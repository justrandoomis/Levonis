/**
 * THE SITE ITSELF — who it is, how it is organised, its public pages, its
 * policies and FAQ, its banners and pictures, and its memberships.
 *
 * WHAT IS DELIBERATELY NOT HERE. The public settings the storefront boots
 * with (`PUBLIC_SETTING_KEYS`) include the bank/wallet account numbers of the
 * wallet top-up methods, internal timings and checkout configuration; only
 * the names of the delivery and payment methods, and delivery prices a
 * visitor is quoted, are published here — field by field. There is no public
 * postal address, phone number or e-mail for the shop (the policies withhold
 * them too): the way to reach the shop is the support page.
 *
 * POLICIES ARE READ FROM THE CODE REGISTRY (worker/lib/policies), which is
 * the published text; the storefront's `/api/policies` also mirrors the
 * archive into the database on a read, which a read-only API must not do.
 *
 * Kurdish (`ckb`) text is hand-written on this site and never machine
 * translated: where the site has no Kurdish wording yet, `ckb` is ''.
 */
import { notFound } from '../../http';
import { deliversToHome, getSettings } from '../../settings';
import { normalizeHomeBanners } from '../../homeContent';
import { resolveSiteMedia, SERVICE_SLOTS } from '../../siteMedia';
import { PLATFORM_NAME } from '../../webManifest';
import { POLICY_DOCUMENTS, POLICY_SECTIONS, getPolicyDocument, policySectionOf } from '../../policies';
import { publicBenefitSummary } from '../../membershipBenefits';
import { getProPause } from '../../tierPause';
import { readCommunityGate, communityMayEnter } from '../../communityGate';
import { tierLabel } from '../../../routes/memberships';
import { localized, int, type Localized } from '../common';
import { array, boolean, enumOf, integer, localized as localizedSchema, nullable, number, object, ref, string, url, type JsonSchema } from '../schema';
import type { PublicRequest, PublicRoute } from '../types';
import type { PublicUrls } from '../urls';

// OWNER: Sorani to be written by hand wherever `ckb` is '' below.
const L = (ar: string, en: string, ckb = ''): Localized => ({ ar, en, ckb });

const SITE_LOGO = '/files/UiUx/Logo/Logo.webp';

// ------------------------------------------------------------ site

const SITE_SCHEMA = object(
  {
    name: string('The shop\'s name.'),
    tagline: localizedSchema('What the shop is, in one line.'),
    url: url('The website.'),
    logo: nullable(url('The shop\'s logo.')),
    country: enumOf(['IQ'], 'Where the shop sells.'),
    currency: enumOf(['IQD'], 'Every price is in Iraqi dinars (whole dinars).'),
    languages: array(
      object({ code: enumOf(['ar', 'en', 'ckb']), name: string(), direction: enumOf(['rtl', 'ltr']), default: boolean() }),
      'The site\'s languages. Every text in this API is given in all three; `ckb` may be \'\' where no Kurdish text was written.'
    ),
    support: object({ url: url('The support page — the way to contact the shop.') }),
    delivery_methods: array(
      object(
        {
          title: localizedSchema(),
          description: localizedSchema(),
          price: nullable(integer('The delivery price in IQD the checkout quotes for this method.')),
          home_delivery: boolean('Delivered to the customer\'s address (rather than collected).'),
        },
        'A way to receive an order.'
      )
    ),
    payment_methods: array(object({ title: localizedSchema() }, 'A way to pay at checkout.')),
    community_open: boolean('Whether the community section (stores directory, requests board) is open to visitors right now.'),
    api: object({ context_url: url(), openapi_url: url() }),
  },
  'The shop.'
);

