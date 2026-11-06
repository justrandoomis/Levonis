/**
 * «قيّم طابعتك», the code and the analysis, MOUNTED with explicit API fixtures
 * (DECISIONS row 301). The real screens, the real CSS; only the server is answered
 * here, with the shapes worker/lib/gifts/reviewCode.ts answers
 * (tests/reviewGiftCode.test.ts holds those).
 *
 *   ?view=rate&printer=code_ready|gift|in_cart|to_rate|none   /rewards/rate
 *   ?view=hub&printer=code_ready                         /rewards
 *   ?view=gifts                                          /gifts: a code's gift, grouped by level
 *   ?view=admin&state=submitted|approved&empty=1         the admin's review queue
 *   ?view=grant                                          the admin's grant detail
 *   ?view=sheet                                          the order's review sheet, on a printer
 *   ?view=form                                           the product page's review form, on a printer
 *   &score=26|5|92  &lang=ar|en|ckb   &theme=dark|light  &conflict=shipping  &refuse=1  &used=1 (the code answers GIFT_CODE_USED)  &withdrawn=1 (the gift chosen earlier has left the offer)
 *
 * Serve it with Vite beside the repo's other browser pages. Every API the screens
 * call is answered here; anything else 404s loudly. The requests are kept on
 * `window.giftRequests` for whoever drives the page.
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../../src/AuthContext';
import { LanguageProvider } from '../../src/LanguageContext';
import { WalletProvider } from '../../src/WalletContext';
import { CurrencyProvider } from '../../src/CurrencyContext';
import RewardsArea from '../../src/pages/RewardsArea';
import MyGifts from '../../src/components/reviews/MyGifts';
import AdminReviews from '../../src/components/AdminReviews';
import AdminGifts from '../../src/components/adminGifts/AdminGifts';
import ReviewSheet from '../../src/components/orders/ReviewSheet';
import ReviewSection from '../../src/components/reviews/ReviewSection';
import { giftLevelsForScore } from '../../packages/contracts/src/giftScore';
import '../../src/components/adminProducts/theme.css';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'rate';
const printerState = params.get('printer') ?? 'code_ready';
const lang = ['en', 'ckb'].includes(params.get('lang') ?? '') ? params.get('lang')! : 'ar';
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
localStorage.setItem('levo_lang', lang);

// ------------------------------------------------------------- the pictures

const art = (fill: string, accent: string, shape: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="${fill}"/>${shape.replace(/ACC/g, accent)}</svg>`
  )}`;
const PRINTER = art('#d9d4c8', '#2a2d33', '<rect x="26" y="20" width="68" height="78" rx="6" fill="ACC"/><rect x="34" y="28" width="52" height="46" rx="3" fill="#6f7680"/><rect x="48" y="82" width="24" height="6" rx="2" fill="#c9a85a"/>');
const SPOOL_BEIGE = art('#e7e0d3', '#cdb88e', '<circle cx="60" cy="60" r="42" fill="ACC"/><circle cx="60" cy="60" r="15" fill="#f5f1e8"/><circle cx="60" cy="60" r="6" fill="#8b8f98"/>');
const SPOOL_BLACK = art('#e7e0d3', '#2b2d31', '<circle cx="60" cy="60" r="42" fill="ACC"/><circle cx="60" cy="60" r="15" fill="#f5f1e8"/><circle cx="60" cy="60" r="6" fill="#8b8f98"/>');
const NOZZLE = art('#e7e0d3', '#b98f3e', '<path d="M48 22h24v30l10 14v10H38V66l10-14z" fill="ACC"/><rect x="54" y="76" width="12" height="20" rx="3" fill="#8b8f98"/>');

const tri = (ar: string, en: string, ckb: string) => ({ ar, en, ckb });

// ------------------------------------------------------------- the server's shapes

const SPOOL_1KG = tri('مع بكرة — 1 كغ', 'With spool — 1 kg', 'لەگەڵ بکرە — 1 کگم');
const item = (id: string, level: number, name: string, image: string, variant: ReturnType<typeof tri>, color: (ReturnType<typeof tri> & { hex: string }) | null, value: number) => ({
  item_id: id,
  product_id: `p_${id}`,
  slug: id,
  name: tri(name, name, name),
  image,
  variant,
  color,
  qty: 1,
  sale_type: 'direct_sale' as const,
  transport_method: '',
  value_iqd: value,
  lead_time_text: '',
  lead_time_min_days: null,
  lead_time_max_days: null,
  available: true,
  reason: null,
  level,
});
const CHOICES = [
  item('gpi_beige', 1, 'eSUN PLA+ 1 kg', SPOOL_BEIGE, SPOOL_1KG, { ...tri('بيج', 'Beige', 'بێج'), hex: '#cdb88e' }, 24000),
  item('gpi_black', 1, 'eSUN PLA+ 1 kg', SPOOL_BLACK, SPOOL_1KG, { ...tri('أسود', 'Black', 'ڕەش'), hex: '#2b2d31' }, 24000),
  item('gpi_nozzle2', 2, 'Hardened Nozzle Kit', NOZZLE, tri('قطر 0.4 مم', '0.4 mm', 'تیرەی 0.4 ملم'), null, 40000),
  item('gpi_nozzle3', 3, 'Hardened Nozzle Kit', NOZZLE, tri('قطر 0.6 مم', '0.6 mm', 'تیرەی 0.6 ملم'), null, 52000),
  item('gpi_black4', 4, 'eSUN PLA+ 2 kg', SPOOL_BLACK, tri('بكرتان — 2 كغ', 'Two spools — 2 kg', 'دوو بکرە — 2 کگم'), { ...tri('أسود', 'Black', 'ڕەش'), hex: '#2b2d31' }, 48000),
  item('gpi_beige5', 5, 'eSUN PLA+ 3 kg', SPOOL_BEIGE, tri('ثلاث بكرات — 3 كغ', 'Three spools — 3 kg', 'سێ بکرە — 3 کگم'), { ...tri('بيج', 'Beige', 'بێج'), hex: '#cdb88e' }, 72000),
];

const LEVEL_NAMES = [
  tri('المستوى الأول', 'Level 1', 'ئاستی یەکەم'),
  tri('المستوى الثاني', 'Level 2', 'ئاستی دووەم'),
  tri('المستوى الثالث', 'Level 3', 'ئاستی سێیەم'),
  tri('المستوى الرابع', 'Level 4', 'ئاستی چوارەم'),
  tri('المستوى الخامس', 'Level 5', 'ئاستی پێنجەم'),
];

/** The three reviews the owner's sentence names, as the server would answer them. */
function revealOf(score: number) {
  const levels = giftLevelsForScore(score);
  const parts =
    score === 5
      ? { text: { score: 0, max: 42, chars: 4, words: 1 }, images: { score: 0, max: 27, count: 0 }, video: { score: 0, max: 18, present: false }, story: { score: 0, max: 8, present: false }, stars: { score: 5, max: 5, stars: 3 } }
      : score === 26
        ? { text: { score: 13, max: 42, chars: 64, words: 12 }, images: { score: 6, max: 27, count: 1 }, video: { score: 0, max: 18, present: false }, story: { score: 0, max: 8, present: false }, stars: { score: 5, max: 5, stars: 4 } }
        : { text: { score: 34, max: 42, chars: 240, words: 38 }, images: { score: 27, max: 27, count: 3 }, video: { score: 18, max: 18, present: true }, story: { score: 8, max: 8, present: true }, stars: { score: 5, max: 5, stars: 2 } };
  const sum = parts.text.score + parts.images.score + parts.video.score + parts.story.score + parts.stars.score;
  return {
    score,
    levels,
    track: [1, 2, 3, 4, 5].map((level) => ({ level, name: LEVEL_NAMES[level - 1], threshold: level === 1 ? 1 : (level - 1) * 20, opened: levels.includes(level) })),
    breakdown: { ...parts, adjustment: score - sum },
    review: { product_id: 'p_printer', slug: 'bambu-p1s', name: tri('طابعة Bambu Lab P1S', 'Bambu Lab P1S', 'چاپکەری Bambu Lab P1S'), image: PRINTER, stars: parts.stars.stars },
    gift: gift(levels),
    replay: false,
  };
}

