/**
 * Printer Farm — the admin balancing console (src/components/adminFarm).
 *
 * The console is schema-less: it renders whatever `GET /api/admin/farm/config`
 * returns from each value's JSON type and the default beside it. These checks
 * pin the promises that make that safe — every section and leaf of the REAL
 * defaults gets an editor the tree knows and a label somebody wrote; number
 * hints agree with the server's own ranges; the section order is the
 * contract's; the client speaks to /api/admin/farm alone with the contract's
 * bodies; nothing is fabricated, no browser dialog, every string in three
 * languages, Levonis Points untouched. Static checks read the source the way
 * a reviewer would (tests/subscriptionPage.test.ts style); the pure helpers
 * are exercised directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { FARM_ADMIN_STRINGS, LABELS, adminStrings } from '../src/components/adminFarm/strings';
import {
  FIXED_KEY_PATHS,
  SECTION_ORDER,
  blankFrom,
  defaultText,
  freshKey,
  getAt,
  humanize,
  isTuple,
  jsonEqual,
  labelCandidates,
  numberSpec,
  orderedSections,
  privateKeys,
  problemsFor,
  ratioPercent,
  referenceOptions,
  renameKey,
  sectionCount,
  setAt,
  shapeOf,
  splitPath,
  templateOf,
  type JsonObject,
} from '../src/components/adminFarm/schema';
import { findLabel, labelFor } from '../src/components/adminFarm/labels';
import {
  FARM_ADMIN_CODES,
  farmAdminApi,
  farmAdminCurrentVersion,
  farmAdminErrorText,
  farmAdminProblems,
} from '../src/lib/farmAdminApi';
import { ApiError } from '../src/lib/api';
import { FARM_CONFIG_DEFAULTS, FARM_CONFIG_SECTIONS, publicFarmConfig } from '../worker/lib/farm/config';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const DIR = 'src/components/adminFarm';
const panelFiles = () => [
  ...readdirSync(join(ROOT, DIR))
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => `${DIR}/${f}`),
  'src/lib/farmAdminApi.ts',
];
const componentFiles = () => panelFiles().filter((f) => f.endsWith('.tsx'));
const allSource = () => panelFiles().map((f) => `// ${f}\n${read(f)}`).join('\n');

const DEFAULTS = FARM_CONFIG_DEFAULTS as unknown as JsonObject;

// ---------------------------------------------------------------- the tree

interface Node {
  path: string;
  value: unknown;
  shape: ReturnType<typeof shapeOf>;
  /** A catalog entry: its header shows the key and the row's own name, not a label. */
  row: boolean;
}

/** Every path of the defaults with catalog entry keys folded to `*`, plus its value and shape. */
function walk(value: unknown, path: string, out: Node[], row = false) {
  const shape = shapeOf(value);
  out.push({ path, value, shape, row });
  if (shape === 'catalog') {
    for (const entry of Object.values(value as JsonObject)) walk(entry, `${path}.*`, out, true);
  } else if (shape === 'group') {
    for (const [k, v] of Object.entries(value as JsonObject)) walk(v, path ? `${path}.${k}` : k, out);
  }
}

function tree() {
  const out: Node[] = [];
  for (const section of orderedSections(DEFAULTS)) walk(DEFAULTS[section], section, out);
  // De-duplicate the `*` rows: fourteen printers fold to one printers.* row per field.
  const seen = new Map<string, Node>();
  for (const row of out) if (!seen.has(row.path)) seen.set(row.path, row);
  return Array.from(seen.values());
}

test('the section order is the contract’s (docs §5 plus `colors`), and every default section is an object', () => {
  assert.deepEqual([...SECTION_ORDER], [...FARM_CONFIG_SECTIONS]);
  assert.deepEqual(orderedSections(DEFAULTS), [...FARM_CONFIG_SECTIONS], 'schema and version are meta, not sections');
  // An unknown section the engine adds tomorrow still renders — after the known ones.
  assert.deepEqual(orderedSections({ ...DEFAULTS, zeta: { a: 1 } }), [...FARM_CONFIG_SECTIONS, 'zeta']);
});

