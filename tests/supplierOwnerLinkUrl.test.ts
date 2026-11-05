/**
 * THE OWNER'S OWN SUPPLIER LINKS: THE SHARED PARSER
 * (packages/catalog/src/supplierPrices/ownerLink.ts; docs/SMART_PRICING.md
 * §3.10; DECISIONS row 293, which amends §3.9's «a link is never built from
 * free text» for the owner's own links only).
 *
 *   - https only, on a named host: http, javascript:, data:, a scheme-relative
 *     address, a user name or password, a port, an IP literal, localhost, a
 *     single-label host, a space, a control or a bidi character are refused,
 *     each by its reason;
 *   - one canonical form: a Tmall item rebuilt by the §3.9 builder (tracking
 *     dropped, the SKU kept), an EU store page with skr=yes, a US one without;
 *     Taobao, AliExpress, 1688, Amazon and a short link kept as the URL
 *     standard writes them (IDN hosts punycoded); at most 1000 characters;
 *   - `safeOwnerLinkHref` draws a stored address only when it reads back to
 *     exactly itself: every canonical form does, every hostile one does not;
 *   - `ownerLinkNote`, the note's one rule for the sheet and the Worker: its
 *     line breaks kept, any other control or bidi character refused.
 *
 * Pure: no database, no network.
 *
 * Run: node --import tsx --test tests/supplierOwnerLinkUrl.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNER_LINK_ERRORS,
  OWNER_LINK_INPUT_MAX,
  OWNER_LINK_MAX,
  OWNER_LINK_NOTE_MAX,
  isOwnerLinkError,
  ownerLinkNote,
  ownerLinkUrl,
  safeOwnerLinkHref,
  type OwnerLinkAddress,
} from '../packages/catalog/src/supplierPrices/ownerLink';
import { supplierItemUrl, supplierSkuUrl } from '../packages/catalog/src/supplierPrices/links';

const ok = (raw: string): OwnerLinkAddress => {
  const r = ownerLinkUrl(raw);
  assert.ok(!('error' in r), `${raw}: refused (${JSON.stringify(r)})`);
  return r as OwnerLinkAddress;
};
const reason = (raw: unknown) => {
  const r = ownerLinkUrl(raw);
  return 'error' in r ? r.error : null;
};

test('a Tmall item is rebuilt by the §3.9 builder: tracking dropped, the SKU kept, any tmall.com host, no scheme needed', () => {
  assert.deepEqual(ok('https://detail.tmall.com/item.htm?spm=a1z10.3-b&id=693972799714&skuId=4930331344241&ali_refid=a3_430&sku_properties=1627207:28320'), {
    url: 'https://detail.tmall.com/item.htm?id=693972799714&skuId=4930331344241',
    host: 'detail.tmall.com',
    source: 'tmall_cn',
    item_key: '693972799714',
    sku_key: '4930331344241',
  });
  assert.equal(ok('detail.m.tmall.com/item.htm?id=693972799714').url, supplierItemUrl('tmall_cn', '693972799714'));
  assert.equal(ok('  https://chaoshi.detail.tmall.com/item.htm?id=1&skuId=2  ').url, supplierSkuUrl('tmall_cn', '1', '2'));
  // A SKU id that is not digits is dropped, never repaired: the item page is kept.
  assert.deepEqual([ok('https://detail.tmall.com/item.htm?id=1&skuId=abc').url, ok('https://detail.tmall.com/item.htm?id=1&skuId=abc').sku_key], ['https://detail.tmall.com/item.htm?id=1', null]);
  // A Tmall page that names no item (a shop, a search) is kept as it is.
  assert.equal(ok('https://bambulab.tmall.com/search.htm?id=12').source, 'other');
  assert.equal(ok('https://detail.tmall.com/item.htm?id=abc').source, 'other');
  // A look-alike is not Tmall.
  assert.equal(ok('https://detail.tmall.com.evil.example/item.htm?id=1').source, 'other');
  assert.equal(ok('https://eviltmall.com/item.htm?id=1').source, 'other');
});

test('a Bambu store page is rebuilt: the EU one with skr=yes (item and variant), the US one without; a region prefix dropped', () => {
  assert.deepEqual(ok('https://eu.store.bambulab.com/de-de/products/H2D?id=596571526982115329&utm_source=x'), {
    url: 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329&skr=yes',
    host: 'eu.store.bambulab.com',
    source: 'bambu_eu',
    item_key: 'h2d',
    sku_key: '596571526982115329',
  });
  assert.equal(ok('eu.store.bambulab.com/products/h2d').url, 'https://eu.store.bambulab.com/products/h2d?skr=yes');
  assert.equal(ok('https://us.store.bambulab.com/products/h2d?id=581025672340709385&skr=yes').url, 'https://us.store.bambulab.com/products/h2d?id=581025672340709385');
  assert.doesNotMatch(ok('https://us.store.bambulab.com/products/x1-carbon').url, /skr=/);
  // A handle the builder refuses (a non-ASCII hyphen) keeps the page as the standard writes it.
  const odd = ok('https://eu.store.bambulab.com/products/usb‑c-soldering-iron-kit');
  assert.deepEqual([odd.source, odd.url], ['other', 'https://eu.store.bambulab.com/products/usb%E2%80%91c-soldering-iron-kit']);
});

test('any other https site is kept as the URL standard writes it: Taobao, a short link, AliExpress, 1688, Amazon, an IDN host punycoded', () => {
  for (const [raw, url, host] of [
    ['https://item.taobao.com/item.htm?id=7788&spm=x', 'https://item.taobao.com/item.htm?id=7788&spm=x', 'item.taobao.com'],
    ['https://m.tb.cn/h.5abcDEF?tk=xyz', 'https://m.tb.cn/h.5abcDEF?tk=xyz', 'm.tb.cn'],
    ['https://www.aliexpress.com/item/1005006.html', 'https://www.aliexpress.com/item/1005006.html', 'www.aliexpress.com'],
    ['detail.1688.com/offer/6543.html', 'https://detail.1688.com/offer/6543.html', 'detail.1688.com'],
    ['https://www.amazon.de/dp/B0CXYZ#reviews', 'https://www.amazon.de/dp/B0CXYZ#reviews', 'www.amazon.de'],
    ['HTTPS://Bücher.Example:443/Path?q="x"&y=<z>', 'https://xn--bcher-kva.example/Path?q=%22x%22&y=%3Cz%3E', 'xn--bcher-kva.example'],
    ['https://shop.example/ä', 'https://shop.example/%C3%A4', 'shop.example'],
  ] as const) {
    const r = ok(raw);
    assert.deepEqual([r.url, r.host, r.source, r.item_key, r.sku_key], [url, host, 'other', null, null], raw);
  }
});

test('every refusal has its reason: empty, not a URL, not https, credentials, a port, a host that names no site, too long', () => {
  for (const [raw, why] of [
    ['', 'empty'],
    ['   ', 'empty'],
    [42, 'not_url'],
    [null, 'not_url'],
    ['https://example.com/a b', 'not_url'],
    ['https://example.com/\u0000', 'not_url'],
    ['https://example.com/\u202eevil', 'not_url'],
    ['https://exa\u200fmple.com/', 'not_url'],
    ['https://', 'not_url'],
    ['http://detail.tmall.com/item.htm?id=1', 'not_https'],
    ['HTTP://example.com', 'not_https'],
    ['javascript:alert(1)', 'not_https'],
    ['JavaScript:alert(1)', 'not_https'],
    ['data:text/html,hi', 'not_https'],
    ['mailto:a@b.co', 'not_https'],
    ['ftp://example.com/', 'not_https'],
    ['//detail.tmall.com/item.htm?id=1', 'not_https'],
    ['/products/h2d', 'not_https'],
    ['https://user:pw@example.com/', 'credentials'],
    ['https://user@example.com/', 'credentials'],
    ['https://example.com:8443/', 'port'],
    ['example.com:8080/x', 'port'],
    ['https://127.0.0.1/', 'host'],
    ['https://0x7f.1/', 'host'],
    ['https://[::1]/', 'host'],
    ['https://localhost/', 'host'],
    ['https://shop.localhost/', 'host'],
    ['https://intranet/', 'host'],
    ['https://example.com./x', 'host'],
    ['https://exa_mple.com/', 'host'],
    ['https://-bad.example/', 'host'],
    [`https://example.com/${'a'.repeat(OWNER_LINK_MAX - 'https://example.com/'.length + 1)}`, 'too_long'],
    [`https://detail.tmall.com/item.htm?id=1&x=${'a'.repeat(OWNER_LINK_INPUT_MAX)}`, 'too_long'],
  ] as const) {
    assert.equal(reason(raw), why, String(raw).slice(0, 80));
  }
  // A byte-order mark around a pasted address is trimmed like a space.
  assert.equal(ok('\ufeffhttps://example.com/x\ufeff').url, 'https://example.com/x');
  // The longest kept, exactly; and a long Tmall address with its tracking is rebuilt short, so it is kept.
  assert.equal(ok(`https://example.com/${'a'.repeat(OWNER_LINK_MAX - 'https://example.com/'.length)}`).url.length, OWNER_LINK_MAX);
  assert.equal(ok(`https://detail.tmall.com/item.htm?id=1&spm=${'a'.repeat(2000)}`).url, 'https://detail.tmall.com/item.htm?id=1');
  for (const e of OWNER_LINK_ERRORS) assert.equal(isOwnerLinkError(e), true);
  assert.equal(isOwnerLinkError('duplicate'), false);
});

test('safeOwnerLinkHref: a stored address is drawn only when it reads back to exactly itself', () => {
  // Every canonical form reads back to itself.
  for (const raw of [
    'https://detail.tmall.com/item.htm?spm=x&id=1&skuId=2',
    'https://eu.store.bambulab.com/de-de/products/h2d',
    'https://us.store.bambulab.com/products/h2d?id=581025672340709385',
    'https://item.taobao.com/item.htm?id=7788',
    'https://Bücher.example/a?q=<x>#f',
    'https://a.bc',
  ]) {
    const { url } = ok(raw);
    assert.equal(safeOwnerLinkHref(url), url, raw);
  }
  // The §3.9 hostile list (tests/estimateAdminUi.test.ts) and more: never drawn.
  for (const hostile of [
    'javascript:alert(1)',
    'http://detail.tmall.com/item.htm?id=1',
    '//detail.tmall.com/item.htm?id=1',
    'https://eu.store.bambulab.com/products/h2d"><script>',
    'data:text/html,hi',
    '',
    null,
    undefined,
    42,
    // Not in the parser's own form: tracking still on, an upper-case host, a missing skr=yes, no path, a port.
    'https://detail.tmall.com/item.htm?id=1&spm=x',
    'https://EXAMPLE.com/',
    'https://eu.store.bambulab.com/products/h2d',
    'https://example.com',
    'https://example.com:443/',
    ' https://example.com/',
    'https://user@example.com/',
    'https://127.0.0.1/',
    `https://example.com/${'a'.repeat(OWNER_LINK_MAX)}`,
  ]) {
    assert.equal(safeOwnerLinkHref(hostile), null, String(hostile).slice(0, 80));
  }
  // Any https site is the owner's to choose: a host the builder does not know is drawn, its host shown beside it.
  assert.equal(safeOwnerLinkHref('https://evil.example/products/h2d'), 'https://evil.example/products/h2d');
});

test('ownerLinkNote: a note keeps its lines (CRLF and CR read as \\n), trimmed, at most 300 characters; any other control or bidi character refuses it', () => {
  assert.equal(ownerLinkNote(''), '');
  assert.equal(ownerLinkNote('  MOQ 2  '), 'MOQ 2');
  assert.equal(ownerLinkNote('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  assert.equal(ownerLinkNote('\r\n\nline one\nline two\n\n'), 'line one\nline two');
  assert.equal(ownerLinkNote('x'.repeat(OWNER_LINK_NOTE_MAX)), 'x'.repeat(OWNER_LINK_NOTE_MAX));
  assert.equal(ownerLinkNote('x'.repeat(OWNER_LINK_NOTE_MAX + 1)), null);
  // A Windows line break counts once, as it is stored.
  assert.equal(ownerLinkNote(`${'x'.repeat(149)}\r\n${'y'.repeat(150)}`)?.length, OWNER_LINK_NOTE_MAX);
  for (const refused of ['a\tb', 'a\u0000b', 'a\u0007b', 'a\u000bb', 'a\u000cb', 'a\u007fb', 'a\u0085b', 'a‪b', 'a‮b', 'a⁦b', 'a⁩b']) {
    assert.equal(ownerLinkNote(refused), null, JSON.stringify(refused));
  }
  // Arabic and Sorani are his words, kept as typed.
  assert.equal(ownerLinkNote('اطلب اللون الأسود\nڕەنگی ڕەش'), 'اطلب اللون الأسود\nڕەنگی ڕەش');
});
