/**
 * «يكتب مستخدم خمسين ألف فيضاف أصبح أقل 49,994 … وعندما يريد أن يطلب منتجا
 *  الذي يكون طابعة تطلب خمسين ألف ضبط فيقول له الرصيد غير كافي.»
 *
 * THE OWNER'S OWN SCENARIO, RUN. A customer types 50,000 د.ع, the deposit is
 * filed by the REAL `createDepositRequest` against the REAL migrations, an
 * admin approves it, and then the two comparisons that refused them are made
 * with the real functions checkout makes them with. The assertion is that the
 * order is ACCEPTED — and, one line later, that the wallet reads empty rather
 * than carrying a six-dinar ghost of its own credit.
 *
 * THE OTHER HALF IS THE ONE THAT MATTERS MORE: that no balance that already
 * exists moves. Three populations are pinned here — a row with no testimony,
 * a row from the CEIL era between 0105 and 0106 whose testimony would LOWER a
 * balance if it were read unclamped, and a database that has not run 0108 at
 * all. All three must read exactly what they read before this change.
 *
 * TWO KINDS OF ASSERTION, the same division tests/walletTypedDinars.test.ts
 * makes: the arithmetic runs against the real engine, and the WIRING is a
 * source rule, because a balance line quietly reverted to the old conversion
 * is precisely the change that passes every behavioural test written for it.
 *
 * Run: node --import tsx --test tests/walletDinarBalance.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1, createTableSql } from './fixtures/d1';
import {
  availableUsdSql,
  createDepositRequest,
  readWalletDust,
  usdSpendStatement,
  walletIqdAvailable,
  walletSpendCents,
} from '../worker/lib/walletOps';
import { requestWithdrawal } from '../worker/lib/walletOps';
import { printerHomeDeliveryAdvanceIqd } from '../worker/lib/printerAdvance';
import { iqdToUsdCents, usdCentsToIqd } from '../src/lib/api';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const migration = (f: string) => read(join('migrations', f));

const RATE = 1400;
/** The advance the owner configured, read the way the shop reads it. */
const PRINTER_ADVANCE = printerHomeDeliveryAdvanceIqd({
  hasPrinterLine: true,
  isPickup: false,
  noteIqd: 50_000,
});

/**
 * `upTo0108` false builds the wallet exactly as a database that has NOT run
 * 0108 has it. That is not a convenience: a Worker can reach production ahead
 * of its migration, and a balance query that threw there would take the wallet
 * page, the checkout quote and every affordability decision down at once.
 */
function freshDb(upTo0108 = true): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, username TEXT)');
  raw.exec(createTableSql('0001_init.sql', 'wallet_transactions'));
  raw.exec(migration('0015_wallet_holds.sql'));
  raw.exec(migration('0105_deposit_declared_iqd.sql'));
  raw.exec(migration('0106_withdrawal_declared_iqd.sql'));
  if (upTo0108) raw.exec(migration('0108_wallet_ledger_dinars.sql'));
  for (const u of ['u1', 'u2', 'u3']) {
    raw.prepare('INSERT INTO users (id, email, username) VALUES (?,?,?)').run(u, `${u}@example.com`, u);
  }
  return { db: new SqliteD1(raw) as unknown as D1Database, raw };
}

/** File a deposit the way the customer's browser does, then approve it. */
async function depositAndApprove(
  db: D1Database,
  raw: DatabaseSync,
  p: { userId: string; typedIqd: number | null; cents: number; rate?: number; ref: string }
): Promise<string> {
  const txId = `wtx_${p.ref}`;
  const res = await createDepositRequest(db, {
    userId: p.userId,
    amountCents: p.cents,
    receiptKey: `receipts/${p.userId}/x.png`,
    provider: 'zaincash',
    channel: 'app',
    reference: p.ref,
    declaredAmountIqd: p.typedIqd ?? undefined,
    exchangeRateSnapshot: p.typedIqd ? (p.rate ?? RATE) : undefined,
    txId,
  });
  assert.equal(res.ok, true, 'the deposit request must file');
  raw.prepare("UPDATE wallet_transactions SET status = 'approved' WHERE id = ?").run(txId);
  return txId;
}

