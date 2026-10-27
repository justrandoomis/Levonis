/**
 * THE WORDS OF A REQUEST CARD (community UI plan B2), for RequestListCard and
 * the screens that show one (the community home, the requests board, «طلباتي»).
 *
 * The hub speaks its own state words here rather than importing
 * requests/requestStates.ts, which rides in the request page chunk: a card on
 * the home must not download the request page to say «مفتوح». Each state has a
 * word and a pill tone (kit/display.tsx `StatePill`), so a state is never the
 * colour alone. The owner reads one more: «بانتظار الاختيار» when offers have
 * arrived and the choice is theirs.
 *
 * Counted nouns follow the house rule (src/lib/catalog/copy.ts: 1, 2, 3 to 10,
 * 11 to 99, hundreds), with Latin digits in every language (plan R13): «قطعة
 * واحدة», «قطعتان», «3 قطع», «12 قطعة»; «مرفقان»; and no offers yet is
 * «بانتظار العروض», never «0 عروض». Every word is written in Arabic, English
 * and Sorani (DECISIONS row 183), the Sorani its own.
 */
import type { StateTone } from '../kit/display';

export type CardLang = 'ar' | 'en' | 'ckb';

type Three = Record<CardLang, string>;

interface StateWord {
  word: Three;
  tone: StateTone;
}

const STATES: Readonly<Record<string, StateWord>> = {
  draft: { word: { ar: 'مسودة', en: 'Draft', ckb: 'ڕەشنووس' }, tone: 'done' },
  open: { word: { ar: 'مفتوح', en: 'Open', ckb: 'کراوە' }, tone: 'open' },
  receiving_offers: { word: { ar: 'يستقبل عروضًا', en: 'Receiving offers', ckb: 'وەرگرتنی ئۆفەر' }, tone: 'open' },
  offer_selected: { word: { ar: 'تم اختيار عرض', en: 'Offer chosen', ckb: 'ئۆفەر هەڵبژێردرا' }, tone: 'progress' },
  awarded: { word: { ar: 'تم اختيار عرض', en: 'Offer chosen', ckb: 'ئۆفەر هەڵبژێردرا' }, tone: 'progress' },
  in_progress: { word: { ar: 'قيد التنفيذ', en: 'In progress', ckb: 'لە جێبەجێکردندا' }, tone: 'progress' },
  delivered: { word: { ar: 'تم التسليم', en: 'Delivered', ckb: 'گەیشت' }, tone: 'progress' },
  completed: { word: { ar: 'مكتمل', en: 'Completed', ckb: 'تەواو' }, tone: 'done' },
  disputed: { word: { ar: 'نزاع', en: 'Disputed', ckb: 'ناکۆکی' }, tone: 'cancelled' },
  cancelled: { word: { ar: 'ملغي', en: 'Cancelled', ckb: 'هەڵوەشێنراوە' }, tone: 'cancelled' },
  expired: { word: { ar: 'منتهٍ', en: 'Expired', ckb: 'بەسەرچوو' }, tone: 'cancelled' },
};

/** The owner, with offers waiting on their choice. */
const AWAITING_CHOICE: StateWord = { word: { ar: 'بانتظار الاختيار', en: 'Awaiting your choice', ckb: 'چاوەڕوانی هەڵبژاردنی تۆیە' }, tone: 'waiting' };
/** A state a newer server adds later still reads as words, not a code. */
const UNKNOWN: StateWord = { word: { ar: 'قيد المتابعة', en: 'In progress', ckb: 'لە بەدواداچووندایە' }, tone: 'progress' };

/** The state of a request as a card says it, and the tone of its pill. */
export function requestStateWord(state: string | null | undefined, lang: CardLang, opts: { owner?: boolean; offers?: number } = {}): { word: string; tone: StateTone } {
  const key = String(state ?? '');
  const takesOffers = key === 'open' || key === 'receiving_offers';
  const entry = opts.owner && takesOffers && (opts.offers ?? 0) > 0 ? AWAITING_CHOICE : STATES[key] ?? UNKNOWN;
  return { word: entry.word[lang], tone: entry.tone };
}

interface Forms {
  one: string;
  two: string;
  few: string;
  many: string;
  hundred: string;
  en1: string;
  enN: string;
  ckb: string;
}

function counted(n: number, f: Forms, lang: CardLang): string {
  const count = Math.max(0, Math.floor(n));
  if (lang === 'en') return `${count} ${count === 1 ? f.en1 : f.enN}`;
  if (lang === 'ckb') return `${count} ${f.ckb}`;
  if (count === 1) return f.one;
  if (count === 2) return f.two;
  const r = count % 100;
  if (r >= 3 && r <= 10) return `${count} ${f.few}`;
  if (r >= 11 && r <= 99) return `${count} ${f.many}`;
  return `${count} ${f.hundred}`;
}

