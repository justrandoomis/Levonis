/**
 * THE RESTOCK SHEET — «+ مخزون» on a sold-out row of Today (merchant platform
 * v2 §3.2). One number, one save: PATCH /api/merchant/products/:id {stock}.
 *
 * The route is behind `requireSellingPrivileges` (worker/routes/
 * merchantCatalog.ts), so a paused store is refused `STORE_PAUSED`, a lapsed
 * one `SUBSCRIPTION_INACTIVE`; those come back as the store's own sentence
 * from src/lib/refusalStrings.ts, next to the field — never a generic error
 * and never the server's English.
 */
import { useEffect, useState } from 'react';
import { useLanguage } from '../../../LanguageContext';
import { api } from '../../../lib/api';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { NumberInput } from '../../ui/NumberInput';
import { Sheet } from '../../ui/Sheet';
import { useToast } from '../../ui/Toast';
import { useCounterStrings } from './strings';

export interface RestockTarget {
  id: string;
  name: string;
  stock: number;
}

/** The catalogue's own ceiling for a stock count. */
export const STOCK_MAX = 1_000_000;

export default function RestockSheet({ target, onClose, onDone }: { target: RestockTarget | null; onClose: () => void; onDone: () => void }) {
  const { lang } = useLanguage();
  const s = useCounterStrings();
  const toast = useToast();
  const [value, setValue] = useState<number | null>(target?.stock ?? 0);
  const [valid, setValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // A new product in the sheet starts from ITS count, and from a clean slate.
  useEffect(() => {
    setValue(target?.stock ?? 0);
    setValid(true);
    setProblem(null);
  }, [target?.id, target?.stock]);

  const save = async () => {
    if (!target || value === null || !valid) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.patch(`/api/merchant/products/${encodeURIComponent(target.id)}`, { stock: value });
      toast.success(s.restock.saved);
      onDone();
      onClose();
    } catch (e) {
      // The sentences are loaded on the first refusal, not with the sheet.
      const { apiRefusal } = await import('../../../lib/refusalStrings');
      setProblem(apiRefusal(e, lang, s.restock.failed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={!!target}
      onClose={onClose}
      detents={['medium']}
      label={s.restock.title}
      header={
        <div className="px-4 pb-2">
          <h2 className="text-[15px] font-bold text-text-primary">{s.restock.title}</h2>
          {target && <p className="truncate text-[12.5px] text-text-muted">{target.name}</p>}
        </div>
      }
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            {s.generic.cancel}
          </Button>
          <Button variant="primary" size="sm" onClick={save} loading={busy} disabled={value === null || !valid} data-restock-save>
            {s.generic.save}
          </Button>
        </div>
      }
    >
      <div className="px-4 py-3">
        <Field label={s.restock.label} hint={s.restock.hint} error={problem ?? undefined}>
          <NumberInput
            kind="quantity"
            value={value}
            max={STOCK_MAX}
            onValueChange={(v, ok) => {
              setValue(v);
              setValid(ok);
              setProblem(null);
            }}
            data-restock-input
          />
        </Field>
      </div>
    </Sheet>
  );
}
