/**
 * The store page's draft, publish, history and restore — /api/merchant/store/layout.
 *
 * Merchant administration, so the rules of /api/merchant/* hold: the store is
 * resolved from the SESSION (`requireStoreOwner`) and every statement below is
 * scoped by that store's id in SQL. There is no store id in any path or body.
 *
 *   GET    /                    the draft (or what a draft would start from),
 *                               the published revision, the newest revisions
 *   PUT    /draft               save the draft — {layout, version}; version 0
 *                               creates it. 409 DRAFT_CHANGED when another tab
 *                               saved first.
 *   POST   /publish             {version, note?} — the draft AS SAVED becomes a
 *                               new revision and the storefront's pointer moves
 *                               to it, in ONE batch fenced on the draft version
 *   GET    /revisions           ?cursor=<revision>&limit= — newest first
 *   GET    /revisions/:rev      one revision's layout, to look at before restoring
 *   POST   /restore/:rev        {version, publish?, note?} — copy a revision into
 *                               the draft; with publish, also publish it as a
 *                               NEW revision in the same batch
 *   GET    /preview             the draft (or ?revision=) with the rows its
 *                               blocks show — owner only, never cached, never
 *                               public
 *   GET    /media               ?kind=image|video — the owner's own uploads a
 *                               layout may hold, for the builder's picker (W4-A);
 *                               since P5 each row carries `byte_size` and
 *                               `used_in` (where the file is still shown)
 *   DELETE /media/<key>         forget a library file nothing shows any more:
 *                               MEDIA_IN_USE {used_in, where} while something
 *                               does, else `file_objects.deleted_at` is set and
 *                               the bytes are left to the media sweep
 *
 * EVERY WRITE NORMALISES (packages/storeLayout) with the owner's id and then
 * checks the references against the store's own rows (worker/lib/storeLayout).
 * A fatal issue — an unsafe link, somebody else's media, a future schema, an
 * oversize layout — refuses the write with LAYOUT_REJECTED and the list of
 * issues; anything merely cleaned is saved and reported back as `issues`.
 * Two more refusals since P5 (media everywhere): a file heavier than its slot
 * allows refuses the DRAFT save with LAYOUT_MEDIA_TOO_HEAVY {size, max} — the
 * merchant just picked it and the picker says so — while publish and restore
 * drop it with the issue `media_too_heavy`; and a hero or background video
 * without its poster refuses PUBLISH with LAYOUT_POSTER_REQUIRED {paths}.
 *
 * Changing the look never touches content: these routes write only the two
 * layout tables and the store's pointer. Products, reviews, collections,
 * services, orders and the store's own words are other tables, read by id.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, HttpError } from '../lib/http';
import { requireStoreOwner, type StoreContext } from '../lib/merchantAuth';
import { rateLimit } from '../lib/ratelimit';
import { auditStatements } from '../lib/audit';
import { newId } from '../lib/crypto';
import { isConstraintAbort } from '../lib/walletOps';
import { blockDataFor, mediaUsedIn, publishedLayout, verifyLayoutRefs } from '../lib/storeLayout';
import { afterStorefrontWrite } from '../lib/edgePolicy';
import { normalizeLayout, renderableBlocks, type LayoutIssue } from '@levonis/storeLayout/normalize';
import { defaultLayoutFromStore } from '@levonis/storeLayout/defaults';
import { MAX_BLOCKS, MAX_LAYOUT_BYTES, MAX_REQUEST_BYTES, SCHEMA_VERSION, type StoreLayout } from '@levonis/storeLayout/schema';
import { THEME_NAMES } from '@levonis/storeLayout/tokens';
import { mediaKey, type MediaKind } from '@levonis/storeLayout/refs';
import { missingPosters } from '@levonis/storeLayout/verify';
import { baghdadDay } from '../lib/baghdadTime';
import { rootDomainFrom, storeUrl } from '../lib/hosts';
import {
  auditLayoutWeight,
  pageSpeedUrl,
  pickFirstProductRow,
  readVitalsDays,
  summarizeVitals,
  type VitalsDevice,
} from '../lib/storeSpeed';

export const storeLayoutRoutes = new Hono<AppContext>();

storeLayoutRoutes.use('*', requireAuth);

/** Published revisions kept per store; the publish batch prunes the rest. */
export const MAX_REVISIONS = 50;
const NOTE_MAX = 200;

const nowIso = () => new Date().toISOString();

interface DraftRow {
  layout_json: string;
  base_revision: number | null;
  updated_at: string;
  version: number;
}

interface RevisionRow {
  id: string;
  revision: number;
  schema_version: number;
  layout_json?: string;
  published_at: string;
  note: string;
  restored_from: number | null;
}

// ---------------------------------------------------------------- helpers

