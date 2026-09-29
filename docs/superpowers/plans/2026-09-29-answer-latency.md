# Answer Latency & Follow-up Threading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut time-to-answer from ~5.1s (gpt-6-luna, finished) toward ~4s by firing the answer on Gemini's own end-of-turn signal, and make mid-question pauses produce a follow-up appended *below* the current answer instead of a second answer that takes over the screen.

**Architecture:** Gemini Live already runs voice activity detection: its first `modelTurn` after the interviewer stops arrives 550–1050ms after the last transcript fragment (measured across 5 sessions), earlier than our fixed 1500ms settle timer. We trigger on that signal and keep the timer only as a fallback. Follow-up handling lives in a new pure module (`src/utils/answerThread.js`) so it is unit-testable without Electron; `gemini.js` wires it in. Measurement comes first: a log replay (Task 1) and a scripted live Gemini test (Task 2) pick the timer and VAD values used in Task 3.

**Tech Stack:** Node (built-in `node:test`), Electron main process, `@google/genai` Live API, OpenRouter streaming chat completions, `ffmpeg`, PipeWire (`paplay`).

## Global Constraints

- Answer model: OpenRouter `openai/gpt-6-luna` only. Upstream-host routing work is out of scope.
- Follow-up = speech that arrives while the current answer is streaming **or within 5000ms after it finishes**. Later speech starts a fresh card.
- A follow-up answer is appended **below** the current answer in the same card, separated by a markdown `---` divider. No cancel/merge, no new card.
- A follow-up is sent to the model marked as a continuation, with an instruction to answer only the new part and not repeat.
- New settle timer = the fastest configuration whose split rate is **≤ 10%**, from the Task 1 replay and Task 2 live test.
- No new runtime dependencies. Measurement scripts live in `scripts/` and are not bundled into the app.
- Tests: `npm test` (`node --test`) must stay green; currently 26 passing.

## Findings this plan is built on (from logs, 2026-09-29)

| Signal | Timing after last input fragment |
|---|---|
| Our settle timer fires | 1500ms (fixed) |
| Gemini first `modelTurn` (its VAD end-of-turn) | 550–1050ms, one outlier at 1750ms |
| Gemini `generationComplete` | 5–9s (end of Gemini's own spoken reply, useless as a trigger) |
| Gemini `turnComplete` | 20–30s |
| `interrupted` | interviewer spoke while Gemini was replying: this is the split-question case |

- `groqRequestStartedForTurn` stays `true` until `turnComplete` (20–30s later). Any speech that arrives in the same Gemini turn *after* we sent is collected and then silently dropped.
- Session `1790637706195` (before the flush fix) dropped two real questions around t=230s; only the leftover fragment "Assuming it's an AC2 instance." was sent.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/lib/transportLog.js` (create) | Tolerant parser for transport logs, plus extraction of the input/model-start timeline. Pure. |
| `scripts/replay-turns.js` (create) | CLI: replay logs against trigger policies and print split rate and latency. Pure `simulate`/`summarize` exported. |
| `scripts/measure-live-turns.js` (create) | CLI: synthesize interviewer audio with controlled pauses and stream it to Gemini Live; report when Gemini detects end of turn. |
| `src/utils/answerThread.js` (create) | Pure follow-up logic: `isFollowUp`, `buildContinuationMessage`, `composeThreadText`, `FOLLOW_UP_GRACE_MS`. |
| `src/utils/gemini.js` (modify) | Trigger on Gemini end-of-turn; stop dropping same-turn speech; VAD config; follow-up threading; connection warm-up. |
| `src/storage.js` (modify) | New config default `geminiSilenceDurationMs` (only if Task 2 shows a non-default value wins). |
| `test/transportLog.test.js`, `test/replayTurns.test.js`, `test/answerThread.test.js` (create) | Unit tests. |

---

### Task 1: Log replay: measure split rate and latency per trigger policy

**Files:**
- Create: `scripts/lib/transportLog.js`, `scripts/replay-turns.js`
- Test: `test/transportLog.test.js`, `test/replayTurns.test.js`

**Interfaces:**
- Produces: `parseTransportLog(text) -> Event[]`, `extractTimeline(events) -> { inputs: number[], modelStarts: number[] }`, `simulate(timeline, { settleMs, useGeminiEndOfTurn }) -> Fire[]` where `Fire = { lastInputAt, firedAt, nextInputAt|undefined }`, `summarize(fires, splitWindowMs=5000) -> { questions, splits, splitRate, medianLatencyMs, p90LatencyMs }`.

Why this replay is valid: the interviewer's speech and Gemini's VAD in a recorded log don't depend on when *we* sent to OpenRouter, so any trigger policy can be re-run against them. A "split" is a fire followed by more interviewer speech within 5s. A real new question within 5s of an answer starting is rare, so this slightly overcounts splits.

- [ ] **Step 1: Write failing tests**

`test/transportLog.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTransportLog, extractTimeline } = require('../scripts/lib/transportLog');

