import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, forbidden, notFound, str, int } from '../lib/http';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { canViewFinancials } from '../lib/adminScope';
import { baghdadDay, isDay } from '../lib/baghdadTime';
import {
  DEFAULT_EXPENSE_CATEGORIES,
  MAX_EXPENSE_REPEAT,
  expenseSeriesDays,
  expenseSlug,
  validateExpenseAmount,
  validateExpenseDay,
  type ExpenseCategoryRow,
  type ExpenseRow,
} from '../lib/financeLedger';

/**
 * «تكاليف اخرى ... لا علاقه لها بالمنتج الاساسي او ما يظهر للمستخدم، انها
 * خاصه في لوحه الادمن» — THE OPERATING-EXPENSE LEDGER, and nothing else.
 *
 * This router owns the WRITING of expenses and their categories. The reporting
 * that reads them — gross profit, net profit, the period charts — is a separate
 * module and deliberately so: a ledger that also draws its own conclusions is a
 * ledger whose numbers cannot be checked against anything.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT AN OPERATING EXPENSE IS, AND WHAT IT IS NOT
 *
 * It is rent, a salary, an advertising invoice, a shipping contract, customs,
 * a bank fee. It belongs to NO product. It is never shown to a customer and
 * there is no customer-facing route in this file at all.
 *
 * It is NOT a product cost. The product cost is one level, `cost_iqd` on the
 * product/option/colour rungs, and it is the cost of goods sold. Keeping the
 * two apart is the whole reason this table exists separately:
 *
 *     GROSS PROFIT = revenue − cost of goods sold   (per product, per category)
 *     NET PROFIT   = gross profit − operating expenses         (per period ONLY)
 *
 * An expense row belongs to no product, so a per-product NET profit would be an
 * invention. Nothing in this file may ever attach an expense to a product, and
 * there is no column for it to be attached with.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * EVERY ROUTE HERE IS FINANCIAL, SO EVERY ROUTE HERE IS GATED
 *
 * worker/lib/adminScope.ts §11: «cost وجميع تفاصيل الربح متاحة فقط
 * للمالك/الدور المالي. مساعد الأدمن العادي لا يراها في API ولا في HTML ولا في
 * export». An operating expense IS profit detail: knowing the shop pays
 * 600,000 a month in rent and 2,400,000 in salaries is knowing its cost base,
 * which is exactly what §11 withholds from an assistant admin.
 *
 * The gate is a router-level middleware rather than a check inside each
 * handler, because a check that each handler must remember is a check the next
 * handler will forget — and the failure mode of forgetting is an assistant
 * reading the owner's cost base out of a JSON response. It runs on `*`, which
 * covers reads, writes and anything added to this file later.
 */

export const adminFinanceRoutes = new Hono<AppContext>();
adminFinanceRoutes.use('*', requireAdmin);

/**
 * THE FINANCIAL SCOPE, ON EVERY METHOD AND EVERY PATH.
 *
 * 403 and not 404: the caller IS an administrator and the route DOES exist for
 * them as a person — what they lack is financial scope, and saying so is how an
 * assistant knows to ask the owner rather than report a broken panel. This is
 * the same answer `adminPriceGrid` gives for price history and for cost.
 */
async function requireFinancialAdmin(c: Context<AppContext>, next: Next) {
  if (!canViewFinancials(c.env, c.get('user'))) {
    throw forbidden('Expenses and profit detail are restricted to financial admins');
  }
  await next();
}
adminFinanceRoutes.use('*', requireFinancialAdmin);

/** The server's own Baghdad day. Never a client's: a day a client can choose is
 *  a period a client can move money into. */
const today = () => baghdadDay(Date.now());

const nowIso = () => new Date().toISOString();

// ══════════════════════════════════════════════════════ expense categories

