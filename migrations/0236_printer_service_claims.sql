-- PRINTER SERVICES, PHASE 3 — warranty + Levo Care claims and their money (owner rulings 2026-11-18;
-- DECISIONS row 347). Reuses the warranty claims desk (warranty_claims, 0001/0003/0006/0191); adds:
--
-- (1) warranty_claims.claim_kind: 'warranty' (the shop's own cost) or 'care' (a Levo Care claim, the
--     customer pays a co-pay after the Care discount). NULL = a claim filed before phase 3 (warranty).
-- (2) printer_care_policies: the Care terms frozen per policy_version at the publish that first carried
--     them (owner ruling D1: the FIRST published terms are v1 for everyone already holding Care; later
--     edits need a new version, for new buyers only). Never updated, never deleted (CARE_POLICY_FROZEN).
-- (3) care_claim_benefits: one Care benefit per claim — the desk's quote (list, eligible, discount,
--     benefit, co-pay), the customer's acceptance, the financial admin's approval (caps re-checked in
--     the write), its void, and the co-pay collected in cash. An approved benefit changes only to void
--     (before its co-pay is collected) or to record that collection (CARE_BENEFIT_FROZEN).
-- (4) service_claim_costs: what a claim cost the shop out of pocket (a part bought, labour, a courier,
--     a replacement, other). Each is a GENERAL expense of its cost day (operating_expenses, category
--     exp_warranty_claims / exp_care_claims) — never written back to any order: historical orders, their
--     profit and every investor / staff share stay untouched (owner ruling).
-- (5) account 4300 «إيرادات خدمات الصيانة» (Repair service income): the co-pay is service income
--     (owner ruling D2), journal care-copay:<claim> 1000 Dr / 4300 Cr.
--
-- Additive; no foreign key to order_items. Every reader tolerates its absence (CLAUDE.md rule 2).
ALTER TABLE warranty_claims ADD COLUMN claim_kind TEXT CHECK (claim_kind IS NULL OR claim_kind IN ('warranty', 'care'));

CREATE TABLE IF NOT EXISTS printer_care_policies (
  policy_version INTEGER PRIMARY KEY CHECK (policy_version >= 1),
  terms TEXT NOT NULL CHECK (json_valid(terms)),
  published_at TEXT NOT NULL,
  published_by TEXT
);
CREATE TRIGGER IF NOT EXISTS trg_printer_care_policies_frozen BEFORE UPDATE ON printer_care_policies
BEGIN
  SELECT RAISE(ABORT, 'CARE_POLICY_FROZEN');
END;
CREATE TRIGGER IF NOT EXISTS trg_printer_care_policies_kept BEFORE DELETE ON printer_care_policies
BEGIN
  SELECT RAISE(ABORT, 'CARE_POLICY_FROZEN');
END;