/** The request body, refused before parsing when it is oversize or not JSON. */
async function readBody(c: Context<AppContext>): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_REQUEST_BYTES) throw tooLarge();
  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > MAX_REQUEST_BYTES) throw tooLarge();
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON', 'INVALID_JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'The request body must be an object', 'INVALID_JSON');
  }
  return body as Record<string, unknown>;
}

const tooLarge = () =>
  new HttpError(413, 'This layout is larger than a store page may be', 'LAYOUT_TOO_LARGE', {
    max_bytes: MAX_LAYOUT_BYTES,
  });

/** The draft version the editor saw: 0 = "there was no draft". */
function versionOf(body: Record<string, unknown>): number {
  const v = body.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1_000_000_000) {
    throw new HttpError(400, 'Send the draft version you are editing', 'VERSION_REQUIRED');
  }
  return v;
}

function noteOf(body: Record<string, unknown>): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  return typeof body.note === 'string' ? body.note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, NOTE_MAX) : '';
}

const draftChanged = (version: number | null) =>
  new HttpError(409, 'The draft changed since you opened it', 'DRAFT_CHANGED', { version });

/**
 * Normalise with the owner's id, refuse on any fatal issue, then check the
 * references against the store's own rows. The single path every write takes.
 *
 * `refuseHeavy` (the draft save and the posted preview — the layout the
 * CLIENT just sent): a file over its slot's cap is refused with
 * LAYOUT_MEDIA_TOO_HEAVY and the figures, so the picker can say them. Publish
 * and restore re-check a layout that was already saved: there the drop stays
 * an issue (`media_too_heavy`), like a picture deleted since the save.
 */
async function acceptLayout(
  db: D1Database,
  ctx: StoreContext,
  raw: unknown,
  opts: { refuseHeavy?: boolean } = {}
): Promise<{ layout: StoreLayout; issues: LayoutIssue[] }> {
  const first = normalizeLayout(raw, { ownerUserId: ctx.store.user_id });
  if (!first.ok) {
    throw new HttpError(400, 'This layout contains something a store page cannot hold', 'LAYOUT_REJECTED', {
      issues: first.issues.slice(0, 50),
    });
  }
  const verified = await verifyLayoutRefs(db, ctx, first.layout);
  if (opts.refuseHeavy && verified.heavy.length) {
    const [h] = verified.heavy;
    throw new HttpError(400, 'A file is heavier than its place on the page allows', 'LAYOUT_MEDIA_TOO_HEAVY', {
      path: h.path,
      block_id: h.block_id,
      size: h.size,
      max: h.max,
      heavy: verified.heavy.slice(0, 20).map((x) => ({ path: x.path, block_id: x.block_id, size: x.size, max: x.max })),
    });
  }
  return { layout: verified.layout, issues: [...first.issues, ...verified.issues].slice(0, 50) };
}

/** The poster rule at publish (storefront L3/L4): a hero or background video needs its still. */
function requirePosters(layout: StoreLayout): void {
  const paths = missingPosters(layout);
  if (paths.length) {
    throw new HttpError(400, 'Pick a poster image for the video before publishing', 'LAYOUT_POSTER_REQUIRED', { paths });
  }
}

async function readDraft(db: D1Database, storeId: string): Promise<DraftRow | null> {
  return db
    .prepare('SELECT layout_json, base_revision, updated_at, version FROM store_layout_drafts WHERE store_id = ?')
    .bind(storeId)
    .first<DraftRow>();
}

function revisionOut(r: RevisionRow, liveId: string | null) {
  return {
    id: r.id,
    revision: Number(r.revision),
    schema_version: Number(r.schema_version),
    published_at: r.published_at,
    note: r.note ?? '',
    restored_from: r.restored_from === null || r.restored_from === undefined ? null : Number(r.restored_from),
    live: r.id === liveId,
  };
}

async function livePointer(db: D1Database, ctx: StoreContext): Promise<string | null> {
  const row = await db
    .prepare('SELECT published_revision_id AS id FROM merchant_stores WHERE id = ? AND user_id = ?')
    .bind(ctx.store.id, ctx.store.user_id)
    .first<{ id: string | null }>();
  return row?.id ?? null;
}

/**
 * THE PUBLISH BATCH. `content` is the verified layout; `expectedVersion` the
 * draft version it was read at. In order, all or nothing:
 *
 *   1. the revision row, whose `layout_json` is
 *      `CASE WHEN <the draft is still at expectedVersion> THEN content ELSE NULL END`
 *      — a draft that moved (another tab saved, another publish won) makes it
 *      NULL, the NOT NULL constraint aborts the batch, and nothing below runs;
 *      its number is the store's maximum + 1, computed inside the transaction
 *      (UNIQUE(store_id, revision) is the second fence);
 *   2. the draft: set to the published content, version + 1, based on the
 *      new revision — so one draft version is published at most once;
 *   3. the store's pointer — the ONLY thing the public storefront reads;
 *   4. pruning to the newest MAX_REVISIONS, never the one just published;
 *   5. the audit row, in the same batch, so a publish cannot land unaudited.
 */
