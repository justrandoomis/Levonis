/**
 * THE STORE'S DELIVERY POLICY («إدارة التوصيل», owner decisions 2026-10-18).
 *
 * One settings document (`admin_settings.deliveryPolicy`) prices Levonis's
 * own standard delivery:
 *
 *  - a DEFAULT price for the whole order, unlimited pieces, in every
 *    governorate (5,000);
 *  - per-governorate exceptions: a different default price, or delivery
 *    stopped there altogether;
 *  - RULE GROUPS aimed at sections / categories / sub-sections (any depth of
 *    the taxonomy) and at products, each with a mode: flat for the order, per
 *    piece, per block of N pieces, or "not delivered".
 *
 * A line is priced by the MOST SPECIFIC group that names it: product, then the
 * nearest section on its path (sub-section before section), then the default.
 * The order's delivery is the SUM of every group present; the default flat
 * charge is added only when no group is present at all. A governorate price
 * replaces the default only — groups cost the same everywhere.
 *
 * Pure: no I/O. Shared by the worker (quoteShipping is the only authority)
 * and the cart page's estimate.
 */
import { IRAQ_GOVERNORATES } from './iraqGovernorates';

export type DeliveryMode = 'flat' | 'per_piece' | 'per_block' | 'stopped';
export const DELIVERY_MODES: readonly DeliveryMode[] = ['flat', 'per_piece', 'per_block', 'stopped'];

export interface DeliveryName {
  ar: string;
  en: string;
  ckb: string;
}

export interface DeliveryRuleGroup {
  id: string;
  name: DeliveryName;
  enabled: boolean;
  mode: DeliveryMode;
  /** Integer IQD: per order (flat), per piece, or per block. Ignored for 'stopped'. */
  fee_iqd: number;
  /** Pieces per block; >= 2 for 'per_block', 1 otherwise. */
  block_size: number;
  /** Sections / categories / sub-sections at any depth. */
  catalog_ids: string[];
  /** Product targets (exceptions inside a section). */
  product_ids: string[];
}

export type GovernorateRule = { stopped: true } | { fee_iqd: number };

export interface DeliveryPolicy {
  version: 1;
  /** Flat per order, unlimited pieces. */
  default_fee_iqd: number;
  /** Keyed by IRAQ_GOVERNORATES id. A missing key means the default. */
  governorates: Record<string, GovernorateRule>;
  groups: DeliveryRuleGroup[];
  updated_at: string;
  updated_by: string;
}

export const DELIVERY_FEE_MAX_IQD = 10_000_000;
export const DELIVERY_GROUPS_MAX = 50;
export const DELIVERY_PRODUCT_IDS_MAX = 500;
export const DELIVERY_CATALOG_IDS_MAX = 500;
export const DELIVERY_BLOCK_MAX = 10_000;
const GROUP_ID = /^[A-Za-z0-9_-]{1,48}$/;
const TARGET_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const GOVERNORATE_IDS = new Set(IRAQ_GOVERNORATES.map((g) => g.id));

/**
 * THE PRINTERS GROUP. A line that IS a printer — the owner's catalog flag
 * (`is_printer_catalog`, reached through any placement) or a printer size
 * class, the identity the pre-policy tariff charged its 10,000 on — and that
 * no group names by product or section is priced by this group when it is
 * enabled, instead of falling to the default. So a printer filed in a mixed
 * section the seeded rule leaves out (e.g. «أجهزة الليزر» itself), or in a
 * catalog flagged as a printer catalog later, still pays the printer charge.
 */
export const PRINTER_DELIVERY_GROUP_ID = 'g_printers';

/**
 * USED ONLY WHEN THE SETTING ROW IS MISSING. It reproduces the tariff that
 * was live before the delivery management: 5,000 per order, or 10,000 when a
 * printer is in the shipment (one flat printer charge, whatever the count).
 * "A printer" is the printer fact on the line (see PRINTER_DELIVERY_GROUP_ID),
 * so a printer outside the three catalog ids below is still charged 10,000.
 */
export const DELIVERY_POLICY_FALLBACK: DeliveryPolicy = {
  version: 1,
  default_fee_iqd: 5_000,
  governorates: {},
  groups: [
    {
      id: 'g_printers',
      name: { ar: 'الطابعات', en: 'Printers', ckb: 'پرینتەرەکان' },
      enabled: true,
      mode: 'flat',
      fee_iqd: 10_000,
      block_size: 1,
      catalog_ids: ['cat_printers', 'cat_laser_machines', 'cat_used_printers'],
      product_ids: [],
    },
  ],
  updated_at: '',
  updated_by: '',
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isFee = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= DELIVERY_FEE_MAX_IQD;
const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function idList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !TARGET_ID.test(x)) return null;
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

