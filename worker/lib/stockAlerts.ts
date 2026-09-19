/**
 * «خبرني لما يرجع» — THE SWEEP. The thing that actually answers a customer's
 * standing request (migration 0092, worker/lib/stockAlertResolve.ts).
 *
 * This module drives the lifecycle and nothing else: it decides WHICH alerts to
 * look at this pass, asks `resolveWish` whether each wish is buyable now,
 * detects the EDGE, writes one message per (customer, product), and moves the
 * row through armed -> firing -> notified. It re-implements no availability
 * rule — `saleAvailability` (worker/routes/products.ts) is the only thing in
 * this codebase that decides whether something can be bought, and
 * `stockAlertResolve.ts` is the only thing that decides which selections to ask
 * it about.
 *
 * ---------------------------------------------------------------------------
 * 1. WHY A SWEEP AND NOT A HOOK — so nobody later "fixes" this by moving it
 *    onto a write path.
 *
 * Availability rises about sixteen different ways in this catalogue and only
 * FIVE of them write to `inventory_ledger`. `saveProductAtomic` covers three
 * more; the CSV import, the direct-stock panel and the price-grid traits drawer
 * each write raw SQL of their own; and four paths raise availability with NO
 * stock write at all (a value/colour/variant flipped `active` 0 -> 1,
 * `products.inventory_mode` repointed, a direct-sale cell re-enabled, a
 * `product_variants` row created for a combination nobody had modelled).
 *
 * A ledger hook would therefore cover under a third of them — and the failure
 * is INVISIBLE. No error, no dead row, no log line: just an alert that never
 * arrives, on a shop that believes the feature works because it worked the day
 * it was demonstrated. The `InventoryChanged` event cannot carry it either:
 * the event bus is off on production, so `pumpOutbox` returns null every run.
 * And the only safe in-request hook is `ctx.waitUntil`, which is not durable —
 * an isolate that is evicted mid-flight loses the work with nothing recording
 * that it was ever owed.
 *
 * So the sweep is the system of record. Its cost is LATENCY: a restock is
 * noticed within one cron period rather than within a request. For a feature
 * whose entire promise is "we will tell you when it comes back", fifteen
 * minutes is invisible, and correctness is not.
 *
 * ---------------------------------------------------------------------------
 * 2. THE EDGE IS COMPUTED ON THE ALERT ROW, NEVER ON A STOCK ROW.
 *
 * `last_buyable` / `last_available` live on `product_stock_alerts` and describe
 * THE WISH, not a shelf. Keying the edge to a stock row breaks both ways on a
 * multi-group product:
 *
 *   - one leg restocking raises that row's edge and fires an alert for a
 *     COMBINATION that is still unbuyable, because every value in the other
 *     group is at zero — the wrong-message failure this feature has exactly one
 *     unit of trust to spend on; and
 *   - once that leg's edge has been consumed by the first subscriber it never
 *     produces another, so the next person waiting on the same leg hears
 *     nothing, for ever.
 *
 * Per-wish state costs one integer per alert and is the only shape that can be
 * right for both.
 *
 * ---------------------------------------------------------------------------
 * 3. THE SWEEP ORDERS BY last_checked_at ASC, AND BOUNDS ITS RUN. The heading
 *    says THE SWEEP because the prune at the foot of this file deliberately
 *    carries no ORDER BY at all, for reasons of its own; a reader auditing that
 *    DELETE must not land here and conclude it orders its victims.
 *
 * `product_stock_alerts` has no examined-at column by accident — it has one on
 * purpose, and the sweep MUST order by it. Any stable ordering that is not
 * "least recently examined first" (id, armed_at, product_id) re-serves the same
 * first N rows every fifteen minutes and the tail NEVER fires. That is a
 * permanent starvation which looks EXACTLY like the feature working: the rows
 * at the front are examined, messages go out, the report shows traffic, and the
 * shoppers at the back wait indefinitely — an alert has NO deadline (see the
 * note at the top of worker/routes/stockAlerts.ts) — and are told nothing.
 *
 * A freshly armed row carries `last_checked_at = ''`, which sorts before every
 * ISO timestamp — so the newest request is examined on the very next pass.
 *
 * ---------------------------------------------------------------------------
 * 4. ONE MESSAGE PER (CUSTOMER, PRODUCT) PER PASS.
 *
 * A shopper who saves two models and five colours has SEVEN rows. An owner who
 * restocks three colours in one save would otherwise produce three in-app rows
 * and three Telegram messages in a single pass — three lock-screen buzzes for
 * one event, which is how a useful notification becomes one the person mutes.
 * Matched rows are grouped by (user_id, product_id) and emit ONE notification
 * that NAMES what came back, keyed once per customer+product+pass, with every
 * participating row flipped in the SAME `db.batch` under that key.
 *
 * ---------------------------------------------------------------------------
 * 5. READINESS IS RE-CHECKED AT FIRE TIME, weeks after arming.
 *
 * `armed_channel` records what we PROMISED when the shopper tapped. It is not
 * what can carry the message today: a Telegram link can be revoked, a WhatsApp
 * session can be logged out, a deployment can lose a secret. So
 * `channelReadiness` is asked again here, and when it answers with NOTHING the
 * alert STAYS ARMED — it is never flipped to notified. Consuming an alert
 * nobody was told about is the one failure the shopper cannot detect and cannot
 * repair: Settings would show it as fired and re-arming is the only remedy they
 * would never think to try.
 *
 * ---------------------------------------------------------------------------
 * 6. THE LIFECYCLE, AND WHY 'firing' EXISTS AS A STATE OF ITS OWN.
 *
 *   armed  -> firing    the in-app row is written and the outbox rows enqueued
 *   firing -> notified  once an outbox row actually reached `sent`
 *   firing -> armed     when every outbox row reached `dead`, with `arm_seq`
 *                       bumped and `last_buyable` reset to 0 so the next pass
 *                       re-detects the edge and tries again
 *
 * The tempting shortcut — flip to `notified` on ENQUEUE — consumes the alert
 * while the message can still die terminally (a blocked bot is a 403 and
 * `classifyTelegramFailure` calls that terminal on the first attempt). The
 * shopper is then told nothing AND cannot re-arm, because «تنبيهاتي» shows the
 * row as already fired. `firing` is what makes "queued" and "delivered"
 * different facts.
 *
 * A fire with NO outbound channel (in-app only) goes straight to `notified`:
 * there is no outbox row that could ever move, and leaving such a row in
 * `firing` would park it there for ever.
 *
 * ---------------------------------------------------------------------------
 * 7. THE EVENT KEY, AND THE SILENT FAILURE IT IS SHAPED AROUND.
 *
 * `user_notifications.event_key` is unique PER USER (0045) and `outbox.event_key`
 * is unique GLOBALLY across all three transports (0003). Both are keyed here on
 * the SAME identity — user id, product id, and the instant this fire was
 * written — and the channel suffix is appended by `planNotifyCustomer` alone.
 * Two different keyings would mean the in-app row dedupes while the outbound
 * rows do not, so one person gets the same lock-screen message twice.
 *
 * THE INSTANT IS PART OF THE KEY, and that is the whole point. The in-app
 * insert is `INSERT OR IGNORE` and `outbox.event_key` is UNIQUE, so a key that
 * repeats is not an error — it is a pair of silent no-ops followed by a sweep
 * that flips the row to `notified` having delivered nothing, for ever. A key
 * built only from (user, product) does exactly that the second time a customer
 * is notified about the same product, which is the ordinary flow: alert fires,
 * shopper misses it, shopper taps «خبرني» again. `notified_at` carries that
 * instant on every participating row, written in the same batch from the same
 * string, so the settle step below can rebuild the key from any one of them
 * without a column that does not exist.
 *
 * AND THE KEY MUST NOT BE MOVED ONTO `arm_seq`, however tempting that looks
 * while hunting the duplicate the CLAIM in `fireGroup` exists to stop. Two
 * overlapping passes would indeed rebuild the same key from `arm_seq` — and so
 * would two DIFFERENT armings, which is the failure that matters. `arm_seq`
 * restarts at 1 on a fresh INSERT, and a fresh INSERT is ordinary: the customer
 * deletes a live alert and arms it again, or `pruneFinishedStockAlerts` erases
 * the finished row and they tap «نبّهني» a month later. Nothing in this Worker
 * ever deletes a `user_notifications` row or an `outbox` row, so the FIRST
 * fire's key outlives the alert row by years — and the second arming's
 * identical `...:s:1` key would be swallowed by INSERT OR IGNORE and by the
 * UNIQUE index, in silence, after which the sweep flips the row to `notified`
 * having delivered nothing. That is the DROPPED message, and it is worse than
 * the duplicate. The instant stays; concurrency is handled by the claim.
 *
 * ---------------------------------------------------------------------------
 * 8. RECONCILE, DO NOT CASCADE.
 *
 * `option_value_id` / `color_id` carry no foreign key (0092 says why), so a
 * wish can outlive its target. Such a row is marked `dead` WITH a reason the
 * shopper can read in Settings — never silently dropped from the driving set,
 * which would leave «تنبيهاتي» presenting a corpse as a live alert. And there
 * is deliberately NO companion DELETE beside `productPersistence`'s
 * option-value delete: that statement is guarded by `NOT EXISTS` clauses and
 * frequently deletes nothing, so an unconditional sibling would wipe a
 * customer's alerts off a live, sellable row with no notice to anybody.
 *
 * ---------------------------------------------------------------------------
 * 9. AND WHEN IT IS OVER, THE SERVER ERASES THE ROW.
 *
 * An alert has no deadline — it waits until the product is buyable, however
 * long that takes — but it does have an END: it fires once and its job is
 * done. `notified`, `cancelled` and `dead` are rows with no future, and the
 * customer cannot remove them (DELETE /:id is guarded on 'armed'/'firing', so
 * that a re-arm finds the same row). `pruneFinishedStockAlerts` at the bottom
 * of this file is what clears them, on the same cron as the sweep, after a
 * retention window. It deletes NOTHING that is still working.
 */

