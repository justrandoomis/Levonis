/**
 * The one data hook of the farm.
 *
 *   - GET /api/farm/state on mount, again every 20 s while the page is
 *     visible, and whenever the tab regains focus (useFreshOnReturn);
 *   - every mutation goes through `run(actionId, call)`: a fresh idempotency
 *     key per attempt (kept only for a retry of a NETWORK failure of that same
 *     attempt), no optimistic write — the screen re-renders from the state
 *     the server returns (mutations answer without the public config, so the
 *     one already held is kept while `config_version` is unchanged), or from
 *     a fresh GET when a response lacks the state or the config moved;
 *   - after a server refusal the state is re-read too, so an OFFER_EXPIRED or
 *     a PRINTER_UNAVAILABLE leaves the screen showing what is true now;
 *   - one refusal is retried: 409 STATE_CHANGED means the row moved under the
 *     intent, so the state is re-read and the intent sent ONCE more with a
 *     fresh key; a second refusal is shown ("Your farm changed…"). An
 *     IDEMPOTENCY_KEY_REUSED is an ordinary refusal: shown, state refreshed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, newIdempotencyKey } from '../../../lib/api';
import { farmApi, isFarmState, withPreviousConfig, type FarmState } from '../../../lib/farmApi';
import { useFreshOnReturn } from '../../../lib/useFreshOnReturn';
import { isStateChanged } from '../errors';
import { useServerClock } from './useServerClock';

/** `result` is the server's answer body (state + the route's own fields, e.g. a collect's `delivered`), for the caller to read a fact from — never to patch state with. */
export type RunResult = { ok: true; result: unknown } | { ok: false; error: unknown };

/** The refusal `run` answers with while another intent is still in flight — not a server error, nothing to show. */
export const BUSY: unique symbol = Symbol('farm-busy');

export interface FarmStateKit {
  state: FarmState | null;
  loading: boolean;
  error: unknown;
  /** The id of the action in flight, or null. */
  busy: string | null;
  /** Estimated server time (ms), ticking once a second while visible. */
  now: number;
  reload: () => Promise<void>;
  run: (actionId: string, call: (idempotencyKey: string) => Promise<unknown>) => Promise<RunResult>;
}

export function useFarmState(): FarmStateKit {
  const [state, setState] = useState<FarmState | null>(null);
  const stateRef = useRef<FarmState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const clock = useServerClock();
  const sync = clock.sync;

  const apply = useCallback(
    (s: FarmState) => {
      sync(s.now);
      stateRef.current = s;
      setState(s);
      setError(null);
    },
    [sync]
  );

  const reload = useCallback(async () => {
    try {
      apply(await farmApi.state());
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useFreshOnReturn(reload, { pollWhileVisibleMs: 20_000, minIntervalMs: 5_000, enabled: busy === null });

  const run = useCallback(
    async (actionId: string, call: (idempotencyKey: string) => Promise<unknown>): Promise<RunResult> => {
      if (busyRef.current) return { ok: false, error: BUSY };
      busyRef.current = actionId;
      setBusy(actionId);
      try {
        for (let attempt = 0; ; attempt++) {
          const key = keys.current.get(actionId) ?? newIdempotencyKey();
          keys.current.set(actionId, key);
          try {
            const res = withPreviousConfig(await call(key), stateRef.current);
            keys.current.delete(actionId);
            if (isFarmState(res)) apply(res);
            else await reload();
            return { ok: true, result: res };
          } catch (e) {
            // A network failure may be retried with the SAME key (the server may
            // have applied it). Any server verdict ends the attempt, and the
            // screen re-reads the truth so a stale offer or a busy printer is
            // shown as it is now.
            const network = e instanceof ApiError && e.status === 0;
            if (network) return { ok: false, error: e };
            keys.current.delete(actionId);
            // STATE_CHANGED: re-read the state and send the intent once more,
            // as a new attempt with a new key. A second refusal is shown.
            if (attempt === 0 && isStateChanged(e)) {
              await reload();
              continue;
            }
            void reload();
            return { ok: false, error: e };
          }
        }
      } finally {
        busyRef.current = null;
        setBusy(null);
      }
    },
    [apply, reload]
  );

  return { state, loading, error, busy, now: clock.now, reload, run };
}