function readGovernorateRule(v: unknown): GovernorateRule | null {
  if (!isObj(v)) return null;
  if (v.stopped === true) return { stopped: true };
  if (isFee(v.fee_iqd)) return { fee_iqd: v.fee_iqd };
  return null;
}

/** One group, or null when anything about it is not a value somebody chose. */
function readGroup(v: unknown): DeliveryRuleGroup | null {
  if (!isObj(v)) return null;
  const id = typeof v.id === 'string' ? v.id : '';
  if (!GROUP_ID.test(id)) return null;
  const mode = v.mode as DeliveryMode;
  if (!DELIVERY_MODES.includes(mode)) return null;
  if (typeof v.enabled !== 'boolean') return null;
  const fee = mode === 'stopped' ? 0 : v.fee_iqd;
  if (!isFee(fee)) return null;
  let block = 1;
  if (mode === 'per_block') {
    const b = v.block_size;
    if (typeof b !== 'number' || !Number.isSafeInteger(b) || b < 2 || b > DELIVERY_BLOCK_MAX) return null;
    block = b;
  }
  const catalogs = idList(v.catalog_ids ?? []);
  const products = idList(v.product_ids ?? []);
  if (!catalogs || !products || catalogs.length + products.length === 0) return null;
  const n = isObj(v.name) ? v.name : {};
  return {
    id,
    name: { ar: str(n.ar) || id, en: str(n.en) || id, ckb: str(n.ckb) || str(n.en) || id },
    enabled: v.enabled,
    mode,
    fee_iqd: fee,
    block_size: block,
    catalog_ids: catalogs,
    product_ids: products,
  };
}

/**
 * TOLERANT READ. A malformed group or governorate entry is DROPPED rather
 * than priced: charging a number nobody chose is worse than a missing rule.
 * A document that is not a policy at all reads as the fallback.
 */
export function normalizeDeliveryPolicy(value: unknown): DeliveryPolicy {
  if (!isObj(value) || (value.version !== undefined && value.version !== 1)) return DELIVERY_POLICY_FALLBACK;
  const governorates: Record<string, GovernorateRule> = {};
  if (isObj(value.governorates)) {
    for (const [k, v] of Object.entries(value.governorates)) {
      if (!GOVERNORATE_IDS.has(k)) continue;
      const rule = readGovernorateRule(v);
      if (rule) governorates[k] = rule;
    }
  }
  const groups: DeliveryRuleGroup[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(value.groups) ? value.groups : []) {
    if (groups.length >= DELIVERY_GROUPS_MAX) break;
    const g = readGroup(raw);
    if (!g || seen.has(g.id)) continue;
    seen.add(g.id);
    groups.push(g);
  }
  return {
    version: 1,
    default_fee_iqd: isFee(value.default_fee_iqd) ? value.default_fee_iqd : DELIVERY_POLICY_FALLBACK.default_fee_iqd,
    governorates,
    groups,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : '',
    updated_by: typeof value.updated_by === 'string' ? value.updated_by : '',
  };
}

export interface DeliveryPolicyError {
  code: 'DELIVERY_POLICY_INVALID';
  field: string;
  message: DeliveryName;
}

const fail = (field: string, ar: string, en: string, ckb: string): { ok: false; error: DeliveryPolicyError } => ({
  ok: false,
  error: { code: 'DELIVERY_POLICY_INVALID', field, message: { ar, en, ckb } },
});

/**
 * STRICT WRITE. Refuses anything the tolerant reader would have to drop, plus
 * the rules the owner's page promises: a section or product sits in at most
 * one enabled group, every name exists in all three languages and the Sorani
 * name is not a copy of the Arabic (DECISIONS row 183). Whether every id
 * exists is the caller's question (it needs the database).
 */
