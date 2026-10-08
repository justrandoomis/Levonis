/**
 * SERIAL ASSIGNMENTS AT ORDER PREPARATION (migration 0178; owner brief
 * 2026-10-07, 33 sections) — the server half.
 *
 * WHAT EXISTS AND IS REUSED, NOT REBUILT:
 *   - the device asset:        serial_inventory (serial_norm PRIMARY KEY);
 *   - the warranty record:     order_item_units, created at delivery by
 *                              createUnitsOnDelivery with computeCoverage;
 *   - asset → warranty:        device_serials (serial PK, unit_id UNIQUE);
 *   - the history:             audit_log, by target = serial_norm.
 * WHAT IS NEW: `serial_assignments`, the serial bound to an order UNIT before
 * any unit row may exist. One live pending row per serial and per slot
 * (partial UNIQUE indexes), released — never deleted — on unlink, change,
 * cancel (a trigger on `orders`, every door), return and owner override.
 *
 * THE RULES THIS FILE ENFORCES, each inside ONE atomic batch:
 *   §7  first scan: find-or-create the asset once (INSERT … ON CONFLICT DO
 *       NOTHING), bind it, warranty PENDING_DELIVERY (derived, no clock);
 *   §9/§13 an existing asset with no live binding: a new assignment row;
 *   §10 live on another order: refused (the order number to the owner only);
 *   §11 delivered under an open warranty: refused, owner override only;
 *   §17 product / option / EAN / serial-family mismatch: refused;
 *   §18 one serial per slot, one slot per serial;
 *   §19 the preparation gate (setting `serialPrepGate`, ships OFF);
 *   §20 change / unlink before delivery, the asset kept;
 *   §23/§24 server validation, fences re-asserted inside the batch,
 *       idempotency by op_id;
 *   §26/§27 no stock movement; the serial's lot must be one the line was
 *       allocated (FIFO confirms, never chooses);
 *   §8/§28 activation at delivery: device_serials → the new unit, the lot
 *       onto order_item_units.inventory_lot_id, in a batch SEPARATE from the
 *       unit inserts (critique H3) so a failure here never costs a customer
 *       their warranty units.
 *
 * DEPLOY-AHEAD. Everything reads `serialAssignmentsInstalled` first: before
 * migration 0178 the write routes answer 503 SERIALS_NOT_INSTALLED, the order
 * detail says `installed:false`, and activation, the gate and the return hook
 * are no-ops — HEAD behaviour exactly.
 */
import type { Env, SessionUser } from './types';
import { safeParse } from './types';
import { HttpError } from './http';
import { newId } from './crypto';
import { auditStatements } from './audit';
import { fence } from './operations';
import { changedExactlyOne, isLostRace } from './gifts/fence';
import { canMoveMoney, isOwner } from './adminScope';
import { serverMessage } from '../../packages/contracts/src/costRefusals';
import { comboKey } from './inventory';
import { getSetting } from './settings';
import { maskSerial, unitTotalMonths, coverageState, type UnitRow } from './deviceOps';
import { resolveLabelProduct, serialStatusSql, type InventoryStatus } from './serialInventory';
import { serialAssignmentsInstalled, serializationContext, lineDevicePolicy } from './serialPolicy';
import { classifyCode, normalizeEan, normalizeSerial, serialModelHint, serialProblem } from '@levonis/catalog/deviceSerials';

export { serialAssignmentsInstalled } from './serialPolicy';

// ======================================================================
//  Messages — the brief's exact Arabic (§31, §9, §10, §11, §17, §19) is the
//  server's sentence; the client localises by code (src/lib/refusalStrings.ts).
// ======================================================================

export const SERIAL_TEXT = {
  SERIAL_LINKED: 'تم ربط الرقم التسلسلي بالطلب.', // §31
  // §31's sentence (critique-1 #32: one wording; §9 says the same in longer form).
  SERIAL_EXISTING_LINKED: 'الرقم موجود مسبقاً وتم ربطه بهذا الطلب.', // §31
  SERIAL_IN_USE: 'هذا الرقم التسلسلي مرتبط حالياً بطلب آخر.', // §10 (§31: «هذا الرقم التسلسلي مرتبط بطلب آخر.»)
  SERIAL_DELIVERED: 'هذا الجهاز تم تسليمه مسبقاً.', // §31
  SERIAL_DELIVERED_ACTIVE: 'هذا الجهاز تم تسليمه مسبقاً ومربوط بضمان فعال.', // §11
  SERIAL_PRODUCT_MISMATCH: 'الرقم التسلسلي لا يطابق المنتج المحدد.', // §17 (§31: «…لا يطابق هذا المنتج.»)
  SERIALS_REQUIRED: 'تبقى أرقام تسلسلية غير مرتبطة لهذا الطلب.', // §19
  SERIAL_OPTION_MISMATCH: 'الرقم التسلسلي لا يطابق الخيار المطلوب من هذا المنتج.',
  SERIAL_MODEL_MISMATCH: 'الرقم التسلسلي يعود لطراز آخر غير هذا المنتج.',
  SERIAL_BATCH_MISMATCH: 'هذا الجهاز من دفعة غير الدفعة المصروفة لهذا الطلب — خذ القطعة من الدفعة المحددة.',
  SERIAL_IN_USE_THIS_ORDER: 'هذا الرقم مربوط بوحدة أخرى في الطلب نفسه.',
  UNIT_ALREADY_LINKED: 'هذه الوحدة مربوطة برقم آخر — استخدم «تغيير».',
  ORDER_NOT_PREPARABLE: 'لا يمكن ربط الأرقام التسلسلية في هذه المرحلة من الطلب.',
  SERIAL_NOT_REQUIRED: 'هذا المنتج لا يحتاج رقمًا تسلسليًا.',
  UNIT_NOT_OPEN: 'ضمان هذه الوحدة مغلق (أُعيد الجهاز أو أُلغي الطلب أو استُبدل) — لا يُربط بها رقم تسلسلي.',
  SERIAL_INVALID: 'هذا ليس رقمًا تسلسليًا صالحًا — امسح «Product SN» أو اكتبه كما هو مطبوع.',
  SERIAL_NOT_AVAILABLE: 'هذا الجهاز غير متاح للبيع (ملغى أو في الحجر أو مستبدل).',
  SERIAL_UNLINKED: 'أُزيل الرقم التسلسلي من الوحدة.',
  SERIAL_ALREADY_ACTIVATED: 'سُلّم هذا الجهاز وبدأ ضمانه — الطريق الآن مرتجع أو استثناء المالك.',
  SERIAL_ASSIGNMENT_NOT_FOUND: 'لم يُعثر على هذا الربط في الطلب.',
  SERIAL_LINK_RELEASED: 'أُزيل هذا الربط بعد المسح — امسح الرقم مجددًا.',
  // The programme contract's codes speak the contract's ONE server sentence
  // (packages/contracts/src/costRefusals.ts, as `ownerOnly()` does in
  // worker/lib/costAccess.ts): one code, one sentence, from every door.
  OWNER_ONLY: serverMessage('OWNER_ONLY'),
  OVERRIDE_REASON_REQUIRED: 'اكتب سبب الاستثناء (5 أحرف على الأقل).',
  OVERRIDE_UNAVAILABLE: 'هذا الاستثناء غير متاح لهذه الحالة.',
  IDEMPOTENCY_MISMATCH: serverMessage('IDEMPOTENCY_MISMATCH'),
  SERIAL_RACE: 'تغيّر الطلب أثناء المسح — أعد المحاولة.',
  SERIALS_NOT_INSTALLED: 'ميزة ربط الأرقام التسلسلية لم تُفعّل على قاعدة البيانات بعد.',
  SERIAL_STORY_UNAVAILABLE: 'تعذّرت قراءة سجل هذا الرقم التسلسلي الآن — أعد المحاولة بعد قليل.',
  ORDER_NOT_FOUND: 'الطلب غير موجود.',
  ITEM_NOT_IN_ORDER: 'هذا المنتج ليس ضمن هذا الطلب.',
  RETURN_SERIAL_MISMATCH: 'هذا الرقم التسلسلي ليس جهازًا من هذا البند لدى هذا الزبون.',
  RETURN_UNIT_MISMATCH: 'هذه الوحدة ليست وحدة مفتوحة من هذا البند.',
} as const;
export type SerialCode = keyof typeof SERIAL_TEXT;

export const refuse = (status: number, code: SerialCode, details?: Record<string, unknown>) =>
  new HttpError(status, SERIAL_TEXT[code], code, details);

// ======================================================================
//  Who is asking
// ======================================================================

export interface SerialActor {
  id: string;
  /**
   * INITIAL_ADMIN_EMAIL on an admin row — the Main Admin of the brief. S1's
   * rule for owner-only acts that carry no cost (`requireOwner`,
   * `userPatchRefusal` in worker/lib/adminScope.ts): `isOwner` and the admin
   * role. NOT the verified-owner rule of cost (`canViewCost`) — no serial door
   * answers a cost, so an owner whose address is not verified yet still makes
   * the serial exceptions.
   */
  owner: boolean;
  /**
   * The owner and full-scope (or legacy NULL-scope) admins see the whole
   * serial; assistants the masked form. That is exactly S1's `canMoveMoney`
   * (the owner first, then any admin whose scope is not 'assistant') — a
   * serial is no cost, so the cost predicates do not decide it.
   */
  fullSerial: boolean;
}

export function serialActor(env: Env, user: SessionUser): SerialActor {
  const owner = user.role === 'admin' && isOwner(env, user);
  return { id: user.id, owner, fullSerial: canMoveMoney(env, user) };
}

const shown = (raw: string, actor: Pick<SerialActor, 'fullSerial'>) => (actor.fullSerial ? raw : maskSerial(raw));
const nowIso = () => new Date().toISOString();

// ======================================================================
//  The scan window — when a unit is physically on this shelf, after the
//  deduct (STOCK_DEDUCTED_STATES) and before dispatch.
// ======================================================================

export const SCAN_DIRECT_STAGES = ['confirmed', 'preparing'] as const;
export const SCAN_PREORDER_STAGES = ['at_levo_warehouse', 'local_delivery_prep'] as const;

/** Whether a serial may be linked by staff — `scanWindowSql` in TypeScript (pinned by a test). */
export function serialScanWindow(shippingType: string, stage: string, status: string): boolean {
  if (status !== 'confirmed' && status !== 'processing') return false;
  if (shippingType === 'direct') return (SCAN_DIRECT_STAGES as readonly string[]).includes(stage);
  return (SCAN_PREORDER_STAGES as readonly string[]).includes(stage);
}

export const scanWindowSql = (o: string) =>
  `(${o}.status IN ('confirmed','processing') AND ((${o}.shipping_type = 'direct' AND ${o}.stage IN ('confirmed','preparing'))` +
  ` OR (${o}.shipping_type <> 'direct' AND ${o}.stage IN ('at_levo_warehouse','local_delivery_prep'))))`;

/**
 * M1 — the line's stock was really taken. A tracked line has a `reserve` row
 * from checkout; until its `deduct` exists the FIFO lot is not chosen and the
 * scan would be choosing it. Untracked lines have no ledger rows and pass.
 * `instr`, never LIKE: line ids contain `_` (critique L17).
 */
export const deductEvidenceSql = (orderExpr: string, itemExpr: string) =>
  `(NOT EXISTS (SELECT 1 FROM inventory_ledger lr WHERE lr.order_id = ${orderExpr} AND lr.kind = 'reserve'
                  AND instr(lr.idempotency_key, ':' || ${itemExpr} || ':') > 0)
    OR EXISTS (SELECT 1 FROM inventory_ledger ld WHERE ld.order_id = ${orderExpr} AND ld.kind = 'deduct'
                  AND instr(ld.idempotency_key, ':' || ${itemExpr} || ':') > 0))`;

// ======================================================================
//  Which units need a serial — the ONE predicate delivery, the order screen,
//  the scan route and the gate share (lineDevicePolicy).
// ======================================================================

export interface OrderFacts {
  id: string;
  user_id: string;
  status: string;
  stage: string;
  shipping_type: string;
  seller_type: string;
  delivery_remote_id: string;
  created_at: string;
  delivered_at: string | null;
}

export interface LineFacts {
  id: string;
  product_id: string | null;
  qty: number;
  name_snapshot: string;
  option_snapshot: string;
  option_value_ids: string;
  color_id: string;
  warranty_snapshot: string | null;
  ops_policy: string | null;
  p_name: string | null;
  p_name_ar: string | null;
  bundle_parent_item_id: string | null;
  is_bundle_parent: number;
}

export interface SerialSlot {
  order_item_id: string;
  unit_index: number;
  part: 'device';
  part_index: 1;
  product_id: string;
  product_name: string;
  variant_label: string | null;
}

export async function readOrderFacts(db: D1Database, orderId: string): Promise<OrderFacts | null> {
  const o = await db
    .prepare(
      `SELECT id, user_id, status, stage, shipping_type, COALESCE(seller_type,'') AS seller_type,
              COALESCE(delivery_remote_id,'') AS delivery_remote_id, created_at, delivered_at
         FROM orders WHERE id = ?`
    )
    .bind(orderId)
    .first<OrderFacts>();
  return o ?? null;
}

export async function readOrderLines(db: D1Database, orderId: string): Promise<LineFacts[]> {
  const { results } = await db
    .prepare(
      `SELECT oi.id, oi.product_id, oi.qty, COALESCE(oi.name_snapshot,'') AS name_snapshot,
              COALESCE(oi.option_snapshot,'') AS option_snapshot, COALESCE(oi.option_value_ids,'[]') AS option_value_ids,
              COALESCE(oi.color_id,'') AS color_id, oi.warranty_snapshot, p.ops_policy, p.name AS p_name, p.name_ar AS p_name_ar,
              oi.bundle_parent_item_id,
              EXISTS (SELECT 1 FROM order_items c WHERE c.bundle_parent_item_id = oi.id) AS is_bundle_parent
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ? ORDER BY oi.rowid`
    )
    .bind(orderId)
    .all<LineFacts>();
  return results ?? [];
}

/**
 * Every physical unit slot of this order that needs a serial. A bundle PARENT
 * never does (critique M8): its devices are its component rows, which carry
 * their own slots — asking twice would demand two serials for one box. A
 * community-store order never does (M9): the merchant's goods are not the
 * platform's devices.
 */
export async function serialRequiredSlots(
  db: D1Database,
  orderId: string,
  pre?: { order: OrderFacts | null; lines: LineFacts[] }
): Promise<{ order: OrderFacts | null; lines: LineFacts[]; slots: SerialSlot[] }> {
  const order = pre ? pre.order : await readOrderFacts(db, orderId);
  if (!order) return { order: null, lines: [], slots: [] };
  const lines = pre ? pre.lines : await readOrderLines(db, orderId);
  if (order.seller_type === 'merchant') return { order, lines, slots: [] };
  const ctx = await serializationContext(db, lines.map((l) => String(l.product_id ?? '')));
  const slots: SerialSlot[] = [];
  for (const l of lines) {
    if (!l.product_id || Number(l.is_bundle_parent) === 1) continue;
    if (!lineDevicePolicy(l.ops_policy, l.product_id, ctx).serialized) continue;
    const qty = Math.min(Math.max(Number(l.qty) || 0, 0), 500);
    const name = l.name_snapshot || l.p_name || '';
    for (let i = 1; i <= qty; i++) {
      slots.push({
        order_item_id: l.id,
        unit_index: i,
        part: 'device',
        part_index: 1,
        product_id: l.product_id,
        product_name: name,
        variant_label: l.option_snapshot || null,
      });
    }
  }
  return { order, lines, slots };
}

/** The platform variant (SKU row) a Levonis line resolves to, or null. */
export async function resolveLineVariant(
  db: D1Database,
  line: Pick<LineFacts, 'product_id' | 'option_value_ids' | 'color_id'>
): Promise<{ variant_id: string; sku: string | null } | null> {
  if (!line.product_id) return null;
  const ids = safeParse<unknown>(line.option_value_ids, []);
  const key = comboKey({
    option_value_ids: Array.isArray(ids) ? ids.map(String) : [],
    color_id: line.color_id || null,
  });
  if (!key) return null;
  const v = await db
    .prepare('SELECT id, sku FROM product_variants WHERE product_id = ? AND combo_key = ?')
    .bind(line.product_id, key)
    .first<{ id: string; sku: string | null }>();
  return v ? { variant_id: v.id, sku: v.sku } : null;
}