test('every node of the real defaults has an editor the tree knows (no opaque JSON) and a curated label', () => {
  const rows = tree();
  assert.ok(rows.length > 150, `expected the whole document, walked ${rows.length} nodes`);
  const opaque = rows.filter((r) => r.shape === 'json').map((r) => r.path);
  assert.deepEqual(opaque, [], 'a shape the editor cannot edit');
  const labelled = rows.filter((r) => !r.row);
  const unlabelled = labelled.filter((r) => !findLabel(r.path)).map((r) => r.path);
  assert.deepEqual(unlabelled, [], 'a field the admin would see humanised instead of named');
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    for (const r of labelled) {
      const lb = labelFor(r.path, lang);
      assert.ok(lb.curated && lb.label.length > 0, `${lang} label for ${r.path}`);
    }
  }
  // The catalogs the engine keys by name (tiers, qualities, failure kinds) title each row by a curated label.
  for (const p of FIXED_KEY_PATHS) {
    const rec = getAt(DEFAULTS, splitPath(p));
    if (shapeOf(rec) !== 'catalog') continue;
    for (const k of Object.keys(rec as JsonObject)) assert.ok(labelFor(`${p}.${k}`, 'ckb').curated, `${p}.${k} row title`);
  }
  // A group of groups is NOT a catalog: nobody may add a row to `rewards`.
  assert.equal(shapeOf(DEFAULTS.rewards), 'group');
  assert.equal(shapeOf(DEFAULTS.economy), 'group');
  assert.equal(shapeOf({ a1_mini: (DEFAULTS.printers as JsonObject).a1_mini }, DEFAULTS.printers), 'catalog', 'a catalog cut to one row is still a catalog');
  assert.equal(shapeOf({ only: { x: 1 } }), 'group', 'one record with no catalog default is a group');
});

test('fixed-key catalogs are exactly the ones the normaliser keeps on a fixed key set', () => {
  assert.deepEqual([...FIXED_KEY_PATHS].sort(), ['customers', 'failure.kinds', 'jobs.reward_formula.quality_multipliers', 'quality']);
  for (const p of FIXED_KEY_PATHS) {
    const v = getAt(DEFAULTS, splitPath(p));
    assert.ok(v !== undefined, `${p} exists in the defaults`);
  }
});

test('number hints agree with the server: ratios only where the default is within [0, 1], integers only where the default is whole, and consistent across catalog rows', () => {
  const all: Node[] = [];
  for (const section of orderedSections(DEFAULTS)) walk(DEFAULTS[section], section, all);
  const numbers = all.filter((r) => r.shape === 'number');
  assert.ok(numbers.length > 120);
  const integerByPath = new Map<string, boolean>();
  for (const r of numbers) {
    const spec = numberSpec(r.path, r.value);
    const v = r.value as number;
    if (spec.kind === 'ratio') assert.ok(v >= 0 && v <= 1, `${r.path} is a ratio but its default is ${v}`);
    if (spec.integer) assert.ok(Number.isInteger(v), `${r.path} is integer-only but its default is ${v}`);
    if (spec.min !== undefined) assert.ok(v >= spec.min, `${r.path} default ${v} below min ${spec.min}`);
    if (spec.max !== undefined) assert.ok(v <= spec.max, `${r.path} default ${v} above max ${spec.max}`);
    const prev = integerByPath.get(r.path);
    if (prev !== undefined) assert.equal(spec.integer, prev, `${r.path} is integer on one catalog row and decimal on another`);
    integerByPath.set(r.path, spec.integer);
  }
});

