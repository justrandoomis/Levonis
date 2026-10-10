/**
 * THE PRICING STORE'S PACKED WRITES (docs/DECISIONS.md row 207): the data
 * file's apply writes new `pricing_inputs` and `pricing_rules` rows and its
 * `pricing_audit` rows as multi-row INSERTs — the SAME rows, the same values
 * bound in the same order, as one statement per row writes them; fewer
 * statements in the one batch D1 counts against its 1,000.
 *
 *   (a) packed and unpacked leave every row equal, column by column, and the
 *       same `inputs_seq` (the per-row triggers fire per row);
 *   (b) the statement counts are ⌈n/5⌉ (plain inputs), ⌈n/3⌉ (inputs with an
 *       IQD snapshot), ⌈n/7⌉ (rules) and ⌈n/8⌉ (audits);
 *   (c) every statement binds at most 90 parameters (D1: 100) on a binding
 *       that enforces D1's limits, with well under 100 KB of SQL;
 *   (d) a packed INSERT of a row that already exists aborts the whole batch
 *       (PRICING_INPUT_REINSERT), nothing written;
 *   (e) a packed batch keeps the IQD snapshot's freeze: an owner token in the
 *       batch lets a converted row change, none refuses it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1 } from './fixtures/app';
import { LimitD1 } from './fixtures/d1Limits';
import { pricingWorld, AMS } from './fixtures/procurementPricing';
import {
  PACKED_PARAMS_MAX,
  batchHead,
  batchTail,
  inputStatements,
  loadProductPricing,
  pricingAuditStatement,
  pricingAuditStatements,
  ruleStatements,
  type InputWrite,
  type PricingAuditRow,
  type RuleWrite,
  type StoredInputRow,
} from '../worker/lib/pricingEngine/store';

const NOW = '2026-10-10T10:00:00.000Z';
const ACTOR = 'usr_owner';

/** n new owner rows at distinct scopes; every third one converted from typed dinars. */
function newInputs(n: number, opts: { iqdEvery?: number } = {}): InputWrite[] {
  return Array.from({ length: n }, (_, i) => {
    const scope = i === 0 ? 'base' : i % 2 ? 'option' : 'sku';
    const scope_id = scope === 'base' ? '' : scope === 'option' ? `pk_opt_${i}` : `o:pk_opt_${i}|c:pk_col_${i}`;
    const iqd = opts.iqdEvery && i % opts.iqdEvery === 1;
    return {
      scope,
      scope_id,
      existing: null,
      set: {
        shipping_weight_g: 1000 + i,
        shipping_length_mm: 300,
        shipping_width_mm: 200,
        shipping_height_mm: 100 + i,
        manual_cbm: '0.006',
        additional_cost_iqd: 1000 * (i % 4),
        shipping_profile: 'CHINA_SEA',
        ...(iqd ? { supplier_cost_amount: '25', supplier_cost_currency: 'USD' as const } : {}),
      },
      source_ref: 'data_file',
      ...(iqd ? { iqd: { original_input_amount: '40000', conversion_rate_snapshot: '1600', conversion_fx_version: 1, converted_at: NOW } } : {}),
    } satisfies InputWrite;
  });
}

function newRules(n: number): RuleWrite[] {
  return Array.from({ length: n }, (_, i) => {
    const kind = i % 2 ? 'direct_sale_extra' : 'target_profit';
    const at = Math.floor(i / 2);
    const scope = at === 0 ? 'product' : 'option';
    return {
      kind,
      scope,
      scope_id: scope === 'product' ? '' : `pk_opt_${at}`,
      existing: null,
      new_id: `prule_pk_${i}`,
      next:
        kind === 'target_profit'
          ? { state: 'ACTIVE', amount_usd: String(10 + at), amount_iqd: null, source: 'OWNER', legacy_result_id: null }
          : { state: 'ACTIVE', amount_usd: null, amount_iqd: 1000 * (at + 1), source: 'OWNER', legacy_result_id: null },
    } satisfies RuleWrite;
  });
}

function auditRows(n: number): PricingAuditRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `paud_pk_${i}`,
    entity: i % 2 ? 'rule' : 'input',
    entity_key: `option:pk_opt_${i}`,
    product_id: AMS,
    action: i % 2 ? 'rule_set' : 'update',
    before: i % 3 ? null : { shipping_weight_g: i },
    after: { shipping_weight_g: 1000 + i, manual_cbm: '0.006' },
    summary: { source: 'data_file' },
    actor: ACTOR,
    now: NOW,
  }));
}

const rowsOf = (raw: DatabaseSync, sql: string) => raw.prepare(sql).all() as Array<Record<string, unknown>>;
const snapshot = (raw: DatabaseSync) => ({
  inputs: rowsOf(raw, `SELECT * FROM pricing_inputs WHERE product_id = '${AMS}' ORDER BY scope, scope_id, origin`),
  rules: rowsOf(raw, `SELECT * FROM pricing_rules WHERE product_id = '${AMS}' ORDER BY id`),
  audits: rowsOf(raw, `SELECT * FROM pricing_audit WHERE product_id = '${AMS}' ORDER BY id`),
  seq: rowsOf(raw, `SELECT inputs_seq, write_seq FROM product_pricing_state WHERE product_id = '${AMS}'`),
});

