/**
 * The model viewer's shaders, moved out of src/pages/ModelViewer.tsx (the one
 * viewer core). GLSL ES 1.00, WebGL1-safe. Every GLSL line is the page's own,
 * in its order; the comments that used to sit INSIDE the strings are here, as
 * JS comments, because the GPU never reads them and every visitor downloaded
 * them (≈ 440 B gzip — the room the viewer core needed to stay inside the pair
 * budget «ModelViewer + viewer-core ≤ 7.7 KB»). tests/viewerCore.test.ts pins
 * the strings against the page's originals with only the comments removed.
 *
 * The studio's region, finish and decal variants are in ./studioShaders — a
 * separate module on purpose, so the chunk the model viewer loads carries none
 * of them.
 */

/**
 * `vBary`: barycentric weights unpacked from the corner index — three floats
 * the vertex stage makes up, so the wireframe costs one byte per vertex on the
 * bus instead of twelve.
 */
export const MODEL_VERT = `
attribute vec3 position;
attribute vec3 normal;
attribute float corner;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
varying vec3 vNormal;
varying vec3 vBary;
void main() {
  vNormal = normalMatrix * normal;
  vBary = vec3(float(corner < 0.5), float(corner > 0.5 && corner < 1.5), float(corner > 1.5));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * - Uploaded meshes have unreliable winding — a customer's export may hand us
 *   inside-out triangles — so instead of culling, the normal is flipped toward
 *   whichever side is being looked at. Nothing ever renders black.
 * - View space: the key light rides just over the viewer's shoulder, so the
 *   form reads the same however the part is turned.
 * - The wireframe uses a fixed threshold rather than fwidth(): derivatives need
 *   an extension on WebGL1, and this is a toggle, not the primary read of the
 *   model.
 */
export const MODEL_FRAG = `
precision highp float;
uniform vec3 uBase;
uniform vec3 uAccent;
uniform float uWire;
varying vec3 vNormal;
varying vec3 vBary;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;

  float key = dot(n, normalize(vec3(0.42, 0.72, 0.55))) * 0.5 + 0.5;
  float fill = max(dot(n, normalize(vec3(-0.7, -0.25, 0.35))), 0.0);
  float rim = pow(1.0 - clamp(abs(n.z), 0.0, 1.0), 3.0);
  vec3 col = uBase * (0.17 + 0.85 * key * key + 0.16 * fill) + uAccent * rim * 0.5;

  if (uWire > 0.5) {
    float edge = min(min(vBary.x, vBary.y), vBary.z);
    float line = 1.0 - smoothstep(0.0, 0.04, edge);
    col = mix(col * 0.3, uAccent, line * 0.85);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export const GRID_VERT = `
attribute vec3 position;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uHalf;
varying float vFade;
void main() {
  vFade = 1.0 - clamp(length(position.xz) / uHalf, 0.0, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Squared falloff so the grid dissolves instead of ending on a hard square. */
export const GRID_FRAG = `
precision mediump float;
uniform vec3 uColor;
varying float vFade;
void main() {
  gl_FragColor = vec4(uColor, vFade * vFade * 0.5);
}
`;
