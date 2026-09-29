#!/usr/bin/env node
// Streams synthesized interviewer speech with controlled mid-question pauses into Gemini Live,
// configured like the app, and reports when Gemini's VAD decides the turn ended. Unlike the log
// replay this knows the exact moment speech ended, because we generate the audio. Usage:
//   node scripts/measure-live-turns.js [--tts-model NAME] [--pauses 500,1000,1500,2000]
//       [--silence default,300,800,1200] [--reps 3] [--write-wav DIR]
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { GoogleGenAI } = require('@google/genai');
const { getCredentials, getConfig } = require('../src/storage');
const { getSystemPrompt } = require('../src/utils/prompts');
const { buildLiveConfig } = require('../src/utils/liveConfig');

const SAMPLE_RATE = 24000; // matches src/utils/renderer.js
const CHUNK_MS = 100; // renderer sends ~100ms chunks
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
const PART_A = 'What is Kubernetes';
const PART_B = 'and how do you handle pods that keep failing even after restarting?';
const SINGLE = 'Tell me about a time you handled a production outage.';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-turn-'));
const silence = ms => Buffer.alloc(Math.round(ms * BYTES_PER_MS) & ~1);

// TTS is rate limited (free tier: 10 requests), so keep synthesized clips between runs.
const cacheDir = path.join(os.tmpdir(), 'live-turn-cache');

async function synthesize(ai, model, text) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const cached = path.join(cacheDir, `${model}-${Buffer.from(text).toString('base64url').slice(0, 80)}.raw`);
    if (fs.existsSync(cached)) return fs.readFileSync(cached);
    const response = await ai.models.generateContent({
        model,
        contents: [{ parts: [{ text }] }],
        config: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } },
        },
    });
    const part = response.candidates[0].content.parts.find(p => p.inlineData);
    const rate = Number((part.inlineData.mimeType.match(/rate=(\d+)/) || [])[1] || 24000);
    // Resample to the app's input format and trim the TTS's own leading/trailing silence so the
    // pause we insert is the only pause.
    const inFile = path.join(workDir, `in-${Date.now()}.raw`);
    const outFile = inFile.replace('in-', 'out-');
    fs.writeFileSync(inFile, Buffer.from(part.inlineData.data, 'base64'));
    execFileSync('ffmpeg', [
        '-loglevel', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', inFile,
        '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse',
        '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', outFile,
    ]);
    fs.copyFileSync(outFile, cached);
    return fs.readFileSync(outFile);
}

function writeWav(file, pcm) {
    const raw = path.join(workDir, `wav-${Date.now()}.raw`);
    fs.writeFileSync(raw, pcm);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', raw, file]);
}

function liveConfig(silenceDurationMs) {
    const config = buildLiveConfig({
        model: arg('live-model', getConfig().geminiLiveModel),
        tools: [],
        systemPrompt: getSystemPrompt('interview', '', false),
        language: 'en-US',
    });
    if (silenceDurationMs !== 'default') {
        config.realtimeInputConfig = { automaticActivityDetection: { silenceDurationMs: Number(silenceDurationMs) } };
    }
    return config;
}

