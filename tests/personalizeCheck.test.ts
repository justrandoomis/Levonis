/**
 * THE CHECK (Programme C, C1 lane L2; docs/LEVO_PROJECT_PROGRAMME.md §B.1 hop 3,
 * P15; survey §4.6 «engine check codes», §5.3 «Checks and automatic fixes»).
 *
 * Pins: every check code, each made by a minimal fixture; each code's group
 * (fixed = applied by itself, suggest = a priced tap, review, blocked); the
 * verdict precedence blocked › review › adjusted › ready, with a pending
 * suggestion or a demoted fix blocking the door; automatic fixes never change
 * the price — over the fixtures and 30 generated blueprints — and the fixed
 * configuration is still valid for the live revision; the QR's module and
 * contrast arithmetic; COMPONENT_OUT's alternatives from the same slot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOGO_REVIEW_COLOURS, QR_MIN_CONTRAST, QR_QUIET_MODULES, blockingCode, checkConfig, qrColours, qrModules, qrPayload, type CheckContext, type CheckFinding, type CheckResult } from '../packages/catalog/src/personalize/check';
import { partKey, priceConfig, priceContextFromPublic } from '../packages/catalog/src/personalize/price';
import { normalizeConfig } from '../packages/catalog/src/personalize/config';
import { CHECK_CODES, checkGroup, type CheckCode } from '../packages/catalog/src/personalize/vocab';
import { PALETTE_RGB, contrastRatio } from '../packages/catalog/src/personalize/color';
import type { FitResult } from '../packages/catalog/src/personalize/fit';
import type { DesignConfig, PublicBlueprint } from '../packages/catalog/src/personalize/types';
import { FIXTURES, GOLDEN_CONFIG, GROUP_PARTICIPANT } from './fixtures/personalizeBlueprints';
import { ASSET_KEY, LONG_MENU, PICTURES_PUB, SHELF_SPEC, configOf, generated, nameArea, publicOf, qrPanel, shelfPub } from './fixtures/personalizeMoney';

const STAND = FIXTURES.nameStand.pub;
const ROTATING = FIXTURES.rotatingDisplay.pub;
const clone = <T>(v: T): T => structuredClone(v);
const run = (pub: PublicBlueprint, config: DesignConfig, more: Partial<CheckContext> = {}): CheckResult =>
  checkConfig(pub, config, { price: priceContextFromPublic(pub, config.variant), ...more });
const find = (r: CheckResult, code: CheckCode): CheckFinding => {
  const i = r.issues.find((x) => x.code === code);
  assert.ok(i, `${code} expected in ${JSON.stringify(r.issues.map((x) => x.code))}`);
  return i!;
};
const unit = (pub: PublicBlueprint, c: DesignConfig) => priceConfig(pub, c, priceContextFromPublic(pub, c.variant)).unit_iqd;
/** Smart Fit standing in with one answer (the real table is L3's and is pinned there). */
const fits = (code: FitResult['code'], more: Partial<FitResult> = {}): CheckContext['fit'] => (value, _area, o) => ({ lines: [...value], cap_mm: 8, fits: code !== 'SIZE_UP_FOR_TEXT' && code !== 'TEXT_TOO_LONG', code, style: o.style, ...more });
/** A named stand in stock: classic medium, ALI in gold on white, a navy body. */
const stand = (variant = 'pv_m_classic', set: (c: Record<string, any>) => void = () => {}) => // eslint-disable-line @typescript-eslint/no-explicit-any
  configOf(STAND, (c) => {
    c.texts.name.value = ['ALI'];
    c.colors.body = 'navy';
    c.colors.name = 'gold';
    set(c);
  }, variant);

const seen = new Set<CheckCode>();
/** The issue for `code` in `r` (recorded for the every-code test). */
function has(r: CheckResult, code: CheckCode): CheckFinding {
  seen.add(code);
  return find(r, code);
}

// ------------------------------------------------------------ texts

test('a clean configuration is ready: no issue, the same configuration, its price', () => {
  const c = stand();
  const r = run(STAND, c, { fit: fits('TEXT_OK') });
  assert.deepEqual(r.issues, []);
  assert.equal(r.verdict, 'ready');
  assert.equal(r.config, c, 'nothing fixed: the very same configuration');
  assert.deepEqual(r.price, priceConfig(STAND, c, priceContextFromPublic(STAND, c.variant)));
  assert.equal(run(ROTATING, GOLDEN_CONFIG).verdict, 'ready', 'the golden rotating display');
});

