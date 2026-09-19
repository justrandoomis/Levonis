import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, notFound, str, int } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import {
  POLICY_DOCUMENTS,
  POLICY_SECTIONS,
  getPolicyDocument,
  policySectionOf,
} from '../lib/policies';
import {
  POLICY_LANGS,
  policyDocHash,
  policyEffectiveInstant,
  type PolicyDocument,
  type PolicyLang,
} from '../lib/policies/types';
import { CHECKOUT_POLICY_KEYS } from '../lib/policyOps';
import { ensurePolicyCorpusQuietly } from '../lib/policySync';
import { waitUntilFrom } from '../lib/eventBus';

/**
 * Store policies — served from CODE.
 *
 * The owner's instruction was that policy text is edited in the source tree
 * and nowhere else, so this file has no authoring surface at all: no seeding,
 * no drafting, no publishing. The registry in worker/lib/policies/ is the
 * author; reads answer from it, which is why this page can no longer tell a
 * visitor that the store's policies "are not configured" on a deployment
 * whose database happens to be empty.
 *
 * `policy_documents` remains the ARCHIVE and is still read for one question
 * the code cannot answer: `?version=N` for a superseded version that has left
 * the source tree but is still referenced by somebody's acceptance record.
 * worker/lib/policySync.ts keeps that archive fed, lazily, from here.
 */

interface PolicyArchiveRow {
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

const CHECKOUT_KEYS: readonly string[] = CHECKOUT_POLICY_KEYS;

/**
 * Feed the archive without making the customer wait for it. A read answers
 * from the registry, so the mirror is housekeeping: on a request that has an
 * execution context it runs after the response, and the first visitor to a
 * freshly reset database is not held for the whole trilingual corpus. Unit
 * tests and direct calls have no context and simply await it, which is what
 * keeps their assertions about the archive deterministic.
 */
function mirrorCorpus(c: Context<AppContext>): Promise<void> {
  const mirror = ensurePolicyCorpusQuietly(c.env.DB);
  const waitUntil = waitUntilFrom(c);
  if (!waitUntil) return mirror;
  waitUntil(mirror);
  return Promise.resolve();
}

function readLang(raw: string | undefined): PolicyLang {
  return raw === 'en' || raw === 'ckb' ? raw : 'ar';
}

/**
 * Arabic is the authoritative text: a language whose translation is absent or
 * blank falls back to it rather than showing the customer an empty document.
 * The response says which language was actually served AND which was asked
 * for, because the reader prints a notice when they differ.
 */
function resolveLang(doc: PolicyDocument, requested: PolicyLang): PolicyLang {
  return doc.body[requested]?.trim() && doc.title[requested]?.trim() ? requested : 'ar';
}

// Bodies are compile-time constants, so their hashes are computed once per
// isolate instead of on every read of a policy page.
const hashCache = new Map<string, Promise<string>>();
function cachedDocHash(doc: PolicyDocument, lang: PolicyLang): Promise<string> {
  const id = `${doc.key}@${doc.version}:${lang}`;
  let hash = hashCache.get(id);
  if (!hash) {
    hash = policyDocHash(doc.key, doc.version, lang, doc.title[lang], doc.body[lang]);
    hashCache.set(id, hash);
  }
  return hash;
}

// ------------------------------------------------------------- public reads

/** The corpus: every document the code publishes, grouped into sections. */
policiesRoutes.get('/', async (c) => {
  await rateLimit(c, 'policies-list', 120, 60);
  await mirrorCorpus(c);
  return c.json({
    success: true,
    sections: POLICY_SECTIONS.map((s) => ({ id: s.id, titles: s.title, keys: [...s.keys] })),
    policies: POLICY_DOCUMENTS.map((doc) => ({
      key: doc.key,
      version: doc.version,
      effective_at: policyEffectiveInstant(doc.effective_at),
      titles: doc.title,
      section: policySectionOf(doc.key),
      required_for_checkout: CHECKOUT_KEYS.includes(doc.key),
    })),
  });
});

/**
 * One document in the requested language, Arabic fallback.
 *
 * Without `?version`, and with a version that matches what the code ships,
 * the answer comes from the registry. `?version=N` for any other N is the one
 * question the registry cannot answer — the exact text of a version that has
 * been superseded — so it is read from the archive, drafts excluded.
 */
policiesRoutes.get('/:key', async (c) => {
  await rateLimit(c, 'policies-read', 120, 60);
  const key = str(c.req.param('key'), 'key', { min: 1, max: 40 });
  const lang = readLang(c.req.query('lang'));
  const versionQ = c.req.query('version');
  const version = versionQ !== undefined ? int(versionQ, 'version', { min: 1, max: 1_000_000 }) : null;

  const doc = getPolicyDocument(key);
  if (doc && (version === null || version === doc.version)) {
    await mirrorCorpus(c);
    const served = resolveLang(doc, lang);
    const at = policyEffectiveInstant(doc.effective_at);
    return c.json({
      success: true,
      policy: {
        key: doc.key,
        version: doc.version,
        lang: served,
        lang_requested: lang,
        published_at: at,
        effective_at: at,
        title: doc.title[served],
        body: doc.body[served],
        hash: await cachedDocHash(doc, served),
        status: 'published',
        section: policySectionOf(doc.key),
        required_for_checkout: CHECKOUT_KEYS.includes(doc.key),
      },
    });
  }

  // Historical read. A key that has left the registry entirely is still
  // answerable here, because an acceptance record may still point at it.
  const statuses = "('published','archived')";
  let row: PolicyArchiveRow | null = null;
  if (version !== null) {
    row = await c.env.DB.prepare(
      `SELECT * FROM policy_documents WHERE key = ? AND lang = ? AND version = ? AND status IN ${statuses}`
    ).bind(key, lang, version).first<PolicyArchiveRow>();
    if (!row && lang !== 'ar') {
      row = await c.env.DB.prepare(
        `SELECT * FROM policy_documents WHERE key = ? AND lang = 'ar' AND version = ? AND status IN ${statuses}`
      ).bind(key, version).first<PolicyArchiveRow>();
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
      section: policySectionOf(row.key),
      required_for_checkout: CHECKOUT_KEYS.includes(row.key),
    },
  });
});

// ------------------------------------------------------------- admin routes

policiesRoutes.use('/admin/*', requireAdmin);

/**
 * READ-ONLY. Support needs to answer "which text did this customer accept?"
 * from the archive, and that is the whole remaining reason for an admin
 * surface here. Every write endpoint that once lived under /admin — seeding,
 * drafting, preparing terms and publishing — is gone by design, not gated:
 * policy text is edited in worker/lib/policies/ and deployed, never typed
 * into a form. Bodies are omitted; the public reader serves them by version.
 */
policiesRoutes.get('/admin/list', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, key, version, lang, title, hash, status, created_at, published_at, effective_at, LENGTH(body) AS body_length
       FROM policy_documents ORDER BY key, version DESC, lang`
  ).all<Record<string, unknown>>();
  return c.json({
    success: true,
    documents: results,
    // What the archive SHOULD contain, so support can see at a glance whether
    // a deployment's mirror is complete without a write button to "fix" it.
    registry: POLICY_DOCUMENTS.map((d) => ({ key: d.key, version: d.version, langs: POLICY_LANGS })),
  });
});
