/**
 * Review of de54666a (autoReprice backlog window).
 *
 * The commit says: "a circular window of 50 products is evaluated instead. Its
 * last ID is retained in the run audit, so a large backlog or an unreadable
 * product cannot starve later IDs." The cursor is read from the newest
 * `run_finished` record only, and every run that is NOT windowed (an owner's
 * rate act or the six-hour FX run with the 600 budget, or any tick with enough
 * budget) writes a record WITHOUT `next_product_id`. The next windowed tick
 * therefore starts again at the lowest product ID and re-evaluates the window
 * it already processed, while the products after the cursor wait. Deficit
 * ties are broken by ascending product ID in the global run too, so with a
 * backlog larger than one rotation between such runs the highest IDs are
 * never reached.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { row } from './fixtures/app';
import { v2BacklogWorld } from './fixtures/v2Backlog';
import { SqliteD1 } from './fixtures/d1';
import { sweepStaleEnginePrices } from '../worker/lib/fx/reprice';
import { statementBudget } from '../worker/lib/fx/budget';
import type { Env } from '../worker/lib/types';

const COUNT = 120;
// The clean start (spec addendum A.6): the run selects V2 products only — a V2 backlog (tests/fixtures/v2Backlog.ts).
const backlogWorld = () => v2BacklogWorld(COUNT);

const lastSummary = (w: Awaited<ReturnType<typeof backlogWorld>>) =>
  JSON.parse(row<{ summary_json: string }>(w.raw, "SELECT summary_json FROM pricing_audit WHERE entity = 'run' AND entity_key = 'auto_reprice' AND action = 'run_finished' ORDER BY created_at DESC, rowid DESC LIMIT 1")!.summary_json) as { next_product_id?: string };

test('an unwindowed run between two windowed ticks must not send the window back to the first IDs', async () => {
  const w = await backlogWorld();
  const env = () => ({ DB: new SqliteD1(w.raw) }) as unknown as Env;

  // 1. A constrained tick: 120 stale products do not fit, so the 50-product window runs and records its cursor.
  const first = await sweepStaleEnginePrices(env(), { trigger: 'sweep', budget: statementBudget(80) });
  assert.equal(first.skipped, null, JSON.stringify(first));
  const cursor = lastSummary(w).next_product_id;
  assert.equal(cursor, 'backlog_0049', 'precondition: the first window recorded its cursor');
  assert.ok(first.repriced.length > 0 && first.repriced.length < 50, `precondition: part of the window written (${first.repriced.length})`);

  // 2. A run with a larger budget (owner act / six-hour run): the backlog fits, no window, no cursor in its record.
  const middle = await sweepStaleEnginePrices(env(), { trigger: 'sweep', budget: statementBudget(140) });
  assert.equal(middle.skipped, null, JSON.stringify(middle));
  assert.ok(middle.repriced.length > 0, 'precondition: the global run wrote something');

  // 3. The next constrained tick should continue after backlog_0049.
  const next = await sweepStaleEnginePrices(env(), { trigger: 'sweep', budget: statementBudget(80) });
  assert.equal(next.skipped, null, JSON.stringify(next));
  assert.ok(next.repriced.length > 0);
  assert.ok(next.repriced.every((pid) => pid > cursor!), `window restarted at the first IDs: ${next.repriced.join(',')} (cursor was ${cursor})`);
});
