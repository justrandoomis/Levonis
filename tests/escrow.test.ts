/**
 * Escrow, tested the way money has to be tested: by trying to break it.
 *
 * Every test here is an attack on the invariant rather than a demonstration
 * that the happy path works. The happy path is one test; the rest are double
 * releases, double refunds, retries that must not pay twice, refunds larger
 * than the escrow, and settlement after settlement.
 *
 * These run against a real SQLite engine through the D1 adapter, so the
 * conditional UPDATEs, the UNIQUE idempotency keys and the CHECK constraints
 * all actually execute. What it cannot reproduce is D1's own concurrency on
 * Cloudflare storage; races are simulated by interleaving in one process,
 * which does exercise the guards because they are written as conditional SQL
 * rather than as read-then-write in JavaScript.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1 } from './fixtures/d1';
import {
  holdEscrow,
  releaseEscrow,
  refundEscrow,
  disputeEscrow,
  getEscrow,
  merchantBalance,
} from '../worker/lib/escrowOps';
import { createDepositRequest, readWalletDust, walletIqdAvailable, availableUsdSql } from '../worker/lib/walletOps';

const RATE = 1400;

function setup(balanceIqd = 1_000_000) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES
      ('buyer','Sara','s@x.co','h'), ('owner','Ali','a@x.co','h'), ('boss','Admin','ad@x.co','h');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name)
      VALUES ('s1','m1','owner','ali3d','Ali 3D');
    INSERT INTO community_requests (id,customer_id,title) VALUES ('r1','buyer','Print');
    INSERT INTO community_offers (id,request_id,merchant_id,price_iqd) VALUES ('o1','r1','m1',50000);
    INSERT INTO community_orders
      (id,request_id,offer_id,customer_id,merchant_id,price_iqd,platform_fee_iqd,merchant_receivable_iqd)
      VALUES ('co1','r1','o1','buyer','m1',50000,5000,45000);
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
  `);
  // Fund the customer's wallet with an approved deposit, the way a real
  // balance arises — not by writing a balance column, because there isn't one.
  // A zero balance is no funding row at all: `CHECK (amount > 0)`.
  const cents = Math.ceil((balanceIqd * 100) / RATE);
  if (cents > 0) {
    raw.exec(
      `INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
       VALUES ('wt1','buyer','deposit','USD',${cents},'approved','test funding')`
    );
  }
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

const hold = (db: D1Database, key = 'k1') =>
  holdEscrow(db, {
    communityOrderId: 'co1',
    customerId: 'buyer',
    merchantId: 'm1',
    grossIqd: 50_000,
    platformFeeIqd: 5_000,
    merchantReceivableIqd: 45_000,
    idempotencyKey: key,
  });

// ------------------------------------------------------------- the happy path

test('accepting an offer holds the money without spending it', async () => {
  const { db } = setup();
  const r = await hold(db);
  assert.equal(r.ok, true);

  const esc = (await getEscrow(db, (r as { escrowId: string }).escrowId))!;
  assert.equal(esc.state, 'held');
  assert.equal(esc.gross_iqd, 50_000);
  assert.equal(esc.platform_fee_iqd + esc.merchant_receivable_iqd, esc.gross_iqd);
  assert.ok(esc.hold_id, 'no wallet hold was taken — the money is still spendable');

  // Nothing is owed to the merchant yet. They have not done the work.
  assert.deepEqual(await merchantBalance(db, 'm1'), { available_iqd: 0, pending_iqd: 0, paid_iqd: 0 });
});

test('confirming delivery pays the merchant exactly once, net of commission', async () => {
  const { db } = setup();
  const h = await hold(db);
  const escrowId = (h as { escrowId: string }).escrowId;

  const rel = await releaseEscrow(db, {
    escrowId, actorId: 'buyer', actorRole: 'customer', idempotencyKey: 'rel1',
  });
  assert.equal(rel.ok, true);

  const bal = await merchantBalance(db, 'm1');
  assert.equal(bal.available_iqd, 45_000, 'the merchant should be owed the receivable');
  // `paid` counts PAYOUTS only (audit 02 B20): the commission is Levonis's,
  // never money paid out to the merchant — but it is still its own row.
  assert.equal(bal.paid_iqd, 0, 'no payout has been made');
  const fee = (await db.prepare("SELECT COALESCE(SUM(amount_iqd), 0) AS n FROM merchant_ledger_entries WHERE merchant_id = 'm1' AND kind = 'commission'").first<{ n: number }>())!.n;
  assert.equal(fee, -5_000, 'the commission is recorded as its own ledger row');
  // Ledger rows sum to the gross: nothing appeared or vanished.
  assert.equal(bal.available_iqd + -fee, 50_000);

  const esc = (await getEscrow(db, escrowId))!;
  assert.equal(esc.state, 'released');
  assert.equal(esc.released_iqd, 50_000);
});

// ----------------------------------------------------------------- attacks

test('a retried acceptance does not reserve the money twice', async () => {
  const { db, raw } = setup();
  const a = await hold(db, 'same-key');
  const b = await hold(db, 'same-key');
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal((b as { replayed: boolean }).replayed, true, 'the retry was treated as a new acceptance');
  assert.equal((a as { escrowId: string }).escrowId, (b as { escrowId: string }).escrowId);

  const holds = raw.prepare("SELECT COUNT(*) c FROM wallet_holds WHERE user_id='buyer'").get() as { c: number };
  assert.equal(holds.c, 1, 'a second wallet hold was taken for the same acceptance');
});

test('a double release pays once, not twice', async () => {
  const { db } = setup();
  const escrowId = (await hold(db) as { escrowId: string }).escrowId;

  const first = await releaseEscrow(db, { escrowId, actorId: 'buyer', actorRole: 'customer', idempotencyKey: 'r1' });
  const second = await releaseEscrow(db, { escrowId, actorId: 'buyer', actorRole: 'customer', idempotencyKey: 'r1' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal((second as { replayed: boolean }).replayed, true);
  assert.equal((await merchantBalance(db, 'm1')).available_iqd, 45_000, 'the merchant was paid twice');
});

test('a second release under a DIFFERENT key still cannot pay twice', async () => {
  // The dangerous case: a client that retries with a fresh key. Idempotency
  // cannot help, so the state guard has to.
  const { db } = setup();
  const escrowId = (await hold(db) as { escrowId: string }).escrowId;

  await releaseEscrow(db, { escrowId, actorId: 'buyer', actorRole: 'customer', idempotencyKey: 'r1' });
  const again = await releaseEscrow(db, { escrowId, actorId: 'buyer', actorRole: 'customer', idempotencyKey: 'r2' });
  assert.equal(again.ok, true);
  assert.equal((again as { replayed: boolean }).replayed, true, 'a released escrow must report as already settled');
  assert.equal((await merchantBalance(db, 'm1')).available_iqd, 45_000);
});

test('a released escrow can never go back to held', async () => {
  const { db } = setup();
  const escrowId = (await hold(db) as { escrowId: string }).escrowId;
  await releaseEscrow(db, { escrowId, actorId: 'buyer', actorRole: 'customer', idempotencyKey: 'r1' });

  const disputed = await disputeEscrow(db, { escrowId, actorId: 'buyer', actorRole: 'customer', idempotencyKey: 'd1' });
  assert.equal(disputed.ok, false);
  assert.equal((disputed as { reason: string }).reason, 'STATE_CONFLICT');
  assert.equal((await getEscrow(db, escrowId))!.state, 'released');
});

test('money cannot be refunded after it has been released', async () => {
  const { db } = setup();
  const escrowId = (await hold(db) as { escrowId: string }).escrowId;
  await releaseEscrow(db, { escrowId, actorId: 'buyer', actorRole: 'customer', idempotencyKey: 'r1' });

  const refund = await refundEscrow(db, { escrowId, actorId: 'boss', actorRole: 'admin', idempotencyKey: 'rf1' });
  assert.equal(refund.ok, false, 'the platform paid the customer money it had already paid the merchant');
  assert.equal((refund as { reason: string }).reason, 'STATE_CONFLICT');
});

test('a refund larger than the escrow is refused', async () => {
  const { db } = setup();
  const escrowId = (await hold(db) as { escrowId: string }).escrowId;
  const r = await refundEscrow(db, {
    escrowId, actorId: 'boss', actorRole: 'admin', amountIqd: 60_000, idempotencyKey: 'rf1',
  });
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'AMOUNT_EXCEEDS_HELD');
});

test('a double refund returns the money once', async () => {
  const { db } = setup();
  const escrowId = (await hold(db) as { escrowId: string }).escrowId;

  await refundEscrow(db, { escrowId, actorId: 'boss', actorRole: 'admin', idempotencyKey: 'rf1' });
  const second = await refundEscrow(db, { escrowId, actorId: 'boss', actorRole: 'admin', idempotencyKey: 'rf1' });
  assert.equal((second as { replayed: boolean }).replayed, true);

  const esc = (await getEscrow(db, escrowId))!;
  assert.equal(esc.state, 'refunded');
  assert.equal(esc.refunded_iqd, 50_000, 'the refund was applied twice');
});

test('a full refund gives the money back and pays the merchant nothing', async () => {
  const { db, raw } = setup();
  const escrowId = (await hold(db) as { escrowId: string }).escrowId;
  await refundEscrow(db, { escrowId, actorId: 'boss', actorRole: 'admin', idempotencyKey: 'rf1' });

  assert.deepEqual(await merchantBalance(db, 'm1'), { available_iqd: 0, pending_iqd: 0, paid_iqd: 0 });
  // The hold is released rather than committed: nothing was ever spent, so
  // the balance simply becomes available again.
  const h = raw.prepare("SELECT state FROM wallet_holds WHERE user_id='buyer'").get() as { state: string };
  assert.equal(h.state, 'released');
});

test('a partial refund splits correctly and leaves both movements visible', async () => {
  const { db, raw } = setup();
  const escrowId = (await hold(db) as { escrowId: string }).escrowId;

  await refundEscrow(db, {
    escrowId, actorId: 'boss', actorRole: 'admin', amountIqd: 20_000, idempotencyKey: 'rf1',
    reason: 'partially delivered',
  });

  const esc = (await getEscrow(db, escrowId))!;
  assert.equal(esc.state, 'partially_refunded');
  assert.equal(esc.refunded_iqd, 20_000);

  // The merchant keeps their share of what was NOT refunded.
  assert.equal((await merchantBalance(db, 'm1')).available_iqd, 30_000);

  // The hold is committed and the refunded part comes back as its own credit,
  // so an auditor sees two movements rather than a quietly shrunk hold.
  const h = raw.prepare("SELECT state FROM wallet_holds WHERE user_id='buyer'").get() as { state: string };
  assert.equal(h.state, 'committed');
  const credits = raw
    .prepare("SELECT COUNT(*) c FROM wallet_transactions WHERE user_id='buyer' AND note LIKE '%partial refund%'")
    .get() as { c: number };
  assert.equal(credits.c, 1);
});

test('a customer without the balance cannot accept the offer, and nothing is written', async () => {
  const { db, raw } = setup(1_000); // far less than the 50,000 offer
  const r = await hold(db);
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'INSUFFICIENT_FUNDS');

  // No half-funded escrow left behind for someone to find later.
  const n = raw.prepare('SELECT COUNT(*) c FROM community_escrows').get() as { c: number };
  assert.equal(n.c, 0);
});

test('one balance cannot fund two acceptances', async () => {
  // The reason a hold is used rather than a flag: 60,000 IQD cannot cover two
  // 50,000 offers, and the availability check lives inside the INSERT.
  const { raw, db } = setup(60_000);
  raw.exec(`
    INSERT INTO community_requests (id,customer_id,title) VALUES ('r2','buyer','Another print');
    INSERT INTO community_offers (id,request_id,merchant_id,price_iqd) VALUES ('o2','r2','m1',50000);
    INSERT INTO community_orders
      (id,request_id,offer_id,customer_id,merchant_id,price_iqd,platform_fee_iqd,merchant_receivable_iqd)
      VALUES ('co2','r2','o2','buyer','m1',50000,5000,45000);
  `);

  const first = await hold(db, 'a');
  const second = await holdEscrow(db, {
    communityOrderId: 'co2', customerId: 'buyer', merchantId: 'm1',
    grossIqd: 50_000, platformFeeIqd: 5_000, merchantReceivableIqd: 45_000, idempotencyKey: 'b',
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false, 'the same balance funded two escrows');
  assert.equal((second as { reason: string }).reason, 'INSUFFICIENT_FUNDS');
});

test('an escrow whose parts do not sum is refused before it reaches the database', async () => {
  const { db } = setup();
  const r = await holdEscrow(db, {
    communityOrderId: 'co1', customerId: 'buyer', merchantId: 'm1',
    grossIqd: 50_000, platformFeeIqd: 5_000, merchantReceivableIqd: 44_000, idempotencyKey: 'x',
  });
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'INVALID_AMOUNT');
});

// ---------------------------------------------------------------- disputes

test('a dispute freezes settlement in both directions until an admin decides', async () => {
  const { db } = setup();
  const escrowId = (await hold(db) as { escrowId: string }).escrowId;

  const d = await disputeEscrow(db, {
    escrowId, actorId: 'buyer', actorRole: 'customer', reason: 'not as described', idempotencyKey: 'd1',
  });
  assert.equal(d.ok, true);
  assert.equal((await getEscrow(db, escrowId))!.state, 'disputed');

  // An admin can still settle it either way — that is the resolution.
  const rel = await releaseEscrow(db, { escrowId, actorId: 'boss', actorRole: 'admin', idempotencyKey: 'r1' });
  assert.equal(rel.ok, true, 'an admin must be able to resolve a dispute in the merchant’s favour');
  assert.equal((await merchantBalance(db, 'm1')).available_iqd, 45_000);
});

test('a disputed escrow can be resolved as a refund instead', async () => {
  const { db } = setup();
  const escrowId = (await hold(db) as { escrowId: string }).escrowId;
  await disputeEscrow(db, { escrowId, actorId: 'buyer', actorRole: 'customer', idempotencyKey: 'd1' });

  const r = await refundEscrow(db, { escrowId, actorId: 'boss', actorRole: 'admin', idempotencyKey: 'rf1' });
  assert.equal(r.ok, true);
  assert.equal((await getEscrow(db, escrowId))!.state, 'refunded');
  assert.equal((await merchantBalance(db, 'm1')).available_iqd, 0);
});

// -------------------------------------------------------------- the record

test('every movement leaves an append-only event, and history is never rewritten', async () => {
  const { db, raw } = setup();
  const escrowId = (await hold(db) as { escrowId: string }).escrowId;
  await disputeEscrow(db, { escrowId, actorId: 'buyer', actorRole: 'customer', idempotencyKey: 'd1' });
  await releaseEscrow(db, { escrowId, actorId: 'boss', actorRole: 'admin', idempotencyKey: 'r1' });

  const events = raw
    .prepare('SELECT kind, amount_iqd, actor_role FROM community_escrow_events WHERE escrow_id = ? ORDER BY created_at, id')
    .all(escrowId) as Array<{ kind: string; amount_iqd: number; actor_role: string }>;

  assert.deepEqual(
    events.map((e) => e.kind).sort(),
    ['dispute_open', 'held', 'release'],
    'the settlement cannot be reconstructed from the event log alone'
  );
  const release = events.find((e) => e.kind === 'release')!;
  assert.equal(release.amount_iqd, 45_000);
  assert.equal(release.actor_role, 'admin', 'who decided is part of the record');
});

/**
 * «الدينار هو الأساس» ON THE COMMUNITY BOARD.
 *
 * The hold used to be `iqdToUsdCents(gross)` — a CEIL: a 50,000 د.ع offer
 * asked for 3,572 cents, and a customer whose wallet read exactly 50,000 د.ع
 * (a typed 50,000 deposit: 3,571 cents plus its six-dinar remainder, 0108)
 * was told «Your wallet balance does not cover this offer». The hold now asks
 * the dinar question and reserves `walletSpendCents` — floored, capped at the
 * cents on hand — exactly as a checkout does, and the settlement debit records
 * the dinars it spent, so the wallet then reads 0, not 6.
 */
