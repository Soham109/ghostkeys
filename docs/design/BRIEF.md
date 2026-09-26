# Ghostkeys design brief

## 1. Direction

**Machined silence.** The product is invisible, so absence is the hero: a near-black (or bone-white) void, one lit aluminum MacBook, and light only where a touch happens. It should read like a precision instrument manual, not a SaaS page. Every animation is tied to scroll or touch. The one warm accent color means "a touch was felt" and appears nowhere else.

References:
- **Apple MacBook Pro** (https://www.apple.com/macbook-pro/): pinned, scroll-scrubbed product choreography; one huge sentence per screen.
- **Igloo Inc** (https://www.igloo.inc/): point clouds that form and dissolve on scroll; monochrome restraint; opt-in sound.
- **Teenage Engineering** (https://teenage.engineering): tiny mono labels, numbered specs, hairline grids, one hot accent used like an LED.

## 2. Visual system

**Tokens**

| token | dark | light |
|---|---|---|
| `--bg` | `#0A0A0B` | `#F4F4F1` |
| `--bg-raised` | `#111113` | `#ECECE8` |
| `--ink` | `#EDEDEF` | `#0B0B0C` |
| `--ink-2` (muted) | `#8A8A90` | `#65656B` |
| `--ink-3` (labels) | `#55555B` | `#9A9A9E` |
| `--hairline` | `#1F1F23` | `#DADAD5` |
| `--aluminum` (3D base color) | `#A7A9AC` | `#C9CBCE` |
| **`--signal`** (sole accent) | `#FF5B1F` | `#E5480C` |

Accent only for live touch feedback, the HUD dot, and at most one word per page.

**Gradients:** allowed only as *light*, never as fills. Use soft radial falloff behind the laptop (`--ink` at 4 to 6 percent opacity to 0), and 3D volumetric light via postprocessing. Dither all screen-space gradients with 64px blue noise at 3 percent to kill banding. Banned: rainbow, purple to blue, mesh-gradient blobs, gradient text.

**Grain:** `<Noise opacity={0.035} premultiply />` (0.025 in light).

**Type (all free and self-hostable, SIL OFL licensed):**
- Text and UI: **Geist** (https://github.com/vercel/geist-font), weights 400 and 500 only.
- Labels, numerals, HUD: **Geist Mono**, 11 to 12px, uppercase, tracking +0.08em.
- Display accent: **Instrument Serif** italic (https://fonts.google.com/specimen/Instrument+Serif), used for one or two words inside a Geist headline ("Your MacBook has *hidden* keys.").

Scale (fluid `clamp`): 12 / 14 / 16 / 20 / 28 / 44 / 72 / 120 / 184px. Display sizes use tracking -0.035em and line-height 0.92. Body 16/1.55, max 60ch.

**Spacing:** 4px base; steps 4, 8, 12, 16, 24, 32, 48, 64, 96, 160, 240. Sections separate by 160 to 240px, never by boxes.

**Radius:** 0 for layout, 6px for inputs, 999px only for the HUD pill and toggles.

**Motion:**
- `--ease-out`: `cubic-bezier(0.16, 1, 0.3, 1)` (expo out) for reveals.
- `--ease-inout`: `cubic-bezier(0.65, 0, 0.35, 1)` for camera moves.
- `--ease-snap`: `cubic-bezier(0.2, 0, 0, 1)` for UI state.
- Durations: micro 160ms, UI 280ms, reveal 900ms, scene 1400 to 1800ms. Stagger 0.03s per character, 0.08s per line.
- Lenis: `lerp: 0.085`, `smoothWheel: true`, driven from `gsap.ticker` (one RAF loop for everything).

## 3. Layout rules (instead of cards)

- 12-column editorial grid (gutter 16px mobile, 24px desktop); content starts on column 3 or 7, deliberately asymmetric.
- Feature lists are **numbered rows** split by full-width 1px hairlines: `01` in mono on the left, a sentence in Geist 28px, a small live demo on the right. No containers.
- Large 184px tabular numerals carry specs: "7 zones", "0 buttons".
- Text sits over the full-bleed 3D scene, protected by radial light, not a panel.

**Banned (10):**
1. Grids of cards (icon + title + blurb in a rounded box).
2. Bold vertical bar or left-border accent beside text.
3. Centered hero with a pill badge above and two buttons below.
4. Glassmorphism, except the real macOS vibrancy in the app.
5. Emoji and generic line-icon sets (Lucide/Heroicons as decoration).
6. Stock gradients: purple-blue, aurora blobs, gradient text, glowing borders.
7. Logo walls, fake testimonials, "Trusted by" strips.
8. Drop shadows on flat UI (depth comes from light in 3D only).
9. Scroll-jacked sections that trap the user more than 2 viewports without visible progress.
10. Boxed pricing tables, bordered FAQ accordions, bouncy overshoot on text.

## 4. Signature moments (website)

**(a) Particles to logo to laptop.** Three.js `GPUComputationRenderer` (FBO ping-pong) inside R3F, 256x256 = 65,536 points (512x512 = 262k on desktop GPUs that pass a `detect-gpu` tier 3 check).
- Targets baked offline into float textures: (1) points sampled along the strokes of `logo.svg` (use `SVGLoader` then sample path length evenly, jitter 0.6px, z = noise * 0.1); (2) points sampled on the MacBook GLB surface with drei `<Sampler>` / `MeshSurfaceSampler`, weighted toward palm rests and grilles.
- Velocity shader: `acc = (target - pos) * k + curlNoise(pos * 0.9 + t * 0.15) * n`, `vel *= 0.92`. On load, `k` tweens 0 to 0.06 and `n` 1.0 to 0.05 over 2.2s (`--ease-out`), so a dust cloud condenses into the mark. On first scroll, swap target to the laptop, set `n = 0.6`, then settle; the real mesh fades in (`opacity` 0 to 1) as particles fade out. Points: size 1.2 to 2.2px, additive on dark, normal blending with `--ink` on light.
- Adapt: https://threejs.org/examples/webgl_gpgpu_protoplanet.html ; R3F FBO walkthrough https://blog.maximeheckel.com/posts/the-magical-world-of-particles-with-react-three-fiber-and-shaders/ ;

**(b) Pinned scroll story.** GSAP ScrollTrigger (https://gsap.com/docs/v3/Plugins/ScrollTrigger/) with `pin: true, scrub: 1, end: "+=400%"` on the canvas section. One master timeline tweens a camera rig object (position, target, fov) through 5 keyframes: lid-open 3/4 view, top-down on palm rests, macro on speaker grille, edge profile, lid back. Each keyframe pulses its zone in `--signal` and swaps one line of copy. Author the camera path in **Theatre.js** (https://github.com/theatre-js/theatre) and play its sequence position from ScrollTrigger progress. Mono counter "02 / 05" bottom left.

**(c) Headline reveals.** GSAP SplitText (free since 3.13, rewritten; https://gsap.com/docs/v3/Plugins/SplitText/) with `type: "lines,words", mask: "lines", autoSplit: true`. Tween `yPercent: 110 to 0`, `duration: 0.9`, `stagger: 0.08`, `ease: "expo.out"`, triggered at `start: "top 80%"`. The italic serif word gets a separate 120ms delayed blur 8px to 0.

**(d) Cursor ripples on aluminum.** `three-custom-shader-material` (https://github.com/FarazzShaikh/THREE-CustomShaderMaterial) extending `MeshPhysicalMaterial` (metalness 1, roughness 0.32, anisotropy 0.6 for brushed metal). Raycast the pointer to the laptop's UV; write impulses into a 256x256 height field simulated like https://threejs.org/examples/webgl_gpgpu_water.html (damping 0.985). Perturb normals only, so light rolls across the metal; a faint `--signal` rim at impact fades over 600ms. Smooth pointer with `maath/easing.damp2` (https://github.com/pmndrs/maath).

**(e) Section transitions.** One persistent fixed canvas behind the DOM. Between sections, run a fullscreen pass in `@react-three/postprocessing` (https://github.com/pmndrs/react-postprocessing) whose uniform `uProgress` is scrubbed by ScrollTrigger: a noise-threshold dissolve (FBM, softness 0.08) from scene A into scene B, plus a brief `ChromaticAberration` of 0.0015 at peak. For route changes, GSAP Flip carries the logo mark from footer to header.

**(f) UI audio (off by default).** A mono "SOUND OFF / ON" toggle top right, preference in `localStorage`. Web Audio via Howler (https://howlerjs.com) with one sprite file under 60KB: a soft tick on hover of numbered rows (-28 dB), a low felt thump when a ripple lands (-22 dB, pitch varies ±3 percent), a 1.8s airy swell as particles converge. Audio unlocks only on the toggle click. Wiring reference: https://tympanus.net/codrops/2026/07/15/the-architecture-behind-trionn-coordinating-gsap-three-js-lenis-and-web-audio/ .

**(g) Reduced motion.** Under `prefers-reduced-motion: reduce` (https://web.dev/articles/prefers-reduced-motion) and via `gsap.matchMedia()`: no Lenis (native scroll), no pinning, no particles; show a static pre-rendered logo and a still hero render (AVIF). SplitText becomes a 280ms opacity fade. Ripples become a single static highlight. Same fallback for GPU tier 0 or no WebGL2.

## 5. Desktop app (Electron)

- **Window:** `titleBarStyle: "hiddenInset"`, `vibrancy: "under-window"` for the sidebar and `"hud"` for the HUD, `visualEffectState: "followWindow"`, `backgroundColor: "#00000000"` (https://www.electronjs.org/docs/latest/api/browser-window). Traffic lights inset at `{x: 16, y: 18}`.
- **Type:** `-apple-system, system-ui` (real SF); Geist Mono for readings and shortcuts. Sizes 11 / 13 / 15 / 20 / 28; body 13px.
- **Grid:** 8pt. Sidebar 220px; content padding 24px; row height 32px; controls 28px.
- **No cards:** sidebar list; sections titled in 11px mono uppercase `--ink-3`; rows split by 1px `--hairline` inset 16px; native-style switches (shadcn restyled, no shadows or card borders).
- **Live laptop map:** a top-down line drawing of the MacBook (SVG, 1px strokes in `--ink-3`) filling the main pane. Each zone (palm L/R, grilles, top strip, edges, lid) is a region with a 6 percent fill on hover. On a live tap from the sensor, draw a `--signal` ring at the reported point: scale 0.4 to 1.6, opacity 1 to 0, 520ms `--ease-out`, using `motion` `animate`. Selecting a zone slides its bindings in (x 12px to 0, 280ms). No 3D here.
- **HUD pill:** a separate frameless, click-through, always-on-top window, 999px radius, height 36px, `vibrancy: "hud"`, centered near the top of screen. Content: 6px `--signal` dot + "Left palm · Play/Pause" at 13px. Enter: y -8 to 0, opacity 0 to 1, 200ms; hold 1.1s; exit 240ms. Use `motion`'s `AnimatePresence` with `layout` so text width changes glide.
- **Motion:** 160 to 280ms, snap easing, no bounce. Respect `useReducedMotion()` from motion.
- **Themes:** three-way segmented control "System / Light / Dark". Main process sets `nativeTheme.themeSource` (https://www.electronjs.org/docs/latest/api/native-theme), renderer mirrors it as `data-theme` on `<html>`, and all colors come from the same tokens as the website so vibrancy tints correctly in both.

## 6. Logo

**Concept: the key that is not there.** Two identical rounded-square keycaps, one solid and one offset ghost behind it, plus the dot where a finger lands. File: `docs/design/logo.svg`.

Geometry (viewBox `0 0 128 128`, stroke `currentColor`, width 6, round joins, no fill):
- Ghost keycap: `rect x=36 y=28 w=64 h=64 rx=16`, opacity 0.35.
- Front keycap: `rect x=28 y=36 w=64 h=64 rx=16`, opacity 1.
- Touch point: filled `circle cx=60 cy=68 r=7`.

Strokes plus one dot read clearly even at 20k points. Assign roughly 55 percent of points to the front key, 30 percent to the ghost (rendered at lower alpha), and 15 percent packed into the dot, which is the last to settle and briefly flashes `--signal`. Wordmark: "ghostkeys", Geist 500, lowercase, tracking -0.02em, right of the mark, x-height 0.42 of mark height.