async function site(req: PublicRequest) {
  const { db, urls } = req;
  const [settings, gate] = await Promise.all([
    getSettings(db, ['checkoutDeliveryMethods', 'checkoutPaymentMethods']),
    readCommunityGate(db).catch(() => null),
  ]);
  const delivery = Array.isArray(settings.checkoutDeliveryMethods) ? (settings.checkoutDeliveryMethods as Record<string, unknown>[]) : [];
  const payment = Array.isArray(settings.checkoutPaymentMethods) ? (settings.checkoutPaymentMethods as Record<string, unknown>[]) : [];
  return {
    data: {
      name: PLATFORM_NAME,
      tagline: L(
        'متجر الطباعة ثلاثية الأبعاد: طابعات، خيوط، قطع جاهزة وطلبات طباعة حسب الطلب.',
        'The 3D printing store: printers, filament, ready-made parts and made-to-order prints.'
      ),
      url: urls.web('/'),
      logo: urls.media(SITE_LOGO),
      country: 'IQ' as const,
      currency: 'IQD' as const,
      languages: [
        { code: 'ar' as const, name: 'العربية', direction: 'rtl' as const, default: true },
        { code: 'en' as const, name: 'English', direction: 'ltr' as const, default: false },
        { code: 'ckb' as const, name: 'کوردی', direction: 'rtl' as const, default: false },
      ],
      support: { url: urls.web('/support') },
      delivery_methods: delivery
        .filter((m) => m && typeof m === 'object')
        .map((m) => ({
          title: localized(m.titleAr, m.titleEn, ''),
          description: localized(m.descAr, m.descEn, ''),
          price: int(m.price_iqd),
          home_delivery: deliversToHome({ id: String(m.id ?? ''), home_delivery: typeof m.home_delivery === 'boolean' ? m.home_delivery : undefined }),
        })),
      payment_methods: payment.filter((m) => m && typeof m === 'object').map((m) => ({ title: localized(m.titleAr, m.titleEn, '') })),
      community_open: gate ? communityMayEnter(gate, null) : false,
      api: { context_url: urls.api('/context'), openapi_url: urls.api('/openapi.json') },
    },
    web: urls.web('/'),
  };
}

// ------------------------------------------------------------ pages & navigation

interface PageDef {
  key: string;
  title: Localized;
  description: Localized;
  path: string;
  api?: string;
  community?: boolean;
}

/**
 * The pages a signed-out visitor can open (src/App.tsx, outside every
 * ProtectedRoute), in the order of the site's own navigation.
 */
const PAGES: readonly PageDef[] = [
  { key: 'home', title: L('الرئيسية', 'Home', 'سەرەکی'), description: L('الصفحة الرئيسية للمتجر.', 'The shop\'s home page.'), path: '/', api: '/home' },
  { key: 'products', title: L('المنتجات', 'Products'), description: L('كل المنتجات، مع البحث والفرز والتصفية.', 'Every product, with search, sorting and filters.'), path: '/products', api: '/products' },
  { key: 'categories', title: L('الفئات', 'Categories'), description: L('الأقسام وأقسامها الفرعية.', 'The sections and their sub-sections.'), path: '/categories', api: '/sections' },
  { key: 'bundles', title: L('الباقات والصناديق الغامضة', 'Bundles and mystery boxes'), description: L('باقات منتجات بسعر واحد، وصناديق الخيوط الغامضة.', 'Product bundles at one price, and filament mystery boxes.'), path: '/bundles', api: '/bundles' },
  { key: 'used_printers', title: L('المنتجات المستعملة', 'Pre-owned'), description: L('طابعات مستعملة ومفتوحة العلبة مع تقرير حالة.', 'Used and open-box printers with a condition report.'), path: '/used-printers' },
  { key: 'compare', title: L('قارن الطابعات', 'Compare printers'), description: L('مقارنة المواصفات جنبًا إلى جنب.', 'Side-by-side specification comparison.'), path: '/compare' },
  { key: 'printer_finder', title: L('ساعدني أختار', 'Printer finder'), description: L('أسئلة قصيرة تقترح الطابعة المناسبة.', 'A few questions that suggest the right printer.'), path: '/printer-finder' },
  { key: 'tools', title: L('الأدوات', 'Tools'), description: L('حاسبات وأدوات للطباعة ثلاثية الأبعاد.', '3D printing calculators and tools.'), path: '/tools' },
  { key: 'subscription', title: L('العضويات', 'Memberships', 'ئەندامێتی'), description: L('خطط العضوية وأسعارها ومزاياها.', 'Membership plans, prices and benefits.'), path: '/subscription', api: '/memberships' },
  { key: 'community', title: L('المجتمع', 'Community', 'کۆمەڵگە'), description: L('متاجر المجتمع وطلبات الطباعة.', 'Community stores and print requests.'), path: '/community', community: true },
  { key: 'support', title: L('الدعم', 'Support'), description: L('مساعد الدعم وطريق التواصل مع المتجر.', 'The support assistant and the way to contact the shop.'), path: '/support' },
  { key: 'policies', title: L('السياسات', 'Policies'), description: L('شروط المتجر وسياساته والأسئلة الشائعة.', 'The shop\'s terms, policies and FAQ.'), path: '/policies', api: '/policies' },
];