test('key hints: money, basis points, ratios, units', () => {
  assert.deepEqual(numberSpec('printers.a1_mini.price', 6000), { kind: 'money', integer: true, step: 1, min: 0 });
  assert.equal(numberSpec('materials.PLA.price_per_gram', 2).integer, false, 'a per-gram rate may be fractional');
  assert.equal(numberSpec('economy.energy.coins_per_kwh', 20).kind, 'money');
  assert.deepEqual(numberSpec('customers.individual.late_penalty_bp', 80), { kind: 'bp', integer: true, step: 1, min: 0, max: 5000 });
  assert.equal(numberSpec('failure.base', 0.02).kind, 'ratio');
  assert.equal(numberSpec('failure.weights.health', 0.35).kind, 'ratio');
  assert.equal(numberSpec('printers.x1c.reliability', 0.95).kind, 'ratio');
  assert.equal(numberSpec('economy.resale_factor', 0.55).kind, 'ratio');
  assert.equal(numberSpec('starter.spool.quality', 1).kind, 'ratio');
  assert.equal(numberSpec('time.offer_refresh_minutes', 10).unit, 'min');
  assert.equal(numberSpec('products.keychain.seconds_per_part', 1500).unit, 's');
  assert.equal(numberSpec('printers.a1_mini.watts', 95).unit, 'W');
  assert.equal(numberSpec('printers.a1_mini.speed', 250).unit, 'mm/s');
  assert.equal(numberSpec('locations.garage.storage_grams', 12000).unit, 'g');
  assert.equal(numberSpec('customers.merchant.reward_margin', 1.5).kind, 'decimal');
  assert.equal(numberSpec('failure.kinds.clog.health_hit', 4).integer, false, 'a health hit is fractional on some kinds');
  assert.equal(numberSpec('progression.xp_per_job', 40).integer, true);
  assert.equal(numberSpec('brand_new.some_count', 3).integer, true, 'an unknown whole default edits as an integer');
  assert.equal(numberSpec('brand_new.some_rate', 0.7).integer, false, 'an unknown fractional default edits as a decimal');
  assert.equal(ratioPercent(0.55), 55);
  assert.equal(ratioPercent(1.7), 100);
});

test('shapes: scalars, localised names, lists, records, catalogs, groups; an emptied list borrows its default’s type', () => {
  assert.equal(shapeOf(5), 'number');
  assert.equal(shapeOf(true), 'boolean');
  assert.equal(shapeOf('a1_mini'), 'string');
  assert.equal(shapeOf({ ar: 'أ', en: 'a', ckb: 'ئ' }), 'localized');
  assert.equal(shapeOf(['PLA', 'PETG']), 'string-list');
  assert.equal(shapeOf([250, 500]), 'number-list');
  assert.equal(shapeOf(DEFAULTS.customers), 'catalog');
  assert.equal(shapeOf((DEFAULTS.customers as JsonObject).individual), 'group');
  assert.equal(shapeOf(((DEFAULTS.customers as JsonObject).individual as JsonObject).names), 'record-list');
  assert.equal(shapeOf(DEFAULTS.time), 'group');
  assert.equal(shapeOf([], [250, 500]), 'number-list');
  assert.equal(shapeOf([], ['PLA']), 'string-list');
  assert.equal(shapeOf({}, DEFAULTS.printers), 'catalog', 'an emptied catalog is still a catalog');
  assert.equal(shapeOf([1, 'x']), 'json');
  assert.deepEqual(sectionCount(DEFAULTS.printers), { entries: 14, catalog: true });
  assert.deepEqual(sectionCount(DEFAULTS.time), { entries: 4, catalog: false });
  assert.ok(isTuple('printers.a1_mini.volume_mm', [180, 180, 180]));
  assert.ok(isTuple('customers.individual.qty_range', [1, 4]));
  assert.equal(isTuple('economy.spool_sizes_g', [250, 500, 1000]), false, 'spool sizes are a list, not a tuple');
  assert.equal(isTuple('progression.level_thresholds', [0, 100]), false);
});

test('labels: most specific path first, then `*` wildcards, then the bare key; unknown keys are humanised', () => {
  assert.deepEqual(labelCandidates('printers.a1_mini.price').slice(0, 2), ['printers.a1_mini.price', 'printers.*.price']);
  assert.equal(labelCandidates('printers.a1_mini.price').at(-1), 'price');
  assert.equal(labelFor('printers.a1_mini.price', 'ar').label, LABELS['printers.*.price'].ar);
  assert.equal(labelFor('printers.a1_mini.price', 'ar').secondary, LABELS['printers.*.price'].en);
  assert.equal(labelFor('printers.a1_mini.price', 'en').secondary, LABELS['printers.*.price'].ar);
  assert.equal(labelFor('failure.kinds.clog.weight', 'ckb').label, LABELS['failure.kinds.*.weight'].ckb);
  assert.equal(labelFor('jobs.reward_formula.quality_multipliers.fine', 'en').label, 'Fine');
  assert.ok(labelFor('time', 'ckb').hint, 'a section carries a hint');
  const unknown = labelFor('brand_new.offer_refresh_minutes', 'en');
  assert.equal(unknown.curated, false);
  assert.equal(unknown.label, 'Offer refresh minutes');
  assert.equal(humanize('maxColors'), 'Max colors');
  // The three section names that double as bare-segment fallbacks exist once.
  for (const k of ['materials', 'colors', 'quality']) assert.ok(LABELS[k], `${k} is curated`);
});

