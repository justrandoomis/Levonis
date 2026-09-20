# Levonis media storage

## The true binding map

Read out of `wrangler.jsonc` and `studio/wrangler.jsonc`, not assumed.
`tests/mediaBuckets.test.ts` fails if this table and those configs disagree.

| Environment | Worker | `BUCKET` | `R2_PUBLIC` | `R2_PRIVATE` |
|---|---|---|---|---|
| top-level ("production") | `levonis` — **does not exist on the account** | `levonis-files` | `levonis-media-public` | `levonis-media-private` |
| `env.staging` | `levonis-staging` — **this is what serves levonis-iq.com** | `levonis-files-staging` | `levonis-media-public-staging` | `levonis-media-private-staging` |
| `env.dark` | `levonis-core-dark` — deployed by nothing yet | `levonis-files-dark` | `levonis-media-public-dark` | `levonis-media-private-dark` |
| Studio top-level | `levonis-studio` — workers.dev only | `levonis-studio-files` | — | — |
| Studio `env.staging` | `levonis-studio-staging` — serves studio.levonis-iq.com | `levonis-studio-files-staging` | — | — |

The `-staging` names are historical; those are the production Workers. See
`docs/WORKERS.md`.

### What is on the account, and what references it

| Bucket | Objects | Referenced by |
|---|---|---|
| `levonis-files-staging` | 22 / 6.28 MB | `BUCKET` of the LIVE store Worker. **All of the store's media is here.** |
| `levonis-media-public-staging` | 0 | `R2_PUBLIC` of the LIVE store Worker |
| `levonis-media-private-staging` | 0 | `R2_PRIVATE` of the LIVE store Worker |
| `levonis-studio-files-staging` | 0 | `BUCKET` of the LIVE Studio Worker — a **separate application** |
| `levonis-studio-files` | 0 | `BUCKET` of `levonis-studio`, the alternate Studio Worker |
| `levonis-files` | 0 | `BUCKET` of the top-level block, i.e. of a Worker that does not exist |
| `levonis` | 0 | **nothing in this repository** — no wrangler config, no workflow, no script |

And the reverse: `levonis-media-public` and `levonis-media-private` are
**bound by the top-level block and do not exist on the account.**

### A binding to a bucket that does not exist

Nothing validates a bucket name against the account at deploy time, so this
config deploys cleanly and fails per request, at the first R2 call, for as long
as it is live. `mediaBucket()` resolves a binding with
`env.R2_PUBLIC ?? env.BUCKET`; a binding to a missing bucket is an ordinary
`R2Bucket` object, so `??` never fires and the legacy bucket is never consulted.

`worker/lib/mediaStorage.ts` now catches that rejection, logs
`media_primary_bucket_unavailable`, and still serves the object from the legacy
bucket. `GET /api/admin/media/migration/status` asks R2 directly so the
condition is visible before a customer finds it.

This does **not** affect levonis-iq.com today: the live Worker is `env.staging`
and all three of its buckets exist. It affects the top-level block, and it
would have been a total media outage the first time that block was deployed
anywhere real.

### Provisioning

Do not enable an `r2.dev` public URL for `R2_PRIVATE`. Public files are served
by the Worker's `/files/*` route so headers and the legacy fallback stay
consistent. Create the `-dark` pair only when deploying the dark environment.

## Product-image ingestion

All new product-image ingestion uses one server-side pipeline. A product image
uploaded through the admin UI and a remote image requested by TXT
`images.N.fetch_url` both arrive at the Worker as source bytes. The Worker:

1. identifies the format from the bytes rather than trusting a filename or
   request `Content-Type`, rejects HTML/XML masquerading as an image, and
   applies source and output size limits;
2. asks the Cloudflare Images binding to decode the source and return a
   validated WebP, re-encoding supported non-WebP sources (JPEG, PNG, WebP,
   AVIF and static GIF sources are accepted; animated GIF is rejected rather
   than silently flattened);
