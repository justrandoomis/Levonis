-- Levonis migration 0089 — THE SEARCH INDEX, AND THE WORDS ITS CUSTOMERS USE.
--
-- WHAT WAS THERE BEFORE. One statement, in worker/routes/products.ts:
--
--   name LIKE '%q%' OR name_ar LIKE '%q%' OR name_ku LIKE '%q%' OR description LIKE '%q%'
--
-- Four unindexed substring scans with no tokenisation and no ranking. A
-- customer looking for the shop's flagship printer types «بامبو» or «بمبو» or
-- «اكس تو دي» or «طابعه» and gets nothing, because none of those is a
-- substring of "Bambu Lab X2D Combo". The owner's brief was «مهما كتب يظهر
-- الذي يريده».
--
-- WHY NOT FTS5. SQLite's full-text extension would give tokenisation and
-- ranking for free and would not touch the actual problem: its tokenizers do
-- no Arabic normalisation, no romanisation and no typo tolerance, so every
-- hard part would still have to be built beside it. Against that, a virtual
-- table is a hard dependency on an extension being present in D1 AT MIGRATION
-- TIME, and a migration that cannot apply is a failed deploy on a live shop.
-- Two ordinary tables cost nothing to be sure about.
--
-- ---------------------------------------------------------------- the index
--
-- One row per distinct token per product, carrying the weight of the best
-- field that token appeared in (name 10 … description 1 — see
-- worker/lib/search/index.ts). Every token is stored twice: as itself and as
-- its romanised skeleton, which is what lets «بامبو» and "bambu" meet.
--
-- ON DELETE CASCADE, so a deleted product takes its index rows with it — the
-- same guarantee every other product-scoped table in this schema declares.
CREATE TABLE IF NOT EXISTS search_tokens (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  weight     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (product_id, token)
);

-- THE LOOKUP THIS WHOLE DESIGN RESTS ON. Every query is a range scan over this
-- index: exact tokens, prefixes ("pla bas" -> "pla basic"), and the bounded
-- candidate set the fuzzy pass runs over (tokens sharing the first two
-- characters). The token leads because that is what is searched; the weight
-- follows so the scan is covering and never touches the table.
CREATE INDEX IF NOT EXISTS idx_search_tokens_token ON search_tokens(token, product_id, weight);

