-- ============================================================================
-- 0037 — STOREFRONT PROFILE WIDGETS.
--
-- The two merchant-controlled rows of the store profile header:
--   profile_links — up to three link pills (icon, title, url)
--   profile_facts — up to three info cards (icon, title, secondary text)
-- Each item also carries visible on/off; order is the array order. Opaque
-- JSON on the store row like policies/social_links before them — the server
-- sanitizes on the way in (icon names from a fixed set, http(s) urls only)
-- and the frontend maps icon NAMES to its own components, so nothing a
-- merchant types becomes markup or a style rule (§12).
-- ============================================================================

ALTER TABLE merchant_stores ADD COLUMN profile_links TEXT NOT NULL DEFAULT '[]';
ALTER TABLE merchant_stores ADD COLUMN profile_facts TEXT NOT NULL DEFAULT '[]';

-- The following-list reads scan follows by user; only the merchant side had
-- an index until now.
CREATE INDEX IF NOT EXISTS idx_follows_user ON follows(user_id);