test('texts through Smart Fit: fitted, two lines and a bolder style are applied; a size of the same price is taken; a priced one is suggested', () => {
  const c = stand('pv_m_classic', (x) => (x.texts.name.style = 'elegant'));
  for (const code of ['TEXT_FITTED', 'TEXT_TWO_LINES'] as const) {
    const r = run(STAND, c, { fit: fits(code) });
    assert.deepEqual(has(r, code), { code, path: 'texts.name', fix: { kind: 'auto', delta_iqd: 0 } });
    assert.equal(r.verdict, 'adjusted');
    assert.equal(r.config, c, 'the fit is drawn, not stored');
  }
  const bold = run(STAND, c, { fit: fits('TEXT_STYLE_BOLDER', { style: 'bold' }) });
  assert.deepEqual(has(bold, 'TEXT_STYLE_BOLDER'), { code: 'TEXT_STYLE_BOLDER', path: 'texts.name', from: 'elegant', to: 'bold', fix: { kind: 'auto', delta_iqd: 0 } });
  assert.equal(bold.config.texts.name.style, 'bold');
  assert.equal(bold.verdict, 'adjusted');

  const up = run(STAND, c, { fit: fits('SIZE_UP_FOR_TEXT', { size_value: 'ov_l' }) });
  const s = has(up, 'SIZE_UP_FOR_TEXT');
  assert.equal(s.to, 'ov_l');
  assert.equal(s.fix!.kind, 'suggest');
  assert.equal(s.fix!.config!.variant, 'pv_l_classic');
  assert.equal(s.fix!.delta_iqd, 3_000);
  assert.equal(up.verdict, 'blocked', 'a text that does not fit blocks until the tap');
  assert.equal(up.config, c);
  // The large size priced like the medium: the move is price-neutral, so it is made.
  const same = { ...STAND, variants: STAND.variants.map((v) => (v.id === 'pv_l_classic' ? { ...v, price_iqd: 23_000 } : v)) };
  const moved = run(same, c, { fit: fits('SIZE_UP_FOR_TEXT', { size_value: 'ov_l' }) });
  assert.deepEqual(has(moved, 'TEXT_FITTED'), { code: 'TEXT_FITTED', path: 'texts.name', to: 'ov_l', fix: { kind: 'auto', delta_iqd: 0 } });
  assert.equal(moved.config.variant, 'pv_l_classic');
  assert.equal(moved.verdict, 'adjusted');

  const long = run(STAND, c, { fit: fits('TEXT_TOO_LONG') });
  assert.deepEqual(has(long, 'TEXT_TOO_LONG'), { code: 'TEXT_TOO_LONG', path: 'texts.name' });
  assert.equal(long.verdict, 'blocked');
});

test('Smart Fit is asked at the chosen size with only the larger sizes the printer makes — and a text no size holds is TEXT_TOO_LONG for real', () => {
  const calls: Array<{ scale: number; sizes: string[] }> = [];
  const spy: CheckContext['fit'] = (value, _a, o) => {
    calls.push({ scale: o.scale, sizes: (o.sizes ?? []).map((z) => z.value) });
    return { lines: [...value], cap_mm: 8, fits: true, code: 'TEXT_OK', style: o.style };
  };
  run(STAND, stand('pv_s_classic'), { fit: spy });
  run(STAND, stand('pv_s_classic'), { fit: spy, printer: { max_mm: [160, 160, 160] } });
  assert.deepEqual(calls, [{ scale: 0.8, sizes: ['ov_m', 'ov_l'] }, { scale: 0.8, sizes: ['ov_m'] }], 'Large is above a 160 mm printer: never offered');
  // The real Smart Fit: forty letters in an 8 × 4 mm frame fit at no size.
  const tiny = publicOf({ ...SHELF_SPEC, areas: [nameArea('name', 'body', { frame: { o: [0, -40, 0], n: [0, -1, 0], u: [0, 0, 1], w: 8, h: 4 } }, { max: 40 })] }, { productId: 'cp_tiny', price: 5_000 });
  const r = run(tiny, configOf(tiny, (x) => (x.texts.name.value = ['W'.repeat(40)])));
  assert.deepEqual(has(r, 'TEXT_TOO_LONG'), { code: 'TEXT_TOO_LONG', path: 'texts.name' });
  // Roster names are fitted too.
  const group = FIXTURES.groupParticipant.pub;
  const roster = configOf(group, (x) => {
    x.texts.name.value = ['OMAR'];
    x.roster = [{ n: 1, texts: { name: ['SARA'] } }, { n: 2, texts: { name: ['ABDULRAHMAN'] } }];
  });
  const byName: CheckContext['fit'] = (value, _a, o) => ({ lines: [...value], cap_mm: 8, fits: value[0].length < 8, code: value[0].length < 8 ? 'TEXT_OK' : 'TEXT_TOO_LONG', style: o.style });
  assert.deepEqual(run(group, roster, { fit: byName }).issues, [{ code: 'TEXT_TOO_LONG', path: 'roster.1.texts.name' }]);
  assert.equal(GROUP_PARTICIPANT.extras.roster!.max, 30);
});

