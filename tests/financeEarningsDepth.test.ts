/** Node's SQLite accepts expression trees deeper than Cloudflare D1's 100.
 * Compile the actual earnings and withdrawal SQL with D1's limit as well. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asD1, freshDb } from './fixtures/app';
import { changeWithdrawalState, participantOverview, payWithdrawal, requestWithdrawal } from '../worker/lib/financeParticipants';
import type { Env } from '../worker/lib/types';

test('earnings, withdrawal reservations and payouts fit the D1 expression-depth limit', async () => {
  const raw = freshDb();
  const directory = mkdtempSync(join(tmpdir(), 'levonis-earnings-depth-'));
  try {
    raw.exec(`INSERT INTO users(id,email,name,role,admin_scope,email_verified_at) VALUES
      ('boss','boss@x.co','Owner','admin','full','2026-01-01'),
      ('staff','staff@x.co','Staff','admin','assistant',NULL);
      UPDATE finance_staff SET user_id='staff' WHERE id='staff_sajjad';
      INSERT INTO expense_categories(id,slug,name_ar) VALUES ('wages','depth-wages','Wages');
      INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
      VALUES ('o','staff','delivered','{}','standard','{}','cash',50000,1500,55000,55000);
      INSERT INTO finance_order_costs(id,order_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,base_iqd,qty,amount_iqd,cost_day,state,snapshot)
      VALUES ('wage','o','rule',1,'Preparation','prep','staff_sajjad','wages','delivered',40000,1,10000,'2026-10-01','approved','{}');`);
    const sql = new Set<string>();
    const local = asD1(raw);
    const db = new Proxy(local, { get(target, key) {
      if (key === 'prepare') return (query: string) => { sql.add(query); return target.prepare(query); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    assert.equal((await participantOverview(db, 'boss')).summary.available_iqd, 0);
    assert.equal((await participantOverview(db, 'staff')).summary.available_iqd, 10000);
    await requestWithdrawal({ DB: db } as Env, 'staff', 'depth-withdrawal', 7000, 'earnings');
    await changeWithdrawalState(db, 'depth-withdrawal', 'boss', 'approve');
    await payWithdrawal(db, 'boss', 'depth-withdrawal', { id: 'depth-payout', amount: 3000, reference: 'cash', receipt_url: '' });
    const summary = (await participantOverview(db, 'staff')).summary;
    assert.equal(summary.available_iqd, 3000);
    assert.equal(summary.held_iqd, 4000);
    assert.equal(summary.paid_iqd, 3000);

    const path = join(directory, 'schema.sqlite');
    raw.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    const compiled = spawnSync('python3', ['-I', '-c', `
import json, sqlite3, sys
db = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 100)
assert db.getlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH) == 100
for sql in json.load(sys.stdin):
    try:
        db.execute('EXPLAIN ' + sql)
    except sqlite3.ProgrammingError as error:
        # Preparing succeeded; bound values are not needed for this compile check.
        if 'Incorrect number of bindings supplied' not in str(error): raise
    except sqlite3.Error as error:
        raise AssertionError(str(error) + '\\n' + sql[:200]) from error
`, path], { input: JSON.stringify([...sql]), encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message);
  } finally {
    raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
