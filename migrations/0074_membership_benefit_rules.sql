-- ============================================================================
--  0074 — MEMBERSHIP SHOPPING BENEFITS BECOME DATA
-- ============================================================================
-- WHAT WAS WRONG. Every commercial number a membership is worth lived in one
-- of three places, and none of them was a place an owner could reach:
--
--   * `packages/pricing/src/pricing.ts` knew exactly ONE member-discount rule —
--     `proPricingPolicy` — and it was a single store-wide percentage for PRO
--     with no cap, no category, no quantity limit and no PREMIUM equivalent.
--     Every other member discount had to be typed per product as an explicit
--     `pro_price_iqd` / `prime_price_iqd`, one product at a time.
--   * `shippingPolicy` in `admin_settings` held the free-delivery thresholds,
--     but WHICH delivery methods a tier's waiver covers was inferred from
--     `pro_waiver_covers`, a flag that was really about printer and carton
--     surcharges. There was no way to say "PREMIUM: standard only".
--   * COD tax exemption did not exist at all.
--
-- So "PRO gets 10% off printers, capped at 100,000 per unit" was not a thing
-- the system could hold. It could hold "this printer costs a PRO member
-- 1,750,000", which is the same number for exactly one product until someone
-- edits it by hand.
--
-- WHAT THIS ADDS. One table of RULES, read by one resolver
-- (`packages/pricing/src/membershipBenefits.ts`), consumed by the price
-- resolver, the shipping quote and the COD tax step that already exist. It is
-- deliberately not a second discount engine: `resolveUnitPrice` still decides
-- every price, `quoteShipping` still decides every delivery fee, and
-- `codDeliveryTaxIqd` still calculates the tax in full before anything is
-- waived — the rules only tell them what the membership is worth.
--
-- WHY A TABLE AND NOT ANOTHER `admin_settings` KEY. The settings store is a
-- key/value blob, which is the right shape for "one policy" and the wrong
-- shape for "a list of rules that must be ordered, scoped, dated and switched
-- on and off individually". A category override, a product override and a tier
-- default are three ROWS of the same kind; expressing them as nested JSON
-- would put the precedence logic in a parser instead of in a query.
--
-- HISTORY IS NOT RECALCULATED. An order snapshots the rule set that priced it
-- (`membership_benefit_versions.id` on the order, plus the resolved numbers on
-- the order and its items), so changing a rule tomorrow leaves yesterday's
-- totals, invoices and receipts exactly as they were.

