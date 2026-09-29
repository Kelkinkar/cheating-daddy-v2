// Gemini Live ends sessions after ~10 minutes with a goAway warning (observed: timeLeft 50s). The
// app used to wait for the server to abort the connection, then pause RECONNECT_DELAY before
// reconnecting: a ~2.4s window in which the interviewer was not heard. These tests pin the
// replacement: open the next session as soon as goAway arrives and switch audio to it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGeminiWithStubs } = require('./helpers/geminiHarness');

const harness = loadGeminiWithStubs();
const { gemini, requests } = harness;
const sessions = harness.sessions;

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
// Opening a session includes getStoredSetting's 100ms wait for the renderer.
const connectTime = () => tick(300);
const goAway = record => record.callbacks.onmessage({ goAway: { timeLeft: '50s' } });
const input = (record, text) => record.callbacks.onmessage({ serverContent: { inputTranscription: { text } } });
const endOfTurn = record => record.callbacks.onmessage({ serverContent: { generationComplete: true } });

test.beforeEach(async () => {
    sessions.length = 0;
    requests.length = 0;
    global.geminiSessionRef = { current: await gemini.initializeGeminiSession('gemini-key', '', 'interview', 'en-US') };
    assert.equal(sessions.length, 1);
});

test.after(() => harness.restore());

test('goAway opens the next session immediately and moves audio to it', async () => {
    const first = sessions[0];
    goAway(first);
    await connectTime();
    assert.equal(sessions.length, 2, 'next session opened without waiting for the server to close');

    await gemini.sendAudioToGemini('chunk-after-handoff', global.geminiSessionRef);
    assert.deepEqual(sessions[1].audio, ['chunk-after-handoff']);
    assert.deepEqual(first.audio, []);
});

test('the retired session is closed after draining, without triggering a reconnect', async () => {
    const first = sessions[0];
    goAway(first);
    await connectTime();
    assert.equal(first.closed, false, 'kept open briefly so in-flight transcripts arrive');

    await tick(gemini.HANDOFF_DRAIN_MS + 100);
    assert.equal(first.closed, true);

    first.callbacks.onclose({ reason: 'closed by client' });
    await tick(2200); // longer than RECONNECT_DELAY
    assert.equal(sessions.length, 2, 'no reconnect for a retired session');
});

test('a transcript the retired session delivers while draining is still answered', async () => {
    const first = sessions[0];
    goAway(first);
    await connectTime();
    input(first, 'What is Kubernetes?');
    endOfTurn(first);
    await tick();
    assert.equal(requests.length, 1);
    requests[0].finish();
    await tick();
});

test('a second goAway on the same session does not open another session', async () => {
    goAway(sessions[0]);
    goAway(sessions[0]);
    await connectTime();
    assert.equal(sessions.length, 2);
});

test('if the handoff fails, the server close still falls back to the normal reconnect', async () => {
    const first = sessions[0];
    harness.failNextConnect = true;
    goAway(first);
    await connectTime();
    assert.equal(sessions.length, 1, 'handoff attempt failed');
    assert.equal(global.geminiSessionRef.current !== null, true, 'still on the old session');

    first.callbacks.onclose({ reason: 'GoAway deadline' });
    await tick(2300);
    assert.equal(sessions.length, 2, 'reconnected via the existing path');
});
