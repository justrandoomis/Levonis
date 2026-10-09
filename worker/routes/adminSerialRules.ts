/**
 * Admin — SERIAL FORMATS BY BRAND AND PRODUCT (owner decision 2, 2026-10-09;
 * migration 0180 `serial_brand_rules`; docs/DECISIONS.md row 195). The screen
 * is «صيغ الأرقام التسلسلية» beside the serial inventory
 * (src/components/adminWarranty/serialInventory/SerialRulesTab.tsx).
 *
 * Mounted at /api/admin/serial-rules (worker/index.ts), behind the main host
 * and the admin role here as well, so it stays closed if mounted elsewhere.
 *
 *   GET  /                     every rule; the brands with how many of their
 *                              products need a serial; the products that need a
 *                              serial but have NO brand (they fall to the
 *                              generic rule — the owner's list to fix); `installed`
 *   GET  /resolve?product_id=  the rule that judges that product's serials
 *   POST /                     { scope, brand_id | product_id, …rule }          OWNER
 *   PUT  /:id                  { expected_version, brand_id?, …rule }           OWNER
 *   POST /:id/deactivate       { expected_version? }                            OWNER
 *   POST /dry-run              { rule, serials?[≤1000], brand_id? | product_id? } OWNER
 *                              → a verdict per serial, and the impact over at
 *                                most 5,000 of that brand's (or product's)
 *                                inventory serials
 *
 * WHO. Every admin who writes serials READS the rules (the scan sheet and the
 * inventory camera need them). Writing one is the OWNER's act alone
 * (`serialActor().owner`: INITIAL_ADMIN_EMAIL on an admin row), refused to
 * every other admin with 403 OWNER_ONLY before the body is read. Every write
 * lands with its audit row IN THE SAME BATCH: `serial_rule.create`,
 * `serial_rule.update {from, to}` and `serial_rule.deactivate` — the update
 * and the deactivation guarded by `changes() = 1`, so a stale save writes
 * neither the rule nor its audit (409 SERIAL_RULE_CHANGED, and the screen
 * reloads).
 *
 * NO REGEX FROM DATA. Every rule passes `parseSerialRule`
 * (packages/catalog/src/serialRules.ts): strict keys, bounded lists, a named
 * character set and box shape, and no pattern-looking string anywhere —
 * 400 SERIAL_RULE_INVALID {field, reason}.
 *
 * DEPLOY-AHEAD. Before migration 0180: GET answers `installed: false` (the
 * brand lists still work — they read no new table), the writes answer 503
 * SERIAL_RULES_NOT_INSTALLED, and every serial door judges by today's rule.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, int, requireAdmin, requireMainHost, str } from '../lib/http';
import { newId } from '../lib/crypto';
import { auditStatements } from '../lib/audit';
import { refuse, SERIAL_TEXT, serialActor } from '../lib/serialAssignments';
import { serialAssignmentsInstalled, serializedProductSql } from '../lib/serialPolicy';
import {
  RULE_COLS,
  publicRule,
  ruleForProduct,
  ruleFromRow,
  serialRulesInstalled,
  type RuleRow,
} from '../lib/serialRules';
import { BULK_MAX_LINES, classifyCode, normalizeSerial, serialProblem } from '@levonis/catalog/deviceSerials';
import {
  GENERIC_RULE,
  RULE_SPEC_KEYS,
  evaluateSerial,
  parseSerialRule,
  specAsRule,
  type SerialRule,
  type SerialRuleSpec,
} from '@levonis/catalog/serialRules';

export const adminSerialRulesRoutes = new Hono<AppContext>();
adminSerialRulesRoutes.use('*', requireMainHost, requireAdmin);

/** How many inventory serials a dry run judges at most. */
export const DRY_RUN_IMPACT_MAX = 5000;

async function body(c: Context<AppContext>): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => ({}));
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

