import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { useSignInPrompt } from '../lib/guest';
import { api, ApiError, newIdempotencyKey, uploadFile } from '../lib/api';
import { mergeThread, pollWhileVisible, settleThread, useThreadScroll } from '../lib/supportThread';
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
  Paperclip,
  Plus,
  X,
} from 'lucide-react';
/**
 * A TICKET IS A PROMISE OF A REPLY, and a reply that only reaches the in-app
 * inbox is a reply the customer has to come back and hunt for. The window is
 * offered once the ticket EXISTS — never while the form is open, where it
 * would compete with the thing they are trying to send.
 */
import ChannelNudge from '../components/notify/ChannelNudge';
import { IconButton } from '../components/ui/Button';
import { MotionCharacterHome } from '../components/bloub/MotionCharacterAnchor';
import VariantImg from '../components/ui/VariantImg';
import { ASSIST_CLEARED_EVENT, loadAssistContext, loadAssistState, saveAssistContext, saveAssistState } from '../lib/assistSession';
import ChunkBoundary from '../components/ChunkBoundary';
import type { AssistAttachment } from '../components/support/AssistAttach';

/**
 * The + sheet (gallery, camera, voice note) is its own chunk, fetched the
 * first time the + is pressed: a customer who only asks questions never
 * downloads the recorder.
 */
const AssistAttach = lazy(() => import('../components/support/AssistAttach'));

/** A ticket takes at most this many assistant attachments (worker/lib/assist/attachments.ts). */
const ATTACH_MAX = 6;
/** How much of the transcript survives a reload in this tab. */
const TRANSCRIPT_KEEP = 40;

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
  /** Another origin — LEVO Studio. `navigate()` would produce a blank route. */
  external?: boolean;
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
/** The assistant's compact comparison. `winners` may be empty — a tie is a
 *  tie, and marking a winner on every row would invent a verdict. */
interface AsstTable {
  columns: string[];
  rows: Array<{ label: string; values: string[]; winners: number[] }>;
}
interface AsstReply {
  intent: string;
  text: string;
  cards?: AsstCard[];
  choices?: AsstChoice[];
  links?: AsstLink[];
  table?: AsstTable;
  auth_required?: boolean;
  handoff?: boolean;
  /**
   * WHAT THE ASSISTANT IS WAITING FOR, to be handed straight back with the
   * next free-text message. The server's own comment explains the mechanism;
   * on this side the rule is simply that it is OPAQUE — the page never reads
   * it, never edits it, and never acts on it, it only returns it. Treating it
   * as a token rather than as data is what keeps one turn of memory from
   * becoming a second, client-side idea of what the conversation is about.
   */
  expects?: { intent: string; slot: string; params?: Record<string, string> };
  /** The printer-problem triage's curated steps, in order. `hot` marks a burn risk. */
  steps?: Array<{ key: string; text: string; safety?: 'hot' }>;
  /** What the ticket form opens with after «تحدث مع الفريق», all of it editable. */
  ticket_draft?: { subject: string; body: string; unit_id?: string; handoff?: unknown };
  /** The conversation context: opaque here, stored and returned unchanged (src/lib/assistSession.ts). */
  context?: unknown;
}

interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
  reply?: AsstReply;
  error?: boolean;
  /** Typed by the customer (not a tapped chip): what «من المحادثة» quotes in the ticket. */
  typed?: boolean;
  /** Photos, clips and voice notes the customer attached in this bubble. */
  attachments?: AssistAttachment[];
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
  /** 'text' on every message written before migration 0107. */
  kind?: 'text' | 'image' | 'video';
  /** `/files/<key>`, composed by the server. Null for a typed message. */
  file_url?: string | null;
  /**
   * A bubble that exists only in this browser, waiting for the server. It is
   * rendered at reduced opacity and is replaced by the real row — same id,
   * same timestamp — the moment the POST answers.
   */
  pending?: boolean;
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
      'مرحبًا! أنا مساعد Levonis الآلي (بدون ذكاء اصطناعي — قواعد ثابتة وبيانات حسابك الحقيقية فقط). اختر موضوعًا أو اكتب سؤالك:',
    inputPlaceholder: 'اكتب سؤالك...',
    send: 'إرسال',
    thinking: 'جارٍ البحث...',
    netError: 'تعذر الاتصال بالخادم — حاول مرة أخرى.',
    openTicketCta: 'إنشاء تذكرة دعم',
    bestCell: 'الأفضل في هذا الصف:',
    ticketFormTitle: 'تذكرة دعم جديدة',
    subject: 'الموضوع',
    message: 'الرسالة',
    linkOrder: 'ربط بطلب (اختياري)',
    linkDevice: 'ربط بجهاز (اختياري)',
    noLink: 'بدون ربط',
    next: 'متابعة',
    cancel: 'إلغاء',
    confirmTitle: 'تأكيد إرسال التذكرة',
    confirmBody: 'ستُرسل هذه التذكرة إلى فريق Levonis. راجع التفاصيل ثم أكّد.',
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
    attach: 'إرفاق ملف',
    uploading: 'جارٍ الرفع…',
    attachFailed: 'تعذر إرسال الصورة',
    you: 'أنت',
    staff: 'فريق Levonis',
    loading: 'جارٍ التحميل...',
    loadError: 'تعذر التحميل — حاول مجددًا.',
    retry: 'إعادة المحاولة',
    subjectRequired: 'الموضوع مطلوب (3 أحرف على الأقل)',
    messageRequired: 'الرسالة مطلوبة (5 أحرف على الأقل)',
    complaintsTitle: 'شكاواي',
    complaintLabel: 'شكوى',
    complaintOn: 'على',
    openImage: 'فتح الصورة بالحجم الكامل',
    attachAdd: 'إرفاق صورة أو فيديو أو رسالة صوتية',
    attachSignIn: 'سجّل الدخول لإرفاق صور أو فيديو أو رسائل صوتية.',
    attachAck: 'استلمت المرفق. سيصل إلى الفريق مع التذكرة عندما تختار «تحدث مع الفريق».',
    fromChat: 'من المحادثة:',
    attachmentsLabel: 'المرفقات',
    removeAttachment: 'إزالة المرفق',
    voiceNote: 'رسالة صوتية',
    attachGone: 'أحد المرفقات لم يعد متاحاً. أزله ثم أرفقه من جديد.',
    attachUnavailable: 'لا يمكن إرسال المرفقات مع التذكرة حالياً. أزلها ثم أرسل التذكرة.',
    complaintStatus: {
      submitted: 'جديدة',
      under_review: 'قيد المراجعة',
      waiting_customer: 'بانتظار ردك',
      waiting_merchant: 'بانتظار التاجر',
      resolved: 'محلولة',
      rejected: 'مرفوضة',
      closed: 'مغلقة',
    } as Record<string, string>,
    /* THE OPENING MENU IS CLIENT-SIDE, SO IT HAS TO MIRROR THE SERVER'S.
       The first screen is seeded locally (button-first: no round trip before
       the customer has said anything), so these rows — not
       worker/routes/support.ts MENU_ITEMS — are the chips a cold /support
       actually shows. The server list only reaches the screen LATER, on a
       greeting/thanks/clarify reply, so the two drifted silently once
       `choose_printer`, `compare_products`, `power_usage` and `open_ticket`
       were promoted server-side: «ساعدني باختيار طابعة» — the owner's own
       sentence, and the one thing a first-time buyer wants — was reachable
       only by typing it.
       RULE: intent for intent, in the same order as MENU_ITEMS
       (worker/routes/support.ts), in all three dictionaries, with the
       server's own labels rather than fresh translations. */
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
      { intent: 'choose_printer', label: 'ساعدني باختيار طابعة' },
      { intent: 'compare_products', label: 'مقارنة منتجين' },
      { intent: 'power_usage', label: 'استهلاك الكهرباء وحجم الـ UPS' },
      { intent: 'policy_question', label: 'السياسات' },
      { intent: 'printer_problem', label: 'مشكلة بالطابعة' },
      { intent: 'open_ticket', label: 'فتح تذكرة دعم' },
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
    bestCell: 'Best on this row:',
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
    attach: 'Attach file',
    uploading: 'Uploading…',
    attachFailed: 'Failed to send image',
    you: 'You',
    staff: 'LEVONIS team',
    loading: 'Loading...',
    loadError: 'Failed to load — try again.',
    retry: 'Retry',
    subjectRequired: 'Subject is required (at least 3 characters)',
    messageRequired: 'Message is required (at least 5 characters)',
    complaintsTitle: 'My complaints',
    complaintLabel: 'Complaint',
    complaintOn: 'about',
    openImage: 'Open the full-size image',
    attachAdd: 'Attach a photo, video or voice note',
    attachSignIn: 'Sign in to attach photos, videos or voice notes.',
    attachAck: 'Got it. It goes to the team with the ticket when you choose «Talk to the team».',
    fromChat: 'From the conversation:',
    attachmentsLabel: 'Attachments',
    removeAttachment: 'Remove attachment',
    voiceNote: 'Voice note',
    attachGone: 'One of the attachments is no longer available. Remove it and attach it again.',
    attachUnavailable: 'Attachments cannot be sent with a ticket right now. Remove them and send the ticket.',
    complaintStatus: {
      submitted: 'New',
      under_review: 'Under review',
      waiting_customer: 'Waiting for you',
      waiting_merchant: 'Waiting for the merchant',
      resolved: 'Resolved',
      rejected: 'Rejected',
      closed: 'Closed',
    } as Record<string, string>,
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
      { intent: 'choose_printer', label: 'Help me choose a printer' },
      { intent: 'compare_products', label: 'Compare two products' },
      { intent: 'power_usage', label: 'Power draw and UPS size' },
      { intent: 'policy_question', label: 'Policies' },
      { intent: 'printer_problem', label: 'Printer problem' },
      { intent: 'open_ticket', label: 'Open a support ticket' },
      { intent: 'human_handoff', label: 'Talk to the team' },
    ],
  },
  ckb: {
    title: 'پشتگیری و یارمەتی',
    tabAssistant: 'یاریدەدەر',
    tabTickets: 'تیکێتەکانم',
    greeting:
      'سڵاو! من یاریدەدەری Levonisم (بەبێ زیرەکی دەستکرد — تەنها یاسا نەگۆڕەکان و داتای ڕاستەقینەی هەژمارەکەت). بابەتێک هەڵبژێرە یان پرسیارەکەت بنووسە:',
    inputPlaceholder: 'پرسیارەکەت بنووسە...',
    send: 'ناردن',
    thinking: 'گەڕان بەردەوامە...',
    netError: 'پەیوەندی بە ڕاژەکار نەکرا — دووبارە هەوڵ بدەرەوە.',
    openTicketCta: 'دروستکردنی تیکێتی پشتگیری',
    bestCell: 'باشترین لەم ڕیزەدا:',
    ticketFormTitle: 'تیکێتی پشتگیری نوێ',
    subject: 'بابەت',
    message: 'پەیام',
    linkOrder: 'بەستنەوە بە داواکارییەک (ئارەزوومەندانە)',
    linkDevice: 'بەستنەوە بە ئامێرێک (ئارەزوومەندانە)',
    noLink: 'بەبێ بەستنەوە',
    next: 'بەردەوامبوون',
    cancel: 'هەڵوەشاندنەوە',
    confirmTitle: 'پشتڕاستکردنەوەی ناردنی تیکێت',
    confirmBody: 'ئەم تیکێتە بۆ تیمی Levonis دەنێردرێت. وردەکارییەکان بپشکنە و پاشان پشتڕاست بکەرەوە.',
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
    attach: 'هاوپێچکردنی فایل',
    uploading: 'بارکردن…',
    attachFailed: 'بارکردن سەرکەوتوو نەبوو',
    you: 'تۆ',
    staff: 'تیمی Levonis',
    loading: 'بارکردن...',
    loadError: 'بارکردن سەرکەوتوو نەبوو — دووبارە هەوڵ بدەرەوە.',
    retry: 'هەوڵدانەوە',
    subjectRequired: 'بابەت پێویستە (لانیکەم 3 پیت)',
    messageRequired: 'پەیام پێویستە (لانیکەم 5 پیت)',
    // OWNER: the complaint lines below are yours to write in Sorani by hand;
    // they carry the Arabic, except the two states «تذاكري» already says.
    complaintsTitle: 'شكاواي',
    complaintLabel: 'شكوى',
    complaintOn: 'على',
    openImage: 'کردنەوەی وێنەکە بە قەبارەی تەواو',
    attachAdd: 'وێنە، ڤیدیۆ یان نامەی دەنگی هاوپێچ بکە',
    attachSignIn: 'بچۆ ژوورەوە بۆ هاوپێچکردنی وێنە، ڤیدیۆ یان نامەی دەنگی.',
    attachAck: 'وەرمگرت. کاتێک «قسە لەگەڵ تیمەکە بکە» هەڵدەبژێریت، لەگەڵ تیکێتەکە دەگاتە تیمەکە.',
    fromChat: 'لە گفتوگۆکەوە:',
    attachmentsLabel: 'هاوپێچەکان',
    removeAttachment: 'لابردنی هاوپێچ',
    voiceNote: 'نامەی دەنگی',
    attachGone: 'یەکێک لە هاوپێچەکان ئیتر بەردەست نییە. لایببە و دووبارە هاوپێچی بکەرەوە.',
    attachUnavailable: 'لە ئێستادا ناتوانرێت هاوپێچ لەگەڵ تیکێت بنێردرێت. لایانببە و تیکێتەکە بنێرە.',
    complaintStatus: {
      submitted: 'جديدة',
      under_review: 'قيد المراجعة',
      waiting_customer: 'چاوەڕوانی وەڵامی تۆیە',
      waiting_merchant: 'بانتظار التاجر',
      resolved: 'چارەسەرکراوە',
      rejected: 'مرفوضة',
      closed: 'مغلقة',
    } as Record<string, string>,
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
      { intent: 'choose_printer', label: 'یارمەتیم بدە پرینتەر هەڵبژێرم' },
      { intent: 'compare_products', label: 'بەراوردی دوو بەرهەم' },
      { intent: 'power_usage', label: 'ڕاکێشانی کارەبا و قەبارەی UPS' },
      { intent: 'policy_question', label: 'سیاسەتەکان' },
      { intent: 'printer_problem', label: 'کێشەی پرینتەر' },
      { intent: 'open_ticket', label: 'کردنەوەی تیکێتی پشتگیری' },
      { intent: 'human_handoff', label: 'قسە لەگەڵ تیمەکە' },
    ],
  },
};

