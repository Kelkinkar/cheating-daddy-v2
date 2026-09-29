# cheating-daddy — Codebase Review

_Reviewed 2026-09-17 against `master` @ `3cccc36` (v0.8.0). Updated 2026-09-29 against `master` @ `e45dc25`,
plus uncommitted response-length and rendering work in the working tree (§7)._

Fork of [sohzm/cheating-daddy](https://github.com/sohzm/cheating-daddy). Electron overlay app that listens to
system/mic audio + screen, and streams AI answers to a transparent always-on-top window. Used as an
interview/meeting teleprompter.

---

## 1. Stack and shape

|                |                                                                        |
| -------------- | ---------------------------------------------------------------------- |
| Runtime        | Electron 30, plain JavaScript (no TS, no build step, no bundler)       |
| UI             | Lit 2.7 web components, loaded from vendored `src/assets/lit-*.min.js` |
| Packaging      | Electron Forge 7 (squirrel / dmg / AppImage), `forge.config.js`        |
| Deps (runtime) | `@google/genai`, `ws`, `electron-squirrel-startup` — that's all        |
| Tests          | `node --test` — 26 unit tests in `test/openaiCompatible.test.js`       |
| Lint           | none (`npm run lint` echoes "No linting configured")                   |
| Format         | Prettier: 4 spaces, width 150, single quotes (`.prettierrc`)           |

`src/index.js` is the main process; there is **no functioning preload** — `src/preload.js` is a
comment-only stub and is never referenced. The renderer runs with `nodeIntegration: true` and
`contextIsolation: false` (`src/utils/window.js:27-28`, with a `// TODO: change to true`), so the
renderer `require()`s `electron` and node modules directly.

### Directory map

```
src/
  index.js                 main process: app lifecycle + all storage/general IPC handlers
  preload.js               STUB (empty, unused)
  index.html               CSS design tokens + script tags; mounts <cheating-daddy-app>
  storage.js               JSON file persistence in ~/.config/cheating-daddy-config
  audioUtils.js            PCM→WAV + debug audio dump (only used when DEBUG_AUDIO is set)
  utils/
    window.js              BrowserWindow creation, global shortcuts, window IPC
    gemini.js              the real hub. Gemini Live + provider routing/orchestration
    openaiCompatible.js    pure: provider descriptors, request builder, SSE reader (unit-tested)
    cloud.js               WebSocket client for wss://api.cheatingdaddy.com (UI disabled)
    localai.js             offline path: VAD → whisper.cpp server → llama.cpp server
    native-ai-runtime.js   downloads/verifies llama & whisper binaries + GGUF models
    prompts.js             6 profile system prompts (interview/sales/meeting/…/exam)
    transportLogger.js     per-session JSON event log under <config>/logs/
    renderer.js            renderer-side glue: capture, screenshots, storage wrapper, theme
  components/
    app/CheatingDaddyApp.js   root component, view router, session lifecycle (997 lines)
    app/AppHeader.js
    views/{Main,Customize,AICustomize,Assistant,History,Help,Feedback,Onboarding}View.js
```

---

## 2. Runtime architecture

### Provider modes

`gemini.js` holds a module-level `currentProviderMode` of `'byok' | 'cloud' | 'local'`. Every
audio/text/image IPC handler branches on it.

- **byok** (default): Gemini Live WebSocket via `@google/genai` `client.live.connect()`, API version
  `v1alpha`, model from `config.geminiLiveModel`. Audio modality out, input+output transcription on,
  speaker diarization (2 speakers, mapped to `Interviewer` / `Candidate`), Google Search tool
  optional, sliding-window context compression.
- **cloud**: `ws` client to `wss://api.cheatingdaddy.com/ws?token=…`. Backend wiring is complete but
  **the UI is deliberately disabled** (`MainView.js:1146` comment; `CheatingDaddyApp.js:600` coerces
  a stored `'cloud'` preference back to `'byok'`). The whole `if (providerMode === 'cloud')` branch in
  `handleStart` is therefore unreachable today.
- **local**: fully offline. See §3.

### Answer path in byok mode (the important bit)

Gemini Live is used as the **ear**; an OpenAI-compatible provider is used as the **mouth**. Provider
precedence is OpenRouter, then Groq, then Gemini Live itself if neither key is set — resolved by
`getAnswerProvider()` in `gemini.js`, with the shared request/stream logic in
`src/utils/openaiCompatible.js`:

1. Audio chunks (24 kHz mono PCM, 100 ms) → `sendRealtimeInput`.
2. `serverContent.inputTranscription` accumulates into `currentTranscription`.
3. The answer fires on Gemini's end-of-turn signal. With a native-audio model, that is Gemini's
   first `modelTurn`/`outputTranscription` after the input (median 735 ms after the last fragment).
   With a transcription model (`gemini-3.5-transcribe-live`), it is the `generationComplete` that
   follows each whole utterance. Each inputTranscription message also (re)arms a 1500 ms settle
   timer (`scheduleAnswerForSettledTranscription`) as a fallback for turns Gemini never answers.
   `sendFinalTranscriptionToAnswerProvider()` **consumes** `currentTranscription`, so each send is
   one settled chunk of speech and later speech in the same Gemini turn is sent too. Transcriptions
   that are only noise tags (`<noise>`) are skipped.
4. The resolved provider streams back via `sendTextToProvider`; tokens go to the renderer as
   `new-response` / `update-response`. Voice speech that arrives while an answer is streaming, or
   within 5 s after it finishes, is a **follow-up** (`src/utils/answerThread.js`). It is sent as
   "the interviewer continued their previous question (…) with: … answer only the new part", and its
   answer is appended below the current one on the same card, after a `---` divider. Typed
   questions always open a new card.
5. If **neither** provider key is set, `getAnswerProvider()` returns `null` and Gemini's own
   `outputTranscription` is used as the answer instead.

Screenshots take a different route: `sendImageToProvider` (vision model) if any provider key exists,
else `sendImageToGeminiHttp` with the rate-limit-chosen flash model.

A failed provider call surfaces to the status line and stops — it never cascades to another provider,
so a dead key is visible rather than silently degrading answers mid-interview.

### Reconnection

`onclose` → `attemptReconnect()`, max 3 tries, 2 s apart, recursive. On success it replays the last
20 turns as a synthetic text message (`buildContextMessage`). On exhaustion it emits `reconnect-failed`,
which the renderer renders as a response card.

### Renderer ↔ main

Main→renderer channels: `update-status`, `new-response`, `update-response`, `session-initializing`,
`reconnect-failed`, `save-conversation-turn`, `save-session-context`, `save-screen-analysis`,
`clear-sensitive-data`, `click-through-toggled`, `whisper-downloading`, `local-ai-download-progress`,
`navigate-{previous,next}-response`, `scroll-response-{up,down}`.

Renderer→main: `initialize-{gemini,cloud,local}`, `cancel-local-initialization`,
`send-{audio,mic-audio,image,text}-content` / `send-text-message`, `start/stop-macos-audio`,
`close-session`, `storage:*` (14 handlers), `window-minimize`, `toggle-window-visibility`,
`view-changed`, `open-external`, `get-app-version`, `quit-application`.

`window.cheatingDaddy` in `renderer.js` is the façade the Lit components call; global shortcuts in the
main process reach the UI by `webContents.executeJavaScript('cheatingDaddy.handleShortcut(...)')`.

### Audio capture, per platform

- **macOS**: spawns the bundled `src/assets/SystemAudioDump` binary (stereo 24 kHz → mono in
  `convertStereoToMono`, which just takes the left channel). Mic optional via `getUserMedia`.
- **Windows**: `getDisplayMedia` with `audio: 'loopback'` (set in the display-media request handler).
- **Linux**: `getDisplayMedia` audio if the compositor offers it, else screen-only; mic via
  `getUserMedia`. The README's "Linux (kinda, dont use)" still holds.

### Stealth features

`setContentProtection(true)` (excluded from screen capture), `setSkipTaskbar` on Windows,
`setHiddenInMissionControl` on macOS, `setVisibleOnAllWorkspaces`, click-through toggle, and
`emergencyErase` (Ctrl/Cmd+Shift+E) which hides, closes the session, fires `clear-sensitive-data`
and quits after 300 ms.

---

## 3. Local (offline) mode

`localai.js` + `native-ai-runtime.js` implement a complete offline pipeline with no npm ML deps:

```
24 kHz PCM → resample24kTo16k (linear interp, carries a remainder buffer)
           → energy VAD (RMS; VERY_AGGRESSIVE preset is the active default)
           → on speech-end, WAV-wrap and POST to whisper-server /inference
           → transcript → llama-server /v1/chat/completions (streamed SSE)
```

Binaries and models are downloaded on demand into `<config>/binaries` and `<config>/models`,
each verified by SHA-256 (`installVerifiedFile`), with atomic temp-file + rename. Servers are spawned
on ephemeral ports bound to `127.0.0.1` and health-polled by `waitForServer`. Cancelling an
initialization aborts the fetch and removes any cache entries created during that attempt.

**Linux is unsupported in local mode**: `BINARY_RELEASES` only has `darwin/{arm64,x64}` and
`win32/x64`, so `getPlatformReleases()` throws `Local AI is not available for linux/x64` on this
machine. Models come from Hugging Face; the GGUF is picked by matching the quant string, and the
multimodal projector is hard-required to be exactly `mmproj-BF16.gguf`.

---

## 4. Storage

Plain JSON under the OS config dir (`~/.config/cheating-daddy-config` on Linux):
`config.json`, `credentials.json`, `preferences.json`, `keybinds.json`, `limits.json`,
`history/<sessionId>.json`, `logs/<sessionId>.json`.

- `CONFIG_VERSION = 1`; a version mismatch or missing version **wipes the entire config directory**
  (`resetConfigDir` via `initializeStorage` on every boot). Bumping `CONFIG_VERSION` destroys users'
  API keys and history — deliberate, but sharp.
- **API keys are stored in plaintext** in `credentials.json`. No keytar/safeStorage.
- `limits.json` tracks daily free-tier usage: request counts for flash/flash-lite, character counts
  for Groq models and Gemma.
- Transport logs contain full transcriptions and model responses in cleartext, one file per session,
  never pruned.

---

## 5. Findings

### Bugs / dead code

1. ~~**Rate-limit counting is broken (uncommitted change).**~~ **Resolved 2026-09-17.** The offending
   model-rename was discarded rather than completed; `getAvailableModel()` and `incrementLimitCount()`
   both use `gemini-2.5-flash` / `gemini-2.5-flash-lite` again and the counter matches. If the rename is
   ever revisited, key the counter off a model→bucket map instead of string equality so the two cannot
   drift apart again.
2. **`src/components/index.js` exports a file that doesn't exist** — `./views/AdvancedView.js`. Nothing
   imports `components/index.js`, so it never throws, but it is stale (it also omits `AICustomizeView`
   and `FeedbackView`).
3. **`src/index.html` loads `script.js`, which doesn't exist.** Harmless 404, should be deleted.
4. **Duplicate `update-keybinds` listener.** Registered in both `src/index.js:283` and
   `src/utils/window.js:318`, so `updateGlobalShortcuts` runs twice per change.
5. **Unused import** `isCloudActive` in `gemini.js:7`; `getModelForToday` in `storage.js` is exported but
   called nowhere; `pcmToWav`/`analyzeAudioBuffer` only run under `DEBUG_AUDIO`.
6. `attemptReconnect` recurses on failure _and_ is re-entered from `onclose`; the counter caps it, but
   the control flow is hard to follow and `reconnectAttempts` is never reset on a successful reconnect
   (comment acknowledges this).

### Behavioural risks

7. ~~**The answer provider fires on the first transcription fragment, not the final one.**~~
   **Resolved, in two parts.**
    - _2026-09-17:_ answers were generated from 1–4 character fragments ("What") because
      `sendFinalTranscriptionToAnswerProvider` ran on every `inputTranscription` message. Fixed with an
      settle timer (`TRANSCRIPTION_SETTLE_MS`); measured max inter-fragment gap was 244 ms. Set to
      800 ms initially, raised to 1500 ms on 2026-09-29 so mid-sentence pauses do not split one
      question into two. The trade is latency before the answer starts.
    - _2026-09-29:_ the settle timer introduced a second, opposite defect — `turnComplete` called
      `clearTranscriptionSettleTimer()`, so a turn that ended inside the settle window **cancelled the
      pending answer and dropped the question silently**, with no error and no status change.
      `generationComplete` had the same hole via clearing `currentTranscription`. Confirmed in
      `logs/1790637010665.json`: turn 1's `turnComplete` arrived 292 ms after the last fragment and
      produced no `openrouter.text.request` at all (3 turns, 2 answers). Short questions lose this race
      because Gemini finishes generating fast on short input. Fixed by `flushPendingTranscription()`,
      which sends the pending transcription instead of discarding it.
8. ~~**Gemini Live still generates a full spoken answer even when Groq is answering.**~~
   **Resolved 2026-09-29:** `geminiLiveModel` now defaults to `gemini-3.5-transcribe-live`.
   `liveConfig.js` then asks for TEXT and drops the reply-only options. Without an answer provider it
   falls back to the default native-audio model. This was more than wasted tokens: the spoken reply
   (about 14 s long) is what degraded the interviewer's next words. In live tests, a continuation
   spoken over Gemini's reply was transcribed 2–4 s late, or not at all in 7 of 22 trials. In the real
   app, a question asked while the previous reply was still running came through as "Kubera." and
   "is Cooper Nathan.". With the transcription model, every utterance was exact and complete. The
   earlier "relay mode" quality drop doesn't apply: that experiment had Gemini answer, whereas here the
   answer provider still answers.
9. **`getStoredSetting` executes string-interpolated JS in the renderer** (`gemini.js:170-190`) to read
   `localStorage`, even though a full IPC storage layer exists and `googleSearchEnabled` already lives
   in `preferences.json`. Two sources of truth, and an unnecessary `executeJavaScript`.
10. `saveDebugAudio` writes raw meeting audio to `~/cheating-daddy-debug` when `DEBUG_AUDIO` is set —
    fine for a flag, worth documenting given the privacy posture.

### Security posture

11. `contextIsolation: false` + `nodeIntegration: true` is the single biggest structural risk, and it
    directly contradicts `AGENTS.md` ("maintain Electron's context isolation pattern for IPC"). The CSP
    in `index.html` (`script-src 'self' 'unsafe-inline'`) does not help: `'unsafe-inline'` is exactly
    what permits inline event handlers. **Still open** — the renderer keeps full Node access.

    The response-rendering half of this is **resolved (2026-09-29)**. `AssistantView` calls
    `marked.parse` with `sanitize: false` and assigns the result to `container.innerHTML`; marked
    passes raw HTML through untouched, and while `innerHTML` will not run `<script>`, it does create
    live elements whose inline handlers (`onerror`, `onload`) fire — with `require()` in scope. Model
    output is the vector, since Google Search grounding and screenshot transcription both carry
    outside text into a response. `sanitizeDom()` now walks the parsed tree before rendering and
    applies an allowlist: `ALLOWED_TAGS` for elements marked actually emits, `ALLOWED_ATTRIBUTES`
    per tag (which is what drops every `on*` handler), and scheme checks on `href`/`src`. Dangerous
    elements are removed with their subtree; other unknown elements are unwrapped so their text
    survives. It runs _before_ `wrapWordsInSpans`, so the injected `data-word` spans are not stripped,
    and the two `renderMarkdown` fallback paths route through `sanitizeHtml()` so a raw string never
    reaches the sink.

    Verified in a real Electron renderer (`nodeIntegration: false` harness, the app's own
    `marked-4.3.0`), assigning each payload into a live `innerHTML` sink and inspecting the resulting
    DOM: 9 payloads (img/onerror, script, svg/onload, iframe and anchor `javascript:`, inline
    `onmouseover`, object, form+input) go from dangerous nodes and live `on*` attributes present, to
    zero; 5 legitimate markdown constructs (bold, inline code, lists, fenced code, tables, https
    links) render unchanged; and both real responses from `logs/1790637010665.json` are byte-identical
    with and without the sanitizer, so it is a no-op on genuine answers.

    Remaining hardening, not done: `src/index.html:4` could likely drop `'unsafe-inline'` from
    `script-src`, since all five script tags in that file are external `src=` files and none are
    inline. That would block inline handlers at the browser level as defence in depth. Needs a
    smoke-test of the running app before trusting it.

12. Credentials in plaintext JSON (§4) and full transcripts in `<config>/logs`.
13. On the plus side: downloaded binaries and models are SHA-256 pinned, Forge fuses disable
    `RunAsNode` / `NODE_OPTIONS` / inspect args and enforce ASAR integrity, and local servers bind to
    loopback on ephemeral ports.

---

## 6. Divergence from AGENTS.md

`AGENTS.md` describes an aspirational target (TypeScript strict, React 19, shadcn/ui, Jest, secure IPC).
None of it exists yet — the codebase is JS + Lit + no tests. Two of its TODO items _have_ effectively
landed, though under a different design than described: local whisper.cpp transcription and VAD are
implemented natively in `localai.js`. Dual-stream capture is partial (mic and system audio are captured
on separate channels but merged into one Gemini stream). Speaker diarization is done server-side by
Gemini Live, not tinydiarize.

Treat `AGENTS.md` as direction, not as a description of the repo.

---

## 7. Working-tree state at review time

As of the 2026-09-29 update, `master` is at `e45dc25` with three modified files, all from the
response-length work:

```
M src/utils/prompts.js                    longer-answer targets + global no-code-fence rule
M src/components/views/AssistantView.js   wrapper-fence unwrap + wrapping CSS
M src/utils/gemini.js                     flushPendingTranscription (finding #7)
```

### Response length

Answer length is set by the prompts, not by a token cap. `MAX_COMPLETION_TOKENS = 16384`
(`openaiCompatible.js:48`) is sent as `max_tokens` for OpenRouter and `max_completion_tokens` for
Groq, and is far above what the prompts ask for — it is not the limiter. The limiter is
`formatRequirements` in `prompts.js`: the interview profile targets **4–6 sentences, hard-capped at
150 words**, the sales/meeting/presentation/negotiation profiles **3–5 sentences capped at 120**, and
exam stays at **1–2** because speed is the point there. Few-shot examples in `promptParts.content`
set the real floor, so a change to the targets must change the examples too or the model just
follows the examples.

**Voice and the document-drift failure mode (2026-09-29).** Answers must be first person — the words
the candidate speaks — not advice addressed to the listener. Three symptoms move together and share
one cause. Measured across three consecutive sessions on the same model (`qwen3.8-27b`): the first
two averaged ~156 words with 0–10 first-person pronouns and **zero** bold section headings, while the
third produced 223–340 words, **zero** first-person pronouns, 5–10 second-person constructions, and
2–3 headings per answer. Once the model emits a heading such as `**Architecture & Setup**` it has
decided it is writing a reference document — and documents address the reader as "you" and run to a
page. The structural rules are therefore the load-bearing ones: **no section headings** and **at most
one flat list**, alongside the explicit first-person instruction and the word cap (a sentence ceiling
alone does not bind a bullet list). A fourth example covering the "X vs Y" question shape was added,
since comparison questions are what triggered the drift.

Note that `groqConversationHistory` feeds assistant turns back into each request, so a single
document-shaped answer becomes an in-context example for the next one. Prompt rules govern the first
answer; if drift reappears mid-session, truncating or dropping assistant turns from the replayed
history is the next lever.

Two caveats that are not bugs: reasoning tokens count against `max_tokens`, so a thinking-enabled
model can be truncated mid-answer with `finish_reason: 'length'` (surfaced by `emptyResponseMessage`);
and individual OpenRouter models may cap output below 16384 regardless of what is sent. The local
llama path caps at 2048 (`localai.js:199`), which is still ~7x the 8-sentence ceiling.

### Response rendering

Models intermittently wrap an entire answer in a ` ```markdown ` fence. `marked` then renders the
whole response as one `<pre>`, which shows literal `**` markers and scrolls horizontally instead of
wrapping — observed in `logs/1790637010665.json`, where one of two answers was fenced and the other
was not. Handled at three levels: `unwrapWrapperFence()` in `AssistantView` strips a whole-response
fence before parsing (conservatively — a tagged ` ```python ` block, or a code block followed by
prose, is left alone, and an unterminated fence still unwraps so streaming renders correctly);
`pre` now uses `white-space: pre-wrap` since horizontal scrolling is unusable in a narrow overlay;
and `GLOBAL_OUTPUT_RULES` in `prompts.js` tells every profile not to fence its whole response.