3. hashes the **final WebP bytes** with SHA-256 and builds a content-addressed
   `products/<namespace>/gallery/<sha256>.webp` key;
4. creates that R2 object conditionally, so an existing object at the same
   canonical key is reused rather than overwritten; and
5. returns the only delivery address the catalogue may store:
   `url=/files/<key>`, with the same value in `key`/`r2_key` and with the
   verified MIME, byte count and dimensions.

Conversion is therefore not a browser-canvas contract. The browser may send a
raw supported product image, including PNG or JPEG; the Worker is responsible
for sniffing, conversion, validation, naming and persistence. If Cloudflare
Images is unavailable or cannot decode/convert the bytes, the product-image
write fails instead of storing an unverified source file.

`file_objects` records the R2 key, visibility, logical domain, MIME, byte size,
dimensions, owner/entity and audit filename. Video, PDF and other non-product
attachments keep their own upload policy; the WebP invariant above applies to
product images.

### TXT remote fetch and provenance

`fetch_url` is an instruction to the import operation, not stored media. Apply
accepts an HTTP(S) URL, fetches each distinct source once for that Apply, and
runs the returned bytes through the same server-side WebP pipeline. Remote
fetches have redirect, timeout, byte-budget and address-safety checks; a
redirect is validated before it is followed.

| Field | Meaning after a successful Apply |
|---|---|
| `fetch_url` | One-shot remote import input. It is never stored and never exported. |
| `source_url` | Provenance: the original supplier URL supplied to the import. It may be external, but it is never a delivery URL and never triggers a later fetch by itself. |
| `url` | The local delivery URL, exactly `/files/<key>`. |
| `key` / `r2_key` | The owned R2 object key, exactly matching the suffix of `url`. |

An exported TXT therefore contains the local `url` and `key` plus
`source_url`, but no `fetch_url`. Re-importing that export reuses and verifies
the local object; it does not contact the supplier again. Legacy external
values supplied in an image `url` field are treated as import-only fetch
intent, with a warning, and are normalized to the same local fields.

There are no product hotlinks. Catalogue and storefront projections only use
canonical `/files/<key>` product media. An external `source_url` is retained
solely as provenance and must never be rendered as the product image.

### Deduplication and delayed cleanup

Deduplication happens at two levels: one TXT Apply fetches a repeated
`fetch_url` once, and the final WebP is addressed by its SHA-256 digest. R2
creation is conditional, and the ingest result records whether that operation
actually created the object (`created_new`) or reused the canonical key.

R2 and D1 do not share a transaction. If Apply fails after staging media, only
objects marked `created_new` by that operation are put into the durable
`media_cleanup_jobs` queue; reused/pre-existing objects are never treated as
rollback-owned. Rollback does not delete from R2 inline. Its jobs have a
15-minute `not_before` grace period, and reuse of a key renews the grace on any
pending cleanup job for that key.

When a job becomes due, the guarded cleanup worker rebuilds the live media
reference set before deletion. A referenced/shared key is preserved and the
job closes as `skipped_shared`; incomplete reference coverage refuses the
delete; transient R2 failures remain retryable until the queue's attempt limit.
This delayed check is what makes deduplicated keys safe to share across
multiple catalogue rows.

## Safe existing-data migration

Apply migration `0068_media_objects.sql` first. Then use the admin-only API:

1. `GET /api/admin/media/migration/inventory?limit=250`
2. Follow `cursor` until `truncated` is false.
3. Review each returned plan. Unreferenced objects are only labelled
   `orphan_candidate`; nothing deletes them.
4. Call `POST /api/admin/media/migration/apply` with `{ "key": "…" }` for a
   dry run.
5. Repeat with `{ "key": "…", "confirm": true }` to apply that one object.

