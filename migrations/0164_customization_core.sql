-- ============================================================================
--  0164 — customization_core (Programme C, phase C1) — part_spec here; lane L5
--         appends the blueprint tables below
--         (docs/LEVO_PROJECT_PROGRAMME.md §B.3, §B.7 row customization_core)
-- ============================================================================
--
-- ---------------------------------------------------------------------------
--  1. PARTS AS STORE PRODUCTS — «يُستخدم داخل منتجات مطبوعة»
-- ---------------------------------------------------------------------------
-- A part is an ordinary store product: its price, stock, SKU, pictures,
-- weight, variants and publish state stay where 0126 put them. What makes it a
-- part is ONE column:
--
--   part_spec   the part's facts as the flat key map the Levonis `printed_part`
--               spec group uses (printed_use, part_kind, part_shape,
--               diameter_mm, length_mm, width_mm, height_mm, voltage, power_w,
--               install_type, install_minutes, fits_family, uses, source,
--               variant_specs), stored as JSON text. NULL = not a part.
--               Validated in code (readPartSpec,
--               packages/catalog/src/personalize/parts.ts), never by a CHECK, so
--               a new fact is an ALTER-free change.
--
-- «INSIDE PRODUCTS ONLY» IS NOT A NEW STATE. A part the merchant keeps off the
-- shelf is `publish_state = 'hidden'`; 0126's mirror trigger (as recreated by
-- 0152) turns that into `status = 'hidden'`, so every storefront, search and
-- community reader — all of which ask `status = 'active'` — already refuses
-- it. Only PART_BUYABLE_SQL (worker/lib/personalize/parts.ts) lets a hidden
-- part through, and only inside its own store.
--
-- ADDITIVE: one nullable column and one partial index; nothing rebuilt.
-- ============================================================================

ALTER TABLE community_products ADD COLUMN part_spec TEXT;

CREATE INDEX IF NOT EXISTS idx_community_products_parts
  ON community_products(store_id) WHERE part_spec IS NOT NULL;

-- ---------------------------------------------------------------------------
--  2. THE BLUEPRINT — «التخصيص · Customization · خۆگونجاندن» (lane L5)
-- ---------------------------------------------------------------------------
-- What the MERCHANT defines for one product, as immutable REVISIONS (the store
-- layout's precedent, 0122): `draft` → `live` → `retired` (and a retired one
-- may be published again as it was). At most ONE live revision per product
-- (`ux_blueprint_live`) and at most ONE draft (`ux_blueprint_draft`): a save
-- on a product whose newest revision is live or retired opens the next draft
-- revision; a publish flips the old live row to retired and the draft to live
-- in one batch, fenced on state and rev, so two live revisions cannot exist
-- even when two publishes race.
--
--   spec          the normalised BlueprintSpec v1 WITHOUT its `private` part
--                 (packages/catalog/src/personalize/spec.ts `normalizeBlueprint`);
--                 '{}' only on a draft whose spec was never saved (a model
--                 attached first). The public projection reads this column
--                 through `publicSpecOf` and never reads the next one.
--   private_json  the spec's `private` part (quality notes, the merchant's
--                 notes) — merchant-only, never in any public body.
--   source_keys   the ≤ 12 PRIVATE `product_file`-purpose keys the mesh was
--                 compiled from. Never `product_files` rows (P16: those are
--                 granted to buyers), never served.
--   parts         the compiled parts' facts, NAMES INCLUDED (compile.ts
--                 `CompiledPart`) — merchant-only; the mesh carries ranges only.
--   analysis      the compile's facts: format, dims, bbox, snap, warnings and
--                 the draft mesh's own hash/bytes/triangles — or {format, hint}
--                 when the source could not be read.
--   mesh_state    none · pending (reserved for a waitUntil compile) · ready ·
--                 failed · photo (a photo-only blueprint: no mesh by design).
--   draft_mesh_key  PRIVATE merchants/<uid>/blueprints/<productId>-<hash12>.lvm.gz
--                 (every part), served only by the builder's owner door.
--   mesh_key      PUBLIC merchants/<uid>/public/bp/<id>-r<rev>-<hash12>.lvm.gz,
--                 written at publish (hidden parts removed); /files serves it.
--   mesh_hash, mesh_bytes, triangles
--                 the mesh this row serves: the draft mesh while a draft, the
--                 public mesh once published.
--   look          the look card {poster_key, w, h, idmap, quads, camera, basis}
--                 accepted from the builder (poster under the public prefix).
--   photo_keys    {media_id: media_key} of every product picture the spec
--                 names, captured at save: the public read builds photo URLs
--                 from it (0126's media rows are re-minted on every gallery
--                 save, so a live revision must not depend on their ids).
--   family, tags, from_iqd   what the gallery (C4) filters and shows.
--   referenced_at stamped by the first order that uses the revision (C3); a
--                 referenced revision is never pruned.
--
-- THE LOCK (`trg_blueprint_locked`): once a revision is not a draft its
-- content — spec, private_json, source_keys, parts, analysis, mesh_state, the
-- mesh keys and figures, look, photo_keys, family, tags — never changes.
-- What stays writable: `state` (draft → live, live → retired, retired → live;
-- `trg_blueprint_state` refuses every other move), `referenced_at`,
-- `from_iqd` (a display figure recomputed from live prices), and the
-- timestamps. The identity (id, product, store, merchant, rev) never changes
-- in any state (`trg_blueprint_identity`).
--
-- NO BLUEPRINT ON A PRIVATE PRODUCT (0152's audience): a private product is
-- one customer's quote and stays one (`trg_blueprint_not_private`, which also
-- refuses a row whose store or merchant is not the product's). The other
-- direction — a product that HAS a blueprint turning private — is refused by
-- 0152's own `trg_private_product_locked` (audience_user_id never changes
-- after creation) and, so the rule holds here even if that one is ever
-- relaxed, by `trg_blueprint_product_stays_public`.
--
-- ADDITIVE: three new tables, their indexes and triggers; nothing rebuilt.
-- ============================================================================