function setupTyped(typedIqd: number) {
  const { raw, db } = setup(0);
  raw.exec("DELETE FROM wallet_transactions WHERE id = 'wt1'");
  return { raw, db, typedIqd };
}

async function depositTyped(db: D1Database, raw: DatabaseSync, typedIqd: number, ref: string) {
  const cents = Math.floor((typedIqd * 100) / RATE); // the browser's own floor
  const res = await createDepositRequest(db, {
    userId: 'buyer',
    amountCents: cents,
    receiptKey: 'receipts/buyer/x.png',
    provider: 'zaincash',
    channel: 'app',
    reference: ref,
    declaredAmountIqd: typedIqd,
    exchangeRateSnapshot: RATE,
    txId: `wtx_${ref}`,
  });
  assert.equal(res.ok, true);
  raw.prepare("UPDATE wallet_transactions SET status = 'approved' WHERE id = ?").run(`wtx_${ref}`);
}

const dinarBalance = async (db: D1Database, raw: DatabaseSync) => {
  const cents = Number((raw.prepare(`SELECT ${availableUsdSql('?1')} AS c`).get('buyer') as { c: number }).c);
  return walletIqdAvailable(cents, (await readWalletDust(db, 'buyer')).dust_iqd, RATE);
};

test('a wallet that reads 50,000 د.ع accepts a 50,000 د.ع offer, and then reads zero', async () => {
  const { raw, db } = setupTyped(50_000);
  await depositTyped(db, raw, 50_000, 'T1');
  assert.equal(await dinarBalance(db, raw), 50_000, 'the balance the customer sees');

  const r = await hold(db);
  assert.equal(r.ok, true, `refused a wallet showing exactly the offer: ${JSON.stringify(r)}`);
  const esc = (await getEscrow(db, (r as { escrowId: string }).escrowId))!;
  const heldCents = (raw.prepare('SELECT amount_cents FROM wallet_holds WHERE id = ?').get(esc.hold_id) as { amount_cents: number })
    .amount_cents;
  assert.equal(heldCents, 3571, 'floored and capped at the cents on hand — never the 3,572 the ceil asked for');
  assert.equal(await dinarBalance(db, raw), 0, 'the hold takes the whole balance while it stands');

  const rel = await releaseEscrow(db, { escrowId: esc.id, actorId: 'buyer', actorRole: 'customer', idempotencyKey: 'rel-t1' });
  assert.equal(rel.ok, true);
  const debit = raw
    .prepare("SELECT amount, amount_iqd, exchange_rate_snapshot FROM wallet_transactions WHERE type = 'withdrawal' AND user_id = 'buyer'")
    .get() as { amount: number; amount_iqd: number; exchange_rate_snapshot: number };
  assert.deepEqual({ ...debit }, { amount: 3571, amount_iqd: 50_000, exchange_rate_snapshot: RATE }, 'the debit records the dinars it spent');
  assert.equal((await readWalletDust(db, 'buyer')).dust_iqd, 0, 'the deposit remainder is cancelled by the debit that spent it');
  assert.equal((await merchantBalance(db, 'm1')).available_iqd, 45_000, 'the merchant is paid in dinars, untouched by the cents');
});

