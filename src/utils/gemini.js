const { GoogleGenAI } = require('@google/genai');
const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { saveDebugAudio } = require('../audioUtils');
const { getSystemPrompt } = require('./prompts');
const {
    getAvailableModel,
    incrementLimitCount,
    getApiKey,
    getGroqApiKey,
    getOpenRouterApiKey,
    incrementCharUsage,
    getConfig,
    getCredentials,
} = require('../storage');
const { PROVIDERS, buildChatRequest, streamChatCompletion, stripThinkingTags } = require('./openaiCompatible');
const { connectCloud, sendCloudAudio, sendCloudText, sendCloudImage, closeCloud, isCloudActive, setOnTurnComplete } = require('./cloud');
const { startTransportLog, logTransportEvent, closeTransportLog } = require('./transportLogger');
const { isTranscriptionModel, buildLiveConfig } = require('./liveConfig');
const { createAnswerThread, isFollowUp, buildContinuationMessage, composeThreadText, isNonSpeech } = require('./answerThread');

// Lazy-loaded to avoid circular dependency (localai.js imports from gemini.js)
let _localai = null;
function getLocalAi() {
    if (!_localai) _localai = require('./localai');
    return _localai;
}

// Provider mode: 'byok', 'cloud', or 'local'
let currentProviderMode = 'byok';

// Conversation history for the OpenAI-compatible answer provider (Groq or OpenRouter),
// keyed on the name `groqConversationHistory` for historical reasons; also shared with an
// unreachable legacy code path further down. Do not rename.
let groqConversationHistory = [];

// The on-screen card that voice follow-ups are appended to; see answerThread.js.
let answerThread = createAnswerThread();

// Conversation tracking variables
let currentSessionId = null;
let currentTranscription = '';
let conversationHistory = [];
let screenAnalysisHistory = [];
let currentProfile = null;
let currentCustomPrompt = null;
let isInitializingSession = false;
let currentSystemPrompt = null;

function formatSpeakerResults(results) {
    let text = '';
    for (const result of results) {
        if (result.transcript && result.speakerId) {
            const speakerLabel = result.speakerId === 1 ? 'Interviewer' : 'Candidate';
            text += `[${speakerLabel}]: ${result.transcript}\n`;
        }
    }
    return text;
}

module.exports.formatSpeakerResults = formatSpeakerResults;

// Audio capture variables
let systemAudioProc = null;
let messageBuffer = '';

// Gemini Live streams input transcription in fragments ~120ms apart, so answering on the first
// fragment sends a 2-4 character question ("What"). The primary trigger is Gemini's own voice
// activity detection: its first model output after the interviewer stops arrives 550-1050ms after
// the last fragment (median 735ms across 54 logged questions). The timer is the fallback for
// turns Gemini chooses not to answer (proactiveAudio). Mid-question pauses in real sessions were
// 1.6-2.9s, longer than any window worth waiting, so those are threaded as follow-ups
// (answerThread.js) rather than absorbed here. Measured with scripts/replay-turns.js and
// scripts/measure-live-turns.js; see docs/superpowers/plans/2026-09-29-answer-latency.md.
const TRANSCRIPTION_SETTLE_MS = 1500;
let transcriptionSettleTimer = null;
let awaitingEndOfTurn = false;

function emptyResponseMessage(provider, finishReason) {
    if (finishReason === 'length') {
        return `${provider.label} hit the token limit before returning a final answer. Disable thinking in Home → AI responses and try again.`;
    }

    return `${provider.label} returned an empty response twice in a row (finish reason: ${finishReason || 'unknown'}). This is usually a flaky upstream provider rather than a bad request. Ask again, or try a different model in Home → AI responses.`;
}

const DEFAULT_LIVE_MODEL = 'gemini-3.1-flash-live-preview';

// Reconnection variables
let isUserClosing = false;
let sessionParams = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 2000;

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

// Build context message for session restoration
function buildContextMessage() {
    const lastTurns = conversationHistory.slice(-20);
    const validTurns = lastTurns.filter(turn => turn.transcription?.trim() && turn.ai_response?.trim());

    if (validTurns.length === 0) return null;

    const contextLines = validTurns.map(turn => `[Interviewer]: ${turn.transcription.trim()}\n[Your answer]: ${turn.ai_response.trim()}`);

    return `Session reconnected. Here's the conversation so far:\n\n${contextLines.join('\n\n')}\n\nContinue from here.`;
}

// Conversation management functions
function initializeNewSession(profile = null, customPrompt = null) {
    currentSessionId = Date.now().toString();
    startTransportLog(currentSessionId);
    currentTranscription = '';
    awaitingEndOfTurn = false;
    clearTranscriptionSettleTimer();
    conversationHistory = [];
    screenAnalysisHistory = [];
    groqConversationHistory = [];
    answerThread = createAnswerThread();
    currentProfile = profile;
    currentCustomPrompt = customPrompt;
    console.log('New conversation session started:', currentSessionId, 'profile:', profile);

    // Save initial session with profile context
    if (profile) {
        sendToRenderer('save-session-context', {
            sessionId: currentSessionId,
            profile: profile,
            customPrompt: customPrompt || '',
        });
    }
}

