/**
 * «خصص طابعتك» — the package card under the version selector (owner brief
 * 2026-11-17; DECISIONS row 339) as redesigned on 2026-11-19 (row 362).
 *
 * WHAT THE CUSTOMER READS IN TWO SECONDS, top to bottom:
 *   1. what the price on the page includes now (one line under the title);
 *   2. three packages, each with what it changes in the price — «مشمول في
 *      السعر», a minus or a plus — in one end-aligned column;
 *   3. how the printer arrives: Economy, Personal, or free warehouse pickup;
 *   4. «تخصيص بنفسي», which opens the detailed choices.
 *
 * THE ANCHOR (`offer.anchor`, row 362): the owner's rule is «today's price IS
 * the Smart Choice price». Smart Choice is then the choice the card opens
 * with — confirmed, because it is what the price pays for (the server prices a
 * line with no choice the same way) — «الطابعة فقط» shows what it takes off
 * the price, service by service, and «التجربة الكاملة» the difference.
 * Without an anchor nothing is chosen until the customer taps, and every
 * figure is the «+» price it always was.
 *
 * THE SELECTED STATE IS THE HOUSE'S OWN (`lv-choice`, DECISIONS row 207): the
 * row sinks into the selected fill and its gold check appears — the same cue
 * as «طريقة التوفر» above it, in both themes. It replaced a pure white slab
 * with black ink, which was the brightest thing on a dark page (owner: «white
 * very light … not very white»).
 *
 * Every figure is the server's, or the difference of two of them: a tile
 * shows the offer's package price against the anchor, the custom row the
 * quote's fee for the choice on screen. The page's add is allowed only when
 * the quote priced exactly this choice without a blocker (`onReady`); a
 * pending or failed quote says so instead. Delivery is asked here too when the
 * offer has it — required then, never defaulted.
 *
 * PHASE 7 (owner, 2026-11-20; DECISIONS row 363):
 *  - when the owner decides delivery at checkout (`offer.delivery.choose_at`), the
 *    «كيف تصلك الطابعة؟» block is not drawn and nothing waits for a delivery;
 *  - a choice without a warranty lists what it gives up (✕ lines) and its box says
 *    the same in one sentence; a warranty row also says the free return;
 *  - THE AGREEMENT GATE: while that box is unticked the page's «أضف إلى السلة»
 *    looks disabled (muted, aria-disabled — still focusable and pressable), and a
 *    press brings the box to the centre, focuses it, pulses it and says what to
 *    tick. The page's button is the product page's own element: this card (a lazy
 *    chunk) marks it and listens for its press, so the page's opening carries not
 *    one byte for the gate.
 */
import React, { Suspense, lazy, startTransition, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, SlidersHorizontal, Truck, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMoney } from '../../CurrencyContext';
import { useAuth } from '../../AuthContext';
import { PS_STRINGS, ackSentence, servicesErrorText } from './printerServicesStrings';
import { OPEN_MAP_LABEL, noteWithoutLinks } from '../../lib/noteLinks';
import { NoteLinkRow } from '../ui/NoteLinks';
import {
  AGREEMENT_HOT,
  AGREEMENT_HOT_MS,
  CHOSEN_EDGE,
  anchorOf,
  anchoredStart,
  asksDelivery,
  deliveryChoices,
  lostWith,
  needsAck,
  pointAtAgreement,
  deliveryFee,
  firstBlocker,
  moveRadioFocus,
  netFee,
  packageDelta,
  pickupOf,
  presetFrom,
  removedByJust,
  signedMoney,
  tabStop,
  quoteDraft,
  readyToBuy,
  verdictOf,
  type Delta,
  type DeliveryChoice,
  type DeliveryPick,
  type KitsFor,
  type QuoteBase,
  type QuotedServices,
  type QuoteState,
  type QuotedSelection,
  type ServiceSelection,
  type ServicesOffer,
} from './printerServicesModel';
import type { ExtrasLabels } from './CustomizeSheet';

/** «تخصيص بنفسي»: its code is fetched when the card is idle (and at the latest on the first open). */
const loadSheet = () => import('./CustomizeSheet');
const CustomizeSheet = lazy(loadSheet);

