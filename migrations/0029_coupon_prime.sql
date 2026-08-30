-- 0029 — a coupon may require PRIME.
--
-- WHY A TABLE REBUILD. `coupons.tier_required` has carried
-- CHECK (... IN ('plus','pro')) since 0002, written before PRIME existed
-- (migration 0018 added it). SQLite cannot alter a CHECK constraint in
-- place, so the table is rebuilt — the standard twelve-step rebuild, with
-- every row carried across.
--
-- The bug this fixes is not only "an owner cannot make a PRIME coupon". It is
-- that PRIME, the TOP tier, could not use a PRO coupon either: the check
-- compared tiers by equality, so a PRIME member was refused a discount every
-- PRO member got. The comparison becomes a ladder in
-- worker/lib/membershipOps.ts; this makes the column able to express the top
-- rung.

CREATE TABLE IF NOT EXISTS coupons_new (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  tier_required TEXT CHECK (tier_required IS NULL OR tier_required IN ('plus','pro','prime')),
  kind TEXT NOT NULL CHECK (kind IN ('fixed_iqd','percent')),
  value INTEGER NOT NULL CHECK (value > 0),
  min_total_iqd INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT,
  max_global INTEGER,
  max_per_user INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO coupons_new
  (id, code, tier_required, kind, value, min_total_iqd, starts_at, ends_at, max_global, max_per_user, active, created_at)
SELECT id, code, tier_required, kind, value, min_total_iqd, starts_at, ends_at, max_global, max_per_user, active, created_at
  FROM coupons;

DROP TABLE coupons;

ALTER TABLE coupons_new RENAME TO coupons;
