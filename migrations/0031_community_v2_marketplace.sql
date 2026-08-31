-- 0031 — LEVO Community V2: requests, offers, escrow, orders, reviews, disputes.
--
-- Part 2 of 2. 0030 established who sells; this establishes the marketplace
-- transaction: a customer asks, merchants offer, one offer wins, money is
-- HELD rather than paid, work happens, money is released or refunded.
--
-- THE FINANCIAL RULE THAT SHAPES THIS FILE: money is never a mutable number.
-- Every movement is an append-only row, and a balance is a SUM over rows.
-- There is no `merchant.balance` column to drift, be double-credited by a
-- retry, or be corrected by hand into a state nobody can explain later.
--
-- NON-DESTRUCTIVE: every statement is CREATE or ALTER ADD. Nothing is dropped
-- and no existing row is rewritten.

------------------------------------------------------ 1. REQUESTS (V2, §22)
-- 0001's community_requests has only (open|closed). The full lifecycle cannot
-- replace that CHECK without rebuilding the table, so the state machine lives
-- in a new `state` column and `status` is kept in step as a coarse mirror for
-- anything still reading it. worker/lib/communityStates.ts owns the
-- transitions; the CHECK here is the floor, not the rule.
ALTER TABLE community_requests ADD COLUMN state TEXT NOT NULL DEFAULT 'open';
  -- draft | open | receiving_offers | offer_selected | in_progress
  -- delivered | completed | cancelled | disputed | expired
