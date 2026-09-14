-- Convert only explicit legacy availability rows attached to live products.
-- Old orphan rows are deliberately left for the separately confirmed audit.
PRAGMA defer_foreign_keys = ON;
INSERT INTO product_option_aliases(legacy_option_id,product_id,option_id,fulfillment_type,legacy_snapshot)
SELECT v.id,v.product_id,
 (SELECT c.id FROM product_option_values c WHERE c.product_id=v.product_id
    AND CASE WHEN v.variant_key<>'' THEN c.variant_key=v.variant_key ELSE c.id=v.id END
    AND c.availability_type IN ('direct_sale','pre_order')
    ORDER BY CASE c.availability_type WHEN 'pre_order' THEN 0 ELSE 1 END ,c.sort,c.id LIMIT 1),
 v.availability_type,json_object('id',v."id",'product_id',v."product_id",'group_id',v."group_id",'name_en',v."name_en",'sku_part',v."sku_part",'image',v."image",'sort',v."sort",'active',v."active",'stock',v."stock",'reserved',v."reserved",'low_stock_threshold',v."low_stock_threshold",'regular_price_iqd',v."regular_price_iqd",'prime_price_iqd',v."prime_price_iqd",'pro_price_iqd',v."pro_price_iqd",'cost_iqd',v."cost_iqd",'created_at',v."created_at",'availability_type',v."availability_type",'lead_time_text',v."lead_time_text",'lead_time_min_days',v."lead_time_min_days",'lead_time_max_days',v."lead_time_max_days",'variant_key',v."variant_key",'variant_label',v."variant_label",'regular_adjust_iqd',v."regular_adjust_iqd",'prime_adjust_iqd',v."prime_adjust_iqd",'pro_adjust_iqd',v."pro_adjust_iqd",'cost_adjust_iqd',v."cost_adjust_iqd",'name_ar',v."name_ar",'name_ckb',v."name_ckb")
FROM product_option_values v
WHERE v.availability_type IN ('direct_sale','pre_order')
  AND EXISTS(SELECT 1 FROM products p WHERE p.id=v.product_id)
  AND EXISTS(SELECT 1 FROM product_option_groups g WHERE g.id=v.group_id);

-- Each legacy row becomes one availability row. A duplicate of the SAME
-- model+route is ambiguous and the UNIQUE constraint aborts the migration.
INSERT INTO product_option_fulfillment
(id,product_id,option_id,fulfillment_type,enabled,regular_price_iqd,prime_price_iqd,pro_price_iqd,cost_iqd,
regular_adjust_iqd,prime_adjust_iqd,pro_adjust_iqd,cost_adjust_iqd,stock,reserved,image,sku_part,lead_time_text,lead_time_min_days,lead_time_max_days)
SELECT 'ful_'||a.option_id||'_'||a.fulfillment_type,a.product_id,a.option_id,a.fulfillment_type,v.active,
v.regular_price_iqd,v.prime_price_iqd,v.pro_price_iqd,v.cost_iqd,v.regular_adjust_iqd,v.prime_adjust_iqd,v.pro_adjust_iqd,v.cost_adjust_iqd,
v.stock,v.reserved,v.image,v.sku_part,v.lead_time_text,v.lead_time_min_days,v.lead_time_max_days
FROM product_option_aliases a JOIN product_option_values v ON v.id=a.legacy_option_id;

INSERT OR IGNORE INTO product_option_fulfillment(id,product_id,option_id,fulfillment_type,enabled)
SELECT 'ful_'||a.option_id||'_'||t.kind,a.product_id,a.option_id,t.kind,0
FROM product_option_aliases a CROSS JOIN (SELECT 'direct_sale' kind UNION ALL SELECT 'pre_order') t;

UPDATE product_images SET option_value_id=(SELECT option_id FROM product_option_aliases a WHERE a.legacy_option_id=product_images.option_value_id)
WHERE option_value_id IN (SELECT legacy_option_id FROM product_option_aliases);
INSERT OR IGNORE INTO product_color_option_links(color_id,option_value_id,group_id)
SELECT l.color_id,a.option_id,v.group_id FROM product_color_option_links l JOIN product_option_aliases a ON a.legacy_option_id=l.option_value_id JOIN product_option_values v ON v.id=a.option_id;
DELETE FROM product_color_option_links WHERE option_value_id IN (SELECT legacy_option_id FROM product_option_aliases WHERE legacy_option_id<>option_id);

