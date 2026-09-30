/**
 * BlueprintSpec v1 — the merchant's blueprint (Programme C, C1 lane L1;
 * docs/LEVO_PROJECT_PROGRAMME.md §B.1 «Shapes», §0 rows 5–7 and 39).
 *
 * Pins: every fixture archetype is already normal (a round trip returns it);
 * absent optional fields take their documented defaults; every limit; every
 * reference the spec can resolve, with its JSON path; unknown keys; kit
 * options refused in C1; photo-only blueprints; frames; price-word and
 * reserved ids; the text rule on samples; `publicSpecOf` leaves nothing
 * private; and the closed vocabularies with their three languages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BLUEPRINT_LIMITS, hiddenParts, isPhotoOnly, normalizeBlueprint, publicSpecOf, sizeOrder, type NormalizeBlueprintOptions } from '../packages/catalog/src/personalize/spec';
import type { BlueprintSpec, EngineIssue } from '../packages/catalog/src/personalize/types';
import {
  CHECK_CODES, ICON_KEYS, PAINT_KEYS, SAY_CODES, VOCAB, checkGroup, colorWord, isTag, slotKindWord, vocabWord, word, LOOK_WORDS, LOOKS, type VocabName,
} from '../packages/catalog/src/personalize/vocab';
import { PART_KINDS } from '../packages/catalog/src/personalize/parts';
import { SWATCHES, SWATCH_NAMES, SWATCH_NAMES_CKB } from '../packages/catalog/src/palette';
import { FIXTURES, NAME_STAND, NAME_KEYCHAIN, PHOTO_ONLY_SIGN, PRIVATE_MARKERS, QR_MENU_STAND, ROTATING_DISPLAY, front } from './fixtures/personalizeBlueprints';

const ROOT = join(import.meta.dirname, '..');
const clone = <T>(v: T): T => structuredClone(v);
type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The errors of a refused spec (fails the test when it was accepted). */
function refused(raw: unknown, opts?: NormalizeBlueprintOptions): EngineIssue[] {
  const r = normalizeBlueprint(raw, opts);
  assert.equal(r.ok, false, `expected a refusal, got ${JSON.stringify(r.ok ? r.value : null).slice(0, 200)}`);
  return r.ok ? [] : r.errors ?? [];
}
/** Refused with this code at this path (among the others). */
function refusedAt(raw: unknown, path: string, code: string, opts?: NormalizeBlueprintOptions): void {
  const errors = refused(raw, opts);
  assert.ok(errors.some((e) => e.path === path && e.code === code), `expected ${code} at «${path}», got ${JSON.stringify(errors)}`);
}
const accepted = (raw: unknown, opts?: NormalizeBlueprintOptions): BlueprintSpec => {
  const r = normalizeBlueprint(raw, opts);
  assert.ok(r.ok, `refused: ${JSON.stringify(r.ok ? null : r.errors)}`);
  return r.ok ? r.value : (null as never);
};
const minimal = (): Raw => ({ v: 1, regions: [{ id: 'body', role: 'body', parts: [0], tone: 'primary', paint: { allowed: 'all', default: 'black' } }], colors: { included: 1, per_extra_iqd: 0, max: 2 }, sell: { cart: true } });
const nameStand = (): Raw => clone(NAME_STAND) as Raw;

// ------------------------------------------------------------ round trips

test('every fixture blueprint is already normal: the round trip returns it, with and without the resolving options', () => {
  for (const f of Object.values(FIXTURES)) {
    assert.deepEqual(accepted(clone(f.spec), f.opts), f.spec, `${f.name} with its options`);
    assert.deepEqual(accepted(JSON.parse(JSON.stringify(f.spec))), f.spec, `${f.name} from JSON, no options`);
  }
  assert.equal(isPhotoOnly(PHOTO_ONLY_SIGN), true);
  assert.equal(isPhotoOnly(NAME_STAND), false);
  assert.deepEqual(sizeOrder(NAME_STAND), ['ov_s', 'ov_m', 'ov_l']);
  assert.deepEqual(sizeOrder(QR_MENU_STAND), []);
});