test('every curated label and hint is written in ar, en and ckb', () => {
  const keys = Object.keys(LABELS);
  assert.ok(keys.length > 150, `expected the whole §5 vocabulary, found ${keys.length}`);
  for (const [k, l] of Object.entries(LABELS)) {
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      assert.ok(l[lang] && l[lang].trim().length > 0, `LABELS[${k}].${lang}`);
      if (l.hint) assert.ok(l.hint[lang] && l.hint[lang].trim().length > 0, `LABELS[${k}].hint.${lang}`);
    }
    assert.ok(/^[a-z_.*-]+$/i.test(k), `label key is a dotted path: ${k}`);
  }
});

test('values: blank rows, templates, immutable set, ordered rename, fresh keys, defaults text, reference suggestions', () => {
  const template = templateOf(DEFAULTS.printers) as JsonObject;
  const blank = blankFrom(template) as JsonObject;
  assert.deepEqual(Object.keys(blank), Object.keys(template), 'a blank row has the shape of the defaults’ first row');
  assert.equal(blank.price, 0);
  assert.equal(blank.ams, false);
  assert.deepEqual(blank.materials, []);
  assert.deepEqual(blank.volume_mm, [0, 0, 0], 'a tuple keeps its length');
  assert.deepEqual(blank.name, { ar: '', en: '', ckb: '' });

  const doc = { economy: { maintenance: { cost: 150 } } };
  const next = setAt(doc, ['economy', 'maintenance', 'cost'], 200) as typeof doc;
  assert.equal(next.economy.maintenance.cost, 200);
  assert.equal(doc.economy.maintenance.cost, 150, 'setAt never mutates');
  assert.equal(getAt(DEFAULTS, ['printers', 'a1_mini', 'price']), 6000);
  assert.equal(getAt(DEFAULTS, ['printers', 'nope', 'price']), undefined);
  assert.deepEqual(splitPath('economy.maintenance.cost'), ['economy', 'maintenance', 'cost']);

  const renamed = renameKey({ a: 1, new_1: 2, c: 3 }, 'new_1', 'b');
  assert.deepEqual(Object.keys(renamed), ['a', 'b', 'c'], 'a rename keeps the row where it was');
  assert.deepEqual(renameKey({ a: 1, b: 2 }, 'a', 'b'), { a: 1, b: 2 }, 'a taken key is refused');
  assert.equal(freshKey(['new_1', 'new_2', 'x']), 'new_3');
  assert.equal(freshKey([]), 'new_1');

  assert.equal(defaultText(1500), '1500');
  assert.equal(defaultText([250, 500, 1000]), '250, 500, 1000');
  assert.equal(defaultText('a1_mini'), 'a1_mini');
  assert.equal(defaultText(''), undefined);
  assert.equal(defaultText({ cost: 1 }), undefined, 'an object has no one-line default');

  const materials = Object.keys(DEFAULTS.materials as JsonObject);
  assert.deepEqual(referenceOptions('printers.a1_mini.materials', DEFAULTS), materials);
  assert.deepEqual(referenceOptions('starter.spool.material', DEFAULTS), materials);
  assert.deepEqual(referenceOptions('starter.spool.color', DEFAULTS), Object.keys(DEFAULTS.colors as JsonObject));
  assert.deepEqual(referenceOptions('starter.printer_model', DEFAULTS), Object.keys(DEFAULTS.printers as JsonObject));
  assert.deepEqual(referenceOptions('starter.first_job.product', DEFAULTS), Object.keys(DEFAULTS.products as JsonObject));
  assert.deepEqual(referenceOptions('products.gear.min_tier', DEFAULTS), Object.keys(DEFAULTS.customers as JsonObject));
  assert.deepEqual(referenceOptions('starter.first_job.quality', DEFAULTS), ['draft', 'standard', 'fine', 'ultra']);
  assert.equal(referenceOptions('materials.PLA.quality', DEFAULTS), null, 'a numeric quality is not a reference');
  assert.equal(referenceOptions('colors', DEFAULTS), null, 'the colours catalog is not a list of references');
  assert.deepEqual(referenceOptions('printers.a1_mini.family', DEFAULTS), ['A', 'P', 'X', 'H']);
  assert.equal(referenceOptions('time.time_scale', DEFAULTS), null);
  assert.equal(referenceOptions('starter.spool.material', null), null, 'no document, no suggestions');
});

