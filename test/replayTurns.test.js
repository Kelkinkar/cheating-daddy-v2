const test = require('node:test');
const assert = require('node:assert/strict');
const { simulate, summarize } = require('../scripts/replay-turns');

test('timer policy fires settleMs after the last fragment of a burst', () => {
    const fires = simulate({ inputs: [0, 120, 240], modelStarts: [] }, { settleMs: 1500, useGeminiEndOfTurn: false });
    assert.deepEqual(fires, [{ lastInputAt: 240, firedAt: 1740, nextInputAt: undefined }]);
});

test('a pause longer than settleMs splits the question', () => {
    const fires = simulate({ inputs: [0, 2000], modelStarts: [] }, { settleMs: 1500, useGeminiEndOfTurn: false });
    assert.equal(fires.length, 2);
    assert.equal(summarize(fires).splits, 1);
});

test('gemini end-of-turn fires before the timer when it comes first', () => {
    const fires = simulate({ inputs: [0, 100], modelStarts: [700] }, { settleMs: 1500, useGeminiEndOfTurn: true });
    assert.deepEqual(fires, [{ lastInputAt: 100, firedAt: 700, nextInputAt: undefined }]);
});

test('a model start that precedes the last fragment is ignored', () => {
    const fires = simulate({ inputs: [0, 900], modelStarts: [500, 1600] }, { settleMs: 1500, useGeminiEndOfTurn: true });
    // 500 is before input 900, so the burst continues; 1600 is the first start after it.
    assert.equal(fires[fires.length - 1].firedAt, 1600);
});

test('summarize reports latency percentiles and split rate', () => {
    const s = summarize([
        { lastInputAt: 0, firedAt: 600, nextInputAt: undefined },
        { lastInputAt: 10000, firedAt: 10800, nextInputAt: 12000 },
    ]);
    assert.equal(s.questions, 2);
    assert.equal(s.splits, 1);
    assert.equal(s.splitRate, 0.5);
    assert.equal(s.medianLatencyMs, 600);
});
