-- MONEY WITH THE COURIER, SECOND ROUND (the owner, 2026-11-13; DECISIONS row 338).
--
-- (1) A PREPAID PARCEL'S FEE. A parcel paid before delivery has no cash at the door, yet Al-Zaeem keeps its fee from a
--     transfer. courier_remittance_fees holds that fee on the transfer — one row per order among live transfers — with the
--     expense that carries it, linked to the order so the order's profit counts it. A fee of 0 marks a prepaid parcel
--     settled with no fee (an old one the opening clears) and writes no expense.
-- (2) UNDO. A transfer recorded by mistake and not yet checked against the courier's statement can be undone, once, with a
--     reason (courier_remittance_voids). Its parcels go back to the courier: their collections and fee rows go, their
--     expenses are voided and their journal entries reversed on the transfer's day. courier_remittance_undone keeps each
--     undone parcel and fee as it was and locks the voided expenses: never restored or edited, because a restore would
--     count a fee twice once the parcels are recorded again. A checked transfer is never undone, an undone one is never
--     checked, and an undo is final.
-- Additive and re-runnable: three new tables, their triggers, and 0232's parcel trigger re-created with the undo's exception.
CREATE TABLE IF NOT EXISTS courier_remittance_fees (
  remittance_id TEXT NOT NULL REFERENCES courier_remittances(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  fee_iqd INTEGER NOT NULL CHECK(fee_iqd>=0),
  expense_id TEXT UNIQUE REFERENCES operating_expenses(id),
  CHECK((fee_iqd = 0) = (expense_id IS NULL)),
  PRIMARY KEY (remittance_id, order_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_courier_remittance_fees_order ON courier_remittance_fees(order_id);
CREATE TABLE IF NOT EXISTS courier_remittance_voids (
  remittance_id TEXT PRIMARY KEY REFERENCES courier_remittances(id),
  reason TEXT NOT NULL CHECK(length(trim(reason))>0),
  actor_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS courier_remittance_undone (
  remittance_id TEXT NOT NULL REFERENCES courier_remittance_voids(remittance_id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL CHECK(kind IN ('cash','fee')),
  collected_iqd INTEGER NOT NULL CHECK(collected_iqd>=0),
  fee_iqd INTEGER NOT NULL CHECK(fee_iqd>=0),
  collection_id TEXT,
  expense_id TEXT UNIQUE REFERENCES operating_expenses(id),
  PRIMARY KEY (remittance_id, order_id)
);
-- A live transfer's parcels and fees never change; an undone transfer's may go, and nothing else's.
DROP TRIGGER IF EXISTS courier_remittance_order_no_delete;
CREATE TRIGGER IF NOT EXISTS courier_remittance_order_no_delete
BEFORE DELETE ON courier_remittance_orders
WHEN NOT EXISTS (SELECT 1 FROM courier_remittance_voids v WHERE v.remittance_id = OLD.remittance_id)
BEGIN SELECT RAISE(ABORT, 'Courier remittance parcel immutable'); END;
CREATE TRIGGER IF NOT EXISTS courier_remittance_fee_immutable
BEFORE UPDATE ON courier_remittance_fees BEGIN SELECT RAISE(ABORT, 'Courier remittance fee immutable'); END;
CREATE TRIGGER IF NOT EXISTS courier_remittance_fee_no_delete
BEFORE DELETE ON courier_remittance_fees
WHEN NOT EXISTS (SELECT 1 FROM courier_remittance_voids v WHERE v.remittance_id = OLD.remittance_id)
BEGIN SELECT RAISE(ABORT, 'Courier remittance fee immutable'); END;
-- A prepaid parcel's fee expense belongs to its transfer, and an undone one stays voided: neither is edited, restored,
-- deleted or moved to another order on its own.
CREATE TRIGGER IF NOT EXISTS courier_fee_expense_update
BEFORE UPDATE ON operating_expenses
WHEN EXISTS (SELECT 1 FROM courier_remittance_fees f WHERE f.expense_id = OLD.id)
  OR EXISTS (SELECT 1 FROM courier_remittance_undone u WHERE u.expense_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'Correct the source operation'); END;
CREATE TRIGGER IF NOT EXISTS courier_fee_expense_delete
BEFORE DELETE ON operating_expenses
WHEN EXISTS (SELECT 1 FROM courier_remittance_fees f WHERE f.expense_id = OLD.id)
  OR EXISTS (SELECT 1 FROM courier_remittance_undone u WHERE u.expense_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'Correct the source operation'); END;
CREATE TRIGGER IF NOT EXISTS courier_fee_expense_link_update
BEFORE UPDATE ON finance_expense_links
WHEN EXISTS (SELECT 1 FROM courier_remittance_fees f WHERE f.expense_id = OLD.expense_id)
  OR EXISTS (SELECT 1 FROM courier_remittance_undone u WHERE u.expense_id = OLD.expense_id)
BEGIN SELECT RAISE(ABORT, 'Correct the source operation'); END;
CREATE TRIGGER IF NOT EXISTS courier_fee_expense_link_delete
BEFORE DELETE ON finance_expense_links
WHEN EXISTS (SELECT 1 FROM courier_remittance_fees f WHERE f.expense_id = OLD.expense_id)
  OR EXISTS (SELECT 1 FROM courier_remittance_undone u WHERE u.expense_id = OLD.expense_id)
BEGIN SELECT RAISE(ABORT, 'Correct the source operation'); END;
-- A checked transfer is never undone; an undone one is never checked; an undo and what it kept are final.
CREATE TRIGGER IF NOT EXISTS courier_remittance_void_unreconciled
BEFORE INSERT ON courier_remittance_voids
WHEN EXISTS (SELECT 1 FROM courier_remittances r WHERE r.id = NEW.remittance_id AND r.state = 'reconciled')
BEGIN SELECT RAISE(ABORT, 'A reconciled courier remittance cannot be undone'); END;
CREATE TRIGGER IF NOT EXISTS courier_remittance_reconcile_not_void
BEFORE UPDATE OF state ON courier_remittances
WHEN NEW.state = 'reconciled' AND EXISTS (SELECT 1 FROM courier_remittance_voids v WHERE v.remittance_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'An undone courier remittance cannot be reconciled'); END;
CREATE TRIGGER IF NOT EXISTS courier_remittance_void_final
BEFORE UPDATE ON courier_remittance_voids BEGIN SELECT RAISE(ABORT, 'Courier remittance undo is final'); END;
CREATE TRIGGER IF NOT EXISTS courier_remittance_void_no_delete
BEFORE DELETE ON courier_remittance_voids BEGIN SELECT RAISE(ABORT, 'Courier remittance undo is final'); END;
CREATE TRIGGER IF NOT EXISTS courier_remittance_undone_final
BEFORE UPDATE ON courier_remittance_undone BEGIN SELECT RAISE(ABORT, 'Courier remittance undo is final'); END;
CREATE TRIGGER IF NOT EXISTS courier_remittance_undone_no_delete
BEFORE DELETE ON courier_remittance_undone BEGIN SELECT RAISE(ABORT, 'Courier remittance undo is final'); END;
