/**
 * DISPUTE EVIDENCE'S WORDS — Arabic, English and written Sorani
 * (docs/COMMUNITY_ECOSYSTEM.md D6, §9.6 «Dispute evidence access»), and the
 * desk's own name in the community admin's section row.
 *
 * A table of its own, apart from the desk's (./strings.ts): the section's
 * name and the dispute desk's «المحادثة» / «الطلب» ride in the community
 * admin's chunk (../AdminCommunity.tsx, ./EvidenceLinks) and the read-only
 * banner in the chat's lazy evidence chunk (./EvidenceBanner) — neither should
 * carry the whole moderation desk.
 * EVIDENCE_NOT_LINKED / EVIDENCE_CLOSED themselves are worded by
 * src/lib/refusalStrings.ts.
 */
export type EvidenceLang = 'ar' | 'en' | 'ckb';

export interface EvidenceStrings {
  /** The moderation desk's name in the community admin's section row. */
  desk: string;
  /** The chat's banner: staff read a disputed order's thread, never write in it. */
  title: string;
  /** Every staff read session is on the record (`chat_staff_reads` + `admin.chat_read`). */
  note: string;
  conversation: string;
  request: string;
  /** The dispute desk's row of links, and the banner's links back to the case. */
  linksLabel: string;
  /** A refused evidence read (not linked yet, or the dispute decided). */
  refusedTitle: string;
  back: string;
}

export const EVIDENCE_STRINGS: Record<EvidenceLang, EvidenceStrings> = {
  ar: {
    desk: 'الإشراف',
    title: 'قراءة فقط — مراقبة نزاع',
    note: 'كل قراءة مسجَّلة',
    conversation: 'المحادثة',
    request: 'الطلب',
    linksLabel: 'أدلة النزاع',
    refusedTitle: 'لا يمكن فتح هذه المحادثة',
    back: 'رجوع',
  },
  en: {
    desk: 'Moderation',
    title: 'Read-only — dispute review',
    note: 'Every read is recorded',
    conversation: 'Conversation',
    request: 'Request',
    linksLabel: 'Dispute evidence',
    refusedTitle: 'This conversation can’t be opened',
    back: 'Back',
  },
  ckb: {
    desk: 'چاودێری',
    title: 'تەنها خوێندنەوە — چاودێریی ناکۆکی',
    note: 'هەموو خوێندنەوەیەک تۆمار دەکرێت',
    conversation: 'گفتوگۆ',
    request: 'داواکاری',
    linksLabel: 'بەڵگەکانی ناکۆکی',
    refusedTitle: 'ئەم گفتوگۆیە ناکرێتەوە',
    back: 'گەڕانەوە',
  },
};

export function evidenceStrings(lang: string): EvidenceStrings {
  return lang === 'en' ? EVIDENCE_STRINGS.en : lang === 'ckb' ? EVIDENCE_STRINGS.ckb : EVIDENCE_STRINGS.ar;
}

/** Where staff read a disputed order's conversation: the chat page in evidence mode, in the admin frame. */
export const evidenceChatHref = (chatId: string) => `/admin/chats/${encodeURIComponent(chatId)}`;

/** The custom request behind a community order — its own page. */
export const evidenceRequestHref = (requestId: string) => `/requests/${encodeURIComponent(requestId)}`;