function gift(levels: number[]) {
  const max = levels.length;
  return {
    id: 'gift_code',
    status: 'GRANTED' as string,
    mode: 'level',
    reason: 'review',
    level: { n: max, name: LEVEL_NAMES[max - 1], description: tri('', '', ''), active: true },
    choices: CHOICES.filter((c) => levels.includes(c.level)) as typeof CHOICES | null,
    choice_scope: 'up_to',
    chosen_level: null as number | null,
    chosen: null as (typeof CHOICES)[number] | null,
    can_change_choice: true,
    cart_item_id: null,
    order: null,
    granted_at: '2026-11-05T10:00:00.000Z',
    chosen_at: null,
    redeemed_at: null,
    ordered_at: null,
    fulfilled_at: null,
    cancelled_at: null,
    legacy: null,
  };
}

const SCORE = Number(params.get('score') ?? 92);
const reveal = revealOf(SCORE);
const theGift = reveal.gift;
// A gift chosen earlier whose item the team has since withdrawn: it is still `chosen`, and no longer among the choices.
if (params.get('withdrawn') === '1') Object.assign(theGift, { status: 'READY_TO_REDEEM', chosen: { ...CHOICES[1], item_id: 'gpi_withdrawn' }, chosen_level: 1, chosen_at: '2026-11-05T10:01:00.000Z' });

