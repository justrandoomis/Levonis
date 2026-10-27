/**
 * THE WIZARD HEADER (community UI plan C4, §4; IMG_8474, IMG_8482, IMG_8477,
 * IMG_8470): the section page header with the step title, the draft button
 * at the inline end, and the four bars of the progress under them.
 *
 *   «› الملفات والفكرة              [🗎 احفظ مسودة]»
 *   «████ ▬▬▬▬ ▬▬▬▬ ▬▬▬▬   طلب طباعة · 1 من 4»
 *
 * THE SAVE STATUS LIVES IN THE BUTTON (plan §4): «احفظ مسودة» while there is
 * something to save, «يُحفظ…» while it goes, «محفوظ» once the server has it,
 * and, when a save failed or the connection is gone, the words of the
 * failure with the button that tries again. A published request has no
 * autosave: its status says whether there are changes to publish, and the
 * button is only a status (its changes go out with «احفظ التعديلات»).
 *
 * Only a failure, the loss of the connection and a conflict are announced to
 * a screen reader (design critique 19); «يُحفظ…» and «محفوظ» are not, every
 * few seconds. On a narrow screen (under 390 px, Sorani at 360 and 320) the
 * button keeps its icon and its full words as its name, so the title keeps
 * its row.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, Check, FileText, LogIn, RotateCcw } from 'lucide-react';
import SectionPageHeader from '../../kit/SectionPageHeader';
import { StepProgress } from '../../kit/display';
import Spinner from '../../../ui/Spinner';
import type { SaveStatus } from './persistence';
import { fill, type EditorStrings } from './strings';

/** Where a save stands, in a short word (the button) and a long one (its name). */
export function statusWords(status: SaveStatus, edit: boolean, t: EditorStrings): { short: string; long: string; tone: 'quiet' | 'warn' | 'bad' } {
  if (edit) {
    return status === 'dirty' ? { short: t.statusEditDirty, long: t.statusEditDirtyLong, tone: 'warn' } : { short: t.statusEditClean, long: t.statusEditClean, tone: 'quiet' };
  }
  switch (status) {
    case 'saving':
      return { short: t.statusSaving, long: t.statusSaving, tone: 'quiet' };
    case 'dirty':
      return { short: t.statusDirty, long: t.statusDirty, tone: 'quiet' };
    case 'failed':
      return { short: t.statusFailed, long: t.statusFailedLong, tone: 'bad' };
    case 'offline':
      return { short: t.statusOffline, long: t.statusOfflineLong, tone: 'bad' };
    case 'conflict':
      return { short: t.statusConflict, long: t.conflictTitle, tone: 'bad' };
    case 'signedOut':
      return { short: t.statusSignedOut, long: t.sessionExpired, tone: 'bad' };
    default:
      return { short: t.statusSaved, long: t.statusSavedLong, tone: 'quiet' };
  }
}

export const WIZARD_STEPS = [1, 2, 3, 4] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** The step an address names, held to 1–4 (a missing or broken `?step=` is step 1). */
export function stepOf(raw: string | null | undefined): WizardStep {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return n === 2 || n === 3 || n === 4 ? n : 1;
}

/** The title of each step, in the words of the references. */
export function stepTitle(step: WizardStep, t: EditorStrings, edit = false): string {
  if (step === 2) return t.stepSettings;
  if (step === 3) return t.stepDelivery;
  if (step === 4) return edit ? t.stepEditReview : t.stepReview;
  return t.stepFiles;
}

