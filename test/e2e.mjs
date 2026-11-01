// End-to-end test: loads the unpacked extension into Chromium and drives the
// popup, the blocked page and the service worker.
//
//   npm test            headless
//   HEADED=1 npm test   watch it run
//
// Nothing reaches the real X: its hostnames resolve to nowhere in the test
// browser. X pages that should load are faked with Playwright routing; in the
// block checks routing is off, so the extension's rule is what stops the
// navigation. Tabs are counted from chrome.tabs (what the extension sees),
// because tabs the extension opens itself can show up in Playwright as error
// pages.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromiumPath } from "./chromium.mjs";
import { isXUrl } from "../extension/sites.js";

const EXT = path.resolve(import.meta.dirname, "../extension");
const SHOTS = path.resolve(import.meta.dirname, "screens");
mkdirSync(SHOTS, { recursive: true });
const userDataDir = mkdtempSync(path.join(os.tmpdir(), "x-off-test-"));

let ctx;
let id;
let passed = 0;

async function launch() {
  ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromiumPath(),
    headless: !process.env.HEADED,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--host-resolver-rules=MAP x.com ~NOTFOUND, MAP *.x.com ~NOTFOUND, MAP twitter.com ~NOTFOUND, MAP *.twitter.com ~NOTFOUND",
    ],
    viewport: { width: 1000, height: 700 },
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
  id = new URL(sw.url()).host;
}

async function worker() {
  return ctx.serviceWorkers()[0] || ctx.waitForEvent("serviceworker", { timeout: 10000 });
}
const inWorker = async (fn, arg) => (await worker()).evaluate(fn, arg);
const handle = (msg) => inWorker((m) => self.xoff.handle(m), msg);
const badge = () => inWorker(() => chrome.action.getBadgeText({}));
const badgeColor = () => inWorker(() => chrome.action.getBadgeBackgroundColor({}));
const rules = () => inWorker(() => chrome.declarativeNetRequest.getDynamicRules());
const storedBlock = () => inWorker(async () => (await chrome.storage.local.get("block")).block ?? null);
const tabs = () =>
  inWorker(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url || t.pendingUrl || "" })));
const xTabUrls = async () => (await tabs()).map((t) => t.url).filter(isXUrl);
const xTabCount = async () => (await xTabUrls()).length;
const BLOCKED = () => `chrome-extension://${id}/blocked.html`;
const isBlockedPage = (p) => p.url().startsWith(BLOCKED());
const RED = [217, 48, 37, 255];

