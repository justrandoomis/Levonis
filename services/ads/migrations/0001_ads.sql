-- levonis-ads — the service's OWN database (`levonis-ads-db` / `-dark`).
-- Owning service: ads (`01-TARGET.md` §2.1, `packages/contracts/src/ownership.ts`).
--
-- Applied by `svc-ads.yml` against the ads D1 only. It is NOT part of the
-- root `migrations/` stream: nothing here touches the shared core database,
-- and `node scripts/migrate-check.mjs` never sees it. `test/migrations.test.ts`
-- applies this file twice against a fresh SQLite database and proves the second
-- pass is a no-op, which is the same guarantee the root harness gives.
--
-- Every statement is idempotent (`IF NOT EXISTS`, `INSERT OR IGNORE`) so a
-- re-run after a partially applied deploy repairs rather than fails.

-- ---------------------------------------------------------------- providers
-- The per-provider kill switch (`01-TARGET.md` §9.1
-- `ads.providers.<name>.enabled`). A row exists for every adapter in the
-- registry; `enabled = 0` stops delivery for that provider without a deploy
-- and without touching the credential. It is NOT the same lever as "not
-- configured": a disabled provider gets no delivery row at all, an
-- unconfigured one gets `status='sandbox'`.
CREATE TABLE IF NOT EXISTS ads_providers (
  name       TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO ads_providers (name, enabled) VALUES
  ('meta_capi', 1),
  ('google_ads', 1),
  ('tiktok', 1),
  ('snapchat', 1),
  ('noop', 1);

-- --------------------------------------------------------------- event map
-- The seeded mapping of `01-TARGET.md` §9.1: our event type -> the name the
-- provider knows it by, one row per (event_type, provider). `enabled = 0` is
-- the per-event kill switch (`ads.events.<type>.enabled`), scoped per provider
-- so one platform can be silenced for one event without stopping the rest.
--
-- `UserUpdated -> CompleteRegistration` is the consent-change mapping: Ads
-- never sees `UserCreated`, because no consent can exist at signup
-- (`03-EVENTS.md` §3.1), and the row is only emitted the FIRST time a snapshot
-- reaches `ads` consent.
CREATE TABLE IF NOT EXISTS ads_event_map (
  event_type     TEXT NOT NULL,
  provider       TEXT NOT NULL REFERENCES ads_providers(name),
  provider_event TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  PRIMARY KEY (event_type, provider)
);

INSERT OR IGNORE INTO ads_event_map (event_type, provider, provider_event) VALUES
  ('PurchaseCompleted',  'meta_capi',  'Purchase'),
  ('PurchaseCompleted',  'google_ads', 'purchase'),
  ('PurchaseCompleted',  'tiktok',     'CompletePayment'),
  ('PurchaseCompleted',  'snapchat',   'PURCHASE'),
  ('UserUpdated',        'meta_capi',  'CompleteRegistration'),
  ('UserUpdated',        'google_ads', 'sign_up'),
  ('UserUpdated',        'tiktok',     'CompleteRegistration'),
  ('UserUpdated',        'snapchat',   'SIGN_UP'),
  ('AddToCart',          'meta_capi',  'AddToCart'),
  ('AddToCart',          'google_ads', 'add_to_cart'),
  ('AddToCart',          'tiktok',     'AddToCart'),
  ('AddToCart',          'snapchat',   'ADD_CART'),
  ('CheckoutStarted',    'meta_capi',  'InitiateCheckout'),
  ('CheckoutStarted',    'google_ads', 'begin_checkout'),
  ('CheckoutStarted',    'tiktok',     'InitiateCheckout'),
  ('CheckoutStarted',    'snapchat',   'START_CHECKOUT'),
  ('ProductViewed',      'meta_capi',  'ViewContent'),
  ('ProductViewed',      'google_ads', 'view_item'),
  ('ProductViewed',      'tiktok',     'ViewContent'),
  ('ProductViewed',      'snapchat',   'VIEW_CONTENT'),
  ('SubscriptionChanged','meta_capi',  'Subscribe'),
  ('SubscriptionChanged','google_ads', 'subscribe'),
  ('SubscriptionChanged','tiktok',     'Subscribe'),
  ('SubscriptionChanged','snapchat',   'SUBSCRIBE');

-- -------------------------------------------------------- consent snapshots
-- Keyed by `user_hash`, never by user id: Ads is a `pseudonymous` consumer and
-- the bus refuses to hand it a `personal` envelope at all.
--
-- `email_hash` / `phone_hash` are the SHA-256 hashes Identity computes IN
-- MEMORY on a consent change and puts on `UserUpdated`. They are stored ONLY
-- while `consent = 'ads'`; on any other value the consumer writes NULLs, which
-- is a drop BEFORE persistence, not a flag checked at send time
-- (`01-TARGET.md` §9.1, `03-EVENTS.md` §5 rule 2).
--
-- `first_ads_at` is what makes `CompleteRegistration` fire once: the mapping
-- is "consent changed to ads, first time", so the row remembers the first time
-- and every later consent refresh maps to nothing.
CREATE TABLE IF NOT EXISTS ads_consent_snapshots (
  user_hash    TEXT PRIMARY KEY,
  consent      TEXT NOT NULL CHECK (consent IN ('none','analytics','ads')),
  email_hash   TEXT,
  phone_hash   TEXT,
  first_ads_at TEXT,
  -- last aggregate_seq applied: reordering is tolerated by "last seq wins"
  -- (`01-TARGET.md` §5 "Poison"), so a late redelivery cannot resurrect a
  -- withdrawn consent.
  last_seq     INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ------------------------------------------------------------- deliveries
-- One row per (event_id, provider) — the UNIQUE constraint IS the idempotency
-- of this service (`03-EVENTS.md` §2.5): a redelivered envelope, a replayed
-- outbox row and a cron retry all land on the same row.
--
-- `status`:
--   pending    claimed, not yet attempted (only inside one invocation)
--   sent       the provider accepted it
--   sandbox    the provider's secrets are absent — the mapping was validated,
--              NOTHING left the account
--   no_consent the consent snapshot for this user_hash is not 'ads'
--   rejected   the provider answered 4xx: our payload is wrong, never retried
--   failed     transient (5xx/timeout); `next_attempt_at` holds the backoff
--   dead       out of attempts; a row was written to ads_dead_letters
CREATE TABLE IF NOT EXISTS ads_deliveries (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  provider        TEXT NOT NULL REFERENCES ads_providers(name),
  provider_event  TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL CHECK (status IN ('pending','sent','sandbox','no_consent','rejected','failed','dead')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  error           TEXT,
  -- the mapped provider payload, kept so a retry never re-derives it from an
  -- envelope this service no longer holds. Consent-gated identifiers are
  -- already dropped by the time it is written.
  payload         TEXT NOT NULL DEFAULT '{}',
  correlation_id  TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  delivered_at    TEXT,
  UNIQUE (event_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_ads_deliveries_retry
  ON ads_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_ads_deliveries_provider
  ON ads_deliveries(provider, created_at DESC);

-- ----------------------------------------------------------- dead letters
-- The DLQ (`01-TARGET.md` §11.4 "DLQ depth", alert > 0). A row here is a
-- delivery that will never be retried automatically; the admin replay reads it.
CREATE TABLE IF NOT EXISTS ads_dead_letters (
  id           TEXT PRIMARY KEY,
  delivery_id  TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  provider     TEXT NOT NULL,
  reason       TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  payload      TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (delivery_id)
);

-- ---------------------------------------------------------- platform tables
-- `<svc>_processed_events` and `<svc>_idempotency` (`01-TARGET.md` §4 item 10,
-- `03-EVENTS.md` §2.3). Their shape is the platform kit's — kept in sync with
-- `processedEventsSchemaSql('ads')` / `idempotencySchemaSql('ads')` by
-- `test/migrations.test.ts`, which compares this file's tables to what the kit
-- would create.
CREATE TABLE IF NOT EXISTS ads_processed_events (
  event_id     TEXT PRIMARY KEY,
  consumer     TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  result       TEXT
);

CREATE TABLE IF NOT EXISTS ads_idempotency (
  service      TEXT NOT NULL,
  scope        TEXT NOT NULL,
  key          TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status       INTEGER NOT NULL,
  body         TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (service, scope, key)
);
CREATE INDEX IF NOT EXISTS idx_ads_idempotency_created ON ads_idempotency(created_at);
