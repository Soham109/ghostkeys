// Real wheel input: single notches must never spring back; plus the Download sheet opens.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const port = 5700 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, [new URL("./serve.mjs", import.meta.url).pathname, String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 500));
const b = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(`http://127.0.0.1:${port}/?tier=3`);
await p.waitForTimeout(4000);
await p.mouse.move(720, 450);
let bad = 0;
const y = () => p.evaluate(() => Math.round(scrollY));
for (let i = 0; i < 10; i++) {
  const before = await y();
  await p.mouse.wheel(0, 100);
  await p.waitForTimeout(1600);
  const after = await y();
  if (after <= before) bad++;
  console.log("down notch", before, "->", after, after > before ? "ok" : "SPRANG BACK");
}
const max = await p.evaluate(() => document.documentElement.scrollHeight - innerHeight);
await p.evaluate((m) => window.__gkScroll(m), max);
await p.waitForTimeout(1500);
for (let i = 0; i < 4; i++) {
  const before = await y();
  await p.mouse.wheel(0, -100);
  await p.waitForTimeout(1600);
  const after = await y();
  if (after >= before) bad++;
  console.log("up notch", before, "->", after, after < before ? "ok" : "SPRANG BACK");
}
await p.evaluate(() => window.__gkScroll(0));
await p.waitForTimeout(1500);
await p.click("nav a.btn-ink");
await p.waitForTimeout(600);
const open = await p.evaluate(() => !!document.querySelector("dialog[open]"));
console.log("sheet opens:", open, "url:", p.url());
await p.screenshot({ path: new URL("../screenshots/get-sheet.png", import.meta.url).pathname });
await b.close();
server.kill();
process.exit(bad || !open ? 1 : 0);
