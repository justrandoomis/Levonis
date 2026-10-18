-- 0201 — «إدارة التوصيل»: THE STORE'S DELIVERY POLICY (owner decisions 2026-10-18, DECISIONS row 250;
-- packages/shipping/src/storeDelivery.ts)
--
-- DATA ONLY, NO SCHEMA CHANGE. One admin_settings document, `deliveryPolicy`, prices standard delivery:
-- a default price for the whole order (5,000, unlimited pieces), per-governorate exceptions (none at
-- the start) and rule groups by section / product, each flat / per piece / per block of N / not
-- delivered. The most specific group wins for a line (product > sub-section > section > default); the
-- order pays the SUM of the groups present and the default only when no group is present.
--
-- (a) THE OWNER'S STARTING RULES, seeded active:
--     g_printers        10,000 per piece on the highest printer catalogs (the live `is_printer_catalog`
--                       flag, the same fact the 10,000 printer tariff used) that hold NO non-printer
--                       sub-section — so «الليزر» itself, which also holds the laser accessories, is not
--                       taken whole: cat_printers (FDM, resin), cat_laser_machines, cat_used_printers.
--     g_printers_large  25,000 per piece: H2S and H2D, product exceptions inside the printers.
--     g_filament        5,000 per block of 10 pieces on cat_materials_fdm.
--     g_stopped         «لا يُوصَّل»: every product whose old per-product standard delivery was disabled.
--     A target that does not exist on this database leaves its group empty; the reader drops an empty
--     group, so it is inert.
--     `json(...)` around each scalar subquery is required: a subquery loses SQLite's JSON subtype and the
--     arrays would otherwise be stored as strings.
-- (b) The retired per-product field `ops_policy.delivery_options` is cleared (its stop moved into
--     g_stopped above; its fee and step were personal-only, and personal delivery is gone).
-- (c) category_delivery_rules (0135) is neither dropped nor converted: it has no reader and no writer
--     now, and its rows were personal-only, so no live fee came from it. A later migration drops it.
--
-- IDEMPOTENT (migrate-check --twice): INSERT OR IGNORE keeps an existing document, and the UPDATE matches
-- nothing the second time. An older Worker ignores the new key; a newer Worker on a database without it
-- reads the code fallback, which is the pre-policy tariff.

INSERT OR IGNORE INTO admin_settings (key, value)
SELECT 'deliveryPolicy', json_object(
  'version', 1,
  'default_fee_iqd', 5000,
  'governorates', json('{}'),
  'updated_at', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
  'updated_by', 'migration:0201',
  'groups', json_array(
    json_object(
      'id', 'g_printers',
      'name', json_object('ar', 'الطابعات', 'en', 'Printers', 'ckb', 'پرینتەرەکان'),
      'enabled', json('true'), 'mode', 'per_piece', 'fee_iqd', 10000, 'block_size', 1,
      'product_ids', json('[]'),
      'catalog_ids', json((SELECT json_group_array(c.id) FROM catalogs c
                            WHERE c.is_printer_catalog = 1
                              AND NOT EXISTS (SELECT 1 FROM catalogs k WHERE k.parent_id = c.id AND k.is_printer_catalog = 0)
                              AND NOT EXISTS (SELECT 1 FROM catalogs p WHERE p.id = c.parent_id AND p.is_printer_catalog = 1
                                                AND NOT EXISTS (SELECT 1 FROM catalogs k2 WHERE k2.parent_id = p.id AND k2.is_printer_catalog = 0))))
    ),
    json_object(
      'id', 'g_printers_large',
      'name', json_object('ar', 'الطابعات الكبيرة', 'en', 'Large printers', 'ckb', 'پرینتەرە گەورەکان'),
      'enabled', json('true'), 'mode', 'per_piece', 'fee_iqd', 25000, 'block_size', 1,
      'catalog_ids', json('[]'),
      'product_ids', json((SELECT json_group_array(id) FROM products
                            WHERE id IN ('prd_65182590e9284a97a3e2' /* H2S */, 'prd_7387063972434aab9f92' /* H2D */)))
    ),
    json_object(
      'id', 'g_filament',
      'name', json_object('ar', 'الفلمنت', 'en', 'Filament', 'ckb', 'فیلامێنت'),
      'enabled', json('true'), 'mode', 'per_block', 'fee_iqd', 5000, 'block_size', 10,
      'product_ids', json('[]'),
      'catalog_ids', json((SELECT json_group_array(id) FROM catalogs WHERE id = 'cat_materials_fdm'))
    ),
    json_object(
      'id', 'g_stopped',
      'name', json_object('ar', 'لا يُوصَّل', 'en', 'Not delivered', 'ckb', 'ناگەیەنرێت'),
      'enabled', json('true'), 'mode', 'stopped', 'fee_iqd', 0, 'block_size', 1,
      'catalog_ids', json('[]'),
      'product_ids', json((SELECT json_group_array(id) FROM products
                            WHERE (CASE WHEN json_valid(ops_policy)
                                        THEN json_extract(ops_policy, '$.delivery_options.standard.enabled') END ) = 0))
    )
  )
);

UPDATE products
   SET ops_policy = json_remove(ops_policy, '$.delivery_options')
 WHERE (CASE WHEN json_valid(ops_policy) THEN json_type(ops_policy, '$.delivery_options') END ) IS NOT NULL;
