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
 * own add once the server priced the choice). Phase 2 (0235): the Membership
 * row is a real choice (GET /api/memberships/order-options, read when the row
 * opens: the server's charge, kind and blocker per plan) and the Filament row
 * lists the owner's kits for this printer (GET /api/products/:slug/kits). Both
 * travel as `extras` (membershipPlanId / kitId), never as services, and both
 * are their own cart lines: the footer lists their server figures beside the
 * printer's total, it never adds them in.
 * Phase 4 (0242; DECISIONS row 355): the kit's customer-colour filaments take
 * a colour each (an in-stock one, or «لون عشوائي», preselected), the owner's
 * discounted add-ons are their own row of check cards, and the store bundles
 * linked to the printer are a row of cards added straight to the cart — all
 * from the same kits endpoint, drawn by PrinterOffersRows (this chunk only),
 * and travelling as `extras.kitColors` / `extras.addonIds` / `extras.addonColors`.
 * Motion is transform and opacity only, from the shared animate-in utilities (no stylesheet of its own: the public CSS budget).
 *
 * Loaded lazily from the product page: its code is paid for only on open.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../AuthContext';
import { authPathWithSupportRef } from '../../lib/supportRef';
import { TIER_ORDER, tierLabel, type AnyTier } from '../subscription/tierMeta';
import { CirclePlay, Check, ChevronDown, ClipboardCheck, Crown, Heart, Package, Shield, ShoppingCart, SlidersHorizontal, Spool, Truck, X } from 'lucide-react';
import { AddonsBody, BeforeAfter, BundlesBody, KitColours, OffersLoading, RANDOM, colourProblem, loadOffers, type OfferExtras, type PrinterOffers } from './PrinterOffersRows';
import { OFFER_STRINGS, offerErrorText } from './printerOfferStrings';
import { Sheet } from '../ui/Sheet';
import VariantImg from '../ui/VariantImg';
import { PS_STRINGS, servicesErrorText, type PsLang } from './printerServicesStrings';
import {
  EMPTY_SELECTION,
  asCustom,
  deliveryFee,
  firstBlocker,
  loadMembershipOptions,
  moveRadioFocus,
  readyToBuy,
  servicesOnly,
  tabStop,
  type KitsFor,
  type MembershipOption,
  type MembershipOptions,
  type PricedKit,
  type AcademyChoice,
  type QuotedSelection,
  type DeliveryChoice,
  type ServiceSelection,
  type ServicesOffer,
} from './printerServicesModel';

/** Where «تصفّح الخيوط» goes: the ordinary FDM-materials listing (src/lib/homeLayout.ts `filament`). */
const FILAMENT_LISTING = '/products?category=cat_materials_fdm';

/** What the card says about the chosen membership and kit (their names; the figures stay the server's). */
export interface ExtrasLabels { membership?: string | null; kit?: string | null; addons?: string | null }

export interface CustomizeSheetProps {
  open: boolean;
  onClose: () => void;
  onApply: (s: ServiceSelection, labels?: ExtrasLabels) => void;
  /**
   * The product page's «أضف إلى السلة»: apply this confirmed choice and add the
   * printer through the page's own add once the server priced it. Absent (the
   * cart, or a selection the page cannot sell) = «تطبيق» is the only action.
   */
  onApplyAndAdd?: (s: ServiceSelection, labels?: ExtrasLabels) => void;
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
   * What the owner's kits are priced for (GET /api/products/:slug/kits): this
   * printer's product, version, order type, route and quantity. Absent = the
   * Filament row only links to the ordinary listing.
   */
  kitsFor?: KitsFor | null;
}

type Loaded<T> = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; data: T };

type DraftQuote = { key: string; state: 'fresh' | 'failed'; unit: number | null; sel: QuotedSelection | null };

type RowKey = 'warranty' | 'care' | 'membership' | 'packaging' | 'delivery' | 'inspection' | 'academy' | 'filament' | 'addons' | 'bundles';

