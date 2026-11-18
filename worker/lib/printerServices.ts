/**
 * PRINTER SERVICES — storage (owner brief 2026-11-17; DECISIONS row 339).
 *
 * The owner's price list lives in ONE admin setting, `printerServices`:
 *   { draft, published, published_at, published_by }
 * The draft is what the admin page edits; `published` is what customers are
 * priced against. Until the owner publishes, `published` is null and every
 * printer keeps the legacy warranty flow — the feature is simply off.
 *
 * Writes are compare-and-swap on the stored text, so two admins saving at
 * once cannot silently overwrite each other (the loser gets 409 and reloads),
 * and each write appends its audit row in the same batch, guarded by the same
 * swap, so a lost race writes no audit row.
 *
 * The pure rules (validation, the family lookup, the pricing) are in
 * packages/pricing/src/printerServices.ts; nothing here prices anything.
 */

import {
  DEFAULT_PRINTER_SERVICES,
  canonicalConfig,
  classesFor,
  anchorFeeFor,
  configIssues,
  kitItemKey,
  mappingResolves,
  publishIssues,
  withPhase2Defaults,
  canonicalCareTerms,
  anchorFeeOf,
  type CareTerms,
  type PricedServices,
  type PrinterClasses,
  type PrinterServicesConfig,
  type ServicesOffer,
} from '@levonis/pricing/printerServices';
import { conflict, badRequest, HttpError } from './http';
import { parseConditionDoc } from './condition';
import { newId } from './crypto';
import { forgetPricingInputs } from './membershipBenefits';

export const PRINTER_SERVICES_KEY = 'printerServices';

export interface PrinterServicesState {
  draft: PrinterServicesConfig;
  published: PrinterServicesConfig | null;
  published_at: string | null;
  published_by: string | null;
}

export const PRINTER_SERVICES_INITIAL: PrinterServicesState = Object.freeze({
  draft: DEFAULT_PRINTER_SERVICES,
  published: null,
  published_at: null,
  published_by: null,
}) as PrinterServicesState;

/** Reads the state and the exact stored text (the CAS token). A malformed row reads as the initial state. */
export async function loadPrinterServices(db: D1Database): Promise<{ state: PrinterServicesState; token: string | null }> {
  const row = await db.prepare('SELECT value FROM admin_settings WHERE key = ?').bind(PRINTER_SERVICES_KEY).first<{ value: string }>();
  if (!row) return { state: PRINTER_SERVICES_INITIAL, token: null };
  try {
    const v = JSON.parse(row.value) as Partial<PrinterServicesState>;
    const draft = configIssues(v.draft).length ? DEFAULT_PRINTER_SERVICES : withPhase2Defaults(v.draft as PrinterServicesConfig);
    // A published config that no longer validates is treated as OFF rather
    // than half-applied: customers fall back to the legacy flow. One published
    // before phase 2 reads as «memberships off, no kits» (withPhase2Defaults).
    const published = v.published && !configIssues(v.published).length ? withPhase2Defaults(v.published as PrinterServicesConfig) : null;
    return {
      state: { draft, published, published_at: v.published_at ?? null, published_by: v.published_by ?? null },
      token: row.value,
    };
  } catch {
    return { state: PRINTER_SERVICES_INITIAL, token: row.value };
  }
}

/** What the storefront prices against: the published config or null (feature off). */
export async function publishedPrinterServices(db: D1Database): Promise<PrinterServicesConfig | null> {
  return (await loadPrinterServices(db)).state.published;
}

/**
 * The compare-and-swap write and its audit row, in one batch. The audit row is
 * CONDITIONAL on the same guard: it is inserted only when the write just
 * changed the row (`changes() = 1`, read immediately after the write) AND the
 * setting now holds this request's text — so a write that lost the race
 * leaves no audit row behind. (A raw audit_log row, like the serial ops'
 * guarded rows: the bus envelope cannot be made conditional.)
 */
async function swap(
  db: D1Database, token: string | null, next: PrinterServicesState,
  actorId: string, action: string, detail: Record<string, unknown>,
  /** Statements that ride the same batch, each guarded on the setting holding `text` (`guardedOnSetting`). */
  extra: (text: string) => D1PreparedStatement[] = () => []
): Promise<void> {
  const text = JSON.stringify(next);
  const write = token === null
    ? db.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').bind(PRINTER_SERVICES_KEY, text)
    : db.prepare('UPDATE admin_settings SET value = ? WHERE key = ? AND value = ?').bind(text, PRINTER_SERVICES_KEY, token);
  const audit = db.prepare(
    `INSERT INTO audit_log (actor_id, action, target, detail)
     SELECT ?, ?, ?, ? WHERE changes() = 1 AND EXISTS (SELECT 1 FROM admin_settings WHERE key = ? AND value = ?)`
  ).bind(actorId, action, PRINTER_SERVICES_KEY, JSON.stringify(detail).slice(0, 4000), PRINTER_SERVICES_KEY, text);
  const [res] = await db.batch([write, audit, ...extra(text)]);
  if (!res?.meta?.changes) {
    // Lost the race: nothing was written, the audit row included. Refuse so the admin reloads.
    throw conflict('Someone else changed the printer services. Reload and try again.', 'PRINTER_SERVICES_STALE');
  }
}

