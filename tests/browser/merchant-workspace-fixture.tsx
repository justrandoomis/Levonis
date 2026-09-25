/**
 * THE MERCHANT WORKSPACE, AS SHIPPED (W3-A) — the real application (src/App),
 * its real routes and full-screen tree, with `fetch` answering the real route
 * shapes from fixed data. Served only by a local `vite` dev server.
 *
 *   /tests/browser/merchant-workspace.html?lang=ar|en&path=/merchant/orders
 *        [&host=store]   the same tree under /admin on the store's own subdomain
 *        [&state=lapsed|calm|other]  a lapsed PLUS / nothing waiting / someone else's store host
 *
 * The page rewrites its own address to `path` before the app boots, so the
 * router sees exactly the address a merchant would open.
 */
import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { defaultLayoutFromStore } from '../../packages/storeLayout/src/defaults';
import { emptyBlockData } from '../../packages/storeLayout/src/data';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : params.get('lang') === 'ckb' ? 'ckb' : 'ar';
const onStore = params.get('host') === 'store';
const state = params.get('state') ?? 'busy';
try {
  localStorage.setItem('levo_lang', lang);
  localStorage.removeItem('levo_merchant_sidebar_collapsed');
  if (params.get('collapsed') === '1') localStorage.setItem('levo_merchant_sidebar_collapsed', '1');
} catch {
  /* Arabic, the default */
}
const path = params.get('path') ?? '/merchant';
history.replaceState(null, '', onStore ? path.replace(/^\/merchant/, '/admin') : path);

const en = lang === 'en';
const ago = (days: number, h = 10) => new Date(Date.now() - days * 86_400_000 - h * 3_600_000).toISOString();
const day = (n: number) => {
  const d = new Date(Date.now() + 3 * 3_600_000 - n * 86_400_000);
  return d.toISOString().slice(0, 10);
};

const STORE = {
  id: 's1', merchant_id: 'm1', slug: 'ali3d', url: 'https://ali3d.levonis-iq.com', name: en ? 'Ali 3D Prints' : 'علي للطباعة ثلاثية الأبعاد', tagline: '', description: '',
  logoUrl: null, bannerUrl: null, accent: 'olive', categories: [], governorate: 'baghdad', service_areas: [], contact_phone: '07701234567', contact_phone_public: false,
  business_hours: [], policies: {}, social_links: {}, profile_links: [], profile_facts: [], accepts_custom_requests: true, sells_direct_products: true,
  status: state === 'lapsed' ? 'active' : 'active', status_reason: '', created_at: ago(90),
  merchant: { id: 'm1', name: 'Ali', verified: true, status: 'active', badge: 'trusted', rating: 4.8, rating_count: 23, completed_orders: 58 },
};
const ME = {
  eligible: state !== 'lapsed', tier: 'plus', tier_active: state !== 'lapsed', expires_at: '2027-01-01', gated_benefits: [],
  can: { store: true, products: true, orders: true, offers: true, analytics: state !== 'lapsed', subdomain: true },
  store: STORE,
  selling: state === 'lapsed' ? { canSell: false, reason: 'subscription_inactive' } : { canSell: true, reason: '' },
  suggested_slug: null, root_domain: 'levonis-iq.com',
};
const BUSY = {
  orders: { total: 5, by_stage: { pending: 3, confirmed: 1, processing: 1 }, link: '/merchant/orders', links: { pending: '/merchant/orders?status=pending', confirmed: '/merchant/orders?status=confirmed', processing: '/merchant/orders?status=processing' } },
  custom_orders: { to_start: 1, in_progress: 2, total: 3, link: '/merchant/requests/orders' },
  inbox: { threads: 2, messages: 3, link: '/merchant/inbox' },
  notifications: { unread: 4, link: '/merchant/notifications' },
  requests: { matching: 2, link: '/merchant/requests' },
  stock: { low: 2, out: 1, link_low: '/merchant/products?state=published&stock=low', link_out: '/merchant/products?state=published&stock=out' },
  reviews: { new: 1, unanswered: 2, link: '/merchant/reviews' },
  money: { available_iqd: 182_100, pending_iqd: 61_300, link: '/merchant/money' },
  payouts: { in_flight: 1, amount_iqd: 60_000, link: '/merchant/money' },
  coupons: { ending_soon: 1, first_ends_at: ago(-3), within_days: 7, link: '/merchant/marketing/coupons' },
  store: { problems: [{ code: 'layout_unpublished', link: '/merchant/store/design' }] },
};
const CALM = {
  orders: { total: 0, by_stage: { pending: 0, confirmed: 0, processing: 0 }, link: '/merchant/orders', links: BUSY.orders.links },
  custom_orders: { to_start: 0, in_progress: 0, total: 0, link: '/merchant/requests/orders' },
  inbox: { threads: 0, messages: 0, link: '/merchant/inbox' },
  notifications: { unread: 0, link: '/merchant/notifications' },
  stock: { low: 0, out: 0, link_low: BUSY.stock.link_low, link_out: BUSY.stock.link_out },
  reviews: { new: 0, unanswered: 0, link: '/merchant/reviews' },
  money: { available_iqd: 0, pending_iqd: 0, link: '/merchant/money' },
  store: { problems: [] },
};
const LAPSED = { ...BUSY, requests: undefined, store: { problems: [{ code: 'subscription_inactive', link: '/subscription' }] } };
const attention = state === 'calm' ? CALM : state === 'lapsed' ? LAPSED : BUSY;

