/**
 * «Scan Serial» IN A BROWSER — the order-preparation window with one slot per
 * physical unit, the camera sheet, the §19 blocker, the serial / warranty
 * page, the orders board chip, the owner's gate switch and the two policy
 * controls, on canned answers that follow the server's own contract
 * (worker/routes/adminOrderSerials.ts, worker/lib/serialAssignments.ts), so
 * they can be pressed and photographed without a worker:
 *
 *   /tests/browser/serial-prep.html
 *     ?scene=order|detail|board|gate|policy
 *     &state=fresh|partial|reopen|done          (order: what is linked already)
 *     &tab=order|stages                         (order: the tab it opens on)
 *     &owner=1|0  &scope=full|assistant  &gate=1|0
 *     &shipped=1     (order: past preparation — staff read only, the owner's exception)
 *     &lang=ar|en|ckb  &theme=dark|light
 *
 * The scan door answers the way the server does for these serials:
 *   03919D580600001  → SERIAL_IN_USE (the other order named to the owner only)
 *   03919D580600002  → SERIAL_DELIVERED (active warranty)
 *   03919D580600003  → an existing asset: «موجود مسبقاً» + «تم ربطه الآن»
 *   00M… / 094…      → SERIAL_PRODUCT_MISMATCH on an A1 line
 *   any 8–14 digits  → SERIAL_INVALID (an EAN / UPC / ITF)
 *   B0…  (box SN)    → SERIAL_INVALID BOX_ONLY
 *   anything else serial-shaped → linked (created)
 * What the page sent is kept on `window.__sent` for scripts/e2e-serial-prep.mjs.
 */
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { AuthProvider } from '../../src/AuthContext';
import { LanguageProvider, useLanguage } from '../../src/LanguageContext';
import { Toaster } from '../../src/components/ui/Toast';
import OrderDetailModal from '../../src/components/adminOrders/OrderDetailModal';
import OrderBoardRow from '../../src/components/adminOrders/OrderBoardRow';
import SerialDetail from '../../src/components/adminWarranty/serial/SerialDetail';
import SerialGateCard from '../../src/components/adminWarranty/serial/SerialGateCard';
import { WarrantySection as ProductWarrantySection } from '../../src/components/adminProducts/form/WarrantySection';
import { SectionsTab } from '../../src/components/adminTaxonomy/SectionsTab';
import type { CatalogNode } from '../../src/components/adminTaxonomy/shared';
import type { AdminOrderRow } from '../../src/lib/api';
import { serverMessage } from '../../packages/contracts/src/costRefusals';
import '../../src/index.css';
import '../../src/components/adminProducts/theme.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : params.get('lang') === 'ckb' ? 'ckb' : 'ar';
const scene = params.get('scene') ?? 'order';
const state = params.get('state') ?? 'fresh';
const owner = params.get('owner') !== '0';
const assistant = params.get('scope') === 'assistant';
const full = owner || !assistant;
const gateOn = params.get('gate') === '1';
const shipped = params.get('shipped') === '1';
localStorage.setItem('levo_lang', lang);
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
document.documentElement.setAttribute('data-theme', params.get('theme') === 'light' ? 'light' : 'dark');

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ORDER = 'ORD-2026-0142';
const mask = (raw: string) => (raw.length <= 4 ? '****' : `****${raw.slice(-4)}`);
const shown = (raw: string) => (full ? raw : mask(raw));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------- the order

const LINES = [
  { id: 'oi_a1', product_id: 'p_a1', name: 'Bambu Lab A1 Combo', variant: 'Combo · AMS Lite', qty: 2, price: 899_000, family: 'A1' },
  { id: 'oi_ams', product_id: 'p_ams', name: 'Bambu Lab AMS Lite', variant: '', qty: 1, price: 399_000, family: 'AMS' },
  { id: 'oi_pla', product_id: 'p_pla', name: 'Bambu PLA Basic', variant: lang === 'en' ? 'Black · 1 kg' : 'أسود · 1 كغ', qty: 3, price: 25_000, family: '' },
];
const SERIAL_LINES = LINES.filter((l) => l.family);

