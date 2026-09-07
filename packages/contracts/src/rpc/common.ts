/**
 * Types every RPC contract shares: the Identity-signed principal, the hop
 * envelope a caller signs per call (`01-TARGET.md` §4 item 3), the call context
 * passed as the LAST argument of every RPC method, actors, results and health.
 */

/** `scope` folds the owner rule into the signed claim (`adminScope.ts` → Identity). */
export type PrincipalScope = 'owner' | 'full' | 'assistant' | null;
export type PrincipalRole = 'customer' | 'merchant' | 'admin' | 'system' | 'anonymous';
export type HostKind = 'main' | 'system' | 'merchant' | 'foreign';

/** The claims Identity signs (`01-TARGET.md` §3.4). No email, phone, hashes, tokens. */
export interface Principal {
  v: 1;
  /** user id, `system:<svc>` for cron/queue work, `anon:<ip-hash>` for the gateway's anonymous marker */
  sub: string;
  sid_hash: string | null;
  role: PrincipalRole;
  scope: PrincipalScope;
  investor: boolean;
  tier: string | null;
  locale: 'ar' | 'en' | 'ckb' | null;
  host_kind: HostKind;
  iat: number; // unix seconds
  exp: number; // iat + 120 for user principals
  cid: string; // correlation id of the request that minted it
}

/** The signed hop a caller attaches to every RPC; `args_hash = sha256(canonical(args))`. */
export interface HopEnvelope {
  iss: string; // caller service name
  kid: string; // caller key id
  iat: number; // unix seconds
  exp: number; // iat + 30
  nonce: string;
  method: string; // '<Entrypoint>.<method>' or 'http.forward'
  args_hash: string;
  principal_hash: string | null; // sha256 of the principal header when one is forwarded
  sig: string; // <b64url(header)>.<b64url(signature)>
}

/** The last argument of every RPC method. */
export interface RpcCtx {
  cid: string;
  /** The `x-levonis-principal` header value, forwarded verbatim (verified by the callee). */
  principal?: string;
  idempotencyKey?: string;
  hop: HopEnvelope;
}

export interface Actor {
  kind: 'user' | 'admin' | 'merchant' | 'system';
  id: string | null;
}

export interface HealthReport {
  ok: boolean;
  svc: string;
  ver: string;
  checks: {
    db?: 'ok' | 'fail' | 'skipped';
    outbox_lag_s?: number | null;
    deps?: Array<{ name: string; ok: boolean; ms: number; ver?: string; error?: string }>;
  };
}

/** Result of `deliver()` on any consumer (`03-EVENTS.md` §2.3). */
export type DeliveryOutcome = 'acked' | 'replayed' | 'invalid' | 'forged' | 'pii_refused' | 'retry';

export interface DeliverResult {
  results: Array<{ event_id: string; result: DeliveryOutcome; error?: string }>;
}
