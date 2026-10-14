/**
 * «ما ينقص لحساب الأسعار» — WHAT IS MISSING, GROUPED BY FIELD AND LEVEL
 * (implementation spec §5.2 `ReadinessV2.tsx`; docs/PRICING-V2.md §2.1 rule 4,
 * P14).
 *
 * The server groups (`missing`: code, field NAME, level, how many SKUs, the
 * first SKU's name), so an empty 2×3 product reads one line — «تكلفة المورد
 * (المنتج)» — instead of eighteen. A line at a model, colour or SKU jumps to
 * section ٥; anything else to ٣. Codes and names only, never a value.
 */
import type { V2Missing } from './v2Model';
import { nameIn } from './v2Model';
import { missingLabel } from './StatusChipV2';
import { useV2Lang, useV2Strings } from './v2Ui';

/** The section a missing line is fixed in: a model, a colour or an SKU is ٥, the product ٣. */
export const sectionOfMissing = (m: Pick<V2Missing, 'level'>): 3 | 5 => (m.level === 'model' || m.level === 'colour' || m.level === 'sku' ? 5 : 3);

export default function ReadinessV2({ missing, onJump }: { missing: readonly V2Missing[]; onJump: (section: 3 | 5) => void }) {
  const lang = useV2Lang();
  const s = useV2Strings();
  // A consequence is never a separate gap beside its cause («السعر المحسوب غير صالح» only says a price is missing).
  const shown = missing.filter((m) => !(m.code === 'PRICE_INVALID' && missing.length > 1));
  if (!shown.length) return null;
  const level = (m: V2Missing) =>
    m.level === 'model' ? s.levelModel : m.level === 'colour' ? s.levelColour : m.level === 'sku' ? s.levelSku : m.level === 'product' ? s.levelProduct : null;
  return (
    <div className="lv-alert lv-alert-warning min-w-0 px-3 py-2 mb-3" data-v2-readiness>
      <p className="mb-1 text-[12px] font-bold text-text-primary">{s.readinessTitle}</p>
      <ul className="grid gap-1">
        {shown.map((m, i) => {
          const where = level(m);
          const first = m.level && m.level !== 'product' ? nameIn(m.first_name, lang) : '';
          return (
            <li key={`${m.code}-${m.field ?? ''}-${m.level ?? ''}-${i}`} className="flex min-w-0 items-start justify-between gap-2 text-[12px] text-text-secondary" data-v2-missing={m.code}>
              <span className="min-w-0 leading-snug">
                {s.chipMissing(missingLabel(m, lang))}
                {where ? <span className="text-text-muted"> ({where}{first ? ` · ${first}` : ''})</span> : null}
                {m.count > 1 ? <span className="text-text-muted"> · {s.missingCount(String(m.count))}</span> : null}
              </span>
              <button type="button" className="inline-flex min-h-11 shrink-0 items-center px-2 text-[11px] font-bold underline underline-offset-2 text-text-primary" onClick={() => onJump(sectionOfMissing(m))} data-v2-jump={sectionOfMissing(m)}>
                {s.show}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
