/**
 * DesignConfig v1 — the customer's configuration (Programme C, C1 lane L1;
 * docs/LEVO_PROJECT_PROGRAMME.md §B.1 hop 2, P1, P11, P15; §F rows F4, F25).
 *
 * Pins: a fresh design for every fixture is valid and canonical; THE TEXT
 * RULE (Arabic, Sorani with each Kurdish letter, lam-alef, Arabic-Indic
 * digits accepted; bidi overrides, isolates, LRM/RLM/ALM, C0/C1, emoji and
 * symbols refused at the exact path); grapheme, line and name limits;
 * price-like keys refused at any depth (lenient mode too); unknown keys and
 * ids; QR and NFC targets; the size limits; the canonical form (key order,
 * NFC, defaults explicit) and its hash; lenient migration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_LIMITS, PRICE_LIKE_KEYS, defaultConfig, designTextOk, graphemeCount, graphemeCountFallback, isPriceLikeKey, normalizeConfig, normalizeTarget, plainTextOk,
  requiredMissing, textRuleAllows, textValues, type NormalizeConfigOptions,
} from '../packages/catalog/src/personalize/config';
import { canonicalJson, canonicalize, cleanLine, configHash, sha256Hex } from '../packages/catalog/src/personalize/canonical';
import type { BlueprintSpec, DesignConfig, EngineIssue, PublicBlueprint } from '../packages/catalog/src/personalize/types';
import { FIXTURES, GOLDEN_CONFIG, GROUP_PARTICIPANT, NAME_STAND, NAME_STAND_CONFIG } from './fixtures/personalizeBlueprints';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const clone = <T>(v: T): T => structuredClone(v);
const STAND = FIXTURES.nameStand.pub;
const QR = FIXTURES.qrMenuStand.pub;
const KEYCHAIN = FIXTURES.nameKeychain.pub;
const ROTATING = FIXTURES.rotatingDisplay.pub;
const GROUP = FIXTURES.groupParticipant.pub;

const ok = (raw: unknown, spec: BlueprintSpec | PublicBlueprint = STAND, opts?: NormalizeConfigOptions): DesignConfig => {
  const r = normalizeConfig(raw, spec, opts);
  assert.ok(r.ok, `refused: ${JSON.stringify(r.ok ? null : r)}`);
  return r.ok ? r.value : (null as never);
};
/** Refused (strict) with this top-level code and path; returns every error. */
function refused(raw: unknown, code: string, path: string, spec: BlueprintSpec | PublicBlueprint = STAND, opts?: NormalizeConfigOptions): EngineIssue[] {
  const r = normalizeConfig(raw, spec, opts);
  assert.equal(r.ok, false, `accepted ${JSON.stringify(raw).slice(0, 160)}`);
  if (r.ok) return [];
  assert.equal(r.code, code, `code for ${JSON.stringify(r.errors)}`);
  assert.equal(r.path, path, `path for ${JSON.stringify(r.errors)}`);
  return r.errors ?? [];
}
/** A filled name stand with one change. */
const stand = (set?: (c: Raw) => void): Raw => {
  const c = clone(NAME_STAND_CONFIG) as Raw;
  set?.(c);
  return c;
};
const named = (value: unknown[], set?: (c: Raw) => void) => stand((c) => {
  c.texts.name.value = value;
  set?.(c);
});

// ------------------------------------------------------------ fresh designs

test('a fresh design is valid and canonical for every fixture: the recommended size in stock, defaults everywhere, texts empty', () => {
  for (const f of Object.values(FIXTURES)) {
    const d = defaultConfig(f.pub);
    assert.deepEqual(ok(d, f.pub), d, `${f.name}: the default is its own canonical form`);
    assert.equal(canonicalJson(d), JSON.stringify(d), `${f.name}: keys already in order`);
    assert.equal(d.p, f.pub.product.id);
    assert.equal(d.rev, f.pub.rev);
    for (const t of Object.values(d.texts)) assert.deepEqual(t.value, [], `${f.name}: the sample is never copied`);
    const fromSpec = defaultConfig(f.spec, d.variant, { p: d.p, rev: d.rev });
    assert.deepEqual(fromSpec, d, `${f.name}: the same default from the merchant's spec`);
  }
  const d = defaultConfig(STAND);
  assert.equal(d.variant, 'pv_m_classic', 'Medium ⭐ Recommended, in stock');
  assert.deepEqual(d.colors, { base: 'white', body: 'black', name: 'black', plate: 'white' }, 'every region AND the text\'s own colour');
  assert.deepEqual(d.texts, { name: { style: 'bold', value: [] } });
  assert.deepEqual(d.slots, { magnet: { option: null } });
  assert.deepEqual(requiredMissing(d, STAND), ['texts.name']);
  assert.deepEqual(defaultConfig(ROTATING).slots, { lighting: { option: null }, magnet: { option: 'm10' }, motor: { option: 'a' } });
  assert.deepEqual(requiredMissing(defaultConfig(ROTATING), ROTATING), [], 'required slots start on their default');
  assert.deepEqual(defaultConfig(KEYCHAIN).parts, { ring: true }, 'an optional piece starts at its default');
  assert.deepEqual(requiredMissing(defaultConfig(QR), QR), ['logo.logo', 'qr.qr']);
  assert.equal(defaultConfig(ROTATING).variant, null, 'a product without variants');
  const soldOut = { ...STAND, variants: STAND.variants.map((v) => (v.id === 'pv_m_classic' ? { ...v, in_stock: false } : v)) };
  assert.equal(defaultConfig(soldOut).variant, 'pv_m_silk', 'the recommended size, in stock first');
  assert.equal(defaultConfig(STAND, 'pv_l_classic').variant, 'pv_l_classic');
});