CREATE TABLE IF NOT EXISTS care_claim_benefits (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL UNIQUE REFERENCES warranty_claims(id),
  -- The device's ROOT unit (a replacement resolves to the unit first sold): Care and its caps follow the device.
  entitlement_unit_id TEXT NOT NULL,
  -- The order line that sold the Care (the root unit's line).
  order_item_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  quote_json TEXT NOT NULL CHECK (json_valid(quote_json)),
  list_iqd INTEGER NOT NULL CHECK (list_iqd >= 0 AND list_iqd <= 1000000000),
  eligible_iqd INTEGER NOT NULL CHECK (eligible_iqd >= 0 AND eligible_iqd <= list_iqd),
  discount_pct INTEGER NOT NULL CHECK (discount_pct BETWEEN 0 AND 90),
  benefit_iqd INTEGER NOT NULL CHECK (benefit_iqd >= 0 AND benefit_iqd <= eligible_iqd),
  copay_iqd INTEGER NOT NULL CHECK (copay_iqd = list_iqd - benefit_iqd),
  state TEXT NOT NULL DEFAULT 'quoted' CHECK (state IN ('quoted', 'accepted', 'approved', 'void')),
  -- Moves on every re-quote: the customer accepts, and the admin approves, THE quote they saw.
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  quoted_by TEXT,
  quoted_at TEXT NOT NULL,
  customer_accepted_at TEXT,
  decided_by TEXT,
  decided_at TEXT,
  -- The Baghdad day of the approval (the report's «Care benefit given» counts it there).
  decided_day TEXT,
  copay_collected_at TEXT,
  copay_collected_by TEXT,
  copay_collected_day TEXT,
  copay_operation_id TEXT UNIQUE,
  voided_at TEXT,
  voided_by TEXT,
  void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_care_claim_benefits_unit ON care_claim_benefits(entitlement_unit_id, state);
CREATE INDEX IF NOT EXISTS idx_care_claim_benefits_order_item ON care_claim_benefits(order_item_id);
CREATE INDEX IF NOT EXISTS idx_care_claim_benefits_decided ON care_claim_benefits(decided_day) WHERE decided_day IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_care_claim_benefits_copay ON care_claim_benefits(copay_collected_day) WHERE copay_collected_day IS NOT NULL;

-- An approved benefit keeps its figures: it changes only to void (never once its co-pay is
-- collected) or to record the co-pay's collection, once.
CREATE TRIGGER IF NOT EXISTS trg_care_claim_benefits_approved_frozen BEFORE UPDATE ON care_claim_benefits
WHEN OLD.state = 'approved' AND (
  NEW.state NOT IN ('approved', 'void')
  OR NEW.list_iqd <> OLD.list_iqd OR NEW.eligible_iqd <> OLD.eligible_iqd OR NEW.benefit_iqd <> OLD.benefit_iqd
  OR NEW.copay_iqd <> OLD.copay_iqd OR NEW.discount_pct <> OLD.discount_pct OR NEW.quote_json <> OLD.quote_json
  OR NEW.policy_version <> OLD.policy_version OR NEW.entitlement_unit_id <> OLD.entitlement_unit_id
  OR (NEW.state = 'void' AND OLD.copay_collected_at IS NOT NULL)
  OR (OLD.copay_collected_at IS NOT NULL AND NEW.copay_collected_at IS NOT OLD.copay_collected_at))
BEGIN
  SELECT RAISE(ABORT, 'CARE_BENEFIT_FROZEN');
END;
CREATE TRIGGER IF NOT EXISTS trg_care_claim_benefits_kept BEFORE DELETE ON care_claim_benefits
BEGIN
  SELECT RAISE(ABORT, 'CARE_BENEFIT_FROZEN');
END;

CREATE TABLE IF NOT EXISTS service_claim_costs (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES warranty_claims(id),
  claim_kind TEXT NOT NULL CHECK (claim_kind IN ('warranty', 'care')),
  kind TEXT NOT NULL CHECK (kind IN ('part_purchase', 'labor', 'courier', 'replacement', 'other')),
  amount_iqd INTEGER NOT NULL CHECK (amount_iqd > 0 AND amount_iqd <= 1000000000),
  cost_day TEXT NOT NULL,
  -- The general expense (operating_expenses) this cost IS; voided with it.
  expense_id TEXT NOT NULL UNIQUE REFERENCES operating_expenses(id),
  -- The request's own key: a retry returns the same cost, never a second expense.
  operation_id TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  voided_at TEXT,
  voided_by TEXT,
  void_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_service_claim_costs_day ON service_claim_costs(cost_day);
CREATE INDEX IF NOT EXISTS idx_service_claim_costs_claim ON service_claim_costs(claim_id);
CREATE TRIGGER IF NOT EXISTS trg_service_claim_costs_kept BEFORE DELETE ON service_claim_costs
BEGIN
  SELECT RAISE(ABORT, 'SERVICE_CLAIM_COST_KEPT');
END;

INSERT OR IGNORE INTO expense_categories (id, slug, name_ar, name_en, name_ckb, sort) VALUES
  ('exp_warranty_claims', 'warranty-claim-costs', 'تكاليف مطالبات الضمان', 'Warranty claim costs', 'تێچووی داواکارییەکانی گەرەنتی', 91),
  ('exp_care_claims', 'care-claim-costs', 'تكاليف مطالبات ليفو كير', 'Levo Care claim costs', 'تێچووی داواکارییەکانی لیڤۆ کێر', 92);

INSERT OR IGNORE INTO accounting_accounts (code, name, kind) VALUES ('4300', 'إيرادات خدمات الصيانة', 'income');
