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

const { PROVIDERS, buildChatRequest } = require('../src/utils/openaiCompatible');

test('PROVIDERS exposes groq and openrouter descriptors', () => {
    assert.equal(PROVIDERS.groq.id, 'groq');
    assert.equal(PROVIDERS.groq.baseUrl, 'https://api.groq.com/openai/v1');
    assert.equal(PROVIDERS.groq.usageBucket, 'groq');
    assert.equal(PROVIDERS.groq.textModelKey, 'groqModel');
    assert.equal(PROVIDERS.groq.imageModelKey, 'groqImageModel');

    assert.equal(PROVIDERS.openrouter.id, 'openrouter');
    assert.equal(PROVIDERS.openrouter.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(PROVIDERS.openrouter.usageBucket, null);
    assert.equal(PROVIDERS.openrouter.textModelKey, 'openrouterModel');
    assert.equal(PROVIDERS.openrouter.imageModelKey, 'openrouterImageModel');
});

test('buildChatRequest targets the provider chat-completions endpoint', () => {
    const { url } = buildChatRequest({
        provider: PROVIDERS.openrouter,
        apiKey: 'sk-test',
        model: 'qwen/qwen3.8-27b',
        messages: [{ role: 'user', content: 'hi' }],
        thinkingDisabled: true,
    });

    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
});

test('buildChatRequest sets the auth header and provider extra headers', () => {
    const { options } = buildChatRequest({
        provider: PROVIDERS.openrouter,
        apiKey: 'sk-test',
        model: 'qwen/qwen3.8-27b',
        messages: [],
        thinkingDisabled: false,
    });

    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer sk-test');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.headers['HTTP-Referer'], 'https://cheatingdaddy.com');
    assert.equal(options.headers['X-Title'], 'Cheating Daddy');
});

test('buildChatRequest omits extra headers for groq', () => {
    const { options } = buildChatRequest({
        provider: PROVIDERS.groq,
        apiKey: 'gsk-test',
        model: 'qwen/qwen3.6-27b',
        messages: [],
        thinkingDisabled: false,
    });

    assert.equal(options.headers['HTTP-Referer'], undefined);
    assert.equal(options.headers.Authorization, 'Bearer gsk-test');
});

test('buildChatRequest streams and applies shared generation settings', () => {
    const { options } = buildChatRequest({
        provider: PROVIDERS.groq,
        apiKey: 'gsk-test',
        model: 'qwen/qwen3.6-27b',
        messages: [{ role: 'user', content: 'hi' }],
        thinkingDisabled: true,
    });

    const body = JSON.parse(options.body);
    assert.equal(body.model, 'qwen/qwen3.6-27b');
    assert.equal(body.stream, true);
    assert.equal(body.temperature, 0.7);
    assert.equal(body.max_completion_tokens, 16384);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
    assert.equal(body.reasoning_effort, 'none');
});

test('buildChatRequest merges per-provider reasoning options into the body', () => {
    const { options } = buildChatRequest({
        provider: PROVIDERS.openrouter,
        apiKey: 'sk-test',
        model: 'qwen/qwen3.8-27b',
        messages: [],
        thinkingDisabled: true,
    });

    const body = JSON.parse(options.body);
    assert.deepEqual(body.reasoning, { exclude: true, effort: 'none' });
});

const { streamChatCompletion } = require('../src/utils/openaiCompatible');

function responseFrom(chunks) {
    const encoder = new TextEncoder();
    return {
        body: new ReadableStream({
            start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(encoder.encode(chunk));
                }
                controller.close();
            },
        }),
    };
}

function deltaFrame(content, finishReason = null) {
    return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }] })}\n`;
}

test('streamChatCompletion accumulates tokens and reports the final text', async () => {
    const seen = [];
    const result = await streamChatCompletion(responseFrom([deltaFrame('Hello'), deltaFrame(' world')]), {
        onText: text => seen.push(text),
    });

    assert.equal(result.fullText, 'Hello world');
    assert.deepEqual(seen, ['Hello', 'Hello world']);
});

test('streamChatCompletion reassembles a frame split across chunks', async () => {
    const frame = deltaFrame('Hello world');
    const midpoint = Math.floor(frame.length / 2);
    const result = await streamChatCompletion(responseFrom([frame.slice(0, midpoint), frame.slice(midpoint)]), {});

    assert.equal(result.fullText, 'Hello world');
});

test('streamChatCompletion ignores the DONE sentinel', async () => {
    const result = await streamChatCompletion(responseFrom([deltaFrame('done'), 'data: [DONE]\n']), {});

    assert.equal(result.fullText, 'done');
});

test('streamChatCompletion survives a malformed frame and reports it', async () => {
    const errors = [];
    const result = await streamChatCompletion(responseFrom(['data: {not json}\n', deltaFrame('ok')]), {
        onParseError: (data, error) => errors.push({ data, message: error.message }),
    });

    assert.equal(result.fullText, 'ok');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].data, '{not json}');
});

test('streamChatCompletion captures the finish reason', async () => {
    const result = await streamChatCompletion(responseFrom([deltaFrame('hi', 'length')]), {});

    assert.equal(result.finishReason, 'length');
});

test('streamChatCompletion withholds onText while only thinking content has arrived', async () => {
    const seen = [];
    const result = await streamChatCompletion(responseFrom([deltaFrame('<think>hmm'), deltaFrame('</think>Answer')]), {
        onText: text => seen.push(text),
    });

    assert.deepEqual(seen, ['Answer']);
    assert.equal(result.fullText, '<think>hmm</think>Answer');
});
