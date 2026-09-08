# The core's named entrypoints — the contract

The legacy core (`levonis-staging` live, `levonis-core-dark` on the dark stack)
exports four named `WorkerEntrypoint` classes besides its default fetch handler.
A binding of the form

```jsonc
"services": [
  { "binding": "IDENTITY", "service": "levonis-core-dark", "entrypoint": "IdentityEntrypoint" }
]
```

reaches exactly the public methods listed here and nothing else. **The public
methods are the contract**; their types live in `packages/contracts/src/rpc/*.ts`
and each file's `_<name>Contract` constant is a compile-time proof that the class
still matches them, so a signature that drifts fails `npm run check` rather than a
deploy.

Nothing on this page is reachable from the internet. These are Worker-to-Worker
calls over service bindings; the HTTP surface of the core is unchanged.

## Preconditions on every call

| | |
|---|---|
| **Hop envelope** | Every method except `health()` verifies the caller's signed hop (`{iss, kid, iat, exp, nonce, method, args_hash, principal_hash}`) — signature, per-method caller allowlist, argument hash, the 30-second window and replay. `CORE_METHOD_CALLERS` in `base.ts` is the allowlist. |
| **Mode** | `off` while `ALLOWED_CALLER_KIDS` is empty (every deployment today — no caller is registered and nothing is bound), `on` as soon as it is set. `ENTRYPOINT_HOP=off\|log\|on` overrides. |
| **Refusal** | `HopRefused` with a reason (`MISSING_HOP`, `METHOD_MISMATCH`, `ARGS_MISMATCH`, `ISSUER_NOT_ALLOWED`, `BAD_SIGNATURE`, `EXPIRED`, `REPLAY`, …). Never a partial effect: the assertion runs before anything is read or written. |
| **`health()`** | Never hop-guarded — a probe that must authenticate cannot report that authentication is broken. Returns `{ok, svc:'core', ver, checks:{db, outbox_lag_s}}`. |

## `IdentityEntrypoint` (`rpc/identity.ts`)

| Method | Callers | What it does |
|---|---|---|
| `resolveSession({sid_hash, host_kind, cid})` | gateway | Looks up the session by the hash of the cookie token — the raw token never crosses a binding — and returns a **signed** principal (`sub`, `role`, `scope`, `tier`, `host_kind`, 120-s expiry). With no `CORE_SIGNING_KEY` it mints nothing rather than an unsigned claim. |
| `introspect(sid_hash)` | gateway, studio | Is this session live, and whose? Display fields only. Studio is allowlisted for this and `redeemHandoff`, never for `resolveSession`, which is a principal-minting oracle. |
| `lookupUsers(ids)` | any registered caller | ≤90 ids (D1 binds ≤100 parameters); `{id, username, name, avatar_key, role, membership_tier}` and nothing else. |
| `lookupContacts(ids)` | admin surfaces | `{id, email, phone_masked}` — the phone is masked here, not by the caller. |
| `contactFor(userId, 'email'\|'telegram'\|'phone')` | notifications | ONE address for ONE channel. The `@telegram.local` placeholder is not an address and is answered as `null`. |
| `rateLimitHit(cls, key, limit, windowSeconds)` | any registered caller | The cross-isolate fixed window every Worker shares (ADR-016). Identity owns `rate_limits`; this runs the upsert the core runs today and returns `{allowed, count}` instead of throwing. |
| `revoke(sid_hash)` | gateway | Deletes one session; says whether it existed. |
| `getPublicKeys()` | any registered caller | The public half of the core's signing key, for verifying its principals and event signatures. |
| `deliver(batch)` | — | The core subscribes to nothing before Phase 6b, and says so (`invalid`) rather than acknowledging an event it does not apply. Identity's `SubscriptionChanged` consumer — the writer of the `users.membership_tier` copy — arrives with the slice that removes the write-on-read in `lib/entitlements.ts`. |

