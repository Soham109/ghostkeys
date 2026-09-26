# Ghostkeys web: QA and art-direction review

Owner: web QA agent. Read-only on `web/`. Every round builds a private copy of the latest `web/` source (`next build`, static `out/`), serves it on port 4801, and drives it with Playwright Chromium on the Metal GPU (`ANGLE Metal Renderer: Apple M5 Pro`, not SwiftShader). Screenshots live in the QA scratch folder named per round:
`/private/tmp/claude-501/-Users-sohamaggarwal/5865e2c2-7871-49a1-8e02-7f828d1f782d/scratchpad/rounds/rN/shots/`
(short name below: `rN/<file>`).

Harness: `scratchpad/qa.mjs` (5 viewports x 15 scroll positions, 37 dark + 15 light art positions, load filmstrip, 3 scripted wheel passes through Lenis with in-page rAF timing, heap after forced GC, WebGL object counters, theme, reduced motion, 45 Tab presses, link check).

Newest round first.

---

## Round 2: 2026-09-26 17:55 local (build of `web/` as of 17:53, mid-edit snapshot)

The site was rebuilt between rounds: one pinned `Experience` on `/` (7,425px tall at 1440x900, was 23,972) plus subpages `/guide/ /pricing/ /faq/ /privacy/ /compatibility/`, serif display type, floating pill nav. Round 1 issues are re-checked at the end of this round.

### Bugs (fix first)

1. **Every "Download" button and the skip link go nowhere.** `lib/site.ts` still has `DOWNLOAD_URL = "#pricing"`, but `/` no longer has an element with `id="pricing"` (pricing moved to `/pricing/`). Affected: nav "Download" (on every page), hero "Download for Mac", end "Download for Mac", and the skip link "Skip to pricing" in `app/page.tsx`. Clicking does nothing. Fix now: point to `/pricing/` until the .dmg URL exists.
2. **Chapter headlines overlap each other under reduced motion.** With `prefers-reduced-motion: reduce`, "Gesture in the air." and "Listen closer." render on top of each other at the same spot, reading "Gisstenrecloser." Shot: `r2/reduced-04.png` (also `-05`, and "Go on. Tap it." / "The blank" half-overlapped in `r2/reduced-09.png`). `Experience.tsx:181` returns early when reduced, so the chapter copy never gets its hide/show timeline; every chapter's copy is visible at once. Fix: under reduced motion, lay the chapters out as normal flow sections (each copy block static, no absolute stacking), or toggle visibility by IntersectionObserver.
3. **Exiting headline lines overlap the lines below them.** At rest (1.4s after scrolling stops) the hero headline's first line "Your laptop" sits on top of "has more": `r2/art-dark-02.png` (y=413), `r2/art-light-01.png`, mobile `r2/390x844-01.png`. Same for "Every blank surface" at `r2/art-dark-09.png`, and the end headline is cut mid-line in `r2/art-dark-33.png` ("space is the" sliced) and `r2/390x844-13.png`. The line mask is not clipping the line that is leaving. Check that the exit tween moves lines inside their own `mask: "lines"` wrappers (not the whole heading), and that the mask wrapper has `overflow: clip` with enough `padding-block` for Instrument Serif descenders.
4. **HUD pills land on the headline.** "Left palm · Tap" sits on the word "buttons" with a white dot over the "L": `r2/art-dark-02.png`. "Left palm · Run macro" overlaps "layers.": `r2/art-dark-25.png`. Detector hits at 1280, 1920, 2560 and 390 in the same chapters (`Mute call, pause music` over "your layers.", `Left grille` over "Your apps,"). Fix unchanged from round 1: keep pills out of the copy column, or anchor copy to the side the laptop is not on.
5. **3D labels render off-screen at every width.** "Left grille · Tap" at x -139 (1920), -166 (2560), -310 (390); "Left edge · Tap" at x 2083 (1920) and 580 (390); "Next sheet" at x 1397 to 1474 on 1440. Shots: `r2/1920x1080-03.png`, `r2/390x844-03.png`, `r2/art-dark-19.png`. Clamp label screen positions to the viewport minus 16px, or hide labels whose anchor is off-frame.
6. **Mobile compatibility table still overflows** on `/compatibility/` at 390px: "Lid and tilt", "Light sensor", "Camera add-on" headers at x 340 to 528. Shot: `r2/sub_compatibility_-390x844-1.png`.
7. **Reduced motion still animates the 3D.** Orange ripples and key glow keep playing in `r2/reduced-02.png`, `-07.png`, `-08.png`. One canvas instead of six (better), and the round 1 missing-stills 404s are gone.
8. **No theme control on mobile** (still `false`); it is in the footer only.