/** The server's answer moves when the code is written, as it does for real: the hub then says the score. */
let codeWritten = false;

const printer = (state: string) => ({
  order_id: 'ord_1',
  product_id: 'p_printer',
  slug: 'bambu-p1s',
  name: tri('طابعة Bambu Lab P1S', 'Bambu Lab P1S', 'چاپکەری Bambu Lab P1S'),
  image: PRINTER,
  delivered_at: '2026-10-20T10:00:00.000Z',
  state,
  stars: state === 'to_rate' ? null : reveal.review.stars,
  reward_level: state === 'reward_approved' ? reveal.levels.length : null,
  final_score: state === 'reward_approved' ? SCORE : null,
  gift: state === 'reward_approved' ? { id: 'gift_code', status: printerState === 'in_cart' ? 'ADDED_TO_ORDER' : 'GRANTED', scope: 'up_to' } : null,
});

const hub = () => ({
  installed: true,
  server_time: new Date().toISOString(),
  point_balance: 1200,
  pending_points: { points: 0, next_available_at: null },
  program: {
    enabled: true,
    valid_days: 7,
    weekly: { enabled: true, months: 12 },
    free_shipping: { enabled: true, amount_iqd: 5000, min_order_iqd: 100000 },
    filament: { enabled: true, percent: 15, max_discount_iqd: 25000, max_pieces: 1, products: [], section: null },
  },
  coupons: [],
  coupon_counts: { active: 0, past: 0 },
  printers: printerState === 'none' ? [] : [printer(codeWritten || printerState === 'gift' || printerState === 'in_cart' ? 'reward_approved' : printerState), printer2()],
  rating: {
    gift_levels: [1, 2, 3, 4, 5].map((level) => ({ level, name: LEVEL_NAMES[level - 1], description: tri('', '', ''), active: true, threshold: level === 1 ? 1 : (level - 1) * 20 })),
    review_points: 25,
    no_level_points: 50,
  },
  shop: [],
  competitions: [],
  competition_counts: { open: 0, upcoming: 0, closed: 0, open_to_enter: 0 },
});
const printer2 = () => ({
  ...printer('rated'),
  order_id: 'ord_0',
  product_id: 'p_a1',
  slug: 'bambu-a1',
  name: tri('طابعة Bambu Lab A1', 'Bambu Lab A1', 'چاپکەری Bambu Lab A1'),
  stars: 5,
});