// ======================================================================
//  ONE canonicaliser for every source (critique H1): camera, scanner,
//  manual, relink. A box SN, an EAN / UPC / ITF-14 of any length, a receipt
//  or anything not serial-shaped never becomes an asset.
// ======================================================================

export type ScanInput =
  | { kind: 'serial'; norm: string; raw: string }
  | { kind: 'box_sn'; box: string }
  | { kind: 'invalid'; problem: string };

/**
 * A printed prefix a QR payload, a wedge read or a typed value may carry —
 * `SN: …`, `S/N: …`, `Product SN: …` AND `SN 0391…` with only a space
 * (critique H1: without the colon it used to normalise to `SN0391…`, a second
 * asset for one device). A separator is required, so a serial that merely
 * starts with S and N is kept.
 */
export function stripSerialPrefix(text: string): string {
  return String(text ?? '').replace(/^\s*(?:product\s*)?s\s*\/?\s*n(?:\s*[:：#]\s*|\s+)(?=\S)/i, '').trim();
}

/** Pure: what one scanned or typed value is. */
export function classifyScanInput(code: unknown): ScanInput {
  const text = stripSerialPrefix(String(code ?? '').slice(0, 200));
  // `classifyCode` with no barcode format: a valid GTIN of ANY length (EAN-8,
  // UPC-A, EAN-13, ITF-14) is a product code, never a device.
  const c = classifyCode({ text });
  if (c.kind === 'receipt') return { kind: 'invalid', problem: 'SERIAL_LOOKS_LIKE_RECEIPT' };
  if (c.kind === 'ean') return { kind: 'invalid', problem: 'SERIAL_LOOKS_LIKE_EAN' };
  if (c.kind === 'unknown') return { kind: 'invalid', problem: serialProblem(text) ?? 'SERIAL_CHARS' };
  if (c.kind === 'box_sn') return { kind: 'box_sn', box: c.value };
  const raw = text.replace(/\s+/g, ' ').trim().slice(0, 80);
  return { kind: 'serial', norm: c.value, raw: raw || c.value };
}

// ---------------------------------------------------- §17 serial model metadata

const nameTokens = (text: string | null | undefined): string[] =>
  String(text ?? '')
    .toLowerCase()
    .replace(/([a-z0-9])(mini|combo)\b/g, '$1 $2')
    .split(/[^a-z0-9\u0600-\u06ff]+/)
    .filter(Boolean);
/** A model code: a letter then a digit (`a1`, `p1s`, `x1`, `h2d`, `x2d`). */
const MODEL_TOKEN = /^[a-z]\d[a-z0-9]*$/;
/** Words that make ANOTHER machine of a family; Combo / AMS / Lite are bundles, not machines. */
const FAMILY_SPLIT = new Set(['mini', 'pro', 'max', 'plus', 'carbon', 'ultra', 'se']);

/**
 * A serial whose prefix names one family (`serialModelHint`) filed on a line
 * whose product name states ANOTHER: 030 (A1 mini) on «A1 Combo», 039 (A1) on
 * «A1 mini» or «X2D Combo». Null when they agree or either side is unknown —
 * an unknown prefix or a name without a model code is not evidence.
 */
export function serialFamilyConflict(serial: string, productNames: ReadonlyArray<string | null | undefined>): { serial_family: string; product_family: string } | null {
  const hint = serialModelHint(serial);
  if (!hint) return null;
  const want = nameTokens(hint.model);
  const model = want.find((t) => MODEL_TOKEN.test(t));
  if (!model) return null;
  for (const name of productNames) {
    const have = nameTokens(name);
    const models = have.filter((t) => MODEL_TOKEN.test(t));
    if (!models.length) continue;
    const label = String(name ?? '').trim().slice(0, 80);
    if (!models.includes(model)) return { serial_family: hint.model, product_family: label };
    const splitWant = want.filter((t) => FAMILY_SPLIT.has(t));
    const splitHave = have.filter((t) => FAMILY_SPLIT.has(t));
    if (splitWant.some((t) => !have.includes(t)) || splitHave.some((t) => !want.includes(t))) {
      return { serial_family: hint.model, product_family: label };
    }
    return null;
  }
  return null;
}

/**
 * The device serial a scan names, resolved against the store: a BOX SN only
 * counts through the asset that carries it (`idx_serial_inventory_box`); a
 * value shaped like a box SN that the store already holds AS a device serial
 * is that device.
 */
export async function canonicalSerial(db: D1Database, code: unknown): Promise<{ norm: string; raw: string; viaBox: boolean }> {
  const c = classifyScanInput(code);
  if (c.kind === 'invalid') throw refuse(400, 'SERIAL_INVALID', { problem: c.problem });
  if (c.kind === 'serial') return { norm: c.norm, raw: c.raw, viaBox: false };
  const asSerial = await db
    .prepare('SELECT serial_norm, serial_raw FROM serial_inventory WHERE serial_norm = ?')
    .bind(c.box)
    .first<{ serial_norm: string; serial_raw: string }>();
  if (asSerial) return { norm: asSerial.serial_norm, raw: asSerial.serial_raw, viaBox: false };
  const byBox = await db
    .prepare("SELECT serial_norm, serial_raw FROM serial_inventory WHERE box_sn = ? AND box_sn <> '' ORDER BY created_at LIMIT 1")
    .bind(c.box)
    .first<{ serial_norm: string; serial_raw: string }>();
  if (byBox) return { norm: byBox.serial_norm, raw: byBox.serial_raw, viaBox: true };
  throw refuse(400, 'SERIAL_INVALID', { problem: 'BOX_ONLY' });
}

/** The companion box SN of a label read, kept only when it really is one. */
function companionBox(raw: unknown): string {
  const b = normalizeSerial(String(raw ?? '').slice(0, 80));
  return b.length >= 4 && b.length <= 60 && /^[A-Z0-9]+$/.test(b) ? b : '';
}

// ======================================================================
//  Rows
// ======================================================================

export interface AssignmentRow {
  id: string;
  serial_norm: string;
  serial_raw: string;
  order_id: string | null;
  order_item_id: string | null;
  order_ref: string;
  unit_index: number;
  part: string;
  part_index: number;
  product_id: string | null;
  variant_id: string | null;
  lot_id: string | null;
  lot_source: string | null;
  allocation_id: string | null;
  source: string;
  warranty_mode: 'new' | 'carry' | 'restart';
  prior_unit_id: string | null;
  override_kind: string | null;
  override_reason: string | null;
  adopted_product: number;
  idempotency_key: string;
  linked_by: string;
  linked_at: string;
  unit_id: string | null;
  activated_at: string | null;
  activation_attempts: number;
  released_at: string | null;
  released_by: string | null;
  release_reason: string | null;
  release_note: string;
  return_case_id: string | null;
}

interface Binding {
  unit_id: string;
  order_id: string;
  order_item_id: string;
  unit_index: number;
  owner_user_id: string;
  delivered_at: string | null;
  warranty_end_at: string | null;
  warranty_closed_at: string | null;
  warranty_closed_reason: string | null;
  replaced_by_unit_id: string | null;
  warranty_base_months: number | null;
  warranty_ext_months: number;
  policy_version: string;
  /** The unit's order status now — a unit an undone-delivery cancel closed is open again once that order is re-delivered. */
  order_status: string | null;
}

export interface LotFacts {
  lot_id: string;
  allocation_id: string;
  scope: string;
  scope_id: string;
  net: number;
  taken: number;
  received_at: string | null;
  location: string | null;
}

async function tryAll<T>(run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run();
  } catch {
    return [];
  }
}
async function tryFirst<T>(run: () => Promise<T | null>): Promise<T | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}

/** The line's lots with what each still owes: net allocated minus live serials on it. Never cost. */
export async function lineLots(db: D1Database, itemId: string): Promise<LotFacts[]> {
  const rows = await tryAll(async () =>
    (
      await db
        .prepare(
          `SELECT a.lot_id, MIN(a.id) AS allocation_id, a.scope, a.scope_id,
                  SUM(CASE WHEN a.released_at IS NULL THEN a.qty ELSE -a.qty END) AS net,
                  (SELECT COUNT(*) FROM serial_assignments s WHERE s.order_item_id = a.order_item_id
                      AND s.lot_id = a.lot_id AND s.released_at IS NULL) AS taken,
                  l.received_at,
                  (SELECT sl.name FROM inventory_lot_locations ll JOIN stock_locations sl ON sl.id = ll.location_id
                    WHERE ll.lot_id = a.lot_id) AS location
             FROM order_item_inventory_allocations a LEFT JOIN inventory_lots l ON l.id = a.lot_id
            WHERE a.order_item_id = ?
            GROUP BY a.lot_id, a.scope, a.scope_id
            ORDER BY MIN(a.id)`
        )
        .bind(itemId)
        .all<LotFacts>()
    ).results ?? []
  );
  return rows.map((r) => ({ ...r, net: Number(r.net) || 0, taken: Number(r.taken) || 0 }));
}

interface SerialLot {
  lot_id: string;
  order_item_id: string | null;
  lot_product_id: string | null;
  scope: string;
  scope_id: string;
  linked_order_status: string | null;
}

async function serialLotOf(db: D1Database, norm: string): Promise<SerialLot | null> {
  return tryFirst(() =>
    db
      .prepare(
        `SELECT sl.lot_id, sl.order_item_id, l.product_id AS lot_product_id, l.scope, l.scope_id,
                (SELECT o.status FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id = sl.order_item_id) AS linked_order_status
           FROM stock_serial_links sl JOIN inventory_lots l ON l.id = sl.lot_id
          WHERE sl.serial_norm = ?`
      )
      .bind(norm)
      .first<SerialLot>()
  );
}

const ASSIGNMENT_COLS = `id, serial_norm, serial_raw, order_id, order_item_id, order_ref, unit_index, part, part_index,
  product_id, variant_id, lot_id, lot_source, allocation_id, source, warranty_mode, prior_unit_id, override_kind,
  override_reason, adopted_product, idempotency_key, linked_by, linked_at, unit_id, activated_at, activation_attempts,
  released_at, released_by, release_reason, release_note, return_case_id`;

async function bindingOf(db: D1Database, norm: string): Promise<Binding | null> {
  return db
    .prepare(
      `SELECT d.unit_id, u.order_id, u.order_item_id, u.unit_index, u.owner_user_id, u.delivered_at, u.warranty_end_at,
              u.warranty_closed_at, u.warranty_closed_reason, u.replaced_by_unit_id,
              u.warranty_base_months, u.warranty_ext_months, u.policy_version, o.status AS order_status
         FROM device_serials d JOIN order_item_units u ON u.id = d.unit_id LEFT JOIN orders o ON o.id = u.order_id
        WHERE d.serial_norm = ?`
    )
    .bind(norm)
    .first<Binding>();
}

// ======================================================================
//  LINK — scan, change, relink and every owner override, one path.
// ======================================================================

export type OverrideKind = 'take_from_order' | 'delivered_device' | 'unavailable' | 'outside_window' | 'batch' | 'model_family';
export const OVERRIDE_KINDS: readonly OverrideKind[] = [
  'take_from_order',
  'delivered_device',
  'unavailable',
  'outside_window',
  'batch',
  'model_family',
];
export type LinkSource = 'camera' | 'scanner' | 'manual' | 'relink';

export interface LinkRequest {
  orderId: string;
  orderItemId: string;
  unitIndex: number;
  part?: string;
  partIndex?: number;
  code: unknown;
  ean?: unknown;
  boxSn?: unknown;
  source: LinkSource;
  opId: string;
  /** Change: the live assignment this link replaces, in the same batch. */
  replaceAssignmentId?: string;
  /** Owner only (the route checks): kind, reason, and the resale warranty mode. */
  override?: { kind: OverrideKind; reason: string; warrantyMode?: 'carry' | 'restart' };
}

export interface SlotView {
  order_item_id: string;
  unit_index: number;
  part: string;
  assignment: null | {
    id: string;
    serial_display: string;
    serial_full?: string;
    linked_at: string;
    linked_by: string;
    source: string;
    lot: { id: string; received_at: string | null; location: string | null } | null;
    lot_source: string | null;
    warranty: { state: 'PENDING_DELIVERY' | 'ACTIVE' | 'EXPIRED' | 'NEEDS_CONFIG' | 'RETURNED' | 'CLOSED'; mode: string; carries_until: string | null };
    override_kind: string | null;
  };
}

export interface LinkResult {
  success: true;
  outcome: 'created' | 'existing' | 'already';
  code: 'SERIAL_LINKED' | 'SERIAL_EXISTING_LINKED';
  message: string;
  assignment_id: string;
  slot: SlotView;
  warnings: string[];
}

type LiveRow = AssignmentRow & { o_status: string | null; o_remote: string; o_stage: string | null; o_shipping: string | null };

interface LinkContext {
  order: OrderFacts | null;
  line: LineFacts | null;
  slots: SerialSlot[];
  asset: { serial_norm: string; serial_raw: string; product_id: string | null; variant_id: string | null; voided_at: string | null; box_sn: string; source: string } | null;
  boxOwner: string | null;
  boxIsSerial: boolean;
  live: Array<LiveRow>;
  slotLive: AssignmentRow | null;
  binding: Binding | null;
  receipt: { id: string; unit_id: string; order_id: string | null } | null;
  serialLot: SerialLot | null;
  lots: LotFacts[];
  variant: { variant_id: string; sku: string | null } | null;
  ledger: { reserved: boolean; deducted: boolean; latest: string | null };
  lastReleased: AssignmentRow | null;
  /** M7: the same device stored under a pre-2026-09-26 key (see `legacyAliases`). */
  legacy: LegacyAlias[];
}

export interface LegacyAlias {
  serial_norm: string;
  /** An open warranty (unit not closed, not replaced) or a live receipt. */
  open: boolean;
}

/**
 * CRITIQUE M7 — KEYS WRITTEN BEFORE THE NORMALISER LEARNED ITS LAST RULES.
 * Until 2026-09-26 `device_serials` / `warranty_receipts` keys were only
 * trimmed, upper-cased and stripped of spaces and `-`, so an old key may still
 * hold Arabic-Indic digits, a bidi mark or a Unicode dash. An equality test
 * (fence S5) would miss that delivered device and activation would give it a
 * SECOND device_serials row — a duplicate warranty. Today's keys are pure
 * `[0-9A-Z]`, so the census is only the rows that are not (`GLOB`), bounded,
 * each normalised here and compared with the scanned serial.
 */
export async function legacyAliases(db: D1Database, norm: string): Promise<LegacyAlias[]> {
  const [units, receipts] = await Promise.all([
    tryAll(async () =>
      (
        await db
          .prepare(
            `SELECT d.serial_norm, (u.warranty_closed_at IS NULL AND u.replaced_by_unit_id IS NULL) AS open
               FROM device_serials d JOIN order_item_units u ON u.id = d.unit_id
              WHERE d.serial_norm GLOB '*[^0-9A-Z]*' LIMIT 5000`
          )
          .all<{ serial_norm: string; open: number }>()
      ).results ?? []
    ),
    tryAll(async () =>
      (
        await db
          .prepare(
            `SELECT serial_norm FROM warranty_receipts
              WHERE status IN ('draft','active') AND serial_norm GLOB '*[^0-9A-Z]*' LIMIT 5000`
          )
          .all<{ serial_norm: string }>()
      ).results ?? []
    ),
  ]);
  const out = new Map<string, boolean>();
  for (const u of units) if (u.serial_norm !== norm && normalizeSerial(u.serial_norm) === norm) out.set(u.serial_norm, (out.get(u.serial_norm) ?? false) || Number(u.open) === 1);
  for (const r of receipts) if (r.serial_norm !== norm && normalizeSerial(r.serial_norm) === norm) out.set(r.serial_norm, true);
  return [...out].map(([serial_norm, open]) => ({ serial_norm, open }));
}

async function readLinkContext(db: D1Database, req: LinkRequest, norm: string, boxSn: string): Promise<LinkContext> {
  const { order, lines, slots } = await serialRequiredSlots(db, req.orderId);
  const line = lines.find((l) => l.id === req.orderItemId) ?? null;
  const part = req.part ?? 'device';
  const partIndex = req.partIndex ?? 1;
  const [asset, boxOwner, boxIsSerial, live, slotLive, binding, receipt, serialLot, lots, variant, ledger, lastReleased, legacy] = await Promise.all([
    db
      .prepare('SELECT serial_norm, serial_raw, product_id, variant_id, voided_at, box_sn, source FROM serial_inventory WHERE serial_norm = ?')
      .bind(norm)
      .first<NonNullable<LinkContext['asset']>>(),
    db
      .prepare("SELECT serial_norm FROM serial_inventory WHERE box_sn = ? AND box_sn <> '' AND serial_norm <> ? LIMIT 1")
      .bind(norm, norm)
      .first<{ serial_norm: string }>()
      .then((r) => r?.serial_norm ?? null),
    boxSn
      ? db
          .prepare('SELECT 1 AS x FROM serial_inventory WHERE serial_norm = ? AND serial_norm <> ?')
          .bind(boxSn, norm)
          .first()
          .then((r) => !!r)
      : Promise.resolve(false),
    db
      .prepare(
        `SELECT ${ASSIGNMENT_COLS.split(',').map((c) => `a.${c.trim()}`).join(', ')}, o.status AS o_status,
                COALESCE(o.delivery_remote_id,'') AS o_remote, o.stage AS o_stage, o.shipping_type AS o_shipping
           FROM serial_assignments a LEFT JOIN orders o ON o.id = a.order_id
          WHERE a.serial_norm = ? AND a.released_at IS NULL`
      )
      .bind(norm)
      .all<LiveRow>()
      .then((r) => r.results ?? []),
    db
      .prepare(
        `SELECT ${ASSIGNMENT_COLS} FROM serial_assignments
          WHERE order_item_id = ? AND unit_index = ? AND part = ? AND part_index = ? AND released_at IS NULL`
      )
      .bind(req.orderItemId, req.unitIndex, part, partIndex)
      .first<AssignmentRow>(),
    bindingOf(db, norm),
    db
      .prepare("SELECT id, unit_id, order_id FROM warranty_receipts WHERE serial_norm = ? AND status IN ('draft','active') LIMIT 1")
      .bind(norm)
      .first<{ id: string; unit_id: string; order_id: string | null }>(),
    serialLotOf(db, norm),
    lineLots(db, req.orderItemId),
    line ? resolveLineVariant(db, line) : Promise.resolve(null),
    db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM inventory_ledger WHERE order_id = ?1 AND kind = 'reserve' AND instr(idempotency_key, ':' || ?2 || ':') > 0) AS reserved,
                EXISTS (SELECT 1 FROM inventory_ledger WHERE order_id = ?1 AND kind = 'deduct' AND instr(idempotency_key, ':' || ?2 || ':') > 0) AS deducted,
                (SELECT kind FROM inventory_ledger WHERE order_id = ?1 AND instr(idempotency_key, ':' || ?2 || ':') > 0
                  ORDER BY created_at DESC, rowid DESC LIMIT 1) AS latest`
      )
      .bind(req.orderId, req.orderItemId)
      .first<{ reserved: number; deducted: number; latest: string | null }>()
      .then((r) => ({ reserved: Number(r?.reserved) === 1, deducted: Number(r?.deducted) === 1, latest: r?.latest ?? null })),
    db
      .prepare(`SELECT ${ASSIGNMENT_COLS} FROM serial_assignments WHERE serial_norm = ? AND released_at IS NOT NULL ORDER BY released_at DESC LIMIT 1`)
      .bind(norm)
      .first<AssignmentRow>(),
    legacyAliases(db, norm),
  ]);
  return {
    order,
    line,
    slots,
    asset: asset ?? null,
    boxOwner,
    boxIsSerial,
    live,
    slotLive: slotLive ?? null,
    binding: binding ?? null,
    receipt: receipt ?? null,
    serialLot,
    lots,
    variant,
    ledger,
    lastReleased: lastReleased ?? null,
    legacy,
  };
}

interface LinkPlan {
  already: AssignmentRow | null;
  staffWindow: boolean;
  releaseOther: AssignmentRow | null;
  priorUnitId: string | null;
  mode: 'new' | 'carry' | 'restart';
  skipDeliveredFence: boolean;
  lotId: string | null;
  lotSource: 'serial_link' | 'allocation' | null;
  allocationId: string | null;
  lotFence: boolean;
  warnings: string[];
}

/**
 * A unit closed `order_cancelled` (an undone delivery, then a cancel) whose
 * order is DELIVERED again is a delivered device whatever its columns still
 * say: the re-delivery re-opens it (`reopenRedeliveredUnits`), and until that
 * step has run it must not read as a free device (integrity review #1).
 */
const REDELIVERED = (b: Pick<Binding, 'warranty_closed_reason' | 'order_status'> | null) =>
  !!b && b.warranty_closed_reason === 'order_cancelled' && b.order_status === 'delivered';
const OPEN_UNIT = (b: Binding | null) => !!b && !b.replaced_by_unit_id && (!b.warranty_closed_at || REDELIVERED(b));
/** The SQL twin of OPEN_UNIT for a unit `u` (device_serials → order_item_units). */
export const openUnitSql = (u: string) =>
  `(${u}.replaced_by_unit_id IS NULL AND (${u}.warranty_closed_at IS NULL OR (${u}.warranty_closed_reason = 'order_cancelled'
     AND EXISTS (SELECT 1 FROM orders ro WHERE ro.id = ${u}.order_id AND ro.status = 'delivered'))))`;
const UNSELLABLE = (b: Binding | null) =>
  !!b && (!!b.replaced_by_unit_id || b.warranty_closed_reason === 'returned_unsellable' || b.warranty_closed_reason === 'replaced');

/**
 * Every refusal, in the brief's order of importance, from what was read.
 * Run before the batch (for the message) and again after a failed batch (for
 * the honest reason) — one classifier, so the two can never disagree.
 */
async function classifyLink(db: D1Database, ctx: LinkContext, req: LinkRequest, actor: SerialActor, norm: string, ean: string, boxSn: string): Promise<LinkPlan> {
  const ov = req.override?.kind ?? null;
  const part = req.part ?? 'device';
  const partIndex = req.partIndex ?? 1;
  const order = ctx.order;
  if (!order) throw refuse(404, 'ORDER_NOT_FOUND');
  const line = ctx.line;
  if (!line) throw refuse(404, 'ITEM_NOT_IN_ORDER');
  // Phase 1: one serial per unit, the box Product SN (owner default — a Combo
  // gets ONE serial). The AMS part is in the schema for later.
  if (part !== 'device' || partIndex !== 1) throw refuse(409, 'SERIAL_NOT_REQUIRED', { part });
  const slot = ctx.slots.find((s) => s.order_item_id === line.id && s.unit_index === req.unitIndex);
  if (!slot) throw refuse(409, 'SERIAL_NOT_REQUIRED');

  // The same serial already on this very slot: a replay, a double tap, the
  // second device of one account — the answer is the link that exists.
  // (A «change» to the serial the slot already holds is the same answer.)
  const sameSlot = ctx.slotLive && ctx.slotLive.serial_norm === norm ? ctx.slotLive : null;
  if (sameSlot) return { already: sameSlot } as LinkPlan;

  // ---- the window (S1) --------------------------------------------------
  const inWindow = serialScanWindow(order.shipping_type, order.stage, order.status);
  if (order.seller_type === 'merchant') throw refuse(409, 'ORDER_NOT_PREPARABLE', { stage: order.stage, status: order.status });
  if (ov === 'outside_window') {
    if (order.status === 'cancelled' || order.status === 'delivered') {
      throw refuse(409, 'ORDER_NOT_PREPARABLE', { stage: order.stage, status: order.status });
    }
  } else {
    if (!inWindow) throw refuse(409, 'ORDER_NOT_PREPARABLE', { stage: order.stage, status: order.status });
    // H2: once a courier shipment exists the parcel is out of staff hands.
    if (order.delivery_remote_id && !actor.owner) {
      throw refuse(409, 'ORDER_NOT_PREPARABLE', { stage: order.stage, status: order.status, reason: 'shipment' });
    }
    // M1: the FIFO lot is chosen at the deduct; scanning before it would choose.
    if (ctx.ledger.reserved && !ctx.ledger.deducted) {
      throw refuse(409, 'ORDER_NOT_PREPARABLE', { stage: order.stage, status: order.status, reason: 'stock_not_deducted' });
    }
  }

  // ---- the asset (S4) ----------------------------------------------------
  const asset = ctx.asset;
  if (asset?.voided_at) throw refuse(409, 'SERIAL_NOT_AVAILABLE', { reason: 'void' });
  if (asset?.product_id && asset.product_id !== line.product_id) throw refuse(400, 'SERIAL_PRODUCT_MISMATCH');
  if (asset?.variant_id && ctx.variant && asset.variant_id !== ctx.variant.variant_id) throw refuse(400, 'SERIAL_OPTION_MISMATCH');
  // H1: a serial that is some other asset's BOX SN, or a box SN that is some
  // other asset's serial, is the same physical box read twice.
  if (ctx.boxOwner) throw refuse(400, 'SERIAL_INVALID', { problem: 'BOX_SN' });
  if (boxSn && ctx.boxIsSerial) throw refuse(400, 'SERIAL_INVALID', { problem: 'BOX_SN_IS_SERIAL' });
  if (ean) {
    const hit = await resolveLabelProduct(db, ean, '');
    if (hit && hit.product.id !== line.product_id) throw refuse(400, 'SERIAL_PRODUCT_MISMATCH', { via: 'ean' });
    if (hit && hit.variant_id && ctx.variant && hit.variant_id !== ctx.variant.variant_id) {
      throw refuse(400, 'SERIAL_OPTION_MISMATCH', { via: 'ean' });
    }
  }
  // M11/§17 serial model metadata: a known prefix family that the product's
  // name contradicts. Not for an asset the owner already filed under this
  // product — that filing IS the owner's answer.
  if (!(asset?.product_id && asset.product_id === line.product_id) && ov !== 'model_family') {
    const conflict = serialFamilyConflict(norm, [line.p_name, line.p_name_ar, line.name_snapshot]);
    if (conflict) throw refuse(400, 'SERIAL_MODEL_MISMATCH', { ...conflict });
  }

  // ---- other live bindings (§10, §11, §18) --------------------------------
  const pending = ctx.live.find((a) => !a.activated_at && a.id !== req.replaceAssignmentId) ?? null;
  let releaseOther: AssignmentRow | null = null;
  if (pending) {
    if (pending.order_id === order.id) {
      throw refuse(409, 'SERIAL_IN_USE_THIS_ORDER', { order_item_id: pending.order_item_id, unit_index: pending.unit_index });
    }
    if (ov === 'take_from_order') {
      // L13: never strand a parcel already with the courier. And only from an
      // order still on the shelf (integrity review #6): a delivered order whose
      // activation has not run yet, or one already out for delivery, holds a
      // device that left — that is `delivered_device`, once it has activated.
      if (pending.o_remote) throw refuse(409, 'OVERRIDE_UNAVAILABLE', { reason: 'other_order_shipped' });
      if (pending.o_status === 'delivered') throw refuse(409, 'OVERRIDE_UNAVAILABLE', { reason: 'other_order_delivered' });
      if (!serialScanWindow(pending.o_shipping ?? '', pending.o_stage ?? '', pending.o_status ?? '')) {
        throw refuse(409, 'OVERRIDE_UNAVAILABLE', { reason: 'other_order_outside_window' });
      }
      releaseOther = pending;
    } else {
      throw refuse(409, 'SERIAL_IN_USE', actor.owner ? { order_id: pending.order_id ?? pending.order_ref } : {});
    }
  }
  // The legacy serial→order-item link (stock_serial_links.order_item_id) on a
  // live order other than this one (critique-1 #7).
  const sl = ctx.serialLot;
  if (sl?.order_item_id && sl.order_item_id !== line.id && sl.linked_order_status && sl.linked_order_status !== 'cancelled' && ov !== 'take_from_order') {
    throw refuse(409, 'SERIAL_IN_USE', {});
  }

  // M7: the same device under an old-form key. Open → it is a delivered
  // device (staff refused; the owner's override cannot move a key it does not
  // hold — re-entering the unit's serial through the post-delivery door
  // rewrites it in today's form first). Closed → not sellable until then.
  const legacyOpen = ctx.legacy.find((l) => l.open) ?? null;
  if (legacyOpen) {
    if (ov === 'delivered_device') throw refuse(409, 'OVERRIDE_UNAVAILABLE', { reason: 'legacy_serial_form', legacy_serial: legacyOpen.serial_norm });
    throw refuse(409, 'SERIAL_DELIVERED', actor.owner ? { legacy_serial: legacyOpen.serial_norm } : {});
  }
  if (ctx.legacy.length) {
    throw refuse(409, 'SERIAL_NOT_AVAILABLE', { reason: 'legacy_serial_form', ...(actor.owner ? { legacy_serial: ctx.legacy[0].serial_norm } : {}) });
  }

  const b = ctx.binding;
  const active = ctx.live.find((a) => !!a.activated_at) ?? null;
  let priorUnitId: string | null = null;
  let mode: 'new' | 'carry' | 'restart' = 'new';
  let skipDeliveredFence = false;
  const warnings: string[] = [];
  const delivered = OPEN_UNIT(b) || !!active || !!ctx.receipt;
  if (UNSELLABLE(b)) {
    if (ov !== 'unavailable') throw refuse(409, 'SERIAL_NOT_AVAILABLE', { reason: b?.replaced_by_unit_id ? 'replaced' : 'unsellable' });
    priorUnitId = b!.unit_id;
    mode = req.override?.warrantyMode ?? 'carry';
    skipDeliveredFence = true;
  } else if (delivered) {
    if (ov !== 'delivered_device') {
      const end = b?.warranty_end_at ?? null;
      const live = end ? coverageState(b?.delivered_at ?? null, end).state === 'active' : false;
      const err = refuse(
        409,
        'SERIAL_DELIVERED',
        actor.owner ? { order_id: b?.order_id ?? active?.order_id ?? ctx.receipt?.order_id ?? null, warranty_end_at: end, active_warranty: live } : { active_warranty: live }
      );
      if (live) err.message = SERIAL_TEXT.SERIAL_DELIVERED_ACTIVE;
      throw err;
    }
    priorUnitId = b?.unit_id ?? active?.unit_id ?? ctx.receipt?.unit_id ?? null;
    mode = req.override?.warrantyMode ?? 'carry';
    skipDeliveredFence = true;
  } else if (b && (b.warranty_closed_reason === 'returned' || b.warranty_closed_reason === 'traded_in')) {
    // §14 resale of a returned device: the SAME warranty identity continues —
    // its original end carries (owner default). A purchased plan on the new
    // line does not restart it silently (M15): the owner decides.
    priorUnitId = b.unit_id;
    mode = 'carry';
    const snap = safeParse<{ plan_id?: string } | null>(line.warranty_snapshot, null);
    if (snap?.plan_id) warnings.push('RESTART_SUGGESTED');
  }
  if (req.override?.warrantyMode && (ov === 'delivered_device' || ov === 'unavailable')) mode = req.override.warrantyMode;

  // ---- the slot (§18) ----------------------------------------------------
  if (ctx.slotLive && ctx.slotLive.serial_norm !== norm && ctx.slotLive.id !== req.replaceAssignmentId) {
    throw refuse(409, 'UNIT_ALREADY_LINKED', { assignment_id: ctx.slotLive.id });
  }

  // ---- the lot (§26/§27, Phase 1) ----------------------------------------
  let lotId: string | null = null;
  let lotSource: LinkPlan['lotSource'] = null;
  let allocationId: string | null = null;
  let lotFence = false;
  // A change releases the slot's old row in the same batch, so that row does
  // not hold its lot here (integrity review #8: a fully allocated line was
  // refused SERIAL_BATCH_MISMATCH on every change).
  const replacing = req.replaceAssignmentId && ctx.slotLive?.id === req.replaceAssignmentId ? ctx.slotLive : null;
  const open = ctx.lots
    .filter((l) => l.net > 0)
    .map((l) => (replacing?.lot_id && replacing.lot_id === l.lot_id ? { ...l, taken: Math.max(0, l.taken - 1) } : l));
  const expected = open.map((l) => ({ id: l.lot_id, received_at: l.received_at, location: l.location }));
  if (sl) {
    if (sl.lot_product_id && sl.lot_product_id !== line.product_id) throw refuse(400, 'SERIAL_PRODUCT_MISMATCH', { via: 'lot' });
    const mine = open.find((l) => l.lot_id === sl.lot_id) ?? null;
    if (open.length && mine && mine.taken < mine.net) {
      lotId = sl.lot_id;
      lotSource = 'serial_link';
      allocationId = mine.allocation_id;
      lotFence = true;
    } else if (open.length) {
      // Another queue (option / colour / variant) is another product here.
      if (!open.some((l) => l.scope === sl.scope && l.scope_id === sl.scope_id)) throw refuse(400, 'SERIAL_OPTION_MISMATCH', { via: 'lot' });
      if (ov !== 'batch') throw refuse(400, 'SERIAL_BATCH_MISMATCH', { expected_lots: expected });
      // L11: the owner's Phase-1 batch exception RECORDS the mismatch (audited,
      // the serial's own lot kept as evidence); the allocation is not re-pinned.
      lotId = sl.lot_id;
      lotSource = 'serial_link';
      warnings.push('BATCH_OVERRIDDEN');
    } else {
      lotId = sl.lot_id;
      lotSource = 'serial_link';
      warnings.push('ALLOCATION_MISSING');
    }
  } else if (open.length) {
    const free = open.find((l) => l.taken < l.net) ?? null;
    if (free) {
      lotId = free.lot_id;
      lotSource = 'allocation';
      allocationId = free.allocation_id;
      lotFence = true;
    }
  } else if (ctx.ledger.reserved) {
    warnings.push('ALLOCATION_MISSING');
  }
  if (ctx.ledger.latest === 'restore' || ctx.ledger.latest === 'release') warnings.push('STOCK_NOT_RETAKEN');
  if (ctx.lastReleased?.release_note === 'from:shipped') warnings.push('CANCELLED_AFTER_DISPATCH');

  return {
    already: null,
    staffWindow: ov !== 'outside_window',
    releaseOther,
    priorUnitId,
    mode,
    skipDeliveredFence,
    lotId,
    lotSource,
    allocationId,
    lotFence,
    warnings,
  };
}

function rawAudit(db: D1Database, actorId: string | null, action: string, target: string, detail: Record<string, unknown>, when: string): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO audit_log (actor_id, action, target, detail) SELECT ?, ?, ?, ? WHERE ${when}`)
    .bind(actorId, action, target, JSON.stringify(detail).slice(0, 4000));
}

/**
 * M11 — a mistaken first scan filed a product-less asset under this line's
 * product. When that link is released and the asset has no other history (no
 * other assignment, never on a unit), the filing is undone and audited.
 */
function undoAdoptionStatements(db: D1Database, a: Pick<AssignmentRow, 'id' | 'serial_norm' | 'product_id' | 'adopted_product'>, actorId: string): D1PreparedStatement[] {
  if (Number(a.adopted_product) !== 1 || !a.product_id) return [];
  return [
    db
      .prepare(
        `UPDATE serial_inventory SET product_id = NULL, variant_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE serial_norm = ?1 AND product_id = ?2
            AND NOT EXISTS (SELECT 1 FROM serial_assignments x WHERE x.serial_norm = ?1 AND x.id <> ?3)
            AND NOT EXISTS (SELECT 1 FROM device_serials d WHERE d.serial_norm = ?1)`
      )
      .bind(a.serial_norm, a.product_id, a.id),
    rawAudit(db, actorId, 'serial_inventory.update', a.serial_norm, { source: 'prep_unlink', from: { product_id: a.product_id }, to: { product_id: null, variant_id: null }, assignment_id: a.id }, 'changes() = 1'),
  ];
}

export async function linkSerial(env: Env, actor: SerialActor, req: LinkRequest): Promise<LinkResult> {
  const db = env.DB;
  if (!(await serialAssignmentsInstalled(db))) throw refuse(503, 'SERIALS_NOT_INSTALLED');
  const opId = String(req.opId ?? '').trim();
  if (!/^[A-Za-z0-9_.:-]{8,80}$/.test(opId)) throw new HttpError(400, 'op_id is required (8–80 characters)', 'OP_ID_REQUIRED');
  const part = req.part ?? 'device';
  const partIndex = req.partIndex ?? 1;
  const key = `scan:${opId}`;

  // §23 + H1: the one canonicaliser, then the companions of the same read.
  const { norm, raw } = await canonicalSerial(db, req.code);
  const ean = normalizeEan(typeof req.ean === 'string' ? req.ean : '') || '';
  const boxSn = companionBox(req.boxSn);

  // Idempotency (§24): the same op_id is the same scan.
  const replay = await db.prepare(`SELECT ${ASSIGNMENT_COLS} FROM serial_assignments WHERE idempotency_key = ?`).bind(key).first<AssignmentRow>();
  if (replay) return replayAnswer(db, actor, replay, req, norm, part);

  const ctx = await readLinkContext(db, req, norm, boxSn);
  const plan = await classifyLink(db, ctx, req, actor, norm, ean, boxSn);
  if (plan.already) return answer(db, actor, plan.already, 'already', []);
  const order = ctx.order!;
  const line = ctx.line!;
  const lineVariant = ctx.variant?.variant_id ?? null;
  const now = nowIso();
  const id = newId('sa');
  const ov = req.override ?? null;
  const stmts: D1PreparedStatement[] = [];

  // S1 — the window, the line and the unit, re-asserted inside the batch.
  if (plan.staffWindow) {
    stmts.push(
      ...fence(
        db,
        `EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
                  WHERE o.id = ? AND oi.id = ? AND ? <= min(oi.qty, 500)
                    AND COALESCE(o.seller_type,'') <> 'merchant' AND ${scanWindowSql('o')}
                    ${actor.owner ? '' : "AND COALESCE(o.delivery_remote_id,'') = ''"}
                    AND ${deductEvidenceSql('o.id', 'oi.id')})`,
        [order.id, line.id, req.unitIndex]
      )
    );
  } else {
    stmts.push(
      ...fence(
        db,
        `EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
                  WHERE o.id = ? AND oi.id = ? AND ? <= min(oi.qty, 500)
                    AND COALESCE(o.seller_type,'') <> 'merchant' AND o.status NOT IN ('cancelled','delivered'))`,
        [order.id, line.id, req.unitIndex]
      )
    );
  }

  // Change (§20): the old binding goes in the same transaction — a failed new
  // link leaves the old one intact.
  let replaced: AssignmentRow | null = null;
  if (req.replaceAssignmentId) {
    replaced = ctx.slotLive && ctx.slotLive.id === req.replaceAssignmentId ? ctx.slotLive : null;
    if (!replaced) throw refuse(404, 'SERIAL_ASSIGNMENT_NOT_FOUND');
    if (replaced.activated_at) throw refuse(409, 'SERIAL_ALREADY_ACTIVATED');
    stmts.push(
      db
        .prepare(
          `UPDATE serial_assignments SET released_at = ?, released_by = ?, release_reason = 'changed', release_note = ?
            WHERE id = ? AND order_id = ? AND released_at IS NULL AND activated_at IS NULL`
        )
        .bind(now, actor.id, `to:${norm}`.slice(0, 500), replaced.id, order.id),
      ...changedExactlyOne(db)
    );
    stmts.push(
      ...(
        await auditStatements(db, actor.id, 'serial.released', replaced.serial_norm, {
          assignment_id: replaced.id, order_id: order.id, order_item_id: replaced.order_item_id, unit_index: replaced.unit_index,
          part: replaced.part, reason: 'changed', new_serial: norm,
        })
      ).statements,
      ...undoAdoptionStatements(db, replaced, actor.id)
    );
  }
  // Owner take_from_order (§10 exception): the other order's slot empties.
  if (plan.releaseOther) {
    stmts.push(
      db
        .prepare(
          `UPDATE serial_assignments SET released_at = ?, released_by = ?, release_reason = 'owner_override', release_note = ?
            WHERE id = ? AND released_at IS NULL AND activated_at IS NULL
              AND EXISTS (SELECT 1 FROM orders o WHERE o.id = serial_assignments.order_id AND ${scanWindowSql('o')}
                            AND COALESCE(o.delivery_remote_id,'') = '')`
        )
        .bind(now, actor.id, (ov?.reason ?? '').slice(0, 500), plan.releaseOther.id),
      ...changedExactlyOne(db),
      ...(
        await auditStatements(db, actor.id, 'serial.released', plan.releaseOther.serial_norm, {
          assignment_id: plan.releaseOther.id, order_id: plan.releaseOther.order_id, order_item_id: plan.releaseOther.order_item_id,
          unit_index: plan.releaseOther.unit_index, part: plan.releaseOther.part, reason: 'owner_override', to_order_id: order.id,
        })
      ).statements
    );
  }

  // S2/S3 — find or create the asset ONCE (§5, §7). No order id on the asset (§6).
  const assetIndex = stmts.length;
  stmts.push(
    db
      .prepare(
        `INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, variant_id, box_sn, ean, source, created_by, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '') ON CONFLICT(serial_norm) DO NOTHING`
      )
      .bind(norm, raw, line.product_id, lineVariant, boxSn, ean, req.source === 'manual' ? 'manual' : 'scan', actor.id),
    rawAudit(db, actor.id, 'serial_inventory.add', norm, { source: 'prep_scan', via: req.source, product_id: line.product_id, variant_id: lineVariant, order_id: order.id, serials: [norm], op: key }, 'changes() = 1')
  );
  // S4 — the asset is usable and is this product / option, and is not another box's SN.
  stmts.push(
    ...fence(
      db,
      `EXISTS (SELECT 1 FROM serial_inventory si WHERE si.serial_norm = ? AND si.voided_at IS NULL
                  AND (si.product_id IS NULL OR si.product_id = ?)
                  AND (si.variant_id IS NULL OR ? IS NULL OR si.variant_id = ?))
        AND NOT EXISTS (SELECT 1 FROM serial_inventory b WHERE b.box_sn = ? AND b.box_sn <> '' AND b.serial_norm <> ?)`,
      [norm, line.product_id, lineVariant, lineVariant, norm, norm]
    )
  );
  // S5 — not a delivered device under any open warranty (legacy devices with
  // no assignment row included), nor one that may not be sold.
  if (!plan.skipDeliveredFence) {
    stmts.push(
      ...fence(
        db,
        `NOT EXISTS (SELECT 1 FROM device_serials d JOIN order_item_units u ON u.id = d.unit_id
                      WHERE d.serial_norm = ? AND (${openUnitSql('u')} OR u.replaced_by_unit_id IS NOT NULL
                                                   OR u.warranty_closed_reason IN ('returned_unsellable','replaced')))
          AND NOT EXISTS (SELECT 1 FROM warranty_receipts w WHERE w.serial_norm = ? AND w.status IN ('draft','active'))
          AND NOT EXISTS (SELECT 1 FROM serial_assignments x WHERE x.serial_norm = ? AND x.released_at IS NULL AND x.activated_at IS NOT NULL)`,
        [norm, norm, norm]
      )
    );
  } else if (plan.priorUnitId) {
    // The override names the device's warranty unit it read; it must still be that one.
    stmts.push(...fence(db, `EXISTS (SELECT 1 FROM device_serials d WHERE d.serial_norm = ? AND d.unit_id = ?)
                              OR NOT EXISTS (SELECT 1 FROM device_serials d WHERE d.serial_norm = ?)`, [norm, plan.priorUnitId, norm]));
  }
  // S6/S7 — an asset filed under no product adopts the line's (audited), and
  // one filed under the product with no option adopts the line's option. Two
  // statements, so the batch itself records whether THIS link filed the
  // product (critique L13: the pre-read cannot know — another door may file
  // it between the read and this batch).
  stmts.push(
    db
      .prepare(
        `UPDATE serial_inventory SET product_id = ?1, variant_id = COALESCE(variant_id, ?2),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE serial_norm = ?3 AND product_id IS NULL`
      )
      .bind(line.product_id, lineVariant, norm),
    rawAudit(db, actor.id, 'serial_inventory.update', norm, { source: 'prep_scan', to: { product_id: line.product_id, variant_id: lineVariant }, order_id: order.id, adopted: 'product', op: key }, 'changes() = 1'),
    db
      .prepare(
        `UPDATE serial_inventory SET variant_id = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE serial_norm = ?3 AND product_id = ?1 AND variant_id IS NULL AND ?2 IS NOT NULL`
      )
      .bind(line.product_id, lineVariant, norm),
    rawAudit(db, actor.id, 'serial_inventory.update', norm, { source: 'prep_scan', to: { variant_id: lineVariant }, order_id: order.id, adopted: 'variant', op: key }, 'changes() = 1')
  );
  // S8 — the lot still owes this line a unit (taken < net), so two serials can
  // never claim one allocated unit (Audit C2's capacity gap).
  if (plan.lotFence && plan.lotId) {
    stmts.push(
      ...fence(
        db,
        `(SELECT COUNT(*) FROM serial_assignments WHERE order_item_id = ? AND lot_id = ? AND released_at IS NULL)
          < (SELECT COALESCE(SUM(CASE WHEN released_at IS NULL THEN qty ELSE -qty END), 0)
               FROM order_item_inventory_allocations WHERE order_item_id = ? AND lot_id = ?)`,
        [line.id, plan.lotId, line.id, plan.lotId]
      )
    );
  }
  // S9 — the assignment. The partial UNIQUE indexes and the idempotency key decide races.
  stmts.push(
    db
      .prepare(
        `INSERT INTO serial_assignments (id, serial_norm, serial_raw, order_id, order_item_id, order_ref, unit_index, part, part_index,
            product_id, variant_id, lot_id, lot_source, allocation_id, source, warranty_mode, prior_unit_id,
            override_kind, override_reason, adopted_product, idempotency_key, linked_by, linked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19,
                 EXISTS (SELECT 1 FROM audit_log l
                          WHERE l.target = ?2 AND l.action IN ('serial_inventory.add','serial_inventory.update')
                            AND (CASE WHEN json_valid(l.detail) THEN json_extract(l.detail, '$.op') END) = ?20
                            AND (l.action = 'serial_inventory.add'
                                 OR (CASE WHEN json_valid(l.detail) THEN json_extract(l.detail, '$.adopted') END) = 'product')),
                 ?20, ?21, ?22)`
      )
      .bind(
        id, norm, raw, order.id, line.id, order.id, req.unitIndex, part, partIndex,
        line.product_id, lineVariant, plan.lotId, plan.lotSource, plan.allocationId,
        ov ? 'owner_override' : req.source, plan.mode, plan.priorUnitId,
        ov?.kind ?? null, ov ? ov.reason : null, key, actor.id, now
      )
  );
  // S10 — §25: who, what, which unit, previous and new assignment, why.
  const previous = ctx.lastReleased;
  stmts.push(
    ...(
      await auditStatements(db, actor.id, 'serial.linked', norm, {
        assignment_id: id, order_id: order.id, order_item_id: line.id, unit_index: req.unitIndex, part,
        source: req.source, lot_id: plan.lotId, lot_source: plan.lotSource, warranty_mode: plan.mode,
        prior_unit_id: plan.priorUnitId, previous_assignment: previous?.id ?? null,
        previous_order_id: previous?.order_ref ?? null, replaces_assignment: replaced?.id ?? null,
        override_kind: ov?.kind ?? null,
      })
    ).statements
  );
  if (ov) {
    stmts.push(
      ...(
        await auditStatements(db, actor.id, 'serial.override', norm, {
          kind: ov.kind, reason: ov.reason, new_assignment: id, previous_assignment: plan.releaseOther?.id ?? previous?.id ?? null,
          other_order_id: plan.releaseOther?.order_id ?? null, prior_unit_id: plan.priorUnitId, warranty_mode: plan.mode,
          order_id: order.id, order_item_id: line.id, unit_index: req.unitIndex,
        })
      ).statements
    );
  }

  let results: D1Result[];
  try {
    results = await db.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/serial_assignments\.idempotency_key/.test(msg)) {
      const again = await db.prepare(`SELECT ${ASSIGNMENT_COLS} FROM serial_assignments WHERE idempotency_key = ?`).bind(key).first<AssignmentRow>();
      if (again) return replayAnswer(db, actor, again, req, norm, part);
    }
    if (!isLostRace(e) && !/UNIQUE constraint failed|CHECK constraint failed/.test(msg)) throw e;
    // Re-read and classify: the honest reason, or the same link already made.
    const fresh = await readLinkContext(db, req, norm, boxSn);
    const second = await classifyLink(db, fresh, req, actor, norm, ean, boxSn);
    if (second.already) return answer(db, actor, second.already, 'already', []);
    throw refuse(409, 'SERIAL_RACE');
  }
  const created = Number(results[assetIndex]?.meta?.changes ?? 0) === 1;
  const row = await db.prepare(`SELECT ${ASSIGNMENT_COLS} FROM serial_assignments WHERE id = ?`).bind(id).first<AssignmentRow>();
  return answer(db, actor, row!, created ? 'created' : 'existing', plan.warnings);
}

