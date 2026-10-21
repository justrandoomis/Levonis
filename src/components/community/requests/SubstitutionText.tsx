/**
 * ONE SUBSTITUTION, READ THE RIGHT WAY ROUND (P1-05 review 4).
 *
 * «{to} بدل {from} ({part})» with each side in its own isolate: a side that
 * starts with a Latin name (PLA, PETG) no longer decides the direction of the
 * line, so «PETG بدل PLA» never reads as PLA instead of PETG. The container
 * carries the direction of the reader (`readerDir`), never `auto`.
 */
import { fillNodes, type RequestStrings } from './strings';
import type { SubstitutionPiece } from './offerParts';

export function SubstitutionText({ x, s }: { x: SubstitutionPiece; s: RequestStrings }) {
  return <>{fillNodes(s.substitutionRow, { to: <bdi>{x.to}</bdi>, from: <bdi>{x.from}</bdi>, part: <bdi>{x.part}</bdi> })}</>;
}