test('an absent optional field takes its documented default; v, regions, colors and sell have none', () => {
  const s = accepted(minimal());
  assert.deepEqual(
    { areas: s.areas, axes: s.axes, themes: s.themes, slots: s.slots, fixed: s.fixed, rules: s.rules, extras: s.extras, photos: s.photos, licence: s.licence, warranty_days: s.warranty_days, prep_days_add: s.prep_days_add, family: s.family, tags: s.tags, private: s.private, sell: s.sell },
    { areas: [], axes: {}, themes: 'all', slots: [], fixed: [], rules: [], extras: { nfc: null, roster: null }, photos: [], licence: 'remix', warranty_days: 0, prep_days_add: {}, family: 'other', tags: [], private: {}, sell: { cart: true, request: false } }
  );
  assert.deepEqual(s.regions[0], { id: 'body', role: 'body', parts: [0], tone: 'primary', paint: { allowed: 'all', default: 'black' }, optional: null, shown_by: null });

  const raw = minimal();
  raw.regions.push({ id: 'plate', role: 'name', parts: [1], tone: 'text', paint: { allowed: 'all', default: 'white' } });
  raw.areas = [
    { id: 'name', kind: 'text', role: 'name', region: 'plate', frame: front(0, 40, 10), text: { max: 10, paint: { allowed: 'all', default: 'white' }, sample: { ar: 'علي', en: 'ALI', ckb: 'عەلی' } } },
    { id: 'logo', kind: 'logo', region: 'body', frame: front(20, 30, 30) },
    { id: 'qr', kind: 'qr', region: 'body', frame: front(-20, 30, 30), qr: { kinds: ['url'] } },
    { id: 'icon', kind: 'icon', region: 'body', frame: front(40, 10, 10) },
  ];
  raw.slots = [{ id: 'hook', kind: 'hook', options: [{ key: 'h1', part: { p: 'cp_hook', v: null } }] }];
  raw.fixed = [{ part: { p: 'cp_screw', v: null } }];
  raw.rules = [{ id: 'r1', if: { text: 'name', longer_than: 8 }, then: { max_colors: 2 }, say: 'fewer_colors' }];
  const d = accepted(raw);
  assert.deepEqual(d.areas[0].text, { lines: 1, max: 10, count: 1, styles: 'all', default_style: 'bold', min_cap_mm: 4, paint: { allowed: 'all', default: 'white' }, sample: { ar: 'علي', en: 'ALI', ckb: 'عەلی' } });
  assert.deepEqual([d.areas[0].required, d.areas[0].fee_iqd], [false, 0]);
  assert.deepEqual(d.areas[1].logo, { max_colors: 2, modes: ['flat'] });
  assert.equal(d.areas[1].role, 'logo', 'a non-text area plays its own kind');
  assert.deepEqual(d.areas[2].qr, { kinds: ['url'], min_module_mm: 1 });
  assert.deepEqual(d.areas[3].icon, { keys: 'all' });
  assert.deepEqual(d.slots[0], { id: 'hook', kind: 'hook', qty: 1, required: false, choice: 'customer', pricing: 'add', options: [{ key: 'h1', part: { p: 'cp_hook', v: null } }] });
  assert.deepEqual(d.fixed[0], { part: { p: 'cp_screw', v: null }, qty: 1, show: false }, 'a fixed part is a hidden production material unless shown');
  assert.equal(d.rules[0].fix, 'suggest');

  for (const key of ['v', 'regions', 'colors', 'sell']) {
    const r = minimal();
    delete r[key];
    refusedAt(r, key, 'REQUIRED');
  }
  refusedAt({ ...minimal(), v: 2 }, 'v', 'INVALID');
  refusedAt({ ...minimal(), regions: [] }, 'regions', 'REQUIRED');
  refusedAt({ ...minimal(), sell: { cart: false, request: false } }, 'sell', 'REQUIRED');
  for (const raw of [null, [], 'spec', 7]) refusedAt(raw, '', 'TYPE');
});

// ---------------------------------------------------------------- limits

test('BLUEPRINT_LIMITS are the programme\'s numbers', () => {
  assert.deepEqual(
    [BLUEPRINT_LIMITS.bytes, BLUEPRINT_LIMITS.regions, BLUEPRINT_LIMITS.areas, BLUEPRINT_LIMITS.parts, BLUEPRINT_LIMITS.slots, BLUEPRINT_LIMITS.options, BLUEPRINT_LIMITS.fixed, BLUEPRINT_LIMITS.rules, BLUEPRINT_LIMITS.label, BLUEPRINT_LIMITS.fee],
    [65536, 16, 4, 64, 8, 12, 8, 24, 60, 50_000_000]
  );
});

