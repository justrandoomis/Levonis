/**
 * Admin TXT template pipeline routes (mandate §6) — mounted at
 * /api/admin/template. Deterministic parse/export only; NO AI anywhere.
 *
 *   GET  /blank              blank template download (text/plain attachment)
 *   GET  /example            filled, valid EXAMPLE template (draft only)
 *   GET  /export/:productId  full product export (all languages, attachment)
 *   POST /parse              dry-run: preview + diff + errors — NO writes
 *   POST /apply              re-parses server-side and persists (create=draft)
 *   POST /parse-zip          multipart ZIP of .txt templates, per-file results
 *
 * Apply never trusts a client-prebuilt document: the template text is parsed
 * and validated server-side on every call. Unknown brand/catalog references
 * block the write with needs_review — never silent creation or drop.
 *
 * §6.1 download contract (iPad Safari): the two GET downloads answer with
 * `text/plain; charset=utf-8`, an explicit `Content-Disposition: attachment`
 * carrying BOTH a sanitized ASCII `filename=` and an RFC 5987 `filename*=`,
 * a real `Content-Length`, and `X-Content-Type-Options: nosniff`, so WebKit
 * saves a file instead of rendering the text inline. Errors on these routes
 * stay JSON (worker/index.ts onError) so the client can tell a failed
 * download from a successful one instead of saving an error page as .txt.
 *
 * §6.1 round-trip contract: whatever /blank and /example serve must parse
 * with ZERO errors — `buildBlankTemplate()` proves it before serving (see
 * `templateDownloadDiagnostics()` and tests/templateDownload.test.ts).
 *
 * §6.1 confirm-once contract: /apply claims a content fingerprint immediately
 * before the write, so a double-submitted batch (double click, retry after a
 * timed-out response, the same file twice in one ZIP) resolves to ONE write.
 */

import { Hono, type Context } from 'hono';
import { unzipSync } from 'fflate';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, notFound, oneOf, str, HttpError } from '../lib/http';
import { applyRelations, loadRelationsView, EMPTY_RELATIONS, type ProductRelationsView } from '../lib/productOverlay';
import { relationsBodyFromDoc, deriveInventoryModeFromDoc, type BridgeDiagnostics } from '../lib/templateRelations';
import {
  planProductSave,
  saveProductAtomic,
  reloadForVerification,
  verifyApplied,
  relationCounts,
  translationInputsOf,
  type Mismatch,
  type ProductSavePlan,
} from '../lib/productPersistence';
import { resolveTemplateFamilies, type CatalogRow } from './adminTaxonomy';
import { canViewFinancials, projectForAdmin } from '../lib/adminScope';
import { getSetting } from '../lib/settings';
import { rateLimit } from '../lib/ratelimit';
import { newId, sha256Hex } from '../lib/crypto';
import { audit } from '../lib/audit';
import {
  parseTemplate,
  exportProduct,
  generateBlankTemplate,
  toDocBody,
  touchesPricingStructure,
  docToEntries,
  translationBookkeeping,
  deriveSlug,
  NULL_TOKEN,
  TEMPLATE_VERSION,
  type ParsedTemplate,
  type ResolvedRefs,
  type TemplateError,
  type ToDocResult,
} from '../lib/template';
import { normalizeCheapestBase } from '../lib/cheapestBase';
import { applyPrinterWarrantyRules } from '../lib/warrantyPlans';
import {
  parseProductRow,
  validateProductDoc,
  projectAdmin,
  type ProductDoc,
} from '../lib/productModel';
import {
  PRODUCT_TYPES,
  groupsForType,
  groupsForSection,
  type SectionRef,
  flatFields,
  isProductType,
  isTemplateFamily,
  productType,
  type ProductTypeId,
  type TemplateField,
} from '../lib/templateFamilies';
import {
  MEMBERSHIP_CAP_SCOPES,
  MEMBERSHIP_COLUMNS,
  MEMBERSHIP_FIELDS,
  MEMBERSHIP_MAX_IQD,
  MEMBERSHIP_MAX_PERCENT,
  MEMBERSHIP_MAX_QUANTITY,
  MEMBERSHIP_MIN_PERCENT,
  MEMBERSHIP_MODES,
  MEMBERSHIP_NULL,
  MEMBERSHIP_PREFIX,
  MEMBERSHIP_TIERS,
  membershipRuleFromCells,
  type MembershipCells,
  type MembershipRuleValues,
  type ParsedMembershipRule,
  type RowIssue,
} from '../lib/importCsv';
import { applyMembershipRules } from './adminImport';

export const templateRoutes = new Hono<AppContext>();
templateRoutes.use('*', requireAdmin);

const MAX_TEMPLATE_CHARS = 1_500_000;
const MAX_ZIP_BYTES = 15 * 1024 * 1024;
const MAX_ZIP_FILES = 100;

// ------------------------------------------------------- download helpers

/**
 * `Content-Disposition: attachment` with an ASCII-sanitized `filename=` AND
 * an RFC 5987 `filename*=`. iOS/iPadOS Safari picks the ASCII form; keeping
 * both means a non-ASCII product name can never produce a header the browser
 * silently ignores (which is how a download turns into an inline render).
 * The sanitizer also strips CR/LF and quotes, so a product id can never
 * inject a response header.
 */
export function contentDisposition(filename: string): string {
  const ascii = (filename.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'template').slice(0, 120);
  const safeAscii = ascii.toLowerCase().endsWith('.txt') ? ascii : `${ascii}.txt`;
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Text attachment response. Encodes to bytes first so `Content-Length` is the
 * real UTF-8 byte length (Arabic content is multi-byte): Safari uses it to
 * commit the transfer to a file instead of streaming it into a tab.
 */
function attachment(text: string, filename: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': contentDisposition(filename),
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Template-Version': String(TEMPLATE_VERSION),
    },
  });
}

// --------------------------------------------- blank / example templates

interface DisabledLine {
  line: number;
  content: string;
  reason: string;
}

/**
 * Comments out any line the parser rejects, so the file we hand an admin
 * always parses with zero errors (mandate §6.1: the importer must accept
 * exactly what the download serves). Nothing is deleted — the key, its type
 * comment and its notes stay in the file, only the `key=` line is disabled
 * and annotated with the parser's own reason.
 *
 * Line-based and idempotent: re-parsing after each pass catches lines whose
 * error only appears once an earlier line is gone.
 */
function disableUnparsableLines(text: string): { text: string; disabled: DisabledLine[] } {
  let current = text;
  const disabled: DisabledLine[] = [];
  for (let pass = 0; pass < 6; pass++) {
    const parsed = parseTemplate(current);
    if (parsed.errors.length === 0) break;
    const lines = current.split('\n');
    let changed = false;
    for (const e of parsed.errors) {
      const idx = e.line - 1;
      if (idx < 0 || idx >= lines.length) continue;
      const content = lines[idx].trim();
      if (content === '' || content.startsWith('#')) continue;
      lines[idx] = `# ${content}   ⟵ املأ قيمة صالحة ثم احذف # / fill a valid value, then uncomment — ${e.message}`;
      disabled.push({ line: e.line, content, reason: e.message });
      changed = true;
    }
    if (!changed) break;
    current = lines.join('\n');
  }
  return { text: current, disabled };
}

/* -------------------- §18: the product-scoped membership discount, in TXT */

/**
 * SIX KEYS PER MEMBER TIER, SPELT EXACTLY AS THE CSV SHEET SPELLS THEM.
 *
 * `membership.pro.percent`, `membership.premium.cap_scope`, … — the same
 * names, the same accepted values and the same refusals as the spreadsheet
 * columns, because the two are imported from `worker/lib/importCsv.ts` rather
 * than written down twice. An admin who has filled one file already knows
 * this one, and a rule the CSV accepts can never be a rule the .txt refuses.
 *
 * WHY THESE KEYS ARE NOT IN THE FIELD REGISTRY. A membership discount is a row
 * in `membership_benefit_rules`, not a field of a product: it carries a tier,
 * a scope, a date window, a version history and an audit trail of its own, and
 * it must be written through `saveBenefitRule` so those go with it. Merging it
 * into the ProductDoc would make it a product column that the checkout does
 * not read and the benefit engine does not see. So the lines are lifted out of
 * the file BEFORE the product parser runs — replaced with blanks, which keeps
 * every other line's number truthful — and applied beside the product.
 *
 * THE THREE STATES ARE THE SHEET'S THREE STATES (docs/TXT_IMPORT_PARITY.md):
 * a key that is absent or empty changes nothing, values create or update the
 * tier's product rule, and `discount_mode=__NULL__` removes it. An export
 * therefore writes the keys EMPTY for a tier that has no rule — never
 * `__NULL__`, which would turn a re-import of an old file into a deletion.
 */
const MEMBERSHIP_KEYS = new Set<string>(MEMBERSHIP_COLUMNS);
const MEMBERSHIP_LINE_RE = /^([A-Za-z0-9_.]+)\s*=(.*)$/;

interface MembershipTemplate {
  /** The template with the membership lines blanked out — same line numbers. */
  text: string;
  rules: ParsedMembershipRule[];
  errors: TemplateError[];
}

function extractMembership(text: string): MembershipTemplate {
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
  const out = lines.slice();
  const seen = new Map<string, { value: string; line: number }>();
  const errors: TemplateError[] = [];

  let i = 0;
  while (i < lines.length) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();
    i++;
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = MEMBERSHIP_LINE_RE.exec(trimmed);
    if (!m) continue;
    const value = m[2].trim();
    // A heredoc BODY is verbatim text — somebody's Arabic description may
    // contain a line that looks like a key. Skipped wholesale, exactly as
    // `parseTemplate` skips it, so a description can never set a price.
    if (value.startsWith('<<<')) {
      const token = value.slice(3).trim() || 'END';
      while (i < lines.length && lines[i].trim() !== token) i++;
      i++;
      continue;
    }
    if (!MEMBERSHIP_KEYS.has(m[1])) continue;
    // Blanked, not deleted: the product parser must still count lines the way
    // the admin's editor does, or every error below this point points at the
    // wrong row. A DUPLICATE is blanked too — it is reported here, and leaving
    // it in the text would hand `parseTemplate` a key it does not know and the
    // admin a second, misleading "unknown key" complaint about the same line.
    out[lineNo - 1] = '';
    if (seen.has(m[1])) {
      errors.push({ line: lineNo, key: m[1], message: 'duplicate key' });
      continue;
    }
    seen.set(m[1], { value, line: lineNo });
  }

  const issues: RowIssue[] = [];
  const rules: ParsedMembershipRule[] = [];
  for (const t of MEMBERSHIP_TIERS) {
    const at = (f: string) => `${MEMBERSHIP_PREFIX}${t.key}.${f}`;
    const present = MEMBERSHIP_FIELDS.filter((f) => seen.has(at(f)));
    if (present.length === 0) continue;
    const raw = Object.fromEntries(
      MEMBERSHIP_FIELDS.map((f) => [f, seen.get(at(f))?.value ?? ''])
    ) as MembershipCells;
    const rule = membershipRuleFromCells(t, raw, seen.get(at(present[0]))!.line, issues);
    if (rule) rules.push(rule);
  }
  for (const issue of issues) {
    errors.push({ line: issue.line, key: issue.message.split(':')[0], message: issue.message });
  }

  return { text: out.join('\n'), rules, errors };
}

