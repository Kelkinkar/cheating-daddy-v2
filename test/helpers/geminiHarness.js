// Loads src/utils/gemini.js with Electron, the Gemini SDK, storage and fetch stubbed, so tests can
// drive the Live message handler with scripted events. Call once per test file: node --test runs
// each file in its own process, which keeps gemini.js's module state per file.
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

function loadGeminiWithStubs() {
    const storagePath = path.resolve(__dirname, '../../src/storage.js');
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-harness-'));

    const harness = {
        rendered: [],
        // One entry per live.connect call: { callbacks, audio: [], texts: [], closed }.
        sessions: [],
        requests: [],
        warmups: [],
        failNextConnect: false,
    };

    const stubs = {
        electron: {
            BrowserWindow: {
                getAllWindows: () => [
                    { webContents: { send: (channel, data) => harness.rendered.push({ channel, data }), executeJavaScript: async () => null } },
                ],
            },
            ipcMain: { handle() {}, on() {} },
        },
        '@google/genai': {
            GoogleGenAI: class {
                constructor() {
                    this.live = {
                        connect: async ({ callbacks }) => {
                            if (harness.failNextConnect) {
                                harness.failNextConnect = false;
                                throw new Error('connect failed');
                            }
                            const record = { callbacks, audio: [], texts: [], closed: false };
                            harness.sessions.push(record);
                            return {
                                sendRealtimeInput: async input => {
                                    if (input.audio) record.audio.push(input.audio.data);
                                    if (input.text) record.texts.push(input.text);
                                },
                                close() {
                                    record.closed = true;
                                },
                            };
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
    global.fetch = async (url, options) => {
        if (!url.endsWith('/chat/completions')) {
            harness.warmups.push(url);
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
            // A stream that ends with no content triggers the provider's empty-generation retry, so
            // always answer something.
            finish() {
                if (!this.said) this.say('ok');
                controller.enqueue(
                    new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
                );
                controller.close();
            },
        };
        harness.requests.push(request);
        return new Response(body, { status: 200 });
    };

    harness.gemini = require('../../src/utils/gemini');
    harness.restore = () => {
        Module._load = originalLoad;
    };
    return harness;
}

module.exports = { loadGeminiWithStubs };
