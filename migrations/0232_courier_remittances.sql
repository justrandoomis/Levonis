-- MONEY WITH THE COURIER (the owner's brief, 2026-11-12, part 3; DECISIONS row 332).
--
-- Al-Zaeem collects the cash at the door and transfers it, less its fee, in one transfer for many parcels. A transfer is
-- recorded here as a remittance: what arrived, on which day, under which reference, and the parcels it paid, each with
-- the cash collected and the fee Al-Zaeem kept. Each parcel's collection is an ordinary finance_collections row with its
-- own journal entry, written in the same batch, so every report that already reads collections sees it.
--   - state 'received': the money arrived; 'reconciled': the owner checked it against Al-Zaeem's own statement.
--   - kind 'opening': the one-time entry for parcels Al-Zaeem paid before the site tracked transfers.
--   - difference_iqd = what arrived − (collected − fees); never hidden: a transfer with one carries a note, and the
--     difference is booked against the courier-fee account in its own journal entry.
-- Append-only: a recorded transfer and its parcels never change, except the state moving once to 'reconciled'.
-- Additive and re-runnable: two new tables, never read by older code.
CREATE TABLE IF NOT EXISTS courier_remittances (
  id TEXT PRIMARY KEY,
  courier TEXT NOT NULL DEFAULT 'alzaeem' CHECK(courier IN ('alzaeem')),
  kind TEXT NOT NULL DEFAULT 'transfer' CHECK(kind IN ('transfer','opening')),
  reference TEXT NOT NULL DEFAULT '',
  received_day TEXT NOT NULL CHECK(received_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  amount_iqd INTEGER NOT NULL CHECK(amount_iqd>=0),
  collected_iqd INTEGER NOT NULL CHECK(collected_iqd>0),
  fee_iqd INTEGER NOT NULL CHECK(fee_iqd>=0),
  difference_iqd INTEGER NOT NULL,
  parcels INTEGER NOT NULL CHECK(parcels>0),
  state TEXT NOT NULL DEFAULT 'received' CHECK(state IN ('received','reconciled')),
  note TEXT NOT NULL DEFAULT '',
  request_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(request_json)),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  reconciled_by TEXT REFERENCES users(id),
  reconciled_at TEXT,
  reconcile_note TEXT NOT NULL DEFAULT '',
  CHECK(difference_iqd = amount_iqd - (collected_iqd - fee_iqd)),
  CHECK((state = 'reconciled') = (reconciled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_courier_remittances_day ON courier_remittances(received_day, id);
CREATE TABLE IF NOT EXISTS courier_remittance_orders (
  remittance_id TEXT NOT NULL REFERENCES courier_remittances(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  collection_id TEXT NOT NULL UNIQUE REFERENCES finance_collections(id),
  collected_iqd INTEGER NOT NULL CHECK(collected_iqd>0),
  fee_iqd INTEGER NOT NULL CHECK(fee_iqd>=0 AND fee_iqd<=collected_iqd),
  PRIMARY KEY (remittance_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_courier_remittance_orders_order ON courier_remittance_orders(order_id);
CREATE TRIGGER IF NOT EXISTS courier_remittance_terms_immutable
BEFORE UPDATE OF id, courier, kind, reference, received_day, amount_iqd, collected_iqd, fee_iqd, difference_iqd, parcels, note, request_json, created_by, created_at
ON courier_remittances BEGIN SELECT RAISE(ABORT, 'Courier remittance immutable'); END;
CREATE TRIGGER IF NOT EXISTS courier_remittance_reconciled_final
BEFORE UPDATE OF state, reconciled_by, reconciled_at, reconcile_note ON courier_remittances WHEN OLD.state = 'reconciled'
BEGIN SELECT RAISE(ABORT, 'Courier remittance already reconciled'); END;
CREATE TRIGGER IF NOT EXISTS courier_remittance_no_delete
BEFORE DELETE ON courier_remittances BEGIN SELECT RAISE(ABORT, 'Courier remittance immutable'); END;
CREATE TRIGGER IF NOT EXISTS courier_remittance_order_immutable
BEFORE UPDATE ON courier_remittance_orders BEGIN SELECT RAISE(ABORT, 'Courier remittance parcel immutable'); END;
CREATE TRIGGER IF NOT EXISTS courier_remittance_order_no_delete
BEFORE DELETE ON courier_remittance_orders BEGIN SELECT RAISE(ABORT, 'Courier remittance parcel immutable'); END;
