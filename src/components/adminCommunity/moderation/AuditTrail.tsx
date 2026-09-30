/**
 * «سجل القرارات» — THE HISTORY OF ONE TARGET (`GET /api/admin/moderation/audit`,
 * worker/routes/adminModeration.ts): its standing now, every moderation
 * decision about it (for an account, also about its content), each with the
 * staff member who took it and its appeal, then the audit rows the desk may
 * read about it — moderation and community actions, never money.
 *
 * Read when the sheet opens, every time: a history is a record, and the desk
 * reads the record as it is now, not as it was when the queue loaded.
 */
import { useEffect, useId, useState } from 'react';
import { useLanguage } from '../../../LanguageContext';
import { StatusChip } from '../../ui/Badge';
import { ErrorState } from '../../ui/AsyncStates';
import { Sheet } from '../../ui/Sheet';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { moderationDeskApi, type HistoryAction, type ModerationTargetType, type TargetHistory } from './api';
import { StandingChip } from './TargetPreview';
import { deskDate, deskLang, deskStrings, type DeskLang } from './strings';

export interface AuditTarget {
  type: ModerationTargetType;
  id: string;
  /** What the sheet's title names — a name, a title. */
  label: string;
}

/** One decision in the history: what, why, when, by whom, until when, and its appeal. */
export function HistoryRow({ a, lang }: { a: HistoryAction; lang: DeskLang }) {
  const s = deskStrings(lang);
  const until = deskDate(a.until, lang);
  return (
    <li className="py-3" data-history-action={a.action} data-history-id={a.id}>
      <p className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-bold text-text-primary">
        {s.actions[a.action] ?? a.action}
        <span className="text-[12px] font-normal text-text-muted">· {s.targets[a.target_type] ?? a.target_type}</span>
      </p>
      {a.reason && (
        <p dir="auto" className="mt-0.5 text-[12.5px] leading-relaxed text-text-secondary">
          {a.reason}
        </p>
      )}
      <p className="mt-0.5 text-[11.5px] text-text-muted">
        {deskDate(a.created_at, lang, true)}
        {a.actor && ` · ${s.by(a.actor.name)}`}
        {until && ` · ${s.until(until)}`}
      </p>
      {a.appeal && (
        <div className="mt-1.5" data-history-appeal={a.appeal.state}>
          <StatusChip tone={a.appeal.state === 'accepted' ? 'success' : a.appeal.state === 'rejected' ? 'danger' : 'warning'}>{s.appealLine(a.appeal.state)}</StatusChip>
          {a.appeal.body && (
            <p dir="auto" className="mt-1 text-[12px] leading-relaxed text-text-secondary">
              {a.appeal.body}
            </p>
          )}
          {a.appeal.decision && (
            <p dir="auto" className="mt-1 text-[12px] leading-relaxed text-text-secondary">
              <span className="font-semibold text-text-primary">{s.deskAnswer}</span> {a.appeal.decision}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/** The target's standing now, when it has one (an account, a post, a comment). */
function Current({ history, lang }: { history: TargetHistory; lang: DeskLang }) {
  const s = deskStrings(lang);
  const c = history.current as Record<string, unknown> | null;
  if (!c || c.exists === false) return null;
  if (history.target.type === 'user') {
    return (
      <p className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-text-secondary" data-history-current>
        <span className="text-text-muted">{s.now}</span>
        {c.status === 'active' ? <StatusChip tone="success">{s.statuses.active}</StatusChip> : <StandingChip status={String(c.status ?? '')} until={(c.until as string | null) ?? null} lang={lang} />}
      </p>
    );
  }
  const hidden = history.target.type === 'post' ? !!c.hidden : c.state === 'hidden';
  return hidden ? (
    <p className="flex items-center gap-1.5 text-[12.5px] text-text-secondary" data-history-current>
      <span className="text-text-muted">{s.now}</span>
      <StatusChip tone="danger">{s.hidden}</StatusChip>
    </p>
  ) : null;
}

export default function AuditTrail({ target, onClose }: { target: AuditTarget | null; onClose: () => void }) {
  const { lang } = useLanguage();
  const l = deskLang(lang);
  const s = deskStrings(l);
  const [data, setData] = useState<TargetHistory | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const titleId = useId();

  useEffect(() => {
    if (!target) return;
    let alive = true;
    setData(null);
    setError(null);
    moderationDeskApi
      .history(target.type, target.id)
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [target, nonce]);

  return (
    <Sheet
      open={!!target}
      onClose={onClose}
      labelledBy={titleId}
      detents={['medium', 'large']}
      dragHandle
      testId="moderation-history"
      header={
        <div className="px-4 pb-2 pt-1">
          <h2 id={titleId} className="text-[16px] font-bold text-text-primary">
            {s.historyTitle}
          </h2>
          {target?.label && (
            <p className="truncate text-[12.5px] text-text-muted">
              <bdi>{target.label}</bdi>
            </p>
          )}
        </div>
      }
    >
      <div className="px-4 pb-4" data-history>
        {error ? (
          <ErrorState error={error} onRetry={() => setNonce((n) => n + 1)} compact />
        ) : !data ? (
          <SkeletonGroup className="flex flex-col gap-3 py-2">
            {[0, 1, 2].map((i) => (
              <div key={i} aria-hidden="true">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="mt-2 h-3 w-3/4" />
              </div>
            ))}
          </SkeletonGroup>
        ) : (
          <>
            <Current history={data} lang={l} />
            <h3 className="mt-3 text-[12.5px] font-semibold text-text-muted">{s.historyActions}</h3>
            {data.actions.length === 0 ? (
              <p className="py-3 text-[13px] text-text-secondary" data-history-empty>
                {s.historyEmpty}
              </p>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {data.actions.map((a) => (
                  <HistoryRow key={a.id} a={a} lang={l} />
                ))}
              </ul>
            )}
            {data.audit.length > 0 && (
              <>
                <h3 className="mt-4 text-[12.5px] font-semibold text-text-muted">{s.historyAudit}</h3>
                <ul className="divide-y divide-border-subtle" data-history-audit>
                  {data.audit.map((r) => (
                    <li key={r.id} className="py-2.5 text-[12.5px]">
                      <p className="text-text-primary">{s.auditActions[r.action] ?? r.action}</p>
                      <p className="mt-0.5 text-[11.5px] text-text-muted">
                        {deskDate(r.created_at, l, true)}
                        {r.actor && ` · ${s.by(r.actor.name)}`}
                      </p>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
