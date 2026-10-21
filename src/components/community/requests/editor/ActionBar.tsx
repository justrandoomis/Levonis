/**
 * THE EDITOR’S BAR, UNDER THE THUMB (plan P1-06; design critique 6, 11).
 *
 * Two things only, so it fits 360 px in every language: where the save
 * stands — an icon and one short word, the whole sentence as its name — and
 * the primary step, «مراجعة». When the save failed or the connection is
 * gone, the status itself is the button that tries again; there is no second
 * «احفظ» on a phone. From 640 px wide a draft also shows «احفظ».
 *
 * The bar steps aside while the soft keyboard is up (useKeyboardOpen.ts),
 * so it never covers the field being typed into, and comes back when it
 * closes. Only a failure, the loss of the connection and a conflict are
 * announced; «يُحفظ…» and «محفوظ» are not, every few seconds.
 */
import { AlertCircle, Check, CloudOff, Loader2, LogIn, RotateCcw } from 'lucide-react';
import { Button } from '../../../ui/Button';
import type { SaveStatus } from './persistence';
import type { EditorStrings } from './strings';

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

export function ActionBar({
  status,
  edit,
  hidden,
  wide,
  primaryLabel,
  primaryDisabled,
  onPrimary,
  onRetry,
  onSave,
  t,
}: {
  status: SaveStatus;
  edit: boolean;
  hidden: boolean;
  wide: boolean;
  primaryLabel: string;
  primaryDisabled?: boolean;
  onPrimary: () => void;
  onRetry: () => void;
  onSave: () => void;
  t: EditorStrings;
}) {
  const w = statusWords(status, edit, t);
  const retry = !edit && (status === 'failed' || status === 'offline');
  const Icon = status === 'saving' ? Loader2 : status === 'offline' ? CloudOff : status === 'signedOut' ? LogIn : w.tone === 'bad' ? AlertCircle : retry ? RotateCcw : Check;
  const tone = w.tone === 'bad' ? 'text-danger' : w.tone === 'warn' ? 'text-warning' : 'text-text-muted';
  const announce = w.tone === 'bad';
  const chip = (
    <>
      <Icon aria-hidden="true" className={`h-4 w-4 shrink-0 ${status === 'saving' ? 'animate-spin motion-reduce:animate-none' : ''}`} />
      <span className="min-w-0 truncate">{w.short}</span>
    </>
  );
  return (
    <div
      className={`fixed inset-x-0 bottom-0 z-30 border-t border-border-subtle bg-surface-raised px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] shadow-dock transition-transform motion-reduce:transition-none ${
        hidden ? 'pointer-events-none translate-y-full' : ''
      }`}
      data-editor-bar={hidden ? 'keyboard' : 'shown'}
      aria-hidden={hidden || undefined}
    >
      <div className="mx-auto flex max-w-2xl items-center gap-2">
        <div className={`flex min-w-0 flex-1 items-center text-[12.5px] font-semibold ${tone}`} data-editor-status={status}>
          {retry ? (
            <button
              type="button"
              onClick={onRetry}
              aria-label={w.long}
              title={w.long}
              className="-ms-2 inline-flex min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-full px-2 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {chip}
            </button>
          ) : (
            <span className="inline-flex min-w-0 max-w-full items-center gap-1.5" title={w.long}>
              {chip}
              <span className="sr-only">{w.long === w.short ? '' : w.long}</span>
            </span>
          )}
          <span className="sr-only" role={announce ? 'alert' : undefined}>
            {announce ? w.long : ''}
          </span>
        </div>
        {wide && !edit && (
          <Button variant="ghost" size="sm" className="shrink-0 whitespace-nowrap" onClick={onSave} disabled={status === 'saving' || status === 'conflict' || status === 'signedOut'} data-editor="save">
            {t.save}
          </Button>
        )}
        <Button variant="primary" className="shrink-0 whitespace-nowrap" onClick={onPrimary} disabled={primaryDisabled} data-editor="primary">
          {primaryLabel}
        </Button>
      </div>
    </div>
  );
}
