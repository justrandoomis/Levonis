/**
 * Admin TXT template pipeline routes (mandate §6) — mounted at
 * /api/admin/template. Deterministic parse/export only; NO AI anywhere.
 *
 *   GET  /blank              blank template download (text/plain attachment)
 *   GET  /export/:productId  full product export (all languages, attachment)
 *   POST /parse              dry-run: preview + diff + errors — NO writes
 *   POST /apply              re-parses server-side and persists (create=draft)
 *   POST /parse-zip          multipart ZIP of .txt templates, per-file results
 *
 * Apply never trusts a client-prebuilt document: the template text is parsed
 * and validated server-side on every call. Unknown brand/catalog references
 * block the write with needs_review — never silent creation or drop.
 */

import { Hono } from 'hono';
import { unzipSync } from 'fflate';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, notFound, oneOf, str, HttpError } from '../lib/http';
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';
import { newId } from '../lib/crypto';
import {
  parseTemplate,
  exportProduct,
  generateBlankTemplate,
  toDocBody,
  docToEntries,
  translationBookkeeping,
  deriveSlug,
  NULL_TOKEN,
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

export const templateRoutes = new Hono<AppContext>();
templateRoutes.use('*', requireAdmin);

const MAX_TEMPLATE_CHARS = 1_500_000;
const MAX_ZIP_BYTES = 15 * 1024 * 1024;
const MAX_ZIP_FILES = 100;

// ---------------------------------------------------------------- helpers

function attachment(text: string, filename: string): Response {
  return new Response(text, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

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

// ---------------------------------------------------------------- GET /blank

templateRoutes.get('/blank', (c) => {
  return attachment(generateBlankTemplate(), 'levonis-product-template.txt');
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
  return c.json({
    success: true,
    product_id: a.parsed.header.product_id,
    is_create: !a.parsed.header.product_id,
    errors: a.parsed.errors,
    warnings: a.merge?.warnings ?? a.parsed.warnings,
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

    const serialized = serializeDoc(doc);
    const cols = Object.keys(serialized);
    const sql = `INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    try {
      await c.env.DB.prepare(sql).bind(...cols.map((k) => (serialized as Record<string, unknown>)[k])).run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
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

  if (a.refs.catalog_ids !== undefined) {
    await applyCatalogs(c.env.DB, doc.id, a.refs.catalog_ids);
  }

  await audit(c.env.DB, adminUser.id, 'template.apply', doc.id, {
    mode,
    created: !isUpdate,
    duplicate_choice: duplicateChoice,
    applied: a.merge?.applied_fields ?? [],
    cleared: a.merge?.cleared_fields ?? [],
  });

  const fresh = await loadProductDoc(c.env.DB, doc.id);
  return c.json({
    success: true,
    created: !isUpdate,
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
        warnings: a.merge?.warnings ?? a.parsed.warnings,
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

  return c.json({
    success: true,
    files,
    skipped_entries: skipped,
    skipped_over_limit: overflow,
  });
});
