-- WAGE SETTLEMENT (owner 2026-11-10; DECISIONS row 306).
--
-- The owner agrees one final amount with an employee for every order
-- delivered before a day: Hussein closes at 75,000, Sousou at 0, and Sajjad's
-- unpaid wages from before his return on 10 Nov at 0. The amount is written
-- onto the employee's own wage rows as manual adjustments (so payouts keep
-- allocating to real rows), and these two tables say which rows are settled:
--   - a settled row is never held for a cost, a recalculation or a posting
--     error again, and the wage planner leaves its order alone;
--   - wages for orders delivered on or after `through_day` accrue as usual.
-- Additive and re-runnable: two new tables, never read by older code.
CREATE TABLE IF NOT EXISTS finance_staff_settlements (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES finance_staff(id),
  through_day TEXT NOT NULL CHECK(through_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  owed_iqd INTEGER NOT NULL CHECK(owed_iqd>=0),
  earned_before_iqd INTEGER NOT NULL,
  paid_before_iqd INTEGER NOT NULL,
  owed_before_iqd INTEGER NOT NULL,
  rows_settled INTEGER NOT NULL CHECK(rows_settled>=0),
  reason TEXT NOT NULL DEFAULT '',
  settlement_day TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staff_settlements_staff ON finance_staff_settlements(staff_id,through_day);
CREATE TABLE IF NOT EXISTS finance_staff_settled_costs (
  cost_id TEXT PRIMARY KEY REFERENCES finance_order_costs(id),
  settlement_id TEXT NOT NULL REFERENCES finance_staff_settlements(id),
  before_iqd INTEGER,
  paid_iqd INTEGER NOT NULL CHECK(paid_iqd>=0),
  after_iqd INTEGER
);
CREATE INDEX IF NOT EXISTS idx_staff_settled_costs_settlement ON finance_staff_settled_costs(settlement_id);
CREATE TRIGGER IF NOT EXISTS finance_staff_settlement_immutable BEFORE UPDATE ON finance_staff_settlements BEGIN SELECT RAISE(ABORT,'Wage settlements are immutable'); END;
CREATE TRIGGER IF NOT EXISTS finance_staff_settlement_delete BEFORE DELETE ON finance_staff_settlements BEGIN SELECT RAISE(ABORT,'Wage settlements are immutable'); END;
CREATE TRIGGER IF NOT EXISTS finance_staff_settled_cost_immutable BEFORE UPDATE ON finance_staff_settled_costs BEGIN SELECT RAISE(ABORT,'Settled wages are immutable'); END;
CREATE TRIGGER IF NOT EXISTS finance_staff_settled_cost_delete BEFORE DELETE ON finance_staff_settled_costs BEGIN SELECT RAISE(ABORT,'Settled wages are immutable'); END;
CREATE TRIGGER IF NOT EXISTS finance_clock_finance_staff_settlements_insert AFTER INSERT ON finance_staff_settlements BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS finance_clock_finance_staff_settled_costs_insert AFTER INSERT ON finance_staff_settled_costs BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