/** Saves the draft. `baseRevision` must equal the stored draft's revision (the page's copy). */
export async function saveDraft(db: D1Database, actorId: string, draft: unknown, baseRevision: number): Promise<PrinterServicesState> {
  const { state, token } = await loadPrinterServices(db);
  // A page that does not know the phase 2 fields (membership, kits, a
  // package's tier) keeps what the stored draft holds instead of erasing it.
  if (draft && typeof draft === 'object' && !Array.isArray(draft)) {
    const d = draft as Partial<PrinterServicesConfig>;
    if (d.membership === undefined) d.membership = state.draft.membership;
    if (d.kits === undefined) d.kits = state.draft.kits;
    const pk = d.packages as unknown as Record<string, Record<string, unknown>> | undefined;
    if (pk && typeof pk === 'object') for (const id of ['smart', 'complete'] as const) {
      if (pk[id] && typeof pk[id] === 'object' && pk[id].membership_tier === undefined) pk[id].membership_tier = state.draft.packages[id].membership_tier ?? null;
    }
    // Phase 3 (DECISIONS row 347): a page that does not know the Care terms or the inspection
    // labour figure keeps what the stored draft holds.
    const care = d.care as unknown as Record<string, unknown> | undefined;
    if (care && typeof care === 'object' && care.terms === undefined) care.terms = state.draft.care.terms ?? null;
    const ins = d.inspection as unknown as Record<string, unknown> | undefined;
    if (ins && typeof ins === 'object' && ins.labor_iqd === undefined) ins.labor_iqd = state.draft.inspection.labor_iqd ?? null;
    keepPhase4Fields(d as unknown as Record<string, unknown>, state.draft);
    keepPhase6Fields(d as unknown as Record<string, unknown>, state.draft);
    // The PRO services discount (2026-11-19): a page that does not send it keeps the stored percent.
    if (d.pro_discount_pct === undefined && state.draft.pro_discount_pct !== undefined) d.pro_discount_pct = state.draft.pro_discount_pct;
  }
  const issues = configIssues(draft);
  if (issues.length) throw badRequest(`Invalid printer services: ${issues.slice(0, 5).join('; ')}`, 'PRINTER_SERVICES_INVALID');
  if (state.draft.revision !== baseRevision) throw conflict('The draft changed since you opened it. Reload.', 'PRINTER_SERVICES_STALE');
  // Every save moves the draft revision on, so a page holding an older copy is refused (409).
  // Rebuilt from the validated shape: unknown keys the page sent are not stored.
  const nextDraft = canonicalConfig({ ...(draft as PrinterServicesConfig), revision: state.draft.revision + 1 });
  const next: PrinterServicesState = { ...state, draft: nextDraft };
  await swap(db, token, next, actorId, 'printer_services.draft_saved', {
    revision: nextDraft.revision, products: Object.keys(nextDraft.products).length,
  });
  return next;
}

/**
 * Phase 4 (DECISIONS row 355): a page that does not know the phase 4 fields keeps what the stored
 * draft holds instead of erasing it — the add-ons, each printer's store bundles, a kit's discount
 * (matched by kit id) and a kit item's colour mode (matched by kitItemKey within the same kit).
 * Only ABSENT keys are filled; anything the page sent (null and [] included) is what it meant.
 */
export function keepPhase4Fields(d: Record<string, unknown>, stored: PrinterServicesConfig): void {
  if (d.addons === undefined) d.addons = stored.addons ?? [];
  const products = d.products;
  if (products && typeof products === 'object' && !Array.isArray(products)) {
    for (const [pid, m] of Object.entries(products as Record<string, unknown>)) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
      const row = m as Record<string, unknown>;
      if (row.store_bundle_ids === undefined && Object.hasOwn(stored.products, pid)) {
        row.store_bundle_ids = [...(stored.products[pid].store_bundle_ids ?? [])];
      }
    }
  }
  if (!Array.isArray(d.kits)) return;
  const storedKits = new Map((stored.kits ?? []).map((k) => [k.id, k]));
  for (const k of d.kits as unknown[]) {
    if (!k || typeof k !== 'object' || Array.isArray(k)) continue;
    const kit = k as Record<string, unknown>;
    const was = typeof kit.id === 'string' ? storedKits.get(kit.id) : undefined;
    if (!was) continue;
    if (kit.discount === undefined) kit.discount = was.discount ?? null;
    if (!Array.isArray(kit.items)) continue;
    const modes = new Map(was.items.map((i) => [kitItemKey(i), i.color_mode]));
    for (const it of kit.items as unknown[]) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
      const item = it as Record<string, unknown>;
      if (item.color_mode !== undefined || typeof item.product_id !== 'string' || !Array.isArray(item.option_value_ids)) continue;
      if (!(item.color_id === null || typeof item.color_id === 'string')) continue;
      if (!(item.option_value_ids as unknown[]).every((v) => typeof v === 'string')) continue;
      const mode = modes.get(kitItemKey({ product_id: item.product_id, option_value_ids: item.option_value_ids as string[], color_id: item.color_id as string | null }));
      if (mode) item.color_mode = mode;
    }
  }
}

/**
 * Phase 6 (DECISIONS row 362): a page that does not know the phase 6 fields keeps what the stored
 * draft holds instead of erasing it — the price anchor, the warehouse pickup (switch and note) and
 * delivery class d6's two prices. Only ABSENT keys are filled.
 */
export function keepPhase6Fields(d: Record<string, unknown>, stored: PrinterServicesConfig): void {
  if (d.price_anchor === undefined) d.price_anchor = stored.price_anchor ?? 'none';
  const dl = d.delivery;
  if (!dl || typeof dl !== 'object' || Array.isArray(dl)) return;
  const delivery = dl as Record<string, unknown>;
  if (delivery.pickup === undefined) delivery.pickup = stored.delivery.pickup ?? { active: false, note: null };
  const classes = delivery.classes;
  if (classes && typeof classes === 'object' && !Array.isArray(classes) && (classes as Record<string, unknown>).d6 === undefined) {
    (classes as Record<string, unknown>).d6 = stored.delivery.classes.d6 ?? { economy_iqd: null, personal_iqd: null };
  }
}