import type { Env } from './types';
import {
  channelReadiness,
  channelsLive,
  type ChannelId,
  type LiveChannels,
} from './channelReadiness';
import {
  planNotifyCustomer,
  reachForMany,
  type CustomerChannel,
  type CustomerMessage,
  type CustomerReach,
} from './customerNotify';
import { degradeIfSchemaMissing } from './membershipBenefits';
import { notifyStatement } from './notifications';
import {
  loadAlertContexts,
  resolveWish,
  type AlertDeadReason,
  type AlertProductContext,
  type AlertVerdict,
  type AlertWish,
} from './stockAlertResolve';

export interface StockAlertSweepReport {
  /** Alert rows actually examined this pass — evaluated or settled. */
  scanned: number;
  /** Rows that crossed the edge into buyable this pass. */
  matched: number;
  /** Rows that reached `notified` this pass (a delivery confirmed, or an
   *  in-app-only fire with nothing to wait for). */
  notified: number;
  /** Rows reconciled to `dead` with a reason. */
  dead: number;
  /** Rows deliberately left where they were: no channel could carry the
   *  message, or their outbox rows have not settled yet. */
  deferred: number;
}

/** D1 refuses more than 100 bound parameters; 90 is the margin the rest of this
 *  codebase documents (`productPersistence.ts`, `stockAlertResolve.ts`). */
const IN_CHUNK = 90;

/** Bookkeeping updates are independent of each other, so they are batched for
 *  round trips only. Kept well under D1's statement ceiling per batch. */
const BOOKKEEPING_BATCH = 50;

/** How long a `firing` row may wait on an outbox row that is neither sent nor
 *  dead before the sweep gives up on it and re-arms. See `settleFiring`. */
const FIRING_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * How long a CLAIMED but not yet written fire (`state = 'firing'` with an empty
 * `notified_at`) is left alone before `settleFiring` treats it as wreckage and
 * returns it to `armed`.
 *
 * It measures the window between `fireGroup`'s claim and the batch that writes
 * the message — a `planNotifyCustomer` call and one `db.batch`, seconds. One
 * cron period is already enormous next to that, and it is the shortest value
 * that cannot mistake a fire in flight for a dead one: an overlapping
 * invocation's settle pass that re-armed a live claim would reset
 * `last_buyable` under a message about to be written, and the alert would fire
 * a SECOND time on the next tick. Deliberately far shorter than
 * `FIRING_STALE_MS`, which times a queue that is retrying, not a gap of seconds.
 */
const UNDATED_FIRING_GRACE_MS = 15 * 60 * 1000;

/**
 * The key prefix, shared by the in-app row and by every outbox row this sweep
 * writes. `planNotifyCustomer` appends `:email` / `:whatsapp` / `:telegram`.
 */
const EVENT_PREFIX = 'stock_back';

/** The three transports `customerNotify` can enqueue, in the order their keys
 *  are built. Used to look a fire's outbox rows back up at settle time. */
const OUTBOUND: readonly CustomerChannel[] = ['email', 'whatsapp', 'telegram'];

const eventKeyFor = (userId: string, productId: string, firedAt: string): string =>
  `${EVENT_PREFIX}:u:${userId}:p:${productId}:t:${firedAt}`;

interface AlertRow {
  id: string;
  user_id: string;
  product_id: string;
  kind: string;
  option_value_id: string;
  color_id: string;
  state: string;
  arm_seq: number;
  last_available: number | null;
  last_buyable: number;
  notified_at: string;
  /** Written by every judgement AND by `fireGroup`'s claim, which is what lets
   *  `settleFiring` date an undated `firing` row. See UNDATED_FIRING_GRACE_MS. */
  last_checked_at: string;
}

const ALERT_COLUMNS =
  'id, user_id, product_id, kind, option_value_id, color_id, state, arm_seq, ' +
  'last_available, last_buyable, notified_at, last_checked_at';

const wishOf = (row: AlertRow): AlertWish => ({
  // The CHECK constraint on `kind` is the guarantee; the cast states it rather
  // than re-validating a column SQLite already refuses to hold anything else in.
  kind: row.kind as AlertWish['kind'],
  option_value_id: row.option_value_id,
  color_id: row.color_id,
});

const isOutbound = (c: ChannelId): c is CustomerChannel => c !== 'inapp';

/**
 * A composite Map key from several ids. `JSON.stringify` rather than a joined
 * string with a separator: every separator that is cheap to type is a character
 * some id could one day contain, and the failure that produces — two different
 * groups collapsing into one notification — is silent and would be blamed on
 * the grouping rule rather than on the key.
 */
