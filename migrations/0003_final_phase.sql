-- Levonis migration 0003 — final phase: contact verification (Telegram),
-- email verification, notification outbox + invoices, serialized devices &
-- per-unit warranty, reviews & gift levels, returns, price history &
-- protection, ticket ledger & game sessions, policy documents & consent,
-- PRO KYC cases & approved addresses, restriction cases.
-- NONDESTRUCTIVE: ADD COLUMN / CREATE TABLE only.

PRAGMA defer_foreign_keys = true;

-- ------------------------------------------------ Telegram linking & OTP

-- One verified Telegram binding per account; telegram user may bind once.
CREATE TABLE telegram_links (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  chat_id INTEGER NOT NULL,
  phone_e164 TEXT NOT NULL,            -- normalized +964...
  verified_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Short-lived single-use linking challenges. id = SHA-256 of the deep-link
-- nonce (raw nonce never stored). session_ref binds to the originating
-- browser session/pending registration.
CREATE TABLE link_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('signup','link','recovery','phone_change')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,   -- NULL for signup
  session_ref TEXT NOT NULL DEFAULT '',
  phone_entered TEXT NOT NULL,          -- normalized E.164 entered on the site
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','contact_received','phone_verified','browser_confirmed','linked','expired','revoked')),
  telegram_user_id INTEGER,
  chat_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX idx_link_challenges_user ON link_challenges(user_id, state);

-- OTPs delivered over the verified private chat. verifier = SHA-256(code).
CREATE TABLE otp_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('signup','login','reset','phone_change')),
  verifier TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  superseded_by TEXT,                   -- resend invalidation chain
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX idx_otp_user ON otp_challenges(user_id, purpose);

-- Webhook update dedup (Telegram redelivers).
CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ------------------------------------------------------ email verification

ALTER TABLE users ADD COLUMN email_verified_at TEXT;

CREATE TABLE email_verification_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  new_email TEXT,                       -- set for email-change verification
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- --------------------------------------------------- outbox and invoices

-- Durable notification outbox: business events commit atomically with their
-- outbox row (unique event_key); a delivery outage never undoes a purchase.
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('email','telegram')),
  event_key TEXT NOT NULL UNIQUE,       -- e.g. invoice:ORD-X:1, otp:<id>
  recipient TEXT NOT NULL,              -- email address or chat id
  payload TEXT NOT NULL,                -- JSON (subject/body/template ref)
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','failed','dead','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT
);
CREATE INDEX idx_outbox_state ON outbox(state, created_at);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,                  -- internal id
  invoice_no TEXT NOT NULL UNIQUE,      -- e.g. INV-2026-000001
  order_id TEXT NOT NULL REFERENCES orders(id),
  revision INTEGER NOT NULL DEFAULT 1,  -- credit notes/corrections append
  snapshot TEXT NOT NULL,               -- JSON: lines, fees, discounts, totals
  amount_paid_iqd INTEGER NOT NULL DEFAULT 0,
  amount_due_iqd INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL CHECK (payment_status IN ('unpaid','partial','paid','cod_due','bnpl_due')),
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  superseded_by TEXT,
  UNIQUE (order_id, revision)
);

-- --------------------------------------- serialized devices and warranty

-- One row per PHYSICAL eligible unit (5 printers + 1 AMS = 6 rows).
CREATE TABLE order_item_units (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  order_item_id TEXT NOT NULL REFERENCES order_items(id),
  product_id TEXT,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  unit_index INTEGER NOT NULL,          -- 1..qty within the order item
  delivered_at TEXT,                    -- per-unit delivery (partial shipments)
  warranty_base_months INTEGER,         -- from product policy at purchase
  warranty_ext_months INTEGER NOT NULL DEFAULT 0, -- purchased extension (+12/+24)
  warranty_start_at TEXT,               -- = delivered_at (never registration)
  warranty_end_at TEXT,
  policy_version TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (order_item_id, unit_index)
);
CREATE INDEX idx_units_owner ON order_item_units(owner_user_id);
CREATE INDEX idx_units_order ON order_item_units(order_id);

-- Serial assignment: exact raw value preserved; normalized for lookup.
CREATE TABLE device_serials (
  serial_norm TEXT PRIMARY KEY,         -- normalized (upper, no spaces/dashes)
  serial_raw TEXT NOT NULL,
  unit_id TEXT NOT NULL UNIQUE REFERENCES order_item_units(id),
  assigned_by TEXT NOT NULL,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  replaced_by_serial TEXT,              -- replacement device chain
  note TEXT NOT NULL DEFAULT ''
);

