import React, { useState, useEffect } from 'react';
import { Crown } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api } from '../lib/api';
import PlanPicker from '../components/subscription/PlanPicker';
import BenefitsSection from '../components/subscription/BenefitsSection';
import type { PaidTier } from '../components/subscription/tierMeta';
import type { ApiPlan } from '../components/subscription/types';

export default function Subscription() {
  const { loc } = useLanguage();

  const [plans, setPlans] = useState<ApiPlan[] | null>(null);
  const [activeTier, setActiveTier] = useState<PaidTier>('plus');
  const [selectedPlanId, setSelectedPlanId] = useState<string>('');
  const [error, setError] = useState<unknown>(null);

  const fetchPlans = () => {
    setPlans(null);
    setError(null);
    api
      .get<{ plans: ApiPlan[] }>('/api/memberships/plans')
      .then((res) => {
        if (res.plans) {
          setPlans(res.plans);
          if (res.plans.length > 0) {
            setSelectedPlanId(res.plans[0].id);
          }
        }
      })
      .catch((e) => setError(e));
  };

  useEffect(() => {
    fetchPlans();
  }, []);

  const tiers: PaidTier[] = ['plus', 'pro'];
  const tierPlans = (plans || []).filter((p) => p.tier === activeTier);

  return (
    <div className="min-h-screen bg-black text-white pb-24">
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 font-semibold text-xs mb-3">
            <Crown className="w-3.5 h-3.5" />
            <span>{loc('عضويات ليفونيس الحصرية', 'Levonis Memberships', 'ئەندامێتی لێڤۆنیس')}</span>
          </div>
          <h1 className="text-3xl font-black text-white tracking-tight">
            {loc('استثمر في إنتاجك ثلاثي الأبعاد', 'Elevate Your 3D Printing', 'بەرهەمەکانت بەرەوپێش ببە')}
          </h1>
          <p className="text-sm text-zinc-400 mt-2 max-w-lg mx-auto leading-relaxed">
            {loc(
              'احصل على خصومات حصرية، شحن مجاني، وصول مبكر لأحدث الطابعات ودعم فني متخصص على مدار الساعة.',
              'Unlock exclusive discounts, free delivery, priority printing quotas and premier dedicated support.',
              'داشکاندنی تایبەت، گەیاندنی بێبەرامبەر و دەستگەیشتن بە نوێترین چاپکەرەکان.'
            )}
          </p>
        </div>

        <PlanPicker
          plans={plans}
          error={error}
          onRetry={fetchPlans}
          tiers={tiers}
          activeTier={activeTier}
          onTierChange={(t) => {
            setActiveTier(t);
            const first = (plans || []).find((p) => p.tier === t);
            if (first) setSelectedPlanId(first.id);
          }}
          tierPlans={tierPlans}
          selectedPlanId={selectedPlanId}
          onSelectPlan={setSelectedPlanId}
          currentTier="free"
        />

        <div className="mt-12">
          <BenefitsSection tier={activeTier} />
        </div>
      </div>
    </div>
  );
}