/** `null` writes an EMPTY value, which the importer reads as "no change". */
const membershipValue = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));

/**
 * The membership block of an export, and of the two downloads.
 *
 * `commented` ships the keys as documentation on the blank template and the
 * example, where filling them in would mean the file carried a commercial
 * value nobody typed. A real export writes them live, with the product's own
 * rules — or empty, when it has none.
 */
function membershipLines(rules: readonly MembershipRuleValues[], commented = false): string[] {
  const hash = commented ? '# ' : '';
  const out = [
    '',
    '# ------------------------------ خصم العضوية لهذا المنتج / membership discount',
    '# قاعدة خصم واحدة مربوطة بهذا المنتج وحده لكل فئة عضوية، وهي تتقدّم على قاعدة',
    '# القسم وعلى القاعدة العامة (docs/MEMBERSHIP_BENEFITS.md §1).',
    `#   المفتاح الغائب أو الفارغ  = لا تغيير على القاعدة المحفوظة`,
    `#   discount_mode=${MEMBERSHIP_NULL}   = احذف قواعد هذه الفئة كلها (الحذف يُقال صراحةً)`,
    `#   discount_mode: ${MEMBERSHIP_MODES.join(' / ')}   ·   percent: ٪ ${MEMBERSHIP_MIN_PERCENT}..${MEMBERSHIP_MAX_PERCENT}   ·   fixed_iqd و max_discount_iqd: د.ع 0..${MEMBERSHIP_MAX_IQD.toLocaleString('en-US')}`,
    `#   cap_scope: ${MEMBERSHIP_CAP_SCOPES.join(' / ')} (السقف لكل قطعة أم لكل طلب)   ·   max_quantity: عدد قطع (1..${MEMBERSHIP_MAX_QUANTITY})`,
    '# التواريخ والأولوية والتفعيل والاسم والملاحظة تبقى كما ضُبطت في لوحة الإدارة.',
  ];
  for (const t of MEMBERSHIP_TIERS) {
    const rule = rules.find((r) => r.tier === t.tier);
    const at = (f: string) => `${hash}${MEMBERSHIP_PREFIX}${t.key}.${f}`;
    out.push(
      `${at('discount_mode')}=${rule?.discount_mode ?? ''}`,
      `${at('percent')}=${membershipValue(rule?.percent)}`,
      `${at('fixed_iqd')}=${membershipValue(rule?.fixed_iqd)}`,
      `${at('max_discount_iqd')}=${membershipValue(rule?.max_discount_iqd)}`,
      `${at('cap_scope')}=${rule?.cap_scope ?? ''}`,
      `${at('max_quantity')}=${membershipValue(rule?.max_quantity)}`
    );
  }
  return out;
}

/** The product-scoped rules a product has now, in the panel's own order. */
async function loadMembershipRules(db: D1Database, productId: string): Promise<MembershipRuleValues[]> {
  const { results } = await db
    .prepare(
      `SELECT tier, discount_mode, percent, fixed_iqd, max_discount_iqd, cap_scope, max_quantity
         FROM membership_benefit_rules
        WHERE benefit_type = 'product_discount' AND scope = 'product' AND product_id = ?
        ORDER BY priority DESC, id`
    )
    .bind(productId)
    .all<Record<string, unknown>>();
  const out: MembershipRuleValues[] = [];
  for (const r of results ?? []) {
    if (r.tier !== 'pro' && r.tier !== 'prime') continue;
    if (out.some((x) => x.tier === r.tier)) continue;
    const n = (v: unknown) => (typeof v === 'number' ? v : null);
    out.push({
      tier: r.tier,
      discount_mode: r.discount_mode === 'percent' || r.discount_mode === 'fixed' ? r.discount_mode : null,
      percent: n(r.percent),
      fixed_iqd: n(r.fixed_iqd),
      max_discount_iqd: n(r.max_discount_iqd),
      cap_scope: r.cap_scope === 'per_unit' || r.cap_scope === 'per_order' ? r.cap_scope : null,
      max_quantity: n(r.max_quantity),
    });
  }
  return out;
}

const GROUP_ITEM_LINE_RE = /^([a-z_]+)\.(\d+)\./;

/**
 * The rich blank template, made importable.
 *
 * Two problems are fixed here without touching the field registry:
 *  1. Repeated-group sample items (`options.1.*`, `images.1.*`, …) ship
 *     COMMENTED. Every key, type note and required marker stays in the file,
 *     but an untouched blank no longer carries an empty option / image /
 *     warranty item that blocks the import with "name_ar is required".
 *     Uncomment only the items you actually fill in.
 *  2. Required scalars whose blank value is not parseable (`price_iqd=`,
 *     `display_order=`) are commented with the parser's own reason instead of
 *     being served as four guaranteed parse errors.
 */
export function buildBlankTemplate(): { text: string; disabled: DisabledLine[]; groupsDisabled: string[] } {
  const out: string[] = [];
  const groupsDisabled: string[] = [];
  let currentGroup = '';
  for (const raw of generateBlankTemplate().split('\n')) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      out.push(raw);
      continue;
    }
    const gm = GROUP_ITEM_LINE_RE.exec(trimmed);
    if (!gm) {
      out.push(raw);
      continue;
    }
    if (gm[1] !== currentGroup) {
      currentGroup = gm[1];
      groupsDisabled.push(currentGroup);
      out.push(
        `# ▼ المجموعة المتكررة "${currentGroup}" معطّلة افتراضياً — احذف علامة # من أسطر العنصر الذي تملؤه فقط.`,
        `#   Repeated group "${currentGroup}" ships DISABLED: uncomment only the lines of an item you actually fill.`,
        `#   عنصر مفعّل بحقول مطلوبة فارغة يوقف الاستيراد كله؛ اترك ما لا تحتاجه معطّلاً.`
      );
    }
    out.push(`# ${trimmed}`);
  }
  // §18 — the membership keys are not in the field registry (they describe a
  // benefit rule, not a product), so the generator cannot emit them. They ship
  // COMMENTED and EMPTY: the shape is taught, and no commercial value the
  // owner never typed is hidden in a downloaded file.
  const healed = disableUnparsableLines([...out, ...membershipLines([], true)].join('\n'));
  return { text: healed.text, disabled: healed.disabled, groupsDisabled };
}

/**
 * A filled, valid example (mandate §6.1: "مثال صالح واضح لا يُنشر كمنتج
 * حقيقي تلقائيًا"). It demonstrates heredocs, per-field null inheritance,
 * option/colour linking (`option_id` and the import-only `option_index`),
 * spec rows, labels, a warranty plan and a content block.
 *
 * It carries NO brand/catalog reference (nothing to resolve) and NO image
 * URL — an example must never create a product with a broken image. Applying
 * it creates a DRAFT: `POST /apply` forces `status=draft` on every create,
 * and the name says so in three languages.
 */
