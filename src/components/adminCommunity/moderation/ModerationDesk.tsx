/**
 * «الإشراف» — THE MODERATION DESK (docs/COMMUNITY_ECOSYSTEM.md §9.6 Moderation
 * V2; the doors are worker/routes/adminModeration.ts, typed in ./api.ts).
 * A section of the community admin (../AdminCommunity.tsx), beside the
 * disputes, and a lazy chunk of it: only staff who open it download it.
 *
 * TWO QUEUES.
 *
 *   البلاغات   the reports, newest first, filtered by state (open by default)
 *              and by what they name. Each shows the thing reported as the
 *              desk needs to judge it (./TargetPreview.tsx), who reported it,
 *              how many reports that same thing has drawn and how many are
 *              still open, and the decisions it allows:
 *                · hide / show a post, a comment, a request comment;
 *                · a step of the account ladder on the person behind it —
 *                  تنبيه → تقييد → تعليق → حظر, and «استعادة» back; a step
 *                  lighter than the one in force is disabled with the reason
 *                  (the server's MODERATION_LADDER answers the same), staff
 *                  accounts have none;
 *                · «رُوجع» / «رفض البلاغ» for the report itself;
 *                · «السجل»: the target's history (./AuditTrail.tsx).
 *              A decision taken from a report carries its `report_id`, and the
 *              server marks the report actioned in the same batch.
 *   الاعتراضات the appeals (./AppealsQueue.tsx).
 *
 * EVERY DECISION IS ASKED ONCE (./DecisionSheet.tsx): the consequence, the
 * reason the person will read, the end date for a restriction or a
 * suspension, and — for a sanction — a ConfirmDialog naming the account. The
 * server records it three ways and tells the person; the queue is read again
 * after it, so what the desk sees is what is true.
 */
import { useCallback, useEffect, useState } from 'react';
import { CheckCheck, ChevronDown, EyeOff, Eye, History, ShieldAlert, XCircle } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { apiRefusal } from '../../../lib/refusalStrings';
import { Button } from '../../ui/Button';
import { StatusChip } from '../../ui/Badge';
import { EmptyState, ErrorState } from '../../ui/AsyncStates';
import { Select } from '../../ui/Field';
import { Menu, type MenuEntry } from '../../ui/Menu';
import { Segmented } from '../../ui/Segmented';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { toast } from '../../ui/Toast';
import {
  LADDER_STEPS,
  REPORT_KINDS,
  moderationDeskApi,
  type LadderStep,
  type ModerationTargetType,
  type PersonRef,
  type RenderedTarget,
  type ReportKind,
  type ReportRow,
  type ReportState,
  type UserStatus,
} from './api';
import AppealsQueue from './AppealsQueue';
import AuditTrail, { type AuditTarget } from './AuditTrail';
import DecisionSheet, { type DecisionRequest } from './DecisionSheet';
import TargetPreview from './TargetPreview';
import { deskDate, deskLang, deskStrings, type DeskLang, type DeskStrings } from './strings';

type View = 'reports' | 'appeals';
type StateFilter = ReportState | 'all';
/** The report states the queue filters by, the open ones first (the default). */
const REPORT_STATE_FILTERS = ['open', 'reviewed', 'actioned', 'dismissed', 'all'] as const;

// ------------------------------------------------------------ the rules the row draws

/** The kinds whose content the desk hides and shows. */
const HIDEABLE: readonly ReportKind[] = ['post', 'comment', 'request_comment'];

/** A person behind a report's target — whom the account ladder is about — and in which role. */
export interface LadderPerson {
  id: string;
  name: string;
  status?: UserStatus;
  staff?: boolean;
  role: keyof DeskStrings['roles'];
}

export function personOf(t: RenderedTarget): LadderPerson | null {
  if (!t.exists) return null;
  const from = (p: PersonRef | null | undefined, role: LadderPerson['role']): LadderPerson | null =>
    p?.id ? { id: p.id, name: p.name || p.username || p.id, status: p.status, role } : null;
  switch (t.kind) {
    case 'post':
    case 'comment':
    case 'request_comment':
    case 'order_update':
      return from(t.author, 'author');
    case 'user':
      return { id: t.id, name: t.name || t.username || t.id, status: t.status, staff: !!t.staff, role: 'account' };
    case 'store':
      return t.owner_id ? { id: t.owner_id, name: t.name || t.owner_id, role: 'owner' } : null;
    case 'request':
      return t.customer?.id ? { id: t.customer.id, name: t.customer.name || t.customer.id, role: 'customer' } : null;
    default:
      return null;
  }
}

/** Whether the content is hidden now — the verb the row offers is the other one. */
export function isHidden(t: RenderedTarget): boolean | null {
  if (!t.exists) return null;
  if (t.kind === 'post') return !!t.hidden;
  if (t.kind === 'comment' || t.kind === 'request_comment') return t.state === 'hidden' ? true : t.state === 'visible' ? false : null;
  return null;
}

