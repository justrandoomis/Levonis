/**
 * Health (`01-TARGET.md` §11.3): every service exposes RPC `health()` and HTTP
 * `/health` on its dark URL; a production Worker has no URL, so the probe goes
 * through the gateway/core `GET /api/health?deep=1` with a constant-time
 * compared `x-health-probe: <HEALTH_PROBE_TOKEN>` header, which fans out
 * `health()` to every bound service with a 2-s budget.
 */
import type { HealthReport } from '@levonis/contracts/rpc/common';
import { HEALTH_PROBE_HEADER } from '@levonis/contracts/http/common';
import { constantTimeEqual } from './keys';
import { withTimeout } from './rpc';

export { HEALTH_PROBE_HEADER };
export const DEEP_HEALTH_BUDGET_MS = 2_000;

export interface HealthInput {
  svc: string;
  ver: string;
  db?: D1Database | null;
  outboxLagS?: () => Promise<number | null>;
  deps?: Record<string, { health(): Promise<HealthReport> } | undefined>;
  budgetMs?: number;
}

/** Builds the report: a cheap `SELECT 1` on the own database, the outbox lag, and bound dependencies within the budget. */
export async function healthReport(input: HealthInput): Promise<HealthReport> {
  const checks: HealthReport['checks'] = {};
  let ok = true;
  if (input.db) {
    try {
      await input.db.prepare('SELECT 1 AS one').first();
      checks.db = 'ok';
    } catch {
      checks.db = 'fail';
      ok = false;
    }
  } else checks.db = 'skipped';
  if (input.outboxLagS) {
    try {
      checks.outbox_lag_s = await input.outboxLagS();
    } catch {
      checks.outbox_lag_s = null;
    }
  }
  if (input.deps) {
    const budget = input.budgetMs ?? DEEP_HEALTH_BUDGET_MS;
    checks.deps = await Promise.all(
      Object.entries(input.deps)
        .filter(([, d]) => !!d)
        .map(async ([name, d]) => {
          const started = Date.now();
          try {
            const r = await withTimeout(d!.health(), budget, () => new Error('health timeout'));
            if (!r.ok) ok = false;
            return { name, ok: r.ok, ms: Date.now() - started, ver: r.ver };
          } catch (e) {
            ok = false;
            return { name, ok: false, ms: Date.now() - started, error: (e as Error).message };
          }
        })
    );
  }
  return { ok, svc: input.svc, ver: input.ver, checks };
}

/** True when the request carries the probe token (constant-time compare). A missing token config never matches. */
export function isHealthProbe(headers: Headers, token: string | undefined): boolean {
  const given = headers.get(HEALTH_PROBE_HEADER);
  if (!given || !token) return false;
  return constantTimeEqual(given, token);
}

/** The legacy `GET /api/health` body, unchanged. */
export function legacyHealthBody(ver?: string): { success: true; status: 'ok'; version?: string } {
  return ver ? { success: true, status: 'ok', version: ver } : { success: true, status: 'ok' };
}