function saveConversationTurn(transcription, aiResponse) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: aiResponse.trim(),
    };

    conversationHistory.push(conversationTurn);
    console.log('Saved conversation turn:', conversationTurn);

    // Send to renderer to save in IndexedDB
    sendToRenderer('save-conversation-turn', {
        sessionId: currentSessionId,
        turn: conversationTurn,
        fullHistory: conversationHistory,
    });
}

function saveScreenAnalysis(prompt, response, model) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const analysisEntry = {
        timestamp: Date.now(),
        prompt: prompt,
        response: response.trim(),
        model: model,
    };

    screenAnalysisHistory.push(analysisEntry);
    console.log('Saved screen analysis:', analysisEntry);

    // Send to renderer to save
    sendToRenderer('save-screen-analysis', {
        sessionId: currentSessionId,
        analysis: analysisEntry,
        fullHistory: screenAnalysisHistory,
        profile: currentProfile,
        customPrompt: currentCustomPrompt,
    });
}

function getCurrentSessionData() {
    return {
        sessionId: currentSessionId,
        history: conversationHistory,
    };
}

async function getEnabledTools() {
    const tools = [];

    // Check if Google Search is enabled (default: true)
    const googleSearchEnabled = await getStoredSetting('googleSearchEnabled', 'true');
    console.log('Google Search enabled:', googleSearchEnabled);

    if (googleSearchEnabled === 'true') {
        tools.push({ googleSearch: {} });
        console.log('Added Google Search tool');
    } else {
        console.log('Google Search tool disabled');
    }

    return tools;
}

async function getStoredSetting(key, defaultValue) {
    try {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
            // Wait a bit for the renderer to be ready
            await new Promise(resolve => setTimeout(resolve, 100));

            // Try to get setting from renderer process localStorage
            const value = await windows[0].webContents.executeJavaScript(`
                (function() {
                    try {
                        if (typeof localStorage === 'undefined') {
                            console.log('localStorage not available yet for ${key}');
                            return '${defaultValue}';
                        }
                        const stored = localStorage.getItem('${key}');
                        console.log('Retrieved setting ${key}:', stored);
                        return stored || '${defaultValue}';
                    } catch (e) {
                        console.error('Error accessing localStorage for ${key}:', e);
                        return '${defaultValue}';
                    }
                })()
            `);
            return value;
        }
    } catch (error) {
        console.error('Error getting stored setting for', key, ':', error.message);
    }
    console.log('Using default value for', key, ':', defaultValue);
    return defaultValue;
}

// Maps a provider id to the credential accessor for its key. Lives here rather than on the
// descriptor so openaiCompatible.js stays free of storage imports.
const PROVIDER_KEY_GETTERS = {
    groq: getGroqApiKey,
    openrouter: getOpenRouterApiKey,
};

// Resolves who answers this turn. Precedence is OpenRouter, then Groq, then null.
// null means Gemini Live answers directly, which is the behavior when no provider key is set.
// Reads credentials once per call: getCredentials() hits disk uncached and this runs in the
// Gemini Live message hot path.
function getAnswerProvider() {
    const credentials = getCredentials();
    if ((credentials.openrouterApiKey || '').trim() !== '') return PROVIDERS.openrouter;
    if ((credentials.groqApiKey || '').trim() !== '') return PROVIDERS.groq;
    return null;
}

// Node's fetch drops idle keep-alive sockets after ~4s and questions are further apart than that,
// so every answer paid a fresh TLS handshake: measured 408ms cold vs 132ms warm to OpenRouter.
// Opening the socket while the interviewer is still talking takes that off the critical path.
const WARMUP_MIN_INTERVAL_MS = 3000;
let lastWarmupAt = 0;

function warmAnswerProviderConnection() {
    if (Date.now() - lastWarmupAt < WARMUP_MIN_INTERVAL_MS) return;
    const provider = getAnswerProvider();
    if (provider !== PROVIDERS.openrouter) return;
    lastWarmupAt = Date.now();
    fetch(`${provider.baseUrl}/key`, { headers: { Authorization: `Bearer ${getOpenRouterApiKey()}` } })
        .then(response => response.arrayBuffer())
        .catch(() => {});
}

function clearTranscriptionSettleTimer() {
    if (transcriptionSettleTimer) {
        clearTimeout(transcriptionSettleTimer);
        transcriptionSettleTimer = null;
    }
}

function scheduleAnswerForSettledTranscription() {
    clearTranscriptionSettleTimer();
    transcriptionSettleTimer = setTimeout(() => {
        transcriptionSettleTimer = null;
        sendFinalTranscriptionToAnswerProvider();
    }, TRANSCRIPTION_SETTLE_MS);
}

// A turn can end inside the settle window: Gemini finishes generating fast on short input, so
// its generationComplete/turnComplete can arrive before the settle timer fires. Cancelling the
// timer there dropped the question with no answer and no error, so flush it instead. Safe to
// call twice - the second call sees an empty transcription.
function flushPendingTranscription() {
    if (!transcriptionSettleTimer) {
        return;
    }

    clearTranscriptionSettleTimer();
    sendFinalTranscriptionToAnswerProvider();
}

