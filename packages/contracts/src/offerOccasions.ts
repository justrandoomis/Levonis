/**
 * «تخفيض السعر» BY OCCASION — THE PRESETS AND THEIR WORDS (DECISIONS row 294; docs/ux/PRODUCT-DISCOUNT.md §16).
 *
 * The owner, 2026-11-04: «make a label to show this is black friday discount like on to left corner»; and on
 * 2026-11-05, how a discount gets it: «Label all sales by dates on product edit on price dicount can named by
 * what the oocasion like cristmas or blackfriday or cyber monday or flash deal or hyper or white friday or 11.11
 * or 12.12 or eid al futtur or eid al adhaa or ramaddan or back to school or summer deal or winter or spring deal
 * or anything, any of them have special design and clean ui ux for know this is dicount for this special deal».
 *
 * ONE TABLE FOR BOTH SIDES. The Worker validates a key against it and stores the key on the sale's own row
 * (`offer_windows.badge`, migration 0224; `badge_text` holds a custom name); the SPA draws each key in its own
 * design (src/components/ui/OccasionTag.tsx) with these words. No label TEXT for a preset ever travels: the
 * customer payload carries the key, and a custom name only for `custom`.
 *
 * A KEY IS A SHAPE, NOT A LIST, IN THE DATABASE: the column's CHECK is `^[a-z0-9_]{2,32}$` (`OCCASION_KEY_SHAPE`),
 * so a new preset is a change here and never a CHECK widening (a table rebuild in SQLite). An unknown key reads
 * as no label everywhere (an older Worker reading a newer key).
 *
 * Every `ckb` is its own Sorani (DECISIONS row 183) — never a copy of the Arabic and never one of the
 * Arabic-only letters ة ى ي ك. The Sorani transliterations of the English event names («بلاک فرایدەی»,
 * «سایبەر ماندەی») are the shop's spelling until the owner confirms them.
 *
 * No runtime dependency: the Worker and the SPA import this file as it is.
 */

export type OccasionLang = 'ar' | 'en' | 'ckb';

export interface OccasionText {
  ar: string;
  en: string;
  ckb: string;
}

/**
 * The presets, in the order the owner's picker shows them: the shopping days first, then the season of
 * Ramadan and the two Eids, Christmas, and the four seasons of the year.
 */
export const OFFER_OCCASION_PRESETS = [
  'black_friday',
  'white_friday',
  'cyber_monday',
  'singles_day',
  'double_twelve',
  'flash_deal',
  'hyper_deal',
  'ramadan',
  'eid_al_fitr',
  'eid_al_adha',
  'christmas',
  'back_to_school',
  'summer',
  'winter',
  'spring',
] as const;

export type OfferOccasionPreset = (typeof OFFER_OCCASION_PRESETS)[number];

/** A preset, or the owner's own name (`custom`, with `badge_text`). */
export type OfferOccasionKey = OfferOccasionPreset | 'custom';

export const OFFER_OCCASION_KEYS: readonly OfferOccasionKey[] = [...OFFER_OCCASION_PRESETS, 'custom'];

/** The column's CHECK (migration 0224): a key the database accepts, known to this code or not. */
export const OCCASION_KEY_SHAPE = /^[a-z0-9_]{2,32}$/;

/**
 * The longest custom name the door accepts, in characters, in each language. A card's ribbon (and the
 * gallery's, its scale) shows about 14 of them whole and ends a longer name in an ellipsis
 * (src/components/ui/OccasionTag.tsx `room`); the owner's picker previews it in all three languages and says so.
 */
export const OCCASION_NAME_MAX = 32;

/**
 * What a shopper reads for one occasion: the tag's NAME, the sentence a screen reader says instead of the
 * tag («خصم بلاك فرايدي»), and the label beside the sale price on the product page («سعر بلاك فرايدي»).
 */
export interface OccasionWords {
  name: OccasionText;
  sr: OccasionText;
  price: OccasionText;
}

