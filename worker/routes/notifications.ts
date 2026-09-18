import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { badRequest, oneOf, requireAuth, str, int } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { listNotifications, markRead, unreadCount } from '../lib/notifications';
import { channelReadiness, setPrimaryChannelStatements, type ChannelId } from '../lib/channelReadiness';

/** The four channels the schema's CHECK admits (migration 0092). Declared here
 *  as the request validator's allowlist so a body can never write a fifth and
 *  discover the constraint as a 500. */
const CHANNEL_IDS = ['inapp', 'telegram', 'whatsapp', 'email'] as const satisfies readonly ChannelId[];

/**
 * THE NOTIFICATION INBOX.
 *
 * Small on purpose. A notification is a pointer: a title, a line of context and
 * a link back to the thing it is about. Everything else — the request, the
 * offer, the order — is fetched from the route that owns it, so this endpoint
 * can never become a second, staler copy of the data it points at.
 *
 * Every query is scoped to `c.get('user').id` in SQL, so a guessed id belonging
 * to someone else returns nothing and marks nothing.
 */

export const notificationRoutes = new Hono<AppContext>();
notificationRoutes.use('*', requireAuth);

notificationRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const q = c.req.query();
  const limit = int(q.limit, 'limit', { min: 1, max: 50, def: 25 });
  const before = str(q.before, 'before', { max: 40, required: false }) ?? '';
  const [items, unread] = await Promise.all([
    listNotifications(c.env.DB, user.id, {
      limit,
      before: before || undefined,
      unreadOnly: q.unread === '1',
    }),
    unreadCount(c.env.DB, user.id),
  ]);
  return c.json({
    success: true,
    unread,
    notifications: items.map((n) => ({
      id: n.id,
      kind: n.kind,
      title_ar: n.title_ar,
      title_en: n.title_en,
      body_ar: n.body_ar,
      body_en: n.body_en,
      link: n.link,
      entity_type: n.entity_type,
      entity_id: n.entity_id,
      read: n.read_at !== null,
      created_at: n.created_at,
    })),
    // The cursor is the oldest row returned; absent when the page was short,
    // which is how the client knows it has reached the end.
    next_before: items.length === limit ? items[items.length - 1].created_at : null,
  });
});

/** Just the badge. Cheap enough to poll, and backed by a partial index. */
notificationRoutes.get('/unread-count', async (c) => {
  const user = c.get('user')!;
  return c.json({ success: true, unread: await unreadCount(c.env.DB, user.id) });
});

notificationRoutes.post('/read', async (c) => {
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = str(body.id, 'id', { max: 60, required: false }) ?? '';
  const changed = await markRead(c.env.DB, user.id, id || undefined);
  return c.json({ success: true, marked: changed, unread: await unreadCount(c.env.DB, user.id) });
});

// ---------------------------------------------------------------------------
//  WHERE A MESSAGE GOES — /api/notifications/channels
// ---------------------------------------------------------------------------

/**
 * THE READINESS ANSWER, AND WHY IT MUST NEVER BE CACHED.
 *
 * Readiness is the AND of two facts that both change out from under a cached
 * copy: whether this DEPLOYMENT can carry a channel, and whether this ACCOUNT
 * has somewhere for it to land. The second flips the instant somebody finishes
 * linking Telegram — which is the exact moment they come back to this screen to
 * check. A cached «not ready» there is what makes a person redo an activation
 * they have already completed, decide it is broken, and stop.
 *
 * `no-store` and not `no-cache`: `no-cache` still permits a stored copy that is
 * revalidated, and this response carries a masked destination, so there is
 * nothing to gain from letting an intermediary hold one at all.
 */
notificationRoutes.get('/channels', async (c) => {
  const user = c.get('user')!;
  const readiness = await channelReadiness(c.env, user.id);
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, ...readiness });
});

/**
 * PUT /channels — the customer's own choice of where to be told.
 *
 * PREFERENCE ONLY, NEVER CAPABILITY. Enabling a channel here does not make it
 * ready and is not allowed to pretend otherwise: `channelReadiness` intersects
 * the choice with what can actually deliver, and the response is that same
 * readiness answer rather than an echo of what was sent — so a person who
 * switches on email without a verified address sees immediately that nothing
 * changed about where their messages will go.
 *
 * AN EMPTY LIST IS A VALID CHOICE and is stored as such: every channel off. It
 * is not treated as "no preference", because that is how a person who
 * deliberately silenced everything gets the full fan-out back on the next
 * notification. The sweep's floor rule (worker/lib/stockAlerts.ts §5) reads the
 * same table and leaves an alert ARMED rather than consuming it when nothing is
 * left that can carry the message.
 *
 * `primary` IS AN EXPLICIT ACTIVATION — the only kind that may write it (see
 * `setPrimaryChannelStatements`). It must be one of the channels being switched
 * on: a preferred channel that is simultaneously switched off is two
 * contradictory instructions in one request, and guessing which one was meant
 * is how a person ends up with messages going somewhere they turned off.
 */
notificationRoutes.put('/channels', async (c) => {
  await rateLimit(c, 'notify-channels', 20, 600);
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const raw = body.channels;
  if (!Array.isArray(raw)) throw badRequest('channels must be an array', 'BAD_CHANNELS');
  if (raw.length > CHANNEL_IDS.length) throw badRequest('channels has too many items', 'BAD_CHANNELS');
  const wanted = new Set<ChannelId>(raw.map((v) => oneOf(v, 'channels', CHANNEL_IDS)));

  const primaryRaw = body.primary;
  const primary =
    primaryRaw === undefined || primaryRaw === null || primaryRaw === ''
      ? null
      : oneOf(primaryRaw, 'primary', CHANNEL_IDS);
  if (primary && !wanted.has(primary)) {
    throw badRequest('primary must be one of the enabled channels', 'PRIMARY_NOT_ENABLED');
  }

  const stmts: D1PreparedStatement[] = CHANNEL_IDS.map((channel) =>
    c.env.DB.prepare(
      `INSERT INTO user_notification_channels (user_id, channel, enabled, is_primary, updated_at)
       VALUES (?, ?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(user_id, channel) DO UPDATE SET
         enabled = excluded.enabled,
         -- A channel that has just been switched off cannot stay the preferred
         -- one. Left alone, is_primary = 1 beside enabled = 0 is a row that says
         -- two opposite things, and every reader has to remember which wins.
         is_primary = CASE WHEN excluded.enabled = 1 THEN user_notification_channels.is_primary ELSE 0 END,
         updated_at = excluded.updated_at`
    ).bind(user.id, channel, wanted.has(channel) ? 1 : 0)
  );
  if (primary) stmts.push(...setPrimaryChannelStatements(c.env.DB, user.id, primary));

  await c.env.DB.batch(stmts);

  // The readiness answer, not an echo: what was STORED is a preference, and the
  // only useful thing to render afterwards is where messages will now actually
  // go.
  const readiness = await channelReadiness(c.env, user.id);
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, ...readiness });
});
