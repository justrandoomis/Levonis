/**
 * «سعر تقديري» — THE NOTICE UNDER AN ESTIMATED PRICE (docs/SMART_PRICING.md
 * §5.3–5.5; DECISIONS rows 278–281).
 *
 * A LAZY CHUNK. The product page mounts it only while the selection on screen
 * is at an estimated pre-order price, so a page with a confirmed price never
 * downloads it (tests/bundleBudget.test.ts keeps it out of the product
 * opening). Every word comes from the contract,
 * packages/contracts/src/priceEstimates.ts, which this chunk imports and the
 * page does not.
 *
 * WHAT IT SAYS. The notice — the price is an estimate, the final price may
 * differ once the order is confirmed with the supplier, a change is sent to the
 * customer to approve or cancel, and nothing extra is charged without their
 * approval. Its words are the ones the checkout acknowledgement is bound to
 * (`ESTIMATE_NOTICE_VERSION`). Then one small link: «تواصل معنا لمزيد من
 * المعلومات». No figure, source or measure is ever said here (invariant I6).
 *
 * THE LINK SENDS NOTHING. It opens the support assistant at
 * `/support?ask=price_estimate`, which asks «ما معنى السعر التقديري؟» and shows
 * the answer — readable without signing in — and hands the page the ticket's
 * subject («سؤال عن السعر التقديري: <name>», and the order on an order page) in
 * router state. The ticket form opens with it only when the customer chooses
 * to talk to the team (src/pages/Support.tsx); creating a ticket still needs
 * sign-in.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import {
  ESTIMATE_STRINGS,
  ESTIMATE_SUPPORT_INTENT,
  fillEstimateText,
  type EstimateLang,
} from '../../../packages/contracts/src/priceEstimates';

/** Where «تواصل معنا» goes: the assistant's allow-listed estimate question (src/pages/Support.tsx). */
export const ESTIMATE_SUPPORT_PATH = `/support?ask=${ESTIMATE_SUPPORT_INTENT}`;

/**
 * The router state the link hands the support page (its `TicketPrefill`): the
 * ticket subject in the reader's language, and the order when there is one.
 */
export function estimateSupportState(name: string, lang: EstimateLang, orderId?: string): { subject: string; orderId?: string } {
  const subject = fillEstimateText(ESTIMATE_STRINGS.support.subject, { name: name.trim() })[lang];
  return orderId ? { subject, orderId } : { subject };
}

export default function EstimateNotice({
  name,
  orderId,
  className = '',
}: {
  /** The product's name (English in every language, product-form mandate §3), for the ticket subject. */
  name: string;
  /** On an order's screen: the order the question is about. */
  orderId?: string;
  className?: string;
}) {
  const { lang } = useLanguage();
  const l: EstimateLang = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  return (
    <div data-estimate-notice className={`lv-surface p-4 ${className}`.trim()}>
      <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-text-secondary">
        <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span>{ESTIMATE_STRINGS.notice[l]}</span>
      </p>
      <Link
        to={ESTIMATE_SUPPORT_PATH}
        state={estimateSupportState(name, l, orderId)}
        data-estimate-contact
        className="mt-1 inline-flex min-h-11 items-center ps-6 text-[12px] font-bold text-text-primary underline underline-offset-2 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded"
      >
        {ESTIMATE_STRINGS.contact[l]}
      </Link>
    </div>
  );
}
