# OpenRouter Answer Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OpenRouter API key alongside the existing Groq key so OpenRouter answers when its key is set, Groq answers when only its key is set, and Gemini Live answers when neither is set.

**Architecture:** The duplicated OpenAI-compatible request/stream logic currently inlined in `sendToGroq` and `sendImageToGroq` is extracted into a new dependency-free module, `src/utils/openaiCompatible.js`, parameterized by a provider descriptor. `src/utils/gemini.js` keeps all stateful orchestration (conversation history, usage accounting, renderer events, transport logs) and gains a single `getAnswerProvider()` resolver that replaces the `hasGroqKey()` predicate at six call sites.

**Tech Stack:** Node 24 / Electron 30, CommonJS, no bundler. Tests use the built-in `node:test` runner and `node:assert/strict` — no new dependencies are added to `package.json`.

**Spec:** `docs/superpowers/specs/2026-09-17-openrouter-provider-design.md`

## Global Constraints

- **Precedence is fixed:** OpenRouter (if key set) → Groq (if key set) → Gemini Live. Determined purely by key presence. No provider-selector UI.
- **Do not bump `CONFIG_VERSION`** in `src/storage.js`. It is `1` and must stay `1`. Bumping it triggers `resetConfigDir()`, which deletes every user's API keys and session history.
- **Do not touch `sendToGemma()`** (`src/utils/gemini.js:548-632`) or rename `groqConversationHistory`. Both are explicitly out of scope.
- **Storage changes are purely additive.** `disableGroqThinking` keeps its name and now governs both providers.
- **Default model for both new config keys:** `qwen/qwen3.8-27b` (verified on OpenRouter as `input_modalities: ['text','image','video']`).
- **No error cascade.** A failed OpenRouter call surfaces to the status line and stops. It must never silently retry against Groq or Gemini.
- **Formatting:** run `npx prettier --write <changed files>` before every commit. Prettier config is 4-space indent, print width 150, single quotes, semicolons.
- **Behavior for existing users must not change,** with exactly one documented exception. With no OpenRouter key set, every code path must behave as it does at `master` @ `3cccc36`, **except** the SSE partial-frame buffering fix specified in Task 3. That fix makes the Groq path strictly more reliable — today's inline loops drop a JSON frame that splits across two network reads — and was explicitly approved as an intentional deviation. No other behavioral change to the Groq or Gemini paths is permitted.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/utils/openaiCompatible.js` | **New.** Pure, dependency-free. Provider descriptors, reasoning-option mappers, request builder, SSE stream reader, thinking-tag stripper. Imports nothing — not Electron, not storage. |
| `test/openaiCompatible.test.js` | **New.** `node:test` unit tests for the above. |
| `src/storage.js` | Adds `openrouterApiKey` credential, two config defaults, and a getter/setter pair. |
| `src/index.js` | Adds two IPC handlers. |
| `src/utils/renderer.js` | Adds two storage-wrapper methods. |
| `src/utils/gemini.js` | Adds `getAnswerProvider()`, `sendTextToProvider()`, `sendImageToProvider()`; rewires six call sites; deletes the now-duplicated `sendToGroq`/`sendImageToGroq` bodies. |
| `src/components/views/MainView.js` | Adds three form fields, three state properties, three save handlers; updates two strings. |
| `package.json` | Adds a `test` script. |

**Why `openaiCompatible.js` imports nothing:** keeping it free of `require('electron')` and `require('../storage')` means it loads in a bare `node --test` process with no mocking, and it cannot participate in the circular-dependency problem that already forces `gemini.js` to lazy-load `localai.js`.

**Refinement vs. the spec:** the spec's descriptor sketch showed `getApiKey: getGroqApiKey` on each provider. That is dropped — it would force the pure module to import `storage.js`. Instead `buildChatRequest()` receives `apiKey` as an argument and `gemini.js` owns the key lookup. Everything else in the descriptor is unchanged.

---

## Task 1: Test harness, `stripThinkingTags`, and reasoning-option mappers

**Files:**
- Create: `src/utils/openaiCompatible.js`
- Create: `test/openaiCompatible.test.js`
- Modify: `package.json` (scripts block)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `stripThinkingTags(text: string) => string`
  - `getGroqReasoningOptions(model: string, disableThinking: boolean) => object`
  - `getOpenRouterReasoningOptions(model: string, disableThinking: boolean) => object`

- [ ] **Step 1: Add the test script**

In `package.json`, inside `"scripts"`, add a `test` entry directly above `"lint"`. Node's bare `--test` auto-discovers `*.test.js` and skips `node_modules`; do NOT write `node --test test/`, which Node 24 rejects as a module path:

```json
"test": "node --test",
```

- [ ] **Step 2: Write the failing tests**

Create `test/openaiCompatible.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripThinkingTags, getGroqReasoningOptions, getOpenRouterReasoningOptions } = require('../src/utils/openaiCompatible');

test('stripThinkingTags removes a complete thinking block', () => {
    assert.equal(stripThinkingTags('<think>weighing options</think>The answer is 4.'), 'The answer is 4.');
});

test('stripThinkingTags removes an unterminated thinking block', () => {
    assert.equal(stripThinkingTags('<think>still reasoning'), '');
});

test('stripThinkingTags returns empty string for a partial opening tag', () => {
    assert.equal(stripThinkingTags('<thi'), '');
    assert.equal(stripThinkingTags(''), '');
});

test('stripThinkingTags leaves plain text untouched', () => {
    assert.equal(stripThinkingTags('The answer is 4.'), 'The answer is 4.');
});

test('getGroqReasoningOptions hides reasoning for qwen3 models', () => {
    assert.deepEqual(getGroqReasoningOptions('qwen/qwen3.6-27b', false), { reasoning_format: 'hidden' });
});

test('getGroqReasoningOptions disables reasoning effort for qwen3 when asked', () => {
    assert.deepEqual(getGroqReasoningOptions('qwen/qwen3.6-27b', true), {
        reasoning_format: 'hidden',
        reasoning_effort: 'none',
    });
});

test('getGroqReasoningOptions excludes reasoning for gpt-oss models', () => {
    assert.deepEqual(getGroqReasoningOptions('openai/gpt-oss-120b', true), { include_reasoning: false });
});

test('getGroqReasoningOptions returns empty object for other models', () => {
    assert.deepEqual(getGroqReasoningOptions('moonshotai/kimi-k2-instruct', true), {});
});

test('getOpenRouterReasoningOptions always excludes reasoning from the response', () => {
    assert.deepEqual(getOpenRouterReasoningOptions('qwen/qwen3.8-27b', false), { reasoning: { exclude: true } });
});

test('getOpenRouterReasoningOptions suppresses generation when thinking is disabled', () => {
    assert.deepEqual(getOpenRouterReasoningOptions('qwen/qwen3.8-27b', true), {
        reasoning: { exclude: true, effort: 'none' },
    });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/utils/openaiCompatible'`

