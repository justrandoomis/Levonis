/**
 * «ليفو كير» ON ONE CLAIM (printer phase 3, DECISIONS row 347) — loaded lazily
 * from the claim desk (AdminSerials), so the desk's own chunk barely grows.
 *
 * What the server judges, this screen only words: the device's Levo Care at the
 * claim's FILING date (state, window end, claims and discount left), a quote the
 * desk writes (eligible parts from the frozen terms, labour, shipping, anything
 * else at full price), the server's priced answer (list, discount, co-pay), and
 * the money acts — approve after the customer accepted THAT version, void,
 * co-pay collected — which need the financial scope (`can_decide`). The claim's
 * out-of-pocket costs are the owner's to read (`costs` is null for anyone else); any
 * admin who may decide its money (`can_decide`, owner ruling D3) may record one.
 * Every amount is whole IQD; every refusal is said by its code.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { apiRefusal, refusalLang } from '../../lib/refusalStrings';
import { formatMoney } from '../../lib/money';
import { dateLocale } from '../orders/format';
import type { Language } from '../../translations';

type Text3 = { ar: string; en: string; ckb: string };
type Cover = 'discounted' | 'full_price';
interface CareTerms {
  eligible_parts: Array<{ key: string; label: Text3 }>;
  discount_pct: number;
  max_claims: number;
  max_benefit_iqd: number | null;
  labor: Cover;
  shipping: Cover;
  exclusions: Text3[];
}
interface QuotePart { key: string; label: Text3 | null; qty: number; unit_iqd: number; total_iqd: number }
interface CareQuote {
  state: 'quoted' | 'accepted' | 'approved' | 'void';
  version: number;
  policy_version: number;
  parts: QuotePart[];
  labor_iqd: number;
  shipping_iqd: number;
  other_iqd: number;
  note: string;
  list_iqd: number;
  eligible_iqd: number;
  discount_pct: number;
  benefit_iqd: number;
  copay_iqd: number;
  quoted_at: string;
  customer_accepted_at: string | null;
  decided_at: string | null;
  copay_collected: boolean;
  copay_collected_day?: string | null;
  voided_at: string | null;
  void_reason?: string | null;
}
type CostKind = 'part_purchase' | 'labor' | 'courier' | 'replacement' | 'other';
interface ClaimCost {
  id: string;
  kind: CostKind;
  amount_iqd: number;
  cost_day: string;
  note: string;
  voided: boolean;
  void_reason: string | null;
}
interface CarePanelData {
  installed: boolean;
  claim?: { id: string; stage: string; claim_kind: 'warranty' | 'care'; unit_id: string | null };
  warranty?: { state: string; covered_via: string; end_at: string | null } | null;
  care?: {
    state: 'none' | 'not_delivered' | 'active' | 'expired' | 'closed' | 'terms_missing';
    policy_version: number | null;
    start_at: string | null;
    end_at: string | null;
    used_claims: number;
    used_benefit_iqd: number;
    claims_left: number | null;
    benefit_left_iqd: number | null;
    terms: CareTerms | null;
    used_excluding_this_claim?: { claims: number; benefit_iqd: number };
  } | null;
  quote: CareQuote | null;
  costs: ClaimCost[] | null;
  costs_total_iqd: number | null;
  can_decide?: boolean;
  service_income_account?: { code: string; name: Text3 };
}

const COST_KINDS: readonly CostKind[] = ['part_purchase', 'labor', 'courier', 'replacement', 'other'];
const OPEN_FOR_QUOTE = new Set(['received', 'diagnosing']);

const S = {
  ar: {
    title: 'ليفو كير', loading: 'جارٍ التحميل…', error: 'تعذّر التنفيذ.', done: 'تم.',
    notInstalled: 'ليفو كير غير مُثبَّت في قاعدة البيانات بعد.',
    noUnit: 'هذه المطالبة بلا جهاز، فلا يشملها ليفو كير.',
    entitlement: 'الاستحقاق — عند تاريخ تقديم المطالبة',
    careState: { none: 'لم يشترِ ليفو كير', not_delivered: 'الجهاز لم يُسلَّم بعد', active: 'ساري', expired: 'منتهي', closed: 'مُغلق (أُعيد الجهاز)', terms_missing: 'شروط هذا الإصدار غير مكتوبة' } as Record<string, string>,
    until: (d: string) => `حتى ${d}`,
    claimsLeft: 'المطالبات المتبقية', benefitLeft: 'الخصم المتبقي', noCap: 'بلا سقف', policy: 'إصدار الشروط',
    wState: { active: 'ساري', expired: 'منتهي', needs_config: 'بحاجة إعداد', not_delivered: 'غير مُسلَّم', closed: 'مُغلق' } as Record<string, string>,
    discount: 'نسبة الخصم', warranty: 'الضمان', usedBefore: 'المستخدم قبل هذه المطالبة',
    usedLine: (n: number, m: string) => `${n} مطالبة · ${m}`,
    exclusions: 'لا يشمل',
    quote: 'عرض السعر', part: 'القطعة', qty: 'الكمية', unitPrice: 'سعر الوحدة', addPart: 'إضافة قطعة', remove: 'حذف',
    labor: 'أجرة العمل', shipping: 'الشحن', other: 'أخرى (بالسعر الكامل)', note: 'ملاحظة للزبون',
    discounted: 'مشمول بالخصم', fullPrice: 'بالسعر الكامل',
    misuse: 'الضمان ساري لكن العطل سوء استخدام لا يغطيه الضمان',
    preview: 'معاينة — العرض الذي يحفظه الخادم هو المعتمد',
    list: 'السعر الكامل', eligible: 'المشمول بالخصم', benefit: 'خصم ليفو كير', copay: 'يدفعه الزبون',
    sendQuote: 'حفظ العرض وإرساله للزبون', savedQuote: 'العرض المحفوظ', version: (n: number) => `الإصدار ${n}`,
    quoteState: { quoted: 'بانتظار موافقة الزبون', accepted: 'وافق الزبون', approved: 'معتمد', void: 'ملغى' } as Record<string, string>,
    acceptedAt: 'وافق في', voidReason: 'سبب الإلغاء',
    reason: 'السبب (5 أحرف على الأقل)', approve: 'اعتماد الخصم', voidBtn: 'إلغاء الخصم',
    needsAccept: 'يُعتمد الخصم بعد موافقة الزبون على هذا الإصدار من العرض.',
    financeOnly: 'اعتماد الخصم وإلغاؤه وتسجيل المبالغ تحتاج صلاحية المال.',
    copayDone: (d: string) => `استُلم مبلغ الزبون نقداً (${d})`, markCollected: 'تسجيل استلام مبلغ الزبون نقداً',
    day: 'اليوم (فارغ = اليوم)', incomeTo: (n: string) => `يُقيَّد إيراداً في حساب ${n}`,
    costs: 'تكاليف المطالبة',
    costsNote: 'مصروف عام في يومه، مما دُفع من الجيب فقط. القطع من المخزون تُسجَّل تالفاً مع رقم المطالبة في الملاحظة.',
    costsOwnerOnly: 'التكاليف المسجّلة يراها المالك وحده.',
    costsTotal: 'المجموع', noCosts: 'لا تكاليف مسجّلة.', kind: 'النوع', amount: 'المبلغ (دينار)', costNote: 'ملاحظة',
    addCost: 'تسجيل التكلفة', voided: 'ملغاة', voidCost: 'إلغاء', confirm: 'تأكيد', back: 'رجوع',
    reasonRequired: 'اكتب سبباً من 5 أحرف على الأقل.', amountRequired: 'أدخل مبلغاً صحيحاً أكبر من صفر.',
    costKind: { part_purchase: 'شراء قطعة', labor: 'أجرة عمل', courier: 'توصيل', replacement: 'جهاز بديل', other: 'أخرى' } as Record<string, string>,
  },
  en: {
    title: 'Levo Care', loading: 'Loading…', error: 'It could not be done.', done: 'Done.',
    notInstalled: 'Levo Care is not installed in the database yet.',
    noUnit: 'This claim has no device, so Levo Care does not apply.',
    entitlement: 'Entitlement — on the claim’s filing date',
    careState: { none: 'No Levo Care bought', not_delivered: 'Device not delivered yet', active: 'Active', expired: 'Expired', closed: 'Closed (device returned)', terms_missing: 'Terms of this version are not written' } as Record<string, string>,
    until: (d: string) => `until ${d}`,
    claimsLeft: 'Claims left', benefitLeft: 'Discount left', noCap: 'No cap', policy: 'Terms version',
    wState: { active: 'Active', expired: 'Expired', needs_config: 'Needs setup', not_delivered: 'Not delivered', closed: 'Closed' } as Record<string, string>,
    discount: 'Discount', warranty: 'Warranty', usedBefore: 'Used before this claim',
    usedLine: (n: number, m: string) => `${n} claim(s) · ${m}`,
    exclusions: 'Not covered',
    quote: 'Quote', part: 'Part', qty: 'Qty', unitPrice: 'Unit price', addPart: 'Add a part', remove: 'Remove',
    labor: 'Labour', shipping: 'Shipping', other: 'Other (full price)', note: 'Note to the customer',
    discounted: 'discounted', fullPrice: 'full price',
    misuse: 'The warranty is active but the fault is misuse, which the warranty does not cover',
    preview: 'Preview — the quote the server saves is what counts',
    list: 'List price', eligible: 'Eligible', benefit: 'Levo Care discount', copay: 'Customer pays',
    sendQuote: 'Save and send the quote to the customer', savedQuote: 'Saved quote', version: (n: number) => `version ${n}`,
    quoteState: { quoted: 'Waiting for the customer to accept', accepted: 'Customer accepted', approved: 'Approved', void: 'Void' } as Record<string, string>,
    acceptedAt: 'Accepted on', voidReason: 'Void reason',
    reason: 'Reason (at least 5 characters)', approve: 'Approve the discount', voidBtn: 'Void the discount',
    needsAccept: 'The discount is approved after the customer accepts this version of the quote.',
    financeOnly: 'Approving, voiding and recording money need the financial scope.',
    copayDone: (d: string) => `Co-pay collected in cash (${d})`, markCollected: 'Record the co-pay as collected in cash',
    day: 'Day (empty = today)', incomeTo: (n: string) => `Booked as income in ${n}`,
    costs: 'Claim costs',
    costsNote: 'A general expense on its day, out-of-pocket only. Stock parts are written off as stock loss with the claim number in the note.',
    costsOwnerOnly: 'Recorded costs are visible to the owner only.',
    costsTotal: 'Total', noCosts: 'No costs recorded.', kind: 'Kind', amount: 'Amount (IQD)', costNote: 'Note',
    addCost: 'Record the cost', voided: 'Voided', voidCost: 'Void', confirm: 'Confirm', back: 'Back',
    reasonRequired: 'Write a reason of at least 5 characters.', amountRequired: 'Enter a whole amount above zero.',
    costKind: { part_purchase: 'Part bought', labor: 'Labour', courier: 'Courier', replacement: 'Replacement device', other: 'Other' } as Record<string, string>,
  },
  ckb: {
    title: 'لیڤۆ کێر', loading: 'باردەکرێت…', error: 'نەکرا.', done: 'تەواو.',
    notInstalled: 'لیڤۆ کێر هێشتا لە بنکەی زانیارییەکاندا دانەمەزراوە.',
    noUnit: 'ئەم داواکارییە ئامێری پێوە نییە، بۆیە لیڤۆ کێر نایگرێتەوە.',
    entitlement: 'مافەکە — لە بەرواری پێشکەشکردنی داواکارییەکەدا',
    careState: { none: 'لیڤۆ کێری نەکڕیوە', not_delivered: 'ئامێرەکە هێشتا نەگەیەنراوە', active: 'چالاکە', expired: 'بەسەرچووە', closed: 'داخراوە (ئامێرەکە گەڕێنراوەتەوە)', terms_missing: 'مەرجەکانی ئەم وەشانە نەنووسراون' } as Record<string, string>,
    until: (d: string) => `تا ${d}`,
    claimsLeft: 'داواکارییە ماوەکان', benefitLeft: 'داشکاندنی ماوە', noCap: 'بێ سنوور', policy: 'وەشانی مەرجەکان',
    wState: { active: 'چالاکە', expired: 'بەسەرچووە', needs_config: 'پێویستی بە ڕێکخستنە', not_delivered: 'نەگەیەنراوە', closed: 'داخراوە' } as Record<string, string>,
    discount: 'ڕێژەی داشکاندن', warranty: 'گەرەنتی', usedBefore: 'بەکارهاتوو پێش ئەم داواکارییە',
    usedLine: (n: number, m: string) => `${n} داواکاری · ${m}`,
    exclusions: 'ناگرێتەوە',
    quote: 'نرخنامە', part: 'پارچە', qty: 'بڕ', unitPrice: 'نرخی یەکە', addPart: 'زیادکردنی پارچە', remove: 'لابردن',
    labor: 'کرێی کار', shipping: 'ناردن', other: 'هی تر (بە نرخی تەواو)', note: 'تێبینی بۆ کڕیار',
    discounted: 'داشکاندن دەیگرێتەوە', fullPrice: 'بە نرخی تەواو',
    misuse: 'گەرەنتی چالاکە بەڵام تێکچوونەکە لە خراپ بەکارهێنانەوەیە و گەرەنتی نایگرێتەوە',
    preview: 'پێشبینین — ئەو نرخنامەیەی ڕاژەکار پاشەکەوتی دەکات بڕیاردەرە',
    list: 'نرخی تەواو', eligible: 'ئەوەی داشکاندن دەیگرێتەوە', benefit: 'داشکاندنی لیڤۆ کێر', copay: 'کڕیار دەیدات',
    sendQuote: 'پاشەکەوتکردن و ناردنی نرخنامە بۆ کڕیار', savedQuote: 'نرخنامەی پاشەکەوتکراو', version: (n: number) => `وەشانی ${n}`,
    quoteState: { quoted: 'چاوەڕێی ڕەزامەندی کڕیارە', accepted: 'کڕیار ڕازی بوو', approved: 'پەسەندکراوە', void: 'هەڵوەشاوەتەوە' } as Record<string, string>,
    acceptedAt: 'ڕازیبوون لە', voidReason: 'هۆکاری هەڵوەشاندنەوە',
    reason: 'هۆکار (لانیکەم 5 پیت)', approve: 'پەسەندکردنی داشکاندن', voidBtn: 'هەڵوەشاندنەوەی داشکاندن',
    needsAccept: 'داشکاندنەکە دوای ڕەزامەندی کڕیار لەسەر ئەم وەشانەی نرخنامە پەسەند دەکرێت.',
    financeOnly: 'پەسەندکردن و هەڵوەشاندنەوەی داشکاندن و تۆمارکردنی پارە پێویستیان بە دەسەڵاتی دارایی هەیە.',
    copayDone: (d: string) => `بەشی کڕیار بە نەختینە وەرگیرا (${d})`, markCollected: 'تۆمارکردنی وەرگرتنی بەشی کڕیار بە نەختینە',
    day: 'ڕۆژ (بەتاڵ = ئەمڕۆ)', incomeTo: (n: string) => `وەک داهات لە هەژماری ${n} تۆمار دەکرێت`,
    costs: 'تێچووەکانی داواکاری',
    costsNote: 'خەرجییەکی گشتییە لە ڕۆژی خۆیدا، تەنها ئەوەی لە گیرفان دراوە. پارچەی کۆگا وەک زیانی کۆگا تۆمار دەکرێت و ژمارەی داواکارییەکە لە تێبینیدا دەنووسرێت.',
    costsOwnerOnly: 'تێچووە تۆمارکراوەکان تەنها خاوەنەکە دەیانبینێت.',
    costsTotal: 'کۆ', noCosts: 'هیچ تێچوویەک تۆمار نەکراوە.', kind: 'جۆر', amount: 'بڕ (دینار)', costNote: 'تێبینی',
    addCost: 'تۆمارکردنی تێچوو', voided: 'هەڵوەشاوەتەوە', voidCost: 'هەڵوەشاندنەوە', confirm: 'دڵنیاکردنەوە', back: 'گەڕانەوە',
    reasonRequired: 'هۆکارێک بنووسە کە لانیکەم 5 پیت بێت.', amountRequired: 'بڕێکی تەواو لە سەرووی سفر بنووسە.',
    costKind: { part_purchase: 'کڕینی پارچە', labor: 'کرێی کار', courier: 'گەیاندن', replacement: 'ئامێری جێگرەوە', other: 'هی تر' } as Record<string, string>,
  },
};

const text3 = (t: Text3 | null | undefined, lang: Language) => (t ? (lang === 'en' ? t.en || t.ar : lang === 'ckb' ? t.ckb || t.ar : t.ar || t.en) : '');
const whole = (v: string) => { const t = v.replace(/[^\d]/g, ''); return t === '' ? 0 : Math.min(100_000_000, Number(t)); };
const dateText = (iso: string | null | undefined, lang: Language) => {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(dateLocale(lang), { year: 'numeric', month: 'short', day: 'numeric' });
};
const newOp = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

interface DraftPart { key: string; qty: number; unit_iqd: number }
interface Draft { parts: DraftPart[]; labor_iqd: number; shipping_iqd: number; other_iqd: number; note: string; misuse: boolean }
const draftOf = (q: CareQuote | null): Draft => ({
  parts: (q?.parts ?? []).map((p) => ({ key: p.key, qty: p.qty || 1, unit_iqd: p.unit_iqd || 0 })),
  labor_iqd: q?.labor_iqd ?? 0, shipping_iqd: q?.shipping_iqd ?? 0, other_iqd: q?.other_iqd ?? 0, note: q?.note ?? '', misuse: false,
});

/** The same arithmetic as the server's priceCareQuote, for the preview only — the saved quote is the server's. */
function previewOf(d: Draft, terms: CareTerms, usedBenefit: number) {
  const parts = d.parts.reduce((s, p) => s + p.qty * p.unit_iqd, 0);
  const list = parts + d.labor_iqd + d.shipping_iqd + d.other_iqd;
  const eligible = parts + (terms.labor === 'discounted' ? d.labor_iqd : 0) + (terms.shipping === 'discounted' ? d.shipping_iqd : 0);
  const raw = Math.floor((eligible * terms.discount_pct) / 100);
  const capLeft = terms.max_benefit_iqd == null ? raw : Math.max(0, terms.max_benefit_iqd - usedBenefit);
  const benefit = Math.max(0, Math.min(raw, capLeft));
  return { list, eligible, benefit, copay: list - benefit };
}