const PIECES: Forms = { one: 'قطعة واحدة', two: 'قطعتان', few: 'قطع', many: 'قطعة', hundred: 'قطعة', en1: 'piece', enN: 'pieces', ckb: 'پارچە' };
const ATTACHMENTS: Forms = { one: 'مرفق واحد', two: 'مرفقان', few: 'مرفقات', many: 'مرفقًا', hundred: 'مرفق', en1: 'attachment', enN: 'attachments', ckb: 'هاوپێچ' };
const OFFERS: Forms = { one: 'عرض واحد', two: 'عرضان', few: 'عروض', many: 'عرضًا', hundred: 'عرض', en1: 'offer', enN: 'offers', ckb: 'ئۆفەر' };

/** «قطعة واحدة», «قطعتان», «4 قطع», «12 قطعة». */
export const piecesWord = (n: number, lang: CardLang) => counted(n, PIECES, lang);
/** «مرفق واحد», «مرفقان», «3 مرفقات». */
export const attachmentsWord = (n: number, lang: CardLang) => counted(n, ATTACHMENTS, lang);
/** «بانتظار العروض» at zero, then «عرض واحد», «عرضان», «3 عروض», «12 عرضًا». */
export function offersWord(n: number, lang: CardLang): string {
  if (Math.max(0, Math.floor(n)) === 0) return CARD_WORDS[lang].awaitingOffers;
  return counted(n, OFFERS, lang);
}

export interface CardWords {
  awaitingOffers: string;
  viewRequest: string;
  neededBy: string;
  flexibleTiming: string;
  budget: string;
  budgetHidden: string;
  budgetShown: string;
  estimate: string;
  acceptedBy: string;
  repeat: string;
  /** The glyph tile read aloud when there is no picture: what the job is made with. */
  glyphFdm: string;
  glyphResin: string;
  glyphText: string;
}

export const CARD_WORDS: Readonly<Record<CardLang, CardWords>> = {
  ar: {
    awaitingOffers: 'بانتظار العروض',
    viewRequest: 'عرض الطلب',
    neededBy: 'الموعد المطلوب',
    flexibleTiming: 'مرن في الموعد',
    budget: 'ميزانيتك',
    budgetHidden: 'مخفية عن التجار والعموم',
    budgetShown: 'يراها التجار الذين يمكنهم صنع طلبك، ولا تظهر للعموم',
    estimate: 'تقدير ليفونيس',
    acceptedBy: 'التاجر المختار',
    repeat: 'إعادة الطلب',
    glyphFdm: 'طباعة بالخيوط',
    glyphResin: 'طباعة بالريزن',
    glyphText: 'وصف بلا ملف',
  },
  en: {
    awaitingOffers: 'Awaiting offers',
    viewRequest: 'View request',
    neededBy: 'Needed by',
    flexibleTiming: 'Flexible timing',
    budget: 'Your budget',
    budgetHidden: 'Hidden from merchants and the public',
    budgetShown: 'Seen by the merchants who can make your request, never by the public',
    estimate: 'Levonis estimate',
    acceptedBy: 'Chosen merchant',
    repeat: 'Request again',
    glyphFdm: 'Filament print',
    glyphResin: 'Resin print',
    glyphText: 'Description only',
  },
  ckb: {
    awaitingOffers: 'چاوەڕوانی ئۆفەرە',
    viewRequest: 'داواکارییەکە ببینە',
    neededBy: 'کاتی پێویست',
    flexibleTiming: 'کاتەکەی نەرمە',
    budget: 'بودجەکەت',
    budgetHidden: 'لە بازرگانان و خەڵکی گشتی شاراوەیە',
    budgetShown: 'ئەو بازرگانانە دەیبینن کە دەتوانن داواکارییەکەت دروست بکەن، بۆ خەڵکی گشتی دەرناکەوێت',
    estimate: 'خەمڵاندنی لیڤۆنیس',
    acceptedBy: 'بازرگانی هەڵبژێردراو',
    repeat: 'دووبارە داوای بکەرەوە',
    glyphFdm: 'چاپی فیلامێنت',
    glyphResin: 'چاپی ڕێزن',
    glyphText: 'تەنها وەسف',
  },
};

/** What the neutral media tile draws (plan R3): no request picture is ever public. */
export type RequestGlyph = 'fdm' | 'resin' | 'text';

/** The process glyph of a job: a description with no file, a resin material, else filament. */
export function requestGlyph(r: { file_count?: number | null; material?: string | null }): RequestGlyph {
  if (!r.file_count) return 'text';
  return /resin|ريزن|ڕێزن/i.test(String(r.material ?? '')) ? 'resin' : 'fdm';
}

export const asCardLang = (lang: string): CardLang => (lang === 'en' || lang === 'ckb' ? lang : 'ar');
