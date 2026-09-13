import { policyPublicationBatch, isPolicyPublicationConflict } from '../lib/policyPublication';
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, notFound, str, int, oneOf } from '../lib/http';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';
import {
  POLICY_KEYS,
  POLICY_LANGS,
  POLICY_DRAFTS,
  CHECKOUT_POLICY_KEYS,
  policyDocHash,
  type PolicyKey,
  type PolicyLang,
} from '../lib/policyOps';

/**
 * Versioned policy documents (final-phase brief §7).
 *
 * - Public reads serve PUBLISHED versions only (with Arabic fallback per
 *   language). Drafts are admin-only.
 * - Publishing is an explicit, confirmed, audited action that recomputes and
 *   freezes each row's content hash. Published/archived rows are immutable —
 *   a correction creates version+1 as a new draft.
 * - Checkout consent (terms + privacy) turns on exactly when those keys have
 *   a published version — see worker/lib/policyOps.ts.
 */

interface PolicyRow {
  id: string;
  key: string;
  version: number;
  lang: PolicyLang;
  title: string;
  body: string;
  hash: string;
  status: 'draft' | 'published' | 'archived';
  created_at: string;
  published_at: string | null;
  effective_at: string | null;
}

export const policiesRoutes = new Hono<AppContext>();

// ------------------------------------------------------------- public reads

/** Published policy list: latest published version per key, titles per lang. */
policiesRoutes.get('/', async (c) => {
  await rateLimit(c, 'policies-list', 120, 60);
  const { results } = await c.env.DB.prepare(
    `SELECT p.key, p.version, p.lang, p.title FROM policy_documents p
      JOIN (SELECT key, MAX(version) AS v FROM policy_documents WHERE status = 'published' GROUP BY key) latest
        ON latest.key = p.key AND latest.v = p.version
     WHERE p.status = 'published'
     ORDER BY p.key`
  ).all<Pick<PolicyRow, 'key' | 'version' | 'lang' | 'title'>>();

  const byKey = new Map<string, { key: string; version: number; titles: Record<string, string> }>();
  for (const r of results) {
    const entry = byKey.get(r.key) || { key: r.key, version: Number(r.version), titles: {} };
    entry.titles[r.lang] = r.title;
    byKey.set(r.key, entry);
  }
  return c.json({
    success: true,
    policies: [...byKey.values()].map((p) => ({
      ...p,
      required_for_checkout: (CHECKOUT_POLICY_KEYS as readonly string[]).includes(p.key),
    })),
  });
});

/**
 * Published body for one key in the requested language, Arabic fallback.
 * `?version=N` additionally serves formerly published (archived) versions so
 * a customer can always re-read the exact version they accepted; drafts are
 * never served here.
 */
policiesRoutes.get('/:key', async (c) => {
  await rateLimit(c, 'policies-read', 120, 60);
  const key = str(c.req.param('key'), 'key', { min: 1, max: 40 });
  const langQ = c.req.query('lang');
  const lang: PolicyLang = langQ === 'en' || langQ === 'ckb' ? langQ : 'ar';
  const versionQ = c.req.query('version');
  const version = versionQ !== undefined ? int(versionQ, 'version', { min: 1, max: 1_000_000 }) : null;

  const statusFilter = version === null ? "('published')" : "('published','archived')";
  let row: PolicyRow | null;
  if (version === null) {
    row = await c.env.DB.prepare(
      `SELECT * FROM policy_documents WHERE key = ? AND lang IN (?, 'ar') AND status = 'published'
       AND version = (SELECT MAX(version) FROM policy_documents WHERE key = ? AND status = 'published')
       ORDER BY CASE WHEN lang = ? THEN 0 ELSE 1 END LIMIT 1`
    )
      .bind(key, lang, key, lang)
      .first<PolicyRow>();
  } else {
    row = await c.env.DB.prepare(
      `SELECT * FROM policy_documents WHERE key = ? AND lang = ? AND version = ? AND status IN ${statusFilter}`
    )
      .bind(key, lang, version)
      .first<PolicyRow>();
    if (!row && lang !== 'ar') {
      row = await c.env.DB.prepare(
        `SELECT * FROM policy_documents WHERE key = ? AND lang = 'ar' AND version = ? AND status IN ${statusFilter}`
      )
        .bind(key, version)
        .first<PolicyRow>();
    }
  }
  if (!row) throw notFound('No published version of this policy exists');
  return c.json({
    success: true,
    policy: {
      key: row.key,
      version: Number(row.version),
      lang: row.lang,
      lang_requested: lang,
      published_at: row.published_at,
      effective_at: row.effective_at,
      title: row.title,
      body: row.body,
      hash: row.hash,
      status: row.status,
    },
  });
});

// ------------------------------------------------------------- admin routes

policiesRoutes.use('/admin/*', requireAdmin);

