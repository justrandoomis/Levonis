/**
 * «حالة حسابي» — /moderation (docs/COMMUNITY_ECOSYSTEM.md §9.6; the link every
 * moderation notice carries, `/moderation?action=<id>`).
 *
 * The account's standing now, then every decision the desk took about the
 * account or its content (`GET /api/moderation/status`, newest first): what
 * was decided, the reason the desk wrote, the day and the end date, and its
 * appeal — the state and the desk's answer when one is on file, «اعتراض»
 * while the decision may still be contested (one per decision, ./AppealSheet).
 * `?action=` marks the decision the notice was about and brings it into view.
 *
 * NOT BEHIND THE COMMUNITY GATE, and open to a banned account: the one door a
 * ban leaves is the appeal (worker/lib/userStatus.ts `bannedMayWrite`), and an
 * appeal is about the account, not the community (the route is
 * ProtectedRoute only — src/App.tsx).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CircleCheckBig } from 'lucide-react';
import { useAuth } from '../../../AuthContext';
import { useLanguage } from '../../../LanguageContext';
import { useGoBack } from '../../../lib/useGoBack';
import { Button } from '../../ui/Button';
import { StatusChip } from '../../ui/Badge';
import { EmptyState, ErrorState } from '../../ui/AsyncStates';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import StatusBanner from './StatusBanner';
import { actionFromSearch, moderationApi, standingOf, type Appeal, type ModerationDecision, type MyModeration } from './api';
import { appealTone, modDate, modLang, moderationStrings, type ModLang } from './strings';

const AppealSheet = React.lazy(() => import('./AppealSheet'));

/**
 * ONE APPEAL PER DECISION, ON THE PAGE TOO: the appeal the server filed takes
 * the door's place — the decision is no longer appealable and shows the
 * appeal's state from then on.
 */
export function withAppeal(decisions: ModerationDecision[], id: string, appeal: Appeal): ModerationDecision[] {
  return decisions.map((x) =>
    x.id === id
      ? { ...x, appealable: false, appeal: { id: appeal.id, state: appeal.state, decision: appeal.decision, decided_at: appeal.decided_at, created_at: appeal.created_at } }
      : x
  );
}

