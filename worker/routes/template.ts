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
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';
import { newId, sha256Hex } from '../lib/crypto';
import {
  parseTemplate,
  exportProduct,
  generateBlankTemplate,
  toDocBody,
  docToEntries,
  translationBookkeeping,
  deriveSlug,
  NULL_TOKEN,
  TEMPLATE_VERSION,
  type ParsedTemplate,
  type ResolvedRefs,
  type ToDocResult,
} from '../lib/template';
import {
  parseProductRow,
  validateProductDoc,
  serializeDoc,
  projectAdmin,
  type ProductDoc,
} from '../lib/productModel';
import {
  PRODUCT_TYPES,
  groupsForType,
  isProductType,
  productType,
  type ProductTypeId,
} from '../lib/templateFamilies';

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
  const healed = disableUnparsableLines(out.join('\n'));
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
options.1.id=opt_example_small
options.1.name_ar=المقاس الصغير
options.1.name_en=Small
options.1.active=true
# __NULL__ = يرث السعر الأساسي (لا يساوي صفراً)
options.1.regular_price_iqd=__NULL__
options.2.id=opt_example_large
options.2.name_ar=المقاس الكبير
options.2.name_en=Large
options.2.active=true
# سعر الخيار يستبدل السعر الأساسي
options.2.regular_price_iqd=120000

# ------------------------------ الألوان / colors
# الوراثة لكل حقل: لون ← خيار ← أساسي
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
colors.2.regular_price_iqd=135000
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

# ------------------------------ خطط الضمان / warranty plans
warranty_plans.1.id=wp_example_base
warranty_plans.1.title_ar=ضمان أساسي
warranty_plans.1.title_en=Base warranty
warranty_plans.1.duration_months=12
warranty_plans.1.duration_kind=total
# 0 = مجاني صراحةً (وليس "غير محدد")
warranty_plans.1.fee_iqd=0
warranty_plans.1.active=true

# ------------------------------ كتل المحتوى / content blocks
content_blocks.1.id=cb_example_text
content_blocks.1.kind=text
content_blocks.1.body_ar=<<<END
كتلة محتوى نصية تظهر أسفل صفحة المنتج.
END
content_blocks.1.caption_ar=مثال
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

