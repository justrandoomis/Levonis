/**
 * THE CLOSED VOCABULARIES OF THE PERSONALIZATION ENGINE, and the short words a
 * customer or a merchant reads for them in Arabic, English and written Sorani
 * (docs/LEVO_PROJECT_PROGRAMME.md §B.1, §A C1.4–C1.26).
 *
 * Weight is the design constraint (the engine chunk's budget): the key lists
 * are literal arrays, and the words are packed `a|b|c` strings in list order,
 * one export per list, so a bundle carries only the words it names. Colour
 * names come from ../palette.ts (Sorani: SWATCH_NAMES_CKB), part kinds from
 * ./parts.ts (`partKindWord`). The long sentences — check codes, rule `say`
 * codes, fix chips — belong to the feature strings (the studio's and the
 * builder's strings.ts), keyed by the code lists below.
 *
 * Customer words obey the vocabulary rule (programme decision D1 (٣),
 * tests/customerVocabulary.test.ts): plain words a shopper uses, never the
 * workshop's technical dictionary.
 */
import { SWATCHES, SWATCH_NAMES, SWATCH_NAMES_CKB, type Swatch } from '../palette';
import { partKindWord, type PartKind } from './parts';

type Lang = 'ar' | 'en' | 'ckb';

/** Every palette key a part may be painted with (`multi` is a print, not a filament). */
export const PAINT_KEYS = SWATCHES.filter((k) => k !== 'multi') as Exclude<(typeof SWATCHES)[number], 'multi'>[];
export type PaletteKey = (typeof PAINT_KEYS)[number];

export const REGION_ROLES = ['body', 'base', 'name', 'text', 'border', 'accent', 'logo', 'icon', 'insert', 'accessory', 'fixed'] as const;
export type RegionRole = (typeof REGION_ROLES)[number];
export const TONES = ['primary', 'secondary', 'accent', 'text', 'neutral'] as const;
export type Tone = (typeof TONES)[number];
export const LOOKS = ['classic', 'matte', 'shiny', 'silk', 'wood', 'marble', 'glow', 'flexible', 'translucent', 'metallic'] as const;
export type LookKey = (typeof LOOKS)[number];
export const STYLES = ['fun', 'gaming', 'elegant', 'kids', 'minimal', 'bold'] as const;
export type StyleKey = (typeof STYLES)[number];
/** Names only — themes.ts maps each to a palette per tone. */
export const THEMES = ['gaming', 'fire', 'ocean', 'candy', 'pastel', 'mono', 'royal', 'fresh', 'sunset', 'cyber'] as const;
export type ThemeKey = (typeof THEMES)[number];
export const CONTENT_KINDS = ['text', 'logo', 'photo', 'qr', 'icon'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];
export const AREA_ROLES = ['name', 'text', 'logo', 'photo', 'qr', 'icon'] as const;
export type AreaRole = (typeof AREA_ROLES)[number];
/** `reorder` carries no value: the server fills the twin link (C3). */
export const QR_KINDS = ['instagram', 'tiktok', 'whatsapp', 'website', 'menu', 'contact', 'url', 'reorder'] as const;
export type QrKind = (typeof QR_KINDS)[number];
export const NFC_KINDS = ['profile', 'whatsapp', 'website', 'contact', 'wifi', 'url'] as const;
export type NfcKind = (typeof NFC_KINDS)[number];
export const PHOTO_MODES = ['lithophane', 'relief', 'silhouette', 'print'] as const;
export type PhotoMode = (typeof PHOTO_MODES)[number];
export const LOGO_MODES = ['flat', 'raised', 'engraved'] as const;
export type LogoMode = (typeof LOGO_MODES)[number];
/** lucide-react names (ISC), kebab-case as in `lucide-react/dist/esm/icons/<key>.js`. */
export const ICON_KEYS = [
  'heart', 'star', 'crown', 'gift', 'cake', 'party-popper', 'graduation-cap', 'gamepad-2', 'trophy', 'medal', 'volleyball', 'music',
  'camera', 'coffee', 'utensils', 'shopping-bag', 'briefcase', 'house', 'flower-2', 'sun', 'moon', 'sparkles', 'paw-print', 'car',
] as const;
export type IconKey = (typeof ICON_KEYS)[number];
export const TIERS = ['value', 'best'] as const;
export type Tier = (typeof TIERS)[number];
export const LICENCES = ['remix', 'personal', 'no_remix'] as const;
export type Licence = (typeof LICENCES)[number];
export const FAMILIES = ['stand', 'keychain', 'lamp', 'sign', 'plaque', 'magnet', 'frame', 'decor', 'figure', 'toy', 'box', 'other'] as const;
export type FamilyKey = (typeof FAMILIES)[number];
export const OCCASIONS = ['birthday', 'wedding', 'graduation', 'eid', 'ramadan', 'newroz', 'newyear', 'valentine', 'mothers_day', 'birth', 'opening'] as const;
export type Occasion = (typeof OCCASIONS)[number];
export const RECIPIENTS = ['kids', 'him', 'her', 'couple', 'family', 'friend', 'team', 'teacher', 'business'] as const;
export type Recipient = (typeof RECIPIENTS)[number];
/** How a slot shows its part: a marker part made `visible`, or a simplified marker at an anchor. */
export const SLOT_EFFECTS = ['marker', 'glow', 'ring', 'badge', 'visible'] as const;
export type SlotEffect = (typeof SLOT_EFFECTS)[number];

