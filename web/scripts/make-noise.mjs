// Generates a 64x64 high-passed noise tile (a cheap blue-noise approximation) for gradient dithering.
import sharp from "sharp";
const N = 64;
const w = new Float32Array(N * N).map(() => Math.random());
const out = Buffer.alloc(N * N);
for (let y = 0; y < N; y++)
  for (let x = 0; x < N; x++) {
    let s = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) s += w[((y + dy + N) % N) * N + ((x + dx + N) % N)];
    const hp = w[y * N + x] - s / 9;
    out[y * N + x] = Math.max(0, Math.min(255, Math.round(128 + hp * 300)));
  }
await sharp(out, { raw: { width: N, height: N, channels: 1 } }).png().toFile(new URL("../public/noise.png", import.meta.url).pathname);
console.log("wrote public/noise.png");
