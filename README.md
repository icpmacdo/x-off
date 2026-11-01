# X Off

A Chrome extension with two buttons:

- **Quick close.** Closes every X/Twitter tab in every window with one press. You
  have 10 minutes to reopen them from the popup.
- **Quick block.** Closes your X tabs, then blocks x.com and twitter.com for 30 min,
  1 hour, 4 hours, the rest of today, or until you unblock it. A blocked visit shows a
  "X is blocked" page with the time left.

| Shortcut | Does |
| --- | --- |
| <kbd>⌥⇧X</kbd> (Alt+Shift+X) | Close all X tabs |
| <kbd>⌥⇧B</kbd> (Alt+Shift+B) | Block X until you unblock it. Press again to unblock |

The toolbar badge shows how many X tabs are open. While X is blocked, it turns red and
shows the time left (`45m`, `3h`, or `∞`).

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `extension/` folder in this repo. You can also
   drag the folder onto the page.
3. Pin **X Off** from the puzzle-piece menu so the badge is visible.

If another extension already uses a shortcut, Chrome leaves it unassigned. The popup
shows the shortcuts that are actually bound. Change them with **Change shortcuts** in
the popup, or at `chrome://extensions/shortcuts`. To make a shortcut work even when
Chrome isn't the frontmost app, set its scope to **Global** there.

After editing the code, click the reload arrow on the X Off card in `chrome://extensions`.

## How it works

- Matches `x.com`, `twitter.com` and all their subdomains (`mobile.x.com`,
  `mobile.twitter.com`, …). The list is in `extension/sites.js`. `t.co` is not blocked,
  so links that X shortens still open.
- Closing includes pinned X tabs and any open "X is blocked" pages. If X tabs are the
  only tabs left in Chrome, it opens a new tab first so Chrome keeps a window.
- Blocking uses a `declarativeNetRequest` rule that redirects top-level x.com and
  twitter.com navigations to `blocked.html`. As a backstop, a tab that still reaches an
  X URL is redirected, for example through X's in-page navigation or a page its
  service worker served.
- The block is stored in `chrome.storage.local` and the rule is persistent, so the block
  survives a Chrome restart. A timed block lifts itself through `chrome.alarms`. If it
  ran out while Chrome was closed, it's lifted at startup.
- Permissions: access to x.com and twitter.com only, plus storage, alarms and
  declarativeNetRequest. It doesn't read any other site.

It's a speed bump, not a lock. Removing or disabling the extension lifts the block.
Embedded tweets on other sites still show, and incognito isn't covered unless you allow
the extension there.

## Development

```sh
npm install
npm test          # loads the extension into Chromium and runs 18 end-to-end checks
HEADED=1 npm test # same, with the browser visible
npm run icons     # re-render extension/icons/ from design/icon.svg
```

The tests need a Chromium that accepts `--load-extension`. Branded Google Chrome
dropped that flag in v137. `test/chromium.mjs` uses `$CHROME_PATH` if it's set,
otherwise the newest Chrome for Testing build in the Playwright cache. Real X is never
contacted: the test browser resolves X's hostnames to nothing, and the X pages it needs
are faked. Screenshots of the popup and the blocked page go to `test/screens/`.

The keyboard shortcuts themselves can't be pressed from automation. The tests call the
same handlers the shortcuts call (`close` and `toggle`).
