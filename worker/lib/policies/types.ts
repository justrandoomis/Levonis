import { sha256Hex } from '../crypto';

/**
 * The shape of a store policy as the CODE authors it.
 *
 * The source of truth for policy text is this directory, not the database:
 * one module per document, imported by ./index.ts. `policy_documents` keeps
 * its role as the ARCHIVE — a versioned acceptance is worthless unless the
 * exact text that was accepted can still be read years later — but it is no
 * longer the author, and no admin screen writes it.
 */

export const POLICY_LANGS = ['ar', 'en', 'ckb'] as const;
export type PolicyLang = (typeof POLICY_LANGS)[number];

/** Arabic is the authoritative text and the fallback for the other two. */
export type PolicyText = Record<PolicyLang, string>;

export interface PolicyDocument {
  /**
   * Typed as `string`, not `PolicyKey`: a document module cannot depend on
   * the registry that imports it without a value-level circular inference
   * that TypeScript refuses. ./index.ts derives the key union from the
   * module map instead, and `isPolicyKey` narrows at the boundaries.
   */
  key: string;
  /** Bumped in code for a correction; a new version is a new archive row. */
  version: number;
  /** Calendar date, `YYYY-MM-DD`. */
  effective_at: string;
  title: PolicyText;
  body: PolicyText;
}

/**
 * The key union, derived from the registry rather than hand-listed so that
 * adding a document module is the only edit an author has to make. Re-exported
 * here as a type so callers can take the shape and the union from one import;
 * `export type` is erased, so this does not create a runtime import cycle.
 */
export type { PolicyKey } from './index';

/**
 * Content hash stored on the archive row and copied into every acceptance
 * record. It lives beside the document shape rather than in policyOps.ts
 * because it is part of a document's identity — what "this exact text" means —
 * and because keeping it here lets policySync.ts sit above policyOps.ts
 * without an import cycle.
 *
 * The input format is frozen: changing it would orphan every acceptance
 * recorded before the change from the row it points at.
 */
export function policyDocHash(
  key: string,
  version: number,
  lang: string,
  title: string,
  body: string
): Promise<string> {
  return sha256Hex(`policy:${key}:v${version}:${lang}:${title}\n${body}`);
}

/**
 * The archive's timestamp columns are ISO instants while the registry states a
 * calendar date, so the two are reconciled in exactly one place. A document
 * authored in code has no separate "drafted then published" moment: the date
 * the version takes effect IS the date it was published, which is why the
 * archive row and the code-served response carry the same value.
 */
export function policyEffectiveInstant(effectiveAt: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(effectiveAt) ? `${effectiveAt}T00:00:00.000Z` : effectiveAt;
}
