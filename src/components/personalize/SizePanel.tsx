/**
 * SIZE — Small / Medium ★ / Large, never a percentage (the owner's brief;
 * survey S1b). The sizes are the product's own size variants that the shop's
 * printer makes (packages/catalog/src/personalize/rules.ts
 * `sizeValuesInBuild`), each keeping the chosen look and quality; the
 * recommended one carries the star; under each, what it does to the price;
 * the dimensions are secondary, in centimetres. A sold-out size is shown and
 * cannot be chosen.
 */
import { Star } from 'lucide-react';
import { Segmented } from '../ui/Segmented';
import { Money } from '../ui/Money';
import { fill } from './strings';
import { sizeName } from './ReadyLine';
import { axisOf, sizeRows, type Kit } from './useStudio';

/** Whole centimetres (half a centimetre when small). */
const cm = (mm: number) => String(mm < 100 ? Math.round(mm / 5) / 2 : Math.round(mm / 10));

export function SizePanel({ k }: { k: Kit }) {
  const { pub, state, dispatch, t } = k;
  const ax = pub.axes.size;
  const rows = sizeRows(pub, state.config);
  if (!ax || rows.length < 2) return null;
  const now = axisOf(pub, state.config, 'size');
  const cur = pub.variants.find((v) => v.id === state.config.variant);
  const dims = now ? ax.values[now]?.dims_mm : undefined;
  return (
    <div className="space-y-2 px-3 py-3" data-sizes>
      <Segmented
        group="personalize-size"
        label={t.tiles.size}
        dataAttr="data-size"
        value={now ?? ''}
        onChange={(value) => {
          const v = rows.find((r) => r.value === value)?.variant;
          if (v?.in_stock) dispatch({ type: 'variant', variant: v.id });
        }}
        items={rows.map((r) => ({
          id: r.value,
          label: sizeName(pub, state.config, r.value, t),
          badge: ax.values[r.value]?.recommended ? <Star aria-label={t.recommended} className="h-3.5 w-3.5 fill-current text-gold" /> : undefined,
          disabled: !r.variant || !r.variant.in_stock,
        }))}
      />
      <div className="grid gap-1 text-center text-[12px] text-text-muted" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}>
        {rows.map((r) => (
          <span key={r.value} className="truncate">
            {!r.variant || !r.variant.in_stock ? (
              <span className="text-warning">{t.soldOut}</span>
            ) : r.value === now || !cur ? (
              ' '
            ) : r.variant.price_iqd === cur.price_iqd ? (
              t.samePrice
            ) : (
              <Money iqd={r.variant.price_iqd - cur.price_iqd} signed />
            )}
          </span>
        ))}
      </div>
      {dims && <p className="text-[12.5px] text-text-secondary">{fill(t.dims, { dims: dims.map(cm).join(' × ') })}</p>}
    </div>
  );
}
