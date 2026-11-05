/**
 * «السعر التقديري» — THE WORDS AND SHARED NAMES OF AN ESTIMATED PRE-ORDER PRICE
 * (docs/SMART_PRICING.md §5.5, §6, §4.6; migration 0218; DECISIONS rows 278–282).
 *
 * An estimated price is an ordinary published price the owner has not yet
 * confirmed against the supplier. The customer is told so with a small label, a
 * notice, a "Contact us" link and a versioned acknowledgement at checkout, and
 * the order waits at «تم الاستلام» until every estimated line is settled.
 *
 * What a customer may ever read from this file: the sentences below, a boolean
 * label and a line state. Never a source, a supplier price, a flag, a type, a
 * measure or a match (invariant I6) — the owner-only CODES further down carry
 * no figure, and no runtime value here names a private field
 * (tests/estimateStrings.test.ts walks them against FINANCIAL_FIELDS).
 *
 * Who imports it: the Worker and LAZY client chunks only. The two eager card
 * labels are COPIED into src/lib/priceStatus.ts (as `ESTIMATE_TEXT` and
 * `ESTIMATE_SHORT`, about 120 bytes) and that copy is pinned equal to
 * `ESTIMATE_STRINGS.label` / `ESTIMATE_STRINGS.labelShort` by
 * tests/estimateStorefrontUi.test.ts; the refusal sentences stay out of the
 * eager src/lib/refusalStrings.ts (the entry chunk's budget) and every screen
 * that can receive one resolves it through `estimateRefusalText` first — except
 * the customer's trade-in screens, which carry a copy of the three refusals
 * their doors answer (`ESTIMATE_REFUSAL_COPY` in
 * src/components/tradeIn/parts.tsx, pinned equal by
 * tests/tradeInEstimateRefusal.test.ts), so a /trade-in visit never loads this
 * file.
 *
 * Every `ckb` is its own Sorani, never the Arabic or the English pasted across
 * (DECISIONS row 183), written with the codebase's own words: «خەمڵێنراو»
 * (estimated), «پێشداواکاری» (pre-order), «پەیوەندیمان پێوە بکە» (contact us),
 * «دابینکەر» (supplier), «جزدان» (wallet), «پەسەند» (approve). A native review
 * is still recommended (owner question 282(k)).
 *
 * Pure data and pure functions: no imports.
 */

export type EstimateLang = 'ar' | 'en' | 'ckb';

export interface EstimateText {
  ar: string;
  en: string;
  ckb: string;
}

/**
 * THE VERSION AN ACKNOWLEDGEMENT BINDS TO (§6.2). `POST /api/orders` requires
 * `price_estimate_ack === ESTIMATE_NOTICE_VERSION` whenever a line is
 * estimated, and every estimate line records the version its customer
 * acknowledged. BUMP IT whenever `ESTIMATE_STRINGS.notice` or
 * `ESTIMATE_STRINGS.checkoutAck` changes: a tab still showing the old words
 * then cannot order on them (tests/estimateStrings.test.ts pins the words to
 * this number).
 */
export const ESTIMATE_NOTICE_VERSION = 1;

