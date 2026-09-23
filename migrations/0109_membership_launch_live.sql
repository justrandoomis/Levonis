-- ============================================================================
--  0109 — «الموقع يعمل»: THE MEMBERSHIP LAUNCH IS ACTIVATED.
-- ============================================================================
-- The owner, on /subscription: «يظهر حجز البطاقة وتفعيل عند اطلاق الموقع وهذا
-- خطأ لأن الموقع يعمل — اجعل البطاقات والاشتراكات تعمل».
--
-- WHY THE PAGE SAID IT. `launchConfig.activated` gated every membership
-- writer (worker/routes/memberships.ts `quotePurchase`, the admin grant, the
-- printer gift): while it was false a paid card was written as
-- `prepaid_pending_launch`, and `getTierStatus` counts only `active` rows — so
-- a customer who paid got no discount, no delivery benefit and no store, and
-- was told «تُفعّل عند إطلاق الموقع» on a site that was already running. No
-- migration had ever written the setting and the code default was `false`,
-- so the only way out was an admin button nobody had pressed.
--
-- WHY A MIGRATION AND NOT ONLY A NEW DEFAULT. The code default changes in the
-- same deploy (DEFAULT_LAUNCH in worker/lib/entitlements.ts), but `getSetting`
-- returns a stored row verbatim when one exists — a database where the admin
-- once saved `activated: false` would keep reserving. This writes the row
-- either way.
--
-- WHAT IT DOES NOT DO: convert the reservations already waiting. A plain
-- UPDATE of `prepaid_pending_launch` rows is unsafe here — the one-active
-- index (0052) covers only 'active', and a legacy account can hold an active
-- row AND a reservation, so a blanket flip could fail half-way or leave two
-- memberships running. The conversion keeps its per-account dedupe in code
-- (worker/lib/launchActivation.ts) and runs the first time each account is
-- read after this applies; the admin button sweeps the rest.
--
-- IDEMPOTENT. A missing row is inserted as activated now. An existing row is
-- rewritten ONLY when it is not already activated, and then keeps any
-- `launch_at` / `activated_at` it already carries. A row that is not a JSON
-- object (hand-edited, truncated) is replaced by a well-formed one, because
-- the reader would otherwise fall back to its default — which is now "live"
-- too, so the two agree.
INSERT INTO admin_settings (key, value)
VALUES (
  'launchConfig',
  json_object(
    'launch_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    'activated', json('true'),
    'activated_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
)
ON CONFLICT(key) DO UPDATE SET value = json_object(
    'launch_at', COALESCE(
      CASE WHEN json_valid(admin_settings.value) AND json_type(admin_settings.value) = 'object'
           THEN json_extract(admin_settings.value, '$.launch_at') END,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ),
    'activated', json('true'),
    'activated_at', COALESCE(
      CASE WHEN json_valid(admin_settings.value) AND json_type(admin_settings.value) = 'object'
           THEN json_extract(admin_settings.value, '$.activated_at') END,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  )
WHERE NOT (
  json_valid(admin_settings.value)
  AND json_type(admin_settings.value) = 'object'
  AND json_extract(admin_settings.value, '$.activated') = 1
);