async function loadProductDoc(db: D1Database, id: string): Promise<ProductDoc | null> {
  const row = await db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return row ? parseProductRow(row) : null;
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

/** Replaces the product↔catalog associations, keeping existing positions and
 *  appending new memberships at the end of each catalog. */
async function applyCatalogs(db: D1Database, productId: string, catalogIds: string[]): Promise<void> {
  const { results } = await db
    .prepare('SELECT catalog_id FROM product_catalogs WHERE product_id = ?')
    .bind(productId)
    .all<{ catalog_id: string }>();
  const current = new Set(results.map((r) => r.catalog_id));
  const wanted = new Set(catalogIds);
  for (const cid of current) {
    if (!wanted.has(cid)) {
      await db.prepare('DELETE FROM product_catalogs WHERE product_id = ? AND catalog_id = ?').bind(productId, cid).run();
    }
  }
  for (const cid of catalogIds) {
    if (current.has(cid)) continue;
    const row = await db
      .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM product_catalogs WHERE catalog_id = ?')
      .bind(cid)
      .first<{ pos: number }>();
    await db
      .prepare('INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES (?, ?, ?)')
      .bind(productId, cid, row?.pos ?? 1)
      .run();
  }
}

interface Analysis {
  parsed: ParsedTemplate;
  refs: ResolvedRefs;
  existing: ProductDoc | null;
  merge: ToDocResult | null;
  doc: ProductDoc | null;
  validation_error: { message: string; code?: string } | null;
}

/** Shared dry-run pipeline: parse → resolve refs → merge → validate.
 *  Never writes. `target` retargets the merge: undefined = follow the
 *  template's product_id header; null = force a create merge (ignore the
 *  header); a string = merge onto that product (duplicate flow). */
async function analyzeTemplate(
  db: D1Database,
  text: string,
  target?: string | null
): Promise<Analysis> {
  const parsed = parseTemplate(text);
  const a: Analysis = { parsed, refs: {}, existing: null, merge: null, doc: null, validation_error: null };
  if (parsed.errors.length > 0) return a;

  a.refs = await resolveRefs(db, parsed);

  const targetId = target === null ? null : target ?? parsed.header.product_id;
  if (targetId) {
    a.existing = await loadProductDoc(db, targetId);
    if (!a.existing) {
      parsed.errors.push({ line: 0, key: 'product_id', message: `product "${targetId}" not found` });
      return a;
    }
  }

  a.merge = toDocBody(parsed, a.existing, a.refs);
  const body = { ...a.merge.body };
  const bookkeeping = translationBookkeeping(body, a.existing);
  body.content_rev = bookkeeping.content_rev;
  body.translation_meta = bookkeeping.translation_meta;
  try {
    a.doc = validateProductDoc(body);
  } catch (e) {
    if (e instanceof HttpError) a.validation_error = { message: e.message, code: e.code };
    else throw e;
  }
  return a;
}

function computeDiff(
  before: ProductDoc | null,
  after: ProductDoc
): Array<{ field: string; before: string | null; after: string | null }> {
  const repr = (v: string | null): string => (v === null ? NULL_TOKEN : v);
  const beforeMap = new Map<string, string | null>();
  if (before) {
    beforeMap.set('slug', before.slug);
    for (const e of docToEntries(before)) beforeMap.set(e.key, e.value);
  }
  const diff: Array<{ field: string; before: string | null; after: string | null }> = [];
  const seen = new Set<string>();
  const afterEntries: Array<{ key: string; value: string | null }> = [
    { key: 'slug', value: after.slug },
    ...docToEntries(after),
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

async function exportOptsFor(db: D1Database, doc: ProductDoc): Promise<{ brand: string | null; catalogs: string[] }> {
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
  return { brand, catalogs: results.map((r) => r.slug) };
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
async function repeatSubmission(c: Context<AppContext>, adminUserId: string, fingerprint: string) {
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
  const fresh = await loadProductDoc(c.env.DB, prior.product_id);
  return c.json({
    success: true,
    already_applied: true,
    created: prior.created,
    fingerprint,
    product_id: prior.product_id,
    product: fresh ? projectAdmin(fresh) : null,
    applied_fields: [],
    cleared_fields: [],
    preserved_fields: [],
    warnings: [
      'هذه الدفعة طُبِّقت مسبقاً بالمحتوى نفسه — لم يُنشأ منتج ثانٍ / this exact batch was already applied; no second product was created',
    ],
  });
}

/** Honest money warnings — §6.1 forbids a dropped zero/empty field silently
 *  changing the price. A zero base price with no option/colour price is legal
 *  but almost never intended, so it is surfaced instead of assumed. */
function priceWarnings(doc: ProductDoc): string[] {
  const out: string[] = [];
  const anyVariantPrice =
    doc.options.some((o) => o.regular_price_iqd !== null) ||
    doc.colors.some((cl) => cl.regular_price_iqd !== null);
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
  const doc = await loadProductDoc(c.env.DB, id);
  if (!doc) throw notFound('Product not found');
  const opts = await exportOptsFor(c.env.DB, doc);
  return attachment(exportProduct(doc, opts), `levonis-product-${doc.id}.txt`);
});

// ---------------------------------------------------------------- POST /parse

templateRoutes.post('/parse', async (c) => {
  await rateLimit(c, 'tpl_parse', 240, 3600);
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const text = str(body.text, 'text', { min: 1, max: MAX_TEMPLATE_CHARS });

  const a = await analyzeTemplate(c.env.DB, text);
  const needsReview = [...(a.merge?.needs_review ?? a.refs.needs_review ?? [])];
  // Every error / warning / needs-review entry is returned in full — the UI
  // must be able to show ALL rejected rows with their reason (§6.1), never a
  // truncated "first five".
  return c.json({
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
    diff: a.doc ? computeDiff(a.existing, a.doc) : [],
  });
});

// ---------------------------------------------------------------- POST /apply

const APPLY_MODES = ['draft', 'update'] as const;
const DUPLICATE_CHOICES = ['update_existing', 'create_hidden_draft_new_identity'] as const;

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
  let a = await analyzeTemplate(c.env.DB, text, mode === 'update' ? undefined : null);
  if (a.parsed.errors.length > 0) {
    return c.json(
      { success: false, error: 'Template has errors — nothing was written', code: 'TEMPLATE_ERRORS', errors: a.parsed.errors },
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
      a = await analyzeTemplate(c.env.DB, text, dup.id);
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
      { success: false, error: 'Template needs review — nothing was written', code: 'NEEDS_REVIEW', needs_review: needsReview },
      400
    );
  }
  if (a.validation_error) throw new HttpError(400, a.validation_error.message, a.validation_error.code);
  const doc = a.doc!;
  warnings.push(...(a.merge?.warnings ?? []));
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

    const claimed = await claimApplyFingerprint(c.env.DB, fingerprint);
    if (!claimed) return repeatSubmission(c, adminUser.id, fingerprint);

    const serialized = serializeDoc(doc);
    delete (serialized as Record<string, unknown>).id;
    const cols = Object.keys(serialized);
    // Explicit-column UPDATE: legacy v1 columns (shipping_methods, features,
    // membership_prices, brand text, categories, …) are not in the column
    // map, so they are preserved verbatim.
    const sql = `UPDATE products SET ${cols.map((k) => `${k} = ?`).join(', ')},
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`;
    try {
      await c.env.DB.prepare(sql).bind(...cols.map((k) => (serialized as Record<string, unknown>)[k]), doc.id).run();
    } catch (e) {
      // The write did not happen — free the fingerprint so a corrected retry
      // is not mistaken for a double submission.
      await releaseApplyFingerprint(c.env.DB, fingerprint);
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('UNIQUE') && msg.includes('slug')) throw badRequest('A product with this slug already exists');
      throw e;
    }
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

    const claimed = await claimApplyFingerprint(c.env.DB, fingerprint);
    if (!claimed) return repeatSubmission(c, adminUser.id, fingerprint);

    const serialized = serializeDoc(doc);
    const cols = Object.keys(serialized);
    const sql = `INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    try {
      await c.env.DB.prepare(sql).bind(...cols.map((k) => (serialized as Record<string, unknown>)[k])).run();
    } catch (e) {
      // Nothing was inserted — release the claim before reporting.
      await releaseApplyFingerprint(c.env.DB, fingerprint);
      const msg = e instanceof Error ? e.message : String(e);
      // UNIQUE(slug) is the last-resort backstop for two concurrent creates
      // that both passed duplicate detection; the loser writes nothing.
      if (msg.includes('UNIQUE') && msg.includes('slug')) {
        return c.json(
          {
            success: false,
            error: 'A product with this slug already exists',
            code: 'DUPLICATE',
            existing_product_id: (await findDuplicate(c.env.DB, doc.slug, ''))?.id ?? null,
            choices: DUPLICATE_CHOICES,
          },
          409
        );
      }
      throw e;
    }
  }

  // The product row is written at this point. A catalog-association failure
  // is reported as a warning and never aborts the audit that follows: the
  // audit row is what a repeat submission of this batch reads back, so losing
  // it would strand the fingerprint and turn an honest retry into a 409.
  if (a.refs.catalog_ids !== undefined) {
    try {
      await applyCatalogs(c.env.DB, doc.id, a.refs.catalog_ids);
    } catch (e) {
      console.error('template apply: catalog association failed', doc.id, e);
      warnings.push(
        'حُفظ المنتج لكن ربط الكتالوجات فشل — راجع تصنيفات المنتج يدوياً / the product was saved but its catalog links failed; check them manually'
      );
    }
  }

  // The fingerprint is part of the audit detail: it is how a repeat
  // submission finds the product the first submission produced.
  await audit(c.env.DB, adminUser.id, 'template.apply', doc.id, {
    mode,
    created: !isUpdate,
    duplicate_choice: duplicateChoice,
    fingerprint,
    applied: a.merge?.applied_fields ?? [],
    cleared: a.merge?.cleared_fields ?? [],
  });

  const fresh = await loadProductDoc(c.env.DB, doc.id);
  return c.json({
    success: true,
    created: !isUpdate,
    already_applied: false,
    fingerprint,
    product_id: doc.id,
    product: fresh ? projectAdmin(fresh) : null,
    applied_fields: a.merge?.applied_fields ?? [],
    cleared_fields: a.merge?.cleared_fields ?? [],
    preserved_fields: a.merge?.preserved_fields ?? [],
    warnings,
  });
});

// ------------------------------------------------------------ POST /parse-zip

templateRoutes.post('/parse-zip', async (c) => {
  await rateLimit(c, 'tpl_zip', 30, 3600);
  const form = await c.req.formData().catch(() => null);
  if (!form) throw badRequest('Expected multipart form data with a "file" ZIP field');
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('No ZIP file uploaded (field name: file)');
  if (file.size > MAX_ZIP_BYTES) throw badRequest(`ZIP is too large (max ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)} MB)`);

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw badRequest('Could not read the ZIP archive — is it a valid .zip file?');
  }

  const names = Object.keys(entries)
    .filter((n) => !n.endsWith('/'))
    .filter((n) => !n.includes('__MACOSX'))
    .filter((n) => !n.split('/').pop()!.startsWith('.'))
    .filter((n) => n.toLowerCase().endsWith('.txt'))
    .sort();

  const skipped = Object.keys(entries).filter((n) => !n.endsWith('/') && !names.includes(n));
  const overflow = names.length > MAX_ZIP_FILES ? names.splice(MAX_ZIP_FILES) : [];

  const decoder = new TextDecoder('utf-8');
  const files: Array<Record<string, unknown>> = [];
  // Each entry is parsed independently — one bad file never fails the rest.
  for (const name of names) {
    try {
      const text = decoder.decode(entries[name]);
      const a = await analyzeTemplate(c.env.DB, text);
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
    counts: {
      parsed: files.length,
      ready: files.filter((f) => f.ready_to_apply === true).length,
      not_ready: files.filter((f) => f.ready_to_apply !== true).length,
      skipped_not_txt: skipped.length,
      skipped_over_limit: overflow.length,
      limit: MAX_ZIP_FILES,
    },
  });
});