/**
 * Which ladder steps a standing allows. A step lighter than the one in force
 * is refused by the server (409 MODERATION_LADDER) — the menu says so before
 * it is asked; `restore` needs something to lift. Unknown standing: all open.
 */
export function stepAllowed(step: LadderStep, status: UserStatus | undefined): boolean {
  if (!status) return true;
  if (step === 'restore') return status !== 'active';
  if (step === 'restrict') return status === 'active' || status === 'restricted';
  if (step === 'suspend') return status !== 'banned';
  return true;
}

/** What `history` reads for a report's target (an order update has no history of its own: its author's). */
export function historyTarget(t: RenderedTarget, s: DeskStrings): AuditTarget | null {
  const label = (x: string | null | undefined) => (x ?? '').slice(0, 80);
  switch (t.kind) {
    case 'post':
      return { type: 'post', id: t.id, label: label(t.card?.title) || s.kinds.post };
    case 'comment':
    case 'request_comment':
      return { type: t.kind, id: t.id, label: label(t.body) || s.kinds[t.kind] };
    case 'user':
      return { type: 'user', id: t.id, label: t.name || t.username || t.id };
    case 'store':
    case 'product':
    case 'request': {
      const name = t.kind === 'request' ? t.title : t.name;
      return { type: t.kind as ModerationTargetType, id: t.id, label: label(name) || s.kinds[t.kind] };
    }
    case 'order_update':
      return t.author?.id ? { type: 'user', id: t.author.id, label: t.author.name } : null;
  }
}

// ------------------------------------------------------------ one report

export interface ReportActions {
  hide: (r: ReportRow, hidden: boolean) => void;
  step: (r: ReportRow, person: LadderPerson, step: LadderStep) => void;
  decide: (r: ReportRow, state: 'reviewed' | 'dismissed') => void;
  history: (t: AuditTarget) => void;
}