type Assignment = {
  id: string;
  serial_display: string;
  serial_full?: string;
  linked_at: string;
  linked_by: string;
  source: string;
  lot: { id: string; received_at: string | null; location: string | null } | null;
  lot_source: string | null;
  warranty: { state: 'PENDING_DELIVERY'; mode: string; carries_until: string | null };
  override_kind: string | null;
};
type Slot = {
  order_item_id: string;
  unit_index: number;
  part: 'device';
  part_index: 1;
  product_id: string;
  product_name: string;
  variant_label: string | null;
  assignment: Assignment | null;
  previous: null | { serial_display: string; serial_full?: string; released_at: string; reason: string; free: boolean };
  flags: string[];
  raw?: string;
};

let seq = 0;
const LOT = { id: 'lot_2026_09_21_a', received_at: '2026-09-21T09:00:00.000Z', location: lang === 'en' ? 'Shelf A-3' : 'رف A-3' };
function assignment(raw: string, extra: Partial<Assignment> = {}): Assignment {
  return {
    id: `sa_${++seq}`,
    serial_display: shown(raw),
    ...(full ? { serial_full: raw } : {}),
    linked_at: ago(12),
    linked_by: 'u_sara',
    source: 'camera',
    lot: LOT,
    lot_source: 'serial_link',
    warranty: { state: 'PENDING_DELIVERY', mode: 'new', carries_until: null },
    override_kind: null,
    ...extra,
  };
}

const slots: Slot[] = SERIAL_LINES.flatMap((l) =>
  Array.from({ length: l.qty }, (_, i) => ({
    order_item_id: l.id,
    unit_index: i + 1,
    part: 'device' as const,
    part_index: 1 as const,
    product_id: l.product_id,
    product_name: l.name,
    variant_label: l.variant || null,
    assignment: null,
    previous: null,
    flags: [],
  }))
);
const slotOf = (item: string, unit: number) => slots.find((s) => s.order_item_id === item && s.unit_index === unit);
function link(item: string, unit: number, raw: string, extra: Partial<Assignment> = {}) {
  const s = slotOf(item, unit)!;
  s.assignment = assignment(raw, extra);
  s.raw = raw;
  s.previous = null;
}
if (state === 'partial' || state === 'done') {
  link('oi_a1', 1, '03919D580607841');
  // A device that came back on a refund and is sold again: its warranty runs on to the original end.
  link('oi_ams', 1, '00N00A2B1234567', { warranty: { state: 'PENDING_DELIVERY', mode: 'carry', carries_until: '2027-03-14T00:00:00.000Z' }, lot: null, lot_source: null });
}
if (state === 'done') link('oi_a1', 2, '03919D580607842', { source: 'scanner' });
if (state === 'reopen') {
  slotOf('oi_a1', 1)!.previous = { serial_display: shown('03919D580607841'), ...(full ? { serial_full: '03919D580607841' } : {}), released_at: ago(60 * 26), reason: 'order_cancelled', free: true };
  slotOf('oi_a1', 2)!.previous = { serial_display: shown('03919D580607899'), ...(full ? { serial_full: '03919D580607899' } : {}), released_at: ago(60 * 26), reason: 'order_cancelled', free: false };
  slotOf('oi_a1', 2)!.flags = ['STOCK_NOT_RETAKEN'];
}

function serialsView() {
  const out = slots.map(({ raw: _raw, ...s }) => s);
  const missing = slots.filter((s) => !s.assignment).map((s) => ({ order_item_id: s.order_item_id, unit_index: s.unit_index, part: s.part, product_name: s.product_name }));
  return {
    installed: true,
    window: !shipped,
    shipment_locked: false,
    gate: { enabled: gateOn, applies: gateOn, since: gateOn ? ago(60 * 24 * 3) : null },
    required: slots.length,
    linked: slots.filter((s) => s.assignment).length,
    slots: out,
    missing,
  };
}

