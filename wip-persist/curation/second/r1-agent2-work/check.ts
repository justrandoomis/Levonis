import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { specKey } from '/home/user/levonis-curated/packages/catalog/src/bambuImport/registry/specKeys';
import { mergeCurated } from '/home/user/levonis-runner/scripts/bambu-import/enrich';
const bytes = readFileSync(process.argv[2]);
const file = JSON.parse(bytes.toString('utf8'));
const payload = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const problems: string[] = [];
const covered = (k: string) => file.searched.some((s: any) => s.keys.some((p: string) => (p.endsWith('.*') ? k.startsWith(p.slice(0, -1)) : p === k)));
for (const s of file.specs) {
  const r = specKey(s.key);
  if (!r) { problems.push(`not in registry: ${s.key}`); continue; }
  if (r.appliesTo.length && !r.appliesTo.includes('laser_machine')) problems.push(`appliesTo excludes laser_machine: ${s.key}`);
  if ((s.unit ?? '') !== r.unit) problems.push(`unit ${s.key}: ${s.unit} vs registry ${r.unit}`);
  if (typeof s.quote !== 'string' || s.quote.length > 200) problems.push(`quote length ${s.key} ${s.quote?.length}`);
  if (s.status === 'verified' && typeof s.value === 'number' && (!s.locator || !s.quote)) problems.push(`verified numeric without locator/quote ${s.key}`);
  if (s.locator.length > 200) problems.push(`locator long ${s.key}`);
  if (!covered(s.key)) problems.push(`spec key not covered by searched: ${s.key}`);
}
for (const k of file.not_published) {
  const r = specKey(k);
  if (!r) problems.push(`np not in registry ${k}`);
  else if (r.appliesTo.length && !r.appliesTo.includes('laser_machine')) problems.push(`np not applicable ${k}`);
  if (!covered(k)) problems.push(`np not covered ${k}`);
  if (file.specs.some((s: any) => s.key === k)) problems.push(`np also in specs ${k}`);
}
for (const r of file.relations) if (!r.quote || r.quote.length > 200) problems.push(`relation quote ${r.target_label} ${r.quote?.length}`);
console.log('problems', problems);
const sha = createHash('sha256').update(bytes).digest('hex');
const before = payload.specs.length;
const rep = mergeCurated(payload, file, sha);
console.log('merge', rep, 'specs', before, '->', payload.specs.length);
for (const s of payload.specs) console.log(s.key, '|', s.scope_kind, s.scope_id, '|', s.region, s.status, s.confidence, s.source_kind, '|', s.data_type, JSON.stringify(s.value_text).slice(0, 90), s.value_num, s.unit, '| cs', s.checked_sources.length, s.visibility);
console.log('docs', payload.documents.map((d: any) => [d.kind, d.title_en, d.url]));
console.log('notes', payload.notes);
