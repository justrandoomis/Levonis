import type { ReactNode } from 'react';
import { useLanguage } from '../../LanguageContext';
import { Sheet } from '../ui/Overlay';
import Spinner from '../ui/Spinner';

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
        <h2 className="text-white font-bold text-[16px] leading-snug">{title}</h2>
        {children && <div className="text-zinc-400 text-[13px] mt-2 leading-relaxed">{children}</div>}
        <p role="alert" aria-live="assertive" className="text-red-400 text-[12.5px] mt-3 min-h-[1.25em]">
          {error}
        </p>
        {footer}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="flex-1 min-h-[44px] rounded-xl border border-zinc-700 text-zinc-200 text-[13.5px] font-bold hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:opacity-50"
          >
            {loc('ليس الآن', 'Not now', 'ئێستا نا')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
            data-confirm-sheet="confirm"
            className={`flex-1 min-h-[44px] rounded-xl text-white text-[13.5px] font-bold hover:brightness-110 transition-[filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-50 inline-flex items-center justify-center gap-2 ${
              tone === 'danger' ? 'bg-[#ef233c]' : 'bg-olive'
            }`}
          >
            {busy && <Spinner size="sm" delayMs={0} decorative className="text-white" />}
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
