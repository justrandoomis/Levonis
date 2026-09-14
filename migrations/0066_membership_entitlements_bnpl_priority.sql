-- Canonical membership benefits: functional PRO BNPL and 12-hour delivery.
-- Additive only; historical orders and ledger rows retain their meaning.

ALTER TABLE bnpl_ledger ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bnpl_ledger_idempotency
  ON bnpl_ledger(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bnpl_charge_order
  ON bnpl_ledger(order_id) WHERE kind = 'charge' AND order_id IS NOT NULL;

ALTER TABLE orders ADD COLUMN fulfillment_service TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE orders ADD COLUMN priority_due_at TEXT;
ALTER TABLE orders ADD COLUMN bnpl_due_iqd INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN bnpl_due_at TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_priority_due
  ON orders(priority DESC, priority_due_at, created_at);

-- The application supplies friendly eligibility reasons. These triggers are
-- the concurrent-write decision: two tabs can never spend the same limit.
CREATE TRIGGER IF NOT EXISTS trg_bnpl_charge_guard
BEFORE INSERT ON bnpl_ledger
WHEN NEW.kind = 'charge' AND NOT EXISTS (
  SELECT 1 FROM bnpl_ledger l WHERE l.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'BNPL_AMOUNT_INVALID') WHERE NEW.amount_iqd <= 0;
  SELECT RAISE(ABORT, 'BNPL_ORDER_REQUIRED') WHERE NEW.order_id IS NULL;
  SELECT RAISE(ABORT, 'BNPL_ORDER_INVALID') WHERE NOT EXISTS (
    SELECT 1 FROM orders o
     WHERE o.id = NEW.order_id AND o.user_id = NEW.user_id AND o.payment_method_id = 'bnpl'
  );
  SELECT RAISE(ABORT, 'BNPL_PRO_REQUIRED') WHERE NOT EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.user_id = NEW.user_id AND m.tier = 'pro' AND m.state = 'active'
       AND (m.expires_at IS NULL OR m.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  SELECT RAISE(ABORT, 'BNPL_RESTRICTED') WHERE EXISTS (
    SELECT 1 FROM restriction_cases r, json_each(r.benefit_flags) f
     WHERE r.user_id = NEW.user_id AND r.state = 'active'
       AND f.value IN ('bnpl')
  );
  SELECT RAISE(ABORT, 'BNPL_NOT_APPROVED') WHERE NOT EXISTS (
    SELECT 1 FROM bnpl_accounts a
     WHERE a.user_id = NEW.user_id AND a.state = 'approved' AND a.credit_limit_iqd > 0
  );
  SELECT RAISE(ABORT, 'BNPL_IDENTITY_REQUIRED') WHERE NOT EXISTS (
    SELECT 1 FROM kyc_cases k WHERE k.user_id = NEW.user_id AND k.state = 'verified'
  );
  SELECT RAISE(ABORT, 'BNPL_APPROVED_ADDRESS_REQUIRED') WHERE NOT EXISTS (
    SELECT 1
      FROM orders o JOIN approved_addresses a ON a.user_id = o.user_id AND a.state = 'approved'
     WHERE o.id = NEW.order_id
       AND (
         a.source_address_id = json_extract(o.address_snapshot, '$.id')
         OR (
           lower(trim(a.name)) = lower(trim(json_extract(o.address_snapshot, '$.name')))
           AND lower(trim(a.address)) = lower(trim(json_extract(o.address_snapshot, '$.address')))
         )
       )
  );
  SELECT RAISE(ABORT, 'BNPL_LIMIT_EXCEEDED') WHERE (
    SELECT MAX(0, COALESCE(SUM(CASE
      WHEN l.kind = 'charge' THEN l.amount_iqd
      WHEN l.kind = 'repayment' THEN -l.amount_iqd
      ELSE l.amount_iqd END), 0))
      FROM bnpl_ledger l WHERE l.user_id = NEW.user_id
  ) + NEW.amount_iqd > (
    SELECT a.credit_limit_iqd FROM bnpl_accounts a WHERE a.user_id = NEW.user_id
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_bnpl_repayment_guard
BEFORE INSERT ON bnpl_ledger
WHEN NEW.kind = 'repayment' AND NOT EXISTS (
  SELECT 1 FROM bnpl_ledger l WHERE l.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'BNPL_AMOUNT_INVALID') WHERE NEW.amount_iqd <= 0;
  SELECT RAISE(ABORT, 'BNPL_REPAYMENT_EXCEEDS_DEBT') WHERE NEW.amount_iqd > (
    SELECT MAX(0, COALESCE(SUM(CASE
      WHEN l.kind = 'charge' THEN l.amount_iqd
      WHEN l.kind = 'repayment' THEN -l.amount_iqd
      ELSE l.amount_iqd END), 0))
      FROM bnpl_ledger l WHERE l.user_id = NEW.user_id
  );
END;

INSERT OR IGNORE INTO admin_settings(key, value) VALUES
  ('bnplPolicy', '{"enabled":true,"due_days":30,"min_order_iqd":10000,"max_order_iqd":null,"require_verified_identity":true,"require_approved_address":true}'),
  ('proPriorityDelivery', '{"enabled":true,"max_hours":12,"delivery_method_ids":["personal"],"shipping_types":["direct"],"governorates":[]}');
