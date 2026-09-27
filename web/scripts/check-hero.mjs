// Hero headline must be whole (all lines visible, or the whole block faded) at small scroll offsets, widths and after reload.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const port = 5600 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, [new URL("./serve.mjs", import.meta.url).pathname, String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 500));
const b = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const out = new URL("../screenshots/", import.meta.url).pathname;
let bad = 0;
const probe = (p) =>
  p.evaluate(() => {
    const h1 = document.querySelector("h1");
    const blk = h1.closest(".page-x");
    const op = +getComputedStyle(blk).opacity;
    const lines = [...h1.querySelectorAll(".split-line")];
    const vis = lines.map((l) => {
      const r = l.getBoundingClientRect(), m = l.parentElement.getBoundingClientRect();
      return r.bottom > m.top + 2 && r.top < m.bottom - 2 ? (Math.abs(r.top - m.top) < 3 ? "in" : "part") : "out";
    });
    return { op: +op.toFixed(2), vis: getComputedStyle(h1).visibility, lines: vis };
  });
for (const w of [1280, 1440, 1920, 2560]) {
  const p = await b.newPage({ viewport: { width: w, height: Math.round(w * 0.5625) } });
  await p.goto(`http://127.0.0.1:${port}/?tier=3`);
  await p.waitForTimeout(3500);
  for (const y of [0, 40, 80, 120, 200]) {
    await p.evaluate((y) => window.__gkScroll(y), y);
    await p.waitForTimeout(1500);
    const s = await probe(p);
    const partial = s.op > 0.05 && (s.vis !== "visible" || s.lines.some((l) => l !== "in"));
    if (partial) bad++;
    console.log(w, y, JSON.stringify(s), partial ? "PARTIAL" : "ok");
    if (w === 1440) await p.screenshot({ path: `${out}hero-${w}-y${y}.png` });
  }
  // reload mid-scroll
  await p.evaluate(() => window.__gkScroll(120));
  await p.waitForTimeout(800);
  await p.reload();
  await p.waitForTimeout(3500);
  const s = await probe(p);
  const partial = s.op > 0.05 && (s.vis !== "visible" || s.lines.some((l) => l !== "in"));
  if (partial) bad++;
  console.log(w, "reload@" + (await p.evaluate(() => scrollY)), JSON.stringify(s), partial ? "PARTIAL" : "ok");
  if (w === 1440) await p.screenshot({ path: `${out}hero-${w}-reload.png` });
  await p.close();
}
await b.close();
server.kill();
process.exit(bad ? 1 : 0);