Referenced WebP/GIF/AVIF and private attachments are copied byte-for-byte to
the correct bucket and read back for verification. Product PNG/JPEG migration
uses the Cloudflare Images binding to produce a validated WebP, uploads it,
verifies it, and only then atomically updates `product_images` and the legacy
product JSON mirrors. If Cloudflare Images is unavailable the endpoint returns
`MEDIA_TRANSFORM_UNAVAILABLE` without changing references.

The pre-existing `UIUx/Animation`, `UIUx/Icons`, and `UIUx/Logo` folders are
mapped to `ui/levonis/animations`, `ui/levonis/icons`, and `ui/levonis/logo`.
Exact settings references are updated; the old object is retained.

Every successful operation is logged in `file_migration_log` as
`verified_pending_cleanup`. The migration endpoint intentionally never deletes
the old object. Deletion is a separate, later operational decision after the
inventory proves no reference remains and backups/rollback have been verified.

## The split rule — what decides public from private

There is exactly ONE implementation, and everything goes through it:

- `isAnonymousPublicMediaKey(key)` in `worker/lib/mediaStorage.ts` is the rule.
- `planLegacyMediaKey(key, referenced)` in `worker/lib/mediaMigration.ts` is the
  only caller that matters for the migration:
  `visibility = isAnonymousPublicMediaKey(key) ? 'public' : 'private'`.
- The `/files/*` route asks the same function to decide whether a request needs
  a signed-in user at all, so the bucket an object sits in and the access check
  it gets can never disagree.

PUBLIC is a closed list of prefixes that are already served to anyone who asks:

```
products/                 avatars/                  community/
users/<id>/avatar/        users/<id>/public-avatars/
merchants/<id>/public/    merchants/<id>/logos/     merchants/<id>/covers/
ui/                       UIUx/                     brands/                services/
```

PRIVATE is **everything else**, and that is the point — the rule is default-deny,
so a prefix nobody has thought of yet lands in the private bucket rather than on
the open internet. `chat/`, `receipts/`, `kyc/`, `warranty/`, `claims/`,
`orders/`, `imports/`, `requests/`, `support/`, `reviews-evidence/` are private
by that default. `reviews/` is deliberately private too: whether a review photo
is published is decided by its authorised API route, never by its prefix.

**The key does not change when the bucket does.** `buildMediaKey` deliberately
does not encode visibility into the path, so moving an object between buckets
keeps every `r2_key` and `/files/...` reference in D1 valid with no database
write at all. The one rename this system wants — `UIUx/*` to `ui/levonis/*` — is
NOT done by the move workflow, because it has to rewrite `settings` rows in the
same D1 batch. `POST /api/admin/media/migration/apply` does that, one object at
a time, and already exists.

## Moving `levonis-files-staging` into the two media buckets

Workflow **`38 - Move legacy media into the public/private buckets`**.

### Before you start, once

Create an R2 API token: Cloudflare dashboard → R2 → API → *Manage API tokens* →
*Create token*, permission **Object Read & Write**, scoped to
`levonis-files-staging`, `levonis-media-public-staging` and
`levonis-media-private-staging`. Save the two halves as repository secrets
`R2_S3_ACCESS_KEY_ID` and `R2_S3_SECRET_ACCESS_KEY`.

This is a different credential from `CLOUDFLARE_API_TOKEN`, and it is needed
because R2's object API is S3-only: wrangler can get, put and delete a single
object but cannot LIST a bucket, and a migration that cannot enumerate its
source is not a migration.

### Step 1 — copy and verify (deletes nothing)

Run workflow 38 with:

| input | value |
|---|---|
| `confirm` | `MIGRATE-MEDIA` |
| `source_bucket` | `levonis-files-staging` |
| `public_bucket` | `levonis-media-public-staging` |
| `private_bucket` | `levonis-media-private-staging` |
| `delete_confirm` | **leave empty** |

Only the `copy` job runs. It copies server-side (the bytes never leave
Cloudflare), then proves each copy by size plus ETag, or by downloading both
sides and comparing SHA-256 when the ETags are not comparable. It deletes
nothing under any input.

