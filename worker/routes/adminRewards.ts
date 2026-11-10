/**
 * ADMIN → REWARDS (owner, 2026-11-03; migration 0220; docs/DECISIONS.md row
 * 286). Mounted at /api/admin/rewards, behind the /api/admin/* host and
 * no-store layers and `requireAdmin` here.
 *
 * WHO MAY DO WHAT (worker/lib/moneyAuthority.ts):
 *   · the programme's TERMS — what every printer buyer is given, what points
 *     buy — and PUBLISHING a competition are the owner's alone ('coupon_issue',
 *     the public-promotion act: DECISIONS rows 223 #3 and 228);
 *   · EXTENDING a coupon and NAMING WINNERS give value to one person: the
 *     financial scope ('gift_grant'), and the owner when the admin is that
 *     person (four eyes);
 *   · WITHDRAWING a coupon, cancelling a competition (every entry fee comes
 *     back) and writing a draft give nothing away: any admin;
 *   · A VIDEO AD (0227): creating, editing and switching one on is the owner's
 *     ('coupon_issue'), switching one off is any admin's.
 *   · GRANTING one customer a coupon gives value to that person: the financial
 *     scope ('gift_grant'), and the owner when the admin is that person (four eyes).
 *
 * The overview and the printers (DECISIONS row 298) read no cost: any admin.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, conflict, notFound, int, oneOf, str, HttpError } from '../lib/http';
import { audit, auditStatements } from '../lib/audit';
import { assertMoneyAuthority, requireMoneyAuthority } from '../lib/moneyAuthority';
import { rateLimit } from '../lib/ratelimit';
import { isSchemaMissing } from '../lib/membershipBenefits';
import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { newId, sha256Hex } from '../lib/crypto';
import { notifyStatement } from '../lib/notifications';
import {
  FILAMENT_SECTION_ID,
  MAX_VALID_DAYS,
  REWARD_COUPON_KINDS,
  getRewardConfig,
  saveRewardConfigStatement,
  validateRewardConfig,
} from '../lib/rewards/config';
import { DAY_MS, GRANT_SELECT, couponPointsBackStatements, grantSelect, grantView, mintStatements, rewardCouponCode, termsFor } from '../lib/rewards/coupons';
import { changedExactlyOne, isLostRace } from '../lib/gifts/fence';
import { SPENT_AMOUNT_SQL, SPENT_SQL } from '../lib/rewards/pool';
import { adminPrintersPage, type AdminPrinterState } from '../lib/rewards/printers';
import { emptyOverview, LIVE_OFFER_SQL, rewardsOverview } from '../lib/rewards/overview';
import { firstShopItemRefusal, shopItemsForAdmin } from '../lib/rewards/shopItems';
import { rewardText } from '../lib/rewards/strings';
import {
  cancelCompetition,
  createCompetition,
  disqualifyEntry,
  entriesForAdmin,
  finishCompetition,
  listCompetitionsForAdmin,
  parseCompetitionInput,
  prizePointsOf,
  publishCompetition,
  updateDraftCompetition,
  type WinnerPick,
} from '../lib/rewards/competitions';
import { adActiveFrom, assertAdFiles, createAd, listAdsForAdmin, parseAdInput, setAdActive, updateAd } from '../lib/rewards/ads';
import { getRewardTaskConfig } from '../lib/pointsTasks';

export const adminRewardsRoutes = new Hono<AppContext>();
adminRewardsRoutes.use('*', requireAdmin);

/** A WRITE on a database before 0220 is refused: there is nowhere to write it. */
const installedOr503 = (e: unknown): never => {
  if (isSchemaMissing(e)) throw new HttpError(503, 'The rewards tables are not installed on this database yet (migration 0220)', 'REWARDS_NOT_INSTALLED');
  throw e;
};

/**
 * A READ on a database before 0220 answers as the migrated one does, with an
 * empty list and `installed: false` (CLAUDE.md rule 2; the deploy-ahead sweeps,
 * tests/costDeployAhead.test.ts and tests/fxDeployAhead.test.ts): no reward
 * coupon, competition or entry can exist before the table that holds it.
 */
