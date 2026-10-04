-- Account-linked earnings, frozen multi-target rules and auditable withdrawals.
ALTER TABLE finance_staff ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE UNIQUE INDEX idx_finance_staff_user ON finance_staff(user_id) WHERE user_id IS NOT NULL;
ALTER TABLE finance_cost_rules ADD COLUMN scope_json TEXT NOT NULL DEFAULT '{}';
CREATE TABLE finance_cost_adjustments (
  id TEXT PRIMARY KEY, cost_id TEXT NOT NULL REFERENCES finance_order_costs(id),
  kind TEXT NOT NULL DEFAULT 'manual' CHECK(kind IN ('manual','recalculation')),
  delta_iqd INTEGER NOT NULL CHECK(delta_iqd<>0), before_iqd INTEGER NOT NULL CHECK(before_iqd>=0),
  after_iqd INTEGER NOT NULL CHECK(after_iqd>=0), actor_id TEXT REFERENCES users(id),
  adjustment_day TEXT NOT NULL, created_at TEXT NOT NULL,
  CHECK(after_iqd-before_iqd=delta_iqd)
);
CREATE INDEX idx_finance_cost_adjustment_cost ON finance_cost_adjustments(cost_id);
CREATE TRIGGER finance_cost_adjustment_immutable BEFORE UPDATE ON finance_cost_adjustments BEGIN SELECT RAISE(ABORT,'Cost adjustments are immutable'); END;
CREATE TRIGGER finance_cost_adjustment_delete BEFORE DELETE ON finance_cost_adjustments BEGIN SELECT RAISE(ABORT,'Cost adjustments are immutable'); END;
CREATE TABLE finance_withdrawals (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), amount_iqd INTEGER NOT NULL CHECK(amount_iqd>0),
  paid_iqd INTEGER NOT NULL DEFAULT 0 CHECK(paid_iqd>=0 AND paid_iqd<=amount_iqd),
  balance_type TEXT NOT NULL DEFAULT 'earnings' CHECK(balance_type IN ('earnings','capital','all')),
  state TEXT NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','approved','part_paid','paid','rejected','cancelled')),
  version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  approved_by TEXT REFERENCES users(id), closed_by TEXT REFERENCES users(id), note TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '', receipt_url TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_finance_withdrawals_user ON finance_withdrawals(user_id,created_at);
CREATE INDEX idx_finance_withdrawals_state ON finance_withdrawals(state,created_at);
CREATE TABLE finance_withdrawal_allocations (
  withdrawal_id TEXT NOT NULL REFERENCES finance_withdrawals(id),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('staff','investor_profit','investor_capital')),
  source_id TEXT NOT NULL, amount_iqd INTEGER NOT NULL CHECK(amount_iqd>0),
  paid_iqd INTEGER NOT NULL DEFAULT 0 CHECK(paid_iqd>=0 AND paid_iqd<=amount_iqd),
  PRIMARY KEY(withdrawal_id,source_kind,source_id)
);
CREATE INDEX idx_finance_withdrawal_source ON finance_withdrawal_allocations(source_kind,source_id);
CREATE TABLE finance_withdrawal_payments (
  id TEXT PRIMARY KEY, withdrawal_id TEXT NOT NULL REFERENCES finance_withdrawals(id),
  amount_iqd INTEGER NOT NULL CHECK(amount_iqd>0), payment_day TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '', receipt_url TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  CHECK(length(reference)>0 OR length(receipt_url)>0)
);
CREATE TRIGGER finance_withdrawal_payment_immutable BEFORE UPDATE ON finance_withdrawal_payments BEGIN SELECT RAISE(ABORT,'Payout proof is immutable'); END;
CREATE TRIGGER finance_withdrawal_payment_delete BEFORE DELETE ON finance_withdrawal_payments BEGIN SELECT RAISE(ABORT,'Payout proof is immutable'); END;
-- Older payroll screens obey the same reserved balance as the self-service screen.
CREATE TRIGGER finance_payment_reservation_insert AFTER INSERT ON finance_payment_allocations BEGIN
  SELECT CASE WHEN (SELECT COALESCE(c.amount_iqd,0)+COALESCE((SELECT SUM(delta_iqd) FROM finance_cost_adjustments WHERE cost_id=c.id),0)
    -(SELECT COALESCE(SUM(amount_iqd),0) FROM finance_payment_allocations WHERE cost_id=c.id)
    -(SELECT COALESCE(SUM(a.amount_iqd-a.paid_iqd),0) FROM finance_withdrawal_allocations a JOIN finance_withdrawals w ON w.id=a.withdrawal_id
      WHERE a.source_kind='staff' AND a.source_id=c.id AND w.state IN ('requested','approved','part_paid'))
    FROM finance_order_costs c WHERE c.id=NEW.cost_id)<0 THEN RAISE(ABORT,'Earnings are already paid or reserved') END;
