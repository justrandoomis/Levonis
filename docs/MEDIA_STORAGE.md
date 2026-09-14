# Levonis media storage

## Bindings and buckets

The Worker keeps three bindings during migration:

| Binding | Production | Staging | Purpose |
|---|---|---|---|
| `BUCKET` | `levonis-files` | `levonis-files-staging` | legacy mixed bucket; read fallback only for migrated flows |
| `R2_PUBLIC` | `levonis-media-public` | `levonis-media-public-staging` | anonymous-safe storefront/UI media |
| `R2_PRIVATE` | `levonis-media-private` | `levonis-media-private-staging` | authenticated evidence, chat, receipts, requests, warranty/support files |

Dark has the equivalent `levonis-files-dark`, `levonis-media-public-dark`, and
`levonis-media-private-dark` buckets. `worker/lib/mediaStorage.ts` is the only
bucket selector and key constructor. If the two new bindings are absent from a
local/test environment, it deliberately falls back to `BUCKET`; production
migration refuses to apply unless the dedicated destination exists.

Create the resources before deploying a config that binds them:

```bash
npx wrangler r2 bucket create levonis-media-public
npx wrangler r2 bucket create levonis-media-private
npx wrangler r2 bucket create levonis-media-public-staging
npx wrangler r2 bucket create levonis-media-private-staging
```

Create the `-dark` pair only when deploying the dark environment. Do not enable
an `r2.dev` public URL for `R2_PRIVATE`. Public files are still served by the
Worker's `/files/*` route so headers and legacy fallback remain consistent.

## New uploads

- The browser detects PNG/JPEG by magic bytes and converts product raster images
  to WebP through `src/lib/imagePreprocess.ts` before upload.
- The image is never upscaled; its longest edge is capped at 3,000px, alpha is
  retained, EXIF orientation is applied by the browser decoder, and WebP quality
  is 0.87.
- The Worker sniffs the result again, enforces the 8MB/dimension/pixel limits,
  and refuses a raw product PNG/JPEG with `PRODUCT_IMAGE_REQUIRES_WEBP`.
- GIF, AVIF, video, PDF and other attachments are not blindly converted.
- `file_objects` records the object key, visibility, logical domain, MIME,
  byte size, dimensions where known, owner/entity and audit filename. Private
  objects never use a permanent public URL as their source of truth.

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
uses Cloudflare Image Resizing to produce a validated WebP, uploads it, verifies
it, and only then atomically updates `product_images` and the legacy product JSON
mirrors. If Image Resizing is unavailable the endpoint returns
`MEDIA_TRANSFORM_UNAVAILABLE` without changing references.

The pre-existing `UIUx/Animation`, `UIUx/Icons`, and `UIUx/Logo` folders are
mapped to `ui/levonis/animations`, `ui/levonis/icons`, and `ui/levonis/logo`.
Exact settings references are updated; the old object is retained.

Every successful operation is logged in `file_migration_log` as
`verified_pending_cleanup`. The migration endpoint intentionally never deletes
the old object. Deletion is a separate, later operational decision after the
inventory proves no reference remains and backups/rollback have been verified.
