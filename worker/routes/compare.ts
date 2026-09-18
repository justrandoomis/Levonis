/**
 * «المقارنة» — COMPARING TWO MACHINES, ON THE SHOP'S OWN SPEC SHEET.
 *
 * /api/compare?ids=a,b,c        the comparison itself
 * /api/compare/candidates?for=  what is worth comparing WITH a given product
 *
 * ---------------------------------------------------------------------------
 * THIS ROUTE OWNS NO DEFINITION OF WHAT A SPEC IS.
 *
 * `worker/lib/templateFamilies.ts` already declares every field a product can
 * carry — id, trilingual label, type, unit — and its own header states the
 * rule: ONE DEFINITION, so a CSV column and a form input cannot drift. It has
 * two consumers already (the admin product form and the import template). The
 * comparison is the THIRD, and the whole point of routing it through
 * `worker/lib/compareSpecs.ts` — which reads those same definitions — is that
 * it does not become a FOURTH list of what a printer's specifications are.
 * A comparison table with its own idea of the fields would start agreeing with
 * the product page and end disagreeing with it, silently, one migration later.
 *
 * So this file does exactly three things: it finds the products, it works out
 * what TYPE and SECTION each one is (which is what decides which fields apply
 * at all), and it hands them to `compareProducts`. Every judgement about which
 * value beats which lives there.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC, AND THAT IS THE FEATURE.
 *
 * Nothing here is behind `requireAuth`. A person comparing two printers has
 * not bought anything yet and very often has no account — a comparison is a
 * REASON to visit the shop, and a sign-in wall in front of it turns the one
 * page that answers «أي وحدة أشتري؟» into a page that asks for an email
 * address first. It reads published catalogue data and nothing else: no cost
 * column, no stock ledger, no customer.
 *
 * ---------------------------------------------------------------------------
 * ONE READ PER TABLE, NOT ONE PER PRODUCT.
 *
 * A comparison of four products needs four spec sheets, four prices, and the
 * catalogue branch each one sits in. Written naively that is four `products`
 * reads plus a walk up `catalogs` per product — on D1, where every round trip
 * is a network hop, that is the difference between a page that opens and a
 * page that feels broken. `products` is read once with an IN list, and
 * `catalogs` is read once in full (it is a few dozen rows; the branch walk is
 * then pure memory).
 *
 * ---------------------------------------------------------------------------
 * A MERCHANT PRODUCT IS NOT IN `products`, AND IS NOT SUPPORTED HERE.
 *
 * Community/merchant listings live in `community_products`, which has no
 * `spec_fields`, no `template_family` and no section — a merchant types a
 * name, a picture and a price. There is genuinely nothing to compare, so a
 * merchant id is REFUSED by name rather than half-supported: rendering it as a
 * column of «غير مذكور» would tell the customer the machine lacks the
 * specifications, when what is actually missing is the sheet itself.
 */

import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { badRequest, notFound, str } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import {
  isTemplateFamily,
  productTypeForBranch,
  type ProductTypeId,
  type SectionRef,
} from '../lib/templateFamilies';
import { compareProducts, type CompareResult } from '../lib/compareSpecs';

export const compareRoutes = new Hono<AppContext>();

/**
 * FOUR COLUMNS, AND THE REASON IS THE PHONE.
 *
 * The owner asked for «أكثر من طابعة» — more than two — and then asked, in the
 * same breath, for a page that is not «متشابكة وخربطة ولا يستطيع المستخدم
 * فهم». Those two requests meet at four. Nearly every visitor to this shop is
 * on a phone in Arabic: a spec row has to carry a label plus one cell per
 * product, and at a fifth column the cells are narrower than «غير مذكور» and
 * the table stops being readable in the only place most people will read it.
 *
 * It is also the bound on the work: four products is four spec sheets and one
 * catalogue read, and it keeps the IN list far under D1's 100-parameter limit
 * with no chunking to get wrong.
 */
const MAX_COMPARE_IDS = 4;

/** What the second-slot picker offers. Long enough to find the machine you
 *  meant, short enough to stay a list rather than a search results page. */
const MAX_CANDIDATES = 12;

/**
 * How many rows the ranking may consider. The final ordering depends on the
 * product TYPE, which is derived in TypeScript from the catalogue branch and
 * therefore cannot be an ORDER BY — so SQL returns a bounded, already
 * roughly-ordered pool and the exact ranking happens over that.
 */
const CANDIDATE_POOL = 120;