- [ ] **Step 4: Write the minimal implementation**

Create `src/utils/openaiCompatible.js`:

```js
// Pure helpers shared by every OpenAI-compatible answer provider (Groq, OpenRouter).
// This module intentionally imports nothing so it stays unit-testable under `node --test`
// and cannot participate in the circular dependency between gemini.js and localai.js.

function stripThinkingTags(text) {
    const trimmedStart = text.trimStart();
    if ('<think>'.startsWith(trimmedStart)) {
        return '';
    }

    return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
}

function getGroqReasoningOptions(model, disableThinking) {
    if (model.includes('qwen3')) {
        const options = {
            reasoning_format: 'hidden',
        };

        if (disableThinking) {
            options.reasoning_effort = 'none';
        }

        return options;
    }

    if (model.startsWith('openai/gpt-oss-')) {
        return {
            include_reasoning: false,
        };
    }

    return {};
}

function getOpenRouterReasoningOptions(model, disableThinking) {
    // exclude:true mirrors Groq's always-on reasoning_format:'hidden' — keep reasoning out of the
    // streamed content. effort:'none' mirrors reasoning_effort:'none' — actually stop generating it.
    const reasoning = { exclude: true };

    if (disableThinking) {
        reasoning.effort = 'none';
    }

    return { reasoning };
}

module.exports = {
    stripThinkingTags,
    getGroqReasoningOptions,
    getOpenRouterReasoningOptions,
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — `# pass 10`, `# fail 0`

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/utils/openaiCompatible.js test/openaiCompatible.test.js package.json
git add src/utils/openaiCompatible.js test/openaiCompatible.test.js package.json
git commit -m "feat: extract pure reasoning and thinking-tag helpers for answer providers"
```

---

## Task 2: Provider descriptors and request builder

**Files:**
- Modify: `src/utils/openaiCompatible.js`
- Modify: `test/openaiCompatible.test.js`

**Interfaces:**
- Consumes: `getGroqReasoningOptions`, `getOpenRouterReasoningOptions` from Task 1.
- Produces:
  - `PROVIDERS` — object keyed `groq` and `openrouter`. Each descriptor has `id`, `label`, `baseUrl`, `textModelKey`, `imageModelKey`, `usageBucket` (string or `null`), `extraHeaders` (object), `reasoningOptions` (function).
  - `buildChatRequest({ provider, apiKey, model, messages, thinkingDisabled }) => { url: string, options: object }` — `options` is the second argument to `fetch`.

- [ ] **Step 1: Write the failing tests**

Append to `test/openaiCompatible.test.js`:

```js
const { PROVIDERS, buildChatRequest } = require('../src/utils/openaiCompatible');

