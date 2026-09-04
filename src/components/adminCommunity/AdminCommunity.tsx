/**
 * Platform administration of LEVO Community.
 *
 * Seven sections, one for each thing an admin actually has to do: see the
 * shape of the marketplace, act on a merchant, moderate the request board,
 * settle a dispute, move money, review standing and ratings, and set the
 * rules.
 *
 * TWO THINGS SHAPE EVERY SCREEN HERE.
 *
 * Suspending is not deleting. Nothing in this file removes a merchant, an
 * order, a review or a payout row. A suspended merchant stops trading and
 * keeps their whole history — and so do their customers, because punishing a
 * merchant must not erase what someone else bought (§46).
 *
 * A settlement is a decision on the record. Releasing or refunding a disputed
 * escrow appends events; it never edits amounts. So every money control here
 * asks for a REASON before it will act, and shows the full escrow event log
 * next to the decision rather than a summary of it (§45).
 *
 * These endpoints answer 404 on any merchant subdomain. This component is only
 * ever mounted inside the platform admin, on the apex host.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Loader2, Search, BadgeCheck, Ban, ShieldCheck, Store, AlertTriangle, Wallet,
  Scale, Settings2, TrendingUp, ChevronLeft, Check, ClipboardList, Star, Printer,
} from 'lucide-react';
import { ApiError } from '../../lib/api';
import PrintPricingAdmin from './PrintPricingAdmin';
import { newIdempotencyKey } from '../../lib/api';
import {
  adminCommunityApi, iqd, badgeLabel,
  type CommunityOverview, type AdminMerchantRow, type AdminComplaintRow,
  type AdminRequestRow, type AdminReviewRow, type AdminReputation,
} from '../../lib/merchant';

type Section =
  | 'overview' | 'merchants' | 'board' | 'disputes' | 'finance' | 'reputation' | 'settings' | 'print';

export default function AdminCommunity({ dir }: { dir: 'ltr' | 'rtl' }) {
  const rtl = dir === 'rtl';
  const t = (ar: string, en: string) => (rtl ? ar : en);
  const [section, setSection] = useState<Section>('overview');

  const SECTIONS: Array<{ id: Section; label: string; icon: React.ElementType }> = [
    { id: 'overview', label: t('نظرة عامة', 'Overview'), icon: TrendingUp },
    { id: 'merchants', label: t('التجار والمتاجر', 'Merchants & stores'), icon: Store },
    { id: 'board', label: t('الطلبات والعروض', 'Requests & offers'), icon: ClipboardList },
    { id: 'disputes', label: t('النزاعات والشكاوى', 'Disputes'), icon: Scale },
    { id: 'finance', label: t('الأموال', 'Money'), icon: Wallet },
    { id: 'reputation', label: t('التقييمات والسمعة', 'Reviews & reputation'), icon: Star },
    { id: 'settings', label: t('الإعدادات', 'Settings'), icon: Settings2 },
    /* The numbers behind every print estimate. They live here rather than in
       the code because the price of a kilo of PETG in Baghdad is not a
       constant — the owner changes it, and the next quote follows. */
    { id: 'print', label: t('تسعير الطباعة', 'Print pricing'), icon: Printer },
  ];

  return (
    <div className="text-white">
      <div className="flex gap-1.5 overflow-x-auto hide-scrollbar mb-6 pb-1">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            className={`shrink-0 flex items-center gap-2 px-4 min-h-[42px] rounded-2xl text-[13px] font-semibold border transition-colors ${
              section === s.id
                ? 'bg-olive text-white border-olive'
                : 'bg-zinc-800/40 text-zinc-400 border-zinc-700/50'
            }`}
          >
            <s.icon className="w-4 h-4" />
            {s.label}
          </button>
        ))}
      </div>

      {section === 'overview' && <Overview t={t} />}
      {section === 'merchants' && <Merchants t={t} />}
      {section === 'board' && <Board t={t} />}
      {section === 'disputes' && <Disputes t={t} />}
      {section === 'finance' && <Finance t={t} />}
      {section === 'reputation' && <Reputation t={t} />}
      {section === 'settings' && <SettingsSection t={t} />}
      {section === 'print' && <PrintPricingAdmin dir={dir} />}
    </div>
  );
}

type T = (ar: string, en: string) => string;

// ---------------------------------------------------------------- overview

