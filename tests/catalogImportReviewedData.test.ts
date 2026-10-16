/**
 * THE COMMITTED REVIEWED FILES, READ BY THE WORKER'S OWN PARSER (Bambu import
 * spec §A.3, §A.8, §B.6, §D.2, §E.1; HANDOFF-PLAN §3.5, P0 step 3 e).
 *
 * data/bambu-import/existing-matches.json, compat-targets.json and
 * taxonomy-map.json were reviewed against the sealed live snapshot (workflow 60
 * run 38863823810, 2026-10-16). The snapshot is private and never in the
 * repository, so these tests read only the committed files:
 *
 *   - the eight bundled texts parse with `parseReviewedBundle` exactly as the
 *     Worker bundles them (and the runner's reader takes the same files and
 *     answers the same write modes, when its file is present);
 *   - the matches file holds ids, a public slug, a decision, a reason code and,
 *     for a merge, the value map — and nothing for an owner-hidden target but
 *     its id (§A.8: no slug, no option ids of a non-active product);
 *   - through the gate (`checkReviewedScope`) with the reviewed P0 manifest: a
 *     merge only into its listed product, a create refused for every listed
 *     merge and hold;
 *   - the compat file names no unresolved snapshot member any more, and the
 *     taxonomy map places every manifest row on its reviewed leaf, its new
 *     nodes as `cat_bi_<key>`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './fixtures/d1';
import { page } from './fixtures/bambu/load';
import { buildImportPayload, type ImportPayload } from '../packages/catalog/src/bambuImport/payload';
import type { CompatTargets } from '../packages/catalog/src/bambuImport/relations';
import {
  catalogIdOf,
  checkReviewedScope,
  MATCH_DECISIONS,
  MATCH_REASONS,
  parseReviewedBundle,
  REVIEWED_FILES,
  reviewedTargets,
  taxonomyNodeId,
  taxonomyOfRow,
  type ReviewedFileKey,
  type ReviewedTexts,
} from '../worker/lib/catalogImport/reviewed';

const DATA = join(ROOT, 'data', 'bambu-import');
const P0 = join(ROOT, 'docs', 'bambu-import', 'p0');
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');

/** The eight files exactly as the Worker bundles them (wrangler Text modules: the file's bytes). */
function committedTexts(): ReviewedTexts {
  const out = {} as ReviewedTexts;
  for (const k of Object.keys(REVIEWED_FILES) as ReviewedFileKey[]) out[k] = read(DATA, REVIEWED_FILES[k]);
  return out;
}
/** The committed files with the reviewed P0 manifest (step 9 copies it to data/; the gate needs its rows). */
const withP0Manifest = (): ReviewedTexts => ({ ...committedTexts(), manifest: read(P0, 'manifest.json') });

/** The sealed snapshot all three files were reviewed against (workflow 60 run 38863823810). */
const SNAPSHOT_SHA256 = '1215895671756da4011dbdc1f310f95f4543d8d0ad9b0b71f1deb3928557ef8c';
const ENTRY_KEYS = ['source_product_id', 'source_handle', 'levonis_product_id', 'levonis_slug', 'decision', 'value_map', 'unmapped_variants', 'reason', 'reviewed_by', 'reviewed_at', 'approval_ref'];

