const test = require('node:test');
const assert = require('node:assert/strict');
const {
    FOLLOW_UP_GRACE_MS,
    createAnswerThread,
    isFollowUp,
    buildContinuationMessage,
    composeThreadText,
    isNonSpeech,
} = require('../src/utils/answerThread');

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

test('isNonSpeech flags transcriptions that are only noise tags', () => {
    assert.equal(isNonSpeech('<noise>'), true);
    assert.equal(isNonSpeech(' <noise> <noise> '), true);
    assert.equal(isNonSpeech('[Interviewer]: <noise>\n'), true);
    assert.equal(isNonSpeech('<noise> What is Redis?'), false);
    assert.equal(isNonSpeech('What is Redis?'), false);
});