const PAGE_SCHEMA = object(
  {
    key: string('A stable name for the page.'),
    title: localizedSchema(),
    description: localizedSchema(),
    url: url('The page on the website.'),
    api_url: nullable(url('Where this API serves the page\'s content, when it does.')),
  },
  'A public page of the website.'
);

function pageDto(p: PageDef, urls: PublicUrls) {
  return { key: p.key, title: p.title, description: p.description, url: urls.web(p.path), api_url: p.api ? urls.api(p.api) : null };
}

async function communityOpen(db: D1Database): Promise<boolean> {
  const gate = await readCommunityGate(db).catch(() => null);
  return gate ? communityMayEnter(gate, null) : false;
}

async function pages(req: PublicRequest) {
  const open = await communityOpen(req.db);
  const policyPages = POLICY_DOCUMENTS.map((d) => ({
    key: `policy:${d.key}`,
    title: localized(d.title.ar, d.title.en, d.title.ckb),
    description: L('وثيقة من وثائق المتجر.', 'One of the shop\'s documents.'),
    url: req.urls.web(`/policies/${encodeURIComponent(d.key)}`),
    api_url: req.urls.api(`/policies/${encodeURIComponent(d.key)}`),
  }));
  return {
    data: [...PAGES.filter((p) => !p.community || open).map((p) => pageDto(p, req.urls)), ...policyPages],
    web: req.urls.web('/'),
  };
}

async function navigation(req: PublicRequest) {
  const open = await communityOpen(req.db);
  return {
    data: {
      main: PAGES.filter((p) => !p.community || open).map((p) => pageDto(p, req.urls)),
      sections_api_url: req.urls.api('/sections'),
      search: {
        url_template: req.urls.web('/products?search={q}'),
        api_url_template: req.urls.api('/search?q={q}'),
      },
    },
    web: req.urls.web('/'),
  };
}

// ------------------------------------------------------------ policies & FAQ

const POLICY_SUMMARY_SCHEMA = object(
  {
    key: string(),
    title: localizedSchema(),
    version: integer(),
    effective_at: string('The date the version took effect (YYYY-MM-DD).'),
    url: url('The document on the website.'),
    api_url: url('The full text in this API.'),
  },
  'One of the shop\'s documents.'
);

const POLICY_SCHEMA = object(
  {
    key: string(),
    section: nullable(string('The group the document belongs to (ordering, delivery, warranty, community, legal, help).')),
    title: localizedSchema(),
    body: localizedSchema('The full text, in Markdown. The Arabic text is the authoritative one; a language may be \'\' when not written.'),
    version: integer(),
    effective_at: string(),
    url: url(),
  },
  'A policy document.'
);

function policySummary(d: (typeof POLICY_DOCUMENTS)[number], urls: PublicUrls) {
  return {
    key: d.key,
    title: localized(d.title.ar, d.title.en, d.title.ckb),
    version: d.version,
    effective_at: d.effective_at,
    url: urls.web(`/policies/${encodeURIComponent(d.key)}`),
    api_url: urls.api(`/policies/${encodeURIComponent(d.key)}`),
  };
}

async function listPolicies(req: PublicRequest) {
  const byKey = new Map(POLICY_DOCUMENTS.map((d) => [d.key, d]));
  return {
    data: POLICY_SECTIONS.map((s) => ({
      key: s.id,
      title: localized(s.title.ar, s.title.en, s.title.ckb),
      policies: s.keys.map((k) => byKey.get(k)).filter((d): d is NonNullable<typeof d> => !!d).map((d) => policySummary(d, req.urls)),
    })),
    web: req.urls.web('/policies'),
  };
}

async function getPolicy(req: PublicRequest) {
  const doc = getPolicyDocument(req.path.key);
  if (!doc) throw notFound('Policy not found');
  return {
    data: {
      key: doc.key,
      section: policySectionOf(doc.key),
      title: localized(doc.title.ar, doc.title.en, doc.title.ckb),
      body: localized(doc.body.ar, doc.body.en, doc.body.ckb),
      version: doc.version,
      effective_at: doc.effective_at,
      url: req.urls.web(`/policies/${encodeURIComponent(doc.key)}`),
    },
    web: req.urls.web(`/policies/${encodeURIComponent(doc.key)}`),
  };
}

