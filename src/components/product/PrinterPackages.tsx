/**
 * «خصص طابعتك» — the THIN package card under the version selector (owner brief
 * 2026-11-17; DECISIONS row 339; reference image «12_40_10»).
 *
 * Three presets and one «تخصيص بنفسي» row. Smart Choice is drawn as the
 * recommendation, but nothing is chosen until the customer taps: the page
 * holds `selection = null` and the cart refuses until `confirmed` (a visual
 * default is never consent). Just Printer asks for its one acknowledgment.
 * Delivery is asked here too when the offer has it — required then, never
 * defaulted — in one compact row. Monochrome on purpose: a white tile is the
 * chosen one; the recommendation is only outlined, never filled.
 *
 * Every figure is the server's: a tile shows the offer's package price, the
 * custom row the quote's `fee_iqd` for the choice on screen. The page's add is
 * allowed only when the quote priced exactly this choice without a blocker
 * (`onReady`); a pending or failed quote says so instead.
 */
import React, { Suspense, lazy, startTransition, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, SlidersHorizontal, Truck } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMoney } from '../../CurrencyContext';
import { PS_STRINGS, servicesErrorText } from './printerServicesStrings';
import {
  deliveryFee,
  firstBlocker,
  moveRadioFocus,
  presetFrom,
  tabStop,
  quoteDraft,
  readyToBuy,
  verdictOf,
  type DeliveryChoice,
  type QuoteBase,
  type QuotedServices,
  type QuoteState,
  type QuotedSelection,
  type ServiceSelection,
  type ServicesOffer,
} from './printerServicesModel';
import type { ExtrasLabels } from './CustomizeSheet';

