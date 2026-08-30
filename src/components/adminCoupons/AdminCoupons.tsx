/**
 * The coupon panel — the half of the promo-code feature that never existed.
 *
 * The engine has been in the schema since migration 0002: tiers, date
 * windows, global and per-user limits, fixed and percentage discounts, all
 * enforced server-side at checkout. What was missing was any way to CREATE a
 * code, so the storefront's promo box had nothing to accept and shipped
 * disabled with "قريباً" on it.
 *
 * The CODE is not editable after creation. Customers have it written down and
 * placed orders reference it in their snapshots; renaming would break the
 * first and orphan the second. Deactivating is the way out — and there is no
 * delete at all, because an order that says "SAVE10 was applied" must still
 * be able to say what SAVE10 was.
 */
import { useCallback, useEffect, useState } from 'react';
import { Plus, Ticket, Power, Loader2, Check } from 'lucide-react';
import { api } from '../../lib/api';

interface CouponRow {
  id: string;
  code: string;
  tier_required: string | null;
  kind: 'fixed_iqd' | 'percent';
  value: number;
  min_total_iqd: number;
  starts_at: string | null;
  ends_at: string | null;
  max_global: number | null;
  max_per_user: number;
  active: number;
  redeemed: number;
  created_at: string;
}

const BLANK = {
  code: '',
  kind: 'percent' as 'percent' | 'fixed_iqd',
  value: '10',
  min_total_iqd: '0',
  tier_required: '',
  starts_at: '',
  ends_at: '',
  max_global: '',
  max_per_user: '1',
};

const input =
  'w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-[#BAA369] transition-colors';
const label = 'block text-zinc-400 text-[10px] font-bold mb-1.5 uppercase tracking-wider';