export function ReportCard({ report: r, lang, act }: { report: ReportRow; lang: DeskLang; act?: ReportActions }) {
  const s = deskStrings(lang);
  const t = r.target;
  const person = personOf(t);
  const hidden = HIDEABLE.includes(t.kind) ? isHidden(t) : null;
  const history = historyTarget(t, s);
  const decided = r.state === 'actioned' || r.state === 'dismissed';
  const ladder: MenuEntry[] = person
    ? LADDER_STEPS.map((step) => {
        const allowed = stepAllowed(step, person.status);
        return {
          id: step,
          label: s.steps[step],
          destructive: step === 'suspend' || step === 'ban',
          disabled: !allowed,
          hint: allowed ? undefined : step === 'restore' ? s.statuses.active : s.lighter,
          onSelect: () => act?.step(r, person, step),
        };
      })
    : [];
  return (
    <li className="lv-surface p-4" data-report={r.id} data-report-kind={t.kind} data-report-state={r.state}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusChip tone={r.state === 'open' ? 'warning' : r.state === 'actioned' ? 'success' : 'neutral'}>{s.reportStates[r.state]}</StatusChip>
        <span className="text-[13px] font-bold text-text-primary">{s.reasons[r.reason] ?? r.reason}</span>
        <span className="text-[12px] text-text-muted">· {s.kinds[t.kind]}</span>
      </div>
      <p className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[12px] text-text-muted">
        <span>
          {s.reporter} <bdi className="text-text-secondary">{r.reporter.name || r.reporter.username || r.reporter.id}</bdi>
        </span>
        <span>· {deskDate(r.created_at, lang, true)}</span>
        <span data-report-count={`${r.reports_on_target}/${r.open_on_target}`}>· {s.onTarget(r.reports_on_target, r.open_on_target)}</span>
      </p>
      {r.details && (
        <p dir="auto" className="mt-2 text-[12.5px] leading-relaxed text-text-secondary">
          <span className="text-text-muted">{s.details}</span> {r.details}
        </p>
      )}
      <div className="mt-3">
        <TargetPreview target={t} lang={lang} />
      </div>
      {r.resolution && decided && (
        <p dir="auto" className="mt-2 text-[12.5px] text-text-secondary">
          <span className="text-text-muted">{s.resolution}</span> {r.resolution}
        </p>
      )}
      {act && (
        <div className="mt-3 flex flex-col gap-1.5" data-report-actions>
          {/* THE DECISIONS ON THE CONTENT AND ITS PERSON, then the report's own
              and its history as quieter controls — two rows on a phone. */}
          {(hidden !== null || person) && (
            <div className="flex flex-wrap items-center gap-2">
              {hidden !== null && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={hidden ? <Eye aria-hidden="true" className="h-4 w-4" /> : <EyeOff aria-hidden="true" className="h-4 w-4" />}
                  onClick={() => act.hide(r, !hidden)}
                  data-report-hide={hidden ? 'show' : 'hide'}
                >
                  {hidden ? s.unhide : s.hide}
                </Button>
              )}
              {person && !person.staff && (
                <Menu
                  label={`${s.accountAction} — ${person.name}`}
                  items={ladder}
                  trigger={(props) => (
                    <Button {...props} variant="secondary" size="sm" icon={<ShieldAlert aria-hidden="true" className="h-4 w-4" />} iconEnd={<ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />} data-report-ladder={person.id}>
                      {s.accountAction}
                    </Button>
                  )}
                />
              )}
              {person?.staff && <span className="text-[12px] text-text-muted">{s.staffTarget}</span>}
            </div>
          )}
          <div className="-ms-2 flex flex-wrap items-center gap-1">
            {r.state === 'open' && (
              <Button variant="ghost" size="sm" icon={<CheckCheck aria-hidden="true" className="h-4 w-4" />} onClick={() => act.decide(r, 'reviewed')} data-report-decide="reviewed">
                {s.markReviewed}
              </Button>
            )}
            {!decided && (
              <Button variant="ghost" size="sm" icon={<XCircle aria-hidden="true" className="h-4 w-4" />} onClick={() => act.decide(r, 'dismissed')} data-report-decide="dismissed">
                {s.dismiss}
              </Button>
            )}
            {history && (
              <Button variant="ghost" size="sm" icon={<History aria-hidden="true" className="h-4 w-4" />} onClick={() => act.history(history)} data-report-history>
                {s.history}
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------ the decisions a report allows

/** A refusal, in the refusal table's words, for the sheet to show. */
const refusal = (e: unknown, l: DeskLang, s: DeskStrings) => new Error(apiRefusal(e, l, s.failed));

/** Hide (or show again) the post, comment or request comment a report names; the report is actioned with it. */
export function hideRequest(r: ReportRow, hide: boolean, s: DeskStrings, l: DeskLang, onDone: () => void): DecisionRequest {
  return {
    title: hide ? s.hideTitle : s.unhideTitle,
    consequence: hide ? s.hideConsequence : s.unhideConsequence,
    confirmLabel: hide ? s.hide : s.unhide,
    reason: hide ? 'required' : 'optional',
    onSubmit: async ({ reason }) => {
      const input = { hidden: hide, reason, report_id: r.id };
      try {
        const t = r.target;
        const res =
          t.kind === 'post'
            ? await moderationDeskApi.hidePost(t.id, input)
            : t.kind === 'comment'
              ? await moderationDeskApi.hideComment(t.id, input)
              : await moderationDeskApi.hideRequestComment(t.id, input);
        toast.success(res.replayed ? s.done.replayed : hide ? s.done.hidden : s.done.unhidden);
        onDone();
      } catch (e) {
        throw refusal(e, l, s);
      }
    },
  };
}

/**
 * A STEP OF THE LADDER on the person behind a report — asked with the reason
 * they will read, the end date for a restriction or a suspension, and a
 * ConfirmDialog naming the account (destructive for a suspension or a ban).
 */
export function stepRequest(r: ReportRow, person: LadderPerson, step: LadderStep, s: DeskStrings, l: DeskLang, onDone: () => void): DecisionRequest {
  return {
    title: `${s.steps[step]} — ${person.name}`,
    consequence: s.consequence[step],
    confirmLabel: s.steps[step],
    destructive: step === 'suspend' || step === 'ban',
    reason: step === 'restore' ? 'optional' : 'required',
    until: step === 'restrict' || step === 'suspend',
    confirm: { title: s.confirmTitle[step](person.name), consequence: s.consequence[step] },
    onSubmit: async ({ reason, until }) => {
      try {
        const res = await moderationDeskApi.setStatus(person.id, { status: step, reason, until, report_id: r.id });
        const store = step === 'ban' && res.store?.status === 'suspended' ? ` ${s.done.storeSuspended}` : step === 'restore' && res.store ? ` ${s.done.storeKept}` : '';
        toast.success(res.replayed ? s.done.replayed : `${s.done.status(step, person.name)}${store}`);
        onDone();
      } catch (e) {
        throw refusal(e, l, s);
      }
    },
  };
}

/** «رُوجع» / «رفض البلاغ»: the report itself, with an optional note. */
export function reportRequest(r: ReportRow, next: 'reviewed' | 'dismissed', s: DeskStrings, l: DeskLang, onDone: () => void): DecisionRequest {
  return {
    title: next === 'reviewed' ? s.reviewTitle : s.dismissTitle,
    consequence: next === 'reviewed' ? s.reviewConsequence : s.dismissConsequence,
    confirmLabel: next === 'reviewed' ? s.markReviewed : s.dismiss,
    reason: 'optional',
    onSubmit: async ({ reason }) => {
      try {
        const res = await moderationDeskApi.decideReport(r.id, next, reason);
        toast.success(res.replayed ? s.done.replayed : s.done.report);
        onDone();
      } catch (e) {
        throw refusal(e, l, s);
      }
    },
  };
}

// ------------------------------------------------------------ the reports queue

function ReportsQueue({ onDecision, onHistory }: { onDecision: (r: DecisionRequest) => void; onHistory: (t: AuditTarget) => void }) {
  const { lang } = useLanguage();
  const l = deskLang(lang);
  const s = deskStrings(l);
  const [state, setState] = useState<StateFilter>('open');
  const [type, setType] = useState<ReportKind | ''>('');
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState(false);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setError(null);
    moderationDeskApi
      .reports({ state, type: type || undefined })
      .then((p) => {
        if (!alive) return;
        setRows(p.reports);
        setNext(p.next);
      })
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [state, type, nonce]);

  // A new filter is a new list: the old rows leave at once rather than lingering under the new name.
  useEffect(() => setRows(null), [state, type]);

  const loadMore = async () => {
    if (!next || more) return;
    setMore(true);
    try {
      const p = await moderationDeskApi.reports({ state, type: type || undefined }, next);
      setRows((r) => [...(r ?? []), ...p.reports]);
      setNext(p.next);
    } catch {
      toast.error(s.loadFailed);
    } finally {
      setMore(false);
    }
  };

  const act: ReportActions = {
    hide: (r, hide) => onDecision(hideRequest(r, hide, s, l, reload)),
    step: (r, person, step) => onDecision(stepRequest(r, person, step, s, l, reload)),
    decide: (r, next) => onDecision(reportRequest(r, next, s, l, reload)),
    history: onHistory,
  };

  return (
    <div className="flex flex-col gap-3" data-reports-queue>
      {/* TWO POP-UP FILTERS, not a segmented row: the states' names run long
          in English and Sorani («پێداچوونەوەی بۆ کرا»), and five equal columns
          would cut them on a phone. Side by side on a phone, at the end of the
          row from `sm` up. */}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end sm:gap-3" data-reports-filters>
        <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-text-muted sm:flex-row sm:items-center sm:gap-2">
          <span className="truncate">{s.stateLabel}</span>
          <Select value={state} onChange={(e) => setState(e.target.value as StateFilter)} className="h-9 w-full sm:w-48" data-reports-state>
            {REPORT_STATE_FILTERS.map((id) => (
              <option key={id} value={id}>
                {s.reportStates[id]}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-text-muted sm:flex-row sm:items-center sm:gap-2">
          <span className="truncate">{s.typeLabel}</span>
          <Select value={type} onChange={(e) => setType(e.target.value as ReportKind | '')} className="h-9 w-full sm:w-48" data-reports-type>
            <option value="">{s.anyType}</option>
            {REPORT_KINDS.map((k) => (
              <option key={k} value={k}>
                {s.kinds[k]}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {error && !rows ? (
        <ErrorState error={error} onRetry={reload} compact />
      ) : !rows ? (
        <SkeletonGroup className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} aria-hidden="true" className="lv-surface p-4">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="mt-2 h-3 w-1/2" />
              <Skeleton className="mt-3 h-20 w-full" />
            </div>
          ))}
        </SkeletonGroup>
      ) : rows.length === 0 ? (
        <EmptyState title={s.empty} compact />
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((r) => (
            <ReportCard key={r.id} report={r} lang={l} act={act} />
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

// ------------------------------------------------------------ the desk

export default function ModerationDesk() {
  const { lang } = useLanguage();
  const s = deskStrings(deskLang(lang));
  const [view, setView] = useState<View>('reports');
  const [decision, setDecision] = useState<DecisionRequest | null>(null);
  const [history, setHistory] = useState<AuditTarget | null>(null);

  return (
    <section className="flex flex-col gap-4 text-text-primary" data-moderation-desk aria-labelledby="moderation-desk-title">
      <header>
        <h2 id="moderation-desk-title" className="text-[17px] font-bold">
          {s.title}
        </h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-text-muted">{s.intro}</p>
      </header>
      <Segmented
        group="moderation-view"
        label={s.viewsLabel}
        value={view}
        onChange={(v) => setView(v as View)}
        dataAttr="data-moderation-view"
        items={[
          { id: 'reports', label: s.views.reports },
          { id: 'appeals', label: s.views.appeals },
        ]}
        className="w-full max-w-sm"
      />
      {view === 'reports' ? <ReportsQueue onDecision={setDecision} onHistory={setHistory} /> : <AppealsQueue onDecision={setDecision} onHistory={setHistory} />}
      <DecisionSheet request={decision} onClose={() => setDecision(null)} />
      <AuditTrail target={history} onClose={() => setHistory(null)} />
    </section>
  );
}
