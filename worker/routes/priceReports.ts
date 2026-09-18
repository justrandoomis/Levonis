/**
 * «لكيتها بمكان أرخص» — I FOUND IT CHEAPER SOMEWHERE ELSE.
 *
 * POST   /api/price-reports          the customer's report
 * GET    /api/admin/price-reports    the owner's list
 * PATCH  /api/admin/price-reports/:id
 *
 * ---------------------------------------------------------------------------
 * A REPORT IS A RECORD, NOT A CONVERSATION.
 *
 * The obvious place for this was a support ticket, and it is the wrong place.
 * A ticket's whole shape is "somebody is waiting for an answer" — it has a
 * thread, it ages, and it sits in the same inbox as «وين طلبيتي». What the
 * owner asked for is the opposite: a LIST they can sort by how big the gap is
 * and filter by product, so the question "where are we being beaten, and by
 * how much" has an answer on one screen. That is a table with columns, so
 * `price_reports` (migration 0093) is its own table with its own four states.
 *
 * ---------------------------------------------------------------------------
 * THE SERVER FREEZES ITS OWN PRICE, AND NEVER TAKES IT FROM THE CLIENT.
 *
 * `our_price_iqd` is read here, server-side, from `products.price_iqd` at the
 * instant the report is filed. Two separate reasons, and either alone is
 * enough:
 *
 *   - WITHOUT IT THE ROW MEANS NOTHING LATER. «وجدتها بـ٥٠٠ ألف» is a complete
 *     sentence today and unreadable in six months. Recomputing the gap against
 *     today's price answers a different question than the one that was asked —
 *     and if the product was repriced BECAUSE of this report, the table erases
 *     its own effect.
 *   - A CLIENT-SUPPLIED "our price" IS A CLIENT-SUPPLIED GAP. The first person
 *     to open dev tools would file a report claiming we charge ten times what
 *     we do, and the owner's sorted-by-gap list would put it at the top.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE CUSTOMER IS TOLD, AND WHAT THEY ARE NOT.
 *
 * The reply says the shop will LOOK at it. It does not say the price will be
 * matched, because nobody agreed to match anything: this shop imports its
 * stock, carries its own warranty, and a cheaper figure on Instagram is very
 * often a different unit or no warranty at all. A confirmation that promises a
 * match creates an obligation the owner never made, on a screen the owner
 * never sees — and the customer discovers it is untrue at the till.
 *
 * ---------------------------------------------------------------------------
 * THE LINK IS STORED, NOT FOLLOWED.
 *
 * `url` is validated to be http(s) and bounded, then stored as text. Nothing
 * on the server fetches it, and the admin list hands it back as a string. An
 * admin panel that resolves a customer-supplied URL on render — for a preview,
 * a favicon, a title — is an SSRF surface pointed at everything the Worker can
 * reach, and makes every admin page view a request to a stranger's server from
 * the shop's IP.
 */

import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { badRequest, conflict, int, notFound, oneOf, requireAdmin, requireAuth, str } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';

export const priceReportRoutes = new Hono<AppContext>();
/**
 * SIGNED IN, AND NOT NEGOTIABLE. An anonymous form that writes a row the owner
 * reads is a spam endpoint with a rate limit in front of it: the limit buckets
 * by IP for anonymous callers, and Iraqi carriers NAT thousands of customers
 * behind one address — so the limit that stops the flood also stops the
 * neighbours. An account is what makes a report attributable, dedupable, and
 * worth reading.
 */
priceReportRoutes.use('*', requireAuth);

export const adminPriceReportRoutes = new Hono<AppContext>();
/** Platform administration, and `requireAdmin` carries the apex-only host rule
 *  with it (worker/lib/http.ts) — so the guard cannot be lost by a mount. */
adminPriceReportRoutes.use('*', requireAdmin);

const REPORT_STATES = ['new', 'reviewed', 'actioned', 'rejected'] as const;
type ReportState = (typeof REPORT_STATES)[number];

