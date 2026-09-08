# `levonis-analytics`

The platform's consumer-owned read models, on its own D1 from day one
(`01-TARGET.md` row 17 and §9.2, `02-MIGRATION-PLAN.md` slice 1.7).

**Nothing here is deployed.** No Worker was created, no database, no secret, no
workflow run. `wrangler.jsonc` and `migrations/` exist so the dark deploy (G1)
and the production deploy (2.1, after G5) are a workflow run rather than a
design exercise.

| | |
|---|---|
| Contract | [`CONTRACT.md`](CONTRACT.md) — RPC, HTTP, events, the projection, the numbers |
| Ownership | [`OWNERSHIP.json`](OWNERSHIP.json) — three tables, no reads, one call |
| Secrets | [`SECRETS.md`](SECRETS.md) — three names, no values |
| Schema | [`src/schema.ts`](src/schema.ts) = [`migrations/0001_analytics_init.sql`](migrations/0001_analytics_init.sql), pinned by a test |
| Local rig | [`dev/README.md`](dev/README.md) — two Workers, one `wrangler dev`, no account touched |

## The shape of it

```
producer ──deliver(batch, hop)──► project (drop every pii field, hash the actor)
                                       │
                                       ├─► analytics_events        (raw, rolls at 30 days)
                                       └─► daily_platform/_merchant (+= in the SAME batch)

cron */5  ──► repair the last 2 days from the raw rows ──► daily_* (=)
          └─► roll raw events out at the retention window

admin     ──GET /api/v1/analytics/admin/overview | /admin/daily──► the rollups
merchant  ──GET /api/v1/analytics/merchant/daily?merchant_id=──►  its own rows only
```

## The one property that matters

Every field the event catalogue annotates `pii` is dropped before anything is
written, and no list of those fields lives in this service — it reads
`EVENT_SCHEMAS[key].pii` from `@levonis/contracts`, so an annotation added there
takes effect here with no change and no release.
`test/projection.test.ts` proves it over the whole subscribed catalogue and then
reads the entire store back as text to check that no raw person id is in it.

## Reading order

1. `src/schema.ts` — three tables and why each column exists.
2. `src/projection.ts` — what is dropped, what is hashed, and why the envelope's
   aggregate id needs the same treatment as the payload.
3. `src/metrics.ts` — one event → counters. Pure, total, integers only.
4. `src/consumer.ts` / `src/store.ts` — the ingest batch and every statement.
5. `src/rollup.ts` — the repair pass and the retention roll, and why both exist.
6. `src/read.ts` — the read models, and an explicit list of what Analytics
   cannot know rather than a guess.
7. `src/http.ts` / `src/index.ts` — the routes, the RPC, the cron.

## Tests

```bash
npx tsx --test services/analytics/test/*.test.ts
```

(or `npm run test:unit` at the root, which finds them through
`scripts/test-workspaces.mjs`). They run against the service's **real
migration** in real SQLite, and the event fixtures are the committed ones from
`@levonis/contracts`, signed at test time with throwaway keys.
