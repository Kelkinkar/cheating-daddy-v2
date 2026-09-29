<img width="1299" height="424" alt="cd (1)" src="https://github.com/user-attachments/assets/b25fff4d-043d-4f38-9985-f832ae0d0f6e" />

## Recall.ai - API for desktop recording

If you’re looking for a hosted desktop recording API, consider checking out [Recall.ai](https://www.recall.ai/product/desktop-recording-sdk/?utm_source=github&utm_medium=sponsorship&utm_campaign=sohzm-cheating-daddy), an API that records Zoom, Google Meet, Microsoft Teams, in-person meetings, and more.

This project is sponsored by Recall.ai.

https://github.com/sohzm/cheating-daddy.git

---

> [!NOTE]  
> Use latest MacOS and Windows version, older versions have limited support

> [!NOTE]  
> During testing it wont answer if you ask something, you need to simulate interviewer asking question, which it will answer

A real-time AI assistant that provides contextual help during video calls, interviews, presentations, and meetings using screen capture and audio analysis.

## Features

- **Live AI Assistance**: Real-time help powered by Google Gemini 2.0 Flash Live
- **Screen & Audio Capture**: Analyzes what you see and hear for contextual responses
- **Pluggable Answer Provider**: Gemini Live transcribes, and OpenRouter or Groq can write the
  answers instead of Gemini. Precedence is OpenRouter → Groq → Gemini Live itself; set a key in
  Home → AI responses to switch, or leave both blank to let Gemini answer
- **Offline Mode**: A fully local pipeline (whisper.cpp + llama.cpp, downloaded on demand) on
  macOS and Windows
- **Multiple Profiles**: Interview, Sales Call, Business Meeting, Presentation, Negotiation, Exam
- **Transparent Overlay**: Always-on-top window that can be positioned anywhere
- **Click-through Mode**: Make window transparent to clicks when needed
- **Cross-platform**: Works on macOS, Windows, and Linux (kinda, dont use, just for testing rn)

## Setup

1. **Get a Gemini API Key**: Visit [Google AI Studio](https://aistudio.google.com/apikey)
2. **Install Dependencies**: `npm install`
3. **Run the App**: `npm start`

## Usage

1. Enter your Gemini API key in the main window
2. Choose your profile and language in settings
3. Click "Start Session" to begin
4. Position the window using keyboard shortcuts
5. The AI will provide real-time assistance based on your screen and what interview asks

## Response Length

Answer length and voice are controlled by the system prompts in `src/utils/prompts.js`, not by a
token limit. Each profile's `formatRequirements` sets a sentence target and a hard word cap — the
interview profile aims for 4-6 sentences capped at 150 words, the sales/meeting/presentation/
negotiation profiles for 3-5 sentences capped at 120, and exam stays at 1-2 for speed.

Answers are written in **first person**, as the words you speak, rather than as advice addressed to
you. Two rules hold that in place and are worth keeping if you edit the prompts: no section
headings, and at most one flat list. Without them the model slides into writing a reference
document, and a document addresses the reader as "you" and runs to a full page.

To change any of this, edit both the rules **and** the few-shot examples in that profile's
`content`: the examples set the effective floor, so changing the rules alone has little effect.

Longer answers take proportionally longer to finish streaming, which matters in a live
conversation. See §7 of `repo/PROJECT_REVIEW.md` for the token caps and their caveats.

## Keyboard Shortcuts

- **Window Movement**: `Ctrl/Cmd + Arrow Keys` - Move window
- **Click-through**: `Ctrl/Cmd + M` - Toggle mouse events
- **Close/Back**: `Ctrl/Cmd + \` - Close window or go back
- **Send Message**: `Enter` - Send text to AI

## Audio Capture

- **macOS**: [SystemAudioDump](https://github.com/Mohammed-Yasin-Mulla/Sound) for system audio
- **Windows**: Loopback audio capture
- **Linux**: Microphone input

## Requirements

- Electron-compatible OS (macOS, Windows, Linux)
- Gemini API key
- Screen recording permissions
- Microphone/audio permissions