Clean this round: no console errors or warnings on any page (the `THREE.Clock` and `currentColor` warnings are gone), no failed requests, no 404s, no hydration errors, no WebGL context loss, CLS 0.0000 to 0.0066 on all viewports, theme toggle correct and persistent with no flash on reload, 45 of 45 Tab stops show a focus ring (the round 1 email input issue is gone because the input moved), all subpages return 200, no horizontal page overflow. The header-over-content collision from round 1 is fixed by the floating pill nav (only 1 residual hit: `/faq/` at 1440, the "Guide" link overlaps the H1 "Asked often." by 550px² when scrolled 150px).

### Performance (M5 Pro, Metal, 1440x900)

| measure | round 1 | round 2 |
|---|---|---|
| Canvas mounted | 13 ms | 365 ms |
| First WebGL draw | 209 to 219 ms | 441 to 662 ms (466 in the perf run; 470 at 390x844) |
| LCP | 28 ms | 80 ms |
| Cold scroll pass p50 / p95 / p99 / max | 16.7 / 16.7 / 16.8 / 50 ms | 16.7 / 16.7 / 16.8 / 50 ms (1 frame > 32 ms, at y 1606 entering "how") |
| Warm passes | 0 to 1 long frames | 0 long frames, max 16.8 ms |
| 4x CPU throttle pass | not run | p99 16.8 ms, 0 frames > 32 ms |
| JS heap growth over 3 passes (after GC) | +7.4 MB | +1.9 MB (21.5 to 23.4 MB) |
| WebGL buffers after pass 1 / 2 / 3 | 971 / 1,291 / 1,443 | 406 / 430 / 454 |
| Programs compiled | 96 | 92 (all during pass 1) |
| Canvases on `/` | 6 | 1 |

Reading:
- Scroll is smooth on this machine even at 4x CPU throttle. The one remaining hitch is the first entry into the "how" chapter (shader compile). Precompile with `gl.compileAsync` during the intro.
- The buffer leak shrank from ~150 to 24 new buffers per pass. Still growing linearly; likely the HUD pill or label geometry recreated per chapter.
- **Load is still the weakest moment.** Filmstrip `r2/load.jpg`: black until ~600 ms, then the whole frame jumps in one step to a mid-grey backdrop, then for the next 3+ seconds the only thing on the right half is a faint cluster of orange dots about 40px wide. At rest on the first screen there is **no laptop and no logo**: `r2/art-dark-00.png` is a big headline on an empty grey field. The laptop only appears after the first scroll. For a site whose client complaint is "the laptop loading is bad", the first screen has to show the object. Fix: have the particles converge into the laptop (or the logo) within the first 1.5 s without scroll, fade the backdrop light up from `--bg` over 900 ms instead of a step, and show a poster frame of the laptop in CSS behind the canvas until the first draw.

### Art direction

**Verdict:** a real step up. The page now has a point of view: one object, one sentence per screen, macro camera moves, a quiet footer. The keyboard macro (`r2/art-dark-07.png`) and the lit laptop in `r2/art-dark-06.png` are the first frames that look premium. What still holds it back: the first screen is empty, text sits on the object without protection, the orange is everywhere, and the subpages fall back to the old SaaS layout.

**Words per viewport on `/` (1440x900):** 4 to 20 on almost every screen (nav counts 4), 26 to 37 on the "Your apps, your layers" screens (HUD pills and labels add most of it), 47 to 51 on the last screen with the footer. Target met on most of the page. Subpages are dense by design: `/guide/` 75 to 111, `/pricing/` 55 to 179, `/privacy/` 93 to 186, `/compatibility/` 75 to 94, `/faq/` 50 to 77.

