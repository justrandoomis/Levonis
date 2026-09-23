/**
 * /subscription — «اختر بطاقتك».
 *
 * Open to guests: what a card costs, and what it gives, is the first thing
 * someone weighing one wants to see. The page reads GET /api/memberships/plans
 * (public: the plans, the benefit rules the checkout applies, the entitlement
 * contract) and, when signed in, GET /api/memberships/mine and
 * GET /api/memberships/quote for the selected plan — the server saying
 * exactly what buying it would do for THIS account. Nothing shown as a number
 * is computed in the browser.
 *
 * THE ORDER IS THE DECISION'S ORDER (mobile first, top to bottom):
 *   1. who you are here — your card and its date, or the title for a guest;
 *   2. the three cards, each with its price and what it is for, chosen in
 *      place; the default is the tier above yours, or the first one on sale;
 *   3. the duration, only where there is a choice (PLUS);
 *   4. «مقارنة الخطط», a real matrix, right after the choice it informs;
 *   5. «عضويتك» — the ledger, identity, BNPL and the store — at the end.
 * The checkout is a bar above the navigation on a phone and a sticky aside
 * from 1024px; the selected tier and plan live in the URL (?tier=&plan=) so
 * a sign-in round trip or a back navigation lands on the same choice.
 *
 * THE SITE IS LIVE. A purchase starts the membership at once — there is no
 * reservation copy anywhere on this page. A legacy reservation still waiting
 * for a human is shown as «قيد التفعيل», never as "until the launch".
 *
 * Buying goes through a confirmation window (PurchaseConfirm). ONE
 * idempotency key is generated per confirmed attempt and reused only for a
 * retry of that same attempt, so a flaky network can never charge twice; a
 * new attempt gets a new key. The confirmation carries the very figures the
 * window displayed; when the server's recomputed charge differs it refuses
 * with 409 QUOTE_CHANGED and the fresh quote, which the window shows with a
 * one-line notice instead of charging. The result stays until closed, and
 * while the charge is in flight the app-wide busy screen holds every other
 * control (src/lib/busy.ts).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { useWallet } from '../WalletContext';
import { useAuth } from '../AuthContext';
import { useMoney } from '../CurrencyContext';
import { useMotion } from '../lib/motion';
import { useBusy } from '../lib/busy';
import { api, ApiError, newIdempotencyKey } from '../lib/api';
import StoreCta from '../components/merchant/StoreCta';
import KycSection from '../components/kyc/KycSection';
import { MemberHeader } from '../components/subscription/MemberHeader';
import { TierCards, type TierStanding } from '../components/subscription/TierCards';
import { PlanPicker } from '../components/subscription/PlanPicker';
import { CheckoutBar } from '../components/subscription/CheckoutBar';
import { PurchaseConfirm } from '../components/subscription/PurchaseConfirm';
import { CompareMatrix } from '../components/subscription/CompareMatrix';
import { MembershipLedger } from '../components/subscription/MembershipLedger';
import { BnplPanel } from '../components/subscription/BnplPanel';
import { tierHighlights } from '../components/subscription/compareModel';
import { isolatedMoney, type PlanBenefits } from '../components/subscription/benefitLines';
import { TIER_ORDER, isPaidTier, pickDefaultTier, type AnyTier, type PaidTier } from '../components/subscription/tierMeta';
import type {
  ApiPlan,
  ConfirmedFigures,
  MineResponse,
  PlanFeatures,
  PlansResponse,
  PurchaseQuote,
  PurchaseResult,
  SubscribeResponse,
} from '../components/subscription/types';

/** The tier and plan the URL carries, when they are real ones. */
function readSelection(search: string): { tier: PaidTier | null; plan: string | null } {
  const q = new URLSearchParams(search);
  const tier = q.get('tier');
  const plan = q.get('plan');
  return { tier: isPaidTier(tier) ? tier : null, plan: plan && /^[a-z0-9_]{1,60}$/i.test(plan) ? plan : null };
}

