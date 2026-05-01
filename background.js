const MODEL = "gpt-4.1";
const API_KEY_STORAGE_KEY = "typi:openaiApiKey";
const PLANNING_DEBUG_KEY = "typi:lastPlanningDebug";
const MAX_PLAN_ATTEMPTS = 3;
const OPENAI_TIMEOUT_MS = 45_000;
const CHUNKING_WORD_THRESHOLD = 500;
const TARGET_PLANNING_CHUNK_WORDS = 425;
const MIN_PLANNING_CHUNK_WORDS = 350;
const PROTECTED_BLANK_LINES_RE = /\n{2,}[ \t]*/g;
const MIN_TYPO_RATE = 0.03;
const MAX_TYPO_RATE = 0.06;
const REVISION_WORD_THRESHOLD = 350;

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["write", "pause", "typo", "revise"] },
          text: { type: "string" },
          wrong: { type: "string" },
          target: { type: "string" },
          ms: { type: "number" },
          reason: { type: "string" }
        },
        required: ["type", "text", "wrong", "target", "ms", "reason"],
        additionalProperties: false
      }
    }
  },
  required: ["actions"],
  additionalProperties: false
};

const SYSTEM_PROMPT = `You plan how a human will type the given text into a document, with realistic typos and revisions.

The user gives you the FINAL desired document text. You output a sequence of actions that, when executed, produces exactly that final text — but the typing journey includes natural mistakes and rewrites.

ACTION TYPES (always fill every field; use empty string / 0 for unused fields):

1. "write" — type a chunk of text exactly.
   Fields: text=chunk, wrong="", target="", ms=0, reason="".

2. "pause" — wait between actions.
   Fields: text="", wrong="", target="", ms=duration, reason="brief why".

3. "typo" — type a misspelled word, briefly pause, backspace, then type it correctly. (See dedicated section below.)

4. "revise" — go back to a previously-typed phrase and rewrite it.
   Fields: text=replacement (what should be there in the final doc), target=EXACT previously-typed text to find and delete, wrong="", ms=0, reason="why revising".

==========================================
TYPOS — READ CAREFULLY
==========================================

Field semantics:
  - "wrong" = the MISSPELLED string. Gets typed first, then erased.
  - "text"  = the CORRECT string. Ends up in the final document.

After a typo runs, the document contains exactly the "text" field — NOT "wrong". Getting this mapping reversed will produce the wrong final document.

Hard constraints on every typo action:
  - SCOPE IS EXACTLY ONE WORD. Both "wrong" and "text" must contain NO spaces and NO punctuation. Only the word itself.
  - "wrong" and "text" differ by 1-3 characters — a believable single-word typo.
  - The corrected word appears ONCE in the final document. Adjacent "write" actions must NOT also contain that word, or the word will be duplicated.

Examples — CORRECT usage:
  {"type":"typo","wrong":"teh","text":"the","ms":0,"target":"","reason":"transposition"}
  {"type":"typo","wrong":"recieve","text":"receive","ms":0,"target":"","reason":"common misspelling"}
  {"type":"typo","wrong":"seperate","text":"separate","ms":0,"target":"","reason":"common misspelling"}
  {"type":"typo","wrong":"buisness","text":"business","ms":0,"target":"","reason":"missing letter"}

Examples — WRONG, do not do these:
  ❌ wrong="businesses", text="busniesses" — fields swapped (correct word in wrong, misspelling in text)
  ❌ wrong="euphoria of the first bits of suceess", text="euphoria of the first bits of success" — multi-word scope
  ❌ wrong="separated,", text="separated," — punctuation included; the typo word should be just "separated"

How to compose with neighbors:
  Imagine the sentence "I want to receive the package."
  CORRECT pattern:
    write: "I want to "
    typo:  wrong="recieve", text="receive"
    write: " the package."
  WRONG pattern (would produce "...to receive receive the package..."):
    write: "I want to "
    typo:  wrong="recieve", text="receive"
    write: " receive the package."          ← duplicates the word

Realistic typo styles to use:
  - missing letter: "th"→"the", "buisness"→"business"
  - extra letter: "thee"→"the", "succcess"→"success"
  - transposition: "teh"→"the", "recieve"→"receive"
  - adjacent-key slip: "yhe"→"the"
  - common misspellings: "seperate"→"separate", "definately"→"definitely", "alot"→"a lot" (this last one violates scope, so skip word-splitters)

Frequency: follow the per-input typo-count requirement exactly when provided. Don't typo every word — sprinkle them naturally across the document.

==========================================
REVISIONS — how to plan them
==========================================

The user's input is the FINAL essay. To produce realistic revisions, invent a plausible "first draft" for a clause or sentence, write it out, continue with 1-3 more chunks of OTHER content, then emit a revise that targets the first-draft text and replaces it with what's actually in the user's input.

Example. Final input:
  "She loved the lake because it reminded her of summer."

Plan:
  write "She loved the lake "
  write "because it was peaceful and quiet."   ← invented first draft
  pause 1500 (thinking)
  write " The water was always cold."          ← invented continuation
  pause 2000 (rethinking earlier sentence)
  revise target="because it was peaceful and quiet. The water was always cold." replacement="because it reminded her of summer."

Notice: the revise target is the EXACT concatenation of what was previously typed (preserving punctuation and spacing). Combined with the rest of the plan, this must produce the final input text exactly.

Revision style:
  - Follow the per-input revision-count requirement exactly when provided.
  - A revision must feel like a real idea/style change, not just a typo correction.
  - Good revisions replace a rough first draft with the final sentence/clause from the user's input.
  - For longer essays, revise something from an earlier sentence or previous paragraph after writing 1-3 chunks of later text, then continue from the end.
  - Keep each revise target reasonably short: usually 1 sentence or 1-2 clauses. Avoid revising huge paragraphs.

STRICT REVISION CONTRACT:
  - The revise target MUST be text that was actually typed earlier by one or more write actions, including exact spaces/newlines.
  - The revise text MUST be exact final wording copied from the user's input.
  - The revise text must be the final wording that belongs at the SAME POSITION where the rough target was typed. Do not replace a rough draft with a sentence that belongs later or earlier in the final text.
  - Never write final wording first and then revise it into a rough draft. The rough draft goes in target; final wording goes in text.
  - Do not type final text that should come before the replacement, then revise an earlier rough draft into text that should come after it. This reorders the document and is invalid.
  - Do not change adjacent final text just to make a revision feel natural. If you type a rough phrase like "without truly understanding", that exact rough phrase must be part of a later revise target.
  - Avoid placing revise actions at the final sentence or at paragraph boundaries. Prefer an earlier/middle sentence where the target is easy to find.
  - The target should appear exactly once in the current typed buffer when the revise action runs.

==========================================
PAUSES (insert between actions at natural breakpoints)
==========================================

  - After . ! ? : 800-2000 ms ("end of sentence")
  - After , ; : : 200-500 ms ("comma pause")
  - Between paragraphs (after \\n\\n): 1500-3000 ms ("paragraph break")
  - Mid-clause thinking: 1000-2500 ms ("thinking") — sparingly, 0-2 per paragraph
  - Before a revise: 1500-3000 ms ("rethinking earlier sentence")

==========================================
CHUNK SIZE for "write" actions
==========================================

  - Each chunk: a clause, short phrase, or sentence. Not a single character. Not a whole paragraph.
  - Don't split words across chunks.
  - Aim for 4-15 chunks per paragraph.

==========================================
OVERRIDING CORRECTNESS RULE
==========================================

After all actions are simulated (writes insert text; typos insert their CORRECT text; revises find target in current buffer state and replace with text), the resulting document MUST equal the user's input EXACTLY — every character, space, newline, and punctuation mark. Paragraph breaks are especially important: if the input has a newline, an action must preserve that exact newline. If any of the rules above conflict with this, the correctness rule wins. Plan accordingly.`;

