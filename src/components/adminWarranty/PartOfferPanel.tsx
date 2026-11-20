/**
 * «خصم على قطعة — ليفو كير» ON ONE CLAIM (printer phase 5, DECISIONS row 358) — the staff side of the
 * Care part offer, inside the claim's Care panel (same lazy chunk).
 *
 * The owner's rule: when a customer applied for Care, staff put a discount on a PART — an ordinary
 * store product — and send it to him in the claim's chat like a product. He adds it to the cart and
 * orders it like any part; the discount applies by itself, on that part only, once, on his account
 * only. So this screen: finds the part (the server's own list of what may be offered, priced for
 * THIS customer), takes a percent within the published Care ceiling, shows the price before and
 * after, and sends. Below, every offer of the claim with its state — live / used / revoked /
 * expired — and, for a live one, taking it back with a reason.
 *
 * The server judges everything (Care active at filing, misuse while the warranty was in force, the
 * claim and money limits, the part itself); every refusal is said by its code. Issuing and revoking
 * are money acts (`care_claim_decision`): anyone else sees the list and why the form is not theirs.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import VariantImg from '../ui/VariantImg';
import { formatMoney } from '../../lib/money';
import { dateLocale } from '../orders/format';
import type { Language } from '../../translations';

export type GrantState = 'live' | 'used' | 'revoked' | 'expired';
export interface GrantProduct {
  id: string; slug: string; name: string; name_ar: string; name_ku: string; image: string;
  /** The product has options or colours: the customer chooses them on the product page. */
  needs_choices: boolean;
  available: boolean;
}
export interface PartGrantAdmin {
  id: string;
  claim_id: string;
  product: GrantProduct | null;
  discount_pct: number;
  max_discount_iqd: number | null;
  price_iqd: number | null;
  discount_iqd: number | null;
  after_iqd: number | null;
  state: GrantState;
  expires_at: string;
  created_at: string;
  used_order_id: string | null;
  discount_given_iqd: number | null;
  misuse?: boolean;
  note?: string;
  revoked_at?: string | null;
  revoke_reason?: string | null;
}
export interface PartRules { default_pct: number | null; max_pct: number; valid_days: number; max_live: number }
type PickerProduct = GrantProduct & { price_iqd?: number | null };