/**
 * The REAL spendable expression — settled minus effective holds — read the way
 * every guard reads it. `?1` and not `?`: the fragment names the user twice,
 * and a bare `?` would bind the holds sum to NULL and quietly report a balance
 * that no hold had ever been subtracted from.
 */
const availableCents = (raw: DatabaseSync, userId: string): number =>
  Number((raw.prepare(`SELECT ${availableUsdSql('?1')} AS c`).get(userId) as { c: number }).c);

// ------------------------------------------------- the defect, and its shape

test('the pair is not a round trip — which is why a rounding rule cannot fix it', () => {
  // The owner's own example: «مثلا 35.71 = 50,000».
  assert.equal(iqdToUsdCents(50_000, RATE), 3571);
  assert.equal((3571 / 100).toFixed(2), '35.71');
  // And neither neighbour reads back as 50,000. That is the whole defect.
  assert.equal(usdCentsToIqd(3571, RATE), 49_994, 'the floor credits LESS than was transferred');
  assert.equal(usdCentsToIqd(3572, RATE), 50_008, 'the ceil credits MORE than was transferred');
  // The advance is a NATIVE dinar figure — never converted, never rounded.
  assert.equal(PRINTER_ADVANCE, 50_000);
});

// ------------------------------------------------------ the owner's scenario

test('a customer who types 50,000 holds 50,000 and passes a 50,000 printer advance', async () => {
  const { db, raw } = freshDb();
  // The browser's own arithmetic, unchanged: floor, the owner's rule.
  const cents = iqdToUsdCents(50_000, RATE);
  assert.equal(cents, 3571);
  await depositAndApprove(db, raw, { userId: 'u1', typedIqd: 50_000, cents, ref: 'R-1' });

  // The ledger is still cents, and still exactly what was credited.
  assert.equal(availableCents(raw, 'u1'), 3571);

  // THE BALANCE, as worker/routes/orders.ts now builds it.
  const dust = await readWalletDust(db, 'u1');
  assert.equal(dust.ledger_dinars, true);
  assert.equal(dust.dust_iqd, 6, 'the dinars the cent grid could not hold');
  const balanceIqd = walletIqdAvailable(3571, dust.dust_iqd, RATE);
  assert.equal(balanceIqd, 50_000, 'not 49,994 and not 50,008 — the figure that was typed');

  // THE FIRST DOOR — worker/routes/orders.ts, `walletApplied < requiredAdvance`.
  const walletApplied = Math.min(balanceIqd, PRINTER_ADVANCE);
  assert.equal(walletApplied, 50_000);
  assert.equal(walletApplied < PRINTER_ADVANCE, false, 'ACCEPTED: the advance is covered');

  // THE SECOND DOOR — the cents the wallet actually pays, at the same floor
  // the credit used. Under the old ceil this was 3,572 against 3,571 and the
  // order was refused a second time with a worse message.
  const walletUsdCents = Math.floor((walletApplied * 100) / RATE);
  assert.equal(walletUsdCents, 3571);
  assert.equal(walletUsdCents > availableCents(raw, 'u1'), false, 'ACCEPTED: the debit fits the balance');
  assert.equal(Math.ceil((walletApplied * 100) / RATE), 3572, 'the superseded ceil, kept legible');

  // And the debit posts, carrying the dinars it was quoted in.
  await db.batch([
    usdSpendStatement(db, {
      txId: 'wtx_ord_1_usd',
      userId: 'u1',
      amountCents: walletUsdCents,
      note: 'Wallet payment on order 1',
      ref: 'ORD-1',
      nowIso: '2026-09-23T10:00:00.000Z',
      amountIqd: walletApplied,
      exchangeRateSnapshot: RATE,
    }),
  ]);
  assert.equal(availableCents(raw, 'u1'), 0);
  const after = await readWalletDust(db, 'u1');
  assert.equal(after.dust_iqd, 0, 'the credit’s remainder is cancelled by the debit that spent it');
  assert.equal(walletIqdAvailable(0, after.dust_iqd, RATE), 0, 'an emptied wallet reads empty');
});

