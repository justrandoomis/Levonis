/**
 * THE CUSTOMER'S OFFERS, SIDE BY SIDE — V2 (docs/COMMUNITY_ECOSYSTEM.md
 * §9.5, Client 5c). Every offer answers the same questions in the same rows
 * so the eye can run across them; the TOTAL leads, because the total is what
 * the customer agrees to: the price plus the delivery fee, computed on the
 * server (`total_iqd`) and never here.
 *
 * A revised offer says «عرض معدّل» with the price it replaced and opens its
 * history; a superseded, expired or no-longer-possible one says why it cannot
 * be taken; the offer's files are URLs on the Worker (a party never sees a
 * key).
 *
 * ACCEPTING MOVES MONEY, AND ONLY FOR THE VERSION ON SCREEN. The sheet names
 * the total and the version, says the money is HELD, says who receives the
 * customer's phone and address, lets the customer pick the address for a
 * delivered job, and sends back exactly `expected_total_iqd` and
 * `offer_revision`. OFFER_CHANGED swaps in the fresh terms and asks again;
 * OFFER_STALE says the merchant must re-confirm — both as the refusal's own
 * sentence with a «حدّث» that re-reads the offers.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, BadgeCheck, History, MessageCircle, Star } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { api, ApiError, type ApiAddress } from '../../../lib/api';
import { apiRefusal } from '../../../lib/refusalStrings';
import { Sheet } from '../../ui/Sheet';
import { Button } from '../../ui/Button';
import { Money } from '../../ui/Money';
import { Segmented } from '../../ui/Segmented';
import { StatusChip } from '../../ui/Badge';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { CommunityStoreLink } from '../../../pages/community/access';
import { offersApi } from '../offers/types';
import { offersV2Api, type CatalogMaterial, type OfferFileV2, type OfferHistoryEntryV2, type OfferV2 } from './api';
import { FileGlyph } from './OfferComposer';
import { daysLabel, fill, fillNodes, handoverLabel, jobsLabel, offerStateWords, requestLang, shortDay, useRequestStrings, type RequestLang, type RequestStrings } from './strings';

type Sort = 'price' | 'time' | 'rating';

/** An offer the customer can still take. */
export function offerIsLive(o: OfferV2): boolean {
  return o.state === 'pending' && !o.stale && !o.expired && !o.workshop_unable;
}

/** The three best-in-class picks for the quick comparison, from the live offers. */
export function bestOffers(offers: OfferV2[]): { cheapest: OfferV2 | null; fastest: OfferV2 | null; topRated: OfferV2 | null } {
  const live = offers.filter(offerIsLive);
  const by = (key: (o: OfferV2) => number) => live.reduce<OfferV2 | null>((best, o) => (best === null || key(o) < key(best) ? o : best), null);
  const rated = live.filter((o) => o.merchant?.rating != null);
  return {
    cheapest: by((o) => o.total_iqd ?? Number.MAX_SAFE_INTEGER),
    fastest: by((o) => o.completion_days || Number.MAX_SAFE_INTEGER),
    topRated: rated.reduce<OfferV2 | null>((best, o) => (best === null || (o.merchant!.rating ?? 0) > (best.merchant!.rating ?? 0) ? o : best), null),
  };
}

/** The accepted offer first, then the ones that can still be taken, each group in the chosen order. */
export function sortOffers(offers: OfferV2[], sort: Sort): OfferV2[] {
  const rank = (o: OfferV2) => (o.state === 'accepted' ? 0 : offerIsLive(o) ? 1 : 2);
  const key = (o: OfferV2) => (sort === 'price' ? o.total_iqd ?? Number.MAX_SAFE_INTEGER : sort === 'time' ? o.completion_days || 9999 : -(o.merchant?.rating ?? 0));
  return [...offers].sort((a, b) => rank(a) - rank(b) || key(a) - key(b));
}

/** What `acceptOffer` sends — the TOTAL and the version on screen, never a price the server did not compute. */
export function acceptBody(o: Pick<OfferV2, 'total_iqd' | 'revision' | 'delivery_method'>, addressId: string) {
  return {
    expected_total_iqd: o.total_iqd ?? 0,
    offer_revision: o.revision,
    ...(addressId && o.delivery_method !== 'pickup' ? { address_id: addressId } : {}),
  };
}

