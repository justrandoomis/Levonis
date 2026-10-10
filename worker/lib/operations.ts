import { HttpError, badRequest, conflict, forbidden, unavailable } from './http';
import { canViewCost, canWriteCost, isOwner } from './adminScope';
import { costRefusal } from './costAccess';
import type { Env, SessionUser } from './types';
import { newId } from './crypto';

export type Capability =
  | 'purchase'
  | 'receive'
  | 'count'
  | 'transfer'
  | 'rules'
  | 'pay'
  | 'accounting'
  | 'close';
export const baghdadDay = (at = new Date()) =>
  new Date(at.getTime() + 3 * 3600000).toISOString().slice(0, 10);
export const dateValue = (value: unknown, fallback?: string): string => {
  const v = typeof value === 'string' ? value : fallback;
  if (
    !v ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    !Number.isFinite(Date.parse(`${v}T00:00:00Z`)) ||
    new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v
  )
    throw badRequest('تاريخ غير صحيح', 'BAD_DATE');
  return v;
};
export const whole = (value: unknown, label: string, min = 0, max = 1e12) => {
  const n = Number(value);
  if (value === null || value === '' || value === undefined || !Number.isSafeInteger(n) || n < min || n > max)
    throw badRequest(`${label}: أدخل عددًا صحيحًا`, 'BAD_NUMBER');
  return n;
};
export const decimal = (value: unknown, label: string, min = 0) => {
  const n = Number(value);
  if (value === null || value === '' || value === undefined || !Number.isFinite(n) || n < min || n > 1e9)
    throw badRequest(`${label}: قيمة غير صحيحة`, 'BAD_NUMBER');
  return n;
};
export async function operationsInstalled(db: D1Database) {
  return !!(await db
    .prepare("SELECT 1 AS yes FROM sqlite_master WHERE type='table' AND name='purchase_orders'")
    .first());
}
export async function requireCapability(
  env: Env,
  user: SessionUser,
  capability: Capability,
  /** The refusal an operations capability answers with when `allowed = 0` (default: the generic FORBIDDEN). */
  refusal: () => HttpError = () => forbidden('ليس لديك صلاحية لهذه العملية'),
) {
  if (!(await operationsInstalled(env.DB)))
    throw unavailable(
      'تحديث عمليات المخزون والمالية لم يطبق على قاعدة البيانات بعد',
      'OPERATIONS_NOT_CONFIGURED',
    );
  /**
   * THE FINANCIAL CAPABILITIES ARE COST (owner decision 2). Purchasing,
   * compensation rules, payroll, accounting and period close all read or
   * write cost, so they need cost access — the owner — before any permission
   * row is consulted. For a non-owner (a grantee, once delegation exists) a
   * financial capability is DENY BY DEFAULT: a missing row is a refusal, the
   * opposite of the operations rule below. `purchase` writes cost, so it
   * needs cost write as well.
   */
  if (FINANCIAL_CAPABILITIES.includes(capability)) {
    if (!canViewCost(env, user) || (capability === 'purchase' && !canWriteCost(env, user))) throw costRefusal(env, user);
    if (isOwner(env, user)) return;
    const row = await env.DB.prepare('SELECT allowed FROM ops_permissions WHERE user_id=? AND capability=?')
      .bind(user.id, capability)
      .first<{ allowed: number }>();
    if (row?.allowed !== 1) throw costRefusal(env, user);
    return;
  }
  if (isOwner(env, user)) return;
  // Operations (receive, count, transfer): unchanged — a missing row allows.
  const permission = await env.DB.prepare(
    'SELECT allowed FROM ops_permissions WHERE user_id=? AND capability=?',
  )
    .bind(user.id, capability)
    .first<{ allowed: number }>();
  if (permission?.allowed === 0) throw refusal();
}

/**
 * ADDING A SERIAL (owner decision 1, 2026-10-09; DECISIONS row 192). Every
 * admin door that adds a serial or rewrites a binding — the preparation scan,
 * change and unlink, the inventory's commit, scan and link-EAN, the
 * post-delivery assign, and a warranty replacement that names a new serial —
 * follows the `receive` operations capability, as the preparation doors
 * already did: the owner always passes, a missing row allows, `allowed = 0`
 * refuses. No new capability value (the CHECK of migration 0162 cannot be
 * widened additively). Sensitive edits and exceptions keep their own gates.
 *
 * The refusal has its own code, `SERIAL_WRITE_NOT_ALLOWED`, which every
 * serial screen renders in the admin's language (src/lib/refusalStrings.ts):
 * the generic FORBIDDEN carried one Arabic sentence and the inventory panel
 * could only say "try again" — a retry that can never succeed.
 */