function firstDivergence(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

function simulatePlan(actions) {
  let buf = "";
  for (const a of actions) {
    if (a.type === "write") buf += a.text;
    else if (a.type === "typo") buf += a.text;
    else if (a.type === "revise") {
      const idx = buf.lastIndexOf(a.target);
      if (idx === -1) return { ok: false, reason: `revise target not found in buffer at runtime: "${a.target.slice(0, 60)}..."` };
      buf = buf.slice(0, idx) + a.text + buf.slice(idx + a.target.length);
    }
  }
  return { ok: true, buf };
}

function diagnosePlan(plan, expected) {
  const sim = simulatePlan(plan.actions || []);
  if (!sim.ok) return { ok: false, message: sim.reason };
  if (sim.buf === expected) return { ok: true };

  const idx = firstDivergence(expected, sim.buf);
  const ctxBefore = expected.slice(Math.max(0, idx - 20), idx);
  const expectedAt = expected.slice(idx, idx + 60);
  const actualAt = sim.buf.slice(idx, idx + 60);
  return {
    ok: false,
    index: idx,
    contextBefore: ctxBefore,
    expectedAt,
    actualAt,
    expectedLength: expected.length,
    actualLength: sim.buf.length,
    nearbyActions: actionsAroundFinalIndex(plan.actions || [], idx),
    message:
      `Final text mismatch at character ${idx}.\n` +
      `Context before divergence: ...${JSON.stringify(ctxBefore)}\n` +
      `Expected next: ${JSON.stringify(expectedAt)}\n` +
      `Your plan produced: ${JSON.stringify(actualAt)}\n\n` +
      `Likely causes to check:\n` +
      `1. A typo where "wrong" and "text" are swapped (the misspelled string ended up in "text").\n` +
      `2. A typo that spans multiple words or includes spaces/punctuation.\n` +
      `3. Adjacent write+typo actions both contain the same word, duplicating it.\n` +
      `4. A revise whose target doesn't exist in the buffer at the moment it runs.`
  };
}

function actionsAroundFinalIndex(actions, index, window = 80) {
  let buf = "";
  const nearby = [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (action.type === "write" || action.type === "typo") {
      const inserted = action.type === "write" ? action.text : action.text;
      const start = buf.length;
      buf += inserted;
      const end = buf.length;
      if (index >= start - window && index <= end + window) {
        nearby.push({ index: i, start, end, action });
      }
    } else if (action.type === "revise") {
      const targetIndex = buf.lastIndexOf(action.target);
      if (targetIndex !== -1) {
        const start = targetIndex;
        buf = buf.slice(0, targetIndex) + action.text + buf.slice(targetIndex + action.target.length);
        const end = start + action.text.length;
        if (index >= start - window && index <= end + window) {
          nearby.push({ index: i, start, end, action });
        }
      }
    }
  }

  return nearby.slice(-8);
}

async function getOpenAIKey() {
  const result = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
  const key = (result[API_KEY_STORAGE_KEY] || "").trim();
  if (!key) {
    throw new Error("Set your OpenAI API key in the Typi popup, then try again.");
  }
  return key;
}

async function savePlanningDebug(debug) {
  try {
    await chrome.storage.local.set({ [PLANNING_DEBUG_KEY]: debug });
  } catch (e) {
    console.warn("[Typi] Could not save planning debug info:", e);
  }
}

function logPlanningAttempt(attemptDebug) {
  const status = attemptDebug.ok ? "valid" : "invalid";
  const scope = attemptDebug.chunkIndex === undefined ? "" : ` chunk ${attemptDebug.chunkIndex + 1}`;
  console.groupCollapsed(`[Typi] Planning${scope} attempt ${attemptDebug.attempt} ${status}`);
  console.log("Diagnosis:", attemptDebug.diagnosis || attemptDebug.error || "none");
  console.log("Action count:", attemptDebug.actionCount ?? "n/a");
  if (attemptDebug.nearbyActions?.length) console.log("Actions near mismatch:", attemptDebug.nearbyActions);
  if (attemptDebug.plan) console.log("Parsed plan:", attemptDebug.plan);
  if (attemptDebug.rawContent) console.log("Raw model content:", attemptDebug.rawContent);
  console.groupEnd();
}

async function callOpenAI(messages, schema = PLAN_SCHEMA, schemaName = "typing_plan") {
  const openAIKey = await getOpenAIKey();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openAIKey}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        response_format: {
          type: "json_schema",
          json_schema: { name: schemaName, strict: true, schema }
        }
      })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty response from model");
    return content;
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${Math.round(OPENAI_TIMEOUT_MS / 1000)} seconds`);
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

function countWords(text) {
  return (text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
}

function typoCountRange(text) {
  const words = countWords(text);
  return {
    words,
    min: Math.max(1, Math.ceil(words * MIN_TYPO_RATE)),
    max: Math.max(1, Math.ceil(words * MAX_TYPO_RATE))
  };
}

function typoGuidance(text) {
  const { words, min, max } = typoCountRange(text);
  return `This input has approximately ${words} words. Include between ${min} and ${max} typo actions. ` +
    `Distribute them naturally across the text. A typo action replaces exactly one final word, so preserve all surrounding spaces, articles, punctuation, and newlines in adjacent write actions.`;
}

function isPromptLikeChunk(text) {
  return /\b(please expand|recommended:|limit \d+ words|why did you choose|how are the goals|essays are a great way|how will you contribute)\b/i.test(text);
}

function revisionCountRange(text) {
  const words = countWords(text);
  if (isPromptLikeChunk(text)) return { words, min: 0, max: 0 };
  if (words < REVISION_WORD_THRESHOLD) return { words, min: 0, max: 0 };

  const min = Math.max(1, Math.floor(words / 450));
  const max = Math.max(min, Math.ceil(words / 350));
  return { words, min, max };
}

function revisionGuidance(text) {
  const { words, min, max } = revisionCountRange(text);
  if (min === 0) {
    return `This input has approximately ${words} words. Include 0 revise actions for this chunk; use typo and pause actions only. This avoids fragile revisions in short or prompt-like chunks.`;
  }
  return `This input has approximately ${words} words. Include between ${min} and ${max} revise actions, roughly one revision per 350-450 words. ` +
    `Each revise action should represent a genuine idea/style change, but must follow the strict revision contract. ` +
    `Safe pattern: choose an exact final sentence/clause from the chunk, type a rough-draft version IN THAT SAME POSITION instead of the final wording, type 1-3 later final-text chunks, then revise that exact rough-draft target into the exact final wording for that same position. ` +
    `Do not replace a rough draft with a sentence that belongs later in the chunk; that reorders the final text. ` +
    `Do not put revisions at the final sentence, do not revise across paragraph boundaries, and do not leave any rough-draft wording outside the revise target. ` +
    `Do not stop after a revise unless that revise replacement reaches the exact end of this chunk; if more final text remains after the revised passage, continue writing it. ` +
    `Preserve exact final output after simulation. Keep revise targets short enough for reliable cursor movement, usually one sentence or one/two clauses.`;
}

function planningGuidance(text) {
  return `${typoGuidance(text)}\n${revisionGuidance(text)}`;
}

function basePlanningGuidance(text) {
  return `${typoGuidance(text)}\nInclude 0 revise actions in this main plan. Revisions are inserted by a separate verified pass after the exact typo/pause plan is valid.`;
}

function diagnosePlanRequirements(plan, text) {
  const actions = plan.actions || [];
  const reviseCount = actions.filter((action) => action.type === "revise").length;
  const reviseRange = revisionCountRange(text);

  if (reviseCount < reviseRange.min || reviseCount > reviseRange.max) {
    return {
      ok: false,
      message:
        `Revision count ${reviseCount} is outside the required range ` +
        `${reviseRange.min}-${reviseRange.max} for this ${reviseRange.words}-word chunk. ` +
        `Add genuine revise actions that follow the strict revision contract while preserving exact final text.`
    };
  }

  return { ok: true };
}

function splitByProtectedBlankLines(text) {
  const units = [];
  let lastIndex = 0;

  for (const match of text.matchAll(PROTECTED_BLANK_LINES_RE)) {
    if (match.index > lastIndex) {
      units.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }
    units.push({ type: "literal", text: match[0] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    units.push({ type: "text", text: text.slice(lastIndex) });
  }

  return units.filter((unit) => unit.text.length > 0);
}

function splitIntoPlanningChunks(text) {
  if (countWords(text) <= CHUNKING_WORD_THRESHOLD) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const remaining = text.slice(start);
    if (countWords(remaining) <= TARGET_PLANNING_CHUNK_WORDS) {
      chunks.push(remaining);
      break;
    }

    let bestEnd = -1;
    for (let i = start; i < text.length; i++) {
      let candidateEnd = -1;
      const ch = text[i];

      if (ch === "\n") {
        // Prefer putting whitespace/newlines at the start of the next chunk.
        // Models are more likely to preserve leading whitespace than invisible trailing whitespace.
        candidateEnd = i;
      } else if ((ch === "." || ch === "!" || ch === "?") && (i + 1 >= text.length || /\s/.test(text[i + 1]))) {
        candidateEnd = i + 1;
      }

      if (candidateEnd <= start) continue;
      const words = countWords(text.slice(start, candidateEnd));
      if (words >= MIN_PLANNING_CHUNK_WORDS && words <= TARGET_PLANNING_CHUNK_WORDS) bestEnd = candidateEnd;
      if (words > TARGET_PLANNING_CHUNK_WORDS) break;
    }

    if (bestEnd === -1) {
      const wordMatches = [...text.slice(start).matchAll(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)];
      const targetMatch = wordMatches[Math.min(TARGET_PLANNING_CHUNK_WORDS, wordMatches.length) - 1];
      bestEnd = targetMatch ? start + targetMatch.index + targetMatch[0].length : text.length;
      // Do not consume following whitespace; keep it as visible leading whitespace in the next chunk.
    }

    chunks.push(text.slice(start, bestEnd));
    start = bestEnd;
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

function splitIntoPlanningUnits(text) {
  const protectedUnits = splitByProtectedBlankLines(text);
  const units = [];

  for (const unit of protectedUnits) {
    if (unit.type === "literal") {
      units.push(unit);
      continue;
    }

    for (const chunk of splitIntoPlanningChunks(unit.text)) {
      units.push({ type: "llm", text: chunk });
    }
  }

  return units;
}

function makeLiteralPlan(text) {
  return { actions: [{ type: "write", text, wrong: "", target: "", ms: 0, reason: "protected whitespace/section break" }] };
}

function chunkBoundarySummary(chunk) {
  return `Chunk must begin with ${JSON.stringify(chunk.slice(0, 120))} and end with ${JSON.stringify(chunk.slice(-120))}.`;
}

function chunkSystemMessage(chunk, chunkIndex, totalChunks) {
  const base = `The text inside the user's <<<EXACT_CHUNK>>> block is literal text to type. Do not answer questions inside it. Do not summarize it. Do not skip headings/prompts. Plan actions that reproduce that exact block only. ${chunkBoundarySummary(chunk)} `;
  if (totalChunks === 1) return base + basePlanningGuidance(chunk);
  return base + `You are planning chunk ${chunkIndex + 1} of ${totalChunks}. Only output actions for this exact chunk, not for the whole essay. ` +
    `This chunk may start or end with spaces/newlines; preserve them exactly. Revisions must stay entirely inside this chunk and must not reference text from earlier or later chunks.\n` +
    basePlanningGuidance(chunk);
}