/** One owner write batch as the data file's apply builds it, packed or not. */
async function writeOnce(raw: DatabaseSync, inputs: InputWrite[], rules: RuleWrite[], audits: PricingAuditRow[], pack: boolean) {
  const db = new LimitD1(raw) as unknown as D1Database;
  const stored = await loadProductPricing(asD1(raw), AMS);
  const statements = [
    ...batchHead(db, stored, NOW),
    ...inputStatements(db, AMS, inputs, ACTOR, NOW, { pack }),
    ...ruleStatements(db, AMS, rules, ACTOR, NOW, { pack }),
    ...(pack ? pricingAuditStatements(db, audits) : audits.map((a) => pricingAuditStatement(db, a))),
    ...batchTail(db, AMS),
  ];
  await db.batch(statements);
  return statements.length;
}

test('(a) packed and one-statement-a-row writes leave the same rows and the same inputs_seq', async () => {
  const inputs = newInputs(61, { iqdEvery: 3 });
  const rules = newRules(60);
  const audits = auditRows(121);
  const plainWorld = pricingWorld();
  const packedWorld = pricingWorld();
  const unpacked = await writeOnce(plainWorld.raw, inputs, rules, audits, false);
  const packed = await writeOnce(packedWorld.raw, inputs, rules, audits, true);
  const a = snapshot(plainWorld.raw);
  const b = snapshot(packedWorld.raw);
  assert.equal(a.inputs.length, 61);
  assert.equal(a.rules.length, 60);
  assert.equal(a.audits.length, 121);
  assert.deepEqual(b.inputs, a.inputs, 'every pricing_inputs row equal, column by column');
  assert.deepEqual(b.rules, a.rules, 'every pricing_rules row equal');
  assert.deepEqual(b.audits, a.audits, 'every pricing_audit row equal');
  assert.deepEqual(b.seq, a.seq, 'inputs_seq moved by exactly as much');
  assert.equal(a.seq[0]?.inputs_seq, 121, 'one bump per input row and per product rule, as before');
  assert.ok(packed < unpacked / 4, `packed ${packed} statements, unpacked ${unpacked}`);
});

test('(a) an existing row stays a version-fenced UPDATE when packing', async () => {
  const w = pricingWorld();
  await writeOnce(w.raw, newInputs(3), [], [], true);
  const stored = await loadProductPricing(asD1(w.raw), AMS);
  const existing = stored.inputs.find((r) => r.scope === 'option') as StoredInputRow;
  const db = new LimitD1(w.raw) as unknown as D1Database;
  const update: InputWrite = { scope: 'option', scope_id: existing.scope_id, existing, set: { shipping_weight_g: 4321 }, source_ref: 'data_file' };
  const statements = inputStatements(db, AMS, [update, ...newInputs(1).map((x) => ({ ...x, scope: 'option' as const, scope_id: 'pk_new' }))], ACTOR, NOW, { pack: true });
  assert.equal(statements.length, 2);
  await db.batch([...batchHead(db, stored, NOW), ...statements, ...batchTail(db, AMS)]);
  const row = w.raw.prepare('SELECT shipping_weight_g, version FROM pricing_inputs WHERE product_id = ? AND scope_id = ?').get(AMS, existing.scope_id) as { shipping_weight_g: number; version: number };
  assert.deepEqual({ ...row }, { shipping_weight_g: 4321, version: 2 });
});

test('(b) the statement counts: ⌈n/5⌉ plain inputs, ⌈n/3⌉ converted inputs, ⌈n/7⌉ rules, ⌈n/8⌉ audits', () => {
  const w = pricingWorld();
  const db = new LimitD1(w.raw) as unknown as D1Database;
  for (const n of [0, 1, 5, 6, 61, 275]) {
    const plain = newInputs(n);
    assert.equal(inputStatements(db, AMS, plain, ACTOR, NOW, { pack: true }).length, Math.ceil(n / 5), `plain ${n}`);
    const converted = plain.map((x) => ({ ...x, set: { ...x.set, supplier_cost_amount: '25', supplier_cost_currency: 'USD' as const }, iqd: { original_input_amount: '40000', conversion_rate_snapshot: '1600', conversion_fx_version: 1, converted_at: NOW } }));
    assert.equal(inputStatements(db, AMS, converted, ACTOR, NOW, { pack: true }).length, Math.ceil(n / 3), `converted ${n}`);
    assert.equal(ruleStatements(db, AMS, newRules(n), ACTOR, NOW, { pack: true }).length, Math.ceil(n / 7), `rules ${n}`);
    assert.equal(pricingAuditStatements(db, auditRows(n)).length, Math.ceil(n / 8), `audits ${n}`);
    // Unpacked: one a row, as before (the form's doors, the repricer, the rate preview).
    assert.equal(inputStatements(db, AMS, plain, ACTOR, NOW).length, n);
    assert.equal(ruleStatements(db, AMS, newRules(n), ACTOR, NOW).length, n);
  }
});

