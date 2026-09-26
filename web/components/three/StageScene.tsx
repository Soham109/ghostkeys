"use client";

import * as THREE from "three";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import gsap from "gsap";
import { D, KB, PAD, W } from "@/lib/dims";
import { ZONES, zoneById, type Zone } from "@/lib/zones";
import { APPS } from "@/lib/apps";
import { bus, ZONE_SHORT } from "@/lib/stage";
import { AIR_SOUND_SPLIT, AIR_STEPS, LAYER_STEPS, SOUND_STEPS, stepAt } from "@/lib/chapters";
import { PALETTE, type Theme } from "@/lib/theme";
import { Laptop, makeLaptopState, type LaptopParts } from "./Laptop";
import { Internals } from "./Internals";
import { ZoneLayer, makeZoneRuntime } from "./Zones";
import { TapLabels } from "./TapLabels";
import { BackLight, Floor, StudioLight } from "./Studio";
import { Effects, type FxControl } from "./Effects";
import { TapField, now } from "./taps";
import { WaterSim } from "./water";
import { ScreenPainter, loadLiveTexture, type ScreenMode } from "./screen";
import { sceneBg } from "./tone";
import { buildFilm, makeChannels } from "./director";
import { AirGestureScene, SoundScene } from "./air";

type Gesture = "tap" | "double" | "triple" | "rhythm";

const HERO_TAPS: { zone: string; gesture: Gesture; action: string }[] = [
  { zone: "right-palm", gesture: "double", action: "Next track" },
  { zone: "left-palm", gesture: "tap", action: "Play or pause" },
  { zone: "right-grille", gesture: "double", action: "Volume up" },
  { zone: "top-strip", gesture: "tap", action: "Mission Control" },
  { zone: "left-grille", gesture: "triple", action: "Screenshot" },
];

/** Zones chapter: the surfaces light up in the site's ZONE_STEPS order. */
const ZONE_GROUPS = [["left-palm", "right-palm"], ["left-grille", "right-grille"], ["top-strip"], ["left-edge", "right-edge"], ["lid"]];

/** Layers chapter: what each LAYER_STEPS beat puts on screen and on the zones. */
const LAYER_BEATS: Record<string, { modes: ScreenMode[]; labels: (i: number) => Record<string, string> }> = {
  layers: { modes: ["sheet", "design", "music", "code"], labels: (i) => APPS[i].bindings },
  excel: {
    modes: ["sheet"],
    labels: () => ({ "left-palm": "Paste values", "right-palm": "Fill down", "left-grille": "Toggle $ refs", "right-grille": "Trace precedents", "top-strip": "Sum selection" }),
  },
  macros: {
    modes: ["code"],
    labels: () => ({ "left-palm": "Run macro", "right-palm": "Record macro", "left-grille": "Step back", "right-grille": "Step forward", "top-strip": "Macro list" }),
  },
  composer: { modes: ["composer"], labels: () => ({ "left-grille": "Mute call, pause music" }) },
};

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Cold open: two macro camera marks low over the left palm rest, the tap point, and the timing (seconds). */
const INTRO_END = 2.45;
const MACRO = {
  a: { pos: new THREE.Vector3(-2.55, 0.3, 1.95), tgt: new THREE.Vector3(-0.95, 0.0, 0.55) },
  b: { pos: new THREE.Vector3(-1.75, 0.46, 2.2), tgt: new THREE.Vector3(-0.85, 0.0, 0.5) },
  fov: 24,
  tap: { x: -1.02, z: 0.62 },
};
const BACK_TARGET = new THREE.Vector3(0.1, 0.72, -0.25);
/** crawl, whip, crawl (the promo film's speed ramp) */
const whip = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2;
};

function zonePoint(z: Zone, jitter = 0.25) {
  const u = z.rect.x + z.rect.w * (0.5 + (Math.random() - 0.5) * jitter);
  const v = z.rect.y + z.rect.h * (0.5 + (Math.random() - 0.5) * jitter);
  return { x: (u - 0.5) * W, z: (v - 0.5) * D, u, v };
}

