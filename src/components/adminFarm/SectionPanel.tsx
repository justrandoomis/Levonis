/**
 * One accordion card per top-level section of the configuration document:
 * a numbered header with the section's name, a one-line summary when closed
 * (field count, private chip, unsaved mark), the editor tree when open, and
 * the section's own save bar — Save writes THIS section alone against the
 * document version, Discard returns to the last server copy, Reset to
 * defaults sits behind a typed RESET window.
 */
import React, { useId, useRef, useState } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import { Banner, btnGhost, btnDanger } from '../adminProducts/form/formUi';
import { Overlay } from '../ui/Overlay';
import { CatalogEditor, GroupEditor, type EditorCtx } from './editors';
import { btnGold } from './inputs';
import { labelFor } from './labels';
import { sectionCount, shapeOf } from './schema';

export interface SectionNote {
  ok: boolean;
  text: string;
}

export interface SectionPanelProps {
  n: number;
  section: string;
  open: boolean;
  onToggle: () => void;
  draft: unknown;
  fallback: unknown;
  ctx: EditorCtx;
  dirty: boolean;
  saving: boolean;
  /** False when the server's section list does not name this key (nothing to PUT to). */
  savable: boolean;
  isPrivate: boolean;
  note: SectionNote | null;
  /** `problems` of a FARM_CONFIG_INVALID refusal of THIS section's last save. */
  invalid: string[];
  /** Problems the server reports about the STORED document that belong to this section. */
  storedProblems: string[];
  onChange: (v: unknown) => void;
  onSave: () => void;
  onDiscard: () => void;
  /** Resolves true when the reset landed (the window closes), false when it was refused (the window stays). */
  onReset: () => Promise<boolean>;
}

