/**
 * THE MERCHANT FINANCE SCREEN AND THE ADMIN PAYOUT QUEUE, AS SHIPPED (W2-B).
 *
 * A browser fixture served only by a local `vite` dev server, never by
 * production: the real components, with `fetch` answering the real route
 * shapes (worker/routes/merchantFinance.ts, the admin queue) from fixed data.
 *
 *   /tests/browser/merchant-finance.html?lang=ar|en&view=merchant|admin[&sheet=1]
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider, useLanguage } from '../../src/LanguageContext';
import { Toaster } from '../../src/components/ui/Toast';
import MerchantFinance from '../../src/components/merchant/finance/MerchantFinance';
import PayoutQueue from '../../src/components/adminCommunity/PayoutQueue';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
try {
  localStorage.setItem('levo_lang', params.get('lang') === 'en' ? 'en' : 'ar');
} catch {
  /* Arabic, the default */
}

const day = (d: number) => new Date(Date.UTC(2026, 8, 24 - d, 9, 30)).toISOString();
const summary = {
  gross: 412_000, store_gross: 362_000, custom_gross: 50_000, commission: 20_600, delivery_fees: 24_000,
  refunds: 16_000, adjustments: 0, receivable: 399_400, pending: 61_300, pending_frozen: 15_300,
  available: 182_100, reserved: 60_000, paid_out: 96_000, escrow_held: 47_500, open_payouts: 1,
};
const entries = [
  { id: 'e1', kind: 'release', bucket: 'available', amount_iqd: 15300, note: '', created_at: day(0), link: { type: 'order', id: 'ORD-7F3A21C9' }, legacy: false },
  { id: 'e2', kind: 'release', bucket: 'pending', amount_iqd: -15300, note: '', created_at: day(0), link: { type: 'order', id: 'ORD-7F3A21C9' }, legacy: false },
  { id: 'e3', kind: 'payout', bucket: 'reserved', amount_iqd: 60000, note: '', created_at: day(1), link: { type: 'payout', id: 'mpo_1' }, legacy: false },
  { id: 'e4', kind: 'payout', bucket: 'available', amount_iqd: -60000, note: '', created_at: day(1), link: { type: 'payout', id: 'mpo_1' }, legacy: false },
  { id: 'e5', kind: 'sale_gross', bucket: 'pending', amount_iqd: 14000, note: '', created_at: day(2), link: { type: 'order', id: 'ORD-91BC04D2' }, legacy: false },
  { id: 'e6', kind: 'commission', bucket: 'pending', amount_iqd: -700, note: '', created_at: day(2), link: { type: 'order', id: 'ORD-91BC04D2' }, legacy: false },
  { id: 'e7', kind: 'delivery_fee', bucket: 'pending', amount_iqd: 2000, note: '', created_at: day(2), link: { type: 'order', id: 'ORD-91BC04D2' }, legacy: false },
  { id: 'e8', kind: 'escrow_release', bucket: 'available', amount_iqd: 50000, note: '', created_at: day(4), link: { type: 'custom_order', id: 'cord_58a1' }, legacy: false },
  { id: 'e9', kind: 'commission', bucket: 'available', amount_iqd: -2500, note: '', created_at: day(4), link: { type: 'custom_order', id: 'cord_58a1' }, legacy: false },
  { id: 'e10', kind: 'refund', bucket: 'pending', amount_iqd: -14000, note: '', created_at: day(6), link: { type: 'order', id: 'ORD-22EE1B07' }, legacy: false },
  { id: 'e11', kind: 'sale_gross', bucket: 'available', amount_iqd: 10000, note: '', created_at: day(20), link: { type: 'order', id: 'ORD-0A11C3F4' }, legacy: true },
];
const payouts = [
  { id: 'mpo_1', amount_iqd: 60000, state: 'requested', source: 'merchant', method: { channel: 'zaincash', label: 'زين كاش', account: '07701234567', holder: 'علي حسن' }, note: '', reference: '', decision_reason: '', created_at: day(1), updated_at: day(1), approved_at: null, paid_at: null, failed_at: null, cancelled_at: null },
  { id: 'mpo_0', amount_iqd: 96000, state: 'paid', source: 'merchant', method: { channel: 'ki_card', label: 'كي كارد', account: '6280112233445566', holder: '' }, note: '', reference: 'KI-448120', decision_reason: '', created_at: day(9), updated_at: day(8), approved_at: day(9), paid_at: day(8), failed_at: null, cancelled_at: null },
  { id: 'mpo_x', amount_iqd: 30000, state: 'failed', source: 'merchant', method: { channel: 'rafidain', label: 'مصرف الرافدين', account: '0012 3344', holder: '' }, note: '', reference: '', decision_reason: 'رقم الحساب غير صحيح', created_at: day(12), updated_at: day(11), approved_at: null, paid_at: null, failed_at: day(11), cancelled_at: null },
];
const methods = [
  { id: 'ki_card', name: 'كي كارد', requires_account: true },
  { id: 'rafidain', name: 'مصرف الرافدين', requires_account: true },
  { id: 'zaincash', name: 'زين كاش', requires_account: true },
  { id: 'cash_pickup', name: 'استلام كاش', requires_account: false },
];
const queue = [
  { ...payouts[0], merchant: { id: 'm1', name: 'Ali 3D', status: 'active', store_name: 'علي للطباعة', store_slug: 'ali3d', available_iqd: 182100, reserved_iqd: 60000 } },
  { ...payouts[0], id: 'mpo_2', state: 'approved', amount_iqd: 125000, method: { channel: 'ki_card', label: 'كي كارد', account: '6280112233445566', holder: 'Zainab K.' }, created_at: day(3), merchant: { id: 'm2', name: 'Zain Prints', status: 'restricted', store_name: 'Zain Prints', store_slug: 'zain', available_iqd: 4000, reserved_iqd: 125000 } },
];

const json = (body: unknown) => new Response(JSON.stringify({ success: true, ...(body as object) }), { status: 200, headers: { 'content-type': 'application/json' } });
window.fetch = async (input: RequestInfo | URL) => {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  await new Promise((r) => setTimeout(r, 60));
  if (url.includes('/api/merchant/finance/summary')) return json({ summary });
  if (url.includes('/api/merchant/finance/ledger')) {
    const kind = new URL(url, location.origin).searchParams.get('kind');
    return json({ entries: kind ? entries.filter((e) => e.kind === kind) : entries, next_cursor: kind ? null : 'x|y' });
  }
  if (url.includes('/api/merchant/payouts')) return json({ buckets: {}, methods, payouts, next_cursor: null });
  if (url.includes('/api/merchant/orders/')) return json({ order: { total_iqd: 16000, platform_fee_iqd: 700, merchant_receivable_iqd: 15300, credit_state: 'available' } });
  if (url.includes('/api/admin/community/payouts')) return json({ payouts: queue, next_cursor: null });
  return json({});
};

function App() {
  const { loc } = useLanguage();
  const admin = params.get('view') === 'admin';
  const t = (a: string, b: string) => loc(a, b);
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-300">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-4 pb-16">
        {admin ? <PayoutQueue t={t} /> : <MerchantFinance onOpenOrder={() => undefined} onOpenCustomOrders={() => undefined} />}
      </div>
      <Toaster />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <LanguageProvider>
    <MemoryRouter>
      <App />
    </MemoryRouter>
  </LanguageProvider>
);