/**
 * Page scroll in viewport heights: the film's time axis. The site may publish it as `bus.scroll`; otherwise it is read
 * from the window (a plain property read, no layout). Pages without scroll (tests) fall back to chapter progress.
 */
function makeScrollPos(film: ReturnType<typeof buildFilm>) {
  return () => {
    const pub = (bus as unknown as { scroll?: number }).scroll;
    if (typeof pub === "number") return pub;
    const vh = window.innerHeight || 1;
    if (document.documentElement.scrollHeight > vh * 1.5) return window.scrollY / vh;
    return film.position(bus.chapters);
  };
}

export function StageScene({ theme, quality, particleSize, reduced }: { theme: Theme; quality: "high" | "low"; particleSize: number; reduced: boolean }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const pal = PALETTE[theme];
  const dark = theme === "dark";
  const bg = useMemo(() => sceneBg(pal.bg), [pal.bg]);

  const film = useMemo(() => buildFilm(), []);
  const scrollPos = useMemo(() => makeScrollPos(film), [film]);
  const ch = useMemo(() => makeChannels(), []);
  const taps = useMemo(() => new TapField(), []);
  const screen = useMemo(() => new ScreenPainter(), []);
  const state = useMemo(() => makeLaptopState(), []);
  const zrt = useMemo(() => makeZoneRuntime(), []);
  const fx = useMemo<FxControl>(() => ({ dissolve: 0, aberration: 0, focus: new THREE.Vector3(0, 0.3, -0.3), bokeh: 0, hush: 0 }), []);
  const skipIntro = reduced || particleSize === 0;
  // cold open clock: -1 until everything is ready, then seconds since the reveal began
  const intro = useMemo(() => ({ start: -1, speed: 1, t: skipIntro ? 99 : -1, tapped: false }), [skipIntro]);
  const [parts, setParts] = useState<LaptopParts | null>(null);
  const [customZones, setCustomZones] = useState<Zone[]>(() => bus.demo.customZones);
  const load = useRef({ env: false, live: false, compiled: false });

  const water = useMemo(() => {
    const w = new WaterSim(gl, quality === "high" ? 256 : 128, W / D);
    return w.ok ? w : null;
  }, [gl, quality]);
  useEffect(() => {
    taps.water = water;
    return () => water?.dispose();
  }, [water, taps]);
  useEffect(() => () => screen.dispose(), [screen]);

  // --- preload: HDRI, the Live screenshot, and every shader variant the film will use, all behind the dust
  useEffect(() => {
    let alive = true;
    loadLiveTexture()
      .then(() => alive && (load.current.live = true))
      .catch(() => alive && (load.current.live = true));
    return () => {
      alive = false;
    };
  }, []);
  const onEnvReady = () => void (load.current.env = true);
  useEffect(() => {
    if (!parts) return;
    let alive = true;
    const wait = () => new Promise<void>((r) => {
      const id = window.setInterval(() => {
        if (!alive || load.current.env) {
          window.clearInterval(id);
          r();
        }
      }, 50);
    });
    (async () => {
      await wait();
      if (!alive) return;
      // compile the base programs, then the dithered-reveal and x-ray (transparent) variants, so no switch hitches later
      const mats = new Set<THREE.Material>();
      parts.root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m && !(m as THREE.ShaderMaterial).isShaderMaterial && !(m as THREE.LineBasicMaterial).isLineBasicMaterial) mats.add(m);
      });
      const snapshot = [...mats].map((m) => [m, m.alphaHash, m.transparent, m.depthWrite] as const);
      const pass = async (fn: (m: THREE.Material) => void) => {
        mats.forEach((m) => {
          fn(m);
          m.needsUpdate = true;
        });
        try {
          await gl.compileAsync(scene, camera);
        } catch {
          gl.compile(scene, camera);
        }
      };
      await pass(() => {});
      await pass((m) => void (m.alphaHash = true));
      await pass((m) => {
        m.alphaHash = false;
        m.transparent = true;
      });
      for (const [m, a, t, d] of snapshot) {
        m.alphaHash = a;
        m.transparent = t;
        m.depthWrite = d;
        m.needsUpdate = true;
      }
      if (!alive) return;
      // one warm render with everything forced visible (fragments discarded by the reveal dither), so geometry
      // buffers and textures are uploaded now, behind the dark, not on the frame the laptop appears
      const saved: [THREE.Object3D, boolean, boolean][] = [];
      parts.root.traverse((o) => {
        saved.push([o, o.visible, o.frustumCulled]);
        o.visible = true;
        o.frustumCulled = false;
      });
      const rt = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType });
      const prev = gl.getRenderTarget();
      gl.setRenderTarget(rt);
      gl.render(scene, camera);
      gl.setRenderTarget(prev);
      rt.dispose();
      for (const [o, v, f] of saved) {
        o.visible = v;
        o.frustumCulled = f;
      }
      load.current.compiled = true;
    })();
    return () => {
      alive = false;
    };
  }, [parts, gl, scene, camera]);

  // --- cold open (like the promo film): the laptop is already there in the dark; a studio light sweeps across the
  // aluminum while the camera glides low over the palm rest, a first tap sends the ring through the metal, and the
  // camera settles into the hero. It starts only when everything is loaded and compiled (black frame until then).
  useEffect(() => {
    if (skipIntro) {
      state.reveal = 1;
      bus.introDone = true;
      bus.loaded = 1;
      return;
    }
    bus.introDone = false;
    const born = performance.now();
    const gate = window.setInterval(() => {
      const q = load.current;
      if ((q.env && q.live && q.compiled) || performance.now() - born > 3000) {
        window.clearInterval(gate);
        intro.start = now();
      }
    }, 30);
    return () => window.clearInterval(gate);
  }, [skipIntro, state, intro]);

  const camPos = useMemo(() => new THREE.Vector3(3.55, 2.45, 6.1), []);
  const camTgt = useMemo(() => new THREE.Vector3(0, 0.4, -0.35), []);
  const goalP = useMemo(() => new THREE.Vector3(), []);
  const goalT = useMemo(() => new THREE.Vector3(), []);
  const off = useMemo(() => new THREE.Vector3(), []);
  const sph = useMemo(() => new THREE.Spherical(), []);
  const sweep = useRef<THREE.DirectionalLight>(null);
  const IA = useMemo(() => ({ pos: new THREE.Vector3(), tgt: new THREE.Vector3() }), []);
  const shift = useRef({ x: 0.16, y: 0.1, fov: 30, init: false });
  const pointerSm = useRef({ x: 0, y: 0 });
  const sched = useRef({ next: 0, i: 0, zoneStep: -1, layerKey: "", finaleTap: false, introDoneHold: false, revealed: new Set<string>(), g: 0, loc: { id: "intro", local: 0 } });
  const air = useRef({ id: "pinch", progress: 0, weight: 0 });
  const sound = useRef({ id: "knuckle", progress: 0, weight: 0 });
  const tryState = useRef<{ zone: string; name: string; count: number; timer: number }>({ zone: "", name: "", count: 0, timer: 0 });
  const lastPose = useRef({ lid: -1, tilt: -1 });
  const SENSOR = useMemo(() => new THREE.Vector3(0.42, -0.02, -0.42), []);

  const fireGesture = (zone: string, gesture: Gesture, action: string, pill = true) => {
    const z = zoneById(zone);
    const label = { zone: ZONE_SHORT[zone] ?? z.name, action };
    const hit = (s: number, withLabel: boolean) => {
      zrt.flashes[zone] = taps.time;
      if (z.surface === "base") {
        const q = zonePoint(z, 0.12);
        taps.tap(q.x, q.z, s, withLabel ? label : undefined);
        screen.markTap(q.u, q.v, taps.time);
      } else if (withLabel) {
        const y = z.surface === "lid" ? 1.2 : 0.05;
        const x = z.surface === "edge-left" ? -W / 2 - 0.1 : z.surface === "edge-right" ? W / 2 + 0.1 : 0;
        const zz = z.surface === "lid" ? -D / 2 - 0.35 : (z.rect.y + z.rect.h / 2 - 0.5) * D;
        taps.tap(x, zz, 0, { ...label, y });
      }
      bus.cue("tap");
    };
    hit(1, pill);
    screen.showHud(`${label.zone} · ${action}`, taps.time);
    const times = gesture === "double" ? [0.17] : gesture === "triple" ? [0.16, 0.32] : gesture === "rhythm" ? [0.62, 0.79] : [];
    times.forEach((dt) => window.setTimeout(() => hit(0.85, false), dt * 1000));
  };

  useFrame((s, dtRaw) => {
    const dt = Math.min(dtRaw, 1 / 20);
    const t = now();
    taps.update(t);
    if (bus.demo.customZones !== customZones) setCustomZones(bus.demo.customZones);
    const r = load.current;
    bus.loaded = Math.max(bus.loaded, (r.env ? 0.45 : 0) + (r.live ? 0.2 : 0) + (r.compiled ? 0.35 : 0));

    const g = scrollPos();
    film.sample(g, ch);
    const loc = film.locate(g);
    sched.current.loc = loc;
    const cp = (id: string) => bus.chapters[id as keyof typeof bus.chapters] ?? 0;
    // a chapter "owns" the frame from the moment its section starts scrolling in
    const inChapter = (id: string) => loc.id === id;

    // ---------- camera: sampled film, damped follow, orbit parallax to the cursor, a breath of hand-held drift
    const narrow = size.width < 768;
    const portrait = size.width / size.height < 1;
    pointerSm.current.x = THREE.MathUtils.damp(pointerSm.current.x, reduced ? 0 : bus.pointer.x, 2.5, dt);
    pointerSm.current.y = THREE.MathUtils.damp(pointerSm.current.y, reduced ? 0 : bus.pointer.y, 2.5, dt);
    goalT.set(ch.tx, ch.ty, ch.tz);
    off.set(ch.px - ch.tx, ch.py - ch.ty, ch.pz - ch.tz).multiplyScalar(ch.dolly * (narrow || portrait ? 1.45 : 1));
    sph.setFromVector3(off);
    const drift = reduced ? 0 : 1;
    sph.theta += (pointerSm.current.x * 0.06 + Math.sin(t * 0.11) * 0.006 * drift) * (reduced ? 0 : 1);
    sph.phi = THREE.MathUtils.clamp(sph.phi - pointerSm.current.y * 0.035 + Math.sin(t * 0.083 + 1.3) * 0.004 * drift, 0.02, Math.PI - 0.02);
    goalP.setFromSpherical(sph).add(goalT);
    let fovGoal = ch.fov + (narrow ? 6 : 0);
    let sxGoal = narrow ? 0 : ch.sx;
    const copyTop = loc.id === "zones" || loc.id === "air" || loc.id === "try";
    let syGoal = narrow ? (copyTop ? -0.17 : 0.15) : ch.sy;

    // ---------- cold open: macro glide over the left palm rest, first tap, whip back to the hero
    let lightUp = 1;
    let introCam = 0;
    if (!skipIntro) {
      if (intro.t < INTRO_END) {
        // before everything is ready: hold the first macro mark in the dark (nothing visible, nothing loading)
        if (intro.start >= 0) {
          if (scrollPos() > 0.12) intro.speed = 3;
          intro.t = Math.max(0, intro.t) + dt * intro.speed;
        }
        const ti = Math.max(0, intro.t);
        lightUp = intro.start < 0 ? 0 : smooth(0.0, 1.0, ti);
        // glide: slow and even, like a dolly
        const g1 = smooth(0, 1.35, ti);
        IA.pos.lerpVectors(MACRO.a.pos, MACRO.b.pos, g1);
        IA.tgt.lerpVectors(MACRO.a.tgt, MACRO.b.tgt, g1);
        // then the whip back to the hero framing: crawl, fast, crawl
        const wv = whip(Math.min(1, Math.max(0, (ti - 1.4) / (INTRO_END - 1.4))));
        introCam = 1 - wv;
        goalP.lerpVectors(IA.pos, goalP, wv);
        goalT.lerpVectors(IA.tgt, goalT, wv);
        fovGoal = THREE.MathUtils.lerp(MACRO.fov, fovGoal, wv);
        // the macro sits in the right half of the frame, clear of the headline
        sxGoal = THREE.MathUtils.lerp(0.2, sxGoal, wv);
        syGoal = THREE.MathUtils.lerp(0.08, syGoal, wv);
        if (ti > 1.15 && !intro.tapped) {
          intro.tapped = true;
          const z = zoneById("left-palm");
          taps.tap(MACRO.tap.x, MACRO.tap.z, 1.1, { zone: ZONE_SHORT["left-palm"] ?? z.name, action: "Play or pause" });
          zrt.flashes["left-palm"] = t;
          screen.markTap(MACRO.tap.x / W + 0.5, MACRO.tap.z / D + 0.5, t);
          screen.showHud("Left palm · Play or pause", t);
          bus.cue("tap");
        }
        if (intro.t >= INTRO_END) {
          bus.introDone = true;
          sched.current.next = t + 1.6;
        }
      }
    }
    const k = reduced || !shift.current.init || introCam > 0.001 ? 1 : 1 - Math.exp(-dt * 6.5);
    shift.current.init = true;
    camPos.lerp(goalP, k);
    camTgt.lerp(goalT, k);
    camera.position.copy(camPos);
    camera.lookAt(camTgt);
    shift.current.fov += (fovGoal - shift.current.fov) * k;
    shift.current.x += (sxGoal - shift.current.x) * k;
    // phones: copy spans the width, so the laptop moves to whichever half the chapter's copy is not in
    shift.current.y += (syGoal - shift.current.y) * k;
    camera.fov = shift.current.fov;
    const w = size.width, h = size.height;
    camera.setViewOffset(w, h, -shift.current.x * w, shift.current.y * h, w, h);
    camera.updateProjectionMatrix();

    // ---------- laptop pose and light
    state.lid = ch.lid;
    state.tilt = ch.tilt;
    state.xray = reduced ? 0 : ch.xray;
    state.screen = ch.screen * smooth(0.55, 1.25, skipIntro ? 9 : intro.t);
    state.backlight = ch.backlight * (1 - ch.hush * 0.8) * smooth(0.35, 1.2, skipIntro ? 9 : intro.t);
    state.sensor = 0;
    fx.hush = ch.hush;
    fx.bokeh = reduced ? 0 : Math.max(ch.bokeh, introCam * 0.75);
    fx.focus = fx.focus ?? new THREE.Vector3();
    if (state.xray > 0.3) fx.focus.copy(SENSOR);
    else if (introCam > 0.05) fx.focus.set(MACRO.tap.x, 0, MACRO.tap.z);
    else fx.focus.copy(camTgt);
    // the sweep: a key light that crosses the aluminum once during the cold open, then rests at zero
    if (sweep.current) {
      const ti = skipIntro || intro.start < 0 ? -1 : intro.t;
      const u = smooth(0.05, 1.7, ti);
      sweep.current.position.set(-7 + u * 14, 3.2, 2.5 - u * 1.5);
      sweep.current.intensity = ti < 0 || ti > 2.2 ? 0 : Math.sin(Math.PI * u) * 3.2;
    }
    fx.aberration = Math.min(1, Math.abs(bus.velocity) * 0.25);
    (scene as THREE.Scene & { environmentIntensity: number }).environmentIntensity = (1 - ch.hush * 0.55) * lightUp;

    const sc = sched.current;
    let mode: ScreenMode = "map";
    // zone visibility defaults
    for (const z of ZONES) {
      zrt.levels[z.id] = ch.zonesAll;
      zrt.labels[z.id] = "";
    }

    // ---------- intro: the hero keeps a slow rhythm of taps once the lid is open
    if (inChapter("intro") && bus.introDone && !reduced && t > sc.next && !sc.introDoneHold) {
      const gst = HERO_TAPS[sc.i++ % HERO_TAPS.length];
      fireGesture(gst.zone, gst.gesture, gst.action);
      sc.next = t + 2.1;
    }

    // ---------- zones: five surfaces in order; during the x-ray the palm taps visibly reach the sensor
    if (inChapter("zones")) {
      const p = cp("zones");
      const step = stepAt(p, ZONE_GROUPS.length);
      ZONE_GROUPS.forEach((grp, gi) => {
        for (const id of grp) {
          zrt.levels[id] = gi === step ? 1 : gi < step ? 0.28 : 0;
          if (gi === step) zrt.labels[id] = ZONE_SHORT[id] ?? "";
        }
      });
      if (step !== sc.zoneStep) {
        sc.zoneStep = step;
        for (const id of ZONE_GROUPS[step]) fireGesture(id, "tap", "Tap");
        sc.next = t + 0.9;
      } else if (t > sc.next && bus.introDone) {
        const grp = ZONE_GROUPS[step];
        const id = grp[sc.i++ % grp.length];
        const z = zoneById(id);
        zrt.flashes[id] = t;
        if (z.surface === "base") {
          const q = zonePoint(z, 0.5);
          taps.tap(q.x, q.z, 0.85);
          screen.markTap(q.u, q.v, t);
        }
        bus.cue("tap");
        sc.next = t + (state.xray > 0.5 ? 0.85 : 1.25);
      }
    } else sc.zoneStep = -1;

    // ---------- air and sound (camera add-on, sound mode)
    const pa = cp("air");
    const airOn = inChapter("air");
    const split = AIR_SOUND_SPLIT;
    const a = air.current;
    const so = sound.current;
    if (airOn) {
      const pAir = Math.min(0.9999, pa / split);
      const na = AIR_STEPS.length;
      const ia = stepAt(pAir, na);
      a.id = AIR_STEPS[ia].id;
      a.progress = pAir * na - ia;
      const ps = Math.min(0.9999, Math.max(0, (pa - split) / (1 - split)));
      const ns = SOUND_STEPS.length;
      const is = stepAt(ps, ns);
      so.id = SOUND_STEPS[is].id;
      so.progress = ps * ns - is;
      // fade in while the chapter scrolls in, cross-fade at the split, fade out as layers begins
      const inW = smooth(-0.6, -0.2, loc.local) * (1 - smooth(0.97, 1.0, pa));
      a.weight = inW * (1 - smooth(split - 0.035, split + 0.005, pa));
      so.weight = inW * smooth(split - 0.005, split + 0.035, pa);
    } else {
      a.weight = 0;
      so.weight = 0;
    }

    // ---------- layers: per-app layouts, Excel tools, macros, the composer
    if (inChapter("layers")) {
      const p = cp("layers");
      const n = LAYER_STEPS.length;
      const i = stepAt(p, n);
      const local = p * n - i;
      const beat = LAYER_BEATS[LAYER_STEPS[i].id] ?? LAYER_BEATS.layers;
      const mi = Math.min(beat.modes.length - 1, Math.floor(local * beat.modes.length));
      mode = beat.modes[mi];
      if (mode === "composer") screen.composer = Math.min(1, local * 1.15);
      const labels = beat.labels(mi);
      for (const id of Object.keys(labels)) {
        zrt.levels[id] = Math.max(zrt.levels[id] ?? 0, 0.9);
        zrt.labels[id] = labels[id];
      }
      const key = `${i}:${mi}`;
      if (key !== sc.layerKey) {
        sc.layerKey = key;
        const first = Object.keys(labels)[0];
        if (first) fireGesture(first, "tap", labels[first], false);
        sc.next = t + 1.3;
      } else if (t > sc.next) {
        const ids = Object.keys(labels);
        const id = ids[sc.i++ % ids.length];
        fireGesture(id, "tap", labels[id], false);
        sc.next = t + 1.6;
      }
    } else sc.layerKey = "";
    screen.setMode(mode);

    // ---------- try: while the chapter scrolls in, the zones draw on one by one, each with a tap; then all stay
    // outlined and visitor clicks resolve to gestures (handled in onDown)
    if (inChapter("try") && loc.local < 0) {
      ZONES.forEach((z, i) => {
        const a = -0.85 + i * 0.075;
        const lv = smooth(a, a + 0.12, loc.local);
        zrt.levels[z.id] = Math.max(zrt.levels[z.id] ?? 0, lv);
        const on = lv > 0.5;
        if (on && !sc.revealed.has(z.id)) {
          sc.revealed.add(z.id);
          zrt.flashes[z.id] = t;
          if (z.surface === "base") {
            const q = zonePoint(z, 0.2);
            taps.tap(q.x, q.z, 0.6);
          }
        } else if (!on) sc.revealed.delete(z.id);
      });
    }
    if (inChapter("try")) {
      for (const z of customZones) zrt.levels[z.id] = Math.max(zrt.levels[z.id] ?? 0, ch.zonesAll);
    }

    // ---------- finale: one last ripple as the lid comes down
    if (inChapter("finale")) {
      const p = loc.local;
      if (p > -0.45 && !sc.finaleTap) {
        sc.finaleTap = true;
        taps.tap(0.95, 0.62, 1.1);
        bus.cue("tap");
      } else if (p < -0.6) sc.finaleTap = false;
    }

    water?.step(quality === "high" ? 2 : 1);
    screen.paint(t);
    sc.g = g;
  });

  // ---------- pointer
  const zoneAt = (x: number, z: number): Zone | null => {
    const u = x / W + 0.5;
    const v = z / D + 0.5;
    const hit = (q: Zone) => q.surface === "base" && u >= q.rect.x && u <= q.rect.x + q.rect.w && v >= q.rect.y && v <= q.rect.y + q.rect.h;
    for (let i = customZones.length - 1; i >= 0; i--) if (hit(customZones[i])) return customZones[i];
    return ZONES.find(hit) ?? null;
  };
  const inTry = () => sched.current.loc.id === "try" && sched.current.loc.local > -0.35;
  const resolveTry = (zoneId: string, name: string) => {
    const ts = tryState.current;
    if (ts.zone === zoneId) ts.count++;
    else {
      ts.zone = zoneId;
      ts.name = name;
      ts.count = 1;
    }
    window.clearTimeout(ts.timer);
    ts.timer = window.setTimeout(() => {
      const gesture = ts.count >= 3 ? "triple" : ts.count === 2 ? "double" : "tap";
      const action = zoneId === "keyboard" || zoneId === "trackpad" ? null : bus.demo.bindings[zoneId]?.[gesture] ?? null;
      bus.fire({ zone: zoneId, zoneName: ts.name, gesture, count: ts.count, action });
      if (action) screen.showHud(`${ts.name} · ${action}`, taps.time);
      ts.zone = "";
      ts.count = 0;
    }, 340);
  };
  const onMove = (x: number, z: number) => {
    taps.stir(x, z, 1);
    const zone = inTry() ? zoneAt(x, z) : null;
    zrt.hover = zone?.id ?? null;
    document.body.style.cursor = zone ? "pointer" : "";
  };
  const onDown = (x: number, z: number) => {
    const zone = zoneAt(x, z);
    const onKeys = x > KB.x0 && x < KB.x1 && z > KB.z0 && z < KB.z1;
    const onPad = x > PAD.x0 && x < PAD.x1 && z > PAD.z0 && z < PAD.z1;
    const name = zone ? ZONE_SHORT[zone.id] ?? zone.name : "";
    taps.tap(x, z, 1, zone ? { zone: name, action: inTry() ? "Tap" : "Tap" } : undefined);
    if (zone) zrt.flashes[zone.id] = taps.time;
    screen.markTap(x / W + 0.5, z / D + 0.5, taps.time);
    bus.cue("tap");
    if (inTry()) {
      if (zone) resolveTry(zone.id, name);
      else if (onKeys) resolveTry("keyboard", "Keyboard");
      else if (onPad) resolveTry("trackpad", "Trackpad");
    }
  };
  const onEdge = (side: "left" | "right", z: number) => {
    const id = side === "left" ? "left-edge" : "right-edge";
    zrt.flashes[id] = taps.time;
    taps.tap(side === "left" ? -W / 2 - 0.1 : W / 2 + 0.1, z, 0, { zone: ZONE_SHORT[id], action: "Tap", y: 0.05 });
    bus.cue("tap");
    if (inTry()) resolveTry(id, ZONE_SHORT[id]);
  };
  const onLid = () => {
    zrt.flashes.lid = taps.time;
    bus.cue("tap");
    if (inTry()) resolveTry("lid", ZONE_SHORT.lid);
  };

  const shadowDirty = () => {
    const p = lastPose.current;
    const d = Math.abs(p.lid - state.lid) > 0.25 || Math.abs(p.tilt - state.tilt) > 0.1;
    if (d) {
      p.lid = state.lid;
      p.tilt = state.tilt;
    }
    return d;
  };

  const airSource = useMemo(() => () => air.current, []);
  const soundSource = useMemo(() => () => sound.current, []);
  const allZones = useMemo(() => [...ZONES, ...customZones], [customZones]);

  return (
    <>
      <primitive attach="background" object={bg} />
      <fog attach="fog" args={[bg, 11, 30]} />
      <Suspense fallback={null}>
        <StudioLight theme={theme} onReady={onEnvReady} />
      </Suspense>
      <BackLight theme={theme} target={BACK_TARGET} />
      {/* cold-open sweep light (always mounted so the shader programs never change) */}
      <directionalLight ref={sweep} intensity={0} color="#f4f5f8" position={[-7, 3.2, 2.5]} />
      <Laptop
        state={state}
        taps={taps}
        water={water}
        screen={screen}
        theme={theme}
        onReady={setParts}
        onDeckPointerMove={reduced ? undefined : onMove}
        onDeckPointerDown={onDown}
        onEdgePointerDown={onEdge}
        onLidPointerDown={onLid}
        deckChildren={
          <>
            <ZoneLayer zones={allZones} surface="base" rt={zrt} taps={taps} ink={pal.ink} signal={pal.signal} dark={dark} />
            <TapLabels taps={taps} />
          </>
        }
        chassisChildren={<Internals taps={taps} state={state} signal={pal.signal} ink={pal.ink} />}
        lidChildren={<ZoneLayer zones={ZONES} surface="lid" rt={zrt} taps={taps} ink={pal.ink} signal={pal.signal} dark={dark} />}
      >
        <ZoneLayer zones={ZONES} surface="edges" rt={zrt} taps={taps} ink={pal.ink} signal={pal.signal} dark={dark} />
        {!reduced && (
          <>
            <AirGestureScene source={airSource} screen={screen} taps={taps} ink={pal.ink} signal={pal.signal} dark={dark} />
            <SoundScene source={soundSource} screen={screen} taps={taps} ink={pal.ink} signal={pal.signal} dark={dark} />
          </>
        )}
      </Laptop>
      <Floor theme={theme} quality={quality} dirty={shadowDirty} fade={() => state.reveal * (1 - state.xray * 0.7) * (skipIntro ? 1 : smooth(0, 1, intro.t))} />
      <Effects theme={theme} quality={quality} fx={fx} />
    </>
  );
}
