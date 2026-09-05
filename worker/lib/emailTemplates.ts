/**
 * Branded LEVONIS email templates (final-phase §3): verification, password
 * reset/security notices and the ORDER INVOICE — the only routine order
 * email. Every template returns HTML **plus a plain-text alternative**, in
 * ar/en/ckb with correct RTL markup for ar/ckb.
 *
 * Rules enforced here:
 * - Inline styles only; no images, no scripts, no web fonts, no tracking
 *   pixels and no analytics query parameters — links are plain app URLs.
 * - Every interpolated value passes through escapeHtml() before entering
 *   the HTML; plain-text bodies never contain markup.
 * - Links are built by the CALLER from the trusted configured origin
 *   (env.APP_ORIGIN) — this module never derives origins itself.
 *
 * Sorani (ckb) copy: written as simple reviewed-style Sorani; flagged in the
 * project docs for native review. Nothing is machine-translated at runtime.
 */

export type EmailLang = 'ar' | 'en' | 'ckb';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function emailLang(v: unknown): EmailLang {
  return v === 'en' || v === 'ckb' ? v : 'ar';
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function dirOf(lang: EmailLang): 'ltr' | 'rtl' {
  return lang === 'en' ? 'ltr' : 'rtl';
}

/** Integer IQD for display — templates never do arithmetic on money. */
function iqd(amount: number): string {
  return `${Math.trunc(amount).toLocaleString('en-US')} IQD`;
}

// ------------------------------------------------------------------ copy

interface Copy {
  brandTagline: string;
  verifySubject: string;
  verifyIntro: string;
  verifyCta: string;
  verifyExpiry: string;
  verifyIgnore: string;
  linkFallback: string;
  resetSubject: string;
  resetIntro: string;
  resetCta: string;
  resetExpiry: string;
  resetIgnore: string;
  changedSubject: string;
  changedBody: string;
  changedWarn: string;
  googleSubject: string;
  googleBody: string;
  googleIgnore: string;
  existsSubject: string;
  existsBody: string;
  existsCta: string;
  existsIgnore: string;
  invoiceSubject: (invoiceNo: string) => string;
  invoiceTitle: string;
  invoiceGreeting: (name: string) => string;
  invoiceIntro: (orderId: string) => string;
  invoiceNoLabel: string;
  orderLabel: string;
  issuedLabel: string;
  revisionLabel: string;
  itemLabel: string;
  qtyLabel: string;
  unitPriceLabel: string;
  lineTotalLabel: string;
  transportFeeLabel: string;
  warrantyFeeLabel: string;
  subtotalLabel: string;
  deliveryLabel: string;
  deliveryWaivedLabel: string;
  couponLabel: string;
  pointsLabel: string;
  walletLabel: string;
  totalLabel: string;
  paidLabel: string;
  dueLabel: string;
  statusLabel: string;
  status: Record<InvoicePaymentStatus, string>;
  invoiceFooter: string;
  viewOrders: string;
}

const COPY_AR: Copy = {
  brandTagline: 'متجر LEVONIS',
  verifySubject: 'تأكيد بريدك الإلكتروني — LEVONIS',
  verifyIntro: 'لتفعيل استلام فواتيرك ورسائل الأمان، يرجى تأكيد ملكية هذا البريد الإلكتروني.',
  verifyCta: 'تأكيد البريد الإلكتروني',
  verifyExpiry: 'هذا الرابط صالح لمدة 24 ساعة ويُستخدم مرة واحدة فقط. فتح الرابط وحده لا يؤكد البريد — يلزم الضغط على زر التأكيد في الصفحة.',
  verifyIgnore: 'إذا لم تنشئ حسابًا في LEVONIS، تجاهل هذه الرسالة بأمان.',
  linkFallback: 'إن لم يعمل الزر، انسخ الرابط التالي إلى المتصفح:',
  resetSubject: 'إعادة تعيين كلمة المرور — LEVONIS',
  resetIntro: 'وصلنا طلب لإعادة تعيين كلمة المرور لحسابك في LEVONIS.',
  resetCta: 'اختيار كلمة مرور جديدة',
  resetExpiry: 'هذا الرابط صالح لمدة 30 دقيقة ويمكن استخدامه مرة واحدة فقط.',
  resetIgnore: 'إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة بأمان.',
  changedSubject: 'تم تغيير كلمة المرور — LEVONIS',
  changedBody: 'تم تغيير كلمة مرور حسابك في LEVONIS للتو، وتم تسجيل الخروج من الجلسات الأخرى.',
  changedWarn: 'إذا لم تقم بذلك، أعد تعيين كلمة المرور فورًا وتواصل مع الدعم.',
  googleSubject: 'محاولة إعادة تعيين كلمة المرور — LEVONIS',
  googleBody:
    'وصلنا طلب لإعادة تعيين كلمة المرور لهذا البريد، لكن هذا الحساب يسجّل الدخول عبر Google ولا يملك كلمة مرور. للدخول استخدم زر «المتابعة عبر Google» في صفحة تسجيل الدخول.',
  googleIgnore: 'إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة بأمان.',
  existsSubject: 'محاولة إنشاء حساب ببريدك — LEVONIS',
  existsBody:
    'حاول شخص إنشاء حساب في LEVONIS بهذا البريد، لكن لديك حسابًا بالفعل. إن كان ذلك أنت فسجّل الدخول بحسابك الحالي، أو أعد تعيين كلمة المرور إن نسيتها.',
  existsCta: 'الذهاب إلى تسجيل الدخول',
  existsIgnore: 'إذا لم يكن ذلك أنت فلا يلزمك أي إجراء — لم يتغيّر شيء في حسابك.',
  invoiceSubject: (invoiceNo) => `فاتورة طلبك ${invoiceNo} — LEVONIS`,
  invoiceTitle: 'فاتورة',
  invoiceGreeting: (name) => (name ? `مرحبًا ${name}،` : 'مرحبًا،'),
  invoiceIntro: (orderId) => `هذه فاتورة طلبك ${orderId} من LEVONIS.`,
  invoiceNoLabel: 'رقم الفاتورة',
  orderLabel: 'رقم الطلب',
  issuedLabel: 'تاريخ الإصدار',
  revisionLabel: 'مراجعة',
  itemLabel: 'المنتج',
  qtyLabel: 'الكمية',
  unitPriceLabel: 'سعر الوحدة',
  lineTotalLabel: 'الإجمالي',
  transportFeeLabel: 'عمولة النقل (طلب مسبق)',
  warrantyFeeLabel: 'رسوم تمديد الضمان',
  subtotalLabel: 'مجموع المنتجات',
  deliveryLabel: 'رسوم التوصيل',
  deliveryWaivedLabel: 'رسوم التوصيل (مُعفاة)',
  couponLabel: 'خصم الكوبون',
  pointsLabel: 'نقاط مستخدمة',
  walletLabel: 'مدفوع من المحفظة',
  totalLabel: 'الإجمالي النهائي',
  paidLabel: 'المبلغ المدفوع',
  dueLabel: 'المبلغ المتبقي',
  statusLabel: 'حالة الدفع',
  status: {
    paid: 'مدفوعة بالكامل',
    partial: 'مدفوعة جزئيًا — المتبقي يُدفع عند الاستلام',
    cod_due: 'غير مدفوعة — تُدفع عند الاستلام',
    unpaid: 'غير مدفوعة',
    bnpl_due: 'مستحقة (اشترِ الآن وادفع لاحقًا)',
  },
  invoiceFooter:
    'هذه فاتورة تلقائية من LEVONIS. رسائل الطلبات تقتصر على الفواتير فقط — لا رسائل تسويقية. للاستفسار تواصل مع دعم LEVONIS من داخل حسابك.',
  viewOrders: 'عرض طلباتي',
};

const COPY_EN: Copy = {
  brandTagline: 'LEVONIS Store',
  verifySubject: 'Verify your email — LEVONIS',
  verifyIntro: 'To receive your invoices and security messages, please confirm that you own this email address.',
  verifyCta: 'Verify my email',
  verifyExpiry:
    'This link is valid for 24 hours and can be used once. Opening the link alone does not verify anything — you must press the confirm button on the page.',
  verifyIgnore: 'If you did not create a LEVONIS account, you can safely ignore this email.',
  linkFallback: 'If the button does not work, copy this link into your browser:',
  resetSubject: 'Reset your LEVONIS password',
  resetIntro: 'We received a request to reset your LEVONIS password.',
  resetCta: 'Choose a new password',
  resetExpiry: 'This link expires in 30 minutes and can be used once.',
  resetIgnore: 'If you did not request this, you can safely ignore this email.',
  changedSubject: 'Your LEVONIS password was changed',
  changedBody: 'The password for your LEVONIS account was just changed, and your other sessions were signed out.',
  changedWarn: 'If this was not you, reset your password immediately and contact support.',
  googleSubject: 'Password reset attempt — LEVONIS',
  googleBody:
    'We received a password reset request for this email, but this account signs in with Google and has no password. Use the "Continue with Google" button on the sign-in page instead.',
  googleIgnore: 'If you did not request this, you can safely ignore this email.',
  existsSubject: 'Someone tried to sign up with your email — LEVONIS',
  existsBody:
    'Someone tried to create a LEVONIS account with this address, but you already have one. If that was you, sign in to your existing account, or reset your password if you have forgotten it.',
  existsCta: 'Go to sign-in',
  existsIgnore: 'If that was not you, nothing needs doing — nothing about your account has changed.',
  invoiceSubject: (invoiceNo) => `Your LEVONIS invoice ${invoiceNo}`,
  invoiceTitle: 'Invoice',
  invoiceGreeting: (name) => (name ? `Hello ${name},` : 'Hello,'),
  invoiceIntro: (orderId) => `This is the invoice for your LEVONIS order ${orderId}.`,
  invoiceNoLabel: 'Invoice no.',
  orderLabel: 'Order',
  issuedLabel: 'Issued',
  revisionLabel: 'Revision',
  itemLabel: 'Item',
  qtyLabel: 'Qty',
  unitPriceLabel: 'Unit price',
  lineTotalLabel: 'Total',
  transportFeeLabel: 'Transport commission (preorder)',
  warrantyFeeLabel: 'Warranty extension fee',
  subtotalLabel: 'Items subtotal',
  deliveryLabel: 'Delivery fee',
  deliveryWaivedLabel: 'Delivery fee (waived)',
  couponLabel: 'Coupon discount',
  pointsLabel: 'Points applied',
  walletLabel: 'Paid from wallet',
  totalLabel: 'Grand total',
  paidLabel: 'Amount paid',
  dueLabel: 'Amount due',
  statusLabel: 'Payment status',
  status: {
    paid: 'Paid in full',
    partial: 'Partially paid — balance due on delivery',
    cod_due: 'Unpaid — due on delivery',
    unpaid: 'Unpaid',
    bnpl_due: 'Due (Buy Now, Pay Later)',
  },
  invoiceFooter:
    'This is an automatic invoice from LEVONIS. Order emails are limited to invoices only — no marketing mail. For questions, contact LEVONIS support from your account.',
  viewOrders: 'View my orders',
};

// Sorani Kurdish (ckb) — simple direct copy in Arabic script (RTL). Flagged
// for native review; where a term is uncertain the Arabic wording is kept.
const COPY_CKB: Copy = {
  brandTagline: 'فرۆشگای LEVONIS',
  verifySubject: 'پشتڕاستکردنەوەی ئیمەیڵەکەت — LEVONIS',
  verifyIntro: 'بۆ وەرگرتنی پسوولەکانت و پەیامە ئەمنییەکان، تکایە پشتڕاست بکەرەوە کە ئەم ئیمەیڵە هی تۆیە.',
  verifyCta: 'پشتڕاستکردنەوەی ئیمەیڵ',
  verifyExpiry:
    'ئەم بەستەرە بۆ ٢٤ کاتژمێر کارایە و تەنها جارێک بەکاردێت. تەنها کردنەوەی بەستەرەکە پشتڕاستکردنەوە نییە — پێویستە دوگمەی پشتڕاستکردنەوە لە پەڕەکەدا دابگریت.',
  verifyIgnore: 'ئەگەر هەژماری LEVONIS ت دروست نەکردووە، ئەم پەیامە پشتگوێ بخە.',
  linkFallback: 'ئەگەر دوگمەکە کار نەکات، ئەم بەستەرە لە وێبگەڕەکەت دابنێ:',
  resetSubject: 'دانانەوەی وشەی نهێنی — LEVONIS',
  resetIntro: 'داواکارییەک گەیشت بۆ دانانەوەی وشەی نهێنی هەژمارەکەت لە LEVONIS.',
  resetCta: 'هەڵبژاردنی وشەی نهێنی نوێ',
  resetExpiry: 'ئەم بەستەرە بۆ ٣٠ خولەک کارایە و تەنها جارێک بەکاردێت.',
  resetIgnore: 'ئەگەر ئەمەت داوا نەکردووە، ئەم پەیامە پشتگوێ بخە.',
  changedSubject: 'وشەی نهێنی گۆڕدرا — LEVONIS',
  changedBody: 'وشەی نهێنی هەژمارەکەت لە LEVONIS تازە گۆڕدرا، و لە دانیشتنەکانی تر دەرچوویت.',
  changedWarn: 'ئەگەر ئەمە تۆ نەبوویت، دەستبەجێ وشەی نهێنی دابنێرەوە و پەیوەندی بە پشتگیری بکە.',
  googleSubject: 'هەوڵی دانانەوەی وشەی نهێنی — LEVONIS',
  googleBody:
    'داواکاری دانانەوەی وشەی نهێنی بۆ ئەم ئیمەیڵە گەیشت، بەڵام ئەم هەژمارە بە Google دەچێتە ژوورەوە و وشەی نهێنی نییە. لە پەڕەی چوونەژوورەوە دوگمەی «بەردەوامبوون بە Google» بەکاربهێنە.',
  googleIgnore: 'ئەگەر ئەمەت داوا نەکردووە، ئەم پەیامە پشتگوێ بخە.',
  existsSubject: 'هەوڵی دروستکردنی هەژمار بە ئیمەیلەکەت — LEVONIS',
  existsBody:
    'کەسێک هەوڵی دا هەژمارێکی LEVONIS بەم ئیمەیلە دروست بکات، بەڵام تۆ پێشتر هەژمارت هەیە. ئەگەر ئەوە تۆ بوویت، بە هەژمارەکەت بچۆرەژوورەوە، یان ئەگەر وشەی نهێنیت لەبیرچووە دایبنێرەوە.',
  existsCta: 'بڕۆ بۆ چوونەژوورەوە',
  existsIgnore: 'ئەگەر ئەوە تۆ نەبوویت، هیچ پێویست ناکات — هیچ شتێک لە هەژمارەکەت نەگۆڕاوە.',
  invoiceSubject: (invoiceNo) => `پسوولەی داواکارییەکەت ${invoiceNo} — LEVONIS`,
  invoiceTitle: 'پسوولە',
  invoiceGreeting: (name) => (name ? `سڵاو ${name}،` : 'سڵاو،'),
  invoiceIntro: (orderId) => `ئەمە پسوولەی داواکارییەکەتە ${orderId} لە LEVONIS.`,
  invoiceNoLabel: 'ژمارەی پسوولە',
  orderLabel: 'ژمارەی داواکاری',
  issuedLabel: 'بەرواری دەرچوون',
  revisionLabel: 'پێداچوونەوە',
  itemLabel: 'کاڵا',
  qtyLabel: 'ژمارە',
  unitPriceLabel: 'نرخی یەکە',
  lineTotalLabel: 'کۆ',
  transportFeeLabel: 'کرێی گواستنەوە (پێش‌داواکاری)',
  warrantyFeeLabel: 'کرێی درێژکردنەوەی گەرەنتی',
  subtotalLabel: 'کۆی کاڵاکان',
  deliveryLabel: 'کرێی گەیاندن',
  deliveryWaivedLabel: 'کرێی گەیاندن (بەخۆڕایی)',
  couponLabel: 'داشکاندنی کۆپۆن',
  pointsLabel: 'خاڵی بەکارهێنراو',
  walletLabel: 'لە جزدانەوە دراوە',
  totalLabel: 'کۆی گشتی',
  paidLabel: 'بڕی دراو',
  dueLabel: 'بڕی ماوە',
  statusLabel: 'دۆخی پارەدان',
  status: {
    paid: 'بە تەواوی دراوە',
    partial: 'بەشێکی دراوە — ماوەکە لە کاتی وەرگرتن دەدرێت',
    cod_due: 'نەدراوە — لە کاتی وەرگرتن دەدرێت',
    unpaid: 'نەدراوە',
    bnpl_due: 'قەرزارە (ئێستا بکڕە، دواتر بدە)',
  },
  invoiceFooter:
    'ئەمە پسوولەیەکی خۆکارە لە LEVONIS. ئیمەیڵی داواکارییەکان تەنها پسوولەیە — هیچ پەیامێکی بازرگانی نانێردرێت. بۆ پرسیار، لە ناو هەژمارەکەتەوە پەیوەندی بە پشتگیری LEVONIS بکە.',
  viewOrders: 'بینینی داواکارییەکانم',
};

const COPY: Record<EmailLang, Copy> = { ar: COPY_AR, en: COPY_EN, ckb: COPY_CKB };

// ------------------------------------------------------------------ shell

/**
 * Shared LEVONIS shell: dark header band with the gold wordmark, white card
 * body. Table-free for simple messages; inline styles only.
 */
function shell(lang: EmailLang, inner: string): string {
  const dir = dirOf(lang);
  const t = COPY[lang];
  return (
    `<div dir="${dir}" style="margin:0;padding:24px 12px;background-color:#f4f4f2;font-family:Arial,Helvetica,sans-serif;">` +
    `<div style="max-width:520px;margin:0 auto;">` +
    `<div style="background-color:#111111;border-radius:14px 14px 0 0;padding:18px 24px;">` +
    `<span style="font-size:20px;font-weight:bold;letter-spacing:2px;color:#d4af37;">LEVONIS</span>` +
    `<span style="font-size:11px;color:#999999;margin:0 8px;">${escapeHtml(t.brandTagline)}</span>` +
    `</div>` +
    `<div style="background-color:#ffffff;border-radius:0 0 14px 14px;padding:26px 24px;color:#111111;">` +
    inner +
    `</div></div></div>`
  );
}

function ctaButton(label: string, link: string): string {
  return (
    `<p style="margin:24px 0;text-align:center;">` +
    `<a href="${escapeHtml(link)}" style="display:inline-block;background-color:#111111;color:#d4af37;text-decoration:none;padding:13px 30px;border-radius:12px;font-size:14px;font-weight:bold;">${escapeHtml(label)}</a>` +
    `</p>`
  );
}

function para(text: string, opts: { small?: boolean } = {}): string {
  const size = opts.small ? 'font-size:12px;color:#555555;' : 'font-size:14px;';
  return `<p style="margin:0 0 14px 0;${size}line-height:1.7;">${escapeHtml(text)}</p>`;
}

function rawLink(link: string, label: string): string {
  return (
    para(label, { small: true }) +
    `<p style="margin:0 0 6px 0;font-size:11px;color:#888888;word-break:break-all;" dir="ltr">${escapeHtml(link)}</p>`
  );
}

// -------------------------------------------------------- auth templates

export function renderVerifyEmail(lang: EmailLang, link: string): RenderedEmail {
  const t = COPY[lang];
  const html = shell(
    lang,
    para(t.verifyIntro) +
      ctaButton(t.verifyCta, link) +
      para(t.verifyExpiry, { small: true }) +
      para(t.verifyIgnore, { small: true }) +
      rawLink(link, t.linkFallback)
  );
  const text = [t.verifyIntro, '', `${t.verifyCta}: ${link}`, '', t.verifyExpiry, t.verifyIgnore].join('\n');
  return { subject: t.verifySubject, html, text };
}

export function renderResetPasswordEmail(lang: EmailLang, link: string): RenderedEmail {
  const t = COPY[lang];
  const html = shell(
    lang,
    para(t.resetIntro) +
      ctaButton(t.resetCta, link) +
      para(t.resetExpiry, { small: true }) +
      para(t.resetIgnore, { small: true }) +
      rawLink(link, t.linkFallback)
  );
  const text = [t.resetIntro, '', `${t.resetCta}: ${link}`, '', t.resetExpiry, t.resetIgnore].join('\n');
  return { subject: t.resetSubject, html, text };
}

export function renderPasswordChangedEmail(lang: EmailLang): RenderedEmail {
  const t = COPY[lang];
  const html = shell(lang, para(t.changedBody) + para(t.changedWarn, { small: true }));
  return { subject: t.changedSubject, html, text: `${t.changedBody}\n\n${t.changedWarn}` };
}

export function renderGoogleAccountNoticeEmail(lang: EmailLang): RenderedEmail {
  const t = COPY[lang];
  const html = shell(lang, para(t.googleBody) + para(t.googleIgnore, { small: true }));
  return { subject: t.googleSubject, html, text: `${t.googleBody}\n\n${t.googleIgnore}` };
}

/**
 * Sent to an address that already has an account when someone tries to sign
 * up with it. The person who typed the address gets the same "check your
 * inbox" answer as a real sign-up; only the inbox owner learns what happened.
 */
export function renderAccountExistsEmail(lang: EmailLang, signInUrl: string): RenderedEmail {
  const t = COPY[lang];
  const html = shell(
    lang,
    para(t.existsBody) + ctaButton(t.existsCta, signInUrl) + para(t.existsIgnore, { small: true }) + rawLink(signInUrl, t.linkFallback)
  );
  return { subject: t.existsSubject, html, text: [t.existsBody, '', `${t.existsCta}: ${signInUrl}`, '', t.existsIgnore].join('\n') };
}

// ------------------------------------------------------ invoice template

export type InvoicePaymentStatus = 'unpaid' | 'partial' | 'paid' | 'cod_due' | 'bnpl_due';

export interface InvoiceEmailLine {
  name: string;
  variant: string; // human-readable option/color label ('' when none)
  qty: number;
  unit_price_iqd: number; // includes per-unit transport commission + warranty fee
  line_total_iqd: number;
  transport_commission_iqd: number; // per-unit effective commission (0 = none/waived)
  warranty_fee_iqd: number; // per-unit warranty extension fee (0 = none)
  warranty_label: string;
}

export interface InvoiceEmailData {
  invoice_no: string;
  order_id: string;
  revision: number;
  issued_at: string; // ISO-8601 UTC
  customer_name: string;
  lines: InvoiceEmailLine[];
  subtotal_iqd: number;
  delivery_fee_iqd: number;
  delivery_waived: boolean;
  coupon_discount_iqd: number;
  points_applied_iqd: number;
  wallet_applied_iqd: number;
  total_iqd: number;
  amount_paid_iqd: number;
  amount_due_iqd: number;
  payment_status: InvoicePaymentStatus;
}

function invoiceMetaHtml(t: Copy, inv: InvoiceEmailData): string {
  const issued = inv.issued_at.slice(0, 10);
  const rows: Array<[string, string]> = [
    [t.invoiceNoLabel, inv.invoice_no],
    [t.orderLabel, inv.order_id],
    [t.issuedLabel, issued],
  ];
  if (inv.revision > 1) rows.push([t.revisionLabel, String(inv.revision)]);
  return (
    `<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px 0;font-size:12px;color:#555555;">` +
    rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:2px 0;">${escapeHtml(k)}</td><td style="padding:2px 0;text-align:end;color:#111111;" dir="ltr">${escapeHtml(v)}</td></tr>`
      )
      .join('') +
    `</table>`
  );
}

