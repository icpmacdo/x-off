import { SITES, URL_PATTERNS, isXUrl } from "./sites.js";
import { badgeLeft, formatClock } from "./format.js";

const RULE_ID = 1;
const EXPIRE_ALARM = "xoff-expire";
const TICK_ALARM = "xoff-tick";
const BLOCKED_PAGE = chrome.runtime.getURL("blocked.html");
const UNDO_WINDOW_MS = 10 * 60 * 1000;

// Every state change runs through one queue, so a shortcut press that wakes the
// service worker can't race the start-up reconcile and leave the rule half-applied.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(() => fn());
  queue = run.catch(() => {});
  return run;
}

// ---- state ---------------------------------------------------------------
// storage.local  block:      { since, until } | null   (until = null means "until I unblock")
// storage.session lastClosed: { at, tabs: [{ url, windowId, index, pinned }] }

async function getBlock() {
  const { block = null } = await chrome.storage.local.get("block");
  return block;
}

const isActive = (block, now = Date.now()) =>
  !!block && (block.until == null || block.until > now);

async function xTabs() {
  return chrome.tabs.query({ url: URL_PATTERNS });
}

async function blockedPageTabIds() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
  return contexts
    .filter((c) => c.tabId >= 0 && c.documentUrl?.startsWith(BLOCKED_PAGE))
    .map((c) => c.tabId);
}

// ---- quick close -----------------------------------------------------------

async function closeXTabs({ remember = true } = {}) {
  const tabs = await xTabs();
  const ids = [...new Set([...tabs.map((t) => t.id), ...(await blockedPageTabIds())])];
  if (!ids.length) return { closed: 0 };

  // If every tab in every normal window is about to go, open a new tab first so
  // Chrome isn't left with no windows.
  const closing = new Set(ids);
  const normal = await chrome.tabs.query({ windowType: "normal" });
  if (normal.length && normal.every((t) => closing.has(t.id))) {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
    await chrome.tabs.create(win ? { windowId: win.id } : {});
  }

  if (remember && tabs.length) {
    await chrome.storage.session.set({
      lastClosed: {
        at: Date.now(),
        tabs: tabs.map((t) => ({
          url: t.url || t.pendingUrl,
          windowId: t.windowId,
          index: t.index,
          pinned: t.pinned,
        })),
      },
    });
  }

  try {
    await chrome.tabs.remove(ids);
  } catch {
    // One of them closed on its own in the meantime; close the rest one by one.
    await Promise.all(ids.map((id) => chrome.tabs.remove(id).catch(() => {})));
  }
  return { closed: ids.length };
}

async function reopen() {
  const { lastClosed } = await chrome.storage.session.get("lastClosed");
  if (!lastClosed?.tabs?.length) return { reopened: 0 };
  if (isActive(await getBlock())) return { reopened: 0, blocked: true };
  await chrome.storage.session.remove("lastClosed");

  const openWindows = new Set((await chrome.windows.getAll()).map((w) => w.id));
  const byWindow = new Map();
  for (const t of lastClosed.tabs) {
    if (!byWindow.has(t.windowId)) byWindow.set(t.windowId, []);
    byWindow.get(t.windowId).push(t);
  }
  for (const [windowId, list] of byWindow) {
    list.sort((a, b) => a.index - b.index);
    if (openWindows.has(windowId)) {
      for (const t of list) {
        await chrome.tabs
          .create({ windowId, index: t.index, url: t.url, pinned: t.pinned, active: false })
          .catch(() => chrome.tabs.create({ url: t.url, active: false }));
      }
    } else {
      // The window closed when its last X tab went; bring it back as a new window.
      const win = await chrome.windows.create({ url: list.map((t) => t.url), focused: false });
      await Promise.all(
        list.map((t, i) =>
          t.pinned && win.tabs?.[i] ? chrome.tabs.update(win.tabs[i].id, { pinned: true }) : null,
        ),
      );
    }
  }
  return { reopened: lastClosed.tabs.length };
}

// ---- quick block -----------------------------------------------------------

function untilFor(duration) {
  if (duration == null || duration === "forever") return null;
  if (duration === "today") {
    const d = new Date();
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }
  const minutes = Number(duration);
  if (!(minutes > 0)) throw new Error(`Bad block duration: ${duration}`);
  return Date.now() + minutes * 60000;
}

