/**
 * P0 final-pass check with the REAL step-4 code (read-only imports from /home/user/levonis-import):
 *  1. every title, option group name and option value name of the 1,115 pages through the TS classifier with payload.ts's
 *     textRefusal splitting (customer class) -> ids + class only, never text;
 *  2. ams-2-pro's payload with the manifest's value_labels applied the way owner-questions §E item 1 asks
 *     (name_en/ar/ckb, variant_label, value source_refs.source_label), then assertImportPayload over the WHOLE payload.
 * Writes nothing outside p0/work/step4. Run: /home/user/levonis-import/node_modules/.bin/tsx p0/work/step4/check.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { step4CodeState } from './codestate';
import { gunzipSync } from 'node:zlib';
import { extractPage } from '/home/user/levonis-import/packages/catalog/src/bambuImport/extract';
import { buildImportPayload, assertImportPayload, ImportPayloadRefused } from '/home/user/levonis-import/packages/catalog/src/bambuImport/payload';
import { extractionFingerprint } from '/home/user/levonis-import/packages/catalog/src/bambuImport/fingerprint';
import { classifySentence } from '/home/user/levonis-import/packages/catalog/src/bambuImport/sentences';

const P0 = '/tmp/claude-0/-home-user-Levonis/f168c507-ccde-51da-80be-0fda576cd519/scratchpad/bambu/p0';
const manifest = JSON.parse(readFileSync(`${P0}/manifest.json`, 'utf8'));
const targets = JSON.parse(readFileSync(`${P0}/compat-targets.json`, 'utf8'));
const identity = JSON.parse(readFileSync(`${P0}/identity-map.json`, 'utf8')).entries ?? {};
const fileOf = (h: string) => `${P0}/raw/${h.replace(/[^A-Za-z0-9._-]/g, '_')}.html.gz`;
const CUSTOMER = new Set(['money', 'promotion', 'shipping_policy', 'warranty']);
// payload.ts textRefusal (not exported): line by line, then at [.!?。] + space.
const refusal = (s: string): string | null => {
  if (!s) return null;
  for (const line of s.split(/\n+/)) for (const part of line.split(/(?<=[.!?。])\s+/)) {
    const c = classifySentence(part);
    if (CUSTOMER.has(c)) return c;
  }
  return null;
};

const hits: any[] = [];
const scanned = { titles: 0, option_groups: 0, option_values: 0 };
let ams: any = null;
for (const r of manifest.rows) {
  const html = gunzipSync(readFileSync(fileOf(r.handle))).toString('utf8');
  const x: any = extractPage(html).extraction;
  scanned.titles++;
  const t = refusal(x.title);
  if (t) hits.push({ handle: r.handle, field: 'title', class: t });
  const groups: any[] = x.groups ?? x.options ?? x.properties ?? [];
  if (r.handle === 'ams-2-pro') ams = { r, x };
  (r as any)._x = x;
}
// The extraction's option shape: find it generically (groups with values) to stay independent of field names.
const sample = manifest.rows.find((r: any) => r.handle === 'ams-2-pro')._x;
const keys = Object.keys(sample);
writeFileSync(`${P0}/work/step4/extraction-keys.json`, JSON.stringify(keys));
const groupKey = keys.find((k) => Array.isArray(sample[k]) && sample[k].length && sample[k][0] && typeof sample[k][0] === 'object' && Array.isArray(sample[k][0].values));
if (!groupKey) throw new Error('no option group array found in the extraction: ' + keys.join(','));
for (const r of manifest.rows) {
  const x = r._x;
  for (const g of x[groupKey] ?? []) {
    scanned.option_groups++;
    const gl = g.propertyKey ?? g.label ?? g.name ?? '';
    const gc = refusal(gl);
    if (gc) hits.push({ handle: r.handle, field: 'group', group_source_id: g.propertyKeyId ?? g.sourceId ?? g.id, class: gc });
    for (const v of g.values ?? []) {
      scanned.option_values++;
      const vl = v.value ?? v.text ?? v.name ?? '';
      const vc = refusal(vl);
      if (vc) hits.push({ handle: r.handle, field: 'value', value_source_id: v.id ?? v.sourceId, class: vc });
    }
  }
}

// 2. ams-2-pro with the reviewed labels applied, then the whole-payload validator.
const res: any = buildImportPayload({
  extraction: ams.x, writeMode: 'create', extractionSha256: extractionFingerprint(ams.x), skuCodes: ams.r.sku_codes ?? {},
  identity: identity['ams-2-pro'] ?? null, targets, retrievedAt: '2026-10-15T00:00:00Z',
} as any);
const p = JSON.parse(JSON.stringify(res.payload));
let before = 'ok';
try { assertImportPayload(JSON.parse(JSON.stringify(p))); } catch (e) {
  if (!(e instanceof ImportPayloadRefused)) throw e;
  before = `${e.reason}:${e.textClass} at ${e.path.replace(/\[\d+\]/g, '[]')}`;
}
const labels = ams.r.value_labels ?? {};
let applied = 0;
for (const g of p.groups) for (const v of g.values) {
  const l = labels[v.source_id];
  if (!l) continue;
  v.name_en = l.name_en; v.name_ar = l.name_ar; v.name_ckb = l.name_ckb; v.variant_label = l.name_en; applied++;
}
for (const s of p.source_refs) if (s.kind === 'value' && labels[s.source_id]) { s.source_label = labels[s.source_id].name_en; applied++; }
// Image alt texts append the value's nameEn as the selection label (media.ts push(..., val.nameEn) -> registry/labels altText):
// the label must reach them too. Simulate applying the label in the option model BEFORE media binding.
const srcText = new Map<string, string>();
for (const g of ams.x.groups) for (const v of g.values) if (labels[v.id ?? v.sourceId]) srcText.set(v.id ?? v.sourceId, v.value ?? v.text ?? v.name);
let altFixed = 0;
const pAltOnlyBefore = JSON.parse(JSON.stringify(p));
let afterNoAlt = 'ok';
try { assertImportPayload(pAltOnlyBefore); } catch (e) { if (!(e instanceof ImportPayloadRefused)) throw e; afterNoAlt = `${e.reason}:${e.textClass} at ${e.path.replace(/\[\d+\]/g, '[]')}`; }
// The selection label is ' — ' + the value's nameEn (value, value_set, representative rows) or the variant's value names
// joined by ' / ' (variant rows): swap the exact segment, as applying the label in the option model would.
for (const im of p.images) for (const k of ['alt_en', 'alt_ar', 'alt_ckb']) {
  const s0: string = im[k];
  const cut = s0.lastIndexOf(' — ');
  if (cut < 0) continue;
  const segs = s0.slice(cut + 3).split(' / ');
  let changed = false;
  for (const [vid, t] of srcText) for (let i = 0; i < segs.length; i++) if (segs[i] === t) { segs[i] = labels[vid].name_en; changed = true; }
  if (changed) { im[k] = s0.slice(0, cut + 3) + segs.join(' / '); altFixed++; }
}
let after = 'ok';
try { assertImportPayload(p); } catch (e) {
  if (!(e instanceof ImportPayloadRefused)) throw e;
  after = `${e.reason}:${e.textClass} at ${e.path.replace(/\[\d+\]/g, '[]')}`;
}
// Where else would the source wording sit? (ids only)
const wording = Object.keys(labels);
const leftovers: string[] = [];
const walk = (v: any, path: string) => {
  if (typeof v === 'string') { if (/\bdeals?\b/i.test(v)) leftovers.push(path); return; }
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
};
walk(p, '$');
const out = { step4_code: step4CodeState(), scanned, hits, ams_2_pro: { group_key: groupKey, before, applied, after_names_only: afterNoAlt, alt_fixed: altFixed, after_names_and_alts: after, variants: p.variants.length, values: p.groups.reduce((n: number, g: any) => n + g.values.length, 0), value_labels: wording, promotion_word_left_at: leftovers } };
writeFileSync(`${P0}/work/step4/check.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
