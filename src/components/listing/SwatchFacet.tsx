import React from 'react';
import ChipFacet, { type ChipOption } from './ChipFacet';

/**
 * «اللون» (§7, filament): the colour facet as chips with a swatch dot. The
 * dot is drawn only when the admin's colour name IS a colour the browser
 * knows («Black», «White», «Red»…); a trade name («Galaxy Purple») gets no
 * invented swatch, only its words.
 */
export function swatchFor(name: string): string | undefined {
  const n = name.trim().toLowerCase().replace(/\s+/g, '');
  if (!/^[a-z]{3,20}$/.test(n)) return undefined;
  try {
    return typeof CSS !== 'undefined' && CSS.supports('color', n) ? n : undefined;
  } catch {
    return undefined;
  }
}

export default function SwatchFacet(props: {
  options: ChipOption[];
  selected: string[];
  onToggle: (value: string) => void;
  labelledBy: string;
}) {
  // A base colour the importer mirrored is a token («white») drawn in the reader's words (the Bambu import
  // spec §G.5): its dot comes from the token, since «أبيض» is no colour a browser knows.
  const options = props.options.map((o) => ({ ...o, swatch: (o.value !== 'transparent' ? swatchFor(o.value) : undefined) ?? swatchFor(o.label) }));
  return <ChipFacet {...props} options={options} />;
}
