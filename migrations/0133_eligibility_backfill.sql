-- ============================================================================
--  0133 — ELIGIBILITY AS DATA: THE BACKFILL OF 0132.
-- ============================================================================
-- Stream W5-B. Four UPDATE/INSERT statements over existing rows, each one
-- idempotent (a re-run changes nothing it already changed). No row is
-- deleted, no money row is touched, and no merchant's eligibility is decided
-- here: that is worker/lib/eligibility.ts's job, run by the re-match queue.
--
-- 1. PRINTERS TYPED AS A KNOWN MACHINE ARE TIED TO IT. A printer whose brand
--    and model text equal a canonical row's manufacturer and model (trimmed,
--    case-insensitive) AND whose technology matches is linked to that row
--    (`model_id`), and its physical columns take the row's values — the
--    canonical physics win over the typed ones from here on (0078 §2: «economics
--    yes, physics no»). Anything not an exact match stays a self-declared
--    machine, shown as such to its merchant, who can link it in one tap.
--
-- 2. EVERY RECORDED VERDICT NAMES ITS REVISION. The rows the matcher wrote
--    before W5-B were decided for the request as it stood at its last publish,
--    which is its current revision (a later revision re-ran the matcher), so
--    they are stamped with it; `engine` stays 1 until they are decided again.
--
-- 3. EVERY OPEN REQUEST IS QUEUED FOR A RE-MATCH, so its verdicts are decided
--    by engine 2 — stock, delivery reach and plan included — by the scheduled
--    sweep within a few ticks. Until then the offer route asks the live
--    verdict anyway, so no stale row can let an offer through.
--
-- 4. EVERY UNBOUND 3D-PREVIEW LINK STOPS. They live 60 minutes at most
--    (0119), and from W5-B a link is bound to the account and the revision it
--    was minted for; an older one carries neither, so it is revoked rather than
--    grandfathered. Whoever was looking mints a new one with one tap.
-- ============================================================================

UPDATE merchant_printers
   SET model_id = (
         SELECT pm.id FROM printer_models pm
          WHERE lower(trim(pm.manufacturer)) = lower(trim(merchant_printers.brand))
            AND lower(trim(pm.model)) = lower(trim(merchant_printers.model))
            AND pm.technology = merchant_printers.technology
            AND pm.merchant_selectable = 1
          ORDER BY pm.sort_order LIMIT 1)
 WHERE model_id IS NULL
   AND trim(brand) <> '' AND trim(model) <> ''
   AND EXISTS (
         SELECT 1 FROM printer_models pm
          WHERE lower(trim(pm.manufacturer)) = lower(trim(merchant_printers.brand))
            AND lower(trim(pm.model)) = lower(trim(merchant_printers.model))
            AND pm.technology = merchant_printers.technology
            AND pm.merchant_selectable = 1);

UPDATE merchant_printers
   SET build_x_mm = (SELECT pm.build_x_mm FROM printer_models pm WHERE pm.id = merchant_printers.model_id),
       build_y_mm = (SELECT pm.build_y_mm FROM printer_models pm WHERE pm.id = merchant_printers.model_id),
       build_z_mm = (SELECT pm.build_z_mm FROM printer_models pm WHERE pm.id = merchant_printers.model_id),
       enclosed   = (SELECT pm.enclosed FROM printer_models pm WHERE pm.id = merchant_printers.model_id),
       hardened_nozzle = CASE
         WHEN (SELECT pm.hardened_nozzle_available FROM printer_models pm WHERE pm.id = merchant_printers.model_id) = 1
         THEN hardened_nozzle ELSE 0 END
 WHERE model_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM printer_models pm WHERE pm.id = merchant_printers.model_id);

UPDATE community_request_matches
   SET revision = COALESCE((SELECT r.revision FROM community_requests r
                             WHERE r.id = community_request_matches.request_id), 0),
       reasons = CASE WHEN reject_reason <> '' THEN json_array(reject_reason) ELSE '[]' END,
       notify_ok = eligible,
       computed_at = COALESCE(computed_at, created_at)
 WHERE engine = 1 AND revision = 0;

INSERT OR IGNORE INTO community_match_queue (kind, subject_id, reason)
SELECT 'request', r.id, 'backfill'
  FROM community_requests r
 WHERE r.state IN ('open','receiving_offers') AND r.visibility = 'public';

UPDATE model_view_tokens
   SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE revoked_at IS NULL AND bound_user = 0;
