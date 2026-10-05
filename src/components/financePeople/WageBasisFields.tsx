import { useId } from 'react';
import { NumberInput } from '../ui/NumberInput';
import { Select } from '../ui/Field';
import { Field, Money, useLanguage } from './shared';

/** The saved bases remain unchanged: switching the counting unit never changes
 * the entered amount, while changing between a percentage and IQD resets it. */
export default function WageBasisFields({ basis, amount, onBasisChange, onAmountChange, cap = null, changing = false }: {
  basis: string;
  amount: number | null;
  onBasisChange: (value: string) => void;
  onAmountChange: (value: number | null) => void;
  cap?: number | null;
  changing?: boolean;
}) {
  const { loc } = useLanguage(), exampleId = useId();
  const percent = basis.endsWith('percent');
  const kind = percent ? basis : 'fixed';
  const example = amount === null ? null : amount * (basis === 'unit' ? 6 : 1);
  return <>
    <Field label={loc('نوع الأجر', 'Pay type')}>
      <Select value={kind} onChange={(event) => {
        const next = event.target.value;
        if ((next === 'fixed') === percent) onAmountChange(null);
        onBasisChange(next === 'fixed' ? 'unit' : next);
      }}>
        <option value="fixed">{loc('مبلغ ثابت بالدينار', 'Fixed amount in IQD')}</option>
        <option value="profit_percent">{loc('نسبة من ربح البضاعة', 'Share of goods profit')}</option>
        <option value="revenue_percent">{loc('نسبة من صافي المبيعات', 'Share of net sales')}</option>
      </Select>
    </Field>
    {!percent && <fieldset className="fp-detail fp-stack" aria-describedby={exampleId}>
      <legend>{loc('يُحسب الأجر على', 'Count pay by')}</legend>
      <div className="fp-chips">
        <button type="button" className="fp-chip" aria-pressed={basis === 'unit'} onClick={() => onBasisChange('unit')}>{loc('كل قطعة مباعة', 'Each sold unit')}</button>
        <button type="button" className="fp-chip" aria-pressed={basis === 'order'} onClick={() => onBasisChange('order')}>{loc('الطلب كاملًا مرة واحدة', 'Whole order once')}</button>
      </div>
      <p className="fp-muted" id={exampleId}>{basis === 'unit'
        ? loc('طلب فيه ٦ طابعات مشمولة = الأجر × ٦. القطع المستثناة لا تُحسب.', 'An order with 6 eligible printers earns the rate × 6. Excluded units do not count.')
        : loc('طلب فيه ٦ طابعات مشمولة = الأجر مرة واحدة. يلزم وجود قطعة مشمولة واحدة على الأقل.', 'An order with 6 eligible printers earns the rate once. At least one eligible unit is required.')}</p>
    </fieldset>}
    <Field label={percent
      ? changing ? loc('النسبة الجديدة', 'New percentage') : loc('النسبة', 'Percentage')
      : basis === 'unit' ? loc('أجر كل قطعة', 'Pay per unit') : loc('أجر الطلب كاملًا', 'Pay per whole order')}>
      <NumberInput kind={percent ? 'number' : 'money'} value={amount} min={changing ? 0 : percent ? 0.01 : 1} max={percent ? 100 : undefined} unit={percent ? '%' : undefined} onValueChange={(value, valid) => onAmountChange(valid ? value : null)} placeholder={percent ? '10' : '5,000'} />
    </Field>
    {!percent && example !== null && <p className="fp-note" role="status">
      {loc('مثال: أجر طلب فيه ٦ قطع مشمولة = ', 'Example: pay for an order with 6 eligible units = ')}<Money value={cap === null ? example : Math.min(cap, example)} />
      {cap !== null && <> · {loc('بعد تطبيق سقف الأجر', 'after the pay cap')}</>}
    </p>}
    {percent && <p className="fp-note">{basis === 'profit_percent'
      ? loc('تُحسب النسبة على ربح القطع المشمولة: قيمتها بعد الخصومات والمرتجعات مطروحًا منها تكلفتها المثبتة، ثم تُجمع أجورها. أجور ٦ قطع تشمل أرباح القطع الست، دون ضرب الناتج في ٦ مرة أخرى. تُحسب الأجور قبل حصة المستثمر.', 'The percentage uses eligible goods revenue after discounts and returns, less verified cost, then adds the line earnings. Pay for 6 units includes all 6 units’ profit; it is not multiplied by 6 again. Wages are calculated before the investor share.')
      : loc('تُحسب النسبة على صافي مبيعات القطع المشمولة بعد الخصومات والمرتجعات. طلب فيه ٦ قطع يشمل مبيعات القطع الست، دون ضرب الناتج في ٦ مرة أخرى.', 'The percentage uses net sales of eligible units after discounts and returns. An order with 6 units includes all 6 units’ sales; it is not multiplied by 6 again.')}</p>}
  </>;
}
