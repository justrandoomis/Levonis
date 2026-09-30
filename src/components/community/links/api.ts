/**
 * LINK CARDS — the client's typed doors to worker/routes/linkCards.ts and the
 * chat's link route in worker/routes/chats.ts (docs/COMMUNITY_ECOSYSTEM.md
 * §9.4 "Link cards").
 *
 * Three doors, and which one a screen calls is the whole design:
 *
 *   resolveLink(url)         the AUTHOR, while composing — signed in, rate
 *                            limited; the only call that can make the server
 *                            fetch a page. A chat composer, a request comment
 *                            box, the project editor.
 *   cachedLink(url)          a READER, while rendering — a guest may ask; the
 *                            answer is what an author's resolve already learned
 *                            or null, and the server never fetches for it. A
 *                            page of links costs the linked hosts nothing.
 *   postChatLink(...)        the chat's own send: resolve + message in one
 *                            server-side step, replayable by `client_id`.
 *
 * The picture is ALWAYS ours: `image_url` is `/files/link-cards/<id>.webp` or
 * null — never the source's address, so a card never sends a reader's browser
 * to the pasted host. Render the card with `rel="noopener noreferrer
 * nofollow"` and `target="_blank"`; the `model_page` kind offers «اطلب
 * طباعته», which pre-fills the request wizard's link source.
 *
 * Refusal codes these doors raise — map them through src/lib/refusalStrings.ts:
 * LINK_URL_INVALID (not a web address: javascript:, data:, a bare word),
 * LINK_HOST_BLOCKED (a well-formed address the server will not touch), and
 * LINK_FETCH_FAILED — which is NOT thrown: it arrives as `card.reason` on a
 * card whose `status` is 'failed', so the composer can explain «تعذّر جلب
 * المعاينة» and still offer to send the bare link.
 */
import { api, ApiError, type RequestOptions } from '../../../lib/api';

export type LinkCardKind = 'model_page' | 'video' | 'article' | 'unknown';
export type LinkCardStatus = 'ok' | 'blocked' | 'failed';

export interface LinkCard {
  id: string;
  /** The canonical address (fragment dropped, share-tracking parameters stripped). */
  url: string;
  /** The host line: `printables.com`, never with `www.`. */
  host: string;
  title: string;
  description: string;
  /** `/files/link-cards/<id>.webp` — our copy — or null. Never hot-linked. */
  image_url: string | null;
  kind: LinkCardKind;
  /** `ok` fetched · `blocked` a host outside the preview list (a bare card) · `failed` retried in an hour. */
  status: LinkCardStatus;
  fetched_at: string;
  reason: 'LINK_FETCH_FAILED' | null;
}

/** The link as a chat message carries it (`message.link`); the card as it was when sent. */
export interface ChatLink {
  card_id: string;
  url: string;
  host: string;
  title: string;
  description: string;
  image_url: string | null;
  kind: LinkCardKind;
}

/** The longest address the server accepts — 2 KB. */
export const LINK_URL_MAX = 2048;

/** The author's door: resolve (and, for a listed host, fetch) the card for an address. */
export async function resolveLink(url: string, opts?: RequestOptions): Promise<LinkCard> {
  const res = await api.post<{ success: true; card: LinkCard }>('/api/link-cards/resolve', { url }, opts);
  return res.card;
}

/**
 * The reader's door: the stored card for an address, or null when nobody has
 * resolved it yet. Never causes a fetch. A refused address (a `javascript:`
 * scheme in somebody's text) also answers null — a reader is not the one to
 * tell about it.
 */
export async function cachedLink(url: string, opts?: RequestOptions): Promise<LinkCard | null> {
  try {
    const res = await api.get<{ success: true; card: LinkCard }>(`/api/link-cards?url=${encodeURIComponent(url)}`, opts);
    return res.card;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return null;
    throw e;
  }
}

export interface PostedChatLink {
  id: string;
  /** The stored message in the thread's own shape — `message.link` is the card. */
  message: { id: string; link: ChatLink | null } & Record<string, unknown>;
  card?: LinkCard;
  /** True when this `client_id` had already been stored: the same message, not a second one. */
  replayed?: boolean;
}

/** The chat's send: the server resolves the address and writes the line with its card, once per `client_id`. */
export function postChatLink(chatId: string, url: string, clientId: string, opts?: RequestOptions): Promise<PostedChatLink> {
  return api.post<PostedChatLink>(`/api/chats/${encodeURIComponent(chatId)}/cards/link`, { url, client_id: clientId }, opts);
}

/**
 * The http(s) addresses in a piece of text, in order, de-duplicated and
 * capped — what a comment or a project body hands to `cachedLink` (and what
 * a composer hands to `resolveLink` as the author types). Trailing
 * punctuation that prose attaches to a link («انظر https://x.com/a.») is
 * not part of it.
 */
export function linksInText(text: string, max = 3): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'«»]+/gi)) {
    const url = m[0].replace(/[.,;:!?)\]}؟،]+$/u, '');
    if (url.length > LINK_URL_MAX || out.includes(url)) continue;
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}