/** «تخصيص بنفسي»: its code loads on the first open. */
const CustomizeSheet = lazy(() => import('./CustomizeSheet'));

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
    <section className="lv-surface min-w-0 p-3" data-printer-packages data-packages-state={failed ? 'failed' : 'pending'}>
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
  const s = PS_STRINGS[lang];
  const [sheet, setSheet] = useState(false);
  // Mounted on the first open and kept: closing then plays the sheet's exit
  // slide (and its focus hand-back) instead of vanishing on unmount.
  const [sheetMounted, setSheetMounted] = useState(false);
  const root = useRef<HTMLElement | null>(null);
  // The page asked to add before the choice was complete: bring the card into view.
  useEffect(() => {
    if (attention) root.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [attention]);
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
  // Delivery switched off after it was chosen: the choice no longer carries it (the server would refuse it).
  const staleDelivery = !offer.delivery && !!selection?.delivery;
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
  const titleId = useId();
  const chosen: PresetId | 'custom' | null = shown?.confirmed ? shown.package : null;
  const delivery = shown?.delivery ?? null;

  // Each preset's line says what it holds, read from the offer the server sent
  // (never a fixed sentence that could disagree with the price beside it).
  const rows: Array<{ id: PresetId; name: string; sub: string; price: number | null }> = [
    { id: 'just', name: s.just, sub: s.justSub, price: 0 },
    { id: 'smart', name: s.smart, sub: includesText(offer, 'smart', s) || s.smartSub, price: offer.packages.smart?.price_iqd ?? null },
    { id: 'complete', name: s.complete, sub: includesText(offer, 'complete', s) || s.completeSub, price: offer.packages.complete?.price_iqd ?? null },
  ];
  const packageStop = tabStop(rows.map((r) => r.id), chosen === 'custom' ? null : chosen, (id) => rows.find((r) => r.id === id)?.price !== null);
  const deliveryIds = ['economy', 'personal'] as const;
  const deliveryStop = tabStop(deliveryIds, delivery, (d) => deliveryFee(offer, d) !== null);

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
  const setDelivery = (d: DeliveryChoice) => {
    if (shown) change({ ...shown, delivery: d });
    else change({ ...(presetFrom(offer, 'just', d) as ServiceSelection), ...extras, package: 'just', confirmed: false, delivery: d });
  };

  // The quote's fee for the choice on screen — a server figure, shown only while it answers this choice.
  const fee = quoteState === 'fresh' && quoted && !blocker ? quoted.fee_iqd : null;
  const missing =
    verdict === 'incomplete'
      ? !selection?.confirmed ? s.chooseFirst : offer.delivery && delivery === null ? s.deliveryChoose : s.justAck
      : verdict === 'pending' ? s.pending
      : null;
  // Said without waiting for a press: the server refused this choice, or its prices could not be read.
  const standing = verdict === 'blocked' ? servicesErrorText(blocker, lang) || s.unavailable : verdict === 'failed' ? s.quoteFailed : null;
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const keyDir = dir === 'rtl' ? 'rtl' : 'ltr';

  return (
    <section ref={root} className="lv-surface min-w-0 p-3.5" aria-labelledby={titleId} data-printer-packages>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={titleId} className="text-[15px] font-bold tracking-[-0.01em] text-text-primary">{s.cardTitle}</h2>
        <p className="truncate text-[12px] text-text-secondary">{s.cardSub}</p>
      </div>

      {/* Three compact rows, one decision each. Arrow keys move focus; Enter,
          Space or a tap chooses — a package is never chosen for the customer. */}
      <div className="mt-3 space-y-2" role="radiogroup" aria-labelledby={titleId} onKeyDown={(e) => moveRadioFocus(e, keyDir)}>
        {rows.map((t) => {
          const on = chosen === t.id;
          // The recommendation is drawn only while nothing is chosen, and it is
          // never checked: outlined (dashed), never filled — a filled row is a chosen one.
          const suggested = chosen === null && t.id === 'smart';
          const unavailable = t.price === null;
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={packageStop === t.id ? 0 : -1}
              disabled={unavailable}
              onClick={() => pick(t.id)}
              data-package={t.id}
              data-suggested={suggested || undefined}
              className={`flex min-h-14 w-full items-center gap-3 rounded-xl border px-3 py-2 text-start press-scale [touch-action:manipulation] disabled:opacity-50 ${
                on ? 'bg-white text-black border-transparent' : suggested ? 'border-dashed border-text-muted text-text-primary' : 'border-border-subtle text-text-primary'
              }`}
            >
              <Radio on={on} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold leading-tight">{t.name}</span>
                  {t.id === 'smart' ? (
                    <span className={`shrink-0 rounded-full border px-1.5 text-[10px] leading-4 ${on ? 'border-current/10' : 'border-border-subtle text-text-secondary'}`}>{s.recommended}</span>
                  ) : null}
                </span>
                <span className={`mt-0.5 block text-[11.5px] leading-snug line-clamp-2 ${on ? 'opacity-70' : 'text-text-secondary'}`}>{t.sub}</span>
              </span>
              <span className="shrink-0 text-[13px] font-semibold tabular-nums" dir="auto">
                {unavailable ? '—' : t.price === 0 ? money(0) : `+${money(t.price!)}`}
              </span>
            </button>
          );
        })}
      </div>

      {shown?.confirmed && shown.warranty === 'none' ? (
        <div className="animate-in fade-in slide-in-from-top-2 duration-200 motion-reduce:animate-none mt-2 rounded-xl border border-border-subtle p-3" data-no-warranty-warning>
          <p className="text-[12px] leading-relaxed text-text-secondary">{s.justWarning}</p>
          <label className="mt-1.5 flex min-h-11 cursor-pointer items-center gap-2.5 text-[13px] font-medium text-text-primary">
            <input
              type="checkbox"
              className="h-5 w-5 shrink-0" style={{ accentColor: '#fff' }}
              checked={shown.ack_no_warranty}
              onChange={(e) => change({ ...shown, ack_no_warranty: e.target.checked })}
            />
            {s.justAck}
          </label>
        </div>
      ) : null}

      {offer.delivery ? (
        <div className="mt-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-[12px] text-text-secondary">
            <Truck aria-hidden="true" className="w-4 h-4" /> {s.delivery}
          </p>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={s.delivery} onKeyDown={(e) => moveRadioFocus(e, keyDir)}>
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
                  className={`flex min-h-12 items-center gap-2 rounded-xl border px-2.5 py-1.5 text-start press-scale [touch-action:manipulation] disabled:opacity-50 ${on ? 'bg-white text-black border-transparent' : 'border-border-subtle text-text-primary'}`}
                >
                  <Radio on={on} />
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] font-semibold">{d === 'economy' ? s.deliveryEconomy : s.deliveryPersonal}</span>
                    <span className={`block text-[11px] tabular-nums ${on ? 'opacity-70' : 'text-text-secondary'}`} dir="auto">
                      {price === null ? s.unavailable : `+${money(price)}`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => { setSheetMounted(true); setSheet(true); }}
        aria-haspopup="dialog"
        className={`mt-3 flex min-h-12 w-full items-center gap-2.5 rounded-xl border px-3 text-start press-scale [touch-action:manipulation] ${chosen === 'custom' ? 'bg-white text-black border-transparent' : 'border-border-subtle text-text-primary'}`}
        data-customize-open
      >
        <SlidersHorizontal aria-hidden="true" className="w-4 h-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold">{s.customize}</span>
          <span className={`block truncate text-[11.5px] ${chosen === 'custom' ? 'opacity-70' : 'text-text-secondary'}`}>
            {chosen === 'custom' && fee !== null ? `${s.custom} · + ${money(fee)}` : s.customizeSub}
          </span>
        </span>
        <Chevron aria-hidden="true" className="w-4 h-4 shrink-0" />
      </button>
      {/* Phase 2: the membership and the kit chosen with this printer — their own cart lines, priced there. */}
      {shownPlan || shownKit ? (
        <div className="mt-2 space-y-0.5 text-[11.5px] text-text-secondary" data-packages-extras>
          {shownPlan ? <p className="truncate" data-packages-membership={shownPlan}>{s.membership}{planName ? `: ${planName}` : ''}</p> : null}
          {shownKit ? <p className="truncate" data-packages-kit={shownKit}>{s.filament}{kitName ? `: ${kitName}` : ''}</p> : null}
          <p>{s.extrasApart}</p>
        </div>
      ) : null}

      {/* What Levo Care includes, wherever it is on sale (DECISIONS row 359): one calm line. */}
      {offer.care ? (
        <p className="mt-2 text-[11.5px] leading-relaxed text-text-secondary" data-packages-care-includes>{s.care} — {s.careIncludes(offer.care.max_discount_pct ?? 90)}</p>
      ) : null}

      {standing ? (
        <p role="alert" className="animate-in fade-in slide-in-from-top-2 duration-200 motion-reduce:animate-none mt-2 text-[12px] text-text-primary" data-packages-blocked>{standing}</p>
      ) : attention && missing ? (
        <p role="alert" className="animate-in fade-in slide-in-from-top-2 duration-200 motion-reduce:animate-none mt-2 text-[12px] text-text-primary" data-packages-missing>{missing}</p>
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
            // The owner's kits are priced for this exact version, order type, route and the page's printer quantity
            // (a kit is one per printer unit: its items follow the printer's quantity).
            kitsFor={quoteFor ? { slug: quoteFor[0], optionValueIds: quoteFor[2], fulfillmentType: quoteFor[5] || undefined, transportMethod: quoteFor[4] || undefined, qty: Math.max(1, quoteFor[6] ?? 1) } : null}
          />
        </Suspense>
      ) : null}
    </section>
  );
}

/** The radio mark: an empty ring, or a ring whose dot scales in (transform only). */
function Radio({ on }: { on: boolean }) {
  return (
    <span aria-hidden="true" className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border ${on ? 'border-current' : 'border-text-muted'}`}>
      {on ? <span className="animate-in fade-in duration-200 motion-reduce:animate-none h-2 w-2 rounded-full bg-black" /> : null}
    </span>
  );
}

/** A preset's contents, shortest form: «الضمان 12 شهر · Levo Care +12 شهر · فحص كامل» (Care runs after the warranty). */
function includesText(offer: ServicesOffer, id: 'smart' | 'complete', s: (typeof PS_STRINGS)['ar']): string {
  const inc = offer.packages[id]?.includes;
  if (!inc) return '';
  const parts: string[] = [];
  if (inc.warranty !== 'none') parts.push(`${s.warranty} ${s.months(inc.warranty === 'w12' ? 12 : 24)}`);
  if (inc.care === 'c12') parts.push(`${s.care} +${s.months(12)}`);
  if (inc.packaging === 'extra') parts.push(s.packagingExtra);
  if (inc.inspection === 'full') parts.push(s.inspectionOption);
  return parts.join(' · ');
}
