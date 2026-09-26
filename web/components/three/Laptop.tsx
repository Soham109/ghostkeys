"use client";

import * as THREE from "three";
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import CustomShaderMaterial from "three-custom-shader-material/vanilla";
import { BASE_H, D, GRILLE, HINGE_Z, KB, LID_T, PAD, PLAN_R, W } from "@/lib/dims";
import { SHADOW_LAYER } from "./Studio";
import { PALETTE, type Theme } from "@/lib/theme";
import { RIPPLE_GLSL } from "./glsl";
import { buildKeys, flatRoundedRect, frame, grainTexture, legendTexture, roundedRectShape, slab } from "./geometry";
import type { TapField } from "./taps";
import { FLAT_HEIGHT, type WaterSim } from "./water";
/** Anything that can feed the display: ScreenPainter, or a custom painter with its own canvas texture. */
export type ScreenSurface = {
  texture: THREE.Texture;
  /** optional static base image (the real app's Live screen); `texture` is then composited over it by alpha */
  base?: THREE.Texture | null;
};

export type LaptopState = {
  /** lid opening in degrees, 0 = closed */
  lid: number;
  /** 0..1 how far the top case is lifted to show the inside */
  hood: number;
  /** 0..1 x-ray: the shell turns to glass and hairlines so the logic board and motion sensor show through */
  xray: number;
  /** 0..1 dithered visibility, used when particles hand over to the mesh */
  reveal: number;
  backlight: number;
  /** display brightness 0..1 */
  screen: number;
  /** ambient light sensor glow 0..1 */
  sensor: number;
  /** highlighted keys: deck-space rect (x0, z0, x1, z1) and amount 0..1 (a held modifier) */
  keyHi: THREE.Vector4;
  keyHiAmt: number;
  /** roll of the whole laptop in degrees (tilt gesture) */
  tilt: number;
};

export const makeLaptopState = (): LaptopState => ({
  lid: 108,
  hood: 0,
  xray: 0,
  reveal: 1,
  backlight: 0.9,
  screen: 1,
  sensor: 0,
  keyHi: new THREE.Vector4(-1.34, -0.289, -0.938, -0.102),
  keyHiAmt: 0,
  tilt: 0,
});

type Props = {
  state: LaptopState;
  taps: TapField;
  water: WaterSim | null;
  screen: ScreenSurface;
  theme: Theme;
  /** children rendered in the top-case space (moves with the hood) */
  deckChildren?: ReactNode;
  /** children rendered in the chassis space (stays put) */
  chassisChildren?: ReactNode;
  /** children rendered in lid space */
  lidChildren?: ReactNode;
  /** children rendered in base space that stay visible (edge zones, labels) */
  children?: ReactNode;
  onDeckPointerMove?: (x: number, z: number) => void;
  onDeckPointerDown?: (x: number, z: number, e: ThreeEvent<PointerEvent>) => void;
  onEdgePointerDown?: (side: "left" | "right", z: number) => void;
  onLidPointerDown?: () => void;
  onReady?: (parts: LaptopParts) => void;
};

export type LaptopParts = {
  root: THREE.Group;
  deck: THREE.Mesh;
  chassis: THREE.Mesh;
  lidShell: THREE.Mesh;
  lidGroup: THREE.Group;
};

const PLATE_T = 0.014;

/** Base color (F0) of the anodized aluminum per theme. Brighter than the flat UI token: metal gets its value from reflections. */
const ALU = { dark: "#c3c5c8", light: "#d0d2d5" } as const;
const BLOCK_TOP = -0.034;

const deckVertex = /* glsl */ `
uniform vec2 uHalf;
varying vec2 vDeckUv;
varying float vTop;
varying vec3 vT;
varying vec3 vB;
varying vec3 vUp;
void main() {
  vDeckUv = vec2((position.x + uHalf.x) / (2.0 * uHalf.x), (position.z + uHalf.y) / (2.0 * uHalf.y));
  vTop = step(0.7, normal.y);
  vT = normalize(normalMatrix * vec3(1.0, 0.0, 0.0));
  vB = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));
  vUp = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
}
`;