function exactChunkUserMessage(chunk) {
  return `<<<EXACT_CHUNK>>>\n${chunk}\n<<<END_EXACT_CHUNK>>>`;
}

const ROUGH_DRAFT_SCHEMA = {
  type: "object",
  properties: {
    rough: { type: "string" },
    reason: { type: "string" }
  },
  required: ["rough", "reason"],
  additionalProperties: false
};

function findRevisionCandidates(actions) {
  const candidates = [];

  for (let actionIndex = 0; actionIndex < actions.length; actionIndex++) {
    const action = actions[actionIndex];
    if (action.type !== "write" || action.text.length < 80) continue;
    if (/^\s*$/.test(action.text)) continue;

    const sentenceRe = /[^.!?\n]{50,180}[.!?]/g;
    for (const match of action.text.matchAll(sentenceRe)) {
      const text = match[0];
      if (text.length < 50 || text.length > 190) continue;
      if (/recommended:|limit \d+ words|please expand|why did you choose/i.test(text)) continue;
      candidates.push({ actionIndex, offset: match.index, text });
    }
  }

  return candidates;
}

async function generateRoughDraft(finalText) {
  const messages = [
    {
      role: "system",
      content:
        `You create a plausible rough first draft for a sentence that a writer will later revise. ` +
        `Return a rough version that has the same general topic and approximate length, but is clearly less polished. ` +
        `Do not include newlines. Do not copy the final sentence exactly.`
    },
    { role: "user", content: finalText }
  ];
  const content = await callOpenAI(messages, ROUGH_DRAFT_SCHEMA, "rough_draft_revision");
  const draft = JSON.parse(content);
  return { rough: draft.rough.trim(), reason: draft.reason || "revising rough draft into final wording" };
}

