/**
 * THE PRICING PROGRAMME'S REFUSAL CONTRACT (master plan §6.1, landed whole in
 * step S1 so no later step invents a code without its three sentences).
 *
 * Owner decision 2 (2026-10-07): cost data reaches the owner only. Every
 * refusal that guards it, and every refusal the engine, batch and profit steps
 * will raise, is listed here once, in Arabic, English and Sorani. The server
 * sends `serverMessage(code)` ("ar / en") as the fallback sentence and the
 * client renders the viewer's language by CODE through `REFUSAL_STRINGS`
 * (`src/lib/refusalStrings.ts` spreads this table in).
 *
 * Rules every entry follows:
 *   - `ckb` is its own Sorani, never the Arabic or the English pasted across
 *     (docs/DECISIONS.md row 183), and it carries Sorani letters.
 *   - Terminology (master plan C32): product «بەرهەم», batch «وەجبە», cost
 *     «تێچوو», shipping «ناردن», main admin «بەڕێوەبەری سەرەکی».
 *   - A refusal carries no number, id or field value: one oracle-free answer
 *     for a real and an invented target alike (brief 1 §38).
 *
 * `PRODUCT_UNAVAILABLE` is NOT here: it keeps its existing cart wording in
 * `REFUSAL_STRINGS` (master plan F19). The add-to-cart and quote refusal with
 * the §38 sentence is `PRODUCT_CURRENTLY_UNAVAILABLE` (critique G-34).
 *
 * Pure data: no imports, so the Worker, the client and the tests share it.
 */

export interface CostRefusal {
  ar: string;
  en: string;
  ckb: string;
}