-- Canonicalize JSON selections using exact IDs, never a substring replacement.
UPDATE cart_items SET fulfillment_type=COALESCE((SELECT fulfillment_type FROM product_option_aliases a WHERE a.legacy_option_id=cart_items.option_id),fulfillment_type),
 option_id=COALESCE((SELECT option_id FROM product_option_aliases a WHERE a.legacy_option_id=cart_items.option_id),option_id),
 option_value_ids=(SELECT json_group_array(COALESCE((SELECT option_id FROM product_option_aliases a WHERE a.legacy_option_id=j.value),j.value)) FROM json_each(cart_items.option_value_ids) j)
WHERE product_id IN (SELECT product_id FROM product_option_aliases);
UPDATE bundle_components SET option_value_ids=(SELECT json_group_array(COALESCE((SELECT option_id FROM product_option_aliases a WHERE a.legacy_option_id=j.value),j.value)) FROM json_each(bundle_components.option_value_ids) j)
WHERE member_product_id IN (SELECT product_id FROM product_option_aliases);
UPDATE mystery_pool_entries SET option_value_ids=(SELECT json_group_array(COALESCE((SELECT option_id FROM product_option_aliases a WHERE a.legacy_option_id=j.value),j.value)) FROM json_each(mystery_pool_entries.option_value_ids) j)
WHERE product_id IN (SELECT product_id FROM product_option_aliases);
UPDATE bundle_component_choices SET ref_id=COALESCE((SELECT option_id FROM product_option_aliases a WHERE a.legacy_option_id=bundle_component_choices.ref_id),ref_id) WHERE dim='option';

UPDATE product_variants SET combo_key=(SELECT group_concat(token,'|') FROM (
 SELECT DISTINCT CASE WHEN substr(j.value,1,2)='o:' THEN 'o:'||COALESCE((SELECT option_id FROM product_option_aliases a WHERE a.legacy_option_id=substr(j.value,3)),substr(j.value,3)) ELSE j.value END token
 FROM json_each('["'||replace(product_variants.combo_key,'|','","')||'"]') j ORDER BY token))
WHERE product_id IN (SELECT product_id FROM product_option_aliases);

UPDATE inventory_ledger SET idempotency_key=replace(idempotency_key,':option:'||scope_id,':fulfillment:'||(SELECT 'ful_'||a.option_id||'_'||a.fulfillment_type FROM product_option_aliases a WHERE a.legacy_option_id=inventory_ledger.scope_id)),scope_id=(SELECT 'ful_'||a.option_id||'_'||a.fulfillment_type FROM product_option_aliases a WHERE a.legacy_option_id=inventory_ledger.scope_id),scope='fulfillment'
WHERE scope='option' AND scope_id IN (SELECT legacy_option_id FROM product_option_aliases);

-- Historical order IDs/names/prices/media are snapshots and stay untouched.
UPDATE product_option_values SET availability_type='', stock=NULL,reserved=0,
 active=CASE WHEN EXISTS(SELECT 1 FROM product_option_fulfillment f WHERE f.option_id=product_option_values.id AND f.enabled=1) THEN 1 ELSE 0 END,
 name_en=CASE WHEN variant_label<>'' THEN variant_label ELSE name_en END ,
 lead_time_text='',lead_time_min_days=NULL,lead_time_max_days=NULL
WHERE id IN (SELECT option_id FROM product_option_aliases);
DELETE FROM product_option_values WHERE id IN (SELECT legacy_option_id FROM product_option_aliases WHERE legacy_option_id<>option_id);