// Takes the settled speech and clears it, so each send is one chunk of speech. Speech that arrives
// after a send, even inside the same Gemini turn, becomes its own send rather than being dropped:
// the old per-turn latch held until turnComplete, 20-30s later, and silently swallowed follow-ups.
function sendFinalTranscriptionToAnswerProvider() {
    const provider = getAnswerProvider();
    if (!provider) {
        return;
    }

    const transcription = currentTranscription.trim();
    currentTranscription = '';
    awaitingEndOfTurn = false;
    if (transcription === '' || isNonSpeech(transcription)) {
        return;
    }

    sendTextToProvider(provider, transcription, { threadable: true });
}

function trimConversationHistoryForGemma(history, maxChars = 42000) {
    if (!history || history.length === 0) return [];
    let totalChars = 0;
    const trimmed = [];

    for (let i = history.length - 1; i >= 0; i--) {
        const turn = history[i];
        const turnChars = (turn.content || '').length;

        if (totalChars + turnChars > maxChars) break;
        totalChars += turnChars;
        trimmed.unshift(turn);
    }
    return trimmed;
}

// One request/stream cycle. Returns { fullText, finishReason } on success, or { httpError } when the
// call itself failed, so the caller can retry a valid-but-empty generation without retrying an error.
async function streamProviderAnswer({ provider, apiKey, model, messages, thinkingDisabled, onDisplayText }) {
    const { url, options } = buildChatRequest({ provider, apiKey, model, messages, thinkingDisabled });

    const response = await fetch(url, options);

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`${provider.label} API error:`, response.status, errorText);
        logTransportEvent(`${provider.id}.text.http_error`, {
            status: response.status,
            body: errorText,
        });
        return { httpError: response.status };
    }

    logTransportEvent(`${provider.id}.text.http_response`, { status: response.status });

    let isFirst = true;
    return await streamChatCompletion(response, {
        onText: displayText => {
            onDisplayText(displayText, isFirst);
            isFirst = false;
        },
        onChunk: chunk => logTransportEvent(`${provider.id}.text.stream_chunk`, { chunk }),
        onEvent: event => logTransportEvent(`${provider.id}.text.stream_event`, event),
        onParseError: (data, error) =>
            logTransportEvent(`${provider.id}.text.stream_parse_error`, {
                data,
                error: error.message,
            }),
    });
}

// threadable: voice input may continue the current card as a follow-up. Typed questions are
// deliberate, so they always open a new card.
async function sendTextToProvider(provider, transcription, { threadable = false } = {}) {
    const apiKey = PROVIDER_KEY_GETTERS[provider.id]();
    if (!apiKey) {
        console.log(`No ${provider.label} API key configured, skipping response`);
        return;
    }

    if (!transcription || transcription.trim() === '') {
        console.log(`Empty transcription, skipping ${provider.label}`);
        return;
    }

    const config = getConfig();
    const modelToUse = config[provider.textModelKey];

    const followUp = threadable && isFollowUp(answerThread, Date.now());
    if (!followUp) {
        answerThread = createAnswerThread();
    }
    const thread = answerThread;
    const segmentIndex = thread.segments.length;
    const modelInput = followUp ? buildContinuationMessage(thread.questions, transcription.trim()) : transcription.trim();
    thread.questions.push(transcription.trim());
    thread.segments.push('');

    // The first answer opens a card; follow-ups rewrite that card with every segment so far, so an
    // answer still streaming above keeps updating in place.
    const showSegment = (text, isFirst) => {
        thread.segments[segmentIndex] = text;
        if (thread !== answerThread) return; // a newer card owns the screen
        const opensCard = segmentIndex === 0 && isFirst;
        sendToRenderer(opensCard ? 'new-response' : 'update-response', composeThreadText(thread.segments));
    };

    console.log(`Sending to ${provider.label} (${modelToUse}):`, transcription.substring(0, 100) + '...');
    logTransportEvent(`${provider.id}.text.request`, {
        model: modelToUse,
        transcription,
        followUp,
    });

    groqConversationHistory.push({
        role: 'user',
        content: modelInput,
    });

    if (groqConversationHistory.length > 20) {
        groqConversationHistory = groqConversationHistory.slice(-20);
    }

    const systemPrompt = currentSystemPrompt || 'You are a helpful assistant.';

    thread.streaming++;
    try {
        const attemptOptions = {
            provider,
            apiKey,
            model: modelToUse,
            messages: [{ role: 'system', content: systemPrompt }, ...groqConversationHistory],
            thinkingDisabled: config.disableGroqThinking,
            onDisplayText: showSegment,
        };

        let attempt = await streamProviderAnswer(attemptOptions);
        if (attempt.httpError) {
            sendToRenderer('update-status', `${provider.label} error: ${attempt.httpError}`);
            return;
        }

        let cleanedResponse = stripThinkingTags(attempt.fullText);

        // OpenRouter fans a model out across many upstream providers, and one occasionally returns a
        // clean `stop` with no content at all (observed: completion_tokens 1, empty delta, HTTP 200).
        // It is an upstream flake rather than a bad request, and a retry usually lands elsewhere, so
        // spend one. A 'length' finish is a real cap being hit and would just fail again.
        if (!cleanedResponse && attempt.finishReason !== 'length') {
            console.warn(`${provider.label} returned an empty generation, retrying once`);
            logTransportEvent(`${provider.id}.text.empty_retry`, {
                model: modelToUse,
                finishReason: attempt.finishReason,
            });

            attempt = await streamProviderAnswer(attemptOptions);
            if (attempt.httpError) {
                sendToRenderer('update-status', `${provider.label} error: ${attempt.httpError}`);
                return;
            }
            cleanedResponse = stripThinkingTags(attempt.fullText);
        }

        const { fullText, finishReason } = attempt;

        if (provider.usageBucket) {
            const modelKey = modelToUse.split('/').pop();
            const historyChars = groqConversationHistory.reduce((sum, msg) => sum + (msg.content || '').length, 0);
            const inputChars = systemPrompt.length + historyChars;
            incrementCharUsage(provider.usageBucket, modelKey, inputChars + cleanedResponse.length);
        }

        if (cleanedResponse) {
            groqConversationHistory.push({
                role: 'assistant',
                content: cleanedResponse,
            });

            saveConversationTurn(transcription, cleanedResponse);
        } else {
            console.warn(`${provider.label} returned no final answer (${modelToUse})`);
            logTransportEvent(`${provider.id}.text.empty_response`, {
                model: modelToUse,
                fullText,
                finishReason,
            });
            showSegment(emptyResponseMessage(provider, finishReason), true);
            sendToRenderer('update-status', `${provider.label} returned an empty response`);
            return;
        }

        logTransportEvent(`${provider.id}.text.completed`, {
            model: modelToUse,
            response: cleanedResponse,
        });
        console.log(`${provider.label} response completed (${modelToUse})`);
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error(`Error calling ${provider.label} API:`, error);
        logTransportEvent(`${provider.id}.text.error`, {
            error: error.message,
            stack: error.stack,
        });
        sendToRenderer('update-status', `${provider.label} error: ` + error.message);
    } finally {
        thread.streaming--;
        thread.finishedAt = Date.now();
    }
}

