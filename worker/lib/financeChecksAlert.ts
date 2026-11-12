/**
 * THE DAILY CHECK OF THE BOOKS, SAID TO THE ADMIN GROUP (the owner's brief, 2026-11-12, part 4: «automated consistency
 * checks»).
 *
 * Once a Baghdad day, from ALERT_FROM_HOUR, the quarter-hour jobs (jobs.ts) run financeChecks.ts. When something is found,
 * the admin group's general topic is told WHAT and HOW MANY — never an amount: a cost is the owner's alone (owner decision
 * 2) and the group may hold assistants; the page the message links to is the owner's (requireCostRead).
 *
 * WHEN IT SPEAKS. A fault (an 'error' check) is said every day it stands — a fault is never quietly accepted. What only
 * needs a look (a 'warning') is said when what is found changes, not every morning: an order the owner chose to leave
 * walked back would otherwise be a daily nag. A day that finds nothing after a day that found something says so once,
 * because an alarm that only ever fires leaves the reader unsure the fault was fixed — schemaDriftAlarm.ts's rhythm, and
 * its state is an `ops:` row of admin_settings for the same reasons (operator state, never a SettingKey).
 *
 * The send failing still records the day: a down Telegram or an unbound group would otherwise retry every fifteen minutes.
 * The next day is the retry.
 */
import type { Env } from './types';
import { baghdadDay } from './baghdadTime';
import { announceToAdmins } from './adminTopicRouting';
import { runFinanceChecks, type FinanceCheckKey, type FinanceChecksReport } from './financeChecks';

/** Not a SettingKey: operator bookkeeping, like ops:schema_drift_alert. */
export const FINANCE_CHECKS_STATE_KEY = 'ops:finance_checks_alert';

/** Nine in the morning, Baghdad: the day's deliveries of the night before are in, and someone is awake to read it. */
export const ALERT_FROM_HOUR = 9;

export interface FinanceChecksAlertState {
  /** The Baghdad day the checks last ran. */
  day: string;
  /** What that run found, `key:count` joined, '' for nothing. */
  signature: string;
  /** Whether any of it was a fault. */
  errors: boolean;
}

export interface FinanceChecksAlarmReport {
  ran: boolean;
  sent: 'found' | 'repeat' | 'clear' | null;
  signature: string;
  error?: string;
}

/** The group's words for each check: what it found, never how much money. */
export const CHECK_WORDS: Record<FinanceCheckKey, string> = {
  journal_unbalanced: 'قيود مدينها لا يساوي دائنها',
  posting_errors: 'أخطاء ترحيل تنتظر الإعادة',
  collections_over_due: 'طلبات سُجّل عليها تحصيل أكثر من المستحق',
  undated_delivered: 'طلبات مسلَّمة بلا تاريخ تسليم صالح',
  staff_payment_overallocated: 'دفعات موظفين وُزّع منها أكثر من مبلغها',
  delivered_without_sale: 'طلبات مسلَّمة لم يصل بيعها إلى القيود',
  cancelled_after_delivery_in_journal: 'طلبات أُلغيت بعد التسليم وما زال بيعها في القيود',
  walk_backs: 'طلبات أُرجعت من «تم التوصيل» ولم تُلغَ',
  cash_on_cancelled: 'طلبات ملغاة عليها تحصيل مسجَّل',
  pending_cost_months: 'أشهر لا تُغلق لأن تكاليف فيها معلّقة',
  expenses_counting_nowhere: 'مصاريف مربوطة بطلبات لا يُحتسب فيها شيء',
};

const baghdadHour = (now: Date) => new Date(now.getTime() + 3 * 3600_000).getUTCHours();
const link = (env: Env) => {
  const origin = String(env.APP_ORIGIN ?? '').trim().replace(/\/+$/, '');
  return origin ? `\n${origin}/admin?tab=finance&finance=accounting` : '';
};

export function foundMessage(report: FinanceChecksReport, env: Env): string {
  const found = report.checks.filter((c) => c.count > 0);
  const lines = found.map((c) => `${c.severity === 'error' ? '⛔' : '•'} ${CHECK_WORDS[c.key]}: ${c.count.toLocaleString('en-US')}`);
  const faults = found.some((c) => c.severity === 'error');
  return [
    faults ? '⛔ فحص الحسابات اليومي: في الدفاتر ما يجب إصلاحه' : '🔎 فحص الحسابات اليومي: ما يحتاج نظرتك',
    ...lines,
    `التفاصيل في «المال والأرباح» ← المحاسبة.${link(env)}`,
  ].join('\n');
}

export function clearMessage(env: Env): string {
  return `✅ فحص الحسابات اليومي: لم يجد اليوم شيئًا مما وجده من قبل.${link(env)}`;
}

function parse(value: string | undefined): FinanceChecksAlertState | null {
  if (!value) return null;
  try {
    const s = JSON.parse(value) as Partial<FinanceChecksAlertState>;
    return { day: typeof s.day === 'string' ? s.day : '', signature: typeof s.signature === 'string' ? s.signature : '', errors: s.errors === true };
  } catch {
    return null;
  }
}

export async function dailyFinanceChecks(env: Env, now = new Date()): Promise<FinanceChecksAlarmReport> {
  const today = baghdadDay(now.getTime());
  const stored = parse(
    (await env.DB.prepare('SELECT value FROM admin_settings WHERE key = ?').bind(FINANCE_CHECKS_STATE_KEY).first<{ value: string }>())?.value
  );
  if (stored?.day === today || baghdadHour(now) < ALERT_FROM_HOUR) return { ran: false, sent: null, signature: stored?.signature ?? '' };

  const report = await runFinanceChecks(env.DB, now);
  const found = report.checks.filter((c) => c.count > 0);
  const signature = found.map((c) => `${c.key}:${c.count}`).join(',');
  const errors = found.some((c) => c.severity === 'error');
  const out: FinanceChecksAlarmReport = { ran: true, sent: null, signature };

  if (!signature) {
    if (stored?.signature) out.sent = 'clear';
  } else if (errors || signature !== stored?.signature) {
    out.sent = stored?.signature === signature ? 'repeat' : 'found';
  }
  if (out.sent) {
    const sent = await announceToAdmins(env, 'general', out.sent === 'clear' ? clearMessage(env) : foundMessage(report, env));
    if (!sent.ok) out.error = sent.reason;
  }
  const state: FinanceChecksAlertState = { day: today, signature, errors };
  await env.DB.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(FINANCE_CHECKS_STATE_KEY, JSON.stringify(state))
    .run();
  return out;
}
