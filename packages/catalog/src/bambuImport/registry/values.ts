/**
 * The generic value-word dictionary (spec §C.2): an option value's ar/ckb
 * names come from here only, by exact (case-insensitive) match on the whole
 * value. Anything else keeps '' and falls back to the English source text —
 * never a guess, never machine translation (row 2).
 */
import { labelKey } from '../normalize';
import { tri, type Tri } from './labels';

const WORDS: ReadonlyArray<[string, Tri]> = [
  ['Refill', tri('عبوة بدون بكرة', 'Refill', 'پڕکردنەوە بەبێ ماسوورە')],
  ['Refill (No Spool)', tri('عبوة بدون بكرة', 'Refill (No Spool)', 'پڕکردنەوە بەبێ ماسوورە')],
  ['With Spool', tri('مع بكرة', 'With Spool', 'لەگەڵ ماسوورە')],
  ['Spool', tri('مع بكرة', 'Spool', 'لەگەڵ ماسوورە')],
  ['Filament with spool', tri('مع بكرة', 'Filament with spool', 'لەگەڵ ماسوورە')],
  ['Standard', tri('قياسي', 'Standard', 'ستاندارد')],
];

const BY_KEY = new Map(WORDS.map(([w, t]) => [labelKey(w), t]));

/** The authored ar/ckb names of a whole value, or null. */
export function valueWord(value: string): Tri | null {
  return BY_KEY.get(labelKey(value)) ?? null;
}

export const VALUE_WORDS: ReadonlyArray<[string, Tri]> = WORDS;
