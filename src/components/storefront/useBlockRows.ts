import { useEffect, useState } from 'react';

/**
 * Rows a block shows: the ones that arrived with the store, or — when the
 * store's answer did not carry them (an older payload, a preview that did not
 * ask) — the ones `load` fetches once. `null` while loading; a failed load is
 * an empty list, never a broken block.
 */
export function useBlockRows<T>(initial: T[] | null | undefined, load: () => Promise<T[]>, enabled = true): T[] | null {
  const [rows, setRows] = useState<T[] | null>(initial ?? null);
  useEffect(() => {
    if (initial) {
      setRows(initial);
      return;
    }
    if (!enabled) {
      setRows([]);
      return;
    }
    let alive = true;
    load()
      .then((r) => alive && setRows(r))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
    // `load` comes from the memoised runtime; `initial` from the memoised data.
  }, [initial, load, enabled]);
  return rows;
}
