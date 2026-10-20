/**
 * THE V1 REQUEST CORPUS (P1-04, docs/DECISIONS.md row 266) — one anonymised
 * fixture per class of request the live database holds, as `factsFromRows`
 * reads it: the request row, the print row (or none: a chat or direct
 * request) and the attachment list in `created_at, id` order.
 *
 * Every name, note and link here is invented. The classes are what matter:
 * a model request, a link request, an images request, a description-only
 * request, «لست متأكدًا» on both axes, three colours with none chosen, a
 * colour word whose hex is not the palette's, rows from before 0130 (no
 * `source_type`, a `source_url` on an upload), an images request that also
 * names a model, the 16-colour ceiling, a resin row kept while unsure, and a
 * chat request with free Arabic text and no print row at all.
 *
 * `tests/requestModelHash.test.ts` pins the v1 canonical string of each one,
 * captured before migration 0208's code existed: the strings below must never
 * move, because a pending offer was priced against them.
 */
import type { RevisionFile } from '../../worker/lib/requestRevisions';

export interface V1Fixture {
  name: string;
  r: Record<string, unknown>;
  p: Record<string, unknown> | null;
  files: RevisionFile[];
}

const req = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  customer_id: 'cust_1',
  title: 'A bracket for a shelf',
  description: 'Please print this bracket for my shelf',
  quantity: 1,
  material: '',
  color: '',
  dimensions: '',
  governorate: 'baghdad',
  delivery_pref: '',
  deadline: null,
  customer_notes: '',
  budget_iqd: null,
  state: 'open',
  visibility: 'public',
  revision: 1,
  ...extra,
});

const print = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  request_id: id,
  process: 'fdm',
  material_id: 'pla',
  color_hex: '',
  color_name: '',
  quality: 'standard',
  infill_percent: 20,
  supports: 1,
  colors_count: 1,
  post_processing_minutes: 0,
  primary_file_id: null,
  source_kind: 'upload',
  source_provider: '',
  source_url: '',
  source_meta: '{}',
  analysis: '{}',
  estimate: '{}',
  source_type: '',
  process_unsure: 0,
  material_unsure: 0,
  stated_dims: '',
  ...extra,
});

const file = (id: string, kind: 'model' | 'reference' | 'document', name: string): RevisionFile => ({
  id,
  kind,
  content_type: kind === 'model' ? 'model/stl' : kind === 'reference' ? 'image/png' : 'application/pdf',
  size_bytes: 1024,
  file_name: name,
});

export const V1_CORPUS: readonly V1Fixture[] = [
  {
    name: 'model request, PLA, a palette red',
    r: req('req_model', { quantity: 2, governorate: 'erbil', customer_notes: '  keep the holes clean  ' }),
    p: print('req_model', { source_type: 'model', primary_file_id: 'crf_m1', color_hex: '#d32f2f', color_name: 'Red' }),
    files: [file('crf_m1', 'model', 'bracket.stl'), file('crf_i1', 'reference', 'shelf.png')],
  },
  {
    name: 'link request, process and material unsure',
    r: req('req_link', { deadline: '2026-12-01', delivery_pref: 'pickup' }),
    p: print('req_link', {
      source_type: 'link', source_kind: 'link', source_provider: 'printables',
      source_url: 'https://www.printables.com/model/12345-shelf-bracket', process_unsure: 1, material_unsure: 1, material_id: '',
    }),
    files: [],
  },
  {
    name: 'images request, three colours, none chosen',
    r: req('req_images', { quantity: 5 }),
    p: print('req_images', { source_type: 'images', colors_count: 3, material_id: 'petg' }),
    files: [file('crf_i2', 'reference', 'front.png'), file('crf_i3', 'reference', 'side.png')],
  },
  {
    name: 'description only, a colour word the palette does not have',
    r: req('req_desc'),
    p: print('req_desc', { source_type: 'description', color_name: 'Navy', material_id: 'abs' }),
    files: [],
  },
  {
    name: 'resin with a custom hex and stated dimensions',
    r: req('req_resin', { quantity: 1 }),
    p: print('req_resin', {
      source_type: 'description', process: 'resin', material_id: 'resin-standard', color_hex: '#abcdef',
      stated_dims: JSON.stringify({ x: 40, y: 25.5, z: 12 }), quality: 'fine', infill_percent: 100, supports: 0, post_processing_minutes: 30,
    }),
    files: [],
  },
  {
    name: 'before 0130: no source_type, a source_url on an upload, a model file',
    r: req('req_pre130'),
    p: print('req_pre130', { source_type: '', source_kind: 'upload', source_url: 'https://www.thingiverse.com/thing:999', primary_file_id: 'crf_m2' }),
    files: [file('crf_m2', 'model', 'old.stl')],
  },
  {
    name: 'before 0130: no source_type, a link source',
    r: req('req_pre130_link'),
    p: print('req_pre130_link', {
      source_type: '', source_kind: 'link', source_provider: 'thingiverse', source_url: 'https://www.thingiverse.com/thing:1001',
    }),
    files: [],
  },
  {
    name: 'a palette word with a hex that is not the palette red',
    r: req('req_red_word'),
    p: print('req_red_word', { source_type: 'description', color_hex: '#ee1111', color_name: 'Red' }),
    files: [],
  },
  {
    name: 'an images request that also names a model as primary',
    r: req('req_images_model'),
    p: print('req_images_model', { source_type: 'images', primary_file_id: 'crf_m3', colors_count: 2, color_hex: '#1976d2', color_name: 'Blue' }),
    files: [file('crf_i4', 'reference', 'look.png'), file('crf_m3', 'model', 'part.3mf')],
  },
  {
    name: 'sixteen colours, the readSpec ceiling',
    r: req('req_sixteen'),
    p: print('req_sixteen', { source_type: 'description', colors_count: 16 }),
    files: [],
  },
  {
    name: 'resin kept while the process is unsure',
    r: req('req_resin_unsure'),
    p: print('req_resin_unsure', { source_type: 'description', process: 'resin', process_unsure: 1, material_id: '', material_unsure: 1 }),
    files: [file('crf_d1', 'document', 'drawing.pdf')],
  },
  {
    name: 'no source_type and only pictures: derived as images',
    r: req('req_derived_images'),
    p: print('req_derived_images', { source_type: '' }),
    files: [file('crf_i5', 'reference', 'a.png')],
  },
  {
    name: 'chat request, no print row, free Arabic text',
    r: req('req_chat', { material: 'بلاستيك قوي', color: 'أحمر غامق', dimensions: 'حوالي ١٠ سم', visibility: 'direct' }),
    p: null,
    files: [file('crf_c1', 'reference', 'photo.jpg')],
  },
];
