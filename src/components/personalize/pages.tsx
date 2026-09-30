/**
 * THE ADD-ONS — each customer slot's options (the store's own part products),
 * with the picture, the name, what each one does to the price (the engine's
 * pricer, so «included» slots show only a positive difference) and whether
 * it is in stock (survey S2 «Add-ons»). A sold-out option stays visible and
 * cannot be chosen; the verdict line names the alternative.
 */
import { Check, Package } from 'lucide-react';
import { partKindWord } from '../../../packages/catalog/src/personalize/parts';
import { priceContextFromPublic, slotChoice } from '../../../packages/catalog/src/personalize/price';
import { unitPricer, withPublic } from '../../../packages/catalog/src/personalize/rules';
import { Money } from '../ui/Money';
import { type Kit } from './useStudio';

/** The add-ons: each customer slot's options, with the price each one adds (survey S2 «Add-ons»). */
export function AddonsPage({ k }: { k: Kit }) {
  const { pub, state, derived, dispatch, t, lang } = k;
  const config = state.config;
  let unitOf: (c: typeof config) => number | null = () => null;
  try {
    unitOf = unitPricer(pub, withPublic(pub, { price: priceContextFromPublic(pub, config.variant) }), config.variant);
  } catch {
    // A variant the product no longer sells: no deltas to show.
  }
  const now = derived.unit;
  return (
    <div className="space-y-4 px-3 py-3" data-addons>
      {pub.slots
        .filter((s) => s.choice === 'customer')
        .map((s) => {
          const chosen = slotChoice(s, config);
          const options = pub.slot_options[s.id] ?? [];
          const title = s.label?.[lang] || partKindWord(s.kind, lang);
          const row = (key: string | null, name: string, image: string | null, inStock: boolean) => {
            const then = unitOf({ ...config, slots: { ...config.slots, [s.id]: { option: key } } });
            const delta = then !== null && now !== null ? then - now : null;
            return (
              <button
                key={key ?? 'none'}
                type="button"
                role="radio"
                aria-checked={chosen === key}
                aria-disabled={!inStock || undefined}
                onClick={() => inStock && dispatch({ type: 'slot', slot: s.id, option: key })}
                data-option={key ?? 'none'}
                className="lv-choice flex w-full items-center gap-3 p-2 text-start"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border-subtle bg-surface-raised">
                  {image ? <img src={image} alt="" className="h-full w-full object-cover" loading="lazy" /> : <Package aria-hidden="true" className="h-5 w-5 text-text-muted" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold text-text-primary">{name}</span>
                  {!inStock && <span className="block text-[12px] text-warning">{t.soldOut}</span>}
                </span>
                <span className="shrink-0 text-[12.5px] text-text-secondary">
                  {chosen === key ? <Check aria-hidden="true" className="h-4 w-4 text-gold" /> : delta ? <Money iqd={delta} signed /> : null}
                </span>
              </button>
            );
          };
          return (
            <section key={s.id} role="radiogroup" aria-label={title} className="space-y-2">
              <p className="text-[12.5px] font-semibold text-text-secondary">
                {title}
                {s.qty > 1 ? ` ×${s.qty}` : ''}
                {s.required ? <span className="ms-2 font-normal text-text-muted">{t.required}</span> : null}
              </p>
              {!s.required && row(null, t.none, null, true)}
              {s.options.map((o) => {
                const pubOption = options.find((x) => x.key === o.key);
                return row(o.key, pubOption?.name ?? o.key, pubOption?.image ?? null, pubOption?.in_stock !== false);
              })}
            </section>
          );
        })}
    </div>
  );
}

