/**
 * MODERATION V2, REPUTATION V2 AND DISPUTE EVIDENCE IN A BROWSER
 * (docs/COMMUNITY_ECOSYSTEM.md §9.6, Client 6a) — the real components with
 * every door they knock on answered locally, so scripts/e2e-moderation.mjs
 * can press, read and photograph them without a Worker:
 *
 *   /tests/browser/moderation.html?scene=…&lang=ar|en|ckb&theme=dark|light
 *
 *   desk        «الإشراف»: the report queue (every kind a report names), the
 *               ladder with its ConfirmDialog, hiding, the history sheet,
 *               and «الاعتراضات» a press away
 *   disputes    the dispute desk (ComplaintsDesk) → a case → «المحادثة» / «الطلب»
 *   page        /moderation, «حالة حسابي»: `&status=restricted|suspended|banned|active`,
 *               `&action=mod_2` (the notice's decision)
 *   badges      /community/badges (`&hash=fast_response`)
 *   evidence    /admin/chats/ch_1 — the chat read-only for staff;
 *               `&refused=not_linked|closed` for the evidence door's refusals
 *   storefront  the store hero with its chips (`&hero=profile|cover`)
 *   creator     /u/sara with her store's chips
 *   reputation  «سمعتك» (`&rep=none` for «قيد الحساب»)
 *
 * The answers have the shapes worker/routes/adminModeration.ts,
 * worker/routes/chats.ts, worker/routes/community.ts and
 * worker/routes/merchantReputation.ts return; writes change the in-memory
 * rows so a decision reads back as the server would read it.
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from '../../src/AuthContext';
import { LanguageProvider } from '../../src/LanguageContext';
import { WalletProvider } from '../../src/WalletContext';
import { CurrencyProvider } from '../../src/CurrencyContext';
import { Toaster } from '../../src/components/ui/Toast';
import { SocialProvider } from '../../src/components/community/social/SocialContext';
import ModerationDesk from '../../src/components/adminCommunity/moderation/ModerationDesk';
import { ComplaintsDesk } from '../../src/components/adminCommunity/AdminCommunity';
import ModerationPage from '../../src/components/community/moderation/ModerationPage';
import BadgesPage from '../../src/pages/community/Badges';
import Chat from '../../src/pages/Chat';
import CreatorPage from '../../src/pages/community/Creator';
import ReputationCard from '../../src/components/merchant/analytics/ReputationCard';
import StoreRenderer from '../../src/components/storefront/StoreRenderer';
import { StorefrontRuntimeProvider } from '../../src/components/storefront/runtime';
import { previewRuntime } from '../../src/components/storefront/preview';
import type { StorefrontStore } from '../../src/components/storefront/types';
import '../../src/components/storefront/styles';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : params.get('lang') === 'ckb' ? 'ckb' : 'ar';
const scene = params.get('scene') ?? 'desk';
localStorage.setItem('levo_lang', lang);
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
document.documentElement.setAttribute('data-theme', params.get('theme') === 'light' ? 'light' : 'dark');

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);

/** A photograph stand-in: a soft backdrop and one printed object. */
function picture(tone: string, w = 600, h = 600): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><defs><radialGradient id="g" cx="50%" cy="35%" r="80%"><stop offset="0" stop-color="#f1ede4"/><stop offset="1" stop-color="#c9c2b3"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><path d="M${w * 0.35} ${h * 0.2} q-${w * 0.12} ${h * 0.25} 0 ${h * 0.45} q${w * 0.05} ${h * 0.1} -${w * 0.03} ${h * 0.2} h${w * 0.36} q-${w * 0.08} -${h * 0.1} -${w * 0.03} -${h * 0.2} q${w * 0.12} -${h * 0.2} 0 -${h * 0.45} z" fill="${tone}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ------------------------------------------------------------------ who is looking

const ADMIN = { id: 'staff_1', username: 'desk', name: 'علي — الإشراف', role: 'admin', isAdmin: true, admin_scope: 'full', email: 'x@x.co', locale: lang === 'ckb' ? 'ku' : lang, avatar_key: null, bio: '', website: '', profile: {}, country: 'IQ', phone: null, has_phone: false, notify_whatsapp: true, subscription_plan: 'free', membership_tier: 'free', subscription_expiry: 0, is_investor: false, creator_public: false };
const status = params.get('status') ?? 'restricted';
const standing =
  status === 'active'
    ? { status: 'active', reason: '', until: null }
    : { status, reason: status === 'banned' ? 'احتيال متكرر على المشترين' : 'نشر إعلانات متكررة في التعليقات', until: status === 'banned' ? null : inDays(5) };
