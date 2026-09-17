# cheating-daddy — Codebase Review

_Reviewed 2026-09-17 against `master` @ `3cccc36` (v0.8.0), plus uncommitted changes in the working tree._

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
| Tests          | none                                                                   |
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
3. On _any_ inputTranscription message, `sendFinalTranscriptionToAnswerProvider()` fires once per
   turn (guard `groqRequestStartedForTurn`, reset on `turnComplete`).
4. The resolved provider streams back via `sendTextToProvider`; tokens go to the renderer as
   `new-response` / `update-response`.
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

1. **Rate-limit counting is broken (uncommitted change).** `src/storage.js:334,336` now increments on
   `'gemini-3.7-flash'` / `'gemini-3.5-flash-lite'`, but `getAvailableModel()` (`src/storage.js:392-400`)
   still returns `'gemini-2.5-flash'` / `'gemini-2.5-flash-lite'`. `incrementLimitCount(model)` is called
   with the value from `getAvailableModel()`, so **neither branch ever matches** — screenshot requests are
   no longer counted and the free-tier guard is inert. Either update both or key the counter off a
   model→bucket map instead of string equality.
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

7. **Groq fires on the first transcription fragment, not the final one.** `sendFinalTranscriptionToGroq`
   is called from _every_ `inputTranscription` message and latches `groqRequestStartedForTurn = true`.
   Gemini Live's input transcription arrives heavily fragmented, so the answer is frequently generated
   from a partial question, and later fragments of the same utterance are dropped until `turnComplete`.
   This is the root of the "compound question" class of bugs. A debounce on transcription settling, or
   waiting for a turn boundary, is the fix.
8. **Gemini Live still generates a full spoken answer even when Groq is answering.** With a Groq key set,
   `outputTranscription` is simply not forwarded to the UI — the tokens are still generated and billed.
   A previous "relay mode" experiment (making Gemini a silent transcriber) was reverted because answer
   quality dropped; worth revisiting with a narrower prompt rather than a one-character relay.
9. **`getStoredSetting` executes string-interpolated JS in the renderer** (`gemini.js:170-190`) to read
   `localStorage`, even though a full IPC storage layer exists and `googleSearchEnabled` already lives
   in `preferences.json`. Two sources of truth, and an unnecessary `executeJavaScript`.
10. `saveDebugAudio` writes raw meeting audio to `~/cheating-daddy-debug` when `DEBUG_AUDIO` is set —
    fine for a flag, worth documenting given the privacy posture.

### Security posture

11. `contextIsolation: false` + `nodeIntegration: true` is the single biggest structural risk, and it
    directly contradicts `AGENTS.md` ("maintain Electron's context isolation pattern for IPC"). The CSP
    in `index.html` (`script-src 'self' 'unsafe-inline'`) is the only thing standing between injected
    markup and full node access. Responses are rendered through `marked` — check the sanitizer settings
    in `AssistantView` before trusting that.
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

```
M README.md          + upstream URL line
M package-lock.json  dependency pruning (~100 lines removed)
M src/storage.js     model-name rename that breaks limit counting — see finding #1
```

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
