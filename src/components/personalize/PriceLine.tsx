/**
 * THE PRICE — the engine's unit for this configuration (packages/catalog/src/
 * personalize/price.ts, the same pricer the Worker charges with: P1). A
 * figure the engine cannot price (a part with no live price) reads «—»,
 * never a guess. Announced politely when it changes; `data-price-iqd` for
 * probes.
 */
import { Money } from '../ui/Money';

export function PriceLine({ unit, label }: { unit: number | null; label: string }) {
  return (
    <p className="shrink-0 leading-tight" aria-live="polite" data-price-iqd={unit ?? ''}>
      <span className="sr-only">{label} </span>
      <Money iqd={unit} className="text-[17px] font-bold text-text-primary" />
    </p>
  );
}