const MEMBER = { ...ADMIN, id: 'u_eve', username: 'eve', name: 'إيف', role: 'customer', isAdmin: false, admin_scope: null, moderation: standing };
const me = scene === 'desk' || scene === 'disputes' || scene === 'evidence' ? ADMIN : scene === 'page' || scene === 'reputation' ? MEMBER : null;

// ------------------------------------------------------------------ the desk's rows

type Person = { id: string; name: string; username: string | null; status: string };
const people: Record<string, Person> = {
  u_sara: { id: 'u_sara', name: 'سارة كريم', username: 'sara', status: 'active' },
  u_omar: { id: 'u_omar', name: 'Omar 3D', username: 'omar', status: 'suspended' },
  u_ali: { id: 'u_ali', name: 'علي حسن', username: 'ali3d', status: 'active' },
  u_zain: { id: 'u_zain', name: 'زينب', username: null, status: 'restricted' },
  u_admin: { id: 'u_admin', name: 'فريق Levonis', username: 'levonis', status: 'active' },
};
const person = (id: string) => ({ ...people[id] });
const postHidden: Record<string, { at: string; reason: string } | null> = { p_spam: { at: ago(40), reason: 'إعلان متكرر' }, p_ok: null };
const commentState: Record<string, string> = { c1: 'visible', rc1: 'hidden' };
const statusUntil: Record<string, string | null> = { u_omar: inDays(3), u_zain: inDays(9) };

function target(kind: string, id: string): Record<string, unknown> {
  // A post its author deleted since it was reported.
  if (id === 'p_gone') return { kind, id, exists: false };
  switch (kind) {
    case 'post':
      return {
        kind,
        id,
        exists: true,
        card: { id, kind: 'project', title: id === 'p_spam' ? 'اشترِ متابعين الآن — عرض محدود' : 'حامل هاتف قابل للطي', excerpt: 'طُبع بدون دعامات، طبقة 0.2.', cover: { url: picture(id === 'p_spam' ? '#b0473c' : '#6c7a4a', 800, 800), kind: 'image', width: 800, height: 800 }, url: `/community/projects/${id}` },
        hidden: postHidden[id],
        author: person(id === 'p_spam' ? 'u_omar' : 'u_sara'),
      };
    case 'comment':
      return { kind, id, exists: true, post_id: 'p_ok', post_url: '/community/projects/p_ok', body: 'هذا التصميم مسروق وصاحبه لص، لا تشتروا منه.', state: commentState[id], hidden_reason: '', created_at: ago(90), author: person('u_zain') };
    case 'request_comment':
      return { kind, id, exists: true, request_id: 'req_9', comment_kind: 'public_comment', body: 'تواصل معي على واتساب خارج الموقع لسعر أرخص', state: commentState[id], hidden_reason: 'تحويل للشراء خارج المنصة', created_at: ago(200), author: person('u_sara') };
    case 'order_update':
      return { kind, id, exists: true, order_id: 'co_7', update_kind: 'progress_photo', body: 'صورة التقدم في الطباعة', has_file: true, created_at: ago(300), author: person('u_ali') };
    case 'user': {
      const p = people[id];
      return { kind, id, exists: true, name: p.name, username: p.username, avatarUrl: id === 'u_omar' ? picture('#4a6c7a', 200, 200) : null, staff: id === 'u_admin', status: p.status, stored_status: p.status, status_reason: p.status === 'active' ? '' : 'سبام', status_until: statusUntil[id] ?? null, creator_public: !!p.username, created_at: ago(90_000) };
    }
    case 'store':
      return { kind, id, exists: true, slug: 'ali3d', name: 'Ali 3D', status: 'active', status_reason: '', merchant_status: 'active', owner_id: 'u_ali', logoUrl: picture('#b08d3c', 200, 200) };
    case 'product':
      return { kind, id, exists: true, slug: 'dragon', name: 'Articulated dragon', name_ar: 'تنين مفصلي', status: 'active', lifecycle: 'active', hidden: null, merchant_id: 'm_ali', store_slug: 'ali3d' };
    case 'request':
      return { kind, id, exists: true, title: 'نسخة من مجسم محمي بحقوق', state: 'open', visibility: 'public', customer: { id: 'u_zain', name: 'زينب' } };
    default:
      return { kind, id, exists: false };
  }
}

