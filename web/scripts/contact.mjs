// Tiles screenshots into a contact sheet: node scripts/contact.mjs out.png cols file1 file2 ...
import sharp from "sharp";
const [out, colsArg, ...files] = process.argv.slice(2);
const cols = Number(colsArg), W = 720, H = 450;
const rows = Math.ceil(files.length / cols);
const tiles = await Promise.all(files.map((f) => sharp(f).resize(W, H, { fit: "cover", position: "top" }).toBuffer()));
await sharp({ create: { width: cols * W, height: rows * H, channels: 3, background: "#222" } })
  .composite(tiles.map((t, i) => ({ input: t, left: (i % cols) * W, top: Math.floor(i / cols) * H })))
  .png().toFile(out);
