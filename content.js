// Google Docs uses a canvas renderer. Real keystrokes are captured by a hidden
// iframe (.docs-texteventtarget-iframe). We dispatch synthetic KeyboardEvents
// at that iframe's document so Docs' own handlers process them as user input.

const KEY = {
  Backspace: 8,
  Enter: 13,
  ArrowLeft: 37,
  ArrowRight: 39,
  Delete: 46,
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
  if (typeof target?.focus === "function") target.focus();
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

// >>> TYPING SPEED <<<
// Formula: MEAN_MS = 12000 / WPM  (assuming 5 chars per word)
// MEAN_MS is mutable so the popup can override it via the EXECUTE_PLAN message.
// JITTER_MS scales with mean so spread stays proportional to speed.
const DEFAULT_WPM = 150;
let MEAN_MS = wpmToMeanMs(DEFAULT_WPM);     // ~80ms at 150 WPM
let JITTER_MS = meanToJitter(MEAN_MS);      // ~35ms at 150 WPM

function wpmToMeanMs(wpm) {
  const safe = Math.max(20, Math.min(400, Number(wpm) || DEFAULT_WPM));
  return 12000 / safe;
}
function meanToJitter(meanMs) {
  // ~44% of mean — wide enough to break uniformity without going wild
  return Math.max(8, meanMs * 0.44);
}
function setTypingSpeed(wpm) {
  MEAN_MS = wpmToMeanMs(wpm);
  JITTER_MS = meanToJitter(MEAN_MS);
}

// Google Docs can occasionally drop synthetic editing keys if they are fired
// immediately after typed characters. Keep typo corrections deliberately slower
// than normal text so the misspelling is committed before Backspace events run.
const TYPO_BEFORE_BACKSPACE_MIN_MS = 180;
const TYPO_BEFORE_BACKSPACE_JITTER_MS = 100;
const TYPO_BACKSPACE_MS = 70;
const TYPO_AFTER_BACKSPACE_MIN_MS = 100;
const TYPO_AFTER_BACKSPACE_JITTER_MS = 80;

const REVISION_ARROW_MS = 35;
const REVISION_SELECT_ARROW_MS = 22;
const REVISION_BACKSPACE_MS = 85;
const REVISION_BEFORE_DELETE_MS = 650;
const REVISION_AFTER_SELECT_MS = 250;
const REVISION_AFTER_DELETE_MS = 450;
const REVISION_SELECT_DELETE_THRESHOLD = 30;

// Common bigrams a fluent typist races through, awkward pairs they slow on.
// Values are multipliers applied to the per-key mean.
const BIGRAM_FAST = new Set([
  "th","he","in","er","an","re","on","at","en","nd","ti","es","or","te","of",
  "ed","is","it","al","ar","st","to","nt","ng","se","ha","as","ou","io","le",
  "ve","co","me","de","hi","ri","ro","ic","ne","ea","ra","ce"
]);
const BIGRAM_SLOW = new Set([
  // same-finger / awkward pairings on QWERTY
  "ws","sw","de","ed","ki","ik","ol","lo","mn","nm","bv","vb",
  "qa","az","wx","cr","rc","yu","uy","io","oi","pl","lp","gh","hg","fr","rf",
  // capital-y or punctuation-heavy
  "x ","z ","q ","--",";:",":;"
]);

function gaussianStd() {
  // Box-Muller; clamp to avoid extreme outliers from the tail.
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.max(-3, Math.min(3, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)));
}

function logNormalNoiseMs(stdMs) {
  // log-normal centered on 0 mean shift, with a fat right tail.
  const sigma = 0.45;
  const z = gaussianStd();
  const mult = Math.exp(sigma * z) - 1;  // can be negative (faster) or positive (slower)
  return mult * stdMs;
}

function classOf(ch) {
  if (ch === "\n") return "newline";
  if (ch === " ") return "space";
  if (/[A-Z]/.test(ch)) return "capital";
  if (/[a-z]/.test(ch)) return "letter";
  if (/[0-9]/.test(ch)) return "digit";
  if (/[.!?]/.test(ch)) return "sentence_end";
  if (/[,;:]/.test(ch)) return "comma";
  return "other";
}

const CLASS_MULT = {
  letter: 1.0,
  space: 1.05,
  capital: 1.45,       // shift co-press
  digit: 1.25,
  comma: 1.20,
  sentence_end: 1.30,
  newline: 1.10,
  other: 1.15
};

function bigramAdjust(prev, curr) {
  if (!prev) return 1.0;
  const pair = (prev + curr).toLowerCase();
  if (BIGRAM_FAST.has(pair)) return 0.82;
  if (BIGRAM_SLOW.has(pair)) return 1.30;
  return 1.0;
}

function makeRhythm() {
  return {
    speedFactor: 1.0,     // drifts as a clamped random walk
    prevChar: "",
    prevPrevChar: "",
    charsSincePause: 0,
    wordsSinceDeepPause: 0,
    deepPauseTargetWords: 60 + Math.floor(Math.random() * 120),
    inBurst: false,
    burstRemaining: 0
  };
}

