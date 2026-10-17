import { writeFileSync } from 'node:fs';
const OUT = process.argv[2];
const STORE = 'https://us.store.bambulab.com/products/bambu-hotend-a1-a2';
const STORE_T = 'Bambu Hotend - A1/A2 (Bambu Lab US store product page)';
const STORE_AT = '2026-10-16T06:53:40Z';
const NOZ = 'https://wiki.bambulab.com/en/filament-acc/acc/nozzles';
const NOZ_T = 'Introduction to Bambu Nozzles | Bambu Lab Wiki';
const NOZ_AT = '2026-10-16T08:22:49Z';
const FG = 'https://wiki.bambulab.com/en/general/filament-guide-material-table';
const FG_T = 'Filament guide - Printer, Nozzle, AMS, Build Plate, Glue Compatibility and Required Parameters | Bambu Lab Wiki';
const FG_AT = '2026-10-16T08:18:29Z';
const TOOLHEAD = 'https://wiki.bambulab.com/en/a1-mini/maintenance/toolhead';

// Option values exactly as the package's option model names them (payload groups; scopeOf matches source_value_id or id).
const V = {
  s02: { kind: 'option_value', group: 'Size', source_value_id: '564681835144835082', id: 'ov_8b4064f4ef4ee5535936ce45', value_text: '0.2mm Stainless Steel' },
  h04: { kind: 'option_value', group: 'Size', source_value_id: '564681835144835079', id: 'ov_86bd75275a007b69b0b4d2b2', value_text: '0.4mm Hardened Steel' },
  h06: { kind: 'option_value', group: 'Size', source_value_id: '564681835144835080', id: 'ov_0b465fc1ba5d51b495904c95', value_text: '0.6mm Hardened Steel' },
  h08: { kind: 'option_value', group: 'Size', source_value_id: '564681835144835081', id: 'ov_4772a0db32b0f9206a55b2b5', value_text: '0.8mm Hardened Steel' },
  s04: { kind: 'option_value', group: 'Size', source_value_id: '564681835144835083', id: 'ov_b4e5c1200250c6ce41e928ee', value_text: '0.4mm Stainless Steel' },
  pA2L: { kind: 'option_value', group: 'Printer Model', source_value_id: '737888342695104516', id: 'ov_b64ca3f627e36f9f303d5255', value_text: 'A2L' },
  pA1: { kind: 'option_value', group: 'Printer Model', source_value_id: '737888342695104514', id: 'ov_13695372b372ce837ce8627f', value_text: 'A1' },
  pA1m: { kind: 'option_value', group: 'Printer Model', source_value_id: '737888342695104515', id: 'ov_80b85df0829a8990ac6a1754', value_text: 'A1 mini' },
};
const PRODUCT = { kind: 'product' };

const store = (o) => ({ status: 'verified', confidence: 'official_page', source_kind: 'store_page', source_url: STORE, source_title: STORE_T, test_method: '', test_condition: '', region: '', retrieved_at: STORE_AT, ...o });
const specs = [];

// ---- Product Specifications table (store page, 4-cell rows)
specs.push(store({ key: 'thermal.max_nozzle_temp', scope: PRODUCT, value: 320, unit: '°C', locator: 'Product Specifications › row 1 › pair 1', quote: 'Max. Printing Temp. | 320 ℃' }));
specs.push(store({ key: 'product.length', scope: PRODUCT, value: 47.3, unit: 'mm', locator: 'Product Specifications › row 1 › pair 2', quote: 'Length | 47.3 mm' }));
specs.push(store({ key: 'package.weight', scope: PRODUCT, value: 30, unit: 'g', locator: 'Product Specifications › row 2 › pair 1', quote: 'Packaging Weight | 30 g' }));
specs.push(store({ key: 'package.length', scope: PRODUCT, value: 60, unit: 'mm', locator: 'Product Specifications › row 2 › pair 2 › dimension 1 of 3', quote: 'Packaging Size | 60*60*30 mm' }));
specs.push(store({ key: 'package.width', scope: PRODUCT, value: 60, unit: 'mm', locator: 'Product Specifications › row 2 › pair 2 › dimension 2 of 3', quote: 'Packaging Size | 60*60*30 mm' }));
specs.push(store({ key: 'package.height', scope: PRODUCT, value: 30, unit: 'mm', locator: 'Product Specifications › row 2 › pair 2 › dimension 3 of 3', quote: 'Packaging Size | 60*60*30 mm' }));

