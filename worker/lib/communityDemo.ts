/**
 * COMMUNITY DEMO DATA — «أضف بيانات وهمية للمجتمع للتجربة، وأحذفها كلها بسهولة».
 *
 * The owner tests Levo Community on the live site while it is CLOSED
 * (worker/lib/communityGate.ts). This seeds a coherent set of demo makers,
 * workshops, projects, social activity, print requests and pending offers in
 * ONE batch, and removes every one of them in ONE batch.
 *
 * HOW A DEMO ROW IS KNOWN. By its primary id alone: `demo_` + the shape
 * `newId()` mints (packages/contracts/src/demoData.ts). The ids here are
 * FIXED, not random — the seed is the same set every time, so a second
 * press (or two presses racing) cannot create a second copy: a race ends on
 * the primary keys and the loser reports «already present». Rows without an
 * id of their own (a like, a save, a follow, a workshop's preferences) are
 * demo because the user, post or merchant they name is.
 *
 * WHAT IS NEVER CREATED. No product (nothing enters the catalogue, a feed, a
 * sitemap or a cart), no accepted offer, no order, no escrow, no wallet or
 * ledger row, no chat, no notification, no outbox row, no session. Demo users
 * have no password, no Google subject, no phone and a `.invalid` address, and
 * worker/lib/session.ts refuses to open a session for one anyway.
 *
 * WHO TOUCHES WHAT. Demo users interact only with demo content, so seeding
 * moves no real counter. Real testers may interact with demo content (like a
 * demo project, follow a demo shop, offer on a demo request); the removal
 * deletes those interactions WITH the demo content, and the counters the
 * triggers of 0154 keep move only on the demo rows being deleted. A real
 * request's `offer_count` is recomputed if a demo merchant's offer is ever
 * found on one.
 *
 * WHERE IT MAY NOT REACH. Seeding is refused while the community is open to
 * the public, and opening the gate is refused while demo rows exist
 * (worker/routes/adminCommunity.ts). Outside the wall, a demo store is hidden
 * like a sanctioned one (`storeHiddenFromPublic`), the public API and the
 * share cards leave demo rows out, the matcher never pairs a demo row with a
 * real one, and email to a demo address is never sent.
 */
import { DEMO_EMAIL_DOMAIN, DEMO_ID_PREFIX, isDemoId } from '../../packages/contracts/src/demoData';
import { HttpError } from './http';
import { listing } from './listing';
import { isAnonymousPublicMediaKey } from './mediaStorage';
import { DEMO_COMMENTS, DEMO_IDEAS, DEMO_MAKER_COUNT, DEMO_PEOPLE, DEMO_PRINTERS, DEMO_PRODUCTS, DEMO_REPLIES, DEMO_REQUESTS, DEMO_SHOPS, type DemoLang } from './communityDemoData';
import { makeBlock, normalizeLayout } from '@levonis/storeLayout/normalize';
import { starterLayout } from '@levonis/storeLayout/starters';
import { FOOTER_VARIANTS, HEADER_VARIANTS, SCHEMA_VERSION, defaultFooter, defaultHeader, type StoreBlock, type StoreLayout } from '@levonis/storeLayout/schema';
import {
  ACCENT_TOKENS, CARD_STYLES, DENSITIES, GRID_COLUMNS, IMAGE_RATIOS, PRODUCT_CARDS, RADII, SECTION_SPACING, SURFACES, THEME_NAMES, THEME_PRESETS, TYPOGRAPHY, WIDTHS,
} from '@levonis/storeLayout/tokens';

/**
 * NO MONEY ON A DEMO ROW. A ledger line, a payout or a wallet line naming a
 * demo merchant or account would block «حذف كل البيانات التجريبية» for good
 * (DEMO_REMOVE_BLOCKED) and so keep the community shut; the admin money doors
 * that take an id (merchant payout and adjustment, the wallet adjustment)
 * refuse one first.
 */
export function refuseDemoMoney(id: unknown): void {
  if (isDemoId(id)) {
    throw new HttpError(409, 'هذا حساب تجريبي، لا تُسجَّل له أموال / This is community demo data; no money is recorded for it', 'DEMO_NO_MONEY');
  }
}

/** A column holds a demo id. `substr`, not LIKE: `_` is a LIKE wildcard. */
export const demoIdSql = (col: string) => `substr(${col}, 1, ${DEMO_ID_PREFIX.length}) = '${DEMO_ID_PREFIX}'`;
/** A column holds no demo id (NULL counts as not demo). */
export const notDemoSql = (col: string) => `COALESCE(substr(${col}, 1, ${DEMO_ID_PREFIX.length}), '') <> '${DEMO_ID_PREFIX}'`;

/** A fixed demo id with `newId()`'s shape: `demo_<tag>_` + twenty characters. */
export const demoId = (tag: string, n: number) => `${DEMO_ID_PREFIX}${tag}_${String(n).padStart(20, '0')}`;


// ------------------------------------------------------------------ store builder

const HERO_VARIANTS = ['profile', 'cover', 'split', 'minimal'] as const;

/**
 * ONE WORKSHOP'S PAGE, BUILT WITH THE STORE BUILDER'S OWN PARTS — the theme
 * preset's starter (packages/storeLayout/src/starters.ts), every token turned
 * the way a merchant turns it in the builder, a hero variant, and the blocks
 * a workshop adds: its story, a FAQ, a call to order, its numbers, reviews,
 * services, its work and its machines. Across the fifteen workshops every
 * theme, every token value, every header and footer variant and every hero
 * variant appears at least once. The result passes the builder's own
 * normaliser (`normalizeLayout`, the single write path of
 * worker/routes/storeLayout.ts) with no issue, or the seed refuses to run.
 *
 * No media in the layout: the builder accepts only the merchant's own uploads
 * (merchants/<uid>/public/…), and the demo set never copies or uploads a
 * picture. The hero shows the store's banner, which is a reused catalogue
 * picture (an empty hero image means «the store's own»).
 */
