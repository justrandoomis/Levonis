import type { Language } from '../../translations';

export interface FarmStrings {
  title: string;
  back: string;
  level: string;
  hubTitle: string;
  hubKicker: string;
  hubDesc: string;
  hubGuestTitle: string;
  hubGuestDesc: string;
  hubYourFarm: string;
  enterFarm: string;
  hubLeaderboards: string;
  hubLeaderboardsDesc: string;
  hubProfile: string;
  hubProfileDesc: string;
  hubRedeem: string;
  hubRedeemDesc: string;

  // Leaderboard
  lbTitle: string;
  lbBoardsLabel: string;
  lbBoardReputation: string;
  lbBoardFarmValue: string;
  lbBoardJobs: string;
  lbEmptyTitle: string;
  lbEmptyDesc: string;
  lbRank: string;
  lbYou: string;
}

export const FARM_STRINGS: Record<Language, FarmStrings> = {
  ar: {
    title: 'مزرعة الطابعات',
    back: 'رجوع',
    level: 'المستوى',
    hubTitle: 'الألعاب',
    hubKicker: 'ألعاب ليفونيس التفاعلية',
    hubDesc: 'ابنِ مزرعة طابعاتك، نفذ طلبات التصنيع، نافس في قوائم المتصدرين واستبدل أرباحك بجوائز حقيقية.',
    hubGuestTitle: 'سجل دخولك للعب',
    hubGuestDesc: 'تحتاج إلى حساب لحفظ تقدمك ومزرعتك والجوائز التي تحققها.',
    hubYourFarm: 'مزرعتك',
    enterFarm: 'دخول المزرعة',
    hubLeaderboards: 'قوائم المتصدرين',
    hubLeaderboardsDesc: 'أفضل المزارع في السمعة وقيمة الإنتاج',
    hubProfile: 'الملف التعريفي',
    hubProfileDesc: 'إحصائيات مزرعتك وإنجازاتك',
    hubRedeem: 'استبدال العملات',
    hubRedeemDesc: 'تحويل نقاط المزرعة إلى خصومات ورصيد حقيقي',

    lbTitle: 'لوحة المتصدرين',
    lbBoardsLabel: 'لوحات الشرف',
    lbBoardReputation: 'السمعة',
    lbBoardFarmValue: 'قيمة المزرعة',
    lbBoardJobs: 'الطلبات المنجزة',
    lbEmptyTitle: 'لا يوجد لاعبون بعد',
    lbEmptyDesc: 'كن أول من يدخل المزرعة ويحقق رقماً قياسياً!',
    lbRank: 'الترتيب',
    lbYou: 'أنت',
  },
  en: {
    title: 'Printer Farm',
    back: 'Back',
    level: 'Level',
    hubTitle: 'Games Hub',
    hubKicker: 'Levonis Interactive Games',
    hubDesc: 'Build your 3D printer farm, deliver print jobs, compete on leaderboards, and redeem farm earnings for real rewards.',
    hubGuestTitle: 'Sign in to Play',
    hubGuestDesc: 'You need an account to save your farm progress and claim rewards.',
    hubYourFarm: 'Your Farm',
    enterFarm: 'Enter Farm',
    hubLeaderboards: 'Leaderboards',
    hubLeaderboardsDesc: 'Top farms ranked by reputation and output value',
    hubProfile: 'Farm Profile',
    hubProfileDesc: 'Your farm statistics and unlocked achievements',
    hubRedeem: 'Redeem Coins',
    hubRedeemDesc: 'Convert farm coins to store credit and discounts',

    lbTitle: 'Leaderboards',
    lbBoardsLabel: 'Categories',
    lbBoardReputation: 'Reputation',
    lbBoardFarmValue: 'Farm Value',
    lbBoardJobs: 'Completed Jobs',
    lbEmptyTitle: 'No players yet',
    lbEmptyDesc: 'Be the first to join the farm and claim the top spot!',
    lbRank: 'Rank',
    lbYou: 'You',
  },
  ckb: {
    title: 'کێڵگەی چاپکەرەکان',
    back: 'گەڕانەوە',
    level: 'ئاست',
    hubTitle: 'یارییەکان',
    hubKicker: 'یارییە کارلێککراوەکانی لێڤۆنیس',
    hubDesc: 'کێڵگەی چاپکەرە سێ ڕەهەندییەکانت دروستبکە، کارەکان ئەنجامبدە و خەڵات بەدەستبهێنە.',
    hubGuestTitle: 'بچۆ ژوورەوە بۆ یاری',
    hubGuestDesc: 'پێویستت بە هەژمارە بۆ پاراستنی بەرەوپێشچوونەکانت.',
    hubYourFarm: 'کێڵگەکەت',
    enterFarm: 'چوونە نێو کێڵگە',
    hubLeaderboards: 'ڕیزبەندی سەرکەوتووان',
    hubLeaderboardsDesc: 'باشترین کێڵگەکان بەپێی ناوبانگ و بەرهەم',
    hubProfile: 'پڕۆفایلی کێڵگە',
    hubProfileDesc: 'ئامارەکانی کێڵگەکەت و دەستکەوتەکان',
    hubRedeem: 'گۆڕینەوەی دراو',
    hubRedeemDesc: 'گۆڕینەوەی دراوی کێڵگە بۆ داشکاندن و باڵانسی ڕاستەقینە',

    lbTitle: 'تەختەی سەرکەوتووان',
    lbBoardsLabel: 'بەشەکان',
    lbBoardReputation: 'ناوبانگ',
    lbBoardFarmValue: 'نرخی کێڵگە',
    lbBoardJobs: 'داواکارییە تەواوکراوەکان',
    lbEmptyTitle: 'هێشتا هیچ یاریزانێک نییە',
    lbEmptyDesc: 'یەکەم کەس بە کە دەستپێدەکات!',
    lbRank: 'پلە',
    lbYou: 'تۆ',
  },
};