-- Strip only known fulfillment suffixes on explicitly migrated legacy rows.
WITH suffixes(suffix) AS (VALUES (' — pre-order'),(' – pre-order'),(' - pre-order'),(' (pre-order)'),(' — pre order'),(' – pre order'),(' - pre order'),(' (pre order)'),(' — preorder'),(' – preorder'),(' - preorder'),(' (preorder)'),(' — direct'),(' – direct'),(' - direct'),(' (direct)'),(' — direct sale'),(' – direct sale'),(' - direct sale'),(' (direct sale)'),(' — طلب مسبق'),(' – طلب مسبق'),(' - طلب مسبق'),(' (طلب مسبق)'),(' — بيع مباشر'),(' – بيع مباشر'),(' - بيع مباشر'),(' (بيع مباشر)'))
UPDATE product_option_values SET name_en=COALESCE((SELECT trim(substr(name_en,1,length(name_en)-length(suffix))) FROM suffixes WHERE lower(substr(name_en,-length(suffix)))=suffix AND length(name_en)>length(suffix) LIMIT 1),name_en) WHERE id IN (SELECT option_id FROM product_option_aliases);
WITH suffixes(suffix) AS (VALUES (' — pre-order'),(' – pre-order'),(' - pre-order'),(' (pre-order)'),(' — pre order'),(' – pre order'),(' - pre order'),(' (pre order)'),(' — preorder'),(' – preorder'),(' - preorder'),(' (preorder)'),(' — direct'),(' – direct'),(' - direct'),(' (direct)'),(' — direct sale'),(' – direct sale'),(' - direct sale'),(' (direct sale)'),(' — طلب مسبق'),(' – طلب مسبق'),(' - طلب مسبق'),(' (طلب مسبق)'),(' — بيع مباشر'),(' – بيع مباشر'),(' - بيع مباشر'),(' (بيع مباشر)'))
UPDATE product_option_values SET name_ar=COALESCE((SELECT trim(substr(name_ar,1,length(name_ar)-length(suffix))) FROM suffixes WHERE lower(substr(name_ar,-length(suffix)))=suffix AND length(name_ar)>length(suffix) LIMIT 1),name_ar) WHERE id IN (SELECT option_id FROM product_option_aliases);
WITH suffixes(suffix) AS (VALUES (' — pre-order'),(' – pre-order'),(' - pre-order'),(' (pre-order)'),(' — pre order'),(' – pre order'),(' - pre order'),(' (pre order)'),(' — preorder'),(' – preorder'),(' - preorder'),(' (preorder)'),(' — direct'),(' – direct'),(' - direct'),(' (direct)'),(' — direct sale'),(' – direct sale'),(' - direct sale'),(' (direct sale)'),(' — طلب مسبق'),(' – طلب مسبق'),(' - طلب مسبق'),(' (طلب مسبق)'),(' — بيع مباشر'),(' – بيع مباشر'),(' - بيع مباشر'),(' (بيع مباشر)'))
UPDATE product_option_values SET name_ckb=COALESCE((SELECT trim(substr(name_ckb,1,length(name_ckb)-length(suffix))) FROM suffixes WHERE lower(substr(name_ckb,-length(suffix)))=suffix AND length(name_ckb)>length(suffix) LIMIT 1),name_ckb) WHERE id IN (SELECT option_id FROM product_option_aliases);

-- Prevent the legacy JSON mirror from resurrecting removed availability options.
UPDATE products SET options=(SELECT json_group_array(json_object('id',v.id,'name_en',v.name_en,'name_ar',v.name_ar,'name_ckb',v.name_ckb,'active',json(CASE v.active WHEN 1 THEN 'true' ELSE 'false' END ),'image',v.image,'variant_key',v.variant_key,'regular_price_iqd',v.regular_price_iqd,'prime_price_iqd',v.prime_price_iqd,'pro_price_iqd',v.pro_price_iqd,'cost_iqd',v.cost_iqd,'regular_adjust_iqd',v.regular_adjust_iqd,'prime_adjust_iqd',v.prime_adjust_iqd,'pro_adjust_iqd',v.pro_adjust_iqd,'cost_adjust_iqd',v.cost_adjust_iqd)) FROM product_option_values v WHERE v.product_id=products.id)
WHERE id IN (SELECT product_id FROM product_option_aliases);

CREATE INDEX IF NOT EXISTS idx_option_alias_model ON product_option_aliases(product_id,option_id);
