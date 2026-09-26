"use client";
import { useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(pref: ThemePref) {
  const t = pref === "system" ? systemTheme() : pref;
  document.documentElement.dataset.theme = t;
  document.documentElement.dataset.themePref = pref;
  emit();
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem("gk-theme");
    else localStorage.setItem("gk-theme", pref);
  } catch {}
  apply(pref);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onSys = () => {
    if ((document.documentElement.dataset.themePref ?? "system") === "system") apply("system");
  };
  mq.addEventListener("change", onSys);
  return () => {
    listeners.delete(cb);
    mq.removeEventListener("change", onSys);
  };
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    subscribe,
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
    () => "dark",
  );
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(
    subscribe,
    () => (document.documentElement.dataset.themePref as ThemePref) ?? "system",
    () => "system",
  );
}

export const PALETTE = {
  dark: { bg: "#0a0a0b", ink: "#ededef", ink2: "#8a8a90", ink3: "#55555b", aluminum: "#a7a9ac", signal: "#ff5b1f" },
  light: { bg: "#f4f4f1", ink: "#0b0b0c", ink2: "#65656b", ink3: "#9a9a9e", aluminum: "#c9cbce", signal: "#e5480c" },
} as const;
