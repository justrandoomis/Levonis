/**
 * THE COMMITTED REVIEWED FILES, READ BY THE WORKER'S OWN PARSER (Bambu import
 * spec §A.3, §A.8, §B.6, §D.2, §E.1, §K.2 step 9; HANDOFF-PLAN §3.5, P0 step
 * 3 e; DECISIONS row 242).
 *
 * data/bambu-import/existing-matches.json, compat-targets.json and
 * taxonomy-map.json were reviewed against the sealed live snapshot (workflow 60
 * run 38863823810, 2026-10-16); manifest.json, identity-map.json,
 * media-overrides.json and search-synonyms.json are the reviewed P0 drafts,
 * bundled for step 9. The snapshot is private and never in the repository, so
 * these tests read only the committed files:
 *
 *   - the eight bundled texts parse with `parseReviewedBundle` exactly as the
 *     Worker bundles them (and the runner's reader takes the same files and
 *     answers the same write modes, when its file is present);
 *   - the matches file holds ids, a public slug (active targets only), a
 *     decision, a reason code, the value map, and for merge_publish the owner's
 *     approval — never a slug for a product that was not active at review (§A.8);
 *   - through the gate (`checkReviewedScope`) with the committed manifest: a
 *     merge or merge_publish only into its listed product, a create refused for
 *     every listed source;
 *   - the manifest keeps the P0 queue (the canary, the audit classes, the one
 *     ORDER_TYPE_WORD hold last, no OWNER_HIDDEN hold);
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

/** The sealed snapshot the three matched files were reviewed against (workflow 60 run 38863823810). */
const SNAPSHOT_SHA256 = '1215895671756da4011dbdc1f310f95f4543d8d0ad9b0b71f1deb3928557ef8c';
const APPROVAL = 'DECISIONS row 242';
const ENTRY_KEYS = ['source_product_id', 'source_handle', 'levonis_product_id', 'levonis_slug', 'decision', 'value_map', 'unmapped_variants', 'reason', 'reviewed_by', 'reviewed_at', 'approval_ref'];
/** The 14 owner-hidden matches the owner decided to merge and publish (DECISIONS row 242), by their public handles. */
const PUBLISHED = [
  'a1', 'a1-mini', 'a2l', 'ams-2-pro', 'ams-ht', 'ams-lite', 'bambu-high-flow-hotend-h2-p2s-x2d', 'bambu-hotend-a1-a2',
  'h2s', 'p2s', 'pla-matte', 'r1', 'tungsten-carbide-nozzle-h2-p2s', 'x2d',
];

test('the committed reviewed files parse with the Worker\'s own parser, byte for byte, and name the sealed snapshot they were reviewed against', () => {
  const texts = committedTexts();
  const b = parseReviewedBundle(texts);
  for (const k of Object.keys(REVIEWED_FILES) as ReviewedFileKey[]) {
    assert.equal(b.sha256[k], createHash('sha256').update(texts[k]).digest('hex'), `${REVIEWED_FILES[k]}: /hello answers the SHA-256 of the exact bytes`);
  }
  assert.equal(b.matches.entries.length, 35);
  const byDecision: Record<string, number> = {};
  for (const e of b.matches.entries) byDecision[e.decision] = (byDecision[e.decision] ?? 0) + 1;
  assert.deepEqual(byDecision, { merge: 21, merge_publish: 14 });
  assert.deepEqual(b.matches.entries.filter((e) => e.decision === 'merge_publish').map((e) => e.source_handle).sort(), PUBLISHED);
  // Source variants accounted for: mapped by the reviewed rule, or unmapped (variant_not_merged at the write).
  const total = (d: string, f: (e: (typeof b.matches.entries)[number]) => number) => b.matches.entries.filter((e) => e.decision === d).reduce((n, e) => n + f(e), 0);
  assert.deepEqual(
    { merge: [total('merge', (e) => Object.keys(e.value_map).length), total('merge', (e) => e.unmapped_variants.length)], merge_publish: [total('merge_publish', (e) => Object.keys(e.value_map).length), total('merge_publish', (e) => e.unmapped_variants.length)] },
    { merge: [174, 65], merge_publish: [44, 99] }
  );
  assert.equal(b.taxonomy.snapshot_sha256, SNAPSHOT_SHA256);
  for (const f of ['existing-matches.json', 'compat-targets.json', 'taxonomy-map.json']) {
    assert.equal((JSON.parse(read(DATA, f)) as { snapshot_sha256?: string }).snapshot_sha256, SNAPSHOT_SHA256, f);
  }
  // Step 9: the reviewed P0 drafts, bundled with only their status line changed; no curated file yet (another job).
  for (const f of ['manifest.json', 'identity-map.json', 'media-overrides.json', 'search-synonyms.json']) {
    const strip = (t: string) => {
      const o = JSON.parse(t) as Record<string, unknown>;
      delete o.status;
      return o;
    };
    assert.deepEqual(strip(read(DATA, f)), strip(read(P0, f)), `${f}: the P0 draft`);
  }
  assert.equal(b.manifest.rows.length, 1115);
  assert.equal(b.identity.size, 65);
  assert.equal(b.overrides.length, 0);
  assert.equal(b.synonyms.length, 79);
  assert.equal(b.curated.size, 0, 'curated/index.json stays the empty index until the curated files land');
});

