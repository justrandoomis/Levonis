/**
 * THE ALARM FOR THE ONE FAULT THAT HAS TAKEN THIS SITE DOWN TWICE.
 *
 * Code and schema are deployed by two different mechanisms here. A push to the
 * live branch redeploys the Worker on its own; the migrations do NOT follow it
 * — they are applied by a GitHub workflow. So between the two there is a window
 * in which the running code reads tables the database does not have, and the
 * symptom is not a warning anywhere: it is a 500 on whatever page happens to
 * touch the newest table. That is exactly how «لوحة الادارة لا تعمل» started,
 * and before it «الصفحة الرئيسية لا تعمل» — the same fault, months apart, both
 * found by the owner looking at a broken screen.
 *
 * `.github/workflows/auto-migrate-on-push.yml` now closes the window by
 * applying migrations automatically. THIS FILE EXISTS FOR WHEN THAT FAILS,
 * which is the only case the automation cannot cover: a workflow that errors,
 * is rate-limited, is disabled, or never fires leaves no trace on any screen
 * the owner looks at. An automation with no alarm is an automation you find out
 * about from a customer.
 *
 * ---------------------------------------------------------------------------
 * WHY IT LIVES IN THE WORKER AND NOT IN CI.
 *
 * A scheduled GitHub job could poll `/api/health` just as well, but it would
 * need the bot token and the owner's Telegram id as CI secrets — and the
 * owner's ruling stands: «رقم من هذا النوع هو مفتاح صلاحية مالية ولا يجوز أن
 * يُشحن داخل البرنامج». The Worker already holds the admin bot and already
 * knows the bound group and its topics, so the alarm reuses the exact path
 * every other admin notification takes and introduces no new secret anywhere.
 *
 * It also makes the alarm INDEPENDENT of GitHub. A CI outage would take the
 * migration workflow and its watchdog down together, which is the one
 * correlation an alarm must not have.
 *
 * ---------------------------------------------------------------------------
 * IT DOES NOT SHOUT, AND IT SAYS WHEN IT IS OVER.
 *
 * The cron ticks every fifteen minutes. Alerting on every tick would train the
 * owner to swipe the notification away, which is worse than not sending it. So
 * one message per distinct drift SIGNATURE, repeated at most once a day while
 * the drift persists, and one RECOVERED message when it clears — because an
 * alarm that only ever fires leaves the reader unsure whether they fixed it.
 *
 * THE DE-DUPLICATION STATE IS IN `admin_settings`, DELIBERATELY. That table has
 * existed since migration 0001, and `d1_migrations` is D1's own — so both of
 * this alarm's reads are guaranteed present in precisely the situation it
 * reports. A watchdog whose own bookkeeping lives in a table a pending
 * migration was going to create is a watchdog that is silent exactly when it
 * is needed. The key is namespaced `ops:` so it can never collide with a
 * SettingKey — it is operator state, not a setting the owner configures, and
 * it is not served by the settings routes, which read a fixed list.
 *
 * TO BE EXACT ABOUT THE LIMIT: the SEND still needs the admin-bot tables
 * (`telegram_admin_config`, `telegram_admin_topics`, migration 0080). Real
 * drift is one or two migrations, so those are present, and
 * tests/schemaDriftAlarm.test.ts proves it against a database stopped at 0083.
 * A database behind by eighty migrations has no notification channel at all —
 * and no working site either, which is its own alarm.
 */
import type { Env } from './types';
import { readSchemaStatus, type SchemaStatus } from './schemaVersion';
import { announceToAdmins } from './adminTopicRouting';

/** Not a SettingKey. See the header: `ops:` marks operator bookkeeping. */
export const DRIFT_STATE_KEY = 'ops:schema_drift_alert';

/** A drift that is still there a day later is worth saying again — once. */
export const REPEAT_AFTER_MS = 24 * 60 * 60 * 1000;

export interface DriftAlertState {
  /** The drift this alarm last reported, or '' after a recovery. */
  signature: string;
  /** When that message was sent, ISO. */
  notified_at: string;
}

export interface DriftAlarmReport {
  state: SchemaStatus['state'];
  behind: number;
  /** null when nothing was sent, which is the ordinary outcome. */
  sent: 'drift' | 'repeat' | 'recovered' | null;
  /** Set when the message could not be delivered; never thrown. */
  error?: string;
}

/**
 * What makes two drifts "the same". Both readings are in it because they fail
 * independently — `readSchemaStatus` reports behind on the newest NAME or on
 * the COUNT, and a hole in the middle moves only the second.
 */
