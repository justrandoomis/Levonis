-- 0063 — THE LEGACY BUNDLES GATE (docs/BUNDLES_MYSTERY.md §1.11, §9)
--
-- The second half of `0059_bundles_migrate_legacy.sql`, separated for one
-- reason only: `offer_windows` is created by 0060 and migrations apply in file
-- order, so §1.11's `INSERT INTO offer_windows` cannot live in 0059 — on a
-- fresh database it fails with "no such table" before the offer model exists.
-- Nothing else about it changed: the same rows, the same deterministic ids,
-- the same INSERT OR IGNORE, and the same preserved gate.
--
-- TODAY'S MEMBERS-ONLY GATE, PRESERVED EXACTLY, AS A SET. The legacy route
-- gated the whole bundles section on `benefits.exclusiveSections`, which is
-- PLUS or PRIME or PRO — all three. It is written here as a `required_tiers`
-- SET, ["plus","prime","pro"], and never as a ladder minimum (§9): a minimum
-- of 'plus' would silently admit PRIME to every future PLUS-exclusive offer
-- and hand it the PLUS price, which is a different rule that merely looks the
-- same on today's data. An admin may make any migrated bundle public by
-- emptying the set (§17 decision 2).
--
-- INSERT OR IGNORE on the (subject_type, subject_id) primary key: a second
-- pass moves no row, and a gate an admin has already edited is never
-- overwritten. The EXISTS guard is because ON CONFLICT does not apply to a
-- foreign-key violation in SQLite.
INSERT OR IGNORE INTO offer_windows (subject_type, subject_id, id, required_tiers, active)
SELECT 'product', 'prd_bnd_' || b.id, 'ofw_bnd_' || b.id,
       '["plus","prime","pro"]', b.active
  FROM bundles b
 WHERE EXISTS (SELECT 1 FROM products p WHERE p.id = 'prd_bnd_' || b.id);
