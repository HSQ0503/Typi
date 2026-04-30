// Google Docs uses a canvas renderer. Real keystrokes are captured by a hidden
// iframe (.docs-texteventtarget-iframe). We dispatch synthetic KeyboardEvents
// at that iframe's document so Docs' own handlers process them as user input.

const KEY = {
  Backspace: 8,
  Enter: 13,
  ArrowLeft: 37,
  ArrowRight: 39,
};

function getDocsTarget() {
  const iframe = document.querySelector("iframe.docs-texteventtarget-iframe");
  if (!iframe) throw new Error("Docs input iframe not found — is the doc fully loaded?");
  const doc = iframe.contentDocument;
  if (!doc) throw new Error("Cannot access iframe document.");
  return doc;
}

function dispatchKey(doc, { key, code, keyCode, char, shiftKey }) {
  const target = doc.activeElement || doc.body;
  const common = {
    key, code: code || key, keyCode, which: keyCode,
    shiftKey: !!shiftKey, bubbles: true, cancelable: true
  };
  target.dispatchEvent(new KeyboardEvent("keydown", common));
  if (char !== undefined) {
    target.dispatchEvent(new KeyboardEvent("keypress", { ...common, charCode: char.charCodeAt(0) }));
  }
  target.dispatchEvent(new KeyboardEvent("keyup", common));
}

function rawTypeChar(doc, ch) {
  if (ch === "\n") {
    dispatchKey(doc, { key: "Enter", keyCode: KEY.Enter });
    return;
  }
  const keyCode = ch.toUpperCase().charCodeAt(0);
  const code =
    /[a-zA-Z]/.test(ch) ? `Key${ch.toUpperCase()}` :
    /[0-9]/.test(ch) ? `Digit${ch}` :
    ch === " " ? "Space" : undefined;
  dispatchKey(doc, { key: ch, code, keyCode, char: ch });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// >>> TYPING SPEED — edit MEAN_MS to change WPM <<<
// 200 WPM ≈ 60ms/char. 100 WPM ≈ 120ms. 60 WPM ≈ 200ms.
// Formula: MEAN_MS = 12000 / WPM  (assuming 5 chars per word)
// JITTER_MS adds approx-normal variance around the mean.
const MEAN_MS = 60;     // 200 WPM
const JITTER_MS = 24;   // ~40% of mean feels natural

function charDelay() {
  const r = (Math.random() + Math.random() - 1);
  return Math.max(20, MEAN_MS + r * JITTER_MS);
}

class Executor {
  constructor(doc) {
    this.doc = doc;
    this.buffer = "";
    this.cursor = 0;
  }

  recordInsert(text) {
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
  }
  recordBackspace() {
    if (this.cursor === 0) return;
    this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
    this.cursor--;
  }
  recordArrow(dir) {
    this.cursor = Math.max(0, Math.min(this.buffer.length, this.cursor + dir));
  }

  async typeChar(ch) {
    checkAbort();
    rawTypeChar(this.doc, ch);
    this.recordInsert(ch);
    await abortableSleep(charDelay());
  }

  async typeText(text) {
    for (const ch of text) await this.typeChar(ch);
  }

  async backspace(n, perKeyMs) {
    for (let i = 0; i < n; i++) {
      checkAbort();
      dispatchKey(this.doc, { key: "Backspace", keyCode: KEY.Backspace });
      this.recordBackspace();
      await abortableSleep(perKeyMs ?? charDelay());
    }
  }

  async arrow(dir, n, perKeyMs = 18) {
    const key = dir < 0 ? "ArrowLeft" : "ArrowRight";
    const keyCode = dir < 0 ? KEY.ArrowLeft : KEY.ArrowRight;
    for (let i = 0; i < n; i++) {
      checkAbort();
      dispatchKey(this.doc, { key, keyCode });
      this.recordArrow(dir);
      await abortableSleep(perKeyMs);
    }
  }

  async typo(wrong, correct) {
    await this.typeText(wrong);
    await abortableSleep(150 + Math.random() * 250);
    await this.backspace(wrong.length);
    await abortableSleep(80 + Math.random() * 120);
    await this.typeText(correct);
  }

  async revise(target, replacement) {
    const idx = this.buffer.lastIndexOf(target);
    if (idx === -1) {
      console.warn("[Typi] revise target not found in buffer:", target);
      return;
    }
    const targetEnd = idx + target.length;

    if (this.cursor > targetEnd) {
      await this.arrow(-1, this.cursor - targetEnd);
    } else if (this.cursor < targetEnd) {
      await this.arrow(1, targetEnd - this.cursor);
    }
    await abortableSleep(400);

    await this.backspace(target.length, 30);
    await abortableSleep(300);

    await this.typeText(replacement);

    const tail = this.buffer.length - this.cursor;
    if (tail > 0) await this.arrow(1, tail);
  }
}

let aborted = false;

class AbortedError extends Error {
  constructor() { super("Aborted by user"); this.name = "AbortedError"; }
}

function checkAbort() {
  if (aborted) throw new AbortedError();
}

async function abortableSleep(ms) {
  const step = 50;
  let remaining = ms;
  while (remaining > 0) {
    checkAbort();
    const chunk = Math.min(step, remaining);
    await sleep(chunk);
    remaining -= chunk;
  }
}

async function executePlan(plan) {
  aborted = false;
  const doc = getDocsTarget();
  const exec = new Executor(doc);
  for (const action of plan.actions || []) {
    checkAbort();
    if (action.type === "write") {
      await exec.typeText(action.text);
    } else if (action.type === "pause") {
      await abortableSleep(Math.max(0, action.ms || 0));
    } else if (action.type === "typo") {
      await exec.typo(action.wrong, action.text);
    } else if (action.type === "revise") {
      await exec.revise(action.target, action.text);
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "STOP") {
    aborted = true;
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type !== "EXECUTE_PLAN") return;
  executePlan(msg.plan)
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: e.name === "AbortedError", error: e.message, aborted: e.name === "AbortedError" }));
  return true;
});