test('server problems are routed to their section; the public projection decides which sections are private', () => {
  const problems = [
    'economy.spool_sizes_g must all be > 0',
    'starter printer a1 cannot print the starter spool material PLA',
    'materials: at least one material is required',
    'failure.kinds: at least one kind needs a positive weight',
    'rewards.levonis_points.enabled cannot be true: Farm Coins → Levonis Points conversion is not implemented in this phase',
  ];
  assert.deepEqual(problemsFor('economy', problems), [problems[0]]);
  assert.deepEqual(problemsFor('starter', problems), [problems[1]]);
  assert.deepEqual(problemsFor('materials', problems), [problems[2]]);
  assert.deepEqual(problemsFor('failure', problems), [problems[3]]);
  assert.deepEqual(problemsFor('rewards', problems), [problems[4]]);
  assert.deepEqual(problemsFor('time', problems), []);
  assert.deepEqual(privateKeys(DEFAULTS, publicFarmConfig(FARM_CONFIG_DEFAULTS) as unknown as JsonObject), ['limits', 'rewards']);
  assert.deepEqual(privateKeys(DEFAULTS, null), [...FARM_CONFIG_SECTIONS], 'without a projection nothing is assumed public');
  assert.ok(jsonEqual({ a: [1, 2] }, { a: [1, 2] }));
  assert.equal(jsonEqual({ a: 1 }, { a: 2 }), false);
});

// ------------------------------------------------------------------ strings

function keyPaths(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...keyPaths(v, p));
    else out.push(p);
  }
  return out.sort();
}

test('every console string exists in ar, en and ckb with the same shape, no empty value, and Sorani written by hand', () => {
  const en = keyPaths(FARM_ADMIN_STRINGS.en);
  assert.deepEqual(keyPaths(FARM_ADMIN_STRINGS.ar), en, 'ar differs from en');
  assert.deepEqual(keyPaths(FARM_ADMIN_STRINGS.ckb), en, 'ckb differs from en');
  assert.ok(en.length > 150, `expected a full table, found ${en.length} keys`);
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const table = FARM_ADMIN_STRINGS[lang] as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(table)) {
      if (typeof v === 'function') {
        const out = (v as (...a: never[]) => string)(...([3, 'x', 4] as never[]));
        assert.ok(typeof out === 'string' && out.length > 0, `${lang}.${k}() returned an empty string`);
      } else {
        assert.ok(typeof v === 'string' && v.length > 0, `${lang}.${k} is empty`);
      }
    }
  }
  const same = Object.keys(FARM_ADMIN_STRINGS.en).filter((k) => {
    const a = (FARM_ADMIN_STRINGS.ar as unknown as Record<string, unknown>)[k];
    const c = (FARM_ADMIN_STRINGS.ckb as unknown as Record<string, unknown>)[k];
    return typeof a === 'string' && a === c;
  });
  assert.ok(same.length < 8, `too many ckb strings are identical to ar: ${same.join(', ')}`);
  assert.equal(adminStrings('xx'), FARM_ADMIN_STRINGS.ar, 'an unknown UI language reads Arabic, the source language');
  assert.equal(adminStrings('ckb'), FARM_ADMIN_STRINGS.ckb);
});

// ---------------------------------------------------------------- the API

test('the client speaks to /api/admin/farm alone, with the contract’s bodies', async () => {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = { success: true, version: 3, config: {}, defaults: {}, public: {}, problems: [], user: { id: 'u' }, farm: null, replayed: false, ledger_id: 'l', amount: 1, balance: 1 };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    await farmAdminApi.config();
    await farmAdminApi.saveSection('economy', { starter_coins: 1 }, 2);
    await farmAdminApi.resetSection('printers');
    await farmAdminApi.player('usr_1');
    await farmAdminApi.grant('usr_1', { amount: -5, reason: 'refund test', idempotencyKey: 'k'.repeat(12) });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(
    calls.map((c) => [c.method, c.url]),
    [
      ['GET', '/api/admin/farm/config'],
      ['PUT', '/api/admin/farm/config/economy'],
      ['POST', '/api/admin/farm/config/printers/reset'],
      ['GET', '/api/admin/farm/players/usr_1'],
      ['POST', '/api/admin/farm/players/usr_1/grant'],
    ]
  );
  assert.deepEqual(calls[1].body, { value: { starter_coins: 1 }, expected_version: 2 }, 'a save carries the section value and the expected version');
  assert.deepEqual(calls[2].body, { confirm: 'RESET' }, 'a reset carries the typed word');
  assert.deepEqual(calls[4].body, { amount: -5, reason: 'refund test', idempotencyKey: 'k'.repeat(12) });
  for (const c of calls) assert.ok(c.url.startsWith('/api/admin/farm/'), `${c.url} is outside the farm admin surface`);
});

