/**
 * «روابطك» — THE OWNER'S OWN SUPPLIER LINKS, PER PRODUCT
 * (docs/SMART_PRICING.md §3.10; migration 0223; DECISIONS row 293; the
 * owner's request of 2026-11-05: «i need to save the link so i can easily
 * track price from supplier or on pre order item to order it or when i need to
 * future buy on inventory»).
 *
 *   GET /owner-links/:product_id[?combo_key= | ?scope=&scope_id=]
 *       his links of the product beside the matched Tmall / EU links (§3.9) of
 *       the same SKUs, and the keys a new link may be saved for
 *   PUT /owner-links/:product_id {version, upsert, remove}
 *       adds, edits and removes his links (fenced on the version he read)
 *
 * WHAT A LINK BELONGS TO. `combo_key` is '' (the whole product), 'o:<value>'
 * (one model or option), 'c:<colour>' (one colour across models) or one exact
 * SKU key — a canonical subset of a SKU's key, in the space of
 * supplier_price_matches.combo_key. A link APPLIES to a SKU when every part of
 * its key is a part of the SKU's key, so one stock row of a purchase (its base,
 * option, colour or variant) and one order line each read the links that
 * concern them. A new link is saved only for a key the product offers today
 * (`choices`); a stored one whose option was since removed stays readable, and
 * removable.
 *
 * THE ADDRESS is read by the shared parser (packages/catalog/src/supplierPrices/
 * ownerLink.ts): https only, a named host, the §3.9 builder's form for a Tmall
 * item or a Bambu store page, at most 1000 characters. The Worker never
 * fetches it. Saving one writes no price (supplier_price_manual stays the
 * «تحديث السعر» door's) and never touches a match (supplier_price_matches).
 *
 * Owner-only (I6): served only behind the router's requireCostRead, every
 * write behind assertCostWrite; the links sit under `supplier_links` and the
 * matched facts under `supplier_prices`, both FINANCIAL_FIELDS names, so
 * `stripFinancials` drops them whole from anything projected for a non-owner.
 * The audit row carries counts only, never an address or a host.
 *
 * DEPLOY-AHEAD (CLAUDE.md rule 2): the owner's rows are read in a batch of
 * their own, never beside a 0218 read, and a missing table is recognised by
 * its own name (isMissingEstimateSchema does not know it): the read then
 * answers `installed: false` with the matched links still there, and the
 * write 503 SUPPLIER_LINKS_NOT_INSTALLED. Without 0218 the read answers
 * nothing but the product's name (the router's links-read convention).
 */
import { auditStatements } from '../audit';
import { HttpError, notFound } from '../http';
import { fence, isFenceMiss } from '../operations';
import { unitNamesOf } from '../pricingEngine/legacy';
import { inputInvalid } from '../pricingEngine/whatIf';
import { priceEstimatesInstalled } from '../priceEstimateLabel';
import { estimateServerMessage } from '@levonis/contracts/priceEstimates';
import { parseSkuComboKey } from '@levonis/pricing/skuChannel';
import {
  OWNER_LINKS_PER_PRODUCT,
  OWNER_LINK_LABEL_MAX,
  ownerLinkNote,
  ownerLinkUrl,
  type OwnerLinkSource,
} from '@levonis/catalog/supplierPrices/ownerLink';
import { EMPTY_TOKEN, hasControlCharacter, isProductId, loadProductSkus, pricingChanged, strictBody, type ProductSkus } from './store';
import { productLinkViews, type LinkSku, type ProductLinks } from './links';

/** The most links one write adds or edits, and the most it removes. */
export const OWNER_LINKS_WRITE_MAX = 20;

/** A link's id: minted here as `psl_` and 32 hex digits (the 0223 CHECK allows 40 characters). */
const LINK_ID = /^psl_[A-Za-z0-9_-]{1,36}$/;
/** An option value, colour or variant id as a query names it. */
const SCOPE_ID = /^[A-Za-z0-9_:.-]{1,120}$/;

/**
 * The product's token over its links: count, sum of row versions and the
 * latest stamp — the shape of MATCHES_TOKEN_SQL. The owner's write carries
 * back the token he read, and the batch is fenced on this very expression.
 */
export const OWNER_LINKS_TOKEN_SQL =
  "(SELECT COUNT(*) || '.' || COALESCE(SUM(version), 0) || '.' || COALESCE(MAX(updated_at), '') FROM product_supplier_links WHERE product_id = ?)";