**Specific fixes, in order of impact:**
1. **Empty first screen.** See load above. The hero needs the laptop (or the formed mark) on screen at rest. Right now it reads "big serif headline on a grey gradient", which is the template the client wanted gone.
2. **Headline legibility over the object.** White serif at 400 weight sits directly on light aluminum and lit keys: "Every blank surface is a key." over the keyboard (`r2/art-dark-07.png`, `-08.png`), "The blank space is the interface." over the palm rest (`r2/art-dark-34.png`, `-35.png`, light theme `r2/art-light-13.png`, mobile `r2/390x844-14.png`). Thin serif strokes vanish against the aluminum highlights. Either frame the camera so copy always lands on the dark backdrop, or add the brief's radial light-well (darken, not a panel) behind the copy at 40 to 60 percent.
3. **Too much orange.** The accent is supposed to mean "a touch was felt" and appear nowhere else. Now it is: glowing seams between keys (`-07`), full-deck ripple rings that cross the trackpad (`r2/art-dark-24.png`, `r2/390x844-10.png`), orange lava cracks over the keyboard in the layers chapter, the spreadsheet cell border. Keep one ring at the touch point per tap, no inter-key glow, no rings crossing other zones.
4. **Rainbow zone colors in the on-screen app UI.** The laptop screen shows the Ghostkeys app with blue, green, purple and pink zone outlines and dots (`r2/reduced-04.png` is the clearest). That is the palette `docs/review/APP_CRITIQUE.md` item 1 already rejects. Use the monochrome zone styling in the screen texture too.
5. **Dead scroll.** Three consecutive screens show only the back of the lid with no copy or label (`r2/art-dark-12.png` to `-14.png`, 1,000px), and four near-identical screens of the laptop drifting with no copy between "layers" and "Go on. Tap it." (`r2/art-dark-27.png` to `-30.png`). That is 7 of 37 positions with nothing happening. Either shorten those holds by half or give each one a single mono label and a camera move.
6. **The lid shot** (`r2/art-dark-10.png` to `-14.png`, mobile `-04`, `-05`) is a flat navy panel with a dot grid and a hairline outline. It reads as a placeholder next to the good keyboard shots. Give the lid real anodized material (same aluminum, not navy), the logo, and a single ring where a knuckle lands.
7. **Subpages still look like the old site.** `/pricing/` is a three-column table with the Pro column on a raised background (a boxed pricing table), a five-column fine print strip, "Compare every feature", and a portrait video box that looks like an Instagram story embed (`r2/sub_pricing_-1440x900-0.png`, `-1`). `/privacy/` is the 6-row list at 186 words a screen. Bring them to the home page's language: one idea per screen, big numerals, the rest behind disclosures.
8. **Hero headline weight.** "Your laptop has more buttons." at the 120px step in a light serif, left aligned at column 1, with a tiny "Download for Mac" text link underneath: elegant, but the CTA is so quiet it is easy to miss, and the column-1 left alignment repeats on every chapter. The brief asks for content on column 3 or 7, deliberately asymmetric. Alternate chapter copy between column 1 and column 7.

**Motion:** chapter swaps and camera moves feel authored now. Problems are the overlapping exit lines (bug 3), pills that pop in without easing, and the load step.

**Material and lighting:** much better. The aluminum has a specular ramp, the chamfer catches a light line, the keyboard macro has depth. Remaining: the deck still goes flat white in the 3/4 views (`r2/art-dark-06.png`, palm rests are almost pure `#D0D0D0` with no gradient), there is no contact shadow under the laptop, and the navy lid color does not match the silver deck (light theme `r2/art-light-04.png`, `-05.png` makes the mismatch obvious).

### Round 1 items, re-checked
- Fixed: header colliding with content; reduced-motion feature copy invisible (section removed); 404 stills; console warnings; blank screen after the pin (now "dead scroll" holds, item 5 above); email input focus ring; 6 canvases down to 1; long page and text density on `/`.
- Still open: placeholder CTAs (now worse: they point at a missing anchor), HUD pills over headlines, labels off-screen, mobile compatibility table overflow, reduced motion still animating, no mobile theme control, load pop.

