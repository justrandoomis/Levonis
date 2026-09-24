/**
 * The ways to ask for help about ONE order.
 *
 * The chat is the order's own thread (POST /api/chats/open { orderId }) —
 * deliberately not the customer's general conversation, so "which colour did
 * you mean?" stays beside the order it is about. The ticket routes carry the
 * order id and a subject in router state for the Support page to prefill.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageCircle, LifeBuoy, PackageX, XCircle, ChevronRight } from 'lucide-react';
import { api } from '../../lib/api';
import type { ApiOrder } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import Spinner from '../ui/Spinner';
import { asLang } from './format';

const STRINGS = {
  ar: {
    chat: 'محادثة حول هذا الطلب',
    chatDesc: 'محادثة مباشرة مع الفريق مرتبطة بهذا الطلب',
    chatDescStore: 'محادثة مباشرة مع المتجر مرتبطة بهذا الطلب',
    opening: 'جارٍ فتح المحادثة…',
    chatFailed: 'تعذر فتح المحادثة.',
    ticket: 'فتح تذكرة دعم',
    ticketDesc: 'طلب رسمي يتابعه الفريق حتى الحل',
    ticketSubject: (id: string) => `الطلب ${id}`,
    delivery: 'الإبلاغ عن مشكلة في التوصيل',
    deliveryDesc: 'تأخر، عنوان خاطئ، أو طرد متضرر',
    deliverySubject: (id: string) => `مشكلة في توصيل الطلب ${id}`,
    cancel: 'إلغاء الطلب',
    cancelDesc: 'متاح ما دام الطلب بانتظار الدفع',
  },
  en: {
    chat: 'Chat about this order',
    chatDesc: 'A direct conversation with the team, tied to this order',
    chatDescStore: 'A direct conversation with the store, tied to this order',
    opening: 'Opening chat…',
    chatFailed: 'The chat could not be opened.',
    ticket: 'Open a support ticket',
    ticketDesc: 'A tracked request the team follows to resolution',
    ticketSubject: (id: string) => `Order ${id}`,
    delivery: 'Report a problem with delivery',
    deliveryDesc: 'Late, wrong address, or a damaged parcel',
    deliverySubject: (id: string) => `Delivery problem — order ${id}`,
    cancel: 'Cancel order',
    cancelDesc: 'Available while the order is pending payment',
  },
  ckb: {
    chat: 'گفتوگۆ دەربارەی ئەم داواکارییە',
    chatDesc: 'گفتوگۆی ڕاستەوخۆ لەگەڵ تیم، بەستراو بەم داواکارییە',
    // OWNER: Sorani to be written by hand — the Arabic stands in until then.
    chatDescStore: 'محادثة مباشرة مع المتجر مرتبطة بهذا الطلب',
    opening: 'کردنەوەی گفتوگۆ…',
    chatFailed: 'گفتوگۆکە نەکرایەوە.',
    ticket: 'کردنەوەی تکتی پشتگیری',
    ticketDesc: 'داواکارییەکی تۆمارکراو کە تیم بەدوایدا دەچێت',
    ticketSubject: (id: string) => `داواکاری ${id}`,
    delivery: 'ڕاپۆرتکردنی کێشەی گەیاندن',
    deliveryDesc: 'دواکەوتن، ناونیشانی هەڵە، یان پاکێجی زیانلێکەوتوو',
    deliverySubject: (id: string) => `کێشەی گەیاندن — داواکاری ${id}`,
    cancel: 'هەڵوەشاندنەوەی داواکاری',
    cancelDesc: 'بەردەستە هەتا داواکاری چاوەڕێی پارەدانە',
  },
} as const;

const ROW =
  'w-full flex items-center gap-3 min-h-[56px] px-4 py-2 text-start rounded-2xl border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] disabled:opacity-60';

export default function SupportActions({
  order,
  onCancelRequest,
}: {
  order: ApiOrder;
  onCancelRequest: (anchor: HTMLElement | null) => void;
}) {
  const { lang } = useLanguage();
  const s = STRINGS[asLang(lang)];
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const [chatError, setChatError] = useState('');

  const openChat = async () => {
    if (opening) return;
    setOpening(true);
    setChatError('');
    try {
      const res = await api.post<{ chatId: string }>('/api/chats/open', { orderId: order.id });
      navigate(`/chat/${encodeURIComponent(res.chatId)}`);
    } catch (e) {
      setChatError(e instanceof Error && e.message ? e.message : s.chatFailed);
      setOpening(false);
    }
  };

  const toSupport = (subject: string) => navigate('/support', { state: { orderId: order.id, subject } });
  const canCancel = order.can_cancel ?? order.status === 'pending';

  return (
    <div className="flex flex-col gap-2" data-support-actions>
      <button type="button" onClick={openChat} disabled={opening} className={ROW} data-open-order-chat>
        <span className="w-10 h-10 rounded-xl bg-zinc-800 flex items-center justify-center shrink-0 text-[#BAA369]">
          {opening ? <Spinner size="sm" delayMs={0} decorative /> : <MessageCircle className="w-5 h-5" aria-hidden />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-white text-[13.5px] font-bold">{opening ? s.opening : s.chat}</span>
          {/* A store order's thread is with its SELLER, who is a participant
              and is notified (audit 04 #4) — not with the Levonis team. */}
          <span className="block text-zinc-500 text-[11.5px] truncate">{order.receipt != null ? s.chatDescStore : s.chatDesc}</span>
        </span>
        <ChevronRight className="w-4 h-4 text-zinc-600 rtl:rotate-180 shrink-0" aria-hidden />
      </button>
      <p role="alert" aria-live="assertive" className={`text-red-400 text-[12px] px-1 ${chatError ? '' : 'sr-only'}`}>
        {chatError}
      </p>

      <button type="button" onClick={() => toSupport(s.ticketSubject(order.id))} className={ROW} data-open-ticket>
        <span className="w-10 h-10 rounded-xl bg-zinc-800 flex items-center justify-center shrink-0 text-zinc-300">
          <LifeBuoy className="w-5 h-5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-white text-[13.5px] font-bold">{s.ticket}</span>
          <span className="block text-zinc-500 text-[11.5px] truncate">{s.ticketDesc}</span>
        </span>
        <ChevronRight className="w-4 h-4 text-zinc-600 rtl:rotate-180 shrink-0" aria-hidden />
      </button>

      <button type="button" onClick={() => toSupport(s.deliverySubject(order.id))} className={ROW} data-report-delivery>
        <span className="w-10 h-10 rounded-xl bg-zinc-800 flex items-center justify-center shrink-0 text-zinc-300">
          <PackageX className="w-5 h-5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-white text-[13.5px] font-bold">{s.delivery}</span>
          <span className="block text-zinc-500 text-[11.5px] truncate">{s.deliveryDesc}</span>
        </span>
        <ChevronRight className="w-4 h-4 text-zinc-600 rtl:rotate-180 shrink-0" aria-hidden />
      </button>

      {canCancel && (
        <button
          type="button"
          onClick={(e) => onCancelRequest(e.currentTarget)}
          className={`${ROW} border-red-500/30 hover:bg-red-500/10 focus-visible:ring-red-400`}
          data-cancel-order={order.id}
        >
          <span className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center shrink-0 text-red-300">
            <XCircle className="w-5 h-5" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-red-200 text-[13.5px] font-bold">{s.cancel}</span>
            <span className="block text-zinc-500 text-[11.5px] truncate">{s.cancelDesc}</span>
          </span>
          <ChevronRight className="w-4 h-4 text-zinc-600 rtl:rotate-180 shrink-0" aria-hidden />
        </button>
      )}
    </div>
  );
}