// ------------------------------------------------------------------- the admin

const QUALITY = { score: 92, tier: 4, reasons: ['meaningful_text', 'unique_images', 'video_present', 'supporting_evidence'], textQuality: 34, imageCount: 3, imageQuality: 27, videoPresent: true, videoQuality: 18, suspiciousSignals: [], rewardEligible: true, textChars: 240, wordCount: 38 };
const emptyLevels = params.get('empty') === '1';
const GIFT_LEVELS = [1, 2, 3, 4, 5].map((level) => ({
  level,
  active: emptyLevels ? false : level !== 5,
  items: emptyLevels ? 0 : level === 4 ? 0 : 1,
  sellable: emptyLevels ? 0 : level === 4 ? 0 : 1,
}));
const queueRow = (over: Record<string, unknown>) => ({
  review_id: 'rv_1',
  reward_id: 'rr_1',
  created_at: '2026-11-01T10:00:00.000Z',
  customer: { email: 'sara@example.com', username: 'sara', name: 'سارة', lang: 'ar' },
  product: { id: 'p_printer', name: 'Bambu Lab P1S', name_ar: 'طابعة Bambu Lab P1S', name_ckb: 'چاپکەری Bambu Lab P1S' },
  order_id: 'ord_1',
  stars: 4,
  body: 'جربت الطابعة لمدة شهر في ورشة صغيرة: دقة الأبعاد ممتازة والطبقة الأولى ثابتة، والضجيج مقبول. الصور تبيّن النتيجة من عدة زوايا.',
  media: [],
  review_status: 'published',
  source: 'user',
  moderation_note: '',
  kind: 'printer_gift',
  reward_state: 'submitted',
  quality_score: null,
  quality: QUALITY,
  final_score: null,
  levels: [],
  code: null,
  code_issued_at: null,
  code_redeemed_at: null,
  reason: '',
  points_awarded: 0,
  decided_at: null,
  entitlement_id: null,
  instagram: { link: 'https://instagram.com/stories/sara/1', file_url: null },
  facts: { delivered: true, is_printer: true, photos: 3, has_video: true, has_instagram: true, text_chars: 240, written_detail: true },
  ...over,
});
const QUEUE: Record<string, unknown[]> = {
  submitted: [queueRow({})],
  approved: [
    queueRow({ reward_state: 'approved', final_score: 26, levels: [1, 2], code: 'GFT7KQ4MZX', code_issued_at: '2026-11-05T10:00:00.000Z', reason: 'نص واضح وصور حقيقية.' }),
    queueRow({
      review_id: 'rv_2',
      reward_id: 'rr_2',
      product: { id: 'p_a1', name: 'Bambu Lab A1', name_ar: 'طابعة Bambu Lab A1', name_ckb: 'چاپکەری Bambu Lab A1' },
      reward_state: 'approved',
      final_score: 92,
      levels: [1, 2, 3, 4, 5],
      code: 'GFT3NP9RWH',
      code_issued_at: '2026-11-02T10:00:00.000Z',
      code_redeemed_at: '2026-11-03T10:00:00.000Z',
      reason: 'مراجعة كاملة.',
    }),
  ],
};

// ------------------------------------------------------------------ the fetch

const requests: Array<{ path: string; method: string; body?: unknown }> = [];
const unstubbed: string[] = [];
Object.assign(window, { giftRequests: requests, giftUnstubbed: unstubbed });
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, ...(data as object) }), { status: 200, headers: { 'content-type': 'application/json' } });
const refuse = (status: number, code: string, error: string) => new Response(JSON.stringify({ success: false, code, error }), { status, headers: { 'content-type': 'application/json' } });