test('PROVIDERS exposes groq and openrouter descriptors', () => {
    assert.equal(PROVIDERS.groq.id, 'groq');
    assert.equal(PROVIDERS.groq.baseUrl, 'https://api.groq.com/openai/v1');
    assert.equal(PROVIDERS.groq.usageBucket, 'groq');
    assert.equal(PROVIDERS.groq.textModelKey, 'groqModel');
    assert.equal(PROVIDERS.groq.imageModelKey, 'groqImageModel');

    assert.equal(PROVIDERS.openrouter.id, 'openrouter');
    assert.equal(PROVIDERS.openrouter.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(PROVIDERS.openrouter.usageBucket, null);
    assert.equal(PROVIDERS.openrouter.textModelKey, 'openrouterModel');
    assert.equal(PROVIDERS.openrouter.imageModelKey, 'openrouterImageModel');
});

test('buildChatRequest targets the provider chat-completions endpoint', () => {
    const { url } = buildChatRequest({
        provider: PROVIDERS.openrouter,
        apiKey: 'sk-test',
        model: 'qwen/qwen3.8-27b',
        messages: [{ role: 'user', content: 'hi' }],
        thinkingDisabled: true,
    });

    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
});

test('buildChatRequest sets the auth header and provider extra headers', () => {
    const { options } = buildChatRequest({
        provider: PROVIDERS.openrouter,
        apiKey: 'sk-test',
        model: 'qwen/qwen3.8-27b',
        messages: [],
        thinkingDisabled: false,
    });

    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer sk-test');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.headers['HTTP-Referer'], 'https://cheatingdaddy.com');
    assert.equal(options.headers['X-Title'], 'Cheating Daddy');
});

test('buildChatRequest omits extra headers for groq', () => {
    const { options } = buildChatRequest({
        provider: PROVIDERS.groq,
        apiKey: 'gsk-test',
        model: 'qwen/qwen3.6-27b',
        messages: [],
        thinkingDisabled: false,
    });

    assert.equal(options.headers['HTTP-Referer'], undefined);
    assert.equal(options.headers.Authorization, 'Bearer gsk-test');
});

test('buildChatRequest streams and applies shared generation settings', () => {
    const { options } = buildChatRequest({
        provider: PROVIDERS.groq,
        apiKey: 'gsk-test',
        model: 'qwen/qwen3.6-27b',
        messages: [{ role: 'user', content: 'hi' }],
        thinkingDisabled: true,
    });

    const body = JSON.parse(options.body);
    assert.equal(body.model, 'qwen/qwen3.6-27b');
    assert.equal(body.stream, true);
    assert.equal(body.temperature, 0.7);
    assert.equal(body.max_completion_tokens, 16384);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
    assert.equal(body.reasoning_effort, 'none');
});

test('buildChatRequest merges per-provider reasoning options into the body', () => {
    const { options } = buildChatRequest({
        provider: PROVIDERS.openrouter,
        apiKey: 'sk-test',
        model: 'qwen/qwen3.8-27b',
        messages: [],
        thinkingDisabled: true,
    });

    const body = JSON.parse(options.body);
    assert.deepEqual(body.reasoning, { exclude: true, effort: 'none' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'id')`

- [ ] **Step 3: Write the implementation**

In `src/utils/openaiCompatible.js`, add above `module.exports`:

```js
const MAX_COMPLETION_TOKENS = 16384;
const TEMPERATURE = 0.7;

const PROVIDERS = {
    groq: {
        id: 'groq',
        label: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        textModelKey: 'groqModel',
        imageModelKey: 'groqImageModel',
        usageBucket: 'groq',
        extraHeaders: {},
        reasoningOptions: getGroqReasoningOptions,
    },
    openrouter: {
        id: 'openrouter',
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        textModelKey: 'openrouterModel',
        imageModelKey: 'openrouterImageModel',
        // OpenRouter is prepaid credit with no daily free-tier allowance to protect, so no bucket.
        usageBucket: null,
        extraHeaders: {
            'HTTP-Referer': 'https://cheatingdaddy.com',
            'X-Title': 'Cheating Daddy',
        },
        reasoningOptions: getOpenRouterReasoningOptions,
    },
};

function buildChatRequest({ provider, apiKey, model, messages, thinkingDisabled }) {
    return {
        url: `${provider.baseUrl}/chat/completions`,
        options: {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                ...provider.extraHeaders,
            },
            body: JSON.stringify({
                model,
                messages,
                stream: true,
                temperature: TEMPERATURE,
                max_completion_tokens: MAX_COMPLETION_TOKENS,
                ...provider.reasoningOptions(model, thinkingDisabled),
            }),
        },
    };
}
```

Extend `module.exports` to:

```js
module.exports = {
    PROVIDERS,
    buildChatRequest,
    stripThinkingTags,
    getGroqReasoningOptions,
    getOpenRouterReasoningOptions,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — `# pass 16`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/utils/openaiCompatible.js test/openaiCompatible.test.js
git add src/utils/openaiCompatible.js test/openaiCompatible.test.js
git commit -m "feat: add provider descriptors and shared chat request builder"
```

---

## Task 3: SSE stream reader

**Files:**
- Modify: `src/utils/openaiCompatible.js`
- Modify: `test/openaiCompatible.test.js`

**Interfaces:**
- Consumes: `stripThinkingTags` from Task 1.
- Produces: `streamChatCompletion(response, handlers) => Promise<{ fullText: string, finishReason: string|null }>`
  - `response` — a `fetch` Response whose `body` is a web ReadableStream.
  - `handlers` — `{ onText?, onChunk?, onEvent?, onParseError? }`. `onText(displayText)` receives the cumulative thinking-stripped text and is called only when that text is non-empty.

> **Deliberate deviation, flag at review:** the existing inline loops in `sendToGroq`/`sendImageToGroq` split each network chunk on `\n` without carrying a partial trailing line into the next chunk, so a JSON frame split across two TCP reads is silently dropped as a parse error. This implementation buffers the partial line, matching the correct pattern already used by `readStreamingResponse` in `src/utils/localai.js:186-208`. It makes the Groq path strictly more reliable; it does not change any user-visible behavior other than dropping fewer tokens.
>
> **Amended during execution:** review found the first implementation still dropped a final frame when a stream closed without a trailing newline — the loop broke on `done` without draining `pendingLine`. The same gap exists in the cited `localai.js` reference. The shipped version hoists the per-line body into a `processLine` closure and calls it once more after the loop. Covered by the test 'processes a final frame with no trailing newline'.

- [ ] **Step 1: Write the failing tests**

Append to `test/openaiCompatible.test.js`:

```js
const { streamChatCompletion } = require('../src/utils/openaiCompatible');

function responseFrom(chunks) {
    const encoder = new TextEncoder();
    return {
        body: new ReadableStream({
            start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(encoder.encode(chunk));
                }
                controller.close();
            },
        }),
    };
}

function deltaFrame(content, finishReason = null) {
    return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }] })}\n`;
}

test('streamChatCompletion accumulates tokens and reports the final text', async () => {
    const seen = [];
    const result = await streamChatCompletion(responseFrom([deltaFrame('Hello'), deltaFrame(' world')]), {
        onText: text => seen.push(text),
    });

    assert.equal(result.fullText, 'Hello world');
    assert.deepEqual(seen, ['Hello', 'Hello world']);
});

test('streamChatCompletion reassembles a frame split across chunks', async () => {
    const frame = deltaFrame('Hello world');
    const midpoint = Math.floor(frame.length / 2);
    const result = await streamChatCompletion(responseFrom([frame.slice(0, midpoint), frame.slice(midpoint)]), {});

    assert.equal(result.fullText, 'Hello world');
});

test('streamChatCompletion ignores the DONE sentinel', async () => {
    const result = await streamChatCompletion(responseFrom([deltaFrame('done'), 'data: [DONE]\n']), {});

    assert.equal(result.fullText, 'done');
});

test('streamChatCompletion survives a malformed frame and reports it', async () => {
    const errors = [];
    const result = await streamChatCompletion(responseFrom(['data: {not json}\n', deltaFrame('ok')]), {
        onParseError: (data, error) => errors.push({ data, message: error.message }),
    });

    assert.equal(result.fullText, 'ok');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].data, '{not json}');
});

test('streamChatCompletion captures the finish reason', async () => {
    const result = await streamChatCompletion(responseFrom([deltaFrame('hi', 'length')]), {});

    assert.equal(result.finishReason, 'length');
});

test('streamChatCompletion withholds onText while only thinking content has arrived', async () => {
    const seen = [];
    const result = await streamChatCompletion(responseFrom([deltaFrame('<think>hmm'), deltaFrame('</think>Answer')]), {
        onText: text => seen.push(text),
    });

    assert.deepEqual(seen, ['Answer']);
    assert.equal(result.fullText, '<think>hmm</think>Answer');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `TypeError: streamChatCompletion is not a function`

- [ ] **Step 3: Write the implementation**

In `src/utils/openaiCompatible.js`, add above `module.exports`:

```js
async function streamChatCompletion(response, handlers = {}) {
    const { onText, onChunk, onEvent, onParseError } = handlers;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let pendingLine = '';
    let fullText = '';
    let finishReason = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        onChunk?.(chunk);

        // Carry an incomplete trailing line into the next chunk so frames split
        // across network reads are not dropped.
        pendingLine += chunk;
        const lines = pendingLine.split('\n');
        pendingLine = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;

            const data = trimmed.slice(6);
            if (data === '[DONE]') continue;

            try {
                const event = JSON.parse(data);
                onEvent?.(event);
                finishReason = event.choices?.[0]?.finish_reason || finishReason;

                const token = event.choices?.[0]?.delta?.content || '';
                if (!token) continue;

                fullText += token;
                const displayText = stripThinkingTags(fullText);
                if (displayText) {
                    onText?.(displayText);
                }
            } catch (error) {
                onParseError?.(data, error);
            }
        }
    }

    return { fullText, finishReason };
}
```

Add `streamChatCompletion` to `module.exports`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — `# pass 22`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/utils/openaiCompatible.js test/openaiCompatible.test.js
git add src/utils/openaiCompatible.js test/openaiCompatible.test.js
git commit -m "feat: add shared SSE reader with partial-frame buffering"
```

---

## Task 4: Storage layer

**Files:**
- Modify: `src/storage.js:15` (DEFAULT_CONFIG), `src/storage.js:20` (DEFAULT_CREDENTIALS), `src/storage.js:204-209` (getters), `src/storage.js:514` (exports)

**Interfaces:**
- Consumes: nothing.
- Produces: `getOpenRouterApiKey() => string`, `setOpenRouterApiKey(key: string) => boolean`. Config keys `openrouterModel` and `openrouterImageModel`, both `'qwen/qwen3.8-27b'` by default.

- [ ] **Step 1: Add the config defaults**

In `src/storage.js`, `DEFAULT_CONFIG` currently reads:

```js
const DEFAULT_CONFIG = {
    configVersion: CONFIG_VERSION,
    onboarded: false,
    layout: 'normal',
    geminiLiveModel: 'gemini-3.1-flash-live-preview',
    groqModel: 'qwen/qwen3.6-27b',
    groqImageModel: 'qwen/qwen3.6-27b',
    disableGroqThinking: true,
};
```

Replace it with:

```js
const DEFAULT_CONFIG = {
    configVersion: CONFIG_VERSION,
    onboarded: false,
    layout: 'normal',
    geminiLiveModel: 'gemini-3.1-flash-live-preview',
    groqModel: 'qwen/qwen3.6-27b',
    groqImageModel: 'qwen/qwen3.6-27b',
    openrouterModel: 'qwen/qwen3.8-27b',
    openrouterImageModel: 'qwen/qwen3.8-27b',
    // Despite the name, this governs every answer provider (Groq and OpenRouter alike).
    // Kept unrenamed so the stored config schema stays backwards compatible.
    disableGroqThinking: true,
};
```

`CONFIG_VERSION` stays `1`. `getConfig()` spreads `{ ...DEFAULT_CONFIG, ...saved }`, so existing installs pick up the new keys with no migration.

- [ ] **Step 2: Add the credential default**

`DEFAULT_CREDENTIALS` currently reads:

```js
const DEFAULT_CREDENTIALS = {
    apiKey: '',
    groqApiKey: '',
};
```

Replace it with:

```js
const DEFAULT_CREDENTIALS = {
    apiKey: '',
    groqApiKey: '',
    openrouterApiKey: '',
};
```

- [ ] **Step 3: Add the getter and setter**

Directly after `setGroqApiKey` (around line 209), add:

```js
function getOpenRouterApiKey() {
    return getCredentials().openrouterApiKey || '';
}

