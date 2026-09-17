# Design: OpenRouter as an answer provider

**Date:** 2026-09-17
**Status:** Approved for planning
**Baseline:** `master` @ `3cccc36` (v0.8.0)

## Goal

Add an OpenRouter API key, alongside the existing Groq key, as an alternative source of AI answers.
OpenRouter answers when its key is set; otherwise Groq; otherwise Gemini Live, exactly as today.

## Non-goals

This change adds a provider. It does not alter how the app behaves for anyone who does not set an
OpenRouter key. Two known defects are inherited unchanged rather than fixed here:

- Gemini Live still generates a complete spoken answer that is discarded whenever another provider is
  answering. OpenRouter inherits this cost and latency exactly as Groq has it today.
- The answer provider still fires on the first `inputTranscription` fragment rather than on the settled
  utterance (the `groqRequestStartedForTurn` latch). OpenRouter inherits this identically.

Both are recorded in `repo/PROJECT_REVIEW.md` findings #7 and #8 and are out of scope.

Also out of scope: deleting the unreachable `sendToGemma()` (gemini.js:548-632), renaming
`groqConversationHistory`, and adding usage tracking for OpenRouter.

---

## D-1. Precedence

Pure key-presence gating, with no provider selector in the UI:

```
hasOpenRouterKey()  → OpenRouter answers
else hasGroqKey()   → Groq answers
else                → Gemini Live answers   (null provider)
```

To switch back from OpenRouter to Groq, a user clears the OpenRouter key. This mirrors how Groq is
enabled and disabled today and adds no new configuration concept.

A single resolver replaces the `hasGroqKey()` predicate:

```js
function getAnswerProvider() {
    if (getOpenRouterApiKey().trim()) return PROVIDERS.openrouter;
    if (getGroqApiKey().trim())       return PROVIDERS.groq;
    return null;
}
```

`null` means "Gemini Live answers", preserving today's exact semantics at every call site.

### Call sites

All six existing `hasGroqKey()` uses in `src/utils/gemini.js` swap one truthy check for another. With
no OpenRouter key set, every branch evaluates identically to today.

| Line | Today | After |
|---|---|---|
| 215 | `!hasGroqKey() \|\| groqRequestStartedForTurn` | `!provider \|\| groqRequestStartedForTurn` |
| 690 | `!hasGroqKey() && outputTranscription?.text` | `!provider && outputTranscription?.text` |
| 698 | `!hasGroqKey() && messageBuffer.trim()` | `!provider && messageBuffer.trim()` |
| 1200 | `hasGroqKey() ? sendImageToGroq(…) : sendImageToGeminiHttp(…)` | `provider ? sendImageToProvider(provider, …) : sendImageToGeminiHttp(…)` |
| 1239 | `if (hasGroqKey())` | `if (provider)` |

`hasGroqKey()` itself (line 209) is replaced by `getAnswerProvider()`.

## D-2. Modality parity

OpenRouter serves both paths Groq serves today:

| Input | Route |
|---|---|
| Spoken question (via Gemini Live transcription) | `sendTextToProvider(provider, transcription)` |
| Typed message | `sendTextToProvider(provider, text)` |
| Screenshot | `sendImageToProvider(provider, base64, prompt)` |

Three new settings mirror Groq's three: key, text model, image model.

## D-3. Shared OpenAI-compatible client

Groq and OpenRouter are both OpenAI-compatible. Everything except the base URL, auth header, extra
headers, reasoning parameters, and usage bucket is identical logic. Today that logic is duplicated
across `sendToGroq` (~150 lines) and `sendImageToGroq` (~120 lines); adding OpenRouter by copy-paste
would make it four copies.

The provider-agnostic half moves to a new **`src/utils/openaiCompatible.js`**, which imports nothing
from Electron and holds no application state. This avoids any circular dependency with `gemini.js`
and makes the extracted logic directly unit-testable under plain `node --test`.

```
openaiCompatible.js (pure)          gemini.js (orchestration, unchanged in kind)
  PROVIDERS                    ←      getAnswerProvider()
  buildChatRequest()                  sendTextToProvider()    ── history, usage accounting,
  streamChatCompletion()              sendImageToProvider()      saveConversationTurn,
  stripThinkingTags()  (moved)                                   renderer events, transport logs
```

### Provider descriptors

