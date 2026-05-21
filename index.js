'use strict';

const express = require('express');
const { Chess } = require('chess.js');
const stockfish = require('stockfish');

const app = express();
app.use(express.json());

const sf = stockfish();
let bestFromPv = null;
let resolver = null;
const queue = [];
let busy = false;

sf.postMessage('uci');
sf.postMessage('setoption name MultiPV value 1');
sf.postMessage('setoption name Threads value 4');
sf.postMessage('setoption name UCI_LimitStrength value true');
sf.postMessage('isready');

sf.onmessage = (e) => {
    const msg = typeof e === 'string' ? e : e.data;

    if (msg.includes(' multipv 1 ') && msg.includes(' pv ')) {
        const pvPart = msg.split(' pv ')[1];
        if (pvPart) bestFromPv = pvPart.trim().split(' ')[0];
    }

    if (msg.startsWith('bestmove')) {
        const best = msg.split(' ')[1];
        if (resolver) {
            resolver(bestFromPv || best);
            resolver = null;
            bestFromPv = null;
        }
    }
};

function getMove(fen, depth) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            resolver = null;
            reject(new Error('timeout'));
        }, 15000);

        resolver = (move) => {
            clearTimeout(t);
            resolve(move);
        };

        bestFromPv = null;
        sf.postMessage('position fen ' + fen);
        sf.postMessage('go depth ' + depth);
    });
}

async function processQueue() {
    if (busy || !queue.length) return;
    busy = true;
    const { fen, depth, eloForOption, resolve, reject } = queue.shift();
    try {
        sf.postMessage('setoption name UCI_Elo value ' + eloForOption);
        const move = await getMove(fen, depth);
        resolve(move);
    } catch (e) {
        reject(e);
    }
    busy = false;
    processQueue();
}

function enqueue(fen, depth, eloForOption) {
    return new Promise((resolve, reject) => {
        queue.push({ fen, depth, eloForOption, resolve, reject });
        processQueue();
    });
}

function eloToDepth(elo) {
    if (elo <= 400)  return 1;
    if (elo <= 800)  return 2;
    if (elo <= 1200) return 4;
    if (elo <= 1500) return 6;
    if (elo <= 1800) return 8;
    if (elo <= 2000) return 10;
    if (elo <= 2200) return 14;
    if (elo <= 2500) return 16;
    return 20;
}

function isValidFen(fen) {
    try { new Chess(fen); return true; }
    catch { return false; }
}

function pgnToFen(pgn) {
    const chess = new Chess();
    chess.loadPgn(pgn);
    return chess.fen();
}

app.get('/health', (req, res) => {
    res.json({ status: 'ok', queue: queue.length, busy });
});

app.post('/bestmove', async (req, res) => {
    try {
        const { fen, pgn, elo = 1200 } = req.body;

        if (!fen && !pgn) return res.status(400).json({ error: 'fen or pgn required' });

        let position;
        if (pgn) {
            try { position = pgnToFen(pgn); }
            catch { return res.status(400).json({ error: 'invalid pgn' }); }
        } else {
            if (!isValidFen(fen)) return res.status(400).json({ error: 'invalid fen' });
            position = fen;
        }

        const clampedElo = Math.min(Math.max(elo, 1320), 3190);
        const depth = eloToDepth(elo);
        const bestmove = await enqueue(position, depth, clampedElo);

        res.json({ elo, depth, bestmove });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(8567);
