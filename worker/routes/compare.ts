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
import { adviseFromSpecs, type PowerAdvice } from '../lib/powerAdvice';
import { loadAuthoritativeProductImages } from '../lib/productSelectionImage';
import { parseProductRow } from '../lib/productModel';
import { buildGrid } from '../lib/priceGrid';

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
export const PRODUCT_COLUMNS =
  'id, slug, status, name, name_ar, name_ku, price_iqd, spec_fields, ' +
  'template_family, category_id, sub_category_id, brand_id, condition_doc';

export interface ProductRow {
  id: string;
  slug: string;
  status: string;
  name: string;
  name_ar: string;
  name_ku: string;
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
  /**
   * ON A COMPARISON COLUMN ONLY: the product this column is, when `id` is a
   * slot key rather than a product id. The page needs it for the link to the
   * product page, which knows nothing about slots.
   */
  product_id?: string;
  /** ON A COMPARISON COLUMN ONLY: the option this column is priced and
   *  labelled as, or null for the product as sold at its base price. */
  option?: { id: string; label: Trilingual } | null;
  /**
   * ON A PICKER CARD ONLY, and only when there are at least TWO: the options
   * this product can be added as, so the picker can ask «أي خيار؟» before it
   * adds. Absent — not empty — when there is nothing to ask.
   */
  options?: Array<{ id: string; label: Trilingual }>;
}

const tri = (ar: string, en: string, ckb: string): Trilingual => ({
  ar: ar || en || ckb,
  en: en || ar || ckb,
  ckb: ckb || ar || en,
});

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
export function hasAnySpec(specs: Record<string, unknown>): boolean {
  for (const value of Object.values(specs)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' ? value.trim() !== '' : true) return true;
  }
  return false;
}

/** The whole taxonomy, once. A few dozen rows; the alternative is a recursive
 *  walk per product, which on D1 is a round trip per hop. */
export async function loadCatalogs(db: D1Database): Promise<CatalogRow[]> {
  const { results } = await db
    .prepare('SELECT id, parent_id, slug, name_ar, name_en, name_ckb, template_family FROM catalogs')
    .all<CatalogRow>();
  return results ?? [];
}