const deckFragment = /* glsl */ `
uniform sampler2D uHeight;
uniform vec2 uTexel;
uniform float uNormalAmt;
uniform float uRim;
uniform vec3 uSignal;
varying vec2 vDeckUv;
varying float vTop;
varying vec3 vT;
varying vec3 vB;
varying vec3 vUp;
void main() {
  float h = texture2D(uHeight, vDeckUv).x;
  float hx = texture2D(uHeight, vDeckUv + vec2(uTexel.x, 0.0)).x - texture2D(uHeight, vDeckUv - vec2(uTexel.x, 0.0)).x;
  float hz = texture2D(uHeight, vDeckUv + vec2(0.0, uTexel.y)).x - texture2D(uHeight, vDeckUv - vec2(0.0, uTexel.y)).x;
  vec3 n = normalize(vUp - (hx * vT + hz * vB) * uNormalAmt);
  csm_FragNormal = normalize(mix(csm_FragNormal, n, vTop));
  // no colour from the height field: the metal only bends light; orange is drawn by the touch ring alone
}
`;

const keyVertex = /* glsl */ `
${RIPPLE_GLSL}
uniform sampler2D uHeight;
uniform vec2 uHalf;
uniform vec4 uKb;
uniform vec4 uKeyHi;
uniform float uKeyHiAmt;
varying vec2 vLegendUv;
varying float vTopK;
varying float vWave;
varying float vHi;
void main() {
  vec4 c = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vHi = step(uKeyHi.x, c.x) * step(c.x, uKeyHi.z) * step(uKeyHi.y, c.z) * step(c.z, uKeyHi.w) * uKeyHiAmt;
  vec2 duv = vec2((c.x + uHalf.x) / (2.0 * uHalf.x), (c.z + uHalf.y) / (2.0 * uHalf.y));
  float h = texture2D(uHeight, duv).x;
  float ring = touchRing(c.xz, 0.05);
  float lift = clamp(h * 0.05, -0.004, 0.01) + ring * 0.011 - vHi * 0.005;
  csm_Position = position + vec3(0.0, lift, 0.0);
  vec4 lp = instanceMatrix * vec4(position, 1.0);
  vLegendUv = vec2((lp.x - uKb.x) / uKb.z, 1.0 - (lp.z - uKb.y) / uKb.w);
  vTopK = step(0.7, normal.y);
  vWave = ring + clamp(abs(h) * 1.5, 0.0, 1.0);
}
`;

const keyFragment = /* glsl */ `
uniform sampler2D uLegend;
uniform float uBacklight;
uniform vec3 uSignal;
varying vec2 vLegendUv;
varying float vTopK;
varying float vWave;
varying float vHi;
void main() {
  float lg = texture2D(uLegend, vLegendUv).r * vTopK;
  csm_DiffuseColor.rgb = mix(csm_DiffuseColor.rgb, vec3(0.55), lg * 0.35);
  csm_Emissive = csm_Emissive + vec3(0.92, 0.93, 0.95) * lg * uBacklight * 0.55 + vec3(0.95) * vHi * (0.12 + lg * 2.5);
}
`;

const ringVertex = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const ringFragment = /* glsl */ `
${RIPPLE_GLSL}
uniform vec3 uSignal;
uniform vec2 uHalf;
uniform float uGain;
uniform float uNormal;
varying vec2 vP;
float sdRoundRect(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  float mask = 1.0 - smoothstep(-0.02, 0.0, sdRoundRect(vP, uHalf, 0.12));
  float thin = touchRing(vP, 0.006);
  float soft = touchRing(vP, 0.03) * 0.22;
  float flash = rippleFlash(vP);
  vec3 col = uSignal * (thin * 2.4 + soft + flash * 1.6);
  col *= mask * uGain;
  if (uNormal > 0.5) {
    // light theme: normal blending, so encode intensity as alpha instead of adding light
    float a = clamp(max(max(col.r, col.g), col.b) * 0.8, 0.0, 1.0);
    gl_FragColor = vec4(mix(uSignal, vec3(1.0), 0.15), a);
  } else {
    gl_FragColor = vec4(col, 1.0);
  }
}
`;