test('every count limit is refused at its path', () => {
  const region = (i: number) => ({ id: `r${i}`, role: 'body', parts: [i], tone: 'primary', paint: { allowed: 'all', default: 'black' } });
  refusedAt({ ...minimal(), regions: Array.from({ length: 17 }, (_, i) => region(i)) }, 'regions', 'TOO_MANY');
  assert.ok(accepted({ ...minimal(), regions: Array.from({ length: 16 }, (_, i) => region(i)) }), '16 regions are fine');

  const area = (i: number) => ({ id: `a${i}`, kind: 'icon', region: 'body', frame: front(i * 5, 10, 10) });
  refusedAt({ ...minimal(), areas: Array.from({ length: 5 }, (_, i) => area(i)) }, 'areas', 'TOO_MANY');
  assert.ok(accepted({ ...minimal(), areas: Array.from({ length: 4 }, (_, i) => area(i)) }));

  const slot = (i: number, options = 1) => ({ id: `s${i}`, kind: 'magnet', options: Array.from({ length: options }, (_, j) => ({ key: `o${j}`, part: { p: 'cp_m', v: `pv_${j}` } })) });
  refusedAt({ ...minimal(), slots: Array.from({ length: 9 }, (_, i) => slot(i)) }, 'slots', 'TOO_MANY');
  refusedAt({ ...minimal(), slots: [slot(0, 13)] }, 'slots.0.options', 'TOO_MANY');
  assert.ok(accepted({ ...minimal(), slots: Array.from({ length: 8 }, (_, i) => slot(i, 12)) }), '8 slots × 12 options');
  refusedAt({ ...minimal(), slots: [slot(0, 0)] }, 'slots.0.options', 'REQUIRED');

  refusedAt({ ...minimal(), fixed: Array.from({ length: 9 }, () => ({ part: { p: 'cp_x', v: null } })) }, 'fixed', 'TOO_MANY');
  const rule = (i: number) => ({ id: `rule${i}`, if: { value: 'ov_s' }, then: { max_colors: 2 }, say: 'fewer_colors' });
  const withSize = { ...minimal(), axes: { size: { group: 'og', values: { ov_s: { dims_mm: [10, 10, 10], scale: 1 } } } } };
  refusedAt({ ...withSize, rules: Array.from({ length: 25 }, (_, i) => rule(i)) }, 'rules', 'TOO_MANY');
  assert.ok(accepted({ ...withSize, rules: Array.from({ length: 24 }, (_, i) => rule(i)) }));
  refusedAt({ ...minimal(), photos: Array.from({ length: 13 }, (_, i) => ({ media_id: `pm_${i}` })) }, 'photos', 'TOO_MANY');
  refusedAt({ ...minimal(), tags: Array.from({ length: 13 }, () => 'biz') }, 'tags', 'TOO_MANY');
  refusedAt({ ...minimal(), tags: ['biz', 'biz'] }, 'tags.1', 'DUPLICATE');
  refusedAt({ ...minimal(), tags: ['occ:christmas'] }, 'tags.0', 'INVALID');

  // Part indices: < 64 always, < partCount when the mesh is known.
  refusedAt({ ...minimal(), regions: [{ ...region(0), parts: [64] }] }, 'regions.0.parts.0', 'RANGE');
  refusedAt({ ...minimal(), regions: [{ ...region(0), parts: [3] }] }, 'regions.0.parts.0', 'RANGE', { partCount: 3 });
  refusedAt({ ...minimal(), regions: [{ ...region(0), parts: [0, 0] }] }, 'regions.0.parts.1', 'DUPLICATE');
  refusedAt({ ...minimal(), regions: [region(0), { ...region(1), parts: [0] }] }, 'regions.1.parts.0', 'DUPLICATE');
  assert.ok(accepted(minimal(), { partCount: 2 }), 'a part no region takes is hidden, not an error (the publish strips it)');
  assert.deepEqual(hiddenParts(accepted(minimal()), 3), [1, 2]);
  assert.deepEqual(hiddenParts(ROTATING_DISPLAY, 4), [3], 'a slot\'s marker part is not hidden');
  assert.deepEqual(hiddenParts({ ...ROTATING_DISPLAY, regions: ROTATING_DISPLAY.regions.slice(0, 2) }, 3), [], 'the marker part stays for its slot');
  assert.deepEqual(hiddenParts(PHOTO_ONLY_SIGN, 0), []);
  refusedAt({ ...minimal(), regions: [{ ...region(0), parts: [0.5] }] }, 'regions.0.parts.0', 'TYPE');
});

test('numbers out of range are errors — nothing is clamped', () => {
  const s = nameStand();
  s.warranty_days = 3651;
  s.prep_days_add = { tier_best: 31 };
  s.slots[0].qty = 21;
  s.areas[0].text.lines = 5;
  s.areas[0].text.max = 41;
  s.areas[0].text.count = 5;
  s.areas[0].text.min_cap_mm = 0.1;
  s.colors = { included: 5, per_extra_iqd: 0, max: 4 };
  const errors = refused(s);
  for (const [path, code] of [
    ['warranty_days', 'RANGE'], ['prep_days_add.tier_best', 'RANGE'], ['slots.0.qty', 'RANGE'], ['areas.0.text.lines', 'RANGE'], ['areas.0.text.max', 'RANGE'],
    ['areas.0.text.count', 'RANGE'], ['areas.0.text.min_cap_mm', 'RANGE'], ['colors.included', 'RANGE'],
  ]) assert.ok(errors.some((e) => e.path === path && e.code === code), `${code} at ${path}: ${JSON.stringify(errors)}`);

  const g = clone(FIXTURES.groupParticipant.spec) as Raw;
  g.extras.roster.max = 101;
  refusedAt(g, 'extras.roster.max', 'RANGE');
  const q = clone(QR_MENU_STAND) as Raw;
  q.areas[0].logo.max_colors = 5;
  q.areas[1].qr.min_module_mm = 0.2;
  const qe = refused(q);
  assert.ok(qe.some((e) => e.path === 'areas.0.logo.max_colors' && e.code === 'RANGE'));
  assert.ok(qe.some((e) => e.path === 'areas.1.qr.min_module_mm' && e.code === 'RANGE'));
  const sz = nameStand();
  sz.axes.size.values.ov_s.dims_mm = [0, 10, 10];
  sz.axes.size.values.ov_m.scale = 0;
  const se = refused(sz);
  assert.ok(se.some((e) => e.path === 'axes.size.values.ov_s.dims_mm' && e.code === 'RANGE'));
  assert.ok(se.some((e) => e.path === 'axes.size.values.ov_m.scale' && e.code === 'RANGE'));
});

