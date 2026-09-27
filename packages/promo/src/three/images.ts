import { continueRender, delayRender, staticFile } from "remotion";

// App screenshots used as screen textures, preloaded once; rendering waits until they decode.
export type AppImage = "live" | "guide";
const cache: Partial<Record<AppImage, HTMLImageElement>> = {};
let started = false;
export const preloadAppImages = () => {
  if (started || typeof window === "undefined") return;
  started = true;
  (["live", "guide"] as AppImage[]).forEach((n) => {
    const h = delayRender(`app image ${n}`);
    const img = new Image();
    img.onload = () => continueRender(h);
    img.onerror = () => continueRender(h);
    img.src = staticFile(`app/${n}.png`);
    cache[n] = img;
  });
};
export const appImage = (n: AppImage) => cache[n];