export default function CustomizeSheet({ open, onClose, onApply, onApplyAndAdd, adding = false, offer, current, printer, lang, money, quote, busy = false, error = null, kitsFor = null }: CustomizeSheetProps) {
  const s = PS_STRINGS[lang];
  const o4 = OFFER_STRINGS[lang];
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
  const setExtra = (patch: OfferExtras) => setDraft((d) => ({ ...d, extras: { ...d.extras, ...patch } }));
  /** Phase 4: a customer-colour kit item's colour (by product id) or an add-on's (by add-on id). */
  const pickColour = (field: 'kitColors' | 'addonColors') => (key: string, v: string) =>
    setDraft((d) => {
      const x = (d.extras ?? {}) as OfferExtras;
      const next: OfferExtras = { ...x, [field]: { ...(x[field] ?? {}), [key]: v } };
      return { ...d, extras: next };
    });
  const toggleAddon = (id: string) =>
    setDraft((d) => {
      const x = (d.extras ?? {}) as OfferExtras;
      const held = x.addonIds ?? [];
      const ids = held.includes(id) ? held.filter((a) => a !== id) : [...held, id];
      const next: OfferExtras = { ...x, addonIds: ids.length ? ids : null };
      return { ...d, extras: next };
    });

  // ---- phase 2: the membership and the kit, each read from its own endpoint when its row opens
  // (or at once when the confirmed choice already holds one, so its figure is the server's).
  const { user } = useAuth();
  const location = useLocation();
  const memberOffered = !!offer.membership && offer.membership.tiers.length > 0;
  const kitsOffered = offer.kits.length > 0 && !!kitsFor;
  // Phase 4: an older cached offer has neither list.
  const offerAddons = offer.addons ?? [];
  const offerBundles = offer.store_bundles ?? [];
  const addonsOffered = offerAddons.length > 0 && !!kitsFor;
  const bundlesOffered = offerBundles.length > 0 && !!kitsFor;
  const x4 = (draft.extras ?? {}) as OfferExtras;
  const addonIds = x4.addonIds ?? [];
  const [members, setMembers] = useState<Loaded<MembershipOptions> | null>(null);
  // The kits endpoint answers the kits, the add-ons and the store bundles together (phase 4).
  const [kits, setKits] = useState<Loaded<PrinterOffers> | null>(null);
  const [memberTry, setMemberTry] = useState(0);
  const [kitTry, setKitTry] = useState(0);
  const wantMembers = open && memberOffered && !!user && (openRow === 'membership' || !!draft.extras?.membershipPlanId);
  const wantKits = open && !!kitsFor && (kitsOffered || addonsOffered || bundlesOffered)
    && (openRow === 'filament' || openRow === 'addons' || openRow === 'bundles' || !!draft.extras?.kitId || addonIds.length > 0);
  // The colours picked so far: the server prices exactly those (a colour may carry its own price).
  // (Kit items are keyed by product id and add-ons by their own id: one `colors` query carries both.)
  const coloursKey = JSON.stringify(Object.entries({ ...(x4.kitColors ?? {}), ...(x4.addonColors ?? {}) }).sort(([a], [b]) => a.localeCompare(b)));
  const kitsKey = kitsFor ? JSON.stringify(kitsFor) : '';
  // The printer itself (product and version): another one = other kits, so a chosen kit is dropped.
  const versionKey = kitsFor ? JSON.stringify([kitsFor.slug, [...kitsFor.optionValueIds].sort()]) : '';
  const offerMemberKey = JSON.stringify(offer.membership ?? null);
  const offerKitsKey = offer.kits.map((k) => k.id).join(',');
  const offerAddonsKey = offerAddons.map((a) => a.id).join(',');
  /*
   * A version switch, or an offer that no longer carries the membership row or
   * this kit, clears the choice (never kept as a hidden extra the add would
   * send), and the lists are read again for what is on screen now.
   */
  const lastVersion = useRef(versionKey);
  useEffect(() => {
    const switched = lastVersion.current !== versionKey;
    lastVersion.current = versionKey;
    setDraft((d) => {
      const x = d.extras as OfferExtras | undefined;
      if (!x) return d;
      const dropKit = !!x.kitId && (switched || !offer.kits.some((k) => k.id === x.kitId));
      const dropPlan = !!x.membershipPlanId && !offer.membership;
      // Phase 4: another printer = other add-ons and colours; an add-on the offer no longer lists is dropped.
      const held = x.addonIds ?? [];
      const keptAddons = switched ? [] : held.filter((id) => offerAddons.some((a) => a.id === id));
      const dropAddons = keptAddons.length !== held.length;
      const dropColours = switched && (!!x.kitColors || !!x.addonColors);
      if (!dropKit && !dropPlan && !dropAddons && !dropColours) return d;
      const next: OfferExtras = {
        ...x,
        ...(dropKit ? { kitId: null } : {}),
        ...(dropPlan ? { membershipPlanId: null } : {}),
        ...(dropAddons ? { addonIds: keptAddons.length ? keptAddons : null } : {}),
        ...(dropColours ? { kitColors: null, addonColors: null } : {}),
      };
      return { ...d, extras: next };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionKey, offerKitsKey, offerAddonsKey, offerMemberKey, open]);
  useEffect(() => { setKits(null); }, [kitsKey]);
  useEffect(() => { setMembers(null); }, [offerMemberKey]);
  useEffect(() => {
    if (!wantMembers) return;
    const ac = new AbortController();
    setMembers((m) => (m?.state === 'ready' ? m : { state: 'loading' }));
    loadMembershipOptions(ac.signal).then(
      (data) => { if (!ac.signal.aborted) setMembers({ state: 'ready', data }); },
      () => { if (!ac.signal.aborted) setMembers({ state: 'failed' }); }
    );
    return () => ac.abort();
  }, [wantMembers, memberTry, user?.id, offerMemberKey]);
  // A colour tap re-reads the figures (a colour may carry its own price): the last answer stays on screen
  // meanwhile, and the apply waits for the answer of exactly these colours (`coloursFresh`).
  const [pricedColours, setPricedColours] = useState('');
  useEffect(() => {
    if (!wantKits || !kitsKey) return;
    const ac = new AbortController();
    setKits((k) => (k?.state === 'ready' ? k : { state: 'loading' }));
    const colours = Object.fromEntries(JSON.parse(coloursKey) as Array<[string, string]>);
    const timer = setTimeout(() => {
      loadOffers(JSON.parse(kitsKey) as KitsFor, colours, lang, ac.signal).then(
        (data) => { if (!ac.signal.aborted) { setKits({ state: 'ready', data }); setPricedColours(coloursKey); } },
        () => { if (!ac.signal.aborted) setKits({ state: 'failed' }); }
      );
    }, 150);
    return () => { clearTimeout(timer); ac.abort(); };
  }, [wantKits, kitsKey, kitTry, coloursKey, lang]);
  const blockedWords = (code: string) => s.memberBlocked[code] || servicesErrorText(code, lang) || s.unavailable;
  const blockedSentence = (code: string) => servicesErrorText(code, lang) || s.memberBlocked[code] || s.unavailable;
  const memberList = members?.state === 'ready' ? members.data : null;
  const planId = draft.extras?.membershipPlanId ?? null;
  /*
   * An existing member is offered an UPGRADE only (owner ruling): the same and lower tiers are hidden, and
   * there is no renewal through a printer order. The server already leaves them out; this holds the line
   * if an answer still lists one (an option at or below the current tier, or its refusal).
   */
  const rank = (t: string | null | undefined) => TIER_ORDER[(t || 'free') as AnyTier] ?? 0;
  const upward = (o: MembershipOption) => !memberList?.current || rank(o.plan.tier) > rank(memberList.current.tier);
  const chosenPlan = planId ? memberList?.options.find((o) => o.plan.id === planId) ?? null : null;
  const kitId = draft.extras?.kitId ?? null;
  const offers = kits?.state === 'ready' ? kits.data : null;
  const kitList = kitsOffered && offers ? offers.kits : null;
  const chosenKit = kitId ? kitList?.find((k) => k.id === kitId) ?? null : null;
  // Phase 4: the server's add-ons and store bundles, in the offer's order (only those the offer lists).
  const addonList = addonsOffered && offers ? offerAddons.map((a) => offers.addons.find((x) => x.id === a.id)).filter((a): a is NonNullable<typeof a> => !!a) : null;
  const bundleList = bundlesOffered && offers ? offerBundles.map((id) => offers.store_bundles.find((b) => b.id === id)).filter((b): b is NonNullable<typeof b> => !!b) : null;
  const chosenAddons = addonList ? addonList.filter((a) => addonIds.includes(a.id)) : [];
  const coloursFresh = pricedColours === coloursKey;
  const addonColourChoices = chosenAddons.flatMap((a) => (a.colour ? [a.colour] : []));
  // A chosen plan or kit the server no longer sells holds the apply, with its reason — and so does one
  // whose options are still loading or could not be read (its figure is not the server's yet).
  const extrasBlock =
    planId && !user ? s.memberSignIn
    : planId && !memberList ? (members?.state === 'failed' ? s.memberFailed : s.memberLoading)
    : chosenPlan && !chosenPlan.ok ? blockedSentence(codeOf(chosenPlan))
    : chosenPlan && !upward(chosenPlan) ? blockedSentence('ALREADY_SUBSCRIBED')
    : planId && memberList && !chosenPlan ? servicesErrorText('MEMBERSHIP_NOT_OFFERED', lang)
    : kitId && !kitsOffered ? servicesErrorText('KIT_NOT_OFFERED', lang)
    : kitId && !kitList ? (kits?.state === 'failed' ? s.kitsFailed : s.kitsLoading)
    // Phase 4: a kit refused because of the colour picked in it says so (its fix is a chip below the kit).
    : chosenKit && !chosenKit.available ? (colourProblem(chosenKit.colours, x4.kitColors) ? offerErrorText('KIT_COLOR_UNAVAILABLE', lang) : servicesErrorText('KIT_UNAVAILABLE', lang))
    : kitId && kitList && !chosenKit ? servicesErrorText('KIT_NOT_OFFERED', lang)
    : addonIds.length && !addonsOffered ? offerErrorText('ADDON_NOT_OFFERED', lang)
    : addonIds.length && !addonList ? (kits?.state === 'failed' ? o4.failed : o4.loading)
    : addonList && addonIds.some((id) => !addonList.some((a) => a.id === id)) ? offerErrorText('ADDON_NOT_OFFERED', lang)
    : chosenAddons.some((a) => !a.available) ? offerErrorText('ADDON_UNAVAILABLE', lang)
    : colourProblem(addonColourChoices, x4.addonColors) ? offerErrorText('ADDON_UNAVAILABLE', lang)
    : (chosenKit || chosenAddons.length) && !coloursFresh ? o4.loading
    : '';
  const memberCharge = chosenPlan?.ok ? chosenPlan.charge_iqd : null;
  const kitTotal = chosenKit?.available ? chosenKit.total_iqd : null;
  // Phase 4: the chosen add-ons' totals and what the discounts save — each the server's figure, listed.
  const addonTotals = chosenAddons.map((a) => a.money.after_total).filter((n): n is number => n !== null);
  const addonsTotal = addonTotals.length ? addonTotals.reduce((a, b) => a + b, 0) : null;
  const savedTotal = (chosenKit?.available ? chosenKit.money.saving_total : 0) + chosenAddons.reduce((n, a) => n + (a.available ? a.money.saving_total : 0), 0);
  // Only the colours of what is chosen travel (a colour for a product no longer chosen is not sent).
  const only = (held: Record<string, string> | null | undefined, keys: readonly string[]) => {
    const kept = Object.fromEntries(Object.entries(held ?? {}).filter(([k]) => keys.includes(k)));
    return Object.keys(kept).length ? kept : held === undefined ? undefined : null;
  };
  const extras4: OfferExtras | undefined = draft.extras
    ? {
        ...x4,
        kitColors: only(x4.kitColors, (chosenKit?.colours ?? []).map((c) => c.key)),
        addonColors: only(x4.addonColors, addonColourChoices.map((c) => c.key)),
      }
    : undefined;
  const applied: ServiceSelection = { ...asCustom(draft), ...(extras4 ? { extras: extras4 } : {}), confirmed: true };
  // The names the card shows for the chosen extras (a name only: the figures stay the server's, in the cart).
  const labels: ExtrasLabels = {
    membership: chosenPlan ? `${tierLabel(chosenPlan.plan.tier)} · ${s.months(chosenPlan.plan.duration_months)}` : null,
    kit: kitId ? offer.kits.find((k) => k.id === kitId)?.title[lang] || chosenKit?.title[lang] || null : null,
    addons: chosenAddons.length ? chosenAddons.map((a) => a.title).join(lang === 'en' ? ', ' : '، ') : null,
  };
  // The server prices the services only; the extras are priced by their own endpoints below.
  const draftKey = JSON.stringify(servicesOnly(applied));
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
  const ready = complete && quoted && !extrasBlock && !busy && !adding;
  const hint = extrasBlock ? extrasBlock : !complete
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
  /** Anything the folded «تفاصيل السعر» would list. */
  const breakdown = (!!figures && figures.sel.fee_iqd > 0) || dFee !== null || memberCharge !== null || kitTotal !== null || addonsTotal !== null;

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

  /** One column of choices whose right side and lines are the server's words and figures. */
  const list = (name: string, options: Array<{ id: string; label: string; right: React.ReactNode; lines: string[]; disabled: boolean; suggested?: boolean }>, value: string, onPick: (id: string) => void) => {
    const stop = tabStop(options.map((o) => o.id), value, (id) => !options.find((o) => o.id === id)?.disabled);
    return (
      <div className="space-y-2" role="radiogroup" aria-label={name} onKeyDown={(e) => moveRadioFocus(e, keyDir)}>
        {options.map((o) => {
          const on = value === o.id;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={stop === o.id ? 0 : -1}
              disabled={o.disabled}
              onClick={() => onPick(o.id)}
              data-sheet-option={o.id}
              className={`min-h-12 w-full rounded-xl border px-2.5 py-1.5 text-start press-scale [touch-action:manipulation] disabled:opacity-50 ${on ? 'bg-white text-black border-transparent' : o.suggested ? 'border-dashed border-text-muted text-text-primary' : 'border-border-subtle text-text-primary'}`}
            >
              <span className="flex items-center justify-between gap-1.5">
                <span className="text-[12.5px] font-semibold leading-tight">{o.label}</span>
                <span className="flex shrink-0 items-center gap-1.5 text-[12px] font-semibold tabular-nums" dir="auto">
                  {o.right}
                  {on ? <Check aria-hidden="true" className="animate-in fade-in duration-200 motion-reduce:animate-none w-3.5 h-3.5 shrink-0" /> : null}
                </span>
              </span>
              {o.lines.filter(Boolean).map((l, i) => (
                <span key={i} className={`block text-[11px] leading-snug ${on ? 'opacity-70' : 'text-text-secondary'}`} dir="auto">{l}</span>
              ))}
            </button>
          );
        })}
      </div>
    );
  };

  const loadingLine = (state: 'loading' | 'failed', loading: string, failed: string, again: () => void) =>
    state === 'loading' ? (
      <p role="status" className="text-[11.5px] text-text-secondary">{loading}</p>
    ) : (
      <p role="alert" className="flex flex-wrap items-center gap-2 text-[11.5px] text-text-primary">
        {failed}
        <button type="button" onClick={again} className="inline-flex min-h-11 items-center font-semibold underline">{s.retry}</button>
      </p>
    );

  function membershipBody() {
    const terms = (
      <>
        <p className="mt-2 text-[11.5px] leading-relaxed text-text-secondary">{s.memberStarts}</p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-text-secondary">{s.memberFinal}</p>
        <Link to="/policies/membership" className="mt-1 inline-flex min-h-11 items-center text-[12px] text-text-secondary underline">{s.membershipTerms}</Link>
      </>
    );
    if (!user) {
      return (
        <>
          <p className="text-[12px] text-text-primary">{s.memberSignIn}</p>
          <Link to={authPathWithSupportRef(`${location.pathname}${location.search}`)} className="mt-1 inline-flex min-h-11 items-center text-[12.5px] font-semibold text-text-primary underline">{s.signIn}</Link>
          {terms}
        </>
      );
    }
    if (!members || members.state !== 'ready') return <>{loadingLine(members?.state === 'failed' ? 'failed' : 'loading', s.memberLoading, s.memberFailed, () => setMemberTry((n) => n + 1))}{terms}</>;
    const m = members.data;
    if (!m.offered) return <p className="text-[11.5px] text-text-secondary">{s.memberOff}</p>;
    // The package's tier is only drawn as a suggestion until the customer taps (a visual default is not consent).
    const pkg = current?.confirmed && (current.package === 'smart' || current.package === 'complete') ? offer.packages[current.package] : null;
    const hintTier = draft.extras?.membershipPlanId === undefined ? pkg?.includes.membership_tier ?? null : null;
    const shownOptions = m.options.filter((o) => upward(o) && !['DOWNGRADE_BLOCKED', 'ALREADY_SUBSCRIBED'].includes(codeOf(o)));
    return (
      <>
        {m.current ? <p className="mb-2 text-[12px] text-text-primary" data-sheet-member-current>{s.memberCurrent(tierLabel(m.current.tier), (m.current.expires_at ?? '').slice(0, 10))}</p> : null}
        {m.current ? <p className="mb-2 text-[11.5px] text-text-secondary" data-sheet-member-upgrade-only>{shownOptions.length ? s.memberUpgradeOnly : s.memberNoUpgrade}</p> : null}
        {m.pending_order_id ? <p className="mb-2 text-[11.5px] text-text-secondary">{s.memberPendingOrder}</p> : null}
        {list(s.membership, [
          { id: '', label: s.memberNone, right: '', lines: [], disabled: false },
          ...shownOptions.map((o) => ({
            id: o.plan.id,
            label: `${tierLabel(o.plan.tier)} · ${s.months(o.plan.duration_months)}`,
            right: o.ok ? `+${money(o.charge_iqd)}` : blockedWords(codeOf(o)),
            lines: o.ok
              ? [
                  o.kind === 'upgrade' ? s.memberUpgrade : s.memberNew,
                  o.credit_iqd > 0 ? `${money(o.price_iqd)} · ${s.memberCredit(money(o.credit_iqd))}` : '',
                ]
              : [],
            disabled: !o.ok,
            suggested: !!hintTier && o.plan.tier === hintTier,
          })),
        ], planId ?? '', (id) => setExtra({ membershipPlanId: id || null }))}
        {terms}
      </>
    );
  }

  function kitsBody() {
    const note = <p className="mt-2 text-[11.5px] leading-relaxed text-text-secondary">{s.kitNote}</p>;
    if (!kits || kits.state !== 'ready') return <>{loadingLine(kits?.state === 'failed' ? 'failed' : 'loading', s.kitsLoading, s.kitsFailed, () => setKitTry((n) => n + 1))}{note}</>;
    // A customer-colour item names its picked colour (or «لون عشوائي») instead of a fixed variant.
    const picked = (pid: string) => {
      const v = x4.kitColors?.[pid] ?? RANDOM;
      if (v === RANDOM) return o4.randomColour;
      return kits.data.kits.flatMap((k) => k.colours).find((c) => c.product_id === pid)?.colors.find((c) => c.id === v)?.name ?? o4.randomColour;
    };
    const name = (k: (typeof kits.data.kits)[number], i: PricedKit['items'][number]) => {
      const custom = k.colours.some((c) => c.product_id === i.product_id);
      const variant = custom ? picked(i.product_id) : i.variant;
      return `${lang === 'en' ? i.name : i.name_ar || i.name}${variant ? ` (${variant})` : ''} ×${i.qty_per_printer}${i.available ? '' : ` — ${s.kitItemOut}`}`;
    };
    return (
      <>
        {list(s.filament, [
          { id: '', label: s.kitSkip, right: '', lines: [], disabled: false },
          ...kits.data.kits.map((k) => ({
            id: k.id,
            label: k.title[lang] || k.title.ar,
            right: k.available && k.money.after_total !== null
              ? <BeforeAfter before={k.money.before_total} after={k.money.after_total} money={money} s={o4} plus />
              : s.unavailable,
            lines: [
              k.items.map((i) => name(k, i)).join(' · '),
              k.available && k.money.after_per !== null && (k.money.after_total !== k.money.after_per || k.money.saving_total > 0)
                ? `${k.money.before_per !== null && k.money.before_per > k.money.after_per ? `${o4.priceBefore} ${money(k.money.before_per)} · ` : ''}${money(k.money.after_per)} ${s.kitPerPrinter}`
                : '',
              k.available && k.money.saving_percent > 0 ? o4.save(k.money.saving_percent) : '',
            ],
            disabled: !k.available,
          })),
        ], kitId ?? '', (id) => setExtra({ kitId: id || null }))}
        {chosenKit ? <KitColours kit={chosenKit} picked={x4.kitColors} onPick={pickColour('kitColors')} lang={lang} dir={keyDir} money={money} /> : null}
        {note}
      </>
    );
  }

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
            {/* The server's figures for this exact draft — listed, never summed here. Folded at 390px so the footer stays
                two lines: «تفاصيل السعر» and «وفّرت X»; the total beside them never wraps. */}
            <div className={`min-w-0 flex-1 text-[11.5px] text-text-secondary ${stale ? 'opacity-50 transition-opacity' : ''}`}>
              {breakdown ? (
                <details data-sheet-breakdown>
                  <summary className="cursor-pointer font-semibold text-text-primary">{o4.priceDetails}</summary>
                  {figures && figures.sel.fee_iqd > 0 ? <span className="block tabular-nums" dir="auto">{s.services}: + {money(figures.sel.fee_iqd)}</span> : null}
                  {dFee !== null ? <span className="block tabular-nums" dir="auto">{s.deliveryLine}: + {money(dFee)}</span> : null}
                  {dFee !== null ? <span className="block">{s.deliveryApart}</span> : null}
                  {/* Phase 2: their own cart lines — each figure from its own endpoint, never added to the total. */}
                  {memberCharge !== null ? <span className="block tabular-nums" dir="auto" data-sheet-membership-charge>{s.membership}: + {money(memberCharge)}</span> : null}
                  {kitTotal !== null ? <span className="block tabular-nums" dir="auto" data-sheet-kit-total>{s.filament}: + {money(kitTotal)}</span> : null}
                  {addonsTotal !== null ? <span className="block tabular-nums" dir="auto" data-sheet-addons-total>{o4.addonsLine}: + {money(addonsTotal)}</span> : null}
                  {memberCharge !== null || kitTotal !== null || addonsTotal !== null ? <span className="block">{addonsTotal !== null ? o4.extrasApart : s.extrasApart}</span> : null}
                </details>
              ) : null}
              {savedTotal > 0 ? <span className="block font-semibold tabular-nums text-success" dir="auto" data-sheet-saved>{o4.saved(money(savedTotal))}</span> : null}
            </div>
            <div className="shrink-0 text-end" aria-live="polite" aria-atomic="true">
              <span className="block text-[11.5px] text-text-secondary">{s.total}</span>
              <span
                key={stale ? 'stale' : String(unit)}
                className={`block whitespace-nowrap text-[20px] font-bold tabular-nums text-text-primary ${stale ? 'opacity-50 transition-opacity' : 'animate-in fade-in duration-200 motion-reduce:animate-none'}`}
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
                onClick={() => { if (ready) onApply(applied, labels); }}
                className="min-h-12 shrink-0 rounded-full border border-border-subtle px-4 text-[14px] font-semibold text-text-primary press-scale disabled:opacity-50"
                data-sheet-apply
              >
                {busy ? s.saving : s.apply}
              </button>
              <button
                type="button"
                disabled={!ready}
                aria-busy={actionBusy || undefined}
                onClick={() => { if (ready) onApplyAndAdd(applied, labels); }}
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
              onClick={() => { if (ready) onApply(applied, labels); }}
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
            { id: 'c12' as const, label: s.careOption(draft.warranty === 'w24' ? 36 : draft.warranty === 'w12' ? 24 : 12), price: priceOf(offer.care?.c12) },
          ], draft.care, (v) => set({ care: v })), !offer.care)}

        {/* Phase 2: the membership bought WITH the printer — its own order line at the live plan price. */}
        {row('membership', <Crown className="w-5 h-5" aria-hidden="true" />, s.membership, s.membershipSub,
          memberCharge !== null ? `+${money(memberCharge)}` : draft.extras?.membershipPlanId === null ? s.none : '',
          membershipBody(), !memberOffered)}

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

        {/* Phase 2: the owner's filament kits for this printer — one kit or skip; no kit = the ordinary listing. */}
        {row('filament', <Spool className="w-5 h-5" aria-hidden="true" />, s.filament, kitsOffered ? s.filamentSub : s.filamentNote,
          kitTotal !== null ? `+${money(kitTotal)}` : draft.extras?.kitId === null ? s.none : '',
          kitsOffered ? kitsBody() : (
            <>
              <p className="text-[11.5px] leading-relaxed text-text-secondary">{s.filamentNote}</p>
              <Link to={FILAMENT_LISTING} className="mt-1 inline-flex min-h-11 items-center text-[12.5px] font-semibold text-text-primary underline">{s.filamentShop}</Link>
            </>
          ))}

        {/* Phase 4: the owner's add-ons at a special price — check cards, each its own cart line under the printer. */}
        {row('addons', <Package className="w-5 h-5" aria-hidden="true" />, o4.addonsRow, o4.addonsSub,
          addonsTotal !== null ? `+${money(addonsTotal)}` : addonIds.length ? o4.addonsChosen(addonIds.length) : '',
          addonList ? (
            <AddonsBody addons={addonList} chosen={addonIds} onToggle={toggleAddon} picked={x4.addonColors} onPick={pickColour('addonColors')} lang={lang} dir={keyDir} money={money} />
          ) : (
            <OffersLoading state={kits?.state === 'failed' ? 'failed' : 'loading'} lang={lang} again={() => setKitTry((n) => n + 1)} />
          ), !addonsOffered)}

        {/* Phase 4: the store bundles linked to this printer — added to the cart on their own, at their own price. */}
        {row('bundles', <ShoppingCart className="w-5 h-5" aria-hidden="true" />, o4.bundlesRow, o4.bundlesSub, '',
          bundleList ? (
            <BundlesBody bundles={bundleList} lang={lang} money={money} signedIn={!!user} signInPath={authPathWithSupportRef(`${location.pathname}${location.search}`)} />
          ) : (
            <OffersLoading state={kits?.state === 'failed' ? 'failed' : 'loading'} lang={lang} again={() => setKitTry((n) => n + 1)} />
          ), !bundlesOffered)}
      </div>
    </Sheet>
  );
}

/** A refused plan's code (the server's `options[].code`). */
function codeOf(o: MembershipOption): string {
  return 'code' in o ? o.code : '';
}

/** The sheet starts from what was confirmed, or from nothing paid (never from a package). */
function start(current: ServiceSelection | null, offer: ServicesOffer): ServiceSelection {
  // A delivery the offer no longer has (switched off) is not carried into the draft.
  const delivery = offer.delivery ? current?.delivery ?? null : null;
  if (current?.confirmed) return { ...current, delivery };
  return { ...EMPTY_SELECTION, delivery, ...(current?.extras ? { extras: current.extras } : {}) };
}
