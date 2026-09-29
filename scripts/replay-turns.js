#!/usr/bin/env node
// Replays recorded Gemini Live sessions against answer-trigger policies. The interviewer's speech
// and Gemini's voice activity detection in a log do not depend on when we sent to the answer
// provider, so any trigger policy can be re-run against them. A "split" is a fire followed by more
// interviewer speech within SPLIT_WINDOW_MS. Usage:
//   node scripts/replay-turns.js [logFile ...]   (defaults to the 6 newest logs)
const fs = require('fs');
const path = require('path');
const { getConfigDir } = require('../src/storage');
const { parseTransportLog, extractTimeline } = require('./lib/transportLog');

const SPLIT_WINDOW_MS = 5000;

function simulate({ inputs, modelStarts }, { settleMs, useGeminiEndOfTurn }) {
    const fires = [];
    let i = 0;
    while (i < inputs.length) {
        let last = inputs[i];
        for (;;) {
            let firedAt = last + settleMs;
            if (useGeminiEndOfTurn) {
                const start = modelStarts.find(t => t > last);
                if (start !== undefined && start < firedAt) firedAt = start;
            }
            const next = inputs[i + 1];
            if (next !== undefined && next < firedAt) {
                i++;
                last = next;
                continue;
            }
            fires.push({ lastInputAt: last, firedAt, nextInputAt: next });
            i++;
            break;
        }
    }
    return fires;
}

function percentile(sorted, p) {
    if (sorted.length === 0) return null;
    return sorted[Math.floor(p * (sorted.length - 1))];
}

function summarize(fires, splitWindowMs = SPLIT_WINDOW_MS) {
    const splits = fires.filter(f => f.nextInputAt !== undefined && f.nextInputAt - f.firedAt <= splitWindowMs).length;
    const latencies = fires.map(f => f.firedAt - f.lastInputAt).sort((a, b) => a - b);
    return {
        questions: fires.length,
        splits,
        splitRate: fires.length ? splits / fires.length : 0,
        medianLatencyMs: percentile(latencies, 0.5),
        p90LatencyMs: percentile(latencies, 0.9),
    };
}

const POLICIES = [
    { name: 'timer 1500 (today)', settleMs: 1500, useGeminiEndOfTurn: false },
    { name: 'timer 1200', settleMs: 1200, useGeminiEndOfTurn: false },
    { name: 'timer 900', settleMs: 900, useGeminiEndOfTurn: false },
    { name: 'timer 600', settleMs: 600, useGeminiEndOfTurn: false },
    { name: 'gemini EOT + 1500 fallback', settleMs: 1500, useGeminiEndOfTurn: true },
    { name: 'gemini EOT + 900 fallback', settleMs: 900, useGeminiEndOfTurn: true },
];

function main(files) {
    const logsDir = path.join(getConfigDir(), 'logs');
    if (files.length === 0) {
        files = fs
            .readdirSync(logsDir)
            .filter(f => f.endsWith('.json'))
            .map(f => path.join(logsDir, f))
            .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
            .slice(-6);
    }
    const timelines = files.map(f => extractTimeline(parseTransportLog(fs.readFileSync(f, 'utf8'))));

    console.log(`Replaying ${files.length} sessions\n`);
    console.log('policy'.padEnd(30), 'questions', 'splits', 'split%', 'median', 'p90');
    for (const policy of POLICIES) {
        const fires = timelines.flatMap(t => simulate(t, policy));
        const s = summarize(fires);
        console.log(
            policy.name.padEnd(30),
            String(s.questions).padStart(9),
            String(s.splits).padStart(6),
            (s.splitRate * 100).toFixed(0).padStart(5) + '%',
            String(s.medianLatencyMs).padStart(6),
            String(s.p90LatencyMs).padStart(5)
        );
    }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { simulate, summarize };
