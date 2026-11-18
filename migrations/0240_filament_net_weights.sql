-- ============================================================================
--  0240 — FILAMENT NET WEIGHTS FOR THE PRINT CALCULATOR (data only)
-- ============================================================================
-- The owner, 2026-11-18: «i need to synch the materails of fdm to calculator,
-- so price will atumaticcaly calcualte», and chose «Bambu official specs» for
-- the weights (DECISIONS row 356). The print calculator prices a material per
-- kilo from the shop's own spool: price ÷ `spec_fields.net_weight`. Without a
-- net weight a spool cannot price anything.
--
-- EVERY VALUE IS BAMBU LAB'S OWN SPOOL SIZE, read from the product's page on
-- us.store.bambulab.com (the URL is above each statement). PA6-CF, PAHT-CF and
-- PET-CF are sold there as 0.5 kg and 1 kg; the owner said the shop's price is
-- for 1 kg. Support spools, PETG HF (no price yet) and the multi-spool sets are
-- left alone.
--
-- NONDESTRUCTIVE (as 0144): written only where net_weight is absent or empty,
-- so an owner edit made before this runs is never overwritten, and a second
-- pass is a no-op. A row whose spec_fields is not valid JSON is skipped. The
-- estimate label (0218) is not touched.

-- PETG Matte (petg-matte): 1 kg — us.store.bambulab.com/products/petg-matte
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '1000')
 WHERE id = 'p_347d7601a6a9ad4e989ba46f' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- TPU 85A / TPU 90A (tpu-85a-tpu-90a): 1 kg — us.store.bambulab.com/products/tpu-85a-tpu-90a
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '1000')
 WHERE id = 'p_7c50802a9f5f95904ff45530' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- PC FR (pc-fr): 1 kg — us.store.bambulab.com/products/pc-fr
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '1000')
 WHERE id = 'p_78a4e57dcfd5b251ad31cc09' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- TPU for AMS (tpu-for-ams): 1 kg — us.store.bambulab.com/products/tpu-for-ams
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '1000')
 WHERE id = 'p_d17febdc5eacc35af7bd440e' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- ASA-CF (asa-cf): 1 kg — us.store.bambulab.com/products/asa-cf
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '1000')
 WHERE id = 'p_f48ae66f9e10cf13c392a18d' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- PPS-CF (pps-cf): 0.75 kg — us.store.bambulab.com/products/pps-cf
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '750')
 WHERE id = 'p_e3233a2e0e547199637b1cfc' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- PPA-CF (ppa-cf): 0.75 kg — us.store.bambulab.com/products/ppa-cf
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '750')
 WHERE id = 'p_3bbe41364b55c572f8e3b67e' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- ABS-GF (abs-gf): 1 kg — us.store.bambulab.com/products/abs-gf
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '1000')
 WHERE id = 'p_19a04d030df9e58fa6467d46' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- ASA Aero (asa-aero): 1 kg — us.store.bambulab.com/products/asa-aero
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '1000')
 WHERE id = 'p_6d63a9cd7d0cf3a66e074c17' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- PA6-GF (pa6-gf): 1 kg — us.store.bambulab.com/products/pa6-gf
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '1000')
 WHERE id = 'p_4d8dbe40076221ff47740942' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- PVA (pva): 0.5 kg — us.store.bambulab.com/products/pva
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '500')
 WHERE id = 'p_8737117ceca16eab8418ee1f' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- PETG Translucent (petg-translucent): 1 kg — us.store.bambulab.com/products/petg-translucent
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '1000')
 WHERE id = 'p_d166ab8d13f0fc22a2fdbd6c' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- TPU 95A HF (tpu-95a-hf): 1 kg — us.store.bambulab.com/products/tpu-95a-hf
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '1000')
 WHERE id = 'p_173ae8ba9d1a499aa88afed4' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- PA6-CF (pa6-cf): 1 kg — us.store.bambulab.com/products/pa6-cf
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '1000')
 WHERE id = 'p_6633a37fa683993e24ab5faf' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- ASA (asa-filament): 1 kg — us.store.bambulab.com/products/asa-filament
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '1000')
 WHERE id = 'p_6ff4fd9a32631efb1b40e2b0' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- PET-CF (pet-cf): 1 kg — us.store.bambulab.com/products/pet-cf
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '1000')
 WHERE id = 'p_7904e79430bbbac1b1f75f7e' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- PETG-CF (petg-cf): 1 kg — us.store.bambulab.com/products/petg-cf
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '1000')
 WHERE id = 'p_edefddae866a498f2ad92183' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- PAHT-CF (paht-cf): 1 kg — us.store.bambulab.com/products/paht-cf
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '1000')
 WHERE id = 'p_987ef2c76e6eda92776a1987' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- PLA Metal (pla-metal): 1 kg — us.store.bambulab.com/products/pla-metal
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '1000')
 WHERE id = 'p_48132a7f89282798c18871ce' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- ABS (abs-filament): 1 kg — us.store.bambulab.com/products/abs-filament
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '1000')
 WHERE id = 'p_b96289685122830707dd8d17' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
-- PC (pc-filament): 1 kg — us.store.bambulab.com/products/pc-filament
UPDATE products SET spec_fields = json_set(spec_fields, '$.net_weight', '1000')
 WHERE id = 'p_446b259e5474f9a8fcf79a1a' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.net_weight'), '') = '';