const REASONS = ['spam', 'abuse', 'fraud', 'copyright', 'nudity', 'offtopic', 'other'];
const reports = [
  ['post', 'p_spam', 4, 3],
  ['comment', 'c1', 2, 2],
  ['user', 'u_omar', 5, 1],
  ['request_comment', 'rc1', 1, 1],
  ['order_update', 'ou1', 1, 1],
  ['store', 's_ali', 1, 1],
  ['product', 'cp_1', 1, 1],
  ['request', 'req_2', 2, 2],
  ['user', 'u_admin', 1, 1],
  ['post', 'p_gone', 1, 1],
  ['post', 'p_ok', 1, 0],
  // More of the same, so the queue runs past one page after the desk has decided a few.
  ['comment', 'c1', 2, 2],
  ['user', 'u_zain', 1, 1],
  ['post', 'p_spam', 4, 3],
].map(([kind, id, all, open], i) => ({
  id: `rep_${i + 1}`,
  state: i === 10 ? 'dismissed' : 'open',
  reason: REASONS[i % REASONS.length],
  details: i === 0 ? 'ينشر نفس الإعلان في كل مكان منذ يومين.' : i === 2 ? 'يرسل رسائل مزعجة لكل من يعلّق.' : '',
  created_at: ago(20 + i * 35),
  reviewed_by: null,
  reviewed_at: null,
  resolution: i === 10 ? 'ليس مخالفًا' : '',
  reporter: { id: `u_r${i}`, name: ['نور', 'Hama', 'ليلى', 'سيف', 'Dana'][i % 5], username: null },
  kind: String(kind),
  target_id: String(id),
  reports_on_target: Number(all),
  open_on_target: Number(open),
}));

const history = (type: string, id: string) => ({
  target: { type, id },
  current: type === 'user' ? { exists: true, status: people[id]?.status ?? 'active', stored_status: people[id]?.status ?? 'active', reason: 'سبام', until: statusUntil[id] ?? null, changed_at: ago(60), staff: false } : { exists: true, state: 'published', visibility: 'public', hidden: postHidden[id] ?? null, author_id: 'u_omar' },
  actions: [
    { id: 'mod_31', action: 'suspend', target_type: 'user', target_id: 'u_omar', reason: 'رسائل مزعجة لكل من يعلّق', until: inDays(3), report_id: 'rep_3', subject_user_id: 'u_omar', created_at: ago(60), actor: { id: 'staff_1', name: 'علي' }, appeal: { id: 'apl_1', state: 'open', body: 'كنت أرد على الأسئلة فقط.', decision: '', decided_at: null, created_at: ago(30) } },
    { id: 'mod_30', action: 'warn', target_type: 'user', target_id: 'u_omar', reason: 'تنبيه أول على الرسائل المكررة', until: null, report_id: null, subject_user_id: 'u_omar', created_at: ago(3_000), actor: { id: 'staff_2', name: 'مريم' }, appeal: null },
    { id: 'mod_29', action: 'hide', target_type: 'post', target_id: 'p_spam', reason: 'إعلان متكرر', until: null, report_id: 'rep_1', subject_user_id: 'u_omar', created_at: ago(40), actor: { id: 'staff_1', name: 'علي' }, appeal: { id: 'apl_0', state: 'rejected', body: 'ليس إعلانًا', decision: 'الإعلان نفسه منشور 14 مرة.', decided_at: ago(20), created_at: ago(35) } },
  ],
  audit: [
    { id: 901, action: 'admin.moderation.user_status', actor: { id: 'staff_1', name: 'علي' }, detail: {}, created_at: ago(60) },
    { id: 900, action: 'moderation.appeal_filed', actor: { id: 'u_omar', name: 'Omar 3D' }, detail: {}, created_at: ago(30) },
  ],
});

const appeals = [
  { id: 'apl_1', state: 'open', body: 'كنت أرد على أسئلة الناس عن الطابعة، ولم أرسل إعلانًا لأحد. أرجو مراجعة الرسائل.', decision: '', decided_at: null, created_at: ago(30), user: person('u_omar'), action: { id: 'mod_31', action: 'suspend', target_type: 'user', target_id: 'u_omar', reason: 'رسائل مزعجة لكل من يعلّق', until: inDays(3), created_at: ago(60) } },
  { id: 'apl_2', state: 'open', body: 'التعليق كان مزحة بيني وبين صديقي.', decision: '', decided_at: null, created_at: ago(90), user: person('u_zain'), action: { id: 'mod_22', action: 'hide', target_type: 'comment', target_id: 'c1', reason: 'إساءة', until: null, created_at: ago(200) } },
  { id: 'apl_0', state: 'rejected', body: 'ليس إعلانًا', decision: 'الإعلان نفسه منشور 14 مرة.', decided_at: ago(20), created_at: ago(35), user: person('u_omar'), action: { id: 'mod_29', action: 'hide', target_type: 'post', target_id: 'p_spam', reason: 'إعلان متكرر', until: null, created_at: ago(40) } },
];

