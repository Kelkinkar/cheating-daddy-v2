const { Modality } = require('@google/genai');

// Transcription-only Live models (e.g. gemini-3.5-transcribe-live) reject an AUDIO response and
// never reply, so they only make sense when an answer provider (OpenRouter/Groq) does the
// answering. Measured against native-audio: they catch every mid-question continuation, where a
// native-audio model busy with its own discarded reply transcribed the continuation 2-4s late or
// dropped it. Each utterance arrives whole with an immediate generationComplete, which the
// existing flush treats as end of turn.
function isTranscriptionModel(model) {
    return /transcribe/i.test(model || '');
}

function buildLiveConfig({ model, tools, systemPrompt, language }) {
    const base = {
        inputAudioTranscription: {
            enableSpeakerDiarization: true,
            minSpeakerCount: 2,
            maxSpeakerCount: 2,
        },
        contextWindowCompression: { slidingWindow: {} },
        systemInstruction: { parts: [{ text: systemPrompt }] },
    };

    if (isTranscriptionModel(model)) {
        return { ...base, responseModalities: [Modality.TEXT] };
    }

    return {
        ...base,
        responseModalities: [Modality.AUDIO],
        proactivity: { proactiveAudio: true },
        outputAudioTranscription: {},
        tools,
        speechConfig: { languageCode: language },
    };
}

module.exports = { isTranscriptionModel, buildLiveConfig };
