// Pure helpers shared by every OpenAI-compatible answer provider (Groq, OpenRouter).
// This module intentionally imports nothing so it stays unit-testable under `node --test`
// and cannot participate in the circular dependency between gemini.js and localai.js.

function stripThinkingTags(text) {
    const trimmedStart = text.trimStart();
    if ('<think>'.startsWith(trimmedStart)) {
        return '';
    }

    return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
}

function getGroqReasoningOptions(model, disableThinking) {
    if (model.includes('qwen3')) {
        const options = {
            reasoning_format: 'hidden',
        };

        if (disableThinking) {
            options.reasoning_effort = 'none';
        }

        return options;
    }

    if (model.startsWith('openai/gpt-oss-')) {
        return {
            include_reasoning: false,
        };
    }

    return {};
}

function getOpenRouterReasoningOptions(model, disableThinking) {
    // exclude:true mirrors Groq's always-on reasoning_format:'hidden' — keep reasoning out of the
    // streamed content. effort:'none' mirrors reasoning_effort:'none' — actually stop generating it.
    const reasoning = { exclude: true };

    if (disableThinking) {
        reasoning.effort = 'none';
    }

    return { reasoning };
}

const MAX_COMPLETION_TOKENS = 16384;
const TEMPERATURE = 0.7;

const PROVIDERS = {
    groq: {
        id: 'groq',
        label: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        textModelKey: 'groqModel',
        imageModelKey: 'groqImageModel',
        usageBucket: 'groq',
        extraHeaders: {},
        reasoningOptions: getGroqReasoningOptions,
    },
    openrouter: {
        id: 'openrouter',
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        textModelKey: 'openrouterModel',
        imageModelKey: 'openrouterImageModel',
        // OpenRouter is prepaid credit with no daily free-tier allowance to protect, so no bucket.
        usageBucket: null,
        extraHeaders: {
            'HTTP-Referer': 'https://cheatingdaddy.com',
            'X-Title': 'Cheating Daddy',
        },
        reasoningOptions: getOpenRouterReasoningOptions,
    },
};

function buildChatRequest({ provider, apiKey, model, messages, thinkingDisabled }) {
    return {
        url: `${provider.baseUrl}/chat/completions`,
        options: {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                ...provider.extraHeaders,
            },
            body: JSON.stringify({
                model,
                messages,
                stream: true,
                temperature: TEMPERATURE,
                max_completion_tokens: MAX_COMPLETION_TOKENS,
                ...provider.reasoningOptions(model, thinkingDisabled),
            }),
        },
    };
}

module.exports = {
    PROVIDERS,
    buildChatRequest,
    stripThinkingTags,
    getGroqReasoningOptions,
    getOpenRouterReasoningOptions,
};
