import React, { useCallback, useEffect, useState } from 'react';
import {
  Star,
  Check,
  X,
  AlertTriangle,
  RefreshCw,
  Gift,
  Instagram,
  ExternalLink,
  Plus,
  Trash2,
  Pencil,
  ClipboardList,
  Boxes,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useLanguage } from '../LanguageContext';

/**
 * Admin: review/reward queue with eligibility facts and evidence viewing,
 * rubric quality scoring (independent from stars/sentiment), gift pool
 * management with real stock, and gift grant history/fulfillment.
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

interface PoolItem {
  id: string;
  level: number;
  kind: string;
  label_ar: string;
  label_en: string;
  label_ckb: string;
  brand: string;
  material: string;
  color: string;
  option_value: string;
  compat_products: string[];
  stock: number;
  active: boolean;
}

interface GrantedGift {
  id: string;
  max_level: number;
  chosen_level: number | null;
  contents: Array<{ item_id: string; label_ar: string; label_en: string; option_value: string }>;
  state: 'available' | 'selected' | 'fulfilled' | 'cancelled';
  created_at: string;
  redeemed_at: string | null;
  customer: { email: string; username: string | null };
  quality_score: number | null;
  product: { id: string | null; name: string | null; name_ar: string | null };
}

const EMPTY_POOL_FORM = {
  level: 1, kind: 'accessory', label_ar: '', label_en: '', label_ckb: '', brand: '', material: '',
  color: '', option_value: '', compat: '', stock: 0, active: true,
};

export default function AdminReviews() {
  const { lang, dir, loc } = useLanguage();
  const S = STRINGS[lang] ?? STRINGS.ar;
  const [tab, setTab] = useState<'queue' | 'pools' | 'gifts'>('queue');

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

  // ---------------- pools state
  const [pools, setPools] = useState<PoolItem[]>([]);
  const [poolsLoading, setPoolsLoading] = useState(false);
  const [poolsError, setPoolsError] = useState('');
  const [poolForm, setPoolForm] = useState<typeof EMPTY_POOL_FORM>({ ...EMPTY_POOL_FORM });
  const [editingPoolId, setEditingPoolId] = useState<string | null>(null);
  const [poolFormOpen, setPoolFormOpen] = useState(false);
  const [poolSaving, setPoolSaving] = useState(false);
  const [poolFormError, setPoolFormError] = useState('');

  const loadPools = useCallback(async () => {
    setPoolsLoading(true);
    setPoolsError('');
    try {
      const res = await api.get<{ items: PoolItem[] }>('/api/reviews/admin/pools');
      setPools(res.items);
    } catch (e) {
      setPoolsError(e instanceof ApiError ? e.message : 'Failed to load pools');
    } finally {
      setPoolsLoading(false);
    }
  }, []);

  // ---------------- gifts state
  const [gifts, setGifts] = useState<GrantedGift[]>([]);
  const [giftsLoading, setGiftsLoading] = useState(false);
  const [giftsError, setGiftsError] = useState('');

  const loadGifts = useCallback(async () => {
    setGiftsLoading(true);
    setGiftsError('');
    try {
      const res = await api.get<{ gifts: GrantedGift[] }>('/api/reviews/admin/gifts');
      setGifts(res.gifts);
    } catch (e) {
      setGiftsError(e instanceof ApiError ? e.message : 'Failed to load gifts');
    } finally {
      setGiftsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'queue') loadQueue();
    else if (tab === 'pools') loadPools();
    else loadGifts();
  }, [tab, loadQueue, loadPools, loadGifts]);

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
    if (action === 'approve' && row.kind === 'printer_gift') payload.qualityScore = scoreDraft[row.review_id];
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

  // ---------------- pool actions

  const openPoolForm = (item?: PoolItem) => {
    setPoolFormError('');
    if (item) {
      setEditingPoolId(item.id);
      setPoolForm({
        level: item.level, kind: item.kind, label_ar: item.label_ar, label_en: item.label_en,
        label_ckb: item.label_ckb, brand: item.brand, material: item.material, color: item.color,
        option_value: item.option_value, compat: item.compat_products.join(', '), stock: item.stock, active: item.active,
      });
    } else {
      setEditingPoolId(null);
      setPoolForm({ ...EMPTY_POOL_FORM });
    }
    setPoolFormOpen(true);
  };

  const savePool = async (e: React.FormEvent) => {
    e.preventDefault();
    if (poolSaving) return;
    setPoolSaving(true);
    setPoolFormError('');
    const payload = {
      level: poolForm.level,
      kind: poolForm.kind,
      label_ar: poolForm.label_ar,
      label_en: poolForm.label_en,
      label_ckb: poolForm.label_ckb,
      brand: poolForm.brand,
      material: poolForm.material,
      color: poolForm.color,
      option_value: poolForm.option_value,
      compat_products: poolForm.compat.split(',').map((s) => s.trim()).filter(Boolean),
      stock: poolForm.stock,
      active: poolForm.active,
    };
    try {
      if (editingPoolId) await api.put(`/api/reviews/admin/pools/${editingPoolId}`, payload);
      else await api.post('/api/reviews/admin/pools', payload);
      setPoolFormOpen(false);
      await loadPools();
    } catch (err) {
      setPoolFormError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setPoolSaving(false);
    }
  };

  const deletePool = async (item: PoolItem) => {
    if (!window.confirm(S.delConfirm)) return;
    try {
      await api.delete(`/api/reviews/admin/pools/${item.id}`);
      await loadPools();
    } catch (e) {
      setPoolsError(e instanceof ApiError ? e.message : 'Delete failed');
    }
  };

  // ---------------- gift actions

  const fulfillGift = async (g: GrantedGift) => {
    try {
      await api.post(`/api/reviews/admin/gifts/${g.id}/fulfill`);
      await loadGifts();
    } catch (e) {
      setGiftsError(e instanceof ApiError ? e.message : 'Failed');
    }
  };

  const cancelGift = async (g: GrantedGift) => {
    const reason = window.prompt(S.cancelReason);
    if (reason === null || !reason.trim()) return;
    try {
      await api.post(`/api/reviews/admin/gifts/${g.id}/cancel`, { reason: reason.trim() });
      await loadGifts();
    } catch (e) {
      setGiftsError(e instanceof ApiError ? e.message : 'Failed');
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
        <div className="flex bg-zinc-900 border border-zinc-800 p-1 rounded-xl">
          {(
            [
              { id: 'queue', icon: ClipboardList, label: S.tabs.queue },
              { id: 'pools', icon: Boxes, label: S.tabs.pools },
              { id: 'gifts', icon: Gift, label: S.tabs.gifts },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                tab === t.id ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <t.icon className="w-3.5 h-3.5" /> {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ------------------------------------------------ QUEUE */}
      {tab === 'queue' && (
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
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#6B46FF]/10 text-[#a78bfa] border border-[#6B46FF]/30">
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

                    <div>
                      <div className="text-[11px] font-bold text-zinc-500 mb-1 flex items-center gap-1">
                        <Instagram className="w-3.5 h-3.5 text-pink-400" /> {S.evidence}
                      </div>
                      {row.instagram ? (
                        <div className="flex items-center gap-3 text-[12px]">
                          {row.instagram.link && (
                            <a href={row.instagram.link} target="_blank" rel="noreferrer" className="text-[#a78bfa] underline flex items-center gap-1" dir="ltr">
                              {row.instagram.link} <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                          {row.instagram.file_url && (
                            <a href={row.instagram.file_url} target="_blank" rel="noreferrer" className="text-[#a78bfa] underline flex items-center gap-1">
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
                                      scoreDraft[row.review_id] === n
                                        ? 'bg-[#6B46FF] border-[#6B46FF] text-white'
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
                              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-[13px] text-white focus:border-[#6B46FF] outline-none"
                            />
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {row.kind === 'printer_gift' ? (
                              <button
                                disabled={
                                  busyId === row.review_id ||
                                  !scoreDraft[row.review_id] ||
                                  (rubricDraft[row.review_id]?.trim().length ?? 0) < 10
                                }
                                onClick={() => decideReward(row, 'approve')}
                                className="text-[12px] font-bold bg-[#6B46FF] hover:bg-[#5A38E6] disabled:opacity-40 px-4 py-1.5 rounded-full"
                              >
                                {busyId === row.review_id ? S.working : S.approveGift}
                              </button>
                            ) : pointsConfigured !== null ? (
                              <button
                                disabled={busyId === row.review_id || (rubricDraft[row.review_id]?.trim().length ?? 0) < 3}
                                onClick={() => decideReward(row, 'approve')}
                                className="text-[12px] font-bold bg-[#6B46FF] hover:bg-[#5A38E6] disabled:opacity-40 px-4 py-1.5 rounded-full"
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

      {/* ------------------------------------------------ POOLS */}
      {tab === 'pools' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <p className="text-[12px] text-zinc-500 max-w-xl">{S.poolNote}</p>
            <div className="flex items-center gap-2">
              <button
                onClick={loadPools}
                className="p-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-xl text-zinc-300 transition-colors"
                title={S.refresh}
              >
                <RefreshCw className={`w-4 h-4 ${poolsLoading ? 'animate-spin' : ''}`} />
              </button>
              <button
                onClick={() => openPoolForm()}
                className="flex items-center gap-2 bg-[#6B46FF] hover:bg-[#5A38E6] text-white text-sm font-bold px-4 py-2 rounded-full transition-colors"
              >
                <Plus className="w-4 h-4" /> {S.addItem}
              </button>
            </div>
          </div>

          {poolsError && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-3 text-sm">{poolsError}</div>
          )}

          {poolFormOpen && (
            <form onSubmit={savePool} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-zinc-500 mb-1">{S.level}</label>
                <select
                  value={poolForm.level}
                  onChange={(e) => setPoolForm((f) => ({ ...f, level: Number(e.target.value) }))}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm"
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-zinc-500 mb-1">{S.kind}</label>
                <select
                  value={poolForm.kind}
                  onChange={(e) => setPoolForm((f) => ({ ...f, kind: e.target.value }))}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm"
                >
                  {['accessory', 'filament', 'nozzle', 'plate', 'other'].map((k) => (
                    <option key={k} value={k}>{S.kindNames[k]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-zinc-500 mb-1">{S.stock}</label>
                <input
                  type="number"
                  min={0}
                  value={poolForm.stock}
                  onChange={(e) => setPoolForm((f) => ({ ...f, stock: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-zinc-500 mb-1">{S.labelAr}</label>
                <input
                  value={poolForm.label_ar}
                  onChange={(e) => setPoolForm((f) => ({ ...f, label_ar: e.target.value }))}
                  required
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-zinc-500 mb-1">{S.labelEn}</label>
                <input
                  value={poolForm.label_en}
                  onChange={(e) => setPoolForm((f) => ({ ...f, label_en: e.target.value }))}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-zinc-500 mb-1">{S.labelCkb}</label>
                <input
                  value={poolForm.label_ckb}
                  onChange={(e) => setPoolForm((f) => ({ ...f, label_ckb: e.target.value }))}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-zinc-500 mb-1">{S.brand}</label>
                <input
                  value={poolForm.brand}
                  onChange={(e) => setPoolForm((f) => ({ ...f, brand: e.target.value }))}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-zinc-500 mb-1">{S.material}</label>
                <input
                  value={poolForm.material}
                  onChange={(e) => setPoolForm((f) => ({ ...f, material: e.target.value }))}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-zinc-500 mb-1">{S.color}</label>
                <input
                  value={poolForm.color}
                  onChange={(e) => setPoolForm((f) => ({ ...f, color: e.target.value }))}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-zinc-500 mb-1">{S.optionValue}</label>
                <input
                  value={poolForm.option_value}
                  onChange={(e) => setPoolForm((f) => ({ ...f, option_value: e.target.value }))}
                  placeholder="0.4"
                  dir="ltr"
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-[11px] font-bold text-zinc-500 mb-1">{S.compat}</label>
                <input
                  value={poolForm.compat}
                  onChange={(e) => setPoolForm((f) => ({ ...f, compat: e.target.value }))}
                  dir="ltr"
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="pool-active"
                  type="checkbox"
                  checked={poolForm.active}
                  onChange={(e) => setPoolForm((f) => ({ ...f, active: e.target.checked }))}
                />
                <label htmlFor="pool-active" className="text-[12px] font-bold text-zinc-400">{S.active}</label>
              </div>
              {poolFormError && (
                <div className="md:col-span-3 bg-red-500/10 border border-red-500/30 text-red-400 text-[12px] rounded-xl p-3">
                  {poolFormError}
                </div>
              )}
              <div className="md:col-span-3 flex gap-2">
                <button
                  type="submit"
                  disabled={poolSaving}
                  className="bg-[#6B46FF] hover:bg-[#5A38E6] disabled:opacity-50 text-white text-sm font-bold px-6 py-2 rounded-full transition-colors"
                >
                  {poolSaving ? S.working : S.save}
                </button>
                <button
                  type="button"
                  onClick={() => setPoolFormOpen(false)}
                  className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-bold px-6 py-2 rounded-full transition-colors"
                >
                  {S.cancel}
                </button>
              </div>
            </form>
          )}

          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left rtl:text-right border-collapse min-w-[760px]">
                <thead>
                  <tr className="bg-zinc-800/50 border-b border-zinc-700 text-[11px] text-zinc-400 uppercase">
                    <th className="py-3 px-4">{S.level}</th>
                    <th className="py-3 px-4">{S.kind}</th>
                    <th className="py-3 px-4">{S.labelAr}</th>
                    <th className="py-3 px-4">{S.brand}/{S.material}/{S.color}</th>
                    <th className="py-3 px-4">{S.optionValue.split(' ')[0]}</th>
                    <th className="py-3 px-4">{S.stock}</th>
                    <th className="py-3 px-4">{S.active}</th>
                    <th className="py-3 px-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {pools.map((it) => (
                    <tr key={it.id} className="border-b border-zinc-800 hover:bg-zinc-800/30">
                      <td className="py-3 px-4 font-black">{it.level}</td>
                      <td className="py-3 px-4 text-[13px]">{S.kindNames[it.kind] ?? it.kind}</td>
                      <td className="py-3 px-4 text-[13px]">{loc(it.label_ar, it.label_en || it.label_ar, it.label_ckb || undefined)}</td>
                      <td className="py-3 px-4 text-[12px] text-zinc-400">
                        {[it.brand, it.material, it.color].filter(Boolean).join(' / ') || '—'}
                      </td>
                      <td className="py-3 px-4 text-[12px]" dir="ltr">{it.option_value || '—'}</td>
                      <td className={`py-3 px-4 font-bold ${it.stock === 0 ? 'text-red-400' : 'text-white'}`}>{it.stock}</td>
                      <td className="py-3 px-4">{it.active ? <Check className="w-4 h-4 text-green-400" /> : <X className="w-4 h-4 text-zinc-600" />}</td>
                      <td className="py-3 px-4">
                        <div className="flex gap-1">
                          <button onClick={() => openPoolForm(it)} className="p-1.5 text-zinc-400 hover:text-white" title={S.edit}>
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button onClick={() => deletePool(it)} className="p-1.5 text-zinc-400 hover:text-red-400" title={S.del}>
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!poolsLoading && pools.length === 0 && (
                    <tr>
                      <td colSpan={8} className="py-10 text-center text-zinc-500">{S.empty}</td>
                    </tr>
                  )}
                  {poolsLoading && pools.length === 0 && (
                    <tr>
                      <td colSpan={8} className="py-10 text-center text-zinc-500">{S.loading}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------ GIFTS */}
      {tab === 'gifts' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={loadGifts}
              className="p-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-xl text-zinc-300 transition-colors"
              title={S.refresh}
            >
              <RefreshCw className={`w-4 h-4 ${giftsLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          {giftsError && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-3 text-sm">{giftsError}</div>
          )}
          {giftsLoading && gifts.length === 0 && <div className="text-center text-zinc-500 py-10">{S.loading}</div>}
          {!giftsLoading && gifts.length === 0 && !giftsError && (
            <div className="text-center text-zinc-500 py-10">{S.empty}</div>
          )}
          {gifts.map((g) => (
            <div key={g.id} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-bold truncate">{g.customer.email}</div>
                  <div className="text-[11px] text-zinc-500 truncate">
                    {productName(g.product)} · {S.score} {g.quality_score ?? g.max_level}/5 · {new Date(g.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700">
                    {S.giftStates[g.state]}
                  </span>
                  {g.state === 'selected' && (
                    <button
                      onClick={() => fulfillGift(g)}
                      className="text-[11px] font-bold bg-green-600/80 hover:bg-green-600 px-3 py-1 rounded-full"
                    >
                      {S.fulfill}
                    </button>
                  )}
                  {g.state === 'available' && (
                    <button
                      onClick={() => cancelGift(g)}
                      className="text-[11px] font-bold bg-red-600/60 hover:bg-red-600 px-3 py-1 rounded-full"
                    >
                      {S.cancelGift}
                    </button>
                  )}
                </div>
              </div>
              {g.chosen_level ? (
                <div className="text-[12px] text-zinc-300">
                  {S.contents} ({S.level} {g.chosen_level}):{' '}
                  {g.contents
                    .map((it) => loc(it.label_ar, it.label_en || it.label_ar) + (it.option_value ? ` (${it.option_value})` : ''))
                    .join('، ')}
                </div>
              ) : (
                <div className="text-[12px] text-zinc-500">{S.notRedeemed}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
