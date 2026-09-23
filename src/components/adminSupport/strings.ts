/**
 * The console's OWN words — the tabs, the message inbox and the few labels the
 * ticket queue did not already have. The ticket queue keeps reading
 * `adminMemberships/strings.ts`, where its sentences have lived since it was a
 * membership tab; nothing is copied from there, so the two cannot drift.
 *
 * SORANI. Only short labels, and only where an existing Sorani string in this
 * product already says the same thing (the order chat's «نامە», the queue's
 * «تیکێت», the bell's «نەخوێندراوە»). Anything longer carries the ARABIC with
 * an OWNER marker — the rule the notification copy already follows — because a
 * generated Kurdish sentence is worse than an honest Arabic one.
 */
export interface ConsoleStrings {
  tabTickets: string;
  tabMessages: string;
  tabComplaints: string;
  consoleLabel: string;
  waiting: string;
  messagesTitle: string;
  messagesHint: string;
  unreadOnly: string;
  allThreads: string;
  messagesEmpty: string;
  unreadBadge: (n: number) => string;
  image: string;
  video: string;
  audio: string;
  file: string;
  fromTeam: string;
  order: string;
  back: string;
  openImage: string;
  refresh: string;
}

export const CONSOLE_STRINGS: Record<'ar' | 'en' | 'ckb', ConsoleStrings> = {
  ar: {
    tabTickets: 'التذاكر',
    tabMessages: 'الرسائل',
    tabComplaints: 'الشكاوى',
    consoleLabel: 'الدعم',
    waiting: 'بانتظار الرد',
    messagesTitle: 'رسائل الزبائن على طلباتهم',
    messagesHint: 'محادثات «محادثة حول هذا الطلب» — الأحدث غير المقروء أولًا.',
    unreadOnly: 'غير المقروءة',
    allThreads: 'الكل',
    messagesEmpty: 'لا توجد رسائل من الزبائن بعد.',
    unreadBadge: (n: number) => `${n.toLocaleString('ar')} غير مقروءة`,
    image: 'صورة',
    video: 'فيديو',
    audio: 'رسالة صوتية',
    file: 'ملف',
    fromTeam: 'الفريق',
    order: 'الطلب',
    back: 'رجوع',
    openImage: 'فتح الصورة بالحجم الكامل',
    refresh: 'تحديث',
  },
  en: {
    tabTickets: 'Tickets',
    tabMessages: 'Messages',
    tabComplaints: 'Complaints',
    consoleLabel: 'Support',
    waiting: 'Awaiting a reply',
    messagesTitle: 'Customer messages about their orders',
    messagesHint: '«Chat about this order» threads — unread first, newest first.',
    unreadOnly: 'Unread',
    allThreads: 'All',
    messagesEmpty: 'No customer messages yet.',
    unreadBadge: (n: number) => `${n} unread`,
    image: 'Image',
    video: 'Video',
    audio: 'Voice message',
    file: 'File',
    fromTeam: 'Staff',
    order: 'Order',
    back: 'Back',
    openImage: 'Open the full-size image',
    refresh: 'Refresh',
  },
  ckb: {
    tabTickets: 'تیکێتەکان',
    tabMessages: 'نامەکان',
    tabComplaints: 'الشكاوى', // OWNER: Sorani by hand.
    consoleLabel: 'پشتگیری',
    waiting: 'بانتظار الرد', // OWNER: Sorani by hand.
    messagesTitle: 'رسائل الزبائن على طلباتهم', // OWNER: Sorani by hand.
    messagesHint: 'محادثات «محادثة حول هذا الطلب» — الأحدث غير المقروء أولًا.', // OWNER: Sorani by hand.
    unreadOnly: 'نەخوێندراوە',
    allThreads: 'هەموو',
    messagesEmpty: 'لا توجد رسائل من الزبائن بعد.', // OWNER: Sorani by hand.
    unreadBadge: (n: number) => `${n} نەخوێندراوە`,
    image: 'وێنە',
    video: 'ڤیدیۆ',
    audio: 'رسالة صوتية', // OWNER: Sorani by hand.
    file: 'ملف', // OWNER: Sorani by hand.
    fromTeam: 'تیم',
    order: 'داواکاری',
    back: 'گەڕانەوە',
    openImage: 'فتح الصورة بالحجم الكامل', // OWNER: Sorani by hand.
    refresh: 'نوێکردنەوە',
  },
};

export function consoleStrings(lang: string): ConsoleStrings {
  return (CONSOLE_STRINGS as Record<string, ConsoleStrings>)[lang] ?? CONSOLE_STRINGS.ar;
}

/** An attachment-only last message, in a word — the server sends the
 *  attachment's real kind (worker/routes/adminChats.ts), not the column that
 *  can only say 'text' or 'image'. */
export function previewLabel(kind: string, cs: Pick<ConsoleStrings, 'image' | 'video' | 'audio' | 'file'>): string {
  if (kind === 'image') return cs.image;
  if (kind === 'video') return cs.video;
  if (kind === 'audio') return cs.audio;
  if (kind === 'file') return cs.file;
  return '';
}