function setOpenRouterApiKey(openrouterApiKey) {
    return setCredentials({ openrouterApiKey });
}
```

`getCredentials()` returns the saved file without spreading defaults, so on an existing install `openrouterApiKey` is `undefined` and `|| ''` yields `''`. No migration needed.

- [ ] **Step 4: Export them**

In the `module.exports` block, directly after `setGroqApiKey,` add:

```js
    getOpenRouterApiKey,
    setOpenRouterApiKey,
```

- [ ] **Step 5: Verify the module loads and behaves correctly**

Run:

```bash
node -e "
const s = require('./src/storage');
const c = s.getConfig();
console.log('openrouterModel:', c.openrouterModel);
console.log('openrouterImageModel:', c.openrouterImageModel);
console.log('configVersion:', c.configVersion);
console.log('groqModel unchanged:', c.groqModel);
console.log('openrouter key default:', JSON.stringify(s.getOpenRouterApiKey()));
"
```

Expected output:

```
openrouterModel: qwen/qwen3.8-27b
openrouterImageModel: qwen/qwen3.8-27b
configVersion: 1
groqModel unchanged: qwen/qwen3.6-27b
openrouter key default: ""
```

If `configVersion` prints anything other than `1`, stop — `CONFIG_VERSION` was changed and will wipe user data.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/storage.js
git add src/storage.js
git commit -m "feat: add openrouter credential and model config keys"
```

