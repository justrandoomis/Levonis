/**
 * TODAY'S APPROVAL CARD (Community V3 push 1.3, wave 1; gap row 0) — where a
 * merchant no reviewer has approved yet stands, said once, at the top of
 * Today, with the one action that moves it forward:
 *
 *   draft / none        «أكمل طلبك» / «قدّم طلب اعتماد التاجر»
 *   sent / in review    what still works, «تابع طلبك» (info — polite)
 *   changes requested   the reviewer's PUBLIC reason, «عدّل الطلب» (warning)
 *   rejected            the reviewer's PUBLIC reason, «قدّم من جديد» (warning; C8: at once)
 *
 * It REPLACES the shell's one-line approval notice on Today (the shell keeps
 * it on every other screen), so the merchant never reads the same thing
 * twice. The words are the merchant application's own
 * (src/components/merchantApplication/approvalWords.ts); the reason is the
 * reviewer's public one — the server never sends the internal note. A
 * suspension is not this card's to say: the store problems row says it.
 */
import { ShieldCheck } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import type { MerchantMe } from '../../../lib/merchant';
import { applicationCta, applicationStateWord, approvalReason } from '../../merchantApplication/approvalWords';
import { say, W } from '../shell/strings';
import { useCounterStrings } from './strings';

/** The card's tone: a decision that asks something of the merchant is a warning; a wait is information. */
export function approvalTone(app: MerchantMe['application']): 'info' | 'warning' {
  return app?.state === 'submitted' || app?.state === 'in_review' ? 'info' : 'warning';
}

export default function ApprovalCard({ me, href }: { me: MerchantMe; href: string }) {
  const { loc } = useLanguage();
  const s = useCounterStrings();
  if (me.approved !== false) return null;
  const app = me.application ?? null;
  const tone = approvalTone(app);
  return (
    <section
      aria-labelledby="cc-approval"
      className={`lv-alert ${tone === 'info' ? 'lv-alert-info' : 'lv-alert-warning'} flex flex-col gap-3 sm:flex-row sm:items-start`}
      data-approval-card={app?.state ?? 'none'}
    >
      <ShieldCheck aria-hidden="true" className={`hidden h-5 w-5 shrink-0 sm:block ${tone === 'info' ? 'text-info' : 'text-warning'}`} />
      <div className="min-w-0 flex-1 space-y-1">
        <h2 id="cc-approval" className="text-[14px] font-bold text-text-primary">
          {s.approval.title}
          {' · '}
          <span className="font-semibold text-text-secondary">{app ? applicationStateWord(app.state, loc) : say(loc, W.approval)}</span>
        </h2>
        {/* A decision is announced politely; the shell never interrupts for it (role=alert is for a suspension). */}
        <p role="status" className="text-[13px] leading-relaxed text-text-primary" data-approval-reason>
          {approvalReason(app, loc)}
        </p>
        <p className="text-[12.5px] leading-relaxed text-text-muted">{s.approval.stillWorks}</p>
      </div>
      <a href={href} className="lv-button lv-button-primary lv-button-sm shrink-0 self-start" data-approval-action={app?.state ?? 'none'}>
        {applicationCta(app, loc)}
      </a>
    </section>
  );
}