**Check between steps.** Read the job summary table: every row must say
`VERIFIED`. Then, still before deleting anything:

1. Open levonis-iq.com and load a product page, a merchant store page and a
   signed-in page with a receipt or a chat image. Everything must still work —
   at this point both buckets hold the objects, so it cannot look different.
2. Call `GET /api/admin/media/migration/status` as an admin. Expect
   `buckets.public.reachable` and `buckets.private.reachable` to be `true`, and
   `complete` to be `true`. `complete` is `null`, never `false`, when the page
   it read was not the whole bucket — it will not claim a result it cannot
   support.
3. In the Worker's logs, `media_legacy_fallback` lines should have stopped.
   Each one names the key that is still only in the legacy bucket. **When those
   lines stop, the migration is actually finished** — that is the whole signal.

### Step 2 — delete the legacy source objects

Re-run the same workflow with the same four inputs **and** `delete_confirm` set
to `DELETE-LEGACY-SOURCE`.

The `copy` job runs again first — it is idempotent, so it copies nothing new and
simply re-verifies — and only then does the `prune` job start. `prune` refuses
unless the manifest from that run is for these exact buckets and says every
object verified, and it re-checks each object at its destination immediately
before deleting that object's source. Anything that fails is kept, not deleted.

Neither job creates, renames or deletes a **bucket**. That is a dashboard
decision and it is yours.

### If step 2 looks wrong

Nothing needs to be undone in code, and there is no rollback to run.

- **Step 1 looked wrong:** nothing was deleted. The legacy bucket is untouched
  and is still being read through the fallback. Empty the destination buckets by
  hand if you want a clean retry; the workflow is re-runnable either way.
- **Step 2 deleted sources and something is now missing:** the object is in
  `levonis-media-public-staging` or `levonis-media-private-staging` under the
  **same key** — that is why keys are never rewritten. Copy it back to
  `levonis-files-staging` under the same key and the fallback serves it again:
  `aws s3api copy-object --endpoint-url https://<account>.r2.cloudflarestorage.com --bucket levonis-files-staging --key <key> --copy-source <destination-bucket>/<key>`
- **The whole step-2 run looks wrong:** every deletion is recorded in the
  `media-prune-manifest` artifact with the key, the destination bucket and the
  proof used. That artifact is the list of what to copy back.

Do not reach for a D1 restore: the move performs no database write at all.

## Recommended bucket decisions — evidence only, the call is yours

Nothing here is acted on by any workflow in this repository.

| Bucket | Evidence | Note |
|---|---|---|
| `levonis` | 0 objects; referenced by no wrangler config, no workflow, no script in this repository | Nothing would break. Confirm it is not used by something outside this repo first. |
| `levonis-files` | 0 objects; bound as `BUCKET` by the top-level block, whose Worker `levonis` does not exist | Deleting it makes workflow 3 fail at deploy instead of at request time. Repointing the top-level block is the other option. |
| `levonis-studio-files` | 0 objects; bound by `levonis-studio`, the alternate Studio Worker | **Belongs to the separate Studio app.** Not the store's to delete. |
| `levonis-studio-files-staging` | 0 objects; bound by `levonis-studio-staging`, which serves studio.levonis-iq.com | **In live use by Studio.** Empty only because Studio has no projects yet. Keep. |
| `levonis-media-public-staging` | 0 objects; `R2_PUBLIC` of the live store Worker | Keep — this is a destination of the move above. |
| `levonis-media-private-staging` | 0 objects; `R2_PRIVATE` of the live store Worker | Keep — this is the other destination. |
| `levonis-files-staging` | 22 objects, 6.28 MB; `BUCKET` of the live store Worker | Keep until step 2 has run and the site has been checked. It is the only copy. |

Two buckets the config names and the account does not have —
`levonis-media-public` and `levonis-media-private` — are a separate decision:
either create them, or repoint the top-level block. Both are changes to the
Cloudflare account or to a deploy path, so neither was made here.