export function demoStoreLayout(i: number, shop: { tagline: string; description: string }, lang: Lang, ownerUserId: string): StoreLayout {
  const theme = THEME_NAMES[i % THEME_NAMES.length];
  const base = starterLayout(theme);
  const tokens = {
    ...THEME_PRESETS[theme],
    accent: ACCENT_TOKENS[i % ACCENT_TOKENS.length],
    surface: SURFACES[i % SURFACES.length],
    radius: RADII[i % RADII.length],
    density: DENSITIES[(i + 1) % DENSITIES.length],
    typography: TYPOGRAPHY[i % TYPOGRAPHY.length],
    card: CARD_STYLES[(i + 2) % CARD_STYLES.length],
    product_card: PRODUCT_CARDS[i % PRODUCT_CARDS.length],
    image_ratio: IMAGE_RATIOS[(i + 1) % IMAGE_RATIOS.length],
    section_spacing: SECTION_SPACING[i % SECTION_SPACING.length],
    grid_columns: GRID_COLUMNS[i % GRID_COLUMNS.length],
    width: WIDTHS[(i + 1) % WIDTHS.length],
  };
  // The builder's text is per language ({ar, en, ckb}); the shop's own words go in the slot of the language they are written in.
  const w = (ar: string, en: string, ku: string) => ({ ar, en, ckb: ku });
  const own = (text: string) => ({ [lang === 'ku' ? 'ckb' : lang]: text });
  const extra: StoreBlock[] = [
    makeBlock('text', 'story', { variant: i % 2 ? 'callout' : 'plain', settings: { title: w('قصتنا', 'Our story', 'چیرۆکی ئێمە'), body: own(shop.description), align: i % 3 ? 'start' : 'center' } }),
    makeBlock('faq', 'faq', {
      settings: {
        title: w('أسئلة متكررة', 'Questions we hear', 'پرسیارە باوەکان'),
        items: [
          { q: w('كم يستغرق الطلب؟', 'How long does an order take?', 'داواکاری چەند دەخایەنێت؟'), a: w('بين ثلاثة وعشرة أيام حسب الحجم.', 'Three to ten days, depending on size.', 'سێ بۆ دە ڕۆژ بەپێی قەبارە.') },
          { q: w('هل تطبعون من صورة فقط؟', 'Can you print from a photo?', 'دەتوانن لە وێنەوە چاپ بکەن؟'), a: w('نعم، نرسم القطعة أولًا ونرسل لك المعاينة.', 'Yes — we model it first and send a preview.', 'بەڵێ، سەرەتا دیزاینی دەکەین و پێشبینینەکەت بۆ دەنێرین.') },
          { q: w('أي خامات تتوفر؟', 'Which materials do you stock?', 'کام کەرەستە هەیە؟'), a: w('PLA وPETG وASA والريزن.', 'PLA, PETG, ASA and resin.', 'PLA و PETG و ASA و ڕێزن.') },
        ],
      },
    }),
    makeBlock('cta', 'order', { variant: i % 2 ? 'subtle' : 'accent', settings: { title: w('عندك فكرة؟', 'Got an idea?', 'بیرۆکەیەکت هەیە؟'), body: own(shop.tagline), label: w('تصفح المنتجات', 'Browse products', 'بەرهەمەکان ببینە'), link: { kind: 'route', route: 'products' } } }),
  ];
  const have = new Set(base.blocks.map((b) => b.type));
  const maybe = (type: Parameters<typeof makeBlock>[0], id: string, opts?: Parameters<typeof makeBlock>[2]) => {
    if (!have.has(type)) extra.push(makeBlock(type, id, opts));
  };
  maybe('stats', 'stats', { variant: i % 2 ? 'cards' : 'row' });
  maybe('reviews', 'reviews', { variant: i % 2 ? 'list' : 'cards' });
  maybe('services', 'services', { variant: i % 2 ? 'grid' : 'list' });
  maybe('showcase', 'showcase', { variant: i % 2 ? 'grid' : 'grouped' });
  maybe('printers', 'printers', { variant: i % 2 ? 'list' : 'cards' });
  maybe('products_grid', 'products', { settings: { source: 'latest', limit: 8 } });
  maybe('contact', 'contact');
  const blocks = base.blocks.map((b) =>
    b.type === 'hero' ? makeBlock('hero', b.id, { variant: HERO_VARIANTS[i % HERO_VARIANTS.length], settings: { subheadline: own(shop.tagline) } }) : b
  );
  const layout: StoreLayout = {
    ...base,
    tokens,
    header: defaultHeader(HEADER_VARIANTS[i % HEADER_VARIANTS.length]),
    footer: defaultFooter(FOOTER_VARIANTS[i % FOOTER_VARIANTS.length]),
    blocks: [...blocks, ...extra],
  };
  const checked = normalizeLayout(layout, { ownerUserId });
  if (!checked.ok || checked.issues.length) {
    throw new Error(`demo store layout ${i}: ${JSON.stringify(checked.issues.slice(0, 5))}`);
  }
  return checked.layout;
}

// ------------------------------------------------------------------ the set

/**
 * A picture the seed may show: a key of a PUBLISHED catalogue product's own
 * image (product_images.url = /files/<key>), reused by reference — never
 * copied, uploaded or deleted. The demo rows only point at it; removing them
 * removes the pointer (worker/lib/mediaRefs.ts keeps counting product_images
 * as a reference, so no cleanup ever treats the object as orphaned, and the
 * removal enqueues no media cleanup at all).
 */
export interface DemoImage {
  key: string;
  width: number | null;
  height: number | null;
}

/**
 * The pictures the seed reuses: the images of products a customer may see,
 * the makers' kind of thing first (anything that is not a printer, a material,
 * an accessory or a used item), then the rest, at most 160. An empty
 * catalogue seeds no pictures, and the cards show their drawn placeholders.
 */
export async function demoImagePool(db: D1Database): Promise<DemoImage[]> {
  try {
    const visible = (await listing(db)).visible('p');
    const { results } = await db
      .prepare(
        `SELECT i.url, i.width, i.height
           FROM product_images i
           JOIN products p ON p.id = i.product_id
          WHERE ${visible} AND i.url LIKE '/files/products/%' AND i.url LIKE '%.webp'
          ORDER BY CASE WHEN COALESCE(p.category_id, '') LIKE 'cat_printers%'
                          OR COALESCE(p.category_id, '') LIKE 'cat_materials%'
                          OR COALESCE(p.category_id, '') LIKE 'cat_pacc%'
                          OR COALESCE(p.category_id, '') LIKE 'cat_used%' THEN 1 ELSE 0 END,
                   p.id, i.is_primary DESC, i.sort_order, i.id
          LIMIT 160`
      )
      .all<{ url: string; width: number | null; height: number | null }>();
    const seen = new Set<string>();
    const out: DemoImage[] = [];
    for (const row of results ?? []) {
      const key = String(row.url).slice('/files/'.length);
      if (!isAnonymousPublicMediaKey(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, width: row.width ?? null, height: row.height ?? null });
    }
    return out;
  } catch (e) {
    console.error('demo seed: no catalogue pictures', e instanceof Error ? e.message : String(e));
    return [];
  }
}

/** A fixed pseudo-random sequence, so the same press always writes the same set. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const uid = (n: number) => demoId('usr', n);
const mid = (n: number) => demoId('mch', n);
const sid = (n: number) => demoId('str', n);
const pick = <T>(xs: readonly T[], r: () => number): T => xs[Math.floor(r() * xs.length)];
const shuffle = <T>(xs: readonly T[], r: () => number): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/** One table's rows, column by column. */
export interface DemoRows {
  table: string;
  columns: string[];
  rows: unknown[][];
}

export interface DemoPlan {
  tables: DemoRows[];
  /** Counted the way `demoCounts` counts them. */
  counts: DemoCounts;
}

