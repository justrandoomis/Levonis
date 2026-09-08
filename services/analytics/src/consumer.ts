/**
 * The consumer half. `defineConsumer` refuses everything it should
 * (`03-EVENTS.md` §2.3) and this file supplies the side effect: the projected
 * event row and the day's counters, in ONE batch with `processed_events` — so
 * "counted exactly once" is the same fact as "delivered exactly once", and not
 * a second scheme that could disagree with it.
 *
 * `piiMax` is `pseudonymous`: Analytics is one of the four consumers that may
 * never receive a `personal` envelope (`03-EVENTS.md` §5 rule 1). The bus
 * refuses to deliver one; if one arrives anyway, this refuses it again.
 */
import { defineConsumer, type Consumer, type EventHandler } from '@levonis/platform-kit/consumer';
import { eventKeyOf } from '@levonis/contracts/envelope';
import type { Logger } from '@levonis/platform-kit/log';
import type { KeyRing } from '@levonis/platform-kit/keys';
import { METRIC_MAPPERS, metricsOf } from './metrics';
import { project } from './projection';
import { insertEventStatement, rollupStatements } from './store';
import { SERVICE } from './env';

export interface AnalyticsConsumerOptions {
  keys: KeyRing;
  /** the daily-hash salt (`ANALYTICS_HASH_SALT`) */
  salt?: string;
  acceptFixtureSig?: boolean;
  now?: () => string;
  log?: Logger;
  onRejected?: (eventId: string, type: string, reason: string) => void;
}

/**
 * One handler for every subscribed type: project, count, append. The salt is
 * closed over rather than read from a module global, so two isolates — or two
 * tests — can never share one.
 *
 * The counters are computed from the PROJECTED payload, never the raw one: a
 * metric that needed a dropped field would fail here rather than quietly
 * keeping the field alive in a rollup.
 */
function handlerFor(salt: string | undefined): EventHandler {
  return async (env, ctx) => {
    const projection = await project(env, { salt, now: ctx.now });
    const points = metricsOf(eventKeyOf(env), projection.payload);
    return [insertEventStatement(ctx.db, projection, ctx.now), ...rollupStatements(ctx.db, projection.day, points, ctx.now)];
  };
}

export function analyticsConsumer(opts: AnalyticsConsumerOptions): Consumer {
  const handlers: Record<string, EventHandler> = {};
  const handler = handlerFor(opts.salt);
  for (const key of Object.keys(METRIC_MAPPERS)) handlers[key] = handler;
  return defineConsumer({
    name: SERVICE,
    piiMax: 'pseudonymous',
    handlers,
    keys: opts.keys,
    acceptFixtureSig: opts.acceptFixtureSig,
    now: opts.now,
    log: opts.log,
    onRejected: (envelope, reason) => opts.onRejected?.(envelope.event_id, envelope.event_type, reason),
  });
}
