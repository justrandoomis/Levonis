/**
 * WHAT LEVONIS CAN DO WITH EACH 3D FORMAT (row `14.format-honesty`) — the
 * vocabulary worker/lib/modelGeometry.ts measures by, and the table the
 * browser renders a refused or reference-only format from, in ar/en/ckb
 * (src/components/community/requests/fileRefusals.ts). No imports, no
 * strings a reader sees: the words live with the screens.
 */

export type ModelFormat = 'stl' | '3mf' | 'obj' | 'amf' | 'glb' | 'gltf' | 'step' | 'unknown';

/**
 * What Levonis can do with a format, stated per capability rather than as one
 * "supported" flag — because "we can show it" and "a merchant can print it" and
 * "we can measure it for a price" are three different promises, and a customer
 * who uploads a STEP file deserves to be told which of the three they get.
 */
export interface FormatCapability {
  /** The viewer can render it (we can produce a mesh from it). */
  previewable: boolean;
  /** Real dimensions and volume can be extracted, so the price is computed. */
  measurable: boolean;
  /** A merchant's slicer opens it directly, with no conversion step. */
  sliceable: boolean;
  /** We could convert it to something sliceable if we had to. */
  convertible: boolean;
  /** We can store it and show it in the request; nothing more is promised. */
  reference_only: boolean;
}

export const FORMAT_CAPABILITIES: Record<ModelFormat, FormatCapability> = {
  // The two the owner asked to support "بشكل ممتاز", and the two that carry the
  // most reliable geometry.
  stl: { previewable: true, measurable: true, sliceable: true, convertible: true, reference_only: false },
  '3mf': { previewable: true, measurable: true, sliceable: true, convertible: true, reference_only: false },
  obj: { previewable: true, measurable: true, sliceable: true, convertible: true, reference_only: false },
  amf: { previewable: true, measurable: true, sliceable: true, convertible: true, reference_only: false },
  // glTF is a rendering format. Slicers do not open it, but its accessors carry
  // an exact bounding box and its buffers carry real triangles, so it measures
  // and previews honestly and is offered as convertible rather than sliceable.
  glb: { previewable: true, measurable: true, sliceable: false, convertible: true, reference_only: false },
  gltf: { previewable: true, measurable: true, sliceable: false, convertible: true, reference_only: false },
  // STEP is boundary-representation CAD: real surfaces, no triangles. Measuring
  // it needs a geometry kernel we do not have and will not pretend to have. It
  // is accepted, stored and shown to the merchant, who can open it in their own
  // CAD — which is exactly what `reference_only` promises and no more.
  step: { previewable: false, measurable: false, sliceable: false, convertible: false, reference_only: true },
  unknown: { previewable: false, measurable: false, sliceable: false, convertible: false, reference_only: true },
};