/** The tables the seed writes, in the order the status reports them. */
export const DEMO_TABLES = [
  'users',
  'community_merchants',
  'merchant_stores',
  'merchant_printers',
  'merchant_request_prefs',
  'merchant_showcase',
  'merchant_store_sections',
  'merchant_services',
  'store_layout_revisions',
  'community_products',
  'merchant_reviews',
  'community_posts',
  'community_post_media',
  'community_comments',
  'community_likes',
  'community_saves',
  'user_follows',
  'follows',
  'community_requests',
  'community_offers',
] as const;
export type DemoTable = (typeof DEMO_TABLES)[number];
export type DemoCounts = Record<DemoTable, number>;

/** How many posts and how many print requests the set has. */
export const DEMO_POST_COUNT = 120;
export const DEMO_REQUEST_COUNT = 30;

const offerWords = (lang: Lang, material: string, days: number) =>
  lang === 'en'
    ? `We can print this in ${material}, ready in ${days} days.`
    : lang === 'ku'
      ? `دەتوانین بە ${material} چاپی بکەین، لە ${days} ڕۆژدا ئامادە دەبێت.`
      : `نطبعها بـ ${material} وتكون جاهزة خلال ${days} أيام.`;

/**
 * THE WHOLE SET AS ROWS — 40 accounts (25 makers, 15 of them running one of
 * 15 workshops across nine governorates, and 15 customers), 120 posts over
 * the last 60 days with their pictures, comments and replies, likes, saves
 * and follows, and 30 open requests with 1–4 pending offers each.
 * Deterministic: the same `nowMs`, pictures and admin give the same rows.
 *
 * `adminId` — the admin who pressed «إضافة»: they follow eight demo makers
 * and four demo workshops and save four projects, so «أتابعهم» and
 * «المحفوظة» have something to show the person testing. Those rows name demo
 * rows, so the removal takes them too.
 */