const EXAMPLE_TEMPLATE = `# ============================================================
# مثال قالب ليفونيس — منتج نموذجي صالح للمعاينة
# Levonis product template — filled EXAMPLE (valid, ready to preview)
# ============================================================
# تطبيق هذا الملف يُنشئ **مسودة** فقط ولا يُنشر أبداً كمنتج حقيقي تلقائياً.
# Applying this file creates a DRAFT only; template creation never publishes.
# استبدل كل القيم بقيمك الحقيقية قبل النشر، أو احذف المسودة بعد التجربة.

template_version=${TEMPLATE_VERSION}
# لا يوجد product_id: هذا إنشاء جديد. أضف product_id لتحديث منتج قائم.
slug=levonis-template-example

# ------------------------------ الهوية / identity
name_ar=منتج مثال للقالب — لا تنشره
name_en=Levonis template example — do not publish
name_ckb=نموونەی قاڵب — بڵاوی مەکەوە
status=draft

# ------------------------------ الوصف / description
description_ar=<<<END
هذا وصف عربي متعدد الأسطر مكتوب داخل كتلة heredoc.
كل سطر يُحفظ حرفياً كما هو، بما في ذلك الأسطر الفارغة.
END
description_en=A multi-line English description written with a heredoc block.
description_ckb=
how_to_use=مثال مختصر على طريقة الاستخدام.

# ------------------------------ التسعير / pricing (أعداد صحيحة بالدينار)
price_iqd=100000
# __NULL__ = لا سعر PRO صريح (سياسة المتجر تطبق؛ الافتراضي: لا خصم مُختلق)
pro_price_iqd=__NULL__
original_price_iqd=125000
# الكلفة داخلية ولا تُنشر أبداً للزبون
product_cost_iqd=__NULL__

# ------------------------------ خصم العضوية لهذا المنتج / membership discount
# ستة مفاتيح لكل فئة عضوية تصف قاعدة خصم واحدة مربوطة بهذا المنتج وحده، وهي
# تتقدّم على قاعدة القسم وعلى القاعدة العامة (docs/MEMBERSHIP_BENEFITS.md §1).
# كلها اختيارية، ومعطّلة هنا عمداً: المثال يعلّم الشكل ولا يحمل رقماً تجارياً
# لم يكتبه المالك. احذف علامة # واكتب القيم لتفعيل القاعدة.
#   المفتاح الغائب أو الفارغ = لا تغيير على القاعدة المحفوظة
#   discount_mode=__NULL__   = احذف قاعدة هذه الفئة
#   discount_mode: percent / fixed  ·  percent: ٪ 1..100  ·  fixed_iqd و max_discount_iqd: د.ع
#   cap_scope: per_unit / per_order  ·  max_quantity: عدد قطع (1 فأكثر)
# membership.pro.discount_mode=
# membership.pro.percent=
# membership.pro.fixed_iqd=
# membership.pro.max_discount_iqd=
# membership.pro.cap_scope=
# membership.pro.max_quantity=
# membership.premium.discount_mode=
# membership.premium.percent=
# membership.premium.fixed_iqd=
# membership.premium.max_discount_iqd=
# membership.premium.cap_scope=
# membership.premium.max_quantity=

# ------------------------------ التصنيف / classification
# لا علامة ولا كتالوج في المثال: أي قيمة غير موجودة توقف الاستيراد للمراجعة
brand=__NULL__
catalogs=
hashtags=مثال,example
is_featured=false
display_order=0

# ------------------------------ البيع والمخزون / selling & stock
selling_type=direct_sale
stock=5
payment_options=

# ------------------------------ الوسائط / media
# معطّلة عمداً: ضع رابطاً حقيقياً (/files/<key> أو https://…) قبل التفعيل،
# فالمثال يجب ألا يُنشئ منتجاً بصورة مكسورة.
# images.1.id=img_example_1
# images.1.url=
# images.1.primary=true
# images.1.alt_ar=صورة المنتج

# ------------------------------ الخيارات / options
# السعر الأساسي (100000) هو الأرخص؛ كل خيار زيادة فوقه. التوفر حسب المنتج:
# اترك availability_type فارغًا، فالبيع المباشر/الطلب المسبق يُسعَّر بزيادات
# المنتج (direct_surcharge_iqd وطرق الشحن) لا بخيارات منفصلة.
options.1.id=opt_example_small
options.1.name_ar=المقاس الصغير
options.1.name_en=Small
options.1.active=true
# __NULL__ = نفس السعر الأساسي (لا يساوي صفراً)
options.1.regular_price_iqd=__NULL__
options.1.availability_type=
options.2.id=opt_example_large
options.2.name_ar=المقاس الكبير
options.2.name_en=Large
options.2.active=true
# +20000 = زيادة عشرين ألفًا فوق السعر الأساسي (تُخزَّن في regular_adjust_iqd)
options.2.regular_price_iqd=+20000
options.2.availability_type=

# ------------------------------ الألوان / colors
# اللون زيادة فوق سعر الخيار المختار (لون ← خيار ← أساسي)
colors.1.id=col_example_black
colors.1.name_ar=أسود
colors.1.name_en=Black
colors.1.hex=#111111
# __NULL__ = متاح لكل الخيارات
colors.1.option_id=__NULL__
colors.1.active=true
colors.2.id=col_example_gold
colors.2.name_ar=ذهبي
colors.2.name_en=Gold
colors.2.hex=#D4AF37
# option_index بديل استيراد فقط: يربط اللون بالخيار options.2
colors.2.option_index=2
# +15000 فوق سعر الخيار الكبير (120000) = 135000 للزبون
colors.2.regular_price_iqd=+15000
colors.2.active=true

# ------------------------------ المواصفات / specifications
spec_groups.1.id=sg_example_general
spec_groups.1.title_ar=عام
spec_groups.1.title_en=General
spec_groups.1.rows.1.id=sr_example_weight
spec_groups.1.rows.1.label_ar=الوزن
spec_groups.1.rows.1.label_en=Weight
spec_groups.1.rows.1.value_ar=1.2
spec_groups.1.rows.1.value_en=1.2
spec_groups.1.rows.1.unit=kg

# ------------------------------ الشارات / labels
labels.1.id=lbl_example_warranty
labels.1.key=warranty_included
labels.1.text_ar=ضمان سنة
labels.1.text_en=1-year warranty
labels.1.visible=true

# ------------------------------ الضمان الممدد / extended warranty — للطابعات فقط
# هذا المثال ليس في كتالوج طابعات، فخطط الضمان الممدد محذوفة منه: سطر warranty_plans
# على منتج ليس طابعة يُرفض (WARRANTY_NOT_PRINTER). لطابعة: الأساسي 12 شهرًا من
# التسليم (warranty_base_months=12، serialized=true) وخطتان تمديد فقط، رسم كل منهما
# نسبة من سعر الطابعة الاعتيادي (fee_percent مثل 7.5 أو 10) تُقرَّب إلى دينار صحيح
# ولا تُعفى بالعضوية. المثال الكامل: docs/examples/bambu-a1.txt
# warranty_base_months=12
# serialized=true
# warranty_plans.1.id=wp_ext12
# warranty_plans.1.title_en=Extended warranty +12 months (24 months total)
# warranty_plans.1.duration_months=12
# warranty_plans.1.duration_kind=extension
# warranty_plans.1.fee_percent=7.5
# warranty_plans.1.fee_iqd=0
# warranty_plans.1.active=true
# warranty_plans.2.id=wp_ext24
# warranty_plans.2.title_en=Extended warranty +24 months (36 months total)
# warranty_plans.2.duration_months=24
# warranty_plans.2.duration_kind=extension
# warranty_plans.2.fee_percent=10
# warranty_plans.2.fee_iqd=0
# warranty_plans.2.active=true

# ------------------------------ كتل المحتوى / content blocks
content_blocks.1.id=cb_example_text
content_blocks.1.kind=text
content_blocks.1.body_ar=<<<END
كتلة محتوى نصية تظهر أسفل صفحة المنتج.
END
content_blocks.1.caption_ar=مثال

# ------------------------------ دليل التركيب والاستخدام / setup & usage guide
usage_official_url=
usage_steps.1.id=ustep_example_unbox
usage_steps.1.kind=setup
usage_steps.1.title=فك التغليف
usage_steps.1.body=أخرج الجهاز وأزل أشرطة التثبيت قبل التشغيل.
usage_steps.1.images=
usage_steps.1.video_url=
usage_steps.1.link_url=
`;

export function buildExampleTemplate(): string {
  return EXAMPLE_TEMPLATE;
}

/** Parse-level diagnostics for both downloads — pinned by
 *  tests/templateDownload.test.ts so a registry change can never quietly
 *  reintroduce a template the importer rejects. */
export function templateDownloadDiagnostics(): {
  blank: { errors: number; unknown_keys: string[]; disabled: DisabledLine[]; groupsDisabled: string[] };
  example: { errors: number; unknown_keys: string[] };
  /** Same check, once per product type, for the `?type=` scaffold. */
  typed: Array<{ type: string; errors: number; unknown_keys: string[] }>;
} {
  const blank = buildBlankTemplate();
  const blankParsed = parseTemplate(blank.text);
  const exampleParsed = parseTemplate(buildExampleTemplate());
  return {
    blank: {
      errors: blankParsed.errors.length,
      unknown_keys: blankParsed.unknown_keys,
      disabled: blank.disabled,
      groupsDisabled: blank.groupsDisabled,
    },
    example: { errors: exampleParsed.errors.length, unknown_keys: exampleParsed.unknown_keys },
    typed: PRODUCT_TYPES.map((t) => {
      const parsed = parseTemplate(`${blank.text}\n${typeSpecScaffold(t.id).join('\n')}`);
      return { type: t.id, errors: parsed.errors.length, unknown_keys: parsed.unknown_keys };
    }),
  };
}

// ---------------------------------------------------------------- helpers

/**
 * THE PRODUCT AS IT ACTUALLY IS, NOT AS ITS JSON COLUMNS REMEMBER IT.
 *
 * This read `products` alone. Every product built in the current admin form
 * keeps its options, colours and images in the relational tables instead — the
 * relations PUT writes them there and never mirrors them back into
 * `products.options` — so exporting one produced a file with the base fields
 * and NOTHING else.
 *
 * Measured on a product with two priced options (each with its own cost), a
 * colour and an image: the exported .txt carried 24 keys, of which
 * `options.*` = 0, `colors.*` = 0, `images.*` = 0 and option costs = 0. That is
 * the owner's report — «حقول فارغة أو قليلة»، «الخيارات غير متضمنة»،
 * «صور لا توجد»، «التكلفة» — as one defect, not four.
 *
 * `applyRelations` is the same overlay the storefront, the cart, the quote and
 * the price grid already read through, so the export now shows what the
 * customer is actually sold rather than a stale JSON mirror. It is a no-op for
 * a product that has no relational rows, which is why the old products still
 * export exactly as before.
 */
/**
 * The same read, keeping the relational view the caller needs to write back.
 *
 * `includeInactive` is what separates the admin view from the shop's: an
 * option the owner switched off must appear in the .txt with `active=false`,
 * or «ويفعل الخيارات» — turn the options back on by editing the file — is
 * impossible, and re-applying the file would delete every disabled row.
 */
async function loadProductDocWithView(
  db: D1Database,
  id: string
): Promise<{ doc: ProductDoc; view: ProductRelationsView; row: Record<string, unknown> } | null> {
  const row = await db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!row) return null;
  const doc = parseProductRow(row);
  const view = await loadRelationsView(db, id, row.inventory_mode);
  return { doc: applyRelations(doc, view, { includeInactive: true, authoredNames: true }), view, row };
}

/** The template groups whose rows live in the relation tables. */
const STRUCTURE_GROUPS = ['options', 'colors', 'images'] as const;

/** Does this file WRITE structure — items or a whole-group clear? */
function touchesStructure(parsed: ParsedTemplate): boolean {
  return STRUCTURE_GROUPS.some((g) => (parsed.groups[g]?.length ?? 0) > 0 || !!parsed.groupClears[g]);
}

/** Resolves brand/catalog slug-or-id references against the DB. Unknown
 *  values become needs_review entries — the change is withheld entirely
 *  (no partial catalog list, no silently created brand). */
