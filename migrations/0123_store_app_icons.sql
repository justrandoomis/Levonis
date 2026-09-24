-- ============================================================================
--  0123 — A MERCHANT'S INSTALLED APP CARRIES THE MERCHANT'S OWN ICON
-- ============================================================================
-- Wave 2 of the merchant platform (docs/MERCHANT_PLATFORM.md §4.5), stream W2-D.
--
-- NONDESTRUCTIVE. One new table, created IF NOT EXISTS. Nothing existing is
-- altered, dropped or backfilled, so a second run is a no-op and a Worker that
-- reaches an edge before this reaches D1 reads "no renditions" (every reader
-- of this table tolerates its absence — worker/lib/storeIcons.ts) and keeps
-- serving exactly what it served before: the platform icons.
--
-- ---------------------------------------------------------------------------
--  WHAT WAS MISSING (audit 01 §3.6)
-- ---------------------------------------------------------------------------
-- The per-host manifest named the store, but its icons were the merchant's
-- RAW upload — one entry, no `sizes`, usually a WebP — followed by the
-- platform's four sized PNGs. Chromium picks an icon by declared size, so it
-- installed the Levonis mark; iOS does not accept WebP for a home-screen icon,
-- so it kept the Levonis PNG too. A merchant's installed app carried the
-- store's NAME and, in the common case, the PLATFORM's icon — the opposite of
-- decision 11 («every merchant has an independent store — identity, subdomain,
-- PWA»).
--
-- ---------------------------------------------------------------------------
--  ONE ROW PER STORE, THREE PARTS
-- ---------------------------------------------------------------------------
--  1. THE COMMITTED SET — the PNG renditions that exist in R2 and are served:
--     192 and 512 (`any`), 512 maskable (padded into the safe zone on the
--     store's own ground colour), the 180 Apple touch icon and a 32 favicon.
--     Together with the logo they were cut from (`source_key` + the SHA-256
--     of its bytes), the geometry version (`recipe`) and the ground colour
--     (`tile_colour`). All of it is NULL until the first success, and all of
--     it moves at once — the CHECK below makes a half-written set
--     unrepresentable. A set is SERVED only while `source_key` is still the
--     store's `logo_key`, so a changed logo can never show the old icon.
--     The keys are content-addressed (`merchants/<owner>/logos/appicon-
--     <rev>-<role>.png`, `rev` a digest of source bytes + recipe + colour),
--     so a new logo is a new URL — which is what makes an INSTALLED app
--     notice the change (Chrome compares the manifest's icon URLs).
--  2. THE LAST FAILURE — `failed_fingerprint` names the (recipe, colour, logo)
--     that could not be made, with a stable reason code, an attempt count and
--     `retry_after`: a logo that cannot be rendered is not retried on every
--     manifest request.
--  3. THE ONE GENERATION IN FLIGHT — a lease (`lease_token`, until
--     `lease_until`) taken with a conditional upsert, so two requests never
--     render the same logo twice and a NEWER logo takes the lease from an
--     older one. Only the lease holder can commit, and its commit re-checks
--     that the store still has the logo it rendered.
--
-- Stale renditions are never deleted in place: the replaced keys are queued
-- on `media_cleanup_jobs`, whose guarded drain re-checks every reference
-- before a delete — so the key columns below are registered as reference
-- sources in worker/lib/mediaRefs.ts IN THE SAME CHANGE (an unregistered
-- key-bearing column makes that drain refuse to run at all).
--
-- Backfill for existing stores is LAZY and needs no job: the first manifest,
-- icon or share-kit request for a store whose renditions are missing or stale
-- takes the lease and renders them after the response (waitUntil).
CREATE TABLE IF NOT EXISTS merchant_store_icons (
  store_id TEXT PRIMARY KEY REFERENCES merchant_stores(id) ON DELETE CASCADE,

  -- 1. the committed set
  source_key TEXT,
  source_sha256 TEXT,
  recipe INTEGER CHECK (recipe IS NULL OR recipe >= 1),
  tile_colour TEXT CHECK (tile_colour IS NULL OR tile_colour GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  rev TEXT,
  icon192_key TEXT,
  icon512_key TEXT,
  maskable512_key TEXT,
  apple180_key TEXT,
  favicon32_key TEXT,
  generated_at TEXT,

  -- 2. the last failure
  failed_fingerprint TEXT,
  failure_reason TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  retry_after TEXT,

  -- 3. the one generation in flight
  lease_token TEXT,
  lease_fingerprint TEXT,
  lease_until TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- All or nothing: a served set is always complete.
  CHECK (
    (source_key IS NULL AND source_sha256 IS NULL AND recipe IS NULL AND tile_colour IS NULL AND rev IS NULL
      AND icon192_key IS NULL AND icon512_key IS NULL AND maskable512_key IS NULL
      AND apple180_key IS NULL AND favicon32_key IS NULL AND generated_at IS NULL)
    OR
    (source_key IS NOT NULL AND source_sha256 IS NOT NULL AND recipe IS NOT NULL AND tile_colour IS NOT NULL
      AND rev IS NOT NULL AND length(rev) = 16
      AND icon192_key IS NOT NULL AND icon512_key IS NOT NULL AND maskable512_key IS NOT NULL
      AND apple180_key IS NOT NULL AND favicon32_key IS NOT NULL AND generated_at IS NOT NULL)
  )
);
