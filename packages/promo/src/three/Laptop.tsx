import React, { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { BODY, LID, PAD, keyRects, grilleHoles, roundedRectShape } from "./laptopGeo";
import { makeDeckMaterial, MAX_RIPPLES } from "./deckMaterial";
import { LID_ANGLE, ZONES, ZONE_RECTS, Tap, calibrationHits } from "../timeline";

const HITS = calibrationHits();
/** Calibration heat map: every accepted calibration tap adds a soft blob where it landed. */
const drawHeat = (cv: HTMLCanvasElement, frame: number) => {
  const ctx = cv.getContext("2d")!;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.globalCompositeOperation = "lighter";
  for (const h of HITS) {
    if (h.f > frame) break;
    const age = frame - h.f;
    const px = (h.x / BODY.w + 0.5) * cv.width;
    const py = (h.z / BODY.d + 0.5) * cv.height;
    const r = 26 + Math.min(1, age / 8) * 18;
    const fresh = Math.exp(-age / 6);
    const g = ctx.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, `rgba(255,91,31,${0.34 + fresh * 0.5})`);
    g.addColorStop(0.5, `rgba(255,91,31,${0.12 + fresh * 0.2})`);
    g.addColorStop(1, "rgba(255,91,31,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
};
import { makeScreenCanvas, drawScreen } from "./screen";

export type LaptopState = {
  opacity: number;
  xray: number;
  zoneGlow: number[]; // per ZONE_RECTS entry 0..1 (bone white outline)
  zoneHot: number[]; // per ZONE_RECTS entry 0..1 (signal)
  heat: number;
  screenOn: number;
  chipPulse: number;
};

const ALU = "#A7A9AC";

/** Ripple strengths for deck taps active at `frame`. */
export const activeRipples = (taps: Tap[], frame: number, fps: number) =>
  taps
    .filter((t) => frame >= t.f && frame - t.f < fps * 2.6 && ZONES[t.zone].deck)
    .slice(-MAX_RIPPLES)
    .map((t) => ({ x: ZONES[t.zone].deck![0], z: ZONES[t.zone].deck![1], age: (frame - t.f) / fps, s: t.zone.startsWith("edge") ? 0.8 : 1 }));

export const Laptop: React.FC<{ frame: number; fps: number; taps: Tap[]; st: LaptopState }> = ({ frame, fps, taps, st }) => {
  const geo = useMemo(() => {
    const body = new RoundedBoxGeometry(BODY.w, BODY.h, BODY.d, 6, BODY.r);
    const deck = new THREE.PlaneGeometry(BODY.w - BODY.r * 2 + 0.2, BODY.d - BODY.r * 2 + 0.2, 300, 210);
    const key = new RoundedBoxGeometry(1, 0.2, 1, 2, 0.08);
    const pad = new RoundedBoxGeometry(PAD.w, 0.05, PAD.d, 3, 0.02);
    const padTop = new THREE.ShapeGeometry(roundedRectShape(PAD.w, PAD.d, 0.55), 12);
    const hole = new THREE.CircleGeometry(0.075, 10);
    const lid = new RoundedBoxGeometry(LID.w, LID.t, LID.d, 6, 0.2);
    const screen = new THREE.PlaneGeometry(LID.w - 1.3, LID.d - 1.5);
    const hinge = new THREE.CylinderGeometry(0.42, 0.42, 26, 24);
    const bodyEdges = new THREE.EdgesGeometry(body, 30);
    const lidEdges = new THREE.EdgesGeometry(lid, 30);
    return { body, deck, key, pad, padTop, hole, lid, screen, hinge, bodyEdges, lidEdges };
  }, []);

  const mats = useMemo(() => {
    const alu = new THREE.MeshPhysicalMaterial({ color: ALU, metalness: 1, roughness: 0.34, envMapIntensity: 1 });
    const deck = makeDeckMaterial();
    const key = new THREE.MeshPhysicalMaterial({ color: "#111114", metalness: 0, roughness: 0.5, clearcoat: 0.3 });
    const pad = new THREE.MeshPhysicalMaterial({ color: "#8c8e92", metalness: 0.85, roughness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.25 });
    const hole = new THREE.MeshBasicMaterial({ color: "#050506" });
    const lid = new THREE.MeshPhysicalMaterial({ color: ALU, metalness: 1, roughness: 0.32 });
    const screenCv = makeScreenCanvas();
    const screenTex = new THREE.CanvasTexture(screenCv.canvas);
    screenTex.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.MeshPhysicalMaterial({
      color: "#020203",
      metalness: 0,
      roughness: 0.2,
      clearcoat: 0.35,
      clearcoatRoughness: 0.22,
      envMapIntensity: 0.4,
      emissive: new THREE.Color("#ffffff"),
      emissiveMap: screenTex,
      emissiveIntensity: 1,
    });
    const bezel = new THREE.MeshPhysicalMaterial({ color: "#050506", roughness: 0.2, metalness: 0, clearcoat: 1 });
    const hinge = new THREE.MeshStandardMaterial({ color: "#1a1a1d", metalness: 0.6, roughness: 0.4 });
    const edge = new THREE.LineBasicMaterial({ color: "#EDEDEF", transparent: true, opacity: 0 });
    const heatCv = document.createElement("canvas");
    heatCv.width = 608;
    heatCv.height = 424;
    const heatTex = new THREE.CanvasTexture(heatCv);
    deck.uniforms.uHeat.value = heatTex;
    return { alu, deck, key, pad, hole, lid, screen, screenCv, screenTex, bezel, hinge, edge, heatCv, heatTex };
  }, []);

  const keys = useMemo(() => keyRects(), []);
  const holes = useMemo(() => grilleHoles(), []);
  const keyMesh = useMemo(() => new THREE.InstancedMesh(geo.key, mats.key, keys.length), [geo, mats, keys]);
  const holeMesh = useMemo(() => {
    const m = new THREE.InstancedMesh(geo.hole, mats.hole, holes.length);
    const o = new THREE.Object3D();
    holes.forEach(([x, z], i) => {
      o.position.set(x, 0.03, z);
      o.rotation.set(-Math.PI / 2, 0, 0);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    return m;
  }, [geo, mats, holes]);

  const ripples = activeRipples(taps, frame, fps);

  useLayoutEffect(() => {
    // --- ripples into the shader
    const u = mats.deck.uniforms;
    for (let i = 0; i < MAX_RIPPLES; i++) {
      const r = ripples[i];
      u.uRip.value[i].set(r ? r.x : 0, r ? r.z : 0, r ? r.age : -1, r ? r.s : 0);
    }
    ZONE_RECTS.forEach((z, i) => {
      u.uZones.value[i].set(z.r[0], z.r[1], z.r[2], z.r[3]);
      u.uZoneGlow.value[i] = st.zoneGlow[i] ?? 0;
      u.uZoneHot.value[i] = st.zoneHot[i] ?? 0;
    });
    u.uHeatAmt.value = st.heat;
    if (st.heat > 0.001) {
      drawHeat(mats.heatCv, frame);
      mats.heatTex.needsUpdate = true;
    }
    u.uXray.value = st.xray;

    // --- keys bob as the wave passes under them
    const o = new THREE.Object3D();
    keys.forEach((k, i) => {
      let lift = 0;
      for (const r of ripples) {
        const d = Math.hypot(k.x - r.x, k.z - r.z);
        const x = d - r.age * 24;
        lift += Math.exp(-x * x / 3) * Math.exp(-r.age * 2.4) * r.s * 0.09;
      }
      o.position.set(k.x, 0.02 + lift, k.z);
      o.scale.set(k.w, 1, k.d);
      o.updateMatrix();
      keyMesh.setMatrixAt(i, o.matrix);
    });
    keyMesh.instanceMatrix.needsUpdate = true;

    // --- x-ray: chassis goes translucent
    const solid = 1 - st.xray;
    const setT = (m: THREE.Material, base: number) => {
      const op = (base + (1 - base) * solid) * st.opacity;
      const wantT = op < 0.999;
      if (m.transparent !== wantT) {
        m.transparent = wantT;
        m.needsUpdate = true;
      }
      m.opacity = op;
      m.depthWrite = !wantT;
    };
    setT(mats.alu, 0.05);
    setT(mats.deck.mat, 0.07);
    setT(mats.key, 0.12);
    setT(mats.pad, 0.08);
    setT(mats.lid, 0.06);
    setT(mats.bezel, 0.1);
    setT(mats.screen, 0.2);
    setT(mats.hole, 0.1);
    setT(mats.hinge, 0.1);
    mats.edge.opacity = st.xray * 0.55 * st.opacity;

    // --- screen HUD
    drawScreen(mats.screenCv, frame, fps, taps, st.screenOn);
    mats.screenTex.needsUpdate = true;
  });

  const lidRot = -LID_ANGLE;

  return (
    <group>
      <mesh geometry={geo.body} material={mats.alu} position={[0, -BODY.h / 2, 0]} />
      <lineSegments geometry={geo.bodyEdges} material={mats.edge} position={[0, -BODY.h / 2, 0]} />
      <mesh geometry={geo.deck} material={mats.deck.mat} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} />
      <primitive object={keyMesh} />
      <primitive object={holeMesh} />
      <mesh geometry={geo.pad} material={mats.pad} position={[0, 0.04, PAD.z]} />
      {/* hinge */}
      <mesh geometry={geo.hinge} material={mats.hinge} rotation={[0, 0, Math.PI / 2]} position={[0, -0.1, -10.45]} />
      {/* lid: hinge at origin of this group, closed along +z */}
      <group position={[0, 0.1, -10.6]} rotation={[lidRot, 0, 0]}>
        <mesh geometry={geo.lid} material={mats.lid} position={[0, LID.t / 2, LID.d / 2]} />
        <lineSegments geometry={geo.lidEdges} material={mats.edge} position={[0, LID.t / 2, LID.d / 2]} />
        {/* inner face (screen side) faces -y in lid space */}
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, -0.004, LID.d / 2]} material={mats.bezel}>
          <planeGeometry args={[LID.w - 0.5, LID.d - 0.4]} />
        </mesh>
        <mesh geometry={geo.screen} material={mats.screen} rotation={[Math.PI / 2, 0, 0]} position={[0, -0.01, LID.d / 2 + 0.3]} />
      </group>
    </group>
  );
};
