// The user's context (CV, job description, a whole rulebook) used to be part of the Live session's
// system instruction. A transcription-only Live model never answers, so it gained nothing from it,
// while a large context made session start fail with Gemini's "exceeded your current quota". The
// context now goes only to the answer provider, which does the answering.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGeminiWithStubs } = require('./helpers/geminiHarness');

const harness = loadGeminiWithStubs();
const { gemini, sessions, requests } = harness;

const CONTEXT = 'LAW 11 KNOCK-ON: a player loses possession of the ball and it goes forward.';
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const instruction = record => record.config.systemInstruction.parts[0].text;

test.afterEach(async () => {
    sessions.length = 0;
    requests.length = 0;
    await gemini.closeSession?.();
});

test.after(() => harness.restore());

test('a transcription-only Live session is opened without the user context', async () => {
    harness.config = { ...harness.config, geminiLiveModel: 'gemini-3.5-transcribe-live' };
    global.geminiSessionRef = { current: await gemini.initializeGeminiSession('gemini-key', CONTEXT, 'interview', 'en-US') };

    assert.equal(sessions.length, 1);
    assert.equal(instruction(sessions[0]).includes(CONTEXT), false);
});

test('the answer provider still receives the user context', async () => {
    harness.config = { ...harness.config, geminiLiveModel: 'gemini-3.5-transcribe-live' };
    global.geminiSessionRef = { current: await gemini.initializeGeminiSession('gemini-key', CONTEXT, 'interview', 'en-US') };

    sessions[0].callbacks.onmessage({ serverContent: { inputTranscription: { text: 'What is a knock-on?' } } });
    sessions[0].callbacks.onmessage({ serverContent: { generationComplete: true } });
    await tick(100);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.messages[0].content.includes(CONTEXT), true);
    requests[0].finish();
});

test('a native-audio Live session, which answers itself, keeps the user context', async () => {
    harness.config = { ...harness.config, geminiLiveModel: 'gemini-2.5-flash-native-audio-preview-09-2025' };
    global.geminiSessionRef = { current: await gemini.initializeGeminiSession('gemini-key', CONTEXT, 'interview', 'en-US') };

    assert.equal(instruction(sessions[0]).includes(CONTEXT), true);
});