async function resolveRefs(db: D1Database, parsed: ParsedTemplate): Promise<ResolvedRefs> {
  const refs: ResolvedRefs = { needs_review: [] };

  const brandField = parsed.fields.brand;
  if (brandField) {
    const v = brandField.clear || brandField.value === null ? '' : String(brandField.value).trim();
    if (!v) {
      refs.brand_id = null;
    } else {
      const row = await db.prepare('SELECT id FROM brands WHERE slug = ? OR id = ?').bind(v, v).first<{ id: string }>();
      if (row) refs.brand_id = row.id;
      else refs.needs_review!.push({
        key: 'brand', line: brandField.line, value: v,
        message: `unknown brand "${v}" — create the brand first or fix the slug/id (brands are never silently created)`,
      });
    }
  }

  // The main section and the sub-section are single references into the SAME
  // catalogs tree the `catalogs` list draws from — resolved by slug or id, and
  // never silently created, exactly like the brand above.
  for (const [key, target] of [
    ['category', 'category_id'],
    ['sub_category', 'sub_category_id'],
  ] as const) {
    const field = parsed.fields[key];
    if (!field) continue;
    const v = field.clear || field.value === null ? '' : String(field.value).trim();
    if (!v) {
      refs[target] = null;
      continue;
    }
    const row = await db.prepare('SELECT id FROM catalogs WHERE slug = ? OR id = ?').bind(v, v).first<{ id: string }>();
    if (row) refs[target] = row.id;
    else
      refs.needs_review!.push({
        key,
        line: field.line,
        value: v,
        message: `unknown section "${v}" — create it in التصنيفات first, or fix the slug/id (sections are never silently created)`,
      });
  }

  const catField = parsed.fields.catalogs;
  if (catField) {
    const wanted = catField.clear || catField.value === null ? [] : (catField.value as string[]);
    if (wanted.length === 0) {
      refs.catalog_ids = [];
    } else {
      const ids: string[] = [];
      let allResolved = true;
      for (const w of wanted) {
        const row = await db.prepare('SELECT id FROM catalogs WHERE slug = ? OR id = ?').bind(w, w).first<{ id: string }>();
        if (row) {
          ids.push(row.id);
        } else {
          allResolved = false;
          refs.needs_review!.push({
            key: 'catalogs', line: catField.line, value: w,
            message: `unknown catalog "${w}" — create the catalog first or fix the slug/id (never silently created or dropped)`,
          });
        }
      }
      if (allResolved) refs.catalog_ids = [...new Set(ids)];
    }
  }
  return refs;
}

/**
 * THE SPEC SHEET, CHECKED AGAINST THE SECTION THE FORM WILL RENDER.
 *
 * `spec.<id>` accepted any id and stored it; the form shows only the ids of
 * the section's template (`GET /taxonomy/templates?category=`), so a value
 * outside that list was stored and invisible — and a select value the sheet
 * does not offer was stored as typed (docs/TXT_IMPORT_PARITY.md, root cause
 * 9). Nothing is dropped here: every finding is a warning and a name in
 * `outside_section`, so the owner sees it at check time and after apply.
 */
export interface SpecSheetReport {
  stored: number;
  visible_in_form: number;
  outside_section: string[];
  family: string | null;
  warnings: string[];
}

async function specSheetReport(db: D1Database, doc: ProductDoc, parsed: ParsedTemplate): Promise<SpecSheetReport> {
  const ids = Object.keys(doc.spec_fields);
  const report: SpecSheetReport = { stored: ids.length, visible_in_form: 0, outside_section: [], family: null, warnings: [] };
  const fileIds = new Set(Object.keys(parsed.specFields));
  const sectionId = doc.sub_category_id || doc.category_id;
  let fields: TemplateField[] = [];
  if (sectionId) {
    const { results } = await db.prepare('SELECT * FROM catalogs').all<CatalogRow>();
    const byId = new Map(results.map((r) => [r.id, r]));
    const family = resolveTemplateFamilies(results).get(sectionId) ?? doc.template_family;
    if (family && isTemplateFamily(family)) {
      report.family = family;
      // Leaf first, ids alongside slugs: `groupsForSection` narrows an FDM
      // printer to the FDM group, and it can only do that if it is told which
      // leaf the product is actually filed in.
      const branch: SectionRef[] = [];
      let cursor = byId.get(sectionId);
      for (let i = 0; i < 20 && cursor; i++) {
        branch.push({ id: cursor.id, slug: cursor.slug });
        cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
      }
      fields = flatFields(groupsForSection(family, branch));
    }
  }
  const known = new Map(fields.map((f) => [f.id, f]));
  for (const id of ids) {
    const f = known.get(id);
    if (!f) {
      report.outside_section.push(id);
      if (fileIds.has(id)) {
        report.warnings.push(
          sectionId && report.family
            ? `spec.${id}: ليس من حقول قسم هذا المنتج — حُفظ لكنه لا يظهر في قسم المواصفات بالنموذج / not a field of this product's section; stored but not shown in the form's spec section`
            : `spec.${id}: المنتج بلا قسم/عائلة قالب، فلا يظهر في قسم المواصفات بالنموذج / the product has no section or template family; stored but not shown in the form's spec section`
        );
      }
      continue;
    }
    report.visible_in_form += 1;
    if (!fileIds.has(id)) continue;
    const v = doc.spec_fields[id];
    if (f.options && f.options.length && !f.options.some((o) => o.toLowerCase() === v.toLowerCase())) {
      report.warnings.push(`spec.${id}: "${v}" ليست من القيم المتاحة (${f.options.join(' / ')}) — حُفظت كما كُتبت / not one of the offered values; stored as written`);
    } else if (f.type === 'number' && !/^-?\d+(\.\d+)?$/.test(v.trim())) {
      report.warnings.push(`spec.${id}: "${v}" ليس رقمًا / is not a number; stored as written`);
    } else if (f.type === 'hex' && !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim())) {
      report.warnings.push(`spec.${id}: "${v}" ليس #RGB أو #RRGGBB / is not a hex colour; stored as written`);
    }
  }
  return report;
}

interface Analysis {
  parsed: ParsedTemplate;
  refs: ResolvedRefs;
  existing: ProductDoc | null;
  /** The existing product's relational view (update only). */
  existingView: ProductRelationsView | null;
  merge: ToDocResult | null;
  doc: ProductDoc | null;
  validation_error: { message: string; code?: string } | null;
  spec: SpecSheetReport | null;
  /** §18 — the product-scoped membership rules the file states, lifted out of
   *  the text before the product parser ran (see `extractMembership`). */
  membership: ParsedMembershipRule[];
}

/** Shared dry-run pipeline: parse → resolve refs → merge → validate.
 *  Never writes. `target` retargets the merge: undefined = follow the
 *  template's product_id header; null = force a create merge (ignore the
 *  header); a string = merge onto that product (duplicate flow). */
async function analyzeTemplate(
  db: D1Database,
  text: string,
  target?: string | null,
  opts: { money: boolean } = { money: true }
): Promise<Analysis> {
  // §18 — the membership keys are lifted out FIRST, so the product parser
  // never sees a key it would have to file under `unknown_keys`, and a rule the
  // panel would refuse stops the import here rather than after the write.
  const membership = extractMembership(text);
  const parsed = parseTemplate(membership.text);
  parsed.errors.push(...membership.errors);
  const a: Analysis = {
    parsed, refs: {}, existing: null, existingView: null, merge: null, doc: null, validation_error: null, spec: null,
    membership: membership.rules,
  };
  if (parsed.errors.length > 0) return a;

  a.refs = await resolveRefs(db, parsed);

  const targetId = target === null ? null : target ?? parsed.header.product_id;
  if (targetId) {
    const loaded = await loadProductDocWithView(db, targetId);
    if (!loaded) {
      parsed.errors.push({ line: 0, key: 'product_id', message: `product "${targetId}" not found` });
      return a;
    }
    a.existing = loaded.doc;
    a.existingView = loaded.view;
  }

  const merge = toDocBody(parsed, a.existing, a.refs);
  a.merge = merge;
  const body = { ...merge.body };
  const bookkeeping = translationBookkeeping(body, a.existing);
  body.content_rev = bookkeeping.content_rev;
  body.translation_meta = bookkeeping.translation_meta;
  try {
    const validated = validateProductDoc(body);
    // Extended warranty is for printers only (owner mandate): the catalogs
    // this file names — or the product's stored placement when it names
    // none — decide, and the +12/+24 shape and the printer defaults
    // (serialized, 12-month base) are applied before anything is written.
    // Runs inside the same try so a refusal is a validation_error the
    // preview shows, not a 500.
    await applyPrinterWarrantyRules(
      db,
      validated,
      a.refs.catalog_ids !== undefined ? a.refs.catalog_ids : a.existing ? undefined : []
    );
    a.doc = validated;
    /**
     * THE OWNER'S FORM IS WHAT GETS STORED: cheapest sellable price as the
     * base, every option and colour an increase over it (cheapestBase.ts). A
     * file that states fixed option prices is re-expressed here — the resolved
     * price of every option × colour × tier is unchanged — and the preview's
     * warnings and key-by-key diff show exactly what will be written.
     *
     * ONLY WHEN THE FILE WRITES THE ROWS. The rewrite moves the base and the
     * option/colour rows together. A file carrying no options.N or colors.N keys
     * leaves the stored rows alone (the relational writer does not run), so
     * lowering the base by itself would change what every inheriting option
     * sells for. Such a file is applied as written.
     *
     * AND ONLY IF THE RESULT VALIDATES. The rewrite is built to pass the
     * write-time ladder, but the validator is the authority: a normalized
     * document it refuses is not stored — the file is applied as written and
     * the preview says so.
     */
    if (touchesPricingStructure(parsed)) {
      const norm = normalizeCheapestBase(validated, { money: opts.money });
      if (norm.changed.length > 0) {
        try {
          a.doc = validateProductDoc({
            ...body,
            price_iqd: norm.doc.price_iqd,
            options: norm.doc.options,
            colors: norm.doc.colors,
            // The printer defaults the first pass filled in (serialized,
            // base months) are the document's now, not the file's — keep them.
            serialized: validated.serialized,
            warranty_base_months: validated.warranty_base_months,
          });
          merge.warnings.push(...norm.warnings);
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          merge.warnings.push(
            `لم يُعَد التعبير عن الأسعار كزيادات فوق الأرخص لأن النتيجة لا تجتاز قواعد التسعير (${e.message}) — طُبِّق الملف كما كُتب.`
          );
        }
      } else {
        merge.warnings.push(...norm.warnings);
      }
    }
  } catch (e) {
    if (e instanceof HttpError) a.validation_error = { message: e.message, code: e.code };
    else throw e;
  }
  if (a.doc) {
    a.spec = await specSheetReport(db, a.doc, parsed);
    merge.warnings.push(...a.spec.warnings);
  }
  return a;
}

/** The mode the apply will store, so the preview's diff can say it. */
function plannedInventoryMode(a: Analysis, isUpdate: boolean): string | null {
  if (!a.doc || !a.merge) return null;
  const view = a.existingView ?? EMPTY_RELATIONS;
  const structure = touchesStructure(a.parsed);
  if (isUpdate && !structure && a.merge.inventory_mode === undefined) return view.inventory_mode;
  const kept = view.variants.length;
  return deriveInventoryModeFromDoc(a.doc, view, a.merge.inventory_mode, kept);
}

