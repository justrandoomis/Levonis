import React from 'react';
import { ChevronRight, Crown, MessageSquare } from 'lucide-react';
import type { Language } from '../../translations';
import type { Claim } from './types';
import { fmtDate, fmtInt, stageStep } from './types';
import type { WarrantyStrings } from './strings';
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
      <span aria-hidden="true" className="absolute top-[5px] h-px bg-zinc-800" style={{ insetInlineStart: '10%', insetInlineEnd: '10%' }} />
      <span
        aria-hidden="true"
        className={`absolute top-[5px] h-px ${rejected ? 'bg-zinc-500' : 'bg-[#BAA369]'}`}
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
                    ? 'bg-zinc-400 border-zinc-400 ring-4 ring-zinc-400/15'
                    : 'bg-[#BAA369] border-[#BAA369] ring-4 ring-[#BAA369]/20'
                  : done
                    ? rejected
                      ? 'bg-zinc-500 border-zinc-500'
                      : 'bg-[#BAA369] border-[#BAA369]'
                    : 'bg-zinc-900 border-zinc-700'
              }`}
            />
            <span
              className={`mt-1.5 text-[10px] leading-tight w-full truncate ${
                isCurrent ? 'text-white font-bold' : done ? 'text-zinc-400' : dead ? 'text-zinc-700' : 'text-zinc-600'
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
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-[#BAA369]/40 bg-[#BAA369]/10 text-[#BAA369] text-[10px] font-bold whitespace-nowrap">
      <Crown aria-hidden="true" className="w-3 h-3" />
      {s.priorityBadge}
    </span>
  );
}

/**
 * One claim in «مطالباتي» — and, above all, a DOOR TO ITS CONVERSATION.
 *
 * The owner: «لا يوجد هنالك توضيح أو زر معين يظهر أن عند الضغط على مطالباتي …
 * تفتح المحادثة». The whole card always opened the thread, but nothing on it
 * said so: it read as a status panel, and a customer waiting for the warranty
 * team had no reason to tap it. The last row now says what the tap does
 * («فتح المحادثة»), how much is in there, and — the part that makes it worth
 * tapping today — «رد جديد من الفريق» when the team wrote since the customer
 * last looked (the server's `unread`, never guessed here).
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
  const count = claim.message_count ?? 0;
  const unread = claim.unread === true;
  return (
    <button
      type="button"
      onClick={(e) => onOpen(claim, e.currentTarget)}
      className={`w-full text-start ${CARD} p-4 hover:border-zinc-700 transition-colors ${FOCUS} ${
        unread ? 'border-[#BAA369]/50' : ''
      }`}
      data-claim-id={claim.id}
      data-claim-unread={unread ? '1' : '0'}
      aria-label={`${claim.subject} — ${s.openThread}${unread ? ` · ${s.newReply}` : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="block text-white font-bold text-[15px] leading-tight truncate">{claim.subject}</span>
          <span className="block text-zinc-500 text-[12px] mt-0.5 truncate">
            {claim.product_name}
            {claim.serial && (
              <>
                {' · '}
                <span dir="ltr" className="font-mono">{claim.serial}</span>
              </>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {claim.priority && <PriorityBadge s={s} />}
          <time dateTime={claim.created_at} className="text-zinc-600 text-[11px] tabular-nums whitespace-nowrap">
            {fmtDate(claim.created_at, lang)}
          </time>
        </div>
      </div>

      <ClaimProgress stage={claim.stage} s={s} className="mt-4" />

      <p className="text-zinc-400 text-[13px] mt-3 line-clamp-2 whitespace-pre-wrap">{claim.description}</p>
      {claim.decision_reason && (
        <p className="text-zinc-500 text-[12px] mt-2">
          <span className="text-zinc-400 font-bold">{s.decisionReason}:</span> {claim.decision_reason}
        </p>
      )}

      <span className="mt-3 pt-3 border-t border-zinc-800/80 flex items-center gap-2 min-h-[28px]" data-claim-open-thread={claim.id}>
        <MessageSquare aria-hidden="true" className="w-4 h-4 text-[#BAA369] shrink-0" />
        <span className="text-[13px] font-bold text-[#BAA369] whitespace-nowrap">{s.openThread}</span>
        {claim.message_count !== undefined && (
          <span className="text-[12px] text-zinc-500 tabular-nums truncate">· {s.messagesCount(count, fmtInt(count, lang))}</span>
        )}
        <span className="ms-auto flex items-center gap-2 shrink-0">
          {unread && (
            <span
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#BAA369] text-black text-[11px] font-bold whitespace-nowrap"
              data-claim-new-reply={claim.id}
            >
              <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-black/70" />
              {s.newReply}
            </span>
          )}
          <ChevronRight aria-hidden="true" className="w-4 h-4 text-zinc-600 rtl:rotate-180" />
        </span>
      </span>
    </button>
  );
}
