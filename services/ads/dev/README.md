# The local rig — `levonis-ads` + `levonis-notifications`

Three Workers, one command, no Cloudflare account touched.

```bash
# 1. create the two LOCAL databases and apply each service's own migrations.
#    --persist-to is what makes them the same databases the dev server will
#    open: without it, `d1 migrations apply` writes under the config's own
#    directory and `wrangler dev` opens a different, empty state directory —
#    every table is then missing and every health check still says "ok",
#    because SELECT 1 works fine on an empty database.
npx wrangler d1 migrations apply levonis-ads-db-dark --local \
    --persist-to .wrangler/rig -c services/ads/wrangler.jsonc --env dark
npx wrangler d1 migrations apply levonis-notifications-db-dark --local \
    --persist-to .wrangler/rig -c services/notifications/wrangler.jsonc --env dark

# 2. run all three Workers together. The FIRST config is the primary: it is
#    served on the port, and its `services` bindings resolve to the other
#    configs on the same command line.
npx wrangler dev -c services/ads/dev/producer-stub/wrangler.jsonc \
                 -c services/ads/wrangler.jsonc \
                 -c services/notifications/wrangler.jsonc \
                 --env dark --port 8811 --persist-to .wrangler/rig

# 3. drive it.
node services/ads/dev/probe.mjs http://localhost:8811
```

Expected tail:

```
  ok   the rig is up and both bindings resolved
  ok   both services answer health() over the binding with a live database
  ok   ADS: a consent change is stored, and the first one maps to a sandbox delivery per provider
  ok   ADS: a purchase reaches every provider in SANDBOX — no secret is set, so nothing leaves the account
  ok   ADS: a redelivered envelope is replayed and writes no second row
  ok   ADS: the provider kill switch removes one platform and leaves the rest
  ok   ADS: every provider reports unconfigured, and the master switch is on in dark
  ok   NOTIFICATIONS: an order becomes an in-app row, and a redelivery adds nothing
  ok   NOTIFICATIONS: send() is idempotent on the event key
  ok   NOTIFICATIONS: with no transport secret set, the pump drops rather than sends
  ok   NOTIFICATIONS: the webhook answers 200 and dedups, and accepts nothing without the secret
  ok   NOTIFICATIONS: the inbox refuses a request it cannot attribute

all checks passed
```

## What the rig proves that the unit suites cannot

`services/*/test/*` drive the modules directly, with an in-memory SQLite and an
injected `fetch`. The rig runs the same code **inside workerd**, reached over a
**real service binding** from another Worker, against **real local D1**. That
difference is where the interesting failures live: an `ON CONFLICT` clause D1
accepts and `node:sqlite` does not, a `batch()` that behaves differently under a
real transaction, an RPC argument that does not survive serialisation, a
`waitUntil` that never runs.

It also exercises the two properties this slice exists for in the shape an
operator will actually see them:

- **no provider secret is set in dark**, so every ads delivery comes back
  `sandbox` and no request leaves the account — proven by the rows, not by a
  mock;
- **no transport secret is set in dark**, so the notifications pump records
  `dropped` with `EMAIL_NOT_CONFIGURED` rather than pretending to have sent.

## Why the fixtures need no key

The envelopes the probe sends are the COMMITTED contract fixtures
(`packages/contracts/src/events/fixtures/*.json`), whose `sig` is the literal
marker `fixture`. Both dark environments set `ACCEPT_FIXTURE_SIG=on`, which is
the only mode in which `defineConsumer` accepts that marker. So the rig needs no
signing key, and **no key material exists in this repository, in a var or on a
command line**. Production sets `ACCEPT_FIXTURE_SIG=off`, where an unsigned
envelope is `forged` and never processed — `test/delivery.test.ts` and
`test/consumers.test.ts` both pin that.

## What it is not

- **Not a deployment.** `wrangler dev` runs locally; nothing here is uploaded,
  no workflow references `dev/`, and no Cloudflare resource is created. The
  `*-dark` Workers and databases are still gated on the owner (G1/G2).
- **Not a producer.** `producer-stub/` forwards whatever the probe hands it to
  `deliver()`. The real producer is the core's outbox pump (slice 1.6).
- **Not part of the service.** `tests/leastPrivilege.test.ts` reads
  `services/<name>/wrangler.jsonc` and `tests/serviceBoundaries.test.ts` scans
  `services/<name>/src`; `dev/` is neither, which is why the stub may hold both
  bindings at once.

## Cleaning up

```bash
rm -rf .wrangler/rig
```
