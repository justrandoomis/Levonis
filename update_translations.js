import fs from 'fs';

let content = fs.readFileSync('src/translations.ts', 'utf8');

const additions = {
  en: {
    subscribeNow: "Subscribe Now",
    tangiblePhysicalCard: "Tangible Physical Card",
    planComparisons: "Plan Comparisons",
    yourLevoCard: "Your Levo Card",
    freeTier: "Free Tier",
    freeTierUpgrade: "Free Tier - Upgrade for more",
    status: "Status",
    active: "Active"
  },
  ar: {
    subscribeNow: "اشترك الآن",
    tangiblePhysicalCard: "بطاقة فعلية ملموسة",
    planComparisons: "مقارنات الخطط",
    yourLevoCard: "بطاقة Levo الخاصة بك",
    freeTier: "المستوى المجاني",
    freeTierUpgrade: "المستوى المجاني - الترقية للمزيد",
    status: "الحالة",
    active: "نشط"
  },
  ku: {
    subscribeNow: "ئێستا بەشداری بکە",
    tangiblePhysicalCard: "کارتی جەستەیی بەرجەستە",
    planComparisons: "بەراوردکردنی پلانەکان",
    yourLevoCard: "کارتی Levo ی تۆ",
    freeTier: "ئاستی بێبەرامبەر",
    freeTierUpgrade: "ئاستی بێبەرامبەر - بۆ زیاتر نوێبکەرەوە",
    status: "دۆخ",
    active: "چالاکە"
  }
};

for (const lang of Object.keys(additions)) {
  for (const key of Object.keys(additions[lang])) {
    const value = additions[lang][key];
    const regex = new RegExp('(' + lang + ': \\{[^}]*?)(' + key + ': ".*?")');
    const match = content.match(regex);
    if (!match) {
        // Add it
        const replaceRegex = new RegExp('(' + lang + ': \\{)');
        content = content.replace(replaceRegex, '$1\n    ' + key + ': "' + value + '",');
    } else {
        // Replace it
        content = content.replace(regex, '$1' + key + ': "' + value + '"');
    }
  }
}

fs.writeFileSync('src/translations.ts', content);
