'use strict';
// by allou Mohamed
// sfv ^10.0.2 — optimized for low-RAM / weak hosts

const express = require('express');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const { Chess } = require('chess.js');
const stockfish = require('stockfish');

/* ─────────────────────────────────────────────
   WORKER THREAD
───────────────────────────────────────────── */
if (!isMainThread) {
    const sf = stockfish();
    let resolveMove = null;

    sf.onmessage = (e) => {
        const msg = typeof e === 'string' ? e : e.data;

        if (msg.startsWith('bestmove') && resolveMove) {
            const best = msg.split(' ')[1];
            const cb = resolveMove;
            resolveMove = null;
            cb(best && best !== '(none)' ? best : null);
        }
    };

    sf.postMessage('uci');
    sf.postMessage('setoption name Hash value 8');       // 8 MB hash — safe for weak hosts
    sf.postMessage('setoption name Threads value 1');    // 1 thread per worker
    sf.postMessage('setoption name MultiPV value 1');    // single best line only

    parentPort.on('message', ({ fen, depth }) => {
        resolveMove = (move) => parentPort.postMessage(move);
        sf.postMessage('position fen ' + fen);
        sf.postMessage('go depth ' + depth);
    });

    return;
}

/* ─────────────────────────────────────────────
   LRU CACHE  (pure JS, zero dependencies)
   Keeps the N most-recently-used FEN+depth
   results so repeated positions are instant.
───────────────────────────────────────────── */
class LRUCache {
    constructor(max = 512) {
        this.max = max;
        this.map = new Map();
    }

    get(key) {
        if (!this.map.has(key)) return undefined;
        const val = this.map.get(key);
        // refresh recency
        this.map.delete(key);
        this.map.set(key, val);
        return val;
    }

    set(key, val) {
        if (this.map.has(key)) this.map.delete(key);
        else if (this.map.size >= this.max) {
            // evict oldest entry
            this.map.delete(this.map.keys().next().value);
        }
        this.map.set(key, val);
    }
}

const cache = new LRUCache(512);

/* ─────────────────────────────────────────────
   WORKER POOL
   Reduced to 2 workers on weak hosts.
   Each worker owns one Stockfish instance.
───────────────────────────────────────────── */
const WORKERS = 2;
const pool = Array.from({ length: WORKERS }, () => new Worker(__filename));
const busy = new Array(WORKERS).fill(false);

// Round-robin that skips busy workers; falls back to least-loaded
function pickWorker() {
    for (let i = 0; i < WORKERS; i++) {
        if (!busy[i]) return i;
    }
    return 0; // all busy — queue on worker 0
}

function runWorker(fen, depth) {
    return new Promise((resolve, reject) => {
        const idx = pickWorker();
        busy[idx] = true;

        const timer = setTimeout(() => {
            busy[idx] = false;
            reject(new Error('Stockfish timeout'));
        }, 12000);

        pool[idx].once('message', (move) => {
            clearTimeout(timer);
            busy[idx] = false;
            resolve(move);
        });

        pool[idx].postMessage({ fen, depth });
    });
}

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */
function eloToDepth(elo) {
    if (elo <= 400)  return 1;
    if (elo <= 800)  return 2;
    if (elo <= 1200) return 4;
    if (elo <= 1500) return 6;
    if (elo <= 1800) return 8;
    if (elo <= 2000) return 10;
    return 14;
}

// Validate a FEN string cheaply before sending to Stockfish
function isValidFen(fen) {
    if (typeof fen !== 'string') return false;
    const parts = fen.trim().split(/\s+/);
    return parts.length >= 4;
}

function pgnToFen(pgn) {
    const chess = new Chess();
    // loadPgn throws on bad input — let it bubble up
    chess.loadPgn(pgn);
    return chess.fen();
}

/* ─────────────────────────────────────────────
   EXPRESS APP
───────────────────────────────────────────── */
const app = express();

// Limit body size — nobody should POST more than 32 KB of PGN
app.use(express.json({ limit: '32kb' }));

// Simple in-process rate limiter (no extra packages)
const rateMap = new Map(); // ip → { count, resetAt }
const RATE_LIMIT = 30;     // requests per window
const RATE_WINDOW = 60_000; // 1 minute

function rateLimited(ip) {
    const now = Date.now();
    let entry = rateMap.get(ip);

    if (!entry || now > entry.resetAt) {
        entry = { count: 1, resetAt: now + RATE_WINDOW };
        rateMap.set(ip, entry);
        return false;
    }

    entry.count++;
    if (entry.count > RATE_LIMIT) return true;
    return false;
}

// Purge stale rate-limit entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of rateMap) {
        if (now > e.resetAt) rateMap.delete(ip);
    }
}, 300_000).unref(); // .unref() so this doesn't keep the process alive

/* ── POST /bestmove ── */
app.post('/bestmove', async (req, res) => {
    const ip = req.ip;
    if (rateLimited(ip)) {
        return res.status(429).json({ error: 'Too many requests — slow down.' });
    }

    let fen;
    try {
        const { fen: rawFen, pgn, elo = 1200 } = req.body;

        if (!rawFen && !pgn) {
            return res.status(400).json({ error: 'Provide fen or pgn.' });
        }

        fen = pgn ? pgnToFen(pgn) : rawFen.trim();

        if (!isValidFen(fen)) {
            return res.status(400).json({ error: 'Invalid FEN.' });
        }

        const depth = eloToDepth(Number(elo) || 1200);
        const cacheKey = `${fen}|${depth}`;

        // ── Cache hit ──────────────────────────────
        const cached = cache.get(cacheKey);
        if (cached) {
            return res.json({ elo, depth, bestmove: cached, cached: true });
        }

        // ── Compute ────────────────────────────────
        const bestmove = await runWorker(fen, depth);

        if (!bestmove) {
            return res.status(422).json({ error: 'No legal moves in this position.' });
        }

        cache.set(cacheKey, bestmove);
        return res.json({ elo, depth, bestmove, cached: false });

    } catch (err) {
        console.error('[/bestmove]', err.message);
        return res.status(500).json({ error: err.message });
    }
});

/* ── GET /health ── */
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        workers: WORKERS,
        busy: busy.filter(Boolean).length,
        cacheSize: cache.map.size,
        memMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Chess API ready on :${PORT}`));
