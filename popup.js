const statusEl = document.getElementById("status");
const textEl = document.getElementById("text");
const apiKeyEl = document.getElementById("apiKey");
const saveKeyEl = document.getElementById("saveKey");
const runEl = document.getElementById("run");
const stopEl = document.getElementById("stop");
const planEl = document.getElementById("plan");
const planHeadingEl = document.getElementById("planHeading");
const wpmEl = document.getElementById("wpm");
const wpmReadoutEl = document.getElementById("wpmReadout");

const PLAN_KEY = "typi:lastPlan";
const API_KEY_STORAGE_KEY = "typi:openaiApiKey";
const PLANNING_DEBUG_KEY = "typi:lastPlanningDebug";
const ERROR_KEY = "typi:lastError";
const WPM_KEY = "typi:wpm";
const DEFAULT_WPM = 150;
const ERROR_TTL_MS = 5 * 60 * 1000;

let lastSavedApiKey = "";

function normalizeLineEndings(text) {
  return text.replace(/\r\n?/g, "\n");
}

function restoreParagraphSpacing(text) {
  const normalized = normalizeLineEndings(text);
  if (/\n[ \t]*\n/.test(normalized)) return normalized;

  // Some sources put visual paragraph breaks on the clipboard as a single newline.
  // Turn sentence-ending single newlines into blank-line paragraph breaks so Docs
  // receives the spacing users saw before pasting into the popup.
  return normalized.replace(/([.!?]["')\]]?)[ \t]*\n[ \t]*(?=["'(\[]?[A-Z0-9])/g, "$1\n\n");
}

function normalizeTextInput({ notify = false } = {}) {
  const current = textEl.value;
  const normalized = restoreParagraphSpacing(current);
  if (normalized !== current) {
    textEl.value = normalized;
    if (notify) showStatus("Restored paragraph spacing from pasted line breaks.");
  }
  return normalized;
}

function el(tag, className, textContent) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (textContent !== undefined) e.textContent = textContent;
  return e;
}

function renderPlan(plan) {
  planEl.innerHTML = "";
  planHeadingEl.textContent = "Plan";
  planHeadingEl.style.display = "block";

  for (const action of plan.actions || []) {
    const div = el("div", `action ${action.type}`);

    if (action.type === "write") {
      div.appendChild(el("span", "label", "write"));
      div.appendChild(el("span", "text", action.text));
    } else if (action.type === "pause") {
      div.appendChild(el("span", "label", "pause"));
      div.appendChild(document.createTextNode(`${action.ms}ms`));
      if (action.reason) div.appendChild(el("span", "reason", `— ${action.reason}`));
    } else if (action.type === "typo") {
      div.appendChild(el("span", "label", "typo"));
      div.appendChild(el("span", "wrong", action.wrong));
      div.appendChild(el("span", "arrow", " → "));
      div.appendChild(el("span", "text", action.text));
      if (action.reason) div.appendChild(el("span", "reason", `— ${action.reason}`));
    } else if (action.type === "revise") {
      div.appendChild(el("span", "label", "revise"));
      div.appendChild(el("span", "target", action.target));
      div.appendChild(el("span", "replacement", action.text));
      if (action.reason) div.appendChild(el("span", "reason", `— ${action.reason}`));
    }

    planEl.appendChild(div);
  }
}

function renderDebug(debug) {
  planEl.innerHTML = "";
  planHeadingEl.textContent = "Planning debug";
  planHeadingEl.style.display = "block";

  const summary = {
    model: debug?.model,
    expectedLength: debug?.expectedLength,
    expectedWords: debug?.expectedWords,
    chunkCount: debug?.chunkCount,
    unitCount: debug?.unitCount,
    protectedLiteralCount: debug?.protectedLiteralCount,
    chunkWordCounts: debug?.chunkWordCounts,
    maxAttempts: debug?.maxAttempts,
    finalError: debug?.finalError,
    finalDiagnosis: debug?.finalDiagnosis,
    chunks: (debug?.chunks || []).map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      type: chunk.type || "llm",
      words: chunk.words,
      expectedLength: chunk.expectedLength,
      ok: chunk.ok,
      attempts: chunk.attempts?.length || 0
    })),
    attempts: (debug?.attempts || []).map((attempt) => ({
      chunkIndex: attempt.chunkIndex,
      attempt: attempt.attempt,
      ok: attempt.ok,
      actionCount: attempt.actionCount,
      injectedRevisionCount: attempt.injectedRevisionCount,
      actionCountAfterRevisionInjection: attempt.actionCountAfterRevisionInjection,
      error: attempt.error,
      diagnosis: attempt.diagnosis,
      textDiagnosis: attempt.textDiagnosis,
      requirementDiagnosis: attempt.requirementDiagnosis,
      nearbyActions: attempt.nearbyActions,
      rawContent: attempt.rawContent
    }))
  };

  planEl.appendChild(el("pre", "debug", JSON.stringify(summary, null, 2)));
}