/**
 * Publishes the draft: it must validate fully (`publishIssues`), then it
 * becomes the live price list with the next revision number, which every
 * order line frozen afterwards carries.
 */
export async function publishDraft(db: D1Database, actorId: string, baseRevision: number, nowIso: string): Promise<PrinterServicesState> {
  const { state, token } = await loadPrinterServices(db);
  if (state.draft.revision !== baseRevision) throw conflict('The draft changed since you opened it. Reload.', 'PRINTER_SERVICES_STALE');
  // The anchor's price notes (a printer cheaper than its anchor) are told to the owner, never a refusal:
  // such a printer simply sells without the anchor (the pricing rule), and prices move after a publish anyway.
  const blocking = [...publishIssues(state.draft), ...(await printerExtrasCatalogIssues(db, state.draft))];
  if (blocking.length) throw badRequest(`Not ready to publish: ${blocking.slice(0, 5).join('; ')}`, 'PRINTER_SERVICES_NOT_READY');
  const revision = Math.max(state.draft.revision, (state.published?.revision ?? 0) + 1);
  const live: PrinterServicesConfig = { ...state.draft, revision };
  const next: PrinterServicesState = { draft: live, published: live, published_at: nowIso, published_by: actorId };
  const freeze = await carePolicyFreeze(db, live, actorId, nowIso);
  await swap(db, token, next, actorId, 'printer_services.published', {
    revision, products: Object.keys(live.products).length,
    ...(freeze.versions.length ? { care_policy_frozen: freeze.versions } : {}),
  }, freeze.statements);
  // The product page's flag reads the shared pricing inputs: this isolate forgets them now.
  forgetPricingInputs(db);
  return next;
}

/**
 * THE CARE TERMS ARE FROZEN PER VERSION AT THE PUBLISH (phase 3, owner ruling D1; DECISIONS row 347).
 * printer_care_policies (0236) keeps one row per Care policy_version, never updated or deleted
 * (CARE_POLICY_FROZEN). A publish carrying terms:
 *  - writes the row of its version when there is none (same batch as the publish, guarded on the
 *    setting holding the published text, so a publish that lost its race freezes nothing);
 *  - the FIRST terms ever published are v1 for everyone already holding Care: every version from 1
 *    up to the published one gets them (orders sold before the terms existed carry policy_version 1);
 *  - changed terms under a version that already has a row are refused, 409 CARE_POLICY_VERSION_REUSED:
 *    raise care.policy_version (new buyers only) — the customers of that version keep what they bought.
 * A database without 0236 freezes nothing (CLAUDE.md rule 2): the Care desk is off there anyway.
 */
export const CARE_POLICY_VERSION_REUSED_MESSAGE =
  'شروط ليفو كير لهذا الإصدار نُشرت سابقًا ولا تتغير — ارفع رقم إصدار الشروط لتسري على المشترين الجدد / The Levo Care terms of this version were already published and cannot change — raise the terms version so the new terms apply to new buyers / مەرجەکانی لیڤۆ کێری ئەم وەشانە پێشتر بڵاوکراونەتەوە و ناگۆڕدرێن — ژمارەی وەشانی مەرجەکان بەرز بکەرەوە بۆ ئەوەی بۆ کڕیارە نوێیەکان جێبەجێ بن';
const MAX_BACKFILLED_CARE_VERSIONS = 50;
export async function carePolicyFreeze(
  db: D1Database, live: PrinterServicesConfig, actorId: string, nowIso: string
): Promise<{ versions: number[]; statements: (text: string) => D1PreparedStatement[] }> {
  const none = { versions: [] as number[], statements: () => [] as D1PreparedStatement[] };
  const terms = canonicalCareTerms(live.care.terms ?? null);
  if (!terms) return none;
  const version = live.care.policy_version;
  let rows: Array<{ policy_version: number; terms: string }>;
  try {
    rows = (await db.prepare('SELECT policy_version, terms FROM printer_care_policies ORDER BY policy_version').all<{ policy_version: number; terms: string }>()).results ?? [];
  } catch (e) {
    if (/no such table/i.test(String((e as Error)?.message ?? e))) return none;
    throw e;
  }
  const text = JSON.stringify(terms);
  const same = rows.find((r) => Number(r.policy_version) === version);
  if (same) {
    let stored: string;
    try { stored = JSON.stringify(canonicalCareTerms(JSON.parse(same.terms) as CareTerms)); } catch { stored = same.terms; }
    if (stored !== text) throw new HttpError(409, CARE_POLICY_VERSION_REUSED_MESSAGE, 'CARE_POLICY_VERSION_REUSED', { policy_version: version });
    return none;
  }
  const versions = rows.length === 0
    ? Array.from({ length: Math.min(version, MAX_BACKFILLED_CARE_VERSIONS) }, (_, i) => version - i).reverse()
    : [version];
  return {
    versions,
    statements: (settingText: string) => versions.map((v) =>
      db.prepare(
        `INSERT OR IGNORE INTO printer_care_policies (policy_version, terms, published_at, published_by)
         SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM admin_settings WHERE key = ? AND value = ?)`
      ).bind(v, text, nowIso, actorId, PRINTER_SERVICES_KEY, settingText)
    ),
  };
}