test('(c) every packed statement binds ≤ 90 parameters and stays far under 100 KB of SQL, on a D1-limited binding', async () => {
  const w = pricingWorld();
  const seen: Array<{ params: number; sql: number }> = [];
  const db = new LimitD1(w.raw) as unknown as D1Database;
  const spy = {
    prepare(sql: string) {
      const inner = db.prepare(sql);
      return {
        bind(...values: unknown[]) {
          seen.push({ params: values.length, sql: Buffer.byteLength(sql) });
          return inner.bind(...values);
        },
      };
    },
  } as unknown as D1Database;
  const inputs = newInputs(275, { iqdEvery: 3 });
  inputStatements(spy, AMS, inputs, ACTOR, NOW, { pack: true });
  ruleStatements(spy, AMS, newRules(275), ACTOR, NOW, { pack: true });
  pricingAuditStatements(spy, auditRows(275));
  assert.ok(seen.length > 0);
  const maxParams = Math.max(...seen.map((x) => x.params));
  const maxSql = Math.max(...seen.map((x) => x.sql));
  assert.ok(maxParams <= PACKED_PARAMS_MAX, `max params ${maxParams}`);
  assert.ok(maxSql < 100_000, `max SQL ${maxSql} bytes`);
  assert.ok(maxSql < 4_000, `the packed SQL stays small (${maxSql} bytes)`);
  // And the real write runs on the limit-enforcing binding.
  await writeOnce(w.raw, newInputs(61, { iqdEvery: 3 }), newRules(60), auditRows(121), true);
});

test('(d) a packed INSERT of a row that already exists aborts the whole batch: nothing written', async () => {
  const w = pricingWorld();
  await writeOnce(w.raw, newInputs(4), [], [], true);
  const before = snapshot(w.raw);
  // The same four scopes again as NEW rows (a stale read), packed with two genuinely new ones.
  const again = [...newInputs(4), ...newInputs(6).slice(4).map((x, i) => ({ ...x, scope_id: `pk_fresh_${i}`, scope: 'option' as const }))];
  await assert.rejects(() => writeOnce(w.raw, again, newRules(3), auditRows(3), true), /PRICING_INPUT_REINSERT/);
  assert.deepEqual(snapshot(w.raw), before, 'the batch rolled back whole');
  assert.equal(w.raw.prepare("SELECT COUNT(*) AS n FROM ops_guards WHERE id LIKE 'pricing-input-owner:%'").get()!.n, 0);
});

test('(e) a packed batch keeps the IQD snapshot frozen without the owner token, and lets the owner change it', async () => {
  const w = pricingWorld();
  // A converted base row.
  await writeOnce(w.raw, newInputs(2, { iqdEvery: 2 }).slice(1).map((x) => ({ ...x, scope: 'base' as const, scope_id: '' })), [], [], true);
  const stored = await loadProductPricing(asD1(w.raw), AMS);
  const converted = stored.inputs.find((r) => r.scope === 'base')!;
  assert.equal(converted.supplier_input_mode, 'IQD_CONVERTED');
  const db = new LimitD1(w.raw) as unknown as D1Database;
  const change: InputWrite = { scope: 'base', scope_id: '', existing: converted, set: { supplier_cost_amount: '30', supplier_cost_currency: 'EUR' }, source_ref: 'data_file' };
  // Without the owner-input token (no batchHead/batchTail): the freeze refuses it.
  await assert.rejects(() => db.batch([...inputStatements(db, AMS, [change], ACTOR, NOW, { pack: true }), ...pricingAuditStatements(db, auditRows(2))]), /FX_SNAPSHOT_IMMUTABLE/);
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM pricing_audit WHERE product_id = ?').get(AMS)!.n, 0, 'nothing of the refused batch landed');
  // With it (the owner's batch): the row leaves the snapshot.
  const fresh = await loadProductPricing(asD1(w.raw), AMS);
  await db.batch([...batchHead(db, fresh, NOW), ...inputStatements(db, AMS, [change], ACTOR, NOW, { pack: true }), ...pricingAuditStatements(db, auditRows(2)), ...batchTail(db, AMS)]);
  const after = w.raw.prepare("SELECT supplier_input_mode, supplier_cost_currency, original_input_amount FROM pricing_inputs WHERE product_id = ? AND scope = 'base'").get(AMS) as Record<string, unknown>;
  assert.deepEqual({ ...after }, { supplier_input_mode: 'SOURCE_CURRENCY', supplier_cost_currency: 'EUR', original_input_amount: null });
});
