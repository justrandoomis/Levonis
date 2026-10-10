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

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Loader2, PackageSearch, MapPin, Search, X } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { useSignInPrompt } from '../lib/guest';
import { api } from '../lib/api';
import { iqd, merchantApi, communityOrdersApi, type MerchantMe, type CommunityOrderRow } from '../lib/merchant';
import { GOVERNORATE_LABELS } from '../lib/governorates';
import MyRequestsList from '../components/print/MyRequestsList';
/**
 * PRINT REQUESTS v2 (stream W5-A): the four-step wizard with drafts. The
 * offers — compared by the customer, composed by the merchant — live on the
 * request's own page now (src/pages/community/Request.tsx, Client 5c).
 */
import RequestWizard from '../components/community/requests/RequestWizard';
import { requestsApi, type CatalogMaterial } from '../components/community/requests/api';
import { requestPath, requestRedirect, requestStateLabel, requestStateTone } from '../components/community/requests/requestStates';
import { CommunityLoadError } from './community/access';
import PendingStoreReviews from '../components/community/reviews/StoreReviews';
import OrderContactCard from '../components/community/offers/OrderContactCard';
/**
 * ELIGIBILITY AS DATA (stream W5-B): «مناسب لي» — the requests this workshop
 * can make, by the server's own verdict. The workshop's verdict on ONE
 * request, with its private costing, is on the request's page.
 */
import RequestBoard from '../components/merchant/workshop/RequestBoard';
import { Segmented } from '../components/ui/Segmented';
import { StatusChip } from '../components/ui/Badge';
import FilterChip from '../components/community/FilterChip';
import { merchantHref } from '../lib/merchantRoutes';
import ConfirmSheet from '../components/print/ConfirmSheet';
import { apiRefusal } from '../lib/refusalStrings';
import { asLang, formatDate } from '../components/orders/format';
import { offersLabel } from '../components/community/hub/copy';
/**
 * THE ORDER'S TIMELINE (Phase 5d, §9.5 «Customer order view»): the merged
 * record of a running order and «اطلب تعديلًا», in a sheet opened from the
 * order's row — a lazy chunk, downloaded on the first tap.
 */
import { lazy, Suspense } from 'react';
import { Sheet } from '../components/ui/Sheet';
import { useTimelineStrings } from '../components/community/requests/timelineStrings';
const OrderTimeline = lazy(() => import('../components/community/requests/OrderTimeline'));

/**
 * THE REQUEST'S OWN SCREEN, for the one place this page still shows it: the
 * offers that arrived before the community shut, under the maintenance card
 * (PendingOffersWhileClosed). A lazy chunk — the route file's own.
 */