const groupKey = (...parts: string[]): string => JSON.stringify(parts);

function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Run a list of independent statements without letting one failure lose the
 *  rest. Every statement here is a single-row, state-guarded UPDATE, so the
 *  chunks have nothing to be atomic about — only round trips to save. */
async function runBookkeeping(env: Env, stmts: D1PreparedStatement[]): Promise<void> {
  for (const part of chunk(stmts, BOOKKEEPING_BATCH)) {
    try {
      await env.DB.batch(part);
    } catch (e) {
      console.error('stock alert bookkeeping failed:', e instanceof Error ? e.message : String(e));
    }
  }
}

// --------------------------------------------------------------- messages

interface Trilingual {
  ar: string;
  en: string;
  ckb: string;
}

/**
 * WHAT THE CUSTOMER READS. Arabic first, then English, then Sorani — the
 * house rule, and here it is load-bearing rather than cosmetic: the in-app row
 * stores ar/en separately so the language it is read in next month wins over
 * the one that happened to be active when it was written, and the chat/email
 * text is rendered in the recipient's own `locale`.
 *
 * The message NAMES what came back. «رجع المنتج» on a product with nine
 * colours tells the person nothing they can act on — they open the page, find
 * the colour they wanted still at zero, and learn that the alert cannot be
 * trusted. The labels come from `AlertVerdict.label`, which is the authored
 * name in three languages and never the stock engine's internal `name_en` or a
 * machine `combo_key`.
 */
function composeMessage(
  ctx: AlertProductContext,
  labels: Trilingual[],
  productWide: boolean
): { title: Trilingual; body: Trilingual } {
  const name = ctx.name as Trilingual;
  const title: Trilingual = {
    ar: `رجع للبيع: ${name.ar}`,
    en: `Back in stock: ${name.en}`,
    ckb: `گەڕایەوە بۆ فرۆشتن: ${name.ckb}`,
  };

  // A product-wide wish in the group makes every narrower label redundant: the
  // customer asked about the product, and listing the colours that happened to
  // return reads as a restriction they did not ask for.
  if (productWide || labels.length === 0) {
    return {
      title,
      body: {
        ar: `${name.ar} رجع متوفر الآن. اطلبه قبل ما ينفد مرة ثانية.`,
        en: `${name.en} is available again. Order it before it sells out.`,
        ckb: `${name.ckb} ئێستا بەردەستە. پێش ئەوەی دووبارە تەواو بێت داوای بکە.`,
      },
    };
  }

  const joined: Trilingual = {
    ar: labels.map((l) => l.ar).join('، '),
    en: labels.map((l) => l.en).join(', '),
    ckb: labels.map((l) => l.ckb).join('، '),
  };
  return {
    title,
    body: {
      ar: `${name.ar} — ${joined.ar}: رجع متوفر الآن. اطلبه قبل ما ينفد مرة ثانية.`,
      en: `${name.en} — ${joined.en}: available again. Order it before it sells out.`,
      ckb: `${name.ckb} — ${joined.ckb}: ئێستا بەردەستە. پێش ئەوەی دووبارە تەواو بێت داوای بکە.`,
    },
  };
}

/**
 * The absolute address a chat message can be tapped. `APP_ORIGIN` is
 * CONFIGURATION and there is no request to fall back to inside a cron, so an
 * unconfigured deployment simply omits the link rather than inventing an
 * origin — the same rule `invoices.ts` applies for the same reason (a merchant
 * subdomain must never end up in a link the platform sent).
 */