const line = (timestamp, type, data) => JSON.stringify({ timestamp, type, data });

test('parseTransportLog reads a closed log', () => {
    const text = `[\n${line(1, 'a', {})},\n${line(2, 'b', {})}\n]\n`;
    assert.deepEqual(parseTransportLog(text).map(e => e.timestamp), [1, 2]);
});

test('parseTransportLog skips a truncated last line of an unclosed log', () => {
    const text = `[\n${line(1, 'a', {})},\n{"timestamp":2,"ty`;
    assert.deepEqual(parseTransportLog(text).map(e => e.timestamp), [1]);
});

test('extractTimeline keeps only the first model output after each input run', () => {
    const msg = serverContent => ({ serverContent });
    const events = [
        { timestamp: 100, type: 'gemini.live.message', data: msg({ inputTranscription: { text: ' What' } }) },
        { timestamp: 220, type: 'gemini.live.message', data: msg({ inputTranscription: { text: ' is' } }) },
        { timestamp: 800, type: 'gemini.live.message', data: msg({ modelTurn: { parts: [] } }) },
        { timestamp: 900, type: 'gemini.live.message', data: msg({ modelTurn: { parts: [] } }) },
        { timestamp: 950, type: 'gemini.live.message', data: msg({ outputTranscription: { text: 'x' } }) },
        { timestamp: 2000, type: 'gemini.live.message', data: msg({ inputTranscription: { text: ' and' } }) },
        { timestamp: 2600, type: 'gemini.live.message', data: msg({ outputTranscription: { text: 'y' } }) },
    ];
    assert.deepEqual(extractTimeline(events), { inputs: [100, 220, 2000], modelStarts: [800, 2600] });
});
```

`test/replayTurns.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { simulate, summarize } = require('../scripts/replay-turns');

test('timer policy fires settleMs after the last fragment of a burst', () => {
    const fires = simulate({ inputs: [0, 120, 240], modelStarts: [] }, { settleMs: 1500, useGeminiEndOfTurn: false });
    assert.deepEqual(fires, [{ lastInputAt: 240, firedAt: 1740, nextInputAt: undefined }]);
});

test('a pause longer than settleMs splits the question', () => {
    const fires = simulate({ inputs: [0, 2000], modelStarts: [] }, { settleMs: 1500, useGeminiEndOfTurn: false });
    assert.equal(fires.length, 2);
    assert.deepEqual(summarize(fires).splits, 1);
});

test('gemini end-of-turn fires before the timer when it comes first', () => {
    const fires = simulate({ inputs: [0, 100], modelStarts: [700] }, { settleMs: 1500, useGeminiEndOfTurn: true });
    assert.deepEqual(fires, [{ lastInputAt: 100, firedAt: 700, nextInputAt: undefined }]);
});

test('a model start that precedes the last fragment is ignored', () => {
    const fires = simulate({ inputs: [0, 900], modelStarts: [500, 1600] }, { settleMs: 1500, useGeminiEndOfTurn: true });
    // 500 is before input 900, so the burst continues; 1600 is the first start after it.
    assert.equal(fires[fires.length - 1].firedAt, 1600);
});

test('summarize reports latency percentiles and split rate', () => {
    const s = summarize([
        { lastInputAt: 0, firedAt: 600, nextInputAt: undefined },
        { lastInputAt: 10000, firedAt: 10800, nextInputAt: 12000 },
    ]);
    assert.equal(s.questions, 2);
    assert.equal(s.splits, 1);
    assert.equal(s.splitRate, 0.5);
    assert.equal(s.medianLatencyMs, 600);
});
```

- [ ] **Step 2: Run tests, expect FAIL** (`Cannot find module`)

Run: `npm test`

- [ ] **Step 3: Implement `scripts/lib/transportLog.js`**

```js
// Reads transport logs written by src/utils/transportLogger.js: one JSON event per line inside a
// JSON array. A session killed mid-write leaves the array unclosed and the last line truncated, so
// parse line by line and skip what does not parse instead of JSON.parse-ing the whole file.
function parseTransportLog(text) {
    const events = [];
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim().replace(/,$/, '');
        if (line === '' || line === '[' || line === ']') continue;
        try {
            events.push(JSON.parse(line));
        } catch {
            // truncated trailing line
        }
    }
    return events;
}

