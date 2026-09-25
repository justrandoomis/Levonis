/**
 * «فحص فروقات التقريب» → the members whose balance drifted → «تطبيق التسوية».
 *
 * The owner's answer about balances that drifted a few dinars under the old
 * rounding: «صحّحها بتسوية مسجّلة». The server does all the arithmetic
 * (worker/lib/walletAdjust.ts); this screen only asks it, shows the answer and
 * sends the admin's typed confirmation back with the fingerprint of the list
 * they were shown — a list that changed in between is refused, never applied
 * blind. A second run finds nothing: every correction is subtracted from what
 * is still owed.
 *
 * Owner / financial scope only; the server refuses anyone else.
 */
import React, { useState } from 'react';
import { ScanSearch, TriangleAlert, CheckCircle2 } from 'lucide-react';
import { api, ApiError, formatIqd } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';

interface DriftMember {
  user_id: string;
  name: string;
  email: string;
  rows: Array<{ tx_id: string; kind: 'deposit' | 'withdrawal'; typed_iqd: number; ledger_iqd: number; owed_iqd: number }>;
  outstanding_iqd: number;
  balance_iqd: number;
  apply_iqd: number;
  capped: boolean;
  skipped_rows: number;
}
interface DriftScan {
  confirm_phrase: string;
  members: DriftMember[];
  total_credit_iqd: number;
  total_debit_iqd: number;
  fingerprint: string;
}
interface ApplyResult {
  results: Array<{ user_id: string; applied_iqd: number; status: string }>;
  /** Members left for another request (the server applies a page at a time). */
  remaining?: number;
}

/** Pages one press may apply before it stops and shows what is left. */
const MAX_APPLY_ROUNDS = 20;

