#!/usr/bin/env node
/**
 * THE SMART FIT TABLE — measures, once, how wide Cairo draws every character
 * the personalization text rule allows, and writes
 * packages/catalog/src/personalize/cairoAdvances.ts, the only data Smart Fit
 * (packages/catalog/src/personalize/fit.ts) reads in the browser and in the
 * Worker (docs/LEVO_PROJECT_PROGRAMME.md §A C1.8, §C.1 row C1).
 *
 *   node --import tsx scripts/cairo-advances.mjs [--base http://127.0.0.1:4191] [--check]
 *
 * Needs the app's dev server (`npm run dev`) and Playwright's Chromium. The
 * faces are the app's own: every «Cairo» @font-face rule in index.html (the
 * three subsets under /fonts/cairo/) and src/index.css (the Kurdish patch),
 * declared in the same order with the same unicode-range, loaded by URL from
 * the dev server — never from Google Fonts.
 *
 * What it measures, at 1000 px (so 1 px = 1/1000 em), at every weight from
 * 300 to 900 in steps of 50:
 *   · each code point's advance; an Arabic letter in each positional form its
 *     joining class allows (isolated X, initial Xـ, medial ـXـ, final ـX —
 *     tatweel as the joining context, its own width taken off), a lam-alef
 *     ligature isolated and final; a Latin letter that NFD-folds to a base
 *     that is never narrower gets no entry of its own;
 *   · every pair of characters (Latin, and Arabic in the four joining
 *     contexts): where kerning or a contextual form makes a pair wider than
 *     its two entries, an Arabic pair becomes a pair rule (`kern`: the left
 *     letters with the same right letters share one, at their widest) and
 *     any other pair widens its first entry — then every pair is measured
 *     again at every weight and none may be wider than the table;
 *   · a corpus of Arabic, Sorani and Latin names: the table is never below
 *     the browser;
 *   · the cap height (H, the lowest across weights), each script's ink
 *     ascent, descent and overhang past the advance (the highest), and the
 *     thinnest stroke per weight (pixel runs through e, o, H, I, alef and
 *     tatweel).
 *
 * The table: 500 units per em, rounded up; two weights, 400 and 900 (a
 * weight below 400 reads the 400 value, between them a straight line — both
 * checked at every 50 from 300 to 900 and raised wherever they would fall
 * below the browser); per entry the 400 value in two characters, then the
 * rise to 900 in steps of 3 units, rounded up, + 16.
 * Deterministic: the same faces and browser write the same bytes; `--check`
 * measures and compares with the committed file without writing it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { textRuleAllows } from '../packages/catalog/src/personalize/config.ts';
import { formCount, glyphRun, joiningClass } from '../packages/catalog/src/personalize/fit.ts';
import { CAIRO as COMMITTED } from '../packages/catalog/src/personalize/cairoAdvances.ts';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'packages/catalog/src/personalize/cairoAdvances.ts');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const BASE = arg('--base') || process.env.BASE_URL || 'http://127.0.0.1:4191';
const CHECK = process.argv.includes('--check');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright/index.js'));
}

const UNITS = 500;
/** A rise between two weights is stored in steps of this many units. */
const STEP = 3;
const KNOTS = [400, 900];
const PROBES = [300, 400, 700, 900];
const WEIGHTS = [];
for (let w = 300; w <= 900; w += 50) WEIGHTS.push(w);
const STEM_WEIGHTS = [300, 400, 500, 600, 700, 800, 900];
const GAP = 0.08;
/** Data characters: code point − 48 is the value (0–63), '0' to 'o'. */
const CH = (v) => String.fromCharCode(48 + v);
const T = '\u0640';
const ALEFS = [0x622, 0x623, 0x625, 0x627];
const LAMS = [0x644, 0x6b5];
const hex = (n) => n.toString(16);
const log = (...a) => console.log(...a);
const esc = (str) => [...str].map((ch) => (ch.codePointAt(0) > 0x7e ? `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}` : ch)).join('');

// ------------------------------------------------------------ the app's faces

