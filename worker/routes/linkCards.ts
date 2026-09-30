/**
 * LINK CARDS — /api/link-cards (docs/COMMUNITY_ECOSYSTEM.md §9.4).
 *
 * Two doors over worker/lib/linkCards.ts:
 *
 *   POST /resolve {url}   the AUTHOR's door while composing: signed in, 60 an
 *                         hour per account (it is the only door that can make
 *                         this Worker fetch a page), answers the card.
 *   GET  /?url=           the READER's door: a guest may ask, the answer is the
 *                         STORED row or 404, and it NEVER fetches — a link in a
 *                         public project body is drawn from what the author's
 *                         resolve already learned, so a page full of links
 *                         costs readers nothing and costs the linked host
 *                         nothing either. Wrapped in the anonymous edge cache
 *                         with `url` as its one declared parameter.
 *
 * The chat's own door — POST /api/chats/:id/cards/link — lives in
 * worker/routes/chats.ts beside the message route whose participant check and
 * notification path it shares. Request comments and post bodies need no route
 * of their own: the client resolves while composing and reads cached rows
 * while rendering.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, notFound } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { anonymousCached } from '../lib/edgePolicy';
import { linkCardPublic, normalizeLinkUrl, readLinkCard, resolveLinkCard } from '../lib/linkCards';

export const linkCardRoutes = new Hono<AppContext>();

linkCardRoutes.post('/resolve', requireAuth, async (c) => {
  await rateLimit(c, 'link-card', 60, 3600);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const card = await resolveLinkCard(c.env, body.url);
  return c.json({ success: true, card });
});

linkCardRoutes.get('/', (c) =>
  anonymousCached(c, { params: ['url'] }, async () => {
    // The same normalisation the resolver applies, so the reader's key is the
    // author's key; the refusal codes are the resolver's own.
    const url = normalizeLinkUrl(c.req.query('url'));
    const row = await readLinkCard(c.env.DB, url.toString());
    if (!row) throw notFound('No card for this link yet');
    return c.json({ success: true, card: linkCardPublic(row) });
  })
);