export function buildDemoPlan(opts: { nowMs: number; images: readonly DemoImage[]; adminId?: string | null }): DemoPlan {
  const { nowMs, images } = opts;
  const r = rng(20261117);
  const at = (hoursAgo: number) => new Date(nowMs - Math.round(hoursAgo * 3_600_000)).toISOString();
  const ahead = (days: number) => new Date(nowMs + days * 86_400_000).toISOString();
  const img = (n: number) => (images.length ? images[((n % images.length) + images.length) % images.length] : null);
  const tables: DemoRows[] = [];
  const add = (table: string, columns: string[], rows: unknown[][]) => {
    if (rows.length) tables.push({ table, columns, rows });
  };
  const people = DEMO_PEOPLE.map((p, i) => ({ ...p, n: i + 1 }));
  const makers = people.slice(0, DEMO_MAKER_COUNT);
  const customers = people.slice(DEMO_MAKER_COUNT);
  const now = at(0);
  const printerName = (i: number) => `${DEMO_PRINTERS[i].brand} ${DEMO_PRINTERS[i].model}`;

  // ---- accounts
  add(
    'users',
    ['id', 'email', 'username', 'name', 'role', 'locale', 'bio', 'profile_json', 'avatar_key', 'country', 'onboarding_state', 'notify_whatsapp', 'creator_public', 'created_at', 'updated_at'],
    people.map((p) => {
      const shop = DEMO_SHOPS.find((s) => s.owner === p.n);
      const maker = p.n <= DEMO_MAKER_COUNT;
      const printers = shop ? shop.printers.map(printerName) : maker ? [printerName(p.n % DEMO_PRINTERS.length)] : [];
      return [
        uid(p.n), `demo+${p.n}@${DEMO_EMAIL_DOMAIN}`, `demo_${p.handle}`, p.name, 'customer', p.locale, p.bio,
        JSON.stringify(maker ? { printers, materials: ['PLA', 'PETG'] } : {}),
        img(p.n * 13 + 5)?.key ?? null,
        'IQ', 'done', 0, maker ? 1 : 0, at(24 * (60 + p.n)), now,
      ];
    })
  );

  // ---- workshops: each its own name, picture, banner, accent, city, facts and rating
  add(
    'community_merchants',
    ['id', 'user_id', 'name', 'bio', 'avatar_key', 'governorate', 'status', 'badge', 'verified', 'rating_avg_x100', 'rating_count', 'completed_orders', 'approved_at', 'created_at'],
    DEMO_SHOPS.map((s, i) => [mid(i + 1), uid(s.owner), s.name, s.description, img(i * 7 + 1)?.key ?? null, s.gov, 'active', 'new', s.verified ? 1 : 0, s.rating, s.ratings, s.jobs, at(24 * 55), at(24 * 58)])
  );
  add(
    'merchant_stores',
    ['id', 'merchant_id', 'user_id', 'slug', 'name', 'tagline', 'description', 'logo_key', 'banner_key', 'accent', 'categories', 'governorate', 'service_areas', 'accepts_custom_requests', 'sells_direct_products', 'status', 'profile_facts', 'created_at', 'updated_at'],
    DEMO_SHOPS.map((s, i) => [
      sid(i + 1), mid(i + 1), uid(s.owner), s.slug, s.name, s.tagline, s.description,
      img(i * 7 + 1)?.key ?? null, img(i * 7 + 4)?.key ?? null, s.accent, JSON.stringify(s.categories), s.gov, JSON.stringify(s.areas),
      1, 0, 'active', JSON.stringify(s.facts.map((f) => ({ ...f, visible: true }))), at(24 * 58), now,
    ])
  );
  const printerRows: unknown[][] = [];
  DEMO_SHOPS.forEach((s, i) =>
    s.printers.forEach((pi, k) => {
      const p = DEMO_PRINTERS[pi];
      printerRows.push([demoId('prn', printerRows.length + 1), mid(i + 1), sid(i + 1), printerName(pi), p.tech, p.brand, p.model, p.x, p.y, p.z, JSON.stringify(p.materials), p.enclosed ? 1 : 0, 'available', 1, k]);
    })
  );
  add('merchant_printers', ['id', 'merchant_id', 'store_id', 'name', 'technology', 'brand', 'model', 'build_x_mm', 'build_y_mm', 'build_z_mm', 'materials', 'enclosed', 'availability', 'active', 'sort_order'], printerRows);
  add(
    'merchant_request_prefs',
    ['merchant_id', 'processes', 'governorates', 'delivery', 'turnaround_days', 'technologies', 'max_build_mm', 'workshop_intro'],
    DEMO_SHOPS.map((s, i) => {
      const ps = s.printers.map((pi) => DEMO_PRINTERS[pi]);
      const techs = [...new Set(ps.map((p) => p.tech))];
      const big = ps.reduce((m, p) => (p.x * p.y * p.z > m.x * m.y * m.z ? { x: p.x, y: p.y, z: p.z } : m), { x: 0, y: 0, z: 0 });
      return [mid(i + 1), JSON.stringify(techs), JSON.stringify(s.areas), JSON.stringify(s.delivery), s.turnaround, JSON.stringify(techs), JSON.stringify(big), s.tagline];
    })
  );
  // A workshop's own work: the «أعمال الورش» strip.
  if (images.length) {
    add(
      'merchant_showcase',
      ['id', 'store_id', 'kind', 'title', 'details', 'image_key', 'sort_order', 'active', 'created_at'],
      DEMO_SHOPS.flatMap((s, i) =>
        [0, 1, 2, 3].map((k) => {
          const idea = DEMO_IDEAS[(i * 5 + k * 3) % DEMO_IDEAS.length];
          const lang = people[s.owner - 1].locale;
          const printer = k === 3 ? DEMO_PRINTERS[s.printers[0]] : null;
          return [
            demoId('shw', i * 4 + k + 1), sid(i + 1), printer ? 'printer' : 'work', printer ? `${printer.brand} ${printer.model}` : idea.title[lang],
            printer ? `${printer.x} × ${printer.y} × ${printer.z} mm` : idea.body[lang], img(i * 9 + k * 5 + 2)!.key, k, 1, at(24 * (3 + i + k * 7)),
          ];
        })
      )
    );
  }


  // ---- the store builder: every workshop's page as its owner would publish it
  const hoursRows = (lang: Lang) =>
    lang === 'en'
      ? [{ day: 'Saturday - Thursday', open: '10:00', close: '21:00' }, { day: 'Friday', open: '', close: '', closed: true }]
      : lang === 'ku'
        ? [{ day: 'شەممە - پێنجشەممە', open: '09:00', close: '20:00' }, { day: 'هەینی', open: '', close: '', closed: true }]
        : [{ day: 'السبت - الخميس', open: '10:00', close: '22:00' }, { day: 'الجمعة', open: '16:00', close: '22:00' }];
  const layoutRows: unknown[][] = [];
  const draftRows: unknown[][] = [];
  DEMO_SHOPS.forEach((s, i) => {
    const lang = people[s.owner - 1].locale;
    const json = JSON.stringify(demoStoreLayout(i, s, lang, uid(s.owner)));
    layoutRows.push([demoId('lyr', i + 1), sid(i + 1), 1, SCHEMA_VERSION, json, uid(s.owner), at(24 * 50), 'demo']);
    draftRows.push([sid(i + 1), json, 1, uid(s.owner), at(24 * 50), 2]);
  });
  // The store row names its published revision (no foreign key: the row is written first).
  const storeTable = tables.find((x) => x.table === 'merchant_stores')!;
  storeTable.columns.push('published_revision_id', 'business_hours');
  storeTable.rows.forEach((row, i) => row.push(demoId('lyr', i + 1), JSON.stringify(hoursRows(people[DEMO_SHOPS[i].owner - 1].locale))));
  add('store_layout_revisions', ['id', 'store_id', 'revision', 'schema_version', 'layout_json', 'published_by', 'published_at', 'note'], layoutRows);
  add('store_layout_drafts', ['store_id', 'layout_json', 'base_revision', 'updated_by', 'updated_at', 'version'], draftRows);

  // Automatic collections (no member rows): featured, best sellers, new arrivals.
  const sectionRows: unknown[][] = [];
  const sectionWords: Record<'featured' | 'best_sellers' | 'new_arrivals', [string, string]> = {
    featured: ['Featured', 'مختارات الورشة'],
    best_sellers: ['Best sellers', 'الأكثر طلبًا'],
    new_arrivals: ['New this month', 'جديد هذا الشهر'],
  };
  DEMO_SHOPS.forEach((_s, i) => {
    (['featured', 'best_sellers', 'new_arrivals'] as const).forEach((kind, k) => {
      sectionRows.push([demoId('sec', i * 3 + k + 1), sid(i + 1), sectionWords[kind][0], sectionWords[kind][1], k, 1, kind, at(24 * 50)]);
    });
  });
  add('merchant_store_sections', ['id', 'store_id', 'name', 'name_ar', 'sort_order', 'active', 'kind', 'created_at'], sectionRows);

  // Services: what each workshop offers beyond its shelf (a starting price is a display, not a charge).
  const serviceRows: unknown[][] = [];
  const serviceKinds = [
    ['print_service', 'طباعة حسب الطلب', 'Print on demand', 'ملفك أو تصميمنا، بأي خامة متوفرة.'],
    ['design', 'تصميم ثلاثي الأبعاد', '3D design', 'نرسم القطعة من صورة أو قياسات.'],
    ['finishing', 'صنفرة وتلوين', 'Sanding and painting', 'برايمر وطبقات لون ولمسة نهائية.'],
    ['repair', 'قطع غيار بديلة', 'Replacement parts', 'نقيس القطعة المكسورة ونطبع بديلًا أقوى.'],
  ] as const;
  DEMO_SHOPS.forEach((s, i) => {
    const lang = people[s.owner - 1].locale;
    [0, 1, 2].forEach((k) => {
      const [kind, ar, en, desc] = serviceKinds[(i + k) % serviceKinds.length];
      serviceRows.push([demoId('svc', i * 3 + k + 1), sid(i + 1), mid(i + 1), lang === 'en' ? en : ar, desc, kind, k === 1 ? null : 5_000 * (k + 1 + (i % 3)), k === 0 ? 'per piece' : '', '["pla","petg"]', 1, k, at(24 * 50), now]);
    });
  });
  add('merchant_services', ['id', 'store_id', 'merchant_id', 'title', 'description', 'kind', 'price_from_iqd', 'price_unit', 'materials', 'active', 'sort_order', 'created_at', 'updated_at'], serviceRows);

  // ---- products on each shelf: for looking at only — the cart and the checkout refuse them
  const productRows: unknown[][] = [];
  DEMO_SHOPS.forEach((_s, i) => {
    for (let k = 0; k < 5; k += 1) {
      const n = i * 5 + k + 1;
      const idea = DEMO_PRODUCTS[(i * 3 + k * 4) % DEMO_PRODUCTS.length];
      const pics = images.length ? [0, 1, 2].slice(0, 1 + (n % 3)).map((j) => `/files/${img(n * 5 + j * 13)!.key}`) : [];
      const created = at(24 * (2 + ((n * 7) % 50)));
      productRows.push([
        demoId('prd', n), mid(i + 1), sid(i + 1), `demo-prd-${n}`, 'active', idea.en, idea.ar, idea.descEn, idea.descAr, JSON.stringify(pics),
        idea.price, k === 2 ? Math.round((idea.price * 1.25) / 250) * 250 : null, 'active', 20 + (n % 15), 1, idea.category, idea.material, idea.tech, idea.color, idea.finish,
        k === 0 ? 1 : 0, (n * 7) % 40, 30 + ((n * 37) % 400), 1 + (n % 5), created, created,
      ]);
    }
  });
  add('community_products', ['id', 'merchant_id', 'store_id', 'slug', 'status', 'name', 'name_ar', 'description', 'description_ar', 'images', 'price_iqd', 'original_price_iqd', 'lifecycle', 'stock', 'track_stock', 'category', 'material', 'print_technology', 'color', 'finish', 'featured', 'sold_count', 'view_count', 'prep_days', 'created_at', 'updated_at'], productRows);

  // ---- reviews of each workshop by demo customers, and the rating they add up to
  const reviewRows: unknown[][] = [];
  const reviewWords: Record<Lang, string[]> = {
    ar: ['شغل نظيف وتسليم بالوقت، أنصح بهم.', 'الطباعة ممتازة لكن التوصيل تأخر يومًا.', 'تعامل راقٍ وسعر مناسب.', 'القطعة أقوى من الأصلية، شكرًا.', 'الألوان كما في الصور تمامًا.'],
    en: ['Clean work and on time. Recommended.', 'Great print, delivery was a day late.', 'Friendly and fairly priced.', 'Stronger than the original part — thanks!', 'Colours exactly as pictured.'],
    ku: ['کارێکی پاک و لە کاتی خۆیدا. پێشنیاری دەکەم.', 'چاپەکە نایابە بەڵام گەیاندن ڕۆژێک دواکەوت.', 'مامەڵەیەکی باش و نرخێکی گونجاو.', 'لە ئەسڵەکە بەهێزترە، سوپاس!', 'ڕەنگەکان وەک وێنەکانن.'],
  };
  const ratingOf = new Map<number, number[]>();
  let reviewN = 0;
  DEMO_SHOPS.forEach((s, i) => {
    const reviewers = shuffle(people.filter((p) => p.n !== s.owner), r).slice(0, 4 + (i % 5));
    reviewers.forEach((p, k) => {
      reviewN += 1;
      const rating = k % 6 === 5 ? 3 : k % 3 === 2 ? 4 : 5;
      ratingOf.set(i, [...(ratingOf.get(i) ?? []), rating]);
      const when = at(24 * (3 + k * 4 + (i % 7)));
      const reply = k % 2 === 0 ? (people[s.owner - 1].locale === 'en' ? 'Thank you — see you again!' : people[s.owner - 1].locale === 'ku' ? 'سوپاس، بە هیوای بینینەوە!' : 'شكرًا لك، نتشرف بخدمتك دائمًا!') : '';
      // A review rests on an order; a demo order is only an id that names no row (`order_id` has no foreign key), so no order, money or ledger row exists.
      reviewRows.push([demoId('rvw', reviewN), mid(i + 1), sid(i + 1), uid(p.n), demoId('ord', reviewN), rating, pick(reviewWords[p.locale], r), reply, reply ? when : null, 0, when, when]);
    });
  });
  add('merchant_reviews', ['id', 'merchant_id', 'store_id', 'customer_id', 'order_id', 'rating', 'body', 'merchant_reply', 'merchant_replied_at', 'hidden', 'created_at', 'updated_at'], reviewRows);
  // The workshop's stored rating is its reviews' (what refreshMerchantRating would write).
  const merchantTable = tables.find((x) => x.table === 'community_merchants')!;
  const ratingCol = merchantTable.columns.indexOf('rating_avg_x100');
  const countCol = merchantTable.columns.indexOf('rating_count');
  merchantTable.rows.forEach((row, i) => {
    const rs = ratingOf.get(i) ?? [];
    row[ratingCol] = rs.length ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 100) : 0;
    row[countCol] = rs.length;
  });

  // ---- posts: each author writes in their own language; workshop owners tag their shop
  const shopOf = new Map(DEMO_SHOPS.map((s, i) => [s.owner, i + 1]));
  const posts: Array<{ n: number; author: number; lang: Lang; hoursAgo: number }> = [];
  const postRows: unknown[][] = [];
  const mediaRows: unknown[][] = [];
  for (let n = 1; n <= DEMO_POST_COUNT; n += 1) {
    const idea = DEMO_IDEAS[(n * 7) % DEMO_IDEAS.length];
    // The fifteen workshop owners write two posts in three, the other makers the rest.
    const author = n % 3 === 0 ? 16 + ((n / 3) % (DEMO_MAKER_COUNT - 15)) : 1 + (n % 15);
    const lang = people[author - 1].locale;
    const hoursAgo = n * 11.7 + r() * 6;
    const published = at(hoursAgo);
    const shop = shopOf.get(author);
    posts.push({ n, author, lang, hoursAgo });
    postRows.push([
      demoId('prj', n), uid(author), idea.kind, idea.title[lang], idea.body[lang], 'published', 'public',
      printerName(Math.floor(r() * DEMO_PRINTERS.length)), idea.material, idea.color[lang], idea.minutes,
      JSON.stringify(idea.dims ?? {}), JSON.stringify(idea.tags), shop && r() < 0.8 ? sid(shop) : null, published, published, published,
      // Views: a stored counter (the beacon's), popular posts in the hundreds.
      n % 4 === 0 ? 300 + Math.floor(r() * 900) : 20 + Math.floor(r() * 180),
    ]);
    // One picture each, three or four on some; neighbours never share a cover.
    const pictures = images.length ? (n % 5 === 0 ? 4 : n % 3 === 0 ? 3 : 1) : 0;
    for (let k = 0; k < pictures; k += 1) {
      const pic = img(n * 3 + k * 11)!;
      mediaRows.push([demoId('pmd', mediaRows.length + 1), demoId('prj', n), 'image', pic.key, pic.width, pic.height, k]);
    }
  }
  add('community_posts', ['id', 'author_id', 'kind', 'title', 'body', 'state', 'visibility', 'printer_name', 'material', 'color', 'print_time_minutes', 'dimensions', 'tags', 'store_id', 'published_at', 'created_at', 'updated_at', 'view_count'], postRows);
  add('community_post_media', ['id', 'post_id', 'kind', 'media_key', 'width', 'height', 'sort_order'], mediaRows);

  // ---- comments (and the author's replies), likes, saves
  const roots: unknown[][] = [];
  const replies: unknown[][] = [];
  const likes: unknown[][] = [];
  const saves: unknown[][] = [];
  let commentN = 0;
  for (const p of posts) {
    const others = shuffle(people.filter((u) => u.n !== p.author), r);
    // Popular posts (one in four) draw a crowd: 10-16 comments and dozens of likes; the rest a few.
    const popular = p.n % 4 === 0;
    const nComments = popular ? 10 + Math.floor(r() * 7) : Math.floor(r() * 5);
    for (let k = 0; k < nComments; k += 1) {
      const who = others[k];
      commentN += 1;
      const id = demoId('cmt', commentN);
      const when = at(Math.max(0.3, p.hoursAgo - 1 - k * 2));
      roots.push([id, demoId('prj', p.n), uid(who.n), null, pick(DEMO_COMMENTS[who.locale], r), 'visible', when, when]);
      if (r() < (popular ? 0.5 : 0.3)) {
        commentN += 1;
        const later = at(Math.max(0.2, p.hoursAgo - 2 - k * 2));
        replies.push([demoId('cmt', commentN), demoId('prj', p.n), uid(p.author), id, pick(DEMO_REPLIES[p.lang], r), 'visible', later, later]);
      }
    }
    const nLikes = Math.min(others.length, popular ? 22 + Math.floor(r() * 17) : 2 + Math.floor(r() * 10));
    for (const u of others.slice(0, nLikes)) likes.push([uid(u.n), demoId('prj', p.n), at(Math.max(0.1, p.hoursAgo - 3))]);
    const nSaves = popular ? 5 + Math.floor(r() * 8) : Math.floor(r() * 4);
    for (const u of others.slice(others.length - nSaves)) saves.push([uid(u.n), demoId('prj', p.n), '', at(Math.max(0.1, p.hoursAgo - 4))]);
  }
  add('community_comments', ['id', 'post_id', 'author_id', 'parent_id', 'body', 'state', 'created_at', 'updated_at'], roots);
  add('community_comments', ['id', 'post_id', 'author_id', 'parent_id', 'body', 'state', 'created_at', 'updated_at'], replies);
  add('community_likes', ['user_id', 'post_id', 'created_at'], likes);

  // ---- follows: everyone follows a few makers and a shop or two
  const userFollows: unknown[][] = [];
  const storeFollows: unknown[][] = [];
  for (const u of people) {
    for (const m of shuffle(makers.filter((x) => x.n !== u.n), r).slice(0, 3 + Math.floor(r() * 8))) {
      userFollows.push([uid(u.n), uid(m.n), at(24 * (5 + r() * 50))]);
    }
    const shops = shuffle(DEMO_SHOPS.map((s, i) => ({ s, i })).filter(({ s }) => s.owner !== u.n), r).slice(0, 1 + Math.floor(r() * 4));
    for (const { i } of shops) storeFollows.push([uid(u.n), mid(i + 1), at(24 * (5 + r() * 50))]);
  }
  const admin = opts.adminId && !opts.adminId.startsWith(DEMO_ID_PREFIX) ? opts.adminId : null;
  if (admin) {
    for (const m of makers.slice(0, 8)) userFollows.push([admin, uid(m.n), now]);
    for (let i = 1; i <= 4; i += 1) storeFollows.push([admin, mid(i), now]);
    for (const n of [1, 4, 9, 15]) saves.push([admin, demoId('prj', n), '', now]);
  }
  add('community_saves', ['user_id', 'post_id', 'collection', 'created_at'], saves);
  add('user_follows', ['follower_id', 'user_id', 'created_at'], userFollows);
  add('follows', ['user_id', 'merchant_id', 'created_at'], storeFollows);

  // ---- the board: thirty open requests, 1–4 pending offers on each — no money moves
  const requestRows: unknown[][] = [];
  const offerRows: unknown[][] = [];
  for (let n = 1; n <= DEMO_REQUEST_COUNT; n += 1) {
    const idea = DEMO_REQUESTS[(n - 1) % DEMO_REQUESTS.length];
    const who = n % 4 === 0 ? people[15 + (n % 10)] : customers[(n - 1) % customers.length];
    const created = at(n * 19 + r() * 8);
    requestRows.push([
      demoId('req', n), uid(who.n), idea.title[who.locale], idea.description[who.locale], 'open', 'receiving_offers', idea.category, idea.quantity,
      idea.material, '', idea.dimensions, idea.budget, who.gov, n % 3 === 0 ? 'pickup' : 'delivery', 'public', 0, ahead(6 + (n % 24)), created, created, created,
    ]);
    const bidders = shuffle(DEMO_SHOPS.map((s, i) => ({ s, i })).filter(({ s }) => s.owner !== who.n), r).slice(0, 1 + (n % 4));
    bidders.forEach(({ s, i }, k) => {
      const base = idea.budget ?? 50_000;
      const price = Math.max(5_000, Math.round((base * (0.75 + r() * 0.4)) / 250) * 250);
      const pickup = (s.delivery.length === 1 && s.delivery[0] === 'pickup') || (n + k) % 3 === 0;
      const when = at(Math.max(0.5, n * 19 - 4 - k * 3));
      offerRows.push([
        demoId('off', offerRows.length + 1), demoId('req', n), mid(i + 1), sid(i + 1), price, s.turnaround + (k % 3), pickup ? 'pickup' : 'delivery',
        offerWords(people[s.owner - 1].locale, idea.material, s.turnaround), 'pending', ahead(10 + k), pickup ? 0 : s.gov === who.gov ? 5_000 : 10_000, when, when,
      ]);
    });
  }
  add('community_requests', ['id', 'customer_id', 'title', 'description', 'status', 'state', 'category', 'quantity', 'material', 'color', 'dimensions', 'budget_iqd', 'governorate', 'delivery_pref', 'visibility', 'offer_count', 'expires_at', 'published_at', 'created_at', 'updated_at'], requestRows);
  add('community_offers', ['id', 'request_id', 'merchant_id', 'store_id', 'price_iqd', 'completion_days', 'delivery_method', 'message', 'state', 'expires_at', 'delivery_fee_iqd', 'created_at', 'updated_at'], offerRows);

  const counts = Object.fromEntries(DEMO_TABLES.map((name) => [name, 0])) as DemoCounts;
  for (const tb of tables) if ((DEMO_TABLES as readonly string[]).includes(tb.table)) counts[tb.table as DemoTable] += tb.rows.length;
  return { tables, counts };
}

