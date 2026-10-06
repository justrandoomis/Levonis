import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, Gift, Pencil, ShieldCheck, Star } from 'lucide-react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import { useIsPhone } from '../../lib/useMediaQuery';
import { Button } from '../ui/Button';
import { formatDate } from '../orders/format';
import { StarRatingDisplay } from './StarRating';
import ReviewMediaGallery, { type ReviewMediaItem } from './ReviewMediaGallery';
import { reviewStrings } from './reviewStrings';

/**
 * THE PRODUCT PAGE'S REVIEWS — the list, the customer's own review, and the
 * door to the ONE review form (docs/REVIEWS_GIFTS.md §8 C1).
 *
 * This file used to carry a second, different review form (six photos, one
 * video, Instagram evidence). It no longer writes anything: «اكتب مراجعتك» and
 * «عدّل مراجعتك» open ReviewSheet on this product — lazily, so the form, the
 * picker and the uploader cost the product page nothing until someone taps.
 * The section itself is a lazy chunk of the product page (Product.tsx).
 *
 * - The public list shows PUBLISHED reviews only, masked reviewer names and the
 *   incentivized-review disclosure; Instagram evidence never appears here.
 * - Stars, words, and the review's photos and videos in the one gallery
 *   (full-size viewer, videos that never play by themselves).
 * - Who may write or edit is the server's answer (`/eligibility/:productId`):
 *   a delivered order with this product, and `can_edit`.
 */

interface MediaRef extends ReviewMediaItem {
  key?: string;
}
interface PublicReview {
  id: string;
  stars: number;
  body: string;
  media: MediaRef[];
  created_at: string;
  reviewer: string;
  incentivized: boolean;
  verified_purchase: boolean;
  source: 'user' | 'system';
  system_generated: boolean;
}
interface MyReview {
  id: string;
  order_id: string | null;
  stars: number;
  body: string;
  media: MediaRef[];
  status: 'pending' | 'published' | 'rejected';
  moderation_note: string;
  source: 'user' | 'system';
  system_generated: boolean;
  fallback_points_awarded: number;
  reward: {
    kind: 'printer_gift' | 'points';
    state: 'submitted' | 'revision_needed' | 'approved' | 'rejected';
    reason: string;
    points_awarded: number;
  } | null;
}
interface Eligibility {
  eligible_orders: Array<{ id: string; delivered_at: string | null }>;
  existing_review: MyReview | null;
  is_printer: boolean;
  review_points: number | null;
  can_replace_system_review: boolean;
  can_edit?: boolean;
  gift?: { program?: boolean; linked?: boolean; linked_elsewhere?: boolean; unit_rewarded?: boolean } | null;
}

const ReviewSheet = React.lazy(() => import('../orders/ReviewSheet'));

/** May the customer edit their review? The server's `can_edit`, else its own rule. */
function editable(e: Eligibility | null): boolean {
  const r = e?.existing_review;
  if (!r || r.system_generated || r.source === 'system') return false;
  if (typeof e?.can_edit === 'boolean') return e.can_edit;
  return r.status !== 'rejected' && (!r.reward || r.reward.state === 'submitted' || r.reward.state === 'revision_needed');
}