const L3 = (ar: string, en: string, ckb: string) => ({ label_ar: ar, label_en: en, label_ckb: ckb });
const STAGES = {
  received: L3('تم استلام الطلب', 'Order received', 'داواکاری وەرگیرا'),
  confirmed: L3('تم تأكيد الطلب', 'Order confirmed', 'داواکاری پشتڕاستکرایەوە'),
  preparing: L3('قيد التجهيز', 'Being prepared', 'ئامادە دەکرێت'),
  out_for_delivery: L3('في الطريق إليك', 'On the way to you', 'لە ڕێگەیە بۆ لات'),
  delivered: L3('تم التوصيل', 'Delivered', 'گەیەنرا'),
};
const stage = shipped ? 'out_for_delivery' : 'preparing';
const order = {
  id: ORDER,
  order_kind: 'normal',
  status: shipped ? 'shipped' : 'processing',
  stage,
  shipping_type: 'direct',
  address: { name: lang === 'en' ? 'Sara Ahmed' : 'سارة أحمد', phone: '+9647701234567', governorate: 'baghdad', area: lang === 'en' ? 'Karrada' : 'الكرادة', landmark: lang === 'en' ? 'Near the Hurriya roundabout' : 'قرب ساحة الحرية', notes: '' },
  delivery_method: { id: 'home', titleAr: 'توصيل للمنزل', titleEn: 'Home delivery', price_iqd: 5000 },
  payment_method_id: 'cash',
  subtotal_iqd: 2_272_000,
  shipping_iqd: 5_000,
  cod_tax_iqd: 0,
  points_discount_iqd: 0,
  wallet_applied_iqd: 0,
  price_hold_id: null,
  total_iqd: 2_277_000,
  due_on_delivery_iqd: 2_277_000,
  created_at: ago(60 * 5),
  updated_at: ago(10),
  items: LINES.map((l) => ({ id: l.id, product_id: l.product_id, name: l.name, image: '', variant: l.variant, qty: l.qty, unit_price_iqd: l.price, line_total_iqd: l.price * l.qty })),
  admin_note: '',
  financial: {
    merchandise_iqd: 2_272_000, fees_iqd: 0, subtotal_iqd: 2_272_000, coupon_discount_iqd: 0, points_used: 0, points_value_iqd: 0, shipping_iqd: 5_000,
    cod_tax_iqd: 0, delivery_waived: false, total_iqd: 2_277_000, wallet_applied_iqd: 0, due_on_delivery_iqd: 2_277_000, collected_iqd: null, outstanding_iqd: 2_277_000, payment_state: 'cod_due',
  },
  customer: { id: 'u_sara', name: 'Sara Ahmed', username: 'sara', email: 'sara@example.com', account_phone: null, membership_tier: 'free', member_since: '2025-02-01' },
  units: [],
  invoice: null,
  chat_id: null,
  tracking: {
    shipping_type: 'direct',
    stage,
    stage_source: 'manual',
    stage_changed_at: ago(40),
    next_stage: 'out_for_delivery',
    next_stage_at: null,
    delivery: { provider: '', remote_id: '', tracking_no: '', status_text: '', synced_at: null, error: '' },
    steps: (['received', 'confirmed', 'preparing', 'out_for_delivery', 'delivered'] as const).map((st, i) => ({
      stage: st,
      source: st === 'out_for_delivery' || st === 'delivered' ? 'delivery_api' : 'manual',
      reached: i <= 2,
      current: st === stage,
      at: i <= 2 ? ago(60 * (5 - i)) : null,
      ...STAGES[st],
    })),
    available: [
      { stage: 'out_for_delivery', source: 'manual', ...STAGES.out_for_delivery },
      { stage: 'confirmed', source: 'manual', ...STAGES.confirmed },
    ],
    history: [],
  },
};

// ----------------------------------------------------------- the serial page