/** A price a human could plausibly have seen. Above zero because «لكيتها ببلاش»
 *  is not a price report, and bounded far above the most expensive machine
 *  this shop sells so a typo is refused rather than sorted to the top of the
 *  owner's list. */
const MIN_PRICE_IQD = 1;
const MAX_PRICE_IQD = 1_000_000_000;

/** Every free-text field is bounded. `seller_name` is a shop name, `note` is a
 *  sentence, `url` is a link — none of them is an essay, and an unbounded
 *  string is a row nobody can render in a list. */
const MAX_SELLER = 120;
const MAX_URL = 500;
const MAX_NOTE = 500;

const nowIso = () => new Date().toISOString();

/**
 * An http(s) address, or a refusal that says which part was wrong.
 *
 * Parsed with `URL` rather than matched with a regular expression: the thing
 * being decided is "would a browser open this", and the parser is the only
 * honest answer to that. `javascript:` and `data:` are the reason the protocol
 * is checked at all — both parse cleanly, and both become a live link the
 * moment somebody renders this field as an anchor.
 *
 * The parsed form is NOT what is stored. `new URL()` normalises — it lowercases
 * the host, adds a trailing slash, re-encodes the path — and the owner is going
 * to compare this string against what the customer says they saw. What they
 * typed is what is kept.
 */
function externalUrl(raw: unknown): string {
  const value = str(raw, 'url', { max: MAX_URL, required: false });
  if (!value) return '';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw badRequest(
      'الرابط مو صحيح. الصقه كامل مع https:// أو اتركه فارغ. / That link is not a valid address. Paste the whole link including https://, or leave it empty.',
      'REPORT_BAD_URL'
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest(
      'نقبل روابط http أو https فقط. / Only http and https links are accepted.',
      'REPORT_BAD_URL_SCHEME'
    );
  }
  return value;
}

// ------------------------------------------------------------- the report

/**
 * POST /api/price-reports
 *
 * FIVE AN HOUR. High enough that a customer comparing a basket of filament
 * across three shops is never stopped, low enough that the owner's queue
 * cannot be filled faster than they can read it. Keyed by user id (the limiter
 * prefers it over the IP whenever there is a session), so one account's
 * enthusiasm never throttles a whole carrier's customers.
 */
