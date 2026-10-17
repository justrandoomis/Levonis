import { readFileSync } from 'node:fs';
const { mergeCurated } = await import('/home/user/levonis-runner/scripts/bambu-import/enrich.ts');
const { specKey } = await import('/home/user/levonis-curated/packages/catalog/src/bambuImport/registry/specKeys.ts');
const [, , parsedPath, curatedPath] = process.argv;
const parsed = JSON.parse(readFileSync(parsedPath, 'utf8'));
const file = JSON.parse(readFileSync(curatedPath, 'utf8'));
const payload = structuredClone(parsed.payload);
const before = new Map(payload.specs.map((s: any) => [s.id, structuredClone(s)]));
const problems: string[] = [];
// registry, unit, applies-to
for (const s of file.specs) {
  const r = specKey(s.key);
  if (!r) { problems.push(`unknown key ${s.key}`); continue; }
  if (r.appliesTo.length && !r.appliesTo.includes('hotend')) problems.push(`${s.key} not for hotend`);
  if ((r.unit || '') !== (s.unit || '')) problems.push(`${s.key} unit ${s.unit} != registry ${r.unit}`);
  if (s.status === 'verified' && (typeof s.value === 'number' || (s.value && typeof s.value === 'object' && 'min' in s.value))) {
    if (!s.locator || !s.quote) problems.push(`${s.key} verified numeric without locator/quote`);
  }
  if ((s.quote ?? '').length > 200) problems.push(`${s.key} quote ${s.quote.length} chars`);
  if ((s.locator ?? '').length > 200) problems.push(`${s.key} locator long`);
  if (s.key === 'thermal.max_nozzle_temp' && (s.value < 150 || s.value > 350)) problems.push('nozzle temp range');
  if (s.key === 'nozzle.diameter' && (s.value < 0.1 || s.value > 2)) problems.push('nozzle diameter range');
  if (s.key === 'printing.layer_height' && !(s.value.min > 0 && s.value.max > s.value.min && s.value.max < 1)) problems.push('layer height range');
}
for (const k of file.not_published) {
  const r = specKey(k);
  if (!r) problems.push(`np unknown ${k}`);
  else if (r.appliesTo.length && !r.appliesTo.includes('hotend')) problems.push(`np ${k} not for hotend`);
  const cov = file.searched.some((s: any) => s.keys.some((p: string) => (p.endsWith('.*') ? k.startsWith(p.slice(0, -1)) : p === k)));
  if (!cov) problems.push(`np ${k} not covered`);
  if (file.specs.some((s: any) => s.key === k)) problems.push(`np ${k} also has a value`);
}
for (const r of file.relations) if ((r.quote ?? '').length > 200) problems.push('relation quote long');
const rep = mergeCurated(payload, file, 'test');
console.log('merge report', rep);
// consistency with the page: rows the curated file touched that existed before
for (const s of payload.specs) {
  const b: any = before.get(s.id);
  if (b && (b.value_num !== s.value_num || b.value_text !== s.value_text || s.conflict)) console.log('CHANGED/CONFLICT', s.key, s.scope_id, b.value_text, '->', s.value_text, s.conflict);
}
console.log('notes', JSON.stringify(payload.notes));
for (const s of payload.specs.filter((s: any) => !before.has(s.id))) console.log('ADDED', s.key, s.scope_kind, s.scope_id, s.data_type, JSON.stringify(s.value_text).slice(0, 90), s.value_num, s.value_num_max, s.unit, s.status, s.source_kind, JSON.stringify(s.checked_sources.map((c: any) => c.kind)));
console.log('docs', payload.documents.map((d: any) => `${d.kind} ${d.title_en} ${d.url}`));
console.log('PROBLEMS', problems);