const emptyBeforeInstall = <T>(empty: T, flag: { installed: boolean }) => (e: unknown): T => {
  if (!isSchemaMissing(e)) throw e;
  flag.installed = false;
  return empty;
};

// ------------------------------------------------------------- the terms

/** Products in the FDM filament section (by section or by placement), for the owner's ticks. */
async function filamentCatalogue(db: D1Database, nowIso: string) {
  const { results } = await db
    .prepare(
      `WITH RECURSIVE branch(id) AS (
         SELECT ?1 UNION SELECT c.id FROM catalogs c JOIN branch b ON c.parent_id = b.id
       )
       SELECT p.id, p.slug, p.name, p.name_ar, p.name_ku, p.status, ${LIVE_OFFER_SQL('p.id', '?2')} AS on_offer
         FROM products p
        WHERE (p.category_id IN (SELECT id FROM branch) OR p.sub_category_id IN (SELECT id FROM branch)
               OR EXISTS (SELECT 1 FROM product_catalogs pc WHERE pc.product_id = p.id AND pc.catalog_id IN (SELECT id FROM branch)))
          AND p.status <> 'draft'
        ORDER BY p.name
        LIMIT 400`
    )
    .bind(FILAMENT_SECTION_ID, nowIso)
    .all<{ id: string; slug: string; name: string; name_ar: string; name_ku: string; status: string; on_offer: number }>();
  return (results ?? []).map((p) => ({ id: p.id, slug: p.slug, name: { ar: p.name_ar || p.name, en: p.name, ckb: p.name_ku || p.name }, status: p.status, on_offer: Number(p.on_offer) === 1 }));
}

adminRewardsRoutes.get('/config', async (c) => {
  const db = c.env.DB;
  const config = await getRewardConfig(db);
  const [filaments, shopProducts, summary] = await Promise.all([
    filamentCatalogue(db, new Date().toISOString()),
    shopItemsForAdmin(c.env, config.shop.items),
    db
      .prepare(
        `SELECT g.kind, g.source,
                SUM(CASE WHEN ${SPENT_SQL('g.coupon_id')} THEN 1 ELSE 0 END) AS used,
                COUNT(*) AS issued,
                COALESCE(SUM(g.points_spent), 0) AS points_spent
           FROM reward_grants g GROUP BY g.kind, g.source`
      )
      .all<{ kind: string; source: string; used: number; issued: number; points_spent: number }>()
      .then((r) => ({ installed: true, rows: r.results ?? [] }))
      .catch((e: unknown) => {
        if (isSchemaMissing(e)) return { installed: false, rows: [] };
        throw e;
      }),
  ]);
  return c.json({ success: true, config, filaments, shop_products: shopProducts, filament_section_id: FILAMENT_SECTION_ID, installed: summary.installed, summary: summary.rows });
});

adminRewardsRoutes.put('/config', requireMoneyAuthority('coupon_issue'), async (c) => {
  const admin = c.get('user')!;
  const body = await c.req.json().catch(() => null);
  const before = await getRewardConfig(c.env.DB);
  const check = validateRewardConfig(body, before);
  if (!check.ok) throw badRequest(check.error, check.code, check.details);
  // The products this save names (DECISIONS row 299): each one on sale must be something the
  // store can sell, whatever today's stock, or a typo would reach a customer. An older screen
  // that sends no list does not answer for rows it never saw.
  if ((body as { shop?: { items?: unknown } }).shop?.items !== undefined) {
    const refused = await firstShopItemRefusal(c.env, check.value.shop.items);
    if (refused) throw badRequest(`This product cannot be sold for points (${refused.code}).`, refused.code, { item_id: refused.item_id, item_index: refused.item_index, errors: refused.errors });
  }
  await c.env.DB.batch([saveRewardConfigStatement(c.env.DB, check.value)]);
  await audit(c.env.DB, admin.id, 'rewards.config', 'rewardProgramConfig', { before, after: check.value });
  return c.json({ success: true, config: check.value, shop_products: await shopItemsForAdmin(c.env, check.value.shop.items) });
});