/** A rule's explanation code (the sentence lives in the feature strings). */
export const SAY_CODES = ['text_needs_size', 'addon_needs_size', 'qr_needs_size', 'addon_needs_addon', 'addons_conflict', 'look_limits_colors', 'fewer_colors'] as const;
export type SayCode = (typeof SAY_CODES)[number];

/**
 * check.ts codes in verdict-group order: `fixed` (0–8, price-neutral, applied
 * and explained), `suggest` (9–11, a priced one-tap fix), `review` (12–15),
 * `blocked` (16–22).
 */
export const CHECK_CODES = [
  'TEXT_FITTED', 'TEXT_TWO_LINES', 'TEXT_STYLE_BOLDER', 'COLOR_MATCHED', 'COLORS_MERGED', 'CONTRAST_FIXED', 'QR_ENLARGED', 'LOGO_SIMPLIFIED', 'RULE_ADJUSTED',
  'SIZE_UP_FOR_TEXT', 'SIZE_UP_FOR_QR', 'SIZE_UP_FOR_ADDON',
  'LOGO_DETAIL', 'PHOTO_LOW_RES', 'PHOTO_NEEDS_CUTOUT', 'TOO_BIG_FOR_PRINTER',
  'TEXT_TOO_LONG', 'COMPONENT_OUT', 'COLOR_OUT', 'SIZE_OUT', 'QR_UNREADABLE', 'CONTENT_MISSING', 'RULE_UNMET',
] as const;
export type CheckCode = (typeof CHECK_CODES)[number];
export type CheckGroup = 'fixed' | 'suggest' | 'review' | 'blocked';
export function checkGroup(code: CheckCode): CheckGroup {
  const i = CHECK_CODES.indexOf(code);
  return i < 9 ? 'fixed' : i < 12 ? 'suggest' : i < 16 ? 'review' : 'blocked';
}

/** QR and NFC kinds share their words. */
export const TARGET_KEYS = ['instagram', 'tiktok', 'whatsapp', 'website', 'menu', 'contact', 'url', 'reorder', 'profile', 'wifi'] as const;

/**
 * Words: `[ar, en, ckb]`, each `a|b|c` in its key list's order. One export per
 * list, so a bundle carries only the lists it names (`word(LOOK_WORDS, LOOKS,
 * key, lang)`); `vocabWord` reads them all (the Worker's summary).
 */
export type Words = readonly [ar: string, en: string, ckb: string];

