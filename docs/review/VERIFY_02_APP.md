# Verify 02: Ghostkeys app, new first-run and practice work

Date: 27 Sep 2026. Scope: 5-step onboarding, Tap test, "Why didn't that work?", Training session draft, Sonar page and Sonar test, plain-language errors, approvals.

**Bottom line:** everything new works against a real (simulated-sensor) daemon, after 9 small fixes. Two of those were real breakages: the Training session never finished, and the Sonar header said "0s left" forever. The biggest remaining UX problems are listed at the end, ranked.

## How it was checked

- New scripted check: `pnpm verify:app` (`app/scripts/verify/verify-app.mjs` + `driver.mjs`).
  - Starts the real `ghostkeysd` with `--simulate-sensors --no-hardware-sessions --dry-run --config-dir <scratch> --port 47985`.
  - Runs the app offscreen with a fresh profile, so it is a true first launch.
  - Drives the real UI by clicking buttons and pressing keys. Sensor input comes only from the daemon's test hooks (`sim_spike` live, `sim_tap`, `sim_sonar`).
  - Writes screenshots to `app/screenshots/verify/` and every check plus the accessibility audit to `results.json`.
- Small app hooks were added for this. Both are dev only and inert in a packaged build:
  - `GK_VERIFY_DRIVER` in `src/main/index.ts`
  - `window.__gk.stores` in screenshot mode
- Final run: **65 of 65 checks pass, 1 not applicable.**
- Also reviewed by eye: every screenshot in `app/screenshots/`, plus the 38 new ones.

## Pass/fail

| Area | Check | Result |
| --- | --- | --- |
| Startup | App connects to the simulated daemon; fresh profile opens onboarding | PASS |
| Onboarding 1 | Tab reaches "Get started"; Enter advances | PASS |
| Onboarding 2 | Lists this Mac and its sensors | PASS |
| Onboarding 3 | Way forward without Accessibility ("Continue without it") | PASS (the "Allow" button was deliberately not pressed, because it opens a real macOS prompt) |
| Onboarding 4 | Quick calibration: 10 taps on each palm rest are counted, typing round, training, "ready" screen | PASS |
| Onboarding 5 | A harmless double-tap binding (play/pause) is created | PASS |
| Onboarding 5 | A double tap fires and the step says "That's it." | PASS in 1 of 3 runs. The synthetic taps are identical, so a 2-zone model splits them about 50/50. With a 1-zone model it passes every time (separate check). |
| Onboarding 5 | After 20 s it explains what happened and offers "Open the Tap test" | PASS (copy was wrong before the fix, see bug 3) |
| Gesture | Two live taps make a double tap and run play/pause (dry run) | PASS |
| Why | Paused: plain sentence, and "Resume" really resumes the daemon | PASS |
| Why | Low confidence, from the real daemon: names the zone, "Teach it" sends feedback, the daemon learns, a toast confirms | PASS |
| Why | Burst, from the real daemon (5 fast taps) | PASS |
| Why | Typing, trackpad, motion | PASS for the app's handling. The daemon can't produce these without real keyboard, trackpad or motion input, so the daemon-shaped message was fed into the app. |
| Why | "Shorten typing pause" changes the daemon setting 450 to 300 ms | PASS |
| Why | Nothing felt in 30 s: "Raise sensitivity" changes the daemon setting 0.5 to 0.65 | PASS |
| Tap test | Hits, wrong-zone and misses are scored correctly (7 of 16, as planned) | PASS |
| Tap test | "Teach it this tap" on a miss gets a daemon answer | PASS |
| Tap test | Wrong zone no longer offers a "Teach it" that cannot work | PASS after fix (bug 4) |
| Tap test | Result screen offers "Recalibrate these zones" or "Test again" | PASS |
| Training | All three rounds run, one tap per prompt | PASS |
| Training | Finishes and hands over to the results | **FAILED before fix** (bug 1), PASS after |
| Sonar | Off: "Turn on" leads to an explanation dialog, then a sonar session | PASS |
| Sonar | Header subtitle | **FAILED before fix** (bug 2: "LISTENING · 0S LEFT"), PASS after |
| Sonar | A simulated push shows as "Last sonar gesture" | PASS |
| Sonar test | Hover, push, both sweeps and slide are recognised; the missing pull is explained; score "5 of 6 recognised" | PASS |
| Sonar | "Stop sonar" stops it, and "Turn on" is offered again | PASS |
| Approvals | Cancel approves nothing; Allow returns a hash; the dialog shows the exact command; Cancel is the default | PASS |
| Approvals | Unapproved command refused; approved one runs (dry run); revoke works | PASS |
| Errors | Refused test action: plain toast | PASS |
| Errors | Feedback sent twice in 2 s | **FAILED before fix** (bug 5: generic "Ghostkeys couldn't do that" plus the raw daemon text), PASS after |
| Errors | Sonar start while off: "Sonar isn't listening. Sonar is off." | PASS |
| Errors | Calibration step sent out of order: plain sentence | PASS |
| Accessibility | No unnamed buttons or inputs on any new screen; Tab order is logical; focus ring visible on buttons | PASS (ring check needs focus emulation offscreen, which the driver now enables) |
| Accessibility | Onboarding welcome: 690 px animated drawing has no label and is not hidden from VoiceOver | FAIL, not fixed (listed below) |
| Accessibility | Small grey text contrast | FAIL: many 11 to 12 px labels are 4.15 to 4.39:1 against the 4.5:1 minimum. Listed below. |