/** D1 refuses a statement that binds more than 100 parameters. */
export const D1_MAX_PARAMS = 100;

/**
 * The plan as multi-row INSERTs — as many rows per statement as fit under
 * D1's 100-parameter ceiling — after the gate guard, then the board's offer
 * counts. One `db.batch`: one transaction, all of it or none, so a seed that
 * fails leaves nothing to clean. About two hundred statements.
 */
export function demoSeedStatements(db: D1Database, plan: DemoPlan): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [db.prepare(DEMO_SEED_GUARD_SQL)];
  for (const t of plan.tables) {
    const per = Math.max(1, Math.floor(D1_MAX_PARAMS / t.columns.length));
    const marks = `(${t.columns.map(() => '?').join(', ')})`;
    for (let i = 0; i < t.rows.length; i += per) {
      const chunk = t.rows.slice(i, i + per);
      out.push(
        db.prepare(`INSERT INTO ${t.table} (${t.columns.join(', ')}) VALUES ${chunk.map(() => marks).join(', ')}`).bind(...chunk.flat())
      );
    }
  }
  // The board's advertised count, the same COUNT offerCountStatement writes.
  out.push(
    db.prepare(
      `UPDATE community_requests SET offer_count = (SELECT COUNT(*) FROM community_offers o
                                                     WHERE o.request_id = community_requests.id AND o.state IN ('pending','accepted'))
        WHERE ${demoIdSql('id')}`
    )
  );
  return out;
}

