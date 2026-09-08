# `levonis-ads`

The only Worker on this platform that talks to an advertising platform. Nothing
in Orders or Checkout imports it, knows a provider's name, or holds a provider
credential.

- **What it is and how to call it:** `CONTRACT.md`.
- **Which secret NAMES it needs, and what happens without them:** `SECRETS.md`.
- **What it owns:** `OWNERSHIP.json` — five tables in its own D1, and it reads
  no other service's.
- **Run the whole thing locally, over real service bindings, with no
  Cloudflare account:** `dev/README.md`.

Status: **dark**. Nothing here is deployed. Creating `levonis-ads-dark` and
`levonis-ads-db-dark` changes the Cloudflare account and is gated on the owner
(G1/G2 in `docs/architecture/02-MIGRATION-PLAN.md`).

## The one thing to know

A provider whose secret NAMES are not all present is **not configured**, and an
unconfigured provider is replaced by the SANDBOX adapter: the mapping still
runs, the delivery row still says exactly what would have been sent, and no
request is made. There is no code path from an unconfigured provider to a
`fetch` — `test/delivery.test.ts` proves it by handing the engine a `fetch` that
throws.

That is also the emergency switch of `01-TARGET.md` §9.1, and it is stronger
than a flag: it removes the credential.

## Tests

```bash
npx tsx --test services/ads/test/*.test.ts     # or: npm run test:unit (runs every workspace)
npx tsc --noEmit -p services/ads/tsconfig.json # or: npm run check
```

## What a deploy workflow must do

`svc-ads.yml` belongs to the deploy-tooling slice (1.9). What it needs from
here:

| | |
|---|---|
| config | `services/ads/wrangler.jsonc`, `--env dark` for the dark Worker |
| Worker names | `levonis-ads-dark` (dark) / `levonis-ads` (live, later) |
| D1 to create by name | `levonis-ads-db-dark` / `levonis-ads-db`, id resolved at deploy time |
| migrations | `services/ads/migrations/`, applied **before** the code |
| secret NAMES to upload | exactly the list in `SECRETS.md`, from `ADS__<NAME>` |
| health | `GET /health` on the dark URL; through the gateway's fan-out in production |
| vars | `ADS_ENABLED` ships `off` in production and is turned on by a workflow run, not by hand |
