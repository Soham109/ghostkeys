# Requests from the site side (components/site, app, lib)

Owner of this folder: the 3D and motion specialist. The site agent only appends here.

## 1. One persistent canvas for the whole page (lead requirement)

- `components/site/Experience.tsx` now mounts `<StageCanvas tier active />` once, in a `position: fixed; inset: 0` layer behind all DOM, for the entire page. It is never unmounted.
- `MiniStage` is no longer used by the site (Features and Demo sections were removed). Everything they did must happen in the one scene.
- `StageCanvas` props stay `{ tier: Tier; active: boolean; onCreated?: () => void }`. `active` goes false only when the tab is hidden or the pricing chapter fully covers the viewport.
- Pointer: DOM overlays use `pointer-events: none` except real controls, so the canvas receives pointer events everywhere else. If you switch to `eventSource`, use `document.getElementById("gk-root")` with `eventPrefix="client"`.

## 2. Scroll contract (read-only for you, written by the site)

All in `lib/stage.ts` (`bus`) and `lib/chapters.ts`:

- `bus.chapters[id]`: smoothed progress 0..1 of each chapter section (0 before it, 1 after it). Ids in order: `intro, feel, zones, calibrate, layers, beyond, gestures, try, privacy, pricing, outro`.
- `bus.chapter`: the chapter filling most of the viewport.
- `bus.page`: whole page 0..1. `bus.velocity`: smoothed scroll velocity, screens per second, signed. Good for motion blur, chromatic aberration kicks, particle wind.
- `bus.pos`: legacy 0..11 value for the current rig in `lib/rig.ts`. Mapping (in `Experience.tsx`): intro 0..0.6, feel 0.6..2.45, zones 2.45..5.3, calibrate 5.3..7.0, layers 7.0..8.75, beyond 8.75..10.3, gestures and try hold 10.3, privacy 10.3..11 (dissolve), pricing 11, outro back to 10.3. Replace it with per-chapter logic whenever you like; the site keeps writing it.
- The site never calls setState on scroll; please keep the scene free of React state changes on scroll too.

## 3. What each chapter should show (the DOM only carries one short line)

| chapter | on-screen line (site) | laptop should |
| --- | --- | --- |
| intro | "Your laptop has more buttons." | dust to logo to laptop as one continuous transformation; the laptop must never pop in. Preload everything behind the dust. Set `bus.loaded` 0..1 while preparing and `bus.introDone` when the lid is open. |
| feel | "It feels every tap." | dive inside, sensor chip glows, live trace |
| zones | "The blank space is the interface." | zones light one by one; small mono corner caption names the current one (site shows it from `zoneStep`) |
| calibrate | "It learns your hands." | heat map builds |
| layers | "Every app, its own layout." | zones relabel as the screen swaps apps |
| beyond | "Nudge. Tilt. Cover." | lid nudge, tilt, light sensor cover |
| gestures | one big word per step, from `GESTURE_STEPS` in `lib/chapters.ts` | step `i = floor(progress * GESTURE_STEPS.length)`; perform `GESTURE_STEPS[i]` (zone, gesture, action) with the HUD pill. `air` = camera add-on fingertips pinching over the keys |
| try | "Go on. Tap it." | clicks on zones resolve to tap, double or triple (count clicks within 340 ms), then call `bus.fire({ zone, zoneName, gesture, count, action })`. Bindings are `bus.demo.bindings[zoneId][gesture]`. Visitor-drawn zones are in `bus.demo.customZones` (base surface, protocol rect); render them like the default zones and include them in hit tests, checking the newest first. Clicks on keys or the trackpad: ripple only, and `bus.fire` with `zone: "keyboard"` or `"trackpad"` and `action: null`. |
| privacy | "Nothing leaves your Mac." | everything goes quiet: glows fade, the laptop recedes into the dark |
| pricing | DOM only | render nothing or a static dimmed frame; `active` is false while pricing covers the screen |
| outro | "The blank space is the interface." | the lid slowly closes as the page ends |

## 4. Bugs and warnings the lead wants gone (zero console warnings)

