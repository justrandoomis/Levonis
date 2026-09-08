# The local rig

Two Workers, one command, no Cloudflare account touched:

```bash
npx wrangler dev -c services/gateway/wrangler.jsonc \
                 -c services/gateway/dev/core-stub/wrangler.jsonc \
                 --env dark --port 8803 --var STORE_ROOT_DOMAIN:levonis-iq.com

node services/gateway/dev/probe.mjs http://localhost:8803
```

The first config is the primary (the gateway, `env.dark`); the second is a stub
that carries the dark core's NAME, so the gateway's `services` bindings resolve
to it locally. `--var STORE_ROOT_DOMAIN:levonis-iq.com` is what makes host
classification real: without a root domain every hostname is `foreign` and the
apex/storefront distinction — the guard this Worker exists for — cannot be
exercised.

To drive the whole principal chain as well, add `--var PRINCIPAL_MODE:on` and
run the probe with `PRINCIPAL_MODE=on`. The stub Identity generates an Ed25519
key **in memory** on first use, signs a principal with it, and publishes the
public half through `getPublicKeys()`; the gateway fetches it over RPC, verifies
the signature, and answers the capability guard from the signed claims. No key
material exists in the repository, in a var, or on a command line.

## What the rig proves that the unit suites cannot

`services/gateway/test/*` drive the real Hono app but stub the binding. The rig
runs the gateway inside **workerd**, reached over a **real service binding**,
with the real `ratelimits` binding and the real Cache API. That difference has
already earned its keep: workerd hands a bodiless `POST` a **non-null empty body
stream**, so the "a body needs a content type" rule — written against
`request.body !== null`, which is correct for HTTP/2 — refused every one of the
SPA's 41 bodiless `POST`/`DELETE` calls with a 415. `hasBody()` now treats a
declared `Content-Length: 0` as authoritative, and `test/validation.test.ts`
pins it.

## What it is not

- Not a deployment. `wrangler dev` runs locally; nothing here is ever uploaded,
  and no workflow references `dev/`.
- Not the core. The stub answers `fetch` by echoing what it was handed and
  implements the four `IdentityEntrypoint` methods the gateway may call. The
  dark stack (slice 1.4) puts the real core behind the same binding.
- Not `services/gateway/dev` in any ownership sense: `tests/leastPrivilege.test.ts`
  reads `services/<name>/wrangler.jsonc`, and `tests/serviceBoundaries.test.ts`
  scans `services/<name>/src` — this directory is neither.