test('the fixture configurations — the golden rotating display and a filled name stand — are valid and canonical', () => {
  assert.deepEqual(ok(clone(GOLDEN_CONFIG), ROTATING), GOLDEN_CONFIG);
  assert.deepEqual(ok(clone(NAME_STAND_CONFIG), STAND), NAME_STAND_CONFIG);
  assert.deepEqual(requiredMissing(NAME_STAND_CONFIG, STAND), []);
  const off = { ...clone(NAME_STAND), regions: NAME_STAND.regions.map((r) => (r.id === 'plate' ? { ...r, optional: { on: true, fee_iqd: 0 } } : r)) };
  const hidden = { ...defaultConfig(off, 'pv_m_classic', { p: 'cp_name_stand', rev: 3 }), parts: { plate: false } };
  assert.deepEqual(requiredMissing(hidden, off), [], 'a required name on a piece left off is not missing');
  assert.deepEqual(requiredMissing({ ...GOLDEN_CONFIG, slots: { ...GOLDEN_CONFIG.slots, motor: { option: null } } }, ROTATING), ['slots.motor']);
});

// ------------------------------------------------------------ the text rule

test('THE TEXT RULE accepts Arabic, Sorani with every Kurdish letter, lam-alef, Latin and the three digit sets', () => {
  const names = [
    'علي', 'فاطمة الزهراء', 'محمد', 'عبدالله', 'آمنة', 'مؤمن', 'هيئة', 'علاء', 'بلال', 'لا',
    'ڕۆژان', 'شێرکۆ', 'ڤیان', 'هەڵگورد', 'کەژاڵ', 'پەیمان', 'چنار', 'ئاسۆ', 'گوڵاڵە', 'ھێمن', 'ژینۆ',
    'ALI & SARA', "O'Neil", 'Zoë', 'José', 'Ali-Sara', 'Mr. Ali', 'Go! 10+',
    '٢٠٢٦', '۲۰۲۶', 'Team 7', 'بە‌خێر', 'علـــي', 'ماذا؟', 'Ali’s',
  ];
  const roomy: BlueprintSpec = { ...clone(NAME_STAND), areas: NAME_STAND.areas.map((a) => ({ ...a, text: { ...a.text!, max: 40 } })) };
  for (const n of names) {
    assert.equal(designTextOk(cleanLine(n)), true, `«${n}» should be printable`);
    assert.deepEqual(ok(named([n]), roomy, { variants: STAND.variants }).texts.name.value, [n.normalize('NFC')], `«${n}» is kept as typed`);
  }
  for (const k of ['ە', 'ۆ', 'ێ', 'ڕ', 'ڵ', 'ڤ', 'پ', 'چ', 'ژ', 'ک', 'گ', 'ی', 'ھ']) assert.equal(textRuleAllows(k.codePointAt(0)!), true, `Kurdish letter ${k}`);
  assert.equal(ok(named(['بە‌خێر'])).texts.name.value[0].includes('‌'), true, 'ZWNJ kept');
});