CREATE TABLE IF NOT EXISTS product_blueprints (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL REFERENCES community_products(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES community_merchants(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL CHECK (rev >= 1),
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'live', 'retired')),
  spec TEXT NOT NULL CHECK (json_valid(spec)),
  private_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(private_json)),
  source_keys TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_keys)),
  parts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(parts)),
  analysis TEXT CHECK (analysis IS NULL OR json_valid(analysis)),
  mesh_state TEXT NOT NULL DEFAULT 'none' CHECK (mesh_state IN ('none', 'pending', 'ready', 'failed', 'photo')),
  draft_mesh_key TEXT,
  mesh_key TEXT,
  mesh_hash TEXT,
  mesh_bytes INTEGER CHECK (mesh_bytes IS NULL OR mesh_bytes >= 0),
  triangles INTEGER CHECK (triangles IS NULL OR triangles >= 0),
  look TEXT CHECK (look IS NULL OR json_valid(look)),
  photo_keys TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(photo_keys)),
  family TEXT,
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  from_iqd INTEGER CHECK (from_iqd IS NULL OR from_iqd >= 0),
  referenced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  retired_at TEXT,
  UNIQUE (product_id, rev)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_blueprint_live ON product_blueprints(product_id) WHERE state = 'live';
CREATE UNIQUE INDEX IF NOT EXISTS ux_blueprint_draft ON product_blueprints(product_id) WHERE state = 'draft';
CREATE INDEX IF NOT EXISTS idx_product_blueprints_store ON product_blueprints(store_id, state);
CREATE INDEX IF NOT EXISTS idx_product_blueprints_live ON product_blueprints(published_at DESC, id) WHERE state = 'live';

CREATE TRIGGER IF NOT EXISTS trg_blueprint_identity
BEFORE UPDATE OF id, product_id, store_id, merchant_id, rev ON product_blueprints
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id OR NEW.product_id IS NOT OLD.product_id OR NEW.store_id IS NOT OLD.store_id
  OR NEW.merchant_id IS NOT OLD.merchant_id OR NEW.rev IS NOT OLD.rev
BEGIN
  SELECT RAISE(ABORT, 'BLUEPRINT_LOCKED');
END;

CREATE TRIGGER IF NOT EXISTS trg_blueprint_locked
BEFORE UPDATE ON product_blueprints
FOR EACH ROW
WHEN OLD.state <> 'draft'
 AND (NEW.spec IS NOT OLD.spec OR NEW.private_json IS NOT OLD.private_json OR NEW.source_keys IS NOT OLD.source_keys
   OR NEW.parts IS NOT OLD.parts OR NEW.analysis IS NOT OLD.analysis OR NEW.mesh_state IS NOT OLD.mesh_state
   OR NEW.draft_mesh_key IS NOT OLD.draft_mesh_key OR NEW.mesh_key IS NOT OLD.mesh_key OR NEW.mesh_hash IS NOT OLD.mesh_hash
   OR NEW.mesh_bytes IS NOT OLD.mesh_bytes OR NEW.triangles IS NOT OLD.triangles OR NEW.look IS NOT OLD.look
   OR NEW.photo_keys IS NOT OLD.photo_keys OR NEW.family IS NOT OLD.family OR NEW.tags IS NOT OLD.tags
   OR NEW.created_at IS NOT OLD.created_at)
