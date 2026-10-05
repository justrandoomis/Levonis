CREATE TABLE investment_profiles (
 user_id TEXT PRIMARY KEY REFERENCES users(id),state TEXT NOT NULL DEFAULT 'active' CHECK(state IN('active','archived')),
 default_profit_share_bps INTEGER NOT NULL CHECK(default_profit_share_bps BETWEEN 0 AND 10000),
 default_capital_share_bps INTEGER NOT NULL DEFAULT 10000 CHECK(default_capital_share_bps BETWEEN 1 AND 10000),
 default_loss_share_bps INTEGER NOT NULL DEFAULT 0 CHECK(default_loss_share_bps BETWEEN 0 AND 10000),
 version INTEGER NOT NULL DEFAULT 1,created_by TEXT REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
-- Profiles organize existing contracts without changing any agreement.
INSERT INTO investment_profiles(user_id,state,default_profit_share_bps,default_capital_share_bps,default_loss_share_bps,created_by,created_at,updated_at)
 SELECT c.user_id,CASE WHEN u.role='admin' AND u.admin_scope='assistant' THEN 'active' ELSE 'archived' END,c.profit_share_bps,c.capital_share_bps,c.loss_share_bps,c.created_by,c.created_at,c.created_at
 FROM investment_contracts c JOIN users u ON u.id=c.user_id
 WHERE c.id=(SELECT x.id FROM investment_contracts x WHERE x.user_id=c.user_id ORDER BY x.created_at DESC,x.id DESC LIMIT 1);
ALTER TABLE incoming_inventory ADD COLUMN purchase_total_iqd INTEGER CHECK(purchase_total_iqd IS NULL OR purchase_total_iqd>=0);
ALTER TABLE purchase_lines ADD COLUMN purchase_total_iqd INTEGER CHECK(purchase_total_iqd IS NULL OR purchase_total_iqd>=0);
ALTER TABLE purchase_lines ADD COLUMN purchase_cost_mode TEXT NOT NULL DEFAULT 'unit' CHECK(purchase_cost_mode IN('unit','total'));
ALTER TABLE investment_contracts ADD COLUMN overhead_policy TEXT NOT NULL DEFAULT 'owner_only' CHECK(overhead_policy='owner_only');
CREATE TABLE purchase_investor_agreements (
 purchase_id TEXT PRIMARY KEY REFERENCES purchase_orders(id),user_id TEXT NOT NULL REFERENCES investment_profiles(user_id),
 agreed_iqd INTEGER NOT NULL CHECK(agreed_iqd>0),allocated_iqd INTEGER NOT NULL CHECK(allocated_iqd>=0 AND allocated_iqd<=agreed_iqd),
 batch_cost_iqd INTEGER NOT NULL CHECK(batch_cost_iqd>=0),profit_share_bps INTEGER NOT NULL CHECK(profit_share_bps BETWEEN 0 AND 10000),
 loss_share_bps INTEGER NOT NULL CHECK(loss_share_bps BETWEEN 0 AND 10000),
 allocation_basis TEXT NOT NULL DEFAULT 'landed_value' CHECK(allocation_basis='landed_value'),
 actor_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,request_json TEXT NOT NULL CHECK(json_valid(request_json))
);
CREATE TABLE purchase_investor_allocations (
 purchase_id TEXT NOT NULL REFERENCES purchase_investor_agreements(purchase_id),
 incoming_id TEXT NOT NULL UNIQUE REFERENCES incoming_inventory(id),contract_id TEXT NOT NULL UNIQUE REFERENCES investment_contracts(id),
 principal_iqd INTEGER NOT NULL CHECK(principal_iqd>0),PRIMARY KEY(purchase_id,incoming_id)
);
CREATE TABLE purchase_investor_receipts (
 id TEXT PRIMARY KEY,purchase_id TEXT NOT NULL REFERENCES purchase_investor_agreements(purchase_id),amount_iqd INTEGER NOT NULL CHECK(amount_iqd>0),
 allocated_iqd INTEGER NOT NULL CHECK(allocated_iqd>=0 AND allocated_iqd<=amount_iqd),payment_day TEXT NOT NULL,reference TEXT NOT NULL CHECK(length(reference)>0),
 actor_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,request_json TEXT NOT NULL CHECK(json_valid(request_json))
);
CREATE INDEX idx_purchase_investor_user ON purchase_investor_agreements(user_id,purchase_id);
CREATE TRIGGER purchase_investor_agreement_immutable BEFORE UPDATE ON purchase_investor_agreements BEGIN SELECT RAISE(ABORT,'Funded purchase terms immutable'); END;
CREATE TRIGGER purchase_investor_agreement_no_delete BEFORE DELETE ON purchase_investor_agreements BEGIN SELECT RAISE(ABORT,'Funded purchase terms immutable'); END;
CREATE TRIGGER purchase_investor_allocation_immutable BEFORE UPDATE ON purchase_investor_allocations BEGIN SELECT RAISE(ABORT,'Funding allocation immutable'); END;
CREATE TRIGGER purchase_investor_allocation_no_delete BEFORE DELETE ON purchase_investor_allocations BEGIN SELECT RAISE(ABORT,'Funding allocation immutable'); END;
CREATE TRIGGER purchase_investor_receipt_immutable BEFORE UPDATE ON purchase_investor_receipts BEGIN SELECT RAISE(ABORT,'Funding receipt immutable'); END;
CREATE TRIGGER purchase_investor_receipt_no_delete BEFORE DELETE ON purchase_investor_receipts BEGIN SELECT RAISE(ABORT,'Funding receipt immutable'); END;
CREATE TABLE investment_profile_history (
 user_id TEXT NOT NULL REFERENCES investment_profiles(user_id),version INTEGER NOT NULL,snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),actor_id TEXT NOT NULL REFERENCES users(id),recorded_at TEXT NOT NULL,PRIMARY KEY(user_id,version)
);
CREATE TRIGGER investment_profile_history_immutable BEFORE UPDATE ON investment_profile_history BEGIN SELECT RAISE(ABORT,'Investor profile history immutable'); END;
CREATE TRIGGER investment_profile_history_no_delete BEFORE DELETE ON investment_profile_history BEGIN SELECT RAISE(ABORT,'Investor profile history immutable'); END;
-- Unknown or USD-cent legacy investment records stay in their original tables.
-- Only an explicit, evidenced link may connect one to an IQD contract.
CREATE TABLE investment_legacy_links (
 legacy_investment_id TEXT PRIMARY KEY REFERENCES investments(id),contract_id TEXT REFERENCES investment_contracts(id),
 state TEXT NOT NULL DEFAULT 'review' CHECK(state IN('review','linked','historical')),
 evidence TEXT NOT NULL DEFAULT '',actor_id TEXT REFERENCES users(id),recorded_at TEXT,
 CHECK(state<>'linked' OR (contract_id IS NOT NULL AND length(evidence)>0))
);
