/**
 * OFFER TIMES ARE BAGHDAD TIME (docs/ux/PRODUCT-DISCOUNT.md D11, §6.5, F4).
 *
 * The server stores an offer's start and end as a UTC instant, and reads a zone-less
 * `datetime-local` value as +03:00 (worker/lib/offers.ts `normalizeUtc`) — the zone the store runs
 * in. The «العروض الخاصة» tab used to print the stored UTC instant straight into a `datetime-local`
 * field (`iso.slice(0, 16)`), so 12:00 in Baghdad showed as 09:00, and to send the field back
 * through the BROWSER's zone (`new Date(local)`), so an owner travelling abroad moved his own sale.
 * Both directions now go through Baghdad, whatever the device's zone: Iraq keeps UTC+3 all year.
 */
const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** A stored instant → the `datetime-local` value a Baghdad clock shows ('' for none or an unreadable one). */
export function isoToBaghdadInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + BAGHDAD_OFFSET_MS).toISOString().slice(0, 16);
}

/**
 * A `datetime-local` value → the naive text the server reads as Baghdad time (`2026-10-20T12:00:00`),
 * or null for an empty or malformed one. Never passed through `new Date()`: the browser's zone is not
 * the store's.
 */
export function baghdadInputToNaive(local: string | null | undefined): string | null {
  const v = String(local ?? '').trim();
  const m = LOCAL.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31 || Number(h) > 23 || Number(mi) > 59 || Number(sec ?? 0) > 59) return null;
  return `${y}-${mo}-${d}T${h}:${mi}:${sec ?? '00'}`;
}

/** The same, with the offset said out loud (`…+03:00`) — what an edited field holds until it is saved. */
export function baghdadInputToZoned(local: string | null | undefined): string | null {
  const naive = baghdadInputToNaive(local);
  return naive ? `${naive}+03:00` : null;
}
