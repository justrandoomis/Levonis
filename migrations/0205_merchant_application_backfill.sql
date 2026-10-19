-- 0205 — Community V3 push 1.3: EVERY EXISTING MERCHANT APPLIES (owner decisions C1, C2;
-- DECISIONS row 260; design: Community V3 gap analysis §3.9).
--
-- DATA ONLY, NO SCHEMA CHANGE. Migration 0204 made approval a fourth axis and left every existing
-- merchant unapproved on purpose: there is no legacy approval and no default (C1). This file gives
-- each of them a starting point — a DRAFT merchant application, pre-filled with what their store
-- ALREADY shows the public, so applying is finishing a form rather than starting one.
--
-- WHO GETS ONE: a `community_merchants` row with no `approved_at` and NO application at all. A merchant
-- who already has one keeps it exactly as it stands — a live one is theirs to finish, and a rejected or
-- withdrawn one keeps the reviewer's public reason and its «قدّم من جديد» on their screens (C8: they
-- re-apply at once). Nobody is approved here: `approved_at` is not written, by this file or anywhere.
--
-- WHAT IS COPIED — PUBLIC FIELDS ONLY (gap §3.7):
--   public_name   the store's name, else the merchant profile's name (60 characters at most);
--   public_bio    the store's description, else its tagline, else the profile's bio (500 at most);
--   public_links  up to five https addresses the storefront already shows: the visible profile link
--                 pills, then the social links; no address with credentials in its authority, and
--                 none carrying a phone-length run of digits (a wa.me/964… link IS a phone number).
-- NEVER COPIED: the contact phone, the governorate, anything of the store's settings, and every
-- private review value — the legal name, the date of birth, the activity link and the photo are
-- SEALED columns that only the applicant fills (worker/routes/merchantApplication.ts). They stay ''.
--
-- THE TRAIL: each draft gets its 'created' event, by the SYSTEM (no actor id), operation id
-- `backfill:<application id>`. An application the applicant route made always has its event in the
-- same batch, so «an application with no event» is exactly a row this file wrote.
--
-- THE NOTICE is not written here (no migration in this repository writes a notification): the
-- merchant's next workspace load writes it once, id-only (worker/lib/merchantApproval.ts
-- `approvalRequiredNotice`, called from GET /api/merchant/me).
--
-- IDEMPOTENT (migrate-check --twice): both INSERTs are guarded by NOT EXISTS over the table they
-- write, so a second run finds every merchant already holding an application and every backfilled
-- application already holding its event. The partial unique index (one live application per user)
-- is never at risk: only a user with no application at all is selected.

INSERT INTO merchant_applications (id, user_id, state, revision, created_at, updated_at, public_name, public_bio, public_links)
SELECT 'mapp_' || lower(hex(randomblob(10))),
       cm.user_id,
       'draft',
       1,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       substr(trim(COALESCE(NULLIF(trim(s.name), ''), cm.name, '')), 1, 60),
       substr(trim(COALESCE(NULLIF(trim(s.description), ''), NULLIF(trim(s.tagline), ''), cm.bio, '')), 1, 500),
       COALESCE((
         SELECT json_group_array(url) FROM (
           SELECT url FROM (
             SELECT trim(json_extract(w.value, '$.url')) AS url, 0 AS src, CAST(w.key AS INTEGER) AS ord
               FROM json_each(CASE WHEN json_valid(s.profile_links) AND json_type(s.profile_links) = 'array'
                                   THEN s.profile_links ELSE '[]' END ) w
              WHERE w.type = 'object' AND COALESCE(json_extract(w.value, '$.visible'), 1) <> 0
             UNION ALL
             SELECT trim(l.value), 1, 0
               FROM json_each(CASE WHEN json_valid(s.social_links) AND json_type(s.social_links) = 'object'
                                   THEN s.social_links ELSE '{}' END ) l
              WHERE l.type = 'text'
           )
           WHERE url LIKE 'https://_%' AND length(url) <= 300 AND instr(url, ' ') = 0
             AND url NOT GLOB '*[0-9][0-9][0-9][0-9][0-9][0-9][0-9]*'
             AND instr(substr(url, 9, CASE WHEN instr(substr(url, 9), '/') > 0
                                           THEN instr(substr(url, 9), '/') - 1 ELSE 300 END ), '@') = 0
           GROUP BY url
           ORDER BY MIN(src), MIN(ord)
           LIMIT 5
         )
       ), '[]')
  FROM community_merchants cm
  LEFT JOIN merchant_stores s ON s.merchant_id = cm.id
 WHERE cm.approved_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM merchant_applications a WHERE a.user_id = cm.user_id);

INSERT INTO merchant_application_events (id, application_id, revision, actor_id, actor_kind, action, at, operation_id)
SELECT 'mape_' || lower(hex(randomblob(10))),
       a.id,
       a.revision,
       NULL,
       'system',
       'created',
       a.created_at,
       'backfill:' || a.id
  FROM merchant_applications a
 WHERE a.state = 'draft'
   AND NOT EXISTS (SELECT 1 FROM merchant_application_events e WHERE e.application_id = a.id);
