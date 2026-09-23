/**
 * REFERENCE MATCHING FOR THE TXT IMPORT — SLUG, ID, **AND THE NAME A PERSON TYPES**.
 *
 * WHAT WENT WRONG. `resolveRefs` (worker/routes/template.ts) asked
 * `WHERE slug = ? OR id = ?` and nothing else. The owner's التصنيفات screen
 * lists «بامبو لاب / Bambu Lab», slug `bambu-lab`, ten products on it; a file
 * whose line read `brand=Bambu Lab` was answered «unknown brand "Bambu Lab" —
 * create the brand first». The brand was in the list the whole time — the file
 * simply named it the way a human names it. The same sentence was true of
 * `category=`, `sub_category=` and `catalogs=`, which are the same query
 * against `catalogs`.
 *
 * HOW A VALUE IS MATCHED NOW, in two tiers that never trade places:
 *
 *   1. AUTHORITATIVE — `slug` or `id`, compared with `normKey` (trim, lower
 *      case, runs of whitespace collapsed). These are unique by definition, so
 *      a hit here is final and no name may take it away. It is the same rule
 *      `registerAliases` (worker/routes/adminImport.ts) applies to the CSV
 *      import; the two importers must not disagree about the same word.
 *   2. NAMES — `name_ar`, `name_en`, `name_ckb`, compared with `normalizeText`
 *      (./search/normalize.ts).
 *
 * WHY `normalizeText` AND NOT `toLowerCase()` FOR THE NAMES. Lower-casing is a
 * Latin operation: it does exactly nothing to «بامبو لاب», so an Arabic name
 * typed with a different hamza carrier (أ إ آ ا), or ending in ة where the row
 * holds ه, would still miss and the owner would be told a second time that a
 * brand they can see does not exist. `normalizeText` is this repo's existing
 * answer to that question — it is what the shop's own search compares with —
 * so the name that finds a brand in the search box is the name that resolves
 * it in an import.
 *
 * HOW FAR TO FOLD, AND WHY FOLDING TOO FAR CANNOT MIS-FILE ANYTHING HERE.
 * `normalizeText` keeps digits and keeps the letters that are genuinely
 * different sounds (ڕ ڵ ۆ گ چ پ ژ), so "X1C" and "X2D" can never meet. It does
 * drop punctuation, so rows named "AT&T" and "AT T" would produce one key.
 * That is not a mis-file: a key claimed by more than one row is reported
 * AMBIGUOUS and refused BY NAME with the candidates' slugs printed, because
 * silently taking the first row is how ten products end up under the wrong
 * brand. Deliberately NOT used: `tokenize`, transliteration and edit distance
 * (./search/translit.ts, ./search/match.ts). Those exist to find something
 * plausible for a shopper; an import must be certain or say that it is not.
 *
 * INACTIVE ROWS MATCH TOO. The CSV import reads `WHERE active = 1`, which is
 * right for it: it can only ever refuse, and «أضفها أولًا» is a fair answer.
 * This resolver CREATES a brand it cannot find, so skipping a deactivated row
 * would answer a file naming it by minting a SECOND «Bambu Lab» at slug
 * `bambu-lab-2` — the exact split that the create rule below exists to avoid.
 */
import { newId } from './crypto';
import { normalizeText } from './search/normalize';
import { normKey } from './importApply';
import { slugify, uniqueSlug } from '../routes/adminTaxonomy';
import type { PendingBrand } from './template';

/** The columns every taxonomy row this module matches against must carry. */
export interface RefRow {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
}

export type RefMatch =
  | { kind: 'hit'; id: string }
  /** Nothing answers to this value. For a brand that means "create it". */
  | { kind: 'miss' }
  /** More than one row answers to this NAME — the candidates' slugs, sorted. */
  | { kind: 'ambiguous'; candidates: string[] };

/** The whole table, once. `brands` and `catalogs` are admin-sized (the panel
 *  itself lists them with `LIMIT 500`), and one read replaced one query per
 *  reference — a `catalogs=` line with eight entries made eight round trips. */
