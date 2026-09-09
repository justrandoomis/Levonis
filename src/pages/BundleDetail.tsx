import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Lock, Package, Sparkles } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError, formatIqd, type ApiProduct, type CartItem } from '../lib/api';
import { useAuth } from '../AuthContext';
import { refusalText } from '../lib/refusalStrings';
import { useFreshOnReturn } from '../lib/useFreshOnReturn';
import SafeImage from '../components/ui/SafeImage';
import CardPrice from '../components/CardPrice';
import Countdown from '../components/ui/Countdown';
import BundleSavingLine from '../components/bundles/BundleSavingLine';
import { BundleDetailSkeleton } from '../components/ui/Skeleton';
import { ErrorState } from '../components/ui/AsyncStates';
import Note from '../components/ui/Note';
import { tierLabel } from '../components/subscription/tierMeta';
import { StateChip, type BundleCard } from '../components/bundles/BundleTile';

/**
 * ONE BUNDLE OR MYSTERY OFFER (docs/BUNDLES_MYSTERY.md §10, §13).
 *
 * `src/pages/Product.tsx` is the template — the same hero, the same emerald /
 * amber / red mode chip, the same section rhythm, the same purchase surface.
 *
 * THIS PAGE IS THE ONLY PRODUCER OF §5.2's REQUEST BODY. Nothing else in `src/`
 * sends `bundleChoices`, `mysteryFamilyId` or `mysteryMode`, so without it the
 * whole cart, checkout, reveal and return path could be reached only by seeding
 * `cart_items` directly — which is what the test suite does and a customer
 * cannot. Every value it sends is an ID the server gave it: never a price,
 * never a component total, never a saving, never a stock number, never a
 * composition key.
 *
 * THE PRICE IS THE SERVER'S, TWICE. The card's figures come from the detail
 * payload; changing a choice, a family, a mode or a transport re-asks
 * `POST /api/products/:slug/quote` — debounced, sequence-guarded — and the
 * button quotes what that answered. A refusal is decoded from its CODE through
 * `refusalText`, never rendered as the server's untranslated sentence (§15.3).
 *
 * TWO THINGS THIS PAGE MUST NEVER DO.
 *
 *  - It must never show a number the viewer cannot pay. A locked payload does
 *    not merely hide its prices in the markup: the server never sent them
 *    (§9's allow-list), so there is nothing here to leak through a devtools
 *    panel or a saved response.
 *
 *  - It must never classify. The per-component chips, the bundle state, the
 *    saving and the shipping mode are all strings the server computed with the
 *    same functions the cart and the door will use.
 */