```js
PROVIDERS = {
    groq: {
        id: 'groq',
        label: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        getApiKey: getGroqApiKey,
        textModelKey: 'groqModel',
        imageModelKey: 'groqImageModel',
        usageBucket: 'groq',              // limits.json section
        reasoningOptions: getGroqReasoningOptions,
    },
    openrouter: {
        id: 'openrouter',
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        getApiKey: getOpenRouterApiKey,
        textModelKey: 'openrouterModel',
        imageModelKey: 'openrouterImageModel',
        usageBucket: null,                // see D-6
        extraHeaders: { 'HTTP-Referer': 'https://cheatingdaddy.com', 'X-Title': 'Cheating Daddy' },
        reasoningOptions: getOpenRouterReasoningOptions,
    },
};
```

`getGroqReasoningOptions` moves across unchanged, preserving its exact current behavior
(`reasoning_format: 'hidden'` plus `reasoning_effort: 'none'` for qwen3 models; `include_reasoning:
false` for `openai/gpt-oss-*`; `{}` otherwise).

`getOpenRouterReasoningOptions` uses OpenRouter's unified `reasoning` object, whose semantics were
confirmed against the live docs: `effort` accepts `"max" | "xhigh" | "high" | "medium" | "low" |
"minimal" | "none"`, and `exclude` (default `false`) only *withholds reasoning tokens from the
response* — the model still generates them and still bills for them.

The two flags therefore map to different Groq behaviors and both are needed:

```js
function getOpenRouterReasoningOptions(model, disableThinking) {
    // exclude:true mirrors Groq's always-on reasoning_format:'hidden'
    const reasoning = { exclude: true };
    // effort:'none' mirrors Groq's reasoning_effort:'none' — actually suppresses generation
    if (disableThinking) reasoning.effort = 'none';
    return { reasoning };
}
```

Using `exclude: true` alone for the disabled case would be a bug: reasoning would still be generated,
costing the latency the checkbox exists to avoid. Unlike Groq's version, this mapping is not
model-specific, because OpenRouter normalizes the parameter across model families.

`max_completion_tokens: 16384` and `temperature: 0.7` stay as they are for both providers.

Net effect on `gemini.js`: one text path and one image path replace two of each. The file shrinks by
roughly 200 lines without `sendToGemma` being touched.

## D-4. Storage schema

No `CONFIG_VERSION` bump. `getConfig()` spreads `{ ...DEFAULT_CONFIG, ...saved }`, so new keys reach
existing installs automatically. Bumping the version would trigger `resetConfigDir()` and destroy every
user's saved API keys and session history.

**`credentials.json`** gains `openrouterApiKey: ''`. `getCredentials()` reads the saved file without
spreading defaults, so `getOpenRouterApiKey()` resolves `undefined || ''` to `''` on existing installs
with no migration.

**`config.json`** gains:

```js
openrouterModel:      'qwen/qwen3.8-27b',
openrouterImageModel: 'qwen/qwen3.8-27b',
```

`qwen/qwen3.8-27b` was verified present in OpenRouter's live catalog with
`input_modalities: ['text', 'image', 'video']`, so it is valid for both the text and the image path.

**`disableGroqThinking` → `disableThinking`.** The checkbox is already labelled just "Disable thinking"
in the UI and now governs both providers, so the stored key is renamed with a read-time fallback:

```js
const thinkingDisabled = config.disableThinking ?? config.disableGroqThinking ?? true;
```

> This is the one schema change in the design that is not purely additive. The fallback means existing
> users keep their saved setting. If it is unwanted, keeping `disableGroqThinking` as the stored name
> works identically and touches eight fewer lines.

### New storage surface

`getOpenRouterApiKey()` / `setOpenRouterApiKey()` in `storage.js`, mirroring the Groq pair; two IPC
handlers (`storage:get-openrouter-api-key`, `storage:set-openrouter-api-key`) in `index.js`; two
matching methods on the renderer's storage wrapper in `renderer.js`.

## D-5. UI

Three fields are appended to the existing "AI responses" `<details>` block in
`src/components/views/MainView.js` (~line 1190). Nothing existing moves.

```
AI responses
──────────────────────────────────
Groq API Key            [••••••]
Groq Model              [qwen/qwen3.6-27b]
Groq Image Model        [qwen/qwen3.6-27b]

OpenRouter API Key      [••••••]
OpenRouter Model        [qwen/qwen3.8-27b]
OpenRouter Image Model  [qwen/qwen3.8-27b]

☐ Disable thinking
```

The section summary description changes from "Groq key and response model" to "Answer provider keys
and models". The hint at line 1231 changes from:

> If the Groq API key is empty, Gemini Live is used for answers instead. Its answer quality may be lower.

to:

> If an OpenRouter key is set it is used for answers. Otherwise Groq is used, and if neither is set,
> Gemini Live answers directly — its answer quality may be lower.

A "Get OpenRouter key" link points at `https://openrouter.ai/keys`, matching the existing Groq link
pattern, routed through the existing `open-external` IPC handler.

