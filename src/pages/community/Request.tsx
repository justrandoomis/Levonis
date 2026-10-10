/**
 * A PRINT REQUEST — /requests/:id (docs/COMMUNITY_ECOSYSTEM.md §9.5
 * «Client», Client 5c). The request's own address: the old
 * `/requests?request=<id>` redirects here with its hash
 * (src/pages/Requests.tsx), so every notice, card and chat button that links
 * the old way lands on this page — `#discussion` and `#timeline` included.
 *
 * ONE PAGE, IN THE OWNER'S ORDER:
 *   header (title, state chip, customer / chosen merchant) → status strip →
 *   files (AttachmentList, 3D doors minted on demand) → details (the fields,
 *   the customer's notes, PrintSummary with the estimate) → DISCUSSION →
 *   OFFERS (the customer compares, the workshop composes) → comparison →
 *   chat door → accepted offer → timeline (a line and a door; the whole
 *   record is Client 5d's OrderTimeline) → the money (held / released, never
 *   a key) → delivery (the other party's contact, frozen at acceptance) →
 *   review (when the work is complete).
 *
 * WHO SEES WHAT is the server's: the request is `publicRequest()`'s
 * whitelist, a merchant reads only their own offers, a party gets the other
 * party's contact only after acceptance, and no file key reaches this page
 * for anybody but its uploader. The page draws what it is given and decides
 * nothing about money.
 *
 * `RequestDetail` is also mounted by src/pages/Requests.tsx under the
 * maintenance card (PendingOffersWhileClosed): with the community shut the
 * request's own read is refused, so the detail starts from the row it is
 * handed and keeps it when the re-read fails.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import * as Motion from 'motion/react-m';
import { ArrowLeft, ArrowRight, Box, FilePen, MapPin, MessageCircle, PencilLine, Phone, Plus, Store } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import { useSignInPrompt } from '../../lib/guest';
import { useGoBack } from '../../lib/useGoBack';
import { useMotion } from '../../lib/motion';
import { MotionFeatures } from '../../lib/motionFeatures';
import { api, ApiError } from '../../lib/api';
import { apiRefusal } from '../../lib/refusalStrings';
import { merchantApi, type MerchantMe } from '../../lib/merchant';
import { merchantHref } from '../../lib/merchantRoutes';
import { GOVERNORATE_LABELS } from '../../lib/governorates';
import { printApi } from '../../lib/printApi';
import { formatDate } from '../../components/orders/format';
import { AttachmentList, type RequestFile } from '../../components/media/RequestAttachments';
import PrintSummary from '../../components/print/PrintSummary';
import ConfirmSheet from '../../components/print/ConfirmSheet';
import ChannelNudge from '../../components/notify/ChannelNudge';
import WorkshopRequestCard from '../../components/merchant/workshop/WorkshopRequestCard';
import type { OfferPrefill } from '../../components/merchant/workshop/api';
import { StoreReviewCard, useEligibleReviews } from '../../components/community/reviews/StoreReviews';
import { viewerHref } from '../../components/community/files/api';
import { forgetCommunityFeed } from '../../components/community/hub/feedCache';
import { timeAgo } from '../../components/community/hub/copy';
import { offersApi, type OrderContact } from '../../components/community/offers/types';
import OfferCompare, { Breakdown, OfferFiles } from '../../components/community/requests/OfferCompare';
import { MerchantOfferSection } from '../../components/community/requests/OfferComposer';
import Discussion from '../../components/community/requests/Discussion';
import { discussionApi, offersV2Api, requestsApi, type CatalogMaterial, type OfferV2, type OrderTimeline as OrderTimelineData } from '../../components/community/requests/api';
import { latestEvent, REQUEST_STEPS, requestStateLabel, requestStateTone, requestStepIndex, requestTakesOffers } from '../../components/community/requests/requestStates';
import {
  daysLabel,
  escrowSentence,
  fill,
  fillNodes,
  handoverLabel,
  orderStateWord,
  requestLang,
  useRequestStrings,
  useTimelineStrings,
  type RequestLang,
  type RequestStrings,
} from '../../components/community/requests/strings';
import { Button, IconButton } from '../../components/ui/Button';
import { StatusChip } from '../../components/ui/Badge';
import { Money } from '../../components/ui/Money';
import { Sheet } from '../../components/ui/Sheet';
import { NotFoundState } from '../../components/ui/AsyncStates';
import { Skeleton, SkeletonGroup } from '../../components/ui/Skeleton';
import { useToast } from '../../components/ui/Toast';
import { CommunityLoadError } from './access';

/** The wizard finishes a draft or edits the request in place (a lazy chunk: most visitors never edit). */
const RequestWizard = lazy(() => import('../../components/community/requests/RequestWizard'));
/** THE ORDER'S TIMELINE is Client 5d's — mounted in a sheet behind the «آخر تحديث» line. */
const OrderTimeline = lazy(() => import('../../components/community/requests/OrderTimeline'));

export interface RequestRow {
  id: string;
  title: string;
  description: string;
  category?: string;
  quantity: number;
  material: string;
  color: string;
  dimensions: string;
  budget_iqd: number | null;
  deadline: string | null;
  governorate: string;
  delivery_pref?: string;
  state: string;
  offer_count: number;
  created_at: string;
  customer_name: string | null;
  expires_at?: string | null;
  /** Notes the customer wrote for the merchants (0130). */
  customer_notes?: string;
  revision?: number;
  file_count?: number;
}

/** What a caller hands the detail: at least the id; a list row when it has one. */
export type RequestSeed = Pick<RequestRow, 'id'> & Partial<RequestRow>;

/** A request file as GET /api/marketplace/requests/:id lists it — with what THIS caller may do with its bytes. */
export type PageFile = RequestFile & { access?: 'download' | 'view' | 'preview' | 'none' };

/** GET /api/marketplace/orders/:id — the order a party sees: the other side's contact and the money's state. */
export interface OrderView {
  role: 'customer' | 'merchant';
  order: { id: string; state: string; price_iqd: number; auto_complete_at?: string | null; delivery_method?: string };
  contact: OrderContact | null;
  thread: { request_id: string; merchant_id: string };
  escrow: {
    state: string;
    gross_iqd: number;
    platform_fee_iqd: number;
    merchant_receivable_iqd: number;
    released_at: string | null;
    refunded_at: string | null;
  } | null;
  can: Record<string, boolean>;
}

