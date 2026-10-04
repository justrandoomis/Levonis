-- Employment cutoff is a Baghdad delivery day, exclusive: 20 Sep starts 21 Sep.
ALTER TABLE finance_staff ADD COLUMN start_work_date TEXT CHECK(start_work_date IS NULL OR (length(start_work_date)=10 AND date(start_work_date,'+0 days') IS start_work_date));
ALTER TABLE finance_staff ADD COLUMN archived_at TEXT;
ALTER TABLE finance_staff ADD COLUMN employment_version INTEGER NOT NULL DEFAULT 1 CHECK(employment_version>0);
ALTER TABLE finance_staff ADD COLUMN inactive_periods_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(inactive_periods_json));
ALTER TABLE finance_cost_adjustments ADD COLUMN employment_version INTEGER;
ALTER TABLE finance_cost_rules ADD COLUMN employment_effective_default INTEGER NOT NULL DEFAULT 0 CHECK(employment_effective_default IN (0,1));
-- Older simple forms supplied the creation day as the automatic default.
-- Preserve rules that ever declared another date or an explicit end date.
UPDATE finance_cost_rules SET employment_effective_default=1
WHERE effective_from=date(created_at,'+3 hours') AND effective_to IS NULL
AND NOT EXISTS(SELECT 1 FROM finance_rule_versions v WHERE v.rule_id=finance_cost_rules.id
  AND (json_extract(v.snapshot,'$.effective_from')<>finance_cost_rules.effective_from OR json_extract(v.snapshot,'$.effective_to') IS NOT NULL));
CREATE TABLE finance_staff_reconciliations (
  staff_id TEXT PRIMARY KEY REFERENCES finance_staff(id), revision INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','complete','failed')),
  cursor TEXT NOT NULL DEFAULT '', processed_orders INTEGER NOT NULL DEFAULT 0,
  adjusted_orders INTEGER NOT NULL DEFAULT 0, rules_json TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '', actor_id TEXT REFERENCES users(id), updated_at TEXT NOT NULL
);
CREATE TABLE finance_staff_order_rules (
  order_id TEXT NOT NULL REFERENCES orders(id), staff_id TEXT NOT NULL REFERENCES finance_staff(id),
  employment_version INTEGER NOT NULL, rules_json TEXT NOT NULL CHECK(json_valid(rules_json)),
  created_at TEXT NOT NULL, PRIMARY KEY(order_id,staff_id)
);
CREATE INDEX idx_staff_jobs_state ON finance_staff_reconciliations(state,updated_at);
CREATE INDEX idx_staff_order_rules_staff ON finance_staff_order_rules(staff_id,order_id);
CREATE TRIGGER finance_staff_no_delete BEFORE DELETE ON finance_staff BEGIN
  SELECT RAISE(ABORT,'Archive employees to retain financial history');
END;
CREATE TRIGGER finance_staff_archived_inactive BEFORE UPDATE ON finance_staff WHEN NEW.archived_at IS NOT NULL AND NEW.active<>0 BEGIN
  SELECT RAISE(ABORT,'Archived employees must remain inactive');
END;
