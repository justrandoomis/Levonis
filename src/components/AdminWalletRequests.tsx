import React, { useState, useEffect, useCallback } from 'react';
import { api, ApiError, WalletTx, formatIqd, formatUsdCents, formatWalletIqd } from '../lib/api';
import { useWallet } from '../WalletContext';
import { Check, X, Wallet, FileImage, RefreshCw } from 'lucide-react';

type AdminWalletTx = WalletTx & { email?: string; username?: string; userId?: string };

export default function AdminWalletRequests() {
  /** Dinars are the headline here too — this is the screen where a human
   *  approves money, so it also carries the rate it was converted at. */
  const { exchangeRate } = useWallet();
  const [transactions, setTransactions] = useState<AdminWalletTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('pending');
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  /**
   * The step being confirmed for one row, with the note that step needs.
   *
   * A deposit is decided through /api/wallet/admin/deposits/:id/approve|reject
   * — the guarded service the Telegram buttons also call: it refuses a request
   * whose observed amount does not match, frees the transfer reference on a
   * rejection and closes the group message. Rejecting needs a written reason.
   * Only a withdrawal filed before the holds engine (no workflow row) is still
   * decided the old way. A hold-backed withdrawal walks its own state machine:
   * requested → approved (for processing, no money moves) → processing → paid,
   * with the payout reference of a transfer that already happened; or reject /
   * fail with a reason. Each step is ONE call to
   * /api/wallet/admin/withdrawals/:id/…, which commits or releases the hold in
   * the same transaction as the ledger row.
   */
  type Step =
    | { kind: 'legacy'; status: 'approved' | 'rejected' }
    | { kind: 'deposit'; action: 'approve' | 'reject' }
    | { kind: 'wd'; action: 'approve' | 'processing' | 'paid' | 'reject' | 'fail' | 'reconcile_clear'; wdId: string };
  const [decision, setDecision] = useState<{ id: string; step: Step; note: string } | null>(null);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  /**
   * THE DINARS THE CUSTOMER TYPED, per deposit id (migration 0105).
   *
   * This screen used to print `formatWalletIqd(t.amount, exchangeRate)` and
   * nothing else — a conversion of the stored cents back to dinars. That
   * conversion is not the inverse of the one the deposit form did: at 1,400
   * IQD/USD a cent is 14 د.ع, so a customer who transferred 50,000 د.ع had
   * their request approved against «50,008 د.ع» on this very card, and a
   * reviewer holding the transfer slip could not match the two numbers.
   *
   * The recorded figure is fetched separately because the list itself comes
   * from the legacy /api/admin/wallet-requests route, which reports the ledger
   * row only. A request filed before 0105 is simply absent from this map and
   * the card keeps converting — the honest answer for a dinar figure nobody
   * ever wrote down. The ledger value and the rate stay underneath either way:
   * approving money is a reconciliation, and both numbers belong on it.
   */
  const [declaredIqd, setDeclaredIqd] = useState<Record<string, { amount_iqd: number; exchange_rate: number | null }>>({});

  const fetchTransactions = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get<{ requests: AdminWalletTx[] }>('/api/admin/wallet-requests');
      setTransactions(data.requests);
      const depositIds = data.requests.filter((t) => t.type === 'deposit').map((t) => t.id);
      if (depositIds.length > 0) {
        try {
          const meta = await api.get<{ declared: Record<string, { amount_iqd: number; exchange_rate: number | null }> }>(
            `/api/wallet/admin/deposits/declared?ids=${encodeURIComponent(depositIds.slice(0, 200).join(','))}`
          );
          setDeclaredIqd(meta.declared ?? {});
        } catch {
          // A missing testimony map is not a failed screen: every card falls
          // back to the conversion it has always used.
          setDeclaredIqd({});
        }
      } else {
        setDeclaredIqd({});
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load wallet requests');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  /** Steps that need a written reason or reference before they can be confirmed. */
  const noteRequired = (step: Step) =>
    (step.kind === 'deposit' && step.action === 'reject') ||
    (step.kind === 'wd' && (step.action === 'paid' || step.action === 'reject' || step.action === 'fail' || step.action === 'reconcile_clear'));
  const noteLabel = (step: Step) => {
    if (step.kind === 'legacy') return step.status === 'approved' ? 'Admin note (optional)' : 'Rejection reason (optional)';
    if (step.kind === 'deposit') return step.action === 'approve' ? 'Admin note (optional)' : 'Rejection reason (required — frees the transfer reference for a corrected request)';
    switch (step.action) {
      case 'paid': return 'Payout reference of the transfer that already happened (required)';
      case 'reject': return 'Rejection reason (required)';
      case 'fail': return 'Why the transfer failed (required)';
      case 'approve': return 'Approve for processing — this is NOT a payout; the money stays held';
      case 'processing': return 'A person is now working the transfer — the money stays held';
      case 'reconcile_clear': return 'What the transfer channel actually did — the recorded finding (required)';
    }
  };
  const confirmLabel = (step: Step) => {
    if (step.kind === 'legacy') return step.status === 'approved' ? 'Confirm Approve' : 'Confirm Reject';
    if (step.kind === 'deposit') return step.action === 'approve' ? 'Confirm Approve' : 'Confirm Reject';
    return { approve: 'Approve for processing', processing: 'Start processing', paid: 'Confirm paid', reject: 'Confirm Reject', fail: 'Confirm failure', reconcile_clear: 'Record finding' }[step.action];
  };
  /** Which button colour: green for a step that moves things forward, red for a refusal. */
  const isPositive = (step: Step) =>
    step.kind === 'legacy' ? step.status === 'approved'
    : step.kind === 'deposit' ? step.action === 'approve'
    : step.action !== 'reject' && step.action !== 'fail';

  const confirmDecision = async () => {
    if (!decision || loadingAction) return;
    const { id, step, note } = decision;
    if (noteRequired(step) && note.trim().length < 3) {
      setActionError({ id, message: 'Write at least 3 characters — this is recorded on the request.' });
      return;
    }
    setLoadingAction(`${step.kind === 'legacy' ? step.status : step.action}-${id}`);
    setActionError(null);
    try {
      if (step.kind === 'legacy') {
        await api.post(`/api/admin/wallet-requests/${id}/decide`, { status: step.status, adminNote: note || undefined });
      } else if (step.kind === 'deposit') {
        // The guarded deposit decision (amount-mismatch refusal, dedup-slot
        // release, Telegram message close) — never the generic legacy decide.
        if (step.action === 'approve') await api.post(`/api/wallet/admin/deposits/${id}/approve`, { adminNote: note || undefined });
        else await api.post(`/api/wallet/admin/deposits/${id}/reject`, { reason: note.trim() });
      } else {
        const base = `/api/wallet/admin/withdrawals/${step.wdId}`;
        if (step.action === 'approve') await api.post(`${base}/approve`, {});
        else if (step.action === 'processing') await api.post(`${base}/processing`, {});
        else if (step.action === 'paid') await api.post(`${base}/paid`, { payoutReference: note.trim() });
        else if (step.action === 'reject') await api.post(`${base}/reject`, { reason: note.trim() });
        else if (step.action === 'fail') await api.post(`${base}/fail`, { reason: note.trim() });
        else await api.post(`${base}/reconcile/clear`, { finding: note.trim() });
      }
      setDecision(null);
      await fetchTransactions();
    } catch (err) {
      // Surfaces e.g. INSUFFICIENT_BALANCE, STATE_CONFLICT or
      // USE_WITHDRAWAL_WORKFLOW honestly instead of a green button.
      setActionError({ id, message: err instanceof ApiError ? err.message : 'Action failed' });
    } finally {
      setLoadingAction(null);
    }
  };

  /** The buttons one row offers, from where it stands. */
  const stepsFor = (t: AdminWalletTx): Array<{ label: string; step: Step; primary: boolean; icon: 'check' | 'x' }> => {
    const wd = t.type === 'withdrawal' ? t.withdrawal : null;
    if (wd) {
      const w = (action: Extract<Step, { kind: 'wd' }>['action'], label: string, primary: boolean, icon: 'check' | 'x') =>
        ({ label, step: { kind: 'wd', action, wdId: wd.id } as Step, primary, icon });
      // A transfer with an unknown outcome is parked for reconciliation; until
      // the real finding is recorded, /paid and /fail are both refused by the
      // server, so the only step is to record what the channel actually did.
      if (wd.needs_reconciliation) return [w('reconcile_clear', 'Record reconciliation finding', true, 'check')];
      switch (wd.state) {
        case 'requested': return [w('approve', 'Approve for processing', true, 'check'), w('reject', 'Reject', false, 'x')];
        case 'approved': return [w('processing', 'Start processing', true, 'check'), w('reject', 'Reject', false, 'x')];
        case 'processing': return [w('paid', 'Mark paid', true, 'check'), w('fail', 'Transfer failed', false, 'x')];
        default: return [];
      }
    }
    if (t.status !== 'pending') return [];
    if (t.type === 'deposit') {
      return [
        { label: 'Approve', step: { kind: 'deposit', action: 'approve' }, primary: true, icon: 'check' },
        { label: 'Reject', step: { kind: 'deposit', action: 'reject' }, primary: false, icon: 'x' },
      ];
    }
    // A withdrawal from before the holds engine: no workflow row, nothing
    // else can decide it.
    return [
      { label: 'Approve', step: { kind: 'legacy', status: 'approved' }, primary: true, icon: 'check' },
      { label: 'Reject', step: { kind: 'legacy', status: 'rejected' }, primary: false, icon: 'x' },
    ];
  };

  /** What the badge says: the workflow state for a hold-backed withdrawal, the ledger status otherwise. */
  const badgeFor = (t: AdminWalletTx): { text: string; cls: string } => {
    const wd = t.type === 'withdrawal' ? t.withdrawal : null;
    const state = wd ? wd.state : t.status;
    const cls =
      state === 'pending' || state === 'requested' ? 'bg-[#FFD166]/20 text-[#FFB703]' :
      state === 'approved' && wd ? 'bg-[#6B46FF]/20 text-[#8B6BFF]' :
      state === 'processing' ? 'bg-[#6B46FF]/20 text-[#8B6BFF]' :
      state === 'approved' || state === 'paid' ? 'bg-[#2CE59B]/20 text-[#06D6A0]' :
      'bg-[#FF6B6B]/20 text-[#EF476F]';
    return { text: wd?.needs_reconciliation ? `${state} · needs reconciliation` : state, cls };
  };

  const filtered = transactions.filter(t => filter === 'all' ? true : t.status === filter);
  const pendingCount = transactions.filter(t => t.status === 'pending').length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-black text-white">Wallet Requests</h2>
          {pendingCount > 0 && (
            <span className="bg-[#FF6B6B] text-white px-3 py-1 rounded-full text-xs font-bold shadow-sm">{pendingCount} Pending</span>
          )}
          <button
            onClick={fetchTransactions}
            className="p-2 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 rounded-xl text-zinc-400 hover:text-white transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="flex bg-zinc-900 border border-zinc-800 p-1 rounded-xl">
          {(['all', 'pending', 'approved', 'rejected'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-2 rounded-lg text-sm font-bold capitalize transition-colors ${filter === f ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-4 text-sm font-medium">
          {loadError}
        </div>
      )}

      <div className="space-y-4">
        {filtered.map(t => (
          <div key={t.id} className="bg-zinc-900 border border-zinc-800 rounded-3xl p-5 shadow-sm hover:shadow-md transition-shadow">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center border shadow-inner shrink-0 ${
                  t.type === 'deposit' ? 'bg-[#2CE59B]/10 border-[#2CE59B]/20' : 'bg-[#FF6B9E]/10 border-[#FF6B9E]/20'
                }`}>
                  <Wallet className={`w-5 h-5 ${t.type === 'deposit' ? 'text-[#2CE59B]' : 'text-[#FF6B9E]'}`} />
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-bold text-white capitalize text-lg">{t.type}</h3>
                    <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-wider ${badgeFor(t).cls}`}>
                      {badgeFor(t).text}
                    </span>
                  </div>
                  <div className="text-sm text-zinc-400 font-medium flex flex-wrap items-center gap-2">
                    <span className="text-zinc-200">{t.email || t.username || t.userId || 'Unknown user'}</span>
                    {t.paymentMethod && (
                      <>
                        <span className="text-zinc-600">•</span>
                        <span className="uppercase">{t.paymentMethod}</span>
                      </>
                    )}
                    {t.accountNumber && (
                      <>
                        <span className="text-zinc-600">•</span>
                        <span dir="ltr">{t.accountNumber}</span>
                      </>
                    )}
                    <span className="text-zinc-600">•</span>
                    <span>{t.date ? new Date(t.date).toLocaleDateString() : '—'}</span>
                  </div>
                  {t.hasReceipt && t.receiptUrl && (
                    <a
                      href={t.receiptUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 mt-2 text-xs font-bold text-[#6B46FF] hover:text-[#8B6BFF] transition-colors"
                    >
                      <FileImage className="w-3.5 h-3.5" /> View receipt
                    </a>
                  )}
                  {t.note && (
                    <div className="text-xs text-zinc-500 mt-1 max-w-md" title={t.note}>User note: {t.note}</div>
                  )}
                </div>
              </div>

              <div className="flex flex-col md:items-end gap-2 border-t md:border-t-0 md:border-l border-zinc-800 pt-4 md:pt-0 md:pl-6">
                <div className="text-xl font-black text-white tabular-nums">
                  {/* Presence decides, not truthiness: a request with no
                      recorded dinars falls back to the conversion, and a
                      recorded figure is printed exactly as it was filed.
                      A DEPOSIT's figure comes from the separate testimony map
                      (migration 0105, fetched above because the legacy list
                      route reports the ledger row only); a WITHDRAWAL's rides
                      on the row itself (migration 0106), because both admin
                      lists already join `wallet_withdrawals`. This is the card
                      a human reads before making the transfer, so it must
                      state the amount the customer actually asked for. */}
                  {declaredIqd[t.id]
                    ? formatIqd(declaredIqd[t.id].amount_iqd)
                    : t.withdrawal?.declared_amount_iqd
                      ? formatIqd(t.withdrawal.declared_amount_iqd)
                      : formatWalletIqd(t.amount, exchangeRate)}
                </div>
                {/* The ledger value AND the rate. A reviewer approving a
                    deposit is reconciling a bank transfer against a stored
                    balance, so both numbers and the rate between them belong
                    on this card — the Telegram review card already says
                    «المبلغ: X د.ع (الدفتر: $Y — سعر الصرف Z)» for the same
                    reason. */}
                <div className="text-[11px] text-zinc-500 tabular-nums" dir="ltr">
                  {formatUsdCents(t.amount)} · {exchangeRate.toLocaleString()} IQD/USD
                </div>
                {/**
                  * THE NUMBER TO TRANSFER — because it is NOT the one above it.
                  *
                  * The commission is deducted from the requested amount, so a
                  * customer who asks for 50,000 د.ع at 3% is owed about 48,500
                  * and the shop keeps the rest. This card carried the gross and
                  * nothing else, which meant the figure a reviewer read
                  * immediately before making a bank transfer was the figure
                  * they must NOT transfer.
                  *
                  * It appears only when a commission was actually withheld: on
                  * a request filed while the rate was 0, gross and net are the
                  * same number and a second line saying so would be noise.
                  * `net_cents` is read for presence, not truthiness — a route
                  * that does not carry it must not silently render 0 د.ع as a
                  * payout instruction.
                  *
                  * Both figures come off the row, written when the request was
                  * filed and held together by `CHECK (net_cents = amount_cents
                  * - fee_cents)`, so changing the commission tomorrow cannot
                  * restate what an outstanding request is worth.
                  */}
                {t.withdrawal
                  && typeof t.withdrawal.net_cents === 'number'
                  && typeof t.withdrawal.fee_cents === 'number'
                  && t.withdrawal.fee_cents > 0 && (
                  <div className="w-full md:w-auto rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 mt-1">
                    <div className="flex items-baseline justify-between gap-4 md:justify-end">
                      <span className="text-[10px] uppercase tracking-wide text-amber-200/70">Transfer</span>
                      <span className="text-base font-bold text-amber-100 tabular-nums">
                        {formatWalletIqd(t.withdrawal.net_cents, exchangeRate)}
                      </span>
                    </div>
                    <div className="text-[10px] text-zinc-500 tabular-nums mt-0.5 md:text-right" dir="ltr">
                      commission {formatWalletIqd(t.withdrawal.fee_cents, exchangeRate)} withheld ·{' '}
                      {formatUsdCents(t.withdrawal.net_cents)}
                    </div>
                  </div>
                )}
                {stepsFor(t).length > 0 && decision?.id !== t.id && (
                  <div className="flex gap-2">
                    {stepsFor(t).map((b) => (
                      <button
                        key={b.label}
                        onClick={() => { setActionError(null); setDecision({ id: t.id, step: b.step, note: '' }); }}
                        disabled={!!loadingAction}
                        className={b.primary
                          ? 'flex items-center gap-1 bg-[#2CE59B] hover:bg-[#06D6A0] text-white px-3 py-1.5 rounded-xl text-xs font-bold transition-all shadow-[0_4px_10px_rgba(44,229,155,0.4)] hover:scale-105 disabled:opacity-50'
                          : 'flex items-center gap-1 bg-zinc-900 border border-zinc-700 hover:bg-zinc-800/50 text-zinc-300 px-3 py-1.5 rounded-xl text-xs font-bold transition-all shadow-sm hover:scale-105 disabled:opacity-50'}
                      >
                        {b.icon === 'check' ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />} {b.label}
                      </button>
                    ))}
                  </div>
                )}
                {t.type === 'withdrawal' && t.withdrawal?.payout_reference && (
                  <div className="text-xs text-zinc-500 max-w-[220px] text-right truncate" title={t.withdrawal.payout_reference}>
                    Payout ref: {t.withdrawal.payout_reference}
                  </div>
                )}
                {t.adminNote && (
                  <div className="text-xs text-zinc-500 max-w-[200px] text-right truncate" title={t.adminNote}>
                    Note: {t.adminNote}
                  </div>
                )}
              </div>
            </div>

            {/* Inline decision panel with an admin-note input */}
            {decision?.id === t.id && (
              <div className="mt-4 pt-4 border-t border-zinc-800">
                <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-3">
                  <div className="flex-1">
                    <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1.5">
                      {noteLabel(decision.step)}
                    </label>
                    <input
                      type="text"
                      value={decision.note}
                      onChange={e => setDecision({ ...decision, note: e.target.value })}
                      disabled={decision.step.kind === 'wd' && (decision.step.action === 'approve' || decision.step.action === 'processing')}
                      placeholder={
                        decision.step.kind === 'legacy'
                          ? (decision.step.status === 'approved' ? 'e.g. Verified against the receipt' : 'e.g. Receipt does not match the amount')
                          : decision.step.kind === 'deposit'
                          ? (decision.step.action === 'approve' ? 'e.g. Verified against the receipt' : 'e.g. Receipt does not match the amount')
                          : decision.step.action === 'paid' ? 'e.g. ZainCash TX 8841-2201'
                          : decision.step.action === 'reject' ? 'e.g. Account holder name does not match'
                          : decision.step.action === 'fail' ? 'e.g. Channel refused the transfer'
                          : 'No note needed for this step'
                      }
                      className="w-full bg-zinc-800 border border-zinc-700 text-white px-3 py-2 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#6B46FF]/50"
                      autoFocus
                    />
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={confirmDecision}
                      disabled={!!loadingAction}
                      className={`px-4 py-2 rounded-xl text-sm font-bold transition-all disabled:opacity-50 ${
                        isPositive(decision.step)
                          ? 'bg-[#2CE59B] hover:bg-[#06D6A0] text-black'
                          : 'bg-red-500/90 hover:bg-red-500 text-white'
                      }`}
                    >
                      {loadingAction ? 'Working...' : confirmLabel(decision.step)}
                    </button>
                    <button
                      onClick={() => setDecision(null)}
                      disabled={!!loadingAction}
                      className="px-4 py-2 rounded-xl text-sm font-bold bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            {actionError?.id === t.id && (
              <div className="mt-3 bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl p-3 text-sm font-medium">
                {actionError.message}
              </div>
            )}
          </div>
        ))}
        {!loading && filtered.length === 0 && (
          <div className="text-center text-zinc-500 py-16 bg-zinc-900/50 border border-zinc-800/50 rounded-3xl border-dashed">
            No {filter !== 'all' ? filter : ''} requests found
          </div>
        )}
        {loading && transactions.length === 0 && (
          <div className="text-center text-zinc-500 py-16 bg-zinc-900/50 border border-zinc-800/50 rounded-3xl border-dashed">
            Loading...
          </div>
        )}
      </div>
    </div>
  );
}