/** A full list row, or only an id to fetch. */
function isRow(r: RequestSeed): r is RequestRow {
  return typeof r.title === 'string' && typeof r.state === 'string';
}

/** The wizard left `{ published: true }` in the router state: this person just published the request. */
function justPublished(state: unknown): boolean {
  return !!state && typeof state === 'object' && (state as { published?: unknown }).published === true;
}

// ------------------------------------------------------------------- route

export default function RequestPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const goBack = useGoBack('/requests');
  const { user, isLoaded } = useAuth();
  const { signIn } = useSignInPrompt();
  const s = useRequestStrings();
  /** The account's merchant standing; `undefined` while it is being asked, so a workshop never flashes the onlooker's card. */
  const [me, setMe] = useState<MerchantMe | null | undefined>(undefined);
  useEffect(() => {
    if (!isLoaded) return;
    if (!user) {
      setMe(null);
      return;
    }
    let alive = true;
    setMe(undefined);
    merchantApi
      .me()
      .then((d) => alive && setMe(d))
      .catch(() => alive && setMe(null));
    return () => {
      alive = false;
    };
  }, [user, isLoaded]);

  /**
   * A REQUEST THIS PERSON JUST PUBLISHED. Latched from the router state the
   * wizard left (src/pages/Requests.tsx) or from the in-place wizard below,
   * never from a list: a merchant sent here by a match notice must not be
   * asked about the customer's notification channels. The state is dropped
   * from the history entry at once, so Back, Forward or a reload never pops
   * the window again.
   */
  const [requestJustCreated, setRequestJustCreated] = useState(() => justPublished(location.state));
  useEffect(() => {
    if (!justPublished(location.state)) return;
    navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true, state: null });
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The wizard, in place: a draft to finish or the published request to edit — for THIS request only. */
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [id]);
  /** Bumped after the wizard: the detail reads the request again. */
  const [version, setVersion] = useState(0);

  /**
   * THE WINDOW IS RENDERED ONCE, OUTSIDE THE BRANCH: the in-place wizard and
   * the detail are two arms of one conditional, and publishing a draft moves
   * from the first to the second in the same breath — one instance, one
   * reveal, and a dismissal that stays dismissed.
   */
  const nudge = <ChannelNudge context="request" active={requestJustCreated} />;

  return (
    <>
      {editing ? (
        <div className="min-h-screen pb-28 text-text-primary" data-request-editing={id}>
          <TopBar onBack={() => setEditing(false)} kicker={s.editRequest} />
          <div className="mx-auto max-w-2xl px-4 pt-4">
            <Suspense fallback={<PageSkeleton />}>
              <RequestWizard
                key={id}
                requestId={id}
                onDone={(_rid, how) => {
                  setEditing(false);
                  setVersion((v) => v + 1);
                  if (how === 'published') setRequestJustCreated(true);
                }}
                onCancel={() => setEditing(false)}
              />
            </Suspense>
          </div>
        </div>
      ) : (
        <RequestDetail
          // Keyed on the request: another request never inherits this one's offers, files or answers.
          key={id}
          request={{ id }}
          me={me ?? null}
          meReady={me !== undefined}
          version={version}
          onBack={goBack}
          onEdit={() => setEditing(true)}
          onNewRequest={() => (user ? navigate('/requests?view=new') : signIn())}
        />
      )}
      {nudge}
    </>
  );
}

