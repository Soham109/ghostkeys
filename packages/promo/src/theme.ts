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

// Type system (matches web/app/globals.css): Switzer 200 display with a 300 italic accent, Fragment Mono captions.
export const FONT = {
  display: "Switzer, system-ui, sans-serif",
  sans: "Switzer, system-ui, sans-serif",
  mono: "'Fragment Mono', ui-monospace, monospace",
  serif: "Switzer, system-ui, sans-serif",
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
  f("Switzer", "Switzer-200.woff2", "200");
  f("Switzer", "Switzer-300.woff2", "300");
  f("Switzer", "Switzer-300i.woff2", "300", "italic");
  f("Switzer", "Switzer-400.woff2", "400");
  f("Switzer", "Switzer-500.woff2", "500");
  f("Fragment Mono", "FragmentMono-400.woff2", "400");
};
