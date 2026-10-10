/**
 * «تحديث البيانات» — THE OWNER'S FLOW AND THE SIZE REFUSALS' OWN ADVICE
 * (docs/DECISIONS.md row 207; written by the ux verifier of 317e878d).
 *
 * T1  The owner's flow, at small scale, through the real routes: download, fill
 *     the five shipping fields on every pricing scope from empty (kind 'data'),
 *     one line made stale (status), one combination stock (derived lines), then
 *     preview and apply. Every row the sheet shows — changes, refusals, the
 *     stale group and the derived group — is titled with the sheet's own
 *     `rowTitle` (exactly as DataFileSheet.tsx calls it, with the line's nkey)
 *     in ar, en and ckb: never a snake_case key leaf, the four keys the owner
 *     saw raw read the pricing screens' words, and the ckb field part is never
 *     the Arabic.
 * T2  DATA_FILE_PRICING_TOO_LARGE's own advice: «delete about half of the
 *     pricing blocks (start with pricing.skus), apply the rest, then attach the
 *     original file again: what was applied reads as unchanged and the rest is
 *     applied» — held to the real comparison.
 * T3  DATA_FILE_PRODUCT_TOO_LARGE's own advice: «delete the options, colors,
 *     variants and images lines from the file, then attach it again to apply the
 *     rest of its lines» — the rest (pricing lines included) applies in one go
 *     and no model or colour is removed by the deleted lines.
 * T4  DATA_FILE_TOO_LARGE's own advice: «delete the pricing lines, attach it and
 *     apply it, then attach the original file again» — two comparisons, two
 *     atomic applies, every line of the file written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { get, post } from './fixtures/app';
import { SHIPPING5, bigWorld, coldApp, fillPricing, setLines } from './fixtures/dataFileLarge';
import { PRICING_FIELD_LABELS } from '../packages/contracts/src/pricingFieldLabels';
import { DATA_FILE_REFUSALS } from '../packages/contracts/src/dataFileRefusals';
import { DATA_FILE_STRINGS as S, fieldLabel, itemOfNkey, pick, rowTitle, type DataFileLabels } from '../src/components/adminProducts/dataFileStrings';

interface Line {
  key: string;
  nkey: string;
  status: string;
  item: { group: string; id: string } | null;
}
interface Card {
  product_id: string;
  token: string | null;
  fields: Line[];
  derived: Array<{ key: string; nkey: string }>;
  pricing: { kind: string; preview_hash: string | null; large_change: boolean } | null;
  labels?: DataFileLabels;
}

async function previewOf(raw: Parameters<typeof coldApp>[0], id: string, text: string): Promise<Card> {
  const res = await post(coldApp(raw).app, '/api/admin/template/data-preview', { text, product_id: id });
  const body = (await res.json()) as { products: Card[] };
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 400));
  return body.products[0];
}
async function applyOf(raw: Parameters<typeof coldApp>[0], id: string, text: string, p: Card) {
  const res = await post(coldApp(raw).app, '/api/admin/template/data-apply', {
    text,
    product_id: id,
    token: p.token,
    ...(p.pricing?.preview_hash ? { pricing_hash: p.pricing.preview_hash } : {}),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}
const download = async (raw: Parameters<typeof coldApp>[0], id: string) => {
  const res = await get(coldApp(raw).app, `/api/admin/template/data-export/${id}`);
  assert.equal(res.status, 200);
  return res.text();
};
const dropLines = (text: string, drop: (key: string) => boolean) =>
  text
    .split('\n')
    .filter((l) => {
      const eq = l.indexOf('=');
      return eq < 0 || !drop(l.slice(0, eq));
    })
    .join('\n');

const SNAKE = /\b[a-z]+_[a-z0-9_]+\b/;

test('T1 — the owner-shaped file: every row, stale and derived line titled in ar/en/ckb, never a raw key; applies, nothing unpersisted', async () => {
  const w = await bigWorld({ opts: 3, cols: ['black', 'white'] });
  const original = w.text;
  // Something saved after the download, in a section the file does not edit: the file's line is just older (STALE_IN_FILE).
  const st0 = setLines(original, new Map([['status', 'active']]));
  const p0 = await previewOf(w.raw, w.id, st0);
  assert.ok(p0.token, JSON.stringify(p0.fields));
  assert.equal((await applyOf(w.raw, w.id, st0, p0)).status, 200);

  const shipping = fillPricing(original, SHIPPING5);
  const stockKey = /^(variants\.\d+)\.id=/m.exec(original)![1] + '.stock';
  const text = setLines(original, new Map([...shipping, [stockKey, '77']]));
  const p = await previewOf(w.raw, w.id, text);

  assert.equal(p.pricing?.kind, 'data', 'the pricing notice is the data-only one');
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(pick(S.pricingData, lang).length > 0);
  const changes = p.fields.filter((f) => f.status === 'change');
  const stale = p.fields.filter((f) => f.status === 'STALE_IN_FILE');
  assert.ok(stale.some((f) => f.key === 'status'), `status is stale: ${JSON.stringify(p.fields.filter((f) => f.status !== 'change'))}`);
  assert.equal(changes.filter((f) => f.key.startsWith('pricing.')).length, shipping.size);

  const problems: string[] = [];
  const rows: Array<[string, { group: string; id: string } | null, string, string | undefined]> = [
    ...p.fields.map((f): [string, { group: string; id: string } | null, string, string | undefined] => [f.key, f.item, f.status, f.nkey]),
    ...p.derived.map((d): [string, { group: string; id: string } | null, string, string | undefined] => [d.key, itemOfNkey(d.nkey ?? ''), 'derived', d.nkey]),
  ];
  for (const [key, item, kind, nkey] of rows) {
    const titles = Object.fromEntries((['ar', 'en', 'ckb'] as const).map((l) => [l, rowTitle(key, item, p.labels, l, nkey)])) as Record<'ar' | 'en' | 'ckb', string>;
    for (const l of ['ar', 'en', 'ckb'] as const) {
      if (SNAKE.test(titles[l])) problems.push(`${kind} ${key} [${l}]: raw key in «${titles[l]}»`);
      if (titles[l] === key) problems.push(`${kind} ${key} [${l}]: the key itself`);
    }
    const field = fieldLabel(key, p.labels);
    if (field.ckb === field.ar) problems.push(`${kind} ${key}: ckb field copies the Arabic «${field.ar}»`);
  }
  if (process.env.UX_DUMP) {
    const dump = rows.map(([key, item, kind, nkey]) => ({ kind, key, ar: rowTitle(key, item, p.labels, 'ar', nkey), en: rowTitle(key, item, p.labels, 'en', nkey), ckb: rowTitle(key, item, p.labels, 'ckb', nkey) }));
    writeFileSync(process.env.UX_DUMP, JSON.stringify(dump, null, 1));
  }
  assert.deepEqual(problems, []);
  // The four the owner saw raw, at a model scope, by the pricing screens' words.
  const model = changes.find((f) => f.key.startsWith('pricing.options.') && f.key.endsWith('.shipping_height_mm'))!;
  for (const f of ['shipping_length_mm', 'shipping_width_mm', 'shipping_height_mm', 'manual_cbm', 'shipping_weight_g'] as const) {
    const k = model.key.replace(/shipping_height_mm$/, f);
    const line = changes.find((x) => x.key === k)!;
    for (const l of ['ar', 'en', 'ckb'] as const) {
      const t = rowTitle(line.key, line.item, p.labels, l, line.nkey);
      assert.ok(t.endsWith(PRICING_FIELD_LABELS[f][l]), `${k} [${l}] «${t}»`);
      assert.ok(t.length > PRICING_FIELD_LABELS[f][l].length, `${k} [${l}] names its model: «${t}»`);
    }
  }

  const res = await applyOf(w.raw, w.id, text, p);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
  assert.deepEqual(res.body.not_persisted, []);
});

test('T2 — DATA_FILE_PRICING_TOO_LARGE advice: half the blocks first, then the original file — applied reads unchanged, the rest applies', async () => {
  // The advice the owner reads, in every language, names the steps tested here.
  assert.match(DATA_FILE_REFUSALS.DATA_FILE_PRICING_TOO_LARGE.en, /attach the original file again/);
  const w = await bigWorld({ opts: 3, cols: ['black', 'white'] });
  const full = setLines(w.text, fillPricing(w.text, SHIPPING5));
  // Step 1: the file without its pricing.skus blocks.
  const half = dropLines(full, (k) => k.startsWith('pricing.skus.'));
  const p1 = await previewOf(w.raw, w.id, half);
  const skuLines = [...fillPricing(w.text, SHIPPING5).keys()].filter((k) => k.startsWith('pricing.skus.'));
  assert.equal(p1.fields.filter((f) => f.status === 'change').length, fillPricing(w.text, SHIPPING5).size - skuLines.length);
  assert.equal((await applyOf(w.raw, w.id, half, p1)).status, 200);
  // Step 2: the original file again.
  const p2 = await previewOf(w.raw, w.id, full);
  const notChange = p2.fields.filter((f) => f.status !== 'change').map((f) => `${f.key}:${f.status}`);
  assert.deepEqual(notChange, [], 'nothing refused or stale on the second attach');
  assert.deepEqual(p2.fields.map((f) => f.key).sort(), skuLines.sort(), 'exactly the rest');
  const r2 = await applyOf(w.raw, w.id, full, p2);
  assert.equal(r2.status, 200, JSON.stringify(r2.body).slice(0, 400));
  const p3 = await previewOf(w.raw, w.id, full);
  assert.deepEqual(p3.fields.filter((f) => f.status !== 'STALE_IN_FILE'), [], 'the whole file now reads unchanged');
});

test('T3 — DATA_FILE_PRODUCT_TOO_LARGE advice: the file without its options/colors/variants/images lines applies the rest in one go', async () => {
  // The advice the owner reads names the step tested here (and no longer a partial «pricing lines only» apply).
  assert.match(DATA_FILE_REFUSALS.DATA_FILE_PRODUCT_TOO_LARGE.en, /^Nothing was applied: .*Delete the options, colors, variants and images lines from the file, then attach it again/);
  const w = await bigWorld({ opts: 3, cols: ['black', 'white'] });
  const pricing = fillPricing(w.text, SHIPPING5);
  const optName = /^(options\.\d+)\.id=opt_m1$/m.exec(w.text)![1] + '.name_en';
  const doc = new Map<string, string>([
    ['name_en', 'Big Kit 2027'],
    [optName, 'Model One (renamed)'],
    ['spec_groups.1.rows.1.value_en', '11 mm'],
  ]);
  const full = setLines(w.text, new Map([...pricing, ...doc]));
  // «delete the options, colors, variants and images lines from the file and attach it again»
  const rest = dropLines(full, (k) => /^(options|colors|variants|images)\./.test(k));
  const p = await previewOf(w.raw, w.id, rest);
  const shown = p.fields.filter((f) => f.status !== 'STALE_IN_FILE' && !f.key.startsWith('pricing.')).map((f) => `${f.key}:${f.status}`).sort();
  assert.deepEqual(shown, ['name_en:change', 'spec_groups.1.rows.1.value_en:change'], 'the rest of the product lines, nothing else');
  assert.equal(p.fields.filter((f) => f.key.startsWith('pricing.') && f.status === 'change').length, pricing.size, 'and every pricing line');
  const r = await applyOf(w.raw, w.id, rest, p);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
  assert.deepEqual(r.body.not_persisted, []);
  const after = await download(w.raw, w.id);
  assert.equal([...after.matchAll(/^options\.\d+\.id=/gm)].length, 3, 'no model removed by the deleted lines');
  assert.equal([...after.matchAll(/^colors\.\d+\.id=/gm)].length, 2, 'no colour removed by the deleted lines');
  assert.match(after, /^name_en=Big Kit 2027$/m, 'the rest of the product lines landed');
  assert.doesNotMatch(after, /Model One \(renamed\)/, 'the deleted model line was not applied');
  for (const [k, v] of pricing) assert.match(after, new RegExp(`^${k.replace(/\./g, '\\.')}=${v.replace(/\./g, '\\.')}$`, 'm'), k);
});

test('T4 — DATA_FILE_TOO_LARGE advice: the file without its pricing lines, then the original file — two atomic applies, every line written', async () => {
  assert.match(DATA_FILE_REFUSALS.DATA_FILE_TOO_LARGE.en, /^Nothing was applied: .*delete the pricing lines \(those starting with pricing\.\) from the file, attach it and apply it, then attach the original file again/);
  const w = await bigWorld({ opts: 3, cols: ['black', 'white'] });
  const pricing = fillPricing(w.text, SHIPPING5);
  const optName = /^(options\.\d+)\.id=opt_m1$/m.exec(w.text)![1] + '.name_en';
  const doc = new Map<string, string>([
    ['name_en', 'Big Kit 2028'],
    [optName, 'Model One (renamed)'],
  ]);
  const full = setLines(w.text, new Map([...pricing, ...doc]));
  // Step 1: «delete the pricing lines (those starting with pricing.) from the file, attach it and apply it».
  const noPricing = dropLines(full, (k) => k.startsWith('pricing.'));
  const p1 = await previewOf(w.raw, w.id, noPricing);
  assert.deepEqual(p1.fields.filter((f) => f.status === 'change').map((f) => f.key).sort(), [...doc.keys()].sort(), 'only the product lines');
  const r1 = await applyOf(w.raw, w.id, noPricing, p1);
  assert.equal(r1.status, 200, JSON.stringify(r1.body).slice(0, 400));
  // Step 2: «then attach the original file again: what was applied reads as unchanged and the pricing lines are applied».
  const p2 = await previewOf(w.raw, w.id, full);
  assert.deepEqual(p2.fields.filter((f) => f.status !== 'change' && f.status !== 'STALE_IN_FILE').map((f) => `${f.key}:${f.status}`), [], 'nothing refused');
  assert.deepEqual(p2.fields.filter((f) => f.status === 'change').map((f) => f.key).sort(), [...pricing.keys()].sort(), 'exactly the pricing lines');
  const r2 = await applyOf(w.raw, w.id, full, p2);
  assert.equal(r2.status, 200, JSON.stringify(r2.body).slice(0, 400));
  const p3 = await previewOf(w.raw, w.id, full);
  assert.deepEqual(p3.fields.filter((f) => f.status === 'change'), [], 'the whole file now reads unchanged');
});
