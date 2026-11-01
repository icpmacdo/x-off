import { formatClock, formatLeft } from "./format.js";

const $ = (id) => document.getElementById(id);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error || "No response from X Off");
  return res.result;
}

let busy = false;
let lastCloseResult = null;

async function render() {
  const s = await send({ type: "state" });
  const closable = s.xTabCount + s.blockedPageCount;

  const status = $("status");
  status.classList.toggle("blocked", !!s.block);
  status.textContent = s.block ? "Blocked" : s.xTabCount ? `${plural(s.xTabCount, "tab")} open` : "No tabs open";

  $("close").disabled = busy || closable === 0;
  $("close-label").textContent = closable ? `Close all X tabs (${closable})` : "No X tabs open";

  const showUndo = !s.block && s.undoCount > 0;
  $("undo").hidden = !showUndo && !lastCloseResult;
  if (showUndo) {
    $("undo-text").textContent = `Closed ${plural(s.undoCount, "tab")}.`;
    $("reopen").hidden = false;
  } else if (lastCloseResult) {
    $("undo-text").textContent = lastCloseResult;
    $("reopen").hidden = true;
  }

  $("block-off").hidden = !!s.block;
  $("block-on").hidden = !s.block;
  if (s.block) {
    if (s.block.until) {
      $("block-until").textContent = `X is blocked until ${formatClock(s.block.until)}`;
      $("block-left").textContent = formatLeft(s.block.until - Date.now());
    } else {
      $("block-until").textContent = "X is blocked until you unblock it";
      $("block-left").textContent = "";
    }
  }
  for (const b of document.querySelectorAll("[data-duration], #unblock")) b.disabled = busy;
}

async function act(msg, after) {
  busy = true;
  try {
    const result = await send(msg);
    after?.(result);
  } catch (e) {
    lastCloseResult = `Something went wrong: ${e.message}`;
  } finally {
    busy = false;
    await render();
  }
}

$("close").addEventListener("click", () =>
  act({ type: "close" }, (r) => {
    lastCloseResult = r.closed ? null : "Nothing to close.";
  }),
);
$("reopen").addEventListener("click", () =>
  act({ type: "reopen" }, (r) => {
    lastCloseResult = r.reopened ? `Reopened ${plural(r.reopened, "tab")}.` : null;
  }),
);
for (const b of document.querySelectorAll("[data-duration]")) {
  b.addEventListener("click", () => act({ type: "block", duration: b.dataset.duration }, () => (lastCloseResult = null)));
}
$("unblock").addEventListener("click", () => act({ type: "unblock" }));
$("shortcuts").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

// Show the shortcuts that are actually bound (the user may have changed them).
chrome.commands.getAll().then((commands) => {
  const key = (name) => commands.find((c) => c.name === name)?.shortcut || "";
  $("close-key").textContent = key("close-x-tabs");
  $("block-key").textContent = key("toggle-block");
});

chrome.storage.onChanged.addListener(() => render());
chrome.tabs.onRemoved.addListener(() => render());
chrome.tabs.onUpdated.addListener((_id, info) => info.url && render());
setInterval(render, 15000);
render();