test('§A.8 / §E.1: an entry holds ids, a decision and a reason code; a slug only for a target active at review, the owner\'s approval for merge_publish', () => {
  const raw = JSON.parse(read(DATA, 'existing-matches.json')) as { entries: Array<Record<string, unknown>> };
  const { matches } = parseReviewedBundle(committedTexts());
  const decisions = readFileSync(join(ROOT, 'docs', 'DECISIONS.md'), 'utf8');
  assert.match(decisions, /^\| 242 \| \*\*استيراد Bambu — /m, 'the owner\'s decision is DECISIONS row 242');
  for (const h of PUBLISHED) assert.ok(decisions.split('\n').find((l) => l.startsWith('| 242 |'))!.includes(`\`${h}\``), `row 242 names ${h}`);
  const sources = new Set<string>();
  for (const [i, e] of raw.entries.entries()) {
    const at = `entry ${i} (${String(e.source_handle)})`;
    for (const k of Object.keys(e)) assert.ok(ENTRY_KEYS.includes(k), `${at}: key ${k}`);
    assert.match(String(e.levonis_product_id), /^prd_[0-9a-f]{20}$/, at);
    assert.ok((MATCH_DECISIONS as readonly string[]).includes(String(e.decision)), at);
    assert.ok((MATCH_REASONS as readonly string[]).includes(String(e.reason)), at);
    assert.ok(!sources.has(String(e.source_product_id)), `${at}: one entry per source`);
    sources.add(String(e.source_product_id));
    assert.ok(e.decision === 'merge' || e.decision === 'merge_publish', at);
    if (e.decision === 'merge') {
      // Active at review: its public slug.
      assert.match(String(e.levonis_slug), /^[a-z0-9][a-z0-9-]*$/, at);
      assert.ok(!('approval_ref' in e), at);
    } else {
      // Owner-hidden at review, published by the owner's decision: never a slug (spec §A.8, "only of products active at review time").
      assert.ok(!('levonis_slug' in e), `${at}: no slug`);
      assert.equal(e.approval_ref, APPROVAL, at);
    }
    const m = matches.bySourceId.get(String(e.source_product_id))!;
    const mapped = Object.keys(m.value_map);
    assert.ok('value_map' in e && 'unmapped_variants' in e, `${at}: the value map is reviewed`);
    assert.ok(mapped.length + m.unmapped_variants.length > 0, `${at}: every source variant is accounted for`);
    for (const id of [...mapped, ...m.unmapped_variants]) assert.match(id, /^\d{1,24}$/, at);
    assert.equal(new Set([...mapped, ...m.unmapped_variants]).size, mapped.length + m.unmapped_variants.length, `${at}: mapped and unmapped are disjoint`);
  }
});

