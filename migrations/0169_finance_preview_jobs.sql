-- Preview is a durable, read-only projection. It never posts money. Its source
-- clock must still match when the owner applies the version.
CREATE TABLE finance_wage_preview_jobs (
 id TEXT PRIMARY KEY,
 rule_id TEXT NOT NULL REFERENCES finance_cost_rules(id),
 actor_id TEXT NOT NULL REFERENCES users(id),
 input_json TEXT NOT NULL CHECK(json_valid(input_json)),
 source_version INTEGER NOT NULL,
 cursor TEXT NOT NULL DEFAULT '',
 processed_orders INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'running' CHECK(state IN('running','complete')),
 work_json TEXT NOT NULL CHECK(json_valid(work_json)),
 result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
 preview_token TEXT,
 version INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL
);
CREATE INDEX finance_wage_preview_token ON finance_wage_preview_jobs(preview_token,actor_id);

-- Only a completed, applied preview may reserve the necessary overpayment.
-- This does not make the affected earnings withdrawable before posting.
CREATE TABLE finance_wage_pending_targets (
 change_id TEXT NOT NULL REFERENCES finance_wage_changes(id),
 cost_id TEXT NOT NULL REFERENCES finance_order_costs(id),
 amount_iqd INTEGER CHECK(amount_iqd IS NULL OR amount_iqd>=0),
 PRIMARY KEY(change_id,cost_id)
);
