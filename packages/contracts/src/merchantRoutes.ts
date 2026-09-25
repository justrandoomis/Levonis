/**
 * THE MERCHANT WORKSPACE'S ADDRESSES — one spelling, shared by the Worker that
 * writes them into notifications and the SPA that routes them.
 *
 * WHY A CONTRACT. A merchant notification is a pointer to a real object (an
 * order, a thread, a request, a coupon), stored as a PATH in
 * `user_notifications.link` and read back months later. If the Worker spelled
 * "the order page" one way and the router another, every stored link would be
 * a dead link the day either side changed. So both import these builders and
 * this parser, and nothing else writes a `/merchant/…` path by hand.
 *
 * The tree is the plan's (docs/MERCHANT_PLATFORM.md §4.6). On the platform's
 * own host it lives under `/merchant`; on a store's subdomain the same tree is
 * served under `/admin` (`hostPath`). Stored links always use `/merchant` —
 * the host decides where they open, never the row.
 *
 * Pure: no imports, no I/O. Ids are URI-encoded on the way in and decoded on
 * the way out, and the parser accepts only the shapes below, so a stored link
 * can never smuggle a query or a second path into the router.
 */

export const MERCHANT_BASE = '/merchant';
/** The same workspace on a merchant's own subdomain. */
export const STORE_HOST_BASE = '/admin';

export type MerchantSection =
  | 'home'
  | 'orders'
  | 'products'
  | 'customers'
  | 'inbox'
  | 'coupons'
  | 'collections'
  | 'services'
  | 'showcase'
  | 'printers'
  | 'costing'
  | 'requests'
  | 'custom_orders'
  | 'money'
  | 'analytics'
  | 'reviews'
  | 'notifications'
  | 'store_design'
  | 'store_settings'
  | 'store_delivery';

/** The path of each section below the base ('' is the Command Center). */
export const SECTION_PATHS: Readonly<Record<MerchantSection, string>> = {
  home: '',
  orders: 'orders',
  products: 'products',
  customers: 'customers',
  inbox: 'inbox',
  coupons: 'marketing/coupons',
  collections: 'collections',
  services: 'services',
  showcase: 'showcase',
  printers: 'printers',
  costing: 'costing',
  requests: 'requests',
  // A custom order is the job a request became; it lives under the request
  // board it came from.
  custom_orders: 'requests/orders',
  money: 'money',
  analytics: 'analytics',
  reviews: 'reviews',
  notifications: 'notifications',
  store_design: 'store/design',
  store_settings: 'store/settings',
  store_delivery: 'store/delivery',
};

/** Sections whose path may carry one object id after it. */
export const SECTIONS_WITH_ID: ReadonlySet<MerchantSection> = new Set<MerchantSection>([
  'orders',
  'products',
  // A customer is addressed by their first order with the store — an order
  // id, never a user id (W3-B, worker/routes/merchantCustomers.ts).
  'customers',
  'inbox',
  'coupons',
  'requests',
  'custom_orders',
]);

/**
 * Ids are opaque tokens: letters, digits, `_`, `-`, `.`; never a slash or a
 * query — and never dots alone: `.` / `..` are path segments a URL parser
 * resolves, so `/orders/..` would reach the router as an id and a fetch built
 * from it as a different endpoint (W3-A).
 */
const ID_RE = /^(?!\.+$)[A-Za-z0-9_.-]{1,80}$/;

function at(section: MerchantSection, id?: string): string {
  const path = SECTION_PATHS[section];
  const base = path ? `${MERCHANT_BASE}/${path}` : MERCHANT_BASE;
  if (id === undefined) return base;
  if (!SECTIONS_WITH_ID.has(section) || !ID_RE.test(id)) return base;
  return `${base}/${encodeURIComponent(id)}`;
}

/**
 * The builders. An id that is not a plain token falls back to the section
 * itself rather than producing a path the parser would refuse — a link that
 * opens the right list is better than a dead one.
 */
export const merchantHref = {
  home: () => at('home'),
  orders: () => at('orders'),
  order: (orderId: string) => at('orders', orderId),
  products: () => at('products'),
  product: (productId: string) => at('products', productId),
  customers: () => at('customers'),
  customer: (customerKey: string) => at('customers', customerKey),
  inbox: () => at('inbox'),
  thread: (chatId: string) => at('inbox', chatId),
  coupons: () => at('coupons'),
  coupon: (couponId: string) => at('coupons', couponId),
  collections: () => at('collections'),
  services: () => at('services'),
  showcase: () => at('showcase'),
  printers: () => at('printers'),
  costing: () => at('costing'),
  requests: () => at('requests'),
  request: (requestId: string) => at('requests', requestId),
  customOrder: (orderId: string) => at('custom_orders', orderId),
  customOrders: () => at('custom_orders'),
  money: () => at('money'),
  analytics: () => at('analytics'),
  reviews: () => at('reviews'),
  notifications: () => at('notifications'),
  storeDesign: () => at('store_design'),
  storeSettings: () => at('store_settings'),
  storeDelivery: () => at('store_delivery'),
  /** The orders list opened on one status (the Command Center's «3 new»). */
  ordersInStatus: (status: OrderStatusFilter) =>
    (ORDER_STATUS_FILTERS as readonly string[]).includes(status) ? `${at('orders')}?status=${status}` : at('orders'),
  /** The published products that are running low / sold out. */
  productsInStock: (stock: StockFilter) =>
    (STOCK_FILTERS as readonly string[]).includes(stock) ? `${at('products')}?state=published&stock=${stock}` : at('products'),
  /** The quick-create doors: the section, with its «new» form open. */
  newProduct: () => `${at('products')}?new=1`,
  newCoupon: () => `${at('coupons')}?new=1`,
  newCollection: () => `${at('collections')}?new=1`,
} as const;

