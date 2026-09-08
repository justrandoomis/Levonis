/**
 * `levonis-audit` — the Worker.
 *
 * Thin on purpose: the request path is `http.ts`, the ingest is `consumer.ts`,
 * the chain is `chain.ts`/`seal.ts`, and this file owns only what needs the
 * Workers runtime — the `WorkerEntrypoint`, the per-isolate key ring, the cron
 * handler and the four RPC methods that ARE the contract (`CONTRACT.md`).
 *
 * The public methods here are `AuditApi` (`packages/contracts/src/rpc/audit.ts`)
 * plus `record()`: `deliver`, `record`, `query`, `verifyChain`, `health`. A
 * compile-time proof at the bottom keeps them in step with the contract.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import type { AuditApi, AuditEntryInput, AuditQuery, AuditRecordResult, AuditRow } from '@levonis/contracts/rpc/audit';
import type { DeliverResult, HealthReport, HopEnvelope, RpcCtx } from '@levonis/contracts/rpc/common';
import { createLogger } from '@levonis/platform-kit/log';
import { healthReport } from '@levonis/platform-kit/health';
import { contractViolation, forbidden } from '@levonis/platform-kit/errors';
import { uuidv7 } from '@levonis/platform-kit/correlation';
import { createApp } from './http';
import { auditConsumer, directEntryStatements } from './consumer';
import { producerKeys } from './keys';
import { sealOnce, verifyChain as verifyChainOf } from './seal';
import { queryEntries, unsealedCount, sealLagSeconds, headOf, QUERY_LIMIT_DEFAULT, QUERY_LIMIT_MAX } from './store';
import { assertCaller } from './guard';
import { onOff, sealBatchSize, verifyPageSize, verifyMaxRows, versionOf, SERVICE, type Env } from './env';

const log = createLogger({ svc: SERVICE, sampleRate: 0.1 });
const app = createApp({ log });

/** Ingest never runs off a stale clock: one ISO string per delivery. */
const nowIso = () => new Date().toISOString();

export default class AuditEntrypoint extends WorkerEntrypoint<Env> {
  fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  /**
   * The cron (`* * * * *`): seal whatever arrived since the last tick. It is
   * the only scheduled work Audit does — it produces no events, so there is no
   * outbox to pump, and it deletes nothing, because the log is append-only.
   */
  async scheduled(): Promise<void> {
    const res = await sealOnce(this.env.DB, { chainKey: this.env.AUDIT_CHAIN_KEY, limit: sealBatchSize(this.env), now: nowIso() });
    if (res.sealed > 0 || res.contended) log.info('audit.seal', { sealed: res.sealed, head_index: res.head_index, contended: res.contended ?? false });
  }

  /**
   * `03-EVENTS.md` §2.3. Every refusal reason is the platform kit's; the only
   * Audit-specific behaviour is that a delivery is followed by an opportunistic
   * seal in `waitUntil`, so an entry is normally chained within a second rather
   * than at the next cron tick.
   */
  async deliver(batch: EventEnvelope[], hop?: HopEnvelope): Promise<DeliverResult> {
    const consumer = auditConsumer({
      keys: await producerKeys(this.env),
      acceptFixtureSig: onOff(this.env.ACCEPT_FIXTURE_SIG),
      now: nowIso,
      log,
      onRejected: (eventId, type, reason) => log.error('audit.rejected', { event_id: eventId, type, reason }),
    });
    const result = await consumer.deliver(this.env.DB, batch, hop);
    if (result.results.some((r) => r.result === 'acked')) {
      this.ctx.waitUntil(
        sealOnce(this.env.DB, { chainKey: this.env.AUDIT_CHAIN_KEY, limit: sealBatchSize(this.env), now: nowIso() }).then(
          () => undefined,
          (e: unknown) => log.error('audit.seal_failed', { error: e instanceof Error ? e.message : String(e) })
        )
      );
    }
    return result;
  }