function showError(message) {
  statusEl.textContent = message;
  statusEl.style.color = "#b00";
}
function showStatus(message) {
  statusEl.textContent = message;
  statusEl.style.color = "";
}

async function saveApiKey({ quiet = false } = {}) {
  const key = apiKeyEl.value.trim();
  if (!key) {
    showError("Paste your OpenAI API key first, then click Set API key for this user.");
    return false;
  }
  await chrome.storage.local.set({ [API_KEY_STORAGE_KEY]: key });
  lastSavedApiKey = key;
  if (!quiet) showStatus("API key saved for this Chrome user/profile.");
  return true;
}

function clampWpm(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_WPM;
  return Math.max(40, Math.min(280, Math.round(n)));
}

function updateWpmReadout(wpm) {
  if (wpmReadoutEl) wpmReadoutEl.textContent = `${wpm} WPM`;
}

chrome.storage.local.get([PLAN_KEY, API_KEY_STORAGE_KEY, PLANNING_DEBUG_KEY, ERROR_KEY, WPM_KEY]).then((res) => {
  const cached = res[PLAN_KEY];
  if (cached?.plan) renderPlan(cached.plan);
  if (cached?.text) textEl.value = cached.text;
  if (res[API_KEY_STORAGE_KEY]) {
    lastSavedApiKey = res[API_KEY_STORAGE_KEY];
    apiKeyEl.value = lastSavedApiKey;
    showStatus("API key is already saved for this Chrome user/profile.");
  }

  const savedWpm = clampWpm(res[WPM_KEY] ?? DEFAULT_WPM);
  if (wpmEl) wpmEl.value = String(savedWpm);
  updateWpmReadout(savedWpm);

  const lastErr = res[ERROR_KEY];
  if (lastErr && Date.now() - lastErr.ts < ERROR_TTL_MS) {
    showError(`Last run errored: ${lastErr.message}`);
  }
});

if (wpmEl) {
  wpmEl.addEventListener("input", () => {
    const v = clampWpm(wpmEl.value);
    updateWpmReadout(v);
  });
  wpmEl.addEventListener("change", () => {
    const v = clampWpm(wpmEl.value);
    updateWpmReadout(v);
    chrome.storage.local.set({ [WPM_KEY]: v }).catch(() => {});
  });
}

saveKeyEl.addEventListener("click", () => {
  saveApiKey().catch((e) => showError(`Save failed: ${e.message}`));
});

apiKeyEl.addEventListener("change", () => {
  if (apiKeyEl.value.trim() && apiKeyEl.value.trim() !== lastSavedApiKey) {
    saveApiKey().catch((e) => showError(`Save failed: ${e.message}`));
  }
});

apiKeyEl.addEventListener("paste", () => {
  setTimeout(() => {
    if (apiKeyEl.value.trim()) {
      saveApiKey().catch((e) => showError(`Save failed: ${e.message}`));
    }
  }, 0);
});

textEl.addEventListener("paste", () => {
  setTimeout(() => normalizeTextInput({ notify: true }), 0);
});

textEl.addEventListener("change", () => {
  normalizeTextInput();
});

stopEl.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "STOP" });
    showStatus("Stopped.");
  } catch (e) {
    showError(`Stop failed: ${e.message}`);
  }
});

runEl.addEventListener("click", async () => {
  const text = normalizeTextInput();
  if (!text.trim()) {
    showStatus("Paste some text first.");
    return;
  }

  if (!(await saveApiKey({ quiet: true }))) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("https://docs.google.com/document/")) {
    showStatus("Open a Google Doc tab first.");
    return;
  }

  runEl.disabled = true;
  showStatus("Planning with gpt-4.1...");
  planEl.innerHTML = "";
  planHeadingEl.style.display = "none";
  chrome.storage.local.remove(ERROR_KEY);

  try {
    const planRes = await chrome.runtime.sendMessage({ type: "PLAN", text });
    if (!planRes?.ok) {
      if (planRes?.debug) renderDebug(planRes.debug);
      throw new Error(planRes?.error || "Plan failed");
    }

    const plan = planRes.plan;
    renderPlan(plan);
    chrome.storage.local.set({ [PLAN_KEY]: { text, plan } });
    showStatus(`Plan ready (${plan.actions.length} actions). Typing — you can close this.`);

    const wpm = clampWpm(wpmEl?.value ?? DEFAULT_WPM);
    chrome.tabs.sendMessage(tab.id, { type: "EXECUTE_PLAN", plan, wpm }).catch(() => {});
  } catch (e) {
    showError(`Error: ${e.message}`);
  } finally {
    runEl.disabled = false;
  }
});