/** The frozen Care terms of each version asked for (absent table or version = absent from the map). */
export async function carePolicies(db: D1Database, versions: number[]): Promise<Map<number, CareTerms>> {
  const out = new Map<number, CareTerms>();
  const want = [...new Set(versions.filter((v) => Number.isInteger(v) && v >= 1))];
  if (!want.length) return out;
  try {
    const { results } = await db
      .prepare('SELECT policy_version, terms FROM printer_care_policies WHERE policy_version IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(want))
      .all<{ policy_version: number; terms: string }>();
    for (const r of results ?? []) {
      try { out.set(Number(r.policy_version), JSON.parse(r.terms) as CareTerms); } catch { /* a row that does not parse reads as missing */ }
    }
  } catch (e) {
    if (!/no such table/i.test(String((e as Error)?.message ?? e))) throw e;
  }
  return out;
}

/**
 * The kit, add-on and store-bundle checks only the catalogue can answer
 * (phase 2, widened in phase 4 — DECISIONS row 355): every item of an active
 * kit and every active add-on is a product that exists and is not filed under a
 * printer section; an add-on is not a composition; a customer-colour item has
 * at least one active colour; a store bundle linked to a printer is a product
 * with composition 'bundle'. Live price, stock and shipping type are judged
 * where the customer buys (worker/lib/printerKits.ts), never frozen here.
 */
export async function printerExtrasCatalogIssues(db: D1Database, config: PrinterServicesConfig): Promise<string[]> {
  const kits = (config.kits ?? []).filter((k) => k.active);
  const addons = (config.addons ?? []).filter((a) => a.active);
  const bundles = Object.entries(config.products).flatMap(([pid, m]) => (m.store_bundle_ids ?? []).map((b) => ({ printer: pid, id: b })));
  const ids = [...new Set([
    ...kits.flatMap((k) => k.items.map((i) => i.product_id)),
    ...addons.map((a) => a.product_id),
    ...bundles.map((b) => b.id),
  ])];
  if (!ids.length) return [];
  const composition = new Map<string, string>();
  const printers = new Set<string>();
  const coloured = new Set<string>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const marks = chunk.map(() => '?').join(',');
    const { results } = await db.prepare(`SELECT id, composition FROM products WHERE id IN (${marks})`).bind(...chunk).all<{ id: string; composition: string | null }>();
    for (const r of results ?? []) composition.set(r.id, String(r.composition ?? ''));
    const { results: inPrinters } = await db.prepare(
      `SELECT DISTINCT pc.product_id AS id FROM product_catalogs pc
         JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
        WHERE pc.product_id IN (${marks})`
    ).bind(...chunk).all<{ id: string }>();
    for (const r of inPrinters ?? []) printers.add(r.id);
    const { results: colours } = await db.prepare(
      `SELECT DISTINCT product_id AS id FROM product_colors WHERE active = 1 AND product_id IN (${marks})`
    ).bind(...chunk).all<{ id: string }>();
    for (const r of colours ?? []) coloured.add(r.id);
  }
  const out: string[] = [];
  for (const k of kits) for (const it of k.items) {
    if (!composition.has(it.product_id)) out.push(`kits.${k.id}: product ${it.product_id} does not exist`);
    else if (printers.has(it.product_id)) out.push(`kits.${k.id}: ${it.product_id} is a printer, not a kit item`);
    else if (it.color_mode === 'customer' && !coloured.has(it.product_id)) out.push(`kits.${k.id}: ${it.product_id} has no active colour for the customer to pick`);
  }
  // Phase 4 (DECISIONS row 355): an add-on is an ordinary store product — not a printer, not a bundle or a mystery offer.
  for (const a of addons) {
    if (!composition.has(a.product_id)) out.push(`addons.${a.id}: product ${a.product_id} does not exist`);
    else if (printers.has(a.product_id)) out.push(`addons.${a.id}: ${a.product_id} is a printer, not an add-on`);
    else if (composition.get(a.product_id)) out.push(`addons.${a.id}: ${a.product_id} is a bundle or a mystery offer, not an add-on`);
    else if (a.color_mode === 'customer' && !coloured.has(a.product_id)) out.push(`addons.${a.id}: ${a.product_id} has no active colour for the customer to pick`);
  }
  // A store bundle linked to a printer is a fixed bundle (composition 'bundle'), never a mystery offer.
  for (const b of bundles) {
    if (!composition.has(b.id)) out.push(`products.${b.printer}: store bundle ${b.id} does not exist`);
    else if (composition.get(b.id) !== 'bundle') out.push(`products.${b.printer}: ${b.id} is not a store bundle`);
  }
  return out;
}
/**
 * Phase 6 (DECISIONS row 362) — «THE PRINTER'S PRICE IS BELOW ITS ANCHOR», told to the owner beside the
 * publish issues (never blocking: the pricing rule already protects such a line — it sells without the
 * anchor, at its price plus the services, exactly as a list with no anchor). One line per mapped printer
 * whose LOWEST live direct price (its V2 SKU rows; the product's own price when it has none) is below the
 * Smart package's fee for it. A database without the SKU table reads the product price only.
 */
