/**
 * THE WORDS THE ASSISTANT READS, BY HAND (Iraqi Arabic, MSA, English, Sorani).
 *
 * Everything here is compiled with the same scorer the intent lexicon uses
 * (worker/lib/assistantNlu.ts), so an Arabic stem reaches its clitics on its
 * own («نوزل» reaches «بالنوزل» and «النوزل») and a Latin stem matches a whole
 * token or its prefix only. Nothing is generated; every entry was written for
 * a sentence a customer of a printer shop types.
 */
import type { LexEntry } from '../../assistantNlu';
import type { L3, PartKey, SymptomKey } from '../types';

/**
 * WORDS THAT NAME NOTHING. Dropped from the words left over for a search,
 * never from the evidence for what was asked. «مال» is "of / for» in Iraqi
 * («نوزل مال اي ون» is "a nozzle for the A1"), «اريده» is "I want it", «اكو»
 * is "is there", «هواية» is "a lot". The Sorani column: «بۆ» (for), «دەمەوێ»
 * (I want), «هەیە» (there is), «چی» / «چۆن» (what / how).
 */
export const FILLERS: readonly string[] = [
  // Iraqi and Gulf
  'مال', 'مالت', 'مالة', 'اريد', 'اريده', 'اريدها', 'ابغى', 'ابغي', 'ابي', 'اكو', 'ماكو', 'شنو', 'شلون', 'هواية', 'هوايه',
  'زين', 'كلش', 'عندي', 'عدي', 'صارت', 'صار', 'شكد', 'لو', 'سمحت', 'رجاء', 'ممكن', 'يعني', 'بس', 'هم', 'هسه', 'هسة',
  // MSA and shared
  'هل', 'كم', 'هذا', 'هذه', 'هاي', 'من', 'في', 'على', 'عن', 'الى', 'الي', 'ل', 'يا', 'حق', 'و', 'او', 'أو', 'مع', 'بين',
  'لي', 'لطابعتي', 'عندكم', 'عدكم', 'تبيعون', 'متوفر', 'موجود', 'بكم', 'سعر', 'السعر',
  // English
  'what', 'whats', 'is', 'the', 'a', 'an', 'of', 'for', 'me', 'my', 'i', 'you', 'please', 'do', 'does', 'can', 'much', 'how',
  'and', 'or', 'with', 'want', 'need', 'have', 'any', 'there', 'some', 'price', 'buy', 'search', 'find', 'product', 'products',
  // Sorani
  'بۆ', 'دەمەوێ', 'دەمەوێت', 'دەوێ', 'دەوێت', 'پێویستە', 'هەیە', 'نییە', 'چی', 'چۆن', 'زۆر', 'باشە', 'تکایە', 'لە', 'چەند', 'ئایا', 'من',
  // What Arabic glues to a word and a Latin name cut off it: «لل A1», «بال P1S».
  'ال', 'لل', 'بال', 'وال', 'فال', 'ب', 'ف',
  // «مالتي» (mine), «بيها» (in it), «دا» (Iraqi "is …-ing").
  'مالتي', 'مالي', 'مالته', 'مالها', 'بيها', 'بيه', 'فيها', 'دا', 'طابعتي',
  // «بكم الطابعة نفسها» (the printer itself), «نرخی پرینتەرەکە چەندە» (how much is the printer).
  'نفسها', 'نفسه', 'itself', 'چەندە', 'خۆی',
  // «نوزل اشتريته تو»: Iraqi «تو» / «توه» is "just now", and the purchase and the
  // delivery are the story, not the product («وصلني», «وصلتني» it reached me).
  'تو', 'توه', 'توا', 'اشتريت', 'اشتريته', 'اشتريتها', 'شريت', 'شريته', 'شريتها', 'وصلني', 'وصلتني', 'وصلتلي', 'وصلت',
  // «اي» / «ايه» ("yes", or "which"), «الها» / «اله» ("for it").
  'اي', 'ايه', 'الها', 'اله',
  // English follow-ups on the cards just shown: "how much is it?", "is it in stock?",
  // "how much are they?", "the first one".
  'it', 'its', 'they', 'them', 'are', 'in', 'one', 'ones', 'this', 'that', 'these', 'those',
  // «اريد اغير النوزل»: to change or replace the part is still a question about the part.
  'اغير', 'اغيره', 'ابدل', 'ابدله', 'ابدلها', 'استبدل', 'استبدله', 'تبديل', 'replace', 'change', 'بگۆڕم', 'بیگۆڕم',
  // «طابعة ثري دي», "3D printer", «پرینتەری سێ ڕەهەندی»: the kind of printer, never a product word.
  'ثري', 'تري', 'دي', '3d', 'سێ', 'ڕەهەندی',
  // "my own printer", «پرینتەرەکەی خۆم».
  'own', 'خۆم', 'خۆمە',
  // «اريد نوزل جديد», «نوزل اصلي»: new and genuine describe every product on the shelf; searched, they
  // reach «Like New» open-box printers and a «DIY Kit» instead of the part.
  'جديد', 'جديده', 'اصلي', 'اصليه', 'new', 'original', 'genuine', 'نوێ', 'ڕەسەن',
  // «شي ينظف النوزل», «شتێک بۆ پاککردنەوەی نۆزڵ», «شتی تر هەیە؟», «جۆری تر»: "something", "a kind of".
  'شي', 'شيء', 'something', 'شتێک', 'شتی', 'جۆری', 'هی',
];

/**
 * A PRICE ASKED WITH NO PRODUCT NAMED: "how much?", «شكد؟», «بيش؟», «چەندە؟».
 * After cards, it is the price of the cards just shown.
 */
export const PRICE_ASK: readonly string[] = ['how much', 'شكد', 'بيش', 'بكم', 'چەندە', 'نرخی چەندە'];

/**
 * «طابعتي», "my own printer", «پرینتەرەکەی خۆم» typed as the answer to «which
 * printer?»: the customer means the printer of their own account. A sentence
 * of these words only, with at least one of `mine`.
 */
export const OWN_PRINTER: { readonly mine: readonly string[]; readonly with: readonly string[] } = {
  mine: ['طابعتي', 'مالتي', 'مالي', 'my', 'mine', 'پرینتەرەکەم', 'خۆم', 'خۆمە'],
  with: ['طابعه', 'الطابعه', 'نفسها', 'هي', 'هاي', 'printer', 'own', 'the', 'it', 'its', 'is', 'پرینتەر', 'پرینتەرەکە', 'پرینتەرەکەی', 'هی', 'ئەوە'],
};

/**
 * A PRINTER THE CUSTOMER SAYS THEY HAVE, OWN OR BOUGHT (review round 5.4):
 * «عندي اي ون», «طابعتي A1», «اشتريت اي ون من عندكم», "I have an A1", "my
 * printer is an A1", «A1م هەیە», «پرینتەرەکەم A1ە». Read for one thing only:
 * such a sentence is not «a printer name only» (orchestrator `printerOnly`),
 * so the printer is never offered for sale to the one who has it, and the
 * legacy answer stands, as live. It starts no triage and no flow of its own.
 *
 * Never with a want or a need (`want`: «اريد اي ون مالتي», "I need my own
 * printer", «پرینتەرێکم دەوێ»), a have-not (`negations`: «ماكو عندي», "I
 * don't have a printer", «پرینتەرم نییە»), a question to the shop («عندكم
 * اي ون؟», "do you have the A1?", and «اكو …؟» without «عندي»: `thereIs`),
 * or a price or stock ask: those still show the printer first.
 *
 * `have`: whole words; `phrases`: words in a row. Sorani says "I have" with
 * the clitic «م» on the word before `soraniHave` («A1م هەیە», «پرینتەرێکم
 * هەیە»), and "my printer" with it on a word of `soraniPrinter`
 * («پرینتەرەکەم»): read in ./index.ts `saysOwns`.
 */
