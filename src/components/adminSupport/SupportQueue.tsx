import React, { useState } from 'react';
import { useLanguage } from '../../LanguageContext';
import { LifeBuoy, MessageCircle, Scale } from 'lucide-react';
import TicketsDesk from './TicketsDesk';
import MessagesDesk from './MessagesDesk';
import { consoleStrings } from './strings';
import { useSupportCounts } from './supportCounts';

/**
 * THE SUPPORT CONSOLE — the one place an agent answers a customer from.
 *
 * «في لوحة الإدارة لا يوجد صفحة للرد على رسائل المستخدمين ولا على الشكاوى ولا
 * على التذاكر.» The owner named three kinds of waiting customer, and the
 * console held one of them:
 *
 *   • «التذاكر» — support tickets. This was the whole console (TicketsDesk.tsx).
 *   • «الرسائل» — a customer's «محادثة حول هذا الطلب». These threads existed and
 *     nothing listed them; staff joined one only by opening that order's modal
 *     (MessagesDesk.tsx, worker/routes/adminChats.ts).
 *   • «الشكاوى» — community-marketplace complaints. They had a reply box, three
 *     menus deep under «مجتمع ليفو» → «النزاعات والشكاوى». That same screen is
 *     mounted here — the component itself, lazily, never a second copy that
 *     could drift from the one the community panel shows.
 *
 * Each tab carries the count of people waiting in it, from the same store the
 * sidebar badge reads (./supportCounts.ts), so the console and the sidebar
 * cannot disagree.
 *
 * WHY IT IS ITS OWN SIDEBAR ENTRY. It used to be the SECOND TAB of «الأعضاء
 * والدعم», a membership panel filed under marketing — a feature nobody can
 * find is, to the person looking for it, a feature that does not exist. It is
 * still mounted from the memberships panel too, so a bookmarked tab keeps
 * working; both mount this component, so the console cannot fork.
 */
const ComplaintsDesk = React.lazy(() =>
  import('../adminCommunity/AdminCommunity').then((m) => ({ default: m.ComplaintsDesk }))
);

type Desk = 'tickets' | 'messages' | 'complaints';

export default function SupportQueue() {
  const { lang, dir } = useLanguage();
  const cs = consoleStrings(lang);
  const counts = useSupportCounts();
  const [desk, setDesk] = useState<Desk>('tickets');

  const tabs: Array<{ id: Desk; label: string; icon: React.ElementType; count: number }> = [
    { id: 'tickets', label: cs.tabTickets, icon: LifeBuoy, count: counts?.tickets_waiting ?? 0 },
    { id: 'messages', label: cs.tabMessages, icon: MessageCircle, count: counts?.chats_unread ?? 0 },
    { id: 'complaints', label: cs.tabComplaints, icon: Scale, count: counts?.complaints_open ?? 0 },
  ];

  return (
    <div className="space-y-3" data-support-console>
      <div className="flex gap-1 overflow-x-auto rounded-xl bg-zinc-900 p-1 hide-scrollbar" role="tablist" aria-label={cs.consoleLabel}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={desk === t.id}
            data-support-desk={t.id}
            onClick={() => setDesk(t.id)}
            className={`flex min-h-10 min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 sm:gap-2 sm:px-3 ${
              desk === t.id ? 'bg-zinc-700/80 text-white shadow-sm' : 'text-zinc-400 hover:text-white'
            }`}
          >
            {/* At phone width the three words and their counts are what fit;
                the glyphs join them from `sm` up. */}
            <t.icon className="hidden h-4 w-4 shrink-0 sm:block" aria-hidden />
            <span>{t.label}</span>
            {t.count > 0 && (
              <span className="min-w-5 rounded-full bg-sky-500/20 px-1.5 text-center text-[11px] font-black tabular-nums text-sky-300">
                <span className="sr-only">{cs.waiting}: </span>
                {t.count.toLocaleString(lang === 'en' ? 'en' : 'ar')}
              </span>
            )}
          </button>
        ))}
      </div>

      {desk === 'tickets' && <TicketsDesk />}
      {desk === 'messages' && <MessagesDesk />}
      {desk === 'complaints' && (
        <React.Suspense fallback={<div className="py-10 text-center text-sm text-zinc-500">…</div>}>
          <ComplaintsDesk dir={dir} />
        </React.Suspense>
      )}
    </div>
  );
}
