/**
 * THE SANDBOX TOOLS OF THE BAMBU IMPORT (import spec §E.1, §K.2 step 10):
 *
 *   - scripts/bambu-import/match-candidates.ts reproduces the §E.1 candidate
 *     set (brand, registry model and material tokens, Bambu image sources,
 *     slug/handle overlap) from an unsealed snapshot and the manifest; a slug
 *     only for an active product; it refuses to run in Actions and to write
 *     inside a git checkout, and never overwrites a file;
 *   - scripts/e2e-bambu-import.mjs, the local workerd dry run: its arguments,
 *     its refusal of any Cloudflare credential, the fixture bundle it builds,
 *     the run row, the store stand-in (a picture of its own per CDN path, so
 *     the Worker's collapse of byte-identical images does not fold every
 *     gallery into one) and the pass conditions.
 *
 * Run: node --import tsx --test tests/bambuImportTools.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { ROOT } from './fixtures/d1';
import { freshDb } from './fixtures/app';
import { main as candidatesMain, matchCandidates, materialTokens, modelTokens, slugOverlap, tablesOf, manifestEntries } from '../scripts/bambu-import/match-candidates';
import { loadReviewedBundle } from '../scripts/bambu-import/discover';
// @ts-expect-error - plain ESM script (the local dry run), no types
import { fixtureBundle, judge, parseArgs, refuseCredentials, runRowSql, storeAnswer, standInPng, FIXTURE_HANDLES } from '../scripts/e2e-bambu-import.mjs';

const SNAPSHOT = {
  format: 'levonis-bambu-snapshot/1',
  tables: {
    brands: [{ id: 'br_bambu', slug: 'bambu-lab', name_en: 'Bambu Lab' }, { id: 'br_other', slug: 'creality', name_en: 'Creality' }],
    products: [
      { id: 'p_a1', slug: 'bambu-lab-a1', status: 'active', name: 'Bambu Lab A1 3D Printer', brand_id: 'br_bambu' },
      { id: 'p_hidden', slug: 'secret-a1-combo', status: 'hidden', name: 'PLANTED-HIDDEN-NAME A1 Combo', brand_id: 'br_bambu' },
      { id: 'p_pla', slug: 'pla-basic-black', status: 'active', name: 'PLA Basic Black', brand_id: null, brand: 'Bambu' },
      { id: 'p_other', slug: 'ender-3', status: 'active', name: 'Ender 3', brand_id: 'br_other' },
      { id: 'p_src', slug: 'mystery-part', status: 'draft', name: 'Mystery part', brand_id: null },
    ],
    image_sources: [
      { product_id: 'p_src', source_url: 'https://store.bblcdn.com/x/filamentsbuffer-1.png' },
      { product_id: 'p_other', source_url: 'https://example.com/x.png' },
    ],
    option_values: [],
    colors: [],
  },
};
const MANIFEST = {
  rows: [
    { source_product_id: '1', handle: 'a1', title: 'Bambu Lab A1 3D Printer', type: 'printer' },
    { source_product_id: '2', handle: 'a1-combo', title: 'Bambu Lab A1 Combo', type: 'printer' },
    { source_product_id: '3', handle: 'pla-basic-filament', title: 'PLA Basic', type: 'filament' },
    { source_product_id: '4', handle: 'filament-buffer', title: 'Filament Buffer', type: 'spare_part' },
  ],
};

test('match candidates: the §E.1 signals; names are evidence only; a slug only for an active product', () => {
  assert.deepEqual(modelTokens('Bambu Lab A1 mini Combo'), ['A1 mini']);
  assert.deepEqual(materialTokens('Bambu PETG-HF Filament and PLA Basic'), ['PETG-HF', 'PLA basic']);
  assert.ok(slugOverlap('bambu-lab-a1', 'a1'));
  assert.ok(!slugOverlap('ender-3', 'a1'));
  const out = matchCandidates(tablesOf(SNAPSHOT), manifestEntries(MANIFEST));
  const ids = out.map((p) => p.levonis_product_id);
  assert.deepEqual(ids, ['p_a1', 'p_hidden', 'p_pla', 'p_src'], 'a product with no Bambu signal is not a candidate subject');
  const a1 = out.find((p) => p.levonis_product_id === 'p_a1')!;
  assert.equal(a1.levonis_slug, 'bambu-lab-a1');
  assert.equal(a1.candidates[0].handle, 'a1', 'the same model set and the slug rank first');
  assert.ok(a1.candidates[0].reasons.includes('model:A1') && a1.candidates[0].reasons.includes('slug_handle'));
  const hidden = out.find((p) => p.levonis_product_id === 'p_hidden')!;
  assert.equal(hidden.levonis_slug, '', 'no slug for a product that is not active');
  assert.equal(hidden.status, 'hidden');
  assert.equal(out.find((p) => p.levonis_product_id === 'p_pla')!.candidates[0].handle, 'pla-basic-filament');
  const src = out.find((p) => p.levonis_product_id === 'p_src')!;
  assert.equal(src.signals.bambu_image_sources, 1, 'an image taken from Bambu\'s CDN is a signal');
});

test('match candidates: sandbox only — refused in Actions, refused inside a checkout, never over a file, 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'levonis-candidates-'));
  const logs: string[] = [];
  const log = (s: string) => logs.push(s);
  try {
    const snap = join(dir, 'snapshot.json');
    const man = join(dir, 'manifest.json');
    writeFileSync(snap, JSON.stringify(SNAPSHOT));
    writeFileSync(man, JSON.stringify(MANIFEST));
    const out = join(dir, 'candidates.json');
    assert.equal(candidatesMain(['--snapshot', snap, '--manifest', man, '--out', out], { GITHUB_ACTIONS: 'true' }, log), 1);
    assert.ok(!existsSync(out));
    assert.equal(candidatesMain(['--snapshot', snap, '--manifest', man, '--out', join(ROOT, 'candidates.json')], {}, log), 1);
    assert.ok(!existsSync(join(ROOT, 'candidates.json')), 'nothing is written inside the repository');
    assert.ok(logs.some((l) => /inside the git checkout/.test(l)));
    assert.equal(candidatesMain(['--snapshot', snap, '--manifest', man], {}, log), 2);
    assert.equal(candidatesMain(['--snapshot', snap, '--manifest', man, '--out', out], {}, log), 0);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(doc.format, 'levonis-bambu-match-candidates/1');
    assert.equal(doc.snapshot_sha256, createHash('sha256').update(readFileSync(snap)).digest('hex'));
    assert.equal(doc.products.length, 4);
    assert.equal(candidatesMain(['--snapshot', snap, '--manifest', man, '--out', out], {}, log), 1, 'never over an existing file');
    assert.ok(!logs.some((l) => l.includes('PLANTED-HIDDEN-NAME')), 'the console carries counts, never a name');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the dry run: arguments, no Cloudflare credential, the fixture bundle, the run row, the store stand-in, the pass conditions', () => {
  assert.deepEqual(parseArgs(['--build', '--images', 'real', '--seal', 'A'.repeat(43), '--out', '/tmp/x']), { build: true, images: 'real', seal: 'A'.repeat(43), out: '/tmp/x' });
  assert.deepEqual(parseArgs([]), { build: false, images: 'double', seal: '', out: '' });
  assert.throws(() => parseArgs(['--images', 'cdn']));
  assert.throws(() => parseArgs(['--seal', 'A'.repeat(43)]), /--seal needs --out/);
  assert.throws(() => parseArgs(['--wrangler']));
  assert.throws(() => refuseCredentials({ CLOUDFLARE_API_TOKEN: 'x' }), /never uses one/);
  assert.doesNotThrow(() => refuseCredentials({ PATH: '/bin', CLOUDFLARE_API_TOKEN: '' }));

  const { rows, text } = fixtureBundle() as { rows: Array<Record<string, unknown>>; text: Record<string, string> };
  assert.deepEqual(rows.map((r) => [r.handle, r.queue_position]), FIXTURE_HANDLES.map((h: string, i: number) => [h, i + 1]));
  const dir = mkdtempSync(join(tmpdir(), 'levonis-dryrun-bundle-'));
  try {
    for (const [file, body] of Object.entries(text)) {
      const path = join(dir, file);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, body);
    }
    const bundle = loadReviewedBundle(dir);
    assert.equal(bundle.rows.length, 2, 'the bundle loads as the runner reads it');
    assert.equal(Object.keys(bundle.curatedIndex).length, rows.filter((r) => r.curated === true).length, 'every curated row has its reviewed file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const db = freshDb();
  try {
    db.exec(runRowSql('cir_0123456789abcdef01234567', 'b'.repeat(64), '2099-01-01T00:00:00.000Z', 2));
    const row = db.prepare('SELECT state, token_sha256, manifest_total FROM catalog_import_runs').get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, { state: 'open', token_sha256: 'b'.repeat(64), manifest_total: 2 });
  } finally {
    db.close();
  }
  assert.throws(() => runRowSql("cir_x' OR 1", 'b'.repeat(64), '2099-01-01T00:00:00.000Z', 2));

  const pages = { 'filament-buffer': '<html>fb</html>' };
  assert.equal(storeAnswer('/products/filament-buffer', pages).status, 200);
  assert.equal(storeAnswer('/products/gone', pages).status, 404);
  assert.match(storeAnswer('/robots.txt', pages).body, /User-agent: \*/);
  assert.match(storeAnswer('/sitemap_products_1.xml', pages).body, /\/products\/filament-buffer/);
  // The media stand-in: a valid PNG per CDN path, the same bytes for the same path, other pixels for another one.
  const pathA = '/s7/default/x/img.png';
  const pathB = '/s7/default/y/other.jpg';
  const a = storeAnswer(pathA, pages);
  assert.equal(a.type, 'image/png');
  assert.deepEqual(a.body, standInPng(pathA));
  assert.deepEqual(storeAnswer(pathA, pages).body, a.body, 'the same path, the same bytes (a real copy collapses, as on the CDN)');
  assert.notDeepEqual(storeAnswer(pathB, pages).body, a.body);
  const pixel = (png: Uint8Array) => {
    const be32 = (at: number) => new DataView(png.buffer, png.byteOffset + at, 4).getUint32(0);
    const ascii = (at: number) => String.fromCharCode(...png.subarray(at, at + 4));
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(ascii(12), 'IHDR');
    assert.deepEqual([be32(16), be32(20), png[24], png[25]], [8, 8, 8, 2]);
    let at = 8;
    while (ascii(at + 4) !== 'IDAT') at += 12 + be32(at);
    const raw = inflateSync(png.subarray(at + 8, at + 8 + be32(at)));
    assert.equal(raw.length, 8 * (1 + 8 * 3));
    return [...raw.subarray(1, 4)].join(',');
  };
  assert.notEqual(pixel(a.body), pixel(storeAnswer(pathB, pages).body), 'different pixels, so different WebP bytes after conversion');
  assert.equal(pixel(standInPng('/s1/swatch.media')), pixel(storeAnswer('/s1/swatch.media', pages).body));

  const good = { items: [{ handle: 'a', processing_state: 'COMPLETE' }], products: [{ id: 'p', price_iqd: 0, stock: null }], refs: [{ product_id: 'p', stock_decision: 'not_configured' }], guardEvents: 0, rerunWrites: 0 };
  assert.deepEqual(judge(good), []);
  assert.deepEqual(judge({ ...good, products: [{ id: 'p', price_iqd: 1000, stock: 3 }] }), ['p: a price', 'p: stock is set']);
  assert.deepEqual(judge({ ...good, rerunWrites: 4, guardEvents: 1 }), ['1 guard hits', 'a full re-run wrote 4 rows']);
});