-- Customer registration/activation of a delivered unit (features only —
-- NEVER affects coverage dates).
CREATE TABLE device_registrations (
  unit_id TEXT PRIMARY KEY REFERENCES order_item_units(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

ALTER TABLE warranty_claims ADD COLUMN unit_id TEXT REFERENCES order_item_units(id);
ALTER TABLE warranty_claims ADD COLUMN assigned_staff TEXT;
ALTER TABLE warranty_claims ADD COLUMN decision TEXT;        -- repair|replace|reject|misuse
ALTER TABLE warranty_claims ADD COLUMN decision_reason TEXT;
ALTER TABLE warranty_claims ADD COLUMN evidence TEXT;        -- JSON private keys

CREATE TABLE claim_messages (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES warranty_claims(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  is_staff INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL DEFAULT '',
  file_key TEXT,                        -- private claims/ prefix
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_claim_messages ON claim_messages(claim_id, created_at);

-- Per-product operational policy consumed by warranty/shipping/gifts
-- (edited through the product editor/template registry):
-- {warranty_eligible, warranty_base_months, serialized, size_class:
--  'ordinary'|'printer_small'|'printer_large', extensions:[{months,fee_iqd}],
--  review_gift_eligible, spare_part_compat:[product ids], offer_ticket_award}
ALTER TABLE products ADD COLUMN ops_policy TEXT NOT NULL DEFAULT '{}';

-- --------------------------------------------- reviews and gift levels

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  order_item_id TEXT REFERENCES order_items(id),
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  body TEXT NOT NULL DEFAULT '',
  media TEXT NOT NULL DEFAULT '[]',     -- JSON [{key,kind:'image'|'video'}]
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','rejected')),
  moderation_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, product_id)          -- one review per user per product
);
CREATE INDEX idx_reviews_product ON reviews(product_id, status);

-- Reward evaluation is SEPARATE from public review moderation. Quality
-- score is a rubric of usefulness — never sentiment/stars.
CREATE TABLE review_rewards (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL UNIQUE REFERENCES reviews(id),
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('printer_gift','points')),
  instagram_evidence TEXT NOT NULL DEFAULT '',  -- private link/key for admin review
  eligibility TEXT NOT NULL DEFAULT '{}',       -- JSON checklist facts (delivered unit, media present...)
  quality_score INTEGER CHECK (quality_score IS NULL OR quality_score BETWEEN 1 AND 5),
  state TEXT NOT NULL DEFAULT 'submitted' CHECK (state IN
    ('submitted','revision_needed','approved','rejected')),
  points_awarded INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Approved gift: score N unlocks ONE box from levels 1..N.
CREATE TABLE gift_entitlements (
  id TEXT PRIMARY KEY,
  reward_id TEXT NOT NULL UNIQUE REFERENCES review_rewards(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  max_level INTEGER NOT NULL CHECK (max_level BETWEEN 1 AND 5),
  chosen_level INTEGER CHECK (chosen_level IS NULL OR chosen_level BETWEEN 1 AND 5),
  chosen_options TEXT NOT NULL DEFAULT '{}',  -- JSON: nozzle size, plate model
  contents TEXT NOT NULL DEFAULT '[]',        -- JSON server-chosen contents, persisted ONCE
  state TEXT NOT NULL DEFAULT 'available' CHECK (state IN
    ('available','selected','fulfilled','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  selected_at TEXT,
  fulfilled_at TEXT
);
CREATE INDEX idx_gift_entitlements_user ON gift_entitlements(user_id, state);

-- Admin-configured pools per level (items/stock come from the owner).
CREATE TABLE gift_pools (
  id TEXT PRIMARY KEY,
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL DEFAULT '[]',     -- JSON [{label, product_id?, stock}]
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- --------------------------------------------------------------- returns

CREATE TABLE return_cases (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  order_item_id TEXT NOT NULL REFERENCES order_items(id),
  unit_id TEXT REFERENCES order_item_units(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  qty INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  reason TEXT NOT NULL CHECK (reason IN
    ('defective','manufacturing_fault','not_as_described','wrong_item','shipping_damage')),
  description TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '[]',  -- JSON private keys
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  delivered_at_snapshot TEXT,           -- the unit/item delivery time used for the 7-day window
  within_window INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'requested' CHECK (state IN
    ('requested','assessment','approved','rejected','collection','received','inspected','resolved')),
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('replacement','refund','repair','declined')),
  admin_note TEXT NOT NULL DEFAULT '',
  decided_by TEXT,
  decided_at TEXT
);
CREATE INDEX idx_return_cases_user ON return_cases(user_id, state);

-- --------------------------------------- price history and protection

CREATE TABLE price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  variant_key TEXT NOT NULL DEFAULT '', -- '' | option:<id> | color:<id>
  field TEXT NOT NULL CHECK (field IN ('regular','pro','compare_at')),
  old_iqd INTEGER,
  new_iqd INTEGER,
  changed_by TEXT NOT NULL DEFAULT '',
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_price_history_product ON price_history(product_id, changed_at);

CREATE TABLE price_protection_claims (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  order_item_id TEXT NOT NULL REFERENCES order_items(id),
  original_unit_iqd INTEGER NOT NULL,
  observed_unit_iqd INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  credited_iqd INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'requested' CHECK (state IN
    ('requested','approved','rejected','credited')),
  policy_snapshot TEXT NOT NULL DEFAULT '{}',
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_by TEXT,
  decided_at TEXT
);
CREATE INDEX idx_ppc_item ON price_protection_claims(order_item_id);

-- ------------------------------------------------- points idempotency,
-- tickets and game sessions (points VALUE lives in wallet_transactions
-- currency='POINT'; this guard table makes each source award exactly once)

CREATE TABLE points_awards (
  source_ref TEXT PRIMARY KEY,          -- e.g. order:ORD-X:settle, review:<id>
  user_id TEXT NOT NULL,
  points INTEGER NOT NULL,              -- positive award or negative reversal
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE ticket_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  delta INTEGER NOT NULL,               -- +grant / -consume
  kind TEXT NOT NULL CHECK (kind IN
    ('points_redeem','product_offer','daily_pro','game_entry','admin','expiry','refund')),
  source_ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (kind, source_ref)
);
CREATE INDEX idx_ticket_ledger_user ON ticket_ledger(user_id);

CREATE TABLE game_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  game TEXT NOT NULL,
  ticket_entry_id TEXT REFERENCES ticket_ledger(id),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','settled','void')),
  score INTEGER,
  points_awarded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  settled_at TEXT
);
CREATE INDEX idx_game_sessions_user ON game_sessions(user_id, state);

-- --------------------------------------------- policies and consent

CREATE TABLE policy_documents (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,                    -- terms|privacy|warranty|returns|delivery|payment|membership|rewards|competitions
  version INTEGER NOT NULL,
  lang TEXT NOT NULL CHECK (lang IN ('ar','en','ckb')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  hash TEXT NOT NULL,                   -- content hash recorded on acceptance
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (key, version, lang)
);

CREATE TABLE policy_acceptances (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  policy_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  hash TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',     -- order id / membership id / signup
  accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, policy_key, version, context)
);

-- ------------------------------------- PRO KYC and approved addresses

-- Sensitive identity fields stored application-layer encrypted
-- (worker/lib/sealbox.ts, key from env secret KYC_ENC_KEY, versioned).
CREATE TABLE kyc_cases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  full_name_enc TEXT NOT NULL DEFAULT '',
  dob_enc TEXT NOT NULL DEFAULT '',
  doc_type TEXT CHECK (doc_type IS NULL OR doc_type IN ('national_id','passport')),
  evidence_keys TEXT NOT NULL DEFAULT '[]',  -- JSON, private kyc/ prefix only
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN
    ('draft','submitted','reviewing','changes_requested','rejected','verified')),
  reason TEXT NOT NULL DEFAULT '',
  submitted_at TEXT,
  decided_by TEXT,
  decided_at TEXT,
  retention_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_kyc_user ON kyc_cases(user_id, state);

-- Versioned approved default PRO address; approval is a staff act. The
-- approved row is immutable — a change request creates a new version.
CREATE TABLE approved_addresses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  address TEXT NOT NULL,
  landmark TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','superseded','rejected')),
  reason TEXT NOT NULL DEFAULT '',
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_by TEXT,
  approved_at TEXT,
  UNIQUE (user_id, version)
);
CREATE INDEX idx_approved_addresses_user ON approved_addresses(user_id, state);

-- Independent restriction states (debt/fraud/kyc/refusal) — address
-- selection can never clear these; they gate benefits, never login/support.
CREATE TABLE restriction_cases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('debt','fraud','kyc','refusal','other')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','resolved')),
  reason TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '[]',
  opened_by TEXT NOT NULL DEFAULT '',
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_by TEXT,
  resolved_at TEXT,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_restrictions_user ON restriction_cases(user_id, state);