function invoiceLinesHtml(t: Copy, inv: InvoiceEmailData): string {
  const head =
    `<tr style="background-color:#111111;color:#d4af37;">` +
    `<th style="padding:8px 10px;text-align:start;font-size:12px;">${escapeHtml(t.itemLabel)}</th>` +
    `<th style="padding:8px 6px;text-align:center;font-size:12px;">${escapeHtml(t.qtyLabel)}</th>` +
    `<th style="padding:8px 6px;text-align:end;font-size:12px;">${escapeHtml(t.unitPriceLabel)}</th>` +
    `<th style="padding:8px 10px;text-align:end;font-size:12px;">${escapeHtml(t.lineTotalLabel)}</th>` +
    `</tr>`;
  const body = inv.lines
    .map((l) => {
      const details: string[] = [];
      if (l.variant) details.push(escapeHtml(l.variant));
      if (l.transport_commission_iqd > 0)
        details.push(`${escapeHtml(t.transportFeeLabel)}: <span dir="ltr">${escapeHtml(iqd(l.transport_commission_iqd))}</span>`);
      if (l.warranty_fee_iqd > 0)
        details.push(
          `${escapeHtml(t.warrantyFeeLabel)}${l.warranty_label ? ` (${escapeHtml(l.warranty_label)})` : ''}: <span dir="ltr">${escapeHtml(iqd(l.warranty_fee_iqd))}</span>`
        );
      const detailHtml = details.length
        ? `<div style="font-size:11px;color:#777777;margin-top:2px;">${details.join('<br>')}</div>`
        : '';
      return (
        `<tr style="border-bottom:1px solid #eeeeee;">` +
        `<td style="padding:8px 10px;font-size:13px;">${escapeHtml(l.name)}${detailHtml}</td>` +
        `<td style="padding:8px 6px;text-align:center;font-size:13px;">${l.qty}</td>` +
        `<td style="padding:8px 6px;text-align:end;font-size:13px;white-space:nowrap;" dir="ltr">${escapeHtml(iqd(l.unit_price_iqd))}</td>` +
        `<td style="padding:8px 10px;text-align:end;font-size:13px;white-space:nowrap;" dir="ltr">${escapeHtml(iqd(l.line_total_iqd))}</td>` +
        `</tr>`
      );
    })
    .join('');
  return `<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px 0;">${head}${body}</table>`;
}