const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatIqd(Math.abs(n))}`;

export default function RoundingDriftTool() {
  const { loc } = useLanguage();
  const { user } = useAuth();
  const [scan, setScan] = useState<DriftScan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phrase, setPhrase] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [notApplied, setNotApplied] = useState<Array<{ user_id: string; name: string; status: string }>>([]);

  if (user?.can_view_financials === false) return null;

  const check = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    setNotApplied([]);
    try {
      setScan(await api.get<DriftScan>('/api/admin/wallet-adjust/rounding-drift'));
      setPhrase('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!scan) return;
    setBusy(true);
    setError(null);
    setNotApplied([]);
    const names = new Map(scan.members.map((m) => [m.user_id, m.name || m.email || m.user_id]));
    const confirm = phrase.trim();
    let current = scan;
    let applied = 0;
    const skipped: Array<{ user_id: string; name: string; status: string }> = [];
    try {
      // The server corrects a page of members per request; keep going while it
      // reports more and is still writing, each time on a fresh scan.
      for (let round = 0; round < MAX_APPLY_ROUNDS; round++) {
        const res = await api.post<ApplyResult>('/api/admin/wallet-adjust/rounding-drift/apply', {
          confirm,
          fingerprint: current.fingerprint,
        });
        const wrote = res.results.filter((r) => r.status === 'applied').length;
        applied += wrote;
        for (const r of res.results) {
          if (r.status !== 'applied') skipped.push({ user_id: r.user_id, name: names.get(r.user_id) ?? r.user_id, status: r.status });
        }
        // Re-scan so whatever was not written stays on screen.
        current = await api.get<DriftScan>('/api/admin/wallet-adjust/rounding-drift');
        if (!res.remaining || wrote === 0) break;
      }
      setScan(current);
      setDone(loc(`تمت التسوية لـ ${applied} عضو`, `Settled ${applied} member(s)`));
      setNotApplied(skipped);
      setPhrase('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      if (applied > 0) setDone(loc(`تمت التسوية لـ ${applied} عضو`, `Settled ${applied} member(s)`));
      setNotApplied(skipped);
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = (status: string) =>
    status === 'refused'
      ? loc('رُفضت — تغيّر الرصيد', 'refused — the balance changed')
      : status === 'unrepresentable'
        ? loc('أقل من سنت — لا تُسجَّل', 'under one cent — cannot be recorded')
        : status === 'already_applied'
          ? loc('مطبّقة مسبقًا', 'already applied')
          : status;

  const actionable = scan ? scan.members.filter((m) => m.apply_iqd !== 0) : [];

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-900 p-6" data-rounding-drift>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-bold text-white">{loc('فروقات التقريب القديمة', 'Old rounding differences')}</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
            {loc(
              'أرصدة انحرفت بضعة دنانير عمّا كتبه العميل (مثل 49,994 بدل 50,000). الفحص لا يغيّر شيئًا؛ التطبيق يكتب تسوية واحدة مسجّلة لكل عضو، ولا يخصم أبدًا تحت الصفر.',
              'Balances that drifted a few dinars from what the customer typed (e.g. 49,994 for 50,000). Checking changes nothing; applying writes one recorded adjustment per member and never takes a balance below zero.'
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void check()}
          disabled={busy}
          className="flex shrink-0 items-center gap-2 rounded-xl bg-zinc-800 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
        >
          <ScanSearch className="h-4 w-4" /> {loc('فحص فروقات التقريب', 'Check rounding differences')}
        </button>
      </div>

      {error && (
        <p className="mt-4 flex items-start gap-2 text-sm font-medium text-red-400" role="alert">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> <span className="min-w-0 break-words">{error}</span>
        </p>
      )}
      {done && (
        <p className="mt-4 flex items-center gap-2 text-sm font-bold text-mint" role="status">
          <CheckCircle2 className="h-4 w-4" /> {done}
        </p>
      )}

      {notApplied.length > 0 && (
        <div className="mt-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-300" role="status" data-drift-not-applied>
          <p className="font-bold">
            {loc(`لم تُطبَّق التسوية لـ ${notApplied.length} عضو:`, `Not applied for ${notApplied.length} member(s):`)}
          </p>
          <ul className="mt-1 space-y-0.5">
            {notApplied.map((r) => (
              <li key={r.user_id} className="min-w-0 break-words">
                <span dir="auto">{r.name}</span> · {statusLabel(r.status)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {scan && (
        <div className="mt-4 space-y-4">
          {scan.members.length === 0 ? (
            <p className="text-sm text-zinc-400">{loc('لا توجد فروقات — كل الأرصدة مطابقة لما كُتب.', 'No differences — every balance matches what was typed.')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
                <thead>
                  <tr className="text-start text-[11px] font-bold text-zinc-500">
                    <th className="py-2 text-start">{loc('العضو', 'Member')}</th>
                    <th className="py-2 text-start">{loc('العمليات', 'Operations')}</th>
                    <th className="py-2 text-start">{loc('الرصيد', 'Balance')}</th>
                    <th className="py-2 text-start">{loc('التسوية', 'Adjustment')}</th>
                  </tr>
                </thead>
                <tbody>
                  {scan.members.map((m) => (
                    <tr key={m.user_id} className="border-t border-zinc-800 align-top">
                      <td className="py-2 pe-3">
                        <div className="font-bold text-white" dir="auto">{m.name || m.user_id}</div>
                        <div className="text-[11px] text-zinc-500" dir="ltr">{m.email}</div>
                      </td>
                      <td className="py-2 pe-3 text-[11px] text-zinc-400">
                        {m.rows.map((r) => (
                          <div key={r.tx_id} className="tabular-nums">
                            {r.kind === 'deposit' ? loc('إيداع', 'Deposit') : loc('سحب', 'Withdrawal')} ·{' '}
                            {formatIqd(r.typed_iqd)} → {formatIqd(r.ledger_iqd)}
                          </div>
                        ))}
                        {m.skipped_rows > 0 && (
                          <div className="text-amber-400">
                            {loc(`${m.skipped_rows} عملية خارج نطاق التقريب — لم تُحسب`, `${m.skipped_rows} outside rounding — not counted`)}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pe-3 tabular-nums text-zinc-300">{formatIqd(m.balance_iqd)}</td>
                      <td className="py-2 tabular-nums">
                        <span className={`font-black ${m.apply_iqd > 0 ? 'text-mint' : m.apply_iqd < 0 ? 'text-red-400' : 'text-zinc-500'}`}>
                          {signed(m.apply_iqd)}
                        </span>
                        {m.capped && (
                          <div className="text-[11px] text-amber-400">
                            {loc(`محدود بالرصيد (المستحق ${signed(m.outstanding_iqd)})`, `capped at the balance (owed ${signed(m.outstanding_iqd)})`)}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {actionable.length > 0 && (
            <div className="space-y-2 rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
              <p className="text-xs text-zinc-400">
                {loc(
                  `إضافة ${formatIqd(scan.total_credit_iqd)} وخصم ${formatIqd(scan.total_debit_iqd)} على ${actionable.length} عضو. للتأكيد اكتب «${scan.confirm_phrase}».`,
                  `Credit ${formatIqd(scan.total_credit_iqd)} and debit ${formatIqd(scan.total_debit_iqd)} across ${actionable.length} member(s). To confirm type «${scan.confirm_phrase}» or APPLY.`
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                <input
                  value={phrase}
                  onChange={(e) => setPhrase(e.target.value)}
                  dir="auto"
                  placeholder={scan.confirm_phrase}
                  className="min-w-0 flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm text-white outline-none focus:border-zinc-600"
                />
                <button
                  type="button"
                  onClick={() => void apply()}
                  disabled={busy || !(phrase.trim() === scan.confirm_phrase || phrase.trim() === 'APPLY')}
                  className="rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-black transition-colors hover:bg-zinc-200 disabled:opacity-40"
                >
                  {loc('تطبيق التسوية', 'Apply the settlement')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