function fontFaces() {
  const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
  const css = readFileSync(resolve(ROOT, 'src/index.css'), 'utf8');
  const faces = [];
  for (const src of [html, css]) {
    for (const m of src.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
      const body = m[1];
      if (!/font-family:\s*"Cairo"/.test(body)) continue;
      const url = /url\("([^"]+)"\)/.exec(body)?.[1];
      const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1]?.trim();
      const weight = /font-weight:\s*([^;]+);/.exec(body)?.[1]?.trim();
      if (url && range) faces.push({ url, range, weight: weight || '400' });
    }
  }
  if (faces.length < 4) throw new Error(`expected the three Cairo subsets and the Kurdish patch, found ${faces.length} faces`);
  return faces;
}

// ------------------------------------------------------------- the alphabet

const allowed = [];
for (let cp = 0; cp < 0x3000; cp++) if (textRuleAllows(cp)) allowed.push(cp);
const zeroWidth = new Set([0x200c, 0x200d]);
const isLatinLetter = (cp) => cp >= 0xc0 && cp <= 0x24f;
const foldBase = (cp) => String.fromCodePoint(cp).normalize('NFD').codePointAt(0);
const arabic = (cp) => cp >= 0x600 && cp <= 0x6ff;

/** The context strings whose width (minus the tatweels) is a form's advance. */
function formStrings(cp) {
  const x = String.fromCodePoint(cp);
  const n = formCount(cp);
  if (n === 4) return [[x, 0], [x + T, 1], [T + x + T, 2], [T + x, 1]];
  if (n === 2) return [[x, 0], [T + x, 1]];
  return [[x, 0]];
}

