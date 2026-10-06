import React, { useCallback, useEffect, useState } from 'react';
import {
  Star,
  Check,
  AlertTriangle,
  RefreshCw,
  Gift,
  Instagram,
  ExternalLink,
  ClipboardList,
  Boxes,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../LanguageContext';

/**
 * Admin: review/reward queue with eligibility facts and evidence viewing and
 * rubric quality scoring (independent from stars/sentiment). Approving a
 * printer-gift reward grants a LEVEL gift of the quality score (0175); the
 * gift levels and the granted gifts are managed in src/components/adminGifts.
 * Public moderation and reward approval are SEPARATE decisions.
 */

const STRINGS = {
  ar: {
    title: 'المراجعات والهدايا',
    tabs: { queue: 'قائمة المراجعات', pools: 'مخزون الهدايا', gifts: 'الهدايا الممنوحة' },
    loading: 'جارٍ التحميل...',
    refresh: 'تحديث',
    empty: 'لا توجد عناصر.',
    states: {
      submitted: 'مُقدَّمة', revision_needed: 'بحاجة تعديل', approved: 'مقبولة', rejected: 'مرفوضة', all: 'الكل',
    } as Record<string, string>,
    reviewStatus: { pending: 'غير منشورة', published: 'منشورة', rejected: 'رفض النشر' } as Record<string, string>,
    kinds: { printer_gift: 'هدية طابعة', points: 'نقاط' } as Record<string, string>,
    customer: 'العميل',
    product: 'المنتج',
    order: 'الطلب',
    facts: 'حقائق الأهلية (لا تُقرِّر تلقائيًا)',
    factLabels: {
      delivered: 'طلب مُسلَّم', is_printer: 'منتج طابعة', photos: 'صور', has_video: 'فيديو',
      has_instagram: 'دليل إنستغرام', written_detail: 'تفصيل مكتوب كافٍ',
    } as Record<string, string>,
    evidence: 'دليل إنستغرام (خاص)',
    evidenceFile: 'الملف المرفوع',
    noEvidence: 'لا يوجد',
    media: 'الوسائط',
    moderation: 'النشر العام (منفصل عن المكافأة)',
    publish: 'نشر',
    unpublishReject: 'رفض النشر',
    requestChanges: 'طلب تعديل',
    reasonPrompt: 'السبب (يُعرض للعميل):',
    rewardPanel: 'قرار المكافأة',
    scoreLabel: 'درجة الجودة (1-5) — مستقلة عن النجوم والمشاعر؛ مراجعة نقدية بنجمة واحدة يمكن أن تنال 5',
    rubricLabel: 'سبب التقييم وفق المعايير (إلزامي)',
    rubricPlaceholder: 'فائدة الكتابة، الوضوح، ملاءمة الصور/الفيديو، الاكتمال...',
    approveGift: 'اعتماد ومنح الهدية',
    approvePoints: (n: number) => `اعتماد ومنح ${n.toLocaleString()} نقطة`,
    pointsUnconfigured: 'قيمة نقاط المراجعة غير مُعدّة (reviewPointsConfig) — لا يمكن اعتماد مكافأة نقاط حتى إعدادها. لا أرقام مُختلقة.',
    rejectReward: 'رفض المكافأة',
    decided: 'القرار',
    stars: 'النجوم',
    working: 'جارٍ التنفيذ...',
    // pools
    addItem: 'إضافة عنصر',
    level: 'المستوى',
    kind: 'النوع',
    kindNames: { accessory: 'إكسسوار', filament: 'فلامنت', nozzle: 'نوزل', plate: 'لوح', other: 'أخرى' } as Record<string, string>,
    labelAr: 'الاسم (عربي)',
    labelEn: 'الاسم (إنجليزي)',
    labelCkb: 'الاسم (سۆرانی)',
    brand: 'العلامة',
    material: 'المادة',
    color: 'اللون',
    optionValue: 'قيمة الخيار (مقاس النوزل مثلًا)',
    compat: 'معرّفات منتجات الطابعات المتوافقة (مفصولة بفاصلة) — إلزامي للنوزل/اللوح',
    stock: 'المخزون',
    active: 'فعّال',
    save: 'حفظ',
    cancel: 'إلغاء',
    edit: 'تعديل',
    del: 'حذف',
    delConfirm: 'حذف هذا العنصر من المخزون؟ الهدايا الممنوحة سابقًا لا تتأثر.',
    poolNote: 'محتوى الصناديق ومخزونها قرار المالك (سجل القرارات #19) — لا تُمنح هدايا من مخزون غير مُعدّ.',
    // gifts
    score: 'الدرجة',
    state: 'الحالة',
    giftStates: { available: 'متاحة', selected: 'قيد التجهيز', fulfilled: 'سُلِّمت', cancelled: 'أُلغيت' } as Record<string, string>,
    contents: 'المحتوى',
    fulfill: 'تأكيد التسليم',
    cancelGift: 'إلغاء (مع سبب)',
    cancelReason: 'سبب الإلغاء (إلزامي، يُدقَّق):',
    notRedeemed: 'لم تُصرف بعد',
  },
  en: {
    title: 'Reviews & Gifts',
    tabs: { queue: 'Review queue', pools: 'Gift pools', gifts: 'Granted gifts' },
    loading: 'Loading...',
    refresh: 'Refresh',
    empty: 'Nothing here.',
    states: {
      submitted: 'Submitted', revision_needed: 'Needs changes', approved: 'Approved', rejected: 'Rejected', all: 'All',
    } as Record<string, string>,
    reviewStatus: { pending: 'Not published', published: 'Published', rejected: 'Publication rejected' } as Record<string, string>,
    kinds: { printer_gift: 'Printer gift', points: 'Points' } as Record<string, string>,
    customer: 'Customer',
    product: 'Product',
    order: 'Order',
    facts: 'Eligibility facts (never auto-decide)',
    factLabels: {
      delivered: 'Delivered order', is_printer: 'Printer product', photos: 'Photos', has_video: 'Video',
      has_instagram: 'Instagram evidence', written_detail: 'Enough written detail',
    } as Record<string, string>,
    evidence: 'Instagram evidence (private)',
    evidenceFile: 'Uploaded file',
    noEvidence: 'None',
    media: 'Media',
    moderation: 'Public visibility (separate from reward)',
    publish: 'Publish',
    unpublishReject: 'Reject publication',
    requestChanges: 'Request changes',
    reasonPrompt: 'Reason (shown to the customer):',
    rewardPanel: 'Reward decision',
    scoreLabel: 'Quality score (1-5) — independent of stars/sentiment; a critical 1-star review can score 5',
    rubricLabel: 'Rubric reason (required)',
    rubricPlaceholder: 'Useful writing, clarity, relevant images/video, completeness...',
    approveGift: 'Approve & grant gift',
    approvePoints: (n: number) => `Approve & award ${n.toLocaleString()} points`,
    pointsUnconfigured: 'Review-points value is NOT configured (reviewPointsConfig) — points rewards cannot be approved until it is set. No invented numbers.',
    rejectReward: 'Reject reward',
    decided: 'Decision',
    stars: 'Stars',
    working: 'Working...',
    addItem: 'Add item',
    level: 'Level',
    kind: 'Kind',
    kindNames: { accessory: 'Accessory', filament: 'Filament', nozzle: 'Nozzle', plate: 'Plate', other: 'Other' } as Record<string, string>,
    labelAr: 'Name (Arabic)',
    labelEn: 'Name (English)',
    labelCkb: 'Name (Sorani)',
    brand: 'Brand',
    material: 'Material',
    color: 'Color',
    optionValue: 'Option value (e.g. nozzle size)',
    compat: 'Compatible printer product ids (comma-separated) — required for nozzles/plates',
    stock: 'Stock',
    active: 'Active',
    save: 'Save',
    cancel: 'Cancel',
    edit: 'Edit',
    del: 'Delete',
    delConfirm: 'Delete this pool item? Already-granted gifts keep their own snapshot and are unaffected.',
    poolNote: 'Box contents/stock are an owner decision (decision register #19) — gifts are never granted from an unconfigured pool.',
    score: 'Score',
    state: 'State',
    giftStates: { available: 'Available', selected: 'Being prepared', fulfilled: 'Delivered', cancelled: 'Cancelled' } as Record<string, string>,
    contents: 'Contents',
    fulfill: 'Mark delivered',
    cancelGift: 'Cancel (with reason)',
    cancelReason: 'Cancellation reason (required, audited):',
    notRedeemed: 'Not redeemed yet',
  },
  ckb: {
    title: 'پێداچوونەوە و دیارییەکان',
    tabs: { queue: 'ڕیزی پێداچوونەوەکان', pools: 'کۆگای دیارییەکان', gifts: 'دیارییە بەخشراوەکان' },
    loading: 'باردەکرێت...',
    refresh: 'نوێکردنەوە',
    empty: 'هیچ نییە.',
    states: {
      submitted: 'پێشکەشکراو', revision_needed: 'گۆڕانکاری پێویستە', approved: 'پەسەندکراو', rejected: 'ڕەتکراوە', all: 'هەموو',
    } as Record<string, string>,
    reviewStatus: { pending: 'بڵاونەکراوەتەوە', published: 'بڵاوکراوەتەوە', rejected: 'بڵاوکردنەوە ڕەتکرایەوە' } as Record<string, string>,
    kinds: { printer_gift: 'دیاری پرینتەر', points: 'خاڵ' } as Record<string, string>,
    customer: 'کڕیار',
    product: 'بەرهەم',
    order: 'داواکاری',
    facts: 'ڕاستییەکانی شایستەیی (خۆکارانە بڕیار نادەن)',
    factLabels: {
      delivered: 'داواکاری گەیشتوو', is_printer: 'بەرهەمی پرینتەر', photos: 'وێنە', has_video: 'ڤیدیۆ',
      has_instagram: 'بەڵگەی ئینستاگرام', written_detail: 'وردەکاری نووسراوی پێویست',
    } as Record<string, string>,
    evidence: 'بەڵگەی ئینستاگرام (تایبەت)',
    evidenceFile: 'فایلی بارکراو',
    noEvidence: 'نییە',
    media: 'میدیا',
    moderation: 'بڵاوکردنەوەی گشتی (جیا لە خەڵات)',
    publish: 'بڵاوکردنەوە',
    unpublishReject: 'ڕەتکردنەوەی بڵاوکردنەوە',
    requestChanges: 'داواکردنی گۆڕانکاری',
    reasonPrompt: 'هۆکار (بۆ کڕیار پیشان دەدرێت):',
    rewardPanel: 'بڕیاری خەڵات',
    scoreLabel: 'نمرەی کوالیتی (1-5) — سەربەخۆیە لە ئەستێرەکان؛ پێداچوونەوەی ڕەخنەگرانەی یەک ئەستێرە دەتوانێت 5 وەربگرێت',
    rubricLabel: 'هۆکاری نمرەدان بەپێی پێوەرەکان (پێویستە)',
    rubricPlaceholder: 'سوودی نووسین، ڕوونی، گونجانی وێنە/ڤیدیۆ، تەواوی...',
    approveGift: 'پەسەندکردن و بەخشینی دیاری',
    approvePoints: (n: number) => `پەسەندکردن و بەخشینی ${n.toLocaleString()} خاڵ`,
    pointsUnconfigured: 'بەهای خاڵی پێداچوونەوە ڕێکنەخراوە (reviewPointsConfig) — ناتوانرێت خەڵاتی خاڵ پەسەند بکرێت هەتا ڕێکدەخرێت.',
    rejectReward: 'ڕەتکردنەوەی خەڵات',
    decided: 'بڕیار',
    stars: 'ئەستێرەکان',
    working: 'جێبەجێ دەکرێت...',
    addItem: 'زیادکردنی دانە',
    level: 'ئاست',
    kind: 'جۆر',
    kindNames: { accessory: 'ئێکسسوار', filament: 'فیلامێنت', nozzle: 'نۆزڵ', plate: 'پلێت', other: 'هیتر' } as Record<string, string>,
    labelAr: 'ناو (عەرەبی)',
    labelEn: 'ناو (ئینگلیزی)',
    labelCkb: 'ناو (سۆرانی)',
    brand: 'براند',
    material: 'ماددە',
    color: 'ڕەنگ',
    optionValue: 'بەهای هەڵبژاردن (وەک قەبارەی نۆزڵ)',
    compat: 'ناسنامەی بەرهەمە پرینتەرە گونجاوەکان (بە کۆما جیاکراوە) — بۆ نۆزڵ/پلێت پێویستە',
    stock: 'کۆگا',
    active: 'چالاک',
    save: 'پاشەکەوت',
    cancel: 'هەڵوەشاندنەوە',
    edit: 'دەستکاری',
    del: 'سڕینەوە',
    delConfirm: 'ئەم دانەیە بسڕدرێتەوە؟ دیارییە پێشتر بەخشراوەکان کاریگەر نابن.',
    poolNote: 'ناوەڕۆک و کۆگای سندوقەکان بڕیاری خاوەنە (تۆماری بڕیارەکان #19) — دیاری لە کۆگای ڕێکنەخراو نابەخشرێت.',
    score: 'نمرە',
    state: 'دۆخ',
    giftStates: { available: 'بەردەستە', selected: 'ئامادە دەکرێت', fulfilled: 'گەیەنرا', cancelled: 'هەڵوەشێنرایەوە' } as Record<string, string>,
    contents: 'ناوەڕۆک',
    fulfill: 'دڵنیاکردنەوەی گەیاندن',
    cancelGift: 'هەڵوەشاندنەوە (بە هۆکار)',
    cancelReason: 'هۆکاری هەڵوەشاندنەوە (پێویستە، تۆمار دەکرێت):',
    notRedeemed: 'هێشتا وەرنەگیراوە',
  },
};

interface QueueRow {
  review_id: string;
  reward_id: string;
  created_at: string;
  customer: { email: string; username: string | null };
  product: { id: string | null; name: string | null; name_ar: string | null };
  order_id: string | null;
  stars: number;
  body: string;
  media: Array<{ url: string; kind: 'image' | 'video' }>;
  review_status: 'pending' | 'published' | 'rejected';
  moderation_note: string;
  kind: 'printer_gift' | 'points';
  reward_state: 'submitted' | 'revision_needed' | 'approved' | 'rejected';
  quality_score: number | null;
  quality: {
    score: number;
    tier: 1 | 2 | 3 | 4 | 5 | null;
    reasons: string[];
    textQuality: number;
    imageCount: number;
    imageQuality: number;
    videoPresent: boolean;
    videoQuality: number;
    suspiciousSignals: string[];
    rewardEligible: boolean;
  } | null;
  reason: string;
  points_awarded: number;
  entitlement_id: string | null;
  instagram: { link: string; file_url: string | null } | null;
  facts: {
    delivered: boolean;
    is_printer: boolean;
    photos: number;
    has_video: boolean;
    has_instagram: boolean;
    text_chars: number;
    written_detail: boolean;
  };
}

/**
 * The review queue. The gift levels and the granted gifts moved to their own
 * admin screen (src/components/adminGifts, 0175); the two entry points in the
 * header open it on the matching view.
 */
export default function AdminReviews({ onOpenGifts }: { onOpenGifts?: (view: 'levels' | 'grants') => void } = {}) {
  const { lang, dir, loc } = useLanguage();
  const S = STRINGS[lang] ?? STRINGS.ar;

  // ---------------- queue state
  const [stateFilter, setStateFilter] = useState<'submitted' | 'revision_needed' | 'approved' | 'rejected' | 'all'>('submitted');
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [pointsConfigured, setPointsConfigured] = useState<number | null>(null);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [scoreDraft, setScoreDraft] = useState<Record<string, number>>({});
  const [rubricDraft, setRubricDraft] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const loadQueue = useCallback(async () => {
    setQueueLoading(true);
    setQueueError('');
    try {
      const res = await api.get<{ queue: QueueRow[]; review_points_configured: number | null }>(
        `/api/reviews/admin/queue?state=${stateFilter}`
      );
      setQueue(res.queue);
      setPointsConfigured(res.review_points_configured);
    } catch (e) {
      setQueueError(e instanceof ApiError ? e.message : 'Failed to load queue');
    } finally {
      setQueueLoading(false);
    }
  }, [stateFilter]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  // ---------------- queue actions

  const moderate = async (row: QueueRow, action: 'approve' | 'reject' | 'request_changes') => {
    let reason = '';
    if (action !== 'approve') {
      const input = window.prompt(S.reasonPrompt);
      if (input === null) return;
      reason = input.trim();
      if (!reason) return;
    }
    setBusyId(row.review_id);
    setRowError(null);
    try {
      await api.post(`/api/reviews/admin/${row.review_id}/moderate`, { action, reason });
      await loadQueue();
    } catch (e) {
      setRowError({ id: row.review_id, message: e instanceof ApiError ? e.message : 'Failed' });
    } finally {
      setBusyId(null);
    }
  };

  const decideReward = async (row: QueueRow, action: 'approve' | 'reject' | 'request_changes') => {
    let reason = rubricDraft[row.review_id]?.trim() ?? '';
    if (action !== 'approve') {
      const input = window.prompt(S.reasonPrompt, reason);
      if (input === null) return;
      reason = input.trim();
      if (!reason) return;
    }
    const payload: Record<string, unknown> = { action, reason };
    if (action === 'approve' && row.kind === 'printer_gift') {
      payload.qualityScore = scoreDraft[row.review_id] ?? row.quality_score ?? row.quality?.tier;
    }
    setBusyId(row.review_id);
    setRowError(null);
    try {
      await api.post(`/api/reviews/admin/${row.review_id}/reward`, payload);
      await loadQueue();
    } catch (e) {
      setRowError({ id: row.review_id, message: e instanceof ApiError ? e.message : 'Failed' });
    } finally {
      setBusyId(null);
    }
  };

  // ---------------- render helpers

  const FactBadge = ({ ok, label }: { ok: boolean; label: string }) => (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full border ${
        ok ? 'bg-green-500/10 text-green-400 border-green-500/30' : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
      }`}
    >
      {ok ? <Check className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />} {label}
    </span>
  );

  const productName = (p: { name: string | null; name_ar: string | null }) =>
    loc(p.name_ar || p.name || '—', p.name || p.name_ar || '—');

  return (
    <div dir={dir} className="space-y-6 text-white">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-2xl font-black">{S.title}</h2>
        <div className="flex flex-wrap bg-zinc-900 border border-zinc-800 p-1 rounded-xl">
          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-zinc-800 text-white" aria-current="page">
            <ClipboardList className="w-3.5 h-3.5" aria-hidden /> {S.tabs.queue}
          </span>
          {onOpenGifts &&
            (
              [
                { view: 'levels', icon: Boxes, label: S.tabs.pools },
                { view: 'grants', icon: Gift, label: S.tabs.gifts },
              ] as const
            ).map((t) => (
              <button
                key={t.view}
                type="button"
                onClick={() => onOpenGifts(t.view)}
                data-open-gifts={t.view}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors text-zinc-500 hover:text-zinc-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
              >
                <t.icon className="w-3.5 h-3.5" aria-hidden /> {t.label}
              </button>
            ))}
        </div>
      </div>

      {/* ------------------------------------------------ QUEUE */}
      {(
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex bg-zinc-900 border border-zinc-800 p-1 rounded-xl overflow-x-auto">
              {(['submitted', 'revision_needed', 'approved', 'rejected', 'all'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setStateFilter(f)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-colors ${
                    stateFilter === f ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {S.states[f]}
                </button>
              ))}
            </div>
            <button
              onClick={loadQueue}
              className="p-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-xl text-zinc-300 transition-colors"
              title={S.refresh}
            >
              <RefreshCw className={`w-4 h-4 ${queueLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {pointsConfigured === null && (
            <div className="bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded-2xl p-3 text-[12px] font-medium">
              {S.pointsUnconfigured}
            </div>
          )}
          {queueError && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-3 text-sm">{queueError}</div>
          )}
          {queueLoading && queue.length === 0 && <div className="text-center text-zinc-500 py-10">{S.loading}</div>}
          {!queueLoading && queue.length === 0 && !queueError && (
            <div className="text-center text-zinc-500 py-10">{S.empty}</div>
          )}

          {queue.map((row) => {
            const open = expanded === row.review_id;
            const undecided = row.reward_state === 'submitted' || row.reward_state === 'revision_needed';
            const selectedTier = scoreDraft[row.review_id] ?? row.quality_score ?? row.quality?.tier ?? undefined;
            return (
              <div key={row.review_id} className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
                <button
                  onClick={() => setExpanded(open ? null : row.review_id)}
                  className="w-full text-start p-4 hover:bg-zinc-800/40 transition-colors"
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-sm font-bold truncate">{productName(row.product)}</div>
                      <div className="text-[11px] text-zinc-500 truncate">
                        {row.customer.email} · {row.order_id ?? '—'} · {new Date(row.created_at).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="flex items-center gap-1 text-[11px] text-yellow-400">
                        <Star className="w-3.5 h-3.5 fill-yellow-400" /> {row.stars}/5
                      </span>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-iris/10 text-violet-400 border border-iris/30">
                        {S.kinds[row.kind]}
                      </span>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700">
                        {S.states[row.reward_state]}
                      </span>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
                        {S.reviewStatus[row.review_status]}
                      </span>
                    </div>
                  </div>
                </button>

                {open && (
                  <div className="border-t border-zinc-800 p-4 space-y-4">
                    <p className="text-[13px] text-zinc-300 whitespace-pre-wrap break-words">{row.body}</p>

                    {row.media.length > 0 && (
                      <div>
                        <div className="text-[11px] font-bold text-zinc-500 mb-1">{S.media}</div>
                        <div className="flex gap-2 overflow-x-auto pb-1">
                          {row.media.map((m) =>
                            m.kind === 'video' ? (
                              <video key={m.url} src={m.url} controls preload="none" className="h-24 rounded-lg border border-zinc-700 shrink-0" />
                            ) : (
                              <a key={m.url} href={m.url} target="_blank" rel="noreferrer" className="shrink-0">
                                <img src={m.url} alt="" loading="lazy" className="h-24 w-24 object-cover rounded-lg border border-zinc-700" />
                              </a>
                            )
                          )}
                        </div>
                      </div>
                    )}

                    <div>
                      <div className="text-[11px] font-bold text-zinc-500 mb-1">{S.facts}</div>
                      <div className="flex flex-wrap gap-1.5">
                        <FactBadge ok={row.facts.delivered} label={S.factLabels.delivered} />
                        <FactBadge ok={row.facts.is_printer} label={S.factLabels.is_printer} />
                        <FactBadge ok={row.facts.photos > 0} label={`${S.factLabels.photos} (${row.facts.photos})`} />
                        <FactBadge ok={row.facts.has_video} label={S.factLabels.has_video} />
                        <FactBadge ok={row.facts.has_instagram} label={S.factLabels.has_instagram} />
                        <FactBadge ok={row.facts.written_detail} label={`${S.factLabels.written_detail} (${row.facts.text_chars})`} />
                      </div>
                    </div>

                    {row.quality && (
                      <div className="rounded-lg bg-white/[0.035] px-3 py-2.5 text-[11.5px] text-zinc-400">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span>{loc('درجة الجودة', 'Quality score', 'نمرەی کوالیتی')}: <b className="text-zinc-200">{row.quality.score}/100</b></span>
                          <span>{loc('المستوى المتوقع', 'Predicted level', 'ئاستی پێشبینیکراو')}: <b className="text-zinc-200">{row.quality.tier ?? '—'}</b></span>
                          <span>{loc('جودة النص', 'Text quality', 'کوالیتی دەق')}: {row.quality.textQuality}/42</span>
                          <span>{loc('الصور الفريدة', 'Unique images', 'وێنە ڕەسەنەکان')}: {row.quality.imageCount}</span>
                          <span>{loc('جودة الفيديو', 'Video quality', 'کوالیتی ڤیدیۆ')}: {row.quality.videoQuality}/18</span>
                        </div>
                        {row.quality.reasons.length > 0 && (
                          <p className="mt-1 break-words">{loc('الأسباب', 'Reasons', 'هۆکارەکان')}: {row.quality.reasons.join(' · ')}</p>
                        )}
                        {row.quality.suspiciousSignals.length > 0 && (
                          <p className="mt-1 text-amber-300 break-words">
                            {loc('إشارات تحتاج فحصًا', 'Signals to inspect', 'نیشانە پێویستە بپشکنرێت')}: {row.quality.suspiciousSignals.join(' · ')}
                          </p>
                        )}
                      </div>
                    )}

                    <div>
                      <div className="text-[11px] font-bold text-zinc-500 mb-1 flex items-center gap-1">
                        <Instagram className="w-3.5 h-3.5 text-pink-400" /> {S.evidence}
                      </div>
                      {row.instagram ? (
                        <div className="flex items-center gap-3 text-[12px]">
                          {row.instagram.link && (
                            <a href={row.instagram.link} target="_blank" rel="noreferrer" className="text-violet-400 underline flex items-center gap-1" dir="ltr">
                              {row.instagram.link} <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                          {row.instagram.file_url && (
                            <a href={row.instagram.file_url} target="_blank" rel="noreferrer" className="text-violet-400 underline flex items-center gap-1">
                              {S.evidenceFile} <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                        </div>
                      ) : (
                        <div className="text-[12px] text-zinc-500">{S.noEvidence}</div>
                      )}
                    </div>

                    {/* Public moderation — separate from reward */}
                    <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 space-y-2">
                      <div className="text-[11px] font-bold text-zinc-400">{S.moderation}</div>
                      {row.moderation_note && <div className="text-[11px] text-amber-400">{row.moderation_note}</div>}
                      <div className="flex flex-wrap gap-2">
                        {row.review_status !== 'published' && (
                          <button
                            disabled={busyId === row.review_id}
                            onClick={() => moderate(row, 'approve')}
                            className="text-[12px] font-bold bg-green-600/80 hover:bg-green-600 disabled:opacity-50 px-3 py-1.5 rounded-full"
                          >
                            {S.publish}
                          </button>
                        )}
                        {row.review_status !== 'rejected' && (
                          <button
                            disabled={busyId === row.review_id}
                            onClick={() => moderate(row, 'reject')}
                            className="text-[12px] font-bold bg-red-600/70 hover:bg-red-600 disabled:opacity-50 px-3 py-1.5 rounded-full"
                          >
                            {S.unpublishReject}
                          </button>
                        )}
                        <button
                          disabled={busyId === row.review_id}
                          onClick={() => moderate(row, 'request_changes')}
                          className="text-[12px] font-bold bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 px-3 py-1.5 rounded-full"
                        >
                          {S.requestChanges}
                        </button>
                      </div>
                    </div>

                    {/* Reward decision */}
                    <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 space-y-3">
                      <div className="text-[11px] font-bold text-zinc-400">{S.rewardPanel}</div>
                      {row.reward_state === 'approved' ? (
                        <div className="text-[13px] text-zinc-300 space-y-1">
                          {row.kind === 'printer_gift' ? (
                            <div>
                              {S.score}: <b>{row.quality_score}/5</b>
                              {row.entitlement_id && <span className="text-zinc-500 text-[11px]"> · {row.entitlement_id}</span>}
                            </div>
                          ) : (
                            <div>
                              {S.kinds.points}: <b>{row.points_awarded.toLocaleString()}</b>
                            </div>
                          )}
                          {row.reason && <div className="text-[12px] text-zinc-500">{S.decided}: {row.reason}</div>}
                        </div>
                      ) : row.reward_state === 'rejected' ? (
                        <div className="text-[12px] text-zinc-400">
                          {S.states.rejected}
                          {row.reason ? ` — ${row.reason}` : ''}
                        </div>
                      ) : null}

                      {undecided && (
                        <>
                          {row.kind === 'printer_gift' && (
                            <div className="space-y-2">
                              <label className="block text-[11px] text-zinc-500">{S.scoreLabel}</label>
                              <div className="flex gap-1.5">
                                {[1, 2, 3, 4, 5].map((n) => (
                                  <button
                                    key={n}
                                    type="button"
                                    onClick={() => setScoreDraft((m) => ({ ...m, [row.review_id]: n }))}
                                    className={`w-9 h-9 rounded-lg border text-sm font-black transition-colors ${
                                      selectedTier === n
                                        ? 'bg-[#6B46FF] border-iris text-snow'
                                        : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:border-zinc-500'
                                    }`}
                                  >
                                    {n}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                          <div>
                            <label className="block text-[11px] text-zinc-500 mb-1">{S.rubricLabel}</label>
                            <textarea
                              value={rubricDraft[row.review_id] ?? ''}
                              onChange={(e) => setRubricDraft((m) => ({ ...m, [row.review_id]: e.target.value }))}
                              rows={2}
                              placeholder={S.rubricPlaceholder}
                              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-[13px] text-white focus:border-iris outline-none"
                            />
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {row.kind === 'printer_gift' ? (
                              <button
                                disabled={
                                  busyId === row.review_id ||
                                  !selectedTier ||
                                  (rubricDraft[row.review_id]?.trim().length ?? 0) < 10
                                }
                                onClick={() => decideReward(row, 'approve')}
                                className="text-[12px] font-bold bg-[#6B46FF] hover:bg-iris-deep disabled:opacity-40 px-4 py-1.5 rounded-full"
                              >
                                {busyId === row.review_id ? S.working : S.approveGift}
                              </button>
                            ) : pointsConfigured !== null ? (
                              <button
                                disabled={busyId === row.review_id || (rubricDraft[row.review_id]?.trim().length ?? 0) < 3}
                                onClick={() => decideReward(row, 'approve')}
                                className="text-[12px] font-bold bg-[#6B46FF] hover:bg-iris-deep disabled:opacity-40 px-4 py-1.5 rounded-full"
                              >
                                {busyId === row.review_id ? S.working : S.approvePoints(pointsConfigured)}
                              </button>
                            ) : (
                              <span className="text-[11px] text-amber-400">{S.pointsUnconfigured}</span>
                            )}
                            <button
                              disabled={busyId === row.review_id}
                              onClick={() => decideReward(row, 'request_changes')}
                              className="text-[12px] font-bold bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 px-3 py-1.5 rounded-full"
                            >
                              {S.requestChanges}
                            </button>
                            <button
                              disabled={busyId === row.review_id}
                              onClick={() => decideReward(row, 'reject')}
                              className="text-[12px] font-bold bg-red-600/70 hover:bg-red-600 disabled:opacity-50 px-3 py-1.5 rounded-full"
                            >
                              {S.rejectReward}
                            </button>
                          </div>
                        </>
                      )}
                    </div>

                    {rowError?.id === row.review_id && (
                      <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[12px] rounded-xl p-3">
                        {rowError.message}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