export function Laptop({
  state,
  taps,
  water,
  screen,
  theme,
  deckChildren,
  chassisChildren,
  lidChildren,
  children,
  onDeckPointerMove,
  onDeckPointerDown,
  onEdgePointerDown,
  onLidPointerDown,
  onReady,
}: Props) {
  const root = useRef<THREE.Group>(null!);
  const hood = useRef<THREE.Group>(null!);
  const lid = useRef<THREE.Group>(null!);
  const innards = useRef<THREE.Group>(null!);
  const deckMesh = useRef<THREE.Mesh>(null!);
  const chassisMesh = useRef<THREE.Mesh>(null!);
  const lidShell = useRef<THREE.Mesh>(null!);
  const sensorMat = useRef<THREE.MeshBasicMaterial>(null!);
  const pal = PALETTE[theme];

  const geo = useMemo(() => {
    const keys = buildKeys();
    const groups = new Map<string, typeof keys>();
    for (const k of keys) {
      const id = `${k.w.toFixed(3)}x${k.d.toFixed(3)}`;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id)!.push(k);
    }
    const dots: [number, number][] = [];
    const cols = 10;
    const colW = (GRILLE.outer - GRILLE.inner - 0.016) / (cols - 1);
    const rowH = colW * 0.866;
    const rows = Math.floor((GRILLE.z1 - GRILLE.z0 - 0.01) / rowH);
    for (const side of [-1, 1])
      for (let r = 0; r <= rows; r++)
        for (let c = 0; c < cols - (r % 2); c++) {
          const x = GRILLE.inner + 0.008 + c * colW + (r % 2 ? colW / 2 : 0);
          dots.push([side * x, GRILLE.z0 + 0.005 + r * rowH]);
        }
    return {
      keys,
      groups: [...groups.values()],
      legend: legendTexture(keys),
      grain: grainTexture(),
      // small bevels: with a large one the bottom case, top case and lid read as three slabs with grooves between
      block: slab(W, D, PLAN_R, BASE_H - PLATE_T, 0.006, -BASE_H),
      rim: frame(W - 0.004, D - 0.004, PLAN_R - 0.002, 0.022, -BLOCK_TOP - PLATE_T + 0.0005, BLOCK_TOP),
      plate: slab(W, D, PLAN_R, PLATE_T, 0.006, -PLATE_T),
      liner: flatRoundedRect(W - 0.06, D - 0.06, PLAN_R - 0.03, -PLATE_T - 0.0006).rotateX(Math.PI).translate(0, 2 * (-PLATE_T - 0.0006), 0),
      well: flatRoundedRect(KB.x1 - KB.x0 + 0.03, KB.z1 - KB.z0 + 0.03, 0.02, 0.0004).translate(0, 0, (KB.z0 + KB.z1) / 2),
      padEdge: flatRoundedRect(PAD.x1 - PAD.x0 + 0.012, PAD.z1 - PAD.z0 + 0.012, 0.05, 0.0003).translate(0, 0, (PAD.z0 + PAD.z1) / 2),
      pad: flatRoundedRect(PAD.x1 - PAD.x0, PAD.z1 - PAD.z0, 0.045, 0.0007).translate(0, 0, (PAD.z0 + PAD.z1) / 2),
      lidShell: slab(W, D - 0.04, PLAN_R - 0.01, LID_T, 0.006, 0),
      dots,
      ringPlane: new THREE.PlaneGeometry(W, D, 1, 1).rotateX(-Math.PI / 2),
    };
  }, []);
  const edgeGeo = useMemo(() => {
    const e = (g: THREE.BufferGeometry) => new THREE.EdgesGeometry(g, 28);
    // keycap outlines as one merged set of hairlines (x-ray only)
    const pts: number[] = [];
    for (const k of geo.keys) {
      const ring = roundedRectShape(k.w, k.d, Math.min(0.012, k.d * 0.18)).getPoints(3);
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        pts.push(k.x + a.x, 0.0086, k.z - a.y, k.x + b.x, 0.0086, k.z - b.y);
      }
    }
    const keys = new THREE.BufferGeometry();
    keys.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return { block: e(geo.block), plate: e(geo.plate), lid: e(geo.lidShell), pad: e(geo.pad), keys };
  }, [geo]);
  useEffect(() => () => Object.values(edgeGeo).forEach((g) => g.dispose()), [edgeGeo]);

  useEffect(
    () => () => {
      geo.legend.dispose();
      geo.grain.dispose();
    },
    [geo],
  );

  const mats = useMemo(() => {
    // Anodized aluminum: a true metal (F0 near 0.9 before anodizing dulls it), bead-blasted so the roughness is
    // moderate, with a faint brushed direction along the width from anisotropy. No clearcoat: anodizing is not lacquer.
    const aluProps = {
      color: ALU[theme],
      metalness: 1,
      roughness: 0.4,
      roughnessMap: geo.grain,
      anisotropy: 0.35,
      anisotropyRotation: 0,
      clearcoat: 0,
      ior: 1.5,
      envMapIntensity: 1.0,
    };
    const alu = new THREE.MeshPhysicalMaterial(aluProps);
    const deck = new CustomShaderMaterial({
      baseMaterial: THREE.MeshPhysicalMaterial,
      vertexShader: deckVertex,
      fragmentShader: deckFragment,
      uniforms: {
        uHalf: { value: new THREE.Vector2(W / 2, D / 2) },
        uHeight: { value: FLAT_HEIGHT as THREE.Texture },
        uTexel: { value: new THREE.Vector2(1 / 256, 1 / 181) },
        uNormalAmt: { value: 11 },
        uRim: { value: 1.6 },
        uSignal: { value: new THREE.Color(pal.signal) },
      },
      ...aluProps,
    });
    const keys = new CustomShaderMaterial({
      baseMaterial: THREE.MeshPhysicalMaterial,
      vertexShader: keyVertex,
      fragmentShader: keyFragment,
      uniforms: {
        ...taps.uniforms,
        uHeight: deck.uniforms.uHeight,
        uHalf: { value: new THREE.Vector2(W / 2, D / 2) },
        uKb: { value: new THREE.Vector4(KB.x0, KB.z0, KB.x1 - KB.x0, KB.z1 - KB.z0) },
        uLegend: { value: geo.legend },
        uBacklight: { value: 0.9 },
        uKeyHi: { value: new THREE.Vector4() },
        uKeyHiAmt: { value: 0 },
        uSignal: deck.uniforms.uSignal,
      },
      // satin black keycaps: dielectric, soft sheen on the bevels
      color: "#0b0b0c",
      roughness: 0.48,
      metalness: 0.0,
      clearcoat: 0.12,
      clearcoatRoughness: 0.55,
      specularIntensity: 0.6,
    });
    const ring = new THREE.ShaderMaterial({
      vertexShader: ringVertex,
      fragmentShader: ringFragment,
      uniforms: {
        ...taps.uniforms,
        uSignal: deck.uniforms.uSignal,
        uHalf: { value: new THREE.Vector2(W / 2, D / 2) },
        uGain: { value: 1 },
        uNormal: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    // keyboard well: near black, with the backlight leaking up between the keycaps
    const black = new THREE.MeshStandardMaterial({ color: "#050506", roughness: 0.8, metalness: 0.1, emissive: new THREE.Color("#f3efe6"), emissiveIntensity: 0 });
    const liner = new THREE.MeshStandardMaterial({ color: "#1b1b1e", roughness: 0.6, metalness: 0.5 });
    // force-touch trackpad: glass with a satin etched finish over aluminum color
    const pad = new THREE.MeshPhysicalMaterial({ color: ALU[theme], metalness: 0.7, roughness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.28, envMapIntensity: 0.9 });
    const padEdge = new THREE.MeshStandardMaterial({ color: "#5a5b5e", metalness: 1, roughness: 0.22 });
    const glass = new THREE.MeshPhysicalMaterial({ color: "#030304", roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03 });
    const dots = new THREE.MeshBasicMaterial({ color: "#070708" });
    const hinge = new THREE.MeshStandardMaterial({ color: "#151517", roughness: 0.45, metalness: 0.8 });
    const inner = new THREE.MeshStandardMaterial({ color: "#111113", roughness: 0.85, metalness: 0.3 });
    // the display: the picture is emissive, and the glass on top still catches the softboxes
    const display = new THREE.MeshPhysicalMaterial({
      color: "#000000",
      roughness: 0.12,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      emissive: new THREE.Color("#ffffff"),
      emissiveIntensity: 1,
      envMapIntensity: 0.35,
    });
    const displayU = { uBase: { value: null as THREE.Texture | null }, uOver: { value: screen.texture }, uHasBase: { value: 0 }, uBright: { value: 1 } };
    display.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, displayU);
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec2 vScrUv;").replace("#include <uv_vertex>", "#include <uv_vertex>\nvScrUv = uv;");
      sh.fragmentShader = sh.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vScrUv;\nuniform sampler2D uBase;\nuniform sampler2D uOver;\nuniform float uHasBase;\nuniform float uBright;",
        )
        .replace(
          "#include <emissivemap_fragment>",
          `vec4 over = texture2D(uOver, vScrUv);
           vec3 scr = over.rgb;
           if (uHasBase > 0.5) { vec3 b = texture2D(uBase, vScrUv).rgb; scr = mix(b, over.rgb, over.a); }
           totalEmissiveRadiance = scr * uBright;`,
        );
    };
    // x-ray hairlines for the shell
    const edges = new THREE.LineBasicMaterial({ color: pal.ink, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
    return { alu, deck, keys, ring, black, liner, pad, padEdge, glass, dots, hinge, inner, display, displayU, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, taps]);

  // theme changes recolor the metal without rebuilding shaders
  useEffect(() => {
    mats.alu.color.set(ALU[theme]);
    (mats.deck as unknown as THREE.MeshPhysicalMaterial).color.set(ALU[theme]);
    mats.pad.color.set(ALU[theme]);
    mats.edges.color.set(pal.ink);
    (mats.deck.uniforms.uSignal.value as THREE.Color).set(pal.signal);
    mats.ring.blending = theme === "dark" ? THREE.AdditiveBlending : THREE.NormalBlending;
    mats.ring.uniforms.uGain.value = theme === "dark" ? 1 : 1.2;
    mats.ring.uniforms.uNormal.value = theme === "dark" ? 0 : 1;
    mats.ring.needsUpdate = true;
  }, [mats, pal, theme]);

  useEffect(() => {
    if (water?.ok) {
      mats.deck.uniforms.uTexel.value.copy(water.texel);
    }
  }, [water, mats]);

  useEffect(
    () => () => {
      Object.values(mats).forEach((m) => (m as THREE.Material).dispose?.());
    },
    [mats],
  );

  const revealMats = useMemo(
    () => [mats.alu, mats.deck, mats.keys, mats.black, mats.pad, mats.padEdge, mats.glass, mats.dots, mats.hinge, mats.display] as THREE.Material[],
    [mats],
  );
  const revealOn = useRef(false);
  // x-ray: these go to glass; each entry is [material, opacity it keeps at full x-ray]
  const xrayMats = useMemo(
    () =>
      [
        [mats.alu, 0.05],
        [mats.deck, 0.04],
        [mats.keys, 0.05],
        [mats.black, 0.02],
        [mats.pad, 0.04],
        [mats.padEdge, 0.1],
        [mats.dots, 0.06],
        [mats.liner, 0.0],
      ] as [THREE.Material, number][],
    [mats],
  );
  const xrayOn = useRef(false);

  useLayoutEffect(() => {
    // solid parts cast into the floor's occlusion map
    root.current.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || o.userData.noShadow) return;
      const mat = m.material as THREE.Material;
      if (mat && !mat.transparent && !(mat as THREE.ShaderMaterial).isShaderMaterial) o.layers.enable(SHADOW_LAYER);
    });
    onReady?.({ root: root.current, deck: deckMesh.current, chassis: chassisMesh.current, lidShell: lidShell.current, lidGroup: lid.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tmp = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    lid.current.rotation.x = -THREE.MathUtils.degToRad(state.lid);
    hood.current.rotation.x = -state.hood * 1.0;
    hood.current.position.y = state.hood * 0.06;
    innards.current.visible = state.hood > 0.002 || state.xray > 0.002;
    mats.keys.uniforms.uBacklight.value = state.backlight * (1 - state.xray);
    (mats.keys.uniforms.uKeyHi.value as THREE.Vector4).copy(state.keyHi);
    mats.keys.uniforms.uKeyHiAmt.value = state.keyHiAmt;
    root.current.rotation.z = THREE.MathUtils.degToRad(state.tilt);
    root.current.position.y = Math.abs(Math.sin(root.current.rotation.z)) * (W / 2);
    mats.deck.uniforms.uHeight.value = water?.ok ? water.texture : FLAT_HEIGHT;
    const surf = screen as ScreenSurface;
    mats.displayU.uOver.value = surf.texture;
    mats.displayU.uBase.value = surf.base ?? null;
    mats.displayU.uHasBase.value = surf.base ? 1 : 0;
    mats.displayU.uBright.value = (0.1 + 0.9 * state.screen) * (1 - state.xray * 0.6);
    (mats.black as THREE.MeshStandardMaterial).emissiveIntensity = state.backlight * 0.05 * (1 - state.xray);
    sensorMat.current.color.set(pal.signal).multiplyScalar(0.25 + state.sensor * 6);
    // dithered hand-over from particles to the solid mesh
    const r = state.reveal;
    const needHash = r < 0.999;
    if (needHash !== revealOn.current) {
      revealOn.current = needHash;
      for (const m of revealMats) {
        m.alphaHash = needHash;
        m.needsUpdate = true;
      }
    }
    if (needHash) for (const m of revealMats) m.opacity = r;
    root.current.visible = r > 0.001;

    // x-ray: shell to glass with hairline edges, internals show through
    const x = needHash ? 0 : state.xray;
    const needX = x > 0.001;
    if (needX !== xrayOn.current) {
      xrayOn.current = needX;
      for (const [m] of xrayMats) {
        m.transparent = needX;
        m.depthWrite = !needX;
        if (!needX) m.opacity = 1;
        m.needsUpdate = true;
      }
    }
    if (needX) {
      const e = x * x * (3 - 2 * x);
      for (const [m, keep] of xrayMats) m.opacity = 1 + (keep - 1) * e;
    }
    mats.edges.opacity = x * 0.2;
    mats.edges.visible = x > 0.001;
  });

  const toLocal = (e: ThreeEvent<PointerEvent>) => {
    tmp.copy(e.point);
    hood.current.worldToLocal(tmp);
    return tmp;
  };

  return (
    <group ref={root}>
      {/* chassis: the bottom case */}
      <group>
        <lineSegments geometry={edgeGeo.block} material={mats.edges} raycast={() => null} renderOrder={9} />
        <mesh ref={chassisMesh} geometry={geo.block} material={mats.alu} castShadow receiveShadow
          onPointerDown={onEdgePointerDown ? (e) => {
            const p = e.point.clone();
            root.current.worldToLocal(p);
            if (Math.abs(p.x) > W / 2 - 0.03) {
              e.stopPropagation();
              onEdgePointerDown(p.x < 0 ? "left" : "right", p.z);
            }
          } : undefined}
        />
        <group ref={innards} visible={false}>
          <mesh geometry={geo.rim} material={mats.inner} />
          <mesh position={[0, BLOCK_TOP + 0.0005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[W - 0.06, D - 0.06]} />
            <meshStandardMaterial color="#0e0e10" roughness={0.9} />
          </mesh>
          {chassisChildren}
        </group>
        {/* hinge barrel */}
        <mesh position={[0, 0.004, HINGE_Z - 0.012]} rotation={[0, 0, Math.PI / 2]} material={mats.hinge}>
          <cylinderGeometry args={[0.03, 0.03, 2.6, 24, 1]} />
        </mesh>
      </group>

      {/* top case: pivots at the back edge so it can lift like a hood */}
      <group position={[0, 0, -D / 2]}>
        <group ref={hood}>
          <group position={[0, 0, D / 2]}>
            <mesh
              ref={deckMesh}
              geometry={geo.plate}
              material={mats.deck as unknown as THREE.Material}
              receiveShadow
              onPointerMove={onDeckPointerMove ? (e) => { const p = toLocal(e); onDeckPointerMove(p.x, p.z); } : undefined}
              onPointerDown={onDeckPointerDown ? (e) => { const p = toLocal(e); onDeckPointerDown(p.x, p.z, e); } : undefined}
            />
            <mesh geometry={geo.liner} material={mats.liner} />
            <mesh geometry={geo.well} material={mats.black} />
            <mesh geometry={geo.padEdge} material={mats.padEdge} />
            <mesh geometry={geo.pad} material={mats.pad} />
            <lineSegments geometry={edgeGeo.plate} material={mats.edges} raycast={() => null} renderOrder={9} />
            <lineSegments geometry={edgeGeo.pad} material={mats.edges} raycast={() => null} renderOrder={9} />
            <lineSegments geometry={edgeGeo.keys} material={mats.edges} raycast={() => null} renderOrder={9} />
            <Keys groups={geo.groups} material={mats.keys as unknown as THREE.Material} />
            <GrilleDots dots={geo.dots} material={mats.dots} />
            <mesh geometry={geo.ringPlane} material={mats.ring} position={[0, 0.0022, 0]} renderOrder={5} raycast={() => null} />
            {deckChildren}
          </group>
        </group>
      </group>

      {/* lid */}
      <group ref={lid} position={[0, 0.0, HINGE_Z]}>
        <group position={[0, 0, D / 2 - 0.03]}>
          <lineSegments geometry={edgeGeo.lid} material={mats.edges} raycast={() => null} renderOrder={9} />
          <mesh ref={lidShell} geometry={geo.lidShell} material={mats.alu} castShadow
            onPointerDown={onLidPointerDown ? (e) => { e.stopPropagation(); onLidPointerDown(); } : undefined}
          />
          {/* black glass */}
          <mesh position={[0, -0.0006, 0]} rotation={[Math.PI / 2, 0, 0]} material={mats.glass}>
            <planeGeometry args={[W - 0.05, D - 0.08]} />
          </mesh>
          {/* display: content comes from ScreenPainter */}
          <mesh position={[0, -0.0012, 1.1375 - (D / 2 - 0.03)]} rotation={[Math.PI / 2, 0, 0]} material={mats.display}>
            <planeGeometry args={[2.98, 1.935]} />
          </mesh>
          {/* notch, camera, ambient light sensor */}
          <group position={[0, -0.0018, 2.075 - (D / 2 - 0.03)]} rotation={[Math.PI / 2, 0, 0]}>
            <mesh>
              <planeGeometry args={[0.2, 0.062]} />
              <meshBasicMaterial color="#020203" />
            </mesh>
            <mesh position={[0, 0.004, -0.0003]}>
              <circleGeometry args={[0.009, 20]} />
              <meshStandardMaterial color="#0d1016" roughness={0.1} metalness={0.4} />
            </mesh>
            <mesh position={[0.042, 0.004, -0.0003]}>
              <circleGeometry args={[0.0045, 16]} />
              <meshBasicMaterial ref={sensorMat} color="#ff5b1f" toneMapped={false} />
            </mesh>
          </group>
          <CoverHand state={state} />
          {lidChildren}
        </group>
      </group>
      {children}
    </group>
  );
}

function Keys({ groups, material }: { groups: ReturnType<typeof buildKeys>[]; material: THREE.Material }) {
  return (
    <>
      {groups.map((g, i) => (
        <KeyGroup key={i} keys={g} material={material} />
      ))}
    </>
  );
}

function KeyGroup({ keys, material }: { keys: ReturnType<typeof buildKeys>; material: THREE.Material }) {
  const ref = useRef<THREE.InstancedMesh>(null!);
  const geometry = useMemo(() => {
    const k = keys[0];
    // Rounded keycap: extruded rounded rect with a soft top bevel
    const g = slab(k.w, k.d, Math.min(0.012, k.d * 0.18), 0.011, 0.0025, 0, 6);
    return g;
  }, [keys]);
  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    keys.forEach((k, i) => {
      m.makeTranslation(k.x, -0.0025, k.z);
      ref.current.setMatrixAt(i, m);
    });
    ref.current.instanceMatrix.needsUpdate = true;
    ref.current.computeBoundingSphere();
  }, [keys]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <instancedMesh ref={ref} args={[geometry, material, keys.length]} frustumCulled={false} raycast={() => null} />;
}

function GrilleDots({ dots, material }: { dots: [number, number][]; material: THREE.Material }) {
  const ref = useRef<THREE.InstancedMesh>(null!);
  const geometry = useMemo(() => new THREE.CircleGeometry(0.0033, 8).rotateX(-Math.PI / 2), []);
  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    dots.forEach(([x, z], i) => {
      m.makeTranslation(x, 0.0006, z);
      ref.current.setMatrixAt(i, m);
    });
    ref.current.instanceMatrix.needsUpdate = true;
    ref.current.computeBoundingSphere();
  }, [dots]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <instancedMesh ref={ref} args={[geometry, material, dots.length]} raycast={() => null} />;
}

