# Ghostkeys website

Marketing site for Ghostkeys. A short scroll film over one persistent WebGL canvas, plus five quiet text pages.

## Commands

All inside `web/`, with pnpm.

| command | what it does |
| --- | --- |
| `pnpm install` | install dependencies |
| `pnpm dev` | local dev server |
| `pnpm build` | syncs `docs/pricing/features.json` into `content/`, type-checks, and exports a static site to `out/` |
| `pnpm serve` | serves `out/` on http://127.0.0.1:4317 (tiny Node server, no global installs) |
| `pnpm shots` | screenshots of the landing into `screenshots/` (flags: `--theme=light`, `--w= --h=`, `--mobile=1 --dpr=2`, `--reduced=1`, `--path=/pricing/`, `--only=name,name`, `--prefix=`) |
| `pnpm perf` | scrolls the landing with real wheel input, writes `screenshots/perf.txt` and a gzipped Chromium trace |
| `pnpm check` | loads every page in dark and light, scrolls it, and fails on any console warning or error |

Playwright uses its bundled Chromium (`pnpm exec playwright install chromium` once) with `--use-angle=metal`, so WebGL runs on the real GPU.

## Structure

- `app/`: `/` (the film), `/guide`, `/pricing`, `/privacy`, `/compatibility`, `/faq`. Fonts live in `app/fonts`.
- `components/site/`: everything DOM. `Experience.tsx` mounts the fixed canvas once and lays out the chapters; `Nav.tsx` is the floating pill; `Pricing.tsx` renders from `content/features.json`; `Info.tsx` and `Guide.tsx` hold the text pages.
- `components/three/`: the WebGL scene. Owned by the 3D specialist; the site talks to it only through `lib/stage.ts` (`bus`) and `lib/chapters.ts`. Requests from the site side go in `components/three/REQUESTS.md`.
- `lib/chapters.ts`: chapter ids, heights in viewports, and the step lists (zones, air gestures, sound, app layers) that both the captions and the scene read.
- `lib/stage.ts`: the shared bus. The DOM writes smoothed progress per chapter, page progress and scroll velocity; the scene reads them in `useFrame`. Nothing calls React `setState` while scrolling.
- `lib/site.ts`: outbound links. **`DOWNLOAD_URL`, `BUY_URL`, `SALES_URL` and `SOURCE_URL` are placeholders** until the real .dmg, checkout, sales contact and source repo exist.
- `content/features.json`: copy of `docs/pricing/features.json`, refreshed on every build.
- `public/video/teaser-540.mp4`: the 10 second vertical teaser, transcoded with ffmpeg from `packages/promo/out/ghostkeys-teaser-vertical.mp4` (540 wide, no audio, 1.4 MB). Loaded only when it scrolls into view on `/pricing`.
- `public/audio/`: the UI sound sprite (synthesized by `scripts/make-sounds.mjs`, 17 KB). Sound is off until the visitor turns it on.
- `public/gpu-benchmarks/`: detect-gpu's benchmark data, self-hosted so the page makes no third-party requests.

## Type

| role | face | license |
| --- | --- | --- |
| Display (headlines, prices) | Zodiak, weights 300 and 400, with italics | ITF Free Font License (Fontshare), free for commercial use, self-hosted |
| Text (the rare sentence) | Switzer, weights 300, 400, 500 | ITF Free Font License (Fontshare) |
| Captions and labels | Fragment Mono 400 | SIL Open Font License 1.1 |

Chosen after rendering three pairings side by side (`screenshots/fonts-pairing-1..3.png`): Zodiak with Switzer and Fragment Mono; Boska with Satoshi and JetBrains Mono; General Sans with Switzer and Fragment Mono. Zodiak's light weight reads as the most refined at display sizes and its italic carries the one accent word per line. `scripts/fetch-fonts.mjs` re-downloads the Fontshare files.

Scale: display lines are fluid (`--t-hero`, `--t-line`) with tracking at -0.03em and leading at 0.94; labels are 11 px mono, uppercase, +0.08em.

## Motion and scroll

- Lenis (lerp 0.08, no touch smoothing) is driven from `gsap.ticker`, so GSAP, ScrollTrigger and Lenis share one frame loop.
- Each chapter is a tall section with sticky content. Its progress is published through a scrubbed GSAP tween (`scrub: 1`), so the scene receives smoothed values.
- Headlines reveal with GSAP SplitText line masks, scrubbed by scroll; the italic word un-blurs.
- The nav pill converges over the first 420 px of scroll (padding, gap and the wordmark folding into the mark), hides on a fast scroll down and returns on scroll up.
- Reduced motion: no Lenis, no SplitText, the scene skips the particle intro and cuts between shots.

## Verified

- `pnpm build` passes (TypeScript strict).
- `pnpm check`: zero console warnings or errors on all six pages in both themes. One known third-party warning (React Three Fiber constructing the deprecated `THREE.Clock`) is filtered by exact message in `lib/three-console.ts`.
- `pnpm perf` on the M5 Pro at device pixel ratio 2: 60 fps average, p99 frame 16.8 ms, no frames over 20 ms (`screenshots/perf.txt`).

## Known limitations

- The interactive "Go on. Tap it." readout waits on the scene calling `bus.fire` (requested in `components/three/REQUESTS.md`).
- The air-gesture and sound-mode scenes are being built by the 3D specialist; until they land, that chapter shows the laptop idle.
- Social proof is an empty, clearly marked TODO (`components/site/SocialProof.tsx`); add `?todo` to the URL to see where it sits.
- The Windows waitlist stores the address in the visitor's browser only; nothing is sent anywhere yet.