/**
 * THE DEFAULT CATEGORIES, CREATED ONCE AS ORDINARY EDITABLE ROWS.
 *
 * They are not seeded from migration 0095, and that is deliberate: a seeded
 * INSERT is a write (`scripts/check-migrations-additive.mjs` classifies it as
 * non-additive), and re-applying the migration would resurrect a category the
 * owner had deliberately removed. Here, they are created only when the table is
 * EMPTY — so the moment the owner touches the list, this function never runs
 * again and can never undo their edits.
 *
 * The write is audited like any other admin write, so «من أضاف هذه الفئات» has
 * an answer.
 */
async function ensureDefaultCategories(c: Context<AppContext>): Promise<void> {
  const existing = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM expense_categories').first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) return;
  const admin = c.get('user')!;
  const ts = nowIso();
  // One statement per row, one batch: nine rows of eight parameters is 72
  // bound parameters, comfortably under the 100 D1 refuses — and a batch means
  // the owner never sees four of nine categories after a failure.
  const stmts = DEFAULT_EXPENSE_CATEGORIES.map((cat, i) =>
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO expense_categories (id, slug, name_ar, name_en, name_ckb, sort, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).bind(newId('exc'), cat.slug, cat.name_ar, cat.name_en, cat.name_ckb, i * 10, admin.id, ts, ts)
  );
  await c.env.DB.batch(stmts);
  await audit(c.env.DB, admin.id, 'finance.expense_category.seed', 'expense_categories', {
    created: DEFAULT_EXPENSE_CATEGORIES.length,
  });
}

const categoryPublic = (r: ExpenseCategoryRow) => ({
  id: r.id,
  slug: r.slug,
  name_ar: r.name_ar,
  name_en: r.name_en,
  name_ckb: r.name_ckb,
  sort: Number(r.sort) || 0,
  active: Number(r.active) === 1,
});

adminFinanceRoutes.get('/expense-categories', async (c) => {
  await ensureDefaultCategories(c);
  const { results } = await c.env.DB.prepare(
    'SELECT id, slug, name_ar, name_en, name_ckb, sort, active FROM expense_categories ORDER BY active DESC, sort, name_ar'
  ).all<ExpenseCategoryRow>();
  return c.json({ success: true, categories: (results ?? []).map(categoryPublic) });
});

/**
 * Create a category the owner named. The slug is derived, not asked for: a slug
 * the owner has to invent is a slug they will collide, and the derivation
 * already handles Arabic and Kurdish letters and the D1 50-byte pattern limit
 * (see `expenseSlug`).
 */
adminFinanceRoutes.post('/expense-categories', async (c) => {
  const admin = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const nameAr = str(body.name_ar, 'name_ar', { min: 1, max: 80 });
  const nameEn = body.name_en === undefined ? '' : str(body.name_en, 'name_en', { min: 0, max: 80 });
  const nameCkb = body.name_ckb === undefined ? '' : str(body.name_ckb, 'name_ckb', { min: 0, max: 80 });
  const id = newId('exc');
  const slug = expenseSlug(nameEn || nameAr, id);
  const clash = await c.env.DB.prepare('SELECT id FROM expense_categories WHERE slug = ?').bind(slug).first();
  if (clash) throw badRequest('A category with this name already exists', 'CATEGORY_EXISTS');
  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO expense_categories (id, slug, name_ar, name_en, name_ckb, sort, active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  )
    .bind(id, slug, nameAr, nameEn, nameCkb, int(body.sort, 'sort', { min: 0, max: 9999, def: 500 }), admin.id, ts, ts)
    .run();
  await audit(c.env.DB, admin.id, 'finance.expense_category.create', id, { slug, name_ar: nameAr });
  return c.json({ success: true, category: { id, slug, name_ar: nameAr, name_en: nameEn, name_ckb: nameCkb, active: true } });
});

/**
 * Rename, reorder or DEACTIVATE a category.
 *
 * There is no delete. A category is referenced by `operating_expenses` with
 * ON DELETE RESTRICT, so deleting one that has ever been used would fail at the
 * database with an opaque error — and deleting one that has not is a
 * convenience worth less than the certainty that no historical expense can lose
 * its label. Deactivating hides it from the entry form and leaves every past
 * row readable.
 */