### Top 5 for the builder right now
1. All Download buttons and the skip link are dead (`#pricing` no longer exists on `/`).
2. Reduced motion stacks every chapter headline on top of each other.
3. First screen has no laptop and a black-to-grey pop at ~600 ms.
4. Exit lines of headlines overlap the next line; HUD pills and 3D labels overlap copy or go off-screen.
5. Headline legibility over the aluminum, and the orange accent is used as decoration instead of only for touches.

---

## Round 1: 2026-09-26 17:24 local (build of `web/` as of 17:23)

### Bugs (fix first)

1. **Reduced motion: feature copy never appears.** With `prefers-reduced-motion: reduce`, every feature row's text (`#features li [data-row-in]`) stays at opacity 0. Scrolled 5,700px past the first row and it was still 0. Cause: the rows' `gsap.from(..., scrollTrigger)` triggers are measured before the reduced-motion story (`#story`, 5 extra sections) is inserted, and nothing calls `ScrollTrigger.refresh()` in the reduced path. Shot: `r1/reduced-03.png` (left column empty, mini laptop still animating). Fix: call `ScrollTrigger.refresh()` after `tier.ready` in every path, and under reduced motion skip the `from` tweens entirely (render final state).
2. **Reduced motion / no-WebGL stills are missing: 5 x 404.** `/stills/{feel,zones,calibrate,layers,beyond}-dark.avif` and the `hero` still do not exist in `public/`. The reduced-motion story shows empty 16:10 holes and console errors. Also only `-dark` variants are referenced; light theme would need `-light`. Shot: `r1/reduced-02.png`.
3. **Reduced motion still runs WebGL and motion.** 6 canvases mount and the Features mini laptop keeps looping tap animations. Brief 4(g) says no particles and a still image. Gate `MiniStage` and `GestureTrace` animation on reduced motion.
4. **Fixed header collides with content.** The header background is `linear-gradient(var(--bg) 30%, transparent)`, so the nav row sits on a half-transparent band and page text scrolls straight through the links. Visible at every section boundary: `r1/art-dark-27.png` ("Once, twice or three times" runs through "How it works / Features / Try it"), `r1/art-dark-29.png` ("your Mac." under the nav), `r1/art-dark-33.png`, `r1/art-dark-36.png`. Fix: hide the nav on scroll down and show on scroll up, or give the nav row a solid `--bg` band 64px tall with the fade below it, or reduce the header to wordmark + one button with `mix-blend-mode: difference`.
5. **HUD pills overlap the story headline.** In chapter 04 the 3D HTML pill "Left palm · Paste values" sits on top of the H2 "Each app gets its": `r1/art-dark-08.png`. In chapter 05 three pills stack over the laptop screen: `r1/art-dark-10.png`. On mobile a lone pill "Light sensor · Do not disturb" floats in an otherwise empty screen after the laptop has left: `r1/mobile-contact.jpg` (5th tile, `390x844-04.png`). Fix: keep pills out of the left 50% of the viewport on desktop, show max one at a time, and hide them when their anchor is off-frame or the chapter is ending.
6. **A fully blank viewport after the pinned story.** At y≈7,990 (1440x900) the whole screen is empty `--bg`: `r1/art-dark-12.png`. The pin ends, the canvas section is gone, and the Specs section has 160 to 200px top padding plus the pin tail. Either start Specs immediately, or let the laptop exit into the next section (the section transition from brief 4(e)).
7. **Hero particles are neither a logo nor a laptop after any scroll event.** After load the logo forms at ~3s (`r1/load-contact.jpg`, last two tiles), but after a single programmatic scroll back to 0 the cloud is a formless smear: `r1/art-dark-00.png`. Returning to the top should re-form the mark (or the laptop), not leave dust.
8. **Mobile (390x844) horizontal clipping.** Compatibility table columns run off the right edge ("Lid and tilt", "Light sensor", "Camera add-on" at x 345 to 656; "Later" cut to "Late"): `r1/390x844-10.png`. Zone labels in the 3D scene render off-screen ("Left palm" at x -39, "Right palm" to 415, "Play or pause" at -36): `r1/390x844-01.png`, `r1/390x844-03.png`. Fix: on mobile turn the table into one row per Mac with a 4-dot mono status line, and clamp 3D labels to the viewport.
9. **Mobile story headline cut mid-reveal.** "Twenty taps per zone. Three" is sliced by its line mask while the laptop covers the frame: `r1/390x844-02.png`. The chapter copy overlaps the 3D and has no light-well protection on mobile.
10. **Placeholder links make every CTA a dead end.** `lib/site.ts`: `DOWNLOAD_URL`, `BUY_URL`, `SALES_URL` all = `#pricing`, `SOURCE_URL` = `#privacy`. Clicking "Download" on the pricing section scrolls to itself; "View the source" jumps back up to Privacy. Not a code bug but it will read as broken in any review. Use a real URL or a disabled state with "Coming soon" in mono.
11. **Email input has no visible focus ring.** Tab stop 14 (`input` in the hero waitlist): `outline: none`, no box-shadow. Every other stop has a 1px `--ink` outline.
12. **No theme control on mobile.** The header radiogroup is `hidden md:flex`; on 390px the only switch is in the footer. Minor, but brief 5 calls theme a first-class control.
13. **Console warnings on every load:** `THREE.Clock: This module has been deprecated` (x3, from R3F/drei), `THREE.Color: Unknown color currentColor` (x1: something passes the CSS keyword `currentColor` to a three color; find the `color="currentColor"` prop in a three component). No errors, no failed requests (except the 404s above), no hydration errors, no WebGL context loss in any run.