export interface OfferCompareProps {
  requestId: string;
  offers: OfferV2[];
  /** The request still takes offers — acceptance and decline are possible. */
  takingOffers: boolean;
  materials: CatalogMaterial[];
  onChanged: () => void;
}

export default function OfferCompare({ requestId, offers, takingOffers, materials, onChanged }: OfferCompareProps) {
  const { lang } = useLanguage();
  const s = useRequestStrings();
  const L = requestLang(lang);
  const toast = useToast();
  const navigate = useNavigate();
  const [confirm, confirmDialog] = useConfirm();
  const [sort, setSort] = useState<Sort>('price');
  const [accepting, setAccepting] = useState<OfferV2 | null>(null);
  const [historyOf, setHistoryOf] = useState<OfferV2 | null>(null);

  const matName = (id: string) => {
    const m = materials.find((x) => x.id === id);
    return m ? (L === 'en' ? m.name_en : m.name_ar || m.name_en) : id;
  };

  const sorted = useMemo(() => sortOffers(offers, sort), [offers, sort]);
  const best = useMemo(() => bestOffers(offers), [offers]);
  const liveCount = offers.filter(offerIsLive).length;

  async function decline(o: OfferV2) {
    const name = o.merchant?.name ?? s.theMerchant;
    const ok = await confirm({ title: s.declineQ, consequence: fill(s.declineBody, { name }), confirmLabel: s.decline, destructive: true });
    if (!ok) return;
    try {
      await offersApi.decline(o.id);
      onChanged();
    } catch (e) {
      toast.error(apiRefusal(e, L, s.couldNotDecline));
    }
  }

  async function chat(o: OfferV2) {
    try {
      const r = await offersApi.openThread(requestId, o.merchant_id);
      navigate(`/chat/${encodeURIComponent(r.chatId)}`);
    } catch (e) {
      toast.error(apiRefusal(e, L, s.couldNotOpenChat));
    }
  }

  if (!offers.length) {
    return (
      <p className="py-6 text-center text-[13px] text-text-muted" data-offers="empty">
        {s.noOffersYet}
      </p>
    );
  }

  return (
    <div data-offer-compare>
      {offers.length > 1 && (
        <div className="mb-3 max-w-sm">
          <Segmented
            group="offer-sort"
            size="sm"
            label={s.sortOffers}
            value={sort}
            onChange={(id) => setSort(id as Sort)}
            dataAttr="data-offer-sort"
            items={[
              { id: 'price', label: s.sortPrice },
              { id: 'time', label: s.sortTime },
              { id: 'rating', label: s.sortRating },
            ]}
          />
        </div>
      )}
      {/* Phone: columns that scroll sideways and snap; wider: a grid of at most TWO — the page's
          column is max-w-2xl, and three there were ~205 px each, names cut and rows out of line. */}
      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0" data-offer-columns>
        {sorted.map((o) => (
          <OfferColumn
            key={o.id}
            o={o}
            s={s}
            lang={L}
            matName={matName}
            canAct={takingOffers && offerIsLive(o)}
            onAccept={() => setAccepting(o)}
            onDecline={() => decline(o)}
            onChat={() => chat(o)}
            onHistory={() => setHistoryOf(o)}
          />
        ))}
      </div>

      {/* The quick comparison (§9.5 «comparison»): which offer wins on each of
          the three things a customer weighs — only when there is a choice. */}
      {liveCount >= 2 && (
        <section aria-labelledby="offer-compare-title" className="mt-4 overflow-hidden rounded-2xl border border-border-subtle bg-surface" data-request-section="compare" data-offer-compare-table>
          <h3 id="offer-compare-title" className="px-4 pt-3 text-[13px] font-bold text-text-primary">
            {s.compare}
          </h3>
          <dl className="divide-y divide-border-subtle/60 px-4 pb-1 pt-1">
            <CompareRow label={s.cheapest} o={best.cheapest} value={best.cheapest ? <Money iqd={best.cheapest.total_iqd} /> : null} />
            <CompareRow label={s.fastest} o={best.fastest} value={best.fastest ? daysLabel(best.fastest.completion_days, L) : null} />
            <CompareRow
              label={s.topRated}
              o={best.topRated}
              value={
                best.topRated ? (
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <Star aria-hidden="true" className="h-3 w-3 fill-gold text-gold" />
                    {(best.topRated.merchant?.rating ?? 0).toFixed(1)}
                  </span>
                ) : (
                  <span className="text-text-muted">{s.noRatingYet}</span>
                )
              }
            />
          </dl>
        </section>
      )}

      <AcceptSheet
        offer={accepting}
        onClose={() => setAccepting(null)}
        onAccepted={(o) => {
          setAccepting(null);
          toast.success(fill(s.youChose, { name: o.merchant?.name ?? s.theMerchant }));
          onChanged();
        }}
        onRefresh={onChanged}
      />
      <HistorySheet offer={historyOf} onClose={() => setHistoryOf(null)} />
      {confirmDialog}
    </div>
  );
}