export async function printerAnchorNotes(db: D1Database, config: PrinterServicesConfig): Promise<string[]> {
  if (config.price_anchor !== 'smart' || !config.packages.smart.active) return [];
  const ids = Object.keys(config.products);
  if (!ids.length) return [];
  const lowest = new Map<string, number>();
  const take = (id: string, v: unknown) => {
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n) || n <= 0) return;
    const was = lowest.get(id);
    if (was === undefined || n < was) lowest.set(id, n);
  };
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const marks = chunk.map(() => '?').join(',');
    let fromSkus = new Set<string>();
    try {
      const { results } = await db.prepare(
        `SELECT product_id AS id, MIN(regular_price_iqd) AS low FROM product_sku_prices
          WHERE product_id IN (${marks}) AND regular_price_iqd > 0 GROUP BY product_id`
      ).bind(...chunk).all<{ id: string; low: number }>();
      for (const r of results ?? []) { take(String(r.id), r.low); fromSkus.add(String(r.id)); }
    } catch {
      fromSkus = new Set<string>();
    }
    const { results: own } = await db.prepare(`SELECT id, price_iqd FROM products WHERE id IN (${marks})`).bind(...chunk).all<{ id: string; price_iqd: number }>();
    for (const r of own ?? []) if (!fromSkus.has(String(r.id))) take(String(r.id), r.price_iqd);
  }
  const out: string[] = [];
  for (const [pid, m] of Object.entries(config.products)) {
    const low = lowest.get(pid);
    if (low === undefined) continue;
    const selections: string[][] = [[], ...Object.keys(m.by_option_value ?? {}).map((ov) => [ov])];
    let anchor = 0;
    for (const ovs of selections) {
      const cls = classesFor(config, pid, ovs);
      const fee = cls ? anchorFeeFor(config, cls) : null;
      if (fee !== null && fee > anchor) anchor = fee;
    }
    if (anchor > 0 && low < anchor) out.push(`products.${pid}: its price (${low}) is below the Smart package (${anchor}) — the price anchor does not apply to it`);
  }
  return out;
}

/** The phase 2 name of printerExtrasCatalogIssues (kept for callers not yet renamed). */
export const kitCatalogIssues = printerExtrasCatalogIssues;

/** Turns the feature off (published → null); the draft is kept. */
export async function unpublish(db: D1Database, actorId: string): Promise<PrinterServicesState> {
  const { state, token } = await loadPrinterServices(db);
  if (!state.published) return state;
  const next: PrinterServicesState = { ...state, published: null, published_at: null, published_by: null };
  await swap(db, token, next, actorId, 'printer_services.unpublished', {
    revision: state.published.revision,
  });
  // The product page's flag reads the shared pricing inputs: this isolate forgets them now.
  forgetPricingInputs(db);
  return next;
}

/** The printers an admin can map: every product filed under a printer catalog, with its versions. */
export async function printerCatalogForMapping(db: D1Database): Promise<Array<{
  id: string; slug: string; name: string; status: string; is_used: boolean;
  versions: Array<{ id: string; name: string }>;
}>> {
  const { results: products } = await db.prepare(
    `SELECT DISTINCT p.id, p.slug, p.name, p.status, p.condition_doc AS condition_doc
       FROM products p
       JOIN product_catalogs pc ON pc.product_id = p.id
       JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
            ORDER BY p.name`
  ).all<{ id: string; slug: string; name: string; status: string; condition_doc: string }>();
  const ids = (products ?? []).map((p) => p.id);
  const versions = new Map<string, Array<{ id: string; name: string }>>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db.prepare(
      `SELECT v.id, v.product_id, v.name_en FROM product_option_values v
        WHERE v.active = 1 AND v.product_id IN (${chunk.map(() => '?').join(',')})
        ORDER BY v.product_id, v.sort`
    ).bind(...chunk).all<{ id: string; product_id: string; name_en: string }>();
    for (const r of results ?? []) {
      const list = versions.get(r.product_id) ?? [];
      list.push({ id: r.id, name: r.name_en });
      versions.set(r.product_id, list);
    }
  }
  return (products ?? []).map((p) => ({
    id: p.id, slug: p.slug, name: p.name, status: p.status, is_used: parseConditionDoc(p.condition_doc) !== null,
    versions: versions.get(p.id) ?? [],
  }));
}

/**
 * The printer's classes for this selection under the PUBLISHED list, or null
 * when the services do not apply: feature off, a used or refurbished listing
 * (it keeps its own warranty), or not mapped.
 *
 * THE OWNER'S MAPPING IS THE ONE ANSWER. It does not consult the printer
 * catalog flag at runtime: the cart reads that flag only when a legacy plan
 * is chosen, and an enrolled printer whose flag was not read would otherwise
 * slip through without its services. Instead the admin door refuses to map a
 * product that is not filed under a printer catalog.
 */
export function enrolledClasses(
  config: PrinterServicesConfig | null,
  product: { id: string; condition: unknown },
  optionValueIds: readonly string[]
): PrinterClasses | null {
  if (!config || product.condition) return null;
  return classesFor(config, product.id, optionValueIds);
}

/**
 * True when the PRODUCT sells the printer services under the published list:
 * new, mapped, and SOME selection of it resolves both classes
 * (`mappingResolves`). Such a product never offers the legacy plans, whatever
 * the current selection resolves to.
 */
export function productEnrolled(config: PrinterServicesConfig | null, product: { id: string; condition: unknown }): boolean {
  return !!config && !product.condition && mappingResolves(config, product.id);
}

/** The published list from a raw setting value (getSettings), or null when off or invalid. */
export function publishedFromSetting(value: unknown): PrinterServicesConfig | null {
  if (!value || typeof value !== 'object') return null;
  const published = (value as { published?: unknown }).published;
  return published && !configIssues(published).length ? withPhase2Defaults(published as PrinterServicesConfig) : null;
}

// ------------------------------------------------------------ the order line