test('the committed reviewed files parse with the Worker\'s own parser, byte for byte, and name the sealed snapshot they were reviewed against', () => {
  const texts = committedTexts();
  const b = parseReviewedBundle(texts);
  for (const k of Object.keys(REVIEWED_FILES) as ReviewedFileKey[]) {
    assert.equal(b.sha256[k], createHash('sha256').update(texts[k]).digest('hex'), `${REVIEWED_FILES[k]}: /hello answers the SHA-256 of the exact bytes`);
  }
  assert.equal(b.matches.entries.length, 35);
  const byDecision: Record<string, number> = {};
  for (const e of b.matches.entries) byDecision[e.decision] = (byDecision[e.decision] ?? 0) + 1;
  assert.deepEqual(byDecision, { merge: 21, hold_owner_hidden: 14 });
  // The 21 merges account for 239 source variants: 174 mapped by exact names (or the Bambu colour code), 65 not.
  const merges = b.matches.entries.filter((e) => e.decision === 'merge');
  assert.equal(merges.reduce((n, e) => n + Object.keys(e.value_map).length, 0), 174);
  assert.equal(merges.reduce((n, e) => n + e.unmapped_variants.length, 0), 65);
  assert.equal(b.taxonomy.snapshot_sha256, SNAPSHOT_SHA256);
  for (const f of ['existing-matches.json', 'compat-targets.json', 'taxonomy-map.json']) {
    assert.equal((JSON.parse(read(DATA, f)) as { snapshot_sha256?: string }).snapshot_sha256, SNAPSHOT_SHA256, f);
  }
  // The manifest in data/ is still the inert placeholder: the Worker refuses every source until step 9.
  assert.equal(b.manifest.rows.length, 0);
});

test('§A.8 / §E.1: an entry holds ids, a public slug, a decision and a reason code — an owner-hidden target only its id', () => {
  const raw = JSON.parse(read(DATA, 'existing-matches.json')) as { entries: Array<Record<string, unknown>> };
  const { matches } = parseReviewedBundle(committedTexts());
  const sources = new Set<string>();
  for (const [i, e] of raw.entries.entries()) {
    const at = `entry ${i} (${String(e.source_handle)})`;
    for (const k of Object.keys(e)) assert.ok(ENTRY_KEYS.includes(k), `${at}: key ${k}`);
    assert.match(String(e.levonis_product_id), /^prd_[0-9a-f]{20}$/, at);
    assert.ok((MATCH_DECISIONS as readonly string[]).includes(String(e.decision)), at);
    assert.ok((MATCH_REASONS as readonly string[]).includes(String(e.reason)), at);
    assert.ok(!sources.has(String(e.source_product_id)), `${at}: one entry per source`);
    sources.add(String(e.source_product_id));
    if (e.decision === 'merge') {
      // An active target: its public slug and the value map (active option values and colours only).
      assert.match(String(e.levonis_slug), /^[a-z0-9][a-z0-9-]*$/, at);
      const m = matches.bySourceId.get(String(e.source_product_id))!;
      const mapped = Object.keys(m.value_map);
      assert.ok(mapped.length + m.unmapped_variants.length > 0, `${at}: every source variant is accounted for`);
      for (const id of [...mapped, ...m.unmapped_variants]) assert.match(id, /^\d{1,24}$/, at);
      assert.equal(new Set([...mapped, ...m.unmapped_variants]).size, mapped.length + m.unmapped_variants.length, `${at}: mapped and unmapped are disjoint`);
    } else {
      // Owner-hidden (L-7): the id only — no slug, and no option value or colour id (they spell the hidden options).
      assert.equal(e.decision, 'hold_owner_hidden', at);
      for (const k of ['levonis_slug', 'value_map', 'unmapped_variants', 'approval_ref']) assert.ok(!(k in e), `${at}: no ${k}`);
    }
  }
});

