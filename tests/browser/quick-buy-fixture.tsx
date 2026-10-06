/**
 * QUICK BUY — THE CUSTOMER UI AGAINST A STUBBED SERVER THAT PLAYS THE API AS
 * BUILT (worker/routes/quickBuy.ts, docs/GIFTS_QUICK_BUY.md §3.6). Mounts the
 * REAL product page, «طلباتي» and Settings, with the real bottom navigation
 * and the real toaster, behind a `fetch` that answers `/api/quick-buy/*` the
 * way the server does: `{profile}` from every profile route; `{session, ended,
 * added, replay, server_now}` from every line write; GET /session's open
 * `session` or, when none is open, the last `recent` one (submitted with its
 * order, or failed); idempotency keys (a replay returns the stored answer, a
 * different request under the same key is IDEMPOTENCY_KEY_REUSED, a refused
 * request writes nothing); a 30-minute session on a server clock that is
 * deliberately SKEWED from the device's (`skew`, minutes); the refusals with
 * their `details`; lazy submission of an expired session on GET /session; the
 * policy versions an activation must accept; and the printer standard-delivery
 * warning, accepted once per session.
 *
 * Query parameters:
 *   view      product | orders | settings                     (product)
 *   lang      ar | en | ckb                                    (ar)
 *   theme     dark | light                                     (dark)
 *   profile   inactive | active | reconsent | addressMissing  (inactive)
 *   session   none | open | locked | failed | submitted        (none)
 *   remaining seconds left on an open/locked session           (1722 → 28:42)
 *   balance   ok | low  (low: every add is refused for the wallet)
 *   addresses number of saved addresses                        (2)
 *   flaky     1: the first add is APPLIED and its answer lost  (0)
 *   printer   1: the product is a printer (the warning applies) (0)
 *   skew      server clock minus device clock, minutes         (7)
 *
 * window.quickBuyRequests lists every Quick Buy request (method, path, body);
 * window.quickBuyServer exposes the session and `expireIn(ms)`.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AuthProvider } from '../../src/AuthContext';
import { LanguageProvider } from '../../src/LanguageContext';
import { WalletProvider } from '../../src/WalletContext';
import { CurrencyProvider } from '../../src/CurrencyContext';
import Product from '../../src/pages/Product';
import Orders from '../../src/pages/Orders';
import Settings from '../../src/pages/Settings';
import BottomNav, { isBottomNavHidden } from '../../src/components/BottomNav';
import ToasterGate from '../../src/components/ui/ToasterGate';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const LANG = params.get('lang') === 'en' ? 'en' : params.get('lang') === 'ckb' ? 'ckb' : 'ar';
const THEME = params.get('theme') === 'light' ? 'light' : 'dark';
localStorage.setItem('levo_lang', LANG);
document.documentElement.dataset.theme = THEME;
document.documentElement.lang = LANG;
document.documentElement.dir = LANG === 'en' ? 'ltr' : 'rtl';

const VIEW = params.get('view') ?? 'product';
const SKEW_MS = Number(params.get('skew') ?? 7) * 60_000;
const WINDOW_MS = 30 * 60_000;
const serverNow = () => Date.now() + SKEW_MS;
const iso = (ms: number) => new Date(ms).toISOString();

function picture(hue: number, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 480 480"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 30% 82%)"/><stop offset="1" stop-color="hsl(${hue} 25% 62%)"/></linearGradient></defs><rect width="480" height="480" fill="url(#g)"/><rect x="120" y="150" width="240" height="200" rx="22" fill="hsl(${hue} 18% 24%)"/><rect x="150" y="185" width="180" height="120" rx="10" fill="hsl(${hue} 30% 88%)"/><text x="240" y="420" font-family="sans-serif" font-size="30" text-anchor="middle" fill="hsl(${hue} 20% 20%)">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// --------------------------------------------------------------- catalogue

const PRODUCT_IMG = picture(28, 'A1 mini');
const FILAMENT_IMG = picture(200, 'PLA');
const COLORS = [
  { id: 'c-black', name_en: 'Black', name_ar: 'Black', hex: '#1f2937' },
  { id: 'c-white', name_en: 'White', name_ar: 'White', hex: '#e5e7eb' },
];
const PRICE = 455000;
const PRODUCT = {
  id: 'prod_a1mini',
  slug: 'bambu-a1-mini',
  name: 'Bambu Lab A1 mini',
  name_en: 'Bambu Lab A1 mini',
  name_ar: 'Bambu Lab A1 mini',
  name_ckb: 'Bambu Lab A1 mini',
  description_ar: 'طابعة ثلاثية الأبعاد مدمجة بسرعة عالية ومعايرة تلقائية كاملة.',
  description_en: 'A compact, fast 3D printer with full automatic calibration.',
  description_ckb: 'پرینتەرێکی سێ ڕەهەندی بچووک و خێرا بە ڕێکخستنی خۆکارانەی تەواو.',
  price_iqd: PRICE,
  display_price_iqd: PRICE,
  display_from: false,
  selling_type: 'direct',
  is_printer: params.get('printer') === '1',
  media: [{ url: PRODUCT_IMG, primary: true, order: 0 }],
  options: [],
  colors: COLORS,
  warranty_plans: [],
  warranty_base_months: 12,
  spec_groups: [],
  stock: 8,
};
const pricing = {
  regular_iqd: PRICE, pro_iqd: null, prime_iqd: null, applied_iqd: PRICE, applied_tier: 'regular', price_source: 'ladder',
  transport: null, direct: null, pricing_basis: 'direct', warranty: null, unit_subtotal_iqd: PRICE, errors: [] as string[],
};
const availability = (colorId: string | null) => ({
  mode: 'direct_sale', reason: null, selling_type: 'direct',
  stock: { tracked: true, scope: 'product', on_hand: 8, reserved: 0, available: 8, max_qty: 8 },
  selection: {
    option_required: false, color_required: true, option_id: null, color_id: colorId, option_value_ids: [],
    complete: !!colorId, errors: colorId ? [] : ['COLOR_REQUIRED'],
  },
  modes: [
    { type: 'direct_sale', usable: true, reason: null },
    { type: 'pre_order', usable: false, reason: 'PREORDER_NOT_ENABLED' },
  ],
  preorder: { enabled: false, usable: false, reason: 'PREORDER_NOT_ENABLED', transports: [] },
  qty_ok: true,
});

// ---------------------------------------------------------------- account

const USER = {
  id: 'usr_fixture', email: 'zahra@example.test', username: 'zahra', name: 'زهراء علي', role: 'customer', isAdmin: false,
  is_investor: false, subscription_plan: 'free', membership_tier: 'free', admin_scope: null, subscription_expiry: 0,
  locale: LANG === 'ckb' ? 'ku' : LANG, avatar_key: null, bio: '', website: '', profile: {}, country: 'IQ',
  creator_public: false, phone: '+9647******567', has_phone: true, notify_whatsapp: true, has_google: false,
  onboarding_state: 'done', email_verified: true,
};

const ADDRESS_BOOK = [
  { id: 'adr_home', label: 'البيت', name: 'زهراء علي', phone: '+9647701234567', address: 'شارع 62، دار 14', landmark: 'قرب جامع الرحمن', governorate: 'baghdad', area: 'الكرادة', notes: '', is_default: 1, created_at: '2026-09-01T10:00:00Z' },
  { id: 'adr_work', label: 'العمل', name: 'زهراء علي', phone: '+9647709876543', address: 'شارع الصناعة، مبنى 3', landmark: '', governorate: 'basra', area: 'العشار', notes: '', is_default: 0, created_at: '2026-09-15T10:00:00Z' },
];
let addresses = ADDRESS_BOOK.slice(0, Math.max(0, Math.min(ADDRESS_BOOK.length, Number(params.get('addresses') ?? 2))));

const REQUIRED = { terms: 4, privacy: 3, quick_buy: 2 };
const profileMode = params.get('profile') ?? 'inactive';
type AddressRow = (typeof ADDRESS_BOOK)[number];
const addressView = (a: AddressRow) => ({ id: a.id, label: a.label, name: a.name, phone: a.phone, governorate: a.governorate, area: a.area, address: a.address, landmark: a.landmark });

/** The stored profile row, as worker/lib/quickBuy/profile.ts keeps it. */
let stored: {
  enabled: boolean;
  address_id: string | null;
  terms_version: number | null;
  privacy_version: number | null;
  policy_version: number | null;
  consented_at: string | null;
} | null =
  profileMode === 'inactive'
    ? null
    : {
        enabled: true,
        address_id: profileMode === 'addressMissing' ? 'adr_deleted' : ADDRESS_BOOK[0].id,
        terms_version: profileMode === 'reconsent' ? 3 : 4,
        privacy_version: 3,
        policy_version: profileMode === 'reconsent' ? 1 : 2,
        consented_at: '2026-09-20T08:30:00Z',
      };