async function injectOneSafeRevision(plan, chunk, usedTargets = new Set()) {
  const candidates = findRevisionCandidates(plan.actions || [])
    .filter((candidate) => !usedTargets.has(candidate.text));

  for (const candidate of candidates) {
    const { rough, reason } = await generateRoughDraft(candidate.text);
    if (!rough || rough === candidate.text || rough.includes("\n")) continue;

    const actions = (plan.actions || []).map((action) => ({ ...action }));
    const action = actions[candidate.actionIndex];
    if (!action?.text?.includes(candidate.text)) continue;

    action.text =
      action.text.slice(0, candidate.offset) +
      rough +
      action.text.slice(candidate.offset + candidate.text.length);

    const insertAt = Math.min(actions.length, candidate.actionIndex + 4);
    actions.splice(
      insertAt,
      0,
      { type: "pause", text: "", wrong: "", target: "", ms: 1600, reason: "rethinking earlier wording" },
      { type: "revise", text: candidate.text, wrong: "", target: rough, ms: 0, reason }
    );

    const revisedPlan = { actions };
    const diag = diagnosePlan(revisedPlan, chunk);
    if (diag.ok) {
      usedTargets.add(candidate.text);
      return revisedPlan;
    }
  }

  throw new Error("Could not inject a safe revision into this chunk");
}

