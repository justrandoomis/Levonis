/**
 * WHEN A SALE ENDS, AS A CUSTOMER IS TOLD — the end of an offer window in Baghdad time
 * (DECISIONS row 296). The price feed's «ينتهي العرض» column prints it, so Meta's agent can say
 * until when a Black Friday price holds: «الجمعة 27/11/2026 الساعة 11:59 مساءً».
 *
 * BAGHDAD TIME, WHATEVER THE HOST. Iraq is UTC+3 all year (worker/lib/baghdadTime.ts), and the owner
 * types a sale's end on a Baghdad clock (src/lib/offerTime.ts; worker/lib/offers.ts `normalizeUtc`
 * stores the UTC instant). Only `getUTC*` reads are made, after adding the offset, so a laptop's own
 * zone never moves the answer.
 *
 * A MIDNIGHT END IS THE END OF THE DAY BEFORE. A sale the owner ends at «28/11 00:00» is over when
 * Saturday begins; «السبت 28/11/2026 الساعة 12:00 صباحاً» reads to most customers as «on Saturday».
 * So an end in a Baghdad midnight's minute is said as the last minute of the day before: «الجمعة
 * 27/11/2026 الساعة 11:59 مساءً». Any other end is said at its own minute, seconds dropped.
 *
 * WORDS. Arabic is the feed's; English and Sorani exist so another surface (the support chat; DECISIONS
 * row 296) can say the same sentence. The weekday names are the delivery board's own
 * (worker/lib/deliveryDay.ts `WEEKDAYS`); the Sorani hour words are the CLDR day periods («ب.ن» before
 * noon, «د.ن» after noon) and «کاتژمێر» for «الساعة». Digits stay Latin in every language: the
 * owner's own example and the feed's prices («760,500») are written that way, and a machine reads them.
 *
 * '' FOR NO END: an open-ended window (`ends_at` null) or an instant that does not parse. Never a throw.
 * A time written without a zone is read on Baghdad's clock, as the owner's form and `normalizeUtc` do.
 *
 * Pure: no I/O, no Intl (every runtime agrees).
 */
import { BAGHDAD_OFFSET_MS } from './baghdadTime';
import { WEEKDAYS } from './deliveryDay';

export type OfferEndLang = 'ar' | 'en' | 'ckb';

const AT: Readonly<Record<OfferEndLang, string>> = { ar: 'الساعة', en: 'at', ckb: 'کاتژمێر' };
const BEFORE_NOON: Readonly<Record<OfferEndLang, string>> = { ar: 'صباحاً', en: 'AM', ckb: 'ب.ن' };
const AFTER_NOON: Readonly<Record<OfferEndLang, string>> = { ar: 'مساءً', en: 'PM', ckb: 'د.ن' };

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const two = (n: number) => String(n).padStart(2, '0');

/**
 * TEXT WITHOUT A ZONE IS BAGHDAD TIME, by exactly the store's own rule for a sale's times
 * (worker/lib/offers.ts `normalizeUtc`, which every stored `ends_at` already went through, and which is
 * not imported here to keep this module a leaf): text that does not end in `Z` or an offset gets
 * `+03:00`, a 16-character date-time its seconds first — so «2026-11-28 00:00», «…t00:00» and
 * «…T00:00:00.123456» are all Baghdad midnight, never the host's zone that `Date.parse` would use. A
 * bare date is not a time: it does not parse, and reads as no end, as `normalizeUtc` gives null.
 */
function zoned(v: string): string {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(v) ? v : `${v.length === 16 ? `${v}:00` : v}+03:00`;
}

/**
 * The end of a sale as a sentence fragment: «الجمعة 27/11/2026 الساعة 11:59 مساءً» (ar),
 * «Friday 27/11/2026 at 11:59 PM» (en), «هەینی 27/11/2026 کاتژمێر 11:59 د.ن» (ckb).
 * '' when there is no end.
 */
export function offerEndText(endsAt: string | null | undefined, lang: OfferEndLang = 'ar'): string {
  if (typeof endsAt !== 'string' || endsAt.trim() === '') return '';
  const instant = Date.parse(zoned(endsAt.trim()));
  if (!Number.isFinite(instant)) return '';
  // The minute the sale ends on Baghdad's clock (seconds dropped, never rounded up)…
  let local = Math.floor((instant + BAGHDAD_OFFSET_MS) / MINUTE_MS) * MINUTE_MS;
  // …and when that minute is midnight, the sale ended with the day before.
  if (((local % DAY_MS) + DAY_MS) % DAY_MS === 0) local -= MINUTE_MS;
  const at = new Date(local);
  if (Number.isNaN(at.getTime())) return '';
  const L: OfferEndLang = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  const hours = at.getUTCHours();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const period = hours < 12 ? BEFORE_NOON[L] : AFTER_NOON[L];
  const date = `${two(at.getUTCDate())}/${two(at.getUTCMonth() + 1)}/${at.getUTCFullYear()}`;
  return `${WEEKDAYS[L][at.getUTCDay()]} ${date} ${AT[L]} ${hour12}:${two(at.getUTCMinutes())} ${period}`;
}
