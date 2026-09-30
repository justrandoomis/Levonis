/**
 * THE REQUEST PAGE IN A BROWSER — /requests/:id (src/pages/community/
 * Request.tsx, Client 5c) with the API answered locally, so the page can be
 * seen and photographed without a worker:
 *
 *   ?viewer=customer            the owner comparing three offers (a revised
 *                               one with its history, one with a fee and
 *                               files, one the merchant must re-confirm), a
 *                               discussion with a question to answer
 *          merchant             a workshop that may offer: «قدّم عرضًا», the
 *                               composer with «احفظ مسودة» / «أرسل العرض»
 *          merchant-draft       the same workshop with a saved draft
 *          guest                a signed-out visitor: the onlooker card
 *          customer-accepted    the offer taken: accepted card, «آخر تحديث»,
 *                               the money held, the store's contact
 *          merchant-accepted    the workshop's side of the same order
 *          customer-completed   finished work, waiting for its rating
 *          owner-draft          a draft request, not yet published
 *   &route=legacy               start at /requests?request=req_1#discussion
 *                               (the old address) — it must land on
 *                               /requests/req_1#discussion
 *   &lang=ar|en|ckb  &theme=dark|light
 *
 * scripts/e2e-request.mjs drives it (Playwright). What the page SENT is kept
 * on `window.__lab` (offer bodies, accept bodies, comment kinds) so the
 * script can check the contract, not just the pixels.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from '../../src/AuthContext';
import { LanguageProvider } from '../../src/LanguageContext';
import { WalletProvider } from '../../src/WalletContext';
import { CurrencyProvider } from '../../src/CurrencyContext';
import { Toaster } from '../../src/components/ui/Toast';
import RequestPage from '../../src/pages/community/Request';
import Requests from '../../src/pages/Requests';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : params.get('lang') === 'ckb' ? 'ckb' : 'ar';
const viewer = params.get('viewer') ?? 'customer';
const route = params.get('route') ?? '';
localStorage.setItem('levo_lang', lang);
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
document.documentElement.setAttribute('data-theme', params.get('theme') === 'light' ? 'light' : 'dark');

const en = lang === 'en';
const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/** A photograph stand-in for an offer's picture. */
function picture(tone: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#e9e3d6"/><rect x="30" y="40" width="60" height="44" rx="8" fill="${tone}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const accepted = viewer === 'customer-accepted' || viewer === 'merchant-accepted' || viewer === 'customer-completed';
const customerSide = viewer.startsWith('customer') || viewer === 'owner-draft';
const merchantSide = viewer.startsWith('merchant');
const requestState = viewer === 'owner-draft' ? 'draft' : viewer === 'customer-completed' ? 'completed' : accepted ? 'in_progress' : 'receiving_offers';

const USERS: Record<string, Record<string, unknown>> = {
  sara: { id: 'u_sara', username: 'sara', name: en ? 'Sara Karim' : 'سارة كريم' },
  ali: { id: 'u_ali', username: 'ali3d', name: 'Ali 3D' },
};
const me = viewer === 'guest' ? null : { ...(customerSide ? USERS.sara : USERS.ali), role: 'customer', email: 'x@x.co', locale: lang === 'ckb' ? 'ku' : lang, avatar_key: null, bio: '', website: '', profile: {}, country: 'IQ', phone: null, has_phone: false, notify_whatsapp: true, subscription_plan: 'plus', membership_tier: 'plus', subscription_expiry: 0, is_investor: false, isAdmin: false, creator_public: false };

const request = {
  id: 'req_1',
  title: en ? 'Car phone holder, matte black' : 'حامل هاتف للسيارة، أسود مطفي',
  description: en ? 'A holder that clips onto the air vent, for a 6.7" phone with a slim case.' : 'حامل يثبت على فتحة المكيف، لهاتف 6.7 إنش مع غطاء رفيع.',
  category: 'print',
  quantity: 2,
  material: 'PETG',
  color: en ? 'Black' : 'أسود',
  dimensions: '82×64×41 mm',
  budget_iqd: 25000,
  deadline: day(9).slice(0, 10),
  governorate: 'baghdad',
  delivery_pref: 'delivery',
  state: requestState,
  offer_count: 3,
  created_at: day(-2),
  expires_at: day(12),
  customer_name: en ? 'Sara Karim' : 'سارة كريم',
  file_count: 2,
  revision: 2,
  customer_notes: en ? 'Matte black if possible; the charger enters from below.' : 'أسود مطفي إن أمكن؛ الشاحن يدخل من الأسفل.',
};

const M = (id: string, name: string, rating: number | null, n: number, done: number, verified = false) => ({ id, name, verified, badge: '', rating, rating_count: n, completed_orders: done, store_slug: id });
const offerFile = (id: string, kind: 'image' | 'pdf' | 'model', name: string, offerId: string) => ({
  id,
  kind,
  name,
  bytes: kind === 'image' ? 182_004 : kind === 'pdf' ? 96_120 : 1_220_880,
  content_type: kind === 'image' ? 'image/png' : kind === 'pdf' ? 'application/pdf' : 'model/stl',
  url: kind === 'image' ? picture('#6c7a4a') : `/api/marketplace/offers/${offerId}/files/${id}`,
  ...(merchantSide ? { key: `merchants/u_ali/offers/${id}.${kind === 'image' ? 'png' : kind === 'pdf' ? 'pdf' : 'stl'}` } : {}),
});
const base = { request_id: 'req_1', store_id: 's1', materials: '', created_at: day(-1), updated_at: day(-1), request_revision: 2, stale: false, expired: false, draft: false, color: '', terms: '', quantity: null as number | null, files: [] as unknown[], history: [] as unknown[] };
const offers = [
  {
    ...base,
    id: 'off_1', merchant_id: 'm1', price_iqd: 18000, delivery_fee_iqd: 2000, total_iqd: 20000, completion_days: 3, delivery_method: 'merchant_delivery',
    message: en ? 'I can start tomorrow, black PETG in stock.' : 'أبدأ غدًا، عندي PETG أسود.', material_ids: ['petg'], included: en ? 'Light sanding' : 'صنفرة خفيفة',
    warranty_terms: en ? 'Reprint if it cracks in 30 days' : 'إعادة طباعة إن انكسر خلال 30 يومًا', terms: en ? 'Colour as in the photo.' : 'اللون كما في الصورة.', quantity: 2, color: en ? 'Matte black' : 'أسود مطفي',
    state: accepted ? 'accepted' : 'pending', expires_at: day(6), valid_until: day(6), revision: 2, revised: true,
    history: [
      { revision: 1, request_revision: 1, price_iqd: 21000, completion_days: 3, delivery_method: 'merchant_delivery', reason: 'create', created_at: day(-2) },
      { revision: 2, request_revision: 2, price_iqd: 18000, completion_days: 3, delivery_method: 'merchant_delivery', reason: 'edit', created_at: day(-1) },
    ],
    files: [offerFile('ofl_1', 'image', 'sample-print.png', 'off_1'), offerFile('ofl_2', 'pdf', 'fit-check.pdf', 'off_1')],
    order_id: accepted ? 'cord_1' : null,
    merchant: M('m1', 'Ali 3D', 4.8, 23, 41, true),
  },
  {
    ...base,
    id: 'off_2', merchant_id: 'm2', price_iqd: 24500, delivery_fee_iqd: 0, total_iqd: 24500, completion_days: 2, delivery_method: 'courier', message: '', material_ids: ['abs', 'petg'],
    included: en ? 'Two colour options' : 'خياران للون', warranty_terms: '', state: accepted ? 'rejected' : 'pending', expires_at: day(12), valid_until: day(12), revision: 1, revised: false,
    merchant: M('m2', 'Omar Print Lab', 4.5, 9, 12),
  },
  {
    ...base,
    id: 'off_3', merchant_id: 'm3', price_iqd: 15000, delivery_fee_iqd: 0, total_iqd: 15000, completion_days: 6, delivery_method: 'pickup', message: '', material_ids: ['pla'],
    included: '', warranty_terms: '', state: accepted ? 'rejected' : 'superseded', expires_at: null, valid_until: null, revision: 1, revised: false, stale: !accepted, request_revision: 1,
    merchant: M('m3', 'Basra Makers', null, 0, 0),
  },
];

// What the merchant sees of its own: nothing yet, a draft, or the accepted offer.
const draft = viewer === 'merchant-draft'
  ? {
      ...base, id: 'ofd_1', merchant_id: 'm1', price_iqd: 19000, delivery_fee_iqd: 1500, total_iqd: 20500, completion_days: 4, delivery_method: 'merchant_delivery', message: '', material_ids: ['petg'],
      included: '', warranty_terms: '', state: 'draft', draft: true, expires_at: null, valid_until: null, valid_days: 7, revision: 0, revised: false,
      files: [offerFile('ofl_9', 'image', 'draft-sample.png', 'ofd_1')], merchant: null, quote_id: null,
    }
  : null;
const merchantOffers = viewer === 'merchant-accepted' ? [offers[0]] : [];

const materials = [
  { id: 'pla', process: 'fdm', name_en: 'PLA', name_ar: 'PLA', needs_enclosure: false, abrasive: false },
  { id: 'petg', process: 'fdm', name_en: 'PETG', name_ar: 'PETG', needs_enclosure: false, abrasive: false },
  { id: 'abs', process: 'fdm', name_en: 'ABS', name_ar: 'ABS', needs_enclosure: true, abrasive: false },
  { id: 'tpu', process: 'fdm', name_en: 'TPU (flexible)', name_ar: 'TPU مرن', needs_enclosure: false, abrasive: false },
];

const person = (id: string, name: string, role: 'customer' | 'merchant' | 'member') => ({ id, name, username: null, role });
const onBoard = requestState === 'receiving_offers';
const comments: Array<Record<string, unknown>> = [
  { id: 'c1', request_id: 'req_1', parent_id: null, kind: 'public_comment', body: en ? 'Does it fit a phone with a thick case?' : 'هل يناسب هاتفًا بغطاء سميك؟', state: 'visible', created_at: ago(60 * 30), author: person('u_ahmed', en ? 'Ahmed' : 'أحمد', 'member'), system: null, viewer: { mine: false, can_remove: false } },
  { id: 'c2', request_id: 'req_1', parent_id: 'c1', kind: 'public_comment', body: en ? 'A slim case only — the grip is 12 mm.' : 'غطاء رفيع فقط — المشبك 12 مم.', state: 'visible', created_at: ago(60 * 28), author: person('u_sara', request.customer_name, 'customer'), system: null, viewer: { mine: customerSide, can_remove: customerSide } },
  { id: 's1', request_id: 'req_1', parent_id: null, kind: 'system_update', body: '', state: 'visible', created_at: ago(60 * 26), author: null, system: { code: 'revised', meta: { change: 'edit', revision: 2 } }, viewer: { mine: false, can_remove: false } },
  { id: 'q1', request_id: 'req_1', parent_id: null, kind: 'merchant_question', body: en ? 'Should the charger slot face down?' : 'هل تريد فتحة الشاحن للأسفل؟', state: 'visible', created_at: ago(60 * 20), author: person('u_ali', 'Ali 3D', 'merchant'), system: null, viewer: { mine: merchantSide, can_remove: merchantSide } },
  { id: 'a1', request_id: 'req_1', parent_id: 'q1', kind: 'customer_answer', body: en ? 'Yes, from below.' : 'نعم، من الأسفل.', state: 'visible', created_at: ago(60 * 19), author: person('u_sara', request.customer_name, 'customer'), system: null, viewer: { mine: customerSide, can_remove: customerSide } },
  { id: 'q2', request_id: 'req_1', parent_id: null, kind: 'merchant_question', body: en ? 'Like this one? https://www.printables.com/model/1234-vent-holder' : 'مثل هذا؟ https://www.printables.com/model/1234-vent-holder', state: 'visible', created_at: ago(90), author: person('u_omar', 'Omar Print Lab', 'merchant'), system: null, viewer: { mine: false, can_remove: false } },
];

const order = {
  role: customerSide ? 'customer' : 'merchant',
  order: { id: 'cord_1', state: viewer === 'customer-completed' ? 'completed' : 'in_progress', price_iqd: 20000, auto_complete_at: null, delivery_method: 'merchant_delivery' },
  contact: customerSide
    ? { store_name: 'Ali 3D', phone: '+9647700000001', delivery_method: 'merchant_delivery' }
    : { name: request.customer_name, phone: '+9647700000009', governorate: 'baghdad', area: en ? 'Karrada' : 'الكرادة', address: en ? 'Street 12, house 4' : 'شارع 12، دار 4', landmark: en ? 'near the mosque' : 'قرب الجامع', delivery_method: 'merchant_delivery' },
  thread: { request_id: 'req_1', merchant_id: 'm1' },
  escrow: { state: viewer === 'customer-completed' ? 'released' : 'held', gross_iqd: 20000, platform_fee_iqd: 1000, merchant_receivable_iqd: 19000, released_at: null, refunded_at: null },
  can: { cancel: false, dispute: true },
};
const timeline = {
  role: order.role,
  order: { id: 'cord_1', request_id: 'req_1', request_title: request.title, state: order.order.state, price_iqd: 20000, completion_days: 3, delivery_method: 'merchant_delivery', created_at: ago(60 * 12), started_at: ago(60 * 10), ready_at: null, delivered_at: null, confirmed_at: null, completed_at: null, cancelled_at: null, auto_complete_at: null, chat_id: 'chat_1' },
  timeline: [
    { kind: 'created', at: ago(60 * 12), actor: 'customer' },
    { kind: 'funded', at: ago(60 * 12), actor: 'system', amount_iqd: 20000 },
    { kind: 'started', at: ago(60 * 10), actor: 'merchant' },
    { kind: 'photo', at: ago(95), actor: 'merchant', id: 'ou_1', body: en ? 'First layer done.' : 'انتهت الطبقة الأولى.', file: { url: picture('#b08d3c'), inline: true } },
  ],
  can: { update: merchantSide, ready: merchantSide, modification_request: customerSide },
};

const lab = { offerBodies: [] as Record<string, unknown>[], patchBodies: [] as Record<string, unknown>[], sends: 0, acceptBodies: [] as Record<string, unknown>[], commentBodies: [] as Record<string, unknown>[], sessions: 0 };
(window as unknown as { __lab: typeof lab }).__lab = lab;
let acceptTries = 0;
const readJson = async (init?: RequestInit) => {
  try {
    return init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const ok = (body: unknown, status = 200) => new Response(JSON.stringify({ success: true, ...(body as object) }), { status, headers: { 'content-type': 'application/json' } });
const refuse = (status: number, code: string, error: string, details?: Record<string, unknown>) =>
  new Response(JSON.stringify({ success: false, error, code, details }), { status, headers: { 'content-type': 'application/json' } });

const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url, location.origin);
  const p = u.pathname;
  const method = (init?.method ?? 'GET').toUpperCase();
  if (p === '/api/auth/me') return me ? ok({ user: me }) : ok({ user: null });
  if (p === '/api/community/access') return ok({ closed: false, admin: false, may_enter: true });
  if (p === '/api/merchant/me') {
    return ok({
      eligible: true, tier: 'plus', tier_active: true, expires_at: null, gated_benefits: [],
      can: { store: true, products: true, orders: true, offers: merchantSide, analytics: true, subdomain: false },
      store: merchantSide ? { id: 's1', slug: 'ali3d', name: 'Ali 3D' } : null, selling: { canSell: merchantSide, reason: '' }, suggested_slug: null,
    });
  }
  if (p === '/api/marketplace/print/catalog') return ok({ materials, qualities: [], min_job_iqd: 5000 });
  if (p === '/api/marketplace/requests/req_1' && method === 'GET') {
    if (viewer === 'guest' && requestState !== 'receiving_offers') return refuse(404, 'NOT_FOUND', 'Request not found');
    return ok({
      request,
      files: [
        { id: 'crf_1', file_name: 'phone-holder-v3.stl', content_type: 'model/stl', size_bytes: 1_842_112, kind: 'model', inline: false, url: customerSide ? '/api/marketplace/requests/req_1/files/crf_1' : null, access: customerSide ? 'download' : 'preview' },
        { id: 'crf_2', file_name: 'vent-photo.jpg', content_type: 'image/jpeg', size_bytes: 402_311, kind: 'image', inline: true, url: picture('#4a6c7a'), access: 'view' },
      ],
      is_owner: customerSide,
    });
  }
  if (p === '/api/marketplace/print/requests/req_1') {
    return ok({
      is_owner: customerSide,
      print: {
        process: 'fdm', material_id: 'petg', color_hex: '#1a1a1a', color_name: 'Black', quality: 'standard', infill_percent: 20, supports: true, colors_count: 1, post_processing_minutes: 0, quantity: 2,
        primary_file_id: 'crf_1', source_kind: 'upload', source_provider: '', source_url: '', source_meta: {},
        analysis: { format: 'stl', capability: { previewable: true, measurable: true, sliceable: true, convertible: false, reference_only: false }, measured: true, unit: 'mm', unit_source: 'assumed', dimensions_mm: { x: 82.4, y: 64, z: 41.2 }, bbox_min_mm: { x: 0, y: 0, z: 0 }, bbox_max_mm: { x: 82.4, y: 64, z: 41.2 }, volume_mm3: 38000, surface_area_mm2: 12000, triangle_count: 12840, shell_count: 1, watertight: true, complexity: 0.34, warnings: [] },
        estimate: { material_grams: 46, total_time_minutes: 260 }, estimate_low_iqd: 14000, estimate_high_iqd: 29000, estimate_confidence: 'medium', completeness: 0.9, required_capabilities: [],
      },
    });
  }
  if (p === '/api/marketplace/print/requests/req_1/revisions') return ok({ current: 2, revisions: [{ revision: 1, created_at: day(-3), changes: [], reason: 'publish', estimate: {} }, { revision: 2, created_at: day(-1), changes: ['quantity', 'material_id'], reason: 'edit', estimate: {} }] });
  if (p === '/api/marketplace/requests/req_1/offers' && method === 'GET') {
    if (!me) return refuse(401, 'UNAUTHORIZED', 'Sign in');
    return customerSide ? ok({ offers, draft: null, is_customer: true }) : ok({ offers: merchantOffers, draft, is_customer: false });
  }
  if (p === '/api/marketplace/requests/req_1/offers' && method === 'POST') {
    const body = await readJson(init);
    lab.offerBodies.push(body);
    const price = Number(body.price_iqd ?? 0) || null;
    const fee = Number(body.delivery_fee_iqd ?? 0) || 0;
    return ok({ offer: { ...base, id: body.draft ? 'ofd_new' : 'off_new', merchant_id: 'm1', price_iqd: price, delivery_fee_iqd: fee, total_iqd: price === null ? null : price + fee, completion_days: Number(body.completion_days ?? 0), delivery_method: String(body.delivery_method ?? ''), message: '', material_ids: [], included: '', warranty_terms: '', state: body.draft ? 'draft' : 'pending', draft: !!body.draft, expires_at: null, valid_until: null, revision: body.draft ? 0 : 1, revised: false, merchant: null } }, 201);
  }
  let m = /^\/api\/marketplace\/offers\/([^/]+)$/.exec(p);
  if (m && method === 'PATCH') {
    lab.patchBodies.push(await readJson(init));
    return ok({ offer: { ...(draft ?? offers[0]) } });
  }
  m = /^\/api\/marketplace\/offers\/([^/]+)\/send$/.exec(p);
  if (m && method === 'POST') {
    lab.sends += 1;
    return ok({ offer: { ...offers[0], id: 'off_sent', state: 'pending' } }, 201);
  }
  m = /^\/api\/marketplace\/offers\/([^/]+)\/accept$/.exec(p);
  if (m && method === 'POST') {
    const body = await readJson(init);
    lab.acceptBodies.push(body);
    acceptTries += 1;
    // The first press meets a merchant who just re-priced: OFFER_CHANGED with the fresh terms.
    if (acceptTries === 1) return refuse(409, 'OFFER_CHANGED', 'This offer changed since you opened it — review it again', { offer: { ...offers[0], price_iqd: 18500, total_iqd: 20500, revision: 3, merchant: null } });
    return ok({ order: { id: 'cord_1', state: 'funded', price_iqd: Number(body.expected_total_iqd ?? 0), chat_id: 'chat_1' }, escrow_id: 'esc_1' });
  }
  if (p === '/api/addresses') return ok({ addresses: [{ id: 'a1', label: en ? 'Home' : 'البيت', name: 'Sara', phone: '+9647700000009', address: en ? 'Karrada, street 12' : 'الكرادة، شارع 12', landmark: '', governorate: 'baghdad', area: '', notes: '', is_default: 1, created_at: '' }] });
  // ---- the discussion (Phase 5b) ----
  if (p === '/api/marketplace/requests/req_1/comments' && method === 'GET') {
    const can = { comment: !!me && onBoard, ask: !!me && merchantSide && onBoard, answer: customerSide };
    return ok({ comments, next_cursor: null, total: comments.filter((c) => c.kind !== 'system_update').length, can });
  }
  if (p === '/api/marketplace/requests/req_1/comments' && method === 'POST') {
    const body = await readJson(init);
    lab.commentBodies.push(body);
    const row = { id: `c_new_${lab.commentBodies.length}`, request_id: 'req_1', parent_id: (body.parent_id as string | undefined) ?? null, kind: body.kind, body: String(body.body ?? ''), state: 'visible', created_at: new Date().toISOString(), author: person(String(me?.id ?? ''), String(me?.name ?? ''), customerSide ? 'customer' : merchantSide ? 'merchant' : 'member'), system: null, viewer: { mine: true, can_remove: true } };
    return ok({ comment: row }, 201);
  }
  if (/^\/api\/marketplace\/requests\/req_1\/comments\/[^/]+$/.test(p) && method === 'DELETE') return ok({});
  if (/^\/api\/marketplace\/requests\/req_1\/comments\/[^/]+\/report$/.test(p)) return ok({ report_id: 'rpt_1' }, 201);
  if (p === '/api/link-cards') {
    const target = u.searchParams.get('url') ?? '';
    if (!target.includes('printables.com')) return refuse(404, 'NOT_FOUND', 'No card');
    return ok({ card: { id: 'lc_1', url: target, host: 'printables.com', title: en ? 'Air-vent phone holder' : 'حامل هاتف لفتحة المكيف', description: '', image_url: null, kind: 'model_page', status: 'ok', fetched_at: day(-1), reason: null } });
  }
  // ---- the order (Phase 5a/5b) ----
  if (p === '/api/marketplace/orders/cord_1') return ok(order);
  if (p === '/api/marketplace/orders/cord_1/timeline') return ok(timeline);
  if (p === '/api/community-reviews/eligible') return ok({ eligible: viewer === 'customer-completed' ? [{ order_id: null, community_order_id: 'cord_1', merchant_id: 'm1', store_id: 's1', merchant_name: 'Ali 3D', created_at: day(-1) }] : [] });
  // ---- the workshop's verdict and costing (W5-B) ----
  if (p === '/api/merchant/workshop/requests/req_1/eligibility') {
    return ok({ request_id: 'req_1', revision: 2, eligible: true, reason: '', reasons: [], dims: { trade: 'pass', capability: 'pass', stock: 'pass', reach: 'pass', preference: 'pass' }, notify: true, notify_block: '', printer: { id: 'pr_1', name: 'Bambu Lab P1S' }, stock_tracked: true });
  }
  if (p === '/api/merchant/workshop/requests/req_1/costs') return ok({ revision: 2, costs: [] });
  // ---- resumable uploads for the offer's files ----
  if (p === '/api/uploads/sessions' && method === 'POST') {
    lab.sessions += 1;
    return ok({ session_id: `us_${lab.sessions}`, chunk_bytes: 5 * 1024 * 1024, parts_total: 1, expires_at: day(1) }, 201);
  }
  m = /^\/api\/uploads\/sessions\/([^/]+)(?:\/(parts\/\d+|complete))?$/.exec(p);
  if (m) {
    if (method === 'PUT') return ok({ received: [1], bytes_so_far: 2048, parts_total: 1 });
    if (method === 'POST') return ok({ key: `merchants/u_ali/offers/up_${lab.sessions}.png`, url: '', visibility: 'private', mime: 'image/png', bytes: 2048, sha256: 'a'.repeat(64) });
    if (method === 'DELETE') return ok({ state: 'aborted' });
    return ok({ session_id: m[1], state: 'open', received: [], bytes_so_far: 0, declared_bytes: 2048, chunk_bytes: 5 * 1024 * 1024, parts_total: 1, expires_at: day(1) });
  }
  if (p.startsWith('/api/wallet') || p.startsWith('/api/currency') || p.startsWith('/api/settings') || p.startsWith('/api/notify')) return ok({});
  if (method !== 'GET') return ok({});
  return realFetch(input, init);
}) as typeof window.fetch;

/** Where the router actually is — read by the script (the old address must have been replaced). */
function LocationProbe() {
  const at = useLocation();
  return <span hidden data-location={`${at.pathname}${at.search}${at.hash}`} />;
}

const initial = route === 'legacy' ? '/requests?request=req_1#discussion' : '/requests/req_1';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <LanguageProvider>
        <WalletProvider>
          <CurrencyProvider>
            <MemoryRouter initialEntries={[initial]}>
              <LocationProbe />
              <Routes>
                <Route path="/requests" element={<Requests />} />
                <Route path="/requests/:id" element={<RequestPage />} />
              </Routes>
            </MemoryRouter>
            <Toaster />
          </CurrencyProvider>
        </WalletProvider>
      </LanguageProvider>
    </AuthProvider>
  </React.StrictMode>
);