function invoiceTotalsHtml(t: Copy, inv: InvoiceEmailData): string {
  const row = (label: string, value: string, opts: { bold?: boolean; color?: string } = {}) =>
    `<tr><td style="padding:3px 10px;font-size:13px;${opts.bold ? 'font-weight:bold;' : ''}">${escapeHtml(label)}</td>` +
    `<td style="padding:3px 10px;text-align:end;font-size:13px;white-space:nowrap;${opts.bold ? 'font-weight:bold;' : ''}${opts.color ? `color:${opts.color};` : ''}" dir="ltr">${escapeHtml(value)}</td></tr>`;

  let rows = row(t.subtotalLabel, iqd(inv.subtotal_iqd));
  rows += inv.delivery_waived
    ? row(t.deliveryWaivedLabel, iqd(0))
    : row(t.deliveryLabel, iqd(inv.delivery_fee_iqd));
  if (inv.coupon_discount_iqd > 0) rows += row(t.couponLabel, `-${iqd(inv.coupon_discount_iqd)}`);
  if (inv.points_applied_iqd > 0) rows += row(t.pointsLabel, `-${iqd(inv.points_applied_iqd)}`);
  rows += row(t.totalLabel, iqd(inv.total_iqd), { bold: true });
  if (inv.wallet_applied_iqd > 0) rows += row(t.walletLabel, iqd(inv.wallet_applied_iqd));
  rows += row(t.paidLabel, iqd(inv.amount_paid_iqd));
  rows += row(t.dueLabel, iqd(inv.amount_due_iqd), { bold: true, color: inv.amount_due_iqd > 0 ? '#8a6d00' : '#1a7f37' });
  rows += row(t.statusLabel, t.status[inv.payment_status], { bold: true });
  return `<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px 0;background-color:#faf8f2;border-radius:10px;">${rows}</table>`;
}