const needsConsent = () =>
  !stored?.consented_at ||
  stored.terms_version !== REQUIRED.terms ||
  stored.privacy_version !== REQUIRED.privacy ||
  stored.policy_version !== REQUIRED.quick_buy;

/** `profileView` as built: `consent` is null until the first activation. */
function profileView() {
  const addr = stored?.address_id ? addresses.find((a) => a.id === stored!.address_id) ?? null : null;
  const needs = needsConsent();
  return {
    enabled: !!stored?.enabled,
    active: !!stored?.enabled && !needs && !!addr,
    needs_consent: needs,
    address: addr ? addressView(addr) : null,
    address_missing: !!stored?.address_id && !addr,
    consent: stored?.consented_at
      ? {
          terms_version: stored.terms_version,
          privacy_version: stored.privacy_version,
          policy_version: stored.policy_version,
          consented_at: stored.consented_at,
          wallet_consent_at: stored.consented_at,
        }
      : null,
    required: REQUIRED,
  };
}

// ---------------------------------------------------------------- session

interface Item {
  id: string; product_id: string; slug: string; name: string; name_ar: string; name_ku: string; image: string;
  variant: string; sku: string; qty: number; unit_price_iqd: number; max_qty: number;
}
interface Meta {
  id: string; state: 'open' | 'submitted' | 'cancelled' | 'failed'; started_at: number; expires_at: number;
  printer_ack: boolean; order_id: string | null; submitted_at: string | null;
}