// inputs: timestamps of interviewer transcription fragments.
// modelStarts: the first Gemini output after each run of input, i.e. when Gemini's own voice
// activity detection decided the speaker had finished.
function extractTimeline(events) {
    const inputs = [];
    const modelStarts = [];
    let awaitingModelStart = false;

    for (const event of events) {
        if (event.type !== 'gemini.live.message') continue;
        const content = event.data?.serverContent;
        if (!content) continue;

        if (content.inputTranscription) {
            inputs.push(event.timestamp);
            awaitingModelStart = true;
        } else if ((content.modelTurn || content.outputTranscription) && awaitingModelStart) {
            modelStarts.push(event.timestamp);
            awaitingModelStart = false;
        }
    }
    return { inputs, modelStarts };
}

module.exports = { parseTransportLog, extractTimeline };
```

- [ ] **Step 4: Implement `scripts/replay-turns.js`**

```js
#!/usr/bin/env node
// Replays recorded Gemini Live sessions against answer-trigger policies. Usage:
//   node scripts/replay-turns.js [logFile ...]   (defaults to the 6 newest logs)
const fs = require('fs');
const path = require('path');
const { getConfigDir } = require('../src/storage');
const { parseTransportLog, extractTimeline } = require('./lib/transportLog');

const SPLIT_WINDOW_MS = 5000;

function simulate({ inputs, modelStarts }, { settleMs, useGeminiEndOfTurn }) {
    const fires = [];
    let i = 0;
    while (i < inputs.length) {
        let last = inputs[i];
        for (;;) {
            let firedAt = last + settleMs;
            if (useGeminiEndOfTurn) {
                const start = modelStarts.find(t => t > last);
                if (start !== undefined && start < firedAt) firedAt = start;
            }
            const next = inputs[i + 1];
            if (next !== undefined && next < firedAt) {
                i++;
                last = next;
                continue;
            }
            fires.push({ lastInputAt: last, firedAt, nextInputAt: next });
            i++;
            break;
        }
    }
    return fires;
}

function percentile(sorted, p) {
    if (sorted.length === 0) return null;
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function summarize(fires, splitWindowMs = SPLIT_WINDOW_MS) {
    const splits = fires.filter(f => f.nextInputAt !== undefined && f.nextInputAt - f.firedAt <= splitWindowMs).length;
    const latencies = fires.map(f => f.firedAt - f.lastInputAt).sort((a, b) => a - b);
    return {
        questions: fires.length,
        splits,
        splitRate: fires.length ? splits / fires.length : 0,
        medianLatencyMs: percentile(latencies, 0.5),
        p90LatencyMs: percentile(latencies, 0.9),
    };
}

const POLICIES = [
    { name: 'timer 1500 (today)', settleMs: 1500, useGeminiEndOfTurn: false },
    { name: 'timer 1200', settleMs: 1200, useGeminiEndOfTurn: false },
    { name: 'timer 900', settleMs: 900, useGeminiEndOfTurn: false },
    { name: 'timer 600', settleMs: 600, useGeminiEndOfTurn: false },
    { name: 'gemini EOT + 1500 fallback', settleMs: 1500, useGeminiEndOfTurn: true },
    { name: 'gemini EOT + 900 fallback', settleMs: 900, useGeminiEndOfTurn: true },
];

function main(files) {
    const logsDir = path.join(getConfigDir(), 'logs');
    if (files.length === 0) {
        files = fs
            .readdirSync(logsDir)
            .filter(f => f.endsWith('.json'))
            .map(f => path.join(logsDir, f))
            .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
            .slice(-6);
    }
    const timelines = files.map(f => extractTimeline(parseTransportLog(fs.readFileSync(f, 'utf8'))));

    console.log(`Replaying ${files.length} sessions\n`);
    console.log('policy'.padEnd(30), 'questions', 'splits', 'split%', 'median', 'p90');
    for (const policy of POLICIES) {
        const fires = timelines.flatMap(t => simulate(t, policy));
        const s = summarize(fires);
        console.log(
            policy.name.padEnd(30),
            String(s.questions).padStart(9),
            String(s.splits).padStart(6),
            (s.splitRate * 100).toFixed(0).padStart(5) + '%',
            String(s.medianLatencyMs).padStart(6),
            String(s.p90LatencyMs).padStart(5)
        );
    }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { simulate, summarize };
```

- [ ] **Step 5: Run tests, expect PASS.** Run: `npm test`
- [ ] **Step 6: Run the replay and record the table** in the "Results" section at the bottom of this plan. Run: `node scripts/replay-turns.js`
- [ ] **Step 7: Commit** `git add scripts test docs/superpowers/plans && git commit -m "test(latency): replay transport logs against answer-trigger policies"`

---

### Task 2: Scripted live test against real Gemini Live

**Files:**
- Create: `scripts/measure-live-turns.js`

**Interfaces:**
- Consumes: `getCredentials()`, `getConfig()` from `src/storage.js`; `getSystemPrompt` from `src/utils/prompts.js`.
- Produces: a printed table of pause (ms) × `silenceDurationMs` → split (Gemini started output during the pause?) and end-of-turn latency after real speech end.

This measures what the replay can't: **exact** speech-end time, because we generate the audio ourselves. It tests pauses the logs never contained, and it tests Gemini's `silenceDurationMs` setting.

- [ ] **Step 1: Find a TTS-capable Gemini model.** Run:
  `node -e "const {getCredentials}=require('./src/storage');fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key='+getCredentials().apiKey).then(r=>r.json()).then(j=>console.log(j.models.filter(m=>/tts/i.test(m.name)).map(m=>m.name)))"`
  Use the newest name in the output as `TTS_MODEL`.

- [ ] **Step 2: Write `scripts/measure-live-turns.js`**

```js
#!/usr/bin/env node
// Streams synthesized interviewer speech with controlled mid-question pauses into Gemini Live,
// configured like the app, and reports when Gemini's VAD decides the turn ended. Usage:
//   node scripts/measure-live-turns.js [--tts-model NAME] [--pauses 500,1000,1500,2000] [--silence default,300,800] [--reps 3]
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { GoogleGenAI, Modality } = require('@google/genai');
const { getCredentials, getConfig } = require('../src/storage');
const { getSystemPrompt } = require('../src/utils/prompts');

const SAMPLE_RATE = 24000; // matches src/utils/renderer.js
const CHUNK_MS = 100; // renderer sends ~100ms chunks
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
const PART_A = 'What is Kubernetes';
const PART_B = 'and how do you handle pods that keep failing even after restarting?';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-turn-'));

async function synthesize(ai, model, text) {
    const response = await ai.models.generateContent({
        model,
        contents: [{ parts: [{ text: `Say in a neutral interviewer voice: ${text}` }] }],
        config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } } },
    });
    const part = response.candidates[0].content.parts.find(p => p.inlineData);
    const raw = Buffer.from(part.inlineData.data, 'base64');
    const rate = Number((part.inlineData.mimeType.match(/rate=(\d+)/) || [])[1] || 24000);
    // Resample to the app's input format and trim TTS leading/trailing silence so the pause we
    // insert is the only pause.
    const inFile = path.join(workDir, `in-${Date.now()}.raw`);
    const outFile = inFile.replace('in-', 'out-');
    fs.writeFileSync(inFile, raw);
    execFileSync('ffmpeg', [
        '-loglevel', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', inFile,
        '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse',
        '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', outFile,
    ]);
    return fs.readFileSync(outFile);
}