function invoiceText(t: Copy, inv: InvoiceEmailData): string {
  const out: string[] = [];
  out.push(`${t.invoiceTitle} ${inv.invoice_no}`);
  out.push(`${t.orderLabel}: ${inv.order_id}`);
  out.push(`${t.issuedLabel}: ${inv.issued_at.slice(0, 10)}`);
  if (inv.revision > 1) out.push(`${t.revisionLabel}: ${inv.revision}`);
  out.push('');
  for (const l of inv.lines) {
    out.push(`- ${l.name}${l.variant ? ` (${l.variant})` : ''} x${l.qty} @ ${iqd(l.unit_price_iqd)} = ${iqd(l.line_total_iqd)}`);
    if (l.transport_commission_iqd > 0) out.push(`  ${t.transportFeeLabel}: ${iqd(l.transport_commission_iqd)}`);
    if (l.warranty_fee_iqd > 0) out.push(`  ${t.warrantyFeeLabel}: ${iqd(l.warranty_fee_iqd)}`);
  }
  out.push('');
  out.push(`${t.subtotalLabel}: ${iqd(inv.subtotal_iqd)}`);
  out.push(inv.delivery_waived ? `${t.deliveryWaivedLabel}: ${iqd(0)}` : `${t.deliveryLabel}: ${iqd(inv.delivery_fee_iqd)}`);
  if (inv.coupon_discount_iqd > 0) out.push(`${t.couponLabel}: -${iqd(inv.coupon_discount_iqd)}`);
  if (inv.points_applied_iqd > 0) out.push(`${t.pointsLabel}: -${iqd(inv.points_applied_iqd)}`);
  out.push(`${t.totalLabel}: ${iqd(inv.total_iqd)}`);
  if (inv.wallet_applied_iqd > 0) out.push(`${t.walletLabel}: ${iqd(inv.wallet_applied_iqd)}`);
  out.push(`${t.paidLabel}: ${iqd(inv.amount_paid_iqd)}`);
  out.push(`${t.dueLabel}: ${iqd(inv.amount_due_iqd)}`);
  out.push(`${t.statusLabel}: ${t.status[inv.payment_status]}`);
  out.push('');
  out.push(t.invoiceFooter);
  return out.join('\n');
}

