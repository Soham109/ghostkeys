// Verifies the no-WebGL fallback: WebGL disabled in the browser, and a forced tier 0 on a normal GPU.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const port = 5500 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, [new URL("./serve.mjs", import.meta.url).pathname, String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 500));
const out = new URL("../screenshots/", import.meta.url).pathname;
const runs = [
  { name: "fallback-nowebgl", args: ["--disable-webgl", "--disable-webgl2", "--disable-3d-apis"], q: "" },
  { name: "fallback-tier0", args: ["--use-angle=metal", "--enable-gpu"], q: "?tier=0" },
];
for (const r of runs) {
  const b = await chromium.launch({ args: r.args });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const msgs = [];
  p.on("console", (m) => (m.type() === "error" || m.type() === "warning") && msgs.push(m.text()));
  p.on("pageerror", (e) => msgs.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/${r.q}`);
  await p.waitForTimeout(3000);
  const state = await p.evaluate(() => ({ canvases: document.querySelectorAll("canvas").length, stills: [...document.querySelectorAll("img")].filter((i) => i.src.includes("/stills/") && i.complete && i.naturalWidth > 0).length, webgl2: !!document.createElement("canvas").getContext("webgl2") }));
  await p.screenshot({ path: `${out}${r.name}-hero.png` });
  const y = await p.evaluate(() => { const el = document.querySelector('[data-chapter="air"]'); return el.getBoundingClientRect().top + scrollY + (el.offsetHeight - innerHeight) * 0.3; });
  await p.evaluate((y) => window.__gkScroll(y), y);
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${out}${r.name}-air.png` });
  console.log(r.name, JSON.stringify(state), msgs.length ? msgs.slice(0, 5) : "no console issues");
  await b.close();
}
server.kill();