function computeDiff(
  before: ProductDoc | null,
  after: ProductDoc,
  opts: { includeCost?: boolean; beforeMode?: string | null; afterMode?: string | null } = {}
): Array<{ field: string; before: string | null; after: string | null }> {
  const repr = (v: string | null): string => (v === null ? NULL_TOKEN : v);
  // §11: the diff is built from the SAME entry writer as the export, so it
  // inherits the export's cost gate rather than needing its own list of keys.
  const entryOpts = { includeCost: opts.includeCost !== false };
  const beforeMap = new Map<string, string | null>();
  if (before) {
    beforeMap.set('slug', before.slug);
    for (const e of docToEntries(before, { ...entryOpts, inventoryMode: opts.beforeMode ?? undefined })) beforeMap.set(e.key, e.value);
  }
  const diff: Array<{ field: string; before: string | null; after: string | null }> = [];
  const seen = new Set<string>();
  const afterEntries: Array<{ key: string; value: string | null }> = [
    { key: 'slug', value: after.slug },
    ...docToEntries(after, { ...entryOpts, inventoryMode: opts.afterMode ?? undefined }),
  ];
  for (const e of afterEntries) {
    seen.add(e.key);
    const had = beforeMap.has(e.key);
    const b = had ? repr(beforeMap.get(e.key) ?? null) : null;
    const v = repr(e.value);
    if (b !== v) diff.push({ field: e.key, before: b, after: v });
  }
  if (before) {
    for (const [key, value] of beforeMap) {
      if (!seen.has(key)) diff.push({ field: key, before: repr(value), after: null });
    }
  }
  return diff;
}

async function exportOptsFor(
  db: D1Database,
  doc: ProductDoc
): Promise<{
  brand: string | null;
  catalogs: string[];
  transportDefaults: Array<{ method: string; commission_iqd: number | null }>;
  category: string | null;
  subCategory: string | null;
  specFieldIds: string[];
}> {
  let brand: string | null = null;
  if (doc.brand_id) {
    const row = await db.prepare('SELECT slug FROM brands WHERE id = ?').bind(doc.brand_id).first<{ slug: string }>();
    brand = row?.slug ?? doc.brand_id;
  }
  const { results } = await db
    .prepare(
      `SELECT c.slug FROM product_catalogs pc JOIN catalogs c ON c.id = pc.catalog_id
        WHERE pc.product_id = ? ORDER BY c.slug`
    )
    .bind(doc.id)
    .all<{ slug: string }>();
  // `transports.N.commission_iqd=__NULL__` means "inherit the admin default
  // for this method". Without reading that setting the export can name the
  // inheritance but not the number, which is precisely the complaint.
  const transportDefaults = await getSetting(db, 'preorderTransportDefaults');

  /**
   * The §10 field ids this product's family declares, so the export can list
   * the whole sheet rather than only the specs that happen to be filled. The
   * field set depends on the family AND on the product's sections — the same
   * resolution the admin form and the CSV columns go through, so a spec is in
   * all three places or in none.
   */
  let specFieldIds: string[] = [];
  if (doc.template_family === 'devices' || doc.template_family === 'materials') {
    // SUB-CATEGORY FIRST. The branch is read leaf-first everywhere else, and
    // it must be here too: with the parent first, a Resin printer's export
    // would resolve «الطابعات» before «طابعات Resin» and narrow to nothing —
    // or, worse, to the wrong technology's columns.
    const sectionIds = [doc.sub_category_id, doc.category_id].filter((x): x is string => !!x);
    const branch: SectionRef[] = [];
    for (const id of sectionIds) {
      const row = await db.prepare('SELECT slug FROM catalogs WHERE id = ?').bind(id).first<{ slug: string }>();
      if (row) branch.push({ id, slug: row.slug });
    }
    specFieldIds = flatFields(groupsForSection(doc.template_family, branch)).map((f) => f.id);
  }
  // Slugs, not ids: a file that says `category=printers` is readable, and it
  // re-imports on any environment where that section exists.
  const slugOf = async (id: string | null) =>
    id
      ? ((await db.prepare('SELECT slug FROM catalogs WHERE id = ?').bind(id).first<{ slug: string }>())?.slug ?? id)
      : null;
  return {
    brand,
    catalogs: results.map((r) => r.slug),
    transportDefaults,
    category: await slugOf(doc.category_id),
    subCategory: await slugOf(doc.sub_category_id),
    specFieldIds,
  };
}

async function findDuplicate(
  db: D1Database,
  slug: string,
  nameAr: string
): Promise<{ id: string } | null> {
  if (nameAr) {
    return db
      .prepare('SELECT id FROM products WHERE slug = ? OR (name_ar <> \'\' AND name_ar = ?) LIMIT 1')
      .bind(slug, nameAr)
      .first<{ id: string }>();
  }
  return db.prepare('SELECT id FROM products WHERE slug = ? LIMIT 1').bind(slug).first<{ id: string }>();
}

async function uniqueSlug(db: D1Database, base: string): Promise<string> {
  let candidate = base;
  for (let i = 0; i < 5; i++) {
    const row = await db.prepare('SELECT 1 AS x FROM products WHERE slug = ?').bind(candidate).first();
    if (!row) return candidate;
    candidate = `${base}-${newId('').slice(0, 6)}`.slice(0, 120);
  }
  return `${base}-${newId('').slice(0, 12)}`.slice(0, 130);
}

// ------------------------------------------------- apply idempotency guard

/**
 * §6.1: "التأكيد عملية آمنة تمنع استيراد الدفعة نفسها مرتين بالخطأ".
 *
 * The guard is a content fingerprint claimed atomically immediately before
 * the write. Everything that can reject a template (parse errors, needs
 * review, duplicate choice, stale check) runs BEFORE the claim, so a rejected
 * submission never burns the fingerprint and can be retried after a fix.
 *
 * Storage is the existing `rate_limits` table: `key` is its PRIMARY KEY, so
 * `INSERT … ON CONFLICT(key) DO UPDATE … RETURNING count` is a single atomic
 * statement — a check-then-write race is impossible. No new table (and no new
 * migration) is introduced for it; rows expire with the window and are swept
 * by the limiter's own cleanup.
 */
const APPLY_FINGERPRINT_WINDOW_SECONDS = 900; // 15 minutes

/** Same bytes, same batch — CRLF/CR and trailing whitespace are normalized so
 *  the same file re-uploaded from Windows/macOS fingerprints identically. */
export async function applyFingerprint(
  adminUserId: string,
  mode: string,
  duplicateChoice: string | null,
  text: string
): Promise<string> {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const hash = await sha256Hex(`${adminUserId}|${mode}|${duplicateChoice ?? ''}|${normalized}`);
  return hash.slice(0, 32);
}

