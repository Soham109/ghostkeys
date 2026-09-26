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
import { Particles, PARTICLE_LID, type ParticleControl } from "./Particles";
import { BackLight, Floor, StudioLight } from "./Studio";
import { Effects, type FxControl } from "./Effects";
import { TapField, now } from "./taps";
import { WaterSim } from "./water";
import { ScreenPainter, loadLiveTexture, type ScreenMode } from "./screen";
import { sceneBg } from "./tone";
import { buildFilm, makeChannels } from "./director";

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

function zonePoint(z: Zone, jitter = 0.25) {
  const u = z.rect.x + z.rect.w * (0.5 + (Math.random() - 0.5) * jitter);
  const v = z.rect.y + z.rect.h * (0.5 + (Math.random() - 0.5) * jitter);
  return { x: (u - 0.5) * W, z: (v - 0.5) * D, u, v };
}

/** Legacy fallback when the site only writes bus.pos (old single-section story). */
function legacyG(pos: number) {
  if (pos <= 0.6) return pos / 0.6;
  if (pos <= 5.3) return 1 + (pos - 0.6) / 4.7;
  if (pos <= 7.0) return 2;
  if (pos <= 8.75) return 3 + (pos - 7.0) / 1.75;
  return 4;
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
  const ch = useMemo(() => makeChannels(), []);
  const taps = useMemo(() => new TapField(), []);
  const screen = useMemo(() => new ScreenPainter(), []);
  const state = useMemo(() => makeLaptopState(), []);
  const zrt = useMemo(() => makeZoneRuntime(), []);
  const fx = useMemo<FxControl>(() => ({ dissolve: 0, aberration: 0, focus: new THREE.Vector3(0, 0.3, -0.3), bokeh: 0, hush: 0 }), []);
  const skipIntro = reduced || particleSize === 0;
  const control = useMemo<ParticleControl>(() => ({ k: 0, noise: 1, mix: 0, opacity: 0, flash: 0, swirl: 0, done: skipIntro }), [skipIntro]);
  const intro = useMemo(() => ({ lid: skipIntro ? 108 : PARTICLE_LID, open: skipIntro ? 1 : 0 }), [skipIntro]);
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
      if (alive) load.current.compiled = true;
    })();
    return () => {
      alive = false;
    };
  }, [parts, gl, scene, camera]);

  // --- intro: dust in the dark, the mark, then the laptop. One continuous sequence; it holds on the mark until
  // everything is loaded and compiled, so the laptop can never pop in half-ready.
  useEffect(() => {
    if (control.done) {
      state.reveal = 1;
      bus.introDone = true;
      bus.loaded = 1;
      return;
    }
    if (!parts) return;
    state.reveal = 0;
    bus.introDone = false;
    const tl = gsap.timeline({ delay: 0.15 });
    tl.to(control, { opacity: 1, duration: 1.2, ease: "power2.out" }, 0)
      .to(control, { k: 0.085, duration: 2.4, ease: "expo.out" }, 0.5)
      .to(control, { noise: 0.02, duration: 2.4, ease: "power3.out" }, 0.5)
      .add(() => bus.cue("swell"), 0.5)
      .to(control, { flash: 1, duration: 0.25, ease: "power2.out" }, 2.35)
      .to(control, { flash: 0.35, duration: 1.1, ease: "power2.inOut" }, 2.6)
      .addLabel("hold", 3.3)
      .add(() => {
        // hold on the mark (gently breathing) until the scene is ready
        const r = load.current;
        if (!(r.env && r.live && r.compiled)) {
          tl.pause();
          const id = window.setInterval(() => {
            const q = load.current;
            if (q.env && q.live && q.compiled) {
              window.clearInterval(id);
              tl.resume();
            }
          }, 60);
        }
      }, "hold")
      .to(control, { flash: 0, duration: 0.5, ease: "power1.in" }, "hold")
      .to(control, { mix: 1, duration: 2.1, ease: "power2.inOut" }, "hold")
      .to(control, { swirl: 1, duration: 1.0, ease: "power2.out" }, "hold")
      .to(control, { swirl: 0, duration: 1.1, ease: "power2.inOut" }, "hold+=1.0")
      .to(control, { noise: 0.25, duration: 0.5, ease: "power2.out" }, "hold")
      .to(control, { noise: 0.02, duration: 1.4, ease: "expo.out" }, "hold+=0.5")
      .to(state, { reveal: 1, duration: 1.1, ease: "power1.inOut" }, "hold+=1.75")
      .to(control, { opacity: 0, duration: 0.9, ease: "power1.in" }, "hold+=1.95")
      .to(intro, { lid: 108, duration: 1.7, ease: "power2.inOut" }, "hold+=2.2")
      .add(() => void (control.done = true), "hold+=2.9")
      .add(() => {
        intro.open = 1;
        bus.introDone = true;
      }, "hold+=3.9");
    // scrolling early speeds the film up instead of cutting it
    const id = window.setInterval(() => {
      const g = film.position(bus.chapters);
      if ((g > 0.35 || bus.pos > 0.25) && tl.progress() < 1) tl.timeScale(3.5);
    }, 150);
    return () => {
      window.clearInterval(id);
      tl.kill();
    };
  }, [parts, control, state, intro, film]);

  // the mark forms where the hero camera looks, facing it
  const logo = useMemo(() => {
    const v = film.sample(0);
    const center = new THREE.Vector3(0.1, 0.72, -0.25);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(v.px, v.py, v.pz), center, new THREE.Vector3(0, 1, 0));
    return { center, quat: new THREE.Quaternion().setFromRotationMatrix(m) };
  }, [film]);

  const camPos = useMemo(() => new THREE.Vector3(3.55, 2.45, 6.1), []);
  const camTgt = useMemo(() => new THREE.Vector3(0, 0.4, -0.35), []);
  const goalP = useMemo(() => new THREE.Vector3(), []);
  const goalT = useMemo(() => new THREE.Vector3(), []);
  const off = useMemo(() => new THREE.Vector3(), []);
  const sph = useMemo(() => new THREE.Spherical(), []);
  const shift = useRef({ x: 0.16, y: 0.1, fov: 30, init: false });
  const pointerSm = useRef({ x: 0, y: 0 });
  const sched = useRef({ next: 0, i: 0, zoneStep: -1, layerKey: "", finaleTap: false, g: 0 });
  const air = useRef({ id: "pinch", progress: 0, weight: 0 });
  const sound = useRef({ id: "knuckle", progress: 0, weight: 0 });
  const tryState = useRef<{ zone: string; name: string; count: number; timer: number }>({ zone: "", name: "", count: 0, timer: 0 });
  const lastPose = useRef({ lid: -1, tilt: -1 });
  const SENSOR = useMemo(() => new THREE.Vector3(0.42, -0.02, -0.42), []);

  const fireGesture = (zone: string, gesture: Gesture, action: string) => {
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
    hit(1, true);
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

    const hasChapters = Object.keys(bus.chapters).length > 0;
    const g = hasChapters ? film.position(bus.chapters) : legacyG(bus.pos);
    film.sample(g, ch);
    const cp = (id: string) => bus.chapters[id as keyof typeof bus.chapters] ?? 0;
    const inChapter = (id: string) => {
      const k = film.index.get(id);
      return k !== undefined && g >= k && g < k + 1;
    };

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
    const k = reduced || !shift.current.init ? 1 : 1 - Math.exp(-dt * 6.5);
    shift.current.init = true;
    camPos.lerp(goalP, k);
    camTgt.lerp(goalT, k);
    camera.position.copy(camPos);
    camera.lookAt(camTgt);
    shift.current.fov += (ch.fov + (narrow ? 6 : 0) - shift.current.fov) * k;
    shift.current.x += ((narrow ? 0 : ch.sx) - shift.current.x) * k;
    shift.current.y += ((narrow ? ch.sy * 0.5 + 0.12 : ch.sy) - shift.current.y) * k;
    camera.fov = shift.current.fov;
    const w = size.width, h = size.height;
    camera.setViewOffset(w, h, -shift.current.x * w, shift.current.y * h, w, h);
    camera.updateProjectionMatrix();

    // ---------- laptop pose and light
    const introOpen = intro.open;
    state.lid = introOpen >= 1 ? ch.lid : intro.lid;
    state.tilt = ch.tilt;
    state.xray = reduced ? 0 : ch.xray;
    state.screen = ch.screen;
    state.backlight = ch.backlight * (1 - ch.hush * 0.8);
    state.sensor = 0;
    fx.hush = ch.hush;
    fx.bokeh = reduced ? 0 : ch.bokeh;
    fx.focus = fx.focus ?? new THREE.Vector3();
    if (state.xray > 0.3) fx.focus.copy(SENSOR);
    else fx.focus.copy(camTgt);
    fx.aberration = Math.min(1, Math.abs(bus.velocity) * 0.25);
    (scene as THREE.Scene & { environmentIntensity: number }).environmentIntensity = 1 - ch.hush * 0.55;

    const sc = sched.current;
    let mode: ScreenMode = "map";
    // zone visibility defaults
    for (const z of ZONES) {
      zrt.levels[z.id] = ch.zonesAll;
      zrt.labels[z.id] = "";
    }

    // ---------- intro: the hero keeps a slow rhythm of taps once the lid is open
    if (inChapter("intro") && bus.introDone && !reduced && t > sc.next) {
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
    if (airOn || (g > (film.index.get("air") ?? 99) - 0.15 && g < (film.index.get("air") ?? -99) + 1.15)) {
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
      // fade in as the chapter arrives, cross-fade at the split, fade out as layers begins
      const inW = smooth(0.0, 0.07, pa) * (1 - smooth(0.97, 1.0, pa));
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
        if (first) fireGesture(first, "tap", labels[first]);
        sc.next = t + 1.3;
      } else if (t > sc.next) {
        const ids = Object.keys(labels);
        const id = ids[sc.i++ % ids.length];
        fireGesture(id, "tap", labels[id]);
        sc.next = t + 1.6;
      }
    } else sc.layerKey = "";
    screen.setMode(mode);

    // ---------- try: all zones outlined, visitor clicks resolve to gestures (handled in onDown)
    if (inChapter("try")) {
      for (const z of customZones) zrt.levels[z.id] = Math.max(zrt.levels[z.id] ?? 0, ch.zonesAll);
    }

    // ---------- finale: one last ripple as the lid comes down
    if (inChapter("finale")) {
      const p = cp("finale");
      if (p > 0.42 && !sc.finaleTap) {
        sc.finaleTap = true;
        taps.tap(0.95, 0.62, 1.1);
        bus.cue("tap");
      } else if (p < 0.3) sc.finaleTap = false;
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
  const inTry = () => {
    const k = film.index.get("try");
    return k !== undefined && sched.current.g >= k - 0.05 && sched.current.g < k + 1;
  };
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

  const allZones = useMemo(() => [...ZONES, ...customZones], [customZones]);

  return (
    <>
      <primitive attach="background" object={bg} />
      <fog attach="fog" args={[bg, 11, 30]} />
      <Suspense fallback={null}>
        <StudioLight theme={theme} onReady={onEnvReady} />
      </Suspense>
      <BackLight theme={theme} target={logo.center} />
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
        {/* AIR_MOUNT */}
      </Laptop>
      {!control.done && (
        <Particles size={particleSize} parts={parts} control={control} logoCenter={logo.center} logoQuat={logo.quat} ink={pal.ink} signal={pal.signal} dark={dark} />
      )}
      <Floor theme={theme} quality={quality} dirty={shadowDirty} fade={() => state.reveal * (1 - state.xray * 0.7)} />
      <Effects theme={theme} quality={quality} fx={fx} />
    </>
  );
}
