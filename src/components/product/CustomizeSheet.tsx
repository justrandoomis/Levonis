/**
 * PHASE 7 (owner, 2026-11-20; DECISIONS row 363):
 *  - THE TOTAL IS THE WHOLE PURCHASE. The footer's «الإجمالي الحالي» used to be the printer's unit alone
 *    (the services quote's `unit_subtotal_iqd`): the kit, the add-ons and the membership were priced by
 *    their own endpoints, listed under «تفاصيل السعر» and deliberately never added — so picking a kit
 *    changed nothing in the figure the customer watches. It is now `sheetTotal` (printerServicesModel):
 *    printer unit × quantity + the kit + the ticked add-ons + the membership, each a server figure, each
 *    its own row in the details. Delivery is not in it.
 *  - Delivery is not asked here when the owner decides it at checkout; the details say so.
 *  - No warranty: the ✕ list of what the choice gives up, the agreement in one sentence, and the gate —
 *    while the box is unticked the buttons look disabled, and a press opens the warranty row and points
 *    at the box. A warranty option says the free return.
 *
 * PHASE 6 (owner, 2026-11-19; DECISIONS row 362) — four changes, all in this chunk:
 *  - the chosen option and the primary action wear the house's own states (`lv-choice`: a
 *    pressed fill and a gold check; `lv-button-accent`), not a pure white slab on a dark sheet;
 *  - under a price anchor every choice says what it does to the PRICE («مشمول في السعر», −, +);
 *  - each service says what it gives: one line under its title, and «ماذا يشمل؟» under its
 *    choices (printerServicesExplain.ts) — Levo Care, the most important one, opens with its facts;
 *  - the kit / add-on / bundle lists and the membership options are read when the sheet opens,
 *    from the answers the card already asked for (`warmSheet`), so a row's list is there when it
 *    is opened; a list still on its way is drawn as blocks of its rows' height.
 * Delivery lists the free warehouse pickup when the offer carries it.
 *
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
import { AddonsBody, BeforeAfter, BundlesBody, KitColours, OffersLoading, RANDOM, colourProblem, loadOffersWarm, offersNow, type OfferExtras, type PrinterOffers } from './PrinterOffersRows';
import { OFFER_STRINGS, offerErrorText } from './printerOfferStrings';
import { Sheet } from '../ui/Sheet';
import VariantImg from '../ui/VariantImg';
import { PS_STRINGS, ackSentence, servicesErrorText, type PsLang } from './printerServicesStrings';
import { OPEN_MAP_LABEL, noteWithoutLinks } from '../../lib/noteLinks';
import { NoteLinkRow } from '../ui/NoteLinks';
import { EXPLAIN } from './printerServicesExplain';
import {
  AGREEMENT_HOT,
  AGREEMENT_HOT_MS,
  CHOSEN_EDGE,
  EMPTY_SELECTION,
  anchorOf,
  anchoredStart,
  asCustom,
  asksDelivery,
  deliveryChoices,
  lostWith,
  pointAtAgreement,
  sheetTotal,
  deliveryFee,
  firstBlocker,
  loadMembershipOptions,
  moveRadioFocus,
  netFee,
  optionDelta,
  pickupOf,
  proSavingOf,
  readyToBuy,
  servicesOnly,
  signedMoney,
  tabStop,
  warmed,
  warmedNow,
  type DeliveryPick,
  type KitsFor,
  type ServiceKey,
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

/** What one account's membership options are remembered under (printerServicesModel `warmed`). */
const membersKey = (userId: string) => `m:${userId}`;

/**
 * Asked by the package card while it is idle (owner, 2026-11-19: «the filament kit and
 * subscription is delayed to show»): the kits / add-ons / bundles answer for this printer
 * selection, and — signed in — the membership options. Each once per key; the sheet reads the
 * same answers when it opens, so its rows are there on the first paint.
 */