export const OFFER_OCCASIONS: Readonly<Record<OfferOccasionPreset, OccasionWords>> = {
  black_friday: {
    name: { ar: 'بلاك فرايدي', en: 'Black Friday', ckb: 'بلاک فرایدەی' },
    sr: { ar: 'تخفيض بلاك فرايدي', en: 'Black Friday sale', ckb: 'داشکاندنی بلاک فرایدەی' },
    price: { ar: 'سعر بلاك فرايدي', en: 'Black Friday price', ckb: 'نرخی بلاک فرایدەی' },
  },
  white_friday: {
    name: { ar: 'الجمعة البيضاء', en: 'White Friday', ckb: 'هەینیی سپی' },
    sr: { ar: 'تخفيض الجمعة البيضاء', en: 'White Friday sale', ckb: 'داشکاندنی هەینیی سپی' },
    price: { ar: 'سعر الجمعة البيضاء', en: 'White Friday price', ckb: 'نرخی هەینیی سپی' },
  },
  cyber_monday: {
    name: { ar: 'سايبر مونداي', en: 'Cyber Monday', ckb: 'سایبەر ماندەی' },
    sr: { ar: 'تخفيض سايبر مونداي', en: 'Cyber Monday sale', ckb: 'داشکاندنی سایبەر ماندەی' },
    price: { ar: 'سعر سايبر مونداي', en: 'Cyber Monday price', ckb: 'نرخی سایبەر ماندەی' },
  },
  singles_day: {
    name: { ar: 'عروض 11.11', en: '11.11 Sale', ckb: 'ئۆفەری 11.11' },
    sr: { ar: 'تخفيض 11.11', en: '11.11 sale', ckb: 'داشکاندنی 11.11' },
    price: { ar: 'سعر 11.11', en: '11.11 price', ckb: 'نرخی 11.11' },
  },
  double_twelve: {
    name: { ar: 'عروض 12.12', en: '12.12 Sale', ckb: 'ئۆفەری 12.12' },
    sr: { ar: 'تخفيض 12.12', en: '12.12 sale', ckb: 'داشکاندنی 12.12' },
    price: { ar: 'سعر 12.12', en: '12.12 price', ckb: 'نرخی 12.12' },
  },
  flash_deal: {
    name: { ar: 'عرض خاطف', en: 'Flash Deal', ckb: 'ئۆفەری خێرا' },
    sr: { ar: 'تخفيض عرض خاطف', en: 'Flash deal discount', ckb: 'داشکاندنی ئۆفەری خێرا' },
    price: { ar: 'سعر العرض الخاطف', en: 'Flash deal price', ckb: 'نرخی ئۆفەری خێرا' },
  },
  hyper_deal: {
    name: { ar: 'عرض هايبر', en: 'Hyper Deal', ckb: 'ئۆفەری هایپەر' },
    sr: { ar: 'تخفيض عرض هايبر', en: 'Hyper deal discount', ckb: 'داشکاندنی ئۆفەری هایپەر' },
    price: { ar: 'سعر عرض هايبر', en: 'Hyper deal price', ckb: 'نرخی ئۆفەری هایپەر' },
  },
  ramadan: {
    name: { ar: 'عروض رمضان', en: 'Ramadan Deal', ckb: 'ئۆفەری ڕەمەزان' },
    sr: { ar: 'تخفيض رمضان', en: 'Ramadan sale', ckb: 'داشکاندنی ڕەمەزان' },
    price: { ar: 'سعر رمضان', en: 'Ramadan price', ckb: 'نرخی ڕەمەزان' },
  },
  eid_al_fitr: {
    name: { ar: 'عيد الفطر', en: 'Eid al-Fitr', ckb: 'جەژنی ڕەمەزان' },
    sr: { ar: 'تخفيض عيد الفطر', en: 'Eid al-Fitr sale', ckb: 'داشکاندنی جەژنی ڕەمەزان' },
    price: { ar: 'سعر عيد الفطر', en: 'Eid al-Fitr price', ckb: 'نرخی جەژنی ڕەمەزان' },
  },
  eid_al_adha: {
    name: { ar: 'عيد الأضحى', en: 'Eid al-Adha', ckb: 'جەژنی قوربان' },
    sr: { ar: 'تخفيض عيد الأضحى', en: 'Eid al-Adha sale', ckb: 'داشکاندنی جەژنی قوربان' },
    price: { ar: 'سعر عيد الأضحى', en: 'Eid al-Adha price', ckb: 'نرخی جەژنی قوربان' },
  },
  christmas: {
    name: { ar: 'كريسمس', en: 'Christmas', ckb: 'کریسمس' },
    sr: { ar: 'تخفيض الكريسمس', en: 'Christmas sale', ckb: 'داشکاندنی کریسمس' },
    price: { ar: 'سعر الكريسمس', en: 'Christmas price', ckb: 'نرخی کریسمس' },
  },
  back_to_school: {
    name: { ar: 'عودة المدارس', en: 'Back to School', ckb: 'بۆ قوتابخانە' },
    sr: { ar: 'تخفيض عودة المدارس', en: 'Back to school sale', ckb: 'داشکاندنی وەرزی قوتابخانە' },
    price: { ar: 'سعر عودة المدارس', en: 'Back to school price', ckb: 'نرخی وەرزی قوتابخانە' },
  },
  summer: {
    name: { ar: 'عروض الصيف', en: 'Summer Deal', ckb: 'ئۆفەری هاوین' },
    sr: { ar: 'تخفيض الصيف', en: 'Summer sale', ckb: 'داشکاندنی هاوین' },
    price: { ar: 'سعر الصيف', en: 'Summer price', ckb: 'نرخی هاوین' },
  },
  winter: {
    name: { ar: 'عروض الشتاء', en: 'Winter Deal', ckb: 'ئۆفەری زستان' },
    sr: { ar: 'تخفيض الشتاء', en: 'Winter sale', ckb: 'داشکاندنی زستان' },
    price: { ar: 'سعر الشتاء', en: 'Winter price', ckb: 'نرخی زستان' },
  },
  spring: {
    name: { ar: 'عروض الربيع', en: 'Spring Deal', ckb: 'ئۆفەری بەهار' },
    sr: { ar: 'تخفيض الربيع', en: 'Spring sale', ckb: 'داشکاندنی بەهار' },
    price: { ar: 'سعر الربيع', en: 'Spring price', ckb: 'نرخی بەهار' },
  },
};