let items: Item[] = [];
let meta: Meta | null = null;
let rev = 0;
/** The last session that ended (submitted or failed), with its lines, as GET /session reports it. */
let ended: { meta: Meta; items: Item[] } | null = null;
let seq = 0;
const sessionMode = params.get('session') ?? 'none';
const remainingS = Number(params.get('remaining') ?? 1722);

function startSession(endsIn: number, state: Meta['state'] = 'open'): void {
  const end = serverNow() + endsIn;
  meta = { id: `qbs_${++seq}`, state, started_at: end - WINDOW_MS, expires_at: end, printer_ack: false, order_id: null, submitted_at: null };
  rev = 1;
}

const LINE_A1: Item = {
  id: 'qbi_1', product_id: PRODUCT.id, slug: PRODUCT.slug, name: PRODUCT.name_en, name_ar: 'بامبو لاب A1 ميني', name_ku: 'بامبو لاب A1 مینی',
  image: PRODUCT_IMG, variant: 'Black', sku: 'A1M-BLK', qty: 1, unit_price_iqd: PRICE, max_qty: 8,
};
const LINE_PLA: Item = {
  id: 'qbi_2', product_id: 'prod_pla', slug: 'bambu-pla-basic', name: 'Bambu PLA Basic 1 kg', name_ar: 'خيط بامبو PLA بيسك 1 كغم', name_ku: '',
  image: FILAMENT_IMG, variant: '1.75 mm · Jade White', sku: 'PLA-JW', qty: 2, unit_price_iqd: 18000, max_qty: 6,
};

if (sessionMode === 'open' || sessionMode === 'locked') {
  startSession(sessionMode === 'open' ? remainingS * 1000 : -5000);
  items = [{ ...LINE_A1 }, { ...LINE_PLA }];
}
if (sessionMode === 'failed' || sessionMode === 'submitted') {
  startSession(-60_000, sessionMode);
  ended = {
    meta: { ...meta!, order_id: sessionMode === 'submitted' ? 'LV-260107' : null, submitted_at: sessionMode === 'submitted' ? iso(serverNow() - 60_000) : null },
    items: [{ ...LINE_A1 }, { ...LINE_PLA }],
  };
  meta = null;
}