priceReportRoutes.post('/', async (c) => {
  await rateLimit(c, 'price-report', 5, 3600);
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const productId = str(body.productId, 'productId', { min: 1, max: 60 });
  const priceIqd = int(body.priceIqd, 'priceIqd', { min: MIN_PRICE_IQD, max: MAX_PRICE_IQD });
  // Both optional: the owner asked for the place and the link «إن أمكن». A
  // report that carries only a number is still the signal — it says somebody
  // found this machine cheaper — and a form that refuses to submit without a
  // link is a form most people abandon.
  const sellerName = str(body.sellerName, 'sellerName', { max: MAX_SELLER, required: false });
  const url = externalUrl(body.url);
  const note = str(body.note, 'note', { max: MAX_NOTE, required: false });

  /**
   * The product must exist AND be on display. A report against a draft or a
   * hidden row is a report about something no customer can see, which means
   * either the id was guessed or the page is stale — and answering it would
   * confirm to a stranger that an unpublished product id is real.
   */
  const product = await c.env.DB.prepare(
    "SELECT id, name, name_ar, price_iqd FROM products WHERE id = ? AND status = 'active'"
  )
    .bind(productId)
    .first<{ id: string; name: string; name_ar: string; price_iqd: number }>();
  if (!product) throw notFound('Product not found');

  const ourPrice = Number(product.price_iqd) || 0;

  /**
   * ONE OPEN REPORT PER PERSON PER PRODUCT.
   *
   * Without this, the tap that says «ارسل» is a tap that appends a row, and a
   * customer who is not sure it went through sends it three times. The owner's
   * list is then three identical lines about one printer and the count per
   * product — the number that says how strong the signal is — is wrong.
   *
   * Only an UNREVIEWED report blocks. Once the owner has looked, the same
   * customer finding a new price weeks later is new information, not a
   * duplicate.
   */
  const open = await c.env.DB.prepare(
    "SELECT id FROM price_reports WHERE user_id = ? AND product_id = ? AND state = 'new'"
  )
    .bind(user.id, productId)
    .first<{ id: string }>();
  if (open) {
    throw conflict(
      'بلاغك عن سعر هذا المنتج وصلنا وقيد المراجعة. / We already have your price report for this product and it is being reviewed.',
      'REPORT_ALREADY_OPEN'
    );
  }

  const id = newId('prep');
  await c.env.DB.prepare(
    `INSERT INTO price_reports
       (id, user_id, product_id, price_iqd, our_price_iqd, seller_name, url, note, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`
  )
    .bind(id, user.id, productId, priceIqd, ourPrice, sellerName, url, note, nowIso())
    .run();

  return c.json({
    success: true,
    report: {
      id,
      product_id: productId,
      price_iqd: priceIqd,
      our_price_iqd: ourPrice,
      state: 'new' as ReportState,
    },
    /**
     * WHAT WE ACTUALLY PROMISE. The shop will look. Nothing here says the
     * price will be matched — see the module note — and the second sentence
     * is the honest reason the two figures can differ, so the customer is not
     * left to assume we are simply more expensive.
     */
    message:
      'وصلنا بلاغك، شكراً. راح نطّلع على السعر ونقارنه — وانتبه أن أسعارنا تشمل الضمان والدعم المحلي. / ' +
      'Thank you — we have your report and the shop will look at this price. Note that our prices include our own warranty and local support.',
  });
});

// -------------------------------------------------------------- the owner

interface AdminReportRow {
  id: string;
  product_id: string;
  price_iqd: number;
  our_price_iqd: number;
  seller_name: string;
  url: string;
  note: string;
  state: string;
  admin_note: string;
  reviewed_by: string;
  reviewed_at: string;
  created_at: string;
  product_name: string | null;
  product_name_ar: string | null;
  product_slug: string | null;
  product_price_now: number | null;
  reporter_id: string;
  reporter_name: string | null;
  reporter_username: string | null;
}

/**
 * The gap, in dinars and per cent, computed HERE rather than in the browser.
 *
 * It is the column the list is read by, so it has to mean the same thing on
 * the screen, in an export and in anything that later counts it. Positive
 * means we are more expensive — the only direction that is worth acting on.
 *
 * The per cent is null, never 0, when our frozen price was zero: a product
 * priced at 0 is «السعر عند الطلب», and dividing by it would print `Infinity`
 * or a confident-looking 100% at the top of the owner's sorted list.
 */
function gapOf(ourPrice: number, theirPrice: number): { iqd: number; percent: number | null } {
  const iqd = ourPrice - theirPrice;
  return { iqd, percent: ourPrice > 0 ? Math.round((iqd / ourPrice) * 1000) / 10 : null };
}

/**
 * GET /api/admin/price-reports?state=&product=&limit=
 *
 * The row carries everything the decision needs, so the owner never has to
 * open a product to act on a line: what it is, what WE charged when the report
 * was filed, what we charge now, what they charge, the gap both ways, who sold
 * it, the link, who said so and when.
 *
 * `product_price_now` sits beside the frozen `our_price_iqd` deliberately. The
 * two being different is the most useful thing on the screen — it means the
 * price already moved since the report, and the gap on the row is history.
 */
