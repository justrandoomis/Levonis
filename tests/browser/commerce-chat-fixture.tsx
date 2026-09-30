/**
 * THE STORE'S CONVERSATION, AS SHIPPED, ON CANNED ANSWERS
 * (docs/COMMUNITY_COMMERCE_CHAT.md — stages 3–7).
 *
 * A browser fixture (served only by a local `vite`) for screenshots of the
 * commerce chat from both sides, in Arabic and English, phone and desktop,
 * in the app's two themes:
 *
 *   /tests/browser/commerce-chat.html?lang=ar|en&theme=dark|light&side=customer|merchant&scene=deal|orders
 *
 *   deal    a print request → a quote updated once (the old one says so) →
 *           a product whose price moved → a private product
 *   orders  the accepted quote → the escrow's events, the order's card once
 *           under the newest → a store order bought from the thread
 *
 * `fetch` answers with the shapes worker/routes/chats.ts, chatCommerce.ts and
 * worker/lib/chatCards.ts return — `original` frozen, `current` with the
 * actions the server would list for THIS side. The page and its cards are
 * untouched.
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../../src/AuthContext';
import { LanguageProvider } from '../../src/LanguageContext';
import { WalletProvider } from '../../src/WalletContext';
import { CurrencyProvider } from '../../src/CurrencyContext';
import { Toaster } from '../../src/components/ui/Toast';
import Chat from '../../src/pages/Chat';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'ar';
const side = params.get('side') === 'merchant' ? 'merchant' : 'customer';
const scene = params.get('scene') === 'orders' ? 'orders' : 'deal';
localStorage.setItem('levo_lang', lang);
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
document.documentElement.setAttribute('data-theme', params.get('theme') === 'light' ? 'light' : 'dark');

const L = (ar: string, en: string) => (lang === 'en' ? en : ar);
const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/** A product photograph stand-in: a soft studio backdrop and one object. */
function picture(shape: 'organizer' | 'plate' | 'holder', tone: string): string {
  const body =
    shape === 'organizer'
      ? `<rect x="110" y="120" width="180" height="110" rx="14" fill="${tone}"/><rect x="130" y="80" width="40" height="60" rx="8" fill="${tone}" opacity=".85"/><rect x="185" y="95" width="40" height="45" rx="8" fill="${tone}" opacity=".7"/><rect x="240" y="70" width="30" height="70" rx="8" fill="${tone}" opacity=".9"/>`
      : shape === 'plate'
        ? `<rect x="90" y="110" width="220" height="90" rx="10" fill="${tone}"/><rect x="110" y="140" width="180" height="10" rx="5" fill="#fff" opacity=".6"/><rect x="140" y="160" width="120" height="8" rx="4" fill="#fff" opacity=".4"/><rect x="170" y="200" width="60" height="30" fill="${tone}" opacity=".8"/>`
        : `<rect x="160" y="70" width="80" height="140" rx="14" fill="${tone}"/><rect x="172" y="84" width="56" height="100" rx="6" fill="#0b0b0b" opacity=".55"/><rect x="185" y="210" width="30" height="30" fill="${tone}" opacity=".8"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><defs><radialGradient id="g" cx="50%" cy="35%" r="75%"><stop offset="0" stop-color="#f2efe8"/><stop offset="1" stop-color="#cfc8ba"/></radialGradient></defs><rect width="400" height="300" fill="url(#g)"/><ellipse cx="200" cy="245" rx="130" ry="14" fill="#000" opacity=".12"/>${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const STORE = { id: 's_ali', slug: 'ali3d', name: 'Ali 3D' };
const who = (from: 'customer' | 'store') => (from === 'customer' ? 'buyer' : 'ali');
const isMine = (from: 'customer' | 'store') => (side === 'customer' ? from === 'customer' : from === 'store');
const merchant = side === 'merchant';

type Card = { type: string; kind: string; ref: string; original: Record<string, unknown>; current: Record<string, unknown> };
let seq = 0;
const text = (from: 'customer' | 'store', min: number, body: string) => ({
  id: `msg_${++seq}`, sender_id: who(from), mine: isMine(from), kind: 'text', body, fileUrl: null, card: null, system: false, created_at: ago(min),
});
const card = (from: 'customer' | 'store', min: number, c: Card, system = false) => ({
  id: `msg_${++seq}`, sender_id: who(from), mine: isMine(from), kind: `${c.type}_card`, body: String(c.original.title ?? c.original.name ?? ''), fileUrl: null, card: c, system, created_at: ago(min),
});

/** A link line (§9.4): kind 'text', the address as body, the card the server stored beside it (`link`). */
const LINKED_MODEL = 'https://www.printables.com/model/1234-articulated-dragon';
const dragonLink: { card_id: string; url: string; host: string; title: string; description: string; image_url: string | null; kind: string } = { card_id: 'lc_model', url: LINKED_MODEL, host: 'printables.com', title: L('تنين مفصلي v2 — يُطبع مجمّعًا', 'Articulated Dragon v2 — print-in-place'), description: '', image_url: '/files/link-cards/lc_model.webp', kind: 'model_page' };
const videoLink = { card_id: 'lc_video', url: 'https://youtu.be/dQw4w9WgXcQ', host: 'youtu.be', title: L('ضبط خلوص المفاصل على A1', 'Tuning joint clearance on an A1'), description: '', image_url: null, kind: 'video' };
const bareLink = { card_id: 'lc_bare', url: 'https://example.org/notes/42', host: 'example.org', title: '', description: '', image_url: null, kind: 'unknown' };
type ChatLinkShape = { card_id: string; url: string; host: string; title: string; description: string; image_url: string | null; kind: string };
const link = (from: 'customer' | 'store', min: number, l: ChatLinkShape) => ({ ...text(from, min, l.url), link: l });

const job = {
  title: L('حامل هاتف للسيارة بشعار الشركة', 'Car phone holder with our logo'),
  quantity: 20,
  material: 'PETG',
  color: L('أسود مطفي', 'Matte black'),
};
const request: Card = {
  type: 'print_request', kind: 'print_request_card', ref: 'req_1',
  original: {
    v: 1, request_id: 'req_1', ...job,
    description: L(
      'حامل يُثبَّت على فتحة المكيف، لهاتف حتى 6.7 إنش، والشعار محفور على الواجهة. أرفقت الشعار وملف النموذج.',
      'Clips onto the air vent, fits phones up to 6.7", logo engraved on the front. Logo and model attached.'
    ),
    dimensions: L('9 × 6 × 4 سم', '9 × 6 × 4 cm'), budget_iqd: 150000, deadline: day(10), notes: '',
    files: [
      { id: 'crf_1', name: 'logo-final.pdf', kind: 'document', inline: false },
      { id: 'crf_2', name: 'holder-v3.stl', kind: 'model', inline: false },
    ],
    created_by: 'customer',
  },
  current: merchant ? { status: 'receiving_offers', actions: ['edit_quote'], offer_id: 'off_1' } : { status: 'receiving_offers', actions: ['cancel'] },
};
const quoteTerms = (revision: number, price: number, days: number, message: string) => ({
  v: 1, offer_id: 'off_1', request_id: 'req_1', revision, request_revision: 1, ...job,
  price_iqd: price, completion_days: days, delivery_method: 'merchant_delivery', message,
  included: L('التغليف لكل قطعة', 'Each piece packed'), warranty_terms: L('إعادة الطباعة إن انكسر خلال 30 يومًا', 'Reprint if one breaks within 30 days'),
  expires_at: day(7),
});
const quoteOld: Card = {
  type: 'quote', kind: 'quote_card', ref: 'off_1',
  original: quoteTerms(1, 180000, 5, L('أبدأ غدًا، عندي PETG أسود.', 'I can start tomorrow, black PETG in stock.')),
  current: { status: 'changed', actions: [] },
};
const quoteNew = (accepted: boolean): Card => ({
  type: 'quote', kind: 'quote_card', ref: 'off_1',
  original: quoteTerms(2, 160000, 4, L('خصم لأنها 20 قطعة، وأسلّمها بيوم أقل.', 'A discount for 20 pieces, and a day sooner.')),
  current: accepted
    ? { status: 'accepted', actions: [], order_id: 'cord_1' }
    : merchant
      ? { status: 'pending', actions: ['edit', 'withdraw'] }
      : { status: 'pending', actions: ['accept', 'decline'] },
});
const product: Card = {
  type: 'product', kind: 'product_card', ref: 'cp_org',
  original: {
    v: 1, product_id: 'cp_org', name: 'Desk organizer', name_ar: 'منظّم مكتب', image: picture('organizer', '#3f4a3c'),
    price_iqd: 25000, price_max_iqd: null, original_price_iqd: 30000, variants: false, prep_days: 1,
    url: '/community/store/ali3d/p/organizer', store: STORE,
  },
  current: { status: 'available', actions: merchant ? ['view'] : ['add_to_cart', 'view'], price_iqd: 22000, price_max_iqd: null, original_price_iqd: 30000, price_changed: true },
};
const custom: Card = {
  type: 'custom_product', kind: 'custom_product_card', ref: 'cp_x',
  original: {
    v: 1, product_id: 'cp_x', name: 'Engraved desk nameplate', name_ar: 'لوحة مكتب محفورة باسمك',
    description: L('لوحة PLA بلونين، الاسم والمنصب محفوران، عرض 20 سم.', 'Two-colour PLA plate, name and title engraved, 20 cm wide.'),
    image: picture('plate', '#8a6d3b'), price_iqd: 35000, prep_days: 3, expires_at: day(7), quote_id: null, store: STORE,
  },
  current: merchant ? { status: 'available', actions: ['cancel'] } : { status: 'available', actions: ['add_to_cart'] },
};
const orderState = 'merchant_marked_delivered';
const customOrder = (event: string): Card => ({
  type: 'custom_order', kind: 'order_card', ref: 'cord_1',
  original: { v: 1, order_id: 'cord_1', request_id: 'req_1', title: job.title, price_iqd: 160000, event },
  current: { status: orderState, actions: merchant ? ['view'] : ['confirm', 'view'], request_id: 'req_1' },
});
const storeOrder = (event: string): Card => ({
  type: 'order', kind: 'order_card', ref: 'ORD-7F3A21',
  original: {
    v: 1, order_id: 'ORD-7F3A21', total_iqd: 57000, items: 2, event,
    lines: [{ name: L('لوحة مكتب محفورة باسمك', 'Engraved desk nameplate'), qty: 1 }, { name: L('منظّم مكتب', 'Desk organizer'), qty: 1 }],
    image: picture('plate', '#8a6d3b'),
  },
  current: { status: 'shipped', actions: ['view'] },
});

const messages =
  scene === 'deal'
    ? [
        text('customer', 95, L('السلام عليكم، أحتاج حامل هاتف للسيارة بشعار شركتي — 20 قطعة.', 'Hi! I need a car phone holder with my company logo — 20 pieces.')),
        link('customer', 94, dragonLink),
        text('store', 92, L('وعليكم السلام، أكيد. أرسل التفاصيل كطلب طباعة من زر + وأرسل لك عرض سعر هنا.', 'Sure — send the details as a print request from the + button and I will quote here.')),
        card('customer', 80, request),
        card('store', 60, quoteOld),
        text('customer', 41, L('ممكن أقل شوي؟ الميزانية 150 ألف.', 'Could it be a little less? My budget is 150k.')),
        link('store', 40, videoLink),
        link('store', 39, bareLink),
        card('store', 30, quoteNew(false)),
        text('store', 12, L('وهذا من الجاهز عندي، نزل سعره اليوم:', 'And this one is ready-made — its price dropped today:')),
        card('store', 11, product),
        card('store', 5, custom),
      ]
    : [
        card('store', 300, quoteNew(true)),
        card('customer', 290, customOrder('funded'), true),
        card('store', 200, customOrder('started'), true),
        text('store', 60, L('جاهزة ومغلّفة، المندوب في الطريق.', 'All packed — the courier is on the way.')),
        card('store', 58, customOrder('delivered'), true),
        card('customer', 20, storeOrder('placed'), true),
        card('store', 8, storeOrder('shipped'), true),
      ];

const orders = {
  role: side,
  store_orders: [{ id: 'ORD-7F3A21', status: 'shipped', total_iqd: 57000, items: 2, first_item: L('لوحة مكتب محفورة باسمك', 'Engraved desk nameplate'), created_at: ago(20) }],
  custom_orders: [{ id: 'cord_1', request_id: 'req_1', title: job.title, state: orderState, price_iqd: 160000, created_at: ago(290) }],
};
const picker = [
  { id: 'cp_org', name: 'Desk organizer', name_ar: 'منظّم مكتب', image: picture('organizer', '#3f4a3c'), price_iqd: 22000, price_max_iqd: null, original_price_iqd: 30000, in_stock: true, variants: false },
  { id: 'cp_hold', name: 'Phone holder', name_ar: 'حامل هاتف', image: picture('holder', '#2d3a4a'), price_iqd: 9000, price_max_iqd: 12000, original_price_iqd: null, in_stock: true, variants: true },
  { id: 'cp_plate', name: 'Name plate', name_ar: 'لوحة اسم', image: picture('plate', '#8a6d3b'), price_iqd: 18000, price_max_iqd: null, original_price_iqd: null, in_stock: false, variants: false },
];

const thread = {
  id: 'ch_1', context: { type: 'store', id: 's_ali' }, order_id: null, role: side, read_only: false,
  store: { id: 's_ali', name: 'Ali 3D', slug: 'ali3d', logoUrl: null, url: '/community/store/ali3d', open: true },
  other: merchant ? { name: 'Sara Kareem', username: 'sara' } : { name: 'Ali', username: 'ali' },
  can: merchant
    ? { product_card: true, store_card: true, quote: true, custom_product: true, print_request: false }
    : { product_card: false, store_card: false, quote: false, custom_product: false, print_request: true },
};
const me = merchant
  ? { id: 'ali', name: 'Ali', username: 'ali', email: 'ali@x.co', role: 'merchant' }
  : { id: 'buyer', name: 'Sara Kareem', username: 'sara', email: 'sara@x.co', role: 'customer' };

const ok = (b: unknown) => new Response(JSON.stringify({ success: true, ...(b as object) }), { headers: { 'content-type': 'application/json' } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input), location.origin);
  const p = url.pathname;
  const method = init?.method ?? 'GET';
  if (p === '/api/auth/me') return ok({ user: me });
  if (p === '/api/settings/public') return ok({ settings: { exchangeRate: 1400 } });
  if (p === '/api/wallet') return ok({ balance_usd_cents: 0, balance_iqd: 420000, point_balance: 0, transactions: [], point_transactions: [] });
  if (p === '/api/chats/ch_1') return ok({ chat: thread });
  if (p === '/api/chats/ch_1/messages' && method === 'GET') return ok({ messages, older_cursor: null });
  // «رابط» (§9.4): the server resolves the card and writes the line; a repeated client_id is the same line.
  if (p === '/api/chats/ch_1/cards/link' && method === 'POST') {
    const body = JSON.parse(String(init?.body ?? '{}')) as { url?: string; client_id?: string };
    const url = String(body.url ?? '');
    if (!/^https?:\/\//i.test(url)) return new Response(JSON.stringify({ success: false, error: 'not a link', code: 'LINK_URL_INVALID' }), { status: 400, headers: { 'content-type': 'application/json' } });
    const l = url === LINKED_MODEL ? dragonLink : { card_id: 'lc_new', url, host: new URL(url).hostname.replace(/^www\./, ''), title: '', description: '', image_url: null, kind: 'unknown' };
    const msg = { ...link(merchant ? 'store' : 'customer', 0, l), created_at: new Date().toISOString() };
    messages.push(msg);
    return new Response(JSON.stringify({ success: true, id: msg.id, message: msg, card: { ...l, id: l.card_id, status: l.title ? 'ok' : 'blocked', fetched_at: msg.created_at, reason: null } }), { status: 201, headers: { 'content-type': 'application/json' } });
  }
  if (p === '/api/chats/ch_1/typing') return ok({ typing: false, remainingMs: 0 });
  if (p === '/api/chats/ch_1/orders') return ok(orders);
  if (p === '/api/chats/ch_1/products') return ok({ products: picker, next_cursor: null });
  if (p.startsWith('/api/chats/ch_1/read')) return ok({});
  return new Response(JSON.stringify({ success: false, error: 'not in this fixture' }), { status: 404, headers: { 'content-type': 'application/json' } });
};

createRoot(document.getElementById('root')!).render(
  <AuthProvider>
    <LanguageProvider>
      <WalletProvider>
        <CurrencyProvider>
          <MemoryRouter initialEntries={['/chat/ch_1']}>
            <Routes>
              {/* The full-screen shell src/App.tsx gives /chat/:id: the list is the one scroll region. */}
              <Route
                path="/chat/:id"
                element={
                  <div className="h-[100dvh] min-h-0 flex flex-col font-sans overflow-hidden bg-canvas text-text-primary">
                    <Chat />
                  </div>
                }
              />
            </Routes>
          </MemoryRouter>
          <Toaster />
        </CurrencyProvider>
      </WalletProvider>
    </LanguageProvider>
  </AuthProvider>
);