export interface Taxonomy {
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
export function taxonomy(catalogs: CatalogRow[]): Taxonomy {
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

export interface Placed {
  row: ProductRow;
  specs: Record<string, unknown>;
  branch: CatalogRow[];
  productType: ProductTypeId | null;
}

/** Everything the comparison needs about one product, from rows already read. */
export function place(row: ProductRow, tax: Taxonomy): Placed {
  const branch = tax.branchOf(row.sub_category_id || row.category_id);
  const family = tax.familyOf(row, branch);
  const refs: SectionRef[] = branch.map((b) => ({ id: b.id, slug: b.slug }));
  return {
    row,
    specs: specSheet(row.spec_fields),
    branch,
    // No family means nobody has ever told the shop what KIND of thing this
    // is, and the product types are defined per family. Null rather than
    // a guess: `compareProducts` treats an unknown type as "compare on what
    // they share", which is the honest answer.
    productType: family ? productTypeForBranch(family, refs) : null,
  };
}

/**
 * «كم تستهلك الطابعة من كهرباء في العراق على 220 فولت … بالأمبيرية وكم تحتاج
 * من الـ UPS» — THE POWER ANSWER, ONE PER COLUMN.
 *
 * NOT A COMPARISON ROW, AND THAT IS THE POINT. The wattages themselves ARE
 * comparison rows already: they are ordinary template fields, so
 * `compareSpecs` picks them up, gives them their trilingual label and their
 * unit and shows them under «الكهرباء والبيئة» with no code here at all — the
 * rule this file's header states, that the comparison owns no definition of
 * what a spec is. What `compareSpecs` cannot do is DIVIDE: it ranks values, it
 * does not turn 350 W into 1.77 A and a 1 kVA UPS. That arithmetic lives in
 * worker/lib/powerAdvice.ts, which is pure, and this is the one line that
 * feeds it the sheet.
 *
 * ORDERED POINTS, NOT A SECOND TABLE — «لا يتم وضعها بشكل جداول وهوسه
 * وخربطه». `advice.points` is a numbered list of sentences in all three
 * languages, and `advice.assumptions` carries the figures those sentences were
 * built from, so the page can show the reader the arithmetic instead of asking
 * them to trust it.
 *
 * `known: false` FOR A PRINTER NOBODY ENTERED WATTS FOR, with no points at
 * all. A power section assembled out of «غير مذكور» reads as a statement about
 * the machine when it is a statement about our own data entry — the same D1
 * rule compareSpecs applies to every other missing value.
 */
export function powerOf(p: Placed): PowerAdvice {
  return adviseFromSpecs(p.specs);
}

export function cardOf(p: Placed, image: string | null = null): CompareProductCard {
  const leaf = p.branch[0];
  return {
    id: p.row.id,
    slug: p.row.slug,
    name: tri(p.row.name_ar, p.row.name, p.row.name_ku),
    image,
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
 * to the same SLOT is a mistake nobody needs to be told about.
 *
 * A SLOT IS `productId` OR `productId:optionId`.
 *
 * «خاصه الطابعات التي تحمل ليزر او كومبو فيه جهاز ams فهذا يفرق — مثلا يقارن
 *  بين طابعه ونفس الطابعه لكن الخيار يختلف.»
 *
 * The same printer bought as Combo and as the bare unit is two different
 * purchases at two different prices, and until now the page could not address
 * the difference at all: the ids were product ids, so the two columns would
 * have collapsed into one. The option id rides in the same string, which keeps
 * the whole comparison a LINK someone can send — the property this file's
 * header calls the feature.
 */
/** One column of the comparison: a product, optionally narrowed to one of its
 *  option values. */
interface CompareSlot {
  /** Exactly what was in the URL — the id the page removes and replaces by. */
  key: string;
  productId: string;
  optionId: string | null;
}

function readIds(raw: string | undefined): CompareSlot[] {
  const slots: CompareSlot[] = [];
  const ids: string[] = [];
  for (const piece of String(raw ?? '').split(',')) {
    const key = piece.trim();
    if (!key) continue;
    if (key.length > 96) throw badRequest('One of the product ids is not a product id', 'COMPARE_BAD_ID');
    const cut = key.indexOf(':');
    const productId = cut < 0 ? key : key.slice(0, cut);
    const optionId = cut < 0 ? null : key.slice(cut + 1);
    if (!productId || productId.length > 60) {
      throw badRequest('One of the product ids is not a product id', 'COMPARE_BAD_ID');
    }
    if (optionId !== null && (!optionId || optionId.length > 60 || optionId.includes(':'))) {
      throw badRequest('One of the option ids is not an option id', 'COMPARE_BAD_ID');
    }
    // DEDUPED ON THE WHOLE SLOT, not on the product. «يقارن بين طابعه ونفس
    // الطابعه لكن الخيار يختلف» is the case this page exists for now, and
    // collapsing it on the product id would silently delete the second column.
    if (!ids.includes(key)) {
      ids.push(key);
      slots.push({ key, productId, optionId });
    }
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
  return slots;
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
  const slots = readIds(c.req.query('ids'));
  // One product may fill two slots — the whole point of the option id — so the
  // lookup is over the DISTINCT products, and the columns are rebuilt from the
  // slots afterwards.
  const ids = [...new Set(slots.map((slot) => slot.productId))];

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
  // One row per SLOT, so the same product appearing twice under two options is
  // two columns.
  const rows = slots.map((slot) => byId.get(slot.productId)!);

  const hidden = rows.filter((r) => r.status !== 'active');
  if (hidden.length) {
    throw badRequest(
      `«${label(hidden[0])}» مو معروض حالياً، فما نكدر نقارنه. / “${hidden[0].name || hidden[0].slug}” is not on display right now, so it cannot be compared.`,
      'COMPARE_NOT_VISIBLE'
    );
  }

  const [catalogRows, images] = await Promise.all([
    loadCatalogs(c.env.DB),
    loadAuthoritativeProductImages(c.env.DB, ids),
  ]);
  /**
   * THE OPTIONS COME OFF THE ROW, not out of a second query. `options` is a
   * PRODUCT_COLUMNS column, and `parseProductRow` is the one parser for it —
   * the same one the product page and the admin form read, so an option that
   * was upgraded or renumbered cannot mean one thing here and another there.
   */
  const docById = new Map(ids.map((id) => [id, parseProductRow(byId.get(id) as unknown as Record<string, unknown>)]));
  const tax = taxonomy(catalogRows);
  const placed = rows.map((row) => place(row, tax));

  /**
   * THE OPTION EACH COLUMN IS PRICED AS, resolved before anything is drawn.
   *
   * An option id that is not this product's, or is not active any more, is
   * REFUSED BY NAME rather than quietly falling back to the base product: a
   * shared link that silently changed which configuration it compares is worse
   * than one that says the configuration is gone. The shape blames one
   * `product_id`, the same shape `COMPARE_NO_SPECS` uses, so the page's "drop
   * that column" affordance works on it unchanged.
   */
  const picked = slots.map((slot) => {
    if (!slot.optionId) return null;
    const option = docById.get(slot.productId)?.options.find((o) => o.id === slot.optionId);
    if (!option || option.active === false) {
      const row = byId.get(slot.productId)!;
      throw badRequest(
        `الخيار المطلوب من «${label(row)}» ما عاد موجود. / ` +
          `The requested option of “${row.name || row.slug}” no longer exists.`,
        'COMPARE_OPTION_NOT_FOUND',
        { product_id: slot.productId, option_id: slot.optionId }
      );
    }
    return option;
  });

  /**
   * THE PRICE OF A CHOSEN OPTION COMES FROM `buildGrid`, never from arithmetic
   * written here.
   *
   * An option's regular price is a LADDER — an absolute override, or an
   * adjustment measured from the product's own price, clamped against the
   * member tiers — and packages/pricing/src/priceGrid.ts is the one
   * implementation of it, the same one the admin grid and the TXT export read.
   * A second copy in this file would start agreeing and end disagreeing, and
   * the number it disagreed about would be a price on a page whose whole job
   * is telling someone which machine to buy.
   */
  const priceOf = (index: number): number => {
    const option = picked[index];
    const doc = docById.get(slots[index].productId)!;
    const base = Number(doc.price_iqd) || 0;
    if (!option) return base;
    const grid = buildGrid({
      price_iqd: base,
      prime_price_iqd: doc.prime_price_iqd,
      pro_price_iqd: doc.pro_price_iqd,
      product_cost_iqd: doc.product_cost_iqd,
      selling_type: doc.selling_type,
      sale_types: doc.sale_types,
      options: doc.options,
      colors: doc.colors,
    });
    const line = grid.find((g) => g.level === 'option' && g.id === option.id);
    return line?.cells.regular.effective ?? base;
  };

  /**
   * «في المقارنة … يجب أن يكون الفيلمنت مقابل الفيلمنت الطابعة مقابل الطابعة».
   *
   * A RULE, NOT A LABEL. The engine already NOTICED a mixed set —
   * `basisOf` answers `basis: 'mixed'` and the page printed «مقارنة مختلطة:
   * المنتجات مو من نوع واحد» over it — and then drew the comparison anyway.
   * Two things with almost no field in common produce a table of «غير مذكور»
   * and a score built out of whatever three attributes happen to overlap,
   * which is worse than no answer: it looks like a verdict.
   *
   * Only a KNOWN, DIFFERENT type is a contradiction. A product whose branch
   * does not name a type resolves to `null`, and refusing on that would make
   * an unclassified product uncomparable with anything — a taxonomy gap
   * turned into a dead page. So `null` is "not stated", never "different".
   *
   * It is refused BEFORE the spec-sheet check, because a filament next to a
   * printer is not a product the right sheet would fix, and it blames one
   * `product_id` in the shape `COMPARE_NO_SPECS` already uses — that is what
   * lets the page offer to drop that column and carry on rather than showing
   * a dead end.
   */
  const typed = placed.filter((p) => p.productType !== null);
  if (typed.length > 1) {
    /**
     * THE COLUMN TO BLAME IS THE MINORITY ONE, not whichever type happens to
     * be first in the URL.
     *
     * The refusal exists to be ACTED ON — the page reads `product_id` and
     * offers to drop that column. On «spool, printer, printer» a
     * first-wins rule blames a printer, and dropping it leaves «spool,
     * printer», still refused: the affordance would be wrong on its first tap
     * and would take two. Counting instead means the one tap always resolves
     * it, and on a tie of two it is the second column that goes, which is the
     * one the visitor added last.
     */
    const counts = new Map<string, number>();
    for (const p of typed) counts.set(p.productType as string, (counts.get(p.productType as string) ?? 0) + 1);
    let majority = typed[0].productType as string;
    for (const [type, n] of counts) {
      if (n > (counts.get(majority) ?? 0)) majority = type;
    }
    const odd = typed.find((p) => p.productType !== majority);
    const keeper = typed.find((p) => p.productType === majority)!;
    if (odd) {
      throw badRequest(
        `المقارنة تصير بين أشياء من نفس النوع — فيلمنت مقابل فيلمنت وطابعة مقابل طابعة. ` +
          `«${label(odd.row)}» مو من نفس نوع «${label(keeper.row)}». / ` +
          `A comparison is between things of the same kind — filament against filament, ` +
          `printer against printer. “${odd.row.name || odd.row.slug}” is not the same kind as ` +
          `“${keeper.row.name || keeper.row.slug}”.`,
        'COMPARE_TYPE_MISMATCH',
        { product_id: odd.row.id, expected_type: majority, got_type: odd.productType }
      );
    }
  }

  const blank = placed.find((p) => !hasAnySpec(p.specs));
  if (blank) {
    throw badRequest(
      `ما عدنا مواصفات مسجلة لـ«${label(blank.row)}»، فما تصير مقارنة عادلة. / ` +
        `No specifications are recorded for “${blank.row.name || blank.row.slug}”, so there is nothing to compare it on.`,
      'COMPARE_NO_SPECS',
      { product_id: blank.row.id }
    );
  }

  /**
   * THE CARD IS THE SLOT, not the product.
   *
   * `card.id` is what the page removes by, replaces by and writes back into
   * `?ids=`. Giving it the slot key is what makes «نفس الطابعه لكن الخيار
   * يختلف» round-trip: two columns of one printer are two ids, and closing
   * either one closes the right column. The option travels beside it so the
   * column can be labelled «X1C · كومبو» rather than showing the same name
   * twice with two different prices and no explanation.
   */
  const cards = placed.map((product, i) => {
    const option = picked[i];
    return {
      ...cardOf(product, images.get(product.row.id) || null),
      id: slots[i].key,
      product_id: product.row.id,
      price_iqd: priceOf(i),
      option: option
        ? { id: option.id, label: tri(option.name_ar, option.name_en, option.name_ckb) }
        : null,
    };
  });
  /**
   * ALIGNED WITH `products`, INDEX FOR INDEX, and emitted for a single column
   * too. The product page opens «قارن» with one machine already in place and
   * the other slot empty; the mains question is exactly as real then as it is
   * with two columns, and a customer who never adds a second printer still
   * deserves to be told what his one printer draws and what UPS carries it.
   *
   * A SEPARATE KEY RATHER THAN A FIELD ON THE CARD. `CompareProductCard` is
   * also what `/candidates` and the support assistant's second-slot picker
   * return — up to `CANDIDATE_POOL` of them per request — and hanging the
   * advice off the card would compute a UPS sizing for twelve machines nobody
   * asked about, on a public, rate-limited route.
   */
  const power = placed.map(powerOf);
  if (placed.length < 2) return c.json({ success: true, products: cards, power, comparison: null });

  const comparison: CompareResult = compareProducts({
    products: placed.map((p, i) => ({
      // The SLOT id, so a comparison of one printer against itself under two
      // options has two distinguishable columns rather than one id twice.
      id: slots[i].key,
      product_type: p.productType,
      section_slugs: p.branch.map((b) => b.slug),
      spec_fields: p.specs,
      // The price of the CONFIGURATION, from buildGrid — see priceOf above.
      // The spec sheet is the product's; the price is the option's, and the
      // price row is the one line where the two columns genuinely differ.
      price_iqd: priceOf(i),
    })),
  });

  return c.json({ success: true, products: cards, power, comparison });
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
/**
 * WHAT IS WORTH COMPARING WITH THIS ONE — the single ranking.
 *
 * Extracted from the /candidates route because it has a SECOND caller: the
 * support assistant offers the same second-slot choices when someone names one
 * printer and not the other. Two rankings would start agreeing and end
 * disagreeing — the picker offering a machine the assistant never suggests —
 * which is the same drift this file's header refuses for spec definitions.
 */
export async function rankCompareCandidates(
  db: D1Database,
  anchorPlaced: Placed,
  tax: Taxonomy,
  q: string,
  limit: number
): Promise<CompareProductCard[]> {
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
  const bindings: unknown[] = [anchorPlaced.row.id, anchorLeaf, anchorPlaced.row.category_id ?? ''];
  if (pattern) bindings.push(pattern);

  const { results } = await db.prepare(
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

  const scored: Array<{ placed: Placed; score: number }> = [];
  for (const row of results ?? []) {
    const placed = place(row, tax);
    // A sheet that parses to nothing usable is not a candidate, whatever the
    // column said — `spec_fields <> '{}'` catches the default, not a malformed
    // or all-empty document.
    if (!hasAnySpec(placed.specs)) continue;

    /**
     * SAME TYPE IS NOT A PREFERENCE ANY MORE, IT IS THE GATE.
     *
     * It used to be the strongest SCORE (+8), which meant a printer's picker
     * still listed spools once the printers ran out — and GET /api/compare
     * now refuses that pair by name, so every one of those rows was a tap
     * that ends in a refusal. The picker must only show what the comparison
     * will actually draw, which is the same rule that keeps a product with no
     * spec sheet out of this list.
     *
     * Gated on the ANCHOR having a known type: a product whose branch names
     * none would otherwise have an empty picker, and an unclassified product
     * that can be compared with nothing is a taxonomy gap turned into a dead
     * feature. There the old ranking still applies and the refusal above
     * cannot fire either, because `null` is "not stated", never "different".
     */
    if (anchorPlaced.productType !== null && placed.productType !== anchorPlaced.productType) continue;

    let score = 0;
    // Kept as a score as well as a gate: with no anchor type, this is still
    // the strongest signal among a mixed pool.
    if (placed.productType && placed.productType === anchorPlaced.productType) score += 8;
    // Same shelf, then anywhere in the same branch — «طابعات FDM» beats
    // «الطابعات», which still beats an unrelated section.
    if (placed.branch[0] && placed.branch[0].id === anchorLeaf) score += 4;
    else if (placed.branch.some((b) => anchorSections.has(b.id))) score += 2;
    // The text the person typed already filtered the pool; it breaks ties
    // rather than leading, so a search for «بامبو» inside the printers still
    // puts printers first.
    if (pattern) score += 1;
    scored.push({ placed, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (Number(a.placed.row.price_iqd) || 0) - (Number(b.placed.row.price_iqd) || 0)
  );
  const selected = scored.slice(0, limit).map((candidate) => candidate.placed);
  const images = await loadAuthoritativeProductImages(
    db,
    selected.map((candidate) => candidate.row.id)
  );
  return selected.map((candidate) =>
    withOptions(cardOf(candidate, images.get(candidate.row.id) || null), candidate.row)
  );
}

/**
 * THE OPTIONS A CARD CAN BE ADDED AS, so the picker can ask before it adds.
 *
 * «اجعل عند الضغط على إضافة يظهر نافذة منبثقة يختار الخيار قبل الإضافة للمقارنه
 *  خاصه الطابعات التي تحمل ليزر او كومبو فيه جهاز ams فهذا يفرق.»
 *
 * ONLY WHEN THERE IS SOMETHING TO ASK. A product with one active option — or
 * none — is added straight away: a popup offering a single answer is a tap the
 * customer pays for and learns nothing from. Fewer than two, and the key is
 * absent rather than an empty array, so the client's test is simply "is there
 * a list".
 *
 * It is read off the row's own `options` column through `parseProductRow`, the
 * same parser the product page uses, so the names in the popup are the names
 * on the product page.
 */
function withOptions(card: CompareProductCard, row: ProductRow): CompareProductCard {
  const doc = parseProductRow(row as unknown as Record<string, unknown>);
  const active = doc.options.filter((o) => o.active !== false);
  if (active.length < 2) return card;
  return {
    ...card,
    options: active.map((o) => ({ id: o.id, label: tri(o.name_ar, o.name_en, o.name_ckb) })),
  };
}

/**
 * WHAT CAN BE COMPARED AT ALL — the FIRST slot, with nothing to rank against.
 *
 * Deliberately not a second copy of `rankCompareCandidates` with the anchor
 * bits removed: there is no ranking to do. The catalogue's own order is the
 * honest answer, the search text narrows it, and the ONE rule both lists share
 * — never offer a product the comparison cannot draw — is applied here in the
 * same two places, the SQL predicate and `hasAnySpec`.
 */
export async function browseCompareCandidates(
  db: D1Database,
  tax: Taxonomy,
  q: string,
  limit: number
): Promise<CompareProductCard[]> {
  // Through `likePattern`, never `'%' + q + '%'` — D1 refuses a LIKE pattern
  // over 50 BYTES and Arabic is two bytes a letter. See the long note in
  // rankCompareCandidates; tests/sqlLikeBytes.test.ts fails the build on the
  // concatenated form.
  const pattern = likePattern(q);
  const textClause = pattern ? ` AND (${sqlLikeClause(['name', 'name_ar', 'name_ku'], '?1')})` : '';
  const bindings: unknown[] = pattern ? [pattern] : [];

  const { results } = await db.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM products
      WHERE status = 'active' AND spec_fields <> '{}' AND spec_fields <> ''
      ${textClause}
      ORDER BY created_at DESC
      LIMIT ${CANDIDATE_POOL}`
  )
    .bind(...bindings)
    .all<ProductRow>();

  const placed = (results ?? [])
    .map((row) => place(row, tax))
    // `spec_fields <> '{}'` catches the default, not a malformed or all-empty
    // document — the same second look the anchored path takes.
    .filter((candidate) => hasAnySpec(candidate.specs))
    .slice(0, limit);

  const images = await loadAuthoritativeProductImages(db, placed.map((candidate) => candidate.row.id));
  return placed.map((candidate) =>
    withOptions(cardOf(candidate, images.get(candidate.row.id) || null), candidate.row)
  );
}

/**
 * `for` IS OPTIONAL, AND THAT IS THE «زر لاضافه الطابعه».
 *
 * «عند الضغط على المقارنة فإنه يظهر فقط الذي شاهدته مؤخرا أريد أن يكون زر
 *  لاضافه الطابعه.» With nothing placed there is no anchor to rank against,
 * and the page's only way in was the last product this browser happened to
 * look at. Somebody who has just arrived — or who cleared their storage, or
 * who wants a machine unlike the one they were reading — had no way to start a
 * comparison at all.
 *
 * Without an anchor the ranking cannot be "like this one", so it is the
 * catalogue's own order — newest first — narrowed by the search text, and it
 * answers `for: null`. Everything else is identical, INCLUDING the rule that
 * a product with no specification sheet is never offered: a tap that ends in
 * `COMPARE_NO_SPECS` is a tap that teaches people not to tap, and that is as
 * true on the first slot as on the second.
 *
 * There is no type gate here, on purpose. With no anchor there is no type to
 * gate ON, and this list only ever fills the FIRST slot — from the second
 * onwards the anchored path takes over and applies it. Hiding filament from
 * somebody who came to compare filament would be the worse failure.
 */
compareRoutes.get('/candidates', async (c) => {
  await rateLimit(c, 'compare-candidates', 120, 60);
  const anchorId = str(c.req.query('for'), 'for', { max: 60, required: false });
  // Bounded by CHARACTERS here and by BYTES inside likePattern. Both are
  // needed: this cap stops a megabyte of query text reaching the pattern
  // builder, and the byte cap is the one D1 actually enforces (50 bytes, which
  // Arabic reaches in 25 letters — see worker/lib/sqlLike.ts).
  const q = str(c.req.query('q'), 'q', { max: 120, required: false });

  // `status = 'active'` is in the QUERY, not a check after it. The reply echoes
  // the anchor's own card, so loading a draft first and refusing second would
  // still have read an unpublished product's name and price into memory on a
  // public route — and one `if` away from returning it.
  if (!anchorId) {
    const tax = taxonomy(await loadCatalogs(c.env.DB));
    return c.json({
      success: true,
      for: null,
      products: await browseCompareCandidates(c.env.DB, tax, q, MAX_CANDIDATES),
    });
  }

  const anchor = await c.env.DB
    .prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ? AND status = 'active'`)
    .bind(anchorId)
    .first<ProductRow>();
  if (!anchor) throw notFound('Product not found');

  const [catalogRows, images] = await Promise.all([
    loadCatalogs(c.env.DB),
    loadAuthoritativeProductImages(c.env.DB, [anchor.id]),
  ]);
  const tax = taxonomy(catalogRows);
  const anchorPlaced = place(anchor, tax);

  return c.json({
    success: true,
    for: withOptions(cardOf(anchorPlaced, images.get(anchor.id) || null), anchor),
    products: await rankCompareCandidates(c.env.DB, anchorPlaced, tax, q, MAX_CANDIDATES),
  });
});