test('the recorded dinars do not move when the owner moves the rate', async () => {
  const { db, raw } = freshDb();
  await depositAndApprove(db, raw, { userId: 'u1', typedIqd: 50_000, cents: 3571, ref: 'R-1' });

  const row = raw
    .prepare('SELECT amount, amount_iqd, exchange_rate_snapshot FROM wallet_transactions WHERE id = ?')
    .get('wtx_R-1') as { amount: number; amount_iqd: number; exchange_rate_snapshot: number };
  assert.deepEqual({ ...row }, { amount: 3571, amount_iqd: 50_000, exchange_rate_snapshot: 1400 });

  // The rate moves. Nothing stored is recomputed and nothing is rewritten:
  // the dust is read at the row's OWN snapshot, not at today's rate.
  const dust = await readWalletDust(db, 'u1');
  assert.equal(dust.dust_iqd, 6);
  const again = raw
    .prepare('SELECT amount, amount_iqd, exchange_rate_snapshot FROM wallet_transactions WHERE id = ?')
    .get('wtx_R-1');
  assert.deepEqual({ ...(again as object) }, { amount: 3571, amount_iqd: 50_000, exchange_rate_snapshot: 1400 });

  // The cents float with the rate, exactly as they always have, and the
  // remainder rides along — it never becomes a rate pin that strands money.
  assert.equal(walletIqdAvailable(3571, dust.dust_iqd, 1600), usdCentsToIqd(3571, 1600) + 6);
  assert.equal(walletIqdAvailable(3571, dust.dust_iqd, 1600), 57_142);
});

// ------------------------------------------- nothing that already exists moves

test('a row with no testimony converts exactly as it did before', async () => {
  const { db, raw } = freshDb();
  // A deposit typed in DOLLARS, an admin credit, a refund — none of them has a
  // customer's dinar figure, in any vintage, and none may be invented one.
  await depositAndApprove(db, raw, { userId: 'u2', typedIqd: null, cents: 3571, ref: 'R-2' });
  const dust = await readWalletDust(db, 'u2');
  assert.equal(dust.dust_iqd, 0, 'no testimony, no remainder');
  assert.equal(
    walletIqdAvailable(3571, dust.dust_iqd, RATE),
    usdCentsToIqd(3571, RATE),
    'byte for byte the conversion every screen did before 0108'
  );
  assert.equal(walletIqdAvailable(3571, 0, RATE), 49_994);
});

test('a CEIL-era deposit keeps its balance — testimony may raise a reading, never lower one', async () => {
  const { db, raw } = freshDb();
  // Filed in the window between 0105 and 0106: the customer typed 50,000 and
  // the browser CEILED it to 3,572 cents, which read back as 50,008. Reading
  // that testimony unclamped would take EIGHT DINARS off a live balance.
  await depositAndApprove(db, raw, { userId: 'u3', typedIqd: 50_000, cents: 3572, ref: 'R-3' });
  const dust = await readWalletDust(db, 'u3');
  assert.equal(dust.dust_iqd, 0, 'the MAX(0, …) clamp — this is what it is for');
  assert.equal(walletIqdAvailable(3572, dust.dust_iqd, RATE), 50_008, 'unchanged, to the dinar');
  assert.ok(
    walletIqdAvailable(3572, dust.dust_iqd, RATE) >= usdCentsToIqd(3572, RATE),
    'no reading may fall below what the cents already converted to'
  );
});

test('a PRE-0108 deposit reads its dinars out of 0105 — this is the owner’s blocked customer', async () => {
  const { db, raw } = freshDb();
  // The customer in the report deposited AFTER 0105 shipped and after the
  // floor landed — that is the only way to reach 49,994 — so their deposit
  // carries declared_amount_iqd = 50000 in `wallet_deposit_meta` even though
  // the ledger row predates 0108. The testimony is read from there.
  await depositAndApprove(db, raw, { userId: 'u1', typedIqd: 50_000, cents: 3571, ref: 'R-4' });
  raw.prepare('UPDATE wallet_transactions SET amount_iqd = NULL, exchange_rate_snapshot = NULL WHERE id = ?').run('wtx_R-4');
  const dust = await readWalletDust(db, 'u1');
  assert.equal(dust.dust_iqd, 6, 'wallet_deposit_meta (0105) is the legacy source, unchanged and unrewritten');
  assert.equal(walletIqdAvailable(3571, dust.dust_iqd, RATE), 50_000);
});

