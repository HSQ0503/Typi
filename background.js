import { OPENAI_API_KEY } from "./config.local.js";

const MODEL = "gpt-4o-mini";

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

1. "write" — type a chunk of text exactly. text=chunk, wrong="", target="", ms=0, reason="".

2. "pause" — wait. text="", wrong="", target="", ms=duration, reason="brief why".

3. "typo" — type a misspelled version, briefly pause, backspace it, type correctly. text=correct version (what ends up in the doc), wrong=misspelled version typed first, target="", ms=0, reason="kind of typo".

4. "revise" — go back to a previously-typed phrase and rewrite it. text=replacement (what should be there in the final doc), target=EXACT previously-typed text to find and delete, wrong="", ms=0, reason="why revising".

HARD RULES (these must hold or the plan is invalid):

- After all actions are simulated (writes insert text; typos insert their corrected text; revises find target in current document state and replace with text), the resulting document MUST equal the user's input EXACTLY — every character, space, newline, and punctuation mark.
- For "revise": target MUST exactly match a substring that exists in the document at the moment the revise runs. Plan ahead.

REVISIONS — how to plan them:

The user's input is the FINAL essay. To produce realistic revisions, invent a plausible "first draft" for a clause or sentence, write it out, continue with 1-3 more chunks of OTHER content, then emit a revise that targets the first-draft text and replaces it with what's actually in the user's input.

Example. If the user's input is:
  "She loved the lake because it reminded her of summer."

You might plan:
  write "She loved the lake "
  write "because it was peaceful and quiet."   ← invented first draft
  pause 1500 (thinking)
  write " The water was always cold."           ← invented continuation
  pause 2000 (rethinking earlier sentence)
  revise target="because it was peaceful and quiet. The water was always cold." replacement="because it reminded her of summer."

Notice: the revise target is the EXACT concatenation of what was previously typed (including any punctuation and trailing whitespace boundaries). The replacement, combined with everything else written, must build to the final input text.

Use revisions sparingly: 0-2 per essay, only on chunks of ~6+ words. They should feel like genuine "wait, I want to change my approach" moments.

TYPOS:

- ~3-7% of words may have a typo, caught and corrected via the typo action.
- Realistic typo styles: missing letter ("teh"), extra letter ("seperatte"), transposition ("recieve"), adjacent-key slip ("yhe" for "the"), common misspellings ("seperate", "definately", "alot").
- Most typos noticed within the same chunk and corrected immediately. Don't accumulate uncorrected typos — every typo's text field MUST equal the correct word that should appear in the final doc.

PAUSES (insert between actions at natural breakpoints):

- After . ! ? : 800-2000 ms ("end of sentence")
- After , ; : : 200-500 ms ("comma pause")
- Between paragraphs (after \\n\\n): 1500-3000 ms ("paragraph break")
- Mid-clause thinking: 1000-2500 ms ("thinking") — sparingly, 0-2 per paragraph
- Before a revise: 1500-3000 ms ("rethinking earlier sentence")

CHUNK SIZE for "write" actions:

- Each chunk: a clause, short phrase, or sentence. Not a single character. Not a whole paragraph in one shot.
- Don't split words across chunks.
- Aim for 4-15 chunks per paragraph.

Goal: a realistic human typing session — natural rhythm, occasional typos caught and fixed, occasional revisions where the writer changes their mind. Be liberal with typos and pauses; be sparing with revisions.`;

function simulatePlan(actions) {
  let buf = "";
  for (const a of actions) {
    if (a.type === "write") buf += a.text;
    else if (a.type === "typo") buf += a.text;
    else if (a.type === "revise") {
      const idx = buf.lastIndexOf(a.target);
      if (idx === -1) return { ok: false, reason: `revise target not found: "${a.target.slice(0, 40)}..."` };
      buf = buf.slice(0, idx) + a.text + buf.slice(idx + a.target.length);
    }
  }
  return { ok: true, buf };
}

async function generatePlan(text) {
  if (!OPENAI_API_KEY || OPENAI_API_KEY.startsWith("PASTE_")) {
    throw new Error("Set your OpenAI key in config.local.js");
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text }
      ],
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

  const plan = JSON.parse(content);
  const sim = simulatePlan(plan.actions || []);
  if (!sim.ok) {
    console.warn("[Typi] Plan simulation failed:", sim.reason);
  } else if (sim.buf !== text) {
    console.warn("[Typi] Final text mismatch.\nExpected:", text, "\nGot:", sim.buf);
  } else {
    console.log("[Typi] Plan verified — final text matches input.");
  }

  return plan;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "PLAN") return;
  generatePlan(msg.text)
    .then((plan) => sendResponse({ ok: true, plan }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