/** Every sentence a customer can read about an estimated price (§5.5). `{name}` and `{id}` are filled by `fillEstimateText`. */
export const ESTIMATE_STRINGS = {
  /** The card and page label (a muted line under a regular card's price; the chip beside the product page's price). */
  label: {
    ar: 'سعر تقديري',
    en: 'Estimated price',
    ckb: 'نرخی خەمڵێنراو',
  },
  /** The compact card's second line. */
  labelShort: {
    ar: 'تقديري',
    en: 'Estimate',
    ckb: 'خەمڵێنراو',
  },
  /** Under the product page's price card, and at checkout. Bound to ESTIMATE_NOTICE_VERSION. */
  notice: {
    ar: 'هذا سعر تقديري للطلب المسبق، وقد يختلف السعر النهائي عند تأكيد طلبك مع المورّد. إن تغيّر السعر نرسله إليك لتوافق عليه أو تلغي الطلب، ولا نأخذ أي مبلغ إضافي دون موافقتك.',
    en: 'This is an estimated pre-order price. The final price may differ once we confirm your order with the supplier. If it changes, we send you the new price to approve or cancel — nothing extra is charged without your approval.',
    ckb: 'ئەمە نرخێکی خەمڵێنراوە بۆ پێشداواکاری، و لەوانەیە نرخی کۆتایی جیاواز بێت کاتێک داواکارییەکەت لەگەڵ دابینکەر پشتڕاست دەکەینەوە. ئەگەر نرخەکە گۆڕا، نرخە نوێیەکەت بۆ دەنێرین تا پەسەندی بکەیت یان داواکارییەکە هەڵبوەشێنیتەوە — بەبێ ڕەزامەندیی تۆ هیچ بڕە پارەیەکی زیاتر وەرناگیرێت.',
  },
  /** The small link to /support?ask=price_estimate. */
  contact: {
    ar: 'تواصل معنا لمزيد من المعلومات',
    en: 'Contact us for more information',
    ckb: 'بۆ زانیاریی زیاتر پەیوەندیمان پێوە بکە',
  },
  /** One note under the cart's total. */
  cartNotice: {
    ar: 'في سلتك منتجات بسعر تقديري؛ قد يختلف سعرها النهائي، وسنطلب موافقتك قبل أي مبلغ إضافي.',
    en: 'Your cart has items at an estimated price. Their final price may differ, and we will ask for your approval before charging anything extra.',
    ckb: 'لە سەبەتەکەتدا بەرهەمی بە نرخی خەمڵێنراو هەیە؛ لەوانەیە نرخی کۆتاییان جیاواز بێت، و پێش وەرگرتنی هەر بڕە پارەیەکی زیاتر ڕەزامەندیت وەردەگرین.',
  },
  /** The REQUIRED checkbox at checkout. Bound to ESTIMATE_NOTICE_VERSION. */
  checkoutAck: {
    ar: 'أفهم أن أسعار المنتجات المعلَّمة «سعر تقديري» قد تتغيّر، وأن طلبي لا يُجهَّز قبل تأكيد السعر النهائي، وأن أي تغيير سيُعرض عليّ لأوافق عليه أو ألغي الطلب قبل تحصيله.',
    en: 'I understand that items marked “Estimated price” may change in price, that my order is not prepared until the final price is confirmed, and that any change will be sent to me to approve or cancel before it is charged.',
    ckb: 'تێدەگەم کە نرخی ئەو بەرهەمانەی نیشانەی «نرخی خەمڵێنراو»یان هەیە لەوانەیە بگۆڕێت، و داواکارییەکەم ئامادە ناکرێت تا نرخی کۆتایی پشتڕاست نەکرێتەوە، و هەر گۆڕانکارییەک پێش وەرگرتنی پارەکەی بۆم دەنێردرێت تا پەسەندی بکەم یان داواکارییەکە هەڵبوەشێنمەوە.',
  },
  /** The checkout button when any line is estimated. */
  checkoutButton: {
    ar: 'اطلب بالسعر التقديري',
    en: 'Order at the estimated price',
    ckb: 'بە نرخی خەمڵێنراو داوا بکە',
  },
  /** The line under the button: the customer may leave until the price is settled. */
  checkoutCancel: {
    ar: 'حتى تأكيد السعر النهائي يمكنك إلغاء الطلب واسترداد ما دفعته.',
    en: 'Until the final price is confirmed, you can cancel the order and get back what you paid.',
    ckb: 'تا نرخی کۆتایی پشتڕاست نەکرێتەوە، دەتوانیت داواکارییەکە هەڵبوەشێنیتەوە و ئەوەی داوتە وەربگریتەوە.',
  },
  /** The state chip of an estimated order line (`estimateLineText` maps every state). */
  line: {
    open: {
      ar: 'بانتظار تأكيد السعر النهائي',
      en: 'Awaiting final price confirmation',
      ckb: 'چاوەڕێی پشتڕاستکردنەوەی نرخی کۆتایی',
    },
    proposed: {
      ar: 'مطلوب موافقتك على السعر النهائي',
      en: 'Your approval of the final price is needed',
      ckb: 'پێویستە نرخی کۆتایی پەسەند بکەیت',
    },
    /** Also the `approved` state's chip. */
    confirmed: {
      ar: 'تأكّد السعر النهائي',
      en: 'Final price confirmed',
      ckb: 'نرخی کۆتایی پشتڕاست کرایەوە',
    },
    rejected: {
      ar: 'رفضت السعر النهائي — يمكنك إلغاء الطلب واسترداد ما دفعته، أو انتظار تواصلنا.',
      en: 'You rejected the final price — you can cancel the order and get back what you paid, or wait for us to contact you.',
      ckb: 'نرخی کۆتاییت ڕەت کردەوە — دەتوانیت داواکارییەکە هەڵبوەشێنیتەوە و ئەوەی داوتە وەربگریتەوە، یان چاوەڕێی پەیوەندیی ئێمە بیت.',
    },
  },
  /** The order-placed message's added sentence (a server text: it reaches old tabs too). */
  orderPlaced: {
    ar: 'طلبك يتضمّن منتجات بسعر تقديري؛ سنؤكد السعر النهائي قبل الطلب من المورّد ونطلب موافقتك إن تغيّر.',
    en: 'Your order includes items at an estimated price; we will confirm the final price before ordering from the supplier and ask for your approval if it changes.',
    ckb: 'داواکارییەکەت بەرهەمی بە نرخی خەمڵێنراوی تێدایە؛ پێش داواکردن لە دابینکەر نرخی کۆتایی پشتڕاست دەکەینەوە و ئەگەر گۆڕا ڕەزامەندیت وەردەگرین.',
  },
  /** The in-app notice when every line is confirmed at its estimate. `{id}`: the order id. */
  confirmedNoChange: {
    ar: 'تأكّد السعر النهائي لطلبك {id} دون تغيير.',
    en: 'The final price of your order {id} is confirmed — no change.',
    ckb: 'نرخی کۆتایی داواکارییەکەت {id} بەبێ گۆڕانکاری پشتڕاست کرایەوە.',
  },
  /**
   * The in-app notice when the total stays the same but some line is confirmed
   * at a final price other than its estimate (§6.5); its body lists those
   * lines, estimate → final. `{id}`: the order id.
   */
  confirmedTotalUnchanged: {
    ar: 'تأكّدت الأسعار النهائية لطلبك {id}: تغيّر سعر بعض المنتجات، ولم يتغيّر الإجمالي.',
    en: 'The final prices of your order {id} are confirmed: some item prices changed, but the total is unchanged.',
    ckb: 'نرخە کۆتاییەکانی داواکارییەکەت {id} پشتڕاست کرانەوە: نرخی هەندێک بەرهەم گۆڕا، بەڵام کۆی گشتی نەگۆڕا.',
  },
  /** The 0140 proposal's reason when `reason_code` is ESTIMATE_FINAL_PRICE. */
  estimateReason: {
    ar: 'تأكّد سعر المورّد النهائي لمنتجات طلبتها بسعر تقديري.',
    en: "The supplier's final price is now confirmed for items you ordered at an estimated price.",
    ckb: 'نرخی کۆتایی دابینکەر بۆ ئەو بەرهەمانەی بە نرخی خەمڵێنراو داوات کردبوون ئێستا پشتڕاست کرایەوە.',
  },
  /** The approval card's estimate variant: what a rejection leads to. */
  estimateRejectNote: {
    ar: 'إن رفضت السعر الجديد فإما أن نُبقي سعرك الأصلي أو نلغي الطلب ونعيد لك كامل المبلغ، ويمكنك أنت أيضًا إلغاء الطلب.',
    en: 'If you reject the new price, we either keep your original price or cancel the order and refund you in full; you can also cancel the order yourself.',
    ckb: 'ئەگەر نرخە نوێیەکە ڕەت بکەیتەوە، یان نرخە سەرەتاییەکەت دەهێڵینەوە یان داواکارییەکە هەڵدەوەشێنینەوە و هەموو پارەکەت دەگەڕێنینەوە؛ هەروەها خۆشت دەتوانیت داواکارییەکە هەڵبوەشێنیتەوە.',
  },
  /** The support assistant's `price_estimate` intent (§5.4). `{name}`: the product's name. */
  support: {
    chip: {
      ar: 'ما معنى السعر التقديري؟',
      en: 'What does “estimated price” mean?',
      ckb: 'نرخی خەمڵێنراو مانای چییە؟',
    },
    answer: {
      ar: 'السعر التقديري هو السعر المتوقَّع لطلب مسبق قبل أن يؤكّده المورّد. نؤكد السعر النهائي عند طلب منتجك من المورّد، وإن تغيّر نرسل لك السعر الجديد لتوافق عليه أو تلغي الطلب. هل تريد التحدث مع فريقنا؟',
      en: 'An estimated price is our expected price for a pre-order before the supplier confirms it. We confirm the final price when we order your item from the supplier; if it changes, we send you the new price to approve or cancel. Would you like to talk to our team?',
      ckb: 'نرخی خەمڵێنراو ئەو نرخەیە کە بۆ پێشداواکاری چاوەڕێی دەکەین پێش ئەوەی دابینکەر پشتڕاستی بکاتەوە. کاتێک بەرهەمەکەت لە دابینکەر داوا دەکەین نرخی کۆتایی پشتڕاست دەکەینەوە؛ ئەگەر گۆڕا، نرخە نوێیەکەت بۆ دەنێرین تا پەسەندی بکەیت یان داواکارییەکە هەڵبوەشێنیتەوە. دەتەوێت لەگەڵ تیمەکەمان قسە بکەیت؟',
    },
    subject: {
      ar: 'سؤال عن السعر التقديري: {name}',
      en: 'Question about the estimated price: {name}',
      ckb: 'پرسیار دەربارەی نرخی خەمڵێنراو: {name}',
    },
  },
  /** The price-request sweep's title when the requested product became an estimate. `{name}`: the product's name. */
  priceRequest: {
    title: {
      ar: '{name} متاح الآن للطلب المسبق بسعر تقديري',
      en: '{name} can now be pre-ordered at an estimated price',
      ckb: '{name} ئێستا بە نرخی خەمڵێنراو بۆ پێشداواکاری بەردەستە',
    },
  },
} as const satisfies Record<string, EstimateText | Record<string, EstimateText>>;

