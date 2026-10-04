-- Order-specific corrections are append-only; catalog prices and physical
-- FIFO layers remain unchanged. The control account carries unapplied
-- financial corrections separately from customer receivables and cash.
INSERT INTO accounting_accounts(code,name,kind) VALUES ('2990','تسويات مالية خاصة بالطلبات','liability');
INSERT INTO accounting_accounts(code,name,kind) VALUES ('5400','أجور خدمات الدفع','expense');
INSERT INTO expense_categories(id,slug,name_ar,name_en,sort) VALUES
 ('exp_owner_marketing','owner-monthly-marketing','ترويج شهري على المالك','Owner monthly marketing',90);
CREATE TABLE finance_order_versions (
 order_id TEXT PRIMARY KEY REFERENCES orders(id), version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
);
CREATE TABLE finance_order_adjustments (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, order_id TEXT NOT NULL REFERENCES orders(id),
 order_item_id TEXT REFERENCES order_items(id), field TEXT NOT NULL
 CHECK(field IN ('net_goods_iqd','cogs_iqd','shipping_iqd','cod_tax_iqd','courier_fee_iqd','payment_fee_iqd','manual_direct_iqd')),
 old_value_iqd INTEGER, new_value_iqd INTEGER NOT NULL CHECK(new_value_iqd>=0), delta_iqd INTEGER,
 version INTEGER NOT NULL CHECK(version>0), actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 reason TEXT NOT NULL DEFAULT 'تعديل مالي خاص بالطلب', journal_id TEXT REFERENCES accounting_entries(id),
 allocations_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(allocations_json)),
 before_json TEXT NOT NULL CHECK(json_valid(before_json)), after_json TEXT NOT NULL CHECK(json_valid(after_json)),
 UNIQUE(order_id,version)
);
CREATE INDEX idx_finance_adjustment_latest ON finance_order_adjustments(order_id,order_item_id,field,version DESC);
CREATE TABLE finance_workspace_postings (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), field TEXT NOT NULL,
 delta_iqd INTEGER NOT NULL, journal_id TEXT NOT NULL UNIQUE REFERENCES accounting_entries(id),
 actor_id TEXT REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX idx_workspace_postings_order ON finance_workspace_postings(order_id,field);
CREATE TRIGGER finance_workspace_posting_no_update BEFORE UPDATE ON finance_workspace_postings BEGIN SELECT RAISE(ABORT,'Workspace posting immutable'); END;
CREATE TRIGGER finance_workspace_posting_no_delete BEFORE DELETE ON finance_workspace_postings BEGIN SELECT RAISE(ABORT,'Workspace posting immutable'); END;
CREATE TRIGGER finance_adjustment_no_update BEFORE UPDATE ON finance_order_adjustments BEGIN SELECT RAISE(ABORT,'Financial revision immutable'); END;
CREATE TRIGGER finance_adjustment_no_delete BEFORE DELETE ON finance_order_adjustments BEGIN SELECT RAISE(ABORT,'Financial revision immutable'); END;
CREATE TABLE finance_order_calculations (
 order_id TEXT NOT NULL REFERENCES orders(id), version INTEGER NOT NULL CHECK(version>=0),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), actor_id TEXT REFERENCES users(id), created_at TEXT NOT NULL,
 PRIMARY KEY(order_id,version)
);
CREATE TRIGGER finance_calculation_no_update BEFORE UPDATE ON finance_order_calculations BEGIN SELECT RAISE(ABORT,'Financial calculation immutable'); END;
CREATE TRIGGER finance_calculation_no_delete BEFORE DELETE ON finance_order_calculations BEGIN SELECT RAISE(ABORT,'Financial calculation immutable'); END;
CREATE TABLE finance_line_departments (
 order_item_id TEXT PRIMARY KEY REFERENCES order_items(id), main_catalog_id TEXT, sub_catalog_id TEXT,
 main_name TEXT NOT NULL DEFAULT '', sub_name TEXT NOT NULL DEFAULT '', captured_at TEXT NOT NULL,
 is_legacy INTEGER NOT NULL DEFAULT 0 CHECK(is_legacy IN (0,1))
);
-- Historical placements were never frozen. Preserve their classification at
-- upgrade and disclose that capture date instead of inventing checkout facts.
INSERT INTO finance_line_departments(order_item_id,main_catalog_id,sub_catalog_id,main_name,sub_name,captured_at,is_legacy)
 SELECT i.id,p.category_id,p.sub_category_id,COALESCE(mc.name_ar,''),COALESCE(sc.name_ar,''),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1
 FROM order_items i LEFT JOIN products p ON p.id=i.product_id LEFT JOIN catalogs mc ON mc.id=p.category_id LEFT JOIN catalogs sc ON sc.id=p.sub_category_id;
CREATE TRIGGER finance_line_department_no_update BEFORE UPDATE ON finance_line_departments BEGIN SELECT RAISE(ABORT,'Order department snapshot immutable'); END;
CREATE TRIGGER finance_line_department_no_delete BEFORE DELETE ON finance_line_departments BEGIN SELECT RAISE(ABORT,'Order department snapshot immutable'); END;
CREATE TABLE finance_monthly_promotions (
 id TEXT PRIMARY KEY, month TEXT NOT NULL CHECK(month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
 title TEXT NOT NULL DEFAULT 'ترويج شهري', currency TEXT NOT NULL CHECK(currency IN ('IQD','USD','EUR','CNY')),
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0), exchange_rate REAL NOT NULL CHECK(exchange_rate>0),
 amount_iqd INTEGER NOT NULL CHECK(amount_iqd>0), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)),
 expense_id TEXT NOT NULL UNIQUE REFERENCES operating_expenses(id), version INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_monthly_promotion_month ON finance_monthly_promotions(month,enabled);
CREATE TABLE finance_promotion_history (
 id TEXT PRIMARY KEY, promotion_id TEXT NOT NULL REFERENCES finance_monthly_promotions(id),
 operation_id TEXT NOT NULL UNIQUE, version INTEGER NOT NULL, before_json TEXT NOT NULL CHECK(json_valid(before_json)),
 after_json TEXT NOT NULL CHECK(json_valid(after_json)), actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 UNIQUE(promotion_id,version)
);
CREATE TRIGGER finance_promotion_history_no_update BEFORE UPDATE ON finance_promotion_history BEGIN SELECT RAISE(ABORT,'Promotion revision immutable'); END;
CREATE TRIGGER finance_promotion_history_no_delete BEFORE DELETE ON finance_promotion_history BEGIN SELECT RAISE(ABORT,'Promotion revision immutable'); END;
-- The ordinary expense editor cannot change a promotion behind its source.
CREATE TRIGGER finance_promotion_expense_guard BEFORE UPDATE ON operating_expenses
 WHEN EXISTS(SELECT 1 FROM finance_monthly_promotions WHERE expense_id=OLD.id)
 AND NOT EXISTS(SELECT 1 FROM ops_guards WHERE id='promotion-write:'||OLD.id)
 BEGIN SELECT RAISE(ABORT,'Correct the monthly promotion source'); END;
CREATE TRIGGER finance_promotion_expense_delete BEFORE DELETE ON operating_expenses
 WHEN EXISTS(SELECT 1 FROM finance_monthly_promotions WHERE expense_id=OLD.id)
 BEGIN SELECT RAISE(ABORT,'Monthly promotion expense immutable'); END;
