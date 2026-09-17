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