/**
 * THE FEW QUERY WORDS A WORKSPACE ADDRESS MAY CARRY — each from a closed list,
 * so a stored or typed link can open a list on a filter, or a «new» form, and
 * nothing else. Anything outside the lists is dropped, never passed on.
 */
export const ORDER_STATUS_FILTERS = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'] as const;
export type OrderStatusFilter = (typeof ORDER_STATUS_FILTERS)[number];
export const STOCK_FILTERS = ['low', 'out'] as const;
export type StockFilter = (typeof STOCK_FILTERS)[number];
export const PRODUCT_STATE_FILTERS = ['published', 'draft', 'hidden', 'archived'] as const;
export type ProductStateFilter = (typeof PRODUCT_STATE_FILTERS)[number];

export interface WorkspaceQuery {
  status?: OrderStatusFilter;
  stock?: StockFilter;
  state?: ProductStateFilter;
  /** Open the section's «new» form. */
  create: boolean;
}

export function readWorkspaceQuery(search: string): WorkspaceQuery {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(String(search ?? '').replace(/^\?/, ''));
  } catch {
    return { create: false };
  }
  const pick = <T extends string>(key: string, list: readonly T[]): T | undefined => {
    const v = params.get(key);
    return v !== null && (list as readonly string[]).includes(v) ? (v as T) : undefined;
  };
  const out: WorkspaceQuery = { create: params.get('new') === '1' };
  const status = pick('status', ORDER_STATUS_FILTERS);
  const stock = pick('stock', STOCK_FILTERS);
  const state = pick('state', PRODUCT_STATE_FILTERS);
  if (status) out.status = status;
  if (stock) out.stock = stock;
  if (state) out.state = state;
  return out;
}

export interface MerchantLocation {
  section: MerchantSection;
  /** The object the path names, decoded — absent for a section's own page. */
  id?: string;
}

/** Longest paths first, so `requests/orders/x` never reads as request `orders`. */
const MATCH_ORDER: readonly MerchantSection[] = (Object.keys(SECTION_PATHS) as MerchantSection[])
  .filter((s) => s !== 'home')
  .sort((a, b) => SECTION_PATHS[b].length - SECTION_PATHS[a].length);

/**
 * Which workspace destination a path names, or null when it is not one.
 *
 * `base` is where the workspace is mounted on this host (`/merchant` or
 * `/admin`). A query string or hash is ignored; a trailing slash is allowed.
 */
export function parseMerchantPath(pathname: string, base: string = MERCHANT_BASE): MerchantLocation | null {
  const clean = String(pathname ?? '').split(/[?#]/)[0].replace(/\/+$/, '');
  if (clean === base) return { section: 'home' };
  if (!clean.startsWith(`${base}/`)) return null;
  const rest = clean.slice(base.length + 1);
  for (const section of MATCH_ORDER) {
    const path = SECTION_PATHS[section];
    if (rest === path) return { section };
    if (SECTIONS_WITH_ID.has(section) && rest.startsWith(`${path}/`)) {
      const raw = rest.slice(path.length + 1);
      if (raw.includes('/')) continue;
      let id: string;
      try {
        id = decodeURIComponent(raw);
      } catch {
        return null;
      }
      if (!ID_RE.test(id)) return null;
      return { section, id };
    }
  }
  return null;
}

/** Is this stored link a workspace destination? */
export function isMerchantLink(link: string): boolean {
  return parseMerchantPath(link) !== null;
}

/**
 * A stored `/merchant/…` link, as THIS host serves it: unchanged on the
 * platform's host, re-based under `/admin` on a store's own subdomain. Any
 * other link passes through untouched.
 */
export function hostPath(link: string, onStoreHost: boolean): string {
  if (!onStoreHost) return link;
  if (link === MERCHANT_BASE) return STORE_HOST_BASE;
  if (link.startsWith(`${MERCHANT_BASE}/`) || link.startsWith(`${MERCHANT_BASE}?`)) {
    return STORE_HOST_BASE + link.slice(MERCHANT_BASE.length);
  }
  return link;
}
