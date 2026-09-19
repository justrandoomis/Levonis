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
import { Link, useSearchParams } from 'react-router-dom';
import {
  Plus, Loader2, PackageSearch, Clock, MapPin, Star, BadgeCheck, ShieldCheck,
  ChevronLeft, Send, X,
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
}

interface OfferRow {
  id: string;
  price_iqd: number;
  completion_days: number;
  delivery_method: string;
  message: string;
  warranty_terms: string;
  state: string;
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
  const [view, setView] = useState<View>('board');
  const [me, setMe] = useState<MerchantMe | null>(null);
  const [open, setOpen] = useState<RequestRow | null>(null);
  const [params, setParams] = useSearchParams();
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
  const { loc } = useLanguage();
  const [offers, setOffers] = useState<OfferRow[] | null>(null);
  const [isCustomer, setIsCustomer] = useState(false);
  const [accepting, setAccepting] = useState('');
  const [error, setError] = useState('');
  const [offering, setOffering] = useState(false);
  const [files, setFiles] = useState<RequestFile[]>([]);
  const [isOwner, setIsOwner] = useState(false);

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
      .get<{ files: RequestFile[]; is_owner: boolean }>(`/api/marketplace/requests/${request.id}`)
      .then((d) => {
        setFiles(d.files ?? []);
        setIsOwner(!!d.is_owner);
      })
      .catch(() => setFiles([]));
  }, [request.id]);

  useEffect(load, [load]);
  useEffect(loadFiles, [loadFiles]);

  const canOffer = !!me?.can.offers && !isCustomer && ['open', 'receiving_offers'].includes(request.state);
  const alreadyOffered = (offers ?? []).some((o) => o.state === 'pending' || o.state === 'accepted');

  async function accept(offer: OfferRow) {
    // Money moves here. Say exactly what will happen before it does.
    const ok = window.confirm(
      loc(
        `سيُحجز ${iqd(offer.price_iqd)} من رصيدك الآن — لن يُدفع للتاجر إلا بعد تأكيدك للاستلام. متابعة؟`,
        `${iqd(offer.price_iqd)} will be HELD from your balance now — the merchant is only paid after you confirm delivery. Continue?`,
        `${iqd(offer.price_iqd)} لە باڵانسەکەت دەگیرێت — تەنها دوای پشتڕاستکردنەوەی وەرگرتن پارە دەدرێت بە بازرگان. بەردەوام بیت؟`
      )
    );
    if (!ok) return;

    setAccepting(offer.id);
    setError('');
    try {
      await api.post(`/api/marketplace/offers/${offer.id}/accept`);
      load();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : loc('تعذّر قبول العرض', 'Could not accept the offer', 'نەتوانرا ئۆفەرەکە پەسەند بکرێت')
      );
    } finally {
      setAccepting('');
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
            <h1 className="text-white font-bold text-[16px] leading-snug">{request.title}</h1>
            <StateChip state={request.state} />
          </div>
          <p className="text-zinc-300 text-[13px] leading-relaxed whitespace-pre-wrap mb-3">{request.description}</p>

          <div className="grid grid-cols-2 gap-2 text-[12px]">
            {request.budget_iqd !== null && (
              <Detail label={loc('الميزانية', 'Budget', 'بودجە')} value={iqd(request.budget_iqd)} />
            )}
            {request.quantity > 1 && (
              <Detail label={loc('الكمية', 'Quantity', 'بڕ')} value={String(request.quantity)} />
            )}
            {request.material && <Detail label={loc('المادة', 'Material', 'ماددە')} value={request.material} />}
            {request.color && <Detail label={loc('اللون', 'Colour', 'ڕەنگ')} value={request.color} />}
            {request.dimensions && (
              <Detail label={loc('الأبعاد', 'Dimensions', 'ڕەهەندەکان')} value={request.dimensions} />
            )}
            {request.deadline && (
              <Detail label={loc('الموعد', 'Deadline', 'کاتی کۆتایی')} value={request.deadline} />
            )}
          </div>
        </div>

        {/* What Levonis measured and estimated. Renders nothing at all for a
            request that carries no print row — an older one, or one whose link
            could not be measured. */}
        <PrintSummary requestId={request.id} />

        {(files.length > 0 || isOwner) && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 mb-4">
            <AttachmentList
              requestId={request.id}
              files={files}
              /* Adding or removing is only offered while the request is still
                 taking offers. The API refuses it after that anyway — the
                 merchants priced against these files — but a control that
                 will be refused should not be there to press. */
              canEdit={isOwner && ['open', 'receiving_offers', 'draft'].includes(request.state)}
              onChanged={loadFiles}
            />
          </div>
        )}

        {error && (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 mb-4">
            <p className="text-red-300 text-[12.5px]">{error}</p>
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
            requestId={request.id}
            onDone={() => {
              setOffering(false);
              load();
            }}
            onCancel={() => setOffering(false)}
          />
        )}

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
                canAccept={isCustomer && o.state === 'pending' && ['open', 'receiving_offers'].includes(request.state)}
                accepting={accepting === o.id}
                onAccept={() => accept(o)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function OfferCard({
  offer,
  canAccept,
  accepting,
  onAccept,
}: {
  offer: OfferRow;
  canAccept: boolean;
  accepting: boolean;
  onAccept: () => void;
}) {
  const { loc } = useLanguage();
  const m = offer.merchant;

  return (
    <div
      className={`rounded-2xl border p-4 ${
        offer.state === 'accepted' ? 'border-emerald-500/40 bg-emerald-500/[0.06]' : 'border-white/10 bg-white/[0.03]'
      }`}
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
        <span className="text-gold font-bold text-[15px] shrink-0" dir="ltr">{iqd(offer.price_iqd)}</span>
      </div>

      {offer.completion_days > 0 && (
        <div className="flex items-center gap-1.5 text-zinc-400 text-[12px] mb-2">
          <Clock className="w-3.5 h-3.5" />
          {loc(`خلال ${offer.completion_days} يوم`, `In ${offer.completion_days} days`, `لە ${offer.completion_days} ڕۆژدا`)}
        </div>
      )}

      {offer.message && <p className="text-zinc-300 text-[12.5px] leading-relaxed mb-2">{offer.message}</p>}
      {offer.warranty_terms && (
        <div className="flex items-start gap-1.5 text-zinc-400 text-[11.5px] mb-2">
          <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {offer.warranty_terms}
        </div>
      )}

      <div className="flex gap-2 mt-3">
        {m?.store_slug && (
          <Link
            to={`/community/store/${m.store_slug}`}
            className="flex-1 min-h-[40px] rounded-xl border border-white/10 bg-white/[0.03] text-zinc-300 text-[12px] font-semibold flex items-center justify-center"
          >
            {loc('زيارة المتجر', 'View store', 'بینینی فرۆشگا')}
          </Link>
        )}
        {canAccept && (
          <button
            onClick={onAccept}
            disabled={accepting}
            className="flex-1 min-h-[40px] rounded-xl bg-olive text-white text-[12px] font-bold flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            {accepting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {loc('اقبل العرض', 'Accept offer', 'ئۆفەر پەسەند بکە')}
          </button>
        )}
        {offer.state === 'accepted' && (
          <span className="flex-1 min-h-[40px] rounded-xl bg-emerald-500/10 text-emerald-400 text-[12px] font-bold flex items-center justify-center">
            {loc('مقبول', 'Accepted', 'پەسەندکراو')}
          </span>
        )}
      </div>
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
  const { loc } = useLanguage();
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
      setError(e instanceof ApiError ? e.message : loc('تعذّر الإرسال', 'Could not submit', 'نەتوانرا بنێردرێت'));
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-4 mb-4">
      <div className="flex items-center justify-between">
        <h3 className="text-gold font-bold text-[13px]">{loc('عرضك', 'Your offer', 'ئۆفەرەکەت')}</h3>
        <button onClick={onCancel} className="text-zinc-500">
          <X className="w-4 h-4" />
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
 * that belongs to the buyer. Confirming receipt is the ONLY thing that
 * releases the merchant's money (§33), which is why that button asks twice.
 */
function MyCommunityOrders() {
  const { loc } = useLanguage();
  const [orders, setOrders] = useState<CommunityOrderRow[] | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    communityOrdersApi
      .list()
      .then((d) => setOrders(d.orders.filter((o) => o.role === 'customer')))
      .catch(() => setOrders([]));
  }, []);
  useEffect(load, [load]);

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
              ? loc('نزاع — بيد ليفونيس', 'Disputed — with Levonis', 'ناکۆکی')
              : s === 'cancelled'
                ? loc('ملغي ومسترجع', 'Cancelled and refunded', 'هەڵوەشێنراوە')
                : s;

  return (
    <div className="space-y-3">
      {orders.map((o) => (
        <div key={o.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
          <div className="flex items-start justify-between gap-2 mb-1.5">
            <p className="text-white text-[13px] font-semibold flex-1 min-w-0 truncate">{o.request_title}</p>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-white/10 bg-white/[0.04] text-zinc-300 shrink-0">
              {stateLabel(o.state)}
            </span>
          </div>
          <p className="text-zinc-500 text-[11.5px] mb-2">
            {o.merchant_name} · <span className="text-white font-semibold" dir="ltr">{iqd(o.price_iqd)}</span>
            {' '}
            {loc('(محجوز لدى ليفونيس)', '(held by Levonis)', '(لای LEVONIS پارێزراوە)')}
          </p>

          {o.state === 'merchant_marked_delivered' && (
            <div className="space-y-2">
              <button
                disabled={busy === o.id}
                onClick={async () => {
                  if (!confirm(loc(
                    'هل استلمت العمل فعلًا؟ التأكيد يحوّل المبلغ للتاجر ولا يمكن التراجع عنه.',
                    'Did you actually receive the work? Confirming releases the money to the merchant and cannot be undone.',
                    'کارەکەت وەرگرت؟ پشتڕاستکردنەوە پارەکە دەداتە بازرگان.'
                  ))) return;
                  setBusy(o.id);
                  try {
                    await communityOrdersApi.confirm(o.id);
                    load();
                  } catch (e) {
                    if (e instanceof ApiError) alert(e.message);
                  } finally {
                    setBusy('');
                  }
                }}
                className="w-full min-h-[42px] rounded-xl bg-olive text-white font-bold text-[13px] disabled:opacity-40"
              >
                {loc('استلمت العمل — حوّل المبلغ للتاجر', 'I received it — release the funds', 'وەرمگرت — پارەکە بدە')}
              </button>
              {o.auto_complete_at && (
                <p className="text-zinc-600 text-[10.5px] text-center">
                  {loc('يتأكد تلقائيًا في', 'Auto-confirms on', 'خۆکارانە لە')} {new Date(o.auto_complete_at).toLocaleDateString()}
                </p>
              )}
            </div>
          )}

          {(o.state === 'funded' || o.state === 'in_progress' || o.state === 'merchant_marked_delivered') && (
            <div className="flex gap-2 mt-2">
              {o.state === 'funded' && (
                <button
                  disabled={busy === o.id}
                  onClick={async () => {
                    if (!confirm(loc('إلغاء الطلب واسترجاع المبلغ كاملًا؟', 'Cancel and get a full refund?', 'هەڵوەشاندنەوە و گەڕاندنەوەی پارە؟'))) return;
                    setBusy(o.id);
                    try {
                      await communityOrdersApi.cancel(o.id);
                      load();
                    } catch (e) {
                      if (e instanceof ApiError) alert(e.message);
                    } finally {
                      setBusy('');
                    }
                  }}
                  className="flex-1 min-h-[36px] rounded-xl border border-red-500/30 bg-red-500/10 text-red-300 text-[11.5px] font-bold disabled:opacity-40"
                >
                  {loc('إلغاء واسترجاع', 'Cancel & refund', 'هەڵوەشاندنەوە')}
                </button>
              )}
              <button
                disabled={busy === o.id}
                onClick={async () => {
                  const description = prompt(loc(
                    'صف المشكلة (١٠ أحرف على الأقل). سيُجمّد المبلغ حتى تفصل إدارة ليفونيس.',
                    'Describe the problem (at least 10 characters). The money freezes until Levonis decides.',
                    'کێشەکە باس بکە.'
                  ));
                  if (!description || description.trim().length < 10) return;
                  setBusy(o.id);
                  try {
                    await communityOrdersApi.dispute(o.id, description.trim());
                    load();
                  } catch (e) {
                    if (e instanceof ApiError) alert(e.message);
                  } finally {
                    setBusy('');
                  }
                }}
                className="flex-1 min-h-[36px] rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300 text-[11.5px] font-bold disabled:opacity-40"
              >
                {loc('فتح نزاع', 'Open a dispute', 'ناکۆکی تۆمار بکە')}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