test('THE TEXT RULE refuses bidi overrides, isolates, LRM/RLM/ALM, C0/C1 controls, emoji and symbols — DESIGN_TEXT_INVALID at the exact path', () => {
  const bad: Array<[string, string]> = [
    ['‪', 'LRE'], ['‫', 'RLE'], ['‬', 'PDF'], ['‭', 'LRO'], ['‮', 'RLO'],
    ['⁦', 'LRI'], ['⁧', 'RLI'], ['⁨', 'FSI'], ['⁩', 'PDI'],
    ['‎', 'LRM'], ['‏', 'RLM'], ['؜', 'ALM'], ['​', 'ZWSP'], ['﻿', 'BOM'], [' ', 'NBSP'],
    ['\u0000', 'NUL'], ['\u0007', 'BEL'], ['\n', 'LF'], ['\t', 'TAB'], ['\u001B', 'ESC'], ['\u007F', 'DEL'], ['\u0080', 'C1'], ['\u0085', 'NEL'], ['\u009B', 'CSI'],
    ['😀', 'emoji'], ['❤️', 'heart + VS16'], ['👍🏽', 'skin tone'], ['🇮🇶', 'flag'], ['👨‍👩‍👧', 'ZWJ family'], ['★', 'star'], ['©', 'copyright'],
    ['@', 'at'], ['#', 'hash'], ['$', 'dollar'], ['%', 'percent'], ['*', 'asterisk'], ['/', 'slash'], ['<', 'lt'], ['=', 'equals'], ['_', 'underscore'], [',', 'comma'], ['"', 'quote'],
    ['َ', 'fatha'], ['ّ', 'shadda'], ['ﻻ', 'lam-alef presentation form'], ['\uD83D', 'lone surrogate'],
  ];
  for (const [ch, what] of bad) {
    refused(named([`AL${ch}I`]), 'DESIGN_TEXT_INVALID', 'texts.name.value.0');
    refused(named(['ALI', `علي${ch}`], (c) => (c.variant = 'pv_m_classic')), 'DESIGN_TEXT_INVALID', 'texts.name.value.1', {
      ...STAND, areas: STAND.areas.map((a) => ({ ...a, text: { ...a.text!, lines: 2 } })),
    });
    assert.equal(designTextOk(`AL${ch}I`), false, what);
  }
  for (const empty of ['!!!', '‌', '- -', 'ـــ']) refused(named([empty]), 'DESIGN_TEXT_INVALID', 'texts.name.value.0');
  const roster = clone(defaultConfig(GROUP)) as Raw;
  roster.roster = [{ n: 1, texts: { name: ['OMAR'] } }, { n: 2, texts: { name: ['SA‮RA'] } }];
  refused(roster, 'DESIGN_TEXT_INVALID', 'roster.1.texts.name.0', GROUP);
});

test('graphemes: at most the area\'s max; ZWNJ joins, lam-alef is two letters; the fallback never counts fewer than Intl.Segmenter', () => {
  assert.ok(ok(named(['ABCDEFGHIJKL'])), '12 letters fit a 12-letter area');
  refused(named(['ABCDEFGHIJKLM']), 'DESIGN_TEXT_INVALID', 'texts.name.value.0');
  assert.ok(ok(named(['عبدالرحمن‌ئەح'])), 'a ZWNJ is not a letter: 9 + 3 letters');
  refused(named(['عبدالرحمن‌ئەحم']), 'DESIGN_TEXT_INVALID', 'texts.name.value.0');
  assert.equal(graphemeCount('علاء'), 4);
  assert.equal(graphemeCount('بە‌خێر'), 5);
  const samples = [
    'علي', 'ڕۆژان', 'بە‌خێر', 'لا', 'Zoë', 'é', '👨‍👩‍👧', '🇮🇶🇮🇶', '👍🏽', '́abc', 'a\ń', '​́', 'مُحَمَّد', '‍‍', 'क्षि', '각', '\r\n',
  ];
  for (const s of samples) assert.ok(graphemeCountFallback(s) >= graphemeCount(s), `fallback undercounts «${s}»`);
  for (const s of ['علي', 'ڕۆژان', 'بە‌خێر', 'لا', 'Zoë', 'ALI & SARA', '٢٠٢٦', '‌علي‌']) assert.equal(graphemeCountFallback(s), graphemeCount(s), `exact on the rule's alphabet: «${s}»`);
});

test('entries: lines when the area takes one name, names when it takes several; blanks and doubled spaces tidied, never refused', () => {
  refused(named(['ALI', 'SARA']), 'DESIGN_TEXT_INVALID', 'texts.name.value');
  const qr = { ...defaultConfig(QR), texts: { shop: { style: 'minimal', value: ['Rose Café', 'Since 1990'] } } };
  assert.deepEqual(ok(qr, QR).texts.shop.value, ['Rose Café', 'Since 1990'], 'two lines in a two-line area');
  refused({ ...qr, texts: { shop: { style: 'minimal', value: ['a', 'b', 'c'] } } }, 'DESIGN_TEXT_INVALID', 'texts.shop.value', QR);
  const couple: BlueprintSpec = { ...clone(NAME_STAND), areas: NAME_STAND.areas.map((a) => ({ ...a, text: { ...a.text!, count: 2, lines: 1 } })) };
  const opts = { variants: STAND.variants };
  assert.deepEqual(ok(named(['ALI', 'SARA']), couple, opts).texts.name.value, ['ALI', 'SARA'], 'two names');
  refused(named(['ALI', 'SARA', 'OMAR']), 'DESIGN_TEXT_INVALID', 'texts.name.value', couple, opts);
  assert.deepEqual(ok(named(['  ALI   BABA ', '', '   '])).texts.name.value, ['ALI BABA']);
  refused(named([7]), 'CONFIG_INVALID', 'texts.name.value.0');
  refused(stand((c) => (c.texts.name.value = 'ALI')), 'CONFIG_INVALID', 'texts.name.value');
  refused(stand((c) => (c.texts.name.style = 'comic')), 'CONFIG_INVALID', 'texts.name.style');
  const k = { ...defaultConfig(KEYCHAIN), texts: { name: { style: 'elegant', value: ['SARA'] } } };
  refused(k, 'CONFIG_INVALID', 'texts.name.style', KEYCHAIN);
});