export const OWNS_SAID: {
  readonly have: readonly string[];
  readonly phrases: readonly string[];
  readonly soraniHave: readonly string[];
  readonly soraniPrinter: readonly string[];
  readonly want: readonly string[];
  readonly wantPhrases: readonly string[];
  readonly negations: readonly string[];
  readonly thereIs: readonly string[];
  readonly thereIsMine: readonly string[];
} = {
  have: [
    'عندي', 'عدي', 'عندنا', 'طابعتي', 'طابعتنا', 'مالتي', 'مالي', 'مالتنا',
    'اشتريت', 'اشتريته', 'اشتريتها', 'اشترينا', 'اشتريناها', 'شريت', 'شريته', 'شريتها', 'شرينا',
    'my', 'mine', 'own', 'owns', 'bought', 'purchased',
    'خۆم', 'خۆمە', 'کڕیم', 'کڕیمە', 'هەمە',
  ],
  phrases: ['i have', 'i ve', 'we have', 'i got', 'ive got'],
  soraniHave: ['هەیە'],
  soraniPrinter: ['پرینتەر', 'چاپکەر'],
  // A want, a need, or a request ("my own A1 please", «ممكن», «تکایە»).
  want: [
    'اريد', 'اريده', 'اريدها', 'نريد', 'ابي', 'ابغى', 'ابغي', 'احتاج', 'نحتاج', 'محتاج', 'بدي', 'ودي', 'ودنا', 'ممكن', 'رجاء', 'سمحت',
    'want', 'wants', 'wanted', 'need', 'needs', 'looking', 'please', 'pls', 'plz',
    'دەمەوێ', 'دەمەوێت', 'دەوێ', 'دەوێت', 'دەمانەوێ', 'پێویستە', 'پێویستم', 'پێویستمە', 'تکایە',
  ],
  wantPhrases: ['would like', 'i d like', 'id like'],
  negations: [
    'ما', 'ماكو', 'ولا', 'مو', 'مش', 'ليس', 'ليست', 'لست', 'بدون', 'لا',
    'no', 'not', 'dont', 'don', 'doesnt', 'havent', 'haven', 'never', 'without', 'none',
    'نییە', 'نیمە', 'نیە', 'نییەتی',
  ],
  // «اكو اي ون؟», «اكو طابعتي؟»: "is there …?", the Iraqi stock ask; «اكو عندي» (`thereIsMine`) is "I have".
  thereIs: ['اكو'],
  thereIsMine: ['عندي', 'عدي', 'عندنا'],
};

/**
 * A SYMPTOM OR A PART THE CUSTOMER DENIES (review round 5.5): «ماعندي كلوب،
 * عندي خيوط», "it's not clogged, it's stringing", «نۆزڵەکە نەگیراوە، دەزوو
 * دەکات», «ماعندي مشكلة بالنوزل، المشكلة بالبليت», "the nozzle is fine, the
 * problem is the plate", «نۆزڵەکە باشە». The word is not read as the symptom
 * or the part (./index.ts `withoutDenied`):
 *  - with a word of `fine` after it (over `fineSkip`), always;
 *  - with a negation before it (`before`; «ما» only before a word of `have`,
 *    «ما عندي كلوب», never the verb of a symptom «ما يطلع»), over `skip`, the
 *    Sorani «نە» on the word itself, or «نییە» after it (`after`): a symptom
 *    always, whether or not another one is named (review round 5.6: «ماعندي
 *    كلوب» alone names no symptom, and no ticket says «انسداد النوزل»); a part
 *    always, unless the customer only LACKS it («ماعندي بليت», "no plate",
 *    «پلێتم نییە»: `lack`, with no problem word between) and names no other.
 */
export const DENIAL: {
  readonly before: readonly string[];
  readonly beforeHave: readonly string[];
  readonly have: readonly string[];
  readonly skip: readonly string[];
  readonly reach: number;
  readonly fine: readonly string[];
  readonly fineSkip: readonly string[];
  readonly after: readonly string[];
  readonly afterSkip: readonly string[];
  readonly answerNo: readonly string[];
  readonly lack: readonly string[];
  readonly lackHave: readonly string[];
  readonly answerNext: readonly string[];
  readonly problemWords: readonly string[];
  readonly problemBefore: readonly string[];
  readonly problemBeforeHave: readonly string[];
  readonly problemHave: readonly string[];
  readonly problemSkip: readonly string[];
} = {
  before: ['مو', 'مش', 'ماكو', 'ليس', 'ليست', 'بدون', 'not', 'no', 'never', 'isnt', 'isn', 't', 'nt', 'wasnt', 'arent', 'without'],
  // «لا» is not here: «لا، بيها كلوب», «لا عندي كلوب» answer "no" and then say it (review round 5.6).
  beforeHave: ['ما'],
  have: ['عندي', 'عدي', 'عندنا', 'اكو', 'بيها', 'بيه', 'فيها', 'فيه'],
  // "I don't have a clog": «have» is read past too (review round 5.6).
  skip: [
    'عندي', 'عدي', 'عندنا', 'اكو', 'بيها', 'بيه', 'فيها', 'فيه', 'مشكله', 'مشكلة', 'مشاكل', 'a', 'an', 'the', 'any', 'problem', 'issue', 'with',
    'is', 's', 'it', 'its', 'my', 'have', 'has', 'had', 'got',
  ],
  reach: 4,
  fine: ['fine', 'ok', 'okay', 'good', 'alright', 'زين', 'زينه', 'سليم', 'سليمه', 'تمام', 'باشە', 'ساغە'],
  fineSkip: ['is', 's', 'are', 'was', 'هو', 'هي', 'its', 'it'],
  /**
   * THE SORANI NEGATION AFTER THE WORD (review round 5.6): «کلۆگم نییە» ("I
   * have no clog"), «کێشەکە کلۆگ نییە» ("the problem is not a clog»), «گیراوە
   * نییە», «A1م نییە». Right after the word, over `afterSkip` (the clitic «م»
   * a Latin name sheds: «A1م» is read «a1 م»).
   */
  after: ['نییە', 'نیە', 'نەبووە', 'نەبوو', 'نیيە'],
  afterSkip: ['م'],
  /**
   * "No, the nozzle is clogged": a «no» that answers, followed by the thing
   * itself, denies nothing; "not the nozzle" and "no clog" still do.
   */
  answerNo: ['no', 'nope'],
  // A having denied: «ماكو نوزل», "no plate", "without a plate", and "don't have" (`lackHave` with a have-word between).
  lack: ['ماكو', 'no', 'without', 'بدون'],
  lackHave: ['t', 'nt', 'dont', 'doesnt', 'didnt'],
  answerNext: ['the', 'my', 'it', 'its', 'i', 'is', 's'],
  /**
   * A PROBLEM SAID NOT TO BE (review round 5.6): «ما عندي مشكلة بالنوزل بس
   * اريد انظفه», "no problem with the nozzle, I just want to clean it»,
   * «کێشەم نییە». The problem noun under a having denied («ما عندي», «ماكو»,
   * "no", "don't have any") is not the problem cue; "not a problem with the
   * nozzle, it's the plate" and «مو مشكلة» are not read as such a denial.
   */
  problemWords: ['مشكله', 'مشكلة', 'مشاكل', 'مشكل', 'problem', 'problems', 'issue', 'issues', 'کێشە', 'کێشەی', 'کێشەم'],
  problemBefore: ['ماكو', 'no', 'without', 'بدون'],
  problemBeforeHave: ['ما', 't', 'nt', 'dont', 'doesnt', 'didnt'],
  problemHave: ['عندي', 'عدي', 'عندنا', 'اكو', 'بيها', 'بيه', 'فيها', 'فيه', 'have', 'has', 'had', 'got'],
  problemSkip: ['عندي', 'عدي', 'عندنا', 'اكو', 'بيها', 'بيه', 'فيها', 'فيه', 'have', 'has', 'had', 'got', 'a', 'an', 'any', 'real', 'big', 'other'],
};