CREATE TABLE IF NOT EXISTS membership_benefit_rules (
  id TEXT PRIMARY KEY,

  -- WHICH MEMBERSHIP. The database's historical ids: 'prime' is the tier every
  -- customer-facing surface calls PREMIUM, and 'pro' is the highest tier.
  -- A rule names exactly one tier; inheritance is NOT applied to rules,
  -- because "PRO inherits PREMIUM's printer discount" would silently make a
  -- fixed 25,000 the PRO benefit the moment a PRO rule was disabled.
  tier TEXT NOT NULL CHECK (tier IN ('plus', 'prime', 'pro')),

  -- WHAT IT GRANTS.
  --   product_discount   — money off an eligible line
  --   free_shipping      — a delivery-fee waiver above a threshold
  --   cod_tax_exemption  — the cash-on-delivery tax, calculated then waived
  benefit_type TEXT NOT NULL
    CHECK (benefit_type IN ('product_discount', 'free_shipping', 'cod_tax_exemption')),

  -- WHAT IT APPLIES TO, most specific first. The scope column is the authority;
  -- the three id columns carry the target it names. A 'global' rule is the
  -- tier's default and carries none of them.
  scope TEXT NOT NULL DEFAULT 'global'
    CHECK (scope IN ('global', 'category', 'sub_category', 'product')),
  category_id TEXT,
  sub_category_id TEXT,
  product_id TEXT,

  -- HOW THE DISCOUNT IS CALCULATED (product_discount only).
  --   percent — `percent` of the line's regular price
  --   fixed   — `fixed_iqd` off it
  -- PRO's printer rule is a percent with a cap; PREMIUM's is a fixed amount.
  -- Neither is wired in as a constant anywhere: both are rows.
  discount_mode TEXT CHECK (discount_mode IS NULL OR discount_mode IN ('percent', 'fixed')),
  percent REAL,
  fixed_iqd INTEGER,

  -- THE CEILING, and the thing it is a ceiling ON.
  --   per_unit  — each eligible unit is discounted at most this much, so two
  --               printers at a 100,000 cap save 200,000
  --   per_order — the whole line's discount is capped once
  -- The distinction is the owner's, and getting it wrong is a real amount of
  -- money, so it is stored rather than assumed.
  max_discount_iqd INTEGER,
  cap_scope TEXT CHECK (cap_scope IS NULL OR cap_scope IN ('per_unit', 'per_order')),

  -- HOW MANY UNITS QUALIFY. NULL = every unit in the cart.
  max_quantity INTEGER,

  -- The order must be at least this large for the rule to apply at all.
  min_subtotal_iqd INTEGER,

  -- FREE SHIPPING (free_shipping only). The threshold is compared against the
  -- basis named by `shippingPolicy.threshold_basis`, which already exists and
  -- already governs the current waivers — one definition, not two.
  -- `shipping_methods` is a JSON array of the checkout delivery-method ids the
  -- waiver covers ('standard', 'personal'); an empty array means none, and
  -- NULL means every method.
  free_shipping_threshold_iqd INTEGER,
  shipping_methods TEXT,
  -- A ceiling on the subsidy: with 15,000 here and a 25,000 fee, the member
  -- pays 10,000. NULL = the eligible fee is waived in full.
  max_shipping_subsidy_iqd INTEGER,

  -- COD TAX (cod_tax_exemption only). The tax is still calculated in full and
  -- still recorded; this waives it afterwards so the invoice can show both
  -- numbers and the reporting stays honest.
  cod_tax_exempt INTEGER CHECK (cod_tax_exempt IS NULL OR cod_tax_exempt IN (0, 1)),

  -- LIFECYCLE. `priority` breaks ties WITHIN one scope level; it never lets a
  -- global rule beat a product rule, because specificity is the outer sort.
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT,
  valid_until TEXT,

  -- Admin-facing only; never shown to a customer.
  label TEXT,
  notes TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);

-- The resolver's own query shape: tier + type + enabled, then specificity.
CREATE INDEX IF NOT EXISTS idx_benefit_rules_lookup
  ON membership_benefit_rules (tier, benefit_type, enabled);
