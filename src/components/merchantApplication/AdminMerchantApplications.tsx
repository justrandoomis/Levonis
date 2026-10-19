import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, BadgeCheck, Clock, Eye, EyeOff, RefreshCw, ShieldCheck, Store, UserX } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import { Overlay } from '../ui/Overlay';
import { apiRefusal, refusalLang } from '../../lib/refusalStrings';
import { GOVERNORATES } from '../../lib/governorates';
import {
  newOperationId,
  reviewApi,
  type ReviewAction,
  type ReviewDetail,
  type ReviewQueueRow,
} from '../../lib/merchantApplication';
import { REVIEWER_STRINGS } from './reviewerStrings';
// The owner's list of who reviews, and an assistant's MERCHANT_REVIEW grant (owner decision C5) —
// one component for the three desks a grant opens (DECISIONS row 261).
import { ReviewerGrants } from '../adminScope/CapabilityGrants';

/**
 * «طلبات اعتماد التجار» — Admin → الإدارة (Community V3 push 1.2, DECISIONS
 * row 257). Modelled on AdminKyc.tsx: a queue, an audited detail in a solid
 * Overlay, a protected <img> for the review photo, and the four reviewer
 * moves — start review, request changes, approve, reject — each with a public
 * reason (the applicant reads it) and an internal note (reviewers only). An
 * APPROVED application whose owner has opened no store yet offers one more:
 * «سحب الاعتماد» (the server's 'reject' from 'approved'), with the same
 * reason and an inline confirmation; once a store exists the server refuses
 * it and the sanction is suspension, in community administration.
 *
 * THE SERVER DECIDES, THE SCREEN WAITS. No decision is drawn before the server
 * answers: the buttons go quiet, «بانتظار ردّ الخادم…» shows, and the state on
 * screen is the one the answer carries (then the detail and the queue are read
 * again). A refusal — another reviewer was faster, the applicant edited, your
 * own application — is shown in the reviewer's language and nothing changes.
 *
 * Each tap carries the revision the reviewer is looking at and an operation id
 * minted when the decision area opened: a double tap or a retried request is
 * applied once.
 *
 * The tab itself is a hint (`can_review_merchants === true`, src/pages/Admin.tsx);
 * every request here is checked again by the server. The owner also sees who
 * reviews, and grants or revokes an assistant's access (owner decision C5).
 */

const FILTERS = ['queue', 'all', 'changes_requested', 'approved', 'rejected', 'withdrawn'] as const;
type Filter = (typeof FILTERS)[number];

const STATE_STYLE: Record<string, string> = {
  draft: 'bg-white/[0.06] text-text-secondary',
  submitted: 'lv-chip [--chip:var(--color-info)]',
  in_review: 'lv-chip [--chip:var(--color-warning)]',
  changes_requested: 'lv-chip [--chip:var(--color-warning)]',
  approved: 'lv-chip [--chip:var(--color-success)]',
  rejected: 'lv-chip [--chip:var(--color-danger)] [--chip-ink:var(--color-error-ink)]',
  withdrawn: 'bg-white/[0.06] text-text-secondary',
};

type Confirming = null | 'approve' | 'reject' | 'revoke';

