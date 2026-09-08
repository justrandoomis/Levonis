/**
 * `levonis-analytics` — the Worker.
 *
 * Thin: the request path is `http.ts`, the ingest is `consumer.ts`, the
 * numbers are `metrics.ts`/`rollup.ts`/`read.ts`, and this file owns what needs
 * the Workers runtime — the `WorkerEntrypoint`, the cron and the read RPC.
 *
 * Public methods: `deliver`, `overview`, `daily`, `merchantDaily`, `health`
 * (`CONTRACT.md`). It writes nothing on request: its only input is the bus.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import type { DeliverResult, HealthReport, HopEnvelope, RpcCtx } from '@levonis/contracts/rpc/common';
import type { DailyMerchantPoint, DailyPlatformPoint } from '@levonis/contracts/http/analytics';
import { createLogger } from '@levonis/platform-kit/log';
import { healthReport } from '@levonis/platform-kit/health';
import { contractViolation } from '@levonis/platform-kit/errors';
import { createApp } from './http';
import { analyticsConsumer } from './consumer';
import { producerKeys } from './keys';
import { sweep } from './rollup';
import { ingestLagSeconds, type DayRange } from './store';
import { daily as dailyOf, merchantDaily as merchantDailyOf, overview as overviewOf, type Overview } from './read';
import { assertCaller } from './guard';
import { onOff, retentionDays, rollupDays, rollupMaxRows, versionOf, SERVICE, type Env } from './env';

const log = createLogger({ svc: SERVICE, sampleRate: 0.1 });
const app = createApp({ log });

const nowIso = () => new Date().toISOString();
const today = () => nowIso().slice(0, 10);

/** `YYYY-MM-DD` or nothing — the one shape a range may take, RPC included. */
function day(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw contractViolation(`${label} must be YYYY-MM-DD`);
  return value;
}

const rangeOf = (r: DayRange | undefined): DayRange => ({ from: day(r?.from, 'from'), to: day(r?.to, 'to') });

export default class AnalyticsEntrypoint extends WorkerEntrypoint<Env> {
  fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  /**
   * The cron (every five minutes; the expression is in `wrangler.jsonc`):
   * re-compute the recent days from the raw rows and roll raw events out at the
   * retention window. Nothing a user waits on runs here, and the rollups are
   * never pruned.
   */
  async scheduled(): Promise<void> {
    const res = await sweep(this.env.DB, {
      today: today(),
      now: nowIso(),
      rollupDays: rollupDays(this.env),
      retentionDays: retentionDays(this.env),
      maxRows: rollupMaxRows(this.env),
    });
    log.info('analytics.sweep', {
      repaired: res.repaired.map((r) => `${r.day}:${r.rows}${r.skipped ? '(skipped)' : ''}`).join(','),
      pruned: res.pruned,
      pruned_before: res.prunedBefore,
    });
  }

  /**
   * `03-EVENTS.md` §2.3. The projection drops every `pii`-annotated field
   * before anything is written, and the day's counters ride in the same batch
   * as the row, so a redelivery adds neither.
   */
  async deliver(batch: EventEnvelope[], hop?: HopEnvelope): Promise<DeliverResult> {
    const consumer = analyticsConsumer({
      keys: await producerKeys(this.env),
      salt: this.env.ANALYTICS_HASH_SALT,
      acceptFixtureSig: onOff(this.env.ACCEPT_FIXTURE_SIG),
      now: nowIso,
      log,
      onRejected: (eventId, type, reason) => log.warn('analytics.rejected', { event_id: eventId, type, reason }),
    });
    return consumer.deliver(this.env.DB, batch, hop);
  }

  /** The counter half of `GET /api/admin/overview`, from the rollups (`read.ts` names what it cannot know). */
  async overview(range?: DayRange, ctx?: RpcCtx): Promise<Overview> {
    await assertCaller(this.env, 'overview', [range], ctx);
    return overviewOf(this.env.DB, rangeOf(range));
  }

  /** The platform series: `[{day, metric, value}]`. */
  async daily(opts: (DayRange & { metric?: string; limit?: number }) | undefined, ctx?: RpcCtx): Promise<DailyPlatformPoint[]> {
    await assertCaller(this.env, 'daily', [opts], ctx);
    return dailyOf(this.env.DB, { ...rangeOf(opts), metric: opts?.metric, limit: opts?.limit });
  }

  /** One merchant's series. One merchant per call, always. */
  async merchantDaily(
    merchantId: string,
    opts?: DayRange & { metric?: string; limit?: number },
    ctx?: RpcCtx
  ): Promise<DailyMerchantPoint[]> {
    await assertCaller(this.env, 'merchantDaily', [merchantId, opts], ctx);
    if (!merchantId) throw contractViolation('merchantDaily: merchant_id is required');
    return merchantDailyOf(this.env.DB, merchantId, { ...rangeOf(opts), metric: opts?.metric, limit: opts?.limit });
  }

  /**
   * Never hop-guarded. Analytics publishes nothing, so `outbox_lag_s` carries
   * the freshness that matters here: how long ago the newest event arrived.
   */
  async health(): Promise<HealthReport> {
    return healthReport({
      svc: SERVICE,
      ver: versionOf(this.env),
      db: this.env.DB,
      outboxLagS: () => ingestLagSeconds(this.env.DB),
    });
  }
}