END;
CREATE TRIGGER finance_payment_reservation_update AFTER UPDATE ON finance_payment_allocations BEGIN
  SELECT CASE WHEN (SELECT COALESCE(c.amount_iqd,0)+COALESCE((SELECT SUM(delta_iqd) FROM finance_cost_adjustments WHERE cost_id=c.id),0)
    -(SELECT COALESCE(SUM(amount_iqd),0) FROM finance_payment_allocations WHERE cost_id=c.id)
    -(SELECT COALESCE(SUM(a.amount_iqd-a.paid_iqd),0) FROM finance_withdrawal_allocations a JOIN finance_withdrawals w ON w.id=a.withdrawal_id
      WHERE a.source_kind='staff' AND a.source_id=c.id AND w.state IN ('requested','approved','part_paid'))
    FROM finance_order_costs c WHERE c.id=NEW.cost_id)<0 THEN RAISE(ABORT,'Earnings are already paid or reserved') END;
END;
CREATE TRIGGER finance_cost_reserved_reversal BEFORE UPDATE OF state ON finance_order_costs WHEN NEW.state='reversed' BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM finance_withdrawal_allocations a JOIN finance_withdrawals w ON w.id=a.withdrawal_id
    WHERE a.source_kind='staff' AND a.source_id=OLD.id AND a.amount_iqd>a.paid_iqd AND w.state IN ('requested','approved','part_paid'))
    THEN RAISE(ABORT,'Earnings are reserved for withdrawal') END;
END;
CREATE TRIGGER finance_staff_account_locked BEFORE UPDATE OF user_id ON finance_staff WHEN OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM finance_order_costs WHERE staff_id=OLD.id) OR EXISTS(SELECT 1 FROM finance_staff_payments WHERE staff_id=OLD.id)
    THEN RAISE(ABORT,'An earned staff account cannot be reassigned') END;
END;

CREATE TRIGGER finance_withdrawal_identity_immutable BEFORE UPDATE ON finance_withdrawals WHEN NEW.user_id<>OLD.user_id OR NEW.amount_iqd<>OLD.amount_iqd OR NEW.balance_type<>OLD.balance_type BEGIN SELECT RAISE(ABORT,'Withdrawal identity is immutable'); END;
CREATE TRIGGER finance_withdrawal_allocation_immutable BEFORE UPDATE ON finance_withdrawal_allocations WHEN NEW.withdrawal_id<>OLD.withdrawal_id OR NEW.source_kind<>OLD.source_kind OR NEW.source_id<>OLD.source_id OR NEW.amount_iqd<>OLD.amount_iqd OR NEW.paid_iqd<OLD.paid_iqd BEGIN SELECT RAISE(ABORT,'Withdrawal allocation is immutable'); END;
-- Percentage earnings are withdrawable only while their recorded basis still
-- matches order revenue, costs and returns. This closes projection lag.
CREATE TABLE finance_staff_basis (
  order_id TEXT PRIMARY KEY REFERENCES orders(id), basis_fingerprint TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_finance_posting_order ON finance_posting_errors(order_id);