// ------------------------------------------------------------- the coupons

/** A page of the coupons list: enough to scroll, and the cursor brings the next. */
const GRANTS_PAGE = 50;

adminRewardsRoutes.get('/grants', async (c) => {
  const nowIso = new Date().toISOString();
  const state = c.req.query('state') ?? '';
  const kind = c.req.query('kind') ?? '';
  const source = c.req.query('source') ?? '';
  // likePattern bounds the term in BYTES (D1 refuses a pattern over 50) and escapes it.
  const pattern = likePattern(c.req.query('q'));
  const where: string[] = [];
  const binds: unknown[] = [nowIso];
  if (['free_shipping', 'filament_discount'].includes(kind)) { binds.push(kind); where.push(`g.kind = ?${binds.length}`); }
  if (['printer', 'points_shop', 'admin'].includes(source)) { binds.push(source); where.push(`g.source = ?${binds.length}`); }
  const orderItemId = c.req.query('order_item_id') ?? '';
  if (orderItemId) { binds.push(orderItemId); where.push(`g.order_item_id = ?${binds.length}`); }
  const unitIndex = c.req.query('unit_index') ?? '';
  if (unitIndex) { binds.push(int(unitIndex, 'unit_index', { min: 1, max: 1000 })); where.push(`g.unit_index = ?${binds.length}`); }
  const userId = c.req.query('user_id') ?? '';
  if (userId) { binds.push(userId); where.push(`g.user_id = ?${binds.length}`); }
  if (pattern) {
    binds.push(pattern);
    where.push(`(${sqlLikeClause(['c.code', 'g.order_id', 'u.name', 'u.username', 'u.email'], `?${binds.length}`)})`);
  }
  const outer: string[] = [];
  if (['active', 'used', 'expired', 'revoked'].includes(state)) {
    binds.push(state);
    outer.push(`state = ?${binds.length}`);
  }
  const cursor = c.req.query('cursor') ?? '';
  if (cursor) {
    const m = /^([^|]+)\|([^|]+)$/.exec(cursor);
    if (!m) throw badRequest('That page of coupons does not exist', 'BAD_CURSOR');
    binds.push(m[1], m[2]);
    outer.push(`(issued_at < ?${binds.length - 1} OR (issued_at = ?${binds.length - 1} AND id < ?${binds.length}))`);
  }
  const inner = grantSelect('?1', {
    columns: `u.name AS user_name, u.username, u.email, ${SPENT_AMOUNT_SQL('g.coupon_id')} AS amount_spent_iqd`,
    joins: 'JOIN users u ON u.id = g.user_id',
  });
  const sql = `SELECT * FROM (${inner} ${where.length ? `WHERE ${where.join(' AND ')}` : ''})
     ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
     ORDER BY issued_at DESC, id DESC LIMIT ${GRANTS_PAGE + 1}`;
  const flag = { installed: true };
  const { results } = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>()
    .catch(emptyBeforeInstall({ results: [] as Record<string, unknown>[] } as D1Result<Record<string, unknown>>, flag));
  const rows = results ?? [];
  const page = rows.slice(0, GRANTS_PAGE);
  const last = page[page.length - 1];
  return c.json({
    success: true,
    installed: flag.installed,
    grants: page.map((r) => ({
      ...grantView(r as never),
      amount_spent_iqd: Math.max(0, Math.trunc(Number(r.amount_spent_iqd) || 0)),
      user: { id: String(r.user_id ?? ''), name: String(r.user_name ?? ''), username: String(r.username ?? ''), email: String(r.email ?? '') },
    })),
    next_cursor: rows.length > GRANTS_PAGE && last ? `${String(last.issued_at)}|${String(last.id)}` : null,
  });
});

// ------------------------------------------------- the whole programme (DECISIONS row 298)

