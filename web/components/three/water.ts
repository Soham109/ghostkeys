import * as THREE from "three";
import { GPUComputationRenderer, type Variable } from "three/examples/jsm/misc/GPUComputationRenderer.js";

const MAX_IMPULSES = 6;

/**
 * Height field over the deck, simulated like three.js webgl_gpgpu_water.
 * Coordinates are deck UV: u = (x + W/2) / W, v = (z + D/2) / D.
 * Pointer moves and taps push impulses in; materials sample the texture to bend normals and lift keys.
 */
const heightShader = /* glsl */ `
uniform vec4 uImp[${MAX_IMPULSES}];
uniform float uDamping;
uniform vec2 uAspect;

void main() {
  vec2 cell = 1.0 / resolution.xy;
  vec2 uv = gl_FragCoord.xy * cell;
  vec4 h = texture2D(heightmap, uv);
  vec4 n = texture2D(heightmap, uv + vec2(0.0, cell.y));
  vec4 s = texture2D(heightmap, uv - vec2(0.0, cell.y));
  vec4 e = texture2D(heightmap, uv + vec2(cell.x, 0.0));
  vec4 w = texture2D(heightmap, uv - vec2(cell.x, 0.0));
  float avg = (n.x + s.x + e.x + w.x) * 0.25;
  float next = ((n.x + s.x + e.x + w.x) * 0.5 - h.y) * uDamping;
  // a little viscosity: the finest (one-cell) waves flip sign every step and read as flicker on the metal and keys
  next = mix(next, avg, 0.18);
  for (int i = 0; i < ${MAX_IMPULSES}; i++) {
    vec4 imp = uImp[i];
    if (imp.w == 0.0) continue;
    float d = length((uv - imp.xy) * uAspect);
    float phase = clamp(d * 3.14159 / imp.z, 0.0, 3.14159);
    next += (cos(phase) + 1.0) * imp.w;
  }
  // edges absorb so waves do not bounce forever off the chassis rim
  float edge = smoothstep(0.0, 0.03, uv.x) * smoothstep(0.0, 0.03, 1.0 - uv.x) * smoothstep(0.0, 0.03, uv.y) * smoothstep(0.0, 0.03, 1.0 - uv.y);
  next *= mix(0.9, 1.0, edge);
  gl_FragColor = vec4(next, h.x, 0.0, 1.0);
}
`;

export class WaterSim {
  gpu: GPUComputationRenderer;
  variable: Variable;
  private imps: THREE.Vector4[];
  private queue: THREE.Vector4[] = [];
  readonly sizeX: number;
  readonly sizeY: number;
  readonly texel: THREE.Vector2;
  ok = true;

  constructor(renderer: THREE.WebGLRenderer, sizeX: number, aspect: number) {
    this.sizeX = sizeX;
    this.sizeY = Math.round(sizeX / aspect);
    this.texel = new THREE.Vector2(1 / this.sizeX, 1 / this.sizeY);
    this.gpu = new GPUComputationRenderer(this.sizeX, this.sizeY, renderer);
    const h0 = this.gpu.createTexture();
    this.variable = this.gpu.addVariable("heightmap", heightShader, h0);
    this.gpu.setVariableDependencies(this.variable, [this.variable]);
    this.imps = Array.from({ length: MAX_IMPULSES }, () => new THREE.Vector4());
    const u = this.variable.material.uniforms;
    u.uImp = { value: this.imps };
    u.uDamping = { value: 0.985 };
    u.uAspect = { value: new THREE.Vector2(aspect, 1) };
    const err = this.gpu.init();
    if (err) {
      console.warn("[ghostkeys] water sim disabled:", err);
      this.ok = false;
    }
  }

  /** radius and strength in UV units; strength is added per frame for one frame */
  impulse(u: number, v: number, radius = 0.03, strength = 0.02) {
    if (this.queue.length >= MAX_IMPULSES) this.queue.shift();
    this.queue.push(new THREE.Vector4(u, v, radius, strength));
  }

  step(substeps = 1) {
    if (!this.ok) return;
    for (let s = 0; s < substeps; s++) {
      for (let i = 0; i < MAX_IMPULSES; i++) {
        const q = s === 0 ? this.queue[i] : undefined;
        if (q) this.imps[i].copy(q);
        else this.imps[i].set(0, 0, 0, 0);
      }
      this.gpu.compute();
    }
    this.queue.length = 0;
  }

  get texture(): THREE.Texture {
    return this.gpu.getCurrentRenderTarget(this.variable).texture;
  }

  dispose() {
    this.gpu.dispose();
  }
}

/** Fallback 1x1 flat height texture for when the sim is off. */
export const FLAT_HEIGHT = (() => {
  const t = new THREE.DataTexture(new Float32Array([0, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  t.needsUpdate = true;
  return t;
})();
