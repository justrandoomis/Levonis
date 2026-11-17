/**
 * The customer-request marketplace — /requests (community UI plan C3,
 * IMG_8468, IMG_8483, IMG_8475).
 *
 * A customer describes a job; merchants offer; the customer picks one and the
 * money is held until the work is done.
 *
 *   header   «طلبات الطباعة» with the back chevron and the one gold verb,
 *            «طلب جديد» (a guest is asked to sign in first)
 *   search   «ابحث في الطلبات», scoped to the list on screen
 *   tabs     «طلبات المجتمع | طلباتي», and «قيد التنفيذ» once the customer
 *            has a running order; the tab is in the address (`?view=mine`)
 *   filters  «الحالة», «طريقة الطباعة», «المحافظة», in the address too
 *   list     the shared request card: the public `list` card on the board,
 *            the `owner` card on «طلباتي»; the next page as the list end
 *            comes into view, «المزيد» kept for everyone else
 *
 * WHAT THIS PAGE SHOWS AND DOES NOT. The board is public, so it shows the JOB
 * — title, quantity, material, governorate — and never a phone, an email, an
 * address, a person, a picture or the budget (Q2: private by default, never on
 * the public board; plan R2, R3, R10). That is enforced by the server
 * whitelist rather than by this page choosing what to render (§24); the board
 * row type here has no budget field at all, and the card is handed only the
 * fields a public card reads.
 *
 * ACCEPTING AN OFFER MOVES MONEY, so the confirmation says so plainly: the
 * amount leaves the customer's available balance and is HELD, not paid, and
 * the merchant is only paid when the customer confirms delivery. A customer
 * who does not understand that is a customer who will open a dispute over
 * something working correctly.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Box, Loader2, PackageSearch } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { useSignInPrompt } from '../lib/guest';
import { api, ApiError } from '../lib/api';
import { iqd, merchantApi, communityOrdersApi, type MerchantMe, type CommunityOrderRow } from '../lib/merchant';
import MyRequestsList from '../components/print/MyRequestsList';
/**
 * A NEW REQUEST HAS ITS OWN ADDRESS (community UI plan B4): /requests/new,
 * the editor route (src/pages/community/RequestNew.tsx). The offers, compared
 * by the customer and composed by the merchant, live on the request own page
 * (src/pages/community/Request.tsx, Client 5c).
 */
import { requestsApi, type CatalogMaterial } from '../components/community/requests/api';
import { requestPath, requestRedirect } from '../components/community/requests/requestStates';
import { fill, useRequestStrings } from '../components/community/requests/strings';
import RequestListCard, { type PublicRequestCard } from '../components/community/requests/RequestListCard';
import BoardFilters, { PageSentinel, readBoardFilters, type BoardFilterValues } from '../components/community/requests/FilterSelect';
import SectionPageHeader from '../components/community/kit/SectionPageHeader';
import { kitButtonClass } from '../components/community/kit/buttons';
import { SegmentedTrack, UnderlineTabs } from '../components/community/kit/controls';
import { SearchField } from '../components/community/kit/fields';
import { panelId, tabId } from '../components/ui/Tabs';
import { Skeleton, SkeletonGroup } from '../components/ui/Skeleton';
import { CommunityLoadError } from './community/access';
import PendingStoreReviews from '../components/community/reviews/StoreReviews';
import OrderContactCard from '../components/community/offers/OrderContactCard';
/**
 * ELIGIBILITY AS DATA (stream W5-B): «مناسب لي» — the requests this workshop
 * can make, by the server's own verdict. The workshop's verdict on ONE
 * request, with its private costing, is on the request's page.
 */
import RequestBoard from '../components/merchant/workshop/RequestBoard';
import { StatusChip } from '../components/ui/Badge';
import { customOrderChips, customOrderReminder } from '../components/chat/cards/cardWords';
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
import CommunitySurface from '../components/community/CommunitySurface';
const OrderTimeline = lazy(() => import('../components/community/requests/OrderTimeline'));