- `THREE.Color: Unknown color currentColor`: comes from SVGLoader parsing `/logo.svg`. Fixed on the site side: `public/logo.svg` now uses `#ffffff` strokes. If you change the logo source, keep it free of `currentColor`.
- `THREE.Clock: This module has been deprecated`: comes from R3F's store. The site filters exactly this message with three's `setConsoleFunction` in `lib/three-console.ts` (imported by Experience before the canvas mounts). If you move to `THREE.Timer`, delete that filter.
- R3F resets `state.clock` when `frameloop` goes never to always. The scene already uses `now()` from `taps.ts` for stored times; keep that for anything new.
- Light theme: check deck, keyboard well and trackpad placement in top-down shots (well and trackpad are now centered on their own z ranges, fixed just before the handover).
- Unmounting a Canvas that contains drei `<Html>` threw `removeChild` in React 19 (seen with MiniStage). With one persistent canvas this should not happen, but keep `<Html>` usage stable.

## 5. Performance targets

- 60 fps on the M5 Pro while scrolling the whole page (the site will record a Playwright performance trace; results go in `web/screenshots/perf.txt`).
- DPR capped at 1.75, adaptive via `PerformanceMonitor` and detect-gpu tier (`lib/device.ts`, `useTier`).

## 6. Update (site side): the page is now a persuasion arc

Supersedes the chapter table in section 3. Ids and order live in `lib/chapters.ts` (`CHAPTER_ORDER`):

`intro, feel, zones, calibrate, beyond, air, sound, layers, try, trust, pricing, outro`

| chapter | DOM line | scene |
| --- | --- | --- |
| intro | "Your laptop has more buttons." | hook: dust, logo, laptop |
| feel | "It feels every tap." | inside, sensor chip, live trace |
| zones | "Every blank surface is a key." | taps ripple across palm rests, grilles, top strip, edges, lid, in `ZONE_STEPS` order; step = `stepAt(progress, 5)` |
| calibrate | "It learns your hands." | heat map |
| beyond | "Nudge. Tilt. Cover." | lid nudge, tilt, light sensor |
| air | "Gesture in the air." (caption: camera add-on, M4 and M5, beta) | your `AirGestureScene`; gesture = `AIR_STEPS[stepAt(progress, AIR_STEPS.length)].id`, local progress within the step = `(progress * n) % 1` |
| sound | "Listen closer." (caption: sound mode, opt-in, on-device) | your `SoundScene`; mode = `SOUND_STEPS[...]` the same way |
| layers | "Your apps, your layers." | `LAYER_STEPS`: per-app layers, Excel formula tools, macros, AI composer typing a sentence that becomes a binding (the screen already has a `composer` mode in `screen.ts`) |
| try | "Go on. Tap it." | interactive, as in section 3 |
| trust | "Nothing leaves your Mac." | quiet, glows fade |
| pricing | DOM | nothing |
| outro | "The blank space is the interface." | final cinematic: the lid closes, one last ripple |

- `gestures` and `privacy` ids are gone (`privacy` is now `trust`).
- Where should `AirGestureScene` and `SoundScene` mount? The site cannot put R3F components outside the canvas. Please mount them inside `StageScene` (the one persistent canvas) driven by `bus.chapters.air` / `bus.chapters.sound`. If they must be separate canvases, tell me here and I will give them a fixed layer, but the lead asked for one canvas.
- `bus.pos` legacy mapping from now on (so the current rig keeps working until you replace it): intro 0..0.6, feel 0.6..2.45, zones 2.45..5.3, calibrate 5.3..7.0, beyond 8.75..10.3, air and sound hold 7.12, layers 7.15..8.75, try, trust and outro hold 7.12 (front three-quarter shot, laptop idle). The pricing section has an opaque background, so the canvas is simply covered there and `active` goes false.

## 7. Update (site side): shorter landing, about eight viewports (latest, supersedes sections 3 and 6)

Client: "don't make the website unnecessarily long". The landing now has six chapters (`lib/chapters.ts`):

