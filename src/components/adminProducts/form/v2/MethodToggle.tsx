/**
 * «كيف يُحسب السعر؟ [ من التكلفة | سعر بالدولار ]» (implementation spec §5.2
 * `MethodToggle.tsx`; docs/PRICING-V2.md §1.2, §2.2; owner decision A1).
 *
 * The owner chooses (the method is theirs: from cost, D = R + T). Every other
 * reader sees the method as a label — a price editor prices a needs-pricing
 * product in dollars (Q9) and a cost-first product's prices are the owner's.
 */
import Segmented from '../../../ui/Segmented';
import type { V2Method } from './v2Model';
import { useV2Strings } from './v2Ui';

export default function MethodToggle({ method, editable, onChange }: { method: V2Method; editable: boolean; onChange: (m: V2Method) => void }) {
  const s = useV2Strings();
  const name = method === 'cost' ? s.fromCost : s.usdPrice;
  if (!editable) {
    return (
      <p className="mb-3 text-[12px] font-bold text-text-secondary" data-v2-method={method}>
        {s.methodLabel(name)}
      </p>
    );
  }
  return (
    <div className="mb-3 grid min-w-0 gap-1.5 sm:flex sm:items-center sm:gap-3" data-v2-method={method}>
      <span className="text-[12px] font-bold text-text-secondary">{s.method}</span>
      <Segmented
        group="v2-method"
        size="md"
        label={s.method}
        value={method}
        onChange={(id) => onChange(id === 'usd' ? 'usd' : 'cost')}
        dataAttr="data-v2-method-option"
        className="w-full sm:w-auto sm:min-w-[18rem]"
        items={[
          { id: 'cost', label: s.fromCost },
          { id: 'usd', label: s.usdPrice },
        ]}
      />
    </div>
  );
}