adminFinanceRoutes.patch('/expense-categories/:id', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const row = await c.env.DB.prepare('SELECT * FROM expense_categories WHERE id = ?').bind(id).first<ExpenseCategoryRow>();
  if (!row) throw notFound('Category not found');
  const body = await c.req.json().catch(() => ({}));
  const nameAr = body.name_ar === undefined ? row.name_ar : str(body.name_ar, 'name_ar', { min: 1, max: 80 });
  const nameEn = body.name_en === undefined ? row.name_en : str(body.name_en, 'name_en', { min: 0, max: 80 });
  const nameCkb = body.name_ckb === undefined ? row.name_ckb : str(body.name_ckb, 'name_ckb', { min: 0, max: 80 });
  const sort = body.sort === undefined ? Number(row.sort) || 0 : int(body.sort, 'sort', { min: 0, max: 9999 });
  const active = body.active === undefined ? Number(row.active) : body.active ? 1 : 0;
  await c.env.DB.prepare(
    `UPDATE expense_categories SET name_ar = ?, name_en = ?, name_ckb = ?, sort = ?, active = ?, updated_at = ? WHERE id = ?`
  )
    .bind(nameAr, nameEn, nameCkb, sort, active, nowIso(), id)
    .run();
  await audit(c.env.DB, admin.id, 'finance.expense_category.update', id, {
    name_ar: nameAr,
    active,
    // The slug is NOT rewritten on a rename. It is the stable handle the panel
    // and any saved filter refer to, and a slug that moves with a typo fix
    // breaks every reference to it silently.
    slug: row.slug,
  });
  return c.json({ success: true });
});

// ══════════════════════════════════════════════════════════════ expenses

const expensePublic = (r: ExpenseRow & { category_slug?: string; category_name_ar?: string }) => ({
  id: r.id,
  category_id: r.category_id,
  category_slug: r.category_slug ?? '',
  category_name_ar: r.category_name_ar ?? '',
  amount_iqd: Number(r.amount_iqd) || 0,
  expense_day: r.expense_day,
  title: r.title ?? '',
  note: r.note ?? '',
  series_id: r.series_id ?? null,
  created_by: r.created_by ?? null,
  created_at: r.created_at,
  updated_at: r.updated_at,
  /** A voided row is still a row. The screen shows it struck through with who
   *  voided it and why — see the DELETE handler for why it is not removed. */
  voided: r.voided_at !== null && r.voided_at !== undefined,
  voided_at: r.voided_at ?? null,
  voided_by: r.voided_by ?? null,
  void_reason: r.void_reason ?? '',
});

/**
 * The ledger for a period.
 *
 * `from`/`to` are BAGHDAD CIVIL DAYS and are compared as TEXT. That works, and
 * it is the reason `expense_day` is a fixed-width zero-padded string: such a
 * date compares lexicographically in date order, so a period filter needs no
 * timezone in SQL and no `date('now')` — which is UTC, and therefore names the
 * wrong day for the first three hours of every Iraqi night
 * (worker/lib/baghdadTime.ts).
 *
 * VOIDED ROWS ARE EXCLUDED BY DEFAULT, because a report must show what was
 * actually spent. They are one query parameter away, because a ledger that
 * cannot show what was removed is a ledger nobody can audit.
 */
