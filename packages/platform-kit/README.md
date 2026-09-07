# @levonis/platform-kit

The platform kit every LEVONIS Worker is built on (`docs/architecture/01-TARGET.md`
§3–§5, §11; `02-MIGRATION-PLAN.md` slice 1.2). Imports only `@levonis/contracts`,
`hono` and itself — never `worker/` or `services/` (`tests/monorepo.test.ts`).
Import by subpath (`@levonis/platform-kit/rpc`) to keep bundles small.

| Module | What it gives a service |
|---|---|
| `errors` | `KitError` (status + code for the `{success:false, error, code}` envelope), `TransientError`, the standard refusals (`notViaGateway`, `dependencyUnavailable`, `idempotencyMismatch`, `eventKeyReused`, …) |
| `log` | structured JSON lines with `ts, level, svc, ver, env, cid, rid, hop`; head-sampled `info`, unsampled `error` and `money`; redaction of tokens/cookies/contacts |
| `correlation` | `uuidv7()`, `correlationFor(headers, {trusted})` (browser values ignored), `x-correlation-id` |
| `keys` | Ed25519 via WebCrypto: `generateKeyPair`, `importSigningKey`, `KeyRing` (+ `ALLOWED_CALLER_KIDS` bootstrap), compact JWS-style tokens, `constantTimeEqual` |
| `principal` | Identity-signed principal (`sub, sid_hash, role, scope: owner|full|assistant|null, investor, tier, locale, host_kind, iat, exp: iat+120, cid`): `signPrincipal`, `verifyPrincipal` (kid, signature, expiry, host_kind, issuer), `principalToSessionUser` (documents `UNFILLABLE_SESSION_FIELDS`), system/anonymous markers |
| `hop` | the per-call hop envelope `{iss, kid, iat, exp: iat+30, nonce, method, args_hash, principal_hash, sig}`: `signHop`, `verifyHop` (issuer allowed FOR THAT METHOD, signature, args/principal hash, window, `(iss, nonce)` replay set) |
| `eventSig` | `signEnvelope` / `verifyEnvelope` — producer signature + `producers` allowlist, in rpc and queue mode alike |
| `rpc` | `createRpcClient` proxy (budget 3 s / 10 s, retry only idempotent methods, fresh nonce per attempt), `CircuitBreaker` (5 failures → open, half-open after 30 s), `BreakerRegistry`, `createBudget`, `withTimeout` |
| `httpx` | `fetchWithBudget(url, init, {timeoutMs, retries, retryOn, ssrfGuard, breaker})`, `PROVIDER_BUDGETS`, `validateOutboundUrl` (byte-identical to `worker/lib/fetchGuard.ts`) |
| `db` | `ownedDb(db, manifest, {mode: 'throw'|'log'})` — refuses statements naming tables outside `owns`/`reads`; `tablesInSql`, `checkStatement` (shared with the boundaries lint) |
| `inList` | `inList(ids, query)` chunks at 90 and merges (D1 binds ≤100 params); `placeholders`, `selectIn` |
| `outbox` | `publishStatement()` (one statement, or null while `EVENT_BUS_ENABLED` is off or the table is absent — `OutboxProbe`), `Uow` (refuses to commit a publishing command without its outbox row), `outboxSchemaSql(prefix)` |
| `bus` | `RpcFanoutBus` (`pumpIds` after the request, `pump` = the only `pump_lock` holder; one bookkeeping statement per `deliver()`; ≤50 events / ≤500 KB per call; ≤600 statements / ≤60 RPCs per run; backoff `min(15 min, 5 s·2^n)`; dead after 8; `replay`, `redeliver`, `emitBestEffort`), queue-mode helpers (`queueAsConsumer`, `selectConsumers`, ≤100 msgs / 256 KB chunks, pointers above 100 KB) |
| `consumer` | `defineConsumer({name, piiMax, handlers, keys})` → `deliver(db, batch, hop)`: envelope + producer + signature + PII + schema checks, then the handler's statements batched with the `processed_events` row (PK violation = replay) |
| `idempotency` | `processedEventStatement`/`isProcessed`; `IdempotencyStore` scoped to the caller (≥16-char keys, payload-hash mismatch → 409) |
| `config` | `ConfigReader` with `MemoryConfig`/`KvConfig`; 30-s memo except `MONEY_KEYS` (TTL 0); `modeVar` |
| `ratelimit` | `rateLimitKey`/`identifierKey` (byte-identical copies), `RATE_LIMIT_UPSERT_SQL` (today's D1 window for `IdentityEntrypoint.rateLimitHit`), adapters `D1RpcRateLimiter` (authoritative), `BindingRateLimiter` (per-colo first layer), `DoRateLimiter`, `MemoryRateLimiter` (dark only), `LayeredRateLimiter`; the `rateLimit(c, bucket, limit, window)` facade with today's signature — 503, never a silent memory fallback |
| `audit` | `auditStatements()` / `audit()` facade: legacy `audit_log` dual-write + `AuditRecorded` outbox row + `<svc>_audit_details` body (pruned ≤24 h after ack) |
| `health` | `healthReport({svc, ver, db, outboxLagS, deps})` with a 2-s deep budget, `isHealthProbe` (constant-time token), the legacy `/api/health` body |
| `saga` | states `started → local_committed → done` / `→ compensating → compensated` / `stuck`; `SagaStore` with the two-sided fence (`fenceStatement` + `fenceGuardStatement` abort the batch when the sweep won), one in-flight saga per user (stuck excluded), `sweepAction` |
| `scope` | `scopeFor` (Identity folds the owner rule into the claim), `canViewFinancials(principal)`, `stripFinancials`/`FINANCIAL_FIELDS`/`normalizeAdminScope` (byte-identical copies), `meetsRequirement` |
| `realtime` | `RealtimeHub`: `NoopHub` today, `DoHub` when Durable Objects are approved, `MemoryHub` for tests |
| `process` | `ProcessRunner`: `CronSweepRunner` today, `WorkflowRunner` later; `LEGACY_DISABLED_STEPS` helpers and the per-minute-vs-15-minute modulo |
| `edge/hosts`, `edge/securityPolicy` | byte-identical COPIES of `worker/lib/hosts.ts` and `securityPolicy.ts` (`tests/edgeParity.test.ts`) until Phase 3.3 turns the core's files into re-exports |
| `edge/middleware` | byte-identical copies of `originCheck`, `securityHeaders`, `requireMainHost` from `worker/lib/http.ts` |
| `edge/capabilities` | the capability table type, the admin seed rows (`hosts:'main'`, `admin` / `admin:full`), `matchCapability`, today's denial bodies |
| `edge/gatewayOnly` | `gatewayOnly({mode: off|log|on})` — verifies the gateway's forward hop on inbound HTTP; `403 NOT_VIA_GATEWAY` when `on`; health probes pass |

Tests: `packages/platform-kit/test/*.test.ts` (run by `npm run test:unit` through
`scripts/test-workspaces.mjs`), against real SQLite for everything that touches D1.