/** The support assistant's intent and the `/support?ask=` value the contact link opens (§5.4). */
export const ESTIMATE_SUPPORT_INTENT = 'price_estimate';

/**
 * Fills `{name}` and `{id}` in every language. A name given in three languages
 * is used per language, falling back to another language when one is empty
 * (as `priceAvailableMessage` does for price requests).
 */
export function fillEstimateText(text: EstimateText, vars: { name?: EstimateText | string; id?: string } = {}): EstimateText {
  const nameIn = (lang: EstimateLang): string => {
    const n = vars.name;
    if (n === undefined) return '{name}';
    if (typeof n === 'string') return n;
    const order: EstimateLang[] = lang === 'en' ? ['en', 'ar', 'ckb'] : lang === 'ckb' ? ['ckb', 'ar', 'en'] : ['ar', 'en', 'ckb'];
    return order.map((l) => n[l]).find((s) => typeof s === 'string' && s.trim() !== '') ?? '';
  };
  const fill = (template: string, lang: EstimateLang): string => {
    let out = template.split('{name}').join(nameIn(lang));
    if (vars.id !== undefined) out = out.split('{id}').join(vars.id);
    return out;
  };
  return { ar: fill(text.ar, 'ar'), en: fill(text.en, 'en'), ckb: fill(text.ckb, 'ckb') };
}