async function publishStatements(
  db: D1Database,
  ctx: StoreContext,
  p: { revisionId: string; content: string; expectedVersion: number; userId: string; note: string; restoredFrom: number | null; at: string }
): Promise<D1PreparedStatement[]> {
  const storeId = ctx.store.id;
  const audit = await auditStatements(db, p.userId, 'merchant.layout_published', storeId, {
    revision_id: p.revisionId,
    draft_version: p.expectedVersion,
    restored_from: p.restoredFrom,
  });
  return [
    db
      .prepare(
        `INSERT INTO store_layout_revisions (id, store_id, revision, schema_version, layout_json, published_by, published_at, note, restored_from)
         SELECT ?1, ?2,
                (SELECT COALESCE(MAX(revision), 0) + 1 FROM store_layout_revisions WHERE store_id = ?2),
                ?3,
                CASE WHEN (SELECT version FROM store_layout_drafts WHERE store_id = ?2) = ?4 THEN ?5 ELSE NULL END,
                ?6, ?7, ?8, ?9`
      )
      .bind(p.revisionId, storeId, SCHEMA_VERSION, p.expectedVersion, p.content, p.userId, p.at, p.note, p.restoredFrom),
    db
      .prepare(
        `UPDATE store_layout_drafts
            SET layout_json = ?1, version = version + 1, updated_by = ?2, updated_at = ?3,
                base_revision = (SELECT revision FROM store_layout_revisions WHERE id = ?4)
          WHERE store_id = ?5`
      )
      .bind(p.content, p.userId, p.at, p.revisionId, storeId),
    db
      .prepare('UPDATE merchant_stores SET published_revision_id = ?1 WHERE id = ?2 AND user_id = ?3')
      .bind(p.revisionId, storeId, ctx.store.user_id),
    db
      .prepare(
        `DELETE FROM store_layout_revisions
          WHERE store_id = ?1 AND id <> ?2
            AND revision <= (SELECT MAX(revision) FROM store_layout_revisions WHERE store_id = ?1) - ?3`
      )
      .bind(storeId, p.revisionId, MAX_REVISIONS),
    ...audit.statements,
  ];
}

/**
 * The draft write a restore makes: a fresh row when the editor saw none
 * (`expectedVersion` 0), else an UPDATE whose version is
 * `CASE WHEN version = expected THEN version + 1 ELSE NULL END` — a stale
 * editor aborts the batch it is in.
 */
function draftWriteStatement(
  db: D1Database,
  storeId: string,
  p: { content: string; expectedVersion: number; baseRevision: number | null; userId: string; at: string }
): D1PreparedStatement {
  if (p.expectedVersion === 0) {
    return db
      .prepare(
        `INSERT INTO store_layout_drafts (store_id, layout_json, base_revision, updated_by, updated_at, version)
         VALUES (?1, ?2, ?3, ?4, ?5, 1)`
      )
      .bind(storeId, p.content, p.baseRevision, p.userId, p.at);
  }
  return db
    .prepare(
      `UPDATE store_layout_drafts
          SET layout_json = ?1, base_revision = ?2, updated_by = ?3, updated_at = ?4,
              version = CASE WHEN version = ?5 THEN version + 1 ELSE NULL END
        WHERE store_id = ?6`
    )
    .bind(p.content, p.baseRevision, p.userId, p.at, p.expectedVersion, storeId);
}

async function publishedRow(db: D1Database, id: string) {
  return db
    .prepare('SELECT id, revision, published_at FROM store_layout_revisions WHERE id = ?')
    .bind(id)
    .first<{ id: string; revision: number; published_at: string }>();
}

// ------------------------------------------------------------------ routes