/** 403 OWNER_ONLY for every admin but the owner — before anything is read. */
function requireRuleOwner(c: Context<AppContext>) {
  if (!serialActor(c.env, c.get('user')!).owner) throw refuse(403, 'OWNER_ONLY');
}

async function requireRulesInstalled(c: Context<AppContext>) {
  if (!(await serialRulesInstalled(c.env.DB))) throw refuse(503, 'SERIAL_RULES_NOT_INSTALLED');
}

function invalid(field: string, reason: string): HttpError {
  return new HttpError(400, SERIAL_TEXT.SERIAL_RULE_INVALID.replace('{field}', field), 'SERIAL_RULE_INVALID', { field, reason });
}

/** The rule fields of a body (strictly parsed); every other key the caller names is handled by the route. */
function parseSpec(b: Record<string, unknown>, routeKeys: readonly string[]): SerialRuleSpec {
  const spec: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (routeKeys.includes(k)) continue;
    spec[k] = v;
  }
  const parsed = parseSerialRule(spec);
  if (!parsed.ok) throw invalid(parsed.field, parsed.reason);
  return parsed.spec;
}

const specColumns = (s: SerialRuleSpec) => [
  s.label,
  s.mode,
  s.charset,
  s.min_len,
  s.max_len,
  JSON.stringify(s.lengths),
  JSON.stringify(s.prefixes),
  s.prefix_policy,
  JSON.stringify(s.positions),
  s.box_sn_shape,
  s.family_check ? 1 : 0,
  s.source_note,
];

/** The spec half of a stored rule, for an audit `{from, to}`. */
const specOf = (r: SerialRule): SerialRuleSpec => {
  const out: Record<string, unknown> = {};
  for (const k of RULE_SPEC_KEYS) out[k] = r[k];
  return out as unknown as SerialRuleSpec;
};

