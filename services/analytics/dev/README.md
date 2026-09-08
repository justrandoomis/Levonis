# The local rig — `levonis-analytics`

Two Workers, one `wrangler dev`, no Cloudflare account touched.

```bash
# 1. create the local database and apply THIS service's migration to it
npx wrangler d1 execute levonis-analytics-db-dark --local \
    -c services/analytics/wrangler.jsonc --env dark \
    --file services/analytics/migrations/0001_analytics_init.sql \
    --persist-to .wrangler/dev-analytics

# 2. run the producer stub (primary) and the analytics service together
npx wrangler dev -c services/analytics/dev/producer-stub/wrangler.jsonc \
                 -c services/analytics/wrangler.jsonc \
                 --env dark --port 8813 --persist-to .wrangler/dev-analytics

# 3. drive it
node services/analytics/dev/probe.mjs http://localhost:8813
```

The first config is the primary — the stub, which is what the port serves. It
carries the dark core's **name** (`levonis-core-dark`) so the analytics
service's own `IDENTITY` binding resolves to it, binds `ANALYTICS` the way the
bus will, and mints signed principals so the HTTP surface can be driven through
the service's real authorisation path rather than around it.

### Proving the cron — the repair pass

Only the primary config is served on the port, so swap the order and use
wrangler's local trigger. This also demonstrates what the repair pass is for:

```bash
npx wrangler dev -c services/analytics/wrangler.jsonc \
                 -c services/analytics/dev/producer-stub/wrangler.jsonc \
                 --env dark --port 8814 --persist-to .wrangler/dev-analytics

# write a wrong number behind the service, the way drift would look
npx wrangler d1 execute levonis-analytics-db-dark --local \
    -c services/analytics/wrangler.jsonc --env dark --persist-to .wrangler/dev-analytics \
    --command "UPDATE analytics_daily_platform SET value = 99 WHERE metric = 'orders_created'"

curl http://localhost:8814/cdn-cgi/local/scheduled     # one cron tick

npx wrangler d1 execute levonis-analytics-db-dark --local \
    -c services/analytics/wrangler.jsonc --env dark --persist-to .wrangler/dev-analytics \
    --command "SELECT metric, value FROM analytics_daily_platform ORDER BY metric"
```

The counter is back to what the raw rows say — the repair pass recomputed the
day and replaced it.

## What the rig proves that the unit suites cannot

`services/analytics/test/*` call the consumer in process against a SQLite shim.
The rig runs the service inside **workerd**, over a **real service binding**,
against a **real local D1**, with the cron handler the runtime provides and Node
does not. Concretely:

- `deliver`, `overview`, `daily`, `merchantDaily`, `health` and `fetch` called
  across an isolate boundary, where arguments are serialised;
- the **signature chain end to end**: the stub generates one Ed25519 key per
  producer service in memory, signs envelopes with them, publishes the public
  halves through `IdentityEntrypoint.getPublicKeys()`, and the analytics service
  fetches those over the binding and verifies with them — no key material in the
  repository, in a var or on a command line;
- the **principal chain end to end**: the stub signs an admin (or merchant)
  principal with the same registry key, and the service's own HTTP guard
  verifies it, so `401`/`403`/`200` come from the real check;
- real D1 batch semantics behind "a redelivery adds nothing to a rollup".

## What it is not

- **Not a deployment.** `wrangler dev` runs locally; nothing here is uploaded,
  and no workflow references `dev/`.
- **Not the core.** The stub emits four envelope shapes and answers one Identity
  method.
- **Not part of the service.** `tests/leastPrivilege.test.ts` reads
  `services/<name>/wrangler.jsonc` and `tests/serviceBoundaries.test.ts` scans
  `services/<name>/src` — this directory is neither.