const SHIPPING_FEE = 5000;
const FREE_FROM = 400000;
const WALLET_FREE_DELIVERY_LABEL = {
  ar: 'توصيل عادي مجاني — للدفع الكامل من محفظة Levo',
  en: 'Free standard delivery — paid in full from Levo Wallet',
  ckb: 'گەیاندنی ئاسایی بەخۆڕایی — بۆ پارەدانی تەواو لە جزدانی Levo',
};
const PRINTER_POLICY = {
  key: 'printer_standard_transport',
  version: 1,
  text_ar: 'قد يتعرض الطلب لأضرار أثناء التوصيل العادي، ولا نتحمل مسؤولية أضرار النقل. عند حدوث ضرر أثناء التوصيل لا يشمل الطلب الاسترجاع المجاني.',
};

/** `sessionView` as built (worker/lib/quickBuy/session.ts). The client sends no `?lang`, so `label` is Arabic. */
function viewOf(m: Meta, lines: Item[]) {
  const open = m.state === 'open';
  const remaining = Math.max(0, m.expires_at - serverNow());
  const itemsIqd = lines.reduce((n, it) => n + it.qty * it.unit_price_iqd, 0);
  const free = itemsIqd >= FREE_FROM;
  const shipping = free ? 0 : SHIPPING_FEE;
  const total = itemsIqd + shipping;
  const a = addresses.find((x) => x.id === stored?.address_id) ?? ADDRESS_BOOK[0];
  return {
    id: m.id,
    state: m.state,
    started_at: iso(m.started_at),
    expires_at: iso(m.expires_at),
    server_now: iso(serverNow()),
    remaining_ms: open ? remaining : 0,
    editable: open && remaining > 0,
    items: lines.map((it) => ({
      ...it,
      option_label: it.variant,
      color_label: '',
      max_qty: open ? it.max_qty : it.qty,
      line_total_iqd: it.qty * it.unit_price_iqd,
    })),
    items_iqd: itemsIqd,
    discount_iqd: 0,
    shipping_iqd: shipping,
    shipping_before_iqd: SHIPPING_FEE,
    free_delivery: { applied: free, label: free ? WALLET_FREE_DELIVERY_LABEL.ar : null, labels: WALLET_FREE_DELIVERY_LABEL },
    total_iqd: total,
    held_iqd: open ? total : 0,
    address: { name: a.name, phone: a.phone, governorate: a.governorate, area: a.area, address: a.address, landmark: a.landmark },
    delivery_method: 'standard',
    order_id: m.state === 'submitted' ? m.order_id : null,
    submitted_at: m.submitted_at,
    finalize_error: m.state === 'failed' ? 'QUICK_BUY_TOTAL_ABOVE_HOLD' : null,
    rev,
  };
}

const openView = () => (meta && meta.state === 'open' ? viewOf(meta, items) : null);

function recentView() {
  if (!ended) return null;
  const order = ended.meta.state === 'submitted' ? { id: ended.meta.order_id!, status: 'pending', total_iqd: viewOf(ended.meta, ended.items).total_iqd } : null;
  return { ...viewOf(ended.meta, ended.items), order };
}

/** The order a submitted session became, as `orderPublic` lists it: an ordinary order labelled `quick_buy`. */
function submittedOrder() {
  const v = viewOf(ended!.meta, ended!.items);
  const at = ended!.meta.submitted_at ?? iso(serverNow());
  return {
    id: ended!.meta.order_id,
    order_kind: 'quick_buy',
    status: 'pending',
    address: v.address,
    delivery_method: { id: 'standard', titleAr: 'توصيل عادي', titleEn: 'Standard delivery', price_iqd: v.shipping_iqd },
    payment_method_id: 'wallet',
    subtotal_iqd: v.items_iqd,
    shipping_iqd: v.shipping_iqd,
    cod_tax_iqd: 0,
    points_discount_iqd: 0,
    wallet_applied_iqd: v.total_iqd,
    total_iqd: v.total_iqd,
    due_on_delivery_iqd: 0,
    created_at: at,
    updated_at: at,
    shipping_type: 'direct',
    items: ended!.items.map((it) => ({
      id: `oi_${it.id}`,
      product_id: it.product_id,
      product_slug: it.slug,
      name: it.name,
      name_ar: it.name_ar,
      image: it.image,
      variant: it.variant,
      qty: it.qty,
      unit_price_iqd: it.unit_price_iqd,
      line_total_iqd: it.qty * it.unit_price_iqd,
    })),
  };
}

