/**
 * THE VALUE, BY TIER (owner decision 3, spec §6.6; worker/lib/moneyAuthority.ts):
 *
 *   financial admin   «الحد الأعلى المسموح: X» — the SERVER's ceiling from intake (never a figure
 *                     typed here); «اعتماد X» fixes it, or proposes it to the customer when it is
 *                     below the offer; «قيمة أقل…» proposes a lower value with the reason the
 *                     customer reads;
 *   owner             «تجاوز المالك»: a value above the ceiling, with a private reason (audit and
 *                     reports only) and, past the store's own cap, the acknowledgement that the
 *                     margin shrinks and may be a loss (the server asks: TRADE_IN_MARGIN_ACK_REQUIRED).
 *
 * An assistant never sees these buttons (the server refuses them anyway: FINANCIAL_SCOPE_REQUIRED).
 * A unit received with no serial on record, or over a mismatch, is approved by the owner with a
 * reason. Nothing here decides money: every press is the server's to accept or refuse.
 */
import React, { useState } from 'react';
import { CheckCircle2, PencilLine, ShieldAlert } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { api, ApiError } from '../../lib/api';
import { apiRefusal, refusalLang } from '../../lib/refusalStrings';
import { withFee } from '../tradeIn/model';
import { useA } from './useA';
import type { AdminRequestView } from './types';

export default function ValuePanel({ req, ownerScope, onDone }: { req: AdminRequestView; ownerScope: boolean; onDone: (r: AdminRequestView) => void }) {
  const { a, money, lang } = useA();
  const [mode, setMode] = useState<'' | 'lower'>('');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [ownerReason, setOwnerReason] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const ceiling = req.ceiling_iqd ?? null;
  const serialNeedsOwner = req.intake?.serial_match === 'unrecorded' || req.intake?.serial_match === 'mismatch';
  const proposed = Number(value.replace(/[^0-9]/g, '')) || 0;
  const above = ceiling !== null && proposed > ceiling;
  const target = req.target?.price_iqd ?? null;
  const preview = value && target !== null ? withFee(target, proposed, req.pickup_fee_iqd ?? 0) : null;

  const post = async (name: string, path: string, body: Record<string, unknown>) => {
    setBusy(name);
    setError('');
    try {
      const d = await api.post<{ request: AdminRequestView }>(`/api/admin/trade-in/requests/${encodeURIComponent(req.id)}/${path}`, body);
      setMode('');
      setValue('');
      onDone(d.request);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TRADE_IN_MARGIN_ACK_REQUIRED') setAck(false);
      setError(apiRefusal(e, refusalLang(lang), a('failed')));
    } finally {
      setBusy('');
    }
  };

  const ownerReasonOk = ownerReason.trim().length >= 5;
  const approveBlocked = serialNeedsOwner && (!ownerScope || !ownerReasonOk);
  const sendBlocked = !value || proposed <= 0 || (above && (!ownerScope || !ownerReasonOk)) || (serialNeedsOwner && (!ownerScope || !ownerReasonOk));

  return (
    <section className={`${T.surface} space-y-3 p-4`} data-value-panel aria-labelledby="ti-value-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="ti-value-title" className="text-[14px] font-bold">
          {a('ceiling')}
        </h3>
        <span className="text-[20px] font-black tabular-nums" data-ceiling={ceiling ?? ''}>
          {money(ceiling)}
        </span>
      </div>

      {serialNeedsOwner ? (
        <p className="flex items-start gap-1.5 text-[12.5px] text-[var(--ap-warning)]">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {a('value.ownerSerial')}
        </p>
      ) : null}

      <label className="block">
        <span className={`mb-1 block text-[12px] ${T.text3}`}>{a('reasonCustomer')}</span>
        <input className={`${T.input} w-full`} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} data-value-reason />
      </label>

      {serialNeedsOwner || (mode === 'lower' && above) ? (
        ownerScope ? (
          <label className="block" data-owner-reason>
            <span className={`mb-1 block text-[12px] ${T.text3}`}>{above ? a('overrideReason') : a('value.ownerReason')}</span>
            <input className={`${T.input} w-full`} maxLength={500} value={ownerReason} onChange={(e) => setOwnerReason(e.target.value)} />
          </label>
        ) : null
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`${T.btnPrimary} min-h-[44px]`}
          disabled={!!busy || ceiling === null || approveBlocked}
          onClick={() => post('approve', 'approve', { ...(reason.trim() ? { reason: reason.trim() } : {}), ...(serialNeedsOwner ? { owner_reason: ownerReason.trim() } : {}) })}
          data-act="approve"
        >
          <CheckCircle2 className="h-4 w-4" aria-hidden />
          {a('approveX', { x: money(ceiling) })}
        </button>
        <button
          type="button"
          className={`${T.btnSecondary} min-h-[44px]`}
          aria-expanded={mode === 'lower'}
          onClick={() => setMode(mode === 'lower' ? '' : 'lower')}
          data-act="value"
        >
          <PencilLine className="h-4 w-4" aria-hidden />
          {ownerScope ? `${a('lower')} / ${a('override')}` : a('lower')}
        </button>
      </div>

      {mode === 'lower' ? (
        <div className="space-y-2 rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] p-3" data-value-form>
          <label className="block">
            <span className={`mb-1 block text-[12px] ${T.text3}`}>{a('value.amount')}</span>
            <input
              className={`${T.input} w-full tabular-nums`}
              inputMode="numeric"
              dir="ltr"
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))}
              data-value-input
            />
          </label>
          {above ? (
            ownerScope ? (
              <>
                <p className="text-[12.5px] font-semibold text-[var(--ap-warning)]">{a('override')}</p>
                <label className="flex items-start gap-2 text-[12.5px]" data-ack>
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--ap-accent)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  <span>{a('ackLoss')}</span>
                </label>
              </>
            ) : (
              <p className="text-[12.5px] text-[var(--ap-warning)]" role="status" data-above-ceiling>
                {a('value.aboveNeedsOwner')}
              </p>
            )
          ) : null}
          {preview ? <p className={`text-[12.5px] ${T.text2}`}>{a('value.customerPays', { x: money(preview.pay) })}</p> : null}
          <button
            type="button"
            className={`${T.btnPrimary} min-h-[44px]`}
            disabled={!!busy || sendBlocked}
            onClick={() =>
              post('value', 'value', {
                value_iqd: proposed,
                reason: reason.trim(),
                ...(above || serialNeedsOwner ? { owner_reason: ownerReason.trim() } : {}),
                ...(above && ack ? { ack_below_margin: true } : {}),
              })
            }
            data-send-value
          >
            {a('value.send')}
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="text-[13px] text-[var(--ap-danger)]" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