async function waitFor(fn, label, timeout = 8000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for: ${label} (last: ${last})`);
}

async function step(name, fn) {
  process.stdout.write(`- ${name} … `);
  await fn();
  passed++;
  console.log("ok");
}

const fakeX = (route) =>
  route.fulfill({ contentType: "text/html", body: "<title>fake x</title><h1>fake x page</h1>" });
const routeX = () => ctx.route((url) => isXUrl(url.href), fakeX);
const unrouteX = () => ctx.unrouteAll({ behavior: "ignoreErrors" });

async function openX(url) {
  const p = await ctx.newPage();
  await p.goto(url, { waitUntil: "commit" }).catch(() => {});
  return p;
}

async function openPopup(colorScheme = "light") {
  const p = await ctx.newPage();
  await p.emulateMedia({ colorScheme });
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.locator("#status:not(:text('…'))").waitFor();
  return p;
}

async function expectBlockedNav(url) {
  const p = await ctx.newPage();
  await p.goto(url).catch(() => {});
  await waitFor(() => isBlockedPage(p), `${url} → blocked page (at ${p.url()})`);
  return p;
}

try {
  await launch();
  console.log(`Chromium: ${chromiumPath() ?? "playwright default"}\nextension id: ${id}\n`);

  // ---------------------------------------------------------------- quick close
  await routeX();
  await step("badge counts open X tabs", async () => {
    await openX("https://x.com/home");
    await openX("https://twitter.com/jack");
    await openX("https://mobile.x.com/explore");
    await waitFor(async () => (await badge()) === "3", 'badge "3"');
  });

  let popup;
  await step("popup shows the count", async () => {
    popup = await openPopup("light");
    assert.equal(await popup.locator("#close-label").textContent(), "Close all X tabs (3)");
    assert.equal(await popup.locator("#status").textContent(), "3 tabs open");
    await popup.locator("body").screenshot({ path: path.join(SHOTS, "popup-light.png") });
    await popup.emulateMedia({ colorScheme: "dark" });
    await popup.locator("body").screenshot({ path: path.join(SHOTS, "popup-dark.png") });
    await popup.emulateMedia({ colorScheme: "light" });
  });

  await step("Close all X tabs closes every X tab and nothing else", async () => {
    const others = (await tabs()).filter((t) => !isXUrl(t.url)).map((t) => t.id).sort();
    await popup.click("#close");
    await waitFor(async () => (await xTabCount()) === 0, "no X tabs left");
    assert.deepEqual((await tabs()).map((t) => t.id).sort(), others, "non-X tabs untouched");
    await waitFor(async () => (await badge()) === "", "badge cleared");
    await waitFor(async () => !(await popup.locator("#undo").isHidden()), "undo row shown");
    assert.equal(await popup.locator("#undo-text").textContent(), "Closed 3 tabs.");
    await popup.locator("body").screenshot({ path: path.join(SHOTS, "popup-after-close.png") });
  });

  await step("Reopen brings the closed tabs back", async () => {
    await popup.click("#reopen");
    await waitFor(async () => (await xTabCount()) === 3, "3 X tabs back");
    assert.deepEqual((await xTabUrls()).sort(), [
      "https://mobile.x.com/explore",
      "https://twitter.com/jack",
      "https://x.com/home",
    ]);
  });

  await step("closing when only X tabs are open keeps one new tab", async () => {
    const others = (await tabs()).filter((t) => !isXUrl(t.url)).map((t) => t.id);
    await inWorker((ids) => chrome.tabs.remove(ids), others);
    await waitFor(async () => (await tabs()).length === 3, "only the 3 X tabs open");
    const r = await handle({ type: "close" });
    assert.equal(r.closed, 3);
    await waitFor(async () => (await xTabCount()) === 0 && (await tabs()).length === 1, "exactly one non-X tab left");
  });

  // ---------------------------------------------------------------- quick block
  await step("Block 1 hour: closes X tabs, adds the rule, badge shows time", async () => {
    await openX("https://x.com/home");
    await unrouteX();
    popup = await openPopup("light");
    const before = Date.now();
    await popup.click('[data-duration="60"]');
    await waitFor(async () => (await xTabCount()) === 0, "X tab closed by block");
    const b = await storedBlock();
    assert.ok(Math.abs(b.until - (before + 60 * 60000)) < 5000, "until ≈ now + 60 min");
    const r = await rules();
    assert.equal(r.length, 1);
    assert.equal(r[0].action.type, "redirect");
    assert.equal(await badge(), "1h");
    assert.deepEqual(await badgeColor(), RED);
    await waitFor(async () => !(await popup.locator("#block-on").isHidden()), "popup blocked view");
    assert.match(await popup.locator("#block-until").textContent(), /^X is blocked until /);
    assert.match(await popup.locator("#block-left").textContent(), /^(1 h left|60 min left)$/);
    await popup.locator("body").screenshot({ path: path.join(SHOTS, "popup-blocked.png") });
    await popup.emulateMedia({ colorScheme: "dark" });
    await popup.locator("body").screenshot({ path: path.join(SHOTS, "popup-blocked-dark.png") });
  });

  let blockedTab;
  await step("typed navigations to x.com / twitter.com / subdomains are redirected", async () => {
    blockedTab = await expectBlockedNav("https://x.com/home");
    await expectBlockedNav("https://twitter.com/someone/status/1");
    await expectBlockedNav("https://mobile.twitter.com/");
    await expectBlockedNav("http://www.x.com/explore");
  });

  await step("link clicks from another site are redirected", async () => {
    await ctx.route("https://example.org/**", (r) =>
      r.fulfill({ contentType: "text/html", body: '<a id="go" href="https://x.com/someone">x link</a>' }),
    );
    const p = await ctx.newPage();
    await p.goto("https://example.org/");
    await p.click("#go");
    await waitFor(() => isBlockedPage(p), `link click → blocked page (at ${p.url()})`);
    await ctx.unroute("https://example.org/**");
  });

  await step("blocked page explains the block", async () => {
    await blockedTab.bringToFront();
    await blockedTab.locator("#until:not(:empty)").waitFor();
    assert.equal(await blockedTab.locator("h1").textContent(), "X is blocked");
    assert.match(await blockedTab.locator("#until").textContent(), /^until .+ · (1 h left|60 min left)$/);
    await blockedTab.screenshot({ path: path.join(SHOTS, "blocked-page.png") });
  });

  await step("backstop: an X page that slips past the rule is still redirected", async () => {
    await inWorker(() => chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1] }));
    await routeX(); // let the X page load, as if X's own service worker had served it
    const p = await ctx.newPage();
    await p.goto("https://x.com/slipped-through").catch(() => {});
    await waitFor(() => isBlockedPage(p), `backstop redirect (at ${p.url()})`);
    await unrouteX();
    await handle({ type: "reconcile" });
    assert.equal((await rules()).length, 1, "reconcile restores the rule");
  });

  await step("Close all X tabs also closes blocked-page tabs", async () => {
    const n = ctx.pages().filter(isBlockedPage).length;
    assert.ok(n >= 5);
    const r = await handle({ type: "close" });
    assert.equal(r.closed, n);
    await waitFor(() => ctx.pages().filter(isBlockedPage).length === 0, "blocked pages closed");
  });

  await step("Unblock lifts the rule and the blocked page notices", async () => {
    const leftover = await expectBlockedNav("https://x.com/home");
    await popup.bringToFront();
    await popup.click("#unblock");
    await waitFor(async () => (await rules()).length === 0, "rule removed");
    assert.equal(await storedBlock(), null);
    assert.notDeepEqual(await badgeColor(), RED);
    await waitFor(async () => (await leftover.locator("h1").textContent()) === "X is unblocked", "page says unblocked");
    assert.ok(await leftover.locator("#goto").isVisible());
    await routeX();
    const p = await openX("https://x.com/home");
    await p.waitForLoadState();
    assert.equal(p.url(), "https://x.com/home", "x.com loads again");
    await p.close();
    await leftover.close();
    await unrouteX();
  });

  await step("toggle (the ⌥⇧B handler) blocks until unblocked, then unblocks", async () => {
    await routeX();
    await openX("https://twitter.com/home");
    await unrouteX();
    await handle({ type: "toggle" });
    assert.equal((await storedBlock()).until, null);
    assert.equal(await badge(), "∞");
    await waitFor(async () => (await xTabCount()) === 0, "toggle closed X tab");
    await expectBlockedNav("https://x.com/");
    await handle({ type: "toggle" });
    assert.equal(await storedBlock(), null);
    assert.equal((await rules()).length, 0);
    await handle({ type: "close" });
  });

  await step("close (the ⌥⇧X handler) with nothing open is a no-op", async () => {
    const before = ctx.pages().length;
    assert.equal((await handle({ type: "close" })).closed, 0);
    assert.equal(ctx.pages().length, before);
  });

  await step("Rest of today ends at local midnight", async () => {
    const r = await handle({ type: "block", duration: "today" });
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    assert.equal(r.until, midnight.getTime());
    await handle({ type: "unblock" });
  });

  await step("a timed block expires on its own", async () => {
    await handle({ type: "block", duration: 0.05 }); // 3 seconds
    assert.equal((await rules()).length, 1);
    await waitFor(async () => (await storedBlock()) === null && (await rules()).length === 0, "block expired", 20000);
    assert.notDeepEqual(await badgeColor(), RED);
  });

  await step("a block survives a browser restart", async () => {
    await handle({ type: "block", duration: "forever" });
    await ctx.close();
    await launch();
    await expectBlockedNav("https://x.com/home");
    assert.equal(await badge(), "∞");
    await handle({ type: "unblock" });
  });

  await step("an expired block is lifted at startup", async () => {
    await inWorker(() => chrome.storage.local.set({ block: { since: Date.now() - 7200000, until: Date.now() - 1000 } }));
    await inWorker(() => chrome.alarms.clearAll());
    await ctx.close();
    await launch();
    await waitFor(async () => (await storedBlock()) === null && (await rules()).length === 0, "lifted on startup");
  });

  console.log(`\n${passed} checks passed. Screenshots in test/screens/`);
} catch (e) {
  console.log("FAILED");
  console.error(e);
  process.exitCode = 1;
} finally {
  await ctx?.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
}