BEGIN
  SELECT RAISE(ABORT, 'BLUEPRINT_LOCKED');
END;

CREATE TRIGGER IF NOT EXISTS trg_blueprint_state
BEFORE UPDATE OF state ON product_blueprints
FOR EACH ROW
WHEN NEW.state IS NOT OLD.state
 AND NOT ((OLD.state = 'draft' AND NEW.state = 'live')
       OR (OLD.state = 'live' AND NEW.state = 'retired')
       OR (OLD.state = 'retired' AND NEW.state = 'live'))
BEGIN
  SELECT RAISE(ABORT, 'BLUEPRINT_LOCKED');
END;

CREATE TRIGGER IF NOT EXISTS trg_blueprint_not_private
BEFORE INSERT ON product_blueprints
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM community_products p
   WHERE p.id = NEW.product_id AND p.audience_user_id IS NULL
     AND p.store_id = NEW.store_id AND p.merchant_id = NEW.merchant_id)
BEGIN
  SELECT RAISE(ABORT, 'BLUEPRINT_PRODUCT_INELIGIBLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_blueprint_product_stays_public
BEFORE UPDATE OF audience_user_id ON community_products
FOR EACH ROW
WHEN NEW.audience_user_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM product_blueprints b WHERE b.product_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'BLUEPRINT_PRODUCT_INELIGIBLE');
END;

-- ---------------------------------------------------------------------------
--  3. WHICH PARTS A REVISION BUILDS IN — the derived index
-- ---------------------------------------------------------------------------
-- One row per (revision, slot, option) naming the store part product (and
-- variant, '' for a simple part) it takes, plus the always-used fixed parts
-- as slot '~fixed' (option = its index). Rewritten with every draft save;
-- it answers «used in N», PART_IN_USE (a LIVE revision's refs block deleting
-- the part) and the dependent purges without parsing any spec. Deleting a
-- revision deletes its rows (the composite key below).

CREATE TABLE IF NOT EXISTS blueprint_part_refs (
  product_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  slot_key TEXT NOT NULL,
  option_key TEXT NOT NULL,
  part_product_id TEXT NOT NULL REFERENCES community_products(id) ON DELETE CASCADE,
  part_variant_id TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 20),
  PRIMARY KEY (product_id, rev, slot_key, option_key),
  FOREIGN KEY (product_id, rev) REFERENCES product_blueprints(product_id, rev) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_blueprint_part_refs_part ON blueprint_part_refs(part_product_id);

-- ---------------------------------------------------------------------------
--  4. THE CONFIGURATION — what the CUSTOMER chose, as one immutable value
-- ---------------------------------------------------------------------------
-- The canonical DesignConfig v1 (packages/catalog/src/personalize/canonical.ts)
-- of one owner for one product, minted by POST /api/personalize/configs
-- against the LIVE revision; every later door (cart, request, share, publish)
-- carries it by id. Never a price. Owner-scoped and deduplicated: equal
-- choices by the same owner are ONE row (UNIQUE (owner_id, hash), where hash
-- is the SHA-256 of the canonical JSON — `rev` included, so the same choices
-- against a new revision are a new configuration). `twin_code` is random and
-- known before production (the /t/:code resolver, C3). `public` is fixed at
-- insert — a public copy (C12) is its own redacted row.
--
-- IMMUTABLE (`trg_config_immutable`): a configuration is never updated. A
-- change of mind is a new configuration.

CREATE TABLE IF NOT EXISTS design_configs (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES community_products(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL CHECK (rev >= 1),
  hash TEXT NOT NULL CHECK (length(hash) BETWEEN 32 AND 64),
  spec TEXT NOT NULL CHECK (json_valid(spec)),
  public INTEGER NOT NULL DEFAULT 0 CHECK (public IN (0, 1)),
  twin_code TEXT NOT NULL CHECK (length(twin_code) BETWEEN 10 AND 32),
  created_at TEXT NOT NULL,
  UNIQUE (owner_id, hash),
  UNIQUE (twin_code)
);

CREATE INDEX IF NOT EXISTS idx_design_configs_product ON design_configs(product_id);

CREATE TRIGGER IF NOT EXISTS trg_config_immutable
BEFORE UPDATE ON design_configs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'CONFIG_IMMUTABLE');
END;