function TopBar({ onBack, kicker }: { onBack: () => void; kicker: string }) {
  const s = useRequestStrings();
  const { dir } = useLanguage();
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  return (
    <div className="material scroll-edge sticky top-0 z-40 h-14 px-4">
      <div className="mx-auto flex h-full max-w-2xl items-center gap-2">
        <IconButton
          label={s.back}
          onClick={onBack}
          className="-ms-2"
          data-request-back
          icon={<Back aria-hidden="true" className="h-5 w-5" />}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] text-text-muted">{kicker}</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ detail

export function RequestDetail({
  request,
  me,
  onBack,
  onEdit,
  onNewRequest,
  version = 0,
  meReady = true,
}: {
  request: RequestSeed;
  me: MerchantMe | null;
  /** False while the account's merchant standing is still being asked: the offers wait for it. */
  meReady?: boolean;
  onBack: () => void;
  /** Open the wizard on this request (a draft to finish, or a published one to edit). */
  onEdit?: (id: string) => void;
  /** «اطلب مثله»: the wizard, for a visitor who wants something like this. */
  onNewRequest?: () => void;
  /** Bumped by the parent after an edit: everything is read again. */
  version?: number;
}) {
  const s = useRequestStrings();
  const { loc, lang } = useLanguage();
  const L = requestLang(lang);
  const m = useMotion();
  const location = useLocation();
  const { user, isLoaded } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const openCosting = searchParams.get('cost') === '1';

  /**
   * The request as the server has it NOW. The seed is whatever a list read;
   * publishing a draft or closing the request changes its state on this very
   * screen, so the page re-reads it rather than trusting a copy.
   */
  const [current, setCurrent] = useState<RequestRow | null>(isRow(request) ? request : null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [files, setFiles] = useState<PageFile[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const [offers, setOffers] = useState<OfferV2[] | null>(null);
  const [myDraft, setMyDraft] = useState<OfferV2 | null>(null);
  const [offersError, setOffersError] = useState<unknown>(null);
  const [isCustomer, setIsCustomer] = useState(false);
  const [materials, setMaterials] = useState<CatalogMaterial[]>([]);
  const [primaryFile, setPrimaryFile] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState('');
  /** Closing a PUBLISHED request (the server always allowed it; the page has the door). */
  const [closeOpen, setCloseOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState('');
  // «استخدم هذا كعرضي»: a private costing handed to the offer composer (W5-B).
  const [prefill, setPrefill] = useState<OfferPrefill | null>(null);
  const [orderVersion, setOrderVersion] = useState(0);
  const [timelineOpen, setTimelineOpen] = useState(false);
  /** The discussion's read was refused by the maintenance wall: its section folds away. */
  const [discussionShut, setDiscussionShut] = useState(false);
  const seed = useRef(request);

  const loadRequest = useCallback(() => {
    api
      .get<{ request: RequestRow; files: PageFile[]; is_owner: boolean }>(`/api/marketplace/requests/${encodeURIComponent(request.id)}`)
      .then((d) => {
        setLoadError(null);
        if (d.request) setCurrent(d.request);
        setFiles(d.files ?? []);
        setIsOwner(!!d.is_owner);
      })
      .catch((e: unknown) => {
        // Under the maintenance card the read is refused while the offers
        // are not (DECISIONS 110): keep the row we were handed.
        if (isRow(seed.current)) return;
        setLoadError(e);
      });
  }, [request.id]);

  const load = useCallback(() => {
    setOffersError(null);
    // Nobody is decided until the session is known: a signed-in customer must not flash the onlooker's card.
    if (!isLoaded) return;
    // The offers are a signed-in read: a guest is an onlooker, with nothing to load.
    if (!user) {
      setOffers([]);
      setMyDraft(null);
      setIsCustomer(false);
      return;
    }
    offersV2Api
      .list(request.id)
      .then((d) => {
        setOffers(d.offers ?? []);
        setMyDraft(d.draft ?? null);
        setIsCustomer(!!d.is_customer);
        setOrderVersion((v) => v + 1);
      })
      .catch((e: unknown) => setOffersError(e));
  }, [request.id, user, isLoaded]);

  useEffect(loadRequest, [loadRequest, version]);
  useEffect(load, [load, version]);
  // The catalogue names the materials an offer lists and the composer offers.
  useEffect(() => {
    let alive = true;
    requestsApi
      .catalog()
      .then((c) => alive && setMaterials(c.materials))
      .catch(() => alive && setMaterials([]));
    return () => {
      alive = false;
    };
  }, []);

  const refreshAll = useCallback(() => {
    loadRequest();
    load();
  }, [loadRequest, load]);

  const accepted = useMemo(() => offers?.find((o) => o.state === 'accepted') ?? null, [offers]);
  const orderId = accepted?.order_id ?? null;
  const { view: order, timeline, timelineFailed, retryTimeline } = useOrderView(orderId, orderVersion);

  // A notice's hash (`#discussion`, `#timeline`) lands on its section once the page is there.
  const scrolled = useRef(false);
  const unanchor = useRef<(() => void) | null>(null);
  useEffect(() => {
    const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (scrolled.current || !hash || !current || offers === null) return;
    const el = document.getElementById(hash);
    if (!el) return;
    scrolled.current = true;
    el.scrollIntoView({ block: 'start', behavior: m.reduced ? 'auto' : 'smooth' });
    /**
     * AND STAYS THERE WHILE THE PAGE ABOVE IT GROWS (review 2026-09-30): the
     * estimate card and the attachments arrive after the offers, and pushed the
     * «النقاش» heading ~370 px under the fold of a link that named it. Until
     * the reader scrolls, touches or types — or a few seconds pass — every
     * change in the page's size lands the section again.
     */
    const root = el.closest<HTMLElement>('[data-request-page]') ?? document.body;
    const stopOn = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    let observer: ResizeObserver | null = null;
    const stop = () => {
      observer?.disconnect();
      observer = null;
      for (const t of stopOn) window.removeEventListener(t, stop);
      window.clearTimeout(timer);
      unanchor.current = null;
    };
    const timer = window.setTimeout(stop, 4000);
    if (typeof ResizeObserver === 'function') {
      // The observer's first call is the observation starting, not a change: the smooth scroll keeps its way.
      let first = true;
      observer = new ResizeObserver(() => {
        if (first) {
          first = false;
          return;
        }
        if (el.isConnected) el.scrollIntoView({ block: 'start', behavior: 'auto' });
      });
      observer.observe(root);
    }
    for (const t of stopOn) window.addEventListener(t, stop, { passive: true });
    unanchor.current = stop;
  }, [location.hash, current, offers, orderId, m.reduced]);
  useEffect(() => () => unanchor.current?.(), []);

  const fallback = s.couldNot;

  /**
   * A DRAFT IS PUBLISHED FROM ITS OWN PAGE. The wizard's first step saves the
   * request as a draft (it is invisible until published), so a customer who
   * left the wizard needs a way to finish. An empty body publishes the spec
   * already stored.
   */
  async function publishDraft() {
    if (!current) return;
    setPublishing(true);
    setDraftError('');
    try {
      await api.post(`/api/marketplace/print/requests/${current.id}/publish`, {});
      forgetCommunityFeed('requests');
      refreshAll();
    } catch (e) {
      setDraftError(apiRefusal(e, L, fallback));
    } finally {
      setPublishing(false);
    }
  }

  async function closePublished() {
    if (!current) return;
    setClosing(true);
    setCloseError('');
    try {
      await api.post(`/api/marketplace/requests/${current.id}/cancel`);
      forgetCommunityFeed('requests');
      setCloseOpen(false);
      refreshAll();
    } catch (e) {
      setCloseError(apiRefusal(e, L, fallback));
    } finally {
      setClosing(false);
    }
  }

  async function discardDraft() {
    if (!current) return;
    setDiscarding(true);
    setDiscardError('');
    try {
      await api.post(`/api/marketplace/requests/${current.id}/cancel`);
      forgetCommunityFeed('requests');
      setDiscardOpen(false);
      loadRequest();
    } catch (e) {
      setDiscardError(apiRefusal(e, L, fallback));
    } finally {
      setDiscarding(false);
    }
  }

  async function openChat(merchantId?: string) {
    if (!current) return;
    try {
      const r = await offersApi.openThread(current.id, merchantId);
      navigate(`/chat/${encodeURIComponent(r.chatId)}`);
    } catch (e) {
      toast.error(apiRefusal(e, L, s.couldNotOpenChat));
    }
  }

  const frame = (body: ReactNode) => (
    <div className="min-h-screen pb-28 text-text-primary" data-request-page={request.id}>
      <TopBar onBack={onBack} kicker={s.kicker} />
      <div className="mx-auto max-w-2xl px-4">{body}</div>
    </div>
  );

  if (!current) {
    if (loadError instanceof ApiError && loadError.status === 404) {
      return frame(
        <div className="pt-8" data-request-missing>
          <NotFoundState title={s.notFoundTitle} description={s.notFoundBody} />
          <div className="mt-2 flex justify-center">
            <Link to="/requests" className="lv-button lv-button-secondary lv-button-sm">
              {s.toBoard}
            </Link>
          </div>
        </div>
      );
    }
    if (loadError) return frame(<div className="pt-8"><CommunityLoadError error={loadError} onRetry={loadRequest} /></div>);
    return frame(<PageSkeleton />);
  }

  const open = requestTakesOffers(current.state);
  const canOffer = !!me?.store && !!me?.can.offers && !isCustomer && open;
  /** Neither the customer nor a merchant who can answer: a visitor reading someone's request. */
  const onlookers = !isCustomer && !me?.store;
  const draft = current.state === 'draft';
  const step = requestStepIndex(current.state);
  const chosenName = accepted?.merchant?.name ?? null;
  const myLive = !isCustomer ? offers?.find((o) => o.state === 'pending' || o.state === 'superseded' || o.state === 'accepted') ?? null : null;
  /** THE CHAT DOOR has one counterpart: the chosen merchant for the customer, the customer for a merchant with an offer standing. */
  const chatWith: 'merchant' | 'customer' | null = isCustomer ? (accepted ? 'merchant' : null) : myLive ? 'customer' : null;
  const role: 'customer' | 'merchant' | null = order?.role ?? (isCustomer ? 'customer' : accepted ? 'merchant' : null);
  const gov = GOVERNORATE_LABELS[current.governorate];

  return frame(
    <MotionFeatures>
      <Motion.article initial={{ opacity: 0, y: m.travel(10) }} animate={{ opacity: 1, y: 0 }} transition={m.spring('ui')} className="flex flex-col" data-request={current.id} data-request-state={current.state}>
        {/* ---------------------------------------------------------- header */}
        <header data-request-section="header" className="pb-4 pt-3">
          <div className="flex items-start justify-between gap-3">
            {/* The customer's own words keep their own direction: an Arabic
                «80×60 ملم» read in the English interface must not come out as
                60×80. */}
            <h1 dir="auto" className="min-w-0 flex-1 break-words text-[19px] font-bold leading-snug text-text-primary">
              {current.title}
            </h1>
            <StatusChip tone={requestStateTone(current.state)} className="mt-0.5 shrink-0">
              {requestStateLabel(current.state, loc)}
            </StatusChip>
          </div>
          {(current.customer_name || chosenName) && (
            <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-text-muted">
              {current.customer_name && <span data-request-customer>{fillNodes(s.by, { name: <bdi>{current.customer_name}</bdi> })}</span>}
              {chosenName && (
                <span data-request-merchant>{fillNodes(s.chosenMerchant, { name: <bdi className="font-semibold text-text-secondary">{chosenName}</bdi> })}</span>
              )}
            </p>
          )}
        </header>

        {/* ---------------------------------------------------- status strip */}
        <section aria-label={s.status} data-request-section="status" className="lv-section">
          {step >= 0 ? (
            <>
              <ol className="flex gap-1.5" data-request-steps>
                {REQUEST_STEPS.map((k, i) => (
                  <li key={k} aria-current={i === step ? 'step' : undefined} data-step={k} data-step-state={i < step ? 'done' : i === step ? 'current' : 'next'} className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span aria-hidden="true" className={`block h-1 rounded-full ${i <= step ? 'bg-gold' : 'bg-surface-selected'}`} />
                    {/* Six words do not fit a phone's width: there, the current one is said in full below —
                        and the words stay in the accessibility tree, so the list is never six empty items.
                        The column's gap spaces the word from its bar once it is shown (an sr-only item is out of the flow). */}
                    <span className={`sr-only text-[11px] leading-tight sm:not-sr-only ${i === step ? 'font-semibold text-text-primary' : 'text-text-muted'}`}>{s.steps[k]}</span>
                  </li>
                ))}
              </ol>
              <p aria-hidden="true" className="mt-2 text-[12.5px] text-text-secondary sm:hidden" data-request-step-line>
                {fill(s.stepOf, { n: step + 1, total: REQUEST_STEPS.length, label: s.steps[REQUEST_STEPS[step]] })}
              </p>
            </>
          ) : draft && isOwner ? null : (
            // The owner of a draft reads it on the draft card below — said once, not twice.
            <p className={`lv-alert ${current.state === 'disputed' ? 'lv-alert-danger' : 'lv-alert-info'} text-[13px] text-text-primary`} data-request-status-line={current.state}>
              {current.state === 'draft' ? s.statusDraft : current.state === 'expired' ? s.statusExpired : current.state === 'disputed' ? s.statusDisputed : s.statusClosed}
            </p>
          )}

          {isOwner && draft && (
            <div className="lv-surface p-4" data-requests="draft">
              <p className="flex items-center gap-2 text-[13.5px] font-semibold text-text-primary">
                <FilePen aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
                {s.draftTitle}
              </p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-text-secondary">{s.draftBody}</p>
              <p role="alert" aria-live="polite" className="lv-field-error empty:hidden">
                {draftError}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="primary" size="sm" onClick={publishDraft} loading={publishing} loadingLabel={s.publishing} data-requests="publish-draft">
                  {s.publish}
                </Button>
                {onEdit && (
                  <Button variant="secondary" size="sm" onClick={() => onEdit(current.id)} disabled={publishing} data-requests="continue-draft">
                    {s.continueEditing}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDiscardError('');
                    setDiscardOpen(true);
                  }}
                  disabled={publishing}
                  data-requests="discard-draft"
                >
                  {s.discardDraft}
                </Button>
              </div>
            </div>
          )}
        </section>

        {/* ----------------------------------------------------------- files */}
        {(files.length > 0 || isOwner) && (
          <section id="files" aria-label={s.files} data-request-section="files" className="lv-section">
            <AttachmentList
              requestId={current.id}
              files={files}
              /* Adding or removing is only offered while the request still
                 takes offers — the merchants priced against these files. */
              canEdit={isOwner && ['open', 'receiving_offers', 'draft'].includes(current.state)}
              onChanged={() => {
                loadRequest();
                // A change to a published job makes standing offers stale.
                load();
              }}
            />
            <ModelDoors requestId={current.id} files={files} skip={primaryFile} lang={L} s={s} />
          </section>
        )}

        {/* --------------------------------------------------------- details */}
        <section id="details" aria-labelledby="request-details-title" data-request-section="details" className="lv-section">
          <h2 id="request-details-title" className="mb-2 text-[13px] font-semibold text-text-muted">
            {s.details}
          </h2>
          {current.description && (
            <p dir="auto" className="mb-3 whitespace-pre-wrap break-words text-start text-[14px] leading-relaxed text-text-secondary">
              {current.description}
            </p>
          )}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3" data-request-facts>
            {current.budget_iqd !== null && current.budget_iqd !== undefined && <Fact label={s.budget} value={<Money iqd={current.budget_iqd} />} />}
            {current.quantity > 1 && <Fact label={s.quantity} value={`×${current.quantity}`} />}
            {current.material && <Fact label={s.material} value={current.material} />}
            {current.color && <Fact label={s.colour} value={current.color} />}
            {current.dimensions && <Fact label={s.dimensions} value={current.dimensions} />}
            {current.deadline && <Fact label={s.deadline} value={formatDate(current.deadline, lang) || current.deadline} />}
            {/* Where it goes, when it was asked, and until when offers are taken. */}
            {current.governorate && <Fact label={s.governorate} value={gov ? gov[L] : current.governorate} />}
            {current.state !== 'draft' && formatDate(current.created_at, lang) && <Fact label={s.publishedOn} value={formatDate(current.created_at, lang)} />}
            {open && formatDate(current.expires_at, lang) && (
              <Fact label={s.offersClose} value={formatDate(current.expires_at, lang)} />
            )}
          </dl>
          {current.customer_notes && (
            <div className="lv-well mt-3 rounded-md px-3 py-2.5" data-request="customer-notes">
              <p className="mb-0.5 text-[11.5px] text-text-muted">{s.notesForMerchants}</p>
              <p dir="auto" className="whitespace-pre-wrap break-words text-start text-[13px] leading-relaxed text-text-secondary">
                {current.customer_notes}
              </p>
            </div>
          )}
          {isOwner && open && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {onEdit && (
                <Button variant="secondary" size="sm" icon={<PencilLine aria-hidden="true" className="h-4 w-4" />} onClick={() => onEdit(current.id)} data-request="edit">
                  {s.editRequest}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCloseError('');
                  setCloseOpen(true);
                }}
                data-requests="close-request"
              >
                {s.closeRequest}
              </Button>
            </div>
          )}
          {/* What Levonis measured and estimated — the estimate card. Renders
              nothing for a request that carries no print row. */}
          <div className="mt-4">
            <PrintSummary requestId={current.id} onLoaded={(f) => setPrimaryFile(f?.primary_file_id ?? null)} />
          </div>
        </section>

        {/* ------------------------------------------------------ discussion */}
        {!draft && !discussionShut && (
          <section id="discussion" aria-labelledby="request-discussion-title" data-request-section="discussion" className="lv-section scroll-mt-14">
            <h2 id="request-discussion-title" className="mb-2 text-[13px] font-semibold text-text-muted">
              {s.discussion}
            </h2>
            <Discussion requestId={current.id} open={open} onUnavailable={() => setDiscussionShut(true)} />
          </section>
        )}

        {/* ---------------------------------------------------------- offers */}
        {!draft && !(accepted && !isCustomer) && (
          <section
            id="offers"
            aria-label={isCustomer ? s.offers : onlookers ? s.wantLikeThis : s.yourOffer}
            data-request-section="offers"
            className="lv-section scroll-mt-14"
          >
            {/* «عرضك» is a merchant's heading; a visitor gets the card below instead. */}
            {(isCustomer || !onlookers) && !(isCustomer && accepted) && (
              <h2 className="mb-3 text-[13px] font-semibold text-text-muted">{isCustomer ? s.offers : s.yourOffer}</h2>
            )}
            {/* The workshop's own verdict on this request, with the reasons and
                the screen that fixes each, and its private costing (W5-B). */}
            {me?.store && !isCustomer && !isOwner && current.state !== 'draft' && (
              <div className="mb-3">
                <WorkshopRequestCard requestId={current.id} takingOffers={open} openCosting={openCosting} onUseAsOffer={setPrefill} />
              </div>
            )}
            {offers === null || !meReady ? (
              offersError ? (
                <CommunityLoadError error={offersError} onRetry={load} compact />
              ) : (
                <SkeletonGroup className="space-y-2">
                  <Skeleton className="h-40 w-full rounded-2xl" />
                </SkeletonGroup>
              )
            ) : isCustomer ? (
              accepted ? (
                // The choice is made: the other offers stay on the record, folded.
                <details className="group" data-request-other-offers>
                  <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg text-[13px] font-semibold text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                    <span>
                      {s.offers} <span className="tabular-nums text-text-muted">({offers.length})</span>
                    </span>
                  </summary>
                  <div className="pt-2">
                    <OfferCompare requestId={current.id} offers={offers} takingOffers={false} materials={materials} onChanged={refreshAll} />
                  </div>
                </details>
              ) : (
                <OfferCompare requestId={current.id} offers={offers} takingOffers={open} materials={materials} onChanged={refreshAll} />
              )
            ) : onlookers ? (
              <OnlookerCard me={me} onNewRequest={onNewRequest} />
            ) : (
              <MerchantOfferSection
                requestId={current.id}
                offers={offers}
                draft={myDraft}
                canOffer={canOffer}
                takingOffers={open}
                materials={materials}
                defaultQuantity={current.quantity}
                deliveryPref={current.delivery_pref}
                onChanged={load}
                prefill={prefill}
                onPrefillDone={() => setPrefill(null)}
              />
            )}
          </section>
        )}

        {/* ------------------------------------------------------- chat door */}
        {chatWith && (
          <section aria-labelledby="request-chat-title" data-request-section="chat" className="lv-section">
            <h2 id="request-chat-title" className="text-[13px] font-semibold text-text-muted">
              {s.chat}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">{chatWith === 'merchant' ? s.chatWithMerchant : s.chatWithCustomer}</p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              icon={<MessageCircle aria-hidden="true" className="h-4 w-4" />}
              onClick={() => openChat(chatWith === 'merchant' ? accepted?.merchant_id : undefined)}
              data-request-chat={chatWith}
            >
              {chatWith === 'merchant' ? s.openConversation : s.messageCustomer}
            </Button>
          </section>
        )}

        {/* -------------------------------------------------- accepted offer */}
        {accepted && (
          <section aria-labelledby="request-accepted-title" data-request-section="accepted" className="lv-section">
            <h2 id="request-accepted-title" className="mb-2 text-[13px] font-semibold text-text-muted">
              {s.accepted}
            </h2>
            <AcceptedOffer o={accepted} s={s} lang={L} materials={materials} mine={!isCustomer} orderState={order?.order.state ?? null} />
          </section>
        )}

        {/* -------------------------------------------------------- timeline */}
        {orderId && (
          <section id="timeline" aria-labelledby="request-timeline-title" data-request-section="timeline" className="lv-section scroll-mt-14">
            <h2 id="request-timeline-title" className="mb-2 text-[13px] font-semibold text-text-muted">
              {s.timeline}
            </h2>
            <TimelinePeek timeline={timeline} failed={timelineFailed} onRetry={retryTimeline} s={s} lang={L} onOpen={() => setTimelineOpen(true)} />
          </section>
        )}

        {/* --------------------------------------------------------- escrow */}
        {order && (
          <section aria-labelledby="request-escrow-title" data-request-section="escrow" className="lv-section">
            <h2 id="request-escrow-title" className="mb-2 text-[13px] font-semibold text-text-muted">
              {s.escrow}
            </h2>
            <EscrowLine order={order} s={s} lang={L} />
          </section>
        )}

        {/* -------------------------------------------------------- delivery */}
        {order && (
          <section aria-labelledby="request-delivery-title" data-request-section="delivery" className="lv-section">
            <h2 id="request-delivery-title" className="mb-2 text-[13px] font-semibold text-text-muted">
              {s.delivery}
            </h2>
            <ContactCard order={order} s={s} lang={L} />
          </section>
        )}

        {/* ---------------------------------------------------------- review */}
        {orderId && role === 'customer' && order?.order.state === 'completed' && <ReviewSection orderId={orderId} s={s} />}
      </Motion.article>

      {/* THE ORDER'S TIMELINE (Client 5d), behind the «آخر تحديث» door. */}
      {orderId && (
        <Sheet
          open={timelineOpen}
          onClose={() => setTimelineOpen(false)}
          label={s.timeline}
          detents={['medium', 'large']}
          dragHandle
          testId="request-order-timeline"
          header={
            <div className="px-4 pb-2 pt-1">
              <h2 className="text-[16px] font-bold text-text-primary">{s.timeline}</h2>
              <p dir="auto" className="truncate text-start text-[12.5px] text-text-secondary">
                {current.title}
              </p>
            </div>
          }
        >
          {timelineOpen && (
            <div className="px-4 pb-4" data-request-timeline-sheet={orderId}>
              <Suspense
                fallback={
                  <SkeletonGroup className="space-y-3">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-4 w-1/2" />
                  </SkeletonGroup>
                }
              >
                <OrderTimeline
                  orderId={orderId}
                  onChanged={() => {
                    load();
                    setOrderVersion((v) => v + 1);
                  }}
                />
              </Suspense>
            </div>
          )}
        </Sheet>
      )}

      <ConfirmSheet
        open={discardOpen}
        testId="discard-draft"
        tone="danger"
        title={s.discardQ}
        confirmLabel={s.discardDraft}
        busyLabel={s.discarding}
        busy={discarding}
        error={discardError}
        onConfirm={discardDraft}
        onClose={() => setDiscardOpen(false)}
      >
        {s.discardBody}
      </ConfirmSheet>
      <ConfirmSheet
        open={closeOpen}
        testId="close-request"
        tone="danger"
        title={s.closeQ}
        confirmLabel={s.closeRequest}
        busyLabel={s.closing}
        busy={closing}
        error={closeError}
        onConfirm={closePublished}
        onClose={() => setCloseOpen(false)}
      >
        {s.closeBody}
      </ConfirmSheet>
    </MotionFeatures>
  );
}

// ------------------------------------------------------------------- order

/** The order a request became, as its two parties read it: the view (money, contact) and the timeline. */
function useOrderView(
  orderId: string | null,
  version: number
): { view: OrderView | null; timeline: OrderTimelineData | null; timelineFailed: boolean; retryTimeline: () => void } {
  const [view, setView] = useState<OrderView | null>(null);
  const [timeline, setTimeline] = useState<OrderTimelineData | null>(null);
  // A failed read is not an empty one (review 2026-09-30): «لا تحديثات بعد» over an order
  // whose updates could not be read told the customer nothing had happened.
  const [timelineFailed, setTimelineFailed] = useState(false);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    if (!orderId) {
      setView(null);
      setTimeline(null);
      setTimelineFailed(false);
      return;
    }
    let alive = true;
    api
      .get<OrderView>(`/api/marketplace/orders/${encodeURIComponent(orderId)}`)
      .then((d) => alive && setView(d))
      .catch(() => alive && setView(null));
    discussionApi
      .orderTimeline(orderId)
      .then((d) => {
        if (!alive) return;
        setTimeline(d);
        setTimelineFailed(false);
      })
      .catch(() => {
        if (!alive) return;
        setTimeline(null);
        setTimelineFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [orderId, version, again]);
  const retryTimeline = useCallback(() => setAgain((n) => n + 1), []);
  return { view, timeline, timelineFailed, retryTimeline };
}

function AcceptedOffer({
  o,
  s,
  lang,
  materials,
  mine,
  orderState,
}: {
  o: OfferV2;
  s: RequestStrings;
  lang: RequestLang;
  materials: CatalogMaterial[];
  /** The reader is the workshop whose offer this is. */
  mine: boolean;
  orderState: string | null;
}) {
  const names = o.material_ids
    .map((id) => {
      const mm = materials.find((x) => x.id === id);
      return mm ? (lang === 'en' ? mm.name_en : mm.name_ar || mm.name_en) : id;
    })
    .join(lang === 'en' ? ', ' : '، ');
  const facts: Array<[string, ReactNode]> = [
    [s.completion, o.completion_days ? daysLabel(o.completion_days, lang) : '—'],
    [s.handover, handoverLabel(o.delivery_method, s)],
  ];
  if (o.quantity != null) facts.push([s.quantity, `×${o.quantity}`]);
  if (o.color) facts.push([s.colour, <bdi key="c">{o.color}</bdi>]);
  if (names) facts.push([s.materials, names]);
  if (o.included) facts.push([s.included, <bdi key="i">{o.included}</bdi>]);
  if (o.warranty_terms) facts.push([s.warranty, <bdi key="w">{o.warranty_terms}</bdi>]);
  if (o.terms) facts.push([s.terms, <bdi key="t">{o.terms}</bdi>]);
  return (
    <div className="lv-surface p-4" data-accepted-offer={o.id}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-text-primary">
            <bdi>{o.merchant?.name ?? s.theMerchant}</bdi>
          </p>
          <p className="text-[12px] text-text-muted">{fill(s.version, { n: o.revision })}</p>
        </div>
        {orderState && <StatusChip tone={orderState === 'completed' ? 'success' : orderState === 'disputed' ? 'danger' : 'info'}>{orderStateWord(orderState, s)}</StatusChip>}
      </div>
      <p className="mt-2 text-[20px] font-bold text-text-primary" data-offer-total={o.total_iqd ?? ''}>
        <Money iqd={o.total_iqd} />
      </p>
      <Breakdown o={o} s={s} />
      <dl className="mt-2 divide-y divide-border-subtle/60">
        {facts.map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-3 py-2">
            <dt className="shrink-0 text-[12px] text-text-muted">{k}</dt>
            <dd className="min-w-0 break-words text-end text-[12.5px] text-text-primary">{v}</dd>
          </div>
        ))}
      </dl>
      {o.message && (
        <p className="mt-2 whitespace-pre-line rounded-lg bg-surface-raised px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary" dir="auto">
          {o.message}
        </p>
      )}
      <OfferFiles files={o.files ?? []} label={s.offerFiles} />
      {mine && <p className="mt-3 text-[13px] text-success">{s.acceptedByCustomer}</p>}
    </div>
  );
}

/**
 * «آخر تحديث: بدأ العمل · قبل ساعتين» and the door to the whole record — the
 * event worded by the timeline's own table (Client 5d, ./timelineStrings.ts),
 * so the line and the sheet it opens never say one moment two ways.
 */
function TimelinePeek({
  timeline,
  failed = false,
  onRetry,
  s,
  lang,
  onOpen,
}: {
  timeline: OrderTimelineData | null;
  /** The read failed — said as a failure, with a retry, never as «no updates yet». */
  failed?: boolean;
  onRetry?: () => void;
  s: RequestStrings;
  lang: RequestLang;
  onOpen: () => void;
}) {
  const t = useTimelineStrings();
  const last = latestEvent(timeline);
  const words = t.event as Record<string, string>;
  return (
    <div data-request-timeline-peek>
      <p className="text-[13px] leading-relaxed text-text-secondary">
        {failed && !last ? (
          <span className="text-text-muted" data-request-timeline-failed>
            {s.updatesFailed}{' '}
            {onRetry && (
              <button type="button" onClick={onRetry} className="inline-flex min-h-11 items-center font-semibold text-text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                {s.updatesRetry}
              </button>
            )}
          </span>
        ) : last ? (
          <>
            <span className="text-text-muted">{s.lastUpdate}: </span>
            <span className="font-semibold text-text-primary" data-request-last-event={last.kind}>
              {words[last.kind] ?? t.event.other}
            </span>
            <span className="text-text-muted">
              {' · '}
              <time dateTime={last.at}>{timeAgo(last.at, lang)}</time>
            </span>
          </>
        ) : (
          <span className="text-text-muted">{s.noUpdatesYet}</span>
        )}
      </p>
      <Button variant="secondary" size="sm" className="mt-2" onClick={onOpen} data-request-timeline-door>
        {s.openTimeline}
      </Button>
    </div>
  );
}

/** THE MONEY, in words: held, released, returned — the amounts the server keeps, never a key or an account. */
function EscrowLine({ order, s, lang }: { order: OrderView; s: RequestStrings; lang: RequestLang }) {
  const e = order.escrow;
  const merchant = order.role === 'merchant';
  return (
    <div className="space-y-1.5 text-[13px]" data-request-escrow={e?.state ?? 'none'}>
      <p className="text-text-primary">{escrowSentence(e?.state, s)}</p>
      {e && (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-text-muted">
          <span>
            {s.total}: <Money iqd={e.gross_iqd} className="font-semibold text-text-primary" />
          </span>
          {merchant && e.merchant_receivable_iqd > 0 && (
            <span data-request-receivable>{fillNodes(s.youReceive, { amount: <Money iqd={e.merchant_receivable_iqd} className="font-semibold text-text-primary" /> })}</span>
          )}
        </p>
      )}
      {order.order.state === 'merchant_marked_delivered' && order.order.auto_complete_at && (
        <p className="text-[12.5px] text-text-muted">{fill(s.autoConfirms, { date: formatDate(order.order.auto_complete_at, lang) })}</p>
      )}
      {order.order.state === 'merchant_marked_delivered' && !merchant && <p className="text-[12.5px] text-text-secondary">{s.confirmFromOrders}</p>}
      <Link
        to={merchant ? merchantHref.customOrder(order.order.id) : '/requests?view=orders'}
        className="inline-flex min-h-11 items-center text-[12.5px] font-semibold text-text-secondary underline-offset-4 hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        data-request-orders-link
      >
        {merchant ? s.merchantOrders : s.myCustomOrders}
      </Link>
    </div>
  );
}

/** THE OTHER PARTY, frozen at acceptance (§4.7): the merchant reads the customer's delivery contact, the customer the store's. */
function ContactCard({ order, s, lang }: { order: OrderView; s: RequestStrings; lang: RequestLang }) {
  const c = order.contact;
  const merchant = order.role === 'merchant';
  const gov = c?.governorate ? GOVERNORATE_LABELS[c.governorate] : undefined;
  const place = [gov ? gov[lang] : c?.governorate ?? '', c?.area, c?.address, c?.landmark].filter(Boolean).join(' · ');
  return (
    <div className="lv-surface p-4" data-order-contact={order.order.id} data-order-contact-role={order.role}>
      <p className="text-[12px] font-semibold text-text-muted">{merchant ? s.contactCustomer : s.contactMerchant}</p>
      {c ? (
        <div className="mt-2 space-y-1.5 text-[13px]">
          <p className="flex items-center gap-2 font-semibold text-text-primary">
            {!merchant && <Store aria-hidden="true" className="h-4 w-4 text-text-muted" />}
            <bdi>{merchant ? c.name : c.store_name}</bdi>
          </p>
          {c.phone ? (
            <a href={`tel:${c.phone}`} className="inline-flex min-h-11 items-center gap-2 rounded text-text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" dir="ltr" data-order-contact-phone>
              <Phone aria-hidden="true" className="h-4 w-4 text-text-muted" />
              {c.phone}
            </a>
          ) : (
            <p className="text-text-muted">{s.noPhone}</p>
          )}
          {merchant && (
            <p className="flex items-start gap-2 text-text-secondary">
              <MapPin aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
              <span dir="auto" className="min-w-0 break-words">
                {c.delivery_method === 'pickup' ? s.collectsFromWorkshop : place || s.noAddressAsk}
              </span>
            </p>
          )}
          {c.delivery_method && <p className="text-[12px] text-text-muted">{handoverLabel(c.delivery_method, s)}</p>}
        </div>
      ) : (
        <p className="mt-1.5 text-[12.5px] text-text-secondary">{s.talkInChat}</p>
      )}
    </div>
  );
}

/** «قيّم الورشة» — the completed order's rating, when it is still waiting for one. */
function ReviewSection({ orderId, s }: { orderId: string; s: RequestStrings }) {
  const [done, setDone] = useState(false);
  const rows = useEligibleReviews('custom');
  const item = rows?.find((r) => r.community_order_id === orderId) ?? null;
  if (!item && !done) return null;
  return (
    <section aria-labelledby="request-review-title" data-request-section="review" className="lv-section">
      <h2 id="request-review-title" className="mb-2 text-[13px] font-semibold text-text-muted">
        {s.review}
      </h2>
      {item && !done ? <StoreReviewCard item={item} onDone={() => setDone(true)} /> : <p className="text-[13px] text-success">{s.reviewThanks}</p>}
    </section>
  );
}

// ------------------------------------------------------------------ pieces

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-text-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-start text-[13px] font-semibold text-text-primary">
        <bdi>{value}</bdi>
      </dd>
    </div>
  );
}

