/**
 * ONE SUBSTITUTION, READ THE RIGHT WAY ROUND (P1-05 reviews 4 and 5).
 *
 * «{to} بدل {from} ({part})» with each side in its own isolate: a side that
 * starts with a Latin name (PLA, PETG) no longer decides the direction of the
 * line, so «PETG بدل PLA» never reads as PLA instead of PETG. Each isolate
 * takes the direction of the READER (`dir`, from `readerDir`), never `auto`:
 * a side «PETG أحمر» or «TPU مرن» laid out left to right inside its isolate
 * reads its words backwards to an Arabic or Sorani reader (review 5). The
 * container carries the same direction.
 */
import { fillNodes, type RequestStrings } from './strings';
import type { SubstitutionPiece } from './offerParts';

export function SubstitutionText({ x, s, dir }: { x: SubstitutionPiece; s: RequestStrings; dir: 'ltr' | 'rtl' }) {
  return <>{fillNodes(s.substitutionRow, { to: <bdi dir={dir}>{x.to}</bdi>, from: <bdi dir={dir}>{x.from}</bdi>, part: <bdi dir={dir}>{x.part}</bdi> })}</>;
}
