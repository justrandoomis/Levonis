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
  configIssues,
  mappingResolves,
  publishIssues,
  withPhase2Defaults,
  canonicalCareTerms,
  type CareTerms,
  type PricedServices,
  type PrinterClasses,
  type PrinterServicesConfig,
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
 * Publishes the draft: it must validate fully (`publishIssues`), then it
 * becomes the live price list with the next revision number, which every
 * order line frozen afterwards carries.
 */
export async function publishDraft(db: D1Database, actorId: string, baseRevision: number, nowIso: string): Promise<PrinterServicesState> {
  const { state, token } = await loadPrinterServices(db);
  if (state.draft.revision !== baseRevision) throw conflict('The draft changed since you opened it. Reload.', 'PRINTER_SERVICES_STALE');
  const blocking = [...publishIssues(state.draft), ...(await kitCatalogIssues(db, state.draft))];
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
 * The kit checks only the catalogue can answer (phase 2): every item of an
 * active kit is a product that exists and is not filed under a printer
 * section. Its live price, stock and shipping type are judged where the
 * customer buys it (worker/lib/printerKits.ts), never frozen here.
 */
export async function kitCatalogIssues(db: D1Database, config: PrinterServicesConfig): Promise<string[]> {
  const kits = (config.kits ?? []).filter((k) => k.active);
  const ids = [...new Set(kits.flatMap((k) => k.items.map((i) => i.product_id)))];
  if (!ids.length) return [];
  const found = new Set<string>();
  const printers = new Set<string>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const marks = chunk.map(() => '?').join(',');
    const { results } = await db.prepare(`SELECT id FROM products WHERE id IN (${marks})`).bind(...chunk).all<{ id: string }>();
    for (const r of results ?? []) found.add(r.id);
    const { results: inPrinters } = await db.prepare(
      `SELECT DISTINCT pc.product_id AS id FROM product_catalogs pc
         JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
        WHERE pc.product_id IN (${marks})`
    ).bind(...chunk).all<{ id: string }>();
    for (const r of inPrinters ?? []) printers.add(r.id);
  }
  const out: string[] = [];
  for (const k of kits) for (const it of k.items) {
    if (!found.has(it.product_id)) out.push(`kits.${k.id}: product ${it.product_id} does not exist`);
    else if (printers.has(it.product_id)) out.push(`kits.${k.id}: ${it.product_id} is a printer, not a kit item`);
  }
  return out;
}

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
  /** 0235: the filament kit packed with this printer, as the packing note names it ('' = none). */
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
      + (kitNote ? ` — ${kitNote.slice(0, 600)}` : '')));
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
  lines: Array<{ service: string; choice: string; fee_iqd: number; policy_version?: number }>;
  fee_iqd: number;
  package_discount_iqd: number;
  warranty_months: number;
  care_months: number;
  inspection_lead_business_days: [number, number] | null;
  delivery: string | null;
  delivery_fee_iqd: number | null;
  revision: number | null;
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
        }))
      : [],
    fee_iqd: num(v.fee_iqd),
    package_discount_iqd: num(v.package_discount_iqd),
    warranty_months: num(v.warranty_months),
    care_months: num(v.care_months),
    inspection_lead_business_days: Array.isArray(v.inspection_lead_business_days) ? (v.inspection_lead_business_days as [number, number]) : null,
    delivery: sel && typeof sel.delivery === 'string' ? sel.delivery : null,
    delivery_fee_iqd: typeof v.delivery_fee_iqd === 'number' ? v.delivery_fee_iqd : null,
    revision: typeof v.revision === 'number' ? v.revision : null,
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
