-- Principal is allocated once to physical receipt units. This is distinct
-- from both the agreed profit percentage and the displayed funding ratio.
CREATE TABLE IF NOT EXISTS purchase_investor_lot_capital (
 lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
 contract_id TEXT NOT NULL REFERENCES investment_contracts(id),
 unit_principal_iqd INTEGER NOT NULL CHECK(unit_principal_iqd>=0),
 qty INTEGER NOT NULL CHECK(qty>0),
 PRIMARY KEY(lot_id,contract_id)
);
CREATE TRIGGER IF NOT EXISTS purchase_investor_lot_capital_immutable BEFORE UPDATE ON purchase_investor_lot_capital BEGIN SELECT RAISE(ABORT,'Lot principal immutable'); END;
CREATE TRIGGER IF NOT EXISTS purchase_investor_lot_capital_no_delete BEFORE DELETE ON purchase_investor_lot_capital BEGIN SELECT RAISE(ABORT,'Lot principal immutable'); END;