/** «نظرة عامة»: what the programme does now and what it has given. No cost. Zeros before 0220/0225. */
adminRewardsRoutes.get('/overview', async (c) => {
  const nowIso = new Date().toISOString();
  const overview = await rewardsOverview(c.env.DB, nowIso).catch((e: unknown) => {
    if (isSchemaMissing(e)) return emptyOverview(nowIso);
    throw e;
  });
  return c.json({ success: true, ...overview });
});

/** «الطابعات»: every printer unit, earning or why not, paged and searched by customer, order or serial. */
adminRewardsRoutes.get('/printers', async (c) => {
  const raw = c.req.query('state') ?? 'all';
  const state: AdminPrinterState = raw === 'earning' || raw === 'stopped' ? raw : 'all';
  const flag = { installed: true };
  const page = await adminPrintersPage(c.env.DB, { state, q: c.req.query('q'), cursor: c.req.query('cursor') }).catch(
    emptyBeforeInstall({ printers: [], next_cursor: null } as Awaited<ReturnType<typeof adminPrintersPage>>, flag)
  );
  return c.json({ success: true, installed: flag.installed, ...page });
});

/**
 * «منح كوبون»: one coupon to one customer, on today's terms, from the team. It gives
 * value to a person, so the financial scope grants it, and the owner when the admin is
 * that person (four eyes), with a reason on the audit row. One batch: the coupon, its
 * grant, the customer's notice and the audit row stand or fall together. A repeated
 * request with the same key, customer and kind is the same coupon: one opening of the
 * dialog keeps its key, so changing the customer after a lost answer is a new grant,
 * never a «granted» that names the wrong person.
 */
adminRewardsRoutes.post('/grants', requireMoneyAuthority('gift_grant'), async (c) => {
  await rateLimit(c, 'reward_admin_grant', 60, 300);
  const admin = c.get('user')!;
  const db = c.env.DB;
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const userId = str(body.user_id, 'user_id', { min: 1, max: 80 });
  const kind = oneOf(body.kind, 'kind', REWARD_COUPON_KINDS);
  const reason = str(body.reason, 'reason', { min: 3, max: 200 });
  const authority = assertMoneyAuthority(c, { act: 'gift_grant', beneficiaryUserId: userId, reason });
  const key = str(body.idempotency_key, 'idempotency_key', { max: 80, required: false });
  const grantId = key ? `rwg_${(await sha256Hex(`reward-admin-grant:${admin.id}:${key}:${userId}:${kind}`)).slice(0, 24)}` : newId('rwg');
  const nowIso = new Date().toISOString();
  const readBack = () => db.prepare(`${GRANT_SELECT('?2')} WHERE g.id = ?1`).bind(grantId, nowIso).first<Record<string, unknown>>();
  // The same read answers a repeated press, and refuses before anything is written on a database without 0220/0225.
  const prior = await readBack().catch(installedOr503);
  if (prior) return c.json({ success: true, replay: true, coupon: grantView(prior as never) });
  const customer = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  if (!customer) throw new HttpError(404, 'Customer not found', 'USER_NOT_FOUND');
  const config = await getRewardConfig(db);
  const validDays = int(body.valid_days, 'valid_days', { min: 1, max: MAX_VALID_DAYS, def: config.valid_days });
  const expiresAt = new Date(Date.parse(nowIso) + validDays * DAY_MS).toISOString();
  const text = rewardText({
    kind: 'team_coupon',
    until: expiresAt.slice(0, 10),
    percent: config.filament.percent,
    amount: config.free_shipping.amount_iqd,
    min: config.free_shipping.min_order_iqd,
    pieces: config.filament.max_pieces,
    kinds: [kind],
  });
  const audited = await auditStatements(db, admin.id, 'rewards.grant', grantId, { user_id: userId, kind, valid_days: validDays, reason, authority: authority.audit });
  await db
    .batch([
      ...mintStatements(db, {
        grantId,
        couponId: newId('cpn'),
        code: rewardCouponCode(kind),
        userId,
        source: 'admin',
        sourceRef: `admin:${grantId}`,
        orderId: null,
        orderItemId: null,
        unitIndex: null,
        terms: { ...termsFor(kind, config), valid_days: validDays },
        issuedAt: nowIso,
        expiresAt,
        createdBy: admin.id,
      }),
      notifyStatement(db, {
        userId,
        kind: 'reward',
        title_ar: text.title.ar,
        title_en: text.title.en,
        body_ar: text.body.ar,
        body_en: text.body.en,
        link: '/rewards/coupons',
        entity_type: 'reward_grant',
        entity_id: grantId,
        meta: { title_ckb: text.title.ckb, body_ckb: text.body.ckb, expires_at: expiresAt },
        eventKey: `reward:team:${grantId}`,
      }).stmt,
      ...audited.statements,
    ])
    .catch(installedOr503);
  const row = await readBack();
  return c.json({ success: true, coupon: row ? grantView(row as never) : null }, 201);
});