async function replayAnswer(db: D1Database, actor: SerialActor, row: AssignmentRow, req: LinkRequest, norm: string, part: string): Promise<LinkResult> {
  const same = row.serial_norm === norm && row.order_item_id === req.orderItemId && row.unit_index === req.unitIndex && row.part === part;
  if (!same) throw refuse(409, 'IDEMPOTENCY_MISMATCH');
  // M10: a replay never reports a link that no longer exists.
  if (row.released_at) throw refuse(409, 'SERIAL_LINK_RELEASED', { release_reason: row.release_reason });
  return answer(db, actor, row, 'already', []);
}

async function answer(db: D1Database, actor: SerialActor, row: AssignmentRow, outcome: LinkResult['outcome'], warnings: string[]): Promise<LinkResult> {
  const slot = await slotView(db, actor, row);
  return {
    success: true,
    outcome,
    code: outcome === 'existing' ? 'SERIAL_EXISTING_LINKED' : 'SERIAL_LINKED',
    message: outcome === 'existing' ? SERIAL_TEXT.SERIAL_EXISTING_LINKED : SERIAL_TEXT.SERIAL_LINKED,
    assignment_id: row.id,
    slot,
    warnings,
  };
}

/** One slot's public shape. No cost, ever; the serial full or masked by scope. */
export async function slotView(db: D1Database, actor: SerialActor, row: AssignmentRow | null, at?: { order_item_id: string; unit_index: number; part: string }): Promise<SlotView> {
  const base = { order_item_id: row?.order_item_id ?? at?.order_item_id ?? '', unit_index: row?.unit_index ?? at?.unit_index ?? 0, part: row?.part ?? at?.part ?? 'device' };
  if (!row || row.released_at) return { ...base, assignment: null };
  const [lot, unit, prior] = await Promise.all([
    row.lot_id
      ? tryFirst(() =>
          db
            .prepare(
              `SELECT l.id, l.received_at, (SELECT sl.name FROM inventory_lot_locations ll JOIN stock_locations sl ON sl.id = ll.location_id WHERE ll.lot_id = l.id) AS location
                 FROM inventory_lots l WHERE l.id = ?`
            )
            .bind(row.lot_id)
            .first<{ id: string; received_at: string | null; location: string | null }>()
        )
      : Promise.resolve(null),
    row.unit_id
      ? db.prepare('SELECT delivered_at, warranty_end_at, warranty_closed_at, warranty_closed_reason FROM order_item_units WHERE id = ?').bind(row.unit_id).first<{ delivered_at: string | null; warranty_end_at: string | null; warranty_closed_at: string | null; warranty_closed_reason: string | null }>()
      : Promise.resolve(null),
    row.prior_unit_id && row.warranty_mode === 'carry'
      ? db.prepare('SELECT warranty_end_at FROM order_item_units WHERE id = ?').bind(row.prior_unit_id).first<{ warranty_end_at: string | null }>()
      : Promise.resolve(null),
  ]);
  let state: NonNullable<SlotView['assignment']>['warranty']['state'] = 'PENDING_DELIVERY';
  if (unit) {
    if (unit.warranty_closed_at) state = unit.warranty_closed_reason === 'returned' || unit.warranty_closed_reason === 'returned_unsellable' ? 'RETURNED' : 'CLOSED';
    else {
      const cov = coverageState(unit.delivered_at, unit.warranty_end_at).state;
      state = cov === 'active' ? 'ACTIVE' : cov === 'expired' ? 'EXPIRED' : 'NEEDS_CONFIG';
    }
  }
  return {
    ...base,
    assignment: {
      id: row.id,
      serial_display: shown(row.serial_raw, actor),
      ...(actor.fullSerial ? { serial_full: row.serial_raw } : {}),
      linked_at: row.linked_at,
      linked_by: row.linked_by,
      source: row.source,
      lot: lot ? { id: lot.id, received_at: lot.received_at ?? null, location: lot.location ?? null } : null,
      lot_source: row.lot_source,
      warranty: { state, mode: row.warranty_mode, carries_until: prior?.warranty_end_at ?? null },
      override_kind: row.override_kind,
    },
  };
}

