import { setConsoleFunction } from "three";

/**
 * React Three Fiber still constructs THREE.Clock, which three r183+ flags as deprecated on every canvas.
 * That warning is outside this codebase, so filter exactly that one message and pass everything else through.
 */
const DEPRECATED_CLOCK = "Clock: This module has been deprecated";

setConsoleFunction((type: string, message: string, ...params: unknown[]) => {
  if (typeof message === "string" && message.includes(DEPRECATED_CLOCK)) return;
  const fn = (console as unknown as Record<string, (...a: unknown[]) => void>)[type] ?? console.log;
  fn(message, ...params);
});

export {};