/**
 * THE REQUEST EDITOR IS REACHED THROUGH THIS CHUNK (community UI plan B4):
 * src/App.tsx names it for /requests/new, /requests/new/:id and
 * /requests/:id/edit, and the editor loads lazily from here, as the wizard
 * did from this board (./community/RequestNew.tsx). A component, not the
 * lazy object itself: React refuses a lazy that resolves to another lazy.
 */
const RequestNew = lazy(() => import('./community/RequestNew'));
export function RequestEditor() {
  return (
    <Suspense fallback={null}>
      <RequestNew />
    </Suspense>
  );
}

/**
 * THE REQUEST'S OWN SCREEN, for the one place this page still shows it: the
 * offers that arrived before the community shut, under the maintenance card
 * (PendingOffersWhileClosed). A lazy chunk — the route file's own.
 */
const RequestDetail = lazy(() => import('./community/Request').then((m) => ({ default: m.RequestDetail })));

/** A board row: the public whitelist (worker `publicRequest`). No budget field, on purpose (plan R2). */
interface RequestRow {
  id: string;
  title: string;
  description: string;
  category: string;
  quantity: number;
  material: string;
  color: string;
  dimensions: string;
  deadline: string | null;
  governorate: string;
  state: string;
  offer_count: number;
  created_at: string;
  file_count?: number;
  summary?: { parts_count: number; pieces_per_set: number } | null;
  /** Only on the customer's own list; the board carries nobody's name (acceptance 34). */
  customer_name?: string | null;
  expires_at?: string | null;
  /** Notes the customer wrote for the merchants (0130). */
  customer_notes?: string;
  revision?: number;
}

/** What the public card reads of a board row, and nothing more (plan R2, R3, R10). */
export function publicCard(r: RequestRow): PublicRequestCard {
  return {
    id: r.id,
    title: r.title,
    quantity: r.quantity,
    material: r.material,
    governorate: r.governorate,
    state: r.state,
    offer_count: r.offer_count,
    file_count: r.file_count ?? null,
    deadline: r.deadline,
    created_at: r.created_at,
    summary: r.summary ?? null,
  };
}

type View = 'board' | 'mine' | 'orders' | 'new';

/** The editor address for an old door: the model link and the project it named ride along (they survive a sign-in). */
export function newRequestTarget(params: URLSearchParams): string {
  const carry = new URLSearchParams();
  for (const key of ['link', 'project']) {
    const value = params.get(key);
    if (value) carry.set(key, value);
  }
  const query = carry.toString();
  return query ? `/requests/new?${query}` : '/requests/new';
}

