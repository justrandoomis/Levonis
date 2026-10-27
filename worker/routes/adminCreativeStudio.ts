/**
 * «استوديو Levonis الإبداعي» — THE CREATIVE STUDIO'S API
 * (docs/CREATIVE_STUDIO.md; packages/creativeDoc/src/api.ts is the contract;
 * DECISIONS row 270).
 *
 * Mounted at /api/admin/creative-studio, so it sits behind the apex-only host
 * guard and the no-store layer of worker/index.ts; it wears its own doors as
 * well, so neither depends on a mount somebody remembered:
 *
 *   every route    requireAdmin (404 off the apex) → a rate limit per method
 *   studio routes  owner or full-scope admin; an assistant admin hears
 *                  403 CREATIVE_SCOPE_REQUIRED (no capability grant is designed yet)
 *   owner routes   requireOwner (the verified owner): the provider key, model,
 *                  budget and rates, brand-kit versions, service claims, the
 *                  JSON import; a key write also needs a sign-in within ten
 *                  minutes (401 REAUTH_REQUIRED)
 *
 * WHAT NEVER LEAVES. The provider key (only a 4-character hint, to the owner),
 * any cost, margin, supplier, stock count or sales figure (the store connector
 * is an allow-list over the public card), prompts and model output in logs or
 * usage rows. The studio writes only its own `creative_*` tables.
 *
 * DEPLOY-AHEAD (CLAUDE.md rule 2): on a database without migration 0215 every
 * GET answers with the same status as on the migrated one — a list 200 with
 * `migrated: false`, an item 404 — and every write 503 CREATIVE_SCHEMA_MISSING.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, badRequest, int, jsonObject as bodyOf, notFound, oneOf, requireAdmin, str } from '../lib/http';
import { requireFreshSession, requireOwner } from '../lib/costAccess';
import { isOwner, isUnverifiedOwner, normalizeAdminScope } from '../lib/adminScope';
import { limitByMethod } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { newId } from '../lib/crypto';
import { deleteMediaObject } from '../lib/mediaStorage';
import {
  CREATIVE_API, type AiTask, type AssetDto, type AssetKind, type ComposeRequest, type DocKind, type DocStatus, type ExportKind, type FeedbackDto,
  type IdeaRecordDto, type ModelDto, type ProviderStatusDto, type RejectReason, type UsageRecordDto, type VersionOrigin,
} from '../../packages/creativeDoc/src/api';
import {
  CAROUSEL_SCHEMA, COMPOSE_SCHEMA, EDIT_SCHEMA, IDEAS_SCHEMA, REVIEW_SCHEMA, validateCarousel, validateCompose, validateEditPatch, validateIdeas, validateReview,
  type Idea,
} from '../../packages/creativeDoc/src/aiContracts';
import { normalizeBrandKit } from '../../packages/creativeDoc/src/brand';
import { normalizeDocument } from '../../packages/creativeDoc/src/normalize';
import type { AllowedAssets } from '../../packages/creativeDoc/src/ops';
import { OBJECTIVES, VISUAL_PRIORITIES, type Density, type Objective, type VisualPriority } from '../../packages/creativeDoc/src/schema';
import { compareSnapshots, type ProductSnapshot } from '../../packages/creativeDoc/src/snapshot';
import { FAMILY_IDS, isTemplateId, isVariantId, variantsFor, type FamilyId, type TemplateId, type VariantId } from '../../packages/creativeDoc/src/templates';
import { keyHintOf, keyState, listModels, validProviderKeyShape, type Transport } from '../lib/creative/anthropic';
import { aiError, ensureReady, runAi } from '../lib/creative/ai';
import { approveBrandVersion, brandVersion, brandVersions, currentBrand, saveBrandVersion, siteLogoSize, SITE_LOGO } from '../lib/creative/brandStore';
import { budgetLeft, imageTokenAllowance, lastDays, usageTotals } from '../lib/creative/budget';
import { approveClaim, approvedClaims, claimExists, claimInput, claimIsCurrent, claimText, createClaim, documentsUsingClaim, listClaims, reviseClaim } from '../lib/creative/claims';
import { intOrNull, isMissingSchema, namesOf, nowIso, readOr, schemaMissing, stringList, studioInstalled, writeOr503 } from '../lib/creative/db';
import {
  REJECT_REASONS, approveDocument, createDocument, documentDto, duplicateDocument, exportDto, exportsOf, getDocRow, keepVersionStatement, listDocuments, markForSnapshot,
  markNeedsReview, readContent, recheckReleased, rejectDocument, requireDoc, renameDocument, restoreDocument, reviews, saveDocument, serverBlockers, serverReport,
  setStatus, staleCodes, summaries, verifyDocument, versionContent, versions, type DocRow, type ExportRow,
} from '../lib/creative/documents';
import { MAX_FILE_BYTES, MAX_PROJECT_JSON_BYTES, assertDeclaredSize, putStudioFile, sha256OfBytes, sniffStudioImage, streamStudioFile, tooLarge, unsupported } from '../lib/creative/files';
import { IDEMPOTENCY_KEY, cancelJob, jobById, jobDto, markApplied } from '../lib/creative/jobs';
import { encryptionReady, sealProviderKey } from '../lib/creative/keyVault';
import { collectOpportunities, syncCatalogWatch } from '../lib/creative/opportunities';
import { carouselContent, composeContent, editContent, ideasContent, reviewContent, testContent, type FeedbackMemory } from '../lib/creative/prompts';
import {
  ensureSettingsRow, isEffort, normalizeBudget, normalizePriorities, normalizeRates, readProviderSettings, type Capabilities, type ProviderSettings,
} from '../lib/creative/settings';
import { getSnapshot, getSnapshots, normalizeSnapshotImport, storeSnapshot } from '../lib/creative/snapshots';
import { buildSnapshotData, listProducts, productDetail } from '../lib/creative/store';

export const adminCreativeStudioRoutes = new Hono<AppContext>();
const R = adminCreativeStudioRoutes;

R.use('*', requireAdmin);
R.use('*', limitByMethod(['creative-read', 1200], ['creative-write', 300]));

/**
 * TESTS ONLY: the provider transport (a stub `fetch`, an instant backoff). The
 * test runner has no network; production leaves this empty and the adapter
 * uses the platform `fetch` with its real deadlines.
 */
export const creativeTransport: Transport = {};

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------

/** The owner or a full-scope admin (legacy NULL scope included); an assistant admin is refused. */
const studio: MiddlewareHandler<AppContext> = async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') throw new HttpError(403, 'Administrator access required', 'FORBIDDEN');
  if (!isOwner(c.env, user) && normalizeAdminScope((user as { admin_scope?: unknown }).admin_scope) === 'assistant') {
    throw new HttpError(403, 'The Creative Studio is open to the owner and full-scope admins.', 'CREATIVE_SCOPE_REQUIRED');
  }
  await next();
};

/** The verified owner — the one who may manage the provider page. */
function canManage(c: Context<AppContext>): boolean {
  const user = c.get('user');
  return !!user && user.role === 'admin' && isOwner(c.env, user) && !isUnverifiedOwner(c.env, user);
}

const actorOf = (c: Context<AppContext>) => String(c.get('user')!.id);
const ok = (c: Context<AppContext>, body: object, status: 200 | 201 = 200) => c.json({ success: true, ...body }, status);
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const idParam = (c: Context<AppContext>, name = 'id') => {
  const v = c.req.param(name) ?? '';
  if (!ID.test(v)) throw notFound();
  return v;
};
const idemKey = (v: unknown) => {
  if (typeof v !== 'string' || !IDEMPOTENCY_KEY.test(v)) throw badRequest('idempotency_key is required (8-80 letters, digits, _ or -)', 'INVALID_INPUT');
  return v;
};
const boolOf = (v: unknown) => v === true || v === 'true' || v === 1;
const DATE_Q = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/;

/**
 * The studio's visual memory for a prompt (spec §22): the last 30 days of
 * rejections — reason counts and the five latest notes. Tolerates a database
 * without the studio tables (an empty memory).
 */
async function feedbackMemory(db: D1Database): Promise<FeedbackMemory> {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const rows = await readOr(
    async () => (await db.prepare(`SELECT reasons_json, note FROM creative_feedback WHERE kind = 'reject' AND created_at >= ? ORDER BY created_at DESC LIMIT 60`).bind(since).all<{ reasons_json: string; note: string | null }>()).results ?? [],
    [] as Array<{ reasons_json: string; note: string | null }>
  );
  const reasons: Record<string, number> = {};
  const notes: string[] = [];
  for (const r of rows) {
    let list: unknown = [];
    try {
      list = JSON.parse(r.reasons_json);
    } catch {
      list = [];
    }
    for (const x of Array.isArray(list) ? list : []) if (typeof x === 'string' && (REJECT_REASONS as readonly string[]).includes(x)) reasons[x] = (reasons[x] ?? 0) + 1;
    if (r.note && r.note.trim() && notes.length < 5) notes.push(r.note.trim());
  }
  return { reasons, notes };
}

// ---------------------------------------------------------------------------
// Provider (owner)
// ---------------------------------------------------------------------------

const ZERO_TOTALS = { requests: 0, input_tokens: 0, output_tokens: 0, est_cost_usd: null };

const capabilityFlags = (caps: Capabilities) => ({ structured_outputs: caps.structured_outputs, vision: caps.vision, effort: caps.effort });

