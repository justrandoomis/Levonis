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
 * Pure data: no imports, so the Worker, the client and the tests share it.
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

/**
 * THE CUSTOMER'S READ REFUSALS (push B plan §5.2–§5.4): the few ways
 * `POST /api/support/assistant/read` and `/read-frames` refuse a request
 * outright. Everything else a reading can meet (switched off, the cap, a
 * limit, a provider fault, an unclear picture) is an ordinary reply in the
 * chat, never an error. The assistant page renders the customer's language by
 * CODE from this table; it is its own export so the page carries only these.
 * A key that is not the customer's own, or not uploaded, keeps push A's codes
 * (ATTACHMENT_NOT_YOURS, ATTACHMENT_NOT_FOUND), which the page already says.
 */
export const ASSIST_AI_READ_REFUSALS = {
  AI_CONSENT_REQUIRED: {
    ar: 'اقرأ ملاحظة القراءة الآلية ووافق عليها أولًا، ثم اضغط القراءة مرة أخرى.',
    en: 'Read and accept the note about automatic reading first, then press read again.',
    ckb: 'سەرەتا تێبینی خوێندنەوەی خۆکار بخوێنەوە و ڕازی بە، پاشان دووبارە خوێندنەوە دابگرە.',
  },
  AI_READ_INVALID: {
    ar: 'طلب القراءة غير مكتمل. أرفق الملف مرة أخرى ثم حاول.',
    en: 'The reading request is incomplete. Attach the file again, then try.',
    ckb: 'داواکاری خوێندنەوەکە تەواو نییە. فایلەکە دووبارە هاوپێچ بکە، پاشان هەوڵ بدەرەوە.',
  },
  AI_READ_KIND: {
    ar: 'هذا المرفق ليس من النوع الذي طُلبت قراءته.',
    en: 'This attachment is not the kind that was asked to be read.',
    ckb: 'ئەم هاوپێچە لەو جۆرە نییە کە داوای خوێندنەوەی کرا.',
  },
  AI_FRAMES_INVALID: {
    ar: 'لم تصل لقطات صالحة من المقطع. المقطع ما زال مرفقًا.',
    en: 'No valid frames of the clip arrived. The clip is still attached.',
    ckb: 'هیچ وێنەیەکی دروست لە ڤیدیۆکە نەگەیشت. ڤیدیۆکە هێشتا هاوپێچ کراوە.',
  },
  AI_FRAMES_TOO_LARGE: {
    ar: 'لقطات المقطع أكبر من المسموح. المقطع ما زال مرفقًا.',
    en: 'The frames of the clip are larger than allowed. The clip is still attached.',
    ckb: 'وێنەکانی ڤیدیۆکە لەوەی ڕێگەپێدراوە گەورەترن. ڤیدیۆکە هێشتا هاوپێچ کراوە.',
  },
} as const satisfies Record<string, AssistAiRefusal>;

export type AssistAiReadRefusalCode = keyof typeof ASSIST_AI_READ_REFUSALS;

/** The server sentence for a read refusal: "ar / en". */
export function assistAiReadMessage(code: AssistAiReadRefusalCode): string {
  const e = ASSIST_AI_READ_REFUSALS[code];
  return `${e.ar} / ${e.en}`;
}
