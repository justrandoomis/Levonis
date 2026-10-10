/**
 * «ملف بيانات المنتج» — COST AND PRIVATE PRICING ARE THE VERIFIED OWNER'S ALONE
 * (owner decision 2; brief 1 §38), decided by the server:
 *
 *   - an assistant, a full admin and the owner before the address is verified
 *     download a file with NO cost line, NO `pricing.*` line and no cost
 *     fingerprint — and that file attached back is zero changes;
 *   - every private line they upload is refused from the file itself
 *     (COST_OWNER_ONLY): the answer is the same bytes for a right guess and a
 *     wrong one, carries neither value, and the stored cost never moves;
 *   - the public lines of the same upload still apply.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, row } from './fixtures/app';
import { OWNER, apply, create, download, edit, preview, setup, PRODUCT } from './fixtures/dataFile';

const ASSISTANT = { id: 'usr_asst', role: 'admin' as const, email: 'asst@x.co', admin_scope: 'assistant' as string | null };
const FULL = { id: 'usr_full', role: 'admin' as const, email: 'full@x.co', admin_scope: 'full' as string | null };
const UNVERIFIED_OWNER = { ...OWNER, email_verified_at: null };

const PRIVATE_LINE = /^(?:[a-z_.0-9]*\.)?(?:product_cost_iqd|cost_iqd|cost_adjust_iqd)=|^pricing\.|^fp\.(?:cost|pricing)/m;

/** One database, the product created by the owner, then the same database seen by `who`. */
async function asStaff(who: typeof ASSISTANT | typeof UNVERIFIED_OWNER) {
  const raw = freshDb();
  const owner = setup(OWNER, raw);
  const id = await create(owner.app, PRODUCT);
  const staff = setup(who as typeof OWNER, raw);
  return { raw, id, owner, staff };
}

for (const [name, who] of [
  ['assistant', ASSISTANT],
  ['full admin', FULL],
  ['owner, address not verified', UNVERIFIED_OWNER],
] as const) {
  test(`${name}: the file has no private line, and attached back it is zero changes`, async () => {
    const { id, staff } = await asStaff(who);
    const text = await download(staff.app, id);
    assert.doesNotMatch(text, PRIVATE_LINE, 'no cost, no pricing block, no private fingerprint');
    assert.match(text, /^viewer=staff$/m);
    assert.doesNotMatch(text, /700000|650000/, 'no stored cost value anywhere in the file');
    const [p] = await preview(staff.app, text, id);
    assert.deepEqual(p.fields.filter((f) => f.status !== 'STALE_IN_FILE'), []);
  });
}

test('a non-owner upload can never change a cost: a right and a wrong guess get the same answer, the public line applies', async () => {
  const { raw, id, staff } = await asStaff(ASSISTANT);
  const text = await download(staff.app, id);
  const add = (t: string, lines: string[]) => t.replace(`=== end ${id} ===`, `${lines.join('\n')}\n=== end ${id} ===`);
  const optionAt = /^options\.(\d+)\.id=opt_std$/m.exec(text)![1];
  const right = add(edit(text, 'sku', 'X1-S'), ['product_cost_iqd=700000', `options.${optionAt}.cost_iqd=650000`, 'pricing.base.supplier_cost_amount=450']);
  const wrong = add(edit(text, 'sku', 'X1-S'), ['product_cost_iqd=1', `options.${optionAt}.cost_iqd=2`, 'pricing.base.supplier_cost_amount=3']);
  const [a] = await preview(staff.app, right, id);
  const [b] = await preview(staff.app, wrong, id);
  const shape = (p: typeof a) => p.fields.map((f) => [f.key, f.status, f.before, f.after, f.message ?? null]);
  assert.deepEqual(shape(a), shape(b), 'the same answer for a right and a wrong guess');
  const st = Object.fromEntries(a.fields.map((f) => [f.key, f.status]));
  assert.equal(st.product_cost_iqd, 'COST_OWNER_ONLY');
  assert.equal(st[`options.${optionAt}.cost_iqd`], 'COST_OWNER_ONLY');
  assert.equal(st['pricing.base.supplier_cost_amount'], 'COST_OWNER_ONLY');
  assert.equal(st.sku, 'change');
  for (const f of a.fields.filter((x) => x.status === 'COST_OWNER_ONLY')) {
    assert.equal(f.before, null);
    assert.equal(f.after, null);
  }
  const res = await apply(staff.app, wrong, b);
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.text();
  assert.doesNotMatch(body, /700000|650000/);
  const stored = row<{ product_cost_iqd: number; sku: string }>(raw, 'SELECT product_cost_iqd, sku FROM products WHERE id = ?', id)!;
  assert.equal(stored.product_cost_iqd, 700000, 'the stored cost never moves');
  assert.equal(stored.sku, 'X1-S');
  assert.equal(row<{ cost_iqd: number }>(raw, "SELECT cost_iqd FROM product_option_values WHERE id = 'opt_std'")!.cost_iqd, 650000);
  assert.equal(row(raw, 'SELECT 1 AS x FROM pricing_inputs WHERE product_id = ?', id), undefined);
});

test('the owner\'s file in a non-owner\'s hands: every cost line is refused by name, nothing else differs', async () => {
  const raw = freshDb();
  const owner = setup(OWNER, raw);
  const id = await create(owner.app, PRODUCT);
  const ownersFile = await download(owner.app, id);
  assert.match(ownersFile, /^product_cost_iqd=700000$/m);
  const staff = setup(ASSISTANT, raw);
  const [p] = await preview(staff.app, ownersFile, id);
  const refused = p.fields.filter((f) => f.status !== 'STALE_IN_FILE');
  assert.ok(refused.length > 0);
  assert.ok(refused.every((f) => f.status === 'COST_OWNER_ONLY' && f.private), JSON.stringify(refused));
  assert.equal(p.token, null);
  const text = JSON.stringify(p);
  assert.doesNotMatch(text, /700000|650000/, 'the preview never echoes a private value');
});

test('the names a comparison sends (row 207): a non-owner is never sent a pricing scope\'s name, the owner is', async () => {
  const raw = freshDb();
  const owner = setup(OWNER, raw);
  const id = await create(owner.app, PRODUCT);
  const ownersFile = await download(owner.app, id);
  const optionAt = /^options\.(\d+)\.id=opt_std$/m.exec(ownersFile)![1];
  const edited = edit(ownersFile, `options.${optionAt}.name_en`, 'Standard plus');
  // The owner's file — its pricing block included — in a non-owner's hands.
  const staff = setup(ASSISTANT, raw);
  const [p] = await preview(staff.app, edited, id);
  const labels = (p as unknown as { labels: { items: Record<string, unknown>; spec: Record<string, unknown> } }).labels;
  assert.ok(p.fields.some((f) => f.key.startsWith('pricing.') && f.status === 'COST_OWNER_ONLY'), 'the pricing lines are refused by name');
  assert.deepEqual(Object.keys(labels.items).filter((k) => k.startsWith('pricing.')), [], 'no pricing scope is named to staff');
  assert.ok(labels.items['options:opt_std'], 'the model a staff line belongs to is named');
  assert.doesNotMatch(JSON.stringify(labels), /700000|650000/);
});