export const ROLE_WORDS: Words = [
  'الجسم|القاعدة|الاسم|النص|الحافة|الزخرفة|الشعار|الأيقونة|القطعة الداخلية|الإكسسوار|قطعة ثابتة',
  'Body|Base|Name|Text|Border|Accent|Logo|Icon|Insert|Accessory|Fixed part',
  'لاشە|بنکە|ناو|دەق|لێوار|جوانکاری|لۆگۆ|هێما|پارچەی ناوەوە|پاشکۆ|پارچەی جێگیر',
];
export const TONE_WORDS: Words = ['أساسي|ثانوي|مميّز|للنص|محايد', 'Primary|Secondary|Accent|Text|Neutral', 'سەرەکی|لاوەکی|جیاکەرەوە|بۆ دەق|بێلایەن'];
export const LOOK_WORDS: Words = [
  'كلاسيكي|مطفي|لامع|حريري|خشبي|رخامي|مضيء|مرن|شبه شفاف|معدني',
  'Classic|Matte|Shiny|Silk|Wood|Marble|Glow|Flexible|Translucent|Metallic',
  'کلاسیکی|مات|بریقەدار|ئاوریشمی|دارین|مەڕمەڕی|درەوشاوە|نەرم|نیوەڕوون|کانزایی',
];
export const STYLE_WORDS: Words = ['مرح|ألعاب|أنيق|أطفال|بسيط|عريض', 'Fun|Gaming|Elegant|Kids|Minimal|Bold', 'خۆش|یاری|شیک|منداڵانە|سادە|ئەستوور'];
export const THEME_WORDS: Words = [
  'ألعاب|نار|محيط|حلوى|باستيل|لون واحد|ملكي|منعش|غروب|سايبر',
  'Gaming|Fire|Ocean|Candy|Pastel|Mono|Royal|Fresh|Sunset|Cyber',
  'یاری|ئاگر|زەریا|شیرینی|پاستێل|یەک ڕەنگ|شاهانە|تازە|خۆرئاوابوون|سایبەر',
];
export const KIND_WORDS: Words = ['نص|شعار|صورة|رمز QR|أيقونة', 'Text|Logo|Photo|QR code|Icon', 'دەق|لۆگۆ|وێنە|کۆدی QR|هێما'];
export const TARGET_WORDS: Words = [
  'إنستغرام|تيك توك|واتساب|موقع إلكتروني|قائمة الطعام|جهة اتصال|رابط|رابط إعادة الطلب|حساب تواصل|واي فاي',
  'Instagram|TikTok|WhatsApp|Website|Menu|Contact|Link|Reorder link|Social profile|Wi-Fi',
  'ئینستاگرام|تیکتۆک|واتسئاپ|ماڵپەڕ|لیستی خواردن|پەیوەندی|بەستەر|بەستەری داواکردنەوە|پرۆفایلی کۆمەڵایەتی|وایفای',
];
export const PHOTO_WORDS: Words = ['صورة مضيئة|نقش بارز|ظلّ|طباعة ملوّنة', 'Lithophane|Relief|Silhouette|Colour print', 'وێنەی ڕووناک|وێنەی بەرجەستە|سێبەر|چاپی ڕەنگاوڕەنگ'];
export const LOGO_WORDS: Words = ['مسطّح|بارز|محفور', 'Flat|Raised|Engraved', 'تەخت|بەرز|هەڵکەندراو'];
export const ICON_WORDS: Words = [
  'قلب|نجمة|تاج|هدية|كعكة|احتفال|تخرّج|يد تحكم|كأس|ميدالية|كرة|موسيقى|كاميرا|قهوة|مطعم|تسوّق|أعمال|بيت|زهرة|شمس|قمر|بريق|أثر مخلب|سيارة',
  'Heart|Star|Crown|Gift|Cake|Party|Graduation|Controller|Trophy|Medal|Ball|Music|Camera|Coffee|Restaurant|Shopping|Business|Home|Flower|Sun|Moon|Sparkles|Paw|Car',
  'دڵ|ئەستێرە|تاجی شاهانە|دیاری|کێک|ئاهەنگ|دەرچوون|دەسکی یاری|جامی پاڵەوانی|مەدالیا|تۆپ|مۆسیقا|کامێرا|قاوە|چێشتخانە|بازاڕکردن|بازرگانی|ماڵ|گوڵ|خۆر|مانگ|بریسکە|شوێنپێی ئاژەڵ|ئۆتۆمبێل',
];
export const TIER_WORDS: Words = ['قيمة جيدة|أفضل مظهر', 'Good value|Best look', 'بەهای باش|باشترین شێوە'];
export const LICENCE_WORDS: Words = [
  'يُسمح بالتعديل|للاستخدام الشخصي|لا يُسمح بالتعديل',
  'Remix allowed|Personal use|No remix',
  'دەستکاری ڕێگەپێدراوە|بۆ بەکارهێنانی کەسی|دەستکاری ڕێگەپێنەدراوە',
];
export const FAMILY_WORDS: Words = [
  'حامل|ميدالية مفاتيح|مصباح|لوحة|لوحة تذكارية|مغناطيس|إطار|ديكور|مجسّم|لعبة|علبة|أخرى',
  'Stand|Keychain|Lamp|Sign|Plaque|Magnet|Frame|Decor|Figure|Toy|Box|Other',
  'پایە|زنجیری کلیل|چرا|تابلۆ|تابلۆی یادگاری|موگناتیس|چوارچێوە|ڕازاندنەوە|پەیکەر|یاری|قوتوو|هی تر',
];
export const OCCASION_WORDS: Words = [
  'عيد ميلاد|زفاف|تخرّج|عيد|رمضان|نوروز|رأس السنة|عيد الحب|عيد الأم|مولود جديد|افتتاح',
  "Birthday|Wedding|Graduation|Eid|Ramadan|Newroz|New Year|Valentine's|Mother's Day|New baby|Opening",
  'ڕۆژی لەدایکبوون|زەماوەند|دەرچوون|جەژن|ڕەمەزان|نەورۆز|سەری ساڵ|ڕۆژی خۆشەویستی|ڕۆژی دایک|منداڵی نوێ|کردنەوە',
];
export const RECIPIENT_WORDS: Words = [
  'أطفال|له|لها|زوجان|العائلة|أصدقاء|فريق|معلّم|أعمال',
  'Kids|Him|Her|Couples|Family|Friends|Teams|Teachers|Business',
  'منداڵان|پیاو|ئافرەت|هاوسەران|خێزان|هاوڕێیان|تیم|مامۆستا|بازرگانی',
];

