/** Shared GLSL chunks. */

export const MAX_RIPPLES = 8;

/**
 * Analytic tap rings. uRip[i] = (x, z, startTime, strength) in base-local coordinates.
 * rippleBand returns the ring intensity at p; rippleFlash the bright core at impact.
 */
export const RIPPLE_GLSL = /* glsl */ `
uniform vec4 uRip[${MAX_RIPPLES}];
uniform float uTime;

float rippleBand(vec2 p, float width, float speed) {
  float acc = 0.0;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 r = uRip[i];
    float age = uTime - r.z;
    if (age < 0.0 || age > 2.4 || r.w <= 0.0) continue;
    float rad = age * speed;
    float d = distance(p, r.xy);
    float fade = 1.0 - age / 2.4;
    fade *= fade;
    acc += exp(-pow((d - rad) / width, 2.0)) * fade * r.w;
  }
  return acc;
}

// The touch ring: one thin ring that opens around the point of contact and dies within a few centimetres, so the
// orange stays where the finger landed instead of sweeping across the deck.
float touchRing(vec2 p, float width) {
  float acc = 0.0;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 r = uRip[i];
    float age = uTime - r.z;
    if (age < 0.0 || age > 0.95 || r.w <= 0.0) continue;
    float k = age / 0.95;
    float rad = 0.03 + (1.0 - pow(1.0 - k, 3.0)) * 0.3 * (0.7 + 0.3 * r.w);
    float d = distance(p, r.xy);
    float fade = (1.0 - k) * (1.0 - k);
    acc += exp(-pow((d - rad) / width, 2.0)) * fade * min(r.w, 1.2);
  }
  return acc;
}

float rippleFlash(vec2 p) {
  float acc = 0.0;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 r = uRip[i];
    float age = uTime - r.z;
    if (age < 0.0 || age > 0.6 || r.w <= 0.0) continue;
    float d = distance(p, r.xy);
    acc += exp(-d * d / 0.0035) * exp(-age * 7.0) * r.w;
  }
  return acc;
}
`;

/** Hash and value noise, FBM, and curl noise (for particles). */
export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return v;
}
`;

export const CURL_GLSL = /* glsl */ `
vec4 permute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0 / 7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
vec3 snoiseVec3(vec3 x) {
  return vec3(snoise(x), snoise(vec3(x.y - 19.1, x.z + 33.4, x.x + 47.2)), snoise(vec3(x.z + 74.2, x.x - 124.5, x.y + 99.4)));
}
vec3 curlNoise(vec3 p) {
  const float e = 0.1;
  vec3 dx = vec3(e, 0.0, 0.0);
  vec3 dy = vec3(0.0, e, 0.0);
  vec3 dz = vec3(0.0, 0.0, e);
  vec3 px0 = snoiseVec3(p - dx); vec3 px1 = snoiseVec3(p + dx);
  vec3 py0 = snoiseVec3(p - dy); vec3 py1 = snoiseVec3(p + dy);
  vec3 pz0 = snoiseVec3(p - dz); vec3 pz1 = snoiseVec3(p + dz);
  float x = py1.z - py0.z - pz1.y + pz0.y;
  float y = pz1.x - pz0.x - px1.z + px0.z;
  float z = px1.y - px0.y - py1.x + py0.x;
  return normalize(vec3(x, y, z) / (2.0 * e));
}
`;