/** D13: any Quick Buy request that finds an expired open session submits it. */
function finaliseIfDue(): void {
  if (!meta || meta.state !== 'open' || serverNow() < meta.expires_at) return;
  if (sessionMode === 'locked') return; // the lease is held elsewhere: still being submitted
  ended = { meta: { ...meta, state: 'submitted', order_id: 'LV-260107', submitted_at: iso(serverNow()) }, items };
  meta = null;
  items = [];
}

// ------------------------------------------------------------------- fetch

type Reply = { status: number; data: Record<string, unknown> };
const ok = (data: Record<string, unknown>): Reply => ({ status: 200, data });
const refuse = (status: number, code: string, error: string, details?: Record<string, unknown>): Reply => ({ status, data: { code, error, details } });

const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
const keys = new Map<string, { hash: string; reply: Reply }>();
let addsSeen = 0;

/**
 * One key, one request: a replay answers what the first answered (`replay`),
 * a different request is refused, and a REFUSED request writes nothing (its
 * key may be sent again). `hashOf` is what the server hashes — for an add,
 * the selection without the printer acceptance.
 */
function idempotent(body: Record<string, unknown> | undefined, hashOf: string, run: () => Reply): Reply {
  const key = String(body?.idempotencyKey ?? '');
  if (key.length < 8) return refuse(400, 'VALIDATION', 'idempotencyKey is required');
  const prior = keys.get(key);
  if (prior) return prior.hash === hashOf ? { ...prior.reply, data: { ...prior.reply.data, replay: true } } : refuse(409, 'IDEMPOTENCY_KEY_REUSED', 'This Quick Buy key was already used for a different request.');
  const reply = run();
  if (reply.status < 400) keys.set(key, { hash: hashOf, reply });
  return reply;
}

/** What every line write answers. */
const changed = (endedView: unknown = null, added: unknown = null): Reply =>
  ok({ session: openView(), ended: endedView, added, replay: false, server_now: iso(serverNow()) });