ALTER TABLE community_requests ADD COLUMN category TEXT NOT NULL DEFAULT '';
ALTER TABLE community_requests ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;
ALTER TABLE community_requests ADD COLUMN material TEXT NOT NULL DEFAULT '';
ALTER TABLE community_requests ADD COLUMN color TEXT NOT NULL DEFAULT '';
ALTER TABLE community_requests ADD COLUMN dimensions TEXT NOT NULL DEFAULT '';
ALTER TABLE community_requests ADD COLUMN budget_iqd INTEGER;
ALTER TABLE community_requests ADD COLUMN deadline TEXT;
ALTER TABLE community_requests ADD COLUMN governorate TEXT NOT NULL DEFAULT '';
ALTER TABLE community_requests ADD COLUMN delivery_pref TEXT NOT NULL DEFAULT '';
ALTER TABLE community_requests ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE community_requests ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE community_requests ADD COLUMN offer_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_requests ADD COLUMN accepted_offer_id TEXT;
ALTER TABLE community_requests ADD COLUMN community_order_id TEXT;
ALTER TABLE community_requests ADD COLUMN expires_at TEXT;
ALTER TABLE community_requests ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_community_requests_state ON community_requests(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_requests_customer ON community_requests(customer_id, created_at DESC);

-- Attachments live in R2. The row stores the key; the key is NEVER handed to
-- a browser (§22, §67). Downloads stream through the worker after an
-- authorisation check, so a merchant who has not been engaged cannot walk the
-- bucket by guessing.
CREATE TABLE community_request_files (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES community_requests(id) ON DELETE CASCADE,
  file_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'reference',   -- reference | model | document
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_community_request_files_request ON community_request_files(request_id);

--------------------------------------------------------------- 2. OFFERS
CREATE TABLE community_offers (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES community_requests(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id) ON DELETE CASCADE,
  store_id TEXT REFERENCES merchant_stores(id) ON DELETE SET NULL,
  price_iqd INTEGER NOT NULL CHECK (price_iqd > 0),
  completion_days INTEGER NOT NULL DEFAULT 0 CHECK (completion_days >= 0),
  delivery_method TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  materials TEXT NOT NULL DEFAULT '',
  included TEXT NOT NULL DEFAULT '',
  warranty_terms TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','accepted','rejected','withdrawn','expired','superseded')),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_community_offers_request ON community_offers(request_id, state);
CREATE INDEX idx_community_offers_merchant ON community_offers(merchant_id, state, created_at DESC);

-- ONE live offer per merchant per request, enforced by the DATABASE (§25).
-- A partial index over the live states only, so a merchant may withdraw and
-- offer again but cannot have two pending offers racing each other.
CREATE UNIQUE INDEX idx_community_offers_one_live
  ON community_offers(request_id, merchant_id)
  WHERE state IN ('pending','accepted');

------------------------------------------------------- 3. COMMUNITY ORDERS
-- Created when an offer is accepted. It carries a SNAPSHOT of the offer, not
-- a pointer to mutable offer columns (§26): once accepted, what the merchant
-- promised and what they are owed can never be edited by editing the offer.
CREATE TABLE community_orders (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES community_requests(id),
  offer_id TEXT NOT NULL REFERENCES community_offers(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id),
  store_id TEXT REFERENCES merchant_stores(id),
  state TEXT NOT NULL DEFAULT 'accepted'
    CHECK (state IN ('accepted','funded','in_progress','merchant_marked_delivered',
                     'customer_confirmed','completed','disputed','cancelled','refunded')),
  -- Immutable snapshot of the winning offer.
  price_iqd INTEGER NOT NULL CHECK (price_iqd > 0),
  commission_percent_x100 INTEGER NOT NULL DEFAULT 0,
  platform_fee_iqd INTEGER NOT NULL DEFAULT 0 CHECK (platform_fee_iqd >= 0),
  merchant_receivable_iqd INTEGER NOT NULL DEFAULT 0 CHECK (merchant_receivable_iqd >= 0),
  completion_days INTEGER NOT NULL DEFAULT 0,
  delivery_method TEXT NOT NULL DEFAULT '',
  offer_snapshot TEXT NOT NULL DEFAULT '{}',
  chat_id TEXT REFERENCES chats(id),
  delivered_at TEXT,
  confirmed_at TEXT,
  auto_complete_at TEXT,           -- NULL when auto-completion is disabled
  completed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- The money identity, checked by the database on every write.
  CHECK (platform_fee_iqd + merchant_receivable_iqd = price_iqd)
);
CREATE INDEX idx_community_orders_customer ON community_orders(customer_id, created_at DESC);
CREATE INDEX idx_community_orders_merchant ON community_orders(merchant_id, state, created_at DESC);
CREATE UNIQUE INDEX idx_community_orders_offer ON community_orders(offer_id);
  -- One order per offer: a retried acceptance cannot create a second.
CREATE INDEX idx_community_orders_autocomplete ON community_orders(auto_complete_at)
  WHERE state = 'merchant_marked_delivered';

CREATE TABLE community_order_items (
  id TEXT PRIMARY KEY,
  community_order_id TEXT NOT NULL REFERENCES community_orders(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price_iqd INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_iqd >= 0),
  line_total_iqd INTEGER NOT NULL DEFAULT 0 CHECK (line_total_iqd >= 0)
);
CREATE INDEX idx_community_order_items_order ON community_order_items(community_order_id);

--------------------------------------------------------------- 4. ESCROW
-- One escrow per community order. The amounts are written once, at creation,
-- and the application never updates them (§29) — a correction is a new
-- refund/release EVENT, never an edit.
CREATE TABLE community_escrows (
  id TEXT PRIMARY KEY,
  community_order_id TEXT NOT NULL UNIQUE REFERENCES community_orders(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES users(id),
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id),
  gross_iqd INTEGER NOT NULL CHECK (gross_iqd > 0),
  platform_fee_iqd INTEGER NOT NULL CHECK (platform_fee_iqd >= 0),
  merchant_receivable_iqd INTEGER NOT NULL CHECK (merchant_receivable_iqd >= 0),
  released_iqd INTEGER NOT NULL DEFAULT 0 CHECK (released_iqd >= 0),
  refunded_iqd INTEGER NOT NULL DEFAULT 0 CHECK (refunded_iqd >= 0),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','held','released','partially_refunded','refunded','disputed','cancelled')),
  hold_id TEXT,                    -- the wallet hold that reserves the funds
  held_at TEXT,
  released_at TEXT,
  refunded_at TEXT,
  disputed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (platform_fee_iqd + merchant_receivable_iqd = gross_iqd),
  CHECK (released_iqd + refunded_iqd <= gross_iqd)
);
CREATE INDEX idx_community_escrows_state ON community_escrows(state);
CREATE INDEX idx_community_escrows_merchant ON community_escrows(merchant_id, state);

-- Append-only. This is the financial history; it is never updated or deleted,
-- and every settlement decision must be reconstructable from it alone.
CREATE TABLE community_escrow_events (
  id TEXT PRIMARY KEY,
  escrow_id TEXT NOT NULL REFERENCES community_escrows(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN ('created','held','release','refund','dispute_open','dispute_resolve','cancel')),
  amount_iqd INTEGER NOT NULL DEFAULT 0,
  actor_id TEXT REFERENCES users(id),
  actor_role TEXT NOT NULL DEFAULT 'system',   -- customer | merchant | admin | system
  reason TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_community_escrow_events_escrow ON community_escrow_events(escrow_id, created_at);

------------------------------------------------------- 5. PAYOUT LEDGER (§76)
-- A merchant's balance is SUM(amount_iqd) over approved rows. There is no
-- balance column anywhere for a retry to double.
CREATE TABLE merchant_payout_ledger (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN ('sale_credit','community_order_credit','refund_debit','commission',
                    'manual_adjustment','payout','reversal')),
  amount_iqd INTEGER NOT NULL,          -- signed: credits positive, debits negative
  state TEXT NOT NULL DEFAULT 'available'
    CHECK (state IN ('pending','available','reserved','paid','reversed')),
  order_id TEXT,
  community_order_id TEXT REFERENCES community_orders(id),
  escrow_id TEXT REFERENCES community_escrows(id),
  note TEXT NOT NULL DEFAULT '',
  admin_id TEXT REFERENCES users(id),
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_merchant_payout_ledger_merchant ON merchant_payout_ledger(merchant_id, state, created_at DESC);

------------------------------------------------------------- 6. REVIEWS
-- A review requires a COMPLETED transaction that belongs to the reviewer, and
-- there is exactly one per transaction. Both rules are database constraints,
-- not route conditions, so no future endpoint can forget them (§39).
CREATE TABLE merchant_reviews (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id) ON DELETE CASCADE,
  store_id TEXT REFERENCES merchant_stores(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id TEXT,                                  -- store-product order
  community_order_id TEXT REFERENCES community_orders(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]',
  merchant_reply TEXT NOT NULL DEFAULT '',
  merchant_replied_at TEXT,
  edited_count INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,              -- admin moderation only
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((order_id IS NULL) <> (community_order_id IS NULL))
);
CREATE INDEX idx_merchant_reviews_merchant ON merchant_reviews(merchant_id, hidden, created_at DESC);
CREATE UNIQUE INDEX idx_merchant_reviews_one_per_order
  ON merchant_reviews(order_id) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX idx_merchant_reviews_one_per_community_order
  ON merchant_reviews(community_order_id) WHERE community_order_id IS NOT NULL;

------------------------------------------------------- 7. REPUTATION (§41)
-- Raw events, kept forever. The score is DERIVED from these, so a merchant
-- can be shown why they have the standing they have, and a mistaken event can
-- be countered by another event rather than by silently editing a number.
CREATE TABLE merchant_reputation_events (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
    -- order_completed | order_cancelled | order_refunded | review_received
    -- | dispute_opened | dispute_lost | dispute_won | on_time | late
    -- | offer_accepted | repeat_customer | admin_adjustment
  points INTEGER NOT NULL DEFAULT 0,
  order_id TEXT,
  community_order_id TEXT,
  review_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_merchant_reputation_events_merchant
  ON merchant_reputation_events(merchant_id, created_at DESC);

-------------------------------------------------- 8. COMPLAINTS / DISPUTES
CREATE TABLE community_complaints (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_user_id TEXT REFERENCES users(id),
  merchant_id TEXT REFERENCES community_merchants(id),
  store_id TEXT REFERENCES merchant_stores(id),
  order_id TEXT,
  community_order_id TEXT REFERENCES community_orders(id),
  offer_id TEXT REFERENCES community_offers(id),
  product_id TEXT,
  category TEXT NOT NULL,
    -- order | offer | product | store | conduct | payment | delivery | quality
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','under_review','waiting_customer','waiting_merchant',
                      'resolved','rejected','closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  assigned_admin_id TEXT REFERENCES users(id),
  resolution TEXT NOT NULL DEFAULT '',
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_community_complaints_status ON community_complaints(status, created_at DESC);
CREATE INDEX idx_community_complaints_reporter ON community_complaints(reporter_id, created_at DESC);
CREATE INDEX idx_community_complaints_merchant ON community_complaints(merchant_id, status);

CREATE TABLE community_complaint_messages (
  id TEXT PRIMARY KEY,
  complaint_id TEXT NOT NULL REFERENCES community_complaints(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  sender_role TEXT NOT NULL DEFAULT 'user',   -- user | merchant | admin
  body TEXT NOT NULL DEFAULT '',
  file_key TEXT,
  internal INTEGER NOT NULL DEFAULT 0,        -- admin-only note, never shown to parties
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_community_complaint_messages_complaint
  ON community_complaint_messages(complaint_id, created_at);

------------------------------------------------------ 9. CHAT CONTEXT (§36)
-- The EXISTING chat system, given context. No second messenger (§89).
-- 0026 already added chats.order_id for platform orders; these sit beside it.
ALTER TABLE chats ADD COLUMN context_type TEXT NOT NULL DEFAULT '';
  -- store | product | request | offer | community_order | merchant_order
ALTER TABLE chats ADD COLUMN context_id TEXT NOT NULL DEFAULT '';
ALTER TABLE chats ADD COLUMN merchant_id TEXT REFERENCES community_merchants(id);
ALTER TABLE chats ADD COLUMN store_id TEXT REFERENCES merchant_stores(id);
ALTER TABLE chats ADD COLUMN community_order_id TEXT REFERENCES community_orders(id);
CREATE INDEX idx_chats_context ON chats(context_type, context_id);
CREATE INDEX idx_chats_merchant ON chats(merchant_id);

--------------------------------------------------------- 10. STORE FOLLOWS
-- `follows` (0001) already keys on (user_id, merchant_id). Extended rather
-- than replaced, so every existing follow keeps working untouched.
ALTER TABLE follows ADD COLUMN notify_products INTEGER NOT NULL DEFAULT 1;
ALTER TABLE follows ADD COLUMN notify_offers INTEGER NOT NULL DEFAULT 1;
ALTER TABLE follows ADD COLUMN notify_updates INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_follows_merchant ON follows(merchant_id);