test('strings are NFC: a decomposed é and a separate madda compose, and hash as the composed form', async () => {
  const decomposed = ok(named(['José']));
  assert.equal(decomposed.texts.name.value[0], 'José');
  assert.equal(await configHash(decomposed), await configHash(ok(named(['José']))));
  assert.equal(ok(named(['آمنة'])).texts.name.value[0], 'آمنة');
  assert.equal(ok(stand((c) => (c.notes = 'Café please'))).notes, 'Café please');
});

// -------------------------------------------------------- price-like keys

test('a price-like key is refused at any depth, in any spelling — CONFIG_INVALID with its path, lenient mode too', () => {
  const cases: Array<[(c: Raw) => void, string]> = [
    [(c) => (c.price = 1000), 'price'],
    [(c) => (c.unitPrice = 1000), 'unitPrice'],
    [(c) => (c.total = 1), 'total'],
    [(c) => (c.texts.name.fee = 0), 'texts.name.fee'],
    [(c) => (c.slots.magnet.unit_iqd = 1), 'slots.magnet.unit_iqd'],
    [(c) => (c.colors.total = 'red'), 'colors.total'],
    [(c) => (c.roster = [{ n: 1, amount: 5 }]), 'roster.0.amount'],
    [(c) => (c.texts.name.value = [{ cost: 1 }]), 'texts.name.value.0.cost'],
    [(c) => (c.meta = { deep: { deeper: { discount: 10 } } }), 'meta.deep.deeper.discount'],
    [(c) => (c.subtotal = 1), 'subtotal'], [(c) => (c.margin = 1), 'margin'], [(c) => (c.fees = []), 'fees'], [(c) => (c.prices = {}), 'prices'],
    [(c) => (c.iqd = 1), 'iqd'], [(c) => (c.unit = 1), 'unit'], [(c) => (c.PriceIQD = 1), 'PriceIQD'], [(c) => (c.extra_fee = 1), 'extra_fee'],
  ];
  for (const [set, path] of cases) {
    refused(stand(set), 'CONFIG_INVALID', path);
    const lenient = normalizeConfig(stand(set), STAND, { lenient: true });
    assert.equal(lenient.ok, false, `lenient keeps refusing ${path}`);
  }
  assert.deepEqual([...PRICE_LIKE_KEYS], ['price', 'prices', 'iqd', '*_iqd', 'unit', 'unit_price', 'total', 'subtotal', 'amount', 'cost', 'fee', 'fees', 'discount', 'margin']);
  for (const k of ['price', 'unit_price', 'unitPrice', 'price_iqd', 'fee_iqd', 'per_extra_iqd', 'totalAmount', 'Cost', 'unit']) assert.equal(isPriceLikeKey(k), true, k);
  for (const k of ['name', 'body', 'united', 'priceless_name', 'feel', 'option', 'value', 'n', 'notes', 'magnet']) assert.equal(isPriceLikeKey(k), false, k);
});

// ------------------------------------------------------- unknown keys and ids

