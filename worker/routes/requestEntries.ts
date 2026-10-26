/**
 * THE REQUEST EDITOR'S ENTRY DOORS (plan P1-06, docs/DECISIONS.md row 268).
 *
 *   POST /api/marketplace/print/requests                         a new DRAFT
 *        entry {kind:'blank'}                                    born empty
 *              {kind:'project', post_id}                         a project's files COPIED in
 *              {kind:'product', product_id, store}               «اطلب طباعته»: to that store only
 *              {kind:'store', merchant_id}                       «لهذا المتجر فقط»
 *   POST /api/marketplace/print/requests/:id/copy-from-project   a skipped project file, again
 *   POST /api/marketplace/print/requests/:id/send                a direct draft, sent to its store
 *
 * The editor at /requests/new creates its draft on the customer's first act
 * (the first keystroke, a file picked, a link added), so every upload has a
 * request to live on and a reload resumes the same draft. The older create
 * door (`POST /api/marketplace/requests`) asks a title of 4 characters and a
 * description of 10 before anything exists; this one asks nothing — the
 * minimums are the publish door's (REQUEST_TITLE_REQUIRED,
 * REQUEST_DESCRIPTION_REQUIRED) and the send door's.
 *
 * Every draft is BORN VERSION 3: the request row, then its print row and a
 * model through the draft save itself (`saveDraft`), so it is never read as a
 * legacy text request and the editor reads it like every other draft. A seed
 * that fails takes the empty row with it.
 *
 * THE PROJECT HANDOFF COPIES (conflict 5): every file the reader may download
 * (`mine || downloadable`, the download door's rule) and the project's cover
 * picture become the request's OWN files by sha256 (worker/lib/requestHandoff.ts),
 * so a later edit or deletion of the post never changes the request. Each copy
 * is counted and logged as the download door counts one. Models become parts.
 *
 * A DIRECT DRAFT TELLS THE STORE NOTHING. «اطلب طباعته» and «لهذا المتجر فقط»
 * make a draft addressed to one store (`visibility = 'direct'`, 0151) with no
 * conversation yet: the thread is opened and its card written only by the SEND
 * (`/send`, in the same batch as the request opening), and until then the
 * store cannot read the draft (`isDirectMerchant` asks `state <> 'draft'`).
 *
 * ONE IDLE DRAFT PER ORIGIN. An entry from a project, a product or a store
 * answers the customer's untouched draft from the same origin (never saved
 * since the entry: `updated_at = created_at`) instead of making another, so a
 * visit that types nothing leaves at most one draft behind. The origin is
 * kept in the request's private `notes` column (`entry:<kind>:<id>`), which
 * no reader but the customer's own rows ever returns.
 *
 * Behind the gate (Q1, row 262: no allow-list) like every door that starts
 * something in the community, and on the main site only: a store subdomain
 * carries the visitor's session cookie, and nothing a store page does needs
 * to create a request.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, badRequest, conflict, notFound, requireAuth, requireMainHost, str } from '../lib/http';
import { requireCommunityOpen } from '../lib/communityGate';
import { rateLimit } from '../lib/ratelimit';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { DRAFT_TTL_DAYS } from '../lib/requestRevisions';
import { waitUntilFrom } from '../lib/eventBus';
import { rootDomainFrom } from '../lib/hosts';
import { ownedMediaKey } from '../lib/mediaRefs';
import { isSafeMediaKey } from '../lib/mediaStorage';
import { blockedEither } from '../lib/userBlocks';
import { storeThreadOf } from '../lib/chatThread';
import { visibleStoreProduct } from '../lib/productVisibility';
import { assertStoreTakesDirect, directRequest, type DirectStore } from '../lib/directRequests';
import { copyIntoRequest, ledgerSha256, type CopySource } from '../lib/requestHandoff';
import { ENTRY_NOTE_PREFIX } from '../lib/requestBudget';
import { REQUEST_FILE_LIMITS } from '../../packages/contracts/src/requestFiles';
import { assertSendable, draftShape, saveDraft } from './printRequests';
import { loadPost, mayRead } from './communityPosts';
import { customerKnowsMerchant, openStoreThread } from './chats';
import { sendDirectDraft, sentDirectCard } from './chatCommerce';

export const requestEntryRoutes = new Hono<AppContext>();

/** The model a new draft is born with: one part, the process and the material open, any colour. */
export const SEED_MODEL_BODY = {
  schema_version: 3,
  quantity: 1,
  quality: 'standard',
  parts: [{ process: 'unsure', quantity: 1, materials: [{ material_id: 'unsure', colors: [{ mode: 'any' }] }] }],
} as const;

