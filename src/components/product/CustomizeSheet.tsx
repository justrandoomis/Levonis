/**
 * «تخصيص بنفسي» — the bottom sheet (owner brief 2026-11-17; DECISIONS row 339;
 * reference images «12_40_06» collapsed and «12_40_00» expanded).
 *
 * One scrolling list of SHORT rows; one row open at a time, expanding inline
 * to its few choices. It starts from what the customer already confirmed, or
 * from nothing paid at all — never from a package. Closing without «تطبيق»
 * keeps nothing; «تطبيق» hands back a CONFIRMED custom choice. Every figure is
 * the server's: the option prices come with the offer, and the footer's
 * services, delivery and total are the quote of exactly this draft (`quote`)
 * — the browser never adds them up.
 *
 * On the product page it also carries «أضف إلى السلة» (apply, then the page's
 * own add once the server priced the choice), a Membership row that only
 * shows the server's `membership_preview` figure, and a Filament row that
 * links to the ordinary listing — neither is a service the server accepts.
 * Motion is transform and opacity only, from the shared animate-in utilities (no stylesheet of its own: the public CSS budget).
 *
 * Loaded lazily from the product page: its code is paid for only on open.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CirclePlay, Check, ChevronDown, ClipboardCheck, Crown, Heart, Package, Shield, ShoppingCart, SlidersHorizontal, Spool, Truck, X } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import VariantImg from '../ui/VariantImg';
import { PS_STRINGS, servicesErrorText, type PsLang } from './printerServicesStrings';
import {
  EMPTY_SELECTION,
  asCustom,
  deliveryFee,
  firstBlocker,
  moveRadioFocus,
  readyToBuy,
  tabStop,
  type AcademyChoice,
  type QuotedSelection,
  type DeliveryChoice,
  type ServiceSelection,
  type ServicesOffer,
} from './printerServicesModel';

/** Where «تصفّح الخيوط» goes: the ordinary FDM-materials listing (src/lib/homeLayout.ts `filament`). */
const FILAMENT_LISTING = '/products?category=cat_materials_fdm';

export interface CustomizeSheetProps {
  open: boolean;
  onClose: () => void;
  onApply: (s: ServiceSelection) => void;
  /**
   * The product page's «أضف إلى السلة»: apply this confirmed choice and add the
   * printer through the page's own add once the server priced it. Absent (the
   * cart, or a selection the page cannot sell) = «تطبيق» is the only action.
   */
  onApplyAndAdd?: (s: ServiceSelection) => void;
  /** The page's add is in flight: «أضف إلى السلة» is busy. */
  adding?: boolean;
  offer: ServicesOffer;
  current: ServiceSelection | null;
  printer: { name: string; image: string | null; versionLabel: string };
  lang: PsLang;
  money: (iqd: number) => string;
  /** Prices the draft on the server (the footer's figures); absent = no figures are shown. */
  quote?: (s: ServiceSelection, signal: AbortSignal) => Promise<{ unit_iqd: number | null; selection: QuotedSelection | null } | null>;
  /** The caller is saving the applied choice: «تطبيق» is busy and cannot be pressed twice. */
  busy?: boolean;
  /** The caller's save was refused: said inside the sheet, which stays open. */
  error?: string | null;
  /**
   * Membership, information only — the server's `membership_preview` figure. It
   * is NOT a service: the selection has no membership field and the server
   * refuses unknown ones. Absent or null = the row is not drawn.
   */
  membership?: { tier: string; unitIqd: number; upgrade: boolean } | null;
}

type DraftQuote = { key: string; state: 'fresh' | 'failed'; unit: number | null; sel: QuotedSelection | null };

type RowKey = 'warranty' | 'care' | 'membership' | 'packaging' | 'delivery' | 'inspection' | 'academy' | 'filament';

