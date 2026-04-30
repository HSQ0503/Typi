import { OPENAI_API_KEY } from "./config.local.js";

const MODEL = "gpt-4o-mini";
const MAX_PLAN_ATTEMPTS = 2;

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

Frequency: roughly 3-7% of words may have a typo. Don't typo every word — sprinkle them.

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

Use revisions sparingly: 0-2 per essay, only on chunks of ~6+ words. Should feel like a real "wait, I want to change my approach" moment.

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

After all actions are simulated (writes insert text; typos insert their CORRECT text; revises find target in current buffer state and replace with text), the resulting document MUST equal the user's input EXACTLY — every character, space, newline, and punctuation mark. If any of the rules above conflict with this, the correctness rule wins. Plan accordingly.`;

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

async function callOpenAI(messages) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: "typing_plan", strict: true, schema: PLAN_SCHEMA }
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
}

async function generatePlan(text) {
  if (!OPENAI_API_KEY || OPENAI_API_KEY.startsWith("PASTE_")) {
    throw new Error("Set your OpenAI key in config.local.js");
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: text }
  ];

  let lastDiagnosis = null;
  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
    const content = await callOpenAI(messages);
    const plan = JSON.parse(content);
    const diag = diagnosePlan(plan, text);

    if (diag.ok) {
      console.log(`[Typi] Plan verified on attempt ${attempt}.`);
      return plan;
    }

    console.warn(`[Typi] Plan invalid on attempt ${attempt}:\n${diag.message}`);
    lastDiagnosis = diag.message;

    if (attempt < MAX_PLAN_ATTEMPTS) {
      messages.push(
        { role: "assistant", content },
        {
          role: "user",
          content:
            `Your plan does not match the required final text.\n\n${diag.message}\n\n` +
            `Generate a corrected plan. Re-read the typo section of your instructions before responding.`
        }
      );
    }
  }

  throw new Error(`Plan invalid after ${MAX_PLAN_ATTEMPTS} attempts. Last diagnosis: ${lastDiagnosis}`);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "PLAN") return;
  generatePlan(msg.text)
    .then((plan) => sendResponse({ ok: true, plan }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