/** `## N. Topic` / `### N.M Question` → numbered topics and questions, for one language. */
function parseFaq(md: string): { topics: Map<string, string>; items: Map<string, { topic: string; q: string; a: string }> } {
  const topics = new Map<string, string>();
  const items = new Map<string, { topic: string; q: string; a: string }>();
  let topic = '';
  let current: { num: string; q: string; lines: string[] } | null = null;
  const flush = () => {
    if (current) items.set(current.num, { topic, q: current.q, a: current.lines.join('\n').trim() });
    current = null;
  };
  for (const line of md.split('\n')) {
    const t = /^##\s+(\d+)\.\s*(.+)$/.exec(line);
    if (t) {
      flush();
      topic = t[1];
      topics.set(t[1], t[2].trim());
      continue;
    }
    const q = /^###\s+(\d+\.\d+)\s+(.+)$/.exec(line);
    if (q) {
      flush();
      current = { num: q[1], q: q[2].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  return { topics, items };
}

const FAQ_SCHEMA = object(
  {
    topics: array(
      object(
        {
          number: string(),
          title: localizedSchema(),
          questions: array(object({ number: string(), question: localizedSchema(), answer: localizedSchema('Markdown.') }, 'One question.')),
        },
        'A group of questions.'
      )
    ),
    version: integer(),
    effective_at: string(),
    url: url(),
  },
  'Frequently asked questions (the shop\'s FAQ document, split into questions).'
);

async function faq(req: PublicRequest) {
  const doc = getPolicyDocument('faq');
  if (!doc) throw notFound('FAQ not found');
  const ar = parseFaq(doc.body.ar);
  const en = parseFaq(doc.body.en);
  const ckb = parseFaq(doc.body.ckb);
  const topics = [...ar.topics.keys()].map((num) => ({
    number: num,
    title: localized(ar.topics.get(num), en.topics.get(num), ckb.topics.get(num)),
    questions: [...ar.items.entries()]
      .filter(([, v]) => v.topic === num)
      .map(([qn, v]) => ({
        number: qn,
        question: localized(v.q, en.items.get(qn)?.q, ckb.items.get(qn)?.q),
        answer: localized(v.a, en.items.get(qn)?.a, ckb.items.get(qn)?.a),
      })),
  }));
  return {
    data: { topics, version: doc.version, effective_at: doc.effective_at, url: req.urls.web('/policies/faq') },
    web: req.urls.web('/policies/faq'),
  };
}

// ------------------------------------------------------------ banners & media

const BANNER_SCHEMA = object(
  {
    image: nullable(url('The banner picture.')),
    link: nullable(url('Where the banner leads.')),
    title: localizedSchema(),
    subtitle: localizedSchema(),
    cta: localizedSchema('The button text.'),
  },
  'A banner the owner published.'
);

export function bannerDtos(raw: unknown, slot: string, urls: PublicUrls) {
  const list = normalizeHomeBanners(raw)[slot] ?? [];
  return list.map((b) => ({
    image: urls.media(b.image),
    link: b.link ? (b.link.startsWith('/') ? urls.web(b.link) : /^https:\/\//i.test(b.link) ? b.link : null) : null,
    title: localized(b.title.ar, b.title.en, b.title.ckb),
    subtitle: localized(b.subtitle.ar, b.subtitle.en, b.subtitle.ckb),
    cta: localized(b.cta.ar, b.cta.en, b.cta.ckb),
  }));
}

const MEDIA_SCHEMA = object(
  {
    logo: nullable(url()),
    hero_slides: array(ref('Banner'), 'The home page\'s hero slides.'),
    editorial_banners: array(ref('Banner'), 'The home page\'s two editorial banners.'),
    home_photos: array(
      object(
        {
          place: string('Where on the home page (e.g. bento-large = the large category tile).'),
          theme: enumOf(['light', 'dark']),
          image: url(),
        },
        'A picture the owner chose for a place on the home page.'
      )
    ),
    brand_logos: array(object({ brand: string(), image: url(), link: nullable(url()) }, 'A brand logo the home page shows.')),
    service_pictures: array(object({ service: string(), image: url(), link: nullable(url()) }, 'A picture of one of the site\'s services.')),
  },
  'Every public banner and site picture.'
);

async function media(req: PublicRequest) {
  const { db, urls } = req;
  const settings = await getSettings(db, ['homeBanners', 'mainPageMedia']);
  const resolved = resolveSiteMedia(settings.mainPageMedia);
  const link = (l: string) => (!l ? null : l.startsWith('/') ? urls.web(l) : /^https:\/\//i.test(l) ? l : null);
  const serviceSlots = new Set(SERVICE_SLOTS.map((s) => s.slot));
  return {
    data: {
      logo: urls.media(SITE_LOGO),
      hero_slides: [...bannerDtos(settings.homeBanners, 'first_banner', urls), ...bannerDtos(settings.homeBanners, 'second_banner', urls)],
      editorial_banners: bannerDtos(settings.homeBanners, 'editorial_banners', urls),
      home_photos: resolved
        .filter((m) => m.group === 'home' && m.target && m.theme)
        .map((m) => ({ place: String(m.target), theme: m.theme as 'light' | 'dark', image: urls.media(m.url) }))
        .filter((m): m is { place: string; theme: 'light' | 'dark'; image: string } => !!m.image),
      brand_logos: resolved
        .filter((m) => m.group === 'brand')
        .map((m) => ({ brand: m.label, image: urls.media(m.url), link: link(m.link) }))
        .filter((m): m is { brand: string; image: string; link: string | null } => !!m.image),
      service_pictures: resolved
        .filter((m) => m.group === 'service' && serviceSlots.has(m.slot))
        .map((m) => ({ service: m.slot.replace(/^service-/, ''), image: urls.media(m.url), link: link(m.link) }))
        .filter((m): m is { service: string; image: string; link: string | null } => !!m.image),
    },
    web: urls.web('/'),
  };
}

// ------------------------------------------------------------ memberships

const MEMBERSHIPS_SCHEMA = object(
  {
    plans: array(
      object(
        {
          tier: enumOf(['plus', 'prime', 'pro']),
          name: string('The name the site shows (PLUS, PREMIUM, PRO).'),
          duration_months: integer(),
          price: nullable(integer('The plan\'s price in IQD; null when it is not on sale right now.')),
          per_month: nullable(integer()),
          purchasable: boolean(),
        },
        'A membership plan.'
      )
    ),
    pro_paused: boolean('True while new PRO memberships are paused.'),
    benefits: array(
      object(
        {
          tier: enumOf(['prime', 'pro']),
          name: string(),
          discounts: array(
            object(
              {
                applies_to: localizedSchema('The section the discount is on; all three \'\' for every product.'),
                percent: nullable(number()),
                fixed_amount: nullable(integer()),
                max_discount: nullable(integer()),
                min_order: nullable(integer()),
                max_quantity: nullable(integer()),
              },
              'A member discount.'
            )
          ),
          free_delivery_from: nullable(integer('Order total from which delivery is free for this tier; 0 = always free.')),
          cash_on_delivery_fee_waived: boolean(),
        },
        'What a membership gives.'
      )
    ),
    url: url(),
  },
  'Membership plans and their benefits.'
);

async function memberships(req: PublicRequest) {
  const { db, urls } = req;
  const [{ results }, benefits, pause] = await Promise.all([
    db
      .prepare('SELECT tier, duration_months, price_iqd FROM membership_plans WHERE active = 1 ORDER BY sort, duration_months')
      .all<{ tier: string; duration_months: number; price_iqd: number | null }>(),
    publicBenefitSummary(db, new Date().toISOString()),
    getProPause(db),
  ]);
  const plans = (results ?? [])
    .filter((p) => p.tier === 'plus' || p.tier === 'prime' || p.tier === 'pro')
    .map((p) => {
      const paused = p.tier === 'pro' && pause.paused;
      const price = paused ? null : int(p.price_iqd);
      return {
        tier: p.tier as 'plus' | 'prime' | 'pro',
        name: tierLabel(p.tier),
        duration_months: int(p.duration_months) ?? 0,
        price,
        per_month: price === null ? null : Math.round(price / Math.max(1, Number(p.duration_months) || 1)),
        purchasable: price !== null,
      };
    });
  const tiers = (['prime', 'pro'] as const).filter((t) => !(t === 'pro' && pause.paused));
  return {
    data: {
      plans,
      pro_paused: pause.paused,
      benefits: tiers.map((t) => ({
        tier: t,
        name: tierLabel(t),
        discounts: benefits[t].discounts.map((d) => ({
          applies_to: localized(d.target_name_ar, d.target_name_en, d.target_name_ckb),
          percent: typeof d.percent === 'number' ? d.percent : null,
          fixed_amount: int(d.fixed_iqd),
          max_discount: int(d.max_discount_iqd),
          min_order: int(d.min_subtotal_iqd),
          max_quantity: int(d.max_quantity),
        })),
        free_delivery_from: benefits[t].free_shipping ? int(benefits[t].free_shipping!.threshold_iqd) ?? 0 : null,
        cash_on_delivery_fee_waived: benefits[t].cod_tax_exempt,
      })),
      url: urls.web('/subscription'),
    },
    web: urls.web('/subscription'),
  };
}

// ------------------------------------------------------------ routes

export const SITE_COMPONENTS: Record<string, JsonSchema> = {
  Site: SITE_SCHEMA,
  Page: PAGE_SCHEMA,
  PolicySummary: POLICY_SUMMARY_SCHEMA,
  Policy: POLICY_SCHEMA,
  Faq: FAQ_SCHEMA,
  Banner: BANNER_SCHEMA,
  Media: MEDIA_SCHEMA,
  Memberships: MEMBERSHIPS_SCHEMA,
};

export const SITE_ROUTES: PublicRoute[] = [
  {
    operationId: 'getSite',
    path: '/site',
    tag: 'Site',
    summary: 'The shop: name, languages, currency, delivery and payment methods',
    description: 'General information about Levonis — what it sells, where, in which languages and currency, how orders are delivered and paid for, and how to reach support.',
    data: ref('Site'),
    maxAge: 600,
    example: '/site',
    handler: site,
  },
  {
    operationId: 'getNavigation',
    path: '/navigation',
    tag: 'Site',
    summary: 'The site\'s main navigation',
    description: 'The main pages a visitor can open, in the site\'s order, with where this API serves each one\'s content; the section tree is /sections.',
    data: object(
      {
        main: array(ref('Page')),
        sections_api_url: url(),
        search: object({ url_template: string('The site\'s search page; replace {q}.'), api_url_template: string('This API\'s search; replace {q}.') }),
      },
      'Navigation.'
    ),
    maxAge: 600,
    example: '/navigation',
    handler: navigation,
  },
  {
    operationId: 'listPages',
    path: '/pages',
    tag: 'Site',
    summary: 'Every public page of the website',
    description: 'The pages a signed-out visitor can open, and every policy document as a page, each with its web address and, where available, its content in this API.',
    data: array(ref('Page')),
    maxAge: 600,
    example: '/pages',
    handler: pages,
  },
  {
    operationId: 'listPolicies',
    path: '/policies',
    tag: 'Policies',
    summary: 'The shop\'s policies and terms, grouped',
    description: 'Every published document — purchase, payment, delivery, warranty, returns, membership, privacy, terms, FAQ… — grouped as on the site.',
    data: array(
      object({ key: string('The group\'s name (ordering, delivery, warranty, community, legal, help).'), title: localizedSchema(), policies: array(ref('PolicySummary')) }, 'A group of documents.')
    ),
    maxAge: 3600,
    example: '/policies',
    handler: listPolicies,
  },
  {
    operationId: 'getPolicy',
    path: '/policies/{key}',
    tag: 'Policies',
    summary: 'One policy document, full text in three languages',
    description: 'The published text of one document (Markdown). The Arabic text is authoritative.',
    params: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The document key (see /policies).',
        schema: { type: 'string', enum: POLICY_DOCUMENTS.map((d) => d.key) },
        example: 'returns',
      },
    ],
    data: ref('Policy'),
    maxAge: 3600,
    example: '/policies/returns',
    handler: getPolicy,
  },
  {
    operationId: 'getFaq',
    path: '/faq',
    tag: 'Policies',
    summary: 'Frequently asked questions',
    description: 'The shop\'s FAQ, split into numbered topics and questions with their answers in three languages.',
    data: ref('Faq'),
    maxAge: 3600,
    example: '/faq',
    handler: faq,
  },
  {
    operationId: 'getMedia',
    path: '/media',
    tag: 'Site',
    summary: 'Banners and site pictures',
    description: 'The logo, the home page\'s hero slides and editorial banners, the pictures the owner chose for home-page places, brand logos and service pictures — original files. Product pictures are on each product; section pictures on each section.',
    data: ref('Media'),
    maxAge: 600,
    example: '/media',
    handler: media,
  },
  {
    operationId: 'getMemberships',
    path: '/memberships',
    tag: 'Site',
    summary: 'Membership plans, prices and benefits',
    description: 'The membership plans on sale, their prices, and what each gives: member discounts by section, free delivery and cash-on-delivery fees.',
    data: ref('Memberships'),
    maxAge: 600,
    example: '/memberships',
    handler: memberships,
  },
];

