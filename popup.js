const statusEl = document.getElementById("status");
const textEl = document.getElementById("text");
const runEl = document.getElementById("run");
const stopEl = document.getElementById("stop");
const planEl = document.getElementById("plan");
const planHeadingEl = document.getElementById("planHeading");

const STORAGE_KEY = "typi:lastPlan";

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

chrome.storage.local.get(STORAGE_KEY).then((res) => {
  const cached = res[STORAGE_KEY];
  if (cached?.plan) renderPlan(cached.plan);
  if (cached?.text) textEl.value = cached.text;
});

stopEl.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "STOP" });
    statusEl.textContent = "Stopped.";
  } catch (e) {
    statusEl.textContent = `Stop failed: ${e.message}`;
  }
});

runEl.addEventListener("click", async () => {
  const text = textEl.value;
  if (!text.trim()) {
    statusEl.textContent = "Paste some text first.";
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("https://docs.google.com/document/")) {
    statusEl.textContent = "Open a Google Doc tab first.";
    return;
  }

  runEl.disabled = true;
  statusEl.textContent = "Planning with gpt-4o-mini...";
  planEl.innerHTML = "";
  planHeadingEl.style.display = "none";

  try {
    const planRes = await chrome.runtime.sendMessage({ type: "PLAN", text });
    if (!planRes?.ok) throw new Error(planRes?.error || "Plan failed");

    const plan = planRes.plan;
    renderPlan(plan);
    chrome.storage.local.set({ [STORAGE_KEY]: { text, plan } });
    statusEl.textContent = `Plan ready (${plan.actions.length} actions). Typing — you can close this.`;

    chrome.tabs.sendMessage(tab.id, { type: "EXECUTE_PLAN", plan }).catch(() => {});
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
  } finally {
    runEl.disabled = false;
  }
});
