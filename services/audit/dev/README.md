# The local rig — `levonis-audit`

Two Workers, one `wrangler dev`, no Cloudflare account touched.

```bash
# 1. create the local database and apply THIS service's migration to it
npx wrangler d1 execute levonis-audit-db-dark --local \
    -c services/audit/wrangler.jsonc --env dark \
    --file services/audit/migrations/0001_audit_init.sql \
    --persist-to .wrangler/dev-audit

# 2. run the producer stub (primary) and the audit service together
npx wrangler dev -c services/audit/dev/producer-stub/wrangler.jsonc \
                 -c services/audit/wrangler.jsonc \
                 --env dark --port 8811 --persist-to .wrangler/dev-audit

# 3. drive it
node services/audit/dev/probe.mjs http://localhost:8811
```

The first config is the primary — the stub, which is what the port serves. The
second is the real service. The stub carries the dark core's **name**
(`levonis-core-dark`) so the audit service's own `IDENTITY` binding resolves to
it, and binds `AUDIT` the way the bus will.

### Proving the cron

Only the primary config is served on the port, so to drive the audit Worker's
own `scheduled()` handler, swap the order and use wrangler's local trigger:

```bash
npx wrangler dev -c services/audit/wrangler.jsonc \
                 -c services/audit/dev/producer-stub/wrangler.jsonc \
                 --env dark --port 8812 --persist-to .wrangler/dev-audit

curl http://localhost:8812/health                    # the service's own HTTP
curl http://localhost:8812/cdn-cgi/local/scheduled   # one cron tick

npx wrangler d1 execute levonis-audit-db-dark --local \
    -c services/audit/wrangler.jsonc --env dark --persist-to .wrangler/dev-audit \
    --command "SELECT (SELECT COUNT(*) FROM audit_events WHERE chain_index IS NULL) AS unsealed,
                      (SELECT chain_index FROM audit_chain_heads) AS head"
```

After a tick, `unsealed` is 0 and `head` has advanced by the number of entries
that arrived through `record()` (which, unlike a delivery, does not seal
opportunistically).

## What the rig proves that the unit suites cannot

`services/audit/test/*` call the consumer in process against a SQLite shim. The
rig runs the service inside **workerd**, reached over a **real service
binding**, writing to a **real local D1**, with `ctx.waitUntil` and the cron
handler that the runtime provides and Node does not. Concretely it exercises:

- the RPC surface as RPC — `deliver`, `record`, `query`, `verifyChain`, `health`
  called across an isolate boundary, where arguments are serialised and a
  `D1PreparedStatement` could not cross even if someone tried;
- the **signature chain end to end**: the stub generates an Ed25519 key in
  memory, signs envelopes with it, publishes the public half through
  `IdentityEntrypoint.getPublicKeys()`, and the audit service fetches that over
  the binding and verifies with it — no key material in the repository, in a var
  or on a command line;
- the opportunistic seal in `waitUntil`, which has no equivalent under
  `node --test`;
- real D1 constraint behaviour for the append (`ON CONFLICT DO NOTHING`) and the
  chain fence.

## What it is not

- **Not a deployment.** `wrangler dev` runs locally; nothing here is uploaded,
  and no workflow references `dev/`.
- **Not the core.** The stub emits two envelope shapes and answers one Identity
  method. The dark stack (slices 1.4/1.6) puts the real core behind the same
  binding, with the same contract.
- **Not part of the service.** `tests/leastPrivilege.test.ts` reads
  `services/<name>/wrangler.jsonc` and `tests/serviceBoundaries.test.ts` scans
  `services/<name>/src` — this directory is neither, which is why a stub may
  carry another Worker's name and a probe script may speak plain HTTP.
