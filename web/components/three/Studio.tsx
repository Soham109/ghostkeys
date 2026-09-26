"use client";

import * as THREE from "three";
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Environment, Lightformer, useEnvironment } from "@react-three/drei";
import { BASE_H, D, W } from "@/lib/dims";
import { PALETTE, type Theme } from "@/lib/theme";
import { sceneBg } from "./tone";

/** CC0 studio HDRI (Poly Haven "studio_small_03", 1k), served from /public so nothing loads from a third party. */
export const HDR_URL = "/hdr/studio.hdr";

/** Layer the shadow camera renders. Laptop meshes enable it; nothing else casts. */
export const SHADOW_LAYER = 3;

/** A softbox gradient: bright core, long feathered falloff, so reflections on the metal read as light, not as a white card. */
function softboxTexture(kind: "strip" | "box") {
  const w = 256;
  const h = kind === "strip" ? 64 : 256;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w * 2 - 1;
      const v = (y + 0.5) / h * 2 - 1;
      // superellipse falloff with a slightly hotter top edge, like a real diffusion panel
      const d = Math.pow(Math.pow(Math.abs(u), 6) + Math.pow(Math.abs(v), 6), 1 / 6);
      let a = THREE.MathUtils.smoothstep(1.0, 0.55, d);
      a *= 0.78 + 0.22 * (1 - Math.abs(u));
      if (kind === "box") a *= 0.85 + 0.15 * (1 - (v + 1) / 2);
      const i = (y * w + x) * 4;
      const n = Math.random() * 2;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.min(255, a * 253 + n);
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const skyFrag = /* glsl */ `
uniform sampler2D uMap;
uniform float uGain;
uniform float uClamp;
uniform float uRot;
uniform vec3 uTint;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float c = cos(uRot), s = sin(uRot);
  d.xz = mat2(c, -s, s, c) * d.xz;
  vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(d.y, -1.0, 1.0)) / 3.1415927 + 0.5);
  vec3 col = texture2D(uMap, uv).rgb * uGain * uTint;
  // keep the practical lights in the HDRI from blowing past the bloom threshold on the metal
  col = min(col, vec3(uClamp));
  gl_FragColor = vec4(col, 1.0);
}
`;

/** The HDRI, drawn as a dimmed, clamped, rotated sky inside the environment portal (under the hand-placed softboxes). */
function HdrSky({ gain, rot, tint }: { gain: number; rot: number; tint: string }) {
  const map = useEnvironment({ files: HDR_URL });
  const uniforms = useMemo(
    () => ({ uMap: { value: map }, uGain: { value: gain }, uClamp: { value: 1.25 }, uRot: { value: rot }, uTint: { value: new THREE.Color(tint) } }),
    [map, gain, rot, tint],
  );
  return (
    <mesh scale={80} raycast={() => null}>
      <sphereGeometry args={[1, 64, 32]} />
      <shaderMaterial side={THREE.BackSide} depthWrite={false} uniforms={uniforms} vertexShader={skyVert} fragmentShader={skyFrag} toneMapped={false} />
    </mesh>
  );
}

/**
 * Studio light: a real HDRI (dimmed, it only provides the soft room) plus a few gradient softboxes that draw the
 * long highlights on the aluminum. Everything is baked once into a cube map; nothing here costs per frame.
 */
export function StudioLight({ theme, onReady }: { theme: Theme; onReady?: () => void }) {
  const dark = theme === "dark";
  const strip = useMemo(() => softboxTexture("strip"), []);
  const box = useMemo(() => softboxTexture("box"), []);
  useEffect(
    () => () => {
      strip.dispose();
      box.dispose();
    },
    [strip, box],
  );
  const k = dark ? 1 : 1.35;
  // this component suspends until the HDRI is decoded; by the time this effect runs the cube map is baked
  useEffect(() => {
    onReady?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);
  return (
    <Environment key={theme} resolution={512} frames={1} background={false} environmentIntensity={dark ? 1 : 1.1}>
      <color attach="background" args={[dark ? "#000000" : "#cfcfcb"]} />
      <HdrSky gain={dark ? 0.22 : 0.7} rot={2.2} tint={dark ? "#dfe3ea" : "#ffffff"} />
      {/* back wall: a large diffusion panel behind the laptop. In the three-quarter view the deck and palm rests
          reflect it, which is what makes them read as silver instead of a dark mirror */}
      <Lightformer form="rect" map={box} intensity={1.15 * k} scale={[18, 6.5, 1]} position={[-1.5, 2.4, -8.5]} />
      {/* overhead key: for top-down shots, a long gradient across the deck rather than a flat sheet */}
      <Lightformer form="rect" map={box} intensity={1.05 * k} scale={[9, 3.6, 1]} position={[0.6, 7, -0.8]} rotation-x={Math.PI / 2 + 0.22} />
      {/* left kicker: long vertical strip for the lid edge and the chamfer */}
      <Lightformer form="rect" map={strip} intensity={1.0 * k} scale={[9, 0.9, 1]} position={[-7, 2.2, 1.5]} rotation={[0, Math.PI / 2, Math.PI / 2]} />
      {/* right rim: thin and hot, draws the machined edge line */}
      <Lightformer form="rect" map={strip} intensity={1.5 * k} scale={[9, 0.4, 1]} position={[6.8, 2.4, -2.2]} rotation={[0, -Math.PI / 2.3, Math.PI / 2]} />
      {/* behind-right high strip: a crisp line along the back of the lid and the hinge */}
      <Lightformer form="rect" map={strip} intensity={1.2 * k} scale={[7, 0.5, 1]} position={[4.5, 5.5, -5.5]} rotation={[-0.6, -0.7, 0]} />
      {/* high behind: the back of the lid reflects this when the camera looks from behind */}
      <Lightformer form="rect" map={box} intensity={0.9 * k} scale={[12, 5, 1]} position={[0.5, 7.5, -6.5]} rotation-x={-Math.PI / 4.2 + Math.PI} />
      {/* floor bounce, low and behind: what the back of the open lid and the chassis walls reflect */}
      <Lightformer form="rect" map={box} intensity={0.75 * k} scale={[16, 6, 1]} position={[1.5, -4.2, -6]} />
      {/* front-right low strip: a thin bright line along the front lip in the hero */}
      <Lightformer form="rect" map={strip} intensity={0.9 * k} scale={[10, 0.7, 1]} position={[6, 0.4, 6.5]} />
      {/* low front fill so the front lip never goes fully black */}
      <Lightformer form="rect" map={strip} intensity={0.3 * k} scale={[14, 1.6, 1]} position={[0, 0.6, 8]} rotation-y={Math.PI} />
      {/* cool top-left accent, very faint, for a hint of temperature contrast against the warm signal */}
      <Lightformer form="circle" intensity={0.5 * k} color="#e8eef8" scale={1.6} position={[-4, 5.5, 4]} />
    </Environment>
  );
}

const floorFrag = /* glsl */ `
uniform sampler2D uTight;
uniform sampler2D uWide;
uniform vec3 uBg;
uniform vec3 uShadow;
uniform vec3 uPool;
uniform float uTightAmt;
uniform float uWideAmt;
uniform float uPoolAmt;
uniform float uFade;
varying vec2 vUv;
varying vec2 vP;
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  float tight = texture2D(uTight, vUv).r;
  float wide = texture2D(uWide, vUv).r;
  float shade = clamp(tight * uTightAmt + wide * uWideAmt, 0.0, 0.96);
  // a faint pool of light on the floor under the laptop, gone well before the edge of the plane
  float r = length(vP * vec2(0.55, 0.8));
  float pool = exp(-r * r * 0.35) * uPoolAmt;
  float edge = 1.0 - smoothstep(4.0, 9.0, length(vP));
  vec3 col = uBg + uPool * pool * edge;
  // interpolate in log space: the tone curve is close to logarithmic, so the shadow darkens evenly on screen
  // in both themes (a plain multiply barely shows on the light theme's bright floor)
  col = exp(mix(log(max(col, vec3(1e-4))), log(uShadow), shade * uFade));
  col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

const blurFrag = /* glsl */ `
uniform sampler2D tMap;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec4 s = vec4(0.0);
  float w[5];
  w[0] = 0.227027; w[1] = 0.1945946; w[2] = 0.1216216; w[3] = 0.054054; w[4] = 0.016216;
  s += texture2D(tMap, vUv) * w[0];
  for (int i = 1; i < 5; i++) {
    s += texture2D(tMap, vUv + uDir * float(i)) * w[i];
    s += texture2D(tMap, vUv - uDir * float(i)) * w[i];
  }
  gl_FragColor = s;
}
`;

const depthFrag = /* glsl */ `
uniform float uFar;
varying float vH;
void main() {
  // occlusion: strong where the caster is close to the floor, fading with height
  float a = pow(clamp(1.0 - vH / uFar, 0.0, 1.0), 2.2);
  gl_FragColor = vec4(a, a, a, 1.0);
}
`;
const depthVert = /* glsl */ `
uniform float uFloorY;
varying float vH;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  #ifdef USE_INSTANCING
    wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  #endif
  vH = wp.y - uFloorY;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/**
 * Seamless floor that is just the background color, darkened by two blurred occlusion maps (a tight contact line and
 * a wide soft shadow). The shadow re-renders only when `dirty()` says the laptop's pose changed, so it is free most frames.
 */
export function Floor({ theme, quality, dirty, fade }: { theme: Theme; quality: "high" | "low"; dirty?: () => boolean; fade?: () => number }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const dark = theme === "dark";
  const pal = PALETTE[theme];
  const res = quality === "high" ? 512 : 256;
  const bgLin = useMemo(() => sceneBg(pal.bg), [pal.bg]);
  // what full occlusion looks like on screen: near black on dark, a soft warm grey on light
  const shadowLin = useMemo(() => sceneBg(dark ? "#020202" : "#a9a9a4"), [dark]);
  const floorY = -BASE_H - 0.001;
  const SIZE = 7.2;

  const rig = useMemo(() => {
    const opts = { type: THREE.HalfFloatType, depthBuffer: true } as const;
    const raw = new THREE.WebGLRenderTarget(res, res, opts);
    const a = new THREE.WebGLRenderTarget(res / 2, res / 2, { type: THREE.HalfFloatType, depthBuffer: false });
    const b = new THREE.WebGLRenderTarget(res / 2, res / 2, { type: THREE.HalfFloatType, depthBuffer: false });
    const tight = new THREE.WebGLRenderTarget(res / 2, res / 2, { type: THREE.HalfFloatType, depthBuffer: false });
    const wide = new THREE.WebGLRenderTarget(res / 4, res / 4, { type: THREE.HalfFloatType, depthBuffer: false });
    const wide2 = new THREE.WebGLRenderTarget(res / 4, res / 4, { type: THREE.HalfFloatType, depthBuffer: false });
    const cam = new THREE.OrthographicCamera(-SIZE / 2, SIZE / 2, SIZE / 2, -SIZE / 2, 0, 3);
    cam.position.set(0, floorY, 0);
    cam.rotation.set(Math.PI / 2, 0, 0);
    cam.updateMatrixWorld();
    cam.layers.set(SHADOW_LAYER);
    const depthMat = new THREE.ShaderMaterial({ vertexShader: depthVert, fragmentShader: depthFrag, uniforms: { uFar: { value: 1.1 }, uFloorY: { value: floorY } }, side: THREE.DoubleSide });
    const blurMat = new THREE.ShaderMaterial({
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: blurFrag,
      uniforms: { tMap: { value: null }, uDir: { value: new THREE.Vector2() } },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blurMat);
    quad.frustumCulled = false;
    const quadScene = new THREE.Scene();
    quadScene.add(quad);
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    return { raw, a, b, tight, wide, wide2, cam, depthMat, blurMat, quadScene, ortho, quad };
  }, [res, floorY]);

  useEffect(
    () => () => {
      [rig.raw, rig.a, rig.b, rig.tight, rig.wide, rig.wide2].forEach((t) => t.dispose());
      rig.depthMat.dispose();
      rig.blurMat.dispose();
      rig.quad.geometry.dispose();
    },
    [rig],
  );

  const uniformsInit = useMemo(
    () => ({
      uTight: { value: rig.tight.texture },
      uWide: { value: rig.wide.texture },
      uBg: { value: new THREE.Color(pal.bg) },
      uShadow: { value: new THREE.Color() },
      uPool: { value: new THREE.Color(pal.ink) },
      uTightAmt: { value: 0.85 },
      uWideAmt: { value: 0.75 },
      uPoolAmt: { value: 0.03 },
      uFade: { value: 1 },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rig],
  );

  const frames = useRef(0);
  const blur = (src: THREE.WebGLRenderTarget, dst: THREE.WebGLRenderTarget, tmp: THREE.WebGLRenderTarget, px: number) => {
    const u = rig.blurMat.uniforms;
    u.tMap.value = src.texture;
    u.uDir.value.set(px / dst.width, 0);
    gl.setRenderTarget(tmp);
    gl.render(rig.quadScene, rig.ortho);
    u.tMap.value = tmp.texture;
    u.uDir.value.set(0, px / dst.height);
    gl.setRenderTarget(dst);
    gl.render(rig.quadScene, rig.ortho);
  };

  const floorMat = useRef<THREE.ShaderMaterial>(null!);
  useFrame(() => {
    // R3F copies uniform objects onto the material, so scalar writes must go to the material's own uniforms
    const uniforms = floorMat.current.uniforms as typeof uniformsInit;
    uniforms.uBg.value.copy(bgLin);
    uniforms.uShadow.value.copy(shadowLin);
    uniforms.uPool.value.set(pal.ink);
    uniforms.uPoolAmt.value = dark ? 0.008 : 0.0;
    uniforms.uTightAmt.value = dark ? 1.0 : 0.9;
    uniforms.uWideAmt.value = dark ? 1.4 : 1.5;
    uniforms.uFade.value = fade ? fade() : 1;
    // render the occlusion for the first frames (materials settle) and whenever the pose changes
    const need = frames.current < 3 || (dirty ? dirty() : false);
    if (!need) return;
    frames.current++;
    const prevTarget = gl.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevBg = scene.background;
    const prevClear = gl.getClearColor(new THREE.Color());
    const prevAlpha = gl.getClearAlpha();
    scene.overrideMaterial = rig.depthMat;
    scene.background = null;
    gl.setClearColor(0x000000, 1);
    gl.setRenderTarget(rig.raw);
    gl.clear();
    gl.render(scene, rig.cam);
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    // tight contact, then a wide soft shadow blurred from the tight one
    blur(rig.raw, rig.tight, rig.a, 1.5);
    blur(rig.tight, rig.b, rig.a, 2.0);
    blur(rig.b, rig.tight, rig.a, 1.0);
    blur(rig.tight, rig.wide, rig.wide2, 3.0);
    blur(rig.wide, rig.wide, rig.wide2, 5.0);
    blur(rig.wide, rig.wide, rig.wide2, 7.0);
    gl.setRenderTarget(prevTarget);
    gl.setClearColor(prevClear, prevAlpha);
  });

  return (
    <group position={[0, floorY, 0]}>
      {/* the shadow maps cover SIZE x SIZE around the laptop; the plane beyond is plain background */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={() => null} renderOrder={-1}>
        <planeGeometry args={[60, 60]} />
        <shaderMaterial
          ref={floorMat}
          uniforms={uniformsInit}
          depthWrite={false}
          vertexShader={`varying vec2 vUv; varying vec2 vP; uniform float uSize;
            void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vP = wp.xz; vUv = vec2(wp.x / ${SIZE.toFixed(2)} + 0.5, 0.5 + wp.z / ${SIZE.toFixed(2)}); gl_Position = projectionMatrix * viewMatrix * wp; }`}
          fragmentShader={floorFrag.replace(
            "float tight = texture2D(uTight, vUv).r;",
            "vec2 inb = step(vec2(0.0), vUv) * step(vUv, vec2(1.0)); float m = inb.x * inb.y; float tight = texture2D(uTight, vUv).r * m;",
          ).replace("float wide = texture2D(uWide, vUv).r;", "float wide = texture2D(uWide, vUv).r * m;")}
          toneMapped={false}
          fog={false}
        />
      </mesh>
    </group>
  );
}

/**
 * Soft radial light behind the laptop, ink at ~5% falling to nothing, dithered so it never bands.
 * Drawn as a camera-facing quad far behind the subject.
 */
export function BackLight({ theme, target }: { theme: Theme; target: THREE.Vector3 }) {
  const camera = useThree((s) => s.camera);
  const ref = useRef<THREE.Mesh>(null!);
  const pal = PALETTE[theme];
  const mat = useRef<THREE.ShaderMaterial>(null!);
  const uniformsInit = useMemo(
    () => ({ uInk: { value: new THREE.Color(pal.ink) }, uAlpha: { value: 0 }, uCenter: { value: new THREE.Vector2(0.5, 0.5) }, uAspect: { value: 1 } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const v = useMemo(() => new THREE.Vector3(), []);
  const size = useThree((s) => s.size);
  useFrame(() => {
    const m = ref.current;
    m.position.copy(camera.position);
    m.quaternion.copy(camera.quaternion);
    m.translateZ(-40);
    const cam = camera as THREE.PerspectiveCamera;
    const h = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * 40;
    m.scale.set(h * cam.aspect * 1.6, h * 1.6, 1);
    v.copy(target).project(camera);
    const uniforms = mat.current.uniforms as typeof uniformsInit;
    uniforms.uCenter.value.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
    uniforms.uAspect.value = size.width / size.height;
    uniforms.uInk.value.set(pal.ink);
    uniforms.uAlpha.value = theme === "dark" ? 0.0095 : 0.0;
  });
  return (
    <mesh ref={ref} renderOrder={-2} raycast={() => null} frustumCulled={false}>
      {/* depth tested at 40 units: it sits behind the laptop instead of washing over it */}
      <planeGeometry args={[1, 1]} />
      <shaderMaterial
        ref={mat}
        uniforms={uniformsInit}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        fog={false}
        toneMapped={false}
        vertexShader={`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`}
        fragmentShader={`
          uniform vec3 uInk; uniform float uAlpha; uniform vec2 uCenter; uniform float uAspect; varying vec2 vUv;
          float h(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
          void main(){
            vec2 uv = (vUv - 0.5) * 1.6 + 0.5;
            vec2 d = (uv - uCenter) * vec2(uAspect, 1.0);
            float fall = exp(-dot(d, d) * 2.2);
            // tiny dither only (film grain in post does the rest); must stay far below uAlpha or it adds light
            float n = (h(gl_FragCoord.xy) - 0.5) * uAlpha * 0.25;
            gl_FragColor = vec4(uInk, max(0.0, fall * (uAlpha + n)));
          }`}
      />
    </mesh>
  );
}

void W;
void D;