async function ensureRevisionRequirements(plan, chunk, attemptDebug) {
  const range = revisionCountRange(chunk);
  let revisedPlan = plan;
  const usedTargets = new Set();

  while ((revisedPlan.actions || []).filter((action) => action.type === "revise").length < range.min) {
    revisedPlan = await injectOneSafeRevision(revisedPlan, chunk, usedTargets);
  }

  if (attemptDebug) {
    attemptDebug.injectedRevisionCount = (revisedPlan.actions || []).filter((action) => action.type === "revise").length;
  }
  return revisedPlan;
}

async function planChunk(chunk, { chunkIndex, totalChunks, globalStart, debug }) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: chunkSystemMessage(chunk, chunkIndex, totalChunks) },
    { role: "user", content: exactChunkUserMessage(chunk) }
  ];
  const chunkDebug = {
    chunkIndex,
    totalChunks,
    globalStart,
    expectedLength: chunk.length,
    words: countWords(chunk),
    attempts: [],
    ok: false
  };
  debug.chunks.push(chunkDebug);

  let lastDiagnosis = null;
  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
    const attemptDebug = { chunkIndex, attempt, ok: false, startedAt: new Date().toISOString() };
    chunkDebug.attempts.push(attemptDebug);
    debug.attempts.push(attemptDebug);
    let content = "";

    try {
      content = await callOpenAI(messages);
      attemptDebug.rawContent = content;

      const plan = JSON.parse(content);
      attemptDebug.plan = plan;
      attemptDebug.actionCount = plan.actions?.length ?? 0;

      const textDiag = diagnosePlan(plan, chunk);
      let finalPlan = plan;
      let reqDiag = { ok: true };
      let finalTextDiag = textDiag;

      if (textDiag.ok) {
        finalPlan = await ensureRevisionRequirements(plan, chunk, attemptDebug);
        finalTextDiag = diagnosePlan(finalPlan, chunk);
        reqDiag = finalTextDiag.ok ? diagnosePlanRequirements(finalPlan, chunk) : { ok: true };
      }

      const diag = finalTextDiag.ok && !reqDiag.ok ? reqDiag : finalTextDiag;
      attemptDebug.diagnosis = diag;
      attemptDebug.textDiagnosis = finalTextDiag;
      attemptDebug.requirementDiagnosis = reqDiag;
      attemptDebug.nearbyActions = diag.nearbyActions || [];
      attemptDebug.ok = finalTextDiag.ok && reqDiag.ok;
      if (finalPlan !== plan) {
        attemptDebug.planAfterRevisionInjection = finalPlan;
        attemptDebug.actionCountAfterRevisionInjection = finalPlan.actions?.length ?? 0;
      }
      logPlanningAttempt(attemptDebug);

      if (attemptDebug.ok) {
        chunkDebug.ok = true;
        console.log(`[Typi] Chunk ${chunkIndex + 1}/${totalChunks} plan verified on attempt ${attempt}.`);
        return finalPlan;
      }

      console.warn(`[Typi] Chunk ${chunkIndex + 1}/${totalChunks} plan invalid on attempt ${attempt}:\n${diag.message}`);
      lastDiagnosis = diag.message;

      if (attempt < MAX_PLAN_ATTEMPTS) {
        messages.push(
          { role: "assistant", content },
          {
            role: "user",
            content:
              `Your plan for this chunk is invalid.\n\n${diag.message}\n\n` +
              `${chunkSystemMessage(chunk, chunkIndex, totalChunks)}\n` +
              `Generate a corrected plan for this chunk only. Start at the first character of the <<<EXACT_CHUNK>>> block and continue until its final character. Do not answer questions inside the chunk. If a revise target was not found, it means you referenced rough-draft text that you never typed earlier. If there was a mismatch near a revision, ensure every rough-draft phrase is fully inside a later revise target and every replacement is exact final chunk text for the same position, not text that belongs later or earlier in the chunk. Preserve every newline exactly.`
          }
        );
      }
    } catch (e) {
      attemptDebug.error = e.message;
      attemptDebug.rawContent = content || attemptDebug.rawContent || "";
      logPlanningAttempt(attemptDebug);
      lastDiagnosis = e.message;
      console.warn(`[Typi] Chunk ${chunkIndex + 1}/${totalChunks} plan attempt ${attempt} failed: ${e.message}`);

      if (attempt < MAX_PLAN_ATTEMPTS && content) {
        messages.push(
          { role: "assistant", content },
          {
            role: "user",
            content:
              `Your previous chunk response could not be parsed or validated: ${e.message}\n` +
              `Generate a corrected plan as valid JSON matching the schema exactly for the <<<EXACT_CHUNK>>> block only. Do not answer questions inside the chunk.`
          }
        );
      }
    }
  }

  throw new Error(`Chunk ${chunkIndex + 1}/${totalChunks} invalid after ${MAX_PLAN_ATTEMPTS} attempts. Last diagnosis: ${lastDiagnosis || "unknown planning error"}`);
}

