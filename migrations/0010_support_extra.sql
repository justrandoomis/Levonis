-- Levonis migration 0010 — support tickets + restriction-case detail,
-- building on 0003. NONDESTRUCTIVE: CREATE TABLE / ADD COLUMN / CREATE INDEX
-- only.
--
-- 0003 has no general support-ticket table (claim_messages is warranty-claim
-- specific and investor_messages is the invest chat), so the deterministic
-- support assistant (§8) and the PRO-operations console (§10) get their own
-- tables here:
--   1) support_tickets — one row per ticket. `priority` is a REAL queue field
--      (1 = active PRO at creation time, 0 otherwise) used in the admin queue
--      ORDER BY priority DESC, created_at ASC — age still ranks within a
--      priority band so ordinary customers are never starved invisibly.
--   2) support_ticket_messages — the persisted customer/staff thread.
--   3) restriction_cases extras — 0003's kind CHECK ('debt','fraud','kyc',
--      'refusal','other') cannot hold the owner's precise case taxonomy
--      (dropshipping_suspected / repeated_refusal / abuse / debt), and the
--      cases must gate SPECIFIC benefit flags rather than "everything".
--      case_type stores the precise type (kind keeps the coarse 0003 value),
--      benefit_flags is a JSON array of gated entitlement keys (matching
--      worker/lib/entitlements.ts benefit names), decision records
--      pause (temporary) vs revoke (until explicitly resolved). Restrictions
--      only ever gate benefit COMPUTATION — never orders, wallet, points,
--      warranty or support access.

PRAGMA defer_foreign_keys = true;

CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL,
  -- Optional customer-supplied references, ownership-checked at creation.
  order_id TEXT REFERENCES orders(id),
  unit_id TEXT REFERENCES order_item_units(id),
  -- 1 = creator had eligible active PRO (and no active restriction gating
  -- priority) when the ticket was opened. Snapshot, not recomputed.
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN
    ('open','waiting_customer','waiting_staff','resolved')),
  source TEXT NOT NULL DEFAULT 'assistant' CHECK (source IN ('assistant','manual')),
  assigned_staff TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_customer_msg_at TEXT,
  last_staff_msg_at TEXT,
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE INDEX idx_support_tickets_user ON support_tickets(user_id, state, created_at DESC);
CREATE INDEX idx_support_tickets_queue ON support_tickets(state, priority DESC, created_at ASC);

CREATE TABLE support_ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  is_staff INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_support_ticket_messages ON support_ticket_messages(ticket_id, created_at);

-- Restriction-case detail (see header note 3).
ALTER TABLE restriction_cases ADD COLUMN case_type TEXT NOT NULL DEFAULT '';
ALTER TABLE restriction_cases ADD COLUMN benefit_flags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE restriction_cases ADD COLUMN decision TEXT;
ALTER TABLE restriction_cases ADD COLUMN decision_reason TEXT NOT NULL DEFAULT '';
