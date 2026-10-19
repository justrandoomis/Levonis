import React, { useState } from 'react';
import { useLanguage } from '../../LanguageContext';
import { LifeBuoy, MessageCircle, Scale } from 'lucide-react';
import TicketsDesk from './TicketsDesk';
import MessagesDesk from './MessagesDesk';
import { consoleStrings } from './strings';
import { Segmented } from '../ui/Segmented';
import { useSupportCounts } from './supportCounts';
import { useAuth } from '../../AuthContext';
import { CapabilityRefusal, ReviewerGrants } from '../adminScope/CapabilityGrants';

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
 *
 * «الشكاوى» IS ITS OWN DESK (P1-02, DECISIONS row 261): the owner, full admins,
 * and an assistant holding the owner's DISPUTES grant (`can_handle_disputes`,
 * read as `=== true`). Anyone else has no complaints tab and no count for it
 * (the server answers 0); the owner manages that grant at the foot of the desk.
 */
const ComplaintsDesk = React.lazy(() =>
  import('../adminCommunity/AdminCommunity').then((m) => ({ default: m.ComplaintsDesk }))
);

type Desk = 'tickets' | 'messages' | 'complaints';

export default function SupportQueue() {
  const { lang, dir } = useLanguage();
  const cs = consoleStrings(lang);
  const counts = useSupportCounts();
  const { user } = useAuth();
  const canHandleDisputes = user?.can_handle_disputes === true;
  const [desk, setDesk] = useState<Desk>('tickets');

  const tabs: Array<{ id: Desk; label: string; icon: React.ElementType; count: number }> = [
    { id: 'tickets', label: cs.tabTickets, icon: LifeBuoy, count: counts?.tickets_waiting ?? 0 },
    { id: 'messages', label: cs.tabMessages, icon: MessageCircle, count: counts?.chats_unread ?? 0 },
    ...(canHandleDisputes
      ? [{ id: 'complaints' as const, label: cs.tabComplaints, icon: Scale, count: counts?.complaints_open ?? 0 }]
      : []),
  ];

  return (
    <div className="space-y-3" data-support-console>
      {/* The app's one-of-N control (as «الأعضاء / صلاحية المساعد / تيليجرام»
          in the users panel): a well with one lifted thumb that travels.
          Choosing a desk changes what this screen is doing, so a radio group.
          At phone width the three words and their counts are what fit; the
          glyphs join them from `sm` up. */}
      <Segmented
        group="support-desk"
        label={cs.consoleLabel}
        dataAttr="data-support-desk"
        value={desk}
        onChange={(id) => setDesk(id as Desk)}
        items={tabs.map((t) => ({
          id: t.id,
          label: t.label,
          icon: <t.icon className="hidden h-4 w-4 shrink-0 sm:block" aria-hidden />,
          badge:
            t.count > 0 ? (
              <span className="lv-chip min-w-5 rounded-full px-1.5 text-center text-[11px] font-black tabular-nums [--chip:var(--color-info)]">
                <span className="sr-only">{cs.waiting}: </span>
                {t.count.toLocaleString(lang === 'en' ? 'en' : 'ar')}
              </span>
            ) : undefined,
        }))}
      />

      {desk === 'tickets' && <TicketsDesk />}
      {desk === 'messages' && <MessagesDesk />}
      {desk === 'complaints' &&
        (canHandleDisputes ? (
          <React.Suspense fallback={<div className="py-10 text-center text-sm text-text-muted">…</div>}>
            <ComplaintsDesk dir={dir} />
            {user?.is_owner === true && <ReviewerGrants grantKey="DISPUTES" />}
          </React.Suspense>
        ) : (
          <CapabilityRefusal code="DISPUTES_FORBIDDEN" />
        ))}
    </div>
  );
}