/**
 * A NEGATION OR A RUN-OUT, LEFT OVER BESIDE A PART: «ما عندي بليت», «خلص
 * الفلامنت», "I have no plate". Never a word to search: «ما» half-matched
 * «ميني» and showed the A1 mini printer (orchestrator `products`, review
 * round 5.5).
 */
export const NOT_SEARCHED: readonly string[] = [
  'ما', 'مو', 'مش', 'لا', 'ماكو', 'خلص', 'خلصت', 'بدون', 'no', 'not', 'dont', 'don', 't', 'none', 'without', 'نییە', 'نیە',
];

/**
 * MAKERS AND LINES OF PARTS, without a digit in their name («E3D», «V6» and
 * «MK8» carry one and are read by their shape). Only such a word, left over
 * after a part question, names a product line that may outrank the printer
 * remembered from earlier: «اكو نوزل E3D؟». A word like «جديد», «ستيل» or
 * "high flow" describes the part and never does.
 */
export const LINE_WORDS: readonly string[] = ['revo', 'obxidian', 'phaetus', 'trianglelab', 'bondtech', 'capricorn', 'microswiss', 'mosquito', 'dragon'];

/**
 * A PURCHASE IN THE PAST is the story of a fault («اشتريت طابعة من عندكم وصار
 * بيها انسداد», I bought a printer from you and it clogged), never a question
 * about buying: these never count as the shopping cue. «من عندكم» is "from
 * you"; «عندكم» alone («عندكم نوزل؟») still asks.
 */
export const PAST_PURCHASE: readonly string[] = [
  'اشتريت', 'اشتريته', 'اشتريتها', 'اشتريتهم', 'اشترينا', 'اشتريناها', 'شريت', 'شريته', 'شريتها', 'شرينا',
  'من عندكم', 'من عدكم', 'منكم', 'bought', 'purchased', 'کڕیم', 'کڕیمە', 'کڕی', 'لە ئێوە',
];
/**
 * THE VERBS OF A PURCHASE TOLD («اشتريت نوزل وما يركب», "the nozzle I bought
 * doesn't fit", «نۆزڵێکم کڕی»): a part named in such a story is the part the
 * customer has, never one to show for sale (./index.ts `purchaseStory`, review
 * round 5.5). «من عندكم» alone is not one: «اريد نوزل من عندكم» shops.
 */
export const PURCHASE_TOLD: readonly string[] = [
  'اشتريت', 'اشتريته', 'اشتريتها', 'اشتريتهم', 'اشترينا', 'اشتريناها', 'شريت', 'شريته', 'شريتها', 'شرينا',
  'bought', 'purchased', 'کڕیم', 'کڕیمە', 'کڕی',
];

/**
 * «لا قصدي بي ون اس» — "no, I mean the P1S": the customer corrects the
 * printer of the question just answered. Also fillers: they name nothing.
 */
export const CORRECTION_WORDS: readonly string[] = ['لا', 'قصدي', 'اقصد', 'قصدت', 'مو', 'no', 'mean', 'meant', 'نەخێر', 'مەبەستم'];

/** «الاول بكم» — which of the products just shown. 0 is the first. */
export const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  'الاول': 0, 'اول': 0, 'الاولى': 0, 'اولى': 0, 'first': 0, 'یەکەم': 0, 'یەکەمیان': 0,
  'الثاني': 1, 'ثاني': 1, 'الثانيه': 1, 'second': 1, 'دووەم': 1, 'دووەمیان': 1,
  'الثالث': 2, 'ثالث': 2, 'الثالثه': 2, 'third': 2, 'سێیەم': 2, 'سێیەمیان': 2,
};

/** At the triage's «which printer?»: «طابعة أخرى», "another one", or a maker the shop does not list. */
export const OTHER_PRINTER: LexEntry = {
  phrases: ['طابعه اخرى', 'طابعه ثانيه', 'غير طابعه', 'other printer', 'another printer', 'پرینتەرێکی تر'],
  // Sorani «تر» ("other"): «شتی تر هەیە؟», «جۆری تر», «هی تر», read only as a whole word.
  stems: ['اخرى', 'غيرها', 'other', 'another', 'تر'],
};

/**
 * THE OUTCOME OF THE STEPS, TYPED («جربتها وما انحلّت», "still not fixed").
 * The not-fixed list is read first: it carries the negation of the fixed one.
 * Whole phrases between gaps, after `normalizeText` (so «انحلّت» is «انحلت»,
 * and an apostrophe is a gap). A bare "still" or «هێشتا» (still, yet) is never
 * one: «هێشتا تاقیم نەکردۆتەوە» is "not tried yet", and "still waiting for
 * the needle" a wait (review round 4.3). With a fault, a problem or sameness
 * after it, it is (`STILL_AT_FAULT`, review round 5.4).
 */
export const OUTCOME_NOT_FIXED: readonly string[] = [
  'ما انحلت', 'ما انحل', 'ما انحلت المشكله', 'مانحلت', 'ما حلت', 'ما زبطت', 'ما زبط', 'ما نفعت', 'ما نفع', 'ما فادت', 'ما فاد',
  'ما اشتغلت', 'ما اشتغل', 'لم تنحل', 'لم تحل', 'نفس المشكله', 'نفس الشي', 'بعدها نفس', 'بعده نفس', 'بعدها مسدود', 'بعده مسدود',
  'بعدها مسدوده', 'بعده مسدوده',
  'not fixed', 'didnt work', 'did not work', "didn't work", 'didnt help', 'did not help', "didn't help", 'same problem', 'same issue',
  'no luck',
  'still not', 'still clogged', 'still blocked', 'still jammed', 'still stuck', 'still stringing', 'still leaking', 'still broken',
  'still the same', 'still same', 'still happening', 'still there', 'still having', 'still has', 'still doesnt', "still doesn't",
  'still does not', 'still didnt', "still didn't", 'still did not', 'still wont', "still won't", 'still isnt', "still isn't",
  'still is not', 'still cant', "still can't", 'still cannot',
  'چارەسەر نەبوو', 'چارەسەر نەبووە', 'هەمان کێشە', 'هەمان کێشەیە', 'سوودی نەبوو', 'کاری نەکرد', 'هێشتا کار ناکات', 'هێشتا گیراوە',
  'هێشتا هەروایە', 'هێشتا ماوە',
  // The common whole forms with «still» / «هێشتا» (review round 5).
  'still happens', 'still clogs', 'still bad', 'still getting', 'but still',
  'هێشتا کێشەکە هەیە', 'هێشتا کێشە هەیە', 'هێشتا چاک نەبووە', 'هێشتا کارناکات', 'هێشتا ئیش ناکات', 'هێشتا هەمان', 'بەڵام هێشتا',
];
/**
 * «still», «nope, still», «نەخێر هێشتا» as the WHOLE reply to the steps: not
 * fixed. Never as a part of a longer sentence («still waiting for the
 * needle», «هێشتا تاقیم نەکردۆتەوە»), which only `OUTCOME_NOT_FIXED` reads.
 */
export const OUTCOME_NOT_FIXED_ALONE: readonly string[] = [
  'still', 'nope still', 'no still', 'yes still', 'yeah still', 'هێشتا', 'نەخێر هێشتا', 'نا هێشتا', 'بەڵێ هێشتا',
];
/**
 * «STILL» / «هێشتا» AND A FAULT, A PROBLEM OR SAMENESS within `reach` words
 * after it (review round 5.4): "still jamming", "still a problem", "it still
 * persists", "still doing it", "still nothing comes out", «هێشتا کێشەی هەیە»,
 * «هێشتا هەر وایە», «هێشتا خراپە», «هێشتا نۆزڵەکە گیراوە» are not fixed. Never
 * beside a wait (`waits`: "still waiting for a part", «هێشتا چاوەڕێی
 * پارچەکەم»); the steps not tried («هێشتا تاقیم نەکردۆتەوە», "I still haven't
 * tried them") are read before it and have no outcome.
 *
 * `stems` match a word or its beginning ("jam" is "jams" and "jamming",
 * «کێشە» is «کێشەی»); `whole` only the whole word ("no" is never "nozzle");
 * `phrases` the words in a row ("doing it", never "doing the steps").
 */
