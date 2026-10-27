/**
 * ONE READ, WITH ITS THREE HONEST STATES — loading, an error with a retry, or
 * the server's answer — for a cloud screen:
 *
 *   const dash = useCloudQuery((signal) => getDashboard({ signal }), [dashboardVersion]);
 *   if (dash.error) return <CloudErrorState error={dash.error} onRetry={dash.reload} />;
 *   if (!dash.data) return <CloudPageSkeleton />;
 *
 * The request is cancelled when the screen leaves or the inputs change, and a
 * cancelled request is never shown as an error. Nothing is cached: every
 * mount asks the server again (a balance read from memory could be stale).
 */
import { useCallback, useEffect, useState } from 'react';
import { isAborted } from '../lib/api';

export interface CloudQuery<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

export function useCloudQuery<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): CloudQuery<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    load(ac.signal)
      .then((d) => {
        if (ac.signal.aborted) return;
        setData(d);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted || isAborted(e)) return;
        setError(e ?? new Error('failed'));
        setLoading(false);
      });
    return () => ac.abort();
    // `load` is the caller's closure; `deps` are what it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, loading, reload };
}