type Lang = DemoLang;

/** The demo rows each table holds now. One statement, one sub-count per table. */
export async function demoCounts(db: D1Database): Promise<DemoCounts> {
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM users WHERE ${demoIdSql('id')}) AS users,
        (SELECT COUNT(*) FROM community_merchants WHERE ${demoIdSql('id')}) AS community_merchants,
        (SELECT COUNT(*) FROM merchant_stores WHERE ${demoIdSql('id')}) AS merchant_stores,
        (SELECT COUNT(*) FROM merchant_printers WHERE ${demoIdSql('id')}) AS merchant_printers,
        (SELECT COUNT(*) FROM merchant_request_prefs WHERE ${demoIdSql('merchant_id')}) AS merchant_request_prefs,
        (SELECT COUNT(*) FROM merchant_showcase WHERE ${demoIdSql('id')} OR ${demoIdSql('store_id')}) AS merchant_showcase,
        (SELECT COUNT(*) FROM merchant_store_sections WHERE ${demoIdSql('id')} OR ${demoIdSql('store_id')}) AS merchant_store_sections,
        (SELECT COUNT(*) FROM merchant_services WHERE ${demoIdSql('id')} OR ${demoIdSql('store_id')}) AS merchant_services,
        (SELECT COUNT(*) FROM store_layout_revisions WHERE ${demoIdSql('id')} OR ${demoIdSql('store_id')}) AS store_layout_revisions,
        (SELECT COUNT(*) FROM community_products WHERE ${demoIdSql('id')} OR ${demoIdSql('merchant_id')}) AS community_products,
        (SELECT COUNT(*) FROM merchant_reviews WHERE ${demoIdSql('id')} OR ${demoIdSql('merchant_id')} OR ${demoIdSql('customer_id')}) AS merchant_reviews,
        (SELECT COUNT(*) FROM community_posts WHERE ${demoIdSql('id')}) AS community_posts,
        (SELECT COUNT(*) FROM community_post_media WHERE ${demoIdSql('id')} OR ${demoIdSql('post_id')}) AS community_post_media,
        (SELECT COUNT(*) FROM community_comments WHERE ${demoIdSql('id')}) AS community_comments,
        (SELECT COUNT(*) FROM community_likes WHERE ${demoIdSql('user_id')} OR ${demoIdSql('post_id')}) AS community_likes,
        (SELECT COUNT(*) FROM community_saves WHERE ${demoIdSql('user_id')} OR ${demoIdSql('post_id')}) AS community_saves,
        (SELECT COUNT(*) FROM user_follows WHERE ${demoIdSql('follower_id')} OR ${demoIdSql('user_id')}) AS user_follows,
        (SELECT COUNT(*) FROM follows WHERE ${demoIdSql('user_id')} OR ${demoIdSql('merchant_id')}) AS follows,
        (SELECT COUNT(*) FROM community_requests WHERE ${demoIdSql('id')}) AS community_requests,
        (SELECT COUNT(*) FROM community_offers WHERE ${demoIdSql('id')}) AS community_offers`
    )
    .first<Record<string, number>>();
  const out = {} as DemoCounts;
  for (const t of DEMO_TABLES) out[t] = Number(row?.[t] ?? 0);
  return out;
}

export const demoTotal = (c: DemoCounts) => DEMO_TABLES.reduce((n, t) => n + c[t], 0);

/** Is any demo row present — an account, a shop, a post, a request or an offer? */
export const DEMO_PRESENT_SQL = `(EXISTS (SELECT 1 FROM users WHERE ${demoIdSql('id')})
    OR EXISTS (SELECT 1 FROM community_merchants WHERE ${demoIdSql('id')})
    OR EXISTS (SELECT 1 FROM merchant_stores WHERE ${demoIdSql('id')})
    OR EXISTS (SELECT 1 FROM community_posts WHERE ${demoIdSql('id')})
    OR EXISTS (SELECT 1 FROM community_requests WHERE ${demoIdSql('id')})
    OR EXISTS (SELECT 1 FROM community_offers WHERE ${demoIdSql('id')}))`;

export async function demoPresent(db: D1Database): Promise<boolean> {
  const row = await db.prepare(`SELECT ${DEMO_PRESENT_SQL} AS x`).first<{ x: number }>();
  return Number(row?.x ?? 0) === 1;
}

/** The chats a demo shop, store or account is in. */
export const demoChatsSql = () =>
  `SELECT id FROM chats WHERE ${demoIdSql('merchant_id')} OR ${demoIdSql('store_id')}
   UNION SELECT chat_id FROM chat_participants WHERE ${demoIdSql('user_id')}`;

/**
 * The gate is open to the public, as SQL: `{"open": true}` in the one row.
 * Read the strict way the server reads it, but leaning closed-for-demo: any
 * truthy `open` counts as open here, so the seed refuses rather than writes.
 */
export const GATE_OPEN_SQL = `EXISTS (SELECT 1 FROM admin_settings WHERE key = 'communityGate'
    AND json_valid(value) AND json_extract(value, '$.open') = 1)`;

/**
 * The seed's first statement: a guard that fails the whole batch (users.email
 * is NOT NULL) when the gate is open at the moment the batch runs, so a seed
 * racing an «open» writes nothing.
 */
export const DEMO_SEED_GUARD_SQL = `INSERT INTO users (id, email, name) SELECT 'demo_gate_guard', NULL, '' WHERE ${GATE_OPEN_SQL}`;

// ------------------------------------------------------------------ removal

/**
 * Rows OUTSIDE the demo set that name a demo row and are money or trade: an
 * order, an escrow, a complaint, a ledger line, a payout, a wallet line. The
 * seed creates none and a demo account cannot sign in to create one, so this
 * is expected to be all zeros; if it is not, the removal stops and says what
 * it found rather than deleting a trade record.
 */
export async function demoRemovalBlockers(db: D1Database): Promise<Record<string, number>> {
  const d = demoIdSql;
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM community_orders WHERE ${d('id')} OR ${d('merchant_id')} OR ${d('store_id')} OR ${d('customer_id')} OR ${d('request_id')} OR ${d('offer_id')}) AS community_orders,
        (SELECT COUNT(*) FROM community_escrows WHERE ${d('merchant_id')} OR ${d('customer_id')}) AS community_escrows,
        (SELECT COUNT(*) FROM community_complaints WHERE ${d('merchant_id')} OR ${d('store_id')} OR ${d('offer_id')} OR ${d('reporter_id')} OR ${d('reported_user_id')}) AS community_complaints,
        (SELECT COUNT(*) FROM merchant_ledger_entries WHERE ${d('merchant_id')} OR ${d('store_id')}) AS merchant_ledger_entries,
        (SELECT COUNT(*) FROM merchant_payouts WHERE ${d('merchant_id')}) AS merchant_payouts,
        (SELECT COUNT(*) FROM orders WHERE ${d('user_id')} OR ${d('merchant_id')} OR ${d('store_id')} OR origin_chat_id IN (${demoChatsSql()})) AS orders,
        (SELECT COUNT(*) FROM community_orders WHERE chat_id IN (${demoChatsSql()})) AS community_orders_in_demo_chats,
        (SELECT COUNT(*) FROM wallet_transactions WHERE ${d('user_id')}) AS wallet_transactions`
    )
    .first<Record<string, number>>();
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(row ?? {})) if (Number(v) > 0) out[k] = Number(v);
  return out;
}

