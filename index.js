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
    let ready = false;
    const queue = [];

    function flushQueue() {
        if (queue.length === 0) return;
        const { fen, depth } = queue.shift();
        sf.postMessage('stop');
        sf.postMessage('ucinewgame');
        sf.postMessage('position fen ' + fen);
        sf.postMessage('go depth ' + depth);
    }

    sf.onmessage = (e) => {
        const msg = typeof e === 'string' ? e : e.data;

        // Step 1 — engine identified itself
        if (msg === 'uciok') {
            sf.postMessage('setoption name Hash value 8');
            sf.postMessage('setoption name Threads value 1');
            sf.postMessage('setoption name MultiPV value 1');
            sf.postMessage('isready');
            return;
        }

        // Step 2 — engine is ready to accept positions
        if (msg === 'readyok') {
            ready = true;
            flushQueue();
            return;
        }

        // Step 3 — engine finished searching
        if (msg.startsWith('bestmove')) {
            const move = msg.split(' ')[1];
            if (resolveMove) {
                const cb = resolveMove;
                resolveMove = null;
                cb(move && move !== '(none)' ? move : null);
            }
            // if more jobs queued, process next after a tick
            if (queue.length > 0) {
                setImmediate(() => {
                    sf.postMessage('isready');
                });
            }
        }
    };

    // Boot the engine once on worker start
    sf.postMessage('uci');

    parentPort.on('message', ({ fen, depth }) => {
        resolveMove = (move) => parentPort.postMessage(move);
        if (ready) {
            // mark busy so no concurrent jobs land on same worker
            ready = false;
            sf.postMessage('stop');
            sf.postMessage('ucinewgame');
            sf.postMessage('isready');
            queue.push({ fen, depth });
        } else {
            // engine still booting, queue it
            queue.push({ fen, depth });
        }
    });

    return;
}

/* ─────────────────────────────────────────────
   LRU CACHE  (pure JS, zero dependencies)
───────────────────────────────────────────── */
class LRUCache {
    constructor(max = 512) {
        this.max = max;
        this.map = new Map();
    }

    get(key) {
        if (!this.map.has(key)) return undefined;
        const val = this.map.get(key);
        this.map.delete(key);
        this.map.set(key, val);
        return val;
    }

    set(key, val) {
        if (this.map.has(key)) this.map.delete(key);
        else if (this.map.size >= this.max) {
            this.map.delete(this.map.keys().next().value);
        }
        this.map.set(key, val);
    }
}

const cache = new LRUCache(512);

/* ─────────────────────────────────────────────
   WORKER POOL
───────────────────────────────────────────── */
const WORKERS = 2;
const pool = Array.from({ length: WORKERS }, () => new Worker(__filename));
const busy = new Array(WORKERS).fill(false);

// Crash recovery — restart a dead worker automatically
pool.forEach((w, idx) => {
    w.on('error', (err) => {
        console.error(`[worker ${idx}] error:`, err.message);
    });
    w.on('exit', (code) => {
        if (code !== 0) {
            console.warn(`[worker ${idx}] exited (${code}), restarting…`);
            pool[idx] = new Worker(__filename);
            busy[idx] = false;
        }
    });
});

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

        // timeout scales with depth so deep searches don't false-fire
        const timeoutMs = 5000 + depth * 1500;
        const timer = setTimeout(() => {
            busy[idx] = false;
            reject(new Error('Stockfish timeout'));
        }, timeoutMs);

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

function isValidFen(fen) {
    if (typeof fen !== 'string') return false;
    const parts = fen.trim().split(/\s+/);
    return parts.length >= 4;
}

function pgnToFen(pgn) {
    const chess = new Chess();
    chess.loadPgn(pgn);
    return chess.fen();
}

/* ─────────────────────────────────────────────
   EXPRESS APP
───────────────────────────────────────────── */
const app = express();
app.use(express.json({ limit: '32kb' }));

/* ── Rate limiter (no extra packages) ── */
const rateMap = new Map();
const RATE_LIMIT  = 30;
const RATE_WINDOW = 60_000;

function rateLimited(ip) {
    const now = Date.now();
    let entry = rateMap.get(ip);
    if (!entry || now > entry.resetAt) {
        rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
        return false;
    }
    entry.count++;
    return entry.count > RATE_LIMIT;
}

// Purge stale rate-limit entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of rateMap) {
        if (now > e.resetAt) rateMap.delete(ip);
    }
}, 300_000).unref();

/* ── POST /bestmove ── */
app.post('/bestmove', async (req, res) => {
    if (rateLimited(req.ip)) {
        return res.status(429).json({ error: 'Too many requests — slow down.' });
    }

    try {
        const { fen: rawFen, pgn, elo = 1200 } = req.body;

        if (!rawFen && !pgn) {
            return res.status(400).json({ error: 'Provide fen or pgn.' });
        }

        let fen;
        try {
            fen = pgn ? pgnToFen(pgn) : rawFen.trim();
        } catch {
            return res.status(400).json({ error: 'Invalid PGN / FEN.' });
        }

        if (!isValidFen(fen)) {
            return res.status(400).json({ error: 'Invalid FEN.' });
        }

        const depth    = eloToDepth(Number(elo) || 1200);
        const cacheKey = `${fen}|${depth}`;

        const cached = cache.get(cacheKey);
        if (cached) {
            return res.json({ elo, depth, bestmove: cached, cached: true });
        }

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
        status   : 'ok',
        workers  : WORKERS,
        busy     : busy.filter(Boolean).length,
        cacheSize: cache.map.size,
        memMB    : Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Chess API ready on :${PORT}`));
