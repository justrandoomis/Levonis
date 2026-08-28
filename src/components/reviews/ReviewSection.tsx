import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Star, Camera, Video, Instagram, X, ShieldCheck, BadgeCheck, Gift, Pencil } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';

/**
 * Product-page review section (mandate §5): submit + public list.
 * - Public list shows APPROVED reviews only, masked reviewer names and an
 *   incentivized-review disclosure; Instagram evidence never appears here.
 * - Submission requires a delivered order that contains the product; the
 *   printer gift path additionally needs written detail, photos, video and
 *   private Instagram evidence.
 * - No success UI before the server confirms.
 */

const STRINGS = {
  ar: {
    title: 'التقييمات والمراجعات',
    empty: 'لا توجد مراجعات منشورة بعد.',
    loadError: 'تعذّر تحميل المراجعات.',
    loadMore: 'عرض المزيد',
    loading: 'جارٍ التحميل...',
    write: 'اكتب مراجعتك',
    edit: 'تعديل مراجعتك',
    incentivized: 'مراجعة ضمن برنامج المكافآت',
    verified: 'شراء مؤكد',
    notEligible: 'المراجعات متاحة لمن استلم المنتج ضمن طلب مُسلَّم.',
    signInToReview: 'سجّل الدخول لكتابة مراجعة بعد استلام طلبك.',
    myReview: 'مراجعتك',
    statusPending: 'قيد المراجعة',
    statusPublished: 'منشورة',
    statusRejected: 'مرفوضة',
    moderationNote: 'ملاحظة الإدارة',
    rewardState: 'حالة المكافأة',
    rSubmitted: 'قيد التقييم',
    rRevision: 'مطلوب تعديل',
    rApproved: 'مقبولة',
    rRejected: 'مرفوضة',
    rewardReason: 'سبب القرار',
    qualityScore: 'درجة الجودة',
    printerNotice:
      'هذا المنتج ضمن برنامج هدايا الطابعات: مراجعة مكتوبة مفصّلة + صور + فيديو + دليل ستوري إنستغرام (خاص، للمراجعة الإدارية فقط). درجة الجودة مستقلة عن عدد النجوم — المراجعة النقدية الصادقة لا تُنقص المكافأة.',
    pointsNotice: (n: number) => `المراجعات المقبولة لهذا المنتج تمنح ${n.toLocaleString()} نقطة.`,
    pointsUnconfigured: 'قيمة نقاط المراجعة لم تُحدَّد بعد من الإدارة — ستظهر هنا عند إعدادها.',
    order: 'الطلب',
    stars: 'التقييم بالنجوم',
    bodyLabel: 'نص المراجعة',
    bodyPlaceholder: 'اكتب تجربتك الفعلية مع المنتج بالتفصيل...',
    photos: 'الصور',
    addPhoto: 'إضافة صورة',
    videoLabel: 'فيديو (مطلوب لهدية الطابعة)',
    addVideo: 'إضافة فيديو',
    igTitle: 'دليل ستوري إنستغرام (خاص)',
    igPrivacy: 'يُعرض للإدارة فقط لتأكيد الأهلية، ولا يُنشر أبدًا. الستوري تنتهي خلال 24 ساعة — لقطة الشاشة هي الدليل الدائم.',
    igLink: 'رابط الستوري / الحساب',
    igShot: 'لقطة شاشة للستوري',
    addShot: 'رفع لقطة',
    uploading: 'جارٍ الرفع...',
    submit: 'إرسال المراجعة',
    saveEdit: 'حفظ التعديل',
    submitting: 'جارٍ الإرسال...',
    cancel: 'إلغاء',
    remove: 'إزالة',
    reviewsCount: (n: number) => `${n.toLocaleString()} مراجعة`,
    disclosure: 'قد يحصل أصحاب المراجعات المؤهلة على مكافآت (هدايا أو نقاط) — يُفصح عن ذلك في المراجعات المنشورة.',
    keptNote: 'وسائطك الحالية تبقى محفوظة ما لم ترفع بديلاً عنها.',
  },
  en: {
    title: 'Ratings & Reviews',
    empty: 'No published reviews yet.',
    loadError: 'Could not load reviews.',
    loadMore: 'Load more',
    loading: 'Loading...',
    write: 'Write your review',
    edit: 'Edit your review',
    incentivized: 'Rewards-program review',
    verified: 'Verified purchase',
    notEligible: 'Reviews are open to customers with a delivered order containing this product.',
    signInToReview: 'Sign in to review after your order is delivered.',
    myReview: 'Your review',
    statusPending: 'Pending review',
    statusPublished: 'Published',
    statusRejected: 'Rejected',
    moderationNote: 'Moderation note',
    rewardState: 'Reward status',
    rSubmitted: 'Being evaluated',
    rRevision: 'Changes requested',
    rApproved: 'Approved',
    rRejected: 'Rejected',
    rewardReason: 'Decision reason',
    qualityScore: 'Quality score',
    printerNotice:
      'This product is in the printer gift program: a detailed written review + photos + video + an Instagram story proof (private, for admin review only). The quality score is independent of your star rating — an honest critical review never lowers the reward.',
    pointsNotice: (n: number) => `Approved reviews of this product earn ${n.toLocaleString()} points.`,
    pointsUnconfigured: 'The review-points value has not been configured by the store yet — it will appear here once set.',
    order: 'Order',
    stars: 'Star rating',
    bodyLabel: 'Review text',
    bodyPlaceholder: 'Describe your real experience with the product in detail...',
    photos: 'Photos',
    addPhoto: 'Add photo',
    videoLabel: 'Video (required for the printer gift)',
    addVideo: 'Add video',
    igTitle: 'Instagram story evidence (private)',
    igPrivacy: 'Shown to administrators only to confirm eligibility; never published. Stories expire in 24h — a screenshot is the durable proof.',
    igLink: 'Story / account link',
    igShot: 'Story screenshot',
    addShot: 'Upload capture',
    uploading: 'Uploading...',
    submit: 'Submit review',
    saveEdit: 'Save changes',
    submitting: 'Submitting...',
    cancel: 'Cancel',
    remove: 'Remove',
    reviewsCount: (n: number) => `${n.toLocaleString()} reviews`,
    disclosure: 'Eligible reviews may receive rewards (gifts or points) — published reviews disclose this.',
    keptNote: 'Your current media is kept unless you upload replacements.',
  },
  ckb: {
    title: 'هەڵسەنگاندن و پێداچوونەوەکان',
    empty: 'هێشتا هیچ پێداچوونەوەیەکی بڵاوکراوە نییە.',
    loadError: 'پێداچوونەوەکان بار نەبوون.',
    loadMore: 'زیاتر ببینە',
    loading: 'باردەکرێت...',
    write: 'پێداچوونەوەکەت بنووسە',
    edit: 'دەستکاری پێداچوونەوەکەت بکە',
    incentivized: 'پێداچوونەوەی بەرنامەی خەڵات',
    verified: 'کڕینی پشتڕاستکراو',
    notEligible: 'پێداچوونەوە بۆ ئەو کڕیارانەیە کە داواکارییەکی گەیشتوویان هەیە لەگەڵ ئەم بەرهەمە.',
    signInToReview: 'بچۆ ژوورەوە بۆ نووسینی پێداچوونەوە دوای گەیشتنی داواکارییەکەت.',
    myReview: 'پێداچوونەوەکەت',
    statusPending: 'لە چاوەڕوانیدایە',
    statusPublished: 'بڵاوکراوەتەوە',
    statusRejected: 'ڕەتکراوەتەوە',
    moderationNote: 'تێبینی بەڕێوەبەرایەتی',
    rewardState: 'دۆخی خەڵات',
    rSubmitted: 'لە هەڵسەنگاندندایە',
    rRevision: 'گۆڕانکاری داواکراوە',
    rApproved: 'پەسەندکراوە',
    rRejected: 'ڕەتکراوەتەوە',
    rewardReason: 'هۆکاری بڕیار',
    qualityScore: 'نمرەی کوالیتی',
    printerNotice:
      'ئەم بەرهەمە لە بەرنامەی دیاری پرینتەرەکاندایە: پێداچوونەوەی نووسراوی وردەکاری + وێنە + ڤیدیۆ + بەڵگەی ستۆری ئینستاگرام (تایبەت، تەنها بۆ پێداچوونەوەی بەڕێوەبەرایەتی). نمرەی کوالیتی سەربەخۆیە لە ئەستێرەکان — پێداچوونەوەی ڕەخنەگرانەی ڕاستگۆ خەڵاتەکە کەم ناکاتەوە.',
    pointsNotice: (n: number) => `پێداچوونەوە پەسەندکراوەکانی ئەم بەرهەمە ${n.toLocaleString()} خاڵ بەدەست دەهێنن.`,
    pointsUnconfigured: 'بەهای خاڵی پێداچوونەوە هێشتا لەلایەن فرۆشگاوە دیاری نەکراوە — کاتێک ڕێکخرا لێرە دەردەکەوێت.',
    order: 'داواکاری',
    stars: 'هەڵسەنگاندن بە ئەستێرە',
    bodyLabel: 'دەقی پێداچوونەوە',
    bodyPlaceholder: 'ئەزموونی ڕاستەقینەت لەگەڵ بەرهەمەکە بە وردی بنووسە...',
    photos: 'وێنەکان',
    addPhoto: 'زیادکردنی وێنە',
    videoLabel: 'ڤیدیۆ (پێویستە بۆ دیاری پرینتەر)',
    addVideo: 'زیادکردنی ڤیدیۆ',
    igTitle: 'بەڵگەی ستۆری ئینستاگرام (تایبەت)',
    igPrivacy: 'تەنها بۆ بەڕێوەبەرایەتی پیشان دەدرێت بۆ پشتڕاستکردنەوەی شایستەیی؛ هەرگیز بڵاوناکرێتەوە. ستۆری لە ٢٤ کاتژمێردا بەسەردەچێت — وێنەی شاشە بەڵگەی بەردەوامە.',
    igLink: 'بەستەری ستۆری / هەژمار',
    igShot: 'وێنەی شاشەی ستۆری',
    addShot: 'بارکردنی وێنە',
    uploading: 'باردەکرێت...',
    submit: 'ناردنی پێداچوونەوە',
    saveEdit: 'پاشەکەوتکردنی گۆڕانکاری',
    submitting: 'دەنێردرێت...',
    cancel: 'هەڵوەشاندنەوە',
    remove: 'لابردن',
    reviewsCount: (n: number) => `${n.toLocaleString()} پێداچوونەوە`,
    disclosure: 'پێداچوونەوە شایستەکان لەوانەیە خەڵات وەربگرن (دیاری یان خاڵ) — لە پێداچوونەوە بڵاوکراوەکاندا ئەمە ڕوون دەکرێتەوە.',
    keptNote: 'میدیاکانی ئێستات دەمێننەوە مەگەر جێگرەوەیان بار بکەیت.',
  },
};