async function providerStatus(c: Context<AppContext>, given?: ProviderSettings): Promise<ProviderStatusDto> {
  const env = c.env;
  const s = given ?? (await readProviderSettings(env.DB));
  const owner = canManage(c);
  const [key, encryption, totals, left] = await Promise.all([
    keyState(env),
    encryptionReady(env),
    s.migrated ? usageTotals(env.DB) : Promise.resolve({ today: { ...ZERO_TOTALS }, month: { ...ZERO_TOTALS } }),
    s.migrated ? budgetLeft(env.DB, s.budget) : Promise.resolve(true),
  ]);
  const notReady = !s.migrated ? 'CREATIVE_SCHEMA_MISSING' : key.source === 'none' ? 'KEY_NOT_CONFIGURED' : !s.model ? 'MODEL_NOT_SELECTED' : !left ? 'BUDGET_EXCEEDED' : null;
  return {
    migrated: s.migrated,
    provider: 'anthropic',
    key: {
      source: key.source,
      hint: owner && key.source === 'stored' ? s.key_hint : null,
      set_at: owner && key.source === 'stored' ? s.key_set_at : null,
    },
    encryption_ready: encryption,
    model: s.model,
    effort: s.effort,
    last_test: s.last_test,
    capabilities: capabilityFlags(s.capabilities),
    budget: s.budget,
    rates: owner ? s.rates : null,
    vision_review: s.vision_review,
    today: totals.today,
    month: totals.month,
    can_manage: owner,
    ready: notReady === null,
    not_ready_code: notReady,
  };
}

R.get('/provider', studio, async (c) => ok(c, await providerStatus(c)));

R.put('/provider/key', requireOwner, async (c) => {
  requireFreshSession(c);
  const body = await bodyOf(c);
  const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
  if (!validProviderKeyShape(apiKey)) throw badRequest('api_key does not look like a provider key', 'INVALID_INPUT');
  if (!(await encryptionReady(c.env))) {
    throw new HttpError(503, 'Typing a key needs the Worker secret CREATIVE_STUDIO_ENC_KEY. Until it is set, the studio can use the ANTHROPIC_API_KEY Worker secret.', 'ENCRYPTION_NOT_CONFIGURED');
  }
  const sealed = await sealProviderKey(c.env, apiKey);
  const db = c.env.DB;
  const now = nowIso();
  await writeOr503(() =>
    db.batch([
      ensureSettingsRow(db),
      db
        .prepare(
          `UPDATE creative_provider_settings SET key_sealed = ?, key_hint = ?, key_set_at = ?, key_set_by = ?, last_test_at = NULL, last_test_ok = NULL,
                  last_test_code = NULL, updated_at = ?, updated_by = ? WHERE id = 'anthropic'`
        )
        .bind(sealed, keyHintOf(apiKey), now, actorOf(c), now, actorOf(c)),
    ])
  );
  await audit(db, actorOf(c), 'creative.provider.key_set', 'anthropic', { source: 'stored' });
  return ok(c, await providerStatus(c));
});

R.delete('/provider/key', requireOwner, async (c) => {
  requireFreshSession(c);
  const db = c.env.DB;
  const now = nowIso();
  await writeOr503(() =>
    db.batch([
      ensureSettingsRow(db),
      db
        .prepare(
          `UPDATE creative_provider_settings SET key_sealed = NULL, key_hint = NULL, key_set_at = NULL, key_set_by = NULL, last_test_at = NULL,
                  last_test_ok = NULL, last_test_code = NULL, updated_at = ?, updated_by = ? WHERE id = 'anthropic'`
        )
        .bind(now, actorOf(c)),
    ])
  );
  await audit(db, actorOf(c), 'creative.provider.key_deleted', 'anthropic', {});
  return ok(c, await providerStatus(c));
});

function capabilitiesFor(model: { id: string; structured_outputs: boolean | null; vision: boolean | null; effort: boolean | null; effort_levels: Capabilities['effort_levels'] }): Capabilities {
  return { model: model.id, structured_outputs: model.structured_outputs, vision: model.vision, effort: model.effort, effort_levels: model.effort_levels };
}

const TEST_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };

R.post('/provider/test', requireOwner, async (c) => {
  const env = c.env;
  const db = env.DB;
  const settings = await readProviderSettings(db);
  if (!settings.migrated) throw schemaMissing();
  let code: string | null = null;
  let capabilities: Capabilities | null = null;
  const key = await keyState(env);
  if (key.source === 'none') code = 'KEY_NOT_CONFIGURED';
  else {
    const list = await listModels(env, creativeTransport);
    if (!list.ok) code = list.code;
    else if (settings.model) {
      const m = list.models.find((x) => x.id === settings.model);
      if (!m) code = 'MODEL_GONE';
      else {
        capabilities = capabilitiesFor(m);
        try {
          const ready = await ensureReady(env);
          await runAi(
            env,
            { ...ready, settings: { ...ready.settings, capabilities } },
            {
              task: 'test',
              actorId: actorOf(c),
              idempotencyKey: newId('test'),
              request: { at: nowIso() },
              documentId: null,
              baseVersion: null,
              targetIds: [],
              content: testContent(),
              schema: TEST_SCHEMA,
              validate: (raw) => ((raw as { ok?: unknown } | null)?.ok === true ? { ok: true, result: { ok: true } } : { ok: false, reason: 'unexpected_answer' }),
            },
            creativeTransport
          );
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          code = e.code ?? 'PROVIDER_ERROR';
        }
      }
    }
  }
  const now = nowIso();
  await db.batch([
    ensureSettingsRow(db),
    db
      .prepare(
        `UPDATE creative_provider_settings SET last_test_at = ?, last_test_ok = ?, last_test_code = ?,
                capabilities_json = COALESCE(?, capabilities_json) WHERE id = 'anthropic'`
      )
      .bind(now, code === null ? 1 : 0, code, capabilities ? JSON.stringify(capabilities) : null),
  ]);
  const status = await providerStatus(c);
  return ok(c, { ...status, test: { ok: code === null, code } });
});

const modelDto = (m: { id: string; display_name: string; created_at: string | null; structured_outputs: boolean | null; vision: boolean | null; effort: boolean | null }): ModelDto => ({
  id: m.id, display_name: m.display_name, created_at: m.created_at, structured_outputs: m.structured_outputs, vision: m.vision, effort: m.effort,
});

R.get('/provider/models', requireOwner, async (c) => {
  const list = await listModels(c.env, creativeTransport);
  if (!list.ok) throw aiError(list.code);
  return ok(c, { models: list.models.map(modelDto) });
});

R.put('/provider/settings', requireOwner, async (c) => {
  const env = c.env;
  const db = env.DB;
  const body = await bodyOf(c);
  const current = await readProviderSettings(db);
  if (!current.migrated) throw schemaMissing();
  const sets: string[] = [];
  const args: unknown[] = [];
  if ('model' in body) {
    if (body.model === null) {
      sets.push('model = NULL', `capabilities_json = '{}'`);
    } else {
      const id = str(body.model, 'model', { min: 1, max: 120 });
      // The choice must be a model the key can really use, from the live list — never a name typed from memory.
      const list = await listModels(env, creativeTransport);
      if (!list.ok) throw aiError(list.code);
      const m = list.models.find((x) => x.id === id);
      if (!m) throw badRequest('model is not in the live model list', 'INVALID_INPUT');
      if (m.structured_outputs === false) throw badRequest('this model does not support structured outputs, which the studio requires', 'INVALID_INPUT');
      sets.push('model = ?', 'capabilities_json = ?');
      args.push(m.id, JSON.stringify(capabilitiesFor(m)));
    }
  }
  if ('effort' in body) {
    if (body.effort !== null && !isEffort(body.effort)) throw badRequest('effort must be low, medium, high or null', 'INVALID_INPUT');
    sets.push('effort = ?');
    args.push(body.effort ?? null);
  }
  if ('budget' in body) {
    sets.push('budget_json = ?');
    args.push(JSON.stringify(normalizeBudget({ ...current.budget, ...(body.budget && typeof body.budget === 'object' ? body.budget : {}) })));
  }
  if ('rates' in body) {
    if (body.rates === null) sets.push('rates_json = NULL');
    else {
      const rates = normalizeRates(body.rates);
      if (!rates) throw badRequest('rates need input_per_mtok_usd, output_per_mtok_usd, a source and an as_of date', 'INVALID_INPUT');
      sets.push('rates_json = ?');
      args.push(JSON.stringify(rates));
    }
  }
  if ('vision_review' in body) {
    sets.push('vision_review = ?');
    args.push(boolOf(body.vision_review) ? 1 : 0);
  }
  if ('priorities' in body) {
    sets.push('priorities_json = ?');
    args.push(JSON.stringify(normalizePriorities(body.priorities)));
  }
  if (sets.length) {
    const now = nowIso();
    await db.batch([
      ensureSettingsRow(db),
      db.prepare(`UPDATE creative_provider_settings SET ${sets.join(', ')}, updated_at = ?, updated_by = ? WHERE id = 'anthropic'`).bind(...args, now, actorOf(c)),
    ]);
    await audit(db, actorOf(c), 'creative.provider.settings', 'anthropic', { fields: Object.keys(body).filter((k) => ['model', 'effort', 'budget', 'rates', 'vision_review', 'priorities'].includes(k)) });
  }
  return ok(c, await providerStatus(c));
});

