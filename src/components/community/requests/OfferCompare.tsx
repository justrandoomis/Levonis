/**
 * THE OFFERS TO THE CUSTOMER (docs/COMMUNITY_ECOSYSTEM.md §9.5, Client 5c; community
 * UI plan C3, IMG_8472, IMG_8479). Each offer is a card (./OfferCard.tsx) in
 * the radio group «العروض», cheapest live total first; the TOTAL leads,
 * because the total is what the customer agrees to: the price plus the
 * delivery fee, computed on the server (`total_iqd`) and never here.
 *
 *   «مقارنة العروض»  a chip over the list once two offers are live: the lazy
 *                    CompareSheet (the sort, the quick comparison, and the
 *                    offers side by side on a wide screen)
 *   «التفاصيل»       the lazy OfferDetailsSheet: every fact of the offer, its
 *                    message, files and revision history, the store, «اعتذر»
 *   the dock         the one gold «متابعة مع هذا العرض» under the list
 *
 * NOTHING IS CHOSEN FOR THE CUSTOMER (plan R8). No offer starts selected;
 * only a live offer of a request that still takes offers can be chosen; and
 * until one is, the dock button is disabled and says why («اختر عرضًا
 * أولًا»). Choosing moves no money: the button opens the accept sheet.
 *
 * ACCEPTING MOVES MONEY, AND ONLY FOR THE VERSION ON SCREEN. The sheet names
 * the total and the version, says the money is HELD, says who receives the
 * customer's phone and address, lets the customer pick the address for a
 * delivered job, and sends back exactly `expected_total_iqd` and
 * `offer_revision`. OFFER_CHANGED swaps in the fresh terms and asks again;
 * OFFER_STALE says the merchant must re-confirm, both as the own sentence of the refusal
 * sentence with a «حدّث» that re-reads the offers.
 */
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Scale } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { api, ApiError, type ApiAddress } from '../../../lib/api';
import { apiRefusal } from '../../../lib/refusalStrings';
import { Sheet } from '../../ui/Sheet';
import { Button } from '../../ui/Button';
import { Money } from '../../ui/Money';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { offersApi } from '../offers/types';
import { KitButton, kitButtonClass } from '../kit/buttons';
import { ActionDock } from '../kit/display';
import { offersV2Api, type CatalogMaterial, type OfferFileV2, type OfferV2 } from './api';
import { FileGlyph } from './OfferComposer';
import OfferCard from './OfferCard';
import { daysLabel, fill, handoverLabel, requestLang, useRequestStrings, type RequestStrings } from './strings';
import VariantImg from '../../ui/VariantImg';
import { Checkbox } from '../../ui/Switch';
import {
  acceptBody,
  bestOffers,
  coverageOf,
  isPartialOffer,
  listSep,
  offerIsLive,
  partName,
  partialAckReady,
  sortOffers,
  substitutesSomething,
  substitutionPieces,
  readerDir,
  type PartRef,
} from './offerParts';
import { SubstitutionText } from './SubstitutionText';

/** The two sheets the list opens: lazy, so the request page does not carry them (plan R6). */
const OfferDetailsSheet = lazy(() => import('./OfferDetailsSheet'));
const CompareSheet = lazy(() => import('./CompareSheet'));

// The pure helpers live in ./offerParts (P1-05) and are re-exported here for the callers that read them from this file.
export { acceptBody, bestOffers, offerIsLive, sortOffers };

export interface OfferCompareProps {
  requestId: string;
  offers: OfferV2[];
  /** The request still takes offers: a live offer can be chosen, accepted and declined. */
  takingOffers: boolean;
  materials: CatalogMaterial[];
  onChanged: () => void;
  /** P1-05: the parts of the request, to name what a partial offer covers and what a substitution replaces. */
  parts?: PartRef[];
}

