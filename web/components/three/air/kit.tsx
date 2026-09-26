"use client";

import * as THREE from "three";
import { JOINTS } from "./handPose";
import type { GhostHandMesh } from "./GhostHand";

/* ---------- joint smoothing: scroll can jump, the hand never does ---------- */

export class HandDriver {
  readonly target = new Float32Array(JOINTS * 3);
  readonly hot = new Float32Array(JOINTS);
  opacity = 0;
  private live = false;
  /** Ease the drawn hand toward `target`. lambda: higher is snappier. */
  step(hand: GhostHandMesh, dt: number, lambda = 11) {
    const j = hand.joints;
    if (!this.live) {
      j.set(this.target);
      hand.resetTrails();
      this.live = true;
    } else {
      const k = 1 - Math.exp(-Math.min(dt, 0.1) * lambda);
      for (let i = 0; i < j.length; i++) j[i] += (this.target[i] - j[i]) * k;
    }
    for (let i = 0; i < JOINTS; i++) hand.hot[i] = this.hot[i];
    hand.opacity = this.opacity;
  }
  /** Next time the hand shows, it appears in place instead of flying in. */
  sleep() {
    this.live = false;
  }
}

/* ---------- a fading hairline material: per vertex alpha ---------- */

export function fadeLineMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      uniform float uOpacity;
      varying float vA;
      void main() {
        vA = aAlpha * uOpacity;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vA;
      void main() { gl_FragColor = vec4(uColor, vA); }`,
    uniforms: { uColor: { value: new THREE.Color("#ededef") }, uOpacity: { value: 1 } },
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
}

export function setBlend(m: THREE.Material, dark: boolean) {
  const b = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
  if (m.blending !== b) {
    m.blending = b;
    m.needsUpdate = true;
  }
}

/* ---------- tiny mono label, drawn in WebGL (no DOM, so nothing to mount or unmount) ---------- */

export class MonoLabel extends THREE.Sprite {
  private canvas = document.createElement("canvas");
  private tex: THREE.CanvasTexture;
  private px = 7.7;
  constructor(private text: string, color = "#ededef") {
    super(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false, toneMapped: false }));
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;
    this.material.map = this.tex;
    this.center.set(0, 0.5);
    this.renderOrder = 30;
    this.raycast = () => {};
    this.draw(color);
  }
  draw(color: string) {
    const scale = 4;
    const g = this.canvas.getContext("2d")!;
    let fam = "";
    try {
      fam = getComputedStyle(document.documentElement).getPropertyValue("--font-mono-face").trim();
    } catch {}
    const font = `400 ${this.px * scale}px ${fam ? fam + ", " : ""}ui-monospace, "SF Mono", Menlo, monospace`;
    g.font = font;
    const ls = this.px * 0.08 * scale;
    const txt = this.text.toUpperCase();
    const w = Math.ceil(g.measureText(txt).width + ls * txt.length + 8);
    this.canvas.width = w;
    this.canvas.height = Math.ceil(this.px * 1.6 * scale);
    g.font = font;
    (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${ls}px`;
    g.fillStyle = color;
    g.textBaseline = "middle";
    g.fillText(txt, 2, this.canvas.height / 2);
    this.tex.needsUpdate = true;
    this.userData.aspect = this.canvas.width / this.canvas.height;
  }
  /** Keep a constant on-screen size: call each frame with the drawing buffer height, fov (radians) and pixel ratio. */
  fit(viewH: number, fovY: number, dpr: number) {
    const hPx = this.px * 1.6 * dpr;
    const sy = (hPx / viewH) * 2 * Math.tan(fovY / 2);
    this.scale.set(sy * (this.userData.aspect as number), sy, 1);
  }
  set opacity(v: number) {
    this.material.opacity = v;
    this.visible = v > 0.002;
  }
  dispose() {
    this.tex.dispose();
    this.material.dispose();
  }
}

/* ---------- screen overlay drawing kit (matches screen.ts) ---------- */

export const SIGNAL = "#ff5b1f";
export const FONT = `-apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif`;
export const MONO = `ui-monospace, "SF Mono", Menlo, monospace`;
export const ink = (a: number) => `rgba(237,237,239,${a})`;

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Quiet the window underneath so the answer to the gesture reads first. */
export function dim(g: CanvasRenderingContext2D, w: number, h: number, a: number) {
  g.fillStyle = `rgba(12,12,14,${0.78 * a})`;
  g.fillRect(0, 22, w, h - 22);
}

export function windowFrame(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, title: string, lift = 0) {
  if (lift > 0) {
    g.fillStyle = `rgba(0,0,0,${0.45 * lift})`;
    roundRect(g, x + 6, y + 14 * lift, w, h, 10);
    g.fill();
  }
  g.fillStyle = "#1b1b1e";
  roundRect(g, x, y, w, h, 10);
  g.fill();
  g.strokeStyle = `rgba(255,255,255,${0.08 + lift * 0.14})`;
  g.lineWidth = 1;
  g.stroke();
  for (let i = 0; i < 3; i++) {
    g.fillStyle = "#3a3a3e";
    g.beginPath();
    g.arc(x + 16 + i * 16, y + 15, 5, 0, Math.PI * 2);
    g.fill();
  }
  g.font = `500 11px ${FONT}`;
  g.fillStyle = ink(0.55);
  g.textAlign = "center";
  g.fillText(title, x + w / 2, y + 19);
  g.textAlign = "left";
  g.fillStyle = "rgba(255,255,255,0.06)";
  g.fillRect(x, y + 30, w, 1);
}

/** Placeholder text lines inside a window body. */
export function bodyLines(g: CanvasRenderingContext2D, x: number, y: number, w: number, rows: number, seed = 1) {
  for (let i = 0; i < rows; i++) {
    const len = 0.35 + (((i + 1) * 37 * seed) % 55) / 100;
    g.fillStyle = ink(i === 0 ? 0.5 : 0.18);
    g.fillRect(x, y + i * 22, w * len, i === 0 ? 9 : 6);
  }
}

/** Mono caption row along the bottom of the screen: left what the camera saw, right what it did. */
export function caption(g: CanvasRenderingContext2D, w: number, h: number, left: string, right: string, hot: number) {
  g.font = `500 10px ${MONO}`;
  g.fillStyle = ink(0.45);
  g.textAlign = "left";
  g.fillText(left, 40, h - 30);
  g.textAlign = "right";
  g.fillStyle = ink(0.75);
  g.fillText(right, w - 40, h - 30);
  if (hot > 0.02) {
    g.globalAlpha *= Math.min(1, hot * 1.4);
    g.fillStyle = SIGNAL;
    g.beginPath();
    g.arc(w - 48 - g.measureText(right).width, h - 33.5, 3, 0, Math.PI * 2);
    g.fill();
  }
  g.textAlign = "left";
}

/** Status chip, top right: what the add-on is doing. */
export function chip(g: CanvasRenderingContext2D, w: number, text: string) {
  g.font = `500 9px ${MONO}`;
  const tw = g.measureText(text).width;
  const x = w - tw - 58, y = 34;
  g.fillStyle = "rgba(28,28,30,0.9)";
  roundRect(g, x, y, tw + 30, 20, 10);
  g.fill();
  g.strokeStyle = "rgba(255,255,255,0.08)";
  g.stroke();
  g.fillStyle = ink(0.85);
  g.beginPath();
  g.arc(x + 11, y + 10, 2.5, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = ink(0.7);
  g.fillText(text, x + 20, y + 13.5);
}