---

## Task 5: IPC handlers and renderer storage wrapper

**Files:**
- Modify: `src/index.js:120-140` (after the Groq key handlers)
- Modify: `src/utils/renderer.js:52-58` (after `setGroqApiKey`)

**Interfaces:**
- Consumes: `getOpenRouterApiKey`, `setOpenRouterApiKey` from Task 4.
- Produces: IPC channels `storage:get-openrouter-api-key` and `storage:set-openrouter-api-key`; renderer methods `storage.getOpenRouterApiKey()` and `storage.setOpenRouterApiKey(key)`.

- [ ] **Step 1: Add the IPC handlers**

In `src/index.js`, directly after the `storage:set-groq-api-key` handler closes, add:

```js
    ipcMain.handle('storage:get-openrouter-api-key', async () => {
        try {
            return { success: true, data: storage.getOpenRouterApiKey() };
        } catch (error) {
            console.error('Error getting OpenRouter API key:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:set-openrouter-api-key', async (event, openrouterApiKey) => {
        try {
            storage.setOpenRouterApiKey(openrouterApiKey);
            return { success: true };
        } catch (error) {
            console.error('Error setting OpenRouter API key:', error);
            return { success: false, error: error.message };
        }
    });
```

- [ ] **Step 2: Add the renderer wrapper methods**

In `src/utils/renderer.js`, directly after the `setGroqApiKey` method in the `storage` object, add:

```js
    async getOpenRouterApiKey() {
        const result = await ipcRenderer.invoke('storage:get-openrouter-api-key');
        return result.success ? result.data : '';
    },
    async setOpenRouterApiKey(openrouterApiKey) {
        return ipcRenderer.invoke('storage:set-openrouter-api-key', openrouterApiKey);
    },
```

- [ ] **Step 3: Verify both files still parse**

Run:

```bash
node --check src/index.js && node --check src/utils/renderer.js && echo "both parse OK"
```

Expected: `both parse OK`

- [ ] **Step 4: Verify the channel names match exactly**

Run:

```bash
grep -o "storage:[a-z-]*openrouter[a-z-]*" src/index.js src/utils/renderer.js | sort | uniq -c
```

Expected: each of `storage:get-openrouter-api-key` and `storage:set-openrouter-api-key` appears exactly twice (once per file). A count of 1 means a typo on one side, which would fail silently at runtime.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/index.js src/utils/renderer.js
git add src/index.js src/utils/renderer.js
git commit -m "feat: wire openrouter api key through ipc and renderer storage"
```

---

## Task 6: Provider resolution and unified send paths in gemini.js

**Files:**
- Modify: `src/utils/gemini.js` — imports (line 1-8), `hasGroqKey` (209-212), `sendFinalTranscriptionToGroq` (214-226), `stripThinkingTags` (243-250), `getGroqReasoningOptions` (252-272), `sendToGroq` (274-411), `sendImageToGroq` (424-546), and call sites at 690, 698, 1200, 1239.

**Interfaces:**
- Consumes: `PROVIDERS`, `buildChatRequest`, `streamChatCompletion`, `stripThinkingTags` from Tasks 1-3; `getOpenRouterApiKey` from Task 4.
- Produces: `getAnswerProvider() => descriptor|null`, `sendTextToProvider(provider, transcription) => Promise<void>`, `sendImageToProvider(provider, base64Data, prompt) => Promise<{success, text?, model?, error?}>`.

**Do not touch `sendToGemma()` (lines 548-632) or rename `groqConversationHistory`.**

- [ ] **Step 1: Update the imports**

At the top of `src/utils/gemini.js`, change the storage import to include the new getter, and add the new module import:

```js
const { getAvailableModel, incrementLimitCount, getApiKey, getGroqApiKey, getOpenRouterApiKey, incrementCharUsage, getConfig } = require('../storage');
const { PROVIDERS, buildChatRequest, streamChatCompletion, stripThinkingTags } = require('./openaiCompatible');
```

- [ ] **Step 2: Delete the now-duplicated local helpers**

Delete the local `stripThinkingTags` function (lines 243-250) and the local `getGroqReasoningOptions` function (lines 252-272). Both now live in `openaiCompatible.js`. `stripThinkingTags` is imported above; `getGroqReasoningOptions` is reached through `PROVIDERS.groq.reasoningOptions`.

Leave `trimConversationHistoryForGemma` alone — `sendToGemma` still uses it.

- [ ] **Step 3: Replace `hasGroqKey` with the provider resolver**

Replace the `hasGroqKey` function (lines 209-212):

```js
function hasGroqKey() {
    const key = getGroqApiKey();
    return key && key.trim() != '';
}
```

with:

```js
// Maps a provider id to the credential accessor for its key. Lives here rather than on the
// descriptor so openaiCompatible.js stays free of storage imports.
const PROVIDER_KEY_GETTERS = {
    groq: getGroqApiKey,
    openrouter: getOpenRouterApiKey,
};

// Resolves who answers this turn. Precedence is OpenRouter, then Groq, then null.
// null means Gemini Live answers directly, which is the behavior when no provider key is set.
function getAnswerProvider() {
    if ((getOpenRouterApiKey() || '').trim() !== '') return PROVIDERS.openrouter;
    if ((getGroqApiKey() || '').trim() !== '') return PROVIDERS.groq;
    return null;
}
```

- [ ] **Step 4: Rewire the turn-dispatch helper**

Replace `sendFinalTranscriptionToGroq` (lines 214-226) with:

```js
function sendFinalTranscriptionToAnswerProvider() {
    const provider = getAnswerProvider();
    if (!provider || groqRequestStartedForTurn) {
        return;
    }

    const transcription = currentTranscription.trim();
    if (transcription === '') {
        return;
    }

    groqRequestStartedForTurn = true;
    sendTextToProvider(provider, transcription);
}
```

Update its sole caller (line ~688, inside the Gemini Live `onmessage` handler):

```js
                    if (message.serverContent?.inputTranscription) {
                        sendFinalTranscriptionToAnswerProvider();
                    }
