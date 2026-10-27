/**
 * «الفحص» — the deterministic checks of packages/creativeDoc/src/quality.ts,
 * run here with what only the browser knows: the real measurer, which fonts
 * really loaded, which pictures really decoded, and the server’s
 * re-verification of the bound store data (POST /snapshots/:id/verify).
 *
 * Blockers / needs a look / suggestions, then the checks that RAN and the
 * ones that did not, with why — never a quality score. The optional visual
 * review (Claude vision, owner-enabled) is shown as advice only.
 */
import { useMemo, useState } from 'react';
import { Button } from '../../ui/Button';
import { qualityReport, type QualityIssue, type QualityReport } from '../../../../packages/creativeDoc/src/quality';
import type { ReviewResponse, VerifyDto } from '../../../../packages/creativeDoc/src/api';
import type { CreativeDocument } from '../../../../packages/creativeDoc/src/schema';
import { ai, idempotencyKey, store } from '../client';
import type { EditorApi } from '../editorApi';
import { claimStates } from '../editorData';
import { CHANGE_TEXT, CHECK_TEXT, QUALITY_TEXT, ROLE_TEXT, S, SKIP_TEXT, fill } from '../strings';
import { canvasBlob, failText, useText } from '../shared';

/** The report for the document on screen. `final` turns unverified data and test data into blockers. */
export function reportFor(api: Pick<EditorApi, 'data' | 'measure' | 'fonts' | 'images' | 'verification'>, doc: CreativeDocument, final: boolean): QualityReport {
  const verification: Record<string, VerifyDto['changes']> = {};
  for (const [slot, v] of Object.entries(api.verification)) verification[slot] = v.changes;
  return qualityReport(doc, {
    brand: api.data.brand.kit,
    snapshots: api.data.snapshots,
    claims: claimStates(api.data.claims),
    verification: Object.keys(verification).length ? verification : undefined,
    measure: api.measure,
    fontsLoaded: api.fonts.loaded,
    assetsLoaded: api.images.loadedRefs(),
    final,
    now: new Date().toISOString(),
  });
}

/** Re-verifies every bound snapshot on the server; returns the results by slot. */
export async function verifyAll(api: Pick<EditorApi, 'doc' | 'setVerification' | 'verification'>): Promise<Record<string, VerifyDto>> {
  const out: Record<string, VerifyDto> = {};
  for (const b of api.doc.products) out[b.slot] = await store.verify(b.snapshot_id);
  api.setVerification(out);
  return out;
}

