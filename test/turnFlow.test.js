// Drives gemini.js's Live message handler with scripted events, with Electron, the Gemini SDK,
// storage and fetch stubbed, and checks what reaches the answer provider and the renderer.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const storagePath = path.resolve(__dirname, '../src/storage.js');
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turnflow-'));

const rendered = [];
let liveCallbacks = null;

const stubs = {
    electron: {
        BrowserWindow: {
            getAllWindows: () => [{ webContents: { send: (channel, data) => rendered.push({ channel, data }), executeJavaScript: async () => null } }],
        },
        ipcMain: { handle() {}, on() {} },
    },
    '@google/genai': {
        GoogleGenAI: class {
            constructor() {
                this.live = {
                    connect: async ({ callbacks }) => {
                        liveCallbacks = callbacks;
                        return { sendRealtimeInput: async () => {}, close() {} };
                    },
                };
            }
        },
        Modality: { AUDIO: 'AUDIO', TEXT: 'TEXT' },
    },
    [storagePath]: {
        getConfigDir: () => configDir,
        getCredentials: () => ({ openrouterApiKey: 'test-key', groqApiKey: '' }),
        getOpenRouterApiKey: () => 'test-key',
        getGroqApiKey: () => '',
        getApiKey: () => 'gemini-key',
        getConfig: () => ({ openrouterModel: 'openai/gpt-6-luna', geminiLiveModel: 'live-model', disableGroqThinking: false }),
        getAvailableModel: () => 'x',
        incrementLimitCount() {},
        incrementCharUsage() {},
    },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (stubs[request]) return stubs[request];
    try {
        const resolved = Module._resolveFilename(request, parent, isMain);
        if (stubs[resolved]) return stubs[resolved];
    } catch {
        // fall through
    }
    return originalLoad.apply(this, arguments);
};

// Each provider request gets a stream the test finishes explicitly, so "still streaming" is controllable.
const requests = [];
const warmups = [];
global.fetch = async (url, options) => {
    if (!url.endsWith('/chat/completions')) {
        warmups.push(url);
        return new Response('{}', { status: 200 });
    }
    let controller;
    const body = new ReadableStream({ start: c => (controller = c) });
    const request = {
        url,
        body: JSON.parse(options.body),
        said: false,
        say(text) {
            this.said = true;
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
        },
        finish() {
            if (!this.said) this.say('ok');
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`));
            controller.close();
        },
    };
    requests.push(request);
    return new Response(body, { status: 200 });
};

const gemini = require('../src/utils/gemini');

const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const input = text => liveCallbacks.onmessage({ serverContent: { inputTranscription: { text } } });
const modelStarts = () => liveCallbacks.onmessage({ serverContent: { modelTurn: { parts: [] } } });
const lastUserMessage = request => request.body.messages.filter(m => m.role === 'user').pop().content;

let realNow = Date.now;
let clockOffset = 0;

test.before(async () => {
    Date.now = () => realNow() + clockOffset;
    await gemini.initializeGeminiSession('gemini-key', '', 'interview', 'en-US');
    assert.ok(liveCallbacks, 'live session connected');
});

test.after(() => {
    Date.now = realNow;
    Module._load = originalLoad;
});

test.beforeEach(() => {
    requests.length = 0;
    warmups.length = 0;
    rendered.length = 0;
    clockOffset += 60000; // far past any grace window, so each test starts a fresh card
});

test("Gemini's first output after speech sends the question without waiting for the timer", async () => {
    input(' What');
    input(' is Kubernetes?');
    modelStarts();
    await tick();
    assert.equal(requests.length, 1);
    assert.equal(lastUserMessage(requests[0]), 'What is Kubernetes?');
    requests[0].finish();
    await tick();
});

test('a follow-up while the answer streams is sent as a continuation and appended below it', async () => {
    input(' What is Kubernetes?');
    modelStarts();
    await tick();
    requests[0].say('Kubernetes orchestrates containers.');
    await tick();

    input(' And how do you handle pods that keep failing?');
    modelStarts();
    await tick();
    assert.equal(requests.length, 2);
    assert.match(lastUserMessage(requests[1]), /continued their previous question \("What is Kubernetes\?"\)/);
    assert.match(lastUserMessage(requests[1]), /pods that keep failing/);

    requests[1].say('I check the restart reason first.');
    await tick();
    const last = rendered.filter(r => r.channel === 'new-response' || r.channel === 'update-response').pop();
    assert.equal(last.channel, 'update-response');
    assert.equal(last.data, 'Kubernetes orchestrates containers.\n\n---\n\nI check the restart reason first.');
    assert.equal(rendered.filter(r => r.channel === 'new-response').length, 1, 'only one card opened');

    requests[0].finish();
    requests[1].finish();
    await tick();
});

test('speech more than 5s after the answer finished opens a new card', async () => {
    input(' What is Redis?');
    modelStarts();
    await tick();
    requests[0].say('An in-memory store.');
    requests[0].finish();
    await tick();

    clockOffset += 5001;
    input(' Tell me about Terraform.');
    modelStarts();
    await tick();
    assert.equal(lastUserMessage(requests[1]), 'Tell me about Terraform.');
    requests[1].say('Infrastructure as code.');
    await tick();
    assert.equal(rendered.filter(r => r.channel === 'new-response').length, 2);
    requests[1].finish();
    await tick();
});

test('speech later in the same Gemini turn is sent, not dropped', async () => {
    input(' Give me an example.');
    modelStarts();
    await tick();
    requests[0].finish();
    await tick();
    // No turnComplete in between: the old per-turn latch swallowed this.
    input(' Assuming it is an EC2 instance.');
    modelStarts();
    await tick();
    assert.equal(requests.length, 2);
    assert.match(lastUserMessage(requests[1]), /EC2 instance/);
    requests[1].finish();
    await tick();
});

test('a transcription that is only a noise tag is not sent', async () => {
    input('<noise>');
    modelStarts();
    await tick();
    assert.equal(requests.length, 0);
});

test('without a Gemini reply the settle timer still sends the question', async () => {
    input(' What is Docker?');
    await tick();
    assert.equal(requests.length, 0);
    await new Promise(resolve => setTimeout(resolve, 1600));
    assert.equal(requests.length, 1);
    requests[0].finish();
    await tick();
});

test('the first fragment of a question warms the provider connection once', async () => {
    input(' How');
    input(' would you scale this?');
    await tick();
    assert.deepEqual(warmups, ['https://openrouter.ai/api/v1/key']);
    modelStarts();
    await tick();
    requests[0].finish();
    await tick();
});