export function SectionPanel({
  n,
  section,
  open,
  onToggle,
  draft,
  fallback,
  ctx,
  dirty,
  saving,
  savable,
  isPrivate,
  note,
  invalid,
  storedProblems,
  onChange,
  onSave,
  onDiscard,
  onReset,
}: SectionPanelProps) {
  const { s, lang } = ctx;
  const lb = labelFor(section, lang);
  const count = sectionCount(draft);
  const hasProblem = storedProblems.length > 0 || invalid.length > 0;
  const shape = shapeOf(draft, fallback);

  const [resetOpen, setResetOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [resetting, setResetting] = useState(false);
  const resetBtn = useRef<HTMLButtonElement | null>(null);
  const resetTitleId = useId();

  const runReset = async () => {
    if (confirmText !== 'RESET' || resetting) return;
    setResetting(true);
    try {
      const ok = await onReset();
      if (ok) {
        setResetOpen(false);
        setConfirmText('');
      }
    } finally {
      setResetting(false);
    }
  };

  return (
    <section
      data-farm-section={section}
      className={`min-w-0 rounded-xl border overflow-hidden ${
        hasProblem ? 'border-red-500/40 bg-red-500/[0.03]' : open ? 'border-gold/30 bg-zinc-900/60' : 'border-zinc-800 bg-zinc-900/40'
      }`}
    >
      <button
        type="button"
        data-farm-section-toggle={section}
        aria-expanded={open}
        onClick={onToggle}
        className="w-full min-w-0 flex items-center gap-2.5 px-3 h-12 text-start hover:bg-zinc-800/30 transition-colors"
      >
        <span
          className={`shrink-0 w-6 h-6 rounded-md grid place-items-center text-[10px] font-black tabular-nums ${
            open ? 'bg-gold text-black' : 'bg-zinc-800 text-zinc-400'
          }`}
        >
          {n}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-bold text-white truncate">
            {lb.label}
            {lb.secondary && <span className="hidden sm:inline text-[10px] font-medium text-zinc-500"> {lb.secondary}</span>}
            <span className="ms-2 font-mono text-[10px] font-medium text-zinc-600" dir="ltr">
              {section}
            </span>
          </span>
          {!open && (
            <span className="block text-[10.5px] text-zinc-500 truncate tabular-nums">
              {count.catalog ? s.entriesCount(count.entries) : s.fieldsCount(count.entries)}
              {storedProblems.length > 0 && <span className="text-red-400"> · {s.problemsInSection(storedProblems.length)}</span>}
            </span>
          )}
        </span>
        {isPrivate && (
          <span className="shrink-0 h-5 px-1.5 rounded-full border border-zinc-700 text-[10px] font-bold text-zinc-400 grid place-items-center">
            {s.privateChip}
          </span>
        )}
        {dirty && (
          <span className="shrink-0 h-5 px-1.5 rounded-full bg-gold/15 text-gold text-[10px] font-bold grid place-items-center" data-farm-dirty={section}>
            {s.unsavedMark}
          </span>
        )}
        <ChevronDown className={`shrink-0 w-4 h-4 text-zinc-500 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div className="p-3 border-t border-zinc-800/70 min-w-0">
          {lb.hint && <p className="mb-3 text-[12px] text-zinc-400 leading-relaxed">{lb.hint}</p>}

          {storedProblems.length > 0 && (
            <Banner kind="warn">
              <p className="font-bold">{s.problemsTitle}</p>
              <ul className="mt-1 space-y-0.5" dir="ltr">
                {storedProblems.map((p) => (
                  <li key={p} className="font-mono text-[11px]">{p}</li>
                ))}
              </ul>
            </Banner>
          )}

          {shape === 'catalog' ? (
            <CatalogEditor path={section} value={draft} fallback={fallback} onChange={onChange} ctx={ctx} />
          ) : (
            <GroupEditor path={section} value={draft} fallback={fallback} onChange={onChange} ctx={ctx} />
          )}

          {invalid.length > 0 && (
            <div role="alert" className="mt-3">
              <Banner kind="error">
                <p className="font-bold">{s.invalidTitle}</p>
                <ul className="mt-1 space-y-0.5" dir="ltr">
                  {invalid.map((p) => (
                    <li key={p} className="font-mono text-[11px]">{p}</li>
                  ))}
                </ul>
              </Banner>
            </div>
          )}
          {note && (
            <p role={note.ok ? 'status' : 'alert'} className={`mt-3 text-[12px] ${note.ok ? 'text-emerald-300' : 'text-red-400'}`} data-farm-note={section}>
              {note.text}
            </p>
          )}

          <div className="sticky bottom-0 -mx-3 -mb-3 mt-3 px-3 py-2.5 bg-zinc-950/90 backdrop-blur-sm border-t border-zinc-800/70 flex flex-wrap items-center gap-2">
            <button type="button" data-farm-save={section} onClick={onSave} disabled={!dirty || saving || !savable} className={btnGold}>
              {saving ? s.saving : dirty ? s.save : s.noChanges}
            </button>
            <button type="button" onClick={onDiscard} disabled={!dirty || saving} className={btnGhost}>
              {s.discard}
            </button>
            <span className="flex-1" aria-hidden="true" />
            <button
              type="button"
              ref={resetBtn}
              data-farm-reset={section}
              onClick={() => {
                setConfirmText('');
                setResetOpen(true);
              }}
              disabled={saving || !savable}
              aria-haspopup="dialog"
              className={btnDanger}
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              {s.resetDefaults}
            </button>
          </div>
        </div>
      )}

      <Overlay
        open={resetOpen}
        onClose={() => {
          if (!resetting) setResetOpen(false);
        }}
        labelledBy={resetTitleId}
        anchor={resetBtn}
        dismissOnEscape={!resetting}
        dismissOnScrim={!resetting}
        testId="farm-reset-section"
        panelClassName="w-full max-w-md"
      >
        <div className="p-5 sm:p-6">
          <h3 id={resetTitleId} className="text-white font-bold text-[16px]">{s.resetTitle(lb.label)}</h3>
          <p className="text-zinc-300 text-[13px] mt-2 leading-relaxed">{s.resetBody}</p>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runReset();
            }}
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            placeholder="RESET"
            aria-label={s.typeReset}
            className="mt-4 w-full min-h-[44px] rounded-xl bg-zinc-900 border border-zinc-700 px-3 text-white font-mono tracking-widest outline-none focus-visible:ring-2 focus-visible:ring-red-500/70"
          />
          <p className="mt-1.5 text-[11px] text-zinc-500">{s.typeReset}</p>
          <div className="mt-5 flex flex-col-reverse sm:flex-row gap-2.5">
            <button type="button" onClick={() => setResetOpen(false)} disabled={resetting} className={`${btnGhost} flex-1 h-11`}>
              {s.cancel}
            </button>
            <button
              type="button"
              onClick={() => void runReset()}
              disabled={confirmText !== 'RESET' || resetting}
              className={`${btnDanger} flex-1 h-11`}
              data-farm-reset-confirm={section}
            >
              {resetting ? s.working : s.confirmReset}
            </button>
          </div>
        </div>
      </Overlay>
    </section>
  );
}
