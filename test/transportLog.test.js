const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTransportLog, extractTimeline } = require('../scripts/lib/transportLog');

const line = (timestamp, type, data) => JSON.stringify({ timestamp, type, data });

test('parseTransportLog reads a closed log', () => {
    const text = `[\n${line(1, 'a', {})},\n${line(2, 'b', {})}\n]\n`;
    assert.deepEqual(parseTransportLog(text).map(e => e.timestamp), [1, 2]);
});

test('parseTransportLog skips a truncated last line of an unclosed log', () => {
    const text = `[\n${line(1, 'a', {})},\n{"timestamp":2,"ty`;
    assert.deepEqual(parseTransportLog(text).map(e => e.timestamp), [1]);
});

test('extractTimeline keeps only the first model output after each input run', () => {
    const msg = serverContent => ({ serverContent });
    const events = [
        { timestamp: 100, type: 'gemini.live.message', data: msg({ inputTranscription: { text: ' What' } }) },
        { timestamp: 220, type: 'gemini.live.message', data: msg({ inputTranscription: { text: ' is' } }) },
        { timestamp: 800, type: 'gemini.live.message', data: msg({ modelTurn: { parts: [] } }) },
        { timestamp: 900, type: 'gemini.live.message', data: msg({ modelTurn: { parts: [] } }) },
        { timestamp: 950, type: 'gemini.live.message', data: msg({ outputTranscription: { text: 'x' } }) },
        { timestamp: 2000, type: 'gemini.live.message', data: msg({ inputTranscription: { text: ' and' } }) },
        { timestamp: 2600, type: 'gemini.live.message', data: msg({ outputTranscription: { text: 'y' } }) },
    ];
    assert.deepEqual(extractTimeline(events), { inputs: [100, 220, 2000], modelStarts: [800, 2600] });
});