// ------------------------------------------------------------ colours

test('colours on the shop\'s shelf: a \'stocked\' paint off the shelf takes the shop\'s substitute, else COLOR_OUT; lists and \'all\' may be made to order', () => {
  const pub = shelfPub();
  const sub = run(pub, configOf(pub, (c) => (c.colors.body = 'blue')));
  assert.deepEqual(has(sub, 'COLOR_MATCHED'), { code: 'COLOR_MATCHED', path: 'colors.body', from: 'blue', to: 'navy', fix: { kind: 'auto', delta_iqd: 0 } });
  assert.equal(sub.config.colors.body, 'navy');
  assert.equal(sub.verdict, 'adjusted');
  const out = run(pub, configOf(pub, (c) => (c.colors.body = 'red')));
  assert.deepEqual(has(out, 'COLOR_OUT'), { code: 'COLOR_OUT', path: 'colors.body', from: 'red' });
  assert.equal(out.verdict, 'blocked');
  const absent = run(pub, configOf(pub, (c) => (c.colors.body = 'purple')));
  assert.deepEqual(absent.issues, [{ code: 'COLOR_OUT', path: 'colors.body', from: 'purple' }], 'a key the map does not hold is out');
  const made = run(pub, configOf(pub, (c) => {
    c.colors.trim = 'red';
    c.colors.base = 'purple';
  }));
  assert.deepEqual(made.issues, [], 'a listed or \'all\' colour off the shelf is made to order');
  assert.deepEqual(run(shelfPub({}, { stock: null }), configOf(pub, (c) => (c.colors.body = 'red'))).issues, [], 'a shop that tracks nothing refuses nothing');
  // A substitute that changes the price is only suggested (P15): one colour fewer past the included one.
  const priced = shelfPub({ colors: { included: 1, per_extra_iqd: 500, max: 3 } });
  const c = configOf(priced, (x) => {
    x.colors.body = 'blue';
    x.colors.trim = 'navy';
  });
  const demoted = has(run(priced, c), 'COLOR_MATCHED');
  assert.deepEqual([demoted.fix!.kind, demoted.fix!.delta_iqd], ['suggest', -500]);
  assert.equal(run(priced, c).verdict, 'blocked', 'a demoted fix waits for the tap');
});

test('colours over the blueprint\'s max merge into the nearest — applied at the same price, suggested otherwise, COLOR_OUT when nothing can merge', () => {
  const pub = shelfPub({ colors: { included: 2, per_extra_iqd: 0, max: 2 } });
  const three = configOf(pub, (c) => {
    c.colors.body = 'black';
    c.colors.trim = 'navy';
  });
  const r = run(pub, three);
  assert.deepEqual(has(r, 'COLORS_MERGED'), { code: 'COLORS_MERGED', path: 'colors', fix: { kind: 'auto', delta_iqd: 0 } });
  assert.deepEqual(r.config.colors, { base: 'white', body: 'navy', trim: 'navy' });
  const priced = shelfPub({ colors: { included: 1, per_extra_iqd: 500, max: 2 } });
  const p = has(run(priced, configOf(priced, (c) => (c.colors.trim = 'navy'))), 'COLORS_MERGED');
  assert.deepEqual([p.fix!.kind, p.fix!.delta_iqd], ['suggest', -500]);
  const apart = shelfPub({ colors: { included: 2, per_extra_iqd: 0, max: 2 }, regions: SHELF_SPEC.regions.map((x, i) => ({ ...x, paint: [{ allowed: ['black', 'teal'], default: 'black' }, { allowed: ['white', 'navy'], default: 'white' }, { allowed: ['red', 'blue'], default: 'red' }][i] as never })) }, { stock: null });
  assert.deepEqual(run(apart, configOf(apart, () => {})).issues, [{ code: 'COLOR_OUT', path: 'colors' }]);
});

// ------------------------------------------------------------ QR