test('the committed manifest names every source, and the gate allows a merge only into its listed product and refuses every create of a listed source', () => {
  // Most matched sources are in the curated scope (§F, P0 step 3 g; another job writes curated/): a stand-in digest per
  // curated row lets the gate reach the existing-product rules for every one of them.
  const manifestRows = (JSON.parse(read(DATA, 'manifest.json')) as { rows: Array<{ handle: string; curated?: boolean }> }).rows;
  const stand = (h: string) => createHash('sha256').update(`stand-in:${h}`).digest('hex');
  const curated = Object.fromEntries(manifestRows.filter((r) => r.curated).map((r) => [r.handle, stand(r.handle)]));
  const b = parseReviewedBundle({ ...committedTexts(), curatedIndex: JSON.stringify({ version: 1, files: curated }) });
  const counts = { merge_ok: 0, merge_publish_ok: 0, create_refused: 0, other_target_refused: 0 };
  for (const m of b.matches.entries) {
    const row = b.manifest.bySourceId.get(m.source_product_id);
    assert.ok(row, `${m.source_handle}: a manifest source`);
    assert.equal(row!.handle, m.source_handle);
    assert.equal(row!.hold_code, '', `${m.source_handle}: no owner-hidden hold left`);
    // A minimal payload: the identity rows the identity map gives, no override binding, no relation.
    const identity = b.identity.get(m.source_handle) ?? {};
    const specs = (['model', 'series', 'family'] as const).filter((k) => identity[k]).map((k) => ({ key: `identity.${k}`, value_text: identity[k] }));
    const payload = (write_mode: 'create' | 'merge', product_id: string) =>
      ({ source_product_id: m.source_product_id, handle: m.source_handle, write_mode, product_id, curated_sha256: curated[m.source_handle] ?? '', specs, images: [], relations: [], route: row!.currentAllIdRoute }) as unknown as ImportPayload;
    const v = checkReviewedScope(b, payload('merge', m.levonis_product_id));
    assert.ok(v.ok && v.match === m && v.taxonomy.primary === catalogIdOf(row!.leaf), `${m.source_handle}: the listed merge passes and keeps its reviewed leaf`);
    counts[m.decision === 'merge' ? 'merge_ok' : 'merge_publish_ok']++;
    const create = checkReviewedScope(b, payload('create', `p_${'0'.repeat(24)}`));
    assert.ok(!create.ok && create.refusal.reason === 'create_for_listed_merge', m.source_handle);
    counts.create_refused++;
    const other = checkReviewedScope(b, payload('merge', 'prd_00000000000000000000'));
    assert.ok(!other.ok && other.refusal.reason === 'merge_target_not_listed', m.source_handle);
    counts.other_target_refused++;
  }
  assert.deepEqual(counts, { merge_ok: 21, merge_publish_ok: 14, create_refused: 35, other_target_refused: 35 });
});

test('the manifest keeps the P0 queue: the canary, the eight audit classes, no OWNER_HIDDEN hold, the one ORDER_TYPE_WORD hold last', () => {
  const b = parseReviewedBundle(committedTexts());
  const rows = [...b.manifest.rows].sort((x, y) => x.queue_position - y.queue_position);
  assert.deepEqual(rows.map((r) => r.queue_position), Array.from({ length: 1115 }, (_, i) => i + 1));
  assert.equal(rows[0].handle, 'filament-buffer');
  assert.deepEqual(
    rows.filter((r) => Array.isArray(r.audit_classes) && (r.audit_classes as string[]).length).map((r) => `${r.queue_position}:${r.handle}`),
    ['1:filament-buffer', '2:h2d', '3:refurbished-bambu-lab-h2d-3d-printer', '4:ams-2-pro', '5:pla-basic-filament', '6:bambu-hotend-a1-a2', '7:bambu-textured-pei-plate', '8:ams-2-pro-feeder-unit', '9:wireless-charger-kit-k012']
  );
  // The audit classes now cover both merge paths: h2d and pla-basic-filament merge, ams-2-pro and bambu-hotend-a1-a2 merge and publish.
  const decision = (h: string) => b.matches.bySourceId.get(b.manifest.byHandle.get(h)!.source_product_id)?.decision ?? 'create';
  assert.deepEqual(['h2d', 'pla-basic-filament', 'ams-2-pro', 'bambu-hotend-a1-a2', 'filament-buffer'].map(decision), ['merge', 'merge', 'merge_publish', 'merge_publish', 'create']);
  const held = rows.filter((r) => r.hold_code);
  assert.deepEqual(held.map((r) => `${r.queue_position}:${r.handle}:${r.hold_code}`), ['1115:cyberbrick-omnidirectional-forklift:ORDER_TYPE_WORD']);
  // Withdrawn at the store on 2026-10-16 (404): no hold code expresses it (0195), so it stays in its place and the run
  // blocks it SOURCE_WITHDRAWN at its turn (spec §1 row 20, L-10).
  assert.equal(b.manifest.byHandle.get('halloween-filament-special-combo')!.hold_code, '');
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
    loadReviewedBundle(dir: string): {
      sha256: Record<string, string>;
      rows: Array<{ source_product_id: string; handle: string; queue_position: number; hold_code?: string }>;
      matches: Map<string, unknown>;
      identity: Record<string, unknown>;
      overrides: unknown[];
      curatedIndex: Record<string, string>;
    };
    bundleDigest(sums: Record<string, string>): string;
    writeModeOf(bundle: unknown, sid: string): { mode: string; productId?: string; publish?: boolean };
  };
  const ours = parseReviewedBundle(committedTexts());
  const theirs = runner.loadReviewedBundle(DATA);
  for (const k of Object.keys(REVIEWED_FILES) as ReviewedFileKey[]) assert.equal(theirs.sha256[REVIEWED_FILES[k]], ours.sha256[k], REVIEWED_FILES[k]);
  assert.equal(runner.bundleDigest(theirs.sha256), ours.bundleSha256);
  assert.deepEqual(
    theirs.rows.map((r) => [r.queue_position, r.source_product_id, r.handle, r.hold_code ?? '']),
    [...ours.manifest.rows].sort((x, y) => x.queue_position - y.queue_position).map((r) => [r.queue_position, r.source_product_id, r.handle, r.hold_code])
  );
  assert.equal(Object.keys(theirs.identity).length, ours.identity.size);
  assert.equal(theirs.overrides.length, ours.overrides.length);
  assert.equal(Object.keys(theirs.curatedIndex).length, ours.curated.size);
  assert.equal(theirs.matches.size, ours.matches.entries.length);
  for (const m of ours.matches.entries) {
    assert.deepEqual(runner.writeModeOf(theirs, m.source_product_id), { mode: 'merge', productId: m.levonis_product_id, publish: m.decision === 'merge_publish' }, m.source_handle);
  }
  // Every other manifest source is created.
  const other = ours.manifest.rows.find((r) => !ours.matches.bySourceId.has(r.source_product_id))!;
  assert.deepEqual(runner.writeModeOf(theirs, other.source_product_id), { mode: 'create' });
});