/** Adds the 0234 column to an order-item INSERT only for a line that carries services. */
export function withServicesSnapshot<T extends Record<string, string | number | null>>(
  extra: T | undefined,
  snapshot: string | null
): (T & { services_snapshot?: string }) | undefined {
  if (!snapshot) return extra;
  return { ...(extra ?? ({} as T)), services_snapshot: snapshot };
}

/** Adds the 0235 kit columns to an order-item INSERT only for a filament-kit line. */
export function withKitLink<T extends Record<string, string | number | null>>(
  extra: T | undefined,
  parentItemId: string | null,
  kitId: string | null
): (T & { kit_parent_item_id?: string; kit_id?: string | null }) | undefined {
  if (!parentItemId) return extra;
  return { ...(extra ?? ({} as T)), kit_parent_item_id: parentItemId, kit_id: kitId };
}

/**
 * Phase 4 (DECISIONS row 355; migration 0242): the attached-line columns of an order-item INSERT —
 * a kit line (kit_id) or an add-on line (addon_id), never both — only for a line attached to a
 * printer. `colorMode` (kit_color_mode) is written only when given; `discountIqd`
 * (printer_discount_iqd = discount per unit × qty, report-only) only when > 0, so a database
 * without 0242 keeps working for every line that carries neither.
 */
export function withAttachedLink<T extends Record<string, string | number | null>>(
  extra: T | undefined,
  parentItemId: string | null,
  link: { kitId?: string | null; addonId?: string | null; colorMode?: 'chosen' | 'random' | null; discountIqd?: number | null } = {}
): (T & { kit_parent_item_id?: string; kit_id?: string | null; addon_id?: string; kit_color_mode?: string; printer_discount_iqd?: number }) | undefined {
  if (!parentItemId) return extra;
  const out: Record<string, string | number | null> = { ...(extra ?? ({} as T)), kit_parent_item_id: parentItemId };
  if (link.addonId) out.addon_id = link.addonId;
  else out.kit_id = link.kitId ?? null;
  if (link.colorMode === 'chosen' || link.colorMode === 'random') out.kit_color_mode = link.colorMode;
  const d = Math.trunc(Number(link.discountIqd) || 0);
  if (d > 0) out.printer_discount_iqd = d;
  return out as T & { kit_parent_item_id?: string; kit_id?: string | null; addon_id?: string; kit_color_mode?: string; printer_discount_iqd?: number };
}

/**
 * THE OFFER AS THIS LINE IS PRICED (phase 6): `offer.anchor` is kept only when the anchor really applies
 * to the line — a priced selection that carries it, or (no selection) a price at least as large as the
 * anchor. So «offer.anchor present» always means «the server charges price − anchor + the choice».
 */
export function offerForLine(offer: ServicesOffer, resolved: { applied_iqd: number; services?: PricedServices | null }): ServicesOffer {
  if (!offer.anchor) return offer;
  const applies = resolved.services ? typeof resolved.services.anchor_fee_iqd === 'number' : resolved.applied_iqd >= offer.anchor.fee_iqd;
  if (applies) return offer;
  const { anchor: _dropped, ...rest } = offer;
  return rest;
}

/**
 * A priced selection as the quote and the cart line show it. Phase 6: on an anchored line it also says
 * what the catalogue price already includes (`anchor_fee_iqd`) and what the choice moves the UNIT by
 * (`net_fee_iqd` = fee − anchor: 0 for Smart, negative below it). `fee_iqd` stays what the customer
 * holds; the line's applied / regular / before prices are untouched. Both keys are absent on every
 * other line, which reads exactly as before.
 */
export function pricedServicesView(p: PricedServices): {
  fee_iqd: number; lines: PricedServices['lines']; warranty_months: number; delivery_fee_iqd: number | null; blockers: string[];
  anchor_fee_iqd?: number; net_fee_iqd?: number;
  /** PRO services discount (owner, 2026-11-19): what this PRO saves per unit, services and Personal delivery. */
  pro_discount?: PricedServices['pro_discount'];
} {
  const anchored = typeof p.anchor_fee_iqd === 'number';
  const anchor = anchorFeeOf(p);
  return {
    fee_iqd: p.fee_iqd, lines: p.lines, warranty_months: p.warranty_months, delivery_fee_iqd: p.delivery_fee_iqd, blockers: p.blockers,
    ...(anchored ? { anchor_fee_iqd: anchor, net_fee_iqd: p.fee_iqd - anchor } : {}),
    ...(p.pro_discount ? { pro_discount: p.pro_discount } : {}),
  };
}

/**
 * Phase 6: the printer's delivery as the SHIPPING quote reads it. The warehouse pickup is not a courier
 * choice: on the standard method it reads as «not chosen» (the quote says so; the order is refused with
 * SERVICES_PICKUP_METHOD), on the store's pickup method nothing is quoted at all.
 */
export function courierDeliveryOf(services: PricedServices): 'economy' | 'personal' | null {
  const d = services.selection.delivery;
  return d === 'economy' || d === 'personal' ? d : null;
}

/** A printer set to warehouse pickup ordered with another delivery method (phase 6). */
export { SERVICES_PICKUP_METHOD } from '@levonis/pricing/printerServices';
export const SERVICES_PICKUP_METHOD_TEXT = {
  ar: 'اخترت استلام الطابعة من المخزن — اختر «الاستلام من المتجر» طريقةً للتوصيل، أو غيّر توصيل الطابعة إلى اقتصادي أو شخصي من السلة',
  en: 'You chose to collect the printer from the warehouse — choose store pickup as the delivery method, or change the printer’s delivery to Economy or Personal in the cart',
  ckb: 'هەڵتبژاردووە پرینتەرەکە لە کۆگا وەربگریت — «وەرگرتن لە فرۆشگا» وەک شێوازی گەیاندن هەڵبژێرە، یان لە سەبەتەکەدا گەیاندنی پرینتەرەکە بگۆڕە بۆ ئابووری یان تایبەت',
} as const;
export const SERVICES_PICKUP_METHOD_MESSAGE =
  `${SERVICES_PICKUP_METHOD_TEXT.ar} / ${SERVICES_PICKUP_METHOD_TEXT.en} / ${SERVICES_PICKUP_METHOD_TEXT.ckb}`;

