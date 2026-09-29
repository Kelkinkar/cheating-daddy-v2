// A thread is one on-screen answer card plus any follow-ups appended below it. Interviewers pause
// mid-question ("What is Kubernetes ... and how do you handle failing pods"), and the second half
// used to arrive as a new question whose answer replaced the first on screen. Measured pauses in
// real sessions were 1.6-2.9s, longer than any settle window worth waiting, so they are threaded
// instead of prevented.
const FOLLOW_UP_GRACE_MS = 5000;
const DIVIDER = '\n\n---\n\n';

// Gemini Live transcribes background sound as tags like "<noise>"; answering those wastes a turn.
const NON_SPEECH = /\[(Interviewer|Candidate)\]:|<[a-z_]+>|\s/gi;

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

function isNonSpeech(transcription) {
    return transcription.replace(NON_SPEECH, '') === '';
}

module.exports = { FOLLOW_UP_GRACE_MS, createAnswerThread, isFollowUp, buildContinuationMessage, composeThreadText, isNonSpeech };
