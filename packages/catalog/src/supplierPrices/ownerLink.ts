/**
 * THE OWNER'S OWN SUPPLIER LINKS: ONE ADDRESS, READ ONE WAY
 * (docs/SMART_PRICING.md §3.10; DECISIONS row 293; the owner's request of
 * 2026-11-05: «i need to save the link so i can easily track price from
 * supplier or on pre order item to order it or when i need to future buy on
 * inventory»).
 *
 * §3.9 builds every matched link from validated ids and never from free text
 * (./links.ts). Row 293 amends that rule for the owner's OWN links only: an
 * address he pastes is free text by nature, so it is held to this narrower
 * contract instead, here, in one pure function the Worker and the owner's
 * admin chunk both run:
 *   - https only, on a named host: no IP literal, no localhost, no port, no
 *     user name or password. The host is the URL standard's lower-case,
 *     punycoded name, so a look-alike host reads as what it is;
 *   - one canonical form. A Tmall item page or a Bambu EU or US store product
 *     page is rebuilt by the §3.9 builder (tracking parameters dropped, EU
 *     links with `skr=yes`); any other host keeps the URL standard's own
 *     serialisation, which is ASCII (the rest is percent-encoded);
 *   - at most OWNER_LINK_MAX characters once rebuilt.
 * Taobao, m.tb.cn share links, AliExpress, Amazon and 1688 are kept as typed:
 * reading a Taobao address as a Tmall item is unverified, so it is not done.
 *
 * The Worker stores the address and never fetches it. The browser opens it in
 * a new tab without an opener or a referrer, and only when `safeOwnerLinkHref`
 * reads the stored text back to exactly itself; anything else is shown as
 * text. Nothing is repaired.
 *
 * Owner-only data (invariant I6): a link names the shop's supplier.
 */
import { isStoreHandle, isStoreVariantId, isTmallId, supplierItemUrl, supplierSkuUrl } from './links';

/** The longest address kept (the 0223 CHECK). */
export const OWNER_LINK_MAX = 1000;
/** The longest text read at all: a pasted Tmall address may carry long tracking parameters before it is rebuilt. */
export const OWNER_LINK_INPUT_MAX = 4000;
/** The most links one product keeps (owner decision, 2026-11-05). */
export const OWNER_LINKS_PER_PRODUCT = 40;
/** The longest label and supplier name (the 0223 CHECKs). */
export const OWNER_LINK_LABEL_MAX = 80;
/** The longest note (the 0223 CHECK). */
export const OWNER_LINK_NOTE_MAX = 300;

/** Which page a link opens: a Tmall item, a Bambu store product, or any other site. */
export type OwnerLinkSource = 'tmall_cn' | 'bambu_eu' | 'bambu_us' | 'other';

/** Why an address is refused, each with its own sentence on the owner's screen. */
export type OwnerLinkError = 'empty' | 'not_url' | 'not_https' | 'credentials' | 'port' | 'host' | 'too_long';
export const OWNER_LINK_ERRORS: readonly OwnerLinkError[] = ['empty', 'not_url', 'not_https', 'credentials', 'port', 'host', 'too_long'];
export const isOwnerLinkError = (v: unknown): v is OwnerLinkError => typeof v === 'string' && (OWNER_LINK_ERRORS as readonly string[]).includes(v);

export interface OwnerLinkAddress {
  /** The address as stored and opened. */
  url: string;
  /** Its host, lower case and punycoded. */
  host: string;
  source: OwnerLinkSource;
  /** The Tmall item id or the store handle the address names (null for any other site). */
  item_key: string | null;
  /** The Tmall SKU id or the store variant id, when the address names one. */
  sku_key: string | null;
}

export type OwnerLinkRead = OwnerLinkAddress | { error: OwnerLinkError };

