import React from 'react';
import { RotateCcw, X } from 'lucide-react';
import FinderProgress from './FinderProgress';

/**
 * THE FINDER'S TOP BAR (CATALOG_DISCOVERY §8, mockups 5–7): ✕ back to where the
 * finder was opened, the step label (announced), and «تخطَّ» on the steps that
 * allow it — or, on the results, the «من جديد» restart. The 6-segment progress
 * bar sits under it while a question is on screen.
 */
export default function FinderChrome({
  closeLabel,
  onClose,
  title,
  end,
  progress,
  wide = false,
}: {
  closeLabel: string;
  onClose: () => void;
  /** «السؤال 2 من 6» or «النتائج». Announced politely when it changes. */
  title: string;
  /** The trailing control: skip, restart, or nothing. */
  end?: React.ReactNode;
  progress?: { current: number; total: number; label: string } | null;
  /** The results use a wider column (960) than the questions (640). */
  wide?: boolean;
}) {
  return (
    <div className="sticky top-0 z-10 bg-canvas/90 pt-[max(8px,env(safe-area-inset-top))] backdrop-blur-md supports-[backdrop-filter]:bg-canvas/80">
      <div className={`mx-auto w-full px-4 ${wide ? 'max-w-[960px]' : 'max-w-[640px]'}`}>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 py-1.5">
          <div className="flex justify-start">
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              title={closeLabel}
              className="grid size-11 place-items-center rounded-full border border-border-subtle bg-surface text-text-primary transition-[background-color,transform] duration-100 hover:bg-surface-raised active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none"
            >
              <X aria-hidden="true" className="size-5" strokeWidth={2} />
            </button>
          </div>
          <p aria-live="polite" className="truncate text-center text-[13px] font-bold text-text-secondary">
            {title}
          </p>
          <div className="flex justify-end">{end}</div>
        </div>
        {progress ? (
          <div className="pb-3 pt-1.5">
            <FinderProgress current={progress.current} total={progress.total} label={progress.label} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The trailing text control — «تخطَّ» / «من جديد». 44 px tall, quiet. */
export function ChromeTextButton({
  onClick,
  label,
  ariaLabel,
  restart = false,
}: {
  onClick: () => void;
  label: string;
  ariaLabel?: string;
  restart?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[14px] font-bold text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      {restart ? <RotateCcw aria-hidden="true" className="size-4" /> : null}
      {label}
    </button>
  );
}