storeLayoutRoutes.get('/', async (c) => {
  const ctx = await requireStoreOwner(c);
  const db = c.env.DB;
  const [draft, live, published, list, total] = await Promise.all([
    readDraft(db, ctx.store.id),
    livePointer(db, ctx),
    publishedLayout(db, ctx),
    db
      .prepare(
        `SELECT id, revision, schema_version, published_at, note, restored_from
           FROM store_layout_revisions WHERE store_id = ? ORDER BY revision DESC LIMIT 10`
      )
      .bind(ctx.store.id)
      .all<RevisionRow>(),
    db.prepare('SELECT COUNT(*) AS n FROM store_layout_revisions WHERE store_id = ?').bind(ctx.store.id).first<{ n: number }>(),
  ]);
  const liveRevision = (list.results ?? []).find((r) => r.id === live) ?? null;

  // With no draft row, the editor starts from what the public sees: the
  // published layout, or the classic page generated from settings.
  const draftLayout = draft
    ? normalizeLayout(safeParse<unknown>(draft.layout_json, null), { ownerUserId: ctx.store.user_id }).layout
    : published.layout;
  return c.json({
    success: true,
    draft: {
      exists: !!draft,
      version: draft ? Number(draft.version) : 0,
      base_revision: draft?.base_revision ?? null,
      updated_at: draft?.updated_at ?? null,
      layout: draftLayout,
    },
    published:
      published.source === 'published'
        ? {
            revision: published.revision,
            id: live,
            published_at: liveRevision?.published_at ?? null,
            layout: published.layout,
          }
        : null,
    // Whether the draft differs from what visitors see right now.
    dirty: JSON.stringify(draftLayout) !== JSON.stringify(published.layout),
    revisions: (list.results ?? []).map((r) => revisionOut(r, live)),
    revision_count: Number(total?.n ?? 0),
    limits: { max_revisions: MAX_REVISIONS, max_blocks: MAX_BLOCKS, max_bytes: MAX_LAYOUT_BYTES },
    themes: THEME_NAMES,
  });
});

/**
 * WRITES NEED A STORE THAT IS NOT UNDER SANCTION (security review of 644e3ea, L2).
 * Reading stays open — the owner keeps their history — but a suspended
 * merchant or store cannot stage a page that would go live the moment the
 * sanction lifts. A PAUSED store may still design: pausing is the owner's own
 * choice, not Levonis's.
 */
async function requireLayoutWriter(c: Context<AppContext>): Promise<StoreContext> {
  const ctx = await requireStoreOwner(c);
  if (ctx.merchant.status === 'suspended') {
    throw new HttpError(403, 'This merchant account is suspended. Contact support.', 'MERCHANT_SUSPENDED');
  }
  if (ctx.store.status === 'suspended') {
    throw new HttpError(403, 'This store is suspended by Levonis. Contact support.', 'STORE_SUSPENDED');
  }
  return ctx;
}

storeLayoutRoutes.put('/draft', async (c) => {
  const ctx = await requireLayoutWriter(c);
  await rateLimit(c, 'store-layout-draft', 240, 900);
  const body = await readBody(c);
  const expected = versionOf(body);
  const { layout, issues } = await acceptLayout(c.env.DB, ctx, body.layout, { refuseHeavy: true });
  const user = c.get('user')!;
  const at = nowIso();
  const content = JSON.stringify(layout);

  if (expected === 0) {
    try {
      await c.env.DB.prepare(
        `INSERT INTO store_layout_drafts (store_id, layout_json, base_revision, updated_by, updated_at, version)
         VALUES (?, ?, (SELECT r.revision FROM merchant_stores s JOIN store_layout_revisions r ON r.id = s.published_revision_id WHERE s.id = ?), ?, ?, 1)`
      )
        .bind(ctx.store.id, content, ctx.store.id, user.id, at)
        .run();
    } catch (e) {
      if (!isConstraintAbort(e)) throw e;
      const now = await readDraft(c.env.DB, ctx.store.id);
      throw draftChanged(now ? Number(now.version) : null);
    }
  } else {
    const res = await c.env.DB.prepare(
      `UPDATE store_layout_drafts SET layout_json = ?, updated_by = ?, updated_at = ?, version = version + 1
        WHERE store_id = ? AND version = ?`
    )
      .bind(content, user.id, at, ctx.store.id, expected)
      .run();
    if (!res.meta.changes) {
      const now = await readDraft(c.env.DB, ctx.store.id);
      throw draftChanged(now ? Number(now.version) : null);
    }
  }
  const saved = await readDraft(c.env.DB, ctx.store.id);
  return c.json({
    success: true,
    draft: {
      exists: true,
      version: Number(saved?.version ?? expected + 1),
      base_revision: saved?.base_revision ?? null,
      updated_at: saved?.updated_at ?? at,
      layout,
    },
    issues,
  });
});