async function runTrial(ai, audioA, audioB, pauseMs, silenceDurationMs) {
    const events = [];
    let ready;
    const setup = new Promise(resolve => (ready = resolve));
    const session = await ai.live.connect({
        model: arg('live-model', getConfig().geminiLiveModel),
        config: liveConfig(silenceDurationMs),
        callbacks: {
            onmessage: m => {
                const now = Date.now();
                if (process.env.DEBUG_RAW) console.log('RAW', now, JSON.stringify(m).slice(0, 200));
                if (m.setupComplete) ready();
                const c = m.serverContent;
                if (!c) return;
                if (c.inputTranscription) {
                    const t = c.inputTranscription;
                    events.push({ t: now, kind: 'input', text: t.text || (t.results || []).map(r => r.transcript).join('') });
                }
                if (c.modelTurn || c.outputTranscription) events.push({ t: now, kind: 'model' });
                if (c.interrupted) events.push({ t: now, kind: 'interrupted' });
                if (c.generationComplete) events.push({ t: now, kind: 'generationComplete' });
                if (c.turnComplete) events.push({ t: now, kind: 'turnComplete' });
            },
            onerror: e => console.error('live error', e.message),
            onclose: e => { if (process.env.DEBUG_RAW) console.log('CLOSE', e.code, e.reason); },
        },
    });
    await setup;

    const pause = silence(pauseMs);
    const stream = Buffer.concat([audioA, pause, audioB, silence(5000)]);
    const bStartOffset = audioA.length + pause.length;
    const bEndOffset = bStartOffset + audioB.length;
    const chunkBytes = CHUNK_MS * BYTES_PER_MS;

    // Real-time pacing, one 100ms chunk every 100ms like the renderer. Offsets are converted to
    // wall-clock times at the moment each boundary chunk is sent.
    let aEndAt = 0;
    let bEndAt = 0;
    const start = Date.now();
    for (let off = 0; off < stream.length; off += chunkBytes) {
        const wait = start + off / BYTES_PER_MS - Date.now();
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        if (!aEndAt && off + chunkBytes > audioA.length) aEndAt = start + audioA.length / BYTES_PER_MS;
        if (!bEndAt && off + chunkBytes > bEndOffset) bEndAt = start + bEndOffset / BYTES_PER_MS;
        session.sendRealtimeInput({
            audio: { data: stream.subarray(off, off + chunkBytes).toString('base64'), mimeType: `audio/pcm;rate=${SAMPLE_RATE}` },
        });
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
    session.close();

    const bStartAt = start + bStartOffset / BYTES_PER_MS;
    const firstModel = events.find(e => e.kind === 'model');
    const inputs = events.filter(e => e.kind === 'input');
    // Gemini's end-of-turn for the whole question: its first output after the last transcript
    // fragment. Measured from the real end of speech, so it includes transcription lag.
    const lastInputAt = inputs.length ? inputs[inputs.length - 1].t : bEndAt;
    const modelAfterB = events.find(e => e.kind === 'model' && e.t > Math.max(bEndAt, lastInputAt));
    return {
        pauseMs,
        silenceDurationMs,
        // Gemini decided the turn was over during the pause, i.e. it would have split the question.
        split: Boolean(firstModel && firstModel.t < bStartAt),
        firstModelAfterPartAMs: firstModel ? firstModel.t - aEndAt : null,
        eotAfterSpeechEndMs: modelAfterB ? modelAfterB.t - bEndAt : null,
        lastInputAfterSpeechEndMs: inputs.length ? inputs[inputs.length - 1].t - bEndAt : null,
        transcript: inputs.map(e => e.text).join('').trim(),
        partAEndMs: aEndAt - start,
        partBStartMs: bStartAt - start,
        timeline: process.env.DEBUG_TIMELINE
            ? events.filter((e, i, all) => e.kind !== 'model' || all[i - 1]?.kind !== 'model').map(e => `${e.t - start}:${e.kind}${e.text ? ' ' + e.text : ''}`)
            : undefined,
    };
}

const median = xs => {
    const v = xs.filter(x => x !== null).sort((a, b) => a - b);
    return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};

async function main() {
    const ai = new GoogleGenAI({ apiKey: getCredentials().apiKey, httpOptions: { apiVersion: 'v1alpha' } });
    const ttsModel = arg('tts-model', 'gemini-3.8-flash-lite-tts');
    const pauses = arg('pauses', '500,1000,1500,2000').split(',').map(Number);
    const silences = arg('silence', 'default,300,800,1200').split(',');
    const reps = Number(arg('reps', '3'));

    const audioA = await synthesize(ai, ttsModel, PART_A);
    const audioB = await synthesize(ai, ttsModel, PART_B);

    const wavDir = arg('write-wav', null);
    if (wavDir) {
        fs.mkdirSync(wavDir, { recursive: true });
        const single = await synthesize(ai, ttsModel, SINGLE);
        writeWav(path.join(wavDir, 'single.wav'), single);
        for (const p of pauses) writeWav(path.join(wavDir, `kube-${p}.wav`), Buffer.concat([audioA, silence(p), audioB]));
        console.log(`Wrote WAVs to ${wavDir}`);
        return;
    }

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

    console.log('\nsilenceMs  pauseMs  splits  medianEOTms  medianTranscriptLagMs');
    for (const s of silences) {
        for (const p of pauses) {
            const rows = results.filter(r => r.silenceDurationMs === s && r.pauseMs === p);
            console.log(
                String(s).padEnd(9),
                String(p).padStart(8),
                `${rows.filter(r => r.split).length}/${rows.length}`.padStart(7),
                String(median(rows.map(r => r.eotAfterSpeechEndMs))).padStart(12),
                String(median(rows.map(r => r.lastInputAfterSpeechEndMs))).padStart(22)
            );
        }
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