/**
 * «عرض ثلاثي الأبعاد» for each model the caller may preview (the files' own
 * `access`, the W5-B matrix) — minted on demand, never on page load: minting
 * is rate-limited and writes a row. The primary model already has its door
 * in PrintSummary, so it is not offered twice.
 */
function ModelDoors({ requestId, files, skip, lang, s }: { requestId: string; files: PageFile[]; skip: string | null; lang: RequestLang; s: RequestStrings }) {
  const { isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const toast = useToast();
  const inFlight = useRef(new Set<string>());
  const doors = files.filter((f) => f.kind === 'model' && (f.access === 'preview' || f.access === 'download') && f.id !== skip);
  if (!doors.length) return null;
  const view = async (f: PageFile) => {
    if (!isAuthenticated) {
      signIn();
      return;
    }
    if (inFlight.current.has(f.id)) return;
    inFlight.current.add(f.id);
    try {
      const t = await printApi.viewerToken(requestId, f.id);
      window.open(t.url && t.url.startsWith('/') ? t.url : viewerHref(t.token), '_blank', 'noopener');
    } catch (e) {
      toast.error(apiRefusal(e, lang, s.couldNotOpenViewer));
    } finally {
      inFlight.current.delete(f.id);
    }
  };
  return (
    <ul className="mt-2 flex flex-wrap gap-2" data-request-model-doors>
      {doors.map((f) => (
        <li key={f.id} className="max-w-full">
          <Button variant="secondary" size="sm" icon={<Box aria-hidden="true" className="h-4 w-4" />} onClick={() => view(f)} className="max-w-full" data-request-view3d={f.id}>
            <bdi className="truncate">{fill(s.view3dOf, { name: f.file_name })}</bdi>
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * A VISITOR READING SOMEONE'S REQUEST — signed out, or signed in without a
 * store. It says what they CAN do: ask for something like it, or (to print
 * for others) open a store. (Review of Levo Community, 2026-09-28.)
 */
function OnlookerCard({ me, onNewRequest }: { me: MerchantMe | null; onNewRequest?: () => void }) {
  const s = useRequestStrings();
  const { user } = useAuth();
  return (
    <div className="lv-surface space-y-3 p-4" data-request-onlooker>
      <div>
        <p className="text-[13.5px] font-semibold text-text-primary">{s.wantLikeThis}</p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-secondary">{s.askYourself}</p>
        {onNewRequest && (
          <Button variant="primary" size="sm" className="mt-2.5" icon={<Plus aria-hidden="true" className="h-4 w-4" />} onClick={onNewRequest} data-request-onlooker-new>
            {user ? s.askLikeIt : s.signInAndAsk}
          </Button>
        )}
      </div>
      <div className="border-t border-border-subtle pt-3">
        <p className="text-[12.5px] leading-relaxed text-text-secondary">{s.printForOthers}</p>
        <a
          href={user && me?.eligible ? '/merchant/start' : '/subscription'}
          className="mt-1 inline-flex min-h-11 items-center rounded text-[12.5px] font-semibold text-text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          data-request-onlooker-store
        >
          {user && me?.eligible ? s.openYourStore : s.aboutPlus}
        </a>
      </div>
    </div>
  );
}

function PageSkeleton() {
  const s = useRequestStrings();
  return (
    <SkeletonGroup label={s.loadingRequest} className="space-y-4 pt-4">
      <Skeleton className="h-6 w-3/4" />
      <Skeleton className="h-3 w-1/3" />
      <Skeleton className="h-2 w-full" />
      <Skeleton className="h-24 w-full rounded-2xl" />
      <Skeleton className="h-40 w-full rounded-2xl" />
    </SkeletonGroup>
  );
}
