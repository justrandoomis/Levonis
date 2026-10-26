-- One-time repair requested by the owner: previously saved procurement prices
-- could not publish while an empty sibling lacked pricing inputs. Snapshot only
-- those existing saves, never future drafts. The Worker uses the normal V2
-- evaluator/writer, and refuses if either sequence has changed since this snapshot.
CREATE TABLE IF NOT EXISTS pricing_received_recovery (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  inputs_seq INTEGER NOT NULL,
  write_seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'recovered', 'skipped')),
  reason TEXT,
  completed_at TEXT
);

INSERT OR IGNORE INTO pricing_received_recovery (product_id, inputs_seq, write_seq)
SELECT s.product_id, s.inputs_seq, s.write_seq
  FROM product_pricing_state s JOIN products p ON p.id = s.product_id
 WHERE s.mode = 'engine' AND s.pricing_method = 'cost' AND p.status = 'active'
   AND COALESCE(p.composition, '') = ''
   AND NOT EXISTS (SELECT 1 FROM pricing_v2_sku_results r WHERE r.product_id = p.id)
   AND EXISTS (SELECT 1 FROM audit_log a WHERE a.target = p.id AND a.action = 'pricing.v2.data_saved'
     AND a.id = (SELECT MAX(last.id) FROM audit_log last WHERE last.target = p.id AND last.action = 'pricing.v2.data_saved')
     AND json_valid(a.detail) AND json_extract(a.detail, '$.source') = 'product_pricing')
   AND EXISTS (SELECT 1 FROM inventory_lots l WHERE l.product_id = p.id AND l.qty_remaining > 0
     AND l.unit_cost_iqd IS NOT NULL
     AND l.scope = CASE p.inventory_mode WHEN 'OPTION' THEN 'option' WHEN 'COLOR' THEN 'color'
       WHEN 'VARIANT_COMBINATION' THEN 'variant' ELSE 'base' END );