// ---- Nozzle diameter and material from the Size option value text (official_variant)
const sizes = [['s02', 0.2, 'Stainless Steel'], ['h04', 0.4, 'Hardened Steel'], ['h06', 0.6, 'Hardened Steel'], ['h08', 0.8, 'Hardened Steel'], ['s04', 0.4, 'Stainless Steel']];
for (const [k, d, m] of sizes) {
  specs.push(store({ key: 'nozzle.diameter', scope: V[k], value: d, unit: 'mm', confidence: 'official_variant', locator: `option Size › ${V[k].value_text}`, quote: V[k].value_text }));
  specs.push(store({ key: 'nozzle.material', scope: V[k], value: m, unit: '', confidence: 'official_variant', locator: `option Size › ${V[k].value_text}`, quote: V[k].value_text }));
}

// ---- Filament Compatibility matrix (store page): one list per Size option value
const ROWS = ['General PLA', 'PLA Sparkle', 'PLA Marble', 'Wood/Rock/Metal-filled PLA', 'PETG', 'PVA', 'ABS', 'ASA', 'PC', 'PA', 'TPU', 'Bambu PLA-CF', 'Bambu PETG-CF', 'Bambu PAHT-CF', 'Bambu PET-CF', 'CF/GF Filaments from other brands'];
const CF = ['Bambu PLA-CF', 'Bambu PETG-CF', 'Bambu PAHT-CF', 'Bambu PET-CF', 'CF/GF Filaments from other brands'];
const NO02 = ['PLA Sparkle', 'PLA Marble', 'Wood/Rock/Metal-filled PLA', 'PA', 'TPU', ...CF];
const ok02 = ROWS.filter((r) => !NO02.includes(r));
const ok04h = ROWS.filter((r) => r !== 'CF/GF Filaments from other brands');
const ok04s = ROWS.filter((r) => !CF.includes(r));
const FC = 'Filament Compatibility table';
specs.push(store({ key: 'printing.supported_filament', scope: V.s02, value: ok02, unit: '', locator: `${FC} › column 0.2 mm Nozzle (YES)`,
  quote: 'Material | 0.2 mm Nozzle … General PLA | YES … PETG | YES … PVA | YES … ABS | YES … ASA | YES … PC | YES',
  conflict: 'Bambu wiki filament guide (generic, all Bambu nozzles) differs at 0.2 mm: «PVA, BVOH (Dry) | Not Compatible» and «PC | Not Recommended». The product page value is kept; adjudicate.' }));
specs.push(store({ key: 'printing.unsupported_filament', scope: V.s02, value: NO02, unit: '', locator: `${FC} › column 0.2 mm Nozzle (*①NO) › note ①`,
  quote: '*① Filaments with carbon fiber, glass fiber, metal, or other inorganic particles are prone to clog a 0.2 mm nozzle.',
  conflict: 'Bambu wiki filament guide differs at 0.2 mm: «PLA Metal | Compatible» (page row «Wood/Rock/Metal-filled PLA | *①NO»); TPU rows there say «Not Recommended» rather than not compatible.' }));
specs.push(store({ key: 'printing.supported_filament', scope: V.h04, value: ok04h, unit: '', locator: `${FC} › column 0.4 mm Nozzle (YES / Recommended)`,
  quote: 'Bambu PLA-CF | *①NO | *②Recommended | YES | YES | Required … CF/GF Filaments from other brands | *①NO | Not Recommended | YES | YES | Required',
  note: '«CF/GF Filaments from other brands» is «Not Recommended» at 0.4 mm and is left out of both lists. Recommended at 0.4 mm hardened steel: Bambu PLA-CF, Bambu PETG-CF (note ②).' }));
specs.push(store({ key: 'printing.supported_filament', scope: V.s04, value: ok04s, unit: '', locator: `${FC} › column 0.4 mm Nozzle × column Hardened Steel Required? (Optional)`,
  quote: 'Material | 0.2 mm Nozzle | 0.4 mm Nozzle | 0.6 mm Nozzle | 0.8 mm Nozzle | Hardened Steel Required? … PLA Sparkle | *①NO | YES | YES | YES | Optional',
  conflict: 'Bambu wiki filament guide text says particle-filled filaments (PLA Marble, PLA Sparkle, PLA Glow) should not use a stainless steel nozzle, while its own table says PLA Marble «Not Required». The product page («Optional») is kept; adjudicate.' }));