// ------------------------------------------------------------------ the person's own page

const decisions = [
  { id: 'mod_1', action: status === 'active' ? 'restore' : status === 'banned' ? 'ban' : status === 'suspended' ? 'suspend' : 'restrict', target_type: 'user', target_id: 'u_eve', target_label: null, target_url: null, reason: String(standing.reason || ''), until: standing.until, created_at: ago(120), appealable: status !== 'active', appeal: null as null | Record<string, unknown> },
  { id: 'mod_2', action: 'hide', target_type: 'post', target_id: 'p_eve', target_label: 'مزهرية حلزونية', target_url: '/community/projects/p_eve', reason: 'صورة تحمل رقم هاتف', until: null, created_at: ago(2_000), appealable: true, appeal: null as null | Record<string, unknown> },
  { id: 'mod_3', action: 'hide', target_type: 'comment', target_id: 'c_eve', target_label: 'رد غاضب على بائع', target_url: null, reason: 'إساءة', until: null, created_at: ago(9_000), appealable: false, appeal: { id: 'apl_9', state: 'rejected', decision: 'التعليق يسيء لشخص باسمه.', decided_at: ago(8_000), created_at: ago(8_500) } },
  { id: 'mod_4', action: 'warn', target_type: 'user', target_id: 'u_eve', target_label: null, target_url: null, reason: 'تنبيه على التعليقات الحادة', until: null, created_at: ago(12_000), appealable: false, appeal: { id: 'apl_8', state: 'accepted', decision: 'قُبل — التنبيه أُرسل خطأً.', decided_at: ago(11_000), created_at: ago(11_500) } },
];

// ------------------------------------------------------------------ reputation

const BADGE_RULES = [
  { key: 'verified_merchant', rule_params: { verified: true } },
  { key: 'fast_response', rule_params: { window_days: 30, median_within_minutes: 60, min_threads: 10 } },
  { key: 'reliable_seller', rule_params: { window_days: 90, min_completed: 20, max_merchant_cancel_percent: 3, max_disputes_lost: 0 } },
  { key: 'custom_specialist', rule_params: { window_days: 90, min_custom_completed: 10, accepts_custom_requests: true } },
  { key: 'high_completion', rule_params: { window_days: 90, min_completion_percent: 95, min_orders: 20 } },
];
const STORE_BADGES = [
  { key: 'verified_merchant', since: day(200) },
  { key: 'fast_response', since: day(12) },
  { key: 'reliable_seller', since: day(40) },
  { key: 'high_completion', since: day(8) },
];
const REPUTATION = {
  badges: [
    { key: 'fast_response', since: day(12), evidence: { median_within_minutes: 60, threads: 14, window_days: 30 } },
    { key: 'reliable_seller', since: day(40), evidence: { completed: 23, merchant_cancel_percent: 2, disputes_lost: 0, window_days: 90 } },
  ],
  responds_within_minutes: 60,
  metrics: {
    window_30: { window_days: 30, first_reply_count: 14, median_within_minutes: 60, first_reply_avg_minutes: 41, orders_completed: 9, custom_orders_completed: 4, orders_cancelled_by_merchant: 0, disputes_lost: 0, orders_ended: 9, merchant_cancel_percent: 0, completion_percent: 100 },
    window_90: { window_days: 90, first_reply_count: 30, median_within_minutes: 120, first_reply_avg_minutes: 70, orders_completed: 22, custom_orders_completed: 7, orders_cancelled_by_merchant: 2, disputes_lost: 0, orders_ended: 24, merchant_cancel_percent: 8, completion_percent: 92 },
  },
  rules: Object.fromEntries(BADGE_RULES.map((b) => [b.key, b.rule_params])),
  through: day(1),
};

// ------------------------------------------------------------------ the evidence thread

