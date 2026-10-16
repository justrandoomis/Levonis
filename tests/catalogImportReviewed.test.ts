/**
 * THE REVIEWED SCOPE THE WORKER ENFORCES (Bambu import spec §A.3, §B.6, §C.1,
 * §C.4, §D.2, §E.1; worker/lib/catalogImport/reviewed.ts).
 *
 *   - the committed P0 drafts parse (manifest, taxonomy map, compat targets,
 *     identity map, media overrides, search synonyms), and so do the empty,
 *     inert placeholders step 6b bundles;
 *   - a malformed file is refused naming the file and the JSON path; an
 *     existing-matches entry with a key the file may not hold (a free-text note)
 *     is refused (§A.8); a ckb text that copies the Arabic is refused (row 183);
 *   - the gate of §A.3/§E.1, as a pure function: a merge not listed, a create
 *     for a source listed merge / merge_publish / hold_owner_hidden, a merge into
 *     another product, an unlisted source, a manifest hold, a curated product
 *     without its file, identity rows the map does not give, an override the file
 *     does not name and a relation target the compat file does not name are each
 *     refused with their blocker code; a create for a source listed not_bambu or
 *     distinct is never refused;
 *   - taxonomy: handle override → deepest route prefix → none; secondaries from
 *     the route and the evidence-backed entries; '@key' nodes as their catalog ids.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { fixtureJson, sample } from './fixtures/bambu/load';
import { manifestRowOf } from './fixtures/catalogImportWorld';
import { buildImportPayload, type ImportPayload } from '../packages/catalog/src/bambuImport/payload';
import type { CompatTargets } from '../packages/catalog/src/bambuImport/relations';
import {
  checkReviewedScope,
  emptyReviewedTexts,
  newProductIdOf,
  parseReviewedBundle,
  resolveTaxonomy,
  reviewedBundleDigest,
  reviewedFileSha256,
  reviewedTargets,
  ReviewedBundleInvalid,
  REVIEWED_FILES,
  taxonomyNodeId,
  type ReviewedTexts,
} from '../worker/lib/catalogImport/reviewed';

const P0 = join(ROOT, 'docs', 'bambu-import', 'p0');
const p0 = (f: string) => readFileSync(join(P0, f), 'utf8');

function draftTexts(): ReviewedTexts {
  return {
    ...emptyReviewedTexts(),
    manifest: p0('manifest.json'),
    taxonomyMap: p0('taxonomy-map.json'),
    compatTargets: p0('compat-targets.json'),
    identityMap: p0('identity-map.json'),
    mediaOverrides: p0('media-overrides.json'),
    searchSynonyms: p0('search-synonyms.json'),
  };
}

test('the committed P0 drafts parse, and the empty placeholders are a valid, inert bundle', () => {
  const b = parseReviewedBundle(draftTexts());
  assert.equal(b.manifest.rows.length, 1115);
  assert.ok(b.manifest.byHandle.has('pla-basic-filament'));
  assert.ok(b.taxonomy.create.length > 0 && Object.keys(b.taxonomy.routes).length > 0);
  assert.ok(b.identity.get('h2d')?.model);
  assert.ok(b.synonyms.length > 0);
  for (const k of Object.keys(REVIEWED_FILES) as Array<keyof typeof REVIEWED_FILES>) assert.match(b.sha256[k], /^[0-9a-f]{64}$/);
  assert.equal(b.sha256.manifest, createHash('sha256').update(p0('manifest.json')).digest('hex'), 'the SHA-256 of the exact text /hello answers');
  assert.match(b.bundleSha256, /^[0-9a-f]{64}$/);
  assert.equal(parseReviewedBundle(draftTexts()).bundleSha256, b.bundleSha256, 'the combined digest is stable');

  const empty = parseReviewedBundle(emptyReviewedTexts());
  assert.equal(empty.manifest.rows.length, 0);
  assert.notEqual(empty.bundleSha256, b.bundleSha256);
  const x = sample('ams-2-pro-feeder-unit');
  const payload = buildImportPayload({ extraction: x, writeMode: 'create', extractionSha256: 'x', targets: null, retrievedAt: 't' }).payload;
  const v = checkReviewedScope(empty, payload);
  assert.ok(!v.ok && v.refusal.code === 'REVIEWED_SCOPE_REFUSED' && v.refusal.reason === 'source_not_in_manifest', 'an empty manifest refuses every source');
});

test('a malformed file is refused with the file and the JSON path, never half-read', () => {
  const cases: Array<[Partial<ReviewedTexts>, string, RegExp]> = [
    [{ manifest: '{' }, 'manifest.json', /^\$$/],
    [{ manifest: JSON.stringify({ version: 1, source: 'bambu_us', rows: [{ source_product_id: 'x', handle: 'a', queue_position: 1, canonical_url: 'https://a', type: 't' }] }) }, 'manifest.json', /source_product_id/],
    [{ manifest: JSON.stringify({ version: 2, source: 'bambu_us', rows: [] }) }, 'manifest.json', /version/],
    [{ taxonomyMap: JSON.stringify({ version: 1, create: [], routes: { '1>2': { primary: '@nowhere' } } }) }, 'taxonomy-map.json', /primary/],
    [{ existingMatches: JSON.stringify({ version: 1, entries: [{ source_product_id: '1', decision: 'merge' }] }) }, 'existing-matches.json', /source_handle/],
    [{ existingMatches: JSON.stringify({ version: 1, entries: [{ source_product_id: '1', source_handle: 'a', levonis_product_id: 'p', decision: 'merge_publish', reason: 'same_model', reviewed_by: 'r', reviewed_at: 'd' }] }) }, 'existing-matches.json', /approval_ref/],
    [{ mediaOverrides: JSON.stringify({ version: 1, overrides: [{ resource_file_id: 'f', value_ids: ['v'] }] }) }, 'media-overrides.json', /resource_file_id/],
    [{ mediaOverrides: JSON.stringify({ version: 1, overrides: [{ resourceFileId: 'f' }] }) }, 'media-overrides.json', /overrides\[0\]$/],
  ];
  for (const [over, file, path] of cases) {
    assert.throws(
      () => parseReviewedBundle({ ...emptyReviewedTexts(), ...over }),
      (e: unknown) => e instanceof ReviewedBundleInvalid && e.file === file && path.test(e.path),
      `${file} ${path}`
    );
  }
  assert.throws(() => parseReviewedBundle({ ...emptyReviewedTexts(), searchSynonyms: undefined as never }), ReviewedBundleInvalid);
});

test('a source id is a JSON string, never a number (a bare 18-digit id is already rounded); curated is a boolean; a source id appears once', () => {
  const row = { source_product_id: '581025672328126464', handle: 'a', queue_position: 1, canonical_url: 'https://a', type: 't' };
  const entry = { source_product_id: '581025672328126464', source_handle: 'a', levonis_product_id: 'p_x', decision: 'hold_owner_hidden', reason: 'same_model', reviewed_by: 'r', reviewed_at: 'd' };
  const manifest = (rows: unknown[]) => JSON.stringify({ version: 1, source: 'bambu_us', rows });
  const matches = (entries: unknown[]) => JSON.stringify({ version: 1, entries });
  // The control: quoted, as every draft writes them.
  const ok = parseReviewedBundle({ ...emptyReviewedTexts(), manifest: manifest([row]), existingMatches: matches([entry]) });
  assert.ok(ok.matches.bySourceId.has('581025672328126464'));
  // The same files with the id unquoted: JSON.parse reads 581025672328126500, so nothing may be keyed by it.
  const bare = (text: string) => text.replace('"581025672328126464"', '581025672328126464');
  const cases: Array<[Partial<ReviewedTexts>, string, string]> = [
    [{ manifest: bare(manifest([row])) }, 'manifest.json', '$.rows[0].source_product_id'],
    [{ existingMatches: bare(matches([entry])) }, 'existing-matches.json', '$.entries[0].source_product_id'],
    [{ existingMatches: matches([{ ...entry, unmapped_variants: ['1'] }]).replace('["1"]', '[776210262809161737]') }, 'existing-matches.json', '$.entries[0].unmapped_variants[0]'],
    [{ manifest: manifest([{ ...row, curated: 'true' }]) }, 'manifest.json', '$.rows[0].curated'],
    [{ manifest: manifest([row, { ...row, handle: 'b', queue_position: 2 }]) }, 'manifest.json', '$.rows[1].source_product_id'],
    [{ existingMatches: matches([entry, { ...entry }]) }, 'existing-matches.json', '$.entries[1].source_product_id'],
  ];
  for (const [over, file, path] of cases) {
    assert.throws(
      () => parseReviewedBundle({ ...emptyReviewedTexts(), ...over }),
      (e: unknown) => e instanceof ReviewedBundleInvalid && e.file === file && e.path === path,
      `${file} ${path}`
    );
  }
  assert.equal(parseReviewedBundle({ ...emptyReviewedTexts(), manifest: manifest([{ ...row, curated: true }]) }).manifest.rows[0].curated, true);
});

test('the runner\'s spellings: the combined digest, the curated index shapes and the override entries read alike on both sides', () => {
  // scripts/bambu-import/discover.ts `bundleDigest`: SHA-256 over "<file> <sha256>\n", the files sorted by name.
  const b = parseReviewedBundle(emptyReviewedTexts());
  const byFile = reviewedFileSha256(b.sha256);
  assert.deepEqual(Object.keys(byFile).sort(), Object.values(REVIEWED_FILES).slice().sort());
  const lines = Object.keys(byFile).sort().map((f) => `${f} ${byFile[f]}\n`).join('');
  assert.equal(b.bundleSha256, createHash('sha256').update(lines).digest('hex'));
  assert.equal(reviewedBundleDigest(byFile), b.bundleSha256);
  // curated/index.json: {files}, {entries} or a plain map; a value that is not a digest names no file.
  const sha = 'a'.repeat(64);
  for (const text of [{ files: { h: sha } }, { version: 1, entries: { h: { sha256: sha } } }, { h: sha, x: 'not-a-sha' }]) {
    const c = parseReviewedBundle({ ...emptyReviewedTexts(), curatedIndex: JSON.stringify(text) }).curated;
    assert.equal(c.get('h'), sha);
    assert.equal(c.has('x'), false);
  }
  // media-overrides.json: the package's MediaOverride spelling, a handle optional.
  const o = parseReviewedBundle({ ...emptyReviewedTexts(), mediaOverrides: JSON.stringify({ version: 1, overrides: [{ resourceFileId: 'f1', valueIds: ['ov_1'] }] }) }).overrides;
  assert.deepEqual(o, [{ handle: '', resource_file_id: 'f1', value_ids: ['ov_1'], variant_ids: [], reviewed_by: '', reason: '' }]);
});

test('existing-matches.json may hold ids, a public slug, a decision and a reason code — never a note (§A.8)', () => {
  const entry = { source_product_id: '7706060161160', source_handle: 'a1', levonis_product_id: 'p_x', decision: 'merge', reason: 'same_model', reviewed_by: 'r', reviewed_at: '2026-10-15' };
  assert.doesNotThrow(() => parseReviewedBundle({ ...emptyReviewedTexts(), existingMatches: JSON.stringify({ version: 1, entries: [entry] }) }));
  for (const k of ['note', 'notes', 'stock', 'orders', 'name']) {
    assert.throws(
      () => parseReviewedBundle({ ...emptyReviewedTexts(), existingMatches: JSON.stringify({ version: 1, entries: [{ ...entry, [k]: 'x' }] }) }),
      (e: unknown) => e instanceof ReviewedBundleInvalid && e.path === `$.entries[0].${k}`
    );
  }
  assert.throws(
    () => parseReviewedBundle({ ...emptyReviewedTexts(), existingMatches: JSON.stringify({ version: 1, entries: [{ ...entry, reason: 'looks the same' }] }) }),
    ReviewedBundleInvalid,
    'a reason is a code from the fixed list'
  );
});

test('a Sorani text that copies the Arabic is refused (DECISIONS row 183)', () => {
  const node = { key: 'pla', parent: 'cat_materials_fdm', slug: 'pla', name_en: 'PLA', name_ar: 'خيوط PLA', name_ckb: 'خيوط PLA', template_family: 'materials' };
  assert.throws(
    () => parseReviewedBundle({ ...emptyReviewedTexts(), taxonomyMap: JSON.stringify({ version: 1, create: [node], routes: {} }) }),
    (e: unknown) => e instanceof ReviewedBundleInvalid && /name_ckb/.test(e.path)
  );
  // Identical Latin text is not a copy of the Arabic.
  assert.doesNotThrow(() =>
    parseReviewedBundle({ ...emptyReviewedTexts(), taxonomyMap: JSON.stringify({ version: 1, create: [{ ...node, name_ar: 'PLA', name_ckb: 'PLA' }], routes: {} }) })
  );
});

test('taxonomy: handle override, then the deepest route prefix, then nothing; secondaries from the route and the evidence', () => {
  const map = parseReviewedBundle(draftTexts()).taxonomy;
  const pla = sample('pla-basic-filament');
  const r = resolveTaxonomy(map, pla.handle, pla.route)!;
  assert.equal(r.primary, taxonomyNodeId('pla'), "'@pla' is the node prepare-taxonomy creates");
  assert.equal(r.via, 'route');
  assert.equal(resolveTaxonomy(map, 'not-a-handle', '1>2>3'), null, 'no route and no override: TAXONOMY_UNMAPPED');
  // A deeper unknown segment still resolves through its listed prefix.
  assert.equal(resolveTaxonomy(map, 'not-a-handle', `${pla.route}>999`)!.primary, r.primary);
  const refurb = resolveTaxonomy(map, 'refurbished-bambu-lab-h2d-3d-printer', sample('refurbished-bambu-lab-h2d-3d-printer').route)!;
  assert.equal(refurb.via, 'handle');
  assert.equal(refurb.primary, taxonomyNodeId('printers-refurb'));
  const fibre = Object.entries(map.routes).find(([, v]) => v.also?.length)!;
  const viaRoute = resolveTaxonomy(map, 'some-cf-filament', fibre[0])!;
  assert.deepEqual(viaRoute.secondaries, fibre[1].also!.map(taxonomyNodeId));
  const [handle, also] = Object.entries(map.also_by_handle)[0];
  const row = parseReviewedBundle(draftTexts()).manifest.byHandle.get(handle)!;
  const withAlso = resolveTaxonomy(map, handle, row.currentAllIdRoute)!;
  for (const e of also) assert.ok(withAlso.secondaries.includes(e.also.startsWith('@') ? taxonomyNodeId(e.also) : e.also));
  assert.ok(!withAlso.secondaries.includes(withAlso.primary));
});

// ---------------------------------------------------------------- the gate

const targets = fixtureJson<CompatTargets>('compat-targets.json');

function gateWorld(matches: unknown[] = [], extra: Partial<ReviewedTexts> = {}) {
  const x = sample('ams-2-pro-feeder-unit');
  const row = manifestRowOf(x, 1);
  const texts: ReviewedTexts = {
    ...emptyReviewedTexts(),
    manifest: JSON.stringify({ version: 1, source: 'bambu_us', rows: [row] }),
    taxonomyMap: p0('taxonomy-map.json'),
    compatTargets: JSON.stringify(targets),
    existingMatches: JSON.stringify({ version: 1, entries: matches }),
    ...extra,
  };
  const payload = (mode: 'create' | 'merge' = 'create', merge?: string): ImportPayload =>
    buildImportPayload({ extraction: x, writeMode: mode, mergeProductId: merge, extractionSha256: 'x', manifestRow: row as never, targets, retrievedAt: 't' }).payload;
  return { x, row, bundle: parseReviewedBundle(texts), payload, texts };
}

const match = (x: { sourceProductId: string; handle: string }, decision: string, extra: Record<string, unknown> = {}) => ({
  source_product_id: x.sourceProductId,
  source_handle: x.handle,
  levonis_product_id: 'p_existing',
  decision,
  reason: decision === 'not_bambu' ? 'not_bambu_product' : 'same_model',
  reviewed_by: 'r',
  reviewed_at: '2026-10-15',
  ...extra,
});

const refusal = (v: ReturnType<typeof checkReviewedScope>) => (v.ok ? 'ok' : `${v.refusal.code}:${v.refusal.reason}`);

test('§E.1: a merge must be listed (into that very product); a create is refused for a merge, merge_publish or hold source', () => {
  const x = sample('ams-2-pro-feeder-unit');
  // Unlisted source: a create passes under its deterministic id; a merge is refused.
  let w = gateWorld();
  assert.equal(refusal(checkReviewedScope(w.bundle, w.payload('create'))), 'ok');
  assert.equal(w.payload('create').product_id, newProductIdOf(x.sourceProductId));
  assert.equal(refusal(checkReviewedScope(w.bundle, w.payload('merge', 'p_existing'))), 'REVIEWED_SCOPE_REFUSED:merge_not_listed');
  // Listed merge: the merge into the named product passes, into another is refused, a create is refused.
  w = gateWorld([match(x, 'merge')]);
  assert.equal(refusal(checkReviewedScope(w.bundle, w.payload('merge', 'p_existing'))), 'ok');
  assert.equal(refusal(checkReviewedScope(w.bundle, w.payload('merge', 'p_other'))), 'REVIEWED_SCOPE_REFUSED:merge_target_not_listed');
  assert.equal(refusal(checkReviewedScope(w.bundle, w.payload('create'))), 'REVIEWED_SCOPE_REFUSED:create_for_listed_merge');
  w = gateWorld([match(x, 'merge_publish', { approval_ref: 'DECISIONS row 242' })]);
  assert.equal(refusal(checkReviewedScope(w.bundle, w.payload('merge', 'p_existing'))), 'ok');
  assert.equal(refusal(checkReviewedScope(w.bundle, w.payload('create'))), 'REVIEWED_SCOPE_REFUSED:create_for_listed_merge');
  w = gateWorld([match(x, 'hold_owner_hidden')]);
  assert.equal(refusal(checkReviewedScope(w.bundle, w.payload('create'))), 'OWNER_HIDDEN:match_hold_owner_hidden');
  assert.equal(refusal(checkReviewedScope(w.bundle, w.payload('merge', 'p_existing'))), 'REVIEWED_SCOPE_REFUSED:merge_not_listed');
  // not_bambu and distinct: the source is created, never refused.
  for (const d of ['not_bambu', 'distinct']) {
    w = gateWorld([match(x, d)]);
    assert.equal(refusal(checkReviewedScope(w.bundle, w.payload('create'))), 'ok', d);
    assert.equal(refusal(checkReviewedScope(w.bundle, w.payload('merge', 'p_existing'))), 'REVIEWED_SCOPE_REFUSED:merge_not_listed', d);
  }
});

test('the manifest decides the source and its holds; a created product only under its deterministic id', () => {
  const w = gateWorld();
  const p = w.payload();
  assert.equal(refusal(checkReviewedScope(w.bundle, { ...p, source_product_id: '999' })), 'REVIEWED_SCOPE_REFUSED:source_not_in_manifest');
  assert.equal(refusal(checkReviewedScope(w.bundle, { ...p, handle: 'another-handle' })), 'REVIEWED_SCOPE_REFUSED:handle_differs_from_manifest');
  assert.equal(refusal(checkReviewedScope(w.bundle, { ...p, product_id: 'p_somebody_else' })), 'REVIEWED_SCOPE_REFUSED:create_id_not_deterministic');
  for (const hold of ['OWNER_HIDDEN', 'ORDER_TYPE_WORD']) {
    const held = parseReviewedBundle({ ...w.texts, manifest: JSON.stringify({ version: 1, source: 'bambu_us', rows: [{ ...w.row, hold_code: hold }] }) });
    assert.equal(refusal(checkReviewedScope(held, p)), `${hold}:manifest_hold`);
  }
  const curated = parseReviewedBundle({ ...w.texts, manifest: JSON.stringify({ version: 1, source: 'bambu_us', rows: [{ ...w.row, curated: true }] }) });
  assert.equal(refusal(checkReviewedScope(curated, p)), 'CURATION_MISSING:curated_file_not_bundled');
  const sha = 'a'.repeat(64);
  const withFile = parseReviewedBundle({ ...w.texts, manifest: JSON.stringify({ version: 1, source: 'bambu_us', rows: [{ ...w.row, curated: true }] }), curatedIndex: JSON.stringify({ version: 1, entries: { [p.handle]: sha } }) });
  assert.equal(refusal(checkReviewedScope(withFile, p)), 'REVIEWED_SCOPE_REFUSED:curated_sha256_differs');
  assert.equal(refusal(checkReviewedScope(withFile, { ...p, curated_sha256: sha })), 'ok');
});

test('identity rows, override bindings and relation targets come from the reviewed files only', () => {
  const w = gateWorld();
  const p = w.payload();
  // Identity (§C.1): a model the identity map does not give is refused.
  const spec = { ...p.specs[0], id: 'sv_x', key: 'identity.model', group: 'identity', value_text: 'X9 Ultra' };
  assert.equal(refusal(checkReviewedScope(w.bundle, { ...p, specs: [...p.specs, spec] })), 'REVIEWED_SCOPE_REFUSED:identity_model_not_reviewed');
  const withIdentity = parseReviewedBundle({ ...w.texts, identityMap: JSON.stringify({ version: 1, entries: { [p.handle]: { model: 'X9 Ultra' } } }) });
  assert.equal(refusal(checkReviewedScope(withIdentity, { ...p, specs: [...p.specs, spec] })), 'ok');
  assert.equal(refusal(checkReviewedScope(withIdentity, p)), 'REVIEWED_SCOPE_REFUSED:identity_model_not_reviewed', 'a reviewed identity must be written');
  // Overrides (§C.4).
  const img = { ...p.images[1], binding_rule: 'reviewed_override', option_value_id: p.groups[0].values[0].id };
  assert.equal(refusal(checkReviewedScope(w.bundle, { ...p, images: [p.images[0], img] })), 'REVIEWED_SCOPE_REFUSED:override_not_reviewed');
  const withOverride = parseReviewedBundle({
    ...w.texts,
    mediaOverrides: JSON.stringify({ version: 1, overrides: [{ handle: p.handle, resourceFileId: img.source_media_id, valueIds: [img.option_value_id], reviewed_by: 'r', reason: 'bundle_content' }] }),
  });
  assert.equal(refusal(checkReviewedScope(withOverride, { ...p, images: [p.images[0], img] })), 'ok');
  // Relations (§B.6): a resolved target the compat file does not name; a pending handle it does not name.
  const rel = { ...p.relations[0], state: 'resolved' as const, target_product_id: 'p_not_reviewed', target_source: '' as const, target_source_handle: '' };
  assert.equal(refusal(checkReviewedScope(w.bundle, { ...p, relations: [rel] })), 'REVIEWED_SCOPE_REFUSED:relation_target_not_reviewed');
  const pending = { ...p.relations[0], state: 'pending' as const, target_product_id: null, target_source: 'bambu_us' as const, target_source_handle: 'not-in-the-file' };
  assert.equal(refusal(checkReviewedScope(w.bundle, { ...p, relations: [pending] })), 'REVIEWED_SCOPE_REFUSED:relation_pending_on_unreviewed_handle');
  const t = reviewedTargets(targets);
  assert.ok(t.handles.has('ams-2-pro') && t.handles.size > 20);
  // Taxonomy last.
  assert.equal(refusal(checkReviewedScope(w.bundle, { ...p, route: '1>2>3' })), 'TAXONOMY_UNMAPPED:no_route_or_handle_entry');
});