const S = {
  ar: {
    title: 'خصم على قطعة — ليفو كير',
    intro: 'اختر قطعة من المتجر وضع عليها خصماً، فتصل إلى الزبون في محادثة المطالبة كبطاقة منتج. يضيفها إلى السلة ويطلبها كأي قطعة، والخصم يُطبَّق تلقائياً على هذه القطعة فقط ولمرة واحدة.',
    search: 'ابحث عن القطعة بالاسم أو الرمز', searching: 'جارٍ البحث…', noResults: 'لا توجد قطعة بهذا الاسم.', searchFailed: 'تعذّر البحث. حاول مرة أخرى.',
    typeToSearch: 'اكتب اسم القطعة لتظهر النتائج.',
    chosen: 'القطعة المختارة', change: 'غيّر القطعة',
    pct: (max: number) => `نسبة الخصم % (من 1 إلى ${max})`,
    misuse: 'العطل سوء استخدام لا يغطيه الضمان',
    misuseWhy: 'الضمان كان سارياً عند تقديم المطالبة: العطل العادي يُصلَّح بالضمان مجاناً. خصم ليفو كير هنا لسوء الاستخدام فقط — علّم المربع إن كان كذلك.',
    note: 'ملاحظة داخلية (اختياري)',
    before: 'السعر الآن', discount: 'خصم ليفو كير', after: 'يدفع الزبون',
    cappedBy: (m: string) => `الخصم محدود بما بقي من سقف ليفو كير لهذا الجهاز (${m}).`,
    perUnit: 'على قطعة واحدة. السعر النهائي يُحسب عند الطلب بسعر الزبون يومها.',
    needsChoices: 'لهذه القطعة خيارات أو ألوان: يختارها الزبون في صفحة المنتج، والخصم يُحسب على اختياره.',
    notOnSale: 'هذه القطعة غير معروضة للبيع الآن — لن يستطيع الزبون طلبها حتى تتوفر.',
    send: 'أرسل العرض في المحادثة', sent: 'أُرسل العرض إلى الزبون في محادثة المطالبة.',
    validFor: (d: number) => `العرض صالح ${d} يوماً، ثم ينتهي تلقائياً.`,
    whyOff: 'لا يمكن الإرسال:',
    whyNoProduct: 'اختر القطعة أولاً.', whyPct: (max: number) => `اكتب نسبة بين 1 و${max}.`,
    whyMisuse: 'الضمان كان سارياً: علّم «سوء استخدام» أو أصلح العطل بالضمان.',
    whyLimit: (n: number) => `على هذه المطالبة ${n} عروض سارية — الحد الأقصى. اسحب واحداً أولاً.`,
    whyAlready: 'لهذه القطعة عرض سارٍ على هذه المطالبة.',
    whyNotActive: 'ليفو كير غير سارٍ لهذا الجهاز عند تقديم المطالبة، فلا يُرسل عرض.',
    whyNoCare: 'لم يشترِ الزبون ليفو كير لهذا الجهاز، فلا يُرسل عرض قطعة بخصم.',
    whyClosed: 'المطالبة مغلقة: لا تُرسل عليها عروض جديدة.',
    whyNoClaims: 'استنفد هذا الجهاز عدد مطالبات ليفو كير.',
    financeOnly: 'إرسال العرض وسحبه يحتاجان صلاحية المال.',
    offers: 'العروض المرسلة', noOffers: 'لم يُرسل أي عرض على هذه المطالبة بعد.',
    state: { live: 'ساري', used: 'استُخدم', revoked: 'مسحوب', expired: 'انتهى' } as Record<string, string>,
    until: (d: string) => `صالح حتى ${d}`, endedOn: (d: string) => `انتهت صلاحيته في ${d}`, revokedWhy: (r: string) => `سبب السحب: ${r}`, usedIn: (o: string) => `في الطلب ${o}`, gave: (m: string) => `خُصم فعلاً ${m}`,
    revoke: 'اسحب العرض', revokeReason: 'سبب السحب (5 أحرف على الأقل)', confirm: 'تأكيد السحب', back: 'رجوع',
    reasonRequired: 'اكتب سبباً من 5 أحرف على الأقل.',
    deleted: 'منتج محذوف', misuseTag: 'سوء استخدام', priceUnknown: 'غير معروض للبيع الآن',
  },
  en: {
    title: 'Discount on a part — Levo Care',
    intro: 'Pick a part from the store and put a discount on it; the customer gets it in the claim chat as a product card. They add it to the cart and order it like any part, and the discount applies by itself — on this part only, once.',
    search: 'Find the part by name or code', searching: 'Searching…', noResults: 'No part with that name.', searchFailed: 'The search failed. Try again.',
    typeToSearch: 'Type the part’s name to see results.',
    chosen: 'Chosen part', change: 'Change the part',
    pct: (max: number) => `Discount % (1 to ${max})`,
    misuse: 'The fault is misuse, which the warranty does not cover',
    misuseWhy: 'The warranty was in force when the claim was filed: an ordinary fault is repaired free under it. A Levo Care discount applies here to misuse only — tick the box if that is the case.',
    note: 'Internal note (optional)',
    before: 'Price now', discount: 'Levo Care discount', after: 'Customer pays',
    cappedBy: (m: string) => `The discount is limited by what is left of this device’s Levo Care ceiling (${m}).`,
    perUnit: 'On one unit. The final price is worked out at the order, at the customer’s price that day.',
    needsChoices: 'This part has options or colours: the customer chooses them on the product page, and the discount follows that choice.',
    notOnSale: 'This part is not on sale right now — the customer cannot order it until it is.',
    send: 'Send the offer in the chat', sent: 'The offer was sent to the customer in the claim chat.',
    validFor: (d: number) => `The offer is valid for ${d} days, then ends by itself.`,
    whyOff: 'Cannot send:',
    whyNoProduct: 'pick the part first.', whyPct: (max: number) => `enter a percent between 1 and ${max}.`,
    whyMisuse: 'the warranty was in force: tick «misuse», or repair the fault under the warranty.',
    whyLimit: (n: number) => `this claim has ${n} live offers — the most allowed. Take one back first.`,
    whyAlready: 'this part already has a live offer on this claim.',
    whyNotActive: 'Levo Care was not active for this device when the claim was filed, so no offer can be sent.',
    whyNoCare: 'the customer did not buy Levo Care for this device, so no discounted part can be sent.',
    whyClosed: 'the claim is closed: no new offers are sent on it.',
    whyNoClaims: 'this device has used all its Levo Care claims.',
    financeOnly: 'Sending and taking back an offer need the financial scope.',
    offers: 'Offers sent', noOffers: 'No offer has been sent on this claim yet.',
    state: { live: 'Live', used: 'Used', revoked: 'Taken back', expired: 'Expired' } as Record<string, string>,
    until: (d: string) => `valid until ${d}`, endedOn: (d: string) => `ended on ${d}`, revokedWhy: (r: string) => `Reason: ${r}`, usedIn: (o: string) => `in order ${o}`, gave: (m: string) => `${m} actually taken off`,
    revoke: 'Take the offer back', revokeReason: 'Reason (at least 5 characters)', confirm: 'Confirm', back: 'Back',
    reasonRequired: 'Write a reason of at least 5 characters.',
    deleted: 'Deleted product', misuseTag: 'misuse', priceUnknown: 'not on sale now',
  },
  ckb: {
    title: 'داشکاندن لەسەر پارچەیەک — لیڤۆ کێر',
    intro: 'پارچەیەک لە فرۆشگا هەڵبژێرە و داشکاندنی لەسەر دابنێ؛ لە گفتوگۆی داواکارییەکەدا وەک کارتی بەرهەم دەگاتە کڕیار. دەیخاتە ناو سەبەتە و وەک هەر پارچەیەک داوای دەکات، و داشکاندنەکە خۆکارانە جێبەجێ دەبێت — تەنها لەسەر ئەم پارچەیە و تەنها یەکجار.',
    search: 'پارچەکە بە ناو یان کۆد بدۆزەوە', searching: 'دەگەڕێت…', noResults: 'هیچ پارچەیەک بەم ناوە نییە.', searchFailed: 'گەڕانەکە سەرکەوتوو نەبوو. دووبارە هەوڵ بدەوە.',
    typeToSearch: 'ناوی پارچەکە بنووسە تا ئەنجامەکان دەربکەون.',
    chosen: 'پارچەی هەڵبژێردراو', change: 'پارچەکە بگۆڕە',
    pct: (max: number) => `ڕێژەی داشکاندن % (لە 1 تا ${max})`,
    misuse: 'تێکچوونەکە لە خراپ بەکارهێنانەوەیە و گەرەنتی نایگرێتەوە',
    misuseWhy: 'لە کاتی پێشکەشکردنی داواکارییەکەدا گەرەنتی کارا بوو: تێکچوونی ئاسایی بە گەرەنتی بەخۆڕایی چاک دەکرێت. داشکاندنی لیڤۆ کێر لێرەدا تەنها بۆ خراپ بەکارهێنانە — ئەگەر وایە خانەکە نیشان بکە.',
    note: 'تێبینی ناوخۆیی (ئارەزوومەندانە)',
    before: 'نرخی ئێستا', discount: 'داشکاندنی لیڤۆ کێر', after: 'کڕیار دەیدات',
    cappedBy: (m: string) => `داشکاندنەکە بەوەی لە سنووری لیڤۆ کێری ئەم ئامێرە ماوە سنووردار کراوە (${m}).`,
    perUnit: 'لەسەر یەک دانە. نرخی کۆتایی لە کاتی داواکارییەکەدا بە نرخی ئەو ڕۆژەی کڕیار هەژمار دەکرێت.',
    needsChoices: 'ئەم پارچەیە هەڵبژاردە یان ڕەنگی هەیە: کڕیار لە پەڕەی بەرهەمەکە هەڵیاندەبژێرێت، و داشکاندنەکە بەپێی هەڵبژاردنەکەی دەبێت.',
    notOnSale: 'ئەم پارچەیە ئێستا بۆ فرۆشتن دانەنراوە — کڕیار ناتوانێت داوای بکات تا بەردەست دەبێت.',
    send: 'پێشنیارەکە لە گفتوگۆکەدا بنێرە', sent: 'پێشنیارەکە لە گفتوگۆی داواکارییەکەدا بۆ کڕیار نێردرا.',
    validFor: (d: number) => `پێشنیارەکە ${d} ڕۆژ کارایە، پاشان خۆی کۆتایی دێت.`,
    whyOff: 'ناتوانرێت بنێردرێت:',
    whyNoProduct: 'سەرەتا پارچەکە هەڵبژێرە.', whyPct: (max: number) => `ڕێژەیەک لە نێوان 1 و ${max} بنووسە.`,
    whyMisuse: 'گەرەنتی کارا بوو: «خراپ بەکارهێنان» نیشان بکە، یان تێکچوونەکە بە گەرەنتی چاک بکە.',
    whyLimit: (n: number) => `ئەم داواکارییە ${n} پێشنیاری کارای هەیە — زۆرترین ڕێگەپێدراو. سەرەتا یەکێکیان بکشێنەوە.`,
    whyAlready: 'ئەم پارچەیە پێشتر پێشنیارێکی کارای لەسەر ئەم داواکارییە هەیە.',
    whyNotActive: 'لە کاتی پێشکەشکردنی داواکارییەکەدا لیڤۆ کێر بۆ ئەم ئامێرە کارا نەبوو، بۆیە پێشنیار نانێردرێت.',
    whyNoCare: 'کڕیار لیڤۆ کێری بۆ ئەم ئامێرە نەکڕیوە، بۆیە پارچەی داشکێنراو نانێردرێت.',
    whyClosed: 'داواکارییەکە داخراوە: پێشنیاری نوێی لەسەر نانێردرێت.',
    whyNoClaims: 'ئەم ئامێرە هەموو داواکارییەکانی لیڤۆ کێری بەکارهێناوە.',
    financeOnly: 'ناردن و کشاندنەوەی پێشنیار پێویستیان بە دەسەڵاتی دارایی هەیە.',
    offers: 'پێشنیارە نێردراوەکان', noOffers: 'هێشتا هیچ پێشنیارێک لەسەر ئەم داواکارییە نەنێردراوە.',
    state: { live: 'کارایە', used: 'بەکارهات', revoked: 'کشێنرایەوە', expired: 'بەسەرچوو' } as Record<string, string>,
    until: (d: string) => `کارایە تا ${d}`, endedOn: (d: string) => `لە ${d} بەسەرچوو`, revokedWhy: (r: string) => `هۆکاری کشاندنەوە: ${r}`, usedIn: (o: string) => `لە داواکاری ${o}`, gave: (m: string) => `${m} بە کردەوە داشکێنرا`,
    revoke: 'پێشنیارەکە بکشێنەوە', revokeReason: 'هۆکار (لانیکەم 5 پیت)', confirm: 'دڵنیاکردنەوە', back: 'گەڕانەوە',
    reasonRequired: 'هۆکارێک بنووسە کە لانیکەم 5 پیت بێت.',
    deleted: 'بەرهەمی سڕاوە', misuseTag: 'خراپ بەکارهێنان', priceUnknown: 'ئێستا بۆ فرۆشتن نییە',
  },
};