/**
 * The deletes, in dependency order, each labelled with what its count
 * reports. The interactions of REAL accounts with demo content are deleted
 * with it (a like on a demo project, a follow of a demo shop, an offer on a
 * demo request, a report of a demo post, a chat opened with a demo shop and
 * a direct request addressed to one); each is its own labelled line so the
 * owner sees exactly what went. The triggers of 0154 fire on every like,
 * save, comment and follow deleted, so the counters they keep stay exact.
 */
export function demoRemovalStatements(db: D1Database, realRequestsToRecount: string[]): Array<{ label: string; stmt: D1PreparedStatement }> {
  const d = demoIdSql;
  const del = (label: string, sql: string) => ({ label, stmt: db.prepare(sql) });
  const demoChats = demoChatsSql();
  const steps = [
    // A demo account's bell (user_notifications, the notifications service's
    // table) goes with the account: its user_id foreign key cascades.
    del('community_likes', `DELETE FROM community_likes WHERE ${d('user_id')} OR ${d('post_id')}`),
    del('community_saves', `DELETE FROM community_saves WHERE ${d('user_id')} OR ${d('post_id')}`),
    // Leaves first, so a reply is counted rather than swept away uncounted by
    // its parent's cascade: three passes cover a thread three replies deep,
    // the last pass takes whatever is left (and its cascade anything deeper).
    ...[1, 2, 3].map(() =>
      del(
        'community_comments',
        `DELETE FROM community_comments WHERE (${d('id')} OR ${d('author_id')} OR ${d('post_id')})
            AND NOT EXISTS (SELECT 1 FROM community_comments ch WHERE ch.parent_id = community_comments.id)`
      )
    ),
    del('community_comments', `DELETE FROM community_comments WHERE ${d('id')} OR ${d('author_id')} OR ${d('post_id')}`),
    del('community_report_targets', `DELETE FROM community_report_targets WHERE ${d('target_id')}`),
    del('community_reports', `DELETE FROM community_reports WHERE ${d('reporter_id')} OR ${d('target_id')}`),
    del('community_post_media', `DELETE FROM community_post_media WHERE ${d('post_id')}`),
    del('community_post_files', `DELETE FROM community_post_files WHERE ${d('post_id')}`),
    del('community_posts', `DELETE FROM community_posts WHERE ${d('id')} OR ${d('author_id')}`),
    del('user_follows', `DELETE FROM user_follows WHERE ${d('follower_id')} OR ${d('user_id')}`),
    del('user_blocks', `DELETE FROM user_blocks WHERE ${d('user_id')} OR ${d('blocked_id')}`),
    del('user_mutes', `DELETE FROM user_mutes WHERE ${d('user_id')} OR ${d('muted_id')}`),
    del('follows', `DELETE FROM follows WHERE ${d('user_id')} OR ${d('merchant_id')}`),
    del('community_offer_drafts', `DELETE FROM community_offer_drafts WHERE ${d('request_id')} OR ${d('merchant_id')}`),
    del('community_offers', `DELETE FROM community_offers WHERE ${d('id')} OR ${d('request_id')} OR ${d('merchant_id')}`),
    del('community_request_matches', `DELETE FROM community_request_matches WHERE ${d('request_id')} OR ${d('merchant_id')}`),
    del(
      'community_requests_to_demo_shops',
      `DELETE FROM community_requests WHERE NOT (${d('id')}) AND (${d('target_merchant_id')} OR origin_chat_id IN (${demoChats}))`
    ),
    // Every conversation a demo shop or a demo account is in — a store thread,
    // or a direct message a real tester opened with a demo maker — goes whole:
    // its messages, its members, the chat.
    // Messages first (counted), then the chats — while their members are still
    // there to name them; the members go with each chat (ON DELETE CASCADE).
    del('chat_messages', `DELETE FROM chat_messages WHERE chat_id IN (${demoChats})`),
    del('chats', `DELETE FROM chats WHERE id IN (${demoChats})`),
    del('community_requests', `DELETE FROM community_requests WHERE ${d('id')} OR ${d('customer_id')}`),
    del('merchant_reviews', `DELETE FROM merchant_reviews WHERE ${d('id')} OR ${d('merchant_id')} OR ${d('customer_id')} OR ${d('store_id')}`),
    del('community_product_favorites', `DELETE FROM community_product_favorites WHERE ${d('user_id')} OR ${d('product_id')}`),
    del('cart_items', `DELETE FROM cart_items WHERE ${d('community_product_id')} OR ${d('store_id')} OR ${d('merchant_id')}`),
    del('merchant_collection_products', `DELETE FROM merchant_collection_products WHERE ${d('product_id')} OR ${d('store_id')}`),
    del('community_products', `DELETE FROM community_products WHERE ${d('id')} OR ${d('merchant_id')} OR ${d('store_id')}`),
    del('merchant_store_sections', `DELETE FROM merchant_store_sections WHERE ${d('id')} OR ${d('store_id')}`),
    del('merchant_services', `DELETE FROM merchant_services WHERE ${d('id')} OR ${d('store_id')}`),
    del('merchant_showcase', `DELETE FROM merchant_showcase WHERE ${d('id')} OR ${d('store_id')}`),
    del('store_layout_drafts', `DELETE FROM store_layout_drafts WHERE ${d('store_id')}`),
    del('store_layout_revisions', `DELETE FROM store_layout_revisions WHERE ${d('id')} OR ${d('store_id')}`),
    del('merchant_printers', `DELETE FROM merchant_printers WHERE ${d('id')} OR ${d('merchant_id')}`),
    del('merchant_request_prefs', `DELETE FROM merchant_request_prefs WHERE ${d('merchant_id')}`),
    del('merchant_stores', `DELETE FROM merchant_stores WHERE ${d('id')} OR ${d('merchant_id')}`),
    del('community_merchants', `DELETE FROM community_merchants WHERE ${d('id')} OR ${d('user_id')}`),
    del('sessions', `DELETE FROM sessions WHERE ${d('user_id')}`),
    del('users', `DELETE FROM users WHERE ${d('id')}`),
  ];
  // A real request a demo workshop offered on (the seed never does it): its
  // advertised count is recomputed once the demo offer is gone.
  for (const id of realRequestsToRecount) {
    steps.push({
      label: 'recount',
      stmt: db
        .prepare(
          `UPDATE community_requests SET offer_count = (SELECT COUNT(*) FROM community_offers o
                                                         WHERE o.request_id = ?1 AND o.state IN ('pending','accepted'))
            WHERE id = ?1`
        )
        .bind(id),
    });
  }
  return steps;
}

/** Real requests a demo merchant's offer sits on — read before the removal deletes the offer. */
export async function realRequestsWithDemoOffers(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT DISTINCT request_id FROM community_offers WHERE ${demoIdSql('merchant_id')} AND ${notDemoSql('request_id')} LIMIT 90`)
    .all<{ request_id: string }>();
  return (results ?? []).map((r) => String(r.request_id));
}