### Answer latency (2026-09-29)

Branch `feat/answer-latency`, plan and all measurements in
`docs/superpowers/plans/2026-09-29-answer-latency.md`. The tools are reusable:
`node scripts/replay-turns.js` replays recorded sessions against trigger policies, and
`node scripts/measure-live-turns.js` streams synthesized speech with controlled pauses into Gemini
Live (`--live-model`, `--pauses`, `--silence`; TTS clips are cached because the free tier allows 10
TTS requests per model per day).

- **Where the time went (gpt-6-luna, before):** 1500 ms settle, 1.0–2.3 s to first token, 1.5–2.2 s
  streaming. About 5.1 s from the last fragment, plus about 1 s of capture-plus-transcription lag in
  the real app.
- **End-of-turn trigger:** replaces the fixed 1500 ms wait in the common case. The replay across 54
  logged questions showed the same split count under every policy, because the real mid-question
  pauses were 1.6–2.9 s, beyond any window worth waiting. Splits are threaded as follow-ups instead.
- **`silenceDurationMs`** (Gemini VAD): 300 / default / 1200 made no measurable difference, and 2000
  only slowed end-of-turn. Left unset.
- **Connection warm-up:** the first fragment of each question pre-opens the OpenRouter socket
  (`warmAnswerProviderConnection`). Measured 408 ms cold vs 132 ms warm.
- **End to end in the real app** (speakers → loopback capture, transcribe-live, gpt-6-luna): speech
  end → request 1.1–1.2 s, first text 2.4–3.0 s, finished 3.9–5.0 s. Follow-ups were threaded under
  the first answer and answered only the new part.

## 8. Where to start for common tasks

| Task                                                | File                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| Change how answers are generated / routed           | `src/utils/gemini.js`                                                       |
| Change what the AI is told to do                    | `src/utils/prompts.js`                                                      |
| Change capture, screenshots, or the renderer façade | `src/utils/renderer.js`                                                     |
| Add a settings field                                | `src/storage.js` defaults → `src/index.js` IPC → `MainView`/`CustomizeView` |
| Window behaviour, shortcuts, stealth                | `src/utils/window.js`                                                       |
| Offline pipeline                                    | `src/utils/localai.js`, `src/utils/native-ai-runtime.js`                    |
| Debug a live session                                | `<config>/logs/<sessionId>.json` via `transportLogger.js`                   |
| Measure answer latency / split questions            | `scripts/replay-turns.js`, `scripts/measure-live-turns.js`                  |
| Change follow-up threading                          | `src/utils/answerThread.js`                                                 |