export function driftSignature(status: SchemaStatus): string {
  return `${status.state}:${status.expected}:${status.applied ?? '-'}:${status.applied_count}/${status.expected_count}`;
}

function parseState(raw: unknown): DriftAlertState | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const v = JSON.parse(raw) as Partial<DriftAlertState>;
    if (typeof v?.signature !== 'string' || typeof v?.notified_at !== 'string') return null;
    return { signature: v.signature, notified_at: v.notified_at };
  } catch {
    return null;
  }
}

/**
 * The message. Arabic, because the person woken by it reads Arabic, and it
 * names the REMEDY rather than only the fault — an alarm that leaves the reader
 * to go and look up what to do costs them the minutes it was meant to save.
 */
export function driftMessage(status: SchemaStatus, repeat: boolean): string {
  const head = repeat
    ? '⚠️ قاعدة البيانات ما زالت متأخرة عن الكود'
    : '⚠️ قاعدة البيانات متأخرة عن الكود';
  return [
    head,
    '',
    `الكود يتوقع: ${status.expected}`,
    `المطبَّق فعلًا: ${status.applied ?? 'لا شيء'}`,
    `العدد: ${status.applied_count} من ${status.expected_count} (ناقص ${status.behind})`,
    '',
    'المعنى: الموقع يشتغل بكود يقرأ جداول غير موجودة، وأي صفحة تلمس أحدث جدول سترد 500.',
    '',
    'الإصلاح: شغّل workflow «6 - Repair Staging Database (migrations only)» من GitHub Actions،',
    'أو تأكد لماذا لم يعمل التطبيق التلقائي عند آخر دفع.',
  ].join('\n');
}

export function recoveredMessage(status: SchemaStatus): string {
  return [
    '✅ قاعدة البيانات لحقت الكود',
    '',
    `المطبَّق الآن: ${status.applied ?? '-'} (${status.applied_count} من ${status.expected_count})`,
  ].join('\n');
}

/**
 * Read the drift, decide whether it is worth a message, send at most one.
 *
 * NEVER THROWS — it is a cron step, and the caller's `step()` would only turn
 * a throw into a logged error anyway. Returning the reason instead means the
 * durable-jobs report can carry it, which is where an operator looks.
 *
 * `ahead` and `unknown` are deliberately NOT alerted. `ahead` is the ordinary
 * state during a rollback and `unknown` is a database not built by
 * `migrations apply` at all — neither is the fault this watches for, and an
 * alarm that fires on states nobody can act on is an alarm that gets muted.
 */
export async function checkSchemaDrift(env: Env): Promise<DriftAlarmReport> {
  const status = await readSchemaStatus(env.DB);
  const report: DriftAlarmReport = { state: status.state, behind: status.behind, sent: null };

  const stored = parseState(
    (
      await env.DB.prepare('SELECT value FROM admin_settings WHERE key = ?')
        .bind(DRIFT_STATE_KEY)
        .first<{ value: string }>()
    )?.value
  );

  if (status.state !== 'behind') {
    // Only speak if we spoke before. A site that has never drifted must not
    // receive a "recovered" message on the first tick after a deploy.
    if (status.state === 'current' && stored && stored.signature !== '') {
      report.sent = 'recovered';
      const out = await announceToAdmins(env, 'general', recoveredMessage(status));
      if (!out.ok) report.error = out.reason;
      await writeState(env, { signature: '', notified_at: new Date().toISOString() });
    }
    return report;
  }

  const signature = driftSignature(status);
  const sameAsLast = stored?.signature === signature;
  const age = stored ? Date.now() - Date.parse(stored.notified_at) : Number.POSITIVE_INFINITY;
  // `Number.isNaN(age)` guards a stored timestamp that will not parse: treat it
  // as old rather than as "just sent", so a corrupt row cannot silence the alarm.
  if (sameAsLast && !Number.isNaN(age) && age < REPEAT_AFTER_MS) return report;

  report.sent = sameAsLast ? 'repeat' : 'drift';
  const out = await announceToAdmins(env, 'general', driftMessage(status, sameAsLast));
  if (!out.ok) report.error = out.reason;
  // The state is written whether or not the SEND succeeded, and that is
  // deliberate: an unbound group or a down Telegram would otherwise make this
  // retry every fifteen minutes for ever. The daily repeat is the retry.
  await writeState(env, { signature, notified_at: new Date().toISOString() });
  return report;
}

async function writeState(env: Env, state: DriftAlertState): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO admin_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(DRIFT_STATE_KEY, JSON.stringify(state))
    .run();
}
