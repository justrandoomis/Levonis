/**
 * THE COMMITTED CURATED FILES (Bambu import spec §F, "Quality validation per
 * class", the Curated row): data/bambu-import/curated/<handle>.json.
 *
 *   (1) the schema test — registry keys, units, types and hosts, a locator and
 *       a quote of at most 200 characters on every verified numeric value,
 *       every not_published key covered by a searched entry — plus privacy:
 *       no money, stock or shipping-fee key or value, no secret or model name,
 *       no link off a Bambu-owned host;
 *   (2) the consistency test: every curated value that also appears on the
 *       parsed store page agrees with it, or carries a conflict note. The P0
 *       crawl is private and never in the repository, so this test runs only
 *       where it is (BAMBU_CORPUS_DIR = the crawl's raw/ folder of
 *       <handle>.html.gz) and skips with a note everywhere else, CI included;
 *   (4) unit and range sanity per key.
 *
 * And the merge itself: every committed entry goes through `mergeCurated` and
 * the merged payload through `assertImportPayload`, the Worker's own check, so
 * no committed file can make the Worker refuse a product.
 *
 * Gate (3), the second extraction and its adjudication, happened before the
 * commit; its figures are in curated/index.json, checked by
 * catalogImportReviewedData.test.ts with the index itself.
 *
 * Run: node --import tsx --test tests/bambuImportCurated.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ROOT } from './fixtures/d1';
import { fixtureJson, pageOf } from './fixtures/bambu/load';
import { extractPage } from '../packages/catalog/src/bambuImport/extract';
import { extractionFingerprint } from '../packages/catalog/src/bambuImport/fingerprint';
import { assertImportPayload, buildImportPayload, type ImportPayload, type PayloadSpec } from '../packages/catalog/src/bambuImport/payload';
import type { CompatTargets } from '../packages/catalog/src/bambuImport/relations';
import { SPEC_KEYS } from '../packages/catalog/src/bambuImport/registry/specKeys';
import { CURATED_RANGES, curatedPrivacyProblems, curatedRangeProblems, curatedSchemaProblems } from '../scripts/bambu-import/curated';
import { mergeCurated } from '../scripts/bambu-import/enrich';

type Rec = Record<string, unknown>;
const DATA = join(ROOT, 'data', 'bambu-import');
const DIR = join(DATA, 'curated');
const SHA = 'c'.repeat(64);

/** Every committed curated file, by handle (index.json is not one). */
function curatedFiles(): Array<{ handle: string; file: Rec }> {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .sort()
    .map((f) => ({ handle: f.slice(0, -'.json'.length), file: JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Rec }));
}
const specsOf = (file: Rec) => file.specs as Rec[];

/** Problems by handle; a passing file is left out, so a failure names every file and problem at once. */
function problemsBy(check: (file: Rec, handle: string) => string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { handle, file } of curatedFiles()) {
    const p = check(file, handle);
    if (p.length) out[handle] = p;
  }
  return out;
}

test('§F gate 1: every committed curated file passes the schema (registry keys, units, types, hosts; locator and quote ≤ 200 on every verified numeric value; not_published covered by searched)', () => {
  const files = curatedFiles();
  assert.equal(files.length, 91);
  assert.deepEqual(problemsBy((f, h) => curatedSchemaProblems(f, h)), {});
  // Whatever the files hold, the schema test read it: a value on every entry, and the verified numeric ones quoted.
  const specs = files.flatMap(({ file }) => specsOf(file));
  assert.ok(specs.length > 2000, `${specs.length} spec entries`);
  const quoted = specs.filter((s) => s.status === 'verified' && typeof s.value === 'number');
  assert.ok(quoted.length > 1000 && quoted.every((s) => String(s.locator).trim() !== '' && String(s.quote).length <= 200));
});

