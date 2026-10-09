/**
 * THE CRON STRINGS scheduled() KNOWS, AND THE JOB SET EACH ONE RUNS (FX plan
 * F13). worker/index.ts asks `cronJobs(event.cron)`; a string this table does
 * not hold EXACTLY runs nothing.
 *
 * Why exact, and why a table: cron triggers are Worker settings, not part of a
 * version. After a dashboard rollback or `wrangler rollback` the triggers of
 * the NEWER commit stay, so the Worker that answers them may not know one of
 * them. Before this rule every string that was not the minute fell into the
 * fifteen-minute jobs, so a later trigger (the FX six-hour one) would have run
 * them a second time on a rolled-back Worker.
 *
 * Every key here is one entry of wrangler.jsonc's `triggers.crons`, in all
 * three environments, and every entry there is a key here: a new trigger needs
 * its own entry and its own branch in scheduled() BEFORE it is declared
 * (tests/scheduledCronDispatch.test.ts holds both sides).
 *
 * WHY THESE STRINGS LIVE HERE AND NOT IN worker/index.ts. A cron step ("every
 * fifteen minutes") is spelled with a star followed by a slash, the very pair
 * that closes a block comment. Several suites read worker/index.ts and strip
 * its comments with a pattern that cannot tell a string from a comment; when
 * FX-0 first put these strings there, one such strip opened at the slash-star
 * inside the string '/api/admin/*' and closed at the cron step, and about
 * 44 KB of mounts, the admin host guard among them, silently vanished from the
 * assertions that read them. worker/index.ts keeps that pair for real comment
 * terminators only (tests/storefrontIsolation.test.ts holds it).
 */

/** The minute tick: order-finance recovery and Quick Buy finalisation. */
export const CRON_EVERY_MINUTE = '* * * * *';

/** The fifteen-minute tick: staff reconciliation, durable jobs, upload sweep. */
export const CRON_EVERY_FIFTEEN_MINUTES = '*/15 * * * *';

/** The job sets scheduled() runs, one per known cron string. */
export type CronJobs = 'minute' | 'quarter_hour';

/**
 * The exact-match dispatch table. A Map, not an object literal: a cron string
 * such as `constructor` must find nothing, not an inherited property.
 */
export const CRON_DISPATCH: ReadonlyMap<string, CronJobs> = new Map<string, CronJobs>([
  [CRON_EVERY_MINUTE, 'minute'],
  [CRON_EVERY_FIFTEEN_MINUTES, 'quarter_hour'],
]);

/**
 * The job set a cron string runs, or null when this commit does not know it.
 * No trimming and no normalising: the fifteen-minute string with a doubled
 * space or a trailing one is not the fifteen-minute string, and runs nothing.
 */
export function cronJobs(cron: string): CronJobs | null {
  return CRON_DISPATCH.get(cron) ?? null;
}
