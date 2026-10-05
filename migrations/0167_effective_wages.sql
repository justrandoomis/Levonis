-- Recorded time is audit information; delivery day selects an effective wage.
-- Boundaries are immutable. The latest revision at a boundary supersedes only
-- that boundary, and the next boundary ends it exclusively (see the view).
CREATE TABLE finance_wage_versions (
 id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES finance_cost_rules(id),
 revision INTEGER NOT NULL CHECK(revision>0), staff_id TEXT NOT NULL REFERENCES finance_staff(id),
 effective_from TEXT NOT NULL CHECK(date(effective_from,'+0 days') IS effective_from),
 effective_until TEXT CHECK(effective_until IS NULL OR (date(effective_until,'+0 days') IS effective_until AND effective_until>effective_from)),
 follows_employment INTEGER NOT NULL DEFAULT 0 CHECK(follows_employment IN(0,1)),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), reason TEXT NOT NULL CHECK(length(reason)>0),
 actor_id TEXT NOT NULL REFERENCES users(id), recorded_at TEXT NOT NULL,
 supersedes_id TEXT REFERENCES finance_wage_versions(id),
 UNIQUE(rule_id,revision), CHECK(json_extract(snapshot,'$.id')=rule_id),
 CHECK(json_extract(snapshot,'$.staff_id')=staff_id)
);
CREATE INDEX idx_wage_version_delivery ON finance_wage_versions(staff_id,effective_from,rule_id);
CREATE TRIGGER wage_version_immutable BEFORE UPDATE ON finance_wage_versions BEGIN SELECT RAISE(ABORT,'Wage history is immutable'); END;
CREATE TRIGGER wage_version_no_delete BEFORE DELETE ON finance_wage_versions BEGIN SELECT RAISE(ABORT,'Wage history is immutable'); END;
INSERT INTO finance_wage_versions(id,rule_id,revision,staff_id,effective_from,effective_until,follows_employment,snapshot,reason,actor_id,recorded_at)
 SELECT 'wage:baseline:'||r.id,r.id,r.version,r.staff_id,r.effective_from,date(r.effective_to,'+1 day'),r.employment_effective_default,
 json_set(v.snapshot,'$.employment_effective_default',r.employment_effective_default),
 'إعداد قائم عند بدء سجل السريان؛ النسخ واللقطات الأقدم محفوظة للتدقيق',v.actor_id,v.created_at
 FROM finance_cost_rules r JOIN finance_rule_versions v ON v.rule_id=r.id AND v.version=r.version WHERE r.staff_id IS NOT NULL;
CREATE VIEW finance_wage_periods AS
 WITH starts AS (
  SELECT v.*,CASE WHEN follows_employment=1 AND s.start_work_date IS NOT NULL THEN date(s.start_work_date,'+1 day') ELSE effective_from END AS starts_on
  FROM finance_wage_versions v JOIN finance_staff s ON s.id=v.staff_id WHERE NOT EXISTS(SELECT 1 FROM finance_wage_versions replacement WHERE replacement.supersedes_id=v.id)
 ), boundaries AS (
  SELECT *,ROW_NUMBER() OVER(PARTITION BY rule_id,starts_on ORDER BY revision DESC) AS position FROM starts
 ), periods AS (
  SELECT *,LEAD(starts_on) OVER(PARTITION BY rule_id ORDER BY starts_on) AS next_start FROM boundaries WHERE position=1
 ) SELECT *,CASE WHEN next_start IS NULL THEN effective_until WHEN effective_until IS NULL THEN next_start ELSE MIN(next_start,effective_until) END AS ends_before FROM periods;
