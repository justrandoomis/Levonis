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
 * 3. ORDER BY last_checked_at ASC, AND BOUND THE RUN.
 *
 * `product_stock_alerts` has no examined-at column by accident — it has one on
 * purpose, and the sweep MUST order by it. Any stable ordering that is not
 * "least recently examined first" (id, armed_at, product_id) re-serves the same
 * first N rows every fifteen minutes and the tail NEVER fires. That is a
 * permanent starvation which looks EXACTLY like the feature working: the rows
 * at the front are examined, messages go out, the report shows traffic, and the
 * shoppers at the back wait for ninety days and are told nothing.
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
}

const ALERT_COLUMNS =
  'id, user_id, product_id, kind, option_value_id, color_id, state, arm_seq, ' +
  'last_available, last_buyable, notified_at';

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
    // A row with no `notified_at` cannot have been fired by this module — it is
    // a hand-edited or half-migrated row. Returning it to `armed` is the safe
    // reading: the worst case is one extra message, where the alternative is a
    // row parked in `firing` that nothing will ever move.
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
      verdict = 'rearm';
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
       * fifteen-minute ticks) and far short of the ninety days the standing
       * request is good for. Re-arming costs at worst one duplicate message on
       * a queue that later unsticks; the alternative costs the whole promise.
       */
      const age = Date.now() - Date.parse(g.notified_at);
      if (verdict === 'wait' && Number.isFinite(age) && age > FIRING_STALE_MS) verdict = 'rearm';
    }

    for (const row of g.rows) {
      if (verdict === 'notified') {
        report.notified += 1;
        stmts.push(
          env.DB.prepare(
            `UPDATE product_stock_alerts
                SET state = 'notified', last_checked_at = ?
              WHERE id = ? AND state = 'firing'`
          ).bind(now, row.id)
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
         * `arm_seq` is bumped for the same reason the arm upsert bumps it: a
         * re-armed row must not reuse the identity of the fire that died, or
         * the replacement message dedupes against the corpse of the first.
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
              WHERE id = ? AND state = 'firing'`
          ).bind(now, row.id)
        );
      } else {
        // Still in flight. `last_checked_at` still moves, so a group whose
        // outbox is retrying does not hold the front of the queue and starve
        // the rows behind it.
        report.deferred += 1;
        stmts.push(
          env.DB.prepare(
            `UPDATE product_stock_alerts SET last_checked_at = ? WHERE id = ? AND state = 'firing'`
          ).bind(now, row.id)
        );
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
 * ONE CUSTOMER, ONE PRODUCT, ONE MESSAGE, ONE BATCH.
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

  const productWide = group.rows.some((m) => m.row.kind === 'product');
  const labels: Trilingual[] = [];
  const seenLabels = new Set<string>();
  for (const m of group.rows) {
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
      meta: { alert_ids: group.rows.map((m) => m.row.id) },
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

  for (const m of group.rows) {
    stmts.push(
      env.DB.prepare(
        `UPDATE product_stock_alerts
            SET state = ?, last_buyable = 1, last_available = ?, notified_at = ?,
                last_checked_at = ?, dead_reason = ''
          WHERE id = ? AND state = 'armed'`
      ).bind(nextState, m.verdict.available, firedAt, now, m.row.id)
    );
  }

  await env.DB.batch(stmts);
  report.matched += group.rows.length;
  if (nextState === 'notified') report.notified += group.rows.length;
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
  const examined: AlertRow[] = [];
  for (const row of armed) {
    if (!chosen.has(row.product_id)) {
      if (chosen.size >= productBudget) continue;
      chosen.add(row.product_id);
      productIds.push(row.product_id);
    }
    examined.push(row);
  }
  if (examined.length === 0) return report;

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
 * alert sit live for ninety days waiting for a message that can never come.
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
