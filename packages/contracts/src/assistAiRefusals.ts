/**
 * THE OWNER'S ASSISTANT-AI TAB: ITS REFUSALS (push B plan §11), in Arabic,
 * English and Sorani. The server sends `assistAiMessage(code)` ("ar / en") as
 * the fallback sentence; the admin tab (a lazy chunk) renders the owner's
 * language by CODE from this table. It is deliberately NOT spread into
 * src/lib/refusalStrings.ts: no customer can meet these, and the storefront
 * bundle should not carry them.
 *
 * Every `ckb` is its own Sorani, never the Arabic pasted across
 * (docs/DECISIONS.md row 183). No sentence carries a value: no key, no model
 * id, no rate.
 *
 * Pure data, so the Worker, the client and the tests share it; its one
 * import is the read refusals it re-exports (./assistAiReadRefusals.ts).
 */
export interface AssistAiRefusal {
  ar: string;
  en: string;
  ckb: string;
}

export const ASSIST_AI_REFUSALS = {
  AI_SCHEMA_MISSING: {
    ar: 'جداول طبقة الذكاء الاصطناعي غير مثبّتة بعد في قاعدة البيانات. لم يُحفظ شيء.',
    en: 'The AI layer tables are not installed in the database yet. Nothing was saved.',
    ckb: 'خشتەکانی چینی زیرەکی دەستکرد هێشتا لە بنکەدراوەکەدا دانەمەزراون. هیچ شتێک پاشەکەوت نەکرا.',
  },
  AI_TASK_INVALID: {
    ar: 'المهمة أو الترتيب غير معروف.',
    en: 'Unknown task or rank.',
    ckb: 'ئەرک یان ڕیزبەندییەکە نەناسراوە.',
  },
  AI_MODEL_ID_INVALID: {
    ar: 'معرّف النموذج غير صالح.',
    en: 'The model id is not valid.',
    ckb: 'ناسنامەی مۆدێلەکە دروست نییە.',
  },
  AI_MODEL_LIST_UNAVAILABLE: {
    ar: 'تعذّر جلب قائمة النماذج من المزوّد الآن، فلم يُحفظ شيء. حاول بعد قليل.',
    en: 'The provider model list could not be fetched right now, so nothing was saved. Try again shortly.',
    ckb: 'ئێستا نەتوانرا لیستی مۆدێلەکان لە دابینکەرەکەوە وەربگیرێت، بۆیە هیچ شتێک پاشەکەوت نەکرا. کەمێکی تر هەوڵ بدەرەوە.',
  },
  AI_MODEL_NOT_LISTED: {
    ar: 'هذا النموذج ليس في قائمة المزوّد الحالية أو لا يدعم ما تحتاجه هذه المهمة.',
    en: 'This model is not in the provider current list, or it lacks what this task needs.',
    ckb: 'ئەم مۆدێلە لە لیستی ئێستای دابینکەرەکەدا نییە، یان ئەوەی ئەم ئەرکە پێویستیەتی پشتگیری ناکات.',
  },
  AI_TEST_TOKEN_REQUIRED: {
    ar: 'المعرّف المكتوب يدويًا يُحفظ فقط بعد تجربة ناجحة خلال آخر ١٠ دقائق. جرّبه أولًا.',
    en: 'A typed model id is saved only after a passing test in the last 10 minutes. Test it first.',
    ckb: 'ناسنامەیەکی بە دەست نووسراو تەنها دوای تاقیکردنەوەیەکی سەرکەوتوو لە ١٠ خولەکی ڕابردوودا پاشەکەوت دەکرێت. سەرەتا تاقی بکەرەوە.',
  },
  AI_RATES_REQUIRED: {
    ar: 'أدخل الأسعار المطلوبة لهذه المهمة (أكبر من صفر): لا يعمل نموذج بلا سعر.',
    en: 'Enter the prices this task needs (above zero): a model without prices does not run.',
    ckb: 'ئەو نرخانە بنووسە کە ئەم ئەرکە پێویستیەتی (لە سفر زیاتر): مۆدێلێک بێ نرخ کار ناکات.',
  },
  AI_RATE_INVALID: {
    ar: 'السعر يجب أن يكون رقمًا بالدولار بست خانات عشرية على الأكثر، ولا يتجاوز ١٠٠٠.',
    en: 'A price must be a USD number with at most six decimals, and at most 1000.',
    ckb: 'نرخ دەبێت ژمارەیەک بێت بە دۆلار، زۆرترین شەش ژمارەی دوای خاڵ، و لە ١٠٠٠ زیاتر نەبێت.',
  },
  AI_SETTINGS_INVALID: {
    ar: 'قيمة غير صالحة في الإعدادات: السقف بين ٠ و٥٠ دولارًا بخانتين عشريتين، وحصة الزوار بين ٠ و١٠٠.',
    en: 'A setting is not valid: the cap is 0 to 50 USD with two decimals, and the guest share 0 to 100.',
    ckb: 'بەهایەکی ڕێکخستنەکان دروست نییە: سنوورەکە لە ٠ تا ٥٠ دۆلارە بە دوو ژمارەی دوای خاڵ، و بەشی میوانان لە ٠ تا ١٠٠.',
  },
  AI_TEST_INPUT_INVALID: {
    ar: 'ملف التجربة مفقود أو غير صالح.',
    en: 'The test file is missing or not valid.',
    ckb: 'فایلی تاقیکردنەوەکە نییە یان دروست نییە.',
  },
  AI_TEST_TOO_LARGE: {
    ar: 'ملف التجربة أكبر من المسموح.',
    en: 'The test file is larger than allowed.',
    ckb: 'فایلی تاقیکردنەوەکە لەوەی ڕێگەپێدراوە گەورەترە.',
  },
} as const satisfies Record<string, AssistAiRefusal>;

export type AssistAiRefusalCode = keyof typeof ASSIST_AI_REFUSALS;

export const isAssistAiRefusalCode = (code: unknown): code is AssistAiRefusalCode =>
  typeof code === 'string' && Object.prototype.hasOwnProperty.call(ASSIST_AI_REFUSALS, code);

/** The server sentence: "ar / en", as every contract refusal carries it. */
export function assistAiMessage(code: AssistAiRefusalCode): string {
  const e = ASSIST_AI_REFUSALS[code];
  return `${e.ar} / ${e.en}`;
}

// The customer's read refusals live in their own module (see there why) and are re-exported here
// for the Worker and the tests.
export { ASSIST_AI_READ_REFUSALS, assistAiReadMessage, type AssistAiReadRefusalCode } from './assistAiReadRefusals';
