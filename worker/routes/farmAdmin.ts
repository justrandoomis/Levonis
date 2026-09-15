/**
 * LEVO Printer Farm — the balancing console (docs/PRINTER_FARM.md §4 Admin),
 * mounted at /api/admin/farm so worker/index.ts's apex-only host guard covers
 * it; a merchant subdomain answers 404 even to an admin.
 *
 * The ONLY write path for `printerFarmConfig`. A section is replaced, the
 * whole document normalised, `farmConfigProblems` consulted (400 with the
 * list), `version` bumped, stored, and audited with before/after of that
 * section — so a balancing change is always traceable to who, what and which
 * version. `expected_version` makes two admins editing at once safe: the
 * second save sees 409 and reloads instead of silently reverting the first.
 *
 * SCOPE (mandate §11, worker/lib/adminScope.ts). The anti-abuse `limits`, the
 * Points `rewards` budget and coin grants are money rules: an assistant admin
 * (`admin_scope = 'assistant'`) reads the console and edits the game's
 * balancing sections, but those three answer 403 FINANCIAL_SCOPE_REQUIRED.
 * The owner (INITIAL_ADMIN_EMAIL) is always allowed.
 */

import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import type { Context } from 'hono';
import { HttpError, badRequest, conflict, notFound, requireAdmin, str, int } from '../lib/http';
import { audit } from '../lib/audit';
import { canViewFinancials } from '../lib/adminScope';
import { getSetting, setSetting } from '../lib/settings';
import {
  FARM_CONFIG_DEFAULTS, FARM_CONFIG_SECTIONS, farmConfigProblems, normalizeFarmConfig, publicFarmConfig,
  type FarmConfig, type FarmConfigSection,
} from '../lib/farm/config';
import { BALANCE_SQL, isInsufficientCoins, isLedgerReplay, ledgerInsertStatement, requestLedgerId } from '../lib/farm/ledger';
import { FARM_SHELVED_SETTING_KEY, ensureFarmState, farmIsShelved, loadFarmConfig, loadFarmState, stateBody } from './farm';
import type { FarmEventRow, FarmJobRow } from '../lib/farm/types';

export const farmAdminRoutes = new Hono<AppContext>();
farmAdminRoutes.use('*', requireAdmin);

const isSection = (v: string): v is FarmConfigSection => (FARM_CONFIG_SECTIONS as readonly string[]).includes(v);

/** Config sections that are money rules, not game balancing: financial scope only. */
export const FINANCIAL_SECTIONS: readonly FarmConfigSection[] = ['limits', 'rewards'] as const;

function requireFinancial(c: Context<AppContext>): void {
  if (!canViewFinancials(c.env, c.get('user'))) {
    throw new HttpError(
      403,
      'هذا الإجراء للمالك أو الدور المالي فقط / This action needs the owner or a financial admin',
      'FINANCIAL_SCOPE_REQUIRED'
    );
  }
}

/** An admin grant's ledger key lives in its own namespace: it never collides with the player's own request keys. */
const adminLedgerKey = (key: string) => `adm:${key}`;

async function loadStored(db: D1Database): Promise<FarmConfig> {
  return normalizeFarmConfig(await getSetting(db, 'printerFarmConfig'));
}

// ---------------------------------------------------------------- config

farmAdminRoutes.get('/config', async (c) => {
  const config = await loadStored(c.env.DB);
  return c.json({
    success: true,
    version: config.version,
    config,
    defaults: FARM_CONFIG_DEFAULTS,
    public: publicFarmConfig(config),
    problems: farmConfigProblems(config),
    sections: FARM_CONFIG_SECTIONS,
  });
});

