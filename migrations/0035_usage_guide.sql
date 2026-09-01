-- 0035 — structured usage & setup guide.
--
-- The owner's mandate: «طريقة الاستخدام» must grow from one free-text blob
-- into REAL steps — each with a title, a description, images, an optional
-- video and an optional link to the official documentation (e.g.
-- wiki.bambulab.com/en/a1) — split into تركيب وتنصيب (setup) and استخدام
-- (usage), plus one official-guide URL for the whole product.
--
-- JSON shape (validated + URL-sanitized in worker/lib/productModel.ts):
--   { "official_url": "https://…",
--     "steps": [ { "id", "kind": "setup"|"usage", "title", "body",
--                  "images": ["https://…"], "video_url", "link_url",
--                  "order" } ] }
--
-- The legacy products.how_to_use text stays untouched as the fallback for
-- rows that never author steps. NULL/absent = no guide — every existing
-- product keeps behaving exactly as before.

ALTER TABLE products ADD COLUMN usage_guide TEXT;

-- The print-price calculator filters on template_family ('materials') for
-- every quote; give that scan an index while we are touching the table.
CREATE INDEX IF NOT EXISTS idx_products_template_family ON products(template_family);