type SupportStrings = (typeof STRINGS)['en'];

/** The assistant / tickets switch: a raised thumb in a well track (the Segmented recipe). */
const TAB_ON = 'bg-surface-raised border-border-subtle shadow-1 text-text-primary';
const TAB_OFF = 'border-transparent text-text-secondary hover:text-text-primary';

const STATE_STYLES: Record<Ticket['state'], string> = {
  open: 'lv-chip [--chip:var(--color-info)]',
  waiting_customer: 'lv-chip [--chip:var(--color-warning)]',
  waiting_staff: 'bg-white/[0.06] text-text-secondary',
  resolved: 'lv-chip [--chip:var(--color-success)]',
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

/**
 * THE COMPACT COMPARISON, INSIDE THE CONVERSATION.
 *
 * A real table rather than one card per machine: putting two numbers beside
 * each other is the whole job of a comparison, and stacked cards make the
 * reader scroll between them. It stays small on purpose — the server sends at
 * most six rows and the full page is one tap away underneath.
 *
 * `text-start` and the logical border properties, never `text-left`: this
 * table is read right-to-left by almost everyone who will see it.
 *
 * The winning cell is marked in gold AND carries a screen-reader sentence,
 * because colour alone is not an answer for a reader who cannot see it.
 */
function ReplyTable({ table, bestLabel }: { table: AsstTable; bestLabel: string }) {
  return (
    <div className="lv-surface overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-border-subtle">
            <th scope="col" className="p-2 text-start font-bold text-text-muted" />
            {table.columns.map((c, i) => (
              <th key={i} scope="col" className="p-2 text-start font-bold text-text-primary">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i} className="border-b border-border-subtle last:border-b-0">
              <th scope="row" className="p-2 text-start align-top font-normal text-text-muted">
                {r.label}
              </th>
              {r.values.map((v, j) => (
                <td
                  key={j}
                  className={`p-2 align-top ${
                    r.winners.includes(j) ? 'font-bold text-gold' : 'text-text-secondary'
                  }`}
                >
                  {r.winners.includes(j) && <span className="sr-only">{bestLabel} </span>}
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReplyCard({ card, onNavigate }: { card: AsstCard; onNavigate: (to: string) => void }) {
  return (
    <div className="lv-surface flex items-start gap-3 p-3">
      {card.image && (
        <VariantImg
          sizes="48px"
          referrerPolicy="no-referrer"
          src={card.image}
          alt=""
          className="w-12 h-12 rounded-sm object-cover bg-surface-selected shrink-0"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold text-text-primary break-words">{card.title}</span>
          {card.badge && <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/[0.06] text-text-secondary font-bold">{card.badge}</span>}
        </div>
        {card.subtitle && <div className="text-xs text-text-secondary mt-0.5 break-words">{card.subtitle}</div>}
        {card.fields && card.fields.length > 0 && (
          <div className="mt-1.5 space-y-0.5">
            {card.fields.map((f, i) => (
              <div key={i} className="text-xs text-text-secondary">
                <span className="text-text-muted">{f.label}: </span>
                <span className="text-text-primary">{f.value}</span>
              </div>
            ))}
          </div>
        )}
        {card.link && (
          <button
            onClick={() => onNavigate(card.link!.to)}
            className="mt-2 text-xs font-bold text-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded"
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
  /** The assistant's handoff draft: printer, symptom and the steps tried. Editable. */
  body?: string;
  /**
   * The same facts as closed-set values, from the server's draft. Sent back
   * untouched; the server reads it again and keeps it for the team only.
   */
  handoff?: unknown;
}

/**
 * ONE ATTACHMENT, SMALL: a picture as a thumbnail, a clip or a voice note as
 * its own player. `/files/…` is the private address the server composed; the
 * gate there decides who may read it.
 */
function AttachmentThumb({ a, label, compact = false }: { a: AssistAttachment; label: string; compact?: boolean }) {
  if (a.kind === 'audio') {
    return <audio src={a.url} controls preload="metadata" aria-label={label} className={compact ? 'w-56 max-w-full' : 'w-full max-w-xs'} />;
  }
  if (a.kind === 'video') {
    return <video src={a.url} controls playsInline preload="metadata" className={`rounded-lg bg-black ${compact ? 'h-20 w-28 object-cover' : 'max-h-56 w-full max-w-xs'}`} />;
  }
  return (
    <a href={a.url} target="_blank" rel="noopener noreferrer" className="block">
      <img src={a.url} alt="" referrerPolicy="no-referrer" className={`rounded-lg bg-surface-raised ${compact ? 'h-20 w-20 object-cover' : 'max-h-56 max-w-full object-contain'}`} />
    </a>
  );
}

function TicketForm({
  s,
  lang,
  loc,
  initial,
  attachments = [],
  onRemoveAttachment,
  onClose,
  onCreated,
}: {
  s: SupportStrings;
  lang: string;
  loc: (ar: string, en: string, ckb?: string) => string;
  initial?: TicketPrefill;
  /** What the customer attached in the assistant chat; it goes with the ticket. */
  attachments?: AssistAttachment[];
  onRemoveAttachment?: (key: string) => void;
  onClose: () => void;
  onCreated: (t: Ticket) => void;
}) {
  const [subject, setSubject] = useState(initial?.subject ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [orderId, setOrderId] = useState(initial?.orderId ?? '');
  const [unitId, setUnitId] = useState(initial?.unitId ?? '');
  const [orders, setOrders] = useState<OrderOption[]>([]);
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ subject?: string; body?: string }>({});
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

  /**
   * ONE CONFIRM STEP, ONE TICKET. The key is minted when the customer reaches
   * «تأكيد وإرسال» and reused by every press of it, so a POST that committed
   * but came back as «خطأ في الشبكة» is recognised on the retry and answered
   * with the ticket that already exists — not a second one in the Warranty
   * topic. Going back to edit mints a new key, because what is confirmed next
   * is a different ticket.
   */
  const idemKey = useRef('');
  const goConfirm = () => {
    if (subject.trim().length < 3) {
      setFieldErrors({ subject: s.subjectRequired });
      return;
    }
    if (body.trim().length < 5) {
      setFieldErrors({ body: s.messageRequired });
      return;
    }
    setFieldErrors({});
    setError('');
    idemKey.current = newIdempotencyKey();
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
        idempotencyKey: idemKey.current || undefined,
        attachments: attachments.length ? attachments.map((a) => a.key) : undefined,
        handoff: initial?.handoff ?? undefined,
      });
      onCreated(data.ticket);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      setError(
        code === 'ATTACHMENT_NOT_FOUND' || code === 'ATTACHMENT_NOT_YOURS' || code === 'ATTACHMENT_INVALID'
          ? s.attachGone
          : code === 'ATTACHMENTS_UNAVAILABLE'
            ? s.attachUnavailable
            : e instanceof ApiError
              ? e.message
              : s.netError
      );
      setBusy(false);
    }
  };

  const attachmentList = (removable: boolean) =>
    attachments.length > 0 && (
      <div data-support-ticket-attachments>
        <div className="mb-1.5 text-xs font-bold text-text-secondary">{s.attachmentsLabel}</div>
        <div className="flex flex-wrap gap-2">
          {attachments.map((a) => (
            <div key={a.key} className="relative">
              <AttachmentThumb a={a} label={s.voiceNote} compact />
              {removable && onRemoveAttachment && (
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(a.key)}
                  aria-label={s.removeAttachment}
                  title={s.removeAttachment}
                  className="lv-button lv-button-secondary absolute -top-2 -end-2 min-h-7 w-7 rounded-full px-0"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    );

  return (
    <div className="lv-surface p-4 space-y-4" data-support-ticket-form>
      <div className="flex items-center justify-between">
        <h3 className="text-text-primary font-bold text-sm">{step === 'form' ? s.ticketFormTitle : s.confirmTitle}</h3>
        <button onClick={onClose} className="text-xs text-text-muted hover:text-text-secondary">
          {s.cancel}
        </button>
      </div>

      {step === 'form' ? (
        <>
          <div>
            <label htmlFor="support-ticket-subject" className="mb-1.5 block text-xs font-bold text-text-secondary">{s.subject}</label>
            <input
              className="lv-input text-sm"
              id="support-ticket-subject"
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                if (fieldErrors.subject) setFieldErrors((current) => ({ ...current, subject: undefined }));
              }}
              maxLength={200}
              aria-invalid={!!fieldErrors.subject}
              aria-describedby={fieldErrors.subject ? 'support-ticket-subject-error' : undefined}
            />
            {fieldErrors.subject && <p id="support-ticket-subject-error" role="alert" className="lv-field-error">{fieldErrors.subject}</p>}
          </div>
          <div>
            <label htmlFor="support-ticket-message" className="mb-1.5 block text-xs font-bold text-text-secondary">{s.message}</label>
            <textarea
              className="lv-input min-h-28 resize-y py-2.5 text-sm"
              id="support-ticket-message"
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                if (fieldErrors.body) setFieldErrors((current) => ({ ...current, body: undefined }));
              }}
              maxLength={4000}
              rows={4}
              aria-invalid={!!fieldErrors.body}
              aria-describedby={fieldErrors.body ? 'support-ticket-message-error' : undefined}
            />
            {fieldErrors.body && <p id="support-ticket-message-error" role="alert" className="lv-field-error">{fieldErrors.body}</p>}
          </div>
          <div>
            <label className="text-xs font-bold text-text-secondary block mb-1.5">{s.linkOrder}</label>
            <div className="relative">
              <select
                className="lv-input w-full appearance-none pe-9 text-sm"
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
              >
                <option value="">{s.noLink}</option>
                {orderOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.id}
                    {o.created_at ? ` · ${fmtDate(o.created_at, lang)}` : ''}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-4 h-4 text-text-muted absolute top-3 end-3 pointer-events-none" />
            </div>
          </div>
          <div>
            <label className="text-xs font-bold text-text-secondary block mb-1.5">{s.linkDevice}</label>
            <div className="relative">
              <select
                className="lv-input w-full appearance-none pe-9 text-sm"
                value={unitId}
                onChange={(e) => setUnitId(e.target.value)}
              >
                <option value="">{s.noLink}</option>
                {deviceOptions.map((d) => (
                  <option key={d.unit_id} value={d.unit_id}>
                    {loc(d.product.name_ar, d.product.name, d.product.name_ckb)} {d.serial ? `(${d.serial})` : ''}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-4 h-4 text-text-muted absolute top-3 end-3 pointer-events-none" />
            </div>
          </div>
          {attachmentList(true)}
          {error && <div className="text-xs text-danger">{error}</div>}
          <button onClick={goConfirm} className="lv-button lv-button-primary w-full">
            {s.next}
          </button>
        </>
      ) : (
        <>
          <p className="text-xs text-text-secondary">{s.confirmBody}</p>
          <div className="lv-well rounded-md p-3 space-y-1">
            <div className="text-sm text-text-primary font-bold break-words">{subject}</div>
            <div className="text-xs text-text-secondary whitespace-pre-wrap break-words">{body}</div>
            {orderId && <div className="text-xs text-text-muted font-mono">{orderId}</div>}
          </div>
          {attachmentList(false)}
          {error && <div className="text-xs text-danger">{error}</div>}
          <div className="flex gap-2">
            <button
              onClick={() => setStep('form')}
              disabled={busy}
              className="lv-button lv-button-secondary flex-1"
            >
              {s.back}
            </button>
            <button
              onClick={create}
              disabled={busy}
              className="lv-button lv-button-primary flex-1"
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

/**
 * WHICH CONVERSATION TO OPEN, handed in from the page's query string — the
 * address a notification carries (worker/lib/engagementNotify.ts
 * `supportTicketLink` / `complaintThreadLink`). `nonce` changes on every
 * navigation (the page re-reads the target on each `location.key`), so the
 * same link tapped twice opens the thread twice.
 */
export interface ThreadTarget {
  kind: 'ticket' | 'complaint';
  id: string;
  nonce: number;
}

interface Complaint {
  id: string;
  category: string;
  description: string;
  status: string;
  resolution?: string;
  created_at: string;
  updated_at: string;
  community_order_id: string | null;
  merchant_name: string | null;
  message_count?: number;
}

/** What the open thread is about — a ticket or a complaint, drawn alike. */
type ThreadHead =
  | { kind: 'ticket'; ticket: Ticket }
  | { kind: 'complaint'; complaint: Complaint };

interface OpenThread {
  head: ThreadHead;
  messages: TicketMsg[];
  /** What the assistant chat handed to this ticket (0209); read once, on open. */
  attachments?: AssistAttachment[];
}

/** How often an open thread re-reads itself while the page is visible. */
const THREAD_POLL_MS = 12_000;

function threadPaths(kind: 'ticket' | 'complaint', id: string) {
  return kind === 'ticket'
    ? { read: `/api/support/tickets/${id}`, write: `/api/support/tickets/${id}/messages`, purpose: 'support' as const }
    : { read: `/api/marketplace/complaints/${id}`, write: `/api/marketplace/complaints/${id}/messages`, purpose: 'complaint' as const };
}

function headOf(kind: 'ticket' | 'complaint', d: { ticket?: Ticket; complaint?: Complaint }): ThreadHead | null {
  if (kind === 'ticket') return d.ticket ? { kind: 'ticket', ticket: d.ticket } : null;
  return d.complaint ? { kind: 'complaint', complaint: d.complaint } : null;
}

function TicketsTab({
  s,
  lang,
  refreshKey,
  target,
  onTargetOpened,
}: {
  s: SupportStrings;
  lang: string;
  refreshKey: number;
  target?: ThreadTarget | null;
  /** The link has been followed; the page forgets it, so switching tabs and
   *  back does not reopen a thread the customer already closed. */
  onTargetOpened?: () => void;
}) {
  const { isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<{ kind: 'ticket' | 'complaint'; id: string } | null>(null);
  const [thread, setThread] = useState<OpenThread | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyError, setReplyError] = useState('');
  const [uploading, setUploading] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const tempCounter = useRef(0);

  const load = useCallback(async () => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [d, cd] = await Promise.all([
        api.get<{ tickets: Ticket[] }>('/api/support/tickets'),
        // A customer who never filed a complaint gets an empty list; one whose
        // complaints cannot be read right now still gets their tickets.
        api.get<{ complaints: Complaint[] }>('/api/marketplace/complaints').catch(() => ({ complaints: [] as Complaint[] })),
      ]);
      setTickets(d.tickets || []);
      setComplaints(cd.complaints || []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : s.loadError);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, s.loadError]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  /**
   * OPENING a thread is the one moment a spinner is honest: there is nothing
   * on screen yet and the thread has to arrive. REPLYING is not that moment,
   * and this function is not called for it — see `commitReply`.
   */
  const openThread = useCallback(
    async (kind: 'ticket' | 'complaint', id: string) => {
      setOpen({ kind, id });
      setThreadLoading(true);
      setThread(null);
      setReplyError('');
      try {
        const d = await api.get<{ ticket?: Ticket; complaint?: Complaint; messages: TicketMsg[]; attachments?: Array<{ kind: string; file_url: string; mime?: string }> }>(
          threadPaths(kind, id).read
        );
        const head = headOf(kind, d);
        // `key` here is only a React key: the address is the server's own `/files/…`.
        const attachments = (d.attachments ?? [])
          .filter((a) => a.kind === 'image' || a.kind === 'video' || a.kind === 'audio')
          .map((a) => ({ key: a.file_url, url: a.file_url, kind: a.kind as AssistAttachment['kind'], mime: a.mime }));
        if (head) setThread({ head, messages: d.messages || [], attachments });
      } catch (e) {
        setReplyError(e instanceof ApiError ? e.message : s.loadError);
      } finally {
        setThreadLoading(false);
      }
    },
    [s.loadError]
  );

  /**
   * «افتح «تذاكري»» NOW OPENS THE TICKET. A staff reply's notification links
   * here with the ticket (or complaint) named, and the page hands it down; it
   * is opened once per navigation, after sign-in is known.
   */
  const targetKey = target && isAuthenticated ? `${target.kind}:${target.id}:${target.nonce}` : '';
  useEffect(() => {
    if (!targetKey || !target) return;
    void openThread(target.kind, target.id);
    onTargetOpened?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, openThread]);

  /**
   * THE THREAD RE-READS ITSELF — the half of «الرد يُضاف» the customer could
   * not see: support answered while the ticket was open and nothing on the
   * screen changed until it was closed and reopened. A silent GET every few
   * seconds while the page is visible, merged by id so a bubble being sent is
   * never dropped or doubled (src/lib/supportThread.ts).
   */
  const openKey = open ? `${open.kind}:${open.id}` : '';
  useEffect(() => {
    if (!open || threadLoading) return;
    const { kind, id } = open;
    return pollWhileVisible(() => {
      api
        .get<{ ticket?: Ticket; complaint?: Complaint; messages: TicketMsg[] }>(threadPaths(kind, id).read, { mascot: 'silent' })
        .then((d) => {
          const head = headOf(kind, d);
          if (!head) return;
          setThread((prev) => {
            if (!prev || prev.head.kind !== kind) return prev;
            const prevId = prev.head.kind === 'ticket' ? prev.head.ticket.id : prev.head.complaint.id;
            if (prevId !== id) return prev;
            return { ...prev, head, messages: mergeThread(prev.messages, d.messages || []) };
          });
        })
        .catch(() => undefined);
    }, THREAD_POLL_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey, threadLoading]);

  /**
   * THE LAST BUBBLE IS THE ONE WORTH SEEING — on open, on every append, and
   * once more when a photo in the thread has loaded and made it taller.
   * `scrollTop` on the list itself, not `scrollIntoView`, which also scrolls
   * every ancestor and can shift the whole page on a phone.
   */
  const messageCount = thread ? thread.messages.length : 0;
  const lastPending = !!thread?.messages[thread.messages.length - 1]?.pending;
  useThreadScroll(listRef, `${openKey}:${threadLoading ? 1 : 0}`, messageCount, lastPending);

  const nextTempId = () => {
    tempCounter.current += 1;
    return `temp-${Date.now()}-${tempCounter.current}`;
  };

  const sameThread = (prev: OpenThread | null, kind: 'ticket' | 'complaint', id: string) =>
    !!prev && prev.head.kind === kind && (prev.head.kind === 'ticket' ? prev.head.ticket.id : prev.head.complaint.id) === id;

  const addPending = (kind: 'ticket' | 'complaint', id: string, optimistic: { body: string; kind: 'text' | 'image' | 'video'; file_url: string | null }) => {
    const tempId = nextTempId();
    setThread((prev) =>
      prev && sameThread(prev, kind, id)
        ? {
            ...prev,
            messages: [
              ...prev.messages,
              {
                id: tempId,
                body: optimistic.body,
                is_staff: false,
                created_at: new Date().toISOString(),
                kind: optimistic.kind,
                file_url: optimistic.file_url,
                pending: true,
              },
            ],
          }
        : prev
    );
    return tempId;
  };

  const dropPending = (kind: 'ticket' | 'complaint', id: string, tempId: string) =>
    setThread((prev) => (prev && sameThread(prev, kind, id) ? { ...prev, messages: prev.messages.filter((m) => m.id !== tempId) } : prev));

  /**
   * A REPLY APPENDS. IT DOES NOT RELOAD THE WORLD.
   *
   * What this replaced: `await openThread(openId)` followed by `await load()`.
   * `openThread` set `thread` to null and `threadLoading` to true BEFORE its
   * GET, so the render swapped the entire conversation for a centred
   * «جارٍ التحميل...» — every bubble the customer had just been reading
   * unmounted and came back — and `load()` put the ticket LIST into its own
   * loading state behind it. Three round trips for one sent sentence, with a
   * blank screen in the middle of them, on a tablet over Iraqi mobile data.
   *
   * Now: the bubble is on screen before the request leaves, the server hands
   * back the row it wrote (id, timestamp, kind, file url) and that row
   * replaces the temporary one in place. Nothing else is re-fetched — the
   * row in the list is patched from the same response.
   *
   * ON FAILURE the bubble is REMOVED (by the caller) and the text is put back
   * in the box. A message that did not reach support must not sit in the
   * thread looking like it did.
   */
  const commitReply = async (
    kind: 'ticket' | 'complaint',
    id: string,
    tempId: string,
    payload: { body?: string; fileKey?: string },
    fallback: TicketMsg
  ) => {
    const res = await api.post<{ message?: TicketMsg; ticket_state?: Ticket['state']; status?: string; updated_at?: string }>(
      threadPaths(kind, id).write,
      payload
    );
    setThread((prev) => {
      if (!prev || !sameThread(prev, kind, id)) return prev;
      // A Worker that predates the row-returning response still ACCEPTED the
      // message; keeping the local bubble and clearing `pending` is the
      // truthful reading of a 200 with no body.
      const settled: TicketMsg = res?.message ? { ...res.message, pending: false } : { ...fallback, id: tempId, pending: false };
      const head: ThreadHead =
        prev.head.kind === 'ticket'
          ? {
              kind: 'ticket',
              ticket: { ...prev.head.ticket, state: res?.ticket_state ?? 'waiting_staff', updated_at: res?.updated_at ?? prev.head.ticket.updated_at },
            }
          : {
              kind: 'complaint',
              complaint: { ...prev.head.complaint, status: res?.status ?? prev.head.complaint.status, updated_at: res?.updated_at ?? prev.head.complaint.updated_at },
            };
      return { ...prev, head, messages: settleThread(prev.messages, tempId, settled) };
    });
    if (kind === 'ticket') {
      setTickets((prev) =>
        prev.map((t) =>
          t.id === id
            ? {
                ...t,
                state: res?.ticket_state ?? 'waiting_staff',
                updated_at: res?.updated_at ?? t.updated_at,
                message_count: typeof t.message_count === 'number' ? t.message_count + 1 : t.message_count,
              }
            : t
        )
      );
    } else {
      setComplaints((prev) =>
        prev.map((c) =>
          c.id === id
            ? {
                ...c,
                status: res?.status ?? c.status,
                updated_at: res?.updated_at ?? c.updated_at,
                message_count: typeof c.message_count === 'number' ? c.message_count + 1 : c.message_count,
              }
            : c
        )
      );
    }
  };

  const sendReply = async () => {
    const text = replyText.trim();
    if (!open || text.length === 0 || replyBusy) return;
    const { kind, id } = open;
    setReplyBusy(true);
    setReplyText('');
    setReplyError('');
    const tempId = addPending(kind, id, { body: text, kind: 'text', file_url: null });
    try {
      await commitReply(kind, id, tempId, { body: text }, { id: tempId, body: text, is_staff: false, created_at: new Date().toISOString(), kind: 'text', file_url: null });
    } catch (e) {
      dropPending(kind, id, tempId);
      setReplyText(text);
      setReplyError(e instanceof ApiError ? e.message : s.netError);
    } finally {
      setReplyBusy(false);
    }
  };

  /**
   * «لا توجد طريقة لإرفاق وسائط» — the photograph of the failed print.
   *
   * The bubble appears with the LOCAL object URL the instant the file is
   * chosen and BEFORE the upload starts, because the upload itself is the slow
   * part and a customer who picked a clip and saw nothing happen picks it
   * again. A failed upload removes it. The object URL is revoked once the
   * server's own `/files/…` has replaced it.
   *
   * The ticket (or complaint) id is passed to the upload so the object is
   * filed under IT, and the server refuses one that is not this account's
   * before a byte is stored.
   */
  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !open || uploading || replyBusy) return;
    const { kind, id } = open;
    const localUrl = URL.createObjectURL(file);
    const mediaKind: 'image' | 'video' = file.type.startsWith('video/') ? 'video' : 'image';
    setUploading(true);
    setReplyError('');
    const tempId = addPending(kind, id, { body: '', kind: mediaKind, file_url: localUrl });
    try {
      const uploaded = await uploadFile(file, threadPaths(kind, id).purpose, id);
      await commitReply(kind, id, tempId, { fileKey: uploaded.key }, { id: tempId, body: '', is_staff: false, created_at: new Date().toISOString(), kind: mediaKind, file_url: uploaded.url });
    } catch (err) {
      dropPending(kind, id, tempId);
      setReplyError(err instanceof ApiError ? err.message : s.attachFailed);
    } finally {
      setUploading(false);
      URL.revokeObjectURL(localUrl);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="lv-surface mx-auto max-w-3xl space-y-3 py-12 text-center text-text-secondary">
          <p>{s.ticketsSignIn}</p>
          <button onClick={() => signIn()} className="lv-button lv-button-primary px-4">
            {s.signIn}
          </button>
        </div>
      </div>
    );
  }

  if (open) {
    const head = thread?.head;
    /**
     * THE COMPOSER IS A SIBLING OF THE SCROLLER, NOT ITS LAST CHILD.
     *
     * It used to be ordinary flow content inside one scrolling column, so on a
     * two-message ticket the box sat a few hundred pixels down a full-height
     * screen — near the TOP, with dead space under it — and on a long ticket
     * it sat below the fold. Both are the same defect: the input's position
     * was decided by how much had been said. The assistant tab on this very
     * page and the order chat already do it the other way; this is that shape,
     * for a ticket and a complaint alike.
     */
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4" data-support-thread>
          <div className="mx-auto max-w-3xl space-y-3">
            <button onClick={() => setOpen(null)} className="text-xs text-text-secondary hover:text-text-primary font-bold">
              ← {s.back}
            </button>
            {threadLoading ? (
              <div className="text-center py-8 text-text-muted">{s.loading}</div>
            ) : head ? (
              <>
                <div className="lv-surface p-3">
                  {head.kind === 'ticket' ? (
                    <>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-text-primary font-bold text-sm break-words">{head.ticket.subject}</span>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${STATE_STYLES[head.ticket.state]}`}>
                          {stateLabel(s, head.ticket.state)}
                        </span>
                        {head.ticket.priority === 1 && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-yellow-500/10 text-yellow-400">{s.proPriority}</span>
                        )}
                      </div>
                      {head.ticket.order_id && <div className="text-xs text-text-muted font-mono mt-1">{head.ticket.order_id}</div>}
                      {thread.attachments && thread.attachments.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2" data-support-ticket-attachments>
                          {thread.attachments.map((a) => (
                            <AttachmentThumb key={a.key} a={a} label={s.voiceNote} compact />
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-text-primary font-bold text-sm">
                          {s.complaintLabel}
                          {head.complaint.merchant_name ? ` ${s.complaintOn} ${head.complaint.merchant_name}` : ''}
                        </span>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-white/[0.06] text-text-secondary">
                          {s.complaintStatus[head.complaint.status] ?? head.complaint.status}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-text-secondary whitespace-pre-wrap break-words">{head.complaint.description}</p>
                    </>
                  )}
                </div>
                <div className="space-y-2">
                  {thread.messages.map((m) => (
                    <div key={m.id} className={`flex ${m.is_staff ? 'justify-start' : 'justify-end'}`}>
                      <div
                        className={`max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                          m.is_staff ? 'bg-surface text-text-secondary' : 'bg-surface-selected border border-border-subtle text-text-primary'
                        } ${m.pending ? 'opacity-60' : ''}`}
                      >
                        <div className="text-[10px] text-text-muted mb-0.5">
                          {m.is_staff ? s.staff : s.you} · {m.pending && m.kind && m.kind !== 'text' ? s.uploading : fmtDate(m.created_at, lang)}
                        </div>
                        {/* THE WHOLE PHOTOGRAPH, AND A WAY TO OPEN IT. It was
                            `object-cover` in a 300px box with nothing to tap,
                            so a serial number or a cracked corner in the
                            evidence photo was cropped away. */}
                        {m.kind === 'image' && m.file_url && (
                          <a href={m.file_url} target="_blank" rel="noopener noreferrer" aria-label={s.openImage} className="mb-1 block">
                            <img
                              referrerPolicy="no-referrer"
                              src={m.file_url}
                              alt=""
                              className="max-h-[300px] w-full rounded-lg bg-surface-selected object-contain"
                            />
                          </a>
                        )}
                        {m.kind === 'video' && m.file_url && (
                          <video src={m.file_url} controls playsInline preload="metadata" className="mb-1 max-h-[300px] w-full rounded-lg bg-charcoal" />
                        )}
                        {m.body}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="text-center py-8 text-danger text-sm">{replyError || s.loadError}</div>
            )}
          </div>
        </div>

        {thread && (
          <div className="z-40 shrink-0 border-t border-border-subtle bg-surface-raised/98 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]" data-support-thread-composer>
            <div className="mx-auto max-w-3xl space-y-2">
              {replyError && (
                <div role="alert" className="text-xs text-danger">
                  {replyError}
                </div>
              )}
              <div className="flex gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*,video/*"
                  className="hidden"
                  onChange={onPickFile}
                />
                <IconButton
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading || replyBusy}
                  label={s.attach}
                  title={s.attach}
                  variant="secondary"
                  icon={<Paperclip className="h-4 w-4" />}
                />
                <input
                  className="lv-input flex-1 min-w-0 text-sm"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') sendReply();
                  }}
                  maxLength={4000}
                  placeholder={uploading ? s.uploading : s.replyPlaceholder}
                  aria-label={s.replyPlaceholder}
                />
                <button
                  onClick={sendReply}
                  disabled={replyBusy || uploading || replyText.trim().length === 0}
                  className="lv-button lv-button-primary px-4"
                >
                  {s.reply}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto max-w-3xl space-y-3">
        <div className="flex justify-end">
          <button onClick={load} aria-label={s.retry} className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface text-text-secondary hover:bg-surface-raised hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {loading ? (
          <div className="text-center py-8 text-text-muted">{s.loading}</div>
        ) : error ? (
          <div className="text-center py-8 text-danger text-sm space-y-2">
            <div>{error}</div>
            <button onClick={load} className="text-xs text-text-secondary underline">
              {s.retry}
            </button>
          </div>
        ) : tickets.length === 0 && complaints.length === 0 ? (
          <div className="lv-surface py-12 text-center text-text-muted">{s.ticketsEmpty}</div>
        ) : (
          <>
            {tickets.map((t) => (
              <button
                key={t.id}
                onClick={() => openThread('ticket', t.id)}
                className="w-full rounded-lg bg-surface p-3 text-start transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-bold text-text-primary break-words flex-1 min-w-0">{t.subject}</span>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0 ${STATE_STYLES[t.state]}`}>
                    {stateLabel(s, t.state)}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1 text-xs text-text-muted flex-wrap">
                  <span>{fmtDate(t.created_at, lang)}</span>
                  {t.priority === 1 && <span className="text-yellow-400 font-bold">{s.proPriority}</span>}
                  {typeof t.message_count === 'number' && (
                    <span className="flex items-center gap-1">
                      <MessageSquare className="w-3 h-3" /> {t.message_count}
                    </span>
                  )}
                </div>
              </button>
            ))}
            {/* «شكاواي» — a complaint filed from a community order, and the
                shop's answers to it. It lives beside the tickets because it is
                the same thing to the customer: a conversation with support
                about something that went wrong. */}
            {complaints.length > 0 && (
              <section className="space-y-2 pt-2" aria-label={s.complaintsTitle} data-support-complaints>
                <h2 className="px-1 text-xs font-bold text-text-muted">{s.complaintsTitle}</h2>
                {complaints.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => openThread('complaint', c.id)}
                    className="w-full rounded-lg bg-surface p-3 text-start transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold text-text-primary break-words flex-1 min-w-0">
                        {s.complaintLabel}
                        {c.merchant_name ? ` ${s.complaintOn} ${c.merchant_name}` : ''}
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0 bg-white/[0.06] text-text-secondary">
                        {s.complaintStatus[c.status] ?? c.status}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-text-secondary break-words">{c.description}</p>
                    <div className="flex items-center gap-2 mt-1 text-xs text-text-muted flex-wrap">
                      <span>{fmtDate(c.created_at, lang)}</span>
                      {typeof c.message_count === 'number' && (
                        <span className="flex items-center gap-1">
                          <MessageSquare className="w-3 h-3" /> {c.message_count}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- page

// --------------------------------------------- the conversation, kept for the tab

interface StoredAssist {
  messages: ChatMsg[];
  attachments: AssistAttachment[];
  draft?: TicketPrefill;
}

const ATTACH_KINDS: ReadonlySet<string> = new Set(['image', 'video', 'audio']);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown, max = 4000): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

/** An attachment exactly as the upload answered it, or nothing. */
function storedAttachment(v: unknown): AssistAttachment | null {
  if (!isRecord(v) || typeof v.key !== 'string' || !v.key.startsWith('assist/') || v.url !== `/files/${v.key}` || !ATTACH_KINDS.has(String(v.kind))) return null;
  return { key: v.key, url: v.url, kind: v.kind as AssistAttachment['kind'], ...(typeof v.mime === 'string' ? { mime: v.mime.slice(0, 100) } : {}) };
}

/**
 * A REPLY AS IT MAY BE SHOWN AGAIN AFTER A RELOAD: its words, steps, chips
 * and links, and each card as a name and a link only. No price, stock line or
 * table survives: those are only ever shown fresh from the server.
 */
function storedReply(v: unknown): AsstReply | undefined {
  if (!isRecord(v)) return undefined;
  const intent = text(v.intent, 64);
  const said = text(v.text);
  if (intent === null || said === null) return undefined;
  const out: AsstReply = { intent, text: said };
  const link = (l: unknown): AsstLink | null => {
    if (!isRecord(l)) return null;
    const label = text(l.label, 200);
    const to = text(l.to, 500);
    if (label === null || to === null) return null;
    if (l.external === true) return to.startsWith('https://') ? { label, to, external: true } : null;
    return to.startsWith('/') && !to.startsWith('//') ? { label, to } : null;
  };
  const steps = list(v.steps).flatMap((st) =>
    isRecord(st) && typeof st.key === 'string' && typeof st.text === 'string'
      ? [{ key: st.key.slice(0, 64), text: st.text.slice(0, 1000), ...(st.safety === 'hot' ? { safety: 'hot' as const } : {}) }]
      : []
  );
  if (steps.length) out.steps = steps;
  const cards = list(v.cards).flatMap((c) => {
    if (!isRecord(c)) return [];
    const title = text(c.title, 300);
    if (title === null) return [];
    const to = link(c.link);
    return [{ title, ...(typeof c.image === 'string' && c.image.startsWith('/') ? { image: c.image } : {}), ...(to ? { link: to } : {}) }];
  });
  if (cards.length) out.cards = cards;
  const links = list(v.links).map(link).filter((l): l is AsstLink => !!l);
  if (links.length) out.links = links;
  const choices = list(v.choices).flatMap((ch) => {
    if (!isRecord(ch)) return [];
    const label = text(ch.label, 200);
    const chIntent = text(ch.intent, 64);
    if (label === null || chIntent === null) return [];
    const params = isRecord(ch.params)
      ? Object.fromEntries(Object.entries(ch.params).filter(([, pv]) => typeof pv === 'string').map(([k, pv]) => [k.slice(0, 32), String(pv).slice(0, 200)]))
      : undefined;
    return [{ label, intent: chIntent, ...(params ? { params } : {}) }];
  });
  if (choices.length) out.choices = choices;
  if (v.handoff === true) out.handoff = true;
  if (v.auth_required === true) out.auth_required = true;
  return out;
}

function readStoredAssist(raw: unknown): StoredAssist {
  const out: StoredAssist = { messages: [], attachments: [] };
  if (!isRecord(raw)) return out;
  for (const m of list(raw.messages).slice(-TRANSCRIPT_KEEP)) {
    if (!isRecord(m) || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const said = text(m.text);
    if (said === null) continue;
    const msg: ChatMsg = { role: m.role, text: said };
    if (m.typed === true) msg.typed = true;
    if (m.error === true) msg.error = true;
    const reply = storedReply(m.reply);
    if (reply) msg.reply = reply;
    const files = list(m.attachments).map(storedAttachment).filter((a): a is AssistAttachment => !!a);
    if (files.length) msg.attachments = files;
    out.messages.push(msg);
  }
  out.attachments = list(raw.attachments).map(storedAttachment).filter((a): a is AssistAttachment => !!a).slice(0, ATTACH_MAX);
  if (isRecord(raw.draft)) {
    const subject = text(raw.draft.subject, 200);
    const body = text(raw.draft.body, 4000);
    if (subject !== null && body !== null) {
      out.draft = {
        subject,
        body,
        ...(typeof raw.draft.unitId === 'string' ? { unitId: raw.draft.unitId.slice(0, 64) } : {}),
        // Closed-set values the server reads again; never shown, never trusted here.
        ...(isRecord(raw.draft.handoff) ? { handoff: raw.draft.handoff } : {}),
      };
    }
  }
  return out;
}

export default function Support() {
  const navigate = useNavigate();
  const { state, key: locationKey } = useLocation();
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

  /**
   * `?tab=tickets&ticket=<id>` (or `&complaint=<id>`) — the address a support
   * reply's notification carries. The page used to open on the assistant
   * whatever the link said, so «افتح «تذاكري»» landed a customer in the bot.
   * Read on mount AND on every later navigation to this page, because a tap
   * in the bell while /support is already open does not remount it.
   */
  const [searchParams] = useSearchParams();
  const qTab = searchParams.get('tab');
  const qTicket = searchParams.get('ticket') ?? '';
  const qComplaint = searchParams.get('complaint') ?? '';
  const [tab, setTab] = useState<'assistant' | 'tickets'>(qTab === 'tickets' || qTicket || qComplaint ? 'tickets' : 'assistant');
  const [threadTarget, setThreadTarget] = useState<ThreadTarget | null>(null);
  useEffect(() => {
    if (qTab === 'tickets' || qTicket || qComplaint) setTab('tickets');
    if (qTicket) setThreadTarget((prev) => ({ kind: 'ticket', id: qTicket, nonce: (prev?.nonce ?? 0) + 1 }));
    else if (qComplaint) setThreadTarget((prev) => ({ kind: 'complaint', id: qComplaint, nonce: (prev?.nonce ?? 0) + 1 }));
    // `locationKey` and not only the values: every reply on one ticket carries
    // the SAME link, so a second tap in the bell (after the thread was closed,
    // or from the assistant tab) changes no search param — only the key of
    // the navigation it made. Without it that tap did nothing at all.
  }, [qTab, qTicket, qComplaint, locationKey]);
  /**
   * THE CONVERSATION AS THIS TAB LEFT IT (src/lib/assistSession.ts), read
   * once: a reload, a language change or the trip to the sign-in page keeps
   * the steps already tried, the draft and the attached photos.
   */
  const [restored] = useState<StoredAssist>(() => readStoredAssist(loadAssistState()));
  const [messages, setMessages] = useState<ChatMsg[]>(restored.messages);
  const messagesRef = useRef<ChatMsg[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  /** Photos, clips and voice notes waiting for the ticket «تحدث مع الفريق» opens. */
  const [attachments, setAttachments] = useState<AssistAttachment[]>(restored.attachments);
  const [attachOpen, setAttachOpen] = useState(false);
  const attachedSinceOpen = useRef(0);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showTicketForm, setShowTicketForm] = useState(false);
  const [ticketsRefresh, setTicketsRefresh] = useState(0);
  /**
   * A TICKET NOW EXISTS. Latched rather than derived from the ticket list: the
   * offer belongs to the moment they opened one, not to the state of a list
   * that reloads on every tab switch, and a person who merely browses their
   * old tickets is not asked anything.
   */
  const [ticketJustOpened, setTicketJustOpened] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // A preselected ticket is only useful if the form is on screen: open it as
  // soon as the visitor is known to be signed in.
  const hasPrefill = !!prefill;
  useEffect(() => {
    if (hasPrefill && isAuthenticated) setShowTicketForm(true);
  }, [hasPrefill, isAuthenticated]);

  // Greeting + main menu are client-side (button-first); every answer after
  // that comes from the server. A conversation already under way is kept on
  // a language change: only a screen that is still just the greeting is
  // greeted again, in the new language.
  const greeting = (): ChatMsg[] => [
    {
      role: 'assistant',
      text: s.greeting,
      reply: {
        intent: 'menu',
        text: s.greeting,
        choices: s.menu.map((m) => ({ label: m.label, intent: m.intent })),
      },
    },
  ];
  const greetingRef = useRef(greeting);
  greetingRef.current = greeting;
  useEffect(() => {
    setMessages((prev) => (prev.some((m) => m.role === 'user') ? prev : greetingRef.current()));
  }, [lang]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, showTicketForm]);

  /**
   * ONE TURN OF MEMORY, HELD IN A REF.
   *
   * A ref and not state: nothing renders from it, and putting it in state
   * would re-run the conversation effect on every reply for no visible
   * change. It is overwritten by each answer — including with `undefined`,
   * which is the important half. An answer that asks nothing CLEARS the
   * question, so a stale «اكتب اسم الطابعة» cannot capture a message three
   * turns later.
   */
  const pendingRef = useRef<AsstReply['expects']>(undefined);
  /**
   * THE CONVERSATION CONTEXT (which printer, where the triage is), kept for
   * the tab. Replaced only by a reply that carries one: an answer from an
   * older handler says nothing about the printer and must not forget it.
   */
  const contextRef = useRef<unknown>(loadAssistContext());
  /** The latest handoff draft, so the ticket form opens filled in. */
  const [draft, setDraft] = useState<TicketPrefill | undefined>(restored.draft);

  /**
   * ANOTHER IDENTITY, A NEW CONVERSATION. The auth layer drops the stored
   * conversation when the signed-in user leaves (src/lib/assistSession.ts
   * `adoptAssistOwner`); a Support page already open resets with it, so the
   * next account never sees the transcript, draft, files or context of the last one.
   */
  useEffect(() => {
    const reset = () => {
      pendingRef.current = undefined;
      contextRef.current = undefined;
      setDraft(undefined);
      setAttachments([]);
      setShowTicketForm(false);
      setTicketJustOpened(false);
      setMessages(greetingRef.current());
    };
    window.addEventListener(ASSIST_CLEARED_EVENT, reset);
    return () => window.removeEventListener(ASSIST_CLEARED_EVENT, reset);
  }, []);

  // Kept for the tab, prices stripped (`storedReply`), every write guarded.
  useEffect(() => {
    saveAssistState({
      messages: messages.slice(-TRANSCRIPT_KEEP).map((m) => ({ ...m, reply: m.reply ? storedReply(m.reply) : undefined })),
      attachments,
      draft,
    });
  }, [messages, attachments, draft]);

  const send = useCallback(
    async (payload: { intent?: string; params?: Record<string, unknown>; text?: string }, label: string) => {
      if (busy) return;
      const sent: ChatMsg = { role: 'user', text: label, ...(payload.text !== undefined ? { typed: true } : {}) };
      setMessages((prev) => [...prev, sent]);
      setBusy(true);
      // A tapped chip names its own intent, so the pending question is moot —
      // and sending it anyway would let a stale slot override a clear answer.
      const expects = payload.intent ? undefined : pendingRef.current;
      try {
        const d = await api.post<{ reply: AsstReply }>('/api/support/assistant', {
          ...payload,
          expects,
          context: contextRef.current,
          locale: lang,
        });
        pendingRef.current = d.reply.expects;
        if (d.reply.context !== undefined) {
          contextRef.current = d.reply.context;
          saveAssistContext(d.reply.context);
        }
        if (d.reply.ticket_draft) {
          /**
           * «من المحادثة»: the customer's own last few typed lines, appended in
           * the open where they can read and edit them before sending. Nothing
           * from the conversation travels that the form does not show.
           */
          const quoted = [...messagesRef.current, sent]
            .filter((m) => m.role === 'user' && m.typed && m.text.trim())
            .slice(-5)
            .map((m) => `- ${m.text.trim().slice(0, 200)}`);
          const body = quoted.length ? `${d.reply.ticket_draft.body}\n\n${s.fromChat}\n${quoted.join('\n')}` : d.reply.ticket_draft.body;
          setDraft({
            subject: d.reply.ticket_draft.subject,
            body: body.slice(0, 4000),
            unitId: d.reply.ticket_draft.unit_id,
            ...(d.reply.ticket_draft.handoff ? { handoff: d.reply.ticket_draft.handoff } : {}),
          });
        }
        setMessages((prev) => [...prev, { role: 'assistant', text: d.reply.text, reply: d.reply }]);
        if (d.reply.handoff) {
          if (isAuthenticated) setShowTicketForm(true);
        }
      } catch (e) {
        // The turn failed, so the question was never answered: KEEP it, and a
        // retry after a dropped connection still lands where it was going.
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', text: e instanceof ApiError ? e.message : s.netError, error: true },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy, lang, isAuthenticated, s.netError, s.fromChat]
  );

  /**
   * A FILE ARRIVED FROM THE + SHEET. It is shown at once as the customer's
   * own bubble and waits for the ticket. The acknowledgement is said here, on
   * the page: nothing reads the file in this push, so no server turn pretends
   * to have looked at it. It carries the chips of the step the customer was
   * on, so «تحدث مع الفريق» is still one tap away.
   */
  const onAttached = (a: AssistAttachment) => {
    attachedSinceOpen.current += 1;
    setAttachments((prev) => (prev.some((x) => x.key === a.key) ? prev : [...prev, a].slice(0, ATTACH_MAX)));
    setMessages((prev) => [...prev, { role: 'user', text: '', attachments: [a] }]);
  };
  const closeAttach = () => {
    setAttachOpen(false);
    if (attachedSinceOpen.current === 0) return;
    attachedSinceOpen.current = 0;
    setMessages((prev) => {
      const last = [...prev].reverse().find((m) => m.role === 'assistant' && m.reply?.intent !== 'attach_ack');
      const choices = last?.reply?.choices;
      return [...prev, { role: 'assistant', text: s.attachAck, reply: { intent: 'attach_ack', text: s.attachAck, ...(choices ? { choices } : {}) } }];
    });
  };
  const removeAttachment = (key: string) => setAttachments((prev) => prev.filter((a) => a.key !== key));

  /**
   * `/support?ask=choose_printer` — «ساعدني أختار» on the home page opens the
   * assistant already asking the printer question, exactly as if the chip had
   * been tapped. ALLOW-LISTED: a link can start only a question that needs no
   * account and changes nothing, never an arbitrary intent from a URL.
   * Keyed on the navigation, so the same link tapped again asks again.
   */
  const qAsk = searchParams.get('ask');
  const askedRef = useRef<string | null>(null);
  useEffect(() => {
    if (qAsk !== 'choose_printer') return;
    const key = `${qAsk}:${locationKey}`;
    if (askedRef.current === key) return;
    askedRef.current = key;
    setTab('assistant');
    const item = s.menu.find((m) => m.intent === qAsk);
    if (item) void send({ intent: item.intent }, item.label);
    // `send` and the strings are read at the moment of the navigation only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qAsk, locationKey]);

  const sendText = () => {
    const q = input.trim();
    if (!q) return;
    setInput('');
    send({ text: q }, q);
  };

  const onTicketCreated = (t: Ticket) => {
    setShowTicketForm(false);
    setDraft(undefined);
    // The files went with the ticket; the next ticket starts empty.
    setAttachments([]);
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
    setTicketJustOpened(true);
  };

  // Suggestions belong to the current turn, not to every historical message.
  // Keeping only the latest assistant reply avoids a wall of duplicate chips
  // and gives the server room to return context-specific next actions.
  const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  const activeChoices = latestAssistant?.reply?.choices ?? [];

  return (
    <div className="flex h-full min-h-0 w-full flex-col text-text-secondary" data-support-layout>
      {/* header */}
      <div className="z-40 flex shrink-0 items-center gap-3 border-b border-border-subtle bg-canvas px-4 py-3">
        <IconButton
          variant="secondary"
          onClick={() => {
            navigate(-1);
          }}
          label={s.back}
          icon={dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        />
        <LifeBuoy className="w-5 h-5 shrink-0 text-gold" aria-hidden="true" />
        {/* ONE BAR STAYS ONE BAR AT 320px.
            Fixed chrome in this row is 188px (32 padding + 44 back button +
            20 icon + 44 character slot + 4x12 gaps), leaving 132px for an
            18px-bold title. «الدعم والمساعدة» and «پشتگیری و یارمەتی» are
            both wider than that, so without a guard the h1 wrapped, the bar
            grew to two rows, and the character sat beside a two-line title —
            the stacked shape this header exists to remove. Everything else in
            the row is `shrink-0`, so the title is the only thing that gives;
            `min-w-0` must ride along with `truncate`, because the
            `whitespace-nowrap` inside `truncate` otherwise raises the flex
            item's automatic minimum to its full max-content width and pushes
            the title out of the bar instead of ellipsizing it. */}
        <h1 className="min-w-0 truncate text-text-primary font-bold text-lg">{s.title}</h1>
        {/* ONE BAR, NOT TWO.
            The shell reserves `lv-character-fallback-header` — a full 60-72px
            strip of its own — for any route that registers no character
            anchor, and this page registered none. So the character arrived in
            a bar ABOVE this one and the whole conversation started a header
            lower on a phone, which is what the owner photographed.
            `characterLayout.hasPageAnchor()` goes true the moment a page owns
            a slot and the shell's strip returns null, so claiming the slot
            HERE is what removes the second bar. It sits immediately after the
            title rather than at the trailing edge because it was asked for
            «بجانب كلمه المساعده والدعم» — beside the words, not across the
            bar from them. */}
        <div className="shrink-0">
          <MotionCharacterHome kind="top-header" compact busy={busy} />
        </div>
        <span className="flex-1" aria-hidden="true" />
      </div>

      {/* tabs */}
      <div className="shrink-0 px-4 pt-3">
        <div className="mx-auto flex max-w-3xl rounded-full lv-well border border-border-subtle p-1" role="tablist" aria-label={s.title}>
          {(['assistant', 'tickets'] as const).map((tabId) => (
            <button
              key={tabId}
              type="button"
              role="tab"
              aria-selected={tab === tabId}
              onClick={() => setTab(tabId)}
              className={`min-h-10 flex-1 rounded-full border px-3 py-2 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                tab === tabId ? TAB_ON : TAB_OFF
              }`}
            >
              {tabId === 'assistant' ? s.tabAssistant : s.tabTickets}
            </button>
          ))}
        </div>
      </div>

      {tab === 'tickets' ? (
        /* THE TAB IS A COLUMN, NOT A SCROLLER. `TicketsTab` owns its own
           scrolling now, because an open thread has to put a scrolling message
           list and a `shrink-0` composer side by side inside this height —
           which is impossible while the parent is the thing that scrolls. */
        <div className="flex min-h-0 flex-1 flex-col">
          <TicketsTab s={s} lang={lang} refreshKey={ticketsRefresh} target={threadTarget} onTargetOpened={() => setThreadTarget(null)} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* conversation */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-support-conversation>
            <div className="mx-auto max-w-3xl space-y-3 p-4 pb-5">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className="max-w-[92%] space-y-2 sm:max-w-[82%]">
                  {m.attachments && m.attachments.length > 0 && (
                    <div className="flex flex-wrap justify-end gap-2" data-assist-attachment>
                      {m.attachments.map((a) => (
                        <AttachmentThumb key={a.key} a={a} label={s.voiceNote} />
                      ))}
                    </div>
                  )}
                  {(m.text || !m.attachments?.length) && (
                  <div
                    className={`inline-block rounded-xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words ${
                      m.role === 'user'
                        ? 'bg-surface-selected border border-border-subtle text-text-primary'
                        : m.error
                          ? 'lv-alert lv-alert-danger text-text-primary'
                          : 'bg-surface text-text-secondary'
                    }`}
                  >
                    {m.error && <AlertTriangle className="w-3.5 h-3.5 inline-block me-1 -mt-0.5" />}
                    {m.text}
                  </div>
                  )}

                  {m.reply?.steps && m.reply.steps.length > 0 && (
                    <ol className="list-decimal space-y-1.5 rounded-xl bg-surface px-3.5 py-2.5 ps-8 text-sm leading-relaxed text-text-secondary" data-assist-steps>
                      {m.reply.steps.map((step) => (
                        <li key={step.key}>
                          {step.safety === 'hot' && <AlertTriangle className="me-1 -mt-0.5 inline-block h-3.5 w-3.5 text-gold" aria-hidden="true" />}
                          {step.text}
                        </li>
                      ))}
                    </ol>
                  )}

                  {m.reply?.cards && m.reply.cards.length > 0 && (
                    <div className="space-y-2">
                      {m.reply.cards.map((card, j) => (
                        <ReplyCard key={j} card={card} onNavigate={(to) => navigate(to)} />
                      ))}
                    </div>
                  )}

                  {m.reply?.table && m.reply.table.rows.length > 0 && (
                    <ReplyTable table={m.reply.table} bestLabel={s.bestCell} />
                  )}

                  {m.reply?.links && m.reply.links.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {/* AN EXTERNAL LINK IS AN ANCHOR, NOT A ROUTE.
                          LEVO Studio is served from its own subdomain, and
                          `navigate('https://…')` inside a SPA produces a route
                          that does not exist and a blank screen — which is how
                          a working answer turns into a bug report. It opens in
                          a new tab so the conversation is still there to come
                          back to, with the rel the target demands.

                          The origin itself is never written here: it arrives
                          on the reply, from the one constant the Worker owns.
                          tests/store-isolation.test.ts forbids the literal
                          anywhere in src/ outside translations.ts, and that
                          rule is right — a second copy of a URL is a URL that
                          gets moved once. */}
                      {m.reply.links.map((l, j) =>
                        l.external ? (
                          <a
                            key={j}
                            href={l.to}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="lv-button lv-button-ghost min-h-9 rounded-full px-3 py-1.5 text-xs text-gold"
                          >
                            {l.label}
                          </a>
                        ) : (
                          <button
                            key={j}
                            onClick={() => navigate(l.to)}
                            className="lv-button lv-button-ghost min-h-9 rounded-full px-3 py-1.5 text-xs text-gold"
                          >
                            {l.label}
                          </button>
                        )
                      )}
                    </div>
                  )}

                  {m.reply?.handoff && !showTicketForm && (
                    <button
                      onClick={() => (isAuthenticated ? setShowTicketForm(true) : signIn())}
                      className="lv-button lv-button-primary min-h-10 px-3 text-xs"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      {isAuthenticated ? s.openTicketCta : s.signIn}
                    </button>
                  )}
                </div>
              </div>
            ))}

            {busy && <div className="text-xs text-text-muted px-1">{s.thinking}</div>}

            {showTicketForm && (
              <TicketForm
                s={s}
                lang={lang}
                loc={loc}
                initial={draft ?? prefill}
                attachments={attachments}
                onRemoveAttachment={removeAttachment}
                onClose={() => setShowTicketForm(false)}
                onCreated={onTicketCreated}
              />
            )}
            <div ref={bottomRef} />
            </div>
          </div>

          {/* Suggestions and composer form one persistent control. They stay in
              flex flow, so the keyboard resizes the conversation instead of
              covering its final message. */}
          <div className="z-40 shrink-0 border-t border-border-subtle bg-surface-raised/98 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]" data-support-composer>
            {!showTicketForm && activeChoices.length > 0 && (
              <div className="mx-auto mb-2 flex max-w-3xl gap-2 overflow-x-auto pb-0.5 hide-scrollbar" data-support-suggestions>
                {activeChoices.map((choice, index) => (
                  <button
                    key={`${choice.intent}:${index}`}
                    type="button"
                    onClick={() => send({ intent: choice.intent, params: choice.params }, choice.label)}
                    disabled={busy}
                    className="shrink-0 rounded-full border border-border-subtle bg-surface px-3 py-1.5 text-xs font-bold text-text-secondary transition-colors hover:bg-surface-selected hover:text-text-primary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            )}
            {attachOpen && isAuthenticated && (
              <ChunkBoundary compact>
                <Suspense fallback={null}>
                  <AssistAttach lang={lang} remaining={ATTACH_MAX - attachments.length} onAttached={onAttached} onClose={closeAttach} />
                </Suspense>
              </ChunkBoundary>
            )}
            <div className="max-w-3xl mx-auto flex gap-2">
              {/* THE +: a photo, a clip or a voice note for the team. A guest is
                  asked to sign in first (the files are kept under an account);
                  the conversation survives the trip in this tab. */}
              <button
                type="button"
                onClick={() => (isAuthenticated ? (attachOpen ? closeAttach() : setAttachOpen(true)) : signIn())}
                disabled={busy}
                className="lv-button lv-button-secondary w-12 shrink-0 px-0"
                aria-label={isAuthenticated ? s.attachAdd : s.attachSignIn}
                title={isAuthenticated ? s.attachAdd : s.attachSignIn}
                aria-expanded={isAuthenticated ? attachOpen : undefined}
                data-assist-attach-button
              >
                <Plus className="w-4 h-4" />
              </button>
              <input
                className="lv-input flex-1 min-w-0 text-sm"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') sendText();
                }}
                maxLength={500}
                placeholder={s.inputPlaceholder}
                aria-label={s.inputPlaceholder}
              />
              <button
                type="button"
                onClick={sendText}
                disabled={busy || input.trim().length === 0}
                className="lv-button lv-button-primary w-12 shrink-0 px-0"
                aria-label={s.send}
              >
                <Send className={`w-4 h-4 ${dir === 'rtl' ? 'rotate-180' : ''}`} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rendered at the page root, not inside the form: the form unmounts the
          instant the ticket is created, and a window mounted inside it would
          be destroyed before it could ever say anything. It portals out of
          this tree anyway and blocks nothing — the new ticket is already
          visible in the list behind it. */}
      <ChannelNudge context="ticket" active={ticketJustOpened} />
    </div>
  );
}
