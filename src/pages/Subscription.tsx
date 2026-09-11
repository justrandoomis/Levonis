/**
 * /subscription — the membership page.
 *
 * Open to guests: what a card costs is the first thing someone weighing one
 * wants to see. The page reads GET /api/memberships/plans (public) and, when
 * signed in, GET /api/memberships/mine and GET /api/memberships/quote for
 * the selected plan — the quote is the server saying exactly what buying that
 * plan would do for THIS account (price, upgrade credit, USD debit, balance,
 * shortfall, start-now or reserve-until-launch). Nothing shown as a number is
 * computed in the browser — the per-month figure on the cards is the server's
 * `per_month_iqd` too.
 *
 * Buying goes through a confirmation window (PurchaseConfirm). ONE idempotency
 * key is generated per confirmed attempt and reused only for a retry of that
 * same attempt, so a flaky network can never charge twice; a new attempt gets
 * a new key. The confirmation carries the very figures the window displayed;
 * when the server's recomputed charge differs (a day boundary, a new exchange
 * rate) it refuses with 409 QUOTE_CHANGED and the fresh quote, which the
 * window shows with a one-line notice instead of charging. The result stays
 * in the window until the person closes it.
 *
 * Layout: the card on top; then "Choose your card" — the tier selector and
 * the duration cards — with the selected-plan summary and the CTA beside them
 * on a desktop (sticky) and below them on a phone; the ledger; the benefits.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useLanguage } from '../LanguageContext';
import { useWallet } from '../WalletContext';
import { useAuth } from '../AuthContext';
import { useMotion } from '../lib/motion';
import { api, ApiError, newIdempotencyKey } from '../lib/api';
import { useSignInPrompt } from '../lib/guest';
import { formatDate } from '../components/orders/format';
import StoreCta from '../components/merchant/StoreCta';
import KycSection from '../components/kyc/KycSection';
import { LevoCard } from '../components/subscription/LevoCard';
import { PlanPicker } from '../components/subscription/PlanPicker';
import { PlanSummary } from '../components/subscription/PlanSummary';
import { PurchaseConfirm } from '../components/subscription/PurchaseConfirm';
import { BenefitsSection } from '../components/subscription/BenefitsSection';
import { MembershipLedger } from '../components/subscription/MembershipLedger';
import { BnplPanel } from '../components/subscription/BnplPanel';
import { FREE_FACE, TIER_META, isPaidTier, tierLabel, type AnyTier, type PaidTier } from '../components/subscription/tierMeta';
import type {
  ApiPlan,
  ConfirmedFigures,
  DeliveryThresholds,
  LaunchInfo,
  MineResponse,
  PlanFeatures,
  PlansResponse,
  PurchaseQuote,
  PurchaseResult,
  SubscribeResponse,
} from '../components/subscription/types';

export default function Subscription() {
  const { t, lang } = useLanguage();
  const m = useMotion();
  const { refreshWallet } = useWallet();
  const { user, refreshUser } = useAuth();
  const { signIn } = useSignInPrompt();

  // ------------------------------------------------------------ catalogue
  const [plans, setPlans] = useState<ApiPlan[] | null>(null);
  const [plansError, setPlansError] = useState<unknown>(null);
  const [launch, setLaunch] = useState<LaunchInfo | null>(null);
  const [features, setFeatures] = useState<PlanFeatures | null>(null);
  const [delivery, setDelivery] = useState<DeliveryThresholds | null>(null);
  const [plansNonce, setPlansNonce] = useState(0);
  const reloadPlans = useCallback(() => setPlansNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setPlansError(null);
    api
      .get<PlansResponse>('/api/memberships/plans')
      .then((data) => {
        if (cancelled) return;
        setPlans(data.plans || []);
        setLaunch(data.launch || null);
        setFeatures(data.features ?? null);
        setDelivery(data.delivery ?? null);
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
  const pendingLaunch = mine?.status.pending_launch ?? null;
  const gatedBenefits = mine?.status.gated_benefits ?? [];

  // ----------------------------------------------------------- selection
  /** Tier order follows the server's own `sort` column, so the owner reorders
   *  the selector from the memberships admin without a code change. */
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

  const [activeTier, setActiveTier] = useState<PaidTier>('pro');
  const [selectedPlanId, setSelectedPlanId] = useState('');

  // Never leave the page on a tier the catalogue does not offer.
  useEffect(() => {
    if (tiers.length && !tiers.includes(activeTier)) setActiveTier(tiers[0]);
  }, [tiers, activeTier]);

  const tierPlans = useMemo(
    () =>
      (plans || [])
        .filter((p) => p.tier === activeTier)
        .sort((a, b) => a.sort - b.sort || a.duration_months - b.duration_months),
    [plans, activeTier]
  );

  // Keep the selection valid for the visible tier; default to the longest
  // plan, which is the one every tier sells.
  useEffect(() => {
    if (tierPlans.length === 0) {
      setSelectedPlanId('');
      return;
    }
    if (!tierPlans.some((p) => p.id === selectedPlanId)) {
      setSelectedPlanId(tierPlans[tierPlans.length - 1].id);
    }
  }, [tierPlans, selectedPlanId]);

  const selectedPlan = tierPlans.find((p) => p.id === selectedPlanId) || null;

  // --------------------------------------------------------------- quote
  const [quote, setQuote] = useState<PurchaseQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<unknown>(null);
  const [quoteNonce, setQuoteNonce] = useState(0);
  const refreshQuote = useCallback(() => setQuoteNonce((n) => n + 1), []);

  const quotePlanId = user && selectedPlan && selectedPlan.purchasable ? selectedPlan.id : '';
  useEffect(() => {
    if (!quotePlanId) {
      setQuote(null);
      setQuoteError(null);
      setQuoteLoading(false);
      return;
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

  const openConfirm = () => {
    if (!selectedPlan) return;
    // A guest may read the whole page; subscribing is where an account starts
    // to matter. Take them to sign in and BRING THEM BACK here.
    if (!user) {
      signIn();
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
  const glow = isPaidTier(activeTier) ? TIER_META[activeTier].glow : FREE_FACE.glow;
  const enter = (delay = 0) => ({
    initial: { opacity: 0, y: m.travel(16) },
    animate: { opacity: 1, y: 0 },
    transition: { ...m.spring('ui'), delay },
  });

  return (
    <div className="w-full flex-1 text-zinc-300 pb-24 bg-[#0a0a0a] relative">
      {/* Ambient light in the selected tier's colour. */}
      <div
        aria-hidden
        className={`fixed top-[20%] left-1/2 -translate-x-1/2 w-full max-w-lg h-[600px] ${glow} rounded-full blur-[120px] pointer-events-none z-0 transition-colors duration-700`}
      />

      {/* 1. The card */}
      <motion.section {...enter(0)} className="pt-8 px-4 sm:px-6 mb-10 flex flex-col items-center relative z-10">
        <h2 className="text-xl font-bold text-gold mb-6 text-center">{t('yourLevoCard')}</h2>
        <LevoCard user={user} tier={currentTier} expiresAt={currentExpiry} />

        {/* Prepaid-pending-launch state on the card holder's account */}
        {pendingLaunch && (
          <div data-pending-launch className="mt-4 w-full max-w-sm bg-sky-500/10 border border-sky-500/30 rounded-2xl px-4 py-3 text-center">
            <p className="text-sky-300 text-[13px] font-bold mb-0.5">
              {tierLabel(pendingLaunch.tier)} — {pendingLaunch.duration_months} {t('months')}
            </p>
            <p className="text-sky-200/80 text-[12px]">
              {t('launchNote')}
              {launch?.launch_at ? ` — ${formatDate(launch.launch_at, lang)}` : ''}
            </p>
          </div>
        )}

        {/* PRO identity verification (KYC) — deliberately here in the
            membership area, never in the public profile (final phase §9). */}
        {(currentTier === 'pro' || pendingLaunch?.tier === 'pro') && (
          <div className="mt-4 w-full max-w-sm">
            <KycSection />
          </div>
        )}
      </motion.section>

      <div className="px-4 sm:px-6 max-w-4xl mx-auto relative z-10 space-y-10">
        {/* 2. Choose your card + the summary/CTA. Two columns from lg. */}
        <motion.div {...enter(0.05)} className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(18rem,20rem)] lg:gap-8 lg:items-start">
          <div className="min-w-0">
            <PlanPicker
              plans={plans}
              error={plansError}
              onRetry={reloadPlans}
              tiers={tiers}
              activeTier={activeTier}
              onTierChange={(tier) => {
                setActiveTier(tier);
                setSelectedPlanId('');
              }}
              tierPlans={tierPlans}
              selectedPlanId={selectedPlanId}
              onSelectPlan={setSelectedPlanId}
              currentTier={currentTier}
            />
            <div className="mt-6">
              <StoreCta />
            </div>
          </div>

          <div className="mt-6 lg:mt-0 lg:sticky lg:top-24">
            <PlanSummary
              plan={selectedPlan}
              quote={quote}
              quoteLoading={quoteLoading}
              quoteError={quoteError}
              onRetryQuote={refreshQuote}
              isGuest={!user}
              launch={launch}
              onSubscribe={openConfirm}
              ctaRef={ctaRef}
              busy={phase === 'busy'}
            />
          </div>
        </motion.div>

        {/* 3. The ledger and paused benefits */}
        {user && mine && (mine.memberships.length > 0 || gatedBenefits.length > 0) && (
          <motion.div {...enter(0.1)} className="max-w-2xl mx-auto lg:max-w-none">
            <MembershipLedger memberships={mine.memberships} gatedBenefits={gatedBenefits} />
          </motion.div>
        )}

        {/* Active PRO customers manage the real BNPL line here. The panel
            also remains visible after a downgrade only when an existing
            account or debt must still be reviewable/repayable. */}
        {user && mine && (
          <motion.div {...enter(0.12)} className="max-w-2xl mx-auto lg:max-w-none">
            <BnplPanel activePro={mine.status.active && mine.status.tier === 'pro'} />
          </motion.div>
        )}

        {/* 4. What each card gives */}
        <motion.div {...enter(0.15)}>
          <BenefitsSection features={features} delivery={delivery} loading={plans === null && !plansError} />
        </motion.div>
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
        launch={launch}
      />
    </div>
  );
}