storeLayoutRoutes.post('/publish', async (c) => {
  const ctx = await requireLayoutWriter(c);
  await rateLimit(c, 'store-layout-publish', 60, 3600);
  const body = await readBody(c);
  const expected = versionOf(body);
  const db = c.env.DB;
  const draft = await readDraft(db, ctx.store.id);
  if (!draft) throw new HttpError(409, 'Save a draft before publishing it', 'DRAFT_MISSING');
  if (Number(draft.version) !== expected) throw draftChanged(Number(draft.version));

  // What was saved is checked AGAIN: a picture deleted, a product removed or a
  // coupon retired since the save is taken out now, not served.
  const { layout, issues } = await acceptLayout(db, ctx, safeParse<unknown>(draft.layout_json, null));
  if (!renderableBlocks(layout).length) {
    throw new HttpError(400, 'A store page needs at least one visible block', 'LAYOUT_EMPTY');
  }
  requirePosters(layout);
  const user = c.get('user')!;
  const revisionId = newId();
  try {
    await db.batch(
      await publishStatements(db, ctx, {
        revisionId,
        content: JSON.stringify(layout),
        expectedVersion: expected,
        userId: user.id,
        note: noteOf(body),
        restoredFrom: null,
        at: nowIso(),
      })
    );
  } catch (e) {
    if (!isConstraintAbort(e)) throw e;
    const now = await readDraft(db, ctx.store.id);
    throw draftChanged(now ? Number(now.version) : null);
  }
  const row = await publishedRow(db, revisionId);
  const after = await readDraft(db, ctx.store.id);
  await afterStorefrontWrite(c, ctx.store); // P2a: the cached shopfront follows the publish
  return c.json({
    success: true,
    published: { id: revisionId, revision: Number(row?.revision), published_at: row?.published_at ?? null },
    draft: { exists: true, version: Number(after?.version), base_revision: after?.base_revision ?? null, layout },
    issues,
  });
});

storeLayoutRoutes.get('/revisions', async (c) => {
  const ctx = await requireStoreOwner(c);
  const limitRaw = Number(c.req.query('limit') ?? 20);
  const limit = Number.isInteger(limitRaw) ? Math.min(MAX_REVISIONS, Math.max(1, limitRaw)) : 20;
  const cursorRaw = Number(c.req.query('cursor') ?? 0);
  const cursor = Number.isInteger(cursorRaw) && cursorRaw > 0 ? cursorRaw : 0;
  const [live, { results }] = await Promise.all([
    livePointer(c.env.DB, ctx),
    c.env.DB.prepare(
      `SELECT id, revision, schema_version, published_at, note, restored_from
         FROM store_layout_revisions
        WHERE store_id = ?1 AND (?2 = 0 OR revision < ?2)
        ORDER BY revision DESC LIMIT ?3`
    )
      .bind(ctx.store.id, cursor, limit)
      .all<RevisionRow>(),
  ]);
  const rows = results ?? [];
  return c.json({
    success: true,
    revisions: rows.map((r) => revisionOut(r, live)),
    next_cursor: rows.length === limit ? Number(rows[rows.length - 1].revision) : null,
  });
});

async function revisionByNumber(db: D1Database, ctx: StoreContext, raw: string | undefined): Promise<RevisionRow> {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, 'No such revision', 'REVISION_NOT_FOUND');
  const row = await db
    .prepare(
      `SELECT id, revision, schema_version, layout_json, published_at, note, restored_from
         FROM store_layout_revisions WHERE store_id = ? AND revision = ?`
    )
    .bind(ctx.store.id, n)
    .first<RevisionRow>();
  if (!row) throw new HttpError(404, 'No such revision', 'REVISION_NOT_FOUND');
  return row;
}

storeLayoutRoutes.get('/revisions/:revision', async (c) => {
  const ctx = await requireStoreOwner(c);
  const [row, live] = await Promise.all([revisionByNumber(c.env.DB, ctx, c.req.param('revision')), livePointer(c.env.DB, ctx)]);
  const { layout } = normalizeLayout(safeParse<unknown>(row.layout_json ?? '', null), { ownerUserId: ctx.store.user_id });
  return c.json({ success: true, revision: { ...revisionOut(row, live), layout } });
});

