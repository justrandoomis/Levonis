/**
 * /games/redeem — the Farm Coins → Levonis Points rules, as the server states
 * them. Phase 1 mints no Levonis Points and `rewards.levonis_points.enabled`
 * defaults to false, so this page says conversion is not open. There is no
 * button here because there is no conversion route: the page reports the
 * server's state and nothing more. When the server sends rules it lists them
 * verbatim; when it sends none it says so.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Coins, Info } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import Note from '../../components/ui/Note';
import { ErrorState, UnauthorizedState } from '../../components/ui/AsyncStates';
import { Skeleton, SkeletonGroup } from '../../components/ui/Skeleton';
import { farmApi, type PublicFarmConfig } from '../../lib/farmApi';
import { FARM_STRINGS, type FarmStrings } from '../farm/strings';
import { starsFromBp } from '../farm/format';
import { GamesBody, GamesHeader, GamesPage } from '../farm/PageChrome';
import { SectionTitle } from '../farm/bits';
import { PANEL } from '../farm/ui';

/** The rule lines the server's config supports — only the fields it sent. */
export function redeemRules(config: PublicFarmConfig | null | undefined, s: FarmStrings): string[] {
  const lp = config?.rewards?.levonis_points;
  if (!lp) return [];
  const out: string[] = [];
  if (typeof lp.coins_per_point === 'number') out.push(s.redeemRuleRate(lp.coins_per_point));
  if (typeof lp.daily_cap_points === 'number') out.push(s.redeemRuleDaily(lp.daily_cap_points));
  if (typeof lp.weekly_cap_points === 'number') out.push(s.redeemRuleWeekly(lp.weekly_cap_points));
  if (typeof lp.min_level === 'number') out.push(s.redeemRuleLevel(lp.min_level));
  if (typeof lp.min_reputation_bp === 'number') out.push(s.redeemRuleRep(starsFromBp(lp.min_reputation_bp)));
  return out;
}

export default function GameRedeem() {
  const { lang, dir } = useLanguage();
  const s = FARM_STRINGS[lang];
  const { isAuthenticated, isLoaded } = useAuth();
  const [config, setConfig] = useState<PublicFarmConfig | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const st = await farmApi.state();
      setConfig(st.config);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    if (isLoaded && isAuthenticated) void load();
  }, [isLoaded, isAuthenticated, load]);

  let body: React.ReactNode;
  if (!isLoaded) {
    body = (
      <SkeletonGroup>
        <Skeleton className="h-24 w-full rounded-2xl" />
      </SkeletonGroup>
    );
  } else if (!isAuthenticated) {
    body = <UnauthorizedState next="/games/redeem" description={s.redeemGuest} />;
  } else if (error) {
    body = <ErrorState error={error} onRetry={() => void load()} next="/games/redeem" />;
  } else if (!config) {
    body = (
      <SkeletonGroup>
        <Skeleton className="h-24 w-full rounded-2xl" />
      </SkeletonGroup>
    );
  } else {
    const lp = config.rewards?.levonis_points;
    const enabled = lp?.enabled === true;
    const rules = redeemRules(config, s);
    body = (
      <>
        {!enabled && (
          <Note tone="amber" icon={<Info className="w-4 h-4" />} animate={false} testId="redeem-closed">
            <p className="font-bold">{s.redeemClosedTitle}</p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed">{s.redeemClosedBody}</p>
          </Note>
        )}
        <section className="space-y-3" aria-labelledby="redeem-rules-title">
          <SectionTitle id="redeem-rules-title" title={s.redeemRulesTitle} />
          {rules.length === 0 ? (
            <p className="text-[13px] text-zinc-500">{s.redeemNoRules}</p>
          ) : (
            <ul className={`${PANEL} divide-y divide-zinc-800/70`} data-redeem-rules={rules.length}>
              {rules.map((r) => (
                <li key={r} className="px-4 py-2.5 text-[13px] text-zinc-200 tabular-nums">
                  {r}
                </li>
              ))}
            </ul>
          )}
        </section>
        <p className="text-[11.5px] text-zinc-500 leading-relaxed">{s.redeemNoButton}</p>
      </>
    );
  }

  return (
    <GamesPage dir={dir} testId="game-redeem">
      <GamesHeader title={s.redeemTitle} backLabel={s.back} fallback="/games" />
      <GamesBody>
        <section className={`${PANEL} p-5 space-y-2`}>
          <h2 className="flex items-center gap-2 text-white font-bold text-[16px]">
            <Coins aria-hidden="true" className="w-5 h-5 text-[#BAA369]" />
            {s.redeemTitle}
          </h2>
          <p className="text-[13px] text-zinc-400 leading-relaxed">{s.redeemIntro}</p>
        </section>
        {body}
      </GamesBody>
    </GamesPage>
  );
}