test('QR maths: the payload by kind, its version (byte mode, EC level M), the module at the chosen size, the quiet zone inside the frame', () => {
  assert.equal(qrPayload('instagram', 'ali.prints'), 'https://instagram.com/ali.prints');
  assert.equal(qrPayload('tiktok', 'ali.prints'), 'https://www.tiktok.com/@ali.prints');
  assert.equal(qrPayload('whatsapp', '+9647701234567'), 'https://wa.me/9647701234567');
  assert.equal(qrPayload('contact', '+9647701234567'), 'tel:+9647701234567');
  assert.equal(qrPayload('menu', 'https://example.com/menu'), 'https://example.com/menu');
  assert.equal(qrModules('url', 'x'.repeat(14)), 21, '14 bytes: version 1');
  assert.equal(qrModules('url', 'x'.repeat(15)), 25, '15 bytes: version 2');
  assert.equal(qrModules('instagram', 'ali.prints'), 29, '32 bytes: version 3');
  assert.equal(qrModules('menu', LONG_MENU), 41, '100 bytes: version 6');
  assert.equal(qrModules('url', 'x'.repeat(213)), 57, '213 bytes: version 10, the encoder\'s last');
  assert.equal(qrModules('url', 'x'.repeat(214)), 0, 'too long for the encoder');
  assert.equal(qrModules('reorder', ''), 29, 'the twin link is sized at 40 bytes: version 3');
  assert.equal(QR_QUIET_MODULES, 2);
  // 41 modules + 2 × 2 quiet modules over the frame's 20 mm × scale: 0.44 mm small, 0.67 mm medium, 1.11 mm large.
  const at = (min: number, variant: string) => run(qrPanel({ min_module_mm: min, large: 16_000 }), configOf(qrPanel({ min_module_mm: min, large: 16_000 }), (c) => (c.qr.qr = { kind: 'menu', value: LONG_MENU }), variant));
  assert.deepEqual(at(0.66, 'pv_m').issues, [], '30 / 45 = 0.667 ≥ 0.66');
  assert.equal(has(at(0.67, 'pv_m'), 'SIZE_UP_FOR_QR').to, 'ov_l', '0.667 < 0.67: the next size that scans');
  assert.deepEqual(at(1.11, 'pv_l').issues, [], '50 / 45 = 1.111');
  assert.deepEqual(at(1.12, 'pv_l').issues, [{ code: 'QR_UNREADABLE', path: 'qr.qr' }]);
});

test('QR: a size of the same price where it scans is taken (QR_ENLARGED); a priced one is suggested; none — or none the printer makes — is QR_UNREADABLE', () => {
  const pub = qrPanel();
  const menu = (variant: string) => configOf(pub, (c) => (c.qr.qr = { kind: 'menu', value: LONG_MENU }), variant);
  const enlarged = run(pub, menu('pv_m'));
  assert.deepEqual(has(enlarged, 'QR_ENLARGED'), { code: 'QR_ENLARGED', path: 'qr.qr', to: 'ov_l', fix: { kind: 'auto', delta_iqd: 0 } });
  assert.equal(enlarged.config.variant, 'pv_l');
  assert.equal(enlarged.verdict, 'adjusted');
  const up = run(pub, menu('pv_s'));
  const s = has(up, 'SIZE_UP_FOR_QR');
  assert.deepEqual([s.to, s.fix!.kind, s.fix!.delta_iqd, s.fix!.config!.variant], ['ov_l', 'suggest', 2_000, 'pv_l']);
  assert.equal(up.verdict, 'blocked');
  const small = qrPanel({ printer: { max_mm: [120, 120, 120] } });
  assert.deepEqual(run(small, configOf(small, (c) => (c.qr.qr = { kind: 'menu', value: LONG_MENU }), 'pv_s')).issues.map((i) => has(run(small, configOf(small, (c) => (c.qr.qr = { kind: 'menu', value: LONG_MENU }), 'pv_s')), i.code).code), ['QR_UNREADABLE'], 'Large is above the printer');
  const fine = qrPanel({ min_module_mm: 1.2 });
  assert.deepEqual(run(fine, configOf(fine, (c) => (c.qr.qr = { kind: 'menu', value: LONG_MENU }), 'pv_s')).issues, [{ code: 'QR_UNREADABLE', path: 'qr.qr' }]);
  // A size-up rule for a QR is a SIZE_UP_FOR_QR suggestion with its sentence.
  const ruled = qrPanel({ min_module_mm: 0.3, rules: [{ id: 'big-qr', if: { qr: 'qr' }, then: { size_at_least: 'ov_m' }, fix: 'suggest', say: 'qr_needs_size' }] });
  const rq = has(run(ruled, configOf(ruled, (c) => (c.qr.qr = { kind: 'instagram', value: 'ali.prints' }), 'pv_s')), 'SIZE_UP_FOR_QR');
  assert.deepEqual([rq.path, rq.say, rq.to, rq.fix!.delta_iqd], ['rules.big-qr', 'qr_needs_size', 'ov_m', 2_000]);
});

