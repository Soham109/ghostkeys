# Ghostkeys web: QA and art-direction review

Owner: web QA agent. Read-only on `web/`. Every round builds a private copy of the latest `web/` source (`next build`, static `out/`), serves it on port 4801, and drives it with Playwright Chromium on the Metal GPU (`ANGLE Metal Renderer: Apple M5 Pro`, not SwiftShader). Screenshots live in the QA scratch folder named per round:
`/private/tmp/claude-501/-Users-sohamaggarwal/5865e2c2-7871-49a1-8e02-7f828d1f782d/scratchpad/rounds/rN/shots/`
(short name below: `rN/<file>`).

Harness: `scratchpad/qa.mjs` (5 viewports x 15 scroll positions, 37 dark + 15 light art positions, load filmstrip, 3 scripted wheel passes through Lenis with in-page rAF timing, heap after forced GC, WebGL object counters, theme, reduced motion, 45 Tab presses, link check).

Newest round first.

---

## Round 5: 2026-09-27 00:51 local (build of `web/` as of 00:51), plus the live deploy

Same method, run at `nice -n 10`, checking the thermal log and load before every heavy step (load stayed between 3.4 and 7.8; there were no thermal warnings). New this round: snap regression with real mouse-wheel input both directions (`scratchpad/snap5.mjs`), a whole-page flicker scan that records every compositor frame through CDP screencast and scores one-frame flashes (`flicker.mjs`, `flicker.py`), a waitlist sheet test (`sheet.mjs`), a light-theme sweep at all 5 viewports, and a local vs live comparison against https://ghostkeys-nine.vercel.app (`live.mjs` plus `curl -I`). Shots: `scratchpad/rounds/r5/` (dark) and `rounds/r5light/` (light).

### Bugs (fix first)

1. **The knock beat still strobes, and in light theme it is a full-screen white/black strobe.** In the sound chapter the whole WebGL frame drops to near-black for single frames, repeatedly:
   - 1440x900 light, scrolling through y 4,573 to 4,901: 8 alternations between mean luminance ~155 and ~17 in about 0.4 s. Filmstrip `r5/flicker-light.jpg` (frames 372 to 389): scene, black, black, scene, and so on.
   - 1920x1080 light, y 5,494 to 5,745: luminance 161 to 12 and back, 8 times.
   - 1440x900 dark, y 4,536 to 4,863: luminance 33 to 5 and back, 12 times, on alternate frames.
   - **It also happens with the page parked, not only while scrolling.** Parked at y 4,550 for 2 s: 21 of 120 frames black in light, 16 of 120 in dark. Parked at 4,650: 8 and 7. Clean at 4,750 and 4,850.
   - Frame with the black state: `r5light/shots/1920x1080-07.png` (headline over a black void with one radial light, laptop gone).
   A light-to-dark full-screen flash several times a second can trigger photosensitive seizures (WCAG 2.3.1, three flashes per second). This is the one bug that must be fixed before anyone sees the site. Likely cause: something in the sound/knock scene toggles the renderer's clear or scene visibility on a per-frame condition near the beat boundary (for example a threshold on smoothed chapter progress that oscillates). Nothing else on the page flickered: the only other brightness steps are the intended chapter cuts (y≈2,381 and y≈1,487).