export interface PrinterPackagesProps {
  /** The quote's offer; null while the first quote is on its way (or failed). */
  offer: ServicesOffer | null;
  selection: ServiceSelection | null;
  /** The new choice, and whether it is complete on the customer's side (`readyToBuy`). */
  onChange: (next: ServiceSelection, ready: boolean) => void;
  /** The quote's pricing of `selection` (its `printer_services.selection`). */
  quoted: QuotedSelection | null;
  /** Whether `quoted` answers the choice on screen. */
  quoteState: QuoteState;
  /** The page's add may go ahead: complete AND priced by the server without a blocker. */
  onReady?: (ready: boolean) => void;
  /**
   * What the sheet's draft quotes are for: [slug, optionId, optionValueIds, colorId,
   * transport, fulfillment] — plain values, so the product page's opening carries no
   * request shape (its bundle budget); the body is built here, in the lazy chunk.
   */
  quoteFor?: readonly [string, string, readonly string[], string, string, string, number?] | null;
  /** What the sheet's summary shows. */
  printer: { name: string; image: string | null };
  /** Set by the page when the customer pressed «add» before finishing: the card says what is missing. */
  attention?: boolean;
  /**
   * The page's own add (the same request its button sends). The sheet's «أضف إلى
   * السلة» applies the choice, waits for the page's quote to price it, then calls this.
   */
  onAdd?: () => void;
  /** Whether the page can sell this selection at all (else the sheet offers «تطبيق» only). */
  addable?: boolean;
  /** The page's add is in flight. */
  adding?: boolean;
}

type PresetId = 'just' | 'smart' | 'complete';

/**
 * What the product page hands over: the quote's `printer_services` and the product
 * whole — unpacked here, in the lazy chunk, so the page's opening stays in its budget.
 */
export type PrinterPackagesPageProps = Omit<PrinterPackagesProps, 'offer' | 'quoted' | 'printer' | 'quoteState'> & {
  /** The page's quote answers the selection on screen. */
  fresh: boolean;
  /** The page's last quote failed (and none is on its way). */
  failed: boolean;
  ps: QuotedServices | null;
  product: { name?: string | null; images?: readonly string[] | null };
};

export default function PrinterPackages({ ps, product, fresh, failed, ...rest }: PrinterPackagesPageProps) {
  const offer = ps?.offer ?? null;
  const quoteState: QuoteState = fresh ? 'fresh' : failed ? 'failed' : 'pending';
  if (!offer) return fresh ? null : <PackagesWaiting failed={quoteState === 'failed'} />;
  return <Packages {...rest} quoteState={quoteState} offer={offer} quoted={ps?.selection ?? null} printer={{ name: product.name ?? '', image: product.images?.[0] ?? null }} />;
}

/** The card before the first quote answered: its title, and what it waits for. */
function PackagesWaiting({ failed }: { failed: boolean }) {
  const { lang: rawLang } = useLanguage();
  const s = PS_STRINGS[rawLang === 'en' || rawLang === 'ckb' ? rawLang : 'ar'];
  return (
    <section className="lv-surface min-w-0 p-3.5" data-printer-packages data-packages-state={failed ? 'failed' : 'pending'}>
      <h2 className="text-[15px] font-bold text-text-primary">{s.cardTitle}</h2>
      <p role={failed ? 'alert' : 'status'} className="mt-1 text-[12px] text-text-secondary">{failed ? s.quoteFailed : s.pending}</p>
    </section>
  );
}