export const COST_REFUSALS = {
  // ---- who may see or write cost (security spec §6) ------------------------
  COST_ACCESS_DENIED: {
    ar: 'هذه البيانات متاحة للأدمن الرئيسي فقط.',
    en: 'This information is available to the main admin only.',
    ckb: 'ئەم زانیارییانە تەنها بۆ بەڕێوەبەری سەرەکی بەردەستن.',
  },
  // The owner's own address on an admin row that is NOT yet verified (DECISIONS
  // row 185, amendment of 2026-10-08). Only that one session can ever receive
  // it; everyone else keeps COST_ACCESS_DENIED, byte for byte. It names the
  // way out: verify the address with the link in the verification email (the
  // admin screens send it). The first proof of this address is made only after
  // the person accepted what it ends (OWNER_FIRST_PROOF_REQUIRED below: the
  // link, or a code sign-in to this address); a Google sign-in leaves it
  // unproven (worker/lib/emailStamp.ts) — so the sentence offers no Google,
  // and never a "connect Google in your settings" control, which does not
  // exist.
  //
  // The last sentence says, BEFORE the owner verifies, what the first proof
  // ends (worker/lib/emailStamp.ts, review finding C1): every other session,
  // the password, the Telegram link, the phone sign-in and any Google account
  // under another address — whoever took the address while it was free must
  // not keep a way in. Google on this same address is cleared too but links
  // again at its next sign-in (the row is proven by then), so the sentence
  // does not tell the owner Google is lost. Only someone already signed in to
  // this row reads it, so it carries no "ignore it if you did not ask" advice:
  // that belongs to the email and to VERIFY_SIGN_IN_REQUIRED, which a stranger
  // to the row can read.
  OWNER_EMAIL_UNVERIFIED: {
    ar: 'بيانات التكلفة تُفتح للأدمن الرئيسي بعد تأكيد بريد حسابه. أكّد بريدك الإلكتروني برابط رسالة التأكيد لفتحها. أول تأكيد يُنهي جلسات هذا الحساب على الأجهزة الأخرى ويزيل كلمة مروره وربط تيليغرام والدخول بالهاتف وأي حساب Google ببريد آخر؛ بعده تدخل برمز يصل إلى هذا البريد أو بـGoogle على البريد نفسه، ولك أن تعيّن كلمة مرور جديدة.',
    en: "Cost data opens for the main admin once the account's email is verified. Verify your email with the link in the verification email to open it. The first verification ends this account's sessions on other devices and removes its password, Telegram link, phone sign-in and any Google account with a different email; after it you sign in with a code sent to this email or with Google on this same email, and you can set a new password.",
    ckb: 'زانیارییەکانی تێچوو بۆ بەڕێوەبەری سەرەکی دەکرێنەوە دوای پشتڕاستکردنەوەی ئیمەیڵی هەژمارەکە. بۆ کردنەوەیان، بە بەستەری ناو ئیمەیڵی پشتڕاستکردنەوە ئیمەیڵەکەت پشتڕاست بکەرەوە. یەکەم پشتڕاستکردنەوە دانیشتنەکانی ئەم هەژمارە لە ئامێرەکانی تر کۆتایی پێدەهێنێت و وشەی نهێنی و بەستنەوەی تێلێگرام و چوونەژوورەوە بە ژمارەی مۆبایل و هەر هەژمارێکی Google بە ئیمەیڵێکی تر لادەبات؛ دوای ئەوە بە کۆدێک کە بۆ ئەم ئیمەیڵە دەنێردرێت یان بە Google بە هەمان ئیمەیڵ دەچیتە ژوورەوە، و دەتوانیت وشەی نهێنییەکی نوێ دابنێیت.',
  },
  // The FIRST proof of the owner's address — the emailed link, or a sign-in
  // code to that address — is made only by a request that says the person
  // accepted what it ends (`accept_owner_first_proof: true`); without it the
  // route answers this, changes nothing, and keeps the link or the code
  // unspent (worker/lib/emailStamp.ts, rule 3). Decided by the server for any
  // row and any token, so no page state can skip the warning. Read only by the
  // holder of a valid link or code — the mailbox — so it tells nobody anything
  // their mailbox did not. The page shows it with a confirm and a cancel.
  OWNER_FIRST_PROOF_REQUIRED: {
    ar: 'هذا أول تأكيد لبريد الأدمن الرئيسي. يُنهي جلسات هذا الحساب على الأجهزة الأخرى ويزيل كلمة مروره وربط تيليغرام والدخول بالهاتف وأي حساب Google ببريد آخر؛ بعده تدخل برمز يصل إلى هذا البريد أو بـGoogle على البريد نفسه. أكّد للمتابعة، أو ألغِ ليبقى كل شيء كما هو.',
    en: "This is the first verification of the main admin's email. It ends this account's sessions on other devices and removes its password, Telegram link, phone sign-in and any Google account with a different email; after it you sign in with a code sent to this email or with Google on this same email. Confirm to continue, or cancel to leave everything as it is.",
    ckb: 'ئەمە یەکەم پشتڕاستکردنەوەی ئیمەیڵی بەڕێوەبەری سەرەکییە. دانیشتنەکانی ئەم هەژمارە لە ئامێرەکانی تر کۆتایی پێدەهێنێت و وشەی نهێنی و بەستنەوەی تێلێگرام و چوونەژوورەوە بە ژمارەی مۆبایل و هەر هەژمارێکی Google بە ئیمەیڵێکی تر لادەبات؛ دوای ئەوە بە کۆدێک کە بۆ ئەم ئیمەیڵە دەنێردرێت یان بە Google بە هەمان ئیمەیڵ دەچیتە ژوورەوە. بۆ بەردەوامبوون پشتڕاستی بکەرەوە، یان هەڵیبوەشێنەوە تا هەموو شتێک وەک خۆی بمێنێتەوە.',
  },
  // A verification link for the owner's address — the one that opens cost —
  // is confirmed only from a session of the account it belongs to (DECISIONS
  // row 185 amendment). Said only to the holder of a valid, unused link, so it
  // tells nobody anything their mailbox did not; the link stays unused.
  //
  // The last sentence is for the real owner opening a message somebody ELSE
  // asked for (review finding C1): a row that took the address while it was
  // free can send it, and "sign in" would then be a code sign-in into THAT
  // row (which asks, with OWNER_FIRST_PROOF_REQUIRED, before it proves
  // anything). Ignoring it leaves the row unproven.
  VERIFY_SIGN_IN_REQUIRED: {
    ar: 'بريد الأدمن الرئيسي يُؤكَّد من حسابه وهو مسجّل الدخول فقط. سجّل الدخول إلى ذلك الحساب في هذا المتصفح، ثم افتح رابط التأكيد من الرسالة مرة أخرى. إن لم تطلب هذه الرسالة، فتجاهلها ولا تسجّل الدخول.',
    en: "The main admin's email is confirmed only from that account while it is signed in. Sign in to it in this browser, then open the confirmation link from the email again. If you did not ask for this email, ignore it and do not sign in.",
    ckb: 'ئیمەیڵی بەڕێوەبەری سەرەکی تەنها لە هەژمارەکەی خۆیەوە و لە کاتی چوونەژوورەوەدا پشتڕاست دەکرێتەوە. لەم وێبگەڕەدا بچۆ ژوورەوەی ئەو هەژمارە، پاشان دووبارە بەستەری پشتڕاستکردنەوە لە ئیمەیڵەکەوە بکەرەوە. ئەگەر داوای ئەم ئیمەیڵەت نەکردووە، پشتگوێی بخە و مەچۆ ژوورەوە.',
  },
  OWNER_ONLY: {
    ar: 'هذا الإجراء للأدمن الرئيسي فقط.',
    en: 'Only the main admin can do this.',
    ckb: 'تەنها بەڕێوەبەری سەرەکی دەتوانێت ئەم کارە بکات.',
  },
  PRICING_INCOMPLETE: {
    ar: 'بيانات التسعير غير مكتملة. راجع الأدمن الرئيسي.',
    en: 'Pricing data is incomplete. Please check with the main admin.',
    ckb: 'زانیارییەکانی نرخدانان تەواو نین. پەیوەندی بە بەڕێوەبەری سەرەکییەوە بکە.',
  },
  PRODUCT_CURRENTLY_UNAVAILABLE: {
    ar: 'هذا المنتج غير متوفر حالياً.',
    en: 'This product is currently unavailable.',
    ckb: 'ئەم بەرهەمە لە ئێستادا بەردەست نییە.',
  },
  PRIVATE_DELEGATION_DISABLED: {
    ar: 'منح صلاحيات التكلفة متوقف حالياً بقرار المالك.',
    en: "Granting cost access is switched off by the owner's decision.",
    ckb: 'پێدانی دەسەڵاتی بینینی تێچوون لە ئێستادا بە بڕیاری خاوەنی فرۆشگا ڕاگیراوە.',
  },
  SCOPE_ELEVATION_OWNER_ONLY: {
    ar: 'رفع صلاحية المشرف إلى كاملة للأدمن الرئيسي فقط.',
    en: 'Only the main admin can give an admin full access.',
    ckb: 'تەنها بەڕێوەبەری سەرەکی دەتوانێت دەسەڵاتی تەواو بە بەڕێوەبەرێک بدات.',
  },
  PROMOTION_STARTS_ASSISTANT: {
    ar: 'يبدأ كل أدمن جديد مساعداً. امنحه الدور أولاً، ثم يقرر الأدمن الرئيسي أي صلاحية أوسع.',
    en: 'Every new admin starts as an assistant. Grant the role first; the main admin decides any wider access afterwards.',
    ckb: 'هەموو بەڕێوەبەرێکی نوێ وەک یاریدەدەر دەست پێدەکات. سەرەتا ڕۆڵەکە بدە؛ دواتر بەڕێوەبەری سەرەکی بڕیار لەسەر دەسەڵاتی فراوانتر دەدات.',
  },
  INVESTOR_FLAG_OWNER_ONLY: {
    ar: 'تغيير صفة المستثمر للأدمن الرئيسي فقط.',
    en: 'Only the main admin can change investor status.',
    ckb: 'تەنها بەڕێوەبەری سەرەکی دەتوانێت دۆخی وەبەرهێنەر بگۆڕێت.',
  },
  ROLE_CHANGE_DENIED: {
    ar: 'منح دور الأدمن أو سحبه يحتاج صلاحية كاملة.',
    en: 'Granting or removing the admin role needs full access.',
    ckb: 'پێدان یان لابردنی ڕۆڵی بەڕێوەبەر پێویستی بە دەسەڵاتی تەواو هەیە.',
  },
  SELF_DEMOTE: {
    ar: 'لا يمكنك سحب دور الأدمن من حسابك أنت.',
    en: 'You cannot remove the admin role from your own account.',
    ckb: 'ناتوانیت ڕۆڵی بەڕێوەبەر لە هەژماری خۆت لاببەیت.',
  },
  OWNER_LOCKED: {
    ar: 'لا يمكن سحب صلاحيات حساب المالك أو تقييدها.',
    en: "The owner account's access cannot be removed or restricted.",
    ckb: 'ناتوانرێت دەسەڵاتەکانی هەژماری خاوەن لاببرێن یان سنووردار بکرێن.',
  },
  OWNER_EMAIL_LOCKED: {
    ar: 'لا يمكن تغيير بريد حساب المالك من هنا.',
    en: "The owner account's email cannot be changed here.",
    ckb: 'ناتوانرێت ئیمەیڵی هەژماری خاوەن لێرەوە بگۆڕدرێت.',
  },
  REAUTH_REQUIRED: {
    ar: 'سجّل الدخول مجدداً ثم أعد المحاولة.',
    en: 'Sign in again, then try once more.',
    ckb: 'دووبارە بچۆ ژوورەوە، پاشان هەوڵ بدەرەوە.',
  },
  GRANT_TARGET_INVALID: {
    ar: 'لا يمكن منح هذه الصلاحية لهذا الحساب.',
    en: 'This access cannot be granted to this account.',
    ckb: 'ناتوانرێت ئەم دەسەڵاتە بەم هەژمارە بدرێت.',
  },
  GRANT_EXISTS: {
    ar: 'هذه الصلاحية ممنوحة لهذا الحساب مسبقاً.',
    en: 'This account already has this access.',
    ckb: 'ئەم هەژمارە پێشتر ئەم دەسەڵاتەی هەیە.',
  },

  // ---- the engine model (ENG §6.3; «کاڵا» replaced by «بەرهەم», C32) -------
  ENGINE_MANAGED: {
    ar: 'أسعار هذا المنتج يديرها محرك التسعير ولا تُعدَّل من هنا.',
    en: "This product's prices are managed by the pricing engine and cannot be changed here.",
    ckb: 'نرخەکانی ئەم بەرهەمە بزوێنەری نرخدانان بەڕێوەیان دەبات و لێرەوە ناگۆڕدرێن.',
  },
  ENGINE_MANAGED_PRICES_KEPT: {
    ar: 'حُفظت تعديلاتك الأخرى وبقيت الأسعار كما هي لأن محرك التسعير يديرها.',
    en: 'Your other changes were saved; prices were kept because the pricing engine manages them.',
    ckb: 'گۆڕانکارییەکانی ترت پاشەکەوت کران؛ نرخەکان وەک خۆیان مانەوە چونکە بزوێنەری نرخدانان بەڕێوەیان دەبات.',
  },
  DIRECT_SALE_EXTRA_NOT_ON_STEP: {
    ar: 'يجب أن تكون زيادة البيع المباشر من مضاعفات 1,000 د.ع.',
    en: 'The Direct Sale Extra must be a multiple of 1,000 IQD.',
    ckb: 'زیادەی فرۆشتنی ڕاستەوخۆ دەبێت چەندجارەی 1,000 دینار بێت.',
  },

  // ---- engine runs (RUN §6) ------------------------------------------------
  PRICING_INCOMPLETE_KEPT_HIDDEN: {
    ar: 'بقي المنتج مخفياً لأن بيانات تسعيره غير مكتملة.',
    en: 'The product stayed hidden because its pricing data is incomplete.',
    ckb: 'بەرهەمەکە شاردراوە مایەوە چونکە زانیاری نرخدانانی ناتەواوە.',
  },
  PRICING_PREVIEW_STALE: {
    ar: 'تغيّرت البيانات منذ المعاينة. أعد المعاينة.',
    en: 'The data changed since this preview. Preview again.',
    ckb: 'زانیارییەکان لە دوای پێشبینینەکە گۆڕاون. دووبارە پێشبینی بکەرەوە.',
  },
  PRICING_PREVIEW_EXPIRED: {
    ar: 'انتهت صلاحية المعاينة. أعد المعاينة.',
    en: 'This preview has expired. Preview again.',
    ckb: 'ماوەی ئەم پێشبینینە بەسەرچووە. دووبارە پێشبینی بکەرەوە.',
  },
  PRICING_ENGINE_PAUSED: {
    ar: 'التسعير التلقائي متوقف مؤقتاً.',
    en: 'Automatic pricing is paused.',
    ckb: 'نرخدانانی خۆکار بە کاتی وەستێنراوە.',
  },
  COMPOSITION_NOT_PRICEABLE: {
    ar: 'الحزم والعروض العشوائية لا تُسعَّر تلقائياً.',
    en: 'Bundles and mystery offers are not priced automatically.',
    ckb: 'پاکێج و ئۆفەرە نهێنییەکان بە خۆکاری نرخیان بۆ دانانرێت.',
  },

  // ---- import and template (IMP §6.3) ---------------------------------------
  IMPORT_PREVIEW_EXPIRED: {
    ar: 'انتهت صلاحية هذه المعاينة — افحص الملف مرة أخرى.',
    en: 'This preview has expired — check the file again.',
    ckb: 'ماوەی ئەم پێشبینینە بەسەرچووە — دووبارە فایلەکە بپشکنە.',
  },
  AUDIT_UNAVAILABLE: {
    ar: 'تعذّر تسجيل التصدير في سجل التدقيق — لم يُنزَّل الملف. أعد المحاولة.',
    en: 'The export could not be written to the audit log — the file was not served. Try again.',
    ckb: 'هەناردەکردنەکە لە تۆماری چاودێریدا تۆمار نەکرا — فایلەکە نەنێردرا. دووبارە هەوڵ بدەرەوە.',
  },

  // ---- inventory and batches (INV §6.6) -------------------------------------
  FIFO_OVERRIDE_TOO_LATE: {
    ar: 'تم صرف هذا البند من المخزون بنظام FIFO؛ لا يمكن تغيير دفعته الآن.',
    en: 'This line has already been issued from stock by FIFO; its batch can no longer be changed.',
    ckb: 'ئەم هێڵە بە FIFO لە کۆگا دەرکراوە؛ ئێستا ناتوانرێت وەجبەکەی بگۆڕدرێت.',
  },
  FIFO_OVERRIDE_REASON_REQUIRED: {
    ar: 'اكتب سبب الاستثناء (10 أحرف على الأقل).',
    en: 'Write the reason for the exception (at least 10 characters).',
    ckb: 'هۆکاری ئەم ڕێگەپێدانە تایبەتە بنووسە (لانیکەم ١٠ پیت).',
  },
  FIFO_OVERRIDE_LOT_MISMATCH: {
    ar: 'الدفعة لا تخص هذا المنتج أو الخيار أو اللون في هذا الطلب.',
    en: 'That batch does not belong to this product, option or colour in this order.',
    ckb: 'ئەو وەجبەیە سەر بەم بەرهەم یان هەڵبژاردە یان ڕەنگەی ئەم داواکارییە نییە.',
  },
  FIFO_OVERRIDE_QTY: {
    ar: 'الكمية أكبر من المحجوز لهذا البند أو من المتبقي في الدفعة.',
    en: 'The quantity is more than this line has reserved or than the batch has left.',
    ckb: 'بڕەکە لەوە زیاترە کە بۆ ئەم هێڵە حیجزکراوە یان لە وەجبەکەدا ماوە.',
  },
  FIFO_OVERRIDE_NOT_NEEDED: {
    ar: 'هذه القطعة من الدفعة التي خصصها FIFO أصلًا؛ لا حاجة لاستثناء.',
    en: 'This unit is already from the batch FIFO assigned; no exception is needed.',
    ckb: 'ئەم پارچەیە لە هەمان ئەو وەجبەیەیە کە FIFO دیاریکردووە؛ پێویست بە ڕێگەپێدانی تایبەت ناکات.',
  },
  FIFO_OVERRIDE_NOT_DEDUCTED: {
    ar: 'لم يُصرف هذا البند من المخزون بعد؛ استخدم التثبيت قبل التأكيد.',
    en: 'This line has not been issued from stock yet; pin a batch before confirmation instead.',
    ckb: 'ئەم هێڵە هێشتا لە کۆگا دەرنەکراوە؛ لە جیاتی ئەوە پێش پشتڕاستکردنەوە وەجبەیەک جێگیر بکە.',
  },
  FIFO_OVERRIDE_REVOKE_REFUSED: {
    ar: 'لا يمكن إلغاء هذا التثبيت بعد صرف البند.',
    en: 'This pin cannot be removed after the line has been issued.',
    ckb: 'ئەم جێگیرکردنە دوای دەرکردنی هێڵەکە لاناچێت.',
  },
  FIFO_OVERRIDES_NOT_INSTALLED: {
    ar: 'استثناءات FIFO لم تُفعَّل بعد.',
    en: 'FIFO exceptions are not set up yet.',
    ckb: 'ڕێگەپێدانە تایبەتەکانی FIFO هێشتا ڕێکنەخراون.',
  },
  SERIAL_LOT_NOT_FIFO: {
    ar: 'هذا الرقم التسلسلي من دفعة غير التي خصصها FIFO لهذا الطلب. لا يُربط إلا باستثناء يعتمده الأدمن الرئيسي.',
    en: 'This serial belongs to a different batch from the one FIFO assigned to this order. It can only be linked through an exception the main admin approves.',
    ckb: 'ئەم ژمارە زنجیرەییە سەر بە وەجبەیەکی ترە جگە لەوەی FIFO بۆ ئەم داواکارییە دیاریکردووە. تەنها بە ڕێگەپێدانی بەڕێوەبەری سەرەکی دەبەسترێتەوە.',
  },
  SCAN_ORDER_MISMATCH: {
    ar: 'الدفعة ليست من أصل هذا الطلب.',
    en: 'This batch is not one this order was issued from.',
    ckb: 'ئەم وەجبەیە لەو وەجبانە نییە کە ئەم داواکارییەی لێ دەرکراوە.',
  },
  SNAPSHOT_MISMATCH: {
    ar: 'تعذّر تثبيت لقطة تكلفة الدفعة؛ لم يُستلم شيء. أعد المحاولة أو راجع بنود الشراء.',
    en: 'The batch cost snapshot could not be fixed; nothing was received. Retry or review the purchase lines.',
    ckb: 'تۆماری جێگیری تێچووی وەجبە دانەمەزرا؛ هیچ شتێک وەرنەگیرا. دووبارە هەوڵ بدەرەوە یان هێڵەکانی کڕین بپشکنە.',
  },
  COST_CORRECTIONS_NOT_INSTALLED: {
    ar: 'تصحيحات تكلفة المخزون لم تُفعَّل بعد.',
    en: 'Inventory cost corrections are not set up yet.',
    ckb: 'ڕاستکردنەوەکانی تێچووی کۆگا هێشتا ڕێکنەخراون.',
  },

  // ---- orders and profit (ORD §6; «کاڵا» replaced by «بەرهەم», C32) --------
  REOPEN_STOCK_UNAVAILABLE: {
    ar: 'لا يمكن إعادة فتح الطلب: المخزون الحالي لا يغطي قطعه. حدّث المخزون أو أنشئ طلبًا جديدًا.',
    en: 'This order cannot be re-opened: current stock does not cover its items. Update the stock or create a new order.',
    ckb: 'ناتوانرێت داواکارییەکە دووبارە بکرێتەوە: کۆگای ئێستا بەشی بەرهەمەکانی ناکات. کۆگا نوێ بکەرەوە یان داواکارییەکی نوێ دروست بکە.',
  },
  RETURN_RESOLUTION_RETRY: {
    ar: 'لم يُنفّذ أي جزء من الاسترداد. أعد المحاولة.',
    en: 'No part of the refund was applied. Try again.',
    ckb: 'هیچ بەشێکی گەڕاندنەوەی پارە جێبەجێ نەکرا. دووبارە هەوڵ بدەرەوە.',
  },
  LOT_OVER_ATTRIBUTED: {
    ar: 'هذه الدفعة لا تحتوي قطعًا كافية لهذا الربط.',
    en: 'This batch does not have enough units for this link.',
    ckb: 'ئەم وەجبەیە دانەی پێویستی بۆ ئەم بەستنەوەیە تێدا نییە.',
  },
  PREORDER_LINK_NOT_ELIGIBLE: {
    ar: 'هذا البند ليس طلبًا مسبقًا منتظرًا.',
    en: 'This line is not a waiting pre-order.',
    ckb: 'ئەم دێڕە پێش-داواکارییەکی چاوەڕوان نییە.',
  },
  PREORDER_LEGACY_CAPACITY_HOLD: {
    ar: 'هذا الطلب القديم ما زال يحجز حصة استيراد؛ لا يُربط يدويًا.',
    en: 'This legacy order still holds an import quota; it cannot be linked by hand.',
    ckb: 'ئەم داواکارییە کۆنە هێشتا بەشێکی هاوردەکردن دەگرێت؛ بە دەست نابەسترێتەوە.',
  },
  HISTORICAL_RECONCILIATION_NOT_ELIGIBLE: {
    ar: 'هذا البند ليس طلبًا مسبقًا قديمًا سُلّم بلا دفعة.',
    en: 'This line is not a legacy pre-order delivered without a batch.',
    ckb: 'ئەم دێڕە پێش-داواکارییەکی کۆن نییە کە بێ وەجبە گەیەندرابێت.',
  },
  RECONCILIATION_QTY_MISMATCH: {
    ar: 'مجموع القطع يجب أن يساوي كمية البند.',
    en: 'The units must add up to the line quantity.',
    ckb: 'کۆی دانەکان دەبێت یەکسان بێت بە بڕی دێڕەکە.',
  },
  PREORDER_AWAITING_BATCH: {
    ar: 'تكلفة الطلب المسبق تقديرية حتى يُربط بدفعة مستلمة؛ يُرحّل القيد تلقائيًا بعد الربط.',
    en: 'The pre-order cost is an estimate until it is linked to a received batch; the journal posts automatically after linking.',
    ckb: 'تێچووی پێش-داواکاری خەمڵێنراوە تا بە وەجبەیەکی وەرگیراو دەبەسترێتەوە؛ تۆمارەکە دوای بەستنەوە خۆکارانە دەنێردرێت.',
  },

  // ---- new, merged or corrected codes (master plan §6.1 table) ------------
  UNKNOWN_FIELD: {
    ar: 'الطلب يحتوي حقلاً غير مسموح.',
    en: 'The request contains a field that is not allowed.',
    ckb: 'داواکارییەکە خانەیەکی ڕێگەپێنەدراوی تێدایە.',
  },
  IDEMPOTENCY_MISMATCH: {
    ar: 'رقم العملية مستخدم لطلب مختلف.',
    en: 'This operation id was already used for a different request.',
    ckb: 'ئەم ژمارەی کردارە پێشتر بۆ داواکارییەکی جیاواز بەکارهاتووە.',
  },
  PRICING_CHANGED: {
    ar: 'تغيّرت بيانات التسعير منذ فتحتها أو صدّرتها. حدّث الصفحة أو صدّر الملف من جديد ثم أعد المحاولة.',
    en: 'Pricing data changed since you opened or exported it. Refresh the page or export the file again, then retry.',
    ckb: 'داتای نرخدانان لەو کاتەوەی کردتەوە یان هەناردەت کرد گۆڕاوە. پەڕەکە نوێ بکەرەوە یان فایلەکە دووبارە هەناردە بکە، پاشان دووبارە هەوڵ بدەرەوە.',
  },
  PRICING_NOT_INSTALLED: {
    ar: 'نظام التسعير قيد التحديث؛ حاول بعد قليل.',
    en: 'The pricing system is being updated; try again shortly.',
    ckb: 'سیستەمی نرخدانان نوێ دەکرێتەوە؛ کەمێکی تر هەوڵ بدەرەوە.',
  },
  PRICING_PREVIEW_REQUIRED: {
    ar: 'هذا التغيير يمسّ منتجات كثيرة؛ عاينه أولاً ثم طبّقه.',
    en: 'This change affects many products; preview it first, then apply it.',
    ckb: 'ئەم گۆڕانکارییە کار لە زۆر بەرهەم دەکات؛ سەرەتا پێشبینینی بکە، پاشان جێبەجێی بکە.',
  },
  PRICING_PREVIEW_BUSY: {
    ar: 'المعاينة قيد الحساب في نافذة أخرى؛ انتظر لحظة.',
    en: 'This preview is being calculated in another window; wait a moment.',
    ckb: 'ئەم پێشبینینە لە پەنجەرەیەکی تردا هەژمار دەکرێت؛ کەمێک چاوەڕێ بکە.',
  },
  PRICING_PREVIEW_INCOMPLETE: {
    ar: 'لم تكتمل المعاينة بعد.',
    en: 'The preview has not finished yet.',
    ckb: 'پێشبینینەکە هێشتا تەواو نەبووە.',
  },
  PRICING_RUN_REVISION_CHANGED: {
    ar: 'بدأت عملية تسعير أحدث؛ حدّث الصفحة.',
    en: 'A newer pricing run has started; refresh the page.',
    ckb: 'کارێکی نوێتری نرخدانان دەستی پێکردووە؛ پەڕەکە نوێ بکەرەوە.',
  },
  PRICING_NOT_MANAGED: {
    ar: 'هذا المنتج لا يستخدم التسعير التلقائي.',
    en: 'This product does not use automatic pricing.',
    ckb: 'ئەم بەرهەمە نرخدانانی خۆکار بەکارناهێنێت.',
  },
  PRICING_SET_TOO_LARGE: {
    ar: 'التغيير يشمل منتجات أكثر من المسموح في عملية واحدة؛ قسّمه حسب القسم.',
    en: 'This change covers more products than one run allows; split it by category.',
    ckb: 'ئەم گۆڕانکارییە بەرهەمی زیاتر لەوە دەگرێتەوە کە یەک کار ڕێگەی پێدەدات؛ بەپێی بەش دابەشی بکە.',
  },
  LOT_PRODUCT_MISMATCH: {
    ar: 'هذه الدفعة لمنتج آخر.',
    en: 'That batch belongs to another product.',
    ckb: 'ئەو وەجبەیە هی بەرهەمێکی ترە.',
  },
  // MVP plan V14: the one §6.1 code S1 did not land, added by the first route
  // that validates a pricing input (P1's what-if). `{field}` is the field's
  // NAME, filled from `details.field` — never its value.
  PRICING_INPUT_INVALID: {
    ar: 'قيمة غير صالحة في الحقل «{field}».',
    en: 'Invalid value in “{field}”.',
    ckb: 'بەهایەکی نادروست لە خانەی «{field}».',
  },
  CENTRAL_RATES_MOVED: {
    ar: 'أسعار الصرف والشحن المركزية تُعدّل من شاشة «التسعير والشحن» فقط.',
    en: 'Central exchange and shipping rates are edited only on the Pricing & Shipping screen.',
    ckb: 'نرخە ناوەندییەکانی ئاڵوگۆڕ و ناردن تەنها لە شاشەی «نرخدانان و ناردنی بەرهەم» دەستکاری دەکرێن.',
  },

  // ---- adversarial review amendments (critique-2 §6) ----------------------
  PRICING_LARGE_CHANGE_CONFIRM: {
    ar: 'هذا التغيير كبير (أكثر من ١٥٪ عن القيمة الحالية). راجع المعاينة ثم أكّد التغيير الكبير صراحةً.',
    en: 'This is a large change (more than 15% from the current value). Review the preview, then confirm the large change explicitly.',
    ckb: 'ئەم گۆڕانکارییە گەورەیە (زیاتر لە ١٥٪ لە بەهای ئێستا). پێشبینینەکە بپشکنە، پاشان بە ڕوونی گۆڕانکارییە گەورەکە پشتڕاست بکەرەوە.',
  },
  PRICING_PINS_BELOW_TARGET_ACK: {
    ar: 'بعد هذا التغيير ستصبح أسعار مثبتة يدوياً أقل من ربحك المستهدف. راجع القائمة وأكّد أنك تبقيها كما هي.',
    en: 'After this change, some manually pinned prices will fall below your target profit. Review the list and confirm you are keeping them as they are.',
    ckb: 'دوای ئەم گۆڕانکارییە هەندێک نرخی جێگیرکراوی دەستی لە قازانجی ئامانجت کەمتر دەبن. لیستەکە بپشکنە و پشتڕاستی بکەرەوە کە وەک خۆیان دەیانهێڵیتەوە.',
  },
  PRICING_RUN_MARK_ERRONEOUS_REFUSED: {
    ar: 'لا يمكن تعليم هذه العملية كخاطئة: يجب أن تكون انتهت خلال آخر ٢٤ ساعة وأن تعقبها عملية تسعير أحدث.',
    en: "This run can't be marked as erroneous: it must have finished within the last 24 hours and be followed by a newer pricing run.",
    ckb: 'ناتوانرێت ئەم کارە وەک هەڵە دیاری بکرێت: دەبێت لە ٢٤ کاتژمێری ڕابردوودا تەواو بووبێت و کارێکی نرخدانانی نوێتر دوای کەوتبێت.',
  },
  PRICE_PROTECTION_MANUAL_REVIEW: {
    ar: 'لا يمكن مقارنة سعر هذا المنتج تلقائياً. سيراجع فريق الدعم طلبك يدوياً.',
    en: "This product's price can't be compared automatically. Support will review your claim manually.",
    ckb: 'نرخی ئەم بەرهەمە ناتوانرێت بە شێوەی خۆکار بەراورد بکرێت. تیمی پشتگیری داواکەت بە دەستی دەپشکنێت.',
  },
  PREORDER_LINK_SKIP_OWNER_ONLY: {
    ar: 'تخطّي ربط الطلبات المسبقة بهذه الدفعة للأدمن الرئيسي فقط.',
    en: 'Only the main admin can skip linking pre-orders to this batch.',
    ckb: 'تەنها بەڕێوەبەری سەرەکی دەتوانێت بەستنەوەی پێشداواکارییەکان بەم وەجبەیە بپەڕێنێت.',
  },
  OFFER_FIXED_NOT_FOR_ENGINE: {
    ar: 'السعر الثابت للعرض لا يصلح لمنتج يُسعَّر تلقائياً؛ استخدم خصماً بالنسبة أو بالمبلغ.',
    en: "A fixed offer price can't be used on an automatically priced product; use a percentage or amount discount.",
    ckb: 'نرخی جێگیری ئۆفەر بۆ بەرهەمێکی نرخدانانی خۆکار ناگونجێت؛ داشکاندنی ڕێژەیی یان بڕێکی دیاریکراو بەکاربهێنە.',
  },

  // ---- master plan v2 check §3.9: codes later steps raise ------------------
  PRICING_CLEAR_INCOMPLETE_CONFIRM: {
    ar: 'مسح هذه القيمة يترك تسعير المنتج غير مكتمل، فلا يستطيع النظام حساب سعره بعد الآن. أكّد ذلك صراحةً إن كنت تقصده.',
    en: "Clearing this value leaves the product's pricing incomplete, and the system can no longer calculate its price. Confirm explicitly if you mean it.",
    ckb: 'سڕینەوەی ئەم بەهایە نرخدانانی بەرهەمەکە ناتەواو دەهێڵێتەوە و ئیتر سیستەمەکە ناتوانێت نرخەکەی هەژمار بکات. ئەگەر مەبەستتە، بە ڕوونی پشتڕاستی بکەرەوە.',
  },
  PRICING_MEASURES_UNCONFIRMED: {
    ar: 'وزن هذا المنتج أو أبعاده مأخوذة من المواصفات العامة ولم تؤكَّد بعد. راجعها وأكّدها قبل تفعيل التسعير التلقائي.',
    en: "This product's weight or dimensions come from its public specifications and are not confirmed yet. Review and confirm them before turning on automatic pricing.",
    ckb: 'کێش یان ئەندازەکانی ئەم بەرهەمە لە تایبەتمەندییە گشتییەکانەوە وەرگیراون و هێشتا پشتڕاست نەکراونەتەوە. پێش چالاککردنی نرخدانانی خۆکار بیانپشکنە و پشتڕاستیان بکەرەوە.',
  },
  PRICING_GATE_ITEMS_MISSING: {
    ar: 'لم تُقبل كل بنود التفعيل الأول للتسعير التلقائي. راجع كل بند وأشّر عليه، ثم أكّد من جديد.',
    en: 'Not every item for the first activation of automatic pricing was accepted. Review and tick each item, then confirm again.',
    ckb: 'هەموو بڕگەکانی یەکەم چالاککردنی نرخدانانی خۆکار قبوڵ نەکراون. هەر بڕگەیەک بپشکنە و نیشانەی لێ بدە، پاشان دووبارە پشتڕاستی بکەرەوە.',
  },
  PRICING_GATE_NOT_CONFIRMED: {
    ar: 'لم يؤكّد الأدمن الرئيسي بعد بنود التفعيل الأول للتسعير التلقائي، فلا يمكن تفعيله لأي منتج قبل ذلك.',
    en: 'The main admin has not yet confirmed the first-activation items for automatic pricing, so it cannot be turned on for any product before that.',
    ckb: 'بەڕێوەبەری سەرەکی هێشتا بڕگەکانی یەکەم چالاککردنی نرخدانانی خۆکاری پشتڕاست نەکردووەتەوە، بۆیە پێش ئەوە بۆ هیچ بەرهەمێک چالاک ناکرێت.',
  },

  // ---- serial scan at preparation (landing round 4, R2) --------------------
  // A non-owner's catalog edit or product save re-checks, inside its own
  // batch, that no product's need for a serial changed under it
  // (`serialAnswerFence`, worker/lib/serialPolicy.ts). When something else
  // changed the sections or the products filed under them between its reads
  // and its write, nothing is written and the admin is asked to reload.
  SERIAL_FILING_CHANGED: {
    ar: 'تغيّرت الأقسام أو المنتجات المصنّفة فيها أثناء الحفظ، فلم يُحفظ شيء. أعد تحميل الصفحة ثم حاول مرة أخرى.',
    en: 'The sections, or the products filed under them, changed while saving, so nothing was saved. Reload the page and try again.',
    ckb: 'بەشەکان، یان ئەو بەرهەمانەی لەژێریاندا دانراون، لە کاتی پاشەکەوتکردندا گۆڕان، بۆیە هیچ پاشەکەوت نەکرا. پەڕەکە نوێ بکەرەوە و دووبارە هەوڵ بدەرەوە.',
  },
} as const satisfies Record<string, CostRefusal>;

export type CostRefusalCode = keyof typeof COST_REFUSALS;

/** True for a code this contract owns. */
export function isCostRefusalCode(code: unknown): code is CostRefusalCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(COST_REFUSALS, code);
}

/** The sentence a server refusal carries: the Arabic, then the English. The client renders by code. */
export function serverMessage(code: CostRefusalCode): string {
  const entry: CostRefusal = COST_REFUSALS[code];
  return `${entry.ar} / ${entry.en}`;
}

/**
 * The server sentence for the EXISTING `PRODUCT_UNAVAILABLE` (a customer, guest
 * or merchant asking about a product whose price is not ready). The client
 * keeps rendering that code through its own cart wording (master plan F19);
 * this is only the fallback the response carries.
 */
export const PRODUCT_UNAVAILABLE_SERVER_MESSAGE = 'هذا المنتج غير متوفر حالياً. / This product is currently unavailable.';