test('fees are non-negative safe integers up to 50,000,000 — BLUEPRINT_PRICE_INVALID when only a fee is wrong', () => {
  for (const bad of [-1, 1.5, 50_000_001, '1000', Number.MAX_SAFE_INTEGER + 2, NaN]) {
    const s = nameStand();
    s.areas[0].fee_iqd = bad;
    const r = normalizeBlueprint(s);
    assert.equal(r.ok, false, String(bad));
    if (!r.ok) {
      assert.equal(r.code, 'BLUEPRINT_PRICE_INVALID', String(bad));
      assert.deepEqual(r.errors, [{ path: 'areas.0.fee_iqd', code: 'PRICE' }]);
    }
  }
  const s = nameStand();
  s.areas[0].fee_iqd = 50_000_000;
  s.regions[2].paint.premium.gold = 0;
  assert.ok(accepted(s));
  for (const [set, path] of [
    [(x: Raw) => (x.regions[2].paint.premium.gold = -5), 'regions.2.paint.premium.gold'],
    [(x: Raw) => (x.colors.per_extra_iqd = 0.5), 'colors.per_extra_iqd'],
    [(x: Raw) => (x.regions[0].optional = { on: false, fee_iqd: -1 }), 'regions.0.optional.fee_iqd'],
  ] as const) {
    const x = nameStand();
    set(x);
    refusedAt(x, path, 'PRICE');
  }
  const k = clone(QR_MENU_STAND) as Raw;
  k.extras.nfc.fee_iqd = -3500;
  refusedAt(k, 'extras.nfc.fee_iqd', 'PRICE');
  const mixed = nameStand();
  mixed.areas[0].fee_iqd = -1;
  mixed.family = 'rocket';
  assert.equal((normalizeBlueprint(mixed) as { code: string }).code, 'BLUEPRINT_INVALID', 'a fee among other errors is BLUEPRINT_INVALID');
});

test('a spec over 64 KB is refused before it is read', () => {
  const r = normalizeBlueprint({ ...minimal(), junk: 'x'.repeat(4 * 65536) }, { strict: false });
  assert.deepEqual(r, { ok: false, code: 'BLUEPRINT_INVALID', path: '', errors: [{ path: '', code: 'TOO_LARGE' }] });
  const big = nameStand();
  big.private.notes = 'n'.repeat(500);
  assert.ok(accepted(big), 'the largest legal note is fine');
  big.private.notes = 'n'.repeat(501);
  refusedAt(big, 'private.notes', 'TOO_LONG');
});

// ------------------------------------------------------------ references

