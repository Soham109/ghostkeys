// Rasterizes the Ghostkeys mark (docs/design/logo.svg geometry) into the tray template images and
// the app icon, with no image dependencies: signed distance fields + supersampling + a tiny PNG encoder.
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const out = new URL('../resources/', import.meta.url).pathname
mkdirSync(out, { recursive: true })

// ---- PNG encoder (RGBA8)
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---- SDF primitives in logo units (viewBox 0..128)
function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2
  const cy = y + h / 2
  const qx = Math.abs(px - cx) - (w / 2 - r)
  const qy = Math.abs(py - cy) - (h / 2 - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r
const stroke = (d, width) => Math.abs(d) - width / 2

/** Coverage of each logo layer at a point in logo units. */
function layers(px, py, strokeW) {
  return {
    ghost: stroke(sdRoundRect(px, py, 36, 28, 64, 64, 16), strokeW) <= 0 ? 1 : 0,
    front: stroke(sdRoundRect(px, py, 28, 36, 64, 64, 16), strokeW) <= 0 ? 1 : 0,
    dot: sdCircle(px, py, 60, 68, 7) <= 0 ? 1 : 0
  }
}

function render(size, { pad, strokeW, paint }) {
  const buf = Buffer.alloc(size * size * 4)
  const SS = 4
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0]
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size
          const v = (y + (sy + 0.5) / SS) / size
          const c = paint(u, v, pad, strokeW)
          // premultiplied accumulate
          acc[0] += c[0] * c[3]
          acc[1] += c[1] * c[3]
          acc[2] += c[2] * c[3]
          acc[3] += c[3]
        }
      }
      const n = SS * SS
      const a = acc[3] / n
      const i = (y * size + x) * 4
      buf[i] = a ? Math.round(acc[0] / n / a) : 0
      buf[i + 1] = a ? Math.round(acc[1] / n / a) : 0
      buf[i + 2] = a ? Math.round(acc[2] / n / a) : 0
      buf[i + 3] = Math.round(a * 255)
    }
  }
  return png(size, size, buf)
}

// Logo bbox is 28..100 in both axes (72 units) -> center it.
const toLogo = (u, v, pad) => {
  const span = 72 / (1 - 2 * pad)
  return [64 - span / 2 + u * span, 64 - span / 2 + v * span]
}

// ---- Tray template: black + alpha, ghost at 35%.
function trayPaint(u, v, pad, strokeW) {
  const [px, py] = toLogo(u, v, pad)
  const l = layers(px, py, strokeW)
  const a = Math.max(l.front, l.dot, l.ghost * 0.4)
  return [0, 0, 0, a]
}
for (const [size, name] of [
  [18, 'trayTemplate.png'],
  [36, 'trayTemplate@2x.png']
]) {
  writeFileSync(out + name, render(size, { pad: 0.06, strokeW: size <= 18 ? 11 : 9, paint: trayPaint }))
}

// ---- App icon: macOS squircle, graphite with soft top light, ink mark, signal dot.
function superellipse(u, v) {
  // Icon body occupies 824/1024 centered (Apple grid), n = 5.
  const s = 824 / 1024
  const x = (u - 0.5) / (s / 2)
  const y = (v - 0.5) / (s / 2)
  return Math.pow(Math.abs(x), 5) + Math.pow(Math.abs(y), 5) <= 1
}
function iconPaint(u, v, pad, strokeW) {
  if (!superellipse(u, v)) return [0, 0, 0, 0]
  // graphite body with a soft radial light from the top
  const d = Math.hypot(u - 0.5, (v - 0.18) * 1.2)
  const light = Math.max(0, 1 - d / 0.75)
  const base = 12 + light * light * 26
  let c = [base, base, base + 1, 1]
  const [px, py] = toLogo(u, v, pad)
  const l = layers(px, py, strokeW)
  if (l.ghost) c = mix(c, [237, 237, 239], 0.3)
  if (l.front) c = [237, 237, 239, 1]
  if (l.dot) c = [255, 91, 31, 1]
  return c
}
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 1]
writeFileSync(out + 'icon.png', render(1024, { pad: 0.27, strokeW: 6.5, paint: iconPaint }))
console.log('icons written to', out)
