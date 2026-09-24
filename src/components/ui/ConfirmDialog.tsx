/**
 * CONFIRMDIALOG — the replacement for `window.confirm`, and `useConfirm`, the
 * one-line way to ask.
 *
 * About twenty native `confirm()`/`alert()` calls live in the merchant tabs.
 * A native dialog cannot be read in the merchant's language chrome, cannot say
 * what will actually be lost, cannot be styled as destructive, freezes every
 * timer on the page, and on iOS may be suppressed outright after a few.
 *
 * WHAT A CONFIRMATION MUST SAY (Apple HIG «Alerts», and apple-design §6, §10):
 *   a title that names the action as a question («حذف المنتج؟»), the
 *   CONSEQUENCE in one sentence («سيختفي من متجرك ولا يمكن التراجع»), a
 *   confirm button whose label is the verb itself — never «نعم» — and an
 *   obvious way out. A destructive verb is drawn destructive, and focus starts
 *   on CANCEL, so an Enter pressed out of habit never deletes anything.
 *
 * It is an `alertdialog` on the shared `Overlay`, so it inherits the whole
 * contract: the stack (Escape answers "cancel" for this dialog only, never for
 * the sheet it was opened from), the focus trap and the return of focus to
 * the control that asked. On a phone it rises from the bottom, where the
 * thumb is; from `sm` up it is a centred window.
 *
 * TWO WAYS TO USE IT.
 *
 *   const [confirm, confirmDialog] = useConfirm();
 *   …
 *   if (!(await confirm({ title, consequence, confirmLabel, destructive: true }))) return;
 *   …
 *   return <>{…}{confirmDialog}</>;
 *
 * or controlled, `<ConfirmDialog open … onConfirm onCancel busy error />`, when
 * the work itself should run INSIDE the dialog (the confirm button shows it is
 * busy, refuses a second press, and a failure keeps the dialog open with the
 * reason in it instead of closing on a lie).
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { Overlay } from './Overlay';
import { Button } from './Button';

export interface ConfirmOptions {
  /** The action, as a question: «حذف المنتج؟». */
  title: React.ReactNode;
  /** What happens if they go ahead — the sentence that makes the choice informed. */
  consequence?: React.ReactNode;
  /** The verb on the button: «حذف», «إلغاء الطلب». Defaults to «تأكيد». */
  confirmLabel?: React.ReactNode;
  /** Defaults to «إلغاء». */
  cancelLabel?: React.ReactNode;
  /** Something is lost: the button is drawn destructive and focus starts on cancel. */
  destructive?: boolean;
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  /** May return a promise; the dialog stays open and busy until it settles. */
  onConfirm: () => unknown;
  onCancel: () => void;
  /** Busy from outside: the confirm button spins and nothing can be pressed twice. */
  busy?: boolean;
  /** Why the last attempt failed, shown inside the dialog. */
  error?: React.ReactNode;
  testId?: string;
}

export function ConfirmDialog({
  open,
  title,
  consequence,
  confirmLabel,
  cancelLabel,
  destructive = false,
  onConfirm,
  onCancel,
  busy = false,
  error,
  testId,
}: ConfirmDialogProps) {
  const { loc } = useLanguage();
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const [working, setWorking] = useState(false);
  const locked = busy || working;

  const confirm = () => {
    const result = onConfirm();
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      setWorking(true);
      const done = () => setWorking(false);
      (result as PromiseLike<unknown>).then(done, done);
      return result;
    }
    return undefined;
  };

  return (
    <Overlay
      open={open}
      onClose={() => {
        if (!locked) onCancel();
      }}
      alert
      labelledBy={titleId}
      describedBy={consequence || error ? bodyId : undefined}
      placement="bottom"
      initialFocus={destructive ? cancelRef : confirmRef}
      dismissOnEscape={!locked}
      dismissOnScrim={!locked}
      testId={testId ?? 'confirm-dialog'}
      panelClassName="w-full sm:max-w-sm"
    >
      <div className="p-5" style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}>
        <div className="flex items-start gap-3">
          {destructive && (
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger"
            >
              <AlertTriangle className="h-[18px] w-[18px]" />
            </span>
          )}
          <div className="min-w-0">
            <h2 id={titleId} className="text-[17px] font-bold leading-snug text-text-primary">
              {title}
            </h2>
            {(consequence || error) && (
              <div id={bodyId} className="mt-1.5 space-y-2">
                {consequence && <p className="text-sm leading-relaxed text-text-secondary">{consequence}</p>}
                {error && (
                  <p role="alert" className="lv-alert lv-alert-danger text-[13px] leading-relaxed text-text-primary">
                    {error}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={locked} className="sm:min-w-24">
            {cancelLabel ?? loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
          </Button>
          <Button
            ref={confirmRef}
            variant={destructive ? 'danger' : 'primary'}
            loading={locked}
            onClick={confirm}
            className="sm:min-w-24"
            data-confirm-action
          >
            {confirmLabel ?? loc('تأكيد', 'Confirm', 'دڵنیاکردنەوە')}
          </Button>
        </div>
      </div>
    </Overlay>
  );
}

/**
 * `const [confirm, dialog] = useConfirm()` — render `dialog` once, then
 * `await confirm({...})` resolves true (confirmed) or false (cancelled,
 * dismissed, replaced by a newer question, or the component went away).
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, React.ReactElement] {
  const [asking, setAsking] = useState<ConfirmOptions | null>(null);
  const [open, setOpen] = useState(false);
  const resolver = useRef<((answer: boolean) => void) | null>(null);

  const answer = useCallback((value: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setOpen(false);
    resolve?.(value);
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    // A second question replaces the first, which is answered "no".
    resolver.current?.(false);
    setAsking(options);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  useEffect(() => () => resolver.current?.(false), []);

  const dialog = (
    <ConfirmDialog
      open={open}
      title={asking?.title ?? ''}
      consequence={asking?.consequence}
      confirmLabel={asking?.confirmLabel}
      cancelLabel={asking?.cancelLabel}
      destructive={asking?.destructive}
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
    />
  );
  return [confirm, dialog];
}