function quickBuy(method: string, path: string, body: Record<string, unknown> | undefined): Reply {
  if (path === '/api/quick-buy/session' && method === 'GET') {
    finaliseIfDue();
    const session = meta && meta.state === 'open' ? openView() : null;
    return ok({ session, recent: session ? null : recentView(), server_now: iso(serverNow()) });
  }
  if (path === '/api/quick-buy/profile' && method === 'GET') return ok({ profile: profileView() });
  if (path === '/api/quick-buy/profile' && method === 'PUT') {
    if (String(body?.idempotencyKey ?? '').length < 8) return refuse(400, 'VALIDATION', 'idempotencyKey is required');
    if (!stored) return refuse(409, 'QUICK_BUY_NOT_ACTIVE', 'فعّل الشراء السريع أولاً / Switch Quick Buy on first');
    if (body?.addressId !== undefined && !addresses.some((x) => x.id === body.addressId)) {
      return refuse(400, 'QUICK_BUY_ADDRESS_INVALID', 'اختر عنواناً صحيحاً للشراء السريع / Choose a valid Quick Buy address');
    }
    if (body?.enabled === true && needsConsent()) return refuse(409, 'QUICK_BUY_RECONSENT_REQUIRED', 'Accept the updated policies');
    if (typeof body?.addressId === 'string') stored = { ...stored, address_id: body.addressId };
    if (typeof body?.enabled === 'boolean') stored = { ...stored, enabled: body.enabled };
    return ok({ profile: profileView() });
  }
  if (path === '/api/quick-buy/activate' && method === 'POST') {
    return idempotent(body, `activate|${JSON.stringify({ ...body, idempotencyKey: undefined })}`, () => {
      if (body?.walletConsent !== true) return refuse(400, 'QUICK_BUY_WALLET_CONSENT_REQUIRED', 'Allow the Levo wallet hold and charge');
      if (!addresses.some((x) => x.id === body?.addressId)) return refuse(400, 'QUICK_BUY_ADDRESS_INVALID', 'Choose a valid Quick Buy address');
      const accepted = (body?.policyAcceptance as Array<{ key: string; version: number }>) ?? [];
      const v = (k: string) => accepted.find((p) => p.key === k)?.version;
      if (v('terms') !== REQUIRED.terms || v('privacy') !== REQUIRED.privacy || v('quick_buy') !== REQUIRED.quick_buy) {
        return refuse(400, 'POLICY_ACCEPTANCE_REQUIRED', 'Policies changed; reload and review them again');
      }
      const now = iso(serverNow());
      stored = { enabled: true, address_id: String(body?.addressId), terms_version: REQUIRED.terms, privacy_version: REQUIRED.privacy, policy_version: REQUIRED.quick_buy, consented_at: now };
      return ok({ profile: profileView() });
    });
  }
  if (path === '/api/quick-buy/items' && method === 'POST') {
    const qty = Number(body?.qty) || 1;
    const add = [body?.productId, qty, body?.optionId ?? '', [...((body?.optionValueIds as string[]) ?? [])].sort(), body?.colorId ?? '', body?.warrantyPlanId ?? ''];
    return idempotent(body, `add|${JSON.stringify(add)}`, () => {
      finaliseIfDue();
      if (meta && meta.state === 'open' && serverNow() >= meta.expires_at) {
        return refuse(409, 'QUICK_BUY_PREVIOUS_PENDING', 'Your previous Quick Buy order is being submitted — one moment');
      }
      if (!stored?.enabled) return refuse(409, 'QUICK_BUY_NOT_ACTIVE', 'فعّل الشراء السريع أولاً / Switch Quick Buy on first');
      if (needsConsent()) return refuse(409, 'QUICK_BUY_RECONSENT_REQUIRED', 'Accept the updated policies to keep using Quick Buy');
      const opening = !meta || meta.state !== 'open';
      if (opening && !addresses.some((x) => x.id === stored?.address_id)) {
        return refuse(409, 'QUICK_BUY_ADDRESS_INVALID', 'اختر عنواناً للشراء السريع من الإعدادات / Choose a Quick Buy address in settings');
      }
      if (qty > 8) return refuse(400, 'OUT_OF_STOCK', 'Not enough stock', { available: 8 });
      if (params.get('balance') === 'low') {
        return refuse(409, 'QUICK_BUY_INSUFFICIENT_BALANCE', 'رصيد محفظة Levo غير كافٍ لإتمام الشراء السريع. / Your Levo Wallet balance is not enough for this Quick Buy.', {
          available_iqd: 125000,
          required_iqd: qty * PRICE + SHIPPING_FEE,
        });
      }
      const ack = body?.printerStandardDeliveryAcceptance as { accepted?: unknown; version?: unknown } | undefined;
      const acked = !!ack && ack.accepted === true && ack.version === PRINTER_POLICY.version;
      if (PRODUCT.is_printer && !(meta?.state === 'open' && meta.printer_ack) && !acked) {
        return refuse(409, 'PRINTER_STANDARD_DELIVERY_ACCEPTANCE_REQUIRED', 'Acknowledge the printer standard-delivery warning first.', { policy: PRINTER_POLICY });
      }
      if (opening) {
        items = [];
        startSession(WINDOW_MS);
      } else {
        rev += 1;
      }
      if (PRODUCT.is_printer) meta!.printer_ack = true;
      const variant = COLORS.find((c) => c.id === body?.colorId)?.name_en ?? '';
      const same = items.find((it) => it.product_id === body?.productId && it.variant === variant);
      if (same) same.qty += qty;
      else items.push({ ...LINE_A1, id: `qbi_${++seq}`, product_id: String(body?.productId), variant, sku: 'A1M', qty });
      const item = same ?? items[items.length - 1];
      return changed(null, { item_id: item.id, qty: item.qty });
    });
  }
  const itemPath = /^\/api\/quick-buy\/items\/([^/]+)$/.exec(path);
  if (itemPath && (method === 'PATCH' || method === 'DELETE')) {
    const itemId = decodeURIComponent(itemPath[1]);
    const qty = method === 'DELETE' ? 0 : Number(body?.qty);
    return idempotent(body, `${qty === 0 ? 'remove' : 'update'}|${itemId}|${qty}`, () => {
      if (meta && meta.state === 'open' && serverNow() >= meta.expires_at) {
        finaliseIfDue();
        return refuse(409, 'QUICK_BUY_EXPIRED', 'انتهى وقت التعديل على طلب الشراء السريع / The Quick Buy order can no longer be changed');
      }
      if (!meta || meta.state !== 'open') return refuse(409, 'QUICK_BUY_NO_SESSION', 'لا يوجد طلب شراء سريع مفتوح / There is no open Quick Buy order');
      const it = items.find((x) => x.id === itemId);
      if (!it) return refuse(404, 'QUICK_BUY_ITEM_NOT_FOUND', 'هذا المنتج ليس في طلب الشراء السريع / Not in your Quick Buy order');
      if (qty > it.max_qty) return refuse(400, 'OUT_OF_STOCK', 'Not enough stock', { available: it.max_qty });
      if (qty <= 0) items = items.filter((x) => x !== it);
      else it.qty = qty;
      rev += 1;
      if (items.length === 0) {
        // Removing the last line is cancelling the order.
        const cancelled = viewOf({ ...meta, state: 'cancelled' }, []);
        meta = null;
        return changed(cancelled);
      }
      return changed();
    });
  }
  if (path === '/api/quick-buy/session/cancel' && method === 'POST') {
    return idempotent(body, 'cancel', () => {
      meta = null;
      items = [];
      return ok({ session: null, server_now: iso(serverNow()) });
    });
  }
  return refuse(404, 'NOT_FOUND', `Fixture missing ${method} ${path}`);
}

