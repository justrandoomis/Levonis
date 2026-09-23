import { POLICY_DOCUMENTS } from './policies';
import { POLICY_LANGS, policyDocHash, policyEffectiveInstant, type PolicyLang } from './policies/types';
import { newId } from './crypto';

/**
 * The code is the author; `policy_documents` is the ARCHIVE.
 *
 * WHY the table still exists at all: `policy_acceptances.document_id` is a
 * foreign key into it, and the whole point of a versioned acceptance is that a
 * customer — or a court, or a bank — can re-read THE EXACT VERSION that was
 * agreed, years later, after the source tree has moved on. If the worker
 * simply served itself and the table were dropped, every past acceptance would
 * point at a row that no longer explains what was agreed.
 *
 * So this module mirrors the registry INTO the archive, once, and never again
 * touches what it wrote:
 *   - it only ever INSERTs (key, version, lang) triples that are missing;
 *   - it never UPDATEs and never DELETEs — migration 0070's immutability
 *     triggers refuse both for published rows, and they are right to;
 *   - a correction is a new `version` in code, which becomes a new archive row
 *     beside the old one, exactly as publishing already worked.
 *
 * It deliberately does NOT archive superseded versions. Old rows keep
 * status='published' and that is harmless, because the "current version" of a
 * policy is now answered from the registry and never from a MAX(version) query
 * against this table.
 */

/** Row count the registry expects to own in the archive at its current versions. */
const CORPUS_ROW_COUNT = POLICY_DOCUMENTS.length * POLICY_LANGS.length;

/**
 * Per-isolate memo of a COMPLETED sync. A warm shop therefore pays nothing at
 * all: no query, no hash, no allocation beyond a resolved promise. A cold
 * isolate pays exactly one projection query (below) and, only on a genuinely
 * empty or reset database, the inserts.
 *
 * A failed sync clears the memo so the next request retries rather than
 * caching an outage for the life of the isolate.
 */
let ensured: Promise<void> | null = null;

export function ensurePolicyCorpus(db: D1Database): Promise<void> {
  if (!ensured) {
    ensured = syncPolicyCorpus(db).then(
      () => undefined,
      (error) => {
        ensured = null;
        throw error;
      }
    );
  }
  return ensured;
}

/**
 * Best-effort variant for the PUBLIC READ paths: those answer from the code
 * registry and do not need the archive to render, so a sync failure must never
 * turn a policy page into an error page. The failure is logged and the read
 * continues; the next request retries.
 */
export async function ensurePolicyCorpusQuietly(db: D1Database): Promise<void> {
  try {
    await ensurePolicyCorpus(db);
  } catch (error) {
    console.error('policy corpus sync failed:', error instanceof Error ? error.message : String(error));
  }
}

export interface PolicyCorpusSync {
  /** Archive rows created by this call, across every key and language. */
  inserted: number;
  /** Keys whose current version was newly written to the archive. */
  keys: string[];
}

/**
 * Idempotent mirror of the registry into the archive. Safe to call
 * concurrently: the INSERTs are `OR IGNORE` against the table's
 * UNIQUE (key, version, lang), so two isolates racing on a cold database
 * produce one row each at worst and no trigger ever fires.
 */