test('a genuinely PRE-0105 deposit has no testimony anywhere, still reads 49,994, and stays blocked', async () => {
  /**
   * THE POPULATION THIS CHANGE DOES NOT REACH, stated as a test rather than
   * as a hope. A deposit filed before 0105 shipped recorded NO dinar figure —
   * not on the ledger row, not in `wallet_deposit_meta` — and
   * `admin_settings.exchangeRate` is a single mutable row with no history, so
   * what the rate was that week is not stored either.
   *
   * INVENTING ONE IS FORBIDDEN AND WOULD BE WRONG. 3,571 cents is not evidence
   * that anybody typed 50,000: at 1,400 it is equally consistent with a
   * customer who typed 49,995, and crediting them six dinars they never paid
   * is the same class of error as debiting six they did.
   *
   * So the only honest repair for this customer is a human one — the admin
   * credit path, with a reference — and this test exists so that the fix is
   * never reported as closing a case it cannot see.
   */
  const { db, raw } = freshDb();
  raw
    .prepare(
      "INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, created_by) VALUES (?,?,'deposit','USD',?,'approved','system')"
    )
    .run('wtx_legacy', 'u1', 3571);
  const dust = await readWalletDust(db, 'u1');
  assert.equal(dust.dust_iqd, 0, 'no record, no remainder — nothing may be invented for it');
  assert.equal(walletIqdAvailable(3571, dust.dust_iqd, RATE), 49_994, 'unchanged, and short of the advance');
  assert.ok(walletIqdAvailable(3571, dust.dust_iqd, RATE) < PRINTER_ADVANCE, 'BLOCKED, and knowingly so');
});

test('the dinar balance is never below the cents balance, whatever the remainder says', () => {
  /**
   * THE LOWER CLAMP IS THE ONE THAT PROTECTS LIVE MONEY, and it is the only
   * clamp left in this function. A wallet whose rows recorded nothing, or
   * whose debits recorded more remainder than its credits, reads exactly what
   * every screen printed before 0108.
   *
   * THE UPPER CLAMP THAT USED TO BE ASSERTED HERE IS GONE ON PURPOSE. It read
   * `Math.min(dust, Math.ceil(rate / 100))` and it is what refused the owner's
   * customer a second time: two typed deposits of 25,000 د.ع carry two honest
   * ten-dinar remainders, and cutting their SUM to one cent's worth put the
   * balance back on 49,994. The ceiling now bounds what EACH ROW may
   * contribute, inside `walletDustIqdSql`, where the rows can still be told
   * apart — the test below proves it on a real admin-reduced credit.
   */
  for (const rate of [1400, 1450, 1500, 1600]) {
    for (const cents of [0, 1, 100, 3571, 7142, 1_000_000]) {
      const floorIqd = usdCentsToIqd(cents, rate);
      for (const dust of [-50, 0, 3, 13, 14, 999, 100_000]) {
        const v = walletIqdAvailable(cents, dust, rate);
        if (cents <= 0) {
          assert.equal(v, 0, 'an empty wallet reads empty whatever the dust says');
          continue;
        }
        assert.ok(v >= floorIqd, `balance fell below the cents at rate ${rate}, cents ${cents}, dust ${dust}`);
        assert.equal(v, floorIqd + Math.max(dust, 0), 'the reading is the cents conversion plus the recorded remainder');
      }
    }
  }
});