/** Whitespace, C0 and C1 controls, the bidi marks and overrides and a byte-order mark: never part of an address he means. */
// eslint-disable-next-line no-control-regex
const REFUSED = /[\s\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
/** A scheme, but not a host followed by a port (`example.com:8080` is a host). */
const SCHEME = /^([a-z][a-z0-9+.-]*):(?!\d)/i;
/** One label of a host name: letters, digits and inner hyphens. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Tmall's own hosts (detail.tmall.com, detail.m.tmall.com …), never Taobao's. */
const TMALL_HOST = /^(?:[a-z0-9-]+\.)*tmall\.com$/;
const STORE_HOSTS: Readonly<Record<string, 'bambu_eu' | 'bambu_us'>> = { 'eu.store.bambulab.com': 'bambu_eu', 'us.store.bambulab.com': 'bambu_us' };
/** A store product page, with or without a region prefix (/de-de/products/…), as storePageTarget reads it. */
const STORE_PATH = /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/products\/([^/]+)\/?$/i;
/** What every stored address is: https and printable ASCII without a space (the 0223 CHECK). */
const STORED = /^https:\/\/[!-~]+$/;

/** A host that names a site: dotted labels, a last label that is not a number, never localhost. */
function isNamedHost(host: string): boolean {
  if (host.length < 3 || host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return false;
  // Every IPv4 form reads back as four decimals, so a numeric last label is an address, not a name.
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return false;
  return labels[labels.length - 1] !== 'localhost';
}

/** The §3.9 builder's form of a Tmall item or a Bambu store product page, else the URL standard's own. */
function canonical(u: URL): OwnerLinkAddress {
  const host = u.hostname;
  if (TMALL_HOST.test(host) && u.pathname === '/item.htm') {
    const id = u.searchParams.get('id');
    if (isTmallId(id)) {
      const sku = u.searchParams.get('skuId');
      const skuKey = isTmallId(sku) ? sku : null;
      const url = skuKey ? supplierSkuUrl('tmall_cn', id, skuKey) : supplierItemUrl('tmall_cn', id);
      if (url) return { url, host: 'detail.tmall.com', source: 'tmall_cn', item_key: id, sku_key: skuKey };
    }
  }
  const store = Object.prototype.hasOwnProperty.call(STORE_HOSTS, host) ? STORE_HOSTS[host] : undefined;
  if (store) {
    const m = STORE_PATH.exec(u.pathname);
    let handle = '';
    try {
      handle = m ? decodeURIComponent(m[1]!).toLowerCase() : '';
    } catch {
      handle = '';
    }
    const id = u.searchParams.get('id');
    if (isStoreHandle(handle) && (id === null || isStoreVariantId(id))) {
      const url = id ? supplierSkuUrl(store, handle, id) : supplierItemUrl(store, handle);
      if (url) return { url, host, source: store, item_key: handle, sku_key: id };
    }
  }
  return { url: u.href, host, source: 'other', item_key: null, sku_key: null };
}

/**
 * The address the owner typed or pasted, as it is stored and opened, or why it
 * is refused. An address without a scheme is read as https (`tmall.com/…`); any
 * scheme but https is refused, http included.
 */
export function ownerLinkUrl(raw: unknown): OwnerLinkRead {
  if (typeof raw !== 'string') return { error: 'not_url' };
  const text = raw.trim();
  if (!text) return { error: 'empty' };
  if (text.length > OWNER_LINK_INPUT_MAX) return { error: 'too_long' };
  if (REFUSED.test(text)) return { error: 'not_url' };
  const scheme = SCHEME.exec(text);
  if (scheme && scheme[1]!.toLowerCase() !== 'https') return { error: 'not_https' };
  // A path or a scheme-relative address (`//host/…`) names no site of its own.
  if (!scheme && (text.startsWith('/') || text.startsWith('\\'))) return { error: 'not_https' };
  let u: URL;
  try {
    u = new URL(scheme ? text : `https://${text}`);
  } catch {
    return { error: 'not_url' };
  }
  if (u.protocol !== 'https:') return { error: 'not_https' };
  if (u.username !== '' || u.password !== '') return { error: 'credentials' };
  if (u.port !== '') return { error: 'port' };
  if (!isNamedHost(u.hostname)) return { error: 'host' };
  const out = canonical(u);
  if (out.url.length > OWNER_LINK_MAX) return { error: 'too_long' };
  // The standard's serialisation is already this; the check keeps the 0223 CHECK true whatever it becomes.
  if (!STORED.test(out.url)) return { error: 'not_url' };
  return out;
}

/**
 * The second net, on the owner's screen: a stored address is drawn as a link
 * only when the parser reads it back to exactly itself (https, a named host,
 * its canonical form), else null and it is shown as text.
 */
export function safeOwnerLinkHref(stored: unknown): string | null {
  if (typeof stored !== 'string' || stored.length > OWNER_LINK_MAX) return null;
  const read = ownerLinkUrl(stored);
  return 'error' in read || read.url !== stored ? null : stored;
}

/** C0 and C1 controls but the line break, and the bidi overrides and isolates: never part of a note he means. */
// eslint-disable-next-line no-control-regex
const NOTE_REFUSED = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/**
 * His note on a link as it is stored, or null when it is refused. The sheet
 * gives him a box of a few lines, so a line break is kept (a Windows or old
 * Mac one is stored as `\n`); any other control or bidi-override character is
 * refused, as in every other text of his. Trimmed, at most
 * OWNER_LINK_NOTE_MAX characters (the 0223 CHECK). The Worker's write and the
 * owner's sheet both read a note here, so neither refuses what the other
 * accepts.
 */
export function ownerLinkNote(raw: string): string | null {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  return text.length <= OWNER_LINK_NOTE_MAX && !NOTE_REFUSED.test(text) ? text : null;
}