farmAdminRoutes.put('/config/:section', async (c) => {
  const admin = c.get('user')!;
  const section = c.req.param('section');
  if (!isSection(section)) throw badRequest(`Unknown section; one of ${FARM_CONFIG_SECTIONS.join(', ')}`, 'FARM_SECTION_UNKNOWN');
  if (FINANCIAL_SECTIONS.includes(section)) requireFinancial(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const expected = int(body.expected_version, 'expected_version', { min: 0, max: 1_000_000_000 });
  if (body.value === undefined || body.value === null) throw badRequest('value is required');
  if (JSON.stringify(body.value).length > 400_000) throw badRequest('value is too large');

  const current = await loadStored(c.env.DB);
  if (expected !== current.version) {
    throw new HttpError(
      409,
      'تغيّرت الإعدادات من جهة أخرى — أعد التحميل / The configuration changed elsewhere — reload before saving',
      'CONFIG_VERSION_MISMATCH',
      { current_version: current.version }
    );
  }
  // Replace ONE section, then normalise the WHOLE document with the same
  // function every reader uses; what survives here is exactly what the engine
  // will run on.
  const next = normalizeFarmConfig({ ...current, [section]: body.value });
  const problems = farmConfigProblems(next);
  if (problems.length) {
    throw badRequest('الإعدادات غير صالحة / Invalid farm configuration', 'FARM_CONFIG_INVALID', { problems });
  }
  next.version = current.version + 1;
  await setSetting(c.env.DB, 'printerFarmConfig', next);
  await audit(c.env.DB, admin.id, 'farm.config_update', section, {
    version: next.version,
    before: current[section],
    after: next[section],
  });
  return c.json({ success: true, version: next.version, config: next, problems: [] });
});

farmAdminRoutes.post('/config/:section/reset', async (c) => {
  const admin = c.get('user')!;
  const section = c.req.param('section');
  if (!isSection(section)) throw badRequest(`Unknown section; one of ${FARM_CONFIG_SECTIONS.join(', ')}`, 'FARM_SECTION_UNKNOWN');
  if (FINANCIAL_SECTIONS.includes(section)) requireFinancial(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.confirm !== 'RESET') throw badRequest('اكتب RESET للتأكيد / Type RESET to confirm', 'CONFIRM_REQUIRED');
  const current = await loadStored(c.env.DB);
  const next = normalizeFarmConfig({ ...current, [section]: FARM_CONFIG_DEFAULTS[section] });
  const problems = farmConfigProblems(next);
  if (problems.length) throw badRequest('الإعدادات غير صالحة / Invalid farm configuration', 'FARM_CONFIG_INVALID', { problems });
  next.version = current.version + 1;
  await setSetting(c.env.DB, 'printerFarmConfig', next);
  await audit(c.env.DB, admin.id, 'farm.config_reset', section, { version: next.version, before: current[section] });
  return c.json({ success: true, version: next.version, config: next, problems: [] });
});

// ---------------------------------------------------------------- shelving

/**
 * THE ONE SWITCH that decides whether customers may play — «قريبا — تحت
 * التطوير» while it is closed (worker/routes/farm.ts, "the shelving switch").
 *
 * Read and written here, and nowhere else, so every flip is audited with who
 * did it and which way it went. It is NOT part of `printerFarmConfig`: that
 * document is balancing and needs a matching `expected_version`, and a version
 * race is the last thing anybody wants between them and closing a game.
 *
 * SCOPE. CLOSING is a safety action any platform admin may take — shutting a
 * door harms nobody. OPENING starts an economy that mints Farm Coins, so it
 * follows the same rule as `limits` and `rewards` (mandate §11): the owner or
 * a financial admin only. An assistant can therefore stop the game in an
 * incident but cannot turn the coin faucet back on.
 */
farmAdminRoutes.get('/shelved', async (c) => {
  const shelved = await farmIsShelved(c.env.DB);
  return c.json({ success: true, shelved, key: FARM_SHELVED_SETTING_KEY });
});

farmAdminRoutes.put('/shelved', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.open !== 'boolean') {
    throw badRequest('open must be true or false', 'FARM_OPEN_REQUIRED');
  }
  const open = body.open;
  if (open) requireFinancial(c);
  const before = await farmIsShelved(c.env.DB);
  const nowIso = new Date().toISOString();
  // The same upsert `setSetting` uses; the key is not a typed SETTING_DEFAULTS
  // entry because the generic settings PUT must not be able to open a game
  // without an audit row naming who opened it.
  await c.env.DB
    .prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(FARM_SHELVED_SETTING_KEY, JSON.stringify({ open, updated_at: nowIso, by: admin.id }))
    .run();
  await audit(c.env.DB, admin.id, 'farm.shelved_update', FARM_SHELVED_SETTING_KEY, {
    before_shelved: before,
    after_shelved: !open,
  });
  return c.json({ success: true, shelved: !open, changed: before !== !open });
});

// ---------------------------------------------------------------- players