export default function Requests() {
  const { lang } = useLanguage();
  const s = useRequestStrings();
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
   * community page shortcuts link to (src/pages/Community.tsx). Read at
   * mount; the tabs then keep it in the address (`?view=mine`), so Back and a
   * reload return to the same tab. A guest who asks for the wizard or «قيد
   * التنفيذ» lands on the board; a guest on «طلباتي» is asked to sign in.
   */
  const [view, setViewState] = useState<View>(() => {
    // A carried link outranks the address: it is the wizard, with the link in it.
    const asked = carriedLink ? '' : params.get('view');
    if (asked === 'mine') return 'mine';
    if ((asked === 'new' || asked === 'orders') && user) return asked;
    return carriedLink && user ? 'new' : 'board';
  });
  /**
   * THE OLD DOORS STILL OPEN THE EDITOR (plan B4 seam). Every link written
   * before /requests/new existed (the community verbs, a model link card, a
   * project «اطلب طباعة مثلها», the price calculator, a store «اطلب عرض سعر»,
   * the chat sheet) names `?view=new`, `?link=`, `?project=` or router state
   * (`printLink`, `project`). It is REPLACED by the editor address carrying
   * all of it, so Back never lands on the forward; nothing of the board
   * flashes first.
   */
  const navigate = useNavigate();
  useEffect(() => {
    if (view === 'new') {
      navigate(newRequestTarget(params), { replace: true, state: location.state });
      return;
    }
    // The address says the tab the page opened on (a guest asking for «قيد التنفيذ» is on the board).
    const want = view === 'board' ? null : view;
    if (params.get('view') === want) return;
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (want) p.set('view', want);
        else p.delete('view');
        return p;
      },
      { replace: true }
    );
    // Once, at mount: the tabs keep the address from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A tab is a place in the address; the status filter means another thing on each tab, so it is dropped. */
  const setView = (next: View) => {
    setViewState(next);
    setDraft('');
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === 'board') p.delete('view');
        else p.set('view', next);
        p.delete('state');
        return p;
      },
      { replace: true }
    );
  };
  const filters = readBoardFilters(params, view === 'mine');
  const setFilter = (key: keyof BoardFilterValues, value: string | null) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (value) p.set(key, value);
        else p.delete(key);
        return p;
      },
      { replace: true }
    );
  const clearFilters = () =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        for (const k of ['state', 'process', 'governorate']) p.delete(k);
        return p;
      },
      { replace: true }
    );
  // One search for the list on screen: the board asks the server (title and description), «طلباتي» narrows its rows.
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const settle = useCallback((v: string) => setQ(v.trim().slice(0, 60)), []);

  const [me, setMe] = useState<MerchantMe | null>(null);
  /** The customer has a running order: «قيد التنفيذ» is a tab. */
  const [hasOrders, setHasOrders] = useState(false);
  /**
   * THE BOARD SAID THE COMMUNITY IS SHUT (503 COMMUNITY_CLOSED). The route
   * gate can let the page through on a verdict it has not refreshed, and the
   * board then shows the maintenance card — while «طلب جديد» stayed a live
   * primary that opened a wizard whose publish would be refused. It stays on
   * the page, flat and described by the notice, and opens nothing.
   */
  const [closed, setClosed] = useState(false);

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
  useEffect(() => {
    if (!deepLinked) return;
    navigate(requestRedirect(deepLinked, params, location.hash), { replace: true });
    // The address decides, once per id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinked]);

  // The board's own merchant read — never on the way through to /requests/<id>
  // (review 2026-09-30: an old link paid a /api/merchant/me it threw away).
  useEffect(() => {
    if (!user || deepLinked || view === 'new') return;
    merchantApi.me().then(setMe).catch(() => {});
    communityOrdersApi
      .list()
      .then((d) => setHasOrders(d.orders.some((o) => o.role === 'customer')))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, deepLinked]);

  /** Opening a request is a step forward to its own page, so Back returns here. */
  const openRequestId = useCallback((id: string) => navigate(requestPath(id)), [navigate]);

  // On its way to /requests/<id> or to the editor: nothing of the board flashes first.
  if (deepLinked || view === 'new') return null;

  const tabs = [
    { id: 'board', label: s.tabCommunity },
    { id: 'mine', label: s.tabMine },
    ...(user && (hasOrders || view === 'orders') ? [{ id: 'orders', label: s.tabOrders }] : []),
  ];

  return (
    <CommunitySurface>
      <div className="min-h-screen pb-28 text-text-secondary">
        <div className="mx-auto max-w-2xl px-4 sm:px-6">
          <SectionPageHeader
            title={s.boardTitle}
            trailing={
              <>
                <button
                  type="button"
                  onClick={() => {
                    if (closed) return;
                    // A step forward to the editor, so Back returns to the board; the
                    // editor leaves a new request with «طلباتي» in the place of this
                    // board entry (RequestNew.tsx leaveNewRequest, B2R3-REG-1).
                    if (user) navigate('/requests/new', { state: { from: 'board' } });
                    else signIn();
                  }}
                  aria-disabled={closed || undefined}
                  aria-describedby={closed ? 'requests-closed-note' : undefined}
                  className={kitButtonClass('gold', 'sm')}
                  data-requests-new
                >
                  <Box aria-hidden="true" className="h-4 w-4" />
                  {s.newRequest}
                </button>
                {closed && (
                  <span id="requests-closed-note" className="sr-only">
                    {s.closedNote}
                  </span>
                )}
              </>
            }
          />

          {view !== 'orders' && (
            <SearchField
              label={s.searchRequests}
              placeholder={s.searchRequests}
              value={draft}
              onValueChange={setDraft}
              onSettled={settle}
              debounceMs={300}
              maxLength={60}
              enterKeyHint="search"
              autoComplete="off"
              data-requests-search
              className="mt-2"
            />
          )}

          <UnderlineTabs group="requests-view" label={s.boardTabs} items={tabs} value={view} onChange={(id) => setView(id as View)} panels className="mt-3" />

          <div role="tabpanel" id={panelId('requests-view', view)} aria-labelledby={tabId('requests-view', view)} className="pt-3" data-requests-panel={view}>
            {view !== 'orders' && (
              <BoardFilters values={filters} mine={view === 'mine'} s={s} lang={lang === 'en' || lang === 'ckb' ? lang : 'ar'} onChange={setFilter} />
            )}
            <div className="mt-3">
              {view === 'orders' ? (
                <MyCommunityOrders />
              ) : view === 'mine' ? (
                <MyRequestsList onOpen={openRequestId} filters={filters} q={q} />
              ) : (
                // A PLUS member with no store yet has no workshop: «مناسب لي» is the
                // workshop board, and it answered them 404.
                <RequestList canOffer={!!me?.store && !!me?.can.offers} onClosed={setClosed} q={q} filters={filters} onClearFilters={clearFilters} onOpen={openRequestId} />
              )}
            </div>
          </div>
        </div>
      </div>
    </CommunitySurface>
  );
}

/**
 * THE PUBLIC BOARD. It renders `publicRequest()`'s whitelist and nothing more.
 * The customer's own list is `MyRequestsList`, which reads an owner-scoped
 * route carrying the estimate and the chosen merchant — data this component
 * deliberately never receives.
 */
function RequestList({
  canOffer = false,
  onClosed,
  q,
  filters,
  onClearFilters,
  onOpen,
}: {
  canOffer?: boolean;
  onClosed?: (closed: boolean) => void;
  q: string;
  filters: BoardFilterValues;
  onClearFilters: () => void;
  onOpen: (id: string) => void;
}) {
  const s = useRequestStrings();
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
        <SegmentedTrack
          group="requests-scope"
          size="sm"
          className="mb-4"
          label={s.whichRequests}
          value={scope}
          onChange={(id) => setScope(id as 'mine' | 'all')}
          dataAttr="data-requests-scope"
          items={[
            { id: 'mine', label: s.fitsMe },
            { id: 'all', label: s.allRequests },
          ]}
        />
      )}
      {scope === 'mine' && canOffer ? (
        <RequestBoard materials={materials} workshopHref={merchantHref.printers()} onOpen={(r) => onOpen(r.id)} />
      ) : (
        <AllRequests onClosed={onClosed} q={q} filters={filters} onClearFilters={onClearFilters} />
      )}
    </>
  );
}