test('the reviewed P0 manifest names every source, and the gate allows a merge only into its listed product and refuses every create of a listed source', () => {
  // Most matched sources are in the curated scope (§F, P0 step 3 g, not committed yet): a stand-in digest per curated
  // row lets the gate reach the existing-product rules for every one of them.
  const manifestRows = (JSON.parse(read(P0, 'manifest.json')) as { rows: Array<{ handle: string; curated?: boolean }> }).rows;
  const stand = (h: string) => createHash('sha256').update(`stand-in:${h}`).digest('hex');
  const curated = Object.fromEntries(manifestRows.filter((r) => r.curated).map((r) => [r.handle, stand(r.handle)]));
  const b = parseReviewedBundle({ ...withP0Manifest(), curatedIndex: JSON.stringify({ version: 1, files: curated }) });
  const counts = { merge_ok: 0, create_refused_merge: 0, create_refused_hold: 0, other_target_refused: 0 };
  for (const m of b.matches.entries) {
    const row = b.manifest.bySourceId.get(m.source_product_id);
    assert.ok(row, `${m.source_handle}: a manifest source`);
    assert.equal(row!.handle, m.source_handle);
    // A minimal payload: the gate's identity, override and relation checks see nothing to refuse.
    const payload = (write_mode: 'create' | 'merge', product_id: string) =>
      ({ source_product_id: m.source_product_id, handle: m.source_handle, write_mode, product_id, curated_sha256: curated[m.source_handle] ?? '', specs: [], images: [], relations: [], route: row!.currentAllIdRoute }) as unknown as ImportPayload;
    const create = checkReviewedScope(b, payload('create', `p_${'0'.repeat(24)}`));
    const other = checkReviewedScope(b, payload('merge', 'prd_00000000000000000000'));
    if (m.decision === 'merge') {
      const v = checkReviewedScope(b, payload('merge', m.levonis_product_id));
      assert.ok(v.ok && v.match === m && v.taxonomy.primary === catalogIdOf(row!.leaf), `${m.source_handle}: the listed merge passes and keeps its reviewed leaf`);
      counts.merge_ok++;
      assert.ok(!create.ok && create.refusal.reason === 'create_for_listed_merge', m.source_handle);
      counts.create_refused_merge++;
      assert.ok(!other.ok && other.refusal.reason === 'merge_target_not_listed', m.source_handle);
    } else {
      assert.ok(!create.ok && create.refusal.code === 'OWNER_HIDDEN' && create.refusal.reason === 'match_hold_owner_hidden', m.source_handle);
      counts.create_refused_hold++;
      assert.ok(!other.ok && other.refusal.reason === 'merge_not_listed', m.source_handle);
    }
    counts.other_target_refused++;
  }
  assert.deepEqual(counts, { merge_ok: 21, create_refused_merge: 21, create_refused_hold: 14, other_target_refused: 35 });
});

test("the runner's reader takes the same files: the same SHA-256 per file, the same combined digest and the same write mode per source", async (t) => {
  // scripts/bambu-import/discover.ts is the runner's (step 8, another lane until integrated): imported when present.
  const candidates = [process.env.LEVONIS_RUNNER_DISCOVER ?? '', join(ROOT, 'scripts/bambu-import/discover.ts')].filter(Boolean);
  const file = candidates.find((p) => existsSync(p));
  if (!file) {
    t.skip('the runner (scripts/bambu-import/discover.ts) is not in this tree; set LEVONIS_RUNNER_DISCOVER to its path');
    return;
  }
  const runner = (await import(pathToFileURL(file).href)) as {
    loadReviewedBundle(dir: string): { sha256: Record<string, string>; matches: Map<string, unknown> };
    bundleDigest(sums: Record<string, string>): string;
    writeModeOf(bundle: unknown, sid: string): { mode: string; productId?: string; publish?: boolean };
  };
  const ours = parseReviewedBundle(committedTexts());
  const theirs = runner.loadReviewedBundle(DATA);
  for (const k of Object.keys(REVIEWED_FILES) as ReviewedFileKey[]) assert.equal(theirs.sha256[REVIEWED_FILES[k]], ours.sha256[k], REVIEWED_FILES[k]);
  assert.equal(runner.bundleDigest(theirs.sha256), ours.bundleSha256);
  assert.equal(theirs.matches.size, ours.matches.entries.length);
  for (const m of ours.matches.entries) {
    const mode = runner.writeModeOf(theirs, m.source_product_id);
    if (m.decision === 'merge') assert.deepEqual(mode, { mode: 'merge', productId: m.levonis_product_id, publish: false }, m.source_handle);
    else assert.deepEqual(mode, { mode: 'hold' }, m.source_handle);
  }
});