```

- [ ] **Step 5: Replace the empty-response constant**

Replace the `GROQ_EMPTY_RESPONSE_MESSAGE` constant (near line 48):

```js
const GROQ_EMPTY_RESPONSE_MESSAGE =
    'Groq reached the maximum completion-token limit before returning a final answer. Disable thinking in Home → AI responses and try again.';
```

with a provider-aware builder:

```js
function emptyResponseMessage(provider) {
    return `${provider.label} reached the maximum completion-token limit before returning a final answer. Disable thinking in Home → AI responses and try again.`;
}
```

Remove the now-unused `GROQ_MAX_COMPLETION_TOKENS` constant as well — the limit moved into `buildChatRequest`.

- [ ] **Step 6: Replace `sendToGroq` with the provider-agnostic text path**

Delete `sendToGroq` (lines 274-411) entirely and put this in its place:

```js
async function sendTextToProvider(provider, transcription) {
    const apiKey = PROVIDER_KEY_GETTERS[provider.id]();
    if (!apiKey) {
        console.log(`No ${provider.label} API key configured, skipping response`);
        return;
    }

    if (!transcription || transcription.trim() === '') {
        console.log(`Empty transcription, skipping ${provider.label}`);
        return;
    }

    const config = getConfig();
    const modelToUse = config[provider.textModelKey];

    console.log(`Sending to ${provider.label} (${modelToUse}):`, transcription.substring(0, 100) + '...');
    logTransportEvent(`${provider.id}.text.request`, {
        model: modelToUse,
        transcription,
    });

    groqConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    if (groqConversationHistory.length > 20) {
        groqConversationHistory = groqConversationHistory.slice(-20);
    }

    const systemPrompt = currentSystemPrompt || 'You are a helpful assistant.';

    try {
        const { url, options } = buildChatRequest({
            provider,
            apiKey,
            model: modelToUse,
            messages: [{ role: 'system', content: systemPrompt }, ...groqConversationHistory],
            thinkingDisabled: config.disableGroqThinking,
        });

        const response = await fetch(url, options);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`${provider.label} API error:`, response.status, errorText);
            logTransportEvent(`${provider.id}.text.http_error`, {
                status: response.status,
                body: errorText,
            });
            sendToRenderer('update-status', `${provider.label} error: ${response.status}`);
            return;
        }

        logTransportEvent(`${provider.id}.text.http_response`, {
            status: response.status,
        });

        let isFirst = true;
        const { fullText, finishReason } = await streamChatCompletion(response, {
            onText: displayText => {
                sendToRenderer(isFirst ? 'new-response' : 'update-response', displayText);
                isFirst = false;
            },
            onChunk: chunk => logTransportEvent(`${provider.id}.text.stream_chunk`, { chunk }),
            onEvent: event => logTransportEvent(`${provider.id}.text.stream_event`, event),
            onParseError: (data, error) =>
                logTransportEvent(`${provider.id}.text.stream_parse_error`, {
                    data,
                    error: error.message,
                }),
        });

        const cleanedResponse = stripThinkingTags(fullText);

        if (provider.usageBucket) {
            const modelKey = modelToUse.split('/').pop();
            const historyChars = groqConversationHistory.reduce((sum, msg) => sum + (msg.content || '').length, 0);
            const inputChars = systemPrompt.length + historyChars;
            incrementCharUsage(provider.usageBucket, modelKey, inputChars + cleanedResponse.length);
        }

        if (cleanedResponse) {
            groqConversationHistory.push({
                role: 'assistant',
                content: cleanedResponse,
            });

            saveConversationTurn(transcription, cleanedResponse);
        } else {
            console.warn(`${provider.label} returned no final answer (${modelToUse})`);
            logTransportEvent(`${provider.id}.text.empty_response`, {
                model: modelToUse,
                fullText,
                finishReason,
            });
            sendToRenderer('new-response', emptyResponseMessage(provider));
            sendToRenderer('update-status', `${provider.label} reached the completion-token limit`);
            return;
        }

        logTransportEvent(`${provider.id}.text.completed`, {
            model: modelToUse,
            response: cleanedResponse,
        });
        console.log(`${provider.label} response completed (${modelToUse})`);
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error(`Error calling ${provider.label} API:`, error);
        logTransportEvent(`${provider.id}.text.error`, {
            error: error.message,
            stack: error.stack,
        });
        sendToRenderer('update-status', `${provider.label} error: ` + error.message);
    }
}
```

- [ ] **Step 7: Replace `sendImageToGroq` with the provider-agnostic image path**

Delete `sendImageToGroq` (lines 424-546) and put this in its place:

```js
async function sendImageToProvider(provider, base64Data, prompt) {
    const apiKey = PROVIDER_KEY_GETTERS[provider.id]();
    const config = getConfig();
    const model = config[provider.imageModelKey];

    logTransportEvent(`${provider.id}.image.request`, {
        model,
        prompt,
        imageBytes: Buffer.byteLength(base64Data, 'base64'),
    });

    try {
        const { url, options } = buildChatRequest({
            provider,
            apiKey,
            model,
            messages: [
                { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:image/jpeg;base64,${base64Data}`,
                            },
                        },
                    ],
                },
            ],
            thinkingDisabled: config.disableGroqThinking,
        });

        const response = await fetch(url, options);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`${provider.label} image API error:`, response.status, errorText);
            logTransportEvent(`${provider.id}.image.http_error`, {
                status: response.status,
                body: errorText,
            });
            return { success: false, error: `${provider.label} error: ${response.status}` };
        }

        logTransportEvent(`${provider.id}.image.http_response`, {
            status: response.status,
        });

        let isFirst = true;
        const { fullText, finishReason } = await streamChatCompletion(response, {
            onText: displayText => {
                sendToRenderer(isFirst ? 'new-response' : 'update-response', displayText);
                isFirst = false;
            },
            onChunk: chunk => logTransportEvent(`${provider.id}.image.stream_chunk`, { chunk }),
            onEvent: event => logTransportEvent(`${provider.id}.image.stream_event`, event),
            onParseError: (data, error) =>
                logTransportEvent(`${provider.id}.image.stream_parse_error`, {
                    data,
                    error: error.message,
                }),
        });

        const cleanedResponse = stripThinkingTags(fullText);
        if (!cleanedResponse) {
            logTransportEvent(`${provider.id}.image.empty_response`, {
                model,
                fullText,
                finishReason,
            });
            return { success: false, error: emptyResponseMessage(provider) };
        }

        saveScreenAnalysis(prompt, cleanedResponse, model);
        logTransportEvent(`${provider.id}.image.completed`, {
            model,
            response: cleanedResponse,
        });
        return { success: true, text: cleanedResponse, model };
    } catch (error) {
        console.error(`Error calling ${provider.label} image API:`, error);
        logTransportEvent(`${provider.id}.image.error`, {
            error: error.message,
            stack: error.stack,
        });
        return { success: false, error: error.message };
    }
}
```

- [ ] **Step 8: Rewire the four remaining call sites**

Line ~690, Gemini Live output transcription suppression:

```js
                    if (!getAnswerProvider() && message.serverContent?.outputTranscription?.text) {
```

Line ~698, the turn-save path:

```js
                            if (!getAnswerProvider() && messageBuffer.trim() !== '') {
```

Line ~1200, the `send-image-content` handler:

```js
            const imageProvider = getAnswerProvider();
            const result = imageProvider
                ? await sendImageToProvider(imageProvider, data, prompt)
                : await sendImageToGeminiHttp(data, prompt);
            return result;
```

Line ~1239, the `send-text-message` handler:

```js
            const textProvider = getAnswerProvider();
            if (textProvider) {
                groqRequestStartedForTurn = true;
                sendTextToProvider(textProvider, text.trim());
            }
```

- [ ] **Step 9: Verify no stale references remain**

Run:

```bash
grep -n "hasGroqKey\|sendToGroq\|sendImageToGroq\|GROQ_EMPTY_RESPONSE_MESSAGE\|GROQ_MAX_COMPLETION_TOKENS\|sendFinalTranscriptionToGroq" src/utils/gemini.js
```

Expected: **no output.** Any hit is a call site that was missed.

Then confirm the dead code was left alone:

```bash
grep -c "sendToGemma\|trimConversationHistoryForGemma" src/utils/gemini.js
```

Expected: `3` (one definition and one call of `trimConversationHistoryForGemma`, one definition of `sendToGemma`).

- [ ] **Step 10: Verify the module parses and the unit tests still pass**

Run:

```bash
node --check src/utils/gemini.js && npm test
```

Expected: no parse errors, `# pass 22`, `# fail 0`.

- [ ] **Step 11: Commit**

```bash
npx prettier --write src/utils/gemini.js
git add src/utils/gemini.js
git commit -m "feat: resolve answer provider by key precedence and unify send paths"
```

---

## Task 7: Settings UI

**Files:**
- Modify: `src/components/views/MainView.js` — state properties (~699-705), constructor defaults (~728-734), load logic (~758-775), save handlers (~940-970), template (~1190-1234)

**Interfaces:**
- Consumes: `storage.getOpenRouterApiKey` / `storage.setOpenRouterApiKey` from Task 5; config keys `openrouterModel` / `openrouterImageModel` from Task 4.
- Produces: nothing consumed by later tasks.

The three OpenRouter fields are appended **below** the existing Groq fields. Nothing existing moves.

- [ ] **Step 1: Add the reactive state properties**

In the `static properties` block, directly after `_groqModel: { type: String }` (or the equivalent `_groqImageModel` entry), add:

```js
        _openrouterKey: { state: true },
        _openrouterModel: { state: true },
        _openrouterImageModel: { state: true },
```

- [ ] **Step 2: Add the constructor defaults**

In the constructor, directly after `this._groqModel = 'qwen/qwen3.6-27b';`, add:

```js
        this._openrouterKey = '';
        this._openrouterModel = 'qwen/qwen3.8-27b';
        this._openrouterImageModel = 'qwen/qwen3.8-27b';
```

- [ ] **Step 3: Load the saved values**

In the same load block that populates `this._groqKey` and `this._groqModel`, add:

```js
            this._openrouterKey = (await cheatingDaddy.storage.getOpenRouterApiKey().catch(() => '')) || '';
            this._openrouterModel = config.openrouterModel || 'qwen/qwen3.8-27b';
            this._openrouterImageModel = config.openrouterImageModel || 'qwen/qwen3.8-27b';
```

- [ ] **Step 4: Add the save handlers**

Directly after the existing `_saveGroqModel` handler, add:

```js
    async _saveOpenRouterKey(val) {
        this._openrouterKey = val;
        await cheatingDaddy.storage.setOpenRouterApiKey(val);
    }

    async _saveOpenRouterModel(val) {
        this._openrouterModel = val;
        await cheatingDaddy.storage.updateConfig('openrouterModel', val);
    }

    async _saveOpenRouterImageModel(val) {
        this._openrouterImageModel = val;
        await cheatingDaddy.storage.updateConfig('openrouterImageModel', val);
    }
```

- [ ] **Step 5: Add the form fields**

In the "AI responses" `<details>` block, directly after the Groq Image Model `form-group` closes and **before** the `config-checkbox` label, insert:

```js
                    <div class="form-group">
                        <label class="form-label">OpenRouter API Key</label>
                        <input
                            type="password"
                            placeholder="Optional"
                            .value=${this._openrouterKey}
                            @input=${e => this._saveOpenRouterKey(e.target.value)}
                        />
                        <div class="form-hint">
                            <span class="link" @click=${() => this.onExternalLink('https://openrouter.ai/keys')}>Get OpenRouter key</span>
                        </div>
                    </div>

                    <div class="form-group">
                        <label class="form-label">OpenRouter Model</label>
                        <input type="text" .value=${this._openrouterModel} @input=${e => this._saveOpenRouterModel(e.target.value)} />
                    </div>

                    <div class="form-group">
                        <label class="form-label">OpenRouter Image Model</label>
                        <input
                            type="text"
                            .value=${this._openrouterImageModel}
                            @input=${e => this._saveOpenRouterImageModel(e.target.value)}
                        />
                    </div>
```

- [ ] **Step 6: Update the section description**

Change the summary description from:

```js
                        <span class="config-summary-description">Groq key and response model</span>
```

to:

```js
                        <span class="config-summary-description">Answer provider keys and models</span>
```

- [ ] **Step 7: Update the fallback hint**

Change the `config-note` text from:

```
If the Groq API key is empty, Gemini Live is used for answers instead. Its answer quality may be lower.
```

to:

```
If an OpenRouter key is set it is used for answers. Otherwise Groq is used, and if neither is set,
Gemini Live answers directly — its answer quality may be lower.
```

- [ ] **Step 8: Verify the module parses**

Run:

```bash
node --check src/components/views/MainView.js && echo "MainView parses OK"
```

Expected: `MainView parses OK`

- [ ] **Step 9: Verify every handler is wired**

Run:

```bash
grep -c "_saveOpenRouterKey\|_saveOpenRouterModel\|_saveOpenRouterImageModel" src/components/views/MainView.js
```

Expected: `6` — each of the three handlers appears exactly twice (definition plus template binding).

- [ ] **Step 10: Commit**

```bash
npx prettier --write src/components/views/MainView.js
git add src/components/views/MainView.js
git commit -m "feat: add openrouter key and model fields to settings"
```

---

## Task 8: End-to-end verification

**Files:**
- Modify: `repo/PROJECT_REVIEW.md` (provider-routing description)

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: nothing.

- [ ] **Step 1: Confirm the unit suite passes from a clean state**

```bash
npm test
```

Expected: `# pass 22`, `# fail 0`.

- [ ] **Step 2: Launch the app**

```bash
npm start
```

The app window should open with no console errors mentioning `openrouter`, `undefined`, or `Cannot find module`.

- [ ] **Step 3: Run the regression rows first**

These two rows must behave exactly as they did before this change. Run them **before** the new-feature rows so a regression is caught early.

| Key state | Spoken question | Typed message | Screenshot |
|---|---|---|---|
| Neither key set | Gemini Live answers | Gemini Live answers | Gemini HTTP (flash model) |
| Groq key only | Groq answers | Groq answers | Groq vision model |

For each cell: start a session, trigger the input, confirm a response card appears and the status line returns to `Listening...`.

- [ ] **Step 4: Run the new-feature rows**

| Key state | Spoken question | Typed message | Screenshot |
|---|---|---|---|
| OpenRouter key only | OpenRouter answers | OpenRouter answers | OpenRouter vision model |
| Both keys set | OpenRouter answers | OpenRouter answers | OpenRouter vision model |

The "Both keys set" row is the precedence proof: with a valid Groq key *also* present, every response must still come from OpenRouter.

- [ ] **Step 5: Confirm exactly one provider generated per turn**

For the "Both keys set" run, inspect the session transport log:

```bash
ls -t ~/.config/cheating-daddy-config/logs/*.json | head -1 | xargs -I{} node -e "
const events = require('{}');
const counts = {};
for (const e of events) {
    const bucket = e.type.split('.')[0];
    counts[bucket] = (counts[bucket] || 0) + 1;
}
console.log(counts);
console.log('groq events:', Object.keys(counts).filter(k => k === 'groq').length === 0 ? 'NONE (correct)' : 'PRESENT (BUG)');
"
```

Expected: `openrouter.*` events present, **zero** `groq.*` events. Any `groq.*` event during a run with an OpenRouter key set means the precedence check is being bypassed somewhere.

- [ ] **Step 6: Verify the error path does not cascade**

Set the OpenRouter key to a deliberately invalid value (e.g. `sk-or-invalid`), keep a valid Groq key set, and ask a question.

Expected: the status line shows `OpenRouter error: 401` and **no answer appears**. If a Groq or Gemini answer appears instead, the no-cascade requirement has been violated — that is a bug, not a fallback.

- [ ] **Step 7: Update the review document**

In `repo/PROJECT_REVIEW.md`, in the "Answer path in byok mode" section, replace the sentence:

```
Gemini Live is used as the **ear**; Groq is used as the **mouth** whenever a Groq key is configured:
```

with:

```
Gemini Live is used as the **ear**; an OpenAI-compatible provider is used as the **mouth**. Provider
precedence is OpenRouter, then Groq, then Gemini Live itself if neither key is set — resolved by
`getAnswerProvider()` in `gemini.js`, with the shared request/stream logic in
`src/utils/openaiCompatible.js`.
```

- [ ] **Step 8: Commit**

```bash
npx prettier --write repo/PROJECT_REVIEW.md
git add repo/PROJECT_REVIEW.md
git commit -m "docs: record openrouter provider precedence in review"
```

---

## Rollback

Every task is a single commit touching a disjoint set of files except Task 6, which is the only one that modifies existing behavior. To revert the feature entirely while keeping the extracted module, revert Tasks 6 and 7. To revert everything, `git revert` the eight commits in reverse order.
