import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { extractPage } from '/home/user/levonis-curated/packages/catalog/src/bambuImport/extract';
import { extractionFingerprint } from '/home/user/levonis-curated/packages/catalog/src/bambuImport/fingerprint';
import { buildImportPayload } from '/home/user/levonis-curated/packages/catalog/src/bambuImport/payload';

const [rawPath, manifestPath, targetsPath, identityPath, overridesPath, outPath] = process.argv.slice(2);
const html = gunzipSync(readFileSync(rawPath)).toString('utf8');
const x = extractPage(html).extraction;
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const rows = Array.isArray(manifest) ? manifest : manifest.products ?? manifest.rows;
const row = rows.find((r: any) => r.handle === 'h2s');
const targets = JSON.parse(readFileSync(targetsPath, 'utf8'));
const identityAll = JSON.parse(readFileSync(identityPath, 'utf8'));
let overrides: any = JSON.parse(readFileSync(overridesPath, 'utf8'));
overrides = Array.isArray(overrides) ? overrides : overrides.overrides ?? [];
const identity = (identityAll.entries ?? identityAll)['h2s'] ?? null;
const build = buildImportPayload({
  extraction: x, writeMode: 'create', extractionSha256: extractionFingerprint(x), manifestRow: row,
  identity, targets, overrides, retrievedAt: '2026-10-16T00:00:00Z',
});
writeFileSync(outPath, JSON.stringify({ extraction: x, payload: build.payload, report: build.report }, null, 1));
const p = build.payload;
console.log('errors', build.report.errors, 'type', build.report.productType, 'format', build.report.format);
for (const g of p.groups) { console.log('GROUP', g.id, g.source_id, JSON.stringify(g.name ?? g.label ?? '')); for (const v of g.values) console.log('  VALUE', v.id, v.source_id, JSON.stringify((v as any).value_text ?? (v as any).label ?? (v as any).name)); }
for (const v of p.variants) console.log('VARIANT', v.id, v.source_id, JSON.stringify((v as any).value_ids ?? (v as any).values ?? ''));
for (const s of p.specs) console.log('SPEC', s.key, s.scope_kind, s.scope_id, s.region || '-', s.status, s.confidence, s.source_kind, '|', s.value_text, '|', s.value_num, s.value_num_max, s.unit, '|', s.source_locator, '|', s.source_excerpt);
for (const d of p.documents) console.log('DOC', d.kind, d.url, d.title_en);
for (const n of p.notes) console.log('NOTE', JSON.stringify(n));
