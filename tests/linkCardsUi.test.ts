/**
 * LINK CARDS ON THE SCREEN (docs/COMMUNITY_ECOSYSTEM.md §9.4 "Link cards",
 * Phase 4 client) — src/components/community/links/{LinkCard,useLinkCard,
 * LinkSheet,strings} and the surfaces that mount them.
 *
 *   the words: every key in ar, en AND real Sorani, never the Arabic pasted
 *   across;
 *   the render (`renderToStaticMarkup`, the technique of
 *   tests/ordersListUi.test.ts): a card without a picture is still a card;
 *   the anchor opens in a new tab with `rel="noopener noreferrer nofollow"`;
 *   the picture is drawn only from OUR copy (`/files/…`), never the pasted
 *   host; «اطلب طباعته» on a model page only, into the wizard with `?link=`
 *   (a guest through sign-in first); a bare card stands on its host;
 *   the reader's ask: `GET /api/link-cards?url=` ONCE per address per page
 *   whatever the answer — a 404 draws nothing and is not asked again; a
 *   network failure likewise; the author's paste warms the memo through
 *   `POST /resolve` so no reader GET follows;
 *   the pins: the chat sends through `postChatLink` and draws `message.link`,
 *   the feed card, the project page and the comments mount `LinkRow`, the
 *   two composers warm on paste, the wizard reads `?link=`, the chat's clock
 *   speaks `ckb` (A9), tokens only in the links folder.
 *
 * Run: node --import tsx --test tests/linkCardsUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import type { LinkCard as LinkCardData } from '../src/components/community/links/api';

// The language provider reads `levo_lang` from localStorage on mount; a stub
// lets each render pick its language the way the browser fixtures do.
let storedLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? storedLang : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};
const { LanguageProvider } = await import('../src/LanguageContext');
const { AuthContext } = await import('../src/AuthContext');
const { LinkCard, LinkRow, ownImage, printRequestPath } = await import('../src/components/community/links/LinkCard');
const { cachedLinkOnce, firstLink, linkCardMemoSize, resetLinkCards, warmLink, warmLinksOnPaste } = await import('../src/components/community/links/useLinkCard');
const { LINK_STRINGS, linkStrings, hostLine } = await import('../src/components/community/links/strings');
const { looksLikeLink } = await import('../src/components/community/links/LinkSheet');

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** Source without comments, so a sentence ABOUT a pattern cannot satisfy or trip a check. */
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const KURDISH = /[ەۆێڕڵڤگچپژیک]/;

const auth = (isAuthenticated: boolean) => ({
  isAuthenticated,
  user: isAuthenticated ? { id: 'u1', username: 'eve', name: 'Eve' } : null,
  login: async () => {},
  loginWithGoogle: async () => {},
  register: async () => {},
  refreshUser: async () => {},
  logout: async () => {},
  isLoaded: true,
});
const html = (node: ReactNode, lang: 'ar' | 'en' | 'ckb' = 'ar', signedIn = true) => {
  storedLang = lang;
  return renderToStaticMarkup(
    createElement(AuthContext.Provider, { value: auth(signedIn) as never }, createElement(LanguageProvider, { children: createElement(MemoryRouter, null, node) }))
  );
};
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

const MODEL = 'https://www.printables.com/model/1234-articulated-dragon';
const card = (over: Partial<LinkCardData> = {}): LinkCardData => ({
  id: 'lc_1',
  url: MODEL,
  host: 'printables.com',
  title: 'Articulated Dragon v2',
  description: 'A two-colour dragon with 24 joints.',
  image_url: null,
  kind: 'model_page',
  status: 'ok',
  fetched_at: '2026-09-29T10:00:00.000Z',
  reason: null,
  ...over,
});

// ------------------------------------------------------------------ words

test('every word exists in ar, en and real Sorani — no Arabic standing in for ckb', () => {
  const keys = Object.keys(LINK_STRINGS.ar);
  for (const lang of ['en', 'ckb'] as const) assert.deepEqual(Object.keys(LINK_STRINGS[lang]).sort(), [...keys].sort(), `${lang} has the same keys`);
  const flat = (o: Record<string, unknown>): string[] => Object.values(o).flatMap((v) => (typeof v === 'string' ? [v] : flat(v as Record<string, unknown>)));
  const ar = flat(LINK_STRINGS.ar as unknown as Record<string, unknown>);
  const ckb = flat(LINK_STRINGS.ckb as unknown as Record<string, unknown>);
  let distinctive = 0;
  ckb.forEach((v, i) => {
    if (/^https?:/.test(v)) return; // the placeholder is an address in every language
    assert.notEqual(v, ar[i], `ckb «${v}» is the Arabic pasted across`);
    if (KURDISH.test(v)) distinctive += 1;
  });
  // «ناردن» (send) is Sorani spelt with letters Arabic shares; the rest carry a letter Arabic lacks.
  assert.ok(distinctive >= ckb.length - 2, `only ${distinctive} of ${ckb.length} Sorani strings carry a Sorani letter`);
  for (const k of ['link', 'sendLink', 'urlLabel', 'send', 'sending', 'invalidUrl', 'fetchFailed', 'opensNewTab', 'print', 'open', 'noPreview'] as const) {
    assert.ok(LINK_STRINGS.ar[k] && LINK_STRINGS.en[k] && LINK_STRINGS.ckb[k], `${k} in all three`);
  }
  assert.equal(linkStrings('fr').print, LINK_STRINGS.ar.print, 'an unknown language falls back to Arabic');
  assert.equal(hostLine(LINK_STRINGS.ar, 'printables.com'), 'من printables.com');
});