const refused = params.get('refused');
const card = (type: string, ref: string, original: Record<string, unknown>, current: Record<string, unknown>) => ({ type, kind: `${type}_card`, ref, original, current });
const THREAD = {
  id: 'ch_1',
  context: { type: 'request', id: 'req_9' },
  order_id: null,
  role: 'staff',
  read_only: true,
  store: { id: 's_ali', name: 'Ali 3D', slug: 'ali3d', logoUrl: picture('#b08d3c', 200, 200), url: '/community/store/ali3d', open: true },
  other: null,
  can: { product_card: false, store_card: false, quote: false, print_request: false, custom_product: false },
  evidence: { community_order_id: 'co_7', order_id: null, complaint_id: 'cmp_1', request_id: 'req_9' },
};
const MESSAGES = [
  { id: 'm1', sender_id: 'u_zain', mine: false, kind: 'text', body: 'السلام عليكم، أريد حامل شاشة بهذه المقاسات بلون أسود.', fileUrl: null, created_at: ago(3_000) },
  { id: 'm2', sender_id: 'u_ali', mine: false, kind: 'text', body: 'أهلًا، أقدر أطبعه PETG خلال 4 أيام. سأرسل عرضًا الآن.', fileUrl: null, created_at: ago(2_950) },
  {
    id: 'm3',
    sender_id: 'u_ali',
    mine: false,
    kind: 'store_card',
    body: 'Ali 3D',
    fileUrl: null,
    // The server empties a staff reader's actions; this one arrives with one, and the page drops it anyway.
    card: card('store', 's_ali', { store_id: 's_ali', slug: 'ali3d', name: 'Ali 3D', tagline: 'طباعة FDM وراتنج', logo: null, url: '/community/store/ali3d' }, { status: 'open', actions: ['view'], name: 'Ali 3D' }),
    created_at: ago(2_940),
  },
  { id: 'm4', sender_id: 'u_zain', mine: false, kind: 'text', body: 'وصل الحامل لكن المقاس أصغر بـ 2 سم مما اتفقنا عليه.', fileUrl: null, created_at: ago(400) },
  { id: 'm5', sender_id: 'u_ali', mine: false, kind: 'text', body: 'المقاس مطابق للملف الذي أرسلته أنت.', fileUrl: null, created_at: ago(380) },
];

// ------------------------------------------------------------------ the doors

