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
  // ONE SWATCH, not a black capsule holding two: the button fill, wearing the
  // dot at its centre — the fill tells the three gold-dotted presets apart,
  // the dot tells «Levonis» from «blue» (both fill near-white). The store
  // island stays on the swatch itself; its 1px line is the island's own
  // border, so a near-white fill still has an edge on cream.
  return (
    <span
      data-store-theme=""
      aria-hidden="true"
      data-accent-sample={accent}
      className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border border-border-subtle ${a.btn}`}
    >
      <span className={`h-2 w-2 rounded-full ${a.indicator}`} />
    </span>
  );
}
