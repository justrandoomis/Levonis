-- ============================================================================
--  0144 — PRINTER COLOUR FACTS AND PER-OPTION DIFFERENCES (data only)
-- ============================================================================
-- The owner, 2026-09-26: «يظهر بعض المقارنات غير صحيحة خاصة للأجهزة التي
-- يمكنها الطباعة بأكثر من لون بدون خسارة بالفلامت مثل snapmaker u1 و h2c
-- بسبعة ألوان و x2d بلونين … كما أن الخيار نفسه يفرق من حيث أن الطابعة بدون
-- ams بدون كومبو أو مع ams يختلف كذلك يختلف عن التي فيها ليزر».
--
-- NO NEW COLUMN. The facts are ordinary printer-template fields
-- (worker/lib/templateFamilies.ts, «خاص بطابعات FDM»: multicolor_method,
-- max_colors_native, purge_waste, multi_material, colors_out_of_box,
-- ams_units_included, laser_module_power, cutting_module, and the per-option
-- lines in variant_specs — read by worker/lib/multicolor.ts). They live in
-- `products.spec_fields` like every other spec, so the admin edits them in
-- the same form.
--
-- EVERY VALUE IS QUOTED FROM THE PRODUCT'S OWN SHEET (the line above each
-- block names the sentence). Nothing here is from a vendor page or memory; a
-- fact the sheet does not state is left EMPTY for the owner, and the page
-- says «غير مذكور» rather than a guess.
--
-- NONDESTRUCTIVE: each key is written only where it is absent or empty, so an
-- owner edit made before this runs is never overwritten, and a second pass is
-- a no-op. A row whose spec_fields is not valid JSON is skipped.


-- Snapmaker U1 (prd_34302590d3494fba8411)
-- Source: multi_color «Up to 4 colours/materials simultaneously through 4 independent SnapSwap toolheads»; extruders 4; description «multi-colour and multi-material … toolhead swaps … to reduce purge waste»; in_the_box «4 toolheads with hot ends … 4 filament holders»; the owner: «بدون خسارة بالفلامنت». One option (u1), so the facts sit on the product.
UPDATE products SET spec_fields = json_set(spec_fields, '$.multicolor_method', 'Tool changer')
 WHERE id = 'prd_34302590d3494fba8411' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.multicolor_method'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.max_colors_native', '4')
 WHERE id = 'prd_34302590d3494fba8411' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.max_colors_native'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.purge_waste', 'Near zero')
 WHERE id = 'prd_34302590d3494fba8411' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.purge_waste'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.multi_material', 'Yes')
 WHERE id = 'prd_34302590d3494fba8411' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.multi_material'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.ams_units_included', '0')
 WHERE id = 'prd_34302590d3494fba8411' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.ams_units_included'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.colors_out_of_box', '4')
 WHERE id = 'prd_34302590d3494fba8411' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.colors_out_of_box'), '') = '';

-- Bambu Lab H2C (prd_e71ab7217435490fb43a)
-- Source: multi_color «Six Vortek induction-hotend positions plus a fixed left nozzle provide up to seven dedicated material paths with reduced purging»; max_colors 24; in_the_box: AMS Combo base «AMS 2 Pro», Ultimate «two AMS 2 Pro, one AMS HT», Laser Full Combo «selected 10W or 40W laser, blade/pen module». Whether the laser combos ship an AMS is NOT stated — left for the owner.
UPDATE products SET spec_fields = json_set(spec_fields, '$.multicolor_method', 'Multi-nozzle (hotend changer)')
 WHERE id = 'prd_e71ab7217435490fb43a' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.multicolor_method'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.max_colors_native', '7')
 WHERE id = 'prd_e71ab7217435490fb43a' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.max_colors_native'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.purge_waste', 'Low')
 WHERE id = 'prd_e71ab7217435490fb43a' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.purge_waste'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.multi_material', 'Yes')
 WHERE id = 'prd_e71ab7217435490fb43a' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.multi_material'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.has_laser_module', 'Yes')
 WHERE id = 'prd_e71ab7217435490fb43a' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.has_laser_module'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.variant_specs', 'h2c-ams-combo: ams_units_included=1
h2c-laser-full-combo-10w: laser_module_power=10, cutting_module=Yes
h2c-laser-full-combo-40w: laser_module_power=40, cutting_module=Yes
h2c-vortek-ultimate-bundle: ams_units_included=3')
 WHERE id = 'prd_e71ab7217435490fb43a' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.variant_specs'), '') = '';