test('QR contrast: the code prints in the design\'s colour with the most contrast against its surface — under 3:1 the surface is changed (CONTRAST_FIXED), else QR_UNREADABLE', () => {
  const pub = qrPanel({ min_module_mm: 0.3, panel: { allowed: ['navy', 'white'], default: 'navy' } });
  const c = configOf(pub, (x) => (x.qr.qr = { kind: 'instagram', value: 'ali.prints' }));
  const ink = qrColours(pub, c, 'qr')!;
  assert.deepEqual([ink.on, ink.off], ['black', 'navy']);
  assert.equal(ink.ratio, contrastRatio(PALETTE_RGB.black, PALETTE_RGB.navy));
  assert.ok(ink.ratio < QR_MIN_CONTRAST);
  const r = run(pub, c);
  assert.deepEqual(has(r, 'CONTRAST_FIXED'), { code: 'CONTRAST_FIXED', path: 'colors.panel', from: 'navy', to: 'white', fix: { kind: 'auto', delta_iqd: 0 } });
  assert.ok(qrColours(pub, r.config, 'qr')!.ratio >= QR_MIN_CONTRAST);
  // The shop's own colours decide the contrast when it has them.
  assert.equal(qrColours(pub, c, 'qr', (k) => (k === 'navy' ? [250, 250, 250] : PALETTE_RGB[k]))!.ratio > QR_MIN_CONTRAST, true);
  // A one-colour design prints its code in black or white.
  const one = qrPanel({ min_module_mm: 0.3, body: { allowed: ['navy'], default: 'navy' }, panel: { allowed: ['navy'], default: 'navy' } });
  assert.deepEqual(qrColours(one, configOf(one, (x) => (x.qr.qr = { kind: 'instagram', value: 'ali.prints' })), 'qr')!.on, 'white');
  // Nothing the surface may wear reaches 3:1 against the rest: unreadable.
  const stuck = qrPanel({ min_module_mm: 0.3, panel: { allowed: ['navy'], default: 'navy' } });
  assert.deepEqual(run(stuck, configOf(stuck, (x) => (x.qr.qr = { kind: 'instagram', value: 'ali.prints' }))).issues, [{ code: 'QR_UNREADABLE', path: 'qr.qr' }]);
});

// ------------------------------------------------------------ pictures

test('the owner\'s pictures: a logo past its colours is simplified, a detailed one reviewed; a photo too small for its frame, or a silhouette without transparency, reviewed', () => {
  const c = configOf(PICTURES_PUB, (x) => {
    x.logo.logo = { key: ASSET_KEY, crop: [0, 0, 1, 1], mode: 'flat' };
    x.photo.photo = { key: ASSET_KEY, crop: [0, 0, 1, 1], mode: 'lithophane' };
  });
  const facts = (logo: number, px: number, alpha = true) => ({ logo: { px_w: 800, px_h: 800, colours: logo }, photo: { px_w: px, px_h: px, has_alpha: alpha } });
  assert.deepEqual(run(PICTURES_PUB, c, { assets: facts(2, 800) }).issues, [], 'two colours, 8 px per mm');
  const simple = run(PICTURES_PUB, c, { assets: facts(3, 800) });
  assert.deepEqual(has(simple, 'LOGO_SIMPLIFIED'), { code: 'LOGO_SIMPLIFIED', path: 'logo.logo', fix: { kind: 'auto', delta_iqd: 0 } });
  assert.equal(simple.verdict, 'adjusted');
  const detail = run(PICTURES_PUB, c, { assets: facts(LOGO_REVIEW_COLOURS + 1, 800) });
  assert.deepEqual(has(detail, 'LOGO_DETAIL'), { code: 'LOGO_DETAIL', path: 'logo.logo' });
  assert.equal(detail.verdict, 'review');
  // 100 × 80 mm at 5 px per mm needs 500 × 400 px: 450 px is short. Half of 1,200 px (600) is enough; half of 900 (450) is not.
  const low = run(PICTURES_PUB, c, { assets: facts(2, 450) });
  assert.deepEqual(has(low, 'PHOTO_LOW_RES'), { code: 'PHOTO_LOW_RES', path: 'photo.photo' });
  assert.equal(low.verdict, 'review');
  const cropped = clone(c);
  cropped.photo.photo.crop = [0.25, 0.25, 0.5, 0.5];
  assert.deepEqual(run(PICTURES_PUB, cropped, { assets: facts(2, 1_200) }).issues, []);
  assert.deepEqual(run(PICTURES_PUB, cropped, { assets: facts(2, 900) }).issues, [{ code: 'PHOTO_LOW_RES', path: 'photo.photo' }]);
  const silhouette = clone(c);
  silhouette.photo.photo.mode = 'silhouette';
  assert.deepEqual(has(run(PICTURES_PUB, silhouette, { assets: facts(2, 800, false) }), 'PHOTO_NEEDS_CUTOUT'), { code: 'PHOTO_NEEDS_CUTOUT', path: 'photo.photo' });
  assert.deepEqual(run(PICTURES_PUB, silhouette, { assets: facts(2, 800, true) }).issues, []);
  assert.deepEqual(run(PICTURES_PUB, c).issues, [], 'no facts: not judged');
});