function stepSpeedFactor(rhythm) {
  // small random walk; occasionally enter a fast-burst or slow-spell.
  rhythm.speedFactor += (Math.random() - 0.5) * 0.08;
  if (rhythm.burstRemaining > 0) {
    rhythm.burstRemaining--;
    if (rhythm.burstRemaining === 0) rhythm.inBurst = false;
  } else if (Math.random() < 0.012) {
    rhythm.inBurst = true;
    rhythm.burstRemaining = 4 + Math.floor(Math.random() * 12);
    rhythm.speedFactor *= Math.random() < 0.5 ? 0.75 : 1.35;
  }
  // clamp so things don't run away
  if (rhythm.speedFactor < 0.7) rhythm.speedFactor = 0.7;
  if (rhythm.speedFactor > 1.6) rhythm.speedFactor = 1.6;
}

function charDelayContextual(prev, curr, rhythm) {
  stepSpeedFactor(rhythm);

  const cls = classOf(curr);
  const classMult = CLASS_MULT[cls] ?? 1.0;
  const bigramMult = bigramAdjust(prev, curr);

  // Word-start hesitation: small extra delay starting a fresh word.
  const wordStart = (prev === " " || prev === "\n" || prev === "") ? 1.10 : 1.0;
  // After-punctuation lag (the keystroke AFTER a sentence-end mark).
  const afterPunct = /[.!?]/.test(prev) ? 1.35 : (/[,;:]/.test(prev) ? 1.10 : 1.0);

  let mean = MEAN_MS * classMult * bigramMult * wordStart * afterPunct * rhythm.speedFactor;

  // Log-normal noise for fat right tail.
  let delay = mean + logNormalNoiseMs(JITTER_MS);

  // Rare hesitation events (boosted): a brief 250-900ms freeze.
  let hesitationP = 0.030;
  if (/[.!?]/.test(prev)) hesitationP = 0.10;
  else if (/[,;:]/.test(prev)) hesitationP = 0.06;
  else if (prev === " ") hesitationP = 0.045;
  if (Math.random() < hesitationP) {
    delay += 250 + Math.random() * 650;
  }

  if (delay < 18) delay = 18 + Math.random() * 8;
  return delay;
}

// Mandatory structural pause based on the character that was JUST typed.
// These are not probabilistic — every sentence-end / paragraph break / comma
// gets a pause. Returns 0 when no pause is warranted.
function structuralPauseMs(justTyped, prevPrev) {
  if (justTyped === "\n") {
    // paragraph break (\n\n) gets a much longer pause than a soft line break
    if (prevPrev === "\n") return 1400 + Math.random() * 1700;
    return 350 + Math.random() * 700;
  }
  if (justTyped === ".") return 480 + Math.random() * 850;
  if (justTyped === "!" || justTyped === "?") return 520 + Math.random() * 900;
  if (justTyped === ",") return 95 + Math.random() * 230;
  if (justTyped === ";") return 200 + Math.random() * 320;
  if (justTyped === ":") return 220 + Math.random() * 400;
  if (justTyped === "—" || justTyped === "–") return 280 + Math.random() * 480;
  return 0;
}

// Probabilistic micro-pause within a burst — breaks the "burst is flat" pattern
// at the executor level without needing the LLM to schedule pauses.
function maybeMicroPauseMs(rhythm, prev, curr) {
  rhythm.charsSincePause++;

  // base probability rises with chars since last pause (boosted)
  let p = 0;
  if (rhythm.charsSincePause >= 25) p = 0.04;
  if (rhythm.charsSincePause >= 50) p = 0.10;
  if (rhythm.charsSincePause >= 80) p = 0.20;
  if (rhythm.charsSincePause >= 120) p = 0.35;

  // boost after spaces and punctuation — natural breath points
  if (prev === " ") p *= 1.8;
  if (/[.!?]/.test(prev)) p *= 3.5;
  if (/[,;:]/.test(prev)) p *= 2.2;

  if (Math.random() >= p) return 0;

  rhythm.charsSincePause = 0;
  // log-normal magnitude: typical 200-650ms, occasional ~1400ms
  const base = 260;
  const z = gaussianStd();
  const ms = base * Math.exp(0.65 * z);
  return Math.max(150, Math.min(1500, ms));
}

// Deep "composing the next thought" pause — fires every 60-180 words.
// This mimics the writer stopping to assemble what comes next, which is
// exactly the kind of pause the LLM is supposed to schedule but doesn't.
function maybeDeepThinkingPauseMs(rhythm, justTyped) {
  // count words by counting space-after-non-space transitions
  if (justTyped === " " && rhythm.prevChar !== " " && rhythm.prevChar !== "\n" && rhythm.prevChar !== "") {
    rhythm.wordsSinceDeepPause = (rhythm.wordsSinceDeepPause || 0) + 1;
  }

  const target = rhythm.deepPauseTargetWords || 0;
  if (target === 0) {
    rhythm.deepPauseTargetWords = 60 + Math.floor(Math.random() * 120);
    return 0;
  }
  if ((rhythm.wordsSinceDeepPause || 0) < target) return 0;
  // fire only at a sentence/paragraph boundary so it lands naturally
  if (!/[.!?\n]/.test(justTyped)) return 0;

  rhythm.wordsSinceDeepPause = 0;
  rhythm.deepPauseTargetWords = 60 + Math.floor(Math.random() * 120);

  // log-normal: typical 1500-3500ms, occasionally up to ~6000ms
  const base = 2100;
  const z = gaussianStd();
  const ms = base * Math.exp(0.55 * z);
  return Math.max(1200, Math.min(6000, ms));
}