const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, location.origin);
  const p = url.pathname;
  const method = (init?.method || 'GET').toUpperCase();
  if (!p.startsWith('/api/')) return realFetch(input as RequestInfo, init);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  requests.push({ path: `${p}${url.search}`, method, body });
  await new Promise((r) => setTimeout(r, 80));

  if (p === '/api/auth/me') return ok({ user: { id: 'u_sara', name: 'سارة', email: 'sara@example.com', role: view === 'admin' || view === 'grant' ? 'admin' : 'customer' } });
  if (p.startsWith('/api/wallet') || p.startsWith('/api/settings') || p.startsWith('/api/notifications') || p.startsWith('/api/currency')) return ok({});
  if (p === '/api/rewards/program' && method === 'GET') return ok(hub());
  if (p === '/api/rewards/program/gift-code' && method === 'POST') {
    if (params.get('refuse') === '1' || String(body?.code).trim().toUpperCase() === 'WRONG') return refuse(404, 'GIFT_CODE_INVALID', 'This code is not valid.');
    if (params.get('used') === '1') return refuse(409, 'GIFT_CODE_USED', 'This code has already been used.');
    codeWritten = true;
    return ok(reveal);
  }
  if (p.startsWith('/api/rewards/program/gift-reveal/')) return ok({ ...reveal, gift: theGift });
  if (p === '/api/gifts' && method === 'GET') return ok({ gifts: [theGift] });
  const choose = /^\/api\/gifts\/([^/]+)\/choose$/.exec(p);
  if (choose && method === 'POST') {
    const c = CHOICES.find((x) => x.item_id === body?.itemId);
    if (!c) return refuse(409, 'GIFT_ITEM_UNAVAILABLE', 'unavailable');
    Object.assign(theGift, { status: 'READY_TO_REDEEM', chosen: c, chosen_level: c.level, chosen_at: new Date().toISOString() });
    return ok({ gift: theGift });
  }
  if (/^\/api\/gifts\/[^/]+\/redeem$/.test(p) && method === 'POST') {
    Object.assign(theGift, { status: 'REDEEMED', choices: null, can_change_choice: false, redeemed_at: new Date().toISOString() });
    return ok({ gift: theGift });
  }
  if (p === '/api/cart/gift-items' && method === 'POST') {
    if (params.get('conflict') === 'shipping' && body?.replaceCart !== true) {
      return refuse(400, 'CART_SHIPPING_CONFLICT', 'Your cart holds items with a different shipping type.');
    }
    Object.assign(theGift, { status: 'ADDED_TO_ORDER', cart_item_id: 'ci_gift' });
    return ok({ items: [{ id: 'ci_gift', kind: 'gift', qty: 1, unit_price_iqd: 0 }], tier: 'free', tierActive: false });
  }
  if (p === '/api/cart') return ok({ items: [], tier: 'free', tierActive: false });
  if (p === '/api/reviews/admin/queue') {
    const state = url.searchParams.get('state') ?? 'submitted';
    return ok({ state, queue: QUEUE[state] ?? [], review_points_configured: 25, gift_levels: GIFT_LEVELS });
  }
  if (/^\/api\/reviews\/admin\/[^/]+\/reward$/.test(p)) return ok({ reward_state: 'approved', final_score: body?.finalScore, levels: giftLevelsForScore(Number(body?.finalScore)), code: 'GFT7KQ4MZX', warnings: [], entitlement_id: null });
  if (/^\/api\/reviews\/admin\/[^/]+\/code\/regenerate$/.test(p)) return ok({ code: 'GFT9ABCDEF' });
  if (p === '/api/gifts/admin/levels') return ok({ levels: [] });
  if (p === '/api/gifts/admin/grants') return ok({ grants: [adminGrant], next_cursor: null });
  if (p.startsWith('/api/gifts/admin/grants/')) return ok({ grant: adminGrant, audit: [] });
  if (p === '/api/reviews/order/ord_1') {
    return ok({
      order_id: 'ord_1',
      delivered: true,
      review_points: 25,
      remaining: 1,
      lines: [{ order_item_id: 'oi_1', product_id: 'p_printer', name: 'Bambu Lab P1S', image: PRINTER, variant: '', is_printer: true, existing_review: null, can_replace_system_review: false, state: 'reviewable' }],
    });
  }
  if (p === '/api/reviews/product/p_printer') return ok({ total: 0, avg_stars: null, reviews: [] });
  if (p === '/api/reviews/eligibility/p_printer') return ok({ eligible_orders: [{ id: 'ord_1', delivered_at: '2026-10-20T10:00:00.000Z' }], existing_review: null, can_replace_system_review: false, is_printer: true, review_points: 25 });
  unstubbed.push(`${method} ${p}`);
  return refuse(404, 'NOT_FOUND', `unstubbed: ${method} ${p}`);
}) as typeof window.fetch;

