/**
 * A NEW PRODUCT'S SLUG — the rule the CSV/TXT import and the catalogue import
 * share (Bambu import spec §A.4, §C.1).
 *
 * Moved here, unchanged, from worker/routes/adminImport.ts (where it was
 * module-private) so the catalogue import's writer
 * (worker/lib/catalogImport/writer.ts) names a created product with exactly
 * the rule the admin import uses: `uniqueProductSlug(db, productSlugFrom(handle))`.
 *
 *   - `productSlugFrom(seed)`: lower case, every run of characters other than
 *     a–z, 0–9 and the Arabic block becomes one '-', no leading or trailing
 *     '-', at most 60 characters; an empty result falls back to a
 *     deterministic `product-<base36 FNV-1a of the seed>`.
 *   - `uniqueProductSlug(db, seed)`: that slug, or `-2` … `-40` when it is
 *     taken; past that a random suffix. One read per candidate.
 */
import { newId } from './crypto';

/** The slug shape of a seed (a name, a handle, a key), before uniqueness. */
export function productSlugFrom(seed: string): string {
  return (
    seed
      .toLowerCase()
      .replace(/[^a-z0-9؀-ۿ]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || `product-${Math.abs(hashOf(seed)).toString(36)}`
  );
}

/** A free slug for a new product; mirrors the form's own rule. */
export async function uniqueProductSlug(db: D1Database, seed: string): Promise<string> {
  const base = productSlugFrom(seed);
  for (let i = 0; i < 40; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const clash = await db.prepare('SELECT id FROM products WHERE slug = ?').bind(candidate).first();
    if (!clash) return candidate;
  }
  return `${base}-${newId('p').slice(-6)}`;
}

/** FNV-1a, only ever used to make a fallback slug deterministic. */
function hashOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}
