/**
 * A STORE COLOUR, AS THE STORE PAGE WILL WEAR IT — its dot (the tab
 * underline, the rings) and its button fill, drawn from the storefront's own
 * table (src/components/storefront/theme.ts) inside a dark store island
 * (`[data-store-theme]`). Outside the island the app's light theme remaps
 * these utilities, so a swatch drawn bare showed the wrong colour; and three
 * of the seven presets share the gold dot, so a dot alone could not tell them
 * apart — the button tells them apart.
 *
 * Used by the settings screen's «لون المتجر» and the builder's «التمييز».
 */
import { ACCENTS } from '../storefront/theme';

export function AccentSample({ accent }: { accent: string }) {
  const a = ACCENTS[accent] ?? ACCENTS.default;
  return (
    <span data-store-theme="" aria-hidden="true" data-accent-sample={accent} className="inline-flex shrink-0 items-center gap-1 rounded-md bg-canvas p-1">
      <span className={`h-3.5 w-3.5 rounded-full ${a.indicator}`} />
      <span className={`h-3.5 w-5 rounded ${a.btn}`} />
    </span>
  );
}
