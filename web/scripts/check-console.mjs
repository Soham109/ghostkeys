// Loads each page, scrolls top to bottom and back, and prints every console warning or error. Exit code 1 if any.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const port = 4800 + Math.floor(Math.random() * 100);
const server = spawn(process.execPath, [new URL("./serve.mjs", import.meta.url).pathname, String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 500));
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const paths = (process.argv[2] ?? "/,/pricing/,/guide/,/privacy/,/compatibility/,/faq/").split(",");
let bad = 0;
for (const theme of ["dark", "light"]) {
  for (const path of paths) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
    const msgs = [];
    page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && msgs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
    page.on("pageerror", (e) => msgs.push(`[pageerror] ${e.message}`));
    await page.goto(`http://127.0.0.1:${port}${path}?tier=3`, { waitUntil: "load" });
    await page.waitForTimeout(path === "/" ? 7000 : 1500);
    const H = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < H; y += 600) {
      await page.evaluate((y) => window.__gkScroll?.(y), y);
      await page.waitForTimeout(250);
    }
    await page.evaluate(() => window.__gkScroll?.(0));
    await page.waitForTimeout(800);
    console.log(`${theme} ${path}: ${msgs.length ? msgs.length + " issue(s)" : "clean"}`);
    msgs.forEach((m) => console.log("   ", m));
    bad += msgs.length;
    await page.close();
  }
}
await browser.close();
server.kill();
process.exit(bad ? 1 : 0);