/** Everything, all statuses, bodies omitted (fetch one by id for the body). */
policiesRoutes.get('/admin/list', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, key, version, lang, title, hash, status, created_at, published_at, effective_at, LENGTH(body) AS body_length
       FROM policy_documents ORDER BY key, version DESC, lang`
  ).all<Record<string, unknown>>();
  return c.json({ success: true, documents: results });
});

policiesRoutes.get('/admin/doc/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM policy_documents WHERE id = ?')
    .bind(c.req.param('id'))
    .first<PolicyRow>();
  if (!row) throw notFound('Document not found');
  return c.json({ success: true, document: row });
});

/**
 * Idempotent seeding of the ORIGINAL LEVONIS drafts (worker/lib/policyOps.ts
 * POLICY_DRAFTS): for each key that has NO rows yet, insert version 1 in all
 * three languages with status='draft'. Keys that already have any rows are
 * skipped — reseeding never overwrites edits and NEVER publishes anything.
 */
policiesRoutes.post('/admin/seed-drafts', async (c) => {
  const admin = c.get('user')!;
  const seeded: string[] = [];
  const skipped: string[] = [];
  for (const draft of POLICY_DRAFTS) {
    const existing = await c.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM policy_documents WHERE key = ?'
    )
      .bind(draft.key)
      .first<{ n: number }>();
    if ((existing?.n ?? 0) > 0) {
      skipped.push(draft.key);
      continue;
    }
    const stmts: D1PreparedStatement[] = [];
    for (const lang of POLICY_LANGS) {
      const title = draft.title[lang];
      const body = draft.body[lang];
      const hash = await policyDocHash(draft.key, 1, lang, title, body);
      stmts.push(
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO policy_documents (id, key, version, lang, title, body, hash, status)
           VALUES (?, ?, 1, ?, ?, ?, ?, 'draft')`
        ).bind(newId('pol'), draft.key, lang, title, body, hash)
      );
    }
    await c.env.DB.batch(stmts);
    seeded.push(draft.key);
  }
  await audit(c.env.DB, admin.id, 'policy.seed_drafts', 'policy_documents', { seeded, skipped });
  return c.json({ success: true, seeded, skipped });
});

/** Add the revised purchase terms as a NEW draft version. Never overwrite a
 * merchant/owner's existing draft or publish text merely because code ships.
 */
policiesRoutes.post('/admin/prepare-terms', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body.confirm !== 'PREPARE TERMS DRAFT') throw badRequest('Explicit draft preparation confirmation required', 'CONFIRM_REQUIRED');
  const draft = POLICY_DRAFTS.find((d) => d.key === 'terms')!;
  const db = c.env.DB;
  const latest = await db.prepare("SELECT MAX(version) v FROM policy_documents WHERE key = 'terms'").first<{ v: number | null }>();
  const previous = Number(latest?.v ?? 0);
  const rows = previous ? (await db.prepare("SELECT lang, title, body, status FROM policy_documents WHERE key = 'terms' AND version = ?")
    .bind(previous).all<Pick<PolicyRow, 'lang' | 'title' | 'body' | 'status'>>()).results : [];
  if (rows.length === POLICY_LANGS.length && POLICY_LANGS.every((lang) => rows.some((row) => row.lang === lang && row.title === draft.title[lang] && row.body === draft.body[lang]))) {
    return c.json({ success: true, version: previous, created: false });
  }
  if (previous >= 1_000_000) throw badRequest('Policy version limit reached');
  const version = previous + 1;
  const statements: D1PreparedStatement[] = [];
  for (const lang of POLICY_LANGS) {
    const hash = await policyDocHash('terms', version, lang, draft.title[lang], draft.body[lang]);
    statements.push(db.prepare(
      `INSERT INTO policy_documents (id, key, version, lang, title, body, hash, status)
       VALUES (?, 'terms', ?, ?, ?, ?, ?, 'draft')`
    ).bind(newId('pol'), version, lang, draft.title[lang], draft.body[lang], hash));
  }
  try { await db.batch(statements); }
  catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error))) throw badRequest('A draft was created concurrently; reload before retrying', 'CONFLICT_RETRY');
    throw error;
  }
  await audit(db, c.get('user')!.id, 'policy.terms.prepare', `terms@v${version}`, { version, previous, langs: POLICY_LANGS });
  return c.json({ success: true, version, created: true });
});

/**
 * Create or update a DRAFT row. Published/archived rows are immutable —
 * targeting a key whose latest version is published starts version+1.
 */
