/**
 * «المحادثة» — an instruction to Claude, scoped to what the owner selected or
 * pointed at, or explicitly design-wide (spec §16, §17).
 *
 *  - Before sending, the target is spelled out: «N عناصر: …» or «التصميم
 *    كله». A selected group (a CTA chip) takes what is inside it along — its
 *    words are a child layer — and the panel says so. Nothing selected and not
 *    design-wide → nothing is sent.
 *  - Pointing marks (pin / box / arrow + a note) are document coordinates
 *    (viewToDoc), saved with the document, sent with the request and never
 *    exported.
 *  - The answer is a PATCH. It passes the same gate here as on the server
 *    (validateEditPatch, on this exact document and version) and is shown as
 *    a diff — changed layers, dependents that moved, a re-layout it asks for,
 *    conflicts — with Apply / Discard. Apply saves with origin `ai` and the
 *    job id, then tells the server it was applied. If the document moved on
 *    while the answer was on its way, the answer is dropped and a retry on the
 *    current version is offered.
 *  - THE CONVERSATION BELONGS TO THE EDITOR (`useChatSession`), not to this
 *    panel: switching to another tab, closing the phone sheet or crossing the
 *    desktop/phone breakpoint unmounts the panel, never the request, its
 *    answer or the typed words. Leaving the editor stops the wait and cancels
 *    an answer that was never applied.
 *  - «Stop» and Discard say what is true: a request already sent may still be
 *    processed and charged; the usage log is one tap away.
 *  - Not ready (no key, no model, no budget): the reason and a way to
 *    Settings; every manual tool keeps working. Nothing is ever shown as
 *    Claude’s answer that Claude did not send.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { MapPin, MousePointer2, MoveUpRight, Square, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../../ui/Button';
import { Field, Input, Textarea } from '../../ui/Field';
import { Segmented } from '../../ui/Segmented';
import { Switch } from '../../ui/Switch';
import { validateEditPatch, type PatchVerdict } from '../../../../packages/creativeDoc/src/aiContracts';
import type { EditResponse } from '../../../../packages/creativeDoc/src/api';
import type { RebuildRequest } from '../../../../packages/creativeDoc/src/ops';
import type { Annotation, CreativeDocument } from '../../../../packages/creativeDoc/src/schema';
import { VARIANT_LABELS } from '../../../../packages/creativeDoc/src/templates';
import { ai, idempotencyKey } from '../client';
import type { EditorApi } from '../editorApi';
import { evidenceFor } from '../editorData';
import { chatScope, topLevel } from '../editorModel';
import { ANNOTATION_TEXT, CONFLICT_TEXT, FORMAT_TEXT, PRIORITY_TEXT, ROLE_TEXT, S, fill } from '../strings';
import { AiNotReady, failText, useText } from '../shared';
import type { Tool } from '../stageView';

export type ChatPhase =
  | { kind: 'idle'; note?: string; usageLink?: boolean }
  | { kind: 'sending' }
  | { kind: 'stale' }
  | { kind: 'error'; message: string }
  | { kind: 'preview'; res: EditResponse; verdict: PatchVerdict; base: CreativeDocument; version: number };

/** The conversation's state and actions, held by the editor (see the header). */
export interface ChatSession {
  whole: boolean;
  setWhole(v: boolean): void;
  text: string;
  setText(v: string): void;
  phase: ChatPhase;
  applying: boolean;
  send(instruction: string): Promise<void>;
  /** Stop waiting for the answer (the request may still be processed). */
  stop(): void;
  apply(): Promise<void>;
  discard(): void;
  /** Ask again with the last instruction, on the current version. */
  retry(): void;
}

/**
 * The conversation, owned by the editor core. `api` returns the editor's
 * current handle (it is rebuilt on every render). On the editor's real
 * unmount a request still on its way is aborted, and an answer shown but never
 * applied is cancelled on the server (`POST /jobs/:id/cancel`) so it can never
 * be applied later.
 */
