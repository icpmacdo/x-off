// Finds a Chromium that can load unpacked extensions from the command line.
// Branded Google Chrome dropped --load-extension in v137, so this needs Chrome for
// Testing or Chromium. Order: $CHROME_PATH, newest cached Playwright Chromium,
// then Playwright's own default.
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function chromiumPath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return undefined;
  const builds = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const b of builds) {
    for (const rel of [
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-linux64/chrome",
      "chrome-linux/chrome",
    ]) {
      const p = path.join(cache, b, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}
