/**
 * The courier panel: what is configured, the official status list, and the
 * owner's mapping from their statuses to ours.
 *
 * THE MAPPING IS THE WHOLE POINT OF THIS SCREEN. An Al-Waseet status nobody
 * has mapped moves no order — that is the safety rule, and it means an
 * unmapped list is not a broken integration, it is an integration waiting
 * for the one decision only the owner can make: what does "قيد التوصيل" mean
 * for OUR order. Until they say, orders sit still, which is the correct
 * behaviour and not a bug.
 *
 * NO CREDENTIAL EVER APPEARS HERE. The panel is told WHICH keys are missing,
 * by name, and nothing else — the values live in Worker secrets and no route
 * returns them.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, Loader2, RefreshCw, Truck } from 'lucide-react';
import { api, ApiError } from '../../lib/api';

interface StatusRow {
  provider: string;
  remote_id: string;
  remote_text: string;
  internal_stage: string;
  updated_at: string;
}

interface Config {
  provider: string;
  credentials_configured: boolean;
  missing_credentials: string[];
  wire: Record<string, unknown>;
  statuses_known: number;
  statuses_mapped: number;
}

/** The stages a courier status may sensibly mean. */
const MAPPABLE = [
  { stage: '', ar: '— غير مخرَّط —', en: '— unmapped —' },
  { stage: 'local_delivery_prep', ar: 'جارٍ تجهيز التوصيل المحلي', en: 'Preparing local delivery' },
  { stage: 'out_for_delivery', ar: 'في الطريق إليك', en: 'On the way to you' },
  { stage: 'delivered', ar: 'تم التوصيل', en: 'Delivered' },
  { stage: 'cancelled', ar: 'أُلغي الطلب', en: 'Cancelled' },
];