Not verifiable in simulation:
- Real tap accuracy.
- The sonar field drawing with live data. Simulated sonar sends no signal readings, so the Watch view always says "Not hearing the tones".
- The real Accessibility prompt.
- The macOS VoiceOver speech itself. Labels were checked in the page instead.

## Bugs fixed (all in `app/`)

1. **Training session never finished.** After the typing round it stayed on "Training on your taps" forever. The "done" message was ignored outside the running phase. It now finishes and opens the results; a cancel also resets it. (`screens/Practice.tsx`)
2. **Sonar header said "LISTENING · 0S LEFT".** Sonar has no time limit any more. It now says "listening". (`screens/Sonar.tsx`)
3. **First gesture said "Nothing has registered yet" when taps were felt.** It now says what it felt:
   - taps on another zone: "Ghostkeys felt your taps, but heard them on the left palm rest..."
   - a single tap: "Ghostkeys felt a single tap. Make the two taps quicker..."
   (`screens/FirstRun.tsx`)
4. **Tap test offered "Teach it this tap" for wrong-zone taps.** The daemon only learns taps it dropped, and a wrong-zone tap was accepted, so the button always failed. It is now shown only for misses, and the copy points to recalibrating instead. (`screens/Practice.tsx`)
5. **Tap test asked for zones never calibrated.** Right after onboarding, 6 of 8 prompts were zones nobody had taught, so they were certain misses. It now uses only zones the model knows. (`screens/Practice.tsx`)
6. **Tap test intro claimed "Nothing runs while you test".** False: nothing suppresses actions during the test. The copy now says gestures you have set up still run.
7. **Raw daemon text in toasts.**
   - Before: "No tap-like onset 0.7 to 5 s before the request". Now: "Ghostkeys didn't feel anything in the few seconds before you asked..."
   - Other feedback reasons are also mapped to plain words.
   - The feedback rate limit now reads "That was sent too quickly after the last one..."
   (`components/Feedback.tsx`)
8. **Run-on zone lists.**
   - Before: "Left palm rest and Top strip and Right grille and Left grille and ... need another pass."
   - Now: "Left palm rest, top strip and 6 other zones".
   - Same fix on the Tap test result. (new `nameList` in `lib/utils.ts`)
9. **Tap test miss copy.**
   - Before: "Ghostkeys ignored it because nothing was felt; try a slightly firmer tap."
   - Now: "Ghostkeys didn't feel a tap. Try a slightly firmer tap."

Typecheck, lint and build all pass after every fix.

## Top 15 UX improvements (ranked)

1. **"Teach it" in the Why helper trusts the classifier's guess.** "Teach it: right palm rest" appears when Ghostkeys was only 50% sure. If the user actually tapped the left palm rest, one click teaches the wrong zone. Ask "Where did you tap?" with the zones, as "Missed a tap" already does.
2. **The Training session is very long and covers zones the user never chose.** After onboarding it asks for 80 taps across 8 zones: "3 OF 48 IN THIS ROUND" on the desk round alone. Let users pick zones as Calibrate does, and default to the ones they have bindings on.
3. **Tap test cannot be honest about "Nothing runs".** Now that the copy is correct, a test mode is still the better answer. The daemon would report taps and gestures but skip actions, as it already does during calibration. That needs a protocol message.
4. **Sonar page when sonar is off.** It shows "Not hearing the tones" twice and a "Waiting for the tones" chip, which reads like a fault. It also repeats itself: "Needs Sonar. Sonar is off." Hide the readouts until sonar is on, and make "Turn on" the one clear action. The Sonar test should also be disabled while sonar is off: today "Go" just waits 7 s and fails.
5. **Sonar jargon.**
   - "SNR 57 DB · MOVED -1 MM", "19.5 KHZ" / "20.25 KHZ" under the speakers, and the "HAND" meter labels. SNR means signal-to-noise ratio, how clearly the tone is heard.
   - The Turn on dialog opens with "19.5 and 20.25 kHz".
   - The quality word ("Strong", "Good") already says it all. Move the numbers to Sensors.