R.get('/usage', studio, async (c) => {
  const days = int(c.req.query('days'), 'days', { min: 1, max: 90, def: 30 });
  const db = c.env.DB;
  const settings = await readProviderSettings(db);
  if (!settings.migrated) return ok(c, { migrated: false, records: [], days: [], today: { ...ZERO_TOTALS }, month: { ...ZERO_TOTALS } });
  const want = lastDays(days);
  const [records, spend, totals] = await Promise.all([
    db
      .prepare(
        `SELECT id, created_at, task, model, status, error_code, input_tokens, output_tokens, est_cost_micro_usd, actor_id, document_id
           FROM creative_usage ORDER BY created_at DESC LIMIT 100`
      )
      .all<{ id: string; created_at: string; task: AiTask; model: string | null; status: UsageRecordDto['status']; error_code: string | null; input_tokens: number | null; output_tokens: number | null; est_cost_micro_usd: number | null; actor_id: string | null; document_id: string | null }>(),
    db
      .prepare('SELECT day, requests, tokens_used, usd_micro_spent FROM creative_spend_day WHERE day >= ? ORDER BY day DESC')
      .bind(want[want.length - 1])
      .all<{ day: string; requests: number; tokens_used: number; usd_micro_spent: number }>(),
    usageTotals(db),
  ]);
  const rows = records.results ?? [];
  const names = await namesOf(db, rows.map((r) => r.actor_id));
  const byDay = new Map((spend.results ?? []).map((r) => [r.day, r]));
  return ok(c, {
    migrated: true,
    records: rows.map((r): UsageRecordDto => ({
      id: r.id, created_at: r.created_at, task: r.task, model: r.model, status: r.status, error_code: r.error_code, input_tokens: r.input_tokens,
      output_tokens: r.output_tokens, est_cost_usd: r.est_cost_micro_usd !== null ? r.est_cost_micro_usd / 1_000_000 : null,
      actor_name: r.actor_id ? names.get(r.actor_id) ?? null : null, document_id: r.document_id,
    })),
    days: want.map((day) => {
      const r = byDay.get(day);
      return { day, requests: r?.requests ?? 0, tokens_used: r?.tokens_used ?? 0, est_cost_usd: settings.rates && r ? r.usd_micro_spent / 1_000_000 : null };
    }),
    today: totals.today,
    month: totals.month,
  });
});

// ---------------------------------------------------------------------------
// Store (read-only)
// ---------------------------------------------------------------------------

R.get('/products', studio, async (c) => {
  const q = str(c.req.query('q'), 'q', { max: 100, required: false });
  const category = str(c.req.query('category'), 'category', { max: 80, required: false });
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 50, def: 24 });
  const offset = int(c.req.query('offset'), 'offset', { min: 0, max: 10_000, def: 0 });
  return ok(c, await listProducts(c.env.DB, { q, category, limit, offset }));
});

R.get('/products/:id', studio, async (c) => {
  const id = idParam(c);
  const detail = await productDetail(c.env.DB, id);
  if (!detail) throw notFound('Product not found');
  return ok(c, detail);
});

const VARIANT_KEY = /^ov:[A-Za-z0-9_-]{1,80}$/;

R.post('/snapshots', studio, async (c) => {
  const body = await bodyOf(c);
  const productId = str(body.product_id, 'product_id', { min: 1, max: 64 });
  const variantKey = body.variant_key === null || body.variant_key === undefined || body.variant_key === '' ? null : String(body.variant_key);
  if (variantKey !== null && !VARIANT_KEY.test(variantKey)) throw badRequest('variant_key must be ov:<option id>', 'INVALID_INPUT');
  if (!(await studioInstalled(c.env.DB))) throw schemaMissing();
  const data = await buildSnapshotData(c.env.DB, productId, variantKey);
  if (!data) throw notFound('Product or option not found');
  const snap = await writeOr503(() => storeSnapshot(c.env.DB, data, 'live', actorOf(c)));
  return ok(c, snap, 201);
});

R.post('/snapshots/import', requireOwner, async (c) => {
  const body = await bodyOf(c);
  const source = oneOf(body.source, 'source', ['manual', 'test'] as const);
  const data = normalizeSnapshotImport(body.data);
  const snap = await writeOr503(() => storeSnapshot(c.env.DB, data, source, actorOf(c)));
  await audit(c.env.DB, actorOf(c), 'creative.snapshot.import', snap.id, { source, product_id: data.product_id });
  return ok(c, snap, 201);
});

R.get('/snapshots/:id', studio, async (c) => {
  const snap = await readOr(() => getSnapshot(c.env.DB, idParam(c)), null);
  if (!snap) throw notFound('Snapshot not found');
  return ok(c, snap);
});

R.post('/snapshots/:id/verify', studio, async (c) => {
  const id = idParam(c);
  const snap = await writeOr503(() => getSnapshot(c.env.DB, id));
  if (!snap) throw notFound('Snapshot not found');
  const freshData = await buildSnapshotData(c.env.DB, snap.data.product_id, snap.data.variant_key);
  const fresh: ProductSnapshot | null = freshData ? await storeSnapshot(c.env.DB, freshData, 'live', actorOf(c)) : null;
  const changes = compareSnapshots(snap.data, freshData);
  // An approved or final-exported design bound to this snapshot is marked for what it shows (spec §25).
  await markForSnapshot(c.env.DB, id, changes);
  return ok(c, { snapshot_id: id, fresh, changes });
});

// ---------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------

/** The kit in force, with the site logo's size read from the file the site serves (brandStore.ts `siteLogoSize`). */
async function brandNow(c: Context<AppContext>) {
  const [brand, siteLogo] = await Promise.all([currentBrand(c.env.DB), siteLogoSize(c.env)]);
  return { ...brand, site_logo: siteLogo };
}

R.get('/brand', studio, async (c) => ok(c, await brandNow(c)));

R.get('/brand/versions', studio, async (c) => {
  const list = await readOr(async () => ({ migrated: true, versions: await brandVersions(c.env.DB) }), { migrated: false, versions: [] });
  return ok(c, list);
});

/** One version and its kit (a pending one can be viewed before approval); 404 when it does not exist, as on a database without 0215. */
R.get('/brand/versions/:version', studio, async (c) => {
  const version = Number(c.req.param('version'));
  if (!Number.isInteger(version) || version < 1) throw notFound();
  const out = await readOr(() => brandVersion(c.env.DB, version), null);
  if (!out) throw notFound('Brand version not found');
  return ok(c, out);
});

R.post('/brand/versions', requireOwner, async (c) => {
  const body = await bodyOf(c);
  const n = normalizeBrandKit(body.kit);
  if (!n.ok) throw new HttpError(400, 'The brand kit was refused.', 'INVALID_INPUT', { issues: n.issues.filter((i) => i.fatal) });
  const note = str(body.note, 'note', { max: 300, required: false });
  const saved = await writeOr503(() => saveBrandVersion(c.env.DB, actorOf(c), n.kit, note, boolOf(body.approve)));
  await audit(c.env.DB, actorOf(c), 'creative.brand.saved', String(saved.version), { status: saved.status });
  return ok(c, { saved, brand: await brandNow(c) }, 201);
});

R.post('/brand/versions/:version/approve', requireOwner, async (c) => {
  const version = Number(c.req.param('version'));
  if (!Number.isInteger(version) || version < 1) throw notFound();
  const saved = await writeOr503(() => approveBrandVersion(c.env.DB, actorOf(c), version));
  if (!saved) throw notFound('Brand version not found');
  await audit(c.env.DB, actorOf(c), 'creative.brand.approved', String(version), {});
  return ok(c, { saved, brand: await brandNow(c) });
});

// ---------------------------------------------------------------------------
// Service claims
// ---------------------------------------------------------------------------

R.get('/claims', studio, async (c) => ok(c, await readOr(async () => ({ migrated: true, claims: await listClaims(c.env.DB) }), { migrated: false, claims: [] })));

R.post('/claims', requireOwner, async (c) => {
  const body = await bodyOf(c);
  const key = str(body.key, 'key', { min: 1, max: 60 });
  const input = claimInput(body);
  const claim = await writeOr503(() => createClaim(c.env.DB, actorOf(c), key, input));
  await audit(c.env.DB, actorOf(c), 'creative.claim.created', claim.id, { key, version: claim.version });
  return ok(c, { claim }, 201);
});

R.put('/claims/:id', requireOwner, async (c) => {
  const id = idParam(c);
  const input = claimInput(await bodyOf(c));
  const claim = await writeOr503(() => reviseClaim(c.env.DB, actorOf(c), id, input));
  if (!claim) throw notFound('Claim not found');
  await audit(c.env.DB, actorOf(c), 'creative.claim.revised', id, { version: claim.version });
  return ok(c, { claim });
});

R.post('/claims/:id/approve', requireOwner, async (c) => {
  const id = idParam(c);
  const body = await bodyOf(c);
  const version = body.version === undefined || body.version === null ? null : int(body.version, 'version', { min: 1 });
  const out = await writeOr503(() => approveClaim(c.env.DB, actorOf(c), id, version));
  if (!out) throw notFound('No pending version of this claim');
  await audit(c.env.DB, actorOf(c), 'creative.claim.approved', id, { version: out.claim.version, marked: out.marked });
  return ok(c, { claim: out.claim, marked: out.marked });
});

