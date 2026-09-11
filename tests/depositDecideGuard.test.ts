/**
 * The legacy POST /api/admin/wallet-requests/:id/decide delegates every
 * DEPOSIT decision to the one deposit service (walletOps.decideDeposit) — the
 * same function the guarded /api/wallet/admin/deposits/:id/approve|reject
 * routes and the Telegram buttons call. It used to approve with a bare UPDATE,
 * which bypassed the amount-mismatch refusal, the dedup-slot release on
 * rejection and the message close. The response shape stays the legacy one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { freshDb, asD1, stubApp, post, json, row, count, pending } from './fixtures/app';
import { adminRoutes } from '../worker/routes/admin';
import { walletRoutes } from '../worker/routes/wallet';

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('boss','Admin','boss@x.co','h','admin'), ('u1','User','u1@x.co','h','customer');
    -- Declared 100,000; finance observed 10,000 → parked as amount_mismatch.
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note,created_by)
      VALUES ('dep_bad','u1','deposit','USD',100000,'pending','bank transfer','user');
    INSERT INTO wallet_deposit_meta (tx_id,user_id,provider,channel,reference,reference_norm,declared_amount_cents,observed_amount_cents,review_state)
      VALUES ('dep_bad','u1','zaincash','app','REF-1','ref1',100000,10000,'amount_mismatch');
    -- A clean one, owning its transfer-reference slot.
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note,created_by)
      VALUES ('dep_ok','u1','deposit','USD',20000,'pending','bank transfer','user');
    INSERT INTO wallet_deposit_meta (tx_id,user_id,provider,channel,reference,reference_norm,declared_amount_cents,review_state)
      VALUES ('dep_ok','u1','zaincash','app','REF-2','ref2',20000,'awaiting_review');
    -- A withdrawal filed before the holds engine: no wallet_withdrawals row.
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note,created_by)
      VALUES ('legacy_wd','u1','withdrawal','USD',5000,'pending','old','user');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
      VALUES ('fund','u1','deposit','USD',50000,'approved','seed');
  `);
}

const build = (raw: DatabaseSync) =>
  stubApp(asD1(raw), { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => {
    a.route('/api/admin', adminRoutes);
    a.route('/api/wallet', walletRoutes);
  });
const legacy = (app: ReturnType<typeof build>, id: string, status: 'approved' | 'rejected', adminNote?: string) =>
  post(app, `/api/admin/wallet-requests/${id}/decide`, { status, ...(adminNote ? { adminNote } : {}) });
const txStatus = (raw: DatabaseSync, id: string) => row<{ status: string }>(raw, 'SELECT status FROM wallet_transactions WHERE id = ?', id)!.status;

test('the legacy route REFUSES an amount_mismatch deposit exactly as the guarded route does', async () => {
  const raw = freshDb();
  seed(raw);
  const app = build(raw);

  const guarded = await post(app, '/api/wallet/admin/deposits/dep_bad/approve', { adminNote: 'ok' });
  assert.equal(guarded.status, 409);

  const res = await legacy(app, 'dep_bad', 'approved');
  const out = await json(res);
  assert.equal(res.status, 409, JSON.stringify(out));
  assert.equal(out.code, 'AMOUNT_MISMATCH');
  assert.match(String(out.error), /observed amount does not match/i);
  assert.equal(txStatus(raw, 'dep_bad'), 'pending', 'nothing was credited');
  await Promise.allSettled(pending);
});

test('a clean deposit approved through the legacy route goes through the service: one credit, the service audit row, legacy response', async () => {
  const raw = freshDb();
  seed(raw);
  const app = build(raw);
  const res = await legacy(app, 'dep_ok', 'approved', 'verified');
  assert.deepEqual(await json(res), { success: true });
  assert.equal(txStatus(raw, 'dep_ok'), 'approved');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action='wallet.deposit.approved' AND target='dep_ok'"), 1, 'decideDeposit recorded the decision');
  // Deciding it again is refused by the route's own pending-only lookup (its
  // long-standing 404), and the ledger has exactly one approved credit.
  assert.equal((await legacy(app, 'dep_ok', 'approved')).status, 404);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE id='dep_ok' AND status='approved'"), 1);
  await Promise.allSettled(pending);
});

test('a deposit rejected through the legacy route needs a reason and frees its transfer-reference slot', async () => {
  const raw = freshDb();
  seed(raw);
  const app = build(raw);

  const noReason = await legacy(app, 'dep_ok', 'rejected');
  const out = await json(noReason);
  assert.equal(noReason.status, 400, JSON.stringify(out));
  assert.equal(out.code, 'REASON_REQUIRED');
  assert.equal(txStatus(raw, 'dep_ok'), 'pending');

  const res = await legacy(app, 'dep_ok', 'rejected', 'receipt does not match');
  assert.deepEqual(await json(res), { success: true });
  assert.equal(txStatus(raw, 'dep_ok'), 'rejected');
  assert.equal(
    row<{ dedup_active: number }>(raw, "SELECT dedup_active FROM wallet_deposit_meta WHERE tx_id='dep_ok'")!.dedup_active,
    0,
    'the (provider, channel, reference) slot is released for an honest correction'
  );
  await Promise.allSettled(pending);
});

test('a withdrawal filed before the holds engine is still decided the legacy way (nothing else can)', async () => {
  const raw = freshDb();
  seed(raw);
  const app = build(raw);
  assert.equal((await legacy(app, 'legacy_wd', 'approved')).status, 200);
  assert.equal(txStatus(raw, 'legacy_wd'), 'approved');
});

test('the admin UI decides deposits through the guarded routes and keeps the legacy call for pre-holds withdrawals only', () => {
  const overview = readFileSync(join(ROOT, 'src/components/AdminOverview.tsx'), 'utf8');
  const requests = readFileSync(join(ROOT, 'src/components/AdminWalletRequests.tsx'), 'utf8');
  for (const [name, src] of [['AdminOverview', overview], ['AdminWalletRequests', requests]] as const) {
    assert.match(src, /\/api\/wallet\/admin\/deposits\/\$\{/, `${name} decides deposits through the guarded routes`);
  }
  // AdminOverview: deposit rows go to the guarded base, the legacy decide is the non-deposit branch.
  assert.match(overview, /else if \(isDeposit\) \{[\s\S]{0,200}\/api\/wallet\/admin\/deposits\/\$\{req\.id\}[\s\S]{0,300}\} else \{\s*await api\.post\(`\/api\/admin\/wallet-requests\//,
    'AdminOverview: deposits are guarded, only other rows use the legacy decide');
  // AdminWalletRequests: deposit rows get deposit steps that call the guarded routes.
  assert.match(requests, /if \(t\.type === 'deposit'\) \{[\s\S]{0,300}kind: 'deposit'/, 'AdminWalletRequests: deposit rows get deposit steps');
  assert.match(requests, /\/api\/wallet\/admin\/deposits\/\$\{id\}\/approve/);
  assert.match(requests, /\/api\/wallet\/admin\/deposits\/\$\{id\}\/reject/);
});