6. **Onboarding "ready" screen says ready whatever the score.** "Your palm rests are ready. Ghostkeys recognised 60%..." At 60% it should say one more round would help, and offer it.
7. **Back during quick calibration leaves calibration running.** The footer "Back" stays active mid-capture. Going back does not cancel the daemon's calibration, so later taps keep being labelled. Hide Back while capturing, or cancel first.
8. **The Why helper is hard to find.** It is a small grey link at the bottom of the right column on Live, under the recent-gestures list. When a rejection just happened, pulse it or show the one sentence inline for a few seconds.
9. **Low-confidence sentence is odd.** "Only 50% sure which zone it was" sounds like a coin toss. Say instead: "Ghostkeys felt a tap but couldn't tell if it was the left or right palm rest." The daemon already sends the guess, so the second-best zone could be sent too.
10. **Live header jargon.** "CONNECTED · 2/4 SENSORS · TRAINED · 800 HZ". Hz here means readings per second. A first-time user needs "Ready" or "Needs calibration", nothing more.
11. **Zones are only numbers on the map.** Everywhere except the focused zone they show "03", "05", "08". New users must hover to learn which is which. Show names on the map in onboarding and in the Tap test.
12. **Stacked toasts overlap.** Two toasts of different heights stack so the lower line of the back one shows below the front one ("right away." visible under the new toast; `screenshots/verify/37`). Give the stack a fixed collapsed height, or expand it on new errors.
13. **Contrast of small grey labels.**
    - 11 to 12 px labels in `text-ink-3` / `text-ink-2`: mono captions like "ZONE 1 OF 2", "SECONDS LEFT", "Score", sidebar numbers, "Search and commands".
    - They measure 4.15 to 4.39:1, below the 4.5:1 minimum.
    - Raising `--ink-3` in dark mode slightly fixes all of them at once.
14. **VoiceOver gaps.**
    - The onboarding hand animation (690x599) has no label and is not hidden. Give it the caption as its label, or mark it hidden.
    - The Tap test progress bar and the quick-calibration dots are `aria-hidden`, and nothing is announced when a tap lands or misses. Add an `aria-live="polite"` region for "Landed", "Missed" and the counter.
15. **Sidebar sonar control disagrees with the page.** The sidebar says "Sonar on · Turn off"; the page says "Stop sonar". Both turn the setting off. Use "Turn off sonar" in both places.

Also noticed:
- The mock daemon still simulates timed sonar ("57S LEFT" in `screenshots/sonar.png`), so the mock screenshots hid bug 2. Update `scripts/mock-daemon.ts` to continuous sonar.
- The simulated daemon still reads real keyboard and trackpad input. One run got a real "trackpad" rejection mid-test (known, RELEASE_CHECK bug 5).
- The results page after a Training session contradicts itself in simulation: it recommends keeping a zone that scored 0% and expects "100% on the zones kept". This is probably the identical synthetic taps, but it is worth a look with real data.
- The tab order on the Tap test intro loops between "Start the test" and an open toast. The second time, focus lands without a visible ring (the toast library moves focus itself).

## Files

- New:
  - `app/scripts/verify/verify-app.mjs`
  - `app/scripts/verify/driver.mjs`
  - `package.json` script `verify:app`
- Harness hooks:
  - `app/src/main/index.ts` (`GK_VERIFY_DRIVER`, dev builds only)
  - `app/src/renderer/src/lib/shots.ts` and `app/src/preload/index.d.ts` (`__gk.stores`)
- Fixes:
  - `screens/Practice.tsx`, `screens/Sonar.tsx`, `screens/FirstRun.tsx`, `screens/Calibration.tsx`
  - `components/Feedback.tsx`, `lib/utils.ts`
- Evidence: `app/screenshots/verify/` (38 PNGs + `results.json`)
