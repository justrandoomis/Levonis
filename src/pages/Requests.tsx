/**
 * The customer-request marketplace — /requests.
 *
 * A customer describes a job; merchants offer; the customer picks one and the
 * money is held until the work is done.
 *
 * WHAT THIS PAGE SHOWS AND DOES NOT. The board is public, so it shows the JOB
 * — title, quantity, material, budget, governorate — and a display name. It
 * never shows a phone, an email or an address, and that is enforced by the
 * server's SELECT list rather than by this page choosing what to render
 * (§24). If this component asked for more, it would not get it.
 *
 * ACCEPTING AN OFFER MOVES MONEY, so the confirmation says so plainly: the
 * amount leaves the customer's available balance and is HELD, not paid, and
 * the merchant is only paid when the customer confirms delivery. A customer
 * who does not understand that is a customer who will open a dispute over
 * something working correctly.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import {
  Plus, Loader2, PackageSearch, Clock, MapPin, Star, BadgeCheck, ShieldCheck,
  ChevronLeft, Send, X, AlertTriangle, FilePen,
} from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { useSignInPrompt } from '../lib/guest';
import { api, ApiError } from '../lib/api';
import { iqd, badgeLabel, merchantApi, communityOrdersApi, type MerchantMe, type CommunityOrderRow } from '../lib/merchant';
import { GOVERNORATE_LABELS } from '../lib/governorates';
import { AttachmentList, type RequestFile } from '../components/media/RequestAttachments';
import PrintRequestWizard from '../components/print/PrintRequestWizard';
import PrintSummary from '../components/print/PrintSummary';
import MyRequestsList from '../components/print/MyRequestsList';
import ProMerchantBadge from '../components/merchant/ProMerchantBadge';
/**
 * A PUBLISHED REQUEST IS A PROMISE OF OFFERS, and offers arrive hours later
 * from merchants the customer has never met. For an account with no outbound
 * channel every one of them lands only in the in-app inbox, so the request the
 * customer just wrote sits there collecting answers nobody tells them about.
 */
import ChannelNudge from '../components/notify/ChannelNudge';
import { CommunityStoreLink } from './community/access';
import Spinner from '../components/ui/Spinner';
import ConfirmSheet from '../components/print/ConfirmSheet';
import { apiRefusal } from '../lib/refusalStrings';
import { asLang, formatDate } from '../components/orders/format';

interface RequestRow {
  id: string;
  title: string;
  description: string;
  category: string;
  quantity: number;
  material: string;
  color: string;
  dimensions: string;
  budget_iqd: number | null;
  deadline: string | null;
  governorate: string;
  state: string;
  offer_count: number;
  created_at: string;
  customer_name: string | null;
  expires_at?: string | null;
}

interface OfferRow {
  id: string;
  price_iqd: number;
  completion_days: number;
  delivery_method: string;
  message: string;
  warranty_terms: string;
  state: string;
  /** The version on screen. Accepting sends it back, so only THIS version can
   *  be accepted — never one the merchant edited after the customer read it. */
  revision: number;
  /** The customer changed the request after this offer priced it; it cannot be
   *  accepted until its merchant re-confirms it. */
  stale: boolean;
  merchant: {
    id: string;
    name: string;
    verified: boolean;
    pro_badge?: boolean;
    badge: string;
    rating: number | null;
    rating_count: number;
    completed_orders: number;
    store_slug: string | null;
  } | null;
}

type View = 'board' | 'mine' | 'orders' | 'new';