test('every reference inside the spec is resolved, with the path of the one that is not', () => {
  const cases: Array<[(s: Raw) => void, string, string]> = [
    [(s) => (s.areas[0].region = 'lid'), 'areas.0.region', 'UNKNOWN_REF'],
    [(s) => (s.rules[0].if.text = 'motto'), 'rules.0.if.text', 'UNKNOWN_REF'],
    [(s) => (s.rules[1].if.is = 'm99'), 'rules.1.if.is', 'UNKNOWN_REF'],
    [(s) => (s.rules[1].if.slot = 'lighting'), 'rules.1.if.slot', 'UNKNOWN_REF'],
    [(s) => (s.rules[0].then.size_at_least = 'ov_classic'), 'rules.0.then.size_at_least', 'UNKNOWN_REF'],
    [(s) => (s.rules[2].if.value = 'ov_xl'), 'rules.2.if.value', 'UNKNOWN_REF'],
    [(s) => (s.rules[2].then.only_colors.target = 'lid'), 'rules.2.then.only_colors.target', 'UNKNOWN_REF'],
    [(s) => (s.rules[2].then.only_colors.keys = ['black', 'rainbow']), 'rules.2.then.only_colors.keys.1', 'INVALID'],
    [(s) => (s.rules[0].if = { text: 'name', longer_than: 10, value: 'ov_s' }), 'rules.0.if', 'INVALID'],
    [(s) => (s.rules[0].then = { size_at_least: 'ov_m', max_colors: 2 }), 'rules.0.then', 'INVALID'],
    [(s) => (s.rules[0].if = { value: 'ov_s', is: 'm10' }), 'rules.0.if.is', 'NOT_ALLOWED'],
    [(s) => (s.rules[0].say = 'because'), 'rules.0.say', 'INVALID'],
    [(s) => (s.regions[1].shown_by = 'lighting'), 'regions.1.shown_by', 'UNKNOWN_REF'],
    [(s) => (s.regions[1].shown_by = 'magnet:m99'), 'regions.1.shown_by', 'UNKNOWN_REF'],
    [(s) => (s.regions[1].shown_by = 'magnet:m10:x'), 'regions.1.shown_by', 'UNKNOWN_REF'],
    [(s) => (s.prep_days_add.size = { ov_xl: 1 }), 'prep_days_add.size.ov_xl', 'UNKNOWN_REF'],
    [(s) => (s.prep_days_add.size = { ov_silk: 1 }), 'prep_days_add.size.ov_silk', 'UNKNOWN_REF'],
    [(s) => (s.slots[0].default = 'm99'), 'slots.0.default', 'UNKNOWN_REF'],
    [(s) => (s.slots[0].required = true), 'slots.0.default', 'REQUIRED'],
    [(s) => (s.slots[0].choice = 'fixed'), 'slots.0.default', 'REQUIRED'],
    [(s) => (s.slots[0].options[1].key = 'm10'), 'slots.0.options.1.key', 'DUPLICATE'],
    [(s) => (s.regions[2].paint.default = 'red'), 'regions.2.paint.default', 'NOT_ALLOWED'],
    [(s) => (s.regions[2].paint.premium = { red: 500 }), 'regions.2.paint.premium.red', 'NOT_ALLOWED'],
    [(s) => (s.regions[2].paint.default = 'multi'), 'regions.2.paint.default', 'INVALID'],
    [(s) => (s.regions[0].paint.allowed = []), 'regions.0.paint.allowed', 'REQUIRED'],
    [(s) => (s.regions[0].paint.allowed = ['black', 'black']), 'regions.0.paint.allowed.1', 'DUPLICATE'],
    [(s) => (s.areas[0].text.styles = ['fun', 'kids']), 'areas.0.text.default_style', 'INVALID'],
    [(s) => (s.areas[0].id = 'body'), 'areas.0.id', 'DUPLICATE'],
    [(s) => (s.rules[0].id = 'magnet'), 'rules.0.id', 'DUPLICATE'],
    [(s) => (s.axes.size.values.ov_l.recommended = true), 'axes.size.values.ov_l.recommended', 'DUPLICATE'],
    [(s) => (s.axes.look.group = 'og_size'), 'axes.look.group', 'DUPLICATE'],
    [(s) => (s.axes.look.values.ov_m = { look: 'silk', material_id: 'pla' }), 'axes.look.values.ov_m', 'DUPLICATE'],
    [(s) => (s.axes.look.values.ov_silk.material_id = 'PLA Silk'), 'axes.look.values.ov_silk.material_id', 'INVALID'],
    [(s) => (s.axes.look.values.ov_silk.look = 'neon'), 'axes.look.values.ov_silk.look', 'INVALID'],
  ];
  for (const [set, path, code] of cases) {
    const s = nameStand();
    set(s);
    refusedAt(s, path, code);
  }
  const shown = nameStand();
  shown.regions[1].shown_by = 'magnet:m15';
  assert.ok(accepted(shown), 'a region shown by one option of a slot');
  shown.regions[1].shown_by = 'magnet';
  assert.ok(accepted(shown), 'a region shown by any option of a slot');

  const k = clone(NAME_KEYCHAIN) as Raw;
  k.regions[1].shown_by = 'badge:rocket';
  refusedAt(k, 'regions.1.shown_by', 'UNKNOWN_REF');
  k.regions[1].shown_by = 'badge';
  refusedAt(k, 'regions.1.shown_by', 'UNKNOWN_REF', {});
  const roster = clone(FIXTURES.groupParticipant.spec) as Raw;
  roster.extras.roster.vary = ['nickname'];
  refusedAt(roster, 'extras.roster.vary.0', 'UNKNOWN_REF');
  roster.extras.roster.vary = [];
  refusedAt(roster, 'extras.roster.vary', 'REQUIRED');
});

test('the axes annotate the product\'s own option groups — every value, nothing else', () => {
  const opts = FIXTURES.nameStand.opts;
  const missing = { ...opts, variantGroups: { ...opts.variantGroups, og_size: ['ov_s', 'ov_m', 'ov_l', 'ov_xl'] } };
  refusedAt(nameStand(), 'axes.size.values.ov_xl', 'REQUIRED', missing);
  const extra = nameStand();
  extra.axes.size.values.ov_xl = { dims_mm: [200, 140, 160], scale: 1.4 };
  refusedAt(extra, 'axes.size.values.ov_xl', 'UNKNOWN_REF', opts);
  refusedAt(nameStand(), 'axes.look.group', 'UNKNOWN_REF', { ...opts, variantGroups: { og_size: opts.variantGroups.og_size } });
  refusedAt({ ...minimal(), axes: { tier: { group: 'og_t', values: {} } } }, 'axes.tier.values', 'REQUIRED');
  refusedAt({ ...minimal(), axes: { size: { group: 'og', values: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`ov_${i}`, { dims_mm: [10, 10, 10], scale: 1 }])) } } }, 'axes.size.values', 'TOO_MANY');
  refusedAt({ ...minimal(), axes: { finish: { group: 'og', values: {} } } }, 'axes.finish', 'UNKNOWN_KEY');
});

test('unknown keys are refused at their path — and ignored when not strict', () => {
  const cases: Array<[(s: Raw) => void, string]> = [
    [(s) => (s.sizes = [{ key: 's' }]), 'sizes'],
    [(s) => (s.gift = { wrap_iqd: 2000 }), 'gift'],
    [(s) => (s.regions[0].colour = 'red'), 'regions.0.colour'],
    [(s) => (s.areas[0].make = 'raised'), 'areas.0.make'],
    [(s) => (s.areas[0].text.font = 'Cairo'), 'areas.0.text.font'],
    [(s) => (s.slots[0].options[0].price_iqd = 900), 'slots.0.options.0.price_iqd'],
    [(s) => (s.rules[0].auto = true), 'rules.0.auto'],
    [(s) => (s.extras.space = true), 'extras.space'],
    [(s) => (s.private.cost_iqd = 4000), 'private.cost_iqd'],
  ];
  for (const [set, path] of cases) {
    const s = nameStand();
    set(s);
    refusedAt(s, path, 'UNKNOWN_KEY');
    assert.deepEqual(accepted(s, { strict: false }), NAME_STAND, `${path} is dropped when not strict`);
  }
});