export const STILL_AT_FAULT: {
  readonly still: readonly string[];
  readonly reach: number;
  readonly stems: readonly string[];
  readonly whole: readonly string[];
  readonly phrases: readonly string[];
  readonly waits: readonly string[];
} = {
  still: ['still', 'هێشتا'],
  reach: 3,
  stems: [
    'jam', 'fail', 'problem', 'issue', 'persist', 'occur', 'happen', 'clog', 'block', 'stuck', 'string', 'leak', 'broke', 'wrong',
    'error', 'same', 'nothing',
    'کێشە', 'خراپ', 'گیراو', 'داخراو', 'تێکچوو', 'هەروا', 'ناکات', 'ناکا', 'نایەت', 'هەڵە',
  ],
  whole: ['no', 'bad', 'worse', 'هەر', 'وایە', 'هەمان'],
  phrases: ['doing it', 'doing that', 'does it', 'does that', 'doing the same'],
  waits: ['wait', 'waiting', 'awaiting', 'چاوەڕێ', 'چاوەڕێی', 'چاوەڕێم', 'چاوەڕوان', 'چاوەڕوانم', 'انتظر', 'بانتظار', 'منتظر', 'انتظار'],
};
/**
 * THE STEPS NOT TRIED («بعدني ما جربتها», "I still have not tried them",
 * «هێشتا تاقیم نەکردۆتەوە»): no outcome at all, read before both lists. The
 * steps were only shown, and a ticket never says they were tried (review
 * round 4.3). «بعدني ما» alone is not here: «بعدني ما انحلت» is "still not
 * fixed", and «بعدني ما جربتها» is read by «ما جربتها» (review round 5.4).
 */
export const OUTCOME_NOT_TRIED: readonly string[] = [
  'ما جربت', 'ما جربتها', 'ما جربته', 'ما جربتهم', 'ماجربت', 'ماجربتها', 'لم اجرب', 'لم اجربها', 'لم اجربهم',
  'ما طبقتها', 'ما سويتها',
  // The other objects of the same verbs, which «بعدني ما» used to cover («بعدني ما سويتهم»).
  'ما جربتهن', 'ما سويته', 'ما سويتهم', 'ما سويتهن', 'ما طبقته', 'ما طبقتهم', 'ما طبقتهن',
  "haven't tried", 'havent tried', 'have not tried', 'not tried', "didn't try", 'didnt try', 'did not try', "haven't yet",
  'havent yet', 'have not yet', 'not yet tried', 'yet to try',
  'تاقیم نەکردۆتەوە', 'تاقیم نەکردووەتەوە', 'تاقیم نەکردوەتەوە', 'تاقیم نەکردووە', 'تاقیم نەکردەوە', 'تاقیم نەکردنەوە',
  'تاقیمان نەکردۆتەوە', 'تاقیمان نەکردەوە', 'تاقی نەکراوەتەوە',
];
/**
 * "NOT YET" BESIDE «بعد ما»: «لهسه بعد ما جربتها», «بعد ما جربتهن لحد الان»
 * can only mean "I have not tried them yet", so «بعد ما» is not "after" in a
 * sentence with one of these (./index.ts `afterNotNegation`, review round 5.5).
 */
export const NOT_YET_WORDS: readonly string[] = ['لهسه', 'للحين', 'لحد', 'لسه', 'لحين', 'هسه'];

/**
 * THE STEPS SAID TO BE TRIED («جربتها», "tried them", «تاقیم کردەوە»): only
 * with one of `verbs`, no word of `negations` before it («ما سويتها», "have
 * not done them", "not yet tried"; the Sorani negation is in the verb itself,
 * «نەمکردووە»), and none of `negatedAfter` right after a verb that ends in an
 * auxiliary ("I did not"). A not-fixed reply without one («نفس المشكله»,
 * "still clogged", «هێشتا گیراوە») says nothing of trying: the ticket lists
 * the steps as shown, never as tried (review round 5).
 *
 * THE NEGATION MAY STAND FURTHER OFF (review round 5.2). Up to three words
 * back, over the words of `adverbs` ("I have not really tried them", «ما بعد
 * جربتها»); «ولا» and one word before the verb («ولا خطوة جربتها», not one
 * step); a word of `none` before the verb ("nothing done") or right after a
 * verb with no object of its own ("I did nothing", "tried none", «سويت ولا
 * شي»), unless a word of `clause` follows it ("tried, nothing changed"). A
 * reply that names only some of the steps (`partial`, or an ordinal: "the
 * first one only", «الاولى بس») never says all of them were tried.
 *
 * THE OBJECT IS THE STEPS (review round 5.4). A verb of `bare` (no object of
 * its own: "tried", «جربت», "I did") counts only when its object means the
 * steps (`objects`, over `determiners`: "tried them", "the steps",
 * «الخطوات», «كلشي»; a demonstrative only with a steps word or the end of
 * its clause after it: "did that, still …", never "that new filament") or
 * when its clause ends there (`clauseStart`, read with «و» taken off the next
 * word: "I tried, still clogged", «جربت بس نفس المشكله», «جربت وما زبطت»;
 * never «جربت ويه بكره ثانيه» or «جربت وحده منهن», review round 5.5). Never
 * with a gerund, a verb or another noun after it ("tried printing again",
 * «حاولت اطبع», "I did a cold pull", «سويت تنظيف»). A "did …" verb that
 * carries its object ("did that") is not one when a word other than
 * `afterObject` or a clause start follows it: "did that help?" asks. No
 * English verb counts after a third-person subject (`thirdPerson`: "it did
 * that again", "the printer did that again"). The Arabic forms with the clitic
 * («جربتها», «سويتهم») carry their object. Sorani puts the object before the
 * verb (`soraniVerbs`): one counts with nothing before it, the steps
 * («هەموویم تاقی کردەوە») or a clause word (`soraniBefore`), never another
 * noun («فیلامێنتێکی ترم تاقی کردەوە», "I tried another filament").
 */
