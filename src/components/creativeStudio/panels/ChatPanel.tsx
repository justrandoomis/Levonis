/**
 * «المحادثة» — an instruction to Claude, scoped to what the owner selected or
 * pointed at, or explicitly design-wide (spec §16, §17).
 *
 *  - Before sending, the target is spelled out: «N عناصر: …» or «التصميم
 *    كله». Nothing selected and not design-wide → nothing is sent.
 *  - Pointing marks (pin / box / arrow + a note) are document coordinates
 *    (viewToDoc), saved with the document, sent with the request and never
 *    exported.
 *  - The answer is a PATCH. It passes the same gate here as on the server
 *    (validateEditPatch, on this exact document and version) and is shown as
 *    a diff — changed layers, dependents that moved, conflicts — with Apply /
 *    Discard. Apply saves with origin `ai` and the job id, then tells the
 *    server it was applied. If the document moved on while the answer was on
 *    its way, the answer is dropped and a retry on the current version is
 *    offered.
 *  - Not ready (no key, no model, no budget): the reason and a way to
 *    Settings; every manual tool keeps working. Nothing is ever shown as
 *    Claude’s answer that Claude did not send.
 */
import { useRef, useState, type ReactNode } from 'react';
import { MapPin, MousePointer2, MoveUpRight, Square, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../../ui/Button';
import { Field, Input, Textarea } from '../../ui/Field';
import { Segmented } from '../../ui/Segmented';
import { Switch } from '../../ui/Switch';
import { validateEditPatch, type PatchVerdict } from '../../../../packages/creativeDoc/src/aiContracts';
import type { EditResponse } from '../../../../packages/creativeDoc/src/api';
import type { Annotation, CreativeDocument } from '../../../../packages/creativeDoc/src/schema';
import { ai, idempotencyKey } from '../client';
import type { EditorApi } from '../editorApi';
import { evidenceFor } from '../editorData';
import { topLevel } from '../editorModel';
import { ANNOTATION_TEXT, CONFLICT_TEXT, ROLE_TEXT, S, fill } from '../strings';
import { AiNotReady, failText, useText } from '../shared';
import type { Tool } from '../stageView';

type Phase =
  | { kind: 'idle'; note?: string }
  | { kind: 'sending' }
  | { kind: 'stale' }
  | { kind: 'error'; message: string }
  | { kind: 'preview'; res: EditResponse; verdict: PatchVerdict; base: CreativeDocument; version: number };

export default function ChatPanel({ api, pending, onPendingDone }: { api: EditorApi; pending: Omit<Annotation, 'id' | 'note'> | null; onPendingDone(): void }) {
  const { lang, w } = useText();
  const { doc, selection } = api;
  const [whole, setWhole] = useState(false);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [applying, setApplying] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  const lastInstruction = useRef('');

  const scope = topLevel(doc, selection);
  const nameOf = (id: string) => {
    const l = doc.layers.find((x) => x.id === id);
    return l ? w(ROLE_TEXT[l.role]) : id;
  };
  const ready = api.provider?.ready === true;

  const send = async (instruction: string) => {
    const words = instruction.trim();
    if (!words) return;
    if (!whole && !scope.length) {
      setPhase({ kind: 'error', message: w(S.chatScopeNone) });
      return;
    }
    lastInstruction.current = words;
    setPhase({ kind: 'sending' });
    await api.flush();
    const base = api.current();
    if (base.saveState !== 'saved' && base.saveState !== 'idle') {
      setPhase({ kind: 'error', message: w(S.exportNeedsSave) });
      return;
    }
    const controller = new AbortController();
    ctrl.current = controller;
    const scopeIds = whole ? null : topLevel(base.doc, selection);
    try {
      const res = await ai.edit(
        { document_id: api.docId, base_version: base.version, instruction: words, scope_ids: scopeIds, annotations: base.doc.annotations, idempotency_key: idempotencyKey() },
        controller.signal,
      );
      const now = api.current();
      if (now.doc !== base.doc || now.version !== base.version) {
        void ai.cancel(res.job_id).catch(() => undefined);
        setPhase({ kind: 'stale' });
        return;
      }
      const main = base.doc.products[0];
      const ev = evidenceFor(main?.product_id ?? null, main ? api.data.snapshots[main.slot] ?? null : null, api.data.opportunities);
      const verdict = validateEditPatch(res.patch, {
        documentId: api.docId, version: base.version, doc: base.doc, scope: scopeIds,
        evidence: { offer: ev.offer, serviceClaim: base.doc.services.length > 0 },
        ops: { brand: api.data.brand.kit, allowed: api.allowed, measure: api.measure },
      });
      setPhase({ kind: 'preview', res, verdict, base: base.doc, version: base.version });
    } catch (e) {
      if (controller.signal.aborted) setPhase({ kind: 'idle', note: w(S.chatCancel) });
      else setPhase({ kind: 'error', message: failText(e, lang) });
    } finally {
      ctrl.current = null;
    }
  };

  const applyPatch = async () => {
    if (phase.kind !== 'preview' || phase.verdict.ok === false || !phase.verdict.applied) return;
    const now = api.current();
    if (now.doc !== phase.base || now.version !== phase.version) {
      setPhase({ kind: 'stale' });
      return;
    }
    setApplying(true);
    try {
      const ok = await api.applyAi(phase.verdict.applied, phase.res.job_id);
      setPhase(ok ? { kind: 'idle', note: w(S.chatApplied) } : { kind: 'error', message: w(S.saveFailed) });
      if (ok) setText('');
    } finally {
      setApplying(false);
    }
  };

  const discard = () => {
    if (phase.kind === 'preview') void ai.cancel(phase.res.job_id).catch(() => undefined);
    setPhase({ kind: 'idle' });
  };

  const tools: Array<{ id: Tool; label: string; icon: ReactNode }> = [
    { id: 'select', label: w(S.chatToolOff), icon: <MousePointer2 className="h-4 w-4" /> },
    { id: 'pin', label: w(S.chatToolPin), icon: <MapPin className="h-4 w-4" /> },
    { id: 'box', label: w(S.chatToolBox), icon: <Square className="h-4 w-4" /> },
    { id: 'arrow', label: w(S.chatToolArrow), icon: <MoveUpRight className="h-4 w-4" /> },
  ];

  const addNote = () => {
    if (!pending) return;
    const id = `n_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    if (api.apply([{ op: 'add_annotation', annotation: { ...pending, id, note: note.trim() } }])) {
      setNote('');
      onPendingDone();
    }
  };

  return (
    <div className="flex flex-col gap-4" data-chat-panel>
      {!ready ? <AiNotReady provider={api.provider} onSettings={api.goSettings} /> : null}

      <section aria-label={w(S.chatToolHint)} className="flex flex-col gap-2">
        <Segmented label={w(S.chatToolHint)} group="note-tool" size="sm" value={api.tool} onChange={(id) => api.setTool(id as Tool)} items={tools.map((t) => ({ id: t.id, label: t.label, icon: t.icon }))} />
        <p className="text-xs text-text-muted">{w(S.chatToolHint)}</p>
        {pending ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface p-2" data-pending-note>
            <Field label={`${w(S.chatNote)} — ${w(ANNOTATION_TEXT[pending.kind])}`}>
              <Input value={note} maxLength={300} autoFocus onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addNote(); if (e.key === 'Escape') onPendingDone(); }} />
            </Field>
            <div className="flex gap-2">
              <Button size="sm" variant="primary" onClick={addNote}>{w(S.save)}</Button>
              <Button size="sm" variant="ghost" onClick={onPendingDone}>{w(S.cancel)}</Button>
            </div>
          </div>
        ) : null}
        {doc.annotations.length ? (
          <ol className="flex flex-col gap-1" aria-label={fill(w(S.chatAnnotations), { n: doc.annotations.length })}>
            {doc.annotations.map((a, i) => (
              <li key={a.id} className="flex items-center gap-2 text-sm">
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold" style={{ background: '#f59e0b', color: '#111214' }}>{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-text-secondary">{w(ANNOTATION_TEXT[a.kind])}{a.note ? ` — ${a.note}` : ''}{a.layer_ids.length ? ` (${a.layer_ids.map(nameOf).join('، ')})` : ''}</span>
                <IconButton label={`${w(S.remove)} ${i + 1}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => api.apply([{ op: 'delete_annotation', annotation_id: a.id }])} />
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <Switch checked={whole} onChange={setWhole} label={w(S.chatWholeToggle)} />
        <p className="text-sm text-text-primary" data-chat-scope>
          {whole ? w(S.chatScopeWhole) : scope.length ? fill(w(S.chatScopeSelection), { n: scope.length, names: scope.map(nameOf).join('، ') }) : <span className="text-text-muted">{w(S.chatScopeNone)}</span>}
        </p>
        <Textarea rows={3} value={text} maxLength={600} placeholder={w(S.chatPlaceholder)} aria-label={w(S.chatPlaceholder)} disabled={!ready || phase.kind === 'sending'} onChange={(e) => setText(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          {phase.kind === 'sending' ? (
            <Button size="sm" variant="ghost" onClick={() => ctrl.current?.abort()}>{w(S.chatCancel)}</Button>
          ) : (
            <Button size="sm" variant="primary" disabled={!ready || !text.trim() || (!whole && !scope.length)} onClick={() => send(text)}>{w(S.chatSend)}</Button>
          )}
          {phase.kind === 'sending' ? <span className="self-center text-sm text-text-muted" role="status">{w(S.aiBusy)}</span> : null}
        </div>
      </section>

      {phase.kind === 'idle' && phase.note ? <p className="text-sm text-text-secondary" role="status">{phase.note}</p> : null}
      {phase.kind === 'error' ? <p className="text-sm text-danger" role="alert">{phase.message}</p> : null}
      {phase.kind === 'stale' ? (
        <div className="flex flex-col gap-2" role="alert" data-chat-stale>
          <p className="text-sm text-text-secondary">{w(S.chatStale)}</p>
          <Button size="sm" onClick={() => send(lastInstruction.current)}>{w(S.chatRetryCurrent)}</Button>
        </div>
      ) : null}
      {phase.kind === 'preview' ? <PatchPreview phase={phase} nameOf={nameOf} applying={applying} onApply={applyPatch} onDiscard={discard} /> : null}
    </div>
  );
}

function PatchPreview({ phase, nameOf, applying, onApply, onDiscard }: { phase: Extract<Phase, { kind: 'preview' }>; nameOf(id: string): string; applying: boolean; onApply(): void; onDiscard(): void }) {
  const { w } = useText();
  const { verdict, res } = phase;
  if (verdict.ok === false) {
    return (
      <div className="flex flex-col gap-2" role="alert" data-patch-refused={verdict.code}>
        <p className="text-sm text-danger">{fill(w(S.chatRejectedPatch), { code: verdict.code })}</p>
        <Button size="sm" variant="ghost" onClick={onDiscard}>{w(S.discard)}</Button>
      </div>
    );
  }
  const p = verdict.patch;
  const a = verdict.applied;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-surface p-3" data-patch-preview>
      <p className="text-sm font-semibold text-text-primary">{w(S.chatDiffTitle)}</p>
      {p.reason ? <p className="text-sm text-text-secondary"><span className="text-text-muted">{w(S.chatReason)}: </span>{p.reason}</p> : null}
      {p.clarification ? <p className="text-sm text-text-primary"><span className="text-text-muted">{w(S.chatClarify)} </span>{p.clarification}</p> : null}
      {a ? (
        <>
          <p className="text-sm"><span className="text-text-muted">{w(S.chatDiffChanged)}: </span>{a.changed.length ? a.changed.map(nameOf).join('، ') : '—'}</p>
          {a.moved.length ? <p className="text-sm"><span className="text-text-muted">{w(S.chatDiffMoved)}: </span>{a.moved.map(nameOf).join('، ')}</p> : null}
          {a.conflicts.length ? <p className="text-sm text-warning"><span>{w(S.chatDiffConflicts)}: </span>{a.conflicts.map((c) => w(CONFLICT_TEXT[c.code])).join('، ')}</p> : null}
        </>
      ) : (
        !p.clarification && <p className="text-sm text-text-muted">{w(S.chatDiffNothing)}</p>
      )}
      {p.warnings.length ? <ul className="list-disc ps-5 text-xs text-text-muted" aria-label={w(S.chatWarnings)}>{p.warnings.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
      <p className="text-xs text-text-muted" dir="ltr">
        {fill(w(S.chatUsage), { in: res.usage.input_tokens, out: res.usage.output_tokens })}
        {res.usage.est_cost_usd !== null ? ` · ≈ $${res.usage.est_cost_usd.toFixed(4)} (${w(S.aiEstimated)})` : ''}
      </p>
      <div className="flex gap-2">
        {a ? <Button size="sm" variant="primary" loading={applying} onClick={onApply}>{w(S.apply)}</Button> : null}
        <Button size="sm" variant="ghost" onClick={onDiscard}>{w(S.discard)}</Button>
      </div>
    </div>
  );
}

