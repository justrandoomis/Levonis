-- ============================================================================
--  0153 — PROJECTS AND POSTS: WHAT THE COMMUNITY MAKES (docs/COMMUNITY_ECOSYSTEM.md §3, Phase 1)
-- ============================================================================
-- Levo Community grows from a marketplace into a place makers publish what
-- they printed. A PROJECT is a finished print with the facts a maker cares
-- about — the printer, the material, the colour, the settings, how long it
-- took, how big it is — and the doors that lead from it into the marketplace:
-- the store that made it, the product it became, the request it fulfilled,
-- «اطلب طباعته» and «اشتر المواد المستخدمة». A POST is the same row with fewer
-- facts (a photo, a timelapse, a tutorial, a before/after).
--
-- ADDITIVE: two new tables and one nullable-defaulted column on `users`.
-- Nothing existing is rewritten; a database a migration behind is the same
-- community it was, with no posts.
--
-- ---------------------------------------------------------------------------
--  ONE TABLE FOR PROJECTS AND POSTS
-- ---------------------------------------------------------------------------
-- `kind` says what a row is. Every kind is authored by an ordinary account
-- (not only a merchant), so the creator layer is open to customers who print
-- at home — the community the owner asked for is «Social + Creator +
-- Manufacturing», and the creator is often the customer.
--
--   state        draft → published → archived (the author's own steps)
--   visibility   public (the feed, search, the profile) · unlisted (the link
--                only) · private (the author only)
--   admin_hidden_at / admin_hidden_reason
--                Levonis's moderation mark (0126's `admin_hidden_at` pattern):
--                a hidden post is served to nobody but its author and staff,
--                whatever its state, and the author is told why.
--
-- THE LINKS ARE IDS, CHECKED BY THE SERVER (docs/COMMUNITY_COMMERCE_CHAT.md
-- D2's rule, applied again): `store_id` must be a store the author owns,
-- `product_id` a product of that store, `request_id` / `community_order_id` a
-- job the author was a party to. A PORTFOLIO piece made from a customer's
-- private request needs that customer's consent before it is public
-- (`consent_status`): the pictures are of their part.
--
-- THE COUNTERS are denormalised so a feed page is one read. They are
-- maintained by the social tables' triggers (0154) and never trusted from a
-- client; `view_count` is the analytics beacon's (Phase 7).
--
-- `print_settings`, `dimensions` and `tags` are JSON holding numbers and short
-- words, never a file key — registered as non-media with the sweeper
-- (worker/lib/mediaRefs.ts) in the same change.
-- ============================================================================

CREATE TABLE IF NOT EXISTS community_posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'project'
    CHECK (kind IN ('project','post','tutorial','timelapse','before_after')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','archived')),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','unlisted','private')),
  -- what was used: a catalogue printer / material when the maker picked one,
  -- and the words they wrote when they did not
  printer_product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  printer_name TEXT NOT NULL DEFAULT '',
  material_product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  material TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  print_settings TEXT NOT NULL DEFAULT '{}',
  print_time_minutes INTEGER CHECK (print_time_minutes IS NULL OR print_time_minutes >= 0),
  dimensions TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '[]',
  -- the doors into the marketplace
  store_id TEXT REFERENCES merchant_stores(id) ON DELETE SET NULL,
  product_id TEXT REFERENCES community_products(id) ON DELETE SET NULL,
  request_id TEXT REFERENCES community_requests(id) ON DELETE SET NULL,
  community_order_id TEXT REFERENCES community_orders(id) ON DELETE SET NULL,
  consent_status TEXT NOT NULL DEFAULT 'not_needed'
    CHECK (consent_status IN ('not_needed','pending','granted','declined')),
  -- counters (0154's triggers; the beacon for views)
  like_count INTEGER NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  comment_count INTEGER NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
  save_count INTEGER NOT NULL DEFAULT 0 CHECK (save_count >= 0),
  view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  -- moderation
  admin_hidden_at TEXT,
  admin_hidden_reason TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The feed's own index: what everybody may see, newest first, paged by
-- (published_at, id) like every other community feed (worker/lib/feedCursor.ts).
CREATE INDEX IF NOT EXISTS idx_community_posts_feed
  ON community_posts(published_at DESC, id DESC)
  WHERE state = 'published' AND visibility = 'public' AND admin_hidden_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_community_posts_author ON community_posts(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_posts_store ON community_posts(store_id) WHERE store_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_community_posts_product ON community_posts(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_community_posts_request ON community_posts(request_id) WHERE request_id IS NOT NULL;

-- A post is published only with a published_at, so the feed index and the
-- «منذ …» line always have a date; the doors that publish set both together.
CREATE TRIGGER IF NOT EXISTS trg_post_published_has_date
BEFORE UPDATE OF state ON community_posts
FOR EACH ROW
WHEN NEW.state = 'published' AND NEW.published_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'POST_PUBLISHED_WITHOUT_DATE');
END;

-- ---------------------------------------------------------------------------
--  THE PICTURES AND VIDEOS OF A POST
-- ---------------------------------------------------------------------------
-- The author's own public media (`users/<uid>/posts/…`, uploaded through
-- POST /api/uploads purpose=post, sniffed by bytes like every upload) in the
-- order the author arranged them. The first row is the cover. 3D files are
-- NOT here: they arrive with the asset platform (Phase 4) as attachments with
-- their own access rules — a model is never a public object.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_post_media (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  media_key TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_s INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_community_post_media_post ON community_post_media(post_id, sort_order, id);

-- ---------------------------------------------------------------------------
--  A CREATOR PROFILE IS PUBLIC BY CHOICE
-- ---------------------------------------------------------------------------
-- `users.bio`, `website` and the socials in `profile_json` were returned to
-- the account itself only. A public creator page (/u/<username>) shows them
-- — so it exists only for an account that said yes: publishing a first
-- project sets it (the composer says so), the profile settings switch it, and
-- a store owner is public already through their store. Everyone else's
-- profile answers 404 exactly as before this migration.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN creator_public INTEGER NOT NULL DEFAULT 0 CHECK (creator_public IN (0,1));
