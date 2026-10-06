/**
 * «هداياي» and the admin «الهدايا» screens, MOUNTED with explicit API fixtures
 * (owner brief 2026-10-06 §1; docs/GIFTS_QUICK_BUY.md §1.3).
 * Run: scripts/e2e-gifts.mjs against Vite.
 *
 *   ?view=customer&scenario=all   one card in every status (and a legacy box)
 *   ?view=customer&scenario=flow  ONE gift walked through choose → redeem →
 *                                 add to cart, the fixture answering as the
 *                                 server does
 *   ?view=admin&tab=levels|grants the admin screens
 *   ?view=cart | order | orders   the gift line in the real cart, order and
 *                                 orders list pages («هدية — 0 د.ع»)
 *   &lang=ar|en|ckb  &theme=dark|light
 *
 * Every API the screens call is answered here; anything else 404s loudly, so
 * a screen that starts calling a new endpoint fails here instead of passing on
 * a stub that says yes to everything. The requests are kept on
 * `window.giftRequests` for the runner to assert on.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../../src/AuthContext';
import { LanguageProvider } from '../../src/LanguageContext';
import { WalletProvider } from '../../src/WalletContext';
import { CurrencyProvider } from '../../src/CurrencyContext';
import MyGifts from '../../src/components/reviews/MyGifts';
import AdminGifts from '../../src/components/adminGifts/AdminGifts';
import Cart from '../../src/pages/Cart';
import OrderDetail from '../../src/pages/OrderDetail';
import Orders from '../../src/pages/Orders';
// Real server payloads (tests/fixtures/giftWorld.ts through the real routes):
// a cart holding a gift line beside a bought line, and the order it became.
import served from './gifts-data.json';
import '../../src/components/adminProducts/theme.css';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const VIEWS = ['customer', 'admin', 'cart', 'order', 'orders'] as const;
const view = (VIEWS as readonly string[]).includes(params.get('view') ?? '') ? (params.get('view') as (typeof VIEWS)[number]) : 'customer';
const scenario = params.get('scenario') === 'flow' ? 'flow' : 'all';
const lang = ['en', 'ckb'].includes(params.get('lang') ?? '') ? params.get('lang')! : 'ar';
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.lang = lang === 'ckb' ? 'ckb' : lang;
document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
localStorage.setItem('levo_lang', lang);

// ------------------------------------------------------------- the pictures

const art = (fill: string, accent: string, shape: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="${fill}"/>${shape.replace(/ACC/g, accent)}</svg>`
  )}`;
const NOZZLE_IMG = art('#1d2026', '#c9a85a', '<path d="M48 22h24v30l10 14v10H38V66l10-14z" fill="ACC"/><rect x="54" y="76" width="12" height="20" rx="3" fill="#8b8f98"/>');
const PLATE_IMG = art('#20232a', '#3b3f47', '<rect x="16" y="34" width="88" height="56" rx="6" fill="#d9c79a"/><rect x="22" y="40" width="76" height="44" rx="4" fill="ACC" opacity=".35"/>');
const CLEANER_IMG = art('#1b1e23', '#6f9bd1', '<rect x="56" y="20" width="8" height="70" rx="3" fill="ACC"/><circle cx="60" cy="96" r="7" fill="#8b8f98"/>');

const tri = (ar: string, en: string, ckb: string) => ({ ar, en, ckb });
const levelOf = (n: number, ar: string, en: string, ckb: string, d = tri('', '', '')) => ({ n, name: tri(ar, en, ckb), description: d, active: true });
const GOLD = levelOf(
  3,
  'الهدية الذهبية',
  'Gold gift',
  'دیاریی زێڕین',
  tri('اختر قطعة أصلية لطابعتك', 'Pick a genuine part for your printer', 'پارچەیەکی ڕەسەن بۆ چاپکەرەکەت هەڵبژێرە')
);
const SILVER = levelOf(2, 'الهدية الفضية', 'Silver gift', 'دیاریی زیو');
const BRONZE = levelOf(1, 'الهدية البرونزية', 'Bronze gift', 'دیاریی برۆنز');

const nozzle = (itemId: string | null, colorEn = 'Red', hex = '#cc3b3b') => ({
  item_id: itemId,
  product_id: 'p_nozzle',
  slug: 'nozzle-kit',
  name: tri('طقم فوهات', 'Hardened Nozzle Kit 0.4', 'کیتی نۆزڵ'),
  image: NOZZLE_IMG,
  variant: tri('0.4 مم', '0.4 mm', '0.4 ملم'),
  color: { ...tri(colorEn === 'Red' ? 'أحمر' : 'أزرق', colorEn, colorEn === 'Red' ? 'سوور' : 'شین'), hex },
  qty: 1,
  sale_type: 'direct_sale',
  transport_method: '',
  value_iqd: 40000,
  lead_time_text: '',
  available: true,
  reason: null,
});
const plate = (itemId: string | null) => ({
  item_id: itemId,
  product_id: 'p_plate',
  slug: 'pei-plate',
  name: tri('لوح PEI', 'Textured PEI Plate', 'تەختەی PEI'),
  image: PLATE_IMG,
  variant: tri('PEI محبب', 'Textured PEI', 'PEI ی دانەدار'),
  color: { ...tri('أسود', 'Black', 'ڕەش'), hex: '#151515' },
  qty: 1,
  sale_type: 'pre_order',
  transport_method: 'air',
  value_iqd: 60000,
  lead_time_text: '10-14 days',
  lead_time_min_days: 10,
  lead_time_max_days: 14,
  available: true,
  reason: null,
});
const cleaner = (itemId: string | null) => ({
  item_id: itemId,
  product_id: 'p_plain',
  slug: 'nozzle-cleaner',
  name: tri('منظف فوهات', 'Nozzle Cleaning Kit', 'پاککەرەوەی نۆزڵ'),
  image: CLEANER_IMG,
  variant: tri('', '', ''),
  color: null,
  qty: 2,
  sale_type: 'direct_sale',
  transport_method: '',
  value_iqd: 30000,
  lead_time_text: '',
  available: false,
  reason: 'OUT_OF_STOCK',
});

const base = {
  mode: 'level',
  reason: 'review',
  choices: null,
  chosen: null,
  can_change_choice: false,
  cart_item_id: null,
  order: null,
  granted_at: '2026-10-01T09:00:00.000Z',
  chosen_at: null,
  redeemed_at: null,
  ordered_at: null,
  fulfilled_at: null,
  cancelled_at: null,
  legacy: null,
};

type Gift = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const flowGift = (): Gift => ({
  ...base,
  id: 'gift_flow',
  status: 'GRANTED',
  reason: 'compensation',
  level: GOLD,
  can_change_choice: true,
  choices: [nozzle('gpi_nozzle'), plate('gpi_plate'), cleaner('gpi_cleaner')],
});

const allGifts = (): Gift[] => [
  flowGift(),
  { ...base, id: 'gift_ready', status: 'READY_TO_REDEEM', mode: 'product', reason: 'admin_gift', level: SILVER, chosen: plate(null), chosen_at: '2026-10-02T10:00:00.000Z' },
  { ...base, id: 'gift_redeemed', status: 'REDEEMED', mode: 'product', reason: 'reward', level: BRONZE, chosen: nozzle(null), redeemed_at: '2026-10-03T11:00:00.000Z' },
  { ...base, id: 'gift_cart', status: 'ADDED_TO_ORDER', level: GOLD, chosen: nozzle('gpi_nozzle', 'Blue', '#3b6fcc'), redeemed_at: '2026-10-03T12:00:00.000Z', cart_item_id: 'ci_gift' },
  {
    ...base,
    id: 'gift_ordered',
    status: 'ORDERED',
    level: GOLD,
    chosen: plate('gpi_plate'),
    redeemed_at: '2026-10-04T08:00:00.000Z',
    ordered_at: '2026-10-04T08:30:00.000Z',
    order: { id: 'ORD-7F3A21C9', status: 'confirmed', stage: 'confirmed' },
  },
  {
    ...base,
    id: 'gift_fulfilled',
    status: 'FULFILLED',
    reason: 'compensation',
    level: SILVER,
    chosen: nozzle(null),
    redeemed_at: '2026-09-20T08:00:00.000Z',
    ordered_at: '2026-09-20T09:00:00.000Z',
    fulfilled_at: '2026-09-24T15:00:00.000Z',
    order: { id: 'ORD-51B0E2A4', status: 'delivered', stage: 'delivered' },
  },
  { ...base, id: 'gift_cancelled', status: 'CANCELLED', reason: 'admin_gift', level: BRONZE, cancelled_at: '2026-09-28T10:00:00.000Z' },
  {
    ...base,
    id: 'gift_legacy',
    status: 'LEGACY',
    mode: 'legacy',
    reason: 'legacy',
    level: null,
    legacy: {
      id: 'gift_legacy',
      max_level: 3,
      chosen_level: null,
      chosen_options: {},
      contents: [],
      state: 'available',
      created_at: '2026-08-15T10:00:00.000Z',
      selected_at: null,
      fulfilled_at: null,
      product: { id: 'p_printer', name: 'Bambu Lab P1S', name_ar: 'Bambu Lab P1S' },
      levels: [
        { level: 1, available: true, reason: 'ok', nozzle_sizes: [], plates: [] },
        { level: 2, available: false, reason: 'pool_unconfigured', nozzle_sizes: [], plates: [] },
        { level: 3, available: true, reason: 'ok', nozzle_sizes: [], plates: [] },
      ],
    },
  },
];

const gifts: Gift[] = scenario === 'flow' ? [flowGift()] : allGifts();

// ------------------------------------------------------------- the admin data

const adminItem = (id: string, level: number, item: Gift, active = true) => ({
  ...item,
  id,
  level,
  active,
  sort: 0,
  option_value_ids: item.product_id === 'p_plate' ? ['v_pei'] : item.product_id === 'p_nozzle' ? ['v_04'] : [],
  color_id: item.color ? 'c_x' : '',
  updated_at: '2026-10-01T09:00:00.000Z',
});
const levels = [
  { ...BRONZE, description: tri('ملحقات صغيرة', 'Small accessories', 'پاشکۆی بچووک'), updated_at: null, items: [adminItem('gpi_cleaner', 1, cleaner('gpi_cleaner'))], legacy_items: [] },
  { ...SILVER, updated_at: null, items: [adminItem('gpi_plate2', 2, plate('gpi_plate2'))], legacy_items: [] },
  {
    ...GOLD,
    updated_at: '2026-10-02T09:00:00.000Z',
    items: [adminItem('gpi_nozzle', 3, nozzle('gpi_nozzle')), adminItem('gpi_plate', 3, plate('gpi_plate')), adminItem('gpi_old', 3, cleaner('gpi_old'), false)],
    legacy_items: [
      { id: 'gpi_box', level: 3, kind: 'accessory', label: tri('حامل بكرة', 'Spool holder', 'هەڵگری بکەرە'), brand: 'Bambu', material: '', color: '', option_value: '', stock: 4, active: true },
    ],
  },
  { ...levelOf(4, 'الهدية الماسية', 'Diamond gift', 'دیاریی ئەڵماس'), active: false, updated_at: null, items: [], legacy_items: [] },
  { ...levelOf(5, 'المستوى الخامس', 'Level 5', 'ئاستی پێنجەم'), updated_at: null, items: [], legacy_items: [] },
];

const user = (id: string, name: string, email: string, phone: string) => ({ id, name, email, username: id, phone, role: 'customer' });
const SARA = user('u_sara', 'سارة أحمد', 'sara@example.com', '+9647701234567');
const OMAR = user('u_omar', 'Omar Khalid', 'omar@example.com', '+9647709876543');
const grant = (g: Gift, extra: Gift = {}): Gift => ({
  id: g.id,
  status: g.status,
  state: String(g.status).toLowerCase(),
  mode: g.mode,
  reason: g.reason,
  level: g.level,
  user: SARA,
  note: 'تأخر الطلب السابق — اتصلت الإدارة بالزبونة',
  granted_by: { id: 'boss', name: 'المدير', email: 'boss@levonis.iq' },
  granted_at: g.granted_at,
  chosen: g.chosen,
  item_id: g.chosen?.item_id ?? null,
  cart_item_id: g.cart_item_id,
  order: g.order,
  order_seq: g.order ? 1 : 0,
  chosen_at: g.chosen_at,
  redeemed_at: g.redeemed_at,
  ordered_at: g.ordered_at,
  fulfilled_at: g.fulfilled_at,
  cancelled_at: g.cancelled_at,
  cancelled_by: g.cancelled_at ? 'boss' : null,
  cancel_reason: g.cancelled_at ? 'مُنحت مرتين بالخطأ' : '',
  version: 2,
  reward_id: null,
  legacy: null,
  actions: { cancel: ['GRANTED', 'READY_TO_REDEEM', 'REDEEMED', 'ADDED_TO_ORDER'].includes(g.status), edit_reason: true, convert: false, fulfill: false },
  ...extra,
});
const grants = allGifts()
  .filter((g) => g.status !== 'LEGACY')
  .map((g, i) => grant(g, i % 2 ? { user: OMAR } : {}));
grants.push(
  grant(allGifts()[7], {
    status: 'LEGACY',
    state: 'available',
    mode: 'legacy',
    reason: 'legacy',
    level: null,
    note: '',
    granted_by: null,
    legacy: { state: 'available', max_level: 3, chosen_level: null, contents: [], selected_at: null },
    actions: { cancel: true, edit_reason: false, convert: true, fulfill: false },
  })
);
const audit = [
  { id: 1, action: 'gift.grant', actor: { id: 'boss', name: 'المدير', email: 'boss@levonis.iq' }, detail: { level: 3 }, at: '2026-10-04 08:00:00' },
  { id: 2, action: 'gift.choose', actor: { id: 'u_sara', name: 'سارة أحمد', email: 'sara@example.com' }, detail: {}, at: '2026-10-04 08:10:00' },
  { id: 3, action: 'gift.redeem', actor: { id: 'u_sara', name: 'سارة أحمد', email: 'sara@example.com' }, detail: {}, at: '2026-10-04 08:12:00' },
  { id: 4, action: 'gift.cart_add', actor: { id: 'u_sara', name: 'سارة أحمد', email: 'sara@example.com' }, detail: {}, at: '2026-10-04 08:13:00' },
  { id: 5, action: 'gift.cart_remove', actor: { id: 'u_sara', name: 'سارة أحمد', email: 'sara@example.com' }, detail: {}, at: '2026-10-04 08:20:00' },
  { id: 6, action: 'gift.cart_add', actor: { id: 'u_sara', name: 'سارة أحمد', email: 'sara@example.com' }, detail: {}, at: '2026-10-04 08:25:00' },
  { id: 7, action: 'gift.order', actor: { id: 'u_sara', name: 'سارة أحمد', email: 'sara@example.com' }, detail: { order_id: 'ORD-7F3A21C9' }, at: '2026-10-04 08:30:00' },
];
const options = {
  product: { id: 'p_nozzle', slug: 'nozzle-kit', name_en: 'Hardened Nozzle Kit 0.4', name_ar: 'طقم فوهات', name_ckb: 'کیتی نۆزڵ', image: NOZZLE_IMG, status: 'active', composition: '', price_iqd: 40000 },
  giftable: true,
  sale_types: ['direct_sale'],
  groups: [
    {
      id: 'g_size',
      name_en: 'Size',
      values: [
        { id: 'v_04', name_en: '0.4 mm', name_ar: '0.4 مم', name_ckb: '0.4 ملم', stock: 3, sale_types: [], routes: [] },
        { id: 'v_06', name_en: '0.6 mm', name_ar: '0.6 مم', name_ckb: '0.6 ملم', stock: 0, sale_types: [], routes: [] },
      ],
    },
  ],
  colors: [
    { id: 'c_red', name_en: 'Red', name_ar: 'أحمر', name_ckb: 'سوور', hex: '#cc3b3b', stock: null, links: [] },
    { id: 'c_blue', name_en: 'Blue', name_ar: 'أزرق', name_ckb: 'شین', hex: '#3b6fcc', stock: null, links: [] },
  ],
  transports: [],
};
const pickerProducts = [
  { id: 'p_nozzle', name_en: 'Hardened Nozzle Kit 0.4', name_ar: 'طقم فوهات', sku: 'NZ-04', price_iqd: 40000, status: 'active', composition: '' },
  { id: 'p_plate', name_en: 'Textured PEI Plate', name_ar: 'لوح PEI', sku: 'PEI-T', price_iqd: 60000, status: 'active', composition: '' },
];

// ---------------------------------------------------------------- the server

const requests: Array<{ path: string; method: string; body?: unknown }> = [];
const unstubbed: string[] = [];
Object.assign(window, { giftRequests: requests, giftUnstubbed: unstubbed });
const ok = (data: Record<string, unknown>) =>
  new Response(JSON.stringify({ success: true, ...data }), { status: 200, headers: { 'content-type': 'application/json' } });
const refuse = (status: number, code: string, error: string) =>
  new Response(JSON.stringify({ success: false, code, error }), { status, headers: { 'content-type': 'application/json' } });
const now = () => new Date().toISOString();

const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, location.origin);
  const p = url.pathname;
  const method = (init?.method || 'GET').toUpperCase();
  if (!p.startsWith('/api/')) return realFetch(input as RequestInfo, init);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  requests.push({ path: `${p}${url.search}`, method, body });
  await new Promise((r) => setTimeout(r, 120));

  if (p === '/api/auth/me') return ok({ user: { id: 'u_sara', name: 'سارة', email: 'sara@example.com', role: view === 'admin' ? 'admin' : 'customer' } });
  if (p.startsWith('/api/wallet') || p.startsWith('/api/settings') || p.startsWith('/api/notifications') || p.startsWith('/api/currency')) return ok({});

  // ---- the cart, the order and the orders list (the gift line)
  if (p === '/api/cart' && method === 'GET') return ok(served.cart);
  const orderId = served.order.order.id;
  if (p === `/api/orders/${orderId}`) return ok(served.order);
  if (p === `/api/orders/${orderId}/tracking`) return ok(served.tracking);
  if (p === `/api/orders/${orderId}/units`) return ok(served.units);
  if (p === `/api/orders/${orderId}/price-adjustment`) return ok({ pending: null });
  if (p === '/api/orders' && method === 'GET') return ok(served.orders);
  if (p === '/api/orders/counts') return ok({ counts: { all: 1, pending: 1 } });
  if (p === '/api/reviews/mine') return ok({ reviews: [] });
  if (p === '/api/community-reviews/eligible') return ok({ eligible: [] });
  if (p === '/api/price-protection/claims') return ok({ claims: [] });
  if (p === '/api/returns') return ok({ cases: [] });
  if (p.startsWith('/api/reviews/order/')) return ok({ order_id: orderId, items: [], reviewed: [] });
  if (p.startsWith('/api/community/') || p.startsWith('/api/store-reviews') || p.startsWith('/api/merchant')) return ok({ items: [], reviews: [], pending: [] });

  // ---- the customer
  if (p === '/api/gifts' && method === 'GET') return ok({ gifts });
  const choose = /^\/api\/gifts\/([^/]+)\/choose$/.exec(p);
  if (choose && method === 'POST') {
    const g = gifts.find((x) => x.id === choose[1]);
    const item = g?.choices?.find((c: Gift) => c.item_id === body?.itemId);
    if (!g || !item) return refuse(404, 'GIFT_NOT_FOUND', 'not found');
    if (item.available === false) return refuse(409, 'GIFT_ITEM_UNAVAILABLE', 'unavailable');
    Object.assign(g, { status: 'READY_TO_REDEEM', chosen: item, chosen_at: now() });
    return ok({ gift: g });
  }
  const redeem = /^\/api\/gifts\/([^/]+)\/redeem$/.exec(p);
  if (redeem && method === 'POST') {
    const g = gifts.find((x) => x.id === redeem[1]);
    if (!g) return refuse(404, 'GIFT_NOT_FOUND', 'not found');
    if (g.status === 'READY_TO_REDEEM') Object.assign(g, { status: 'REDEEMED', choices: null, can_change_choice: false, redeemed_at: now() });
    return ok({ gift: g });
  }
  if (p === '/api/cart/gift-items' && method === 'POST') {
    const g = gifts.find((x) => x.id === body?.giftId);
    if (!g) return refuse(404, 'GIFT_NOT_FOUND', 'not found');
    if (g.status !== 'REDEEMED') return refuse(409, 'GIFT_NOT_REDEEMED', 'redeem first');
    // &conflict=shipping: the cart holds another shipping type, as the server
    // answers it (400 CART_SHIPPING_CONFLICT) until the customer says «empty it».
    if (params.get('conflict') === 'shipping' && body?.replaceCart !== true) {
      return refuse(400, 'CART_SHIPPING_CONFLICT', 'Your cart holds items with a different shipping type. It must be emptied to add this one.');
    }
    Object.assign(g, { status: 'ADDED_TO_ORDER', cart_item_id: 'ci_gift' });
    return ok({ items: [{ id: 'ci_gift', kind: 'gift', qty: 1, unit_price_iqd: 0 }], tier: 'free', tierActive: false });
  }

  // ---- the admin
  if (p === '/api/gifts/admin/levels' && method === 'GET') return ok({ levels });
  const levelPut = /^\/api\/gifts\/admin\/levels\/(\d)$/.exec(p);
  if (levelPut && method === 'PUT') {
    const l = levels[Number(levelPut[1]) - 1];
    l.name = tri(body.name_ar, body.name_en, body.name_ckb);
    l.description = tri(body.description_ar, body.description_en, body.description_ckb);
    l.active = body.active;
    return ok({ level: l });
  }
  const itemPost = /^\/api\/gifts\/admin\/levels\/(\d)\/items$/.exec(p);
  if (itemPost && method === 'POST') {
    const n = Number(itemPost[1]);
    const item = adminItem(`gpi_new_${levels[n - 1].items.length}`, n, nozzle(null, body.colorId === 'c_blue' ? 'Blue' : 'Red', body.colorId === 'c_blue' ? '#3b6fcc' : '#cc3b3b'));
    levels[n - 1].items.push(item);
    return ok({ item });
  }
  if (/^\/api\/gifts\/admin\/items\/[^/]+$/.test(p) && (method === 'PUT' || method === 'DELETE')) return ok({});
  if (/^\/api\/gifts\/admin\/products\/[^/]+\/options$/.test(p)) return ok({ options });
  if (p === '/api/admin/products-v2') return ok({ products: pickerProducts, total: pickerProducts.length });
  const pickerOne = /^\/api\/admin\/products-v2\/([^/]+)$/.exec(p);
  if (pickerOne) return ok({ product: pickerProducts.find((x) => x.id === pickerOne[1]) ?? pickerProducts[0] });
  if (p === '/api/gifts/admin/users') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    return ok({ users: [SARA, OMAR].filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(q)) });
  }
  if (p === '/api/gifts/admin/grants' && method === 'GET') {
    const status = url.searchParams.get('status');
    return ok({ grants: status ? grants.filter((g) => g.status === status) : grants, next_cursor: null });
  }
  if (p === '/api/gifts/admin/grants' && method === 'POST') {
    const g = grant({ ...flowGift(), id: `gift_new_${grants.length}` }, { user: SARA, reason: body.reason, note: body.note });
    grants.unshift(g);
    return ok({ grant: g });
  }
  const detail = /^\/api\/gifts\/admin\/grants\/([^/]+)$/.exec(p);
  if (detail && method === 'GET') {
    const g = grants.find((x) => x.id === detail[1]);
    return g ? ok({ grant: g, audit: g.status === 'ORDERED' ? audit : audit.slice(0, 1) }) : refuse(404, 'NOT_FOUND', 'Gift not found');
  }
  if (detail && method === 'PATCH') {
    const g = grants.find((x) => x.id === detail[1])!;
    Object.assign(g, { note: body.note ?? g.note, reason: body.reason ?? g.reason });
    return ok({ grant: g });
  }

  unstubbed.push(`${method} ${p}`);
  return refuse(404, 'NOT_STUBBED', `Fixture missing ${method} ${p}`);
}) as typeof window.fetch;

// ------------------------------------------------------------------- render

function Admin() {
  return (
    <div dir={lang === 'en' ? 'ltr' : 'rtl'} style={{ maxWidth: 1280, margin: '0 auto', padding: 12 }}>
      <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-2xl p-4 md:p-5 text-white">
        <AdminGifts initialView={params.get('tab') === 'grants' ? 'grants' : 'levels'} />
      </div>
    </div>
  );
}

function Customer() {
  return (
    <div className="p-4">
      <MyGifts />
    </div>
  );
}

const START: Record<(typeof VIEWS)[number], string> = {
  customer: '/gifts',
  admin: '/gifts',
  cart: '/cart',
  order: `/orders/${served.order.order.id}`,
  orders: '/orders',
};

createRoot(document.getElementById('root')!).render(
  <AuthProvider>
    <LanguageProvider>
      <WalletProvider>
        <CurrencyProvider>
          <MemoryRouter initialEntries={[START[view]]}>
            <div className="min-h-screen bg-canvas text-text-primary">
              <Routes>
                <Route path="/gifts" element={view === 'admin' ? <Admin /> : <Customer />} />
                <Route path="/cart" element={<Cart />} />
                <Route path="/orders" element={<Orders />} />
                <Route path="/orders/:id" element={<OrderDetail />} />
                <Route path="*" element={<p data-left-gifts>left the gifts page</p>} />
              </Routes>
            </div>
          </MemoryRouter>
        </CurrencyProvider>
      </WalletProvider>
    </LanguageProvider>
  </AuthProvider>
);
