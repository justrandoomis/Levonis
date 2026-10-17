-- 0199 — A MERGE THAT VERIFY FAILED AFTER ITS WRITE IS WRITTEN AGAIN ON RESUME (Bambu import spec §B.5, §E.2)
--
-- The live PLA Basic merge was written by a writer that dropped its colour and SKU codes; VERIFY found the
-- product by none of them and BLOCKED it VERIFY_FAILED_PERSISTENT. A resume went straight back to
-- VERIFYING_LIVE, which can only fail again on the same rows. A merge write is idempotent and proves its
-- protected fields unchanged (before_fp_equal), so writing it again is what applies a writer fix to an item
-- already written. This admits exactly that edge, and nothing else:
--
--   BLOCKED, blocker VERIFY_FAILED*, match_kind 'merged', a product, last completed PUBLISHING
--     → WRITING with last_completed_stage back to INGESTING_MEDIA (a retry inside the new write resumes at
--       WRITING, never past it).
--
-- A create is never written twice (IMPORT_DUPLICATE_CREATE) and still resumes at VERIFYING_LIVE. The rule in
-- code: @levonis/catalog/bambuImport/merge `rewritesOnResume` (worker/lib/catalogImport/items.ts, the runner).
-- Both triggers are 0195's, re-created whole with one term each; the guards still fire for every other edge.
-- An older Worker never sends the edge. Re-runnable: each trigger is dropped and created again.

DROP TRIGGER IF EXISTS trg_cii_transition;
CREATE TRIGGER IF NOT EXISTS trg_cii_transition BEFORE UPDATE OF processing_state ON catalog_import_items
WHEN NEW.processing_state IS NOT OLD.processing_state
BEGIN
  SELECT RAISE(ABORT, 'IMPORT_RUN_NOT_OPEN') WHERE NOT EXISTS (
    SELECT 1 FROM catalog_import_runs r WHERE r.id = NEW.run_id AND r.state IN ('open','running','blocked'));
  SELECT RAISE(ABORT, 'IMPORT_ILLEGAL_TRANSITION') WHERE NOT (
       (OLD.processing_state = 'DISCOVERED' AND NEW.processing_state = 'EXTRACTING' AND OLD.last_completed_stage = '')
    OR (OLD.processing_state = 'EXTRACTING'      AND NEW.processing_state = 'ENRICHING')
    OR (OLD.processing_state = 'ENRICHING'       AND NEW.processing_state = 'VALIDATING')
    OR (OLD.processing_state = 'VALIDATING'      AND NEW.processing_state = 'INGESTING_MEDIA')
    OR (OLD.processing_state = 'INGESTING_MEDIA' AND NEW.processing_state = 'WRITING')
    OR (OLD.processing_state = 'WRITING'         AND NEW.processing_state = 'PUBLISHING')
    OR (OLD.processing_state = 'PUBLISHING'      AND NEW.processing_state = 'VERIFYING_LIVE')
    OR (OLD.processing_state = 'VERIFYING_LIVE'  AND NEW.processing_state = 'COMPLETE')
    OR (OLD.processing_state IN ('EXTRACTING','ENRICHING','VALIDATING','INGESTING_MEDIA','WRITING','PUBLISHING','VERIFYING_LIVE')
        AND NEW.processing_state IN ('RETRYING','BLOCKED'))
    OR (OLD.processing_state = 'RETRYING' AND NEW.processing_state = 'BLOCKED')
    OR (OLD.processing_state = 'BLOCKED'  AND NEW.processing_state = 'RETRYING')
    OR (OLD.processing_state IN ('RETRYING','BLOCKED') AND NEW.processing_state = CASE OLD.last_completed_stage
          WHEN '' THEN 'EXTRACTING' WHEN 'EXTRACTING' THEN 'ENRICHING' WHEN 'ENRICHING' THEN 'VALIDATING'
          WHEN 'VALIDATING' THEN 'INGESTING_MEDIA' WHEN 'INGESTING_MEDIA' THEN 'WRITING'
          WHEN 'WRITING' THEN 'PUBLISHING' WHEN 'PUBLISHING' THEN 'VERIFYING_LIVE' ELSE '' END )
    OR (OLD.processing_state = 'BLOCKED' AND OLD.blocker_code = 'SOURCE_WITHDRAWN' AND NEW.processing_state = 'WITHDRAWN_AT_SOURCE')
    -- 0199: a merge that VERIFY failed after its write is written again (the write no longer recorded as done)
    OR (OLD.processing_state = 'BLOCKED' AND OLD.blocker_code GLOB 'VERIFY_FAILED*' AND OLD.match_kind = 'merged'
        AND OLD.levonis_product_id <> '' AND OLD.last_completed_stage = 'PUBLISHING'
        AND NEW.processing_state = 'WRITING' AND NEW.last_completed_stage = 'INGESTING_MEDIA')
    -- a rollback (§A.10): only a COMPLETE item whose product was removed, and only to the END of the queue:
    -- past EVERY other item of the run, the not-yet-processed DISCOVERED ones included (max + 1)
    OR (OLD.processing_state = 'COMPLETE' AND NEW.processing_state = 'DISCOVERED'
        AND NEW.levonis_product_id = '' AND NEW.last_completed_stage = ''
        AND NEW.queue_position > (SELECT COALESCE(MAX(i.queue_position), 0) FROM catalog_import_items i
                                   WHERE i.run_id = NEW.run_id AND i.id <> NEW.id))
  );
END;

DROP TRIGGER IF EXISTS trg_cii_stage_monotonic;
CREATE TRIGGER IF NOT EXISTS trg_cii_stage_monotonic BEFORE UPDATE OF last_completed_stage ON catalog_import_items
WHEN NEW.last_completed_stage IS NOT OLD.last_completed_stage
BEGIN
  SELECT RAISE(ABORT, 'IMPORT_ILLEGAL_TRANSITION') WHERE NOT (
       (NEW.last_completed_stage = OLD.processing_state AND NEW.processing_state = CASE OLD.processing_state
          WHEN 'EXTRACTING' THEN 'ENRICHING' WHEN 'ENRICHING' THEN 'VALIDATING' WHEN 'VALIDATING' THEN 'INGESTING_MEDIA'
          WHEN 'INGESTING_MEDIA' THEN 'WRITING' WHEN 'WRITING' THEN 'PUBLISHING' WHEN 'PUBLISHING' THEN 'VERIFYING_LIVE'
          WHEN 'VERIFYING_LIVE' THEN 'COMPLETE' ELSE '' END )
    OR (NEW.last_completed_stage = '' AND OLD.processing_state = 'COMPLETE' AND NEW.processing_state = 'DISCOVERED')
    -- 0199: the one step back, on the rewrite edge above only
    OR (NEW.last_completed_stage = 'INGESTING_MEDIA' AND OLD.last_completed_stage = 'PUBLISHING' AND OLD.processing_state = 'BLOCKED'
        AND OLD.blocker_code GLOB 'VERIFY_FAILED*' AND OLD.match_kind = 'merged' AND OLD.levonis_product_id <> ''
        AND NEW.processing_state = 'WRITING'));
END;