export async function loadRefRows(db: D1Database, table: 'brands' | 'catalogs'): Promise<RefRow[]> {
  const { results } = await db.prepare(`SELECT id, slug, name_ar, name_en, name_ckb FROM ${table}`).all<RefRow>();
  return results ?? [];
}

export function matchRef(rows: RefRow[], raw: string): RefMatch {
  const value = raw.trim();
  if (!value) return { kind: 'miss' };
  const authoritative = normKey(value);
  for (const r of rows) {
    if (normKey(r.slug) === authoritative || normKey(r.id) === authoritative) return { kind: 'hit', id: r.id };
  }
  const key = normalizeText(value);
  if (!key) return { kind: 'miss' };
  const hits = rows.filter((r) => [r.name_ar, r.name_en, r.name_ckb].some((n) => n && normalizeText(n) === key));
  if (hits.length === 0) return { kind: 'miss' };
  if (hits.length === 1) return { kind: 'hit', id: hits[0].id };
  return { kind: 'ambiguous', candidates: hits.map((r) => r.slug).sort() };
}

/** Arabic, Persian and Kurdish letters — the test that decides which name
 *  column a single string from the file belongs in. */
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;

/**
 * WHAT A BRAND THE FILE INVENTS WILL LOOK LIKE — decided at CHECK time so the
 * owner reads it before pressing «ابدأ الاستيراد», not afterwards.
 *
 * Nothing is written here. The row's identity (`id`) is allocated now so the
 * disclosure, the preview's diff and the row the apply finally inserts are all
 * the same brand rather than three descriptions of one.
 *
 * THE NAME COLUMNS. The file carries ONE string, and `brands.name_ar` is NOT
 * NULL. `POST /api/admin/taxonomy/brands` already answers the same question —
 * an absent `name_ar` falls back to the English name — so a Latin "Bambu Lab"
 * is written to both columns and an Arabic «بامبو لاب» is written to `name_ar`
 * with `name_en` left empty for the owner to fill. `name_ckb` is ALWAYS empty:
 * inventing Sorani for a brand nobody typed in Sorani is machine translation,
 * which this repo does not do. The owner names it in التصنيفات.
 */
export async function planBrandCreate(db: D1Database, name: string): Promise<PendingBrand> {
  const trimmed = name.trim();
  const arabic = ARABIC_SCRIPT.test(trimmed);
  const nameEn = arabic ? '' : trimmed;
  const nameAr = arabic ? trimmed : trimmed;
  const id = newId('brd');
  const slug = await uniqueSlug(db, 'brands', slugify(nameEn || nameAr, id), null);
  return { id, name: trimmed, name_ar: nameAr, name_en: nameEn, slug };
}

/**
 * THE ONE PLACE A TXT IMPORT WRITES A BRAND — and it writes at most one row
 * per name however often it runs.
 *
 * RE-RESOLVED FIRST, ALWAYS. The check that disclosed this brand may have run
 * minutes ago, and the owner may have added the brand by hand in between, or
 * applied the same file twice, or be applying ten files from one archive that
 * all name it. Every one of those paths comes back through here and finds the
 * row that now exists, so «أضف براند جديد» never becomes «أضف براند جديد
 * مرتين». The slug is derived again for the same reason: `bambu-lab` may have
 * been taken since the check, and `brands.slug` is UNIQUE.
 *
 * AMBIGUITY IS STILL NOT A MATCH. If the gap produced two rows answering to
 * the name, the write is refused here exactly as the check would have refused
 * it — a second brand is not a repair for that.
 */
export async function createPendingBrand(
  db: D1Database,
  pending: PendingBrand
): Promise<{ id: string; created: boolean } | { ambiguous: string[] }> {
  const again = matchRef(await loadRefRows(db, 'brands'), pending.name);
  if (again.kind === 'hit') return { id: again.id, created: false };
  if (again.kind === 'ambiguous') return { ambiguous: again.candidates };
  const slug = await uniqueSlug(db, 'brands', pending.slug, null);
  await db
    .prepare('INSERT INTO brands (id, slug, name_ar, name_en, name_ckb, active) VALUES (?, ?, ?, ?, ?, 1)')
    .bind(pending.id, slug, pending.name_ar, pending.name_en, '')
    .run();
  return { id: pending.id, created: true };
}