export async function syncPolicyCorpus(db: D1Database): Promise<PolicyCorpusSync> {
  // One projection query, no bound parameters and no bodies: the archive is a
  // few dozen short rows even after years of corrections, and reading the
  // whole (key, version, lang) index is cheaper than binding 54 parameters —
  // D1 caps bound parameters per query, and the corpus will keep growing.
  // `status = 'published'` IS THE WHOLE POINT OF THIS QUERY.
  //
  // It used to read every row regardless of status, and a row is not only ever
  // created here: worker/lib/policyPublication.ts writes a version as 'draft'
  // and promotes it afterwards. A draft therefore counted as PRESENT, this
  // function skipped the document, and `INSERT OR IGNORE` below could never
  // create the published row because the draft already occupied that
  // (key, version, lang).
  //
  // What that costs is the whole shop. `preparePolicyAcceptance` refuses
  // unless it can read a PUBLISHED row for the required version, so checkout
  // answered POLICY_ACCEPTANCE_REQUIRED to a customer who had just ticked the
  // box — on every attempt, for ever, with no way out from inside the
  // application. And a fresh database never reproduces it, which is why the
  // suites stayed green while the live shop could not take an order.
  const { results } = await db
    .prepare("SELECT key, version, lang FROM policy_documents WHERE status = 'published'")
    .all<{ key: string; version: number; lang: string }>();
  const present = new Set((results || []).map((r) => `${r.key}@${Number(r.version)}:${r.lang}`));
  if (present.size >= CORPUS_ROW_COUNT && POLICY_DOCUMENTS.every((doc) =>
    POLICY_LANGS.every((lang) => present.has(`${doc.key}@${doc.version}:${lang}`))
  )) {
    return { inserted: 0, keys: [] };
  }

  const summary: PolicyCorpusSync = { inserted: 0, keys: [] };
  for (const doc of POLICY_DOCUMENTS) {
    const missing = POLICY_LANGS.filter((lang) => !present.has(`${doc.key}@${doc.version}:${lang}`));
    if (missing.length === 0) continue;
    // The date the version takes effect is also the date it was published:
    // a code-authored document has no separate drafting moment, and keeping
    // the two equal is what lets a read served from the registry and a read
    // served from the archive carry byte-identical metadata.
    const at = policyEffectiveInstant(doc.effective_at);
    const statements: D1PreparedStatement[] = [];
    for (const lang of missing as PolicyLang[]) {
      const title = doc.title[lang];
      const body = doc.body[lang];
      statements.push(
        db.prepare(
          `INSERT OR IGNORE INTO policy_documents
             (id, key, version, lang, title, body, hash, status, published_at, effective_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)`
        ).bind(newId('pol'), doc.key, doc.version, lang, title, body,
          await policyDocHash(doc.key, doc.version, lang, title, body), at, at)
      );
    }
    // One batch per document, not one for the whole corpus: a cold sync moves
    // the entire trilingual text of eighteen documents, and a document is the
    // unit that must land whole — a half-written version could be accepted.
    const written = await db.batch(statements);
    summary.inserted += written.reduce((n, r) => n + (r.meta.changes || 0), 0);

    /**
     * AND THE INSERT IS NOT ENOUGH ON ITS OWN.
     *
     * `INSERT OR IGNORE` is ignored when a row for this (key, version, lang)
     * already exists in ANY status, so a document stuck at 'draft' would still
     * have no published row after the batch above and the shop would still be
     * unable to take an order.
     *
     * Promoting it is the same transition `policyPublication.ts` performs, and
     * it is fenced the same way — `AND status = 'draft'`, so a row that is
     * already published is untouched and migration 0070's immutability of a
     * PUBLISHED version is respected. The hash is rewritten from the registry
     * text at the same moment, because a draft may carry a stale one and an
     * acceptance is recorded against that hash.
     */
    const promotions: D1PreparedStatement[] = [];
    for (const lang of missing as PolicyLang[]) {
      const title = doc.title[lang];
      const body = doc.body[lang];
      promotions.push(
        db.prepare(
          `UPDATE policy_documents
              SET status = 'published', hash = ?, published_at = COALESCE(published_at, ?), effective_at = COALESCE(effective_at, ?)
            WHERE key = ? AND version = ? AND lang = ? AND status = 'draft'`
        ).bind(await policyDocHash(doc.key, doc.version, lang, title, body), at, at, doc.key, doc.version, lang)
      );
    }
    const promoted = await db.batch(promotions);
    summary.inserted += promoted.reduce((n, r) => n + (r.meta.changes || 0), 0);

    summary.keys.push(doc.key);
  }
  return summary;
}

/** Test seam: forget the per-isolate memo. */
export function resetPolicyCorpusMemo(): void {
  ensured = null;
}
