/**
 * «تقييم المنتجات المستلمة» — THE ONLY REVIEW FORM (docs/REVIEWS_GIFTS.md §8 C1).
 *
 * Opened from an order (Orders, OrderDetail) and from a product page
 * (ReviewSection, with `initialProductId`); it is the same form everywhere, so
 * there is one set of rules for writing a review and one for editing it.
 *
 * Built around the order, because the owner asked for the products, plural:
 *
 *  - ONE request on open, `GET /api/reviews/order/:orderId`, answers for every
 *    line: what is reviewable, what this customer already reviewed (with its
 *    media and whether it may still be edited), the printer-gift facts, and
 *    whether the order is delivered at all.
 *  - Submitting does NOT end the sheet. The rated product becomes a read-only
 *    row (its stars and gallery) and the next unrated one opens.
 *  - Each product keeps its own draft while the customer moves between them,
 *    and an upload keeps running while another product is being rated.
 *
 * THE SERVER DECIDES, THIS ONLY REFLECTS IT. `items` / `reviewedProductIds`
 * are the caller's hints for the first paint only. The text rule is the
 * server's own module (packages/catalog/src/reviewRules.ts), so the live
 * «x/30» counter can never promise a review the server refuses; the media
 * limits are the server's numbers; the gift hint is the server's `gift` block,
 * never a guess. Every refusal arrives as a code and is said in the customer's
 * language through src/lib/refusalStrings.ts.
 *
 * Body sent: `{productId, orderId, stars, body, media:[{key}]}` — POST for a
 * new review, PUT /api/reviews/:id with the FULL media list for an edit.
 *
 * Sheet v2 (`ui/Sheet`): dragged by its header only, a scrolling body, the
 * actions in a footer that stays above the keyboard and the home indicator,
 * and `dirty` so a swipe never throws away a half-written review.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Gift, PackageOpen, Pencil, RotateCw, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import type { ApiOrderItem } from '../../lib/api';
import { apiRefusal, refusalText } from '../../lib/refusalStrings';
import { useLanguage } from '../../LanguageContext';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import Spinner from '../ui/Spinner';
import SafeImage from '../ui/SafeImage';
import { formatDate } from './format';
import { checkReviewText, REVIEW_LIMITS, type ReviewTextVerdict } from '../../../packages/catalog/src/reviewRules';
import { StarRatingDisplay, StarRatingInput } from '../reviews/StarRating';
import ReviewMediaGallery from '../reviews/ReviewMediaGallery';
import ReviewMediaPicker, { useReviewMediaUploads } from '../reviews/ReviewMediaPicker';
import { mediaPayload, slotsFromStored, storedKeysComplete, submitBlock, textCode, type MediaSlot, type SubmitBlock } from '../reviews/reviewUpload';
import { asReviewLang, reviewStrings, type ReviewStrings } from '../reviews/reviewStrings';

/** One stored media item of the customer's own review (`key` is the owner's, §6.1). */
interface StoredMedia {
  url: string;
  kind: 'image' | 'video';
  key?: string;
}

/** `existing_review` — the same MyReviewView the product endpoint returns. */
interface ExistingReview {
  id: string;
  stars: number;
  status: string;
  created_at: string;
  body?: string;
  media?: StoredMedia[];
  source?: string;
  system_generated?: boolean;
  reward?: { kind?: string; state?: string } | null;
}

/** The printer-gift facts of one line (§6.1) — read, never inferred here. */
interface LineGift {
  program?: boolean;
  linked?: boolean;
  linked_elsewhere?: boolean;
  unit_rewarded?: boolean;
}

/** One product of the order, as GET /api/reviews/order/:orderId returns it. */
interface OrderReviewLine {
  order_item_id: string;
  product_id: string;
  name: string;
  image: string;
  variant: string;
  is_printer: boolean;
  existing_review: ExistingReview | null;
  can_replace_system_review: boolean;
  state: 'reviewable' | 'reviewed' | 'not_delivered';
  can_edit?: boolean;
  gift?: LineGift | null;
}

interface OrderReview {
  delivered: boolean;
  review_points: number | null;
  remaining: number;
  lines: OrderReviewLine[];
}

/** POST / PUT /api/reviews answer: the stored review and the gift verdict. */
interface SubmitAnswer {
  review?: ExistingReview | null;
  gift?: { program?: boolean; queued?: boolean; missing?: string[] } | null;
}