/**
 * THE OWNER'S OWN NAME (`custom`), language by language: Arabic is required; a language the owner left
 * empty reads these generic words — never another language's name, so a Sorani reader never sees the
 * Arabic. The price label falls back to the page's own «سعر العرض» (`SALE_PRICE`, OfferBadge.tsx).
 */
export const CUSTOM_OCCASION_FALLBACK: OccasionWords = {
  name: { ar: 'عرض خاص', en: 'Special deal', ckb: 'ئۆفەری تایبەت' },
  sr: { ar: 'تخفيض عرض خاص', en: 'Special deal discount', ckb: 'داشکاندنی ئۆفەری تایبەت' },
  price: { ar: 'سعر العرض', en: 'Sale price', ckb: 'نرخی ئۆفەر' },
};

/** The custom name as stored (JSON text in `offer_windows.badge_text`) and as the customer payload carries it. */
export interface OccasionName {
  ar: string;
  en?: string;
  ckb?: string;
}

const PRESET_SET: ReadonlySet<string> = new Set(OFFER_OCCASION_PRESETS);

export const isOfferOccasionPreset = (v: unknown): v is OfferOccasionPreset => typeof v === 'string' && PRESET_SET.has(v);

/** A key this code knows: a preset or `custom`. Anything else — an older Worker's unknown key included — is no label. */
export const isOfferOccasionKey = (v: unknown): v is OfferOccasionKey => v === 'custom' || isOfferOccasionPreset(v);

/** Arabic script (Arabic, Sorani): the test of "a copy of the Arabic" in another language's slot. */
const ARABIC_SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿ]/;

/**
 * One language's name, cleaned: control and bidi-override characters removed, white space collapsed,
 * trimmed. '' when nothing is left.
 */
export function cleanOccasionText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tooLong = (s: string) => [...s].length > OCCASION_NAME_MAX;

/**
 * A POSTED CUSTOM NAME, checked (the admin door): Arabic required; English and Sorani optional; each at
 * most `OCCASION_NAME_MAX` characters; English or Sorani identical to an Arabic-script Arabic name is a
 * copy of the Arabic and refused (DECISIONS row 183) — an empty slot reads the generic words instead.
 * Accepts the object the card posts or the JSON text the column holds.
 */
export function checkOccasionName(raw: unknown): { ok: true; name: OccasionName } | { ok: false } {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false };
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const v = value as Record<string, unknown>;
  const ar = cleanOccasionText(v.ar);
  const en = cleanOccasionText(v.en);
  const ckb = cleanOccasionText(v.ckb);
  if (!ar || tooLong(ar) || tooLong(en) || tooLong(ckb)) return { ok: false };
  const copies = (other: string) => other !== '' && other === ar && ARABIC_SCRIPT.test(ar);
  if (copies(en) || copies(ckb)) return { ok: false };
  return { ok: true, name: { ar, ...(en ? { en } : {}), ...(ckb ? { ckb } : {}) } };
}

/** A stored or carried custom name, or null when it is not one (an unreadable value is no label). */
export function occasionNameOf(raw: unknown): OccasionName | null {
  const checked = checkOccasionName(raw);
  return checked.ok ? checked.name : null;
}

/**
 * WHAT A READER SEES for an occasion, in their language: the tag's name, its screen-reader sentence and the
 * product page's price label. A preset reads its table; `custom` reads the owner's name in that language,
 * else the generic words (`fallback: true`). Null for a key this code does not know, or a `custom` without
 * a name — no label.
 */
export function occasionWords(
  key: unknown,
  name: OccasionName | null | undefined,
  lang: OccasionLang
): { key: OfferOccasionKey; name: string; sr: string; price: string; fallback: boolean } | null {
  if (isOfferOccasionPreset(key)) {
    const w = OFFER_OCCASIONS[key];
    return { key, name: w.name[lang], sr: w.sr[lang], price: w.price[lang], fallback: false };
  }
  if (key !== 'custom') return null;
  const clean = name ? occasionNameOf(name) : null;
  if (!clean) return null;
  const own = lang === 'ar' ? clean.ar : lang === 'en' ? (clean.en ?? '') : (clean.ckb ?? '');
  if (!own) {
    const f = CUSTOM_OCCASION_FALLBACK;
    return { key, name: f.name[lang], sr: f.sr[lang], price: f.price[lang], fallback: true };
  }
  const sr = lang === 'ar' ? `تخفيض ${own}` : lang === 'en' ? `${own} discount` : `داشکاندنی ${own}`;
  const price = lang === 'ar' ? `سعر ${own}` : lang === 'en' ? `${own} price` : `نرخی ${own}`;
  return { key, name: own, sr, price, fallback: false };
}