// ---------------------------------------------------------------- order lines

/** Every state of an `order_price_estimates` row (migration 0218's CHECK). */
export const ESTIMATE_LINE_STATES = ['open', 'proposed', 'confirmed', 'approved', 'rejected', 'void'] as const;
export type EstimateLineState = (typeof ESTIMATE_LINE_STATES)[number];

/** The states that hold an order at «تم الاستلام» (trigger T8, the gate). */
export const ESTIMATE_UNSETTLED_STATES = ['open', 'proposed', 'rejected'] as const satisfies readonly EstimateLineState[];

/** A settled line: confirmed at its estimate or at a final price, or approved by the customer. */
export const ESTIMATE_SETTLED_STATES = ['confirmed', 'approved'] as const satisfies readonly EstimateLineState[];

export const isEstimateLineState = (v: unknown): v is EstimateLineState =>
  typeof v === 'string' && (ESTIMATE_LINE_STATES as readonly string[]).includes(v);

/** The chip of a line's state; `void` (a cancelled order's line) has none. */
export function estimateLineText(state: EstimateLineState, lang: EstimateLang): string | null {
  switch (state) {
    case 'open':
      return ESTIMATE_STRINGS.line.open[lang];
    case 'proposed':
      return ESTIMATE_STRINGS.line.proposed[lang];
    case 'confirmed':
    case 'approved':
      return ESTIMATE_STRINGS.line.confirmed[lang];
    case 'rejected':
      return ESTIMATE_STRINGS.line.rejected[lang];
    default:
      return null;
  }
}

/** `order_price_adjustments.reason_code` of a 0140 proposal that settles estimate lines (migration 0218). */
export const ESTIMATE_REASON_CODE = 'ESTIMATE_FINAL_PRICE';

// ---------------------------------------------------------------- refusals

/**
 * Who can receive a refusal:
 *   customer — a shopper's screen (product, cart, checkout, order);
 *   staff    — any admin's order screens;
 *   owner    — the owner's estimates workspace only (cost-read doors).
 */
export type EstimateRefusalAudience = 'customer' | 'staff' | 'owner';

export interface EstimateRefusal extends EstimateText {
  status: 400 | 409 | 502 | 503;
  audience: EstimateRefusalAudience;
}

/**
 * Every refusal the estimate feature answers, by CODE. The server sends
 * `estimateServerMessage(code)` ("ar / en") as the fallback sentence; a client
 * renders the viewer's language with `estimateRefusalText` before `apiRefusal`.
 * A refusal carries no figure, id or field value.
 */
