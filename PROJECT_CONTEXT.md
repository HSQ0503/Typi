# Project Context

_Last analyzed: 2026-04-30_

## Overview
Typi is a Chrome Manifest V3 extension that types user-provided final text into Google Docs with human-like pacing, typos, pauses, and revisions. The popup stores an OpenAI API key locally for the current Chrome user/profile, collects text, asks an OpenAI model to produce a verified typing plan, displays the plan, then sends it to a Google Docs content script that dispatches synthetic keyboard events into Docs' hidden input iframe.

## Tech Stack
- Runtime/language: Plain JavaScript (browser extension service worker, content script, popup script), HTML/CSS
- Frameworks: Chrome Extension Manifest V3
- Package manager: None observed
- Key libraries: Chrome extension APIs (`chrome.runtime`, `chrome.tabs`, `chrome.storage`, `chrome.scripting` permission), browser `fetch`
- Database/storage: `chrome.storage.local` for OpenAI API key, last plan, and recent executor error
- External services: OpenAI Chat Completions API (`gpt-4.1`), Google Docs web UI

## How to Run
```bash
# install
# No package install step is currently required.

# development
# Open Chrome/Chromium -> Extensions -> Developer mode -> Load unpacked -> select this repo root.
# Open a Google Doc, click into the document, open the Typi extension popup, paste your OpenAI API key, click "Set API key for this user", paste final text, then click "Plan & type".

# build
# No build step observed; files are loaded directly by Chrome.

# test/lint/typecheck
node --check background.js
node --check content.js
node --check popup.js
```

## Project Structure
```text
/ - Chrome extension source root and project root
manifest.json - Manifest V3 metadata, permissions, background worker, content script registration
background.js - OpenAI typing-plan generation, JSON schema, plan simulation/verification, runtime message handler
content.js - Google Docs keyboard-event executor for write/pause/typo/revise actions, abort/error handling
popup.html - Extension popup markup and inline styles
popup.js - Popup UI state, plan rendering, Chrome tab/runtime/storage messaging
config.local.example.js - Legacy note; API keys are now set in the popup and stored in chrome.storage.local
config.local.js - Optional local experiment file if created manually; gitignored and not used by default
.gitignore - Ignores local secrets and common generated files
.pi/ - Local Pi/Taskplane metadata; currently untracked in git
PROJECT_CONTEXT.md - This reusable codebase context
```

## Architecture Notes
The extension has three main runtime pieces:

1. Popup UI (`popup.html`, `popup.js`)
   - Accepts and locally stores an OpenAI API key in `chrome.storage.local` for the current Chrome user/profile via the "Set API key for this user" button; paste/change events also attempt to save.
   - Accepts final desired document text.
   - Verifies the active tab is a Google Docs document.
   - Sends `{ type: "PLAN", text }` to the background service worker.
   - Renders returned actions with visual styling for writes, pauses, typos, and revisions.
   - Stores the last `{ text, plan }` under `typi:lastPlan`.
   - Sends `{ type: "EXECUTE_PLAN", plan }` to the content script without waiting for full execution.
   - Provides a Stop button that sends `{ type: "STOP" }` to the content script.

2. Planner service worker (`background.js`)
   - Reads the OpenAI API key from `chrome.storage.local` at request time so the service worker can register without a user-specific config file.
   - Uses a strict JSON schema requiring each action to include all fields (`type`, `text`, `wrong`, `target`, `ms`, `reason`).
   - The system prompt instructs the model to create realistic human typing behavior while ensuring the simulated final buffer exactly equals the user's input, including paragraph newlines. `generatePlan()` injects per-input typo-count guidance based on word count (`MIN_TYPO_RATE`/`MAX_TYPO_RATE`). For revisions, substantial non-prompt-like chunks (`REVISION_WORD_THRESHOLD`, currently 350 words) target roughly one revision per 350-450 words, but revisions are inserted by code after exact plan validation: a separate rough-draft call proposes a less-polished version of an exact final sentence, code swaps that rough draft into the write action, then inserts a revise back to the exact final wording.
   - `simulatePlan()` applies write/typo/revise semantics locally; typos contribute the corrected `text`, and revisions replace the last matching `target` in the current buffer.
   - `diagnosePlan()` reports the first divergence when a generated plan does not match the final text. The main LLM planner is asked to produce exact typo/pause plans with 0 revisions; `ensureRevisionRequirements()` then injects safe verified revisions into substantial chunks using a separate rough-draft call, and `diagnosePlanRequirements()` verifies the required revision count.
   - `generatePlan()` protects large blank-line/section-break runs (`PROTECTED_BLANK_LINES_RE`) as deterministic literal write actions, then splits remaining long text into independent planning chunks when the input exceeds `CHUNKING_WORD_THRESHOLD` (currently 500 words), aiming for `TARGET_PLANNING_CHUNK_WORDS` (currently 425 words) and preferring paragraph/sentence boundaries. Each LLM chunk is wrapped in an `<<<EXACT_CHUNK>>>` block so prompts/questions inside the user's text are treated as literal text rather than instructions. Each LLM chunk gets up to three bounded attempts (`OPENAI_TIMEOUT_MS` is 45 seconds per attempt), is validated independently, then the concatenated plan is validated against the full input. There is no fallback: invalid plans are rejected so the user can inspect debug output rather than silently losing humanization.

