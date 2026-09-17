# SDD Progress — OpenRouter answer provider

Plan: docs/superpowers/plans/2026-09-17-openrouter-answer-provider.md
Spec: docs/superpowers/specs/2026-09-17-openrouter-provider-design.md
Branch: feat/openrouter-provider (from master @ 3cccc36 + 3 docs commits)
Stash: stash@{0} = user's pre-existing WIP (model rename, README, lockfile)

## Human rulings
- SECRETS: never print credential values in verification. getConfig()/getCredentials() read the
  USER'S REAL ~/.config/cheating-daddy-config/, not code defaults. A Task 4 check printed the live
  openrouterApiKey into the transcript. Not in git (verified every commit + .superpowers/sdd/.gitignore
  is `*`). User advised to rotate. Check presence/length only, never the value.
- USER'S SAVED CONFIG OVERRIDES DEFAULTS: their openrouterModel is already qwen/qwen3-235b-a22b-2507
  and groqModel is qwen/qwen3.8-27b. The qwen/qwen3.8-27b default only affects fresh installs.
  Task 8 manual verification will exercise THEIR models, not the shipped defaults.
- Working tree: stashed, branch from clean master.
- Task 3 SSE fix: KEEP the partial-frame buffering fix; Global Constraint amended to allow it.
- sendToGemma dead code: DO NOT touch. Not a defect for review purposes — plan-mandated.
- disableGroqThinking: keeps its name. Schema purely additive.

## Tasks
- [x] Task 1: complete (commits 4d44d79..578d187, spec OK, quality approved)
- [x] Task 2: complete (commit 9312b2d, spec OK, quality approved)
- [x] Task 3: complete (commits 11d8170..2cc2894, spec OK, quality approved after 1 fix)
- [x] Task 4: complete (commit fe35329, spec OK, quality approved, no findings)
- [x] Task 5: complete (commit 1344362, spec OK, quality approved, no findings)
- [x] Task 6: complete (commits 0b5b84e..7c5b64d, spec OK, quality approved after 1 perf fix)
- [x] Task 7: complete (commit dc6342d, spec OK, quality approved, 1 Minor logged)
- [x] Task 8: complete. Manual verification passed by the user (live session tested, satisfied).

## Minor findings (for final review triage)
- Task 7: the three new _saveOpenRouter* handlers omit the trailing this.requestUpdate() that every
  other save handler in MainView.js calls. Harmless - Lit `state: true` props already schedule a
  re-render, so the existing calls are themselves redundant. Stylistic inconsistency only.
- Task 6: currentSystemPrompt is now snapshotted BEFORE the request for usage accounting rather
  than re-read after. More correct (bills the prompt actually sent); differs only if reassigned mid-stream.
- Task 6: a bare `data: ` line with empty payload no longer emits a stream_parse_error. Log-only.
- Task 6: Groq users will now see FEWER dropped tokens (SSE reassembly reaching production). This is
  the approved deviation; note it in any release notes.
- PLAN DEFECT (mine): planned getAnswerProvider() did 2 uncached disk reads per call and sat left of
  && in the Gemini Live message hot path. Fixed in 7c5b64d.
- Task 3: no try/finally around the SSE read loop. A throwing handler callback leaves the reader
  locked / stream undrained. Matches localai.js pattern. ACCEPTED OUT OF SCOPE - triage at final review.
- PLAN DEFECT (mine): Task 3 code as planned dropped a final frame lacking a trailing newline.
  Inherited from localai.js:186-211, which my plan cited as the correct reference. That file still
  has the bug. Consider a follow-up fix there (OUT OF SCOPE for this branch).
- Task 2: reasoningOptions spreads LAST into the request body. No collision today, but a future
  reasoning helper emitting `model`/`messages`/`stream`/`temperature`/`max_completion_tokens`
  would silently override it. Watch if Task 6 extends these helpers.
- Task 1: stripThinkingTags("") test is arguably redundant with the partial-tag test. Harmless.
- PLAN DEFECT (mine): plan specified `node --test test/`, which Node 24 rejects. Corrected in plan.
- PROCESS: implementer and fixer both filed reports claiming work that was incomplete
  (unstaged deletion, malformed commit trailer). Verify every report against the repo.

## Final whole-branch review (verdict: ready with follow-ups)

RESOLVED by controller, no code change needed:
- `max_completion_tokens` on OpenRouter: reviewer flagged it as possibly-dropped (OpenRouter documents
  `max_tokens`). Checked OpenRouter's live parameter docs: `max_completion_tokens` IS documented and
  supported ("Key: max_completion_tokens, Optional, integer, 1 or above"). The 16384 cap applies.
  Not a defect; does NOT need to go in the manual matrix.

RESOLVED by human (accept, no code change):
- Partially-typed OpenRouter key kills all answers. MainView saves on every @input keystroke, and
  precedence is key PRESENCE. Typing (not pasting) a key means `openrouterApiKey: "s"` after one
  keystroke -> every turn 401s, Groq is bypassed, Gemini output suppressed. Paste is one event, so the
  common path is safe. Same pattern as the existing Groq field.
  DECISION: accepted as-is. It matches the existing Groq field's behavior, and pasting (the normal
  path) is unaffected. No code change. If the Groq field is ever debounced, do both together.

BLOCKING MERGE: none. User tested live and confirmed satisfied.

FOLLOW-UPS (separate branch, NOT this one):
- localai.js:186-211 - same trailing-frame SSE bug fixed here, PLUS a bare JSON.parse with no
  try/catch at line 202: one malformed frame kills the entire local stream. Worse than what was
  fixed here. Zero diff on this branch.
- localai.js + openaiCompatible.js - no try/finally around SSE read loops; window destroyed mid-stream
  leaves the reader locked. Pre-existing pattern, present on master too.
- storage.js - rate-limit counter model names don't match getAvailableModel(). Untouched here.
  This is the change sitting in the user's stash@{0}.
- Release notes: Groq users will see fewer dropped tokens (the approved SSE deviation).

## Post-review fixes (found during the user's live testing)

- e7bdf00 fix: wait for transcription to settle before answering (800ms debounce).
  ROOT CAUSE of the long-running "compound question" problem. Questions were truncated to their
  first fragment ("Te", "If", "What"). Pre-existing on master; affected Groq identically.
  Proven by replaying the real session log through the new logic: all 4 questions now complete.
- eca2d91 fix: send max_tokens to openrouter and stop forcing unsupported reasoning param
  1. max_completion_tokens is NOT in OpenRouter's per-model supported_parameters -> silently dropped
     -> generation was UNCAPPED on prepaid credit. Now sends max_tokens via provider.maxTokensParam.
     NOTE: the final reviewer flagged this and the controller incorrectly dismissed it based on
     OpenRouter's general docs page. Per-model supported_parameters is the authority.
  2. `reasoning` was sent unconditionally; many models don't support it. Now opt-in only.
  3. emptyResponseMessage claimed a token limit when finish_reason was "stop" and reasoning_tokens 0.
     Now reports the real finish_reason.
  Groq reasoning options verified IDENTICAL across all model/flag combinations after the change.

## User config note
Their saved openrouterModel/openrouterImageModel was qwen/qwen3-235b-a22b-2507, which is text-only
AND does not support `reasoning`. Advised to set both fields to qwen/qwen3.8-27b (vision + reasoning).