test('two 25,000 deposits (3,570 cents) still cover a 50,000 offer — the hold is capped at the cents on hand', async () => {
  const { raw, db } = setupTyped(0);
  await depositTyped(db, raw, 25_000, 'T2a');
  await depositTyped(db, raw, 25_000, 'T2b');
  assert.equal(await dinarBalance(db, raw), 50_000);
  const r = await hold(db);
  assert.equal(r.ok, true, JSON.stringify(r));
  const esc = (await getEscrow(db, (r as { escrowId: string }).escrowId))!;
  const heldCents = (raw.prepare('SELECT amount_cents FROM wallet_holds WHERE id = ?').get(esc.hold_id) as { amount_cents: number })
    .amount_cents;
  assert.equal(heldCents, 3570, 'an uncapped 3,571 would have been refused by the hold');
});

test('a wallet genuinely short of the offer is still refused, and nothing is reserved', async () => {
  const { raw, db } = setupTyped(0);
  await depositTyped(db, raw, 49_000, 'T3');
  const r = await hold(db);
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'INSUFFICIENT_FUNDS');
  assert.equal(
    (raw.prepare('SELECT COUNT(*) AS n FROM wallet_holds').get() as { n: number }).n,
    0,
    'a refused offer reserves nothing'
  );
});

test('a partial refund credits exactly the refunded dinars', async () => {
  const { raw, db } = setupTyped(0);
  await depositTyped(db, raw, 50_000, 'T4');
  const r = await hold(db);
  const escrowId = (r as { escrowId: string }).escrowId;
  const rf = await refundEscrow(db, { escrowId, actorId: 'boss', actorRole: 'admin', amountIqd: 20_000, idempotencyKey: 'prf-t4' });
  assert.equal(rf.ok, true, JSON.stringify(rf));
  const credit = raw
    .prepare("SELECT amount, amount_iqd, exchange_rate_snapshot FROM wallet_transactions WHERE id = ?")
    .get(`wtx_escrow_refund_${escrowId}`) as { amount: number; amount_iqd: number; exchange_rate_snapshot: number };
  assert.deepEqual(
    { ...credit },
    { amount: Math.floor((20_000 * 100) / RATE), amount_iqd: 20_000, exchange_rate_snapshot: RATE },
    'floored at the hold’s rate, with the dinars beside the cents'
  );
  assert.equal(await dinarBalance(db, raw), 20_000, 'the customer reads exactly what came back — not 20,006');
});