Not implemented yet: `setRole` (Phase 9.2, with the admin BFF), `redeemHandoff`
(Phase 2.4, with the Studio binding).

## `LedgerEntrypoint` (`rpc/ledger.ts`)

Every command delegates to the exported function the site routes already call,
so a command over a binding and a command from a route are the same code, the
same guards, the same idempotency and the same audit trail. Nothing here writes
SQL of its own.

| Method | What it does |
|---|---|
| `hold(cmd)` | A purchase hold. The `eventKey` is **required** and must be server-minted (`<service>:<aggregate>:<id>:<leg>` or a legacy deterministic id) — a client's idempotency string is not a money key. Replay of the same key returns the same hold; the same key for a different amount is refused (`EVENT_KEY_REUSED`), never silently reused. |
| `commitHoldAndDebit({holdId, eventKey, note})` | Settles the hold: the ledger debit is posted in the SAME transaction as the state flip (the Phase-0 settlement rule). |
| `releaseHold({holdId, eventKey})` | Returns reserved money to the available balance, exactly once. |
| `getBalances(userId)` | `{settled, held, available}` for USD cents and points, separately — never one blended figure. |
| `getBreakdown(userId)` | The wallet page's own numbers, including pending deposits and open withdrawals. |
| `reconcile()` | READS and reports; never releases a hold, never posts a row, never "fixes" a balance. |

Deliberately absent, each with the slice that brings it: `credit`/`debit`/`refund`
(6a/6b/7.2 move their callers), the points commands (8.0), `decideDeposit` (4b-ii,
which adds the nonce and approver verification of `01-TARGET.md` §6.5). Writing a
second implementation of a money command beside the one in the routes is exactly
the duplication Phase 0 spent its time removing.

## `CatalogEntrypoint` (`rpc/catalog.ts`)

| Method | What it does |
|---|---|
| `isPrinterCatalog(catalogId)` | The owner's `catalogs.is_printer_catalog` flag — what the printer home-delivery note and the warranty rules key off, never `ops_policy`. |
| `listForIndex(cursor)` | The Search backfill feed: 100 rows ordered by id, cursor = the last id, so a page can neither be skipped by a concurrent insert nor repeated. Display and index fields only — no cost, no margin, no supplier. |

`getProductsForCart` is not here: pricing a cart line is the whole resolver (tier,
PRO policy, transport defaults, availability) and it moves with the read routes in
slice 5.1.

## `OrdersEntrypoint` (`rpc/orders.ts`, read-only half)

| Method | What it does |
|---|---|
| `canAccessOrder(orderId, sub)` | Decides from the order row — owner, the merchant whose store sold it, or an admin — never from a role the caller asserts about itself. |
| `itemSnapshots(orderId)` | The frozen per-line `warranty_snapshot` / `ops_policy` objects **as sold**. This is why `OrderDelivered` can carry references instead of snapshots and stay far below the queue message cap. |

The commands (`applyStage`, `applyStatus`, `createMerchantOrder`, `cancel`,
`unblockSaga`) arrive with the slices that move their callers (6a, 7.1–7.3, 7b), so
a command lives in exactly one place at a time.

## Why the base class is resolved dynamically

`cloudflare:workers` exists only on the Workers runtime. Node — which runs the
unit suite, and which imports `worker/index.ts` to drive all 225 admin routes in
`tests/adminHostGuard.test.ts` — cannot resolve it at all, so a static import
would take the test suite down. `base.ts` therefore imports it dynamically with a
Node stand-in as the fallback. Both halves are proven, not assumed: the classes are
constructed and exercised directly by `tests/coreEntrypoints.test.ts` under Node,
and the real `worker/index.ts` was run under `wrangler dev` with a second Worker
bound to `IdentityEntrypoint` and `CatalogEntrypoint` — `rateLimitHit` counted
across calls in the local D1, `health()` reported `db: ok`, and the cron pump
delivered an outbox event to a bound consumer over its service binding.