test('compat-targets.json: no member waits for the snapshot any more, and a family names only manifest handles', () => {
  const text = read(DATA, 'compat-targets.json');
  assert.ok(!/resolve_from|step2_snapshot/.test(text), 'every snapshot member resolved');
  const compat = JSON.parse(text) as CompatTargets & { levonis_existing_printers: Record<string, { levonis_product_id: string | null; resolution: string }> };
  const t = reviewedTargets(compat);
  const handles = parseReviewedBundle(withP0Manifest()).manifest.byHandle;
  for (const h of t.handles) assert.ok(handles.has(h), h);
  // The live catalogue holds no X1C, X1E, P1P or X1; its P1S is the merge target of the source p1s.
  assert.equal(t.ids.size, 0, 'no relation targets an existing Levonis id directly');
  assert.deepEqual(
    Object.fromEntries(Object.entries(compat.levonis_existing_printers).map(([k, v]) => [k, v.resolution])),
    { X1C: 'not_in_levonis', X1E: 'not_in_levonis', P1P: 'not_in_levonis', P1S: 'merged_source', X1: 'not_in_levonis' }
  );
  const p1s = parseReviewedBundle(committedTexts()).matches.bySourceId.get(handles.get('p1s')!.source_product_id)!;
  assert.equal(p1s.decision, 'merge');
  assert.equal(compat.levonis_existing_printers.P1S.levonis_product_id, p1s.levonis_product_id);
  // A label whose only target was a missing Levonis model keeps no target: the package keeps it as text.
  for (const label of ['P1P', 'X1', 'X1E']) assert.ok(!compat.labels[label].to && !compat.labels[label].members, label);

  // The canary's "X1 Series and P1 Series": the draft's four unresolved members are gone; every family row waits on a
  // manifest handle (refurbished-x1c, p1s, refurbished-p1s).
  const x = page().extraction;
  const notesOf = (targets: CompatTargets) =>
    buildImportPayload({ extraction: x, writeMode: 'create', extractionSha256: 'x', targets, retrievedAt: 't' }).payload;
  const draft = notesOf(JSON.parse(read(P0, 'compat-targets.json')) as CompatTargets);
  const final = notesOf(compat);
  const unresolvable = (p: ImportPayload) => p.notes.filter((n) => n.kind === 'relation_unresolvable').length;
  // X1C, X1E, P1S and P1P stubs, on the product and on its one compatibility value, each read twice (option value and
  // compatibility section): twelve notes in the draft, none now.
  assert.equal(unresolvable(draft), 12);
  assert.equal(unresolvable(final), 0);
  assert.deepEqual(
    [...new Set(final.relations.filter((r) => r.target_family).map((r) => `${r.state}:${r.target_source_handle}`))].sort(),
    ['pending:p1s', 'pending:refurbished-p1s', 'pending:refurbished-x1c']
  );
});

test('taxonomy-map.json: every manifest row lands on its reviewed leaf; the new nodes are cat_bi_<key>, one id and one slug each', () => {
  const b = parseReviewedBundle(withP0Manifest());
  let resolved = 0;
  for (const row of b.manifest.rows) {
    const r = taxonomyOfRow(b, row);
    assert.ok(r, row.handle);
    assert.equal(r!.primary, catalogIdOf(row.leaf), row.handle);
    resolved++;
  }
  assert.equal(resolved, 1115);
  const ids = b.taxonomy.create.map((n) => taxonomyNodeId(n.key));
  assert.equal(new Set(ids).size, b.taxonomy.create.length);
  assert.equal(new Set(b.taxonomy.create.map((n) => n.slug)).size, b.taxonomy.create.length);
  assert.ok(ids.every((id) => /^cat_bi_[a-z0-9_]+$/.test(id)));
  assert.equal(b.taxonomy.create.length, 21);
  assert.equal(taxonomyNodeId('parts-x1p1'), 'cat_bi_parts_x1p1');
});