/** One decision, its appeal's state or its door. */
export function DecisionRow({
  decision,
  lang,
  current = false,
  onAppeal,
}: {
  decision: ModerationDecision;
  lang: ModLang;
  current?: boolean;
  onAppeal?: (d: ModerationDecision) => void;
}) {
  const s = moderationStrings(lang);
  const date = modDate(decision.created_at, lang);
  const until = modDate(decision.until, lang);
  const appeal = decision.appeal;
  return (
    <li
      id={`decision-${decision.id}`}
      data-decision={decision.id}
      data-decision-action={decision.action}
      aria-current={current ? 'true' : undefined}
      className={`scroll-mt-14 rounded-2xl border p-4 ${current ? 'border-border-subtle bg-surface-selected' : 'border-border-subtle/60 bg-surface'}`}
    >
      <p className="text-[14px] font-bold leading-snug text-text-primary" dir="auto">
        {s.decision(decision.action, decision.target_type, decision.target_label)}
      </p>
      <p className="mt-0.5 text-[12px] text-text-muted">
        {date && s.on(date)}
        {until && ` · ${s.until(until)}`}
      </p>
      {decision.reason && (
        <p className="mt-1.5 text-[13px] leading-relaxed text-text-secondary" dir="auto">
          {s.reason(decision.reason)}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {appeal ? (
          <div className="min-w-0" data-appeal-state={appeal.state}>
            <StatusChip tone={appealTone(appeal.state)}>{s.appealState[appeal.state]}</StatusChip>
            {appeal.decision && (
              <p className="mt-2 text-[12.5px] leading-relaxed text-text-secondary" dir="auto">
                <span className="font-semibold text-text-primary">{s.deskAnswer}</span> {appeal.decision}
              </p>
            )}
          </div>
        ) : decision.appealable && onAppeal ? (
          <Button variant="secondary" size="sm" onClick={() => onAppeal(decision)} data-appeal-open={decision.id}>
            {s.appeal}
          </Button>
        ) : null}
        {decision.target_url && (
          <Link to={decision.target_url} className="lv-button lv-button-ghost lv-button-sm" data-decision-target>
            {s.openTarget}
          </Link>
        )}
      </div>
    </li>
  );
}

function RowsSkeleton() {
  return (
    <SkeletonGroup className="flex flex-col gap-3">
      {[0, 1, 2].map((i) => (
        <div key={i} aria-hidden="true" className="rounded-2xl border border-border-subtle/60 bg-surface p-4">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="mt-2 h-3 w-1/3" />
          <Skeleton className="mt-3 h-3.5 w-full" />
        </div>
      ))}
    </SkeletonGroup>
  );
}

export default function ModerationPage() {
  const goBack = useGoBack('/community');
  const { lang, dir } = useLanguage();
  const l = modLang(lang);
  const s = moderationStrings(l);
  const { user } = useAuth();
  const { search } = useLocation();
  const target = actionFromSearch(search);
  const [data, setData] = useState<MyModeration | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const [appealing, setAppealing] = useState<ModerationDecision | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    moderationApi
      .status()
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [nonce, user?.id]);

  // The notice's decision, in view once it is drawn.
  useEffect(() => {
    if (!data || !target) return;
    const frame = requestAnimationFrame(() => document.getElementById(`decision-${target}`)?.scrollIntoView({ block: 'center' }));
    return () => cancelAnimationFrame(frame);
  }, [data, target]);

  const filed = useCallback((id: string, appeal: Appeal) => setData((d) => (d ? { ...d, decisions: withAppeal(d.decisions, id, appeal) } : d)), []);

  // The server's standing is fresher than the session's; until it answers, the session's.
  const standing = data?.standing ?? standingOf(user);
  const decisions = useMemo(() => data?.decisions ?? [], [data]);
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;

  return (
    <div className="min-h-screen bg-canvas pb-28 text-text-primary" data-moderation-page>
      <div className="material scroll-edge sticky top-0 z-40 h-14 px-4">
        <div className="mx-auto flex h-full max-w-3xl items-center gap-2">
          <button
            type="button"
            aria-label={s.page.back}
            onClick={goBack}
            className="press-scale -ms-2 flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Back className="h-5 w-5" />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-[15px] font-bold">{s.page.title}</h1>
        </div>
      </div>

      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pt-4">
        {standing.status === 'active' ? (
          <section className="lv-surface flex items-start gap-3 p-4" data-standing="active">
            <CircleCheckBig aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-success" />
            <div className="min-w-0">
              <h2 className="text-[14px] font-bold text-text-primary">{s.page.good}</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">{s.page.goodHint}</p>
            </div>
          </section>
        ) : (
          <StatusBanner standing={standing} appealHref={null} />
        )}

        <section aria-labelledby="moderation-decisions">
          <h2 id="moderation-decisions" className="mb-3 text-[13px] font-semibold text-text-muted">
            {s.page.decisions}
          </h2>
          {error && !data ? (
            <ErrorState error={error} onRetry={() => setNonce((n) => n + 1)} compact />
          ) : !data ? (
            <RowsSkeleton />
          ) : decisions.length === 0 ? (
            <EmptyState title={s.page.none} compact />
          ) : (
            <ul className="flex flex-col gap-3" data-decisions>
              {decisions.map((d) => (
                <DecisionRow key={d.id} decision={d} lang={l} current={d.id === target} onAppeal={setAppealing} />
              ))}
            </ul>
          )}
        </section>
      </div>

      {appealing && (
        <React.Suspense fallback={null}>
          <AppealSheet
            open
            decision={appealing}
            onClose={() => setAppealing(null)}
            onFiled={filed}
            onStale={() => setNonce((n) => n + 1)}
          />
        </React.Suspense>
      )}
    </div>
  );
}