test('refusals are read from the server’s code and details, never guessed', () => {
  assert.equal(FARM_ADMIN_CODES.versionMismatch, 'CONFIG_VERSION_MISMATCH');
  assert.equal(FARM_ADMIN_CODES.invalid, 'FARM_CONFIG_INVALID');
  assert.equal(farmAdminCurrentVersion(new ApiError(409, 'stale', 'CONFIG_VERSION_MISMATCH', { current_version: 7 })), 7);
  assert.equal(farmAdminCurrentVersion(new ApiError(409, 'stale', 'CONFIG_VERSION_MISMATCH')), null);
  assert.equal(farmAdminCurrentVersion(new ApiError(400, 'bad', 'FARM_CONFIG_INVALID', { current_version: 7 })), null);
  assert.deepEqual(farmAdminProblems(new ApiError(400, 'bad', 'FARM_CONFIG_INVALID', { problems: ['printers.x.price must be > 0', 4] })), ['printers.x.price must be > 0']);
  assert.deepEqual(farmAdminProblems(new ApiError(400, 'bad', 'SOMETHING_ELSE', { problems: ['x'] })), []);
  assert.deepEqual(farmAdminProblems(new Error('boom')), []);
  assert.equal(farmAdminErrorText(new ApiError(500, 'Server said so'), 'fallback'), 'Server said so');
  assert.equal(farmAdminErrorText(new Error('boom'), 'fallback'), 'fallback');
});

// -------------------------------------------------------------- the source

/** Every `<button` tag in a JSX source, with its attribute text (braces balanced across arrow functions). */
function buttonTags(src: string): string[] {
  const out: string[] = [];
  let i = src.indexOf('<button');
  while (i !== -1) {
    let depth = 0;
    let j = i;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    out.push(src.slice(i, j + 1));
    i = src.indexOf('<button', j);
  }
  return out;
}