export function warmSheet(offer: ServicesOffer, kitsFor: KitsFor | null, lang: PsLang, userId: string | null): void {
  if (kitsFor && (offer.kits.length || (offer.addons ?? []).length || (offer.store_bundles ?? []).length)) {
    void loadOffersWarm(kitsFor, null, lang).catch(() => undefined);
  }
  if (userId && offer.membership && offer.membership.tiers.length) {
    void warmed(membersKey(userId), () => loadMembershipOptions()).catch(() => undefined);
  }
}
/** «PRO −50%» on the services (owner, 2026-11-19): the saving the server reported for this draft. */
const PRO_SAVING: Record<PsLang, (pct: number, amount: string) => string> = {
  ar: (pct, amount) => `خصم PRO ${pct}% على الخدمات: وفّرت ${amount}`,
  en: (pct, amount) => `PRO ${pct}% off services: you save ${amount}`,
  ckb: (pct, amount) => `داشکاندنی PRO ${pct}% بۆ خزمەتگوزارییەکان: ${amount} پاشەکەوت دەکەیت`,
};

type DraftQuote = { key: string; state: 'fresh' | 'failed'; unit: number | null; sel: QuotedSelection | null };

type RowKey = 'warranty' | 'care' | 'membership' | 'packaging' | 'delivery' | 'inspection' | 'academy' | 'filament' | 'addons' | 'bundles';