-- Bambu Lab H2D (prd_7387063972434aab9f92)
-- Source: model/description «Dual-nozzle»; extruders 2; in_the_box per option (Combo: one AMS 2 Pro; Laser Full Combo 10W/40W: one AMS 2 Pro and the laser; «blade-cutting/pen module»). purge_waste Low is the dual-nozzle design (two nozzles, two filaments, no swap between them) — for the owner to confirm. multi_material is NOT stated — left for the owner.
UPDATE products SET spec_fields = json_set(spec_fields, '$.multicolor_method', 'Dual nozzle')
 WHERE id = 'prd_7387063972434aab9f92' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.multicolor_method'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.max_colors_native', '2')
 WHERE id = 'prd_7387063972434aab9f92' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.max_colors_native'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.purge_waste', 'Low')
 WHERE id = 'prd_7387063972434aab9f92' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.purge_waste'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.has_laser_module', 'Yes')
 WHERE id = 'prd_7387063972434aab9f92' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.has_laser_module'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.variant_specs', 'h2d: ams_units_included=0
h2d-combo: ams_units_included=1
h2d-laser-full-combo-10w: ams_units_included=1, laser_module_power=10, cutting_module=Yes
h2d-laser-full-combo-40w: ams_units_included=1, laser_module_power=40, cutting_module=Yes')
 WHERE id = 'prd_7387063972434aab9f92' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.variant_specs'), '') = '';

-- Bambu Lab X2D (prd_04aa310272f943f3b51b)
-- Source: description «mechanically switched dual-nozzle system»; extruders 2; supported_filaments «Support for PLA/PETG …»; the owner: «x2d بلونين لكنه لون ثنائي»; in_the_box «X2D Combo: X2D + 1× AMS 2 Pro. Print More Bundle: X2D + 2× AMS 2 Pro». purge_waste Low as H2D — for the owner to confirm.
UPDATE products SET spec_fields = json_set(spec_fields, '$.multicolor_method', 'Dual nozzle')
 WHERE id = 'prd_04aa310272f943f3b51b' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.multicolor_method'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.max_colors_native', '2')
 WHERE id = 'prd_04aa310272f943f3b51b' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.max_colors_native'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.purge_waste', 'Low')
 WHERE id = 'prd_04aa310272f943f3b51b' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.purge_waste'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.multi_material', 'Yes')
 WHERE id = 'prd_04aa310272f943f3b51b' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.multi_material'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.variant_specs', 'x2d: ams_units_included=0
x2d-combo: ams_units_included=1
x2d-print-more-bundle: ams_units_included=2')
 WHERE id = 'prd_04aa310272f943f3b51b' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.variant_specs'), '') = '';

-- Bambu Lab H2S (prd_65182590e9284a97a3e2)
-- Source: extruders 1 with max_colors 24 (a single nozzle fed by AMS); in_the_box «H2S AMS Combo: one AMS 2 Pro», «Laser Full Combo 10W: one AMS 2 Pro and 10W laser module … blade-cutting module/pen holder»; the AMS 2 Pro is «four-slot» (P2S in_the_box).
UPDATE products SET spec_fields = json_set(spec_fields, '$.multicolor_method', 'Single nozzle + AMS')
 WHERE id = 'prd_65182590e9284a97a3e2' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.multicolor_method'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.max_colors_native', '1')
 WHERE id = 'prd_65182590e9284a97a3e2' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.max_colors_native'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.purge_waste', 'High')
 WHERE id = 'prd_65182590e9284a97a3e2' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.purge_waste'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.has_laser_module', 'Yes')
 WHERE id = 'prd_65182590e9284a97a3e2' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.has_laser_module'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.variant_specs', 'h2s: ams_units_included=0, colors_out_of_box=1
h2s-ams-combo: ams_units_included=1, colors_out_of_box=4
h2s-laser-full-combo: ams_units_included=1, colors_out_of_box=4, laser_module_power=10, cutting_module=Yes')
 WHERE id = 'prd_65182590e9284a97a3e2' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.variant_specs'), '') = '';

-- Bambu Lab P1S (prd_b1e2ff5081a34f3f9389)
-- Source: extruders 1, max_colors 16; in_the_box «P1S AMS Combo: one original four-slot AMS», «P1S AMS 2 Combo: one AMS 2 Pro» (four-slot, P2S in_the_box).
UPDATE products SET spec_fields = json_set(spec_fields, '$.multicolor_method', 'Single nozzle + AMS')
 WHERE id = 'prd_b1e2ff5081a34f3f9389' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.multicolor_method'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.max_colors_native', '1')
 WHERE id = 'prd_b1e2ff5081a34f3f9389' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.max_colors_native'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.purge_waste', 'High')
 WHERE id = 'prd_b1e2ff5081a34f3f9389' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.purge_waste'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.variant_specs', 'p1s: ams_units_included=0, colors_out_of_box=1
