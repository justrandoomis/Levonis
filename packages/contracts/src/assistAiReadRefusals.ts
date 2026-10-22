/**
 * THE CUSTOMER'S READ REFUSALS (push B plan §5.2–§5.4), in Arabic, English
 * and Sorani: the few ways `POST /api/support/assistant/read` and
 * `/read-frames` refuse a request outright. Everything else a reading can
 * meet (switched off, the cap, a limit, a provider fault, an unclear picture)
 * is an ordinary reply in the chat, never an error. The assistant page
 * renders the customer's language by CODE from this table.
 *
 * ITS OWN MODULE, so the page's lazy + sheet chunk carries these five
 * sentences and never the owner tab's table (./assistAiRefusals.ts, which
 * re-exports this one for the Worker and the tests): a bundler shares a
 * whole module between the chunks that import it.
 *
 * A key that is not the customer's own, or not uploaded, keeps push A's codes
 * (ATTACHMENT_NOT_YOURS, ATTACHMENT_NOT_FOUND), which the page already says.
 * Every `ckb` is its own Sorani, never the Arabic pasted across
 * (docs/DECISIONS.md row 183). Pure data: no imports.
 */
export interface AssistAiReadRefusal {
  ar: string;
  en: string;
  ckb: string;
}

export const ASSIST_AI_READ_REFUSALS = {
  AI_CONSENT_REQUIRED: {
    ar: 'اقرأ ملاحظة القراءة الآلية ووافق عليها أولًا، ثم اضغط القراءة مرة أخرى.',
    en: 'Read and accept the note about automatic reading first, then press read again.',
    ckb: 'سەرەتا تێبینی خوێندنەوەی خۆکار بخوێنەوە و ڕازی بە، پاشان دووبارە خوێندنەوە دابگرە.',
  },
  AI_READ_INVALID: {
    ar: 'طلب القراءة غير مكتمل. أرفق الملف مرة أخرى ثم حاول.',
    en: 'The reading request is incomplete. Attach the file again, then try.',
    ckb: 'داواکاری خوێندنەوەکە تەواو نییە. فایلەکە دووبارە هاوپێچ بکە، پاشان هەوڵ بدەرەوە.',
  },
  AI_READ_KIND: {
    ar: 'هذا المرفق ليس من النوع الذي طُلبت قراءته.',
    en: 'This attachment is not the kind that was asked to be read.',
    ckb: 'ئەم هاوپێچە لەو جۆرە نییە کە داوای خوێندنەوەی کرا.',
  },
  AI_FRAMES_INVALID: {
    ar: 'لم تصل لقطات صالحة من المقطع. المقطع ما زال مرفقًا.',
    en: 'No valid frames of the clip arrived. The clip is still attached.',
    ckb: 'هیچ وێنەیەکی دروست لە ڤیدیۆکە نەگەیشت. ڤیدیۆکە هێشتا هاوپێچ کراوە.',
  },
  AI_FRAMES_TOO_LARGE: {
    ar: 'لقطات المقطع أكبر من المسموح. المقطع ما زال مرفقًا.',
    en: 'The frames of the clip are larger than allowed. The clip is still attached.',
    ckb: 'وێنەکانی ڤیدیۆکە لەوەی ڕێگەپێدراوە گەورەترن. ڤیدیۆکە هێشتا هاوپێچ کراوە.',
  },
} as const satisfies Record<string, AssistAiReadRefusal>;

export type AssistAiReadRefusalCode = keyof typeof ASSIST_AI_READ_REFUSALS;

/** The server sentence for a read refusal: "ar / en". */
export function assistAiReadMessage(code: AssistAiReadRefusalCode): string {
  const e = ASSIST_AI_READ_REFUSALS[code];
  return `${e.ar} / ${e.en}`;
}