/** Atomic claim. Returns true only for the FIRST caller inside the window. */
export async function claimApplyFingerprint(db: D1Database, fingerprint: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - APPLY_FINGERPRINT_WINDOW_SECONDS;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start > ?3 THEN count + 1 ELSE 1 END,
         window_start = CASE WHEN window_start > ?3 THEN window_start ELSE ?2 END
       RETURNING count`
    )
    .bind(`tplfp:${fingerprint}`, now, cutoff)
    .first<{ count: number }>();
  return (row?.count ?? 0) <= 1;
}

/** Releases a claim whose write did not happen, so the admin can retry. */
export async function releaseApplyFingerprint(db: D1Database, fingerprint: string): Promise<void> {
  try {
    await db.prepare('DELETE FROM rate_limits WHERE key = ? AND count <= 1').bind(`tplfp:${fingerprint}`).run();
  } catch (e) {
    console.error('template apply fingerprint release failed', e);
  }
}

/** The product a previous apply of this exact fingerprint produced, read back
 *  from the audit trail (written in the same request as the write). */
async function previousApply(
  db: D1Database,
  adminUserId: string,
  fingerprint: string
): Promise<{ product_id: string; created: boolean } | null> {
  const row = await db
    .prepare(
      `SELECT target, detail FROM audit_log
        WHERE action = 'template.apply' AND actor_id = ? AND detail LIKE ?
        ORDER BY id DESC LIMIT 1`
    )
    .bind(adminUserId, `%"fingerprint":"${fingerprint}"%`)
    .first<{ target: string; detail: string }>();
  if (!row?.target) return null;
  let created = false;
  try {
    created = JSON.parse(row.detail)?.created === true;
  } catch {
    /* detail is advisory only — the product id is what matters */
  }
  return { product_id: row.target, created };
}

/**
 * A second submission of an already-claimed batch. Nothing is written. When
 * the first submission's audit row is readable we answer 200 with the SAME
 * product and `already_applied: true` (so a client that lost the first
 * response converges instead of creating a twin); when it is not yet readable
 * — the first write is still in flight — we answer 409 honestly rather than
 * inventing a result.
 */
async function repeatSubmission(
  c: Context<AppContext>,
  adminUserId: string,
  fingerprint: string,
  /** What the SAME file said, re-parsed for this request. A retry is exactly
   *  the case where the admin never saw the first answer, so the keys the
   *  registry ignored and the fields the merge applied/cleared/preserved are
   *  echoed rather than answered as empty arrays — «unknown keys are never
   *  dropped silently» is a rule about the answer, not only about the write. */
  echo: { unknown_keys: string[]; applied_fields: string[]; cleared_fields: string[]; preserved_fields: string[] }
) {
  const prior = await previousApply(c.env.DB, adminUserId, fingerprint);
  if (!prior) {
    return c.json(
      {
        success: false,
        code: 'APPLY_IN_PROGRESS',
        error:
          'هذه الدفعة نفسها قيد التطبيق الآن — لم يُكتب شيء إضافي. انتظر النتيجة ثم حدّث القائمة / this exact batch is already being applied; nothing extra was written',
        fingerprint,
      },
      409
    );
  }
  const stored = await reloadForVerification(c.env.DB, prior.product_id);
  // §11: a resubmitted batch answers with the product; gate it like the rest.
  return c.json(projectForAdmin(c.env, c.get('user'), {
    success: true,
    already_applied: true,
    created: prior.created,
    fingerprint,
    product_id: prior.product_id,
    product: stored ? projectAdmin(stored.document) : null,
    applied_fields: echo.applied_fields,
    cleared_fields: echo.cleared_fields,
    preserved_fields: echo.preserved_fields,
    unknown_keys: echo.unknown_keys,
    warnings: [
      'هذه الدفعة طُبِّقت مسبقاً بالمحتوى نفسه — لم يُنشأ منتج ثانٍ / this exact batch was already applied; no second product was created',
    ],
    relations: stored ? relationCounts(stored) : null,
    mismatches: [],
  }));
}

/** Honest money warnings — §6.1 forbids a dropped zero/empty field silently
 *  changing the price. A zero base price with no option/colour price is legal
 *  but almost never intended, so it is surfaced instead of assumed. */
function priceWarnings(doc: ProductDoc): string[] {
  const out: string[] = [];
  // A row priced as "+N over the base" is a price too — the owner's form
  // writes every option that way, so a base of 0 under +50,000 rows is not
  // an unpriced product.
  const anyVariantPrice =
    doc.options.some((o) => o.regular_price_iqd !== null || (o.regular_adjust_iqd ?? null) !== null) ||
    doc.colors.some((cl) => cl.regular_price_iqd !== null || (cl.regular_adjust_iqd ?? null) !== null);
  if (doc.price_iqd === 0 && !anyVariantPrice) {
    out.push(
      'price_iqd = 0 ولا يوجد سعر خيار/لون يستبدله — تأكد أن هذا مقصود قبل تفعيل المنتج / base price is an explicit zero and no option/colour price replaces it'
    );
  }
  // §5 price ladder: PRO <= PRIME <= Regular. A PRIME price above the
  // regular price would be an increase, not a member discount.
  if (doc.prime_price_iqd !== null && doc.prime_price_iqd > doc.price_iqd) {
    out.push(
      'prime_price_iqd أعلى من السعر الاعتيادي — خصم PRIME يجب أن يكون أقل أو مساويًا / PRIME price is above the regular price'
    );
  }
  if (doc.prime_price_iqd !== null && doc.pro_price_iqd !== null && doc.pro_price_iqd > doc.prime_price_iqd) {
    out.push(
      'pro_price_iqd أعلى من prime_price_iqd — يجب أن يكون PRO <= PRIME <= Regular / PRO price must not exceed the PRIME price'
    );
  }
  return out;
}

// ------------------------------------------------------- GET /blank, /example

/**
 * THE SPEC SHEET THIS PRODUCT TYPE ACTUALLY HAS, as a commented scaffold.
 *
 * The TXT template's `spec_groups` are free-form label/value rows, which is
 * what makes it able to carry a detail-rich product — and also what makes a
 * blank one unhelpful: it says "write your specifications" and leaves the
 * admin to remember what a printer is supposed to list. The CSV template
 * already knows, because the product form and the CSV columns are both built
 * from the same per-type registry; this hands the TXT lane the same list.
 *
 * EVERY LINE IS A COMMENT. The scaffold names the fields and suggests the
 * indices; it cannot add a value, cannot introduce a parse error, and cannot
 * change what /apply writes. The §6.1 round-trip contract (a served template
 * parses with zero errors) therefore holds by construction, and
 * tests/templateDownload.test.ts checks it for every type rather than trusting
 * that.
 */
export function typeSpecScaffold(id: ProductTypeId): string[] {
  const def = productType(id);
  const groups = groupsForType(id);
  const out: string[] = [
    '',
    '# ============================================================',
    `# مواصفات «${def.label_ar}» — القائمة نفسها التي يعرضها نموذج المنتج`,
    `# Specification sheet for "${def.label_en}" — the same list the product form shows`,
    '# ============================================================',
    '# كل الأسطر أدناه تعليقات: احذف علامة # من السطر الذي تملؤه فعلاً.',
    '# Every line below is a comment: uncomment only the rows you actually fill.',
    '# لا حد ثابت لعدد المجموعات أو الأسطر — كرّر spec_groups.2 / rows.3 وهكذا.',
    '# No fixed number of groups or rows — keep going with spec_groups.2, rows.3, …',
  ];
  let g = 0;
  for (const group of groups) {
    g += 1;
    out.push('', `# --- ${group.label_ar} / ${group.label_en}`);
    out.push(`# spec_groups.${g}.title_ar=${group.label_ar}`);
    out.push(`# spec_groups.${g}.title_en=${group.label_en}`);
    let r = 0;
    for (const field of group.fields) {
      r += 1;
      const unit = field.unit ? ` (${field.unit})` : '';
      const options = field.options?.length ? ` — ${field.options.join(' / ')}` : '';
      out.push(`# spec_groups.${g}.rows.${r}.label_ar=${field.label_ar}${unit}${options}`);
      out.push(`# spec_groups.${g}.rows.${r}.value_ar=`);
    }
  }
  out.push('');
  return out;
}

/**
 * `?type=printer|parts|filament|accessory` appends that type's specification
 * scaffold. Without it the template is exactly what it has always been, so
 * every existing caller and saved link keeps its file.
 */
templateRoutes.get('/blank', (c) => {
  const raw = (c.req.query('type') ?? '').trim();
  if (!raw) return attachment(buildBlankTemplate().text, 'levonis-product-template.txt');
  if (!isProductType(raw)) {
    throw badRequest(
      `type: "${raw}" غير معروف — القيم المتاحة: ${PRODUCT_TYPES.map((t) => t.id).join(' / ')}`
    );
  }
  const text = `${buildBlankTemplate().text}\n${typeSpecScaffold(raw).join('\n')}`;
  return attachment(text, `levonis-product-template-${raw}.txt`);
});

/** A filled, valid example. Creating from it yields a DRAFT — never a live
 *  product (see the create branch of /apply). */
templateRoutes.get('/example', () => {
  return attachment(buildExampleTemplate(), 'levonis-product-template-example.txt');
});

// ------------------------------------------------------ GET /export/:productId

templateRoutes.get('/export/:productId', async (c) => {
  const id = c.req.param('productId');
  const loaded = await loadProductDocWithView(c.env.DB, id);
  if (!loaded) throw notFound('Product not found');
  const doc = loaded.doc;
  const opts = await exportOptsFor(c.env.DB, doc);
  // §18 — the membership block travels with the product, live. A tier with no
  // rule exports EMPTY keys, so editing and re-applying this very file changes
  // nothing about it; only typing values or `__NULL__` does.
  const benefits = membershipLines(await loadMembershipRules(c.env.DB, doc.id)).join('\n');
  return attachment(
    `${exportProduct(doc, {
      ...opts,
      // Symmetric with the parser: the file says which level counts the stock.
      inventoryMode: loaded.view.inventory_mode,
      // §11, the same gate the CSV export has always applied: an assistant
      // admin downloads the product without its cost, not the whole cost sheet.
      includeCost: canViewFinancials(c.env, c.get('user')!),
    })}\n${benefits}\n`,
    `levonis-product-${doc.id}.txt`
  );
});

// ---------------------------------------------------------------- POST /parse

templateRoutes.post('/parse', async (c) => {
  await rateLimit(c, 'tpl_parse', 240, 3600);
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const text = str(body.text, 'text', { min: 1, max: MAX_TEMPLATE_CHARS });

  const a = await analyzeTemplate(c.env.DB, text, undefined, { money: canViewFinancials(c.env, c.get('user')) });
  const needsReview = [...(a.merge?.needs_review ?? a.refs.needs_review ?? [])];
  // Every error / warning / needs-review entry is returned in full — the UI
  // must be able to show ALL rejected rows with their reason (§6.1), never a
  // truncated "first five".
  /**
   * §11 — the cost gate belongs on EVERY response, not only on the download.
   *
   * `includeCost` was added to the .txt export, and this route kept returning
   * the whole merged document plus a key-by-key diff. An assistant admin who
   * could not open the export could paste the same text here and read every
   * cost out of `preview` and `diff` instead. `projectForAdmin` is the same
   * stripper the relations endpoint uses, and it removes every field naming a
   * cost at any depth rather than a list someone has to remember to extend.
   */
  return c.json(projectForAdmin(c.env, c.get('user'), {
    success: true,
    product_id: a.parsed.header.product_id,
    is_create: !a.parsed.header.product_id,
    errors: a.parsed.errors,
    warnings: [...(a.merge?.warnings ?? a.parsed.warnings), ...(a.doc ? priceWarnings(a.doc) : [])],
    unknown_keys: a.parsed.unknown_keys,
    needs_review: needsReview,
    validation_error: a.validation_error,
    applied_fields: a.merge?.applied_fields ?? [],
    cleared_fields: a.merge?.cleared_fields ?? [],
    preserved_fields: a.merge?.preserved_fields ?? [],
    // Merged-vs-existing preview (admin view; parse never writes anything).
    preview: a.doc ? projectAdmin(a.doc) : null,
    diff: a.doc
      ? computeDiff(a.existing, a.doc, {
          includeCost: canViewFinancials(c.env, c.get('user')),
          beforeMode: a.existingView?.inventory_mode ?? null,
          afterMode: plannedInventoryMode(a, !!a.existing),
        })
      : [],
    // What the apply will do with the spec sheet and the stock level — the
    // check step says it before anything is written.
    spec_fields: a.spec,
    inventory_mode: plannedInventoryMode(a, !!a.existing),
    // §18 — and what it will do to this product's membership discount. An
    // empty list is the ordinary answer: the file said nothing, so nothing
    // changes. A `remove` entry is the one thing that deletes pricing, and it
    // is named here BEFORE the owner presses apply.
    membership: a.membership.map((r) => ({
      tier: r.tier,
      action: r.remove ? 'remove' : 'set',
      discount_mode: r.discount_mode,
      percent: r.percent,
      fixed_iqd: r.fixed_iqd,
      max_discount_iqd: r.max_discount_iqd,
      cap_scope: r.cap_scope,
      max_quantity: r.max_quantity,
    })),
  }));
});

// ---------------------------------------------------------------- POST /apply

const APPLY_MODES = ['draft', 'update'] as const;
const DUPLICATE_CHOICES = ['update_existing', 'create_hidden_draft_new_identity'] as const;

/** The template keys the file actually wrote — the scope of the read-back
 *  comparison on an update (an omitted key was preserved, and comparing it
 *  would only echo the preservation). */
function touchedKeys(merge: ToDocResult): Set<string> {
  return new Set([...merge.applied_fields, ...merge.cleared_fields]);
}

/** The read-back block every apply answer carries — counts from the tables
 *  and the document, never from the file. */
function readBackBlock(stored: NonNullable<Awaited<ReturnType<typeof reloadForVerification>>>, spec: SpecSheetReport | null, plan: ProductSavePlan | null) {
  const rel = relationCounts(stored);
  const req = plan?.relations?.requested ?? null;
  return {
    relations: rel,
    spec_fields: spec ?? { stored: Object.keys(stored.row.spec_fields).length, visible_in_form: 0, outside_section: [], family: null, warnings: [] },
    images: { requested: req ? req.images.length : null, stored: rel.images },
    option_groups: { requested: req ? req.groups.length : null, stored: rel.groups },
    option_values: { requested: req ? req.values.length : null, stored: rel.values },
    colors: { requested: req ? req.colors.length : null, stored: rel.colors },
  };
}

