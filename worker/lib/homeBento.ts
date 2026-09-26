/**
 * «تسوق حسب الفئة» — WHICH SECTION SITS IN WHICH SQUARE, AS THE OWNER DECIDES.
 *
 * The owner (2026-09-26): «اجعل في ترتيب الفئات في الشاشة الرئيسية في تسوق حسب
 * الفئة تكون بإدارة الأدمن حيث يقرر ماذا يضع على اليسار في المربع الكبير وماذا
 * يضع في المربعات الخمسة على اليمين اثنين فوق وثلاثة في الأسفل».
 *
 * The bento has six fixed POSITIONS — one large square, two wide tiles above
 * and three compact ones below. The `homeBento` setting maps a position to a
 * section of the taxonomy (any active `catalogs` row, root or sub, at any
 * depth) or to the graded-stock shelf (`used`), with an optional title in the
 * owner's words. A position the owner leaves unassigned keeps the automatic
 * matching it had (src/lib/homeLayout.ts `resolveBento`), so a partial
 * assignment is a normal state, not a broken one.
 *
 * THE POSITIONS ARE THE ALLOW-LIST. The admin write refuses an unknown
 * position and a section id that is not an active catalog; the read side
 * (`normalizeHomeBento`) re-checks the SHAPE, because the value round-trips
 * through a JSON settings row. A section that has no products is simply not
 * drawn on the storefront — the tree `/api/home` sends carries only stocked
 * sections — so no assignment can put an empty tile on the page.
 *
 * The same position ids name the light/dark picture pair of each square
 * (worker/lib/siteMedia.ts, targets `bento-<position>`).
 */
import { localized, type LocalizedText } from './homeContent';

export const BENTO_POSITIONS = ['large', 'top-1', 'top-2', 'bottom-1', 'bottom-2', 'bottom-3'] as const;
export type BentoPosition = (typeof BENTO_POSITIONS)[number];

/** The graded shelf (/used-printers) — the one target that is not a catalog row. */
export const BENTO_USED = 'used';

export interface BentoAssignment {
  /** A `catalogs.id`, or `used`. */
  category: string;
  /** The owner's name for the square; blank means the section's own name. */
  title: LocalizedText;
}

export type HomeBento = Partial<Record<BentoPosition, BentoAssignment>>;

const CATEGORY_ID = /^[A-Za-z0-9_-]{1,80}$/;
const TITLE_MAX = 60;

export function isBentoPosition(value: unknown): value is BentoPosition {
  return typeof value === 'string' && (BENTO_POSITIONS as readonly string[]).includes(value);
}

/**
 * The stored value's SHAPE, re-checked on the way out: unknown positions and
 * malformed ids are dropped, titles are capped. Whether a section still exists
 * is the storefront's question (it draws only sections in the live tree).
 */
export function normalizeHomeBento(raw: unknown): HomeBento {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: HomeBento = {};
  for (const [position, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isBentoPosition(position)) continue;
    if (typeof entry !== 'object' || entry === null) continue;
    const category = (entry as { category?: unknown }).category;
    if (typeof category !== 'string' || !CATEGORY_ID.test(category)) continue;
    out[position] = { category, title: localized((entry as { title?: unknown }).title, TITLE_MAX) };
  }
  return out;
}

export type BentoRefusal = { code: 'BENTO_UNKNOWN_POSITION' | 'BENTO_BAD_CATEGORY' | 'BENTO_UNKNOWN_CATEGORY'; detail: string };

/**
 * THE WRITE-SIDE CHECK. Strict where the read side is lenient: a write naming
 * a position that does not exist, or a section that is not an active catalog,
 * is refused with the reason rather than silently trimmed — the owner should
 * learn that a choice did not take. `knownCategory` is the database lookup,
 * injected so this stays testable without D1.
 */
export async function validateHomeBento(
  raw: unknown,
  knownCategory: (id: string) => Promise<boolean>
): Promise<{ ok: true; value: HomeBento } | { ok: false; refusal: BentoRefusal }> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, refusal: { code: 'BENTO_BAD_CATEGORY', detail: 'homeBento must be an object' } };
  }
  for (const [position, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isBentoPosition(position)) {
      return { ok: false, refusal: { code: 'BENTO_UNKNOWN_POSITION', detail: position } };
    }
    const category = (entry as { category?: unknown } | null)?.category;
    if (typeof category !== 'string' || !CATEGORY_ID.test(category)) {
      return { ok: false, refusal: { code: 'BENTO_BAD_CATEGORY', detail: position } };
    }
    if (category !== BENTO_USED && !(await knownCategory(category))) {
      return { ok: false, refusal: { code: 'BENTO_UNKNOWN_CATEGORY', detail: category } };
    }
  }
  return { ok: true, value: normalizeHomeBento(raw) };
}