/** One stored rule for the screen: the rule, and what it is bound to. */
function rowPublic(r: RuleRow & { product_name?: string | null; product_name_ar?: string | null }) {
  return {
    ...ruleFromRow(r),
    active: Number(r.active) === 1,
    bound: r.scope === 'product' ? !!r.product_id : !!r.brand_id,
    product_name: r.product_name ?? null,
    product_name_ar: r.product_name_ar ?? null,
    updated_by: r.updated_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

async function readRule(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT ${RULE_COLS.split(',').map((c) => `r.${c.trim()}`).join(', ')}, p.name AS product_name, p.name_ar AS product_name_ar
         FROM serial_brand_rules r LEFT JOIN products p ON p.id = r.product_id WHERE r.id = ?`
    )
    .bind(id)
    .first<RuleRow & { product_name: string | null; product_name_ar: string | null }>();
}

/** An audit row written only when the statement before it changed exactly one row. */
function guardedAudit(db: D1Database, actorId: string, action: string, target: string, detail: Record<string, unknown>): D1PreparedStatement {
  return db
    .prepare('INSERT INTO audit_log (actor_id, action, target, detail) SELECT ?, ?, ?, ? WHERE changes() = 1')
    .bind(actorId, action, target, JSON.stringify(detail).slice(0, 4000));
}

const isUniqueClash = (e: unknown) => /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e));

// ------------------------------------------------------------------ reads

adminSerialRulesRoutes.get('/', async (c) => {
  const db = c.env.DB;
  const actor = serialActor(c.env, c.get('user')!);
  const [installed, withCatalog] = await Promise.all([serialRulesInstalled(db), serialAssignmentsInstalled(db)]);
  // The effective "needs a serial" — the delivery hook's own predicate.
  const needsSerial = serializedProductSql('p.id', 'p.ops_policy', withCatalog);
  const [rules, brands, unbranded] = await Promise.all([
    installed
      ? db
          .prepare(
            `SELECT ${RULE_COLS.split(',').map((x) => `r.${x.trim()}`).join(', ')}, p.name AS product_name, p.name_ar AS product_name_ar
               FROM serial_brand_rules r LEFT JOIN products p ON p.id = r.product_id
              ORDER BY r.active DESC, r.scope, r.label, r.created_at LIMIT 500`
          )
          .all<RuleRow & { product_name: string | null; product_name_ar: string | null }>()
          .then((r) => r.results ?? [])
      : Promise.resolve([]),
    db
      .prepare(
        `SELECT b.id, b.slug, b.name_ar, b.name_en, b.name_ckb, b.active,
                (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id AND ${needsSerial}) AS serialized_products
           FROM brands b ORDER BY b.active DESC, b.name_en, b.name_ar LIMIT 300`
      )
      .all<{ id: string; slug: string; name_ar: string; name_en: string; name_ckb: string; active: number; serialized_products: number }>()
      .then((r) => r.results ?? []),
    // THE OWNER'S LIST (risk 7 of the plan): a product that needs a serial
    // and has no brand is judged by the generic rule — a Bambu printer among
    // them would accept its box number as a serial (with a warning). Set its
    // brand in the product editor.
    db
      .prepare(
        `SELECT p.id, p.slug, p.name, p.name_ar, p.status FROM products p
          WHERE (p.brand_id IS NULL OR p.brand_id = '' OR NOT EXISTS (SELECT 1 FROM brands b WHERE b.id = p.brand_id))
            AND ${needsSerial}
          ORDER BY p.name LIMIT 200`
      )
      .all<{ id: string; slug: string; name: string; name_ar: string | null; status: string }>()
      .then((r) => r.results ?? []),
  ]);
  return c.json({
    success: true,
    installed,
    can_edit: actor.owner,
    rules: rules.map(rowPublic),
    brands: brands.map((b) => ({ ...b, active: Number(b.active) === 1, serialized_products: Number(b.serialized_products) || 0 })),
    unbranded,
    generic: GENERIC_RULE,
  });
});

adminSerialRulesRoutes.get('/resolve', async (c) => {
  const productId = str(c.req.query('product_id'), 'product_id', { max: 80, required: false });
  const [installed, rule] = await Promise.all([serialRulesInstalled(c.env.DB), ruleForProduct(c.env.DB, productId || null)]);
  return c.json({ success: true, installed, rule, public: publicRule(rule) });
});

// ------------------------------------------------------------------ writes (owner)

adminSerialRulesRoutes.post('/', async (c) => {
  requireRuleOwner(c);
  await requireRulesInstalled(c);
  const db = c.env.DB;
  const admin = c.get('user')!;
  const b = await body(c);
  const scope = b.scope;
  if (scope !== 'brand' && scope !== 'product') throw invalid('scope', 'BAD_VALUE');
  const spec = parseSpec(b, ['scope', 'brand_id', 'product_id']);
  let brandId: string | null = null;
  let productId: string | null = null;
  if (scope === 'brand') {
    brandId = str(b.brand_id, 'brand_id', { min: 1, max: 80 });
    if (!(await db.prepare('SELECT 1 AS x FROM brands WHERE id = ?').bind(brandId).first())) throw refuse(400, 'SERIAL_RULE_TARGET_UNKNOWN', { brand_id: brandId });
  } else {
    productId = str(b.product_id, 'product_id', { min: 1, max: 80 });
    if (!(await db.prepare('SELECT 1 AS x FROM products WHERE id = ?').bind(productId).first())) throw refuse(400, 'SERIAL_RULE_TARGET_UNKNOWN', { product_id: productId });
  }
  const id = newId('sbr');
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO serial_brand_rules (id, scope, brand_id, product_id, label, mode, charset, min_len, max_len, lengths, prefixes,
            prefix_policy, positions, box_sn_shape, family_check, source_note, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, scope, brandId, productId, ...specColumns(spec), admin.id),
    ...(await auditStatements(db, admin.id, 'serial_rule.create', id, { scope, brand_id: brandId, product_id: productId, rule: spec })).statements,
  ];
  try {
    await db.batch(stmts);
  } catch (e) {
    if (isUniqueClash(e)) throw refuse(409, 'SERIAL_RULE_EXISTS', { scope, brand_id: brandId, product_id: productId });
    throw e;
  }
  const row = await readRule(db, id);
  return c.json({ success: true, rule: row ? rowPublic(row) : null });
});

adminSerialRulesRoutes.put('/:id', async (c) => {
  requireRuleOwner(c);
  await requireRulesInstalled(c);
  const db = c.env.DB;
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 80 });
  const b = await body(c);
  const expected = int(b.expected_version, 'expected_version', { min: 1, max: 1_000_000 });
  const spec = parseSpec(b, ['expected_version', 'brand_id']);
  const current = await readRule(db, id);
  if (!current) throw refuse(404, 'SERIAL_RULE_NOT_FOUND');
  const from = ruleFromRow(current);
  // «اربطها بعلامة تجارية»: a brand rule may be (re)bound by the owner; a
  // product rule has no brand.
  let brandId: string | null = current.brand_id ?? null;
  if (b.brand_id !== undefined) {
    if (current.scope !== 'brand') throw invalid('brand_id', 'BAD_VALUE');
    const want = str(b.brand_id, 'brand_id', { min: 1, max: 80 });
    if (!(await db.prepare('SELECT 1 AS x FROM brands WHERE id = ?').bind(want).first())) throw refuse(400, 'SERIAL_RULE_TARGET_UNKNOWN', { brand_id: want });
    brandId = want;
  }
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE serial_brand_rules
            SET label = ?, mode = ?, charset = ?, min_len = ?, max_len = ?, lengths = ?, prefixes = ?, prefix_policy = ?, positions = ?,
                box_sn_shape = ?, family_check = ?, source_note = ?, brand_id = ?,
                version = version + 1, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND version = ?`
      )
      .bind(...specColumns(spec), brandId, admin.id, id, expected),
    guardedAudit(db, admin.id, 'serial_rule.update', id, {
      scope: current.scope,
      from: { ...specOf(from), brand_id: current.brand_id ?? null, version: Number(current.version) },
      to: { ...spec, brand_id: brandId, version: expected + 1 },
    }),
  ];
  let changed = 0;
  try {
    const res = await db.batch(stmts);
    changed = Number(res[0]?.meta?.changes ?? 0);
  } catch (e) {
    if (isUniqueClash(e)) throw refuse(409, 'SERIAL_RULE_EXISTS', { brand_id: brandId });
    throw e;
  }
  const now = await readRule(db, id);
  if (!now) throw refuse(404, 'SERIAL_RULE_NOT_FOUND');
  if (changed !== 1) throw refuse(409, 'SERIAL_RULE_CHANGED', { rule: rowPublic(now) });
  return c.json({ success: true, rule: rowPublic(now) });
});

