import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { useSignInPrompt } from '../lib/guest';
import { api, ApiError } from '../lib/api';
import {
  ArrowLeft,
  ArrowRight,
  Send,
  LifeBuoy,
  MessageSquare,
  RefreshCw,
  ChevronDown,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';

/**
 * Guided, deterministic (non-AI) support assistant + real support tickets.
 * Button-first navigation; free text goes through the server's keyword
 * dictionaries and comes back as an answer or clarifying choices — never a
 * guess. Conversation state lives client-side only. Escalation to a human
 * creates a REAL ticket after an explicit confirmation step; nothing shows
 * success before the server confirms.
 */

// ------------------------------------------------------------------- types

interface AsstLink {
  label: string;
  to: string;
}
interface AsstChoice {
  label: string;
  intent: string;
  params?: Record<string, unknown>;
}
interface AsstCard {
  title: string;
  subtitle?: string;
  image?: string;
  badge?: string;
  fields?: Array<{ label: string; value: string }>;
  link?: AsstLink;
}
interface AsstReply {
  intent: string;
  text: string;
  cards?: AsstCard[];
  choices?: AsstChoice[];
  links?: AsstLink[];
  auth_required?: boolean;
  handoff?: boolean;
}

interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
  reply?: AsstReply;
  error?: boolean;
}

interface Ticket {
  id: string;
  subject: string;
  order_id: string | null;
  unit_id: string | null;
  priority: number;
  state: 'open' | 'waiting_customer' | 'waiting_staff' | 'resolved';
  created_at: string;
  updated_at: string;
  message_count?: number;
}
interface TicketMsg {
  id: string;
  body: string;
  is_staff: boolean;
  created_at: string;
}

interface OrderOption {
  id: string;
  status: string;
  total_iqd: number;
  created_at: string;
}
interface DeviceOption {
  unit_id: string;
  product: { name: string; name_ar: string; name_ckb?: string };
  serial: string | null;
}

// ----------------------------------------------------------------- strings