test('every button carries an explicit type and no browser dialog, canvas or banned renderer enters the console', () => {
  for (const f of componentFiles()) {
    const src = read(f);
    for (const tag of buttonTags(src)) assert.match(tag, /\btype="(button|submit)"/, `${f}: a button without type — ${tag.slice(0, 80)}`);
  }
  const src = allSource();
  assert.equal(/window\.(confirm|alert|prompt)\(/.test(src), false, 'no browser dialogs');
  assert.equal(/\balert\(/.test(src), false, 'no alert()');
  assert.equal(src.includes('<canvas'), false, 'no canvas');
  for (const mod of ["from 'three'", "from 'ogl'", "from 'recharts'", "from 'gsap'", '@react-three']) {
    assert.equal(src.includes(mod), false, `${mod} must not enter the admin chunk`);
  }
});

test('Levonis Points are never touched, nothing is minted, and numbers go through the shared Intl helpers', () => {
  const src = allSource();
  for (const phrase of ['/api/wallet', 'refreshWallet', 'useWallet', "'POINT'", '/api/rewards', 'pointBalance', 'wallet/credit']) {
    assert.equal(src.includes(phrase), false, `the console reaches the points system: ${phrase}`);
  }
  assert.equal(/enabled:\s*true/.test(src), false, 'nothing flips the conversion switch on');
  for (const f of componentFiles()) {
    const c = read(f);
    assert.equal(/\bapi\.(get|post|put|patch|delete)\(/.test(c), false, `${f} calls the API directly; only farmAdminApi may`);
    assert.equal(c.includes('fetch('), false, `${f} fetches directly`);
    assert.equal(c.includes('toLocaleString('), false, `${f} formats a number outside the shared helpers`);
    assert.equal(/\bIntl\./.test(c), false, `${f} formats outside the shared helpers`);
  }
});

test('RTL: logical CSS properties only, and the direction-bearing inputs say so', () => {
  const physical = /\b-?(ml|mr|pl|pr)-\d|\btext-(left|right)\b|\b(left|right)-\d|\brounded-(l|r)-|\bborder-(l|r)-\d|\b(ms|me|ps|pe)-\[?-/;
  for (const f of componentFiles()) {
    const c = read(f);
    const hit = c.match(physical);
    assert.equal(hit, null, `${f} uses a physical direction class: ${hit?.[0]}`);
  }
  const inputs = read(`${DIR}/inputs.tsx`);
  assert.ok(inputs.includes('dir="ltr"'), 'number and key boxes are LTR');
  assert.ok(inputs.includes("dir={rtl ? 'rtl' : 'ltr'}"), 'a translated name reads in its own direction');
});

test('async results are announced (role=status / role=alert), destructive actions sit behind in-app windows, and every icon-only button is labelled', () => {
  const root = read(`${DIR}/AdminFarmConfig.tsx`);
  const panel = read(`${DIR}/SectionPanel.tsx`);
  const players = read(`${DIR}/PlayersPanel.tsx`);
  const editors = read(`${DIR}/editors.tsx`);
  for (const [name, c] of [
    ['AdminFarmConfig', root],
    ['SectionPanel', panel],
    ['PlayersPanel', players],
  ] as const) {
    assert.ok(c.includes("role={") && c.includes("'status'") && c.includes("'alert'"), `${name} announces results`);
  }
  assert.ok(root.includes('role="alert"') && root.includes('role="status"'));
  assert.ok(panel.includes('testId="farm-reset-section"') && panel.includes("confirmText !== 'RESET'"), 'reset needs the typed word');
  assert.ok(editors.includes('testId="farm-remove-row"'), 'a catalog row is removed after an in-app confirm');
  assert.ok(players.includes('testId="farm-grant-confirm"'), 'a coin movement is confirmed in-app');
  assert.match(players, /const MIN_REASON = 5;/, 'a grant reason is at least five characters');
  assert.ok(players.includes('newIdempotencyKey()'), 'every grant attempt carries a fresh idempotency key');
  // Icon-only buttons (a lone lucide icon inside) carry aria-label.
  for (const f of componentFiles()) {
    const c = read(f);
    for (const tag of buttonTags(c)) {
      const after = c.slice(c.indexOf(tag) + tag.length, c.indexOf(tag) + tag.length + 160);
      const iconOnly = /^\s*<[A-Z][A-Za-z]+ className="[^"]*" aria-hidden="true" \/>\s*<\/button>/.test(after);
      if (iconOnly) assert.match(tag, /aria-label=/, `${f}: icon-only button without a label — ${tag.slice(0, 80)}`);
    }
  }
});

test('the console mounts the server’s document, never a client schema, and the Admin page wires the tab', () => {
  const root = read(`${DIR}/AdminFarmConfig.tsx`);
  assert.ok(root.includes('farmAdminApi.config()'), 'the document is fetched from the server');
  assert.ok(root.includes('applyServer(res.config, section)'), 'both copies are replaced from the normalised document the server returned');
  assert.ok(root.includes('farmAdminCurrentVersion(e)') && root.includes('farmAdminProblems(e)'), '409 and 400 are read from the refusal');
  assert.ok(root.includes('orderedSections(docs.draft)'), 'one card per top-level key, in the contract’s order');
  assert.ok(root.includes('<PublicPreview') && root.includes('<PlayersPanel'), 'public preview and players are on the page');
  assert.equal(/from '[^']*worker\//.test(allSource()), false, 'the client imports no server module — the defaults come from the response');

  const admin = read('src/pages/Admin.tsx');
  assert.match(admin, /\|\s*'printer_farm'/, 'AdminTab has printer_farm');
  assert.ok(admin.includes("id: 'printer_farm'"), 'the sidebar lists the farm');
  assert.ok(admin.includes("loc('مزرعة الطابعات', 'Printer Farm', 'کێڵگەی چاپکەر')"), 'the sidebar label is trilingual');
  assert.ok(admin.includes("{activeTab === 'printer_farm' && <AdminFarmConfig />}"), 'the tab renders the console');
  assert.match(admin, /import AdminFarmConfig from '\.\.\/components\/adminFarm\/AdminFarmConfig'/);
  assert.match(admin, /icon: Factory/, 'a lucide icon, not an emoji');
});