2. **Duplicate guide articles.** `web/content/guide/` now has 13 copies named `"01-getting-started 3.md"` to `"13-developers 3.md"` (byte-identical to the originals; they look like Finder or iCloud sync conflict copies). The build turns them into 13 extra pages at URLs with a space (`/guide/actions 3/`), and `/guide/` lists every article twice ("01 Getting started, 02 Getting started, 03 Calibration, 04 Calibration..."). `web/.next/` also has dozens of `"* 2.json"` copies, and so does `web/screenshots/`. **The live deploy does not have this yet** (live `/guide/actions%203/` is 404 and live `/guide/` lists each article once), so the next deploy from `web/` would ship it. Delete the `* 3.md` files (the lead's call, since QA does not touch `web/`) and consider a build check that fails on filenames with a space.
3. **Mobile dark theme: the page is 469px wide on a 390px phone.** `innerWidth` and `scrollWidth` are 469 on `/` at 390x844 in dark theme (390 in light). The cause is `.scrim` in `app/globals.css:299`: under 767px it is `left: -20vw; width: 140vw`, so it runs from -78 to 468px. Light theme overrides the width to 62vw, which is why light is fine. Phones can pan sideways and the nav pill sits off-centre (`r5/shots/390x844-01.png`). Fix: `overflow-x: clip` on the chapter sections (or `body`), or keep the scrim inside 100vw.
4. **The waitlist sheet promises an email that can never be sent.** The copy says "Leave your email and we'll email you when the Mac download is ready", and after submitting, "Saved. You're on the list." But `GetSheet.tsx` only writes to `localStorage` (`gk-mac-waitlist`), so nobody ever receives the address. The idle line ("Kept in this browser until signup opens. Nothing is sent yet.") is honest, but it disappears once the visitor submits. Anyone who signs up will believe they are on a list that does not exist. Wire a real endpoint, or change the saved message to "Saved in this browser only. Nothing was sent." and drop "we'll email you".
5. **Waitlist sheet: the page scrolls behind the open sheet.** A 600px mouse wheel over the open dialog scrolls the page 415px on `/`, `/pricing/` and `/guide/getting-started/`. Lenis keeps handling wheel events while the modal is open. Call `lenis.stop()` on open and `lenis.start()` on close.
6. **Waitlist sheet: the email input has no visible focus ring** (the Tab cycle shows `ring: false` on the input, while Close and Notify me have one). On phones the input is 14px, so iOS Safari zooms the page when it is focused. Use 16px on mobile and a 1px `--ink` outline on `:focus-visible`.
7. **Mobile light theme: headlines in dark ink sit on the black laptop screen.** "Every blank surface is a key." (`r5light/shots/390x844-02.png`, `-03.png`) and "A different layout for every app." (`r5light/shots/390x844-10.png`) are dark grey on a near-black display and cannot be read. In the hero at y 497, the fading "Download for Mac" button and "FREE TO START" sit on top of the laptop (`r5light/shots/390x844-01.png`).
8. **Mid-reveal slices at rest points** (minor now): "touching it." cut at `r5/shots/art-dark-14.png` and "A different" cut at `r5/shots/art-light-11.png`, `r5light/shots/1920x1080-09.png`.
9. **Reduced motion:** "A different layout for every app." still scrolls over the bright hand-wave still (`r5/shots/reduced-06.png`); the new scrim does not reach it.
10. **Small ones:**
    - The skip link is now "Skip to download" and opens the waitlist sheet. A skip link should skip to the main content.
    - `/compatibility/` is still built but nothing links to it any more (it was dropped from the single-row footer). Link it or remove the route.
    - No theme control in the mobile nav; the pill shows "AUTO" as plain text.

### Verified fixed

- **Snap spring-back: fixed.** Real mouse wheel, 1 / 3 / 5 notches, from the top, three mid-page beats and the bottom, both directions, at 1440 and 1280: every input moves the page (70px per notch) and **0px of pull-back in all 64 cases**. 38 trackpad-like flicks go from top to bottom and 37 go back up, with 0px pull-back. Forward snap only adds small nudges in the direction of travel (for example 3 notches from 3,623 land at 3,911, not 3,833). Pacing now feels right.
- **Hero headline moves as one block:** at y 503 the hero is a single fading block with no line overlap (`r5/shots/art-dark-02.png`).
- **Purchase paths no longer loop:** every Download and Buy link on all 18 pages now points at the sheet (tested by click on `/`, `/pricing/`, `/faq/` and `/guide/getting-started/`); the Pro variant shows the Pro copy. The sheet opens with Enter from the keyboard, focus lands on Close, Tab stays inside (one stop goes to the page body before wrapping, which is normal for a native `<dialog>`), Escape and a backdrop click close it, focus returns to the trigger, invalid and valid emails get the right messages, and it fits at 390px (352px wide, 19px margins). Screens: `r5/sheet/sheets.jpg`.
- **Footer** is a single row at 1440 (`r5/shots/art-dark-36.png`).
- **Everything else clean:** 0 console errors or warnings, 0 failed requests and 0 hydration errors across all pages and viewports, no WebGL context loss, CLS ≤ 0.0074, theme toggle correct with no flash, 43 of 43 Tab stops with a focus ring, reduced motion renders stills with 0 canvases.

### Performance (M5 Pro, Metal, 1440x900)

| measure | round 4 | round 5 |
|---|---|---|
| First WebGL draw | 448 ms | 459 ms |
| LCP | 104 ms | 100 ms |
| Cold / warm / 4x-throttled scroll p99, max | 16.8, 16.8 ms | 16.8, 16.8 ms, 0 frames > 32 ms |
| JS heap growth over 3 passes | +1.4 MB | +1.4 MB |
| WebGL buffers after passes 1 / 2 / 3 | 458 / 458 / 458 | 453 / 453 / 453 (no leak) |

### Live deploy vs local build

- **Content and visuals match.** Page text is identical on `/`, `/pricing/`, `/faq/`, `/privacy/` and `/compatibility/`, and screenshots differ by 0.0 to 0.3 percent of pixels at y 0, 1,500, 4,200, 9,000 and on the subpages. The only text difference is `/guide/` (bug 2: local has the duplicates, live does not). No console errors on live. All fonts load on live (Switzer 200 to 500, Fragment Mono).
- **Caching is wrong on live.** Every file, including content-hashed ones, is served with `cache-control: public, max-age=0, must-revalidate`: `/_next/static/chunks/*.js`, `/_next/static/media/*.woff2`, `/hdr/studio.hdr` (1.7 MB), `/stills/*.avif`, `/video/teaser-540.mp4`. Every repeat visit revalidates every asset. The deploy looks like a plain static-folder upload, so Vercel's usual `immutable` headers for Next are missing. Add a `vercel.json` `headers` rule: `/_next/static/(.*)` gets `public, max-age=31536000, immutable`; fonts, the HDR, stills and video get at least `max-age=86400`.
- **Missing on live:** `/robots.txt` and `/sitemap.xml` both 404. There are no `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` or CSP headers (HSTS is present). No `og:image` or canonical link on `/`. None of these are visible to visitors, but they matter for link previews and search.
- Compression (brotli) and content types are correct. The page cache showed `age: 19143` on `/`, so the live build is about 5 hours old.

### Top 5 for the builder right now
1. Knock beat strobe (white/black flashes several times a second in light theme, also while parked). Fix before anyone sees it.
2. Delete the 13 duplicate `* 3.md` guide files before the next deploy; `/guide/` lists every article twice.
3. Mobile dark page is 469px wide (`.scrim` 140vw); add `overflow-x: clip`.
4. Waitlist sheet: remove the false "we'll email you" promise, stop Lenis while it is open, add a focus ring and a 16px input on mobile.
5. Mobile light theme: dark headlines on the black laptop screen are unreadable.

---

## Round 4: 2026-09-26 19:14 local (build of `web/` as of 19:13)

Same method (copy of `web/`, `next build`, port 4801, Chromium on Metal). Added this round: a scroll-snap test (`scratchpad/snap.mjs`, `snap2.mjs`) using both synthetic wheel events and real mouse-wheel input through Playwright, and a full crawl of every internal page and link (19 pages including all `/guide/*` articles).

### Bugs (fix first)

1. **Mouse-wheel users get stuck on the first screen (snap pulls them back to the top).** Real mouse-wheel input, 1440x900, starting at the top:

   | input | where it settles |
   |---|---|
   | 1 notch (100px) | 0 (moved, then pulled back) |
   | 3 notches, 250 ms apart | 0 |
   | 3 notches, 120 ms apart | 0 |
   | 5 notches, 120 ms apart | 350 |
   | 8 notches, 80 ms apart | 560 |

   A gentle trackpad swipe (about 150px of travel) also returns to 0, 30 times out of 30, at both 1440x900 and 1280x800. The same happens at the bottom: 30 of 30 small upward swipes spring back to the last beat (9005 at 1440, 8004 at 1280). So a normal person who scrolls one or two notches at a time sees the page nudge and bounce back, and believes it is broken.
   Cause: `Experience.tsx:100` uses `Snap(lenis, { type: "proximity", distanceThreshold: "32%", debounce: 180 })` and `beatPositions()` in `lib/chapters.ts` always adds `0` and the page end as beats. The next beat after 0 is at 1,283px, so anything that settles within 288px (32 percent of 900) of the top is pulled back to 0.
   Fix, in order of preference: drop `0` and the page end from the beat list (the intro and footer should scroll freely); make snap directional (only snap forward in the direction of the last input); or add a beat at the end of the intro pin so the first beat is within reach. Re-test with 1 and 3 notches from the top.
2. **Mid-page, one notch is also undone.** From a beat at 1,300, one notch ends at 1,283 (moved 17px backwards); from 3,600 one notch moves only 23px. Scrolling slowly, a step at a time, does nothing until the user pushes harder. With the fix to bug 1 in place, consider `distanceThreshold` around 20 percent so single notches between beats are allowed to rest.
3. **Hero headline overlaps itself when the page rests between beats.** At y=503 (1440x900) "Your MacBook" sits across "has more": `r4/art-dark-02.png`. Snap does not correct this position (503 is more than 288px from both beats), so users land here. Same at 390x844 (`r4/390x844-01.png`, top lines ghosted) and mid-reveal slices at `r4/art-dark-14.png` ("touching it." cut) and `r4/art-light-11.png` ("A different" cut). Fix: finish the exit tween before the first beat, or make lines fully in or fully out between beats.
4. **Every purchase path loops back to the pricing page.** `lib/site.ts`: `DOWNLOAD_URL = "/pricing/"`, `BUY_URL = "/pricing/#tiers"`, `SALES_URL = "/faq/"`. On `/pricing/` itself, "Download free" reloads `/pricing/` and "Buy Pro, $19 at launch" scrolls to the table the user is already reading. The links resolve (not 404), but the moment someone tries to buy it looks broken. Use a disabled state with a mono "Available [date]" or a waitlist form until the real URLs exist.
5. **Reduced motion: the next chapter's headline scrolls over the previous chapter's still.** "A different layout for every app." in thin white type sits on the light aluminum of the sound-mode still: `r4/reduced-06.png`. Also `r4/reduced-01.png`. Keep copy and its still in the same block, or give the still a dark lower gradient where copy passes.
6. **Still open from earlier rounds:** no theme control in the mobile nav (`mobileToggleVisible: false`; the pill shows only "AUTO" text at 390px, see `r4/390x844-00.png`, which is not a control).

Clean this round: 0 console errors or warnings on all 19 pages at all 5 viewports; 0 failed requests; 0 broken links or missing `#anchors` across the full crawl; no hydration errors; no WebGL context loss; CLS 0.0000 to 0.0065 (only the nav pill converging, value 0); theme toggle correct and persistent with no flash; 43 of 43 Tab stops have a visible focus ring; mobile `/compatibility/` table no longer overflows; 3D labels no longer render off-screen at any width; no HUD pill overlaps the copy; reduced motion now renders stills with **0 canvases** and no stacked headlines (round 2 and 3 bug fixed).

### Performance (M5 Pro, Metal, 1440x900)

| measure | round 3 | round 4 |
|---|---|---|
| First WebGL draw | 456 ms | 448 ms (461 to 543 across viewports) |
| LCP | 68 ms | 104 ms |
| Cold scroll pass p50 / p95 / p99 / max | 16.7 / 16.8 / 16.8 / 33.3 ms | 16.7 / 16.8 / 16.8 / 16.8 ms, **0 frames > 32 ms** |
| Warm passes, 4x CPU throttle pass | 0 long frames | 0 long frames, max 16.8 ms |
| JS heap growth over 3 passes | +1.7 MB | +1.4 MB (21.6 to 23.0 MB) |
| WebGL buffers after pass 1 / 2 / 3 | 496 / 541 / 586 | **458 / 458 / 458 (leak fixed)** |
| Programs | 107 | 119, all created before the first pass ends; no compile hitch seen |
| Idle fps | 60.5 | 60.5 |

- **The cinematic intro works.** Filmstrip `r4/load.jpg`: black at 100 ms, a macro of the palm rest edge fades up from black at ~600 ms, a touch ring lands with the "Left palm · Play or pause" pill at ~1.9 s, then the camera pulls back to the full laptop by ~2.7 s. No brightness step, no pop-in, no empty frame. This fixes the client's "the laptop loading is bad" complaint.
- Scroll is locked at 60 fps with no long frames even on a cold first pass and at 4x CPU throttle. This machine is fast; a mid-range Intel or M1 Air test is still worth doing before launch.

### Snap pacing: does it feel good?

- **Big gestures: yes.** A reading-speed scroll (small continuous deltas for 2.5 s) moves freely and lands within 76px of where the user stopped. Pulled back 76px at 1440 and 0px at 1280, which is barely noticeable. Snap settles in about 1.0 s after input ends (debounce 180 ms plus the 0.8 s ease), which reads as deliberate and calm.
- **Small gestures: no.** See bugs 1 and 2. The spring-back at the top and bottom is the one thing in this build that feels broken.
- **Touch (390x844, real touch scroll gestures via CDP):** swipes are not fought. 10 of 12 swipes had 0px pull-back and 2 had 82px. Snap settles 0.8 to 0.9 s after the swipe. Fine.

### Art direction (short)

The site now reads as one short film: black void, silver laptop, one line of type per beat, a closing lid at the end. Frames `r4/art-dark-00.png`, `-05.png`, `-07.png`, `-16.png`, `-35.png` are portfolio quality. Subpages now match (`r4/subs.jpg`). Remaining taste issues, none blocking:
- **Dead scroll is shorter but still there**: positions 11 to 13 (lid, about 750px) and 28 to 31 (laptop idling before "Try it here.", about 1,000px) have no copy; 20 to 23 carry only on-laptop labels. Consider halving the second hold.
- The Switzer light at display size is elegant but thin; over the lit keyboard in `r4/art-dark-07.png` and the palm rest in `r4/art-dark-08.png` it loses contrast. A slightly heavier weight (300 to 400) at display size would hold up.
- On-laptop zone labels are soft and slightly blurred in 3/4 views (`r4/art-dark-01.png`, bottom right). Check they render in screen space, not through the depth-of-field pass.

### Top 5 for the builder right now
1. Snap springs back at the top and bottom: 1 to 3 mouse-wheel notches from the top go nowhere. Remove the `0` and page-end beats, or make snap directional.
2. Single notches mid-page are undone; lower `distanceThreshold` once 1 is fixed.
3. Hero headline overlaps itself at rest positions between beats (y≈350 to 500).
4. Every purchase CTA loops back to `/pricing/`; use an honest disabled or waitlist state until real URLs exist.
5. Reduced motion: headlines scroll over the previous chapter's bright still; add a dark gradient or keep copy with its own still.

---

## Round 3: 2026-09-26 18:22 local (build of `web/` as of 18:19)

Changes since round 2 were in the 3D (`components/three/*`, new `air/` scenes, `director.ts`) and new `public/stills/*.avif`. Nothing in `components/site/`, `lib/` or `app/` changed, so most round 2 site bugs are unchanged.

### Bugs (fix first)

1. **Still open: every "Download" and the skip link are dead.** `#pricing` does not exist on `/`; `lib/site.ts` unchanged. This is the top issue: the primary action of the site does nothing.
2. **Still open: reduced motion stacks "Gesture in the air." on top of "Listen closer."** (`r3/reduced-04.png`, `-05.png`, and "Go on. Tap it." over "The blank" in `r3/reduced-09.png`). Ripples and key glow still animate under reduced motion (`r3/reduced-01.png`, `-08.png`). The new stills exist in `public/stills/` but the reduced path does not show them.
3. **Still open: exiting headline line overlaps the next line at rest.** "Your laptop" sits across "has more" 1.4 s after scrolling stops: `r3/art-dark-02.png` (y=413), `r3/390x844-01.png`; "is a key." sliced at `r3/art-dark-06.png`; end headline sliced at `r3/art-dark-33.png`. HUD pill "Left palm · Tap" still sits on "buttons." in `r3/art-dark-02.png`.
4. **New: two HUD pills stack on each other** in the sound chapter: "Right palm · Knuckle" and "Right palm · Fingertip" overlap by 948px² at 1280, 1920, 2560 and 390 (`r3/1920x1080-07.png`, `r3/390x844-07.png`). On mobile the sound chapter's wireframe fan and bar graph draw straight through "Listen closer." (`r3/390x844-07.png`).
5. **Still open: 3D labels off-screen**: "Left grille · Tap" at x -145 (1920), -156 (2560), -313 (390); "Paste values", "Previous sheet", "Mute call, pause music" at negative x on 390. Shots `r3/390x844-08.png`, `-09.png`.
6. **Still open:** mobile `/compatibility/` table overflow ("Lid and tilt" at x 340 to 434); no theme control on mobile.

Clean: no console errors or warnings on any page or viewport, no failed requests, no 404s, no hydration errors, no WebGL context loss, CLS 0.0000 to 0.0065, theme toggle correct with no flash, 45 of 45 Tab stops show a focus ring, all subpages 200.

### Performance (M5 Pro, Metal, 1440x900)

| measure | round 2 | round 3 |
|---|---|---|
| First WebGL draw | 466 ms | 456 ms (454 to 472 across viewports) |
| LCP | 80 ms | 68 ms |
| Cold scroll pass p50 / p95 / p99 / max | 16.7 / 16.7 / 16.8 / 50 ms | 16.7 / 16.8 / 16.8 / 33.3 ms (1 frame > 32 ms at y 871) |
| Warm passes and 4x CPU throttle pass | 0 long frames | 0 long frames, max 16.8 ms |
| JS heap growth over 3 passes | +1.9 MB | +1.7 MB (22.4 to 24.1 MB) |
| WebGL buffers after pass 1 / 2 / 3 | 406 / 430 / 454 | 496 / 541 / 586 (+45 per pass, worse) |
| Programs | 92 | 107, all compiled in pass 1 |

- **Load is fixed in spirit.** Filmstrip `r3/load.jpg`: black, then a soft glow fades up, dust gathers, and the mark (two keycaps and the orange touch dot) is formed at ~3.4 s. No brightness step any more, and the backdrop is now near-black. The mark is small (about 150px) and off to the right; it could be larger and centered on the laptop's future position so the hand-off to the laptop reads as one object.
- **GPU buffer leak grew** to 45 buffers per full scroll pass (was 24). The new `air/` scenes (`GhostHand`, `SoundScene`) are the likely source: check for geometries built in render or in effects without `dispose()`.

### Art direction

**Verdict:** closest yet. The near-black void, the forming mark, the closing-lid ending (`r3/art-dark-35.png`) and the macro grille shot (`r3/art-dark-07.png`) are award-level frames. What keeps it from the top tier is now a short list: dead scroll, text sitting on bright metal, orange overuse, and the subpages.

1. **Ten screens with nothing to read.** Positions 10 to 14 (the lid, 1,030px) and 26 to 30 (the laptop idling before "Go on. Tap it.", 1,030px) have zero words and almost no motion: `r3/art-dark-10.png` to `-14.png`, `-26.png` to `-30.png`. That is 27 percent of the scroll. Cut both holds by at least half, or give each a single mono label and a visible camera move.
2. **Copy over bright aluminum** is still the biggest legibility problem: "Every blank surface is a key." over lit keys (`r3/art-dark-08.png`), "Your apps, your layers." over the palm rest (`r3/art-dark-24.png`), "the interface." over the palm rest on mobile (`r3/390x844-14.png`). Add a darkening light-well behind copy or frame the laptop away from the copy column.
3. **Orange is decoration, not signal.** Full-deck ripple rings crossing the trackpad and other zones, inter-key glow, orange on the spreadsheet cell. One ring at the point of touch, nothing else.
4. **Rainbow zone colors in the on-screen app** (blue, green, purple, pink outlines) are unchanged; brief and `APP_CRITIQUE.md` item 1 say monochrome.
5. **The closed laptop at the end** reads as three separate slabs with dark gaps between them (`r3/art-dark-35.png`): the lid, a dark band, and the base do not meet, and there is no hinge. Close the gap or add a hinge cylinder and a contact shadow; this is the last frame people see.
6. **Subpages unchanged** from round 2 (boxed Pro column on `/pricing/`, 186-word screens on `/privacy/`).

### Top 5 for the builder right now
1. Point every Download link and the skip link at a real target (`/pricing/` for now). One-line fix in `lib/site.ts` plus `app/page.tsx`.
2. Reduced motion: stop stacking chapter copy, stop the 3D animation, use the new stills.
3. Fix the headline exit mask so leaving lines do not overlap the next line; keep HUD pills and the sound-chapter wireframe out of the copy column.
4. Cut the two dead-scroll holds (10 of 37 screens are empty).
5. Darken behind copy that lands on metal; limit orange to one touch ring.

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
