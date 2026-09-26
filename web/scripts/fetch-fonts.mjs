// Downloads the self-hosted fonts (Fontshare, ITF Free Font License) into app/fonts. Run once; files are committed.
import { writeFile, mkdir } from "node:fs/promises";
const want = process.argv.slice(2).length ? process.argv.slice(2) : ["zodiak@300,301,400,401", "switzer@300,400,500", "boska@400,401", "gambarino@400", "satoshi@400,500", "general-sans@400,500"];
const dir = new URL("../app/fonts/", import.meta.url).pathname;
await mkdir(dir, { recursive: true });
for (const spec of want) {
  const css = await (await fetch(`https://api.fontshare.com/v2/css?f[]=${spec}&display=swap`)).text();
  const re = /font-family: '([^']+)';\s*src: url\('([^']+\.woff2)'\)[^;]*;\s*font-weight: (\d+);[^}]*font-style: (\w+);/g;
  let m;
  while ((m = re.exec(css))) {
    const [, fam, url, w, st] = m;
    const name = `${fam.replace(/\s+/g, "")}-${w}${st === "italic" ? "i" : ""}.woff2`;
    const buf = Buffer.from(await (await fetch("https:" + url)).arrayBuffer());
    await writeFile(dir + name, buf);
    console.log(name, buf.length);
  }
}