CREATE INDEX IF NOT EXISTS idx_benefit_rules_product
  ON membership_benefit_rules (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_benefit_rules_category
  ON membership_benefit_rules (category_id) WHERE category_id IS NOT NULL;

-- ============================================================================
--  THE VERSION AN ORDER WAS PRICED UNDER
-- ============================================================================
-- Every write to the rules appends one row holding the WHOLE rule set as it
-- stood afterwards. An order stores that row's id, so "what was PRO worth on
-- the third of March" is answerable exactly, and an admin change tomorrow
-- cannot move a number on an invoice that has already been issued.
--
-- The full set rather than a diff because the question is always "what were
-- ALL the rules", and reconstructing that from diffs is a replay that can
-- drift. At a few kilobytes per change this is the cheap option.
CREATE TABLE IF NOT EXISTS membership_benefit_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  actor_user_id TEXT,
  -- What changed, for the admin's history view: 'create' | 'update' |
  -- 'delete' | 'seed', the rule it touched, and the row before and after.
  action TEXT NOT NULL,
  rule_id TEXT,
  before_json TEXT,
  after_json TEXT,
  -- The complete rule set at this version — what an order points at.
  rules_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_benefit_versions_created ON membership_benefit_versions (created_at DESC);

-- ============================================================================
--  WHAT AN ORDER REMEMBERS
-- ============================================================================
-- `orders.membership_tier_snapshot` already records the tier. These record what
-- that tier was WORTH on this order, so a receipt can show the benefit and a
-- report can total it without re-running a resolver against today's rules.
ALTER TABLE orders ADD COLUMN benefit_version_id INTEGER;
ALTER TABLE orders ADD COLUMN membership_discount_iqd INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN shipping_before_benefit_iqd INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN shipping_benefit_iqd INTEGER NOT NULL DEFAULT 0;
-- The tax as CALCULATED, beside the part the membership waived. Both, always:
-- an exemption that overwrites the tax with zero destroys the audit trail the
-- invoice and the COD reconciliation both depend on.
ALTER TABLE orders ADD COLUMN cod_tax_before_exemption_iqd INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN cod_tax_exemption_iqd INTEGER NOT NULL DEFAULT 0;
-- The resolved benefit as JSON — which rules fired, what each was worth, and
-- the basis each threshold was tested against.
ALTER TABLE orders ADD COLUMN benefit_snapshot TEXT;

-- Per line, so a mixed cart can show which item saved what.
ALTER TABLE order_items ADD COLUMN membership_discount_iqd INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN membership_rule_id TEXT;

-- ============================================================================
--  THE OWNER'S STARTING VALUES
-- ============================================================================
-- Seeded with fixed ids and INSERT OR IGNORE, so re-running the migration
-- changes nothing and an owner who has since edited a value keeps their edit.
--
-- ONLY THE SCOPE-FREE RULES ARE SEEDED, and the omission is deliberate rather
-- than incomplete. Free delivery and the COD tax exemption are properties of
-- the MEMBERSHIP: "PRO delivers free above 75,000 on standard and personal"
-- needs nothing from the catalogue and is true the moment it is written.
--
-- The product discounts are not, because every one of them names a section —
-- printers, filament, accessories — and a section is a row the owner created,
-- with an id this file cannot know. Seeding them globally instead would be
-- worse than seeding nothing: a global "PRO 10%" would quietly discount every
-- product in the store, including ones the owner never meant to discount, and
-- the first evidence would be a month of margins. The admin page offers the
-- brief's suggested values as a one-click starting point against sections the
-- owner picks, which is the same defaults arriving with their scope attached.

INSERT OR IGNORE INTO membership_benefit_rules
  (id, tier, benefit_type, scope, free_shipping_threshold_iqd, shipping_methods, enabled, priority, label)
VALUES
  ('seed-pro-free-shipping', 'pro', 'free_shipping', 'global', 75000, '["standard","personal"]', 1, 0,
   'PRO free delivery — standard and personal'),
  -- PREMIUM covers standard delivery only; personal delivery stays payable.
  ('seed-premium-free-shipping', 'prime', 'free_shipping', 'global', 100000, '["standard"]', 1, 0,
   'PREMIUM free delivery — standard only');

INSERT OR IGNORE INTO membership_benefit_rules
  (id, tier, benefit_type, scope, cod_tax_exempt, enabled, priority, label)
VALUES
  ('seed-pro-cod-exempt', 'pro', 'cod_tax_exemption', 'global', 1, 1, 0,
   'PRO — exempt from the cash-on-delivery tax'),
  -- Written as an explicit NOT-exempt row rather than left absent: "PREMIUM is
  -- not exempt" is a decision the owner made, and a row saying so is a thing
  -- they can find and change. An absence is just an absence.
  ('seed-premium-cod-exempt', 'prime', 'cod_tax_exemption', 'global', 0, 1, 0,
   'PREMIUM — cash-on-delivery tax applies');

-- The version an order placed before any admin edit points at.
INSERT OR IGNORE INTO membership_benefit_versions (id, action, rules_json)
VALUES (1, 'seed', '[]');
