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
sf.postMessage('setoption name MultiPV value 5'); 
sf.postMessage('setoption name Threads value 4');
sf.postMessage('setoption name UCI_LimitStrength value true');
sf.postMessage('isready');

let pvMoves = {};

sf.onmessage = (e) => {
    const msg = typeof e === 'string' ? e : e.data;

    if (msg.includes(' pv ')) {
        const multipvMatch = msg.match(/ multipv (\d+) /);
        const pvPart = msg.split(' pv ')[1];
        if (multipvMatch && pvPart) {
            const rank = parseInt(multipvMatch[1]);
            pvMoves[rank] = pvPart.trim().split(' ')[0];
        }
    }

    if (msg.startsWith('bestmove')) {
        const best = msg.split(' ')[1];
        if (resolver) {
            resolver({ pvMoves: { ...pvMoves }, best });
            resolver = null;
            pvMoves = {};
        }
    }
};

function getMove(fen, depth) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            resolver = null;
            reject(new Error('timeout'));
        }, 15000);

        resolver = (result) => {
            clearTimeout(t);
            resolve(result);
        };

        pvMoves = {};
        sf.postMessage('position fen ' + fen);
        sf.postMessage('go depth ' + depth);
    });
}

function humanPickMove(elo, pvMoves, best, fen) {
    const chess = new Chess(fen);
    const legalMoves = chess.moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
    const candidates = [];
    for (let i = 1; i <= 5; i++) {
        if (pvMoves[i]) candidates.push(pvMoves[i]);
    }
    if (candidates.length === 0) candidates.push(best);
    const weightProfiles = {
        400:  [20, 20, 20, 20, 20],  
        600:  [30, 25, 20, 15, 10],
        800:  [40, 28, 18, 10,  4],
        1000: [55, 25, 12,  6,  2],
        1200: [65, 20, 10,  4,  1],
        1500: [75, 15,  7,  2,  1],
        1800: [85, 10,  4,  1,  0],
        2000: [92,  6,  2,  0,  0],
        2200: [96,  3,  1,  0,  0],
        2500: [98,  2,  0,  0,  0],
        3190: [100, 0,  0,  0,  0],
    };
    const brackets = Object.keys(weightProfiles).map(Number).sort((a, b) => a - b);
    let bracket = brackets[0];
    for (const b of brackets) {
        if (elo >= b) bracket = b;
    }
    const weights = weightProfiles[bracket];
    const blunderChance = Math.max(0, (1500 - elo) / 1500) * 0.30;

    if (Math.random() < blunderChance) {
        
        const randomMove = legalMoves[Math.floor(Math.random() * legalMoves.length)];
        return randomMove;
    }
    const totalWeight = weights.slice(0, candidates.length).reduce((a, b) => a + b, 0);
    let rand = Math.random() * totalWeight;
    for (let i = 0; i < candidates.length; i++) {
        rand -= weights[i];
        if (rand <= 0) return candidates[i];
    }

    return candidates[0]; 
}

async function processQueue() {
    if (busy || !queue.length) return;
    busy = true;
    const { fen, depth, elo, eloForOption, resolve, reject } = queue.shift();
    try {
        sf.postMessage('setoption name UCI_Elo value ' + eloForOption);
        const result = await getMove(fen, depth);
        const move = humanPickMove(elo, result.pvMoves, result.best, fen);
        resolve(move);
    } catch (e) {
        reject(e);
    }
    busy = false;
    processQueue();
}

function enqueue(fen, depth, elo, eloForOption) {
    return new Promise((resolve, reject) => {
        queue.push({ fen, depth, elo, eloForOption, resolve, reject });
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
        const bestmove = await enqueue(position, depth, elo, clampedElo);

        res.json({ elo, depth, bestmove });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(30293);
