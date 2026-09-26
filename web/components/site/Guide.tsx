import { Head } from "./Info";

type Row = { t: string; d: string; tag?: string };

const SECTIONS: { id: string; label: string; title: string; rows: Row[] }[] = [
  {
    id: "sensor",
    label: "The sensor",
    title: "It feels every tap.",
    rows: [
      { t: "A motion sensor you already own", d: "MacBooks carry a motion sensor and gyroscope. Ghostkeys reads them 800 times a second and listens for the shape of a tap." },
      { t: "Lid angle and light", d: "The lid angle sensor and the ambient light sensor beside the camera are inputs too." },
    ],
  },
  {
    id: "calibrate",
    label: "Calibration",
    title: "It learns your hands.",
    rows: [
      { t: "Twenty taps a zone", d: "Tap each zone twenty times, then type normally for a moment. About three minutes." },
      { t: "Typing is ignored", d: "Keys, the trackpad and bumps like a mug on the desk never fire a binding." },
      { t: "Recalibrate any time", d: "A desk and a lap feel different. Calibrate where you work, again whenever you move." },
    ],
  },
  {
    id: "zones",
    label: "Zones",
    title: "Every blank surface is a key.",
    rows: [
      { t: "Palm rests", d: "Left and right of the trackpad. Free.", tag: "Free" },
      { t: "Speaker grilles and top strip", d: "Beside the keys, and the band above them." },
      { t: "Edges and lid", d: "Both sides of the case, and the back of the screen." },
      { t: "Zones you draw", d: "Mark any blank area on a picture of your laptop." },
    ],
  },
  {
    id: "gestures",
    label: "Gestures",
    title: "Tap, and then some.",
    rows: [
      { t: "Tap, double, triple", d: "Three actions per zone to start.", tag: "Free" },
      { t: "Sequence and rhythm", d: "Left palm then right palm. Or tap, pause, tap tap." },
      { t: "Modifier plus tap", d: "Hold Shift, Control, Option, Command or fn while you tap." },
      { t: "Lid nudge, tilt, cover", d: "Tip the screen back, roll the laptop, or cover the light sensor." },
      { t: "Sound mode", d: "Knuckle or fingertip, a rub on the grille, a wave of the hand. Opt-in.", tag: "Beta" },
      { t: "In the air", d: "Pinch, drag, swipe and turn, seen by the camera on M4 and M5 MacBooks. Opt-in.", tag: "Beta" },
    ],
  },
  {
    id: "actions",
    label: "Actions",
    title: "Anything your Mac can do.",
    rows: [
      { t: "Everyday", d: "Keystrokes, text, clipboard, apps, links, volume, media, windows.", tag: "Free" },
      { t: "Per-app layers", d: "The same tap does different things in different apps." },
      { t: "Scripts and macros", d: "Shell, AppleScript, Shortcuts, and macros up to 50 steps." },
      { t: "Integrations", d: "Excel formula tools, browser tabs, Music and Spotify, Finder, slides, Zoom and Meet." },
      { t: "AI composer", d: "Describe a macro in a sentence and check the binding before you save it." },
    ],
  },
];

export function Guide() {
  return (
    <>
      {SECTIONS.map((s) => (
        <section key={s.id} className="mt-[16svh]" aria-labelledby={`${s.id}-h`}>
          <Head id={s.id} label={s.label} title={<span id={`${s.id}-h`}>{s.title}</span>} />
          <ol className="mt-12 md:ml-[25%]">
            {s.rows.map((r, i) => (
              <li key={r.t} className="grid grid-cols-[3rem_1fr] gap-y-2 border-t hairline py-6 md:grid-cols-[4rem_1fr_1fr]">
                <span className="label !text-ink pt-1 tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                <h3 className="text-[19px] font-normal leading-[1.3] text-ink md:pr-10">
                  {r.t}
                  {r.tag && <span className="label ml-3">{r.tag}</span>}
                </h3>
                <p className="col-start-2 max-w-[46ch] text-[15px] font-light text-ink-2 md:col-start-3">{r.d}</p>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </>
  );
}