// ------------------------------------------------------------ stock, printer, rules, content

test('COMPONENT_OUT: an option out of stock blocks, with the in-stock alternatives of the SAME slot, the nearest in price first', () => {
  const c = clone(GOLDEN_CONFIG);
  c.slots.magnet = { option: 'm20' };
  const r = run(ROTATING, c);
  const out = has(r, 'COMPONENT_OUT');
  assert.equal(out.path, 'slots.magnet');
  assert.equal(out.from, 'm20');
  assert.deepEqual(out.alternatives!.map((a) => [a.key, a.delta_iqd]), [['m15', -2_000], ['m10', -3_000]]);
  for (const a of out.alternatives!) {
    assert.deepEqual({ ...a.config, slots: { ...a.config.slots, magnet: c.slots.magnet } }, c, 'only the slot changes');
    assert.equal(a.delta_iqd, unit(ROTATING, a.config) - unit(ROTATING, c));
    assert.ok(ROTATING.slot_options.magnet.find((o) => o.key === a.key)!.in_stock);
  }
  assert.deepEqual(out.fix, { kind: 'suggest', config: out.alternatives![0].config, delta_iqd: -2_000 });
  assert.equal(r.verdict, 'blocked');
  assert.equal(blockingCode(r.issues), 'COMPONENT_OUT');
  // The magnet rule (20 mm needs motor B) is unmet too, with its priced fix.
  const rule = has(r, 'RULE_UNMET');
  assert.deepEqual([rule.path, rule.say, rule.fix!.kind, rule.fix!.delta_iqd], ['rules.big-magnet', 'addon_needs_addon', 'suggest', 3_000]);
  // A part with no live price: the configuration cannot be priced — price null, blocked on the part.
  const ctx = priceContextFromPublic(ROTATING, null);
  const parts = { ...ctx.parts };
  delete parts[partKey('cp_motor', 'pv_motor_a')];
  const gone = checkConfig(ROTATING, GOLDEN_CONFIG, { price: { ...ctx, parts } });
  assert.equal(gone.price, null);
  assert.equal(gone.verdict, 'blocked');
  assert.deepEqual(has(gone, 'COMPONENT_OUT').alternatives!.map((a) => [a.key, a.delta_iqd]), [['b', undefined]], 'the alternative is offered; its delta is unknown');
});

test('SIZE_OUT, TOO_BIG_FOR_PRINTER, CONTENT_MISSING: the variant sold out, a size above the printer, required content still empty', () => {
  const out = run(STAND, stand('pv_l_silk', (c) => (c.colors.body = 'black')));
  const s = has(out, 'SIZE_OUT');
  assert.deepEqual([s.path, s.to, s.fix!.kind, s.fix!.config!.variant, s.fix!.delta_iqd], ['variant', 'pv_m_silk', 'suggest', 'pv_m_silk', -3_000], 'the nearest in stock: the same look, the next size');
  assert.equal(out.verdict, 'blocked');
  const big = run(STAND, stand(), { printer: { max_mm: [130, 130, 130] } });
  const b = has(big, 'TOO_BIG_FOR_PRINTER');
  assert.deepEqual([b.path, b.to, b.fix!.kind, b.fix!.config!.variant, b.fix!.delta_iqd], ['variant', 'ov_s', 'suggest', 'pv_s_classic', -3_000], 'the largest size it makes, offered');
  assert.equal(big.verdict, 'review', 'a review with an optional suggestion never blocks');
  const empty = run(STAND, configOf(STAND, () => {}));
  assert.deepEqual(has(empty, 'CONTENT_MISSING'), { code: 'CONTENT_MISSING', path: 'texts.name' });
  assert.equal(empty.verdict, 'blocked');
  const qr = FIXTURES.qrMenuStand.pub;
  assert.deepEqual(run(qr, configOf(qr, () => {})).issues.map((i) => i.path), ['logo.logo', 'qr.qr'], 'one issue per missing path');
});