test('a customer’s own claim is ceilinged per row; what the shop itself wrote is not', async () => {
  const { db, raw } = freshDb();
  // AN ADMIN APPROVES A DEPOSIT FOR LESS THAN WAS DECLARED. `corroborated-
  // DeclaredIqd` cannot see this — it runs at request time, against the cents
  // that arrived — so the row ends up claiming 50,000 د.ع beside 1,785 cents,
  // a remainder of 25,010. The per-row ceiling cuts it to 13: the widest a
  // single floor() could honestly have missed by at 1,400.
  await depositAndApprove(db, raw, { userId: 'u1', typedIqd: 50_000, cents: 3571, ref: 'R-C' });
  raw.prepare('UPDATE wallet_transactions SET amount = 1785 WHERE id = ?').run('wtx_R-C');
  const dust = await readWalletDust(db, 'u1');
  assert.equal(dust.dust_iqd, 13, 'the ceiling, applied where the rows can still be told apart');
  assert.equal(walletIqdAvailable(1785, dust.dust_iqd, RATE), usdCentsToIqd(1785, RATE) + 13);

  // FOUR HONEST TOP-UPS KEEP FOUR HONEST REMAINDERS. This is the case a
  // ceiling on the SUM could not distinguish from the one above.
  const { db: db2, raw: raw2 } = freshDb();
  for (let i = 0; i < 4; i += 1) {
    await depositAndApprove(db2, raw2, { userId: 'u1', typedIqd: 10_000, cents: iqdToUsdCents(10_000, RATE), ref: `R-D${i}` });
  }
  const many = await readWalletDust(db2, 'u1');
  assert.equal(many.dust_iqd, 16, 'four remainders of four, not one cent for the wallet');
  assert.equal(walletIqdAvailable(4 * iqdToUsdCents(10_000, RATE), many.dust_iqd, RATE), 40_000);
});

