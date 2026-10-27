/**
 * «التصدير» — PNG / JPEG / WebP rendered from the Konva stage at exactly the
 * document’s size, with guides, the selection and the annotations left out
 * (they live on other layers); Project JSON (the normalised document with its
 * schema_version, re-importable).
 *
 * DRAFT vs FINAL (spec §23, §24). A draft can always be downloaded, named
 * «…-draft», and is never recorded as final. A FINAL export needs zero
 * blockers in the final-mode checks AND the server’s re-verification of the
 * bound data; it is uploaded to POST /documents/:id/exports with final:true
 * (the server re-checks and may refuse) and only then handed to the reader.
 *
 * WebP: the browser’s encoder is asked, and its answer checked — a browser
 * that cannot encode WebP returns a PNG, and the panel says so instead of
 * naming a PNG «.webp».
 */
import { useRef, useState } from 'react';
import { Button } from '../../ui/Button';
import { normalizeDocument } from '../../../../packages/creativeDoc/src/normalize';
import type { ExportDto, ExportKind } from '../../../../packages/creativeDoc/src/api';
import { documents } from '../client';
import type { EditorApi } from '../editorApi';
import { exportFileName } from '../editorModel';
import { EXPORT_KIND_TEXT, S, fill } from '../strings';
import { canvasBlob, downloadBlob, failText, useText } from '../shared';
import { reportFor, verifyAll } from './QaPanel';