export const TRIED_SAID: {
  readonly verbs: readonly string[];
  readonly soraniVerbs: readonly string[];
  readonly soraniBefore: readonly string[];
  readonly negations: readonly string[];
  readonly auxiliaries: readonly string[];
  readonly negatedAfter: readonly string[];
  readonly adverbs: readonly string[];
  readonly notEven: readonly string[];
  readonly none: readonly string[];
  readonly bare: readonly string[];
  readonly clause: readonly string[];
  readonly partial: readonly string[];
  readonly objects: readonly string[];
  readonly determiners: readonly string[];
  readonly demonstratives: readonly string[];
  readonly stepsWords: readonly string[];
  readonly clauseStart: readonly string[];
  readonly afterObject: readonly string[];
  readonly thirdPerson: readonly string[];
  readonly contractions: readonly string[];
  readonly passive: readonly string[];
  readonly relatives: readonly string[];
  readonly subjects: readonly string[];
  readonly subjectSkip: readonly string[];
  readonly beforeSubject: readonly string[];
  readonly subjectAdverbs: readonly string[];
  readonly singular: readonly string[];
  readonly singularObjects: readonly string[];
  readonly things: readonly string[];
  readonly stepNumbers: readonly string[];
  readonly stepWords: readonly string[];
  readonly soraniWith: readonly string[];
  readonly soraniAfterClause: readonly string[];
} = {
  verbs: [
    'جربت', 'جربتها', 'جربته', 'جربتهم', 'جربنا', 'جربناها', 'سويت', 'سويتها', 'سويته', 'سويتهم', 'سوينا', 'سويناها', 'طبقت', 'طبقتها',
    'طبقته', 'طبقتهم', 'عملتها', 'عملتهم', 'نفذت', 'نفذتها', 'نفذتهم', 'اتبعت', 'اتبعتها', 'حاولت', 'مسويها', 'مجربها',
    // The Iraqi plural clitic «ـهن» (review round 5.2).
    'جربتهن', 'سويتهن', 'طبقتهن', 'نفذتهن', 'عملتهن', 'مسويهن', 'مجربهن', 'جربناهن', 'سويناهن',
    'tried', 'i did', 'we did', 'did them', 'did it', 'did all', 'did those', 'did everything', 'did every', 'did each', 'done',
    'followed', 'applied', 'went through', 'did that', 'did these', 'did this', 'gave it a try', 'gave them a try', 'gave it a go',
    // "after trying them, still clogged" (review round 5.4); "still trying" is not here: it is not done.
    'after trying', 'after doing', 'after following', 'after applying',
  ],
  // Sorani puts the object BEFORE the verb: these count with nothing, a steps word or a clause word before them (`soraniBefore`).
  soraniVerbs: [
    'تاقیم کردەوە', 'تاقیمکردەوە', 'تاقیم کردنەوە', 'تاقیم کرد', 'تاقیمان کردەوە', 'کردم', 'کردمن', 'کردمە', 'هەمووم کرد',
    'جێبەجێم کرد', 'ئەنجامم دا',
    // Without the clitic on the verb («هەموویم تاقی کردەوە»), glued, and plural (review round 5.2).
    'تاقی کردەوە', 'تاقیمکردنەوە', 'جێبەجێم کردن', 'ئەنجامم دان',
  ],
  // Before a Sorani verb: the steps («هەموویم», «هەنگاوەکان», «ئەوانە») or a clause word («بەڵام», «ئەوەی» of «دوای ئەوەی»); never another noun.
  // Never «و», «کە», «ئەوە» or «ئەوەم» (review round 5.5): the object stands before them, so «نۆزڵێکی نوێم کڕی و تاقیم
  // کردەوە» tried the new nozzle, «ئەو قرقرەیەی کە تاقیم کردەوە» is the spool, and «ئەوەم» "that one" (a filament).
  soraniBefore: [
    'هەموو', 'هەمووی', 'هەمووم', 'هەموویم', 'هەموویان', 'هەمووشیان', 'هەمووشم', 'هەنگاوەکان', 'هەنگاوەکانم', 'هەنگاوەکانیش',
    'ئەوانە', 'ئەوانەم', 'ئەمانە', 'ئەمانەم',
    'بەڵام', 'من', 'منیش', 'ئێمە', 'بەڵێ', 'نەخێر', 'نا',
  ],
  // «ما», «لم», «مو», «ولا»; the English ones, and «t», the end of "haven t" once the apostrophe is a gap.
  negations: [
    'ما', 'لم', 'مو', 'مش', 'ولا', 'not', 'never', 't', 'nt', 'haven', 'havent', 'hasn', 'hasnt', 'didn', 'didnt', 'dont', 'yet',
    'nothing', 'none',
  ],
  auxiliaries: ['did'],
  negatedAfter: ['not', 'nt', 'never'],
  // Between a negation and its verb: "not really tried", "never even did", «ما بعد جربتها», «ما حتى سويتها».
  adverbs: ['even', 'really', 'actually', 'yet', 'ever', 'still', 'just', 'quite', 'fully', 'properly', 'بعد', 'حتى', 'اصلا', 'ابد', 'ابدا', 'للحين'],
  // «ولا خطوة جربتها»: «ولا» and the one word it negates, before the verb.
  notEven: ['ولا'],
  // "did nothing", "tried none", "done anything", «سويت شي», «سويت ولا شي».
  none: ['nothing', 'none', 'anything', 'شي', 'شيء', 'ولا'],
  // The verbs with no object of their own: never "did it" or «جربتها», which carry their own.
  bare: [
    'جربت', 'جربنا', 'سويت', 'سوينا', 'طبقت', 'نفذت', 'اتبعت', 'حاولت', 'tried', 'i did', 'we did', 'done',
    'followed', 'applied', 'went through', 'after trying', 'after doing', 'after following', 'after applying',
  ],
  // "tried, nothing changed", «جربت ولا شي تغير»: the word of `none` starts its own clause.
  clause: [
    'changed', 'change', 'worked', 'works', 'work', 'happened', 'helped', 'helps', 'fixed', 'improved',
    'تغير', 'تغيرت', 'صار', 'صارت', 'اشتغل', 'اشتغلت', 'زبط', 'زبطت', 'فاد', 'فادت', 'نفع', 'نفعت', 'انحل', 'انحلت',
  ],
  // Only some of the steps: "only", "just one", "one of them", «بعضها», «یەکێکیان», «تەنها»; the ordinals are read too.
  // "all but one", "except the last", «وحده منهن», «عدا الاخيرة», «جگە لە» (review round 5.5).
  partial: [
    'only', 'just one', 'one of them', 'some of them', 'a few', 'but one', 'except', 'apart from', 'other than',
    'بعضها', 'بعض', 'عدا', 'الا', 'غير', 'منهن', 'منها', 'منهم', 'یەکێکیان', 'هەندێکیان', 'تەنها', 'جگە لە',
    // «ماعدا» typed as one word, «بێجگە» the common spelling, and the last step named: "but not the last one",
    // «بس مو الاخيره», «دوایینیان نا» (review round 5.6).
    'ماعدا', 'بێجگە', 'the last', 'last one', 'last step', 'الاخيره', 'الاخير', 'دوایینیان', 'دوایینەکە',
  ],
  // The objects of a `bare` verb that mean the steps: "tried them", "did everything", «جربت الخطوات», «سويت كلشي».
  objects: [
    'them', 'it', 'all', 'everything', 'both', 'each', 'those', 'these', 'that', 'this',
    'الخطوات', 'خطوات', 'الخطوه', 'خطوه', 'كلشي', 'كلها', 'كلهم', 'كل', 'الكل', 'جميعها', 'جميعهم', 'جميع', 'الحلول', 'حلول',
    'اياها', 'اياهم', 'ياها', 'ياهم', 'هاي', 'هذا', 'هذي', 'هذه', 'هذول',
  ],
  // Read past, before the object: "the steps", "your instructions", "every step".
  determiners: ['the', 'your', 'ur', 'every'],
  // An object only with a steps word or the end of its clause after it: "did that, still …", «جربت هاي الخطوات».
  demonstratives: ['those', 'these', 'that', 'this', 'هاي', 'هذا', 'هذي', 'هذه', 'هذول'],
  stepsWords: [
    'steps', 'step', 'instructions', 'suggestions', 'solutions', 'fixes', 'fix', 'guide', 'above',
    'الخطوات', 'خطوات', 'الخطوه', 'خطوه', 'الحلول', 'حلول', 'الطريقه', 'الطرق',
  ],
  // The first word of the next clause: "I tried, still clogged", «جربت بس نفس المشكله», «جربت ما زبطت».
  // Never «هم» (also), "yet", "now", "so" or "then": after a bare verb they start its object or an adverb, «جربت هم طريقه
  // ثانيه», "tried yet another spool", "tried now with PETG" (review round 5.5).
  clauseStart: [
    'still', 'but', 'and', 'same', 'no', 'nope', 'not', 'nothing', 'though', 'however',
    'بس', 'لكن', 'بعدين', 'ما', 'لا', 'مو', 'نفس', 'بعدها', 'بعده', 'بعدني', 'للاسف', 'مازال', 'لازال', 'لسه',
    'هێشتا', 'بەڵام', 'کەچی',
    // The intransitive verbs of an outcome: «جربت صار نفس الشي», «جربت تغير شي؟».
    'changed', 'worked', 'happened', 'helped', 'fixed', 'improved',
    'تغير', 'تغيرت', 'صار', 'صارت', 'اشتغل', 'اشتغلت', 'زبط', 'زبطت', 'فاد', 'فادت', 'نفع', 'نفعت', 'انحل', 'انحلت',
  ],
  // What may follow a "did …" verb that carries its object: "did it again", "did them all"; "did that help?" asks.
  afterObject: ['again', 'too', 'also', 'already', 'twice', 'all', 'both', 'properly', 'exactly', 'carefully', 'myself'],
  // Not the customer: "it did that again", "the printer did that again", "my A1 did it again", "the print did it
  // again" (the printer names are read too, ./index.ts; review round 5.5).
  thirdPerson: [
    'it', 'he', 'she', 'they', 'printer', 'machine', 'nozzle', 'hotend', 'extruder', 'ams',
    'print', 'prints', 'job', 'filament', 'spool', 'roll', 'one', 'plate', 'bed', 'part',
    // "the toolhead did it again", "my Bambu did it again", "the X1 Carbon did it again" (review round 5.6).
    'toolhead', 'head', 'device', 'thing', 'unit', 'bambu', 'lab', 'carbon', 'mini', 'pro', 'combo',
  ],
  // "it's done that", "it has done it": read past to the subject.
  contractions: ['s', 'has', 'had', 'just'],
  // "the print was done": a passive «done» says nothing of the customer (review round 5.5).
  passive: ['is', 'was', 'were', 'are', 'be', 'been', 'being', 'got', 'get', 'gets'],
  // «النوزل الجديد اللي جربته»: a verb in a relative clause tries its noun, never the steps (review round 5.5).
  relatives: ['اللي', 'الي', 'اللى', 'الذي', 'التي', 'يلي'],
  /**
   * "the other roll I tried still jams": a bare verb whose subject «I» / «we»
   * stands right after a noun is a relative clause, and its object is that
   * noun. Read past `subjectSkip` to the subject; the word before it must be
   * none, or one of `beforeSubject` ("yes, I tried", "ok I tried") (review round 5.5).
   */
  subjects: ['i', 'we'],
  subjectSkip: ['have', 've', 'had', 'd', 'just', 'already', 'also', 'both', 'really', 'actually'],
  beforeSubject: [
    'yes', 'yeah', 'yep', 'yup', 'ya', 'ok', 'okay', 'sure', 'well', 'so', 'and', 'but', 'also', 'already', 'then', 'now',
    'no', 'nope', 'still', 'actually', 'honestly', 'hi', 'hey', 'hello', 'sorry', 'oh', 'ah', 'um', 'hmm',
  ],
  /**
   * BETWEEN A SUBJECT AND ITS "did" OR "done" (review round 5.6): "the printer
   * also did it again", "it really did it again". Read past to the subject. A
   * "did …" or "done" counts only with «I» / «we», no subject at all, or a word
   * of `beforeSubject` before it: never the printer, the toolhead, «Bambu».
   */
  subjectAdverbs: ['also', 'really', 'then', 'again', 'even', 'once', 'always', 'still', 'actually', 'just', 'already', 'have', 've', 'has', 's', 'had', 'd'],
  /**
   * «جربته», «سويته», «طبقته»: the object «ـه» is one thing, masculine, never
   * the steps («ـها», «ـهم», «ـهن»): «بدلت النوزل وجربته», «النوزل الجديد
   * جربته» tried the nozzle (review round 5.6).
   */
  singular: ['جربته', 'سويته', 'طبقته', 'نفذته', 'جربناه', 'سويناه'],
  /**
   * "I changed the nozzle and tried it", "the new nozzle, I tried it": «it»,
   * «that», «this» after a part or a filament named before the verb in the
   * same message is that thing, never the steps (`things`, and the parts).
   */
  singularObjects: ['it', 'that', 'this'],
  things: ['filament', 'spool', 'roll', 'reel', 'pla', 'petg', 'abs', 'tpu', 'asa', 'firmware', 'one'],
  /** "steps 1 and 2", "step one", «الخطوه 2»: only some steps, by number. */
  stepNumbers: ['1', '2', '3', '4', 'one', 'two', 'three', 'four', 'یەک', 'دوو', 'سێ'],
  stepWords: ['step', 'steps', 'خطوه', 'الخطوه', 'خطوات', 'الخطوات', 'هەنگاو', 'هەنگاوی'],
  /**
   * «تاقیم کردەوە لەگەڵ نۆزڵێکی نوێ», «تاقیم کردەوە بە فیلامێنتێکی تر»: "I
   * tried WITH a new nozzle": what was tried follows, never the steps.
   */
  soraniWith: ['لەگەڵ', 'بە'],
  /** «دوای ئەوەی تاقیم کردنەوە» ("after I tried them"); «ئەوەی» alone opens "what I tried was …" (review round 5.6). */
  soraniAfterClause: ['دوای ئەوەی', 'پاش ئەوەی'],
};
export const OUTCOME_RESOLVED: readonly string[] = [
  'انحلت', 'انحل', 'انحلت المشكله', 'زبطت', 'زبط', 'اشتغلت', 'اشتغل', 'صارت زينه', 'صار زين', 'رجعت تشتغل', 'رجعت زينه',
  'fixed', 'solved', 'it works', 'works now', 'that fixed it', 'چارەسەر بوو', 'باش بوو', 'کاری کرد',
];