adminSerialRulesRoutes.post('/:id/deactivate', async (c) => {
  requireRuleOwner(c);
  await requireRulesInstalled(c);
  const db = c.env.DB;
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 80 });
  const b = await body(c);
  const expected = b.expected_version === undefined ? null : int(b.expected_version, 'expected_version', { min: 1, max: 1_000_000 });
  const current = await readRule(db, id);
  if (!current) throw refuse(404, 'SERIAL_RULE_NOT_FOUND');
  if (Number(current.active) !== 1) return c.json({ success: true, already: true, rule: rowPublic(current) });
  const res = await db.batch([
    db
      .prepare(
        `UPDATE serial_brand_rules SET active = 0, version = version + 1, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND active = 1 AND (? IS NULL OR version = ?)`
      )
      .bind(admin.id, id, expected, expected),
    guardedAudit(db, admin.id, 'serial_rule.deactivate', id, {
      scope: current.scope,
      brand_id: current.brand_id ?? null,
      product_id: current.product_id ?? null,
      version: Number(current.version),
    }),
  ]);
  const now = await readRule(db, id);
  if (!now) throw refuse(404, 'SERIAL_RULE_NOT_FOUND');
  if (Number(res[0]?.meta?.changes ?? 0) !== 1) {
    if (Number(now.active) !== 1) return c.json({ success: true, already: true, rule: rowPublic(now) });
    throw refuse(409, 'SERIAL_RULE_CHANGED', { rule: rowPublic(now) });
  }
  return c.json({ success: true, rule: rowPublic(now) });
});