const STRINGS = {
  ar: {
    title: 'الدعم والمساعدة',
    tabAssistant: 'المساعد',
    tabTickets: 'تذاكري',
    greeting:
      'مرحبًا! أنا مساعد ليفونيس الآلي (بدون ذكاء اصطناعي — قواعد ثابتة وبيانات حسابك الحقيقية فقط). اختر موضوعًا أو اكتب سؤالك:',
    inputPlaceholder: 'اكتب سؤالك...',
    send: 'إرسال',
    thinking: 'جارٍ البحث...',
    netError: 'تعذر الاتصال بالخادم — حاول مرة أخرى.',
    openTicketCta: 'إنشاء تذكرة دعم',
    ticketFormTitle: 'تذكرة دعم جديدة',
    subject: 'الموضوع',
    message: 'الرسالة',
    linkOrder: 'ربط بطلب (اختياري)',
    linkDevice: 'ربط بجهاز (اختياري)',
    noLink: 'بدون ربط',
    next: 'متابعة',
    cancel: 'إلغاء',
    confirmTitle: 'تأكيد إرسال التذكرة',
    confirmBody: 'ستُرسل هذه التذكرة إلى فريق ليفونيس. راجع التفاصيل ثم أكّد.',
    confirmSend: 'تأكيد وإرسال',
    back: 'رجوع',
    creating: 'جارٍ الإنشاء...',
    created: 'تم إنشاء التذكرة بنجاح. سيرد الفريق هنا.',
    proPriority: 'أولوية PRO',
    stateOpen: 'مفتوحة',
    stateWaitingCustomer: 'بانتظار ردك',
    stateWaitingStaff: 'بانتظار الفريق',
    stateResolved: 'محلولة',
    ticketsEmpty: 'لا توجد تذاكر بعد. استخدم المساعد لفتح تذكرة عند الحاجة.',
    ticketsSignIn: 'سجّل الدخول لعرض تذاكرك وفتح تذاكر جديدة.',
    signIn: 'تسجيل الدخول',
    replyPlaceholder: 'اكتب ردك...',
    reply: 'رد',
    you: 'أنت',
    staff: 'فريق ليفونيس',
    loading: 'جارٍ التحميل...',
    loadError: 'تعذر التحميل — حاول مجددًا.',
    retry: 'إعادة المحاولة',
    subjectRequired: 'الموضوع مطلوب (3 أحرف على الأقل)',
    messageRequired: 'الرسالة مطلوبة (5 أحرف على الأقل)',
    menu: [
      { intent: 'order_status', label: 'حالة طلبي' },
      { intent: 'delivery_estimate', label: 'موعد التوصيل' },
      { intent: 'my_devices', label: 'أجهزتي' },
      { intent: 'warranty_status', label: 'الضمان' },
      { intent: 'points_balance', label: 'نقاطي' },
      { intent: 'membership_status', label: 'عضويتي' },
      { intent: 'return_help', label: 'الإرجاع' },
      { intent: 'password_help', label: 'كلمة المرور' },
      { intent: 'product_search', label: 'بحث عن منتج' },
      { intent: 'policy_question', label: 'السياسات' },
      { intent: 'human_handoff', label: 'التحدث مع الفريق' },
    ],
  },
  en: {
    title: 'Support & Help',
    tabAssistant: 'Assistant',
    tabTickets: 'My tickets',
    greeting:
      'Hello! I am the LEVONIS assistant (no AI — fixed rules over your real account data only). Pick a topic or type your question:',
    inputPlaceholder: 'Type your question...',
    send: 'Send',
    thinking: 'Looking that up...',
    netError: 'Could not reach the server — please try again.',
    openTicketCta: 'Create a support ticket',
    ticketFormTitle: 'New support ticket',
    subject: 'Subject',
    message: 'Message',
    linkOrder: 'Link an order (optional)',
    linkDevice: 'Link a device (optional)',
    noLink: 'No link',
    next: 'Continue',
    cancel: 'Cancel',
    confirmTitle: 'Confirm sending the ticket',
    confirmBody: 'This ticket will be sent to the LEVONIS team. Review the details, then confirm.',
    confirmSend: 'Confirm & send',
    back: 'Back',
    creating: 'Creating...',
    created: 'Ticket created successfully. The team will reply here.',
    proPriority: 'PRO priority',
    stateOpen: 'Open',
    stateWaitingCustomer: 'Waiting for you',
    stateWaitingStaff: 'Waiting for staff',
    stateResolved: 'Resolved',
    ticketsEmpty: 'No tickets yet. Use the assistant to open one when needed.',
    ticketsSignIn: 'Sign in to view your tickets and open new ones.',
    signIn: 'Sign in',
    replyPlaceholder: 'Write your reply...',
    reply: 'Reply',
    you: 'You',
    staff: 'LEVONIS team',
    loading: 'Loading...',
    loadError: 'Failed to load — try again.',
    retry: 'Retry',
    subjectRequired: 'Subject is required (at least 3 characters)',
    messageRequired: 'Message is required (at least 5 characters)',
    menu: [
      { intent: 'order_status', label: 'My order status' },
      { intent: 'delivery_estimate', label: 'Delivery estimate' },
      { intent: 'my_devices', label: 'My devices' },
      { intent: 'warranty_status', label: 'Warranty' },
      { intent: 'points_balance', label: 'My points' },
      { intent: 'membership_status', label: 'My membership' },
      { intent: 'return_help', label: 'Returns' },
      { intent: 'password_help', label: 'Password' },
      { intent: 'product_search', label: 'Search products' },
      { intent: 'policy_question', label: 'Policies' },
      { intent: 'human_handoff', label: 'Talk to the team' },
    ],
  },
  ckb: {
    title: 'پشتگیری و یارمەتی',
    tabAssistant: 'یاریدەدەر',
    tabTickets: 'تیکێتەکانم',
    greeting:
      'سڵاو! من یاریدەدەری ليڤۆنیسم (بەبێ زیرەکی دەستکرد — تەنها یاسا نەگۆڕەکان و داتای ڕاستەقینەی هەژمارەکەت). بابەتێک هەڵبژێرە یان پرسیارەکەت بنووسە:',
    inputPlaceholder: 'پرسیارەکەت بنووسە...',
    send: 'ناردن',
    thinking: 'گەڕان بەردەوامە...',
    netError: 'پەیوەندی بە ڕاژەکار نەکرا — دووبارە هەوڵ بدەرەوە.',
    openTicketCta: 'دروستکردنی تیکێتی پشتگیری',
    ticketFormTitle: 'تیکێتی پشتگیری نوێ',
    subject: 'بابەت',
    message: 'پەیام',
    linkOrder: 'بەستنەوە بە داواکارییەک (ئارەزوومەندانە)',
    linkDevice: 'بەستنەوە بە ئامێرێک (ئارەزوومەندانە)',
    noLink: 'بەبێ بەستنەوە',
    next: 'بەردەوامبوون',
    cancel: 'هەڵوەشاندنەوە',
    confirmTitle: 'پشتڕاستکردنەوەی ناردنی تیکێت',
    confirmBody: 'ئەم تیکێتە بۆ تیمی ليڤۆنیس دەنێردرێت. وردەکارییەکان بپشکنە و پاشان پشتڕاست بکەرەوە.',
    confirmSend: 'پشتڕاستکردنەوە و ناردن',
    back: 'گەڕانەوە',
    creating: 'دروستکردن بەردەوامە...',
    created: 'تیکێتەکە بە سەرکەوتوویی دروستکرا. تیمەکە لێرە وەڵام دەداتەوە.',
    proPriority: 'پێشینەیی PRO',
    stateOpen: 'کراوەیە',
    stateWaitingCustomer: 'چاوەڕوانی وەڵامی تۆیە',
    stateWaitingStaff: 'چاوەڕوانی تیمەکەیە',
    stateResolved: 'چارەسەرکراوە',
    ticketsEmpty: 'هێشتا هیچ تیکێتێک نییە. لە کاتی پێویستدا یاریدەدەرەکە بەکاربهێنە بۆ کردنەوەی تیکێت.',
    ticketsSignIn: 'بچۆ ژوورەوە بۆ بینینی تیکێتەکانت و کردنەوەی تیکێتی نوێ.',
    signIn: 'چوونەژوورەوە',
    replyPlaceholder: 'وەڵامەکەت بنووسە...',
    reply: 'وەڵام',
    you: 'تۆ',
    staff: 'تیمی ليڤۆنیس',
    loading: 'بارکردن...',
    loadError: 'بارکردن سەرکەوتوو نەبوو — دووبارە هەوڵ بدەرەوە.',
    retry: 'هەوڵدانەوە',
    subjectRequired: 'بابەت پێویستە (لانیکەم 3 پیت)',
    messageRequired: 'پەیام پێویستە (لانیکەم 5 پیت)',
    menu: [
      { intent: 'order_status', label: 'دۆخی داواکاریم' },
      { intent: 'delivery_estimate', label: 'کاتی گەیاندن' },
      { intent: 'my_devices', label: 'ئامێرەکانم' },
      { intent: 'warranty_status', label: 'گەرەنتی' },
      { intent: 'points_balance', label: 'خاڵەکانم' },
      { intent: 'membership_status', label: 'ئەندامێتیم' },
      { intent: 'return_help', label: 'گەڕاندنەوە' },
      { intent: 'password_help', label: 'وشەی نهێنی' },
      { intent: 'product_search', label: 'گەڕان بۆ بەرهەم' },
      { intent: 'policy_question', label: 'سیاسەتەکان' },
      { intent: 'human_handoff', label: 'قسە لەگەڵ تیمەکە' },
    ],
  },
};

