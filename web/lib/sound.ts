"use client";
import { useSyncExternalStore } from "react";
import { bus } from "./stage";

/** UI sound, off by default. Howler loads only after the visitor turns sound on (that click unlocks audio). */
type HowlLike = { play: (id: string) => number; volume: (v: number, id?: number) => void; rate: (r: number, id?: number) => void };
let howl: HowlLike | null = null;
let enabled = false;
const listeners = new Set<() => void>();
const VOL = { tick: 0.04, tap: 0.08, swell: 0.12 } as const;
let lastTap = 0;

async function load() {
  if (howl) return;
  const { Howl } = await import("howler");
  howl = new Howl({
    src: ["/audio/ui.webm", "/audio/ui.mp3"],
    sprite: { tick: [0, 60], thump: [260, 320], swell: [780, 1900] },
    preload: true,
  }) as unknown as HowlLike;
}

export async function setSound(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem("gk-sound", on ? "on" : "off");
  } catch {}
  if (on) await load();
  listeners.forEach((l) => l());
}

export function play(name: "tick" | "tap" | "swell") {
  if (!enabled || !howl) return;
  const now = performance.now();
  if (name === "tap") {
    if (now - lastTap < 90) return;
    lastTap = now;
  }
  const id = howl.play(name === "tap" ? "thump" : name);
  howl.volume(VOL[name], id);
  if (name === "tap") howl.rate(0.97 + Math.random() * 0.06, id);
}

bus.cue = (name) => play(name);

export function useSound() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    () => enabled,
    () => false,
  );
}