test('merchant rules: auto and price-neutral → RULE_ADJUSTED; a priced size → SIZE_UP_FOR_TEXT / SIZE_UP_FOR_ADDON; anything else unmet → RULE_UNMET', () => {
  const silk = stand('pv_m_silk', (c) => (c.colors.base = 'gold'));
  const adj = run(STAND, silk, { fit: fits('TEXT_OK') });
  assert.deepEqual(has(adj, 'RULE_ADJUSTED'), { code: 'RULE_ADJUSTED', path: 'rules.silk-colours', say: 'look_limits_colors', fix: { kind: 'auto', delta_iqd: 0 } });
  assert.equal(adj.config.colors.body, 'black');
  assert.equal(adj.verdict, 'adjusted');

  const addon = run(STAND, stand('pv_m_classic', (c) => (c.slots.magnet = { option: 'm15' })), { fit: fits('TEXT_OK') });
  const a = has(addon, 'SIZE_UP_FOR_ADDON');
  assert.deepEqual([a.path, a.say, a.to, a.fix!.kind, a.fix!.delta_iqd, a.fix!.config!.variant], ['rules.big-magnet', 'addon_needs_size', 'ov_l', 'suggest', 3_000, 'pv_l_classic']);
  assert.equal(addon.verdict, 'blocked');

  const text = run(STAND, stand('pv_s_classic', (c) => (c.texts.name.value = ['ABCDEFGHIJK'])), { fit: fits('TEXT_OK') });
  const t = has(text, 'SIZE_UP_FOR_TEXT');
  assert.deepEqual([t.path, t.say, t.to, t.fix!.delta_iqd], ['rules.long-name', 'text_needs_size', 'ov_m', 3_000]);

  const unmet = run(STAND, stand('pv_m_silk', (c) => {
    c.slots.magnet = { option: 'm15' };
    c.colors.body = 'black';
    c.colors.base = 'gold';
  }), { fit: fits('TEXT_OK') });
  assert.deepEqual(has(unmet, 'RULE_UNMET'), { code: 'RULE_UNMET', path: 'rules.big-magnet', say: 'addon_needs_size' }, 'Large silk is sold out: nothing to offer');
});

// ------------------------------------------------------------ verdict

test('verdict precedence: blocked › review › adjusted › ready — a pending suggestion or a demoted fix blocks; blockingCode names the most serious', () => {
  for (const code of CHECK_CODES) assert.ok(['fixed', 'suggest', 'review', 'blocked'].includes(checkGroup(code)));
  const logo = (colours: number, trim?: string) => {
    const pub = PICTURES_PUB;
    const c = configOf(pub, (x) => {
      x.logo.logo = { key: ASSET_KEY, crop: [0, 0, 1, 1], mode: 'flat' };
      if (trim) x.colors.body = trim;
    });
    return run(pub, c, { assets: { logo: { px_w: 900, px_h: 900, colours } } });
  };
  assert.equal(logo(1).verdict, 'ready');
  assert.equal(logo(3).verdict, 'adjusted', 'a fix applied');
  assert.equal(logo(20).verdict, 'review');
  // Review and a blocked issue: blocked.
  const pub = shelfPub({ areas: [{ id: 'logo', kind: 'logo', role: 'logo', region: 'body', frame: { o: [0, -40, 0], n: [0, -1, 0], u: [0, 0, 1], w: 40, h: 40 }, logo: { max_colors: 2, modes: ['flat'] }, required: false, fee_iqd: 0 }] });
  const both = run(pub, configOf(pub, (x) => {
    x.logo.logo = { key: ASSET_KEY, crop: [0, 0, 1, 1], mode: 'flat' };
    x.colors.body = 'red';
  }), { assets: { logo: { px_w: 900, px_h: 900, colours: 20 } } });
  assert.deepEqual(both.issues.map((i) => i.code).sort(), ['COLOR_OUT', 'LOGO_DETAIL']);
  assert.equal(both.verdict, 'blocked');
  assert.equal(blockingCode(both.issues), 'COLOR_OUT');
  // Review and an applied fix: review.
  const reviewed = run(pub, configOf(pub, (x) => {
    x.logo.logo = { key: ASSET_KEY, crop: [0, 0, 1, 1], mode: 'flat' };
    x.colors.body = 'blue';
  }), { assets: { logo: { px_w: 900, px_h: 900, colours: 20 } } });
  assert.deepEqual(reviewed.issues.map((i) => i.code), ['COLOR_MATCHED', 'LOGO_DETAIL']);
  assert.equal(reviewed.verdict, 'review');
  assert.equal(blockingCode(reviewed.issues), undefined);
  // A suggestion alone blocks, and is the door's chip.
  const suggestion = run(STAND, stand('pv_m_classic', (c) => (c.slots.magnet = { option: 'm15' })), { fit: fits('TEXT_OK') });
  assert.deepEqual(suggestion.issues.map((i) => i.code), ['SIZE_UP_FOR_ADDON']);
  assert.equal(suggestion.verdict, 'blocked');
  assert.equal(blockingCode(suggestion.issues), 'SIZE_UP_FOR_ADDON');
  // A blocked code outranks a pending suggestion for the chip.
  const mixed: CheckFinding[] = [{ code: 'SIZE_UP_FOR_TEXT', fix: { kind: 'suggest', delta_iqd: 3_000 } }, { code: 'CONTENT_MISSING', path: 'texts.name' }];
  assert.equal(blockingCode(mixed), 'CONTENT_MISSING');
  assert.equal(blockingCode([{ code: 'COLORS_MERGED', fix: { kind: 'suggest', delta_iqd: -500 } }]), 'COLORS_MERGED', 'a demoted fix waits for its tap');
  assert.equal(blockingCode([{ code: 'COLORS_MERGED', fix: { kind: 'auto', delta_iqd: 0 } }, { code: 'LOGO_DETAIL' }]), undefined);
});