// ======================================================================
//  UNLINK (§20) — before delivery; the asset is never deleted.
// ======================================================================

export async function unlinkSerial(
  env: Env,
  actor: SerialActor,
  req: { orderId: string; assignmentId: string; reason?: string }
): Promise<{ success: true; already?: true; code: 'SERIAL_UNLINKED'; message: string; slot: SlotView }> {
  const db = env.DB;
  if (!(await serialAssignmentsInstalled(db))) throw refuse(503, 'SERIALS_NOT_INSTALLED');
  const row = await db
    .prepare(`SELECT ${ASSIGNMENT_COLS} FROM serial_assignments WHERE id = ? AND order_id = ?`)
    .bind(req.assignmentId, req.orderId)
    .first<AssignmentRow>();
  if (!row) throw refuse(404, 'SERIAL_ASSIGNMENT_NOT_FOUND');
  const at = { order_item_id: row.order_item_id ?? '', unit_index: row.unit_index, part: row.part };
  // Unlinks target the assignment id, never the slot: a replay cannot release a newer link.
  if (row.released_at) return { success: true, already: true, code: 'SERIAL_UNLINKED', message: SERIAL_TEXT.SERIAL_UNLINKED, slot: await slotView(db, actor, null, at) };
  if (row.activated_at) throw refuse(409, 'SERIAL_ALREADY_ACTIVATED');
  const order = await readOrderFacts(db, req.orderId);
  if (!order) throw refuse(404, 'ORDER_NOT_FOUND');
  const reason = String(req.reason ?? '').trim().slice(0, 500);
  const inWindow = serialScanWindow(order.shipping_type, order.stage, order.status) && !order.delivery_remote_id;
  if (!inWindow) {
    // Outside the window (shipped, a courier shipment exists): the owner only, with a reason.
    if (!actor.owner) throw refuse(409, 'ORDER_NOT_PREPARABLE', { stage: order.stage, status: order.status, ...(order.delivery_remote_id ? { reason: 'shipment' } : {}) });
    if (reason.length < 5) throw refuse(400, 'OVERRIDE_REASON_REQUIRED');
  }
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  if (inWindow) {
    stmts.push(...fence(db, `EXISTS (SELECT 1 FROM orders o WHERE o.id = ? AND ${scanWindowSql('o')} AND COALESCE(o.delivery_remote_id,'') = '')`, [order.id]));
  }
  stmts.push(
    db
      .prepare(
        `UPDATE serial_assignments SET released_at = ?, released_by = ?, release_reason = 'unlinked', release_note = ?
          WHERE id = ? AND order_id = ? AND released_at IS NULL AND activated_at IS NULL`
      )
      .bind(now, actor.id, reason, row.id, order.id),
    ...changedExactlyOne(db),
    ...(
      await auditStatements(db, actor.id, 'serial.unlinked', row.serial_norm, {
        assignment_id: row.id, previous_assignment: row.id, order_id: order.id, order_item_id: row.order_item_id,
        unit_index: row.unit_index, part: row.part, reason, outside_window: !inWindow,
      })
    ).statements,
    ...undoAdoptionStatements(db, row, actor.id)
  );
  try {
    await db.batch(stmts);
  } catch (e) {
    if (!isLostRace(e)) throw e;
    const again = await db.prepare('SELECT released_at, activated_at FROM serial_assignments WHERE id = ?').bind(row.id).first<{ released_at: string | null; activated_at: string | null }>();
    if (again?.released_at) return { success: true, already: true, code: 'SERIAL_UNLINKED', message: SERIAL_TEXT.SERIAL_UNLINKED, slot: await slotView(db, actor, null, at) };
    if (again?.activated_at) throw refuse(409, 'SERIAL_ALREADY_ACTIVATED');
    throw refuse(409, 'ORDER_NOT_PREPARABLE');
  }
  return { success: true, code: 'SERIAL_UNLINKED', message: SERIAL_TEXT.SERIAL_UNLINKED, slot: await slotView(db, actor, null, at) };
}