adminRewardsRoutes.post('/grants/:id/revoke', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = str(body.reason, 'reason', { min: 3, max: 200 });
  const nowIso = new Date().toISOString();
  const g = await c.env.DB.prepare(`${GRANT_SELECT('?2')} WHERE g.id = ?1`).bind(id, nowIso).first<Record<string, unknown>>().catch(installedOr503);
  if (!g) throw notFound('Reward coupon not found');
  if (g.state === 'used') throw conflict('This coupon was already spent on an order; it stays with that order', 'REWARD_COUPON_USED');
  if (g.state === 'revoked') return c.json({ success: true, already: true });
  // A live coupon bought with points gives them back in this batch, once (row 303 R2; policy 14.10). The
  // fence after the flip makes a concurrent or replayed withdrawal write nothing, so nothing comes back twice.
  const pointsBack = couponPointsBackStatements(c.env.DB, g, nowIso);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE reward_grants SET revoked_at = ?1, revoke_reason = 'admin' WHERE id = ?2 AND revoked_at IS NULL").bind(nowIso, id),
      ...changedExactlyOne(c.env.DB),
      c.env.DB.prepare('UPDATE coupons SET active = 0 WHERE reward_grant_id = ?1').bind(id),
      ...pointsBack,
    ]);
  } catch (e) {
    if (isLostRace(e)) return c.json({ success: true, already: true });
    throw e;
  }
  const returned = pointsBack.length
    ? Number((await c.env.DB.prepare('SELECT amount FROM wallet_transactions WHERE id = ? AND decided_at = ?').bind(`wtx_rwshop_back_${id}`, nowIso).first<{ amount: number }>())?.amount) || 0
    : 0;
  await audit(c.env.DB, admin.id, 'rewards.revoke', id, { reason, changed: 1, ...(returned > 0 ? { points_returned: returned } : {}) });
  return c.json({ success: true, points_returned: returned });
});

/** Gives an unused coupon more days — a customer whose week ran out through the shop's delay. */
adminRewardsRoutes.post('/grants/:id/extend', requireMoneyAuthority('gift_grant'), async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const days = int(body.days, 'days', { min: 1, max: 30 });
  const reason = str(body.reason, 'reason', { min: 3, max: 200 });
  const nowIso = new Date().toISOString();
  const g = await c.env.DB.prepare(`${GRANT_SELECT('?2')} WHERE g.id = ?1`).bind(id, nowIso).first<Record<string, unknown>>().catch(installedOr503);
  if (!g) throw notFound('Reward coupon not found');
  const owner = await c.env.DB.prepare('SELECT user_id FROM reward_grants WHERE id = ?').bind(id).first<{ user_id: string }>();
  const grant = assertMoneyAuthority(c, { act: 'gift_grant', beneficiaryUserId: owner?.user_id ?? null, reason });
  if (g.state === 'used') throw conflict('This coupon was already spent on an order', 'REWARD_COUPON_USED');
  if (g.state === 'revoked') throw conflict('This coupon was withdrawn', 'REWARD_COUPON_REVOKED');
  // From the later of its end and now: an expired coupon gets `days` from today.
  const base = Math.max(Date.parse(String(g.expires_at)), Date.parse(nowIso));
  const until = new Date(base + days * DAY_MS).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE coupons SET ends_at = ?1 WHERE reward_grant_id = ?2 AND active = 1').bind(until, id),
    c.env.DB.prepare('UPDATE reward_grants SET expires_at = ?1, reminded_at = NULL WHERE id = ?2 AND revoked_at IS NULL').bind(until, id),
  ]);
  await audit(c.env.DB, admin.id, 'rewards.extend', id, { days, until, reason, authority: grant.audit });
  return c.json({ success: true, expires_at: until });
});