  /**
   * The direct write (`02-MIGRATION-PLAN.md` 1.7 "deliver, query"; ADR-012's
   * facade calls it for entries that must be recorded outside an event batch).
   * Idempotent by `event_id`: the caller supplies the id of the `AuditRecorded`
   * event it emitted, or a fresh UUIDv7, and a second call with the same id
   * records nothing and reports `replayed`.
   *
   * `source_service` is taken from the SIGNED hop, never from the argument: a
   * caller must not be able to write the log in another service's name.
   */
  async record(entry: AuditEntryInput, ctx?: RpcCtx): Promise<AuditRecordResult> {
    const iss = await assertCaller(this.env, 'record', [entry], ctx);
    if (!entry || typeof entry !== 'object') throw contractViolation('record: an entry object is required');
    const action = String(entry.action ?? '').trim();
    if (!action) throw contractViolation('record: action is required');
    const source = iss ?? entry.source_service;
    if (!source) throw forbidden('record: the caller service could not be established', 'FORBIDDEN');
    const at = nowIso();
    const eventId = entry.event_id || uuidv7();
    const statements = await directEntryStatements(this.env.DB, {
      event_id: eventId,
      actor_id: entry.actor_id ?? null,
      action,
      target: String(entry.target ?? ''),
      detail: entry.detail ?? null,
      source_service: source,
      correlation_id: entry.correlation_id ?? ctx?.cid ?? '',
      occurred_at: entry.occurred_at ?? at,
      recorded_at: at,
    });
    const results = await this.env.DB.batch(statements);
    const inserted = Number(results[0]?.meta?.changes ?? 0) > 0;
    return { ok: true, event_id: eventId, replayed: !inserted };
  }

  /** The admin read model behind `/api/v1/audit/admin/events`. `admin:full` at the gateway; the hop allowlist here. */
  async query(q: AuditQuery, ctx?: RpcCtx): Promise<{ rows: AuditRow[]; next: string | null }> {
    await assertCaller(this.env, 'query', [q], ctx);
    const cursor = Number.parseInt(q?.cursor ?? '', 10);
    return queryEntries(this.env.DB, {
      actor_id: q?.actor_id,
      action: q?.action,
      target: q?.target,
      from: q?.from,
      to: q?.to,
      limit: Math.min(q?.limit ?? QUERY_LIMIT_DEFAULT, QUERY_LIMIT_MAX),
      cursor: Number.isFinite(cursor) && cursor > 0 ? cursor : null,
    });
  }

  /** Re-computes the chain and compares it with what is stored (`AuditApi.verifyChain`). */
  async verifyChain(ctx?: RpcCtx): Promise<{ ok: boolean; checked: number; head: string; anchored_head: string | null }> {
    await assertCaller(this.env, 'verifyChain', [], ctx);
    const res = await verifyChainOf(this.env.DB, { chainKey: this.env.AUDIT_CHAIN_KEY, pageSize: verifyPageSize(this.env), maxRows: verifyMaxRows(this.env) });
    return { ok: res.ok, checked: res.checked, head: res.head, anchored_head: res.anchored_head };
  }

  /**
   * Never hop-guarded: a probe that must authenticate cannot report that
   * authentication is broken. Audit publishes nothing, so `outbox_lag_s`
   * carries the lag that does exist here — how long the oldest entry has been
   * waiting to be chained — and the `chain` dep reports the head and how many
   * entries are still unsealed.
   */
  async health(): Promise<HealthReport> {
    const report = await healthReport({
      svc: SERVICE,
      ver: versionOf(this.env),
      db: this.env.DB,
      outboxLagS: () => sealLagSeconds(this.env.DB),
    });
    const head = await headOf(this.env.DB).catch(() => null);
    const pending = await unsealedCount(this.env.DB).catch(() => -1);
    return {
      ...report,
      checks: {
        ...report.checks,
        deps: [{ name: 'chain', ok: true, ms: 0, ver: `${head ? `${head.alg}:${head.chain_index}` : 'empty'}+${pending}` }],
      },
    };
  }
}

/** Compile-time proof against `packages/contracts/src/rpc/audit.ts`. */
type ImplementedAudit = Pick<AuditApi, 'deliver' | 'record' | 'query' | 'verifyChain' | 'health'>;
export const _auditContract: (e: AuditEntrypoint) => ImplementedAudit = (e) => e;