export function validateDeliveryPolicy(
  value: unknown
): { ok: true; policy: DeliveryPolicy } | { ok: false; error: DeliveryPolicyError } {
  if (!isObj(value)) return fail('', 'إعدادات التوصيل غير صالحة.', 'The delivery settings are not valid.', 'ڕێکخستنەکانی گەیاندن دروست نین.');
  if (value.version !== undefined && value.version !== 1) {
    return fail('version', 'إصدار إعدادات التوصيل غير معروف.', 'Unknown delivery settings version.', 'وەشانی ڕێکخستنەکانی گەیاندن نەناسراوە.');
  }
  if (!isFee(value.default_fee_iqd)) {
    return fail(
      'default_fee_iqd',
      'السعر الافتراضي يجب أن يكون عدداً صحيحاً بين 0 و10,000,000 د.ع.',
      'The default price must be a whole number from 0 to 10,000,000 IQD.',
      'نرخی بنەڕەت دەبێت ژمارەیەکی تەواو بێت لە 0 تا 10,000,000 دینار.'
    );
  }
  const governorates: Record<string, GovernorateRule> = {};
  if (value.governorates !== undefined) {
    if (!isObj(value.governorates)) {
      return fail('governorates', 'قائمة المحافظات غير صالحة.', 'The governorate list is not valid.', 'لیستی پارێزگاکان دروست نییە.');
    }
    for (const [k, v] of Object.entries(value.governorates)) {
      if (!GOVERNORATE_IDS.has(k)) {
        return fail(`governorates.${k}`, `محافظة غير معروفة: ${k}`, `Unknown governorate: ${k}`, `پارێزگای نەناسراو: ${k}`);
      }
      const rule = readGovernorateRule(v);
      if (!rule) {
        return fail(
          `governorates.${k}`,
          'سعر المحافظة يجب أن يكون عدداً صحيحاً أو «التوصيل متوقف».',
          'A governorate price must be a whole number, or "delivery stopped".',
          'نرخی پارێزگا دەبێت ژمارەیەکی تەواو بێت، یان «گەیاندن ڕاگیراوە».'
        );
      }
      governorates[k] = rule;
    }
  }
  const rawGroups = value.groups === undefined ? [] : value.groups;
  if (!Array.isArray(rawGroups) || rawGroups.length > DELIVERY_GROUPS_MAX) {
    return fail(
      'groups',
      `القواعد يجب أن تكون قائمة من ${DELIVERY_GROUPS_MAX} قاعدة على الأكثر.`,
      `Rules must be a list of at most ${DELIVERY_GROUPS_MAX}.`,
      `یاساکان دەبێت لیستێک بن کە زیاتر لە ${DELIVERY_GROUPS_MAX} نەبێت.`
    );
  }
  const groups: DeliveryRuleGroup[] = [];
  const ids = new Set<string>();
  const catalogOwner = new Map<string, string>();
  const productOwner = new Map<string, string>();
  let productTotal = 0;
  let catalogTotal = 0;
  for (let i = 0; i < rawGroups.length; i += 1) {
    const raw = rawGroups[i];
    const f = `groups.${i}`;
    if (!isObj(raw)) return fail(f, 'قاعدة غير صالحة.', 'A rule is not valid.', 'یاسایەک دروست نییە.');
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!GROUP_ID.test(id) || ids.has(id)) {
      return fail(`${f}.id`, 'معرّف القاعدة مفقود أو مكرر.', 'A rule id is missing or repeated.', 'ناسنامەی یاسا نییە یان دووبارەیە.');
    }
    ids.add(id);
    const n = isObj(raw.name) ? raw.name : {};
    const ar = str(n.ar, 200);
    const en = str(n.en, 200);
    const ckb = str(n.ckb, 200);
    if (!ar || !en || !ckb || ar.length > 80 || en.length > 80 || ckb.length > 80) {
      return fail(
        `${f}.name`,
        'اسم القاعدة مطلوب بالعربية والإنجليزية والكردية (80 حرفاً على الأكثر).',
        'The rule name is required in Arabic, English and Kurdish (80 characters at most).',
        'ناوی یاسا بە عەرەبی و ئینگلیزی و کوردی پێویستە (زۆرترین 80 پیت).'
      );
    }
    if (ckb === ar) {
      return fail(
        `${f}.name.ckb`,
        'الاسم الكردي نسخة من العربي — اكتبه بالكردية السورانية.',
        'The Kurdish name is a copy of the Arabic — write it in Sorani Kurdish.',
        'ناوی کوردی کۆپیی عەرەبییەکەیە — بە کوردیی سۆرانی بینووسە.'
      );
    }
    if (typeof raw.enabled !== 'boolean') {
      return fail(`${f}.enabled`, 'حالة التفعيل غير صالحة.', 'The enabled switch is not valid.', 'دۆخی چالاککردن دروست نییە.');
    }
    const mode = raw.mode as DeliveryMode;
    if (!DELIVERY_MODES.includes(mode)) {
      return fail(`${f}.mode`, 'طريقة التسعير غير معروفة.', 'Unknown pricing mode.', 'شێوازی نرخدانان نەناسراوە.');
    }
    const fee = mode === 'stopped' ? 0 : raw.fee_iqd;
    if (!isFee(fee)) {
      return fail(
        `${f}.fee_iqd`,
        'الرسم يجب أن يكون عدداً صحيحاً بين 0 و10,000,000 د.ع.',
        'The fee must be a whole number from 0 to 10,000,000 IQD.',
        'کرێ دەبێت ژمارەیەکی تەواو بێت لە 0 تا 10,000,000 دینار.'
      );
    }
    let block = 1;
    if (mode === 'per_block') {
      const b = raw.block_size;
      if (typeof b !== 'number' || !Number.isSafeInteger(b) || b < 2 || b > DELIVERY_BLOCK_MAX) {
        return fail(
          `${f}.block_size`,
          'عدد القطع في الدفعة يجب أن يكون 2 أو أكثر.',
          'Pieces per block must be 2 or more.',
          'ژمارەی پارچە لە هەر کۆمەڵەیەکدا دەبێت 2 یان زیاتر بێت.'
        );
      }
      block = b;
    }
    const catalogs = idList(raw.catalog_ids ?? []);
    const products = idList(raw.product_ids ?? []);
    if (!catalogs || !products) {
      return fail(`${f}.targets`, 'قائمة الأقسام أو المنتجات غير صالحة.', 'The section or product list is not valid.', 'لیستی بەش یان بەرهەمەکان دروست نییە.');
    }
    if (catalogs.length + products.length === 0) {
      return fail(
        `${f}.targets`,
        'اختر قسماً أو منتجاً واحداً على الأقل لهذه القاعدة.',
        'Choose at least one section or product for this rule.',
        'لانیکەم یەک بەش یان بەرهەم بۆ ئەم یاسایە هەڵبژێرە.'
      );
    }
    catalogTotal += catalogs.length;
    productTotal += products.length;
    if (raw.enabled) {
      for (const c of catalogs) {
        const other = catalogOwner.get(c);
        if (other) {
          return fail(
            `${f}.catalog_ids`,
            `القسم ${c} مستخدم في قاعدة أخرى (${other}).`,
            `Section ${c} is already used by another rule (${other}).`,
            `بەشی ${c} لە یاسایەکی تردا بەکارهاتووە (${other}).`
          );
        }
        catalogOwner.set(c, id);
      }
      for (const p of products) {
        const other = productOwner.get(p);
        if (other) {
          return fail(
            `${f}.product_ids`,
            `المنتج ${p} مستخدم في قاعدة أخرى (${other}).`,
            `Product ${p} is already used by another rule (${other}).`,
            `بەرهەمی ${p} لە یاسایەکی تردا بەکارهاتووە (${other}).`
          );
        }
        productOwner.set(p, id);
      }
    }
    groups.push({ id, name: { ar, en, ckb }, enabled: raw.enabled, mode, fee_iqd: fee, block_size: block, catalog_ids: catalogs, product_ids: products });
  }
  if (productTotal > DELIVERY_PRODUCT_IDS_MAX || catalogTotal > DELIVERY_CATALOG_IDS_MAX) {
    return fail(
      'groups',
      `الحد الأقصى ${DELIVERY_PRODUCT_IDS_MAX} منتج و${DELIVERY_CATALOG_IDS_MAX} قسم في كل القواعد.`,
      `At most ${DELIVERY_PRODUCT_IDS_MAX} products and ${DELIVERY_CATALOG_IDS_MAX} sections across all rules.`,
      `زۆرترین ${DELIVERY_PRODUCT_IDS_MAX} بەرهەم و ${DELIVERY_CATALOG_IDS_MAX} بەش لە هەموو یاساکاندا.`
    );
  }
  return {
    ok: true,
    policy: {
      version: 1,
      default_fee_iqd: value.default_fee_iqd,
      governorates,
      groups,
      updated_at: typeof value.updated_at === 'string' ? value.updated_at : '',
      updated_by: typeof value.updated_by === 'string' ? value.updated_by : '',
    },
  };
}

