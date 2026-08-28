-- Levonis migration 0008 — commerce extras building on 0003.
-- NONDESTRUCTIVE: ADD COLUMN / CREATE INDEX only.
--
-- 1) order_items.option_id / color_id — checkout persists the EXACT selected
--    variant ids (0001 only stored a human-readable option_snapshot label).
--    Price protection (§6.8) must compare the SAME product/option/color the
--    buyer purchased against price_history/current prices; a display label
--    cannot do that reliably. Old rows keep '' and are handled honestly
--    (claims on label-only legacy variants are routed to support).
-- 2) Indexes for the returns/price-protection queues.

ALTER TABLE order_items ADD COLUMN option_id TEXT NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN color_id TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_return_cases_order ON return_cases(order_id);
CREATE INDEX idx_return_cases_item ON return_cases(order_item_id);
CREATE INDEX idx_ppc_user ON price_protection_claims(user_id, state);