export function useChatSession(api: () => EditorApi): ChatSession {
  const { lang, w } = useText();
  const [whole, setWhole] = useState(false);
  const [text, setText] = useState('');
  const [phase, setPhaseState] = useState<ChatPhase>({ kind: 'idle' });
  const [applying, setApplyingState] = useState(false);
  const phaseRef = useRef(phase);
  const applyingRef = useRef(false);
  const ctrl = useRef<AbortController | null>(null);
  /** «Stop» pressed while the design was still being saved, before anything was sent. */
  const stopEarly = useRef(false);
  const lastInstruction = useRef('');
  const wholeRef = useRef(whole);
  wholeRef.current = whole;

  const setPhase = useCallback((p: ChatPhase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);
  const setApplying = (v: boolean) => {
    applyingRef.current = v;
    setApplyingState(v);
  };

  useEffect(() => () => {
    ctrl.current?.abort();
    const p = phaseRef.current;
    // An answer being applied right now finishes; one only shown is cancelled so it is never applied later.
    if (p.kind === 'preview' && !applyingRef.current) void ai.cancel(p.res.job_id).catch(() => undefined);
  }, []);

  const send = async (instruction: string) => {
    const words = instruction.trim();
    if (!words) return;
    const start = api();
    const isWhole = wholeRef.current;
    // The selection the owner sent it about — captured now, before the save below.
    const selection = start.selection;
    if (!isWhole && !chatScope(start.doc, selection).length) {
      setPhase({ kind: 'error', message: w(S.chatScopeNone) });
      return;
    }
    lastInstruction.current = words;
    stopEarly.current = false;
    setPhase({ kind: 'sending' });
    await start.flush();
    if (stopEarly.current) {
      // Nothing left the browser: nothing to process, nothing to pay.
      setPhase({ kind: 'idle' });
      return;
    }
    const base = api().current();
    if (base.saveState !== 'saved' && base.saveState !== 'idle') {
      setPhase({ kind: 'error', message: w(S.exportNeedsSave) });
      return;
    }
    const controller = new AbortController();
    ctrl.current = controller;
    const scopeIds = isWhole ? null : chatScope(base.doc, selection);
    try {
      const res = await ai.edit(
        { document_id: start.docId, base_version: base.version, instruction: words, scope_ids: scopeIds, annotations: base.doc.annotations, idempotency_key: idempotencyKey() },
        controller.signal,
      );
      const now = api().current();
      if (now.doc !== base.doc || now.version !== base.version) {
        void ai.cancel(res.job_id).catch(() => undefined);
        setPhase({ kind: 'stale' });
        return;
      }
      const a = api();
      const main = base.doc.products[0];
      const ev = evidenceFor(main?.product_id ?? null, main ? a.data.snapshots[main.slot] ?? null : null, a.data.opportunities);
      const verdict = validateEditPatch(res.patch, {
        documentId: a.docId, version: base.version, doc: base.doc, scope: scopeIds,
        evidence: { offer: ev.offer, serviceClaim: base.doc.services.length > 0 },
        ops: { brand: a.data.brand.kit, allowed: a.allowed, measure: a.measure },
      });
      setPhase({ kind: 'preview', res, verdict, base: base.doc, version: base.version });
    } catch (e) {
      if (controller.signal.aborted) setPhase({ kind: 'idle', note: w(S.chatStopped), usageLink: true });
      else setPhase({ kind: 'error', message: failText(e, lang) });
    } finally {
      if (ctrl.current === controller) ctrl.current = null;
    }
  };

  const apply = async () => {
    const p = phaseRef.current;
    if (p.kind !== 'preview' || p.verdict.ok === false || !p.verdict.applied || applyingRef.current) return;
    const now = api().current();
    if (now.doc !== p.base || now.version !== p.version) {
      setPhase({ kind: 'stale' });
      return;
    }
    setApplying(true);
    try {
      const r = await api().applyAi(p.verdict.applied, p.res.job_id);
      // `=== false`: src/ compiles without strict null checks, where only a literal comparison narrows the union.
      if (r.ok === false) setPhase({ kind: 'error', message: r.message });
      else {
        setPhase({ kind: 'idle', note: w(S.chatApplied) });
        setText('');
      }
    } finally {
      setApplying(false);
    }
  };

  const discard = () => {
    const p = phaseRef.current;
    if (applyingRef.current) return;
    if (p.kind === 'preview') {
      void ai.cancel(p.res.job_id).catch(() => undefined);
      setPhase({ kind: 'idle', note: w(S.chatDiscarded), usageLink: true });
      return;
    }
    setPhase({ kind: 'idle' });
  };

  return {
    whole, setWhole, text, setText, phase, applying, send, apply, discard,
    stop: () => {
      if (ctrl.current) ctrl.current.abort();
      else if (phaseRef.current.kind === 'sending') stopEarly.current = true;
    },
    retry: () => { void send(lastInstruction.current); },
  };
}

export default function ChatPanel({ api, pending, onPendingDone }: { api: EditorApi; pending: Omit<Annotation, 'id' | 'note'> | null; onPendingDone(): void }) {
  const { lang, w } = useText();
  const { doc, selection, chat } = api;
  const { whole, text, phase, applying } = chat;
  const [note, setNote] = useState('');

  const scope = topLevel(doc, selection.filter((id) => doc.layers.some((l) => l.id === id)));
  const expanded = chatScope(doc, selection);
  const inside = expanded.filter((id) => !scope.includes(id));
  const nameOf = (id: string) => {
    const l = doc.layers.find((x) => x.id === id);
    return l ? w(ROLE_TEXT[l.role]) : id;
  };
  const ready = api.provider?.ready === true;

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
        <Switch checked={whole} onChange={chat.setWhole} label={w(S.chatWholeToggle)} />
        <div className="text-sm text-text-primary" data-chat-scope={whole ? 'whole' : expanded.join(' ')}>
          {whole ? w(S.chatScopeWhole) : scope.length ? (
            <>
              <p>{fill(w(S.chatScopeSelection), { n: scope.length, names: scope.map(nameOf).join('، ') })}</p>
              {inside.length ? <p className="text-xs text-text-muted">{fill(w(S.chatScopeIncludes), { names: [...new Set(inside.map(nameOf))].join('، ') })}</p> : null}
            </>
          ) : <span className="text-text-muted">{w(S.chatScopeNone)}</span>}
        </div>
        <Textarea rows={3} value={text} maxLength={600} placeholder={w(S.chatPlaceholder)} aria-label={w(S.chatPlaceholder)} disabled={!ready || phase.kind === 'sending'} onChange={(e) => chat.setText(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          {phase.kind === 'sending' ? (
            <Button size="sm" variant="ghost" onClick={chat.stop}>{w(S.chatCancel)}</Button>
          ) : (
            <Button size="sm" variant="primary" disabled={!ready || !text.trim() || (!whole && !scope.length)} onClick={() => void chat.send(text)}>{w(S.chatSend)}</Button>
          )}
          {phase.kind === 'sending' ? <span className="self-center text-sm text-text-muted" role="status">{w(S.aiBusy)}</span> : null}
        </div>
      </section>

      {phase.kind === 'idle' && phase.note ? (
        <div className="flex flex-col items-start gap-1" role="status" data-chat-note>
          <p className="text-sm text-text-secondary">{phase.note}</p>
          {phase.usageLink ? <Button size="sm" variant="ghost" onClick={api.goSettings}>{w(S.chatUsageLink)}</Button> : null}
        </div>
      ) : null}
      {phase.kind === 'error' ? <p className="text-sm text-danger" role="alert">{phase.message}</p> : null}
      {phase.kind === 'stale' ? (
        <div className="flex flex-col gap-2" role="alert" data-chat-stale>
          <p className="text-sm text-text-secondary">{w(S.chatStale)}</p>
          <Button size="sm" onClick={chat.retry}>{w(S.chatRetryCurrent)}</Button>
        </div>
      ) : null}
      {phase.kind === 'preview' ? <PatchPreview phase={phase} nameOf={nameOf} applying={applying} onApply={() => void chat.apply()} onDiscard={chat.discard} lang={lang} /> : null}
    </div>
  );
}

/** The re-layout an answer asks for, in words, so Apply never hides that the whole design is laid out again. */
function rebuildLine(r: RebuildRequest, w: (t: { ar: string; en: string; ckb: string }) => string, lang: 'ar' | 'en' | 'ckb'): string {
  if (r.kind === 'variant') return fill(w(S.chatDiffRebuildVariant), { name: VARIANT_LABELS[r.variant]?.[lang] ?? r.variant });
  if (r.kind === 'priority') return fill(w(S.chatDiffRebuildPriority), { name: w(PRIORITY_TEXT[r.priority]) });
  const name = r.format.id === 'custom' ? `${r.format.width}×${r.format.height}` : w(FORMAT_TEXT[r.format.id]);
  return fill(w(S.chatDiffRebuildFormat), { name });
}

function PatchPreview({ phase, nameOf, applying, onApply, onDiscard, lang }: { phase: Extract<ChatPhase, { kind: 'preview' }>; nameOf(id: string): string; applying: boolean; onApply(): void; onDiscard(): void; lang: 'ar' | 'en' | 'ckb' }) {
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
          {a.rebuild ? <p className="text-sm text-warning" data-patch-rebuild={a.rebuild.kind}>{rebuildLine(a.rebuild, w, lang)}</p> : null}
          {a.changed.length || !a.rebuild ? <p className="text-sm"><span className="text-text-muted">{w(S.chatDiffChanged)}: </span>{a.changed.length ? a.changed.map(nameOf).join('، ') : '—'}</p> : null}
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
        {/* A cancel landing while Apply saves is exactly the race that saved a discarded answer (spec §29). */}
        <Button size="sm" variant="ghost" disabled={applying} onClick={onDiscard}>{w(S.discard)}</Button>
      </div>
    </div>
  );
}
