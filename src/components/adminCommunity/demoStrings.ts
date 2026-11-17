/**
 * «بيانات تجريبية» — the admin card's words (worker/lib/communityDemo.ts), in
 * Arabic, English and Sorani (docs/DECISIONS.md row 183: a Sorani slot is
 * Sorani, never the Arabic copied). tests/communityDemo.test.ts holds the
 * three to the same keys.
 */
import type { Language } from '../../translations';

export interface DemoCardStrings {
  title: string;
  intro: string;
  seed: string;
  remove: string;
  refresh: string;
  none: string;
  total: (n: number) => string;
  openBlocked: string;
  removeTitle: string;
  removeConsequence: (n: number) => string;
  removeConfirm: string;
  cancel: string;
  seeded: (n: number) => string;
  alreadyPresent: string;
  removed: (n: number) => string;
  failed: string;
  tables: Record<string, string>;
}

const TABLES_AR: Record<string, string> = {
  users: 'حسابات تجريبية',
  community_merchants: 'تجار',
  merchant_stores: 'ورش ومتاجر',
  merchant_printers: 'طابعات الورش',
  merchant_request_prefs: 'إعدادات الورش',
  community_posts: 'مشاريع ومنشورات',
  community_comments: 'تعليقات',
  community_likes: 'إعجابات',
  community_saves: 'حفظ',
  user_follows: 'متابعات الصناع',
  follows: 'متابعات المتاجر',
  community_requests: 'طلبات طباعة',
  community_offers: 'عروض',
};

export const DEMO_CARD_STRINGS: Record<Language, DemoCardStrings> = {
  ar: {
    title: 'بيانات تجريبية',
    intro: 'صنّاع وورش ومشاريع وطلبات وعروض وهمية لتجربة المجتمع وهو مغلق. كل ما يُضاف يحمل شارة «تجريبي» ويُحذف كله بضغطة واحدة. لا منتجات ولا طلبات شراء ولا أموال.',
    seed: 'إضافة بيانات تجريبية',
    remove: 'حذف كل البيانات التجريبية',
    refresh: 'تحديث',
    none: 'لا توجد بيانات تجريبية الآن.',
    total: (n) => `${n} سجلًا تجريبيًا`,
    openBlocked: 'المجتمع مفتوح للجميع، فلا تُضاف بيانات تجريبية. أغلقه أولًا.',
    removeTitle: 'حذف كل البيانات التجريبية؟',
    removeConsequence: (n) => `سيُحذف ${n} سجلًا تجريبيًا، ومعها أي إعجاب أو متابعة أو تعليق أو عرض أضافه حساب حقيقي عليها. لا يمكن التراجع.`,
    removeConfirm: 'حذف الكل',
    cancel: 'إلغاء',
    seeded: (n) => `أُضيف ${n} سجلًا تجريبيًا.`,
    alreadyPresent: 'البيانات التجريبية موجودة مسبقًا، لم يُضف شيء.',
    removed: (n) => `حُذف ${n} سجلًا.`,
    failed: 'تعذّر تنفيذ الإجراء.',
    tables: TABLES_AR,
  },
  en: {
    title: 'Demo data',
    intro: 'Fake makers, workshops, projects, requests and offers for testing the community while it is closed. Everything added carries a «Demo» badge and is removed in one press. No products, no orders, no money.',
    seed: 'Add demo data',
    remove: 'Remove all demo data',
    refresh: 'Refresh',
    none: 'There is no demo data right now.',
    total: (n) => `${n} demo rows`,
    openBlocked: 'The community is open to the public, so demo data cannot be added. Close it first.',
    removeTitle: 'Remove all demo data?',
    removeConsequence: (n) => `${n} demo rows will be deleted, with any like, follow, comment or offer a real account made on them. This cannot be undone.`,
    removeConfirm: 'Remove all',
    cancel: 'Cancel',
    seeded: (n) => `Added ${n} demo rows.`,
    alreadyPresent: 'The demo data is already there; nothing was added.',
    removed: (n) => `Removed ${n} rows.`,
    failed: 'The action could not be completed.',
    tables: {
      users: 'Demo accounts',
      community_merchants: 'Merchants',
      merchant_stores: 'Workshops & stores',
      merchant_printers: 'Workshop printers',
      merchant_request_prefs: 'Workshop settings',
      community_posts: 'Projects & posts',
      community_comments: 'Comments',
      community_likes: 'Likes',
      community_saves: 'Saves',
      user_follows: 'Maker follows',
      follows: 'Store follows',
      community_requests: 'Print requests',
      community_offers: 'Offers',
    },
  },
  ckb: {
    title: 'داتای تاقیکاری',
    intro: 'دروستکەر و کارگە و پڕۆژە و داواکاری و پێشنیاری ساختە بۆ تاقیکردنەوەی کۆمەڵگە کاتێک داخراوە. هەموو ئەوەی زیاد دەکرێت نیشانەی «تاقیکاری» هەیە و بە یەک کرتە هەمووی دەسڕدرێتەوە. هیچ بەرهەم و داواکاری کڕین و پارەیەک نییە.',
    seed: 'زیادکردنی داتای تاقیکاری',
    remove: 'سڕینەوەی هەموو داتای تاقیکاری',
    refresh: 'نوێکردنەوە',
    none: 'ئێستا هیچ داتایەکی تاقیکاری نییە.',
    total: (n) => `${n} تۆماری تاقیکاری`,
    openBlocked: 'کۆمەڵگە بۆ هەمووان کراوەیە، بۆیە داتای تاقیکاری زیاد ناکرێت. سەرەتا دایبخە.',
    removeTitle: 'هەموو داتای تاقیکاری بسڕدرێتەوە؟',
    removeConsequence: (n) => `${n} تۆماری تاقیکاری دەسڕدرێتەوە، لەگەڵ هەر لایک و شوێنکەوتن و لێدوان و پێشنیارێک کە هەژمارێکی ڕاستەقینە لەسەریان کردبێتی. ناگەڕێتەوە.`,
    removeConfirm: 'سڕینەوەی هەموو',
    cancel: 'هەڵوەشاندنەوە',
    seeded: (n) => `${n} تۆماری تاقیکاری زیاد کرا.`,
    alreadyPresent: 'داتای تاقیکاری پێشتر هەیە، هیچ زیاد نەکرا.',
    removed: (n) => `${n} تۆمار سڕایەوە.`,
    failed: 'کردارەکە ئەنجام نەدرا.',
    tables: {
      users: 'هەژماری تاقیکاری',
      community_merchants: 'بازرگانەکان',
      merchant_stores: 'کارگە و فرۆشگاکان',
      merchant_printers: 'چاپکەرەکانی کارگە',
      merchant_request_prefs: 'ڕێکخستنی کارگە',
      community_posts: 'پڕۆژە و بڵاوکراوەکان',
      community_comments: 'لێدوانەکان',
      community_likes: 'لایکەکان',
      community_saves: 'پاشەکەوتکراوەکان',
      user_follows: 'شوێنکەوتنی دروستکەران',
      follows: 'شوێنکەوتنی فرۆشگاکان',
      community_requests: 'داواکارییەکانی چاپ',
      community_offers: 'پێشنیارەکان',
    },
  },
};
