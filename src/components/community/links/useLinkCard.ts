/**
 * ONE ASK PER ADDRESS — the reader's side of link cards (docs/COMMUNITY_ECOSYSTEM.md
 * §9.4 "Link cards").
 *
 * A page of thirty posts may name the same model page thirty times, and a
 * comment thread the same video in every reply. Each address is asked of
 * `GET /api/link-cards?url=` ONCE for the life of the page — the promise is
 * memoised in a module Map, so the second card for an address shares the
 * first's answer, and a re-mount (a feed page appended, a sheet reopened)
 * reads the settled value without a request. A 404 (nobody has resolved it
 * yet), a 400 (not an address the server will discuss) and a network failure
 * all settle as null: the row draws nothing, and does not ask again. The
 * server never fetches for a reader (worker/routes/linkCards.ts), so this is
 * the whole cost of a link in a body: one cheap GET per distinct address.
 *
 * `warmLink` is the author's side: called while composing (on paste), it
 * resolves through `POST /api/link-cards/resolve` — the only door that makes
 * the server fetch a page — and seeds the memo, so the card is drawn the
 * moment the post or comment is published, without a round trip.
 */
import { useEffect, useState } from 'react';
import { cachedLink, linksInText, resolveLink, type LinkCard } from './api';

const inflight = new Map<string, Promise<LinkCard | null>>();
const settled = new Map<string, LinkCard | null>();

/** The stored card for an address — asked of the server once per page, whatever the answer. */
export function cachedLinkOnce(url: string): Promise<LinkCard | null> {
  if (settled.has(url)) return Promise.resolve(settled.get(url) ?? null);
  let p = inflight.get(url);
  if (!p) {
    p = cachedLink(url)
      .catch(() => null)
      .then((card) => {
        settled.set(url, card);
        inflight.delete(url);
        return card;
      });
    inflight.set(url, p);
  }
  return p;
}

/** The author's door: resolve (and let the server fetch) now, so readers find the card warm. */
export async function warmLink(url: string): Promise<LinkCard | null> {
  try {
    const card = await resolveLink(url);
    settled.set(url, card);
    return card;
  } catch {
    return null;
  }
}

/** The first http(s) address in a piece of text, or null. */
export function firstLink(text: string | null | undefined): string | null {
  if (!text) return null;
  return linksInText(text, 1)[0] ?? null;
}

/**
 * A paste handler for a composer: every address in the pasted text is
 * warmed, at most three (the same cap `linksInText` gives a body). Nothing
 * else about the paste changes — the text lands as typed.
 */
export function warmLinksOnPaste(e: { clipboardData: { getData: (type: string) => string } | null }): void {
  const text = e.clipboardData?.getData('text') ?? '';
  for (const url of linksInText(text, 3)) void warmLink(url);
}

/**
 * The card for an address: `undefined` while the one ask is out, `null`
 * when there is none to draw, the card otherwise. `null` in, `null` out.
 */
export function useLinkCard(url: string | null): LinkCard | null | undefined {
  const [card, setCard] = useState<LinkCard | null | undefined>(() => (url ? (settled.has(url) ? settled.get(url) : undefined) : null));
  useEffect(() => {
    if (!url) {
      setCard(null);
      return;
    }
    let alive = true;
    setCard(settled.has(url) ? settled.get(url) : undefined);
    void cachedLinkOnce(url).then((c) => {
      if (alive) setCard(c);
    });
    return () => {
      alive = false;
    };
  }, [url]);
  return url ? card : null;
}

/** How many addresses this page has asked about — a test seam. */
export function linkCardMemoSize(): number {
  return settled.size + inflight.size;
}

/** Forget every answer — between tests only. */
export function resetLinkCards(): void {
  inflight.clear();
  settled.clear();
}