export default function ClaimCarePanel({ claimId, lang, onChanged }: { claimId: string; lang: Language; onChanged?: () => void }) {
  const s = S[lang] ?? S.ar;
  const money = (v: number | null | undefined) => formatMoney(v, lang);
  const [data, setData] = useState<CarePanelData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [reason, setReason] = useState('');
  const [copayDay, setCopayDay] = useState('');
  const [cost, setCost] = useState<{ kind: CostKind; amount: string; day: string; note: string }>({ kind: 'part_purchase', amount: '', day: '', note: '' });
  const [voidingCost, setVoidingCost] = useState<string | null>(null);
  const [costReason, setCostReason] = useState('');
  // One operation id per distinct entry: a retry of the same entry is the same operation (the server answers already:true).
  const costOp = useRef<{ key: string; id: string } | null>(null);
  const copayOp = useRef<string | null>(null);

  const adopt = useCallback((d: CarePanelData) => {
    setData(d);
    setDraft(draftOf(d.quote));
  }, []);

  useEffect(() => {
    let live = true;
    setLoadError('');
    api.get<CarePanelData>(`/api/devices/admin/claims/${encodeURIComponent(claimId)}/care`)
      .then((d) => { if (live) adopt(d); })
      .catch((e) => { if (live) setLoadError(e instanceof ApiError ? apiRefusal(e, refusalLang(lang), e.message) : s.error); });
    return () => { live = false; };
  }, [claimId, lang, adopt, s.error]);

  const run = async (path: string, body: unknown, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const d = await api.post<CarePanelData>(`/api/devices/admin/claims/${encodeURIComponent(claimId)}/${path}`, body);
      adopt(d);
      after?.();
      setMessage({ tone: 'ok', text: s.done });
      onChanged?.();
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof ApiError ? apiRefusal(e, refusalLang(lang), e.message) : s.error });
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <div className="lv-alert lv-alert-danger text-[12px] text-text-primary" role="alert">{loadError}</div>;
  if (!data) return <p className="text-[12px] text-text-muted" role="status">{s.loading}</p>;
  if (!data.installed) return <p className="text-[12px] text-text-muted" data-care-not-installed>{s.notInstalled}</p>;

  const care = data.care ?? null;
  const quote = data.quote ?? null;
  const terms = care?.terms ?? null;
  const canDecide = data.can_decide === true;
  // The list and its total are the owner's (cost visibility); the form is any money-scope admin's (owner ruling D3).
  const costList = data.costs ?? null;
  const stage = data.claim?.stage ?? '';
  const editable = !!care && !!terms && OPEN_FOR_QUOTE.has(stage) && quote?.state !== 'approved';
  const usedBefore = care?.used_excluding_this_claim ?? { claims: care?.used_claims ?? 0, benefit_iqd: care?.used_benefit_iqd ?? 0 };
  const preview = terms ? previewOf(draft, terms, usedBefore.benefit_iqd) : null;
  const setPart = (i: number, patch: Partial<DraftPart>) => setDraft((d) => ({ ...d, parts: d.parts.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  const numInput = (value: number, on: (n: number) => void, label: string) => (
    <label className="flex flex-col gap-1 text-[11px] text-text-secondary min-w-0">
      {label}
      <input className="lv-input h-9 px-2 text-[13px] tabular-nums" inputMode="numeric" dir="ltr" value={value ? String(value) : ''}
        onChange={(e) => on(whole(e.target.value))} disabled={busy} />
    </label>
  );
  const reasonOk = reason.trim().length >= 5;
  const fig = (label: string, value: string, strong = false) => (
    <><dt className="text-text-muted">{label}</dt><dd className={`tabular-nums ${strong ? 'font-bold text-text-primary' : 'text-text-secondary'}`} dir="ltr">{value}</dd></>
  );

  const sendQuote = () => run('care-quote', {
    parts: draft.parts.filter((p) => p.key).map((p) => ({ key: p.key, qty: p.qty || 1, unit_iqd: p.unit_iqd })),
    labor_iqd: draft.labor_iqd, shipping_iqd: draft.shipping_iqd, other_iqd: draft.other_iqd, note: draft.note.trim(), misuse: draft.misuse,
  });
  const approve = () => {
    if (!quote) return;
    if (!reasonOk) { setMessage({ tone: 'error', text: s.reasonRequired }); return; }
    void run('care-approve', { version: quote.version, reason: reason.trim() }, () => setReason(''));
  };
  const voidQuote = () => {
    if (!reasonOk) { setMessage({ tone: 'error', text: s.reasonRequired }); return; }
    void run('care-void', { reason: reason.trim() }, () => setReason(''));
  };
  const collect = () => {
    copayOp.current ??= newOp();
    void run('care-copay', { operation_id: copayOp.current, ...(copayDay ? { day: copayDay } : {}) }, () => { copayOp.current = null; setCopayDay(''); });
  };
  const addCost = () => {
    const amount = whole(cost.amount);
    if (!(amount > 0)) { setMessage({ tone: 'error', text: s.amountRequired }); return; }
    const entry = { kind: cost.kind, amount_iqd: amount, ...(cost.day ? { cost_day: cost.day } : {}), note: cost.note.trim() };
    const key = JSON.stringify(entry);
    if (costOp.current?.key !== key) costOp.current = { key, id: newOp() };
    void run('costs', { ...entry, operation_id: costOp.current.id }, () => { costOp.current = null; setCost((c) => ({ ...c, amount: '', note: '' })); });
  };
  const voidCost = (id: string) => {
    if (costReason.trim().length < 5) { setMessage({ tone: 'error', text: s.reasonRequired }); return; }
    void run(`costs/${encodeURIComponent(id)}/void`, { reason: costReason.trim() }, () => { setVoidingCost(null); setCostReason(''); });
  };

  return (
    <div className="space-y-3 text-[12px]" data-claim-care-panel={claimId}>
      {/* ----------------------------------------------------- entitlement */}
      <section className="rounded-lg border border-border-subtle p-3" data-care-entitlement>
        <h4 className="text-[13px] font-bold text-text-primary mb-2">{s.entitlement}</h4>
        {!care ? (
          <p className="text-text-muted">{s.noUnit}</p>
        ) : (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-text-muted">{s.title}</dt>
              <dd className="font-bold text-text-primary" data-care-state={care.state}>
                {s.careState[care.state] ?? care.state}
                {care.end_at && (care.state === 'active' || care.state === 'expired') ? ` · ${s.until(dateText(care.end_at, lang))}` : ''}
              </dd>
              {data.warranty && <><dt className="text-text-muted">{s.warranty}</dt><dd className="text-text-secondary">{s.wState[data.warranty.state] ?? data.warranty.state}{data.warranty.end_at ? ` · ${s.until(dateText(data.warranty.end_at, lang))}` : ''}</dd></>}
              {care.policy_version != null && <><dt className="text-text-muted">{s.policy}</dt><dd className="text-text-secondary tabular-nums">v{care.policy_version}</dd></>}
              {terms && <><dt className="text-text-muted">{s.discount}</dt><dd className="text-text-secondary tabular-nums" dir="ltr">{terms.discount_pct}%</dd></>}
              <dt className="text-text-muted">{s.claimsLeft}</dt>
              <dd className="text-text-primary tabular-nums">{care.claims_left ?? '—'}{terms ? ` / ${terms.max_claims}` : ''}</dd>
              <dt className="text-text-muted">{s.benefitLeft}</dt>
              <dd className="text-text-primary tabular-nums">{terms && terms.max_benefit_iqd == null ? s.noCap : money(care.benefit_left_iqd)}</dd>
              <dt className="text-text-muted">{s.usedBefore}</dt>
              <dd className="text-text-secondary tabular-nums">{s.usedLine(usedBefore.claims, money(usedBefore.benefit_iqd))}</dd>
            </dl>
            {terms && terms.exclusions.length > 0 && (
              <p className="mt-2 text-text-muted leading-relaxed">
                <span className="font-bold text-text-secondary">{s.exclusions}:</span> {terms.exclusions.map((x) => text3(x, lang)).filter(Boolean).join(' · ')}
              </p>
            )}
          </>
        )}
      </section>

      {/* ---------------------------------------------------- saved quote */}
      {quote && (
        <section className="rounded-lg border border-border-subtle p-3" data-care-quote={quote.state}>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h4 className="text-[13px] font-bold text-text-primary">{s.savedQuote} · {s.version(quote.version)}</h4>
            <span className="inline-flex px-2.5 py-1 rounded-full bg-white/[0.06] text-text-secondary text-[11px] font-bold">{s.quoteState[quote.state] ?? quote.state}</span>
          </div>
          {quote.parts.length > 0 && (
            <ul className="mb-2 space-y-0.5">
              {quote.parts.map((p, i) => (
                <li key={`${p.key}-${i}`} className="flex justify-between gap-3 text-text-secondary">
                  <span className="truncate">{text3(p.label, lang) || p.key} × {p.qty}</span>
                  <span className="tabular-nums shrink-0" dir="ltr">{money(p.total_iqd)}</span>
                </li>
              ))}
            </ul>
          )}
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
            {quote.labor_iqd > 0 && fig(s.labor, money(quote.labor_iqd))}
            {quote.shipping_iqd > 0 && fig(s.shipping, money(quote.shipping_iqd))}
            {quote.other_iqd > 0 && fig(s.other, money(quote.other_iqd))}
            {fig(s.list, money(quote.list_iqd))}
            {fig(s.eligible, money(quote.eligible_iqd))}
            {fig(`${s.benefit} (${quote.discount_pct}%)`, `− ${money(quote.benefit_iqd)}`)}
            {fig(s.copay, money(quote.copay_iqd), true)}
          </dl>
          {quote.note && <p className="mt-2 text-text-muted whitespace-pre-wrap">{quote.note}</p>}
          {quote.customer_accepted_at && <p className="mt-1 text-text-muted">{s.acceptedAt} {dateText(quote.customer_accepted_at, lang)}</p>}
          {quote.state === 'void' && quote.void_reason && <p className="mt-1 text-text-muted">{s.voidReason}: {quote.void_reason}</p>}

          {/* The money acts: the financial scope's, said to anyone else. */}
          {quote.state !== 'void' && (
            canDecide ? (
              <div className="mt-3 space-y-2 border-t border-border-subtle pt-3">
                {quote.state === 'quoted' && <p className="text-text-muted">{s.needsAccept}</p>}
                <input className="lv-input w-full text-[13px]" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={s.reason} aria-label={s.reason} maxLength={500} disabled={busy} data-care-reason />
                <div className="flex flex-wrap gap-2">
                  {quote.state === 'accepted' && (
                    <button type="button" className="lv-button lv-button-primary" disabled={busy} onClick={approve} data-care-approve>{s.approve}</button>
                  )}
                  {!quote.copay_collected && (
                    <button type="button" className="lv-button lv-button-secondary" disabled={busy} onClick={voidQuote} data-care-void>{s.voidBtn}</button>
                  )}
                </div>
                {quote.state === 'approved' && quote.copay_iqd > 0 && (
                  quote.copay_collected ? (
                    <p className="font-bold text-text-primary" data-care-copay-collected>{s.copayDone(dateText(quote.copay_collected_day ?? null, lang))}</p>
                  ) : (
                    <div className="flex flex-wrap items-end gap-2" data-care-copay>
                      <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
                        {s.day}
                        <input type="date" className="lv-input h-9 px-2 text-[13px]" dir="ltr" value={copayDay} onChange={(e) => setCopayDay(e.target.value)} disabled={busy} />
                      </label>
                      <button type="button" className="lv-button lv-button-primary" disabled={busy} onClick={collect}>{s.markCollected} · {money(quote.copay_iqd)}</button>
                      {data.service_income_account && (
                        <p className="w-full text-text-muted">{s.incomeTo(`${data.service_income_account.code} «${text3(data.service_income_account.name, lang)}»`)}</p>
                      )}
                    </div>
                  )
                )}
              </div>
            ) : (
              <p className="mt-3 text-text-muted" data-care-finance-only>{s.financeOnly}</p>
            )
          )}
        </section>
      )}

      {/* ---------------------------------------------------- quote editor */}
      {editable && terms && (
        <section className="rounded-lg border border-border-subtle p-3 space-y-2" data-care-quote-editor>
          <h4 className="text-[13px] font-bold text-text-primary">{s.quote}</h4>
          {draft.parts.map((p, i) => (
            <div key={i} className="grid grid-cols-2 sm:grid-cols-4 items-end gap-2">
              <label className="flex flex-col gap-1 text-[11px] text-text-secondary min-w-0">
                {s.part}
                <select className="lv-input h-9 px-2 text-[13px]" value={p.key} onChange={(e) => setPart(i, { key: e.target.value })} disabled={busy}>
                  <option value="">—</option>
                  {terms.eligible_parts.map((ep) => <option key={ep.key} value={ep.key}>{text3(ep.label, lang) || ep.key}</option>)}
                </select>
              </label>
              {numInput(p.qty, (n) => setPart(i, { qty: Math.max(1, Math.min(20, n || 1)) }), s.qty)}
              {numInput(p.unit_iqd, (n) => setPart(i, { unit_iqd: n }), s.unitPrice)}
              <button type="button" className="lv-button lv-button-secondary h-9 px-2 text-[12px]" disabled={busy} onClick={() => setDraft((d) => ({ ...d, parts: d.parts.filter((_, j) => j !== i) }))}>{s.remove}</button>
            </div>
          ))}
          {draft.parts.length < 20 && terms.eligible_parts.length > 0 && (
            <button type="button" className="lv-button lv-button-secondary text-[12px]" disabled={busy} onClick={() => setDraft((d) => ({ ...d, parts: [...d.parts, { key: '', qty: 1, unit_iqd: 0 }] }))} data-care-add-part>{s.addPart}</button>
          )}
          <div className="grid grid-cols-3 gap-2">
            {numInput(draft.labor_iqd, (n) => setDraft((d) => ({ ...d, labor_iqd: n })), `${s.labor} (${terms.labor === 'discounted' ? s.discounted : s.fullPrice})`)}
            {numInput(draft.shipping_iqd, (n) => setDraft((d) => ({ ...d, shipping_iqd: n })), `${s.shipping} (${terms.shipping === 'discounted' ? s.discounted : s.fullPrice})`)}
            {numInput(draft.other_iqd, (n) => setDraft((d) => ({ ...d, other_iqd: n })), s.other)}
          </div>
          <input className="lv-input w-full text-[13px]" value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} placeholder={s.note} aria-label={s.note} maxLength={500} disabled={busy} />
          {data.warranty?.state === 'active' && (
            <label className="flex items-center gap-2 text-text-secondary">
              <input type="checkbox" checked={draft.misuse} onChange={(e) => setDraft((d) => ({ ...d, misuse: e.target.checked }))} disabled={busy} data-care-misuse />
              {s.misuse}
            </label>
          )}
          {preview && (
            <div className="rounded-md bg-white/[0.04] p-2" data-care-preview>
              <p className="text-text-muted mb-1">{s.preview}</p>
              <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
                {fig(s.list, money(preview.list))}
                {fig(s.eligible, money(preview.eligible))}
                {fig(`${s.benefit} (${terms.discount_pct}%)`, `− ${money(preview.benefit)}`)}
                {fig(s.copay, money(preview.copay), true)}
              </dl>
            </div>
          )}
          <button type="button" className="lv-button lv-button-primary w-full" disabled={busy || draft.parts.some((p) => !p.key)} onClick={() => void sendQuote()} data-care-send-quote>{s.sendQuote}</button>
        </section>
      )}

      {/* ---------------------------------------------------------- costs */}
      {(costList !== null || canDecide) && (
        <section className="rounded-lg border border-border-subtle p-3 space-y-2" data-care-costs>
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-[13px] font-bold text-text-primary">{s.costs}</h4>
            {costList !== null && <span className="tabular-nums font-bold text-text-primary" dir="ltr">{s.costsTotal}: {money(data.costs_total_iqd ?? 0)}</span>}
          </div>
          <p className="text-text-muted leading-relaxed">{s.costsNote}</p>
          {costList === null ? <p className="text-text-muted" data-care-costs-owner-only>{s.costsOwnerOnly}</p> : costList.length === 0 ? <p className="text-text-muted">{s.noCosts}</p> : (
            <ul className="space-y-1">
              {costList.map((c) => (
                <li key={c.id} className={`rounded-md border border-border-subtle px-2 py-1.5 ${c.voided ? 'opacity-60' : ''}`} data-care-cost={c.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-text-primary">{s.costKind[c.kind] ?? c.kind} · <span className="text-text-muted tabular-nums">{dateText(c.cost_day, lang)}</span>{c.voided ? ` · ${s.voided}` : ''}</span>
                    <span className="flex items-center gap-2">
                      <span className={`tabular-nums ${c.voided ? 'line-through text-text-muted' : 'text-text-primary'}`} dir="ltr">{money(c.amount_iqd)}</span>
                      {!c.voided && canDecide && voidingCost !== c.id && (
                        <button type="button" className="text-[11px] font-bold text-text-secondary hover:text-text-primary" disabled={busy} onClick={() => { setVoidingCost(c.id); setCostReason(''); }}>{s.voidCost}</button>
                      )}
                    </span>
                  </div>
                  {c.note && <p className="text-text-muted mt-0.5">{c.note}</p>}
                  {c.voided && c.void_reason && <p className="text-text-muted mt-0.5">{c.void_reason}</p>}
                  {voidingCost === c.id && (
                    <div className="mt-2 flex gap-2">
                      <input className="lv-input flex-1 min-w-0 text-[13px]" value={costReason} onChange={(e) => setCostReason(e.target.value)} placeholder={s.reason} aria-label={s.reason} maxLength={500} disabled={busy} />
                      <button type="button" className="lv-button lv-button-primary shrink-0" disabled={busy} onClick={() => voidCost(c.id)}>{s.confirm}</button>
                      <button type="button" className="lv-button lv-button-secondary shrink-0" disabled={busy} onClick={() => setVoidingCost(null)}>{s.back}</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canDecide && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end border-t border-border-subtle pt-2" data-care-add-cost>
              <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
                {s.kind}
                <select className="lv-input h-9 px-2 text-[13px]" value={cost.kind} onChange={(e) => setCost((c) => ({ ...c, kind: e.target.value as CostKind }))} disabled={busy}>
                  {COST_KINDS.map((k) => <option key={k} value={k}>{s.costKind[k]}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
                {s.amount}
                <input className="lv-input h-9 px-2 text-[13px] tabular-nums" inputMode="numeric" dir="ltr" value={cost.amount} onChange={(e) => setCost((c) => ({ ...c, amount: e.target.value.replace(/[^\d]/g, '') }))} disabled={busy} />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
                {s.day}
                <input type="date" className="lv-input h-9 px-2 text-[13px]" dir="ltr" value={cost.day} onChange={(e) => setCost((c) => ({ ...c, day: e.target.value }))} disabled={busy} />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
                {s.costNote}
                <input className="lv-input h-9 px-2 text-[13px]" value={cost.note} onChange={(e) => setCost((c) => ({ ...c, note: e.target.value }))} maxLength={500} disabled={busy} />
              </label>
              <button type="button" className="lv-button lv-button-primary col-span-full" disabled={busy} onClick={addCost}>{s.addCost}</button>
            </div>
          )}
        </section>
      )}

      {message && (
        <div role={message.tone === 'error' ? 'alert' : 'status'} className={message.tone === 'error' ? 'lv-alert lv-alert-danger text-[12px] text-text-primary' : 'text-[12px] text-text-secondary'}>
          {message.text}
        </div>
      )}
    </div>
  );
}