test('compat-targets.json: no member waits for the snapshot any more, and a family names only manifest handles', () => {
  const text = read(DATA, 'compat-targets.json');
  assert.ok(!/resolve_from|step2_snapshot/.test(text), 'every snapshot member resolved');
  const compat = JSON.parse(text) as CompatTargets & { levonis_existing_printers: Record<string, { levonis_product_id: string | null; resolution: string }> };
  const t = reviewedTargets(compat);
  const b = parseReviewedBundle(committedTexts());
  for (const h of t.handles) assert.ok(b.manifest.byHandle.has(h), h);
  // The live catalogue holds no X1C, X1E, P1P or X1; its P1S is the merge target of the source p1s.
  assert.equal(t.ids.size, 0, 'no relation targets an existing Levonis id directly');
  assert.deepEqual(
    Object.fromEntries(Object.entries(compat.levonis_existing_printers).map(([k, v]) => [k, v.resolution])),
    { X1C: 'not_in_levonis', X1E: 'not_in_levonis', P1P: 'not_in_levonis', P1S: 'merged_source', X1: 'not_in_levonis' }
  );
  const p1s = b.matches.bySourceId.get(b.manifest.byHandle.get('p1s')!.source_product_id)!;
  assert.equal(p1s.decision, 'merge');
  assert.equal(compat.levonis_existing_printers.P1S.levonis_product_id, p1s.levonis_product_id);
  // A label whose only target was a missing Levonis model keeps no target: the package keeps it as text.
  for (const label of ['P1P', 'X1', 'X1E']) assert.ok(!compat.labels[label].to && !compat.labels[label].members, label);

  // The canary's "X1 Series and P1 Series": the draft's unresolved members are gone; every family row waits on a
  // manifest handle (refurbished-x1c, p1s, refurbished-p1s).
  const x = page().extraction;
  const payloadWith = (targets: CompatTargets) => buildImportPayload({ extraction: x, writeMode: 'create', extractionSha256: 'x', targets, retrievedAt: 't' }).payload;
  const draft = payloadWith(JSON.parse(read(P0, 'compat-targets.json')) as CompatTargets);
  const final = payloadWith(compat);
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
  const b = parseReviewedBundle(committedTexts());
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