/** The shadow of a palm approaching the light sensor in the notch. */
function CoverHand({ state }: { state: LaptopState }) {
  const ref = useRef<THREE.Mesh>(null!);
  const mat = useRef<THREE.ShaderMaterial>(null!);
  useFrame(() => {
    const c = state.sensor;
    ref.current.visible = c > 0.01;
    ref.current.position.y = -0.12 - (1 - c) * 0.55;
    ref.current.position.x = 0.1 + (1 - c) * 0.35;
    mat.current.uniforms.uA.value = Math.min(1, c * 1.3);
  });
  return (
    <mesh ref={ref} position={[0.06, -0.3, 0.96]} rotation={[Math.PI / 2, 0, 0.2]} renderOrder={12} raycast={() => null}>
      <planeGeometry args={[0.62, 0.44]} />
      <shaderMaterial
        ref={mat}
        transparent
        depthWrite={false}
        uniforms={{ uA: { value: 0 } }}
        vertexShader={`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`}
        fragmentShader={`uniform float uA; varying vec2 vUv; void main(){ vec2 p = (vUv - 0.5) * vec2(1.0, 1.45); float d = length(p) * 2.0; float a = 1.0 - smoothstep(0.35, 1.0, d); gl_FragColor = vec4(vec3(0.0), a * 0.92 * uA); }`}
      />
    </mesh>
  );
}
