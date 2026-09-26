// Screenshots a local HTML file, one image per 900px panel. Usage: node scripts/specimen-shot.mjs file.html outPrefix
import { chromium } from "playwright";
const [file, prefix] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("file://" + file);
await p.waitForTimeout(600);
const n = await p.evaluate(() => document.querySelectorAll(".p").length);
for (let i = 0; i < n; i++) await p.screenshot({ path: `${prefix}${i + 1}.png`, clip: { x: 0, y: i * 900, width: 1440, height: 900 }, fullPage: true });
await b.close();