test('a refund restores the remainder its debit cancelled — the round trip closes', async () => {
  const { db, raw } = freshDb();
  await depositAndApprove(db, raw, { userId: 'u1', typedIqd: 25_000, cents: iqdToUsdCents(25_000, RATE), ref: 'R-E1' });
  await depositAndApprove(db, raw, { userId: 'u1', typedIqd: 25_000, cents: iqdToUsdCents(25_000, RATE), ref: 'R-E2' });
  const start = walletIqdAvailable(availableCents(raw, 'u1'), (await readWalletDust(db, 'u1')).dust_iqd, RATE);
  assert.equal(start, 50_000);

  // The checkout debit: `walletSpendCents` floors and caps at the cents on
  // hand, and records the dinars it was quoted in.
  const cents = walletSpendCents(start, availableCents(raw, 'u1'), RATE);
  assert.equal(cents, 3570, 'capped at the cents on hand — an uncapped 3,571 would abort the batch');
  await db.batch([
    usdSpendStatement(db, {
      txId: 'wtx_ord_9_usd',
      userId: 'u1',
      amountCents: cents,
      note: 'Wallet payment on order 9',
      ref: 'ORD-9',
      nowIso: '2026-09-23T10:00:00.000Z',
      amountIqd: start,
      exchangeRateSnapshot: RATE,
    }),
  ]);
  assert.equal(walletIqdAvailable(availableCents(raw, 'u1'), (await readWalletDust(db, 'u1')).dust_iqd, RATE), 0);

  // The cancel refund, in the shape worker/lib/orderCancelOps.ts writes it:
  // the cents it took, and the dinars COPIED off the debit it reverses.
  await db.batch([
    db
      .prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at, amount_iqd, exchange_rate_snapshot)
         SELECT ?1, ?3, 'deposit', 'USD', ?4, 'approved', ?5, ?2, 'system', ?6,
           (SELECT SUM(d.amount_iqd) FROM wallet_transactions d
             WHERE d.ref = ?2 AND d.user_id = ?3 AND d.currency = 'USD' AND d.type = 'withdrawal'
               AND d.amount_iqd > 0 AND d.exchange_rate_snapshot > 0),
           (SELECT MAX(d.exchange_rate_snapshot) FROM wallet_transactions d
             WHERE d.ref = ?2 AND d.user_id = ?3 AND d.currency = 'USD' AND d.type = 'withdrawal'
               AND d.amount_iqd > 0 AND d.exchange_rate_snapshot > 0)`
      )
      .bind('wtx_refund_ORD-9_usd', 'ORD-9', 'u1', cents, 'Refund', '2026-09-23T11:00:00.000Z'),
  ]);
  const back = walletIqdAvailable(availableCents(raw, 'u1'), (await readWalletDust(db, 'u1')).dust_iqd, RATE);
  assert.equal(back, 50_000, 'a cancel may not leave a customer poorer than never ordering');
});

test('a pending withdrawal’s dinars leave with its hold, not with its payout', async () => {
  /**
   * The cents go the moment the HOLD is active — `effectiveHoldsUsdSql`
   * subtracts it while the ledger row is still `pending`. The dinars used to
   * wait for `status = 'approved'`, so the reading stayed high and then
   * dropped when the admin recorded the payout, at an instant when no money
   * moved at all. The two now hand over between them.
   */
  const { db, raw } = freshDb();
  await depositAndApprove(db, raw, { userId: 'u1', typedIqd: 50_000, cents: 3571, ref: 'R-F' });
  const res = await requestWithdrawal(db, {
    userId: 'u1',
    amountCents: iqdToUsdCents(20_000, RATE),
    destination: { kind: 'manual_transfer', account: '0770-000-0000', holder: 'Test User' },
    eventKey: 'wd-cont',
    feeBps: 0,
    declaredAmountIqd: 20_000,
    exchangeRateSnapshot: RATE,
  });
  assert.ok(res.ok, `the withdrawal was refused: ${JSON.stringify(res)}`);

  const whilePending = walletIqdAvailable(availableCents(raw, 'u1'), (await readWalletDust(db, 'u1')).dust_iqd, RATE);
  const txId = (raw.prepare('SELECT tx_id FROM wallet_withdrawals WHERE user_id = ?').get('u1') as { tx_id: string }).tx_id;
  raw.prepare("UPDATE wallet_transactions SET status = 'approved' WHERE id = ?").run(txId);
  const afterPayout = walletIqdAvailable(availableCents(raw, 'u1'), (await readWalletDust(db, 'u1')).dust_iqd, RATE);
  assert.equal(whilePending, afterPayout, 'the reading may not move when no money does');
});

test('a database that has not run 0108 reads exactly what it read before', async () => {
  const { db, raw } = freshDb(false);
  await depositAndApprove(db, raw, { userId: 'u1', typedIqd: 50_000, cents: 3571, ref: 'R-5' });
  const dust = await readWalletDust(db, 'u1');
  assert.equal(dust.ledger_dinars, false, 'the Worker knows its database is behind');
  assert.equal(dust.dust_iqd, 0);
  assert.equal(walletIqdAvailable(3571, dust.dust_iqd, RATE), 49_994, 'the pre-0108 reading, unchanged');
  // The deposit still filed, and the 0105 testimony is still recorded: the
  // fallback drops the ledger columns, never the customer's claim.
  const meta = raw
    .prepare('SELECT declared_amount_iqd FROM wallet_deposit_meta WHERE tx_id = ?')
    .get('wtx_R-5') as { declared_amount_iqd: number };
  assert.equal(meta.declared_amount_iqd, 50_000);
});

// ------------------------------------------------- the money path is untouched

test('the spend guard still runs on cents alone, and still refuses an overspend', async () => {
  const { db, raw } = freshDb();
  await depositAndApprove(db, raw, { userId: 'u1', typedIqd: 50_000, cents: 3571, ref: 'R-6' });
  // One cent more than the wallet holds, declared as a full 50,000 د.ع: the
  // dinar column may not buy a cent. CHECK (amount > 0) aborts the batch.
  await assert.rejects(
    db.batch([
      usdSpendStatement(db, {
        txId: 'wtx_over',
        userId: 'u1',
        amountCents: 3572,
        note: 'over',
        ref: 'ORD-X',
        nowIso: '2026-09-23T10:00:00.000Z',
        amountIqd: 50_000,
        exchangeRateSnapshot: RATE,
      }),
    ]),
    /constraint/i
  );
  assert.equal(availableCents(raw, 'u1'), 3571, 'nothing moved');
});

test('a forged dinar claim buys nothing — the cents are still the money', async () => {
  const { db, raw } = freshDb();
  // 50,000,000 د.ع declared beside 100 cents. `corroboratedDeclaredIqd` runs
  // the conversion server-side and refuses the testimony outright.
  await depositAndApprove(db, raw, { userId: 'u2', typedIqd: 50_000_000, cents: 100, ref: 'R-7' });
  const row = raw
    .prepare('SELECT amount, amount_iqd FROM wallet_transactions WHERE id = ?')
    .get('wtx_R-7') as { amount: number; amount_iqd: number | null };
  assert.equal(row.amount, 100);
  assert.equal(row.amount_iqd, null, 'a claim nothing backs is stored as NULL, not as a repaired number');
  const dust = await readWalletDust(db, 'u2');
  assert.equal(dust.dust_iqd, 0);
  assert.equal(walletIqdAvailable(100, dust.dust_iqd, RATE), usdCentsToIqd(100, RATE));
});

// ------------------------------------------------------------- the wiring

test('the balance sites read the one rule and do not re-derive it', () => {
  const orders = read('worker/routes/orders.ts');
  // The line that made 49,994 is gone, and the advance comparison is fed by
  // the one function that knows the rule.
  assert.match(
    orders,
    /const walletBalanceIqd = walletIqdAvailable\(available\.usd_cents_available, walletDust\.dust_iqd, exchangeRate\);/
  );
  assert.ok(
    !/const walletBalanceIqd = Math\.floor\(\(available\.usd_cents_available \* exchangeRate\) \/ 100\)/.test(orders),
    'the old conversion is back on the balance line'
  );
  // The second door: the wallet's share is floored and capped at the cents on
  // hand, by the ONE shared helper — and the file's private ceil helper is
  // gone rather than left for the next caller to find.
  assert.match(
    orders,
    /const walletUsdCents = walletSpendCents\(walletApplied, available\.usd_cents_available, exchangeRate\);/
  );
  assert.match(orders, /if \(walletUsdCents <= 0\) walletApplied = 0;/, 'a sub-cent application must not be granted free');
  assert.ok(
    !/function iqdToUsdCents\(iqd: number, rate: number\): number \{/.test(orders),
    'the private ceil helper is back'
  );
  // The three dinar-priced wallet payments read the SAME rule. A fourth
  // conversion appearing in any of them is how the surfaces drifted apart.
  for (const f of ['worker/routes/storeOrders.ts', 'worker/routes/memberships.ts']) {
    const src = read(f);
    assert.match(src, /walletSpendCents\(/, `${f} does not use the shared spend conversion`);
    assert.match(src, /walletIqdAvailable\(/, `${f} does not ask the affordability question in dinars`);
    assert.ok(!/iqdToUsdCents\(/.test(src), `${f} still converts a wallet payment with the ceil`);
  }
  // A refund gives back both units, or neither — never cents alone.
  const cancel = read('worker/lib/orderCancelOps.ts');
  assert.match(cancel, /SELECT SUM\(d\.amount_iqd\) FROM wallet_transactions d/);
  assert.match(cancel, /d\.exchange_rate_snapshot > 0/, 'a refund may not invent a rate');
  // The debit records the dinars it was quoted in, so the remainder cancels.
  assert.match(orders, /amountIqd: comp\.walletLedgerDinars \? comp\.walletApplied : null/);

  // The server owns the rule; no client re-derives a dinar balance.
  const wallet = read('worker/routes/wallet.ts');
  assert.match(wallet, /balance_iqd: balanceIqd,/);
  assert.match(wallet, /walletIqdAvailable\(breakdown\.usd_cents_available, dust\.dust_iqd, exchangeRate\)/);
  const ctx = read('src/WalletContext.tsx');
  assert.match(ctx, /setBalanceIqd\(Number\(data\.balance_iqd\) \|\| 0\);/);
  for (const page of ['src/pages/Wallet.tsx', 'src/pages/Profile.tsx', 'src/pages/Checkout.tsx']) {
    const src = read(page);
    assert.ok(
      /iqd_available|balanceIqd|walletBalanceIqdFromServer/.test(src),
      `${page} is not reading the server's dinar balance`
    );
  }
});

