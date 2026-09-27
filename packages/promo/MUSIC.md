# Music

## What the film uses

An original score, synthesized in `scripts/mix.ts`. No samples, loops or third-party recordings are used. It is generated from code in this package, so it can be used anywhere the film is used.

- 120 BPM, locked to the edit grid (beat 0 = frame 0, one beat = 15 frames).
- D dorian colour: Dm9, Bbmaj9, Fmaj9/A, Cadd9, one chord per two bars, resolving to Fmaj9 on the end card.
- Layers: detuned saw pads through a moving low-pass, a sub pulse on every beat, a soft pluck arpeggio with a dotted-eighth ping-pong delay, very soft hats, and a small algorithmic room.
- Sections follow the edit: silence into the logo flash, the pulse from "Matter", a darker filter under the x-ray, a lifted arpeggio in the air and sonar beats, a breakdown under the type moment, a build through the hero shot, and a resolve and tail on the end card.

## ElevenLabs music (tried, not available)

The brief asked for ElevenLabs music first. One request was sent to the official endpoint `POST https://api.elevenlabs.io/v1/music` (70 s, instrumental prompt) on 2026-09-27. It was refused with `402 paid_plan_required`: "Music API is not available for free users. Please upgrade to a paid plan to use the API." No audio was produced and no credits were charged. `scripts/music-try.ts` makes that single attempt again and caches the result in `voice/cache/music-eleven.mp3` if the plan is upgraded; the film does not use it yet.

License notes from the ElevenLabs docs (https://elevenlabs.io/docs/overview/capabilities/music), for when a paid plan is used:

- "Eleven Music is cleared for nearly all commercial uses, from film and television to podcasts and social media videos, and from advertisements to gaming."
- "For more information on supported usage across our different plans, see our music terms."
- "The Music API is available for paid subscribers."

Read the plan-specific music terms before shipping any generated track.

## Never

No music is downloaded from anywhere.