function story(serial: string) {
  const s = slots.find((x) => x.raw === serial);
  const ams = serial.startsWith('00N');
  const live = !!s;
  const by = (email: string) => ({ id: `u_${email.split('@')[0]}`, email, username: null });
  const history = [
    ...(live ? [{ id: 9, action: 'serial.linked', created_at: ago(12), actor: by('sara@levonis.iq'), detail: { order_id: full ? ORDER : null, unit_index: s!.unit_index, source: 'camera' } }] : []),
    ...(ams
      ? [
          { id: 8, action: 'serial.returned', created_at: ago(60 * 24 * 9), actor: by('owner@levonis.iq'), detail: { order_id: full ? 'ORD-2026-0057' : null, return_case_id: 'rc_19' } },
          { id: 7, action: 'serial.warranty_activated', created_at: ago(60 * 24 * 160), actor: null, detail: { order_id: full ? 'ORD-2026-0057' : null } },
          { id: 6, action: 'serial.linked', created_at: ago(60 * 24 * 163), actor: by('ali@levonis.iq'), detail: { order_id: full ? 'ORD-2026-0057' : null } },
        ]
      : [
          { id: 5, action: 'serial.released', created_at: ago(60 * 26), actor: { id: 'u_omar', email: 'omar@levonis.iq', username: null, via: 'order_status_history' }, detail: { order_id: full ? 'ORD-2026-0111' : null, reason: 'order_cancelled' } },
          { id: 4, action: 'serial.linked', created_at: ago(60 * 30), actor: by('omar@levonis.iq'), detail: { order_id: full ? 'ORD-2026-0111' : null } },
        ]),
    { id: 1, action: 'serial_inventory.add', created_at: ago(60 * 24 * (ams ? 170 : 2)), actor: by('ali@levonis.iq'), detail: { source: ams ? 'bulk' : 'prep_scan' } },
  ];
  return {
    serial_display: shown(serial),
    ...(full ? { serial } : {}),
    serial_norm: full ? serial : null,
    legacy: false,
    product: ams ? { id: 'p_ams', name: 'Bambu Lab AMS Lite', name_ar: 'Bambu Lab AMS Lite' } : { id: 'p_a1', name: 'Bambu Lab A1 Combo', name_ar: 'Bambu Lab A1 Combo' },
    variant: ams ? null : { id: 'v_combo', label: 'Combo · AMS Lite' },
    sku: ams ? 'BL-AMS-LITE' : 'BL-A1-COMBO',
    status: live ? 'reserved' : 'in_stock',
    current_order: live ? { order_id: full ? ORDER : null, unit_index: s!.unit_index, linked_at: ago(12), activated: false } : null,
    previous_orders: ams
      ? [{ order_id: full ? 'ORD-2026-0057' : null, released_at: ago(60 * 24 * 9), reason: 'returned', linked_at: ago(60 * 24 * 163) }]
      : [{ order_id: full ? 'ORD-2026-0111' : null, released_at: ago(60 * 26), reason: 'order_cancelled', linked_at: ago(60 * 30) }],
    warranty: ams
      ? { state: live ? 'PENDING_DELIVERY' : 'RETURNED', start_at: ago(60 * 24 * 160), end_at: '2027-03-14T00:00:00.000Z', remaining_days: null, mode: live ? 'carry' : null, closed_reason: 'returned' }
      : { state: live ? 'PENDING_DELIVERY' : 'NOT_ACTIVATED', start_at: null, end_at: null, remaining_days: null, mode: live ? 'new' : null, closed_reason: null },
    lot: live && !ams ? { id: LOT.id, source: 'serial_link' } : null,
    history,
  };
}

// ----------------------------------------------------------- the doors

const sent: Array<{ method: string; path: string; body: unknown }> = [];
(window as unknown as { __sent: typeof sent }).__sent = sent;
let gate = { enabled: gateOn, since: gateOn ? ago(60 * 24 * 3) : null as string | null };
const me = {
  id: owner ? 'u_owner' : assistant ? 'u_assist' : 'u_admin',
  username: owner ? 'owner' : 'staff',
  name: owner ? 'Owner' : 'Staff',
  role: 'admin',
  isAdmin: true,
  admin_scope: assistant ? 'assistant' : 'full',
  // S1's hints, as publicUser sends them: cost is the (verified) owner's,
  // money the owner's and full admins', the legacy flag an alias of cost.
  is_owner: owner,
  can_view_cost: owner,
  can_write_cost: owner,
  can_move_money: !assistant,
  can_view_financials: owner,
  owner_email_unverified: false,
  email: owner ? 'owner@levonis.iq' : 'staff@levonis.iq',
  locale: lang === 'ckb' ? 'ku' : lang,
  avatar_key: null,
  bio: '',
  website: '',
  profile: {},
  country: 'IQ',
  phone: null,
  has_phone: false,
  notify_whatsapp: true,
  subscription_plan: 'free',
  membership_tier: 'free',
  subscription_expiry: 0,
  is_investor: false,
  creator_public: false,
};