adminFinanceRoutes.get('/expenses', async (c) => {
  const q = c.req.query();
  const from = isDay(q.from ?? '') ? q.from! : '0000-01-01';
  const to = isDay(q.to ?? '') ? q.to! : '9999-12-31';
  const includeVoided = q.include_voided === '1' || q.include_voided === 'true';
  const categoryId = (q.category_id ?? '').trim().slice(0, 60);
  const limit = int(q.limit ?? 200, 'limit', { min: 1, max: 500, def: 200 });

  const where = ['e.expense_day >= ?', 'e.expense_day <= ?'];
  const binds: unknown[] = [from, to];
  if (!includeVoided) where.push('e.voided_at IS NULL');
  if (categoryId) {
    where.push('e.category_id = ?');
    binds.push(categoryId);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT e.*, c.slug AS category_slug, c.name_ar AS category_name_ar
       FROM operating_expenses e
       LEFT JOIN expense_categories c ON c.id = e.category_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.expense_day DESC, e.rowid DESC
      LIMIT ?`
  )
    .bind(...binds, limit)
    .all<ExpenseRow & { category_slug: string; category_name_ar: string }>();

  const rows = results ?? [];

  /**
   * TWO TOTALS, BECAUSE THIS LIST IS A PAGE AND THE PERIOD IS NOT.
   *
   * `page_total_iqd` is the sum of the rows the caller is holding, so the list
   * on screen always adds up to the figure printed under it. `total_iqd` is
   * the PERIOD's total, from one unbounded SUM over the same WHERE.
   *
   * There used to be only the first, labelled as the second. That is fine
   * until a period holds more live rows than `limit` — a 24-month repeat plus
   * ordinary entries reaches 200 inside a year — and then the ledger screen
   * quietly understates the month while the dashboard, which aggregates in SQL
   * with no limit, states it correctly. Two screens disagreeing about the same
   * month is how an owner stops trusting both, and the understated one feeds a
   * NET PROFIT they price against.
   *
   * `truncated` says outright that there are more rows than were returned, so
   * the screen can offer the rest instead of pretending the page is the period.
   */
  // THE SUM ALWAYS EXCLUDES VOIDED ROWS, even when the list is showing them.
  // `include_voided` widens what is DISPLAYED; it must never widen what is
  // COUNTED, because a voided expense is money the owner decided was not
  // spent. Reusing the list's own WHERE would have made «أظهر الملغاة» quietly
  // add 600,000 of cancelled rent to the period total — a checkbox that
  // changes a financial figure is the worst kind of control.
  const totalWhere = includeVoided ? [...where, 'e.voided_at IS NULL'] : where;
  const totalRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(e.amount_iqd), 0) AS total FROM operating_expenses e WHERE ${totalWhere.join(' AND ')}`
  )
    .bind(...binds)
    .first<{ total: number }>();
  // The row COUNT is about the list, so it uses the list's own filter — it is
  // what `truncated` compares against, and comparing a live count to a page
  // that includes voided rows would report a truncation that is not there.
  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM operating_expenses e WHERE ${where.join(' AND ')}`
  )
    .bind(...binds)
    .first<{ n: number }>();
  const periodCount = Number(countRow?.n ?? 0) || 0;

  return c.json({
    success: true,
    from,
    to,
    expenses: rows.map(expensePublic),
    total_iqd: Number(totalRow?.total ?? 0) || 0,
    page_total_iqd: rows.reduce((n, r) => (r.voided_at ? n : n + (Number(r.amount_iqd) || 0)), 0),
    count: periodCount,
    limit,
    truncated: periodCount > rows.length,
  });
});

/**
 * Record an expense, optionally repeating it monthly.
 *
 * `repeat_months` WRITES REAL ROWS, NOW. It is not a recurrence rule and
 * nothing generates rows later. The argument is in
 * worker/lib/financeLedger.ts (`expenseSeriesDays`) and it is short: a rule
 * evaluated at report time makes last January's profit depend on this June's
 * edit, which is the same silent rewriting of history that the cost snapshot in
 * migration 0095 exists to abolish. Twelve visible rows can each be corrected;
 * a rule can only be corrected everywhere at once.
 */
adminFinanceRoutes.post('/expenses', async (c) => {
  const admin = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const categoryId = str(body.category_id, 'category_id', { min: 1, max: 60 });
  const category = await c.env.DB.prepare('SELECT id, active FROM expense_categories WHERE id = ?')
    .bind(categoryId)
    .first<{ id: string; active: number }>();
  if (!category) throw badRequest('Unknown expense category', 'CATEGORY_UNKNOWN');
  // A DEACTIVATED CATEGORY STILL ACCEPTS A BACKDATED ROW. Deactivation says
  // "stop offering this going forward", not "this never happened" — and the
  // owner entering three months of arrears for a shop they have since closed is
  // the exact case that would otherwise be refused with no way forward.
  const amount = validateExpenseAmount(body.amount_iqd);
  const day = validateExpenseDay(body.expense_day, today());
  const title = body.title === undefined ? '' : str(body.title, 'title', { min: 0, max: 120 });
  const note = body.note === undefined ? '' : str(body.note, 'note', { min: 0, max: 1000 });
  const repeat = body.repeat_months === undefined ? 1 : int(body.repeat_months, 'repeat_months', { min: 1, max: MAX_EXPENSE_REPEAT });

  const days = expenseSeriesDays(day, repeat);
  if (days.length === 0) throw badRequest('expense_day could not be read as a calendar day', 'EXPENSE_DAY_INVALID');
  // A series id only when there IS a series: a lone row that carried one would
  // make the panel offer to "show the other months" of a group of one.
  const seriesId = days.length > 1 ? newId('exs') : null;
  const ts = nowIso();
  const ids = days.map(() => newId('exp'));

  /**
   * ONE STATEMENT PER ROW, ALL IN ONE BATCH — never one multi-row VALUES.
   * D1 REFUSES more than 100 bound parameters in a single statement; at eleven
   * parameters a row, a twenty-four-month repeat as one statement would bind
   * 264 and be refused outright, on the owner's biggest and most useful entry.
   * Separate statements each bind eleven, and the batch is still atomic: twelve
   * months of rent land together or not at all.
   */
  await c.env.DB.batch(
    days.map((d, i) =>
      c.env.DB.prepare(
        `INSERT INTO operating_expenses
           (id, category_id, amount_iqd, expense_day, title, note, series_id, created_by, created_at, updated_at, void_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`
      ).bind(ids[i], categoryId, amount, d, title, note, seriesId, admin.id, ts, ts)
    )
  );
  await audit(c.env.DB, admin.id, 'finance.expense.create', ids[0], {
    category_id: categoryId,
    amount_iqd: amount,
    expense_day: day,
    months: days.length,
    series_id: seriesId,
    ids,
  });
  return c.json({ success: true, ids, series_id: seriesId, days });
});

/**
 * Correct one expense.
 *
 * The amount, the day, the category and the text may all be corrected, because
 * every one of them is something a human types and therefore something a human
 * mistypes — and an uncorrectable wrong number is a number the owner works
 * around by adding a second row, which is worse.
 *
 * The audit detail carries BOTH the old and the new values. A reported net
 * profit that changed between two readings must be explainable, and "the rent
 * row moved from March to January" is only an explanation if the old value is
 * written down somewhere.
 */
adminFinanceRoutes.patch('/expenses/:id', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const row = await c.env.DB.prepare('SELECT * FROM operating_expenses WHERE id = ?').bind(id).first<ExpenseRow>();
  if (!row) throw notFound('Expense not found');
  if (row.voided_at) throw badRequest('This expense is voided — restore it before editing', 'EXPENSE_VOIDED');
  const body = await c.req.json().catch(() => ({}));

  const categoryId = body.category_id === undefined ? row.category_id : str(body.category_id, 'category_id', { min: 1, max: 60 });
  if (categoryId !== row.category_id) {
    const exists = await c.env.DB.prepare('SELECT id FROM expense_categories WHERE id = ?').bind(categoryId).first();
    if (!exists) throw badRequest('Unknown expense category', 'CATEGORY_UNKNOWN');
  }
  const amount = body.amount_iqd === undefined ? Number(row.amount_iqd) : validateExpenseAmount(body.amount_iqd);
  const day = body.expense_day === undefined ? row.expense_day : validateExpenseDay(body.expense_day, today());
  const title = body.title === undefined ? row.title : str(body.title, 'title', { min: 0, max: 120 });
  const note = body.note === undefined ? row.note : str(body.note, 'note', { min: 0, max: 1000 });

  await c.env.DB.prepare(
    `UPDATE operating_expenses
        SET category_id = ?, amount_iqd = ?, expense_day = ?, title = ?, note = ?, updated_at = ?
      WHERE id = ? AND voided_at IS NULL`
  )
    .bind(categoryId, amount, day, title, note, nowIso(), id)
    .run();
  await audit(c.env.DB, admin.id, 'finance.expense.update', id, {
    before: { category_id: row.category_id, amount_iqd: Number(row.amount_iqd), expense_day: row.expense_day },
    after: { category_id: categoryId, amount_iqd: amount, expense_day: day },
  });
  return c.json({ success: true });
});

/**
 * REMOVE AN EXPENSE — AS A VOID, NEVER AS A DELETE.
 *
 * A deleted expense changes a NET PROFIT the owner may already have acted on: a
 * price they set, a salary they approved, a purchase they signed off. If the
 * row disappears, the number changes, nothing anywhere says why, and the report
 * the decision was made from can never be reproduced.
 *
 * So the row stays and gains `voided_at`, `voided_by` and a reason. Reports
 * read `voided_at IS NULL`; the ledger screen can show the voided rows struck
 * through, with who removed them and when. This is the same choice migration
 * 0081 made for cancelled-order retention: in a financial table, forgetting is
 * a defect, not tidiness.
 *
 * VOIDING IS IDEMPOTENT — `AND voided_at IS NULL` in the UPDATE — so a double
 * click cannot rewrite the first void's author and timestamp with the second
 * click's, which would put the wrong name against the removal in the audit.
 */
adminFinanceRoutes.delete('/expenses/:id', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const row = await c.env.DB.prepare('SELECT * FROM operating_expenses WHERE id = ?').bind(id).first<ExpenseRow>();
  if (!row) throw notFound('Expense not found');
  const reason = str(c.req.query('reason') ?? '', 'reason', { min: 0, max: 300 });
  const ts = nowIso();
  const res = await c.env.DB.prepare(
    `UPDATE operating_expenses SET voided_at = ?, voided_by = ?, void_reason = ?, updated_at = ?
      WHERE id = ? AND voided_at IS NULL`
  )
    .bind(ts, admin.id, reason, ts, id)
    .run();
  /**
   * THE AUDIT FOLLOWS THE UPDATE, IT DOES NOT ASSUME IT.
   *
   * The `AND voided_at IS NULL` fence above makes a second click a no-op, which
   * is the point — it cannot overwrite the first void's author. But the audit
   * call used to run regardless, so that second click wrote a second void
   * record naming a second admin against a row that still records the first.
   * The audit trail is the only place a changed net profit can be explained,
   * and two voids for one voided row makes that reconstruction ambiguous: the
   * reader cannot tell which name belongs to the removal. No rows changed means
   * nothing happened, and nothing happened is not an entry.
   */
  if ((res.meta?.changes ?? 0) > 0) {
    await audit(c.env.DB, admin.id, 'finance.expense.void', id, {
      amount_iqd: Number(row.amount_iqd),
      expense_day: row.expense_day,
      reason,
    });
  }
  return c.json({ success: true, voided: (res.meta?.changes ?? 0) > 0 });
});

/** The other half of a void: an expense removed by mistake comes back, with the
 *  restore audited too. Without this, the only way to undo a misclick is a
 *  second row on a different day, which is a worse lie than the first. */
adminFinanceRoutes.post('/expenses/:id/restore', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const row = await c.env.DB.prepare('SELECT * FROM operating_expenses WHERE id = ?').bind(id).first<ExpenseRow>();
  if (!row) throw notFound('Expense not found');
  const res = await c.env.DB.prepare(
    `UPDATE operating_expenses SET voided_at = NULL, voided_by = NULL, void_reason = '', updated_at = ?
      WHERE id = ? AND voided_at IS NOT NULL`
  )
    .bind(nowIso(), id)
    .run();
  // The mirror of the void's rule: a restore that restored nothing is not an
  // entry either. A trail showing a restore against a row that was never
  // voided is a trail that cannot be read back as a sequence of facts.
  if ((res.meta?.changes ?? 0) > 0) {
    await audit(c.env.DB, admin.id, 'finance.expense.restore', id, {
      amount_iqd: Number(row.amount_iqd),
      expense_day: row.expense_day,
    });
  }
  return c.json({ success: true, restored: (res.meta?.changes ?? 0) > 0 });
});