farmAdminRoutes.get('/players/:userId', async (c) => {
  const userId = str(c.req.param('userId'), 'userId', { min: 1, max: 80 });
  const db = c.env.DB;
  const user = await db.prepare('SELECT id, username, name, email FROM users WHERE id = ?').bind(userId)
    .first<{ id: string; username: string | null; name: string; email: string }>();
  if (!user) throw notFound('User not found');
  const nowIso = new Date().toISOString();
  const cfg = await loadFarmConfig(db);
  const state = await loadFarmState(db, userId, nowIso);
  if (!state) return c.json({ success: true, user, farm: null });
  const [ledger, jobs, events] = await Promise.all([
    db.prepare('SELECT id, kind, amount, note, ref_type, ref_id, idempotency_key, created_at FROM farm_ledger WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 30')
      .bind(userId).all(),
    db.prepare('SELECT * FROM farm_jobs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50').bind(userId).all<FarmJobRow>(),
    db.prepare('SELECT * FROM farm_events WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50').bind(userId).all<FarmEventRow>(),
  ]);
  // Read-only: the player's farm is shown as it stands, not resolved — an
  // admin opening a profile must not move a print or pay a job.
  const body = stateBody(state, cfg, nowIso, [], false);
  // The offer salt is the player's secret against offline offer forecasting;
  // it stays on the server even for the owner's eyes.
  const { offer_salt: _salt, ...rawProfile } = state.profile;
  void _salt;
  return c.json({
    success: true,
    user,
    farm: {
      ...body,
      raw_profile: rawProfile,
      ledger_tail: ledger.results,
      jobs_recent: jobs.results,
      events_recent: events.results,
      // Outcome seeds decide prints that have not finished; they stay on the server.
      assignments: state.assignments.map(({ outcome_seed: _seed, ...rest }) => { void _seed; return rest; }),
    },
  });
});

farmAdminRoutes.post('/players/:userId/grant', async (c) => {
  requireFinancial(c);
  const admin = c.get('user')!;
  const userId = str(c.req.param('userId'), 'userId', { min: 1, max: 80 });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const amount = int(body.amount, 'amount', { min: -10_000_000, max: 10_000_000 });
  if (amount === 0) throw badRequest('amount must not be 0');
  const reason = str(body.reason, 'reason', { min: 3, max: 300 });
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { min: 8, max: 80 });
  const db = c.env.DB;
  const target = await db.prepare('SELECT id, username, name, email, role FROM users WHERE id = ?').bind(userId)
    .first<{ id: string; username: string | null; name: string; email: string; role: string }>();
  if (!target) throw notFound('User not found');
  const nowIso = new Date().toISOString();
  const cfg = await loadFarmConfig(db);
  // A player who never opened the game gets a farm first, so the grant lands
  // on a ledger that exists and shows up on their first visit.
  await ensureFarmState(db, { ...target, role: target.role as 'customer' } as never, cfg, nowIso);

  const prior = await db.prepare('SELECT id, kind, amount FROM farm_ledger WHERE user_id = ? AND idempotency_key = ?')
    .bind(userId, adminLedgerKey(idempotencyKey))
    .first<{ id: string; kind: string; amount: number }>();
  const balanceOf = async () => Number((await db.prepare(BALANCE_SQL).bind(userId).first<{ balance: number }>())?.balance ?? 0);
  if (prior) {
    return c.json({ success: true, replayed: true, ledger_id: prior.id, amount: prior.amount, balance: await balanceOf() });
  }
  const id = await requestLedgerId(userId, `adm:${idempotencyKey}`);
  const row = ledgerInsertStatement({
    id, userId, kind: amount > 0 ? 'admin_grant' : 'admin_adjust', amount,
    refType: 'admin', refId: admin.id, idempotencyKey: adminLedgerKey(idempotencyKey), note: reason.slice(0, 200), createdAt: nowIso,
  });
  try {
    await db.prepare(row.sql).bind(...row.params).run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isLedgerReplay(msg)) return c.json({ success: true, replayed: true, ledger_id: id, amount, balance: await balanceOf() });
    if (isInsufficientCoins(msg)) throw conflict('الرصيد لا يكفي لهذا الخصم / The player\'s balance cannot cover this deduction', 'INSUFFICIENT_COINS');
    throw e;
  }
  await audit(db, admin.id, 'farm.admin_grant', userId, { ledger_id: id, amount, reason });
  return c.json({ success: true, replayed: false, ledger_id: id, amount, balance: await balanceOf() });
});