const series = Array.from({ length: 30 }, (_, i) => {
  const orders = [0, 1, 0, 2, 1, 0, 3, 1, 0, 2, 4, 1, 0, 2, 1, 3, 0, 2, 1, 5, 2, 1, 0, 3, 2, 4, 1, 2, 3, 2][i];
  return { day: day(29 - i), orders, gross_iqd: orders * 23_500 };
});
const REPORT = {
  range: { from: day(29), to: day(0), days: 30, timezone: 'Asia/Baghdad' },
  traffic: { since: day(40), counted_from: day(29), totals: { visitors: 1840, store_views: 2300, product_views: 3900, add_to_cart: 210, checkout_started: 96 }, sources: { direct: 900, search: 400, social: 480, other: 60 }, series: series.map((s, i) => ({ day: s.day, visitors: 40 + i * 2, store_views: 60, product_views: 120, add_to_cart: 7, checkout_started: 3 })) },
  orders: { totals: { orders: 49, gross_iqd: 1_151_500, receivable_iqd: 1_093_925, cancelled: 2, average_order_iqd: 23_500 }, series },
  funnel: { from: day(29), visitors: 1840, product_views: 3900, add_to_cart: 210, checkout_started: 96, orders: 49, conversion_percent: 2.7 },
  // W3-B: the analytics page's other sections.
  products: {
    top: [
      { id: 'p1', name: en ? 'Articulated dragon' : 'تنين مفصلي مطبوع', units: 31, revenue_iqd: 558_000, orders: 27 },
      { id: 'p2', name: en ? 'Phone stand' : 'حامل هاتف', units: 22, revenue_iqd: 198_000, orders: 18 },
      { id: 'p3', name: en ? 'Planter pot' : 'أصيص نباتات', units: 9, revenue_iqd: 112_500, orders: 8 },
    ],
    most_viewed: [
      { id: 'p1', name: en ? 'Articulated dragon' : 'تنين مفصلي مطبوع', views: 1620, add_to_cart: 96 },
      { id: 'p2', name: en ? 'Phone stand' : 'حامل هاتف', views: 910, add_to_cart: 51 },
      { id: 'p3', name: en ? 'Planter pot' : 'أصيص نباتات', views: 402, add_to_cart: 12 },
    ],
    least_viewed: [
      { id: 'p9', name: en ? 'Cable clips (set of 10)' : 'مشابك أسلاك (10 قطع)', views: 4, add_to_cart: 0 },
      { id: 'p3', name: en ? 'Planter pot' : 'أصيص نباتات', views: 402, add_to_cart: 12 },
    ],
  },
  customers: { customers: 41, returning: 12, new: 29 },
  coupons: [
    { code: 'SUMMER25', orders: 9, discount_iqd: 52_000, gross_iqd: 211_000, coupon_id: 'cpn1', used_count: 14, max_uses: 100, ends_at: ago(-3), active: true },
    { code: 'WELCOME', orders: 3, discount_iqd: 6_000, gross_iqd: 57_000 },
  ],
  governorates: [
    { governorate: 'baghdad', orders: 29, gross_iqd: 690_000 },
    { governorate: 'basra', orders: 9, gross_iqd: 201_000 },
    { governorate: 'erbil', orders: 6, gross_iqd: 142_000 },
    { governorate: 'najaf', orders: 3, gross_iqd: 70_500 },
  ],
  governorates_unspecified: 2,
  requests: { matched: 18, notified: 11, offers_sent: 14, offers_accepted: 6, win_rate_percent: 43, custom_orders_completed: 4, custom_orders_receivable_iqd: 190_000 },
  previous: {
    range: { from: day(59), to: day(30), days: 30 },
    orders: { orders: 38, gross_iqd: 870_000, receivable_iqd: 826_500, average_order_iqd: 22_895 },
    traffic: { visitors: 1510, product_views: 3400, add_to_cart: 190, checkout_started: 88, orders: 38, conversion_percent: 2.5 },
  },
};
const TIMELINE = {
  order_id: 'ORD-22EE1B07', status: 'delivered', credit_state: 'pending', disputed: false, commission_percent: 5,
  events: [
    { kind: 'placed', at: ago(4, 3), actor: 'customer', total_iqd: 26000 },
    { kind: 'credit_recorded', at: ago(4, 3), bucket: 'pending', lines: [{ kind: 'sale_gross', amount_iqd: 23000 }, { kind: 'commission', amount_iqd: -1150 }, { kind: 'delivery_fee', amount_iqd: 3000 }] },
    { kind: 'chat_started', at: ago(4, 2) },
    { kind: 'status', at: ago(4, 1), status: 'confirmed', stage: 'confirmed', actor: 'store' },
    { kind: 'status', at: ago(3, 5), status: 'processing', stage: 'processing', actor: 'store' },
    { kind: 'status', at: ago(2, 6), status: 'shipped', stage: 'shipped', actor: 'store' },
    { kind: 'status', at: ago(1, 4), status: 'delivered', stage: 'delivered', actor: 'courier' },
    { kind: 'release_due', at: ago(-2, 4), expected: true, frozen: false },
  ],
  money: { gross_iqd: 23000, commission_iqd: -1150, delivery_fee_iqd: 3000, reversed_iqd: 0, adjustments_iqd: 0, net_iqd: 24850, pending_iqd: 24850, available_iqd: 0 },
  delivery: { recorded: true, fulfilment: 'delivery', governorate: 'basra', rule: 'override', fee_iqd: 3000, base_fee_iqd: 5000, free_over_iqd: 50000, prep_days: 2, shipping_type: 'direct' },
  items: [
    { id: 'i1', product_id: 'p1', variant_id: 'v1', name: en ? 'Articulated dragon' : 'تنين مفصلي مطبوع', image: null, option: en ? 'Gold / Large' : 'ذهبي / كبير', sku: 'DR-01-GL', qty: 1, unit_price_iqd: 18000, line_total_iqd: 18000 },
    { id: 'i2', product_id: 'p2', variant_id: null, name: en ? 'Phone stand' : 'حامل هاتف', image: null, option: '', sku: 'PS-01', qty: 1, unit_price_iqd: 5000, line_total_iqd: 5000 },
  ],
  chat: { id: 'chat_1', link: '/merchant/inbox/chat_1' },
};
const CUSTOMERS = [
  { key: 'ORD-22EE1B07', name: en ? 'Zainab K.' : 'زينب كريم', order_count: 3, spent_iqd: 87_000, last_order_at: ago(1), first_order_at: ago(60), governorate: 'basra', link: '/merchant/customers/ORD-22EE1B07' },
  { key: 'ORD-7F3A21C9', name: en ? 'Sara Ahmed' : 'سارة أحمد', order_count: 2, spent_iqd: 61_000, last_order_at: ago(0, 2), first_order_at: ago(20), governorate: 'baghdad', link: '/merchant/customers/ORD-7F3A21C9' },
  { key: 'ORD-91BC04D2', name: 'Omar Najm', order_count: 1, spent_iqd: 16_000, last_order_at: ago(1), first_order_at: ago(1), link: '/merchant/customers/ORD-91BC04D2' },
];
const ORDERS = [
  { id: 'ORD-7F3A21C9', status: 'pending', stage: 'placed', origin: 'store_product', total_iqd: 45000, subtotal_iqd: 42000, shipping_iqd: 3000, platform_fee_iqd: 2100, merchant_receivable_iqd: 42900, created_at: ago(0, 2), customer_name: en ? 'Sara Ahmed' : 'سارة أحمد', item_count: 2, credit_state: 'pending', release_after: null },
  { id: 'ORD-91BC04D2', status: 'confirmed', stage: 'placed', origin: 'store_product', total_iqd: 16000, subtotal_iqd: 14000, shipping_iqd: 2000, platform_fee_iqd: 700, merchant_receivable_iqd: 15300, created_at: ago(1), customer_name: 'Omar Najm', item_count: 1, credit_state: 'pending', release_after: null },
  { id: 'ORD-22EE1B07', status: 'delivered', stage: 'delivered', origin: 'store_product', total_iqd: 26000, subtotal_iqd: 23000, shipping_iqd: 3000, platform_fee_iqd: 1150, merchant_receivable_iqd: 24850, created_at: ago(4), customer_name: en ? 'Zainab K.' : 'زينب كريم', item_count: 3, credit_state: 'available', release_after: null },
];
const PRODUCTS = [
  { id: 'p1', slug: 'dragon', name: en ? 'Articulated dragon' : 'تنين مفصلي مطبوع', name_ar: '', images: [], price_iqd: 18000, stock: 2, track_stock: true, state: 'published', sold_out: false, low_stock: true, variant_mode: 'simple', variant_count: 0, price_range: null, sold_count: 41, collection_ids: [], moderation: null, featured: true, view_count: 120, category: '', created_at: ago(20), updated_at: ago(2), sku: 'DR-01', low_stock_threshold: 3 },
  { id: 'p2', slug: 'stand', name: en ? 'Phone stand' : 'حامل هاتف', name_ar: '', images: [], price_iqd: 9000, stock: 0, track_stock: true, state: 'published', sold_out: true, low_stock: false, variant_mode: 'simple', variant_count: 0, price_range: null, sold_count: 12, collection_ids: [], moderation: null, featured: false, view_count: 80, category: '', created_at: ago(30), updated_at: ago(5), sku: 'PS-01', low_stock_threshold: null },
  { id: 'p3', slug: 'pot', name: en ? 'Planter pot' : 'أصيص نباتات', name_ar: '', images: [], price_iqd: 12500, stock: 14, track_stock: true, state: 'draft', sold_out: false, low_stock: false, variant_mode: 'simple', variant_count: 0, price_range: null, sold_count: 0, collection_ids: [], moderation: null, featured: false, view_count: 0, category: '', created_at: ago(3), updated_at: ago(3), sku: '', low_stock_threshold: null },
];
const layout = defaultLayoutFromStore(null);
const NOTES = [
  { id: 'n1', kind: 'new_order', title_ar: 'طلب جديد في متجرك — ORD-7F3A21C9', title_en: 'New order in your store — ORD-7F3A21C9', body_ar: 'الإجمالي 45,000 د.ع', body_en: 'Total 45,000 IQD', link: '/merchant/orders/ORD-7F3A21C9', entity_type: 'order', entity_id: 'ORD-7F3A21C9', read: false, created_at: ago(0, 2) },
  { id: 'n2', kind: 'new_review', title_ar: 'تقييم جديد ★5', title_en: 'New review ★5', body_ar: 'شغل ممتاز', body_en: 'Great work', link: '/merchant/reviews', entity_type: 'review', entity_id: 'r1', read: true, created_at: ago(2) },
];