3. Google Docs executor (`content.js`)
   - Finds Google Docs' hidden `iframe.docs-texteventtarget-iframe` and dispatches synthetic `KeyboardEvent`s to its active element/body.
   - Maintains its own `buffer` and `cursor` mirror so revise actions can move the cursor, delete old text, type replacements, and return to the end. Longer revision targets are selected with Shift+ArrowLeft and deleted as a block; short targets still use paced Backspace.
   - Implements fast test-mode per-character delays with `MEAN_MS = 20` and `JITTER_MS = 8` (~600 WPM); typo correction backspaces, revision selection, and revision delete operations are still paced because Google Docs can drop synthetic editing keys if fired too quickly after text input.
   - Supports aborting through a shared `aborted` flag and `AbortedError` checked between keystrokes/sleeps.
   - Stores non-abort executor errors in `chrome.storage.local` under `typi:lastError` for popup display.

There is no backend server, build pipeline, database schema, auth flow, or package manifest in the current repo.

## Key Files and Modules
- `manifest.json` - Defines extension identity, activeTab/scripting/storage permissions, host permissions for Google Docs and OpenAI, background service worker, and document content script.
- `background.js` - Most important logic for plan quality; contains action schema, prompt rules, OpenAI API call, retry loop, and final-text verifier.
- `content.js` - Most fragile integration point because it depends on Google Docs DOM internals and synthetic keyboard event behavior.
- `popup.js` - Coordinates API-key storage, user flow, and runtime messages; useful first stop for UI behavior changes.
- `config.local.example.js` - Legacy note; no longer required for normal setup.

## Configuration and Environment
- The OpenAI API key is entered in the popup and stored locally under `typi:openaiApiKey` in `chrome.storage.local` for the current Chrome user/profile.
- Do not commit API keys; `config.local.js` remains ignored if created for experiments, but it is not required.
- OpenAI model is hard-coded as `gpt-4.1` in `background.js`.
- The extension requires host access to `https://docs.google.com/*` and `https://api.openai.com/*`.
- Google Docs execution requires the user to click into the document so the cursor is active before running.
- `.pi/taskplane.json` and `.pi/agents/supervisor.md` are Pi/Taskplane harness metadata, currently untracked; no project-specific coding rules are present there beyond template comments.

## Testing and Quality
- No formal test framework, package scripts, linter, or typechecker are present.
- Basic syntax verification works with:
  ```bash
  node --check background.js
  node --check content.js
  node --check popup.js
  ```
- Planner correctness is guarded at runtime by `simulatePlan()`/`diagnosePlan()` before execution; invalid or timed-out LLM plans are rejected and debug data is logged/stored under `typi:lastPlanningDebug`.
- Manual QA should include loading the unpacked extension, generating a plan for short and multi-paragraph text, confirming final Google Docs output, testing Stop, and testing error display with a missing/invalid API key.
- Current gap: executor behavior is not covered by automated browser/extension tests and may break if Google Docs changes its hidden input iframe or event handling.

## Coding Conventions
- Plain browser JavaScript; manifest currently marks the background service worker as `type: "module"` even though it has no static imports.
- Constants use uppercase names for configuration and storage keys.
- Runtime messages use explicit string `type` values such as `PLAN`, `EXECUTE_PLAN`, and `STOP`.
- Action objects use a uniform shape, with unused fields represented as empty strings or `0` to satisfy the strict OpenAI response schema.
- UI is implemented with direct DOM APIs and inline popup CSS; no framework or bundler.
- Async Chrome message handlers return `true` when responding asynchronously.

## Known Issues / Open Questions
- No README or package metadata exists, so setup instructions are only inferable from code and `config.local.example.js`.
- No automated tests are present for plan generation, popup messaging, or Google Docs execution.
- Google Docs DOM/event internals are an external moving target; `iframe.docs-texteventtarget-iframe` may change.
- OpenAI API key is stored in extension local storage, which is convenient for local development but not a secure vault.
- The OpenAI model, planning timeout, protected whitespace pattern, chunking thresholds, typo/revision rates, and typing speed are hard-coded rather than configurable through the popup or extension options.

## Agent Handoff Notes
- Start with `manifest.json`, then `popup.js`, `background.js`, and `content.js`; the repo is small enough to understand from these files.
- Do not commit API keys or any local `config.local.js` experiment file.
- If changing planner behavior, preserve the invariant that simulated output exactly equals the user's final text before execution.
- If changing executor behavior, test manually in a real Google Doc because synthetic keyboard handling is integration-sensitive; after content script changes, reload the extension and refresh/reopen the Google Doc tab.
- Before claiming code changes are safe, at minimum run the three `node --check` commands above.