test('the spend guards were not moved to dinars', () => {
  const ops = read('worker/lib/walletOps.ts');
  // The three guards that decide whether money may move, verbatim and still
  // in cents. A dinar column may never appear in one of them.
  assert.match(ops, /export const availableUsdSql = \(u: string\) => `\(\$\{settledUsdSql\(u\)\} - \$\{effectiveHoldsUsdSql\(u\)\}\)`;/);
  assert.match(ops, /CASE WHEN \$\{availableUsdSql\('\?2'\)\} >= \?3 THEN \?3 ELSE -1 END/);
  assert.match(ops, /WHERE \$\{availableUsdSql\('\?2'\)\} >= \?4/);
  // And the migration is append-only: no UPDATE, no backfill, nullable only.
  const m = read('migrations/0108_wallet_ledger_dinars.sql');
  const sql = m.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/\bUPDATE\b|\bINSERT\b|\bDROP\b|\bDELETE\b/i.test(sql), 'the migration writes to a row');
  assert.match(sql, /ALTER TABLE wallet_transactions ADD COLUMN amount_iqd INTEGER;/);
  assert.match(sql, /ALTER TABLE wallet_transactions ADD COLUMN exchange_rate_snapshot INTEGER;/);
  assert.ok(!/CHECK/i.test(sql), 'a CHECK on a testimony column aborts money batches');
});