async function sendImageToProvider(provider, base64Data, prompt) {
    const apiKey = PROVIDER_KEY_GETTERS[provider.id]();
    const config = getConfig();
    const model = config[provider.imageModelKey];

    logTransportEvent(`${provider.id}.image.request`, {
        model,
        prompt,
        imageBytes: Buffer.byteLength(base64Data, 'base64'),
    });

    try {
        const { url, options } = buildChatRequest({
            provider,
            apiKey,
            model,
            messages: [
                { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:image/jpeg;base64,${base64Data}`,
                            },
                        },
                    ],
                },
            ],
            thinkingDisabled: config.disableGroqThinking,
        });

        const response = await fetch(url, options);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`${provider.label} image API error:`, response.status, errorText);
            logTransportEvent(`${provider.id}.image.http_error`, {
                status: response.status,
                body: errorText,
            });
            return { success: false, error: `${provider.label} error: ${response.status}` };
        }

        logTransportEvent(`${provider.id}.image.http_response`, {
            status: response.status,
        });

        let isFirst = true;
        const { fullText, finishReason } = await streamChatCompletion(response, {
            onText: displayText => {
                sendToRenderer(isFirst ? 'new-response' : 'update-response', displayText);
                isFirst = false;
            },
            onChunk: chunk => logTransportEvent(`${provider.id}.image.stream_chunk`, { chunk }),
            onEvent: event => logTransportEvent(`${provider.id}.image.stream_event`, event),
            onParseError: (data, error) =>
                logTransportEvent(`${provider.id}.image.stream_parse_error`, {
                    data,
                    error: error.message,
                }),
        });

        const cleanedResponse = stripThinkingTags(fullText);
        if (!cleanedResponse) {
            logTransportEvent(`${provider.id}.image.empty_response`, {
                model,
                fullText,
                finishReason,
            });
            return { success: false, error: emptyResponseMessage(provider, finishReason) };
        }

        saveScreenAnalysis(prompt, cleanedResponse, model);
        logTransportEvent(`${provider.id}.image.completed`, {
            model,
            response: cleanedResponse,
        });
        return { success: true, text: cleanedResponse, model };
    } catch (error) {
        console.error(`Error calling ${provider.label} image API:`, error);
        logTransportEvent(`${provider.id}.image.error`, {
            error: error.message,
            stack: error.stack,
        });
        return { success: false, error: error.message };
    }
}

async function sendToGemma(transcription) {
    const apiKey = getApiKey();
    if (!apiKey) {
        console.log('No Gemini API key configured');
        return;
    }

    if (!transcription || transcription.trim() === '') {
        console.log('Empty transcription, skipping Gemma');
        return;
    }

    console.log('Sending to Gemma:', transcription.substring(0, 100) + '...');

    groqConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    const trimmedHistory = trimConversationHistoryForGemma(groqConversationHistory, 42000);

    try {
        const ai = new GoogleGenAI({ apiKey: apiKey });

        const messages = trimmedHistory.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }],
        }));

        const systemPrompt = currentSystemPrompt || 'You are a helpful assistant.';
        const messagesWithSystem = [
            { role: 'user', parts: [{ text: systemPrompt }] },
            { role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] },
            ...messages,
        ];

        const response = await ai.models.generateContentStream({
            model: 'gemma-4-26b-a4b-it',
            contents: messagesWithSystem,
        });

        let fullText = '';
        let isFirst = true;

        for await (const chunk of response) {
            const chunkText = chunk.text;
            if (chunkText) {
                fullText += chunkText;
                sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                isFirst = false;
            }
        }

        const systemPromptChars = (currentSystemPrompt || 'You are a helpful assistant.').length;
        const historyChars = trimmedHistory.reduce((sum, msg) => sum + (msg.content || '').length, 0);
        const inputChars = systemPromptChars + historyChars;
        const outputChars = fullText.length;

        incrementCharUsage('gemini', 'gemma-4-26b-a4b-it', inputChars + outputChars);

        if (fullText.trim()) {
            groqConversationHistory.push({
                role: 'assistant',
                content: fullText.trim(),
            });

            if (groqConversationHistory.length > 40) {
                groqConversationHistory = groqConversationHistory.slice(-40);
            }

            saveConversationTurn(transcription, fullText);
        }

        console.log('Gemma response completed');
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('Error calling Gemma API:', error);
        sendToRenderer('update-status', 'Gemma error: ' + error.message);
    }
}

async function initializeGeminiSession(apiKey, customPrompt = '', profile = 'interview', language = 'en-US', isReconnect = false) {
    if (isInitializingSession) {
        console.log('Session initialization already in progress');
        return false;
    }

    isInitializingSession = true;
    if (!isReconnect) {
        sendToRenderer('session-initializing', true);
    }

    // Store params for reconnection
    if (!isReconnect) {
        sessionParams = { apiKey, customPrompt, profile, language };
        reconnectAttempts = 0;
    }

    const client = new GoogleGenAI({
        vertexai: false,
        apiKey: apiKey,
        httpOptions: { apiVersion: 'v1alpha' },
    });

    // Get enabled tools first to determine Google Search status
    const enabledTools = await getEnabledTools();
    const googleSearchEnabled = enabledTools.some(tool => tool.googleSearch);

    const systemPrompt = getSystemPrompt(profile, customPrompt, googleSearchEnabled);
    currentSystemPrompt = systemPrompt; // Store for Groq

    // Initialize new conversation session only on first connect
    if (!isReconnect) {
        initializeNewSession(profile, customPrompt);
    }

    // A transcription-only model never answers, so without an answer provider fall back to the
    // default native-audio model rather than a session that stays silent.
    let liveModel = getConfig().geminiLiveModel;
    if (isTranscriptionModel(liveModel) && !getAnswerProvider()) {
        console.warn(`${liveModel} only transcribes and no answer provider is set; using ${DEFAULT_LIVE_MODEL}`);
        liveModel = DEFAULT_LIVE_MODEL;
    }

    try {
        const session = await client.live.connect({
            model: liveModel,
            callbacks: {
                onopen: function () {
                    logTransportEvent('gemini.live.opened', {});
                    sendToRenderer('update-status', 'Live session connected');
                },
                onmessage: function (message) {
                    console.log('----------------', message);
                    logTransportEvent('gemini.live.message', message);

                    if (message.serverContent?.inputTranscription && currentTranscription === '') {
                        warmAnswerProviderConnection();
                    }

                    // Handle input transcription (what was spoken)
                    if (message.serverContent?.inputTranscription?.results) {
                        currentTranscription += formatSpeakerResults(message.serverContent.inputTranscription.results);
                    } else if (message.serverContent?.inputTranscription?.text) {
                        const text = message.serverContent.inputTranscription.text;
                        if (text.trim() !== '') {
                            currentTranscription += text;
                        }
                    }

                    if (message.serverContent?.inputTranscription) {
                        awaitingEndOfTurn = true;
                        scheduleAnswerForSettledTranscription();
                    } else if (awaitingEndOfTurn && (message.serverContent?.modelTurn || message.serverContent?.outputTranscription)) {
                        // Gemini's first output after the interviewer stops is its end-of-turn decision,
                        // ~765ms sooner than the settle timer at the median.
                        awaitingEndOfTurn = false;
                        flushPendingTranscription();
                    }

                    if (message.serverContent?.outputTranscription?.text && !getAnswerProvider()) {
                        const isFirstChunk = messageBuffer === '';
                        messageBuffer += message.serverContent.outputTranscription.text;
                        sendToRenderer(isFirstChunk ? 'new-response' : 'update-response', messageBuffer);
                    }

                    if (message.serverContent?.generationComplete) {
                        // Must run before currentTranscription is cleared below.
                        flushPendingTranscription();
                        if (currentTranscription.trim() !== '') {
                            if (messageBuffer.trim() !== '' && !getAnswerProvider()) {
                                saveConversationTurn(currentTranscription, messageBuffer);
                            }
                            currentTranscription = '';
                        }
                        messageBuffer = '';
                    }

                    if (message.serverContent?.turnComplete) {
                        flushPendingTranscription();
                        currentTranscription = '';
                        messageBuffer = '';
                        sendToRenderer('update-status', 'Listening...');
                    }
                },
                onerror: function (e) {
                    console.log('Session error:', e.message);
                    logTransportEvent('gemini.live.error', {
                        error: e.message,
                    });
                    sendToRenderer('update-status', 'Error: ' + e.message);
                },
                onclose: function (e) {
                    console.log('Session closed:', e.reason);
                    logTransportEvent('gemini.live.closed', {
                        reason: e.reason,
                    });

                    // Don't reconnect if user intentionally closed
                    if (isUserClosing) {
                        isUserClosing = false;
                        closeTransportLog();
                        sendToRenderer('update-status', 'Session closed');
                        return;
                    }

                    // Attempt reconnection
                    if (sessionParams && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                        attemptReconnect();
                    } else {
                        closeTransportLog();
                        sendToRenderer('update-status', 'Session closed');
                    }
                },
            },
            config: buildLiveConfig({ model: liveModel, tools: enabledTools, systemPrompt, language }),
        });

        isInitializingSession = false;
        if (!isReconnect) {
            sendToRenderer('session-initializing', false);
        }
        return session;
    } catch (error) {
        console.error('Failed to initialize Gemini session:', error);
        isInitializingSession = false;
        if (!isReconnect) {
            sendToRenderer('session-initializing', false);
        }
        return null;
    }
}

async function attemptReconnect() {
    reconnectAttempts++;
    console.log(`Reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);

    // Clear stale buffers
    messageBuffer = '';
    currentTranscription = '';
    // Don't reset groqConversationHistory to preserve context across reconnects

    sendToRenderer('update-status', `Reconnecting... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    // Wait before attempting
    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));

    try {
        const session = await initializeGeminiSession(
            sessionParams.apiKey,
            sessionParams.customPrompt,
            sessionParams.profile,
            sessionParams.language,
            true // isReconnect
        );

        if (session && global.geminiSessionRef) {
            global.geminiSessionRef.current = session;

            // Restore context from conversation history via text message
            const contextMessage = buildContextMessage();
            if (contextMessage) {
                try {
                    console.log('Restoring conversation context...');
                    await session.sendRealtimeInput({ text: contextMessage });
                } catch (contextError) {
                    console.error('Failed to restore context:', contextError);
                    // Continue without context - better than failing
                }
            }

            // Don't reset reconnectAttempts here - let it reset on next fresh session
            sendToRenderer('update-status', 'Reconnected! Listening...');
            console.log('Session reconnected successfully');
            return true;
        }
    } catch (error) {
        console.error(`Reconnection attempt ${reconnectAttempts} failed:`, error);
    }

    // If we still have attempts left, try again
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        return attemptReconnect();
    }

    // Max attempts reached - notify frontend
    console.log('Max reconnection attempts reached');
    sendToRenderer('reconnect-failed', {
        message: 'Tried 3 times to reconnect. Must be upstream/network issues. Try restarting or download updated app from site.',
    });
    sessionParams = null;
    return false;
}

function killExistingSystemAudioDump() {
    return new Promise(resolve => {
        console.log('Checking for existing SystemAudioDump processes...');

        // Kill any existing SystemAudioDump processes
        const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], {
            stdio: 'ignore',
        });

        killProc.on('close', code => {
            if (code === 0) {
                console.log('Killed existing SystemAudioDump processes');
            } else {
                console.log('No existing SystemAudioDump processes found');
            }
            resolve();
        });

        killProc.on('error', err => {
            console.log('Error checking for existing processes (this is normal):', err.message);
            resolve();
        });

        // Timeout after 2 seconds
        setTimeout(() => {
            killProc.kill();
            resolve();
        }, 2000);
    });
}

async function startMacOSAudioCapture(geminiSessionRef) {
    if (process.platform !== 'darwin') return false;

    // Kill any existing SystemAudioDump processes first
    await killExistingSystemAudioDump();

    console.log('Starting macOS audio capture with SystemAudioDump...');

    const { app } = require('electron');
    const path = require('path');

    let systemAudioPath;
    if (app.isPackaged) {
        systemAudioPath = path.join(process.resourcesPath, 'SystemAudioDump');
    } else {
        systemAudioPath = path.join(__dirname, '../assets', 'SystemAudioDump');
    }

    console.log('SystemAudioDump path:', systemAudioPath);

    const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
        },
    };

    systemAudioProc = spawn(systemAudioPath, [], spawnOptions);

    if (!systemAudioProc.pid) {
        console.error('Failed to start SystemAudioDump');
        return false;
    }

    console.log('SystemAudioDump started with PID:', systemAudioProc.pid);

    const CHUNK_DURATION = 0.1;
    const SAMPLE_RATE = 24000;
    const BYTES_PER_SAMPLE = 2;
    const CHANNELS = 2;
    const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

    let audioBuffer = Buffer.alloc(0);

    systemAudioProc.stdout.on('data', data => {
        audioBuffer = Buffer.concat([audioBuffer, data]);

        while (audioBuffer.length >= CHUNK_SIZE) {
            const chunk = audioBuffer.slice(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE);

            const monoChunk = CHANNELS === 2 ? convertStereoToMono(chunk) : chunk;

            if (currentProviderMode === 'cloud') {
                sendCloudAudio(monoChunk);
            } else if (currentProviderMode === 'local') {
                getLocalAi().processLocalAudio(monoChunk);
            } else {
                const base64Data = monoChunk.toString('base64');
                sendAudioToGemini(base64Data, geminiSessionRef);
            }

            if (process.env.DEBUG_AUDIO) {
                console.log(`Processed audio chunk: ${chunk.length} bytes`);
                saveDebugAudio(monoChunk, 'system_audio');
            }
        }

        const maxBufferSize = SAMPLE_RATE * BYTES_PER_SAMPLE * 1;
        if (audioBuffer.length > maxBufferSize) {
            audioBuffer = audioBuffer.slice(-maxBufferSize);
        }
    });

    systemAudioProc.stderr.on('data', data => {
        console.error('SystemAudioDump stderr:', data.toString());
    });

    systemAudioProc.on('close', code => {
        console.log('SystemAudioDump process closed with code:', code);
        systemAudioProc = null;
    });

    systemAudioProc.on('error', err => {
        console.error('SystemAudioDump process error:', err);
        systemAudioProc = null;
    });

    return true;
}

function convertStereoToMono(stereoBuffer) {
    const samples = stereoBuffer.length / 4;
    const monoBuffer = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
        const leftSample = stereoBuffer.readInt16LE(i * 4);
        monoBuffer.writeInt16LE(leftSample, i * 2);
    }

    return monoBuffer;
}

function stopMacOSAudioCapture() {
    if (systemAudioProc) {
        console.log('Stopping SystemAudioDump...');
        systemAudioProc.kill('SIGTERM');
        systemAudioProc = null;
    }
}

async function sendAudioToGemini(base64Data, geminiSessionRef) {
    if (!geminiSessionRef.current) return;

    try {
        process.stdout.write('.');
        await geminiSessionRef.current.sendRealtimeInput({
            audio: {
                data: base64Data,
                mimeType: 'audio/pcm;rate=24000',
            },
        });
    } catch (error) {
        console.error('Error sending audio to Gemini:', error);
    }
}

async function sendImageToGeminiHttp(base64Data, prompt) {
    // Get available model based on rate limits
    const model = getAvailableModel();

    const apiKey = getApiKey();
    if (!apiKey) {
        return { success: false, error: 'No API key configured' };
    }

    try {
        const ai = new GoogleGenAI({ apiKey: apiKey });

        const contents = [
            {
                inlineData: {
                    mimeType: 'image/jpeg',
                    data: base64Data,
                },
            },
            { text: prompt },
        ];

        console.log(`Sending image to ${model} (streaming)...`);
        const response = await ai.models.generateContentStream({
            model: model,
            contents: contents,
        });

        // Increment count after successful call
        incrementLimitCount(model);

        // Stream the response
        let fullText = '';
        let isFirst = true;
        for await (const chunk of response) {
            const chunkText = chunk.text;
            if (chunkText) {
                fullText += chunkText;
                // Send to renderer - new response for first chunk, update for subsequent
                sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                isFirst = false;
            }
        }

        console.log(`Image response completed from ${model}`);

        // Save screen analysis to history
        saveScreenAnalysis(prompt, fullText, model);

        return { success: true, text: fullText, model: model };
    } catch (error) {
        console.error('Error sending image to Gemini HTTP:', error);
        return { success: false, error: error.message };
    }
}

function setupGeminiIpcHandlers(geminiSessionRef) {
    // Store the geminiSessionRef globally for reconnection access
    global.geminiSessionRef = geminiSessionRef;

    ipcMain.handle('initialize-cloud', async (event, token, profile, userContext) => {
        try {
            currentProviderMode = 'cloud';
            initializeNewSession(profile);
            setOnTurnComplete((transcription, response) => {
                saveConversationTurn(transcription, response);
            });
            sendToRenderer('session-initializing', true);
            await connectCloud(token, profile, userContext);
            sendToRenderer('session-initializing', false);
            return true;
        } catch (err) {
            console.error('[Cloud] Init error:', err);
            currentProviderMode = 'byok';
            sendToRenderer('session-initializing', false);
            return false;
        }
    });

    ipcMain.handle('initialize-gemini', async (event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
        currentProviderMode = 'byok';
        const session = await initializeGeminiSession(apiKey, customPrompt, profile, language);
        if (session) {
            geminiSessionRef.current = session;
            return true;
        }
        return false;
    });

    ipcMain.handle('initialize-local', async (event, localLlmModel, whisperModel, profile, customPrompt) => {
        currentProviderMode = 'local';
        const success = await getLocalAi().initializeLocalSession(localLlmModel, whisperModel, profile, customPrompt);
        if (!success) {
            currentProviderMode = 'byok';
        }
        return success;
    });

    ipcMain.handle('cancel-local-initialization', async () => {
        const cancelled = await getLocalAi().cancelLocalInitialization();
        if (cancelled) {
            currentProviderMode = 'byok';
        }
        return cancelled;
    });

    ipcMain.handle('send-audio-content', async (event, { data, mimeType }) => {
        if (currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (currentProviderMode === 'local') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                getLocalAi().processLocalAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending local audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };
        try {
            process.stdout.write('.');
            await geminiSessionRef.current.sendRealtimeInput({
                audio: { data: data, mimeType: mimeType },
            });
            return { success: true };
        } catch (error) {
            console.error('Error sending system audio:', error);
            return { success: false, error: error.message };
        }
    });

    // Handle microphone audio on a separate channel
    ipcMain.handle('send-mic-audio-content', async (event, { data, mimeType }) => {
        if (currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (currentProviderMode === 'local') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                getLocalAi().processLocalAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending local mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };
        try {
            process.stdout.write(',');
            await geminiSessionRef.current.sendRealtimeInput({
                audio: { data: data, mimeType: mimeType },
            });
            return { success: true };
        } catch (error) {
            console.error('Error sending mic audio:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-image-content', async (event, { data, prompt }) => {
        try {
            if (!data || typeof data !== 'string') {
                console.error('Invalid image data received');
                return { success: false, error: 'Invalid image data' };
            }

            const buffer = Buffer.from(data, 'base64');

            if (buffer.length < 1000) {
                console.error(`Image buffer too small: ${buffer.length} bytes`);
                return { success: false, error: 'Image buffer too small' };
            }

            process.stdout.write('!');

            if (currentProviderMode === 'cloud') {
                const sent = sendCloudImage(data);
                if (!sent) {
                    return { success: false, error: 'Cloud connection not active' };
                }
                return { success: true, model: 'cloud' };
            }

            if (currentProviderMode === 'local') {
                const result = await getLocalAi().sendLocalImage(data, prompt);
                return result;
            }

            const imageProvider = getAnswerProvider();
            const result = imageProvider ? await sendImageToProvider(imageProvider, data, prompt) : await sendImageToGeminiHttp(data, prompt);
            return result;
        } catch (error) {
            console.error('Error sending image:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-text-message', async (event, text) => {
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return { success: false, error: 'Invalid text message' };
        }

        if (currentProviderMode === 'cloud') {
            try {
                console.log('Sending text to cloud:', text);
                sendCloudText(text.trim());
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud text:', error);
                return { success: false, error: error.message };
            }
        }

        if (currentProviderMode === 'local') {
            try {
                console.log('Sending text to local Llama:', text);
                return await getLocalAi().sendLocalText(text.trim());
            } catch (error) {
                console.error('Error sending local text:', error);
                return { success: false, error: error.message };
            }
        }

        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };

        try {
            console.log('Sending text message:', text);

            const textProvider = getAnswerProvider();
            if (textProvider) {
                sendTextToProvider(textProvider, text.trim());
            }

            await geminiSessionRef.current.sendRealtimeInput({ text: text.trim() });
            return { success: true };
        } catch (error) {
            console.error('Error sending text:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-macos-audio', async event => {
        if (process.platform !== 'darwin') {
            return {
                success: false,
                error: 'macOS audio capture only available on macOS',
            };
        }

        try {
            const success = await startMacOSAudioCapture(geminiSessionRef);
            return { success };
        } catch (error) {
            console.error('Error starting macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-macos-audio', async event => {
        try {
            stopMacOSAudioCapture();
            return { success: true };
        } catch (error) {
            console.error('Error stopping macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('close-session', async event => {
        try {
            stopMacOSAudioCapture();

            if (currentProviderMode === 'cloud') {
                closeCloud();
                currentProviderMode = 'byok';
                closeTransportLog();
                return { success: true };
            }

            if (currentProviderMode === 'local') {
                getLocalAi().closeLocalSession();
                currentProviderMode = 'byok';
                closeTransportLog();
                return { success: true };
            }

            // Set flag to prevent reconnection attempts
            isUserClosing = true;
            clearTranscriptionSettleTimer();
            sessionParams = null;

            // Cleanup session
            if (geminiSessionRef.current) {
                await geminiSessionRef.current.close();
                geminiSessionRef.current = null;
            } else {
                closeTransportLog();
            }

            return { success: true };
        } catch (error) {
            console.error('Error closing session:', error);
            return { success: false, error: error.message };
        }
    });

    // Conversation history IPC handlers
    ipcMain.handle('get-current-session', async event => {
        try {
            return { success: true, data: getCurrentSessionData() };
        } catch (error) {
            console.error('Error getting current session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-new-session', async event => {
        try {
            initializeNewSession();
            return { success: true, sessionId: currentSessionId };
        } catch (error) {
            console.error('Error starting new session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('update-google-search-setting', async (event, enabled) => {
        try {
            console.log('Google Search setting updated to:', enabled);
            // The setting is already saved in localStorage by the renderer
            // This is just for logging/confirmation
            return { success: true };
        } catch (error) {
            console.error('Error updating Google Search setting:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    initializeGeminiSession,
    getEnabledTools,
    getStoredSetting,
    sendToRenderer,
    initializeNewSession,
    saveConversationTurn,
    getCurrentSessionData,
    killExistingSystemAudioDump,
    startMacOSAudioCapture,
    convertStereoToMono,
    stopMacOSAudioCapture,
    sendAudioToGemini,
    sendImageToGeminiHttp,
    setupGeminiIpcHandlers,
    formatSpeakerResults,
};
