/**
 * HAS EITHER OF THESE TWO ACCOUNTS BLOCKED THE OTHER — the one question every
 * social door asks first (worker/routes/communityPosts.ts, chats.ts), kept
 * here so a library the routes depend on (the shared viewer's token resolve,
 * worker/lib/viewerGrants.ts) can ask it too without importing a route.
 */
export async function blockedEither(db: D1Database, a: string, b: string): Promise<boolean> {
  if (!a || !b || a === b) return false;
  const row = await db
    .prepare('SELECT 1 AS x FROM user_blocks WHERE (user_id = ?1 AND blocked_id = ?2) OR (user_id = ?2 AND blocked_id = ?1) LIMIT 1')
    .bind(a, b)
    .first();
  return !!row;
}