storeLayoutRoutes.post('/restore/:revision', async (c) => {
  const ctx = await requireLayoutWriter(c);
  await rateLimit(c, 'store-layout-publish', 60, 3600);
  const body = await readBody(c);
  const expected = versionOf(body);
  const publish = body.publish === true;
  const db = c.env.DB;
  const row = await revisionByNumber(db, ctx, c.req.param('revision'));
  // Checked up front so a stale editor is told before anything is written;
  // the batch below is still fenced on the same version for the race.
  const current = await readDraft(db, ctx.store.id);
  if ((current ? Number(current.version) : 0) !== expected) throw draftChanged(current ? Number(current.version) : null);
  const { layout, issues } = await acceptLayout(db, ctx, safeParse<unknown>(row.layout_json ?? '', null));
  if (publish && !renderableBlocks(layout).length) {
    throw new HttpError(400, 'A store page needs at least one visible block', 'LAYOUT_EMPTY');
  }
  if (publish) requirePosters(layout);
  const user = c.get('user')!;
  const at = nowIso();
  const content = JSON.stringify(layout);
  const restoredFrom = Number(row.revision);
  const revisionId = newId();
  const statements: D1PreparedStatement[] = [
    draftWriteStatement(db, ctx.store.id, { content, expectedVersion: expected, baseRevision: restoredFrom, userId: user.id, at }),
  ];
  if (publish) {
    // The draft is now at expected + 1 (the write above either did that or
    // aborted the batch); the publish is fenced on exactly that.
    statements.push(
      ...(await publishStatements(db, ctx, {
        revisionId,
        content,
        expectedVersion: expected + 1,
        userId: user.id,
        note: noteOf(body) || `#${restoredFrom}`,
        restoredFrom,
        at,
      }))
    );
  } else {
    const audit = await auditStatements(db, user.id, 'merchant.layout_restored', ctx.store.id, {
      revision: restoredFrom,
      draft_version: expected,
    });
    statements.push(...audit.statements);
  }
  let changes = 1;
  try {
    const res = await db.batch(statements);
    changes = Number(res[0]?.meta?.changes ?? 0);
  } catch (e) {
    if (!isConstraintAbort(e)) throw e;
    changes = 0;
  }
  if (!changes) {
    // Either a stale version aborted the batch, or the draft the editor saw
    // was deleted under it (an UPDATE of no row) — both are «reload the draft».
    const now = await readDraft(db, ctx.store.id);
    throw draftChanged(now ? Number(now.version) : null);
  }
  const after = await readDraft(db, ctx.store.id);
  const published = publish ? await publishedRow(db, revisionId) : null;
  if (publish) await afterStorefrontWrite(c, ctx.store); // P2a: the cached shopfront follows the publish
  return c.json({
    success: true,
    restored_from: restoredFrom,
    draft: { exists: true, version: Number(after?.version), base_revision: after?.base_revision ?? null, layout },
    published: published ? { id: published.id, revision: Number(published.revision), published_at: published.published_at } : null,
    issues,
  });
});

storeLayoutRoutes.get('/preview', async (c) => {
  const ctx = await requireStoreOwner(c);
  const db = c.env.DB;
  const revisionParam = c.req.query('revision');
  let layout: StoreLayout;
  let source: 'draft' | 'revision' | 'published' | 'default';
  if (revisionParam) {
    const row = await revisionByNumber(db, ctx, revisionParam);
    layout = normalizeLayout(safeParse<unknown>(row.layout_json ?? '', null), { ownerUserId: ctx.store.user_id }).layout;
    source = 'revision';
  } else {
    const draft = await readDraft(db, ctx.store.id);
    if (draft) {
      layout = normalizeLayout(safeParse<unknown>(draft.layout_json, null), { ownerUserId: ctx.store.user_id }).layout;
      source = 'draft';
    } else {
      const published = await publishedLayout(db, ctx);
      layout = published.layout;
      source = published.source;
    }
  }
  if (!layout.blocks.length && source !== 'draft') layout = defaultLayoutFromStore(ctx.store);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true, source, layout, blocks_data: await blockDataFor(db, ctx, layout) });
});

/**
 * THE ROWS FOR A LAYOUT THAT IS NOT SAVED (review of the store builder,
 * 2026-09-28). The template gallery draws each starter with the merchant's
 * OWN products, collections, services, works and reviews before one is
 * chosen — and nothing is written. The layout passes the same gate as a save
 * (normalised for this owner, its references verified against this store),
 * and the planner reads this store's rows only (`blockDataFor` is scoped by
 * the store id), so a posted layout can never show another shop's data.
 */
storeLayoutRoutes.post('/preview', async (c) => {
  const ctx = await requireStoreOwner(c);
  await rateLimit(c, 'store-layout-preview', 240, 900);
  const body = await readBody(c);
  const { layout, issues } = await acceptLayout(c.env.DB, ctx, body.layout, { refuseHeavy: true });
  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true, source: 'posted', layout, issues, blocks_data: await blockDataFor(c.env.DB, ctx, layout) });
});

/**
 * THE BUILDER'S MEDIA LIBRARY (W4-A) — the pictures or videos this store's
 * owner uploaded, newest first, for the block inspector's picker.
 *
 *   GET /media?kind=image|video&cursor=<created_at|key>&limit=
 *
 * Read-only, and only what a layout could hold: rows under the owner's id in
 * the `merchants` domain, not deleted, of the asked kind by the LEDGER's mime
 * (a `.webp` recorded as video is not offered as a picture), and whose key
 * passes the schema's own `mediaKey` for this owner — so every key offered is
 * one `verifyLayoutRefs` will accept. Keyset paging on the owner index.
 *
 * Library v2 (P5, storefront B1): each row also carries `byte_size` — the
 * picker checks it against the slot's `max_bytes` before offering the file —
 * and `used_in`, where the file is still shown (worker/lib/storeLayout.ts
 * `mediaUsedIn`), so «حذف» is offered only for a file nothing uses.
 */