/** The address of one page of the board: the search and the filters, ANDed on the server. */
export function boardUrl(q: string, f: BoardFilterValues, after?: string): string {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (f.state) p.set('offers', f.state);
  if (f.process) p.set('process', f.process);
  if (f.governorate) p.set('governorate', f.governorate);
  if (after) p.set('cursor', after);
  const qs = p.toString();
  return `/api/marketplace/requests${qs ? `?${qs}` : ''}`;
}

/** Every request on the public board, newest first, a page at a time. */
function AllRequests({
  onClosed,
  q,
  filters,
  onClearFilters,
}: {
  /** Told whether the last board read was refused as COMMUNITY_CLOSED. */
  onClosed?: (closed: boolean) => void;
  q: string;
  filters: BoardFilterValues;
  onClearFilters: () => void;
}) {
  const s = useRequestStrings();
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  /** «المزيد» failed: said on the button, which stays to try again. */
  const [moreError, setMoreError] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    onClosed?.(loadError instanceof ApiError && loadError.code === 'COMMUNITY_CLOSED');
  }, [loadError, onClosed]);
  const { state, process, governorate } = filters;
  const url = useCallback((after?: string) => boardUrl(q, { state, process, governorate }, after), [q, state, process, governorate]);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setLoadError(null);
    setMoreError(false);
    api
      .get<{ requests: RequestRow[]; next_cursor: string | null }>(url())
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
  }, [attempt, url]);

  async function loadMore() {
    if (!cursor || more) return;
    setMore(true);
    setMoreError(false);
    try {
      const d = await api.get<{ requests: RequestRow[]; next_cursor: string | null }>(url(cursor));
      setRows((r) => [...(r ?? []), ...d.requests.filter((x) => !(r ?? []).some((y) => y.id === x.id))]);
      setCursor(d.next_cursor ?? null);
    } catch {
      // The rest of the board is still there: keep the way to it.
      setMoreError(true);
    } finally {
      setMore(false);
    }
  }

  const filtered = !!(state || process || governorate);
  let body: ReactNode = null;
  if (rows === null) {
    body = loadError ? (
      <CommunityLoadError error={loadError} onRetry={() => setAttempt((n) => n + 1)} />
    ) : (
      <SkeletonGroup className="space-y-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-40 w-full rounded-xl" />
        ))}
      </SkeletonGroup>
    );
  } else if (!rows.length) {
    body = (
      <div className="py-14 text-center" data-requests-empty={q ? 'search' : filtered ? 'filters' : 'board'}>
        <PackageSearch aria-hidden="true" className="mx-auto mb-3 h-9 w-9 text-text-muted" />
        <p className="text-[13px] text-text-secondary">{q ? <bdi>{fill(s.noResultsFor, { q })}</bdi> : filtered ? s.noFilterMatch : s.noOpenRequests}</p>
        {filtered && (
          <button type="button" onClick={onClearFilters} className={`${kitButtonClass('secondary', 'sm')} mt-3`} data-requests-clear-filters>
            {s.clearFilters}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-requests-board>
      {body}
      {rows?.map((r) => (
        <RequestListCard key={r.id} variant="list" level={2} request={publicCard(r)} />
      ))}
      {rows && <PageSentinel more={!!cursor} busy={more} failed={moreError} onMore={loadMore} s={s} />}
    </div>
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
                  ? loc('مسترجع بقرار Levonis', 'Refunded by Levonis', 'بە بڕیاری Levonis پارەکە گەڕێنرایەوە')
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
          {/* An order from a partial or substituted offer is not the whole job (P1-05 review 5). */}
          {customOrderChips(o, loc).length > 0 && (
            <p className="mb-1.5 flex flex-wrap gap-1.5" data-community-order-coverage={o.id}>
              {customOrderChips(o, loc).map((c) => (
                <StatusChip key={c} tone="warning">{c}</StatusChip>
              ))}
            </p>
          )}
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
                {loc('التواصل مع التاجر', 'Contact the merchant', 'پەیوەندی بە بازرگانەکەوە')}
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
        busyLabel={loc('جارٍ التحويل…', 'Releasing…', 'پارەکە دەگوازرێتەوە…')}
        busy={busy}
        error={error}
        onConfirm={run}
        onClose={() => setAction(null)}
      >
        {[action?.kind === 'confirm' ? customOrderReminder(action.order, loc) : '', loc(
          'التأكيد يحوّل المبلغ للتاجر ولا يمكن التراجع عنه.',
          'Confirming releases the money to the merchant and cannot be undone.',
          'پشتڕاستکردنەوە پارەکە دەداتە بازرگان.'
        )].filter(Boolean).join(' ')}
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
        {loc(
          'يُلغى التنفيذ قبل أن يبدأ التاجر، ويعود المبلغ المحجوز إلى رصيدك.',
          'The order is cancelled before the merchant starts, and the held money returns to your balance.',
          'داواکارییەکە پێش ئەوەی بازرگانەکە دەست پێ بکات هەڵدەوەشێتەوە، و بڕە پارە گیراوەکە دەگەڕێتەوە بۆ باڵانسەکەت.'
        )}
      </ConfirmSheet>

      <ConfirmSheet
        open={action?.kind === 'dispute'}
        testId="open-dispute"
        title={loc('فتح نزاع', 'Open a dispute', 'ناکۆکی تۆمار بکە')}
        confirmLabel={loc('فتح نزاع', 'Open a dispute', 'ناکۆکی تۆمار بکە')}
        busyLabel={loc('جارٍ الإرسال…', 'Sending…', 'دەنێردرێت…')}
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