// ----------------------------------------------------------------- render

test('a card without a picture is still a card: title, kind, host, and a safe anchor', () => {
  const out = html(createElement(LinkCard, { card: card({ kind: 'video', host: 'youtu.be', url: 'https://youtu.be/x1' }) }));
  assert.equal(count(out, /<img/g), 0, 'no picture, no <img>');
  assert.match(out, /Articulated Dragon v2/);
  assert.match(out, /من youtu\.be/, 'the host line');
  assert.match(out, /فيديو/, 'the kind as a label');
  assert.match(out, /<a[^>]+href="https:\/\/youtu\.be\/x1"[^>]*target="_blank"[^>]*rel="noopener noreferrer nofollow"/, 'target + rel on the one anchor');
  assert.match(out, /يفتح في نافذة جديدة/, 'the screen reader hears where it goes');
  assert.equal(count(out, /data-link-print/g), 0, 'a video offers no print');
  assert.match(out, /data-link-card="?"?[^>]*data-link-variant="compact"/);
});

test('the picture is only ever our copy — a pasted host is never hot-linked', () => {
  assert.equal(ownImage('/files/link-cards/lc_1.webp'), '/files/link-cards/lc_1.webp');
  assert.equal(ownImage('https://cdn.printables.com/og.png'), null);
  assert.equal(ownImage(null), null);
  const ours = html(createElement(LinkCard, { card: card({ image_url: '/files/link-cards/lc_1.webp' }) }));
  assert.match(ours, /<img[^>]+src="\/files\/link-cards\/lc_1\.webp"/);
  const theirs = html(createElement(LinkCard, { card: card({ image_url: 'https://cdn.printables.com/og.png' }) }));
  assert.equal(count(theirs, /<img/g), 0);
  assert.doesNotMatch(theirs, /cdn\.printables\.com/);
});

test('«اطلب طباعته» on a model page only, into the wizard with ?link= — a guest through sign-in first', () => {
  assert.equal(printRequestPath(MODEL), `/requests?view=new&link=${encodeURIComponent(MODEL)}`);
  const door = (out: string) => out.match(/<a[^>]*data-link-print[^>]*>/)?.[0] ?? '';
  const signedIn = html(createElement(LinkCard, { card: card() }));
  assert.ok(door(signedIn).includes(`href="/requests?view=new&amp;link=${encodeURIComponent(MODEL)}"`), `the door carries the link: ${door(signedIn)}`);
  assert.match(signedIn, /اطلب طباعته/);
  const guest = html(createElement(LinkCard, { card: card() }), 'ar', false);
  assert.ok(door(guest).includes('href="/auth"'), `a guest signs in first, the wizard remembered in state: ${door(guest)}`);
  const article = html(createElement(LinkCard, { card: card({ kind: 'article' }) }));
  assert.equal(count(article, /data-link-print/g), 0);
  const silenced = html(createElement(LinkCard, { card: card(), printDoor: false }));
  assert.equal(count(silenced, /data-link-print/g), 0);
  // the wizard really reads it
  assert.match(code('src/pages/Requests.tsx'), /params\.get\('link'\)/, 'Requests.tsx reads ?link=');
  // Sorani and English doors say it in their own words
  assert.match(html(createElement(LinkCard, { card: card() }), 'ckb'), /داوای چاپکردنی بکە/);
  assert.match(html(createElement(LinkCard, { card: card() }), 'en'), /Request a print/);
});