export default function Requests() {
  const { loc } = useLanguage();
  const { user } = useAuth();
  const { signIn } = useSignInPrompt();
  /**
   * A model link carried over from the price calculator (src/pages/Tools.tsx,
   * «أرسله طلب طباعة»): a signed-in customer lands straight in the wizard with
   * it filled in, instead of on the board with nothing.
   */
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  // A guest is sent through sign-in first, and router state does not survive
  // that trip — so the link also rides in `?link=` (Tools.tsx).
  const carriedLink =
    typeof (location.state as { printLink?: unknown } | null)?.printLink === 'string'
      ? String((location.state as { printLink: string }).printLink)
      : params.get('link') ?? '';
  const [view, setView] = useState<View>(() => (carriedLink && user ? 'new' : 'board'));
  const [me, setMe] = useState<MerchantMe | null>(null);
  const [open, setOpen] = useState<RequestRow | null>(null);
  const [deepLinkError, setDeepLinkError] = useState('');
  /**
   * A REQUEST WAS JUST PUBLISHED BY THIS PERSON, in this session. Latched
   * rather than derived from the open request: the deep-link effect below
   * opens any request whose id is in the URL — including one a MERCHANT was
   * pointed at by a match notification — and offering a customer-notification
   * window to a merchant reading somebody else's job would be the wrong window
   * on the wrong screen.
   */
  const [requestJustCreated, setRequestJustCreated] = useState(false);

  useEffect(() => {
    if (!user) return;
    merchantApi.me().then(setMe).catch(() => {});
  }, [user]);

  /**
   * ONE REQUEST HAS ONE ADDRESS.
   *
   * A merchant told about a matching job arrives at `/requests?request=<id>`,
   * and that link has to land on THAT request — the notification's entire
   * purpose is to open the one the matcher pointed at, and a page that dropped
   * them on a generic board would make the match pointless. The detail view
   * used to be local state with no URL, so this reads the id back out and
   * fetches it, which also makes any request shareable and reloadable.
   */
  const deepLinked = params.get('request') ?? '';
  useEffect(() => {
    if (!deepLinked || open?.id === deepLinked) return;
    let alive = true;
    setDeepLinkError('');
    api
      .get<{ request: RequestRow }>(`/api/marketplace/requests/${deepLinked}`)
      .then((d) => {
        if (alive) setOpen(d.request);
      })
      .catch((e) => {
        if (!alive) return;
        // A closed or private request 404s by design. Say so plainly rather
        // than leaving a merchant staring at a board wondering what happened.
        setDeepLinkError(
          e instanceof ApiError && e.status === 404
            ? loc(
                'هذا الطلب لم يعد متاحًا — ربما أُغلق أو اختار صاحبه عرضًا.',
                'That request is no longer available — it may have closed or an offer was accepted.',
                'ئەم داواکاریە بەردەست نییە — لەوانەیە داخرابێت.'
              )
            : loc('تعذّر فتح الطلب', 'Could not open the request', 'نەتوانرا داواکاری بکرێتەوە')
        );
        setParams({}, { replace: true });
      });
    return () => {
      alive = false;
    };
  }, [deepLinked, open?.id, loc, setParams]);

  /** Opening and closing move the URL with them, so Back works. */
  const openRequest = useCallback(
    (r: RequestRow) => {
      setOpen(r);
      setParams({ request: r.id });
    },
    [setParams]
  );
  /**
   * The wizard and the repeat button know an id and nothing else. Rather than
   * make them fetch the row just to hand it back, they move the URL and let the
   * deep-link effect above do the one fetch it already knows how to do.
   */
  const openRequestId = useCallback(
    (id: string) => {
      setParams({ request: id });
    },
    [setParams]
  );
  const closeRequest = useCallback(() => {
    setOpen(null);
    setParams({}, { replace: true });
  }, [setParams]);

  /**
   * THE WINDOW IS RENDERED ONCE, OUTSIDE THE BRANCH — and that is the whole
   * point of the fragment below.
   *
   * This element used to appear in TWO mutually exclusive returns: a fragment
   * when `open` was set, and inside the board `<div>` otherwise. Different
   * positions in the tree, so React unmounted and remounted the component on
   * every toggle, and the publish flow toggles immediately: `onCreated` calls
   * `openRequestId`, which moves the URL, which wakes the deep-link effect,
   * which sets `open`. That cost two things.
   *
   *   ONE WASTED ROUND TRIP per publish. The board-branch instance fired its
   *   readiness GET, was unmounted (its AbortController cancelling the request
   *   in flight), and the detail-branch instance fired a second one — on a
   *   route the server marks `no-store`, so neither could be served from cache.
   *
   *   AND A WINDOW THAT CAME BACK FROM THE DEAD. Escape or a drag sets only the
   *   sheet's local `open` to false and deliberately records NOTHING — it means
   *   "not this window", not «ليس الآن». Pressing Back then flipped the branch,
   *   remounted the component with `active` still latched true, and popped the
   *   sheet again 1.6 seconds later. To the customer that is a window refusing
   *   to go away, which is precisely the nagging the owner's «أو لا» forbids.
   *
   * Rendered from one place, the instance survives the board ↔ detail
   * transition: one fetch, one reveal, and a dismissal that stays dismissed.
   * It portals to document.body and carries no scrim, so the request's own page
   * stays fully usable behind it either way.
   */
  const nudge = <ChannelNudge context="request" active={requestJustCreated} />;

  /**
   * ONE RETURN, so `{nudge}` below keeps the same position in the tree whether
   * the board or the request's own screen is showing. See the note above it.
   */
  return (
    <>
      {open ? (
        <RequestDetail request={open} me={me} onBack={closeRequest} />
      ) : (
        <div className="min-h-screen bg-[#0a0a0a] text-zinc-300 pb-28">
          <div className="fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-2xl h-[380px] bg-olive/15 rounded-full blur-[120px] pointer-events-none z-0" />

          <div className="relative z-10 max-w-2xl mx-auto px-4 sm:px-6 pt-6">
            <h1 className="text-gold font-bold text-lg mb-1">
              {loc('طلبات العملاء', 'Customer requests', 'داواکاری کڕیاران')}
            </h1>
            <p className="text-zinc-500 text-[12.5px] mb-5">
              {loc(
                'اطلب شيئًا مخصصًا، واستقبل عروضًا من التجار.',
                'Ask for something custom, and receive offers from merchants.',
                'داوای شتێکی تایبەت بکە و ئۆفەر لە بازرگانەکانەوە وەربگرە.'
              )}
            </p>

            {deepLinkError && (
              <p
                className="mb-4 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5 text-[12.5px] text-amber-200"
                data-requests="deep-link-error"
                role="status"
              >
                {deepLinkError}
              </p>
            )}

            <div className="flex gap-1.5 mb-5 overflow-x-auto hide-scrollbar">
              {([['board', loc('كل الطلبات', 'All requests', 'هەموو داواکاریەکان')],
                 ['mine', loc('طلباتي', 'My requests', 'داواکاریەکانم')],
                 ...(user ? [['orders', loc('تنفيذ طلباتي', 'My custom orders', 'داواکاریە تایبەتەکانم')] as [View, string]] : []),
                ] as Array<[View, string]>).map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`shrink-0 px-4 min-h-[40px] rounded-2xl text-[12.5px] font-semibold border transition-colors ${
                    view === v ? 'bg-olive text-white border-olive' : 'bg-white/[0.03] text-zinc-400 border-white/10'
                  }`}
                >
                  {label}
                </button>
              ))}
              {(
                <button
                  onClick={() => (user ? setView('new') : signIn())}
                  className="ms-auto shrink-0 px-4 min-h-[40px] rounded-2xl bg-olive text-white text-[12.5px] font-semibold flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4" />
                  {loc('طلب جديد', 'New', 'نوێ')}
                </button>
              )}
            </div>

            {view === 'new' ? (
              /* THE WIZARD REPLACED THE FORM. `NewRequest` asked for eighteen
                 fields before it would create anything; the wizard asks for a file
                 and a sentence, measures the model itself, prices it, and only
                 then offers the rest behind "خيارات متقدمة". It still creates the
                 SAME `community_requests` row through the same endpoint — the
                 print side hangs off it, and publishing is what notifies the
                 merchants who can make it. */
              <PrintRequestWizard
                initialLink={carriedLink || undefined}
                onCreated={(id) => {
                  setView('mine');
                  openRequestId(id);
                  setRequestJustCreated(true);
                }}
                onCancel={() => setView('board')}
              />
            ) : view === 'orders' ? (
              <MyCommunityOrders />
            ) : view === 'mine' ? (
              <MyRequestsList onOpen={openRequestId} />
            ) : (
              <RequestList onOpen={openRequest} />
            )}
          </div>
        </div>
      )}
      {nudge}
    </>
  );
}

/**
 * THE PUBLIC BOARD. It renders `publicRequest()`'s whitelist and nothing more.
 * The customer's own list is `MyRequestsList`, which reads an owner-scoped
 * route carrying the estimate and the chosen merchant — data this component
 * deliberately never receives.
 */