function answer(p: string, q: URLSearchParams, method: string): { status: number; body: Record<string, unknown> } {
  const ok = (b: Record<string, unknown> = {}) => ({ status: 200, body: { success: true, ...b } });
  if (p === '/api/auth/me') return ok({ user: { id: 'owner', email: 'ali@x.co', username: 'ali', name: 'Ali Hassan', role: 'merchant', isAdmin: false, is_investor: false, subscription_plan: 'plus', membership_tier: 'plus', locale: lang, email_verified: true, phone_verified: true } });
  if (p === '/api/auth/verify-email/status') return ok({ email: 'ali@x.co', verified: true, emailConfigured: true });
  if (p === '/api/storefront/resolve') {
    if (onStore) return ok({ kind: 'store', store: state === 'other' ? { ...STORE, id: 's2', slug: 'zahra', name: 'Zahra Prints' } : STORE });
    return ok({ kind: 'main', store: null });
  }
  if (p === '/api/storefront/ali3d') return ok({ store: { ...STORE, followers: 210, product_count: 9, positive_pct: 96, deal_count: 0 } });
  if (p === '/api/community/access') return ok({ closed: false, admin: false, may_enter: true });
  if (p === '/api/merchant/me') return ok(ME);
  if (p === '/api/merchant/attention') return ok({ generated_at: new Date().toISOString(), attention });
  if (p === '/api/merchant/search') {
    const s = (q.get('q') ?? '').toLowerCase();
    return ok({
      q: q.get('q'),
      orders: ORDERS.filter((o) => o.id.toLowerCase().includes(s)).map((o) => ({ id: o.id, status: o.status, total_iqd: o.total_iqd, created_at: o.created_at, link: `/merchant/orders/${o.id}` })),
      products: PRODUCTS.filter((x) => x.name.toLowerCase().includes(s) || x.sku.toLowerCase().includes(s)).map((x) => ({ id: x.id, name: x.name, name_ar: x.name_ar, publish_state: x.state, price_iqd: x.price_iqd, link: `/merchant/products/${x.id}` })),
      customers: 'sara 0770 سارة'.includes(s) ? [{ name: en ? 'Sara Ahmed' : 'سارة أحمد', order_count: 3, last_order_at: ago(0), link: '/merchant/orders/ORD-7F3A21C9' }] : [],
    });
  }
  if (p === '/api/merchant/analytics/report') {
    if (state === 'lapsed') return { status: 403, body: { success: false, error: 'Analytics are part of LEVO PLUS.', code: 'ANALYTICS_NOT_INCLUDED' } };
    return ok(REPORT);
  }
  if (p === '/api/merchant/analytics') {
    if (state === 'lapsed') return { status: 403, body: { success: false, error: 'Analytics are part of LEVO PLUS. Renew to see them again.', code: 'FORBIDDEN' } };
    return ok({ orders: { total: 58, gross_iqd: 1_363_000, receivable_iqd: 1_294_850, average_order_iqd: 23_500, cancelled: 2 }, products: { total: 12, active: 9, views: 4800, sold: 140 }, offers: { sent: 14, accepted: 6, win_rate: 43 }, followers: 210, custom_orders: { completed: 4, receivable_iqd: 190_000 }, top_products: [] });
  }
  if (p === '/api/merchant/notifications/unread-count') return ok({ unread: 4, unread_by_kind: {} });
  if (p === '/api/merchant/notifications/feed') return ok({ unread: 1, unread_by_kind: {}, notifications: NOTES, next_cursor: null });
  if (p === '/api/merchant/notifications') return ok({ preferences: { new_orders: true, request_opportunities: true, new_messages: true, new_reviews: true, low_stock: true, payouts: true, complaints: true, system_alerts: true, marketing: false, new_followers: true, subscription_expiry: true }, forced: ['complaints', 'subscription_expiry', 'system_alerts'], wired: ['new_orders', 'request_opportunities', 'new_messages', 'new_reviews', 'low_stock', 'payouts', 'complaints', 'system_alerts', 'marketing'] });
  if (p === '/api/merchant/inbox') return ok({ threads: [{ id: 'chat_1', kind: 'order', context_id: 'ORD-7F3A21C9', order_id: 'ORD-7F3A21C9', customer: { name: en ? 'Sara Ahmed' : 'سارة أحمد', username: 'sara' }, last_message: en ? 'Can it be black?' : 'هل يمكن تغيير اللون إلى الأسود؟', last_message_at: ago(0, 1), last_from: 'customer', unread: 2 }], next_cursor: null });
  if (p === '/api/merchant/orders') {
    const st = q.get('status');
    return ok({ orders: st ? ORDERS.filter((o) => o.status === st) : ORDERS, next_cursor: null });
  }
  if (p.startsWith('/api/merchant/orders/') && p.endsWith('/timeline')) {
    const o = ORDERS.find((x) => p.includes(x.id)) ?? ORDERS[2];
    return ok({ ...TIMELINE, order_id: o.id, status: o.status, ...(o.status === 'delivered' ? {} : { credit_state: 'pending', events: TIMELINE.events.slice(0, 4) }) });
  }
  if (p.startsWith('/api/merchant/orders/')) {
    const o = ORDERS.find((x) => p.endsWith(x.id)) ?? ORDERS[0];
    return ok({ order: { ...o, customer_phone: '07701234567', address: { governorate: 'baghdad', city: en ? 'Karrada' : 'الكرادة', line1: en ? 'Street 62' : 'شارع 62', phone: '07701234567' }, coupon_code: '', coupon_discount_iqd: 0, payment_method_id: 'wallet', due_on_delivery_iqd: 0 }, items: [{ id: 'i1', name_snapshot: PRODUCTS[0].name, qty: 1, unit_price_iqd: 18000, line_total_iqd: 18000, option_snapshot: '' }] });
  }
  // «عروضي» on /merchant/requests (W5-A): GET /api/marketplace/my-offers, the real shape.
  if (p === '/api/marketplace/my-offers') return ok({ offers: [{ id: 'off_1', request_id: 'req_1', merchant_id: 'm1', price_iqd: 18000, completion_days: 3, delivery_method: 'merchant_delivery', message: '', materials: '', material_ids: ['petg'], included: '', warranty_terms: '', state: 'superseded', expires_at: ago(-5), created_at: ago(2), updated_at: ago(1), revision: 1, request_revision: 1, stale: true, expired: false, merchant: null, request: { id: 'req_1', title: en ? 'Car phone holder' : 'حامل هاتف للسيارة', state: 'receiving_offers', revision: 2, expires_at: ago(-20) }, order_id: null }], next_cursor: null });
  if (p === '/api/marketplace/orders') return ok({ orders: [{ id: 'cord_1', state: 'funded', price_iqd: 50000, merchant_receivable_iqd: 47500, created_at: ago(1), delivered_at: null, completed_at: null, auto_complete_at: null, request_title: en ? 'Bracket, PETG ×12' : 'حامل رف PETG ×12', merchant_name: 'Ali', store_slug: 'ali3d', role: 'merchant' }] });
  if (p === '/api/merchant/products/stats') return ok({ totals: { total: 3, published: 2, active: 2, draft: 1, hidden: 0, archived: 0, out_of_stock: 1, low_stock: 1, views: 200, sold: 53 }, weekly: [], categories: [], sales_daily: [] });
  if (p === '/api/merchant/products' && method === 'GET') {
    const stock = q.get('stock');
    const list = stock === 'low' ? PRODUCTS.filter((x) => x.low_stock) : stock === 'out' ? PRODUCTS.filter((x) => x.sold_out) : PRODUCTS;
    return ok({ products: list, total: list.length, next_cursor: null });
  }
  if (p === '/api/merchant/collections') return ok({ collections: [{ id: 'c1', name: en ? 'Figures' : 'مجسمات', name_ar: '', kind: 'manual', description: '', description_ar: '', image_url: null, image_key: null, sort_order: 0, active: true, product_count: 7 }] });
  if (p === '/api/merchant/services') return ok({ services: [{ id: 'sv1', title: en ? 'Print on demand' : 'طباعة حسب الطلب', description: '', kind: 'print_service', price_from_iqd: 5000, price_unit: '', materials: ['PLA', 'PETG'], imageUrl: null, active: true }] });
  if (p === '/api/merchant/showcase') return ok({ items: [] });
  if (p === '/api/merchant/coupons') return ok({ coupons: [{ id: 'cpn1', code: 'SUMMER25', kind: 'percent', value: 25, min_total_iqd: 20000, max_uses: 100, used_count: 14, active: true, starts_at: null, ends_at: ago(-3), created_at: ago(30) }] });
  if (p === '/api/merchant/reviews') return ok({ reviews: [{ id: 'r1', rating: 5, body: en ? 'Great print quality, fast delivery.' : 'جودة طباعة ممتازة وتوصيل سريع.', images: [], customer_name: en ? 'Sara' : 'سارة', merchant_reply: null, merchant_replied_at: null, hidden: false, created_at: ago(2) }] });
  if (p === '/api/merchant/customers') {
    const s = (q.get('q') ?? '').toLowerCase();
    return ok({ customers: s ? CUSTOMERS.filter((c) => c.name.toLowerCase().includes(s)) : CUSTOMERS, next_cursor: null });
  }
  if (p.startsWith('/api/merchant/customers/')) {
    const c = CUSTOMERS.find((x) => p.endsWith(x.key));
    if (!c) return { status: 404, body: { success: false, error: 'Customer not found', code: 'CUSTOMER_NOT_FOUND' } };
    return ok({
      customer: { key: c.key, name: c.name, order_count: c.order_count, spent_iqd: c.spent_iqd, cancelled_count: 1, average_order_iqd: Math.round(c.spent_iqd / c.order_count), first_order_at: c.first_order_at, last_order_at: c.last_order_at, returning: c.order_count > 1, governorate: c.governorate ?? 'baghdad', phone: '0770 123 4567' },
      orders: ORDERS.map((o) => ({ id: o.id, status: o.status, total_iqd: o.total_iqd, merchant_receivable_iqd: o.merchant_receivable_iqd, created_at: o.created_at, item_count: o.item_count, credit_state: o.credit_state, link: `/merchant/orders/${o.id}` })),
      next_cursor: null,
    });
  }
  if (p === '/api/merchant/printers') return ok({ printers: [], materials: [{ id: 'pla', name_en: 'PLA', name_ar: 'PLA' }], technologies: ['fdm', 'resin'], qualities: ['draft', 'standard', 'fine', 'ultra'] });
  if (p === '/api/merchant/request-prefs') return ok({ prefs: null, capability: {} });
  if (p === '/api/merchant/request-matches') return ok({ matches: [] });
  if (p === '/api/merchant/delivery') return ok({ profile: { default_mode: 'fee', default_fee_iqd: 5000, free_over_iqd: 50000, free_over_basis: 'after_discount', pickup_enabled: false, pickup_governorate: '', pickup_note: '', prep_days: 1, note: '', version: 3 }, rules: [{ governorate_id: 'baghdad', mode: 'fee', fee_iqd: 3000, free_over_iqd: null, prep_days: null, eta_note: '', note: '' }], configured: true, store_open: true, coverage: { served: ['baghdad'], pickup: false, serviceable: true } });
  if (p === '/api/merchant/store/layout') return ok({ draft: { exists: true, version: 2, base_revision: null, updated_at: ago(0), layout }, published: null, dirty: true, revisions: [], revision_count: 0, limits: { max_revisions: 50, max_blocks: 40, max_bytes: 64000 }, themes: ['classic'] });
  if (p === '/api/merchant/store/layout/preview') return ok({ source: 'draft', layout, blocks_data: emptyBlockData() });
  if (p === '/api/merchant/finance/summary') return ok({ summary: { gross: 412_000, store_gross: 362_000, custom_gross: 50_000, commission: 20_600, delivery_fees: 24_000, refunds: 16_000, adjustments: 0, receivable: 399_400, pending: 61_300, pending_frozen: 15_300, available: 182_100, reserved: 60_000, paid_out: 96_000, escrow_held: 47_500, open_payouts: 1 }, buckets: {} });
  if (p === '/api/merchant/finance/ledger') return ok({ entries: [], next_cursor: null });
  if (p === '/api/merchant/payouts') return ok({ buckets: {}, methods: [], payouts: [], next_cursor: null });
  // The request board, both views (W6 sweep): /requests «كل الطلبات» and «مناسب لي».
  if (p === '/api/marketplace/requests' || p === '/api/merchant/workshop/board') {
    const req = (id: string, title: string, o: Record<string, unknown> = {}) => ({
      id, title, description: '', category: 'print', quantity: 1, material: '', color: '', dimensions: '', budget_iqd: null, deadline: null,
      governorate: 'baghdad', delivery_pref: 'delivery', state: 'open', offer_count: 2, created_at: ago(1), expires_at: ago(-20), customer_name: null,
      revision: 1, customer_notes: '', process: 'fdm', material_id: 'pla', estimate_low_iqd: 9000, estimate_high_iqd: 14000,
      file_count: 1, thumb_url: null, has_preview: true, my_offer: null, ...o,
    });
    return ok({
      requests: [
        req('req_1', en ? 'Car phone holder, clips onto the vent' : 'حامل هاتف للسيارة يثبت على فتحة المكيف', { quantity: 2, budget_iqd: 25000 }),
        req('req_2', en ? 'Replacement gear for a kitchen mixer' : 'ترس بديل لخلاط المطبخ', { governorate: 'basra', my_offer: 'pending' }),
        req('req_3', en ? 'Cosplay helmet, painted' : 'خوذة كوسبلاي مطلية', { budget_iqd: 120000, offer_count: 5, has_preview: false }),
      ],
      next_cursor: null,
    });
  }
  if (p === '/api/marketplace/print/catalog') return ok({ materials: [{ id: 'pla', process: 'fdm', name_en: 'PLA', name_ar: 'PLA', needs_enclosure: false, abrasive: false }], qualities: [], min_job_iqd: 0 });
  if (p === '/api/merchant/store/share') return ok({ store_id: 's1', url: STORE.url, host: 'ali3d.levonis-iq.com', card: { title: STORE.name, description: '', image: '', site_name: 'Levonis', url: STORE.url }, app_icon: { state: 'none', reason: null, icon: null, maskable: null, name: STORE.name, short_name: 'Ali 3D', background: '#0b0c0f' }, suspended: false });
  return ok({});
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url, location.origin);
  if (!u.pathname.startsWith('/api/')) return realFetch(input, init);
  // What the page asked for, for the probes (W3-B: a range preset re-asks the report).
  ((window as unknown as { __apiCalls?: string[] }).__apiCalls ??= []).push(`${u.pathname}${u.search}`);
  const r = answer(u.pathname, u.searchParams, (init?.method ?? 'GET').toUpperCase());
  await new Promise((res) => setTimeout(res, 50));
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
};

createRoot(document.getElementById('root')!).render(<App />);