// ---------------------------------------------------------------- measuring

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${BASE}/fonts/cairo/LICENSE`);
const loaded = await page.evaluate(async (faces) => {
  for (const f of faces) {
    const face = new FontFace('Cairo', `url(${f.url})`, { weight: f.weight, unicodeRange: f.range, display: 'block' });
    document.fonts.add(face);
    await face.load();
  }
  return [...document.fonts].map((f) => f.status);
}, fontFaces());
if (loaded.some((s) => s !== 'loaded')) throw new Error(`fonts did not load: ${loaded.join(', ')}`);

/** widths[i][j] = width of strings[i] at weights[j], 1000 px; with ink boxes when asked. */
async function measure(strings, weights, ink = false) {
  return page.evaluate(
    ({ strings, weights, ink }) => {
      const c = document.createElement('canvas').getContext('2d');
      return strings.map((s) =>
        weights.map((w) => {
          c.font = `${w} 1000px Cairo`;
          const m = c.measureText(s);
          return ink ? [m.width, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent, m.actualBoundingBoxLeft, m.actualBoundingBoxRight] : m.width;
        })
      );
    },
    { strings, weights, ink }
  );
}

const tatCheck = await measure([T, T + T, T + T + T], WEIGHTS);
for (const row of tatCheck) row.forEach((v, j) => { if (Math.abs(v / (tatCheck.indexOf(row) + 1) - tatCheck[0][j]) > 0.01) throw new Error('tatweel is not a constant-width joiner'); });
const zw = await measure(['\u200c', '\u200d'], WEIGHTS);
if (zw.flat().some((v) => v !== 0)) throw new Error('ZWNJ/ZWJ draw with a width');

// entries: key → { forms: [strings…], rows: [form][weight] px }
const entries = new Map();
const folded = [];
const own = [];
for (const cp of allowed) {
  if (zeroWidth.has(cp)) continue;
  entries.set(cp, formStrings(cp));
}
const keys = [...entries.keys()];
const flat = keys.flatMap((k) => entries.get(k));
const rows = await measure(flat.map(([s]) => s), WEIGHTS);
const tatW = tatCheck[0];
let r = 0;
const px = new Map();
for (const k of keys) {
  const forms = entries.get(k).map(([, tats]) => rows[r++].map((v, j) => v - tats * tatW[j]));
  px.set(k, forms);
}
// Latin letters folding to a base that is never narrower need no entry.
for (const cp of keys) {
  if (!isLatinLetter(cp)) continue;
  const base = foldBase(cp);
  if (base === cp || !px.has(base)) {
    own.push(cp);
    continue;
  }
  const narrower = px.get(cp)[0].every((v, j) => v <= px.get(base)[0][j] + 1e-9);
  if (narrower && !isLatinLetter(base)) {
    folded.push(cp);
    px.delete(cp);
  } else own.push(cp);
}

// lam-alef ligatures
const lig = [];
const ligPx = new Map();
for (const lam of LAMS) {
  const strs = [];
  for (const alef of ALEFS) {
    const s = String.fromCodePoint(lam, alef);
    strs.push(s, T + s);
  }
  const m = await measure(strs, WEIGHTS);
  const isol = ALEFS.map((_, i) => m[2 * i]);
  const fina = ALEFS.map((_, i) => m[2 * i + 1].map((v, j) => v - tatW[j]));
  const separate = ALEFS.map((alef) => px.get(lam)[1].map((v, j) => v + px.get(alef)[1][j]));
  const ligates = isol.map((row, i) => row.some((v, j) => Math.abs(v - separate[i][j]) > 0.5));
  if (ligates.some((x) => x !== ligates[0])) throw new Error(`U+${hex(lam)} ligates with some alefs only`);
  if (!ligates[0]) continue;
  lig.push(lam);
  ALEFS.forEach((alef, i) => ligPx.set(lam * 0x10000 + alef, [isol[i], fina[i]]));
}
const lzwj = await measure(['ل\u200dا'], [400]);

// ---------------------------------------------------------- the table values

const ceilU = (v) => Math.ceil((v / 1000) * UNITS - 1e-9);
/** Knot values (units) for one form's measured row, raised until the straight lines are never below. */
/** The knot segment a weight falls in and its position there (0–1; clamped outside the knots, as fit.ts reads it). */
function segment(w) {
  let s = 0;
  while (s < KNOTS.length - 2 && w > KNOTS[s + 1]) s++;
  return [s, Math.min(1, Math.max(0, (w - KNOTS[s]) / (KNOTS[s + 1] - KNOTS[s])))];
}
function knotsOf(row) {
  const k = KNOTS.map((w) => ceilU(row[WEIGHTS.indexOf(w)]));
  for (let pass = 0; pass < 8; pass++) {
    let bumped = false;
    WEIGHTS.forEach((w, j) => {
      const [s, t] = segment(w);
      const v = k[s] + (k[s + 1] - k[s]) * t;
      const need = (row[j] / 1000) * UNITS;
      if (v < need - 1e-9) {
        const d = Math.ceil(need - v - 1e-9);
        k[s] += d;
        k[s + 1] += d;
        bumped = true;
      }
    });
    if (!bumped) break;
  }
  return k;
}
const table = new Map();
/** Pair rules: [left letters, right letters, extra width per weight (units)]. */
let kern = [];
for (const [k, forms] of px) table.set(k, forms.map(knotsOf));
for (const [k, forms] of ligPx) table.set(k, forms.map(knotsOf));

const interp = (knots, w) => {
  const [s, t] = segment(w);
  return (knots[s] + (knots[s + 1] - knots[s]) * t) / UNITS;
};
const foldKey = (cp) => (table.has(cp) || cp > 0xffff || !isLatinLetter(cp) ? cp : foldBase(cp));
const slot = (key, form) => {
  const n = key > 0xffff ? 2 : formCount(key);
  return n === 4 ? form : n === 2 && form === 3 ? 1 : 0;
};
const adv = (key, form, w) => {
  const k = foldKey(key);
  const e = table.get(k);
  return e ? interp(e[slot(k, form)], w) : 1.5;
};
/** A pair rule's extra width between two glyphs (a ligature: its alef on the left, its lam on the right). */
function kernEm(left, right, w) {
  const l = String.fromCodePoint(left > 0xffff ? left & 0xffff : left);
  const r = String.fromCodePoint(right > 0xffff ? Math.floor(right / 0x10000) : right);
  for (const [ls, rs, v] of kern) if (ls.includes(l) && rs.includes(r)) return interp(v, w);
  return 0;
}
/** The table's estimate of a line, in em — fit.ts's measureEm over the new data. */
function estimate(text, w) {
  let em = 0;
  let prev = -1;
  for (const [key, form] of glyphRun(text)) {
    em += adv(key, form, w);
    if (prev >= 0) em += kernEm(prev, key, w);
    prev = key;
  }
  return em;
}

// ------------------------------------------------ pairs: kerning and context

const latinSet = keys.filter((cp) => !arabic(cp) && !zeroWidth.has(cp) && (cp < 0xc0 || own.includes(cp)));
const arabicSet = keys.filter((cp) => arabic(cp) && cp !== 0x640);
function pairStrings() {
  const out = [];
  for (const a of latinSet) for (const b of latinSet) out.push(String.fromCodePoint(a, b));
  for (const a of arabicSet) {
    for (const b of arabicSet) {
      const s = String.fromCodePoint(a, b);
      out.push(s, T + s, s + T, T + s + T);
    }
  }
  return out;
}
const pairs = pairStrings();
const tatsOf = (s) => (s.startsWith(T) ? 1 : 0) + (s.endsWith(T) ? 1 : 0);
/** Every pair whose drawn width exceeds the table's estimate: [string, weight index, excess em]. */
async function excesses(weights) {
  const got = [];
  for (let i = 0; i < pairs.length; i += 4000) got.push(...(await measure(pairs.slice(i, i + 4000), weights)));
  const out = [];
  pairs.forEach((s, i) => {
    const tats = tatsOf(s);
    weights.forEach((w, j) => {
      const measured = (got[i][j] - tats * tatW[WEIGHTS.indexOf(w)]) / 1000;
      const over = measured - (estimate(s, w) - tats * adv(0x640, 0, w));
      if (over > 1e-6) out.push([s, j, over]);
    });
  });
  return out;
}
const glyphsOf = (s) => glyphRun(s).filter(([k]) => k !== 0x640);
/** Raise an entry (every weight alike) by `units`. */
const raiseEntry = (key, form, units, why) => {
  const k = foldKey(key);
  const knots = table.get(k)[slot(k, form)];
  for (let i = 0; i < knots.length; i++) knots[i] += units;
  bumps.push(`U+${hex(k)}/${form} +${units} (${why})`);
};
const bumps = [];
// 1. at the four weights: a wider Latin pair widens its first glyph; a wider Arabic pair becomes a pair rule.
const first = await excesses(PROBES);
const fold1 = new Map();
const kernPairs = new Map();
for (const [s, , over] of first) {
  const g = glyphsOf(s);
  const lead = g[0];
  if (!arabic(lead[0] & 0xffff) || g.length < 2) {
    const id = `${lead[0]}:${lead[1]}`;
    fold1.set(id, { key: lead[0], form: lead[1], units: Math.max(fold1.get(id)?.units ?? 0, Math.ceil(over * UNITS - 1e-9)), why: s.replace(/ـ/g, '') });
  } else {
    const l = String.fromCodePoint(lead[0] & 0xffff);
    const r = String.fromCodePoint(g[1][0] > 0xffff ? Math.floor(g[1][0] / 0x10000) : g[1][0]);
    if (!kernPairs.has(l)) kernPairs.set(l, new Set());
    kernPairs.get(l).add(r);
  }
}
for (const { key, form, units, why } of fold1.values()) raiseEntry(key, form, units, why);
// Lefts with the same rights share one rule; its values are the widest excess of its pairs, at every weight.
const byRights = new Map();
for (const [l, rs] of kernPairs) {
  const id = [...rs].sort().join('');
  byRights.set(id, (byRights.get(id) ?? '') + l);
}
kern = [];
for (const [rights, lefts] of byRights) {
  const strs = [];
  for (const l of lefts) for (const r of rights) { const s = l + r; strs.push(s, T + s, s + T, T + s + T); }
  const got = await measure(strs, WEIGHTS);
  const row = WEIGHTS.map((w, j) => Math.max(0, ...strs.map((s, i) => got[i][j] - tatsOf(s) * tatW[j] - (estimate(s, w) - tatsOf(s) * adv(0x640, 0, w)) * 1000)));
  kern.push([lefts, rights, knotsOf(row)]);
}
// 2. every pair at every weight, with the rules: anything still wider widens its first glyph.
for (let pass = 0; pass < 3; pass++) {
  const left = await excesses(WEIGHTS);
  if (!left.length) break;
  const fold2 = new Map();
  for (const [s, , over] of left) {
    const lead = glyphsOf(s)[0];
    const id = `${lead[0]}:${lead[1]}`;
    fold2.set(id, { key: lead[0], form: lead[1], units: Math.max(fold2.get(id)?.units ?? 0, Math.ceil(over * UNITS - 1e-9)), why: s.replace(/ـ/g, '') });
  }
  for (const { key, form, units, why } of fold2.values()) raiseEntry(key, form, units, why);
}
const residual = await excesses(WEIGHTS);
if (residual.length) throw new Error(`pairs still wider than the table: ${residual.slice(0, 5).map(([s]) => s).join(' ')}`);

// ------------------------------------------------------------ names corpus

const CORPUS = [
  'علي', 'محمد', 'فاطمة', 'عبدالله', 'عبد الرحمن', 'زينب', 'مصطفى', 'حسين', 'نور الهدى', 'لؤلؤة', 'ليلى', 'سلام', 'إسلام', 'آلاء', 'لانا', 'بلال', 'غسان', 'ياسمين', 'شهد', 'ضحى',
  'ئاری', 'ژیلا', 'هێمن', 'ڕێژین', 'ڵاوان', 'گوڵاڵە', 'بەهار', 'ئاسۆ', 'دڵنیا', 'ڤیان', 'پەیمان', 'چیا', 'کۆسرەت', 'ڕۆژان', 'سەرکەوت', 'نەوڕۆز', 'هەڵۆ', 'شنۆ', 'ئەڤین', 'ژیان',
  'ALI', 'Mohammed', 'SARA', 'Zainab', 'Mustafa', 'WWW', 'Ali & Sara', "O'Neil", 'Zoë', 'Łukasz', 'Ďuro', 'Straße', 'MMMMMMMMMM', 'Hi!', 'Team+1', 'Ready?', 'Dr. Omar',
  'هێڵ', 'پێڕەو', 'گێڵ', 'بێڕێز', 'ڕێڕەو', 'کێڵگە', 'ئێڵ', 'دێڕ', 'زیرەک', 'ريم', 'ڕیان', 'ژیر', 'پێڕۆ', 'زيد', 'رياض', 'ژيان', 'ئەوین', 'شێرکۆ', 'ڕووناک', 'ئاڵا',
  '٢٠٢٦', '۱۴۰۵', 'علي 2026', 'ئاری ١٢', 'لا', 'ﻻ', 'ـلاـ', 'لا لا لا', 'بلا', 'الله', 'ل\u200dا', 'ل\u200cا', 'عـلـي',
];
const corpusGot = await measure(CORPUS, WEIGHTS);
let worstRatio = 0;
let bestRatio = Infinity;
const below = [];
CORPUS.forEach((s, i) => {
  if (!s.split('').every((ch) => textRuleAllows(ch.codePointAt(0)))) return;
  WEIGHTS.forEach((w, j) => {
    const m = corpusGot[i][j] / 1000;
    const e = estimate(s, w);
    worstRatio = Math.max(worstRatio, m / e);
    bestRatio = Math.min(bestRatio, m / e);
    if (m > e + 1e-9) below.push(`${s} @${w}: browser ${m.toFixed(4)} > table ${e.toFixed(4)}`);
  });
});
if (below.length) throw new Error(`the table is below the browser:\n${below.join('\n')}`);

// ------------------------------------------------------ vertical metrics, stems

const inkStrings = [...px.keys()].flatMap((k) => entries.get(k).map(([s]) => [s, arabic(k) ? 1 : 0]));
for (const lam of lig) for (const alef of ALEFS) inkStrings.push([String.fromCodePoint(lam, alef), 1], [T + String.fromCodePoint(lam, alef), 1]);
const inkRows = await measure(inkStrings.map(([s]) => s), STEM_WEIGHTS, true);
const asc = [0, 0];
const desc = [0, 0];
const over = [0, 0];
inkRows.forEach((row, i) => {
  const c = inkStrings[i][1];
  for (const [wd, a, d, l, rt] of row) {
    asc[c] = Math.max(asc[c], a / 1000);
    desc[c] = Math.max(desc[c], d / 1000);
    over[c] = Math.max(over[c], Math.max(0, l) / 1000, Math.max(0, rt - wd) / 1000);
  }
});

const scans = await page.evaluate((weights) => {
  const cv = document.createElement('canvas');
  cv.width = 3000;
  cv.height = 2000;
  const c = cv.getContext('2d', { willReadFrequently: true });
  const draw = (s, w) => {
    c.clearRect(0, 0, cv.width, cv.height);
    c.font = `${w} 1000px Cairo`;
    c.fillStyle = '#000';
    c.fillText(s, 400, 1400);
    return c.getImageData(0, 0, cv.width, cv.height);
  };
  const on = (img, x, y) => img.data[(y * img.width + x) * 4 + 3] > 127;
  const box = (img) => {
    let t = 1e9, b = -1, l = 1e9, r = -1;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (on(img, x, y)) { t = Math.min(t, y); b = Math.max(b, y); l = Math.min(l, x); r = Math.max(r, x); }
    return { t, b, l, r };
  };
  const runs = (img, fixed, alongX) => {
    const out = [];
    let start = -1;
    const n = alongX ? img.width : img.height;
    for (let i = 0; i <= n; i++) {
      const hit = i < n && (alongX ? on(img, i, fixed) : on(img, fixed, i));
      if (hit && start < 0) start = i;
      if (!hit && start >= 0) { out.push(i - start); start = -1; }
    }
    return out;
  };
  return weights.map((w) => {
    let img = draw('H', w);
    const h = box(img);
    const cap = 1400 - h.t;
    const found = [...runs(img, Math.round((h.l + h.r) / 2), false)];
    for (const [s, alongX] of [['I', true], ['o', false], ['o', true], ['e', false], ['ا', true], ['ـ', false]]) {
      img = draw(s, w);
      const b = box(img);
      found.push(...runs(img, alongX ? Math.round((b.t + b.b) / 2) : Math.round((b.l + b.r) / 2), alongX));
    }
    return { w, cap, stem: Math.min(...found) };
  });
}, STEM_WEIGHTS);
await browser.close();

const cap = Math.min(...scans.map((s) => s.cap)) / 1000;
const stem = scans.map((s) => s.stem / 1000);

// ------------------------------------------------------------ writing it out

function ranges(cps) {
  const out = [];
  for (let i = 0; i < cps.length; i++) {
    let j = i;
    while (j + 1 < cps.length && cps[j + 1] === cps[j] + 1) j++;
    out.push(j > i ? `${hex(cps[i])}-${hex(cps[j])}` : hex(cps[i]));
    i = j;
  }
  return out.join(',');
}
const stored = [...px.keys()].sort((a, b) => a - b);
let data = '';
const put = (knots) => {
  if (knots[0] < 0 || knots[0] >= 4096) throw new Error(`base out of range: ${knots[0]}`);
  data += CH(knots[0] >> 6) + CH(knots[0] & 63);
  let recon = knots[0];
  for (let i = 1; i < knots.length; i++) {
    const step = Math.ceil((knots[i] - recon) / STEP);
    if (step < -16 || step > 47) throw new Error(`step out of range: ${step} in ${knots.join(' ')}`);
    data += CH(step + 16);
    recon += STEP * step;
  }
};
for (const cp of stored) {
  const forms = table.get(cp);
  if (forms.length !== formCount(cp)) throw new Error(`U+${hex(cp)}: ${forms.length} forms, joining class ${joiningClass(cp)}`);
  try {
    forms.forEach(put);
  } catch (e) {
    throw new Error(`U+${hex(cp)}: ${e.message}`);
  }
}
const ligStr = lig.map((cp) => String.fromCodePoint(cp)).join('');
// fit.ts's glyphRun forms ligatures from the committed table's `lig`: the estimates above used it.
if (ligStr !== COMMITTED.lig) throw new Error(`the ligating lams changed (${esc(COMMITTED.lig)} → ${esc(ligStr)}): write lig into the table by hand once and re-run`);
for (const lam of lig) for (const alef of ALEFS) table.get(lam * 0x10000 + alef).forEach(put);
const cpsStr = ranges(stored);
const fnv = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};
const kernStr = JSON.stringify(kern);
const sum = fnv(`${cpsStr}|${ligStr}|${kernStr}|${data}`);
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const up4 = (v) => Math.ceil(v * 1e4 - 1e-9) / 1e4;
const down4 = (v) => Math.floor(v * 1e4 + 1e-9) / 1e4;

const file = `/**
 * GENERATED by scripts/cairo-advances.mjs from the app's own Cairo faces (the
 * three subsets and the Kurdish patch) in Chromium — do not edit; re-run the
 * script (tests/personalizeFit.test.ts pins the checksum). Smart Fit's only
 * data: fit.ts decodes it on first use.
 *
 *   u      data units per em (values rounded up)
 *   w      the weights the data holds: a lighter weight reads the first,
 *          between two the value is linear (never below the browser)
 *   cap    cap height / em (H, the lowest across weights)
 *   asc, desc, over   ink above / below the baseline and past the advance at
 *          a line's end, em, [Latin, Arabic] (the highest across weights)
 *   gap    the space between two stacked lines, em
 *   stem   the thinnest stroke / em at 300, 400 … 900
 *   lig    lams that form a ligature with a following آ أ إ ا
 *   kern   pair rules [left, right, units per weight]: a glyph whose letter
 *          is in \`left\` followed by one whose letter is in \`right\` draws
 *          that much wider — the contextual spacing Arabic pairs have here
 *   cps    the code points with entries (hex ranges); an Arabic letter holds
 *          one entry per form its joining class allows (fit.ts formCount), a
 *          ligature two (isolated, final) after them; any other Latin letter
 *          the rule allows folds to its NFD base
 *   data   per entry, each character's code point − 48 a value 0–63: the
 *          value at w[0] in two characters (high, low), then one per next
 *          weight: its rise in steps of 3 units, + 16 (rounded up, so a value
 *          is never below the measured one)
 * CAIRO_SUM is FNV-1a 32 of \`\${cps}|\${lig}|\${JSON of kern}|\${data}\`.
 */