/** Every catalog id and product id the policy names, for the existence check. */
export function deliveryPolicyTargets(policy: DeliveryPolicy): { catalog_ids: string[]; product_ids: string[] } {
  const c = new Set<string>();
  const p = new Set<string>();
  for (const g of policy.groups) {
    for (const id of g.catalog_ids) c.add(id);
    for (const id of g.product_ids) p.add(id);
  }
  return { catalog_ids: [...c], product_ids: [...p] };
}

export interface DeliveryLine {
  product_id: string;
  qty: number;
  /** Sections the line is filed under, NEAREST FIRST (sub-section, parents, section). */
  category_path?: string[];
  is_printer?: boolean;
  /**
   * Already resolved by the server (the cart's estimate): the group id, or
   * null for the default. When present, resolution is skipped.
   */
  rule_id?: string | null;
}

/**
 * THE GROUP THAT PRICES A LINE: the first enabled group naming the product,
 * else the first enabled group naming the nearest section on its path, else
 * — for a printer — the enabled printers group, else null (the default).
 * Product > sub-section > section > printer fact > default.
 */
export function resolveDeliveryGroup(
  item: Pick<DeliveryLine, 'product_id' | 'category_path' | 'is_printer'>,
  policy: DeliveryPolicy
): DeliveryRuleGroup | null {
  const groups = policy.groups.filter((g) => g.enabled);
  const byProduct = groups.find((g) => g.product_ids.includes(item.product_id));
  if (byProduct) return byProduct;
  for (const id of item.category_path ?? []) {
    const hit = groups.find((g) => g.catalog_ids.includes(id));
    if (hit) return hit;
  }
  if (item.is_printer === true) return groups.find((g) => g.id === PRINTER_DELIVERY_GROUP_ID) ?? null;
  return null;
}