/**
 * WHAT A RULE WOULD DO, BEFORE IT IS SAVED — read-only. The pasted serials
 * get a verdict each; with a brand (or a product), the inventory's own
 * serials of it are judged too, at most 5,000, so the owner sees how many
 * would warn or be refused before switching a rule to `enforce`.
 */
adminSerialRulesRoutes.post('/dry-run', async (c) => {
  requireRuleOwner(c);
  const db = c.env.DB;
  const b = await body(c);
  const parsed = parseSerialRule(b.rule ?? {});
  if (!parsed.ok) throw invalid(parsed.field, parsed.reason);
  const rule = specAsRule(parsed.spec);
  const serials = b.serials === undefined ? [] : b.serials;
  if (!Array.isArray(serials)) throw invalid('serials', 'NOT_A_LIST');
  if (serials.length > BULK_MAX_LINES) {
    throw new HttpError(400, `At most ${BULK_MAX_LINES} serials at a time`, 'SERIAL_LIST_TOO_LONG', { max: BULK_MAX_LINES });
  }
  const verdicts = serials.map((raw) => {
    const text = typeof raw === 'string' ? raw.slice(0, 200) : '';
    const norm = normalizeSerial(text);
    const hard = serialProblem(text) ?? (classifyCode({ text }, { boxShape: 'none' }).kind === 'ean' ? 'SERIAL_LOOKS_LIKE_EAN' : null);
    if (hard) return { serial: text, serial_norm: norm, problem: hard, refuse: [], warnings: [] };
    const v = evaluateSerial(norm, rule);
    return { serial: text, serial_norm: norm, problem: null, refuse: v.refuse, warnings: v.warnings, family: v.family?.m ?? null };
  });

  const brandId = str(b.brand_id, 'brand_id', { max: 80, required: false });
  const productId = str(b.product_id, 'product_id', { max: 80, required: false });
  let impact: null | { checked: number; ok: number; warn: number; refuse: number; capped: boolean; by_code: Record<string, number> } = null;
  if (brandId || productId) {
    const { results } = await db
      .prepare(
        productId
          ? `SELECT si.serial_norm FROM serial_inventory si WHERE si.product_id = ? AND si.voided_at IS NULL ORDER BY si.created_at DESC LIMIT ${DRY_RUN_IMPACT_MAX + 1}`
          : `SELECT si.serial_norm FROM serial_inventory si JOIN products p ON p.id = si.product_id
              WHERE p.brand_id = ? AND si.voided_at IS NULL ORDER BY si.created_at DESC LIMIT ${DRY_RUN_IMPACT_MAX + 1}`
      )
      .bind(productId || brandId)
      .all<{ serial_norm: string }>();
    const rows = results ?? [];
    impact = { checked: 0, ok: 0, warn: 0, refuse: 0, capped: rows.length > DRY_RUN_IMPACT_MAX, by_code: {} };
    for (const r of rows.slice(0, DRY_RUN_IMPACT_MAX)) {
      const v = evaluateSerial(r.serial_norm, rule);
      impact.checked += 1;
      if (v.refuse.length) impact.refuse += 1;
      else if (v.warnings.length) impact.warn += 1;
      else impact.ok += 1;
      for (const n of [...v.refuse, ...v.warnings]) impact.by_code[n.code] = (impact.by_code[n.code] ?? 0) + 1;
    }
  }
  return c.json({ success: true, rule: { ...parsed.spec }, verdicts, impact });
});
