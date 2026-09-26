// Scrolls the landing with real wheel input (so Lenis smoothing runs) and records every frame's duration.
// Writes a summary to screenshots/perf.txt and a Chromium trace to screenshots/perf-trace.json.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const port = 4900 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, [new URL("./serve.mjs", import.meta.url).pathname, String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 500));
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const W = Number(process.env.W ?? 1440), H = Number(process.env.H ?? 900);
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: Number(process.env.DPR ?? 2) });
await page.goto(`http://127.0.0.1:${port}/?tier=3`, { waitUntil: "load" });
await page.waitForTimeout(8000);
await page.mouse.move(W / 2, H / 2);
await browser.startTracing(page, { path: new URL("../screenshots/perf-trace.json", import.meta.url).pathname, screenshots: false });
await page.evaluate(() => {
  window.__frames = [];
  let last = performance.now();
  const loop = (t) => {
    window.__frames.push(t - last);
    last = t;
    if (!window.__stop) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});
const total = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
let y = 0;
while (y < total) {
  await page.mouse.wheel(0, 120);
  y += 120;
  await page.waitForTimeout(16);
}
await page.waitForTimeout(1500);
for (let i = 0; i < 60; i++) {
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(16);
}
await page.waitForTimeout(1000);
const frames = await page.evaluate(() => {
  window.__stop = true;
  return window.__frames.slice(5);
});
await browser.stopTracing();
const sorted = [...frames].sort((a, b) => a - b);
const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const over = (ms) => frames.filter((f) => f > ms).length;
const dpr = await page.evaluate(() => devicePixelRatio);
const summary = [
  `Ghostkeys landing scroll performance (${new Date().toISOString()})`,
  `Viewport ${W}x${H} at devicePixelRatio ${dpr}, headless Chromium, ANGLE on Metal, Apple M5 Pro`,
  `Frames measured: ${frames.length}`,
  `Average frame: ${avg.toFixed(2)} ms (${(1000 / avg).toFixed(1)} fps)`,
  `Median: ${pct(0.5).toFixed(2)} ms, p95: ${pct(0.95).toFixed(2)} ms, p99: ${pct(0.99).toFixed(2)} ms, worst: ${sorted[sorted.length - 1].toFixed(2)} ms`,
  `Frames over 20 ms: ${over(20)} (${((over(20) / frames.length) * 100).toFixed(1)}%), over 33 ms: ${over(33)}`,
].join("\n");
writeFileSync(new URL("../screenshots/perf.txt", import.meta.url).pathname, summary + "\n");
console.log(summary);
await browser.close();
server.kill();
