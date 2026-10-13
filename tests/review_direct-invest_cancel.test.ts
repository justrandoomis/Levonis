/**
 * REVIEW (direct-invest group, 14d08dd4), DI-4: once the owner voids an
 * unfunded contract, the pending return shown to the investor
 * (PENDING_SURPLUS_SQL) and to the owner (purchaseFundingSummary) still
 * subtracted the agreement's immutable allocated_iqd, while
 * receivePurchaseFunding gives a voided contract no cash, so the next receipt
 * returned everything. Fixed 2026-10-13: both read the live (non-void)
 * allocation.
 *
 * The group's DI-3 reproduction (cancelled funded purchase keeps the principal
 * in the contracts) was refuted: DECISIONS row 215 records that behaviour as
 * the owner's decision, so it is not carried here.
 *
 * Run: node --import tsx --test tests/review_direct-invest_cancel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, get, json, row } from './fixtures/app';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { participantOverview } from '../worker/lib/financeParticipants';
import { baghdadDay } from '../worker/lib/operations';

const AGREED = 13_000_000;
const OWNER = { id: 'owner', email: 'boss@x.co', role: 'admin', admin_scope: 'full' } as const;

test('after the owner voids the unfunded contract, the pending return the investor and owner are shown is what the next receipt returns', async () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES ('owner','boss@x.co','Owner','admin','full'),('investor','investor@x.co','Investor','admin','assistant');
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd,stock,inventory_mode) VALUES ('a1','Bambu Lab A1','surplus-a1',3100000,500000,0,'OPTION');
    INSERT INTO product_option_groups(id,product_id,name_en) VALUES('model','a1','Model');
    INSERT INTO product_option_values(id,product_id,group_id,name_en,stock) VALUES('combo','a1','model','Combo',0);`);
  const db = asD1(raw);
  const app = stubApp(db, OWNER, (a) => { a.route('/p', adminProcurementRoutes); a.route('/i', adminInvestmentFinanceRoutes); });
  assert.equal((await post(app, '/i/profiles', { user_id: 'investor', default_profit_share_bps: 3500, default_loss_share_bps: 0 })).status, 200);
  const saved = await post(app, '/p/documents', {
    operation_id: crypto.randomUUID(), currency: 'IQD', purchase_day: baghdadDay(), status: 'ordered', cost_state: 'final',
    lines: [{ product_id: 'a1', scope: 'option', scope_id: 'combo', qty_ordered: 5, purchase_cost_mode: 'total', source_total_amount: 12_353_822 }],
    charges: [{ title: 'شحن', amount_iqd: 500_000, basis: 'quantity' }],
    funding: { mode: 'investor', user_id: 'investor', agreed_iqd: AGREED, received_iqd: '', reference: 'INVESTOR-CASH', profit_share_bps: 3500, loss_share_bps: 0 },
  });
  assert.equal(saved.status, 200);
  const id = (await json(saved)).id as string;
  const contract = row<{ id: string }>(raw, 'SELECT contract_id AS id FROM purchase_investor_allocations WHERE purchase_id=?', id)!;
  const voided = await post(app, `/i/contracts/${contract.id}/void`, { operation_id: crypto.randomUUID() });
  assert.equal(voided.status, 200, JSON.stringify(await json(voided.clone())));

  const shownInvestor = (await participantOverview(db, 'investor')).investment.pending_surplus_iqd;
  const shownOwner = (await json(await get(app, `/p/documents/${id}`))).funding.return_total_iqd;
  const receipt = await post(app, `/p/documents/${id}/investor-receipts`, { operation_id: crypto.randomUUID(), amount_iqd: AGREED, reference: 'BANK', payment_day: baghdadDay() });
  assert.equal(receipt.status, 200);
  const returned = (await participantOverview(db, 'investor')).summary.capital_surplus_iqd;
  const facts = { shown_investor_pending: shownInvestor, shown_owner_return_total: shownOwner, actually_returned: returned };
  assert.equal(returned, AGREED, JSON.stringify(facts));
  assert.equal(shownInvestor, returned, JSON.stringify(facts));
  assert.equal(shownOwner, returned, JSON.stringify(facts));
});
