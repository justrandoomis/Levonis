-- ============================================================================
--  0180 — SERIAL FORMAT RULES BY BRAND AND PRODUCT
--  (owner decision 2, 2026-10-09: «صيغ الأرقام التسلسلية حسب العلامة والمنتج»
--  docs/DECISIONS.md row 195)
-- ============================================================================
--
-- THE OWNER. The shop sells Bambu Lab and Snapmaker (the focus — a Snapmaker
-- product is already on the site), and also Creality, Anycubic and ELEGOO. The
-- Bambu serial shape alone must not block Bulk Add, there is no general rule
-- "if it looks like a Bambu serial, refuse", and validation must be brand and
-- product aware: Bambu has its rules, Snapmaker its rules, and a validator for
-- another brand is added later WITHOUT rebuilding the system.
--
-- SO A RULE IS A ROW. One row per brand (or per product, which wins), in a
-- restricted format the owner edits on «صيغ الأرقام التسلسلية»: a NAMED
-- character set, a length range or exact lengths, known prefixes matched as
-- plain starts, fixed position classes, a NAMED box-number shape and a switch
-- for the model-family check. No column ever holds a pattern: the parser
-- (packages/catalog/src/serialRules.ts) refuses one, and the evaluator builds
-- no regular expression from data.
--
-- WHICH RULE JUDGES A SERIAL: the product's own rule, else its brand's
-- (products.brand_id), else the generic rule in code — letters and digits
-- 6–40, a Bambu-box-shaped value accepted with a warning. Normalisation stays
-- global (serial_norm is the primary key that joins the inventory and the
-- warranty tables), and the hard checks stay for every brand.
--
-- NUMBERING. Ships as 0180, ahead of the pricing engine (which takes 0181).
--
-- ADDITIVE ONLY: one new table, two partial unique indexes and two seed rows
-- in the new table. No existing row of any other table changes. Every
-- statement is re-runnable (IF NOT EXISTS, INSERT OR IGNORE), so
-- `migrate-check --twice` proves it.

CREATE TABLE IF NOT EXISTS serial_brand_rules (
  id            TEXT PRIMARY KEY,
  -- 'catalog' is reserved and unused in v1: a CHECK list cannot be widened
  -- without a table rebuild (the 0178 practice), so it is named now.
  scope         TEXT NOT NULL CHECK (scope IN ('brand','product','catalog')),
  -- No foreign keys, like serial_inventory.product_id (0139): a brand or a
  -- product is deactivated or deleted by its own doors, and a rule naming one
  -- that is gone simply stops matching. NULL brand_id on a brand rule is an
  -- UNBOUND template (a seed whose brand did not exist yet), bound by the
  -- owner with one tap («اربطها بعلامة تجارية»).
  brand_id      TEXT,
  product_id    TEXT,
  catalog_id    TEXT,
  label         TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 60),
  -- off = no format checks beyond the hard ones (and no box or family check);
  -- warn = accept, warn on the screen and in the audit (the default);
  -- enforce = refuse SERIAL_FORMAT_MISMATCH.
  mode          TEXT NOT NULL DEFAULT 'warn' CHECK (mode IN ('off','warn','enforce')),
  charset       TEXT NOT NULL DEFAULT 'ALNUM' CHECK (charset IN ('ALNUM','DIGITS','HEX')),
  min_len       INTEGER NOT NULL DEFAULT 6  CHECK (min_len BETWEEN 6 AND 40),
  max_len       INTEGER NOT NULL DEFAULT 40 CHECK (max_len BETWEEN 6 AND 40),
  -- Bounded JSON arrays: exact lengths, known prefixes ({p, m, a?}) and
  -- position classes ({at, len, cls}). Empty lengths = any length in range.
  lengths       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(lengths) AND json_type(lengths) = 'array' AND json_array_length(lengths) <= 6),
  prefixes      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(prefixes) AND json_type(prefixes) = 'array' AND json_array_length(prefixes) <= 64 AND length(prefixes) <= 4000),
  prefix_policy TEXT NOT NULL DEFAULT 'hint' CHECK (prefix_policy IN ('hint','known_only')),
  positions     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(positions) AND json_type(positions) = 'array' AND json_array_length(positions) <= 8),
  -- The one box-number classifier a rule can name ('bambu': B + digits +
  -- letter + letters/digits, from the shop's A1 Combo label). Only such a
  -- rule refuses a box-number-shaped value as a device serial.
  box_sn_shape  TEXT NOT NULL DEFAULT 'none' CHECK (box_sn_shape IN ('none','bambu')),
  family_check  INTEGER NOT NULL DEFAULT 0 CHECK (family_check IN (0,1)),
  source_note   TEXT NOT NULL DEFAULT '' CHECK (length(source_note) <= 300),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  -- Optimistic concurrency: every owner save names the version it read.
  version       INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by    TEXT NOT NULL DEFAULT 'migration',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (min_len <= max_len),
  CHECK (scope <> 'product' OR product_id IS NOT NULL),
  CHECK (scope <> 'catalog' OR catalog_id IS NOT NULL)
);