function Overview({ t }: { t: T }) {
  const [d, setD] = useState<CommunityOverview | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    adminCommunityApi
      .overview()
      .then(setD)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'error'));
  }, []);

  if (err) return <Err text={err} />;
  if (!d) return <Spin />;

  // Escrow by state, because "how much money is the platform holding right
  // now" is the first question an operator asks and the hardest to get from
  // a list of orders.
  const held = d.escrows.find((e) => e.state === 'held');
  const disputed = d.escrows.find((e) => e.state === 'disputed');

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-gold font-bold text-[13px] mb-3">{t('الأموال المحتجزة الآن', 'Money held right now')}</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat
            label={t('محتجز في الضمان', 'In escrow')}
            value={iqd(held?.total ?? 0)}
            sub={t(`${held?.n ?? 0} طلب`, `${held?.n ?? 0} orders`)}
            accent
          />
          <Stat
            label={t('متنازع عليه', 'Disputed')}
            value={iqd(disputed?.total ?? 0)}
            sub={t(`${disputed?.n ?? 0} طلب`, `${disputed?.n ?? 0} orders`)}
            danger={!!disputed?.n}
          />
          <Stat label={t('إجمالي المبيعات', 'Gross volume')} value={iqd(d.orders.gross)} />
          <Stat label={t('عمولة المنصة', 'Platform fees')} value={iqd(d.orders.fees)} accent />
        </div>
      </div>

      <div>
        <h3 className="text-gold font-bold text-[13px] mb-3">{t('المجتمع', 'The community')}</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat
            label={t('التجار', 'Merchants')}
            value={String(d.merchants.total)}
            sub={t(
              `${d.merchants.verified} موثّق · ${d.merchants.suspended} موقوف`,
              `${d.merchants.verified} verified · ${d.merchants.suspended} suspended`
            )}
          />
          <Stat
            label={t('المتاجر', 'Stores')}
            value={`${d.stores.active}/${d.stores.total}`}
            sub={t('نشط', 'active')}
          />
          <Stat
            label={t('المنتجات', 'Products')}
            value={`${d.products.active}/${d.products.total}`}
            sub={t('منشور', 'published')}
          />
          <Stat
            label={t('الطلبات المفتوحة', 'Open requests')}
            value={String(d.requests.open)}
            sub={t(`${d.offers.total} عرض`, `${d.offers.total} offers`)}
          />
        </div>
      </div>

      {d.complaints.open > 0 && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
          <p className="text-amber-200 text-[13px]">
            {t(
              `${d.complaints.open} شكوى تنتظر المراجعة.`,
              `${d.complaints.open} complaints are waiting for review.`
            )}
          </p>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------- merchants

function Merchants({ t }: { t: T }) {
  const [rows, setRows] = useState<AdminMerchantRow[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState<AdminMerchantRow | null>(null);

  const load = useCallback(() => {
    adminCommunityApi.merchants(q).then((d) => setRows(d.merchants)).catch(() => setRows([]));
  }, [q]);
  useEffect(load, [load]);

  if (open) return <MerchantDetail merchant={open} t={t} onBack={() => { setOpen(null); load(); }} />;
  if (rows === null) return <Spin />;

  async function act(m: AdminMerchantRow, fn: () => Promise<unknown>) {
    setBusy(m.id);
    try {
      await fn();
      load();
    } catch (e) {
      if (e instanceof ApiError) alert(e.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="w-4 h-4 text-zinc-500 absolute start-3 top-1/2 -translate-y-1/2" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('ابحث باسم التاجر أو المتجر', 'Search by merchant or store name')}
          className="w-full min-h-[44px] rounded-2xl bg-zinc-800/40 border border-zinc-700/50 ps-10 pe-4 text-white text-[13px] outline-none focus:border-gold/40"
        />
      </div>

      {!rows.length && <Empty text={t('لا يوجد تجار', 'No merchants')} />}

      {rows.map((m) => (
        <div key={m.id} className="rounded-2xl border border-zinc-700/50 bg-zinc-800/30 p-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <button onClick={() => setOpen(m)} className="min-w-0 text-start">
              <div className="flex items-center gap-1.5">
                <span className="text-white font-semibold text-[14px] truncate">{m.name}</span>
                {!!m.verified && <BadgeCheck className="w-4 h-4 text-gold shrink-0" />}
              </div>
              <p className="text-zinc-500 text-[11.5px] truncate">
                {m.store_slug ? `${m.store_slug}.levonis-iq.com` : t('لا يوجد متجر', 'no store')} · {m.owner_email}
              </p>
              <div className="flex items-center gap-2 mt-1 text-[11px]">
                <span className="text-gold/80">{badgeLabel(m.badge_override || m.badge, (ar, en) => t(ar, en))}</span>
                {!!m.rating_count && (
                  <span className="text-zinc-500">
                    {(m.rating_avg_x100 / 100).toFixed(1)} ★ ({m.rating_count})
                  </span>
                )}
                <span className="text-zinc-500">
                  {t(`${m.completed_orders} مكتمل`, `${m.completed_orders} completed`)}
                </span>
              </div>
            </button>
            <StatusPill status={m.status} t={t} />
          </div>

          <div className="flex flex-wrap gap-2">
            <Act
              label={m.verified ? t('إلغاء التوثيق', 'Unverify') : t('توثيق', 'Verify')}
              icon={<ShieldCheck className="w-3.5 h-3.5" />}
              disabled={busy === m.id}
              onClick={() => act(m, () => adminCommunityApi.verify(m.id, !m.verified))}
            />
            {m.status !== 'suspended' ? (
              <Act
                label={t('إيقاف', 'Suspend')}
                icon={<Ban className="w-3.5 h-3.5" />}
                danger
                disabled={busy === m.id}
                onClick={() => {
                  // A reason is required. A suspension nobody can explain
                  // later is a suspension that gets reversed by whoever asks
                  // loudest.
                  const reason = window.prompt(t('سبب الإيقاف (مطلوب):', 'Reason for suspension (required):'));
                  if (!reason?.trim()) return;
                  act(m, () => adminCommunityApi.setStatus(m.id, 'suspended', reason.trim()));
                }}
              />
            ) : (
              <Act
                label={t('إعادة التفعيل', 'Restore')}
                icon={<Check className="w-3.5 h-3.5" />}
                disabled={busy === m.id}
                onClick={() => act(m, () => adminCommunityApi.setStatus(m.id, 'active', ''))}
              />
            )}
            <Act
              label={t('تقييد', 'Restrict')}
              disabled={busy === m.id || m.status === 'restricted'}
              onClick={() => {
                const reason = window.prompt(t('سبب التقييد (مطلوب):', 'Reason for restriction (required):'));
                if (!reason?.trim()) return;
                act(m, () => adminCommunityApi.setStatus(m.id, 'restricted', reason.trim()));
              }}
            />
            {/* Shutting a STOREFRONT is a different sanction from shutting
                its merchant: a bad banner should not cancel work the merchant
                already owes other customers. */}
            {m.store_id && (m.store_status === 'suspended' ? (
              <Act
                label={t('إعادة فتح المتجر', 'Re-open store')}
                icon={<Store className="w-3.5 h-3.5" />}
                disabled={busy === m.id}
                onClick={() => act(m, () => adminCommunityApi.setStoreStatus(m.store_id!, 'active', ''))}
              />
            ) : (
              <Act
                label={t('إيقاف المتجر فقط', 'Suspend store only')}
                icon={<Store className="w-3.5 h-3.5" />}
                danger
                disabled={busy === m.id}
                onClick={() => {
                  const reason = window.prompt(
                    t('سبب إيقاف المتجر (مطلوب):', 'Reason for suspending the store (required):')
                  );
                  if (!reason?.trim()) return;
                  act(m, () => adminCommunityApi.setStoreStatus(m.store_id!, 'suspended', reason.trim()));
                }}
              />
            ))}
          </div>

          {m.status_reason && (
            <p className="text-amber-300/80 text-[11.5px] mt-2">
              {t('سبب حالة التاجر', 'Merchant status reason')}: {m.status_reason}
            </p>
          )}
          {m.store_status === 'suspended' && m.store_status_reason && (
            <p className="text-amber-300/80 text-[11.5px] mt-1">
              {t('سبب إيقاف المتجر', 'Store suspension reason')}: {m.store_status_reason}
            </p>
          )}
          {m.store_status === 'paused' && (
            <p className="text-zinc-500 text-[11.5px] mt-1">
              {t('المتجر متوقف مؤقتًا بقرار التاجر نفسه.', 'The merchant has paused their own shop.')}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function MerchantDetail({ merchant, t, onBack }: { merchant: AdminMerchantRow; t: T; onBack: () => void }) {
  const [fin, setFin] = useState<Awaited<ReturnType<typeof adminCommunityApi.finance>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [rep, setRep] = useState(false);

  const load = useCallback(() => {
    adminCommunityApi.finance(merchant.id).then(setFin).catch(() => {});
  }, [merchant.id]);
  useEffect(load, [load]);

  async function payout() {
    const raw = window.prompt(
      t(
        `المبلغ المراد تحويله (المتاح: ${fin?.balance.available_iqd ?? 0} د.ع):`,
        `Amount to pay out (available: ${fin?.balance.available_iqd ?? 0} IQD):`
      )
    );
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) return;
    const note = window.prompt(t('ملاحظة (طريقة التحويل، المرجع):', 'Note (method, reference):')) ?? '';

    setBusy(true);
    try {
      // Idempotent: a double submit records one payout, not two.
      const r = await adminCommunityApi.payout(merchant.id, amount, note, newIdempotencyKey());
      if (r.replayed) alert(t('هذه العملية مسجّلة مسبقًا.', 'That payout was already recorded.'));
      load();
    } catch (e) {
      if (e instanceof ApiError) alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  // A merchant with no reviews yet is unreachable from the ratings list, and
  // that is exactly the merchant whose standing an admin most often has to
  // check before verifying them.
  if (rep) return <MerchantReputation id={merchant.id} name={merchant.name} t={t} onBack={() => setRep(false)} />;

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-zinc-400 text-[13px]">
        <ChevronLeft className="w-4 h-4 rtl:rotate-180" />
        {t('رجوع', 'Back')}
      </button>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-white font-bold text-[15px]">{merchant.name}</h3>
          <p className="text-zinc-500 text-[12px] truncate">{merchant.owner_email}</p>
        </div>
        <Act
          label={t('السمعة والتقييمات', 'Reputation')}
          icon={<Star className="w-3.5 h-3.5" />}
          onClick={() => setRep(true)}
        />
      </div>

      {!fin ? (
        <Spin />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Stat label={t('متاح', 'Available')} value={iqd(fin.balance.available_iqd)} accent />
            <Stat label={t('معلّق', 'Pending')} value={iqd(fin.balance.pending_iqd)} />
            <Stat label={t('مدفوع', 'Paid out')} value={iqd(Math.abs(fin.balance.paid_iqd))} />
          </div>

          <button
            onClick={payout}
            disabled={busy || fin.balance.available_iqd <= 0}
            className="w-full min-h-[46px] rounded-2xl bg-olive text-white font-bold text-[13.5px] flex items-center justify-center gap-2 disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wallet className="w-4 h-4" />}
            {t('تسجيل تحويل للتاجر', 'Record a payout')}
          </button>
          <p className="text-zinc-600 text-[11px] -mt-2">
            {t(
              'يُسجَّل التحويل كحركة سالبة في السجل — الرصيد يظل مجموع الحركات ولا يُعدَّل يدويًا.',
              'A payout is recorded as a negative ledger entry — the balance stays a sum of entries and is never edited by hand.'
            )}
          </p>

          <Section title={t('الضمانات', 'Escrows')}>
            {!fin.escrows.length ? (
              <p className="text-zinc-500 text-[12.5px]">{t('لا توجد', 'None')}</p>
            ) : (
              <div className="space-y-2">
                {fin.escrows.map((e) => (
                  <div key={e.id} className="flex items-center justify-between gap-3 text-[12.5px]">
                    <span className="text-zinc-400 truncate" dir="ltr">{e.community_order_id}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <EscrowPill state={e.state} t={t} />
                      <span className="text-white font-semibold" dir="ltr">{iqd(e.gross_iqd)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title={t('سجل الحركات', 'Ledger')}>
            {!fin.ledger.length ? (
              <p className="text-zinc-500 text-[12.5px]">{t('لا توجد حركات', 'No entries')}</p>
            ) : (
              <div className="space-y-1.5">
                {fin.ledger.slice(0, 40).map((l) => (
                  <div key={String(l.id)} className="flex items-center justify-between gap-3 text-[12px]">
                    <span className="text-zinc-400 truncate">
                      {String(l.kind)} · {String(l.state)}
                    </span>
                    <span
                      className={`font-semibold shrink-0 ${Number(l.amount_iqd) < 0 ? 'text-zinc-500' : 'text-gold'}`}
                      dir="ltr"
                    >
                      {Number(l.amount_iqd) < 0 ? '−' : '+'}
                      {iqd(Math.abs(Number(l.amount_iqd)))}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------- requests & offers

const REQUEST_STATES = [
  '', 'open', 'receiving_offers', 'offer_selected', 'in_progress',
  'delivered', 'completed', 'disputed', 'cancelled', 'expired',
] as const;

function requestStateLabel(s: string, t: T): string {
  switch (s) {
    case '': return t('الكل', 'All');
    case 'draft': return t('مسودة', 'Draft');
    case 'open': return t('مفتوح', 'Open');
    case 'receiving_offers': return t('يستقبل عروضًا', 'Receiving offers');
    case 'offer_selected': return t('تم اختيار عرض', 'Offer selected');
    case 'in_progress': return t('قيد التنفيذ', 'In progress');
    case 'delivered': return t('تم التسليم', 'Delivered');
    case 'completed': return t('مكتمل', 'Completed');
    case 'disputed': return t('نزاع', 'Disputed');
    case 'cancelled': return t('ملغي', 'Cancelled');
    case 'expired': return t('منتهي', 'Expired');
    default: return s;
  }
}

/**
 * The request board, moderated.
 *
 * The public board hides who is asking (§24). This one names them, because an
 * admin answering "who posted this and what became of it" cannot do it from
 * an anonymous list — and this screen only ever loads on the apex host, where
 * the API answers at all.
 */
function Board({ t }: { t: T }) {
  const [rows, setRows] = useState<AdminRequestRow[] | null>(null);
  const [state, setState] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    adminCommunityApi.requests(state, q).then((d) => setRows(d.requests)).catch(() => setRows([]));
  }, [state, q]);
  useEffect(load, [load]);

  if (open) return <RequestDetail id={open} t={t} onBack={() => { setOpen(null); load(); }} />;

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="w-4 h-4 text-zinc-500 absolute start-3 top-1/2 -translate-y-1/2" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('ابحث بعنوان الطلب أو رقمه', 'Search by request title or id')}
          className="w-full min-h-[44px] rounded-2xl bg-zinc-800/40 border border-zinc-700/50 ps-10 pe-4 text-white text-[13px] outline-none focus:border-gold/40"
        />
      </div>

      <div className="flex gap-1.5 overflow-x-auto hide-scrollbar pb-1">
        {REQUEST_STATES.map((s) => (
          <button
            key={s || 'all'}
            onClick={() => setState(s)}
            className={`shrink-0 min-h-[34px] px-3 rounded-xl text-[12px] font-semibold border transition-colors ${
              state === s
                ? 'bg-olive text-white border-olive'
                : 'bg-zinc-800/40 text-zinc-400 border-zinc-700/50'
            }`}
          >
            {requestStateLabel(s, t)}
          </button>
        ))}
      </div>

      {rows === null && <Spin />}
      {rows !== null && !rows.length && <Empty text={t('لا توجد طلبات', 'No requests')} />}

      {rows?.map((r) => (
        <button
          key={r.id}
          onClick={() => setOpen(r.id)}
          className="w-full text-start rounded-2xl border border-zinc-700/50 bg-zinc-800/30 p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-white font-semibold text-[14px] truncate">{r.title}</p>
              <p className="text-zinc-500 text-[11.5px] truncate">
                {r.customer_name || r.customer_email} · {r.governorate || t('غير محدد', 'no location')}
              </p>
            </div>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 border-zinc-600/40 bg-zinc-700/20 text-zinc-300">
              {requestStateLabel(r.state, t)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[11.5px]">
            <span className="text-gold font-semibold">
              {t(`${r.offers_pending} عرض قيد الانتظار`, `${r.offers_pending} pending offers`)}
            </span>
            <span className="text-zinc-500">
              {t(`${r.offers_total} إجمالي`, `${r.offers_total} total`)}
            </span>
            {r.budget_iqd ? (
              <span className="text-zinc-400" dir="ltr">{t('الميزانية', 'Budget')} {iqd(r.budget_iqd)}</span>
            ) : null}
            {r.community_order_id && (
              <span className="text-emerald-400/80">{t('يوجد طلب مرتبط', 'Has an order')}</span>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}

function RequestDetail({ id, t, onBack }: { id: string; t: T; onBack: () => void }) {
  const [d, setD] = useState<Awaited<ReturnType<typeof adminCommunityApi.request>> | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    adminCommunityApi
      .request(id)
      .then(setD)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'error'));
  }, [id]);
  useEffect(load, [load]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    try {
      await fn();
      load();
    } catch (e) {
      if (e instanceof ApiError) alert(e.message);
    } finally {
      setBusy('');
    }
  }

  if (err) return <Err text={err} />;
  if (!d) return <Spin />;

  const r = d.request as Record<string, string | number | null>;
  const state = String(r.state ?? '');
  // A request with work under way or money settled is not something to sweep
  // off the board — that is a dispute decision, and the API refuses it here
  // too. The button is absent rather than disabled-with-a-tooltip.
  const removable = !['completed', 'in_progress', 'delivered'].includes(state);

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-zinc-400 text-[13px]">
        <ChevronLeft className="w-4 h-4 rtl:rotate-180" />
        {t('رجوع', 'Back')}
      </button>

      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-white font-bold text-[15px]">{String(r.title ?? '')}</h3>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-zinc-600/40 bg-zinc-700/20 text-zinc-300">
            {requestStateLabel(state, t)}
          </span>
        </div>
        <p className="text-zinc-500 text-[12px]">
          {String(r.customer_name ?? '')} · {String(r.customer_email ?? '')}
        </p>
      </div>

      {!!String(r.description ?? '') && (
        <Section title={t('الوصف', 'Description')}>
          <p className="text-zinc-300 text-[12.5px] whitespace-pre-wrap">{String(r.description)}</p>
        </Section>
      )}

      <Section title={t('التفاصيل', 'Details')}>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
          <Field label={t('الفئة', 'Category')} value={String(r.category || '—')} />
          <Field label={t('الكمية', 'Quantity')} value={String(r.quantity ?? 1)} />
          <Field label={t('المادة', 'Material')} value={String(r.material || '—')} />
          <Field label={t('اللون', 'Colour')} value={String(r.color || '—')} />
          <Field label={t('الأبعاد', 'Dimensions')} value={String(r.dimensions || '—')} />
          <Field label={t('المحافظة', 'Governorate')} value={String(r.governorate || '—')} />
          <Field label={t('الميزانية', 'Budget')} value={r.budget_iqd ? iqd(Number(r.budget_iqd)) : '—'} />
          <Field label={t('الموعد النهائي', 'Deadline')} value={String(r.deadline || '—')} />
        </div>
      </Section>

      {!!d.files.length && (
        <Section title={t('المرفقات', 'Attachments')}>
          {/* File keys are never sent to a browser (§67) — an admin sees what
              exists, not how to address the bucket. */}
          <div className="space-y-1.5">
            {d.files.map((f) => (
              <div key={f.id} className="flex items-center justify-between gap-3 text-[12px]">
                <span className="text-zinc-300 truncate">{f.file_name}</span>
                <span className="text-zinc-600 shrink-0" dir="ltr">
                  {f.kind} · {Math.round(f.size_bytes / 1024)} KB
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title={t(`العروض (${d.offers.length})`, `Offers (${d.offers.length})`)}>
        {!d.offers.length ? (
          <p className="text-zinc-500 text-[12.5px]">{t('لا توجد عروض', 'No offers')}</p>
        ) : (
          <div className="space-y-3">
            {d.offers.map((o) => (
              <div key={o.id} className="rounded-xl border border-zinc-700/40 bg-zinc-900/40 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-white font-semibold text-[13px] truncate">{o.merchant_name}</span>
                      {!!o.verified && <BadgeCheck className="w-3.5 h-3.5 text-gold shrink-0" />}
                    </div>
                    <p className="text-zinc-500 text-[11px] truncate">
                      {o.store_slug ? `${o.store_slug}.levonis-iq.com` : t('لا يوجد متجر', 'no store')}
                      {o.merchant_status !== 'active' && ` · ${o.merchant_status}`}
                    </p>
                  </div>
                  <div className="text-end shrink-0">
                    <p className="text-gold font-bold text-[13.5px]" dir="ltr">{iqd(o.price_iqd)}</p>
                    <p className="text-zinc-600 text-[10.5px]">
                      {t(`${o.completion_days} يوم`, `${o.completion_days} days`)}
                    </p>
                  </div>
                </div>

                {!!o.message && (
                  <p className="text-zinc-400 text-[12px] mt-2 whitespace-pre-wrap">{o.message}</p>
                )}

                <div className="flex items-center justify-between gap-3 mt-2.5">
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-zinc-600/40 bg-zinc-700/20 text-zinc-300">
                    {offerStateLabel(o.state, t)}
                  </span>
                  {o.state === 'pending' && (
                    <Act
                      label={t('رفض العرض', 'Reject offer')}
                      icon={<Ban className="w-3.5 h-3.5" />}
                      danger
                      disabled={busy === o.id}
                      onClick={() => {
                        const reason = window.prompt(t('سبب الرفض (مطلوب):', 'Reason for rejecting (required):'));
                        if (!reason?.trim()) return;
                        act(o.id, () => adminCommunityApi.rejectOffer(o.id, reason.trim()));
                      }}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {d.order && (
        <Section title={t('الطلب والأموال', 'The order and the money')}>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <Stat label={t('السعر', 'Price')} value={iqd(Number(d.order.price_iqd ?? 0))} />
            <Stat label={t('عمولة المنصة', 'Platform fee')} value={iqd(Number(d.order.platform_fee_iqd ?? 0))} accent />
            <Stat label={t('للتاجر', 'To merchant')} value={iqd(Number(d.order.merchant_receivable_iqd ?? 0))} />
          </div>
          {d.escrow ? (
            <div className="flex items-center justify-between gap-3 text-[12.5px]">
              <span className="text-zinc-400">{t('حالة الضمان', 'Escrow state')}</span>
              <EscrowPill state={d.escrow.state} t={t} />
            </div>
          ) : (
            <p className="text-zinc-500 text-[12.5px]">{t('لا يوجد ضمان بعد', 'No escrow yet')}</p>
          )}
          <p className="text-zinc-600 text-[11px] mt-2">
            {t(
              'تحرير الأموال أو إرجاعها يتم من قسم النزاعات، مع سبب مسجَّل.',
              'Releasing or refunding is done from the Disputes section, with a recorded reason.'
            )}
          </p>
        </Section>
      )}

      {removable && (
        <div>
          <Act
            label={t('إزالة الطلب من اللوحة', 'Remove request from the board')}
            icon={<Ban className="w-3.5 h-3.5" />}
            danger
            disabled={busy === 'remove'}
            onClick={() => {
              const reason = window.prompt(t('سبب الإزالة (مطلوب):', 'Reason for removal (required):'));
              if (!reason?.trim()) return;
              act('remove', async () => {
                await adminCommunityApi.removeRequest(id, reason.trim());
                onBack();
              });
            }}
          />
          <p className="text-zinc-600 text-[11px] mt-2">
            {t(
              'الإزالة تُلغي الطلب ولا تحذفه — يبقى في السجل مع سببه.',
              'Removal cancels the request; nothing is deleted. It stays on the record with its reason.'
            )}
          </p>
        </div>
      )}
    </div>
  );
}

function offerStateLabel(s: string, t: T): string {
  switch (s) {
    case 'pending': return t('قيد الانتظار', 'Pending');
    case 'accepted': return t('مقبول', 'Accepted');
    case 'rejected': return t('مرفوض', 'Rejected');
    case 'withdrawn': return t('مسحوب', 'Withdrawn');
    case 'expired': return t('منتهي', 'Expired');
    case 'superseded': return t('مُستبدل', 'Superseded');
    default: return s;
  }
}

// --------------------------------------------------- reviews & reputation

/**
 * Ratings moderation and the standing behind them.
 *
 * Hidden reviews are listed and marked rather than filtered away: a merchant
 * appealing "you hid my review" cannot be answered from a list that no longer
 * contains it. Hiding recomputes the merchant's rating server-side, so the
 * score always matches the reviews a visitor can actually read (§40).
 */
function Reputation({ t }: { t: T }) {
  const [rows, setRows] = useState<AdminReviewRow[] | null>(null);
  const [hidden, setHidden] = useState('');
  const [maxRating, setMaxRating] = useState(5);
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(() => {
    adminCommunityApi
      .reviews({ hidden, maxRating })
      .then((d) => setRows(d.reviews))
      .catch(() => setRows([]));
  }, [hidden, maxRating]);
  useEffect(load, [load]);

  if (open) return <MerchantReputation id={open.id} name={open.name} t={t} onBack={() => { setOpen(null); load(); }} />;

  async function toggle(rv: AdminReviewRow) {
    setBusy(rv.id);
    try {
      await adminCommunityApi.hideReview(rv.id, !rv.hidden);
      load();
    } catch (e) {
      if (e instanceof ApiError) alert(e.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {[
          { v: '', label: t('الكل', 'All') },
          { v: '0', label: t('المنشورة', 'Visible') },
          { v: '1', label: t('المخفية', 'Hidden') },
        ].map((f) => (
          <button
            key={f.v || 'all'}
            onClick={() => setHidden(f.v)}
            className={`min-h-[34px] px-3 rounded-xl text-[12px] font-semibold border transition-colors ${
              hidden === f.v ? 'bg-olive text-white border-olive' : 'bg-zinc-800/40 text-zinc-400 border-zinc-700/50'
            }`}
          >
            {f.label}
          </button>
        ))}
        <span className="w-px bg-zinc-700/50 mx-1" />
        {[5, 3, 2].map((n) => (
          <button
            key={n}
            onClick={() => setMaxRating(n)}
            className={`min-h-[34px] px-3 rounded-xl text-[12px] font-semibold border transition-colors ${
              maxRating === n ? 'bg-olive text-white border-olive' : 'bg-zinc-800/40 text-zinc-400 border-zinc-700/50'
            }`}
          >
            {n === 5 ? t('كل التقييمات', 'Any rating') : t(`${n} نجوم فأقل`, `${n}★ and below`)}
          </button>
        ))}
      </div>

      {rows === null && <Spin />}
      {rows !== null && !rows.length && <Empty text={t('لا توجد تقييمات', 'No reviews')} />}

      {rows?.map((rv) => (
        <div
          key={rv.id}
          className={`rounded-2xl border p-4 ${
            rv.hidden ? 'border-amber-500/25 bg-amber-500/[0.05]' : 'border-zinc-700/50 bg-zinc-800/30'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <button
                onClick={() => setOpen({ id: rv.merchant_id, name: rv.merchant_name })}
                className="text-white font-semibold text-[13.5px] truncate hover:text-gold transition-colors"
              >
                {rv.merchant_name}
              </button>
              <p className="text-zinc-500 text-[11.5px] truncate">
                {rv.customer_name || rv.customer_email} ·{' '}
                {rv.community_order_id ? t('طلب مجتمع', 'community order') : t('طلب متجر', 'store order')}
              </p>
            </div>
            <div className="shrink-0 text-end">
              <p className="text-gold font-bold text-[13px]">{'★'.repeat(rv.rating)}<span className="text-zinc-700">{'★'.repeat(5 - rv.rating)}</span></p>
              {!!rv.hidden && (
                <span className="text-amber-300 text-[10px] font-bold">{t('مخفي', 'Hidden')}</span>
              )}
            </div>
          </div>

          {!!rv.body && <p className="text-zinc-300 text-[12.5px] mt-2 whitespace-pre-wrap">{rv.body}</p>}
          {!!rv.merchant_reply && (
            <p className="text-zinc-400 text-[12px] mt-2 ps-3 border-s-2 border-zinc-700">
              <span className="text-zinc-500">{t('رد التاجر', 'Merchant reply')}: </span>
              {rv.merchant_reply}
            </p>
          )}

          <div className="flex items-center justify-between gap-3 mt-3">
            <span className="text-zinc-600 text-[11px]">
              {t(
                `متوسط التاجر ${(rv.rating_avg_x100 / 100).toFixed(1)} من ${rv.rating_count}`,
                `Merchant averages ${(rv.rating_avg_x100 / 100).toFixed(1)} over ${rv.rating_count}`
              )}
              {rv.edited_count > 0 && t(` · عُدّل ${rv.edited_count} مرة`, ` · edited ${rv.edited_count}×`)}
            </span>
            <Act
              label={rv.hidden ? t('إظهار', 'Unhide') : t('إخفاء', 'Hide')}
              danger={!rv.hidden}
              disabled={busy === rv.id}
              onClick={() => toggle(rv)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

const BADGES = ['', 'new', 'trusted', 'professional', 'elite'] as const;

function MerchantReputation({
  id, name, t, onBack,
}: { id: string; name: string; t: T; onBack: () => void }) {
  const [d, setD] = useState<AdminReputation | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    adminCommunityApi
      .reputation(id)
      .then(setD)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'error'));
  }, [id]);
  useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      load();
    } catch (e) {
      if (e instanceof ApiError) alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (err) return <Err text={err} />;
  if (!d) return <Spin />;

  const total = d.breakdown.reduce((n, b) => n + b.n, 0);

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-zinc-400 text-[13px]">
        <ChevronLeft className="w-4 h-4 rtl:rotate-180" />
        {t('رجوع', 'Back')}
      </button>

      <h3 className="text-white font-bold text-[15px]">{name}</h3>

      <div className="grid grid-cols-3 gap-3">
        <Stat
          label={t('المتوسط', 'Average')}
          value={total ? (Number(d.merchant.rating_avg_x100 ?? 0) / 100).toFixed(1) : '—'}
          sub={t(`${total} تقييم`, `${total} reviews`)}
          accent
        />
        <Stat label={t('طلبات مكتملة', 'Completed')} value={String(d.merchant.completed_orders ?? 0)} />
        <Stat label={t('نقاط السمعة', 'Reputation points')} value={String(d.reputation_points)} />
      </div>

      <Section title={t('الشارة', 'Badge')}>
        {/* The earned badge and the override are shown side by side on
            purpose: pinning one should be a decision made in full view of
            what the published criteria already award (§42). */}
        <div className="flex items-center justify-between gap-3 text-[12.5px] mb-3">
          <span className="text-zinc-400">{t('المستحقة بالمعايير', 'Earned by the criteria')}</span>
          <span className="text-white font-semibold">{badgeLabel(d.earned_badge, (ar, en) => t(ar, en))}</span>
        </div>
        <div className="flex items-center justify-between gap-3 text-[12.5px] mb-3">
          <span className="text-zinc-400">{t('المثبتة إداريًا', 'Pinned by an admin')}</span>
          <span className={d.badge_override ? 'text-gold font-semibold' : 'text-zinc-600'}>
            {d.badge_override ? badgeLabel(d.badge_override, (ar, en) => t(ar, en)) : t('لا شيء', 'none')}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {BADGES.map((b) => (
            <Act
              key={b || 'clear'}
              label={b ? badgeLabel(b, (ar, en) => t(ar, en)) : t('إلغاء التثبيت', 'Clear override')}
              disabled={busy || d.badge_override === b}
              onClick={() => act(() => adminCommunityApi.setBadge(id, b))}
            />
          ))}
        </div>
        <p className="text-zinc-600 text-[11px] mt-2">
          {t(
            'إلغاء التثبيت يعيد التاجر إلى الشارة التي تستحقها معاييره تلقائيًا.',
            'Clearing the override returns the merchant to the badge their record earns.'
          )}
        </p>
      </Section>

      <Section title={t('توزيع التقييمات', 'Rating breakdown')}>
        {!total ? (
          <p className="text-zinc-500 text-[12.5px]">{t('لا توجد تقييمات ظاهرة', 'No visible reviews')}</p>
        ) : (
          <div className="space-y-1.5">
            {[5, 4, 3, 2, 1].map((star) => {
              const n = d.breakdown.find((b) => b.rating === star)?.n ?? 0;
              return (
                <div key={star} className="flex items-center gap-2 text-[11.5px]">
                  <span className="text-zinc-500 w-6 shrink-0" dir="ltr">{star}★</span>
                  <div className="flex-1 h-2 rounded-full bg-zinc-800 overflow-hidden">
                    <div className="h-full bg-gold/70" style={{ width: `${total ? (n / total) * 100 : 0}%` }} />
                  </div>
                  <span className="text-zinc-500 w-8 text-end shrink-0" dir="ltr">{n}</span>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title={t('سجل السمعة', 'Reputation log')}>
        <button
          onClick={() => {
            const raw = window.prompt(
              t('النقاط (موجبة أو سالبة):', 'Points (positive or negative):')
            );
            const points = Number(raw);
            if (!Number.isFinite(points) || points === 0) return;
            const note = window.prompt(t('السبب (مطلوب):', 'Reason (required):'));
            if (!note?.trim()) return;
            act(() => adminCommunityApi.adjustReputation(id, Math.trunc(points), note.trim()));
          }}
          disabled={busy}
          className="w-full min-h-[42px] rounded-2xl border border-zinc-700/50 bg-zinc-800/40 text-zinc-300 text-[12.5px] font-semibold mb-3 disabled:opacity-40"
        >
          {t('إضافة تعديل إداري', 'Add an admin adjustment')}
        </button>
        <p className="text-zinc-600 text-[11px] mb-3">
          {t(
            'الخطأ في السمعة يُصحَّح بحدث جديد يُضاف، لا بتعديل حدث قديم أو حذفه.',
            'A mistaken reputation event is corrected by adding another event, never by editing or deleting the first.'
          )}
        </p>

        {!d.events.length ? (
          <p className="text-zinc-500 text-[12.5px]">{t('لا توجد أحداث', 'No events')}</p>
        ) : (
          <div className="space-y-1.5">
            {d.events.map((e) => (
              <div key={e.id} className="flex items-start justify-between gap-3 text-[12px]">
                <div className="min-w-0">
                  <span className="text-zinc-300">{reputationKindLabel(e.kind, t)}</span>
                  {!!e.note && <p className="text-zinc-600 text-[11px] truncate">{e.note}</p>}
                </div>
                <span
                  className={`font-semibold shrink-0 ${e.points < 0 ? 'text-red-300' : e.points > 0 ? 'text-emerald-400' : 'text-zinc-500'}`}
                  dir="ltr"
                >
                  {e.points > 0 ? '+' : ''}{e.points}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function reputationKindLabel(k: string, t: T): string {
  switch (k) {
    case 'order_completed': return t('طلب مكتمل', 'Order completed');
    case 'order_cancelled': return t('طلب ملغي', 'Order cancelled');
    case 'order_refunded': return t('طلب مُعاد', 'Order refunded');
    case 'review_received': return t('تقييم جديد', 'Review received');
    case 'dispute_opened': return t('فتح نزاع', 'Dispute opened');
    case 'dispute_won': return t('كسب النزاع', 'Dispute won');
    case 'dispute_lost': return t('خسر النزاع', 'Dispute lost');
    case 'on_time': return t('تسليم في الموعد', 'Delivered on time');
    case 'late': return t('تأخر التسليم', 'Delivered late');
    case 'offer_accepted': return t('قُبل عرضه', 'Offer accepted');
    case 'repeat_customer': return t('عميل متكرر', 'Repeat customer');
    case 'admin_adjustment': return t('تعديل إداري', 'Admin adjustment');
    default: return k;
  }
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-zinc-600 text-[11px]">{label}</p>
      <p className="text-zinc-300">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------- disputes

function Disputes({ t }: { t: T }) {
  const [rows, setRows] = useState<AdminComplaintRow[] | null>(null);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    adminCommunityApi.complaints(filter).then((d) => setRows(d.complaints)).catch(() => setRows([]));
  }, [filter]);
  useEffect(load, [load]);

  if (open) return <DisputeDetail id={open} t={t} onBack={() => { setOpen(null); load(); }} />;
  if (rows === null) return <Spin />;

  return (
    <div className="space-y-4">
      <div className="flex gap-1.5 overflow-x-auto hide-scrollbar pb-1">
        {['', 'submitted', 'under_review', 'resolved', 'rejected'].map((s) => (
          <button
            key={s || 'all'}
            onClick={() => setFilter(s)}
            className={`shrink-0 px-3.5 min-h-[36px] rounded-xl text-[12px] font-semibold border transition-colors ${
              filter === s ? 'bg-olive text-white border-olive' : 'bg-zinc-800/40 text-zinc-400 border-zinc-700/50'
            }`}
          >
            {s ? complaintStatusLabel(s, t) : t('الكل', 'All')}
          </button>
        ))}
      </div>

      {!rows.length && <Empty text={t('لا توجد شكاوى', 'No complaints')} />}

      {rows.map((c) => (
        <button
          key={c.id}
          onClick={() => setOpen(c.id)}
          className="w-full text-start rounded-2xl border border-zinc-700/50 bg-zinc-800/30 p-4"
        >
          <div className="flex items-start justify-between gap-3 mb-1.5">
            <span className="text-white font-semibold text-[13.5px]">
              {c.merchant_name ?? t('شكوى عامة', 'General complaint')}
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              {c.priority === 'urgent' && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-300">
                  {t('عاجل', 'Urgent')}
                </span>
              )}
              <ComplaintPill status={c.status} t={t} />
            </div>
          </div>
          <p className="text-zinc-400 text-[12.5px] line-clamp-2 leading-relaxed">{c.description}</p>
          <p className="text-zinc-600 text-[11px] mt-1.5">
            {t('من', 'From')}: {c.reporter_name} · {c.category}
          </p>
        </button>
      ))}
    </div>
  );
}

function DisputeDetail({ id, t, onBack }: { id: string; t: T; onBack: () => void }) {
  const [d, setD] = useState<Awaited<ReturnType<typeof adminCommunityApi.complaint>> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    adminCommunityApi.complaint(id).then(setD).catch(() => {});
  }, [id]);
  useEffect(load, [load]);

  async function settle(decision: 'release' | 'refund' | 'partial_refund') {
    if (!d?.escrow) return;
    // A reason is REQUIRED, and it goes on the record with the decision.
    const reason = window.prompt(
      t('سبب القرار (يُسجَّل بشكل دائم):', 'Reason for this decision (recorded permanently):')
    );
    if (!reason?.trim()) return;

    let amount: number | undefined;
    if (decision === 'partial_refund') {
      const raw = window.prompt(
        t(
          `المبلغ المُعاد للعميل (الإجمالي ${d.escrow.gross_iqd} د.ع):`,
          `Amount to refund to the customer (total ${d.escrow.gross_iqd} IQD):`
        )
      );
      amount = Number(raw);
      if (!Number.isFinite(amount) || amount <= 0 || amount > d.escrow.gross_iqd) return;
    }

    const confirmText =
      decision === 'release'
        ? t(
            `سيُدفع ${d.escrow.merchant_receivable_iqd} د.ع للتاجر نهائيًا. متابعة؟`,
            `${d.escrow.merchant_receivable_iqd} IQD will be paid to the merchant permanently. Continue?`
          )
        : decision === 'refund'
          ? t(
              `سيُعاد ${d.escrow.gross_iqd} د.ع للعميل بالكامل. متابعة؟`,
              `${d.escrow.gross_iqd} IQD will be returned to the customer in full. Continue?`
            )
          : t(`سيُعاد ${amount} د.ع للعميل. متابعة؟`, `${amount} IQD will be returned to the customer. Continue?`);
    if (!window.confirm(confirmText)) return;

    setBusy(true);
    try {
      const r = await adminCommunityApi.resolveEscrow(d.escrow.id, decision, reason.trim(), amount);
      if (r.replayed) alert(t('هذا القرار مسجّل مسبقًا.', 'That decision was already recorded.'));
      await adminCommunityApi.setComplaintStatus(id, 'resolved', `${decision}: ${reason.trim()}`);
      load();
    } catch (e) {
      if (e instanceof ApiError) alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!d) return <Spin />;
  const settled = d.escrow && !['held', 'disputed'].includes(d.escrow.state);

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-zinc-400 text-[13px]">
        <ChevronLeft className="w-4 h-4 rtl:rotate-180" />
        {t('رجوع', 'Back')}
      </button>

      <Section title={t('الشكوى', 'The complaint')}>
        <p className="text-zinc-200 text-[13px] leading-relaxed whitespace-pre-wrap mb-3">{d.complaint.description}</p>
        <div className="flex flex-wrap gap-2 text-[11.5px] text-zinc-500">
          <span>{t('من', 'From')}: {d.complaint.reporter_name}</span>
          <span>·</span>
          <span>{d.complaint.category}</span>
          <span>·</span>
          <ComplaintPill status={d.complaint.status} t={t} />
        </div>
      </Section>

      {d.escrow && (
        <Section title={t('الأموال المحتجزة', 'The money')}>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <Stat label={t('الإجمالي', 'Gross')} value={iqd(d.escrow.gross_iqd)} />
            <Stat label={t('للتاجر', 'To merchant')} value={iqd(d.escrow.merchant_receivable_iqd)} accent />
            <Stat label={t('عمولة', 'Fee')} value={iqd(d.escrow.platform_fee_iqd)} />
          </div>

          {settled ? (
            <div className="rounded-2xl border border-zinc-700/50 bg-zinc-800/40 px-4 py-3">
              <p className="text-zinc-300 text-[12.5px]">
                {t('تمت التسوية:', 'Already settled:')} <EscrowPill state={d.escrow.state} t={t} />
              </p>
              <p className="text-zinc-600 text-[11.5px] mt-1">
                {t(
                  'لا يمكن تغيير تسوية منتهية — أي تصحيح يكون حركة جديدة.',
                  'A completed settlement cannot be changed — a correction is a new movement.'
                )}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <button
                onClick={() => settle('release')}
                disabled={busy}
                className="w-full min-h-[46px] rounded-2xl bg-olive text-white font-bold text-[13px] disabled:opacity-40"
              >
                {t('تحرير المبلغ للتاجر', 'Release to the merchant')}
              </button>
              <button
                onClick={() => settle('refund')}
                disabled={busy}
                className="w-full min-h-[46px] rounded-2xl border border-amber-500/40 bg-amber-500/10 text-amber-300 font-semibold text-[13px] disabled:opacity-40"
              >
                {t('إرجاع كامل للعميل', 'Refund the customer in full')}
              </button>
              <button
                onClick={() => settle('partial_refund')}
                disabled={busy}
                className="w-full min-h-[46px] rounded-2xl border border-zinc-700/50 bg-zinc-800/40 text-zinc-300 font-semibold text-[13px] disabled:opacity-40"
              >
                {t('إرجاع جزئي', 'Partial refund')}
              </button>
            </div>
          )}
        </Section>
      )}

      {/* The full event log, not a summary of it. A decision is made against
          the record. */}
      {!!d.escrow_events.length && (
        <Section title={t('سجل الضمان', 'Escrow event log')}>
          <div className="space-y-2">
            {d.escrow_events.map((e) => (
              <div key={String(e.id)} className="flex items-start justify-between gap-3 text-[12px]">
                <div className="min-w-0">
                  <p className="text-zinc-300">
                    {String(e.kind)} <span className="text-zinc-600">· {String(e.actor_role)}</span>
                  </p>
                  {!!e.reason && <p className="text-zinc-600 text-[11px] truncate">{String(e.reason)}</p>}
                </div>
                <span className="text-zinc-400 shrink-0" dir="ltr">
                  {Number(e.amount_iqd) ? iqd(Number(e.amount_iqd)) : '—'}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title={t('حالة الشكوى', 'Complaint status')}>
        <div className="flex flex-wrap gap-2">
          {['under_review', 'waiting_customer', 'waiting_merchant', 'resolved', 'rejected', 'closed'].map((s) => (
            <button
              key={s}
              disabled={busy}
              onClick={async () => {
                const note = window.prompt(t('ملاحظة (اختياري):', 'Note (optional):')) ?? '';
                setBusy(true);
                try {
                  await adminCommunityApi.setComplaintStatus(id, s, note);
                  load();
                } finally {
                  setBusy(false);
                }
              }}
              className="px-3 min-h-[36px] rounded-xl border border-zinc-700/50 bg-zinc-800/40 text-zinc-300 text-[12px] font-semibold disabled:opacity-40"
            >
              {complaintStatusLabel(s, t)}
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ----------------------------------------------------------------- finance

function Finance({ t }: { t: T }) {
  const [d, setD] = useState<CommunityOverview | null>(null);
  useEffect(() => {
    adminCommunityApi.overview().then(setD).catch(() => {});
  }, []);

  if (!d) return <Spin />;

  const total = d.escrows.reduce((a, e) => a + Number(e.total), 0);

  return (
    <div className="space-y-4">
      <Section title={t('الأموال حسب الحالة', 'Money by escrow state')}>
        {!d.escrows.length ? (
          <p className="text-zinc-500 text-[12.5px]">{t('لا توجد ضمانات', 'No escrows yet')}</p>
        ) : (
          <div className="space-y-2.5">
            {d.escrows.map((e) => (
              <div key={e.state} className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <EscrowPill state={e.state} t={t} />
                  <span className="text-zinc-500 text-[11.5px]">
                    {t(`${e.n} طلب`, `${e.n} orders`)}
                  </span>
                </div>
                <span className="text-white font-semibold text-[13px] shrink-0" dir="ltr">
                  {iqd(e.total)}
                </span>
              </div>
            ))}
            <div className="pt-2.5 mt-1 border-t border-zinc-700/50 flex items-center justify-between">
              <span className="text-zinc-400 text-[12.5px] font-semibold">{t('الإجمالي', 'Total')}</span>
              <span className="text-gold font-bold text-[14px]" dir="ltr">{iqd(total)}</span>
            </div>
          </div>
        )}
      </Section>

      <Section title={t('إيرادات المنصة', 'Platform revenue')}>
        <div className="grid grid-cols-2 gap-3">
          <Stat label={t('عمولة محقّقة', 'Commission earned')} value={iqd(d.orders.fees)} accent />
          <Stat label={t('حجم التداول', 'Gross volume')} value={iqd(d.orders.gross)} />
        </div>
        <p className="text-zinc-600 text-[11px] mt-3 leading-relaxed">
          {t(
            'كل طلب يحمل نسخة من نسبة العمولة وقت البيع. تغيير النسبة لا يُعيد حساب أي طلب سابق.',
            'Every order carries a snapshot of the commission rate at the time of sale. Changing the rate never recalculates a past order.'
          )}
        </p>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------- settings

function SettingsSection({ t }: { t: T }) {
  const [s, setS] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    adminCommunityApi.settings().then((d) => setS(d.settings)).catch(() => setS({}));
  }, []);

  if (!s) return <Spin />;

  const num = (k: string) => Number(s[k] ?? 0);

  async function save() {
    setSaving(true);
    setErr('');
    setSaved(false);
    try {
      await adminCommunityApi.saveSettings({
        communityFeeStorePercentX100: num('communityFeeStorePercentX100'),
        communityFeeRequestPercentX100: num('communityFeeRequestPercentX100'),
        communityFeeMinIqd: num('communityFeeMinIqd'),
        communityAutoCompleteDays: num('communityAutoCompleteDays'),
        communityRequestExpiryDays: num('communityRequestExpiryDays'),
      });
      setSaved(true);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'error');
    } finally {
      setSaving(false);
    }
  }

  const set = (k: string, v: string) => setS({ ...s, [k]: v });

  return (
    <div className="space-y-4">
      <Section title={t('العمولة', 'Commission')}>
        <div className="space-y-4">
          <PercentField
            label={t('عمولة مبيعات المتاجر', 'Direct store sales')}
            valueX100={num('communityFeeStorePercentX100')}
            onChange={(v) => set('communityFeeStorePercentX100', String(v))}
            t={t}
          />
          <PercentField
            label={t('عمولة الطلبات المخصصة', 'Custom request work')}
            valueX100={num('communityFeeRequestPercentX100')}
            onChange={(v) => set('communityFeeRequestPercentX100', String(v))}
            t={t}
          />
          <NumField
            label={t('حد أدنى للعمولة (د.ع)', 'Minimum fee (IQD)')}
            value={num('communityFeeMinIqd')}
            onChange={(v) => set('communityFeeMinIqd', String(v))}
          />
        </div>
        <p className="text-amber-300/80 text-[11.5px] mt-4 leading-relaxed">
          {t(
            'التغيير يسري على المعاملات الجديدة فقط. كل طلب سابق يحتفظ بنسبته المسجّلة وقت البيع.',
            'A change applies to NEW transactions only. Every past order keeps the rate recorded at the time of sale.'
          )}
        </p>
      </Section>

      <Section title={t('دورة حياة الطلب', 'Order lifecycle')}>
        <div className="space-y-4">
          <NumField
            label={t('أيام التأكيد قبل التحرير التلقائي', 'Days to confirm before auto-release')}
            value={num('communityAutoCompleteDays')}
            onChange={(v) => set('communityAutoCompleteDays', String(v))}
          />
          <p className="text-zinc-500 text-[11.5px] leading-relaxed -mt-2">
            {num('communityAutoCompleteDays') === 0
              ? t(
                  'القيمة 0 تعني: لا تحرير تلقائي إطلاقًا. الأموال لا تتحرك إلا بتأكيد إنسان.',
                  '0 means: no automatic release at all. Money only ever moves when a human confirms.'
                )
              : t(
                  'بعد تعليم التاجر للطلب كمُسلَّم، يملك العميل هذه المدة للتأكيد أو فتح نزاع.',
                  'After the merchant marks it delivered, the customer has this long to confirm or dispute.'
                )}
          </p>
          <NumField
            label={t('مدة صلاحية الطلب (أيام)', 'Request expiry (days)')}
            value={num('communityRequestExpiryDays')}
            onChange={(v) => set('communityRequestExpiryDays', String(v))}
          />
        </div>
      </Section>

      {err && <Err text={err} />}

      <button
        onClick={save}
        disabled={saving}
        className="w-full min-h-[48px] rounded-2xl bg-olive text-white font-bold text-[14px] flex items-center justify-center gap-2 disabled:opacity-40"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : null}
        {saved ? t('تم الحفظ', 'Saved') : t('حفظ الإعدادات', 'Save settings')}
      </button>
    </div>
  );
}

/**
 * A percentage the operator reads as a percentage.
 *
 * Stored in hundredths so the money split stays integer arithmetic; showing
 * "500" to someone setting a commission would be an invitation to type 5 and
 * charge 0.05%.
 */
function PercentField({
  label,
  valueX100,
  onChange,
  t,
}: {
  label: string;
  valueX100: number;
  onChange: (x100: number) => void;
  t: T;
}) {
  return (
    <div>
      <label className="block text-zinc-400 text-[12.5px] font-semibold mb-2">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="number"
          step="0.01"
          min="0"
          max="100"
          value={(valueX100 / 100).toFixed(2)}
          onChange={(e) => onChange(Math.round(Number(e.target.value) * 100))}
          className="flex-1 min-h-[46px] rounded-2xl bg-zinc-800/40 border border-zinc-700/50 px-4 text-white text-[14px] outline-none focus:border-gold/40"
          dir="ltr"
        />
        <span className="text-zinc-400 text-[14px] font-semibold w-6">%</span>
      </div>
      <p className="text-zinc-600 text-[11px] mt-1.5" dir="ltr">
        {t('مثال: 50,000 د.ع →', 'e.g. 50,000 IQD →')} {iqd(Math.floor((50000 * valueX100) / 10000))}{' '}
        {t('عمولة', 'fee')}
      </p>
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="block text-zinc-400 text-[12.5px] font-semibold mb-2">{label}</label>
      <input
        type="number"
        min="0"
        value={value}
        onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
        className="w-full min-h-[46px] rounded-2xl bg-zinc-800/40 border border-zinc-700/50 px-4 text-white text-[14px] outline-none focus:border-gold/40"
        dir="ltr"
      />
    </div>
  );
}

// ------------------------------------------------------------------- bits

function Spin() {
  return (
    <div className="py-12 flex justify-center">
      <Loader2 className="w-5 h-5 text-gold animate-spin" />
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-12 text-center text-zinc-500 text-[13px]">{text}</p>;
}

function Err({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3">
      <p className="text-red-300 text-[12.5px]">{text}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-zinc-700/50 bg-zinc-800/30 p-4">
      <h3 className="text-gold font-bold text-[13px] mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
  danger,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border p-3 ${
        danger ? 'border-red-500/30 bg-red-500/[0.06]' : 'border-zinc-700/50 bg-zinc-800/30'
      }`}
    >
      <p className="text-zinc-500 text-[11px] mb-1">{label}</p>
      <p
        className={`font-bold text-[15px] ${danger ? 'text-red-300' : accent ? 'text-gold' : 'text-white'}`}
        dir="ltr"
      >
        {value}
      </p>
      {sub && <p className="text-zinc-600 text-[10.5px] mt-0.5">{sub}</p>}
    </div>
  );
}

function Act({
  label,
  icon,
  onClick,
  danger,
  disabled,
}: {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`min-h-[36px] px-3 rounded-xl border text-[12px] font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-40 ${
        danger
          ? 'border-red-500/30 bg-red-500/10 text-red-300'
          : 'border-zinc-700/50 bg-zinc-800/40 text-zinc-300'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function StatusPill({ status, t }: { status: string; t: T }) {
  const map: Record<string, string> = {
    active: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    restricted: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    suspended: 'bg-red-500/10 text-red-300 border-red-500/20',
  };
  const label: Record<string, string> = {
    active: t('نشط', 'Active'),
    restricted: t('مقيّد', 'Restricted'),
    suspended: t('موقوف', 'Suspended'),
  };
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${map[status] ?? map.active}`}>
      {label[status] ?? status}
    </span>
  );
}

function EscrowPill({ state, t }: { state: string; t: T }) {
  const map: Record<string, string> = {
    held: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
    released: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    refunded: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
    partially_refunded: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    disputed: 'bg-red-500/10 text-red-300 border-red-500/20',
    pending: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
    cancelled: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  };
  const label: Record<string, string> = {
    held: t('محتجز', 'Held'),
    released: t('محرَّر', 'Released'),
    refunded: t('مُعاد', 'Refunded'),
    partially_refunded: t('مُعاد جزئيًا', 'Partly refunded'),
    disputed: t('نزاع', 'Disputed'),
    pending: t('قيد الإنشاء', 'Pending'),
    cancelled: t('ملغي', 'Cancelled'),
  };
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${map[state] ?? map.pending}`}>
      {label[state] ?? state}
    </span>
  );
}

function ComplaintPill({ status, t }: { status: string; t: T }) {
  const map: Record<string, string> = {
    submitted: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    under_review: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
    waiting_customer: 'bg-purple-500/10 text-purple-300 border-purple-500/20',
    waiting_merchant: 'bg-purple-500/10 text-purple-300 border-purple-500/20',
    resolved: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    rejected: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
    closed: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  };
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${map[status] ?? map.submitted}`}>
      {complaintStatusLabel(status, t)}
    </span>
  );
}

function complaintStatusLabel(s: string, t: T): string {
  switch (s) {
    case 'submitted': return t('جديدة', 'New');
    case 'under_review': return t('قيد المراجعة', 'Under review');
    case 'waiting_customer': return t('بانتظار العميل', 'Waiting on customer');
    case 'waiting_merchant': return t('بانتظار التاجر', 'Waiting on merchant');
    case 'resolved': return t('محلولة', 'Resolved');
    case 'rejected': return t('مرفوضة', 'Rejected');
    case 'closed': return t('مغلقة', 'Closed');
    default: return s;
  }
}