interface Draft {
  mode: 'create' | 'edit';
  reviewId: string | null;
  stars: number;
  body: string;
  /** What the edited review held, to know whether anything changed. */
  base: { stars: number; body: string; keys: string } | null;
}

interface Done {
  name: string;
  mode: 'create' | 'edit';
  gift: string;
}

/** A line the customer may still rate — the ONLY thing that opens a new review. */
function isOpen(l: OrderReviewLine): boolean {
  return l.state === 'reviewable';
}

function isSystem(r: ExistingReview | null | undefined): boolean {
  return !!r && (r.source === 'system' || r.system_generated === true);
}

/**
 * May this rated line be edited? The server's `can_edit` when it says; an
 * older answer without it falls back to the server's own rule (a review the
 * customer wrote, not rejected, whose reward — if any — is undecided).
 */
export function canEditLine(l: Pick<OrderReviewLine, 'state' | 'can_edit' | 'existing_review'>): boolean {
  if (l.state !== 'reviewed' || !l.existing_review || isSystem(l.existing_review)) return false;
  if (typeof l.can_edit === 'boolean') return l.can_edit;
  const r = l.existing_review;
  return r.status !== 'rejected' && (!r.reward || r.reward.state === 'submitted' || r.reward.state === 'revision_needed');
}

const keysOf = (slots: readonly MediaSlot[]) =>
  slots
    .map((x) => x.key ?? `~${x.id}`)
    .join('|');

/** The gift sentence after a submit — the server's verdict, in words. */
function giftVerdict(gift: SubmitAnswer['gift'], s: ReviewStrings): string {
  if (!gift || !gift.program) return '';
  if (gift.queued) return s.giftQueued;
  const missing = Array.isArray(gift.missing) ? gift.missing : [];
  if (missing.includes('five_stars')) return s.giftFiveStarsOnly;
  if (missing.includes('registered_to_reviewer')) return s.giftNeedsLink;
  if (missing.includes('unit_not_rewarded')) return s.giftUnitRewarded;
  return s.giftNotQueued;
}

function blockText(block: SubmitBlock, s: ReviewStrings, lang: string, verdict: ReviewTextVerdict): string {
  switch (block.reason) {
    case 'stars':
      return s.needStars;
    case 'text':
      return refusalText(block.code, asReviewLang(lang), s.needMore(Math.max(1, REVIEW_LIMITS.minChars - verdict.length)));
    case 'limit':
      return s.overLimit;
    case 'failed':
      return s.fixFailed(block.count);
    case 'uploading':
      return s.waitUploads(block.count);
  }
}

