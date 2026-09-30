/**
 * The engine's taste — themes, Choose for me, Make it better, Surprise me,
 * colour and the words (Programme C, C1 lane L3; docs/LEVO_PROJECT_PROGRAMME.md
 * §A C1.10–C1.15; survey §5.3).
 *
 * Pins: ten themes map every tone to a palette key, their text reads at 3:1 on
 * the tones a name sits on; applyTheme paints only what a part may wear;
 * chooseForMe is deterministic per seed, never the current theme, only
 * stocked colours, tags first, «Try another» differs; every makeItBetter code
 * reached from a fixture, price-neutral first; surpriseMe never touches
 * content; PALETTE_RGB is the swatch stylesheet; CIEDE2000 on Sharma's
 * reference pairs; the shelf's stock states and the substitute threshold;
 * configWords ≤ 200 characters in three languages, free of workshop words.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DesignConfig } from '../packages/catalog/src/personalize/types';
import {
  FINISH_KEYS, PALETTE_RGB, SUBSTITUTE_MAX_DE, contrastRatio, deltaE2000, keyContrast, lookStock, nearestKey, nearestStocked, rgbToLab, shelfKey, stockFor, stockKey, type RGB,
} from '../packages/catalog/src/personalize/color';
import { THEME_TABLE, applyTheme, chooseForMe, seedIndex, tasteContext, textsLegible, themeExact, themePalette, themeStyle, themesOf } from '../packages/catalog/src/personalize/themes';
import { BETTER_CODES, makeItBetter, surpriseMe } from '../packages/catalog/src/personalize/suggest';
import { SUMMARY_KEYS, SUMMARY_WORDS, configWords, listWords, summaryRows } from '../packages/catalog/src/personalize/summary';
import { FAMILIES, OCCASIONS, PAINT_KEYS, RECIPIENTS, STYLES, THEMES, TONES } from '../packages/catalog/src/personalize/vocab';
import { paintTargets } from '../packages/catalog/src/personalize/price';
import { colourChoices } from '../packages/catalog/src/personalize/rules';
import { defaultConfig } from '../packages/catalog/src/personalize/config';
import { FIXTURES, GOLDEN_CONFIG, NAME_STAND_CONFIG } from './fixtures/personalizeBlueprints';
import { KIDS_STAND_PUB, SHARMA_PAIRS, SHELF, STAND_ANY, STAND_BASE } from './fixtures/personalizeTaste';

const ROOT = join(import.meta.dirname, '..');
const STAND = FIXTURES.nameStand.pub;
const LANGS = ['ar', 'en', 'ckb'] as const;
const colours = (c: DesignConfig) => ({ ...c.colors });

// ------------------------------------------------------------------ themes

test('ten themes: every tone a palette key, a style, tags from the vocabularies', () => {
  assert.equal(THEME_TABLE.split('|').length, THEMES.length);
  const tags = new Set<string>([...FAMILIES, ...OCCASIONS, ...RECIPIENTS, 'biz']);
  for (const t of THEMES) {
    const pal = themePalette(t);
    assert.deepEqual(Object.keys(pal), [...TONES], t);
    for (const tone of TONES) assert.ok((PAINT_KEYS as readonly string[]).includes(pal[tone]), `${t}.${tone} = ${pal[tone]}`);
    assert.ok((STYLES as readonly string[]).includes(themeStyle(t)), t);
    const row = THEME_TABLE.split('|')[THEMES.indexOf(t)].split(' ').slice(6);
    assert.ok(row.length >= 3 && row.every((x) => tags.has(x)), `${t} tags ${row}`);
  }
  assert.equal(new Set(THEMES.map((t) => TONES.map((x) => themePalette(t)[x]).join())).size, 10, 'ten different palettes');
});

test('text contrast ≥ 3:1 in every theme, on the primary, secondary and accent it is printed on', () => {
  for (const t of THEMES) {
    const p = themePalette(t);
    for (const bg of ['primary', 'secondary', 'accent'] as const) {
      const r = keyContrast(p.text, p[bg]);
      assert.ok(r >= 3, `${t}: ${p.text} on ${p[bg]} = ${r.toFixed(2)}`);
    }
  }
});

test('applyTheme paints each part with its tone, or the nearest colour it may wear; texts legible', () => {
  const ocean = applyTheme(STAND_ANY, STAND_BASE, 'ocean');
  assert.equal(ocean.theme, 'ocean');
  assert.deepEqual(colours(ocean), { base: 'teal', body: 'blue', name: 'black', plate: 'white' });
  assert.ok(themeExact(STAND_ANY, ocean, 'ocean'));
  const silk = { ...STAND_BASE, variant: 'pv_m_silk' };
  const cx = tasteContext(STAND, silk);
  for (const t of THEMES) {
    const c = applyTheme(STAND, silk, t);
    for (const p of paintTargets(STAND, c)) assert.ok(colourChoices(STAND, c, cx, p.id).includes(p.key), `${t}: ${p.id} = ${p.key}`);
    assert.ok(textsLegible(STAND, c), t);
    assert.deepEqual(c.texts, silk.texts, 'a theme never touches the words');
  }
  assert.deepEqual(themesOf(FIXTURES.qrMenuStand.pub), ['mono', 'royal', 'fresh']);
  assert.deepEqual(themesOf(FIXTURES.photoLamp.pub), []);
});

test('chooseForMe: deterministic per seed, never the current theme, only stocked colours, «Try another» differs', () => {
  for (const pub of [STAND, STAND_ANY]) {
    for (const variant of ['pv_m_classic', 'pv_m_silk']) {
      const base = { ...STAND_BASE, variant };
      const cx = tasteContext(pub, base);
      for (let seed = -3; seed < 12; seed++) {
        const a = chooseForMe(pub, base, {}, seed);
        assert.deepEqual(chooseForMe(pub, base, {}, seed), a, 'deterministic');
        assert.notEqual(a.theme, null);
        for (const p of paintTargets(pub, a)) assert.ok(colourChoices(pub, a, cx, p.id).includes(p.key), `${variant} seed ${seed}: ${p.id}=${p.key}`);
        assert.ok(textsLegible(pub, a));
        const again = chooseForMe(pub, a, {}, seed + 1);
        assert.notEqual(again.theme, a.theme, 'never the current theme — Try another differs');
        assert.deepEqual(again.texts.name.value, base.texts.name.value);
      }
    }
  }
  assert.equal(chooseForMe(FIXTURES.photoLamp.pub, defaultConfig(FIXTURES.photoLamp.pub, 'pv_s'), {}, 0).theme, null, 'no themes offered: unchanged');
});

test('chooseForMe prefers the themes whose tags match the occasion, and brings the theme\'s style when it fits', () => {
  const wedding = chooseForMe(STAND_ANY, STAND_BASE, { occasion: 'wedding' }, 0);
  assert.equal(wedding.theme, 'royal');
  assert.equal(wedding.texts.name.style, 'elegant');
  const lamp = chooseForMe({ ...STAND_ANY, family: 'lamp', tags: [] }, STAND_BASE, {}, 0);
  assert.ok(['ocean', 'sunset'].includes(lamp.theme!), `lamp → ${lamp.theme}`);
  assert.equal(seedIndex(-1, 4), 3);
  assert.equal(seedIndex(9, 4), 1);
});

// ---------------------------------------------------------- make it better

test('makeItBetter: each code from a fixture — price-neutral first, a priced one says its delta', () => {
  const at = (c: DesignConfig, pub = STAND) => makeItBetter(pub, c);
  const cases: Array<[string, ReturnType<typeof at>]> = [
    ['CONTRAST_TEXT', at({ ...STAND_BASE, colors: { base: 'white', body: 'navy', name: 'gold', plate: 'white' } })],
    ['STOCKED_ONLY', at({ ...STAND_BASE, variant: 'pv_m_silk', colors: { base: 'white', body: 'red', name: 'black', plate: 'white' } })],
    ['FEWER_COLOURS', at({ ...STAND_BASE, colors: { base: 'red', body: 'navy', name: 'black', plate: 'white' } })],
    ['STYLE_FOR_LENGTH', at({ ...STAND_BASE, variant: null, colors: { base: 'white', body: 'navy', name: 'black', plate: 'white' }, texts: { name: { value: ['علي'], style: 'kids' } } }, KIDS_STAND_PUB)],
    ['BALANCE_ACCENT', at({ ...STAND_BASE, colors: { base: 'white', body: 'black', name: 'red', plate: 'black' } })],
  ];
  const qr = FIXTURES.qrMenuStand.pub;
  cases.push(['LOGO_FIT', at({ ...defaultConfig(qr, 'pv_value', { p: qr.product.id, rev: 3 }), logo: { logo: { key: 'users/u1/design-assets/a1.png', crop: [0.1, 0.1, 0.5, 0.5], mode: 'flat' } } }, qr)]);
  const ocean = applyTheme(STAND_ANY, STAND_BASE, 'ocean');
  cases.push(['THEME_MATCH', at({ ...ocean, theme: null, colors: { ...ocean.colors, base: 'green' } }, STAND_ANY)]);
  assert.deepEqual(cases.map(([code]) => code), [...BETTER_CODES]);
  for (const [code, r] of cases) {
    assert.ok(r, code);
    assert.equal(r.code, code);
    if (code === 'FEWER_COLOURS') assert.equal(r.delta_iqd, -1000, 'a saving is a priced suggestion');
    else assert.equal(r.delta_iqd, 0, code);
  }
  const [, contrast] = cases[0];
  assert.ok(keyContrast(contrast!.config.colors.name, contrast!.config.colors.plate) >= 3);
  assert.equal(cases[3][1]!.config.texts.name.style, 'bold');
  assert.equal(cases[4][1]!.config.colors.plate, 'white');
  assert.deepEqual(cases[5][1]!.config.logo.logo.crop, [0, 0, 1, 1]);
  assert.equal(cases[6][1]!.config.theme, 'ocean');
  assert.equal(makeItBetter(STAND_ANY, { ...STAND_BASE, colors: { base: 'white', body: 'navy', name: 'black', plate: 'white' } }), null, 'nothing to improve: no chip');
});

test('surpriseMe: seeded look, theme and style — never the words, logos, photos or QR targets', () => {
  const qr = FIXTURES.qrMenuStand.pub;
  const withContent: DesignConfig = {
    ...defaultConfig(qr, 'pv_value', { p: qr.product.id, rev: 3 }),
    texts: { shop: { value: ['Rose Café'], style: 'minimal' } },
    logo: { logo: { key: 'users/u1/design-assets/a1.png', crop: [0, 0, 1, 1], mode: 'flat' } },
    qr: { qr: { kind: 'instagram', value: 'rose.cafe' } },
  };
  for (const [pub, config] of [[STAND, NAME_STAND_CONFIG], [qr, withContent]] as const) {
    const seen = new Set<string>();
    for (let seed = 0; seed < 8; seed++) {
      const s = surpriseMe(pub, { config }, seed);
      assert.deepEqual(surpriseMe(pub, { config }, seed), s, 'deterministic');
      assert.deepEqual(Object.fromEntries(Object.entries(s.texts).map(([k, v]) => [k, v.value])), Object.fromEntries(Object.entries(config.texts).map(([k, v]) => [k, v.value])));
      assert.deepEqual([s.logo, s.photo, s.qr, s.icon, s.nfc, s.notes, s.slots], [config.logo, config.photo, config.qr, config.icon, config.nfc, config.notes, config.slots]);
      assert.notEqual(s.theme, config.theme);
      assert.ok(pub.variants.find((v) => v.id === s.variant)?.in_stock, 'a look in stock');
      seen.add(JSON.stringify([s.theme, s.variant, s.colors, s.texts]));
    }
    assert.ok(seen.size >= 3, `«Try another» gives another result (${seen.size})`);
  }
});

// ------------------------------------------------------------------ colour

test('PALETTE_RGB is the swatch stylesheet: a colour, or the rounded mean of a gradient\'s stops', () => {
  const css = readFileSync(join(ROOT, 'src/components/catalog/swatches.css'), 'utf8');
  for (const key of PAINT_KEYS) {
    const rule = new RegExp(`\\.lv-swatch\\[data-swatch='${key}'\\]\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(rule, key);
    const background = /background:\s*([^;]+);/.exec(rule[1])![1];
    const stops: number[][] = [];
    for (const m of background.matchAll(/#([0-9a-f]{6})|rgb\((\d+) (\d+) (\d+)/gi)) {
      stops.push(m[1] ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : [+m[2], +m[3], +m[4]]);
    }
    assert.ok(stops.length > 0, key);
    const mean = [0, 1, 2].map((i) => Math.round(stops.reduce((s, c) => s + c[i], 0) / stops.length));
    assert.deepEqual([...PALETTE_RGB[key]], mean, key);
  }
  assert.deepEqual(Object.keys(PALETTE_RGB).sort(), [...PAINT_KEYS].sort());
});

test('CIEDE2000 matches Sharma, Wu and Dalal\'s 34 reference pairs within 1e-4, both ways round', () => {
  assert.equal(SHARMA_PAIRS.length, 34);
  for (const [L1, a1, b1, L2, a2, b2, want] of SHARMA_PAIRS) {
    const got = deltaE2000([L1, a1, b1], [L2, a2, b2]);
    assert.ok(Math.abs(got - want) <= 1e-4, `${[L1, a1, b1, L2, a2, b2]}: ${got} ≠ ${want}`);
    assert.ok(Math.abs(deltaE2000([L2, a2, b2], [L1, a1, b1]) - want) <= 1e-4);
  }
  assert.equal(deltaE2000(rgbToLab([10, 20, 30]), rgbToLab([10, 20, 30])), 0);
  const white = rgbToLab([255, 255, 255]);
  assert.ok(Math.abs(white[0] - 100) < 0.01 && Math.abs(white[1]) < 0.01 && Math.abs(white[2]) < 0.01, 'D65 white');
});

test('WCAG contrast: 21:1 black on white, symmetric, 1 for a colour on itself', () => {
  assert.ok(Math.abs(contrastRatio([0, 0, 0], [255, 255, 255]) - 21) < 1e-9);
  assert.equal(contrastRatio([12, 200, 90], [240, 10, 40]), contrastRatio([240, 10, 40], [12, 200, 90]));
  assert.equal(contrastRatio([90, 90, 90] as RGB, [90, 90, 90]), 1);
  assert.equal(nearestKey('navy', ['white', 'black', 'gold']), 'black');
  assert.equal(nearestKey('navy', []), null);
});

test('the shelf: named or hex-matched spools are in, a close colour stands in (ΔE ≤ 10), finishes only for themselves', () => {
  const pla = stockFor({ material_id: 'pla' }, SHELF);
  assert.equal(Object.keys(pla).length, PAINT_KEYS.length);
  assert.deepEqual(Object.entries(pla).filter(([, s]) => s !== 'out').sort(), [['black', 'in'], ['blue', 'sub:purple'], ['clear', 'in'], ['purple', 'in'], ['red', 'in'], ['white', 'in'], ['yellow', 'in']]);
  assert.equal(pla.gold, 'out', 'gold is a finish: a yellow spool never stands in for it');
  const silk = stockFor({ material_id: 'pla-silk' }, SHELF);
  assert.deepEqual(Object.entries(silk).filter(([, s]) => s !== 'out').sort(), [['gold', 'in'], ['navy', 'in']]);
  assert.equal(shelfKey({ color_hex: '', color_name: 'سيلك ذهبي' }), 'gold');
  assert.equal(shelfKey({ color_hex: '', color_name: 'ڕەش' }), 'black');
  assert.equal(shelfKey({ color_hex: '#2a3a70', color_name: '' }), 'navy');
  assert.equal(shelfKey({ color_hex: 'nope', color_name: '' }), null);
  assert.equal(stockFor({ material_id: 'pla' }, SHELF, 500).red, 'out', 'a spool under the minimum grams is not stock');
  assert.equal(stockFor({ material_id: 'pla' }, SHELF, 500).black, 'in');
  const near = nearestStocked('blue', [{ key: 'purple', rgb: [96, 96, 208] }]);
  assert.equal(near?.key, 'purple');
  assert.ok(near!.delta <= SUBSTITUTE_MAX_DE);
  assert.equal(nearestStocked('teal', [{ key: 'blue', rgb: PALETTE_RGB.blue }]), null, 'teal is not blue');
  assert.equal(nearestStocked('white', [{ key: 'clear', rgb: PALETTE_RGB.clear }]), null, 'clear never stands in for white');
  assert.equal(nearestStocked('red', [{ key: 'red', rgb: [120, 20, 30] }])?.key, 'red', 'the same key always wins');
  assert.ok(FINISH_KEYS.includes('glow') && !FINISH_KEYS.includes('white'));
});

test('lookStock and stockKey: the chosen look\'s map, what prints for a key', () => {
  assert.deepEqual(lookStock(STAND, 'pv_m_silk'), STAND.stock!.silk);
  assert.deepEqual(lookStock(STAND, 'pv_m_classic'), STAND.stock!.default);
  assert.equal(lookStock(STAND_ANY, 'pv_m_silk'), null);
  const silk = lookStock(STAND, 'pv_m_silk');
  assert.equal(stockKey(silk, 'gold'), 'gold');
  assert.equal(stockKey(silk, 'blue'), 'navy');
  assert.equal(stockKey(silk, 'pink'), null);
  assert.equal(stockKey(null, 'pink'), 'pink');
});

// ------------------------------------------------------------------- words

const FORBIDDEN = /\b(stl|3mf|obj|mesh|polygon|triangle|vertex|vertices|slicer|infill|nozzle|layers?|supports?|g-?code|extruder|cad|manifold)\b|طبقة|طبقات|دعامة|دعامات|فوهة|حشوة|مضلع|سلايسر|شبكة مثلثات|چینەکان|پاڵپشت/i;

test('configWords: one line ≤ 200 characters in Arabic, English and Sorani, Sorani its own, no workshop words', () => {
  const cases: Array<[typeof STAND, DesignConfig]> = [[STAND, NAME_STAND_CONFIG], [FIXTURES.rotatingDisplay.pub, GOLDEN_CONFIG]];
  const kc = FIXTURES.nameKeychain.pub;
  cases.push([kc, { ...defaultConfig(kc, 'pv_best', { p: kc.product.id, rev: 3 }), texts: { name: { value: ['سارة'], style: 'fun' } }, icon: { badge: 'heart' } }]);
  const long = 'W'.repeat(40);
  cases.push([STAND, { ...NAME_STAND_CONFIG, texts: { name: { value: [long, long, long], style: 'bold' } }, notes: 'x'.repeat(400) }]);
  for (const [pub, c] of cases) {
    const said = LANGS.map((l) => configWords(pub, c, l));
    for (const s of said) {
      assert.ok(s.length > 0 && s.length <= 200, `${s.length}: ${s}`);
      assert.doesNotMatch(s, FORBIDDEN);
      assert.ok(!s.includes('\n'));
    }
    assert.notEqual(said[2], said[0], 'ckb is not the Arabic line');
    assert.notEqual(said[1], said[0]);
  }
  assert.equal(configWords(STAND, NAME_STAND_CONFIG, 'ar'), 'حامل باسم ALI (ألعاب) · كحلي وأبيض وذهبي · 15 سم · حريري · Round magnet 15 × 3 mm ×2');
  assert.equal(configWords(STAND, NAME_STAND_CONFIG, 'ckb'), 'پایە بە ناوی ALI (یاری) · شینی تۆخ و سپی و ئاڵتوونی · 15 سم · ئاوریشمی · Round magnet 15 × 3 mm ×2');
  assert.equal(configWords(FIXTURES.rotatingDisplay.pub, GOLDEN_CONFIG, 'en'), 'Decor · Black, White and Clear · Small motor A · Round magnet 10 mm ×2 · RGB LED');
  assert.match(configWords(kc, cases[2][1], 'ar'), /باسم سارة \(مرح\).*أيقونة: قلب/);
  assert.equal(configWords(STAND, NAME_STAND_CONFIG, 'en', { variants: { pv_m_silk: 'Medium / Silk' }, slot_options: { magnet: { m15: 'Magnet 15' } } }), 'Stand with the name ALI (Gaming) · Navy, White and Gold · Medium / Silk · Magnet 15 ×2');
});

test('summaryRows: a label and a value per choice, in three languages', () => {
  for (const l of LANGS) {
    const rows = summaryRows(STAND, NAME_STAND_CONFIG, l);
    assert.ok(rows.length >= 5);
    for (const r of rows) {
      assert.ok(r.label && r.value, JSON.stringify(r));
      assert.doesNotMatch(`${r.label} ${r.value}`, FORBIDDEN);
    }
  }
  assert.deepEqual(summaryRows(STAND, NAME_STAND_CONFIG, 'en').map((r) => r.label), ['Name', 'Colours', 'Size', 'Look', 'Magnet', 'Notes']);
  assert.equal(listWords(['a', 'b', 'c'], 'en'), 'a, b and c');
  assert.equal(listWords(['a', 'b'], 'ar'), 'a وb');
  assert.equal(listWords(['a', 'b'], 'ckb'), 'a و b');
  const words = SUMMARY_WORDS.map((w) => w.split('|'));
  for (const w of words) assert.equal(w.length, SUMMARY_KEYS.length);
  const own = words[2].filter((x, i) => x !== words[0][i]);
  assert.ok(own.length >= SUMMARY_KEYS.length - 2, 'Sorani is written, not the Arabic (the unit سم and و are shared)');
  assert.ok(words[2].some((x) => /[ەێۆڕڵ]/.test(x)), 'Sorani letters');
  assert.doesNotMatch(SUMMARY_WORDS.join('|'), FORBIDDEN);
});
