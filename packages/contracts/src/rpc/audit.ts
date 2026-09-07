import type { EventConsumer } from './consumer';
import type { RpcCtx } from './common';

export interface AuditQuery {
  actor_id?: string;
  action?: string;
  target?: string;
  from?: string;
  to?: string;
  limit?: number; // ≤200
  cursor?: string | null;
}

export interface AuditRow {
  id: string;
  seq: number;
  prev_hash: string;
  hash: string;
  event_id: string;
  actor_id: string | null;
  action: string;
  target: string;
  detail: Record<string, unknown> | null;
  source_service: string;
  created_at: string;
}

/** `levonis-audit` (`01-TARGET.md` row 20, ADR-012). Reads are `admin:full` only. */
export interface AuditApi extends EventConsumer {
  query(q: AuditQuery, ctx: RpcCtx): Promise<{ rows: AuditRow[]; next: string | null }>;
  verifyChain(ctx: RpcCtx): Promise<{ ok: boolean; checked: number; head: string; anchored_head: string | null }>;
}