interface MediaRef { url: string; kind: 'image' | 'video' }
interface PublicReview {
  id: string;
  stars: number;
  body: string;
  media: MediaRef[];
  created_at: string;
  reviewer: string;
  incentivized: boolean;
  verified_purchase: boolean;
}
interface MyReview {
  id: string;
  order_id: string | null;
  stars: number;
  body: string;
  media: MediaRef[];
  status: 'pending' | 'published' | 'rejected';
  moderation_note: string;
  reward: {
    kind: 'printer_gift' | 'points';
    state: 'submitted' | 'revision_needed' | 'approved' | 'rejected';
    quality_score: number | null;
    reason: string;
    points_awarded: number;
    instagram: { link: string; file_url: string | null } | null;
  };
}
interface Eligibility {
  eligible_orders: Array<{ id: string; delivered_at: string | null }>;
  existing_review: MyReview | null;
  is_printer: boolean;
  review_points: number | null;
}
interface UploadedFile { key: string; url: string; kind: 'image' | 'video' }

function Stars({ value, onChange, size = 'w-5 h-5' }: { value: number; onChange?: (n: number) => void; size?: string }) {
  return (
    <div className="flex gap-0.5" role={onChange ? 'radiogroup' : undefined}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={!onChange}
          onClick={() => onChange?.(n)}
          aria-label={`${n} / 5`}
          className={onChange ? 'p-0.5' : 'pointer-events-none'}
        >
          <Star className={`${size} ${n <= value ? 'text-yellow-400 fill-yellow-400' : 'text-zinc-600'}`} />
        </button>
      ))}
    </div>
  );
}

