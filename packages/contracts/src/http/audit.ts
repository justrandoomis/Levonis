/**
 * `levonis-audit` HTTP contract — `/api/v1/audit/admin/*` (`01-TARGET.md` row 20,
 * ADR-012). Reads are `admin:full` only; the gateway enforces the capability and
 * the service checks it again (the service check is the authority).
 * Type-only — the rows themselves are the RPC contract's `AuditRow`.
 */
import type { AuditRow } from '../rpc/audit';

/** `GET /api/v1/audit/admin/events` — query string mirrors `AuditQuery`. */
export interface AuditEventsResponse {
  success: true;
  rows: AuditRow[];
  /** opaque cursor; `null` on the last page */
  next: string | null;
}

/**
 * `GET /api/v1/audit/admin/verify` — walks the hash chain (`audit_events`,
 * `audit_chain_heads`) and compares the head with the last R2 anchor.
 */
export interface AuditVerifyResponse {
  success: true;
  ok: boolean;
  checked: number;
  head: string;
  /** the head last written to `audit-archive/`; `null` before the first anchor */
  anchored_head: string | null;
  /** present when `ok` is false: the first sequence number whose hash did not match */
  broken_at?: number;
}
