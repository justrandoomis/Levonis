/**
 * «المحادثة» · «الطلب» — THE DISPUTE DESK'S WAY TO THE EVIDENCE
 * (docs/COMMUNITY_ECOSYSTEM.md §9.6 «Dispute evidence access»).
 *
 * Each complaint row and its detail now carry `chat_id` (the conversation the
 * case's order lives in) and `request_id` (the custom request behind a
 * community order; null for a store order) — `GET /api/admin/community/
 * complaints[/:id]`. «المحادثة» opens that conversation in evidence mode
 * (`/admin/chats/<id>`: the chat page, read-only, every read on the record);
 * «الطلب» opens the request's own page. Both open in a NEW TAB so the case
 * stays where it is on the desk. Whether staff may read the thread is the
 * server's answer on every read (EVIDENCE_NOT_LINKED / EVIDENCE_CLOSED), never
 * this row's: a link here is only a door.
 *
 * Rendered only when there is somewhere to go. Statically imported by the
 * community admin (../AdminCommunity.tsx), so it carries its own small words
 * (./evidenceStrings.ts), not the desk's.
 */
import { ClipboardList, MessagesSquare } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { evidenceChatHref, evidenceRequestHref, evidenceStrings } from './evidenceStrings';

const idOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The two ids off a complaint row, read defensively (an older server sends neither). */
export function evidenceIds(row: unknown): { chatId: string | null; requestId: string | null } {
  const r = row && typeof row === 'object' ? (row as { chat_id?: unknown; request_id?: unknown }) : {};
  return { chatId: idOf(r.chat_id), requestId: idOf(r.request_id) };
}

export default function EvidenceLinks({ complaint, className = '' }: { complaint: unknown; className?: string }) {
  const { lang } = useLanguage();
  const s = evidenceStrings(lang);
  const { chatId, requestId } = evidenceIds(complaint);
  if (!chatId && !requestId) return null;
  return (
    <nav aria-label={s.linksLabel} className={`flex flex-wrap gap-2 ${className}`} data-evidence-links>
      {chatId && (
        <a href={evidenceChatHref(chatId)} target="_blank" rel="noopener noreferrer" className="lv-button lv-button-secondary lv-button-sm gap-1.5" data-evidence-chat={chatId}>
          <MessagesSquare aria-hidden="true" className="h-4 w-4" />
          {s.conversation}
        </a>
      )}
      {requestId && (
        <a href={evidenceRequestHref(requestId)} target="_blank" rel="noopener noreferrer" className="lv-button lv-button-secondary lv-button-sm gap-1.5" data-evidence-request={requestId}>
          <ClipboardList aria-hidden="true" className="h-4 w-4" />
          {s.request}
        </a>
      )}
    </nav>
  );
}