specs.push(store({ key: 'printing.unsupported_filament', scope: V.s04, value: CF, unit: '', locator: `${FC} › column Hardened Steel Required? (Required)`,
  quote: 'Bambu PLA-CF | *①NO | *②Recommended | YES | YES | Required … Bambu PET-CF | *①NO | YES | *③Recommended | YES | Required',
  note: 'Stainless steel option: every row whose «Hardened Steel Required?» cell is «Required» is excluded.' }));
specs.push(store({ key: 'printing.supported_filament', scope: V.h06, value: ROWS, unit: '', locator: `${FC} › column 0.6 mm Nozzle (YES / Recommended)`,
  quote: 'Bambu PAHT-CF | *①NO | YES | *③Recommended | YES | Required … CF/GF Filaments from other brands | *①NO | Not Recommended | YES | YES | Required',
  note: 'Recommended at 0.6 mm hardened steel: Bambu PAHT-CF, Bambu PET-CF (note ③).' }));
specs.push(store({ key: 'printing.supported_filament', scope: V.h08, value: ROWS, unit: '', locator: `${FC} › column 0.8 mm Nozzle (YES)`,
  quote: 'Material | … | 0.8 mm Nozzle | Hardened Steel Required? … General PLA | YES | YES | YES | YES | Optional … CF/GF Filaments from other brands | *①NO | Not Recommended | YES | YES | Required' }));

// ---- Layer heights per nozzle diameter (Bambu wiki, Introduction to Bambu Nozzles)
const wiki = (o) => ({ status: 'verified', confidence: 'official_doc', source_kind: 'wiki', source_url: NOZ, source_title: NOZ_T, test_method: '', test_condition: '', region: '', retrieved_at: NOZ_AT, unit: 'mm', ...o });
specs.push(wiki({ key: 'printing.layer_height', scope: V.s02, value: { min: 0.05, max: 0.12 }, locator: 'Size › nozzle table › row 0.2 mm › Layer heights', quote: 'Typically 0.05 mm to 0.12 mm (25-60% of nozzle diameter for optimal results).' }));
for (const k of ['h04', 's04']) specs.push(wiki({ key: 'printing.layer_height', scope: V[k], value: { min: 0.1, max: 0.3 }, locator: 'Size › nozzle table › row 0.4 mm › Layer heights', quote: '0.1 mm to 0.3 mm (25-75% of nozzle diameter), with 0.2 mm being standard.',
  ...(k === 'h04' ? { note: 'The filament guide recommends 0.15–0.3 mm on a 0.4 mm hardened steel nozzle for CF/GF and particle-filled filaments (a narrower, material-specific condition, not stored).' } : {}) }));
specs.push(wiki({ key: 'printing.layer_height', scope: V.h06, value: { min: 0.15, max: 0.45 }, locator: 'Size › nozzle table › row 0.6 mm › Layer heights', quote: '0.15 mm to 0.45 mm (25-75% of nozzle diameter), with 0.3-0.4 mm being common.' }));
specs.push(wiki({ key: 'printing.layer_height', scope: V.h08, value: { min: 0.2, max: 0.6 }, locator: 'Size › nozzle table › row 0.8 mm › Layer heights', quote: '0.2 mm to 0.6 mm (25-75% of nozzle diameter), with 0.4-0.5 mm being typical.' }));

