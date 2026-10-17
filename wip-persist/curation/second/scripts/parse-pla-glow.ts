import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { extractPage, identityCrossCheck } from '/home/user/levonis-curated/packages/catalog/src/bambuImport/extract';
import { extractionFingerprint } from '/home/user/levonis-curated/packages/catalog/src/bambuImport/fingerprint';
import { buildImportPayload } from '/home/user/levonis-curated/packages/catalog/src/bambuImport/payload';

const [rawFile, manifestFile, targetsFile, overridesFile, out] = process.argv.slice(2);
const html = gunzipSync(readFileSync(rawFile)).toString('utf8');
const x = extractPage(html).extraction;
const m = JSON.parse(readFileSync(manifestFile, 'utf8'));
const row = m.rows.find((r: any) => r.handle === 'pla-glow');
const targets = JSON.parse(readFileSync(targetsFile, 'utf8'));
const overrides = JSON.parse(readFileSync(overridesFile, 'utf8')).overrides;
console.log('identity', x.sourceProductId, x.handle, identityCrossCheck(x));
const build = buildImportPayload({ extraction: x, writeMode: 'create', extractionSha256: extractionFingerprint(x), manifestRow: row, identity: (()=>{const e=JSON.parse(readFileSync('/home/user/Levonis/docs/bambu-import/p0/identity-map.json','utf8')).entries['pla-glow']; return {model:e.model, series:e.series, family:e.family};})(), targets, overrides, retrievedAt: '2026-10-16T00:00:00Z' } as any);
writeFileSync(out, JSON.stringify({ extraction: x, payload: build.payload, report: build.report, described: build.described }, null, 1));
console.log('ok');