/** What the draft button says and does for a status. */
export function saveButtonWords(status: SaveStatus, edit: boolean, t: EditorStrings): { label: string; long: string; action: 'save' | 'retry' | 'none'; tone: 'quiet' | 'warn' | 'bad' } {
  if (edit) {
    const w = statusWords(status, true, t);
    return { label: w.short, long: w.long, action: 'none', tone: w.tone };
  }
  switch (status) {
    case 'saving':
      return { label: t.statusSaving, long: t.statusSaving, action: 'none', tone: 'quiet' };
    case 'saved':
      return { label: t.statusSaved, long: t.statusSavedLong, action: 'none', tone: 'quiet' };
    case 'failed':
    case 'offline': {
      const w = statusWords(status, false, t);
      return { label: w.short, long: w.long, action: 'retry', tone: 'bad' };
    }
    case 'conflict':
    case 'signedOut': {
      const w = statusWords(status, false, t);
      return { label: w.short, long: w.long, action: 'none', tone: 'bad' };
    }
    default:
      return { label: t.saveDraft, long: t.saveDraft, action: 'save', tone: 'quiet' };
  }
}

export function WizardHeader({
  step,
  title,
  status,
  edit,
  onBack,
  onSave,
  t,
}: {
  step: WizardStep;
  title: string;
  status: SaveStatus;
  /** A published request: the status only, no draft to save. */
  edit: boolean;
  onBack: () => void;
  onSave: () => void;
  t: EditorStrings;
}) {
  // The button keeps its words while they fit on the title row; when the row
  // would wrap (a long title, Sorani, a narrow phone) it is the icon alone,
  // its words its name. Measured before paint, again on a resize.
  const box = useRef<HTMLDivElement | null>(null);
  const [roomy, setRoomy] = useState(true);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useLayoutEffect(() => {
    setRoomy(true);
  }, [title, width, status]);
  useLayoutEffect(() => {
    if (!roomy || !box.current) return;
    const back = box.current.querySelector('[data-section-back]');
    const door = box.current.querySelector('[data-editor-status]');
    if (back && door && door.getBoundingClientRect().top > back.getBoundingClientRect().bottom - 4) setRoomy(false);
  }, [roomy, title, width, status, edit]);
  const w = saveButtonWords(status, edit, t);
  const Icon =
    status === 'signedOut'
        ? LogIn
        : w.action === 'retry'
          ? RotateCcw
          : w.tone === 'bad'
            ? AlertCircle
            : status === 'saved' || (edit && status !== 'dirty')
              ? Check
              : FileText;
  const tone = w.tone === 'bad' ? 'text-danger' : w.tone === 'warn' ? 'text-warning' : 'text-text-primary';
  const busy = status === 'saving';
  const glyph = busy ? <Spinner size="sm" delayMs={0} decorative /> : <Icon aria-hidden="true" className="h-5 w-5 shrink-0" strokeWidth={1.75} />;
  const name = w.long === w.label ? w.label : `${w.label}: ${w.long}`;
  const inner = (
    <>
      {glyph}
      {roomy ? <span className="truncate">{w.label}</span> : <span className="sr-only">{name}</span>}
    </>
  );
  const cls = `cm-raised inline-flex min-h-11 items-center gap-1.5 rounded-md text-[15px] font-semibold ${roomy ? 'px-3' : 'w-11 justify-center'} ${tone}`;
  const trailing =
    w.action === 'none' ? (
      <span className={cls} title={w.long} aria-busy={busy || undefined} data-editor-status={status}>
        {inner}
      </span>
    ) : (
      <button
        type="button"
        onClick={onSave}
        title={w.long}
        aria-label={roomy && w.long === w.label ? undefined : name}
        className={`${cls} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
        data-editor="save"
        data-editor-status={status}
      >
        {inner}
      </button>
    );
  return (
    <div ref={box} data-wizard-header={step}>
      <SectionPageHeader title={<span className="text-[22px]">{title}</span>} titleId="editor-step-title" onBack={onBack} backTo="/requests" trailing={trailing} />
      <StepProgress step={step} label={t.progressLabel} caption={fill(t.stepCaption, { n: step })} className="mb-4 mt-1" />
      <span className="sr-only" role={w.tone === 'bad' ? 'alert' : undefined}>
        {w.tone === 'bad' && !edit ? w.long : ''}
      </span>
    </div>
  );
}
