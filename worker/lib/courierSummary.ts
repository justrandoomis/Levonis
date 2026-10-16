/**
 * THE COURIER'S ONE LINE ABOUT WHAT IS IN THE BOX (docs/ux/COLOUR-QUANTITIES.md §7).
 *
 * The waybill used to carry `${name} x${qty}` per line, joined and then cut at
 * 500 characters. Two things were wrong with that for a parcel packed from it:
 *
 *   * NO SELECTION. Three lines of one filament in three colours read as the
 *     same product three times, so the box could leave with the wrong colours
 *     and nothing on the courier's record would say so;
 *   * THE CUT COULD FALL INSIDE A LINE. `slice(0, 500)` could leave
 *     «PLA Basic [With spool — 1 kg / BLA», or worse a quantity of «x5» that
 *     was «x50» before the cut.
 *
 * Each line is now `${name} [${selection}] x${qty}`, where the selection is the
 * order's own stored `option_snapshot` — the authority for what was sold. No
 * colour is read from today's catalogue here (a renamed colour would put the
 * wrong item in the box). When the summary is too long, the product NAMES are
 * shortened first; a selection and a quantity are never shortened; and if it
 * is still too long, whole lines are dropped from the end and replaced by
 * «+N more». No cut ever falls inside a line.
 */

export interface CourierSummaryItem {
  name_snapshot: string;
  option_snapshot?: string | null;
  qty: number;
  /**
   * A bundle or mystery PARENT (it has child lines). Its stored selection is
   * the list of what is inside the box (orders.ts `compositionOptionSnapshot`),
   * and a courier is a third party: it gets the parent's name and count only
   * (docs/BUNDLES_MYSTERY.md, the courier row).
   */
  composition_parent?: number | boolean | null;
}

/** How long a product name may be once the summary has to shrink. */
export const COURIER_NAME_SHORT = 40;

const SEPARATOR = ', ';

function shortName(name: string, max: number): string {
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  return `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
}

function lineText(item: CourierSummaryItem, nameMax: number | null): string {
  const raw = String(item.name_snapshot ?? '').trim();
  const name = nameMax === null ? raw : shortName(raw, nameMax);
  const selection = item.composition_parent ? '' : String(item.option_snapshot ?? '').trim();
  const qty = Math.max(0, Math.trunc(Number(item.qty) || 0));
  return selection ? `${name} [${selection}] x${qty}` : `${name} x${qty}`;
}

// UTF-16 units, as the old `slice(0, 500)` counted: the stricter of the two measures.
const length = (s: string) => s.length;

/**
 * The summary, never longer than `max` characters, never cut inside a line.
 *
 * The order of the lines is the caller's (the order's own line order).
 */
export function courierItemsSummary(items: readonly CourierSummaryItem[], max = 500): string {
  const full = items.map((i) => lineText(i, null));
  const joinedFull = full.join(SEPARATOR);
  if (length(joinedFull) <= max) return joinedFull;

  // 1. Shorten the product names. The selection and the quantity stay whole.
  const shortened = items.map((i) => lineText(i, COURIER_NAME_SHORT));
  const joinedShort = shortened.join(SEPARATOR);
  if (length(joinedShort) <= max) return joinedShort;

  // 2. Drop whole lines from the end, naming how many were dropped.
  for (let keep = shortened.length - 1; keep >= 0; keep--) {
    const more = `+${shortened.length - keep} more`;
    const text = [...shortened.slice(0, keep), more].join(SEPARATOR);
    if (length(text) <= max) return text;
  }
  // Unreachable for any sane `max`: «+N more» alone always fits in 500.
  return `+${shortened.length} more`;
}