Checked and clean this round: CLS 0.0000 to 0.0004 on all viewports (below 0.1 by a wide margin; the only shifts are the progress bar `scaleX` in the story chrome, value 0); theme toggle Light / Dark / Auto sets `data-theme`, body colors match tokens exactly (`#F4F4F1` / `#0A0A0B`), persists to `localStorage`, and applies before first paint on reload (no flash); focus is visible on 44 of 45 tab stops; all in-page anchors resolve; no horizontal page overflow at any desktop size.

### Performance (M5 Pro, Metal, 1440x900, DPR 1 in page, canvas at 1.5x)

| measure | value |
|---|---|
| First contentful paint | 28 ms (local server) |
| Canvas mounted | 13 ms after navigation start |
| First WebGL draw into the hero canvas | 209 to 219 ms desktop, 485 ms at 390x844 |
| Particles visible | ~600 ms |
| Logo fully formed | ~3.0 s |
| Idle frame rate at top | 60.5 fps |
| Cold first scroll pass p50 / p95 / p99 / max | 16.7 / 16.7 / 16.8 / 50 ms, 2 frames > 32 ms |
| Warm passes 2 and 3 | 16.7 / 16.7 / 16.8 / 49.9 and 16.8 ms, 1 and 0 frames > 32 ms |
| Worst single frame seen (earlier cold run same build) | 350 ms at the top of the story, 150 ms entering Features, 100 ms entering Demo; 13 frames > 32 ms in one pass |
| JS heap before / after 3 full passes (after GC) | 21.6 MB / 29.1 MB (+7.4 MB, stable between passes 2 and 3: 36.5 then 35.2 MB) |
| WebGL buffers created / deleted | 971 / 11 after pass 1, 1,291 / 16 after pass 2, 1,443 / 21 after pass 3 |
| WebGL programs compiled | 72 in the first pass, 96 total |

Reading:
- **Load pop-in.** From 122 to 464 ms the frame is flat black. At ~600 ms the whole canvas jumps in one frame from `#0A0A0B` to a mid grey studio backdrop (~`#3A3A3A`) with scattered points: a hard brightness step, not a fade. Filmstrip: `r1/load-contact.jpg`. Fix: render the first frames with the backdrop at `--bg` and tween the backdrop light in over 900 ms with `--ease-out`, starting only once the particle FBO has its first frame. Better: paint the page background with the same radial light in CSS so the canvas has nothing to reveal.
- **First-scroll hitches come from shader compiles.** 72 programs compile during the first pass as new scenes and the Features `MiniStage` mount. Warm passes are clean. Fix: `gl.compileAsync(scene, camera)` (or `renderer.compile`) for every chapter's materials during the logo formation, and mount `MiniStage` earlier (idle callback) instead of at `100%` rootMargin.
- **WebGL buffer leak.** About 150 to 320 new buffers per pass with almost none deleted. Likely geometries created in render (drei `Text`/`Html`, or `new BufferGeometry` in a component that re-renders on `setActive`). Heap is stable, so it is GPU-side only; still, a long session will climb. Find `new *Geometry` inside render paths or components keyed by the active row.
- Scroll itself is smooth on this hardware: every warm frame is 16.7 ms and Lenis moves 43 to 49 px per frame at the test speed. The M5 Pro hides a lot; round 2 adds a 4x CPU throttle run.

