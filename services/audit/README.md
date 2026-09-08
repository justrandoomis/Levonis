# `levonis-audit`

The platform's append-only, hash-chained audit log, on its own D1 from day one
(`01-TARGET.md` row 20, `02-MIGRATION-PLAN.md` slice 1.7).

**Nothing here is deployed.** No Worker was created, no database, no secret, no
workflow run. `wrangler.jsonc` and `migrations/` exist so the dark deploy (G1)
and the production deploy (2.1, after G5) are a workflow run rather than a
design exercise.

| | |
|---|---|
| Contract | [`CONTRACT.md`](CONTRACT.md) — RPC, HTTP, events, storage |
| Ownership | [`OWNERSHIP.json`](OWNERSHIP.json) — `audit_events`, `audit_chain_heads`; calls only `IDENTITY.getPublicKeys` |
| Secrets | [`SECRETS.md`](SECRETS.md) — three names, no values |
| Schema | [`src/schema.ts`](src/schema.ts) = [`migrations/0001_audit_init.sql`](migrations/0001_audit_init.sql), pinned by a test |
| Local rig | [`dev/README.md`](dev/README.md) — two Workers, one `wrangler dev`, no account touched |

## The shape of it

```
producer ──deliver(batch, hop)──► AuditEntrypoint ──► audit_events (append)
                                        │                    │
   any service ──record(entry, hop)─────┘                    ▼
                                              cron * * * * * ──► seal: link + advance head
   admin ──GET /api/v1/audit/admin/events──►  query (keyset, newest first)
   admin ──GET /api/v1/audit/admin/verify──►  re-compute the chain
```

Ingest and chaining are deliberately separate steps; `src/chain.ts` opens with
the reason, and `test/chain.test.ts` proves the consequence (two sealers racing
produce one chain, and the loser writes nothing at all).

## Reading order

1. `src/schema.ts` — the two tables and why each column exists.
2. `src/chain.ts` — the hash, the link, the walk. Pure functions.
3. `src/seal.ts` — the fence, and what a lost race costs.
4. `src/entries.ts` — event → `{action, target, actor_id, detail}`, one function
   per subscribed type.
5. `src/consumer.ts` / `src/store.ts` — the ingest batch and every statement.
6. `src/http.ts` — the two admin routes and the principal check.
7. `src/index.ts` — the Worker: RPC, cron, health.

## Tests

`npm run test:unit` at the root runs them (`scripts/test-workspaces.mjs` finds
`services/*/test/*.test.ts`), or directly:

```bash
npx tsx --test services/audit/test/*.test.ts
```

They run against the service's **real migration** in real SQLite, so the fence,
the UNIQUE constraints and the all-or-nothing batch are the ones production
gets. The event fixtures are the committed ones from `@levonis/contracts`,
signed at test time with throwaway keys — no key material in the repository.
