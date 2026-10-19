/**
 * READINESS BEFORE OPENING (Community V3 push 1.3, wave 1; gap row 1 —
 * Shopify's launch check, our words): when an approved merchant opens their
 * store, a verdict list built from the SERVER's state says what a customer
 * will find. Each row is a tick or a door to its fix; opening stays a
 * deliberate tap (ReadinessSheet.tsx).
 *
 * THE FACTS ARE THE CHECKLIST'S OWN READ — `attention.setup`
 * (worker/routes/merchantWorkspace.ts), the same answer «جهّز متجرك» draws —
 * never a second scan. Delivery is the re-open door's own rule
 * (`deliveryCoverage`: a governorate reached, or pickup), so the list and the
 * door cannot disagree.
 *
 * NEEDED vs RECOMMENDED. Approval, delivery, something to buy, a phone and a
 * published page are what an open store needs; a logo, a banner and «about»
 * are cosmetic — recommended, never a reason to wait. Nothing here blocks the
 * open button outright: a paused store cannot publish a product (the selling
 * gate refuses STORE_PAUSED), so a hard block on «a published product» could
 * never be lifted from inside it. A missing needed step turns the primary
 * «افتح المتجر الآن» into a secondary «افتح على أي حال» instead.
 *
 * Pure, for the tests.
 */
import type { Attention } from '../shell/attention';
import type { CounterStrings } from './strings';

export type Setup = NonNullable<Attention['setup']>;

export type ReadinessId = 'approved' | 'delivery' | 'offer' | 'phone' | 'design' | 'logo' | 'banner' | 'about';

export interface Verdict {
  id: ReadinessId;
  ok: boolean;
  /** Needed to open (true) or recommended (false). */
  required: boolean;
  /** Where it is fixed; '' for a row with no door (approval comes from a reviewer). */
  link: string;
}

/** The main-site address of the merchant application (the approval row's door). */
export const APPLICATION_LINK = '/merchant/start';

/**
 * The verdicts, needed first, in the order a merchant should take them.
 * `approved` is the server's answer on `/api/merchant/me` when the setup read
 * predates the field.
 */
export function readinessVerdicts(setup: Setup, approved: boolean): Verdict[] {
  const isApproved = setup.approved ?? approved;
  const reach = setup.reach ?? (setup.delivery ? 1 : 0);
  return [
    { id: 'approved', ok: isApproved, required: true, link: isApproved ? '' : APPLICATION_LINK },
    { id: 'delivery', ok: reach > 0 || setup.pickup === true, required: true, link: setup.links.delivery },
    { id: 'offer', ok: setup.products > 0 || (setup.services ?? 0) > 0, required: true, link: setup.links.products },
    { id: 'phone', ok: setup.phone, required: true, link: setup.links.settings },
    { id: 'design', ok: setup.design, required: true, link: setup.links.design },
    { id: 'logo', ok: setup.logo, required: false, link: setup.links.settings },
    { id: 'banner', ok: setup.banner, required: false, link: setup.links.settings },
    { id: 'about', ok: setup.about, required: false, link: setup.links.settings },
  ];
}

/** How many NEEDED steps are missing — 0 means ready to open. */
export function missingRequired(verdicts: readonly Verdict[]): number {
  return verdicts.filter((v) => v.required && !v.ok).length;
}

/** The row's words. */
export function verdictText(id: ReadinessId, s: CounterStrings): string {
  return s.readiness[id];
}

/**
 * Does flipping the switch ON go through the readiness sheet? Only for an
 * APPROVED merchant opening a store that is closed: an unapproved one is
 * refused by the server (E8) with the gate's sentence, and closing a store is
 * never held.
 */
export function opensThroughReadiness(next: boolean, approved: boolean | undefined, storeStatus: string): boolean {
  return next && approved === true && storeStatus === 'paused';
}
