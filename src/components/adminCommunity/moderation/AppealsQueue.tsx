/**
 * «الاعتراضات» — THE APPEALS QUEUE (`GET /api/admin/moderation/appeals`,
 * `POST /api/admin/moderation/appeals/:id`; worker/routes/adminModeration.ts).
 *
 * Each appeal as the desk needs to judge it: who, their standing now, the
 * decision they contest (what, about what, the reason the desk wrote, until
 * when), their own words, and — once decided — the answer they were given.
 * «قبول» undoes the decision only while it is still the one in force (a newer
 * decision is left alone, and the desk is told nothing was undone); «رفض»
 * keeps it. Either way the person is told, with the desk's words. An appeal is
 * decided once (APPEAL_DECIDED).
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, History, X } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { apiRefusal } from '../../../lib/refusalStrings';
import { Button } from '../../ui/Button';
import { StatusChip } from '../../ui/Badge';
import { EmptyState, ErrorState } from '../../ui/AsyncStates';
import { Segmented } from '../../ui/Segmented';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import { APPEAL_DECISION_MAX, moderationDeskApi, type AppealState, type DeskAppeal } from './api';
import type { AuditTarget } from './AuditTrail';
import type { DecisionRequest } from './DecisionSheet';
import { PersonLine } from './TargetPreview';
import { deskDate, deskLang, deskStrings, type DeskLang, type DeskStrings } from './strings';

type Filter = AppealState | 'all';

/** One appeal: the person, the decision, their words, and the desk's door or answer. */
export function AppealRow({
  appeal: a,
  lang,
  onDecide,
  onHistory,
}: {
  appeal: DeskAppeal;
  lang: DeskLang;
  onDecide?: (a: DeskAppeal, state: 'accepted' | 'rejected') => void;
  onHistory?: (t: AuditTarget) => void;
}) {
  const s = deskStrings(lang);
  const until = deskDate(a.action.until, lang);
  return (
    <li className="lv-surface p-4" data-appeal={a.id} data-appeal-state={a.state}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-[13.5px] font-bold text-text-primary">
          <bdi>{s.appealBy(a.user.name || a.user.username || a.user.id)}</bdi>
        </p>
        <StatusChip tone={a.state === 'accepted' ? 'success' : a.state === 'rejected' ? 'danger' : 'warning'}>{s.appealStates[a.state]}</StatusChip>
      </div>
      <p className="mt-0.5 text-[11.5px] text-text-muted">{deskDate(a.created_at, lang, true)}</p>
      <PersonLine role={s.roles.account} person={a.user} lang={lang} />
      <div className="mt-3 rounded-xl bg-surface-raised p-3" data-appeal-action={a.action.action}>
        <p className="text-[12px] text-text-muted">{s.appealOn}</p>
        <p className="mt-0.5 text-[13px] font-semibold text-text-primary">
          {s.actions[a.action.action] ?? a.action.action} · {s.targets[a.action.target_type] ?? a.action.target_type}
          {until && <span className="font-normal text-text-muted"> · {s.until(until)}</span>}
        </p>
        {a.action.reason && (
          <p dir="auto" className="mt-0.5 text-[12.5px] leading-relaxed text-text-secondary">
            {a.action.reason}
          </p>
        )}
      </div>
      <p dir="auto" className="mt-3 whitespace-pre-wrap break-words border-s-2 border-border-subtle ps-3 text-[13px] leading-relaxed text-text-primary" data-appeal-body>
        {a.body}
      </p>
      {a.decision && (
        <p dir="auto" className="mt-2 text-[12.5px] leading-relaxed text-text-secondary">
          <span className="font-semibold text-text-primary">{s.deskAnswer}</span> {a.decision}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {a.state === 'open' && onDecide && (
          <>
            <Button variant="primary" size="sm" icon={<Check aria-hidden="true" className="h-4 w-4" />} onClick={() => onDecide(a, 'accepted')} data-appeal-accept>
              {s.accept}
            </Button>
            <Button variant="secondary" size="sm" icon={<X aria-hidden="true" className="h-4 w-4" />} onClick={() => onDecide(a, 'rejected')} data-appeal-reject>
              {s.reject}
            </Button>
          </>
        )}
        {onHistory && (
          <Button
            variant="ghost"
            size="sm"
            icon={<History aria-hidden="true" className="h-4 w-4" />}
            onClick={() => onHistory({ type: a.action.target_type, id: a.action.target_id, label: a.user.name })}
            data-appeal-history
          >
            {s.history}
          </Button>
        )}
      </div>
    </li>
  );
}

/** «قبول» / «رفض» an appeal, with the answer the person will read (≤ 1000). */
export function appealRequest(a: DeskAppeal, state: 'accepted' | 'rejected', s: DeskStrings, l: DeskLang, onDone: () => void): DecisionRequest {
  return {
    title: state === 'accepted' ? s.acceptTitle : s.rejectTitle,
    consequence: state === 'accepted' ? s.acceptConsequence : s.rejectConsequence,
    confirmLabel: state === 'accepted' ? s.accept : s.reject,
    reason: 'optional',
    reasonLabel: s.decisionLabel,
    maxLength: APPEAL_DECISION_MAX,
    onSubmit: async ({ reason }) => {
      try {
        const r = await moderationDeskApi.decideAppeal(a.id, state, reason);
        toast.success(r.replayed ? s.done.replayed : state === 'accepted' ? s.accepted(r.restored) : s.rejected);
        onDone();
      } catch (e) {
        throw new Error(apiRefusal(e, l, s.failed));
      }
    },
  };
}

export default function AppealsQueue({ onDecision, onHistory }: { onDecision: (r: DecisionRequest) => void; onHistory: (t: AuditTarget) => void }) {
  const { lang } = useLanguage();
  const l = deskLang(lang);
  const s = deskStrings(l);
  const [filter, setFilter] = useState<Filter>('open');
  const [rows, setRows] = useState<DeskAppeal[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState(false);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    moderationDeskApi
      .appeals(filter)
      .then((p) => {
        if (!alive) return;
        setRows(p.appeals);
        setNext(p.next);
      })
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [filter, nonce]);

  const loadMore = async () => {
    if (!next || more) return;
    setMore(true);
    try {
      const p = await moderationDeskApi.appeals(filter, next);
      setRows((r) => [...(r ?? []), ...p.appeals]);
      setNext(p.next);
    } catch {
      toast.error(s.loadFailed);
    } finally {
      setMore(false);
    }
  };

  const decide = (a: DeskAppeal, state: 'accepted' | 'rejected') => onDecision(appealRequest(a, state, s, l, reload));

  return (
    <div className="flex flex-col gap-3" data-appeals-queue>
      {/* On a phone the row runs to the panel's edges and scrolls there — never cut mid-card. */}
      <div className="-mx-4 -my-1 overflow-x-auto px-4 py-1 hide-scrollbar sm:mx-0 sm:px-0">
        <Segmented
          size="sm"
          group="moderation-appeals-state"
          label={s.appealStateLabel}
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          dataAttr="data-appeals-filter"
          items={(['open', 'accepted', 'rejected', 'all'] as const).map((id) => ({ id, label: s.appealStates[id] }))}
          className="min-w-[340px] max-w-md"
        />
      </div>
      {error && !rows ? (
        <ErrorState error={error} onRetry={reload} compact />
      ) : !rows ? (
        <SkeletonGroup className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <div key={i} aria-hidden="true" className="lv-surface p-4">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="mt-3 h-14 w-full" />
            </div>
          ))}
        </SkeletonGroup>
      ) : rows.length === 0 ? (
        <EmptyState title={s.emptyAppeals} compact />
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((a) => (
            <AppealRow key={a.id} appeal={a} lang={l} onDecide={decide} onHistory={onHistory} />
          ))}
        </ul>
      )}
      {next && rows && (
        <Button variant="ghost" size="sm" block onClick={loadMore} loading={more}>
          {s.more}
        </Button>
      )}
    </div>
  );
}