const realFetch = window.fetch.bind(window);
const ok = (body: unknown, status = 200) => new Response(JSON.stringify({ success: true, ...(body as object) }), { status, headers: { 'content-type': 'application/json' } });
const refuse = (status: number, code: string, error = code) => new Response(JSON.stringify({ success: false, error, code }), { status, headers: { 'content-type': 'application/json' } });
let appealsFiled = 0;
/** Every write the page made, for the e2e script to read back. */
const writes: Array<{ method: string; path: string; body: unknown }> = [];
(window as unknown as { __writes: typeof writes }).__writes = writes;

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url, location.origin);
  const p = u.pathname;
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = init?.body && typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  if (method !== 'GET') writes.push({ method, path: p + u.search, body });
  if (p === '/api/auth/me' || p === '/api/me') return me ? ok({ user: me }) : refuse(401, 'UNAUTHORIZED');
  if (p === '/api/community/access') return ok({ closed: false, admin: false, may_enter: true });
  if (p === '/api/community/me/social') return ok({ following_users: [], following_stores: [], blocked: [], muted: [] });

  // ---- the desk
  if (p === '/api/admin/moderation/reports' && method === 'GET') {
    const state = u.searchParams.get('state') || 'open';
    const type = u.searchParams.get('type') || '';
    const rows = reports.filter((r) => (state === 'all' || r.state === state) && (!type || r.kind === type));
    const at = Number(u.searchParams.get('cursor') || 0);
    const page = rows.slice(at, at + 8);
    return ok({
      reports: page.map(({ kind, target_id, ...r }) => ({ ...r, target: target(kind, target_id) })),
      next_cursor: at + 8 < rows.length ? String(at + 8) : null,
    });
  }
  let m = /^\/api\/admin\/moderation\/reports\/([^/]+)$/.exec(p);
  if (m && method === 'POST') {
    const r = reports.find((x) => x.id === m![1]);
    if (!r) return refuse(404, 'MODERATION_TARGET_NOT_FOUND');
    r.state = String(body?.state);
    r.resolution = String(body?.resolution ?? '');
    return ok({ state: r.state });
  }
  m = /^\/api\/admin\/moderation\/users\/([^/]+)\/status$/.exec(p);
  if (m && method === 'POST') {
    const who = people[m[1]];
    if (!who) return refuse(404, 'MODERATION_TARGET_NOT_FOUND');
    if (m[1] === 'u_admin') return refuse(403, 'MODERATION_STAFF_TARGET');
    const step = String(body?.status);
    const level: Record<string, number> = { active: 0, restricted: 1, suspended: 2, banned: 3 };
    const next = step === 'restrict' ? 'restricted' : step === 'suspend' ? 'suspended' : step === 'ban' ? 'banned' : step === 'restore' ? 'active' : who.status;
    if (step !== 'warn' && step !== 'restore' && level[next] < level[who.status]) return refuse(409, 'MODERATION_LADDER');
    who.status = next;
    statusUntil[who.id] = (body?.until as string | null) ?? null;
    const r = reports.find((x) => x.id === body?.report_id);
    if (r) r.state = 'actioned';
    return ok({ action_id: `mod_${Date.now()}`, status: next, until: statusUntil[who.id], store: step === 'ban' && who.id === 'u_ali' ? { id: 's_ali', slug: 'ali3d', status: 'suspended' } : null });
  }
  m = /^\/api\/admin\/moderation\/(posts|comments|request-comments)\/([^/]+)\/hide$/.exec(p);
  if (m && method === 'POST') {
    const hidden = body?.hidden !== false;
    if (m[1] === 'posts') postHidden[m[2]] = hidden ? { at: new Date().toISOString(), reason: String(body?.reason ?? '') } : null;
    else commentState[m[2]] = hidden ? 'hidden' : 'visible';
    const r = reports.find((x) => x.id === body?.report_id);
    if (r) r.state = 'actioned';
    return ok({ hidden, action_id: `mod_${Date.now()}` });
  }
  if (p === '/api/admin/moderation/audit') {
    const t = u.searchParams.get('target_type') ?? 'user';
    return ok(history(t, u.searchParams.get('target_id') ?? ''));
  }
  if (p === '/api/admin/moderation/appeals' && method === 'GET') {
    const state = u.searchParams.get('state') || 'open';
    return ok({ appeals: appeals.filter((a) => state === 'all' || a.state === state), next_cursor: null });
  }
  m = /^\/api\/admin\/moderation\/appeals\/([^/]+)$/.exec(p);
  if (m && method === 'POST') {
    const a = appeals.find((x) => x.id === m![1]);
    if (!a) return refuse(404, 'APPEAL_NOT_FOUND');
    if (a.state !== 'open') return refuse(409, 'APPEAL_DECIDED');
    a.state = String(body?.state);
    a.decision = String(body?.decision ?? '');
    a.decided_at = new Date().toISOString();
    return ok({ state: a.state, restored: a.state === 'accepted', restore_action_id: a.state === 'accepted' ? 'mod_r' : null });
  }

  // ---- the dispute desk
  if (p === '/api/admin/community/complaints') {
    return ok({
      complaints: [
        { id: 'cmp_1', reporter_id: 'u_zain', reporter_name: 'زينب', merchant_id: 'm_ali', merchant_name: 'Ali 3D', community_order_id: 'co_7', order_id: null, category: 'order', description: 'الحامل أصغر من المتفق عليه بـ 2 سم، والتاجر يرفض الإرجاع.', status: 'under_review', priority: 'normal', resolution: '', created_at: ago(300), awaiting_reply: 1, chat_id: 'ch_1', request_id: 'req_9' },
        { id: 'cmp_2', reporter_id: 'u_r1', reporter_name: 'نور', merchant_id: 'm_x', merchant_name: 'Print Lab', community_order_id: null, order_id: 'o_5', category: 'order', description: 'الطلب لم يصل بعد عشرة أيام.', status: 'submitted', priority: 'urgent', resolution: '', created_at: ago(900), awaiting_reply: 1, chat_id: 'ch_2', request_id: null },
      ],
    });
  }
  m = /^\/api\/admin\/community\/complaints\/([^/]+)$/.exec(p);
  if (m && method === 'GET') {
    const id = m[1];
    return ok({
      complaint: { id, reporter_id: 'u_zain', reporter_name: 'زينب', merchant_id: 'm_ali', merchant_name: 'Ali 3D', community_order_id: id === 'cmp_1' ? 'co_7' : null, order_id: id === 'cmp_1' ? null : 'o_5', category: 'order', description: 'الحامل أصغر من المتفق عليه بـ 2 سم، والتاجر يرفض الإرجاع.', status: 'under_review', priority: 'normal', resolution: '', created_at: ago(300), chat_id: id === 'cmp_1' ? 'ch_1' : 'ch_2', request_id: id === 'cmp_1' ? 'req_9' : null },
      messages: [],
      escrow: null,
      escrow_events: [],
    });
  }

  // ---- the person's own door
  if (p === '/api/moderation/status') return ok({ standing, actions: decisions });
  if (p === '/api/moderation/appeals' && method === 'POST') {
    appealsFiled += 1;
    const d = decisions.find((x) => x.id === body?.action_id);
    if (!d || !d.appealable) return refuse(404, 'APPEAL_NOT_FOUND');
    if (appealsFiled > 1 && d.appeal) return refuse(409, 'APPEAL_EXISTS');
    const appeal = { id: `apl_${appealsFiled}`, state: 'open', body: String(body?.body ?? ''), decision: '', decided_at: null, created_at: new Date().toISOString(), action: { id: d.id, action: d.action, target_type: d.target_type, target_id: d.target_id, reason: d.reason, until: d.until, created_at: d.created_at } };
    d.appeal = { id: appeal.id, state: 'open', decision: '', decided_at: null, created_at: appeal.created_at };
    d.appealable = false;
    return ok({ appeal }, 201);
  }

  // ---- reputation
  if (p === '/api/community/badges') return ok({ badges: BADGE_RULES });
  if (p === '/api/merchant/reputation') return params.get('rep') === 'none' ? ok({ reputation: null }) : ok({ reputation: REPUTATION });

  // ---- the evidence thread
  if (p === '/api/chats/ch_1') return refused ? refuse(403, refused === 'closed' ? 'EVIDENCE_CLOSED' : 'EVIDENCE_NOT_LINKED') : ok({ chat: THREAD });
  if (p === '/api/chats/ch_1/messages' && method === 'GET') return refused ? refuse(403, refused === 'closed' ? 'EVIDENCE_CLOSED' : 'EVIDENCE_NOT_LINKED') : ok({ messages: MESSAGES, older_cursor: null, read_only: true });
  if (p === '/api/chats/ch_1/typing') return refuse(403, 'FORBIDDEN');

  // ---- the creator page
  if (p === '/api/community/creators/sara') {
    return ok({
      creator: {
        id: 'u_sara',
        username: 'sara',
        name: 'سارة كريم',
        avatarUrl: picture('#7a8c5a', 200, 200),
        bio: 'أطبع في البيت منذ 2021 — ألعاب مفصلية وقطع غيار لا تُباع.',
        website: '',
        socials: {},
        country: 'IQ',
        member_since: '2021-04-02T00:00:00Z',
        printers: ['Bambu Lab A1'],
        materials: ['PLA', 'PETG'],
        badges: { pro: true, premium: false, verified_merchant: true },
        stats: { projects: 8, completed_jobs: 31, followers: 41 },
        store: { id: 'm_sara', user_id: 'u_other', name: 'Sara Prints', bio: '', avatarUrl: null, verified: true, created_at: ago(90_000), store_slug: 'saraprints', store_url: '/community/store/saraprints', store_name: 'Sara Prints', tagline: 'قطع غيار ومجسمات', logoUrl: picture('#7a8c5a', 200, 200), governorate: 'baghdad', accepts_custom_requests: true, badge: 'trusted', rating: 4.9, rating_count: 17, completed_orders: 31, followers: 41, product_count: 12, following: false, badges: STORE_BADGES },
        viewer: { mine: false, following: false, blocked: false },
      },
    });
  }
  if (p === '/api/community/posts') return ok({ posts: [], next_cursor: null, total: 0 });
  if (p.startsWith('/api/wallet') || p.startsWith('/api/currency') || p.startsWith('/api/settings') || p.startsWith('/api/notifications') || p.startsWith('/api/admin/support')) return ok({});
  if (p.startsWith('/api/')) return refuse(404, 'NOT_STUBBED', `not stubbed: ${p}`);
  return realFetch(input, init);
}) as typeof window.fetch;