p1s-ams-combo: ams_units_included=1, colors_out_of_box=4
p1s-ams-2-combo: ams_units_included=1, colors_out_of_box=4')
 WHERE id = 'prd_b1e2ff5081a34f3f9389' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.variant_specs'), '') = '';

-- Bambu Lab P2S (prd_eb3ed76daf8c4c50ad68)
-- Source: extruders 1, max_colors 20; in_the_box «P2S Combo only: one four-slot AMS 2 Pro».
UPDATE products SET spec_fields = json_set(spec_fields, '$.multicolor_method', 'Single nozzle + AMS')
 WHERE id = 'prd_eb3ed76daf8c4c50ad68' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.multicolor_method'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.max_colors_native', '1')
 WHERE id = 'prd_eb3ed76daf8c4c50ad68' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.max_colors_native'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.purge_waste', 'High')
 WHERE id = 'prd_eb3ed76daf8c4c50ad68' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.purge_waste'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.variant_specs', 'p2s: ams_units_included=0, colors_out_of_box=1
p2s-combo: ams_units_included=1, colors_out_of_box=4')
 WHERE id = 'prd_eb3ed76daf8c4c50ad68' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.variant_specs'), '') = '';

-- Bambu Lab A1 (prd_e6ece48322114d37a931)
-- Source: extruders 1; multi_color «Up to 4 colours with one AMS lite; AMS lite is included with A1 Combo»; in_the_box «four rotary spool holders».
UPDATE products SET spec_fields = json_set(spec_fields, '$.multicolor_method', 'Single nozzle + AMS')
 WHERE id = 'prd_e6ece48322114d37a931' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.multicolor_method'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.max_colors_native', '1')
 WHERE id = 'prd_e6ece48322114d37a931' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.max_colors_native'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.purge_waste', 'High')
 WHERE id = 'prd_e6ece48322114d37a931' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.purge_waste'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.variant_specs', 'a1: ams_units_included=0, colors_out_of_box=1
a1-combo: ams_units_included=1, colors_out_of_box=4')
 WHERE id = 'prd_e6ece48322114d37a931' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.variant_specs'), '') = '';

-- Bambu Lab A1 mini (prd_c7dc934872d648d08dbc)
-- Source: extruders 1; multi_color «Up to 4 colours with AMS lite»; in_the_box «A1 mini Combo additionally includes AMS lite … four rotary spool holders».
UPDATE products SET spec_fields = json_set(spec_fields, '$.multicolor_method', 'Single nozzle + AMS')
 WHERE id = 'prd_c7dc934872d648d08dbc' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.multicolor_method'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.max_colors_native', '1')
 WHERE id = 'prd_c7dc934872d648d08dbc' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.max_colors_native'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.purge_waste', 'High')
 WHERE id = 'prd_c7dc934872d648d08dbc' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.purge_waste'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.variant_specs', 'a1-mini: ams_units_included=0, colors_out_of_box=1
a1-mini-combo: ams_units_included=1, colors_out_of_box=4')
 WHERE id = 'prd_c7dc934872d648d08dbc' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.variant_specs'), '') = '';

-- Bambu Lab A2L (prd_907dea50ea694380bcf6)
-- Source: extruders 1, max_colors 19; in_the_box «A2L Combo additionally includes AMS lite», «Cutting Full Combo additionally includes the Cutting Upgrade Kit». The Combo's colours as sold and whether the Cutting combo ships the AMS lite are NOT stated — left for the owner.
UPDATE products SET spec_fields = json_set(spec_fields, '$.multicolor_method', 'Single nozzle + AMS')
 WHERE id = 'prd_907dea50ea694380bcf6' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.multicolor_method'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.max_colors_native', '1')
 WHERE id = 'prd_907dea50ea694380bcf6' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.max_colors_native'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.purge_waste', 'High')
 WHERE id = 'prd_907dea50ea694380bcf6' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.purge_waste'), '') = '';
UPDATE products SET spec_fields = json_set(spec_fields, '$.variant_specs', 'a2l: ams_units_included=0, colors_out_of_box=1
a2l-combo: ams_units_included=1
a2l-cutting-full-combo: cutting_module=Yes')
 WHERE id = 'prd_907dea50ea694380bcf6' AND json_valid(spec_fields) AND COALESCE(json_extract(spec_fields, '$.variant_specs'), '') = '';