/** What one group charges for `units` pieces in one order. */
export function groupChargeIqd(group: Pick<DeliveryRuleGroup, 'mode' | 'fee_iqd' | 'block_size'>, units: number): number {
  const n = Math.max(0, Math.trunc(units));
  if (n === 0) return 0;
  const fee = Math.max(0, Math.trunc(group.fee_iqd));
  switch (group.mode) {
    case 'flat':
      return fee;
    case 'per_piece':
      return fee * n;
    case 'per_block':
      return Math.ceil(n / Math.max(2, Math.trunc(group.block_size))) * fee;
    default:
      return 0;
  }
}

export interface DeliveryChargeComponent {
  kind: 'rule' | 'ordinary';
  /** The group id, or 'default'. */
  rule_id: string;
  mode: DeliveryMode;
  block_size: number;
  fee_per_step_iqd: number;
  units: number;
  product_ids: string[];
  fee_iqd: number;
  contains_printer: boolean;
  /** A rule component: its group's name in the three languages (the checkout's breakdown row). */
  rule_name?: DeliveryName;
  fee_source?: 'governorate' | 'default';
}

export interface DeliveryChargeResult {
  components: DeliveryChargeComponent[];
  total_iqd: number;
  governorate: string;
  governorate_rule: 'default' | 'price' | 'stopped';
  stopped_product_ids: string[];
  /** Where the default component's price came from; null when none was added. */
  fee_source: 'governorate' | 'default' | null;
}

/**
 * THE ORDER'S STANDARD DELIVERY under a policy. One component per group
 * present (its pieces pooled across lines), and the default flat component
 * ONLY when no group is present. A group priced 0 still counts as present.
 */
