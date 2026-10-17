import { readFileSync } from 'node:fs';
import { mergeCurated } from '/home/user/levonis-runner/scripts/bambu-import/enrich.ts';
import { specKey } from '/home/user/levonis-runner/packages/catalog/src/bambuImport/registry/specKeys.ts';

const [curatedPath, parsedPath] = process.argv.slice(2);
const f = JSON.parse(readFileSync(curatedPath, 'utf8'));
const parsed = JSON.parse(readFileSync(parsedPath, 'utf8'));
const problems: string[] = [];
const covered = (p: string, k: string) => (p.endsWith('.*') ? k.startsWith(p.slice(0, -1)) : p === k);
const RANGES: Record<string, [number, number]> = {
  'print_settings.nozzle_temp': [150, 350], 'print_settings.bed_temp': [0, 130], 'material.density': [0.9, 2.5], 'material.diameter': [1.5, 3],
  'drying.temperature': [30, 140], 'drying.time': [1, 48], 'thermal.melting_temp': [50, 400], 'thermal.glass_transition': [-80, 300],
  'thermal.vicat_softening': [30, 300], 'thermal.heat_deflection_temp': [30, 300], 'mechanical.tensile_strength': [1, 300],
  'mechanical.elongation_at_break': [0.1, 1000], 'mechanical.flexural_modulus': [10, 30000], 'mechanical.flexural_strength': [1, 400],
  'mechanical.impact_strength': [0.5, 200], 'material.net_weight': [50, 10000],
};
for (const s of f.specs) {
  const reg = specKey(s.key);
  if (!reg) { problems.push(`not in registry: ${s.key}`); continue; }
  if (s.unit !== reg.unit) problems.push(`unit ${s.key}: ${s.unit} vs ${reg.unit}`);
  const v = s.value;
  const shape = typeof v === 'number' ? 'number' : typeof v === 'string' ? 'string' : Array.isArray(v) ? 'list' : v && typeof v === 'object' ? 'range' : '?';
  if (shape !== reg.type && !(s.status === 'unverified' && shape === 'string')) problems.push(`type ${s.key}: value ${shape} vs registry ${reg.type}`);
  const numeric = typeof v === 'number' || (v && typeof v === 'object' && !Array.isArray(v));
  if (s.status === 'verified' && numeric && ['tds', 'sds', 'manual'].includes(s.source_kind) && (!s.locator || !s.quote)) problems.push(`no locator/quote ${s.key}`);
  if ((s.quote ?? '').length > 200) problems.push(`quote > 200 ${s.key}`);
  if ((s.locator ?? '').length > 200) problems.push(`locator > 200 ${s.key}`);
  if (s.source_kind === 'tds' && !s.test_condition) problems.push(`tds without test_condition ${s.key}`);
  const r = RANGES[s.key];
  if (r) { const nums = typeof v === 'number' ? [v] : [v.min, v.max]; for (const n of nums) if (n < r[0] || n > r[1]) problems.push(`range ${s.key}: ${n}`); }
  // quote must contain the number(s)
  const nums = typeof v === 'number' ? [v] : v && typeof v === 'object' && !Array.isArray(v) ? [v.min, v.max] : [];
  for (const n of nums) if (s.key !== 'material.net_weight' && !String(s.quote).includes(String(n))) problems.push(`quote lacks ${n} for ${s.key}`);
}
for (const k of f.not_published) {
  if (!specKey(k)) problems.push(`not_published not in registry: ${k}`);
  if (!f.searched.some((s: any) => (s.keys ?? []).some((p: string) => covered(p, k)))) problems.push(`not_published uncovered: ${k}`);
  if (f.specs.some((s: any) => s.key === k)) problems.push(`not_published also a spec: ${k}`);
}
const vals = new Map<string, string>();
for (const g of parsed.extraction.groups) for (const v of g.values) vals.set(v.id, v.value);
for (const h of f.hex) {
  if (!/^#[0-9A-F]{6}$/.test(h.hex)) problems.push(`hex format ${h.value_text}`);
  if (vals.get(h.source_value_id) !== h.value_text) problems.push(`hex value text mismatch ${h.value_text}`);
  if (!h.quote.includes(h.hex.slice(1))) problems.push(`hex quote ${h.value_text}`);
}
const colourValues = parsed.extraction.groups.find((g: any) => g.propertyKey === 'Color').values.map((v: any) => v.value);
for (const c of colourValues) if (!f.hex.some((h: any) => h.value_text === c)) problems.push(`colour without hex: ${c}`);
for (const r of f.relations) if ((r.quote ?? '').length > 300) problems.push(`relation evidence > 300 ${r.target_label}`);
const s = JSON.stringify(f).toLowerCase();
for (const w of ['price', 'cost', '$', 'usd', 'in stock', 'ships in', 'shipping time']) if (s.includes(w)) problems.push(`forbidden word: ${w}`);

const payload = JSON.parse(JSON.stringify(parsed.payload));
const before = JSON.parse(JSON.stringify(payload.specs));
const report = mergeCurated(payload, f, 'x'.repeat(64));
console.log('merge report', report);
for (const sp of payload.specs) {
  const b = before.find((x: any) => x.id === sp.id);
  console.log(sp.key.padEnd(38), sp.scope_kind.padEnd(12), sp.status.padEnd(13), sp.confidence.padEnd(16), sp.data_type.padEnd(7), JSON.stringify(sp.value_text), sp.value_num, sp.value_num_max, JSON.stringify(sp.value_list), sp.conflict ? `CONFLICT(${sp.conflict})` : '', b ? `[page: ${b.status} ${JSON.stringify(b.value_text)}]` : '', sp.checked_sources.length ? `checked=${sp.checked_sources.length}` : '');
}
console.log('notes', JSON.stringify(payload.notes));
console.log('documents', payload.documents.map((d: any) => `${d.kind} ${d.title_en}`));
console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'NO PROBLEMS');