/** 503 SUPPLIER_LINKS_NOT_INSTALLED: a write on a database without migration 0223 (nothing was saved). */
export function ownerLinksNotInstalled(): HttpError {
  return new HttpError(503, estimateServerMessage('SUPPLIER_LINKS_NOT_INSTALLED'), 'SUPPLIER_LINKS_NOT_INSTALLED');
}

/** The database refused a statement because 0223 is not on it (its own name: isMissingEstimateSchema never matches it). */
export function isMissingOwnerLinks(e: unknown): boolean {
  const msg = String((e as { message?: unknown } | null)?.message ?? e);
  return /no such table:?\s*(?:[A-Za-z_][A-Za-z0-9_]*\.)?product_supplier_links\b/i.test(msg);
}

/** 400 PRICING_INPUT_INVALID {field, reason}: the field's NAME and why, never its value. */
function refused(field: string, reason: string): HttpError {
  const e = inputInvalid(field);
  e.details = { field, reason };
  return e;
}

// ---------------------------------------------------------------- keys

type Names = { ar: string; en: string; ckb: string };
const NO_NAMES: Names = { ar: '', en: '', ckb: '' };

/** The parts of a combo key ('' has none). */
const partsOf = (key: string): string[] => (key === '' ? [] : key.split('|'));

/** Every part of `link` is a part of `sku`: the link concerns that SKU. */
export function linkApplies(link: string, sku: string): boolean {
  const own = new Set(partsOf(sku));
  return partsOf(link).every((p) => own.has(p));
}

/** A key's names in three languages, from the product's own options and colour ('' for the product itself). */
function namesOf(product: ProductSkus | undefined, key: string): Names {
  const sel = key === '' ? null : parseSkuComboKey(key);
  if (!product || !sel) return NO_NAMES;
  const doc = product.loaded.doc;
  const colour = sel.color_id ? (doc.colors.find((c) => c.id === sel.color_id) ?? null) : null;
  const n = unitNamesOf(doc, sel.option_value_ids, colour);
  return { ar: n.name_ar, en: n.name_en, ckb: n.name_ckb };
}

export type OwnerLinkChoiceKind = 'product' | 'option' | 'colour' | 'sku';

/** One key a new link may be saved for, with its names. */
export interface OwnerLinkChoice {
  combo_key: string;
  kind: OwnerLinkChoiceKind;
  labels: Names;
}

/**
 * The keys a link may be saved for, chosen from a list (owner decision,
 * 2026-11-05): the whole product, each model or option and each colour that a
 * sellable SKU holds, and each sellable SKU. A grid too large for the engine
 * (no SKU list) offers the product, its active options and its active colours.
 */
export function ownerLinkChoices(product: ProductSkus | undefined): OwnerLinkChoice[] {
  const out: OwnerLinkChoice[] = [{ combo_key: '', kind: 'product', labels: NO_NAMES }];
  if (!product) return out;
  const seen = new Set<string>(['']);
  const add = (combo_key: string, kind: OwnerLinkChoiceKind, labels?: Names) => {
    if (seen.has(combo_key)) return;
    seen.add(combo_key);
    out.push({ combo_key, kind, labels: labels ?? namesOf(product, combo_key) });
  };
  const doc = product.loaded.doc;
  if (product.skus === null) {
    for (const o of doc.options) if (o.active && !o.merged_into) add(`o:${o.id}`, 'option');
    for (const c of doc.colors) if (c.active) add(`c:${c.id}`, 'colour');
    return out;
  }
  const options: string[] = [];
  const colours: string[] = [];
  for (const s of product.skus) {
    for (const id of s.option_value_ids) if (!options.includes(id)) options.push(id);
    if (s.color_id && !colours.includes(s.color_id)) colours.push(s.color_id);
  }
  for (const id of options) add(`o:${id}`, 'option');
  for (const id of colours) add(`c:${id}`, 'colour');
  for (const s of product.skus) add(s.combo_key, 'sku', s.labels);
  return out;
}

// ---------------------------------------------------------------- the read

/** Which SKUs a read is about: the whole product, one key, or one stock row of a purchase. */
export type OwnerLinksFilter =
  | { kind: 'all' }
  | { kind: 'combo'; key: string }
  | { kind: 'stock'; scope: 'base' | 'option' | 'color' | 'variant'; id: string };

const STOCK_SCOPES = ['base', 'option', 'color', 'variant'] as const;