templateRoutes.post('/apply', async (c) => {
  await rateLimit(c, 'tpl_apply', 120, 3600);
  const adminUser = c.get('user')!;
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const text = str(body.text, 'text', { min: 1, max: MAX_TEMPLATE_CHARS });
  const mode = oneOf(body.mode, 'mode', APPLY_MODES);
  if (body.confirm !== true) {
    throw badRequest('confirm: true is required — /apply writes to the catalog (use /parse to preview)');
  }
  const duplicateChoice =
    body.duplicate_choice === undefined || body.duplicate_choice === null || body.duplicate_choice === ''
      ? null
      : oneOf(body.duplicate_choice, 'duplicate_choice', DUPLICATE_CHOICES);

  // Content fingerprint for the confirm-once guard. Computed here, CLAIMED
  // only immediately before the write so that a rejected template (errors /
  // needs review / duplicate question / stale) can be fixed and resubmitted.
  const fingerprint = await applyFingerprint(adminUser.id, mode, duplicateChoice, text);

  // Always re-parse server-side — client-prebuilt documents are never trusted.
  // Update mode follows the template's product_id; draft mode forces a create
  // merge (a stray product_id is ignored — create means a new identity).
  const money = canViewFinancials(c.env, adminUser);
  let a = await analyzeTemplate(c.env.DB, text, mode === 'update' ? undefined : null, { money });
  if (a.parsed.errors.length > 0) {
    return c.json(
      {
        success: false,
        error: 'Template has errors — nothing was written',
        code: 'TEMPLATE_ERRORS',
        errors: a.parsed.errors,
        unknown_keys: a.parsed.unknown_keys,
        warnings: a.parsed.warnings,
      },
      400
    );
  }

  let isUpdate = mode === 'update';
  const warnings: string[] = [];

  if (mode === 'update') {
    if (!a.parsed.header.product_id) {
      throw badRequest('mode "update" requires a product_id line in the template (present in every export)');
    }
  } else if (a.parsed.header.product_id && duplicateChoice !== 'update_existing') {
    warnings.push(`product_id "${a.parsed.header.product_id}" was ignored — mode "draft" always creates a new product`);
  }

  // Duplicate detection happens on the create path before any write.
  if (!isUpdate) {
    if (a.validation_error) throw new HttpError(400, a.validation_error.message, a.validation_error.code);
    const draft = a.doc!;
    const baseSlug = deriveSlug(draft.slug || draft.name_en || draft.name_ar);
    if (!baseSlug) throw badRequest('slug could not be derived — give the product a latin name or an explicit slug');
    const dup = await findDuplicate(c.env.DB, baseSlug, draft.name_ar);
    if (dup && !duplicateChoice) {
      return c.json(
        {
          success: false,
          error: 'A product with the same slug or Arabic name already exists — choose how to proceed',
          code: 'DUPLICATE',
          existing_product_id: dup.id,
          choices: DUPLICATE_CHOICES,
        },
        409
      );
    }
    if (dup && duplicateChoice === 'update_existing') {
      // Re-run the merge against the existing product (omitted-preserved).
      a = await analyzeTemplate(c.env.DB, text, dup.id, { money });
      if (a.parsed.errors.length > 0) {
        return c.json(
          { success: false, error: 'Template has errors — nothing was written', code: 'TEMPLATE_ERRORS', errors: a.parsed.errors },
          400
        );
      }
      isUpdate = true;
    }
    if (!dup && duplicateChoice) {
      warnings.push('duplicate_choice was given but no duplicate exists — created normally');
    }
  }

  // Unresolved references block the write — never silently created/dropped.
  const needsReview = a.merge?.needs_review ?? [];
  if (needsReview.length > 0) {
    return c.json(
      { success: false, error: 'Template needs review — nothing was written', code: 'NEEDS_REVIEW', needs_review: needsReview, unknown_keys: a.parsed.unknown_keys },
      400
    );
  }
  if (a.validation_error) throw new HttpError(400, a.validation_error.message, a.validation_error.code);
  const doc = a.doc!;
  const merge = a.merge!;
  warnings.push(...merge.warnings);
  warnings.push(...priceWarnings(doc));

  if (isUpdate) {
    const existing = a.existing!;
    // Stale check: an export carries expected_updated_at; refuse to clobber
    // a product that changed since that export.
    const expected = a.parsed.header.expected_updated_at;
    if (expected && existing.updated_at && expected !== existing.updated_at) {
      return c.json(
        {
          success: false,
          error: 'The product changed since this template was exported — re-export and re-apply your edits',
          code: 'STALE',
          expected_updated_at: expected,
          current_updated_at: existing.updated_at,
        },
        409
      );
    }
    doc.id = existing.id;
    if (!doc.slug) doc.slug = existing.slug; // slug stability (toDocBody enforces allow_slug_change)
  } else {
    // Create: status is FORCED to draft — a template import never goes live
    // without an explicit admin publish step.
    if (doc.status !== 'draft') {
      warnings.push(`status "${doc.status}" was overridden — template creation always starts as a draft`);
    }
    doc.status = 'draft';
    doc.id = newId('prd');
    let baseSlug = deriveSlug(doc.slug || doc.name_en || doc.name_ar);
    if (!baseSlug) throw badRequest('slug could not be derived — give the product a latin name or an explicit slug');
    if (duplicateChoice === 'create_hidden_draft_new_identity') {
      baseSlug = await uniqueSlug(c.env.DB, baseSlug);
    }
    doc.slug = baseSlug;
  }

  /**
   * THE STRUCTURE GOES WHERE THE PRODUCT ACTUALLY KEEPS IT — ALWAYS.
   *
   * The parsed document is translated into the SAME wire body the admin form
   * PUTs and handed to the shared persistence contract, which plans the
   * option groups, values, colours, links, variants and images beside the
   * product row. On a create the plan always runs; on an update it runs
   * whenever the file writes structure or names the stock level — a product
   * with no rows receiving its first option gets rows (docs/TXT_IMPORT_PARITY.md,
   * root causes 1 and 2). The old `hasRelationalStructure` gate is gone.
   */
  const relationsWanted = !isUpdate || touchesStructure(a.parsed) || merge.inventory_mode !== undefined;
  const bridge: BridgeDiagnostics = { warnings: [] };
  const relations = relationsWanted
    ? relationsBodyFromDoc(doc, a.existingView ?? EMPTY_RELATIONS, { inventoryMode: merge.inventory_mode, diag: bridge })
    : null;
  warnings.push(...bridge.warnings);

  const claimed = await claimApplyFingerprint(c.env.DB, fingerprint);
  if (!claimed) {
    return repeatSubmission(c, adminUser.id, fingerprint, {
      unknown_keys: a.parsed.unknown_keys,
      applied_fields: merge.applied_fields,
      cleared_fields: merge.cleared_fields,
      preserved_fields: merge.preserved_fields,
    });
  }

  const refused = async (status: 400 | 409 | 500, payload: Record<string, unknown>) => {
    await releaseApplyFingerprint(c.env.DB, fingerprint);
    return c.json({ success: false, unknown_keys: a.parsed.unknown_keys, warnings, ...payload }, status);
  };

  // ---- plan: row + relations + catalogs + price history + hashtags + translations
  let plan: ProductSavePlan;
  try {
    plan = await planProductSave(c.env.DB, {
      mode: isUpdate ? 'update' : 'create',
      doc,
      // The stored document WITH its relational overlay, so the cost the
      // §11 gate carries forward and the price history it diffs are the
      // real rows' numbers, not a stale JSON mirror's.
      prev: isUpdate ? a.existing : null,
      relations,
      catalogIds: a.refs.catalog_ids,
      actor: { adminId: adminUser.id, money },
      // The file carries its own Arabic and Kurdish; the translation table
      // still gets the English-sourced rows the form path writes.
      translations: translationInputsOf(doc),
    });
  } catch (e) {
    if (e instanceof HttpError) {
      const errors = Array.isArray(e.details?.errors) ? (e.details!.errors as string[]) : [e.message];
      return refused(e.status === 404 ? 400 : (e.status as 400), {
        code: e.code ?? 'VALIDATION',
        error: e.message,
        // The planner names the section it refused (`product` for a duplicate
        // SKU, `relations` for a row the writer rejects); default to relations
        // because that is where every other planned refusal comes from.
        section: typeof e.details?.section === 'string' ? e.details.section : 'relations',
        field: typeof e.details?.field === 'string' ? e.details.field : (errors[0] ?? null),
        errors,
      });
    }
    throw e;
  }
  warnings.push(...plan.warnings);

  /**
   * §11 truth in reporting: a cost line an account without financial scope
   * wrote was carried forward, not applied. It moves from `applied_fields` to
   * `preserved_fields` so the response never claims a write that the gate
   * refused (docs/TXT_IMPORT_PARITY.md, root cause 8).
   */
  const costHeld = plan.costRefused.includes('product_cost_iqd');
  const appliedFields = costHeld ? merge.applied_fields.filter((k) => k !== 'product_cost_iqd') : merge.applied_fields;
  const preservedFields =
    costHeld && merge.applied_fields.includes('product_cost_iqd')
      ? [...merge.preserved_fields, 'product_cost_iqd']
      : merge.preserved_fields;

  // ---- ONE batch: everything lands, or nothing does --------------------
  try {
    await saveProductAtomic(c.env.DB, plan, [
      {
        action: 'template.apply',
        detail: {
          mode,
          created: !isUpdate,
          duplicate_choice: duplicateChoice,
          fingerprint,
          applied: appliedFields,
          cleared: merge.cleared_fields,
          cost_refused: plan.costRefused,
          unknown_keys: a.parsed.unknown_keys,
          relations: plan.relations?.summary ?? null,
        },
      },
    ]);
  } catch (e) {
    // The write did not happen — free the fingerprint so a corrected retry
    // is not mistaken for a double submission.
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') && msg.includes('products.sku')) {
      // The race backstop for the named check in `planProductSave`: two
      // concurrent writes claiming the same SKU. The loser still learns which
      // field it was, never «Something went wrong».
      return refused(400, {
        code: 'SKU_TAKEN',
        error: `sku: "${doc.sku}" is already used by another product / رمز المنتج مستخدم في منتج آخر`,
        section: 'product',
        field: 'sku',
        errors: ['sku: already used by another product'],
      });
    }
    if (msg.includes('UNIQUE') && msg.includes('slug')) {
      // UNIQUE(slug) is the last-resort backstop for two concurrent creates
      // that both passed duplicate detection; the loser writes nothing.
      return refused(409, {
        error: 'A product with this slug already exists',
        code: 'DUPLICATE',
        existing_product_id: (await findDuplicate(c.env.DB, doc.slug, ''))?.id ?? null,
        choices: DUPLICATE_CHOICES,
      });
    }
    await releaseApplyFingerprint(c.env.DB, fingerprint);
    throw e;
  }

  /**
   * §18 — the membership rule, written beside the product and only after it
   * exists (a product-scoped rule has to name a product). It goes through
   * `saveBenefitRule` / `deleteBenefitRule`, so the version row and the audit
   * entry are appended in the same batch as the rule, exactly as they are for
   * a change made in the admin panel.
   *
   * The product row is already committed at this point, so a failure here is
   * reported as itself — naming the product that WAS saved — rather than as a
   * generic 500 that would leave the owner unsure what landed.
   */
  if (a.membership.length > 0) {
    try {
      await applyMembershipRules(c.env, adminUser.id, doc.id, a.membership);
    } catch (e) {
      return c.json(
        {
          success: false,
          code: 'MEMBERSHIP_WRITE_FAILED',
          error: 'The product was saved, but its membership discount was not written — try the membership panel',
          product_id: doc.id,
          created: !isUpdate,
          detail: e instanceof Error ? e.message : String(e),
          warnings,
        },
        500
      );
    }
  }

  // ---- read back through the form's own endpoints and compare -----------
  const stored = await reloadForVerification(c.env.DB, doc.id);
  if (!stored) {
    return refused(500, { code: 'APPLY_VERIFY_FAILED', error: 'the product could not be read back after the write', section: 'product', field: 'id' });
  }
  const mismatches: Mismatch[] = verifyApplied(plan, stored, {
    documentKeys: isUpdate ? touchedKeys(merge) : null,
    inventoryMode: plan.relations?.mode,
  });
  const spec = a.spec ? { ...a.spec, stored: Object.keys(stored.row.spec_fields).length } : null;
  if (mismatches.length > 0) {
    // Parser success is not import success. The batch is committed, so the
    // answer says the product exists and names exactly what did not persist.
    // A fresh create is removed again — nothing half-applied is left behind;
    // an update is reported as it stands, and the fingerprint is released
    // so a corrected retry is possible either way.
    const first = mismatches[0];
    let rollbackFailed: string | null = null;
    if (!isUpdate) {
      // THE ROLLBACK MAY NOT TAKE THE FINGERPRINT WITH IT. If this batch
      // throws, `refused()` is never reached: the claim stays, and a retry of
      // the same file answers `already_applied: true` for a product that was
      // never verified. So it is guarded, the failure is reported, and the
      // fingerprint is released either way. The relation rows go with the
      // product through ON DELETE CASCADE (every product-scoped table declares
      // it, migrations 0018/0048); the hashtag vocabulary rows do not, so the
      // ones THIS apply registered are named explicitly.
      try {
        await c.env.DB.batch([
          ...plan.hashtagsAdded.map((tag) => c.env.DB.prepare('DELETE FROM hashtags WHERE tag = ?').bind(tag)),
          c.env.DB.prepare('DELETE FROM product_catalogs WHERE product_id = ?').bind(doc.id),
          c.env.DB.prepare('DELETE FROM products WHERE id = ?').bind(doc.id),
        ]);
      } catch (e) {
        rollbackFailed = e instanceof Error ? e.message : String(e);
        console.error('template apply rollback failed', rollbackFailed);
      }
    }
    // The trail must not record an apply of a product that no longer exists.
    await audit(c.env.DB, adminUser.id, 'template.apply.rolled_back', doc.id, {
      created: !isUpdate,
      fingerprint,
      section: first.section,
      field: first.key,
      removed: !isUpdate && rollbackFailed === null,
      rollback_error: rollbackFailed,
    }).catch(() => undefined);
    return refused(500, {
      ...(rollbackFailed
        ? {
            rollback_error:
              'the new product could not be removed again — delete it by hand / تعذّرت إزالة المنتج الجديد، احذفه يدويًا',
          }
        : {}),
      code: 'APPLY_VERIFY_FAILED',
      error:
        `${first.section}: requested ${JSON.stringify(first.requested)}, stored ${JSON.stringify(first.stored)} (${first.key})` +
        (isUpdate
          ? ' — the product exists; the sections named did not persist / المنتج موجود لكن الأقسام المذكورة لم تُحفَظ'
          : ' — the new product was removed again; nothing was left half-applied / أُزيل المنتج الجديد ولم يبقَ شيء نصف محفوظ'),
      section: first.section,
      field: first.key,
      expected: first.requested,
      stored: first.stored,
      product_id: isUpdate ? doc.id : null,
      created: !isUpdate,
      mismatches,
      ...(isUpdate ? readBackBlock(stored, spec, plan) : {}),
    });
  }

  // §11: the same gate as the export and /parse — the applied product is the
  // whole document, cost included, and an assistant admin must not read it.
  return c.json(projectForAdmin(c.env, adminUser, {
    success: true,
    created: !isUpdate,
    already_applied: false,
    fingerprint,
    product_id: doc.id,
    product: projectAdmin(stored.document),
    applied_fields: appliedFields,
    cleared_fields: merge.cleared_fields,
    preserved_fields: preservedFields,
    cost_refused: plan.costRefused,
    unknown_keys: a.parsed.unknown_keys,
    warnings,
    ...readBackBlock(stored, spec, plan),
    mismatches: [],
    price_history_rows: plan.priceHistory.length,
    hashtags_registered: plan.hashtagsRegistered,
    translation_review_needed: plan.translations?.review_needed ?? [],
  }));
});

