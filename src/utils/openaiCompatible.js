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

module.exports = {
    stripThinkingTags,
    getGroqReasoningOptions,
    getOpenRouterReasoningOptions,
};
