-- PRINTER SERVICES — «خصص طابعتك» (the owner, 2026-11-17; DECISIONS row 339).
--
-- (1) THE CHOICE ON THE LINE. A printer line in the cart carries the customer's confirmed choice
--     of services (warranty none/12/24 months total, Levo Care, packaging, pre-dispatch inspection, Academy, delivery
--     preference) as canonical JSON in `services`. '' = no choice (every line that is not an enrolled printer). Like the
--     legacy warranty_plan_id it is an attribute of the line, not part of its identity: the same printer added again with
--     a different choice is refused, never merged.
-- (2) THE FROZEN RESULT. order_items.services_snapshot freezes the priced choice at checkout (each service's fee, the
--     warranty and Care months, the policy versions, the price-list revision, the delivery class). NULL = a line sold
--     without the services (every order before this one and every unenrolled product). It is never rewritten.
-- (3) THE WAREHOUSE'S WORK. order_service_tasks holds what staff must do for a line: the packaging instruction (always,
--     for an enrolled printer — standard or extra), the inspection (blocks dispatch until done), the live Academy session
--     request. Written in the order's own batch; a task is completed once, with the staff member and time.
-- Quick buy («اشترِ الآن») does not sell an enrolled printer in this round: its line resolver finds no choice and refuses
-- (SERVICES_REQUIRED), and the page sends such a printer through the cart instead.
-- Additive. RE-RUNNABLE as this repo's rules allow: D1's bookkeeping runs a file once, and
-- scripts/migrate-check.mjs --twice leaves ALTER TABLE ADD COLUMN to that bookkeeping.
ALTER TABLE cart_items ADD COLUMN services TEXT NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN services_snapshot TEXT;

CREATE TABLE IF NOT EXISTS order_service_tasks (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  order_item_id TEXT NOT NULL REFERENCES order_items(id),
  kind TEXT NOT NULL CHECK (kind IN ('packaging', 'inspection', 'academy')),
  -- packaging: 'standard' | 'extra'; inspection: 'full'; academy: 'live_whatsapp' | 'live_in_person'
  choice TEXT NOT NULL,
  -- How many printers of the line the task covers: ONE task per line and kind, while the services are bought per unit,
  -- so staff pack / inspect / teach `qty` printers (the note says «×N» too).
  qty INTEGER NOT NULL DEFAULT 1 CHECK (qty >= 1),
  -- Readable instruction for the packing screen and the printout (Arabic, as staff read it).
  note TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  -- Inspection: what staff found; Academy: the agreed appointment, in words.
  result_note TEXT,
  done_by TEXT REFERENCES users(id),
  done_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((status = 'done') = (done_by IS NOT NULL AND done_at IS NOT NULL)),
  UNIQUE (order_item_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_order_service_tasks_order ON order_service_tasks(order_id);
CREATE INDEX IF NOT EXISTS idx_order_service_tasks_open ON order_service_tasks(kind, status) WHERE status = 'open';

-- A finished task is a record: it is never reopened or edited (a wrong result is corrected by a new note on the order).
CREATE TRIGGER IF NOT EXISTS trg_order_service_tasks_done_final
BEFORE UPDATE ON order_service_tasks
WHEN OLD.status = 'done'
BEGIN
  SELECT RAISE(ABORT, 'ORDER_SERVICE_TASK_DONE');
END;

-- «الفحص قبل الشحن» (owner ruling 2026-11-17): while an inspection bought on the order is open, the order does not reach
-- the courier — not to «في الطريق إليك», not straight to «تم التوصيل», not a courier booking — whatever door moves it
-- (the stage door forced or not, the courier sync, the legacy status dropdown). A direct order's legacy 'shipped' IS its
-- hand-over (stageForLegacyStatus); a pre-order's 'shipped' is the freight leg, which stays open. The worker checks first
-- (INSPECTION_NOT_DONE); this is the same rule inside the write, modelled on trg_orders_price_estimate_gate (0218).
CREATE TRIGGER IF NOT EXISTS trg_orders_inspection_gate BEFORE UPDATE OF status, stage, delivery_remote_id ON orders
FOR EACH ROW
WHEN ((NEW.stage IS NOT OLD.stage AND NEW.stage IN ('out_for_delivery','delivered'))
   OR (NEW.status IS NOT OLD.status AND (NEW.status = 'delivered' OR (NEW.status = 'shipped' AND NEW.shipping_type = 'direct')))
   OR (NEW.delivery_remote_id IS NOT OLD.delivery_remote_id AND NEW.delivery_remote_id <> ''))
 AND EXISTS (SELECT 1 FROM order_service_tasks t WHERE t.order_id = NEW.id AND t.kind = 'inspection' AND t.status = 'open')
BEGIN
  SELECT RAISE(ABORT, 'INSPECTION_NOT_DONE');
END;