export default function Subscription() {
  const { t, loc, dir } = useLanguage();
  const { money } = useMoney();
  const m = useMotion();
  const { refreshWallet } = useWallet();
  const { user, refreshUser } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // ------------------------------------------------------------ catalogue
  const [plans, setPlans] = useState<ApiPlan[] | null>(null);
  const [plansError, setPlansError] = useState<unknown>(null);
  const [features, setFeatures] = useState<PlanFeatures | null>(null);
  const [contract, setContract] = useState<PlansResponse['entitlement_contract'] | null>(null);
  const [points, setPoints] = useState<PlansResponse['points_multiplier_x100'] | null>(null);
  /**
   * §22 — what the store promises PREMIUM and PRO shoppers RIGHT NOW, read
   * from `membership_benefit_rules` by the same server that applies them at
   * the checkout. An older deployment sends no `benefits` at all, and the page
   * then states nothing rather than a figure nobody enforces.
   */
  const [benefits, setBenefits] = useState<PlanBenefits | null>(null);
  const [plansNonce, setPlansNonce] = useState(0);
  const reloadPlans = useCallback(() => setPlansNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setPlansError(null);
    api
      .get<PlansResponse & { benefits?: PlanBenefits }>('/api/memberships/plans')
      .then((data) => {
        if (cancelled) return;
        setPlans(data.plans || []);
        setFeatures(data.features ?? null);
        setBenefits(data.benefits ?? null);
        setContract(data.entitlement_contract ?? null);
        setPoints(data.points_multiplier_x100 ?? null);
      })
      .catch((e: unknown) => {
        // A failed fetch is an error, not an empty catalogue.
        if (!cancelled) setPlansError(e ?? new Error('plans'));
      });
    return () => {
      cancelled = true;
    };
  }, [plansNonce]);

  // ------------------------------------------------------------- account
  const [mine, setMine] = useState<MineResponse | null>(null);
  const loadMine = useCallback(() => {
    if (!user) {
      setMine(null);
      return;
    }
    api
      .get<MineResponse>('/api/memberships/mine')
      .then((data) => setMine(data))
      .catch(() => setMine(null));
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadMine();
  }, [loadMine]);

  // Current tier: the memberships ledger is authoritative once loaded; the
  // session's legacy cache only bridges the load.
  const now = Date.now();
  const legacyActive =
    !!user && user.membership_tier !== 'free' && (user.subscription_expiry === 0 || user.subscription_expiry > now);
  const currentTier: AnyTier = mine
    ? mine.status.active
      ? mine.status.tier
      : 'free'
    : legacyActive
      ? user!.membership_tier
      : 'free';
  const currentExpiry = mine
    ? mine.status.expires_at
    : legacyActive && user?.subscription_expiry
      ? new Date(user.subscription_expiry).toISOString()
      : null;
  const pending = mine?.status.pending_launch ?? null;
  const gatedBenefits = mine?.status.gated_benefits ?? [];

  // ----------------------------------------------------------- selection
  /** Tier order follows the server's own `sort` column, so the owner reorders
   *  the cards from the memberships admin without a code change. */
  const tiers = useMemo<PaidTier[]>(() => {
    const firstSort = new Map<PaidTier, number>();
    for (const p of plans || []) {
      if (!isPaidTier(p.tier)) continue;
      const cur = firstSort.get(p.tier);
      if (cur === undefined || p.sort < cur) firstSort.set(p.tier, p.sort);
    }
    return (['plus', 'prime', 'pro'] as const)
      .filter((x) => firstSort.has(x))
      .sort((a, b) => (firstSort.get(a) ?? 0) - (firstSort.get(b) ?? 0));
  }, [plans]);

  const plansOf = useCallback(
    (tier: PaidTier) =>
      (plans || []).filter((p) => p.tier === tier).sort((a, b) => a.duration_months - b.duration_months || a.sort - b.sort),
    [plans]
  );

  /** Where the account stands against each tier — the badge on each card. */
  const standing = useMemo(() => {
    const out = {} as Record<PaidTier, TierStanding>;
    for (const tier of ['plus', 'prime', 'pro'] as const) {
      const sellable = plansOf(tier).some((p) => p.purchasable);
      out[tier] =
        currentTier === tier
          ? 'current'
          : TIER_ORDER[tier] < TIER_ORDER[currentTier]
            ? 'included'
            : !sellable
              ? 'tba'
              : isPaidTier(currentTier)
                ? 'upgrade'
                : 'open';
    }
    return out;
  }, [currentTier, plansOf]);

  // NOT ALWAYS PRO — see pickDefaultTier.
  const defaultTier = useMemo(
    () => pickDefaultTier(tiers, currentTier, (tier) => plansOf(tier).some((p) => p.purchasable)),
    [tiers, currentTier, plansOf]
  );

  const initial = useRef(readSelection(location.search));
  const [chosenTier, setChosenTier] = useState<PaidTier | null>(initial.current.tier);
  const [chosenPlan, setChosenPlan] = useState<string | null>(initial.current.plan);
  const activeTier: PaidTier = (chosenTier && tiers.includes(chosenTier) ? chosenTier : defaultTier) ?? 'plus';
  const tierPlans = useMemo(() => plansOf(activeTier), [plansOf, activeTier]);
  // A plan the URL or a tap chose, when it belongs to this tier; otherwise the
  // longest, which is the one every tier sells.
  const selectedPlan =
    tierPlans.find((p) => p.id === chosenPlan) ?? (tierPlans.length ? tierPlans[tierPlans.length - 1] : null);

  /**
   * THE CHOICE LIVES IN THE URL. Written with `replaceState` rather than the
   * router: a router REPLACE is a new page to the shell's scroll restoration
   * (App.tsx) and would throw the reader to the top on every tap. The router's
   * own entry state is kept, so back and forward still work; the sign-in link
   * below reads the same parameters.
   */
  const selectionSearch = selectedPlan ? `?tier=${activeTier}&plan=${encodeURIComponent(selectedPlan.id)}` : '';
  useEffect(() => {
    if (!selectedPlan || typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('tier') === activeTier && url.searchParams.get('plan') === selectedPlan.id) return;
    url.searchParams.set('tier', activeTier);
    url.searchParams.set('plan', selectedPlan.id);
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }, [activeTier, selectedPlan]);

  const highlights = useMemo(() => {
    const out = {} as Record<PaidTier, string[]>;
    for (const tier of ['plus', 'prime', 'pro'] as const) {
      out[tier] = tierHighlights(tier, { contract: contract?.tiers ?? null, benefits, points: points ?? null, loc, money: isolatedMoney(money, dir) });
    }
    return out;
  }, [contract, benefits, points, loc, money, dir]);

  // --------------------------------------------------------------- quote
  const [quote, setQuote] = useState<PurchaseQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<unknown>(null);
  const [quoteNonce, setQuoteNonce] = useState(0);
  const refreshQuote = useCallback(() => setQuoteNonce((n) => n + 1), []);

  const quotePlanId = user && selectedPlan && selectedPlan.purchasable ? selectedPlan.id : '';
  const quotedPlan = useRef('');
  useEffect(() => {
    if (!quotePlanId) {
      quotedPlan.current = '';
      setQuote(null);
      setQuoteError(null);
      setQuoteLoading(false);
      return;
    }
    // A NEW PLAN CLEARS THE OLD ANSWER. The previous plan's figures — or its
    // refusal — must not sit under this plan's price while its quote loads.
    // A refresh of the SAME plan keeps them: the QUOTE_CHANGED flow shows the
    // fresh figures the refusal carried while the re-check runs.
    if (quotedPlan.current !== quotePlanId) {
      quotedPlan.current = quotePlanId;
      setQuote(null);
    }
    let cancelled = false;
    setQuoteLoading(true);
    setQuoteError(null);
    api
      .get<{ quote: PurchaseQuote }>(`/api/memberships/quote?planId=${encodeURIComponent(quotePlanId)}`)
      .then((d) => {
        if (cancelled) return;
        setQuote(d.quote);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setQuote(null);
        setQuoteError(e ?? new Error('quote'));
      })
      .finally(() => {
        if (!cancelled) setQuoteLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [quotePlanId, quoteNonce]);

  // ------------------------------------------------------------ purchase
  const ctaRef = useRef<HTMLButtonElement | null>(null);
  const attemptKey = useRef<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [phase, setPhase] = useState<'review' | 'busy' | 'done'>('review');
  const [result, setResult] = useState<PurchaseResult | null>(null);
  const [quoteChanged, setQuoteChanged] = useState(false);
  // The charge is in flight: the app-wide busy screen holds every other
  // control, so nothing on the page can be tapped twice behind it.
  useBusy(phase === 'busy', 'subscribe');

  const openConfirm = () => {
    if (!selectedPlan) return;
    // A guest may read the whole page; subscribing is where an account starts
    // to matter. Take them to sign in and BRING THEM BACK to this choice.
    if (!user) {
      navigate('/auth', { state: { from: `${location.pathname}${selectionSearch}` } });
      return;
    }
    if (!selectedPlan.purchasable) return; // honest disabled state — never a fake purchase
    attemptKey.current = null; // a new attempt gets a new key when confirmed
    setResult(null);
    setQuoteChanged(false);
    setPhase('review');
    setConfirmOpen(true);
    refreshQuote(); // the balance may have changed since the summary loaded
  };

  const runPurchase = async () => {
    if (!selectedPlan || !user || phase === 'busy') return;
    if (!attemptKey.current) attemptKey.current = newIdempotencyKey();
    // The figures on the screen travel with the confirmation: the server
    // charges exactly these or refuses — never a number nobody saw.
    const shown: ConfirmedFigures | null =
      quote && quote.ok ? { charge_iqd: quote.charge_iqd, charge_usd_cents: quote.charge_usd_cents } : null;
    setPhase('busy');
    setResult(null);
    setQuoteChanged(false);
    let res: SubscribeResponse;
    try {
      // The server validates the plan, applies any upgrade credit and charges
      // the wallet — the page only reports the REAL result.
      res = await api.post<SubscribeResponse>('/api/memberships/subscribe', {
        planId: selectedPlan.id,
        idempotencyKey: attemptKey.current,
        ...(shown ?? {}),
      });
    } catch (err: unknown) {
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === 'QUOTE_CHANGED') {
        // Nothing was charged. The refusal carries the fresh quote: show it,
        // say why, and let the person confirm the new figures — same attempt,
        // same key.
        const fresh = err instanceof ApiError ? (err.details?.quote as PurchaseQuote | undefined) : undefined;
        if (fresh && fresh.ok === true) setQuote(fresh);
        setQuoteChanged(true);
        setPhase('review');
        refreshQuote();
        return;
      }
      const message = err instanceof Error && err.message ? err.message : t('purchaseFailed');
      setResult({ kind: 'err', code, message });
      setPhase('done');
      if (code === 'INSUFFICIENT_BALANCE') refreshQuote();
      return;
    }
    setResult({ kind: 'ok', res });
    setPhase('done');
    // The purchase stands whatever happens to these refreshes.
    try {
      await Promise.all([refreshUser(), refreshWallet()]);
    } catch {
      /* the caches catch up on the next load */
    }
    loadMine();
    refreshQuote();
  };

  const closeConfirm = () => {
    if (phase === 'busy') return;
    setConfirmOpen(false);
  };

  // ------------------------------------------------------------- render
  const compareRef = useRef<HTMLHeadingElement | null>(null);
  const membershipRef = useRef<HTMLHeadingElement | null>(null);
  const goTo = (ref: React.RefObject<HTMLHeadingElement | null>) => {
    const el = ref.current;
    if (!el) return;
    el.scrollIntoView({ behavior: m.reduced ? 'auto' : 'smooth', block: 'start' });
    el.focus({ preventScroll: true });
  };

  const plansReady = plans !== null && !plansError && tiers.length > 0;

  return (
    <div className="w-full flex-1 bg-canvas text-text-secondary">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 pb-44 lg:pb-16">
        {/* 1. Who you are here */}
        <MemberHeader
          user={user}
          tier={currentTier}
          expiresAt={currentExpiry}
          pending={pending}
          onManage={() => goTo(membershipRef)}
        />

        {/* 2. The cards */}
        <section aria-labelledby="choose-card-title" className="mt-6 sm:mt-8">
          <TierCards
            plans={plans}
            error={plansError}
            onRetry={reloadPlans}
            tiers={tiers}
            selected={activeTier}
            onSelect={(tier) => {
              setChosenTier(tier);
              setChosenPlan(null);
            }}
            standing={standing}
            highlights={highlights}
            onCompare={() => goTo(compareRef)}
          />
        </section>

        {plansReady && (
          <div className="mt-6 lg:mt-8 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-8">
            <div className="min-w-0 space-y-8">
              {/* 3. The duration, where there is a choice */}
              <PlanPicker
                tier={activeTier}
                tierPlans={tierPlans}
                selectedPlanId={selectedPlan?.id ?? ''}
                onSelectPlan={(id) => {
                  setChosenTier(activeTier);
                  setChosenPlan(id);
                }}
              />

              {/* 4. The comparison */}
              <CompareMatrix
                tiers={tiers}
                plans={plans}
                contract={contract?.tiers ?? null}
                benefits={benefits}
                features={features}
                points={points ?? null}
                currentTier={currentTier}
                selectedTier={activeTier}
                loading={false}
                headingRef={compareRef}
              />

              {/* 5. Your membership — signed in only */}
              {user && (
                <section aria-labelledby="membership-title" className="space-y-4">
                  <h2
                    id="membership-title"
                    ref={membershipRef}
                    tabIndex={-1}
                    className="text-[1.25rem] sm:text-[1.45rem] font-extrabold text-text-primary outline-none scroll-mt-4"
                  >
                    {t('yourMembership')}
                  </h2>
                  {mine && <MembershipLedger memberships={mine.memberships} gatedBenefits={gatedBenefits} />}
                  {/* PRO identity verification (KYC) — deliberately here in the
                      membership area, never in the public profile (final phase §9). */}
                  {(currentTier === 'pro' || pending?.tier === 'pro') && <KycSection />}
                  {/* Active PRO customers manage the real BNPL line here. The
                      panel also remains visible after a downgrade only when an
                      existing account or debt must still be reviewable. */}
                  {mine && <BnplPanel activePro={mine.status.active && mine.status.tier === 'pro'} />}
                  <StoreCta />
                </section>
              )}
            </div>

            {/* The checkout: a bar over the navigation on a phone, a sticky
                aside from 1024px. Never inside a transformed ancestor — a
                transform would capture its fixed position. */}
            <div className="lg:relative">
              <CheckoutBar
                plan={selectedPlan}
                standing={standing[activeTier]}
                quote={quote}
                quoteLoading={quoteLoading}
                quoteError={quoteError}
                onRetryQuote={refreshQuote}
                isGuest={!user}
                busy={phase === 'busy'}
                onSubscribe={openConfirm}
                ctaRef={ctaRef}
                currentExpiry={currentExpiry}
              />
            </div>
          </div>
        )}
      </div>

      <PurchaseConfirm
        open={confirmOpen}
        onClose={closeConfirm}
        plan={selectedPlan}
        quote={quote}
        quoteLoading={quoteLoading}
        quoteError={quoteError}
        onRetryQuote={refreshQuote}
        phase={phase}
        result={result}
        quoteChanged={quoteChanged}
        onConfirm={runPurchase}
        onRetry={runPurchase}
        anchor={ctaRef}
      />
    </div>
  );
}