test('unknown keys and ids are refused with their path; kinds, lists and variants are checked', () => {
  const cases: Array<[Raw, string, PublicBlueprint?]> = [
    [stand((c) => (c.gift = { to: 'Sara' })), 'gift'],
    [stand((c) => (c.size = 'm')), 'size'],
    [stand((c) => (c.finish = 'silk')), 'finish'],
    [stand((c) => (c.colors.lid = 'red')), 'colors.lid'],
    [stand((c) => (c.colors.plate = 'red')), 'colors.plate'],
    [stand((c) => (c.colors.body = 'multi')), 'colors.body'],
    [stand((c) => (c.colors.body = 'rainbow')), 'colors.body'],
    [stand((c) => (c.texts.motto = { value: ['x'] })), 'texts.motto'],
    [stand((c) => (c.texts.name.font = 'Cairo')), 'texts.name.font'],
    [stand((c) => (c.slots.lighting = { option: 'rgb' })), 'slots.lighting'],
    [stand((c) => (c.slots.magnet = { option: 'm99' })), 'slots.magnet.option'],
    [stand((c) => (c.slots.magnet = 'm10')), 'slots.magnet'],
    [stand((c) => (c.parts.body = false)), 'parts.body'],
    [stand((c) => (c.logo.name = { key: 'users/u1/design-assets/a.png' })), 'logo.name'],
    [stand((c) => (c.icon.name = 'heart')), 'icon.name'],
    [stand((c) => (c.nfc = { kind: 'url', value: 'https://levonis.iq' })), 'nfc'],
    [stand((c) => (c.roster = [{ n: 1 }])), 'roster'],
    [stand((c) => (c.variant = 'pv_xl_gold')), 'variant'],
    [stand((c) => (c.variant = null)), 'variant'],
    [stand((c) => (c.theme = 'jungle')), 'theme'],
    [stand((c) => (c.parent = 'not an id')), 'parent'],
    [stand((c) => (c.colors = ['black'])), 'colors'],
    [{ ...defaultConfig(QR), theme: 'ocean' }, 'theme', QR],
    [{ ...defaultConfig(QR), qr: { qr: { kind: 'tiktok', value: 'ali' } } }, 'qr.qr.kind', QR],
    [{ ...defaultConfig(QR), qr: { logo: { kind: 'url', value: 'https://a.iq' } } }, 'qr.logo', QR],
    [{ ...defaultConfig(KEYCHAIN), icon: { badge: 'rocket' } }, 'icon.badge', KEYCHAIN],
    [{ ...defaultConfig(KEYCHAIN), icon: { badge: 'unicorn' } }, 'icon.badge', KEYCHAIN],
    [{ ...defaultConfig(KEYCHAIN), parts: { ring: 'yes' } }, 'parts.ring', KEYCHAIN],
    [{ ...defaultConfig(ROTATING), variant: 'pv_anything' }, 'variant', ROTATING],
  ];
  for (const [raw, path, spec] of cases) refused(raw, 'CONFIG_INVALID', path, spec ?? STAND);
  refused(stand((c) => (c.p = 'cp_other')), 'CONFIG_INVALID', 'p');
  refused(stand((c) => (c.v = 2)), 'CONFIG_INVALID', 'v');
  refused(stand((c) => (c.rev = 0)), 'CONFIG_INVALID', 'rev');
  for (const raw of [null, [], 'config', 1]) refused(raw, 'CONFIG_INVALID', '');
  assert.equal(ok({ ...defaultConfig(KEYCHAIN), icon: { badge: 'gamepad-2' } }, KEYCHAIN).icon.badge, 'gamepad-2');
  const fixedSlot: BlueprintSpec = { ...clone(ROTATING_SPEC()), slots: ROTATING_SPEC().slots.map((s) => (s.id === 'motor' ? { ...s, choice: 'fixed' as const } : s)) };
  refused({ ...GOLDEN_CONFIG }, 'CONFIG_INVALID', 'slots.motor', fixedSlot);
  assert.deepEqual(Object.keys(ok({ ...GOLDEN_CONFIG, slots: { magnet: { option: 'm15' } } }, fixedSlot).slots), ['lighting', 'magnet'], 'a fixed slot is not the customer\'s');
});
const ROTATING_SPEC = () => FIXTURES.rotatingDisplay.spec;

test('the variant is one the product sells — checked against the public variants, the given list, or by shape alone', () => {
  const spec = FIXTURES.nameStand.spec;
  const c = { ...NAME_STAND_CONFIG };
  assert.equal(ok(c, spec, { variants: STAND.variants }).variant, 'pv_m_silk');
  refused({ ...c, variant: 'pv_nope' }, 'CONFIG_INVALID', 'variant', spec, { variants: STAND.variants });
  assert.equal(ok({ ...c, variant: 'pv_nope' }, spec).variant, 'pv_nope', 'no list: the Worker checks the id');
  refused({ ...c, variant: 'pv nope' }, 'CONFIG_INVALID', 'variant', spec);
  assert.equal(ok({ ...c, variant: null }, spec).variant, null);
});

test('logo and photo keys are the owner\'s design assets; crops are inside the picture and kept at 1e-4', () => {
  const logo = (l: Raw) => ({ ...defaultConfig(QR), logo: { logo: l }, qr: { qr: { kind: 'menu', value: 'cafe.iq/menu' } } });
  const good = ok(logo({ key: 'users/u_1/design-assets/logo1.png', crop: [0.123456, 0, 0.5, 1], mode: 'raised' }), QR);
  assert.deepEqual(good.logo.logo, { crop: [0.1235, 0, 0.5, 1], key: 'users/u_1/design-assets/logo1.png', mode: 'raised' });
  assert.deepEqual(ok(logo({ key: 'users/u_1/design-assets/logo1.webp' }), QR).logo.logo, { crop: [0, 0, 1, 1], key: 'users/u_1/design-assets/logo1.webp', mode: 'flat' }, 'defaults: the whole picture, the first mode');
  for (const key of ['merchants/u_1/public/logo.png', 'users/u_1/avatar/a.png', 'users/../design-assets/a.png', 'users/u_1/design-assets/a.svg', 'https://x.iq/a.png', 'users/u_1/design-assets/a.png?x=1']) {
    refused(logo({ key }), 'CONFIG_INVALID', 'logo.logo.key', QR);
  }
  for (const crop of [[0, 0, 0, 1], [0.5, 0, 0.6, 1], [-0.1, 0, 0.5, 0.5], [0, 0, 1], [0, 0, 1, NaN]]) refused(logo({ key: 'users/u_1/design-assets/l.png', crop }), 'CONFIG_INVALID', 'logo.logo.crop', QR);
  refused(logo({ key: 'users/u_1/design-assets/l.png', mode: 'engraved' }), 'CONFIG_INVALID', 'logo.logo.mode', QR);
  const lamp = FIXTURES.photoLamp.pub;
  assert.equal(ok({ ...defaultConfig(lamp), photo: { photo: { key: 'users/u_9/design-assets/p1.jpg', mode: 'lithophane' } } }, lamp).photo.photo.mode, 'lithophane');
  refused({ ...defaultConfig(lamp), photo: { photo: { key: 'users/u_9/design-assets/p1.jpg', mode: 'relief' } } }, 'CONFIG_INVALID', 'photo.photo.mode', lamp);
});

