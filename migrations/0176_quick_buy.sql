-- 0176 — QUICK BUY «الشراء السريع» (owner brief 2026-10-06 §3–§21,
-- docs/GIFTS_QUICK_BUY.md §3).
--
-- A Quick Buy session is the DRAFT of one ordinary order. For 30 minutes from
-- the first quick purchase the customer adds direct-sale products from any
-- product page; the Levo wallet HOLDS the running total and every item's
-- units are RESERVED; when the 30 minutes end the server creates the order
-- through the very checkout the cart uses, with the order id reserved here at
-- the start.
--
-- Nothing in this file is a second order table, wallet or inventory: holds
-- live in wallet_holds, reservations in inventory_ledger, the order in orders
-- (orders.order_kind = 'quick_buy', orders.quick_buy_session_id — 0174).
-- Additive only.

-- The customer's standing Quick Buy choice: on/off, the default address and
-- the consent it was switched on under (§5). `address_id` carries no foreign
-- key on purpose: deleting an address must never fail because Quick Buy once
-- pointed at it — Quick Buy re-validates the address at every use instead.
CREATE TABLE IF NOT EXISTS quick_buy_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  address_id TEXT,
  terms_version INTEGER,
  privacy_version INTEGER,
  policy_version INTEGER,
  consented_at TEXT,
  wallet_consent_at TEXT,
  -- The policy_acceptances rows recorded at activation: {"terms":"pac_…",…}.
  consent_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One session per purchase window. `expires_at` is fixed at the start and
-- never moves (§9); the server decides every edit against it (§18).
CREATE TABLE IF NOT EXISTS quick_buy_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'submitted', 'cancelled', 'failed')),
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- Reserved at the start; the finalised order is created with exactly this
  -- id, so two finalisers racing collide on orders.id and one rolls back.
  order_id TEXT NOT NULL UNIQUE,
  address_id TEXT NOT NULL,
  -- The delivery address frozen at the start (§15): name, phone, governorate,
  -- area, street, landmark. A later change to the default address applies to
  -- the next session only.
  address_snapshot TEXT NOT NULL,
  delivery_method_id TEXT NOT NULL DEFAULT 'standard',
  -- The rate the held cents were computed at; the order pays at the same rate.
  exchange_rate INTEGER NOT NULL CHECK (exchange_rate > 0),
  rev INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  -- The ONE active wallet hold, replaced in the same batch on every change so
  -- the held amount always equals the session total (D11).
  hold_id TEXT,
  held_iqd INTEGER NOT NULL DEFAULT 0 CHECK (held_iqd >= 0),
  held_cents INTEGER NOT NULL DEFAULT 0 CHECK (held_cents >= 0),
  items_iqd INTEGER NOT NULL DEFAULT 0,
  discount_iqd INTEGER NOT NULL DEFAULT 0,
  shipping_iqd INTEGER NOT NULL DEFAULT 0,
  shipping_before_iqd INTEGER NOT NULL DEFAULT 0,
  total_iqd INTEGER NOT NULL DEFAULT 0 CHECK (total_iqd >= 0),
  -- The last quote the hold was sized from (totals, delivery, free-delivery rule).
  quote_json TEXT NOT NULL DEFAULT '{}',
  -- The policy versions and acceptance rows this session was started under.
  consent_json TEXT NOT NULL DEFAULT '{}',
  -- The printer standard-delivery warning as the customer accepted it, when a
  -- printer is in the session (packages/shipping/src/printerDeliveryPolicy.ts).
  printer_ack_json TEXT,
  lease_until TEXT,
  finalize_attempts INTEGER NOT NULL DEFAULT 0,
  finalize_error TEXT,
  submitted_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- ONE open session per customer, enforced by the database (§9).
CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_buy_sessions_open ON quick_buy_sessions(user_id) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_quick_buy_sessions_due ON quick_buy_sessions(expires_at) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_quick_buy_sessions_user ON quick_buy_sessions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quick_buy_sessions_state ON quick_buy_sessions(state, updated_at);

-- The session's lines. The selection columns carry the SAME names and
-- defaults as cart_items, so the checkout reads a session line through the
-- very projection it reads a cart line with — one pricing door, not two.
CREATE TABLE IF NOT EXISTS quick_buy_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES quick_buy_sessions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  option_id TEXT NOT NULL DEFAULT '',
  option_value_ids TEXT NOT NULL DEFAULT '[]',
  color_id TEXT NOT NULL DEFAULT '',
  shipping_method_id TEXT NOT NULL DEFAULT '',
  transport_method TEXT NOT NULL DEFAULT '',
  fulfillment_type TEXT NOT NULL DEFAULT 'direct_sale',
  warranty_plan_id TEXT NOT NULL DEFAULT '',
  draw_salt TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL CHECK (qty >= 0),
  -- Units held in inventory_ledger for this line, and the counters they are
  -- held on: a release always aims at the counters that took the hold.
  reserved_qty INTEGER NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  stock_targets TEXT NOT NULL DEFAULT '[]',
  -- The unit price the customer was quoted (§20). The order never charges
  -- more: it is the line's price ceiling at finalisation (D12).
  unit_price_iqd INTEGER NOT NULL CHECK (unit_price_iqd >= 0),
  line_total_iqd INTEGER NOT NULL DEFAULT 0 CHECK (line_total_iqd >= 0),
  -- Names, option and colour labels, SKU and discount at the add (§20).
  snapshot TEXT NOT NULL DEFAULT '{}',
  -- The selection's picture as the product page showed it (a media reference,
  -- registered in worker/lib/mediaRefs.ts like order_items.image_snapshot).
  image_snapshot TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  removed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_quick_buy_items_session ON quick_buy_items(session_id);
-- One live line per selection: adding the same variant again raises its qty.
CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_buy_items_line
  ON quick_buy_items(session_id, product_id, option_value_ids, color_id, warranty_plan_id) WHERE qty > 0;

-- Idempotency (§18): every Quick Buy write carries a key. A replay returns
-- the stored answer; the same key with a different request is refused.
CREATE TABLE IF NOT EXISTS quick_buy_actions (
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, key)
);

-- Append-only money and stock trail (§21): the DELTA of every hold, release
-- and capture, every reservation change and every state change, so a report
-- can tell a HOLD (not revenue) from a CAPTURE without replaying holds.
CREATE TABLE IF NOT EXISTS quick_buy_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('start', 'add', 'update', 'remove', 'hold', 'release', 'capture',
                                     'reserve', 'unreserve', 'submit', 'cancel', 'fail', 'retry')),
  amount_iqd INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  item_id TEXT,
  hold_id TEXT,
  order_id TEXT,
  action_key TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_quick_buy_events_session ON quick_buy_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quick_buy_events_kind ON quick_buy_events(kind, created_at);
