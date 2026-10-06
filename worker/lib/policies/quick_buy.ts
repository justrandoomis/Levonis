import type { PolicyDocument } from './types';

/**
 * سياسة الشراء السريع — «الشراء السريع» (owner brief 2026-10-06 §3–§21).
 *
 * WHY A DOCUMENT OF ITS OWN. Quick Buy asks for something no other purchase
 * asks for: a standing permission to HOLD money in the Levo wallet the moment
 * a button is pressed, and to TAKE it thirty minutes later without a second
 * confirmation. The customer accepts this document, the Terms and the Privacy
 * Policy by version when they switch Quick Buy on (§5), and a new version of
 * any of them asks for consent again before the next quick purchase.
 *
 * WHAT IT DESCRIBES IS WHAT THE CODE DOES. worker/lib/quickBuy is the only
 * place these rules run: the 30-minute window fixed at the first purchase, one
 * open Quick Buy order per customer, the wallet hold replaced on every change
 * and captured at the end, the price and stock held per item, the address
 * frozen at the start, standard delivery only, direct sale only, no coupons or
 * points. A rule written here that the code does not enforce would be a
 * promise nobody keeps.
 */
export const quick_buy: PolicyDocument = {
  key: 'quick_buy',
  version: 1,
  effective_at: '2026-10-06',
  title: {
    ar: 'سياسة الشراء السريع',
    en: 'Quick Buy Policy',
    ckb: 'سیاسەتی کڕینی خێرا',
  },
  body: {
    ar: `## 1. التمهيد والتعريفات

### 1.1 الغرض من هذه الوثيقة
تبيّن هذه الوثيقة كيف تعمل خدمة «الشراء السريع» في متجر Levonis: كيف تُفعَّل، وكيف يُحجز المال في محفظة Levo ثم يُخصم، وكيف تُحجز الكميات، وما الذي يحدث عند انتهاء مدة الطلب.

### 1.2 التعريفات
- الشراء السريع: شراء منتج من صفحته مباشرة دون المرور بالسلة وشاشة الدفع، بالدفع من محفظة Levo.
- طلب الشراء السريع: طلب واحد يجمع كل ما تشتريه بالشراء السريع خلال ثلاثين دقيقة من أول شراء.
- الحجز: مبلغ يُقتطع من رصيدك المتاح ويبقى محجوزاً لطلب الشراء السريع، دون أن يُخصم نهائياً.
- الخصم: تحويل المبلغ المحجوز إلى دفعة نهائية للطلب.
- عنوان الشراء السريع: العنوان الافتراضي الذي تختاره عند التفعيل.

### 1.3 النص المعتمد
النص العربي هو المعتمد، والنسختان الإنكليزية والكردية ترجمتان أمينتان له بالترقيم نفسه.

## 2. التفعيل والموافقة

### 2.1 التفعيل بخطوتين
لا يعمل الشراء السريع إلا بعد تفعيله: أولاً الموافقة على هذه السياسة وعلى الشروط والأحكام وسياسة الخصوصية وعلى حجز المبلغ من المحفظة وخصمه تلقائياً، وثانياً اختيار عنوان الشراء السريع وتأكيده.

### 2.2 الموافقة مسجّلة
تُسجَّل موافقتك مع وقتها ورقم إصدار كل وثيقة وافقت عليها. ولا يكون أي مربع موافقة مُعلَّماً مسبقاً.

### 2.3 تغيّر الوثائق
إذا صدر إصدار جديد من هذه السياسة أو من الشروط والأحكام أو من سياسة الخصوصية، طُلبت موافقتك من جديد قبل أول شراء سريع بعده. والطلب المفتوح قبل الإصدار الجديد يُرسَل على الموافقة التي فُتح بها.

### 2.4 الإيقاف وتغيير العنوان
يمكنك إيقاف الشراء السريع أو تغيير عنوانه من إعدادات حسابك في أي وقت. وتغيير العنوان يسري على الطلبات الجديدة فقط.

## 3. طلب الشراء السريع ومدته

### 3.1 ثلاثون دقيقة من أول شراء
أول شراء سريع يفتح طلباً مدته ثلاثون دقيقة تُحسب على الخادم من لحظة ذلك الشراء، وتستمر حتى لو أغلقت التطبيق أو المتصفح.

### 3.2 طلب واحد
كل شراء سريع خلال هذه المدة يُضاف إلى الطلب نفسه، ولا يكون لك أكثر من طلب شراء سريع مفتوح واحد.

### 3.3 المدة لا تُمدَّد
إضافة منتج أو تعديل كمية لا يعيد العدّاد ولا يمدّده.

### 3.4 التعديل قبل انتهاء المدة
يمكنك قبل انتهاء المدة زيادة الكمية أو تقليلها أو حذف منتج أو إلغاء الطلب كله. وبعد انتهاء المدة لا يُقبل أي تعديل.

### 3.5 الإرسال عند انتهاء المدة
عند انتهاء المدة يُرسَل الطلب تلقائياً إلى متجر Levonis كطلب عادي، ويظهر في «طلباتي» ويصلك إشعار بذلك.

## 4. الدفع والمحفظة

### 4.1 الدفع من محفظة Levo فقط
الشراء السريع يُدفع بالكامل من رصيد محفظة Levo، ولا يُقبل فيه الدفع عند الاستلام ولا الأقساط ولا النقاط ولا الكوبونات.

### 4.2 الحجز لحظة الشراء
عند كل شراء سريع يتحقق الخادم من رصيدك المتاح، ويحجز مجموع الطلب كاملاً. والمبلغ المحجوز لا يمكن صرفه في غيره ما دام محجوزاً.

### 4.3 الخصم عند الإرسال
عند انتهاء المدة يُخصم من المبلغ المحجوز ما يساوي مجموع الطلب النهائي، ويُعاد الباقي إلى رصيدك المتاح إن وُجد.

### 4.4 التحرير عند التعديل أو الإلغاء
تقليل الكمية أو حذف منتج يحرّر فوراً ما يقابله من المبلغ المحجوز، وإلغاء الطلب يحرّر المبلغ المحجوز كله.

### 4.5 الرصيد غير الكافي
إذا لم يكفِ رصيدك المتاح لم يُنشأ الطلب ولم يُحجز شيء، ويظهر لك الرصيد المتاح والمبلغ المطلوب.

### 4.6 لا يزيد المخصوم على المحجوز
لا يُخصم منك عند الإرسال أكثر من المبلغ الذي حُجز لطلبك.

## 5. الأسعار والكميات والتوصيل

### 5.1 السعر لحظة الإضافة
يُثبَّت سعر كل منتج كما كان لحظة إضافته. وإن انخفض السعر قبل الإرسال احتُسب السعر الأقل.

### 5.2 حجز الكمية
تُحجز الكمية التي اشتريتها من المخزون لطلبك طوال المدة، وتُخصم من المخزون عند تأكيد الطلب كأي طلب آخر.

### 5.3 التوصيل العادي
يُرسَل طلب الشراء السريع بالتوصيل العادي. ولاختيار طريقة توصيل أخرى استعمل السلة وشاشة الدفع.

### 5.4 التوصيل العادي المجاني
إذا انطبقت على طلبك قاعدة «توصيل عادي مجاني — للدفع الكامل من محفظة Levo» المعلنة في المتجر، طُبّقت تلقائياً.

### 5.5 العنوان المثبّت
يُثبَّت عنوان الشراء السريع على الطلب لحظة فتحه، ويُسلَّم الطلب إليه.

## 6. ما لا يشمله الشراء السريع

### 6.1 البيع المباشر فقط
الشراء السريع متاح للمنتجات المعروضة للبيع المباشر. أما الطلب المسبق والعروض المجمّعة والصناديق المفاجئة فتُطلب عبر السلة.

### 6.2 اكتمال الاختيار
لا يتم الشراء السريع قبل اختيار الخيار واللون والكمية المطلوبة للمنتج.

## 7. بعد الإرسال

### 7.1 طلب عادي
بعد الإرسال يُعامل طلب الشراء السريع معاملة أي طلب في متجر Levonis، وتسري عليه سياسات الشراء والتوصيل والإرجاع والضمان.`,
    en: `## 1. Introduction and definitions

### 1.1 Purpose of this document
This document explains how Quick Buy works at the Levonis store: how it is switched on, how money is held in the Levo Wallet and then charged, how quantities are reserved, and what happens when the order window ends.

### 1.2 Definitions
- Quick Buy: buying a product directly from its page, without the cart and checkout screens, paid from the Levo Wallet.
- Quick Buy order: one order that gathers everything you buy with Quick Buy within thirty minutes of the first purchase.
- Hold: an amount taken out of your available balance and kept reserved for the Quick Buy order, without being charged.
- Charge: turning the held amount into the final payment for the order.
- Quick Buy address: the default address you choose when you switch Quick Buy on.

### 1.3 Authoritative text
The Arabic text is authoritative; the English and Kurdish versions are faithful translations with the same numbering.

## 2. Activation and consent

### 2.1 Two steps to switch on
Quick Buy works only after it is switched on: first, agreeing to this policy, the Terms and Conditions, the Privacy Policy and the automatic hold and charge from the wallet; second, choosing and confirming the Quick Buy address.

### 2.2 Consent is recorded
Your consent is recorded with its time and the version number of every document you agreed to. No consent box is ever pre-ticked.

### 2.3 Documents that change
When a new version of this policy, the Terms and Conditions or the Privacy Policy is published, your consent is asked for again before the next Quick Buy. An order opened before the new version is submitted under the consent it was opened with.

### 2.4 Switching off and changing the address
You can switch Quick Buy off or change its address from your account settings at any time. A new address applies to new orders only.

## 3. The Quick Buy order and its window

### 3.1 Thirty minutes from the first purchase
The first Quick Buy opens an order with a thirty-minute window, counted on the server from that purchase, and it keeps running even if you close the app or the browser.

### 3.2 One order
Every Quick Buy within the window is added to the same order, and you never have more than one open Quick Buy order.

### 3.3 The window is not extended
Adding a product or changing a quantity does not reset or extend the timer.

### 3.4 Changes before the window ends
Before the window ends you may increase or reduce a quantity, remove a product or cancel the whole order. After it ends no change is accepted.

### 3.5 Submission when the window ends
When the window ends the order is submitted to the Levonis store automatically as an ordinary order; it appears under My orders and you are notified.

## 4. Payment and the wallet

### 4.1 Levo Wallet only
Quick Buy is paid in full from your Levo Wallet balance. Cash on delivery, instalments, points and coupons are not accepted.

### 4.2 The hold at purchase
At every Quick Buy the server checks your available balance and holds the full order total. Held money cannot be spent on anything else while it is held.

### 4.3 The charge at submission
When the window ends, the final order total is charged from the held amount and any remainder returns to your available balance.

### 4.4 Release on change or cancellation
Reducing a quantity or removing a product releases the matching part of the hold at once; cancelling the order releases the whole hold.

### 4.5 Insufficient balance
If your available balance is not enough, no order is created and nothing is held; you are shown your available balance and the amount required.

### 4.6 Never more than the hold
At submission you are never charged more than the amount held for your order.

## 5. Prices, quantities and delivery

### 5.1 The price when added
Each product's price is fixed as it was when you added it. If the price falls before submission, the lower price is charged.

### 5.2 Reserved quantity
The quantity you bought is reserved for your order for the whole window and is deducted from stock when the order is confirmed, like any other order.

### 5.3 Standard delivery
A Quick Buy order ships by standard delivery. To choose another delivery method, use the cart and checkout.

### 5.4 Free standard delivery
If the store's published rule "Free standard delivery — paid in full from Levo Wallet" applies to your order, it is applied automatically.

### 5.5 The fixed address
The Quick Buy address is fixed on the order when the order opens, and the order is delivered there.

## 6. What Quick Buy does not cover

### 6.1 Direct sale only
Quick Buy is available for products offered for direct sale. Pre-orders, bundles and mystery boxes are ordered through the cart.

### 6.2 A complete selection
A Quick Buy is not made before the product's option, colour and quantity are chosen.

## 7. After submission

### 7.1 An ordinary order
Once submitted, a Quick Buy order is treated like any other Levonis order, and the purchase, delivery, returns and warranty policies apply to it.`,
    ckb: `## 1. پێشەکی و پێناسەکان

### 1.1 مەبەستی ئەم بەڵگەنامەیە
ئەم بەڵگەنامەیە ڕوون دەکاتەوە خزمەتگوزاری «کڕینی خێرا» لە فرۆشگای Levonis چۆن کار دەکات: چۆن چالاک دەکرێت، چۆن پارە لە جزدانی Levo دەگیرێت و پاشان دەبڕدرێت، چۆن بڕەکان دەگیرێن، و کاتێک ماوەی داواکارییەکە کۆتایی دێت چی ڕوودەدات.

### 1.2 پێناسەکان
- کڕینی خێرا: کڕینی بەرهەمێک ڕاستەوخۆ لە پەڕەکەیەوە، بەبێ سەبەتە و شاشەی پارەدان، بە پارەدان لە جزدانی Levo.
- داواکاری کڕینی خێرا: یەک داواکاری کە هەموو ئەوەی بە کڕینی خێرا دەیکڕیت لە ماوەی سی خولەک لە یەکەم کڕینەوە کۆدەکاتەوە.
- گرتن: بڕە پارەیەک کە لە باڵانسی بەردەستت دەردەهێنرێت و بۆ داواکاری کڕینی خێرا گیراو دەمێنێتەوە، بەبێ ئەوەی بە یەکجاری ببڕدرێت.
- بڕین: گۆڕینی بڕە پارەی گیراو بۆ پارەدانی کۆتایی داواکارییەکە.
- ناونیشانی کڕینی خێرا: ئەو ناونیشانە بنەڕەتییەی لە کاتی چالاککردندا هەڵیدەبژێریت.

### 1.3 دەقی پشتپێبەستراو
دەقی عەرەبی پشتپێبەستراوە، و وەشانە ئینگلیزی و کوردییەکان وەرگێڕانی دڵسۆزن بە هەمان ژمارەکردن.

## 2. چالاککردن و ڕەزامەندی

### 2.1 چالاککردن بە دوو هەنگاو
کڕینی خێرا تەنها دوای چالاککردن کار دەکات: یەکەم، ڕەزامەندی لەسەر ئەم سیاسەتە و مەرج و ڕێساکان و سیاسەتی تایبەتمەندێتی و گرتن و بڕینی خۆکاری پارە لە جزدان؛ دووەم، هەڵبژاردن و دڵنیاکردنەوەی ناونیشانی کڕینی خێرا.

### 2.2 ڕەزامەندی تۆمار دەکرێت
ڕەزامەندییەکەت لەگەڵ کاتەکەی و ژمارەی وەشانی هەر بەڵگەنامەیەک کە ڕەزامەندیت لەسەری داوە تۆمار دەکرێت. هیچ چوارگۆشەیەکی ڕەزامەندی پێشوەختە نیشانە نەکراوە.

### 2.3 گۆڕانی بەڵگەنامەکان
کاتێک وەشانێکی نوێی ئەم سیاسەتە یان مەرج و ڕێساکان یان سیاسەتی تایبەتمەندێتی بڵاودەکرێتەوە، پێش کڕینی خێرای داهاتوو دووبارە داوای ڕەزامەندیت لێدەکرێت. داواکارییەک کە پێش وەشانە نوێیەکە کراوەتەوە بە هەمان ئەو ڕەزامەندییەی پێی کراوەتەوە دەنێردرێت.

### 2.4 ڕاگرتن و گۆڕینی ناونیشان
دەتوانیت هەر کاتێک بێت کڕینی خێرا ڕابگریت یان ناونیشانەکەی لە ڕێکخستنەکانی هەژمارەکەتەوە بگۆڕیت. ناونیشانی نوێ تەنها بۆ داواکارییە نوێیەکان جێبەجێ دەبێت.

## 3. داواکاری کڕینی خێرا و ماوەکەی

### 3.1 سی خولەک لە یەکەم کڕینەوە
یەکەم کڕینی خێرا داواکارییەک بە ماوەی سی خولەک دەکاتەوە کە لەسەر ڕاژەکار لەو کڕینەوە دەژمێردرێت، و بەردەوام دەبێت تەنانەت ئەگەر ئەپەکە یان وێبگەڕەکە دابخەیت.

### 3.2 یەک داواکاری
هەر کڕینێکی خێرا لە ماوەکەدا بۆ هەمان داواکاری زیاد دەکرێت، و هەرگیز زیاتر لە یەک داواکاری کڕینی خێرای کراوەت نابێت.

### 3.3 ماوەکە درێژ ناکرێتەوە
زیادکردنی بەرهەمێک یان گۆڕینی بڕێک کاتژمێرەکە سفر ناکاتەوە و درێژی ناکاتەوە.

### 3.4 گۆڕانکاری پێش کۆتایی ماوەکە
پێش کۆتایی ماوەکە دەتوانیت بڕێک زیاد یان کەم بکەیت، بەرهەمێک لابەریت یان هەموو داواکارییەکە هەڵبوەشێنیتەوە. دوای کۆتایی ماوەکە هیچ گۆڕانکارییەک وەرناگیرێت.

### 3.5 ناردن لە کۆتایی ماوەکەدا
کاتێک ماوەکە کۆتایی دێت، داواکارییەکە بە خۆکاری وەک داواکارییەکی ئاسایی بۆ فرۆشگای Levonis دەنێردرێت؛ لە «داواکارییەکانم» دەردەکەوێت و ئاگادار دەکرێیتەوە.

## 4. پارەدان و جزدان

### 4.1 تەنها جزدانی Levo
کڕینی خێرا بە تەواوی لە باڵانسی جزدانی Levo دەدرێت. پارەدان لە کاتی وەرگرتن، قیست، خاڵ و کۆپۆن وەرناگیرێن.

### 4.2 گرتن لە کاتی کڕیندا
لە هەر کڕینێکی خێرادا ڕاژەکار باڵانسی بەردەستت دەپشکنێت و کۆی گشتی داواکارییەکە بە تەواوی دەگرێت. پارەی گیراو تا کاتێک گیراوە لە هیچ شتێکی تر خەرج ناکرێت.

### 4.3 بڕین لە کاتی ناردندا
کاتێک ماوەکە کۆتایی دێت، کۆی گشتی کۆتایی داواکارییەکە لە بڕە پارەی گیراو دەبڕدرێت و هەر پاشماوەیەک بۆ باڵانسی بەردەستت دەگەڕێتەوە.

### 4.4 ئازادکردن لە کاتی گۆڕانکاری یان هەڵوەشاندنەوەدا
کەمکردنەوەی بڕێک یان لابردنی بەرهەمێک یەکسەر بەشی هاوتای پارەی گیراو ئازاد دەکات؛ هەڵوەشاندنەوەی داواکارییەکە هەموو پارەی گیراو ئازاد دەکات.

### 4.5 باڵانسی ناتەواو
ئەگەر باڵانسی بەردەستت بەس نەبێت، هیچ داواکارییەک دروست ناکرێت و هیچ شتێک ناگیرێت؛ باڵانسی بەردەست و بڕی پێویستت پیشان دەدرێت.

### 4.6 هەرگیز زیاتر لە پارەی گیراو نا
لە کاتی ناردندا هەرگیز زیاتر لەو بڕەی بۆ داواکارییەکەت گیراوە لێت نابڕدرێت.

## 5. نرخ، بڕ و گەیاندن

### 5.1 نرخ لە کاتی زیادکردندا
نرخی هەر بەرهەمێک وەک ئەوەی لە کاتی زیادکردنیدا بوو جێگیر دەکرێت. ئەگەر نرخەکە پێش ناردن دابەزێت، نرخە کەمترەکە حیساب دەکرێت.

### 5.2 گرتنی بڕ
ئەو بڕەی کڕیوتە بە درێژایی ماوەکە بۆ داواکارییەکەت لە کۆگا دەگیرێت و لە کاتی دڵنیاکردنەوەی داواکارییەکەدا وەک هەر داواکارییەکی تر لە کۆگا کەم دەکرێتەوە.

### 5.3 گەیاندنی ئاسایی
داواکاری کڕینی خێرا بە گەیاندنی ئاسایی دەنێردرێت. بۆ هەڵبژاردنی ڕێگایەکی تری گەیاندن، سەبەتە و شاشەی پارەدان بەکاربهێنە.

### 5.4 گەیاندنی ئاسایی بەخۆڕایی
ئەگەر یاسای بڵاوکراوەی فرۆشگا «گەیاندنی ئاسایی بەخۆڕایی — بۆ پارەدانی تەواو لە جزدانی Levo» لەسەر داواکارییەکەت جێبەجێ بێت، بە خۆکاری جێبەجێ دەکرێت.

### 5.5 ناونیشانی جێگیر
ناونیشانی کڕینی خێرا لە کاتی کردنەوەی داواکارییەکەدا لەسەری جێگیر دەکرێت، و داواکارییەکە بۆ ئەوێ دەگەیەنرێت.

## 6. ئەوەی کڕینی خێرا نایگرێتەوە

### 6.1 تەنها فرۆشتنی ڕاستەوخۆ
کڕینی خێرا بۆ ئەو بەرهەمانە بەردەستە کە بۆ فرۆشتنی ڕاستەوخۆ پێشکەش کراون. داواکاری پێشوەخت، کۆمەڵە بەرهەم و سندوقی سەرسوڕهێنەر لە ڕێگەی سەبەتەوە داوا دەکرێن.

### 6.2 هەڵبژاردنی تەواو
کڕینی خێرا ناکرێت پێش ئەوەی هەڵبژاردە و ڕەنگ و بڕی بەرهەمەکە دیاری بکرێت.

## 7. دوای ناردن

### 7.1 داواکارییەکی ئاسایی
دوای ناردن، داواکاری کڕینی خێرا وەک هەر داواکارییەکی تری Levonis مامەڵەی لەگەڵ دەکرێت، و سیاسەتەکانی کڕین و گەیاندن و گەڕاندنەوە و گەرەنتی لەسەری جێبەجێ دەبن.`,
  },
};