function RequestList({ onOpen }: { onOpen: (r: RequestRow) => void }) {
  const { loc, lang } = useLanguage();
  const [rows, setRows] = useState<RequestRow[] | null>(null);

  useEffect(() => {
    setRows(null);
    api
      .get<{ requests: RequestRow[] }>('/api/marketplace/requests')
      .then((d) => setRows(d.requests))
      .catch(() => setRows([]));
  }, []);

  if (rows === null) {
    return (
      <div className="py-12 flex justify-center">
        <Loader2 className="w-5 h-5 text-gold animate-spin" />
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="py-14 text-center">
        <PackageSearch className="w-9 h-9 text-zinc-600 mx-auto mb-3" />
        <p className="text-zinc-400 text-[13px]">
          {loc('لا توجد طلبات مفتوحة', 'No open requests', 'هیچ داواکارییەکی کراوە نییە')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <button
          key={r.id}
          onClick={() => onOpen(r)}
          className="w-full text-start rounded-2xl border border-white/10 bg-white/[0.03] p-4 active:scale-[0.99] transition-transform"
        >
          <div className="flex items-start justify-between gap-3 mb-1.5">
            <h3 className="text-white font-semibold text-[14px] leading-snug">{r.title}</h3>
            <StateChip state={r.state} />
          </div>
          <p className="text-zinc-400 text-[12.5px] line-clamp-2 leading-relaxed mb-2.5">{r.description}</p>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-zinc-500">
            {r.budget_iqd !== null && (
              <span className="text-gold font-semibold" dir="ltr">
                {loc('الميزانية', 'Budget', 'بودجە')}: {iqd(r.budget_iqd)}
              </span>
            )}
            {r.quantity > 1 && <span>×{r.quantity}</span>}
            {r.material && <span>{r.material}</span>}
            {r.governorate && (
              <span className="flex items-center gap-1">
                <MapPin className="w-3 h-3" />
                {GOVERNORATE_LABELS[r.governorate]?.[lang === 'ckb' ? 'ckb' : lang] ?? r.governorate}
              </span>
            )}
            <span className="ms-auto text-gold/80 font-semibold">
              {loc(`${r.offer_count} عرض`, `${r.offer_count} offers`, `${r.offer_count} ئۆفەر`)}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}

// --------------------------------------------------------------- detail

function RequestDetail({
  request,
  me,
  onBack,
}: {
  request: RequestRow;
  me: MerchantMe | null;
  onBack: () => void;
}) {
  const { loc, lang } = useLanguage();
  const [offers, setOffers] = useState<OfferRow[] | null>(null);
  const [isCustomer, setIsCustomer] = useState(false);
  /** The offer the customer is about to accept — the sheet reads it. */
  const [accepting, setAccepting] = useState<OfferRow | null>(null);
  const [offering, setOffering] = useState(false);
  const [files, setFiles] = useState<RequestFile[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  /**
   * The request as the server has it NOW. The prop is whatever the list or the
   * deep link read, and publishing a draft or discarding it changes its state
   * on this very screen — so the page re-reads it rather than trusting a copy.
   */
  const [current, setCurrent] = useState<RequestRow>(request);
  const [publishing, setPublishing] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState('');

  useEffect(() => setCurrent(request), [request]);

  const load = useCallback(() => {
    api
      .get<{ offers: OfferRow[]; is_customer: boolean }>(`/api/marketplace/requests/${request.id}/offers`)
      .then((d) => {
        setOffers(d.offers);
        setIsCustomer(d.is_customer);
      })
      .catch(() => setOffers([]));
  }, [request.id]);

  // The attachments come from the request itself, and so does the answer to
  // "may this caller see them" — the server decides, this page renders.
  const loadFiles = useCallback(() => {
    api
      .get<{ request: RequestRow; files: RequestFile[]; is_owner: boolean }>(`/api/marketplace/requests/${request.id}`)
      .then((d) => {
        if (d.request) setCurrent(d.request);
        setFiles(d.files ?? []);
        setIsOwner(!!d.is_owner);
      })
      .catch(() => setFiles([]));
  }, [request.id]);

  useEffect(load, [load]);
  useEffect(loadFiles, [loadFiles]);

  const open = ['open', 'receiving_offers'].includes(current.state);
  const canOffer = !!me?.can.offers && !isCustomer && open;
  const alreadyOffered = (offers ?? []).some((o) => o.state === 'pending' || o.state === 'accepted');
  const fallback = loc('تعذّر إتمام العملية', 'Could not complete that', 'نەتوانرا تەواو بکرێت');

  /**
   * A DRAFT IS PUBLISHED FROM ITS OWN PAGE. The wizard's first step saves the
   * request as a draft (it is invisible until published), so a customer who
   * left the wizard, or whose «إعادة الطلب» copy could not be published, needs
   * a way to finish. An empty body publishes the spec already stored.
   */
  async function publishDraft() {
    setPublishing(true);
    setDraftError('');
    try {
      await api.post(`/api/marketplace/print/requests/${current.id}/publish`, {});
      loadFiles();
      load();
    } catch (e) {
      setDraftError(apiRefusal(e, asLang(lang), fallback));
    } finally {
      setPublishing(false);
    }
  }

  async function discardDraft() {
    setDiscarding(true);
    setDiscardError('');
    try {
      await api.post(`/api/marketplace/requests/${current.id}/cancel`);
      setDiscardOpen(false);
      loadFiles();
    } catch (e) {
      setDiscardError(apiRefusal(e, asLang(lang), fallback));
    } finally {
      setDiscarding(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-300 pb-28">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 pt-6">
        <button onClick={onBack} className="inline-flex items-center gap-1.5 text-zinc-400 text-[13px] mb-4">
          <ChevronLeft className="w-4 h-4 rtl:rotate-180" />
          {loc('رجوع', 'Back', 'گەڕانەوە')}
        </button>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 mb-4">
          <div className="flex items-start justify-between gap-3 mb-2">
            {/* The customer's own words keep their own direction: an Arabic
                "80×60 ملم" read in the English interface must not come out
                as 60×80. */}
            <h1 dir="auto" className="flex-1 text-white font-bold text-[16px] leading-snug min-w-0 break-words">
              {current.title}
            </h1>
            <StateChip state={current.state} />
          </div>
          <p dir="auto" className="text-zinc-300 text-[13px] leading-relaxed whitespace-pre-wrap break-words mb-3">
            {current.description}
          </p>

          <div className="grid grid-cols-2 gap-2 text-[12px]">
            {current.budget_iqd !== null && (
              <Detail label={loc('الميزانية', 'Budget', 'بودجە')} value={iqd(current.budget_iqd)} />
            )}
            {current.quantity > 1 && (
              <Detail label={loc('الكمية', 'Quantity', 'بڕ')} value={String(current.quantity)} />
            )}
            {current.material && <Detail label={loc('المادة', 'Material', 'ماددە')} value={current.material} />}
            {current.color && <Detail label={loc('اللون', 'Colour', 'ڕەنگ')} value={current.color} />}
            {current.dimensions && (
              <Detail label={loc('الأبعاد', 'Dimensions', 'ڕەهەندەکان')} value={current.dimensions} />
            )}
            {current.deadline && (
              <Detail label={loc('الموعد', 'Deadline', 'کاتی کۆتایی')} value={current.deadline} />
            )}
          </div>
        </div>

        {isOwner && current.state === 'draft' && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 mb-4" data-requests="draft">
            <p className="text-white text-[13.5px] font-semibold flex items-center gap-2">
              <FilePen className="w-4 h-4 text-zinc-400 shrink-0" aria-hidden="true" />
              {/* OWNER: Sorani to be written by hand. */}
              {loc('هذا الطلب مسودة', 'This request is a draft')}
            </p>
            <p className="text-zinc-400 text-[12.5px] mt-1 leading-relaxed">
              {/* OWNER: Sorani to be written by hand. */}
              {loc(
                'لا يراه أي تاجر بعد. انشره ليصل إلى التجار الذين يستطيعون تنفيذه وتبدأ العروض بالوصول.',
                'No merchant can see it yet. Publish it to reach the merchants who can make it and start receiving offers.'
              )}
            </p>
            <p role="alert" aria-live="polite" className="text-red-400 text-[12.5px] mt-2 empty:hidden">
              {draftError}
            </p>
            <div className="flex gap-2 mt-3">
              <button
                type="button"
                onClick={() => {
                  setDiscardError('');
                  setDiscardOpen(true);
                }}
                disabled={publishing}
                className="flex-1 min-h-[44px] rounded-xl border border-zinc-700 text-zinc-200 text-[13px] font-bold hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] disabled:opacity-50"
              >
                {/* OWNER: Sorani to be written by hand. */}
                {loc('إلغاء المسودة', 'Discard draft')}
              </button>
              <button
                type="button"
                onClick={publishDraft}
                disabled={publishing}
                data-requests="publish-draft"
                className="flex-1 min-h-[44px] rounded-xl bg-olive text-white text-[13px] font-bold hover:brightness-110 transition-[filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-60 inline-flex items-center justify-center gap-2"
              >
                {publishing && <Spinner size="sm" delayMs={0} decorative className="text-white" />}
                {loc('نشر', 'Publish', 'بڵاوکردنەوە')}
              </button>
            </div>
          </div>
        )}

        {/* What Levonis measured and estimated. Renders nothing at all for a
            request that carries no print row — an older one, or one whose link
            could not be measured. */}
        <PrintSummary requestId={current.id} />

        {(files.length > 0 || isOwner) && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 mb-4">
            <AttachmentList
              requestId={current.id}
              files={files}
              /* Adding or removing is only offered while the request is still
                 taking offers. The API refuses it after that anyway — the
                 merchants priced against these files — but a control that
                 will be refused should not be there to press. */
              canEdit={isOwner && ['open', 'receiving_offers', 'draft'].includes(current.state)}
              onChanged={() => {
                loadFiles();
                // A change to a published job makes standing offers stale.
                load();
              }}
            />
          </div>
        )}

        {canOffer && !alreadyOffered && (
          <button
            onClick={() => setOffering(true)}
            className="w-full min-h-[48px] rounded-2xl bg-olive text-white font-bold text-[14px] flex items-center justify-center gap-2 mb-4"
          >
            <Send className="w-4 h-4" />
            {loc('قدّم عرضًا', 'Submit an offer', 'ئۆفەر پێشکەش بکە')}
          </button>
        )}

        {offering && (
          <OfferForm
            requestId={current.id}
            onDone={() => {
              setOffering(false);
              load();
            }}
            onCancel={() => setOffering(false)}
          />
        )}

        {/* A draft cannot be offered on, so there is no "no offers yet" to
            wait for — the draft card above already says what happens next. */}
        {current.state !== 'draft' && (
          <>
            <h2 className="text-gold font-bold text-[13px] mb-3">
              {isCustomer
                ? loc('العروض المقدّمة', 'Offers received', 'ئۆفەرە وەرگیراوەکان')
                : loc('عرضك', 'Your offer', 'ئۆفەرەکەت')}
            </h2>

            {offers === null ? (
              <div className="py-8 flex justify-center">
                <Loader2 className="w-5 h-5 text-gold animate-spin" />
              </div>
            ) : !offers.length ? (
              <p className="text-zinc-500 text-[12.5px] py-6 text-center">
                {loc('لا توجد عروض بعد', 'No offers yet', 'هێشتا ئۆفەر نییە')}
              </p>
            ) : (
              <div className="space-y-3">
                {offers.map((o) => (
                  <OfferCard
                    key={o.id}
                    offer={o}
                    mine={!isCustomer}
                    canAccept={isCustomer && o.state === 'pending' && !o.stale && open}
                    onAccept={() => setAccepting(o)}
                    onChanged={load}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <AcceptOfferSheet
        offer={accepting}
        onClose={() => setAccepting(null)}
        onAccepted={() => {
          setAccepting(null);
          load();
          loadFiles();
        }}
      />

      <ConfirmSheet
        open={discardOpen}
        testId="discard-draft"
        tone="danger"
        // OWNER: Sorani to be written by hand.
        title={loc('إلغاء هذه المسودة؟', 'Discard this draft?')}
        confirmLabel={loc('إلغاء المسودة', 'Discard draft')}
        busyLabel={loc('جارٍ الإلغاء…', 'Discarding…')}
        busy={discarding}
        error={discardError}
        onConfirm={discardDraft}
        onClose={() => setDiscardOpen(false)}
      >
        {/* OWNER: Sorani to be written by hand. */}
        {loc(
          'لن يُنشر هذا الطلب. يبقى في «طلباتي» ملغى، مع ملفاته.',
          'This request will not be published. It stays in “My requests” as cancelled, with its files.'
        )}
      </ConfirmSheet>
    </div>
  );
}

/**
 * ACCEPTING MOVES MONEY, AND ONLY FOR THE OFFER ON SCREEN.
 *
 * The sheet shows the price and the promise, says the money is HELD rather
 * than paid, and sends back exactly the version it showed (`revision` and
 * `price_iqd`). If the merchant changed the offer in the meantime the server
 * answers `OFFER_CHANGED` with the fresh offer — the sheet then shows THAT,
 * says it changed, and the next tap accepts the new terms knowingly. A
 * customer whose wallet cannot cover it is told so here, with the way to fix it.
 */
function AcceptOfferSheet({
  offer,
  onClose,
  onAccepted,
}: {
  offer: OfferRow | null;
  onClose: () => void;
  onAccepted: () => void;
}) {
  const { loc, lang } = useLanguage();
  const [shown, setShown] = useState<OfferRow | null>(offer);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [needsTopUp, setNeedsTopUp] = useState(false);

  useEffect(() => {
    if (!offer) return;
    setShown(offer);
    setChanged(false);
    setError('');
    setNeedsTopUp(false);
    setBusy(false);
  }, [offer]);

  const o = shown;

  async function confirm() {
    if (!o || busy) return;
    setBusy(true);
    setError('');
    setNeedsTopUp(false);
    try {
      await api.post(`/api/marketplace/offers/${o.id}/accept`, {
        expected_price_iqd: o.price_iqd,
        offer_revision: o.revision,
      });
      onAccepted();
    } catch (e) {
      const fresh = e instanceof ApiError && e.code === 'OFFER_CHANGED' ? (e.details?.offer as OfferRow | undefined) : undefined;
      if (fresh) {
        setShown(fresh);
        setChanged(true);
      } else {
        setError(apiRefusal(e, asLang(lang), loc('تعذّر قبول العرض', 'Could not accept the offer', 'نەتوانرا ئۆفەرەکە پەسەند بکرێت')));
        setNeedsTopUp(e instanceof ApiError && e.code === 'INSUFFICIENT_FUNDS');
      }
      setBusy(false);
    }
  }

  return (
    <ConfirmSheet
      open={!!offer}
      testId="accept-offer"
      // OWNER: Sorani to be written by hand.
      title={loc('قبول هذا العرض؟', 'Accept this offer?')}
      confirmLabel={loc('اقبل العرض', 'Accept offer', 'ئۆفەر پەسەند بکە')}
      // OWNER: Sorani to be written by hand.
      busyLabel={loc('جارٍ حجز المبلغ…', 'Holding the money…')}
      busy={busy}
      error={error}
      onConfirm={confirm}
      onClose={onClose}
      footer={
        needsTopUp ? (
          <Link
            to="/wallet"
            className="mb-1 inline-flex min-h-[44px] items-center text-gold text-[13px] font-semibold underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] rounded"
          >
            {loc('اشحن المحفظة', 'Top up the wallet', 'جزدان پڕ بکەرەوە')}
          </Link>
        ) : null
      }
    >
      {o && (
        <>
          {changed && (
            <p
              role="status"
              className="mb-3 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-amber-200 text-[12.5px]"
              data-accept="changed"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
              {/* OWNER: Sorani to be written by hand. */}
              {loc(
                'غيّر التاجر هذا العرض بعد أن فتحته — هذه شروطه الآن.',
                'The merchant changed this offer after you opened it — these are its terms now.'
              )}
            </p>
          )}
          <div className="mb-3 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-white text-[13.5px] font-semibold">{o.merchant?.name ?? '—'}</span>
              <span className="shrink-0 text-gold font-bold text-[15px] tabular-nums" dir="ltr" data-accept="price">
                {iqd(o.price_iqd)}
              </span>
            </div>
            {o.completion_days > 0 && (
              <p className="mt-1 flex items-center gap-1.5 text-zinc-400 text-[12px]">
                <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                {loc(`خلال ${o.completion_days} يوم`, `In ${o.completion_days} days`, `لە ${o.completion_days} ڕۆژدا`)}
              </p>
            )}
          </div>
          {loc(
            `سيُحجز ${iqd(o.price_iqd)} من رصيدك الآن — لن يُدفع للتاجر إلا بعد تأكيدك للاستلام. متابعة؟`,
            `${iqd(o.price_iqd)} will be HELD from your balance now — the merchant is only paid after you confirm delivery. Continue?`,
            `${iqd(o.price_iqd)} لە باڵانسەکەت دەگیرێت — تەنها دوای پشتڕاستکردنەوەی وەرگرتن پارە دەدرێت بە بازرگان. بەردەوام بیت؟`
          )}
        </>
      )}
    </ConfirmSheet>
  );
}

function OfferCard({
  offer,
  mine,
  canAccept,
  onAccept,
  onChanged,
}: {
  offer: OfferRow;
  /** The viewer is the merchant who made it (a merchant only ever sees their own). */
  mine: boolean;
  canAccept: boolean;
  onAccept: () => void;
  onChanged: () => void;
}) {
  const { loc, lang } = useLanguage();
  const m = offer.merchant;
  const [busy, setBusy] = useState<'' | 'reconfirm' | 'withdraw'>('');
  const [error, setError] = useState('');
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const pending = offer.state === 'pending';

  async function reconfirm() {
    setBusy('reconfirm');
    setError('');
    try {
      await api.post(`/api/marketplace/offers/${offer.id}/reconfirm`);
      onChanged();
    } catch (e) {
      setError(apiRefusal(e, asLang(lang), loc('تعذّر تأكيد العرض', 'Could not re-confirm the offer')));
    } finally {
      setBusy('');
    }
  }

  async function withdraw() {
    setBusy('withdraw');
    setError('');
    try {
      await api.post(`/api/marketplace/offers/${offer.id}/withdraw`);
      setWithdrawOpen(false);
      onChanged();
    } catch (e) {
      setError(apiRefusal(e, asLang(lang), loc('تعذّر سحب العرض', 'Could not withdraw the offer')));
    } finally {
      setBusy('');
    }
  }

  return (
    <div
      className={`rounded-2xl border p-4 ${
        offer.state === 'accepted' ? 'border-emerald-500/40 bg-emerald-500/[0.06]' : 'border-white/10 bg-white/[0.03]'
      }`}
      data-offer={offer.id}
      data-offer-stale={offer.stale ? 'true' : undefined}
    >
      <div className="flex items-start justify-between gap-3 mb-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-white font-semibold text-[13.5px] truncate">{m?.name ?? '—'}</span>
            {m?.verified && <BadgeCheck className="w-3.5 h-3.5 text-gold shrink-0" />}
            {m?.pro_badge && <ProMerchantBadge compact />}
          </div>
          {/* Reputation, so a customer can compare on more than price (§27). */}
          <div className="flex items-center gap-2 mt-0.5 text-[11.5px] text-zinc-500">
            {m && <span className="text-gold/80">{badgeLabel(m.badge, loc)}</span>}
            {m?.rating !== null && m?.rating !== undefined && (
              <span className="flex items-center gap-0.5">
                <Star className="w-3 h-3 text-gold fill-gold" />
                {m.rating.toFixed(1)} ({m.rating_count})
              </span>
            )}
            {!!m?.completed_orders && (
              <span>{loc(`${m.completed_orders} طلب`, `${m.completed_orders} orders`, `${m.completed_orders} داواکاری`)}</span>
            )}
          </div>
        </div>
        <span className="text-gold font-bold text-[15px] shrink-0 tabular-nums" dir="ltr">{iqd(offer.price_iqd)}</span>
      </div>

      {offer.completion_days > 0 && (
        <div className="flex items-center gap-1.5 text-zinc-400 text-[12px] mb-2">
          <Clock className="w-3.5 h-3.5" />
          {loc(`خلال ${offer.completion_days} يوم`, `In ${offer.completion_days} days`, `لە ${offer.completion_days} ڕۆژدا`)}
        </div>
      )}

      {offer.message && (
        <p dir="auto" className="text-zinc-300 text-[12.5px] leading-relaxed mb-2 break-words">
          {offer.message}
        </p>
      )}
      {offer.warranty_terms && (
        <div className="flex items-start gap-1.5 text-zinc-400 text-[11.5px] mb-2">
          <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span dir="auto" className="min-w-0 break-words">
            {offer.warranty_terms}
          </span>
        </div>
      )}

      {pending && offer.stale && (
        <p
          className="mt-2 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-amber-200 text-[12px] leading-relaxed"
          data-offer-note="stale"
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          {/* OWNER: Sorani to be written by hand. */}
          {mine
            ? loc(
                'عدّل العميل الطلب بعد عرضك. أكّد عرضك للطلب بصيغته الحالية أو اسحبه — لا يمكن قبوله قبل ذلك.',
                'The customer changed the request after your offer. Re-confirm it for the request as it is now, or withdraw it — it cannot be accepted until you do.'
              )
            : loc(
                'عدّلتَ الطلب بعد هذا العرض، فهو بانتظار أن يؤكده التاجر من جديد.',
                'You changed the request after this offer was made, so it is waiting for the merchant to re-confirm it.'
              )}
        </p>
      )}

      <p role="alert" aria-live="polite" className="text-red-400 text-[12px] mt-2 empty:hidden">
        {error}
      </p>

      <div className="flex gap-2 mt-3">
        {m?.store_slug && !mine && (
          <CommunityStoreLink
            id={m.store_slug}
            className="flex-1 min-h-[40px] rounded-xl border border-white/10 bg-white/[0.03] text-zinc-300 text-[12px] font-semibold flex items-center justify-center"
          >
            {loc('زيارة المتجر', 'View store', 'بینینی فرۆشگا')}
          </CommunityStoreLink>
        )}
        {canAccept && (
          <button
            type="button"
            onClick={onAccept}
            data-offer-accept={offer.id}
            className="flex-1 min-h-[40px] rounded-xl bg-olive text-white text-[12px] font-bold flex items-center justify-center gap-1.5 hover:brightness-110 transition-[filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            {loc('اقبل العرض', 'Accept offer', 'ئۆفەر پەسەند بکە')}
          </button>
        )}
        {mine && pending && (
          <>
            <button
              type="button"
              onClick={() => {
                setError('');
                setWithdrawOpen(true);
              }}
              disabled={!!busy}
              className="flex-1 min-h-[40px] rounded-xl border border-zinc-700 text-zinc-200 text-[12px] font-bold hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] disabled:opacity-50"
            >
              {/* OWNER: Sorani to be written by hand. */}
              {loc('سحب العرض', 'Withdraw offer')}
            </button>
            {offer.stale && (
              <button
                type="button"
                onClick={reconfirm}
                disabled={!!busy}
                data-offer-reconfirm={offer.id}
                className="flex-1 min-h-[40px] rounded-xl bg-olive text-white text-[12px] font-bold inline-flex items-center justify-center gap-1.5 hover:brightness-110 transition-[filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-60"
              >
                {busy === 'reconfirm' && <Spinner size="sm" delayMs={0} decorative className="text-white" />}
                {/* OWNER: Sorani to be written by hand. */}
                {loc('أؤكد عرضي', 'Re-confirm offer')}
              </button>
            )}
          </>
        )}
        {offer.state === 'accepted' && (
          <span className="flex-1 min-h-[40px] rounded-xl bg-emerald-500/10 text-emerald-400 text-[12px] font-bold flex items-center justify-center">
            {loc('مقبول', 'Accepted', 'پەسەندکراو')}
          </span>
        )}
      </div>

      {mine && (
        <ConfirmSheet
          open={withdrawOpen}
          testId="withdraw-offer"
          tone="danger"
          // OWNER: Sorani to be written by hand.
          title={loc('سحب هذا العرض؟', 'Withdraw this offer?')}
          confirmLabel={loc('سحب العرض', 'Withdraw offer')}
          busyLabel={loc('جارٍ السحب…', 'Withdrawing…')}
          busy={busy === 'withdraw'}
          error={error}
          onConfirm={withdraw}
          onClose={() => setWithdrawOpen(false)}
        >
          {/* OWNER: Sorani to be written by hand. */}
          {loc(
            'لن يستطيع العميل قبوله بعد الآن. يمكنك تقديم عرض جديد ما دام الطلب يستقبل العروض.',
            'The customer will no longer be able to accept it. You can make a new offer while the request is still taking offers.'
          )}
        </ConfirmSheet>
      )}
    </div>
  );
}

function OfferForm({
  requestId,
  onDone,
  onCancel,
}: {
  requestId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { loc, lang } = useLanguage();
  const [f, setF] = useState({ price_iqd: '', completion_days: '', message: '', warranty_terms: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setSaving(true);
    setError('');
    try {
      await api.post(`/api/marketplace/requests/${requestId}/offers`, {
        price_iqd: Number(f.price_iqd),
        completion_days: Number(f.completion_days) || 0,
        message: f.message,
        warranty_terms: f.warranty_terms,
      });
      onDone();
    } catch (e) {
      setError(apiRefusal(e, asLang(lang), loc('تعذّر الإرسال', 'Could not submit', 'نەتوانرا بنێردرێت')));
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-4 mb-4">
      <div className="flex items-center justify-between">
        <h3 className="text-gold font-bold text-[13px]">{loc('عرضك', 'Your offer', 'ئۆفەرەکەت')}</h3>
        <button
          type="button"
          onClick={onCancel}
          aria-label={loc('إغلاق', 'Close', 'داخستن')}
          className="text-zinc-500 min-h-[44px] min-w-[44px] -me-3 inline-flex items-center justify-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      <F label={loc('السعر (د.ع)', 'Price (IQD)', 'نرخ')} required>
        <input
          type="number"
          value={f.price_iqd}
          onChange={(e) => setF({ ...f, price_iqd: e.target.value })}
          className="w-full min-h-[48px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40"
        />
      </F>
      <F label={loc('مدة التنفيذ (أيام)', 'Completion (days)', 'ماوەی تەواوکردن')}>
        <input
          type="number"
          value={f.completion_days}
          onChange={(e) => setF({ ...f, completion_days: e.target.value })}
          className="w-full min-h-[48px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40"
        />
      </F>
      <F label={loc('رسالة للعميل', 'Message to the customer', 'نامە بۆ کڕیار')}>
        <textarea
          value={f.message}
          onChange={(e) => setF({ ...f, message: e.target.value })}
          rows={3}
          className="w-full rounded-2xl bg-black/40 border border-white/10 px-4 py-3 text-white text-[14px] outline-none focus:border-gold/40 resize-none"
        />
      </F>
      <F label={loc('الضمان (اختياري)', 'Warranty (optional)', 'گەرەنتی')}>
        <input
          value={f.warranty_terms}
          onChange={(e) => setF({ ...f, warranty_terms: e.target.value })}
          className="w-full min-h-[48px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40"
        />
      </F>

      {error && <p className="text-red-400 text-[12.5px]">{error}</p>}

      <p className="text-zinc-600 text-[11.5px] leading-relaxed">
        {loc(
          'بعد قبول العميل لعرضك، لا يمكن تغيير السعر أو المدة.',
          'Once the customer accepts, the price and timeline cannot be changed.',
          'دوای پەسەندکردنی کڕیار، نرخ و ماوە ناگۆڕدرێن.'
        )}
      </p>

      <button
        onClick={submit}
        disabled={saving || !f.price_iqd}
        className="w-full min-h-[48px] rounded-2xl bg-olive text-white font-bold text-[14px] flex items-center justify-center gap-2 disabled:opacity-40"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        {loc('أرسل العرض', 'Send offer', 'ئۆفەر بنێرە')}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ bits

function F({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-zinc-400 text-[12.5px] font-semibold mb-2">
        {label}
        {required && <span className="text-gold ms-1">*</span>}
      </label>
      {children}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-black/30 border border-white/5 px-3 py-2">
      <p className="text-zinc-600 text-[10.5px] mb-0.5">{label}</p>
      <p className="text-zinc-200 text-[12px] font-semibold" dir="auto">{value}</p>
    </div>
  );
}

function StateChip({ state }: { state: string }) {
  const { loc } = useLanguage();
  const map: Record<string, string> = {
    draft: 'bg-zinc-500/10 text-zinc-300 border-zinc-500/20',
    open: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    receiving_offers: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    offer_selected: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
    in_progress: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
    delivered: 'bg-purple-500/10 text-purple-300 border-purple-500/20',
    completed: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    disputed: 'bg-red-500/10 text-red-300 border-red-500/20',
    cancelled: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
    expired: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  };
  const label: Record<string, string> = {
    // The Sorani is the hand-written one AdminMystery.tsx already carries.
    draft: loc('مسودة', 'Draft', 'ڕەشنووس'),
    open: loc('مفتوح', 'Open', 'کراوە'),
    receiving_offers: loc('يستقبل عروضًا', 'Receiving offers', 'ئۆفەر وەردەگرێت'),
    offer_selected: loc('تم اختيار عرض', 'Offer selected', 'ئۆفەر هەڵبژێردرا'),
    in_progress: loc('قيد التنفيذ', 'In progress', 'لە جێبەجێکردندا'),
    delivered: loc('تم التسليم', 'Delivered', 'گەیشت'),
    completed: loc('مكتمل', 'Completed', 'تەواو'),
    disputed: loc('نزاع', 'Disputed', 'ناکۆکی'),
    cancelled: loc('ملغي', 'Cancelled', 'هەڵوەشێنراوە'),
    expired: loc('منتهٍ', 'Expired', 'بەسەرچوو'),
  };
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${map[state] ?? map.open}`}>
      {label[state] ?? state}
    </span>
  );
}

/**
 * The customer's funded custom orders — the half of the escrow lifecycle
 * that belongs to the buyer. Confirming receipt releases the merchant's money
 * (§33), and so does the auto-confirm date shown under it — a real date now,
 * kept by the server's sweep, not a promise nothing read. Every action is
 * confirmed in a sheet that says what it does, and a refusal is answered in
 * that sheet in the reader's language.
 */
type OrderAction = { kind: 'confirm' | 'cancel' | 'dispute'; order: CommunityOrderRow };

function MyCommunityOrders({ whileClosed = false }: { whileClosed?: boolean } = {}) {
  const { loc, lang } = useLanguage();
  const [orders, setOrders] = useState<CommunityOrderRow[] | null>(null);
  const [action, setAction] = useState<OrderAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [description, setDescription] = useState('');

  const load = useCallback(() => {
    communityOrdersApi
      .list()
      .then((d) => setOrders(d.orders.filter((o) => o.role === 'customer')))
      .catch(() => setOrders([]));
  }, []);
  useEffect(load, [load]);

  const begin = (kind: OrderAction['kind'], order: CommunityOrderRow) => {
    setError('');
    setDescription('');
    setAction({ kind, order });
  };

  async function run() {
    if (!action || busy) return;
    setBusy(true);
    setError('');
    try {
      if (action.kind === 'confirm') await communityOrdersApi.confirm(action.order.id);
      else if (action.kind === 'cancel') await communityOrdersApi.cancel(action.order.id);
      else await communityOrdersApi.dispute(action.order.id, description.trim());
      setAction(null);
      load();
    } catch (e) {
      setError(apiRefusal(e, asLang(lang), loc('تعذّر إتمام العملية', 'Could not complete that', 'نەتوانرا تەواو بکرێت')));
    } finally {
      setBusy(false);
    }
  }

  // Under the maintenance card there is nothing to wait for and nothing to
  // say when this customer has no running order — only the orders themselves.
  if (whileClosed && (orders === null || !orders.length)) return null;

  if (orders === null) {
    return (
      <div className="py-12 flex justify-center">
        <Loader2 className="w-5 h-5 text-gold animate-spin" />
      </div>
    );
  }

  if (!orders.length) {
    return (
      <div className="py-12 text-center">
        <p className="text-zinc-400 text-[13px]">
          {loc('لا توجد طلبات قيد التنفيذ', 'No custom orders in progress', 'هیچ داواکاریەکی تایبەت نییە')}
        </p>
        <p className="text-zinc-600 text-[11.5px] mt-1.5">
          {loc(
            'عندما تقبل عرض تاجر على طلبك، يظهر تنفيذه هنا خطوة بخطوة.',
            'When you accept a merchant’s offer, its progress shows here step by step.',
            'کاتێک ئۆفەرێک قبوڵ دەکەیت لێرە دەردەکەوێت.'
          )}
        </p>
      </div>
    );
  }

  const stateLabel = (s: string) =>
    s === 'funded'
      ? loc('مموّل — التاجر سيبدأ قريبًا', 'Funded — the merchant will start soon', 'پارە دراوە')
      : s === 'in_progress'
        ? loc('قيد التنفيذ', 'In progress', 'جێبەجێ دەکرێت')
        : s === 'merchant_marked_delivered'
          ? loc('التاجر سلّم — بانتظار تأكيدك', 'Delivered — awaiting your confirmation', 'چاوەڕوانی پشتڕاستکردنەوەتە')
          : s === 'completed'
            ? loc('مكتمل', 'Completed', 'تەواو')
            : s === 'disputed'
              ? loc('نزاع — بيد Levonis', 'Disputed — with Levonis', 'ناکۆکی')
              : s === 'cancelled'
                ? loc('ملغي ومسترجع', 'Cancelled and refunded', 'هەڵوەشێنراوە')
                : s === 'refunded'
                  ? // OWNER: Sorani to be written by hand.
                    loc('مسترجع بقرار Levonis', 'Refunded by Levonis')
                  : s;

  const disputeReady = description.trim().length >= 10;

  return (
    <div className="space-y-3">
      {whileClosed && (
        <h2 className="text-gold font-bold text-[14px]">{loc('تنفيذ طلباتي', 'My custom orders', 'داواکاریە تایبەتەکانم')}</h2>
      )}
      {orders.map((o) => (
        <div key={o.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5" data-community-order={o.id}>
          {/* The state can be a long phrase ("Delivered — awaiting your
              confirmation"); rather than squeeze the title to an ellipsis it
              moves under the title when both do not fit. */}
          <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1 mb-1.5">
            <p className="text-white text-[13px] font-semibold flex-1 basis-32 min-w-0 line-clamp-2 break-words">
              <bdi>{o.request_title}</bdi>
            </p>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-white/10 bg-white/[0.04] text-zinc-300 shrink-0">
              {stateLabel(o.state)}
            </span>
          </div>
          <p className="text-zinc-500 text-[11.5px] mb-2">
            {o.merchant_name} · <span className="text-white font-semibold tabular-nums" dir="ltr">{iqd(o.price_iqd)}</span>
            {' '}
            {loc('(محجوز لدى Levonis)', '(held by Levonis)', '(لای LEVONIS پارێزراوە)')}
          </p>

          {o.state === 'merchant_marked_delivered' && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => begin('confirm', o)}
                data-community-order-confirm={o.id}
                className="w-full min-h-[44px] rounded-xl bg-olive text-white font-bold text-[13px] hover:brightness-110 transition-[filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                {loc('استلمت العمل — حوّل المبلغ للتاجر', 'I received it — release the funds', 'وەرمگرت — پارەکە بدە')}
              </button>
              {o.auto_complete_at && (
                <p className="text-zinc-600 text-[10.5px] text-center">
                  {loc('يتأكد تلقائيًا في', 'Auto-confirms on', 'خۆکارانە لە')}{' '}
                  <span className="tabular-nums">{formatDate(o.auto_complete_at, lang)}</span>
                </p>
              )}
            </div>
          )}

          {(o.state === 'funded' || o.state === 'in_progress' || o.state === 'merchant_marked_delivered') && (
            <div className="flex gap-2 mt-2">
              {o.state === 'funded' && (
                <button
                  type="button"
                  onClick={() => begin('cancel', o)}
                  className="flex-1 min-h-[40px] rounded-xl border border-red-500/30 bg-red-500/10 text-red-300 text-[11.5px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
                >
                  {loc('إلغاء واسترجاع', 'Cancel & refund', 'هەڵوەشاندنەوە')}
                </button>
              )}
              <button
                type="button"
                onClick={() => begin('dispute', o)}
                className="flex-1 min-h-[40px] rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300 text-[11.5px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
              >
                {loc('فتح نزاع', 'Open a dispute', 'ناکۆکی تۆمار بکە')}
              </button>
            </div>
          )}
        </div>
      ))}

      <ConfirmSheet
        open={action?.kind === 'confirm'}
        testId="confirm-receipt"
        title={loc('هل استلمت العمل فعلًا؟', 'Did you actually receive the work?', 'کارەکەت وەرگرت؟')}
        confirmLabel={loc('تأكيد الاستلام', 'Confirm receipt', 'پشتڕاستکردنەوەی وەرگرتن')}
        // OWNER: Sorani to be written by hand.
        busyLabel={loc('جارٍ التحويل…', 'Releasing…')}
        busy={busy}
        error={error}
        onConfirm={run}
        onClose={() => setAction(null)}
      >
        {loc(
          'التأكيد يحوّل المبلغ للتاجر ولا يمكن التراجع عنه.',
          'Confirming releases the money to the merchant and cannot be undone.',
          'پشتڕاستکردنەوە پارەکە دەداتە بازرگان.'
        )}
      </ConfirmSheet>

      <ConfirmSheet
        open={action?.kind === 'cancel'}
        testId="cancel-community-order"
        tone="danger"
        title={loc('إلغاء الطلب واسترجاع المبلغ كاملًا؟', 'Cancel and get a full refund?', 'هەڵوەشاندنەوە و گەڕاندنەوەی پارە؟')}
        confirmLabel={loc('إلغاء واسترجاع', 'Cancel & refund', 'هەڵوەشاندنەوە')}
        busyLabel={loc('جارٍ الإلغاء…', 'Cancelling…', 'هەڵوەشاندنەوە…')}
        busy={busy}
        error={error}
        onConfirm={run}
        onClose={() => setAction(null)}
      >
        {/* OWNER: Sorani to be written by hand. */}
        {loc(
          'يُلغى التنفيذ قبل أن يبدأ التاجر، ويعود المبلغ المحجوز إلى رصيدك.',
          'The order is cancelled before the merchant starts, and the held money returns to your balance.'
        )}
      </ConfirmSheet>

      <ConfirmSheet
        open={action?.kind === 'dispute'}
        testId="open-dispute"
        title={loc('فتح نزاع', 'Open a dispute', 'ناکۆکی تۆمار بکە')}
        confirmLabel={loc('فتح نزاع', 'Open a dispute', 'ناکۆکی تۆمار بکە')}
        // OWNER: Sorani to be written by hand.
        busyLabel={loc('جارٍ الإرسال…', 'Sending…')}
        busy={busy}
        error={error}
        confirmDisabled={!disputeReady}
        onConfirm={run}
        onClose={() => setAction(null)}
      >
        <label htmlFor="community-dispute-description" className="block">
          {loc(
            'صف المشكلة (١٠ أحرف على الأقل). سيُجمّد المبلغ حتى تفصل إدارة Levonis.',
            'Describe the problem (at least 10 characters). The money freezes until Levonis decides.',
            'کێشەکە باس بکە.'
          )}
        </label>
        <textarea
          id="community-dispute-description"
          name="dispute-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          maxLength={4000}
          autoComplete="off"
          className="mt-2 w-full rounded-xl bg-black/40 border border-white/10 px-3.5 py-3 text-white text-[14px] leading-relaxed outline-none focus-visible:border-gold/40 focus-visible:ring-2 focus-visible:ring-[#BAA369]/40 resize-none"
        />
        <p className="mt-1 text-zinc-600 text-[11px] tabular-nums" dir="ltr" aria-live="polite">
          {description.trim().length} / 10+
        </p>
      </ConfirmSheet>
    </div>
  );
}

/**
 * WHAT /requests STILL SHOWS WHILE LEVO COMMUNITY IS SHUT.
 *
 * The board, new requests and new offers close with the community (owner,
 * 2026-09-23 — docs/DECISIONS.md), but a customer whose money is already held
 * in escrow must still be able to confirm the delivery, or cancel, from the
 * one screen that has those buttons. So the maintenance card on this route
 * carries the running orders underneath it — the /api/marketplace/orders
 * routes they call are deliberately outside the wall.
 */
export function RunningCommunityOrders() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 pb-28" data-requests="running-orders">
      <PendingOffersWhileClosed />
      <MyCommunityOrders whileClosed />
    </div>
  );
}

/**
 * OFFERS ALREADY MADE ON THIS CUSTOMER'S OWN REQUESTS. No new offer can be made
 * while the community is shut, but one that arrived before it closed is trade
 * in flight: the customer can still read it and accept it (the offers list
 * and `/offers/:id/accept` stay outside the wall — DECISIONS 110). Only the
 * customer's own requests that are receiving offers are listed; there is no
 * board here.
 */
function PendingOffersWhileClosed() {
  const { loc } = useLanguage();
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [open, setOpen] = useState<RequestRow | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .get<{ requests: RequestRow[] }>('/api/marketplace/my-requests')
      .then((d) => {
        if (alive) setRows((d.requests ?? []).filter((r) => r.state === 'receiving_offers' && r.offer_count > 0));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (open) return <RequestDetail request={open} me={null} onBack={() => setOpen(null)} />;
  if (!rows.length) return null;
  return (
    <div className="space-y-2 mb-4" data-requests="pending-offers">
      {rows.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => setOpen(r)}
          className="w-full text-start rounded-2xl border border-white/10 bg-white/[0.03] p-4 min-h-[44px] active:scale-[0.99] transition-transform"
        >
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-white font-semibold text-[14px] leading-snug">{r.title}</h3>
            <span className="shrink-0 text-gold/80 font-semibold text-[11.5px]">
              {loc(`${r.offer_count} عرض`, `${r.offer_count} offers`, `${r.offer_count} ئۆفەر`)}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}