test('a kit option is refused in C1; a Levonis part reference is accepted by the shape', () => {
  const s = nameStand();
  s.slots[0].options.push({ key: 'kit', kit: 'kit_led_lamp' });
  refusedAt(s, 'slots.0.options.2.kit', 'NOT_ALLOWED');
  const l = nameStand();
  l.slots[0].options[0].part = { p: 'prod_levonis_1', v: null, src: 'levonis' };
  assert.equal(accepted(l).slots[0].options[0].part.src, 'levonis');
  l.slots[0].options[0].part.src = 'amazon';
  refusedAt(l, 'slots.0.options.0.part.src', 'INVALID');
  const acc = nameStand();
  acc.slots[0].accepts = { shape: 'hexagon', diameter_mm: { min: 20, max: 10 }, voltage: -5 };
  const errors = refused(acc);
  for (const path of ['slots.0.accepts.shape', 'slots.0.accepts.diameter_mm', 'slots.0.accepts.voltage']) assert.ok(errors.some((e) => e.path === path), path);
  acc.slots[0].accepts = { kind: ['magnet', 'insert'], shape: ['round', 'ring'], diameter_mm: 10, voltage: { max: 12 } };
  assert.deepEqual(accepted(acc).slots[0].accepts, { kind: ['magnet', 'insert'], shape: ['round', 'ring'], diameter_mm: 10, voltage: { max: 12 } });
  const show = nameStand();
  show.slots[0].show = { effect: 'visible' };
  refusedAt(show, 'slots.0.show', 'REQUIRED');
  show.slots[0].show = { effect: 'glow' };
  refusedAt(show, 'slots.0.show', 'REQUIRED');
  show.slots[0].show = { effect: 'visible', part: 9 };
  refusedAt(show, 'slots.0.show.part', 'RANGE', { partCount: 3 });
  show.slots[0].show = { effect: 'sparkle', part: 1 };
  refusedAt(show, 'slots.0.show.effect', 'INVALID');
});

test('a photo-only blueprint has photos and draws its areas on one of them; a model blueprint has frames', () => {
  const p = clone(PHOTO_ONLY_SIGN) as Raw;
  p.photos = [];
  const e1 = refused(p);
  assert.ok(e1.some((e) => e.path === 'photos' && e.code === 'REQUIRED'));
  assert.ok(e1.some((e) => e.path === 'areas.0.photo_frame.media_id' && e.code === 'UNKNOWN_REF'));
  const noFrame = clone(PHOTO_ONLY_SIGN) as Raw;
  delete noFrame.areas[0].photo_frame;
  refusedAt(noFrame, 'areas.0.photo_frame', 'REQUIRED');
  const both = clone(PHOTO_ONLY_SIGN) as Raw;
  both.areas[0].frame = front(0, 10, 10);
  refusedAt(both, 'areas.0.frame', 'NOT_ALLOWED');
  const flat = clone(PHOTO_ONLY_SIGN) as Raw;
  flat.areas[0].photo_frame.quad = [[0.2, 0.2], [0.2, 0.2], [0.2, 0.2], [0.2, 0.2]];
  refusedAt(flat, 'areas.0.photo_frame.quad', 'INVALID');
  flat.areas[0].photo_frame.quad = [[0.2, 0.2], [1.2, 0.2], [0.8, 0.5], [0.2, 0.5]];
  refusedAt(flat, 'areas.0.photo_frame.quad', 'TYPE');
  const media = clone(PHOTO_ONLY_SIGN) as Raw;
  refusedAt(media, 'photos.0.media_id', 'UNKNOWN_REF', { mediaIds: ['pm_white', 'pm_wood', 'pm_large'] });
  media.photos[3].value_id = 'ov_xl';
  refusedAt(media, 'photos.3.value_id', 'UNKNOWN_REF');
  media.photos[3] = { ...media.photos[0] };
  refusedAt(media, 'photos.3', 'DUPLICATE');
  const shown = clone(PHOTO_ONLY_SIGN) as Raw;
  shown.slots = [{ id: 'hook', kind: 'hook', options: [{ key: 'h', part: { p: 'cp_hook', v: null } }], show: { effect: 'ring', anchor: front(0, 5, 5) } }];
  refusedAt(shown, 'slots.0.show', 'NOT_ALLOWED');

  const mixed = nameStand();
  mixed.regions[1].parts = [];
  refusedAt(mixed, 'regions.1.parts', 'REQUIRED');
  const model = nameStand();
  delete model.areas[0].frame;
  refusedAt(model, 'areas.0.frame', 'REQUIRED');
  model.areas[0].photo_frame = { media_id: 'pm_1', quad: [[0, 0], [1, 0], [1, 1], [0, 1]] };
  refusedAt(model, 'areas.0.photo_frame', 'NOT_ALLOWED');
});