/** Owner: how a resold device's warranty starts at delivery (carry = original end, restart = new). */
export async function setWarrantyMode(env: Env, actor: SerialActor, norm: string, mode: 'carry' | 'restart', reason: string) {
  const db = env.DB;
  if (!(await serialAssignmentsInstalled(db))) throw refuse(503, 'SERIALS_NOT_INSTALLED');
  if (!actor.owner) throw refuse(403, 'OWNER_ONLY');
  if (reason.trim().length < 5) throw refuse(400, 'OVERRIDE_REASON_REQUIRED');
  const row = await db
    .prepare(`SELECT ${ASSIGNMENT_COLS} FROM serial_assignments WHERE serial_norm = ? AND released_at IS NULL AND activated_at IS NULL`)
    .bind(norm)
    .first<AssignmentRow>();
  if (!row) throw refuse(404, 'SERIAL_ASSIGNMENT_NOT_FOUND');
  if (!row.prior_unit_id) throw refuse(409, 'OVERRIDE_UNAVAILABLE', { reason: 'not_a_resale' });
  await db.batch([
    db.prepare('UPDATE serial_assignments SET warranty_mode = ? WHERE id = ? AND released_at IS NULL AND activated_at IS NULL').bind(mode, row.id),
    ...changedExactlyOne(db),
    ...(await auditStatements(db, actor.id, 'serial.warranty_mode', norm, { assignment_id: row.id, from: row.warranty_mode, to: mode, reason: reason.trim().slice(0, 500), order_id: row.order_id })).statements,
  ]);
  return { success: true as const, assignment_id: row.id, mode };
}

// ======================================================================
//  ACTIVATION AT DELIVERY (§8, §28) — after the unit batch, never in it.
// ======================================================================

export interface ActivationResult {
  pending: number;
  activated: number;
  released_policy: number;
  conflicts: number;
  /** Units an undone-delivery cancel closed that this re-delivery re-opened without a new scan. */
  reopened: number;
}

/** A SQL string literal (ids built by this file; quotes doubled all the same). */
const lit = (v: string) => `'${String(v).replace(/'/g, "''")}'`;

/**
 * RE-OPEN A UNIT AN UNDONE-DELIVERY CANCEL CLOSED (integrity review #1,
 * regressions review #1/#2). The cancel trigger closed it `order_cancelled`
 * (dates kept), voided its live receipt and revoked its account link; the
 * re-delivery hands the customer a device again, so each of those comes back:
 *   - the account link the cancel revoked (revoked at or after the closure —
 *     a release the holder made earlier stays released). Left revoked, it
 *     would read as «released by its holder» and anyone typing the serial
 *     could take the device (devices.ts /register);
 *   - the receipt the cancel voided — only for the SAME device (`serialNorm`)
 *     and only while neither the unit nor the serial has another live one;
 *   - `serial.warranty_reopened` history, then the unit itself.
 * `when` is an SQL condition every statement carries.
 */
