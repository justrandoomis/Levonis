import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Package } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, type ApiProduct } from '../../lib/api';
import SafeImage from '../ui/SafeImage';
import CardPrice from '../CardPrice';
import SectionHeader from './SectionHeader';
import { useRail } from '../../lib/useRail';
import type { BundleCard } from '../bundles/BundleTile';
import { useMoney } from '../../CurrencyContext';

/**
 * THE COMBO SHELF — «الكومبو», drawn the way the owner asked for it.
 *
 * Their reference was a Newegg card: the parts laid out left to right with a
 * `+` between them, an `=`, and the combined price, with the saving called out
 * above. That shape is doing real work — it shows WHAT the combo is made of
 * before it shows what it costs, which is the question a shopper has about a
 * bundle and does not have about a product.
 *
 * NOTHING NEW WAS BUILT ON THE SERVER FOR THIS. `/api/bundles` already returns
 * `composition.main_items` with each member's picture, name and quantity, plus
 * `component_total_iqd` and `saving_percent`. This is a second way of drawing
 * the payload the bundles shelf already draws — which is exactly what the
 * owner asked for: «لا تجعلها كلها يتبع نفس النمط».
 *
 * THE SAVING IS THE SERVER'S FIGURE. `component_total_iqd` minus the display
 * price is computed here only for DISPLAY of a number the server already
 * decided is positive (`saving_percent > 0` gates it). No card computes a
 * discount it could get wrong, and a LOCKED card — a members-only combo seen
 * by someone who may not buy it — carries no composition at all, so the
 * optional chaining below is the payload's shape, not defensiveness.
 *
 * ITS OWN LAZY CHUNK and its own request, for the same two reasons
 * `BundlesShelf` is: `tests/bundleBudget.test.ts` measures what the home entry
 * chunk pulls in, and first paint must not wait on a shelf that renders
 * nothing when the shop has published no combos.
 */
export default function ComboShelf() {
  const { money } = useMoney();
  const { loc } = useLanguage();
  const rail = useRail();
  const [combos, setCombos] = useState<BundleCard[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ bundles?: BundleCard[] }>('/api/bundles?kind=bundle&limit=12')
      .then((r) => {
        if (cancelled) return;
        // Only rows that actually have parts to show. A combo with one member
        // is a product, and drawing "[thumb] = price" would be a joke.
        setCombos((r.bundles ?? []).filter((b) => (b.composition?.main_items?.length ?? 0) >= 2));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (combos.length === 0) return null;

  return (
    <section data-home-section="combos" className="mb-10 sm:mb-12">
      <SectionHeader
        title={loc('الكومبو', 'Combos', 'کۆمبۆ')}
        accent="bg-info"
        to="/bundles"
      />
      <div
        ref={rail.ref}
        className="flex gap-3 sm:gap-4 overflow-x-auto overscroll-x-contain hide-scrollbar pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x"
      >
        {combos.map((b) => {
          const parts = b.composition?.main_items ?? [];
          const total = b.composition?.component_total_iqd ?? 0;
          const price = b.display_price_iqd ?? b.price_iqd ?? 0;
          const saving = total > price ? total - price : 0;
          return (
            <Link
              key={b.id}
              to={`/bundles/${b.product_slug}`}
              data-combo-card={b.id}
              className="group snap-start shrink-0 w-[268px] sm:w-[300px] flex flex-col rounded-2xl border border-info/25 bg-surface p-3 hover:border-info/50 transition-colors min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {/* The headline the shape exists for: what this combo saves. */}
              <span className="text-[12px] font-bold text-info mb-2 truncate">
                {saving > 0
                  ? loc(`وفّر ${money(saving)}`, `Save ${money(saving)}`, `${money(saving)} پاشەکەوت`)
                  : loc('باقة', 'Bundle', 'پاکێج')}
              </span>

              {/* [part] + [part] + [part] = [price] — the whole point of the
                  layout. `flex-wrap` is off: the row scrolls with the card
                  rather than reflowing, so the equation always reads as one. */}
              <div className="flex items-center gap-1 min-w-0">
                {parts.slice(0, 3).map((m, i) => (
                  <React.Fragment key={m.product_id}>
                    {i > 0 && <span aria-hidden className="text-zinc-600 text-sm font-bold shrink-0">+</span>}
                    <span className="relative w-12 h-12 sm:w-14 sm:h-14 rounded-lg overflow-hidden bg-black border border-border-subtle shrink-0 grid place-items-center">
                      {m.image ? (
                        <SafeImage src={m.image} alt={m.name} aspect="auto" className="w-full h-full" />
                      ) : (
                        <Package aria-hidden className="w-4 h-4 text-zinc-700" />
                      )}
                      {m.qty > 1 && (
                        <span className="absolute bottom-0 end-0 bg-black/90 text-zinc-200 text-[9px] font-bold px-1 rounded-ts-sm">
                          ×{m.qty}
                        </span>
                      )}
                    </span>
                  </React.Fragment>
                ))}
                {parts.length > 3 && (
                  <span aria-hidden className="text-zinc-600 text-[11px] font-bold shrink-0 ps-0.5">
                    +{parts.length - 3}
                  </span>
                )}
                <span aria-hidden className="text-zinc-600 text-sm font-bold shrink-0 px-1">
                  =
                </span>
                <span className="min-w-0 flex-1">
                  <CardPrice p={b as ApiProduct} compact />
                </span>
              </div>

              <h3 dir="ltr" className="text-white font-medium text-[13px] leading-snug line-clamp-2 min-h-[2.2rem] text-start mt-2.5">
                {b.name}
              </h3>
              {total > price && (
                <span className="text-[11px] text-zinc-500 tabular-nums">
                  <span className="line-through">{money(total)}</span>
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