test('a frame is finite millimetres with a normal across its up — inside the mesh box × 1.05 when the box is known', () => {
  const cases: Array<[(f: Raw) => void, string, string]> = [
    [(f) => (f.n = [0, 0, 1]), 'areas.0.frame', 'INVALID'],
    [(f) => (f.n = [0, 0, 0]), 'areas.0.frame', 'INVALID'],
    [(f) => (f.o = [0, NaN, 0]), 'areas.0.frame.o', 'TYPE'],
    [(f) => (f.o = [0, 1e9, 0]), 'areas.0.frame.o', 'RANGE'],
    [(f) => (f.o = [0, 0]), 'areas.0.frame.o', 'TYPE'],
    [(f) => (f.w = 0), 'areas.0.frame.w', 'RANGE'],
    [(f) => (f.h = Infinity), 'areas.0.frame.h', 'TYPE'],
  ];
  for (const [set, path, code] of cases) {
    const s = nameStand();
    set(s.areas[0].frame);
    refusedAt(s, path, code);
  }
  const box = FIXTURES.nameStand.opts;
  const s = nameStand();
  s.areas[0].frame.o = [0, -60, 20];
  refusedAt(s, 'areas.0.frame.o', 'RANGE', box);
  s.areas[0].frame.o = [0, -52, 20];
  assert.ok(accepted(s, box), '−52 mm is inside ±50 × 1.05');
  s.areas[0].frame.w = 300;
  refusedAt(s, 'areas.0.frame', 'RANGE', box);
});

test('ids are short slugs, unique across the spec, never a price word or a prototype name', () => {
  for (const bad of ['Body', 'price', 'total_iqd', 'unit', 'base-fee', 'constructor', '9lives', 'a'.repeat(33), '', 'بدن']) {
    const s = nameStand();
    s.regions[0].id = bad;
    refusedAt(s, 'regions.0.id', 'INVALID');
  }
  const proto = nameStand();
  proto.axes.size.values = JSON.parse('{"__proto__": {"dims_mm": [1, 1, 1], "scale": 1}, "ov_m": {"dims_mm": [150, 100, 120], "scale": 1}}');
  refusedAt(proto, 'axes.size.values.__proto__', 'INVALID');
  assert.equal(({} as Raw).dims_mm, undefined, 'no prototype was touched');
  const slug = nameStand();
  slug.slots[0].options[0].key = 'fee';
  refusedAt(slug, 'slots.0.options.0.key', 'INVALID');
});

test('a sample obeys the text rule and the area\'s length; a label is ≤ 60 plain characters in three languages', () => {
  const cases: Array<[(s: Raw) => void, string, string]> = [
    [(s) => (s.areas[0].text.sample.en = 'ALI 😀'), 'areas.0.text.sample.en', 'INVALID'],
    [(s) => (s.areas[0].text.sample.ar = '‮علي'), 'areas.0.text.sample.ar', 'INVALID'],
    [(s) => (s.areas[0].text.sample.ckb = 'عەلی عەلی عەلی'), 'areas.0.text.sample.ckb', 'TOO_LONG'],
    [(s) => delete s.areas[0].text.sample.ckb, 'areas.0.text.sample.ckb', 'REQUIRED'],
    [(s) => (s.slots[0].label = { ar: 'مغناطيس', en: 'M'.repeat(61), ckb: 'موگناتیس' }), 'slots.0.label.en', 'TOO_LONG'],
    [(s) => (s.slots[0].label = { ar: 'مغناطيس⁦', en: 'Magnet', ckb: 'موگناتیس' }), 'slots.0.label.ar', 'INVALID'],
    [(s) => (s.slots[0].label = { ar: 'مغناطيس', en: 'Magnet' }), 'slots.0.label.ckb', 'REQUIRED'],
    [(s) => (s.private.quality_notes.best = 'line\nbreak'), 'private.quality_notes.best', 'INVALID'],
  ];
  for (const [set, path, code] of cases) {
    const s = nameStand();
    set(s);
    refusedAt(s, path, code);
  }
  const s = nameStand();
  s.slots[0].label = { ar: '  مغناطيس  دائري ', en: 'Round magnet', ckb: 'موگناتیسی خڕ' };
  assert.deepEqual(accepted(s).slots[0].label, { ar: 'مغناطيس دائري', en: 'Round magnet', ckb: 'موگناتیسی خڕ' }, 'spaces tidied, never clamped');
});

// ------------------------------------------------------------- public spec

