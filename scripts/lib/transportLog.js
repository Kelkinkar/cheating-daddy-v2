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
