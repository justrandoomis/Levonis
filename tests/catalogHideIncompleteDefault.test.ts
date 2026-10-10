/**
 * Owner decision 2026-10-10 («في نعم اخفي كل المنتجات»): migration 0184 ships the
 * «إخفاء المنتجات الناقصة عن الزبائن» switch ON, and never overwrites a choice the
 * owner already stored.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dbThrough, type freshDb } from './fixtures/app';
import { normalizeCatalogHideIncomplete } from '../worker/lib/settings';

const MIGRATION = readdirSync('migrations').find((f) => /^\d{4}_product_completeness\.sql$/.test(f))!;

const stored = (raw: ReturnType<typeof freshDb>) =>
  (raw.prepare("SELECT value FROM admin_settings WHERE key = 'catalogHideIncomplete'").get() as { value?: string } | undefined)?.value;

test('a database at 0183 has the switch ON once the completeness migration runs', () => {
  // dbThrough/freshDb clear the seed so unrelated tests list as today; apply 0184 by hand here.
  const raw = dbThrough('0183');
  raw.exec(readFileSync(`migrations/${MIGRATION}`, 'utf8'));
  const v = stored(raw);
  assert.ok(v, 'the switch row exists');
  assert.equal(normalizeCatalogHideIncomplete(JSON.parse(v!)).enabled, true);
});

test('a switch the owner already stored is never overwritten by the migration', () => {
  const raw = dbThrough('0183');
  raw.exec(`INSERT INTO admin_settings (key, value) VALUES ('catalogHideIncomplete', '{"enabled":false,"since":null,"by":"owner"}')`);
  raw.exec(readFileSync(`migrations/${MIGRATION}`, 'utf8'));
  assert.equal(normalizeCatalogHideIncomplete(JSON.parse(stored(raw)!)).enabled, false);
});