// ------------------------------------------------------------------ the storefront scene

const STORE = {
  id: 'st_ali',
  slug: 'ali3d',
  url: '/community/store/ali3d',
  name: 'Ali 3D',
  tagline: 'ورشة طباعة ثلاثية الأبعاد في بغداد',
  description: 'نطبع قطع الغيار والمجسمات بدقة عالية، ونوصل لكل العراق.',
  logoUrl: picture('#b08d3c', 200, 200),
  bannerUrl: picture('#6c7a4a', 1200, 500),
  accent: 'gold',
  categories: [],
  governorate: 'baghdad',
  service_areas: [],
  contact_phone: null,
  business_hours: [],
  policies: {},
  social_links: {},
  profile_links: [],
  profile_facts: [],
  profile_facts_configured: false,
  delivery_settings: {},
  accepts_custom_requests: true,
  sells_direct_products: true,
  workshop: { technologies: ['fdm', 'resin'], max_build_mm: { x: 256, y: 256, z: 300 }, turnaround_days: 3, custom_enabled: true },
  open: true,
  status: 'active',
  merchant: { id: 'm_ali', name: 'Ali 3D', verified: true, pro_badge: true, premium_badge: false, badge: 'trusted', rating: 4.8, rating_count: 23, completed_orders: 41, badges: params.get('badges') === '0' ? [] : STORE_BADGES },
  created_at: '2024-03-01T00:00:00.000Z',
  product_count: 12,
  followers: 87,
  positive_pct: 96,
  blocks_data: {},
} as unknown as StorefrontStore;
const LAYOUT = {
  schema_version: 1,
  theme: 'classic',
  blocks: [
    { id: 'hero', type: 'hero', variant: params.get('hero') ?? 'profile', settings: {} },
    { id: 'text', type: 'text', settings: { title: { ar: 'عن الورشة', en: 'About the workshop', ckb: 'دەربارەی وۆرکشۆپەکە' }, body: { ar: 'نطبع كل قطعة بعناية، ونرسل صورة قبل التسليم.', en: 'We print every part with care and send a photo before delivery.', ckb: 'هەموو پارچەیەک بە وردی چاپ دەکەین و پێش گەیاندن وێنەیەک دەنێرین.' } } },
  ],
};
const runtime = previewRuntime({ mode: 'live', routeHref: (r) => `#${r}`, productHref: (s) => `#p/${s}` });