| chapter | screens | DOM line | scene |
| --- | --- | --- | --- |
| intro | 1.25 | "Your laptop has more buttons." | hook: dust, logo, laptop |
| zones | 2.0 | "Every blank surface is a key." | the reveal: taps ripple across palm rests, grilles, top strip, edges, lid (`ZONE_STEPS`, `stepAt(p, 5)`) |
| air | 2.1 | "Gesture in the air." then "Listen closer." | `p < AIR_SOUND_SPLIT (0.6)`: AirGestureScene, gesture = `AIR_STEPS[stepAt(p / 0.6, 4)]`; `p >= 0.6`: SoundScene, mode = `SOUND_STEPS[stepAt((p - 0.6) / 0.4, 3)]` |
| layers | 1.6 | "Your apps, your layers." | `LAYER_STEPS` (per-app layers, Excel tools, macros, AI composer typing a sentence into a binding) |
| try | 1.2 | "Go on. Tap it." | interactive, contract in section 3 |
| finale | 1.1 | "The blank space is the interface." plus Download | final cinematic, the lid closes |

- Gone from the landing: `feel`, `calibrate`, `beyond`, `sound` (now a beat inside `air`), `trust`, `pricing`, `outro` (now `finale`). The inside view, calibration and lid/tilt/cover are described on the `/guide` page; if you want, fold a quick inside peek into the start of `zones`.
- Pricing, guide, privacy, compatibility and FAQ are separate pages with no canvas.
- Legacy `bus.pos` mapping: intro 0..0.5, zones 2.8..5.3 (starts after the hood track returns to 0), air 7.12 hold, layers 7.15..8.75, try 7.12 hold, finale 7.12 hold.

## 8. Composition notes from the site's screenshots (light and dark, 1440 and 390 wide)

- Legibility: the DOM line sits top left (zones, air, try, finale) or bottom left (layers), at most ~45% of the width on desktop. Please keep the laptop's bright or busy parts (the screen UI especially) out of that area, or dim the screen in those chapters. In the light theme the finale line currently crosses the black display and becomes unreadable.
- Finale: the lid closing would also solve legibility; the laptop can sit lower right.
- Mobile (390 wide, tier 1): laptop edges show a dashed, stair-stepped white outline around the chassis and trackpad in `screenshots/mobile-*.png`. Looks like aliasing on thin edge highlights without MSAA, or the alphaHash reveal staying on.
- Try chapter: nothing calls `bus.fire` yet, so the readout never changes; clicks do ripple.

## 9. Contract change: chapter progress now starts when the section pins

`bus.chapters[id]` is 0 until the section's top reaches the top of the viewport, then runs to 1 as it unpins (the same range as the headline reveals). During the scroll-in between chapters, the previous chapter holds at 1 and `bus.chapter` still names it.

## From 3D: air and sound scenes

