# Chrome Web Store Listing Draft

## Extension name

Typi — Human-Paced Typing for Google Docs

## Short description

Type your own drafts into Google Docs with natural pacing, pauses, corrections, and revisions.

## Detailed description

Typi helps play back your own writing into Google Docs with a more natural typing flow. Paste your draft, choose a typing speed, and Typi creates a writing plan with realistic pacing, pauses, typo corrections, and revision-style edits.

Designed for writers, students, researchers, and productivity users who want a smoother way to enter their own drafts into Google Docs.

### Features

- Human-paced typing into Google Docs
- Adjustable words-per-minute speed
- Natural pauses between thoughts and paragraphs
- Realistic typo corrections
- Revision-style edits for a more organic writing flow
- In-document overlay that blocks accidental clicks while Typi is writing
- Stop controls in both the popup and Google Docs overlay
- Local settings storage for API key and typing speed

### Privacy

Typi does not operate its own backend server. Your OpenAI API key, typing speed, recent plan, and job status are stored locally in your Chrome profile. Draft text is sent to OpenAI only when you request a typing plan.

Please review the privacy policy for details.

### Responsible use

Use Typi only with text you own or have permission to submit, publish, or enter into a document. Users are responsible for following applicable academic, workplace, and platform policies.

## Category

Productivity

## Suggested screenshots

1. Popup showing text field, speed slider, and Plan & Type button.
2. Google Docs overlay showing Typi writing progress.
3. Generated plan preview with write, pause, typo, and revise actions.

Recommended screenshot sizes: 1280x800 or 640x400.

## Permission justifications

### storage

Used to store the user's OpenAI API key, typing speed, recent typing plan, job status, and recent error messages locally in Chrome storage.

### activeTab

Used when the user starts a Typi job from the popup to identify and interact with the currently selected Google Docs tab.

### https://docs.google.com/*

Required so Typi can run its content script on Google Docs and type into the document selected by the user.

### https://api.openai.com/*

Required to send the user's draft to OpenAI's API and receive a structured typing plan.

## Avoid using these claims

Do not use these phrases in the public listing or screenshots:

- undetectable
- bypass detection
- avoid getting caught
- cheat
- fake typing
- plagiarism
- AI detector bypass
