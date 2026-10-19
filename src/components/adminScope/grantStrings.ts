/**
 * THE OWNER'S GRANTS — WHO HANDLES WHICH DESK (owner decision C5; P1-02,
 * DECISIONS row 261). Three desks open to an assistant admin only by the
 * owner's grant: merchant applications (MERCHANT_REVIEW), identity and address
 * verification (KYC_REVIEW), complaints and disputes (DISPUTES). The owner and
 * full admins hold all three by default, and none of them opens money.
 *
 * The merchant-review words moved here unchanged from reviewerStrings.ts. The
 * Sorani reuses the vocabulary of AdminKyc.tsx and the refusal table:
 * پێداچوونەوە, پشتڕاستکردنەوە, سکاڵا, ناکۆکی, مۆڵەت. `ckb` is never a copy of the
 * Arabic (DECISIONS row 183) — tests/adminScopeKycDisputes.test.ts holds it to that.
 */
import type { CapabilityKey } from '../../lib/merchantApplication';

interface Desk {
  title: string;
  hint: string;
  byDefault: string;
}

interface GrantStrings {
  desks: Record<CapabilityKey, Desk>;
  granted: string;
  notGranted: string;
  grant: string;
  revoke: string;
  noAssistants: string;
  loadError: string;
  actionError: string;
}

const ar: GrantStrings = {
  desks: {
    MERCHANT_REVIEW: {
      title: 'من يراجع طلبات التجار',
      hint: 'المالك والمدير الكامل يراجعون دائمًا. المساعد يراجع فقط بإذن يمنحه المالك — ولا يفتح له أي صلاحية مالية.',
      byDefault: 'يراجع دائمًا (مدير كامل)',
    },
    KYC_REVIEW: {
      title: 'من يراجع التحقق والعناوين',
      hint: 'المالك والمدير الكامل يراجعون دائمًا. المساعد يفتح وثائق الهوية وطلبات العناوين فقط بإذن يمنحه المالك — ولا يفتح له أي صلاحية مالية.',
      byDefault: 'يراجعها دائمًا (مدير كامل)',
    },
    DISPUTES: {
      title: 'من يعالج الشكاوى والنزاعات',
      hint: 'المالك والمدير الكامل يعالجونها دائمًا. المساعد يقرأ الشكاوى ويرد عليها ويغيّر حالتها فقط بإذن يمنحه المالك — وتسوية الأموال المحتجزة تبقى خارج هذا الإذن.',
      byDefault: 'يعالجها دائمًا (مدير كامل)',
    },
  },
  granted: 'مأذون له',
  notGranted: 'غير مأذون',
  grant: 'منح الإذن',
  revoke: 'سحب الإذن',
  noAssistants: 'لا يوجد مديرون آخرون.',
  loadError: 'تعذّر تحميل قائمة المديرين',
  actionError: 'تعذّر تنفيذ الإجراء',
};

const en: GrantStrings = {
  desks: {
    MERCHANT_REVIEW: {
      title: 'Who reviews merchant applications',
      hint: 'The owner and full admins always review. An assistant reviews only with access the owner grants — and it opens no financial access.',
      byDefault: 'Always reviews (full admin)',
    },
    KYC_REVIEW: {
      title: 'Who reviews identity and addresses',
      hint: 'The owner and full admins always review. An assistant opens identity documents and address requests only with access the owner grants — and it opens no financial access.',
      byDefault: 'Always reviews them (full admin)',
    },
    DISPUTES: {
      title: 'Who handles complaints and disputes',
      hint: 'The owner and full admins always handle them. An assistant reads, answers and moves complaints only with access the owner grants — settling held money stays outside this access.',
      byDefault: 'Always handles them (full admin)',
    },
  },
  granted: 'Granted',
  notGranted: 'Not granted',
  grant: 'Grant access',
  revoke: 'Revoke access',
  noAssistants: 'There are no other admins.',
  loadError: 'The list of admins could not be loaded',
  actionError: 'The action failed',
};

const ckb: GrantStrings = {
  desks: {
    MERCHANT_REVIEW: {
      title: 'کێ پێداچوونەوە بە داواکارییەکانی بازرگان دەکات',
      hint: 'خاوەن و بەڕێوەبەری تەواو هەمیشە پێداچوونەوە دەکەن. یاریدەدەر تەنها بە مۆڵەتێک کە خاوەن دەیدات پێداچوونەوە دەکات — و هیچ دەسەڵاتێکی دارایی بۆ ناکاتەوە.',
      byDefault: 'هەمیشە پێداچوونەوە دەکات (بەڕێوەبەری تەواو)',
    },
    KYC_REVIEW: {
      title: 'کێ پێداچوونەوە بە پشتڕاستکردنەوەی ناسنامە و ناونیشانەکان دەکات',
      hint: 'خاوەن و بەڕێوەبەری تەواو هەمیشە پێداچوونەوە دەکەن. یاریدەدەر تەنها بە مۆڵەتێک کە خاوەن دەیدات بەڵگەنامەکانی ناسنامە و داواکارییەکانی ناونیشان دەکاتەوە — و هیچ دەسەڵاتێکی دارایی بۆ ناکاتەوە.',
      byDefault: 'هەمیشە پێداچوونەوەیان دەکات (بەڕێوەبەری تەواو)',
    },
    DISPUTES: {
      title: 'کێ سکاڵا و ناکۆکییەکان چارەسەر دەکات',
      hint: 'خاوەن و بەڕێوەبەری تەواو هەمیشە چارەسەریان دەکەن. یاریدەدەر تەنها بە مۆڵەتێک کە خاوەن دەیدات سکاڵاکان دەخوێنێتەوە، وەڵامیان دەداتەوە و دۆخیان دەگۆڕێت — یەکلاکردنەوەی پارەی گیراو لە دەرەوەی ئەم مۆڵەتە دەمێنێتەوە.',
      byDefault: 'هەمیشە چارەسەریان دەکات (بەڕێوەبەری تەواو)',
    },
  },
  granted: 'مۆڵەتی هەیە',
  notGranted: 'مۆڵەتی نییە',
  grant: 'پێدانی مۆڵەت',
  revoke: 'کێشانەوەی مۆڵەت',
  noAssistants: 'هیچ بەڕێوەبەرێکی تر نییە.',
  loadError: 'لیستی بەڕێوەبەران بار نەکرا',
  actionError: 'کردارەکە سەرکەوتوو نەبوو',
};

export const GRANT_STRINGS = { ar, en, ckb } as const;