### Art direction (Awwwards-jury critique)

**Verdict:** it is well built and it still reads as a very good template. The story chapters are the only part that feels authored; everything after the pin is a long SaaS page set in nicer type. The client said "too much text" and the numbers agree.

**Words per viewport (1440x900, target under 12 outside pricing):**

| screen | words | shot |
|---|---|---|
| Hero | 52 (+ nav 12) | `r1/art-dark-00.png` |
| Story chapters 01 to 05 | 22 to 35 | `r1/art-dark-01..11.png` |
| Specs | 45 to 48 | `r1/art-dark-13.png` |
| Features (12 rows, 8,100 px tall) | 25 to 77 | `r1/art-dark-15..26.png` |
| Demo | 26 to 56 | `r1/art-dark-27..28.png` |
| Privacy | 118 to 160 | `r1/art-dark-29..30.png` |
| Compatibility | 94 | `r1/art-dark-31.png` |
| Pricing | 108 to 190 | `r1/art-dark-33..34.png` |
| FAQ | 46 to 57 | `r1/art-dark-35..36.png` |

Not one screen is under 12. Only one screen (the blank one) is under 20.

**What looks like a template (fix in this order):**
1. **Hero = centered-left headline, paragraph, primary button, email field + secondary button, "scroll" hint, full nav, sound toggle, 3-way theme pill, second Download button.** That is 11 interactive or text elements competing with the particles. Cut to: wordmark top left, "Download" top right, the headline, nothing else. Move the paragraph into chapter 01. Move the waitlist to the footer. Kill "Scroll to look inside" (the counter already says where you are). Target: 8 words.
2. **Specs is a stat row** (4 big numerals in a 2x2 grid with labels and right-aligned notes): `r1/art-dark-13.png`. This is the most recognisable SaaS pattern on the page. Either make it one numeral per screen (184px "800", one mono label, nothing else, scrubbed with the laptop still behind it) or drop it; the story already says 800 and three minutes.
3. **Features = 12 rows x 630 px with a boxed video panel on the right.** The right-hand mini laptop sits in a hard-edged grey rectangle (`r1/art-dark-15.png`, `r1/art-dark-18.png`) that reads as an embedded video card, and its top is cut off under the header in `-18` and `-25`. 8,100 px of scroll for 12 near-identical rows is the single biggest "too much text" offender. Fix: 4 rows maximum (palm rests, grilles and edges, per-app layers, composer), no label + title + paragraph stack: one 28px sentence per row, mono number, no body copy. Drop the panel box: put the mini laptop in the persistent canvas with no frame, lit by the same radial light as the hero.
4. **Privacy = 6 rows with 20-word descriptions (160 words on one screen).** Keep the 120px headline "Nothing leaves your *Mac.*" alone on screen, then 3 rows of 4 to 6 words each ("On your Mac. Only.", "No account.", "Open-source core.") with the long text behind a disclosure.
5. **Pricing = three columns with vertical dividers, a five-column fine-print strip, a "Compare every feature / 53 features" expander, then a second FAQ ("About paying") before the real FAQ.** It is a boxed pricing table without the boxes. Two FAQs on one page is redundant. Show one price, huge: "$29, once." with the free tier as one mono line under it. Fold "About paying" into the FAQ.
6. **Demo** uses native `<select>` dropdowns (`r1/art-dark-27.png`, bottom right). They render as default OS form controls and break the instrument look instantly. Replace with the mono segmented / popover style from the header toggle, or cut the binding table and keep only "click the metal".
7. **Two FAQs, a footer with a second 72px headline, a second big wordmark, a theme switch and a legal line** (`r1/art-dark-36.png`). The footer headline "The *blank* space is the interface." is the best line on the site; give it the whole last screen with nothing else except the Download button.