type SupportStrings = (typeof STRINGS)['en'];

const STATE_STYLES: Record<Ticket['state'], string> = {
  open: 'bg-blue-500/10 text-blue-400',
  waiting_customer: 'bg-amber-500/10 text-amber-400',
  waiting_staff: 'bg-purple-500/10 text-purple-400',
  resolved: 'bg-emerald-500/10 text-emerald-400',
};

function stateLabel(s: SupportStrings, state: Ticket['state']): string {
  if (state === 'open') return s.stateOpen;
  if (state === 'waiting_customer') return s.stateWaitingCustomer;
  if (state === 'waiting_staff') return s.stateWaitingStaff;
  return s.stateResolved;
}

function fmtDate(iso: string, lang: string): string {
  try {
    return new Date(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : 'ar-IQ', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

// ------------------------------------------------------------- card render

function ReplyCard({ card, onNavigate }: { card: AsstCard; onNavigate: (to: string) => void }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 flex gap-3 items-start">
      {card.image && (
        <img
          referrerPolicy="no-referrer"
          src={card.image}
          alt=""
          className="w-12 h-12 rounded-lg object-cover border border-zinc-800 shrink-0"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold text-white break-words">{card.title}</span>
          {card.badge && <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 font-bold">{card.badge}</span>}
        </div>
        {card.subtitle && <div className="text-xs text-zinc-400 mt-0.5 break-words">{card.subtitle}</div>}
        {card.fields && card.fields.length > 0 && (
          <div className="mt-1.5 space-y-0.5">
            {card.fields.map((f, i) => (
              <div key={i} className="text-xs text-zinc-400">
                <span className="text-zinc-500">{f.label}: </span>
                <span className="text-zinc-300">{f.value}</span>
              </div>
            ))}
          </div>
        )}
        {card.link && (
          <button
            onClick={() => onNavigate(card.link!.to)}
            className="mt-2 text-xs font-bold text-[#2CE59B] hover:underline"
          >
            {card.link.label} ←
          </button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- ticket form

/** Values another page may hand over through router state (e.g. the warranty
 *  center's "Contact support" on a printer card). */
export interface TicketPrefill {
  unitId?: string;
  orderId?: string;
  subject?: string;
}

function TicketForm({
  s,
  lang,
  loc,
  initial,
  onClose,
  onCreated,
}: {
  s: SupportStrings;
  lang: string;
  loc: (ar: string, en: string, ckb?: string) => string;
  initial?: TicketPrefill;
  onClose: () => void;
  onCreated: (t: Ticket) => void;
}) {
  const [subject, setSubject] = useState(initial?.subject ?? '');
  const [body, setBody] = useState('');
  const [orderId, setOrderId] = useState(initial?.orderId ?? '');
  const [unitId, setUnitId] = useState(initial?.unitId ?? '');
  const [orders, setOrders] = useState<OrderOption[]>([]);
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Selectors are fed ONLY from the signed-in user's own data.
    api
      .get<{ orders: Array<{ id: string; status: string; total_iqd: number; created_at: string }> }>('/api/orders')
      .then((d) => setOrders((d.orders || []).slice(0, 20).map((o) => ({ id: o.id, status: o.status, total_iqd: o.total_iqd, created_at: o.created_at }))))
      .catch(() => {});
    api
      .get<{ devices: DeviceOption[] }>('/api/devices/mine')
      .then((d) => setDevices(d.devices || []))
      .catch(() => {});
  }, []);

  // A prefilled id that is not among the loaded rows — the order list is
  // capped at 20, a device may no longer be linked — gets an option of its
  // own, labelled with the id, so what the select shows is what the form
  // sends. Without it the browser displays the first option while the form
  // still posts the handed-over id.
  const prefillOrderId = initial?.orderId;
  const prefillUnitId = initial?.unitId;
  const orderOptions: OrderOption[] =
    prefillOrderId && !orders.some((o) => o.id === prefillOrderId)
      ? [{ id: prefillOrderId, status: '', total_iqd: 0, created_at: '' }, ...orders]
      : orders;
  const deviceOptions: DeviceOption[] =
    prefillUnitId && !devices.some((d) => d.unit_id === prefillUnitId)
      ? [{ unit_id: prefillUnitId, product: { name: prefillUnitId, name_ar: prefillUnitId }, serial: null }, ...devices]
      : devices;

  const goConfirm = () => {
    if (subject.trim().length < 3) {
      setError(s.subjectRequired);
      return;
    }
    if (body.trim().length < 5) {
      setError(s.messageRequired);
      return;
    }
    setError('');
    setStep('confirm');
  };

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const data = await api.post<{ ticket: Ticket }>('/api/support/tickets', {
        confirm: true,
        subject: subject.trim(),
        body: body.trim(),
        order_id: orderId || undefined,
        unit_id: unitId || undefined,
        source: 'assistant',
      });
      onCreated(data.ticket);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : s.netError);
      setBusy(false);
    }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-white font-bold text-sm">{step === 'form' ? s.ticketFormTitle : s.confirmTitle}</h3>
        <button onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-300">
          {s.cancel}
        </button>
      </div>

      {step === 'form' ? (
        <>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={200}
            placeholder={s.subject}
            className="w-full bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={4000}
            rows={4}
            placeholder={s.message}
            className="w-full bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-600 resize-none"
          />
          <div>
            <label className="text-xs text-zinc-500 block mb-1">{s.linkOrder}</label>
            <div className="relative">
              <select
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                className="w-full appearance-none bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none"
              >
                <option value="">{s.noLink}</option>
                {orderOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.id}
                    {o.created_at ? ` · ${fmtDate(o.created_at, lang)}` : ''}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-4 h-4 text-zinc-600 absolute top-3 ltr:right-3 rtl:left-3 pointer-events-none" />
            </div>
          </div>
          <div>
            <label className="text-xs text-zinc-500 block mb-1">{s.linkDevice}</label>
            <div className="relative">
              <select
                value={unitId}
                onChange={(e) => setUnitId(e.target.value)}
                className="w-full appearance-none bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none"
              >
                <option value="">{s.noLink}</option>
                {deviceOptions.map((d) => (
                  <option key={d.unit_id} value={d.unit_id}>
                    {loc(d.product.name_ar, d.product.name, d.product.name_ckb)} {d.serial ? `(${d.serial})` : ''}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-4 h-4 text-zinc-600 absolute top-3 ltr:right-3 rtl:left-3 pointer-events-none" />
            </div>
          </div>
          {error && <div className="text-xs text-red-400">{error}</div>}
          <button
            onClick={goConfirm}
            className="w-full py-2.5 rounded-xl bg-[#2CE59B] text-black text-sm font-black hover:opacity-90 transition-opacity"
          >
            {s.next}
          </button>
        </>
      ) : (
        <>
          <p className="text-xs text-zinc-400">{s.confirmBody}</p>
          <div className="bg-black border border-zinc-800 rounded-xl p-3 space-y-1">
            <div className="text-sm text-white font-bold break-words">{subject}</div>
            <div className="text-xs text-zinc-400 whitespace-pre-wrap break-words">{body}</div>
            {orderId && <div className="text-xs text-zinc-500 font-mono">{orderId}</div>}
          </div>
          {error && <div className="text-xs text-red-400">{error}</div>}
          <div className="flex gap-2">
            <button
              onClick={() => setStep('form')}
              disabled={busy}
              className="flex-1 py-2.5 rounded-xl bg-zinc-800 text-zinc-300 text-sm font-bold disabled:opacity-50"
            >
              {s.back}
            </button>
            <button
              onClick={create}
              disabled={busy}
              className="flex-1 py-2.5 rounded-xl bg-[#2CE59B] text-black text-sm font-black disabled:opacity-50"
            >
              {busy ? s.creating : s.confirmSend}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------ tickets tab

function TicketsTab({ s, lang, refreshKey }: { s: SupportStrings; lang: string; refreshKey: number }) {
  const { isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [thread, setThread] = useState<{ ticket: Ticket; messages: TicketMsg[] } | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyError, setReplyError] = useState('');

  const load = useCallback(async () => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const d = await api.get<{ tickets: Ticket[] }>('/api/support/tickets');
      setTickets(d.tickets || []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : s.loadError);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, s.loadError]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const openThread = useCallback(
    async (id: string) => {
      setOpenId(id);
      setThreadLoading(true);
      setThread(null);
      setReplyError('');
      try {
        const d = await api.get<{ ticket: Ticket; messages: TicketMsg[] }>(`/api/support/tickets/${id}`);
        setThread({ ticket: d.ticket, messages: d.messages || [] });
      } catch (e) {
        setReplyError(e instanceof ApiError ? e.message : s.loadError);
      } finally {
        setThreadLoading(false);
      }
    },
    [s.loadError]
  );

  const sendReply = async () => {
    if (!openId || replyText.trim().length === 0) return;
    setReplyBusy(true);
    setReplyError('');
    try {
      await api.post(`/api/support/tickets/${openId}/messages`, { body: replyText.trim() });
      setReplyText('');
      await openThread(openId);
      await load();
    } catch (e) {
      setReplyError(e instanceof ApiError ? e.message : s.netError);
    } finally {
      setReplyBusy(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="text-center py-12 text-zinc-400 bg-zinc-900/50 rounded-xl border border-zinc-800/50 space-y-3">
        <p>{s.ticketsSignIn}</p>
        <button onClick={() => signIn()} className="px-4 py-2 rounded-xl bg-[#2CE59B] text-black text-sm font-black">
          {s.signIn}
        </button>
      </div>
    );
  }

  if (openId) {
    return (
      <div className="space-y-3">
        <button onClick={() => setOpenId(null)} className="text-xs text-zinc-400 hover:text-white font-bold">
          ← {s.back}
        </button>
        {threadLoading ? (
          <div className="text-center py-8 text-zinc-500">{s.loading}</div>
        ) : thread ? (
          <>
            <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-white font-bold text-sm break-words">{thread.ticket.subject}</span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${STATE_STYLES[thread.ticket.state]}`}>
                  {stateLabel(s, thread.ticket.state)}
                </span>
                {thread.ticket.priority === 1 && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-yellow-500/10 text-yellow-400">{s.proPriority}</span>
                )}
              </div>
              {thread.ticket.order_id && <div className="text-xs text-zinc-500 font-mono mt-1">{thread.ticket.order_id}</div>}
            </div>
            <div className="space-y-2">
              {thread.messages.map((m) => (
                <div key={m.id} className={`flex ${m.is_staff ? 'justify-start' : 'justify-end'}`}>
                  <div
                    className={`max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                      m.is_staff ? 'bg-zinc-900 border border-zinc-800 text-zinc-200' : 'bg-[#2CE59B]/10 border border-[#2CE59B]/20 text-zinc-100'
                    }`}
                  >
                    <div className="text-[10px] text-zinc-500 mb-0.5">
                      {m.is_staff ? s.staff : s.you} · {fmtDate(m.created_at, lang)}
                    </div>
                    {m.body}
                  </div>
                </div>
              ))}
            </div>
            {replyError && <div className="text-xs text-red-400">{replyError}</div>}
            <div className="flex gap-2">
              <input
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') sendReply();
                }}
                maxLength={4000}
                placeholder={s.replyPlaceholder}
                className="flex-1 min-w-0 bg-black border border-zinc-800 rounded-xl px-3 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
              />
              <button
                onClick={sendReply}
                disabled={replyBusy || replyText.trim().length === 0}
                className="px-4 rounded-xl bg-[#2CE59B] text-black text-sm font-black disabled:opacity-50"
              >
                {s.reply}
              </button>
            </div>
          </>
        ) : (
          <div className="text-center py-8 text-red-400 text-sm">{replyError || s.loadError}</div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={load} className="p-2 bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-400 hover:text-white">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {loading ? (
        <div className="text-center py-8 text-zinc-500">{s.loading}</div>
      ) : error ? (
        <div className="text-center py-8 text-red-400 text-sm space-y-2">
          <div>{error}</div>
          <button onClick={load} className="text-xs text-zinc-400 underline">
            {s.retry}
          </button>
        </div>
      ) : tickets.length === 0 ? (
        <div className="text-center py-12 text-zinc-500 bg-zinc-900/50 rounded-xl border border-zinc-800/50">{s.ticketsEmpty}</div>
      ) : (
        tickets.map((t) => (
          <button
            key={t.id}
            onClick={() => openThread(t.id)}
            className="w-full text-start bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-3 hover:bg-zinc-900 transition-colors"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-white break-words flex-1 min-w-0">{t.subject}</span>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0 ${STATE_STYLES[t.state]}`}>
                {stateLabel(s, t.state)}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500 flex-wrap">
              <span>{fmtDate(t.created_at, lang)}</span>
              {t.priority === 1 && <span className="text-yellow-400 font-bold">{s.proPriority}</span>}
              {typeof t.message_count === 'number' && (
                <span className="flex items-center gap-1">
                  <MessageSquare className="w-3 h-3" /> {t.message_count}
                </span>
              )}
            </div>
          </button>
        ))
      )}
    </div>
  );
}

// ------------------------------------------------------------------- page

export default function Support() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const { lang, dir, loc } = useLanguage();
  const { isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const s: SupportStrings = STRINGS[lang] ?? STRINGS.ar;

  // Router state from another page (the warranty center's "Contact support")
  // preselects the ticket form: unit, order and subject.
  const routeState = (state ?? null) as TicketPrefill | null;
  const prefill: TicketPrefill | undefined =
    routeState && (routeState.unitId || routeState.orderId || routeState.subject)
      ? {
          unitId: typeof routeState.unitId === 'string' ? routeState.unitId : undefined,
          orderId: typeof routeState.orderId === 'string' ? routeState.orderId : undefined,
          subject: typeof routeState.subject === 'string' ? routeState.subject : undefined,
        }
      : undefined;

  const [tab, setTab] = useState<'assistant' | 'tickets'>('assistant');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showTicketForm, setShowTicketForm] = useState(false);
  const [ticketsRefresh, setTicketsRefresh] = useState(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // A preselected ticket is only useful if the form is on screen: open it as
  // soon as the visitor is known to be signed in.
  const hasPrefill = !!prefill;
  useEffect(() => {
    if (hasPrefill && isAuthenticated) setShowTicketForm(true);
  }, [hasPrefill, isAuthenticated]);

  // Greeting + main menu are client-side (button-first); every answer after
  // that comes from the server.
  useEffect(() => {
    setMessages([
      {
        role: 'assistant',
        text: s.greeting,
        reply: {
          intent: 'menu',
          text: s.greeting,
          choices: s.menu.map((m) => ({ label: m.label, intent: m.intent })),
        },
      },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, showTicketForm]);

  const send = useCallback(
    async (payload: { intent?: string; params?: Record<string, unknown>; text?: string }, label: string) => {
      if (busy) return;
      setMessages((prev) => [...prev, { role: 'user', text: label }]);
      setBusy(true);
      try {
        const d = await api.post<{ reply: AsstReply }>('/api/support/assistant', { ...payload, locale: lang });
        setMessages((prev) => [...prev, { role: 'assistant', text: d.reply.text, reply: d.reply }]);
        if (d.reply.handoff) {
          if (isAuthenticated) setShowTicketForm(true);
        }
      } catch (e) {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', text: e instanceof ApiError ? e.message : s.netError, error: true },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy, lang, isAuthenticated, s.netError]
  );

  const sendText = () => {
    const q = input.trim();
    if (!q) return;
    setInput('');
    send({ text: q }, q);
  };

  const onTicketCreated = (t: Ticket) => {
    setShowTicketForm(false);
    setTicketsRefresh((n) => n + 1);
    setMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        text: `${s.created} (${t.id})`,
        reply: { intent: 'ticket_created', text: `${s.created} (${t.id})` },
      },
    ]);
    setTab('tickets');
  };

  return (
    <div className="w-full pb-28 text-zinc-300 min-h-screen">
      {/* header */}
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        </button>
        <LifeBuoy className="w-5 h-5 text-[#2CE59B]" />
        <h1 className="text-white font-bold text-lg flex-1">{s.title}</h1>
      </div>

      {/* tabs */}
      <div className="px-4 pt-3">
        <div className="flex bg-zinc-900 border border-zinc-800 p-1 rounded-xl">
          {(['assistant', 'tickets'] as const).map((tabId) => (
            <button
              key={tabId}
              onClick={() => setTab(tabId)}
              className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-colors ${
                tab === tabId ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {tabId === 'assistant' ? s.tabAssistant : s.tabTickets}
            </button>
          ))}
        </div>
      </div>

      {tab === 'tickets' ? (
        <div className="p-4">
          <TicketsTab s={s} lang={lang} refreshKey={ticketsRefresh} />
        </div>
      ) : (
        <>
          {/* conversation */}
          <div className="p-4 space-y-3">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[92%] space-y-2 ${m.role === 'user' ? '' : 'w-full'}`}>
                  <div
                    className={`rounded-2xl px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words inline-block ${
                      m.role === 'user'
                        ? 'bg-[#2CE59B]/10 border border-[#2CE59B]/20 text-zinc-100'
                        : m.error
                          ? 'bg-red-500/10 border border-red-500/30 text-red-300'
                          : 'bg-zinc-900 border border-zinc-800 text-zinc-200'
                    }`}
                  >
                    {m.error && <AlertTriangle className="w-3.5 h-3.5 inline-block me-1 -mt-0.5" />}
                    {m.text}
                  </div>

                  {m.reply?.cards && m.reply.cards.length > 0 && (
                    <div className="space-y-2">
                      {m.reply.cards.map((card, j) => (
                        <ReplyCard key={j} card={card} onNavigate={(to) => navigate(to)} />
                      ))}
                    </div>
                  )}

                  {m.reply?.choices && m.reply.choices.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {m.reply.choices.map((ch, j) => (
                        <button
                          key={j}
                          onClick={() => send({ intent: ch.intent, params: ch.params }, ch.label)}
                          disabled={busy}
                          className="px-3 py-1.5 rounded-full bg-zinc-900 border border-zinc-700 text-xs font-bold text-zinc-200 hover:border-[#2CE59B]/50 hover:text-white transition-colors disabled:opacity-50"
                        >
                          {ch.label}
                        </button>
                      ))}
                    </div>
                  )}

                  {m.reply?.links && m.reply.links.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {m.reply.links.map((l, j) => (
                        <button
                          key={j}
                          onClick={() => navigate(l.to)}
                          className="px-3 py-1.5 rounded-full bg-[#2CE59B]/10 border border-[#2CE59B]/30 text-xs font-bold text-[#2CE59B] hover:bg-[#2CE59B]/20 transition-colors"
                        >
                          {l.label}
                        </button>
                      ))}
                    </div>
                  )}

                  {m.reply?.handoff && !showTicketForm && (
                    <button
                      onClick={() => (isAuthenticated ? setShowTicketForm(true) : signIn())}
                      className="px-3 py-2 rounded-xl bg-[#2CE59B] text-black text-xs font-black flex items-center gap-1.5"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      {isAuthenticated ? s.openTicketCta : s.signIn}
                    </button>
                  )}
                </div>
              </div>
            ))}

            {busy && <div className="text-xs text-zinc-500 px-1">{s.thinking}</div>}

            {showTicketForm && (
              <TicketForm s={s} lang={lang} loc={loc} initial={prefill} onClose={() => setShowTicketForm(false)} onCreated={onTicketCreated} />
            )}
            <div ref={bottomRef} />
          </div>

          {/* input */}
          <div className="fixed bottom-0 inset-x-0 z-40 bg-black/90 backdrop-blur-xl border-t border-zinc-800/60 p-3">
            <div className="max-w-2xl mx-auto flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') sendText();
                }}
                maxLength={500}
                placeholder={s.inputPlaceholder}
                className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
              />
              <button
                onClick={sendText}
                disabled={busy || input.trim().length === 0}
                className="px-4 rounded-xl bg-[#2CE59B] text-black font-black disabled:opacity-50"
                aria-label={s.send}
              >
                <Send className={`w-4 h-4 ${dir === 'rtl' ? 'rotate-180' : ''}`} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