const norm = (code: string) =>
  String(code)
    .trim()
    .toUpperCase()
    .replace(/^(?:PRODUCT\s*)?S\s*\/?\s*N(?:\s*[:：#]\s*|\s+)(?=\S)/, '')
    .replace(/[\s-]+/g, '');

const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url, location.origin);
  const p = u.pathname;
  const method = (init?.method ?? 'GET').toUpperCase();
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify({ success: true, ...(body as object) }), { status, headers: { 'content-type': 'application/json' } });
  const refused = (status: number, code: string, error: string, details?: Record<string, unknown>) =>
    new Response(JSON.stringify({ success: false, error, code, ...(details ? { details } : {}) }), { status, headers: { 'content-type': 'application/json' } });
  let body: Record<string, unknown> = {};
  if (init?.body && typeof init.body === 'string') {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = {};
    }
  }
  if (!p.startsWith('/api/')) return realFetch(input as RequestInfo, init);
  sent.push({ method, path: p, body });

  if (p === '/api/auth/me') return ok({ user: me });
  if (p === `/api/admin/orders/${ORDER}` && method === 'GET') return ok({ order: { ...order, serials: serialsView() } });
  if (p === `/api/admin/orders/${ORDER}/serials` && method === 'GET') return ok({ serials: serialsView() });
  if (p === `/api/admin/orders/${ORDER}/price-adjustment`)
    return ok({ order: { id: ORDER, total_iqd: order.total_iqd, due_on_delivery_iqd: order.due_on_delivery_iqd, wallet_applied_iqd: 0, payment_method_id: 'cash' }, blocker: null, can_propose: true, financial_scope: true, pending: null, history: [] });
  if (p === `/api/admin/warranties/orders/${ORDER}`)
    return ok({ order: { id: ORDER, status: order.status, delivered_at: null, created_at: order.created_at, invoice_no: null, customer: { name: 'Sara Ahmed', phone: '07701234567', address: '', email: '' } }, config: { default_months: 12 }, units: [] });

  // ---- the scan door (§3, §9–§11, §17, §18, §24)
  const serialDoor = p.match(/^\/api\/admin\/orders\/[^/]+\/serials\/(scan|change|unlink|override)$/);
  if (serialDoor && method === 'POST') {
    await wait(380);
    const kind = serialDoor[1];
    if (kind === 'unlink') {
      const s = slots.find((x) => x.assignment?.id === body.assignment_id);
      if (!s) return refused(404, 'SERIAL_ASSIGNMENT_NOT_FOUND', 'لم يُعثر على هذا الربط في الطلب.');
      const at = { order_item_id: s.order_item_id, unit_index: s.unit_index, part: 'device', assignment: null };
      s.assignment = null;
      s.raw = undefined;
      return ok({ code: 'SERIAL_UNLINKED', message: 'أُزيل الرقم التسلسلي من الوحدة.', slot: at });
    }
    let target: Slot | undefined;
    if (kind === 'change' || (kind === 'override' && body.assignment_id)) target = slots.find((x) => x.assignment?.id === body.assignment_id);
    else target = slotOf(String(body.order_item_id), Number(body.unit_index));
    if (!target) return refused(404, 'ITEM_NOT_IN_ORDER', 'هذا المنتج ليس ضمن هذا الطلب.');
    if (kind === 'override') {
      if (!owner) return refused(403, 'OWNER_ONLY', serverMessage('OWNER_ONLY'));
      if (String(body.reason ?? '').trim().length < 5) return refused(400, 'OVERRIDE_REASON_REQUIRED', 'اكتب سبب الاستثناء (5 أحرف على الأقل).');
    }
    const code = norm(String(body.code ?? ''));
    const line = LINES.find((l) => l.id === target!.order_item_id)!;
    if (kind !== 'override') {
      if (shipped) return refused(409, 'ORDER_NOT_PREPARABLE', 'لا يمكن ربط الأرقام التسلسلية في هذه المرحلة من الطلب.', { stage, status: 'shipped' });
      if (/^\d{8,14}$/.test(code)) return refused(400, 'SERIAL_INVALID', 'هذا ليس رقمًا تسلسليًا صالحًا — امسح «Product SN» أو اكتبه كما هو مطبوع.', { problem: 'SERIAL_LOOKS_LIKE_EAN' });
      if (/^WR-/.test(code)) return refused(400, 'SERIAL_INVALID', 'x', { problem: 'SERIAL_LOOKS_LIKE_RECEIPT' });
      if (/^B0\d{4}[A-Z]\d{7}[A-Z]{2}$/.test(code)) return refused(400, 'SERIAL_INVALID', 'x', { problem: 'BOX_ONLY' });
      if (code.length < 6) return refused(400, 'SERIAL_INVALID', 'x', { problem: code ? 'SERIAL_TOO_SHORT' : 'SERIAL_EMPTY' });
      if (!/^[0-9A-Z]+$/.test(code)) return refused(400, 'SERIAL_INVALID', 'x', { problem: 'SERIAL_CHARS' });
      if (line.family === 'A1' && /^(00M|094)/.test(code)) return refused(400, 'SERIAL_PRODUCT_MISMATCH', 'الرقم التسلسلي لا يطابق المنتج المحدد.');
      const elsewhere = slots.find((x) => x.raw === code && x !== target);
      if (elsewhere) return refused(409, 'SERIAL_IN_USE_THIS_ORDER', 'هذا الرقم مربوط بوحدة أخرى في الطلب نفسه.', { order_item_id: elsewhere.order_item_id, unit_index: elsewhere.unit_index });
      if (code === '03919D580600001') return refused(409, 'SERIAL_IN_USE', 'هذا الرقم التسلسلي مرتبط حالياً بطلب آخر.', owner ? { order_id: 'ORD-2026-0139' } : {});
      if (code === '03919D580600002')
        return refused(409, 'SERIAL_DELIVERED', 'هذا الجهاز تم تسليمه مسبقاً.', owner ? { order_id: 'ORD-2026-0021', warranty_end_at: '2027-06-01T00:00:00.000Z', active_warranty: true } : { active_warranty: true });
      if (kind === 'scan' && target.assignment) return refused(409, 'UNIT_ALREADY_LINKED', 'هذه الوحدة مربوطة برقم آخر — استخدم «تغيير».', { assignment_id: target.assignment.id });
    }
    const existing = code === '03919D580600003';
    target.assignment = assignment(code, {
      source: String(body.source ?? 'camera'),
      linked_at: new Date().toISOString(),
      ...(kind === 'override' ? { override_kind: String(body.kind), lot: null, lot_source: null } : {}),
    });
    target.raw = code;
    target.previous = null;
    return ok({
      outcome: existing ? 'existing' : 'created',
      code: existing ? 'SERIAL_EXISTING_LINKED' : 'SERIAL_LINKED',
      message: existing ? 'الرقم موجود مسبقاً وتم ربطه بهذا الطلب.' : 'تم ربط الرقم التسلسلي بالطلب.',
      assignment_id: target.assignment.id,
      slot: { order_item_id: target.order_item_id, unit_index: target.unit_index, part: 'device', assignment: target.assignment },
      warnings: [],
    });
  }

  // ---- the gated doors (§19)
  if ((p === `/api/admin/orders/${ORDER}/stage` || p === `/api/admin/orders/${ORDER}`) && method === 'PATCH') {
    await wait(250);
    const forward = body.stage === 'out_for_delivery' || body.stage === 'delivered' || body.status === 'shipped' || body.status === 'delivered';
    const missing = serialsView().missing;
    if (gateOn && forward && missing.length && !body.serials_override_reason)
      return refused(409, 'SERIALS_REQUIRED', 'تبقى أرقام تسلسلية غير مرتبطة لهذا الطلب.', { missing, lot_conflicts: [] });
    if (body.serials_override_reason && !owner) return refused(403, 'OWNER_ONLY', serverMessage('OWNER_ONLY'));
    return ok({});
  }

  // ---- the serial page (§16), the gate switch, the policy door
  const detail = p.match(/^\/api\/devices\/admin\/serial-inventory\/([^/]+)$/);
  if (detail && method === 'GET') {
    await wait(200);
    const sn = norm(decodeURIComponent(detail[1]));
    const st = story(sn);
    return ok({ row: null, history: [], story: st });
  }
  if (/^\/api\/devices\/admin\/serial-inventory\/[^/]+\/warranty-mode$/.test(p)) {
    if (!owner) return refused(403, 'OWNER_ONLY', serverMessage('OWNER_ONLY'));
    return ok({ mode: body.mode });
  }
  if (p === '/api/admin/settings' && method === 'GET') return ok({ settings: { serialPrepGate: gate } });
  if (p === '/api/admin/settings/serialPrepGate' && method === 'PUT') {
    if (!owner) return refused(403, 'OWNER_ONLY', serverMessage('OWNER_ONLY'));
    const v = (body.value ?? {}) as { enabled?: boolean; since?: string | null };
    gate = { enabled: !!v.enabled, since: v.enabled ? v.since ?? new Date().toISOString() : gate.since };
    return ok({});
  }
  if (/^\/api\/admin\/taxonomy\/catalogs\/[^/]+\/serial-policy$/.test(p)) {
    if (!owner) return refused(403, 'OWNER_ONLY', serverMessage('OWNER_ONLY'));
    return ok({ policy: body.policy, requires_serial: ['p_ams'] });
  }
  if (p === '/api/admin/taxonomy/catalogs' && method === 'POST') return ok({ created: false, catalog: { id: String(body.id ?? 'ct_new'), name_ar: String(body.name_ar ?? ''), name_en: String(body.name_en ?? '') } });

  return refused(404, 'NOT_STUBBED', `not stubbed: ${method} ${p}`);
}) as typeof window.fetch;