const silence = ms => Buffer.alloc(Math.round(ms * BYTES_PER_MS));

async function runTrial(ai, audioA, audioB, pauseMs, silenceDurationMs) {
    const events = [];
    const config = {
        responseModalities: [Modality.AUDIO],
        proactivity: { proactiveAudio: true },
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        systemInstruction: { parts: [{ text: getSystemPrompt('interview', '', false) }] },
    };
    if (silenceDurationMs !== 'default') {
        config.realtimeInputConfig = { automaticActivityDetection: { silenceDurationMs: Number(silenceDurationMs) } };
    }

    let ready;
    const setup = new Promise(r => (ready = r));
    const session = await ai.live.connect({
        model: getConfig().geminiLiveModel,
        config,
        callbacks: {
            onmessage: m => {
                const now = Date.now();
                if (m.setupComplete) ready();
                const c = m.serverContent;
                if (!c) return;
                if (c.inputTranscription) events.push({ t: now, kind: 'input', text: c.inputTranscription.text });
                if (c.modelTurn || c.outputTranscription) events.push({ t: now, kind: 'model' });
                if (c.interrupted) events.push({ t: now, kind: 'interrupted' });
            },
            onerror: e => console.error('live error', e.message),
            onclose: () => {},
        },
    });
    await setup;

    // Real-time pacing: one 100ms chunk every 100ms, like the renderer.
    const stream = Buffer.concat([audioA, silence(pauseMs), audioB, silence(4000)]);
    const aEndAt = { t: 0 };
    const bEndAt = { t: 0 };
    const chunkBytes = CHUNK_MS * BYTES_PER_MS;
    const start = Date.now();
    for (let off = 0; off < stream.length; off += chunkBytes) {
        const due = start + (off / BYTES_PER_MS);
        const wait = due - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        if (!aEndAt.t && off >= audioA.length) aEndAt.t = Date.now();
        if (!bEndAt.t && off >= audioA.length + silence(pauseMs).length + audioB.length) bEndAt.t = Date.now();
        session.sendRealtimeInput({ audio: { data: stream.subarray(off, off + chunkBytes).toString('base64'), mimeType: `audio/pcm;rate=${SAMPLE_RATE}` } });
    }
    await new Promise(r => setTimeout(r, 1500));
    session.close();

    const firstModel = events.find(e => e.kind === 'model');
    const bStart = aEndAt.t + pauseMs;
    return {
        pauseMs,
        silenceDurationMs,
        split: Boolean(firstModel && firstModel.t < bStart),
        eotAfterSpeechEndMs: (() => {
            const afterB = events.find(e => e.kind === 'model' && e.t > bEndAt.t);
            return afterB ? afterB.t - bEndAt.t : null;
        })(),
        lastInputAfterSpeechEndMs: (() => {
            const inputs = events.filter(e => e.kind === 'input');
            return inputs.length ? inputs[inputs.length - 1].t - bEndAt.t : null;
        })(),
        transcript: events.filter(e => e.kind === 'input').map(e => e.text).join(''),
    };
}

