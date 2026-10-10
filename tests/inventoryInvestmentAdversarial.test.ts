import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, patch, get, json, all, count } from './fixtures/app';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { participantOverview } from '../worker/lib/financeParticipants';
import { baghdadDay } from '../worker/lib/operations';

const OWNER = { id: 'owner', email: 'boss@x.co', role: 'admin', admin_scope: 'full' } as const;
function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES ('owner','boss@x.co','Owner','admin','full'),('investor','investor@x.co','Investor','admin','assistant');
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd,stock,inventory_mode) VALUES ('part','Part','adversarial-part',50000,10000,0,'BASE');`);
  const db = asD1(raw);
  const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => { a.route('/p', adminProcurementRoutes); a.route('/i', adminInvestmentFinanceRoutes); };
  const app = stubApp(db, OWNER, mount);
  const payload = (received = 0) => ({ operation_id: crypto.randomUUID(), currency: 'IQD', purchase_day: baghdadDay(), status: 'ordered', cost_state: 'final',
    invoice_no: 'Original', lines: [{ product_id: 'part', scope: 'base', scope_id: '', qty_ordered: 1, source_unit_amount: 10000 }], charges: [],
    funding: { mode: 'investor', user_id: 'investor', agreed_iqd: 13000, received_iqd: received, reference: 'CASH', profit_share_bps: 3500, loss_share_bps: 0 } });
  async function create(body = payload()) {
    const r = await post(app, '/p/documents', body); const data = await json(r); assert.equal(r.status, 200, JSON.stringify(data)); return String(data.id);
  }
  function gateBatch(match: string, between: () => Promise<void>) {
    let hook: (() => Promise<void>) | null = between;
    const gated = new Proxy(db, { get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (hook && statements.some(s => (s as unknown as { sql: string }).sql.includes(match))) { const run = hook; hook = null; await run(); }
        return target.batch(statements);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    }});
    return stubApp(gated, OWNER, mount);
  }
  return { raw, db, app, payload, create, gateBatch };
}

test('a contract voided after a receipt reads it cannot consume the received capital', async () => {
  const x = setup();
  assert.equal((await post(x.app, '/i/profiles', { user_id: 'investor', default_profit_share_bps: 3500, default_loss_share_bps: 0 })).status, 200);
  const id = await x.create();
  const contract = all<{ id: string }>(x.raw, 'SELECT id FROM investment_contracts')[0];
  const app = x.gateBatch('INSERT INTO purchase_investor_receipts', async () => {
    const r = await post(x.app, `/i/contracts/${contract.id}/void`, { operation_id: 'void-racing-receipt' });
    assert.equal(r.status, 200, JSON.stringify(await json(r)));
  });
  const request = { operation_id: 'racing-void-receipt', amount_iqd: 13000, reference: 'BANK', payment_day: baghdadDay() };
  const raced = await post(app, `/p/documents/${id}/investor-receipts`, request);
  assert.equal(raced.status, 409, 'a stale allocation must abort atomically');
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM purchase_investor_receipts'), 0);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM investor_finance_events'), 0);
  assert.equal((await post(x.app, `/p/documents/${id}/investor-receipts`, request)).status, 200);
  assert.equal((await participantOverview(x.db, 'investor')).summary.capital_available_iqd, 13000, 'retry returns every dinar when the contract has been voided');
});

test('simultaneous identical purchase confirms return already without a second credit or server error', async () => {
  const x = setup();
  assert.equal((await post(x.app, '/i/profiles', { user_id: 'investor', default_profit_share_bps: 3500, default_loss_share_bps: 0 })).status, 200);
  const body = x.payload(13000);
  const app = x.gateBatch('INSERT INTO purchase_orders', async () => { await x.create(body); });
  const raced = await post(app, '/p/documents', body);
  const data = await json(raced);
  assert.equal(raced.status, 200, JSON.stringify(data));
  assert.equal(data.already, true);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM purchase_orders'), 1);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM purchase_investor_receipts'), 1);
  assert.equal((await participantOverview(x.db, 'investor')).summary.capital_available_iqd, 3000);
});

test('a name saved with repeated whitespace can be renamed from the displayed current name', async () => {
  const x = setup();
  const body = { ...x.payload(), funding: { mode: 'store' } };
  const result = await post(x.app, '/p/documents', body);
  assert.equal(result.status, 200, JSON.stringify(await json(result.clone())));
  // Names entered before this feature were not whitespace-normalized.
  x.raw.prepare('UPDATE purchase_orders SET invoice_no=? WHERE id=?').run('Germany   October', body.operation_id);
  const current = await json(await get(x.app, `/p/documents/${body.operation_id}`));
  const renamed = await patch(x.app, `/p/documents/${body.operation_id}/name`, { name: 'Germany November', before: current.purchase.invoice_no });
  assert.equal(renamed.status, 200, JSON.stringify(await json(renamed)));
});
