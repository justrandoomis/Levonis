# @levonis/contracts

The published contracts between LEVONIS services (`docs/architecture/03-EVENTS.md`,
`01-TARGET.md` §4–§6, `02-MIGRATION-PLAN.md` slice 1.3). Hand-written
validators, no runtime dependency; imports nothing outside the package.

| Module | What it is |
|---|---|
| `envelope` | `EventEnvelope` (`event_id` UUIDv7 … `pii_class`, `delivery`, `payload`, `sig`), `validateEnvelope`, `eventKey` |
| `events/v1/<EventType>` | one schema per event: the TypeScript type, a strict `validate`/`is`/`parse` (an allowlist — unknown keys are refused), `pii` fields, `aggregate_type`, `pii_class`, `delivery`, and `envelope()` to build one |
| `events/index` | `EVENT_SCHEMAS` registry keyed `'<Type>.v<n>'`, `schemaFor(type, version)` |
| `events/fixtures/*.json` | one valid envelope per schema (`sig: "fixture"`, signed with a throwaway key at test time); regenerate with `node_modules/.bin/tsx packages/contracts/scripts/regen-fixtures.ts` |
| `subscriptions` | `SUBSCRIPTIONS` (consumers per event type — no wildcard), `PRODUCERS` (verified by signature), `CONSUMER_PII_MAX`, `mayConsume`, `deliverableSubscribers` |
| `ownership` | `TABLE_OWNER` — table → owning service from `01-TARGET.md` §2.1; rebuild artefacts and `<svc>_*` platform tables resolve to their owner |
| `schema` | the validator combinators (`obj`, `str`, `int`, `oneOf`, `nullable`, `arr`, …) and `ContractViolation` |
| `canonical` | canonical JSON, `sha256Hex`, `canonicalHash`, base64url — the bytes every signature is computed over |
| `rpc/common` | `Principal`, `HopEnvelope`, `RpcCtx` (the LAST argument of every RPC method), `Actor`, `HealthReport`, `DeliverResult` |
| `rpc/ledger` | `LedgerApi` (`credit, debit, hold, commitHoldAndDebit, releaseHold, refund, reserve/settle/release/reversePoints, decideDeposit, getBalances, getBreakdown, reconcile`), `MoneyCmd`, `Applied`/`Refused`, `LEDGER_MONEY_METHODS`, event-key shapes |
| `rpc/ledgerPolicy` | `LEDGER_POLICIES` per caller, `LEDGER_METHOD_CALLERS`, `checkLedgerPolicy` (pinned by `tests/ledgerPolicy.test.ts`) |
| `rpc/identity` | `IdentityApi` (`resolveSession, lookupUsers, lookupContacts, contactFor, rateLimitHit, revoke, getPublicKeys, redeemHandoff, introspect, setRole, deliver, health`) |
| `rpc/catalog` | `CatalogApi` (`getProductsForCart, isPrinterCatalog, listForIndex`) |
| `rpc/orders` | `OrdersReadApi` (`canAccessOrder, itemSnapshots`) and `OrdersApi` (`applyStage, applyStatus, createMerchantOrder, cancel, unblockSaga`) |
| `rpc/consumer` | `EventConsumer` (`deliver(batch, hop)`, `health`), the 50-event / 500 KB batch caps |
| `rpc/notifications` | `NotificationsApi` (`send` + consumer) |
| `rpc/audit` | `AuditApi` (`query`, `verifyChain` + consumer) |
| `http/common` | the `{success, error, code, details}` envelope, platform error codes, the internal header names |
| `http/health` | `GET /api/health` shapes |
| `http/gateway` | `RouteTarget`/`RouteHosts`/`RouteRequires`, `RouteOverride` (the kill switch), the gateway's own health and the four permanent 410 bodies |
| `http/audit` | `/api/v1/audit/admin/*` — the event page and the chain-verification report |
| `http/analytics` | `/api/v1/analytics/*` — the overview counters (field-for-field the ones `admin.ts:125-159` returns today) and the daily platform/merchant series |
| `http/ads` | `/api/v1/ads/admin/*` — provider status and breakers, the seeded event map, deliveries (`sandbox`/`no_consent`) and flag flips |
| `http/notifications` | `/api/notifications/*` pinned to today's core responses, plus the admin delivery view and the webhook ack |

Events in v1 today: the 17 of `03-EVENTS.md` §3 plus the 11 §4 events the
Phase 1–3 subscriptions seed names (`UserUpdated`, `SessionRevoked`,
`RoleChanged`, `RequestPublished`, `DepositRequested`, `DepositDecided`,
`WithdrawalStateChanged`, `AuditRecorded`, `RateLimitHit`, `TurnstileFailed`,
`EventRejected`). Later phases add their events with their consumers.