export const ESTIMATE_REFUSALS = {
  // ---- customers (§5.5) -----------------------------------------------------
  /** Checkout without the current acknowledgement; answered with the fresh quote. */
  PRICE_ESTIMATE_ACK_REQUIRED: {
    status: 409,
    audience: 'customer',
    ar: 'في طلبك منتجات بسعر تقديري. راجع الملاحظة وأكّد أنك تفهم أن السعر قد يتغيّر، ثم أعد المحاولة.',
    en: 'Your order has items at an estimated price. Read the note and confirm that you understand the price may change, then try again.',
    ckb: 'لە داواکارییەکەتدا بەرهەمی بە نرخی خەمڵێنراو هەیە. تێبینییەکە بخوێنەوە و پشتڕاستی بکەرەوە کە تێدەگەیت نرخەکە لەوانەیە بگۆڕێت، پاشان دووبارە هەوڵ بدەرەوە.',
  },
  /** BNPL or Gini posted for an order with an estimated line (a financed order could never be settled). */
  PRICE_ESTIMATE_PAYMENT_NOT_ALLOWED: {
    status: 400,
    audience: 'customer',
    ar: 'المنتجات بسعر تقديري تُدفع مقدمًا من المحفظة أو نقدًا عند التسليم فقط.',
    en: 'Items at an estimated price can be paid only in advance from the wallet or in cash on delivery.',
    ckb: 'بەرهەمی بە نرخی خەمڵێنراو تەنها بە پارەدانی پێشوەخت لە جزدانەوە یان پارەدان لە کاتی گەیاندن دەکڕدرێت.',
  },
  /** A direct-sale line of an estimated SKU. */
  PRICE_ESTIMATE_PREORDER_ONLY: {
    status: 409,
    audience: 'customer',
    ar: 'هذا المنتج متاح بالطلب المسبق فقط لأن سعره تقديري.',
    en: 'This item is available by pre-order only, because its price is an estimate.',
    ckb: 'ئەم بەرهەمە تەنها بە پێشداواکاری بەردەستە، چونکە نرخەکەی خەمڵێنراوە.',
  },
  /** Quick Buy of an estimated SKU. */
  PRICE_ESTIMATE_QUICK_BUY: {
    status: 409,
    audience: 'customer',
    ar: 'الشراء السريع غير متاح لمنتج بسعر تقديري؛ أضفه إلى السلة لتراجع الملاحظة.',
    en: 'Quick Buy is not available for an item at an estimated price; add it to the cart to review the note.',
    ckb: 'کڕینی خێرا بۆ بەرهەمی بە نرخی خەمڵێنراو بەردەست نییە؛ بیخەرە سەبەتەکەتەوە بۆ ئەوەی تێبینییەکە ببینیت.',
  },
  /** The owner's emergency brake (`price_estimate_control.ordering_enabled = 0`). */
  PRICE_ESTIMATE_ORDERING_PAUSED: {
    status: 409,
    audience: 'customer',
    ar: 'الطلب بالسعر التقديري متوقف مؤقتًا لهذا المنتج. تواصل معنا لمزيد من المعلومات.',
    en: 'Ordering at the estimated price is paused for this item for now. Contact us for more information.',
    ckb: 'داواکردن بە نرخی خەمڵێنراو بۆ ئەم بەرهەمە بە شێوەیەکی کاتی ڕاگیراوە. بۆ زانیاریی زیاتر پەیوەندیمان پێوە بکە.',
  },
  /** A price-protection claim on a line whose final price is not settled yet. */
  PRICE_PROTECTION_ESTIMATE_PENDING: {
    status: 409,
    audience: 'customer',
    ar: 'تبدأ حماية السعر لهذا المنتج بعد تأكيد سعره النهائي.',
    en: 'Price protection for this item starts once its final price is confirmed.',
    ckb: 'پاراستنی نرخ بۆ ئەم بەرهەمە دوای پشتڕاستکردنەوەی نرخی کۆتایی دەست پێدەکات.',
  },
  /**
   * The estimate state could not be read, so the door refuses rather than guess
   * (fail closed, §2.4): the checkout reading the owner's ordering switch for a
   * labelled line, and the courier door's pre-check. Nothing was written.
   */
  PRICE_ESTIMATES_READ_FAILED: {
    status: 503,
    audience: 'customer',
    ar: 'تعذّرت قراءة الأسعار التقديرية الآن؛ لم يتغيّر شيء ولم يُخصم أي مبلغ. أعد المحاولة بعد لحظة.',
    en: 'Estimated prices could not be read just now; nothing was changed and nothing was charged. Try again in a moment.',
    ckb: 'نرخە خەمڵێنراوەکان ئێستا نەخوێندرانەوە؛ هیچ شتێک نەگۆڕا و هیچ پارەیەک وەرنەگیرا. کەمێکی تر دووبارە هەوڵ بدەرەوە.',
  },
  // ---- staff (any admin's order doors, §6.4–6.7) ------------------------------
  /** Confirm, preparation, shipping or courier booking while a line is unsettled (trigger T8). */
  PRICE_ESTIMATE_UNCONFIRMED: {
    status: 409,
    audience: 'staff',
    ar: 'لا يمكن تأكيد هذا الطلب أو تجهيزه أو شحنه قبل تأكيد السعر النهائي لمنتجاته التقديرية.',
    en: 'This order cannot be confirmed, prepared or shipped until the final price of its estimated items is confirmed.',
    ckb: 'ئەم داواکارییە ناتوانرێت پشتڕاست بکرێتەوە یان ئامادە بکرێت یان بنێردرێت تا نرخی کۆتایی بەرهەمە خەمڵێنراوەکانی پشتڕاست نەکرێتەوە.',
  },
  /** Reopening a cancelled order that has estimate lines (trigger T9). */
  PRICE_ESTIMATE_REOPEN_REFUSED: {
    status: 409,
    audience: 'staff',
    ar: 'لا يُعاد فتح طلب ملغى فيه منتجات بسعر تقديري؛ يضع الزبون طلبًا جديدًا.',
    en: 'A cancelled order with items at an estimated price is not reopened; the customer places a new order.',
    ckb: 'داواکارییەکی هەڵوەشاوە کە بەرهەمی بە نرخی خەمڵێنراوی تێدایە دووبارە ناکرێتەوە؛ کڕیار داواکارییەکی نوێ دەکات.',
  },
  /** An ordinary 0140 proposal on an order with unsettled estimate lines. */
  PRICE_ESTIMATE_OPEN: {
    status: 409,
    audience: 'staff',
    ar: 'لهذا الطلب أسعار تقديرية لم تُؤكَّد بعد؛ استخدم «تأكيد السعر النهائي» بدل تعديل السعر العادي.',
    en: 'This order has estimated prices that are not confirmed yet; use “Confirm the final price” instead of an ordinary price change.',
    ckb: 'ئەم داواکارییە نرخی خەمڵێنراوی پشتڕاستنەکراوەی هەیە؛ لە جیاتی گۆڕینی ئاسایی نرخ، «پشتڕاستکردنەوەی نرخی کۆتایی» بەکاربهێنە.',
  },
  // ---- the owner (the estimates workspace; shown only in the admin chunks) ----
  /** Any owner estimate route on a database without migration 0218 (the shape of PRICING_NOT_INSTALLED). */
  PRICE_ESTIMATES_NOT_INSTALLED: {
    status: 503,
    audience: 'owner',
    ar: 'التسعير التقديري لم يُجهَّز بعد على قاعدة البيانات هذه؛ حاول بعد قليل.',
    en: 'Estimated pricing is not set up on this database yet; try again shortly.',
    ckb: 'نرخدانانی خەمڵێنراو هێشتا لەم بنکەدراوەیە ڕێکنەخراوە؛ کەمێکی تر هەوڵ بدەرەوە.',
  },
  /** Apply while the owner's «apply» switch is off. */
  PRICE_ESTIMATES_DISABLED: {
    status: 409,
    audience: 'owner',
    ar: 'تطبيق الأسعار التقديرية متوقف؛ شغّله من «التسعير التقديري» أولًا.',
    en: 'Applying estimated prices is switched off; switch it on in “Estimated pricing” first.',
    ckb: 'جێبەجێکردنی نرخە خەمڵێنراوەکان ڕاگیراوە؛ سەرەتا لە بەشی «نرخدانانی خەمڵێنراو» هەڵیبکە.',
  },
  /** Switching «apply» on before the purchase policy in force carries the estimate clause (row 280). */
  PRICE_ESTIMATE_POLICY_MISSING: {
    status: 409,
    audience: 'owner',
    ar: 'لا يمكن تشغيل التسعير التقديري قبل نشر سياسة الشراء التي تتضمن بند السعر التقديري.',
    en: 'Estimated pricing cannot be switched on until the purchase policy with the estimated-price clause is published.',
    ckb: 'نرخدانانی خەمڵێنراو هەڵناکرێت تا ئەو سیاسەتی کڕینەی بەندی نرخی خەمڵێنراوی تێدایە بڵاو نەکرێتەوە.',
  },
  /** Apply of a product a blocking flag or §4.7 keeps out; answered with the flag CODES. */
  PRICE_ESTIMATE_NOT_ELIGIBLE: {
    status: 409,
    audience: 'owner',
    ar: 'لا يمكن تطبيق سعر تقديري على هذا المنتج الآن؛ راجع الملاحظات المذكورة ثم احسب من جديد.',
    en: 'An estimated price cannot be applied to this product right now; review the listed flags, then compute again.',
    ckb: 'ئێستا ناتوانرێت نرخی خەمڵێنراو بۆ ئەم بەرهەمە جێبەجێ بکرێت؛ بە تێبینییە نیشاندراوەکاندا بچۆرەوە، پاشان دووبارە هەژمار بکەرەوە.',
  },
  /** Confirmation while any targeted SKU is priced from a type-default measure — never overridable (owner decision D2). */
  PRICE_ESTIMATE_DEFAULT_MEASURES: {
    status: 409,
    audience: 'owner',
    ar: 'لا يُرفع وسم «سعر تقديري» ما دام سعر بعض الموديلات محسوبًا من وزن أو صندوق افتراضي؛ أدخل الوزن والصندوق الحقيقيين أولًا.',
    en: 'The “Estimated price” label cannot be removed while some models are priced from a default weight or box; enter the real weight and box first.',
    ckb: 'نیشانەی «نرخی خەمڵێنراو» لانابرێت تا نرخی هەندێک مۆدێل لە کێش یان سندوقی بنەڕەتی هەژمار کرابێت؛ سەرەتا کێش و سندوقی ڕاستەقینە بنووسە.',
  },
  /** Confirmation with a soft flag not named in `accept_flags`; answered with the open CODES. */
  PRICE_ESTIMATE_FLAGS_OPEN: {
    status: 409,
    audience: 'owner',
    ar: 'ما زالت على هذا السعر التقديري ملاحظات مفتوحة؛ راجع كل ملاحظة واقبلها صراحةً قبل التأكيد.',
    en: 'This estimate still has open flags; review each one and accept it explicitly before confirming.',
    ckb: 'ئەم نرخە خەمڵێنراوە هێشتا تێبینیی کراوەی هەیە؛ پێش پشتڕاستکردنەوە بە هەر تێبینییەکدا بچۆرەوە و بە ڕوونی پەسەندی بکە.',
  },
  /**
   * The owner's one-page store read (§3.6 `POST /read-store-page`) gave no
   * price: the store refused the read or answered a bot check, or the page
   * carried no JSON-LD offers. Nothing was saved; the owner types the price.
   */
  PRICE_ESTIMATE_STORE_PAGE_UNREADABLE: {
    status: 502,
    audience: 'owner',
    ar: 'تعذّرت قراءة صفحة المتجر: رفضها المتجر أو طلب التحقق من أن الزائر ليس برنامجًا آليًّا، أو لم تحمل الصفحة أسعارًا. لم يُحفظ شيء؛ اكتب السعر بنفسك أو أعد المحاولة لاحقًا.',
    en: 'The store page could not be read: the store refused it or asked for a bot check, or the page carried no prices. Nothing was saved; type the price yourself or try again later.',
    ckb: 'پەڕەی فرۆشگاکە نەخوێندرایەوە: فرۆشگاکە ڕەتی کردەوە یان پشکنینی ڕۆبۆتی داوا کرد، یان پەڕەکە هیچ نرخێکی تێدا نەبوو. هیچ شتێک پاشەکەوت نەکرا؛ نرخەکە خۆت بنووسە یان دواتر دووبارە هەوڵ بدەرەوە.',
  },
  /** A type, sourcing or route override that breaks its type's rules (trigger T5). */
  PRICE_ESTIMATE_TYPE_RULE: {
    status: 409,
    audience: 'owner',
    ar: 'هذا المسار لا يناسب نوع المنتج: الخيوط تُشحن بحرًا فقط، ومنتجات المتجر الأوروبي برًّا فقط، والشحن الجوي فقط حيث يسمح به النوع.',
    en: "This route does not fit the product's type: filament travels by sea only, EU-store items by land only, and air only where the type allows it.",
    ckb: 'ئەم ڕێگایە لەگەڵ جۆری بەرهەمەکە ناگونجێت: فیلامێنت تەنها بە ڕێگای دەریایی دەنێردرێت، بەرهەمەکانی فرۆشگای ئەوروپا تەنها بە ڕێگای وشکانی، و ڕێگای ئاسمانی تەنها بۆ ئەو جۆرانەی ڕێگەی پێدەدەن.',
  },
  /**
   * Saving the owner's own supplier links on a database without migration 0223
   * (docs/SMART_PRICING.md §3.10, DECISIONS row 293). Nothing was saved; the
   * read still answers, with the matched links and `installed: false`.
   */
  SUPPLIER_LINKS_NOT_INSTALLED: {
    status: 503,
    audience: 'owner',
    ar: 'حفظ روابط المورّد لم يُجهَّز بعد على قاعدة البيانات هذه؛ لم يُحفظ شيء، حاول بعد قليل.',
    en: 'Saving supplier links is not set up on this database yet; nothing was saved, try again shortly.',
    ckb: 'پاشەکەوتکردنی بەستەرەکانی دابینکەر هێشتا لەم بنکەدراوەیە ڕێکنەخراوە؛ هیچ شتێک پاشەکەوت نەکرا، کەمێکی تر هەوڵ بدەرەوە.',
  },
} as const satisfies Record<string, EstimateRefusal>;

