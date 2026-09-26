// Minimal static server for the exported site in out/ (no global installs). Usage: node scripts/serve.mjs [port]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("../out/", import.meta.url).pathname;
const port = Number(process.argv[2] ?? 4317);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".avif": "image/avif", ".woff2": "font/woff2", ".webm": "audio/webm",
  ".mp3": "audio/mpeg", ".txt": "text/plain", ".ico": "image/x-icon",
};
createServer(async (req, res) => {
  try {
    let p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let f = join(root, p);
    const s = await stat(f).catch(() => null);
    if (s?.isDirectory()) f = join(f, "index.html");
    const body = await readFile(f);
    res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`serving out/ on http://127.0.0.1:${port}`));