const nameOf = (p: { name: string; name_ar: string; name_ku: string }, lang: Language) =>
  (lang === 'en' ? p.name || p.name_ar : lang === 'ckb' ? p.name_ku || p.name || p.name_ar : p.name_ar || p.name) || '';
const dateText = (iso: string | null | undefined, lang: Language) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(dateLocale(lang), { year: 'numeric', month: 'short', day: 'numeric' });
};
/** min(floor(price × pct / 100), ceiling) — the server's own arithmetic (worker/lib/carePartGrantViews.ts partDiscountOf), for the preview only. */
export function partDiscountPreview(priceIqd: number, pct: number, maxIqd: number | null): number {
  let d = Math.floor((Math.max(0, Math.trunc(priceIqd)) * Math.max(0, Math.trunc(pct))) / 100);
  if (maxIqd !== null) d = Math.min(d, Math.max(0, Math.trunc(maxIqd)));
  return Math.max(0, Math.min(d, Math.max(0, Math.trunc(priceIqd))));
}

const STATE_CHIP: Record<GrantState, string> = {
  live: '[--chip:var(--color-success)]', used: '[--chip:var(--color-info)]', revoked: '[--chip:var(--color-warning)]', expired: '[--chip:var(--color-warning)]',
};

function Thumb({ src }: { src: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <span aria-hidden className="h-12 w-12 shrink-0 rounded-md border border-border-subtle bg-surface-selected" />;
  return <VariantImg src={src} sizes="48px" alt="" className="h-12 w-12 shrink-0 rounded-md border border-border-subtle object-cover" onError={() => setBroken(true)} />;
}

export default function PartOfferPanel({ claimId, lang, grants, rules, canDecide, careActive, careState, claimOpen, claimsLeft, warrantyActive, benefitLeftIqd, busy, run }: {
  claimId: string; lang: Language;
  grants: PartGrantAdmin[]; rules: PartRules;
  /** The financial scope (`can_decide`): issuing and revoking are money acts. */
  canDecide: boolean;
  /** Levo Care was active, with written terms, at the claim's filing date. */
  careActive: boolean;
  /** Phase 8: why Care is not active — a device that never bought Care is told so, not «was not active». */
  careState?: string;
  claimOpen: boolean;
  /** Claims left on the device, this claim's own use not counted (null = unknown). */
  claimsLeft: number | null;
  /** The warranty was in force at filing: only misuse is Care (CARE_NOT_WARRANTY). */
  warrantyActive: boolean;
  /** What is left of the device's Care money ceiling (null = no ceiling). */
  benefitLeftIqd: number | null;
  busy: boolean;
  /** The Care panel's own POST: adopts the fresh panel and says every refusal by its code. Resolves true when it went through. */
  run: (path: string, body: unknown, after?: () => void) => Promise<boolean>;
}) {
  const s = S[lang] ?? S.ar;
  const money = (v: number | null | undefined) => formatMoney(v, lang);
  const maxPct = Math.max(1, Math.min(90, Math.trunc(rules.max_pct) || 1));
  const [term, setTerm] = useState('');
  const [rows, setRows] = useState<PickerProduct[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [product, setProduct] = useState<PickerProduct | null>(null);
  // The terms' own discount as the starting percent; with none, the desk types it.
  const [pct, setPct] = useState(rules.default_pct != null && rules.default_pct >= 1 ? String(Math.min(maxPct, Math.trunc(rules.default_pct))) : '');
  const [misuse, setMisuse] = useState(false);
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const seq = useRef(0);

  // The server's own list of what may be offered, priced for THIS claim's customer; debounced.
  useEffect(() => {
    const q = term.trim();
    if (product || q.length < 2) { setRows(null); setSearching(false); return; }
    const mine = ++seq.current;
    setSearching(true);
    setSearchFailed(false);
    const timer = setTimeout(() => {
      api.get<{ products?: PickerProduct[] }>(`/api/devices/admin/part-products?q=${encodeURIComponent(q)}&claim_id=${encodeURIComponent(claimId)}`)
        .then((r) => { if (seq.current === mine) setRows(r.products ?? []); })
        .catch(() => { if (seq.current === mine) { setRows(null); setSearchFailed(true); } })
        .finally(() => { if (seq.current === mine) setSearching(false); });
    }, 300);
    return () => clearTimeout(timer);
  }, [term, product, claimId]);

  const live = grants.filter((g) => g.state === 'live');
  const pctN = /^\d+$/.test(pct) ? Number(pct) : Number.NaN;
  const pctOk = Number.isInteger(pctN) && pctN >= 1 && pctN <= maxPct;
  const price = product?.price_iqd ?? null;
  const off = price !== null && pctOk ? partDiscountPreview(price, pctN, benefitLeftIqd) : null;
  const capped = price !== null && pctOk && off !== null && off < Math.min(price, Math.floor((price * pctN) / 100));
  // The first thing in the way, in the order the form is filled.
  const why = !claimOpen ? s.whyClosed
    : !careActive ? (careState === 'none' ? s.whyNoCare : s.whyNotActive)
      : claimsLeft !== null && claimsLeft <= 0 ? s.whyNoClaims
        : live.length >= rules.max_live ? s.whyLimit(live.length)
          : !product ? s.whyNoProduct
            : live.some((g) => g.product?.id === product.id) ? s.whyAlready
              : !pctOk ? s.whyPct(maxPct)
                : warrantyActive && !misuse ? s.whyMisuse
                  : null;
  const blockedForGood = !claimOpen || !careActive || (claimsLeft !== null && claimsLeft <= 0);

  const send = async () => {
    if (!product || why) return;
    setSent(false);
    const ok = await run('part-grants', { product_id: product.id, discount_pct: pctN, ...(warrantyActive ? { misuse } : {}), ...(note.trim() ? { note: note.trim().slice(0, 300) } : {}) });
    if (ok) { setProduct(null); setTerm(''); setNote(''); setMisuse(false); setSent(true); }
  };
  const revoke = async (id: string) => {
    if (reason.trim().length < 5) { setReasonError(true); return; }
    setReasonError(false);
    const ok = await run(`part-grants/${encodeURIComponent(id)}/revoke`, { reason: reason.trim() });
    if (ok) { setRevoking(null); setReason(''); }
  };

  return (
    <section className="rounded-lg border border-border-subtle p-3 space-y-3" data-care-part-offers>
      <div>
        <h4 className="text-[13px] font-bold text-text-primary">{s.title}</h4>
        <p className="mt-1 text-text-muted leading-relaxed">{s.intro}</p>
      </div>

      {!canDecide ? (
        <p className="text-text-muted" data-care-part-finance-only>{s.financeOnly}</p>
      ) : blockedForGood ? (
        <p className="text-text-secondary" role="note" data-care-part-blocked>{why}</p>
      ) : (
        <div className="space-y-2" data-care-part-form>
          {!product ? (
            <div className="space-y-1.5">
              <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
                {s.search}
                <input type="search" className="lv-input h-11 px-2 text-[13px]" value={term} onChange={(e) => setTerm(e.target.value)} disabled={busy} autoComplete="off" data-care-part-search />
              </label>
              {searching ? <p className="text-text-muted" role="status">{s.searching}</p>
                : searchFailed ? <p className="text-text-secondary" role="alert">{s.searchFailed}</p>
                  : rows === null ? <p className="text-text-muted">{s.typeToSearch}</p>
                    : rows.length === 0 ? <p className="text-text-muted">{s.noResults}</p>
                      : (
                        <ul className="max-h-64 space-y-1 overflow-y-auto" data-care-part-results>
                          {rows.map((p) => (
                            <li key={p.id}>
                              <button type="button" style={{ minHeight: 44 }} className="flex w-full items-center gap-2 rounded-md border border-border-subtle p-1.5 text-start hover:bg-surface-selected" disabled={busy} onClick={() => { setProduct(p); setSent(false); }}>
                                <Thumb src={p.image} />
                                <span className="min-w-0 flex-1 text-[13px] text-text-primary">{nameOf(p, lang) || p.slug}</span>
                                <span className="shrink-0 tabular-nums text-text-secondary" dir="ltr">{p.price_iqd == null ? s.priceUnknown : money(p.price_iqd)}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 rounded-md border border-border-subtle p-2" data-care-part-chosen={product.id}>
                <Thumb src={product.image} />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] text-text-muted">{s.chosen}</p>
                  <p className="text-[13px] font-semibold text-text-primary">{nameOf(product, lang) || product.slug}</p>
                </div>
                <button type="button" className="lv-button lv-button-secondary h-9 shrink-0 px-2 text-[12px]" disabled={busy} onClick={() => setProduct(null)}>{s.change}</button>
              </div>
              {!product.available || price === null ? <p className="text-warning" role="note">{s.notOnSale}</p> : null}
              {product.needs_choices ? <p className="text-text-muted leading-relaxed">{s.needsChoices}</p> : null}

              <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
                {s.pct(maxPct)}
                <input className="lv-input h-11 w-28 px-2 text-[14px] tabular-nums" inputMode="numeric" dir="ltr" value={pct} aria-invalid={!pctOk || undefined}
                  onChange={(e) => setPct(e.target.value.replace(/[^\d]/g, '').slice(0, 2))} disabled={busy} data-care-part-pct />
              </label>

              {warrantyActive ? (
                <div className="space-y-1">
                  <label className="flex min-h-11 items-center gap-2 text-text-primary">
                    <input type="checkbox" checked={misuse} onChange={(e) => setMisuse(e.target.checked)} disabled={busy} data-care-part-misuse />
                    {s.misuse}
                  </label>
                  <p className="text-text-muted leading-relaxed">{s.misuseWhy}</p>
                </div>
              ) : null}

              {price !== null && off !== null ? (
                <div className="rounded-md bg-white/[0.04] p-2" data-care-part-preview>
                  <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
                    <dt className="text-text-muted">{s.before}</dt><dd className="tabular-nums text-text-secondary line-through" dir="ltr">{money(price)}</dd>
                    <dt className="text-text-muted">{s.discount} ({pctN}%)</dt><dd className="tabular-nums text-text-secondary" dir="ltr">− {money(off)}</dd>
                    <dt className="text-text-muted">{s.after}</dt><dd className="tabular-nums font-bold text-text-primary" dir="ltr">{money(price - off)}</dd>
                  </dl>
                  {capped && benefitLeftIqd !== null ? <p className="mt-1 text-warning">{s.cappedBy(money(benefitLeftIqd))}</p> : null}
                  <p className="mt-1 text-text-muted">{s.perUnit}</p>
                </div>
              ) : null}

              <input className="lv-input w-full text-[13px]" value={note} onChange={(e) => setNote(e.target.value)} placeholder={s.note} aria-label={s.note} maxLength={300} disabled={busy} />
            </>
          )}

          <button type="button" className="lv-button lv-button-primary w-full" disabled={busy || !!why} onClick={() => void send()} data-care-part-send>{s.send}</button>
          {why ? <p className="text-text-secondary" data-care-part-why><span className="font-bold text-text-primary">{s.whyOff}</span> {why}</p> : <p className="text-text-muted">{s.validFor(rules.valid_days)}</p>}
          {sent ? <p className="font-bold text-text-primary" role="status" data-care-part-sent>{s.sent}</p> : null}
        </div>
      )}

      <div className="space-y-1.5 border-t border-border-subtle pt-2" data-care-part-list>
        <h5 className="font-bold text-text-primary">{s.offers}{grants.length ? ` (${grants.length})` : ''}</h5>
        {grants.length === 0 ? <p className="text-text-muted">{s.noOffers}</p> : (
          <ul className="space-y-1.5">
            {grants.map((g) => (
              <li key={g.id} className={`rounded-md border border-border-subtle p-2 ${g.state === 'live' || g.state === 'used' ? '' : 'opacity-60'}`} data-care-part-grant={g.id} data-care-part-state={g.state}>
                <div className="flex items-start gap-2">
                  <Thumb src={g.product?.image ?? ''} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-text-primary">{g.product ? nameOf(g.product, lang) || g.product.slug : s.deleted}</p>
                    <p className="tabular-nums text-text-secondary">
                      <span dir="ltr">{g.discount_pct}%</span>
                      {g.price_iqd !== null && g.after_iqd !== null ? (
                        <> · <span dir="ltr" className="line-through text-text-muted">{money(g.price_iqd)}</span> <span dir="ltr" className="font-bold text-text-primary">{money(g.after_iqd)}</span></>
                      ) : null}
                      {g.misuse ? <> · <span className="whitespace-nowrap">{s.misuseTag}</span></> : null}
                    </p>
                    <p className="text-text-muted">
                      {g.state === 'live' ? s.until(dateText(g.expires_at, lang))
                        : g.state === 'used' ? [g.used_order_id ? s.usedIn(g.used_order_id) : '', g.discount_given_iqd != null ? s.gave(money(g.discount_given_iqd)) : ''].filter(Boolean).join(' · ')
                          : g.state === 'revoked' ? (g.revoke_reason ? s.revokedWhy(g.revoke_reason) : '')
                            : s.endedOn(dateText(g.expires_at, lang))}
                    </p>
                    {g.note ? <p className="text-text-muted">{g.note}</p> : null}
                  </div>
                  <span className={`lv-chip ${STATE_CHIP[g.state] ?? STATE_CHIP.expired} shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold`}>{s.state[g.state] ?? g.state}</span>
                </div>
                {g.state === 'live' && canDecide ? (
                  revoking === g.id ? (
                    <div className="mt-2 space-y-1.5">
                      <div className="flex flex-wrap gap-2">
                        <input className="lv-input min-w-0 flex-1 text-[13px]" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={s.revokeReason} aria-label={s.revokeReason} maxLength={500} disabled={busy} data-care-part-revoke-reason />
                        <button type="button" className="lv-button lv-button-primary shrink-0" disabled={busy} onClick={() => void revoke(g.id)}>{s.confirm}</button>
                        <button type="button" className="lv-button lv-button-secondary shrink-0" disabled={busy} onClick={() => { setRevoking(null); setReasonError(false); }}>{s.back}</button>
                      </div>
                      {reasonError ? <p className="text-text-primary" role="alert">{s.reasonRequired}</p> : null}
                    </div>
                  ) : (
                    <button type="button" className="mt-2 lv-button lv-button-secondary h-9 px-2 text-[12px]" disabled={busy} onClick={() => { setRevoking(g.id); setReason(''); setReasonError(false); }} data-care-part-revoke>{s.revoke}</button>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