const STRINGS = {
  ar: {
    inside: 'ما داخل الباقة',
    optional: 'اختياري',
    editable: 'تختاره أنت',
    locked: 'هذا العرض حصري للمشتركين',
    lockedBody: 'اشترك للوصول إلى هذا العرض وسعره.',
    lockedCta: 'اشترك الآن',
    signIn: 'سجّل الدخول',
    notYet: 'الشراء غير متاح لهذا العرض حاليًا',
    back: 'رجوع',
    choices: 'الخيارات المتاحة',
    total: 'قيمة المكوّنات منفردة',
    add: 'أضف إلى السلة',
    adding: 'جارٍ الإضافة…',
    added: 'أُضيف إلى السلة',
    qty: 'الكمية',
    maxReached: 'الحد الأقصى لهذا الطلب',
    chooseOption: 'اختر',
    chooseColor: 'اختر اللون',
    family: 'اختر النوع',
    familyAny: 'أي نوع',
    mode: 'طريقة الشراء',
    modeDirect: 'شراء مباشر',
    modePreorder: 'طلب مسبق',
    transport: 'طريقة الشحن',
    spools: 'عدد القطع العشوائية',
    revealAt: 'يُكشف المحتوى عند',
    odds: 'الاحتمالات',
    signInToBuy: 'سجّل الدخول للشراء',
    addFailed: 'تعذّرت الإضافة إلى السلة',
    optionalKeep: 'ضمّنه',
  },
  en: {
    inside: 'Inside the bundle',
    optional: 'Optional',
    editable: 'You choose',
    locked: 'This offer is members only',
    lockedBody: 'Subscribe to see this offer and its price.',
    lockedCta: 'Subscribe now',
    signIn: 'Sign in',
    notYet: 'This offer cannot be bought right now',
    back: 'Back',
    choices: 'Available choices',
    total: 'The parts bought separately',
    add: 'Add to cart',
    adding: 'Adding…',
    added: 'Added to cart',
    qty: 'Quantity',
    maxReached: 'Maximum for this order',
    chooseOption: 'Choose',
    chooseColor: 'Choose a colour',
    family: 'Choose a type',
    familyAny: 'Any type',
    mode: 'Purchase mode',
    modeDirect: 'Direct',
    modePreorder: 'Pre-order',
    transport: 'Shipping method',
    spools: 'Random items',
    revealAt: 'Contents revealed at',
    odds: 'Odds',
    signInToBuy: 'Sign in to buy',
    addFailed: 'Could not add to cart',
    optionalKeep: 'Include',
  },
  ckb: {
    inside: 'ناوەڕۆکی پاکێج',
    optional: 'ئارەزوومەندانە',
    editable: 'خۆت هەڵیدەبژێریت',
    locked: 'ئەم پێشنیارە تەنها بۆ ئەندامانە',
    lockedBody: 'بەشداری بکە بۆ بینینی ئەم پێشنیارە و نرخەکەی.',
    lockedCta: 'ئێستا بەشداری بکە',
    signIn: 'چوونەژوورەوە',
    notYet: 'ئێستا ناتوانرێت ئەم پێشنیارە بکڕدرێت',
    back: 'گەڕانەوە',
    choices: 'هەڵبژاردنە بەردەستەکان',
    total: 'نرخی پارچەکان بە جیا',
    add: 'زیادکردن بۆ سەبەتە',
    adding: 'زیاد دەکرێت…',
    added: 'زیادکرا بۆ سەبەتە',
    qty: 'بڕ',
    maxReached: 'زۆرترین بڕ بۆ ئەم داواکارییە',
    chooseOption: 'هەڵبژێرە',
    chooseColor: 'ڕەنگ هەڵبژێرە',
    family: 'جۆر هەڵبژێرە',
    familyAny: 'هەر جۆرێک',
    mode: 'شێوازی کڕین',
    modeDirect: 'کڕینی ڕاستەوخۆ',
    modePreorder: 'داواکاری پێشوەخت',
    transport: 'شێوازی گەیاندن',
    spools: 'ژمارەی پارچە هەڕەمەکییەکان',
    revealAt: 'ناوەڕۆک ئاشکرا دەبێت لە',
    odds: 'ئەگەرەکان',
    signInToBuy: 'بۆ کڕین بچۆ ژوورەوە',
    addFailed: 'نەتوانرا زیاد بکرێت بۆ سەبەتە',
    optionalKeep: 'لەخۆی بگرە',
  },
} as const;

interface ComponentView {
  component_id: string;
  product_id: string;
  slug: string;
  name: string;
  image: string;
  qty_per_bundle: number;
  optional: boolean;
  included: boolean;
  editable: { option: boolean; color: boolean };
  state: string;
  variant_label: string;
  choices: Array<{ dim: string; id: string; name: string }>;
}

/** §10's mystery block — `{ spool_qty, families[], modes[], reveal_stage,
 *  odds? }` and NEVER a pool, a candidate, a weight or a product. */
interface MysteryBlockView {
  spool_qty: number;
  modes: string[];
  families: Array<{ id: string; label: string }> | string[];
  family_id: string;
  customer_picks_family: boolean;
  reveal_stage: string;
  odds?: Array<{ family_id: string; percent: number }>;
}

interface BundleDetailPayload extends BundleCard {
  images?: string[];
  description?: string;
  description_ar?: string;
  description_ku?: string;
  viewer_tier?: { tier: string; active: boolean; pricing_active: boolean };
  composition?: BundleCard['composition'] & {
    kind?: string;
    discount_iqd: number;
    max_qty: number;
    max_qty_per_order: number;
    components: ComponentView[];
  };
  mystery?: MysteryBlockView;
  availability?: {
    mode: string;
    reason: string | null;
    stock: { max_qty: number; scope: string };
    modes: Array<{ type: string; usable: boolean; reason: string | null }>;
  };
  pricing_modes?: {
    direct: { unit_subtotal_iqd: number } | null;
    preorder: Array<{ method: string; prepaid: unknown; cod: unknown }>;
  };
}