/** A shopping question, as opposed to a report of a fault. */
export const PRODUCT_CUE: LexEntry = {
  phrases: [
    'ابحث عن', 'دور على', 'اريد اشتري', 'do you have', 'i want to buy', 'maintenance products', 'maintenance product', 'گەڕان بۆ',
    'دەمەوێ بیکڕم',
  ],
  // "product" is the English «منتج»: "I need maintenance products for a faulty nozzle" shops, as the Arabic does.
  stems: [
    'بحث', 'ابحث', 'منتج', 'منتجات', 'اشتري', 'اشتريه', 'عندكم', 'عدكم', 'تبيعون', 'سعر', 'اسعار', 'بكم', 'متوفر', 'موجود',
    'search', 'buy', 'price', 'stock', 'available', 'product', 'products', 'گەڕان', 'بەرهەم', 'نرخ', 'بکڕم', 'بەردەست',
  ],
};

/**
 * «مشكلة», «خلل», «عطل», «ما تشتغل», «ما تطبع», «وكفت» — something is wrong.
 * The Iraqi progressive «دا» («ما دا تشتغل») comes off before these are read
 * (./index.ts `dropProgressive`).
 */
export const PROBLEM_CUE: LexEntry = {
  phrases: [
    'ما تشتغل', 'ما يشتغل', 'لا تعمل', 'لا يعمل', 'not working', 'does not work', 'doesnt work', 'كار ناكات', 'کار ناکات',
    'ما يسحب', 'ما تسحب', 'not feeding', 'does not feed', 'doesnt feed',
    'ما تطبع', 'ما يطبع', 'لا تطبع', 'لا يطبع', 'not printing', 'does not print', 'doesnt print', 'wont print', "won't print",
    'stopped working', 'stopped printing', 'چاپ ناکات', 'چاپ ناکا',
    // "something is wrong with my printer", "help, my printer stopped", "it is acting up". The printer is
    // the subject: a bare "wrong with", "not right", "has stopped" or "it stopped" is as often an order
    // ("my A1 order has stopped") or a choice ("is the P1S not right for beginners?"), and "something is
    // wrong" beside an order, a delivery or a return is the account question (`ACCOUNT_WORDS`).
    'something wrong', 'something is wrong', 'somethings wrong', 'wrong with my printer', 'wrong with the printer', 'acting up',
    'acting weird', 'printer stopped', 'printer has stopped', 'printer just stopped', 'printer keeps stopping',
  ],
  stems: [
    'مشكل', 'مشاكل', 'عطل', 'خلل', 'خربان', 'خربانه', 'عاطل', 'وكفت', 'واكفه', 'problem', 'problems', 'issue', 'broken', 'fault',
    'کێشە', 'کێشەی', 'تێکچووە', 'خراپە',
  ],
};