storeLayoutRoutes.get('/media', async (c) => {
  const ctx = await requireStoreOwner(c);
  const kind: MediaKind = c.req.query('kind') === 'video' ? 'video' : 'image';
  const limitRaw = Number(c.req.query('limit') ?? 36);
  const limit = Number.isInteger(limitRaw) ? Math.min(60, Math.max(1, limitRaw)) : 36;
  const cursorRaw = String(c.req.query('cursor') ?? '');
  const bar = cursorRaw.indexOf('|');
  const cursor = bar > 0 && cursorRaw.length <= 300 ? { at: cursorRaw.slice(0, bar), key: cursorRaw.slice(bar + 1) } : null;
  const owner = ctx.store.user_id;
  const { results } = await c.env.DB.prepare(
    `SELECT object_key, mime_type, byte_size, width, height, created_at FROM file_objects
      WHERE owner_id = ?1 AND domain = 'merchants' AND deleted_at IS NULL AND mime_type LIKE ?2
        AND (?3 = '' OR created_at < ?3 OR (created_at = ?3 AND object_key < ?4))
      ORDER BY created_at DESC, object_key DESC LIMIT ?5`
  )
    .bind(owner, kind === 'video' ? 'video/%' : 'image/%', cursor?.at ?? '', cursor?.key ?? '', limit)
    .all<{ object_key: string; mime_type: string; byte_size: number | null; width: number | null; height: number | null; created_at: string }>();
  const rows = results ?? [];
  const offered = rows.filter((r) => {
    const v = mediaKey(r.object_key, kind, owner);
    return !!v && v.ok && v.key === r.object_key;
  });
  const uses = await mediaUsedIn(c.env.DB, ctx, offered.map((r) => r.object_key));
  const items = offered.map((r) => ({
    key: r.object_key,
    kind,
    mime: r.mime_type,
    byte_size: Number(r.byte_size ?? 0),
    width: r.width === null ? null : Number(r.width),
    height: r.height === null ? null : Number(r.height),
    created_at: r.created_at,
    used_in: uses.get(r.object_key) ?? [],
  }));
  const last = rows[rows.length - 1];
  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true, items, next_cursor: rows.length === limit && last ? `${last.created_at}|${last.object_key}` : null });
});

/**
 * FORGET A LIBRARY FILE (P5, storefront B1) — DELETE /media/<key>, the key
 * with its slashes. Owner only, the key must pass the schema's `mediaKey` for
 * this owner (as image or as video) and name a live ledger row of theirs — one
 * 404 for a foreign, deleted or unknown key, so the door says nothing about
 * what exists. While anything on the store still shows the file (the draft or
 * the published page, the showcase, a collection, a product, a service, the
 * store's logo / banner, the avatar) the answer is 409 MEDIA_IN_USE with
 * `used_in` and the distinct `where` kinds, and nothing changes: a delete
 * never breaks a page. Otherwise `file_objects.deleted_at` is set — the media
 * sweep's contract; the R2 bytes are its job — with an audit row in the same
 * batch, and the library, the quota and the picker stop offering it.
 */
storeLayoutRoutes.delete('/media/*', async (c) => {
  const ctx = await requireStoreOwner(c);
  await rateLimit(c, 'store-layout-media-delete', 120, 900);
  const db = c.env.DB;
  const owner = ctx.store.user_id;
  // The key is the rest of the path after `/media/`, slashes and all; a
  // percent-encoded spelling is read too. Whatever arrives must still pass
  // `mediaKey` for this owner before it is looked up.
  const path = c.req.path;
  const cut = path.indexOf('/media/');
  let raw = cut >= 0 ? path.slice(cut + '/media/'.length) : '';
  try {
    raw = decodeURIComponent(raw);
  } catch {
    raw = '';
  }
  const notFound = () => new HttpError(404, 'No such file in your library', 'MEDIA_NOT_FOUND');
  const asImage = mediaKey(raw, 'image', owner);
  const asVideo = mediaKey(raw, 'video', owner);
  const key = asImage && asImage.ok ? asImage.key : asVideo && asVideo.ok ? asVideo.key : null;
  if (!key || !key.startsWith('merchants/')) throw notFound();
  const row = await db
    .prepare(`SELECT object_key FROM file_objects WHERE object_key = ?1 AND owner_id = ?2 AND domain = 'merchants' AND deleted_at IS NULL`)
    .bind(key, owner)
    .first<{ object_key: string }>();
  if (!row) throw notFound();
  const used = (await mediaUsedIn(db, ctx, [key])).get(key) ?? [];
  if (used.length) {
    throw new HttpError(409, 'This file is still shown on your store', 'MEDIA_IN_USE', {
      used_in: used,
      where: [...new Set(used.map((u) => u.kind))],
    });
  }
  const user = c.get('user')!;
  const at = nowIso();
  const audit = await auditStatements(db, user.id, 'merchant.media_deleted', ctx.store.id, { key });
  const res = await db.batch([
    db
      .prepare(`UPDATE file_objects SET deleted_at = ?1 WHERE object_key = ?2 AND owner_id = ?3 AND domain = 'merchants' AND deleted_at IS NULL`)
      .bind(at, key, owner),
    ...audit.statements,
  ]);
  if (!Number(res[0]?.meta?.changes ?? 0)) throw notFound();
  return c.json({ success: true, key, deleted_at: at });
});

