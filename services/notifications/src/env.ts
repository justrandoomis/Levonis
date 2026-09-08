/**
 * `levonis-notifications` bindings, vars and secret NAMES.
 *
 * Every transport credential is optional, and each is read in exactly one
 * place — the transport's own `configured(env)`. Nothing else in this service
 * looks at one, and no value ever reaches a log line, an outbox row or an
 * error message. The bot token is the sharpest case: it is the only credential
 * that appears in a URL path, which is why nothing here logs a request URL.
 */
import type { EdgeEnv } from '@levonis/platform-kit/edge/types';

export interface NotificationsVars {
  /** the master switch for OUTBOUND delivery; fails closed — only the exact string `on` sends */
  NOTIFY_DELIVERY?: string;
  /** the staging guard carried over verbatim from `worker/lib/outbox.ts`; empty = no allowlist */
  EMAIL_ALLOWED_RECIPIENTS?: string;
  /**
   * `on` flips the meaning of an EMPTY `EMAIL_ALLOWED_RECIPIENTS` from "mail
   * anyone" to "mail nobody". The dark stack ships it `on`: a dark run must not
   * be able to reach a real customer, and an unset allowlist there is a
   * misconfiguration, not permission.
   */
  EMAIL_ALLOWLIST_REQUIRED?: string;
  EMAIL_FROM?: string;
  APP_ORIGIN?: string;
  /** off | log | on — the inbound gateway-hop check */
  GATEWAY_ONLY?: string;
  /** throw | log — the owned-tables guard (ADR-003) */
  OWNERSHIP_GUARD?: string;
  ALLOWED_CALLER_KIDS?: string;
  /** dark/test only: accept the committed fixtures' `sig: 'fixture'` marker */
  ACCEPT_FIXTURE_SIG?: string;
  /**
   * How long the SETTLED delivery log and the Telegram dedup set are kept
   * (`03-EVENTS.md` §5 rule 6). `notify_outbox` and `user_notifications` are
   * never rolled: the first IS the "one delivery per key, forever" guarantee,
   * the second is a customer's inbox.
   */
  NOTIFY_RETENTION_DAYS?: string;
  SVC_VERSION?: string;
}

export interface NotificationsSecrets {
  EMAIL_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ADMIN_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  NOTIFICATIONS_SIGNING_KEY?: string;
  HEALTH_PROBE_TOKEN?: string;
}

export type Env = EdgeEnv &
  NotificationsVars &
  NotificationsSecrets & {
    /** the service's OWN database — never the shared core D1 */
    DB: D1Database;
  };

export const versionOf = (env: NotificationsVars): string => (env.SVC_VERSION || '').trim() || 'dev';

/** True when the var is exactly `on`. An unset, misspelt or empty var is never "on". */
export const isOn = (v: string | undefined): boolean => (v ?? '').trim().toLowerCase() === 'on';

/** The retention window in days: a positive integer, defaulting to 30, capped at 400. */
export const retentionDays = (env: NotificationsVars): number => {
  const n = Number.parseInt((env.NOTIFY_RETENTION_DAYS ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 400) : 30;
};

/** A credential counts as present only when it is a non-empty string after trimming. */
export const has = (v: string | undefined): boolean => typeof v === 'string' && v.trim().length > 0;