const RequestDetail = lazy(() => import('./community/Request').then((m) => ({ default: m.RequestDetail })));

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
  /** Notes the customer wrote for the merchants (0130). */
  customer_notes?: string;
  revision?: number;
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
  /**
   * A SECTION NAMED IN THE ADDRESS — `?view=new|mine|orders`, what the
   * community page's shortcuts link to (src/pages/Community.tsx). Read once,
   * at mount, and then dropped from the URL, so a reload after closing the
   * wizard does not open it again. A guest who asks for the wizard or «تنفيذ
   * طلباتي» lands on the board; the community page sends a guest through
   * sign-in before it links here.
   */
  const [view, setView] = useState<View>(() => {
    // A carried link outranks the address: it is the wizard, with the link in it.
    const asked = carriedLink ? '' : params.get('view');
    if (asked === 'mine') return 'mine';
    if ((asked === 'new' || asked === 'orders') && user) return asked;
    return carriedLink && user ? 'new' : 'board';
  });
  useEffect(() => {
    if (!params.has('view')) return;
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.delete('view');
        return p;
      },
      { replace: true }
    );
    // Once, at mount: the section it named is already in state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [me, setMe] = useState<MerchantMe | null>(null);

  /**
   * ONE REQUEST HAS ONE ADDRESS — /requests/<id>, its own route
   * (src/pages/community/Request.tsx, Client 5c).
   *
   * Every notice, board card, chat button and costing screen written before
   * the route existed links `/requests?request=<id>` (`&cost=1` from the
   * costing screen, `#discussion` / `#timeline` from the grouped notices).
   * That address still has to land on THAT request — the notification's whole
   * purpose — so it is REPLACED by the request's own, carrying the rest of the
   * query and the hash: Back does not walk into a redirect.
   */
  const deepLinked = params.get('request') ?? '';
  const navigate = useNavigate();
  useEffect(() => {
    if (!deepLinked) return;
    navigate(requestRedirect(deepLinked, params, location.hash), { replace: true });
    // The address decides, once per id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinked]);

  // The board's own merchant read — never on the way through to /requests/<id>
  // (review 2026-09-30: an old link paid a /api/merchant/me it threw away).
  useEffect(() => {
    if (!user || deepLinked) return;
    merchantApi.me().then(setMe).catch(() => {});
  }, [user, deepLinked]);

  /** Opening a request is a step forward to its own page, so Back returns here. */
  const openRequestId = useCallback((id: string) => navigate(requestPath(id)), [navigate]);
  const openRequest = useCallback((r: RequestRow) => openRequestId(r.id), [openRequestId]);

  // On its way to /requests/<id>: nothing of the board flashes first.
  if (deepLinked) return null;

  return (
    <div className="min-h-screen text-text-secondary pb-28">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 pt-6">
        <h1 className="text-text-primary font-bold text-lg mb-1">
          {loc('طلبات العملاء', 'Customer requests', 'داواکاری کڕیاران')}
        </h1>
        <p className="text-text-muted text-[12.5px] mb-5">
          {loc(
            'اطلب شيئًا مخصصًا، واستقبل عروضًا من التجار.',
            'Ask for something custom, and receive offers from merchants.',
            'داوای شتێکی تایبەت بکە و ئۆفەر لە بازرگانەکانەوە وەربگرە.'
          )}
        </p>

        {/* The sections are filter chips (pressed when chosen, never an ink
            fill); «طلب جديد» is the page's one primary. The row scrolls
            sideways, so it pads the button's cast in rather than cutting it. */}
        <div className="flex items-center gap-1.5 mb-3 -mt-2 py-2 overflow-x-auto hide-scrollbar">
          {([['board', loc('كل الطلبات', 'All requests', 'هەموو داواکاریەکان')],
             ['mine', loc('طلباتي', 'My requests', 'داواکاریەکانم')],
             ...(user ? [['orders', loc('تنفيذ طلباتي', 'My custom orders', 'داواکاریە تایبەتەکانم')] as [View, string]] : []),
            ] as Array<[View, string]>).map(([v, label]) => (
            <FilterChip key={v} on={view === v} onClick={() => setView(v)}>
              {label}
            </FilterChip>
          ))}
          {(
            <button
              onClick={() => (user ? setView('new') : signIn())}
              className="lv-button lv-button-primary lv-button-sm ms-auto shrink-0 gap-1.5"
            >
              <Plus className="w-4 h-4" />
              {loc('طلب جديد', 'New', 'نوێ')}
            </button>
          )}
        </div>

        {view === 'new' ? (
          /* WIZARD v2 (W5-A). Four steps, a DRAFT all the way until «انشر»,
             and «احفظ كمسودة» at any point. Finishing a draft or editing a
             published request happens on the request's own page
             (src/pages/community/Request.tsx); either way it is the same
             `community_requests` row, and publishing is what notifies the
             merchants who can make it. */
          <RequestWizard
            key="new"
            initialLink={carriedLink || undefined}
            onDone={(id, how) => {
              // Back from the request lands on «طلباتي», where it now is.
              navigate('/requests?view=mine', { replace: true });
              // A request this person just PUBLISHED: its page asks about the
              // notification channels (ChannelNudge), once — never a draft.
              navigate(requestPath(id), how === 'published' ? { state: { published: true } } : undefined);
            }}
            onCancel={() => setView('board')}
          />
        ) : view === 'orders' ? (
          <MyCommunityOrders />
        ) : view === 'mine' ? (
          <MyRequestsList onOpen={openRequestId} />
        ) : (
          // A PLUS member with no store yet has no workshop: «مناسب لي» is the
          // workshop's board, and it answered them 404.
          <RequestList onOpen={openRequest} canOffer={!!me?.store && !!me?.can.offers} />
        )}
      </div>
    </div>
  );
}

/**
 * THE PUBLIC BOARD. It renders `publicRequest()`'s whitelist and nothing more.
 * The customer's own list is `MyRequestsList`, which reads an owner-scoped
 * route carrying the estimate and the chosen merchant — data this component
 * deliberately never receives.
 */
function RequestList({ onOpen, canOffer = false }: { onOpen: (r: RequestRow) => void; canOffer?: boolean }) {
  const { loc, lang } = useLanguage();
  // A workshop that can offer lands on the requests it can MAKE; the whole
  // board stays one tap away (docs/MERCHANT_PLATFORM.md §2 decision 5).
  const [scope, setScope] = useState<'mine' | 'all'>(canOffer ? 'mine' : 'all');
  useEffect(() => setScope(canOffer ? 'mine' : 'all'), [canOffer]);
  const [materials, setMaterials] = useState<CatalogMaterial[]>([]);
  useEffect(() => {
    if (!canOffer) return;
    requestsApi.catalog().then((c) => setMaterials(c.materials)).catch(() => setMaterials([]));
  }, [canOffer]);

  return (
    <>
      {canOffer && (
        <Segmented
          group="requests-scope"
          size="sm"
          className="mb-4"
          label={loc('أي الطلبات', 'Which requests')}
          value={scope}
          onChange={(id) => setScope(id as 'mine' | 'all')}
          dataAttr="data-requests-scope"
          items={[
            // OWNER: Sorani to be written by hand.
            { id: 'mine', label: loc('مناسب لي', 'Fits my workshop') },
            { id: 'all', label: loc('كل الطلبات', 'All requests', 'هەموو داواکاریەکان') },
          ]}
        />
      )}
      {scope === 'mine' && canOffer ? (
        <RequestBoard
          materials={materials}
          workshopHref={merchantHref.printers()}
          onOpen={(r) => onOpen({ ...r, customer_name: null } as unknown as RequestRow)}
        />
      ) : (
        <AllRequests onOpen={onOpen} loc={loc} lang={lang} />
      )}
    </>
  );
}

/** Every request on the public board, newest first, a page at a time. */
function AllRequests({
  onOpen,
  loc,
  lang,
}: {
  onOpen: (r: RequestRow) => void;
  loc: ReturnType<typeof useLanguage>['loc'];
  lang: ReturnType<typeof useLanguage>['lang'];
}) {
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  /** «المزيد» failed: said on the button, which stays to try again. */
  const [moreError, setMoreError] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  // Searched on the server (title and description), like the community page's
  // requests: a filter over the twenty rows on screen would miss page two.
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setQ(draft.trim().slice(0, 60)), 300);
    return () => window.clearTimeout(t);
  }, [draft]);

  const boardUrl = useCallback(
    (after?: string) => {
      const p = new URLSearchParams();
      if (q) p.set('q', q);
      if (after) p.set('cursor', after);
      const qs = p.toString();
      return `/api/marketplace/requests${qs ? `?${qs}` : ''}`;
    },
    [q]
  );

  useEffect(() => {
    let alive = true;
    setRows(null);
    setLoadError(null);
    setMoreError(false);
    api
      .get<{ requests: RequestRow[]; next_cursor: string | null }>(boardUrl())
      .then((d) => {
        if (!alive) return;
        setRows(d.requests);
        setCursor(d.next_cursor ?? null);
      })
      // A board that did not load is not «no open requests».
      .catch((e: unknown) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [attempt, boardUrl]);

  async function loadMore() {
    if (!cursor) return;
    setMore(true);
    setMoreError(false);
    try {
      const d = await api.get<{ requests: RequestRow[]; next_cursor: string | null }>(boardUrl(cursor));
      setRows((r) => [...(r ?? []), ...d.requests.filter((x) => !(r ?? []).some((y) => y.id === x.id))]);
      setCursor(d.next_cursor ?? null);
    } catch {
      // The rest of the board is still there: keep the way to it.
      setMoreError(true);
    } finally {
      setMore(false);
    }
  }

  const search = (
    <form role="search" onSubmit={(e) => e.preventDefault()} className="relative">
      <label htmlFor="requests-search" className="sr-only">
        {loc('ابحث في طلبات الطباعة', 'Search print requests')}
      </label>
      <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
      <input
        id="requests-search"
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        className="lv-input w-full rounded-full ps-10 pe-10 [&::-webkit-search-cancel-button]:appearance-none"
        value={draft}
        maxLength={60}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={loc('ابحث في طلبات الطباعة', 'Search print requests')}
        data-requests-search
      />
      {draft && (
        <button
          type="button"
          onClick={() => setDraft('')}
          aria-label={loc('مسح البحث', 'Clear search')}
          className="absolute end-1.5 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </form>
  );

  // One frame for every state, so the search box is never remounted (and
  // never loses the keyboard) while a search loads.
  let body: ReactNode = null;
  if (rows === null) {
    body = loadError ? (
      <CommunityLoadError error={loadError} onRetry={() => setAttempt((n) => n + 1)} />
    ) : (
      <div className="py-12 flex justify-center">
        <Loader2 className="w-5 h-5 text-gold animate-spin" />
      </div>
    );
  } else if (!rows.length) {
    body = (
      <div className="py-14 text-center" data-requests-empty={q ? 'search' : 'board'}>
        <PackageSearch className="w-9 h-9 text-text-muted mx-auto mb-3" />
        <p className="text-text-secondary text-[13px]">
          {q ? (
            <bdi>{loc(`لا نتائج لـ «${q}»`, `No results for “${q}”`)}</bdi>
          ) : (
            loc('لا توجد طلبات مفتوحة', 'No open requests', 'هیچ داواکارییەکی کراوە نییە')
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {search}
      {body}
      {rows?.map((r) => (
        <button
          key={r.id}
          onClick={() => onOpen(r)}
          className="lv-surface w-full text-start p-4 active:shadow-press"
        >
          <div className="flex items-start justify-between gap-3 mb-1.5">
            <h3 className="text-text-primary font-semibold text-[14px] leading-snug">{r.title}</h3>
            <StateChip state={r.state} />
          </div>
          <p className="text-text-secondary text-[12.5px] line-clamp-2 leading-relaxed mb-2.5">{r.description}</p>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-text-muted">
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
            <span className="ms-auto text-text-secondary font-semibold">
              {/* «عرضان», «5 عروض», «12 عرضًا» — not «5 عرض». */}
              {offersLabel(r.offer_count, lang)}
            </span>
          </div>
        </button>
      ))}
      {cursor && (
        <button
          type="button"
          onClick={loadMore}
          disabled={more}
          data-requests-more
          className="lv-button lv-button-secondary w-full"
        >
          {more
            ? loc('جارٍ التحميل…', 'Loading…')
            : moreError
              ? // OWNER: Sorani to be written by hand.
                loc('تعذّر التحميل — حاول مجددًا', 'Could not load — try again')
              : loc('المزيد', 'Load more')}
        </button>
      )}
    </div>
  );
}


// --------------------------------------------------------------- detail
//
// THE REQUEST'S OWN PAGE moved to its own route: src/pages/community/Request.tsx
// (`/requests/:id`, Client 5c) — header, status strip, files, details, the
// discussion, the offers, the order and its money. This page keeps the board,
// «طلباتي», «تنفيذ طلباتي», the wizard for a NEW request, and the redirect
// from the old `?request=<id>` above.

function StateChip({ state }: { state: string }) {
  const { loc } = useLanguage();
  return (
    <StatusChip tone={requestStateTone(state)} className="shrink-0">
      {requestStateLabel(state, loc)}
    </StatusChip>
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

/** The states in which the customer's payment sits in escrow. */
const HELD_STATES = ['funded', 'in_progress', 'merchant_marked_delivered', 'disputed'];

function MyCommunityOrders({ whileClosed = false }: { whileClosed?: boolean } = {}) {
  const { loc, lang } = useLanguage();
  const ts = useTimelineStrings();
  /** The order whose timeline sheet is open (Phase 5d). */
  const [timelineFor, setTimelineFor] = useState<CommunityOrderRow | null>(null);
  const [orders, setOrders] = useState<CommunityOrderRow[] | null>(null);
  /** Bumped when receipt is confirmed: the work just completed is now waiting for a rating. */
  const [reviewsKey, setReviewsKey] = useState(0);
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
      if (action.kind === 'confirm') {
        await communityOrdersApi.confirm(action.order.id);
        setReviewsKey((n) => n + 1);
      } else if (action.kind === 'cancel') await communityOrdersApi.cancel(action.order.id);
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
        {/* A list that could not be read is shown empty — a waiting rating is still asked for. */}
        <div className="text-start">
          <PendingStoreReviews kind="custom" refreshKey={reviewsKey} />
        </div>
        <p className="text-text-secondary text-[13px]">
          {loc('لا توجد طلبات قيد التنفيذ', 'No custom orders in progress', 'هیچ داواکاریەکی تایبەت نییە')}
        </p>
        <p className="text-text-muted text-[11.5px] mt-1.5">
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
      {/* Completed work waiting for the customer's rating of the workshop. */}
      <PendingStoreReviews kind="custom" refreshKey={reviewsKey} />
      {orders.map((o) => (
        <div key={o.id} className="lv-surface p-3.5" data-community-order={o.id}>
          {/* The state can be a long phrase ("Delivered — awaiting your
              confirmation"); rather than squeeze the title to an ellipsis it
              moves under the title when both do not fit. */}
          <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1 mb-1.5">
            <p className="text-text-primary text-[13px] font-semibold flex-1 basis-32 min-w-0 line-clamp-2 break-words">
              <bdi>{o.request_title}</bdi>
            </p>
            <StatusChip className="shrink-0">{stateLabel(o.state)}</StatusChip>
          </div>
          <p className="text-text-muted text-[11.5px] mb-2">
            {o.merchant_name} · <span className="text-text-primary font-semibold tabular-nums" dir="ltr">{iqd(o.price_iqd)}</span>
            {/* Held only while the work runs or is disputed: a completed order's
                money went to the merchant, a cancelled one's came back — the
                state chip says which. */}
            {HELD_STATES.includes(o.state) && (
              <> {loc('(محجوز لدى Levonis)', '(held by Levonis)', '(لای LEVONIS پارێزراوە)')}</>
            )}
          </p>

          {/* After acceptance each side has the other's contact, and the
              request's conversation (W5-A, §4.7). */}
          {HELD_STATES.includes(o.state) && (
            <details className="mb-2 group" data-community-order-contact={o.id}>
              <summary className="min-h-[44px] flex items-center cursor-pointer text-[12.5px] font-semibold text-gold rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                {loc('التواصل مع التاجر', 'Contact the merchant')}
              </summary>
              <OrderContactCard orderId={o.id} compact />
            </details>
          )}

          {/* The order's timeline and «اطلب تعديلًا» (Phase 5d), in a sheet. */}
          <button
            type="button"
            onClick={() => setTimelineFor(o)}
            data-community-order-timeline={o.id}
            className="mb-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-lg text-[12.5px] font-semibold text-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {ts.open}
          </button>

          {o.state === 'merchant_marked_delivered' && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => begin('confirm', o)}
                data-community-order-confirm={o.id}
                className="lv-button lv-button-primary w-full"
              >
                {loc('استلمت العمل — حوّل المبلغ للتاجر', 'I received it — release the funds', 'وەرمگرت — پارەکە بدە')}
              </button>
              {o.auto_complete_at && (
                <p className="text-text-muted text-[10.5px] text-center">
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
                  className="lv-button lv-button-danger lv-button-sm flex-1"
                >
                  {loc('إلغاء واسترجاع', 'Cancel & refund', 'هەڵوەشاندنەوە')}
                </button>
              )}
              <button
                type="button"
                onClick={() => begin('dispute', o)}
                className="lv-button lv-button-secondary lv-button-sm flex-1"
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
          className="lv-input mt-2 py-3 text-[14px] leading-relaxed resize-none"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          maxLength={4000}
          autoComplete="off"
        />
        <p className="mt-1 text-text-muted text-[11px] tabular-nums" dir="ltr" aria-live="polite">
          {description.trim().length} / 10+
        </p>
      </ConfirmSheet>

      {/* THE TIMELINE SHEET (Phase 5d): medium / large detents, the row's own
          confirm / cancel / dispute stay on the row — the sheet adds the
          record and the customer's «اطلب تعديلًا». */}
      <Sheet
        open={!!timelineFor}
        onClose={() => setTimelineFor(null)}
        label={ts.title}
        detents={['medium', 'large']}
        dragHandle
        testId="community-order-timeline"
        header={
          <div className="px-4 pb-2 pt-1">
            <h2 className="text-[16px] font-bold text-text-primary">{ts.title}</h2>
            {timelineFor && (
              <p dir="auto" className="truncate text-start text-[12.5px] text-text-secondary">
                {timelineFor.request_title}
              </p>
            )}
          </div>
        }
      >
        {timelineFor && (
          <div className="px-4 pb-4" data-community-order-timeline-sheet={timelineFor.id}>
            <Suspense
              fallback={
                <div className="flex justify-center py-6">
                  <Loader2 className="w-5 h-5 text-gold animate-spin" />
                </div>
              }
            >
              <OrderTimeline orderId={timelineFor.id} actions={false} onChanged={load} />
            </Suspense>
          </div>
        )}
      </Sheet>
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
  const { lang } = useLanguage();
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
  if (open) {
    return (
      <Suspense
        fallback={
          <div className="py-12 flex justify-center">
            <Loader2 className="w-5 h-5 text-gold animate-spin" />
          </div>
        }
      >
        <RequestDetail request={open} me={null} onBack={() => setOpen(null)} />
      </Suspense>
    );
  }
  if (!rows.length) return null;
  return (
    <div className="space-y-2 mb-4" data-requests="pending-offers">
      {rows.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => setOpen(r)}
          className="lv-surface w-full text-start p-4 min-h-[44px] active:shadow-press"
        >
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-text-primary font-semibold text-[14px] leading-snug">{r.title}</h3>
            <span className="shrink-0 text-gold/80 font-semibold text-[11.5px]">
              {offersLabel(r.offer_count, lang)}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}
