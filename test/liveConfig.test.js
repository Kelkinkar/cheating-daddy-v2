const test = require('node:test');
const assert = require('node:assert/strict');
const { isTranscriptionModel, buildLiveConfig } = require('../src/utils/liveConfig');

const args = { tools: [{ googleSearch: {} }], systemPrompt: 'be brief', language: 'en-US' };

test('isTranscriptionModel matches transcribe models only', () => {
    assert.equal(isTranscriptionModel('gemini-3.5-transcribe-live'), true);
    assert.equal(isTranscriptionModel('gemini-2.5-flash-native-audio-preview-09-2025'), false);
    assert.equal(isTranscriptionModel(undefined), false);
});

test('native-audio config keeps audio replies, proactivity, tools and language', () => {
    const config = buildLiveConfig({ model: 'gemini-2.5-flash-native-audio-preview-09-2025', ...args });
    assert.deepEqual(config.responseModalities, ['AUDIO']);
    assert.deepEqual(config.proactivity, { proactiveAudio: true });
    assert.deepEqual(config.tools, args.tools);
    assert.deepEqual(config.speechConfig, { languageCode: 'en-US' });
    assert.equal(config.inputAudioTranscription.enableSpeakerDiarization, true);
});

test('transcription config asks for text and drops reply-only options', () => {
    const config = buildLiveConfig({ model: 'gemini-3.5-transcribe-live', ...args });
    assert.deepEqual(config.responseModalities, ['TEXT']);
    for (const key of ['proactivity', 'outputAudioTranscription', 'tools', 'speechConfig']) {
        assert.equal(key in config, false, key);
    }
    assert.equal(config.systemInstruction.parts[0].text, 'be brief');
});

test('a fresh install defaults to the transcription model', () => {
    // node --test runs each file in its own process, so pointing HOME at an empty directory only
    // affects this file: getConfig() then returns DEFAULT_CONFIG.
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-home-'));
    const { getConfig } = require('../src/storage');
    assert.equal(getConfig().geminiLiveModel, 'gemini-3.5-transcribe-live');
});
