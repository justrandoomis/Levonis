/**
 * THE STUDIO'S SHADERS — the region, finish and decal variants of the viewer
 * core (docs/LEVO_PROJECT_PROGRAMME.md §B.2 items 3–4). A module apart from
 * ./shaders on purpose: the model viewer page never loads these bytes.
 *
 * GLSL ES 1.00, WebGL1-safe, and these limits are pinned by
 * tests/viewerCore.test.ts:
 *   - regions: a per-vertex Uint8 `region` → `uniform vec3 uRegion[16]`,
 *     indexed ONLY in the vertex shader (GLSL ES 1.00 guarantees dynamic
 *     uniform indexing there and nowhere else) — a recolour is one uniform
 *     write and one draw;
 *   - finishes: `uFinish[16]` = (sheen, emissive, roughness) per region, also
 *     read in the vertex shader and carried in the .w of three varyings;
 *   - decals (`#define DECALS`, compiled in only once an atlas exists):
 *     ≤ 4 areas in one 1024² atlas; the projective coordinates, the region
 *     mask and the facing test are computed per area in the VERTEX shader; the
 *     fragment shader only samples, with constant indices;
 *   - 6 varyings of WebGL1's 8, 5 fragment uniform vectors of its 16;
 *   - uMode: 0 = the look, 1 = the neutral grey render of the look card,
 *     2 = the flat region-id pass (red = region + 1, read with readPixels);
 *     declared mediump in BOTH stages — a uniform the two stages share must
 *     agree on precision or the program does not link.
 *
 * No colour literal beyond the neutral grey: every colour is a uniform.
 */

export const STUDIO_VERT = `
attribute vec3 position;
attribute vec3 normal;
attribute float region;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
uniform vec3 uRegion[16];
uniform vec3 uFinish[16];
uniform mediump float uMode;
varying vec4 vNormal;
varying vec4 vView;
varying vec4 vColor;
#ifdef DECALS
uniform vec3 uAO[4];
uniform vec3 uAN[4];
uniform vec3 uAU[4];
uniform vec4 uAS[4];
varying vec4 vST01;
varying vec4 vST23;
varying vec4 vMask;
vec3 decal(int k) {
  vec3 d = position - uAO[k];
  float m = float(abs(region - uAS[k].z) < 0.5) * step(0.2, dot(normal, uAN[k])) * step(abs(dot(d, uAN[k])), uAS[k].w);
  return vec3(dot(d, uAU[k]) * uAS[k].x + 0.5, dot(d, cross(uAN[k], uAU[k])) * uAS[k].y + 0.5, m);
}
#endif
void main() {
  int r = int(min(region, 15.0) + 0.5);
  vec3 f = uMode > 0.5 ? vec3(0.0, 0.0, 0.6) : uFinish[r];
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  vNormal = vec4(normalMatrix * normal, f.x);
  vView = vec4(p.xyz, f.z);
  vColor = uMode > 1.5 ? vec4((region + 1.0) / 255.0, 0.0, 0.0, 0.0) : uMode > 0.5 ? vec4(0.72, 0.72, 0.72, 0.0) : vec4(uRegion[r], f.y);
#ifdef DECALS
  vec3 a0 = decal(0);
  vec3 a1 = decal(1);
  vec3 a2 = decal(2);
  vec3 a3 = decal(3);
  vST01 = vec4(a0.xy, a1.xy);
  vST23 = vec4(a2.xy, a3.xy);
  vMask = uMode > 0.5 ? vec4(0.0) : vec4(a0.z, a1.z, a2.z, a3.z);
#endif
  gl_Position = region > 15.5 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * p;
}
`;

export const STUDIO_FRAG = `
precision mediump float;
uniform float uMode;
varying vec4 vNormal;
varying vec4 vView;
varying vec4 vColor;
#ifdef DECALS
uniform sampler2D uAtlas;
uniform vec4 uRect[4];
varying vec4 vST01;
varying vec4 vST23;
varying vec4 vMask;
vec3 paint(vec3 c, vec2 st, float m, vec4 r) {
  vec4 t = texture2D(uAtlas, r.xy + clamp(st, 0.0, 1.0) * r.zw);
  m *= step(0.0, st.x) * step(st.x, 1.0) * step(0.0, st.y) * step(st.y, 1.0);
  return c * (1.0 - t.a * m) + t.rgb * m;
}
#endif
void main() {
  if (uMode > 1.5) {
    gl_FragColor = vec4(vColor.rgb, 1.0);
    return;
  }
  vec3 base = vColor.rgb;
#ifdef DECALS
  base = paint(base, vST01.xy, vMask.x, uRect[0]);
  base = paint(base, vST01.zw, vMask.y, uRect[1]);
  base = paint(base, vST23.xy, vMask.z, uRect[2]);
  base = paint(base, vST23.zw, vMask.w, uRect[3]);
#endif
  vec3 n = normalize(vNormal.xyz);
  if (!gl_FrontFacing) n = -n;
  vec3 l = normalize(vec3(0.42, 0.72, 0.55));
  vec3 v = normalize(-vView.xyz);
  float key = dot(n, l) * 0.5 + 0.5;
  float fill = max(dot(n, normalize(vec3(-0.7, -0.25, 0.35))), 0.0);
  float rim = pow(1.0 - clamp(abs(n.z), 0.0, 1.0), 3.0);
  float spec = pow(max(dot(n, normalize(l + v)), 0.0), mix(90.0, 8.0, vView.w)) * (1.0 - vView.w);
  float sheen = vNormal.w * pow(1.0 - max(dot(n, v), 0.0), 2.0);
  vec3 col = base * (0.17 + 0.85 * key * key + 0.16 * fill + 0.3 * rim + sheen) + spec * 0.5;
  gl_FragColor = vec4(mix(col, base, vColor.a), 1.0);
}
`;

/** Simplified slot markers (a glow, a ring, a badge): colour and alpha per vertex, premultiplied out. */
export const MARKER_VERT = `
attribute vec3 position;
attribute vec4 color;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
varying vec4 vC;
void main() {
  vC = color;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const MARKER_FRAG = `
precision mediump float;
varying vec4 vC;
void main() {
  gl_FragColor = vec4(vC.rgb * vC.a, vC.a);
}
`;
