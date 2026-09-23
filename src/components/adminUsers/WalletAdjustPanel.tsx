/**
 * «تعديل الرصيد والنقاط» — THE ADMIN'S HAND ON A MEMBER'S WALLET.
 *
 * The owner: «المستخدمين لا يمكن التعديل على رصيده مثل خصم رصيد وإضافة رصيد
 * يدوي أو خصم النقاط وإضافة نقاط». The member window showed the balance and the
 * points read-only; this is the control that changes them, through
 * POST /api/admin/wallet-adjust/users/:id (worker/routes/adminWalletAdjust.ts).
 *
 * TWO STEPS, BECAUSE THIS MOVES MONEY. The form never writes: «مراجعة» turns
 * it into a statement of what will happen — the balance NOW and the balance
 * AFTER, in the member's own dinars — and only «تأكيد وتنفيذ» sends it. The
 * idempotency key is minted when the review opens, so a double press or a
 * retried request replays the same adjustment instead of making two.
 *
 * DINARS IN, DINARS OUT. The admin types the dinars the member will see; the
 * server records them beside the cents (migration 0108), so «إضافة 50,000»
 * reads 50,000 on the member's wallet — never 49,994.
 *
 * It is mounted only inside the financial section, which exists only when the
 * SERVER sent money for this member; the server refuses an assistant admin
 * regardless (403 FINANCIAL_SCOPE_REQUIRED).
 */
import React, { useMemo, useState } from 'react';
import { ArrowLeftRight, CheckCircle2, TriangleAlert } from 'lucide-react';
import { api, ApiError, formatIqd, newIdempotencyKey } from '../../lib/api';
import { Segmented } from '../ui/Segmented';
import { useUsersStrings } from './strings';

export type AdjustKind = 'balance' | 'points';
export type AdjustDirection = 'credit' | 'debit';

/** The resulting figure the review shows — null when the input is not a whole positive amount. */
export function adjustedFigure(current: number, direction: AdjustDirection, amount: number): number | null {
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  return direction === 'credit' ? current + amount : current - amount;
}

/** Digits only (Arabic-Indic digits and thousands separators accepted). */
export function parseWholeAmount(raw: string): number {
  const western = raw.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[,،٬\s]/g, '');
  return /^\d{1,10}$/.test(western) ? Number(western) : NaN;
}

interface AdjustResponse {
  success: true;
  replayed: boolean;
  after: { balance_iqd: number; points: number };
}