/** The refusal of a serviced printer on a method that is neither standard delivery nor store pickup. */
export const SERVICES_DELIVERY_METHOD_TEXT = {
  ar: 'الطابعة مع خدماتها تُوصَّل بالتوصيل العادي (اقتصادي أو شخصي) أو تُستلم من المتجر — اختر التوصيل العادي أو الاستلام من المتجر',
  en: 'A printer with its services is delivered by standard delivery (Economy or Personal) or collected from the store — choose standard delivery or store pickup',
  ckb: 'چاپکەر لەگەڵ خزمەتگوزارییەکانی بە گەیاندنی ئاسایی (ئابووری یان تایبەت) دەگەیەنرێت یان لە فرۆشگاکە وەردەگیرێت — گەیاندنی ئاسایی یان وەرگرتن لە فرۆشگا هەڵبژێرە',
} as const;
export const SERVICES_DELIVERY_METHOD_MESSAGE =
  `${SERVICES_DELIVERY_METHOD_TEXT.ar} / ${SERVICES_DELIVERY_METHOD_TEXT.en} / ${SERVICES_DELIVERY_METHOD_TEXT.ckb}`;

/**
 * The priced services as the order freezes them for the checkout method
 * (owner ruling 2026-11-17): unchanged on standard delivery (its delivery
 * component is charged by the shipping quote); on store pickup the printer's
 * delivery choice is dropped and recorded as 'pickup' with no delivery fee,
 * since none is charged; null on any other method — the caller refuses
 * (SERVICES_DELIVERY_METHOD).
 */
export function servicesForMethod(services: PricedServices, methodId: string): Record<string, unknown> | PricedServices | null {
  if (methodId === 'standard') return services;
  if (methodId !== 'pickup') return null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { delivery_fee_iqd: _dropped, ...rest } = services;
  return { ...rest, selection: { ...services.selection, delivery: 'pickup' } };
}

const PACKAGING_NOTE: Record<string, string> = {
  standard: 'التغليف: تغليف المصنع القياسي فقط (0 د.ع)',
  extra: 'التغليف: تغليف حماية إضافي',
};
const ACADEMY_NOTE: Record<string, string> = {
  live_whatsapp: 'دورة تعليمية مباشرة عبر واتساب — تواصل مع الزبون لتحديد الموعد',
  live_in_person: 'دورة تعليمية مباشرة حضورياً — تواصل مع الزبون لتحديد الموعد',
};

/**
 * The warehouse's work for one enrolled printer line, from its frozen
 * snapshot: ALWAYS the packaging instruction (standard or extra — the brief:
 * "on every order containing a printer"), the inspection when bought (it
 * blocks dispatch until a staff member completes it), and the live Academy
 * request when bought. Nothing for a line without services.
 */
export function serviceTaskStatements(
  db: D1Database,
  orderId: string,
  orderItemId: string,
  snapshot: string | null,
  nowIso: string,
  /**
   * The line's quantity. A task is ONE per line (UNIQUE(order_item_id, kind))
   * while the services are bought per unit, so the task carries the count and
   * its note says «×N»: staff pack, inspect and teach N printers.
   */
  qty = 1,
  /** 0235: the filament kit (phase 4: and the add-ons) packed with this printer, as the packing note names it ('' = none; at most 1200 characters). */
  kitNote = ''
): D1PreparedStatement[] {
  if (!snapshot) return [];
  const units = Math.max(1, Math.trunc(Number(qty) || 1));
  const times = units > 1 ? ` — ×${units} (لكل طابعة من ${units})` : '';
  let priced: { lines?: Array<{ service?: string; choice?: string; fee_iqd?: number }>; inspection_lead_business_days?: [number, number] | null } | null = null;
  try { priced = JSON.parse(snapshot); } catch { return []; }
  const lines = priced?.lines ?? [];
  const fee = (service: string) => lines.find((l) => l.service === service);
  const out: D1PreparedStatement[] = [];
  const task = (kind: 'packaging' | 'inspection' | 'academy', choice: string, note: string) =>
    db.prepare(
      `INSERT INTO order_service_tasks (id, order_id, order_item_id, kind, choice, qty, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`
    ).bind(newId('ost'), orderId, orderItemId, kind, choice, units, note + times, nowIso);

  const pack = fee('packaging');
  const packChoice = pack?.choice === 'extra' ? 'extra' : 'standard';
  out.push(task('packaging', packChoice,
    (packChoice === 'extra' ? `${PACKAGING_NOTE.extra} (+${(pack?.fee_iqd ?? 0).toLocaleString('en-US')} د.ع)` : PACKAGING_NOTE.standard)
      + (kitNote ? ` — ${kitNote.slice(0, 1200)}` : '')));
  if (fee('inspection')?.choice === 'full') {
    const [lo, hi] = priced?.inspection_lead_business_days ?? [2, 3];
    out.push(task('inspection', 'full', `فحص كامل للطابعة قبل الشحن — لا تُشحن قبل إكماله (يضيف ${lo}–${hi} أيام عمل للتجهيز)`));
  }
  const academy = fee('academy');
  if (academy && (academy.choice === 'live_whatsapp' || academy.choice === 'live_in_person')) {
    out.push(task('academy', academy.choice, ACADEMY_NOTE[academy.choice]));
  }
  return out;
}