function reopenUnitStatements(db: D1Database, unitId: string, serialNorm: string | null, when: string, detail: Record<string, unknown>): D1PreparedStatement[] {
  const closedAt = `(SELECT cu.warranty_closed_at FROM order_item_units cu WHERE cu.id = ?1 AND cu.warranty_closed_reason = 'order_cancelled')`;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(`UPDATE device_registrations SET revoked_at = NULL WHERE unit_id = ?1 AND revoked_at IS NOT NULL AND revoked_at >= ${closedAt} AND ${when}`)
      .bind(unitId),
  ];
  if (serialNorm) {
    stmts.push(
      db
        .prepare(
          `UPDATE warranty_receipts
              SET status = CASE WHEN issued_at IS NOT NULL THEN 'active' ELSE 'draft' END, void_reason = '', voided_at = NULL,
                  voided_by = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = (SELECT w.id FROM warranty_receipts w
                         WHERE w.unit_id = ?1 AND w.serial_norm = ?2 AND w.status = 'void' AND w.void_reason = 'order_cancelled'
                           AND w.voided_at >= ${closedAt}
                         ORDER BY w.voided_at DESC LIMIT 1)
              AND NOT EXISTS (SELECT 1 FROM warranty_receipts x WHERE x.unit_id = ?1 AND x.status IN ('draft','active'))
              AND NOT EXISTS (SELECT 1 FROM warranty_receipts x WHERE x.serial_norm = ?2 AND x.status IN ('draft','active'))
              AND ${when}`
        )
        .bind(unitId, serialNorm)
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO audit_log (actor_id, action, target, detail)
         SELECT NULL, 'serial.warranty_reopened', ?2, ?3
          WHERE EXISTS (SELECT 1 FROM order_item_units WHERE id = ?1 AND warranty_closed_reason = 'order_cancelled') AND ${when}`
      )
      .bind(unitId, serialNorm ?? unitId, JSON.stringify({ unit_id: unitId, ...detail }).slice(0, 4000)),
    db
      .prepare(`UPDATE order_item_units SET warranty_closed_at = NULL, warranty_closed_reason = NULL WHERE id = ?1 AND warranty_closed_reason = 'order_cancelled' AND ${when}`)
      .bind(unitId)
  );
  return stmts;
}

/**
 * Binds each live, not-yet-activated assignment of a delivered order to the
 * warranty unit delivery created for its slot. One batch PER ASSIGNMENT
 * (critique H3 — one bad row never blocks the others or the units), each
 * statement conditioned so a replay writes nothing twice, and the batch
 * fenced so it commits whole or not at all (integrity review #11):
 *   A0  a unit re-delivered after an undone delivery + cancel loses the OLD
 *       serial it was given before (that serial was released by the
 *       trigger), audited;
 *   A3  device_serials → this unit (moves only off a CLOSED or replaced unit,
 *       or the unit an owner override named — never off an open warranty,
 *       and never off a cancel-closed unit whose order is delivered again);
 *   R   the device's previous ACTIVE assignment is released (owner_override /
 *       reassigned) once the pointer really moved;
 *   A6  activated — only if device_serials really points at this unit; the
 *       fence after it rolls A0–R back otherwise;
 *   A1  carry: the original end, `carried:'original_end'` + `resale_of`
 *       (critique H4: the three readers of that marker keep it on a later
 *       delivery-date correction);
 *   A4  an owner override closes the superseded unit (dates kept), voids its
 *       live receipt and revokes its account link;
 *   AR  a unit closed by an undone-delivery cancel re-opens — its account
 *       link and (same device) its receipt with it (`reopenUnitStatements`);
 *   A5  the serial-verified lot onto order_item_units.inventory_lot_id (L12);
 *   A2  `serial.warranty_activated` history.
 * A slot that got no unit because its line is no longer serialized releases
 * its assignment (`policy_changed`, M5). A row that does not activate counts
 * an attempt; the sweep stops after five (a conflict is the owner's). Then
 * every unit an undone-delivery cancel closed that has NO new serial is
 * re-opened too (`reopenRedeliveredUnits`) — the gate ships off, so a
 * re-delivery without a re-scan is the common case.
 */
export async function activateOrderSerials(env: Env, orderId: string): Promise<ActivationResult> {
  const db = env.DB;
  const out: ActivationResult = { pending: 0, activated: 0, released_policy: 0, conflicts: 0, reopened: 0 };
  if (!(await serialAssignmentsInstalled(db))) return out;
  const order = await db.prepare("SELECT id, status, delivered_at FROM orders WHERE id = ?").bind(orderId).first<{ id: string; status: string; delivered_at: string | null }>();
  if (!order || !order.delivered_at) return out;
  const { results: rows } = await db
    .prepare(`SELECT ${ASSIGNMENT_COLS} FROM serial_assignments WHERE order_id = ? AND released_at IS NULL AND activated_at IS NULL AND part = 'device'`)
    .bind(orderId)
    .all<AssignmentRow>();
  out.pending = rows.length;
  const { slots } = rows.length ? await serialRequiredSlots(db, orderId) : { slots: [] as SerialSlot[] };
  for (const a of rows) {
    const unit = await db
      .prepare('SELECT id FROM order_item_units WHERE order_item_id = ? AND unit_index = ?')
      .bind(a.order_item_id, a.unit_index)
      .first<{ id: string }>();
    if (!unit) {
      const stillRequired = slots.some((s) => s.order_item_id === a.order_item_id && s.unit_index === a.unit_index);
      if (!stillRequired) {
        await db.batch([
          db
            .prepare(`UPDATE serial_assignments SET released_at = ?, release_reason = 'policy_changed', release_note = 'no unit at delivery'
                       WHERE id = ? AND released_at IS NULL AND activated_at IS NULL`)
            .bind(nowIso(), a.id),
          rawAudit(db, null, 'serial.released', a.serial_norm, { assignment_id: a.id, order_id: orderId, order_item_id: a.order_item_id, unit_index: a.unit_index, reason: 'policy_changed' }, 'changes() = 1'),
        ]);
        out.released_policy++;
      } else {
        await bumpAttempt(db, a.id);
        out.conflicts++;
      }
      continue;
    }
    const ok = await activateOne(db, a, unit.id, orderId);
    if (ok) out.activated++;
    else {
      await bumpAttempt(db, a.id);
      out.conflicts++;
    }
  }
  if (order.status === 'delivered') out.reopened = await reopenRedeliveredUnits(db, orderId);
  return out;
}

async function bumpAttempt(db: D1Database, id: string) {
  await db.prepare('UPDATE serial_assignments SET activation_attempts = activation_attempts + 1 WHERE id = ? AND activated_at IS NULL').bind(id).run().catch(() => undefined);
}

async function activateOne(db: D1Database, a: AssignmentRow, unitId: string, orderId: string): Promise<boolean> {
  const now = nowIso();
  const prior = a.prior_unit_id
    ? await db.prepare('SELECT * FROM order_item_units WHERE id = ?').bind(a.prior_unit_id).first<UnitRow & { warranty_end_at: string | null }>()
    : null;
  const ACT = `EXISTS (SELECT 1 FROM serial_assignments WHERE id = ${lit(a.id)} AND activated_at = ${lit(now)} AND unit_id = ${lit(unitId)})`;
  const overrideMove = a.override_kind === 'delivered_device' || a.override_kind === 'unavailable';
  const stmts: D1PreparedStatement[] = [
    // A0 — audited before it goes (the old serial is a free device again).
    db
      .prepare(
        `INSERT INTO audit_log (actor_id, action, target, detail)
         SELECT NULL, 'serial.detached', d.serial_norm,
                json_object('unit_id', ?1, 'order_id', ?4, 'reason', 'redelivered_with_another_serial', 'assignment_id', ?3)
           FROM device_serials d WHERE d.unit_id = ?1 AND d.serial_norm <> ?2
            AND EXISTS (SELECT 1 FROM order_item_units WHERE id = ?1 AND warranty_closed_reason = 'order_cancelled')
            AND EXISTS (SELECT 1 FROM serial_assignments WHERE id = ?3 AND released_at IS NULL AND activated_at IS NULL)`
      )
      .bind(unitId, a.serial_norm, a.id, orderId),
    db
      .prepare(
        `DELETE FROM device_serials WHERE unit_id = ?1 AND serial_norm <> ?2
            AND EXISTS (SELECT 1 FROM order_item_units WHERE id = ?1 AND warranty_closed_reason = 'order_cancelled')
            AND EXISTS (SELECT 1 FROM serial_assignments WHERE id = ?3 AND released_at IS NULL AND activated_at IS NULL)`
      )
      .bind(unitId, a.serial_norm, a.id),
    // A3
    db
      .prepare(
        `INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by, note)
         SELECT ?1, ?2, ?3, ?4, ?5
          WHERE EXISTS (SELECT 1 FROM serial_assignments WHERE id = ?6 AND released_at IS NULL AND activated_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM device_serials d WHERE d.unit_id = ?3)
         ON CONFLICT(serial_norm) DO UPDATE SET unit_id = excluded.unit_id, serial_raw = excluded.serial_raw,
            assigned_by = excluded.assigned_by, assigned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), note = excluded.note
          WHERE device_serials.unit_id IN (SELECT mu.id FROM order_item_units mu WHERE NOT ${openUnitSql('mu')})
             OR (?7 = 1 AND device_serials.unit_id = ?8)`
      )
      .bind(a.serial_norm, a.serial_raw, unitId, a.linked_by, `prep_scan:${a.id}`, a.id, overrideMove ? 1 : 0, a.prior_unit_id ?? ''),
    // R
    db
      .prepare(
        `UPDATE serial_assignments SET released_at = ?1, release_reason = ?2, release_note = ?3
          WHERE serial_norm = ?4 AND released_at IS NULL AND activated_at IS NOT NULL AND id <> ?5
            AND EXISTS (SELECT 1 FROM device_serials d WHERE d.serial_norm = ?4 AND d.unit_id = ?6)
            AND EXISTS (SELECT 1 FROM serial_assignments s WHERE s.id = ?5 AND s.released_at IS NULL AND s.activated_at IS NULL)`
      )
      .bind(now, a.override_kind ? 'owner_override' : 'reassigned', `to:${a.id}`, a.serial_norm, a.id, unitId),
    // A6
    db
      .prepare(
        `UPDATE serial_assignments SET activated_at = ?1, unit_id = ?2
          WHERE id = ?3 AND released_at IS NULL AND activated_at IS NULL
            AND EXISTS (SELECT 1 FROM device_serials d WHERE d.serial_norm = ?4 AND d.unit_id = ?2)`
      )
      .bind(now, unitId, a.id, a.serial_norm),
    // All or nothing: a row that did not activate leaves no trace of A0–R.
    ...fence(db, ACT),
  ];
  // A1 carry
  if (a.warranty_mode === 'carry' && prior) {
    const pv = JSON.stringify({
      v: 1,
      carried: 'original_end',
      resale_of: prior.id,
      base: prior.warranty_base_months,
      ext: prior.warranty_ext_months,
      total: unitTotalMonths(prior),
    });
    stmts.push(db.prepare(`UPDATE order_item_units SET warranty_end_at = ?, policy_version = ? WHERE id = ? AND ${ACT}`).bind(prior.warranty_end_at ?? null, pv, unitId));
  }
  // A4 the superseded unit of an owner override
  if (overrideMove && a.prior_unit_id && a.prior_unit_id !== unitId) {
    stmts.push(
      db.prepare(`UPDATE order_item_units SET warranty_closed_at = ?, warranty_closed_reason = 'owner_override' WHERE id = ? AND warranty_closed_at IS NULL AND ${ACT}`).bind(now, a.prior_unit_id),
      db.prepare(`UPDATE warranty_receipts SET status = 'void', void_reason = 'owner_override', voided_at = ?1, updated_at = ?1 WHERE unit_id = ?2 AND status IN ('draft','active') AND ${ACT}`).bind(now, a.prior_unit_id),
      db.prepare(`UPDATE device_registrations SET revoked_at = ? WHERE unit_id = ? AND revoked_at IS NULL AND ${ACT}`).bind(now, a.prior_unit_id)
    );
  }
  // AR re-delivery of a unit an undone-delivery cancel closed
  stmts.push(...reopenUnitStatements(db, unitId, a.serial_norm, ACT, { order_id: orderId, assignment_id: a.id, via: 'scan' }));
  // A5 the verified lot — never an inferred one (L12)
  if (a.lot_id && a.lot_source === 'serial_link') {
    stmts.push(db.prepare(`UPDATE order_item_units SET inventory_lot_id = ? WHERE id = ? AND inventory_lot_id IS NULL AND ${ACT}`).bind(a.lot_id, unitId));
  }
  // A2 history
  stmts.push(
    db
      .prepare(
        `INSERT INTO audit_log (actor_id, action, target, detail)
         SELECT NULL, 'serial.warranty_activated', ?1,
                json_object('assignment_id', ?2, 'order_id', ?3, 'unit_id', u.id, 'delivered_at', u.delivered_at,
                            'warranty_start_at', u.warranty_start_at, 'warranty_end_at', u.warranty_end_at,
                            'mode', ?4, 'lot_id', ?5, 'prior_unit_id', ?6)
           FROM order_item_units u WHERE u.id = ?7 AND ${ACT}`
      )
      .bind(a.serial_norm, a.id, orderId, a.warranty_mode, a.lot_id, a.prior_unit_id, unitId)
  );
  try {
    await db.batch(stmts);
  } catch (e) {
    // The fence (the row did not activate: a conflict, or a concurrent run
    // got there first) is not a failure to log; anything else is.
    if (!isLostRace(e)) console.error('serial activation failed', a.id, e instanceof Error ? e.message : String(e));
  }
  const after = await db.prepare('SELECT activated_at FROM serial_assignments WHERE id = ?').bind(a.id).first<{ activated_at: string | null }>();
  return !!after?.activated_at;
}

/**
 * The re-delivered units that got NO new serial (integrity review #1): each
 * unit of this delivered order that an undone-delivery cancel closed and
 * whose slot holds no live binding is re-opened, in its own batch, fenced on
 * exactly that state. Its old device:
 *   - still pointed at it and free (no live binding anywhere, not void) →
 *     kept: an activated `relink` binding records it, its receipt comes back;
 *   - since bound elsewhere, or void → its pointer leaves the unit (audited
 *     `serial.detached`): the customer's warranty is open, the serial is not
 *     theirs to claim;
 *   - none → the unit simply re-opens.
 * A batch that loses a race changes nothing; the activation sweep retries.
 */
async function reopenRedeliveredUnits(db: D1Database, orderId: string): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.order_item_id, u.unit_index, u.product_id, d.serial_norm, d.serial_raw,
              EXISTS (SELECT 1 FROM serial_assignments x WHERE x.serial_norm = d.serial_norm AND x.released_at IS NULL) AS serial_live,
              (SELECT si.voided_at FROM serial_inventory si WHERE si.serial_norm = d.serial_norm) AS voided_at
         FROM order_item_units u LEFT JOIN device_serials d ON d.unit_id = u.id
        WHERE u.order_id = ? AND u.warranty_closed_reason = 'order_cancelled'
          AND NOT EXISTS (SELECT 1 FROM serial_assignments a WHERE a.released_at IS NULL
                           AND (a.unit_id = u.id OR (a.order_item_id = u.order_item_id AND a.unit_index = u.unit_index AND a.part = 'device')))`
    )
    .bind(orderId)
    .all<{ id: string; order_item_id: string; unit_index: number; product_id: string | null; serial_norm: string | null; serial_raw: string | null; serial_live: number; voided_at: string | null }>();
  let reopened = 0;
  for (const u of results ?? []) {
    const when = `EXISTS (SELECT 1 FROM orders wo WHERE wo.id = ${lit(orderId)} AND wo.status = 'delivered')`;
    const stmts: D1PreparedStatement[] = [
      ...fence(
        db,
        `EXISTS (SELECT 1 FROM orders o WHERE o.id = ? AND o.status = 'delivered')
          AND EXISTS (SELECT 1 FROM order_item_units cu WHERE cu.id = ? AND cu.warranty_closed_reason = 'order_cancelled')
          AND NOT EXISTS (SELECT 1 FROM serial_assignments a WHERE a.released_at IS NULL
                           AND (a.unit_id = ? OR (a.order_item_id = ? AND a.unit_index = ? AND a.part = 'device')))`,
        [orderId, u.id, u.id, u.order_item_id, u.unit_index]
      ),
    ];
    const keep = !!u.serial_norm && Number(u.serial_live) !== 1 && !u.voided_at;
    if (u.serial_norm && keep) {
      const id = newId('sa');
      const now = nowIso();
      stmts.push(
        ...fence(
          db,
          `EXISTS (SELECT 1 FROM device_serials d WHERE d.serial_norm = ? AND d.unit_id = ?)
            AND NOT EXISTS (SELECT 1 FROM serial_assignments x WHERE x.serial_norm = ? AND x.released_at IS NULL)`,
          [u.serial_norm, u.id, u.serial_norm]
        ),
        db
          .prepare(
            `INSERT INTO serial_inventory (serial_norm, serial_raw, product_id, source, created_by, note)
             VALUES (?, ?, ?, 'manual', 'system', '') ON CONFLICT(serial_norm) DO NOTHING`
          )
          .bind(u.serial_norm, u.serial_raw || u.serial_norm, u.product_id),
        db
          .prepare(
            `INSERT INTO serial_assignments (id, serial_norm, serial_raw, order_id, order_item_id, order_ref, unit_index, part,
                product_id, source, idempotency_key, linked_by, linked_at, unit_id, activated_at)
             SELECT ?1, ?2, ?3, cu.order_id, cu.order_item_id, cu.order_id, cu.unit_index, 'device', cu.product_id, 'relink',
                    'reopen:' || ?1, 'system', ?4, cu.id, ?4
               FROM order_item_units cu WHERE cu.id = ?5 AND cu.unit_index BETWEEN 1 AND 1000`
          )
          .bind(id, u.serial_norm, u.serial_raw || u.serial_norm, now, u.id),
        ...reopenUnitStatements(db, u.id, u.serial_norm, when, { order_id: orderId, assignment_id: id, serial_kept: true, via: 'redelivery' })
      );
    } else {
      if (u.serial_norm) {
        stmts.push(
          rawAudit(db, null, 'serial.detached', u.serial_norm, {
            unit_id: u.id, order_id: orderId, reason: u.voided_at ? 'void' : 'held_elsewhere',
          }, `EXISTS (SELECT 1 FROM device_serials d WHERE d.serial_norm = ${lit(u.serial_norm)} AND d.unit_id = ${lit(u.id)})`),
          db.prepare('DELETE FROM device_serials WHERE unit_id = ? AND serial_norm = ?').bind(u.id, u.serial_norm)
        );
      }
      stmts.push(...reopenUnitStatements(db, u.id, null, when, { order_id: orderId, serial_kept: false, via: 'redelivery' }));
    }
    try {
      await db.batch(stmts);
      reopened++;
    } catch (e) {
      if (!isLostRace(e) && !/UNIQUE constraint failed/.test(e instanceof Error ? e.message : String(e))) {
        console.error('re-opening a re-delivered unit failed', u.id, e instanceof Error ? e.message : String(e));
      }
    }
  }
  return reopened;
}

/**
 * Delivered orders whose serials never activated, or whose undone-delivery
 * units were not re-opened yet — the cron's repair, bounded.
 */
