// Render selected frames to out/frames/*.png with one bundle.
// usage: node scripts/stills.mjs [CompositionId] frame frame ...
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const id = args[0] && isNaN(Number(args[0])) ? args.shift() : "GhostkeysPromo";
const frames = args.length ? args.map(Number) : [20, 90, 124, 200, 300, 380, 440, 500, 560, 620, 700, 860, 1000, 1350, 1460, 1650, 1900, 2000];
const outDir = path.join(root, "out/frames");
fs.mkdirSync(outDir, { recursive: true });

const serveUrl = await bundle({ entryPoint: path.join(root, "src/index.ts"), webpackOverride: (c) => c });
const chromiumOptions = { gl: "angle" };
const composition = await selectComposition({ serveUrl, id, chromiumOptions });
for (const frame of frames) {
  const output = path.join(outDir, `${id === "GhostkeysPromo" ? "f" : "t"}${String(frame).padStart(4, "0")}.png`);
  const t0 = Date.now();
  await renderStill({ serveUrl, composition, frame, output, chromiumOptions, timeoutInMilliseconds: 120000 });
  console.log(`frame ${frame} -> ${path.relative(root, output)} (${Date.now() - t0} ms)`);
}
