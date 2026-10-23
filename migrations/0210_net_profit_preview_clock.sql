-- Coupons/credits and monthly promotion now affect participant entitlements.
-- A wage preview made before one changes must be reviewed again, including
-- when the preview spans several pages. No existing amounts are rewritten.
CREATE TRIGGER IF NOT EXISTS finance_clock_price_protection_claims_insert AFTER INSERT ON price_protection_claims
BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS finance_clock_price_protection_claims_update AFTER UPDATE ON price_protection_claims
BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS finance_clock_price_protection_claims_delete AFTER DELETE ON price_protection_claims
BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS finance_clock_monthly_promotions_insert AFTER INSERT ON finance_monthly_promotions
BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS finance_clock_monthly_promotions_update AFTER UPDATE ON finance_monthly_promotions
BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS finance_clock_monthly_promotions_delete AFTER DELETE ON finance_monthly_promotions
BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS finance_clock_trade_in_stock_insert AFTER INSERT ON trade_in_stock
BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS finance_clock_trade_in_credit_reissues_insert AFTER INSERT ON trade_in_credit_reissues
BEGIN UPDATE finance_mutation_clock SET version=version+1 WHERE id=1; END;
