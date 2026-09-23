import type { PolicyDocument } from './types';

/**
 * THE PAID EXTENSION — and the one rule that makes it honest.
 *
 * IT IS SOLD BEFORE THE ORDER OR NOT AT ALL. That is the owner's rule, and the
 * code enforces it in the only place it can: a plan rides on a CART LINE
 * (worker/routes/cart.ts) and is frozen into order_items.warranty_snapshot at
 * checkout. There is no endpoint anywhere that attaches coverage to an order
 * that already exists, which is why article 6.2 can state the rule as a fact
 * about the system rather than as a promise about staff behaviour — and it
 * states the REASON in the document itself, because a customer refused in
 * month three deserves the argument, not just the ruling.
 *
 * WHAT THE CODE FIXES, AND THE ARTICLE THAT CARRIES IT:
 *  - PRINTERS ONLY (`refuseNonPrinterWarranty`, WARRANTY_NOT_PRINTER) — 6.5.
 *  - +12 OR +24 ONLY, one plan per duration, over a 12-month base, so the
 *    totals are 24 or 36 (`PRINTER_EXTENSION_MONTHS`, `planTotalMonths`) — 6.1.
 *  - THE FEE IS A PERCENTAGE OF THE REGULAR PRICE, never the member price:
 *    `planFee` takes the regular basis on purpose and tests pin it, so a PRO
 *    and a guest pay the same dinar. Article 6.3 says so, because a member who
 *    expects their discount to apply will otherwise read silence as a promise.
 *  - USED, REFURBISHED AND OPEN BOX CANNOT BUY IT (`warrantyExtendable` is
 *    false for every condition listing, WARRANTY_NOT_EXTENDABLE) — 6.5.
 *  - THE PROMISE IS FROZEN AT CHECKOUT: computeCoverage prefers the snapshot's
 *    total_months over the product's current policy, so editing the product
 *    later cannot shorten what was sold — 6.4 and 6.11.
 *
 * The document never calls this insurance, because it is not: it buys more of
 * the SAME cover in the Warranty document, with the same exclusions.
 *
 * VERSION 2 — WHY IT MOVED. Two corrections a customer could see on the
 * page; the archive keeps version 1 byte for byte.
 *   * THE NAME. The store is written «Levonis», in Latin script, in all three
 *     languages. 4 transliterated occurrences left the body here.
 *   * THE UNKNOWNS. 1 line in this document still state a
 *     fact the owner has not given, so ./render.ts WITHHOLDS them from the published
 *     text rather than show a customer a `{{TOKEN}}`. They are still authored
 *     below, and each one returns of its own accord the moment its value is
 *     written in and the version moves again.
 */