export type EstimateRefusalCode = keyof typeof ESTIMATE_REFUSALS;

export const isEstimateRefusalCode = (code: unknown): code is EstimateRefusalCode =>
  typeof code === 'string' && Object.prototype.hasOwnProperty.call(ESTIMATE_REFUSALS, code);

/**
 * The viewer's sentence for an estimate refusal, or null when the code is not
 * one of ours (the caller then falls back to `apiRefusal`). Takes the code, or
 * the refusal itself (`{ code }`, as an API error carries it).
 */
export function estimateRefusalText(code: unknown, lang: EstimateLang): string | null {
  const c = code !== null && typeof code === 'object' ? (code as { code?: unknown }).code : code;
  if (!isEstimateRefusalCode(c)) return null;
  const entry: EstimateRefusal = ESTIMATE_REFUSALS[c];
  return entry[lang] ?? entry.ar;
}

/** The server's fallback sentence ("ar / en"), the shape `serverMessage` gives the cost refusals. */
export function estimateServerMessage(code: EstimateRefusalCode): string {
  const entry: EstimateRefusal = ESTIMATE_REFUSALS[code];
  return `${entry.ar} / ${entry.en}`;
}

// ---------------------------------------------------------------- the database's own words

/**
 * The RAISE(ABORT) messages of migration 0218's triggers. The server matches
 * them (and maps them to a refusal above); they are never shown as a sentence.
 * tests/migration0218PriceEstimates.test.ts pins each to its trigger.
 */
