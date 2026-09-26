# Ghostkeys website

Marketing site for Ghostkeys. A short scroll film over one persistent WebGL canvas, plus five quiet text pages.

## Commands

All inside `web/`, with pnpm.

| command | what it does |
| --- | --- |
| `pnpm install` | install dependencies |
| `pnpm dev` | local dev server |
| `pnpm build` | syncs `docs/pricing/features.json` and `docs/guide/*.md` into `content/`, type-checks, and exports a static site to `out/` |
| `pnpm serve` | serves `out/` on http://127.0.0.1:4317 (tiny Node server, no global installs) |
| `pnpm shots` | screenshots of the landing into `screenshots/` (flags: `--theme=light`, `--w= --h=`, `--mobile=1 --dpr=2`, `--reduced=1`, `--path=/pricing/`, `--only=name,name`, `--prefix=`) |
| `pnpm perf` | scrolls the landing with real wheel input, writes `screenshots/perf.txt` and a gzipped Chromium trace |
| `pnpm check` | loads every page in dark and light, scrolls it, and fails on any console warning or error |

Playwright uses its bundled Chromium (`pnpm exec playwright install chromium` once) with `--use-angle=metal`, so WebGL runs on the real GPU.

## Structure

- `app/`: `/` (the film), `/pricing`, `/guide` plus one page per guide chapter (`/guide/[slug]`, rendered from `docs/guide/*.md` with `marked`, sticky contents), `/privacy`, `/compatibility`, `/faq` (questions parsed from the guide's FAQ chapter). Fonts live in `app/fonts`. Every page is under 6 viewports at 1440x900.
- `components/site/`: everything DOM. `Experience.tsx` mounts the fixed canvas once and lays out the chapters; `Nav.tsx` is the floating pill; `Pricing.tsx` renders from `content/features.json`; `Info.tsx` holds compatibility, `lib/guide.ts` reads the guide markdown.
- `components/three/`: the WebGL scene. Owned by the 3D specialist; the site talks to it only through `lib/stage.ts` (`bus`) and `lib/chapters.ts`. Requests from the site side go in `components/three/REQUESTS.md`.
- `lib/chapters.ts`: chapter ids, heights in viewports, and the step lists (zones, air gestures, sound, app layers) that both the captions and the scene read.
- `lib/stage.ts`: the shared bus. The DOM writes smoothed progress per chapter, page progress and scroll velocity; the scene reads them in `useFrame`. Nothing calls React `setState` while scrolling.
- `lib/site.ts`: outbound links. **`DOWNLOAD_URL`, `BUY_URL`, `SALES_URL` and `SOURCE_URL` are placeholders** until the real .dmg, checkout, sales contact and source repo exist.
- `content/features.json`: copy of `docs/pricing/features.json`, refreshed on every build.
- `public/video/teaser-540.mp4`: the 10 second vertical teaser (540 wide, no audio, 1.4 MB), transcoded from `packages/promo/out/`. Not currently placed: QA read it as a social-story embed on the pricing page.
- `public/audio/`: the UI sound sprite (synthesized by `scripts/make-sounds.mjs`, 17 KB). Sound is off until the visitor turns it on.
- `public/gpu-benchmarks/`: detect-gpu's benchmark data, self-hosted so the page makes no third-party requests.

## Type

| role | face | license |
| --- | --- | --- |
| Display (headlines, prices) | Switzer 200, with Switzer 300 italic for the one accent word per headline | ITF Free Font License (Fontshare), free for commercial use, self-hosted |
| Text | Switzer 300, 400, 500 | ITF Free Font License (Fontshare) |
| Captions and labels | Fragment Mono 400 | SIL Open Font License 1.1 |

Chosen by the client from three specimens rendered on the real page (`screenshots/fonts-v2-A..C.png`: General Sans, Switzer, Fraunces). `scripts/fetch-fonts.mjs switzer@200,300,301,400,500` re-downloads the files. Display sizes use tracking -0.04em and leading 0.98; labels are 11 px mono, uppercase, +0.08em.

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
