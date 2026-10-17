import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { specKey } from '/home/user/levonis-curated/packages/catalog/src/bambuImport/registry/specKeys';
import { assertImportPayload } from '/home/user/levonis-curated/packages/catalog/src/bambuImport/payload';
import { mergeCurated } from '/home/user/levonis-runner/scripts/bambu-import/enrich';

const [curatedPath, parsedPath] = process.argv.slice(2);
const bytes = readFileSync(curatedPath);
const file = JSON.parse(bytes.toString('utf8'));
const parsed = JSON.parse(readFileSync(parsedPath, 'utf8'));
const problems: string[] = [];
const RANGES: Record<string, [number, number]> = {
  'thermal.max_nozzle_temp': [150, 350], 'thermal.max_bed_temp': [40, 150], 'thermal.chamber_temp': [20, 120],
  'motion.max_speed': [50, 2000], 'motion.max_acceleration': [500, 50000], 'motion.max_flow': [5, 100], 'motion.max_flow_high_flow': [5, 120],
  'extrusion.nozzle_diameter': [0.1, 1.2], 'extrusion.filament_diameter': [1.7, 3], 'product.length': [100, 1500], 'product.width': [100, 1500],
  'product.height': [100, 1500], 'product.net_weight': [1000, 100000], 'electrical.max_power': [50, 5000],
};
const covered = (p: string, k: string) => (p.endsWith('.*') ? k.startsWith(p.slice(0, -1)) : p === k);
const seen = new Set<string>();
for (const s of file.specs) {
  const reg = specKey(s.key);
  if (!reg) { problems.push(`not in registry: ${s.key}`); continue; }
  if (reg.appliesTo.length && !reg.appliesTo.includes('printer')) problems.push(`not a printer key: ${s.key}`);
  if (s.unit !== reg.unit) problems.push(`unit ${s.key}: ${s.unit} != ${reg.unit}`);
  const id = `${s.key}|${JSON.stringify(s.scope)}|${s.region}`;
  if (seen.has(id)) problems.push(`duplicate ${id}`);
  seen.add(id);
  if (s.region === 'us_110v' && s.status === 'verified') problems.push(`us_110v verified: ${s.key}`);
  if (reg.regionDependent === 'always' && !s.region) problems.push(`region missing: ${s.key}`);
  if (!reg.regionDependent && s.region) problems.push(`region on a region-free key: ${s.key}`);
  if (s.status === 'verified' && typeof s.value === 'number' && (!s.locator || !s.quote)) problems.push(`verified numeric without locator/quote: ${s.key}`);
  if (!s.locator || !s.quote) problems.push(`no locator/quote: ${s.key}`);
  if (String(s.quote).length > 200) problems.push(`quote > 200: ${s.key}`);
  if (String(s.locator).length > 200) problems.push(`locator > 200: ${s.key}`);
  const r = RANGES[s.key];
  if (r && typeof s.value === 'number' && (s.value < r[0] || s.value > r[1])) problems.push(`range ${s.key}: ${s.value}`);
}
for (const k of file.not_published) {
  const reg = specKey(k);
  if (!reg) problems.push(`not_published not in registry: ${k}`);
  else if (reg.appliesTo.length && !reg.appliesTo.includes('printer')) problems.push(`not_published not a printer key: ${k}`);
  if (!file.searched.some((s: any) => s.keys.some((p: string) => covered(p, k)))) problems.push(`not_published not covered: ${k}`);
  if (file.specs.some((s: any) => s.key === k)) problems.push(`not_published also a spec: ${k}`);
  if (parsed.payload.specs.some((s: any) => s.key === k)) problems.push(`not_published but on the store page: ${k}`);
}
const banned = /price|cost|stock|shipping|usd|\$/i;
for (const s of file.specs) if (banned.test(`${s.value} ${s.quote}`)) problems.push(`money/stock word in ${s.key}`);
console.log('SCHEMA PROBLEMS', problems);

// Merge exactly as the runner does, then the allow-list.
const payload = JSON.parse(JSON.stringify(parsed.payload));
const before = new Map(payload.specs.map((s: any) => [s.id, JSON.parse(JSON.stringify(s))]));
const sha = createHash('sha256').update(bytes).digest('hex');
const report = mergeCurated(payload, file, sha);
console.log('MERGE', report);
try {
  assertImportPayload(JSON.parse(JSON.stringify(payload)));
  console.log('assertImportPayload OK');
} catch (e: any) {
  console.log('assertImportPayload REFUSED', e?.path, e?.reason, e?.detail ?? '', String(e));
}
for (const s of payload.specs) {
  const old: any = before.get(s.id);
  if (s.conflict || (old && old.source_kind !== s.source_kind)) {
    console.log(`${s.key} [${s.region || '-'}] ${s.status} ${s.source_kind} conflict=${JSON.stringify(s.conflict)}\n   page: ${JSON.stringify(old?.value_text)} | curated: ${JSON.stringify(s.value_text)} num=${s.value_num} bool=${s.value_bool}`);
  }
}
const added = payload.specs.filter((s: any) => !before.has(s.id));
console.log('ADDED', added.map((s: any) => `${s.key}[${s.region || '-'}]=${s.status}:${s.value_text}`));
console.log('NOTES', payload.notes.filter((n: any) => n.kind === 'spec_sources_disagree'));
console.log('DOCS', payload.documents.map((d: any) => `${d.kind} ${d.url} ${d.title_en}`));
