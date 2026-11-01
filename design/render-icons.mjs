// Renders design/icon.svg to the PNG sizes Chrome wants, using Playwright's Chromium.
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromiumPath } from "../test/chromium.mjs";

const root = path.resolve(import.meta.dirname, "..");
const svg = await readFile(path.join(root, "design/icon.svg"), "utf8");
const browser = await chromium.launch({ executablePath: chromiumPath() });
for (const size of [16, 32, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await page.screenshot({ path: path.join(root, `extension/icons/icon${size}.png`), omitBackground: true });
  await page.close();
}
await browser.close();
console.log("icons written to extension/icons/");