export default function OfferCompare({ requestId, offers, takingOffers, materials, onChanged, parts = [] }: OfferCompareProps) {
  const { lang, dir } = useLanguage();
  const s = useRequestStrings();
  const L = requestLang(lang);
  const toast = useToast();
  const navigate = useNavigate();
  const [confirm, confirmDialog] = useConfirm();
  const hintId = useId();
  const [accepting, setAccepting] = useState<OfferV2 | null>(null);
  /** The choice of the customer: nobody is chosen for them (plan R8). */
  const [chosen, setChosen] = useState<string | null>(null);
  const [detailsOf, setDetailsOf] = useState<{ offer: OfferV2; history: boolean } | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  /** A lazy sheet stays mounted once its chunk is asked for, so it can close with its motion. */
  const [asked, setAsked] = useState({ details: false, compare: false });
  const radios = useRef<Array<HTMLElement | null>>([]);

  const sorted = useMemo(() => sortOffers(offers, 'price'), [offers]);
  const liveCount = offers.filter(offerIsLive).length;
  const canChoose = (o: OfferV2) => takingOffers && offerIsLive(o);
  const choosable = sorted.filter(canChoose);
  // A choice that stopped being possible (re-read offers, a withdrawn one) is dropped, never kept silently.
  const chosenOffer = choosable.find((o) => o.id === chosen) ?? null;
  useEffect(() => {
    if (chosen && !chosenOffer) setChosen(null);
  }, [chosen, chosenOffer]);

  async function decline(o: OfferV2) {
    const name = o.merchant?.name ?? s.theMerchant;
    const ok = await confirm({ title: s.declineQ, consequence: fill(s.declineBody, { name }), confirmLabel: s.decline, destructive: true });
    if (!ok) return;
    try {
      await offersApi.decline(o.id);
      setDetailsOf(null);
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

  const openDetails = (offer: OfferV2, history = false) => {
    setAsked((a) => ({ ...a, details: true }));
    setDetailsOf({ offer, history });
  };

  /** The radio group keyboard: the arrows walk the offers in the writing direction and choose as they go. */
  function onRadioKey(e: KeyboardEvent<HTMLElement>, at: number) {
    const next = e.key === 'ArrowDown' || e.key === (dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight');
    const prev = e.key === 'ArrowUp' || e.key === (dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft');
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      setChosen(choosable[at].id);
      return;
    }
    if (!next && !prev) return;
    e.preventDefault();
    const n = choosable.length;
    const to = (at + (next ? 1 : -1) + n) % n;
    setChosen(choosable[to].id);
    radios.current[to]?.focus();
  }

  if (!offers.length) {
    return (
      <p className="py-6 text-center text-[13px] text-text-muted" data-offers="empty">
        {s.noOffersYet}
      </p>
    );
  }

  const tabStopId = chosenOffer?.id ?? choosable[0]?.id ?? null;
  return (
    <div data-offer-compare>
      {liveCount >= 2 && (
        <KitButton
          size="sm"
          className="mb-3"
          icon={<Scale aria-hidden="true" className="h-4 w-4" />}
          onClick={() => {
            setAsked((a) => ({ ...a, compare: true }));
            setCompareOpen(true);
          }}
          data-offer-compare-open
        >
          {s.compareOffers}
        </KitButton>
      )}
      <div role={choosable.length ? 'radiogroup' : undefined} aria-label={s.offersGroup} className="space-y-3" data-offer-list>
        {sorted.map((o) => {
          const at = choosable.indexOf(o);
          return (
            <OfferCard
              key={o.id}
              o={o}
              s={s}
              lang={L}
              parts={parts}
              materials={materials}
              selectable={at >= 0}
              selected={chosenOffer?.id === o.id}
              tabStop={o.id === tabStopId}
              onSelect={() => setChosen(o.id)}
              onDetails={() => openDetails(o)}
              onChat={() => chat(o)}
              radioRef={(el) => {
                if (at >= 0) radios.current[at] = el;
              }}
              onRadioKeyDown={(e) => onRadioKey(e, at)}
            />
          );
        })}
      </div>

      {/* The one gold verb of the screen: disabled, and saying why, until the customer chooses. */}
      {choosable.length > 0 && (
        <ActionDock className="-mx-4 mt-4 flex-col">
          {!chosenOffer && (
            <p id={hintId} className="text-center text-[12px] text-text-muted" data-offer-choose-first>
              {s.chooseOfferFirst}
            </p>
          )}
          <button
            type="button"
            aria-disabled={!chosenOffer || undefined}
            aria-describedby={chosenOffer ? undefined : hintId}
            onClick={() => {
              if (chosenOffer) setAccepting(chosenOffer);
            }}
            className={kitButtonClass('gold', 'cta', true)}
            data-offer-continue={chosenOffer?.id ?? ''}
          >
            {s.continueWithOffer}
          </button>
        </ActionDock>
      )}

      <Suspense fallback={null}>
        {asked.details && (
          <OfferDetailsSheet
            offer={detailsOf?.offer ?? null}
            showHistory={!!detailsOf?.history}
            materials={materials}
            parts={parts}
            canAct={!!detailsOf && canChoose(detailsOf.offer)}
            onClose={() => setDetailsOf(null)}
            onChat={chat}
            onDecline={decline}
            onHistory={(o) => openDetails(o, true)}
          />
        )}
        {asked.compare && <CompareSheet open={compareOpen} offers={offers} materials={materials} parts={parts} onClose={() => setCompareOpen(false)} />}
      </Suspense>

      <AcceptSheet
        offer={accepting}
        parts={parts}
        materials={materials}
        onClose={() => setAccepting(null)}
        onAccepted={(o) => {
          setAccepting(null);
          setChosen(null);
          toast.success(fill(s.youChose, { name: o.merchant?.name ?? s.theMerchant }));
          onChanged();
        }}
        onRefresh={onChanged}
      />
      {confirmDialog}
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
            className="lv-button lv-button-secondary lv-button-sm max-w-full justify-start pe-3 ps-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary"
            data-offer-file={f.kind}
          >
            {f.kind === 'image' ? <VariantImg sizes="32px" src={f.url!} alt="" loading="lazy" decoding="async" className="size-8 shrink-0 rounded-lg object-cover" /> : <FileGlyph kind={f.kind} />}
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


/** A refusal with a way out: its sentence and what «حدّث» does. */
type Notice = { code: 'OFFER_CHANGED' | 'OFFER_STALE' | 'OFFER_SUBSTITUTION_UNACCEPTED' | 'OFFER_PARTIAL_UNACCEPTED'; text: string };

function AcceptSheet({
  offer,
  parts,
  materials,
  onClose,
  onAccepted,
  onRefresh,
}: {
  offer: OfferV2 | null;
  parts: PartRef[];
  materials: CatalogMaterial[];
  onClose: () => void;
  onAccepted: (o: OfferV2) => void;
  onRefresh: () => void;
}) {
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
  // P1-05: the acknowledgements, each shown only when the offer needs it.
  const [ackPartial, setAckPartial] = useState(false);
  const [ackSubs, setAckSubs] = useState(false);

  useEffect(() => {
    if (!offer) return;
    setShown(offer);
    setAckPartial(false);
    setAckSubs(false);
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
      if (code === 'OFFER_SUBSTITUTION_UNACCEPTED' || code === 'OFFER_PARTIAL_UNACCEPTED') {
        // P1-05: what this offer needs acknowledged, on the fresh offer the refusal carries.
        const fresh = e instanceof ApiError ? (e.details?.offer as Partial<OfferV2> | undefined) : undefined;
        if (fresh) setShown({ ...o, ...fresh, merchant: o.merchant, files: o.files, history: o.history });
        setAckPartial(false);
        setAckSubs(false);
        setNotice({ code, text: apiRefusal(e, L, s.couldNotAccept) });
        return;
      }
      if (code === 'OFFER_CHANGED' || code === 'OFFER_STALE') {
        const fresh = e instanceof ApiError ? (e.details?.offer as Partial<OfferV2> | undefined) : undefined;
        if (fresh && code === 'OFFER_CHANGED') {
          // The fresh terms from the refusal itself: the total and the version the next press confirms.
          setShown({ ...o, ...fresh, merchant: o.merchant, files: o.files, history: o.history });
          setChanged(true);
          setAckPartial(false);
          setAckSubs(false);
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
  const needsPartial = !!o && isPartialOffer(o);
  const needsSubs = !!o && substitutesSomething(o);
  // A partial offer is acknowledged against the parts it leaves out, named —
  // never «—» while the parts of the request have not loaded (P1-05 review 3).
  const partsReady = !o || partialAckReady(o, parts);
  const acknowledged = (!needsPartial || (partsReady && ackPartial)) && (!needsSubs || ackSubs);
  const uncoveredNames = o ? coverageOf(o, parts).uncovered.map((p) => partName(p, s)).join(listSep(L)) : '';
  const subs = o ? substitutionPieces(o, parts, s, L, materials) : [];
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
            <Button variant="primary" block onClick={accept} disabled={!acknowledged} loadingLabel={s.holding} data-accept-confirm>
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
            <div role="status" className="lv-alert lv-alert-warning flex items-start justify-between gap-3" data-accept={notice.code === 'OFFER_STALE' ? 'stale' : 'changed'}>
              <span className="min-w-0 text-text-primary">{notice.text}</span>
              <Button size="sm" variant="secondary" onClick={refresh} className="shrink-0" data-accept-refresh>
                {s.refresh}
              </Button>
            </div>
          )}
          <div className="rounded-lg bg-surface-raised px-3.5 py-3">
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
          {subs.length > 0 && (
            <ul className="space-y-1 rounded-lg bg-surface-raised px-3.5 py-2.5 text-[12.5px] text-text-primary" aria-label={s.substitutesLabel} data-accept-substitutions>
              {subs.map((x) => (
                <li key={x.line} dir={readerDir(L)}>
                  <SubstitutionText x={x} s={s} dir={readerDir(L)} />
                </li>
              ))}
            </ul>
          )}
          {needsSubs && <Checkbox checked={ackSubs} onChange={setAckSubs} label={s.ackSubstitutions} data-accept-ack="substitutions" />}
          {needsPartial && partsReady && (
            <Checkbox checked={ackPartial} onChange={setAckPartial} label={fill(s.ackPartial, { parts: uncoveredNames })} data-accept-ack="partial" />
          )}
          {needsPartial && !partsReady && (
            <p className="flex items-start gap-2 text-[12px] leading-relaxed text-warning" role="status" data-accept-parts-missing>
              <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {s.partsNotLoaded}
            </p>
          )}
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
