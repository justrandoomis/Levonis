/**
 * THE CHAT PAGE IN EVIDENCE MODE — «قراءة فقط — مراقبة نزاع»
 * (docs/COMMUNITY_ECOSYSTEM.md §9.6 «Dispute evidence access»; the server's
 * half is worker/routes/chats.ts + worker/lib/disputeEvidence.ts).
 *
 * Staff open a store's or a request's conversation only while an order linked
 * to it is disputed (or a store order bought from it has an open complaint):
 * `/admin/chats/<id>` mounts the ordinary chat page (src/pages/Chat.tsx), and
 * in that mode the page draws no composer and no card actions, and this strip
 * under its header — what the reader is doing, that every read is on the
 * record, and the way to the request the case is about. A refused read
 * (EVIDENCE_NOT_LINKED before the dispute, EVIDENCE_CLOSED once it is
 * decided) is a page of its own, in the refusal table's words, never «not
 * found».
 *
 * A lazy chunk of the chat page: nobody but staff in evidence mode fetches it.
 */
import { Link } from 'react-router-dom';
import { ClipboardList, Eye, ShieldAlert } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { refusalText } from '../../../lib/refusalStrings';
import { useGoBack } from '../../../lib/useGoBack';
import type { ChatEvidence } from '../../community/reputation/api';
import { evidenceRequestHref, evidenceStrings } from './evidenceStrings';

const refusalLang = (lang: string): 'ar' | 'en' | 'ckb' => (lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar');

export default function EvidenceBanner({ evidence }: { evidence: ChatEvidence | null }) {
  const { lang } = useLanguage();
  const s = evidenceStrings(lang);
  const requestId = evidence?.request_id ?? null;
  return (
    <div
      role="note"
      data-chat-evidence
      className="shrink-0 border-b border-border-subtle/70 bg-surface px-3 sm:px-4 py-2 flex min-h-11 items-center gap-2.5"
    >
      <Eye aria-hidden="true" className="h-4 w-4 shrink-0 text-warning" />
      <p className="min-w-0 flex-1 text-[12.5px] leading-snug">
        <span className="block font-semibold text-text-primary">{s.title}</span>
        <span className="block text-text-muted">{s.note}</span>
      </p>
      {requestId && (
        <Link to={evidenceRequestHref(requestId)} className="lv-button lv-button-ghost lv-button-sm shrink-0 gap-1.5" data-chat-evidence-request>
          <ClipboardList aria-hidden="true" className="h-4 w-4" />
          {s.request}
        </Link>
      )}
    </div>
  );
}

/**
 * A read the evidence door refused: the sentence that says why, and the way
 * back. The desk opens a conversation in a NEW TAB, where `navigate(-1)` has
 * nowhere to go — so «رجوع» falls back to the admin console.
 */
export function EvidenceRefused({ code, onBack }: { code: string; onBack?: () => void }) {
  const { lang } = useLanguage();
  const s = evidenceStrings(lang);
  const goBack = useGoBack('/admin');
  return (
    <div className="h-full min-h-0 w-full bg-canvas flex flex-col items-center justify-center gap-4 p-8 text-center" data-chat-evidence-refused={code}>
      <ShieldAlert aria-hidden="true" className="h-12 w-12 text-text-muted" strokeWidth={1.25} />
      <h1 className="text-[17px] font-bold text-text-primary">{s.refusedTitle}</h1>
      <p className="max-w-md text-[14px] leading-relaxed text-text-secondary">{refusalText(code, refusalLang(lang))}</p>
      <button type="button" onClick={onBack ?? goBack} className="lv-button lv-button-secondary">
        {s.back}
      </button>
    </div>
  );
}
