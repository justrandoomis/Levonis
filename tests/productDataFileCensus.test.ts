/**
 * «ملف بيانات المنتج» ON THE REAL CATALOGUE: every one of the 41 census
 * products (tests/fixtures/legacyCatalogue.ts — the live shapes, legacy data
 * included) downloads, comes back unedited as ZERO changes, and takes a
 * one-field edit that writes that field alone (no side effect, read back as
 * written).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, stubApp, freshDb, all } from './fixtures/app';
import { seedLegacyCatalogue, seedProfileRates } from './fixtures/legacyCatalogue';
import { OWNER_ROW_SQL } from './fixtures/fx';
import { templateRoutes } from '../worker/routes/template';
import { download, preview, edit, apply, OWNER } from './fixtures/dataFile';
test('every census product round-trips with zero changes and takes a one-field edit alone', async () => {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL); seedLegacyCatalogue(raw); seedProfileRates(raw);
  const app = stubApp(asD1(raw), OWNER, (a) => a.route('/api/admin/template', templateRoutes));
  const ids = all<{ id: string }>(raw, "SELECT id FROM products WHERE COALESCE(composition,'') = '' ORDER BY id").map((r) => r.id);
  const problems: string[] = [];
  for (const id of ids) {
    const text = await download(app, id);
    const [p] = await preview(app, text, id);
    const odd = p.fields.filter((f) => f.status !== 'STALE_IN_FILE');
    if (p.error || odd.length) { problems.push(`${id} roundtrip: ${JSON.stringify(p.error)} ${JSON.stringify(odd.slice(0,4))}`); continue; }
    const ed = edit(text, 'sku', `SKU-${id}`);
    const [q] = await preview(app, ed, id);
    if (!q.token || q.fields.length !== 1 || q.fields[0].status !== 'change') { problems.push(`${id} edit: ${JSON.stringify(q.fields.slice(0,4))}`); continue; }
    const r = await apply(app, ed, q);
    if (r.status !== 200) problems.push(`${id} apply ${r.status}: ${(await r.text()).slice(0, 300)}`);
    else { const b = await r.json() as { not_persisted: string[] }; if (b.not_persisted.length) problems.push(`${id} not persisted ${b.not_persisted}`); }
  }
  assert.equal(ids.length, 41);
  assert.deepEqual(problems, []);
});