export const ESTIMATE_DB_ABORTS = {
  /** T1 / T3: the label set outside a V2 price write, or a product born labelled. */
  LABEL_OUTSIDE_PRICE_WRITE: 'PRICE_ESTIMATE_LABEL_OUTSIDE_PRICE_WRITE',
  /** T2: the label cleared without the owner's confirmation on real measures. */
  LABEL_CLEAR_REFUSED: 'PRICE_ESTIMATE_LABEL_CLEAR_REFUSED',
  /** T4: a firm SKU on an unlabelled product. */
  FIRM_UNLABELLED: 'PRICE_ESTIMATE_FIRM_UNLABELLED',
  /** T5: an override against its type's rules. */
  TYPE_RULE: 'PRICE_ESTIMATE_TYPE_RULE',
  /** T6: a line of a labelled product outside the estimate checkout. */
  CHECKOUT_REQUIRED: 'PRICE_ESTIMATE_CHECKOUT_REQUIRED',
  /** T7: an estimate row outside its order's checkout batch. */
  LINE_OUTSIDE_CHECKOUT: 'PRICE_ESTIMATE_LINE_OUTSIDE_CHECKOUT',
  /** T7: an estimate row's identity changed. */
  LINE_FROZEN: 'PRICE_ESTIMATE_LINE_FROZEN',
  /** T8: the gate. */
  UNCONFIRMED: 'PRICE_ESTIMATE_UNCONFIRMED',
  /** T9: a cancelled estimate order reopened. */
  REOPEN_REFUSED: 'PRICE_ESTIMATE_REOPEN_REFUSED',
} as const;