/**
 * AN ORDER, A DELIVERY, A RETURN, A WARRANTY, A PAYMENT OR A PURCHASE, named
 * beside a fault word: «عندي مشكلة بطلبية الاي ون», "something is wrong with
 * my A1 order", "the delivery of my P1S has stopped", "I want to return my A1,
 * something is wrong with it". The fault word is about the account then, so
 * the printer triage does not start and the account handlers answer.
 *
 * Whole words, read after the Arabic article and the glued prepositions come
 * off («بطلبية», «بالضمان», «للتوصيل»). A purchase or an arrival in the PAST
 * («اشتريت», «وصلتني», "bought", "ordered", "arrived") is the story of a
 * fault, not a question about the account, and is deliberately not here:
 * «اي تو وصلتني الطابعة وبيها مشكلة» is still the triage.
 */
export const ACCOUNT_WORDS: readonly string[] = [
  // The order: «طلبية» is the Iraqi word, «اوردر» the loanword, «داواکاری» the Sorani.
  'order', 'orders', 'طلب', 'طلبي', 'طلبيه', 'طلبيتي', 'طلبات', 'طلباتي', 'طلبياتي', 'اوردر',
  'داواکاری', 'داواکارییەکەم', 'داواکاریەکەم', 'داواکارییەکە', 'داواکارییەکەی',
  // The delivery.
  'delivery', 'deliveries', 'shipping', 'shipment', 'توصيل', 'شحن', 'شحنه', 'شحنتي', 'گەیاندن', 'گەیاندنی', 'گەیاندنەکە',
  // A return or a refund.
  'return', 'returns', 'returning', 'refund', 'refunds', 'ارجاع', 'ارجع', 'ارجعها', 'ارجعه', 'ترجيع', 'استرجاع', 'استرداد',
  'گەڕاندنەوە', 'گەڕاندنەوەی', 'بیگەڕێنمەوە',
  // The warranty.
  'warranty', 'guarantee', 'ضمان', 'ضماني', 'كفاله', 'كفالتي', 'گەرەنتی', 'گەرەنتییەکە', 'گەرەنتییەکەی',
  // The payment.
  'payment', 'payments', 'pay', 'paid', 'invoice', 'receipt', 'دفع', 'دفعت', 'فاتوره', 'فاتورتي', 'پارەدان', 'پارەدانەکە', 'پسوولە',
  // An exchange, a return asked, a cancel (review round 5.6): «ابي استرجع البليت», «ممكن ابدل البليت بغيره», "can I
  // exchange the hotend", "cancel my nozzle order", «دەمەوێت نۆزڵەکە بگەڕێنمەوە», «دەمەوێت پلێتەکە بگۆڕمەوە».
  'استرجع', 'استرجعه', 'استرجعها', 'ارجاعه', 'ابدل', 'ابدله', 'ابدلها', 'استبدل', 'استبدله', 'استبدلها', 'استبدال',
  'الغي', 'الغيه', 'الغيها', 'الغاء',
  'exchange', 'exchanged', 'exchanging', 'cancel', 'cancelled', 'canceled', 'cancellation', 'refunded',
  'بگەڕێنمەوە', 'بگۆڕمەوە', 'بیگۆڕمەوە', 'گۆڕینەوە', 'گۆڕینەوەی', 'هەڵوەشاندنەوە', 'هەڵوەشاندنەوەی',
];
/**
 * «شراء», "buying": an account word beside a fault ("what is wrong with buying
 * the A1 mini?"), but a shopping one beside a part («اريد شراء نوزل»), so
 * never an after-sale question (./index.ts `afterSale`).
 */
export const ACCOUNT_BUYING: readonly string[] = ['buying', 'purchase', 'purchasing', 'شراء', 'کڕین'];
/**
 * AFTER THE SALE, IN WORDS IN A ROW (review round 5.6): "I received the wrong
 * nozzle", «پلێتەکە شکاو گەیشت» (it arrived broken), «الهوت اند مالتي وين صار»
 * (where has it got to). «وصلتني» or "arrived" alone is the story of a fault
 * and is not here.
 */
export const ACCOUNT_PHRASES: readonly string[] = [
  'received the wrong', 'got the wrong', 'sent the wrong', 'sent me the wrong', 'wrong item', 'arrived broken', 'arrived damaged',
  'came broken', 'has not arrived', 'hasnt arrived', 'did not arrive', 'didnt arrive', 'never arrived', 'not arrived',
  'وين صار', 'وين صارت', 'وين وصل', 'وين وصلت', 'وصل مكسور', 'وصلني مكسور', 'وصلتني مكسوره', 'وصلني غلط', 'وصلتني غلط',
  'شکاو گەیشت', 'شکاوی گەیشت', 'شکاو گەیشتووە', 'شکاو هات',
];

/**
 * A FAULT THE CURATED STEPS DO NOT COVER: a leak, a printer that does not heat.
 * It is a problem (the triage asks which printer), but it is not a clog, so
 * the part it names does not pick the clog steps for it: the customer picks
 * the symptom, or «أخرى», and the team gets the rest.
 */
export const FAULT_CUE: LexEntry = {
  phrases: ['ما تسخن', 'ما يسخن', 'لا تسخن', 'لا يسخن', 'not heating', 'does not heat', 'doesnt heat', 'گەرم نابێت', 'گەرم نابێتەوە'],
  stems: ['تسريب', 'يسرب', 'تسرب', 'يخر', 'leak', 'leaks', 'leaking', 'دزەدەکات', 'دزە'],
};

/** «الطابعة», «printer», «پرینتەر». A named model is a printer cue too. */
export const PRINTER_CUE: LexEntry = {
  stems: ['طابعه', 'طابعت', 'طابعات', 'مكينه', 'ماكينه', 'printer', 'printers', 'پرینتەر', 'پرینتەرەکەم', 'چاپکەر'],
};

/** «صيانة» — scopes a part question to the maintenance section. */
export const MAINTENANCE_CUE: LexEntry = {
  stems: ['صيانه', 'maintenance', 'چاککردنەوە', 'چاکردنەوە'],
};

/** The part families a customer names, and the catalogue words that find them. */
export const PART_LEXICON: Record<PartKey, LexEntry> = {
  nozzle_hotend: {
    phrases: ['هوت اند', 'هوت ايند', 'hot end', 'راس الطباعه', 'هۆت ئێند'],
    stems: ['نوزل', 'نوزلات', 'فوهه', 'فوهات', 'هوتند', 'هوتاند', 'nozzle', 'nozzles', 'hotend', 'hotends', 'نۆزڵ', 'نۆزل'],
  },
  plate: {
    phrases: ['لوح طباعه', 'لوح الطباعه', 'سطح الطباعه', 'build plate', 'پلەیتی چاپ', 'پلێتی چاپ'],
    // «پلێت» is the commoner Sorani spelling of the same loanword.
    stems: ['بليت', 'بليتات', 'صفيحه', 'plate', 'plates', 'pei', 'پلەیت', 'پلێت'],
  },
  cleaning: {
    phrases: ['ابره تنظيف', 'ابر تنظيف', 'cleaning needle', 'cleaning kit', 'ئامرازی پاککردنەوە'],
    // «ينظف», «انظف», «تنظف» (to clean: «نظف» reaches each), «اسفنجة», "clean", "sponge", "wipes".
    stems: [
      'ابره', 'تنظيف', 'needle', 'needles', 'cleaning', 'پاککردنەوە', 'دەرزی', 'نظف', 'اسفنج', 'clean', 'sponge', 'sponges', 'wipes',
      'پاککەرەوە', 'ئیسفەنج',
    ],
  },
};

