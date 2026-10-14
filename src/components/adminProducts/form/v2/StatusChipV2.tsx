/**
 * «● محدّثة» — ONE STATUS CHIP PER SECTION HEADER, NEVER CONTRADICTORY
 * (implementation spec §5.2 `StatusChipV2.tsx`; docs/PRICING-V2.md §2.1 rule 3,
 * P11; the clean start's «مخفي: يحتاج تسعيرًا», addendum A.7/A.13).
 *
 * One answer, one chip, decided in this order:
 *   1. held: the exchange rate waits for the owner (or pricing is paused) —
 *      nothing can move until it is approved;
 *   2. hidden: the product has never had a complete V2 write, so no customer
 *      sees it — «جاهز للنشر» when the prices are complete, else «يحتاج تسعيرًا»;
 *   3. missing: a published product's new structure lacks something (its
 *      sellable prices stay at the last good write);
 *   4. review: prices would change with this save;
 *   5. up to date.
 * The chip names; the section body says where (ReadinessV2) and the rate line
 * is the owner's (PricesSectionV2).
 */
import { missingLabel } from './missingLabel';
import type { V2Answer, V2Lang } from './v2Model';
import { v2Strings } from './v2Strings';
import { Chip, useV2Lang } from './v2Ui';

export type V2ChipKind = 'held' | 'paused' | 'hidden' | 'hidden_ready' | 'missing' | 'review' | 'current';

/** What one missing entry is called (the pricing screens' own label for the code; the code itself when unknown). */
export { missingLabel } from './missingLabel';

/** The chip of an answer, or null while there is none yet. Pure: the form's tests read it. */
export function chipOf(a: V2Answer | null, o: { owner: boolean; hidden: boolean; lang: V2Lang }): { kind: V2ChipKind; tone: 'success' | 'warning' | 'danger' | 'info'; text: string } | null {
  if (!a) return null;
  const s = v2Strings(o.lang);
  if (a.status.kind === 'held') {
    if (a.status.reason === 'ENGINE_PAUSED') return { kind: 'paused', tone: 'warning', text: s.chipPaused };
    return { kind: 'held', tone: 'warning', text: o.owner ? s.chipHeld : s.chipHeldStaff };
  }
  if (o.hidden || a.needs_pricing) {
    return a.publishable ? { kind: 'hidden_ready', tone: 'info', text: s.chipHiddenReady } : { kind: 'hidden', tone: 'warning', text: s.chipHidden };
  }
  if (a.status.kind === 'missing') {
    const first = a.status.first ?? a.missing[0] ?? null;
    return { kind: 'missing', tone: 'danger', text: s.chipMissing(first ? missingLabel(first, o.lang) : '—') };
  }
  if (a.status.kind === 'review') return { kind: 'review', tone: 'warning', text: s.chipReview(String(a.status.count)) };
  return { kind: 'current', tone: 'success', text: s.chipCurrent };
}

export default function StatusChipV2({ answer, owner, hidden }: { answer: V2Answer | null; owner: boolean; hidden: boolean }) {
  const lang = useV2Lang();
  const chip = chipOf(answer, { owner, hidden, lang });
  if (!chip) return null;
  return (
    <Chip tone={chip.tone} data={chip.kind}>
      {chip.text}
    </Chip>
  );
}