/** Where a link went: a page that names its address. */
function Elsewhere() {
  const { pathname, search, hash } = useLocation();
  return (
    <main data-elsewhere={pathname + search + hash} className="p-6 text-text-primary">
      <p className="font-mono text-sm">{pathname + search + hash}</p>
    </main>
  );
}

const hash = params.get('hash') ? `#${params.get('hash')}` : '';
const start =
  scene === 'page'
    ? `/moderation${params.get('action') ? `?action=${params.get('action')}` : ''}`
    : scene === 'badges'
      ? `/community/badges${hash}`
      : scene === 'evidence'
        ? '/admin/chats/ch_1'
        : scene === 'creator'
          ? '/u/sara'
          : '/';

function Scene() {
  if (scene === 'desk') {
    return (
      <main data-scene="desk" className="mx-auto max-w-[1280px] p-4 text-text-primary md:p-5">
        <ModerationDesk />
      </main>
    );
  }
  if (scene === 'disputes') {
    return (
      <main data-scene="disputes" className="mx-auto max-w-[1280px] p-4 text-text-primary md:p-5">
        <ComplaintsDesk dir={lang === 'en' ? 'ltr' : 'rtl'} />
      </main>
    );
  }
  if (scene === 'reputation') {
    return (
      <main data-scene="reputation" className="mx-auto max-w-3xl p-4 text-text-primary">
        <ReputationCard />
      </main>
    );
  }
  if (scene === 'storefront') {
    return (
      <main data-scene="storefront">
        <StorefrontRuntimeProvider value={runtime}>
          <StoreRenderer store={STORE} layout={LAYOUT} className="min-h-screen pb-24" />
        </StorefrontRuntimeProvider>
      </main>
    );
  }
  return (
    <Routes>
      <Route path="/moderation" element={<ModerationPage />} />
      <Route path="/community/badges" element={<BadgesPage />} />
      <Route
        path="/admin/chats/:id"
        element={
          // The full-screen shell src/App.tsx gives /admin/*: the list is the one scroll region.
          <div className="h-[100dvh] min-h-0 flex flex-col font-sans overflow-hidden bg-canvas text-text-primary">
            <Chat />
          </div>
        }
      />
      <Route path="/u/:username" element={<CreatorPage />} />
      <Route path="*" element={<Elsewhere />} />
    </Routes>
  );
}

// The app's own provider order (src/App.tsx): Auth → Language → Wallet → Currency → Social.
createRoot(document.getElementById('root')!).render(
  <AuthProvider>
    <LanguageProvider>
      <WalletProvider>
        <CurrencyProvider>
          <MemoryRouter initialEntries={[start]}>
            <SocialProvider>
              <Scene />
              <Toaster />
            </SocialProvider>
          </MemoryRouter>
        </CurrencyProvider>
      </WalletProvider>
    </LanguageProvider>
  </AuthProvider>
);
