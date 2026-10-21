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
 * A PRINTER THE CUSTOMER SAYS IS THEIRS («عندي اي ون», «طابعتي A1», "I have
 * an A1", «A1م هەیە», «پرینتەرێکم هەیە»): they tell which printer they own,
 * they do not ask to buy one, so it is never answered with that printer for
 * sale (review round 4.3). Whole words, and phrases between gaps, after
 * `normalizeText`, which turns an apostrophe into a gap («i ve»). «عندكم»,
 * "do you have" and «A1 هەیە؟» still ask; «بۆ خۆم» is "for myself", a
 * purchase.
 *
 * THE SORANI «-م» IS ALSO WANT, NEED AND HAVE NOT (review round 5).
 * «پرینتەرێکم دەوێ» is "I want a printer", «پرینتەرێکم پێویستە» "I need a
 * printer" and «پرینتەرم نییە» "I have no printer": the clitic is the subject
 * of the verb after it. So «پرینتەرێکم» and «پرینتەرم» are ownership only
 * before «هەیە» or «هەمە», and a sentence with one of `veto` is never one.
 */
export const OWNS_PRINTER: { readonly words: readonly string[]; readonly phrases: readonly string[]; readonly veto: readonly string[] } = {
  words: [
    // «طابعتي», «مالتي» (mine), «عندي» / «عدي» (I have), «لدي», «املك» (I own), and a purchase in the past.
    'طابعتي', 'لطابعتي', 'بطابعتي', 'طابعتنا', 'مكينتي', 'ماكينتي', 'مالتي', 'مالي', 'عندي', 'عدي', 'عندنا', 'عدنا',
    'لدي', 'لدينا', 'املك', 'امتلك', 'نملك', 'اشتريت', 'اشتريته', 'اشتريتها', 'اشترينا', 'اشتريناها', 'شريت', 'شريته',
    'شريتها', 'شرينا',
    'my', 'mine', 'our', 'ours', 'ive', 'bought', 'purchased',
    // «پرینتەرەکەم» (my printer), «A1ەکەم» (my A1), «هەمە» (I have it), «کڕیم» (I bought).
    'پرینتەرەکەم', 'پرینتەرەکەمە', 'چاپکەرەکەم', 'ەکەم', 'هەمە', 'هەمانە', 'کڕیم', 'کڕیمە',
  ],
  // «A1م هەیە», «A1مان هەیە»: the clitic of «I have» and «we have» before «هەیە»; «A1ی خۆم», my own A1;
  // «پرینتەرێکم هەیە» (I have a printer), never «پرینتەرێکم» alone.
  phrases: [
    'i have', 'i ve', 'i own', 'i got', 'we have', 'we own', 'we got', 'م هەیە', 'مان هەیە', 'ی خۆم', 'هی خۆم',
    'پرینتەرێکم هەیە', 'پرینتەرم هەیە', 'چاپکەرێکم هەیە', 'چاپکەرم هەیە',
  ],
  // «دەوێ», «دەوێت», «ئەوێ» (want), «پێویستە» (is needed), «نییە», «نیە» (there is not).
  veto: ['دەوێ', 'دەوێت', 'ئەوێ', 'ئەوێت', 'پێویستە', 'پێویستمە', 'نییە', 'نیە'],
};

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
  'من عندكم', 'من عدكم', 'منكم', 'bought', 'purchased', 'کڕیم', 'کڕیمە', 'لە ئێوە',
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
 * the needle" a wait (review round 4.3).
 */
export const OUTCOME_NOT_FIXED: readonly string[] = [
  'ما انحلت', 'ما انحل', 'ما انحلت المشكله', 'مانحلت', 'ما حلت', 'ما زبطت', 'ما زبط', 'ما نفعت', 'ما نفع', 'ما فادت', 'ما فاد',
  'ما اشتغلت', 'ما اشتغل', 'لم تنحل', 'لم تحل', 'نفس المشكله', 'نفس الشي', 'بعدها نفس', 'بعده نفس', 'بعدها مسدود', 'بعده مسدود',
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
 * THE STEPS NOT TRIED («بعدني ما جربتها», "I still have not tried them",
 * «هێشتا تاقیم نەکردۆتەوە»): no outcome at all, read before both lists. The
 * steps were only shown, and a ticket never says they were tried (review
 * round 4.3).
 */
export const OUTCOME_NOT_TRIED: readonly string[] = [
  'ما جربت', 'ما جربتها', 'ما جربته', 'ما جربتهم', 'ماجربت', 'ماجربتها', 'لم اجرب', 'لم اجربها', 'لم اجربهم', 'بعدني ما',
  'ما طبقتها', 'ما سويتها',
  "haven't tried", 'havent tried', 'have not tried', 'not tried', "didn't try", 'didnt try', 'did not try', "haven't yet",
  'havent yet', 'have not yet', 'not yet tried', 'yet to try',
  'تاقیم نەکردۆتەوە', 'تاقیم نەکردووەتەوە', 'تاقیم نەکردوەتەوە', 'تاقیم نەکردووە', 'تاقیم نەکردەوە', 'تاقیم نەکردنەوە',
  'تاقیمان نەکردۆتەوە', 'تاقیمان نەکردەوە', 'تاقی نەکراوەتەوە',
];
/**
 * THE STEPS SAID TO BE TRIED («جربتها», "tried them", «تاقیم کردەوە»): only
 * with one of `verbs`, no word of `negations` right before it («ما سويتها»,
 * "have not done them", "not yet tried"; the Sorani negation is in the verb
 * itself, «نەمکردووە»), and none of `negatedAfter` right after a verb that
 * ends in an auxiliary ("I did not"). A not-fixed reply without one («نفس
 * المشكله», "still clogged", «هێشتا گیراوە») says nothing of trying: the
 * ticket lists the steps as shown, never as tried (review round 5).
 */
export const TRIED_SAID: {
  readonly verbs: readonly string[];
  readonly negations: readonly string[];
  readonly auxiliaries: readonly string[];
  readonly negatedAfter: readonly string[];
} = {
  verbs: [
    'جربت', 'جربتها', 'جربته', 'جربتهم', 'جربنا', 'جربناها', 'سويت', 'سويتها', 'سويته', 'سويتهم', 'سوينا', 'سويناها', 'طبقت', 'طبقتها',
    'طبقته', 'طبقتهم', 'عملتها', 'عملتهم', 'نفذت', 'نفذتها', 'نفذتهم', 'اتبعت', 'اتبعتها', 'حاولت', 'مسويها', 'مجربها',
    'tried', 'i did', 'we did', 'did them', 'did it', 'did all', 'did those', 'did everything', 'did every', 'did each', 'done',
    'followed', 'applied', 'went through',
    'تاقیم کردەوە', 'تاقیمکردەوە', 'تاقیم کردنەوە', 'تاقیم کرد', 'تاقیمان کردەوە', 'کردم', 'کردمن', 'کردمە', 'هەمووم کرد',
    'جێبەجێم کرد', 'ئەنجامم دا',
  ],
  // «ما», «لم», «مو»; the English ones, and «t», the end of "haven t" once the apostrophe is a gap.
  negations: ['ما', 'لم', 'مو', 'مش', 'not', 'never', 't', 'nt', 'haven', 'havent', 'hasn', 'hasnt', 'didn', 'didnt', 'dont', 'yet'],
  auxiliaries: ['did'],
  negatedAfter: ['not', 'nt', 'never'],
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
  // Buying, now: "what is wrong with buying the A1 mini?".
  'buying', 'purchase', 'purchasing', 'شراء', 'کڕین',
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
