import { Easing } from "remotion";
import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

export const C = {
  bg: "#0A0A0B",
  bgRaised: "#111113",
  ink: "#EDEDEF",
  ink2: "#8A8A90",
  ink3: "#55555B",
  hairline: "#1F1F23",
  aluminum: "#A7A9AC",
  signal: "#FF5B1F",
};

export const FONT = {
  sans: "Geist, system-ui, sans-serif",
  mono: "'Geist Mono', ui-monospace, monospace",
  serif: "'Instrument Serif', Georgia, serif",
};

// Brief motion tokens.
export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);
export const easeSnap = Easing.bezier(0.2, 0, 0, 1);

export const FPS = 30;

let fontsRequested = false;
export const loadFonts = () => {
  if (fontsRequested) return;
  fontsRequested = true;
  const f = (family: string, file: string, weight: string, style = "normal") =>
    loadFont({ family, url: staticFile(`fonts/${file}`), weight, style });
  f("Geist", "Geist-Regular.woff2", "400");
  f("Geist", "Geist-Medium.woff2", "500");
  f("Geist Mono", "GeistMono-Regular.woff2", "400");
  f("Geist Mono", "GeistMono-Medium.woff2", "500");
  f("Instrument Serif", "InstrumentSerif-Italic.woff2", "400", "italic");
};