function other(method: string, path: string, body: Record<string, unknown> | undefined, url: URL): Reply {
  if (path === '/api/auth/me') return ok({ user: USER });
  if (path === '/api/settings/public') return ok({ settings: { exchangeRate: 1400 } });
  if (path === '/api/wallet') return ok({ balance_usd_cents: 0, balance_iqd: 640000, point_balance: 0, transactions: [], point_transactions: [] });
  if (path === `/api/products/${PRODUCT.slug}`) {
    return ok({
      product: PRODUCT, pricing, initial_selection: { option_id: null, option_value_ids: [], color_id: 'c-black', fulfillment_type: 'direct_sale' },
      source: 'catalog', favorite: false, relations: null, availability: availability('c-black'),
      pricing_modes: { direct: { unit_subtotal_iqd: PRICE, direct: null }, preorder: [], cod_reprices: false },
      viewer_tier: { tier: 'free', active: false }, sales_badge: null, rating: { average: 4.8, count: 37 }, fits_printers: [], maintenance_parts: null,
    });
  }
  if (path === `/api/products/${PRODUCT.slug}/quote`) {
    const qty = Number(body?.qty) || 1;
    return ok({ quote: { ...pricing, qty, line_total_iqd: PRICE * qty }, availability: availability((body?.colorId as string) ?? null) });
  }
  if (path === '/api/cart') return ok({ items: [], item_count: 0 });
  if (path.startsWith('/api/reviews/product/')) return ok({ total: 0, avg_stars: null, reviews: [] });
  if (path.startsWith('/api/reviews/eligibility/')) return ok({ eligible_orders: [], existing_review: null, is_printer: false, review_points: null, can_replace_system_review: false });
  if (path === '/api/addresses' && method === 'GET') return ok({ addresses, approved_snapshot: null });
  if (path === '/api/addresses' && method === 'POST') {
    const id = `adr_${++seq}`;
    addresses = [...addresses, { id, label: String(body?.label ?? ''), name: String(body?.name ?? ''), phone: String(body?.phone ?? ''), address: String(body?.address ?? ''), landmark: String(body?.landmark ?? ''), governorate: String(body?.governorate ?? ''), area: String(body?.area ?? ''), notes: '', is_default: addresses.length === 0 ? 1 : 0, created_at: iso(Date.now()) }];
    return ok({ id });
  }
  // After its 30 minutes a session is an ORDINARY order (owner spec §13): it is in the list like any other.
  if (path === '/api/orders') return ok({ orders: ended?.meta.state === 'submitted' ? [submittedOrder()] : [], next_before: null });
  if (path === '/api/orders/counts') return ok({ counts: {} });
  if (path === '/api/community/access') return ok({ may_enter: true, state: 'open' });
  if (path === '/api/auth/verify-email/status') return ok({ email: USER.email, verified: true, emailConfigured: true });
  if (path === '/api/auth/sessions') return ok({ sessions: [] });
  if (path === '/api/telegram/link/status') return ok({ linked: false, configured: false });
  if (path === '/api/auth/capabilities') return ok({ google: false, telegram: false, whatsappOtp: false, email: true });
  void url;
  return ok({ items: [], chats: [], reviews: [], eligible: [], gifts: [], orders: [], sessions: [] });
}

