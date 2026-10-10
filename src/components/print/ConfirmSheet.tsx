import type { ReactNode } from 'react';
import { useLanguage } from '../../LanguageContext';
import { Sheet } from '../ui/Overlay';
import { Button } from '../ui/Button';

/**
 * THE ONE CONFIRMATION SHAPE OF THE REQUEST SCREENS — a sheet, never `window.confirm`.
 *
 * It can be dragged away, it says what will happen before asking, and the
 * answer to a refused action appears INSIDE it (decoded from the server's
 * code into the reader's language) instead of in a browser alert that loses
 * the context. While the request is in flight neither the scrim nor Escape can
 * close it, so a result cannot land on a screen that has moved on.
 */
export default function ConfirmSheet({
  open,
  title,
  children,
  confirmLabel,
  busyLabel,
  tone = 'primary',
  busy,
  error,
  footer,
  confirmDisabled = false,
  onConfirm,
  onClose,
  testId,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  tone?: 'primary' | 'danger';
  busy: boolean;
  error: string;
  /** Anything that belongs under the error — a way out of it, for instance. */
  footer?: ReactNode;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  testId?: string;
}) {
  const { loc } = useLanguage();
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={close}
      label={title}
      dismissOnEscape={!busy}
      dismissOnScrim={!busy}
      panelClassName="w-full sm:max-w-md"
      testId={testId}
    >
      <div className="px-5 pb-6 pt-2">
        <h2 className="text-text-primary font-bold text-[16px] leading-snug">{title}</h2>
        {children && <div className="text-text-secondary text-[13px] mt-2 leading-relaxed">{children}</div>}
        <p role="alert" aria-live="assertive" className="text-red-400 text-[12.5px] mt-3 min-h-[1.25em]">
          {error}
        </p>
        {footer}
        <div className="mt-3 flex gap-2">
          <Button variant="secondary" onClick={close} disabled={busy} className="flex-1">
            {loc('ليس الآن', 'Not now', 'ئێستا نا')}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={busy}
            loadingLabel={busyLabel}
            disabled={confirmDisabled}
            data-confirm-sheet="confirm"
            className="flex-1"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