function CompareRow({ label, o, value }: { label: string; o: OfferV2 | null; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-[12.5px]" data-compare-row>
      <dt className="shrink-0 text-text-muted">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2 text-end text-text-primary">
        {o && <bdi className="truncate font-semibold">{o.merchant?.name ?? '—'}</bdi>}
        <span className="shrink-0 tabular-nums">{value ?? '—'}</span>
      </dd>
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <dt className="shrink-0 text-[12px] text-text-muted">{k}</dt>
      <dd className="min-w-0 break-words text-end text-[12.5px] text-text-primary" dir="auto">
        {children}
      </dd>
    </div>
  );
}

/** The offer's files as a party may open them: a URL on the Worker, never a key. */
export function OfferFiles({ files, label }: { files: OfferFileV2[]; label: string }) {
  const shown = files.filter((f) => f.url);
  if (!shown.length) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2" aria-label={label} data-offer-files>
      {shown.map((f) => (
        <li key={f.id ?? f.url!} className="max-w-full">
          <a
            href={f.url!}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-xl border border-border-subtle bg-surface-raised pe-3 ps-1.5 text-[12px] text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            data-offer-file={f.kind}
          >
            {f.kind === 'image' ? <img src={f.url!} alt="" loading="lazy" decoding="async" className="size-8 shrink-0 rounded-lg object-cover" /> : <FileGlyph kind={f.kind} />}
            <bdi className="truncate">{f.name}</bdi>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** The price and the fee as the customer reads them: «١٨٬٠٠٠ + ٢٬٠٠٠ توصيل», or «بلا رسوم». */
export function Breakdown({ o, s }: { o: Pick<OfferV2, 'price_iqd' | 'delivery_fee_iqd'>; s: RequestStrings }) {
  return (
    <p className="min-h-[18px] text-[11.5px] text-text-muted" data-offer-breakdown>
      {o.delivery_fee_iqd > 0 ? (
        <>
          <Money iqd={o.price_iqd} /> + <Money iqd={o.delivery_fee_iqd} /> {s.feeShort}
        </>
      ) : (
        s.noFee
      )}
    </p>
  );
}

function OfferColumn({
  o,
  s,
  lang,
  matName,
  canAct,
  onAccept,
  onDecline,
  onChat,
  onHistory,
}: {
  o: OfferV2;
  s: RequestStrings;
  lang: RequestLang;
  matName: (id: string) => string;
  canAct: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onChat: () => void;
  onHistory: () => void;
}) {
  const m = o.merchant;
  const st = offerStateWords(o, s);
  const history = o.history ?? [];
  const prev = history.length > 1 ? history[history.length - 2] : null;
  const until = shortDay(o.valid_until ?? o.expires_at, lang);
  const sep = lang === 'en' ? ', ' : '، ';
  return (
    <article
      className="lv-surface flex w-[85%] shrink-0 snap-start flex-col p-4 sm:w-auto"
      data-offer={o.id}
      data-offer-state={o.state}
      data-offer-stale={o.stale ? 'true' : undefined}
      data-offer-revised={o.revised ? 'true' : undefined}
      aria-label={m?.name ?? s.theMerchant}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[14px] font-semibold text-text-primary">
            <bdi className="truncate">{m?.name ?? '—'}</bdi>
            {m?.verified && <BadgeCheck aria-label={s.verified} className="h-4 w-4 shrink-0 text-gold" />}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-text-muted">
            {m?.rating != null && (
              <span className="inline-flex items-center gap-0.5 tabular-nums">
                <Star aria-hidden="true" className="h-3 w-3 fill-gold text-gold" />
                {m.rating.toFixed(1)} ({m.rating_count})
              </span>
            )}
            {!!m?.completed_orders && <span>{jobsLabel(m.completed_orders, lang)}</span>}
          </p>
        </div>
        <StatusChip tone={st.tone}>{st.text}</StatusChip>
      </header>

      <p className="mt-3 text-[20px] font-bold text-text-primary" data-offer-total={o.total_iqd ?? ''}>
        <Money iqd={o.total_iqd} />
      </p>
      {/* One line tall always, so the rows below line up across columns. */}
      <Breakdown o={o} s={s} />
      {o.revised && (
        <p className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px]" data-offer-edited>
          <StatusChip tone="info">{s.revised}</StatusChip>
          {prev && prev.price_iqd !== o.price_iqd && (
            <span className="text-text-muted" data-offer-was>
              {fillNodes(s.was, { price: <Money iqd={prev.price_iqd} className="line-through" /> })}
            </span>
          )}
          {history.length > 1 && (
            <button
              type="button"
              onClick={onHistory}
              className="inline-flex min-h-11 items-center gap-1 rounded-full text-[11.5px] font-semibold text-text-secondary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              data-offer-history={o.id}
            >
              <History aria-hidden="true" className="h-3.5 w-3.5" />
              {s.history}
            </button>
          )}
        </p>
      )}

      <dl className="mt-2 divide-y divide-border-subtle/60">
        <Row k={s.completion}>{o.completion_days ? daysLabel(o.completion_days, lang) : '—'}</Row>
        <Row k={s.handover}>{handoverLabel(o.delivery_method, s)}</Row>
        {o.quantity != null && <Row k={s.quantity}>{`×${o.quantity}`}</Row>}
        {o.color && <Row k={s.colour}>{o.color}</Row>}
        <Row k={s.materials}>{o.material_ids?.length ? o.material_ids.map(matName).join(sep) : o.materials || '—'}</Row>
        <Row k={s.included}>{o.included || '—'}</Row>
        <Row k={s.warranty}>{o.warranty_terms || '—'}</Row>
        {o.terms && <Row k={s.terms}>{o.terms}</Row>}
        <Row k={s.validUntil}>{until || s.openEnded}</Row>
      </dl>
      {o.message && (
        <p className="mt-2 whitespace-pre-line rounded-xl bg-surface-raised px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary" dir="auto">
          {o.message}
        </p>
      )}
      <OfferFiles files={o.files ?? []} label={s.offerFiles} />

      {o.stale && o.state !== 'accepted' && (
        <p className="mt-2 flex items-start gap-2 text-[12px] leading-relaxed text-warning" data-offer-note="stale">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {s.staleNote}
        </p>
      )}
      {o.workshop_unable && o.state === 'pending' && (
        <p className="mt-2 flex items-start gap-2 text-[12px] leading-relaxed text-warning" data-offer-unable>
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {s.unableNote}
        </p>
      )}

      <div className="mt-auto pt-3">
        {canAct && (
          <Button variant="primary" block onClick={onAccept} className="whitespace-nowrap" data-offer-accept={o.id}>
            {s.acceptOffer}
          </Button>
        )}
        <div className="mt-2 flex flex-wrap gap-1">
          {(o.state === 'pending' || o.state === 'superseded') && (
            <Button variant="ghost" size="sm" onClick={onChat} icon={<MessageCircle aria-hidden="true" className="h-4 w-4" />} data-offer-chat={o.id}>
              {s.askMerchant}
            </Button>
          )}
          {m?.store_slug && (
            // A merchant (or store) id: the link resolves ids, and a slug here answered «no store».
            <CommunityStoreLink id={o.merchant_id} className="lv-button lv-button-ghost lv-button-sm">
              {s.viewStore}
            </CommunityStoreLink>
          )}
          {canAct && (
            <Button variant="ghost" size="sm" onClick={onDecline} data-offer-decline={o.id}>
              {s.decline}
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

/** «كان ٥٠٬٠٠٠» — every version of one offer, newest first. The history rows carry the price; the fee travels with the offer. */
function HistorySheet({ offer, onClose }: { offer: OfferV2 | null; onClose: () => void }) {
  const { lang } = useLanguage();
  const s = useRequestStrings();
  const L = requestLang(lang);
  const titleId = useId();
  const rows: OfferHistoryEntryV2[] = [...(offer?.history ?? [])].reverse();
  return (
    <Sheet
      open={!!offer}
      onClose={onClose}
      labelledBy={titleId}
      panelClassName="w-full sm:max-w-md"
      testId="offer-history"
      header={
        <div className="px-5 pb-1 pt-1">
          <h2 id={titleId} className="text-[16px] font-bold text-text-primary">
            {s.history}
          </h2>
          {offer?.merchant?.name && (
            <p className="mt-0.5 text-[12px] text-text-muted">
              <bdi>{offer.merchant.name}</bdi>
            </p>
          )}
        </div>
      }
    >
      <ol className="divide-y divide-border-subtle/60 px-5 pb-4" data-offer-history-list>
        {rows.map((h) => (
          <li key={h.revision} className="flex items-center justify-between gap-3 py-2.5 text-[13px]" data-offer-history-row={h.revision}>
            <span className="min-w-0">
              <span className="block font-semibold text-text-primary">{fill(s.version, { n: h.revision })}</span>
              <span className="block text-[11.5px] text-text-muted">
                {[h.completion_days ? daysLabel(h.completion_days, L) : '', handoverLabel(h.delivery_method, s), shortDay(h.created_at, L)].filter((x) => x && x !== '—').join(' · ')}
              </span>
            </span>
            <span className={`shrink-0 font-semibold tabular-nums ${h.revision === offer?.revision ? 'text-text-primary' : 'text-text-muted line-through'}`}>
              <Money iqd={h.price_iqd} />
            </span>
          </li>
        ))}
      </ol>
    </Sheet>
  );
}

/** A refusal with a way out: its sentence and what «حدّث» does. */
type Notice = { code: 'OFFER_CHANGED' | 'OFFER_STALE'; text: string };

function AcceptSheet({ offer, onClose, onAccepted, onRefresh }: { offer: OfferV2 | null; onClose: () => void; onAccepted: (o: OfferV2) => void; onRefresh: () => void }) {
  const { lang } = useLanguage();
  const s = useRequestStrings();
  const L = requestLang(lang);
  const titleId = useId();
  const [shown, setShown] = useState<OfferV2 | null>(offer);
  const [changed, setChanged] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [error, setError] = useState('');
  const [needsTopUp, setNeedsTopUp] = useState(false);
  const [addresses, setAddresses] = useState<ApiAddress[] | null>(null);
  const [addressId, setAddressId] = useState('');

  useEffect(() => {
    if (!offer) return;
    setShown(offer);
    setChanged(false);
    setNotice(null);
    setError('');
    setNeedsTopUp(false);
    if (offer.delivery_method === 'pickup') return;
    let alive = true;
    setAddresses(null);
    api
      .get<{ addresses: ApiAddress[] }>('/api/addresses')
      .then((d) => {
        if (!alive) return;
        setAddresses(d.addresses ?? []);
        const def = (d.addresses ?? []).find((a) => a.is_default) ?? d.addresses?.[0];
        setAddressId(def?.id ?? '');
      })
      .catch(() => alive && setAddresses([]));
    return () => {
      alive = false;
    };
  }, [offer]);

  const o = shown;
  async function accept() {
    if (!o || o.total_iqd === null) return;
    setError('');
    setNotice(null);
    setNeedsTopUp(false);
    try {
      await offersV2Api.acceptOffer(o.id, acceptBody(o, addressId));
      onAccepted(o);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      if (code === 'OFFER_CHANGED' || code === 'OFFER_STALE') {
        const fresh = e instanceof ApiError ? (e.details?.offer as Partial<OfferV2> | undefined) : undefined;
        if (fresh && code === 'OFFER_CHANGED') {
          // The fresh terms from the refusal itself: the total and the version the next press confirms.
          setShown({ ...o, ...fresh, merchant: o.merchant, files: o.files, history: o.history });
          setChanged(true);
        }
        setNotice({ code, text: apiRefusal(e, L, s.couldNotAccept) });
        return;
      }
      setError(code === 'OFFER_NOT_ELIGIBLE' ? s.unableAccept : apiRefusal(e, L, s.couldNotAccept));
      setNeedsTopUp(code === 'INSUFFICIENT_FUNDS');
    }
  }

  /** «حدّث»: re-read the offers; a stale offer leaves the sheet (only its merchant can revive it). */
  function refresh() {
    onRefresh();
    if (notice?.code === 'OFFER_STALE') onClose();
    else setNotice(null);
  }

  const name = o?.merchant?.name ?? s.theMerchant;
  const stale = notice?.code === 'OFFER_STALE';
  return (
    <Sheet
      open={!!offer}
      onClose={onClose}
      labelledBy={titleId}
      panelClassName="w-full sm:max-w-md"
      testId="offer-accept"
      header={
        <div className="px-5 pb-1 pt-1">
          <h2 id={titleId} className="text-[16px] font-bold text-text-primary">
            {s.acceptQ}
          </h2>
        </div>
      }
      footer={
        <div className="space-y-2 px-1">
          {error && (
            <p className="lv-field-error" role="alert" data-accept-error>
              {error}
            </p>
          )}
          {needsTopUp && (
            <Link to="/wallet" className="inline-flex min-h-[44px] items-center text-[13px] font-semibold text-gold underline-offset-4 hover:underline">
              {s.topUp}
            </Link>
          )}
          {!stale && (
            <Button variant="primary" block onClick={accept} loadingLabel={s.holding} data-accept-confirm>
              {changed ? s.acceptNewTerms : s.acceptAndHold}
            </Button>
          )}
          <Button block variant="ghost" onClick={onClose}>
            {s.notNow}
          </Button>
        </div>
      }
    >
      {o && (
        <div className="space-y-3 px-5 pb-3 pt-1 text-[13px] leading-relaxed text-text-secondary" data-accept-sheet={o.id}>
          {notice && (
            <div role="status" className="lv-alert lv-alert-warning flex items-start justify-between gap-3" data-accept={notice.code === 'OFFER_CHANGED' ? 'changed' : 'stale'}>
              <span className="min-w-0 text-text-primary">{notice.text}</span>
              <Button size="sm" variant="secondary" onClick={refresh} className="shrink-0" data-accept-refresh>
                {s.refresh}
              </Button>
            </div>
          )}
          <div className="rounded-xl bg-surface-raised px-3.5 py-3">
            <div className="flex items-center justify-between gap-3">
              <bdi className="truncate font-semibold text-text-primary">{name}</bdi>
              <span className="shrink-0 text-[16px] font-bold text-text-primary" data-accept="total" data-accept-total={o.total_iqd ?? ''}>
                <Money iqd={o.total_iqd} />
              </span>
            </div>
            <p className="mt-1 text-[12px] text-text-muted">
              {o.delivery_fee_iqd > 0 && (
                <>
                  <Money iqd={o.price_iqd} /> + <Money iqd={o.delivery_fee_iqd} /> {s.feeShort} ·{' '}
                </>
              )}
              {o.completion_days ? `${fill(s.inDays, { days: daysLabel(o.completion_days, L) })} · ` : ''}
              {handoverLabel(o.delivery_method, s)} · {fill(s.version, { n: o.revision })}
            </p>
          </div>
          <p>{s.heldExplain}</p>
          {o.delivery_method !== 'pickup' && (
            <div>
              <label htmlFor={`${titleId}-address`} className="mb-1.5 block text-[12.5px] font-semibold text-text-secondary">
                {s.deliveryAddress}
              </label>
              {addresses === null ? (
                <div className="h-11 animate-pulse rounded-xl bg-surface-selected motion-reduce:animate-none" />
              ) : addresses.length ? (
                <select id={`${titleId}-address`} className="lv-input w-full" value={addressId} onChange={(e) => setAddressId(e.target.value)} data-accept-address>
                  {addresses.map((a) => (
                    <option key={a.id} value={a.id}>{`${a.label} — ${a.address}`}</option>
                  ))}
                </select>
              ) : (
                <p className="text-[12.5px] text-text-muted">
                  {s.noAddress}{' '}
                  <Link to="/addresses" className="font-semibold text-gold underline-offset-4 hover:underline">
                    {s.addAddress}
                  </Link>
                </p>
              )}
            </div>
          )}
          <p className="text-[12px] text-text-muted" data-accept="contact-consent">
            {fill(s.contactConsent, { name, address: o.delivery_method !== 'pickup' ? s.andAddress : '' })}
          </p>
        </div>
      )}
    </Sheet>
  );
}