-- At most ONE active rule per brand and per product: the resolution is a
-- single row, never a choice between two.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sbr_brand ON serial_brand_rules(brand_id)
  WHERE scope = 'brand' AND brand_id IS NOT NULL AND active = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sbr_product ON serial_brand_rules(product_id)
  WHERE scope = 'product' AND active = 1;

-- BAMBU LAB. Bambu's own page (wiki.bambulab.com/en/general/find-sn, read
-- 2026-10-09): a 15- or 18-character serial, and the 13 printer prefixes it
-- lists. `00M` also answers to «X1 Carbon», so a product named «… X1C» is no
-- model conflict. The box-number refusal and the family check stay hard for
-- Bambu, exactly as today; everything else is `warn`. Bound to the brand whose
-- slug is `bambu-lab` or whose English name is «Bambu Lab» — the exact slug
-- first, then an active brand, then the newest — and left unbound (NULL) when
-- there is none: the owner binds it on the screen.
INSERT OR IGNORE INTO serial_brand_rules
  (id, scope, brand_id, label, mode, charset, min_len, max_len, lengths, prefixes, prefix_policy, box_sn_shape, family_check, source_note)
VALUES (
  'sbr_bambu_lab', 'brand',
  (SELECT b.id FROM brands b
    WHERE b.slug = 'bambu-lab' OR lower(trim(b.name_en)) = 'bambu lab'
    ORDER BY (b.slug = 'bambu-lab') DESC, b.active DESC, b.created_at DESC
    LIMIT 1),
  'Bambu Lab', 'warn', 'ALNUM', 15, 18, '[15,18]',
  '[{"p":"00M","m":"X1C","a":["X1 Carbon"]},{"p":"03W","m":"X1E"},{"p":"20P","m":"X2D"},{"p":"01P","m":"P1S"},{"p":"01S","m":"P1P"},{"p":"22E","m":"P2S"},{"p":"039","m":"A1"},{"p":"030","m":"A1 mini"},{"p":"26A","m":"A2L"},{"p":"094","m":"H2D"},{"p":"239","m":"H2D Pro"},{"p":"093","m":"H2S"},{"p":"31B","m":"H2C"}]',
  'hint', 'bambu', 1,
  'wiki.bambulab.com/en/general/find-sn read 2026-10-09: 15 or 18 characters, 13 printer prefixes. Box number shape from the shop''s A1 Combo label.'
);

-- SNAPMAKER. Only the U1 is documented (wiki.snapmaker.com: 16 digits and a
-- 4-character check code — whether the code is printed joined to the serial
-- is not clear), so no format is invented: the generic letters-and-digits
-- 6–40 in `warn`, no box refusal, no family check. A product rule follows
-- once the owner has read the live label. Bound like the Bambu seed.
INSERT OR IGNORE INTO serial_brand_rules
  (id, scope, brand_id, label, mode, charset, min_len, max_len, source_note)
VALUES (
  'sbr_snapmaker', 'brand',
  (SELECT b.id FROM brands b
    WHERE b.slug = 'snapmaker' OR lower(trim(b.name_en)) = 'snapmaker'
    ORDER BY (b.slug = 'snapmaker') DESC, b.active DESC, b.created_at DESC
    LIMIT 1),
  'Snapmaker', 'warn', 'ALNUM', 6, 40,
  'U1: 16 digits and a 4-character check code per wiki.snapmaker.com, read 2026-10-09. Other models undocumented. The canonical form is still open.'
);
