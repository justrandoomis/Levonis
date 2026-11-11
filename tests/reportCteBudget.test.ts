/**
 * THE PROFIT REPORT'S SQL FITS SQLITE 3.54's SUBQUERY BUDGET ON D1 (live 500 of 2026-11-11).
 *
 * SQLite 3.54 (Cloudflare runtime from workerd 1.20261016+; 3.53.4 in node:sqlite and in this repo's
 * workerd does not do it) refuses a statement with «VIEWs and/or subqueries nested too deep» once its
 * FROM sources, counted as below, reach 100 under D1/workerd limits. The accepted-price CTEs used to
 * re-read their inputs, so every sales/refunds statement of /summary, /products and /categories cost
 * 111–455 and the three endpoints answered 500 for any period. Neither engine CI runs can see it, so this
 * suite reproduces 3.54's count from the SQL text.
 *
 * THE COUNT (measured on workerd 1.20261109.1 / SQLite 3.54.1 by padding a statement with a chain of k
 * CTEs until it fails: cost = 100 - k; a 100-CTE chain fails, 99 passes):
 *   every FROM source of every SELECT, compound arms included:
 *     table or table-valued function (json_each)      1
 *     derived table                                    1 + cost(its query)
 *     CTE reference                                    1 + cost(CTE body)  — again at EVERY reference
 *     a recursive CTE naming itself in its own body    1
 *   + cost of every expression subquery (scalar, EXISTS, IN); the subquery itself adds 0.
 * Validation: 35 measured micro shapes (11 kept in the first test) and the old ap_* chain (ap_base 6 …
 * ap_revenue 98) match exactly; the 49 fixed report variants match their measured cost exactly (worst:
 * refundsByProduct / refundsByCategory, 82); the pre-fix SQL scores 111–114 (sales) and 450–455 (refunds),
 * and 3.54.1 refused every one of those statements.
 *
 * The fix and this guard: DECISIONS row 313 (8). Run: node --import tsx --test tests/reportCteBudget.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SchemaFacts } from '../worker/lib/financeReport';

// REPORT_MODULE points the guard at another copy of the report (the pre-fix one fails it: 111–455).
const MODULE = process.env.REPORT_MODULE ?? '../worker/lib/financeReport';
const D1_SUBQUERY_BUDGET = 100;

type Cte = { name: string; start: number; end: number; scope: Map<string, Cte> };
const ENDS = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'WINDOW', 'UNION', 'INTERSECT', 'EXCEPT', 'RETURNING']);

/** SQLite 3.54's subquery budget for one statement, from its text. */
export function subqueryBudget(sql: string): number {
  const t: string[] = [];
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') { const j = sql.indexOf('\n', i); i = j < 0 ? sql.length : j; continue; }
    if (c === "'" || c === '"') { let j = i + 1; while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1; t.push(c === "'" ? "''" : sql.slice(i + 1, j)); i = j + 1; continue; }
    const w = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i, i + 200));
    if (w) { t.push(w[0]); i += w[0].length; continue; }
    if (!/\s/.test(c)) t.push(c);
    i++;
  }
  const up = t.map((x) => x.toUpperCase());
  const match: number[] = [];
  const open: number[] = [];
  t.forEach((x, i) => { if (x === '(') open.push(i); else if (x === ')') { const o = open.pop()!; match[o] = i; match[i] = o; } });
  const isSub = (i: number) => t[i] === '(' && ['SELECT', 'WITH', 'VALUES'].includes(up[i + 1]);
  const memo = new Map<Cte, number>();
  const cteCost = (c: Cte) => { if (!memo.has(c)) memo.set(c, query(c.start, c.end, c.scope, c.name)); return memo.get(c)!; };

  function query(a: number, b: number, scope: Map<string, Cte>, self?: string): number {
    if (up[a] === 'WITH') {
      const inner = new Map(scope);
      let i = up[a + 1] === 'RECURSIVE' ? a + 2 : a + 1;
      for (;;) {
        const name = t[i++];
        if (t[i] === '(') i = match[i] + 1; // column list
        i++; // AS
        if (up[i] === 'NOT') i += 2; else if (up[i] === 'MATERIALIZED') i++;
        inner.set(name.toLowerCase(), { name: name.toLowerCase(), start: i + 1, end: match[i], scope: inner });
        i = match[i] + 1;
        if (t[i] !== ',') break;
        i++;
      }
      return query(i, b, inner, self);
    }
    let total = 0, arm = a;
    for (let i = a; i < b; i++) {
      if (t[i] === '(') i = match[i];
      else if (['UNION', 'INTERSECT', 'EXCEPT'].includes(up[i])) { total += select(arm, i, scope, self); arm = up[i + 1] === 'ALL' ? i + 2 : i + 1; }
    }
    return total + select(arm, b, scope, self);
  }

  function select(a: number, b: number, scope: Map<string, Cte>, self?: string): number {
    let total = 0;
    let state: 'other' | 'item' | 'rest' = 'other';
    for (let i = a; i < b; i++) {
      if (state === 'item') {
        if (isSub(i)) total += 1 + query(i + 1, match[i], scope, self);
        else if (t[i] === '(') total += select(i + 1, match[i], scope, self);
        else if (t[i + 1] === '(') { total += 1 + select(i + 2, match[i + 1], scope, self); i = match[i + 1]; state = 'rest'; continue; } // table-valued function
        else { const n = t[i].toLowerCase(); total += 1 + (n !== self && scope.has(n) ? cteCost(scope.get(n)!) : 0); }
        if (t[i] === '(') i = match[i];
        state = 'rest';
      } else if (t[i] === '(') {
        if (isSub(i)) { total += query(i + 1, match[i], scope, self); i = match[i]; }
      } else if (up[i] === 'FROM') state = 'item';
      else if (state === 'rest' && (t[i] === ',' || up[i] === 'JOIN')) state = 'item';
      else if (state === 'rest' && ENDS.has(up[i])) state = 'other';
    }
    return total;
  }
  return query(0, t.length, new Map());
}

