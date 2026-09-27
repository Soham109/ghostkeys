import React, { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { rng } from "../lib";
import { BODY, PAD, keyRects, grilleHoles } from "./laptopGeo";
import { lidPointWorld } from "../timeline";

export const LOGO_CENTER: [number, number, number] = [0, 7, 0];
export const LOGO_SCALE = 14 / 128;
export const logoToWorld = (lx: number, ly: number): [number, number, number] => [
  LOGO_CENTER[0] + (lx - 64) * LOGO_SCALE,
  LOGO_CENTER[1] - (ly - 64) * LOGO_SCALE,
  LOGO_CENTER[2],
];

const onRoundedRect = (x: number, y: number, w: number, h: number, r: number, u: number): [number, number] => {
  const sw = w - 2 * r, sh = h - 2 * r, arc = (Math.PI * r) / 2;
  const lens = [sw, arc, sh, arc, sw, arc, sh, arc];
  const per = lens.reduce((a, b) => a + b, 0);
  let d = u * per;
  const segs: Array<(k: number) => [number, number]> = [
    (k) => [x + r + k, y],
    (k) => { const a = -Math.PI / 2 + k / r; return [x + w - r + Math.cos(a) * r, y + r + Math.sin(a) * r]; },
    (k) => [x + w, y + r + k],
    (k) => { const a = k / r; return [x + w - r + Math.cos(a) * r, y + h - r + Math.sin(a) * r]; },
    (k) => [x + w - r - k, y + h],
    (k) => { const a = Math.PI / 2 + k / r; return [x + r + Math.cos(a) * r, y + h - r + Math.sin(a) * r]; },
    (k) => [x, y + h - r - k],
    (k) => { const a = Math.PI + k / r; return [x + r + Math.cos(a) * r, y + r + Math.sin(a) * r]; },
  ];
  for (let i = 0; i < 8; i++) {
    if (d <= lens[i]) return segs[i](d);
    d -= lens[i];
  }
  return [x + r, y];
};

const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
vec3 curl(vec3 p){
  const float e=0.1;
  vec3 dx=vec3(e,0,0), dy=vec3(0,e,0), dz=vec3(0,0,e);
  float n1=snoise(p+dy+vec3(31.4)), n2=snoise(p-dy+vec3(31.4));
  float n3=snoise(p+dz+vec3(-17.1)), n4=snoise(p-dz+vec3(-17.1));
  float n5=snoise(p+dz), n6=snoise(p-dz);
  float n7=snoise(p+dx+vec3(31.4)), n8=snoise(p-dx+vec3(31.4));
  float n9=snoise(p+dx+vec3(-17.1)), n10=snoise(p-dx+vec3(-17.1));
  float n11=snoise(p+dy), n12=snoise(p-dy);
  return vec3((n1-n2)-(n3-n4), (n5-n6)-(n9-n10), (n7-n8)-(n11-n12))/(2.0*e);
}
`;

export type ParticleState = {
  t: number; // seconds since burst
  burst: number;
  logo: number; // 0..1 global converge progress onto logo
  flash: number;
  shatter: number;
  lap: number; // 0..1 converge onto laptop
  alpha: number;
  dot: [number, number, number];
  pixelScale: number;
};

export const Particles: React.FC<{ count: number; st: ParticleState }> = ({ count, st }) => {
  const { geometry, material } = useMemo(() => {
    const R = rng(42);
    const logo = new Float32Array(count * 3);
    const lap = new Float32Array(count * 3);
    const dir = new Float32Array(count * 3);
    const rnd = new Float32Array(count * 4);
    const kind = new Float32Array(count);
    const keys = keyRects();
    const holes = grilleHoles();
    const lidW = (x: number, y: number, z: number) => lidPointWorld(x, y, z);
    const sph = () => {
      const u = R() * 2 - 1, a = R() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      return [Math.cos(a) * s, u, Math.sin(a) * s];
    };
    for (let i = 0; i < count; i++) {
      // --- logo target (55% front key, 30% ghost, 15% dot)
      const roll = R();
      let lx: number, ly: number, k = 0;
      if (roll < 0.15) {
        k = 2;
        const a = R() * Math.PI * 2, rr = Math.sqrt(R()) * 7.4;
        lx = 60 + Math.cos(a) * rr; ly = 68 + Math.sin(a) * rr;
      } else {
        k = roll < 0.7 ? 0 : 1;
        const [bx, by] = k === 0 ? [28, 36] : [36, 28];
        const [px, py] = onRoundedRect(bx, by, 64, 64, 16, R());
        lx = px + (R() - 0.5) * 5.6; ly = py + (R() - 0.5) * 5.6;
      }
      const lw = logoToWorld(lx, ly);
      logo.set([lw[0], lw[1], lw[2] + (R() - 0.5) * 0.25], i * 3);
      kind[i] = k;

      // --- laptop target, weighted toward edges, keys, grilles, palm rests
      const q = R();
      let p: [number, number, number];
      const hw = BODY.w / 2, hd = BODY.d / 2;
      if (q < 0.14) {
        const [x, z] = onRoundedRect(-hw, -hd, BODY.w, BODY.d, 0.6, R());
        p = [x, R() < 0.6 ? 0 : -BODY.h * R(), z];
      } else if (q < 0.34) {
        const kr = keys[Math.floor(R() * keys.length)];
        const [x, z] = onRoundedRect(kr.x - kr.w / 2, kr.z - kr.d / 2, kr.w, kr.d, 0.12, R());
        p = [x, 0.2, z];
      } else if (q < 0.42) {
        const [x, z] = onRoundedRect(-PAD.w / 2, PAD.z - PAD.d / 2, PAD.w, PAD.d, 0.5, R());
        p = [x, 0.05, z];
      } else if (q < 0.5) {
        const h = holes[Math.floor(R() * holes.length)];
        p = [h[0] + (R() - 0.5) * 0.08, 0.02, h[1] + (R() - 0.5) * 0.08];
      } else if (q < 0.64) {
        // palm rest and deck surface, denser on palm rests
        const side = R() < 0.5 ? -1 : 1;
        p = R() < 0.6 ? [side * (7.2 + R() * 7.4), 0, 1.6 + R() * 8.6] : [(R() - 0.5) * 29, 0, (R() - 0.5) * 20];
      } else if (q < 0.8) {
        const [x, z] = onRoundedRect(-15.2, 0, 30.4, 21, 0.5, R());
        p = lidW(x, R() < 0.5 ? 0 : 0.42, z);
      } else if (q < 0.9) {
        const [x, z] = onRoundedRect(-14.4, 0.9, 28.8, 19.4, 0.3, R());
        p = lidW(x, -0.02, z);
      } else {
        p = lidW((R() - 0.5) * 29.5, -0.02, 0.5 + R() * 20);
      }
      lap.set(p, i * 3);
      dir.set(sph(), i * 3);
      rnd.set([R(), R(), R(), R()], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(logo, 3));
    g.setAttribute("aLap", new THREE.BufferAttribute(lap, 3));
    g.setAttribute("aDir", new THREE.BufferAttribute(dir, 3));
    g.setAttribute("aRnd", new THREE.BufferAttribute(rnd, 4));
    g.setAttribute("aKind", new THREE.BufferAttribute(kind, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 5, 0), 200);

    const m = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uT: { value: 0 }, uBurst: { value: 0 }, uLogo: { value: 0 }, uFlash: { value: 0 },
        uShatter: { value: 0 }, uLap: { value: 0 }, uAlpha: { value: 1 },
        uDot: { value: new THREE.Vector3() }, uPx: { value: 1 },
        uInk: { value: new THREE.Color("#EDEDEF") }, uSignal: { value: new THREE.Color("#FF5B1F") },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aLap; attribute vec3 aDir; attribute vec4 aRnd; attribute float aKind;
        uniform float uT, uBurst, uLogo, uFlash, uShatter, uLap, uAlpha, uPx; uniform vec3 uDot;
        uniform vec3 uInk, uSignal;
        varying vec3 vCol; varying float vA;
        ${NOISE}
        float eio(float x){ return x<0.5 ? 4.0*x*x*x : 1.0-pow(-2.0*x+2.0,3.0)/2.0; }
        void main(){
          vec3 logo = position;
          float rad = 1.5 + pow(aRnd.x, 1.6) * 16.0;
          vec3 cloud = uDot + normalize(aDir * vec3(1.0, 1.0, 0.25)) * rad * uBurst * vec3(1.6, 1.0, 1.0);
          cloud += curl(cloud * 0.06 + vec3(0.0, uT * 0.2, 0.0)) * 1.8 * uBurst;
          // swirl around the logo's axis
          float ang = uT * (2.4 / (0.6 + rad * 0.12)) * (1.0 - clamp(uLogo, 0.0, 1.0));
          vec2 c2 = cloud.xy - uDot.xy;
          cloud.xy = uDot.xy + mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * c2;
          float delay = aKind > 1.5 ? 0.35 + aRnd.z * 0.3 : aRnd.z * 0.35;
          float q = eio(clamp((uLogo - delay) / 0.45, 0.0, 1.0));
          vec3 p = mix(cloud, logo, q);
          // shatter out of the logo
          float sh = uShatter;
          vec3 cloud2 = logo + aDir * (2.0 + aRnd.w * 22.0) * sh * vec3(1.5, 1.0, 1.3);
          cloud2 += curl(logo * 0.09 + vec3(uT * 0.2)) * 3.5 * sh;
          p = mix(p, cloud2, step(0.0001, sh));
          float q2 = eio(clamp((uLap - aRnd.y * 0.4) / 0.6, 0.0, 1.0));
          p = mix(p, aLap, q2);

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float sz = (0.9 + aRnd.w * 1.2) * (1.0 + uFlash * 0.6);
          gl_PointSize = sz * uPx / max(0.1, -mv.z);
          float isDot = step(1.5, aKind) * (1.0 - step(0.0001, sh));
          vCol = mix(uInk, uSignal * 1.6, isDot * q) * (1.0 + uFlash * 1.1);
          float ghost = aKind > 0.5 && aKind < 1.5 ? mix(1.0, 0.4, q * (1.0 - sh)) : 1.0;
          vA = uAlpha * ghost * (0.3 + 0.7 * max(uBurst, q2)) * 0.42;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vCol; varying float vA;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.1, d) * vA;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vCol, a);
        }`,
    });
    return { geometry: g, material: m };
  }, [count]);

  useLayoutEffect(() => {
    const u = material.uniforms;
    u.uT.value = st.t;
    u.uBurst.value = st.burst;
    u.uLogo.value = st.logo;
    u.uFlash.value = st.flash;
    u.uShatter.value = st.shatter;
    u.uLap.value = st.lap;
    u.uAlpha.value = st.alpha;
    u.uDot.value.set(...st.dot);
    u.uPx.value = st.pixelScale;
  });

  return <points geometry={geometry} material={material} frustumCulled={false} />;
};