// ----------------------------------------------------------- the scenes

function OrderScene() {
  return <OrderDetailModal orderId={ORDER} onClose={() => undefined} />;
}

function DetailScene() {
  const sn = params.get('serial') ?? (state === 'partial' ? '00N00A2B1234567' : '03919D580607841');
  const [open, setOpen] = useState<string | null>(sn);
  return (
    <div className="p-6">
      <button type="button" className="lv-button lv-button-secondary" onClick={() => setOpen(sn)} data-open-detail>
        {sn}
      </button>
      <SerialDetail serial={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function BoardScene() {
  const { loc, lang: l } = useLanguage();
  const row = (id: string, name: string, items: string, serials: AdminOrderRow['serials'], next = true): AdminOrderRow =>
    ({
      ...order,
      id,
      address: { ...order.address, name },
      items: [{ id: `${id}_1`, product_id: 'p_a1', name: items, image: '', variant: '', qty: serials?.required ?? 1, unit_price_iqd: 899_000, line_total_iqd: 899_000 }],
      due_bucket: 'today',
      due_label: loc('اليوم', 'Today', 'ئەمڕۆ'),
      quick_next: next ? { stage: 'out_for_delivery', label: loc(STAGES.out_for_delivery.label_ar, STAGES.out_for_delivery.label_en, STAGES.out_for_delivery.label_ckb), source: 'manual' } : null,
      serials,
    }) as unknown as AdminOrderRow;
  const rows = [
    row('ORD-2026-0142', loc('سارة أحمد', 'Sara Ahmed', 'سارە ئەحمەد'), 'Bambu Lab A1 Combo', { required: 3, linked: 1, gate: gateOn, holds_next: gateOn }),
    row('ORD-2026-0143', loc('علي حسن', 'Ali Hassan', 'عەلی حەسەن'), 'Bambu Lab P1S', { required: 1, linked: 1, gate: gateOn, holds_next: false }),
    row('ORD-2026-0144', loc('نور محمد', 'Noor Mohammed', 'نوور محەمەد'), 'Bambu PLA Basic', undefined),
  ];
  return (
    <div className="mx-auto max-w-2xl space-y-2 p-3" dir={l === 'en' ? 'ltr' : 'rtl'}>
      {rows.map((o) => (
        <OrderBoardRow key={o.id} order={o} loc={loc} onOpen={() => undefined} onDelete={() => undefined} onAdvance={() => undefined} advancing={false} deleting={false} latin={l === 'en'} />
      ))}
    </div>
  );
}

function GateScene() {
  return (
    <div className="ap mx-auto max-w-2xl p-4">
      <SerialGateCard />
    </div>
  );
}

const CATALOGS: CatalogNode[] = [
  { id: 'ct_print', parent_id: null, slug: 'printers', name_ar: 'الطابعات', name_en: 'Printers', name_ckb: 'چاپکەرەکان', sort: 1, is_printer_catalog: true, active: true, serial_policy: 'inherit' },
  { id: 'ct_acc', parent_id: null, slug: 'accessories', name_ar: 'الملحقات', name_en: 'Accessories', name_ckb: 'پاشکۆکان', sort: 2, is_printer_catalog: false, active: true, serial_policy: 'inherit' },
  { id: 'ct_ams', parent_id: 'ct_acc', slug: 'ams', name_ar: 'أنظمة AMS', name_en: 'AMS systems', name_ckb: 'سیستەمەکانی AMS', sort: 1, is_printer_catalog: false, active: true, serial_policy: 'required' },
].map((c) => ({
  template_family: null,
  effective_template_family: null,
  product_count: 3,
  image_url: '',
  delivery_rules: [],
  spec_columns: 0,
  spec_groups: [],
  depth: c.parent_id ? 1 : 0,
  root_id: c.parent_id ?? c.id,
  description_ar: '',
  description_en: '',
  description_ckb: '',
  ...c,
})) as unknown as CatalogNode[];

function PolicyScene() {
  const [serialized, setSerialized] = useState<boolean | null>(null);
  const [printerSerialized, setPrinterSerialized] = useState<boolean | null>(null);
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4">
      <section data-policy-product="ams" className="rounded-2xl border border-border-subtle bg-surface p-4">
        <p className="mb-3 text-[13px] font-bold text-text-secondary">Bambu Lab AMS Lite</p>
        <ProductWarrantySection
          isPrinter={false}
          plans={[]}
          serialized={serialized}
          baseMonths={null}
          priceIqd={399_000}
          errors={{}}
          onPlansChange={() => undefined}
          onSerializedChange={setSerialized}
          onBaseMonthsChange={() => undefined}
          canEditSerial={owner}
          sectionSerial={{ policy: 'required', sectionName: lang === 'en' ? 'AMS systems' : lang === 'ckb' ? 'سیستەمەکانی AMS' : 'أنظمة AMS' }}
        />
      </section>
      <section data-policy-product="printer" className="rounded-2xl border border-border-subtle bg-surface p-4">
        <p className="mb-3 text-[13px] font-bold text-text-secondary">Bambu Lab A1 Combo</p>
        <ProductWarrantySection
          isPrinter
          plans={[]}
          serialized={printerSerialized}
          baseMonths={12}
          priceIqd={899_000}
          errors={{}}
          onPlansChange={() => undefined}
          onSerializedChange={setPrinterSerialized}
          onBaseMonthsChange={() => undefined}
          canEditSerial={owner}
        />
      </section>
      <div className="ap" data-policy-sections>
        <SectionsTab catalogs={CATALOGS} reload={async () => undefined} notify={() => undefined} />
      </div>
    </div>
  );
}

function Scene() {
  if (scene === 'detail') return <DetailScene />;
  if (scene === 'board') return <BoardScene />;
  if (scene === 'gate') return <GateScene />;
  if (scene === 'policy') return <PolicyScene />;
  return <OrderScene />;
}

// The app's own provider order (src/App.tsx): Auth → Language.
createRoot(document.getElementById('root')!).render(
  <AuthProvider>
    <LanguageProvider>
      <div className="min-h-screen bg-canvas text-text-primary">
        <Scene />
      </div>
      <Toaster />
    </LanguageProvider>
  </AuthProvider>
);