/** The §5.2 quote answer: the server's figures for THIS selection. */
interface CompositionQuote {
  applied_iqd: number;
  regular_iqd: number;
  component_total_iqd: number;
  saving_percent: number;
  unit_subtotal_iqd: number;
  line_total_iqd: number;
  qty: number;
  errors: string[];
}

export default function BundleDetail() {
  const { slug = '' } = useParams();
  const { dir, lang, loc } = useLanguage();
  const s = STRINGS[lang];
  const navigate = useNavigate();

  const { isAuthenticated } = useAuth();

  const [bundle, setBundle] = useState<BundleDetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  // ---- the buyer's selection. Every value here is an ID the server sent.
  const [qty, setQty] = useState(1);
  /** componentId -> { optionValueIds, colorId, included } (§5.2). */
  const [choices, setChoices] = useState<Record<string, { optionValueIds: string[]; colorId: string; included: boolean }>>({});
  const [familyId, setFamilyId] = useState('');
  const [mysteryMode, setMysteryMode] = useState('');
  const [transportMethod, setTransportMethod] = useState('');
  const [quote, setQuote] = useState<CompositionQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const addInFlight = useRef(false);
  const quoteSeq = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ bundle: BundleDetailPayload }>(`/api/bundles/${encodeURIComponent(slug)}`);
      setBundle(res.bundle);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);
  useFreshOnReturn(load, { enabled: !loading, minIntervalMs: 8_000 });

  /**
   * §12's ONE counter — a detail-page view, the only one of the three facts
   * nothing else records. Fired ONCE per mounted offer, after the payload has
   * arrived (so the id is the server's, not the slug in the URL), and
   * deliberately not awaited: it is the denominator of a conversion figure and
   * nothing else, never an input to a price, a limit or an eligibility
   * decision, and a page must not wait on a statistic. The server refuses it
   * for a signed-out visitor and rate-limits it.
   */
  const viewedRef = useRef('');
  useEffect(() => {
    const id = bundle?.id;
    if (!id || viewedRef.current === id) return;
    viewedRef.current = id;
    void api.post(`/api/bundles/${encodeURIComponent(id)}/view`).catch(() => undefined);
  }, [bundle?.id]);

  /**
   * THE DEFAULT SELECTION IS THE SERVER'S, NOT A GUESS.
   *
   * A pinned component has nothing to choose and is not in this map at all; an
   * editable one starts on the first ALLOWED choice the server listed, and an
   * optional one starts included, because that is what the payload's
   * `included` already says. Re-seeded whenever the payload changes so a
   * component the admin removed cannot survive as a stale local id.
   */
  useEffect(() => {
    const comps = bundle?.composition?.components ?? [];
    const seeded: Record<string, { optionValueIds: string[]; colorId: string; included: boolean }> = {};
    for (const c of comps) {
      if (!c.editable.option && !c.editable.color && !c.optional) continue;
      const firstOption = c.choices.find((ch) => ch.dim === 'option_value');
      const firstColor = c.choices.find((ch) => ch.dim === 'color');
      seeded[c.component_id] = {
        optionValueIds: c.editable.option && firstOption ? [firstOption.id] : [],
        colorId: c.editable.color && firstColor ? firstColor.id : '',
        included: c.included,
      };
    }
    setChoices(seeded);
    setQty(1);
    const m = bundle?.mystery;
    setFamilyId(m?.family_id ?? '');
    setMysteryMode(m && m.modes.length === 1 ? m.modes[0] : (m?.modes[0] ?? ''));
    const firstTransport = bundle?.pricing_modes?.preorder?.find((t) => t.prepaid !== null)?.method ?? '';
    setTransportMethod(bundle?.availability?.mode === 'preorder' ? firstTransport : '');
  }, [bundle]);

  const isMystery = (bundle?.composition?.kind ?? '') === 'mystery';
  /** Only choices the admin actually left open are ever sent (§5.2): a
   *  submitted choice on a pinned component is refused
   *  (`BUNDLE_CHOICE_NOT_ALLOWED`), not ignored. */
  const bundleChoicesBody = useCallback(() => {
    const comps = bundle?.composition?.components ?? [];
    return comps
      .filter((c) => c.editable.option || c.editable.color || c.optional)
      .map((c) => {
        const sel = choices[c.component_id] ?? { optionValueIds: [], colorId: '', included: c.included };
        return {
          componentId: c.component_id,
          ...(c.editable.option ? { optionValueIds: sel.optionValueIds } : {}),
          ...(c.editable.color ? { colorId: sel.colorId } : {}),
          included: sel.included,
        };
      });
  }, [bundle, choices]);

  /**
   * THE DEBOUNCED QUOTE (§13.2). 220 ms after the selection settles, the server
   * re-prices THIS selection through the same functions the cart and the door
   * will use, so the button can never quote a number the door will not charge.
   * Sequence-guarded: a slow answer for an older selection is dropped rather
   * than overwriting a newer one.
   */
  const selectionKey = JSON.stringify({
    q: qty,
    c: bundleChoicesBody(),
    f: familyId,
    m: mysteryMode,
    t: transportMethod,
  });
  useEffect(() => {
    if (!bundle || bundle.locked) {
      setQuote(null);
      return;
    }
    const seq = ++quoteSeq.current;
    const timer = setTimeout(() => {
      setQuoting(true);
      api
        .post<{ quote: CompositionQuote | null }>(`/api/products/${encodeURIComponent(slug)}/quote`, {
          qty,
          ...(isMystery ? {} : { bundleChoices: bundleChoicesBody() }),
          ...(isMystery && familyId ? { mysteryFamilyId: familyId } : {}),
          ...(isMystery && mysteryMode ? { mysteryMode } : {}),
          ...(transportMethod ? { transportMethod } : {}),
        })
        .then((res) => {
          if (seq !== quoteSeq.current) return;
          setQuote(res.quote);
          setActionError('');
        })
        .catch((err) => {
          if (seq !== quoteSeq.current) return;
          setQuote(null);
          // The CODE is what the customer reads, in their own language.
          setActionError(refusalText(err instanceof ApiError ? err.code : '', lang, ''));
        })
        .finally(() => {
          if (seq === quoteSeq.current) setQuoting(false);
        });
    }, 220);
    return () => clearTimeout(timer);
    // `selectionKey` is the whole selection, serialized, so this re-runs when
    // any part of it changes and never on an unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, slug, bundle?.id, bundle?.locked, isMystery, lang]);

  /**
   * THE ADD. The body is exactly §5.2's: the bundle product id, a quantity, the
   * choices the admin left open, and — for a mystery offer — the family and the
   * mode. Nothing else. A refusal is decoded from its CODE.
   */
  const addToCart = useCallback(async () => {
    if (!bundle || addInFlight.current) return;
    if (!isAuthenticated) {
      navigate(`/auth?next=${encodeURIComponent(`/bundles/${slug}`)}`);
      return;
    }
    addInFlight.current = true;
    setAdding(true);
    setActionError('');
    setNotice('');
    try {
      const body: Record<string, unknown> = { productId: bundle.id, qty };
      if (!isMystery) body.bundleChoices = bundleChoicesBody();
      if (isMystery && familyId) body.mysteryFamilyId = familyId;
      if (isMystery && mysteryMode) body.mysteryMode = mysteryMode;
      if (transportMethod) body.transportMethod = transportMethod;
      const data = await api.post<{ items: CartItem[] }>('/api/cart/items', body);
      const count = data.items.reduce((n, it) => n + it.qty, 0);
      setNotice(`${s.added} (${count})`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate(`/auth?next=${encodeURIComponent(`/bundles/${slug}`)}`);
        return;
      }
      const code = err instanceof ApiError ? err.code ?? '' : '';
      const fallback = err instanceof Error ? err.message : s.addFailed;
      setActionError(refusalText(code, lang, fallback || s.addFailed));
      // A refusal that changed what is sellable is worth re-reading: the
      // server's availability, not a local guess, decides what happens next.
      if (code === 'BUNDLE_COMPOSITION_CHANGED' || code === 'OFFER_INACTIVE') void load();
    } finally {
      addInFlight.current = false;
      setAdding(false);
    }
  }, [bundle, qty, isMystery, familyId, mysteryMode, transportMethod, bundleChoicesBody, isAuthenticated, navigate, slug, lang, s.added, s.addFailed, load]);

  const header = (
    <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-3 flex items-center gap-3">
      <button
        onClick={() => navigate(-1)}
        aria-label={s.back}
        className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors"
      >
        {dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
      </button>
      <h1 dir="ltr" className="text-white font-bold text-[15px] truncate text-start">
        {bundle?.name ?? ''}
      </h1>
    </div>
  );

  if (loading && !bundle) {
    return (
      <div className="w-full pb-24 text-zinc-300 min-h-screen">
        {header}
        <BundleDetailSkeleton />
      </div>
    );
  }

  // A 404 is a not-found state and a 401 a sign-in prompt — never an error
  // toast and never "no bundles" (tests/asyncStates.test.ts).
  if (error != null || !bundle) {
    return (
      <div className="w-full pb-24 text-zinc-300 min-h-screen">
        {header}
        <div className="p-4">
          <ErrorState error={error} onRetry={load} next={`/bundles/${slug}`} />
        </div>
      </div>
    );
  }

  const comp = bundle.composition;
  const gated = bundle.offer.required_tiers.length > 0;
  const mystery = bundle.mystery;
  // THE SERVER'S CAP, never a local one. `max_qty` is already the smallest of
  // the scarcest component, the offer's `max_qty_per_order` and the ceiling
  // (§2.4), so the stepper disables exactly where the door refuses (§10).
  const maxQty = Math.max(0, bundle.availability?.stock.max_qty ?? comp?.max_qty ?? 0);
  const canBuy = !bundle.locked && bundle.availability?.mode !== 'unavailable' && maxQty > 0;
  const familyList: Array<{ id: string; label: string }> = Array.isArray(mystery?.families)
    ? (mystery!.families as Array<{ id: string; label: string } | string>).map((f) =>
        typeof f === 'string' ? { id: f, label: f } : f
      )
    : [];
  const setChoice = (
    componentId: string,
    patch: Partial<{ optionValueIds: string[]; colorId: string; included: boolean }>
  ) =>
    setChoices((prev) => ({
      ...prev,
      [componentId]: { optionValueIds: [], colorId: '', included: true, ...(prev[componentId] ?? {}), ...patch },
    }));
  const selectClass =
    'min-h-11 w-full rounded-lg bg-zinc-950 border border-zinc-700 px-3 text-[13px] text-white focus:outline-none focus:border-gold';

  return (
    <div className="w-full pb-28 text-zinc-300 min-h-screen">
      {header}

      <div className="relative bg-black">
        <SafeImage src={bundle.image} alt={bundle.name} aspect="auto" className="w-full h-64 sm:h-80 object-cover" />
        {bundle.locked && (
          <span className="absolute inset-0 bg-black/60 grid place-items-center">
            <Lock aria-hidden className="w-8 h-8 text-gold" />
          </span>
        )}
        <span className="absolute bottom-3 start-4 flex items-center gap-2">
          <StateChip state={bundle.availability_state} />
          {gated && (
            <span className="inline-flex items-center rounded-md border border-gold/30 bg-gold/15 px-2 py-0.5 text-[10px] font-bold text-gold">
              {bundle.offer.required_tiers.map(tierLabel).join(' / ')}
            </span>
          )}
        </span>
      </div>

      <div className="p-4 space-y-5">
        <div>
          <h2 dir="ltr" className="text-white font-bold text-[19px] leading-snug text-start">
            {bundle.name}
          </h2>
          {bundle.availability_state === 'upcoming' && (
            <Countdown target={bundle.offer.starts_at} kind="opens" onZero={load} className="mt-1 block" />
          )}
          {bundle.offer.ends_at && bundle.availability_state !== 'upcoming' && (
            <Countdown target={bundle.offer.ends_at} kind="ends" onZero={load} className="mt-1 block" />
          )}
        </div>

        {/* ---- the price block ------------------------------------------- */}
        {bundle.locked ? (
          <div className="bg-zinc-900/50 border border-gold/25 rounded-2xl p-5 text-center">
            <span className="mx-auto mb-3 w-11 h-11 rounded-2xl bg-gold/10 border border-gold/30 grid place-items-center">
              <Sparkles className="w-5 h-5 text-gold" />
            </span>
            <h3 className="text-white font-bold text-[15px] mb-1">{s.locked}</h3>
            <p className="text-[13px] text-zinc-400 mb-4">{s.lockedBody}</p>
            {typeof bundle.display_regular_iqd === 'number' && (
              <p className="text-zinc-300 font-bold tabular-nums mb-4">{formatIqd(bundle.display_regular_iqd)}</p>
            )}
            <Link
              to={bundle.viewer_tier?.tier ? '/subscription' : '/auth?next=/bundles'}
              className="inline-flex items-center justify-center min-h-11 px-5 rounded-xl bg-gold text-black text-sm font-black hover:brightness-110 transition-all"
            >
              {bundle.viewer_tier?.tier && bundle.viewer_tier.tier !== 'free' ? s.lockedCta : s.signIn}
            </Link>
          </div>
        ) : (
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-2xl p-4 space-y-2">
            <CardPrice p={bundle as ApiProduct} />
            {comp && (
              <>
                <BundleSavingLine componentTotalIqd={comp.component_total_iqd} savingPercent={comp.saving_percent} />
                <p className="text-[11px] text-zinc-500">
                  {s.total}: <span className="tabular-nums">{formatIqd(comp.component_total_iqd)}</span>
                </p>
              </>
            )}
          </div>
        )}

        {bundle.description && (
          <p dir="ltr" className="text-[13px] text-zinc-400 leading-relaxed text-start whitespace-pre-line">
            {bundle.description}
          </p>
        )}

        {/* ---- what is inside -------------------------------------------- */}
        {comp && comp.components.length > 0 && (
          <section>
            <h3 className="text-white font-bold text-[15px] mb-3">{s.inside}</h3>
            <div className="space-y-2">
              {comp.components.map((c) => (
                <div
                  key={c.component_id}
                  className="flex items-start gap-3 bg-zinc-900/40 border border-zinc-800/50 rounded-xl p-3"
                >
                  <Link
                    to={`/product/${c.slug || c.product_id}`}
                    className="relative w-12 h-12 rounded-lg overflow-hidden bg-zinc-950 border border-zinc-800 shrink-0"
                  >
                    {c.image ? (
                      <SafeImage src={c.image} alt={c.name} aspect="auto" className="w-full h-full" />
                    ) : (
                      <Package aria-hidden className="w-4 h-4 text-zinc-700 m-auto" />
                    )}
                    {c.qty_per_bundle > 1 && (
                      <span className="absolute bottom-0 end-0 bg-zinc-950/90 text-zinc-200 text-[9px] font-bold px-1 rounded-tl rtl:rounded-tl-none rtl:rounded-tr">
                        ×{c.qty_per_bundle}
                      </span>
                    )}
                  </Link>
                  <div className="min-w-0 flex-1">
                    {/* §13.3: product, option and colour names stay English in
                        every language and are never translated. */}
                    <p dir="ltr" className="text-white font-medium text-[13px] leading-snug text-start">
                      {c.name}
                    </p>
                    {c.variant_label && (
                      <p dir="ltr" className="text-[11px] text-zinc-500 text-start">
                        {c.variant_label}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                      <StateChip state={c.state} />
                      {c.optional && (
                        <span className="inline-flex items-center rounded-md border border-zinc-700 bg-zinc-800/50 px-2 py-0.5 text-[10px] font-bold text-zinc-300">
                          {s.optional}
                        </span>
                      )}
                      {(c.editable.option || c.editable.color) && (
                        <span className="inline-flex items-center rounded-md border border-sky-500/30 bg-sky-500/15 px-2 py-0.5 text-[10px] font-bold text-sky-300">
                          {s.editable}
                        </span>
                      )}
                    </div>
                    {/* THE PICKER, where the admin left the choice open (§13.2).
                        A pinned component shows its allowed values as prose and
                        offers no control: sending a choice for one is refused
                        with `BUNDLE_CHOICE_NOT_ALLOWED`, not ignored. */}
                    {canBuy && (c.editable.option || c.editable.color) ? (
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {c.editable.option && (
                          <label className="block">
                            <span className="sr-only">{`${s.chooseOption} — ${c.name}`}</span>
                            <select
                              dir="ltr"
                              aria-label={`${s.chooseOption} — ${c.name}`}
                              className={selectClass}
                              value={choices[c.component_id]?.optionValueIds[0] ?? ''}
                              onChange={(e) => setChoice(c.component_id, { optionValueIds: e.target.value ? [e.target.value] : [] })}
                            >
                              {c.choices
                                .filter((ch) => ch.dim === 'option_value')
                                .map((ch) => (
                                  <option key={ch.id} value={ch.id}>
                                    {ch.name}
                                  </option>
                                ))}
                            </select>
                          </label>
                        )}
                        {c.editable.color && (
                          <label className="block">
                            <span className="sr-only">{`${s.chooseColor} — ${c.name}`}</span>
                            <select
                              dir="ltr"
                              aria-label={`${s.chooseColor} — ${c.name}`}
                              className={selectClass}
                              value={choices[c.component_id]?.colorId ?? ''}
                              onChange={(e) => setChoice(c.component_id, { colorId: e.target.value })}
                            >
                              {c.choices
                                .filter((ch) => ch.dim === 'color')
                                .map((ch) => (
                                  <option key={ch.id} value={ch.id}>
                                    {ch.name}
                                  </option>
                                ))}
                            </select>
                          </label>
                        )}
                      </div>
                    ) : (
                      c.choices.length > 0 && (
                        <p dir="ltr" className="text-[11px] text-zinc-500 mt-1.5 text-start">
                          {s.choices}: {c.choices.map((ch) => ch.name).join(' · ')}
                        </p>
                      )
                    )}
                    {/* An OPTIONAL component the buyer may decline. Declining
                        never lowers `max_bundles` and never reaches the order
                        snapshot; opting in and being unable to satisfy it is
                        refused by name (`BUNDLE_OPTIONAL_UNAVAILABLE`), never
                        silently dropped (§2.2). */}
                    {canBuy && c.optional && (
                      <label className="mt-2 inline-flex items-center gap-2 text-[12px] text-zinc-300">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-gold"
                          checked={choices[c.component_id]?.included ?? c.included}
                          onChange={(e) => setChoice(c.component_id, { included: e.target.checked })}
                        />
                        {s.optionalKeep}
                      </label>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ---- the mystery selectors ------------------------------------- */}
        {!bundle.locked && mystery && (
          <section className="bg-zinc-900/40 border border-zinc-800/50 rounded-xl p-4 space-y-3">
            <p className="text-[13px] text-zinc-300">
              {s.spools}: <span className="tabular-nums font-bold text-white">{mystery.spool_qty}</span>
            </p>
            <p className="text-[12px] text-zinc-500">
              {s.revealAt}: <span className="text-zinc-300">{mystery.reveal_stage}</span>
            </p>
            {/* The odds are AGGREGATED BY FAMILY and appear only when the admin
                switched disclosure on — they name no product, no colour and no
                pool entry (§7.3). */}
            {mystery.odds && mystery.odds.length > 0 && (
              <p dir="ltr" className="text-[12px] text-zinc-400 text-start">
                {s.odds}: {mystery.odds.map((o) => `${o.family_id || '—'} ${o.percent}%`).join(' · ')}
              </p>
            )}
            {mystery.customer_picks_family && familyList.length > 0 && (
              <label className="block">
                <span className="block text-[12px] text-zinc-400 mb-1">{s.family}</span>
                <select
                  className={selectClass}
                  aria-label={s.family}
                  value={familyId}
                  onChange={(e) => setFamilyId(e.target.value)}
                >
                  <option value="">{s.familyAny}</option>
                  {familyList.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label || f.id}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {mystery.modes.length > 1 && (
              <label className="block">
                <span className="block text-[12px] text-zinc-400 mb-1">{s.mode}</span>
                <select
                  className={selectClass}
                  aria-label={s.mode}
                  value={mysteryMode}
                  onChange={(e) => setMysteryMode(e.target.value)}
                >
                  {mystery.modes.map((m) => (
                    <option key={m} value={m}>
                      {m === 'preorder' ? s.modePreorder : s.modeDirect}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </section>
        )}

        {/* ---- the pre-order transport, one method EVERY component offers -- */}
        {!bundle.locked && bundle.availability?.mode === 'preorder' && (bundle.pricing_modes?.preorder?.length ?? 0) > 0 && (
          <label className="block">
            <span className="block text-[12px] text-zinc-400 mb-1">{s.transport}</span>
            <select
              className={selectClass}
              aria-label={s.transport}
              value={transportMethod}
              onChange={(e) => setTransportMethod(e.target.value)}
            >
              {bundle.pricing_modes!.preorder
                .filter((t) => t.prepaid !== null)
                .map((t) => (
                  <option key={t.method} value={t.method}>
                    {t.method}
                  </option>
                ))}
            </select>
          </label>
        )}

        {/* ---- the purchase bar ------------------------------------------ */}
        {!bundle.locked && (
          <section className="space-y-3">
            {canBuy ? (
              <>
                <div className="flex items-center gap-3">
                  <span className="text-[12px] text-zinc-400">{s.qty}</span>
                  <div className="inline-flex items-center rounded-xl border border-zinc-700 overflow-hidden">
                    <button
                      type="button"
                      aria-label="-"
                      disabled={qty <= 1}
                      onClick={() => setQty((q) => Math.max(1, q - 1))}
                      className="min-w-11 min-h-11 text-white disabled:opacity-40"
                    >
                      −
                    </button>
                    <span className="min-w-11 text-center tabular-nums text-white font-bold">{qty}</span>
                    <button
                      type="button"
                      aria-label="+"
                      // §10: the composition availability exposes `max_qty`, so
                      // the stepper disables AT the limit rather than the door
                      // refusing a tap that looked available.
                      disabled={qty >= maxQty}
                      aria-disabled={qty >= maxQty}
                      onClick={() => setQty((q) => Math.min(maxQty, q + 1))}
                      className="min-w-11 min-h-11 text-white disabled:opacity-40"
                    >
                      +
                    </button>
                  </div>
                  {qty >= maxQty && (
                    <span className="text-[11px] text-zinc-500">
                      {s.maxReached}: <span className="tabular-nums">{maxQty}</span>
                    </span>
                  )}
                </div>

                {quote && (
                  <p className="text-[13px] text-zinc-300">
                    <span className="tabular-nums font-bold text-white">{formatIqd(quote.line_total_iqd)}</span>
                  </p>
                )}

                {/* A refusal is a NOTE in the house tints, decoded from its
                    code — never a hand-rolled red paragraph, which is what
                    `tests/asyncStates.test.ts` forbids on this page. */}
                {actionError && (
                  <Note tone="amber" compact>
                    {actionError}
                  </Note>
                )}
                {notice && (
                  <Note tone="gold" compact>
                    {notice}
                  </Note>
                )}

                <button
                  type="button"
                  onClick={addToCart}
                  disabled={adding || quoting}
                  className="w-full min-h-12 rounded-xl bg-gold text-black text-sm font-black hover:brightness-110 transition-all disabled:opacity-60"
                >
                  {adding ? s.adding : isAuthenticated ? s.add : s.signInToBuy}
                </button>
              </>
            ) : (
              <p className="text-center text-[12px] text-zinc-500 border border-zinc-800/60 rounded-xl py-3">
                {s.notYet}
              </p>
            )}
          </section>
        )}

        <p className="text-center">
          <Link to="/bundles" className="text-[13px] text-zinc-400 hover:text-white transition-colors">
            {loc('كل الباقات', 'All bundles', 'هەموو پاکێجەکان')}
          </Link>
        </p>
      </div>
    </div>
  );
}