const adminGrant = {
  id: 'gift_code',
  status: 'REDEEMED',
  state: 'redeemed',
  mode: 'level',
  reason: 'review',
  level: { n: 4, name: LEVEL_NAMES[3], description: tri('', '', ''), active: true },
  choice_scope: 'up_to',
  chosen_level: 2,
  user: { id: 'u_sara', name: 'سارة', email: 'sara@example.com', username: 'sara', phone: '' },
  note: 'نص واضح وصور حقيقية.',
  granted_by: { id: 'boss', name: 'Levonis', email: 'boss@x.co' },
  granted_at: '2026-11-05T10:00:00.000Z',
  chosen: CHOICES[2],
  item_id: 'gpi_nozzle2',
  cart_item_id: null,
  order: null,
  order_seq: 0,
  chosen_at: '2026-11-05T10:01:00.000Z',
  redeemed_at: '2026-11-05T10:01:00.000Z',
  ordered_at: null,
  fulfilled_at: null,
  cancelled_at: null,
  cancelled_by: null,
  cancel_reason: '',
  version: 3,
  reward_id: 'rr_1',
  legacy: null,
  actions: { cancel: true, edit_reason: true, convert: false, fulfill: false },
};

const START: Record<string, string> = { rate: '/rewards/rate', hub: '/rewards', gifts: '/gifts', admin: '/admin', grant: '/admin', sheet: '/order', form: '/product' };
const NOTHING_REVIEWED: ReadonlySet<string> = new Set();

createRoot(document.getElementById('root')!).render(
  <AuthProvider>
    <LanguageProvider>
      <WalletProvider>
        <CurrencyProvider>
          <MemoryRouter initialEntries={[START[view] ?? '/rewards/rate']}>
            <div className="min-h-dvh flex flex-col bg-canvas text-text-primary">
              <Routes>
                <Route path="/rewards" element={<RewardsArea />} />
                <Route path="/rewards/rate" element={<RewardsArea />} />
                <Route path="/gifts" element={<div className="p-4"><MyGifts /></div>} />
                <Route
                  path="/admin"
                  element={
                    <div className="p-4">
                      {view === 'grant' ? <AdminGifts /> : <AdminReviews onOpenGifts={() => undefined} />}
                    </div>
                  }
                />
                <Route path="/order" element={<ReviewSheet open onClose={() => undefined} orderId="ord_1" items={[]} reviewedProductIds={NOTHING_REVIEWED} onSubmitted={() => undefined} />} />
                <Route path="/product" element={<div className="p-4"><ReviewSection productId="p_printer" /></div>} />
                <Route path="*" element={<p data-left-page>left the page</p>} />
              </Routes>
            </div>
          </MemoryRouter>
        </CurrencyProvider>
      </WalletProvider>
    </LanguageProvider>
  </AuthProvider>
);