// ---- Relations
const relations = [];
const rel = (o) => relations.push({ source_url: STORE, ...o });
rel({ relation: 'compatible_with', scope: PRODUCT, target_kind: 'family', target_label: 'A1 Series', evidence_kind: 'compat_section', locator: 'Compatibility', quote: 'Compatibility A1 Series' });
rel({ relation: 'compatible_with', scope: V.pA1, target_kind: 'printer', target_label: 'A1', target_source_handle: 'a1', evidence_kind: 'option_value', locator: 'option Printer Model › A1', quote: 'Printer Model: A1' });
rel({ relation: 'compatible_with', scope: V.pA1m, target_kind: 'printer', target_label: 'A1 mini', target_source_handle: 'a1-mini', evidence_kind: 'option_value', locator: 'option Printer Model › A1 mini', quote: 'Printer Model: A1 mini' });
rel({ relation: 'compatible_with', scope: V.pA2L, target_kind: 'printer', target_label: 'A2L', target_source_handle: 'a2l', evidence_kind: 'option_value', locator: 'option Printer Model › A2L', quote: 'Printer Model: A2L' });
const FIL = [
  ['PLA Sparkle', 'pla-sparkle', 'PLA Sparkle | *①NO | YES | YES | YES | Optional'],
  ['PLA Marble', 'pla-marble', 'PLA Marble | *①NO | YES | YES | YES | Optional'],
  ['Bambu PLA-CF', 'pla-cf', 'Bambu PLA-CF | *①NO | *②Recommended | YES | YES | Required'],
  ['Bambu PETG-CF', 'petg-cf', 'Bambu PETG-CF | *①NO | *②Recommended | YES | YES | Required'],
  ['Bambu PAHT-CF', 'paht-cf', 'Bambu PAHT-CF | *①NO | YES | *③Recommended | YES | Required'],
  ['Bambu PET-CF', 'pet-cf', 'Bambu PET-CF | *①NO | YES | *③Recommended | YES | Required'],
];
const isCF = (l) => l.startsWith('Bambu ');
for (const [label, handle, q] of FIL) {
  const base = { target_kind: 'product', target_label: label, target_source_handle: handle, evidence_kind: 'store_table', locator: `Filament Compatibility table › row ${label}`, quote: q };
  rel({ ...base, relation: 'not_compatible_with', scope: V.s02, reason: '0.2 mm column: *①NO' });
  rel({ ...base, relation: 'compatible_with', scope: V.h04, ...(label === 'Bambu PLA-CF' || label === 'Bambu PETG-CF' ? { qualifier: 'recommended' } : {}) });
  if (isCF(label)) rel({ ...base, relation: 'not_compatible_with', scope: V.s04, reason: 'Hardened Steel Required? Required' });
  else rel({ ...base, relation: 'compatible_with', scope: V.s04, reason: 'Hardened Steel Required? Optional', conflict: 'Bambu wiki filament guide text: do not use a stainless steel nozzle for particle-filled filaments such as PLA Marble and PLA Sparkle.' });
  rel({ ...base, relation: 'compatible_with', scope: V.h06, ...(label === 'Bambu PAHT-CF' || label === 'Bambu PET-CF' ? { qualifier: 'recommended' } : {}) });
  rel({ ...base, relation: 'compatible_with', scope: V.h08 });
}

const file = {
  handle: 'bambu-hotend-a1-a2',
  schema: 2,
  curated_by: 'agent-2',
  curated_at: process.argv[3],
  searched: [
    { kind: 'store_page', url: STORE, title: STORE_T, retrieved_at: STORE_AT,
      keys: ['thermal.*', 'product.*', 'package.*', 'nozzle.*', 'printing.supported_filament', 'printing.unsupported_filament', 'printing.layer_height', 'extrusion.*', 'motion.max_flow', 'part.*', 'electrical.*', 'safety.certifications', 'contents.pieces'] },
    { kind: 'wiki', url: NOZ, title: NOZ_T, retrieved_at: NOZ_AT,
      keys: ['nozzle.*', 'printing.layer_height', 'printing.supported_filament', 'motion.max_flow', 'thermal.max_nozzle_temp', 'extrusion.filament_diameter', 'product.*', 'part.*'] },
    { kind: 'wiki', url: FG, title: FG_T, retrieved_at: FG_AT,
      keys: ['printing.supported_filament', 'printing.unsupported_filament', 'printing.layer_height', 'nozzle.*', 'thermal.max_nozzle_temp', 'extrusion.filament_diameter', 'motion.max_flow'] },
  ],
  specs,
  hex: [],
  relations,
  in_the_box: [{ text: 'Hotend with Nozzle', qty: null, source_url: STORE, locator: 'In the Box › item 1', quote: '- Hotend with Nozzle' }],
  documents: [
    { kind: 'wiki', url: NOZ, title: 'Introduction to Bambu Nozzles' },
    { kind: 'wiki', url: FG, title: 'Filament guide - Printer, Nozzle, AMS, Build Plate, Glue Compatibility and Required Parameters' },
    { kind: 'wiki', url: TOOLHEAD, title: 'Replacing the hotend with nozzle', note: 'linked from the product page; not cached, not read' },
  ],
  not_published: ['product.width', 'product.height', 'product.net_weight', 'extrusion.filament_diameter', 'motion.max_flow'],
};
writeFileSync(OUT, JSON.stringify(file, null, 2) + '\n');
console.log('specs', specs.length, 'relations', relations.length, 'not_published', file.not_published.length);