// ------------------------------------------------------------- speed (P4)

/**
 * «سرعة متجري» (merchant platform v2 §4.5 S4/S5/S7, worker/lib/storeSpeed.ts):
 *
 *   GET /speed?source=published|draft   the first-view WEIGHT AUDIT of that
 *                                       layout — the files a phone downloads
 *                                       before the first product row, what the
 *                                       ledger says each weighs, and closed
 *                                       finding codes (the copy is the client's)
 *   GET /speed/report?days=7|28&device=phone|desktop
 *                                       the REPORT: the real-user vitals of the
 *                                       window as daily buckets, the p75 bucket
 *                                       of each vital as a WORD (null under 50
 *                                       samples), the verdict, the published
 *                                       layout's audit and the PageSpeed link
 *
 * Owner-only reads (`requireStoreOwner`, `private, no-store`): the audit names
 * the owner's own file keys, which is the one reader they may reach. Both ride
 * this router's mount; `storeSpeedRoutes` is the report as a router of its own
 * for a mount at the plan's `/api/merchant/store/speed` should the gateway
 * table gain that row.
 */
async function layoutForSpeed(db: D1Database, ctx: StoreContext, source: 'published' | 'draft'): Promise<{ layout: StoreLayout; source: 'published' | 'draft' | 'default' }> {
  if (source === 'draft') {
    const draft = await readDraft(db, ctx.store.id);
    if (draft) return { layout: normalizeLayout(safeParse<unknown>(draft.layout_json, null), { ownerUserId: ctx.store.user_id }).layout, source: 'draft' };
  }
  const published = await publishedLayout(db, ctx);
  return { layout: published.layout, source: published.source };
}

/** The audit of a layout for THIS store: its first product row from the same planner the storefront uses, then the ledger's sizes. */
async function auditFor(db: D1Database, ctx: StoreContext, layout: StoreLayout, nowIso: string) {
  const data = await blockDataFor(db, ctx, layout);
  return auditLayoutWeight(db, ctx.store, layout, pickFirstProductRow(layout, data, nowIso), nowIso);
}

storeLayoutRoutes.get('/speed', async (c) => {
  const ctx = await requireStoreOwner(c);
  const source = c.req.query('source') === 'draft' ? 'draft' : 'published';
  // The limit rides the first read's wave (review 2026-09-30); a refused read costs one harmless SELECT.
  const [, chosen] = await Promise.all([rateLimit(c, 'store-speed', 60, 60), layoutForSpeed(c.env.DB, ctx, source)]);
  const audit = await auditFor(c.env.DB, ctx, chosen.layout, nowIso());
  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true, source: chosen.source, audit });
});

async function speedReport(c: Context<AppContext>) {
  const ctx = await requireStoreOwner(c);
  const days = c.req.query('days') === '7' ? 7 : 28;
  const device: VitalsDevice = c.req.query('device') === 'desktop' ? 'desktop' : 'phone';
  const db = c.env.DB;
  const now = Date.now();
  const today = baghdadDay(now);
  const from = baghdadDay(now, -(days - 1));
  // The limit rides the first read's wave (review 2026-09-30).
  const [, rows, published] = await Promise.all([
    rateLimit(c, 'store-speed', 60, 60),
    readVitalsDays(db, ctx.store.id, device, from),
    publishedLayout(db, ctx),
  ]);
  const rum = summarizeVitals(rows, { days, today, device });
  const weight = await auditFor(db, ctx, published.layout, new Date(now).toISOString());
  const link = storeUrl(ctx.store.slug, rootDomainFrom(c.env), ctx.store.id);
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    generated_at: new Date(now).toISOString(),
    rum,
    weight,
    weight_source: published.source,
    // S7: a link, never a fetch. Null when the store has no https address of its own yet.
    psi_url: pageSpeedUrl(link),
  });
}

storeLayoutRoutes.get('/speed/report', speedReport);

/** The report as a router of its own (see above). */
export const storeSpeedRoutes = new Hono<AppContext>();
storeSpeedRoutes.use('*', requireAuth);
storeSpeedRoutes.get('/', speedReport);
