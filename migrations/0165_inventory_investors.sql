-- Investment ownership follows incoming inventory through every physical split.
-- Existing wallets, lots, costs and investment records are not rewritten.
CREATE TABLE IF NOT EXISTS investment_contracts (
 id TEXT PRIMARY KEY, incoming_id TEXT NOT NULL REFERENCES incoming_inventory(id),
 user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
 principal_iqd INTEGER NOT NULL CHECK(principal_iqd>0),
 capital_share_bps INTEGER NOT NULL CHECK(capital_share_bps BETWEEN 1 AND 10000),
 profit_share_bps INTEGER NOT NULL CHECK(profit_share_bps BETWEEN 0 AND 10000),
 loss_share_bps INTEGER NOT NULL CHECK(loss_share_bps BETWEEN 0 AND 10000),
 state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','void')), version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 request_json TEXT NOT NULL CHECK(json_valid(request_json))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_investment_active_user ON investment_contracts(incoming_id,user_id) WHERE state='active';
CREATE INDEX IF NOT EXISTS idx_investment_contract_user ON investment_contracts(user_id,incoming_id);
CREATE TRIGGER IF NOT EXISTS investment_contract_share_limit BEFORE INSERT ON investment_contracts
WHEN (SELECT COALESCE(SUM(capital_share_bps),0) FROM investment_contracts WHERE incoming_id=NEW.incoming_id AND state='active')+NEW.capital_share_bps>10000
 OR (SELECT COALESCE(SUM(profit_share_bps),0) FROM investment_contracts WHERE incoming_id=NEW.incoming_id AND state='active')+NEW.profit_share_bps>10000
 OR (SELECT COALESCE(SUM(loss_share_bps),0) FROM investment_contracts WHERE incoming_id=NEW.incoming_id AND state='active')+NEW.loss_share_bps>10000
BEGIN SELECT RAISE(ABORT,'Investment shares exceed 100 percent'); END;
CREATE TRIGGER IF NOT EXISTS investment_contract_immutable BEFORE UPDATE ON investment_contracts
WHEN NEW.id IS NOT OLD.id OR NEW.incoming_id IS NOT OLD.incoming_id OR NEW.user_id IS NOT OLD.user_id OR NEW.name IS NOT OLD.name
 OR NEW.principal_iqd IS NOT OLD.principal_iqd OR NEW.capital_share_bps IS NOT OLD.capital_share_bps OR NEW.profit_share_bps IS NOT OLD.profit_share_bps
 OR NEW.loss_share_bps IS NOT OLD.loss_share_bps OR NEW.request_json IS NOT OLD.request_json OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
 OR OLD.state<>'active' OR NEW.state<>'void' OR NEW.version<>OLD.version+1
 OR EXISTS(SELECT 1 FROM investor_finance_events WHERE contract_id=OLD.id)
 OR EXISTS(SELECT 1 FROM order_item_inventory_allocations a JOIN inventory_lots l ON l.id=a.lot_id WHERE l.incoming_id=OLD.incoming_id AND a.released_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Investment terms immutable'); END;
CREATE TRIGGER IF NOT EXISTS investment_contract_no_delete BEFORE DELETE ON investment_contracts BEGIN SELECT RAISE(ABORT,'Investment history immutable'); END;
CREATE TABLE IF NOT EXISTS investor_finance_events (
 id TEXT PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, contract_id TEXT NOT NULL REFERENCES investment_contracts(id),
 kind TEXT NOT NULL CHECK(kind IN ('funding','profit','profit_correction','capital_recovered','capital_correction','loss','loss_correction')),
 amount_iqd INTEGER NOT NULL, event_day TEXT NOT NULL, order_id TEXT REFERENCES orders(id),
 allocation_id TEXT REFERENCES order_item_inventory_allocations(id), lot_id TEXT REFERENCES inventory_lots(id),
 actor_id TEXT REFERENCES users(id), snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS investment_contract_voids(id TEXT PRIMARY KEY,contract_id TEXT NOT NULL UNIQUE REFERENCES investment_contracts(id),actor_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS investor_event_immutable BEFORE UPDATE ON investor_finance_events BEGIN SELECT RAISE(ABORT,'Investor event immutable'); END;
CREATE TRIGGER IF NOT EXISTS investor_event_no_delete BEFORE DELETE ON investor_finance_events BEGIN SELECT RAISE(ABORT,'Investor event immutable'); END;
CREATE TABLE IF NOT EXISTS investor_allocation_results (
 allocation_id TEXT NOT NULL REFERENCES order_item_inventory_allocations(id), contract_id TEXT NOT NULL REFERENCES investment_contracts(id),
 profit_iqd INTEGER NOT NULL, capital_iqd INTEGER NOT NULL CHECK(capital_iqd>=0), loss_iqd INTEGER NOT NULL CHECK(loss_iqd>=0),
 eligible INTEGER NOT NULL CHECK(eligible IN (0,1)), pending INTEGER NOT NULL DEFAULT 0 CHECK(pending IN(0,1)), snapshot TEXT NOT NULL, version INTEGER NOT NULL,
 PRIMARY KEY(allocation_id,contract_id)
);
CREATE TABLE IF NOT EXISTS finance_investor_earnings (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), contract_id TEXT NOT NULL REFERENCES investment_contracts(id),
 kind TEXT NOT NULL CHECK(kind IN ('investor_profit','investor_capital')), title TEXT NOT NULL,
 amount_iqd INTEGER NOT NULL CHECK(amount_iqd>=0), accrued_iqd INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 state TEXT NOT NULL CHECK(state IN ('pending','available','closed')), day TEXT NOT NULL,
 order_id TEXT REFERENCES orders(id), updated_at TEXT NOT NULL, UNIQUE(contract_id,kind)
);
CREATE TABLE IF NOT EXISTS investor_capital_losses(contract_id TEXT PRIMARY KEY REFERENCES investment_contracts(id),amount_iqd INTEGER NOT NULL CHECK(amount_iqd>=0),version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lot_cost_adjustments (
 id TEXT PRIMARY KEY, incoming_id TEXT NOT NULL REFERENCES incoming_inventory(id), amount_iqd INTEGER NOT NULL CHECK(amount_iqd<>0),
 adjustment_day TEXT NOT NULL, title TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id),
 request_json TEXT NOT NULL CHECK(json_valid(request_json)), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lot_cost_adjustment_shares (
 adjustment_id TEXT NOT NULL REFERENCES lot_cost_adjustments(id), lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
 allocation_id TEXT REFERENCES order_item_inventory_allocations(id), qty INTEGER NOT NULL CHECK(qty>0), amount_iqd INTEGER NOT NULL,
 unit_delta_iqd INTEGER NOT NULL, recognized_iqd INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
 UNIQUE(adjustment_id,lot_id,allocation_id)
);
CREATE TABLE IF NOT EXISTS inventory_lot_cost_versions (
 lot_id TEXT NOT NULL REFERENCES inventory_lots(id), version INTEGER NOT NULL, unit_cost_iqd INTEGER NOT NULL CHECK(unit_cost_iqd>=0),
 adjustment_id TEXT NOT NULL REFERENCES lot_cost_adjustments(id), PRIMARY KEY(lot_id,version)
);
CREATE TRIGGER IF NOT EXISTS lot_cost_adjustment_immutable BEFORE UPDATE ON lot_cost_adjustments BEGIN SELECT RAISE(ABORT,'Cost adjustment immutable'); END;
CREATE TRIGGER IF NOT EXISTS lot_cost_adjustment_no_delete BEFORE DELETE ON lot_cost_adjustments BEGIN SELECT RAISE(ABORT,'Cost adjustment immutable'); END;
CREATE TABLE IF NOT EXISTS stock_return_lot_evidence (
 return_case_id TEXT NOT NULL REFERENCES return_cases(id), allocation_id TEXT NOT NULL REFERENCES order_item_inventory_allocations(id),
 qty INTEGER NOT NULL CHECK(qty>0), PRIMARY KEY(return_case_id,allocation_id)
);
CREATE TABLE IF NOT EXISTS lot_count_events (
 id TEXT PRIMARY KEY, lot_id TEXT NOT NULL REFERENCES inventory_lots(id), expected_qty INTEGER NOT NULL, counted_qty INTEGER NOT NULL CHECK(counted_qty>=0),
 delta INTEGER NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS lot_cost_version_immutable BEFORE UPDATE ON inventory_lot_cost_versions BEGIN SELECT RAISE(ABORT,'Cost history immutable'); END;
CREATE TRIGGER IF NOT EXISTS lot_cost_version_no_delete BEFORE DELETE ON inventory_lot_cost_versions BEGIN SELECT RAISE(ABORT,'Cost history immutable'); END;
INSERT OR IGNORE INTO accounting_accounts(code,name,kind) VALUES
 ('3100','رأس مال المستثمرين','equity'),('3200','توزيع أرباح المستثمرين','equity'),('2450','أرباح المستثمرين المستحقة','liability');