export const SERIAL_WRITE_NOT_ALLOWED_TEXT =
  'إضافة الأرقام التسلسلية وتغييرها وإزالتها تحتاج صلاحية «الاستلام»، وهي موقوفة لحسابك — اطلبها من المالك.';
export async function requireSerialWrite(env: Env, user: SessionUser | null | undefined) {
  // Every caller sits behind requireAdmin; this is the door's own floor.
  if (!user || user.role !== 'admin') throw forbidden();
  await requireCapability(env, user, 'receive', () => new HttpError(403, SERIAL_WRITE_NOT_ALLOWED_TEXT, 'SERIAL_WRITE_NOT_ALLOWED'));
}

/** The capabilities that read or write cost: owner only (decision 2). */
export const FINANCIAL_CAPABILITIES: readonly Capability[] = ['purchase', 'rules', 'pay', 'accounting', 'close'];
export function fence(db: D1Database, sqlCondition: string, args: unknown[] = []): D1PreparedStatement[] {
  const id = newId('guard');
  return [
    db
      .prepare(`INSERT INTO ops_guards(id,ok) SELECT ?, CASE WHEN ${sqlCondition} THEN 1 ELSE 0 END`)
      .bind(id, ...args),
    db.prepare('DELETE FROM ops_guards WHERE id=?').bind(id),
  ];
}
/** `fence` refused its batch (ops_guards' CHECK ok=1): someone wrote between the read and the write. */
export const isFenceMiss = (e: unknown): boolean =>
  /CHECK constraint failed:\s*ok\s*=\s*1\b/i.test(e instanceof Error ? e.message : String(e));
/** Integer largest remainder. Money never disappears into rounded unit prices. */
export function allocateExact(total: number, weights: number[]): number[] {
  whole(total, 'total');
  if (!weights.length || weights.some((w) => !Number.isFinite(w) || w < 0))
    throw badRequest('أساس توزيع التكلفة غير صحيح', 'BAD_ALLOCATION');
  const scaled = weights.map((w) => BigInt(Math.round(w * 1000)));
  const sum = scaled.reduce((a, b) => a + b, 0n);
  if (sum === 0n) {
    if (total === 0) return weights.map(() => 0);
    throw badRequest('أدخل الوزن أو الحجم لجميع البنود قبل توزيع التكلفة', 'ALLOCATION_BASIS_MISSING');
  }
  const shares = scaled.map((w) => Number((BigInt(total) * w) / sum));
  const ranked = scaled
    .map((w, i) => ({ i, rem: (BigInt(total) * w) % sum }))
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  let left = total - shares.reduce((a, b) => a + b, 0);
  for (const r of ranked) {
    if (left-- <= 0) break;
    shares[r.i]++;
  }
  return shares;
}
export async function periodOpen(db: D1Database, day: string) {
  if (await db.prepare('SELECT month FROM accounting_periods WHERE month=?').bind(day.slice(0, 7)).first())
    throw conflict('الفترة المحاسبية مغلقة؛ سجّل التصحيح في فترة مفتوحة', 'PERIOD_CLOSED');
}
export type JournalLine = { account: string; debit?: number; credit?: number };
export function journalPlan(
  db: D1Database,
  input: {
    key: string;
    day: string;
    title: string;
    source: string;
    sourceId: string;
    actor?: string | null;
    reversalOf?: string | null;
  },
  lines: JournalLine[],
) {
  const active = lines.filter((l) => (l.debit ?? 0) + (l.credit ?? 0) > 0);
  const balance = active.reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0);
  if (
    balance !== 0 ||
    active.length < 2 ||
    active.some(
      (l) =>
        !Number.isSafeInteger((l.debit ?? 0) + (l.credit ?? 0)) ||
        (l.debit ?? 0) < 0 ||
        (l.credit ?? 0) < 0 ||
        ((l.debit ?? 0) > 0 && (l.credit ?? 0) > 0),
    )
  )
    throw badRequest('القيد المحاسبي غير متوازن', 'UNBALANCED_JOURNAL');
  const id = newId('je');
  return {
    id,
    statements: [
      db
        .prepare(
          `INSERT INTO accounting_entries(id,event_key,entry_day,title,source_type,source_id,actor_id,reversal_of,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          id,
          input.key,
          input.day,
          input.title,
          input.source,
          input.sourceId,
          input.actor ?? null,
          input.reversalOf ?? null,
          new Date().toISOString(),
        ),
      ...active.map((l) =>
        db
          .prepare(
            'INSERT INTO accounting_lines(id,entry_id,account_code,debit_iqd,credit_iqd) VALUES (?,?,?,?,?)',
          )
          .bind(newId('jl'), id, l.account, l.debit ?? 0, l.credit ?? 0),
      ),
      db.prepare("UPDATE accounting_entries SET state='posted' WHERE id=?").bind(id),
    ],
  };
}
