/**
 * «اطلب تحويل أرباحك» — the payout request, in a sheet, with a confirm step.
 *
 *   · the amount is typed on any keyboard (NumberInput) and checked against
 *     «available» before the button — the SERVER decides, inside the batch
 *     that reserves it, whatever this form says;
 *   · the channel is one of the owner's own `payoutMethods` (the server sends
 *     them); the account is asked only when the channel needs one;
 *   · «مراجعة الطلب» opens a confirmation that says what will happen — the
 *     amount is reserved now and sent after Levonis reviews it, cancellable
 *     until approved — and only its verb sends;
 *   · ONE KEY PER REQUEST THE MERCHANT MEANT: minted when the sheet opens,
 *     reused by every retry of it, so a double tap or a retry after a timeout
 *     reserves once. A key the server says belonged to another request is
 *     replaced before the next attempt;
 *   · a refusal is said beside the field in words; what was typed is kept.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError, newIdempotencyKey } from '../../../lib/api';
import { formatMoney } from '../../../lib/money';
import { Sheet } from '../../ui/Sheet';
import { Button } from '../../ui/Button';
import { Field, Input, Select, focusFirstInvalid } from '../../ui/Field';
import { NumberInput } from '../../ui/NumberInput';
import { useConfirm } from '../../ui/ConfirmDialog';
import { financeApi, type PayoutMethodOption } from './financeApi';
import { financeStrings, payoutRefusalText } from './strings';

export default function PayoutRequestSheet({
  open,
  onClose,
  available,
  methods,
  onRequested,
}: {
  open: boolean;
  onClose: () => void;
  available: number;
  methods: PayoutMethodOption[];
  onRequested: () => void;
}) {
  const { loc, lang } = useLanguage();
  const s = financeStrings(loc);
  const money = (iqd: number) => formatMoney(iqd, lang);
  const titleId = useId();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const [amount, setAmount] = useState<number | null>(null);
  const [amountValid, setAmountValid] = useState(true);
  const [channel, setChannel] = useState('');
  const [account, setAccount] = useState('');
  const [holder, setHolder] = useState('');
  const [note, setNote] = useState('');
  const [key, setKey] = useState('');
  const [errors, setErrors] = useState<{ amount?: string; account?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAmount(null);
    setAmountValid(true);
    setChannel(methods[0]?.id ?? '');
    setAccount('');
    setHolder('');
    setNote('');
    setErrors({});
    setBusy(false);
    setKey(newIdempotencyKey());
  }, [open, methods]);

  const method = methods.find((m) => m.id === channel);

  async function review(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const next: typeof errors = {};
    if (amount !== null && Number.isInteger(amount) && amount > available) next.amount = s.amountTooHigh(money(available));
    else if (!amountValid || amount === null || !Number.isInteger(amount) || amount <= 0) next.amount = s.amountInvalid;
    if (method?.requires_account && account.trim().length < 3) next.account = s.accountRequired;
    setErrors(next);
    if (next.amount || next.account) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    const ok = await confirm({
      title: s.confirmTitle(money(amount!)),
      consequence: s.confirmConsequence(method?.name ?? channel, method?.requires_account ? account.trim() : ''),
      confirmLabel: s.send,
      cancelLabel: s.back,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await financeApi.requestPayout({
        amount_iqd: amount!,
        channel,
        account: method?.requires_account ? account.trim() : '',
        holder: holder.trim(),
        note: note.trim(),
        idempotencyKey: key,
      });
      onRequested();
      onClose();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === 'IDEMPOTENCY_KEY_REUSED') setKey(newIdempotencyKey());
      const text = payoutRefusalText(code, err instanceof ApiError ? err.details : undefined, loc, money);
      setErrors(code === 'INSUFFICIENT_BALANCE' || code === 'INVALID_AMOUNT' ? { amount: text } : code === 'PAYOUT_ACCOUNT_REQUIRED' ? { account: text } : { form: text });
      setBusy(false);
    }
  }

  return (
    <>
      <Sheet
        open={open}
        onClose={() => !busy && onClose()}
        labelledBy={titleId}
        detents={['large']}
        dirty={!busy && (amount !== null || account !== '' || note !== '')}
        panelClassName="w-full sm:max-w-md"
        header={
          <div className="px-5 pt-1 pb-2">
            <h2 id={titleId} className="text-[16px] font-bold text-text-primary">{s.sheetTitle}</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-text-muted">{s.sheetLead(money(available))}</p>
          </div>
        }
        footer={
          <div className="flex gap-2 px-5 py-3">
            <Button variant="ghost" onClick={onClose} disabled={busy} className="flex-1">{s.back}</Button>
            <Button variant="primary" type="submit" form={`${titleId}-form`} loading={busy} className="flex-[2]" data-review-payout>
              {s.review}
            </Button>
          </div>
        }
      >
        <form id={`${titleId}-form`} ref={formRef} onSubmit={review} noValidate className="space-y-4 px-5 pb-4 pt-1" data-payout-form>
          <Field label={s.amount} error={errors.amount} required>
            <NumberInput
              kind="money"
              value={amount}
              onValueChange={(v, valid) => {
                setAmount(v);
                setAmountValid(valid);
                if (errors.amount) setErrors((e) => ({ ...e, amount: undefined }));
              }}
              autoComplete="off"
              name="amount"
            />
          </Field>
          <button
            type="button"
            className="-mt-2 min-h-[36px] text-[12.5px] font-semibold text-gold disabled:opacity-40"
            disabled={available <= 0}
            onClick={() => {
              setAmount(available);
              setAmountValid(true);
              setErrors((e) => ({ ...e, amount: undefined }));
            }}
          >
            {s.allAvailable(money(available))}
          </button>
          <Field label={s.channel} required>
            <Select value={channel} onChange={(e) => setChannel(e.target.value)} name="channel">
              {methods.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </Select>
          </Field>
          {method?.requires_account !== false && (
            <Field label={s.account} error={errors.account} required>
              <Input
                ltr
                name="account"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={120}
                value={account}
                onChange={(e) => {
                  setAccount(e.target.value);
                  if (errors.account) setErrors((x) => ({ ...x, account: undefined }));
                }}
              />
            </Field>
          )}
          <Field label={s.holder} optional>
            <Input name="holder" autoComplete="off" maxLength={120} value={holder} onChange={(e) => setHolder(e.target.value)} />
          </Field>
          <Field label={s.note} optional>
            <Input name="note" autoComplete="off" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {errors.form && <p role="alert" className="lv-field-error">{errors.form}</p>}
        </form>
      </Sheet>
      {confirmDialog}
    </>
  );
}