test('publicSpecOf leaves out private, the hidden fixed parts and what a slot accepts — and nothing else', () => {
  for (const f of Object.values(FIXTURES)) {
    const before = JSON.stringify(f.spec);
    const pub = publicSpecOf(f.spec);
    assert.equal(JSON.stringify(f.spec), before, `${f.name}: the spec is not mutated`);
    const text = JSON.stringify(pub);
    for (const marker of PRIVATE_MARKERS) assert.ok(!text.includes(marker), `${f.name}: «${marker}» leaked`);
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          keys.push(k);
          walk(x);
        }
      }
    };
    walk(pub);
    for (const k of ['private', 'quality_notes', 'notes', 'accepts']) assert.ok(!keys.includes(k), `${f.name}: key «${k}»`);
    assert.deepEqual(pub.fixed, f.spec.fixed.filter((x) => x.show));
    const { private: _p, slots: _s, fixed: _f, ...rest } = f.spec;
    const { slots: _ps, fixed: _pf, ...pubRest } = pub;
    assert.deepEqual(pubRest, rest, `${f.name}: everything else is public as it is`);
    assert.deepEqual(pub.slots.map((x) => x.id), f.spec.slots.map((x) => x.id));
  }
  assert.deepEqual(publicSpecOf(NAME_STAND).fixed, [{ part: { p: 'cp_felt_pads', v: null }, qty: 4, show: true }]);
  assert.equal(publicSpecOf(ROTATING_DISPLAY).fixed.length, 0);
});

// ------------------------------------------------------------ vocabularies

const ARABIC_ONLY = /[ةيكىثذصضطظأإآؤ]/;

test('every closed vocabulary has a word per key in Arabic, English and written Sorani', () => {
  for (const [name, [keys, words]] of Object.entries(VOCAB) as Array<[VocabName, (typeof VOCAB)[VocabName]]>) {
    const [ar, en, ckb] = words.map((w) => w.split('|'));
    for (const [lang, list] of [['ar', ar], ['en', en], ['ckb', ckb]] as const) assert.equal(list.length, keys.length, `${name}.${lang} has ${list.length} words for ${keys.length} keys`);
    keys.forEach((key: string, i: number) => {
      assert.ok(ar[i].trim() && en[i].trim() && ckb[i].trim(), `${name}.${key} is empty somewhere`);
      assert.notEqual(en[i], ar[i], `${name}.${key}: en is the Arabic`);
      assert.notEqual(ckb[i], ar[i], `${name}.${key}: ckb is the Arabic pasted across`);
      assert.doesNotMatch(ckb[i], ARABIC_ONLY, `${name}.${key}: «${ckb[i]}» has a letter Sorani does not write`);
      assert.match(ar[i], /[؀-ۿ]/, `${name}.${key}: ar is Arabic`);
      assert.equal(vocabWord(name, key, 'ckb'), ckb[i]);
    });
    assert.equal(vocabWord(name, 'no-such-key', 'ar'), '');
  }
  assert.equal(word(LOOK_WORDS, LOOKS, 'silk', 'en'), 'Silk');
  assert.equal(word(LOOK_WORDS, LOOKS, 'silk', 'ckb'), 'ئاوریشمی');
  assert.equal(vocabWord('theme', 'ocean', 'ar'), 'محيط');
});

test('the colour names come from the palette, now with written Sorani; `multi` is a print, never a paint', () => {
  for (const k of SWATCHES) {
    assert.ok(SWATCH_NAMES_CKB[k]?.trim(), `${k} has a Sorani name`);
    assert.notEqual(SWATCH_NAMES_CKB[k], SWATCH_NAMES[k].ar, `${k}: ckb is the Arabic`);
    assert.doesNotMatch(SWATCH_NAMES_CKB[k], ARABIC_ONLY, `${k}: «${SWATCH_NAMES_CKB[k]}»`);
    assert.equal(colorWord(k, 'ckb'), SWATCH_NAMES_CKB[k]);
    assert.equal(colorWord(k, 'ar'), SWATCH_NAMES[k].ar);
    assert.equal(colorWord(k, 'en'), SWATCH_NAMES[k].en);
  }
  assert.equal(colorWord('rainbow', 'en'), '');
  assert.deepEqual(PAINT_KEYS, SWATCHES.filter((k) => k !== 'multi'));
  for (const kind of PART_KINDS) for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(slotKindWord(kind, lang), `${kind}.${lang}`);
});

test('the icon keys are lucide-react icons that ship in the dependency; tags and codes are closed lists', () => {
  assert.equal(ICON_KEYS.length, 24);
  for (const key of ICON_KEYS) assert.ok(existsSync(join(ROOT, 'node_modules/lucide-react/dist/esm/icons', `${key}.js`)), `lucide-react has no «${key}»`);
  for (const tag of ['biz', 'occ:birthday', 'occ:newroz', 'for:kids', 'for:team']) assert.equal(isTag(tag), true, tag);
  for (const tag of ['occ:christmas', 'for:', 'occ:birthday:x', 'OCC:birthday', 'kids', 7, null]) assert.equal(isTag(tag), false, String(tag));
  assert.equal(new Set(CHECK_CODES).size, CHECK_CODES.length);
  assert.deepEqual(
    ['TEXT_FITTED', 'RULE_ADJUSTED', 'SIZE_UP_FOR_TEXT', 'SIZE_UP_FOR_ADDON', 'LOGO_DETAIL', 'TOO_BIG_FOR_PRINTER', 'TEXT_TOO_LONG', 'RULE_UNMET'].map((c) => checkGroup(c as never)),
    ['fixed', 'fixed', 'suggest', 'suggest', 'review', 'review', 'blocked', 'blocked']
  );
  assert.equal(SAY_CODES.length, 7);
});
