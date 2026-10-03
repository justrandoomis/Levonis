-- Additive operations upgrade. Existing quantities, FIFO allocations, wallets
-- and historical profit are not rewritten. New documents use the same lots.
CREATE INDEX IF NOT EXISTS idx_lots_product_fifo ON inventory_lots(product_id,scope,scope_id,received_at,id);
CREATE TABLE ops_guards (id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1));
CREATE TABLE ops_permissions (
  user_id TEXT NOT NULL REFERENCES users(id), capability TEXT NOT NULL
    CHECK(capability IN ('purchase','receive','count','transfer','rules','pay','accounting','close')),
  allowed INTEGER NOT NULL CHECK(allowed IN (0,1)), PRIMARY KEY(user_id,capability)
);
CREATE TABLE stock_locations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES stock_locations(id),
  kind TEXT NOT NULL DEFAULT 'warehouse' CHECK(kind IN ('warehouse','shelf','quarantine')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE inventory_lot_locations (
  lot_id TEXT PRIMARY KEY REFERENCES inventory_lots(id), location_id TEXT NOT NULL REFERENCES stock_locations(id)
);
CREATE INDEX idx_lot_locations_location ON inventory_lot_locations(location_id);
CREATE TABLE stock_transfers (
  id TEXT PRIMARY KEY, source_lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
  target_lot_id TEXT NOT NULL REFERENCES inventory_lots(id), from_location_id TEXT REFERENCES stock_locations(id),
  to_location_id TEXT NOT NULL REFERENCES stock_locations(id), qty INTEGER NOT NULL CHECK(qty>0),
  note TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY, supplier_id TEXT REFERENCES inventory_suppliers(id), invoice_no TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL CHECK(currency IN ('IQD','USD','CNY','EUR')), exchange_rate REAL NOT NULL CHECK(exchange_rate>0),
  purchase_day TEXT NOT NULL, expected_day TEXT, warehouse_id TEXT REFERENCES stock_locations(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ordered','partial','received','cancelled')),
  cost_state TEXT NOT NULL DEFAULT 'estimated' CHECK(cost_state IN ('estimated','final')),
  tracking TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', attachment_url TEXT NOT NULL DEFAULT '',
  invoice_total_iqd INTEGER CHECK(invoice_total_iqd IS NULL OR invoice_total_iqd>=0), version INTEGER NOT NULL DEFAULT 1,
  request_json TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE purchase_lines (
  id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchase_orders(id), incoming_id TEXT NOT NULL UNIQUE REFERENCES incoming_inventory(id),
  label TEXT NOT NULL, source_unit_amount REAL NOT NULL CHECK(source_unit_amount>=0),
  weight_g REAL NOT NULL DEFAULT 0 CHECK(weight_g>=0), volume_mm3 REAL NOT NULL DEFAULT 0 CHECK(volume_mm3>=0),
  selling_price_iqd INTEGER CHECK(selling_price_iqd IS NULL OR selling_price_iqd>=0),
  charges_iqd INTEGER NOT NULL DEFAULT 0 CHECK(charges_iqd>=0),
  invoiced_qty INTEGER NOT NULL DEFAULT 0 CHECK(invoiced_qty>=0), rejected_qty INTEGER NOT NULL DEFAULT 0 CHECK(rejected_qty>=0)
);
CREATE INDEX idx_purchase_lines_purchase ON purchase_lines(purchase_id);
CREATE TABLE purchase_charges (
  id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchase_orders(id), title TEXT NOT NULL,
  amount_iqd INTEGER NOT NULL CHECK(amount_iqd>=0), basis TEXT NOT NULL CHECK(basis IN ('quantity','weight','volume','value'))
);
CREATE TABLE supplier_payments (
  id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchase_orders(id), amount_iqd INTEGER NOT NULL CHECK(amount_iqd>0),
  payment_day TEXT NOT NULL, reference TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE purchase_receiving_notes (
  id TEXT PRIMARY KEY REFERENCES incoming_inventory_receipts(id), purchase_id TEXT NOT NULL REFERENCES purchase_orders(id),
  rejected_qty INTEGER NOT NULL DEFAULT 0 CHECK(rejected_qty>=0), note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE purchase_receiving_events (id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchase_orders(id), request_json TEXT NOT NULL);
CREATE TABLE stock_counts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','cancelled')),
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, posted_at TEXT
);
CREATE TABLE stock_count_lines (
  id TEXT PRIMARY KEY, count_id TEXT NOT NULL REFERENCES stock_counts(id), product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  scope TEXT NOT NULL CHECK(scope IN ('base','option','color','variant')), scope_id TEXT NOT NULL DEFAULT '',
  expected_qty INTEGER NOT NULL CHECK(expected_qty>=0), counted_qty INTEGER NOT NULL CHECK(counted_qty>=0),
  unit_cost_iqd INTEGER CHECK(unit_cost_iqd IS NULL OR unit_cost_iqd>=0), reason TEXT NOT NULL DEFAULT 'count', note TEXT NOT NULL DEFAULT '',
  UNIQUE(count_id,product_id,scope,scope_id)
);
CREATE TABLE stock_serial_links (
  serial_norm TEXT PRIMARY KEY REFERENCES serial_inventory(serial_norm), lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
  order_item_id TEXT REFERENCES order_items(id), linked_by TEXT NOT NULL REFERENCES users(id), linked_at TEXT NOT NULL
);
CREATE TABLE stock_return_inspections (
  id TEXT PRIMARY KEY, order_item_id TEXT NOT NULL REFERENCES order_items(id), qty INTEGER NOT NULL CHECK(qty>0),
  disposition TEXT NOT NULL CHECK(disposition IN ('restock','quarantine','damage')),
  note TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  -- Inspection is evidence; existing return/refund routes own restoration.
  location_id TEXT REFERENCES stock_locations(id), return_case_id TEXT UNIQUE REFERENCES return_cases(id)
);
CREATE TABLE finance_staff (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
INSERT INTO finance_staff(id,name,role) VALUES ('staff_sajjad','سجاد','تجهيز'),('staff_hussein','حسين','الرد على الرسائل');
CREATE TABLE finance_cost_centers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE finance_cost_rules (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, name TEXT NOT NULL, group_key TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK(target_type IN ('all','catalog','product')), target_id TEXT NOT NULL DEFAULT '',
  basis TEXT NOT NULL CHECK(basis IN ('unit','order','profit_percent','revenue_percent')),
  amount INTEGER NOT NULL CHECK(amount>=0), -- IQD for fixed rules; basis points for percent rules
  staff_id TEXT REFERENCES finance_staff(id), category_id TEXT NOT NULL REFERENCES expense_categories(id),
  center_id TEXT REFERENCES finance_cost_centers(id), milestone TEXT NOT NULL CHECK(milestone IN ('prepared','delivered')),
  requires_assignment INTEGER NOT NULL DEFAULT 0 CHECK(requires_assignment IN (0,1)),
  cap_iqd INTEGER CHECK(cap_iqd IS NULL OR cap_iqd>=0), priority INTEGER NOT NULL DEFAULT 0,
  effective_from TEXT NOT NULL, effective_to TEXT, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id)
);
CREATE TABLE finance_rule_versions (
  rule_id TEXT NOT NULL REFERENCES finance_cost_rules(id), version INTEGER NOT NULL, snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  created_at TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(rule_id,version)
);
CREATE TRIGGER finance_rule_version_immutable BEFORE UPDATE ON finance_rule_versions BEGIN SELECT RAISE(ABORT,'Rule version immutable'); END;
CREATE TRIGGER finance_rule_version_delete BEFORE DELETE ON finance_rule_versions BEGIN SELECT RAISE(ABORT,'Rule version immutable'); END;
CREATE TABLE finance_order_snapshots (
  order_id TEXT PRIMARY KEY REFERENCES orders(id), rules_json TEXT NOT NULL CHECK(json_valid(rules_json)),
  created_at TEXT NOT NULL, basis_version TEXT NOT NULL DEFAULT 'fifo-net-goods-v1'
);
CREATE TRIGGER finance_snapshot_immutable BEFORE UPDATE ON finance_order_snapshots BEGIN
  SELECT RAISE(ABORT,'Order cost rules are immutable');
END;
CREATE TABLE finance_task_assignments (
  order_id TEXT NOT NULL REFERENCES orders(id), group_key TEXT NOT NULL, staff_id TEXT NOT NULL REFERENCES finance_staff(id),
  completed_at TEXT, actor_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(order_id,group_key)
);
CREATE TABLE finance_order_costs (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), order_item_id TEXT REFERENCES order_items(id),
  rule_id TEXT NOT NULL, rule_version INTEGER NOT NULL, rule_name TEXT NOT NULL,
  group_key TEXT NOT NULL, staff_id TEXT REFERENCES finance_staff(id), category_id TEXT NOT NULL REFERENCES expense_categories(id),
  center_id TEXT REFERENCES finance_cost_centers(id), milestone TEXT NOT NULL, base_iqd INTEGER, qty INTEGER NOT NULL,
  amount_iqd INTEGER CHECK(amount_iqd IS NULL OR amount_iqd>=0), cost_day TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending_cost','due','approved','reversed')),
  expense_id TEXT UNIQUE REFERENCES operating_expenses(id), snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  UNIQUE(order_id,order_item_id,rule_id)
);
CREATE INDEX idx_order_costs_day ON finance_order_costs(cost_day,state);
CREATE UNIQUE INDEX idx_order_cost_once ON finance_order_costs(order_id,COALESCE(order_item_id,''),rule_id);
CREATE INDEX idx_order_costs_staff ON finance_order_costs(staff_id,state);
CREATE TABLE finance_staff_payments (
  id TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES finance_staff(id), amount_iqd INTEGER NOT NULL CHECK(amount_iqd>0),
  kind TEXT NOT NULL CHECK(kind IN ('payment','advance')), payment_day TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE finance_payment_allocations (
  payment_id TEXT NOT NULL REFERENCES finance_staff_payments(id), cost_id TEXT NOT NULL REFERENCES finance_order_costs(id),
  amount_iqd INTEGER NOT NULL CHECK(amount_iqd>0), PRIMARY KEY(payment_id,cost_id)
);
CREATE TABLE finance_cost_reversals (
  id TEXT PRIMARY KEY, cost_id TEXT NOT NULL UNIQUE REFERENCES finance_order_costs(id), amount_iqd INTEGER NOT NULL CHECK(amount_iqd>0),
  reversal_day TEXT NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id)
);
CREATE TABLE finance_advance_settlements (
  id TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES finance_staff(id), amount_iqd INTEGER NOT NULL CHECK(amount_iqd>0),
  settlement_day TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE finance_expense_links (
  expense_id TEXT PRIMARY KEY REFERENCES operating_expenses(id), center_id TEXT REFERENCES finance_cost_centers(id),
  order_id TEXT REFERENCES orders(id), target_type TEXT NOT NULL DEFAULT 'all' CHECK(target_type IN ('all','catalog','product')), target_id TEXT NOT NULL DEFAULT '', allocation_basis TEXT NOT NULL DEFAULT 'none' CHECK(allocation_basis IN ('none','revenue','units','orders'))
);
CREATE TABLE accounting_periods (
  month TEXT PRIMARY KEY, closed_at TEXT NOT NULL, closed_by TEXT NOT NULL REFERENCES users(id)
);
CREATE TABLE accounting_accounts (code TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('asset','liability','equity','income','expense')));
INSERT INTO accounting_accounts(code,name,kind) VALUES
  ('1000','النقدية','asset'),('1100','ذمم العملاء وشركات التوصيل','asset'),('1200','المخزون','asset'),
  ('1300','دفعات الموردين المقدمة','asset'),('1400','سلف الموظفين','asset'),('2000','ذمم الموردين','liability'),
  ('2100','مستحقات الموظفين','liability'),('2200','التزامات المحافظ','liability'),('2300','دفعات العملاء المقدمة','liability'),
  ('3000','رأس المال','equity'),('4000','إيرادات البضاعة','income'),('4100','إيرادات التوصيل','income'),
  ('5000','تكلفة البضاعة','expense'),('5100','المصروفات التشغيلية','expense'),('5200','أجور شركات التوصيل','expense'),('5300','خسائر المخزون','expense');
CREATE TABLE accounting_entries (
  id TEXT PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, entry_day TEXT NOT NULL, title TEXT NOT NULL,
  source_type TEXT NOT NULL, source_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','posted')),
  reversal_of TEXT UNIQUE REFERENCES accounting_entries(id), actor_id TEXT REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE accounting_lines (
  id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES accounting_entries(id), account_code TEXT NOT NULL REFERENCES accounting_accounts(code),
  debit_iqd INTEGER NOT NULL DEFAULT 0 CHECK(debit_iqd>=0), credit_iqd INTEGER NOT NULL DEFAULT 0 CHECK(credit_iqd>=0),
  CHECK((debit_iqd>0 AND credit_iqd=0) OR (credit_iqd>0 AND debit_iqd=0))
);
CREATE TRIGGER accounting_post BEFORE UPDATE OF state ON accounting_entries WHEN NEW.state='posted' BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM accounting_periods WHERE month=substr(NEW.entry_day,1,7)) THEN RAISE(ABORT,'Accounting period closed') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM accounting_lines WHERE entry_id=NEW.id)<2
    OR (SELECT SUM(debit_iqd-credit_iqd) FROM accounting_lines WHERE entry_id=NEW.id)<>0 THEN RAISE(ABORT,'Unbalanced journal') END;
END;
CREATE TRIGGER accounting_no_posted_insert BEFORE INSERT ON accounting_entries WHEN NEW.state='posted' BEGIN SELECT RAISE(ABORT,'Post through journal validation'); END;
CREATE TRIGGER accounting_immutable BEFORE UPDATE ON accounting_entries WHEN OLD.state='posted' BEGIN SELECT RAISE(ABORT,'Reverse a posted journal'); END;
CREATE TRIGGER accounting_no_delete BEFORE DELETE ON accounting_entries WHEN OLD.state='posted' BEGIN SELECT RAISE(ABORT,'Reverse a posted journal'); END;
CREATE TRIGGER accounting_lines_insert BEFORE INSERT ON accounting_lines WHEN EXISTS(SELECT 1 FROM accounting_entries WHERE id=NEW.entry_id AND state='posted') BEGIN SELECT RAISE(ABORT,'Posted lines immutable'); END;
CREATE TRIGGER accounting_lines_update BEFORE UPDATE ON accounting_lines WHEN EXISTS(SELECT 1 FROM accounting_entries WHERE id=OLD.entry_id AND state='posted') BEGIN SELECT RAISE(ABORT,'Posted lines immutable'); END;
CREATE TRIGGER accounting_lines_delete BEFORE DELETE ON accounting_lines WHEN EXISTS(SELECT 1 FROM accounting_entries WHERE id=OLD.entry_id AND state='posted') BEGIN SELECT RAISE(ABORT,'Posted lines immutable'); END;
CREATE INDEX idx_accounting_day ON accounting_entries(entry_day,state);
CREATE TABLE finance_collections (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), payer TEXT NOT NULL CHECK(payer IN ('customer','courier','bank')),
  amount_iqd INTEGER NOT NULL CHECK(amount_iqd>0), fee_iqd INTEGER NOT NULL DEFAULT 0 CHECK(fee_iqd>=0),
  collection_day TEXT NOT NULL, reference TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  expense_id TEXT REFERENCES operating_expenses(id)
);
CREATE TABLE finance_posting_errors (
  event_key TEXT PRIMARY KEY, order_id TEXT REFERENCES orders(id), message TEXT NOT NULL, last_attempt_at TEXT NOT NULL
);
CREATE TABLE finance_refund_facts (
  case_id TEXT PRIMARY KEY REFERENCES return_cases(id), order_id TEXT NOT NULL REFERENCES orders(id),
  refund_iqd INTEGER NOT NULL CHECK(refund_iqd>=0), qty INTEGER NOT NULL CHECK(qty>0), disposition TEXT NOT NULL,
  cogs_iqd INTEGER CHECK(cogs_iqd IS NULL OR cogs_iqd>=0), channel TEXT NOT NULL DEFAULT 'wallet',
  refunded_day TEXT NOT NULL, posted_at TEXT
);
CREATE TRIGGER expense_closed_insert BEFORE INSERT ON operating_expenses WHEN EXISTS(SELECT 1 FROM accounting_periods WHERE month=substr(NEW.expense_day,1,7)) BEGIN SELECT RAISE(ABORT,'Accounting period closed'); END;
CREATE TRIGGER expense_closed_update BEFORE UPDATE ON operating_expenses WHEN EXISTS(SELECT 1 FROM accounting_periods WHERE month IN (substr(NEW.expense_day,1,7),substr(OLD.expense_day,1,7))) BEGIN SELECT RAISE(ABORT,'Accounting period closed'); END;
CREATE TRIGGER expense_closed_delete BEFORE DELETE ON operating_expenses WHEN EXISTS(SELECT 1 FROM accounting_periods WHERE month=substr(OLD.expense_day,1,7)) BEGIN SELECT RAISE(ABORT,'Accounting period closed'); END;
CREATE TRIGGER expense_generated_update BEFORE UPDATE ON operating_expenses WHEN EXISTS(SELECT 1 FROM finance_order_costs WHERE expense_id=OLD.id) OR EXISTS(SELECT 1 FROM finance_collections WHERE expense_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Correct the source operation'); END;
CREATE TRIGGER expense_generated_delete BEFORE DELETE ON operating_expenses WHEN EXISTS(SELECT 1 FROM finance_order_costs WHERE expense_id=OLD.id) OR EXISTS(SELECT 1 FROM finance_collections WHERE expense_id=OLD.id) BEGIN SELECT RAISE(ABORT,'Correct the source operation'); END;