export interface CairoTable {
  u: number;
  w: readonly number[];
  cap: number;
  asc: readonly [number, number];
  desc: readonly [number, number];
  over: readonly [number, number];
  gap: number;
  stem: readonly number[];
  lig: string;
  kern: ReadonlyArray<readonly [string, string, readonly number[]]>;
  cps: string;
  data: string;
}

export const CAIRO: CairoTable = {
  u: ${UNITS},
  w: [${KNOTS.join(', ')}],
  cap: ${down4(cap)},
  asc: [${up4(asc[0])}, ${up4(asc[1])}],
  desc: [${up4(desc[0])}, ${up4(desc[1])}],
  over: [${up4(over[0])}, ${up4(over[1])}],
  gap: ${GAP},
  stem: [${stem.map(down4).join(', ')}],
  lig: '${esc(ligStr)}',
  kern: ${esc(JSON.stringify(kern).replace(/"/g, "'").replace(/,/g, ', '))},
  cps: '${cpsStr}',
  data: '${data.replace(/\\/g, '\\\\')}',
};

export const CAIRO_SUM = 0x${sum.toString(16).padStart(8, '0')};
`;

log(`faces: ${fontFaces().map((f) => f.url).join(' ')}`);
log(`alphabet: ${allowed.length} code points allowed by the text rule; ${zeroWidth.size} zero-width; ${folded.length} Latin letters folded to their base; ${own.length} Latin letters with their own entry`);
log(`entries: ${stored.length} code points, ${data.length / (KNOTS.length + 1)} entries (${lig.length ? `lam-alef ligatures for ${lig.map((c) => `U+${hex(c)}`).join(' ')}` : 'no ligatures'}); U+0644 ZWJ U+0627 draws ${lzwj[0][0].toFixed(1)}/1000 em`);
log(`pairs checked: ${pairs.length} strings × ${WEIGHTS.length} weights; pair rules: ${kern.map(([l, rs, v]) => `${l}→${rs} +${v.join('/')}`).join('; ') || 'none'}; raised: ${bumps.length ? bumps.join(', ') : 'none'}`);
log(`corpus: ${CORPUS.length} names × ${WEIGHTS.length} weights; browser/table ratio ${r4(bestRatio)}…${r4(worstRatio)} (never above 1)`);
log(`cap ${down4(cap)} em; asc ${asc.map(up4).join('/')} desc ${desc.map(up4).join('/')} over ${over.map(up4).join('/')} (Latin/Arabic); stems ${stem.map(down4).join(' ')}`);
log(`data ${data.length} chars; cps ${cpsStr.length} chars; checksum 0x${sum.toString(16).padStart(8, '0')}`);

if (CHECK) {
  const same = readFileSync(OUT, 'utf8') === file;
  log(same ? 'check: the committed table matches' : 'check: the committed table DIFFERS from a fresh measurement');
  process.exit(same ? 0 : 1);
}
writeFileSync(OUT, file);
log(`wrote ${OUT} (${Buffer.byteLength(file)} bytes)`);