/** The cleaning tools a customer names, as the catalogue words they are searched by. */
export type CleaningTool = 'needle' | 'sponge' | 'wipes';
export const CLEANING_TOOLS: Record<CleaningTool, LexEntry> = {
  needle: { stems: ['ابره', 'needle', 'needles', 'دەرزی'] },
  sponge: { stems: ['اسفنج', 'sponge', 'sponges', 'ئیسفەنج'] },
  wipes: { stems: ['wipes', 'مناديل', 'منديل'] },
};

/**
 * The steps a fault IN a part family is answered with, when no symptom is
 * named: «مشكلة بالنوزل» takes the clog steps. It is a path, not a finding:
 * the triage keeps the part (`TriageState.faultIn`), and the chat and the
 * ticket say «a problem with the nozzle», never «انسداد النوزل», until the
 * customer names the clog («مسدود», «كلوب», "clogged", «گیراوە»).
 */
export const PART_SYMPTOM: Readonly<Record<PartKey, SymptomKey>> = {
  nozzle_hotend: 'clog',
  plate: 'adhesion',
  cleaning: 'clog',
};

/** What each family is searched as: the catalogue's own (indexed) words. */
export const PART_TERMS: Readonly<Record<PartKey, string>> = {
  nozzle_hotend: 'hotend nozzle',
  plate: 'plate',
  // The storefront's own answer to "nozzle cleaning": the sponge and the wipes first. A tool named is added («ابرة» → needle).
  cleaning: 'nozzle cleaning',
};

/** What fixes a fault in that family: the part and what cleans it. */
export const PART_FIX_TERMS: Readonly<Record<PartKey, string>> = {
  nozzle_hotend: 'hotend nozzle cleaning needle',
  plate: 'plate',
  cleaning: 'cleaning needle',
};

export const PART_LABELS: Readonly<Record<PartKey, L3>> = {
  nozzle_hotend: { ar: 'النوزل (الهوت إند)', en: 'nozzle / hotend', ckb: 'نۆزڵ / هۆت ئێند' },
  plate: { ar: 'لوح الطباعة', en: 'build plate', ckb: 'پلەیتی چاپکردن' },
  cleaning: { ar: 'أدوات تنظيف النوزل', en: 'nozzle cleaning tools', ckb: 'ئامرازی پاککردنەوەی نۆزڵ' },
};

/**
 * THE SYMPTOMS, matched like the intents. Two words are deliberately missing
 * from the always-on list:
 *
 *   - «خيوط» belongs to `materials_help` («خيوط PLA» is a question about
 *     filament). It counts as stringing only while the triage is asking for
 *     the symptom, or beside a problem word (`STRINGING_WEAK`).
 *   - «AMS» is also a product. It counts as an AMS fault only beside a
 *     problem word (`AMS_WEAK`).
 *
 * A bare «صوت» is not a symptom: «noise» is matched on phrases only.
 */
export const SYMPTOM_LEXICON: Record<Exclude<SymptomKey, 'other'>, LexEntry> = {
  clog: {
    // Either word order: «ما يطلع فلامنت» and «الفلامنت ما يطلع من النوزل». The
    // article on the first word comes off before matching (`bareProclitics`),
    // so «نوزل مسكر» also reads «النوزل مسكر». «مسكر» and «معلك» alone are not
    // here: «المحل مسكر» is a shop that is closed, «الطلب معلك» an order.
    phrases: [
      'انسداد النوزل', 'النوزل مسدود', 'نوزل مسدود', 'ما يطلع فلامنت', 'ما يطلع خيط', 'ما ينزل فلامنت', 'nozzle clog',
      'no extrusion', 'not extruding', 'نۆزڵ گیراوە', 'نۆزڵەکە گیراوە',
      'فلامنت ما يطلع', 'فلامنت ما ينزل', 'فلامنت ما يخرج', 'خيط ما يطلع', 'خيط ما ينزل', 'ما يطلع من النوزل', 'ما ينزل من النوزل',
      'ما يطلع شي من النوزل', 'ما يطلع من الفوهه', 'نوزل مسكر', 'نوزل مسكور', 'نوزل معلك', 'نوزل عالق', 'فلامنت معلك', 'فلامنت عالق',
      'خيط معلك', 'nozzle blocked', 'nozzle is blocked', 'nothing comes out', 'filament not coming out', 'filament stuck',
      'فیلامێنت نایەتە دەرەوە', 'نۆزڵ داخراوە', 'کلۆگ بووە', 'کلۆگی کردووە',
    ],
    // «کلۆگ» is the Sorani loanword, as «كلوب» is the Iraqi one.
    stems: ['كلوب', 'كلوك', 'انسداد', 'مسدود', 'clog', 'clogged', 'jam', 'jammed', 'گیراوە', 'گیراوه', 'کلۆگ'],
  },
  adhesion: {
    phrases: [
      'ما يلزق', 'ما يلصق', 'ما يلتصق', 'عدم الالتصاق', 'الطبقه الاولى', 'not sticking', 'does not stick', 'first layer',
      'چینی یەکەم', 'نانووسێت', 'ترتفع من الزوايا', 'ترتفع من الاطراف', 'زوايا ترتفع', 'تنشال من البليت', 'تنقلع من البليت',
      'corners lifting', 'lifting corners', 'گۆشەکان بەرز دەبنەوە',
    ],
    stems: ['التصاق', 'يلتصق', 'تقوس', 'تتقوس', 'تقوست', 'warping', 'warped', 'adhesion', 'نانووسێت', 'نەنووسان'],
  },
  layer_shift: {
    phrases: [
      'ازاحه الطبقات', 'ازاحه طبقات', 'الطبقات مزاحه', 'layer shift', 'layer shifting', 'لادانی چین', 'لادانی چینەکان',
      'طبقات تزحف', 'طبقات منحرفه', 'طبقات مايله', 'shifted layers', 'layers shifted', 'چینەکان لادەدەن',
    ],
    stems: ['ازاحه', 'مزاحه', 'تزحف', 'layershift', 'لادان'],
  },
  stringing: {
    phrases: ['خيوط رفيعه', 'خيوط بين', 'stringing', 'مثل شعر', 'مثل الشعر', 'بيها خيوط', 'فيها خيوط', 'like hair', 'وەک موو'],
    stems: ['stringing', 'stringy', 'شعيرات', 'دەزوو'],
  },
  ams: {
    phrases: [
      'مشكله ams', 'مشكلة ams', 'ams problem', 'ams error', 'کێشەی ams', 'ams ما يسحب', 'ams لا يسحب', 'ams not feeding',
      'ams is not feeding', 'ams doesnt feed', 'ams فیلامێنت ناکێشێت',
    ],
  },
  hms: {
    phrases: ['رمز خطا', 'رمز الخطا', 'كود خطا', 'كود الخطا', 'error code', 'hms error', 'hms code', 'کۆدی هەڵە'],
    stems: ['hms'],
  },
  noise: {
    phrases: [
      'صوت غريب', 'يطلع صوت', 'اصوات غريبه', 'صوت عالي', 'strange noise', 'weird noise', 'grinding noise', 'clicking noise',
      'دەنگی نامۆ', 'دەنگێکی نامۆ',
    ],
    stems: ['طقطقه', 'grinding', 'clicking'],
  },
};

/** Counted only while the triage asks for a symptom, or beside a problem word. */
export const STRINGING_WEAK: LexEntry = { stems: ['خيوط', 'خيط', 'strings'] };
/** Counted only beside a problem word. */
export const AMS_WEAK: LexEntry = { stems: ['ams'] };