export default function ReviewSheet({
  open,
  onClose,
  orderId,
  items = [],
  initialItemId = null,
  initialProductId = null,
  reviewedProductIds,
  onSubmitted,
}: {
  open: boolean;
  onClose: () => void;
  orderId: string;
  /** The caller's copy of the order lines — first paint only; the server's
   *  answer replaces it the moment it lands. */
  items?: ApiOrderItem[];
  initialItemId?: string | null;
  /** Open on this product (the product page): its form, or its edit form. */
  initialProductId?: string | null;
  /** Optimistic hint for the first paint; never the authority. */
  reviewedProductIds?: ReadonlySet<string>;
  onSubmitted: (productId: string) => void;
}) {
  const { lang } = useLanguage();
  const s = reviewStrings(lang);
  const media = useReviewMediaUploads();

  const [data, setData] = useState<OrderReview | null>(null);
  const [load, setLoad] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [productId, setProductId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** The product just published (or saved), kept visible while the next one is rated. */
  const [justDone, setJustDone] = useState<Done | null>(null);
  const closeRef = useRef<() => void>(() => {});
  const bodyId = `review-body-${orderId}`;

  const emptyDraft = (): Draft => ({ mode: 'create', reviewId: null, stars: 0, body: '', base: null });

  /** Open a rated line for editing: its stars, words and media, as stored. */
  const startEdit = useCallback(
    (l: OrderReviewLine) => {
      const r = l.existing_review;
      if (!r) return;
      const stored = slotsFromStored(Array.isArray(r.media) ? r.media : []);
      media.seed(l.product_id, stored);
      setDrafts((d) => ({
        ...d,
        [l.product_id]: {
          mode: 'edit',
          reviewId: r.id,
          stars: Number(r.stars) || 0,
          body: String(r.body ?? ''),
          base: { stars: Number(r.stars) || 0, body: String(r.body ?? ''), keys: keysOf(stored) },
        },
      }));
      setProductId(l.product_id);
      setError('');
    },
    [media]
  );

  /** Which line to open: the caller's product or line, else the first unrated. */
  const settle = useCallback(
    (lines: OrderReviewLine[], preferItem: string | null, preferProduct: string | null) => {
      const wanted =
        (preferProduct ? lines.find((l) => l.product_id === preferProduct) : undefined) ??
        (preferItem ? lines.find((l) => l.order_item_id === preferItem) : undefined);
      if (wanted && !isOpen(wanted) && canEditLine(wanted) && preferProduct) {
        startEdit(wanted);
        return;
      }
      setProductId(wanted && isOpen(wanted) ? wanted.product_id : lines.find(isOpen)?.product_id ?? null);
    },
    [startEdit]
  );

  const fetchOrder = useCallback(
    async (preferItem: string | null, preferProduct: string | null) => {
      setLoad('loading');
      setError('');
      try {
        const d = await api.get<OrderReview>(`/api/reviews/order/${encodeURIComponent(orderId)}`);
        const lines = Array.isArray(d.lines) ? d.lines : [];
        setData({ ...d, lines });
        settle(lines, preferItem, preferProduct);
        setLoad('ready');
      } catch {
        setData(null);
        setLoad('failed');
      }
    },
    [orderId, settle]
  );

  /** The server's truth again after a submit, without disturbing the form. */
  const refresh = useCallback(async () => {
    try {
      const d = await api.get<OrderReview>(`/api/reviews/order/${encodeURIComponent(orderId)}`);
      const lines = Array.isArray(d.lines) ? d.lines : [];
      setData({ ...d, lines });
      setProductId((cur) => {
        const line = cur ? lines.find((l) => l.product_id === cur) : undefined;
        if (line && (isOpen(line) || canEditLine(line))) return cur;
        return lines.find(isOpen)?.product_id ?? null;
      });
    } catch {
      /* the optimistic row stays; the next opening asks again */
    }
  }, [orderId]);

  // A fresh sheet every time it opens, and never a stale order behind it.
  useEffect(() => {
    if (!open || !orderId) return;
    setDrafts({});
    media.clearAll();
    setBusy(false);
    setJustDone(null);
    setProductId(null);
    void fetchOrder(initialItemId, initialProductId);
    // The caller's opening choices are read once per open: adding them here
    // would restart the sheet (and drop a half-written review) whenever the
    // caller re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orderId, fetchOrder]);

  /**
   * What to draw before the server has answered: the caller's own lines,
   * marked from `reviewedProductIds`. A PLACEHOLDER LIST ONLY — nothing here is
   * selectable and no form hangs off it.
   */
  const placeholder = useMemo(
    () =>
      items
        .filter((it) => !!it.product_id)
        .map((it) => ({ id: it.id, name: it.name, image: it.image, reviewed: !!reviewedProductIds?.has(it.product_id!) })),
    [items, reviewedProductIds]
  );

  const lines = useMemo(() => data?.lines ?? [], [data]);
  const active = lines.find((l) => l.product_id === productId) ?? null;
  const draft: Draft | null = active ? drafts[active.product_id] ?? (isOpen(active) ? emptyDraft() : null) : null;
  const editing = !!active && !!draft && draft.mode === 'edit' && canEditLine(active);
  const formOpen = !!active && !!draft && (isOpen(active) || editing);
  const slots = active ? media.slotsOf(active.product_id) : [];
  const keysKnown = storedKeysComplete(slots);
  const verdict = checkReviewText(draft?.body ?? '');
  const verdictCode = textCode(verdict);
  const block = formOpen && draft ? submitBlock({ stars: draft.stars, text: verdict, slots }) : null;
  const ratedCount = lines.filter((l) => l.state === 'reviewed').length;
  const openCount = lines.filter(isOpen).length;

  /** Unsaved work anywhere in the sheet: a swipe or Escape asks first. */
  const dirty = Object.entries(drafts).some(([pid, d]) => {
    const sl = media.slotsOf(pid);
    if (d.mode === 'edit' && d.base) {
      return d.stars !== d.base.stars || d.body !== d.base.body || keysOf(sl) !== d.base.keys;
    }
    return d.stars > 0 || d.body.trim().length > 0 || sl.length > 0;
  }) || lines.some((l) => !drafts[l.product_id] && media.slotsOf(l.product_id).length > 0);

  const setDraft = (patch: Partial<Draft>) => {
    if (!active) return;
    setDrafts((d) => ({ ...d, [active.product_id]: { ...(d[active.product_id] ?? emptyDraft()), ...patch } }));
  };

  const pick = (l: OrderReviewLine) => {
    if (busy || l.product_id === productId) return;
    setProductId(l.product_id);
    setError('');
  };

  const cancelEdit = () => {
    if (!active) return;
    const pid = active.product_id;
    media.clear(pid);
    setDrafts((d) => {
      const next = { ...d };
      delete next[pid];
      return next;
    });
    setProductId(lines.find(isOpen)?.product_id ?? null);
    setError('');
  };

  const submit = async () => {
    if (!active || !draft || !formOpen || block || busy) return;
    const pid = active.product_id;
    const name = active.name;
    const mode = editing ? 'edit' : 'create';
    setBusy(true);
    setError('');
    const payload: Record<string, unknown> = { productId: pid, orderId, stars: draft.stars, body: draft.body.trim() };
    // An edit sends the FULL list (an empty list clears it); a list whose
    // stored keys are unknown is left out, which keeps what the review has.
    if (mode === 'create' || keysKnown) payload.media = mediaPayload(slots);
    try {
      const res =
        mode === 'edit' && draft.reviewId
          ? await api.put<SubmitAnswer>(`/api/reviews/${encodeURIComponent(draft.reviewId)}`, payload)
          : await api.post<SubmitAnswer>('/api/reviews', payload);
      const stored = res?.review ?? null;
      const now = new Date().toISOString();
      const next: OrderReviewLine[] = lines.map((l) =>
        l.product_id === pid
          ? {
              ...l,
              state: 'reviewed' as const,
              can_replace_system_review: false,
              existing_review: stored
                ? { ...stored, media: Array.isArray(stored.media) ? stored.media : [] }
                : {
                    id: l.existing_review?.id ?? draft.reviewId ?? '',
                    stars: draft.stars,
                    status: 'published',
                    created_at: l.existing_review?.created_at ?? now,
                    body: draft.body.trim(),
                    media: [],
                  },
            }
          : l
      );
      setData((d) => (d ? { ...d, lines: next, remaining: next.filter(isOpen).length } : d));
      setJustDone({ name, mode, gift: giftVerdict(res?.gift, s) });
      media.clear(pid);
      setDrafts((d) => {
        const copy = { ...d };
        delete copy[pid];
        return copy;
      });
      setProductId(next.find(isOpen)?.product_id ?? null);
      onSubmitted(pid);
      void refresh();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      const at = e instanceof ApiError ? Number(e.details?.index) : NaN;
      // A refusal that names one file marks THAT tile, so the customer sees which.
      if (code && code.startsWith('REVIEW_MEDIA_') && Number.isInteger(at)) media.markFailed(pid, at, code);
      setError(apiRefusal(e, asReviewLang(lang), s.failed));
      if (code === 'REVIEW_ALREADY_EXISTS' || code === 'REVIEW_NOT_EDITABLE') void refresh();
    } finally {
      setBusy(false);
    }
  };

  /** Closing for real: every upload stops and every preview is freed. */
  const finish = () => {
    media.clearAll();
    setDrafts({});
    onClose();
  };

  const rowBase =
    'flex items-center gap-3 rounded-xl border px-3 py-2.5 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

  const giftHint = (l: OrderReviewLine): React.ReactNode => {
    const g = l.gift;
    if (g && g.program) {
      if (g.unit_rewarded) return <span>{s.giftUnitRewarded}</span>;
      if (g.linked_elsewhere) return <span>{s.giftLinkedElsewhere}</span>;
      if (g.linked === false) {
        return (
          <span>
            {s.giftNeedsLink}{' '}
            <Link to="/warranty" className="font-bold text-gold underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded">
              {s.giftLinkCta}
            </Link>
          </span>
        );
      }
      return <span>{s.giftProgram}</span>;
    }
    if (typeof data?.review_points === 'number' && data.review_points > 0) return <span>{s.pointsHint(data.review_points)}</span>;
    return null;
  };

  const header = (
    <div className="flex items-center gap-2 px-4 pb-2 pt-2 sm:px-5 sm:pt-5">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[16px] font-bold text-text-primary">{editing && active ? s.editing(active.name) : s.sheetTitle}</h2>
        {load === 'ready' && lines.length > 0 && (
          <p data-review-progress className="text-[11.5px] text-text-muted tabular-nums">
            {s.progress(ratedCount, lines.length)}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => closeRef.current()}
        disabled={busy}
        aria-label={s.close}
        data-review-close
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-secondary hover:text-text-primary hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40"
      >
        <X className="h-5 w-5" aria-hidden />
      </button>
    </div>
  );

  const footer = formOpen ? (
    <div className="flex flex-col gap-2">
      <p aria-live="polite" data-review-block={block ? block.reason : ''} className="min-h-[1.25em] text-[12px] text-text-muted">
        {block && draft ? blockText(block, s, lang, verdict) : ''}
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={editing ? cancelEdit : () => closeRef.current()} disabled={busy}>
          {editing ? s.cancelEdit : s.close}
        </Button>
        <Button
          variant="primary"
          block
          onClick={submit}
          disabled={!!block}
          loading={busy}
          loadingLabel={editing ? s.saving : s.submitting}
          title={block && draft ? blockText(block, s, lang, verdict) : undefined}
          data-submit-review
          data-mascot="review"
        >
          {editing ? s.save : s.submit}
        </Button>
      </div>
    </div>
  ) : (
    <Button variant="secondary" block onClick={() => closeRef.current()} data-review-dismiss>
      {s.close}
    </Button>
  );

  return (
    <Sheet
      open={open}
      onClose={finish}
      label={s.sheetTitle}
      detents={['large']}
      header={header}
      footer={footer}
      dirty={dirty && !busy}
      dismissOnEscape={!busy}
      dismissOnScrim={!busy}
      panelClassName="sm:max-w-lg"
      testId="review-sheet"
    >
      {(overlay) => {
        closeRef.current = overlay.close;
        return (
          <div className="px-4 pb-5 pt-1 sm:px-5">
            {/* Loading: the caller's own lines, inert, so the sheet has shape
                without pretending to know what may be rated. */}
            {load === 'loading' && (
              <>
                <p role="status" aria-live="polite" className="mt-2 inline-flex items-center gap-2 text-[12.5px] text-text-secondary">
                  <Spinner size="xs" delayMs={0} decorative /> {s.loading}
                </p>
                <ul className="mt-3 flex flex-col gap-1.5" aria-hidden="true">
                  {placeholder.map((p) => (
                    <li key={p.id} className={`${rowBase} border-border-subtle opacity-50`}>
                      <SafeImage src={p.image} alt="" aspect="square" className="h-10 w-10 shrink-0 rounded-lg" bgClassName="bg-surface-raised" fallbackIconClassName="w-4 h-4" />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-text-secondary">{p.name}</span>
                      {p.reviewed && <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {/* Failure is said out loud, with the way back. */}
            {load === 'failed' && (
              <div className="mt-3">
                <p role="alert" className="text-[13px] text-warning">
                  {s.loadFailed}
                </p>
                <Button variant="secondary" className="mt-3" onClick={() => void fetchOrder(initialItemId, initialProductId)} icon={<RotateCw className="h-4 w-4" aria-hidden />} data-review-retry>
                  {s.retry}
                </Button>
              </div>
            )}

            {load === 'ready' && (
              <>
                {/* The banner for the product just published stays while the
                    next one is rated — the thanks is not a dead end. */}
                {justDone && (
                  <div role="status" aria-live="polite" data-review-done className="mt-2 flex items-start gap-2 rounded-xl border border-success/30 bg-success/10 p-3">
                    <CheckCircle2 className="mt-px h-4.5 w-4.5 shrink-0 text-success" aria-hidden />
                    <div className="min-w-0 text-[12.5px] text-text-primary">
                      <p>
                        {justDone.mode === 'edit' ? s.saved(justDone.name) : s.published(justDone.name)}
                        {openCount > 0 && <span className="text-text-secondary"> {s.nextUp}</span>}
                      </p>
                      {justDone.gift && (
                        <p className="mt-1 inline-flex items-start gap-1.5 text-text-secondary" data-review-gift-verdict>
                          <Gift className="mt-px h-4 w-4 shrink-0 text-gold" aria-hidden />
                          <span>{justDone.gift}</span>
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Nothing to offer — and it says which kind of nothing. */}
                {lines.length === 0 ? (
                  <p className="mt-3 text-[13px] text-text-secondary">{s.noItems}</p>
                ) : !data?.delivered ? (
                  <p data-review-empty className="mt-3 rounded-xl border border-border-subtle bg-surface p-3 text-[13px] text-text-secondary">
                    {s.notDelivered}
                  </p>
                ) : openCount === 0 && !justDone && !editing ? (
                  <div data-review-empty className="mt-3 flex items-start gap-2.5 rounded-xl border border-border-subtle bg-surface p-4">
                    <PackageOpen className="h-5 w-5 shrink-0 text-gold" aria-hidden />
                    <p className="text-[13px] text-text-primary">{s.allReviewed}</p>
                  </div>
                ) : null}

                {lines.length > 0 && (
                  <div role="radiogroup" aria-label={s.pickItem} className="mt-3 flex flex-col gap-1.5">
                    {lines.map((l) => {
                      const selected = l.product_id === productId;
                      const rated = l.state === 'reviewed';
                      const editable = canEditLine(l);
                      const existing = l.existing_review;
                      const ownMedia = rated && existing && Array.isArray(existing.media) ? existing.media : [];
                      /*
                       * Only a line that can still be rated is a CHOICE. A
                       * rated or undelivered line is a status row, rendered as
                       * plain content, never a disabled radio the group would
                       * still announce as selectable.
                       */
                      if (isOpen(l)) {
                        return (
                          <button
                            key={l.order_item_id}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            disabled={busy}
                            onClick={() => pick(l)}
                            data-review-line={l.product_id}
                            data-review-state={l.state}
                            className={`${rowBase} ${selected ? 'border-gold/60 bg-gold/10' : 'border-border-subtle hover:bg-surface-raised'}`}
                          >
                            <SafeImage src={l.image} alt="" aspect="square" className="h-10 w-10 shrink-0 rounded-lg" bgClassName="bg-surface-raised" fallbackIconClassName="w-4 h-4" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] text-text-primary">{l.name}</span>
                              {l.variant && <span className="block truncate text-[11.5px] text-text-muted">{l.variant}</span>}
                            </span>
                            <span className="shrink-0 rounded-full border border-gold/35 px-2 py-0.5 text-[10px] font-bold text-gold">{s.chipTodo}</span>
                          </button>
                        );
                      }
                      return (
                        <div
                          key={l.order_item_id}
                          data-review-line={l.product_id}
                          data-review-state={l.state}
                          data-selected={selected && editing ? 'true' : undefined}
                          className={`rounded-xl border px-3 py-2.5 ${selected && editing ? 'border-gold/60 bg-gold/10' : 'border-border-subtle'}`}
                        >
                          <div className="flex items-center gap-3">
                            <SafeImage src={l.image} alt="" aspect="square" className={`h-10 w-10 shrink-0 rounded-lg ${rated ? '' : 'opacity-70'}`} bgClassName="bg-surface-raised" fallbackIconClassName="w-4 h-4" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] text-text-primary">{l.name}</span>
                              {l.variant && <span className="block truncate text-[11.5px] text-text-muted">{l.variant}</span>}
                              {rated && existing && (
                                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-secondary">
                                  <StarRatingDisplay value={existing.stars} size="xs" />
                                  <span className="truncate">
                                    {s.reviewedOn(formatDate(existing.created_at, lang))} {s.reviewStatus[existing.status] ?? existing.status}
                                  </span>
                                </span>
                              )}
                            </span>
                            {rated &&
                              (editable && !(selected && editing) ? (
                                <Button variant="ghost" size="sm" onClick={() => startEdit(l)} disabled={busy} icon={<Pencil className="h-3.5 w-3.5" aria-hidden />} data-review-edit={l.product_id}>
                                  {s.edit}
                                </Button>
                              ) : (
                                <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-label={s.chipReviewed} />
                              ))}
                          </div>
                          {ownMedia.length > 0 && !(selected && editing) && (
                            <div className="mt-2.5">
                              <ReviewMediaGallery media={ownMedia} label={s.galleryLabel} max={4} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* The form for the product now selected (new, or an edit). */}
                {formOpen && active && draft && (
                  <div data-review-form={editing ? 'edit' : 'create'}>
                    <div className="mt-4 h-px bg-border-subtle" />

                    {/* What this rating may earn — the server's answer, never a guess. */}
                    {(() => {
                      const hint = giftHint(active);
                      return hint ? (
                        <p className="mt-3 flex items-start gap-1.5 text-[12.5px] text-text-secondary" data-review-gift-hint>
                          <Gift className="mt-px h-4 w-4 shrink-0 text-gold" aria-hidden />
                          {hint}
                        </p>
                      ) : null;
                    })()}

                    <fieldset className="mt-3">
                      <legend className="mb-1 text-[12px] text-text-secondary">
                        {s.starsLabel} — <span className="text-text-primary">{active.name}</span>
                      </legend>
                      <StarRatingInput value={draft.stars} onChange={(n) => setDraft({ stars: n })} label={`${s.starsLabel} — ${active.name}`} disabled={busy} />
                    </fieldset>

                    <label className="mt-3 block" htmlFor={bodyId}>
                      <span className="mb-1 block text-[12px] text-text-secondary">{s.bodyLabel}</span>
                    </label>
                    <textarea
                      id={bodyId}
                      value={draft.body}
                      // Bounded here as well as on the server, so the counter
                      // can never promise room the server would refuse.
                      onChange={(e) => setDraft({ body: e.target.value.slice(0, REVIEW_LIMITS.maxChars) })}
                      placeholder={s.bodyPlaceholder}
                      rows={5}
                      maxLength={REVIEW_LIMITS.maxChars}
                      disabled={busy}
                      dir="auto"
                      aria-describedby={`${bodyId}-count`}
                      // Too short is a counter, not an error: it turns red only
                      // for words the rule refuses outright.
                      aria-invalid={!!verdictCode && verdictCode !== 'REVIEW_TEXT_TOO_SHORT' && draft.body.trim().length > 0 ? true : undefined}
                      data-review-body
                      className="lv-input w-full resize-y py-2.5 text-[13.5px]"
                    />
                    <div id={`${bodyId}-count`} className="mt-1 flex flex-wrap items-start justify-between gap-x-3 gap-y-0.5 text-[11.5px]">
                      <span data-review-text-state={verdictCode ?? 'ok'} className="min-w-0">
                        {!verdictCode ? (
                          <span className="inline-flex items-center gap-1 text-success">
                            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {s.textReady}
                          </span>
                        ) : draft.body.trim().length === 0 ? null : verdictCode === 'REVIEW_TEXT_TOO_SHORT' ? (
                          <span className="text-text-muted">{s.needMore(REVIEW_LIMITS.minChars - verdict.length)}</span>
                        ) : (
                          <span className="text-warning">{refusalText(verdictCode, asReviewLang(lang), s.needMore(1))}</span>
                        )}
                      </span>
                      <span
                        dir="ltr"
                        aria-label={`${s.realChars(Math.min(REVIEW_LIMITS.minChars, verdict.length))} · ${draft.body.length}/${REVIEW_LIMITS.maxChars}`}
                        className="shrink-0 tabular-nums text-text-muted"
                        data-review-count
                      >
                        {Math.min(REVIEW_LIMITS.minChars, verdict.length)}/{REVIEW_LIMITS.minChars} · {draft.body.length}/{REVIEW_LIMITS.maxChars}
                      </span>
                    </div>

                    {keysKnown ? (
                      <ReviewMediaPicker
                        slots={slots}
                        onAdd={(files) => media.add(active.product_id, files)}
                        onReplace={(id, file) => media.replace(active.product_id, id, file)}
                        onRemove={(id) => media.remove(active.product_id, id)}
                        onRetry={(id) => media.retry(active.product_id, id)}
                        disabled={busy}
                        idBase={`review-media-${active.product_id}`}
                      />
                    ) : (
                      <div className="mt-4">
                        <ReviewMediaGallery media={slots.map((x) => ({ url: x.previewUrl, kind: x.kind }))} label={s.galleryLabel} />
                      </div>
                    )}

                    <p className="mt-3 text-[11px] text-text-muted">{s.moderation}</p>

                    <p role="alert" aria-live="assertive" data-review-error className="mt-2 min-h-[1.25em] text-[12.5px] text-danger">
                      {error}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        );
      }}
    </Sheet>
  );
}