async function uploadReviewFile(file: File, purpose: 'media' | 'evidence'): Promise<UploadedFile> {
  const form = new FormData();
  form.append('purpose', purpose);
  form.append('file', file);
  return api.post<UploadedFile>('/api/reviews/uploads', form);
}

export default function ReviewSection({ productId }: { productId: string }) {
  const { lang, dir } = useLanguage();
  const S = STRINGS[lang] ?? STRINGS.ar;
  const { isAuthenticated } = useAuth();

  const [reviews, setReviews] = useState<PublicReview[]>([]);
  const [total, setTotal] = useState(0);
  const [avg, setAvg] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');

  const [eligibility, setEligibility] = useState<Eligibility | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [orderId, setOrderId] = useState('');
  const [stars, setStars] = useState(0);
  const [body, setBody] = useState('');
  const [photos, setPhotos] = useState<UploadedFile[]>([]);
  const [video, setVideo] = useState<UploadedFile | null>(null);
  const [igLink, setIgLink] = useState('');
  const [igShot, setIgShot] = useState<UploadedFile | null>(null);
  const [uploadingWhat, setUploadingWhat] = useState<'' | 'photo' | 'video' | 'evidence'>('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const photoInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const shotInput = useRef<HTMLInputElement>(null);

  const loadPage = useCallback(
    async (p: number, replace: boolean) => {
      setListLoading(true);
      setListError('');
      try {
        const res = await api.get<{ total: number; avg_stars: number | null; reviews: PublicReview[] }>(
          `/api/reviews/product/${encodeURIComponent(productId)}?page=${p}`
        );
        setTotal(res.total);
        setAvg(res.avg_stars);
        setReviews((prev) => (replace ? res.reviews : [...prev, ...res.reviews]));
        setPage(p);
      } catch (e) {
        setListError(e instanceof ApiError ? e.message : S.loadError);
      } finally {
        setListLoading(false);
      }
    },
    [productId, S.loadError]
  );

  const loadEligibility = useCallback(async () => {
    if (!isAuthenticated) {
      setEligibility(null);
      return;
    }
    try {
      const res = await api.get<Eligibility & { success: boolean }>(`/api/reviews/eligibility/${encodeURIComponent(productId)}`);
      setEligibility(res);
    } catch {
      setEligibility(null);
    }
  }, [productId, isAuthenticated]);

  useEffect(() => {
    loadPage(1, true);
  }, [loadPage]);
  useEffect(() => {
    loadEligibility();
  }, [loadEligibility]);

  const existing = eligibility?.existing_review ?? null;
  const canEdit = !!existing && existing.status === 'pending' && ['submitted', 'revision_needed'].includes(existing.reward.state);
  const canCreate = !existing && (eligibility?.eligible_orders.length ?? 0) > 0;

  const openForm = () => {
    setFormError('');
    if (existing) {
      setOrderId(existing.order_id ?? eligibility?.eligible_orders[0]?.id ?? '');
      setStars(existing.stars);
      setBody(existing.body);
      // Existing media keys are not re-derivable from URLs safely for editing
      // composition; the user re-attaches media on edit (server replaces).
      setPhotos([]);
      setVideo(null);
      setIgLink(existing.reward.instagram?.link ?? '');
      setIgShot(null);
    } else {
      setOrderId(eligibility?.eligible_orders[0]?.id ?? '');
      setStars(0);
      setBody('');
      setPhotos([]);
      setVideo(null);
      setIgLink('');
      setIgShot(null);
    }
    setShowForm(true);
  };

  const handleFile = async (file: File | undefined, what: 'photo' | 'video' | 'evidence') => {
    if (!file) return;
    setFormError('');
    setUploadingWhat(what);
    try {
      const up = await uploadReviewFile(file, what === 'evidence' ? 'evidence' : 'media');
      if (what === 'photo') setPhotos((p) => [...p, up]);
      else if (what === 'video') setVideo(up);
      else setIgShot(up);
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : 'Upload failed');
    } finally {
      setUploadingWhat('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || stars < 1) return;
    setFormError('');
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = { productId, orderId, stars, body };
      // On EDIT, omitted media/evidence fields keep what the review already
      // has server-side — attaching new files replaces them.
      if (!existing || photos.length > 0) payload.photoKeys = photos.map((p) => p.key);
      if (!existing) {
        if (video) payload.videoKey = video.key;
        if (igLink || igShot) payload.instagram = { link: igLink || undefined, key: igShot?.key || undefined };
      } else {
        if (video) payload.videoKey = video.key;
        const existingShotKey = existing.reward.instagram?.file_url?.replace('/api/reviews/media/', '') || undefined;
        const mergedKey = igShot?.key || existingShotKey;
        if (igLink || mergedKey) payload.instagram = { link: igLink || undefined, key: mergedKey };
      }
      if (existing) await api.put(`/api/reviews/${existing.id}`, payload);
      else await api.post('/api/reviews', payload);
      setShowForm(false);
      await Promise.all([loadEligibility(), loadPage(1, true)]);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to submit');
    } finally {
      setSubmitting(false);
    }
  };

  const statusLabel = (s: MyReview['status']) =>
    s === 'published' ? S.statusPublished : s === 'rejected' ? S.statusRejected : S.statusPending;
  const rewardLabel = (s: MyReview['reward']['state']) =>
    s === 'approved' ? S.rApproved : s === 'rejected' ? S.rRejected : s === 'revision_needed' ? S.rRevision : S.rSubmitted;

  return (
    <section dir={dir} className="mt-8 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-black text-white">{S.title}</h2>
          {avg !== null && (
            <span className="flex items-center gap-1.5 text-sm text-zinc-300">
              <Star className="w-4 h-4 text-yellow-400 fill-yellow-400" />
              <b>{avg}</b>
              <span className="text-zinc-500 text-xs">{S.reviewsCount(total)}</span>
            </span>
          )}
        </div>
        {isAuthenticated && (canCreate || canEdit) && (
          <button
            onClick={openForm}
            className="flex items-center gap-2 bg-[#6B46FF] hover:bg-[#5A38E6] text-white text-sm font-bold px-4 py-2 rounded-full transition-colors"
          >
            {existing ? <Pencil className="w-4 h-4" /> : <Star className="w-4 h-4" />}
            {existing ? S.edit : S.write}
          </button>
        )}
      </div>

      <p className="text-[11px] text-zinc-500">{S.disclosure}</p>

      {/* Program notice — honest states, no invented values */}
      {eligibility && (canCreate || canEdit) && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-3 text-[12px] text-zinc-400 flex gap-2">
          <Gift className="w-4 h-4 text-[#6B46FF] shrink-0 mt-0.5" />
          <span>
            {eligibility.is_printer
              ? S.printerNotice
              : eligibility.review_points !== null
                ? S.pointsNotice(eligibility.review_points)
                : S.pointsUnconfigured}
          </span>
        </div>
      )}
      {isAuthenticated && eligibility && !existing && eligibility.eligible_orders.length === 0 && (
        <div className="text-[12px] text-zinc-500">{S.notEligible}</div>
      )}
      {!isAuthenticated && <div className="text-[12px] text-zinc-500">{S.signInToReview}</div>}

      {/* My review status card */}
      {existing && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-sm font-bold text-white">{S.myReview}</span>
            <span
              className={`text-[11px] font-bold px-2.5 py-1 rounded-full border ${
                existing.status === 'published'
                  ? 'bg-green-500/10 text-green-400 border-green-500/30'
                  : existing.status === 'rejected'
                    ? 'bg-red-500/10 text-red-400 border-red-500/30'
                    : 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30'
              }`}
            >
              {statusLabel(existing.status)}
            </span>
          </div>
          <Stars value={existing.stars} size="w-4 h-4" />
          <p className="text-[13px] text-zinc-300 whitespace-pre-wrap break-words">{existing.body}</p>
          {existing.moderation_note && (
            <p className="text-[12px] text-amber-400">
              {S.moderationNote}: {existing.moderation_note}
            </p>
          )}
          <div className="text-[12px] text-zinc-400 flex flex-wrap items-center gap-2">
            <span>
              {S.rewardState}: <b className="text-zinc-200">{rewardLabel(existing.reward.state)}</b>
            </span>
            {existing.reward.quality_score !== null && (
              <span>
                {S.qualityScore}: <b className="text-zinc-200">{existing.reward.quality_score}/5</b>
              </span>
            )}
          </div>
          {existing.reward.reason && (
            <p className="text-[12px] text-zinc-500">
              {S.rewardReason}: {existing.reward.reason}
            </p>
          )}
        </div>
      )}

      {/* Submission form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-4">
          {(eligibility?.eligible_orders.length ?? 0) > 1 && !existing && (
            <div>
              <label className="block text-[12px] font-bold text-zinc-400 mb-1">{S.order}</label>
              <select
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:border-[#6B46FF] outline-none"
              >
                {eligibility!.eligible_orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.id}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-[12px] font-bold text-zinc-400 mb-1">{S.stars}</label>
            <Stars value={stars} onChange={setStars} size="w-7 h-7" />
          </div>

          <div>
            <label className="block text-[12px] font-bold text-zinc-400 mb-1">{S.bodyLabel}</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder={S.bodyPlaceholder}
              className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:border-[#6B46FF] outline-none resize-y"
              required
            />
          </div>

          <div>
            <label className="block text-[12px] font-bold text-zinc-400 mb-1">{S.photos}</label>
            {existing && existing.media.length > 0 && photos.length === 0 && !video && (
              <p className="text-[11px] text-zinc-500 mb-2">{S.keptNote}</p>
            )}
            <div className="flex flex-wrap gap-2">
              {photos.map((p) => (
                <div key={p.key} className="relative">
                  <img src={p.url} alt="" className="w-16 h-16 object-cover rounded-lg border border-zinc-700" />
                  <button
                    type="button"
                    aria-label={S.remove}
                    onClick={() => setPhotos((ps) => ps.filter((x) => x.key !== p.key))}
                    className="absolute -top-1.5 -right-1.5 bg-zinc-800 border border-zinc-600 rounded-full p-0.5"
                  >
                    <X className="w-3 h-3 text-zinc-300" />
                  </button>
                </div>
              ))}
              {photos.length < 6 && (
                <button
                  type="button"
                  disabled={uploadingWhat !== ''}
                  onClick={() => photoInput.current?.click()}
                  className="w-16 h-16 rounded-lg border border-dashed border-zinc-600 flex flex-col items-center justify-center text-zinc-500 hover:text-zinc-300 hover:border-zinc-400 transition-colors disabled:opacity-50"
                >
                  <Camera className="w-5 h-5" />
                  <span className="text-[9px] mt-0.5">{uploadingWhat === 'photo' ? S.uploading : S.addPhoto}</span>
                </button>
              )}
              <input
                ref={photoInput}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  handleFile(e.target.files?.[0], 'photo');
                  e.target.value = '';
                }}
              />
            </div>
          </div>

          <div>
            <label className="block text-[12px] font-bold text-zinc-400 mb-1">{S.videoLabel}</label>
            {video ? (
              <div className="flex items-center gap-2 text-[12px] text-zinc-300">
                <Video className="w-4 h-4 text-[#6B46FF]" />
                <span className="truncate max-w-[200px]">{video.key.split('/').pop()}</span>
                <button type="button" onClick={() => setVideo(null)} className="text-red-400 text-[11px] font-bold">
                  {S.remove}
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={uploadingWhat !== ''}
                onClick={() => videoInput.current?.click()}
                className="flex items-center gap-2 text-[12px] font-bold text-zinc-400 border border-dashed border-zinc-600 rounded-lg px-3 py-2 hover:text-zinc-200 hover:border-zinc-400 transition-colors disabled:opacity-50"
              >
                <Video className="w-4 h-4" /> {uploadingWhat === 'video' ? S.uploading : S.addVideo}
              </button>
            )}
            <input
              ref={videoInput}
              type="file"
              accept="video/mp4"
              className="hidden"
              onChange={(e) => {
                handleFile(e.target.files?.[0], 'video');
                e.target.value = '';
              }}
            />
          </div>

          {eligibility?.is_printer && (
            <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 space-y-2">
              <div className="flex items-center gap-2 text-[12px] font-bold text-zinc-300">
                <Instagram className="w-4 h-4 text-pink-400" /> {S.igTitle}
              </div>
              <p className="text-[11px] text-zinc-500">{S.igPrivacy}</p>
              <input
                type="url"
                value={igLink}
                onChange={(e) => setIgLink(e.target.value)}
                placeholder={S.igLink}
                dir="ltr"
                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:border-[#6B46FF] outline-none"
              />
              <div className="flex items-center gap-2">
                {igShot ? (
                  <div className="flex items-center gap-2 text-[12px] text-zinc-300">
                    <img src={igShot.url} alt="" className="w-10 h-10 object-cover rounded border border-zinc-700" />
                    <button type="button" onClick={() => setIgShot(null)} className="text-red-400 text-[11px] font-bold">
                      {S.remove}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={uploadingWhat !== ''}
                    onClick={() => shotInput.current?.click()}
                    className="text-[12px] font-bold text-zinc-400 border border-dashed border-zinc-600 rounded-lg px-3 py-1.5 hover:text-zinc-200 transition-colors disabled:opacity-50"
                  >
                    {uploadingWhat === 'evidence' ? S.uploading : `${S.addShot} (${S.igShot})`}
                  </button>
                )}
                <input
                  ref={shotInput}
                  type="file"
                  accept="image/*,video/mp4"
                  className="hidden"
                  onChange={(e) => {
                    handleFile(e.target.files?.[0], 'evidence');
                    e.target.value = '';
                  }}
                />
              </div>
            </div>
          )}

          {formError && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[12px] font-medium rounded-xl p-3">
              {formError}
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting || uploadingWhat !== '' || stars < 1 || !body.trim() || !orderId}
              className="flex-1 bg-[#6B46FF] hover:bg-[#5A38E6] disabled:opacity-50 text-white text-sm font-bold py-2.5 rounded-full transition-colors"
            >
              {submitting ? S.submitting : existing ? S.saveEdit : S.submit}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-bold py-2.5 rounded-full transition-colors"
            >
              {S.cancel}
            </button>
          </div>
        </form>
      )}

      {/* Public list */}
      {listError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[12px] font-medium rounded-xl p-3">
          {listError}
        </div>
      )}
      {!listError && reviews.length === 0 && !listLoading && (
        <div className="text-[13px] text-zinc-500 text-center py-6">{S.empty}</div>
      )}
      <div className="space-y-3">
        {reviews.map((r) => (
          <article key={r.id} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-white">{r.reviewer}</span>
                {r.verified_purchase && (
                  <span className="flex items-center gap-1 text-[10px] font-bold text-green-400 bg-green-500/10 border border-green-500/30 px-2 py-0.5 rounded-full">
                    <BadgeCheck className="w-3 h-3" /> {S.verified}
                  </span>
                )}
                {r.incentivized && (
                  <span className="flex items-center gap-1 text-[10px] font-bold text-[#a78bfa] bg-[#6B46FF]/10 border border-[#6B46FF]/30 px-2 py-0.5 rounded-full">
                    <ShieldCheck className="w-3 h-3" /> {S.incentivized}
                  </span>
                )}
              </div>
              <span className="text-[11px] text-zinc-500">{new Date(r.created_at).toLocaleDateString()}</span>
            </div>
            <Stars value={r.stars} size="w-4 h-4" />
            <p className="text-[13px] text-zinc-300 whitespace-pre-wrap break-words">{r.body}</p>
            {r.media.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {r.media.map((m) =>
                  m.kind === 'video' ? (
                    <video
                      key={m.url}
                      src={m.url}
                      controls
                      preload="none"
                      className="h-24 rounded-lg border border-zinc-700 shrink-0"
                    />
                  ) : (
                    <a key={m.url} href={m.url} target="_blank" rel="noreferrer" className="shrink-0">
                      <img src={m.url} alt="" loading="lazy" className="h-24 w-24 object-cover rounded-lg border border-zinc-700" />
                    </a>
                  )
                )}
              </div>
            )}
          </article>
        ))}
      </div>

      {listLoading && <div className="text-center text-zinc-500 text-[13px] py-4">{S.loading}</div>}
      {!listLoading && reviews.length < total && (
        <button
          onClick={() => loadPage(page + 1, false)}
          className="w-full bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 text-sm font-bold py-2.5 rounded-full transition-colors"
        >
          {S.loadMore}
        </button>
      )}
    </section>
  );
}