R.get('/claims/:id/documents', studio, async (c) => {
  const id = idParam(c);
  const db = c.env.DB;
  const found = await readOr(() => claimExists(db, id), false);
  if (!found) throw notFound('Claim not found');
  const ids = await documentsUsingClaim(db, id);
  const rows = (await Promise.all(ids.map((d) => getDocRow(db, d)))).filter((r): r is DocRow => !!r);
  return ok(c, { documents: await summaries(db, rows) });
});

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

const ASSET_KINDS: readonly AssetKind[] = ['logo', 'background', 'reference_liked', 'reference_rejected', 'product_extra', 'icon', 'element'];

interface AssetRow {
  id: string;
  kind: AssetKind;
  label: string;
  r2_key: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  provenance: AssetDto['provenance'];
  derived_from: string | null;
  product_id: string | null;
  review: AssetDto['review'];
  note: string;
  created_at: string;
  deleted_at: string | null;
}

const assetDto = (r: AssetRow): AssetDto => ({
  id: r.id, kind: r.kind, label: r.label, mime: r.mime, width: intOrNull(r.width), height: intOrNull(r.height), bytes: r.bytes, provenance: r.provenance,
  derived_from: r.derived_from, product_id: r.product_id, review: r.review, note: r.note, created_at: r.created_at, url: `${CREATIVE_API}/assets/${r.id}/file`,
});

R.get('/assets', studio, async (c) => {
  const kind = c.req.query('kind');
  if (kind !== undefined && kind !== '' && !(ASSET_KINDS as readonly string[]).includes(kind)) throw badRequest('unknown asset kind', 'INVALID_INPUT');
  const out = await readOr(async () => {
    const q = kind
      ? c.env.DB.prepare('SELECT * FROM creative_assets WHERE deleted_at IS NULL AND kind = ? ORDER BY created_at DESC LIMIT 200').bind(kind)
      : c.env.DB.prepare('SELECT * FROM creative_assets WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200');
    return { migrated: true, assets: ((await q.all<AssetRow>()).results ?? []).map(assetDto) };
  }, { migrated: false, assets: [] as AssetDto[] });
  return ok(c, out);
});

async function formFile(c: Context<AppContext>): Promise<{ bytes: Uint8Array; form: FormData }> {
  assertDeclaredSize(c.req.header('content-length'));
  if (!/multipart\/form-data/i.test(c.req.header('content-type') ?? '')) throw badRequest('Send the file as multipart/form-data', 'INVALID_INPUT');
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw badRequest('The upload could not be read', 'INVALID_INPUT');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string' || typeof (file as Blob).arrayBuffer !== 'function') throw badRequest('file is required', 'INVALID_INPUT');
  if ((file as Blob).size > MAX_FILE_BYTES) throw tooLarge();
  return { bytes: new Uint8Array(await (file as Blob).arrayBuffer()), form };
}

R.post('/assets', studio, async (c) => {
  if (!(await studioInstalled(c.env.DB))) throw schemaMissing();
  const { bytes, form } = await formFile(c);
  const kind = oneOf(form.get('kind'), 'kind', ASSET_KINDS);
  const label = str(form.get('label'), 'label', { max: 80, required: false });
  const note = str(form.get('note'), 'note', { max: 300, required: false });
  const productRaw = form.get('product_id');
  const productId = typeof productRaw === 'string' && productRaw ? productRaw : null;
  if (productId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(productId)) throw badRequest('product_id is malformed', 'INVALID_INPUT');
  const img = sniffStudioImage(bytes);
  const id = newId('cast');
  const sha = await sha256OfBytes(bytes);
  const key = await putStudioFile(c.env, { entityId: 'assets', kind, objectId: id, ext: img.ext }, bytes, { mime: img.mime, width: img.width, height: img.height, ownerId: actorOf(c) });
  const now = nowIso();
  // The owner's own upload is approved at once; a full admin's waits for a reviewer's verdict (PATCH below) — and until
  // then it is offered neither to a design nor to Claude, and blocks an approval or a final export (spec §6, §13).
  const review: AssetDto['review'] = canManage(c) ? 'approved' : 'needs_review';
  await c.env.DB
    .prepare(
      `INSERT INTO creative_assets (id, kind, label, r2_key, mime, bytes, width, height, sha256, provenance, product_id, review, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', ?, ?, ?, ?, ?)`
    )
    .bind(id, kind, label, key, img.mime, bytes.byteLength, img.width, img.height, sha, productId, review, note, actorOf(c), now)
    .run();
  const row = (await c.env.DB.prepare('SELECT * FROM creative_assets WHERE id = ?').bind(id).first<AssetRow>())!;
  return ok(c, { asset: assetDto(row) }, 201);
});

R.get('/assets/:id/file', studio, async (c) => {
  const row = await readOr(() => c.env.DB.prepare('SELECT * FROM creative_assets WHERE id = ?').bind(idParam(c)).first<AssetRow>(), null);
  if (!row) throw notFound('Asset not found');
  const res = await streamStudioFile(c.env, row.r2_key, row.mime, null);
  if (!res) throw notFound('Asset file not found');
  return res;
});

/**
 * A reviewer's verdict on an asset. Only `approved` assets are offered to a
 * design or to Claude; rejecting one an approved design or the approved brand
 * kit uses is refused like a delete would be (ASSET_IN_USE).
 */
R.patch('/assets/:id', studio, async (c) => {
  const id = idParam(c);
  const body = await bodyOf(c);
  const review = oneOf(body.review, 'review', ['approved', 'needs_review', 'rejected'] as const);
  const note = body.note === undefined || body.note === null ? null : str(body.note, 'note', { max: 300, required: false });
  const db = c.env.DB;
  const row = await writeOr503(() => db.prepare('SELECT * FROM creative_assets WHERE id = ?').bind(id).first<AssetRow>());
  if (!row || row.deleted_at) throw notFound('Asset not found');
  if (review !== 'approved') {
    const used = await db
      .prepare(
        `SELECT d.id FROM creative_documents d
          WHERE d.approved_version IS NOT NULL
            AND EXISTS (SELECT 1 FROM json_each(d.content_json, '$.layers') l WHERE json_extract(l.value, '$.asset.ref') = ?)
          LIMIT 5`
      )
      .bind(id)
      .all<{ id: string }>();
    const brand = await currentBrand(db);
    const inKit = brand.status === 'approved' && (brand.kit.logo.asset === id || brand.kit.backgrounds.some((b) => b.asset_id === id));
    if ((used.results ?? []).length || inKit) {
      throw new HttpError(409, 'This asset is used by an approved design or the approved brand kit.', 'ASSET_IN_USE', { documents: (used.results ?? []).map((r) => r.id), brand_kit: inKit });
    }
  }
  await db.prepare('UPDATE creative_assets SET review = ?, note = COALESCE(?, note) WHERE id = ? AND deleted_at IS NULL').bind(review, note, id).run();
  await audit(db, actorOf(c), 'creative.asset.reviewed', id, { review });
  const next = (await db.prepare('SELECT * FROM creative_assets WHERE id = ?').bind(id).first<AssetRow>())!;
  return ok(c, { asset: assetDto(next) });
});

