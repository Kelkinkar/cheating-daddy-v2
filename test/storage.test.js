const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// storage resolves its directory from the home dir, so point it at a throwaway one.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-storage-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const storage = require('../src/storage');

function writeConfig(config) {
    fs.mkdirSync(storage.getConfigDir(), { recursive: true });
    fs.writeFileSync(path.join(storage.getConfigDir(), 'config.json'), JSON.stringify({ configVersion: 1, ...config }));
}

test('a blank or missing saved Live model falls back to the default', () => {
    for (const geminiLiveModel of ['', '   ', null, 42]) {
        writeConfig({ geminiLiveModel });
        assert.strictEqual(storage.getConfig().geminiLiveModel, 'gemini-3.5-transcribe-live', JSON.stringify(geminiLiveModel));
    }
});

test('a saved Live model is kept, trimmed', () => {
    writeConfig({ geminiLiveModel: ' gemini-3.1-flash-live-preview ' });
    assert.strictEqual(storage.getConfig().geminiLiveModel, 'gemini-3.1-flash-live-preview');
});

test('blank answer-provider models fall back too', () => {
    writeConfig({ openrouterModel: '', groqModel: '' });
    const config = storage.getConfig();
    assert.strictEqual(config.openrouterModel, 'qwen/qwen3.8-27b');
    assert.strictEqual(config.groqModel, 'qwen/qwen3.6-27b');
});