/** The read's query: `combo_key`, or `scope` with `scope_id`, never both; 400 PRICING_INPUT_INVALID {field} otherwise. */
export function ownerLinksFilter(q: { combo_key?: string; scope?: string; scope_id?: string }): OwnerLinksFilter {
  if (q.combo_key !== undefined) {
    if (q.scope !== undefined || q.scope_id !== undefined) throw inputInvalid('scope');
    if (q.combo_key.length > 400 || parseSkuComboKey(q.combo_key) === null) throw inputInvalid('combo_key');
    return q.combo_key === '' ? { kind: 'all' } : { kind: 'combo', key: q.combo_key };
  }
  if (q.scope === undefined) {
    if (q.scope_id !== undefined) throw inputInvalid('scope');
    return { kind: 'all' };
  }
  if (!(STOCK_SCOPES as readonly string[]).includes(q.scope)) throw inputInvalid('scope');
  const scope = q.scope as (typeof STOCK_SCOPES)[number];
  const id = q.scope_id ?? '';
  if (scope === 'base' ? id !== '' : !SCOPE_ID.test(id)) throw inputInvalid('scope_id');
  return { kind: 'stock', scope, id };
}

/** One of the owner's links, as his screens read it. */
export interface OwnerLink {
  id: string;
  combo_key: string;
  /** The key's names ('' for the whole product, and for an option since removed). */
  labels: Names;
  url: string;
  host: string;
  source: OwnerLinkSource;
  item_key: string | null;
  sku_key: string | null;
  label: string;
  supplier_name: string;
  note: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface OwnerLinksView extends ProductLinks {
  versions: ProductLinks['versions'] & { links: string };
  /** FINANCIAL_FIELDS name: every link of the owner's that concerns the SKUs read, the most specific first. */
  supplier_links: OwnerLink[];
  choices: OwnerLinkChoice[];
}

export interface OwnerLinksAnswer {
  /** Migration 0223 is on this database: links can be saved. */
  installed: boolean;
  /** The key the read is about ('' for the whole product): a new link starts on it. */
  scope_key: string;
  product: OwnerLinksView;
}

/**
 * What a read is about: the keys a link is tested against (null: the whole
 * product, every link), which SKUs' matched facts are shown, and the key a new
 * link starts on.
 */
interface ReadScope {
  targets: string[] | null;
  skuIn: (key: string) => boolean;
  scopeKey: string;
}

/** The key a filter names before the database is asked ('' for the whole product, and for a variant). */
function plainScopeKey(filter: OwnerLinksFilter): string {
  if (filter.kind === 'combo') return filter.key;
  if (filter.kind === 'stock' && filter.scope === 'option') return `o:${filter.id}`;
  if (filter.kind === 'stock' && filter.scope === 'color') return `c:${filter.id}`;
  return '';
}

async function resolveScope(db: D1Database, productId: string, product: ProductSkus | undefined, filter: OwnerLinksFilter): Promise<ReadScope> {
  const sellable = (product?.skus ?? []).map((s) => s.combo_key);
  if (filter.kind === 'all' || (filter.kind === 'stock' && filter.scope === 'base')) return { targets: null, skuIn: () => true, scopeKey: '' };
  if (filter.kind === 'combo') {
    const key = filter.key;
    // An order line's own key, sellable or not any more (an option removed since): its links still concern it.
    return { targets: [...new Set([key, ...sellable.filter((k) => linkApplies(key, k))])], skuIn: (k) => linkApplies(key, k), scopeKey: key };
  }
  if (filter.scope === 'option' || filter.scope === 'color') {
    // A stock row of one option or one colour holds every SKU of it: a link of any of those concerns the row.
    const part = plainScopeKey(filter);
    const holds = (k: string) => partsOf(k).includes(part);
    return { targets: [part, ...sellable.filter(holds)], skuIn: holds, scopeKey: part };
  }
  // A variant row: its combination is the variant's own key (as worker/lib/procurementLine.ts reads it).
  const row = await db
    .prepare('SELECT combo_key FROM product_variants WHERE id = ?1 AND product_id = ?2')
    .bind(filter.id, productId)
    .first<{ combo_key: string | null }>();
  const key = typeof row?.combo_key === 'string' && parseSkuComboKey(row.combo_key) !== null ? row.combo_key : null;
  // A variant gone since the purchase: only the whole product's links still concern it, and no SKU's facts.
  if (key === null) return { targets: [''], skuIn: () => false, scopeKey: '' };
  return { targets: [key], skuIn: (k) => linkApplies(key, k) && linkApplies(k, key), scopeKey: key };
}

/** The owner's rows of one product and its token, in a batch of their own; null on a database without 0223. */
async function readOwnerRows(db: D1Database, productId: string): Promise<{ rows: Array<Record<string, unknown>>; token: string } | null> {
  try {
    const [rows, token] = (await db.batch([
      db
        .prepare(
          `SELECT id, combo_key, url, host, label, supplier_name, note, version, created_at, updated_at
             FROM product_supplier_links WHERE product_id = ?1`
        )
        .bind(productId),
      db.prepare(`SELECT ${OWNER_LINKS_TOKEN_SQL} AS token`).bind(productId),
    ])) as Array<{ results?: Array<Record<string, unknown>> }>;
    return { rows: rows?.results ?? [], token: String(token?.results?.[0]?.token ?? EMPTY_TOKEN) };
  } catch (e) {
    if (isMissingOwnerLinks(e)) return null;
    throw e;
  }
}

const specificity = (key: string) => partsOf(key).length;

/** The matches shown beside his links: the ones the Links tab shows (§3.9), never a rejected one. */
const LINK_STATES: ReadonlySet<'confirmed' | 'suggested'> = new Set(['confirmed', 'suggested']);

/** GET /owner-links/:product_id: the product's links for the SKUs the filter names; 404 for no such product. */
export async function ownerLinksView(db: D1Database, productId: string, filter: OwnerLinksFilter): Promise<OwnerLinksAnswer> {
  if (!isProductId(productId)) throw notFound();
  const row = await db
    .prepare('SELECT id, name, name_ar, name_ku FROM products WHERE id = ?1')
    .bind(productId)
    .first<{ id: string; name: string | null; name_ar: string | null; name_ku: string | null }>();
  if (!row) throw notFound();
  const rowNames: Names = { ar: String(row.name_ar ?? ''), en: String(row.name ?? ''), ckb: String(row.name_ku ?? '') };
  const empty = (installed: boolean, scopeKey: string): OwnerLinksAnswer => ({
    installed,
    scope_key: scopeKey,
    product: {
      product_id: productId,
      name: String(row.name ?? ''),
      names: rowNames,
      versions: { matches: EMPTY_TOKEN, manual: EMPTY_TOKEN, links: EMPTY_TOKEN },
      skus: [],
      supplier_links: [],
      choices: [],
    },
  });
  // Without 0218 there is no catalogue to read, and 0223 comes after it: the product's name, and no link.
  if (!(await priceEstimatesInstalled(db))) return empty(false, plainScopeKey(filter));

  const loaded = await loadProductSkus(db, [productId]);
  const product = loaded.get(productId);
  const scope = await resolveScope(db, productId, product, filter);
  const own = await readOwnerRows(db, productId);
  const view = (await productLinkViews(db, [productId], { states: LINK_STATES, manual: true, loaded })).get(productId);

  // The matched Tmall / EU facts (confirmed or suggested, and his own prices) of the SKUs read that carry any.
  const skus: LinkSku[] = (view?.skus ?? []).filter((s) => s.supplier_prices.length > 0 && scope.skuIn(s.combo_key));
  const links: OwnerLink[] = (own?.rows ?? [])
    .map((r): OwnerLink => {
      const combo = String(r.combo_key ?? '');
      const stored = String(r.url ?? '');
      const read = ownerLinkUrl(stored);
      // The source is read again from the stored address; one that does not read back to itself is «other» (shown as text).
      const same = !('error' in read) && read.url === stored;
      return {
        id: String(r.id),
        combo_key: combo,
        labels: namesOf(product, combo),
        url: stored,
        host: String(r.host ?? ''),
        source: same ? read.source : 'other',
        item_key: same ? read.item_key : null,
        sku_key: same ? read.sku_key : null,
        label: String(r.label ?? ''),
        supplier_name: String(r.supplier_name ?? ''),
        note: String(r.note ?? ''),
        version: Number(r.version ?? 1),
        created_at: String(r.created_at ?? ''),
        updated_at: String(r.updated_at ?? ''),
      };
    })
    // A link concerns the read when it applies to one of its keys (every link, for the whole product).
    .filter((l) => scope.targets === null || scope.targets.some((k) => linkApplies(l.combo_key, k)));
  // The most specific first (an exact SKU, then a model before a colour, the product last), then the latest.
  const choices = ownerLinkChoices(product);
  const rank = new Map(choices.map((c, i) => [c.combo_key, i]));
  const at = (k: string) => rank.get(k) ?? choices.length;
  links.sort(
    (a, b) =>
      specificity(b.combo_key) - specificity(a.combo_key) ||
      at(a.combo_key) - at(b.combo_key) ||
      b.updated_at.localeCompare(a.updated_at) ||
      a.url.localeCompare(b.url) ||
      a.id.localeCompare(b.id)
  );

  return {
    installed: own !== null,
    scope_key: scope.scopeKey,
    product: {
      product_id: productId,
      name: product?.name ?? String(row.name ?? ''),
      names: product?.names ?? rowNames,
      versions: { matches: view?.versions.matches ?? EMPTY_TOKEN, manual: view?.versions.manual ?? EMPTY_TOKEN, links: own?.token ?? EMPTY_TOKEN },
      skus,
      supplier_links: links,
      choices,
    },
  };
}

// ---------------------------------------------------------------- the write

interface LinkEntry {
  id: string | null;
  combo_key: string;
  url: string;
  host: string;
  label: string;
  supplier_name: string;
  note: string;
}

/** A short text of the owner's: trimmed, at most `max` characters, no control or bidi-override character; '' when absent. */
function textOf(v: unknown, field: string, max: number): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw inputInvalid(field);
  const t = v.trim();
  if (t.length > max || hasControlCharacter(t)) throw inputInvalid(field);
  return t;
}

