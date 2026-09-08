# `levonis-audit` — contract

The public methods of `AuditEntrypoint` (`src/index.ts`) and the two HTTP routes
below **are** the contract. Types: `packages/contracts/src/rpc/audit.ts`
(`AuditApi`, `AuditEntryInput`, `AuditRow`) and
`packages/contracts/src/http/audit.ts`. A compile-time proof at the bottom of
`src/index.ts` fails the build if a method drifts from `AuditApi`.

Design: `01-TARGET.md` row 20 and §2.1; `02-MIGRATION-PLAN.md` 1.7 and 2.1;
`03-EVENTS.md` §4 (`AuditRecorded`) and §5 rule 5 (who may see `personal`).

---

## RPC (over a service binding)

Every method except `health()` verifies the caller's signed hop
(`01-TARGET.md` §4 item 3) when any caller key is registered
(`ALLOWED_CALLER_KIDS`); with none registered the assertion is off, because a
Worker no one is bound to has no callers to check. The per-method allowlist is
`AUDIT_METHOD_CALLERS` in `src/guard.ts`.

| Method | Callers | What it does |
|---|---|---|
| `deliver(batch, hop?)` | every producer (the bus) | Ingests the events of `03-EVENTS.md` §6 whose consumer list contains `audit`. Refuses — before touching state — a malformed envelope, a type it does not subscribe to, a `source_service` outside the type's `producers`, a bad signature, and (never, for Audit) a class above its PII ceiling. Idempotent by `event_id` twice over: `audit_processed_events` in the same batch as the INSERT, and `audit_events.event_id UNIQUE`. Returns one `{event_id, result}` per envelope: `acked \| replayed \| invalid \| forged \| retry`. |
| `record(entry, ctx)` | any service | Writes one entry directly, for a sensitive mutation that has no batch to ride in. Idempotent by `entry.event_id`; a repeat reports `replayed: true` and writes nothing. **`source_service` comes from the signed hop, not from the argument** — a caller cannot write the log in another service's name. When the entry carries a `detail` and a row already exists for that `event_id` (the `AuditRecorded` half arrived first), the body fills that row; the chain is unaffected because it covers `detail_hash`, not `detail`. |
| `query(q, ctx)` | `admin`, `support` | The admin read model: newest first, keyset-paged on `seq`, filtered by `actor_id`, `action`, `target` and a half-open `from`/`to` range on `recorded_at`. `limit` ≤ 200 (default 50). `next` is the cursor, or `null` on the last page. |
| `verifyChain(ctx)` | `admin` | Re-computes the chain from the genesis and compares it with what is stored. `{ok, checked, head, anchored_head}`. `checked` below the head's index means the walk hit its row ceiling and `head` is the hash at that point — the verdict covers the prefix it names, never more. |
| `health()` | anyone (never hop-guarded) | `{ok, svc:'audit', ver, checks:{db, outbox_lag_s, deps}}`. Audit publishes nothing, so `outbox_lag_s` carries the lag it does have: how long the oldest entry has been waiting to be chained. The `chain` dep reports `"<alg>:<head index>+<unsealed count>"`. |

## HTTP (through the gateway, `admin:full` only)

| Route | Response |
|---|---|
| `GET /api/v1/audit/admin/events?actor_id=&action=&target=&from=&to=&limit=&cursor=` | `AuditEventsResponse` — `{success:true, rows, next}` |
| `GET /api/v1/audit/admin/verify` | `AuditVerifyResponse` — `{success:true, ok, checked, head, anchored_head, broken_at?}` |
| `GET /health` | the legacy health body plus `svc` — the dark twin's own probe target |

Authorisation is re-applied here and is the authority (`01-TARGET.md` §4 item 6):
a principal signed by Identity (or the core, which is Identity until Phase 9),
unexpired, minted on the apex (`host_kind: 'main'`), with `role:'admin'` and a
scope that is not `assistant`. Anything else is `401 UNAUTHORIZED` or
`403 FORBIDDEN` in the platform envelope. Audit never sees a cookie.

## Events consumed

`AuditRecorded`, `EventRejected`, `UserCreated`, `OrderCreated`,
`PaymentCompleted`, `RefundCompleted`, `RoleChanged`, `DepositDecided`,
`WithdrawalStateChanged` — v1, exactly the `audit` rows of
`packages/contracts/src/subscriptions.ts`. `src/entries.ts` maps each to an
`{action, target, actor_id, detail}`; `test/consumer.test.ts` fails if the two
lists disagree, so a new subscription cannot be half-added.

Events produced: **none**. Audit is a sink.

## What it stores, and what it never stores

`audit_events` (append-only) and `audit_chain_heads`, in its **own** database
(`levonis-audit-db`). Never: a token, a cookie, a password hash, a full contact,
a request body. `detail` is either derived from an event payload — already an
allowlist — or supplied by `record()`, bounded to 4000 characters exactly as the
`audit()` facade bounds it.

The legacy `audit_log` stays in the core's database and is untouched by this
service; the dual-write of ADR-012 keeps both true until `audit_log` is frozen
after Phase 3.

## The chain, in one paragraph

Ingest appends. The sealing pass — the per-minute cron, and opportunistically
`waitUntil` after a delivery — links every unchained row onto the head:
`hash = HMAC(AUDIT_CHAIN_KEY, canonical({chain_index, prev_hash, id, event_id,
event_type, actor_id, action, target, detail_hash, source_service,
correlation_id, occurred_at, recorded_at}))`, or a plain digest when no key is
configured (each row records which, and verification uses the row's own). The
new head is written in the SAME batch, conditional on the old one; a sealer that
loses that race rolls its whole batch back, so a concurrent seal produces one
chain and never a fork or a half-linked row. `verifyChain` walks
`chain_index` and reports the first position whose stored hash, predecessor or
position does not recompute — an edit, a deletion, a reorder and a rewritten
head are all caught, and each has a test.

## Deployment facts a caller may rely on

- No route, ever. `workers_dev:false` and `preview_urls:false` in production;
  reachable only through a service binding or the gateway's versioned prefix.
- Its own D1 (`levonis-audit-db`, dark `levonis-audit-db-dark`) with its own
  migration stream under `migrations/`, applied by its own workflow before its
  code.
- Cron `* * * * *` — sealing only. Audit deletes nothing, ever.
- Secrets: `AUDIT_CHAIN_KEY`, `AUDIT_SIGNING_KEY`, `HEALTH_PROBE_TOKEN`
  (`SECRETS.md`, names only).

## Bindings (least privilege)

Every binding this Worker holds, in every environment, and nothing else —
`tests/boundariesBindings.test.ts` compares this list against
`wrangler.jsonc` in both directions, so a binding added to the config without a
line here fails `npm run check`.

| Binding | Kind | Why Audit has it |
|---|---|---|
| `DB` | D1 | its own store, `levonis-audit-db` (dark: `levonis-audit-db-dark`) |
| `IDENTITY` | service (`IdentityEntrypoint`) | `getPublicKeys` only — a producer's key is what makes an event evidence. Audit binds nothing else: a log that calls the systems it records is not a log |