test('every check code is produced by a minimal fixture, and its group is as the survey pins it', () => {
  assert.deepEqual([...CHECK_CODES].filter((c) => !seen.has(c)), [], 'codes no test produced');
  const group = (codes: CheckCode[]) => codes.map(checkGroup);
  assert.deepEqual(group(['TEXT_FITTED', 'TEXT_TWO_LINES', 'TEXT_STYLE_BOLDER', 'COLOR_MATCHED', 'COLORS_MERGED', 'CONTRAST_FIXED', 'QR_ENLARGED', 'LOGO_SIMPLIFIED', 'RULE_ADJUSTED']), Array(9).fill('fixed'));
  assert.deepEqual(group(['SIZE_UP_FOR_TEXT', 'SIZE_UP_FOR_QR', 'SIZE_UP_FOR_ADDON']), Array(3).fill('suggest'));
  assert.deepEqual(group(['LOGO_DETAIL', 'PHOTO_LOW_RES', 'PHOTO_NEEDS_CUTOUT', 'TOO_BIG_FOR_PRINTER']), Array(4).fill('review'));
  assert.deepEqual(group(['TEXT_TOO_LONG', 'COMPONENT_OUT', 'COLOR_OUT', 'SIZE_OUT', 'QR_UNREADABLE', 'CONTENT_MISSING', 'RULE_UNMET']), Array(7).fill('blocked'));
});

// ------------------------------------------------------------ price-neutral fixes

test('automatic fixes never change the price — across 30 generated blueprints; the fixed configuration stays valid; suggestions carry the exact delta', () => {
  let auto = 0;
  let suggested = 0;
  for (let i = 0; i < 30; i++) {
    const g = generated(i);
    for (const c of g.configs) {
      const label = `blueprint ${i} ${JSON.stringify(c).slice(0, 80)}`;
      const before = JSON.stringify(c);
      const r = checkConfig(g.pub, c, { price: priceContextFromPublic(g.pub, c.variant), assets: g.assets });
      assert.equal(JSON.stringify(c), before, `${label}: the input is never written`);
      assert.deepEqual(checkConfig(g.pub, c, { price: priceContextFromPublic(g.pub, c.variant), assets: g.assets }), r, `${label}: deterministic`);
      const n = normalizeConfig(r.config, g.pub);
      assert.ok(n.ok, `${label}: the fixed configuration is refused ${JSON.stringify(n)}`);
      assert.deepEqual(n.ok && n.value, r.config, `${label}: and canonical`);
      if (r.price) {
        assert.equal(unit(g.pub, r.config), unit(g.pub, c), `${label}: P15`);
        assert.deepEqual(r.price, priceConfig(g.pub, r.config, priceContextFromPublic(g.pub, r.config.variant)));
      }
      for (const is of r.issues) {
        if (is.fix?.kind === 'auto') {
          auto++;
          assert.equal(is.fix.delta_iqd, 0, `${label}: ${is.code}`);
          assert.notEqual(checkGroup(is.code), 'blocked');
          assert.notEqual(checkGroup(is.code), 'suggest');
        }
        if (is.fix?.kind === 'suggest' && is.fix.config && is.fix.delta_iqd !== undefined && r.price) {
          suggested++;
          assert.equal(is.fix.delta_iqd, unit(g.pub, is.fix.config) - unit(g.pub, c), `${label}: ${is.code} delta`);
        }
      }
      const blocks = r.issues.some((x) => checkGroup(x.code) === 'blocked' || (checkGroup(x.code) !== 'review' && x.fix?.kind !== 'auto'));
      assert.equal(r.verdict, blocks ? 'blocked' : r.issues.some((x) => checkGroup(x.code) === 'review') ? 'review' : r.issues.some((x) => x.fix?.kind === 'auto') ? 'adjusted' : 'ready', label);
    }
  }
  assert.ok(auto > 10 && suggested > 10, `the sweep exercised fixes (auto ${auto}, suggested ${suggested})`);
});