/** One key's word from one list, or '' for a key that is not in it. */
export function word(words: Words, keys: readonly string[], key: string, lang: Lang): string {
  const i = keys.indexOf(key);
  return i < 0 ? '' : words[lang === 'en' ? 1 : lang === 'ckb' ? 2 : 0].split('|')[i] ?? '';
}

/** Every list that has words, by name — `vocabWord` reads them all. */
export const VOCAB = {
  role: [REGION_ROLES, ROLE_WORDS], tone: [TONES, TONE_WORDS], look: [LOOKS, LOOK_WORDS], style: [STYLES, STYLE_WORDS], theme: [THEMES, THEME_WORDS],
  kind: [CONTENT_KINDS, KIND_WORDS], target: [TARGET_KEYS, TARGET_WORDS], photo: [PHOTO_MODES, PHOTO_WORDS], logo: [LOGO_MODES, LOGO_WORDS],
  icon: [ICON_KEYS, ICON_WORDS], tier: [TIERS, TIER_WORDS], licence: [LICENCES, LICENCE_WORDS], family: [FAMILIES, FAMILY_WORDS],
  occasion: [OCCASIONS, OCCASION_WORDS], recipient: [RECIPIENTS, RECIPIENT_WORDS],
} as const;
export type VocabName = keyof typeof VOCAB;

export function vocabWord(name: VocabName, key: string, lang: Lang): string {
  const [keys, words] = VOCAB[name];
  return word(words, keys, key, lang);
}

/** A palette key's name. */
export function colorWord(key: string, lang: Lang): string {
  const k = key as Swatch;
  if (!SWATCHES.includes(k)) return '';
  return lang === 'ckb' ? SWATCH_NAMES_CKB[k] : SWATCH_NAMES[k][lang === 'en' ? 'en' : 'ar'];
}

/** A slot's kind — the part kind's own word (./parts.ts). */
export const slotKindWord = (kind: PartKind, lang: Lang): string => partKindWord(kind, lang);

/** `occ:<occasion>`, `for:<recipient>` or `biz`. */
export function isTag(tag: unknown): tag is string {
  if (tag === 'biz') return true;
  const m = typeof tag === 'string' ? /^(occ|for):([a-z_]+)$/.exec(tag) : null;
  return !!m && ((m[1] === 'occ' ? OCCASIONS : RECIPIENTS) as readonly string[]).includes(m[2]);
}