Three new reactive state fields (`_openrouterKey`, `_openrouterModel`, `_openrouterImageModel`) and
three save handlers mirror the Groq ones exactly.

## D-6. Usage accounting

`limits.json` exists to protect free tiers: Gemini's 20 requests/day and Groq's daily character caps.
OpenRouter is prepaid credit with no comparable daily allowance, so tracking characters there would be
noise. `usageBucket: null` makes the shared client skip `incrementCharUsage` entirely for OpenRouter.

Groq's accounting is unchanged: `incrementCharUsage('groq', modelKey, inputChars + outputChars)`, where
`modelKey` remains `model.split('/').pop()`.

## D-7. Error handling

OpenRouter failures behave exactly as Groq failures do today. **There is no cascade to another
provider.** A failed OpenRouter call does not silently retry against Groq or Gemini.

| Condition | Behavior |
|---|---|
| Non-2xx HTTP | Log body, `logTransportEvent('openrouter.text.http_error')`, status line shows `OpenRouter error: <status>`, return |
| Stream parse error | Logged per-chunk to the transport log, stream continues (matches Groq) |
| Empty final answer | Status line + response card explaining the completion-token limit, mirroring `GROQ_EMPTY_RESPONSE_MESSAGE` |
| Network throw | Caught, status line shows `OpenRouter error: <message>` |

Rationale: a cascade would hide a bad or exhausted key behind silently degraded answers in the middle
of a live interview. Surfacing the failure matches current behavior and is the safer default.

Transport log event names follow the existing convention, parameterized by provider id:
`<provider>.text.request`, `.http_error`, `.stream_chunk`, `.stream_event`, `.completed`, and the
`.image.*` equivalents.

## D-8. Conversation history

`groqConversationHistory` continues to serve whichever provider is active, keeping its current name and
its 20-turn trim. A clarifying comment is added. It is still deliberately preserved across Gemini Live
reconnects (gemini.js:784).

Because precedence is resolved per call, switching providers mid-session by editing a key carries the
existing conversation forward rather than resetting it. This is the desired behavior — the user is in
one conversation regardless of who is answering.

---

## Verification

The repository has no test suite. This change introduces the first one, scoped to the newly extracted
pure module, because that is the only place where existing working logic is restructured.

**Automated** — `node --test` against `src/utils/openaiCompatible.js`:

- `streamChatCompletion` parses multi-line SSE frames, ignores `[DONE]`, and survives a malformed frame
- `stripThinkingTags` strips complete `<think>…</think>` blocks, handles an unterminated block, and
  returns `''` for a partial opening tag (the existing `'<think>'.startsWith(trimmed)` behavior)
- `buildChatRequest` emits the correct base URL, auth header, and extra headers per provider
- `getGroqReasoningOptions` output is unchanged for qwen3, `openai/gpt-oss-*`, and other models

**Manual** — a 4×3 matrix run against the real app:

| Key state | Spoken question | Typed message | Screenshot |
|---|---|---|---|
| Neither key | Gemini Live answers | Gemini Live answers | Gemini HTTP (flash) |
| Groq only | Groq answers | Groq answers | Groq vision |
| OpenRouter only | OpenRouter answers | OpenRouter answers | OpenRouter vision |
| Both keys | OpenRouter answers | OpenRouter answers | OpenRouter vision |

The **Groq only** and **Neither key** rows are the regression proof: they must behave identically to
v0.8.0. The **Both keys** row proves precedence. Each run is checked against the session transport log
in `<config>/logs/<sessionId>.json` to confirm exactly one provider generated per turn — the
double-generation failure mode this precedence rule exists to prevent.

## Files touched

| File | Change |
|---|---|
| `src/utils/openaiCompatible.js` | **New.** Pure provider descriptors, request builder, SSE stream reader, thinking-tag stripper |
| `src/utils/gemini.js` | `getAnswerProvider()` replaces `hasGroqKey()`; `sendToGroq`/`sendImageToGroq` collapse into `sendTextToProvider`/`sendImageToProvider`; six call sites updated |
| `src/storage.js` | `openrouterApiKey` credential; two config defaults; `getOpenRouterApiKey`/`setOpenRouterApiKey`; `disableThinking` with fallback |
| `src/index.js` | Two IPC handlers |
| `src/utils/renderer.js` | Two storage-wrapper methods |
| `src/components/views/MainView.js` | Three fields, three state props, three handlers, summary + hint text |
| `test/openaiCompatible.test.js` | **New.** Unit tests for the extracted module |

Untouched: `sendToGemma()`, `prompts.js`, `cloud.js`, `localai.js`, `native-ai-runtime.js`,
`window.js`, and every other view.