test('a bare card (no title) stands on its host; the full variant adds the description and the picture on top', () => {
  const bare = html(createElement(LinkCard, { card: card({ title: '', description: '', kind: 'unknown', host: 'example.org', url: 'https://example.org/n' }) }));
  assert.match(bare, /example\.org/);
  assert.doesNotMatch(bare, /من example\.org/, 'no host line under a host-as-title');
  assert.match(bare, />رابط</, 'the kind label says it is a link');
  const full = html(createElement(LinkCard, { card: card({ image_url: '/files/link-cards/lc_1.webp' }), variant: 'full' }));
  assert.match(full, /data-link-variant="full"/);
  assert.match(full, /A two-colour dragon with 24 joints\./, 'the description');
  assert.match(full, /<img[^>]+class="[^"]*aspect-video/, 'the picture on top');
  const compact = html(createElement(LinkCard, { card: card() }));
  assert.doesNotMatch(compact, /A two-colour dragon/, 'compact keeps to title and host');
});

// -------------------------------------------------------------- the ask

interface Hit {
  method: string;
  path: string;
}
function stubFetch(answer: (hit: Hit, body: unknown) => Response | Error): Hit[] {
  const hits: Hit[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const hit = { method: (init?.method ?? 'GET').toUpperCase(), path: url };
    hits.push(hit);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const res = answer(hit, body);
    if (res instanceof Error) throw res;
    return res;
  }) as typeof fetch;
  return hits;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('a cached GET that answers 404 renders nothing — and the address is not asked again', async () => {
  resetLinkCards();
  const hits = stubFetch(() => json(404, { success: false, error: 'not found', code: 'NOT_FOUND' }));
  const url = 'https://example.org/notes/42';
  assert.equal(await cachedLinkOnce(url), null);
  assert.equal(await cachedLinkOnce(url), null);
  assert.equal(hits.length, 1, 'one ask, whatever the answer');
  assert.equal(hits[0].path, `/api/link-cards?url=${encodeURIComponent(url)}`);
  const out = html(createElement(LinkRow, { text: `see ${url} please` }));
  assert.equal(out, '', 'nothing drawn for a link nobody resolved');
  // a 400 (an address the server will not discuss) is the same silence
  const bad = stubFetch(() => json(400, { success: false, error: 'invalid', code: 'LINK_URL_INVALID' }));
  assert.equal(await cachedLinkOnce('https://example.org/other'), null);
  assert.equal(bad.length, 1);
  // a network failure too: null, once, no storm
  const down = stubFetch(() => new TypeError('offline'));
  assert.equal(await cachedLinkOnce('https://example.org/down'), null);
  assert.equal(await cachedLinkOnce('https://example.org/down'), null);
  assert.equal(down.length, 1);
});

test('one fetch per address per page: concurrent and later asks share the first answer; a stored row draws the card', async () => {
  resetLinkCards();
  const hits = stubFetch(() => json(200, { success: true, card: card() }));
  const results = await Promise.all([cachedLinkOnce(MODEL), cachedLinkOnce(MODEL), cachedLinkOnce(MODEL), cachedLinkOnce(MODEL), cachedLinkOnce(MODEL)]);
  assert.ok(results.every((r) => r?.id === 'lc_1'));
  assert.equal((await cachedLinkOnce(MODEL))?.title, 'Articulated Dragon v2');
  assert.equal(hits.length, 1, 'five cards, one GET');
  await cachedLinkOnce('https://youtu.be/x1');
  assert.equal(hits.length, 2, 'a second address is a second ask');
  assert.equal(linkCardMemoSize(), 2);
  // a settled row renders on first paint, no effect needed
  const out = html(createElement(LinkRow, { text: `printed from ${MODEL}` }));
  assert.match(out, /data-link-row/);
  assert.match(out, /Articulated Dragon v2/);
  assert.match(out, /data-link-print/);
  // while an address is still unasked, nothing is drawn (and nothing is asked in a static render)
  const before = hits.length;
  assert.equal(html(createElement(LinkRow, { text: 'https://example.org/never' })), '');
  assert.equal(hits.length, before);
});

test("the author's paste warms the card through POST /resolve — readers then need no GET", async () => {
  resetLinkCards();
  const hits = stubFetch((hit, body) => {
    if (hit.method === 'POST') return json(200, { success: true, card: card({ url: (body as { url: string }).url }) });
    return json(404, { success: false });
  });
  const text = `look: ${MODEL}, and https://youtu.be/x1 — https://example.org/a https://example.org/b`;
  warmLinksOnPaste({ clipboardData: { getData: () => text } });
  await new Promise((r) => setTimeout(r, 0));
  const posts = hits.filter((h) => h.method === 'POST' && h.path === '/api/link-cards/resolve');
  assert.equal(posts.length, 3, 'at most three addresses per paste, each resolved once');
  assert.equal((await cachedLinkOnce(MODEL))?.url, MODEL);
  assert.equal(hits.filter((h) => h.method === 'GET').length, 0, 'the memo already holds it: no reader GET');
  // an empty clipboard, or one with no address, asks nothing
  const before = hits.length;
  warmLinksOnPaste({ clipboardData: null });
  warmLinksOnPaste({ clipboardData: { getData: () => 'plain words' } });
  assert.equal(hits.length, before);
  // a refused resolve is swallowed: the composer keeps working, the card is simply not warm
  stubFetch(() => json(400, { success: false, error: 'blocked', code: 'LINK_HOST_BLOCKED' }));
  assert.equal(await warmLink('https://10.0.0.1/x'), null);
});

