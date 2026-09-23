-- ============================================================================
--  0113 — «أريد اسم Levonis بالإنجليزي فقط»: THE SAVED WARRANTY WORDING.
-- ============================================================================
-- The store's name is written «Levonis», in Latin letters, in every language
-- (docs/DECISIONS.md row 99). The code default in worker/lib/warrantyConfig.ts
-- now says «ضمان Levonis» and «لـ Levonis أن تفحص الجهاز …», but a default is
-- only what an EMPTY database reads: once the owner has saved the warranty
-- settings from the admin panel, `admin_settings.warrantyConfig` holds its own
-- copy of every sentence, and that copy — still «ضمان ليفونيس» — is what the
-- next receipt prints. This rewrites the brand in that stored copy.
--
-- WHAT IT TOUCHES: one row (`key = 'warrantyConfig'`), and inside it only the
-- Arabic-script spelling of the brand. «لليفونيس» (the preposition glued to
-- the name) becomes «لـ Levonis» first, so the sentence still parses, then
-- every remaining «ليفونيس» becomes «Levonis». Neither replacement contains a
-- quote or a backslash, so the stored JSON stays valid text byte for byte
-- around them. Every other sentence the owner wrote is left exactly as saved.
--
-- THE VERSION MOVES WITH THE WORDING. `version` is what a receipt snapshots
-- as `terms_version` (worker/routes/warranty.ts), and the admin bumps it when
-- the wording changes; this is a wording change, so it is bumped by one when
-- the stored value is a JSON object carrying a numeric version.
--
-- WHAT IT DOES NOT TOUCH: receipts already issued. A receipt is a snapshot of
-- the wording at issue time by design (docs/WARRANTY_RECEIPTS.md), so what a
-- customer was handed stays what they were handed.
--
-- IDEMPOTENT. The WHERE clause matches only a value that still carries the
-- Arabic-script name; after one run nothing does, so a second run changes
-- nothing — including the version.
UPDATE admin_settings
SET value = CASE
    WHEN json_valid(REPLACE(REPLACE(value, 'لليفونيس', 'لـ Levonis'), 'ليفونيس', 'Levonis'))
     AND json_type(REPLACE(REPLACE(value, 'لليفونيس', 'لـ Levonis'), 'ليفونيس', 'Levonis')) = 'object'
     AND json_type(REPLACE(REPLACE(value, 'لليفونيس', 'لـ Levonis'), 'ليفونيس', 'Levonis'), '$.version') = 'integer'
    THEN json_set(
      REPLACE(REPLACE(value, 'لليفونيس', 'لـ Levonis'), 'ليفونيس', 'Levonis'),
      '$.version',
      json_extract(value, '$.version') + 1
    )
    ELSE REPLACE(REPLACE(value, 'لليفونيس', 'لـ Levonis'), 'ليفونيس', 'Levonis')
  END
WHERE key = 'warrantyConfig'
  AND value LIKE '%ليفونيس%';