export default function CustomizeSheet({ open, onClose, onApply, onApplyAndAdd, adding = false, offer, current, printer, lang, money, quote, busy = false, error = null, membership = null }: CustomizeSheetProps) {
  const s = PS_STRINGS[lang];
  const titleId = useId();
  const keyDir = lang === 'en' ? 'ltr' : 'rtl';
  const [draft, setDraft] = useState<ServiceSelection>(() => start(current, offer));
  const [openRow, setOpenRow] = useState<RowKey | null>(null);
  // Reset on open, or when the confirmed choice itself changes — keyed by its
  // content: each cart re-read hands a new object holding the same choice.
  const currentKey = JSON.stringify(current);
  const latest = useRef({ current, offer });
  latest.current = { current, offer };
  useEffect(() => {
    if (open) {
      setDraft(start(latest.current.current, latest.current.offer));
      setOpenRow(null);
    }
  }, [open, currentKey]);

  // Focus moves INTO the sheet on open. The Overlay focuses its panel in an
  // effect, but on the first open the panel can mount a frame later (the
  // motion chunk is still loading), and that focus is then lost; the opener
  // kept it (measured). So: a few frames, until the panel exists, unless focus
  // already went inside.
  const closeBtn = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    let frames = 0;
    let raf = 0;
    const tryFocus = () => {
      const btn = closeBtn.current;
      const panel = btn?.closest<HTMLElement>('[data-overlay-panel]');
      if (panel && panel.contains(document.activeElement)) return;
      if (panel) { panel.focus({ preventScroll: true }); return; }
      if (++frames < 30) raf = requestAnimationFrame(tryFocus);
    };
    raf = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const set = (patch: Partial<ServiceSelection>) => setDraft((d) => ({ ...d, ...patch }));
  const applied: ServiceSelection = { ...asCustom(draft), confirmed: true };
  const draftKey = JSON.stringify(applied);
  const [q, setQ] = useState<DraftQuote | null>(null);
  // The caller may hand a new function each render: the latest one is used, the draft is what re-asks.
  const quoteRef = useRef(quote);
  quoteRef.current = quote;
  const canQuote = !!quote;
  // The server prices exactly this draft, a moment after the last change.
  useEffect(() => {
    const quote = quoteRef.current;
    if (!open || !quote) return;
    const ac = new AbortController();
    const sel = JSON.parse(draftKey) as ServiceSelection;
    const timer = setTimeout(() => {
      quote(sel, ac.signal).then(
        (r) => { if (!ac.signal.aborted) setQ({ key: draftKey, state: 'fresh', unit: r?.unit_iqd ?? null, sel: r?.selection ?? null }); },
        () => { if (!ac.signal.aborted) setQ({ key: draftKey, state: 'failed', unit: null, sel: null }); }
      );
    }, 250);
    return () => { clearTimeout(timer); ac.abort(); };
  }, [open, draftKey, canQuote]);
  const fresh = quote && q?.key === draftKey ? q : null;
  const priced = fresh?.state === 'fresh' ? fresh.sel : null;
  const blocker = firstBlocker(priced);
  const complete = readyToBuy(applied, offer);
  const quoted = !quote || (fresh?.state === 'fresh' && !!priced && !blocker);
  const ready = complete && quoted && !busy && !adding;
  const hint = !complete
    ? offer.delivery && draft.delivery === null ? s.deliveryChoose : draft.warranty === 'none' && !draft.ack_no_warranty ? s.justAck : ''
    : !quote ? ''
    : !fresh ? s.pending
    : fresh.state === 'failed' ? s.quoteFailed
    : blocker ? servicesErrorText(blocker, lang) || s.unavailable
    : !priced ? s.unavailable
    : '';
  // The footer keeps the LAST figures the server sent while it prices the next
  // draft — dimmed, never replaced by a dash and never computed here — so the
  // total does not flash on every tap. A failed or refused draft shows none.
  const shownQuote = fresh?.state === 'fresh' && priced ? { unit: fresh.unit, sel: priced } : null;
  const lastShown = useRef<{ unit: number | null; sel: QuotedSelection } | null>(null);
  if (shownQuote) lastShown.current = shownQuote;
  if (fresh && !shownQuote) lastShown.current = null;
  const figures = shownQuote ?? (fresh ? null : lastShown.current);
  const stale = !shownQuote && !!figures;
  const unit = figures?.unit ?? null;
  const dFee = figures ? figures.sel.delivery_fee_iqd : null;

  const row = (key: RowKey, icon: React.ReactNode, title: string, sub: string, value: string, body: React.ReactNode, hidden = false) => {
    if (hidden) return null;
    const expanded = openRow === key;
    const panelId = `${titleId}-${key}`;
    return (
      <div className="min-w-0" data-sheet-row={key}>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setOpenRow((r) => (r === key ? null : key))}
          className="flex min-h-14 w-full items-center gap-3 px-1 py-2 text-start [touch-action:manipulation] active:opacity-70"
        >
          <span className="shrink-0 text-text-secondary">{icon}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold text-text-primary">{title}</span>
            <span className="block truncate text-[11.5px] text-text-secondary">{sub}</span>
          </span>
          <span className="shrink-0 text-[12.5px] font-semibold tabular-nums text-text-primary" dir="auto">{value}</span>
          <ChevronDown aria-hidden="true" className={`w-4 h-4 shrink-0 text-text-secondary transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
        </button>
        {/* Revealed with opacity and a 4px slide (compositor only): the height
            change itself is a single reflow, never animated frame by frame. */}
        {expanded ? <div id={panelId} className="animate-in fade-in slide-in-from-top-2 duration-200 motion-reduce:animate-none px-1 pb-3">{body}</div> : null}
      </div>
    );
  };

  const choice = <T extends string>(name: string, options: Array<{ id: T; label: string; price: number | null; sub?: string }>, value: T, onPick: (v: T) => void, cols = 2) => {
    const stop = tabStop(options.map((o) => o.id), value, (id) => options.find((o) => o.id === id)?.price !== null);
    return (
      <div className={`grid gap-2 ${cols === 3 ? 'grid-cols-3' : 'grid-cols-2'}`} role="radiogroup" aria-label={name} onKeyDown={(e) => moveRadioFocus(e, keyDir)}>
        {options.map((o) => {
          const on = value === o.id;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={stop === o.id ? 0 : -1}
              disabled={o.price === null}
              onClick={() => onPick(o.id)}
              className={`min-h-12 rounded-xl border px-2.5 py-1.5 text-start press-scale [touch-action:manipulation] disabled:opacity-50 ${on ? 'bg-white text-black border-transparent' : 'border-border-subtle text-text-primary'}`}
            >
              <span className="flex items-center justify-between gap-1.5">
                <span className="text-[12.5px] font-semibold leading-tight">{o.label}</span>
                {on ? <Check aria-hidden="true" className="animate-in fade-in duration-200 motion-reduce:animate-none w-3.5 h-3.5 shrink-0" /> : null}
              </span>
              <span className={`block text-[11px] tabular-nums ${on ? 'opacity-70' : 'text-text-secondary'}`} dir="auto">
                {o.id === 'none' ? ' ' : o.price === null ? s.unavailable : o.price === 0 ? s.free : `+${money(o.price)}`}
              </span>
              {o.sub ? <span className={`block text-[10.5px] leading-snug ${on ? 'opacity-70' : 'text-text-secondary'}`}>{o.sub}</span> : null}
            </button>
          );
        })}
      </div>
    );
  };

  const priceOf = (v: number | null | undefined) => (v === null || v === undefined ? null : v);
  const shown = (v: number | null) => (v === null ? '—' : v === 0 ? s.free : `+${money(v)}`);
  const warrantyValue = draft.warranty === 'none' ? s.none : shown(priceOf(offer.warranty?.[draft.warranty]));
  const academyLive = draft.academy !== 'recorded';
  const actionBusy = busy || adding;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      panelClassName="w-full sm:max-w-lg max-h-[92dvh]"
      header={
        <div className="px-4 pb-2 pt-1">
          <div className="flex items-center justify-between gap-3">
            <button ref={closeBtn} type="button" onClick={onClose} aria-label={s.close} className="grid h-11 w-11 place-items-center rounded-full text-text-secondary hover:text-text-primary press-scale">
              <X aria-hidden="true" className="w-5 h-5" />
            </button>
            <h2 id={titleId} className="flex items-center gap-2 text-[17px] font-bold tracking-[-0.01em] text-text-primary">
              {s.sheetTitle}
              <SlidersHorizontal aria-hidden="true" className="w-4 h-4" />
            </h2>
            <span className="w-11" aria-hidden="true" />
          </div>
          <div className="mt-1 flex items-center gap-3">
            {printer.image ? <VariantImg sizes="48px" src={printer.image} alt="" className="h-10 w-12 shrink-0 rounded-lg bg-white object-contain" /> : null}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold text-text-primary">{printer.name}</p>
              <p className="truncate text-[11.5px] text-text-secondary">{printer.versionLabel || s.sheetSub}</p>
            </div>
          </div>
        </div>
      }
      footer={
        // The Sheet's footer already draws the top rule and the side padding.
        <div>
          <div className="mb-2 flex items-end justify-between gap-3">
            {/* The server's figures for this exact draft — listed, never summed here. */}
            <div className={`min-w-0 text-[11.5px] text-text-secondary ${stale ? 'opacity-50 transition-opacity' : ''}`}>
              {figures && figures.sel.fee_iqd > 0 ? <span className="block tabular-nums" dir="auto">{s.services}: + {money(figures.sel.fee_iqd)}</span> : null}
              {dFee !== null ? <span className="block tabular-nums" dir="auto">{s.deliveryLine}: + {money(dFee)}</span> : null}
              {dFee !== null ? <span className="block">{s.deliveryApart}</span> : null}
            </div>
            <div className="text-end" aria-live="polite" aria-atomic="true">
              <span className="block text-[11.5px] text-text-secondary">{s.total}</span>
              <span
                key={stale ? 'stale' : String(unit)}
                className={`block text-[20px] font-bold tabular-nums text-text-primary ${stale ? 'opacity-50 transition-opacity' : 'animate-in fade-in duration-200 motion-reduce:animate-none'}`}
                dir="auto"
                data-sheet-total
              >
                {unit === null ? '—' : money(unit)}
              </span>
            </div>
          </div>
          {error ? <p role="alert" className="mb-2 text-center text-[12px] text-text-primary" data-sheet-error>{error}</p> : null}
          {onApplyAndAdd ? (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!ready}
                onClick={() => { if (ready) onApply(applied); }}
                className="min-h-12 shrink-0 rounded-full border border-border-subtle px-4 text-[14px] font-semibold text-text-primary press-scale disabled:opacity-50"
                data-sheet-apply
              >
                {busy ? s.saving : s.apply}
              </button>
              <button
                type="button"
                disabled={!ready}
                aria-busy={actionBusy || undefined}
                onClick={() => { if (ready) onApplyAndAdd(applied); }}
                className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-full bg-white text-[15px] font-bold text-black press-scale disabled:opacity-50"
                data-sheet-add
              >
                <ShoppingCart aria-hidden="true" className="w-4 h-4" /> {adding ? s.adding : s.addToCart}
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={!ready}
              aria-busy={busy || undefined}
              onClick={() => { if (ready) onApply(applied); }}
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-white text-[15px] font-bold text-black press-scale disabled:opacity-50"
              data-sheet-apply
            >
              <Check aria-hidden="true" className="w-4 h-4" /> {busy ? s.saving : s.apply}
            </button>
          )}
          {!ready && !actionBusy && hint ? <p className="mt-1.5 text-center text-[11.5px] text-text-secondary" role="status">{hint}</p> : null}
        </div>
      }
    >
      <div className="divide-y divide-border-subtle px-4 pb-4">
        {row('warranty', <Shield className="w-5 h-5" aria-hidden="true" />, s.warranty, s.warrantySub, warrantyValue, (
          <>
            {choice(s.warranty, [
              { id: 'none' as const, label: s.none, price: 0 },
              { id: 'w12' as const, label: s.months(12), price: priceOf(offer.warranty?.w12) },
              { id: 'w24' as const, label: s.months(24), price: priceOf(offer.warranty?.w24) },
            ], draft.warranty, (w) => set({ warranty: w, ack_no_warranty: w === 'none' ? draft.ack_no_warranty : false }), 3)}
            <p className="mt-2 text-[11.5px] leading-relaxed text-text-secondary">{s.warrantyNote}</p>
            {draft.warranty === 'none' ? (
              <div className="animate-in fade-in slide-in-from-top-2 duration-200 motion-reduce:animate-none mt-2 rounded-xl border border-border-subtle p-2.5">
                <p className="text-[11.5px] leading-relaxed text-text-secondary">{s.justWarning}</p>
                <label className="mt-1.5 flex min-h-11 cursor-pointer items-center gap-2.5 text-[13px] font-medium text-text-primary">
                  <input type="checkbox" className="h-5 w-5 shrink-0" style={{ accentColor: '#fff' }} checked={draft.ack_no_warranty} onChange={(e) => set({ ack_no_warranty: e.target.checked })} />
                  {s.justAck}
                </label>
              </div>
            ) : null}
            <Link to="/policies/extended_warranty" className="mt-2 inline-flex min-h-11 items-center text-[12px] text-text-secondary underline">{s.terms}</Link>
          </>
        ), !offer.warranty)}

        {row('care', <Heart className="w-5 h-5" aria-hidden="true" />, s.care, s.careSub(offer.care?.max_discount_pct ?? 90),
          draft.care === 'c12' ? shown(priceOf(offer.care?.c12)) : s.none,
          choice(s.care, [
            { id: 'none' as const, label: s.none, price: 0 },
            { id: 'c12' as const, label: s.careOption, price: priceOf(offer.care?.c12) },
          ], draft.care, (v) => set({ care: v })), !offer.care)}

        {/* Information only: the server's member price for this printer, and where to subscribe. */}
        {row('membership', <Crown className="w-5 h-5" aria-hidden="true" />, s.membership, s.membershipSub,
          membership ? money(membership.unitIqd) : '',
          membership ? (
            <>
              <p className="flex items-baseline justify-between gap-3 text-[12.5px] text-text-primary">
                <span>{s.memberPays(membership.tier)}</span>
                <span className="shrink-0 font-semibold tabular-nums" dir="auto">{money(membership.unitIqd)}</span>
              </p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-secondary">{s.membershipApart}</p>
              <Link to="/subscription" className="mt-1 inline-flex min-h-11 items-center text-[12.5px] font-semibold text-text-primary underline">
                {membership.upgrade ? s.membershipUpgrade(membership.tier) : s.membershipJoin}
              </Link>
            </>
          ) : null, !membership)}

        {row('packaging', <Package className="w-5 h-5" aria-hidden="true" />, s.packaging, s.packagingSub,
          draft.packaging === 'extra' ? shown(priceOf(offer.packaging?.extra)) : s.packagingStandard,
          choice(s.packaging, [
            { id: 'standard' as const, label: s.packagingStandard, price: 0 },
            { id: 'extra' as const, label: s.packagingExtra, price: priceOf(offer.packaging?.extra) },
          ], draft.packaging, (v) => set({ packaging: v })), !offer.packaging)}

        {row('delivery', <Truck className="w-5 h-5" aria-hidden="true" />, s.delivery, s.deliveryChoose,
          draft.delivery === null ? '—' : shown(deliveryFee(offer, draft.delivery)),
          choice<DeliveryChoice>(s.delivery, [
            { id: 'economy', label: s.deliveryEconomy, price: priceOf(offer.delivery?.economy), sub: s.deliveryEconomySub },
            { id: 'personal', label: s.deliveryPersonal, price: priceOf(offer.delivery?.personal), sub: s.deliveryPersonalSub },
          ], draft.delivery ?? ('' as DeliveryChoice), (v) => set({ delivery: v })), !offer.delivery)}

        {row('inspection', <ClipboardCheck className="w-5 h-5" aria-hidden="true" />, s.inspection, s.inspectionSub,
          draft.inspection === 'full' ? shown(priceOf(offer.inspection?.full)) : s.none,
          <>
            {choice(s.inspection, [
              { id: 'none' as const, label: s.none, price: 0 },
              { id: 'full' as const, label: s.inspectionOption, price: priceOf(offer.inspection?.full) },
            ], draft.inspection, (v) => set({ inspection: v }))}
            {offer.inspection ? <p className="mt-2 text-[11.5px] text-text-secondary">{s.inspectionLead(offer.inspection.lead_business_days[0], offer.inspection.lead_business_days[1])}</p> : null}
          </>, !offer.inspection)}

        {row('academy', <CirclePlay className="w-5 h-5" aria-hidden="true" />, s.academy, s.academySub,
          academyLive ? shown(priceOf(offer.academy?.live)) : s.free,
          <>
            {choice<AcademyChoice>(s.academy, [
              { id: 'recorded', label: s.academyRecorded, price: priceOf(offer.academy?.recorded) },
              { id: 'live_whatsapp', label: s.academyWhatsapp, price: priceOf(offer.academy?.live) },
              { id: 'live_in_person', label: s.academyInPerson, price: priceOf(offer.academy?.live) },
            ], draft.academy, (v) => set({ academy: v }))}
            {academyLive ? <p className="mt-2 text-[11.5px] text-text-secondary">{s.academyNote}</p> : null}
          </>, !offer.academy)}

        {/* Not a service: filament is an ordinary product, bought through the normal cart. */}
        {row('filament', <Spool className="w-5 h-5" aria-hidden="true" />, s.filament, s.filamentSub, '', (
          <>
            <p className="text-[11.5px] leading-relaxed text-text-secondary">{s.filamentNote}</p>
            <Link to={FILAMENT_LISTING} className="mt-1 inline-flex min-h-11 items-center text-[12.5px] font-semibold text-text-primary underline">{s.filamentShop}</Link>
          </>
        ))}
      </div>
    </Sheet>
  );
}

/** The sheet starts from what was confirmed, or from nothing paid (never from a package). */
function start(current: ServiceSelection | null, offer: ServicesOffer): ServiceSelection {
  // A delivery the offer no longer has (switched off) is not carried into the draft.
  const delivery = offer.delivery ? current?.delivery ?? null : null;
  if (current?.confirmed) return { ...current, delivery };
  return { ...EMPTY_SELECTION, delivery };
}