const TYPES: Record<'png' | 'jpeg' | 'webp', { mime: string; ext: string; quality?: number }> = {
  png: { mime: 'image/png', ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg', quality: 0.92 },
  webp: { mime: 'image/webp', ext: 'webp', quality: 0.92 },
};

export default function ExportPanel({ api }: { api: EditorApi }) {
  const { lang, w } = useText();
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [finalExport, setFinalExport] = useState<ExportDto | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { doc } = api;
  const bg = doc.layers.find((l) => l.role === 'background');
  const assetBackground = !!bg && bg.type === 'image' && bg.asset.kind === 'asset';

  const render = async (kind: 'png' | 'jpeg' | 'webp', backgroundOnly = false): Promise<Blob | null> => {
    const stage = api.stage();
    if (!stage) return null;
    const t = TYPES[kind];
    const blob = await canvasBlob(stage.exportCanvas({ backgroundOnly }), t.mime, t.quality);
    if (!blob) return null;
    if (blob.type !== t.mime) {
      setMessage({ tone: 'error', text: w(S.exportWebpUnsupported) });
      return null;
    }
    return blob;
  };

  const draft = async (kind: 'png' | 'jpeg' | 'webp') => {
    setMessage(null);
    try {
      const blob = await render(kind);
      if (!blob) return;
      const name = exportFileName(api.meta.title, api.version, TYPES[kind].ext, true);
      downloadBlob(blob, name);
      setMessage({ tone: 'ok', text: fill(w(S.exportDone), { name }) });
    } catch (e) {
      setMessage({ tone: 'error', text: failText(e, lang) });
    }
  };

  const final = async (kind: 'png' | 'jpeg' | 'webp') => {
    setMessage(null);
    try {
      await api.flush();
      const now = api.current();
      if (now.saveState !== 'saved' && now.saveState !== 'idle') {
        setMessage({ tone: 'error', text: w(S.exportNeedsSave) });
        return;
      }
      const verification = doc.products.length ? await verifyAll(api) : {};
      const report = reportFor({ ...api, verification }, now.doc, true);
      if (report.blockers > 0) {
        setMessage({ tone: 'error', text: w(S.exportFinalBlocked) });
        return;
      }
      const blob = await render(kind);
      if (!blob) return;
      const rec = await documents.uploadExport(api.docId, { file: blob, kind: kind as ExportKind, version: now.version, final: true, width: now.doc.format.width, height: now.doc.format.height });
      setFinalExport(rec);
      const name = exportFileName(api.meta.title, now.version, TYPES[kind].ext, false);
      downloadBlob(blob, name);
      setMessage({ tone: 'ok', text: `${fill(w(S.exportDone), { name })} ${fill(w(S.exportRecorded), { n: now.version })}` });
    } catch (e) {
      setMessage({ tone: 'error', text: failText(e, lang) });
    }
  };

  const approve = async () => {
    if (!finalExport) return;
    setMessage(null);
    try {
      const now = api.current();
      const report = reportFor(api, now.doc, true);
      await documents.approve(api.docId, { version: now.version, qa: report, export_ids: [finalExport.id] });
      setMessage({ tone: 'ok', text: w(S.brandApproved) });
    } catch (e) {
      setMessage({ tone: 'error', text: failText(e, lang) });
    }
  };

  const projectJson = () => {
    const r = normalizeDocument(doc);
    const blob = new Blob([JSON.stringify(r.doc, null, 2)], { type: 'application/json' });
    downloadBlob(blob, exportFileName(api.meta.title, api.version, 'json', false));
  };

  const backgroundOnly = async () => {
    setMessage(null);
    const blob = await render('png', true);
    if (!blob) return;
    const name = exportFileName(api.meta.title, api.version, 'png', true).replace(/-draft\.png$/, '-background.png');
    downloadBlob(blob, name);
    setMessage({ tone: 'ok', text: fill(w(S.exportDone), { name }) });
  };

  const importJson = async (file: File) => {
    setMessage(null);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const r = normalizeDocument(parsed);
      if (!r.ok) {
        setMessage({ tone: 'error', text: fill(w(S.importRefused), { issues: r.issues.filter((i) => i.fatal).map((i) => `${i.path} ${i.code}`).join('، ') }) });
        return;
      }
      const created = await documents.create({ title: file.name.replace(/\.json$/i, '').slice(0, 80), content: r.doc, origin: 'import' });
      setMessage({ tone: 'ok', text: w(S.importDone) });
      api.openDocument(created.id);
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof SyntaxError ? fill(w(S.importRefused), { issues: 'JSON' }) : failText(e, lang) });
    }
  };

  return (
    <div className="flex flex-col gap-4" data-export-panel>
      <p className="text-sm text-text-secondary">{fill(w(S.exportSize), { w: doc.format.width, h: doc.format.height })}</p>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-text-primary">{w(S.exportDraft)}</h3>
        <div className="flex flex-wrap gap-2">
          {(['png', 'jpeg', 'webp'] as const).map((k) => <Button key={k} size="sm" data-export-draft={k} onClick={() => draft(k)}>{w(EXPORT_KIND_TEXT[k])}</Button>)}
        </div>
        <p className="text-xs text-text-muted">{w(S.exportDraftNote)}</p>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-text-primary">{w(S.exportFinal)}</h3>
        <div className="flex flex-wrap gap-2">
          {(['png', 'jpeg', 'webp'] as const).map((k) => <Button key={k} size="sm" variant="primary" data-export-final={k} onClick={() => final(k)}>{w(EXPORT_KIND_TEXT[k])}</Button>)}
        </div>
        <p className="text-xs text-text-muted">{w(S.exportFinalBlocked)}</p>
        {finalExport ? <Button size="sm" variant="accent" onClick={approve}>{w(S.brandApprove)}</Button> : null}
      </section>
      <section className="flex flex-col gap-2">
        <Button size="sm" onClick={projectJson}>{w(S.exportJson)}</Button>
        {assetBackground ? <Button size="sm" onClick={backgroundOnly}>{w(S.exportBackground)}</Button> : null}
        <Button size="sm" variant="ghost" onClick={() => fileInput.current?.click()}>{w(S.importJson)}</Button>
        <input ref={fileInput} type="file" accept="application/json,.json" className="hidden" aria-hidden="true" tabIndex={-1} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importJson(f); }} />
      </section>
      {message ? <p className={`text-sm ${message.tone === 'ok' ? 'text-success' : 'text-danger'}`} role={message.tone === 'ok' ? 'status' : 'alert'} data-export-message>{message.text}</p> : null}
    </div>
  );
}