const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, location.origin);
  const path = url.pathname;
  if (!path.startsWith('/api/')) return realFetch(input, init);
  const method = (init?.method || 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
  // A little latency, so loading states are real states.
  await new Promise((r) => setTimeout(r, path.startsWith('/api/quick-buy') ? 260 : 60));
  let reply: Reply;
  if (path.startsWith('/api/quick-buy')) {
    requests.push({ method, path, body });
    reply = quickBuy(method, path, body);
    // FLAKY: the first add is applied on the server and its answer is lost on the way back.
    if (path === '/api/quick-buy/items' && method === 'POST' && params.get('flaky') === '1' && ++addsSeen === 1 && reply.status < 400) {
      throw new TypeError('Failed to fetch');
    }
  } else {
    reply = other(method, path, body, url);
  }
  const payload = reply.status < 400 ? { success: true, ...reply.data } : { success: false, ...reply.data };
  return new Response(JSON.stringify(payload), { status: reply.status, headers: { 'content-type': 'application/json' } });
}) as typeof window.fetch;

Object.assign(window, {
  quickBuyRequests: requests,
  quickBuyServer: {
    get session() {
      return openView();
    },
    get recent() {
      return recentView();
    },
    get profile() {
      return profileView();
    },
    expireIn(ms: number) {
      if (meta) meta.expires_at = serverNow() + ms;
    },
  },
});

// ------------------------------------------------------------------- shell

function NavigateHook() {
  const navigate = useNavigate();
  React.useEffect(() => {
    Object.assign(window, { fixtureNavigate: navigate });
  }, [navigate]);
  return null;
}

function Shell() {
  const location = useLocation();
  const navHidden = isBottomNavHidden(location.pathname);
  return (
    <>
      <NavigateHook />
      <div id="main-scroll-container" className="bg-canvas text-text-primary" style={{ height: '100dvh', overflowY: 'auto', paddingBottom: navHidden ? 0 : 104 }}>
        <Routes>
          <Route path="/product/:slug" element={<Product />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/orders/:id" element={<p data-fixture-order style={{ padding: 24 }}>order page</p>} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/wallet" element={<p data-fixture-wallet style={{ padding: 24 }}>wallet page</p>} />
          <Route path="*" element={<p data-fixture-elsewhere style={{ padding: 24 }}>{location.pathname}</p>} />
        </Routes>
      </div>
      <BottomNav />
      <ToasterGate aboveNav={!navHidden} />
    </>
  );
}

const START = VIEW === 'orders' ? '/orders' : VIEW === 'settings' ? '/settings' : `/product/${PRODUCT.slug}`;

class Catch extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(e: unknown) {
    return { error: String(e) };
  }
  render() {
    return this.state.error ? <p data-fixture-error>{this.state.error}</p> : this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Catch>
      <MemoryRouter initialEntries={[START]}>
        <AuthProvider>
          <LanguageProvider>
            <WalletProvider>
              <CurrencyProvider>
                <Shell />
              </CurrencyProvider>
            </WalletProvider>
          </LanguageProvider>
        </AuthProvider>
      </MemoryRouter>
    </Catch>
  </React.StrictMode>
);