export default function AdminMerchantApplications() {
  const { lang } = useLanguage();
  const { user } = useAuth();
  const t = REVIEWER_STRINGS[lang] ?? REVIEWER_STRINGS.ar;
  const rl = refusalLang(lang);

  const [filter, setFilter] = useState<Filter>('queue');
  const [rows, setRows] = useState<ReviewQueueRow[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  // The latch AdminKyc explains: the window keeps its last case for the length of its exit spring.
  const lastDetail = useRef<ReviewDetail | null>(null);
  if (detail) lastDetail.current = detail;
  const shown = detail ?? lastDetail.current;

  const [showPhoto, setShowPhoto] = useState(false);
  const [reasonPublic, setReasonPublic] = useState('');
  const [noteInternal, setNoteInternal] = useState('');
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  /** One operation id per decision area opened on one revision: a retry of the same move reuses it. */
  const operation = useRef<{ key: string; id: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await reviewApi.list(filter);
      setAvailable(data.available);
      setRows(data.applications);
    } catch (err) {
      setLoadError(apiRefusal(err, rl, t.loadError));
    } finally {
      setLoading(false);
    }
  }, [filter, rl, t.loadError]);

  useEffect(() => {
    void load();
  }, [load]);

  const resetDecisionArea = () => {
    setReasonPublic('');
    setNoteInternal('');
    setConfirming(null);
    setNotice('');
    operation.current = null;
  };

  const openApplication = async (id: string) => {
    setActionError('');
    setShowPhoto(false);
    resetDecisionArea();
    try {
      const data = await reviewApi.detail(id);
      setDetail(data.application);
    } catch (err) {
      setActionError(apiRefusal(err, rl, t.actionError));
    }
  };

  const operationFor = (app: ReviewDetail, action: ReviewAction): string => {
    // The state is part of the key: a reject on a review and a revoke of an approval are two moves.
    const key = `${app.id}:${app.revision}:${app.state}:${action}`;
    if (operation.current?.key !== key) operation.current = { key, id: newOperationId() };
    return operation.current.id;
  };

  const decide = async (move: ReviewAction | 'revoke') => {
    const app = detail;
    if (!app || busy) return;
    // Revoking an approval is the server's 'reject' from 'approved', SAID as a revoke: a late reject never revokes.
    const revoke = move === 'revoke';
    const action: ReviewAction = revoke ? 'reject' : move;
    setActionError('');
    setNotice('');
    const reason = reasonPublic.trim();
    if ((action === 'request-changes' || action === 'reject') && reason.length < 5) {
      setActionError(t.reasonRequired);
      return;
    }
    setBusy(true);
    try {
      const res = await reviewApi.decide(app.id, action, {
        revision: app.revision,
        operation_id: operationFor(app, action),
        ...(action === 'start-review' ? {} : { reason_public: reason, note_internal: noteInternal.trim() }),
        ...(revoke ? { revoke: true as const } : {}),
      });
      // The SERVER's state, never an assumed one.
      resetDecisionArea();
      setNotice(`${t.decided}: ${t.states[res.application.state] ?? res.application.state}`);
      const fresh = await reviewApi.detail(app.id);
      setDetail(fresh.application);
      void load();
    } catch (err) {
      setActionError(apiRefusal(err, rl, t.actionError));
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  };

  const chip = (state: string) => (
    <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold ${STATE_STYLE[state] ?? STATE_STYLE.draft}`}>
      {t.states[state as keyof typeof t.states] ?? state}
    </span>
  );
  const governorateName = (id: string) => {
    const g = GOVERNORATES.find((x) => x.id === id);
    if (!g) return id || '—';
    return lang === 'ar' ? g.ar : lang === 'ckb' ? g.ckb : g.en;
  };
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

  const canStart = shown?.state === 'submitted';
  const canDecide = shown?.state === 'in_review';
  // Revoking an approval is a 'reject' from 'approved', offered only while no store exists (the server re-checks).
  const canRevoke = shown?.state === 'approved' && shown.has_store === false;
  const needsReason = canDecide || canRevoke;

  return (
    <div className="max-w-4xl" data-admin-merchant-applications>
      <div className="flex items-center justify-between gap-2 mb-2">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Store className="w-5 h-5 text-gold" /> {t.title}
        </h2>
        <button onClick={() => void load()} className="lv-button lv-button-secondary lv-button-sm">
          <RefreshCw className="w-3.5 h-3.5" /> {t.refresh}
        </button>
      </div>
      <p className="text-[12px] text-text-muted mb-4 leading-relaxed">{t.subtitle}</p>

      <div className="flex gap-1.5 mb-4 flex-wrap" role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded-full text-[12px] font-bold border ${
              filter === f
                ? 'border-transparent bg-[var(--clay-well-bg)] text-text-primary shadow-press'
                : 'border-border-subtle bg-surface-raised text-text-secondary shadow-xs hover:text-text-primary'
            }`}
          >
            {t.filters[f]}
          </button>
        ))}
      </div>

      {actionError && !detail && <div className="lv-alert lv-alert-danger text-[13px] text-text-primary mb-4">{actionError}</div>}
      {loadError && <div className="lv-alert lv-alert-danger text-[13px] text-text-primary mb-4">{loadError}</div>}

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="w-7 h-7 border-2 border-gold/20 border-t-gold rounded-full animate-spin" />
        </div>
      ) : !available ? (
        <p className="text-text-muted text-sm text-center py-10">{t.unavailable}</p>
      ) : rows.length === 0 ? (
        <p className="text-text-muted text-sm text-center py-10">{t.empty}</p>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="lv-surface p-4" data-application-row={r.state}>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="min-w-0">
                  <p className="font-bold text-[14px] truncate">{r.public.name || '—'}</p>
                  <p className="text-[12px] text-text-muted">
                    {t.kinds[r.review.activity_kind] ?? r.review.activity_kind} · {governorateName(r.review.governorate)} · {t.revision}{' '}
                    {r.revision} · {t.submittedAt} {when(r.submitted_at)}
                  </p>
                  {r.own && <p className="text-[11px] text-warning mt-1">{t.own}</p>}
                </div>
                <div className="flex items-center gap-2">
                  {chip(r.state)}
                  <button onClick={() => void openApplication(r.id)} className="lv-button lv-button-secondary lv-button-sm">
                    <Eye className="w-3.5 h-3.5" /> {t.open}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {user?.is_owner === true && <ReviewerGrants />}

      {shown && (
        <Overlay
          open={!!detail}
          onClose={() => setDetail(null)}
          label={t.title}
          placement="bottom"
          z={60}
          solid
          testId="merchant-application-detail"
          panelClassName={`w-full max-w-xl max-h-[88dvh] overflow-y-auto bg-canvas border border-border-subtle${detail ? '' : ' pointer-events-none'}`}
        >
          <div className="p-5 space-y-4 text-[13px]">
            <div className="flex items-center justify-between gap-2">
              <p className="font-bold text-[15px]">{shown.public.name || '—'}</p>
              {chip(shown.state)}
            </div>
            <p className="text-[11px] text-warning flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {t.auditWarn}
            </p>
            {shown.own && <p className="lv-alert lv-alert-danger text-[12px] text-text-primary">{t.own}</p>}

            <section>
              <p className="text-text-secondary text-[12px] font-bold mb-2">{t.privateSection}</p>
              {shown.purged ? (
                <p className="text-text-muted">{t.purged}</p>
              ) : (
                <div className="space-y-1.5">
                  {!shown.private.readable && <p className="lv-alert lv-alert-danger text-[12px] text-text-primary">{t.unreadable}</p>}
                  <p>
                    <span className="text-text-muted">{t.legalName}:</span>{' '}
                    <span className="font-bold">
                      {shown.private.legal_name
                        ? `${shown.private.legal_name.given} · ${shown.private.legal_name.father} · ${shown.private.legal_name.grandfather}`
                        : '—'}
                    </span>
                  </p>
                  <p>
                    <span className="text-text-muted">{t.dob}:</span> <span dir="ltr">{shown.private.dob ?? '—'}</span>
                    {shown.private.age !== null && (
                      <span className="text-text-muted">
                        {' '}
                        ({t.age} {shown.private.age} {t.years})
                      </span>
                    )}
                  </p>
                  <p className="break-all">
                    <span className="text-text-muted">{t.socialLink}:</span>{' '}
                    {shown.private.social_link ? (
                      <a href={shown.private.social_link} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" dir="ltr" className="text-gold underline">
                        {shown.private.social_link}
                      </a>
                    ) : (
                      '—'
                    )}
                  </p>
                  <div className="pt-1">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-text-secondary text-[12px] font-bold">{t.photo}</p>
                      {shown.private.has_photo && (
                        <button onClick={() => setShowPhoto((v) => !v)} className="lv-button lv-button-secondary lv-button-sm">
                          {showPhoto ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          {showPhoto ? t.hidePhoto : t.showPhoto}
                        </button>
                      )}
                    </div>
                    {!shown.private.has_photo && <p className="text-text-muted">{t.noPhoto}</p>}
                    {showPhoto && shown.private.has_photo && (
                      // Same-origin, cookie-authenticated, no-store and audited by the server per view.
                      <img
                        src={reviewApi.photoUrl(shown.id)}
                        alt={t.photo}
                        referrerPolicy="no-referrer"
                        className="w-full max-w-xs rounded-xl border border-border-subtle"
                      />
                    )}
                  </div>
                </div>
              )}
            </section>

            <section>
              <p className="text-text-secondary text-[12px] font-bold mb-2">{t.checks}</p>
              <p className="flex items-center gap-1.5" data-pro-identity={shown.checks.pro_identity_verified ? 'yes' : 'no'}>
                <BadgeCheck className="w-4 h-4 text-text-muted" /> {t.proIdentity}: <span className="font-bold">{shown.checks.pro_identity_verified ? t.yes : t.no}</span>
              </p>
              <p className="flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-text-muted" /> {t.phoneVerified}: <span className="font-bold">{shown.checks.phone_verified ? t.yes : t.no}</span>
              </p>
              <p className="text-text-muted mt-1">
                {t.applicant}: <span dir="ltr">{shown.applicant.username ? `@${shown.applicant.username}` : shown.applicant.id}</span>
              </p>
            </section>

            <section>
              <p className="text-text-secondary text-[12px] font-bold mb-2">{t.reviewSection}</p>
              <p><span className="text-text-muted">{t.governorate}:</span> {governorateName(shown.review.governorate)}</p>
              <p><span className="text-text-muted">{t.activityKind}:</span> {t.kinds[shown.review.activity_kind] ?? shown.review.activity_kind}</p>
              {shown.review.activity_description && (
                <p className="whitespace-pre-line"><span className="text-text-muted">{t.activityDescription}:</span> {shown.review.activity_description}</p>
              )}
            </section>

            <section>
              <p className="text-text-secondary text-[12px] font-bold mb-2">{t.publicSection}</p>
              <p><span className="text-text-muted">{t.publicName}:</span> {shown.public.name || '—'}</p>
              {shown.public.bio && <p className="whitespace-pre-line"><span className="text-text-muted">{t.publicBio}:</span> {shown.public.bio}</p>}
              {shown.public.links.length > 0 && (
                <p className="break-all" dir="ltr">
                  {shown.public.links.join(' · ')}
                </p>
              )}
            </section>

            {(shown.reason_public || shown.note_internal) && (
              <section className="space-y-1">
                {shown.reason_public && <p className="text-warning"><span className="font-bold">{t.lastReason}:</span> {shown.reason_public}</p>}
                {shown.note_internal && <p className="text-text-secondary"><span className="font-bold">{t.lastNote}:</span> {shown.note_internal}</p>}
              </section>
            )}

            {shown.events.length > 0 && (
              <section>
                <p className="text-text-secondary text-[12px] font-bold mb-2">{t.history}</p>
                <ol className="space-y-1 text-[12px] text-text-muted">
                  {shown.events.map((e, i) => (
                    <li key={`${e.at}-${i}`}>
                      {when(e.at)} · {t.actions[e.action] ?? e.action} · {t.actors[e.actor_kind] ?? e.actor_kind} · {t.revision} {e.revision}
                      {e.reason_public ? ` — ${e.reason_public}` : ''}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {notice && <p className="lv-alert text-[12.5px] text-text-primary" role="status">{notice}</p>}
            {actionError && detail && <p className="lv-alert lv-alert-danger text-[12.5px] text-text-primary" role="alert">{actionError}</p>}

            {(canStart || canDecide || canRevoke) && !shown.own && (
              <section className="border-t border-border-subtle pt-4" data-decision-area>
                <p className="text-[12px] font-bold text-text-secondary mb-2">{t.decisions}</p>
                {canRevoke && <p className="text-[12px] text-text-muted mb-3 leading-relaxed">{t.revokeApprovalHint}</p>}
                {needsReason && (
                  <div className="space-y-3 mb-3">
                    <label className="block">
                      <span className="block text-[12px] text-text-secondary mb-1">{t.reasonPublic}</span>
                      <textarea
                        className="lv-input px-3 py-2 text-[13px] resize-none"
                        rows={3}
                        maxLength={1000}
                        value={reasonPublic}
                        onChange={(e) => setReasonPublic(e.target.value)}
                        disabled={busy}
                      />
                      <span className="block text-[11px] text-text-muted mt-1">{t.reasonPublicHint}</span>
                    </label>
                    <label className="block">
                      <span className="block text-[12px] text-text-secondary mb-1">{t.noteInternal}</span>
                      <textarea
                        className="lv-input px-3 py-2 text-[13px] resize-none"
                        rows={2}
                        maxLength={2000}
                        value={noteInternal}
                        onChange={(e) => setNoteInternal(e.target.value)}
                        disabled={busy}
                      />
                    </label>
                  </div>
                )}
                {busy ? (
                  <p className="text-text-muted text-[12.5px]" role="status" aria-live="polite">{t.waiting}</p>
                ) : confirming ? (
                  <div className="space-y-2">
                    <p className="text-[12.5px] text-text-primary">
                      {confirming === 'approve' ? t.approveConfirm : confirming === 'revoke' ? t.revokeApprovalConfirm : t.rejectConfirm}
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => void decide(confirming)}
                        className={`lv-button lv-button-sm ${confirming === 'approve' ? 'lv-button-primary' : 'lv-button-danger'}`}
                      >
                        {t.confirm}
                      </button>
                      <button onClick={() => setConfirming(null)} className="lv-button lv-button-secondary lv-button-sm">
                        {t.cancel}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2 flex-wrap">
                    {canStart && (
                      <button onClick={() => void decide('start-review')} className="lv-button lv-button-secondary lv-button-sm">
                        <Clock className="w-4 h-4" /> {t.startReview}
                      </button>
                    )}
                    {canDecide && (
                      <>
                        <button onClick={() => void decide('request-changes')} className="lv-button lv-button-accent lv-button-sm">
                          {t.requestChanges}
                        </button>
                        <button onClick={() => setConfirming('reject')} className="lv-button lv-button-danger lv-button-sm">
                          {t.reject}
                        </button>
                        <button onClick={() => setConfirming('approve')} className="lv-button lv-button-primary lv-button-sm">
                          <ShieldCheck className="w-4 h-4" /> {t.approve}
                        </button>
                      </>
                    )}
                    {canRevoke && (
                      <button onClick={() => setConfirming('revoke')} className="lv-button lv-button-danger lv-button-sm" data-revoke-approval>
                        <UserX className="w-4 h-4" /> {t.revokeApproval}
                      </button>
                    )}
                  </div>
                )}
              </section>
            )}

            <button onClick={() => setDetail(null)} className="lv-button lv-button-secondary w-full">
              {t.close}
            </button>
          </div>
        </Overlay>
      )}
    </div>
  );
}
