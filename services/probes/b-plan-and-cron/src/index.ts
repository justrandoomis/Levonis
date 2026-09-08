import { json, type Verdict } from '../../verdict';

/**
 * ADR-017 (b). Two halves.
 *
 * The PLAN half is not a Worker's business: `scripts/assert-paid-plan.mjs`
 * reads the account and the workflow records what it found.
 *
 * The CRON half is: the design puts `* * * * *` on ~28 Workers (≈40k
 * invocations a day) and nothing local says whether the account tolerates that
 * or what it costs. This Worker carries one per-minute trigger and counts its
 * own scheduled runs in isolate memory, so a `wrangler tail` over ten minutes
 * shows the real cadence and the real drift — including the isolate evictions,
 * which are why the count is reported ALONGSIDE the wall clock rather than as
 * the answer.
 */
let ticks = 0;
let firstTick: string | null = null;
let lastTick: string | null = null;

export default {
  fetch(): Response {
    const v: Verdict = {
      row: 'b',
      question: 'Workers Paid confirmed; the cron-trigger cadence with a per-minute trigger',
      answer: ticks > 0 ? 'yes' : 'inconclusive',
      verdict:
        ticks > 0
          ? `${ticks} scheduled run(s) seen by this isolate between ${firstTick} and ${lastTick}`
          : 'no scheduled run has reached this isolate yet — wait a minute, or read `wrangler tail`',
      detail: { ticks, first: firstTick, last: lastTick, note: 'the isolate can be evicted between ticks; the tail log is the authority' },
    };
    return json(v);
  },
  scheduled(event: ScheduledController): void {
    ticks++;
    const at = new Date(event.scheduledTime).toISOString();
    firstTick ??= at;
    lastTick = at;
    console.log(JSON.stringify({ probe: 'b', tick: ticks, cron: event.cron, at }));
  },
};