/** His note: the shared rule (`ownerLinkNote`), which keeps the line breaks of the sheet's box; '' when absent. */
function noteOf(v: unknown): string {
  if (v === undefined || v === null) return '';
  const t = typeof v === 'string' ? ownerLinkNote(v) : null;
  if (t === null) throw inputInvalid('note');
  return t;
}

function entryOf(raw: unknown, choices: ReadonlySet<string>): LinkEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw inputInvalid('upsert');
  const o = raw as Record<string, unknown>;
  strictBody(o, ['id', 'combo_key', 'url', 'label', 'supplier_name', 'note']);
  if (o.id !== undefined && o.id !== null && (typeof o.id !== 'string' || !LINK_ID.test(o.id))) throw inputInvalid('id');
  if (typeof o.combo_key !== 'string' || !choices.has(o.combo_key)) throw inputInvalid('combo_key');
  const read = ownerLinkUrl(o.url);
  if ('error' in read) throw refused('url', read.error);
  return {
    id: typeof o.id === 'string' ? o.id : null,
    combo_key: o.combo_key,
    url: read.url,
    host: read.host,
    label: textOf(o.label, 'label', OWNER_LINK_LABEL_MAX),
    supplier_name: textOf(o.supplier_name, 'supplier_name', OWNER_LINK_LABEL_MAX),
    note: noteOf(o.note),
  };
}