export function WalletAdjustPanel({
  userId,
  balanceIqd,
  points,
  onDone,
}: {
  userId: string;
  /** The member's balance as THEY read it (`wallet_iqd`). */
  balanceIqd: number;
  points: number;
  /** Reload the member window so every figure on it is the server's again. */
  onDone: () => void;
}) {
  const s = useUsersStrings();
  const [kind, setKind] = useState<AdjustKind>('balance');
  const [direction, setDirection] = useState<AdjustDirection>('credit');
  const [amountRaw, setAmountRaw] = useState('');
  const [reason, setReason] = useState('');
  const [review, setReview] = useState<{ key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const amount = parseWholeAmount(amountRaw);
  const current = kind === 'balance' ? balanceIqd : points;
  const after = adjustedFigure(current, direction, amount);
  const fmt = useMemo(
    () => (n: number) => (kind === 'balance' ? formatIqd(n) : `${n.toLocaleString()} ${s.adjPointsUnit}`),
    [kind, s.adjPointsUnit]
  );
  const overdraw = after !== null && after < 0;
  const reasonOk = reason.trim().length >= 5;
  const canReview = after !== null && !overdraw && reasonOk && !busy;

  const reset = () => {
    setReview(null);
    setError(null);
  };

  const submit = async () => {
    if (!review || after === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<AdjustResponse>(`/api/admin/wallet-adjust/users/${encodeURIComponent(userId)}`, {
        kind,
        direction,
        ...(kind === 'balance' ? { amount_iqd: amount } : { points: amount }),
        reason: reason.trim(),
        idempotencyKey: review.key,
      });
      setDone(`${s.adjDone} — ${fmt(kind === 'balance' ? res.after.balance_iqd : res.after.points)}`);
      setAmountRaw('');
      setReason('');
      setReview(null);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-member-section="wallet-adjust" className="space-y-3">
      {!review ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <Segmented
              size="sm"
              group="member-adjust-kind"
              label={s.adjKindLabel}
              value={kind}
              onChange={(v) => {
                setKind(v as AdjustKind);
                setDone(null);
                setError(null);
              }}
              items={[
                { id: 'balance', label: s.adjBalance },
                { id: 'points', label: s.fWalletPoints },
              ]}
            />
            <Segmented
              size="sm"
              group="member-adjust-direction"
              label={s.adjDirLabel}
              value={direction}
              onChange={(v) => {
                setDirection(v as AdjustDirection);
                setDone(null);
                setError(null);
              }}
              items={[
                { id: 'credit', label: s.adjAdd },
                { id: 'debit', label: s.adjDeduct },
              ]}
            />
          </div>
          <label className="block">
            <span className="text-[11px] font-bold text-zinc-500">
              {kind === 'balance' ? s.adjAmountIqd : s.adjAmountPoints}
            </span>
            <input
              inputMode="numeric"
              dir="ltr"
              value={amountRaw}
              onChange={(e) => {
                setAmountRaw(e.target.value);
                setDone(null);
              }}
              placeholder={kind === 'balance' ? '50,000' : '100'}
              className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm font-bold tabular-nums text-white outline-none focus:border-zinc-600"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-bold text-zinc-500">{s.adjReason}</span>
            <textarea
              dir="auto"
              rows={2}
              maxLength={300}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-zinc-600"
            />
            <span className="mt-1 block text-[11px] leading-relaxed text-zinc-600">{s.adjReasonHint}</span>
          </label>
          {overdraw && (
            <p className="flex items-center gap-1.5 text-xs font-medium text-red-400">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" /> {s.adjOverBalance}
            </p>
          )}
          {!overdraw && after !== null && !reasonOk && reason.length > 0 && (
            <p className="text-xs font-medium text-zinc-500">{s.adjReasonShort}</p>
          )}
          {done && (
            <p className="flex items-center gap-1.5 text-xs font-bold text-[#2CE59B]" role="status">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> {done}
            </p>
          )}
          <button
            type="button"
            disabled={!canReview}
            onClick={() => {
              setReview({ key: newIdempotencyKey() });
              setError(null);
              setDone(null);
            }}
            className="w-full rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-black transition-colors hover:bg-zinc-200 disabled:opacity-40"
          >
            {s.adjReview}
          </button>
        </>
      ) : (
        <div className="space-y-3" data-adjust-review>
          <h5 className="text-sm font-black text-white">{s.adjConfirmTitle}</h5>
          <p className="text-xs font-medium text-zinc-400">
            {direction === 'credit' ? s.adjAdd : s.adjDeduct} · {kind === 'balance' ? formatIqd(amount) : fmt(amount)}
          </p>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
            <div className="min-w-0">
              <div className="text-[11px] font-bold text-zinc-500">{s.adjCurrent}</div>
              <div className="text-sm font-bold tabular-nums text-zinc-300">{fmt(current)}</div>
            </div>
            <ArrowLeftRight className="h-4 w-4 shrink-0 text-zinc-600" aria-hidden />
            <div className="min-w-0 text-end">
              <div className="text-[11px] font-bold text-zinc-500">{s.adjAfter}</div>
              <div
                className={`text-lg font-black tabular-nums ${direction === 'credit' ? 'text-[#2CE59B]' : 'text-white'}`}
                data-adjust-after
              >
                {after !== null ? fmt(after) : ''}
              </div>
            </div>
          </div>
          <p dir="auto" className="rounded-xl bg-zinc-900 px-3 py-2 text-xs leading-relaxed text-zinc-400">
            {s.fReason}: {reason.trim()}
          </p>
          {error && (
            <p className="flex items-start gap-1.5 text-xs font-medium text-red-400" role="alert">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span className="min-w-0 break-words">{error}</span>
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={reset}
              className="flex-1 rounded-xl px-4 py-2.5 text-sm font-bold text-zinc-400 transition-colors hover:bg-zinc-800 disabled:opacity-40"
            >
              {s.adjBack}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors disabled:opacity-40 ${
                direction === 'debit' ? 'bg-red-500 text-white hover:bg-red-400' : 'bg-white text-black hover:bg-zinc-200'
              }`}
            >
              {busy ? s.adjWorking : s.adjConfirm}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