// ----------------------------------------------------------- QR and NFC

test('QR and NFC targets by kind: a handle, a phone, an http(s) URL, a short text the shop programs — or QR_TARGET_INVALID', () => {
  const good: Array<[Parameters<typeof normalizeTarget>, string]> = [
    [['instagram', '@Ali.Prints'], 'ali.prints'], [['instagram', ' ali_prints '], 'ali_prints'], [['tiktok', '@levo.iq'], 'levo.iq'],
    [['whatsapp', '07701234567'], '+9647701234567'], [['whatsapp', '٠٧٧٠١٢٣٤٥٦٧'], '+9647701234567'], [['whatsapp', '009647701234567'], '+9647701234567'],
    [['whatsapp', '+964 770 123 4567'], '+9647701234567'], [['whatsapp', '‪+964 770 123 4567‬'], '+9647701234567'], [['contact', '+44 20 7946 0958'], '+442079460958'],
    [['website', 'levonis-iq.com'], 'https://levonis-iq.com/'], [['menu', 'cafe.iq/menu'], 'https://cafe.iq/menu'], [['url', 'HTTP://Example.COM/a b'], 'http://example.com/a%20b'],
    [['website', 'https://مثال.com/'], 'https://xn--mgbh0fb.com/'], [['reorder', ''], ''], [['profile', 'instagram.com/ali'], 'https://instagram.com/ali'],
    [['wifi', 'Home WiFi / pass 1234', true], 'Home WiFi / pass 1234'], [['contact', 'Ali — 0770 123 4567', true], 'Ali — 0770 123 4567'],
  ];
  for (const [args, want] of good) assert.equal(normalizeTarget(...args), want, JSON.stringify(args));
  const bad: Array<Parameters<typeof normalizeTarget>> = [
    ['instagram', 'ali prints'], ['instagram', 'a'.repeat(31)], ['tiktok', 'a'], ['instagram', 'علي'], ['whatsapp', '12345'], ['whatsapp', '7701234567'], ['whatsapp', '+0123456789'],
    ['website', 'javascript:alert(1)'], ['website', 'ftp://x.com'], ['website', 'https://user:pw@x.com'], ['url', 'https://localhost/'], ['url', 'http://10.0.0.1/'],
    ['url', `https://x.com/${'a'.repeat(200)}`], ['website', 'not a url'], ['reorder', 'https://x.com'], ['wifi', 'x‮y', true], ['wifi', 'a'.repeat(121), true], ['wifi', '', true],
  ];
  for (const args of bad) assert.equal(normalizeTarget(...args), null, JSON.stringify(args).slice(0, 80));

  const qr = (kind: string, value: unknown) => ({ ...defaultConfig(QR), qr: { qr: { kind, value } } });
  assert.deepEqual(ok(qr('instagram', '@Ali.Prints'), QR).qr, { qr: { kind: 'instagram', value: 'ali.prints' } });
  refused(qr('instagram', 'ali prints'), 'QR_TARGET_INVALID', 'qr.qr.value', QR);
  refused(qr('website', 'javascript:alert(1)'), 'QR_TARGET_INVALID', 'qr.qr.value', QR);
  refused(qr('menu', 5), 'QR_TARGET_INVALID', 'qr.qr.value', QR);
  const nfc = (kind: string, value: string) => ({ ...defaultConfig(QR), nfc: { kind, value } });
  assert.deepEqual(ok(nfc('wifi', 'Cafe guest / 12345678'), QR).nfc, { kind: 'wifi', value: 'Cafe guest / 12345678' });
  refused(nfc('wifi', 'x⁧y'), 'QR_TARGET_INVALID', 'nfc.value', QR);
  refused(nfc('profile', 'instagram.com/x'), 'CONFIG_INVALID', 'nfc.kind', QR);
});

// ------------------------------------------------------------ notes, roster

