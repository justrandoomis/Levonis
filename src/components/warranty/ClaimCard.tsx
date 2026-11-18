import React from 'react';
import { ChevronRight, Crown, Gift, MessageSquare } from 'lucide-react';
import type { Language } from '../../translations';
import type { Claim } from './types';
import { claimOpen, fmtCount, fmtDate, fmtInt, stageStep } from './types';
import type { CareStrings, WarrantyStrings } from './strings';
import { CARE_STRINGS } from './strings';
import { StatusChip } from '../ui/Badge';
import { CARD, FOCUS } from './ui';

/**
 * received → diagnosing → decision → repair → resolved, as five dots on one
 * hairline. The current dot is gold; a rejection is drawn in grey because a
 * refusal is a decision, not progress, and the steps after it are dimmed
 * rather than removed so the line keeps its shape from card to card.
 */
export function ClaimProgress({ stage, s, className = '' }: { stage: string; s: WarrantyStrings; className?: string }) {
  const current = stageStep(stage);
  const rejected = stage === 'rejected';
  const labels = [
    s.stageLabels.received,
    s.stageLabels.diagnosing,
    rejected ? s.stageLabels.rejected : stage === 'approved' ? s.stageLabels.approved : s.decisionStep,
    stage === 'replaced' ? s.stageLabels.replaced : s.stageLabels.repairing,
    s.stageLabels.resolved,
  ];
  // Dot centres sit at 10%, 30%, 50%, 70%, 90% of the row (five equal
  // columns), so the line spans 80% and the fill is that span times progress.
  const fill = `${(current / 4) * 80}%`;

  return (
    <ol className={`relative grid grid-cols-5 gap-1 ${className}`}>
      {/* the line, drawn behind the dots between the first and last centres */}
      <span aria-hidden="true" className="absolute top-[5px] h-px bg-border-subtle" style={{ insetInlineStart: '10%', insetInlineEnd: '10%' }} />
      <span
        aria-hidden="true"
        className={`absolute top-[5px] h-px ${rejected ? 'bg-text-muted' : 'bg-gold'}`}
        style={{ insetInlineStart: '10%', width: fill }}
      />
      {labels.map((label, i) => {
        const done = i < current;
        const isCurrent = i === current;
        const dead = rejected && i > current;
        return (
          <li key={i} aria-current={isCurrent ? 'step' : undefined} className="relative flex flex-col items-center text-center min-w-0">
            <span
              aria-hidden="true"
              className={`w-[11px] h-[11px] rounded-full border-2 ${
                isCurrent
                  ? rejected
                    ? 'bg-text-muted border-text-muted ring-4 ring-text-muted/15'
                    : 'bg-gold border-gold ring-4 ring-gold/20'
                  : done
                    ? rejected
                      ? 'bg-text-muted border-text-muted'
                      : 'bg-gold border-gold'
                    : 'bg-surface border-border-subtle'
              }`}
            />
            <span
              className={`mt-1.5 text-[10px] leading-tight w-full truncate ${
                isCurrent ? 'text-text-primary font-bold' : done ? 'text-text-secondary' : dead ? 'text-text-muted/60' : 'text-text-muted'
              }`}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function PriorityBadge({ s }: { s: WarrantyStrings }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-gold/40 bg-gold/10 text-gold text-[10px] font-bold whitespace-nowrap">
      <Crown aria-hidden="true" className="w-3 h-3" />
      {s.priorityBadge}
    </span>
  );
}

/** The team wrote since the customer last looked — the server's `unread`, never guessed here. */
function NewReply({ id, s }: { id: string; s: WarrantyStrings }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-gold text-accent-contrast text-[11px] font-bold whitespace-nowrap"
      data-claim-new-reply={id}
    >
      <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-black/70" />
      {s.newReply}
    </span>
  );
}

/**
 * What waits for the customer INSIDE the conversation, said outside it: a part
 * the team offered at a Levo Care discount (`part_offers_live`), or a quote to
 * accept (`care_quote_state`, read only when a server sends it).
 */
export function claimWaiting(claim: Claim, lang: Language, c: CareStrings): string | null {
  const offers = Number(claim.part_offers_live) || 0;
  if (offers > 0) return c.offerWaiting(offers, fmtCount(offers));
  if (claim.care_quote_state === 'quoted') return c.quoteWaiting;
  return null;
}

function Waiting({ text }: { text: string }) {
  return (
    <span className="mt-2 flex items-center gap-1.5 text-[12.5px] font-bold leading-snug" style={{ color: 'var(--color-info)' }} data-claim-waiting>
      <Gift aria-hidden="true" className="w-4 h-4 shrink-0" />
      <span className="min-w-0">{text}</span>
    </span>
  );
}

/**
 * One request in «مطالباتي» — and, above all, a DOOR TO ITS CONVERSATION.
 *
 * The owner: «لا يوجد هنالك توضيح أو زر معين يظهر أن عند الضغط على مطالباتي …
 * تفتح المحادثة». The last row says what the tap does («فتح المحادثة»), how
 * much is in there, and — the part that makes it worth tapping today — «رد
 * جديد من الفريق» when the team wrote since the customer last looked. The head
 * names the device the request is about, and whether it is a Levo Care request.
 */
export function ClaimCard({
  claim,
  lang,
  s,
  onOpen,
}: {
  claim: Claim;
  lang: Language;
  s: WarrantyStrings;
  onOpen: (claim: Claim, trigger: HTMLElement) => void;
}) {
  const c = CARE_STRINGS[lang];
  const count = claim.message_count ?? 0;
  const unread = claim.unread === true;
  const waiting = claimWaiting(claim, lang, c);
  return (
    <button
      type="button"
      onClick={(e) => onOpen(claim, e.currentTarget)}
      className={`w-full text-start ${CARD} p-4 hover:bg-surface-raised transition-colors ${FOCUS} ${unread ? 'border-gold/50' : ''}`}
      data-claim-id={claim.id}
      data-claim-unread={unread ? '1' : '0'}
      aria-label={`${claim.subject} — ${s.openThread}${unread ? ` · ${s.newReply}` : ''}${waiting ? ` · ${waiting}` : ''}`}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-text-primary font-bold text-[15px] leading-tight truncate">{claim.subject}</span>
          <span className="block text-text-muted text-[12px] mt-0.5 truncate">
            {claim.product_name}
            {claim.serial && (
              <>
                {' · '}
                <span dir="ltr" className="font-mono">{claim.serial}</span>
              </>
            )}
          </span>
        </span>
        <time dateTime={claim.created_at} className="text-text-muted text-[11px] tabular-nums whitespace-nowrap shrink-0 pt-0.5">
          {fmtDate(claim.created_at, lang)}
        </time>
      </span>
      {(claim.claim_kind === 'care' || claim.priority) && (
        <span className="mt-2 flex flex-wrap items-center gap-1.5">
          {claim.claim_kind === 'care' && (
            <StatusChip tone="info" dot={false} className="whitespace-nowrap">
              <span data-claim-kind="care">{c.claimBadge}</span>
            </StatusChip>
          )}
          {claim.priority && <PriorityBadge s={s} />}
        </span>
      )}

      <ClaimProgress stage={claim.stage} s={s} className="mt-4" />

      <span className="block text-text-secondary text-[13px] mt-3 line-clamp-2 whitespace-pre-wrap">{claim.description}</span>
      {claim.decision_reason && (
        <span className="block text-text-muted text-[12px] mt-2">
          <span className="text-text-secondary font-bold">{s.decisionReason}:</span> {claim.decision_reason}
        </span>
      )}
      {waiting && <Waiting text={waiting} />}

      <span className="mt-3 pt-3 border-t border-border-subtle flex items-center gap-2 min-h-[28px]" data-claim-open-thread={claim.id}>
        <MessageSquare aria-hidden="true" className="w-4 h-4 text-gold shrink-0" />
        <span className="text-[13px] font-bold text-gold whitespace-nowrap">{s.openThread}</span>
        {claim.message_count !== undefined && (
          <span className="text-[12px] text-text-muted tabular-nums truncate">· {s.messagesCount(count, fmtInt(count, lang))}</span>
        )}
        <span className="ms-auto flex items-center gap-2 shrink-0">
          {unread && <NewReply id={claim.id} s={s} />}
          <ChevronRight aria-hidden="true" className="w-4 h-4 text-text-muted rtl:rotate-180" />
        </span>
      </span>
    </button>
  );
}

/**
 * The same request ON ITS PRINTER'S CARD: one compact row — the subject, where
 * it stands, and what waits inside — that opens the conversation.
 */
export function ClaimRow({
  claim,
  lang,
  s,
  onOpen,
}: {
  claim: Claim;
  lang: Language;
  s: WarrantyStrings;
  onOpen: (claim: Claim, trigger: HTMLElement) => void;
}) {
  const c = CARE_STRINGS[lang];
  const unread = claim.unread === true;
  const waiting = claimWaiting(claim, lang, c);
  const stage = s.stageLabels[claim.stage] ?? claim.stage;
  return (
    <button
      type="button"
      onClick={(e) => onOpen(claim, e.currentTarget)}
      className={`flex w-full min-h-14 items-center gap-3 rounded-xl border px-3 py-2 text-start hover:bg-surface-raised transition-colors ${FOCUS} ${
        unread ? 'border-gold/50' : 'border-border-subtle'
      }`}
      data-claim-row={claim.id}
      aria-label={`${claim.subject} — ${stage} · ${s.openThread}${unread ? ` · ${s.newReply}` : ''}${waiting ? ` · ${waiting}` : ''}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-bold leading-tight text-text-primary">{claim.subject}</span>
        <span className="mt-0.5 block truncate text-[12px] text-text-muted">
          {claim.claim_kind === 'care' ? `${c.claimBadge} · ` : ''}
          {stage}
          {claimOpen(claim) ? '' : ` · ${fmtDate(claim.created_at, lang)}`}
        </span>
        {waiting && <Waiting text={waiting} />}
        {unread && (
          <span className="mt-1.5 block">
            <NewReply id={claim.id} s={s} />
          </span>
        )}
      </span>
      <ChevronRight aria-hidden="true" className="w-4 h-4 shrink-0 text-text-muted rtl:rotate-180" />
    </button>
  );
}