policiesRoutes.post('/admin/draft', async (c) => {
  const admin = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const key = oneOf(body.key, 'key', POLICY_KEYS) as PolicyKey;
  const lang = oneOf(body.lang, 'lang', POLICY_LANGS) as PolicyLang;
  const title = str(body.title, 'title', { min: 2, max: 200 });
  const text = str(body.body, 'body', { min: 10, max: 60_000 });

  const db = c.env.DB;
  const latest = await db.prepare(
    'SELECT MAX(version) AS v FROM policy_documents WHERE key = ?'
  )
    .bind(key)
    .first<{ v: number | null }>();
  const latestVersion = Number(latest?.v ?? 0);

  let targetVersion: number;
  if (latestVersion === 0) {
    targetVersion = 1;
  } else {
    const anyDraftAtLatest = await db.prepare(
      "SELECT COUNT(*) AS n FROM policy_documents WHERE key = ? AND version = ? AND status = 'draft'"
    )
      .bind(key, latestVersion)
      .first<{ n: number }>();
    // If the latest version still has draft rows it is the open working
    // version; otherwise (published/archived) corrections start version+1.
    targetVersion = (anyDraftAtLatest?.n ?? 0) > 0 ? latestVersion : latestVersion + 1;
  }

  const existing = await db.prepare(
    'SELECT id, status FROM policy_documents WHERE key = ? AND version = ? AND lang = ?'
  )
    .bind(key, targetVersion, lang)
    .first<{ id: string; status: string }>();
  if (existing && existing.status !== 'draft') {
    throw badRequest('Published versions are immutable — corrections create a new version', 'IMMUTABLE');
  }

  const hash = await policyDocHash(key, targetVersion, lang, title, text);
  if (existing) {
    const res = await db.prepare(
      "UPDATE policy_documents SET title = ?, body = ?, hash = ? WHERE id = ? AND status = 'draft'"
    )
      .bind(title, text, hash, existing.id)
      .run();
    if (res.meta.changes === 0) {
      throw badRequest('Document was published concurrently — reload and retry', 'CONFLICT_RETRY');
    }
    await audit(db, admin.id, 'policy.draft.update', existing.id, { key, version: targetVersion, lang });
    return c.json({ success: true, id: existing.id, key, version: targetVersion, lang, created: false });
  }
  const id = newId('pol');
  await db.prepare(
    `INSERT INTO policy_documents (id, key, version, lang, title, body, hash, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`
  )
    .bind(id, key, targetVersion, lang, title, text, hash)
    .run();
  await audit(db, admin.id, 'policy.draft.create', id, { key, version: targetVersion, lang });
  return c.json({ success: true, id, key, version: targetVersion, lang, created: true });
});

policiesRoutes.delete('/admin/draft/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT key, version, lang, status FROM policy_documents WHERE id = ?')
    .bind(id)
    .first<{ key: string; version: number; lang: string; status: string }>();
  if (!row) throw notFound('Document not found');
  if (row.status !== 'draft') {
    throw badRequest('Only drafts can be deleted — published versions are permanent records', 'IMMUTABLE');
  }
  const res = await c.env.DB.prepare("DELETE FROM policy_documents WHERE id = ? AND status = 'draft'")
    .bind(id)
    .run();
  if (res.meta.changes === 0) throw badRequest('Document changed concurrently', 'CONFLICT_RETRY');
  await audit(c.env.DB, admin.id, 'policy.draft.delete', id, { key: row.key, version: row.version, lang: row.lang });
  return c.json({ success: true });
});

/**
 * Publish key@version: explicit confirm string, recomputes + freezes each
 * lang row's content hash, archives prior published versions of the key.
 * Published rows become immutable; corrections create version+1 drafts.
 */
policiesRoutes.post('/admin/publish', async (c) => {
  const admin = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const key = oneOf(body.key, 'key', POLICY_KEYS) as PolicyKey;
  const version = int(body.version, 'version', { min: 1, max: 1_000_000 });
  const expected = `PUBLISH ${key} v${version}`;
  if (body.confirm !== expected) {
    throw badRequest(`Send {"confirm":"${expected}"} to publish — publication is permanent`, 'CONFIRM_REQUIRED');
  }

  const db = c.env.DB;
  const { results: rows } = await db.prepare(
    'SELECT * FROM policy_documents WHERE key = ? AND version = ?'
  )
    .bind(key, version)
    .all<PolicyRow>();
  if (rows.length === 0) throw notFound('No document rows at that key/version');
  if (rows.some((r) => r.status !== 'draft')) {
    throw badRequest('This version is already published/archived', 'ALREADY_PUBLISHED');
  }
  if (!rows.some((r) => r.lang === 'ar')) {
    throw badRequest('An Arabic (source-language) row is required before publishing', 'AR_REQUIRED');
  }

  const { statements, hashes } = await policyPublicationBatch(db, key, version, rows);
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (isPolicyPublicationConflict(error)) {
      throw badRequest('The draft or published version changed concurrently — reload and review before publishing', 'CONFLICT_RETRY');
    }
    throw error;
  }
  // Result zero is the atomic assertion, followed by one UPDATE per locale.
  const published = results.slice(1, 1 + rows.length).reduce((n, r) => n + (r.meta.changes || 0), 0);
  if (published !== rows.length) {
    throw badRequest('A row changed concurrently during publish — reload and verify', 'CONFLICT_RETRY');
  }

  await audit(db, admin.id, 'policy.publish', `${key}@v${version}`, {
    langs: rows.map((r) => r.lang),
    hashes,
    archived_prior: results[results.length - 1]?.meta.changes || 0,
  });
  return c.json({ success: true, key, version, langs: rows.map((r) => r.lang), hashes });
});
