/**
 * THE REVIEWED BUNDLE THE WORKER CARRIES (Bambu import spec §A.3 "The reviewed
 * scope"; DECISIONS row 241).
 *
 * The eight committed files under data/bambu-import/ are bundled into the
 * Worker as wrangler `Text` modules (wrangler.jsonc `rules`), so a changed file
 * is a reviewed commit that deploys through workflow 7 like any code. Nothing
 * reads them from anywhere else: no D1 row, no variable, no request.
 *
 * `currentReviewedBundle()` parses them once per isolate (pure, through
 * reviewed.ts) and keeps either the bundle or the refusal: a malformed file is
 * an answer the ops router gives (REVIEWED_BUNDLE_INVALID), never a 500 and
 * never a half-read bundle. `/hello` answers each file's SHA-256 even then, so
 * the runner names the file that differs.
 *
 * THE TEST SEAM. Under Node the same `import` yields a parsed object, not the
 * file's bytes, so the bundle is unavailable there unless a test hands it the
 * texts it read (`useReviewedTextsForTests`). No route calls that function.
 */
import manifest from '../../../data/bambu-import/manifest.json';
import taxonomyMap from '../../../data/bambu-import/taxonomy-map.json';
import existingMatches from '../../../data/bambu-import/existing-matches.json';
import compatTargets from '../../../data/bambu-import/compat-targets.json';
import identityMap from '../../../data/bambu-import/identity-map.json';
import mediaOverrides from '../../../data/bambu-import/media-overrides.json';
import curatedIndex from '../../../data/bambu-import/curated/index.json';
import searchSynonyms from '../../../data/bambu-import/search-synonyms.json';
import { sha256Hex } from '@levonis/catalog/bambuImport/hash';
import {
  parseReviewedBundle,
  REVIEWED_FILES,
  reviewedBundleDigest,
  ReviewedBundleInvalid,
  type ReviewedBundle,
  type ReviewedFileKey,
  type ReviewedTexts,
} from './reviewed';

const MODULES: Record<ReviewedFileKey, unknown> = {
  manifest,
  taxonomyMap,
  existingMatches,
  compatTargets,
  identityMap,
  mediaOverrides,
  curatedIndex,
  searchSynonyms,
};

export type BundleState =
  | { ok: true; bundle: ReviewedBundle; sha256: Record<string, string>; digest: string }
  | { ok: false; code: 'REVIEWED_BUNDLE_UNAVAILABLE' | 'REVIEWED_BUNDLE_INVALID'; file: string; sha256: Record<string, string>; digest: string };

let injected: ReviewedTexts | null = null;
let cached: BundleState | null = null;

/** TEST-ONLY: the texts the bundle is parsed from (null: back to the bundled modules). */
export function useReviewedTextsForTests(texts: ReviewedTexts | null): void {
  injected = texts;
  cached = null;
}

/** The bundled texts, or null when the build did not bundle them as text (Node without the seam). */
export function bundledReviewedTexts(): ReviewedTexts | null {
  if (injected) return injected;
  const out = {} as ReviewedTexts;
  for (const k of Object.keys(REVIEWED_FILES) as ReviewedFileKey[]) {
    const v = MODULES[k];
    if (typeof v !== 'string') return null;
    out[k] = v;
  }
  return out;
}

/** The parsed bundle with each file's SHA-256 (by its file name) and the runner's combined digest. */
export function currentReviewedBundle(): BundleState {
  if (cached) return cached;
  const texts = bundledReviewedTexts();
  if (!texts) {
    cached = { ok: false, code: 'REVIEWED_BUNDLE_UNAVAILABLE', file: '', sha256: {}, digest: '' };
    return cached;
  }
  const sha256: Record<string, string> = {};
  for (const k of Object.keys(REVIEWED_FILES) as ReviewedFileKey[]) sha256[REVIEWED_FILES[k]] = sha256Hex(texts[k]);
  const digest = reviewedBundleDigest(sha256);
  try {
    cached = { ok: true, bundle: parseReviewedBundle(texts), sha256, digest };
  } catch (e) {
    if (!(e instanceof ReviewedBundleInvalid)) throw e;
    cached = { ok: false, code: 'REVIEWED_BUNDLE_INVALID', file: e.file, sha256, digest };
  }
  return cached;
}