**Typography.** Geist display at 72 to 120px with -0.035em tracking and Instrument Serif italic accents is correct and well set. Problems: (a) the hero headline wraps to 5 lines at 1440 ("Your laptop / has more / buttons / than you / *think.*"), making a tower instead of a line; at 1440 it should be 2 lines max, so drop to the 72 step or widen the column to 9 columns; (b) serif accents appear in nearly every H2 (feels, key, your, layout, Cover, happens, Mac, tap, all, blank); the brief allows one or two words per page, not per heading. Keep it in the hero and the footer only; (c) body copy at 20px `--ink-2` sits on busy 3D in the story (`r1/art-dark-01.png`: "It reads 800 times a second..." over the palm rest) with contrast that drops below 3:1 over the aluminum highlights.

**Composition and negative space.** Story frames compose well (headline bottom left, laptop top right). After the pin the page goes to a 2-column editorial grid for the rest, with the content always starting at column 3; that becomes monotonous. Space is spent in the wrong place: a full blank screen after the pin, 160 to 240px padding around text-dense sections, but the heavy sections themselves are packed.

**Motion.** The scrubbed chapter swaps are good (lines rise out of masks, counter and hairline progress bar are right). Weak points: the hero particle cloud does not resolve into anything after a scroll (bug 7); the copy swaps at chapter ends are a hard `set(autoAlpha: 0)`; the 3D HUD pills pop without easing; the Specs count-up is the stock counter effect.

**Laptop material and lighting.** This is the weakest part and what the client means by "the laptop loading is bad, not premium".
- The aluminum reads as flat grey plastic: almost no specular response, no anisotropic brushed streak, no edge highlight on the chamfer, no contact shadow on the desk. Compare `r1/art-dark-01.png` to any Apple product shot: there the edge catches a thin white line and the deck has a soft gradient; here the deck is one grey value with a hard light-to-dark ramp across the palm rest.
- The "x-ray" view in chapter 01 shows the logic board through a transparent deck, but the lid is a flat dark trapezoid and the screen behind is visible through it, so the object reads as broken geometry rather than a cutaway (`r1/art-dark-01.png`, top left).
- Keyboard caps in top-down views are blurry and low-res (`r1/art-dark-03.png`, `-07.png`); legends are soft at 1440. Use a higher-res keycap atlas or real geometry legends; they are the first thing an Apple-literate viewer checks.
- The orange `--signal` "trace" lines that snake across the keyboard (`r1/art-dark-03.png`, `-07.png`, `-08.png`) look like a rendering artifact. The brief's touch light is a ring on the metal at the point of contact, not a line crossing keys.
- The lid close-up (`r1/art-dark-05.png`) is a dot grid on a flat panel with a thin outline: reads as a wireframe placeholder.
- The backdrop is a mid-grey studio (#3A3A3A range) while the page is `#0A0A0B`, so the hero section is visibly a lighter box and the seam shows when it unpins. The brief says near-black void with light only near the object.
- Fixes: `MeshPhysicalMaterial` metalness 1, roughness 0.28 to 0.35, anisotropy 0.6 with a brushed normal map; one soft-box area light from top-left plus a thin rim light from behind for the chamfer line; an HDR environment (a small studio `.hdr`, not `preset="city"`); contact shadow (`<ContactShadows opacity={0.5} blur={2.4}>`); backdrop `--bg` with a 4 to 6 percent radial light behind the laptop only.

**Light theme** (`r1/art-light-02.png`): the laptop turns into a flat mid-grey shape on off-white with thin brown zone outlines; no highlights at all. Light mode needs its own lighting rig (lower exposure on key light, darker environment) or the object looks like a silhouette.

### Top 5 for the builder right now
1. Header/nav collides with scrolling content on every section boundary (bug 4).
2. Reduced-motion path is broken: invisible feature copy, 5 missing stills, WebGL still running (bugs 1 to 3).
3. Text density: no screen is under 12 words; cut hero to headline only, Features to 4 rows, Privacy to 3 short rows, Specs out.
4. Laptop material and lighting read as grey plastic on a grey box; load has a hard black-to-grey pop at ~600 ms.
5. HUD pills overlap headlines and float orphaned on mobile; blank screen after the pin.
