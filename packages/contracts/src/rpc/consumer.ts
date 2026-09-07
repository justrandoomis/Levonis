import type { EventEnvelope } from '../envelope';
import type { DeliverResult, HealthReport, HopEnvelope } from './common';

/**
 * Every event consumer exposes exactly this over its `WorkerEntrypoint`
 * (rpc mode) and calls the same `deliver()` from `queue()` (queue mode).
 * A batch is ≤50 envelopes and ≤500 KB serialised (`03-EVENTS.md` §2.2).
 */
export interface EventConsumer {
  deliver(batch: EventEnvelope[], hop?: HopEnvelope): Promise<DeliverResult>;
  health(): Promise<HealthReport>;
}

export const DELIVER_MAX_EVENTS = 50;
export const DELIVER_MAX_BYTES = 500 * 1024;
