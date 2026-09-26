import React from 'react';
import { useLanguage } from '../../LanguageContext';
import Spinner from '../ui/Spinner';

/**
 * «عرض المزيد» (§7 item 9) — a button, never an endless scroll: the footer
 * stays reachable, and the list's length is a fact the back button can
 * restore. It says how many remain, and turns into a retry after a failure.
 */
export default function LoadMore({ remaining, state, onMore }: { remaining: number; state: 'idle' | 'loading' | 'error'; onMore: () => void }) {
  const { loc, t } = useLanguage();
  if (remaining <= 0) return null;
  return (
    <div className="mt-5 flex justify-center">
      <button
        type="button"
        onClick={onMore}
        disabled={state === 'loading'}
        aria-busy={state === 'loading' || undefined}
        data-load-more
        className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border-subtle bg-surface px-5 text-[13px] font-bold text-text-primary transition-colors hover:bg-surface-raised disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {state === 'loading' ? <Spinner size="sm" /> : null}
        {state === 'error' ? t('retry') : loc('عرض المزيد', 'Load more', 'زیاتر پیشان بدە')}
        {state !== 'error' ? <span className="font-semibold tabular-nums text-text-muted">{remaining}</span> : null}
      </button>
    </div>
  );
}
