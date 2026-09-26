# Live demo run-of-show: 3 minutes

For the finalist round (1 to 3 PM Sunday). One presenter drives the laptop, one presenter talks to the judges and watches the clock. Rehearse this exact sequence at least twice on the actual demo Mac before the round. Calibration is per-machine, and a laptop that hasn't been calibrated on-site will not perform.

## Before the judges sit down

- Demo Mac is calibrated, charged, and the daemon is running (`ghostkeysd` already started, not launched live: don't burn stage time on a cold start).
- A second Mac or a phone is recording video as a backup capture, in case something has to be redone later.
- The mock-daemon build is on a second laptop, running and ready, untouched, as the fallback path (see below).
- Volume is up enough that any audio-based confirmation (if used) is audible to judges standing at a normal distance.
- Close every other app that might steal a keystroke or a notification during the demo.

## Run-of-show

**0:00-0:20: The hook.** Presenter A rests both hands on the closed-looking laptop, says nothing about buttons yet. "Quick question: how many buttons does this MacBook have?" Let someone answer. "It has more than that." Tap the right palm rest once, let whatever's bound to it fire visibly (volume, play/pause, whatever reads clearly on a projector or over someone's shoulder).

**0:20-0:50: Where the buttons are.** Walk two fingers around the case while naming them: both palm rests, both grilles, the strip above the keyboard, the edges, the lid. "All of this is just aluminum right now. On this machine, it isn't." Show the live laptop map on screen if it's built; if not, do this beat on the physical case only and keep talking, don't apologize for a missing screen.

**0:50-1:20: How, in one breath.** "It's using the sensors already in the machine: the motion sensor that feels a tap through the case, the lid angle sensor, the light sensor. No new hardware, nothing to charge, nothing to pair." If there's time and appetite, glance at `ghostkeysd --selftest` running in a terminal for two seconds, just enough for the numbers to register as real telemetry, then move on. Don't explain the columns.

**1:20-1:50: Draw a zone, live.** If the zone editor is ready: draw a new zone live on an untouched spot (e.g. the left edge) and bind it to something visible and fun (launch a specific app, take a screenshot) in front of the judges. This is the single highest-value beat if it works, because it proves the product is configurable, not a fixed demo. If the zone editor is not ready by demo day, skip drawing live and instead tap through 2 to 3 **pre-bound** zones back to back, narrating "you draw these yourself, here's three I made earlier."

**1:50-2:30: Range, fast.** Rapid-fire through distinct gesture types, each ending on its visible result: a double tap (media), a two-zone sequence (an action that clearly needed two specific spots), a lid nudge, a cover gesture. Keep each under 10 seconds; the point is breadth, not depth. Narrate the type, not the mechanics: "double tap... a sequence across two zones... tilt the lid... cover the camera."

**2:30-2:50: Why this and not a Stream Deck.** One line, not a feature list: "A Stream Deck is $150 of extra hardware sitting on your desk. This is software, on the laptop you already own, using zones you draw yourself." If a judge asked about accuracy or false positives earlier, this is also the spot to address it directly rather than dodging: name the real number if calibration/validation testing produced one, otherwise say plainly what's tuned and what's next.

**2:50-3:00: Close and hand off.** "That's Ghostkeys. The keys were always there." Stop talking. Open the floor for judge questions; don't fill dead air with more demo.

## Fallback plan

Live demos fail in specific, predictable ways. Have an answer ready for each:

| Failure | Fallback |
| --- | --- |
| Daemon crashes or sensors stop reporting mid-demo | Switch immediately to the second laptop running the mock daemon; it produces the same WebSocket messages and drives the same UI, so the story continues without a visible seam. Say "switching machines" once, then keep going. Don't debug on stage. |
| Wi-Fi / projector / HDMI issue | Nothing in this product needs the network or a specific display; if the projector fails, keep demoing on the laptop screen itself, judges will lean in. |
| A gesture misfires in front of judges | Don't retry the exact same tap more than once. Say "that's the false-positive case we're still tuning" and move to the next gesture. Owning it reads better than pretending it didn't happen. |
| Zone editor / HUD not finished in time | Pre-record a 15 to 20 second screen capture of the intended flow (drawing a zone, or the HUD confirming a tap) on a phone, and cut to that clip on the backup laptop if asked to show it live. Never claim a recorded clip is happening live. |
| Calibration drifted overnight (different lighting, different surface) | Recalibrate before the round, not during it; if it's clearly off right before going on, fall back to the pre-recorded clip rather than fighting a bad model in front of judges. |
| Time runs short (judges cut in early) | Protect the 0:00-0:50 hook and the 1:20-1:50 configurability beat above everything else; the gesture-range montage (1:50-2:30) is the first thing to cut. |
| A judge asks to try it themselves | Good sign, say yes. Have one zone bound to something harmless and obvious (a screenshot, a notification sound) so a stranger's tap succeeds on the first try even without their own calibration profile. |

## After the demo

Note anything that misfired or drew a strong judge reaction, right after the round while it's fresh. That's real validation data, and it belongs in `docs/pitch/validation.md`, not just in someone's memory.