async function main() {
    const ai = new GoogleGenAI({ apiKey: getCredentials().apiKey, httpOptions: { apiVersion: 'v1alpha' } });
    const ttsModel = arg('tts-model', 'gemini-2.5-flash-preview-tts');
    const pauses = arg('pauses', '500,1000,1500,2000').split(',').map(Number);
    const silences = arg('silence', 'default,300,800,1200').split(',');
    const reps = Number(arg('reps', '3'));

    const audioA = await synthesize(ai, ttsModel, PART_A);
    const audioB = await synthesize(ai, ttsModel, PART_B);

    const results = [];
    for (const s of silences) {
        for (const p of pauses) {
            for (let r = 0; r < reps; r++) {
                const res = await runTrial(ai, audioA, audioB, p, s);
                results.push(res);
                console.log(JSON.stringify(res));
            }
        }
    }

    console.log('\nsilenceMs pauseMs splits  medianEOTms  medianTranscriptLagMs');
    const median = xs => { const v = xs.filter(x => x !== null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
    for (const s of silences) for (const p of pauses) {
        const rows = results.filter(r => r.silenceDurationMs === s && r.pauseMs === p);
        console.log(String(s).padEnd(9), String(p).padStart(7), `${rows.filter(r => r.split).length}/${rows.length}`.padStart(6),
            String(median(rows.map(r => r.eotAfterSpeechEndMs))).padStart(12), String(median(rows.map(r => r.lastInputAfterSpeechEndMs))).padStart(22));
    }
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Smoke-run one trial.** Run: `node scripts/measure-live-turns.js --tts-model <TTS_MODEL> --pauses 1000 --silence default --reps 1`. Expected: one JSON line with a non-empty `transcript` containing "Kubernetes". If the transcript is empty, check the audio format (`ffplay -f s16le -ar 24000 -ac 1 <outFile>`) before going on.
- [ ] **Step 4: Full run.** Run: `node scripts/measure-live-turns.js --tts-model <TTS_MODEL> --reps 3` and paste the summary table into "Results".
- [ ] **Step 5: Decide the values** using this rule, and record the decision in "Results":
  - `silenceDurationMs` = the setting with the lowest median end-of-turn delay whose split count at pause 1000ms is ≤ 1/3 **and** whose split rate across all pauses is no worse than `default`. Keep `default` (no `realtimeInputConfig`) if nothing beats it.
  - Fallback `TRANSCRIPTION_SETTLE_MS` = the smallest value in {600, 900, 1200, 1500} whose Task 1 policy "gemini EOT + N fallback" has split rate ≤ 10%. If none, keep 1500.
- [ ] **Step 6: Commit** `git add scripts/measure-live-turns.js docs/superpowers/plans && git commit -m "test(latency): scripted Gemini Live end-of-turn test"`

---

### Task 3: Fire on Gemini end-of-turn, stop dropping same-turn speech

**Files:**
- Modify: `src/utils/gemini.js` (the settle-timer block at lines 61–69; `sendFinalTranscriptionToAnswerProvider` at ~271; the `onmessage` handler at ~676–716; `initializeNewSession` at ~112; the Live `config` at ~754)
- Modify: `src/storage.js` `DEFAULT_CONFIG` (only if Task 2 chose a non-default silence)

**Interfaces:**
- Produces: `sendFinalTranscriptionToAnswerProvider()` now consumes `currentTranscription` (clears it when sending) instead of latching `groqRequestStartedForTurn`. Task 4 relies on each send being one settled chunk of speech.

Behavior change:
1. Keep an `awaitingEndOfTurn` flag. It is set when an input fragment arrives. On the first `modelTurn` or `outputTranscription` after that, call `flushPendingTranscription()` and clear the flag. That is Gemini saying the speaker finished.
2. The timer stays as a fallback. `proactiveAudio` means Gemini sometimes decides not to reply at all, and then no `modelTurn` arrives.
3. Sending takes the text and clears `currentTranscription`. `groqRequestStartedForTurn` is deleted. The empty-text guard already makes a flush followed by a timer a no-op, and speech that arrives after a send in the same Gemini turn becomes its own send instead of being dropped.

- [ ] **Step 1: Replace the settle constants block** (currently lines 61–69):

```js
let messageBuffer = '';

// Gemini Live streams input transcription in fragments ~120ms apart, so answering on the first
// fragment sends a 2-4 character question ("What"). The primary trigger is Gemini's own voice
// activity detection: its first model output after the interviewer stops arrives 550-1050ms after
// the last fragment (measured across 5 sessions). The timer is the fallback for turns Gemini
// chooses not to answer (proactiveAudio). Value picked by scripts/replay-turns.js and
// scripts/measure-live-turns.js; see docs/superpowers/plans/2026-09-29-answer-latency.md.
const TRANSCRIPTION_SETTLE_MS = /* value from Task 2 Step 5 */ 1500;
let transcriptionSettleTimer = null;
let awaitingEndOfTurn = false;
```

(Write the chosen number in place of `1500` and delete the inline comment marker.)

- [ ] **Step 2: Make the send consume the transcription.** Replace `sendFinalTranscriptionToAnswerProvider`:

```js
// Takes the settled speech and clears it, so each send is one chunk of speech. Speech that arrives
// after a send, even inside the same Gemini turn, becomes its own send rather than being dropped
// (the old per-turn latch held until turnComplete, 20-30s later). Calling this twice is safe:
// the second call sees an empty transcription.
function sendFinalTranscriptionToAnswerProvider() {
    const provider = getAnswerProvider();
    if (!provider) {
        return;
    }

    const transcription = currentTranscription.trim();
    if (transcription === '') {
        return;
    }

    currentTranscription = '';
    awaitingEndOfTurn = false;
    sendTextToProvider(provider, transcription);
}
```

Update the comment on `flushPendingTranscription` to say "the second call sees an empty transcription" instead of mentioning `groqRequestStartedForTurn`.

- [ ] **Step 3: Wire the trigger in `onmessage`.** After the `inputTranscription` block, add `awaitingEndOfTurn = true;` next to `scheduleAnswerForSettledTranscription();`. Then add this before the `outputTranscription` block:

```js
                    // Gemini's first output after the interviewer stops is its end-of-turn decision.
                    if ((message.serverContent?.modelTurn || message.serverContent?.outputTranscription) && awaitingEndOfTurn) {
                        awaitingEndOfTurn = false;
                        flushPendingTranscription();
                    }
```

- [ ] **Step 4: Remove `groqRequestStartedForTurn`.** Delete its declaration, the reset in `initializeNewSession` (replace it with `awaitingEndOfTurn = false;`), and the reset in the `turnComplete` branch. Check nothing is left: `grep -n groqRequestStartedForTurn src` should print nothing.

In the provider path the `generationComplete` branch clears `currentTranscription` after flushing. Keep that; it only matters for the Gemini-direct path.

- [ ] **Step 5 (only if Task 2 chose a non-default silence): VAD config.** Add `geminiSilenceDurationMs: <value>` to `DEFAULT_CONFIG` in `src/storage.js`, and to the Live `config` in `initializeGeminiSession`:

```js
                realtimeInputConfig: {
                    automaticActivityDetection: { silenceDurationMs: getConfig().geminiSilenceDurationMs },
                },
```

- [ ] **Step 6: Verify.** `npm test` passes, then re-run `node scripts/replay-turns.js` and confirm the row for the chosen policy matches Task 1.
- [ ] **Step 7: Commit** `git commit -am "feat(gemini): answer on Gemini end-of-turn, keep same-turn follow-ups"`

---

### Task 4: Follow-up threading: append below the current answer

**Files:**
- Create: `src/utils/answerThread.js`
- Modify: `src/utils/gemini.js` (`sendTextToProvider`, `initializeNewSession`)
- Test: `test/answerThread.test.js`

**Interfaces:**
- Produces:
  - `FOLLOW_UP_GRACE_MS = 5000`
  - `createAnswerThread() -> { questions: string[], segments: string[], streaming: number, finishedAt: number }`. `streaming` counts answers still streaming in this thread.
  - `isFollowUp(thread, now) -> boolean`
  - `buildContinuationMessage(previousQuestions: string[], text: string) -> string`
  - `composeThreadText(segments: string[]) -> string`

- [ ] **Step 1: Write failing tests** in `test/answerThread.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { FOLLOW_UP_GRACE_MS, createAnswerThread, isFollowUp, buildContinuationMessage, composeThreadText } = require('../src/utils/answerThread');

test('an empty thread never takes follow-ups', () => {
    assert.equal(isFollowUp(createAnswerThread(), 1000), false);
});

test('speech while an answer is streaming is a follow-up', () => {
    const thread = { ...createAnswerThread(), questions: ['What is Kubernetes'], streaming: 1 };
    assert.equal(isFollowUp(thread, 999999), true);
});

test('speech within the grace window after the answer finished is a follow-up', () => {
    const thread = { ...createAnswerThread(), questions: ['q'], finishedAt: 10000 };
    assert.equal(isFollowUp(thread, 10000 + FOLLOW_UP_GRACE_MS), true);
    assert.equal(isFollowUp(thread, 10000 + FOLLOW_UP_GRACE_MS + 1), false);
});

test('continuation message quotes the earlier question and the new part', () => {
    const msg = buildContinuationMessage(['What is Kubernetes'], 'and how do you handle pods that keep failing');
    assert.match(msg, /What is Kubernetes/);
    assert.match(msg, /and how do you handle pods that keep failing/);
    assert.match(msg, /only the new part/i);
});

test('composeThreadText joins answers with a markdown divider and skips empty segments', () => {
    assert.equal(composeThreadText(['A']), 'A');
    assert.equal(composeThreadText(['A', 'B']), 'A\n\n---\n\nB');
    assert.equal(composeThreadText(['A', '']), 'A');
});
```

- [ ] **Step 2: Run, expect FAIL.** `npm test`

- [ ] **Step 3: Implement `src/utils/answerThread.js`**

```js
// A thread is one on-screen answer card plus any follow-ups appended below it. Interviewers
// pause mid-question ("What is Kubernetes ... and how do you handle failing pods"), and the
// second half used to arrive as a new question whose answer replaced the first on screen.
const FOLLOW_UP_GRACE_MS = 5000;
const DIVIDER = '\n\n---\n\n';

function createAnswerThread() {
    return { questions: [], segments: [], streaming: 0, finishedAt: 0 };
}

function isFollowUp(thread, now) {
    if (thread.questions.length === 0) return false;
    return thread.streaming > 0 || now - thread.finishedAt <= FOLLOW_UP_GRACE_MS;
}

function buildContinuationMessage(previousQuestions, text) {
    return `The interviewer continued their previous question ("${previousQuestions.join(' ')}") with: "${text}". Answer only the new part. Don't repeat what you already said.`;
}

function composeThreadText(segments) {
    return segments.filter(segment => segment && segment.trim() !== '').join(DIVIDER);
}

module.exports = { FOLLOW_UP_GRACE_MS, createAnswerThread, isFollowUp, buildContinuationMessage, composeThreadText };
```

- [ ] **Step 4: Run, expect PASS.** `npm test`

- [ ] **Step 5: Wire into `gemini.js`.**

Add `const { createAnswerThread, isFollowUp, buildContinuationMessage, composeThreadText } = require('./answerThread');` next to the other requires. Add `let answerThread = createAnswerThread();` near `groqConversationHistory`, and reset it in `initializeNewSession`: `answerThread = createAnswerThread();`.

In `sendTextToProvider`, after the empty-transcription guard:

```js
    const followUp = isFollowUp(answerThread, Date.now());
    if (!followUp) {
        answerThread = createAnswerThread();
    }
    const thread = answerThread;
    const segmentIndex = thread.segments.length;
    const modelInput = followUp ? buildContinuationMessage(thread.questions, transcription.trim()) : transcription.trim();
    thread.questions.push(transcription.trim());
    thread.segments.push('');
    thread.streaming++;

    // The first answer opens a card; follow-ups rewrite that card with every segment so far.
    const showSegment = (text, isFirst) => {
        thread.segments[segmentIndex] = text;
        if (thread !== answerThread) return; // a newer thread owns the screen
        const newCard = segmentIndex === 0 && isFirst;
        sendToRenderer(newCard ? 'new-response' : 'update-response', composeThreadText(thread.segments));
    };
```

Then:
- push `modelInput` (not `transcription`) into `groqConversationHistory`;
- replace `onDisplayText` in `attemptOptions` with `onDisplayText: showSegment`;
- in the empty-response branch, replace `sendToRenderer('new-response', emptyResponseMessage(...))` with `showSegment(emptyResponseMessage(provider, finishReason), true)`;
- wrap the body after `thread.streaming++` so every exit runs `finally { thread.streaming--; thread.finishedAt = Date.now(); }`. The existing `try { … } catch` becomes `try { … } catch { … } finally { … }`. The early `return`s after an HTTP error are inside the `try`, so they run the `finally` too.

- [ ] **Step 6: Unit-test the wiring with the transport log.** Manual: run the app, ask a two-part question with a ~2s pause, then open the newest log in `~/.config/cheating-daddy-config/logs/`. Expect two `openrouter.text.request` events, the second with `transcription` equal to the raw second part, and the card showing both answers separated by a rule. (Task 6 automates this check.)
- [ ] **Step 7: Commit** `git add src/utils/answerThread.js test/answerThread.test.js src/utils/gemini.js && git commit -m "feat(assistant): append mid-question follow-ups below the current answer"`

---

### Task 5: Keep the OpenRouter connection warm

**Files:**
- Modify: `src/utils/gemini.js` (the `inputTranscription` branch of `onmessage`)

- [ ] **Step 1: Measure first.** Run this twice, 10s apart, then twice 1s apart:
  `node -e "const {getCredentials}=require('./src/storage');(async()=>{for(const gap of [0,1000]){await new Promise(r=>setTimeout(r,gap));const t=Date.now();await fetch('https://openrouter.ai/api/v1/key',{headers:{Authorization:'Bearer '+getCredentials().openrouterApiKey}});console.log(gap?'warm':'cold',Date.now()-t,'ms')}})()"`
  If cold minus warm is **< 150ms**, record that in Results, skip this task, and go to Task 6.
- [ ] **Step 2: Implement the warm-up.** On the first fragment of a new utterance (when `currentTranscription` was empty before appending) and the answer provider is OpenRouter, fire the same request without awaiting it, at most once every 3s:

```js
let lastWarmupAt = 0;
// Node's fetch drops idle keep-alive sockets after ~4s and interview questions are further apart
// than that, so every answer paid a fresh TLS handshake. Opening the socket while the interviewer
// is still talking moves that cost off the critical path.
function warmAnswerProviderConnection() {
    const provider = getAnswerProvider();
    if (!provider || Date.now() - lastWarmupAt < 3000) return;
    lastWarmupAt = Date.now();
    const apiKey = PROVIDER_KEY_GETTERS[provider.id]();
    fetch(`${provider.baseUrl}/models?limit=1`, { headers: { Authorization: `Bearer ${apiKey}` } })
        .then(r => r.arrayBuffer())
        .catch(() => {});
}
```

Call `warmAnswerProviderConnection()` in the `inputTranscription` branch before the text is appended, when `currentTranscription === ''`.
- [ ] **Step 3: Verify** `npm test`, then run Task 6 and compare `hdr` (request to HTTP response) against the pre-change 1.0–2.0s.
- [ ] **Step 4: Commit** `git commit -am "perf(gemini): pre-open the answer provider connection while the interviewer speaks"`

---

### Task 6: End-to-end check in the real app

**Files:** none (verification only)

- [ ] **Step 1: Build the test audio.** Reuse Task 2's `synthesize`, or add a `--write-wav` flag. Write `$SCRATCH/kube-1500.wav` (part A + 1500ms + part B), `$SCRATCH/kube-600.wav`, and `$SCRATCH/single.wav` ("Tell me about a time you handled a production outage").
- [ ] **Step 2: Start the app.** `npm start`. **The user clicks Start and approves the screen-share/audio prompt once.**
- [ ] **Step 3: Play each file through the system output,** with 20s between them: `paplay $SCRATCH/single.wav; sleep 20; paplay $SCRATCH/kube-600.wav; sleep 20; paplay $SCRATCH/kube-1500.wav`
- [ ] **Step 4: Measure.** Run `node scripts/replay-turns.js <newest log>` and extend the timing script from the latency analysis (settle / hdr / ttft / stream per request). Pass criteria:
  - `single`: one request; first text ≤ 2.6s and finished ≤ 4.5s after the last input fragment.
  - `kube-600`: one request containing both parts (merged by the settle logic), **or** two requests where the second is a continuation shown under the first on one card.
  - `kube-1500`: two requests; one card with a `---` divider; the second answer doesn't re-explain Kubernetes.
  - No speech that is transcribed but never sent. Check that every input run is followed by an `openrouter.text.request`.
- [ ] **Step 5: Update docs.** Add a 2026-09-29 latency section to `repo/PROJECT_REVIEW.md` and the tuning notes in `README.md` with the Results tables. Commit: `git commit -am "docs: record end-of-turn trigger, follow-up threading and latency results"`

---

## Results

### Task 1: log replay (6 sessions, 54 questions)

| Policy | Splits | Median wait | p90 |
|---|---|---|---|
| timer 1500 (today) | 10 (19%) | 1500ms | 1500 |
| timer 1200 | 10 (19%) | 1200 | 1200 |
| timer 900 | 10 (19%) | 900 | 900 |
| timer 600 | 17 (28%) | 600 | 600 |
| gemini EOT + 1500 fallback | 10 (19%) | 735 | 1500 |
| gemini EOT + 900 fallback | 10 (19%) | 735 | 900 |

Hand-labelled, the 10 splits are: about 5 real continuations (gaps 1.6-2.9s, e.g. "give me an example how you
would set up" -> "Assuming it's an AC2 instance"), 3 new questions, and 2 `<noise>` transcriptions. So the real
split rate is about 9% under every policy. No timer <= 1500ms bridges these pauses, which makes follow-up
threading (Task 4) the fix, and the end-of-turn trigger is free latency.

Added to Task 3: don't send a transcription that is only `<noise>` or similar non-speech tags.
