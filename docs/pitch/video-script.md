# Demo video script: 2 minutes

Shot-by-shot for the Devpost submission video. Voiceover is one person, calm and plain, no hype-narrator cadence. On-screen text is minimal: short lines only, Geist per the design brief, never more than one line up at a time.

Two things need to be true before shooting: a **calibrated** Ghostkeys profile on the demo Mac (don't calibrate on camera, it's the boring part), and the renderer UI (zone editor, HUD) built enough to show. If the UI isn't ready by shoot time, use the fallback noted under each shot that needs it. The daemon and the WebSocket messages are real either way, so the story doesn't depend on the prettiest possible screen.

---

### Shot 1: Cold open on the hands (0:00-0:12)

**Visual:** Tight overhead shot, hands on a MacBook, typing normally. No UI visible yet.

**On-screen text:** `Your MacBook has more buttons than you think.`

**Voiceover:** "This MacBook has buttons you've never pressed. They're not on the keyboard."

**Action:** On the last word, one hand taps the right palm rest, once. Cut on the tap.

---

### Shot 2: The reveal (0:12-0:22)

**Visual:** Camera cuts to the screen. Whatever bound that tap fires visibly: for example the tap opens the current music app's play/pause, or bumps volume, shown as an obvious, legible UI change (menu bar volume HUD is fine and is real macOS UI, not ours).

**On-screen text:** `That was a tap on the palm rest.`

**Voiceover:** "That was a tap on the palm rest. No button there. No sensor you can see. Just aluminum."

---

### Shot 3: What's actually blank (0:22-0:34)

**Visual:** Slow pan/tilt around the laptop's case: both palm rests, the two speaker grilles, the strip above the keyboard, both edges, the lid. If the live laptop map screen exists, cut to it here with each zone highlighting in sequence as the camera pans the matching physical spot. **Fallback if that screen isn't built yet:** do the pan on the physical laptop alone, no screen cut, and let the voiceover carry the list.

**On-screen text:** `Palm rests. Grilles. Edges. Lid.`

**Voiceover:** "Palm rests, the grilles, the strip above the keys, the edges, even the lid. All of it's just sitting there."

---

### Shot 4: How (0:34-0:50)

**Visual:** Cut to a simple diagram or the terminal running `ghostkeysd --selftest`, showing live sensor rates scroll by (this is real output, not a mockup, and it looks convincingly technical without needing any UI). Overlay small labels pointing at the numbers: motion sensor Hz, lid angle, light level.

**On-screen text:** `Motion sensor. Lid angle. Light sensor.` then `Already inside. Nothing new to plug in.`

**Voiceover:** "It's using sensors already inside the machine: the motion sensor, the lid angle sensor, the light sensor. Nothing plugged in, nothing extra to charge."

---

### Shot 5: Drawing a zone (0:50-1:08)

**Visual:** Screen recording of the zone editor: draw a rectangle on the on-screen laptop outline over the right speaker grille, name it. **Fallback if the zone editor isn't built yet:** show the same idea as a quick before/after: the JSON zone definition from `docs/PROTOCOL.md` on one side, the physical spot circled on the laptop on the other, with a simple animated draw-on of the rectangle.

**On-screen text:** `Draw a zone.`

**Voiceover:** "You draw the zone yourself, anywhere blank."

---

### Shot 6: Calibration, sped up (1:08-1:22)

**Visual:** Fast cut montage: a hand tapping the same zone repeatedly (calibration capture), then typing/using the trackpad normally (the "negatives" phase), sped up 4 to 6x with a light whoosh, calibration progress UI overlaid if it exists. **Fallback:** show the `calibration` WebSocket messages from `docs/PROTOCOL.md` scrolling as captions timed to the taps, so the mechanism reads even without the finished screen.

**On-screen text:** `About 3 minutes, once.`

**Voiceover:** "About three minutes, once, and it learns what your tap feels like, and what it doesn't."

---

### Shot 7: Bindings and gestures (1:22-1:42)

**Visual:** Quick-cut proof of range: double-tap the left palm rest (media), a two-zone sequence tap (screenshot action), a lid nudge (something visible fires), a cover-the-camera gesture (mic mute). Each cut is under 3 seconds, each one ends on the visible result, not the tap.

**On-screen text (one line per cut, changing with each):** `Double tap.` → `Sequence.` → `Lid nudge.` → `Cover.`

**Voiceover:** "Double taps, sequences across two zones, tilting the lid, even covering the camera, each one bound to whatever you want."

---

### Shot 8: The HUD confirmation (1:42-1:50)

**Visual:** Close on the small heads-up display pill appearing after a tap: zone name and action label, then fading. **Fallback if the HUD isn't built yet:** cut this beat rather than fake it; go straight from Shot 7 to Shot 9.

**On-screen text:** none. Let the HUD itself be the on-screen text.

**Voiceover:** (silence or a single short line) "You always know what just happened."

---

### Shot 9: Close (1:50-2:00)

**Visual:** Return to the cold-open framing: hands resting on the laptop, still. One tap on the palm rest. Cut to black on the sound of the tap.

**On-screen text:** `Ghostkeys` then, smaller, `The keys were always there.`

**Voiceover:** "Ghostkeys. The keys were always there."

---

## Production notes

- Record all real sensor/daemon footage at native speed; only the calibration montage is sped up, and say so honestly in spirit (don't sell the montage as real-time).
- Every on-screen action shown must be a real, working gesture on the actual daemon: no staged UI, no "coming soon" screens presented as if shipped.
- Keep voiceover under the pace of the visuals; if a shot needs a fallback, the voiceover script does not need to change, only the visual under it.
- Export at 1080p minimum; Devpost's player is the audience's first impression before anyone reads a word of the write-up.