/** The columns a comparison column is drawn from. Deliberately not `SELECT *`:
 *  this is a public route, and `product_cost_iqd` is one column away. */
const PRODUCT_COLUMNS =
  'id, slug, status, name, name_ar, name_ku, images, price_iqd, spec_fields, ' +
  'template_family, category_id, sub_category_id, brand_id, condition_doc';

interface ProductRow {
  id: string;
  slug: string;
  status: string;
  name: string;
  name_ar: string;
  name_ku: string;
  images: string;
  price_iqd: number;
  spec_fields: string;
  template_family: string | null;
  category_id: string | null;
  sub_category_id: string | null;
  brand_id: string | null;
  condition_doc: string;
}

interface CatalogRow {
  id: string;
  parent_id: string | null;
  slug: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  template_family: string | null;
}

/** Arabic first, and English is the fallback for both of the others — a shop
 *  that has not translated a name must still render one. */
interface Trilingual {
  ar: string;
  en: string;
  ckb: string;
}

/** The card one column of the comparison is drawn from. Exported so the page
 *  and the assistant's compact table read the same shape rather than each
 *  inventing one. */
export interface CompareProductCard {
  id: string;
  slug: string;
  name: Trilingual;
  image: string | null;
  /**
   * The BASE price, which by this shop's own rule («سعر المنتج يوضع الأرخص
   * ليكون الخيارات والألوان والتوفر عبارة عن زيادة», see
   * packages/pricing/src/cheapestBase.ts) is the cheapest way to buy the
   * product — every model, colour and delivery route is an increase on it. So
   * it is a «يبدأ من» figure and the page must say so: comparing two machines
   * on a member-tier price would compare the viewer's membership as much as
   * the machines, and a signed-out visitor would see a different comparison
   * from a signed-in one.
   */
  price_iqd: number;
  product_type: ProductTypeId | null;
  section: { id: string; slug: string; label: Trilingual } | null;
  brand_id: string | null;
  /** True when the unit is graded (open box / used / refurbished, 0085). A
   *  comparison that does not say so compares a used machine with a new one
   *  and calls the used one cheaper. */
  graded: boolean;
}

const tri = (ar: string, en: string, ckb: string): Trilingual => ({
  ar: ar || en || ckb,
  en: en || ar || ckb,
  ckb: ckb || ar || en,
});

/** The first published image, or nothing. Same shape `products.ts` stores and
 *  the same tolerance for a malformed list: a broken picture must never be the
 *  reason a comparison refuses to open. */
function firstImage(raw: unknown): string | null {
  const list = safeParse<unknown>(String(raw ?? '[]'), []);
  if (!Array.isArray(list) || list.length === 0) return null;
  const first = list[0];
  if (typeof first === 'string' && first) return first;
  // 0018's richer media entries are objects carrying a url.
  if (first && typeof first === 'object' && typeof (first as { url?: unknown }).url === 'string') {
    return (first as { url: string }).url || null;
  }
  return null;
}

/**
 * The stored spec sheet as an object, whatever is actually in the column.
 *
 * NEVER THROWS, and that is a requirement rather than defensive habit.
 * `spec_fields` is `TEXT NOT NULL DEFAULT '{}'` — the database does not
 * validate JSON — so one bad import, one half-written admin save, or one
 * hand-edited row is enough to put something unparseable in there. A
 * comparison that 500s on it takes down the whole page for the OTHER product
 * too, and the visitor is told the site is broken when the truth is that one
 * machine has no readable sheet. It degrades to "no specs recorded", which the
 * caller then refuses by name.
 */