// ------------------------------------------------------------ POST /parse-zip

templateRoutes.post('/parse-zip', async (c) => {
  await rateLimit(c, 'tpl_zip', 30, 3600);
  const form = await c.req.formData().catch(() => null);
  if (!form) throw badRequest('Expected multipart form data with a "file" ZIP field');
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('No ZIP file uploaded (field name: file)');
  if (file.size > MAX_ZIP_BYTES) throw badRequest(`ZIP is too large (max ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)} MB)`);

  /**
   * NOTHING IS INFLATED BEFORE IT IS JUDGED.
   *
   * `file.size` bounds the COMPRESSED bytes at 15 MB; a 15 MB archive of
   * zeros expands to gigabytes and kills the isolate. fflate's filter runs
   * against the central directory, so an entry is skipped — never inflated —
   * when it is not a template, when its UNCOMPRESSED size is beyond what
   * /parse would accept anyway, or when the archive has already offered more
   * files than one upload may carry.
   */
  const isTemplateName = (n: string) =>
    !n.endsWith('/') &&
    !n.includes('__MACOSX') &&
    !n.split('/').pop()!.startsWith('.') &&
    n.toLowerCase().endsWith('.txt');
  const oversized: string[] = [];
  const skippedNotTxt: string[] = [];
  let offered = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter: (f) => {
        if (!isTemplateName(f.name)) {
          if (!f.name.endsWith('/')) skippedNotTxt.push(f.name);
          return false;
        }
        // One UTF-8 character is at least one byte, so a file whose inflated
        // size exceeds the character limit can never parse.
        if (f.originalSize > MAX_TEMPLATE_CHARS) {
          oversized.push(f.name);
          return false;
        }
        offered += 1;
        return offered <= MAX_ZIP_FILES;
      },
    });
  } catch {
    throw badRequest('Could not read the ZIP archive — is it a valid .zip file?');
  }

  const names = Object.keys(entries).filter(isTemplateName).sort();

  const skipped = [...skippedNotTxt, ...oversized];
  // Entries the filter refused to inflate because the archive had already
  // offered MAX_ZIP_FILES templates, plus (belt and braces) any surplus that
  // still arrived.
  const overflow = names.length > MAX_ZIP_FILES ? names.splice(MAX_ZIP_FILES) : [];
  const overLimit = Math.max(0, offered - MAX_ZIP_FILES);

  const decoder = new TextDecoder('utf-8');
  const files: Array<Record<string, unknown>> = [];
  // Each entry is parsed independently — one bad file never fails the rest.
  for (const name of names) {
    try {
      const text = decoder.decode(entries[name]);
      const a = await analyzeTemplate(c.env.DB, text, undefined, { money: canViewFinancials(c.env, c.get('user')) });
      const needsReview = a.merge?.needs_review ?? a.refs.needs_review ?? [];
      const ok = a.parsed.errors.length === 0 && !a.validation_error;
      files.push({
        name,
        ok,
        ready_to_apply: ok && needsReview.length === 0,
        product_id: a.parsed.header.product_id,
        is_create: !a.parsed.header.product_id,
        errors: a.parsed.errors,
        warnings: [...(a.merge?.warnings ?? a.parsed.warnings), ...(a.doc ? priceWarnings(a.doc) : [])],
        unknown_keys: a.parsed.unknown_keys,
        needs_review: needsReview,
        validation_error: a.validation_error,
        applied_fields: a.merge?.applied_fields ?? [],
        // §7.3 — the same pre-flight statement the single-file /parse makes.
        spec_fields: a.spec,
        inventory_mode: plannedInventoryMode(a, !!a.existing),
        summary: a.doc ? { name_ar: a.doc.name_ar, name_en: a.doc.name_en, price_iqd: a.doc.price_iqd } : null,
      });
    } catch (e) {
      files.push({
        name,
        ok: false,
        ready_to_apply: false,
        errors: [{ line: 0, key: '', message: e instanceof HttpError ? e.message : 'file could not be parsed' }],
        warnings: [],
        unknown_keys: [],
        needs_review: [],
      });
    }
  }

  // Counts cover EVERY entry of the archive — files parsed, files not ready,
  // non-.txt entries and entries past the per-archive limit — so the admin UI
  // can report all accepted/rejected rows with a reason (§6.1), never a
  // truncated list.
  return c.json({
    success: true,
    files,
    skipped_entries: skipped,
    skipped_over_limit: overflow,
    skipped_oversized: oversized,
    counts: {
      parsed: files.length,
      ready: files.filter((f) => f.ready_to_apply === true).length,
      not_ready: files.filter((f) => f.ready_to_apply !== true).length,
      skipped_not_txt: skipped.length,
      skipped_over_limit: overflow.length + overLimit,
      limit: MAX_ZIP_FILES,
    },
  });
});