export default function QaPanel({ api }: { api: EditorApi }) {
  const { lang, w } = useText();
  const [final, setFinal] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const report = useMemo(() => reportFor(api, api.doc, final), [api, final]);

  const nameOf = (id: string) => {
    const l = api.doc.layers.find((x) => x.id === id);
    return l ? w(ROLE_TEXT[l.role]) : id;
  };
  const group = (sev: QualityIssue['severity']) => report.issues.filter((i) => i.severity === sev);
  const verified = api.doc.products.length > 0 && api.doc.products.every((b) => api.verification[b.slot]);

  const runVerify = async () => {
    setError('');
    setVerifying(true);
    try {
      await verifyAll(api);
    } catch (e) {
      setError(failText(e, lang));
    } finally {
      setVerifying(false);
    }
  };

  const runReview = async () => {
    setError('');
    const stage = api.stage();
    if (!stage) return;
    await api.flush();
    const now = api.current();
    try {
      // A downscaled preview (≤ 768 px on the long side) keeps the request small.
      const ratio = Math.min(1, 768 / Math.max(now.doc.format.width, now.doc.format.height));
      const blob = await canvasBlob(stage.exportCanvas({ pixelRatio: ratio }), 'image/png');
      if (!blob) throw new Error(w(S.saveFailed));
      const b64 = await blobBase64(blob);
      setReview(await ai.review({ document_id: api.docId, version: now.version, image_base64: b64, idempotency_key: idempotencyKey() }));
    } catch (e) {
      setError(failText(e, lang));
    }
  };

  const issueLine = (i: QualityIssue, k: number) => (
    <li key={`${i.code}-${k}`} className="text-sm">
      <span className="text-text-primary">{w(QUALITY_TEXT[i.code])}</span>
      {i.layer_ids.length ? <span className="text-text-muted"> — {i.layer_ids.map(nameOf).join('، ')}</span> : null}
      {i.code === 'source_changed' && i.detail ? <span className="text-text-muted"> ({i.detail.split(',').map((c) => (c in CHANGE_TEXT ? w(CHANGE_TEXT[c as keyof typeof CHANGE_TEXT]) : c)).join('، ')})</span> : null}
    </li>
  );

  return (
    <div className="flex flex-col gap-4" data-qa-panel data-qa-blockers={report.blockers}>
      <p className="text-xs text-text-muted">{w(S.qaNotAScore)}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={final ? 'primary' : 'secondary'} aria-pressed={final} onClick={() => setFinal((f) => !f)}>{w(S.qaFinalMode)}</Button>
        {api.doc.products.length ? <Button size="sm" loading={verifying} onClick={runVerify}>{w(S.qaVerify)}</Button> : null}
      </div>
      {verified ? <p className="text-xs text-success" role="status">{w(S.qaVerified)}</p> : null}
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      {(['blocker', 'review', 'optional'] as const).map((sev) => {
        const list = group(sev);
        if (!list.length) return null;
        const title = sev === 'blocker' ? S.qaBlockers : sev === 'review' ? S.qaReview : S.qaOptional;
        return (
          <section key={sev} data-qa-group={sev}>
            <h3 className={`mb-1 text-sm font-semibold ${sev === 'blocker' ? 'text-danger' : sev === 'review' ? 'text-warning' : 'text-text-secondary'}`}>{fill(w(title), { n: list.length })}</h3>
            <ul className="flex flex-col gap-1">{list.map(issueLine)}</ul>
          </section>
        );
      })}
      {!report.issues.length ? <p className="text-sm text-success">{w(S.qaNoIssues)}</p> : null}
      <section>
        <h3 className="mb-1 text-sm font-semibold text-text-secondary">{w(S.qaRan)}</h3>
        <p className="text-sm text-text-primary">{report.ran.map((c) => w(CHECK_TEXT[c])).join('، ')}</p>
      </section>
      {report.skipped.length ? (
        <section>
          <h3 className="mb-1 text-sm font-semibold text-text-secondary">{w(S.qaSkipped)}</h3>
          <ul className="flex flex-col gap-1">{report.skipped.map((s) => <li key={s.check} className="text-sm text-text-muted">{w(CHECK_TEXT[s.check])} — {w(SKIP_TEXT[s.check])}</li>)}</ul>
        </section>
      ) : null}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-text-secondary">{w(S.qaVisualReview)}</h3>
        {api.provider?.vision_review && api.provider.ready ? (
          <>
            <Button size="sm" onClick={runReview}>{w(S.qaVisualReview)}</Button>
            {review ? (
              <div className="rounded-lg border border-border-subtle bg-surface p-2" data-visual-review>
                <p className="mb-1 text-xs text-text-muted">{w(S.qaVisualAdvice)}</p>
                {review.summary ? <p className="text-sm text-text-primary">{review.summary}</p> : null}
                <ul className="mt-1 flex flex-col gap-1">
                  {review.notes.map((n, i) => <li key={i} className="text-sm text-text-secondary">{n.layer_id ? `${nameOf(n.layer_id)}: ` : ''}{n.issue}{n.suggestion ? ` — ${n.suggestion}` : ''}</li>)}
                </ul>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-text-muted">{w(S.qaVisualDisabled)}</p>
        )}
      </section>
    </div>
  );
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
