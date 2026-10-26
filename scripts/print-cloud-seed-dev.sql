-- ---------------------------------------------------------------------------
-- LEVONIS PRINT CLOUD — DEVELOPMENT SEED (docs/PRINT_CLOUD.md §13.3).
--
-- LOCAL DATABASES ONLY:
--   npx wrangler d1 migrations apply levonis-db --local
--   npx wrangler d1 execute levonis-db --local --file scripts/print-cloud-seed-dev.sql
--
-- Never run it against a deployed database: the serial numbers, costs and
-- prices below are illustrative examples from the brief, not the workshop's
-- real equipment or price list. Every id starts with `dev_` so a stray copy is
-- recognisable at a glance. Idempotent (INSERT OR IGNORE).
--
-- The stock is seeded THROUGH the ledger (a lot, its position and its
-- `receive` ledger row), so GET /api/admin/print-cloud/reconcile is clean on a
-- freshly seeded database.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO pc_settings (key, value_json, version, updated_by, updated_at) VALUES
  ('config', '{"enabled":true,"require_operator_approval":true}', 1, 'dev_seed', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO pc_credit_tiers (id, code, name_ar, name_en, name_ckb, hourly_rate_iqd, custom_hours_enabled, min_custom_seconds, custom_step_seconds, active, created_at, updated_at) VALUES
  ('dev_tier_x2d', 'x2d', 'ساعات X2D Combo', 'X2D Combo hours', 'کاتژمێرەکانی X2D Combo', 1500, 1, 3600, 3600, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_tier_h2d', 'h2d', 'ساعات H2D Combo', 'H2D Combo hours', 'کاتژمێرەکانی H2D Combo', 2000, 0, 3600, 3600, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_tier_a1', 'a1', 'ساعات A1 Combo', 'A1 Combo hours', 'کاتژمێرەکانی A1 Combo', 900, 1, 3600, 3600, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO pc_printer_models (id, tier_id, code, brand, model_name, build_x_mm, build_y_mm, build_z_mm, nozzle_options_um, extruder_config,
    ams_systems_json, max_colors, supported_materials_json, enclosed, camera, average_power_w, quality_rank, active, created_at, updated_at) VALUES
  ('dev_model_x2d', 'dev_tier_x2d', 'BBL-X2D-COMBO', 'Bambu Lab', 'X2D Combo', 256, 256, 256, '[400]', 'dual', '["AMS 2 Pro"]', 8, '["PLA","PETG","ABS","TPU"]', 1, 1, 350, 90, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_model_h2d', 'dev_tier_h2d', 'BBL-H2D-COMBO', 'Bambu Lab', 'H2D Combo', 325, 320, 325, '[400]', 'dual', '["AMS 2 Pro"]', 8, '["PLA","PETG","ABS","ASA","PA","TPU"]', 1, 1, 450, 95, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_model_a1', 'dev_tier_a1', 'BBL-A1-COMBO', 'Bambu Lab', 'A1 Combo', 256, 256, 256, '[400]', 'single', '["AMS lite"]', 4, '["PLA","PETG","TPU"]', 0, 1, 150, 70, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO pc_printers (id, model_id, name, serial_number, equipment_code, location, nozzle_um, ams_slots, materials_json, camera, status, adapter,
    acquisition_cost_iqd, expected_life_hours, residual_value_iqd, maintenance_reserve_iqd_per_hour, created_at, updated_at) VALUES
  ('dev_printer_x2d_1', 'dev_model_x2d', 'X2D #1', 'DEV-SN-X2D-0001', 'DEV-LEV-X2D-01', 'Bay A', 400, 4, '["PLA","PETG"]', 1, 'active', 'manual', 2400000, 10000, 400000, 100, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_printer_x2d_2', 'dev_model_x2d', 'X2D #2', 'DEV-SN-X2D-0002', 'DEV-LEV-X2D-02', 'Bay A', 400, 4, '["PLA","PETG"]', 1, 'active', 'manual', 2400000, 10000, 400000, 100, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_printer_a1_1', 'dev_model_a1', 'A1 #1', 'DEV-SN-A1-0001', 'DEV-LEV-A1-01', 'Bay B', 400, 4, '["PLA"]', 1, 'active', 'manual', 650000, 6000, 100000, 50, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO pc_credit_packages (id, tier_id, code, name_ar, name_en, name_ckb, kind, seconds, price_iqd, sort, active, created_at, updated_at) VALUES
  ('dev_pkg_x2d_6', 'dev_tier_x2d', 'x2d-6h', '6 ساعات', '6 hours', '6 کاتژمێر', 'standard', 21600, 10500, 6, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pkg_x2d_24', 'dev_tier_x2d', 'x2d-24h', '24 ساعة', '24 hours', '24 کاتژمێر', 'standard', 86400, 36000, 24, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pkg_x2d_48', 'dev_tier_x2d', 'x2d-48h', '48 ساعة', '48 hours', '48 کاتژمێر', 'standard', 172800, 68000, 48, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pkg_x2d_72', 'dev_tier_x2d', 'x2d-72h', '72 ساعة', '72 hours', '72 کاتژمێر', 'standard', 259200, 96000, 72, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pkg_a1_24', 'dev_tier_a1', 'a1-24h', '24 ساعة', '24 hours', '24 کاتژمێر', 'standard', 86400, 21000, 24, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO pc_products (id, category_code, brand, name_ar, name_en, name_ckb, material, grade, tags_json, active, created_at, updated_at) VALUES
  ('dev_prod_pla_basic', 'filaments', 'Bambu Lab', 'PLA أساسي', 'PLA Basic', 'PLA بنەڕەتی', 'PLA', 'Basic', '["pla"]', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_prod_pla_matte', 'filaments', 'Bambu Lab', 'PLA مطفي', 'PLA Matte', 'PLA بێ بریسکە', 'PLA', 'Matte', '["pla"]', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_prod_petg', 'filaments', 'Bambu Lab', 'PETG أساسي', 'PETG Basic', 'PETG بنەڕەتی', 'PETG', 'Basic', '["petg"]', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_prod_magnet', 'magnets', '', 'مغناطيس نيوديميوم', 'Neodymium magnets', 'موگناتیسی نیۆدیمیۆم', NULL, NULL, '[]', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_prod_ring', 'keychain_rings', '', 'حلقات ميدالية', 'Keychain rings', 'ئەڵقەی کلیلدان', NULL, NULL, '[]', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_prod_nfc', 'nfc', '', 'شرائح NFC', 'NFC tags', 'تاگی NFC', NULL, NULL, '[]', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO pc_variants (id, product_id, sku, name_ar, name_en, name_ckb, color_name, color_hex, diameter_um, unit_code, min_purchase_qty, purchase_step_qty,
    max_purchase_qty, low_stock_threshold_qty, active, created_at, updated_at) VALUES
  ('dev_var_pla_white', 'dev_prod_pla_basic', 'DEV-PLA-BASIC-COLDWHITE', 'PLA أبيض بارد', 'PLA Basic Cold White', 'PLA سپی سارد', 'Cold White', '#F4F7FA', 1750, 'g', 100, 10, 5000, 2000, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_var_pla_black', 'dev_prod_pla_matte', 'DEV-PLA-MATTE-BLACK', 'PLA أسود مطفي', 'PLA Matte Black', 'PLA ڕەشی بێ بریسکە', 'Black', '#1B1B1B', 1750, 'g', 100, 10, 5000, 2000, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_var_petg_blue', 'dev_prod_petg', 'DEV-PETG-BLUE', 'PETG أزرق', 'PETG Blue', 'PETG شین', 'Blue', '#1F5BB5', 1750, 'g', 100, 10, 5000, 2000, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_var_magnet_8x3', 'dev_prod_magnet', 'DEV-MAG-8X3', 'مغناطيس 8×3 مم', '8×3 mm magnet', 'موگناتیسی 8×3 ملم', '', '', NULL, 'pc', 1, 1, 1000, 100, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_var_ring_25', 'dev_prod_ring', 'DEV-RING-25', 'حلقة ميدالية 25 مم', 'Keychain ring 25 mm', 'ئەڵقەی کلیلدان 25 ملم', '', '', NULL, 'pc', 1, 1, 1000, 100, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_var_nfc_ntag215', 'dev_prod_nfc', 'DEV-NFC-NTAG215', 'شريحة NTAG215', 'NTAG215 tag', 'تاگی NTAG215', '', '', NULL, 'pc', 1, 1, 500, 20, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO pc_price_tiers (id, variant_id, mode, min_qty, pack_price_iqd, unit_price_milli_iqd, active, created_at, updated_at) VALUES
  ('dev_pt_w_100', 'dev_var_pla_white', 'pack', 100, 3500, NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pt_w_250', 'dev_var_pla_white', 'pack', 250, 8000, NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pt_w_500', 'dev_var_pla_white', 'pack', 500, 14500, NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pt_w_1000', 'dev_var_pla_white', 'pack', 1000, 24250, NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pt_w_b100', 'dev_var_pla_white', 'bracket', 100, NULL, 35000, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pt_w_b250', 'dev_var_pla_white', 'bracket', 250, NULL, 32000, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pt_w_b500', 'dev_var_pla_white', 'bracket', 500, NULL, 29000, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pt_w_b1000', 'dev_var_pla_white', 'bracket', 1000, NULL, 24250, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pt_k_250', 'dev_var_pla_black', 'pack', 250, 9000, NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pt_k_1000', 'dev_var_pla_black', 'pack', 1000, 27000, NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pt_k_b100', 'dev_var_pla_black', 'bracket', 100, NULL, 38000, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pt_p_1000', 'dev_var_petg_blue', 'pack', 1000, 26000, NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pt_p_b100', 'dev_var_petg_blue', 'bracket', 100, NULL, 36000, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pt_m_b1', 'dev_var_magnet_8x3', 'bracket', 1, NULL, 250000, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pt_m_10', 'dev_var_magnet_8x3', 'pack', 10, 2000, NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pt_r_b1', 'dev_var_ring_25', 'bracket', 1, NULL, 300000, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('dev_pt_n_b1', 'dev_var_nfc_ntag215', 'bracket', 1, NULL, 750000, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

-- Physical stock, through the ledger: lot → position → `receive` row.
INSERT OR IGNORE INTO pc_stock_lots (id, variant_id, lot_code, supplier, received_qty, on_hand_qty, unit_cost_milli_iqd, total_cost_iqd, received_at, received_by, notes) VALUES
  ('dev_lot_w', 'dev_var_pla_white', 'DEV-LOT-W1', 'example supplier', 20000, 20000, 20000, 400000, '2026-01-01T00:00:00.000Z', 'dev_seed', 'development seed'),
  ('dev_lot_k', 'dev_var_pla_black', 'DEV-LOT-K1', 'example supplier', 10000, 10000, 21000, 210000, '2026-01-01T00:00:00.000Z', 'dev_seed', 'development seed'),
  ('dev_lot_p', 'dev_var_petg_blue', 'DEV-LOT-P1', 'example supplier', 5000, 5000, 20000, 100000, '2026-01-01T00:00:00.000Z', 'dev_seed', 'development seed'),
  ('dev_lot_m', 'dev_var_magnet_8x3', 'DEV-LOT-M1', 'example supplier', 500, 500, 100000, 50000, '2026-01-01T00:00:00.000Z', 'dev_seed', 'development seed'),
  ('dev_lot_r', 'dev_var_ring_25', 'DEV-LOT-R1', 'example supplier', 300, 300, 100000, 30000, '2026-01-01T00:00:00.000Z', 'dev_seed', 'development seed'),
  ('dev_lot_n', 'dev_var_nfc_ntag215', 'DEV-LOT-N1', 'example supplier', 100, 100, 300000, 30000, '2026-01-01T00:00:00.000Z', 'dev_seed', 'development seed');

INSERT OR IGNORE INTO pc_stock_positions (variant_id, on_hand_qty, reserved_qty, allocated_qty, updated_at) VALUES
  ('dev_var_pla_white', 20000, 0, 0, '2026-01-01T00:00:00.000Z'),
  ('dev_var_pla_black', 10000, 0, 0, '2026-01-01T00:00:00.000Z'),
  ('dev_var_petg_blue', 5000, 0, 0, '2026-01-01T00:00:00.000Z'),
  ('dev_var_magnet_8x3', 500, 0, 0, '2026-01-01T00:00:00.000Z'),
  ('dev_var_ring_25', 300, 0, 0, '2026-01-01T00:00:00.000Z'),
  ('dev_var_nfc_ntag215', 100, 0, 0, '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO pc_warehouse_ledger (id, entry_key, variant_id, lot_id, entry_type, delta_on_hand, delta_reserved, delta_allocated, cost_iqd, reason, actor_id, created_at) VALUES
  ('dev_wl_w', 'receive:dev_lot_w', 'dev_var_pla_white', 'dev_lot_w', 'receive', 20000, 0, 0, 400000, 'development seed', 'dev_seed', '2026-01-01T00:00:00.000Z'),
  ('dev_wl_k', 'receive:dev_lot_k', 'dev_var_pla_black', 'dev_lot_k', 'receive', 10000, 0, 0, 210000, 'development seed', 'dev_seed', '2026-01-01T00:00:00.000Z'),
  ('dev_wl_p', 'receive:dev_lot_p', 'dev_var_petg_blue', 'dev_lot_p', 'receive', 5000, 0, 0, 100000, 'development seed', 'dev_seed', '2026-01-01T00:00:00.000Z'),
  ('dev_wl_m', 'receive:dev_lot_m', 'dev_var_magnet_8x3', 'dev_lot_m', 'receive', 500, 0, 0, 50000, 'development seed', 'dev_seed', '2026-01-01T00:00:00.000Z'),
  ('dev_wl_r', 'receive:dev_lot_r', 'dev_var_ring_25', 'dev_lot_r', 'receive', 300, 0, 0, 30000, 'development seed', 'dev_seed', '2026-01-01T00:00:00.000Z'),
  ('dev_wl_n', 'receive:dev_lot_n', 'dev_var_nfc_ntag215', 'dev_lot_n', 'receive', 100, 0, 0, 30000, 'development seed', 'dev_seed', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO pc_accessory_rules (id, keyword, project_type, variant_id, qty_per_item, needs_pause_at_layer, note_ar, note_en, note_ckb, active, created_at) VALUES
  ('dev_rule_keychain', 'keychain', '', 'dev_var_ring_25', 1, 0, 'ركّب حلقة لكل ميدالية', 'Attach one ring per keychain', 'بۆ هەر کلیلدانێک ئەڵقەیەک دابنێ', 1, '2026-01-01T00:00:00.000Z'),
  ('dev_rule_magnetic', '', 'magnetic', 'dev_var_magnet_8x3', 2, 1, 'أدخل مغناطيسين عند طبقة التوقف', 'Insert two magnets at the pause layer', 'لە چینی وەستاندندا دوو موگناتیس دابنێ', 1, '2026-01-01T00:00:00.000Z'),
  ('dev_rule_nfc', 'nfc', 'nfc', 'dev_var_nfc_ntag215', 1, 1, 'أدخل الشريحة عند طبقة التوقف', 'Insert the tag at the pause layer', 'لە چینی وەستاندندا تاگەکە دابنێ', 1, '2026-01-01T00:00:00.000Z');
