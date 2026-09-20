-- «لا يوجد حد أدنى لأي طلب طباعة» — the owner's ruling, applied to the rows
-- that already carry a floor.
--
-- WHY A MIGRATION AND NOT JUST A NEW DEFAULT. `getSetting` returns the stored
-- admin_settings row VERBATIM when one exists and falls back to the code
-- default only when it does not (worker/lib/settings.ts). So changing
-- DEFAULT_PRICING.min_job_iqd to 0 fixes a database nobody has ever saved
-- these settings in — and does nothing at all to this one, where the admin
-- screen has been saved and the 5,000 د.ع floor is sitting in JSON. Without
-- this file the deploy would ship a decision the live site ignores.
--
-- WHY THE FIELDS ARE ZEROED AND NOT REMOVED. A decision is not a capability:
-- both floors stay editable in the admin, so the owner can put one back on a
-- single material tomorrow without a deploy. Deleting the keys would also make
-- the stored object disagree in SHAPE with PrintPricingConfig, and the read
-- side does not merge over defaults for this key.
--
-- Both statements are guarded on json_valid so a hand-edited or truncated row
-- cannot be turned into something the parser then rejects, and the print
-- pricing screen fall back to the seeded defaults if it ever is.

-- 1. The platform floor, one scalar inside one object.
UPDATE admin_settings
   SET value = json_set(value, '$.min_job_iqd', 0)
 WHERE key = 'printPricingConfig'
   AND json_valid(value)
   AND json_type(value) = 'object'
   AND json_extract(value, '$.min_job_iqd') IS NOT NULL
   AND json_extract(value, '$.min_job_iqd') > 0;

-- 2. The per-material floor, one scalar inside every element of an array.
--    json_each walks the array, json_set rewrites each element, and
--    json_group_array(json(...)) reassembles it as JSON rather than as an
--    array of strings — the ONE detail that turns this from a fix into
--    corruption, because without the json() wrapper every material would come
--    back double-encoded and the catalogue would read as empty.
UPDATE admin_settings
   SET value = (
         SELECT json_group_array(json(json_set(e.value, '$.min_economic_iqd', 0)))
           FROM json_each(admin_settings.value) AS e
       )
 WHERE key = 'printMaterials'
   AND json_valid(value)
   AND json_type(value) = 'array'
   AND EXISTS (
         SELECT 1 FROM json_each(admin_settings.value) AS e
          WHERE json_extract(e.value, '$.min_economic_iqd') > 0
       );
