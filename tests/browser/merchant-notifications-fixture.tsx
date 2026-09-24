/**
 * THE STORE'S NOTIFICATION CENTRE AND INBOX, as shipped, on canned answers.
 *
 * A browser fixture (served only by a local `vite`), for screenshots of the
 * W2-E components in Arabic and English at a phone and a desktop width:
 *
 *   /tests/browser/merchant-notifications.html?lang=ar|en[&view=inbox]
 *
 * `fetch` is answered here with the shapes worker/routes/merchantNotifications.ts
 * and merchantInbox.ts return — the components themselves are untouched.
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../src/LanguageContext';
import { Toaster } from '../../src/components/ui/Toast';
import MerchantNotificationCenter from '../../src/components/merchant/notifications/MerchantNotificationCenter';
import MerchantNotificationPreferences from '../../src/components/merchant/notifications/MerchantNotificationPreferences';
import MerchantNotificationBell from '../../src/components/merchant/notifications/MerchantNotificationBell';
import MerchantInbox from '../../src/components/merchant/inbox/MerchantInbox';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'ar';
localStorage.setItem('levo_lang', lang);
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
// The server isolates ids, codes and figures inside Arabic copy (worker/lib/merchantNotify.ts `iso`).
const iso = (s: string) => s.replace(/([A-Za-z][A-Za-z0-9_-]*[0-9][A-Za-z0-9_-]*|[0-9][0-9,.-]*)/g, '\u2068$1\u2069');
const N = (id: string, kind: string, ar: string, en: string, bar: string, ben: string, link: string, min: number, read = false) => ({
  id, kind, title_ar: iso(ar), title_en: en, body_ar: iso(bar), body_en: ben, link, entity_type: '', entity_id: '', read, created_at: ago(min),
});
let rows = [
  N('n1', 'new_order', 'طلب جديد في متجرك — ORD-7F3A21', 'New order in your store — ORD-7F3A21', 'الإجمالي 45,000 د.ع، مدفوع مسبقًا من محفظة الزبون. أكّده وجهّزه.', "Total 45,000 IQD, prepaid from the customer's wallet. Confirm and prepare it.", '/merchant/orders/ORD-7F3A21', 3),
  N('n2', 'new_message', 'رسالة جديدة من زبون', 'New message from a customer', 'بخصوص الطلب ORD-7F3A21', 'About order ORD-7F3A21', '/merchant/inbox/chat_1', 18),
  N('n3', 'dispute_opened', 'فتح الزبون شكوى على الطلب ORD-19C0DE', 'The customer opened a complaint on order ORD-19C0DE', 'يبقى مبلغ هذا الطلب معلّقًا حتى يغلق فريق Levonis الشكوى.', "This order's money stays on hold until the Levonis team closes the complaint.", '/merchant/orders/ORD-19C0DE', 95),
  N('n4', 'low_stock', 'المخزون ينفد: مزهرية حلزونية — أبيض', 'Running low: Spiral vase — White', 'بقي 2 (حد التنبيه 3). أعد التعبئة أو عدّل الكمية.', '2 left (alert at 3). Restock or update the quantity.', '/merchant/products/cp1', 60 * 26, true),
  N('n5', 'payout_available', 'صار 42,750 د.ع متاحًا في رصيدك', '42,750 IQD is now available in your balance', 'من الطلب ORD-55AA10. يمكنك طلب تحويله من «الأرباح».', 'From order ORD-55AA10. You can request a payout under Earnings.', '/merchant/money', 60 * 30, true),
  N('n6', 'coupon_ending', 'الكوبون SUMMER25 ينتهي في 2026-09-27', 'Coupon SUMMER25 ends on 2026-09-27', 'استُخدم 14 مرة. مدّده أو اتركه ينتهي.', 'Used 14 times. Extend it or let it end.', '/merchant/marketing/coupons/cpn_1', 60 * 72, true),
  N('n7', 'matching_request', 'طلب طباعة يناسب ورشتك', 'A print request that fits your workshop', 'PETG · 12 قطعة · بغداد', 'PETG · 12 parts · Baghdad', '/merchant/requests/req_1', 60 * 80),
];
const threads = [
  { id: 'chat_1', kind: 'order', context_id: 'ORD-7F3A21', order_id: 'ORD-7F3A21', customer: { name: 'سارة أحمد', username: 'sara' }, last_message: 'هل يمكن تغيير اللون إلى الأسود؟', last_message_at: ago(18), last_from: 'customer', unread: 2 },
  { id: 'chat_2', kind: 'direct', context_id: 'u2', order_id: null, customer: { name: 'Omar Najm', username: 'omar' }, last_message: 'Do you print in carbon fibre PETG?', last_message_at: ago(140), last_from: 'customer', unread: 1 },
  { id: 'chat_3', kind: 'request', context_id: 'req_1', order_id: null, customer: { name: 'زينب', username: 'zainab' }, last_message: 'تمام، أرسلت لك الملف', last_message_at: ago(60 * 27), last_from: 'store', unread: 0 },
];
const unread = () => rows.filter((r) => !r.read).length;
const json = (b: unknown) => new Response(JSON.stringify({ success: true, ...(b as object) }), { headers: { 'content-type': 'application/json' } });
const prefs = { new_orders: true, request_opportunities: true, new_messages: true, new_reviews: true, low_stock: true, payouts: false, complaints: true, system_alerts: true, marketing: true, new_followers: true, subscription_expiry: true };
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  const p = url.pathname;
  if (p === '/api/merchant/notifications/feed') {
    const list = url.searchParams.get('unread') ? rows.filter((r) => !r.read) : rows;
    return json({ unread: unread(), unread_by_kind: {}, notifications: list, next_cursor: null });
  }
  if (p === '/api/merchant/notifications/unread-count') return json({ unread: unread(), unread_by_kind: {} });
  if (p === '/api/merchant/notifications/read') {
    const id = JSON.parse(String(init?.body ?? '{}')).id;
    rows = rows.map((r) => (!id || r.id === id ? { ...r, read: true } : r));
    return json({ marked: 1, unread: unread(), unread_by_kind: {} });
  }
  if (p === '/api/merchant/notifications') {
    return json({ preferences: prefs, forced: ['complaints', 'subscription_expiry', 'system_alerts'], wired: ['new_orders', 'request_opportunities', 'new_messages', 'new_reviews', 'low_stock', 'payouts', 'complaints', 'system_alerts', 'marketing'] });
  }
  if (p === '/api/merchant/inbox') return json({ threads, next_cursor: null });
  return new Response(JSON.stringify({ success: false }), { status: 404 });
};

function Page() {
  const view = params.get('view');
  return (
    <div className="min-h-screen bg-canvas px-4 py-5 text-text-primary sm:px-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-center justify-between">
          <span className="text-[15px] font-bold">Ali 3D</span>
          <MerchantNotificationBell onOpen={() => undefined} />
        </div>
        {view === 'inbox' ? (
          <MerchantInbox />
        ) : (
          <>
            <MerchantNotificationCenter />
            <MerchantNotificationPreferences />
          </>
        )}
      </div>
      <Toaster />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <LanguageProvider>
    <MemoryRouter initialEntries={['/merchant/notifications']}>
      <Page />
    </MemoryRouter>
  </LanguageProvider>
);
