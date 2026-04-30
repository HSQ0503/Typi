const statusEl = document.getElementById("status");
const textEl = document.getElementById("text");
const runEl = document.getElementById("run");
const stopEl = document.getElementById("stop");
const planEl = document.getElementById("plan");
const planHeadingEl = document.getElementById("planHeading");

const PLAN_KEY = "typi:lastPlan";
const ERROR_KEY = "typi:lastError";
const ERROR_TTL_MS = 5 * 60 * 1000;

function el(tag, className, textContent) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (textContent !== undefined) e.textContent = textContent;
  return e;
}

function renderPlan(plan) {
  planEl.innerHTML = "";
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

function showError(message) {
  statusEl.textContent = message;
  statusEl.style.color = "#b00";
}
function showStatus(message) {
  statusEl.textContent = message;
  statusEl.style.color = "";
}

chrome.storage.local.get([PLAN_KEY, ERROR_KEY]).then((res) => {
  const cached = res[PLAN_KEY];
  if (cached?.plan) renderPlan(cached.plan);
  if (cached?.text) textEl.value = cached.text;

  const lastErr = res[ERROR_KEY];
  if (lastErr && Date.now() - lastErr.ts < ERROR_TTL_MS) {
    showError(`Last run errored: ${lastErr.message}`);
  }
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
  const text = textEl.value;
  if (!text.trim()) {
    showStatus("Paste some text first.");
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("https://docs.google.com/document/")) {
    showStatus("Open a Google Doc tab first.");
    return;
  }

  runEl.disabled = true;
  showStatus("Planning with gpt-4o-mini...");
  planEl.innerHTML = "";
  planHeadingEl.style.display = "none";
  chrome.storage.local.remove(ERROR_KEY);

  try {
    const planRes = await chrome.runtime.sendMessage({ type: "PLAN", text });
    if (!planRes?.ok) throw new Error(planRes?.error || "Plan failed");

    const plan = planRes.plan;
    renderPlan(plan);
    chrome.storage.local.set({ [PLAN_KEY]: { text, plan } });
    showStatus(`Plan ready (${plan.actions.length} actions). Typing — you can close this.`);

    chrome.tabs.sendMessage(tab.id, { type: "EXECUTE_PLAN", plan }).catch(() => {});
  } catch (e) {
    showError(`Error: ${e.message}`);
  } finally {
    runEl.disabled = false;
  }
});
