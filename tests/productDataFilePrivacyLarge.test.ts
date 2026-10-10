/**
 * «تحديث البيانات» — A LARGE FILE'S PRIVATE VALUES STAY IN pricing_audit
 * (docs/DECISIONS.md row 207; written by the privacy verifier of 317e878d, for
 * the two-part split that is gone now).
 *
 * The owner's large file carries DISTINCTIVE private values: an additional
 * cost on every pricing scope and a legacy model cost in the product lines.
 * It is too large for one batch, so it is refused whole (DATA_FILE_TOO_LARGE)
 * and applied the way the refusal says: the file without its pricing lines,
 * then the original file — two comparisons, two atomic applies. Then:
 *
 *   - no refusal body, apply answer or console line of the flow carries one;
 *   - no audit_log row of ANY action carries one (values live in pricing_audit);
 *   - pricing_audit holds them, one row per input scope;
 *   - the same file in a staff user's hands: no value, no pricing scope named,
 *     every private line refused as the owner's alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, post } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import type { PreviewProduct } from './fixtures/dataFile';
import { RULES2, SHIPPING5, bigProductText, coldApp, fillPricing, scopePrefixes, setLines } from './fixtures/dataFileLarge';
import { loadProducts } from '../worker/lib/pricingEngine/load';
import { formScopeIds } from '../worker/lib/pricingEngine/productInputs';

const ASSISTANT = { id: 'usr_asst', role: 'admin' as const, email: 'asst@x.co', admin_scope: 'assistant' as string | null };
const EXTRA_COST = '73919';
const MODEL_COST = '86421';
const SECRET = new RegExp(`${EXTRA_COST}|${MODEL_COST}`);

async function world(): Promise<{ raw: DatabaseSync; id: string; text: string }> {
  const w = pricingWorld();
  const cols = Array.from({ length: 10 }, (_, i) => `c${i}`);
  const res = await post(coldApp(w.raw).app, '/api/admin/template/apply', { text: bigProductText({ opts: 24, cols, slug: 'priv-kit' }), mode: 'draft', confirm: true });
  const body = (await res.json()) as { product_id?: string };
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 400));
  const id = body.product_id!;
  const loaded = (await loadProducts(asD1(w.raw), [id])).get(id)!;
  const skus = [...(formScopeIds(loaded).sku ?? [])].sort();
  const ins = w.raw.prepare(
    "INSERT INTO pricing_inputs (product_id, scope, scope_id, origin, shipping_weight_g, unresolved_fields, source_ref, version, updated_by, updated_at) VALUES (?, 'sku', ?, 'MANUAL_OVERRIDE', 900, '[]', 'seed', 1, 'usr_owner', '2026-10-10T08:00:00.000Z')"
  );
  for (const k of skus) ins.run(id, k);
  const text = await (await get(coldApp(w.raw).app, `/api/admin/template/data-export/${id}`)).text();
  return { raw: w.raw, id, text };
}

/** Every console line written while `fn` runs. */
async function capturingConsole<T>(fn: () => Promise<T>): Promise<{ out: T; lines: string[] }> {
  const lines: string[] = [];
  const names = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const saved = names.map((n) => console[n]);
  for (const n of names) {
    console[n] = (...args: unknown[]) => {
      lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
  }
  try {
    return { out: await fn(), lines };
  } finally {
    names.forEach((n, i) => (console[n] = saved[i] as never));
  }
}

const previewOf = async (raw: DatabaseSync, text: string, id: string, user?: typeof ASSISTANT) => {
  const res = await post(coldApp(raw, user).app, '/api/admin/template/data-preview', { text, product_ids: [id] });
  const body = (await res.json()) as { products: Array<PreviewProduct & { labels?: { items: Record<string, unknown> } }> };
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 400));
  return { p: body.products[0], raw: JSON.stringify(body) };
};
const applyOf = async (raw: DatabaseSync, body: Record<string, unknown>, user?: typeof ASSISTANT) => {
  const res = await post(coldApp(raw, user).app, '/api/admin/template/data-apply', body);
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as { code?: string; not_persisted?: string[] } };
};
const dropLines = (text: string, drop: (key: string) => boolean) =>
  text
    .split('\n')
    .filter((l) => {
      const eq = l.indexOf('=');
      return eq < 0 || !drop(l.slice(0, eq));
    })
    .join('\n');
const hashOf = (p: PreviewProduct) => ({
  ...(p.pricing?.preview_hash ? { pricing_hash: p.pricing.preview_hash } : {}),
  ...(p.pricing?.large_change ? { confirm_large_change: true } : {}),
});

