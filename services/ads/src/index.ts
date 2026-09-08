/**
 * `levonis-ads` — the Worker.
 *
 * Thin on purpose: the delivery engine (`deliver.ts`), the registry
 * (`registry.ts`) and the app (`app.ts`) are plain modules a test drives with
 * an in-memory database and an injected `fetch`. This file owns only what needs
 * the Workers runtime — the `WorkerEntrypoint`, the per-isolate registry and
 * key ring, and the cron.
 *
 * The public methods of this class ARE the RPC contract (`CONTRACT.md`).
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createLogger } from '@levonis/platform-kit/log';
import { healthReport } from '@levonis/platform-kit/health';
import { KeyRing } from '@levonis/platform-kit/keys';
import { ownedDb } from '@levonis/platform-kit/db';
import type { DeliverResult, HealthReport, HopEnvelope } from '@levonis/contracts/rpc/common';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import type { Env } from './env';
import { isOn, retentionDays, versionOf } from './env';
import { createApp } from './app';
import { createAdsConsumer } from './consumers';
import { ProviderRegistry } from './registry';
import { retryDue } from './deliver';
import { ADS_OWNS, ADS_READS, dueRetries, pruneDeliveriesStatement, pruneProcessedStatement } from './store';

/** One per isolate: the adapters and their circuit breakers. Holds no secret. */
const registry = new ProviderRegistry();

/** The producers whose event signatures this consumer verifies, built once per isolate. */
let ring: KeyRing | null = null;
async function keyRing(env: Env): Promise<KeyRing> {
  if (!ring) ring = await KeyRing.fromAllowlist(env.ALLOWED_CALLER_KIDS);
  return ring;
}

const log = createLogger({ svc: 'ads', sampleRate: 0.1 });

/**
 * The owned-tables guard (ADR-003). In `throw` mode a statement naming a table
 * outside `OWNERSHIP.json` cannot run at all — the boundary is enforced by the
 * driver, not only by a test over the source.
 */
const guarded = (env: Env): D1Database =>
  ownedDb(env.DB, { service: 'ads', owns: ADS_OWNS, reads: ADS_READS }, { mode: env.OWNERSHIP_GUARD === 'log' ? 'log' : 'throw' });

export default class AdsEntrypoint extends WorkerEntrypoint<Env> {
  fetch(request: Request): Response | Promise<Response> {
    return createApp({ registry }).fetch(request, this.env, this.ctx);
  }

  /**
   * The bus consumer (`03-EVENTS.md` §2.3). Signature, producer allowlist,
   * `piiMax` and schema are checked by the kit before any state is touched;
   * the delivery rows and the `ads_processed_events` row are written in one
   * batch.
   */
  async deliver(batch: EventEnvelope[], hop?: HopEnvelope): Promise<DeliverResult> {
    const consumer = createAdsConsumer({
      keys: await keyRing(this.env),
      acceptFixtureSig: isOn(this.env.ACCEPT_FIXTURE_SIG),
      log,
      deps: { env: this.env as unknown as Record<string, string | undefined>, registry },
    });
    return consumer.deliver(guarded(this.env), batch, hop ?? null);
  }

  health(): Promise<HealthReport> {
    return healthReport({ svc: 'ads', ver: versionOf(this.env), db: this.env.DB ?? null });
  }

  /**
   * THE ONLY OUTBOUND PATH. `deliver()` queues; this cron sends.
   *
   * Ads is never on the hot path, so a provider outage becomes a `failed` row
   * with a backoff and this tick is what clears it; a row out of attempts is
   * promoted to `dead` with an `ads_dead_letters` row, which is the DLQ the
   * §11.4 alert watches. Each row is CLAIMED before it is sent, so overlapping
   * minute ticks cannot send it twice, and the run stops at an explicit send
   * and wall-clock budget — a tick has to fit inside a minute.
   */
  async scheduled(): Promise<void> {
    const db = guarded(this.env);
    const now = new Date().toISOString();
    const rows = await dueRetries(db, now);
    if (rows.length > 0) {
      const report = await retryDue(rows, {
        db,
        env: this.env as unknown as Record<string, string | undefined>,
        registry,
        now: () => now,
      });
      log.info('ads.retry_sweep', { ...report, due: rows.length });
    }
    // The retention roll, after the sweep: a row settled in this very tick is
    // a candidate the moment its window passes. Bounded per run, so a first
    // pass over a large table is many small deletes rather than one that times
    // the tick out.
    const before = new Date(Date.parse(now) - retentionDays(this.env) * 86_400_000).toISOString();
    const [deliveries, processed] = await db.batch([pruneDeliveriesStatement(db, before), pruneProcessedStatement(db, before)]);
    const pruned = Number(deliveries?.meta?.changes ?? 0) + Number(processed?.meta?.changes ?? 0);
    if (pruned > 0) log.info('ads.retention', { deliveries: deliveries?.meta?.changes ?? 0, processed: processed?.meta?.changes ?? 0, before });
  }
}