export function deliveryCharge(input: {
  parts: DeliveryLine[];
  policy: DeliveryPolicy;
  governorate?: string;
}): DeliveryChargeResult {
  const { policy } = input;
  const governorate = input.governorate ?? '';
  const gr = governorate ? policy.governorates[governorate] : undefined;
  const governorateRule: DeliveryChargeResult['governorate_rule'] = !gr ? 'default' : 'stopped' in gr ? 'stopped' : 'price';
  const enabled = new Map(policy.groups.filter((g) => g.enabled).map((g) => [g.id, g]));
  const pools = new Map<string, { group: DeliveryRuleGroup; units: number; products: string[]; printer: boolean }>();
  const stopped: string[] = [];
  const def = { units: 0, products: [] as string[], printer: false };
  for (const line of input.parts) {
    const qty = Math.max(0, Math.trunc(line.qty));
    if (qty === 0) continue;
    const group =
      line.rule_id !== undefined ? (line.rule_id === null ? null : enabled.get(line.rule_id) ?? null) : resolveDeliveryGroup(line, policy);
    if (!group) {
      def.units += qty;
      if (!def.products.includes(line.product_id)) def.products.push(line.product_id);
      def.printer ||= line.is_printer === true;
      continue;
    }
    if (group.mode === 'stopped') {
      if (!stopped.includes(line.product_id)) stopped.push(line.product_id);
      continue;
    }
    const pool = pools.get(group.id) ?? { group, units: 0, products: [], printer: false };
    pool.units += qty;
    if (!pool.products.includes(line.product_id)) pool.products.push(line.product_id);
    pool.printer ||= line.is_printer === true;
    pools.set(group.id, pool);
  }
  const components: DeliveryChargeComponent[] = [];
  let feeSource: DeliveryChargeResult['fee_source'] = null;
  if (governorateRule !== 'stopped') {
    for (const pool of pools.values()) {
      components.push({
        kind: 'rule',
        rule_id: pool.group.id,
        mode: pool.group.mode,
        block_size: pool.group.mode === 'per_block' ? pool.group.block_size : 1,
        fee_per_step_iqd: pool.group.fee_iqd,
        units: pool.units,
        product_ids: pool.products,
        fee_iqd: groupChargeIqd(pool.group, pool.units),
        contains_printer: pool.printer,
        rule_name: pool.group.name,
      });
    }
    if (def.units > 0 && pools.size === 0) {
      feeSource = gr && 'fee_iqd' in gr ? 'governorate' : 'default';
      const fee = gr && 'fee_iqd' in gr ? gr.fee_iqd : policy.default_fee_iqd;
      components.push({
        kind: 'ordinary',
        rule_id: 'default',
        mode: 'flat',
        block_size: 1,
        fee_per_step_iqd: fee,
        units: def.units,
        product_ids: def.products,
        fee_iqd: fee,
        contains_printer: def.printer,
        fee_source: feeSource,
      });
    }
  }
  return {
    components,
    total_iqd: components.reduce((n, c) => n + c.fee_iqd, 0),
    governorate,
    governorate_rule: governorateRule,
    stopped_product_ids: stopped,
    fee_source: feeSource,
  };
}

/** «1–10 → 5,000 · 11–20 → 10,000 · 21–30 → 15,000» style example for a group. */
export function groupChargeExample(group: Pick<DeliveryRuleGroup, 'mode' | 'fee_iqd' | 'block_size'>, steps = 3): Array<{ from: number; to: number; fee_iqd: number }> {
  if (group.mode === 'stopped') return [];
  if (group.mode === 'flat') return [{ from: 1, to: Infinity, fee_iqd: groupChargeIqd(group, 1) }];
  const size = group.mode === 'per_block' ? Math.max(2, group.block_size) : 1;
  const out: Array<{ from: number; to: number; fee_iqd: number }> = [];
  for (let i = 0; i < steps; i += 1) {
    const to = size * (i + 1);
    out.push({ from: size * i + 1, to, fee_iqd: groupChargeIqd(group, to) });
  }
  return out;
}

const iqd = (n: number) => Math.trunc(n).toLocaleString('en-US');

/** How a group (or the default, for null) charges, in the three languages. */
export function deliveryGroupSummary(group: DeliveryRuleGroup | null, policy: Pick<DeliveryPolicy, 'default_fee_iqd'>): DeliveryName {
  if (!group) {
    const f = iqd(policy.default_fee_iqd);
    return {
      ar: `السعر الافتراضي — ${f} د.ع للطلب`,
      en: `Default price — ${f} IQD per order`,
      ckb: `نرخی بنەڕەت — ${f} دینار بۆ هەر داواکارییەک`,
    };
  }
  const f = iqd(group.fee_iqd);
  const n = group.name;
  switch (group.mode) {
    case 'flat':
      return { ar: `${n.ar} — ${f} د.ع للطلب`, en: `${n.en} — ${f} IQD per order`, ckb: `${n.ckb} — ${f} دینار بۆ هەر داواکارییەک` };
    case 'per_piece':
      return { ar: `${n.ar} — ${f} د.ع لكل قطعة`, en: `${n.en} — ${f} IQD per piece`, ckb: `${n.ckb} — ${f} دینار بۆ هەر پارچەیەک` };
    case 'per_block':
      return {
        ar: `${n.ar} — ${f} د.ع لكل ${group.block_size} قطع`,
        en: `${n.en} — ${f} IQD per ${group.block_size} pieces`,
        ckb: `${n.ckb} — ${f} دینار بۆ هەر ${group.block_size} پارچە`,
      };
    default:
      return { ar: `${n.ar} — لا يُوصَّل`, en: `${n.en} — not delivered`, ckb: `${n.ckb} — ناگەیەنرێت` };
  }
}
