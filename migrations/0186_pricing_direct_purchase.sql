-- Private, channel-specific stock purchase inputs. Ordinary pricing_inputs and
-- pricing_rules keep their preorder basis. Existing owner/engine tokens and
-- inputs_seq fences protect this store just like the ordinary input store.
CREATE TABLE IF NOT EXISTS pricing_direct_purchase (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS pricing_direct_purchase_insert_owner
BEFORE INSERT ON pricing_direct_purchase
WHEN NOT EXISTS (SELECT 1 FROM ops_guards WHERE id = 'pricing-input-owner:' || NEW.product_id)
BEGIN SELECT RAISE(ABORT, 'pricing_owner_required'); END;
CREATE TRIGGER IF NOT EXISTS pricing_direct_purchase_update_owner
BEFORE UPDATE ON pricing_direct_purchase
WHEN NOT EXISTS (SELECT 1 FROM ops_guards WHERE id = 'pricing-input-owner:' || NEW.product_id)
BEGIN SELECT RAISE(ABORT, 'pricing_owner_required'); END;
CREATE TRIGGER IF NOT EXISTS pricing_direct_purchase_insert_seq
AFTER INSERT ON pricing_direct_purchase
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id = NEW.product_id; END;
CREATE TRIGGER IF NOT EXISTS pricing_direct_purchase_update_seq
AFTER UPDATE ON pricing_direct_purchase
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id = NEW.product_id; END;
CREATE TRIGGER IF NOT EXISTS pricing_direct_purchase_delete_owner
BEFORE DELETE ON pricing_direct_purchase
WHEN EXISTS (SELECT 1 FROM products WHERE id = OLD.product_id)
 AND NOT EXISTS (SELECT 1 FROM ops_guards WHERE id = 'pricing-input-owner:' || OLD.product_id)
BEGIN SELECT RAISE(ABORT, 'pricing_owner_required'); END;
CREATE TRIGGER IF NOT EXISTS pricing_direct_purchase_delete_seq
AFTER DELETE ON pricing_direct_purchase
BEGIN UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1 WHERE product_id = OLD.product_id; END;
