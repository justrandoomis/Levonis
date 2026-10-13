/**
 * LEAK VERIFY (money) — a lot count the OWNER is refused is POSTED when an
 * assistant sends it, moving stock, the inventory journal and (when some loss
 * is documented) the investor's capital.
 *
 * POST /api/admin/stock-operations/lot-counts on an investor-funded lot with a
 * loss share: a count that goes UP asks for an investor «loss_correction» of
 * trunc(-delta × unit cost × loss_share_bps / 10000). When that exceeds the
 * loss actually documented for the lot, 10c6541a refused EVERY counter
 * («لا توجد خسارة موثقة تكفي لتصحيح رأس مال المستثمر», 400) and wrote nothing.
 * DECISIONS row 219 (leak #26, the refusal was an oracle) keeps the refusal for
 * the owner only; any other counter now gets 200 — the count posts, the lot
 * and the product stock move, the 1200/5300 journal is written for the full
 * delta × cost, and the investor correction is silently capped at the
 * documented loss (`amount = -known`), with an id-only audit row.
 *
 * So for the SAME request on the SAME data the money outcome now depends on
 * who sends it, and the less-privileged caller can post what the owner cannot.
 * Expected (base): owner and assistant get the same outcome.
 *
 * FIXED (DECISIONS row 219, verification pass): an upward lot count is the
 * owner's to post — anyone else hears LOT_COUNT_UP_OWNER_ONLY for EVERY
 * upward count, decided before the lot's cost or funding is read, and
 * nothing is written; the owner keeps the investor-capital refusal. Same
 * status, same (empty) money outcome for both callers.
 *
 * LOCAL ONLY: throwaway copies of the role-matrix database, the real router.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { adminStockOperationsRoutes } from '../worker/routes/adminStockOperations';
import { count } from './fixtures/app';
import { COST } from './fixtures/costlyProduct';
import { OWNER, ROLES, appFor, call, seededCopy, type MountSpec, type Router } from './fixtures/roleMatrix';

const PREFIX = '/api/admin/stock-operations';
const MOUNTS: readonly MountSpec[] = [[PREFIX, adminStockOperationsRoutes as Router]];

/** A received purchase of 3, one left on the lot, funded by an investor who bears 100 % of losses. */
function world(): DatabaseSync {
  const raw = seededCopy();
  raw.exec(`
    INSERT INTO incoming_inventory (id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd,
                                    shipping_total_iqd,internal_delivery_total_iqd,status)
      VALUES ('inc_mv','p_a1','base','',3,3,${COST.incomingUnit},0,0,'received');
    INSERT INTO inventory_lots (id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,purchase_unit_iqd,
                                shipping_share_iqd,internal_share_iqd,total_cost_iqd,cost_basis,received_at,incoming_id)
      VALUES ('lot_mv','p_a1','base','',3,1,${COST.lotUnit},${COST.lotUnit},0,0,${COST.lotUnit * 3},
              'received','2026-08-01T09:00:00Z','inc_mv');
    INSERT INTO investment_contracts (id,incoming_id,user_id,name,principal_iqd,capital_share_bps,profit_share_bps,
                                      loss_share_bps,created_by,created_at,request_json)
      VALUES ('ic_mv','inc_mv','usr_inv','Money verify contract',1000000,10000,3500,10000,'usr_owner',
              '2026-09-01T00:00:00.000Z','{}');
  `);
  return raw;
}

/** One unit found on a shelf that said one (delta +1), and what it moved. */
async function countUp(user: NonNullable<(typeof ROLES)['assistant']>) {
  const raw = world();
  const stockBefore = count(raw, "SELECT stock n FROM products WHERE id='p_a1'");
  const res = await call(appFor(raw, user, MOUNTS), 'POST', `${PREFIX}/lot-counts`, {
    operation_id: 'money-verify-lot-count-01',
    lot_id: 'lot_mv',
    counted_qty: 2,
  });
  return {
    status: res.status,
    lot_qty_remaining: count(raw, "SELECT qty_remaining n FROM inventory_lots WHERE id='lot_mv'"),
    product_stock_delta: count(raw, "SELECT stock n FROM products WHERE id='p_a1'") - stockBefore,
    journal_debit_iqd: count(
      raw,
      "SELECT COALESCE(SUM(l.debit_iqd),0) n FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE e.source_type='lot-count'"
    ),
    investor_events: count(raw, "SELECT COUNT(*) n FROM investor_finance_events WHERE contract_id='ic_mv'"),
  };
}

test('the same upward lot count on an investor-funded lot has the same money outcome for the owner and an assistant', async () => {
  const owner = await countUp(OWNER);
  const assistant = await countUp(ROLES.assistant!);
  console.log(JSON.stringify({ owner, assistant }));
  // Positive control: the owner's refusal is the investor-capital rule itself.
  assert.equal(owner.status, 400, JSON.stringify(owner));
  assert.deepEqual(
    assistant,
    owner,
    `CHANGED MONEY OUTCOME: the owner is refused (${JSON.stringify(owner)}) but the assistant's identical count posts ` +
      `(${JSON.stringify(assistant)}): stock +${assistant.product_stock_delta}, journal ${assistant.journal_debit_iqd} IQD, ` +
      `investor correction capped`
  );
});