export default function CustomizeSheet({ open, onClose, onApply, onApplyAndAdd, adding = false, offer, current, printer, lang, money, quote, busy = false, error = null, kitsFor = null }: CustomizeSheetProps) {
  const s = PS_STRINGS[lang];
  const o4 = OFFER_STRINGS[lang];
  const x = EXPLAIN[lang];
  const anchor = anchorOf(offer);
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
  // Read as soon as the sheet opens — from the answers the card already asked for (`warmSheet`) —
  // so a row shows its list the moment it is opened, not a request later.
  const wantMembers = open && memberOffered && !!user;
  const wantKits = open && !!kitsFor && (kitsOffered || addonsOffered || bundlesOffered);
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
  const memberTried = useRef(0);
  useEffect(() => {
    if (!wantMembers || !user?.id) return;
    let alive = true;
    const key = membersKey(user.id);
    // «إعادة المحاولة» asks the server again; otherwise the card's warm answer is the first paint.
    const again = memberTried.current !== memberTry;
    memberTried.current = memberTry;
    const here = again ? undefined : warmedNow<MembershipOptions>(key);
    if (here) setMembers({ state: 'ready', data: here });
    else setMembers((m) => (m?.state === 'ready' ? m : { state: 'loading' }));
    warmed(key, () => loadMembershipOptions(), again).then(
      (data) => { if (alive) setMembers({ state: 'ready', data }); },
      () => { if (alive) setMembers({ state: 'failed' }); }
    );
    return () => { alive = false; };
  }, [wantMembers, memberTry, user?.id, offerMemberKey]);
  // A colour tap re-reads the figures (a colour may carry its own price): the last answer stays on screen
  // meanwhile, and the apply waits for the answer of exactly these colours (`coloursFresh`).
  const [pricedColours, setPricedColours] = useState('');
  const kitTried = useRef(0);
  // The selection whose list is on screen: only a colour tap AFTER that is debounced.
  const kitsRead = useRef('');
  useEffect(() => {
    if (!wantKits || !kitsKey) return;
    let alive = true;
    const f = JSON.parse(kitsKey) as KitsFor;
    const colours = Object.fromEntries(JSON.parse(coloursKey) as Array<[string, string]>);
    const again = kitTried.current !== kitTry;
    kitTried.current = kitTry;
    const landed = (data: PrinterOffers) => { if (alive) { kitsRead.current = kitsKey; setKits({ state: 'ready', data }); setPricedColours(coloursKey); } };
    // The card's warm answer for exactly this selection and these colours: on screen at once.
    const here = again ? undefined : offersNow(f, colours, lang);
    if (here) { landed(here); return () => { alive = false; }; }
    setKits((k) => (k?.state === 'ready' ? k : { state: 'loading' }));
    const ask = () => { loadOffersWarm(f, colours, lang, again).then(landed, () => { if (alive) setKits({ state: 'failed' }); }); };
    // The first read of a selection is asked at once; a colour tap waits a moment for the next one.
    const timer = kitsRead.current === kitsKey ? setTimeout(ask, 150) : (ask(), undefined);
    return () => { alive = false; if (timer) clearTimeout(timer); };
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
  // Only when EVERY ticked add-on has its server figure: a partial sum is never shown as the add-ons' total.
  const addonsTotal = addonTotals.length && addonTotals.length === addonIds.length ? addonTotals.reduce((a, b) => a + b, 0) : null;
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
  const quotedOnce = useRef(false);
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
    // The opening's own figure is asked at once; a tap waits a moment for the next one.
    const timer = setTimeout(() => {
      quote(sel, ac.signal).then(
        (r) => { if (!ac.signal.aborted) { quotedOnce.current = true; setQ({ key: draftKey, state: 'fresh', unit: r?.unit_iqd ?? null, sel: r?.selection ?? null }); } },
        () => { if (!ac.signal.aborted) setQ({ key: draftKey, state: 'failed', unit: null, sel: null }); }
      );
    }, quotedOnce.current ? 250 : 0);
    return () => { clearTimeout(timer); ac.abort(); };
  }, [open, draftKey, canQuote]);
  const fresh = quote && q?.key === draftKey ? q : null;
  const priced = fresh?.state === 'fresh' ? fresh.sel : null;
  const blocker = firstBlocker(priced);
  const complete = readyToBuy(applied, offer);
  const quoted = !quote || (fresh?.state === 'fresh' && !!priced && !blocker);
  const ready = complete && quoted && !extrasBlock && !busy && !adding;
  /*
   * THE AGREEMENT GATE (phase 7). `ackMissing` = no warranty and the box unticked. The buttons then LOOK
   * disabled (aria-disabled, muted) but stay pressable: a press opens the warranty row, brings the box to
   * the centre, focuses it and pulses it, with one line that says what to tick.
   */
  const ackMissing = draft.warranty === 'none' && !draft.ack_no_warranty;
  const lost = lostWith(draft);
  const ackBox = useRef<HTMLDivElement | null>(null);
  const [pointed, setPointed] = useState(0);
  const [hot, setHot] = useState(false);
  useEffect(() => {
    if (!pointed) return;
    pointAtAgreement(ackBox.current);
    setHot(true);
    const t = window.setTimeout(() => setHot(false), AGREEMENT_HOT_MS);
    return () => window.clearTimeout(t);
  }, [pointed]);
  const askAgreement = () => { setOpenRow('warranty'); setPointed((n) => n + 1); };
  const gateLook = ackMissing && !busy && !adding ? { opacity: 0.5, filter: 'grayscale(1)' } : undefined;
  const hint = extrasBlock ? extrasBlock : !complete
    ? asksDelivery(offer) && draft.delivery === null ? s.deliveryChoose : ackMissing ? s.ackAsk : ''
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
  // The line's printer quantity: the page's (or the cart line's) — what the kit and the add-ons are priced for.
  const printerQty = Math.max(1, Math.trunc(Number(kitsFor?.qty) || 1));
  const dFee = figures ? figures.sel.delivery_fee_iqd : null;
  /** The PRO services discount on this draft (owner, 2026-11-19): a server figure, only shown. */
  const proSaved = figures ? proSavingOf(figures.sel, draft.delivery) : 0;
  /** Anything the folded «تفاصيل السعر» would list. */
  // Under an anchor the services line is what the draft does to the PRICE (the server's net figure).
  const net = figures && anchor ? netFee(figures.sel) : null;
  const servicesSaid = !figures ? null : net !== null ? (net === 0 ? s.included : signedMoney(net, money)) : figures.sel.fee_iqd > 0 ? `+ ${money(figures.sel.fee_iqd)}` : null;
  /*
   * THE TOTAL (phase 7): the printer × its quantity plus everything chosen with it — what the cart will show
   * for these lines. An extra that is chosen but not priced yet (its list is loading, or its colours are being
   * re-priced) holds the figure back, dimmed: never a sum that leaves a chosen line out.
   */
  const total = sheetTotal({ unit_iqd: unit, qty: printerQty, kit_total_iqd: kitTotal, addons_total_iqd: addonsTotal, membership_iqd: memberCharge });
  const extrasPending = (!!kitId && kitTotal === null) || (addonIds.length > 0 && addonsTotal === null) || (!!planId && memberCharge === null);
  const extrasStale = (!!chosenKit || chosenAddons.length > 0) && !coloursFresh;
  const grand = extrasPending ? null : total.total_iqd;
  const dim = stale || extrasStale;
  const breakdown = total.printer_iqd !== null || servicesSaid !== null || dFee !== null || memberCharge !== null || kitTotal !== null || addonsTotal !== null;

  const row = (key: RowKey, icon: React.ReactNode, title: string, sub: string, value: string, body: React.ReactNode, hidden = false, tag = '') => {
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
          className="flex min-h-14 w-full items-center gap-3 px-1 py-2.5 text-start [touch-action:manipulation] active:opacity-70"
        >
          <span className="shrink-0 text-text-secondary">{icon}</span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2">
              <span className="text-[14px] font-bold text-text-primary">{title}</span>
              {tag ? <span className="shrink-0 text-[10px] font-bold leading-4 text-gold" data-sheet-tag>{tag}</span> : null}
            </span>
            {/* One line that says what the service gives — read without opening the row. */}
            <span className="mt-0.5 block text-[11.5px] leading-snug text-text-secondary">{sub}</span>
          </span>
          <bdi className={`shrink-0 text-[12.5px] font-bold tabular-nums ${value === s.included ? 'text-gold' : 'text-text-primary'}`} data-sheet-value>{value}</bdi>
          <ChevronDown aria-hidden="true" className={`w-4 h-4 shrink-0 text-text-secondary transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
        </button>
        {/* Revealed with opacity and a 4px slide (compositor only): the height
            change itself is a single reflow, never animated frame by frame. */}
        {expanded ? <div id={panelId} className="animate-in fade-in slide-in-from-top-2 duration-200 motion-reduce:animate-none px-1 pb-3">{body}</div> : null}
      </div>
    );
  };

  const choice = <T extends string>(name: string, options: Array<{ id: T; label: string; price: number | null; sub?: string; said?: string }>, value: T, onPick: (v: T) => void, cols = 2) => {
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
              style={on ? CHOSEN_EDGE : undefined}
              className="lv-choice min-h-12 px-2.5 py-2 text-start [touch-action:manipulation] disabled:opacity-50"
            >
              <span className="flex items-start justify-between gap-1.5">
                <span className="text-[12.5px] font-bold leading-tight text-text-primary">{o.label}</span>
                <span aria-hidden="true" className="lv-choice-mark"><Check className="h-3 w-3" /></span>
              </span>
              <bdi className={`mt-0.5 block text-[11px] tabular-nums ${o.said === s.included ? 'font-bold text-gold' : 'text-text-secondary'}`}>
                {o.said ?? (o.id === 'none' ? ' ' : o.price === null ? s.unavailable : o.price === 0 ? s.free : `+${money(o.price)}`)}
              </bdi>
              {o.sub ? <span className="block text-[10.5px] leading-snug text-text-secondary">{o.sub}</span> : null}
            </button>
          );
        })}
      </div>
    );
  };

  const priceOf = (v: number | null | undefined) => (v === null || v === undefined ? null : v);
  const shown = (v: number | null) => (v === null ? '—' : v === 0 ? s.free : `+${money(v)}`);
  /*
   * Phase 6 (DECISIONS row 362): every choice of the four priced services says what it does to the
   * PRICE — «مشمول في السعر» for what the price already holds, a minus for less, a plus for more.
   * Without an anchor nothing is included, so the figures are the «+» prices they always were.
   */
  const opt = <T extends string>(service: ServiceKey, id: T, label: string) => {
    const d = optionDelta(offer, service, id);
    return { id, label, price: d ? d.iqd : null, said: !d ? s.unavailable : d.included ? s.included : d.iqd === 0 ? (id === 'none' ? ' ' : s.free) : signedMoney(d.iqd, money) };
  };
  /** The collapsed row's figure for the choice in force; `zero` is its word when it changes nothing. */
  const valueOf = (service: ServiceKey, id: string, zero: string) => {
    const d = optionDelta(offer, service, id);
    return !d ? '—' : d.included ? s.included : d.iqd === 0 ? zero : signedMoney(d.iqd, money);
  };
  /** «ماذا يشمل؟» — the facts of one service, folded under its choices (printerServicesExplain.ts). */
  const includes = (key: string, points: string[], opened = false, first = '') => (
    <details className="mt-1" open={opened || undefined} data-sheet-includes={key}>
      <summary className="inline-flex min-h-11 cursor-pointer items-center text-[12px] font-bold text-text-primary underline">{x.whatIncluded}</summary>
      <ul className="list-disc space-y-1 ps-5 text-[11.5px] leading-relaxed text-text-secondary">
        {(first ? [first, ...points] : points).map((line, i) => <li key={i}>{line}</li>)}
      </ul>
    </details>
  );
  const warrantyValue = valueOf('warranty', draft.warranty, draft.warranty === 'none' ? s.none : s.free);
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
              style={on ? CHOSEN_EDGE : undefined}
              className={`lv-choice min-h-12 w-full px-2.5 py-2 text-start [touch-action:manipulation] disabled:opacity-50 ${o.suggested && !on ? 'border-dashed' : ''}`}
            >
              <span className="flex items-center justify-between gap-1.5">
                <span className="text-[12.5px] font-bold leading-tight text-text-primary">{o.label}</span>
                <span className="flex shrink-0 items-center gap-1.5 text-[12px] font-bold tabular-nums text-text-primary" dir="auto">
                  {o.right}
                  <span aria-hidden="true" className="lv-choice-mark"><Check className="h-3 w-3" /></span>
                </span>
              </span>
              {o.lines.filter(Boolean).map((l, i) => (
                <span key={i} className="mt-0.5 block text-[11px] leading-snug text-text-secondary" dir="auto">{l}</span>
              ))}
            </button>
          );
        })}
      </div>
    );
  };

  const loadingLine = (state: 'loading' | 'failed', loading: string, failed: string, again: () => void, rows = 2) =>
    state === 'loading' ? (
      <OffersLoading state="loading" lang={lang} again={again} rows={rows} label={loading} />
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
    if (!members || members.state !== 'ready') return <>{loadingLine(members?.state === 'failed' ? 'failed' : 'loading', s.memberLoading, s.memberFailed, () => setMemberTry((n) => n + 1), (offer.membership?.tiers.length ?? 1) + 1)}{terms}</>;
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
    if (!kits || kits.state !== 'ready') return <>{loadingLine(kits?.state === 'failed' ? 'failed' : 'loading', s.kitsLoading, s.kitsFailed, () => setKitTry((n) => n + 1), offer.kits.length + 1)}{note}</>;
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
            <div className={`min-w-0 flex-1 text-[11.5px] text-text-secondary ${dim ? 'opacity-50 transition-opacity' : ''}`}>
              {breakdown ? (
                <details data-sheet-breakdown>
                  <summary className="cursor-pointer font-semibold text-text-primary">{o4.priceDetails}</summary>
                  {/* Each part of the total is its own row: the printer (its services inside), then what is bought with it. */}
                  {total.printer_iqd !== null ? <span className="block tabular-nums" dir="auto" data-sheet-printer-line>{s.printerLine}{printerQty > 1 ? ` ×${printerQty}` : ''}: {money(total.printer_iqd)}</span> : null}
                  {servicesSaid !== null ? <span className="block tabular-nums" data-sheet-services>{s.services}: <bdi>{servicesSaid}</bdi></span> : null}
                  {dFee !== null ? <span className="block tabular-nums" dir="auto">{s.deliveryLine}: {dFee === 0 ? s.free : `+ ${money(dFee)}`}</span> : null}
                  {dFee !== null && dFee > 0 ? <span className="block">{s.deliveryApart}</span> : null}
                  {proSaved > 0 && figures?.sel.pro_discount ? (
                    <span className="block font-semibold tabular-nums text-success" dir="auto" data-sheet-pro-saving>
                      {PRO_SAVING[lang](figures.sel.pro_discount.pct, money(proSaved))}
                    </span>
                  ) : null}
                  {/* Phase 2: their own cart lines — each figure from its own endpoint, never added to the total. */}
                  {memberCharge !== null ? <span className="block tabular-nums" dir="auto" data-sheet-membership-charge>{s.membership}: + {money(memberCharge)}</span> : null}
                  {kitTotal !== null ? <span className="block tabular-nums" dir="auto" data-sheet-kit-total>{s.filament}: + {money(kitTotal)}</span> : null}
                  {addonsTotal !== null ? <span className="block tabular-nums" dir="auto" data-sheet-addons-total>{o4.addonsLine}: + {money(addonsTotal)}</span> : null}
                  {/* Delivery is decided at checkout (phase 7): never in this total, and said so. */}
                  {!asksDelivery(offer) && offer.delivery ? <span className="block" data-sheet-no-delivery>{s.totalNoDelivery}</span> : null}
                </details>
              ) : null}
              {savedTotal > 0 ? <span className="block font-semibold tabular-nums text-success" dir="auto" data-sheet-saved>{o4.saved(money(savedTotal))}</span> : null}
            </div>
            <div className="shrink-0 text-end" aria-live="polite" aria-atomic="true">
              <span className="block text-[11.5px] text-text-secondary">{s.total}</span>
              <span
                key={dim ? 'stale' : String(grand)}
                className={`block whitespace-nowrap text-[20px] font-bold tabular-nums text-text-primary ${dim ? 'opacity-50 transition-opacity' : 'animate-in fade-in duration-200 motion-reduce:animate-none'}`}
                dir="auto"
                data-sheet-total
              >
                {grand === null ? '—' : money(grand)}
              </span>
            </div>
          </div>
          {error ? <p role="alert" className="mb-2 text-center text-[12px] text-text-primary" data-sheet-error>{error}</p> : null}
          {onApplyAndAdd ? (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!ready && !ackMissing}
                aria-disabled={ackMissing || undefined}
                style={gateLook}
                onClick={() => { if (ackMissing) askAgreement(); else if (ready) onApply(applied, labels); }}
                className="lv-button lv-button-secondary shrink-0"
                data-sheet-apply
              >
                {busy ? s.saving : s.apply}
              </button>
              <button
                type="button"
                disabled={!ready && !ackMissing}
                aria-disabled={ackMissing || undefined}
                style={gateLook}
                aria-busy={actionBusy || undefined}
                onClick={() => { if (ackMissing) askAgreement(); else if (ready) onApplyAndAdd(applied, labels); }}
                className="lv-button lv-button-accent min-w-0 flex-1"
                data-sheet-add
              >
                <ShoppingCart aria-hidden="true" className="w-4 h-4" /> {adding ? s.adding : s.addToCart}
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={!ready && !ackMissing}
              aria-disabled={ackMissing || undefined}
              style={gateLook}
              aria-busy={busy || undefined}
              onClick={() => { if (ackMissing) askAgreement(); else if (ready) onApply(applied, labels); }}
              className="lv-button lv-button-accent w-full"
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
        {row('warranty', <Shield className="w-5 h-5" aria-hidden="true" />, s.warranty, x.warrantySum, warrantyValue, (
          <>
            {choice(s.warranty, [
              opt('warranty', 'none' as const, s.none),
              { ...opt('warranty', 'w12' as const, s.months(12)), sub: s.freeReturn },
              { ...opt('warranty', 'w24' as const, s.months(24)), sub: s.freeReturn },
            ], draft.warranty, (w) => set({ warranty: w, ack_no_warranty: w === 'none' ? draft.ack_no_warranty : false }), 3)}
            <p className="mt-2 text-[11.5px] leading-relaxed text-text-secondary">{s.warrantyNote}</p>
            {draft.warranty === 'none' ? (
              <div ref={ackBox} style={hot && ackMissing ? AGREEMENT_HOT : undefined} className="animate-in fade-in slide-in-from-top-2 duration-200 motion-reduce:animate-none mt-2 rounded-xl border border-border-subtle p-2.5" data-agreement={ackMissing ? (hot ? 'pointed' : 'needed') : 'given'}>
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
                  <input type="checkbox" className="h-5 w-5 shrink-0" style={{ accentColor: 'var(--color-gold)' }} checked={draft.ack_no_warranty} onChange={(e) => set({ ack_no_warranty: e.target.checked })} data-agreement-box />
                  <span>{ackSentence(s, lost)}</span>
                </label>
                {hot && ackMissing ? <p role="alert" className="mt-1 text-[12px] font-bold text-warning" data-agreement-ask>{s.ackAsk}</p> : null}
              </div>
            ) : null}
            {/* Phase 7: the owner's free-return rule heads the list (its number is WARRANTY_FREE_RETURN_DAYS). */}
            {includes('warranty', x.warranty, false, `${s.freeReturnWith}.`)}
            <Link to="/policies/extended_warranty" className="inline-flex min-h-11 items-center text-[12px] text-text-secondary underline">{s.terms}</Link>
          </>
        ), !offer.warranty)}

        {/* Levo Care is the service the owner calls the most important: it wears the tag, and its facts open with the row. */}
        {row('care', <Heart className="w-5 h-5" aria-hidden="true" />, s.care, s.careSub(offer.care?.max_discount_pct ?? 90),
          valueOf('care', draft.care, draft.care === 'none' ? s.none : s.free),
          <>
            {choice(s.care, [
              opt('care', 'none' as const, s.none),
              { ...opt('care', 'c12' as const, ''), label: s.careOption(draft.warranty === 'w24' ? 36 : draft.warranty === 'w12' ? 24 : 12) },
            ], draft.care, (v) => set({ care: v }))}
            {/* What Care includes (DECISIONS row 359): the parts discount, the weekly coupons, the monthly draw — a chance, never a promise. */}
            {includes('care', x.care(offer.care?.max_discount_pct ?? 90), true)}
          </>, !offer.care, x.mostImportant)}

        {/* Phase 2: the membership bought WITH the printer — its own order line at the live plan price. */}
        {row('membership', <Crown className="w-5 h-5" aria-hidden="true" />, s.membership, s.membershipSub,
          memberCharge !== null ? `+${money(memberCharge)}` : draft.extras?.membershipPlanId === null ? s.none : '',
          membershipBody(), !memberOffered)}

        {row('packaging', <Package className="w-5 h-5" aria-hidden="true" />, s.packaging, x.packagingSum,
          valueOf('packaging', draft.packaging, draft.packaging === 'extra' ? s.free : s.packagingStandard),
          <>
            {choice(s.packaging, [
              opt('packaging', 'standard' as const, s.packagingStandard),
              opt('packaging', 'extra' as const, s.packagingExtra),
            ], draft.packaging, (v) => set({ packaging: v }))}
            {includes('packaging', x.packaging)}
          </>, !offer.packaging)}

        {/* How the printer arrives: Economy, Personal, or — when the owner offers it — the free warehouse pickup with its note. */}
        {row('delivery', <Truck className="w-5 h-5" aria-hidden="true" />, s.delivery, s.deliveryChoose,
          draft.delivery === null ? '—' : shown(deliveryFee(offer, draft.delivery)),
          <>
            {list(s.delivery, deliveryChoices(offer).map((d) => {
              const fee = deliveryFee(offer, d);
              return {
                id: d as string,
                label: d === 'economy' ? s.deliveryEconomy : d === 'personal' ? s.deliveryPersonal : s.deliveryPickup,
                right: fee === null ? s.unavailable : fee === 0 ? s.free : `+${money(fee)}`,
                // The pickup line's words; its map link is drawn under the choices (row 365).
                lines: [d === 'economy' ? s.deliveryEconomySub : d === 'personal' ? s.deliveryPersonalSub : noteWithoutLinks(pickupOf(offer)?.note?.[lang]) || s.deliveryPickupSub],
                disabled: fee === null,
              };
            }), draft.delivery ?? '', (v) => set({ delivery: v as DeliveryChoice }))}
            {deliveryChoices(offer).includes('pickup') ? <NoteLinkRow text={pickupOf(offer)?.note?.[lang]} label={OPEN_MAP_LABEL[lang]} lead={s.deliveryPickup} /> : null}
          </>, !asksDelivery(offer))}

        {row('inspection', <ClipboardCheck className="w-5 h-5" aria-hidden="true" />, s.inspection, x.inspectionSum,
          valueOf('inspection', draft.inspection, draft.inspection === 'full' ? s.free : s.none),
          <>
            {choice(s.inspection, [
              opt('inspection', 'none' as const, s.none),
              opt('inspection', 'full' as const, s.inspectionOption),
            ], draft.inspection, (v) => set({ inspection: v }))}
            {offer.inspection && draft.inspection === 'full' ? <p className="mt-2 text-[11.5px] text-text-secondary">{s.inspectionLead(offer.inspection.lead_business_days[0], offer.inspection.lead_business_days[1])}</p> : null}
            {offer.inspection ? includes('inspection', x.inspection(offer.inspection.lead_business_days[0], offer.inspection.lead_business_days[1])) : null}
          </>, !offer.inspection)}

        {row('academy', <CirclePlay className="w-5 h-5" aria-hidden="true" />, s.academy, x.academySum,
          academyLive ? shown(priceOf(offer.academy?.live)) : s.free,
          <>
            {choice<AcademyChoice>(s.academy, [
              { id: 'recorded', label: s.academyRecorded, price: priceOf(offer.academy?.recorded) },
              { id: 'live_whatsapp', label: s.academyWhatsapp, price: priceOf(offer.academy?.live) },
              { id: 'live_in_person', label: s.academyInPerson, price: priceOf(offer.academy?.live) },
            ], draft.academy, (v) => set({ academy: v }))}
            {academyLive ? <p className="mt-2 text-[11.5px] text-text-secondary">{s.academyNote}</p> : null}
            {includes('academy', x.academy)}
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
            <OffersLoading state={kits?.state === 'failed' ? 'failed' : 'loading'} lang={lang} again={() => setKitTry((n) => n + 1)} rows={offerAddons.length} />
          ), !addonsOffered)}

        {/* Phase 4: the store bundles linked to this printer — added to the cart on their own, at their own price. */}
        {row('bundles', <ShoppingCart className="w-5 h-5" aria-hidden="true" />, o4.bundlesRow, o4.bundlesSub, '',
          bundleList ? (
            <BundlesBody bundles={bundleList} lang={lang} money={money} signedIn={!!user} signInPath={authPathWithSupportRef(`${location.pathname}${location.search}`)} />
          ) : (
            <OffersLoading state={kits?.state === 'failed' ? 'failed' : 'loading'} lang={lang} again={() => setKitTry((n) => n + 1)} rows={offerBundles.length} />
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
  // A delivery the offer no longer has (switched off, or the pickup taken away) is not carried into the draft.
  // Phase 7: nor one the page no longer asks for (decided at checkout) or a disabled Personal.
  const held = current?.delivery ?? null;
  const delivery = held && deliveryChoices(offer).includes(held as DeliveryPick) ? held : null;
  if (current?.confirmed) return { ...current, delivery };
  // Under an anchor (phase 6) the price already holds the Smart package, so the draft opens on it — never on less.
  const included = anchoredStart(offer);
  return { ...(included ? { ...included, confirmed: false } : EMPTY_SELECTION), delivery, ...(current?.extras ? { extras: current.extras } : {}) };
}