// ------------------------------------------------------------- competitions

adminRewardsRoutes.get('/competitions', async (c) => {
  const flag = { installed: true };
  const competitions = await listCompetitionsForAdmin(c.env.DB).catch(emptyBeforeInstall([] as Awaited<ReturnType<typeof listCompetitionsForAdmin>>, flag));
  return c.json({ success: true, installed: flag.installed, competitions });
});

adminRewardsRoutes.post('/competitions', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const input = parseCompetitionInput(body);
  const id = await createCompetition(c.env.DB, admin.id, input).catch(installedOr503);
  await audit(c.env.DB, admin.id, 'competition.create', id, { title: input.title.ar });
  return c.json({ success: true, id }, 201);
});

adminRewardsRoutes.put('/competitions/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const input = parseCompetitionInput(body);
  await updateDraftCompetition(c.env.DB, id, input).catch(installedOr503);
  await audit(c.env.DB, admin.id, 'competition.update', id, { title: input.title.ar });
  return c.json({ success: true });
});

adminRewardsRoutes.post('/competitions/:id/publish', requireMoneyAuthority('coupon_issue'), async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  await publishCompetition(c.env.DB, id).catch(installedOr503);
  await audit(c.env.DB, admin.id, 'competition.publish', id);
  return c.json({ success: true });
});

adminRewardsRoutes.post('/competitions/:id/cancel', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = str(body.reason, 'reason', { min: 3, max: 200 });
  const out = await cancelCompetition(c.env, id).catch(installedOr503);
  await audit(c.env.DB, admin.id, 'competition.cancel', id, { reason, refunded: out.refunded });
  return c.json({ success: true, ...out });
});

adminRewardsRoutes.get('/competitions/:id/entries', async (c) => {
  const id = c.req.param('id') ?? '';
  const flag = { installed: true };
  const entries = await entriesForAdmin(c.env.DB, id).catch(emptyBeforeInstall([] as Awaited<ReturnType<typeof entriesForAdmin>>, flag));
  return c.json({ success: true, installed: flag.installed, entries });
});

adminRewardsRoutes.post('/competitions/:id/entries/:entryId/disqualify', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const entryId = c.req.param('entryId') ?? '';
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const note = str(body.note, 'note', { min: 3, max: 300 });
  await disqualifyEntry(c.env.DB, id, entryId, note).catch(installedOr503);
  await audit(c.env.DB, admin.id, 'competition.disqualify', entryId, { competition_id: id, note });
  return c.json({ success: true });
});

