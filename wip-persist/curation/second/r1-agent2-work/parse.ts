import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { extractPage, identityCrossCheck } from '/home/user/levonis-curated/packages/catalog/src/bambuImport/extract';
import { buildImportPayload } from '/home/user/levonis-curated/packages/catalog/src/bambuImport/payload';
import { extractionFingerprint } from '/home/user/levonis-curated/packages/catalog/src/bambuImport/fingerprint';
const D = '/home/user/levonis-curated/data/bambu-import/';
const html = gunzipSync(readFileSync(process.argv[2])).toString('utf8');
const out = process.argv[3];
const x = extractPage(html).extraction;
const manifest = JSON.parse(readFileSync('/home/user/Levonis/docs/bambu-import/p0/manifest.json', 'utf8'));
const row = manifest.rows.find((r: any) => r.handle === 'r1');
const targets = JSON.parse(readFileSync(D + 'compat-targets.json', 'utf8'));
const overrides = JSON.parse(readFileSync(D + 'media-overrides.json', 'utf8')).overrides;
const identity = JSON.parse(readFileSync(D + 'identity-map.json', 'utf8'));
console.log('ids', x.sourceProductId, x.handle, 'cross', JSON.stringify(identityCrossCheck(x)));
const build = buildImportPayload({
  extraction: x, writeMode: 'create', extractionSha256: extractionFingerprint(x), manifestRow: row,
  identity: identity.entries[row.handle] ?? null, targets, overrides, retrievedAt: '2026-10-16T06:57:00Z',
} as any);
writeFileSync(out + '/extraction.json', JSON.stringify(x, null, 1));
writeFileSync(out + '/payload.json', JSON.stringify(build.payload, null, 1));
writeFileSync(out + '/report.json', JSON.stringify(build.report, null, 1));
writeFileSync(out + '/described.json', JSON.stringify((build as any).described ?? null, null, 1));
writeFileSync(out + '/page.html', html);
console.log(Object.keys(build));