test('privacy: no price, cost, stock or shipping key or value, no secret or model name, every link on a Bambu-owned host', () => {
  assert.deepEqual(problemsBy((f) => curatedPrivacyProblems(f)), {});
  assert.deepEqual(curatedPrivacyProblems(JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'))), [], 'index.json');
  for (const { handle } of curatedFiles()) assert.doesNotMatch(readFileSync(join(DIR, `${handle}.json`), 'utf8'), /IRAQ_PARALLEL_FX_API_KEY/, handle);
});

test('§F gate 4: unit and range sanity per key (nozzle 150–350 °C, density 0.9–2.5 g/cm³, every numeric key with a declared range)', () => {
  assert.deepEqual(CURATED_RANGES['print_settings.nozzle_temp'], [150, 350]);
  assert.deepEqual(CURATED_RANGES['thermal.max_nozzle_temp'], [150, 350]);
  assert.deepEqual(CURATED_RANGES['material.density'], [0.9, 2.5]);
  assert.deepEqual(problemsBy((f) => curatedRangeProblems(f)), {});
  const numeric = (v: unknown) => typeof v === 'number' || (!!v && typeof v === 'object' && typeof (v as Rec).min === 'number');
  const keys = new Set(curatedFiles().flatMap(({ file }) => specsOf(file).filter((s) => numeric(s.value)).map((s) => String(s.key))));
  for (const k of ['print_settings.nozzle_temp', 'material.density', 'mechanical.tensile_strength', 'material.net_weight', 'product.length']) assert.ok(keys.has(k), `${k} is range-checked`);
});

test('the checks refuse what they guard against', () => {
  const tds = 'https://store.bblcdn.com/s7/default/x/Bambu_PLA_Basic_TDS.pdf';
  const spec = (over: Rec = {}): Rec => ({
    key: 'print_settings.nozzle_temp', scope: { kind: 'product' }, value: { min: 190, max: 230 }, unit: '°C', status: 'verified', confidence: 'official_doc',
    source_kind: 'tds', source_url: tds, source_title: 'TDS', locator: 'p.2', quote: 'Nozzle Temperature 190 - 230 °C', test_method: '', test_condition: '', region: '', ...over,
  });
  const file = (over: Rec = {}, specs: Rec[] = [spec()]): Rec => ({
    handle: 'pla-basic-filament', schema: 2, curated_by: 'agent', curated_at: '2026-10-16T08:00:00Z',
    searched: [{ kind: 'tds', url: tds, title: 'TDS', keys: ['print_settings.*', 'thermal.*'] }], specs, hex: [], relations: [], in_the_box: [], documents: [], not_published: ['thermal.vicat_softening'], ...over,
  });
  const all = (f: Rec) => [...curatedSchemaProblems(f, 'pla-basic-filament'), ...curatedPrivacyProblems(f), ...curatedRangeProblems(f)];
  assert.deepEqual(all(file()), []);
  const unranged = SPEC_KEYS.find((k) => k.type === 'number' && k.unit !== 'g' && !(k.key in CURATED_RANGES))!;
  const cases: Array<[string, Rec, RegExp]> = [
    ['an unknown key', file({}, [spec({ key: 'x.nozzle' })]), /not a registry key/],
    ['a unit the registry does not store', file({}, [spec({ unit: '°F' })]), /registry stores «°C»/],
    ['a weight that does not convert', file({}, [spec({ key: 'material.net_weight', value: 1, unit: 'lb' })]), /weight in g or kg/],
    ['a value of another type', file({}, [spec({ key: 'printing.filament_runout_sensor', value: 'Yes', unit: '' })]), /not a boolean/],
    ['a verified number without a locator', file({}, [spec({ locator: '' })]), /without a locator and a quote/],
    ['a quote over 200 characters', file({}, [spec({ quote: 'q'.repeat(201) })]), /at most 200/],
    ['a not_published key nobody searched', file({ not_published: ['mechanical.tensile_strength'] }), /not covered by a searched entry/],
    ['a third-party host', file({}, [spec({ source_url: 'https://example.com/tds.pdf' })]), /host example\.com/],
    ['a store-page value from a CDN', file({}, [spec({ source_kind: 'store_page' })]), /host store\.bblcdn\.com/],
    ['a Shopify file of another shop', file({}, [spec({ source_url: 'https://cdn.shopify.com/s/files/1/9999/0000/0000/files/x.pdf' })]), /not a Bambu store file/],
    ['a price key', file({}, [spec({ price: 19 })]), /forbidden key/],
    ['a money value', file({ notes: ['US$19.99 at launch'] }), /money, stock or a shipping fee/],
    ['a stock state', file({ notes: ['Sold out in Black'] }), /money, stock or a shipping fee/],
    ['a shipping fee', file({ notes: ['Free shipping over 49'] }), /money, stock or a shipping fee/],
    ['the secret name', file({ notes: ['IRAQ_PARALLEL_FX_API_KEY'] }), /secret or a model/],
    ['a link off the Bambu hosts', file({ notes: ['see https://example.org/x'] }), /host example\.org/],
    ['a nozzle temperature out of range', file({}, [spec({ value: { min: 190, max: 400 } })]), /outside 150–350/],
    ['a density out of range', file({}, [spec({ key: 'material.density', value: 3.1, unit: 'g/cm³', quote: 'Density 3.1 g/cm³' })]), /outside 0\.9–2\.5/],
    ['a numeric key with no declared range', file({}, [spec({ key: unranged.key, value: 1, unit: unranged.unit })]), /no declared range/],
    ['a file under another handle', file({ handle: 'pla-matte' }), /not its file/],
  ];
  for (const [what, f, re] of cases) assert.ok(all(f).some((p) => re.test(p)), `${what}: ${JSON.stringify(all(f))}`);
});

test('mergeCurated takes every committed entry, and the Worker\'s payload check accepts every merged row', () => {
  // A minimal real payload (the trimmed filament-buffer page). Every entry is merged at product scope, so an
  // option-value or variant scope of another product is still exercised; entries sharing a key and region go in
  // separate rounds, so none is merged away by another before the check reads it.
  const x = pageOf('filament-buffer').extraction;
  const base = buildImportPayload({
    extraction: x, writeMode: 'create', extractionSha256: extractionFingerprint(x), targets: fixtureJson<CompatTargets>('compat-targets.json'), retrievedAt: '2026-10-16T08:00:00.000Z',
  }).payload;
  let merged = 0;
  for (const { handle, file } of curatedFiles()) {
    const rounds = new Map<string, Rec[]>();
    for (const s of specsOf(file)) rounds.set(`${String(s.key)}|${String(s.region ?? '')}`, [...(rounds.get(`${String(s.key)}|${String(s.region ?? '')}`) ?? []), s]);
    const n = Math.max(1, ...[...rounds.values()].map((r) => r.length));
    for (let i = 0; i < n; i++) {
      const specs = [...rounds.values()].map((r) => r[i]).filter(Boolean).map((s) => ({ ...s, scope: { kind: 'product' } }));
      const payload: ImportPayload = { ...base, specs: [], notes: [], documents: [] };
      const report = mergeCurated(payload, i === 0 ? { ...file, specs } : { specs }, SHA);
      assert.equal(report.skipped, 0, `${handle}: every entry becomes a row`);
      assert.equal(report.specs_added, specs.length, handle);
      merged += report.specs_added;
      assert.doesNotThrow(() => assertImportPayload(payload), handle);
    }
    // And the whole file as it stands, scopes as written (a scope this payload does not hold is skipped, never guessed).
    const whole: ImportPayload = JSON.parse(JSON.stringify(base));
    assert.doesNotThrow(() => mergeCurated(whole, file, SHA), handle);
    assert.doesNotThrow(() => assertImportPayload(whole), handle);
  }
  assert.equal(merged, curatedFiles().reduce((n, { file }) => n + specsOf(file).length, 0));
});

const CORPUS = process.env.BAMBU_CORPUS_DIR ?? '';

test('§F gate 2: every curated value that also appears on the parsed store page agrees with it, or carries a conflict note', (t) => {
  if (!CORPUS || !existsSync(CORPUS)) {
    t.skip('the P0 crawl is private and not in the repository: set BAMBU_CORPUS_DIR to its raw/ folder (<handle>.html.gz) to run the consistency test');
    return;
  }
  const manifest = JSON.parse(readFileSync(join(DATA, 'manifest.json'), 'utf8')) as { rows: Array<Rec & { handle: string }> };
  const targets = JSON.parse(readFileSync(join(DATA, 'compat-targets.json'), 'utf8')) as CompatTargets;
  const rows = new Map(manifest.rows.map((r) => [r.handle, r]));
  const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  // Agreement in the row's own terms: a boolean by its truth, a number (grams for a weight) by value and maximum,
  // a list by its items, a text when every line of one is in the other (a curated cell may keep some rows of a
  // wider store cell).
  const agree = (p: PayloadSpec, r: PayloadSpec): boolean => {
    if (r.value_bool !== null || p.value_bool !== null) return r.value_bool === p.value_bool;
    if (r.value_num !== null || p.value_num !== null) return r.value_num === p.value_num && r.value_num_max === p.value_num_max;
    if (r.value_list.length && p.value_list.length) {
      const a = new Set(r.value_list.map((v) => norm(String(v))));
      const b = new Set(p.value_list.map((v) => norm(String(v))));
      return a.size === b.size && [...a].every((v) => b.has(v));
    }
    const within = (x: string, y: string) => {
      const lines = x.split('\n').map(norm).filter(Boolean);
      return lines.length > 0 && lines.every((l) => norm(y).includes(l));
    };
    return norm(r.value_text) === norm(p.value_text) || within(r.value_text, p.value_text) || within(p.value_text, r.value_text);
  };
  const conflictNoted = (s: Rec) =>
    [s.conflict, s.conflict_note].some((v) => typeof v === 'string' && v.trim() !== '') || (typeof s.note === 'string' && /conflict|disagree|differ/i.test(s.note));
  const unnoted: string[] = [];
  const missing: string[] = [];
  let compared = 0;
  for (const { handle, file } of curatedFiles()) {
    const path = join(CORPUS, `${handle}.html.gz`);
    if (!existsSync(path)) {
      missing.push(handle);
      continue;
    }
    const x = extractPage(new TextDecoder().decode(gunzipSync(readFileSync(path)))).extraction;
    const page = buildImportPayload({
      extraction: x, writeMode: 'create', extractionSha256: extractionFingerprint(x), manifestRow: (rows.get(handle) ?? null) as never, targets, retrievedAt: '2026-10-16T08:00:00.000Z',
    }).payload;
    const byId = new Map(page.specs.map((s) => [s.id, s]));
    for (const s of specsOf(file)) {
      // The entry as the merge writes it (scope resolved on this page, a weight in grams), alone.
      const alone: ImportPayload = { ...page, specs: [], notes: [], documents: [] };
      mergeCurated(alone, { specs: [s] }, SHA);
      const row = alone.specs[0];
      const p = row && byId.get(row.id);
      if (!row || !p || (p.status !== 'verified' && p.status !== 'unverified')) continue;
      compared++;
      if (!agree(p, row) && !conflictNoted(s)) unnoted.push(`${handle} ${row.key} (${row.scope_kind}${row.region ? `, ${row.region}` : ''}): curated «${row.value_text}», page «${p.value_text}»`);
    }
  }
  if (missing.length) t.diagnostic(`no crawled page for ${missing.length} file(s): ${missing.join(', ')}`);
  t.diagnostic(`${compared} curated values compared with their store page`);
  assert.ok(compared > 0, 'the corpus holds the curated products');
  assert.deepEqual(unnoted, []);
});