const ENTRY_KINDS = ['blank', 'project', 'product', 'store'] as const;
type EntryKind = (typeof ENTRY_KINDS)[number];
type Lang = 'ar' | 'en' | 'ckb';
type Skipped = Array<{ name: string; code: string; post_file_id: string }>;

const entryNotFound = () => new HttpError(404, 'What you want printed was not found', 'ENTRY_NOT_FOUND');

/** The request's private record of where it came from (see the header). */
const originNote = (kind: EntryKind, id: string) => (kind === 'blank' ? '' : `${ENTRY_NOTE_PREFIX}${kind}:${id}`);

interface Born {
  id: string;
  replayed: boolean;
  copied?: { files: number; skipped: Skipped };
}

/** The customer's untouched draft from this origin, if there is one. */
async function idleDraft(db: D1Database, customerId: string, note: string, direct: string | null): Promise<string | null> {
  if (!note) return null;
  const row = await db
    .prepare(
      `SELECT id FROM community_requests
        WHERE customer_id = ? AND state = 'draft' AND notes = ? AND updated_at = created_at
          AND ${direct === null ? `visibility = 'public'` : `visibility = 'direct' AND target_merchant_id = ?`}
        ORDER BY created_at DESC LIMIT 1`
    )
    .bind(...(direct === null ? [customerId, note] : [customerId, note, direct]))
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * THE DRAFT ROW, then its seed through the draft save. `direct` addresses it
 * to one store with no conversation yet (`origin_chat_id` NULL). A seed that
 * fails takes the row with it.
 */
async function bornDraft(
  c: Context<AppContext>,
  p: { title: string; note: string; direct: DirectStore | null; seed: Record<string, unknown> }
): Promise<string> {
  const user = c.get('user')!;
  const id = newId('req');
  const ts = new Date().toISOString();
  const expires = new Date(Date.now() + DRAFT_TTL_DAYS * 86_400_000).toISOString();
  if (p.direct) {
    await c.env.DB.prepare(
      `INSERT INTO community_requests
         (id, customer_id, title, description, status, state, visibility, created_at, expires_at, updated_at,
          customer_notes, notes, target_merchant_id, origin_chat_id, created_by)
       VALUES (?, ?, ?, '', 'closed', 'draft', 'direct', ?, ?, ?, '', ?, ?, NULL, 'customer')`
    )
      .bind(id, user.id, p.title, ts, expires, ts, p.note, p.direct.merchantId)
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO community_requests
         (id, customer_id, title, description, status, state, visibility, created_at, expires_at, updated_at, customer_notes, notes)
       VALUES (?, ?, ?, '', 'closed', 'draft', 'public', ?, ?, ?, '', ?)`
    )
      .bind(id, user.id, p.title, ts, expires, ts, p.note)
      .run();
  }
  try {
    await saveDraft(c.env, user.id, id, p.seed);
  } catch (e) {
    // An empty row with no print row and no model is nobody's draft.
    await c.env.DB.prepare(`DELETE FROM community_requests WHERE id = ? AND customer_id = ? AND state = 'draft'`)
      .bind(id, user.id)
      .run()
      .catch(() => undefined);
    throw e;
  }
  return id;
}

/** Untouched since the entry: the replay's own test (see the header). */
async function markUntouched(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE community_requests SET updated_at = created_at WHERE id = ? AND state = 'draft'`).bind(id).run();
}

const extOf = (key: string) => (/\.([a-z0-9]{1,8})$/i.exec(key)?.[1] ?? '').toLowerCase();

// ------------------------------------------------------------------ project

/**
 * A project the reader may copy from: their own, or one the PUBLIC may read
 * (published, public or unlisted, not hidden by Levonis). Never through the
 * consent party's door, and never through an admin's reach into a hidden or
 * unpublished post (critique 9): `mayRead` is asked as a guest.
 */
async function readableProject(c: Context<AppContext>, postId: string): Promise<Record<string, unknown>> {
  const user = c.get('user')!;
  const p = await loadPost(c.env, postId).catch(() => null);
  if (!p || !(user.id === p.author_id || mayRead(p, null, null))) throw entryNotFound();
  if (user.id !== p.author_id && (await blockedEither(c.env.DB, user.id, String(p.author_id)).catch(() => false))) throw entryNotFound();
  return p;
}

interface ProjectFile extends CopySource {
  postFileId: string;
}

/** What may be copied from a project, in order: its downloadable files (models first), then its cover. */
async function projectFiles(c: Context<AppContext>, post: Record<string, unknown>, only: ReadonlySet<string> | null): Promise<ProjectFile[]> {
  const user = c.get('user')!;
  const postId = String(post.id);
  const mine = user.id === post.author_id;
  const meta = { title: String(post.title ?? '').slice(0, 140) };
  const { results } = await c.env.DB.prepare(
    `SELECT id, file_key, kind, name, downloadable FROM community_post_files WHERE post_id = ? ORDER BY (kind = 'model') DESC, position, id`
  )
    .bind(postId)
    .all<{ id: string; file_key: string; kind: string; name: string; downloadable: number }>();
  const out: ProjectFile[] = [];
  for (const f of results ?? []) {
    if (!mine && Number(f.downloadable) !== 1) continue;
    if (only && !only.has(f.id)) continue;
    out.push({
      postFileId: f.id,
      visibility: 'private',
      key: f.file_key,
      name: String(f.name || `file.${extOf(f.file_key)}`),
      expectedSha256: await ledgerSha256(c.env.DB, f.file_key),
      sourceKind: 'project_post',
      origin: { id: postId, ref: f.id, meta },
    });
  }
  // The project's first picture, as a reference picture (its own public object, copied like the rest).
  const cover = await c.env.DB.prepare(
    `SELECT id, media_key FROM community_post_media WHERE post_id = ? AND kind = 'image' ORDER BY sort_order, id LIMIT 1`
  )
    .bind(postId)
    .first<{ id: string; media_key: string }>()
    .catch(() => null);
  // A picture the post already shows its reader: a public object, never a
  // private key (`isSafeMediaKey` refuses every scheme, `..` and `%`).
  const coverKey = cover && isSafeMediaKey(String(cover.media_key ?? '').replace(/^\/files\//, '')) ? String(cover.media_key).replace(/^\/files\//, '') : null;
  if (cover && coverKey && (!only || only.has(`cover:${cover.id}`))) {
    out.push({
      postFileId: `cover:${cover.id}`,
      visibility: 'public',
      key: coverKey,
      name: `${meta.title || 'project'}.${extOf(coverKey)}`,
      expectedSha256: await ledgerSha256(c.env.DB, coverKey),
      sourceKind: 'project_post',
      origin: { id: postId, ref: `cover:${cover.id}`, meta },
    });
  }
  return out;
}

interface Copied {
  fileId: string;
  sourceId: string;
  name: string;
  isModel: boolean;
}

/** Copy project files into a request, one at a time; each counted and logged as a download. */
async function copyProjectFiles(c: Context<AppContext>, requestId: string, post: Record<string, unknown>, files: ProjectFile[]) {
  const user = c.get('user')!;
  const copied: Copied[] = [];
  const skipped: Skipped = [];
  const base = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM community_request_sources WHERE request_id = ?')
    .bind(requestId)
    .first<{ n: number }>()
    .catch(() => null);
  let position = Number(base?.n ?? 0);
  for (const f of files) {
    // The download door's own bucket: a copy is a download.
    try {
      await rateLimit(c, 'post-file-download', 120, 3600);
    } catch (e) {
      skipped.push({ name: f.name, code: e instanceof HttpError && e.code ? e.code : 'RATE_LIMITED', post_file_id: f.postFileId });
      continue;
    }
    const out = await copyIntoRequest(c.env, { requestId, customerId: user.id, source: f, position, waitUntil: waitUntilFrom(c), actor: user });
    if (!out.ok) {
      skipped.push({ name: f.name, code: out.code, post_file_id: f.postFileId });
      continue;
    }
    position += 1;
    copied.push({ fileId: out.fileId, sourceId: out.sourceId, name: out.name, isModel: out.kind === 'model' });
    if (!f.postFileId.startsWith('cover:')) {
      await c.env.DB.prepare('UPDATE community_post_files SET downloads = downloads + 1 WHERE id = ?').bind(f.postFileId).run().catch(() => undefined);
    }
    await audit(c.env.DB, user.id, 'community.post_file_downloaded', f.postFileId, {
      post: String(post.id),
      mine: user.id === post.author_id,
      into_request: requestId,
    });
  }
  return { copied, skipped };
}

/** One part per copied model, measured from it; the first model the main source. */
function projectSeed(title: string, copied: Copied[]): Record<string, unknown> {
  const models = copied.filter((x) => x.isModel);
  const main = models[0] ?? copied[0];
  const material = { material_id: 'unsure', colors: [{ mode: 'any' }] };
  return {
    schema_version: 3,
    title,
    quantity: 1,
    quality: 'standard',
    sources: copied.map((x) => ({ id: x.sourceId, kind: 'project_post', note: '', is_primary: !!main && x.sourceId === main.sourceId })),
    parts: models.length
      ? models.slice(0, 12).map((m) => ({
          name: m.name.replace(/\.[a-z0-9]{1,8}$/i, '').slice(0, 80),
          quantity: 1,
          process: 'unsure',
          measured_file_id: m.fileId,
          source_ids: [m.sourceId],
          materials: [material],
        }))
      : [{ process: 'unsure', quantity: 1, source_ids: copied.map((x) => x.sourceId), materials: [material] }],
  };
}

async function projectEntry(c: Context<AppContext>, postId: string): Promise<Born> {
  const user = c.get('user')!;
  const post = await readableProject(c, postId);
  const note = originNote('project', postId);
  const idle = await idleDraft(c.env.DB, user.id, note, null);
  if (idle) return { id: idle, replayed: true };
  const title = String(post.title ?? '').trim().slice(0, 140);
  const id = await bornDraft(c, { title, note, direct: null, seed: { ...SEED_MODEL_BODY, title } });
  const files = (await projectFiles(c, post, null)).slice(0, REQUEST_FILE_LIMITS.maxFiles + 4);
  const { copied, skipped } = await copyProjectFiles(c, id, post, files);
  if (copied.length) await saveDraft(c.env, user.id, id, projectSeed(title, copied));
  await markUntouched(c.env.DB, id);
  return { id, replayed: false, copied: { files: copied.length, skipped } };
}

// ------------------------------------------------------------------ product and store

/** The product page's own address on the main site: the link a merchant opens (a reference, never a download). */
function productUrl(c: Context<AppContext>, storeSlug: string, productSlug: string): string | null {
  const root = rootDomainFrom(c.env);
  if (!root || !storeSlug || !productSlug) return null;
  return `https://${root}/community/store/${encodeURIComponent(storeSlug)}/p/${encodeURIComponent(productSlug)}`;
}

async function productEntry(c: Context<AppContext>, productId: string, storeSlug: string, lang: Lang): Promise<Born> {
  const user = c.get('user')!;
  let vp;
  try {
    vp = await visibleStoreProduct(c.env.DB, user, storeSlug, productId);
  } catch (e) {
    if (e instanceof HttpError && e.code === 'NOT_FOUND') throw entryNotFound();
    throw e;
  }
  const store = await assertStoreTakesDirect(c.env.DB, vp.ctx.merchant.id, user.id, customerKnowsMerchant);
  const note = originNote('product', productId);
  const idle = await idleDraft(c.env.DB, user.id, note, store.merchantId);
  if (idle) return { id: idle, replayed: true };
  const row = await c.env.DB.prepare('SELECT name, name_ar FROM community_products WHERE id = ?').bind(productId).first<{ name: string; name_ar: string }>();
  const title = String((lang === 'ar' ? row?.name_ar || row?.name : row?.name || row?.name_ar) ?? '').trim().slice(0, 140);
  const url = productUrl(c, store.storeSlug || storeSlug, vp.product.slug);
  const seed: Record<string, unknown> = url
    ? {
        ...SEED_MODEL_BODY,
        title,
        sources: [{ id: 'tmp_product', kind: 'link', url, note: '', is_primary: true }],
        parts: [{ ...SEED_MODEL_BODY.parts[0], source_ids: ['tmp_product'] }],
      }
    : { ...SEED_MODEL_BODY, title };
  const id = await bornDraft(c, { title, note, direct: store, seed });
  // The link is the product's: provenance that a URL edit drops (requestModel.ts readModelInput).
  if (url) {
    await c.env.DB.prepare(`UPDATE community_request_sources SET origin_id = ?, origin_ref = 'product', origin_meta = ? WHERE request_id = ? AND kind = 'link'`)
      .bind(productId, JSON.stringify({ title }), id)
      .run()
      .catch(() => undefined);
  }
  // The product's first picture, copied as a reference picture. None of the
  // product's own files is copied: the design is the store's, and its paid
  // files stay paid.
  const media = await c.env.DB.prepare(`SELECT media_key FROM community_product_media WHERE product_id = ? AND kind = 'image' ORDER BY position, id LIMIT 1`)
    .bind(productId)
    .first<{ media_key: string }>()
    .catch(() => null);
  const key = media ? ownedMediaKey(media.media_key, vp.ctx.store.user_id) : null;
  const skipped: Skipped = [];
  let files = 0;
  if (key) {
    const name = `${title || 'product'}.${extOf(key)}`;
    const out = await copyIntoRequest(c.env, {
      requestId: id,
      customerId: user.id,
      source: {
        visibility: 'public',
        key,
        name,
        expectedSha256: await ledgerSha256(c.env.DB, key),
        sourceKind: 'file',
        origin: { id: productId, ref: 'product_cover', meta: { title } },
      },
      position: 1,
      waitUntil: waitUntilFrom(c),
      actor: user,
    });
    if (out.ok) files = 1;
    else skipped.push({ name, code: out.code, post_file_id: '' });
  }
  await markUntouched(c.env.DB, id);
  return { id, replayed: false, copied: { files, skipped } };
}

async function storeEntry(c: Context<AppContext>, merchantId: string): Promise<Born> {
  const user = c.get('user')!;
  const store = await assertStoreTakesDirect(c.env.DB, merchantId, user.id, customerKnowsMerchant);
  const note = originNote('store', store.merchantId);
  const idle = await idleDraft(c.env.DB, user.id, note, store.merchantId);
  if (idle) return { id: idle, replayed: true };
  const id = await bornDraft(c, { title: '', note, direct: store, seed: { ...SEED_MODEL_BODY } });
  await markUntouched(c.env.DB, id);
  return { id, replayed: false };
}

// ------------------------------------------------------------------ the doors

requestEntryRoutes.post('/requests', requireMainHost, requireCommunityOpen, requireAuth, async (c) => {
  await rateLimit(c, 'print-entry', 20, 3600);
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown> | null;
  const entry = body && typeof body === 'object' && body.entry && typeof body.entry === 'object' ? (body.entry as Record<string, unknown>) : {};
  const kind = (entry.kind === undefined ? 'blank' : String(entry.kind)) as EntryKind;
  if (!(ENTRY_KINDS as readonly string[]).includes(kind)) throw badRequest('That is not a way to start a request');
  const lang: Lang = body?.lang === 'en' || body?.lang === 'ckb' ? body.lang : 'ar';

  let born: Born;
  if (kind === 'project') {
    born = await projectEntry(c, str(entry.post_id, 'post_id', { min: 1, max: 60 }));
  } else if (kind === 'product') {
    born = await productEntry(c, str(entry.product_id, 'product_id', { min: 1, max: 64 }), str(entry.store, 'store', { min: 1, max: 64 }), lang);
  } else if (kind === 'store') {
    born = await storeEntry(c, str(entry.merchant_id, 'merchant_id', { min: 1, max: 60 }));
  } else {
    born = { id: await bornDraft(c, { title: '', note: '', direct: null, seed: { ...SEED_MODEL_BODY } }), replayed: false };
  }
  if (!born.replayed) await audit(c.env.DB, user.id, 'print.request_entry', born.id, { kind });
  const draft = await draftShape(c.env, born.id);
  return c.json(
    { success: true, request_id: born.id, replayed: born.replayed, draft, ...(born.copied ? { copied: born.copied } : {}) },
    born.replayed ? 200 : 201
  );
});

/**
 * A SKIPPED PROJECT FILE, AGAIN — only from the project this request was made
 * from, only files the reader may still download, and never a file the
 * request already holds a copy of (acceptance 13: a retry makes no needless
 * copy). Each copy is counted and logged like a download.
 */
requestEntryRoutes.post('/requests/:id/copy-from-project', requireMainHost, requireCommunityOpen, requireAuth, async (c) => {
  await rateLimit(c, 'print-entry', 20, 3600);
  const user = c.get('user')!;
  const requestId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const postId = str(body.post_id, 'post_id', { min: 1, max: 60 });
  const wanted = Array.isArray(body.file_ids) ? body.file_ids.filter((x): x is string => typeof x === 'string').slice(0, 12) : [];
  const r = await c.env.DB.prepare('SELECT id, customer_id, notes FROM community_requests WHERE id = ?')
    .bind(requestId)
    .first<{ id: string; customer_id: string; notes: string | null }>();
  if (!r || r.customer_id !== user.id) throw notFound('Request not found');
  const { results: held } = await c.env.DB.prepare(
    `SELECT origin_ref FROM community_request_sources WHERE request_id = ? AND kind = 'project_post' AND origin_id = ?`
  )
    .bind(requestId, postId)
    .all<{ origin_ref: string }>();
  if (r.notes !== originNote('project', postId) && !(held ?? []).length) throw entryNotFound();
  const post = await readableProject(c, postId);
  const already = new Set((held ?? []).map((x) => x.origin_ref));
  const files = await projectFiles(c, post, wanted.length ? new Set(wanted) : null);
  const { copied, skipped } = await copyProjectFiles(c, requestId, post, files.filter((f) => !already.has(f.postFileId)));
  return c.json({
    success: true,
    draft: await draftShape(c.env, requestId),
    copied: { files: copied.length, skipped, already: files.filter((f) => already.has(f.postFileId)).map((f) => f.postFileId) },
  });
});

/**
 * «أرسل إلى المتجر» — a direct draft the editor made, sent to its store. The
 * job is asked first (`assertSendable`), then the store (the conversation's
 * own rules), and only then is the conversation opened; the request opens and
 * its card lands in the same batch (`sendDirectDraft`). A second send answers
 * the card already there.
 */
requestEntryRoutes.post('/requests/:id/send', requireMainHost, requireCommunityOpen, requireAuth, async (c) => {
  await rateLimit(c, 'chat-print-request', 10, 3600);
  const user = c.get('user')!;
  const requestId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const r = await directRequest(c.env.DB, requestId);
  if (!r || r.customer_id !== user.id) throw notFound('Request not found');
  if (r.state !== 'draft') {
    const sent = r.origin_chat_id ? await sentDirectCard(c, r.origin_chat_id, requestId) : null;
    if (sent) return c.json({ success: true, message: sent, chat_id: r.origin_chat_id, replayed: true });
    throw conflict('This request was already sent', 'REQUEST_NOT_DRAFT');
  }
  const row = await c.env.DB.prepare('SELECT * FROM community_requests WHERE id = ?').bind(requestId).first<Record<string, unknown>>();
  await assertSendable(c.env, row!);
  const store = await assertStoreTakesDirect(c.env.DB, r.target_merchant_id, user.id, customerKnowsMerchant);
  const chatId =
    r.origin_chat_id ??
    (await openStoreThread(c.env.DB, {
      contextType: 'store',
      contextId: user.id,
      storeId: store.storeId,
      merchantId: store.merchantId,
      customerId: user.id,
      sellerId: store.merchantUserId,
    }));
  const thread = await storeThreadOf(c.env.DB, chatId);
  if (!thread || thread.merchant_id !== r.target_merchant_id) throw notFound('Request not found');
  return sendDirectDraft(c, { requestId, chatId, thread });
});