R.delete('/assets/:id', studio, async (c) => {
  const id = idParam(c);
  const db = c.env.DB;
  const row = await writeOr503(() => db.prepare('SELECT * FROM creative_assets WHERE id = ?').bind(id).first<AssetRow>());
  if (!row || row.deleted_at) throw notFound('Asset not found');
  // In use by an approved design, or by the brand kit in force: refused, never silently broken.
  const used = await db
    .prepare(
      `SELECT d.id FROM creative_documents d
        WHERE d.approved_version IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(d.content_json, '$.layers') l WHERE json_extract(l.value, '$.asset.ref') = ?)
        LIMIT 5`
    )
    .bind(id)
    .all<{ id: string }>();
  const brand = await currentBrand(db);
  const inKit = brand.status === 'approved' && (brand.kit.logo.asset === id || brand.kit.backgrounds.some((b) => b.asset_id === id));
  if ((used.results ?? []).length || inKit) {
    throw new HttpError(409, 'This asset is used by an approved design or the approved brand kit.', 'ASSET_IN_USE', { documents: (used.results ?? []).map((r) => r.id), brand_kit: inKit });
  }
  await db.prepare('UPDATE creative_assets SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(nowIso(), id).run();
  await audit(db, actorOf(c), 'creative.asset.deleted', id, { kind: row.kind });
  return ok(c, { asset: assetDto({ ...row, deleted_at: nowIso() }) });
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

const DOC_STATUSES: readonly DocStatus[] = ['idea', 'draft', 'in_review', 'approved', 'scheduled', 'published', 'archived', 'failed'];
const DOC_KINDS: readonly DocKind[] = ['post', 'slide', 'experiment'];
const ORIGINS: readonly VersionOrigin[] = ['manual', 'ai', 'template', 'restore', 'relayout', 'import'];
const CREATE_ORIGINS = ['manual', 'ai', 'template', 'relayout', 'import'] as const;

R.get('/documents', studio, async (c) => {
  const q = c.req.query();
  const status = q.status ? oneOf(q.status, 'status', DOC_STATUSES) : null;
  const format = q.format ? oneOf(q.format, 'format', ['square', 'portrait', 'story', 'custom'] as const) : null;
  const from = q.from && DATE_Q.test(q.from) ? q.from : null;
  const to = q.to && DATE_Q.test(q.to) ? q.to : null;
  const limit = int(q.limit, 'limit', { min: 1, max: 100, def: 30 });
  const offset = int(q.offset, 'offset', { min: 0, max: 10_000, def: 0 });
  const productId = q.product_id && /^[A-Za-z0-9_-]{1,64}$/.test(q.product_id) ? q.product_id : null;
  const campaignId = q.campaign_id && ID.test(q.campaign_id) ? q.campaign_id : null;
  const text = str(q.q, 'q', { max: 60, required: false });
  const out = await readOr(
    async () => ({ migrated: true, ...(await listDocuments(c.env.DB, { status, product_id: productId, format, campaign_id: campaignId, q: text, from, to, limit, offset })) }),
    { migrated: false, documents: [], total: 0 }
  );
  return ok(c, { ...out, limit, offset });
});

R.post('/documents', studio, async (c) => {
  const body = await bodyOf(c);
  const title = str(body.title, 'title', { max: 120, required: false });
  const kind = body.kind === undefined ? 'post' : oneOf(body.kind, 'kind', DOC_KINDS);
  const campaignId = typeof body.campaign_id === 'string' && ID.test(body.campaign_id) ? body.campaign_id : null;
  const parentId = typeof body.parent_id === 'string' && ID.test(body.parent_id) ? body.parent_id : null;
  const key = body.idempotency_key === undefined || body.idempotency_key === null ? null : idemKey(body.idempotency_key);
  if (body.content === undefined) throw badRequest('content is required', 'INVALID_INPUT');
  // How the design came to be (version 1's origin); a restore is never a creation.
  const origin = body.origin === undefined || body.origin === null ? null : oneOf(body.origin, 'origin', CREATE_ORIGINS);
  const jobId = typeof body.job_id === 'string' && body.job_id ? body.job_id : null;
  if (jobId !== null && !ID.test(jobId)) throw badRequest('job_id is malformed', 'INVALID_INPUT');
  const row = await writeOr503(() =>
    createDocument(c.env.DB, actorOf(c), { title, content: body.content, kind, campaign_id: campaignId, parent_id: parentId, idempotency_key: key, origin, job_id: jobId })
  );
  return ok(c, { document: await documentDto(c.env.DB, row) }, 201);
});

/** Opening an approved or final-exported design re-verifies it, so a stale one says so at once (documents.ts `recheckReleased`). */
R.get('/documents/:id', studio, async (c) => {
  const row = await readOr(() => getDocRow(c.env.DB, idParam(c)), null);
  if (!row) throw notFound('Design not found');
  return ok(c, { document: await documentDto(c.env.DB, await recheckReleased(c.env.DB, row)) });
});

R.put('/documents/:id', studio, async (c) => {
  const id = idParam(c);
  const body = await bodyOf(c);
  const base = int(body.base_version, 'base_version', { min: 1 });
  if (body.content === undefined) throw badRequest('content is required', 'INVALID_INPUT');
  const origin = body.origin === undefined ? 'manual' : oneOf(body.origin, 'origin', ORIGINS);
  const jobId = typeof body.job_id === 'string' && body.job_id ? body.job_id : null;
  if (jobId !== null && !ID.test(jobId)) throw badRequest('job_id is malformed', 'INVALID_INPUT');
  const title = body.title === undefined || body.title === null ? null : str(body.title, 'title', { max: 120, required: false });
  const out = await writeOr503(() =>
    saveDocument(c.env.DB, actorOf(c), id, {
      base_version: base, content: body.content, title, change_summary: str(body.change_summary, 'change_summary', { max: 300, required: false }),
      origin, job_id: jobId, checkpoint: boolOf(body.checkpoint),
    })
  );
  // Who withdrew an approval is on the record (spec §32).
  if (out.invalidated) await audit(c.env.DB, actorOf(c), 'creative.document.approval_invalidated', id, { version: out.row.version, reason: 'content_changed' });
  return ok(c, { document: await documentDto(c.env.DB, out.row) });
});

/** A rename only: no new version, no base version, an approval stands (worker/lib/creative/documents.ts `renameDocument`). */
R.patch('/documents/:id', studio, async (c) => {
  const body = await bodyOf(c);
  const title = str(body.title, 'title', { min: 1, max: 120 });
  const row = await writeOr503(() => renameDocument(c.env.DB, actorOf(c), idParam(c), title));
  return ok(c, { document: await documentDto(c.env.DB, row) });
});

R.get('/documents/:id/versions', studio, async (c) => {
  const id = idParam(c);
  const row = await readOr(() => getDocRow(c.env.DB, id), null);
  if (!row) throw notFound('Design not found');
  return ok(c, { versions: await versions(c.env.DB, id) });
});

R.get('/documents/:id/versions/:version', studio, async (c) => {
  const id = idParam(c);
  const version = Number(c.req.param('version'));
  if (!Number.isInteger(version) || version < 1) throw notFound();
  const out = await readOr(() => versionContent(c.env.DB, id, version), null);
  if (!out) throw notFound('Version not found');
  return ok(c, out);
});

R.post('/documents/:id/restore', studio, async (c) => {
  const id = idParam(c);
  const body = await bodyOf(c);
  const restored = int(body.version, 'version', { min: 1 });
  const out = await writeOr503(() => restoreDocument(c.env.DB, actorOf(c), id, restored, int(body.base_version, 'base_version', { min: 1 })));
  if (out.invalidated) {
    await audit(c.env.DB, actorOf(c), 'creative.document.approval_invalidated', id, { version: out.row.version, reason: 'content_changed', restored_from: restored });
  }
  return ok(c, { document: await documentDto(c.env.DB, out.row) });
});

R.post('/documents/:id/duplicate', studio, async (c) => {
  const row = await writeOr503(() => duplicateDocument(c.env.DB, actorOf(c), idParam(c)));
  return ok(c, { document: await documentDto(c.env.DB, row) }, 201);
});

R.post('/documents/:id/status', studio, async (c) => {
  const body = await bodyOf(c);
  const status = oneOf(body.status, 'status', ['draft', 'in_review', 'archived'] as const);
  const id = idParam(c);
  const out = await writeOr503(() => setStatus(c.env.DB, actorOf(c), id, status, int(body.base_version, 'base_version', { min: 1 })));
  // Every status change, and every approval it withdraws, names who did it (spec §32).
  if (out.from !== status) await audit(c.env.DB, actorOf(c), 'creative.document.status', id, { from: out.from, to: status, version: out.row.version });
  if (out.invalidated) await audit(c.env.DB, actorOf(c), 'creative.document.approval_invalidated', id, { version: out.row.version, reason: 'withdrawn' });
  return ok(c, { document: await documentDto(c.env.DB, out.row) });
});

R.post('/documents/:id/approve', studio, async (c) => {
  const id = idParam(c);
  const body = await bodyOf(c);
  const version = int(body.version, 'version', { min: 1 });
  const exportIds = Array.isArray(body.export_ids) ? body.export_ids.filter((x): x is string => typeof x === 'string') : [];
  const out = await writeOr503(() => approveDocument(c.env.DB, actorOf(c), id, { version, qa: body.qa as never, export_ids: exportIds }));
  await audit(c.env.DB, actorOf(c), 'creative.document.approved', id, { version });
  return ok(c, { document: await documentDto(c.env.DB, out.row), review: out.review, qa: out.qa });
});

R.post('/documents/:id/reject', studio, async (c) => {
  const id = idParam(c);
  const body = await bodyOf(c);
  const reasons = (Array.isArray(body.reasons) ? body.reasons : []).filter((r): r is RejectReason => (REJECT_REASONS as readonly string[]).includes(r as string));
  if (!reasons.length) throw badRequest('reasons must name at least one reason', 'INVALID_INPUT');
  const note = str(body.note, 'note', { max: 600, required: false });
  const out = await writeOr503(() => rejectDocument(c.env.DB, actorOf(c), id, [...new Set(reasons)], note));
  await audit(c.env.DB, actorOf(c), 'creative.document.rejected', id, { reasons });
  return ok(c, { document: await documentDto(c.env.DB, out.row), review: out.review });
});

R.get('/documents/:id/reviews', studio, async (c) => {
  const id = idParam(c);
  const row = await readOr(() => getDocRow(c.env.DB, id), null);
  if (!row) throw notFound('Design not found');
  return ok(c, { reviews: await reviews(c.env.DB, id) });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const EXPORT_KINDS: readonly ExportKind[] = ['png', 'jpeg', 'webp', 'project_json', 'background'];
const MIME_OF_KIND: Readonly<Record<string, string>> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

R.post('/documents/:id/exports', studio, async (c) => {
  const id = idParam(c);
  const db = c.env.DB;
  const row = await writeOr503(() => requireDoc(db, id));
  const { bytes, form } = await formFile(c);
  let meta: Record<string, unknown> = {};
  try {
    const raw = form.get('meta');
    meta = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    throw badRequest('meta must be JSON', 'INVALID_INPUT');
  }
  const kind = oneOf(meta.kind, 'kind', EXPORT_KINDS);
  const version = int(meta.version, 'version', { min: 1 });
  if (version !== row.version) throw new HttpError(409, 'Export the current version of the design.', 'STALE_VERSION', { current_version: row.version });
  const final = boolOf(meta.final);
  let mime: string;
  let ext: 'png' | 'jpg' | 'webp' | 'json';
  let width: number | null = null;
  let height: number | null = null;
  if (kind === 'project_json') {
    if (final) throw badRequest('A Project JSON export is never final', 'INVALID_INPUT');
    if (bytes.byteLength > MAX_PROJECT_JSON_BYTES) throw tooLarge();
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw unsupported('A Project JSON export must be JSON.');
    }
    // The file is the document itself: it passes the same gate as a save.
    const n = normalizeDocument(parsed);
    if (!n.ok) throw new HttpError(400, 'The Project JSON was refused by the document checks.', 'INVALID_DOCUMENT', { issues: n.issues.filter((i) => i.fatal).slice(0, 20) });
    mime = 'application/json';
    ext = 'json';
  } else {
    const img = sniffStudioImage(bytes);
    if (kind !== 'background' && img.mime !== MIME_OF_KIND[kind]) throw unsupported(`The file is ${img.mime}, not ${kind}.`);
    mime = img.mime;
    ext = img.ext;
    width = img.width;
    height = img.height;
  }
  let sourceCheck: ExportRow['source_check'] = 'none';
  const { doc } = readContent(row);
  if (final) {
    if (kind === 'background') throw badRequest('A background export is never final', 'INVALID_INPUT');
    // The final export re-verifies what the design SHOWS now — a restore or an old approval does not carry it past a change.
    const v = await verifyDocument(db, doc);
    await markNeedsReview(db, id, staleCodes(doc, v));
    if (v.blocking.length) throw new HttpError(409, 'The store data this design shows has changed; review it before a final export.', 'SOURCE_CHANGED', { changes: v.blocking, by_slot: v.changes });
    const report = serverReport(doc, v, true);
    const blockers = await serverBlockers(db, doc, v, report);
    if (blockers.length) throw new HttpError(409, 'The design has quality blockers.', 'QA_BLOCKERS', { issues: blockers.slice(0, 30) });
    sourceCheck = doc.products.length ? (Object.values(v.changes).some((x) => x.length) ? 'changed' : 'fresh') : 'none';
  } else if (doc.products.length) {
    sourceCheck = 'unverified';
  }
  const exportId = newId('cexp');
  const key = await putStudioFile(c.env, { entityId: 'exports', kind: id, objectId: exportId, ext }, bytes, { mime, width, height, ownerId: actorOf(c) });
  const now = nowIso();
  const insert = db
    .prepare(
      `INSERT INTO creative_exports (id, document_id, version, kind, r2_key, mime, bytes, width, height, sha256, final, source_check, created_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM creative_documents WHERE id = ? AND version = ?)`
    )
    .bind(exportId, id, version, kind, key, mime, bytes.byteLength, width, height, await sha256OfBytes(bytes), final ? 1 : 0, sourceCheck, actorOf(c), now, final ? 1 : 0, id, version);
  if (final) {
    // The exported version enters the history in the same batch (documents.ts `keepVersionStatement`); a design that
    // moved on meanwhile records neither, and the file just stored is removed again.
    const results = await db.batch([keepVersionStatement(db, id, version, 'final export', actorOf(c), now), insert]);
    if ((results[1]?.meta?.changes ?? 0) !== 1) {
      await deleteMediaObject(c.env, 'private', key).catch(() => undefined);
      const current = await getDocRow(db, id);
      throw new HttpError(409, 'Export the current version of the design.', 'STALE_VERSION', { current_version: current?.version ?? null });
    }
  } else {
    await insert.run();
  }
  const stored = (await db.prepare('SELECT * FROM creative_exports WHERE id = ?').bind(exportId).first<ExportRow>())!;
  return ok(c, { export: exportDto(stored, CREATIVE_API) }, 201);
});

R.get('/documents/:id/exports', studio, async (c) => {
  const id = idParam(c);
  const row = await readOr(() => getDocRow(c.env.DB, id), null);
  if (!row) throw notFound('Design not found');
  return ok(c, { exports: (await exportsOf(c.env.DB, id)).map((e) => exportDto(e, CREATIVE_API)) });
});

R.get('/exports/:id/file', studio, async (c) => {
  const row = await readOr(() => c.env.DB.prepare('SELECT * FROM creative_exports WHERE id = ?').bind(idParam(c)).first<ExportRow>(), null);
  if (!row) throw notFound('Export not found');
  const ext = row.kind === 'project_json' ? 'json' : row.kind === 'jpeg' ? 'jpg' : row.kind === 'background' ? row.mime.split('/')[1] ?? 'png' : row.kind;
  const res = await streamStudioFile(c.env, row.r2_key, row.mime, `levonis-${row.document_id}-v${row.version}.${ext}`);
  if (!res) throw notFound('Export file not found');
  return res;
});

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

/** The approved, current claims (for evidence and the model). */
async function currentClaims(db: D1Database) {
  const now = nowIso();
  return [...(await approvedClaims(db)).values()].filter((cl) => claimIsCurrent(cl, now));
}

/** A snapshot and/or a claim named by an AI request. */
async function subjectOf(db: D1Database, snapshotId: unknown, claimId: unknown): Promise<{ snapshot: ProductSnapshot | null; claim: Awaited<ReturnType<typeof currentClaims>>[number] | null }> {
  const sid = typeof snapshotId === 'string' && snapshotId ? snapshotId : null;
  const cid = typeof claimId === 'string' && claimId ? claimId : null;
  if (!sid && !cid) throw badRequest('snapshot_id or claim_id is required', 'INVALID_INPUT');
  const snapshot = sid ? await getSnapshot(db, sid) : null;
  if (sid && !snapshot) throw notFound('Snapshot not found');
  let claim = null;
  if (cid) {
    claim = (await currentClaims(db)).find((x) => x.id === cid) ?? null;
    if (!claim) throw badRequest('claim_id must name an approved, current claim', 'INVALID_INPUT');
  }
  return { snapshot, claim };
}

/** A live public offer is evidence; a manual or test snapshot never is (spec §9). */
const offerEvidence = (s: ProductSnapshot | null) => !!s && s.source === 'live' && s.data.price.offer !== null;

R.post('/ai/ideas', studio, async (c) => {
  const env = c.env;
  const db = env.DB;
  const body = await bodyOf(c);
  const key = idemKey(body.idempotency_key);
  const count = Math.min(5, Math.max(3, int(body.count, 'count', { min: 1, max: 12, def: 4 })));
  const requested = normalizePriorities(body.priorities).slice(0, 6);
  const ready = await ensureReady(env);
  const claims = await currentClaims(db);
  const bundle = await collectOpportunities(db, { priorities: [...ready.settings.priorities, ...requested].slice(0, 8), claims });
  const listing = await listProducts(db, { q: '', category: '', limit: 12, offset: 0 });
  const products = new Map(listing.products.map((p) => [p.id, { product_id: p.id, name: { ar: p.name.ar, en: p.name.en }, category_id: p.category_id, availability: p.availability, price_kind: p.price_status, live_public_offer: false }]));
  for (const o of bundle.opportunities) {
    if ((o.kind === 'offer' || o.kind === 'arrival' || o.kind === 'back_in_stock') && !products.has(o.ref)) {
      products.set(o.ref, { product_id: o.ref, name: { ar: o.label.ar, en: o.label.en }, category_id: null, availability: o.kind === 'back_in_stock' ? 'available' : 'unknown', price_kind: 'priced', live_public_offer: o.kind === 'offer' });
    } else if (o.kind === 'offer' && products.has(o.ref)) products.get(o.ref)!.live_public_offer = true;
  }
  const history = await db
    .prepare(`SELECT product_id, content_json, updated_at FROM creative_documents WHERE approved_version IS NOT NULL ORDER BY updated_at DESC LIMIT 5`)
    .all<{ product_id: string | null; content_json: string; updated_at: string }>();
  const evidenceFull = bundle.opportunities.map((o) => ({ id: o.id, kind: o.kind, ref: o.ref, label: { ar: o.label.ar, en: o.label.en }, detail: o.detail }));
  type IdeasResult = { ideas: Array<Idea & { id: string }>; rejected: number; notes: string[] };
  const out = await runAi<IdeasResult>(
    env,
    ready,
    {
      task: 'ideas',
      actorId: actorOf(c),
      idempotencyKey: key,
      request: { count, priorities: requested },
      documentId: null,
      baseVersion: null,
      targetIds: [],
      content: ideasContent({
        count,
        evidence: evidenceFull,
        products: [...products.values()],
        categories: bundle.categories,
        services: claims.map(claimText),
        priorities: [...ready.settings.priorities, ...requested],
        history: (history.results ?? []).map((h) => ({ product_id: h.product_id, objective: String((readContent(h).doc.objective)), approved_at: h.updated_at })),
        brand: (await currentBrand(db)).kit,
        feedback: await feedbackMemory(db),
      }),
      schema: IDEAS_SCHEMA,
      validate: (raw) => {
        const v = validateIdeas(raw, {
          products: new Set(products.keys()),
          services: new Set(claims.map((x) => x.id)),
          categories: new Set(bundle.categories.map((x) => x.id)),
          evidence: bundle.evidence,
          max: count,
        });
        if (!v.ideas.length) return { ok: false, reason: 'no_valid_idea', detail: v.rejected.slice(0, 12) };
        return { ok: true, result: { ideas: v.ideas.map((i) => ({ ...i, id: newId('cidea') })), rejected: v.rejected.length, notes: v.notes } };
      },
      // The batch finishes the job first; the ideas are written only when that
      // finish took (a cancel that lands mid-call leaves the job cancelled, and
      // a cancelled job's result is never stored as usable).
      persist: (job, result) =>
        result.ideas.map(({ id, ...idea }) =>
          db
            .prepare(
              `INSERT INTO creative_ideas (id, job_id, status, idea_json, product_id, created_by, created_at)
               SELECT ?, ?, 'new', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM creative_jobs WHERE id = ? AND status = 'succeeded')`
            )
            .bind(id, job.id, JSON.stringify(idea), idea.target_kind === 'product' ? idea.target_ref : null, actorOf(c), nowIso(), job.id)
        ),
    },
    creativeTransport
  );
  const stored = await ideasOfJob(db, out.job.id);
  return ok(c, { job_id: out.job.id, ideas: stored, rejected: out.result.rejected, notes: out.result.notes, usage: out.usage });
});

interface IdeaRow {
  id: string;
  job_id: string;
  status: IdeaRecordDto['status'];
  idea_json: string;
  created_at: string;
}

const ideaDto = (r: IdeaRow): IdeaRecordDto => ({ ...(JSON.parse(r.idea_json) as Idea), id: r.id, status: r.status, job_id: r.job_id, created_at: r.created_at });

async function ideasOfJob(db: D1Database, jobId: string): Promise<IdeaRecordDto[]> {
  const { results } = await db.prepare('SELECT * FROM creative_ideas WHERE job_id = ? ORDER BY created_at, id').bind(jobId).all<IdeaRow>();
  return (results ?? []).map(ideaDto);
}

R.post('/ai/compose', studio, async (c) => {
  const env = c.env;
  const db = env.DB;
  const body = await bodyOf(c);
  const key = idemKey(body.idempotency_key);
  const objective = oneOf(body.objective, 'objective', OBJECTIVES) as Objective;
  const priority = oneOf(body.priority, 'priority', VISUAL_PRIORITIES) as VisualPriority;
  const density = oneOf(body.density, 'density', ['brief', 'detailed'] as const) as Density;
  if (!isTemplateId(body.template)) throw badRequest('template is unknown', 'INVALID_INPUT');
  const template = body.template as TemplateId;
  const family = body.family === null || body.family === undefined ? null : (oneOf(body.family, 'family', FAMILY_IDS) as FamilyId);
  const locale = oneOf(body.locale, 'locale', ['ar', 'en'] as const);
  const brief = str(body.brief, 'brief', { max: 600, required: false });
  const ready = await ensureReady(env);
  const { snapshot, claim } = await subjectOf(db, body.snapshot_id, body.claim_id);
  const allowed = variantsFor(template, objective, snapshot?.data.price.status ?? null);
  const asked = (Array.isArray(body.variants) ? body.variants : []).filter(isVariantId) as VariantId[];
  const variants = (asked.length ? asked.filter((v) => allowed.includes(v)) : allowed).slice(0, 3);
  if (!variants.length) throw badRequest('none of the requested variants suits this template and objective', 'INVALID_INPUT');
  const brand = (await currentBrand(db)).kit;
  const evidence = { offer: offerEvidence(snapshot), serviceClaim: !!claim };
  const request: Omit<ComposeRequest, 'idempotency_key'> = {
    snapshot_id: snapshot?.id ?? null, claim_id: claim?.id ?? null, objective, priority, density, template, family, variants, locale, brief,
  };
  const out = await runAi(
    env,
    ready,
    {
      task: 'compose',
      actorId: actorOf(c),
      idempotencyKey: key,
      request: request as unknown as Record<string, unknown>,
      documentId: null,
      baseVersion: null,
      targetIds: [],
      content: composeContent({ snapshot: snapshot?.data ?? null, claim: claim ? claimText(claim) : null, objective, priority, density, template, family, variants, locale, brief, brand, feedback: await feedbackMemory(db) }),
      schema: COMPOSE_SCHEMA,
      validate: (raw) => {
        const v = validateCompose(raw, { variants, evidence, maxFeatures: brand.density.max_features });
        if (!v.proposals.length) return { ok: false, reason: 'no_valid_proposal', detail: v.rejected.slice(0, 12) };
        return { ok: true, result: { proposals: v.proposals, rejected: v.rejected.length, warnings: v.warnings, missing: v.missing } };
      },
    },
    creativeTransport
  );
  return ok(c, { job_id: out.job.id, ...out.result, usage: out.usage });
});

/** What an edit may place: the bound products' own pictures, approved studio assets and logos (with natural sizes). */
async function allowedAssetsFor(db: D1Database, doc: ReturnType<typeof readContent>['doc'], snapshots: Map<string, ProductSnapshot>): Promise<AllowedAssets> {
  const products: Record<string, Array<{ url: string; width: number; height: number }>> = {};
  for (const b of doc.products) {
    const s = snapshots.get(b.snapshot_id);
    products[b.slot] = (s?.data.images ?? []).filter((i) => i.same_origin && i.width && i.height).map((i) => ({ url: i.url, width: i.width!, height: i.height! }));
  }
  const { results } = await db
    .prepare(`SELECT id, kind, width, height FROM creative_assets WHERE deleted_at IS NULL AND review = 'approved' AND width IS NOT NULL AND height IS NOT NULL LIMIT 200`)
    .all<{ id: string; kind: string; width: number; height: number }>();
  const rows = results ?? [];
  return {
    products,
    assets: rows.filter((a) => a.kind !== 'logo' && a.kind !== 'reference_liked' && a.kind !== 'reference_rejected').map((a) => ({ id: a.id, width: a.width, height: a.height, kind: a.kind })),
    logos: [{ ref: 'site', ...SITE_LOGO }, ...rows.filter((a) => a.kind === 'logo').map((a) => ({ ref: a.id, width: a.width, height: a.height }))],
  };
}

R.post('/ai/edit', studio, async (c) => {
  const env = c.env;
  const db = env.DB;
  const body = await bodyOf(c);
  const key = idemKey(body.idempotency_key);
  const documentId = str(body.document_id, 'document_id', { min: 1, max: 80 });
  const baseVersion = int(body.base_version, 'base_version', { min: 1 });
  const instruction = str(body.instruction, 'instruction', { min: 1, max: 800 });
  const ready = await ensureReady(env);
  const row = await getDocRow(db, documentId);
  if (!row) throw notFound('Design not found');
  // A stale request never reaches the provider (spec §16).
  if (baseVersion !== row.version) throw new HttpError(409, 'The design changed since this request was made.', 'STALE_VERSION', { current_version: row.version });
  const { doc } = readContent(row);
  const layerIds = new Set(doc.layers.map((l) => l.id));
  let scope: string[] | null = null;
  if (body.scope_ids !== null && body.scope_ids !== undefined) {
    if (!Array.isArray(body.scope_ids)) throw badRequest('scope_ids must be a list or null', 'INVALID_INPUT');
    scope = [...new Set(body.scope_ids.filter((x): x is string => typeof x === 'string'))].slice(0, 40);
    if (!scope.length || scope.some((s) => !layerIds.has(s))) throw badRequest('scope_ids must name layers of this design', 'INVALID_INPUT');
  }
  const annotations = normalizeDocument({ ...doc, annotations: Array.isArray(body.annotations) ? body.annotations.slice(0, 12) : [] }).doc.annotations;
  const brand = (await currentBrand(db)).kit;
  const snapshots = await getSnapshots(db, doc.products.map((p) => p.snapshot_id));
  const allowed = await allowedAssetsFor(db, doc, snapshots);
  const claims = await approvedClaims(db, doc.services.map((s) => s.claim_id));
  const now = nowIso();
  const evidence = {
    offer: [...snapshots.values()].some(offerEvidence),
    serviceClaim: doc.services.some((s) => { const cl = claims.get(s.claim_id); return !!cl && claimIsCurrent(cl, now); }),
  };
  const out = await runAi(
    env,
    ready,
    {
      task: 'edit',
      actorId: actorOf(c),
      idempotencyKey: key,
      request: { document_id: documentId, base_version: baseVersion, instruction, scope_ids: scope, annotations },
      documentId,
      baseVersion,
      targetIds: scope ?? [],
      content: editContent({
        documentId, version: row.version, doc, instruction, scope, annotations, brand,
        allowed: {
          variants: doc.template ? ['product_first', 'price_first', 'feature_first', 'headline_first'] : [],
          background_presets: brand.backgrounds.map((b) => b.id),
          asset_ids: allowed.assets.map((a) => a.id),
          logos: allowed.logos.map((l) => l.ref),
          product_pictures: Object.fromEntries(Object.entries(allowed.products).map(([slot, list]) => [slot, list.map((p) => p.url)])),
          palette: brand.colors.palette,
        },
      }),
      schema: EDIT_SCHEMA,
      validate: (raw) => {
        // Against the STORED document at the version the request named — never the editor's local copy.
        const v = validateEditPatch(raw, { documentId, version: row.version, doc, scope, evidence, ops: { brand, allowed } });
        if (!v.ok) return { ok: false, reason: v.code, detail: v.detail };
        return { ok: true, result: { patch: v.patch } };
      },
    },
    creativeTransport
  );
  return ok(c, { job_id: out.job.id, patch: out.result.patch, usage: out.usage });
});

const MAX_REVIEW_IMAGE_BYTES = 3_750_000;

R.post('/ai/review', studio, async (c) => {
  const env = c.env;
  const db = env.DB;
  const body = await bodyOf(c);
  const key = idemKey(body.idempotency_key);
  const documentId = str(body.document_id, 'document_id', { min: 1, max: 80 });
  const version = int(body.version, 'version', { min: 1 });
  const b64 = typeof body.image_base64 === 'string' ? body.image_base64.replace(/^data:image\/[a-z]+;base64,/, '') : '';
  if (!b64 || b64.length > Math.ceil((MAX_REVIEW_IMAGE_BYTES * 4) / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw badRequest('image_base64 must be a PNG, JPEG or WebP under 3.75 MB', 'INVALID_INPUT');
  const ready = await ensureReady(env);
  if (!ready.settings.vision_review || ready.settings.capabilities.vision === false) {
    throw new HttpError(409, 'Visual review is off, or the chosen model cannot read pictures.', 'VISION_REVIEW_DISABLED');
  }
  const row = await getDocRow(db, documentId);
  if (!row) throw notFound('Design not found');
  if (version !== row.version) throw new HttpError(409, 'The design changed since this preview was rendered.', 'STALE_VERSION', { current_version: row.version });
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  } catch {
    throw badRequest('image_base64 is not valid base64', 'INVALID_INPUT');
  }
  const img = sniffStudioImage(bytes);
  const { doc } = readContent(row);
  const out = await runAi(
    env,
    ready,
    {
      task: 'review',
      actorId: actorOf(c),
      idempotencyKey: key,
      request: { document_id: documentId, version, image_sha: await sha256OfBytes(bytes) },
      documentId,
      baseVersion: version,
      targetIds: [],
      content: reviewContent({ documentId, version, doc, image: { media_type: img.mime, data: b64 }, brand: (await currentBrand(db)).kit }),
      schema: REVIEW_SCHEMA,
      imageTokens: imageTokenAllowance(img.width, img.height),
      validate: (raw) => ({ ok: true, result: validateReview(raw, { layerIds: new Set(doc.layers.map((l) => l.id)) }) }),
    },
    creativeTransport
  );
  return ok(c, { job_id: out.job.id, notes: out.result.notes, summary: out.result.summary, usage: out.usage });
});

R.post('/ai/carousel', studio, async (c) => {
  const env = c.env;
  const db = env.DB;
  const body = await bodyOf(c);
  const key = idemKey(body.idempotency_key);
  const topic = str(body.topic, 'topic', { max: 300, required: false });
  const slides = int(body.slides, 'slides', { min: 2, max: 10, def: 5 });
  const locale = oneOf(body.locale, 'locale', ['ar', 'en'] as const);
  const ready = await ensureReady(env);
  const { snapshot, claim } = await subjectOf(db, body.snapshot_id, body.claim_id);
  const evidence = { offer: offerEvidence(snapshot), serviceClaim: !!claim };
  const out = await runAi(
    env,
    ready,
    {
      task: 'carousel',
      actorId: actorOf(c),
      idempotencyKey: key,
      request: { snapshot_id: snapshot?.id ?? null, claim_id: claim?.id ?? null, topic, slides, locale },
      documentId: null,
      baseVersion: null,
      targetIds: [],
      content: carouselContent({ snapshot: snapshot?.data ?? null, claim: claim ? claimText(claim) : null, topic, slides, locale, brand: (await currentBrand(db)).kit, feedback: await feedbackMemory(db) }),
      schema: CAROUSEL_SCHEMA,
      validate: (raw) => {
        const v = validateCarousel(raw, { evidence, maxSlides: slides });
        if (!v.slides.length) return { ok: false, reason: 'no_valid_slide', detail: v.rejected.slice(0, 12) };
        return { ok: true, result: { slides: v.slides, caption: v.caption, rejected: v.rejected.length } };
      },
    },
    creativeTransport
  );
  return ok(c, { job_id: out.job.id, ...out.result, usage: out.usage });
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

R.get('/jobs', studio, async (c) => {
  const out = await readOr(async () => {
    const { results } = await c.env.DB.prepare('SELECT * FROM creative_jobs ORDER BY created_at DESC LIMIT 50').all();
    return { migrated: true, jobs: ((results ?? []) as never[]).map(jobDto) };
  }, { migrated: false, jobs: [] });
  return ok(c, out);
});

R.post('/jobs/:id/cancel', studio, async (c) => {
  const job = await writeOr503(() => cancelJob(c.env.DB, idParam(c)));
  return ok(c, { job: jobDto(job) });
});

R.post('/jobs/:id/applied', studio, async (c) => {
  const id = idParam(c);
  const body = await bodyOf(c);
  const documentId = str(body.document_id, 'document_id', { min: 1, max: 80 });
  const version = int(body.version, 'version', { min: 1 });
  const db = c.env.DB;
  const existing = await writeOr503(() => jobById(db, id));
  // Saving with `job_id` already marked it applied for this very version: the same report again is a no-op, not an error.
  if (existing && existing.applied_at && existing.applied_version === version && (existing.document_id === null || existing.document_id === documentId)) {
    return ok(c, { job: jobDto(existing) });
  }
  const job = await markApplied(db, id, documentId, version);
  return ok(c, { job: jobDto(job) });
});

// ---------------------------------------------------------------------------
// Opportunities, ideas, feedback, the catalogue watch
// ---------------------------------------------------------------------------

R.get('/opportunities', studio, async (c) => {
  const db = c.env.DB;
  const settings = await readProviderSettings(db);
  const claims = settings.migrated ? await currentClaims(db) : [];
  const bundle = await collectOpportunities(db, { priorities: settings.priorities, claims });
  return ok(c, { migrated: settings.migrated, opportunities: bundle.opportunities });
});

R.get('/ideas', studio, async (c) => {
  const out = await readOr(async () => {
    const { results } = await c.env.DB.prepare(`SELECT * FROM creative_ideas WHERE status <> 'dismissed' ORDER BY created_at DESC LIMIT 60`).all<IdeaRow>();
    return { migrated: true, ideas: (results ?? []).map(ideaDto) };
  }, { migrated: false, ideas: [] as IdeaRecordDto[] });
  return ok(c, out);
});

R.patch('/ideas/:id', studio, async (c) => {
  const id = idParam(c);
  const status = oneOf((await bodyOf(c)).status, 'status', ['new', 'used', 'dismissed'] as const);
  const db = c.env.DB;
  const res = await writeOr503(() => db.prepare('UPDATE creative_ideas SET status = ? WHERE id = ?').bind(status, id).run());
  if ((res.meta?.changes ?? 0) !== 1) throw notFound('Idea not found');
  const row = (await db.prepare('SELECT * FROM creative_ideas WHERE id = ?').bind(id).first<IdeaRow>())!;
  return ok(c, { idea: ideaDto(row) });
});

interface FeedbackRow {
  id: string;
  document_id: string | null;
  kind: FeedbackDto['kind'];
  reasons_json: string;
  note: string;
  scope: FeedbackDto['scope'];
  created_by: string | null;
  created_at: string;
}

const feedbackDto = (r: FeedbackRow, names: Map<string, string>): FeedbackDto => ({
  id: r.id, document_id: r.document_id, kind: r.kind, reasons: stringList(r.reasons_json) as RejectReason[], note: r.note, scope: r.scope, created_at: r.created_at,
  created_by_name: r.created_by ? names.get(r.created_by) ?? null : null,
});

R.post('/feedback', studio, async (c) => {
  const body = await bodyOf(c);
  const kind = oneOf(body.kind, 'kind', ['note', 'like', 'reject'] as const);
  const scope = body.scope === undefined ? 'document' : oneOf(body.scope, 'scope', ['document', 'brand'] as const);
  const note = str(body.note, 'note', { max: 600, required: false });
  const reasons = (Array.isArray(body.reasons) ? body.reasons : []).filter((r): r is RejectReason => (REJECT_REASONS as readonly string[]).includes(r as string));
  if (!note && !reasons.length) throw badRequest('feedback needs a note or a reason', 'INVALID_INPUT');
  const documentId = typeof body.document_id === 'string' && body.document_id ? body.document_id : null;
  const db = c.env.DB;
  if (documentId !== null && !(await writeOr503(() => getDocRow(db, documentId)))) throw notFound('Design not found');
  const id = newId('cfbk');
  await writeOr503(() =>
    db
      .prepare(`INSERT INTO creative_feedback (id, document_id, kind, reasons_json, note, scope, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, documentId, kind, JSON.stringify([...new Set(reasons)]), note, scope, actorOf(c), nowIso())
      .run()
  );
  const row = (await db.prepare('SELECT * FROM creative_feedback WHERE id = ?').bind(id).first<FeedbackRow>())!;
  return ok(c, { feedback: feedbackDto(row, await namesOf(db, [row.created_by])) }, 201);
});

R.get('/feedback', studio, async (c) => {
  const db = c.env.DB;
  const out = await readOr(async () => {
    const { results } = await db.prepare('SELECT * FROM creative_feedback ORDER BY created_at DESC LIMIT 100').all<FeedbackRow>();
    const rows = results ?? [];
    const names = await namesOf(db, rows.map((r) => r.created_by));
    return { migrated: true, feedback: rows.map((r) => feedbackDto(r, names)) };
  }, { migrated: false, feedback: [] as FeedbackDto[] });
  return ok(c, out);
});

R.post('/watch/sync', studio, async (c) => {
  try {
    return ok(c, await syncCatalogWatch(c.env.DB));
  } catch (e) {
    if (isMissingSchema(e)) throw schemaMissing();
    throw e;
  }
});