test('a large file applied as its refusal says carries no private value outside pricing_audit: refusal, answers, console, every audit_log row; staff sees none', async () => {
  const w = await world();
  const modelCost = /^options\.(\d+)\.cost_iqd=/m.exec(w.text);
  assert.ok(modelCost, 'the owner file has a model cost line');
  const edits = new Map<string, string>([
    ...fillPricing(w.text, (i) => [...SHIPPING5(i), ['additional_cost_iqd', EXTRA_COST]]),
    ...fillPricing(w.text, RULES2),
    ['options.1.name_en', 'Model 1 (renamed)'],
    [`options.${modelCost[1]}.cost_iqd`, MODEL_COST],
  ]);
  const text = setLines(w.text, edits);
  assert.equal(scopePrefixes(w.text).length, 275);

  // ---- the same file in a staff user's hands (before the owner writes anything)
  const staff = await previewOf(w.raw, text, w.id, ASSISTANT);
  assert.doesNotMatch(staff.raw, SECRET, 'a staff comparison never echoes a private value');
  assert.equal(staff.p.pricing, null);
  assert.deepEqual(Object.keys(staff.p.labels?.items ?? {}).filter((k) => k.startsWith('pricing.')), []);
  assert.ok(staff.p.fields.filter((f) => f.key.startsWith('pricing.') || f.key.endsWith('.cost_iqd')).every((f) => f.status === 'COST_OWNER_ONLY'));

  // ---- the owner's file: refused whole, then applied as the refusal says — console captured end to end
  const auditBefore = (w.raw.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
  const { out, lines } = await capturingConsole(async () => {
    const first = await previewOf(w.raw, text, w.id);
    assert.equal(first.p.counts.refused, 0, JSON.stringify(first.p.fields.filter((f) => f.status !== 'change').slice(0, 3)));
    assert.equal(first.p.pricing?.kind, 'data');
    const refused = await applyOf(w.raw, { text, product_id: w.id, token: first.p.token, ...hashOf(first.p) });
    assert.equal(refused.status, 409, refused.text.slice(0, 300));
    assert.equal(refused.json.code, 'DATA_FILE_TOO_LARGE');
    // «delete the pricing lines, attach it and apply it …»
    const noPricing = dropLines(text, (k) => k.startsWith('pricing.'));
    const p1 = await previewOf(w.raw, noPricing, w.id);
    const r1 = await applyOf(w.raw, { text: noPricing, product_id: w.id, token: p1.p.token, ...hashOf(p1.p) });
    assert.equal(r1.status, 200, r1.text.slice(0, 300));
    // «… then attach the original file again»
    const p2 = await previewOf(w.raw, text, w.id);
    assert.equal(p2.p.pricing?.kind, 'data');
    const r2 = await applyOf(w.raw, { text, product_id: w.id, token: p2.p.token, ...hashOf(p2.p) });
    assert.equal(r2.status, 200, r2.text.slice(0, 300));
    assert.deepEqual(r2.json.not_persisted, []);
    return { refused, r1, r2 };
  });
  assert.doesNotMatch(out.refused.text, SECRET, 'the refusal carries counts only');
  assert.doesNotMatch(out.refused.text, /"token"/, 'and no token');
  assert.doesNotMatch(out.r1.text, SECRET, 'the first apply answers with keys only');
  assert.doesNotMatch(out.r2.text, SECRET, 'the second apply answers with keys only');
  const leaked = lines.filter((l) => SECRET.test(l));
  assert.deepEqual(leaked, [], 'no console line of the flow carries a private value');

  // ---- audit_log: every row the flow wrote, whatever its action — never a value
  const rows = w.raw.prepare('SELECT action, detail FROM audit_log ORDER BY rowid').all() as Array<{ action: string; detail: string | null }>;
  const written = rows.slice(auditBefore);
  assert.ok(written.some((r) => r.action === 'product.data_file.applied'));
  const withValue = written.filter((r) => SECRET.test(r.detail ?? '')).map((r) => r.action);
  assert.deepEqual(withValue, [], 'no audit_log row holds a private value');

  // ---- the values did land where they belong (owner-only tables)
  const exported = await (await get(coldApp(w.raw).app, `/api/admin/template/data-export/${w.id}`)).text();
  assert.match(exported, new RegExp(`^options\\.${modelCost[1]}\\.cost_iqd=${MODEL_COST}$`, 'm'));
  const audits = w.raw
    .prepare("SELECT COUNT(*) AS n FROM pricing_audit WHERE product_id = ? AND entity = 'input' AND json_extract(pricing_after_json, '$.additional_cost_iqd') = ?")
    .get(w.id, Number(EXTRA_COST)) as { n: number };
  const auditsText = w.raw
    .prepare("SELECT COUNT(*) AS n FROM pricing_audit WHERE product_id = ? AND entity = 'input' AND pricing_after_json LIKE ?")
    .get(w.id, `%${EXTRA_COST}%`) as { n: number };
  assert.equal(Math.max(audits.n, auditsText.n), 275, 'one pricing_audit input row per scope holds the value');
});