export default function AdminCoupons({ dir }: { dir: 'rtl' | 'ltr' }) {
  const ar = dir === 'rtl';
  const [rows, setRows] = useState<CouponRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState({ ...BLANK });
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.get<{ coupons: CouponRow[] }>('/api/admin/coupons');
      setRows(data.coupons ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api.post('/api/admin/coupons', {
        code: form.code,
        kind: form.kind,
        value: Number(form.value),
        min_total_iqd: Number(form.min_total_iqd || 0),
        tier_required: form.tier_required || undefined,
        starts_at: form.starts_at ? new Date(form.starts_at).toISOString() : undefined,
        ends_at: form.ends_at ? new Date(form.ends_at).toISOString() : undefined,
        max_global: form.max_global === '' ? null : Number(form.max_global),
        max_per_user: Number(form.max_per_user || 1),
      });
      setNotice(ar ? 'تم إنشاء الكود' : 'Coupon created');
      setForm({ ...BLANK });
      await load();
    } catch (err) {
      // The server's own message — a duplicate code, an out-of-range
      // percentage, a window that closes before it opens.
      setError(err instanceof Error ? err.message : '');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (row: CouponRow) => {
    setBusyId(row.id);
    setError('');
    try {
      if (row.active) {
        await api.delete(`/api/admin/coupons/${row.id}`);
      } else {
        await api.patch(`/api/admin/coupons/${row.id}`, {
          kind: row.kind,
          value: row.value,
          min_total_iqd: row.min_total_iqd,
          tier_required: row.tier_required ?? undefined,
          starts_at: row.starts_at ?? undefined,
          ends_at: row.ends_at ?? undefined,
          max_global: row.max_global,
          max_per_user: row.max_per_user,
          active: true,
        });
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '');
    } finally {
      setBusyId('');
    }
  };

  const discountText = (r: CouponRow) =>
    r.kind === 'percent' ? `${r.value}%` : `${r.value.toLocaleString('en-US')} IQD`;

  return (
    <div className="space-y-6" data-admin-coupons>
      <div>
        <h2 className="text-white font-bold text-lg flex items-center gap-2">
          <Ticket className="w-5 h-5 text-[#BAA369]" aria-hidden />
          {ar ? 'أكواد الخصم' : 'Promo codes'}
        </h2>
        <p className="text-zinc-400 text-xs mt-1">
          {ar
            ? 'الكود يُطبَّق عند إتمام الطلب ويُتحقق منه على الخادم — لا يمكن تعديل الكود بعد إنشائه، ويمكن تعطيله فقط.'
            : 'Codes are applied and validated at checkout, server-side. A code cannot be renamed after creation — deactivate it instead.'}
        </p>
      </div>

      {error && (
        <div role="alert" className="bg-[#B03142]/10 border border-[#B03142]/40 text-[#e4899a] text-xs rounded-2xl p-3">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="bg-[#59A846]/10 border border-[#59A846]/40 text-[#8fd07c] text-xs rounded-2xl p-3 flex items-center gap-2">
          <Check className="w-4 h-4" aria-hidden /> {notice}
        </div>
      )}

      <form onSubmit={create} className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2">
          <label className={label} htmlFor="cpn-code">{ar ? 'الكود' : 'Code'}</label>
          <input
            id="cpn-code"
            dir="ltr"
            required
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
            placeholder="SAVE10"
            className={`${input} font-mono`}
          />
        </div>
        <div>
          <label className={label} htmlFor="cpn-kind">{ar ? 'نوع الخصم' : 'Discount type'}</label>
          <select id="cpn-kind" value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as 'percent' | 'fixed_iqd' }))} className={input}>
            <option value="percent">{ar ? 'نسبة %' : 'Percentage %'}</option>
            <option value="fixed_iqd">{ar ? 'مبلغ ثابت (د.ع)' : 'Fixed amount (IQD)'}</option>
          </select>
        </div>
        <div>
          <label className={label} htmlFor="cpn-value">{ar ? 'القيمة' : 'Value'}</label>
          <input id="cpn-value" dir="ltr" type="number" min={1} max={form.kind === 'percent' ? 100 : undefined} required
            value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} className={input} />
        </div>
        <div>
          <label className={label} htmlFor="cpn-min">{ar ? 'أقل مبلغ للسلة' : 'Minimum cart'}</label>
          <input id="cpn-min" dir="ltr" type="number" min={0} value={form.min_total_iqd}
            onChange={(e) => setForm((f) => ({ ...f, min_total_iqd: e.target.value }))} className={input} />
        </div>
        <div>
          <label className={label} htmlFor="cpn-tier">{ar ? 'يتطلب عضوية' : 'Requires tier'}</label>
          <select id="cpn-tier" value={form.tier_required} onChange={(e) => setForm((f) => ({ ...f, tier_required: e.target.value }))} className={input}>
            <option value="">{ar ? 'الجميع' : 'Anyone'}</option>
            <option value="plus">PLUS</option>
            <option value="pro">PRO</option>
            {/* PRIME could not even be stored before migration 0029: the
                column's CHECK predated the tier. */}
            <option value="prime">PRIME</option>
          </select>
        </div>
        <div>
          <label className={label} htmlFor="cpn-starts">{ar ? 'يبدأ' : 'Starts'}</label>
          <input id="cpn-starts" type="datetime-local" value={form.starts_at}
            onChange={(e) => setForm((f) => ({ ...f, starts_at: e.target.value }))} className={input} />
        </div>
        <div>
          <label className={label} htmlFor="cpn-ends">{ar ? 'ينتهي' : 'Ends'}</label>
          <input id="cpn-ends" type="datetime-local" value={form.ends_at}
            onChange={(e) => setForm((f) => ({ ...f, ends_at: e.target.value }))} className={input} />
        </div>
        <div>
          <label className={label} htmlFor="cpn-global">{ar ? 'حد الاستخدام الكلي' : 'Total uses'}</label>
          <input id="cpn-global" dir="ltr" type="number" min={1} placeholder={ar ? 'بلا حد' : 'Unlimited'}
            value={form.max_global} onChange={(e) => setForm((f) => ({ ...f, max_global: e.target.value }))} className={input} />
        </div>
        <div>
          <label className={label} htmlFor="cpn-user">{ar ? 'لكل مستخدم' : 'Per customer'}</label>
          <input id="cpn-user" dir="ltr" type="number" min={1} value={form.max_per_user}
            onChange={(e) => setForm((f) => ({ ...f, max_per_user: e.target.value }))} className={input} />
        </div>
        <div className="sm:col-span-2 lg:col-span-4 flex justify-end">
          <button type="submit" disabled={saving || !form.code.trim()}
            className="bg-[#BAA369] hover:bg-[#ffe55c] text-black font-bold text-sm px-5 py-3 rounded-xl flex items-center gap-2 disabled:opacity-60 transition-colors">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Plus className="w-4 h-4" aria-hidden />}
            {ar ? 'إنشاء الكود' : 'Create coupon'}
          </button>
        </div>
      </form>

      {loading ? (
        <p className="text-zinc-400 text-sm">{ar ? 'جارٍ التحميل…' : 'Loading…'}</p>
      ) : rows.length === 0 ? (
        <p className="text-zinc-400 text-sm bg-zinc-900/50 border border-zinc-800 rounded-2xl p-6 text-center">
          {ar ? 'لا توجد أكواد بعد.' : 'No coupons yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-zinc-800">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="bg-zinc-900/70 text-zinc-400 text-[11px] uppercase tracking-wider">
              <tr>
                <th className="text-start p-3">{ar ? 'الكود' : 'Code'}</th>
                <th className="text-start p-3">{ar ? 'الخصم' : 'Discount'}</th>
                <th className="text-start p-3">{ar ? 'أقل مبلغ' : 'Minimum'}</th>
                <th className="text-start p-3">{ar ? 'العضوية' : 'Tier'}</th>
                <th className="text-start p-3">{ar ? 'الاستخدام' : 'Used'}</th>
                <th className="text-start p-3">{ar ? 'الحالة' : 'Status'}</th>
                <th className="text-end p-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {rows.map((r) => (
                <tr key={r.id} className="text-zinc-300">
                  <td className="p-3 font-mono text-white" dir="ltr">{r.code}</td>
                  <td className="p-3" dir="ltr">{discountText(r)}</td>
                  <td className="p-3" dir="ltr">{r.min_total_iqd ? r.min_total_iqd.toLocaleString('en-US') : '—'}</td>
                  <td className="p-3 uppercase">{r.tier_required ?? '—'}</td>
                  <td className="p-3" dir="ltr">
                    {/* Counted from the redemption rows the checkout writes,
                        so it can never disagree with the orders. */}
                    {r.redeemed}
                    {r.max_global !== null ? ` / ${r.max_global}` : ''}
                  </td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${r.active ? 'bg-[#59A846]/15 text-[#8fd07c]' : 'bg-zinc-800 text-zinc-400'}`}>
                      {r.active ? (ar ? 'مفعّل' : 'Active') : (ar ? 'معطّل' : 'Off')}
                    </span>
                  </td>
                  <td className="p-3 text-end">
                    <button onClick={() => void toggle(r)} disabled={busyId === r.id}
                      className="inline-flex items-center gap-1.5 text-[11px] font-bold text-zinc-300 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5 disabled:opacity-60">
                      {busyId === r.id ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> : <Power className="w-3 h-3" aria-hidden />}
                      {r.active ? (ar ? 'تعطيل' : 'Disable') : (ar ? 'تفعيل' : 'Enable')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