- New folder `components/three/air/`: `AirGestureScene` (camera add-on) and `SoundScene` (sound mode), plus the shared ghost hand (`GhostHand`, 21 joints like Apple's hand pose: soft points at joints, hairline bones, fading fingertip trails, signal orange only when a pinch closes or a knock lands).
- Both are mounted by the 3D side inside `StageScene`, in the one persistent canvas, driven by the `air` chapter (`bus.chapters.air`): `AIR_STEPS` for the first part, `SOUND_STEPS` after it. Nothing for the site to place.
- Air ids: `pinch`, `drag` (left then right), `swipe`, `dial`, plus `zoom` (two hands), `circle`, `point`, `tap`, `drag-left`, `drag-right`, `drag-up`, `drag-down` if you ever want them in `AIR_STEPS`.
- Sound ids: `knuckle` (knuckle knocks, then fingertip taps, as two kinds of sound wave), `rub` (grille rub, comb of harmonics), `wave` (hand wave bending the 20 kHz field).
- The laptop screen answers each gesture (window grab and slide, desktops, volume dial, zoom, scrub; knuckle or fingertip verdict, harmonics, 20 kHz echo).
- Labels drawn next to the hand, in WebGL (no DOM): "M4 AND M5 · CAMERA ADD-ON" and "SOUND MODE · ON-DEVICE". Your DOM caption can stay as is.
- Each step reads within its own slice of scroll: quick lead-in, the action, a short hold, back to a rest pose by the end, so steps chain without jumps.

## From 3D: state of the scene and what the site can use (latest)

- **Scroll axis.** The camera now runs on raw scroll (viewport heights) built from `CHAPTER_ORDER` and `CHAPTER_SCREENS`, so it keeps moving through the one-viewport scroll-in between chapters (your chapter progress is "top top" to "bottom bottom", which left the scene frozen for a screen between chapters). Assumption: chapter sections are stacked from the top of the page in `CHAPTER_ORDER`, heights `CHAPTER_SCREENS[id]` viewports. If that stops being true, publish `bus.scroll = scrollY / innerHeight` each tick and the scene uses it instead of reading `window.scrollY`.
- **Captions stay in sync:** zone steps, air/sound steps and layer steps still follow your `bus.chapters[id]` exactly (`stepAt`), the camera just starts travelling during the scroll-in.
- **Render loop:** the canvas no longer runs its own requestAnimationFrame; it renders from `gsap.ticker`, after Lenis and ScrollTrigger in the same tick. `active=false` stops it.
- **Loading:** `bus.loaded` goes 0..1 (HDRI, the Live screenshot texture, shader compile and GPU upload). The dust only appears when it reaches 1 (or after 2.5 s), so the intro never hitches. `bus.introDone` flips when the lid is open.
- **Try chapter:** implemented as in section 3: clicks on zones (custom zones first, newest first), keys and trackpad resolve to tap/double/triple within 340 ms and call `bus.fire`. Edge and lid clicks too.
- **Finale:** the lid closes and one last ripple lands during the finale's scroll-in (its pinned range is only 0.1 viewport).
- **Fallback component for reduced motion, tier 0, or no WebGL2:** `components/three/Stills.tsx` (default export `StillStage`, DOM only, no three.js). Mount it where `StageCanvas` would go (same fixed layer). It cross-fades pre-rendered stills of this exact scene by `bus.chapter` (`public/stills/{intro,zones,grille,air,sound,layers,try}-{dark,light}.avif`, 560 KB total, rendered at 1920x1200). Alt text is in `STILL_ALT`. Today the site mounts nothing when `tier === 0`, so those visitors see an empty page behind the copy.
- **Assets added to public:** `hdr/studio.hdr` (Poly Haven "studio_small_03", CC0, 1k), `textures/live.webp` (the app's Live screen, 84 KB), `stills/*.avif`.
- **Debug hook:** `?debug` exposes `window.__gkBus` (the bus) for Playwright checks.
- `MiniStage.tsx` was deleted (unused). `Heatmap.tsx` is kept but not mounted.

## 10. Site side, after QA round 2 (docs/review/WEB_QA.md): open items that are in the scene

- `StillStage` is now mounted for reduced motion, tier 0 and no WebGL2 (the canvas is not mounted in those cases), so QA bug 7 (reduced motion still animating) is closed by that.
- 3D labels and HUD pills over the copy column: "LEFT GRILLE" sits on "Every" at 1280x800 (zones chapter), pills land on "buttons" and "layers." (QA bugs 4 and 5). Please keep drei `<Html>` labels out of the left ~45% on desktop (or hide them while `bus.chapter` copy is on screen), and clamp or hide labels whose anchor is off-frame.
- Headlines now carry a local radial scrim (`.scrim` in globals.css, bg color at 86% center). It helps, but framing the laptop so copy lands on the backdrop is still the better fix at 1280 wide.
- Accent use (QA art item 3): rings still cross the trackpad and other zones; inter-key glow reads as decoration.
- Screen texture uses blue, green, purple and pink zone colors (QA art item 4, APP_CRITIQUE item 1): monochrome please.
- Mobile jagged, dashed-looking chassis and trackpad edges at 390 wide, tier 1 (not in the site's area).
- Light theme: in the sound beat the laptop's black display sits under the headline column at 1440; please frame it further right in air/sound (headline column is the left ~40%).
