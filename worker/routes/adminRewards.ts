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
 *     back) and writing a draft give nothing away: any admin.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, conflict, notFound, int, str, HttpError } from '../lib/http';
import { audit } from '../lib/audit';
import { assertMoneyAuthority, requireMoneyAuthority } from '../lib/moneyAuthority';
import { isSchemaMissing } from '../lib/membershipBenefits';
import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import {
  FILAMENT_SECTION_ID,
  getRewardConfig,
  saveRewardConfigStatement,
  validateRewardConfig,
} from '../lib/rewards/config';
import { DAY_MS, GRANT_SELECT, grantSelect, grantView } from '../lib/rewards/coupons';
import { SPENT_SQL } from '../lib/rewards/pool';
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
async function filamentCatalogue(db: D1Database) {
  const { results } = await db
    .prepare(
      `WITH RECURSIVE branch(id) AS (
         SELECT ?1 UNION SELECT c.id FROM catalogs c JOIN branch b ON c.parent_id = b.id
       )
       SELECT p.id, p.slug, p.name, p.name_ar, p.name_ku, p.status
         FROM products p
        WHERE (p.category_id IN (SELECT id FROM branch) OR p.sub_category_id IN (SELECT id FROM branch)
               OR EXISTS (SELECT 1 FROM product_catalogs pc WHERE pc.product_id = p.id AND pc.catalog_id IN (SELECT id FROM branch)))
          AND p.status <> 'draft'
        ORDER BY p.name
        LIMIT 400`
    )
    .bind(FILAMENT_SECTION_ID)
    .all<{ id: string; slug: string; name: string; name_ar: string; name_ku: string; status: string }>();
  return (results ?? []).map((p) => ({ id: p.id, slug: p.slug, name: { ar: p.name_ar || p.name, en: p.name, ckb: p.name_ku || p.name }, status: p.status }));
}

adminRewardsRoutes.get('/config', async (c) => {
  const db = c.env.DB;
  const [config, filaments, summary] = await Promise.all([
    getRewardConfig(db),
    filamentCatalogue(db),
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
  return c.json({ success: true, config, filaments, filament_section_id: FILAMENT_SECTION_ID, installed: summary.installed, summary: summary.rows });
});

adminRewardsRoutes.put('/config', requireMoneyAuthority('coupon_issue'), async (c) => {
  const admin = c.get('user')!;
  const body = await c.req.json().catch(() => null);
  const check = validateRewardConfig(body);
  if (!check.ok) throw badRequest(check.error, check.code);
  const before = await getRewardConfig(c.env.DB);
  await c.env.DB.batch([saveRewardConfigStatement(c.env.DB, check.value)]);
  await audit(c.env.DB, admin.id, 'rewards.config', 'rewardProgramConfig', { before, after: check.value });
  return c.json({ success: true, config: check.value });
});

// ------------------------------------------------------------- the coupons

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
  if (pattern) {
    binds.push(pattern);
    where.push(`(${sqlLikeClause(['c.code', 'g.order_id', 'u.name', 'u.username', 'u.email'], `?${binds.length}`)})`);
  }
  let stateFilter = '';
  if (['active', 'used', 'expired', 'revoked'].includes(state)) {
    binds.push(state);
    stateFilter = `WHERE state = ?${binds.length}`;
  }
  const inner = grantSelect('?1', { columns: 'u.name AS user_name, u.username, u.email', joins: 'JOIN users u ON u.id = g.user_id' });
  const sql = `SELECT * FROM (${inner} ${where.length ? `WHERE ${where.join(' AND ')}` : ''})
     ${stateFilter}
     ORDER BY issued_at DESC LIMIT 200`;
  const flag = { installed: true };
  const { results } = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>()
    .catch(emptyBeforeInstall({ results: [] as Record<string, unknown>[] } as D1Result<Record<string, unknown>>, flag));
  return c.json({
    success: true,
    installed: flag.installed,
    grants: (results ?? []).map((r) => ({
      ...grantView(r as never),
      user: { id: String(r.user_id ?? ''), name: String(r.user_name ?? ''), username: String(r.username ?? ''), email: String(r.email ?? '') },
    })),
  });
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
  const res = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE reward_grants SET revoked_at = ?1, revoke_reason = 'admin' WHERE id = ?2 AND revoked_at IS NULL").bind(nowIso, id),
    c.env.DB.prepare('UPDATE coupons SET active = 0 WHERE reward_grant_id = ?1').bind(id),
  ]);
  await audit(c.env.DB, admin.id, 'rewards.revoke', id, { reason, changed: res[0]?.meta.changes ?? 0 });
  return c.json({ success: true });
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