test('notes: ≤ 500 characters, several lines, no bidi or control characters', () => {
  assert.equal(ok(stand((c) => (c.notes = 'ن'.repeat(500)))).notes.length, 500);
  refused(stand((c) => (c.notes = 'ن'.repeat(501))), 'DESIGN_TEXT_INVALID', 'notes');
  assert.equal(ok(stand((c) => (c.notes = '  line one\nline two 🎁 \n'))).notes, 'line one\nline two 🎁');
  for (const ch of ['‮', '⁦', '‏', '\u0000', '\t', '\u0085']) refused(stand((c) => (c.notes = `hi${ch}there`)), 'DESIGN_TEXT_INVALID', 'notes');
  refused(stand((c) => (c.notes = 5)), 'CONFIG_INVALID', 'notes');
  assert.equal(plainTextOk('a\nb', true), true);
  assert.equal(plainTextOk('a\nb'), false);
});

test('a roster varies only its declared fields, n pieces each, at most the blueprint\'s max — ROSTER_TOO_LARGE beyond it', () => {
  const base = defaultConfig(GROUP);
  const r = ok({ ...base, texts: { name: { style: 'bold', value: ['OMAR'] } }, roster: [{ n: 2, texts: { name: ['SARA'] }, colors: { body: 'red' } }, { n: 1, texts: { name: ['ALI'] } }] }, GROUP);
  assert.deepEqual(r.roster, [{ colors: { body: 'red' }, n: 2, texts: { name: ['SARA'] } }, { n: 1, texts: { name: ['ALI'] } }]);
  assert.deepEqual(textValues(r), [
    { path: 'texts.name.value.0', value: 'OMAR' },
    { path: 'roster.0.texts.name.0', value: 'SARA' },
    { path: 'roster.1.texts.name.0', value: 'ALI' },
  ]);
  const roster = (entries: unknown[]) => ({ ...base, roster: entries });
  refused(roster([{ n: 0 }]), 'CONFIG_INVALID', 'roster.0.n', GROUP);
  refused(roster([{ n: 21 }]), 'CONFIG_INVALID', 'roster.0.n', GROUP);
  refused(roster([{ n: 1, colors: { body: 'purple' } }]), 'CONFIG_INVALID', 'roster.0.colors.body', GROUP);
  refused(roster([{ n: 1, colors: { name: 'red' } }]), 'CONFIG_INVALID', 'roster.0.colors.name', GROUP);
  assert.deepEqual(ok(roster([{ n: 1, colors: { name: 'white' } }]), GROUP).roster, [{ colors: { name: 'white' }, n: 1 }], '`vary: name` covers the name and its own colour');
  const noColour = { ...clone(GROUP_PARTICIPANT), extras: { nfc: null, roster: { vary: ['name'], max: 30 } } };
  refused(roster([{ n: 1, colors: { body: 'red' } }]), 'CONFIG_INVALID', 'roster.0.colors.body', noColour, { variants: [] });
  refused(roster([{ n: 1, style: 'fun' }]), 'CONFIG_INVALID', 'roster.0.style', GROUP);
  refused(roster([]), 'CONFIG_INVALID', 'roster', GROUP);
  refused(roster(Array.from({ length: 31 }, () => ({ n: 1 }))), 'ROSTER_TOO_LARGE', 'roster', GROUP);
  assert.ok(ok(roster(Array.from({ length: 30 }, () => ({ n: 1 }))), GROUP));
});

// ------------------------------------------------------------------ sizes

test('a configuration over 16 KB (32 KB with a roster) is DESIGN_TOO_LARGE', () => {
  refused(stand((c) => (c.junk = 'x'.repeat(2 * CONFIG_LIMITS.rosterBytes))), 'DESIGN_TOO_LARGE', '');
  const big: BlueprintSpec = {
    ...clone(GROUP_PARTICIPANT),
    areas: GROUP_PARTICIPANT.areas.map((a) => ({ ...a, text: { ...a.text!, count: 4, max: 40 } })),
    extras: { nfc: null, roster: { vary: ['name', 'body'], max: 100 } },
  };
  const opts = { variants: [] };
  const long = 'ع'.repeat(40);
  const entries = (n: number) => Array.from({ length: n }, () => ({ n: 1, texts: { name: [long, long, long, long] }, colors: { body: 'red' } }));
  const base = defaultConfig(big, null, { p: 'cp_group_tag', rev: 3 });
  const mid = ok({ ...base, roster: entries(60) }, big, opts);
  const bytes = new TextEncoder().encode(canonicalJson(mid)).length;
  assert.ok(bytes > CONFIG_LIMITS.bytes && bytes <= CONFIG_LIMITS.rosterBytes, `a roster may pass 16 KB (${bytes} B)`);
  refused({ ...base, roster: entries(100) }, 'DESIGN_TOO_LARGE', '', big, opts);
});

// ------------------------------------------------------------- canonical

