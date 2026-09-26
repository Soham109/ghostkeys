import * as THREE from "three";
import { KB, BODY } from "./laptopGeo";

export const MAX_RIPPLES = 8;

export type DeckUniforms = {
  uRip: { value: THREE.Vector4[] };
  uSignal: { value: THREE.Color };
  uZones: { value: THREE.Vector4[] };
  uZoneGlow: { value: number[] };
  uZoneHot: { value: number[] };
  uHeat: { value: THREE.Texture | null };
  uHeatAmt: { value: number };
  uXray: { value: number };
};

const RIPPLE_GLSL = /* glsl */ `
uniform vec4 uRip[${MAX_RIPPLES}];
float rippleField(vec2 p, out vec2 grad, out float ring) {
  float h = 0.0; grad = vec2(0.0); ring = 0.0;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 r = uRip[i];
    float age = r.z;
    if (age < 0.0 || age > 2.6 || r.w <= 0.0) continue;
    vec2 d = p - r.xy;
    float dist = length(d) + 1e-4;
    vec2 dir = d / dist;
    float front = age * 24.0;
    float x = dist - front;
    float sig = 0.45 + age * 0.9;
    float env = exp(-age * 2.0) * r.w * exp(-x * x / (2.0 * sig * sig));
    float k = 5.0;
    float s = sin(x * k), c = cos(x * k);
    h += s * env;
    grad += dir * (c * k - s * x / (sig * sig)) * env;
    ring += exp(-x * x / 0.05) * exp(-age * 3.0) * r.w;
    ring += exp(-dist * dist / 0.18) * exp(-age * 7.0) * r.w * 2.5;
  }
  return h;
}
`;

/** Aluminum deck with tap ripples (normal perturbation + tiny displacement), zone glow, heat map, keyboard well. */
export const makeDeckMaterial = () => {
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color("#A7A9AC"),
    metalness: 1,
    roughness: 0.36,
    envMapIntensity: 1,
  });
  const uniforms: DeckUniforms = {
    uRip: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, -1, 0)) },
    uSignal: { value: new THREE.Color("#FF5B1F") },
    uZones: { value: Array.from({ length: 7 }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uZoneGlow: { value: new Array(7).fill(0) },
    uZoneHot: { value: new Array(7).fill(0) },
    uHeat: { value: null },
    uHeatAmt: { value: 0 },
    uXray: { value: 0 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec2 vDeck;
         ${RIPPLE_GLSL}`
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vDeck = vec2(transformed.x, -transformed.y);
         vec2 g0; float r0;
         transformed.z += clamp(rippleField(vDeck, g0, r0), -0.3, 1.0) * 0.012;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         varying vec2 vDeck;
         uniform vec3 uSignal;
         uniform vec4 uZones[7];
         uniform float uZoneGlow[7];
         uniform float uZoneHot[7];
         uniform sampler2D uHeat;
         uniform float uHeatAmt;
         uniform float uXray;
         float rrect(vec2 p, vec2 c, vec2 hs, float r) {
           vec2 q = abs(p - c) - hs + r;
           return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
         }
         ${RIPPLE_GLSL}`
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
         float well = 1.0 - smoothstep(-0.02, 0.02, rrect(vDeck, vec2(${((KB.x0 + KB.x1) / 2).toFixed(3)}, ${((KB.z0 + KB.z1) / 2).toFixed(3)}), vec2(${((KB.x1 - KB.x0) / 2 + 0.25).toFixed(3)}, ${((KB.z1 - KB.z0) / 2 + 0.25).toFixed(3)}), 0.5));
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.018, 0.018, 0.02), well);`
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
         roughnessFactor = mix(roughnessFactor, 0.62, well);`
      )
      .replace(
        "#include <metalnessmap_fragment>",
        `#include <metalnessmap_fragment>
         metalnessFactor = mix(metalnessFactor, 0.0, well);`
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
         vec2 rg; float rring;
         rippleField(vDeck, rg, rring);
         vec3 nW = normalize(vec3(-rg.x * 0.22, 1.0, -rg.y * 0.22));
         normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);`
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
         totalEmissiveRadiance += uSignal * rring * 3.0 * (1.0 - well);
         for (int i = 0; i < 7; i++) {
           float dz = rrect(vDeck, uZones[i].xy, uZones[i].zw, 0.35);
           float inside = 1.0 - smoothstep(0.0, 0.06, dz);
           float edge = 1.0 - smoothstep(0.0, 0.07, abs(dz));
           totalEmissiveRadiance += vec3(0.93) * (inside * 0.05 + edge * 0.5) * uZoneGlow[i];
           totalEmissiveRadiance += uSignal * (inside * 0.22 + edge * 1.6) * uZoneHot[i];
         }
         vec2 huv = vec2(vDeck.x / ${BODY.w.toFixed(2)} + 0.5, 0.5 - vDeck.y / ${BODY.d.toFixed(2)});
         vec4 heat = texture2D(uHeat, huv);
         totalEmissiveRadiance += heat.rgb * heat.a * uHeatAmt * 2.2;`
      );
  };
  return { mat, uniforms };
};