// ------------------------------------------------ the withdrawal side of it

test('withdrawing everything leaves nothing behind — not even the remainder', async () => {
  const { db, raw } = freshDb();
  await depositAndApprove(db, raw, { userId: 'u1', typedIqd: 50_000, cents: 3571, ref: 'R-8' });
  assert.equal(walletIqdAvailable(3571, (await readWalletDust(db, 'u1')).dust_iqd, RATE), 50_000);

  // The customer types their whole balance back out, at the same floor.
  const res = await requestWithdrawal(db, {
    userId: 'u1',
    amountCents: iqdToUsdCents(50_000, RATE),
    destination: { kind: 'manual_transfer', account: '0770-000-0000', holder: 'Test User' },
    eventKey: 'wd-1',
    feeBps: 0,
    declaredAmountIqd: 50_000,
    exchangeRateSnapshot: RATE,
  });
  assert.ok(res.ok, `the withdrawal was refused: ${JSON.stringify(res)}`);

  // While it is PENDING the hold has taken the cents, so the wallet is empty —
  // the dust may not resurrect money that is reserved for a payout.
  assert.equal(availableCents(raw, 'u1'), 0);
  assert.equal(walletIqdAvailable(0, (await readWalletDust(db, 'u1')).dust_iqd, RATE), 0);

  // And when the payout posts, the debit's own dinars cancel the credit's.
  const txId = (raw.prepare('SELECT tx_id FROM wallet_withdrawals WHERE user_id = ?').get('u1') as { tx_id: string })
    .tx_id;
  const row = raw
    .prepare('SELECT amount, amount_iqd, exchange_rate_snapshot FROM wallet_transactions WHERE id = ?')
    .get(txId) as { amount: number; amount_iqd: number; exchange_rate_snapshot: number };
  assert.deepEqual({ ...row }, { amount: 3571, amount_iqd: 50_000, exchange_rate_snapshot: 1400 });
  raw.prepare("UPDATE wallet_transactions SET status = 'approved' WHERE id = ?").run(txId);
  assert.equal((await readWalletDust(db, 'u1')).dust_iqd, 0);
});

test('a database at 0106 but not 0108 still records the payout card’s dinars', async () => {
  // The retry ladder drops the NEWEST testimony first. One shared flag would
  // have thrown away 0106's record — the only number a human reads before
  // making an outbound transfer — because 0108 was a deploy late.
  const { db, raw } = freshDb(false);
  await depositAndApprove(db, raw, { userId: 'u1', typedIqd: null, cents: 10_000, ref: 'R-9' });
  const res = await requestWithdrawal(db, {
    userId: 'u1',
    amountCents: 3571,
    destination: { kind: 'manual_transfer', account: '0770-000-0000', holder: 'Test User' },
    eventKey: 'wd-2',
    feeBps: 0,
    declaredAmountIqd: 50_000,
    exchangeRateSnapshot: RATE,
  });
  assert.ok(res.ok, `a withdrawal was refused for want of a migration: ${JSON.stringify(res)}`);
  const wd = raw
    .prepare('SELECT declared_amount_iqd, exchange_rate_snapshot FROM wallet_withdrawals WHERE user_id = ?')
    .get('u1') as { declared_amount_iqd: number; exchange_rate_snapshot: number };
  assert.equal(wd.declared_amount_iqd, 50_000, '0106’s testimony survived 0108’s absence');
  assert.equal(wd.exchange_rate_snapshot, 1400);
});