ALTER TABLE finance_cost_adjustments ADD COLUMN reason TEXT NOT NULL DEFAULT '';
ALTER TABLE finance_cost_adjustments ADD COLUMN wage_version_id TEXT REFERENCES finance_wage_versions(id);
ALTER TABLE finance_cost_adjustments ADD COLUMN earning_day TEXT;
ALTER TABLE finance_cost_adjustments ADD COLUMN recalculation_key TEXT;
CREATE UNIQUE INDEX idx_wage_adjustment_once ON finance_cost_adjustments(recalculation_key) WHERE recalculation_key IS NOT NULL;
CREATE TABLE finance_wage_targets (
 cost_id TEXT PRIMARY KEY REFERENCES finance_order_costs(id), wage_version_id TEXT REFERENCES finance_wage_versions(id),
 amount_iqd INTEGER CHECK(amount_iqd IS NULL OR amount_iqd>=0), basis TEXT NOT NULL,
 employment_version INTEGER NOT NULL, earning_day TEXT NOT NULL, updated_at TEXT NOT NULL
);
ALTER TABLE finance_staff_reconciliations ADD COLUMN affected_from TEXT;
ALTER TABLE finance_staff_reconciliations ADD COLUMN affected_until TEXT;
ALTER TABLE finance_staff_reconciliations ADD COLUMN reason TEXT NOT NULL DEFAULT '';
ALTER TABLE finance_staff_reconciliations ADD COLUMN operation_id TEXT;
CREATE TABLE finance_wage_changes (
 id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES finance_cost_rules(id),
 wage_version_id TEXT NOT NULL UNIQUE REFERENCES finance_wage_versions(id),
 request_json TEXT NOT NULL CHECK(json_valid(request_json)), preview_json TEXT NOT NULL CHECK(json_valid(preview_json)),
 actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TRIGGER wage_change_immutable BEFORE UPDATE ON finance_wage_changes BEGIN SELECT RAISE(ABORT,'Wage change immutable'); END;
CREATE TRIGGER wage_change_no_delete BEFORE DELETE ON finance_wage_changes BEGIN SELECT RAISE(ABORT,'Wage change immutable'); END;
-- Cancelling a partially paid withdrawal releases only its unpaid reservation;
-- its original request and payment evidence remain untouched.
CREATE TABLE finance_withdrawal_reviews (
 id TEXT PRIMARY KEY, withdrawal_id TEXT NOT NULL REFERENCES finance_withdrawals(id),
 change_id TEXT NOT NULL, unpaid_released_iqd INTEGER NOT NULL CHECK(unpaid_released_iqd>=0),
 reason TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 UNIQUE(withdrawal_id,change_id)
);

-- A financial preview is invalidated by any competing source mutation.
CREATE TABLE finance_mutation_clock(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
INSERT INTO finance_mutation_clock VALUES (1,0);
CREATE TRIGGER finance_clock_orders_insert AFTER INSERT ON orders BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_orders_update AFTER UPDATE ON orders BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_orders_delete AFTER DELETE ON orders BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_order_items_insert AFTER INSERT ON order_items BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_order_items_update AFTER UPDATE ON order_items BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_order_items_delete AFTER DELETE ON order_items BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_order_costs_insert AFTER INSERT ON finance_order_costs BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_order_costs_update AFTER UPDATE ON finance_order_costs BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_order_costs_delete AFTER DELETE ON finance_order_costs BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_cost_adjustments_insert AFTER INSERT ON finance_cost_adjustments BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_cost_adjustments_update AFTER UPDATE ON finance_cost_adjustments BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_cost_adjustments_delete AFTER DELETE ON finance_cost_adjustments BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_order_adjustments_insert AFTER INSERT ON finance_order_adjustments BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_order_adjustments_update AFTER UPDATE ON finance_order_adjustments BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_order_adjustments_delete AFTER DELETE ON finance_order_adjustments BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_staff_insert AFTER INSERT ON finance_staff BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_staff_update AFTER UPDATE ON finance_staff BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_staff_delete AFTER DELETE ON finance_staff BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_cost_rules_insert AFTER INSERT ON finance_cost_rules BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_cost_rules_update AFTER UPDATE ON finance_cost_rules BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_cost_rules_delete AFTER DELETE ON finance_cost_rules BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_wage_versions_insert AFTER INSERT ON finance_wage_versions BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_wage_versions_update AFTER UPDATE ON finance_wage_versions BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_wage_versions_delete AFTER DELETE ON finance_wage_versions BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_payment_allocations_insert AFTER INSERT ON finance_payment_allocations BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_payment_allocations_update AFTER UPDATE ON finance_payment_allocations BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_payment_allocations_delete AFTER DELETE ON finance_payment_allocations BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_staff_payments_insert AFTER INSERT ON finance_staff_payments BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_staff_payments_update AFTER UPDATE ON finance_staff_payments BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_staff_payments_delete AFTER DELETE ON finance_staff_payments BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_withdrawals_insert AFTER INSERT ON finance_withdrawals BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_withdrawals_update AFTER UPDATE ON finance_withdrawals BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_withdrawals_delete AFTER DELETE ON finance_withdrawals BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_withdrawal_allocations_insert AFTER INSERT ON finance_withdrawal_allocations BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_withdrawal_allocations_update AFTER UPDATE ON finance_withdrawal_allocations BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_withdrawal_allocations_delete AFTER DELETE ON finance_withdrawal_allocations BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_collections_insert AFTER INSERT ON finance_collections BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_collections_update AFTER UPDATE ON finance_collections BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_collections_delete AFTER DELETE ON finance_collections BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_refund_facts_insert AFTER INSERT ON finance_refund_facts BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_refund_facts_update AFTER UPDATE ON finance_refund_facts BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_refund_facts_delete AFTER DELETE ON finance_refund_facts BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_task_assignments_insert AFTER INSERT ON finance_task_assignments BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_task_assignments_update AFTER UPDATE ON finance_task_assignments BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_task_assignments_delete AFTER DELETE ON finance_task_assignments BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_order_item_inventory_allocations_insert AFTER INSERT ON order_item_inventory_allocations BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_order_item_inventory_allocations_update AFTER UPDATE ON order_item_inventory_allocations BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_order_item_inventory_allocations_delete AFTER DELETE ON order_item_inventory_allocations BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_lot_cost_adjustment_shares_insert AFTER INSERT ON lot_cost_adjustment_shares BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_lot_cost_adjustment_shares_update AFTER UPDATE ON lot_cost_adjustment_shares BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_lot_cost_adjustment_shares_delete AFTER DELETE ON lot_cost_adjustment_shares BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_accounting_entries_insert AFTER INSERT ON accounting_entries BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_accounting_entries_update AFTER UPDATE ON accounting_entries BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_accounting_entries_delete AFTER DELETE ON accounting_entries BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_operating_expenses_insert AFTER INSERT ON operating_expenses BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_operating_expenses_update AFTER UPDATE ON operating_expenses BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_operating_expenses_delete AFTER DELETE ON operating_expenses BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_expense_links_insert AFTER INSERT ON finance_expense_links BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_expense_links_update AFTER UPDATE ON finance_expense_links BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_expense_links_delete AFTER DELETE ON finance_expense_links BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_investment_contracts_insert AFTER INSERT ON investment_contracts BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_investment_contracts_update AFTER UPDATE ON investment_contracts BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_investment_contracts_delete AFTER DELETE ON investment_contracts BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_investor_finance_events_insert AFTER INSERT ON investor_finance_events BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_investor_finance_events_update AFTER UPDATE ON investor_finance_events BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_investor_finance_events_delete AFTER DELETE ON investor_finance_events BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_investor_earnings_insert AFTER INSERT ON finance_investor_earnings BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_investor_earnings_update AFTER UPDATE ON finance_investor_earnings BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_investor_earnings_delete AFTER DELETE ON finance_investor_earnings BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_staff_reconciliations_insert AFTER INSERT ON finance_staff_reconciliations BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_staff_reconciliations_update AFTER UPDATE ON finance_staff_reconciliations BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_finance_staff_reconciliations_delete AFTER DELETE ON finance_staff_reconciliations BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_return_cases_insert AFTER INSERT ON return_cases BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_return_cases_update AFTER UPDATE ON return_cases BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_return_cases_delete AFTER DELETE ON return_cases BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_stock_return_lot_evidence_insert AFTER INSERT ON stock_return_lot_evidence BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_stock_return_lot_evidence_update AFTER UPDATE ON stock_return_lot_evidence BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_stock_return_lot_evidence_delete AFTER DELETE ON stock_return_lot_evidence BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_product_catalogs_insert AFTER INSERT ON product_catalogs BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_product_catalogs_update AFTER UPDATE ON product_catalogs BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_product_catalogs_delete AFTER DELETE ON product_catalogs BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_catalogs_insert AFTER INSERT ON catalogs BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_catalogs_update AFTER UPDATE ON catalogs BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_catalogs_delete AFTER DELETE ON catalogs BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_products_insert AFTER INSERT ON products BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_products_update AFTER UPDATE ON products BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER finance_clock_products_delete AFTER DELETE ON products BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;

CREATE TABLE finance_withdrawal_payment_lines (
 payment_id TEXT NOT NULL REFERENCES finance_withdrawal_payments(id),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('staff','investor_profit','investor_capital')),
 source_id TEXT NOT NULL, amount_iqd INTEGER NOT NULL CHECK(amount_iqd>0),
 PRIMARY KEY(payment_id,source_kind,source_id)
);
CREATE TRIGGER withdrawal_payment_line_immutable BEFORE UPDATE ON finance_withdrawal_payment_lines BEGIN SELECT RAISE(ABORT,'Payment evidence is immutable'); END;
CREATE TRIGGER withdrawal_payment_line_no_delete BEFORE DELETE ON finance_withdrawal_payment_lines BEGIN SELECT RAISE(ABORT,'Payment evidence is immutable'); END;
-- Old payouts consumed immutable allocations in source_kind/source_id order.
-- Reconstruct that exact interval split only when both historical totals match.
WITH payments AS (
 SELECT p.*,SUM(amount_iqd) OVER(PARTITION BY withdrawal_id ORDER BY created_at,id ROWS UNBOUNDED PRECEDING) AS finish
 FROM finance_withdrawal_payments p
), allocations AS (
 SELECT a.*,SUM(paid_iqd) OVER(PARTITION BY withdrawal_id ORDER BY source_kind,source_id ROWS UNBOUNDED PRECEDING) AS finish
 FROM finance_withdrawal_allocations a
), portions AS (
 SELECT p.id,a.source_kind,a.source_id,MIN(p.finish,a.finish)-MAX(p.finish-p.amount_iqd,a.finish-a.paid_iqd) AS amount
 FROM payments p JOIN allocations a ON a.withdrawal_id=p.withdrawal_id
 WHERE (SELECT SUM(amount_iqd) FROM finance_withdrawal_payments WHERE withdrawal_id=p.withdrawal_id)
  =(SELECT SUM(paid_iqd) FROM finance_withdrawal_allocations WHERE withdrawal_id=p.withdrawal_id)
) INSERT INTO finance_withdrawal_payment_lines SELECT * FROM portions WHERE amount>0;