export default function ReviewSection({ productId }: { productId: string }) {
  const { lang, dir } = useLanguage();
  const s = reviewStrings(lang);
  const { isAuthenticated } = useAuth();
  const phone = useIsPhone();

  const [reviews, setReviews] = useState<PublicReview[]>([]);
  const [total, setTotal] = useState(0);
  const [avg, setAvg] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetMounted, setSheetMounted] = useState(false);

  const loadPage = useCallback(
    async (p: number, replace: boolean) => {
      setListLoading(true);
      setListError('');
      try {
        const res = await api.get<{ total: number; avg_stars: number | null; reviews: PublicReview[] }>(
          `/api/reviews/product/${encodeURIComponent(productId)}?page=${p}`
        );
        setTotal(Number(res.total) || 0);
        setAvg(res.avg_stars);
        const list = Array.isArray(res.reviews) ? res.reviews : [];
        setReviews((prev) => (replace ? list : [...prev, ...list]));
        setPage(p);
      } catch {
        setListError(s.loadError);
      } finally {
        setListLoading(false);
      }
    },
    [productId, s.loadError]
  );

  const loadEligibility = useCallback(async () => {
    if (!isAuthenticated) {
      setEligibility(null);
      return;
    }
    try {
      setEligibility(await api.get<Eligibility & { success: boolean }>(`/api/reviews/eligibility/${encodeURIComponent(productId)}`));
    } catch {
      setEligibility(null);
    }
  }, [productId, isAuthenticated]);

  useEffect(() => {
    void loadPage(1, true);
  }, [loadPage]);
  useEffect(() => {
    void loadEligibility();
  }, [loadEligibility]);

  const existing = eligibility?.existing_review ?? null;
  const orders = eligibility?.eligible_orders ?? [];
  const isMarker = !!existing && (existing.system_generated || existing.source === 'system');
  const canEdit = editable(eligibility);
  const canCreate = (!existing || isMarker) && orders.length > 0;
  // The sheet is order-shaped: the review's own order for an edit, else the
  // latest delivered order holding this product.
  const sheetOrder = canEdit ? existing?.order_id ?? orders[0]?.id ?? '' : orders[0]?.id ?? '';

  const openSheet = () => {
    if (!sheetOrder) return;
    setSheetMounted(true);
    setSheetOpen(true);
  };

  const onSubmitted = () => {
    void loadEligibility();
    void loadPage(1, true);
  };

  const rewardLine = (r: NonNullable<MyReview['reward']>): React.ReactNode => {
    if (r.kind === 'points') {
      return r.state === 'approved' && r.points_awarded > 0 ? <span className="font-bold text-success">{s.pointsAwarded(r.points_awarded)}</span> : null;
    }
    if (r.state === 'approved') {
      return (
        <span className="inline-flex flex-wrap items-center gap-x-2">
          <span className="font-bold text-success">{s.giftApproved}</span>
          <Link to="/gifts" className="font-bold text-gold underline underline-offset-4 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            {s.giftsCta}
          </Link>
        </span>
      );
    }
    if (r.state === 'rejected') return <span>{s.giftRejected}</span>;
    if (r.state === 'revision_needed') return <span className="text-warning">{s.giftRevision}</span>;
    return <span>{s.giftQueued}</span>;
  };

  const statusTone = (st: MyReview['status']) =>
    st === 'published' ? 'border-success/30 bg-success/10 text-success' : st === 'rejected' ? 'border-danger/30 bg-danger/10 text-danger' : 'border-warning/30 bg-warning/10 text-warning';

  const thumbs = phone ? 4 : 6;

  return (
    <section dir={dir} className="mt-8 space-y-4" data-review-section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-black text-text-primary">{s.sectionTitle}</h2>
          {avg !== null && (
            <span className="flex items-center gap-1.5 text-sm text-text-secondary">
              <Star className="h-4 w-4 text-gold" fill="currentColor" aria-hidden />
              <b className="text-text-primary tabular-nums">{avg}</b>
              <span className="text-xs text-text-muted">{s.reviewsCount(total)}</span>
            </span>
          )}
        </div>
        {isAuthenticated && (canCreate || canEdit) && !!sheetOrder && (
          <Button
            variant="primary"
            size="sm"
            onClick={openSheet}
            onPointerEnter={() => void import('../orders/ReviewSheet')}
            onFocus={() => void import('../orders/ReviewSheet')}
            icon={canEdit ? <Pencil className="h-4 w-4" aria-hidden /> : <Star className="h-4 w-4" aria-hidden />}
            data-review-cta={canEdit ? 'edit' : 'write'}
          >
            {canEdit ? s.editMine : s.write}
          </Button>
        )}
      </div>

      <p className="text-[11px] text-text-muted">{s.disclosure}</p>
      {isAuthenticated && (canCreate || canEdit) && <p className="text-[11px] text-text-secondary">{s.publishedImmediately}</p>}

      {/* The printer-gift facts, as the server states them for this customer. */}
      {eligibility?.gift?.program && (canCreate || canEdit) && (
        <p className="flex gap-2 rounded-2xl border border-border-subtle bg-surface p-3 text-[12px] text-text-secondary" data-review-gift-hint>
          <Gift className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden />
          <span>
            {eligibility.gift.unit_rewarded
              ? s.giftUnitRewarded
              : eligibility.gift.linked_elsewhere
                ? s.giftLinkedElsewhere
                : eligibility.gift.linked === false
                  ? s.giftNeedsLink
                  : s.giftProgram}
          </span>
        </p>
      )}
      {!eligibility?.gift?.program && eligibility && (canCreate || canEdit) && typeof eligibility.review_points === 'number' && eligibility.review_points > 0 && (
        <p className="flex gap-2 rounded-2xl border border-border-subtle bg-surface p-3 text-[12px] text-text-secondary">
          <Gift className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden />
          <span>{s.pointsHint(eligibility.review_points)}</span>
        </p>
      )}
      {isAuthenticated && eligibility && !existing && orders.length === 0 && <p className="text-[12px] text-text-muted">{s.notEligible}</p>}
      {!isAuthenticated && <p className="text-[12px] text-text-muted">{s.signInToReview}</p>}

      {/* «مراجعتك» — the customer's own review, with its media. */}
      {existing && (
        <div className="space-y-2 rounded-2xl border border-border-subtle bg-surface p-4" data-my-review>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-bold text-text-primary">{s.myReview}</span>
            <span className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${statusTone(existing.status)}`}>
              {s.reviewStatus[existing.status] ?? existing.status}
            </span>
          </div>
          <StarRatingDisplay value={existing.stars} />
          {isMarker ? (
            <p className="text-[12px] text-text-secondary">{s.systemGenerated}</p>
          ) : (
            <p className="whitespace-pre-wrap break-words text-[13px] text-text-primary" dir="auto">
              {existing.body}
            </p>
          )}
          {Array.isArray(existing.media) && existing.media.length > 0 && <ReviewMediaGallery media={existing.media} label={s.galleryLabel} max={thumbs} />}
          {existing.moderation_note && (
            <p className="text-[12px] text-warning">
              {s.moderationNote}: {existing.moderation_note}
            </p>
          )}
          {existing.reward && <p className="text-[12px] text-text-secondary">{rewardLine(existing.reward)}</p>}
          {existing.reward?.reason && (existing.reward.state === 'rejected' || existing.reward.state === 'revision_needed') && (
            <p className="text-[12px] text-text-muted">
              {s.rewardReason}: {existing.reward.reason}
            </p>
          )}
          {!existing.reward && !isMarker && Number(existing.fallback_points_awarded) > 0 && (
            <p className="text-[12px] font-bold text-success">{s.pointsAwarded(Number(existing.fallback_points_awarded))}</p>
          )}
        </div>
      )}

      {/* The public list. */}
      {listError && (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-[12px] font-medium text-danger">
          {listError}
        </p>
      )}
      {!listError && reviews.length === 0 && !listLoading && <p className="py-6 text-center text-[13px] text-text-muted">{s.empty}</p>}
      <div className="space-y-3">
        {reviews.map((r) => (
          <article key={r.id} className="space-y-2 rounded-2xl border border-border-subtle bg-surface p-4" data-review-id={r.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-text-primary">{r.reviewer}</span>
                {r.verified_purchase && (
                  <span className="flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-bold text-success">
                    <BadgeCheck className="h-3 w-3" aria-hidden /> {s.verified}
                  </span>
                )}
                {r.incentivized && (
                  <span className="flex items-center gap-1 rounded-full border border-gold/30 bg-gold/10 px-2 py-0.5 text-[10px] font-bold text-gold">
                    <ShieldCheck className="h-3 w-3" aria-hidden /> {s.incentivized}
                  </span>
                )}
              </div>
              <time dateTime={r.created_at} className="text-[11px] text-text-muted">
                {formatDate(r.created_at, lang)}
              </time>
            </div>
            <StarRatingDisplay value={r.stars} />
            <p className="whitespace-pre-wrap break-words text-[13px] text-text-primary" dir="auto">
              {r.system_generated ? s.systemGenerated : r.body}
            </p>
            {Array.isArray(r.media) && r.media.length > 0 && <ReviewMediaGallery media={r.media} label={s.galleryLabel} max={thumbs} />}
          </article>
        ))}
      </div>

      {listLoading && <p className="py-4 text-center text-[13px] text-text-muted">{s.listLoading}</p>}
      {!listLoading && reviews.length < total && (
        <Button variant="secondary" block onClick={() => void loadPage(page + 1, false)}>
          {s.loadMore}
        </Button>
      )}

      {sheetMounted && (
        <React.Suspense fallback={null}>
          <ReviewSheet
            open={sheetOpen}
            onClose={() => setSheetOpen(false)}
            orderId={sheetOrder}
            initialProductId={productId}
            onSubmitted={onSubmitted}
          />
        </React.Suspense>
      )}
    </section>
  );
}
