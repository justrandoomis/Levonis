-- ============================================================================
--  0119 — A STORE ORDER'S THREAD HOLDS ITS CUSTOMER AND ITS SELLER, AND NO 3D
--         PREVIEW LINK OUTLIVES THE 60-MINUTE RULE.
-- ============================================================================
-- Wave 1 review (docs/MERCHANT_PLATFORM.md), findings S3 and S8.
--
-- DATA ONLY, NO SCHEMA CHANGE. One DELETE and one UPDATE, each conditional on
-- the exact shape it repairs, so a second run matches nothing. Before each, a
-- guarded INSERT records in `audit_log` how many rows it is about to touch —
-- written once (its own NOT EXISTS), because a migration that changes live
-- rows should leave the same trace an admin's change does. And only when it
-- WILL touch some: a database with nothing to repair — every fresh one — gets
-- no row at all, so `audit_log` still starts empty.
--
-- ---------------------------------------------------------------------------
--  1. NOBODY BUT THE CUSTOMER AND THE SELLER IS A MEMBER OF A STORE THREAD (S3)
-- ---------------------------------------------------------------------------
-- A merchant-store order's thread belongs to its customer and its seller
-- (worker/routes/chats.ts). Before wave 1 an admin who opened such a thread
-- was silently JOINED to it as a participant (audit 04 B6). The message door
-- now refuses them CHAT_READ_ONLY, and the typing and upload doors ask the
-- same question (`assertMayWriteInThread`) — but the rows themselves still put
-- staff in the thread's member list. They are removed here. Staff keep what
-- the product gives them: an audited, read-only look at the thread, which
-- never needed a participant row.
--
-- "Store thread" is exactly what the route calls one: a chat on an order
-- whose merchant exists (`storeOrderThread`). The shop's OWN order threads,
-- where the admin desk IS the other party, are not touched.
INSERT INTO audit_log (actor_id, action, target, detail)
SELECT NULL, 'migration.0119.store_thread_members_removed', 'chat_participants', json_object('rows', t.n)
  FROM (SELECT COUNT(*) AS n FROM chat_participants cp
         WHERE EXISTS (SELECT 1 FROM chats ch
                         JOIN orders o ON o.id = ch.order_id
                         JOIN community_merchants m ON m.id = o.merchant_id
                        WHERE ch.id = cp.chat_id
                          AND cp.user_id <> o.user_id
                          AND cp.user_id <> m.user_id)) t
 WHERE t.n > 0
   AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'migration.0119.store_thread_members_removed');

DELETE FROM chat_participants
 WHERE EXISTS (SELECT 1 FROM chats ch
                 JOIN orders o ON o.id = ch.order_id
                 JOIN community_merchants m ON m.id = o.merchant_id
                WHERE ch.id = chat_participants.chat_id
                  AND chat_participants.user_id <> o.user_id
                  AND chat_participants.user_id <> m.user_id);

-- ---------------------------------------------------------------------------
--  2. PREVIEW LINKS MINTED UNDER THE OLD WEEK-LONG RULE STOP NOW (S8)
-- ---------------------------------------------------------------------------
-- The viewer-token mint used to take `hours` from the body, up to 168, and
-- wave 1 fixed every new link at 60 minutes (worker/routes/printRequests.ts,
-- VIEWER_TOKEN_TTL_MINUTES). Links minted before that kept their week. Any
-- link still valid more than 60 minutes from now can only be one of those, and
-- is revoked. (The route ALSO refuses, on every use, a link older than 60
-- minutes and a link whose creator has since lost the access it was minted
-- on — this is the sweep of what already exists.)
INSERT INTO audit_log (actor_id, action, target, detail)
SELECT NULL, 'migration.0119.viewer_links_revoked', 'model_view_tokens', json_object('rows', t.n)
  FROM (SELECT COUNT(*) AS n FROM model_view_tokens
         WHERE revoked_at IS NULL
           AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+60 minutes')) t
 WHERE t.n > 0
   AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'migration.0119.viewer_links_revoked');

UPDATE model_view_tokens
   SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE revoked_at IS NULL
   AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+60 minutes');
