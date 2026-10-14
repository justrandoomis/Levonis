/**
 * WHO MAY MOVE MONEY IN THE SERVICES — the refusals, in the three languages.
 *
 * Owner decision 3 (docs/DECISIONS.md row 223, Services V2 plan §3.5):
 *
 *   assistant        never moves money: no refund, no credit, no valuation,
 *                    no warranty lengthening — 403 FINANCIAL_SCOPE_REQUIRED,
 *                    whatever the amount.
 *   financial admin  up to what the SERVER computes for the act (the trade-in
 *                    estimate, a price-protection credit up to the owner line,
 *                    a refund of what was paid).
 *   the owner        above that, with a recorded reason flagged in reports;
 *                    and alone for the owner-only acts (any warranty
 *                    lengthening, a later delivery date, a whole-unit
 *                    replacement, the trade-in valuation rules, a public
 *                    promo code).
 *
 * The server sends `moneyAuthorityMessage(code)` ("ar / en") as the fallback
 * sentence; the client renders the reader's language by CODE
 * (`src/lib/refusalStrings.ts` spreads this table in). A refusal names no
 * amount and no ceiling: the same answer whatever was asked.
 *
 * Every `ckb` is its own Sorani, never the Arabic pasted across
 * (docs/DECISIONS.md row 183). Pure data: no imports.
 */
export interface MoneyAuthorityRefusal {
  ar: string;
  en: string;
  ckb: string;
}

export const MONEY_AUTHORITY_REFUSALS = {
  // The same two sentences `assertFinancialScope` has always sent, now with Sorani.
  FINANCIAL_SCOPE_REQUIRED: {
    ar: 'هذا الإجراء للمالك أو الدور المالي فقط',
    en: 'This action needs the owner or a financial admin',
    ckb: 'ئەم کارە تەنها بۆ خاوەن یان بەڕێوەبەری داراییە',
  },
  OWNER_REQUIRED: {
    ar: 'هذا الإجراء أو هذا المبلغ يحتاج موافقة الأدمن الرئيسي.',
    en: "This action or amount needs the main admin's approval.",
    ckb: 'ئەم کارە یان ئەم بڕە پێویستی بە ڕەزامەندیی بەڕێوەبەری سەرەکی هەیە.',
  },
  OWNER_REASON_REQUIRED: {
    ar: 'اكتب سبب هذا القرار (خمسة أحرف على الأقل)؛ يُسجَّل معه ويُعلَّم في التقارير.',
    en: 'Write the reason for this decision (at least five characters); it is recorded with it and flagged in reports.',
    ckb: 'هۆکاری ئەم بڕیارە بنووسە (لانیکەم پێنج پیت)؛ لەگەڵیدا تۆمار دەکرێت و لە ڕاپۆرتەکاندا نیشانە دەکرێت.',
  },
  // A trade-in credit is a coupon row, but its figure is the request's: the
  // coupon editor neither changes nor retires it (the trade-in desk does).
  TRADE_IN_COUPON_MANAGED: {
    ar: 'هذا رصيد استبدال مرتبط بطلبه؛ يُدار من مكتب الاستبدال لا من محرر الأكواد.',
    en: 'This is a trade-in credit tied to its request; it is managed from the trade-in desk, not the code editor.',
    ckb: 'ئەمە باڵانسی گۆڕینەوەیە و بە داواکارییەکەیەوە بەستراوە؛ لە مێزی گۆڕینەوە بەڕێوە دەبرێت، نەک لە دەستکاریکەری کۆدەکان.',
  },
} as const satisfies Record<string, MoneyAuthorityRefusal>;

export type MoneyAuthorityCode = keyof typeof MONEY_AUTHORITY_REFUSALS;

export const isMoneyAuthorityCode = (code: unknown): code is MoneyAuthorityCode =>
  typeof code === 'string' && Object.prototype.hasOwnProperty.call(MONEY_AUTHORITY_REFUSALS, code);

/** The server's fallback sentence ("ar / en"); the client renders the reader's language by code. */
export function moneyAuthorityMessage(code: MoneyAuthorityCode): string {
  const t = MONEY_AUTHORITY_REFUSALS[code];
  return `${t.ar} / ${t.en}`;
}

/**
 * The price-protection line (decision 3): a financial admin approves a claim
 * up to this many dinars; above it, the owner, with a reason. IQD (row 194).
 */
export const PRICE_PROTECTION_OWNER_LINE_IQD = 250_000;