test('the canonical form: keys sorted at every depth, every declared control explicit, no whitespace', () => {
  const c = ok(stand());
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      assert.deepEqual(keys, [...keys].sort(), `unsorted: ${keys}`);
      Object.values(v).forEach(walk);
    }
  };
  walk(JSON.parse(canonicalJson(c)));
  assert.equal(canonicalJson(c), JSON.stringify(c), 'the object itself is built in canonical order');
  assert.doesNotMatch(canonicalJson(c), /[\n\t]|": |, "/);
  assert.deepEqual(Object.keys(c), ['colors', 'icon', 'logo', 'nfc', 'notes', 'p', 'parent', 'parts', 'photo', 'qr', 'rev', 'roster', 'slots', 'texts', 'theme', 'v', 'variant']);
  const sparse = ok({ v: 1, p: 'cp_name_stand', rev: 3, variant: 'pv_m_silk', texts: { name: { value: ['ALI'] } } });
  assert.deepEqual(sparse.colors, { base: 'white', body: 'black', name: 'black', plate: 'white' });
  assert.deepEqual(sparse.texts, { name: { style: 'bold', value: ['ALI'] } });
  assert.deepEqual(sparse.slots, { magnet: { option: null } });
  assert.deepEqual([sparse.theme, sparse.nfc, sparse.roster, sparse.parent, sparse.notes], [null, null, null, null, '']);
  assert.deepEqual(canonicalize(sparse, STAND), sparse, 'idempotent');
  assert.equal(canonicalJson({ b: [3, undefined, { z: 1, a: undefined, m: null }], a: 'x' }), '{"a":"x","b":[3,null,{"m":null,"z":1}]}');
});

test('configHash: equal choices give equal hashes however they were spelled; any different choice changes it', async () => {
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const a = ok(stand());
  const spelled = ok({
    variant: 'pv_m_silk', v: 1, texts: { name: { value: ['  ALI '], style: 'gaming' } }, slots: { magnet: { option: 'm15' } }, rev: 3, p: 'cp_name_stand',
    notes: ' please wrap it\n', colors: { plate: 'white', name: 'gold', body: 'navy' }, parts: {}, roster: null,
  });
  const h = await configHash(a);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(await configHash(spelled), h, 'key order, spaces, an implicit default');
  const different: Array<(c: Raw) => void> = [
    (c) => (c.colors.body = 'black'), (c) => (c.texts.name.value = ['ALY']), (c) => (c.texts.name.style = 'bold'), (c) => (c.slots.magnet.option = null),
    (c) => (c.slots.magnet.option = 'm10'), (c) => (c.variant = 'pv_l_classic'), (c) => (c.notes = ''), (c) => (c.theme = 'ocean'), (c) => (c.parent = 'cfg_1'),
  ];
  const seen = new Set([h]);
  for (const set of different) {
    const x = await configHash(ok(stand(set)));
    assert.ok(!seen.has(x), `a different choice hashed like another: ${set}`);
    seen.add(x);
  }
});

// ------------------------------------------------------------- lenient

test('lenient mode migrates a design to the live revision: valid choices kept, the rest reported and defaulted', () => {
  const old = stand((c) => {
    c.rev = 2;
    c.colors.plate = 'red';
    c.texts.name.value = ['ALI', 'SARA'];
    c.slots.magnet = { option: 'm99' };
    c.theme = 'ocean';
    c.finish = 'silk';
  });
  refused(old, 'BLUEPRINT_CHANGED', 'rev');
  const r = normalizeConfig(old, STAND, { lenient: true });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.rev, 3);
  assert.equal(r.value.colors.plate, 'white', 'an invalid colour falls back to its default');
  assert.equal(r.value.colors.body, 'navy', 'a valid one is kept');
  assert.deepEqual(r.value.texts.name.value, ['ALI'], 'the first line the area takes');
  assert.deepEqual(r.value.slots.magnet, { option: null });
  assert.equal(r.value.theme, 'ocean');
  assert.deepEqual(
    r.errors?.map((e) => `${e.code}@${e.path}`).sort(),
    ['BLUEPRINT_CHANGED@rev', 'CONFIG_INVALID@colors.plate', 'CONFIG_INVALID@finish', 'CONFIG_INVALID@slots.magnet.option', 'DESIGN_TEXT_INVALID@texts.name.value'].sort()
  );
  const gone = normalizeConfig(stand((c) => (c.variant = 'pv_xl')), STAND, { lenient: true });
  assert.ok(gone.ok && gone.value.variant === 'pv_m_classic', 'a variant no longer sold becomes the default one');
  assert.equal(normalizeConfig(stand((c) => (c.p = 'cp_other')), STAND, { lenient: true }).ok, false, 'another product is never migrated');
});

test('strict mode collects every error and answers with the most structural code', () => {
  const r = normalizeConfig(named(['A‮B'], (c) => {
    c.colors.lid = 'red';
    c.qr = { qr: { kind: 'url', value: 'x' } };
  }), STAND);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'CONFIG_INVALID');
  assert.equal(r.path, 'colors.lid');
  assert.deepEqual(r.errors?.map((e) => e.path).sort(), ['colors.lid', 'qr.qr', 'texts.name.value.0']);
  const text = normalizeConfig(named(['A‮B']), STAND);
  assert.equal(text.ok ? '' : text.code, 'DESIGN_TEXT_INVALID', 'the text code when it is the only kind of error');
});