class Executor {
  constructor(doc) {
    this.doc = doc;
    this.buffer = "";
    this.cursor = 0;
    this.rhythm = makeRhythm();
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
    const prev = this.rhythm.prevChar;
    const prevPrev = this.rhythm.prevPrevChar;
    rawTypeChar(this.doc, ch);
    this.recordInsert(ch);
    const delay = charDelayContextual(prev, ch, this.rhythm);
    this.rhythm.prevPrevChar = prev;
    this.rhythm.prevChar = ch;
    await abortableSleep(delay);

    // Mandatory structural pause after sentence/paragraph/comma boundaries.
    const structural = structuralPauseMs(ch, prev);
    if (structural > 0) {
      this.rhythm.charsSincePause = 0;
      await abortableSleep(structural);
    }

    // Probabilistic micro-pause for general within-burst variability.
    const microPause = maybeMicroPauseMs(this.rhythm, prev, ch);
    if (microPause > 0) await abortableSleep(microPause);

    // Rare deep-thinking pause every 60-180 words.
    const deep = maybeDeepThinkingPauseMs(this.rhythm, ch);
    if (deep > 0) await abortableSleep(deep);
  }

  async typeText(text) {
    for (const ch of text) await this.typeChar(ch);
  }

  async backspace(n, perKeyMs) {
    for (let i = 0; i < n; i++) {
      checkAbort();
      dispatchKey(this.doc, { key: "Backspace", code: "Backspace", keyCode: KEY.Backspace });
      this.recordBackspace();
      const delay = perKeyMs ?? charDelayContextual(this.rhythm.prevChar, "\b", this.rhythm);
      // small jitter on fixed per-key delays so backspace runs aren't perfectly even either
      const jittered = perKeyMs ? perKeyMs * (0.85 + Math.random() * 0.35) : delay;
      await abortableSleep(jittered);
    }
    // after a backspace burst the previous-char context is no longer reliable
    this.rhythm.prevChar = "";
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

  async selectLeft(n, perKeyMs = REVISION_SELECT_ARROW_MS) {
    for (let i = 0; i < n; i++) {
      checkAbort();
      dispatchKey(this.doc, { key: "ArrowLeft", keyCode: KEY.ArrowLeft, shiftKey: true });
      await abortableSleep(perKeyMs);
    }
  }

  async deleteSelection(start, end) {
    checkAbort();
    dispatchKey(this.doc, { key: "Backspace", code: "Backspace", keyCode: KEY.Backspace });
    this.buffer = this.buffer.slice(0, start) + this.buffer.slice(end);
    this.cursor = start;
  }

  async typo(wrong, correct) {
    await this.typeText(wrong);
    await abortableSleep(TYPO_BEFORE_BACKSPACE_MIN_MS + Math.random() * TYPO_BEFORE_BACKSPACE_JITTER_MS);
    await this.backspace(wrong.length, TYPO_BACKSPACE_MS);
    await abortableSleep(TYPO_AFTER_BACKSPACE_MIN_MS + Math.random() * TYPO_AFTER_BACKSPACE_JITTER_MS);
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
      await this.arrow(-1, this.cursor - targetEnd, REVISION_ARROW_MS);
    } else if (this.cursor < targetEnd) {
      await this.arrow(1, targetEnd - this.cursor, REVISION_ARROW_MS);
    }
    await abortableSleep(REVISION_BEFORE_DELETE_MS);

    if (target.length >= REVISION_SELECT_DELETE_THRESHOLD) {
      await this.selectLeft(target.length);
      await abortableSleep(REVISION_AFTER_SELECT_MS);
      await this.deleteSelection(idx, targetEnd);
    } else {
      await this.backspace(target.length, REVISION_BACKSPACE_MS);
    }
    await abortableSleep(REVISION_AFTER_DELETE_MS);

    await this.typeText(replacement);

    const tail = this.buffer.length - this.cursor;
    if (tail > 0) await this.arrow(1, tail, REVISION_ARROW_MS);
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

const ERROR_KEY = "typi:lastError";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "STOP") {
    aborted = true;
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type !== "EXECUTE_PLAN") return;

  chrome.storage.local.remove(ERROR_KEY);
  if (msg.wpm) setTypingSpeed(msg.wpm);

  executePlan(msg.plan)
    .then(() => sendResponse({ ok: true }))
    .catch((e) => {
      const isAbort = e.name === "AbortedError";
      if (!isAbort) {
        console.error("[Typi] Executor error:", e);
        chrome.storage.local.set({
          [ERROR_KEY]: { message: e.message, stack: e.stack || "", ts: Date.now() }
        });
      }
      sendResponse({ ok: isAbort, error: e.message, aborted: isAbort });
    });
  return true;
});