function absoluteProductUrl(env: Env, slug: string): string {
  const origin = (env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
  return origin ? `${origin}/product/${slug}` : '';
}

// ----------------------------------------------------------- the settle

interface FiringGroup {
  user_id: string;
  product_id: string;
  /** The instant the fire was written — the third component of its event key. */
  notified_at: string;
  rows: AlertRow[];
}

/**
 * MOVE THE ROWS THAT ALREADY FIRED, by asking the outbox what became of them.
 *
 * The join is the event key and nothing else: there is no column on
 * `product_stock_alerts` pointing at an outbox row, and adding one would have
 * meant a destructive migration. The key is rebuilt from (user_id, product_id,
 * notified_at), all three of which are on the alert row and all three of which
 * were written in the same batch as the outbox rows themselves — so a group's
 * members cannot disagree about what their key was.
 *
 * ANY row `sent` settles the group as delivered. The message reached the person
 * on at least one channel, which is the whole question; waiting for the other
 * two would park the alert behind a mailbox that is merely slow.
 */
async function settleFiring(
  env: Env,
  firing: AlertRow[],
  now: string,
  report: StockAlertSweepReport
): Promise<void> {
  if (firing.length === 0) return;

  const groups = new Map<string, FiringGroup>();
  for (const row of firing) {
    /*
     * A `firing` ROW WITH NO `notified_at` IS A CLAIM THAT HAS NOT LANDED YET.
     *
     * `fireGroup` claims its rows — 'armed' -> 'firing' — BEFORE it composes or
     * enqueues anything, and deliberately leaves `notified_at` empty until the
     * batch that actually writes the message. So an undated `firing` row is one
     * of exactly two things: a fire in flight right now in another (overlapping)
     * invocation, or the wreckage of one that died between the claim and the
     * batch. The wreckage MUST go back to `armed` or the customer waits for
     * ever; the fire in flight MUST be left alone, because re-arming it resets
     * `last_buyable` underneath a message that is about to be written and buys
     * the second lock-screen buzz the claim exists to prevent.
     *
     * `UNDATED_FIRING_GRACE_MS` against the row's own `last_checked_at` — which
     * the claim writes — is what tells them apart, in the verdict loop below.
     * (A hand-edited or half-migrated row lands here too, undated, and is
     * re-armed on the same reading: one extra message is the safe direction.)
     */
    const key = groupKey(row.user_id, row.product_id, row.notified_at);
    const g = groups.get(key);
    if (g) g.rows.push(row);
    else groups.set(key, { user_id: row.user_id, product_id: row.product_id, notified_at: row.notified_at, rows: [row] });
  }

  // Every candidate outbox key for every group in one flat list, chunked at the
  // bound-parameter ceiling. One read per 90 keys, never one per group.
  const wanted: string[] = [];
  for (const g of groups.values()) {
    if (!g.notified_at) continue;
    const base = eventKeyFor(g.user_id, g.product_id, g.notified_at);
    for (const ch of OUTBOUND) wanted.push(`${base}:${ch}`);
  }

  const states = new Map<string, string>();
  for (const part of chunk(wanted, IN_CHUNK)) {
    const ph = part.map(() => '?').join(', ');
    const res = await env.DB.prepare(`SELECT event_key, state FROM outbox WHERE event_key IN (${ph})`)
      .bind(...part)
      .all<{ event_key: string; state: string }>()
      .catch((e) => {
        console.error('stock alert settle: outbox read failed:', e instanceof Error ? e.message : String(e));
        return { results: [] as Array<{ event_key: string; state: string }> };
      });
    for (const r of res.results ?? []) states.set(r.event_key, r.state);
  }

  const stmts: D1PreparedStatement[] = [];
  for (const g of groups.values()) {
    report.scanned += g.rows.length;

    let verdict: 'notified' | 'rearm' | 'wait';
    if (!g.notified_at) {
      // The newest claim instant in the group: "how long ago did something take
      // these rows". Nothing refreshes it while we wait — see the `wait` branch
      // below, which is the one place in this module that writes NOTHING.
      let claimedAt = 0;
      for (const row of g.rows) {
        const t = Date.parse(row.last_checked_at);
        if (Number.isFinite(t) && t > claimedAt) claimedAt = t;
      }
      const wreckage = claimedAt === 0 || Date.now() - claimedAt > UNDATED_FIRING_GRACE_MS;
      verdict = wreckage ? 'rearm' : 'wait';
    } else {
      const base = eventKeyFor(g.user_id, g.product_id, g.notified_at);
      const found = OUTBOUND.map((ch) => states.get(`${base}:${ch}`)).filter(
        (s): s is string => s !== undefined
      );
      if (found.length === 0) {
        // Nothing to wait for. Either the fire was in-app only (and already
        // marked notified, so we do not get here) or the rows are gone —
        // either way no future run can change the answer, and the in-app row
        // is the delivery of record.
        verdict = 'notified';
      } else if (found.some((s) => s === 'sent')) {
        verdict = 'notified';
      } else if (found.every((s) => s === 'dead' || s === 'skipped')) {
        verdict = 'rearm';
      } else {
        verdict = 'wait';
      }

      /**
       * THE ESCAPE FROM A ROW THAT WILL NEVER MOVE AGAIN.
       *
       * `processOutbox` claims a row by bumping `attempts` and only THEN writes
       * the terminal state, so an invocation that dies between the two leaves
       * `state = 'pending', attempts = MAX_ATTEMPTS` — which its own SELECT
       * (`attempts < ?`) will never pick up again. The outbox row is then stuck
       * `pending` for ever, and an alert that waits for it to reach `sent` or
       * `dead` is stuck with it: armed in the customer's list, invisible to the
       * matcher because it is `firing`, permanently silent.
       *
       * Six hours is far past any real retry schedule (five attempts across
       * fifteen-minute ticks), and there is no ceiling on the other side to
       * compare it against: the standing request behind it has NO deadline and
       * may wait a year (worker/routes/stockAlerts.ts), so a row stuck in
       * `firing` is stuck for ever rather than until some expiry rescues it.
       * Re-arming costs at worst one duplicate message on a queue that later
       * unsticks; the alternative costs the whole promise.
       */
      const age = Date.now() - Date.parse(g.notified_at);
      if (verdict === 'wait' && Number.isFinite(age) && age > FIRING_STALE_MS) verdict = 'rearm';
    }

    for (const row of g.rows) {
      if (verdict === 'notified') {
        report.notified += 1;
        stmts.push(
          env.DB.prepare(
            // `notified_at = ?` pins this to the FIRE that was judged. Without
            // it an overlapping invocation's freshly claimed row — same id,
            // same state, a different fire entirely — could be settled by a
            // verdict that was never about it.
            `UPDATE product_stock_alerts
                SET state = 'notified', last_checked_at = ?
              WHERE id = ? AND state = 'firing' AND notified_at = ?`
          ).bind(now, row.id, g.notified_at)
        );
      } else if (verdict === 'rearm') {
        /**
         * BACK TO ARMED, WITH THE EDGE RESET.
         *
         * `last_buyable = 0` is not tidiness — without it the row is armed,
         * the product is buyable, and the sweep sees no TRANSITION for ever.
         * The alert would be alive in the customer's list and permanently
         * incapable of firing, which is worse than having been consumed.
         *
         * `arm_seq` is bumped for the same reason the arm upsert bumps it —
         * and it is worth being exact about what that reason is NOT. It is not
         * what stops the replacement message deduping against the corpse of the
         * first. NOTHING in this codebase reads `arm_seq` for behaviour: the
         * event key carries the FIRING INSTANT (§7), and that is what makes the
         * next fire a new identity. The bump is bookkeeping the customer is
         * shown — how many times this person has had to wait for this exact
         * thing — and §7 explains why the key must never be moved onto it.
         */
        report.deferred += 1;
        stmts.push(
          env.DB.prepare(
            `UPDATE product_stock_alerts
                SET state = 'armed',
                    arm_seq = arm_seq + 1,
                    last_buyable = 0,
                    notified_at = '',
                    last_checked_at = ?
              WHERE id = ? AND state = 'firing' AND notified_at = ?`
          ).bind(now, row.id, g.notified_at)
        );
      } else if (g.notified_at) {
        // Still in flight. `last_checked_at` still moves, so a group whose
        // outbox is retrying does not hold the front of the queue and starve
        // the rows behind it.
        report.deferred += 1;
        stmts.push(
          env.DB.prepare(
            `UPDATE product_stock_alerts SET last_checked_at = ? WHERE id = ? AND state = 'firing'`
          ).bind(now, row.id)
        );
      } else {
        /*
         * A CLAIM STILL INSIDE ITS GRACE — THE ONE ROW THIS MODULE WRITES
         * NOTHING TO, AND THE REASON IT MUST NOT.
         *
         * The grace is measured against `last_checked_at`. Moving it here would
         * refresh the very clock the grace is read from, so a claim orphaned by
         * a crash would look fresh on every single pass, for ever, and never be
         * re-armed: permanent silence, which is the failure this module is
         * defined against. These rows exist only in the seconds between a claim
         * and its batch (or after a crash in that gap), they are bounded by the
         * group size, and they clear within a pass or two — so letting them
         * hold the front of the least-recently-examined ordering for that long
         * costs nothing anybody can feel.
         */
        report.deferred += 1;
      }
    }
  }

  await runBookkeeping(env, stmts);
}

// ------------------------------------------------------------- the fire

interface MatchedRow {
  row: AlertRow;
  verdict: AlertVerdict;
}

interface MatchGroup {
  user_id: string;
  product_id: string;
  ctx: AlertProductContext;
  rows: MatchedRow[];
}

/**
 * ONE CUSTOMER, ONE PRODUCT, ONE MESSAGE — A CLAIM, THEN ONE BATCH.
 *
 * The in-app row, the outbox rows and the state flip for every participating
 * alert commit together or not at all. Run separately, a worker that died
 * between them would either notify twice or mark an alert notified that nobody
 * was told about — which are the two failures this whole module is defined
 * against. `enqueueStatement` is `ON CONFLICT DO NOTHING` and `notifyStatement`
 * is `INSERT OR IGNORE` precisely so a replay is a no-op the batch survives
 * rather than a collision that aborts it (see the note on `enqueueStatement`).
 *
 * The batch is PER GROUP and not per pass: a hundred customers waiting on one
 * restocked product are a hundred independent promises, and one customer's
 * failed write must not roll back the other ninety-nine.
 */
async function fireGroup(
  env: Env,
  group: MatchGroup,
  reach: CustomerReach | undefined,
  live: LiveChannels,
  now: string,
  report: StockAlertSweepReport
): Promise<void> {
  const readiness = await channelReadiness(env, group.user_id);

  /**
   * NOTHING CAN CARRY IT — so the promise is not spent. See §5 above: an alert
   * flipped to `notified` with no message behind it is invisible to the shopper
   * and unrecoverable by them.
   *
   * `last_checked_at` MOVES ANYWAY, and `last_buyable` does NOT. The first is
   * what stops these rows from re-occupying the front of the least-recently
   * -examined ordering on every single tick and starving everybody behind them
   * — a person who has switched off every channel must not be able to stall the
   * queue. The second is what keeps the edge armed, so the moment they link
   * Telegram the very next pass fires without needing the stock to move again.
   */
  if (readiness.delivery.length === 0) {
    report.deferred += group.rows.length;
    await runBookkeeping(
      env,
      group.rows.map((m) =>
        env.DB.prepare(
          `UPDATE product_stock_alerts SET last_checked_at = ? WHERE id = ? AND state = 'armed'`
        ).bind(now, m.row.id)
      )
    );
    return;
  }

  const outbound = readiness.delivery.filter(isOutbound);

  /**
   * THE CLAIM. ONE ARMING, ONE MESSAGE, EVEN WHEN TWO CRON RUNS OVERLAP.
   *
   * `runDurableJobs` is handed to `ctx.waitUntil` with NO lock of any kind
   * (worker/index.ts), and a run that outlives the fifteen-minute gap overlaps
   * the next one — index.ts already concedes that on `media_cleanup`, and this
   * pass is a plausible candidate: up to fifty provider sends across two
   * `processOutbox` drains happen before it is even reached.
   *
   * THE FAILURE, PRECISELY. Two overlapping passes both SELECT the same armed
   * row, both read `last_buyable = 0` against a buyable verdict, and both
   * arrive here. Every dedupe this module owns is keyed on the FIRING INSTANT
   * (§7) and the two passes computed DIFFERENT instants — so `INSERT OR IGNORE`
   * on `user_notifications` and `ON CONFLICT DO NOTHING` on `outbox.event_key`
   * are each handed a key nobody has ever seen, and each lets its message
   * through. The state guard on the final UPDATE below protects the ROW and
   * never the MESSAGE: the loser's UPDATE matches zero rows, which is not an
   * error in SQLite, so its batch COMMITS the notification sitting beside it
   * anyway. The customer's phone buzzes «رجع للبيع» twice for one press of
   * «نبّهني» — and «تنبيهاتي» shows one alert, so nothing in the shop records
   * that it happened.
   *
   * SO THE ROWS ARE CLAIMED BEFORE ANYTHING IS COMPOSED OR ENQUEUED, with the
   * same compare-and-swap the rest of this cron already uses for exactly this
   * reason (`processOutbox` claims by bumping `attempts`; `releaseDueAccruals`
   * by a conditional UPDATE). `db.batch` is ONE transaction and reports
   * `meta.changes` per statement, so a single round trip says precisely which
   * rows this pass owns. A row the other pass already flipped reports zero
   * changes and is simply not ours to speak about.
   *
   * `notified_at` IS DELIBERATELY LEFT EMPTY BY THE CLAIM, and that is what
   * makes a half-done fire recoverable instead of a swallowed promise. If this
   * invocation dies between the claim and the batch — an eviction, a throwing
   * `planNotifyCustomer` — the row is `firing` with no instant, and
   * `settleFiring` reads exactly that shape as wreckage and returns it to
   * `armed` with `last_buyable = 0`. The cost is one extra tick of latency. The
   * alternative — claiming WITH the instant — leaves a row that settles as
   * `notified` with no message behind it, which is the one failure the shopper
   * can neither see nor repair.
   */
  const claims = await env.DB.batch(
    group.rows.map((m) =>
      env.DB.prepare(
        `UPDATE product_stock_alerts
            SET state = 'firing', notified_at = '', last_checked_at = ?
          WHERE id = ? AND state = 'armed'`
      ).bind(now, m.row.id)
    )
  );
  const mine = group.rows.filter((_, i) => Number(claims[i]?.meta?.changes ?? 0) > 0);
  if (mine.length === 0) {
    // Another invocation owns this arming and is writing the message. Counted
    // as deferred rather than matched: this pass did nothing for these rows.
    report.deferred += group.rows.length;
    return;
  }
  report.deferred += group.rows.length - mine.length;

  const productWide = mine.some((m) => m.row.kind === 'product');
  const labels: Trilingual[] = [];
  const seenLabels = new Set<string>();
  for (const m of mine) {
    if (m.row.kind === 'product') continue;
    const l = m.verdict.label;
    const seen = groupKey(l.ar, l.en, l.ckb);
    if (seenLabels.has(seen)) continue;
    seenLabels.add(seen);
    labels.push(l);
  }

  const { title, body } = composeMessage(group.ctx, labels, productWide);
  const slug = String(group.ctx.slug ?? '');
  const path = slug ? `/product/${slug}` : '/';
  const url = slug ? absoluteProductUrl(env, slug) : '';

  const lang = reach?.lang ?? 'ar';
  const chatBody = `${title[lang]}\n${body[lang]}`;
  const msg: CustomerMessage = {
    subject: title[lang],
    body: chatBody,
    // Only when APP_ORIGIN is configured: a relative path in a WhatsApp message
    // is text, not a link, and a half-built absolute URL is worse than none.
    details: url ? [{ label: lang === 'en' ? 'Link' : 'الرابط', value: url }] : undefined,
  };

  const firedAt = now;
  const base = eventKeyFor(group.user_id, group.product_id, firedAt);

  const plan = await planNotifyCustomer(env, group.user_id, base, msg, {
    channels: outbound,
    reach,
    live,
  });

  const stmts: D1PreparedStatement[] = [];

  /**
   * THE FLOOR, ALWAYS WRITTEN. `user_notifications` needs no secret, no
   * provider and no verification, and it is the only artefact of the fire the
   * shopper can still find tomorrow. Without it a `notified` row in «تنبيهاتي»
   * points at nothing at all, and a Telegram message that scrolled away is the
   * entire record of a promise the shop kept.
   */
  stmts.push(
    notifyStatement(env.DB, {
      userId: group.user_id,
      kind: 'stock_back',
      title_ar: title.ar,
      title_en: title.en,
      body_ar: body.ar,
      body_en: body.en,
      link: path,
      entity_type: 'product',
      entity_id: group.product_id,
      meta: { alert_ids: mine.map((m) => m.row.id) },
      eventKey: base,
    }).stmt
  );
  stmts.push(...plan.statements);

  /**
   * NO OUTBOUND ROW MEANS NOTHING CAN EVER REACH `sent`, so waiting for one
   * would park this alert in `firing` permanently. The in-app row IS the
   * delivery in that case, and it is already in this batch.
   */
  const nextState = plan.statements.length > 0 ? 'firing' : 'notified';

  for (const m of mine) {
    stmts.push(
      env.DB.prepare(
        // `state = 'firing' AND notified_at = ''` is the claim this pass took,
        // named exactly. The old guard read `state = 'armed'`, which any
        // concurrent pass could also satisfy — see the claim above.
        `UPDATE product_stock_alerts
            SET state = ?, last_buyable = 1, last_available = ?, notified_at = ?,
                last_checked_at = ?, dead_reason = ''
          WHERE id = ? AND state = 'firing' AND notified_at = ''`
      ).bind(nextState, m.verdict.available, firedAt, now, m.row.id)
    );
  }

  await env.DB.batch(stmts);
  report.matched += mine.length;
  if (nextState === 'notified') report.notified += mine.length;
}

// -------------------------------------------------------------- the pass

/**
 * ONE BOUNDED PASS OVER THE STANDING REQUESTS.
 *
 * `limitAlerts` bounds the rows examined and therefore the writes, the
 * readiness reads and the messages; `limitProducts` bounds the catalogue load,
 * which is the expensive half (`loadAlertContexts` is seven chunked reads plus
 * the mystery-pool membership read, whatever N is). Rows whose product did not
 * fit inside `limitProducts` are left COMPLETELY untouched — their
 * `last_checked_at` does not move — so they sort to the front of the very next
 * pass. That is the anti-starvation guarantee, and it only holds because
 * nothing here writes `last_checked_at` on a row it did not actually judge.
 *
 * Never throws for a missing migration: a Worker can be live one migration
 * ahead of D1, and a cron step that errors on every run until somebody applies
 * 0092 is noise in the one place an operator looks for real failures.
 */
export async function sweepStockAlerts(
  env: Env,
  limitProducts: number,
  limitAlerts: number
): Promise<StockAlertSweepReport> {
  const report: StockAlertSweepReport = { scanned: 0, matched: 0, notified: 0, dead: 0, deferred: 0 };

  const alertBudget = Math.max(1, Math.min(2000, Math.trunc(limitAlerts) || 1));
  const productBudget = Math.max(1, Math.min(500, Math.trunc(limitProducts) || 1));
  const now = new Date().toISOString();

  const rows = await degradeIfSchemaMissing(
    'stock alerts (migration 0092)',
    async () =>
      (
        await env.DB.prepare(
          // The partial index `idx_stock_alerts_armed` is what keeps this cheap
          // on a shop with fifty thousand historical rows and forty live ones:
          // notified, cancelled and dead rows — the ones that accumulate for
          // ever — are not in it at all.
          `SELECT ${ALERT_COLUMNS}
             FROM product_stock_alerts
            WHERE state IN ('armed','firing')
            ORDER BY last_checked_at ASC, id ASC
            LIMIT ?`
        )
          .bind(alertBudget)
          .all<AlertRow>()
      ).results ?? [],
    [] as AlertRow[]
  );
  if (rows.length === 0) return report;

  // The already-fired rows first: settling one may return it to `armed`, and
  // doing that BEFORE the match would risk firing the same row twice in one
  // pass. It cannot happen — a row returned to armed here is not in this
  // pass's `armed` list — and the ordering makes that true by construction
  // rather than by argument.
  await settleFiring(
    env,
    rows.filter((r) => r.state === 'firing'),
    now,
    report
  );

  const armed = rows.filter((r) => r.state === 'armed');
  if (armed.length === 0) return report;

  // Spend the product budget on the LEAST RECENTLY EXAMINED products, which is
  // what the ordering above already hands us. A row whose product misses the
  // budget is skipped in full — see the note on starvation.
  const productIds: string[] = [];
  const chosen = new Set<string>();
  // Reassigned when a (user, product) group turns out to be split by the page
  // boundary — see the note below.
  let examined: AlertRow[] = [];
  for (const row of armed) {
    if (!chosen.has(row.product_id)) {
      if (chosen.size >= productBudget) continue;
      chosen.add(row.product_id);
      productIds.push(row.product_id);
    }
    examined.push(row);
  }
  if (examined.length === 0) return report;

  /**
   * A (CUSTOMER, PRODUCT) IS JUDGED WHOLE OR NOT AT ALL — THE ALERT BUDGET'S
   * MISSING HALF OF THE RULE THE PRODUCT BUDGET ABOVE ALREADY KEEPS.
   *
   * `fireGroup` writes ONE message per (user, product) over the rows it is
   * handed. If the `LIMIT ?` on the SELECT cut a customer's wishes on ONE
   * product in half — the product sheet allows up to twenty on a single
   * product — the half on this page fires now, and the half left behind keeps
   * its old `last_checked_at`, sorts to the FRONT of the next pass, is still
   * buyable and still carries `last_buyable = 0`. Fifteen minutes later it
   * fires as a "fresh" group, with a fresh instant and therefore a fresh event
   * key, and the customer gets a SECOND «رجع للبيع» for one restock. The claim
   * in `fireGroup` cannot catch this one: the two halves are different rows and
   * both fires are legitimate.
   *
   * ONE COUNT, AND ONLY WHEN THE PAGE WAS FULL. A page shorter than its budget
   * saw every live row there is, so nothing can have been cut and this costs
   * exactly nothing on the overwhelmingly common tick. The bound parameters are
   * product ids only, chunked at the documented ceiling, and the read is soft:
   * a count that fails leaves the pass judging the page as it stands, which is
   * what this code did before the check existed.
   *
   * A DEFERRED GROUP CANNOT STARVE. Its rows are left COMPLETELY untouched —
   * `last_checked_at` does not move — so they lead the very next pass, where
   * the group sits at the front of the page and is therefore whole.
   * `MAX_WISHES_PER_PRODUCT` (20, worker/routes/stockAlerts.ts) is far below
   * any real `limitAlerts`, so one group can never be too large to fit. The
   * last resort is stated anyway: if deferring would leave NOTHING to judge —
   * a caller with a tiny budget — the page is judged as it stands, because a
   * duplicate message is a nuisance and permanent silence is a broken promise.
   */
  if (rows.length >= alertBudget) {
    const held = new Map<string, number>();
    for (const row of examined) {
      const k = groupKey(row.user_id, row.product_id);
      held.set(k, (held.get(k) ?? 0) + 1);
    }

    const live = new Map<string, number>();
    let counted = true;
    for (const part of chunk(productIds, IN_CHUNK)) {
      const ph = part.map(() => '?').join(', ');
      const res = await env.DB.prepare(
        `SELECT user_id, product_id, COUNT(*) AS n
           FROM product_stock_alerts
          WHERE state = 'armed' AND product_id IN (${ph})
          GROUP BY user_id, product_id`
      )
        .bind(...part)
        .all<{ user_id: string; product_id: string; n: number }>()
        .catch((e) => {
          console.error(
            'stock alert sweep: group completeness read failed:',
            e instanceof Error ? e.message : String(e)
          );
          counted = false;
          return { results: [] as Array<{ user_id: string; product_id: string; n: number }> };
        });
      for (const r of res.results ?? []) live.set(groupKey(r.user_id, r.product_id), Number(r.n));
    }

    if (counted) {
      const whole = examined.filter((row) => {
        const k = groupKey(row.user_id, row.product_id);
        return live.get(k) === held.get(k);
      });
      if (whole.length > 0 && whole.length < examined.length) {
        report.deferred += examined.length - whole.length;
        examined = whole;
      }
    }
  }

  const contexts = await loadAlertContexts(env.DB, productIds);

  /**
   * A LOADER THAT ANSWERED ABOUT NOTHING IS NOT EVIDENCE THAT EVERY PRODUCT IS
   * GONE. `loadAlertContexts` omits an id only when the `products` row really
   * is absent, and that read is deliberately not soft — a failure throws rather
   * than returning an empty map. This guard costs one comparison and stands
   * between an unforeseen loader change and a pass that marks every live alert
   * in the shop `TARGET_REMOVED`, which is not recoverable from.
   */
  if (contexts.size === 0) {
    console.error(`stock alert sweep: no product context for ${productIds.length} product(s); nothing judged`);
    report.deferred += examined.length;
    return report;
  }

  const groups = new Map<string, MatchGroup>();
  const bookkeeping: D1PreparedStatement[] = [];

  for (const row of examined) {
    report.scanned += 1;
    const ctx = contexts.get(row.product_id);
    if (!ctx) {
      // The product row is gone. `product_id` declares ON DELETE CASCADE and
      // `productDeletion` names this table in OWNED_TABLES, but nothing in this
      // Worker sets PRAGMA foreign_keys — so a declared cascade is a promise the
      // runtime never confirms, and reconciling here is what makes it true.
      bookkeeping.push(deadStatement(env, row, 'TARGET_REMOVED', now));
      report.dead += 1;
      continue;
    }

    const verdict = resolveWish(ctx, wishOf(row));

    /*
     * A READ FAILED, SO THIS ROW IS LEFT EXACTLY AS IT WAS FOUND.
     *
     * Not `last_checked_at`, not `last_available`, not `last_buyable` — the
     * pass simply did not happen for this alert. Moving `last_checked_at`
     * would send it to the back of the least-recently-examined ordering as if
     * it had been judged, so a product whose relations are failing would drift
     * behind everything else precisely while it needs a retry.
     *
     * `deferred` rather than `scanned` says so in the report, which is how an
     * operator sees a degraded loader at all: the alternative reads as a quiet
     * pass where nothing happened to be back in stock.
     */
    if (verdict.degraded) {
      report.deferred += 1;
      continue;
    }

    if (verdict.dead) {
      bookkeeping.push(deadStatement(env, row, verdict.dead, now));
      report.dead += 1;
      continue;
    }

    if (verdict.buyable && row.last_buyable !== 1) {
      const key = groupKey(row.user_id, row.product_id);
      const g = groups.get(key);
      if (g) g.rows.push({ row, verdict });
      else groups.set(key, { user_id: row.user_id, product_id: row.product_id, ctx, rows: [{ row, verdict }] });
      continue;
    }

    /**
     * NO EDGE. The reading is still recorded — and `last_buyable` dropping back
     * to 0 is the half that matters: it is what ARMS the next rise. A sweep
     * that only ever wrote 1 would fire once per alert and never again.
     */
    bookkeeping.push(
      env.DB.prepare(
        `UPDATE product_stock_alerts
            SET last_checked_at = ?, last_available = ?, last_buyable = ?
          WHERE id = ? AND state = 'armed'`
      ).bind(now, verdict.available, verdict.buyable ? 1 : 0, row.id)
    );
  }

  await runBookkeeping(env, bookkeeping);

  if (groups.size === 0) return report;

  /**
   * ONE reach lookup for the whole pass and ONE deployment check, handed to
   * every `planNotifyCustomer` call. Without them a restock with two hundred
   * subscribers would run two hundred `reachFor` reads and two hundred
   * `channelsLive` calls inside one invocation — a feature that works with
   * three testers and falls over on the first popular item.
   */
  const userIds = [...new Set([...groups.values()].map((g) => g.user_id))];
  const [reaches, live] = await Promise.all([reachForMany(env, userIds), channelsLive(env)]);

  for (const group of groups.values()) {
    try {
      await fireGroup(env, group, reaches.get(group.user_id), live, now, report);
    } catch (e) {
      // One customer's failed batch must not cost the rest of the queue. The
      // rows stay `armed` with their old `last_checked_at`, so the next pass
      // sorts them to the front and tries again.
      report.deferred += group.rows.length;
      console.error(
        `stock alert fire failed for product ${group.product_id}:`,
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  return report;
}

/**
 * Kill the row WITH the reason. `dead_reason` is what «تنبيهاتي» renders, so a
 * customer whose colour was deleted reads «ما عاد موجود» instead of watching an
 * alert sit live indefinitely — an alert has no deadline — waiting for a
 * message that can never come.
 * The state guard means a row the customer cancelled in the same second is not
 * resurrected as dead.
 */
function deadStatement(env: Env, row: AlertRow, reason: AlertDeadReason, now: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE product_stock_alerts
        SET state = 'dead', dead_reason = ?, last_checked_at = ?
      WHERE id = ? AND state IN ('armed','firing')`
  ).bind(reason, now, row.id);
}

// ------------------------------------------------------------- the prune

/**
 * ===========================================================================
 *  THE SERVER ERASES A FINISHED ROW. «الصفوف المنتهية ... اجعل الخادم يمحيها
 *  تلقائيا» — the owner's ruling, and this is the whole of it.
 * ===========================================================================
 *
 * WHAT A FINISHED ROW IS, AND WHY THE CUSTOMER CANNOT REMOVE ONE.
 *
 * An alert has no time limit: it waits until the product is buyable again —
 * ninety days, ninety-five, a year — fires ONCE, and is then done. It does not
 * re-arm itself; only a fresh «نبّهني» arms a new one. So `notified` is not a
 * parked alert, it is a COMPLETED one, and the same is true of `cancelled` (the
 * customer withdrew it) and `dead` (the target it named no longer exists and
 * the customer has been told so).
 *
 * The customer cannot clear any of the three: DELETE /:id is guarded on
 * `state IN ('armed','firing')` — deliberately, because a re-arm must find the
 * SAME row (see `armStatement`) rather than start a second one beside it. The
 * page does not lie about that: «تنبيهاتي» renders the bin ONLY on a live row,
 * "where the server will honour it", so nothing dead-clicks. The grievance is
 * simpler and worse — the customer has NO control at all that removes a
 * finished row.
 *
 * `notified` and `dead` are the two they watch pile up, against the route's
 * hard LIMIT 100. `cancelled` never reaches that page at all — the list route
 * reads `state IN ('armed','firing','notified','dead')` — so pruning it clears
 * no screen; it is table hygiene, and it is named in the DELETE because a row
 * the customer withdrew has no future either.
 *
 * Nothing before this pruned it. `idx_stock_alerts_armed` is partial, so these
 * rows cost the sweep nothing to carry — which is exactly why the table could
 * grow for ever without anybody noticing: the feature keeps working while the
 * customer's own screen fills with history they cannot clear.
 *
 * ---------------------------------------------------------------------------
 * A DELETED ROW CANNOT CAUSE A SECOND MESSAGE. Worth stating plainly, because
 * it is the first fear this raises. Nothing is armed on a finished row, and the
 * sweep reads `state IN ('armed','firing')` only. The owner's own example holds
 * identically whether the row is still here or gone: back in stock on day 95 →
 * notified; sold out a week later; back again a week after that → SILENCE,
 * because the wish was already answered and only a fresh tap makes a new one.
 * Deleting the row is not what stops the second message; the lifecycle is.
 *
 * WHAT IS LOST is `arm_seq` and `armed_at` for that target — the count of how
 * many times this person has waited for this exact thing and when they first
 * did. Both are carried to the client (`GET /api/stock-alerts`), NOTHING reads
 * `arm_seq` for behaviour — not the sweep, not the event key, which is built
 * from (user, product, instant) — and no screen renders it. After a prune a
 * re-arm INSERTs fresh at `arm_seq = 1` instead of resuming the old row's
 * count. That is the price, it is paid in a statistic nothing consumes, and it
 * buys the list the owner asked for.
 */

/**
 * HOW LONG A FINISHED ROW SURVIVES. THE OWNER'S KNOB — one number, here.
 *
 * NOT ZERO, and the argument against zero is a real screen: the customer's
 * phone buzzes «رجع للبيع», they tap it, «تنبيهاتي» opens — and with a
 * delete-on-send prune the list would be empty. The message says the shop
 * remembered them; the list says no such alert ever existed. That is a worse
 * lie than the clutter this removes, and it costs one row for a few days to
 * avoid.
 *
 * THIRTY DAYS, and the number is not invented here: it is the retention this
 * codebase already applies to the other thing a customer finished with — a
 * cancelled order stays visible for exactly thirty days (`sweepCancelledOrders`,
 * jobs.ts step 11c). One retention the owner already knows beats a second one
 * chosen to be clever. It is also comfortably longer than any plausible gap
 * between a notification and the person opening the app, and comfortably
 * shorter than the ninety-plus days a LIVE alert may wait — so the two can
 * never be confused.
 *
 * To change it, change this number. It is read in exactly one place
 * (worker/lib/jobs.ts, step 15b) and means the same thing for all three
 * finished states.
 */
export const FINISHED_RETENTION_DAYS = 30;

/**
 * THE BOUND, and why an unbounded prune is a bug rather than an optimisation.
 *
 * A shop that has been running for a year reaches this with tens of thousands
 * of finished rows on its first pruning tick. One DELETE over all of them can
 * exceed the invocation's CPU budget and die part-way — and a cron step that
 * dies is a cron step that dies EVERY tick, on the same backlog, for ever,
 * while `step()` faithfully reports the same error.
 *
 * Two hundred per tick, at four ticks an hour, is ~19,000 rows a day. A partial
 * prune is safe to resume because the rows it deleted are GONE: the next tick's
 * identical query simply finds the next two hundred. There is no cursor to
 * keep, no ordering to preserve and no row that can be starved — a candidate
 * only ever leaves the set (deleted, or re-armed by its owner), never joins it
 * ahead of another.
 */
export const PRUNE_RUN_LIMIT = 200;

export interface StockAlertPruneReport {
  /** Finished rows erased this run. */
  deleted: number;
  /** True when the run spent its whole budget — there is more backlog waiting
   *  for the next tick. An operator watching this stay true for days is looking
   *  at a bound that is too small, not at a failure. */
  bound_hit: boolean;
}

/**
 * ERASE THE ROWS WHOSE WORK IS OVER.
 *
 * THE WHERE CLAUSE NAMES THE THREE FINISHED STATES, ONE BY ONE, AND THAT IS
 * NOT VERBOSITY. The tempting shorthand — `state NOT IN ('armed','firing')` —
 * is a standing instruction to delete any state this schema gains in the
 * future. `firing` exists precisely because a notification is IN FLIGHT: its
 * outbox rows have not settled, `settleFiring` is the only thing that may judge
 * it, and deleting one mid-flight destroys the alert while the message it
 * belongs to is still being retried — the customer is then told «رجع للبيع» by
 * a message whose alert is gone, or told nothing at all. A fourth working state
 * added to 0092's CHECK constraint must be swept into this DELETE by somebody
 * who decided it should be, not by the absence of a name in a negation.
 *
 * `last_checked_at` IS THE FINISH INSTANT, and it is the only column all three
 * terminal transitions write: the fire and the settle (this module), the
 * customer's cancel and the save that drops a wish (worker/routes/stockAlerts.ts),
 * and `deadStatement`. `notified_at` would cover only one of the three, and a
 * row that is cancelled or dead has none.
 *
 * A row whose `last_checked_at` is '' IS NEVER DELETED. No code path produces
 * one — every transition into a finished state writes it — so such a row is
 * hand-edited or half-migrated, and '' sorts BEFORE every ISO timestamp, which
 * means a plain `< cutoff` would erase it instantly. We do not date a row we
 * cannot date; it stays, visibly, for whoever made it.
 *
 * NO BAGHDAD CONVERSION HERE, deliberately, and it is worth saying because the
 * house rule (worker/lib/baghdadTime.ts) exists for the opposite case: this
 * compares two full UTC instants and the retention is a DURATION, not a
 * calendar day. `date('now')` is nowhere in it. A thirty-day window is thirty
 * days in every timezone; only "today" differs between UTC and UTC+3.
 *
 * ONE STATEMENT, NOT SELECT-THEN-DELETE. D1 refuses more than 100 bound
 * parameters, so a two-step prune would have to chunk its ids at 90 and pay a
 * round trip per chunk to delete rows nobody needs to see first. This binds
 * exactly TWO parameters whatever the backlog, and the id subquery is what
 * makes the LIMIT legal — SQLite does not accept LIMIT on a bare DELETE unless
 * it was compiled with an option we cannot rely on in D1.
 *
 * THE COST, HONESTLY: no index serves this. `idx_stock_alerts_armed` is partial
 * on ('armed','firing') and excludes every row here BY DESIGN, and
 * `idx_stock_alerts_user` leads with `user_id`, which a shop-wide prune has no
 * value to bind. So the selection is a scan — and that is exactly why it takes
 * no ORDER BY: ordering by an unindexed column would force a FULL scan plus a
 * sort on every single tick, including the overwhelmingly common tick where
 * three rows qualify, whereas an unordered LIMIT lets SQLite stop as soon as it
 * has found its budget. Which two hundred go first does not matter; they are
 * all past the cutoff and they are all going.
 */
export async function pruneFinishedStockAlerts(
  db: D1Database,
  now: string,
  retentionDays: number,
  limit: number
): Promise<StockAlertPruneReport> {
  // Clamped the way `sweepStockAlerts` clamps its budgets. A NEGATIVE retention
  // would put the cutoff in the FUTURE and erase rows finished seconds ago, so
  // it floors at zero rather than being trusted; zero itself is left reachable
  // because it is the owner's to choose, not ours to forbid.
  const days = Math.max(0, Math.trunc(retentionDays) || 0);
  const budget = Math.max(1, Math.min(1000, Math.trunc(limit) || 1));

  // A caller with an unparseable `now` gets this instant rather than an
  // `Invalid Date` that would throw inside toISOString and take the step down.
  const at = Date.parse(now);
  const cutoff = new Date((Number.isFinite(at) ? at : Date.now()) - days * 86_400_000).toISOString();

  // Never throws for a missing migration, for the same reason the sweep does
  // not: a Worker can be live one migration ahead of D1, and a housekeeping
  // step that errors on every run until somebody applies 0092 is noise in the
  // one place an operator looks for real failures. Anything else — a lock, a
  // dropped connection — propagates to `step()` in jobs.ts, which logs it,
  // names it and carries on. Pruning is housekeeping; it may fail loudly.
  const res = await degradeIfSchemaMissing<D1Response | null>(
    'stock alerts (migration 0092)',
    () =>
      db
        .prepare(
          `DELETE FROM product_stock_alerts
             WHERE id IN (
               SELECT id
                 FROM product_stock_alerts
                WHERE state IN ('notified','cancelled','dead')
                  AND last_checked_at <> ''
                  AND last_checked_at < ?
                LIMIT ?
             )`
        )
        .bind(cutoff, budget)
        .run(),
    null
  );

  const deleted = res?.meta.changes ?? 0;
  return { deleted, bound_hit: deleted >= budget };
}