adminPriceReportRoutes.get('/', async (c) => {
  const state = c.req.query('state');
  const productId = str(c.req.query('product'), 'product', { max: 60, required: false });
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 200, def: 100 });

  const where: string[] = [];
  const binds: unknown[] = [];
  if (state && state !== 'all') {
    where.push('r.state = ?');
    binds.push(oneOf(state, 'state', REPORT_STATES));
  }
  if (productId) {
    where.push('r.product_id = ?');
    binds.push(productId);
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';

  /**
   * LEFT JOINs, not JOINs. Both foreign keys cascade, so a missing product or
   * a missing user should be impossible — and a list that silently drops rows
   * when the impossible happens is a list that under-reports without saying so.
   * The row still carries its own frozen figures, which is the whole point of
   * freezing them.
   */
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.product_id, r.price_iqd, r.our_price_iqd, r.seller_name, r.url, r.note,
            r.state, r.admin_note, r.reviewed_by, r.reviewed_at, r.created_at,
            p.name AS product_name, p.name_ar AS product_name_ar, p.slug AS product_slug,
            p.price_iqd AS product_price_now,
            r.user_id AS reporter_id, u.name AS reporter_name, u.username AS reporter_username
       FROM price_reports r
       LEFT JOIN products p ON p.id = r.product_id
       LEFT JOIN users u ON u.id = r.user_id
       ${filter}
      ORDER BY r.created_at DESC
      LIMIT ?`
  )
    .bind(...binds, limit)
    .all<AdminReportRow>();

  return c.json({
    success: true,
    states: REPORT_STATES,
    reports: (results ?? []).map((r) => {
      const gap = gapOf(Number(r.our_price_iqd) || 0, Number(r.price_iqd) || 0);
      return {
        id: r.id,
        product: {
          id: r.product_id,
          slug: r.product_slug,
          name_ar: r.product_name_ar || r.product_name || '',
          name_en: r.product_name || r.product_name_ar || '',
          price_now_iqd: r.product_price_now === null ? null : Number(r.product_price_now),
        },
        our_price_iqd: Number(r.our_price_iqd) || 0,
        their_price_iqd: Number(r.price_iqd) || 0,
        gap_iqd: gap.iqd,
        gap_percent: gap.percent,
        seller_name: r.seller_name,
        // A string, on purpose. See the module note: nothing follows it.
        url: r.url,
        note: r.note,
        state: r.state,
        admin_note: r.admin_note,
        reviewed_by: r.reviewed_by || null,
        reviewed_at: r.reviewed_at || null,
        reported_by: {
          id: r.reporter_id,
          name: r.reporter_name || '',
          username: r.reporter_username || '',
        },
        created_at: r.created_at,
      };
    }),
  });
});

/**
 * PATCH /api/admin/price-reports/:id — the owner's decision.
 *
 * `reviewed_by` and `reviewed_at` come from the SESSION and the clock, never
 * from the body: they are the record of who decided, and a field a caller can
 * set is not a record of anything. Audited for the same reason — «rejected» on
 * a report claiming we are 40% over is a judgement somebody should be able to
 * ask about later.
 */
adminPriceReportRoutes.patch('/:id', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const state = oneOf(body.state, 'state', REPORT_STATES);
  const adminNote = str(body.adminNote, 'adminNote', { max: MAX_NOTE, required: false });

  const existing = await c.env.DB.prepare('SELECT id, state FROM price_reports WHERE id = ?')
    .bind(id)
    .first<{ id: string; state: string }>();
  if (!existing) throw notFound('Price report not found');

  /**
   * Moving BACK to 'new' clears the review stamp rather than leaving a name
   * and a date on a report nobody has looked at. The alternative is a queue
   * whose «الجديدة» filter shows rows that claim to have been reviewed.
   */
  const reviewed = state === 'new' ? { by: '', at: '' } : { by: admin.id, at: nowIso() };

  await c.env.DB.prepare(
    'UPDATE price_reports SET state = ?, admin_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?'
  )
    .bind(state, adminNote, reviewed.by, reviewed.at, id)
    .run();

  await audit(c.env.DB, admin.id, 'price_report.update', id, { from: existing.state, to: state });

  return c.json({
    success: true,
    report: { id, state, admin_note: adminNote, reviewed_by: reviewed.by || null, reviewed_at: reviewed.at || null },
  });
});
