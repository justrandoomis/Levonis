import type { EventConsumer } from './consumer';
import type { RpcCtx } from './common';

export type NotificationChannel = 'inapp' | 'email' | 'telegram';

/** The core's `enqueue()` keeps its signature and forwards to this (Phase 4b-i). */
export interface SendCommand {
  event_key: string; // the Resend Idempotency-Key semantics are kept: one delivery per key
  user_id: string;
  channels: NotificationChannel[];
  template: string;
  params: Record<string, string | number | boolean | null>;
  correlationId: string;
}

export interface NotificationsApi extends EventConsumer {
  send(cmd: SendCommand, ctx: RpcCtx): Promise<{ queued: boolean; replayed: boolean }>;
}
