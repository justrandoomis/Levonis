import { newId } from './crypto';
import { policyDocHash, type PolicyLang } from './policyOps';

export interface PolicyPublicationRow {
  id: string; key: string; version: number; lang: PolicyLang;
  title: string; body: string; hash: string; status: 'draft' | 'published' | 'archived';
}

/** The assertion is the first statement of the SAME D1 transaction as publish.
 * On mismatch it intentionally violates the existing NOT NULL hash constraint.
 * No sentinel document can ever be stored: success inserts zero rows; failure
 * aborts and rolls back the entire batch. No extra table or migration needed.
 */
export async function policyPublicationBatch(db: D1Database, key: string, version: number, rows: PolicyPublicationRow[]) {
  if (!rows.length || !rows.some((row) => row.lang === 'ar') || rows.some((row) => row.key !== key || row.version !== version || row.status !== 'draft')) {
    throw new Error('Publication requires one coherent draft version with an Arabic source');
  }
  const matches = rows.map(() => "(id = ? AND lang = ? AND title = ? AND body = ? AND hash = ? AND status = 'draft')").join(' OR ');
  const statements: D1PreparedStatement[] = [db.prepare(
    `INSERT INTO policy_documents (id, key, version, lang, title, body, hash, status)
     SELECT ?, ?, ?, 'ar', '', '', NULL, 'draft'
     WHERE (SELECT COUNT(*) FROM policy_documents WHERE key = ? AND version = ?) <> ?
        OR (SELECT COUNT(*) FROM policy_documents WHERE key = ? AND version = ? AND (${matches})) <> ?
        OR EXISTS (SELECT 1 FROM policy_documents WHERE key = ? AND version >= ? AND status IN ('published','archived'))`
  ).bind(newId('polguard'), key, version, key, version, rows.length, key, version,
    ...rows.flatMap((row) => [row.id, row.lang, row.title, row.body, row.hash]), rows.length, key, version)];
  const hashes: Record<string, string> = {};
  for (const row of rows) {
    const hash = await policyDocHash(key, version, row.lang, row.title, row.body);
    hashes[row.lang] = hash;
    statements.push(db.prepare("UPDATE policy_documents SET status = 'published', hash = ? WHERE id = ? AND status = 'draft'").bind(hash, row.id));
  }
  statements.push(db.prepare("UPDATE policy_documents SET status = 'archived' WHERE key = ? AND version < ? AND status = 'published'").bind(key, version));
  return { statements, hashes };
}

export function isPolicyPublicationConflict(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
  return /NOT NULL constraint failed:\s*policy_documents\.hash/i.test(message);
}