function Packages({ offer, selection, onChange, quoted, quoteState, onReady, quoteFor, printer, attention, onAdd, addable = false, adding = false }: PrinterPackagesProps & { offer: ServicesOffer }) {
  // The language and the currency are read here, not passed: the product page's
  // opening stays as small as it was (tests/bundleBudget.test.ts).
  const { lang: rawLang, dir } = useLanguage();
  const lang = rawLang === 'en' || rawLang === 'ckb' ? rawLang : 'ar';
  const { money: fmt } = useMoney();
  const money = (v: number) => fmt(v);
  const { user } = useAuth();
  const s = PS_STRINGS[lang];
  const [sheet, setSheet] = useState(false);
  // Mounted on the first open and kept: closing then plays the sheet's exit
  // slide (and its focus hand-back) instead of vanishing on unmount.
  const [sheetMounted, setSheetMounted] = useState(false);
  const root = useRef<HTMLElement | null>(null);
  const ackBox = useRef<HTMLDivElement | null>(null);
  // Phase 7: every refused press of «add» while the agreement is unticked (a counter: each press points again).
  const [pointed, setPointed] = useState(0);
  const [hot, setHot] = useState(false);
  const gate = useRef(false);
  const lastPoint = useRef(0);
  const point = useCallback(() => {
    // One press reaches here twice (the button's own press, then the page's «attention»): once is enough.
    const now = Date.now();
    if (now - lastPoint.current < 250) return;
    lastPoint.current = now;
    setPointed((n) => n + 1);
  }, []);
  // The page asked to add before the choice was complete: bring the card — or the agreement box — into view.
  useEffect(() => {
    if (!attention) return;
    if (gate.current) point();
    else root.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [attention, point]);
  useEffect(() => {
    if (!pointed) return;
    pointAtAgreement(ackBox.current);
    setHot(true);
    const t = window.setTimeout(() => setHot(false), AGREEMENT_HOT_MS);
    return () => window.clearTimeout(t);
  }, [pointed]);
  /*
   * A TAP PAINTS FIRST. The choice lives in the product page, and handing it
   * over re-renders that whole page (and asks for a new quote). So the card
   * draws the tapped choice at once from `shown` (urgent, this card only) and
   * hands it to the page in a transition, which React may spread over frames.
   * Measured at 4x CPU throttle (dev build): the tap's long tasks were
   * 134-331 ms before this. Everything that decides — the verdict, the add,
   * the quote — still reads the page's committed `selection`, never `shown`.
   */
  const [optimistic, setOptimistic] = useState<{ base: ServiceSelection | null; next: ServiceSelection } | null>(null);
  const shown = optimistic && optimistic.base === selection ? optimistic.next : selection;
  const change = (next: ServiceSelection) => {
    setOptimistic({ base: selection, next });
    startTransition(() => onChange(next, readyToBuy(next, offer)));
  };
  // The page's add follows the server: ready only for a fresh quote of this choice with no blocker.
  const verdict = verdictOf(selection, offer, quoted, quoteState);
  const blocker = verdict === 'blocked' ? firstBlocker(quoted) : null;
  const ready = verdict === 'ready';
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  useEffect(() => { readyRef.current?.(ready); }, [ready]);
  useEffect(() => () => readyRef.current?.(false), []);
  /*
   * The sheet's «أضف إلى السلة»: the choice is applied, then the page's own add
   * runs once the page's quote priced exactly that choice without a blocker.
   * Two steps on purpose: `onReady(true)` reaches the page in an effect, so the
   * add is called one render LATER, from the page's re-rendered callback (which
   * then sees `svcReady`). A refusal or a failed quote cancels it; the card
   * then says why, and the choice stays applied.
   */
  const [queued, setQueued] = useState<'no' | 'wait' | 'fire'>('no');
  // The choice the queued add is for: it fires only once the PAGE holds exactly it.
  const queuedFor = useRef('');
  const committedKey = JSON.stringify(selection);
  const addRef = useRef(onAdd);
  addRef.current = onAdd;
  useEffect(() => {
    if (queued === 'wait') {
      if (committedKey !== queuedFor.current) return;
      if (verdict === 'ready') setQueued('fire');
      else if (verdict !== 'pending') setQueued('no');
    } else if (queued === 'fire') {
      setQueued('no');
      addRef.current?.();
    }
  }, [queued, verdict, committedKey]);
  /*
   * THE ANCHOR'S OPENING CHOICE (row 362). The price on the page is the Smart
   * Choice price, so an untouched card holds Smart Choice — handed to the page
   * like a tap, because the page's add and the server's quote read the page's
   * choice. Only while the page holds NO choice: a choice the customer made is
   * never replaced, and after an add (the page clears it) Smart is back.
   */
  const anchor = anchorOf(offer);
  const opening = selection === null ? anchoredStart(offer) : null;
  const openingKey = opening ? JSON.stringify(opening) : '';
  useEffect(() => {
    if (openingKey) change(JSON.parse(openingKey) as ServiceSelection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openingKey]);
  // Delivery switched off after it was chosen — or the pickup taken away: the choice no longer carries it (the server would refuse it).
  // Phase 7: nor one the page no longer asks for (decided at checkout) or a disabled Personal.
  const staleDelivery = !!selection?.delivery && !deliveryChoices(offer).includes(selection.delivery as DeliveryPick);
  useEffect(() => {
    if (staleDelivery && selection) change({ ...selection, delivery: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staleDelivery]);
  const quoteBase: QuoteBase | null = quoteFor
    ? {
        slug: quoteFor[0],
        body: {
          qty: 1,
          optionId: quoteFor[1] || undefined,
          optionValueIds: quoteFor[2].length ? quoteFor[2] : undefined,
          colorId: quoteFor[3] || undefined,
          transportMethod: quoteFor[4] || undefined,
          fulfillmentType: quoteFor[5] || undefined,
        },
      }
    : null;
  const baseKey = quoteBase ? JSON.stringify(quoteBase) : '';
  const sheetQuote = useCallback(
    (sel: ServiceSelection, signal: AbortSignal) => quoteDraft(JSON.parse(baseKey) as QuoteBase, sel, signal),
    [baseKey]
  );
  // The owner's kits are priced for this exact version, order type, route and the page's printer quantity
  // (a kit is one per printer unit: its items follow the printer's quantity).
  const kitsKey = quoteFor
    ? JSON.stringify({ slug: quoteFor[0], optionValueIds: quoteFor[2], fulfillmentType: quoteFor[5] || undefined, transportMethod: quoteFor[4] || undefined, qty: Math.max(1, quoteFor[6] ?? 1) } satisfies KitsFor)
    : '';
  const kitsFor = useMemo(() => (kitsKey ? (JSON.parse(kitsKey) as KitsFor) : null), [kitsKey]);
  /*
   * THE SHEET IS READY BEFORE IT IS OPENED (owner, 2026-11-19: «the filament
   * kit and subscription is delayed to show»). Its code, the kits / add-ons /
   * bundles answer and the membership options used to be asked for only after
   * the tap — the kit list painted about 1.9 s after its row was opened on the
   * live site. Now: once the card is idle (and at once when a finger lands on
   * it) the chunk is fetched and both lists are asked for, each once per key;
   * the sheet reads the same answers (printerServicesModel `warmed`).
   */
  const userId = user?.id ?? null;
  const offerRef = useRef(offer);
  offerRef.current = offer;
  const warmNow = useCallback(() => {
    void loadSheet().then((m) => m.warmSheet(offerRef.current, kitsKey ? (JSON.parse(kitsKey) as KitsFor) : null, lang, userId)).catch(() => undefined);
  }, [kitsKey, lang, userId]);
  const offeredKey = `${offer.kits.length}|${(offer.addons ?? []).length}|${(offer.store_bundles ?? []).length}|${offer.membership ? 1 : 0}`;
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(warmNow, { timeout: 1200 });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(warmNow, 250);
    return () => window.clearTimeout(id);
  }, [warmNow, offeredKey]);
  const titleId = useId();
  const deliveryId = useId();
  const ackHintId = useId();
  /*
   * THE AGREEMENT GATE (phase 7). `gated` = a confirmed choice without a warranty whose box is unticked.
   * The page's «أضف إلى السلة» (its buttons carry data-testid="product-cta") is marked from here after
   * every render — aria-disabled and a muted look, never `disabled`: it stays focusable and pressable —
   * and unmarked the moment the box is ticked. A press while gated is refused by the page (the card's
   * verdict is not «ready»); this card hears it and points at the box.
   */
  const gated = needsAck(shown);
  gate.current = gated;
  useEffect(() => {
    markPageAdd(gated);
  });
  useEffect(() => () => markPageAdd(false), []);
  useEffect(() => {
    if (!gated) { setHot(false); return; }
    const onPress = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.(PAGE_ADD)) point();
    };
    document.addEventListener('click', onPress, true);
    return () => document.removeEventListener('click', onPress, true);
  }, [gated, point]);
  const lost = lostWith(shown);
  const chosen: PresetId | 'custom' | null = shown?.confirmed ? shown.package : null;
  const delivery = (shown?.delivery ?? null) as DeliveryPick | null;

  // Each preset's line says what it holds, read from the offer the server sent
  // (never a fixed sentence that could disagree with the price beside it).
  const removed = removedByJust(offer);
  const serviceName = { warranty: s.warranty, care: s.care, packaging: s.packagingExtra, inspection: s.inspectionOption };
  const rows: Array<{ id: PresetId; name: string; sub: string; delta: Delta | null }> = [
    { id: 'just', name: s.just, sub: s.justSub, delta: packageDelta(offer, 'just') },
    { id: 'smart', name: s.smart, sub: includesText(offer, 'smart', s) || s.smartSub, delta: packageDelta(offer, 'smart') },
    { id: 'complete', name: s.complete, sub: includesText(offer, 'complete', s) || s.completeSub, delta: packageDelta(offer, 'complete') },
  ];
  const packageStop = tabStop(rows.map((r) => r.id), chosen === 'custom' ? null : chosen, (id) => rows.find((r) => r.id === id)?.delta !== null);
  const deliveryIds = deliveryChoices(offer);
  const deliveryStop = tabStop(deliveryIds, delivery, (d) => deliveryFee(offer, d) !== null);
  // The owner's pickup line may carry the map (row 365): its words go in the choice, its link under the group
  // (an anchor cannot sit inside the choice button).
  const pickupLine = pickupOf(offer)?.note?.[lang] ?? '';
  const pickupNote = noteWithoutLinks(pickupLine) || s.deliveryPickupSub;
  const deliveryRows: Record<DeliveryPick, { name: string; sub: string }> = {
    economy: { name: s.deliveryEconomy, sub: s.deliveryEconomySub },
    personal: { name: s.deliveryPersonal, sub: s.deliveryPersonalSub },
    pickup: { name: s.deliveryPickup, sub: pickupNote },
  };

  // The membership and the kit chosen in the sheet (phase 2) stay with a later package tap.
  const extras = shown?.extras ? { extras: shown.extras } : {};
  /*
   * Phase 2: another version of the printer has other kits, and an offer that no longer carries the
   * membership row or this kit cannot sell it — the choice is cleared, never sent as a hidden extra.
   * (The page clears both after a successful add: the next add starts with none.)
   */
  const versionKey = quoteFor ? JSON.stringify([quoteFor[0], [...quoteFor[2]].sort()]) : '';
  const lastVersion = useRef(versionKey);
  const heldKit = selection?.extras?.kitId ?? null;
  const heldPlan = selection?.extras?.membershipPlanId ?? null;
  useEffect(() => {
    const switched = lastVersion.current !== versionKey;
    lastVersion.current = versionKey;
    if (!selection?.extras || (!heldKit && !heldPlan)) return;
    // The offer is judged only once it answers the selection on screen.
    const dropKit = !!heldKit && (switched || (quoteState === 'fresh' && !offer.kits.some((k) => k.id === heldKit)));
    const dropPlan = !!heldPlan && quoteState === 'fresh' && !offer.membership;
    if (dropKit || dropPlan) change({ ...selection, extras: { ...selection.extras, ...(dropKit ? { kitId: null } : {}), ...(dropPlan ? { membershipPlanId: null } : {}) } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionKey, quoteState, offer, heldKit, heldPlan]);
  // The names the sheet gave the chosen extras (shown on the card while they are still the choice).
  const [extrasNames, setExtrasNames] = useState<{ plan: string | null; planName: string; kit: string | null; kitName: string }>({ plan: null, planName: '', kit: null, kitName: '' });
  const remember = (next: ServiceSelection, labels?: ExtrasLabels) =>
    setExtrasNames({ plan: next.extras?.membershipPlanId ?? null, planName: labels?.membership ?? '', kit: next.extras?.kitId ?? null, kitName: labels?.kit ?? '' });
  const shownPlan = shown?.extras?.membershipPlanId ?? null;
  const shownKit = shown?.extras?.kitId ?? null;
  const planName = shownPlan && extrasNames.plan === shownPlan ? extrasNames.planName : '';
  const kitName = shownKit ? offer.kits.find((k) => k.id === shownKit)?.title[lang] || (extrasNames.kit === shownKit ? extrasNames.kitName : '') : '';
  const pick = (id: PresetId) => {
    const next = presetFrom(offer, id, delivery);
    if (next) change({ ...next, ...extras, confirmed: true });
  };
  const setDelivery = (d: DeliveryPick) => {
    const held = d as DeliveryChoice;
    if (shown) change({ ...shown, delivery: held });
    else change({ ...(presetFrom(offer, 'just', d) as ServiceSelection), ...extras, package: 'just', confirmed: false, delivery: held });
  };

  // The quote's fee for the choice on screen — a server figure, shown only while it answers this choice.
  const fee = quoteState === 'fresh' && quoted && !blocker ? quoted.fee_iqd : null;
  // Under an anchor the custom row says what the choice does to the PRICE (the server's net figure).
  const net = fee !== null && quoted && anchor ? netFee(quoted) : null;
  const customSaid =
    chosen !== 'custom' || fee === null ? s.customizeSub
    : net === null ? `${s.custom} · + ${money(fee)}`
    : `${s.custom} · ${net === 0 ? s.included : signedMoney(net, money)}`;
  const missing =
    verdict === 'incomplete'
      ? !selection?.confirmed ? (asksDelivery(offer) ? s.chooseFirst : s.choosePackage) : asksDelivery(offer) && delivery === null ? s.deliveryChoose : s.ackAsk
      : verdict === 'pending' ? s.pending
      : null;
  // Said without waiting for a press: the server refused this choice, or its prices could not be read.
  const standing = verdict === 'blocked' ? servicesErrorText(blocker, lang) || s.unavailable : verdict === 'failed' ? s.quoteFailed : null;
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  // The agreement panel: right under «الطابعة فقط» when that is the choice, under the rows for a custom choice without a warranty.
  const ackPanel = shown?.confirmed && shown.warranty === 'none' ? (
        <div ref={ackBox} style={hot && gated ? AGREEMENT_HOT : undefined} className="animate-in fade-in slide-in-from-top-2 duration-200 motion-reduce:animate-none mt-2 rounded-xl border border-border-subtle p-3" data-no-warranty-warning data-agreement={gated ? (hot ? 'pointed' : 'needed') : 'given'}>
          {/* What this choice gives up — read from the choice itself, each line with its ✕. */}
          <p className="text-[12.5px] font-bold text-text-primary">{s.loseTitle}</p>
          <ul className="mt-1 space-y-0.5" data-lost>
            {lost.map((k) => (
              <li key={k} className="flex items-center gap-1.5 text-[12.5px] font-medium text-text-primary" data-lost-line={k}>
                <X aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-danger" /> {s.lose[k]}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-secondary">{s.rightsStay}</p>
          <label className="mt-1.5 flex min-h-11 cursor-pointer items-center gap-2.5 text-[13px] font-medium text-text-primary">
            <input
              type="checkbox"
              className="h-5 w-5 shrink-0" style={{ accentColor: 'var(--color-gold)' }}
              checked={shown.ack_no_warranty}
              aria-describedby={hot && gated ? ackHintId : undefined}
              onChange={(e) => change({ ...shown, ack_no_warranty: e.target.checked })}
              data-agreement-box
            />
            <span>{ackSentence(s, lost)}</span>
          </label>
          {hot && gated ? <p id={ackHintId} role="alert" className="mt-1 text-[12px] font-bold text-warning" data-agreement-ask>{s.ackAsk}</p> : null}
        </div>
  ) : null;
  const keyDir = dir === 'rtl' ? 'rtl' : 'ltr';

  return (
    <section ref={root} className="lv-surface min-w-0 p-3.5" aria-labelledby={titleId} data-printer-packages data-anchored={anchor ? 'smart' : undefined} onPointerDown={warmNow}>
      <h2 id={titleId} className="text-[15px] font-bold tracking-[-0.01em] text-text-primary">{s.cardTitle}</h2>
      {/* What the price on the page includes NOW — the first thing read. */}
      <p className="mt-0.5 text-[12px] leading-snug text-text-secondary" data-packages-includes>{anchor ? s.priceIncludes(s.smart) : s.cardSub}</p>

      {/* Three rows, one decision each, their figures in one column. Arrow keys
          move focus; Enter, Space or a tap chooses. */}
      <div className="mt-3 space-y-2" role="radiogroup" aria-labelledby={titleId} onKeyDown={(e) => moveRadioFocus(e, keyDir)}>
        {rows.map((t) => {
          const on = chosen === t.id;
          // Without an anchor the recommendation is only drawn (dashed) while nothing is
          // chosen, and never checked: a pressed row is a chosen one.
          const suggested = chosen === null && t.id === 'smart';
          const unavailable = t.delta === null;
          const lines = t.id === 'just' ? removed : [];
          return (
            <React.Fragment key={t.id}>
            <button
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={packageStop === t.id ? 0 : -1}
              disabled={unavailable}
              onClick={() => pick(t.id)}
              data-package={t.id}
              data-suggested={suggested || undefined}
              style={on ? CHOSEN_EDGE : undefined}
              className={`lv-choice flex min-h-14 w-full items-start gap-2.5 px-3 py-2.5 text-start [touch-action:manipulation] disabled:opacity-50 ${suggested ? 'border-dashed' : ''}`}
            >
              <Mark />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-[14px] font-bold leading-tight text-text-primary">{t.name}</span>
                    {t.id === 'smart' ? <span className="shrink-0 text-[10px] font-bold leading-4 text-gold">{s.recommended}</span> : null}
                  </span>
                  <Figure delta={t.delta} money={money} included={s.included} zero={money(0)} />
                </span>
                {lines.length ? (
                  // «الطابعة فقط» under the anchor: what leaves the price with it, each with its own figure.
                  <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] leading-snug text-text-secondary" data-package-removes>
                    {lines.map((l) => (
                      <span key={l.service} className="whitespace-nowrap">
                        {serviceName[l.service]} <bdi className="tabular-nums">{signedMoney(l.iqd, money)}</bdi>
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="mt-1 block text-[11.5px] leading-snug text-text-secondary">{t.sub}</span>
                )}
              </span>
            </button>
            {t.id === 'just' && on ? ackPanel : null}
            </React.Fragment>
          );
        })}
      </div>

      {chosen !== 'just' ? ackPanel : null}

      {asksDelivery(offer) ? (
        <div className="mt-4">
          <p id={deliveryId} className="mb-2 flex items-center gap-1.5 text-[13px] font-bold text-text-primary">
            <Truck aria-hidden="true" className="w-4 h-4 text-text-secondary" /> {s.deliveryHow}
          </p>
          <div className="space-y-2" role="radiogroup" aria-labelledby={deliveryId} onKeyDown={(e) => moveRadioFocus(e, keyDir)}>
            {deliveryIds.map((d) => {
              const price = deliveryFee(offer, d);
              const on = delivery === d;
              return (
                <button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={deliveryStop === d ? 0 : -1}
                  disabled={price === null}
                  onClick={() => setDelivery(d)}
                  data-delivery={d}
                  style={on ? CHOSEN_EDGE : undefined}
                  className="lv-choice flex min-h-12 w-full items-start gap-2.5 px-3 py-2 text-start [touch-action:manipulation] disabled:opacity-50"
                >
                  <Mark />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="text-[13px] font-bold leading-tight text-text-primary">{deliveryRows[d].name}</span>
                      <span className={`shrink-0 text-[12.5px] font-bold tabular-nums ${price === 0 ? 'text-success' : 'text-text-primary'}`}>
                        {price === null ? s.unavailable : price === 0 ? s.free : <bdi>{signedMoney(price, money)}</bdi>}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[11.5px] leading-snug text-text-secondary" data-delivery-note={d}>{deliveryRows[d].sub}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {deliveryIds.includes('pickup') ? <NoteLinkRow text={pickupLine} label={OPEN_MAP_LABEL[lang]} lead={s.deliveryPickup} /> : null}
        </div>
      ) : null}

      {/* «تخصيص بنفسي» opens the detailed choices; it is the pressed row while a custom choice is the one in force. */}
      <button
        type="button"
        onClick={() => { setSheetMounted(true); setSheet(true); }}
        aria-haspopup="dialog"
        data-selected={chosen === 'custom'}
        style={chosen === 'custom' ? CHOSEN_EDGE : undefined}
        className="lv-choice mt-4 flex min-h-12 w-full items-center gap-2.5 px-3 py-2 text-start [touch-action:manipulation]"
        data-customize-open
      >
        <SlidersHorizontal aria-hidden="true" className="w-4 h-4 shrink-0 text-gold" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-bold text-text-primary">{s.customize}</span>
          <span className="block text-[11.5px] leading-snug text-text-secondary" dir="auto">{customSaid}</span>
        </span>
        <Chevron aria-hidden="true" className="w-4 h-4 shrink-0 text-text-secondary" />
      </button>
      {/* Phase 2: the membership and the kit chosen with this printer — their own cart lines, priced there. */}
      {shownPlan || shownKit ? (
        <div className="mt-2 space-y-0.5 text-[11.5px] text-text-secondary" data-packages-extras>
          {shownPlan ? <p className="truncate" data-packages-membership={shownPlan}>{s.membership}{planName ? `: ${planName}` : ''}</p> : null}
          {shownKit ? <p className="truncate" data-packages-kit={shownKit}>{s.filament}{kitName ? `: ${kitName}` : ''}</p> : null}
          <p>{s.extrasBeside}</p>
        </div>
      ) : null}

      {/* What Levo Care includes, wherever it is on sale (DECISIONS row 359): one calm line. */}
      {offer.care ? (
        <p className="mt-3 text-[11.5px] leading-relaxed text-text-muted" data-packages-care-includes>{s.care} — {s.careIncludes(offer.care.max_discount_pct ?? 90)}</p>
      ) : null}

      {standing ? (
        <p role="alert" className="animate-in fade-in slide-in-from-top-2 duration-200 motion-reduce:animate-none mt-2 text-[12px] text-text-primary" data-packages-blocked>{standing}</p>
      ) : attention && missing ? (
        <p role="alert" className="animate-in fade-in slide-in-from-top-2 duration-200 motion-reduce:animate-none mt-2 text-[12px] font-bold text-warning" data-packages-missing>{missing}</p>
      ) : null}
      {sheetMounted ? (
        <Suspense fallback={null}>
          <CustomizeSheet
            open={sheet}
            onClose={() => setSheet(false)}
            onApply={(next, labels) => { remember(next, labels); change(next); setSheet(false); }}
            onApplyAndAdd={onAdd && addable ? (next, labels) => { remember(next, labels); change(next); queuedFor.current = JSON.stringify(next); setQueued('wait'); setSheet(false); } : undefined}
            adding={adding || queued !== 'no'}
            offer={offer}
            current={selection}
            printer={{ ...printer, versionLabel: '' }}
            lang={lang}
            money={money}
            quote={quoteBase ? sheetQuote : undefined}
            kitsFor={kitsFor}
          />
        </Suspense>
      ) : null}
    </section>
  );
}

/** The product page's own «أضف إلى السلة» buttons (the buy column's and the sticky bar's). */
const PAGE_ADD = '[data-testid="product-cta"]';

/**
 * Marks (or clears) the page's add buttons as waiting for the agreement: aria-disabled and a muted
 * look, set on the elements themselves — the page renders neither attribute, so React leaves them be,
 * and a button the page draws later is marked by the card's next render. Never `disabled`: the press
 * must still arrive, so it can point at the box.
 */
function markPageAdd(gated: boolean): void {
  if (typeof document === 'undefined') return;
  document.querySelectorAll<HTMLElement>(PAGE_ADD).forEach((el) => {
    if (gated) {
      el.setAttribute('aria-disabled', 'true');
      el.dataset.agreementGate = '';
      el.style.opacity = '0.5';
      el.style.filter = 'grayscale(1)';
    } else if ('agreementGate' in el.dataset) {
      el.removeAttribute('aria-disabled');
      delete el.dataset.agreementGate;
      el.style.opacity = '';
      el.style.filter = '';
    }
  });
}

/**
 * The chosen mark: a ring that is always there (these are radio rows), and the
 * house's gold check inside it once the row is the chosen one (`lv-choice-mark`
 * fades and scales in on its own).
 */
function Mark() {
  return (
    <span aria-hidden="true" className="mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border border-text-muted">
      <span className="lv-choice-mark"><Check className="h-3 w-3" /></span>
    </span>
  );
}

/** A row's figure in the end column: «مشمول في السعر», a minus, a plus — or the plain zero of an unanchored «الطابعة فقط». */
function Figure({ delta, money, included, zero }: { delta: Delta | null; money: (v: number) => string; included: string; zero: string }) {
  if (!delta) return <span className="shrink-0 text-[13px] font-bold text-text-muted">—</span>;
  if (delta.included) return <span className="shrink-0 text-[11.5px] font-bold text-gold" data-figure="included">{included}</span>;
  return (
    <bdi className="shrink-0 text-[13px] font-bold tabular-nums text-text-primary" data-figure={delta.iqd < 0 ? 'minus' : 'plus'}>
      {delta.iqd === 0 ? zero : signedMoney(delta.iqd, money)}
    </bdi>
  );
}

/** A preset's contents, shortest form: «الضمان 12 شهر · Levo Care +12 شهر · فحص كامل» (Care runs after the warranty). */
function includesText(offer: ServicesOffer, id: 'smart' | 'complete', s: (typeof PS_STRINGS)['ar']): string {
  const inc = offer.packages[id]?.includes;
  if (!inc) return '';
  const parts: string[] = [];
  // Phase 7: a package with a warranty also gives the free return (the owner's rule, row 363).
  if (inc.warranty !== 'none') parts.push(`${s.warranty} ${s.months(inc.warranty === 'w12' ? 12 : 24)}`, s.freeReturn);
  if (inc.care === 'c12') parts.push(`${s.care} +${s.months(12)}`);
  if (inc.packaging === 'extra') parts.push(s.packagingExtra);
  if (inc.inspection === 'full') parts.push(s.inspectionOption);
  return parts.join(' · ');
}