// ---------------------------------------------------------------- owner-only flag codes
//
// THE ESTIMATOR'S FLAG CODES (§4.6) — owner-only, stored in `flags_json` and
// answered only behind the cost-read door; never in a customer payload. The
// words for them live in the owner's workspace (src/components/adminEstimates/
// strings.ts). The evaluation's own codes (FX_RATE_MISSING,
// V2_ROUTE_BELOW_COST, …) block an apply too and keep their own names.

/** Blocking: the product is not applied. */
export const ESTIMATE_BLOCKING_FLAGS = [
  'EST_TYPE_MISSING',
  'EST_TYPE_INCOMPLETE',
  'EST_NO_PRICE',
  'EST_MATCH_REVIEW',
  'EST_PACK_MISMATCH',
  'EST_TYPE_MISMATCH',
  'EST_STRUCTURE_OWNER',
  'EST_FIRM_PRICE',
  'EST_METHOD_OWNER',
  'EST_PURCHASE_REVIEW_PENDING',
  'EST_TOO_MANY_SCOPES',
  'EST_IMPORT_RUNNING',
] as const;

/** Published as an estimate; the label can NEVER be removed while one is open (trigger T2, owner decision D2). */
export const ESTIMATE_HARD_FLAGS = ['EST_DEFAULT_WEIGHT', 'EST_DEFAULT_BOX'] as const;

/** Published as an estimate; the label is removed only when the owner names each in `accept_flags`. */
export const ESTIMATE_SOFT_FLAGS = [
  'EST_US_REFERENCE',
  'EST_MANUAL_PRICE',
  'EST_STORE_PAGE_PRICE',
  'EST_UNITS_DIVIDED',
  'EST_SNAPSHOT_STALE',
  'EST_SOURCE_ITEM_MISSING',
  'EST_SUPPLIER_OUT_OF_STOCK',
] as const;

/** Information only. */
export const ESTIMATE_INFO_FLAGS = ['EST_OWNER_EDITED', 'EST_LARGE_CHANGE_HELD'] as const;

export type EstimateFlag =
  | (typeof ESTIMATE_BLOCKING_FLAGS)[number]
  | (typeof ESTIMATE_HARD_FLAGS)[number]
  | (typeof ESTIMATE_SOFT_FLAGS)[number]
  | (typeof ESTIMATE_INFO_FLAGS)[number];