/**
 * The order-invoice email — the ONLY routine order email. `ordersUrl` is a
 * plain link to the customer's own orders page built from the trusted
 * configured origin; pass '' to omit the button entirely (e.g. APP_ORIGIN
 * not configured — the invoice body is complete without it).
 */
export function renderOrderInvoiceEmail(lang: EmailLang, inv: InvoiceEmailData, ordersUrl: string): RenderedEmail {
  const t = COPY[lang];
  const inner =
    para(t.invoiceGreeting(inv.customer_name)) +
    para(t.invoiceIntro(inv.order_id)) +
    invoiceMetaHtml(t, inv) +
    invoiceLinesHtml(t, inv) +
    invoiceTotalsHtml(t, inv) +
    (ordersUrl ? ctaButton(t.viewOrders, ordersUrl) : '') +
    para(t.invoiceFooter, { small: true });
  const textParts = [t.invoiceGreeting(inv.customer_name), t.invoiceIntro(inv.order_id), '', invoiceText(t, inv)];
  if (ordersUrl) textParts.push('', `${t.viewOrders}: ${ordersUrl}`);
  return { subject: t.invoiceSubject(inv.invoice_no), html: shell(lang, inner), text: textParts.join('\n') };
}

/**
 * Full printable invoice document (GET /api/invoices/:id/html). Standalone
 * HTML — no scripts, no external assets; served with Cache-Control: no-store
 * behind owner/admin authorization only.
 */
export function renderInvoiceHtmlDocument(lang: EmailLang, inv: InvoiceEmailData): string {
  const t = COPY[lang];
  const dir = dirOf(lang);
  const body =
    `<div style="max-width:640px;margin:0 auto;padding:24px 16px;">` +
    `<div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:3px solid #111111;padding-bottom:12px;margin-bottom:16px;">` +
    `<span style="font-size:24px;font-weight:bold;letter-spacing:2px;color:#111111;">LEVONIS</span>` +
    `<span style="font-size:16px;color:#8a6d00;font-weight:bold;">${escapeHtml(t.invoiceTitle)} ${escapeHtml(inv.invoice_no)}</span>` +
    `</div>` +
    invoiceMetaHtml(t, inv) +
    invoiceLinesHtml(t, inv) +
    invoiceTotalsHtml(t, inv) +
    para(t.invoiceFooter, { small: true }) +
    `</div>`;
  return (
    `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex, nofollow">` +
    `<title>${escapeHtml(t.invoiceTitle)} ${escapeHtml(inv.invoice_no)}</title>` +
    `</head><body style="margin:0;background:#ffffff;color:#111111;font-family:Arial,Helvetica,sans-serif;">${body}</body></html>`
  );
}