-- ------------------------------------------------------------ the dictionary
--
-- «طابعة» means "printer". No string algorithm discovers that — romanisation
-- turns it into "tabah", which is nothing like "printer", because it is not a
-- SPELLING of "printer" but the Arabic WORD for it. Somebody has to write it
-- down, and the owner has to be able to add to it when a customer searches for
-- something in a way nobody predicted.
--
-- A TABLE RATHER THAN A CONSTANT, therefore: adding «بمبو» or a new brand must
-- not need a deploy. The seed below is emitted from
-- worker/lib/search/vocabulary.ts so the table and the code can never describe
-- different vocabularies.
--
-- Both sides are stored NORMALISED (worker/lib/search/normalize.ts): folded
-- hamza and ta marbuta, no diacritics, no tatweel. That is why the table does
-- not need a row for every way «طابعة» can be typed.
CREATE TABLE IF NOT EXISTS search_synonyms (
  term      TEXT PRIMARY KEY,
  canonical TEXT NOT NULL,
  -- 0 for the rows this migration seeds, 1 for anything the owner adds later.
  -- A re-seed must never overwrite the owner's own vocabulary.
  owner_added INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_search_synonyms_canonical ON search_synonyms(canonical);

-- The seed. INSERT OR IGNORE for the re-run the migration guard performs, and
-- so that a term the owner has already added by hand keeps THEIR meaning
-- rather than being reset to this file's.
INSERT OR IGNORE INTO search_synonyms (term, canonical, owner_added) VALUES
  ('طابعه', 'printer', 0),
  ('طابعات', 'printer', 0),
  ('طباعه', 'printer', 0),
  ('برنتر', 'printer', 0),
  ('چاپكهر', 'printer', 0),
  ('چاپكهرهكان', 'printer', 0),
  ('printers', 'printer', 0),
  ('فلمنت', 'filament', 0),
  ('فيلمنت', 'filament', 0),
  ('فلامنت', 'filament', 0),
  ('خيط', 'filament', 0),
  ('خيوط', 'filament', 0),
  ('بكره', 'filament', 0),
  ('فيلامێنت', 'filament', 0),
  ('filaments', 'filament', 0),
  ('spool', 'filament', 0),
  ('نوزل', 'nozzle', 0),
  ('نوزلين', 'nozzle', 0),
  ('نوزلات', 'nozzle', 0),
  ('فوهه', 'nozzle', 0),
  ('راس', 'nozzle', 0),
  ('nozzles', 'nozzle', 0),
  ('راتنج', 'resin', 0),
  ('ريزن', 'resin', 0),
  ('رزن', 'resin', 0),
  ('قطع', 'parts', 0),
  ('ملحقات', 'accessories', 0),
  ('اكسسوارات', 'accessories', 0),
  ('قطع غيار', 'parts', 0),
  ('صيانه', 'maintenance', 0),
  ('ضمان', 'warranty', 0),
  ('مستعمل', 'used', 0),
  ('مجدد', 'refurbished', 0),
  ('باقه', 'bundle', 0),
  ('كومبو', 'combo', 0),
  ('بي ال اي', 'pla', 0),
  ('بلا', 'pla', 0),
  ('بيتج', 'petg', 0),
  ('بي تي جي', 'petg', 0),
  ('ابس', 'abs', 0),
  ('تي بي يو', 'tpu', 0),
  ('مطاط', 'tpu', 0),
  ('نايلون', 'nylon', 0),
  ('كاربون', 'carbon', 0),
  ('كربون', 'carbon', 0),
  ('حرير', 'silk', 0),
  ('شفاف', 'clear', 0),
  ('اساسي', 'basic', 0),
  ('بيسك', 'basic', 0),
  ('اف دي ام', 'fdm', 0),
  ('ثلاثي الابعاد', '3d', 0),
  ('ثري دي', '3d', 0),
  ('سلا', 'sla', 0),
  ('بامبو', 'bambu', 0),
  ('بمبو', 'bambu', 0),
  ('بامبولاب', 'bambu', 0),
  ('بامبو لاب', 'bambu', 0),
  ('بانبو', 'bambu', 0),
  ('bambulab', 'bambu', 0),
  ('كريالتي', 'creality', 0),
  ('كرياليتي', 'creality', 0),
  ('كريلتي', 'creality', 0),
  ('اي سن', 'esun', 0),
  ('ايسن', 'esun', 0),
  ('سناب ميكر', 'snapmaker', 0),
  ('سنابميكر', 'snapmaker', 0),
  ('كيدي', 'qidi', 0),
  ('كيوداي', 'qidi', 0),
  ('بيكو', 'biqu', 0),
  ('بيك يو', 'biqu', 0),
  ('بيج تري تك', 'bigtreetech', 0),
  ('بيجتري', 'bigtreetech', 0),
  ('btt', 'bigtreetech', 0),
  ('انتنسكي', 'antinsky', 0),
  ('انتينسكي', 'antinsky', 0),
  ('اكس2دي', 'x2d', 0),
  ('اكستودي', 'x2d', 0),
  ('اي1', 'a1', 0),
  ('ايه1', 'a1', 0),
  ('بي1', 'p1', 0),
  ('اتش2دي', 'h2d', 0),
  ('يو1', 'u1', 0),
  ('ايه ام اس', 'ams', 0),
  ('امس', 'ams', 0),
  ('مزدوج', 'dual', 0),
  ('دبل', 'dual', 0),
  ('ملون', 'color', 0),
  ('الوان', 'color', 0),
  ('سريع', 'fast', 0),
  ('صغير', 'mini', 0),
  ('ميني', 'mini', 0),
  ('كبير', 'large', 0),
  ('رخيص', 'cheap', 0),
  ('عرض', 'offer', 0),
  ('خصم', 'discount', 0);
