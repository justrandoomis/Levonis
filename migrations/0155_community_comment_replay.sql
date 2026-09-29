-- ============================================================================
--  0155 — A COMMENT'S REPLAY KEY, AND THE CREATORS LIST'S INDEX (Phase 2 review)
-- ============================================================================
-- Two doubled taps of «إرسال» used to be caught by a SELECT of the author's
-- last comment under the post and then an INSERT — a check that two
-- concurrent requests both pass, so the one comment landed twice, and with it
-- the counter and the author's notification. The client already names each
-- send (`client_id`, the chat's 0150 pattern); this stores that name and lets
-- the database refuse the second landing: the retry re-reads the row it
-- already made and answers it as a replay. '' is a send without a name (an
-- old client, a script), which the partial index leaves alone.
--
-- ADDITIVE: one column with a default, two indexes.
-- ============================================================================
ALTER TABLE community_comments ADD COLUMN client_id TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_comments_client
  ON community_comments(post_id, author_id, client_id) WHERE client_id <> '';

-- The creators list starts from the accounts WITH a page (creator_public = 1,
-- or a live merchant) instead of ranging over every user with a username.
CREATE INDEX IF NOT EXISTS idx_users_creator_public ON users(creator_public) WHERE creator_public = 1;
