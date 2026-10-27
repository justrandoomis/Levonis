/**
 * «المراجعة والاعتماد» — the review workflow of one design (spec §22, §25).
 *
 * The state shown here is the SERVER's, re-read whenever the version moves
 * (an autosave that changes an approved design sends it back to draft on the
 * server; the editor's own copy of the metadata would be stale). Every action
 * is version-fenced and its answer replaces what is shown:
 *   - send for review / back to draft / archive  → POST …/status
 *   - approve one version                       → POST …/approve, only with a
 *     final export of THAT version, after re-verifying the bound data now
 *   - reject with reasons                       → POST …/reject (stored as
 *     feedback with the reasons)
 * Nothing here claims an outcome the server did not confirm.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../ui/Button';
import { Textarea } from '../../ui/Field';
import type { DocumentDto, ExportDto, RejectReason, ReviewDto } from '../../../../packages/creativeDoc/src/api';
import { documents } from '../client';
import type { EditorApi } from '../editorApi';
import { REJECT_TEXT, S, STATUS_TEXT, fill } from '../strings';
import { failText, shortTime, useText } from '../shared';
import { reportFor, verifyAll } from './QaPanel';

const REASONS: RejectReason[] = ['product_small', 'crowded', 'text_long', 'background_off', 'wrong_variant_image', 'unclear', 'other'];

interface ServerState {
  doc: DocumentDto;
  reviews: ReviewDto[];
  exports: ExportDto[];
}

export default function ReviewSection({ api, refreshKey }: { api: EditorApi; refreshKey: number }) {
  const { lang, w } = useText();
  const [state, setState] = useState<ServerState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reasons, setReasons] = useState<RejectReason[]>([]);
  const [note, setNote] = useState('');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const docId = api.docId;

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const [doc, reviews, exports] = await Promise.all([documents.get(docId), documents.reviews(docId), documents.exports(docId)]);
      setState({ doc, reviews, exports });
    } catch (e) {
      setLoadError(failText(e, lang));
    }
  }, [docId, lang]);

  useEffect(() => {
    void load();
  }, [load, api.version, refreshKey]);

  /** Run one action: save what is on screen first, then the action at the version the server has. */
  const act = async (fn: (version: number) => Promise<string>) => {
    setMessage(null);
    setBusy(true);
    try {
      await api.flush();
      const now = api.current();
      if (now.saveState !== 'saved' && now.saveState !== 'idle') {
        setMessage({ tone: 'error', text: w(S.exportNeedsSave) });
        return;
      }
      const text = await fn(now.version);
      setMessage({ tone: 'ok', text });
      await load();
    } catch (e) {
      setMessage({ tone: 'error', text: failText(e, lang) });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const setStatus = (status: 'draft' | 'in_review' | 'archived') =>
    act(async (version) => {
      await documents.setStatus(docId, status, version);
      setConfirmArchive(false);
      return fill(w(S.reviewStatusSet), { status: w(STATUS_TEXT[status]) });
    });

  const approve = () =>
    act(async (version) => {
      const final = state?.exports.find((e) => e.final && e.version === version);
      if (!final) throw new Error(w(S.reviewApproveNeedsFinal));
      const now = api.current();
      // The bound data is re-read NOW, as the final export did: approval never rests on an old check.
      const verification = now.doc.products.length ? await verifyAll(api) : {};
      const report = reportFor({ ...api, verification }, now.doc, true);
      if (report.blockers > 0) throw new Error(w(S.exportFinalBlocked));
      await documents.approve(docId, { version, qa: report, export_ids: [final.id] });
      return fill(w(S.reviewApproved), { n: version });
    });

  const reject = () => {
    if (!reasons.length) {
      setMessage({ tone: 'error', text: w(S.reviewNeedReason) });
      return;
    }
    return act(async () => {
      await documents.reject(docId, reasons, note.trim());
      setRejecting(false);
      setReasons([]);
      setNote('');
      return w(S.reviewRejected);
    });
  };

  if (loadError) {
    return (
      <section className="flex flex-col gap-2" data-review-section>
        <h3 className="text-sm font-semibold text-text-primary">{w(S.reviewTitle)}</h3>
        <p className="text-sm text-danger" role="alert">{loadError}</p>
        <Button size="sm" variant="ghost" onClick={() => void load()}>{w(S.retry)}</Button>
      </section>
    );
  }
  if (!state) {
    return (
      <section className="flex flex-col gap-2" data-review-section aria-busy="true">
        <h3 className="text-sm font-semibold text-text-primary">{w(S.reviewTitle)}</h3>
        <p className="text-sm text-text-muted">{w(S.loading)}</p>
      </section>
    );
  }

  const { doc, reviews, exports } = state;
  const status = doc.status;
  const finalForThis = exports.some((e) => e.final && e.version === doc.version);
  const canApprove = status !== 'archived' && doc.approved_version !== doc.version;

  return (
    <section className="flex flex-col gap-3" data-review-section data-status={status}>
      <h3 className="text-sm font-semibold text-text-primary">{w(S.reviewTitle)}</h3>
      <p className="text-sm text-text-secondary" data-review-status>
        {fill(w(S.reviewStatus), { status: w(STATUS_TEXT[status]), n: doc.version })}
        {doc.approved_version !== null ? ` · ${fill(w(S.reviewApprovedVersion), { n: doc.approved_version })}` : ''}
      </p>
      {doc.needs_review.length ? <p className="text-sm text-warning" role="status">{fill(w(S.reviewNeedsReview), { why: doc.needs_review.join('، ') })}</p> : null}

      <div className="flex flex-wrap gap-2">
        {status === 'draft' || status === 'idea' ? <Button size="sm" disabled={busy} onClick={() => setStatus('in_review')} data-review-send>{w(S.reviewSend)}</Button> : null}
        {status === 'in_review' || status === 'archived' ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => setStatus('draft')} data-review-draft>{w(S.reviewBackToDraft)}</Button> : null}
        {canApprove ? (
          <Button size="sm" variant="accent" disabled={busy || !finalForThis} onClick={approve} data-review-approve>
            {fill(w(S.reviewApprove), { n: doc.version })}
          </Button>
        ) : null}
        {status !== 'archived' ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting((v) => !v)} aria-expanded={rejecting} data-review-reject>{w(S.reviewReject)}</Button> : null}
        {status !== 'archived' ? (
          confirmArchive ? (
            <Button size="sm" variant="danger" disabled={busy} onClick={() => setStatus('archived')} data-review-archive-confirm>{w(S.reviewArchiveConfirm)}</Button>
          ) : (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmArchive(true)} data-review-archive>{w(S.reviewArchive)}</Button>
          )
        ) : null}
      </div>
      {canApprove && !finalForThis ? <p className="text-xs text-text-muted">{w(S.reviewApproveNeedsFinal)}</p> : null}

      {rejecting ? (
        <fieldset className="flex flex-col gap-2 rounded-lg border border-border-subtle p-3" data-review-reject-form>
          <legend className="px-1 text-sm text-text-secondary">{w(S.reviewRejectReasons)}</legend>
          <div className="flex flex-wrap gap-2">
            {REASONS.map((r) => (
              <label key={r} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border-subtle px-3 text-sm text-text-primary">
                <input type="checkbox" checked={reasons.includes(r)} onChange={(e) => setReasons((cur) => (e.target.checked ? [...cur, r] : cur.filter((x) => x !== r)))} />
                {w(REJECT_TEXT[r])}
              </label>
            ))}
          </div>
          <Textarea aria-label={w(S.reviewRejectNote)} placeholder={w(S.reviewRejectNote)} value={note} maxLength={600} rows={2} onChange={(e) => setNote(e.target.value)} />
          <div>
            <Button size="sm" variant="danger" disabled={busy} onClick={reject} data-review-reject-send>{w(S.reviewRejectSend)}</Button>
          </div>
        </fieldset>
      ) : null}

      {message ? <p className={`text-sm ${message.tone === 'ok' ? 'text-success' : 'text-danger'}`} role={message.tone === 'ok' ? 'status' : 'alert'} data-review-message>{message.text}</p> : null}

      <div className="flex flex-col gap-1">
        <h4 className="text-xs font-semibold text-text-secondary">{w(S.reviewHistory)}</h4>
        {reviews.length ? (
          <ul className="flex flex-col gap-1 text-xs text-text-secondary" data-review-history>
            {reviews.map((r) => (
              <li key={r.id}>
                {fill(w(r.decision === 'approved' ? S.reviewHistoryApproved : S.reviewHistoryRejected), { n: r.version, who: r.actor_name ?? '—', when: shortTime(r.created_at, lang) })}
                {r.reasons.length ? ` — ${r.reasons.map((x) => w(REJECT_TEXT[x])).join('، ')}` : ''}
                {r.invalidated_at ? ` · ${fill(w(S.reviewInvalidated), { why: r.invalidated_reason ?? '' })}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-text-muted">{w(S.reviewNone)}</p>
        )}
      </div>
    </section>
  );
}