async function setRule(on) {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: on
      ? [
          {
            id: RULE_ID,
            priority: 1,
            action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
            condition: { requestDomains: SITES, resourceTypes: ["main_frame"] },
          },
        ]
      : [],
  });
}

async function setAlarms(until) {
  await chrome.alarms.clear(EXPIRE_ALARM);
  await chrome.alarms.clear(TICK_ALARM);
  if (until) {
    await chrome.alarms.create(EXPIRE_ALARM, { when: until });
    await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  }
}

async function block(duration) {
  const until = untilFor(duration);
  await chrome.storage.local.set({ block: { since: Date.now(), until } });
  await setRule(true);
  await setAlarms(until);
  const { closed } = await closeXTabs({ remember: false });
  await refreshBadge();
  return { closed, until };
}

async function unblock() {
  await chrome.storage.local.set({ block: null });
  await setRule(false);
  await setAlarms(null);
  await refreshBadge();
  return {};
}

async function toggle() {
  return isActive(await getBlock()) ? unblock() : block("forever");
}

// Bring the rule, alarms and badge in line with stored state. Runs on every
// service-worker start, so a block that expired while Chrome was closed is lifted.
async function reconcile() {
  const b = await getBlock();
  if (b && !isActive(b)) return unblock();
  await setRule(isActive(b));
  if (b?.until) {
    if (!(await chrome.alarms.get(EXPIRE_ALARM))) await chrome.alarms.create(EXPIRE_ALARM, { when: b.until });
    if (!(await chrome.alarms.get(TICK_ALARM))) await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  } else {
    await setAlarms(null);
  }
  await refreshBadge();
  return {};
}

// ---- badge -----------------------------------------------------------------

async function refreshBadge() {
  const b = await getBlock();
  await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  if (isActive(b)) {
    await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    await chrome.action.setBadgeText({ text: b.until ? badgeLeft(b.until - Date.now()) : "∞" });
    await chrome.action.setTitle({
      title: b.until ? `X Off: X is blocked until ${formatClock(b.until)}` : "X Off: X is blocked until you unblock it",
    });
  } else {
    const n = (await xTabs()).length;
    await chrome.action.setBadgeBackgroundColor({ color: "#5f6368" });
    await chrome.action.setBadgeText({ text: n ? String(n) : "" });
    await chrome.action.setTitle({ title: n ? `X Off: ${n} X tab${n === 1 ? "" : "s"} open` : "X Off" });
  }
}

let badgeTimer;
function scheduleBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => serial(refreshBadge).catch(() => {}), 150);
}

// ---- popup / shortcut API --------------------------------------------------

async function getState() {
  const b = await getBlock();
  const { lastClosed } = await chrome.storage.session.get("lastClosed");
  const recent = lastClosed && Date.now() - lastClosed.at < UNDO_WINDOW_MS;
  return {
    block: isActive(b) ? b : null,
    xTabCount: (await xTabs()).length,
    blockedPageCount: (await blockedPageTabIds()).length,
    undoCount: recent ? lastClosed.tabs.length : 0,
  };
}

const handlers = {
  state: getState,
  close: () => closeXTabs(),
  reopen,
  block: (msg) => block(msg.duration),
  unblock,
  toggle,
  reconcile,
};

function handle(msg) {
  const fn = handlers[msg?.type];
  if (!fn) return Promise.reject(new Error(`Unknown message: ${msg?.type}`));
  return serial(() => fn(msg));
}
globalThis.xoff = { handle }; // used by test/e2e.mjs

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(
    (result) => sendResponse({ ok: true, result }),
    (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
  );
  return true;
});

chrome.commands.onCommand.addListener((command) => {
  const type = { "close-x-tabs": "close", "toggle-block": "toggle" }[command];
  if (type) handle({ type }).catch((e) => console.error("X Off", command, e));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === EXPIRE_ALARM || alarm.name === TICK_ALARM) serial(reconcile).catch(() => {});
});

chrome.tabs.onCreated.addListener(scheduleBadge);
chrome.tabs.onRemoved.addListener(scheduleBadge);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  // Backstop for navigations the network rule doesn't see (X's single-page
  // routing, pages served from X's service worker).
  if (info.url && isXUrl(info.url)) {
    serial(async () => {
      if (isActive(await getBlock())) await chrome.tabs.update(tabId, { url: BLOCKED_PAGE }).catch(() => {});
    });
  }
  if (info.url || info.status) scheduleBadge();
});

serial(reconcile).catch((e) => console.error("X Off reconcile", e));
