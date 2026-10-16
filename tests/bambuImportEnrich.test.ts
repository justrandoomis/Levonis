/**
 * ENRICH (Bambu import spec §C.5, §C.7, §F, §J.2): the curated merge and its
 * gate, tracker links (one HEAD, never followed, allow-listed targets only),
 * document checks (HEAD, then a ranged GET of 1 KB), the wiki follow (≤ 3
 * pages, the deterministic table parser, never over a store value), and the
 * verification adapters that read the public answers.
 *
 * Run: node --import tsx --test tests/bambuImportEnrich.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageOf, fixtureJson } from './fixtures/bambu/load';
import { buildImportPayload, assertImportPayload, type ImportPayload } from '../packages/catalog/src/bambuImport/payload';
import { extractionFingerprint } from '../packages/catalog/src/bambuImport/fingerprint';
import type { CompatTargets } from '../packages/catalog/src/bambuImport/relations';
import { Deadline } from '../scripts/bambu-import/deadline';
import { HostFetcher, ImportStop } from '../scripts/bambu-import/fetch';
import { resolveTracker } from '../scripts/bambu-import/tracker';
import { wikiSpecRows } from '../scripts/bambu-import/wiki';
import { curatedGate, curatedWeight, enrich, mergeCurated } from '../scripts/bambu-import/enrich';
import { flattenTree, knowledgeFacts, resolveSection, siteFacts, isPublicSpec } from '../scripts/bambu-import/verify';

const T0 = Date.parse('2026-10-16T08:00:00.000Z');
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

function hosts(answer: (url: URL, init: RequestInit) => Response, opts: { deadlineIn?: number } = {}) {
  let t = T0;
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
  const seen: Array<{ url: string; method: string; redirect: string; range: string; at: number }> = [];
  const fetcher = new HostFetcher({
    fetch: async (url, init) => {
      const h = (init.headers ?? {}) as Record<string, string>;
      seen.push({ url, method: String(init.method), redirect: String(init.redirect), range: h.Range ?? '', at: t });
      return answer(new URL(url), init);
    },
    clock,
    deadline: new Deadline(T0 + (opts.deadlineIn ?? 330 * 60_000), clock),
    siteOrigin: 'https://levonis-iq.com',
  });
  return { fetcher, seen, clock };
}

function payloadOf(handle: 'filament-buffer' | 'ams-2-pro'): ImportPayload {
  const x = pageOf(handle).extraction;
  const row = handle === 'ams-2-pro' ? fixtureJson<Record<string, unknown>>('ams-2-pro.manifest-row.json') : null;
  return buildImportPayload({
    extraction: x,
    writeMode: 'create',
    extractionSha256: extractionFingerprint(x),
    manifestRow: row as never,
    targets: fixtureJson<CompatTargets>('compat-targets.json'),
    retrievedAt: '2026-10-16T08:00:00.000Z',
  }).payload;
}

test('tracker links: one HEAD, the redirect read and never followed; only allow-listed targets become documents', async () => {
  const { fetcher, seen } = hosts((u) => {
    const c = u.searchParams.get('c');
    if (c === 'wiki') return new Response(null, { status: 302, headers: { location: 'https://wiki.bambulab.com/en/ams-2-pro/feeder-install?utm_source=store' } });
    if (c === 'evil') return new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } });
    if (c === 'wall') return new Response(null, { status: 403 });
    if (c === 'cf') return new Response(null, { status: 200, headers: { 'cf-mitigated': 'challenge' } });
    return new Response(null, { status: 200 });
  });
  const go = (c: string) => resolveTracker(fetcher, { url: `https://e.bambulab.com/t?c=${c}`, text: 'Installation on Bambu Lab Wiki' }, 0);
  const wiki = await go('wiki');
  assert.equal(wiki.outcome, 'resolved');
  assert.equal(wiki.target, 'https://wiki.bambulab.com/en/ams-2-pro/feeder-install', 'the query of a kept link is dropped');
  assert.equal((await go('evil')).outcome, 'host_not_allowed');
  assert.equal((await go('wall')).outcome, 'challenge');
  assert.equal((await go('cf')).outcome, 'challenge');
  assert.equal((await go('plain')).outcome, 'no_redirect');
  assert.equal(seen.length, 5, 'one request per tracker, the target never requested');
  for (const r of seen) {
    assert.equal(r.method, 'HEAD');
    assert.equal(r.redirect, 'manual');
    assert.equal(new URL(r.url).host, 'e.bambulab.com');
  }
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].at - seen[i - 1].at >= 1000, 'tracker HEADs ≥ 1 s apart');
});

test('enrich: trackers become documents, CDN documents are checked (HEAD, then 1 KB), the wiki fills only what the store left empty', async () => {
  const payload = payloadOf('ams-2-pro');
  const firstKb = new Uint8Array(1024).fill(7);
  const wikiHtml = `<html><head><title>AMS 2 Pro feeder installation | Bambu Lab Wiki</title></head><body>
    <table><tr><th>Item</th><th>Value</th></tr>
      <tr><td>Material</td><td>PC-ABS</td></tr>
      <tr><td>Operating Temperature</td><td>10-35 °C</td></tr>
      <tr><td>Price</td><td>$19.99</td></tr>
    </table></body></html>`;
  const docs = payload.documents.filter((d) => d.host === 'store.bblcdn.com');
  assert.ok(docs.length >= 2);
  const dead = docs[1].url;
  const { fetcher, seen } = hosts((u, init) => {
    if (u.host === 'e.bambulab.com') return new Response(null, { status: 301, headers: { location: 'https://wiki.bambulab.com/en/ams-2-pro/feeder' } });
    if (u.host === 'wiki.bambulab.com') return new Response(wikiHtml, { status: 200, headers: { 'content-type': 'text/html' } });
    if (u.toString() === dead) return new Response(null, { status: 404 });
    if (init.method === 'HEAD') return new Response(null, { status: 405 });
    return new Response(firstKb, { status: 206, headers: { 'content-type': 'application/pdf', 'content-range': 'bytes 0-1023/88000' } });
  });
  payload.notes.push({ kind: 'tracker_unresolved', field: 'documents' });
  const before = JSON.stringify(payload);
  const r = await enrich(
    fetcher,
    { payload, productType: 'ams', trackerLinks: [{ url: 'https://e.bambulab.com/t?c=feeder', text: 'Installation of the AMS 2 Pro feeder unit on Bambu Lab Wiki', section: 'other', via: 'a' }], retrievedAt: '2026-10-16T08:00:00.000Z', curated: { kind: 'none' } },
    () => '2026-10-16T08:00:00.000Z'
  );
  assert.equal(JSON.stringify(payload), before, 'ENRICH works on a copy');
  assert.equal(r.report.trackers_resolved, 1);
  const wikiDoc = r.payload.documents.find((d) => d.host === 'wiki.bambulab.com')!;
  assert.equal(wikiDoc.kind, 'installation');
  assert.equal(r.payload.notes.filter((n) => n.kind === 'tracker_unresolved').length, 0, 'the resolved tracker is no longer reported unresolved');
  const trackerCheck = r.documentChecks.find((c) => c.document_id === wikiDoc.id)!;
  assert.equal(trackerCheck.tracker_source, 'https://e.bambulab.com/t?c=feeder');

  const cdn = r.documentChecks.filter((c) => r.payload.documents.find((d) => d.id === c.document_id)?.host === 'store.bblcdn.com');
  assert.equal(cdn.length, docs.length);
  const ok = cdn.find((c) => c.check_status === 206)!;
  assert.equal(ok.content_sha256, sha(firstKb));
  assert.equal(ok.byte_size, 88000);
  assert.equal(ok.content_type, 'application/pdf');
  assert.equal(cdn.find((c) => c.document_id === docs[1].id)!.check_status, 404, 'a dead link is recorded, never dropped');
  assert.equal(r.report.documents_dead, 1);
  assert.ok(seen.filter((s) => s.method === 'GET' && s.range === 'bytes=0-1023').length >= 1, 'the fallback is a ranged GET');

  // The wiki: a typed row for a key the store did not give, nothing from a money row, never over a store value.
  const wikiRows = r.payload.specs.filter((s) => s.source_kind === 'wiki');
  assert.ok(wikiRows.length >= 1, 'the wiki gave at least one free key');
  assert.equal(r.report.wiki_specs, wikiRows.length);
  assert.ok(wikiRows.every((s) => s.status === 'unverified' && s.confidence === 'official_page'));
  assert.ok(!JSON.stringify(wikiRows).includes('19.99'));
  for (const w of wikiRows) assert.ok(!payload.specs.some((s) => s.key === w.key && s.status !== 'not_found' && s.scope_kind === 'product'), `${w.key} was free`);
  assert.equal(r.report.wiki_parsed, 1);
  // The enriched payload still passes the allow-list.
  assert.doesNotThrow(() => assertImportPayload(JSON.parse(JSON.stringify(r.payload))));
});

test('enrich: a wait that does not fit before the deadline stops ENRICH (and nothing else does)', async () => {
  const payload = payloadOf('ams-2-pro');
  const { fetcher } = hosts(() => new Response(null, { status: 200 }), { deadlineIn: 5 * 60_000 });
  await assert.rejects(
    enrich(fetcher, { payload, productType: 'ams', trackerLinks: [], retrievedAt: '', curated: { kind: 'none' } }, () => ''),
    (e: unknown) => e instanceof ImportStop && e.kind === 'deadline'
  );
  const quick = hosts(() => {
    throw new Error('network down');
  });
  const r = await enrich(quick.fetcher, { payload, productType: 'ams', trackerLinks: [], retrievedAt: '', curated: { kind: 'none' } }, () => '');
  assert.ok(r.documentChecks.every((c) => c.check_status === 0), 'a failed check is recorded as unchecked; the product continues');
});

test('wiki tables: the deterministic parser, unverified, only registry keys, at most the free ones', () => {
  const html = `<title>Filament Buffer - Bambu Lab Wiki</title><table>
    <tr><td>Material</td><td>PC</td></tr><tr><td>Weight</td><td>120 g</td></tr><tr><td>Mystery label</td><td>42</td></tr>
    <tr><td>Warranty</td><td>The warranty covers defects</td></tr></table>`;
  const r = wikiSpecRows(html, { productId: 'p_x', productType: 'part', url: 'https://wiki.bambulab.com/en/x', retrievedAt: '', taken: new Set(['part.material']), sortFrom: 100 });
  assert.equal(r.title, 'Filament Buffer - Bambu Lab Wiki');
  assert.deepEqual(r.rows.map((x) => [x.key, x.value_num, x.unit, x.status, x.source_kind, x.sort]), [['product.net_weight', 120, 'g', 'unverified', 'wiki', 100]]);
  assert.match(r.rows[0].source_locator, /row 2$/);
});

test('curated: the gate (none, pending, mismatch, ok) and the merge by source rank, with every disagreement recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'levonis-curated-'));
  try {
    mkdirSync(join(dir, 'curated'));
    const body = JSON.stringify({ handle: 'filament-buffer', schema: 2, specs: [] });
    writeFileSync(join(dir, 'curated', 'filament-buffer.json'), body);
    assert.deepEqual(curatedGate(dir, 'filament-buffer', false, {}), { kind: 'none' });
    assert.deepEqual(curatedGate(dir, 'filament-buffer', true, {}), { kind: 'pending' });
    assert.deepEqual(curatedGate(dir, 'filament-buffer', true, { 'filament-buffer': '0'.repeat(64) }), { kind: 'mismatch' });
    const ok = curatedGate(dir, 'filament-buffer', true, { 'filament-buffer': sha(body) });
    assert.equal(ok.kind, 'ok');
    assert.deepEqual(curatedGate(dir, '../etc', true, { '../etc': sha(body) }), { kind: 'pending' }, 'a handle is never a path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const payload = payloadOf('filament-buffer');
  const page = payload.specs.find((s) => s.value_num !== null && s.scope_kind === 'product')!;
  const notFound = payload.specs.find((s) => s.status === 'not_found');
  const curated = {
    searched: [{ kind: 'manual', url: 'https://wiki.bambulab.com/en/x', title: 'Manual', keys: ['part.*', 'product.*'] }],
    specs: [
      { key: page.key, scope: { kind: 'product' }, value: (page.value_num ?? 0) + 1, unit: page.unit, status: 'verified', confidence: 'official_doc', source_kind: 'manual', locator: 'p.2', quote: 'q' },
      { key: 'part.max_temperature', scope: { kind: 'product' }, value: 60, unit: '°C', status: 'verified', confidence: 'independent', source_kind: 'curated', locator: 'x', quote: 'y' },
      { key: 'part.color', scope: { kind: 'variant', source_variant_id: 'no-such-variant' }, value: 'Black' },
    ],
    not_published: ['part.max_load'],
    documents: [{ url: 'https://store.bblcdn.com/manual.pdf', title: 'Filament Buffer Manual' }],
    hex: [{ value_text: 'Black', hex: '#000000' }],
  };
  const copy: ImportPayload = JSON.parse(JSON.stringify(payload));
  const report = mergeCurated(copy, curated, 'c'.repeat(64));
  assert.equal(copy.curated_sha256, 'c'.repeat(64));
  const merged = copy.specs.find((s) => s.id === page.id)!;
  assert.equal(merged.value_num, (page.value_num ?? 0) + 1, 'official_doc beats official_page');
  assert.equal(merged.source_kind, 'manual');
  assert.match(merged.conflict, /differs/);
  assert.ok(copy.notes.some((n) => n.kind === 'spec_sources_disagree' && n.field === page.key));
  assert.equal(report.conflicts, 1);
  assert.equal(report.skipped, 1, 'a scope the payload does not hold is skipped, never guessed');
  const np = copy.specs.find((s) => s.key === 'part.max_load')!;
  assert.equal(np.status, 'not_published');
  assert.equal(np.missing_reason, 'not_published_by_manufacturer');
  assert.equal(np.checked_sources[0].url, 'https://wiki.bambulab.com/en/x');
  if (notFound) assert.ok(copy.specs.find((s) => s.id === notFound.id)!.checked_sources.some((c) => c.url === 'https://wiki.bambulab.com/en/x'));
  assert.equal(report.documents, 1);
  assert.equal(report.not_applied, 1, 'a published hex has no payload field yet: counted, not applied');
  assert.doesNotThrow(() => assertImportPayload(JSON.parse(JSON.stringify(copy))));
});

test('verification adapters: the knowledge answer of §G.1, publicRelations, the tree and the taxonomy references', () => {
  const k = knowledgeFacts({
    specs: [{ group: 'printing', rows: [{ key: 'printing.speed', scope: { kind: 'product', id: '' }, region: '', status: 'verified', unit: 'mm/s', value_num: 500 }] }],
    logistics: { package: [{ key: 'package.weight', scope: { kind: 'option_value', id: 'ov_1' }, region: 'us_110v', status: 'unverified', unit: 'g', value_num: 900 }], product: [], shipment: [], carton: [] },
    in_the_box: [{ text: 'Tool', scope: { kind: 'product', id: '' } }, { text: 'Cable', scope: { kind: 'product', id: '' } }],
    compatibility: { compatible: [{ relation: 'compatible_with', label: 'A1', state: 'pending', scope: { kind: 'product', id: '' } }], requires: [], related: [], not_compatible: [] },
    documents: [{ kind: 'manual', url: 'https://wiki.bambulab.com/en/x' }],
    swatches: [{ option_value_id: 'ov_1', url: '/files/s.webp' }],
  });
  assert.deepEqual(k.specsByStatus, { verified: 1, unverified: 1 });
  assert.deepEqual(k.specsByRegion, { us_110v: 1 });
  assert.equal(k.inTheBox, 2);
  assert.equal(k.relations[0].label, 'A1');
  assert.equal(k.relations[0].target, '', 'targets are not compared: the answer names them only while visible');
  const sf = siteFacts({ option_groups: [{ id: 'og', sort: 0, name_en: 'Colour', default_value_id: 'ov', values: [{ id: 'ov', sort: 0, swatch: { url: '/files/s.webp' } }] }], variants: [{ id: 'pv', combo_key: 'o:ov' }], images: [{ id: 'pi', url: '/files/a.webp', is_primary: true, option_value_id: 'ov', variant_id: null }] });
  assert.equal(sf.groups[0].values[0].swatch, '/files/s.webp');
  assert.equal(sf.images[0].option_value_id, 'ov');
  const tree = flattenTree({ roots: [{ id: 'cat_maint', slug: 'maintenance', children: [{ id: 'cat_maint_spare', slug: 'spare-parts', children: [{ id: 'cat_new', slug: 'x1-p1-series-parts-2', name_en: 'X1 & P1 series parts', product_count: 3 }] }] }] });
  const taxonomy = { create: [{ key: 'parts-x1p1', parent: 'cat_maint_spare', slug: 'x1-p1-series-parts', name_en: 'X1 & P1 series parts' }] };
  assert.equal(resolveSection('@parts-x1p1', taxonomy, tree)?.slug, 'x1-p1-series-parts-2', 'a new node whose slug got a -2 is still found');
  assert.equal(resolveSection('cat_maint_spare', taxonomy, tree)?.slug, 'spare-parts');
  assert.equal(resolveSection('@nope', taxonomy, tree), null);
  assert.equal(isPublicSpec({ key: 'package.volume_m3', group: 'logistics', visibility: 'public' }), false, 'CBM never reaches customers');
  assert.equal(isPublicSpec({ key: 'manufacturer_terms.warranty_note', group: 'manufacturer_terms', visibility: 'public' }), false);
  assert.equal(isPublicSpec({ key: 'printing.speed', group: 'printing', visibility: 'owner' }), false);
});

test('curated weights are written the way the package writes every weight: grams in value_num, the text as published', () => {
  // The package's own rows (specs.ts publishedWeight): «31 kg» → 31000 g, text «31 kg».
  assert.deepEqual(curatedWeight(31, 'kg', 'Net Weight 31 kg'), { grams: 31000, text: '31 kg' });
  // The quote states the same weight in its own unit: the text is the quote's («1 kg» for 1000 g).
  assert.deepEqual(curatedWeight(1000, 'g', 'Net weight: 1 kg'), { grams: 1000, text: '1 kg' });
  // The quote says nothing of it: the curated value in its own unit.
  assert.deepEqual(curatedWeight(500, 'g', 'Spool weight'), { grams: 500, text: '500 g' });
  assert.equal(curatedWeight(3, 'MPa', ''), null, 'not a weight');

  const payload = payloadOf('filament-buffer');
  const copy: ImportPayload = JSON.parse(JSON.stringify(payload));
  mergeCurated(
    copy,
    {
      specs: [
        { key: 'product.net_weight', scope: { kind: 'product' }, value: 0.12, unit: 'kg', status: 'verified', confidence: 'official_doc', source_kind: 'manual', locator: 'p.3', quote: 'Net weight 120 g' },
        { key: 'package.weight', scope: { kind: 'product' }, value: 0.2, unit: 'kg', status: 'verified', confidence: 'official_doc', source_kind: 'manual', locator: 'p.3', quote: 'Package 0.2 kg' },
      ],
    },
    'c'.repeat(64)
  );
  const net = copy.specs.find((s) => s.key === 'product.net_weight' && s.scope_kind === 'product' && s.region === '')!;
  assert.deepEqual([net.value_num, net.unit, net.value_text], [120, 'g', '120 g'], 'grams, and the quote\'s own words');
  const pack = copy.specs.find((s) => s.key === 'package.weight' && s.scope_kind === 'product' && s.region === '')!;
  assert.deepEqual([pack.value_num, pack.unit, pack.value_text], [200, 'g', '0.2 kg'], 'never «0.2 kg» stored as 0.2 g, never «200 g» for a published «0.2 kg»');
  assert.doesNotThrow(() => assertImportPayload(JSON.parse(JSON.stringify(copy))));
});
