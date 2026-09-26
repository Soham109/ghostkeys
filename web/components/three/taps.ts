import * as THREE from "three";
import { D, W } from "@/lib/dims";
import { MAX_RIPPLES } from "./glsl";
import type { WaterSim } from "./water";

/** Monotonic seconds. R3F restarts its clock when frameloop goes "never" -> "always", so stored times use this instead. */
export const now = () => performance.now() / 1000;

export type TapLabel = { id: number; x: number; y: number; z: number; zone: string; action: string; born: number };

/**
 * Everything a touch causes: an analytic shockwave ring (uniform array), an impulse into the height field,
 * a floating HUD label, and a spike for the sensor waveform.
 */
export class TapField {
  rip: THREE.Vector4[] = Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, -100, 0));
  uniforms = { uRip: { value: this.rip }, uTime: { value: 0 } };
  private idx = 0;
  private nextId = 1;
  water: WaterSim | null = null;
  lastTap = -100;
  lastStrength = 0;
  private labelListeners = new Set<(l: TapLabel) => void>();
  private tapListeners = new Set<(x: number, z: number, s: number) => void>();

  get time() {
    return this.uniforms.uTime.value;
  }

  update(t: number) {
    this.uniforms.uTime.value = t;
  }

  /** x, z in base-local units. */
  tap(x: number, z: number, strength = 1, label?: { zone: string; action: string; y?: number }) {
    const t = this.time;
    this.rip[this.idx].set(x, z, t, strength);
    this.idx = (this.idx + 1) % MAX_RIPPLES;
    this.lastTap = t;
    this.lastStrength = strength;
    this.water?.impulse((x + W / 2) / W, (z + D / 2) / D, 0.035, 0.05 * strength);
    this.tapListeners.forEach((l) => l(x, z, strength));
    if (label) {
      const l: TapLabel = { id: this.nextId++, x, y: label.y ?? 0.16, z, zone: label.zone, action: label.action, born: t };
      this.labelListeners.forEach((fn) => fn(l));
    }
  }

  /** Pointer hover: gentle waves only, no ring. */
  stir(x: number, z: number, strength = 1) {
    this.water?.impulse((x + W / 2) / W, (z + D / 2) / D, 0.02, 0.0045 * strength);
  }

  onLabel(fn: (l: TapLabel) => void) {
    this.labelListeners.add(fn);
    return () => void this.labelListeners.delete(fn);
  }

  onTap(fn: (x: number, z: number, s: number) => void) {
    this.tapListeners.add(fn);
    return () => void this.tapListeners.delete(fn);
  }
}