export default function AdminDelivery({ dir }: { dir: 'rtl' | 'ltr' }) {
  const ar = dir === 'rtl';
  const [config, setConfig] = useState<Config | null>(null);
  const [statuses, setStatuses] = useState<StatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [cfg, list] = await Promise.all([
        api.get<Config>('/api/admin/delivery/config'),
        api.get<{ statuses: StatusRow[] }>('/api/admin/delivery/statuses'),
      ]);
      setConfig(cfg);
      setStatuses(list.statuses ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshStatuses = async () => {
    setBusy('refresh');
    setError('');
    setNotice('');
    try {
      const res = await api.post<{ added: number; refreshed: number; statuses: StatusRow[] }>(
        '/api/admin/delivery/statuses/refresh'
      );
      setStatuses(res.statuses ?? []);
      setNotice(
        ar
          ? `تم جلب القائمة: ${res.added} جديدة، ${res.refreshed} محدَّثة`
          : `Fetched: ${res.added} new, ${res.refreshed} refreshed`
      );
      await load();
    } catch (e) {
      // The driver's own message — "not configured yet" naming what is
      // missing, or the courier's HTTP error. Never a generic failure.
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : '');
    } finally {
      setBusy('');
    }
  };

  const setMapping = async (remoteId: string, stage: string) => {
    setBusy(remoteId);
    setError('');
    try {
      const res = await api.put<{ statuses: StatusRow[] }>(`/api/admin/delivery/statuses/${encodeURIComponent(remoteId)}`, { stage });
      setStatuses(res.statuses ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '');
    } finally {
      setBusy('');
    }
  };

  const syncAll = async () => {
    setBusy('sync');
    setError('');
    setNotice('');
    try {
      const r = await api.post<{ scanned: number; moved: number; unmapped: number; errors: number }>('/api/admin/delivery/sync');
      setNotice(
        ar
          ? `فُحص ${r.scanned} طلب: تحرّك ${r.moved}، غير مخرَّط ${r.unmapped}، أخطاء ${r.errors}`
          : `${r.scanned} scanned: ${r.moved} moved, ${r.unmapped} unmapped, ${r.errors} errors`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-6" data-admin-delivery>
      <div>
        <h2 className="text-white font-bold text-lg flex items-center gap-2">
          <Truck className="w-5 h-5 text-[#BAA369]" aria-hidden />
          {ar ? 'التوصيل المحلي' : 'Local delivery'}
        </h2>
        <p className="text-zinc-400 text-xs mt-1 leading-relaxed">
          {ar
            ? 'حالة غير مخرَّطة لا تحرّك أي طلب. هذا مقصود: لا نخمّن معنى حالة لم تحددها.'
            : 'An unmapped status moves no order. That is deliberate — we do not guess what a status means.'}
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

      {loading ? (
        <p className="text-zinc-400 text-sm">{ar ? 'جارٍ التحميل…' : 'Loading…'}</p>
      ) : (
        <>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-zinc-400">{ar ? 'بيانات الدخول' : 'Credentials'}</span>
              <span className={config?.credentials_configured ? 'text-[#8fd07c] font-bold' : 'text-amber-400 font-bold'}>
                {config?.credentials_configured ? (ar ? 'مهيأة' : 'Configured') : (ar ? 'غير مهيأة' : 'Not configured')}
              </span>
            </div>
            {/* Names only, and only because an owner needs to know what to
                set. No route anywhere returns a credential's value. */}
            {!config?.credentials_configured && (config?.missing_credentials?.length ?? 0) > 0 && (
              <p className="text-zinc-400 text-xs flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" aria-hidden />
                <span dir="ltr" className="font-mono">{config?.missing_credentials.join(', ')}</span>
              </p>
            )}
            <div className="flex items-center justify-between gap-3">
              <span className="text-zinc-400">{ar ? 'الحالات المعروفة' : 'Statuses known'}</span>
              <span dir="ltr" className="text-white font-bold">{config?.statuses_known ?? 0}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-zinc-400">{ar ? 'المخرَّطة' : 'Mapped'}</span>
              <span dir="ltr" className="text-white font-bold">{config?.statuses_mapped ?? 0}</span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void refreshStatuses()}
              disabled={!!busy}
              className="inline-flex items-center gap-2 min-h-[44px] px-4 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-white text-[13px] font-bold disabled:opacity-60"
            >
              {busy === 'refresh' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <RefreshCw className="w-4 h-4" aria-hidden />}
              {ar ? 'جلب قائمة الحالات الرسمية' : 'Fetch official status list'}
            </button>
            <button
              type="button"
              onClick={() => void syncAll()}
              disabled={!!busy}
              className="inline-flex items-center gap-2 min-h-[44px] px-4 rounded-xl bg-[#BAA369] hover:bg-[#ffe55c] text-black text-[13px] font-bold disabled:opacity-60 transition-colors"
            >
              {busy === 'sync' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Truck className="w-4 h-4" aria-hidden />}
              {ar ? 'مزامنة حالة الوسيط' : 'Sync courier statuses'}
            </button>
          </div>

          {statuses.length === 0 ? (
            <p className="text-zinc-400 text-sm bg-zinc-900/50 border border-zinc-800 rounded-2xl p-6 text-center">
              {ar
                ? 'لم تُجلب قائمة الحالات بعد. اضغط «جلب قائمة الحالات الرسمية».'
                : 'The status list has not been fetched yet.'}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-zinc-800">
              <table className="w-full text-sm min-w-[560px]">
                <thead className="bg-zinc-900/70 text-zinc-400 text-[11px] uppercase tracking-wider">
                  <tr>
                    <th className="text-start p-3">{ar ? 'رقم الحالة' : 'Status id'}</th>
                    <th className="text-start p-3">{ar ? 'اسمها عندهم' : 'Their label'}</th>
                    <th className="text-start p-3">{ar ? 'تعني عندنا' : 'Means here'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {statuses.map((r) => (
                    <tr key={r.remote_id} className="text-zinc-300" data-status-row={r.remote_id}>
                      <td className="p-3 font-mono text-white" dir="ltr">{r.remote_id}</td>
                      <td className="p-3">{r.remote_text || '—'}</td>
                      <td className="p-3">
                        <select
                          value={r.internal_stage}
                          disabled={busy === r.remote_id}
                          onChange={(e) => void setMapping(r.remote_id, e.target.value)}
                          className={`bg-zinc-900 border rounded-xl px-3 py-2 text-sm focus:outline-none ${
                            r.internal_stage ? 'border-zinc-700 text-white' : 'border-amber-500/40 text-amber-300'
                          }`}
                        >
                          {MAPPABLE.map((m) => (
                            <option key={m.stage} value={m.stage}>
                              {ar ? m.ar : m.en}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