export interface OwnerLinksSaved {
  added: number;
  updated: number;
  removed: number;
}

/**
 * PUT /owner-links/:product_id {version, upsert?: [{id?, combo_key, url, label?,
 * supplier_name?, note?}], remove?: [id]}: at most 20 of each. A new link gets
 * its id here; an edit names its own; a removal names the ids. Fenced on the
 * token he read (409 PRICING_CHANGED); a key the product does not offer, an
 * address the parser refuses, the same address twice for one key or more than
 * 40 links refuse with the field's name. One batch: the fence, the delete, the
 * upsert and the audit row (counts only).
 */
export async function setOwnerLinks(db: D1Database, productId: string, body: Record<string, unknown>, actor: string, now: Date): Promise<OwnerLinksSaved> {
  strictBody(body, ['version', 'upsert', 'remove']);
  if (!isProductId(productId)) throw notFound();
  if (typeof body.version !== 'string' || body.version.length > 120) throw inputInvalid('version');
  const upsertRaw = body.upsert ?? [];
  const removeRaw = body.remove ?? [];
  if (!Array.isArray(upsertRaw) || upsertRaw.length > OWNER_LINKS_WRITE_MAX) throw inputInvalid('upsert');
  if (!Array.isArray(removeRaw) || removeRaw.length > OWNER_LINKS_WRITE_MAX) throw inputInvalid('remove');
  if (!upsertRaw.length && !removeRaw.length) throw inputInvalid('upsert');
  const product = (await loadProductSkus(db, [productId])).get(productId);
  if (!product) throw notFound();

  const choices = new Set(ownerLinkChoices(product).map((c) => c.combo_key));
  const entries = upsertRaw.map((x) => entryOf(x, choices));
  const remove: string[] = [];
  for (const id of removeRaw) {
    if (typeof id !== 'string' || !LINK_ID.test(id) || remove.includes(id)) throw inputInvalid('remove');
    remove.push(id);
  }
  const named = entries.flatMap((e) => (e.id ? [e.id] : []));
  if (new Set(named).size !== named.length) throw inputInvalid('id');
  if (remove.some((id) => named.includes(id))) throw inputInvalid('remove');

  const own = await readOwnerRows(db, productId);
  if (!own) throw ownerLinksNotInstalled();
  if (own.token !== body.version) throw pricingChanged();
  const current = new Map(own.rows.map((r) => [String(r.id), { combo_key: String(r.combo_key ?? ''), url: String(r.url ?? '') }]));
  // An id he names is one of this product's links (the token he read already proves he saw it).
  for (const id of named) if (!current.has(id)) throw inputInvalid('id');
  for (const id of remove) if (!current.has(id)) throw inputInvalid('remove');

  const fresh = entries.map((e) => (e.id ? (e as LinkEntry & { id: string }) : { ...e, id: `psl_${crypto.randomUUID().replace(/-/g, '')}` }));
  const after = new Map(current);
  for (const id of remove) after.delete(id);
  for (const e of fresh) after.set(e.id, { combo_key: e.combo_key, url: e.url });
  const pairs = new Set<string>();
  for (const v of after.values()) {
    const k = `${v.combo_key}\u0000${v.url}`;
    if (pairs.has(k)) throw refused('url', 'duplicate');
    pairs.add(k);
  }
  if (after.size > OWNER_LINKS_PER_PRODUCT && after.size > current.size) throw refused('upsert', 'limit');

  const at = now.toISOString();
  const saved: OwnerLinksSaved = { added: fresh.length - named.length, updated: named.length, removed: remove.length };
  const audit = await auditStatements(db, actor, 'supplier_prices.owner_links_set', productId, { ...saved });
  const statements: D1PreparedStatement[] = [...fence(db, `${OWNER_LINKS_TOKEN_SQL} = ?`, [productId, body.version])];
  if (remove.length) {
    statements.push(
      db.prepare('DELETE FROM product_supplier_links WHERE product_id = ?1 AND id IN (SELECT value FROM json_each(?2))').bind(productId, JSON.stringify(remove))
    );
  }
  if (fresh.length) {
    const rows = fresh.map((e) => ({ i: e.id, c: e.combo_key, u: e.url, h: e.host, l: e.label, s: e.supplier_name, n: e.note }));
    statements.push(
      db
        .prepare(
          `INSERT INTO product_supplier_links
             (id, product_id, combo_key, url, host, label, supplier_name, note, version, created_by, created_at, updated_by, updated_at)
           SELECT json_extract(j.value, '$.i'), ?1, json_extract(j.value, '$.c'), json_extract(j.value, '$.u'), json_extract(j.value, '$.h'),
                  json_extract(j.value, '$.l'), json_extract(j.value, '$.s'), json_extract(j.value, '$.n'), 1, ?2, ?3, ?2, ?3
             FROM json_each(?4) j WHERE 1
           ON CONFLICT(id) DO UPDATE SET
             combo_key = excluded.combo_key, url = excluded.url, host = excluded.host, label = excluded.label,
             supplier_name = excluded.supplier_name, note = excluded.note,
             updated_by = excluded.updated_by, updated_at = excluded.updated_at,
             version = product_supplier_links.version + 1
           WHERE product_supplier_links.product_id = excluded.product_id`
        )
        .bind(productId, actor, at, JSON.stringify(rows))
    );
  }
  try {
    await db.batch([...statements, ...audit.statements]);
  } catch (e) {
    if (isFenceMiss(e)) throw pricingChanged();
    if (isMissingOwnerLinks(e)) throw ownerLinksNotInstalled();
    // Two links swapping one address inside one write: the unique index is the second net.
    if (/UNIQUE constraint failed:\s*product_supplier_links\./i.test(String((e as Error)?.message ?? e))) throw refused('url', 'duplicate');
    throw e;
  }
  return saved;
}