export async function sweepUnactivatedSerials(env: Env, limit = 50): Promise<{ scanned: number; activated: number; errors: number }> {
  const out = { scanned: 0, activated: 0, errors: 0 };
  if (!(await serialAssignmentsInstalled(env.DB))) return out;
  const { results } = await env.DB.prepare(
    `SELECT o.id, o.delivered_at FROM orders o
      WHERE o.status = 'delivered' AND o.delivered_at IS NOT NULL
        AND o.id IN (SELECT a.order_id FROM serial_assignments a
                      WHERE a.released_at IS NULL AND a.activated_at IS NULL AND a.activation_attempts < 5
                     UNION
                     SELECT u.order_id FROM order_item_units u
                      WHERE u.warranty_closed_reason = 'order_cancelled'
                        AND NOT EXISTS (SELECT 1 FROM serial_assignments x WHERE x.released_at IS NULL
                                         AND (x.unit_id = u.id OR (x.order_item_id = u.order_item_id AND x.unit_index = u.unit_index))))
      LIMIT ?`
  )
    .bind(Math.min(Math.max(Math.trunc(limit), 1), 200))
    .all<{ id: string; delivered_at: string }>();
  out.scanned = results.length;
  // Late import: deviceOps imports this module for the activation step.
  const { createUnitsOnDelivery } = await import('./deviceOps');
  for (const o of results) {
    try {
      const r = await createUnitsOnDelivery(env, o.id, o.delivered_at);
      out.activated += (r.activation?.activated ?? 0) + (r.activation?.reopened ?? 0);
    } catch (e) {
      out.errors++;
      console.error('serial activation sweep failed for order', o.id, e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}

// ======================================================================
//  THE PREPARATION GATE (§19, critique H2)
// ======================================================================

export interface GateMissing {
  order_item_id: string;
  unit_index: number;
  part: string;
  product_name: string;
}

export interface GateState {
  installed: boolean;
  enabled: boolean;
  since: string | null;
  applies: boolean;
  missing: GateMissing[];
  lot_conflicts: Array<{ assignment_id: string; order_item_id: string; unit_index: number }>;
  /** [{i: order_item_id, q: required count}] — bound into the in-batch fence. */
  required: Array<{ i: string; q: number }>;
}

/** Stages and statuses the gate guards: the moves that hand a parcel over. */
export const GATED_TARGET_STAGES = ['out_for_delivery', 'delivered'] as const;

export async function serialGateState(env: Env, orderId: string): Promise<GateState> {
  const db = env.DB;
  const empty: GateState = { installed: false, enabled: false, since: null, applies: false, missing: [], lot_conflicts: [], required: [] };
  if (!(await serialAssignmentsInstalled(db))) return empty;
  const setting = await getSetting(db, 'serialPrepGate');
  const { order, slots } = await serialRequiredSlots(db, orderId);
  const base = { ...empty, installed: true, enabled: setting.enabled, since: setting.since };
  if (!order || order.seller_type === 'merchant') return base;
  const appliesToOrder = setting.enabled && (!setting.since || Date.parse(order.created_at) >= Date.parse(setting.since));
  const { results: live } = await db
    .prepare(
      `SELECT a.id, a.order_item_id, a.unit_index, a.lot_id, a.lot_source,
              (SELECT sl.lot_id FROM stock_serial_links sl WHERE sl.serial_norm = a.serial_norm) AS linked_lot
         FROM serial_assignments a
        WHERE a.order_id = ? AND a.released_at IS NULL AND a.part = 'device'`
    )
    .bind(orderId)
    .all<{ id: string; order_item_id: string; unit_index: number; lot_id: string | null; lot_source: string | null; linked_lot: string | null }>();
  const have = new Set(live.map((a) => `${a.order_item_id}:${a.unit_index}`));
  const missing = slots.filter((s) => !have.has(`${s.order_item_id}:${s.unit_index}`)).map((s) => ({ order_item_id: s.order_item_id, unit_index: s.unit_index, part: s.part, product_name: s.product_name }));
  // M1: at dispatch, a serial whose OWN lot is no longer among the line's live
  // allocations (a re-confirm re-allocated FIFO elsewhere) — its own lot being
  // the one verified at the scan, or the one the receiving desk linked it to
  // since (integrity review #4: a lot recorded after the scan is compared too).
  const lotConflicts: GateState['lot_conflicts'] = [];
  const lotsOf = new Map<string, LotFacts[]>();
  for (const a of live) {
    const own = a.lot_source === 'serial_link' && a.lot_id ? a.lot_id : a.linked_lot;
    if (!own) continue;
    if (!lotsOf.has(a.order_item_id)) lotsOf.set(a.order_item_id, await lineLots(db, a.order_item_id));
    const lots = lotsOf.get(a.order_item_id)!;
    if (lots.length && !lots.some((l) => l.lot_id === own && l.net > 0)) lotConflicts.push({ assignment_id: a.id, order_item_id: a.order_item_id, unit_index: a.unit_index });
  }
  const counts = new Map<string, number>();
  for (const s of slots) counts.set(s.order_item_id, (counts.get(s.order_item_id) ?? 0) + 1);
  return {
    ...base,
    applies: appliesToOrder && slots.length > 0,
    missing,
    lot_conflicts: lotConflicts,
    required: [...counts].map(([i, q]) => ({ i, q })),
  };
}

/** Is this move one the gate guards? Forward into a hand-over stage only. */
export function gateGuardsMove(fromStatus: string, toStage: string): boolean {
  if (!(GATED_TARGET_STAGES as readonly string[]).includes(toStage)) return false;
  // Backward corrections (delivered → out_for_delivery) and cancels are never gated.
  return fromStatus !== 'delivered' && fromStatus !== 'cancelled';
}

/**
 * The in-batch half of the gate (H2): placed right after the stage flip, it
 * re-counts every serial-required line's live assignments inside the move's
 * own transaction, so an unlink that lands between the pre-read and the flip
 * can no longer ship an order with a missing serial.
 */
export function serialGateFence(db: D1Database, required: GateState['required']): D1PreparedStatement[] {
  if (!required.length) return [];
  return fence(
    db,
    `NOT EXISTS (SELECT 1 FROM json_each(?) j
                  WHERE (SELECT COUNT(*) FROM serial_assignments a
                          WHERE a.order_item_id = json_extract(j.value, '$.i') AND a.released_at IS NULL AND a.part = 'device')
                        < json_extract(j.value, '$.q'))`,
    [JSON.stringify(required)]
  );
}

export function serialsRequiredError(state: Pick<GateState, 'missing' | 'lot_conflicts'>): HttpError {
  return refuse(409, 'SERIALS_REQUIRED', { missing: state.missing, lot_conflicts: state.lot_conflicts });
}

/**
 * The pre-read half of the gate for an admin door. Returns the fence to put
 * in the move batch, or [] when the gate does not apply. The owner may pass
 * a reason instead (5–500 characters): the move goes ahead and the override
 * audit row rides the same batch (critique L5).
 */
export async function serialGateForMove(
  env: Env,
  actor: SerialActor,
  orderId: string,
  fromStatus: string,
  toStage: string,
  overrideReason: string
): Promise<{ statements: D1PreparedStatement[]; overridden: boolean }> {
  if (!gateGuardsMove(fromStatus, toStage)) return { statements: [], overridden: false };
  const state = await serialGateState(env, orderId);
  if (!state.applies) return { statements: [], overridden: false };
  const blocked = state.missing.length > 0 || state.lot_conflicts.length > 0;
  const reason = overrideReason.trim();
  if (reason) {
    if (!actor.owner) throw refuse(403, 'OWNER_ONLY');
    if (reason.length < 5 || reason.length > 500) throw refuse(400, 'OVERRIDE_REASON_REQUIRED');
    // Nothing to override: the move still carries the fence, so an unlink
    // racing it is caught exactly as without a reason (integrity review #7).
    if (!blocked) return { statements: serialGateFence(env.DB, state.required), overridden: false };
    const audit = await auditStatements(env.DB, actor.id, 'serial.prep_gate_override', orderId, {
      reason, to_stage: toStage, missing: state.missing, lot_conflicts: state.lot_conflicts,
    });
    return { statements: audit.statements, overridden: true };
  }
  if (blocked) throw serialsRequiredError(state);
  return { statements: serialGateFence(env.DB, state.required), overridden: false };
}

// ======================================================================
//  RETURN (§14) — the unit closes, nothing is zeroed.
// ======================================================================

/**
 * Which warranty units a resolved refund case returns, by evidence only:
 *   1. serials scanned at inspection (`serials`), each resolved to its unit on
 *      THIS line and THIS buyer — a mismatch is refused (critique M6: the
 *      customer's own unit pick is never trusted on a multi-unit line);
 *   2. explicit `unit_ids` from the admin, on this line;
 *   3. otherwise every open unit of the line when the case covers them all.
 * Automatic attribution (3) only touches units bound through an activated
 * assignment — devices this feature delivered — so a refund on an order
 * delivered before it never rewrites that order's history.
 */
export async function returnedUnits(
  db: D1Database,
  kase: { id: string; order_item_id: string; user_id: string; qty: number },
  input: { serials?: unknown; unit_ids?: unknown }
): Promise<{ units: string[]; unattributed: boolean }> {
  const { results: open } = await db
    .prepare(
      `SELECT u.id, d.serial_norm,
              EXISTS (SELECT 1 FROM serial_assignments a WHERE a.unit_id = u.id AND a.released_at IS NULL) AS assigned
         FROM order_item_units u LEFT JOIN device_serials d ON d.unit_id = u.id
        WHERE u.order_item_id = ? AND u.warranty_closed_at IS NULL AND u.replaced_by_unit_id IS NULL`
    )
    .bind(kase.order_item_id)
    .all<{ id: string; serial_norm: string | null; assigned: number }>();
  // The ONE canonicaliser (critique H1, integrity review #14): `SN 0391…`, a
  // QR payload or a box SN filed with its asset reads as the device it names.
  // A legacy key it would refuse (shorter, other characters) still matches
  // the unit it is stored on — attribution only ever reads this line's units.
  const serials: string[] = [];
  for (const raw of Array.isArray(input.serials) ? input.serials : []) {
    const text = String(raw ?? '').slice(0, 200);
    if (!text.trim()) continue;
    const norm = await canonicalSerial(db, text).then((c) => c.norm, () => normalizeSerial(stripSerialPrefix(text)));
    if (norm) serials.push(norm);
  }
  if (serials.length) {
    const units: string[] = [];
    for (const s of serials) {
      const hit = open.find((u) => u.serial_norm === s);
      if (!hit) throw refuse(400, 'RETURN_SERIAL_MISMATCH', { serial: s });
      units.push(hit.id);
    }
    return { units: [...new Set(units)], unattributed: false };
  }
  const ids = Array.isArray(input.unit_ids) ? input.unit_ids.map(String) : [];
  if (ids.length) {
    for (const id of ids) if (!open.some((u) => u.id === id)) throw refuse(400, 'RETURN_UNIT_MISMATCH', { unit_id: id });
    return { units: [...new Set(ids)], unattributed: false };
  }
  const featureUnits = open.filter((u) => Number(u.assigned) === 1);
  if (featureUnits.length && featureUnits.length === open.length && open.length === kase.qty) return { units: open.map((u) => u.id), unattributed: false };
  return { units: [], unattributed: featureUnits.length > 0 };
}

export async function returnSerialStatements(
  db: D1Database,
  input: { caseId: string; units: string[]; restock: boolean; adminId: string | null; orderId: string }
): Promise<D1PreparedStatement[]> {
  const now = nowIso();
  const adminId = input.adminId || null;
  const reason = input.restock ? 'returned' : 'returned_unsellable';
  const stmts: D1PreparedStatement[] = [];
  for (const unitId of input.units) {
    stmts.push(
      db
        .prepare(
          `UPDATE order_item_units SET warranty_closed_at = ?1, warranty_closed_reason = ?2, return_case_id = ?3
            WHERE id = ?4 AND warranty_closed_at IS NULL
              AND EXISTS (SELECT 1 FROM return_cases WHERE id = ?3 AND state = 'resolved' AND resolution = 'refund')`
        )
        .bind(now, reason, input.caseId, unitId),
      db.prepare(`UPDATE warranty_receipts SET status = 'void', void_reason = 'returned', voided_at = ?1, voided_by = ?2, updated_at = ?1 WHERE unit_id = ?3 AND status IN ('draft','active')`).bind(now, adminId, unitId),
      db.prepare('UPDATE device_registrations SET revoked_at = ? WHERE unit_id = ? AND revoked_at IS NULL').bind(now, unitId),
      db
        .prepare(
          `INSERT INTO audit_log (actor_id, action, target, detail)
           SELECT ?1, 'serial.returned', d.serial_norm,
                  json_object('return_case_id', ?2, 'unit_id', ?3, 'disposition', ?4, 'order_id', ?5,
                              'assignment_id', (SELECT a.id FROM serial_assignments a WHERE a.unit_id = ?3 AND a.released_at IS NULL))
             FROM device_serials d WHERE d.unit_id = ?3`
        )
        .bind(adminId, input.caseId, unitId, reason, input.orderId),
      db
        .prepare(
          `UPDATE serial_assignments SET released_at = ?1, released_by = ?2, release_reason = 'returned', return_case_id = ?3
            WHERE unit_id = ?4 AND released_at IS NULL`
        )
        .bind(now, adminId, input.caseId, unitId)
    );
  }
  return stmts;
}

/**
 * The return hook (returns.ts, `to='resolved'` with `resolution='refund'`):
 * attribute, close, void, revoke, release — one batch after the case flip.
 * An ambiguous case changes nothing and leaves `serial.return_unattributed`
 * (target = the case) for the owner. Returns what it did, for the response.
 */
export async function applyReturnSerials(
  env: Env,
  kase: { id: string; order_id: string; order_item_id: string; user_id: string; qty: number },
  input: { serials?: unknown; unit_ids?: unknown },
  adminId: string | null,
  restock: boolean
): Promise<{ closed: string[]; unattributed: boolean }> {
  const db = env.DB;
  if (!(await serialAssignmentsInstalled(db))) return { closed: [], unattributed: false };
  const { units, unattributed } = await returnedUnits(db, kase, input);
  if (units.length) {
    await db.batch(await returnSerialStatements(db, { caseId: kase.id, units, restock, adminId, orderId: kase.order_id }));
    const { results } = await db
      .prepare(`SELECT id FROM order_item_units WHERE return_case_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .bind(kase.id, JSON.stringify(units))
      .all<{ id: string }>();
    return { closed: results.map((r) => r.id), unattributed: false };
  }
  if (unattributed) {
    await db.batch(
      (await auditStatements(db, adminId, 'serial.return_unattributed', kase.id, { order_id: kase.order_id, order_item_id: kase.order_item_id, qty: kase.qty })).statements
    );
  }
  return { closed: [], unattributed };
}

/**
 * Refund cases resolved AFTER their device's serial activated whose warranty
 * is still open — the return route flips the case first and is not one
 * transaction, so this retries the hook. Bounded by that activation time
 * (critique L6): a refund resolved before this feature existed is never
 * rewritten.
 */
export async function sweepReturnedSerials(env: Env, limit = 50): Promise<{ scanned: number; closed: number; errors: number }> {
  const out = { scanned: 0, closed: 0, errors: 0 };
  const db = env.DB;
  if (!(await serialAssignmentsInstalled(db))) return out;
  const { results } = await db
    .prepare(
      `SELECT r.id, r.order_id, r.order_item_id, r.user_id, r.qty FROM return_cases r
        WHERE r.state = 'resolved' AND r.resolution = 'refund' AND r.decided_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM serial_assignments a JOIN order_item_units u ON u.id = a.unit_id
                       WHERE a.order_item_id = r.order_item_id AND a.released_at IS NULL AND a.activated_at IS NOT NULL
                         AND a.activated_at < r.decided_at AND u.warranty_closed_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM order_item_units u WHERE u.return_case_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.target = r.id AND l.action = 'serial.return_unattributed')
        LIMIT ?`
    )
    .bind(Math.min(Math.max(Math.trunc(limit), 1), 200))
    .all<{ id: string; order_id: string; order_item_id: string; user_id: string; qty: number }>();
  out.scanned = results.length;
  for (const k of results) {
    try {
      const inspection = await tryFirst(() =>
        db.prepare('SELECT disposition FROM stock_return_inspections WHERE return_case_id = ?').bind(k.id).first<{ disposition: string }>()
      );
      const res = await applyReturnSerials(env, k, {}, null, !inspection || inspection.disposition === 'restock');
      out.closed += res.closed.length;
    } catch (e) {
      out.errors++;
      console.error('serial return sweep failed for case', k.id, e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}

// ======================================================================
//  The orders board (spec §5.5) — «الأرقام n/m» on each row.
// ======================================================================

export interface BoardSerialCount {
  /** Units of this order that need a serial (the slot rule of `serialRequiredSlots`). */
  required: number;
  /** Of those, how many carry a live serial now. */
  linked: number;
  /** The owner's §19 gate holds THIS order (switched on, created after the cutover). */
  gate: boolean;
}

/** Statuses a board row carries the count for: on the shelf, before dispatch. */
const BOARD_SERIAL_STATUSES = new Set(['confirmed', 'processing']);

/**
 * The board's per-row serial count, for a whole page in three reads (the
 * page's lines with their policy, the policy context, the live bindings) —
 * never one `serialRequiredSlots` per row. The same predicate as every other
 * door (`lineDevicePolicy`; bundle parents and community-store orders
 * excluded; 500 per line at most), so the chip and the order window agree.
 * Empty before migration 0178 and on any failure: a chip is never worth a
 * board that does not load.
 */
export async function boardSerialCounts(
  env: Env,
  orders: ReadonlyArray<{ id?: unknown; status?: unknown; seller_type?: unknown; created_at?: unknown }>
): Promise<Map<string, BoardSerialCount>> {
  const out = new Map<string, BoardSerialCount>();
  const eligible = orders.filter((o) => BOARD_SERIAL_STATUSES.has(String(o.status ?? '')) && String(o.seller_type ?? '') !== 'merchant');
  if (!eligible.length) return out;
  try {
    const db = env.DB;
    if (!(await serialAssignmentsInstalled(db))) return out;
    const ids = JSON.stringify(eligible.map((o) => String(o.id)));
    const [linesRes, liveRes, gate] = await Promise.all([
      db
        .prepare(
          `SELECT oi.id, oi.order_id, oi.product_id, oi.qty, p.ops_policy,
                  EXISTS (SELECT 1 FROM order_items c WHERE c.bundle_parent_item_id = oi.id) AS is_bundle_parent
             FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
            WHERE oi.order_id IN (SELECT value FROM json_each(?))`
        )
        .bind(ids)
        .all<{ id: string; order_id: string; product_id: string | null; qty: number; ops_policy: string | null; is_bundle_parent: number }>(),
      db
        .prepare(
          `SELECT order_id, order_item_id, unit_index FROM serial_assignments
            WHERE order_id IN (SELECT value FROM json_each(?)) AND released_at IS NULL AND part = 'device'`
        )
        .bind(ids)
        .all<{ order_id: string; order_item_id: string; unit_index: number }>(),
      getSetting(db, 'serialPrepGate'),
    ]);
    const lines = linesRes.results ?? [];
    const live = liveRes.results ?? [];
    const ctx = await serializationContext(db, lines.map((l) => String(l.product_id ?? '')));
    const need = new Map<string, number>();
    for (const l of lines) {
      if (!l.product_id || Number(l.is_bundle_parent) === 1) continue;
      if (!lineDevicePolicy(l.ops_policy, l.product_id, ctx).serialized) continue;
      need.set(l.id, Math.min(Math.max(Number(l.qty) || 0, 0), 500));
    }
    for (const o of eligible) {
      const id = String(o.id);
      const required = lines.reduce((n, l) => n + (l.order_id === id ? need.get(l.id) ?? 0 : 0), 0);
      if (required === 0) continue;
      const linked = new Set(
        live
          .filter((a) => a.order_id === id && Number(a.unit_index) <= (need.get(a.order_item_id) ?? 0))
          .map((a) => `${a.order_item_id}:${a.unit_index}`)
      ).size;
      const created = Date.parse(String(o.created_at ?? ''));
      const gateOn = gate.enabled && (!gate.since || (Number.isFinite(created) && created >= Date.parse(gate.since)));
      out.set(id, { required, linked, gate: gateOn });
    }
    return out;
  } catch {
    return new Map();
  }
}

// ======================================================================
//  The order screen (§1, §16, §21, §30) — the `serials` enrichment.
// ======================================================================

export interface OrderSerialsView {
  installed: boolean;
  window: boolean;
  shipment_locked: boolean;
  gate: { enabled: boolean; applies: boolean; since: string | null };
  required: number;
  linked: number;
  slots: Array<
    SerialSlot & {
      assignment: SlotView['assignment'];
      previous: null | { assignment_id: string; serial_display: string; serial_full?: string; released_at: string; reason: string; free: boolean };
      flags: string[];
    }
  >;
  missing: GateMissing[];
}

export async function orderSerialsView(env: Env, actor: SerialActor, orderId: string): Promise<OrderSerialsView> {
  const db = env.DB;
  const off: OrderSerialsView = { installed: false, window: false, shipment_locked: false, gate: { enabled: false, applies: false, since: null }, required: 0, linked: 0, slots: [], missing: [] };
  if (!(await serialAssignmentsInstalled(db))) return off;
  const { order, slots } = await serialRequiredSlots(db, orderId);
  if (!order) return { ...off, installed: true };
  const [gate, liveRes, prevRes] = await Promise.all([
    serialGateState(env, orderId),
    db.prepare(`SELECT ${ASSIGNMENT_COLS} FROM serial_assignments WHERE order_id = ? AND released_at IS NULL`).bind(orderId).all<AssignmentRow>(),
    db
      .prepare(
        `SELECT a.id, a.order_item_id, a.unit_index, a.part, a.serial_norm, a.serial_raw, a.released_at, a.release_reason,
                (EXISTS (SELECT 1 FROM serial_assignments x WHERE x.serial_norm = a.serial_norm AND x.released_at IS NULL)
                 OR EXISTS (SELECT 1 FROM device_serials d JOIN order_item_units u ON u.id = d.unit_id
                             WHERE d.serial_norm = a.serial_norm AND u.warranty_closed_at IS NULL)) AS taken
           FROM serial_assignments a
          WHERE a.order_id = ? AND a.release_reason = 'order_cancelled'
          ORDER BY a.released_at DESC`
      )
      .bind(orderId)
      .all<{ id: string; order_item_id: string; unit_index: number; part: string; serial_norm: string; serial_raw: string; released_at: string; release_reason: string; taken: number }>(),
  ]);
  const live = liveRes.results ?? [];
  const prev = prevRes.results ?? [];
  const delivered = order.status === 'delivered';
  const stockReturned = new Set<string>();
  for (const itemId of new Set(slots.map((s) => s.order_item_id))) {
    const latest = await tryFirst(() =>
      db
        .prepare(
          `SELECT kind FROM inventory_ledger WHERE order_id = ?1 AND instr(idempotency_key, ':' || ?2 || ':') > 0
            ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .bind(orderId, itemId)
        .first<{ kind: string }>()
    );
    if (latest && (latest.kind === 'restore' || latest.kind === 'release')) stockReturned.add(itemId);
  }
  const out: OrderSerialsView['slots'] = [];
  for (const s of slots) {
    const row = live.find((a) => a.order_item_id === s.order_item_id && a.unit_index === s.unit_index && a.part === s.part) ?? null;
    const view = await slotView(db, actor, row, s);
    const p = row ? null : prev.find((x) => x.order_item_id === s.order_item_id && x.unit_index === s.unit_index && x.part === s.part) ?? null;
    const flags: string[] = [];
    if (row && !row.lot_id && row.lot_source === null) {
      const lots = await lineLots(db, s.order_item_id);
      if (!lots.length) flags.push('ALLOCATION_MISSING');
    }
    if (row && delivered && !row.activated_at && Number(row.activation_attempts) > 0) flags.push('SERIAL_ACTIVATION_CONFLICT');
    if (delivered && !row) flags.push('SERIAL_MISSING_AT_DELIVERY');
    // §30 / critique-1 #32: a re-opened order whose stock was returned and not
    // taken again (DECISIONS 184(15)) — a flag for the screen, never a gate.
    if (order.status !== 'cancelled' && order.status !== 'delivered' && stockReturned.has(s.order_item_id)) flags.push('STOCK_NOT_RETAKEN');
    out.push({
      ...s,
      assignment: view.assignment,
      previous: p
        ? { assignment_id: p.id, serial_display: shown(p.serial_raw, actor), ...(actor.fullSerial ? { serial_full: p.serial_raw } : {}), released_at: p.released_at, reason: p.release_reason, free: Number(p.taken) !== 1 }
        : null,
      flags,
    });
  }
  const linked = out.filter((s) => s.assignment).length;
  return {
    installed: true,
    window: serialScanWindow(order.shipping_type, order.stage, order.status),
    shipment_locked: !!order.delivery_remote_id,
    gate: { enabled: gate.enabled, applies: gate.applies, since: gate.since },
    required: slots.length,
    linked,
    slots: out,
    missing: gate.missing,
  };
}

// ======================================================================
//  The serial page (§16) — status, warranty, orders and the whole timeline.
// ======================================================================

/**
 * The §16 page for one serial: the asset (or a legacy device known only to
 * device_serials), its current and previous orders, warranty and lot, and a
 * timeline built from every source — the asset's own `serial_inventory.*`
 * rows, `serial.*` rows, `device.*` on EVERY unit the serial was bound to,
 * the `warranty.*` rows of its receipts, and the «Added to system» event
 * rebuilt from created_at for assets added in bulk (critique-1 #18).
 * Privacy (L7): order ids and the full serial for the owner and full-scope
 * admins only; an assistant sees the masked serial and no order numbers.
 */
/**
 * Detail keys that hold an order number, and keys that hold a serial (this
 * device's or another's) — a string, a list of them, or an object whose every
 * string is one (`corrected_serial: { from, to }`). A box Product SN is a
 * serial too: the page masks the inventory row's `box_sn` the same way.
 */
const ORDER_KEYS = new Set(['order_id', 'other_order_id', 'previous_order_id', 'to_order_id']);
const SERIAL_KEYS = new Set([
  'new_serial', 'serial', 'serial_norm', 'serial_raw', 'detached_serial', 'detached_serial_raw', 'legacy_serial', 'new_serial_norm', 'old_serial',
  'replaced_serial', 'corrected_serial', 'serials', 'box_sn',
]);

function maskDeep(value: unknown, isSerial: boolean, depth: number): unknown {
  if (typeof value === 'string') return isSerial ? maskSerial(value) : value;
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, isSerial, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = ORDER_KEYS.has(k) ? null : maskDeep(v, isSerial || SERIAL_KEYS.has(k), depth + 1);
  }
  return out;
}

/**
 * A history row as an assistant may see it (UX review #1, critique L7): no
 * order numbers, and every serial in it masked — a «change» row names the
 * OTHER device's full serial, which the page itself never shows them. At
 * every depth (S1 review #3): `warranty.reissued` nests the corrected serial
 * under `corrected_serial.{from,to}`, `serial_inventory.update` the box SN
 * under `from` / `to`.
 */
export function maskedDetail(detail: Record<string, unknown>, actor: Pick<SerialActor, 'fullSerial'>): Record<string, unknown> {
  if (actor.fullSerial) return detail;
  return maskDeep(detail, false, 0) as Record<string, unknown>;
}

export async function serialStory(env: Env, actor: SerialActor, norm: string) {
  const db = env.DB;
  const installed = await serialAssignmentsInstalled(db);
  if (!installed) return null;
  const [asset, binding, assignments, receipts] = await Promise.all([
    db
      .prepare(
        `SELECT si.serial_norm, si.serial_raw, si.product_id, si.variant_id, si.source, si.created_by, si.created_at, si.voided_at,
                p.name AS p_name, p.name_ar AS p_name_ar, p.sku AS p_sku, v.sku AS v_sku, v.combo_key
           FROM serial_inventory si LEFT JOIN products p ON p.id = si.product_id LEFT JOIN product_variants v ON v.id = si.variant_id
          WHERE si.serial_norm = ?`
      )
      .bind(norm)
      .first<Record<string, unknown>>(),
    bindingOf(db, norm),
    db.prepare(`SELECT ${ASSIGNMENT_COLS} FROM serial_assignments WHERE serial_norm = ? ORDER BY linked_at DESC`).bind(norm).all<AssignmentRow>().then((r) => r.results ?? []),
    db.prepare('SELECT id, receipt_no, status, unit_id FROM warranty_receipts WHERE serial_norm = ?').bind(norm).all<{ id: string; receipt_no: string; status: string; unit_id: string }>().then((r) => r.results ?? []),
  ]);
  const legacy = !asset && (binding || receipts.length);
  if (!asset && !legacy) return null;
  const units = [...new Set([binding?.unit_id, ...assignments.map((a) => a.unit_id), ...assignments.map((a) => a.prior_unit_id)].filter(Boolean) as string[])];
  const rawSerial = String(asset?.serial_raw ?? assignments[0]?.serial_raw ?? norm);
  const status = await db
    .prepare(
      `SELECT ${serialStatusSql(true)} AS s FROM (SELECT ?1 AS serial_norm, ?2 AS voided_at) si
         LEFT JOIN device_serials ds ON ds.serial_norm = si.serial_norm
         LEFT JOIN device_registrations r ON r.unit_id = ds.unit_id`
    )
    .bind(norm, asset?.voided_at ?? null)
    .first<{ s: InventoryStatus }>();
  const targets = [norm, ...units, ...receipts.map((r) => r.id)];
  const { results: history } = await db
    .prepare(
      `SELECT a.id, a.action, a.target, a.detail, a.created_at, a.actor_id, us.email, us.username
         FROM audit_log a LEFT JOIN users us ON us.id = a.actor_id
        WHERE a.target IN (SELECT value FROM json_each(?))
          AND (a.action LIKE 'serial%' OR a.action LIKE 'device.%' OR a.action LIKE 'warranty.%')
        ORDER BY a.created_at DESC, a.id DESC LIMIT 200`
    )
    .bind(JSON.stringify(targets))
    .all<Record<string, unknown>>();
  const live = assignments.find((a) => !a.released_at) ?? null;
  const unit = binding;
  const cov = unit ? coverageState(unit.delivered_at, unit.warranty_end_at) : null;
  let warrantyState: string = live && !live.activated_at ? 'PENDING_DELIVERY' : 'NOT_ACTIVATED';
  if (unit) {
    if (unit.warranty_closed_at) warrantyState = unit.warranty_closed_reason?.startsWith('returned') ? 'RETURNED' : 'CLOSED';
    else if (!(live && !live.activated_at)) warrantyState = cov?.state === 'active' ? 'ACTIVE' : cov?.state === 'expired' ? 'EXPIRED' : 'NEEDS_CONFIG';
  }
  const orderOf = (a: AssignmentRow) => (actor.fullSerial ? a.order_id ?? a.order_ref : null);
  // §25 who cancelled: the trigger writes its rows with no actor (orders has
  // no cancelled_by) — the order's own stage history knows (critique-1 #17).
  const cancelledBy = new Map<string, string>();
  for (const h of history) {
    if (h.action !== 'serial.released' || h.actor_id) continue;
    const orderId = safeParse<Record<string, unknown>>(h.detail, {}).order_id;
    if (typeof orderId !== 'string' || cancelledBy.has(orderId)) continue;
    const who = await tryFirst(() =>
      db
        .prepare("SELECT changed_by FROM order_status_history WHERE order_id = ? AND status = 'cancelled' ORDER BY changed_at DESC LIMIT 1")
        .bind(orderId)
        .first<{ changed_by: string }>()
    );
    if (who?.changed_by) cancelledBy.set(orderId, who.changed_by);
  }
  const added = history.some((h) => h.action === 'serial_inventory.add');
  return {
    serial_display: shown(rawSerial, actor),
    ...(actor.fullSerial ? { serial: rawSerial } : {}),
    serial_norm: actor.fullSerial ? norm : null,
    legacy: !!legacy,
    product: asset?.product_id ? { id: asset.product_id, name: asset.p_name ?? '', name_ar: asset.p_name_ar ?? '' } : null,
    variant: asset?.variant_id ? { id: asset.variant_id, label: asset.combo_key ?? null } : null,
    sku: (asset?.v_sku as string | null) ?? (asset?.p_sku as string | null) ?? null,
    status: status?.s ?? 'in_stock',
    current_order: live ? { order_id: orderOf(live), unit_index: live.unit_index, linked_at: live.linked_at, activated: !!live.activated_at } : null,
    previous_orders: assignments
      .filter((a) => a.released_at)
      .map((a) => ({ order_id: orderOf(a), released_at: a.released_at, reason: a.release_reason, linked_at: a.linked_at })),
    warranty: {
      state: warrantyState,
      start_at: unit?.delivered_at ?? null,
      end_at: unit?.warranty_end_at ?? null,
      remaining_days: unit && !unit.warranty_closed_at ? cov?.remaining_days ?? null : null,
      mode: live?.warranty_mode ?? null,
      closed_reason: unit?.warranty_closed_reason ?? null,
    },
    lot: live?.lot_id ? { id: live.lot_id, source: live.lot_source } : null,
    history: [
      ...history.map((h) => {
        const detail = maskedDetail(safeParse<Record<string, unknown>>(h.detail, {}), actor);
        const orderId = safeParse<Record<string, unknown>>(h.detail, {}).order_id;
        const inferred = !h.actor_id && typeof orderId === 'string' ? cancelledBy.get(orderId) : undefined;
        return {
          id: h.id,
          action: h.action,
          created_at: h.created_at,
          actor: h.actor_id
            ? { id: h.actor_id, email: h.email ?? null, username: h.username ?? null }
            : inferred
              ? { id: inferred, email: null, username: null, via: 'order_status_history' }
              : null,
          detail,
        };
      }),
      ...(!added && asset
        ? [{ id: `added:${shown(norm, actor)}`, action: 'serial_inventory.add', created_at: asset.created_at, actor: asset.created_by ? { id: asset.created_by, email: null, username: null } : null, detail: { source: asset.source, rebuilt: true } }]
        : []),
    ],
  };
}
