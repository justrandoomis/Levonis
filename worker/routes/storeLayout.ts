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
 *
 * EVERY WRITE NORMALISES (packages/storeLayout) with the owner's id and then
 * checks the references against the store's own rows (worker/lib/storeLayout).
 * A fatal issue — an unsafe link, somebody else's media, a future schema, an
 * oversize layout — refuses the write with LAYOUT_REJECTED and the list of
 * issues; anything merely cleaned is saved and reported back as `issues`.
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
import { blockDataFor, publishedLayout, verifyLayoutRefs } from '../lib/storeLayout';
import { normalizeLayout, renderableBlocks, type LayoutIssue } from '@levonis/storeLayout/normalize';
import { defaultLayoutFromStore } from '@levonis/storeLayout/defaults';
import { MAX_BLOCKS, MAX_LAYOUT_BYTES, MAX_REQUEST_BYTES, SCHEMA_VERSION, type StoreLayout } from '@levonis/storeLayout/schema';
import { THEME_NAMES } from '@levonis/storeLayout/tokens';

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
 */
async function acceptLayout(
  db: D1Database,
  ctx: StoreContext,
  raw: unknown
): Promise<{ layout: StoreLayout; issues: LayoutIssue[] }> {
  const first = normalizeLayout(raw, { ownerUserId: ctx.store.user_id });
  if (!first.ok) {
    throw new HttpError(400, 'This layout contains something a store page cannot hold', 'LAYOUT_REJECTED', {
      issues: first.issues.slice(0, 50),
    });
  }
  const verified = await verifyLayoutRefs(db, ctx, first.layout);
  return { layout: verified.layout, issues: [...first.issues, ...verified.issues].slice(0, 50) };
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

storeLayoutRoutes.put('/draft', async (c) => {
  const ctx = await requireStoreOwner(c);
  await rateLimit(c, 'store-layout-draft', 240, 900);
  const body = await readBody(c);
  const expected = versionOf(body);
  const { layout, issues } = await acceptLayout(c.env.DB, ctx, body.layout);
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
  const ctx = await requireStoreOwner(c);
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
  const ctx = await requireStoreOwner(c);
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