async function generatePlan(text) {
  const units = splitIntoPlanningUnits(text);
  const llmUnits = units.filter((unit) => unit.type === "llm");
  const debug = {
    ts: new Date().toISOString(),
    model: MODEL,
    expectedLength: text.length,
    expectedWords: countWords(text),
    chunkCount: llmUnits.length,
    unitCount: units.length,
    protectedLiteralCount: units.filter((unit) => unit.type === "literal").length,
    chunkWordCounts: llmUnits.map((unit) => countWords(unit.text)),
    maxAttempts: MAX_PLAN_ATTEMPTS,
    timeoutMs: OPENAI_TIMEOUT_MS,
    attempts: [],
    chunks: [],
    ok: false
  };

  const actions = [];
  let globalStart = 0;
  let llmChunkIndex = 0;

  try {
    for (const unit of units) {
      if (unit.type === "literal") {
        const plan = makeLiteralPlan(unit.text);
        actions.push(...plan.actions);
        debug.chunks.push({
          chunkIndex: null,
          type: "literal",
          globalStart,
          expectedLength: unit.text.length,
          words: 0,
          attempts: [],
          ok: true
        });
        globalStart += unit.text.length;
        continue;
      }

      const plan = await planChunk(unit.text, {
        chunkIndex: llmChunkIndex,
        totalChunks: llmUnits.length,
        globalStart,
        debug
      });
      actions.push(...(plan.actions || []));
      globalStart += unit.text.length;
      llmChunkIndex++;
    }

    const combinedPlan = { actions };
    const finalDiag = diagnosePlan(combinedPlan, text);
    debug.finalDiagnosis = finalDiag;
    if (!finalDiag.ok) {
      throw new Error(`Combined chunk plan mismatch: ${finalDiag.message}`);
    }

    debug.ok = true;
    await savePlanningDebug(debug);
    console.log(`[Typi] Full plan verified across ${llmUnits.length} LLM chunk(s), ${units.length} total unit(s), ${actions.length} actions.`);
    return combinedPlan;
  } catch (e) {
    debug.finalError = e.message;
    await savePlanningDebug(debug);
    e.debug = debug;
    throw e;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "PLAN") return;
  generatePlan(msg.text)
    .then((plan) => sendResponse({ ok: true, plan }))
    .catch((e) => sendResponse({ ok: false, error: e.message, debug: e.debug || null }));
  return true;
});
