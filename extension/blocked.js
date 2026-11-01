import { formatClock, formatLeft } from "./format.js";

const $ = (id) => document.getElementById(id);

async function render() {
  const { block = null } = await chrome.storage.local.get("block");
  const active = !!block && (block.until == null || block.until > Date.now());

  $("title").textContent = active ? "X is blocked" : "X is unblocked";
  document.title = active ? "X is blocked" : "X is unblocked";
  $("goto").hidden = active;
  $("hint").hidden = !active;
  if (!active) $("until").textContent = "";
  else if (block.until) $("until").textContent = `until ${formatClock(block.until)} · ${formatLeft(block.until - Date.now())}`;
  else $("until").textContent = "until you unblock it";
}

$("close").addEventListener("click", async () => {
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id);
});

chrome.commands.getAll().then((commands) => {
  const key = commands.find((c) => c.name === "toggle-block")?.shortcut;
  if (key) $("key").textContent = ` or press ${key}`;
});

chrome.storage.onChanged.addListener((changes) => changes.block && render());
setInterval(render, 30000);
render();
