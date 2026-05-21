'use strict';
//by allou Mohamed 
//sfv ^10.0.2
const express = require('express');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const { Chess } = require('chess.js');
const stockfish = require('stockfish');

if (!isMainThread) {
    const sf = stockfish();
    let lines = [];

    function pickMoveFromLines() {
        const pv = lines
            .filter(l => l.includes(' pv '))
            .pop();

        if (pv) {
            const parts = pv.split(' pv ')[1].trim().split(' ');
            return parts[0];
        }

        return null;
    }

    sf.onmessage = (e) => {
        const msg = typeof e === 'string' ? e : e.data;

        if (msg.startsWith('bestmove')) {
            const best = msg.split(' ')[1];
            const fallback = pickMoveFromLines();
            parentPort.postMessage(fallback || best);
        }

        if (msg.includes(' pv ')) {
            lines.push(msg);
        }
    };

    parentPort.on('message', ({ fen, depth }) => {
        lines = [];
        sf.postMessage('uci');
        sf.postMessage('setoption name MultiPV value 5');
        sf.postMessage('position fen ' + fen);
        sf.postMessage('go depth ' + depth);
    });

    return;
}

const app = express();
app.use(express.json());

const WORKERS = 4;
const pool = Array.from({ length: WORKERS }, () => new Worker(__filename));
let i = 0;

function eloToDepth(elo) {
    if (elo <= 400) return 1;
    if (elo <= 800) return 2;
    if (elo <= 1200) return 4;
    if (elo <= 1500) return 6;
    if (elo <= 1800) return 8;
    if (elo <= 2000) return 10;
    return 14;
}

function runWorker(fen, depth) {
    return new Promise((resolve, reject) => {
        const w = pool[i = (i + 1) % WORKERS];
        const t = setTimeout(() => reject(new Error('timeout')), 10000);
        w.once('message', (m) => {
            clearTimeout(t);
            resolve(m);
        });
        w.postMessage({ fen, depth });
    });
}

function pgnToFen(pgn) {
    const chess = new Chess();
    chess.load_pgn(pgn);
    return chess.fen();
}

app.post('/bestmove', async (req, res) => {
    try {
        const { fen, pgn, elo = 1200 } = req.body;
        const depth = eloToDepth(elo);
        const position = pgn ? pgnToFen(pgn) : fen;
        const bestmove = await runWorker(position, depth);
        res.json({ elo, depth, bestmove });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(3000, () => {
   console.log("8==============================D");//😂
});