adminRewardsRoutes.post('/competitions/:id/finish', requireMoneyAuthority('gift_grant'), async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const winners = Array.isArray(body.winners) ? (body.winners as unknown[]) : null;
  if (!winners) throw badRequest('winners must be a list of { entry_id, place }', 'COMPETITION_WINNERS_INVALID');
  const picks: WinnerPick[] = winners.map((w) => {
    const o = (w && typeof w === 'object' ? w : {}) as Record<string, unknown>;
    return { entry_id: str(o.entry_id, 'entry_id', { min: 1, max: 64 }), place: int(o.place, 'place', { min: 1, max: 10 }) };
  });
  const reason = str(body.reason, 'reason', { max: 200, required: false });
  const competition = await c.env.DB.prepare('SELECT prize_points FROM reward_competitions WHERE id = ?').bind(id).first<{ prize_points: string }>().catch(installedOr503);
  if (!competition) throw notFound('Competition not found');
  const prizes = prizePointsOf(competition.prize_points);
  // FOUR EYES, PER WINNER: a prize paid to the admin naming it is the owner's call.
  const { results: owners } = picks.length
    ? await c.env.DB.prepare('SELECT id, user_id FROM reward_competition_entries WHERE competition_id = ?1 AND id IN (SELECT value FROM json_each(?2))')
        .bind(id, JSON.stringify(picks.map((p) => p.entry_id)))
        .all<{ id: string; user_id: string }>()
    : { results: [] as Array<{ id: string; user_id: string }> };
  const ownerOf = new Map((owners ?? []).map((o) => [o.id, o.user_id]));
  const grants = picks.map((p) =>
    assertMoneyAuthority(c, { act: 'gift_grant', amountIqd: prizes[p.place - 1] ?? 0, beneficiaryUserId: ownerOf.get(p.entry_id) ?? null, reason })
  );
  const out = await finishCompetition(c.env, id, picks);
  await audit(c.env.DB, admin.id, 'competition.finish', id, { winners: picks, points: out.points, authority: grants.map((g) => g.audit) });
  return c.json({ success: true, ...out });
});

// ------------------------------------------------------------- the video ads

/**
 * THE ADS OF «اجمع النقاط» (migration 0227, docs/DECISIONS.md row 300). What
 * every customer is shown and paid for is the owner's act ('coupon_issue',
 * the public-promotion act): creating, editing and switching on. Switching OFF
 * gives nothing away: any admin. Reading is any admin: views and points paid are
 * no cost. A database before 0227 lists nothing and refuses a write with 503.
 */
adminRewardsRoutes.get('/ads', async (c) => {
  const flag = { installed: true };
  const [ads, tasks] = await Promise.all([
    listAdsForAdmin(c.env.DB, new Date().toISOString()).catch(emptyBeforeInstall([] as Awaited<ReturnType<typeof listAdsForAdmin>>, flag)),
    getRewardTaskConfig(c.env),
  ]);
  return c.json({ success: true, installed: flag.installed, ads, mission_enabled: tasks.video_enabled });
});

adminRewardsRoutes.post('/ads', requireMoneyAuthority('coupon_issue'), async (c) => {
  const admin = c.get('user')!;
  const input = parseAdInput((await c.req.json().catch(() => ({}))) as Record<string, unknown>);
  await assertAdFiles(c.env.DB, input);
  const id = await createAd(c.env.DB, admin.id, input, new Date().toISOString());
  await audit(c.env.DB, admin.id, 'rewards.ad.create', id, { title: input.title.ar, active: input.active, window: [input.starts_at, input.ends_at], max_views: input.max_views });
  return c.json({ success: true, id }, 201);
});

adminRewardsRoutes.put('/ads/:id', requireMoneyAuthority('coupon_issue'), async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const input = parseAdInput((await c.req.json().catch(() => ({}))) as Record<string, unknown>);
  await assertAdFiles(c.env.DB, input);
  await updateAd(c.env.DB, id, input, new Date().toISOString());
  await audit(c.env.DB, admin.id, 'rewards.ad.update', id, { title: input.title.ar, active: input.active, window: [input.starts_at, input.ends_at], max_views: input.max_views });
  return c.json({ success: true });
});

adminRewardsRoutes.post('/ads/:id/toggle', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const active = adActiveFrom((await c.req.json().catch(() => ({}))) as Record<string, unknown>);
  if (active) assertMoneyAuthority(c, { act: 'coupon_issue' });
  const out = await setAdActive(c.env.DB, id, active, new Date().toISOString());
  if (out.changed) await audit(c.env.DB, admin.id, 'rewards.ad.toggle', id, { active });
  return c.json({ success: true, active, changed: out.changed });
});