export const extended_warranty: PolicyDocument = {
  key: 'extended_warranty',
  version: 2,
  effective_at: '2026-01-01',
  title: {
    ar: 'تمديد الضمان المدفوع',
    en: 'Paid Warranty Extension',
    ckb: 'درێژکردنەوەی گەرەنتی بە پارە',
  },
  body: {
    ar: `## وثيقة تمديد الضمان — المادة 6

هذه الوثيقة تبيّن تمديد الضمان المدفوع الذي يبيعه Levonis على الطابعات، وشرط شرائه، وما يغيّره وما لا يغيّره. تُقرأ مع وثيقة الضمان، المادة 5، ولا تُقرأ وحدها. النص العربي هو النص المعتمد.

### 6.1 ما هو التمديد
- الطابعة المؤهلة تُباع بضمان أساسي مدته اثنا عشر شهرًا من تاريخ التسليم المسجل.
- يجوز للزبون شراء تمديد لهذا الضمان بمدة اثني عشر شهرًا إضافيًا فيصير المجموع أربعة وعشرين شهرًا، أو بأربعة وعشرين شهرًا إضافيًا فيصير المجموع ستة وثلاثين شهرًا.
- لا يوجد تمديد بغير هاتين المدتين، ولا يُباع أكثر من تمديد واحد لكل طابعة في الطلب الواحد.
- المجموع المشترى يُطبع في وصل ضمان الجهاز، وهو المرجع عند أي خلاف على المدة.

### 6.2 الشرط الأساسي: يُشترى قبل الطلب فقط
لا يُباع تمديد الضمان إلا قبل إتمام الطلب. يُختار من صفحة المنتج أو من السلة قبل إرسال الطلب، ولا يُضاف بعد ذلك بأي وسيلة: لا بعد الدفع، ولا بعد الشحن، ولا بعد التسليم، ولا بأثر رجعي على طلب سابق.

وسبب هذا الشرط مذكور هنا صراحةً حتى لا يُفهم على أنه تعسف: الضمان تغطية لخطر لم يقع بعد. أما التغطية التي تُشترى بعد ظهور العطل فليست تأمينًا، بل استرجاعٌ لثمن العطل بخطوات إضافية، يدفع ثمنها كل زبون اشترى تغطيته في وقتها. ولذلك لا يقبل نظام المتجر إضافة تمديد إلى طلب قائم أصلًا، وليس الأمر متروكًا لتقدير موظف.

- طلب التمديد بعد إتمام الطلب يُرفض ولو لم يكن الجهاز قد سُلّم بعد.
- طلب التمديد بعد ظهور عطل يُرفض في كل حال.
- من أراد التمديد بعد إتمام طلبه فسبيله إلغاء الطلب غير المدفوع وإنشاء طلب جديد يتضمن التمديد، وفق وثيقة الشراء ووفق توفر المنتج وسعره وقت الطلب الجديد.

### 6.3 السعر
- رسم التمديد نسبة مئوية من السعر الاعتيادي للطابعة، أو مبلغ ثابت حيث لا تُحدَّد نسبة للخطة.
- يُحسب الرسم على السعر الاعتيادي لا على سعر العضوية. عضوية PRO أو غيرها لا تخفض رسم التمديد ولا تلغيه: العضو والزائر يدفعان المبلغ نفسه عن التمديد نفسه.
- يظهر الرسم بالدينار قبل الإضافة إلى السلة وقبل الدفع، ويُحفظ مع الطلب.
- الرسم جزء من قيمة سطر الطلب ويخضع لما يخضع له من ضرائب أو رسوم توصيل تحددها جهات أخرى.

### 6.4 ما يغيّره التمديد وما لا يغيّره
- التمديد يمدد المدة فقط. التغطية هي التغطية نفسها المنصوص عليها في المادة 5، بحروفها، وبالاستثناءات نفسها.
- التمديد لا يحوّل قطعة استهلاكية أو قطعة تآكل إلى قطعة مشمولة. الفوّهة والسير ومنصة الطباعة وغشاء FEP وحوض الراتنج والمحامل والمراوح بعد عمرها التشغيلي تبقى خارج التغطية في الشهر الثلاثين كما هي خارجها في الشهر الأول.
- التمديد لا يغطي سوء الاستعمال ولا الحوادث ولا السقوط ولا السوائل ولا الجهد الكهربائي الخاطئ ولا التعديل غير المصرح به ولا قطع الطرف الثالث.
- التمديد لا يجعل الضمان استبدالًا للجهاز. يبقى الالتزام إصلاح القطعة المعيبة أو استبدالها وفق المادة 5.4.
- التمديد لا يعيد ساعة الضمان إلى الصفر ولا يبدأ مدة جديدة: المدة الإجمالية تبدأ من تاريخ التسليم المسجل نفسه.
- التمديد ليس بوليصة تأمين، ولا يغطي السرقة ولا الفقدان ولا الحريق ولا الكوارث ولا الضرر العارض.

### 6.5 من لا يُباع له التمديد
- المنتجات غير الطابعات: النظام يرفض التمديد عليها لأن التغطية الموسعة مقررة للطابعات وحدها.
- الأجهزة المستعملة والمجددة وOpen Box: لا يُباع عليها تمديد بأي حال. تحمل هذه الوحدات المدة المعلنة لها، شهرًا واحدًا أو اثني عشر شهرًا، لأن بيع سنتين إضافيتين على جهاز سبق أن أُصلح وعدٌ يصعب الوفاء به.
- الأجهزة التي لم تُشترَ من Levonis، وأجهزة التجار المستقلين داخل ليفو برو.

### 6.6 اختيار التمديد وتغييره قبل الطلب
- يُختار التمديد على مستوى سطر السلة الواحد، لا على الطلب كله. الطلب الذي يضم طابعتين يحتاج اختيارًا لكل واحدة منهما.
- يجوز تغيير التمديد أو إلغاؤه في السلة ما دام الطلب لم يُرسل، ويُعاد حساب الرسم.
- عند إرسال الطلب يُثبَّت الاختيار ورسمُه والمدة الإجمالية الموعودة في سجل الطلب، ولا يتغير بعدها بتعديل لاحق على صفحة المنتج أو على أسعاره.

### 6.7 متى يبدأ التمديد ومتى يثبت
- التغطية الممددة تبدأ من تاريخ التسليم المسجل للوحدة، لا من تاريخ شراء التمديد.
- لا تُنشأ التغطية ولا يصدر وصلها إلا عند تسليم الوحدة. الطلب الذي لم يُسلَّم لا يحمل تغطية ممددة ولو دُفع رسمه.
- المدة الإجمالية المسجلة على الطلب هي الملزمة للمتجر ولو عُدّلت خطط المنتج بعد ذلك.

### 6.8 إلغاء الطلب أو استرجاعه
- إلغاء الطلب قبل التسليم: يُرد رسم التمديد إلى محفظة الزبون مع باقي مبالغ الطلب، ولا تنشأ تغطية.
- إرجاع الطابعة وقبول الإرجاع بإرجاع المبلغ: تسقط التغطية الممددة مع سقوط البيع، لأن التغطية تتبع الوحدة، والوحدة عادت إلى المتجر. يدخل رسم التمديد في حساب المبلغ المسترجع لذلك السطر وفق المادة 4.8.
- إرجاع الطابعة وانتهاء الطلب بالإصلاح أو الاستبدال: تبقى التغطية الممددة قائمة على الوحدة أو على الوحدة البديلة، بتاريخ انتهائها الأصلي.
- لا يُشترى التمديد منفصلًا ولا يُباع ولا يُنقل إلى جهاز آخر ولا يُصرف نقدًا ولا يُحوَّل إلى رصيد بطلب من الزبون.

### 6.9 انتقال الجهاز إلى مالك آخر
التغطية الممددة مرتبطة بالوحدة لا بالشخص، وتنتقل مع الجهاز إذا بيع أو أُهدي، بشرط أن يفك المالك الأول ارتباط الجهاز بحسابه وأن يسجله المالك الجديد باسمه وفق المادة 5.19. الانتقال لا يبدأ مدة جديدة ولا يمدد المدة القائمة، ويكمل المالك الجديد ما تبقى منها فقط.

### 6.10 ما يثبت شراء التمديد
- سجل الطلب في نظام المتجر، وفيه اسم الخطة ورسمها والمدة الإجمالية الموعودة.
- وصل الضمان الصادر للوحدة، وفيه المدة الإجمالية وتاريخ الانتهاء.
- صفحة التحقق العلنية من الضمان برقم الوصل أو بالرقم التسلسلي.

لا يُحتج بأي وعد شفهي أو رسالة أو لقطة شاشة على خلاف ما تحمله هذه المستندات الثلاثة.

### 6.11 الخلاف على وجود التمديد
إذا ادعى الزبون أنه اشترى تمديدًا ولم يظهر في سجل الطلب، فالسجل هو المعتمد، لأنه دُوّن لحظة الشراء قبل وقوع أي عطل. ويبقى للزبون أن يقدم إثباتًا على أنه دفع رسمًا لم يُسجَّل، وعندها يُصحَّح السجل. أما ادعاء اتفاق لاحق على الطلب فلا يُقبل، لأن المادة 6.2 تمنع نشوءه أصلًا.

### 6.12 العطل بعد انتهاء المدة الممددة
انتهاء المدة الإجمالية، أربعة وعشرين أو ستة وثلاثين شهرًا، يُنهي التغطية نهائيًا. العطل الذي يظهر بعدها يُعامل إصلاحًا مدفوعًا وفق وثيقة خدمات ما بعد البيع، ولا يُقبل عليه تمديد جديد.

### 6.13 التعارض واللغة
- عند تعارض هذه الوثيقة مع وثيقة الضمان في مسألة التغطية، فوثيقة الضمان هي المرجع، وهذه الوثيقة لا تزيد على المدة شيئًا.
- عند اختلاف الترجمات يُرجع إلى النص العربي.
- يسري تعديل هذه الوثيقة على التمديدات المشتراة بعد تاريخ نفاذه، ولا يمس تمديدًا اشتُري قبله.
- قناة التواصل المعتمدة: {{LEVONIS_SUPPORT_CONTACT}}.`,

    en: `## Warranty Extension Document — Article 6

This document sets out the paid warranty extension Levonis sells on printers, the condition for buying it, and what it does and does not change. It is read together with the Warranty document, Article 5, and never on its own. The Arabic text is the authoritative text.

### 6.1 What the extension is
- An eligible printer is sold with a base warranty of twelve months from the recorded delivery date.
- The customer may buy an extension of twelve further months, bringing the total to twenty-four months, or of twenty-four further months, bringing the total to thirty-six months.
- There is no extension of any other length, and no more than one extension is sold per printer on one order.
- The purchased total is printed on the warranty receipt of the device, and it is the reference in any dispute about the period.

### 6.2 The fundamental condition: it is bought before the order only
A warranty extension is sold only before the order is placed. It is chosen on the product page or in the cart before the order is sent, and is added by no means afterwards: not after payment, not after shipping, not after delivery, and not retroactively on an earlier order.

The reason for this condition is stated here plainly so that it is not read as arbitrary: a warranty is cover for a risk that has not yet materialised. Cover bought after a fault has appeared is not insurance; it is a refund of the cost of that fault with extra steps, paid for by every customer who bought their cover in time. That is why the store system does not accept adding an extension to an order that already exists, and the matter is not left to the discretion of a member of staff.

- A request for an extension after the order has been placed is refused even where the device has not yet been delivered.
- A request for an extension after a fault has appeared is refused in every case.
- Whoever wants an extension after placing an order may cancel the unpaid order and create a new one that includes the extension, under the Purchase document and subject to the availability and price of the product at the time of the new order.

### 6.3 The price
- The extension fee is a percentage of the regular price of the printer, or a fixed amount where the plan states no percentage.
- The fee is computed on the regular price, not on the member price. A PRO or any other membership neither reduces nor waives the extension fee: a member and a guest pay the same amount for the same extension.
- The fee is shown in dinars before the item is added to the cart and before payment, and is stored with the order.
- The fee is part of the value of the order line and is subject to whatever taxes or delivery charges other parties set on it.

### 6.4 What the extension changes and what it does not
- The extension extends the period only. The cover is the same cover set out in Article 5, word for word, with the same exclusions.
- The extension does not turn a consumable or a wear item into a covered part. The nozzle, the belt, the build plate, FEP film, the resin vat, bearings and fans past their operating life are outside cover in month thirty exactly as they are outside it in month one.
- The extension does not cover misuse, accidents, drops, liquids, incorrect voltage, unauthorised modification or third-party parts.
- The extension does not turn the warranty into a device replacement. The undertaking remains to repair or replace the faulty part under Article 5.4.
- The extension does not reset the warranty clock and does not start a new period: the total period runs from the same recorded delivery date.
- The extension is not an insurance policy, and covers neither theft, nor loss, nor fire, nor disaster, nor accidental damage.

### 6.5 Who cannot buy the extension
- Non-printer products: the system refuses an extension on them, because extended cover is provided for printers alone.
- Used, refurbished and Open Box devices: no extension is sold on them in any case. These units carry the period published for them, one month or twelve months, because selling two further years on a machine that has already been repaired is a promise that is hard to keep.
- Devices not bought from Levonis, and devices of independent merchants inside Levo Pro.

### 6.6 Choosing and changing the extension before the order
- The extension is chosen on a single cart line, not on the whole order. An order containing two printers requires a choice for each of them.
- The extension may be changed or removed in the cart for as long as the order has not been sent, and the fee is recomputed.
- When the order is sent, the choice, its fee and the promised total period are fixed in the order record, and do not change afterwards through any later edit of the product page or its prices.

### 6.7 When the extension starts and when it is established
- Extended cover starts from the recorded delivery date of the unit, not from the date the extension was bought.
- Cover is neither created nor issued with a receipt until the unit is delivered. An undelivered order carries no extended cover even where its fee has been paid.
- The total period recorded on the order binds the store even if the product plans are edited afterwards.

### 6.8 Cancelling or refunding the order
- Cancelling the order before delivery: the extension fee returns to the customer wallet with the rest of the order amounts, and no cover arises.
- Returning the printer and the return being resolved by a refund: extended cover falls with the sale, because cover follows the unit and the unit has returned to the store. The extension fee forms part of the refund calculation for that line under Article 4.8.
- Returning the printer where the case ends in repair or replacement: extended cover remains on the unit or on the replacement unit, with its original expiry date.
- The extension is not bought separately, is not sold on, is not transferred to another device, is not paid out in cash, and is not converted into credit at the request of the customer.

### 6.9 Transfer of the device to another owner
Extended cover attaches to the unit, not to the person, and transfers with the device if it is sold or given away, on condition that the first owner unlinks the device from their account and the new owner registers it in their own name under Article 5.19. The transfer starts no new period and extends no existing one; the new owner takes only what remains of it.

### 6.10 What establishes the purchase of an extension
- The order record in the store system, carrying the plan name, its fee and the promised total period.
- The warranty receipt issued for the unit, carrying the total period and the expiry date.
- The public warranty verification page, by receipt number or serial number.

No oral promise, message or screenshot may be relied upon against what these three records carry.

### 6.11 A dispute over whether an extension exists
Where a customer asserts that they bought an extension and it does not appear in the order record, the record governs, because it was written at the moment of purchase and before any fault occurred. The customer remains free to produce proof that they paid a fee that was not recorded, in which case the record is corrected. An assertion of a later agreement on the order is not accepted, because Article 6.2 prevents such an agreement from arising at all.

### 6.12 A failure after the extended period ends
The end of the total period, twenty-four or thirty-six months, ends cover for good. A failure appearing after it is treated as a paid repair under the After-Sale Services document, and no new extension is accepted on it.

### 6.13 Conflict and language
- Where this document conflicts with the Warranty document on a question of cover, the Warranty document governs; this document adds nothing beyond the period.
- Where translations differ, the Arabic text governs.
- An amendment to this document applies to extensions bought after its effective date and does not touch an extension bought before it.
- Approved contact channel: {{LEVONIS_SUPPORT_CONTACT}}.`,

    ckb: `## بەڵگەنامەی درێژکردنەوەی گەرەنتی — ماددەی 6

ئەم بەڵگەنامەیە ئەو درێژکردنەوە پارەدراوەی گەرەنتی ڕوون دەکاتەوە کە Levonis لەسەر پرینتەرەکان دەیفرۆشێت، مەرجی کڕینی، و ئەوەی دەیگۆڕێت و ئەوەی ناگۆڕێت. لەگەڵ بەڵگەنامەی گەرەنتی، ماددەی 5، دەخوێندرێتەوە و هەرگیز بە تەنها نا. دەقی عەرەبی دەقی پەسەندکراوە.

### 6.1 درێژکردنەوە چییە
- پرینتەری شایستە بە گەرەنتییەکی بنەڕەتی دوانزە مانگ لە بەرواری تۆمارکراوی گەیاندنەوە دەفرۆشرێت.
- کڕیار دەتوانێت درێژکردنەوەیەکی دوانزە مانگی زیاتر بکڕێت کە کۆکە دەبێتە بیست و چوار مانگ، یان بیست و چوار مانگی زیاتر کە کۆکە دەبێتە سی و شەش مانگ.
- هیچ درێژکردنەوەیەکی تر بەم دوو ماوەیە نییە، و لە یەک داواکاریدا زیاتر لە یەک درێژکردنەوە بۆ هەر پرینتەرێک نافرۆشرێت.
- کۆی کڕدراو لە پسوولەی گەرەنتی ئامێرەکەدا چاپ دەکرێت، و ئەوە سەرچاوەیە لە هەر ناکۆکییەک لەسەر ماوەکە.

### 6.2 مەرجی بنەڕەتی: تەنها پێش داواکاری دەکڕدرێت
درێژکردنەوەی گەرەنتی تەنها پێش تەواوکردنی داواکارییەکە دەفرۆشرێت. لە پەڕەی بەرهەم یان لە سەبەتەکە پێش ناردنی داواکارییەکە هەڵدەبژێردرێت، و دواتر بە هیچ ڕێگایەک زیاد ناکرێت: نە دوای پارەدان، نە دوای ناردن، نە دوای گەیاندن، نە بە شێوەی دواکەوتوو لەسەر داواکارییەکی پێشوو.

هۆکاری ئەم مەرجە بە ڕوونی لێرە هاتووە تاکو وەک زۆرداری لێک نەدرێتەوە: گەرەنتی داپۆشینی مەترسییەکە کە هێشتا ڕووی نەداوە. ئەو داپۆشینەی دوای دەرکەوتنی کەموکووڕی دەکڕدرێت دڵنیایی نییە، بەڵکو گەڕاندنەوەی نرخی ئەو کەموکووڕییەیە بە هەنگاوی زیاتر، کە هەموو ئەو کڕیارەی لە کاتی خۆیدا داپۆشینەکەی کڕیوە نرخەکەی دەدات. بۆیە سیستەمی فرۆشگا زیادکردنی درێژکردنەوە بۆ داواکارییەکی هەبوو وەرناگرێت، و بابەتەکە بە دەستی بڕیاری کارمەندێکەوە نییە.

- داواکاری درێژکردنەوە دوای تەواوکردنی داواکارییەکە ڕەت دەکرێتەوە تەنانەت ئەگەر ئامێرەکە هێشتا نەگەیەنرابێت.
- داواکاری درێژکردنەوە دوای دەرکەوتنی کەموکووڕی لە هەموو حاڵەتێکدا ڕەت دەکرێتەوە.
- ئەوەی دوای تەواوکردنی داواکارییەکەی درێژکردنەوەی دەوێت، دەتوانێت داواکارییە پارەنەدراوەکە هەڵبوەشێنێتەوە و داواکارییەکی نوێ دروست بکات کە درێژکردنەوەکەی تێدا بێت، بەپێی بەڵگەنامەی کڕین و بەپێی بەردەستبوون و نرخی بەرهەمەکە لە کاتی داواکارییە نوێیەکەدا.

### 6.3 نرخ
- کرێی درێژکردنەوە ڕێژەیەکی سەدییە لە نرخی ئاسایی پرینتەرەکە، یان بڕێکی جێگیر لەو حاڵەتانەی ڕێژە بۆ پلانەکە دیاری نەکراوە.
- کرێیەکە لەسەر نرخی ئاسایی دەژمێردرێت نەک لەسەر نرخی ئەندامێتی. ئەندامێتی PRO یان هیچ ئەندامێتییەکی تر کرێی درێژکردنەوە کەم ناکاتەوە و لای نابات: ئەندام و میوان هەمان بڕ بۆ هەمان درێژکردنەوە دەدەن.
- کرێیەکە بە دینار پیشان دەدرێت پێش زیادکردن بۆ سەبەتە و پێش پارەدان، و لەگەڵ داواکارییەکەدا هەڵدەگیرێت.
- کرێیەکە بەشێکە لە بەهای دێڕی داواکارییەکە و ملکەچی ئەو باج و کرێی گەیاندنەیە کە لایەنی تر دیاری دەکەن.

### 6.4 ئەوەی درێژکردنەوە دەیگۆڕێت و ئەوەی ناگۆڕێت
- درێژکردنەوە تەنها ماوەکە درێژ دەکاتەوە. داپۆشین هەمان ئەو داپۆشینەیە کە لە ماددەی 5 هاتووە، بە وشە، و بە هەمان جیاکراوەکان.
- درێژکردنەوە پارچەیەکی بەکارهاتوو یان داڕووخاو ناکات بە پارچەیەکی داپۆشراو. نۆزڵ و قایش و تەختەی چاپ و پەردەی FEP و حەوزی ڕەزین و بێرینگ و فانەکان دوای تەمەنی کارییان لە مانگی سییەمدا هەروەک لە مانگی یەکەمدا لە دەرەوەی داپۆشینن.
- درێژکردنەوە خراپ بەکارهێنان و ڕووداو و کەوتن و شلە و ڤۆڵتی هەڵە و دەستکاری بێ مۆڵەت و پارچەی لایەنی سێیەم ناگرێتەوە.
- درێژکردنەوە گەرەنتی ناکات بە گۆڕینەوەی ئامێرەکە. پابەندبوونەکە هەر چاککردن یان گۆڕینی پارچە کەموکووڕەکەیە بەپێی ماددەی 5.4.
- درێژکردنەوە کاتژمێری گەرەنتی ناگەڕێنێتەوە سفر و ماوەیەکی نوێ دەست پێناکات: کۆی ماوەکە لە هەمان بەرواری تۆمارکراوی گەیاندنەوە دەست پێدەکات.
- درێژکردنەوە پۆلیسەی دڵنیایی نییە، و نە دزین نە ونبوون نە ئاگرکەوتنەوە نە کارەسات نە زیانی ڕێکەوتی دادەپۆشێت.

### 6.5 کێ درێژکردنەوەی بۆ نافرۆشرێت
- بەرهەمە ناپرینتەرەکان: سیستەمەکە درێژکردنەوەیان لەسەر ڕەت دەکاتەوە، چونکە داپۆشینی فراوان تەنها بۆ پرینتەرەکان دیاری کراوە.
- ئامێرە بەکارهاتوو و چاککراوەوە و Open Box: بە هیچ شێوەیەک درێژکردنەوەیان لەسەر نافرۆشرێت. ئەم یەکانە ئەو ماوەیە هەڵدەگرن کە بۆیان ڕاگەیەنراوە، یەک مانگ یان دوانزە مانگ، چونکە فرۆشتنی دوو ساڵی زیاتر لەسەر ئامێرێک کە پێشتر چاککراوەتەوە بەڵێنێکە جێبەجێکردنی قورسە.
- ئەو ئامێرانەی لە Levonis نەکڕدراون، و ئامێرەکانی بازرگانە سەربەخۆکان لەناو لێڤۆ پرۆ.

### 6.6 هەڵبژاردن و گۆڕینی درێژکردنەوە پێش داواکاری
- درێژکردنەوە لەسەر ئاستی یەک دێڕی سەبەتە هەڵدەبژێردرێت، نەک لەسەر هەموو داواکارییەکە. ئەو داواکارییەی دوو پرینتەری تێدایە بۆ هەریەکەیان هەڵبژاردنێکی دەوێت.
- دەکرێت درێژکردنەوەکە لە سەبەتەدا بگۆڕدرێت یان لابردرێت هەتا داواکارییەکە نەنێردراوە، و کرێیەکە لە نوێوە دەژمێردرێت.
- لە کاتی ناردنی داواکارییەکەدا، هەڵبژاردنەکە و کرێیەکەی و کۆی ماوە بەڵێندراوەکە لە تۆماری داواکارییەکەدا جێگیر دەکرێن، و دواتر بە هیچ گۆڕانکارییەکی دواتری پەڕەی بەرهەم یان نرخەکانی ناگۆڕێن.

### 6.7 کەی درێژکردنەوە دەست پێدەکات و کەی جێگیر دەبێت
- داپۆشینی درێژکراوە لە بەرواری تۆمارکراوی گەیاندنی یەکەکەوە دەست پێدەکات، نەک لە بەرواری کڕینی درێژکردنەوەکە.
- داپۆشین نە دروست دەبێت و نە پسوولەکەی دەردەچێت تا یەکەکە نەگەیەنرێت. ئەو داواکارییەی نەگەیەنراوە هیچ داپۆشینێکی درێژکراوەی نییە تەنانەت ئەگەر کرێیەکەی درابێت.
- کۆی ئەو ماوەیەی لەسەر داواکارییەکە تۆمارکراوە فرۆشگا پابەند دەکات تەنانەت ئەگەر پلانەکانی بەرهەمەکە دواتر دەستکاری بکرێن.

### 6.8 هەڵوەشاندنەوە یان گەڕاندنەوەی داواکاری
- هەڵوەشاندنەوەی داواکارییەکە پێش گەیاندن: کرێی درێژکردنەوە لەگەڵ بڕەکانی تری داواکارییەکە دەگەڕێتەوە جزدانی کڕیار، و هیچ داپۆشینێک دروست نابێت.
- گەڕاندنەوەی پرینتەرەکە و کۆتاییهاتنی حاڵەتەکە بە گەڕاندنەوەی پارە: داپۆشینی درێژکراوە لەگەڵ فرۆشتنەکە دەڕووخێت، چونکە داپۆشین دوای یەکەکە دەکەوێت و یەکەکە گەڕاوەتەوە فرۆشگا. کرێی درێژکردنەوە دەچێتە ناو ژماردنی بڕە گەڕێنراوەکەی ئەو دێڕە بەپێی ماددەی 4.8.
- گەڕاندنەوەی پرینتەرەکە و کۆتاییهاتنی حاڵەتەکە بە چاککردن یان گۆڕینەوە: داپۆشینی درێژکراوە لەسەر یەکەکە یان لەسەر یەکە جێگرەوەکە دەمێنێتەوە، بە هەمان بەرواری کۆتایی سەرەکی.
- درێژکردنەوە بە جیا ناکڕدرێت، نافرۆشرێتەوە، بۆ ئامێرێکی تر ناگوازرێتەوە، بە نەقد نادرێتەوە، و بە داواکاری کڕیار ناگۆڕدرێت بۆ کرێدیت.

### 6.9 گواستنەوەی ئامێر بۆ خاوەنێکی تر
داپۆشینی درێژکراوە بە یەکەکەوە بەستراوە نەک بە کەسەکەوە، و لەگەڵ ئامێرەکەدا دەگوازرێتەوە ئەگەر بفرۆشرێت یان دیاری بکرێت، بەو مەرجەی خاوەنی یەکەم ئامێرەکە لە هەژمارەکەی خۆی بکاتەوە و خاوەنی نوێ بە ناوی خۆی تۆماری بکات بەپێی ماددەی 5.19. گواستنەوەکە هیچ ماوەیەکی نوێ دەست پێناکات و ماوەی هەبوو درێژ ناکاتەوە، و خاوەنی نوێ تەنها ئەوەی ماوەتەوە وەردەگرێت.

### 6.10 ئەوەی کڕینی درێژکردنەوە دەسەلمێنێت
- تۆماری داواکارییەکە لە سیستەمی فرۆشگا، کە ناوی پلانەکە و کرێیەکەی و کۆی ماوە بەڵێندراوەکەی هەڵگرتووە.
- پسوولەی گەرەنتی دەرچوو بۆ یەکەکە، کە کۆی ماوەکە و بەرواری کۆتاییهاتنی تێدایە.
- پەڕەی ئاشکرای پشتڕاستکردنەوەی گەرەنتی، بە ژمارەی پسوولە یان بە ژمارە زنجیرەیی.

هیچ بەڵێنێکی زارەکی یان نامە یان وێنەی شاشە لە دژی ئەوەی ئەم سێ تۆمارە هەڵیدەگرن پشتی پێ نابەسترێت.

### 6.11 ناکۆکی لەسەر بوونی درێژکردنەوە
ئەگەر کڕیار بڵێت درێژکردنەوەی کڕیوە و لە تۆماری داواکارییەکەدا دەرنەکەوت، تۆمارەکە بنەمایە، چونکە لە ساتی کڕیندا و پێش ڕوودانی هەر کەموکووڕییەک نووسراوە. کڕیار هەر ئازادە بەڵگە پێشکەش بکات کە کرێیەکی داوە و تۆمار نەکراوە، و لەو کاتەدا تۆمارەکە ڕاست دەکرێتەوە. بەڵام باسکردنی ڕێککەوتنێکی دواتر لەسەر داواکارییەکە وەرناگیرێت، چونکە ماددەی 6.2 لە بنەڕەتدا ڕێگە لە دروستبوونی دەگرێت.

### 6.12 تێکچوون دوای کۆتاییهاتنی ماوە درێژکراوەکە
کۆتاییهاتنی کۆی ماوەکە، بیست و چوار یان سی و شەش مانگ، داپۆشین بە تەواوی کۆتایی پێدەهێنێت. ئەو تێکچوونەی دوای دەردەکەوێت وەک چاککردنی پارەدراو بەپێی بەڵگەنامەی خزمەتگوزاری دوای فرۆشتن مامەڵەی لەگەڵ دەکرێت، و هیچ درێژکردنەوەیەکی نوێی لەسەر وەرناگیرێت.

### 6.13 ناکۆکی و زمان
- ئەگەر ئەم بەڵگەنامەیە لەگەڵ بەڵگەنامەی گەرەنتی لە بابەتی داپۆشیندا ناکۆک بوو، بەڵگەنامەی گەرەنتی سەرچاوەیە، و ئەم بەڵگەنامەیە هیچ لە سەرووی ماوەکەوە زیاد ناکات.
- لە کاتی جیاوازی وەرگێڕانەکاندا دەقی عەرەبی بنەمایە.
- گۆڕانکاری لەم بەڵگەنامەیەدا لەسەر ئەو درێژکردنەوانە جێبەجێ دەبێت کە دوای بەرواری کارپێکردنی کڕدراون، و دەستی بەو درێژکردنەوەیە ناگات کە پێشتر کڕدراوە.
- کەناڵی پەیوەندی پەسەندکراو: {{LEVONIS_SUPPORT_CONTACT}}.`,
  },
};