function specSheet(raw: unknown): Record<string, unknown> {
  const parsed = safeParse<unknown>(String(raw ?? '{}'), {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

/** Does this sheet say anything at all? An object full of empty strings is an
 *  empty sheet — the admin opened the form and saved it. */
function hasAnySpec(specs: Record<string, unknown>): boolean {
  for (const value of Object.values(specs)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' ? value.trim() !== '' : true) return true;
  }
  return false;
}

/** The whole taxonomy, once. A few dozen rows; the alternative is a recursive
 *  walk per product, which on D1 is a round trip per hop. */
async function loadCatalogs(db: D1Database): Promise<CatalogRow[]> {
  const { results } = await db
    .prepare('SELECT id, parent_id, slug, name_ar, name_en, name_ckb, template_family FROM catalogs')
    .all<CatalogRow>();
  return results ?? [];
}

interface Taxonomy {
  branchOf(sectionId: string | null): CatalogRow[];
  familyOf(row: ProductRow, branch: CatalogRow[]): 'devices' | 'materials' | null;
}

/**
 * The branch a product sits in, nearest section first, and the family it
 * inherits — resolved exactly the way the admin form and the import template
 * resolve them (worker/routes/adminImport.ts), so the fields a comparison
 * shows are the fields the admin was asked to fill in. Anything else would
 * compare products on rows that were never on the form.
 *
 * Built ONCE per request and passed down. The candidates endpoint places up to
 * `CANDIDATE_POOL` products, and rebuilding the id index inside each one turns
 * a cheap lookup into a quadratic walk over the taxonomy.
 */
function taxonomy(catalogs: CatalogRow[]): Taxonomy {
  const byId = new Map(catalogs.map((r) => [r.id, r]));

  const branchOf = (sectionId: string | null): CatalogRow[] => {
    const out: CatalogRow[] = [];
    let node = sectionId ? byId.get(sectionId) : undefined;
    // The same 12-hop guard the import uses: a taxonomy someone accidentally
    // made cyclic must not hang a public request.
    for (let hop = 0; node && hop < 12; hop++) {
      out.push(node);
      node = node.parent_id ? byId.get(node.parent_id) : undefined;
    }
    return out;
  };

  const familyOf = (row: ProductRow, branch: CatalogRow[]): 'devices' | 'materials' | null => {
    // The product's own column wins: an admin who set it meant it. The branch
    // is the inheritance, for the many rows that never had one set.
    if (isTemplateFamily(row.template_family)) return row.template_family;
    for (const node of branch) if (isTemplateFamily(node.template_family)) return node.template_family;
    return null;
  };

  return { branchOf, familyOf };
}

interface Placed {
  row: ProductRow;
  specs: Record<string, unknown>;
  branch: CatalogRow[];
  productType: ProductTypeId | null;
}

/** Everything the comparison needs about one product, from rows already read. */
function place(row: ProductRow, tax: Taxonomy): Placed {
  const branch = tax.branchOf(row.sub_category_id || row.category_id);
  const family = tax.familyOf(row, branch);
  const refs: SectionRef[] = branch.map((b) => ({ id: b.id, slug: b.slug }));
  return {
    row,
    specs: specSheet(row.spec_fields),
    branch,
    // No family means nobody has ever told the shop what KIND of thing this
    // is, and the four product types are defined per family. Null rather than
    // a guess: `compareProducts` treats an unknown type as "compare on what
    // they share", which is the honest answer.
    productType: family ? productTypeForBranch(family, refs) : null,
  };
}

function cardOf(p: Placed): CompareProductCard {
  const leaf = p.branch[0];
  return {
    id: p.row.id,
    slug: p.row.slug,
    name: tri(p.row.name_ar, p.row.name, p.row.name_ku),
    image: firstImage(p.row.images),
    price_iqd: Number(p.row.price_iqd) || 0,
    product_type: p.productType,
    section: leaf
      ? { id: leaf.id, slug: leaf.slug, label: tri(leaf.name_ar, leaf.name_en, leaf.name_ckb) }
      : null,
    brand_id: p.row.brand_id || null,
    graded: String(p.row.condition_doc ?? '{}') !== '{}',
  };
}

/**
 * The `ids` parameter, refused by name rather than trimmed silently.
 *
 * A client that asked for six products and got four back would render four and
 * be wrong about which two it dropped — and the visitor would think they had
 * removed something. Duplicates are collapsed rather than refused: two links
 * to the same printer is a mistake nobody needs to be told about, and a
 * product compared against itself is a page of ties.
 */
function readIds(raw: string | undefined): string[] {
  const ids: string[] = [];
  for (const piece of String(raw ?? '').split(',')) {
    const id = piece.trim();
    if (!id) continue;
    if (id.length > 60) throw badRequest('One of the product ids is not a product id', 'COMPARE_BAD_ID');
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) {
    throw badRequest(
      'اختر منتجاً واحداً على الأقل للمقارنة. / Choose at least one product to compare.',
      'COMPARE_NO_IDS'
    );
  }
  if (ids.length > MAX_COMPARE_IDS) {
    throw badRequest(
      `تكدر تقارن لحد ${MAX_COMPARE_IDS} منتجات بنفس الوكت. / You can compare up to ${MAX_COMPARE_IDS} products at once.`,
      'COMPARE_TOO_MANY',
      { max: MAX_COMPARE_IDS }
    );
  }
  return ids;
}

/**
 * The name to put in a refusal. A refusal that says "product not found" while
 * the visitor is looking at three cards and one empty slot does not tell them
 * WHICH slot is the problem.
 */
const label = (row: ProductRow): string => row.name_ar || row.name || row.slug;

// ----------------------------------------------------------- the comparison

/**
 * GET /api/compare?ids=a,b,c
 *
 * ONE ID IS A LEGITIMATE REQUEST, and it is the first thing the product page
 * does: «قارن» carries the machine the visitor was reading, and the page opens
 * with that column filled and the other slot empty. It answers with the card
 * and `comparison: null` — a comparison of one is not a comparison, and
 * scoring it would declare a single product the winner of every row it happens
 * to have a value for.
 */
compareRoutes.get('/', async (c) => {
  await rateLimit(c, 'compare-read', 120, 60);
  const ids = readIds(c.req.query('ids'));

  const placeholders = ids.map(() => '?').join(',');
  const { results } = await c.env.DB.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM products WHERE id IN (${placeholders})`
  )
    .bind(...ids)
    .all<ProductRow>();
  const byId = new Map((results ?? []).map((r) => [String(r.id), r]));

  // A missing id is answered specifically, and the FIRST place to look is the
  // merchant catalogue: a visitor who pasted a community listing's id deserves
  // to be told this page cannot compare those, not that their product does not
  // exist.
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    const { results: community } = await c.env.DB.prepare(
      `SELECT id FROM community_products WHERE id IN (${missing.map(() => '?').join(',')})`
    )
      .bind(...missing)
      .all<{ id: string }>();
    if ((community ?? []).length) {
      throw badRequest(
        'منتجات المتاجر ما عندها ورقة مواصفات، فما نكدر نقارنها هنا. المقارنة تشتغل على منتجات المتجر الرئيسي. / ' +
          'Merchant listings carry no specification sheet, so they cannot be compared here. Comparison works on the main shop’s products.',
        'COMPARE_MERCHANT_PRODUCT',
        { ids: (community ?? []).map((r) => r.id) }
      );
    }
    throw notFound(
      'واحد من المنتجات ما عاد موجود. / One of the products no longer exists.'
    );
  }

  // Order follows the REQUEST, not the database: the visitor put one machine
  // on the right and one on the left, and an IN list has no order of its own.
  const rows = ids.map((id) => byId.get(id)!);

  const hidden = rows.filter((r) => r.status !== 'active');
  if (hidden.length) {
    throw badRequest(
      `«${label(hidden[0])}» مو معروض حالياً، فما نكدر نقارنه. / “${hidden[0].name || hidden[0].slug}” is not on display right now, so it cannot be compared.`,
      'COMPARE_NOT_VISIBLE'
    );
  }

  const tax = taxonomy(await loadCatalogs(c.env.DB));
  const placed = rows.map((row) => place(row, tax));

  const blank = placed.find((p) => !hasAnySpec(p.specs));
  if (blank) {
    throw badRequest(
      `ما عدنا مواصفات مسجلة لـ«${label(blank.row)}»، فما تصير مقارنة عادلة. / ` +
        `No specifications are recorded for “${blank.row.name || blank.row.slug}”, so there is nothing to compare it on.`,
      'COMPARE_NO_SPECS',
      { product_id: blank.row.id }
    );
  }

  const cards = placed.map(cardOf);
  if (placed.length < 2) return c.json({ success: true, products: cards, comparison: null });

  const comparison: CompareResult = compareProducts({
    products: placed.map((p) => ({
      id: p.row.id,
      product_type: p.productType,
      section_slugs: p.branch.map((b) => b.slug),
      spec_fields: p.specs,
      price_iqd: Number(p.row.price_iqd) || 0,
    })),
  });

  return c.json({ success: true, products: cards, comparison });
});

// ------------------------------------------------------------- the second slot

/**
 * GET /api/compare/candidates?for=<productId>&q=<text>
 *
 * WHAT MAKES THE SECOND SLOT ONE TAP INSTEAD OF A SEARCH. A visitor who
 * arrives from a printer page wants another PRINTER, and most often another
 * printer from the same shelf. So the ranking is: same product type first,
 * same section first within that, and only then whatever the text matches.
 *
 * A candidate with no specification sheet is never offered. Offering one would
 * be offering a tap that ends in `COMPARE_NO_SPECS` — the picker must only
 * show machines the comparison can actually draw.
 */
compareRoutes.get('/candidates', async (c) => {
  await rateLimit(c, 'compare-candidates', 120, 60);
  const anchorId = str(c.req.query('for'), 'for', { min: 1, max: 60 });
  // Bounded by CHARACTERS here and by BYTES inside likePattern. Both are
  // needed: this cap stops a megabyte of query text reaching the pattern
  // builder, and the byte cap is the one D1 actually enforces (50 bytes, which
  // Arabic reaches in 25 letters — see worker/lib/sqlLike.ts).
  const q = str(c.req.query('q'), 'q', { max: 120, required: false });

  // `status = 'active'` is in the QUERY, not a check after it. The reply echoes
  // the anchor's own card, so loading a draft first and refusing second would
  // still have read an unpublished product's name and price into memory on a
  // public route — and one `if` away from returning it.
  const anchor = await c.env.DB
    .prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ? AND status = 'active'`)
    .bind(anchorId)
    .first<ProductRow>();
  if (!anchor) throw notFound('Product not found');

  const tax = taxonomy(await loadCatalogs(c.env.DB));
  const anchorPlaced = place(anchor, tax);
  const anchorSections = new Set(anchorPlaced.branch.map((b) => b.id));
  const anchorLeaf = anchorPlaced.branch[0]?.id ?? '';

  /**
   * The pattern goes through `likePattern`, never `'%' + q + '%'`.
   *
   * D1 refuses a LIKE pattern over 50 BYTES, and Arabic is two bytes a letter,
   * so a hand-built pattern around a term that passed every character cap in
   * this repo is a 500 for exactly the customers this shop is written for.
   * tests/sqlLikeBytes.test.ts greps for the concatenated forms and fails the
   * build; this comment is here so the next person knows that is a real
   * outage, not a lint.
   */
  const pattern = likePattern(q);
  const textClause = pattern ? ` AND (${sqlLikeClause(['name', 'name_ar', 'name_ku'], '?4')})` : '';

  /**
   * SQL narrows and roughly orders; TypeScript ranks. The final ranking needs
   * the product TYPE, which is derived from the catalogue branch and is not a
   * column, so it cannot be an ORDER BY — but shipping the whole catalogue to
   * rank it would be worse. The CASE puts the same shelf and the same section
   * at the front of a bounded pool, and the exact ordering happens over that.
   *
   * COALESCE rather than a bare `=`: comparing NULL to anything is NULL in
   * SQLite, and a NULL sort key makes the ordering depend on where the planner
   * happens to put it.
   */
  const bindings: unknown[] = [anchorId, anchorLeaf, anchor.category_id ?? ''];
  if (pattern) bindings.push(pattern);

  const { results } = await c.env.DB.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM products
      WHERE status = 'active' AND id <> ?1 AND spec_fields <> '{}' AND spec_fields <> ''
      ${textClause}
      ORDER BY (COALESCE(sub_category_id,'') = ?2) DESC,
               (COALESCE(category_id,'') = ?3) DESC,
               created_at DESC
      LIMIT ${CANDIDATE_POOL}`
  )
    .bind(...bindings)
    .all<ProductRow>();

  const scored: Array<{ card: CompareProductCard; score: number }> = [];
  for (const row of results ?? []) {
    const placed = place(row, tax);
    // A sheet that parses to nothing usable is not a candidate, whatever the
    // column said — `spec_fields <> '{}'` catches the default, not a malformed
    // or all-empty document.
    if (!hasAnySpec(placed.specs)) continue;

    let score = 0;
    // SAME TYPE IS THE STRONGEST SIGNAL. A printer compared with a spool of
    // filament shares almost no field, and a picker that offers it is a picker
    // people stop trusting on the first tap.
    if (placed.productType && placed.productType === anchorPlaced.productType) score += 8;
    // Same shelf, then anywhere in the same branch — «طابعات FDM» beats
    // «الطابعات», which still beats an unrelated section.
    if (placed.branch[0] && placed.branch[0].id === anchorLeaf) score += 4;
    else if (placed.branch.some((b) => anchorSections.has(b.id))) score += 2;
    // The text the person typed already filtered the pool; it breaks ties
    // rather than leading, so a search for «بامبو» inside the printers still
    // puts printers first.
    if (pattern) score += 1;
    scored.push({ card: cardOf(placed), score });
  }

  scored.sort((a, b) => b.score - a.score || a.card.price_iqd - b.card.price_iqd);

  return c.json({
    success: true,
    for: cardOf(anchorPlaced),
    products: scored.slice(0, MAX_CANDIDATES).map((s) => s.card),
  });
});