const chain = (n: number, body: (prev: string) => string) =>
  `WITH RECURSIVE ${Array.from({ length: n }, (_, i) => (i ? `c${i + 1} AS (${body(`c${i}`)})` : 'c1 AS (SELECT 1 AS x)')).join(', ')} SELECT x FROM c${n}`;

test('the counter reproduces what SQLite 3.54.1 charged for each shape (measured on workerd 1.20261109.1)', () => {
  const measured: Array<[string, number]> = [
    ['SELECT 1 AS v', 0],
    ['SELECT (SELECT (SELECT 1)) AS v WHERE EXISTS (SELECT 1) AND 1 IN (SELECT 1)', 0],
    ['SELECT v FROM (SELECT 1 AS v)', 1],
    ["SELECT (SELECT value FROM json_each('[1]')) AS v", 1],
    ['SELECT o.id FROM orders o LEFT JOIN (SELECT order_id FROM order_items GROUP BY order_id) k ON k.order_id = o.id', 3],
    ["SELECT (SELECT COUNT(*) FROM orders om JOIN json_each('[]') mb WHERE om.id = o.id AND (SELECT mp.value FROM json_each('{}') mp) = 'y') AS v FROM orders o", 4],
    ['WITH RECURSIVE a AS (SELECT 1 AS x), r(x) AS (SELECT x FROM a UNION ALL SELECT x + 1 FROM r WHERE x < 3) SELECT x FROM r', 3],
    ['WITH a AS (SELECT 1 AS v) SELECT x.v FROM a x JOIN a y ON x.v = y.v', 2],
    ['WITH a AS (SELECT 1 AS v), b AS (SELECT (SELECT v FROM a) AS v, SUM(1) OVER () AS w) SELECT v FROM b', 2],
    [chain(99, (p) => `SELECT x FROM ${p}`), 99], // passes on 3.54.1; 100 fails
    [chain(7, (p) => `SELECT a.x FROM ${p} a JOIN ${p} b ON a.x = b.x GROUP BY a.x`), 127], // first failing length
  ];
  for (const [sql, cost] of measured) assert.equal(subqueryBudget(sql), cost, sql.slice(0, 80));
});

test('every profit-report statement stays under D1’s subquery budget on SQLite 3.54, for every schema', async () => {
  const fr: typeof import('../worker/lib/financeReport') = await import(MODULE);
  const keys = ['has0095', 'hasFifo', 'hasOperationalRefunds', 'hasPriceAdjustments', 'hasLineEstimates', 'hasTradeInCoupons', 'hasTradeInStock', 'hasTradeInReissues'] as const satisfies ReadonlyArray<keyof SchemaFacts>;
  let worst = { cost: 0, name: '' };
  for (let m = 0; m < 1 << keys.length; m++) {
    const s = Object.fromEntries(keys.map((k, i) => [k, !!(m & (1 << i))])) as Record<(typeof keys)[number], boolean>;
    const statements: Record<string, string> = {
      salesByDay: fr.salesByDaySql(s), refundsByDay: fr.refundsByDaySql(s), ordersByDay: fr.ordersByDaySql(s),
      salesByProduct: fr.salesByProductSql(s), refundsByProduct: fr.refundsByProductSql(s),
      salesByCategoryMain: fr.salesByCategorySql(s, 'main'), refundsByCategoryMain: fr.refundsByCategorySql(s, 'main'),
      salesByCategorySub: fr.salesByCategorySql(s, 'sub'), refundsByCategorySub: fr.refundsByCategorySql(s, 'sub'),
    };
    for (const [name, sql] of Object.entries(statements)) {
      const cost = subqueryBudget(sql);
      if (cost > worst.cost) worst = { cost, name: `${name} (schema ${m})` };
      assert.ok(cost < D1_SUBQUERY_BUDGET, `${name} with schema ${m} costs ${cost}: D1 refuses it («VIEWs and/or subqueries nested too deep»)`);
    }
  }
  console.log(`worst profit-report statement: ${worst.name} = ${worst.cost} of ${D1_SUBQUERY_BUDGET}`);
});