/**
 * The frozen services of an order line as every reader shows them: the choice,
 * each service's fee and policy version, the months, the delivery chosen and
 * its per-unit fee. Built from an explicit field list, so nothing internal
 * (the price-list revision is kept: it names the terms bought) can leak.
 */
export function orderServicesView(snapshot: string): {
  selection: Record<string, unknown> | null;
  lines: Array<{ service: string; choice: string; fee_iqd: number; policy_version?: number; fee_before_discount_iqd?: number; pro_discount_iqd?: number }>;
  fee_iqd: number;
  package_discount_iqd: number;
  warranty_months: number;
  care_months: number;
  /** The whole Care cover from delivery (warranty months + 12 after it); a line frozen before phase 5 is computed. */
  care_total_months: number;
  inspection_lead_business_days: [number, number] | null;
  delivery: string | null;
  delivery_fee_iqd: number | null;
  revision: number | null;
  /** Phase 6, only on a line sold under the price anchor: what the printer's price already included, and what the services moved the unit by (fee − that). */
  anchor_fee_iqd?: number;
  net_fee_iqd?: number;
} | null {
  let v: Record<string, unknown>;
  try { v = JSON.parse(snapshot); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  const sel = v.selection && typeof v.selection === 'object' ? (v.selection as Record<string, unknown>) : null;
  return {
    selection: sel
      ? { package: sel.package, warranty: sel.warranty, care: sel.care, packaging: sel.packaging, inspection: sel.inspection, academy: sel.academy, delivery: sel.delivery }
      : null,
    lines: Array.isArray(v.lines)
      ? (v.lines as Array<Record<string, unknown>>).map((l) => ({
          service: String(l.service ?? ''),
          choice: String(l.choice ?? ''),
          fee_iqd: num(l.fee_iqd),
          ...(typeof l.policy_version === 'number' ? { policy_version: l.policy_version } : {}),
          // PRO services discount (2026-11-19): the list fee and the saving, when the line had one.
          ...(typeof l.fee_before_discount_iqd === 'number' && typeof l.pro_discount_iqd === 'number'
            ? { fee_before_discount_iqd: l.fee_before_discount_iqd, pro_discount_iqd: l.pro_discount_iqd }
            : {}),
        }))
      : [],
    fee_iqd: num(v.fee_iqd),
    package_discount_iqd: num(v.package_discount_iqd),
    warranty_months: num(v.warranty_months),
    care_months: num(v.care_months),
    care_total_months: num(v.care_months) > 0 ? (typeof v.care_total_months === 'number' && v.care_total_months > 0 ? v.care_total_months : num(v.warranty_months) + num(v.care_months)) : 0,
    inspection_lead_business_days: Array.isArray(v.inspection_lead_business_days) ? (v.inspection_lead_business_days as [number, number]) : null,
    delivery: sel && typeof sel.delivery === 'string' ? sel.delivery : null,
    delivery_fee_iqd: typeof v.delivery_fee_iqd === 'number' ? v.delivery_fee_iqd : null,
    revision: typeof v.revision === 'number' ? v.revision : null,
    ...(typeof v.anchor_fee_iqd === 'number' ? { anchor_fee_iqd: anchorFeeOf(v), net_fee_iqd: num(v.fee_iqd) - anchorFeeOf(v) } : {}),
  };
}

export interface ServiceTaskRow {
  /** How many printers of the line the task covers (0234); the note says «×N» too. */
  qty?: number;
  id: string; order_item_id: string; kind: string; choice: string; note: string; status: string;
  result_note: string | null; done_by: string | null; done_at: string | null; created_at: string;
}

/** An order's service tasks; empty on a database one migration behind. */
export async function orderServiceTasks(db: D1Database, orderId: string): Promise<ServiceTaskRow[]> {
  try {
    const { results } = await db
      .prepare('SELECT id, order_item_id, kind, choice, qty, note, status, result_note, done_by, done_at, created_at FROM order_service_tasks WHERE order_id = ? ORDER BY created_at, kind')
      .bind(orderId)
      .all<ServiceTaskRow>();
    return results ?? [];
  } catch (e) {
    if (/no such table/i.test(String((e as Error)?.message ?? e))) return [];
    throw e;
  }
}

/** True while an inspection bought on this order is still open: the order may not leave the warehouse. */
export async function openInspectionBlocksDispatch(db: D1Database, orderId: string): Promise<boolean> {
  return (await orderServiceTasks(db, orderId)).some((t) => t.kind === 'inspection' && t.status === 'open');
}

/** Did a D1 write abort on the inspection gate (trg_orders_inspection_gate, 0234)? */
export function isInspectionGateAbort(e: unknown): boolean {
  return /INSPECTION_NOT_DONE/.test(e instanceof Error ? e.message : String(e));
}

/** The one refusal every door answers an open inspection with (409 INSPECTION_NOT_DONE). */
export const INSPECTION_NOT_DONE_MESSAGE =
  'فحص الطابعة قبل الشحن لم يُكمَل بعد — أكمله من تفاصيل الطلب / The pre-dispatch inspection is not done yet — complete it from the order details / پشکنینی چاپکەر پێش ناردن هێشتا تەواو نەکراوە — لە وردەکارییەکانی داواکارییەکەوە تەواوی بکە';