test('firstLink picks the first address and drops the punctuation prose attaches; looksLikeLink guards the sheet', () => {
  assert.equal(firstLink(`انظر ${MODEL}. ثم https://youtu.be/x1`), MODEL);
  assert.equal(firstLink('no links here'), null);
  assert.equal(firstLink(''), null);
  assert.equal(firstLink(null), null);
  assert.equal(looksLikeLink(' https://printables.com/model/1 '), true);
  assert.equal(looksLikeLink('printables.com/model/1'), false, 'no scheme');
  assert.equal(looksLikeLink('javascript:alert(1)'), false);
  assert.equal(looksLikeLink('https://a b'), false, 'a space is not an address');
  assert.equal(looksLikeLink(`https://x.io/${'a'.repeat(2100)}`), false, 'over 2 KB');
});

// ------------------------------------------------------------------- pins

test('the surfaces are wired: chat sends and draws links, the feed, the project and the comments mount the row, composers warm on paste', () => {
  const chat = read('src/pages/Chat.tsx');
  assert.match(chat, /postChatLink\(id, url, newClientId\(\)\)/, 'the chat sends through the link route with a client_id');
  assert.match(chat, /link\?: ChatLink \| null/, 'the message shape carries `link`');
  assert.match(chat, /msg\.link\s*\?\s*renderLinkBubble\(msg\.link/, 'a message with `link` is drawn as a card');
  assert.match(chat, /<LinkCard card=\{link\} variant="compact"/, 'the compact card in the bubble');
  assert.match(chat, /icon: Link2,\s*label: linkStrings\.link/, 'the «رابط» action in the attachment menu');
  assert.match(chat, /React\.lazy\(\(\) => import\('\.\.\/components\/community\/links\/LinkSheet'\)\)/, 'the sheet is a lazy chunk');
  assert.match(chat, /lang === 'ckb' \? 'ckb'/, 'the clock speaks Sorani (A9)');
  assert.doesNotMatch(chat, /lang === 'ku'/, "no 'ku' left in the clock");
  assert.match(code('src/components/community/feed/PostCard.tsx'), /<LinkRow text=\{p\.excerpt\} variant="compact" className="relative z-10/, 'the feed row, a pressable sibling of the stretched link');
  assert.match(code('src/pages/community/Project.tsx'), /<LinkRow text=\{post\.body\} variant="full"/, 'the project body, full size');
  const comments = code('src/components/community/social/CommentsSheet.tsx');
  assert.match(comments, /<LinkRow text=\{c\.body\} variant="compact"/, 'under a comment');
  assert.match(comments, /onPaste=\{warmLinksOnPaste\}/, 'the comment box warms on paste');
  assert.match(code('src/pages/community/ProjectComposer.tsx'), /onPaste=\{warmLinksOnPaste\}/, 'the project composer warms on paste');
});

test('tokens only in the links folder: no hex, no dark: variant, no physical left/right utility', () => {
  const physical = /(?:^|[\s"'`{])(?:[a-z-]+:)*(?:pl|pr|ml|mr|left|right|text-left|text-right|rounded-l|rounded-r|border-l|border-r)-[\w[\]/.-]+/;
  for (const f of ['LinkCard.tsx', 'LinkSheet.tsx', 'useLinkCard.ts', 'strings.ts', 'api.ts']) {
    const src = code(`src/components/community/links/${f}`);
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b(?![\w-])/, `${f} hard-codes a hex colour`);
    assert.doesNotMatch(src, /(?:^|[\s"'`{])(?:[a-z-]+:)*dark:[a-z-]/, `${f} uses the dark: variant`);
    assert.doesNotMatch(src, physical, `${f} uses a physical left/right utility`);
  }
  const cardSrc = code('src/components/community/links/LinkCard.tsx');
  assert.match(cardSrc, /useMotion\(\)/, 'the row appears through the house springs');
  assert.match(cardSrc, /m\.spring\('ui'\)/);
  assert.match(cardSrc, /m\.travel\(/, 'reduced motion drops the travel');
  assert.match(cardSrc, /rel="noopener noreferrer nofollow"/);
  assert.match(cardSrc, /target="_blank"/);
});
