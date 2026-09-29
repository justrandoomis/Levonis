/**
 * THE SEARCH BOX'S HALF OF THE OVERLAY — what the page keeps when the overlay
 * itself is a lazy chunk (SearchOverlay.tsx): whether it is open, the two
 * elements it hangs from (the bar and the input), and the combobox
 * attributes the input carries so a screen reader hears the same control a
 * sighted person sees.
 *
 * OPENS ON FOCUS, once per focus. The overlay gives focus back to the input
 * when Escape is pressed from inside it; that programmatic focus must not
 * reopen what was just closed, so a focus within a short window after a
 * close is ignored. A click on an already-focused box and any typing reopen
 * it. `?search=1` opens it on arrival (a link from elsewhere) and is stripped
 * from the address with `replace`, so Back never re-opens it.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SetURLSearchParams } from 'react-router-dom';

/** The listbox's id — one search box per page, so one id. */
export const SEARCH_LIST_ID = 'community-search-listbox';

/** Focus that lands this soon after a close came from the overlay's own hand-back. */
const REOPEN_GUARD_MS = 300;

export function useSearchBox(params: URLSearchParams, setParams: SetURLSearchParams) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const barRef = useRef<HTMLFormElement | null>(null);
  const [open, setOpen] = useState(false);
  /** True once it has opened: the lazy chunk is mounted from then on. */
  const [ever, setEver] = useState(false);
  const closedAt = useRef(0);

  const show = useCallback(() => {
    setEver(true);
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    closedAt.current = performance.now();
    setOpen(false);
  }, []);

  const wanted = params.get('search') === '1';
  useEffect(() => {
    if (!wanted) return;
    show();
    inputRef.current?.focus({ preventScroll: true });
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.delete('search');
        return p;
      },
      { replace: true }
    );
  }, [wanted, show, setParams]);

  const inputProps = {
    ref: inputRef,
    role: 'combobox' as const,
    'aria-expanded': open,
    'aria-controls': SEARCH_LIST_ID,
    // The panel lists rows AND the overlay draws an inline completion in the
    // box (the grey tail Tab/→/Space accept), as src/components/search/LiveSearch.tsx declares.
    'aria-autocomplete': 'both' as const,
    'aria-haspopup': 'listbox' as const,
    onFocus: () => {
      if (performance.now() - closedAt.current > REOPEN_GUARD_MS) show();
    },
    onClick: show,
    // Typing, or ↓, reopens a box that Escape closed.
    onInput: show,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') show();
    },
  };

  return { open, ever, inputRef, barRef, show, close, inputProps };
}
