import type { PolicyDocument } from './types';

/**
 * سياسة العضويات — WHAT A PAID TIER ACTUALLY BUYS, STATED SO IT CAN BE
 * ENFORCED IN AN ARGUMENT.
 *
 * THE BENEFIT LIST IS READ OFF entitlements.ts, NOT OFF THE MARKETING PAGE.
 * `ENTITLEMENT_MINIMUM_TIER` is the contract: a benefit is introduced once, at
 * the lowest tier that owns it, and higher tiers inherit it through TIER_RANK
 * (free < plus < prime < pro). Chapters 4, 5 and 6 are that table written in
 * sentences, in the same order, with nothing added. A benefit this document
 * names that the table does not grant would be a promise the checkout refuses
 * to keep, which is the one failure a policy corpus cannot survive.
 *
 * THE DATABASE SAYS `prime`, THE CUSTOMER READS PREMIUM. The id is historical
 * (see the comment on ENTITLEMENT_MINIMUM_TIER); every customer-facing surface
 * calls that tier PREMIUM, so this document does too, and article 2.4 says the
 * two names are the same thing — because an old invoice, an export or a
 * support screen may still show the old word and a customer is entitled to
 * know that it is not a different product.
 *
 * WHY CHAPTER 7 EXISTS AT ALL. `pricingTierContext` grants the PRO PURCHASE
 * benefits — PRO prices, the pre-order commission waiver, the direct-sale
 * premium waiver, the shipping waiver and priority — only at the single
 * approved default PRO address. That condition is invisible on a product card
 * and is the single most likely source of a "you promised me a price" dispute,
 * so it gets its own chapter rather than a parenthesis.
 *
 * NO PRICE IS WRITTEN INTO THIS DOCUMENT. Plan prices live in
 * `membership_plans.price_iqd`, are owner-set, and a NULL there means the plan
 * is not purchasable at all (PLAN_UNPRICED). A number frozen into legal text
 * would contradict the admin the first time the owner edited it, so article
 * 3.3 points at the page instead, and article 3.5 states the unpriced case.
 *
 * WHAT THE CODE DOES NOT HAVE, THIS DOCUMENT DOES NOT PROMISE:
 *  - there is NO automatic renewal and no stored payment instrument; the
 *    purchase is a one-off wallet debit, so chapter 9 says the membership
 *    simply ends;
 *  - there is NO self-service cancellation endpoint; only an audited admin
 *    action cancels a row, so chapter 10 is written as a request to Support;
 *  - a refund on cancellation is OPTIONAL in the route and is NOT prorated
 *    there, so article 10.5 states the recorded charge and refuses to invent
 *    a proration formula the code does not contain.
 *
 * CHAPTER 11 IS THE ONE THE OWNER WILL USE MOST. The codebase freezes the
 * membership's effect onto the order at checkout (`membership_tier_snapshot`,
 * the §19 benefits snapshot, the frozen reward multiplier that
 * `recomputeReversal` honours, `preorderGiftFor`'s snapshot). A lapse
 * therefore cannot reach backwards. Saying so in the document turns a
 * schema detail into a right the customer can rely on and the store can
 * point at.
 *
 * PLACEHOLDERS. Delivery thresholds are configurable settings
 * (`shippingPolicy.pro_threshold_iqd` / `prime_threshold_iqd`), so they are
 * written as the same placeholders the delivery document uses rather than as
 * two numbers that would drift apart between documents.
 *
 * VERSION 2 — WHY IT MOVED. Two corrections a customer could see on the
 * page; the archive keeps version 1 byte for byte.
 *   * THE NAME. The store is written «Levonis», in Latin script, in all three
 *     languages. 2 transliterated occurrences left the body here. Where the
 *     name carried an Arabic or Sorani affix the affix was detached rather than
 *     swallowed by the replacement, so the sentence still parses.
 *   * THE UNKNOWNS. 9 articles and 9 further lines in this document still state a
 *     fact the owner has not given, so ./render.ts WITHHOLDS them from the published
 *     text rather than show a customer a `{{TOKEN}}`. They are still authored
 *     below, and each one returns of its own accord the moment its value is
 *     written in and the version moves again.
 */
export const membership: PolicyDocument = {
  key: 'membership',
  version: 2,
  effective_at: '2026-01-01',
  title: {
    ar: 'سياسة العضويات',
    en: 'Memberships Policy',
    ckb: 'سیاسەتی ئەندامێتییەکان',
  },
  body: {
    ar: `## 1. التمهيد والنطاق والتعريفات

### 1.1 الغرض من هذه الوثيقة
تبيّن هذه الوثيقة فئات العضوية المدفوعة في منصة Levonis، وما تمنحه كل فئة على وجه التحديد، وكيف تُشترى وكيف تُرقّى، ومتى تبدأ ومتى تنتهي، وكيف تُلغى وما يُعاد عند الإلغاء، وما يبقى للزبون مما استحقه قبل انقضاء عضويته، وما يوقف مزاياه إذا أساء استعمالها.

### 1.2 الأطراف
المتجر: {{LEVONIS_LEGAL_NAME}}، المسجل برقم {{LEVONIS_REGISTRATION_NO}}، وعنوانه {{LEVONIS_ADDRESS}}. والعضو: صاحب الحساب الذي اشترى خطة عضوية أو مُنحت له.

### 1.3 التعريفات
- العضوية: علاقة مدة محددة بين المتجر وصاحب الحساب تمنحه مزايا معلنة مقابل بدل مدفوع مقدماً.
- الفئة: مستوى العضوية. والفئات المدفوعة ثلاث: LEVO PLUS و LEVO PREMIUM و LEVO PRO.
- الخطة: سجل قابل للشراء يجمع فئة ومدة بالأشهر وسعراً بالدينار العراقي.
- المدة: عدد الأشهر التقويمية التي تسري فيها العضوية.
- المزية: حق محدد تمنحه الفئة، مسجل باسمه في نظام المتجر.
- الوراثة: أن ترث الفئة الأعلى كل مزايا الفئات التي دونها.
- سجل العضوية: القيد الذي يحمل الفئة والمدة والمبلغ المدفوع وتاريخ الشراء وحالة العضوية.
- الحالة: وصف سجل العضوية في النظام، وهي: بانتظار الدفع، أو محجوزة مدفوعة بانتظار الإطلاق، أو فعّالة، أو منتهية، أو ملغاة.
- الإطلاق: القرار المعلن من المتجر ببدء تشغيل نظام العضويات، ولا يبدأ سريان العضوية المحجوزة قبله.
- العنوان الافتراضي المعتمد: العنوان الواحد الذي اعتمده المتجر لعضو PRO والمسجل في نظامه بحالة معتمد.
- سياق الشراء الخاص بـ PRO: اجتماع الشروط التي تجعل مزايا الشراء الخاصة بـ PRO نافذة على طلب بعينه.
- اللقطة: نسخة مجمدة من الحقائق التي بُني عليها طلب أو مكافأة، تُحفظ مع السجل ولا تُعاد حسابها بعد ذلك.
- حالة التقييد: قرار مسبب من المتجر يوقف مزية أو أكثر على حساب بعينه دون أن يمس الحساب نفسه.
- المحفظة: رصيد الزبون داخل المنصة وفق سياسة الدفع والمحفظة.

### 1.4 النص المعتمد
النص العربي هو النص المعتمد. والنسختان الإنكليزية والكردية ترجمتان أمينتان له بالترقيم نفسه مادةً بمادة، فالمادة 6.4 هي المادة 6.4 في اللغات الثلاث. وعند اختلاف التفسير يُرجع إلى النص العربي.

### 1.5 علاقة هذه الوثيقة بغيرها
تُقرأ هذه الوثيقة مع الشروط والأحكام العامة، وسياسة الشراء، وسياسة الدفع والمحفظة، وسياسة التوصيل، وسياسة حماية السعر، وسياسة مجتمع ليفو، وسياسة المكافآت والنقاط. وما يتصل بأجرة التوصيل يُقرأ في سياسة التوصيل، وما يتصل بالمحفظة والدفع المؤجل يُقرأ في سياسة الدفع، وما يتصل بمضاعف النقاط يُقرأ في سياسة المكافآت.

### 1.6 قاعدة الترجيح
إذا تعارضت هذه الوثيقة مع وثيقة أخرى في وصف مزية من مزايا العضوية، رجحت هذه الوثيقة. وإذا تعارضت مع وثيقة أخرى في إجراء من إجراءات التوصيل أو الدفع أو الضمان، رجحت الوثيقة المختصة بذلك الإجراء.

### 1.7 قبول الوثيقة
شراء خطة عضوية أو الانتفاع بمزية من مزاياها قبول بهذه الوثيقة بنسختها النافذة وقت الشراء.

### 1.8 النسخة وتاريخ النفاذ
لهذه الوثيقة رقم نسخة وتاريخ نفاذ مثبتان في أعلاها. ويُحفظ نص كل نسخة سبق أن قبلها زبون، فلا يُحتج على عضو بنص لم يكن قائماً وقت شرائه.

### 1.9 لا تنازل ضمني
سكوت المتجر عن مخالفة أو تسامحه في حالة بعينها لا يُعد تنازلاً عن حقه في هذه الوثيقة في غيرها.

## 2. الفئات الثلاث وترتيبها

### 2.1 الفئات المدفوعة
فئات العضوية المدفوعة ثلاث: LEVO PLUS، و LEVO PREMIUM، و LEVO PRO. ومن لا عضوية له فهو مستخدم اعتيادي، وله كل ما تمنحه المنصة للجمهور دون مزايا العضوية.

### 2.2 ترتيب الفئات
ترتيب الفئات من الأدنى إلى الأعلى: PLUS ثم PREMIUM ثم PRO.

### 2.3 الوراثة
تَرِث الفئة الأعلى كل مزايا ما دونها. فعضو PREMIUM يملك مزايا PLUS كاملة زائداً مزايا PREMIUM، وعضو PRO يملك مزايا PLUS و PREMIUM كاملة زائداً مزايا PRO.

### 2.4 اسم فئة PREMIUM
تُسمى الفئة الوسطى في كل الشاشات المعروضة للزبون باسم LEVO PREMIUM. وقد يظهر لها في سجلات قديمة أو في تصدير داخلي اسم PRIME، وهما اسمان لفئة واحدة لا لفئتين.

### 2.5 عضوية واحدة في الوقت الواحد
لا يحمل الحساب الواحد أكثر من عضوية قائمة في وقت واحد، سواء أكانت فعّالة أم محجوزة بانتظار الإطلاق. ومحاولة شراء عضوية ثانية مع قيام الأولى تُرفض على الخادم.

### 2.6 العضوية شخصية
العضوية شخصية لصاحب الحساب. ولا تُنقل ولا تُباع ولا تُعار ولا تُقسَّم، ولا يُنتفع بها لحساب شخص آخر ولو من أهل بيته.

### 2.7 المزية تُحسب على الخادم
تُحسب كل مزية على خادم المتجر وقت استعمالها من سجل العضوية نفسه. ولا يُعتد بما يرسله المتصفح أو التطبيق من فئة أو صفة أو علامة محفوظة في الجهاز.

## 3. الخطط وأسعارها ومدتها

### 3.1 ما الخطة
الخطة سجل قابل للشراء يجمع فئة ومدة بالأشهر وسعراً. وللفئة الواحدة أكثر من خطة تختلف مددها.

### 3.2 المدة بالأشهر التقويمية
تُحسب مدة العضوية بالأشهر التقويمية من لحظة بدئها. وإذا لم يكن لليوم المقابل وجود في الشهر المنتهي، انتهت العضوية في آخر يوم من ذلك الشهر.

### 3.3 السعر
سعر كل خطة هو الرقم المعروض في صفحة العضويات لحظة الشراء. ولا يُثبَّت في هذه الوثيقة سعر ولا يُستدل بها على سعر، لأن الأسعار يحددها المتجر في نظامه وتتغير بإعلانه.

### 3.4 السعر المعروض شامل لبدل العضوية وحده
بدل العضوية مقابل المزايا المبينة في هذه الوثيقة. وهو لا يشمل ثمن بضاعة، ولا أجرة توصيل، ولا رسم ضمان ممتد، ولا أي مبلغ آخر.

### 3.5 الخطة غير المسعّرة
الخطة التي لم يحدد لها المتجر سعراً ليست معروضة للبيع ولا تُشترى، ويرفض النظام شراءها برسالة صريحة. وظهورها في شاشة أو في قائمة لا ينشئ حقاً في شرائها بسعر مفترض.

### 3.6 تغيير الأسعار
للمتجر تعديل أسعار الخطط وإضافة خطط وإيقاف خطط. ولا يسري التعديل على عضوية قائمة اشتُريت قبله، ولا يُطالب عضوها بفرق، ولا يُقصّر مدته.

### 3.7 العملة والخصم من المحفظة
تُعرض أسعار الخطط بالدينار العراقي، ويُخصم بدل العضوية من رصيد المحفظة بالعملة التي يجري بها الخصم وفق سعر الصرف المعتمد في المنصة لحظة الشراء. وتفصيل المحفظة والأرصدة في سياسة الدفع والمحفظة.

### 3.8 تغيّر سعر الصرف بين العرض والتأكيد
إذا تغيّر سعر الصرف أو تغيّرت أرقام العرض بين لحظة عرض الملخص ولحظة التأكيد، رفض النظام إتمام الشراء وأعاد عرض الأرقام الجديدة لتؤكد من جديد. ولا يُخصم من الزبون مبلغ لم يره ولم يقره.

### 3.9 لا شراء خارج المنصة
لا تُباع العضوية ولا تُجدَّد ولا تُرقّى إلا من داخل المنصة وبخصم من المحفظة. وما يُدفع خارج المنصة لا يُنشئ عضوية ولا يُلزم المتجر بشيء.

## 4. ما تمنحه فئة LEVO PLUS

### 4.1 أساس هذا الفصل
ما يرد في هذا الفصل هو مجموع المزايا المسجلة لفئة PLUS في نظام المتجر. وما لم يرد فيه ولم يرد في الفصلين الخامس والسادس فليس من مزايا العضوية.

### 4.2 فتح متجر داخل مجتمع ليفو
تمنح PLUS صاحبها صفة التاجر داخل مجتمع ليفو: ملف تاجر، ومتجر داخل المنصة، وعرض منتجات، وإدارة طلبات متجره.

### 4.3 نطاق فرعي لمتجر التاجر
يُمنح متجر التاجر عنواناً فرعياً داخل المنصة يُعرف به.

### 4.4 لوحة إحصاءات التاجر
تُعرض للتاجر إحصاءات متجره ومنتجاته وطلباته.

### 4.5 تقديم العروض داخل المجتمع
يجوز لعضو PLUS أن يقدم عروضه على طلبات الأعضاء المنشورة في مجتمع ليفو وفق سياسة المجتمع.

### 4.6 الكوبونات والأقسام والعروض المخصصة للأعضاء
يُتاح لعضو PLUS ما يخصصه المتجر للأعضاء من كوبونات وأقسام معروضة وعروض، متى أعلنها المتجر وما دامت سارية.

### 4.7 حدود فئة PLUS
لا تمنح PLUS بذاتها سعراً خاصاً للعضو على البضاعة، ولا إعفاءً من أجرة التوصيل، ولا مضاعفاً للنقاط، ولا أولوية في الخدمة، ولا دفعاً مؤجلاً. وهذه مزايا الفئتين الأعلى وحدهما.

### 4.8 اشتراط الاشتراك الفعّال لصفة التاجر
صفة التاجر مرتبطة بعضوية فعّالة. فإذا انقضت العضوية توقفت مزايا التاجر وفق ما تبينه سياسة مجتمع ليفو، دون أن يُحذف ما سبق من سجلات المتجر أو طلباته.

## 5. ما تمنحه فئة LEVO PREMIUM

### 5.1 ما ترثه PREMIUM
تمنح PREMIUM كل ما تمنحه PLUS في الفصل الرابع، وتضيف إليه ما يأتي.

### 5.2 التسعير الخاص بأعضاء PREMIUM
يُطبَّق على العضو سعر العضوية المسجل للمنتج حيث يكون المتجر قد سجل سعراً خاصاً بالأعضاء لذلك المنتج. وحيث لا يكون قد سجله فالسعر هو السعر المعلن للجمهور.

### 5.3 إعفاء التوصيل فوق قيمة الطلب المعلنة
يتحمل المتجر عن عضو PREMIUM أجرة التوصيل الاعتيادية إذا تجاوزت قيمة بضاعة الطلب المحتسبة لهذا الغرض مبلغ {{PREMIUM_FREE_DELIVERY_MIN_IQD}} ديناراً عراقياً. والتجاوز شرط حقيقي: المبلغ المساوي للحد لا يكفي، بل يجب أن يزيد عليه.

### 5.4 حدود إعفاء PREMIUM
إعفاء PREMIUM يغطي أجرة التوصيل الاعتيادية وحدها. ولا يغطي رسوم الطابعات ولا رسوم الكراتين الإضافية ولا الرسوم الإضافية الأخرى، وتبقى هذه على الزبون. وتفصيل هذه الرسوم في سياسة التوصيل.

### 5.5 مضاعف النقاط
تُحتسب نقاط عضو PREMIUM بمعامل مقداره مرة ونصف مما يُحتسب للمستخدم الاعتيادي، في تسجيل الدخول اليومي، وفي المهام، وفي الشراء، وفي المراجعات. وتفصيل الاحتساب والتقريب في سياسة المكافآت والنقاط.

### 5.6 ضريبة الدفع عند الاستلام
الإعفاء من ضريبة التحصيل النقدي مزية مسجلة في النظام لفئة PREMIUM فما فوق، ولا تكون نافذة إلا إذا فعّلها المتجر بقاعدة معلنة. والقاعدة المعمول بها حالياً لا تُعفي عضو PREMIUM من هذه الضريبة، فتبقى مستحقة عليه ما لم يعلن المتجر خلاف ذلك.

### 5.7 حدود فئة PREMIUM
لا تمنح PREMIUM سعر PRO على البضاعة، ولا إعفاء عمولة النقل في الطلب المسبق، ولا الدفع المؤجل، ولا أولوية الخدمة، ولا خدمة الإنجاز خلال اثنتي عشرة ساعة، ولا شارة PRO.

## 6. ما تمنحه فئة LEVO PRO

### 6.1 ما ترثه PRO
تمنح PRO كل ما تمنحه PLUS و PREMIUM في الفصلين الرابع والخامس، وتضيف إليه ما يأتي. ومزايا PRO في الشراء مشروطة بالفصل السابع.

### 6.2 التسعير الخاص بأعضاء PRO
يُطبَّق على العضو سعر PRO المسجل للمنتج حيث يكون المتجر قد سجله. وحيث لا يكون قد سجله فالسعر هو السعر المعلن للجمهور، ولا يُستنتج سعر PRO من نسبة ولا من مقارنة.

### 6.3 إعفاء عمولة النقل في الطلب المسبق
لا تُحتسب على عضو PRO عمولة النقل المضافة إلى سطر الطلب المسبق. وهذا الإعفاء من مزايا الشراء المشروطة بالفصل السابع.

### 6.4 إعفاء التوصيل فوق قيمة الطلب المعلنة
يتحمل المتجر عن عضو PRO كلف التوصيل إذا تجاوزت قيمة بضاعة الطلب المحتسبة لهذا الغرض مبلغ {{PRO_FREE_DELIVERY_MIN_IQD}} ديناراً عراقياً. والتجاوز شرط حقيقي: المبلغ المساوي للحد لا يكفي، بل يجب أن يزيد عليه.

### 6.5 اتساع إعفاء PRO
إعفاء PRO أوسع من إعفاء PREMIUM: فهو يغطي كلف التوصيل المعروضة على الطلب لا الأجرة الاعتيادية وحدها، وفق ما تبينه سياسة التوصيل. وما تفرضه شركة التوصيل من ضريبة تحصيل نقدي عند الباب ليس أجرة توصيل ولا يشمله هذا الإعفاء.

### 6.6 أولوية الخدمة
تُمنح طلبات عضو PRO ومراجعاته ومطالباته أولوية في الدور على غيرها في حدود ما يتيحه تنظيم العمل، وتُستهدف مدة استجابة أولى مقدارها {{PRO_PRIORITY_RESPONSE_HOURS}} ساعة. والأولوية ترتيب في الدور وليست وعداً بنتيجة ولا بتغيير مضمون قرار.

### 6.7 خدمة الإنجاز خلال اثنتي عشرة ساعة
تُعرض لعضو PRO خدمة إنجاز الطلب خلال اثنتي عشرة ساعة من إنشائه. وهي خدمة مشروطة، ولا تكون نافذة على طلب بعينه إلا باجتماع ما يأتي كله: عضوية PRO فعّالة، وتسليم إلى العنوان الافتراضي المعتمد، وتشغيل المتجر للخدمة، وكون طريقة التوصيل المختارة من الطرق التي شملها المتجر بالخدمة، وكون نوع الشحن من الأنواع المشمولة، وكون محافظة العنوان من المحافظات المشمولة.

### 6.8 بيان سبب عدم انطباق خدمة الاثنتي عشرة ساعة
إذا تخلّف شرط من شروط المادة 6.7، لم تُطبَّق الخدمة على الطلب وبُيّن سبب ذلك في الطلب نفسه. ولا يُعد عدم انطباقها إخلالاً بالعضوية.

### 6.9 الدفع المؤجل
يُتاح لعضو PRO الدفع المؤجل وفق حدوده ومواعيده المبينة في سياسة الدفع والمحفظة. وهو تسهيل مشروط بتقدير المتجر لأهلية الحساب، وليس حقاً مطلقاً في كل طلب.

### 6.10 شارة PRO
يُمنح متجر عضو PRO داخل المجتمع شارة تدل على فئته. والشارة دلالة على العضوية وحدها، وليست توثيقاً لهوية ولا شهادة من المتجر على جودة بضاعة التاجر أو التزامه.

### 6.11 مضاعف النقاط
تُحتسب نقاط عضو PRO بضعف ما يُحتسب للمستخدم الاعتيادي، في تسجيل الدخول اليومي، وفي المهام، وفي الشراء، وفي المراجعات. وتفصيل الاحتساب والتقريب في سياسة المكافآت والنقاط.

### 6.12 الأقسام والعروض الخاصة بـ PRO
يُتاح لعضو PRO ما يخصصه المتجر لفئته من أقسام وعروض، متى أعلنها المتجر وما دامت سارية.

### 6.13 هدية الطلب المسبق المدفوع مقدماً
إذا شغّل المتجر هذه الهدية وحدد المنتج الذي تُصرف منه، استحق عضو PRO هدية عينية مع طلبه المسبق إذا كان الطلب مدفوعاً بالكامل قبل التسليم فلا يبقى شيء يُحصّل عند الباب، وكان الطلب مسعّراً في سياق الشراء الخاص بـ PRO وفق الفصل السابع. والهدية بضاعة تُشحن مع الطلب وقيمتها على الفاتورة صفر، فلا تُخصم من ثمن ولا تُبدَّل بمال ولا تُسترد نقداً.

### 6.14 الهدية المشروطة لا تُوعد بها خارج شرطها
إذا لم يشغّل المتجر الهدية أو لم يحدد منتجها، فلا استحقاق فيها. ولا يجوز لأحد من العاملين أو التجار أن يعد بها على أنها آلية أو مضمونة.

## 7. شرط العنوان الافتراضي المعتمد لمزايا الشراء في PRO

### 7.1 القاعدة
مزايا الشراء الخاصة بـ PRO — وهي سعر PRO على البضاعة، وإعفاء عمولة النقل في الطلب المسبق، وإعفاء علاوة البيع المباشر، وإعفاء كلف التوصيل، وأولوية التوصيل — لا تكون نافذة إلا على طلب يُسعَّر لعنوان واحد بعينه هو العنوان الافتراضي المعتمد لحساب العضو.

### 7.2 لماذا هذا الشرط
لأن مزايا PRO وُضعت لشخص واحد في مكان معلوم، لا لعنوان يتبدل في كل طلب. وربطها بعنوان واحد معتمد هو ما يمنع تحويلها إلى أداة شراء بالجملة لإعادة البيع تحت اسم عضو واحد.

### 7.3 كيف يُعرف العنوان المعتمد
العنوان المعتمد هو العنوان المسجل في نظام المتجر بحالة معتمد لحساب العضو. وتُطابق المطابقة على الاسم والعنوان ورقم الهاتف، مع تجاوز فروق المسافات وحالة الأحرف وصيغ كتابة الرقم وحدها.

### 7.4 التسعير خارج العنوان المعتمد
إذا كان الطلب مسعّراً لعنوان غير العنوان المعتمد، سُعِّر تسعيراً اعتيادياً بالكامل: بسعر الجمهور، وبعمولة النقل، وبعلاوة البيع المباشر، وبأجرة التوصيل، ودون أولوية توصيل.

### 7.5 ما يراه العضو قبل اختيار العنوان
في صفحة المنتج وفي السلة، قبل أن يختار العضو عنواناً، يُحكم على السعر بعنوانه الافتراضي. فمن كان عنوانه الافتراضي غير معتمد رأى السعر الاعتيادي في هذه الشاشات جميعاً، حتى لا يرى سعراً لا يُنفَّذ عند الباب.

### 7.6 اعتماد العنوان وتغييره
اعتماد العنوان ومراجعته وتغييره من اختصاص المتجر وفق إجراء إدارة عضوية PRO. ولا يُعتمد عنوان بمجرد إضافته إلى الحساب.

### 7.7 ما لا يسقط بهذا الشرط
لا يسقط بهذا الشرط ما ليس من مزايا الشراء: فمضاعف النقاط، وشارة PRO، وأولوية الخدمة، والدفع المؤجل، والأقسام والعروض الخاصة، تبقى قائمة بقيام العضوية أياً كان عنوان الطلب.

## 8. الشراء والترقية والدفع

### 8.1 من يشتري
لا تُشترى العضوية إلا من داخل حساب موثّق، وتُسجَّل باسم صاحب الحساب وحده.

### 8.2 الملخص قبل التأكيد
يُعرض على الزبون قبل التأكيد ملخص يبين الخطة وفئتها ومدتها وسعرها، وقيمة ما يُحتسب له من رصيد عضويته القائمة إن وُجد، والمبلغ المخصوم فعلاً، ورصيده المتاح، وتاريخ الانتهاء المتوقع أو كون العضوية ستُحجز حتى الإطلاق.

### 8.3 التأكيد هو ما يُلزم
لا يُخصم مبلغ ولا تُنشأ عضوية قبل تأكيد الزبون للملخص. وإذا اختلف المبلغ المعاد حسابه عند التأكيد عن المبلغ المعروض، رُفض الإتمام وأُعيد العرض بالأرقام الجديدة.

### 8.4 الخصم من المحفظة
يُخصم بدل العضوية من الرصيد المتاح في المحفظة. والرصيد المتاح هو المسوّى بعد استنزال المحجوز لعمليات أخرى، كما تبينه سياسة الدفع والمحفظة.

### 8.5 عدم كفاية الرصيد
إذا لم يكفِ الرصيد المتاح، رُفض الشراء ولم يُنشأ سجل عضوية ولم يُخصم شيء. ولا تُنشأ عضوية جزئية ولا عضوية بالدين.

### 8.6 النقر المزدوج والتكرار
لكل عملية شراء مفتاح لا يتكرر. فإذا أُرسل الطلب مرتين لسبب تقني، نُفِّذ خصم واحد وعضوية واحدة، وعُدّ الثاني تكراراً للأول لا شراءً جديداً.

### 8.7 شراء عضوية من الفئة نفسها
لا تُشترى عضوية من الفئة نفسها ما دامت الأولى قائمة. ويُعاد الشراء بعد انتهائها.

### 8.8 النزول إلى فئة أدنى
لا يُشترى نزولاً إلى فئة أدنى من الفئة القائمة. ولمن أراد ذلك أن ينتظر انتهاء عضويته ثم يشتري ما يشاء.

### 8.9 الترقية إلى فئة أعلى
تجوز الترقية من فئة أدنى إلى أعلى في أي وقت. وتُحتسب للعضو قيمة ما تبقى من عضويته القائمة خصماً من سعر الفئة الجديدة، وتُنهى العضوية القديمة في اللحظة نفسها، وتبدأ الجديدة بمدتها كاملة.

### 8.10 كيف يُحتسب رصيد الترقية
يُحتسب رصيد الترقية على أساس قيمة الخطة القائمة موزعة على أيام مدتها، مضروبة في الأيام المتبقية منها، ويُجبر الكسر لمصلحة الدقة إلى الأدنى. ولا يزيد الرصيد المحتسب على سعر الفئة الجديدة بحال، فالترقية لا تُنشئ ديناً للزبون على المتجر ولا تُعيد له نقداً.

### 8.11 ترقية عضوية محجوزة لم تبدأ
إذا كانت العضوية القائمة محجوزة مدفوعة ولم تبدأ مدتها بعد، احتُسبت قيمتها كاملة خصماً من سعر الفئة الجديدة، لأن شيئاً منها لم يُستهلك.

### 8.12 العضوية الممنوحة لا تُحتسب في الترقية
العضوية التي مُنحت للزبون دون بدل تُعامل في الترقية بقيمة صفر، فلا تُخصم من سعر الفئة الجديدة، لأن الترقية تُحتسب على ما دفعه الزبون لا على ما وهبه له المتجر.

## 9. البدء والمدة والانتهاء والتجديد

### 9.1 بدء العضوية بعد الإطلاق
بعد إعلان الإطلاق تبدأ العضوية من لحظة اكتمال الشراء، وينتهي أجلها بانقضاء مدتها محسوبة بالأشهر التقويمية.

### 9.2 العضوية المحجوزة قبل الإطلاق
من اشترى قبل إعلان الإطلاق حُجزت له عضويته بمدتها كاملة ولم تبدأ مدتها بعد. والحجز التزام من المتجر بالمدة كاملة، لا تنقص بطول الانتظار.

### 9.3 بدء المدة عند الإطلاق
تبدأ مدة العضوية المحجوزة بإعلان المتجر تفعيل الإطلاق، وهو قرار معلن ومسجل، لا يقع بمرور الوقت وحده.

### 9.4 انتهاء المدة
تنتهي العضوية بانقضاء مدتها من تلقاء نفسها، ويُسجَّل انتهاؤها في النظام. ولا يحتاج انتهاؤها إلى إشعار ولا إلى طلب.

### 9.5 لا تجديد تلقائي
لا تتجدد العضوية تلقائياً، ولا يحتفظ المتجر بوسيلة دفع يخصم منها بعد انتهاء المدة، ولا يُخصم من محفظة الزبون بدل تجديد لم يطلبه. ومن أراد الاستمرار اشترى خطة جديدة بنفسه.

### 9.6 الشراء بعد الانتهاء
يجوز الشراء من جديد بعد انتهاء العضوية، بالفئة نفسها أو بغيرها. وتُعد العضوية الجديدة عضوية مستقلة بمدتها وسعرها، ولا يُضاف ما مضى إلى ما يأتي.

### 9.7 أثر الانتهاء على المزايا
بانتهاء العضوية تتوقف المزايا كلها من تاريخ الانتهاء فصاعداً: يعود السعر إلى سعر الجمهور، وتعود أجرة التوصيل على الزبون، ويعود مضاعف النقاط إلى مقداره الاعتيادي، وتسقط الأولوية والشارة والدفع المؤجل الجديد.

### 9.8 ما لا يسقط بالانتهاء
لا يسقط بانتهاء العضوية ما استقر للزبون قبله، وتفصيل ذلك في الفصل الحادي عشر.

### 9.9 الإشعار بقرب الانتهاء
إذا أرسل المتجر إشعاراً بقرب انتهاء العضوية فهو تذكير من باب الخدمة. وعدم وصوله لا يمدد المدة ولا ينشئ حقاً في تمديدها.

## 10. الإلغاء والاسترداد

### 10.1 الإلغاء ليس زراً في الحساب
لا يوجد في المنصة إلغاء ذاتي للعضوية. ومن أراد إلغاء عضويته قدّم طلباً إلى الدعم عبر {{LEVONIS_SUPPORT_CONTACT}}، ويُنظر في طلبه وفق هذا الفصل.

### 10.2 من يملك الإلغاء
لا تُلغى العضوية إلا بقرار مسجل من إدارة المتجر، يُحفظ فيه من أصدره ومتى وسببه.

### 10.3 ما يجوز إلغاؤه
يجوز إلغاء العضوية الفعّالة، والعضوية المحجوزة التي لم تبدأ، والعضوية التي لم يكتمل دفعها. ولا تُلغى عضوية انتهت مدتها، لأنها انقضت بذاتها.

### 10.4 أثر الإلغاء
بالإلغاء تتوقف المزايا من تاريخه فصاعداً، وتُسجَّل العضوية ملغاة. ويصير الحساب بعدها خالياً من عضوية قائمة، فيجوز له الشراء من جديد.

### 10.5 الاسترداد
الاسترداد قرار مستقل عن الإلغاء وليس أثراً حتمياً له. وإذا قرر المتجر الاسترداد أُعيد المبلغ المقيَّد على العضوية إلى محفظة الزبون بالعملة التي خُصم بها، ولا يُعاد مرتين ولو تكرر تنفيذ الإلغاء. وإذا اتُفق على إعادة جزء منه لقاء المدة المستهلكة، أُثبت ذلك كتابةً في قرار الإلغاء نفسه وسُجِّل به.

### 10.6 وجهة الاسترداد
وجهة الاسترداد محفظة الزبون داخل المنصة. ولا يُعاد بدل العضوية نقداً عند الباب ولا إلى وسيلة دفع خارجية، ويُتصرف بالرصيد بعد ذلك وفق سياسة الدفع والمحفظة.

### 10.7 الإلغاء بسبب المخالفة
إذا كان الإلغاء بسبب مخالفة من العضو لهذه الوثيقة أو للشروط العامة، جاز للمتجر ألا يسترد شيئاً، ويُبيَّن السبب في قرار الإلغاء.

### 10.8 أثر الإلغاء على مكافأة إحالة نشأت عن الاشتراك
إذا كان اشتراك PRO قد أنشأ مكافأة إحالة لصالح من دعا العضو، أُلغيت تلك المكافأة بإلغاء الاشتراك، لأن سببها هو الدفع الذي زال.

### 10.9 ما لا يُسترد
لا يُسترد بدل العضوية عن مدة انتفع بها العضو فعلاً، ولا تُعوَّض مزية لم يستعملها، ولا يُحوَّل بدل العضوية إلى ثمن بضاعة أو إلى نقاط.

## 11. أثر انقضاء العضوية على ما استحقه العضو قبله

### 11.1 القاعدة
ما ثبت للعضو من مزية على طلب مدفوع أو على مكافأة مستحقة قبل انقضاء عضويته أو إلغائها لا يُسحب منه بعد ذلك. والانقضاء يعمل للمستقبل لا للماضي.

### 11.2 لقطة العضوية على الطلب
يُحفظ مع كل طلب سجل مجمّد لفئة العضوية وحالتها وقت إتمام الطلب، ولما أثّرت به في السعر والتوصيل والضريبة. وهذا السجل هو المرجع في كل مراجعة لاحقة على الطلب.

### 11.3 السعر المدفوع
السعر الذي دُفع بمزية العضوية سعر نهائي. ولا يُطالب الزبون بفرق بعد انقضاء عضويته، ولو نُفِّذ الطلب أو سُلِّم بعد الانقضاء.

### 11.4 إعفاء التوصيل المستحق
إعفاء التوصيل الذي ثبت على طلب مؤكد لا يُنقض بانقضاء العضوية بعد تأكيده، ولا تُطالب شركة التوصيل الزبون بأجرة تحمّلها المتجر.

### 11.5 النقاط التي مُنحت بالمضاعف
النقاط التي احتُسبت بمضاعف العضوية تبقى للزبون بمقدارها المحتسب. وإذا أُرجع جزء من الطلب بعد انقضاء العضوية، أُعيد حساب النقاط بالمضاعف المثبت على الطلب وقت الشراء لا بمضاعف اليوم، فلا يُسحب من الزبون أكثر مما استحق.

### 11.6 الهدايا والمكافآت المستقرة
الهدية التي ثبتت على طلب مدفوع، والمكافأة التي بلغت مرحلة الحجز أو التسليم، لا تُسحب بانقضاء العضوية. وما كان منها لم يبلغ مرحلة الاستحقاق فيخضع لشرطه.

### 11.7 الضمان وما بعد البيع
لا علاقة للعضوية بالضمان. فمدة الضمان ومداه يبقيان كما كانا يوم الشراء، وانقضاء العضوية لا يقصّرهما ولا يسقط مطالبة قائمة. وما يسقط هو أولوية الدور وحدها.

### 11.8 الدفع المؤجل القائم
إذا كان على العضو مبلغ مؤجل، بقي سداده واجباً بعد انقضاء العضوية أو إلغائها، وبقيت وسيلة السداد متاحة له، لأن الالتزام نشأ قبل الانقضاء.

## 12. العضوية الممنوحة والهدايا المشروطة

### 12.1 عضوية PLUS الممنوحة مع شراء طابعة
إذا شغّل المتجر هذه الميزة وحدد خطة PLUS التي تُمنح، مُنح من اشترى طابعة مؤهلة عضوية PLUS دون بدل.

### 12.2 شرط ألا تكون للحساب عضوية قائمة
لا تُمنح العضوية الممنوحة لحساب يحمل عضوية قائمة فعّالة كانت أو محجوزة، لأن الحساب لا يحمل أكثر من عضوية واحدة. ويُسجَّل الامتناع في سجل المتجر ليُنظر فيه يدوياً عند الاقتضاء.

### 12.3 قيمة العضوية الممنوحة في الترقية
العضوية الممنوحة قيمتها صفر في احتساب رصيد الترقية، وفق المادة 8.12.

### 12.4 الهدايا المشروطة عموماً
كل هدية أو مزية إضافية معلقة على تشغيل المتجر لها وعلى تحديد ما تُصرف منه لا تُستحق قبل اجتماع شرطها. وظهور ذكرها في صفحة أو في إعلان قديم لا ينشئ استحقاقاً.

### 12.5 الهدية بضاعة لا مال
الهدية تُصرف بضاعةً بقيمة صفر على الفاتورة. ولا تُبدَّل بمال ولا بنقاط ولا بخصم، ولا تُرد نقداً عند الإرجاع.

### 12.6 نفاد المخزون
إذا نفد ما تُصرف منه الهدية، أُعلم الزبون وبقي استحقاقه محفوظاً حتى يتوفر أو حتى يُتفق على بديل. ولا يتحول إلى مال بحال.

## 13. إساءة الاستعمال وتقييد المزايا

### 13.1 الغرض من هذا الفصل
وُضعت مزايا العضوية لاستعمال شخصي معقول. وهذا الفصل يبين ما يُعد إساءة وما يترتب عليها.

### 13.2 صور إساءة الاستعمال
- استعمال مزايا العضوية لشراء بقصد إعادة البيع أو للتوريد إلى الغير.
- تمكين غير صاحب الحساب من مزايا عضويته.
- فتح حسابات متعددة للشخص الواحد لتكرار مزية أو تجاوز حد.
- تكرار رفض الاستلام أو تكرار الإلغاء على نحو يحمّل المتجر كلفاً بلا مقابل.
- تقديم بيانات غير صحيحة لاعتماد عنوان أو لنيل مزية.
- استعمال العضوية في نشاط ممنوع في الشروط العامة.

### 13.3 تقييد المزايا
للمتجر أن يوقف مزية أو أكثر على حساب بعينه بقرار مسبب مسجل، مع بقاء العضوية قائمة. ويُسمى هذا تقييد المزايا لا إلغاء العضوية.

### 13.4 ما لا يمسه التقييد
لا يمس تقييد المزايا دخول الزبون إلى حسابه، ولا وصوله إلى بياناته وطلباته، ولا حقه في الدعم، ولا حقه في الضمان، ولا التزامه بسداد ما عليه ولا قدرته على السداد. فالتقييد يقع على حساب المزية وحده.

### 13.5 أثر التقييد على التسعير
إذا شمل التقييد مزايا الشراء الخاصة بـ PRO، سُعِّرت طلبات العضو تسعيراً اعتيادياً مدة التقييد، ثم عادت إلى ما كانت عليه بزواله.

### 13.6 الإعلام
يُعلَم صاحب الحساب بقيام التقييد وبسببه على وجه عام، ما لم يكن في تفصيل السبب إضرار بأمن المنصة أو كشف لأسلوب كشف المخالفة.

### 13.7 التظلم
لصاحب الحساب أن يتظلم من قرار التقييد خلال {{ACCOUNT_APPEAL_DAYS}} يوماً من إعلامه به، ويُبت في تظلمه خلال {{DISPUTE_RESPONSE_DAYS}} يوماً.

### 13.8 سحب ما أُخذ بغير وجه حق
للمتجر أن يسترد ما نُقص من ثمن أو أُعفي من أجرة أو مُنح من نقاط بناءً على إساءة استعمال ثابتة، وأن يقيّده ديناً على الحساب أو يخصمه من محفظته.

### 13.9 الإلغاء مع الإساءة الجسيمة
إذا بلغت الإساءة حداً جسيماً أو تكررت بعد الإنذار، جاز إلغاء العضوية وفق المادة 10.7.

### 13.10 حقوق المتجر الأخرى
ما في هذا الفصل لا يمنع المتجر من الرجوع بما لحقه من ضرر، ولا من اتخاذ ما يراه من إجراء وفق الشروط العامة والقانون الواجب التطبيق.

## 14. أحكام ختامية

### 14.1 تعديل هذه الوثيقة
للمتجر تعديل هذه الوثيقة. ويُنشر التعديل بنسخة جديدة وتاريخ نفاذ جديد، ويسري على ما يقع بعد نفاذه. ولا يُنقص تعديل لاحق من مزية ثبتت لعضوية قائمة قبل نفاذه.

### 14.2 حجية النسخة المسجلة
النسخة المحفوظة في سجل المتجر مع قبول العضو لها هي الحجة عند الخلاف في مضمون ما قبله.

### 14.3 استقلال البنود
إذا بطل بند من هذه الوثيقة أو تعذر تنفيذه، بقي سائر بنودها نافذاً.

### 14.4 حل النزاعات
يُقدَّم الخلاف أولاً إلى الدعم عبر {{LEVONIS_SUPPORT_CONTACT}}، ويُجاب عليه خلال {{DISPUTE_RESPONSE_DAYS}} يوماً.

### 14.5 القانون الواجب التطبيق والاختصاص
يسري على هذه الوثيقة قانون {{GOVERNING_LAW_JURISDICTION}}، وتختص بنظر ما ينشأ عنها {{COMPETENT_COURT}}.

### 14.6 جهة الاتصال
جهة الاتصال المعتمدة: {{LEVONIS_SUPPORT_CONTACT}}، وأوقات العمل: {{LEVONIS_SUPPORT_HOURS}}.`,
    en: `## 1. Preamble, Scope and Definitions

### 1.1 Purpose of this document
This document sets out the paid membership tiers on the Levonis platform, exactly what each tier grants, how one is bought and how it is upgraded, when it begins and when it ends, how it is cancelled and what is returned on cancellation, what the customer keeps of what was already earned when a membership lapses, and what suspends the benefits of a member who abuses them.

### 1.2 The parties
The Store: {{LEVONIS_LEGAL_NAME}}, registered under number {{LEVONIS_REGISTRATION_NO}}, at {{LEVONIS_ADDRESS}}. The Member: the account holder who has bought a membership plan or to whom one has been granted.

### 1.3 Definitions
- Membership: a fixed-term relationship between the Store and an account holder granting stated benefits against a consideration paid in advance.
- Tier: the level of a membership. There are three paid tiers: LEVO PLUS, LEVO PREMIUM and LEVO PRO.
- Plan: a purchasable record combining a tier, a duration in months and a price in Iraqi dinars.
- Duration: the number of calendar months for which a membership runs.
- Benefit: a specific right granted by a tier and recorded under its own name in the Store's system.
- Inheritance: that a higher tier holds every benefit of the tiers below it.
- Membership record: the entry carrying the tier, the duration, the amount paid, the purchase date and the state of the membership.
- State: the description of a membership record in the system, namely: awaiting payment, prepaid and reserved pending the launch, active, expired, or cancelled.
- Launch: the Store's announced decision to bring the membership system into operation; a reserved membership does not begin to run before it.
- Approved default address: the single address the Store has approved for a PRO member and recorded in its system in the approved state.
- PRO purchase context: the conjunction of conditions that makes the PRO purchase benefits effective on a particular order.
- Snapshot: a frozen copy of the facts an order or a reward was built on, kept with the record and not recomputed afterwards.
- Restriction case: a reasoned decision of the Store suspending one or more benefits on a particular account without touching the account itself.
- Wallet: the customer's balance inside the platform under the Payment and Wallet Policy.

### 1.4 The authoritative text
The Arabic text is the authoritative text. The English and Kurdish versions are faithful translations of it under the same numbering, article by article: article 6.4 is article 6.4 in all three languages. Where interpretations differ, the Arabic text governs.

### 1.5 Relation to the other documents
This document is read together with the General Terms and Conditions, the Purchase Policy, the Payment and Wallet Policy, the Delivery Policy, the Price Protection Policy, the Levo Community Policy and the Rewards and Points Policy. Matters of delivery charges are read in the Delivery Policy, matters of the wallet and deferred payment in the Payment Policy, and the points multiplier in the Rewards Policy.

### 1.6 Order of precedence
Where this document conflicts with another document in describing a membership benefit, this document governs. Where it conflicts with another document over a delivery, payment or warranty procedure, the document specific to that procedure governs.

### 1.7 Acceptance
Buying a membership plan, or taking any of its benefits, is acceptance of this document in the version in force at the time of purchase.

### 1.8 Version and effective date
This document carries a version number and an effective date stated at its head. The text of every version a customer has accepted is retained, so no member is held to a text that was not in force when they bought.

### 1.9 No implied waiver
The Store's silence over a breach, or its indulgence in a particular case, is not a waiver of its rights under this document in any other case.

## 2. The three tiers and their order

### 2.1 The paid tiers
There are three paid membership tiers: LEVO PLUS, LEVO PREMIUM and LEVO PRO. A person with no membership is an ordinary user and has everything the platform offers the public, without the membership benefits.

### 2.2 Order of the tiers
The tiers rank from lowest to highest: PLUS, then PREMIUM, then PRO.

### 2.3 Inheritance
A higher tier inherits every benefit below it. A PREMIUM member holds the PLUS benefits in full plus the PREMIUM benefits; a PRO member holds the PLUS and PREMIUM benefits in full plus the PRO benefits.

### 2.4 The name of the PREMIUM tier
The middle tier is called LEVO PREMIUM on every screen shown to a customer. It may appear as PRIME in older records or in an internal export; these are two names for one tier, not two tiers.

### 2.5 One membership at a time
An account does not hold more than one live membership at a time, whether active or reserved pending the launch. An attempt to buy a second membership while the first is live is refused on the server.

### 2.6 A membership is personal
A membership is personal to the account holder. It is not transferred, sold, lent or split, and it is not used for the benefit of another person, even a member of the same household.

### 2.7 Benefits are computed on the server
Every benefit is computed on the Store's server at the moment it is used, from the membership record itself. Nothing sent by a browser or an application by way of a tier, an attribute or a flag stored on the device is given any effect.

## 3. Plans, their prices and their durations

### 3.1 What a plan is
A plan is a purchasable record combining a tier, a duration in months and a price. One tier may have several plans differing in duration.

### 3.2 Duration in calendar months
A membership's duration is counted in calendar months from the moment it begins. Where the corresponding day does not exist in the closing month, the membership ends on the last day of that month.

### 3.3 Price
The price of each plan is the figure displayed on the memberships page at the moment of purchase. No price is fixed in this document and none may be inferred from it, because prices are set by the Store in its system and change on its announcement.

### 3.4 The price covers the membership consideration alone
The membership consideration is the price of the benefits set out in this document. It does not include the price of any goods, any delivery charge, any extended-warranty fee or any other amount.

### 3.5 An unpriced plan
A plan for which the Store has set no price is not offered for sale and cannot be bought; the system refuses the purchase with an express message. Its appearance on a screen or in a list creates no right to buy it at a supposed price.

### 3.6 Changes of price
The Store may amend plan prices, add plans and withdraw plans. An amendment does not apply to a live membership bought before it, its member is not asked for any difference, and its term is not shortened.

### 3.7 Currency and the wallet debit
Plan prices are displayed in Iraqi dinars, and the membership consideration is debited from the wallet balance in the currency in which the debit is made, at the exchange rate in force on the platform at the moment of purchase. The wallet and its balances are detailed in the Payment and Wallet Policy.

### 3.8 A rate change between the summary and the confirmation
If the exchange rate or the figures of the summary change between the moment the summary is displayed and the moment of confirmation, the system refuses to complete the purchase and displays the new figures for a fresh confirmation. No amount the customer has not seen and approved is debited.

### 3.9 No purchase outside the platform
A membership is sold, renewed and upgraded only from within the platform and by a debit from the wallet. Anything paid outside the platform creates no membership and binds the Store to nothing.

## 4. What LEVO PLUS grants

### 4.1 The basis of this chapter
What appears in this chapter is the whole of the benefits recorded for the PLUS tier in the Store's system. What does not appear here and does not appear in chapters 5 and 6 is not a membership benefit.

### 4.2 Opening a store inside Levo Community
PLUS grants its holder merchant standing inside Levo Community: a merchant profile, a store within the platform, the listing of products, and the management of that store's orders.

### 4.3 A subdomain for the merchant store
The merchant store is given an address of its own within the platform by which it is known.

### 4.4 The merchant analytics panel
The merchant is shown analytics for their store, their products and their orders.

### 4.5 Making offers inside the community
A PLUS member may make offers on member requests published in Levo Community, under the Community Policy.

### 4.6 Coupons, sections and offers reserved for members
A PLUS member has access to whatever the Store reserves for members by way of coupons, displayed sections and offers, once the Store has announced them and for as long as they run.

### 4.7 The limits of PLUS
PLUS does not by itself grant a member price on goods, an exemption from delivery charges, a points multiplier, priority in service or deferred payment. Those belong to the two higher tiers alone.

### 4.8 Merchant standing requires a live membership
Merchant standing is tied to a live membership. When the membership lapses, the merchant benefits stop as the Levo Community Policy provides, without deleting the store's past records or its orders.

## 5. What LEVO PREMIUM grants

### 5.1 What PREMIUM inherits
PREMIUM grants everything PLUS grants under chapter 4, and adds the following.

### 5.2 Member pricing for PREMIUM
The member price recorded for a product is applied where the Store has recorded a member price for that product. Where it has not, the price is the price published to the public.

### 5.3 Delivery exemption above the stated order value
The Store bears the ordinary delivery charge for a PREMIUM member where the merchandise value of the order counted for this purpose exceeds {{PREMIUM_FREE_DELIVERY_MIN_IQD}} Iraqi dinars. Exceeding is a real condition: an amount equal to the threshold is not enough; it must be above it.

### 5.4 The limits of the PREMIUM exemption
The PREMIUM exemption covers the ordinary delivery charge alone. It does not cover printer charges, additional carton charges or other surcharges, which remain on the customer. Those charges are detailed in the Delivery Policy.

### 5.5 The points multiplier
A PREMIUM member's points are computed at one and a half times what is computed for an ordinary user, on the daily sign-in, on missions, on purchases and on reviews. The computation and its rounding are detailed in the Rewards and Points Policy.

### 5.6 Cash-on-delivery tax
Exemption from the cash-collection tax is a benefit recorded in the system for PREMIUM and above, and it is effective only where the Store has activated it by an announced rule. The rule currently in force does not exempt a PREMIUM member from that tax, which therefore remains payable unless the Store announces otherwise.

### 5.7 The limits of PREMIUM
PREMIUM does not grant the PRO price on goods, the pre-order transport commission waiver, deferred payment, priority of service, the twelve-hour fulfilment service or the PRO badge.

## 6. What LEVO PRO grants

### 6.1 What PRO inherits
PRO grants everything PLUS and PREMIUM grant under chapters 4 and 5, and adds the following. The PRO purchase benefits are conditional on chapter 7.

### 6.2 PRO pricing
The PRO price recorded for a product is applied where the Store has recorded one. Where it has not, the price is the price published to the public, and a PRO price is not inferred from a percentage or from a comparison.

### 6.3 Waiver of the pre-order transport commission
The transport commission added to a pre-order line is not charged to a PRO member. This waiver is one of the purchase benefits conditional on chapter 7.

### 6.4 Delivery exemption above the stated order value
The Store bears the delivery costs for a PRO member where the merchandise value of the order counted for this purpose exceeds {{PRO_FREE_DELIVERY_MIN_IQD}} Iraqi dinars. Exceeding is a real condition: an amount equal to the threshold is not enough; it must be above it.

### 6.5 The breadth of the PRO exemption
The PRO exemption is broader than the PREMIUM one: it covers the delivery costs shown on the order and not the ordinary charge alone, as the Delivery Policy provides. A cash-collection tax imposed by the delivery company at the door is not a delivery charge and is not covered by this exemption.

### 6.6 Priority of service
A PRO member's requests, reviews and claims are given priority in the queue over others so far as the organisation of work allows, with a target first response of {{PRO_PRIORITY_RESPONSE_HOURS}} hours. Priority is a place in a queue; it is not a promise of an outcome nor of a change in the substance of any decision.

### 6.7 The twelve-hour fulfilment service
A PRO member is offered fulfilment of an order within twelve hours of its creation. It is a conditional service, and it is effective on a particular order only where all of the following are met together: a live PRO membership; delivery to the approved default address; the service switched on by the Store; the chosen delivery method being one of the methods the Store has included in the service; the shipping type being one of the included types; and the governorate of the address being one of the included governorates.

### 6.8 Stating why the twelve-hour service does not apply
Where a condition of article 6.7 is not met, the service is not applied to the order and the reason is stated on the order itself. Its non-application is not a breach of the membership.

### 6.9 Deferred payment
A PRO member is offered deferred payment within the limits and dates set out in the Payment and Wallet Policy. It is a facility conditional on the Store's assessment of the account's eligibility and is not an absolute right on every order.

### 6.10 The PRO badge
The community store of a PRO member is given a badge indicating its tier. The badge indicates the membership alone; it is not an identity verification and is not a certificate from the Store as to the quality of the merchant's goods or the merchant's performance.

### 6.11 The points multiplier
A PRO member's points are computed at double what is computed for an ordinary user, on the daily sign-in, on missions, on purchases and on reviews. The computation and its rounding are detailed in the Rewards and Points Policy.

### 6.12 Sections and offers reserved for PRO
A PRO member has access to whatever the Store reserves for that tier by way of sections and offers, once announced and for as long as they run.

### 6.13 The gift on a prepaid pre-order
Where the Store has switched this gift on and named the product it is drawn from, a PRO member is entitled to a gift in kind with a pre-order where the order is paid in full before delivery so that nothing remains to be collected at the door, and the order is priced within the PRO purchase context under chapter 7. The gift is goods shipped with the order and its value on the invoice is zero; it is not deducted from any price, not exchanged for money and not refunded in cash.

### 6.14 A conditional gift is not promised outside its condition
Where the Store has not switched the gift on or has not named its product, there is no entitlement to it. No member of staff and no merchant may promise it as automatic or guaranteed.

## 7. The approved default address condition for PRO purchase benefits

### 7.1 The rule
The PRO purchase benefits — the PRO price on goods, the waiver of the pre-order transport commission, the waiver of the direct-sale premium, the waiver of delivery costs and delivery priority — are effective only on an order priced for one particular address: the approved default address of the member's account.

### 7.2 Why this condition exists
Because the PRO benefits were made for one person at a known place, not for an address that changes with every order. Tying them to a single approved address is what prevents their becoming a wholesale-purchasing instrument for resale under one member's name.

### 7.3 How the approved address is identified
The approved address is the address recorded in the Store's system in the approved state for the member's account. Matching is made on the name, the address and the telephone number, disregarding differences of spacing, letter case and number formatting alone.

### 7.4 Pricing outside the approved address
Where an order is priced for an address other than the approved one, it is priced entirely as ordinary: at the public price, with the transport commission, with the direct-sale premium, with the delivery charge, and without delivery priority.

### 7.5 What the member sees before choosing an address
On the product page and in the cart, before the member has chosen an address, the price is judged against their default address. A member whose default address is not approved therefore sees the ordinary price on all of those screens, so that they are not shown a price that will not be honoured at the door.

### 7.6 Approving and changing an address
Approving an address, reviewing it and changing it belong to the Store under the PRO membership administration procedure. An address is not approved merely by being added to the account.

### 7.7 What this condition does not remove
This condition does not remove what is not a purchase benefit: the points multiplier, the PRO badge, priority of service, deferred payment, and the reserved sections and offers all subsist for as long as the membership does, whatever the address of the order.

## 8. Purchase, upgrade and payment

### 8.1 Who buys
A membership is bought only from within a verified account and is recorded in the name of that account holder alone.

### 8.2 The summary before confirmation
Before confirmation the customer is shown a summary stating the plan, its tier, its duration and its price, the value credited from any live membership, the amount actually debited, the available balance, and the expected expiry date or the fact that the membership will be reserved until the launch.

### 8.3 Confirmation is what binds
No amount is debited and no membership is created before the customer confirms the summary. If the amount recomputed at confirmation differs from the amount displayed, completion is refused and the summary is redisplayed with the new figures.

### 8.4 The wallet debit
The membership consideration is debited from the available balance in the wallet. The available balance is the settled balance after deducting amounts held for other operations, as the Payment and Wallet Policy explains.

### 8.5 Insufficient balance
Where the available balance is insufficient, the purchase is refused, no membership record is created and nothing is debited. No partial membership and no membership on credit is created.

### 8.6 Double submission and repetition
Every purchase carries a non-repeating key. Where a request is sent twice for a technical reason, one debit and one membership result, and the second is treated as a repetition of the first and not as a new purchase.

### 8.7 Buying the same tier again
A membership of the same tier cannot be bought while the first is live. It is bought again after that one ends.

### 8.8 Moving down to a lower tier
A purchase downwards to a tier lower than the live one is not made. A member who wishes to do so waits for their membership to end and then buys as they wish.

### 8.9 Upgrading to a higher tier
An upgrade from a lower tier to a higher one may be made at any time. The value remaining in the live membership is credited against the price of the new tier, the old membership is ended at the same moment, and the new one begins with its full duration.

### 8.10 How the upgrade credit is computed
The upgrade credit is computed from the value of the live plan spread over the days of its duration, multiplied by the days remaining in it, with the fraction taken down. The credit never exceeds the price of the new tier in any case: an upgrade creates no debt of the Store to the customer and returns no cash.

### 8.11 Upgrading a reserved membership that has not begun
Where the live membership is prepaid and reserved and its term has not yet begun, its whole value is credited against the price of the new tier, because none of it has been consumed.

### 8.12 A granted membership carries no upgrade credit
A membership granted to the customer without consideration is treated as of zero value in the upgrade credit and is not deducted from the price of the new tier, because the credit is computed on what the customer paid and not on what the Store gave.

## 9. Commencement, term, expiry and renewal

### 9.1 Commencement after the launch
After the launch has been announced, a membership begins from the moment the purchase completes and ends on the expiry of its duration counted in calendar months.

### 9.2 A membership reserved before the launch
A member who bought before the launch was announced has their membership reserved for its full duration, and its term has not yet begun. The reservation is an undertaking by the Store as to the full duration, which is not shortened by the length of the wait.

### 9.3 Commencement of the term at the launch
The term of a reserved membership begins when the Store announces the activation of the launch, which is an announced and recorded decision and does not occur by the mere passage of time.

### 9.4 Expiry of the term
A membership ends of itself on the expiry of its duration, and its expiry is recorded in the system. Its expiry requires neither notice nor request.

### 9.5 No automatic renewal
A membership does not renew automatically, the Store keeps no payment instrument from which to debit after the term ends, and no renewal consideration the customer has not requested is debited from their wallet. A member who wishes to continue buys a new plan themselves.

### 9.6 Buying again after expiry
A new purchase may be made after a membership expires, in the same tier or another. The new membership is an independent one with its own duration and price, and the time that has passed is not added to what is to come.

### 9.7 The effect of expiry on the benefits
On expiry all benefits stop from the date of expiry onwards: the price returns to the public price, the delivery charge returns to the customer, the points multiplier returns to its ordinary value, and priority, the badge and new deferred payment fall away.

### 9.8 What does not fall away on expiry
What had already vested in the customer before expiry does not fall away; this is detailed in chapter 11.

### 9.9 Notice of approaching expiry
Where the Store sends notice that a membership is about to expire, it is a reminder given as a service. Its non-arrival does not extend the term and creates no right to an extension.

## 10. Cancellation and refund

### 10.1 Cancellation is not a button in the account
There is no self-service cancellation of a membership on the platform. A member who wishes to cancel submits a request to Support at {{LEVONIS_SUPPORT_CONTACT}}, and it is considered under this chapter.

### 10.2 Who may cancel
A membership is cancelled only by a recorded decision of the Store's administration, in which the person who made it, the moment and the reason are preserved.

### 10.3 What may be cancelled
An active membership, a reserved membership that has not begun, and a membership whose payment was not completed may be cancelled. A membership whose term has expired is not cancelled, because it has already come to an end of itself.

### 10.4 The effect of cancellation
On cancellation the benefits stop from that date onwards and the membership is recorded as cancelled. The account is then free of any live membership and may buy again.

### 10.5 Refund
A refund is a decision independent of the cancellation and is not an inevitable consequence of it. Where the Store decides on a refund, the amount recorded against the membership is returned to the customer's wallet in the currency in which it was debited, and it is not returned twice even if the cancellation is executed again. Where it is agreed that only part of it is returned against the term consumed, that is stated in writing in the cancellation decision itself and recorded with it.

### 10.6 The destination of a refund
The destination of a refund is the customer's wallet inside the platform. A membership consideration is not returned in cash at the door nor to an external payment instrument, and the balance is thereafter dealt with under the Payment and Wallet Policy.

### 10.7 Cancellation for breach
Where the cancellation is for a breach by the member of this document or of the General Terms, the Store may refund nothing, and the reason is stated in the cancellation decision.

### 10.8 The effect of cancellation on a referral reward arising from the subscription
Where a PRO subscription gave rise to a referral reward in favour of the person who invited the member, that reward is cancelled with the cancellation of the subscription, because its cause was the payment that has gone.

### 10.9 What is not refunded
The membership consideration is not refunded for a term the member actually enjoyed, no compensation is made for a benefit not used, and the membership consideration is not converted into the price of goods or into points.

## 11. The effect of a lapse on what the member earned before it

### 11.1 The rule
A benefit vested in the member on a paid order, or a reward due before their membership lapsed or was cancelled, is not taken back afterwards. A lapse operates for the future and not for the past.

### 11.2 The membership snapshot on the order
A frozen record of the membership tier and its state at the moment the order completed, and of the effect it had on price, delivery and tax, is kept with every order. That record is the reference in every later review of the order.

### 11.3 The price paid
A price paid under a membership benefit is a final price. The customer is not asked for any difference after their membership lapses, even where the order is fulfilled or delivered after the lapse.

### 11.4 A vested delivery exemption
A delivery exemption vested on a confirmed order is not undone by a lapse occurring after that confirmation, and the delivery company does not charge the customer a fee the Store has borne.

### 11.5 Points granted at the multiplier
Points computed at the membership multiplier remain the customer's in the amount computed. Where part of an order is returned after the membership has lapsed, the points are recomputed at the multiplier recorded on the order at the time of purchase and not at today's multiplier, so that no more is taken back from the customer than they earned.

### 11.6 Vested gifts and rewards
A gift vested on a paid order, and a reward that has reached the reserved or the handed-over stage, are not taken back by a lapse. Anything that has not reached the stage of entitlement remains subject to its own condition.

### 11.7 Warranty and after-sale
A membership has no bearing on warranty. The warranty period and its extent remain as they were on the day of purchase, a lapse neither shortens them nor extinguishes a live claim. What falls away is priority in the queue alone.

### 11.8 Live deferred payment
Where an amount is deferred against the member, its repayment remains due after the membership lapses or is cancelled and the means of repayment remains available to them, because the obligation arose before the lapse.

## 12. Granted memberships and conditional gifts

### 12.1 A PLUS membership granted with a printer purchase
Where the Store has switched this feature on and named the PLUS plan to be granted, a customer who buys a qualifying printer is granted a PLUS membership without consideration.

### 12.2 The condition that the account holds no live membership
A granted membership is not given to an account holding a live membership, whether active or reserved, because an account does not hold more than one membership. The abstention is recorded in the Store's log so that it may be considered by hand where appropriate.

### 12.3 The value of a granted membership on upgrade
A granted membership is of zero value in computing the upgrade credit, under article 8.12.

### 12.4 Conditional gifts generally
Every gift or additional benefit conditional on the Store switching it on and on naming what it is drawn from is not due before its condition is met. Its mention on a page or in an old advertisement creates no entitlement.

### 12.5 A gift is goods, not money
A gift is issued as goods at a value of zero on the invoice. It is not exchanged for money, points or a discount, and it is not refunded in cash on a return.

### 12.6 Stock running out
Where what the gift is drawn from runs out, the customer is informed and their entitlement is preserved until it is available or until an alternative is agreed. It does not in any case turn into money.

## 13. Abuse and the restriction of benefits

### 13.1 The purpose of this chapter
Membership benefits were made for reasonable personal use. This chapter sets out what counts as abuse and what follows from it.

### 13.2 Forms of abuse
- Using membership benefits to buy for resale or to supply third parties.
- Enabling a person other than the account holder to take the benefits of that membership.
- Opening multiple accounts for one person in order to repeat a benefit or to exceed a limit.
- Repeatedly refusing delivery or repeatedly cancelling in a way that loads costs on the Store for no return.
- Giving untrue information to have an address approved or to obtain a benefit.
- Using the membership in an activity prohibited by the General Terms.

### 13.3 Restriction of benefits
The Store may suspend one or more benefits on a particular account by a reasoned, recorded decision, the membership itself subsisting. This is called a restriction of benefits and is not a cancellation of the membership.

### 13.4 What a restriction does not touch
A restriction of benefits does not touch the customer's access to their account, their access to their data and orders, their right to support, their right to warranty, their obligation to repay what they owe or their ability to repay it. It falls on the computation of the benefit alone.

### 13.5 The effect of a restriction on pricing
Where a restriction covers the PRO purchase benefits, the member's orders are priced as ordinary for the duration of the restriction, and return to what they were when it is lifted.

### 13.6 Notification
The account holder is informed that a restriction exists and of its reason in general terms, unless detailing the reason would harm the security of the platform or disclose the method by which the breach was detected.

### 13.7 Appeal
The account holder may appeal a restriction decision within {{ACCOUNT_APPEAL_DAYS}} days of being informed of it, and the appeal is determined within {{DISPUTE_RESPONSE_DAYS}} days.

### 13.8 Recovery of what was taken without right
The Store may recover a reduction in price, an exemption from a charge or a grant of points obtained on the basis of established abuse, and may record it as a debt on the account or set it off against the wallet.

### 13.9 Cancellation for serious abuse
Where the abuse is serious or is repeated after a warning, the membership may be cancelled under article 10.7.

### 13.10 The Store's other rights
Nothing in this chapter prevents the Store from recovering the loss it has suffered, or from taking such action as it sees fit under the General Terms and the applicable law.

## 14. Final provisions

### 14.1 Amendment of this document
The Store may amend this document. An amendment is published as a new version with a new effective date and applies to what occurs after it takes effect. A later amendment does not reduce a benefit vested in a live membership before it took effect.

### 14.2 The authority of the recorded version
The version retained in the Store's records together with the member's acceptance of it is the authority in any dispute over the content of what they accepted.

### 14.3 Severability
If a provision of this document is void or cannot be performed, the remainder of its provisions remain in force.

### 14.4 Dispute resolution
A dispute is first submitted to Support at {{LEVONIS_SUPPORT_CONTACT}} and is answered within {{DISPUTE_RESPONSE_DAYS}} days.

### 14.5 Governing law and jurisdiction
This document is governed by the law of {{GOVERNING_LAW_JURISDICTION}}, and {{COMPETENT_COURT}} has jurisdiction over what arises from it.

### 14.6 Contact
The approved contact point is {{LEVONIS_SUPPORT_CONTACT}}, and the hours of business are {{LEVONIS_SUPPORT_HOURS}}.`,
    ckb: `## 1. پێشەکی و بوار و پێناسەکان

### 1.1 مەبەستی ئەم بەڵگەنامەیە
ئەم بەڵگەنامەیە پلەکانی ئەندامێتیی پارەدراو لە پلاتفۆرمی Levonis دا ڕوون دەکاتەوە، و بە وردی دەڵێت هەر پلەیەک چی دەبەخشێت، چۆن دەکڕدرێت و چۆن بەرز دەکرێتەوە، کەی دەست پێدەکات و کەی کۆتایی دێت، چۆن هەڵدەوەشێنرێتەوە و چی دەگەڕێنرێتەوە، چی بۆ کڕیار دەمێنێتەوە لەوەی پێش کۆتاییهاتنی ئەندامێتییەکەی شایستەی بووە، و چی سوودەکانی ڕادەگرێت ئەگەر خراپ بەکاری بهێنێت.

### 1.2 لایەنەکان
فرۆشگا: {{LEVONIS_LEGAL_NAME}}، تۆمارکراو بە ژمارەی {{LEVONIS_REGISTRATION_NO}}، و ناونیشانی {{LEVONIS_ADDRESS}}. ئەندام: خاوەنی ئەو هەژمارەیە کە پلانێکی ئەندامێتی کڕیوە یان پێی بەخشراوە.

### 1.3 پێناسەکان
- ئەندامێتی: پەیوەندییەکی ماوەدیاریکراو لە نێوان فرۆشگا و خاوەنی هەژمار کە سوودی ڕاگەیەنراوی پێدەبەخشێت بەرامبەر بڕێکی پێشوەخت دراو.
- پلە: ئاستی ئەندامێتی. پلە پارەدراوەکان سێن: LEVO PLUS و LEVO PREMIUM و LEVO PRO.
- پلان: تۆمارێکی کڕدراو کە پلە و ماوە بە مانگ و نرخ بە دیناری عێراقی کۆدەکاتەوە.
- ماوە: ژمارەی ئەو مانگە ڕۆژژمێرییانەی کە ئەندامێتی تێیاندا کار دەکات.
- سوود: مافێکی دیاریکراو کە پلەکە دەیبەخشێت، بە ناوی خۆیەوە لە سیستەمی فرۆشگادا تۆمارکراوە.
- میرات: ئەوەی پلەی سەرەوە هەموو سوودەکانی پلەکانی ژێر خۆی بە میرات دەبات.
- تۆماری ئەندامێتی: ئەو تۆمارەی پلە و ماوە و بڕی پارەدراو و بەرواری کڕین و دۆخی ئەندامێتی هەڵدەگرێت.
- دۆخ: وەسفی تۆماری ئەندامێتی لە سیستەمدا، کە بریتییە لە: چاوەڕێی پارەدان، یان حیجزکراوی پارەدراو لە چاوەڕێی دەستپێکردن، یان چالاک، یان کۆتاییهاتوو، یان هەڵوەشێنراوە.
- دەستپێکردن: بڕیاری ڕاگەیەنراوی فرۆشگا بە دەستپێکردنی کارپێکردنی سیستەمی ئەندامێتییەکان؛ ئەندامێتیی حیجزکراو پێش ئەو کار ناکات.
- ناونیشانی بنەڕەتیی پەسەندکراو: ئەو یەک ناونیشانەی فرۆشگا بۆ ئەندامی PRO پەسەندی کردووە و بە دۆخی پەسەندکراو لە سیستەمەکەیدا تۆمارە.
- چوارچێوەی کڕینی تایبەت بە PRO: کۆبوونەوەی ئەو مەرجانەی کە سوودەکانی کڕینی تایبەت بە PRO لەسەر داواکارییەکی دیاریکراو کاریگەر دەکەن.
- وێنەگرتن: کۆپییەکی بەستراوی ئەو ڕاستییانەی داواکارییەک یان خەڵاتێک لەسەریان بنیات نراوە، لەگەڵ تۆمارەکەدا هەڵدەگیرێت و دوای ئەوە دووبارە ناژمێردرێتەوە.
- دۆخی سنووردارکردن: بڕیارێکی هۆکارداری فرۆشگا کە یەک سوود یان زیاتر لەسەر هەژمارێکی دیاریکراو ڕادەگرێت بەبێ ئەوەی دەست لە خودی هەژمارەکە بدات.
- جزدان: باڵانسی کڕیار لە ناو پلاتفۆرمدا بەپێی سیاسەتی پارەدان و جزدان.

### 1.4 دەقی بنەڕەت
دەقی عەرەبی بنەڕەتە. دوو وەشانی ئینگلیزی و کوردی وەرگێڕانێکی دەستپاکن بۆی بە هەمان ژمارەکردن، ماددە بە ماددە، بۆیە ماددەی 6.4 لە هەر سێ زماندا هەمان ماددەیە. لە کاتی جیاوازیی لێکدانەوەدا دەقی عەرەبی سەرچاوەیە.

### 1.5 پەیوەندیی ئەم بەڵگەنامەیە بە بەڵگەنامەکانی ترەوە
ئەم بەڵگەنامەیە لەگەڵ مەرج و ڕێسا گشتییەکان، سیاسەتی کڕین، سیاسەتی پارەدان و جزدان، سیاسەتی گەیاندن، سیاسەتی پاراستنی نرخ، سیاسەتی کۆمەڵگەی لێڤۆ، و سیاسەتی خەڵات و خاڵ دەخوێنرێتەوە. ئەوەی پەیوەندی بە کرێی گەیاندنەوە هەیە لە سیاسەتی گەیاندندا دەخوێنرێتەوە، ئەوەی پەیوەندی بە جزدان و پارەدانی دواخراوەوە هەیە لە سیاسەتی پارەداندا، و ئەوەی پەیوەندی بە زیادکەری خاڵەوە هەیە لە سیاسەتی خەڵاتدا.

### 1.6 ڕێسای پێشخستن
ئەگەر ئەم بەڵگەنامەیە لەگەڵ بەڵگەنامەیەکی تر لە وەسفکردنی سوودێکی ئەندامێتیدا ناکۆک بوو، ئەم بەڵگەنامەیە پێشدەخرێت. ئەگەر لەگەڵ بەڵگەنامەیەکی تر لە ڕێکارێکی گەیاندن یان پارەدان یان گەرەنتیدا ناکۆک بوو، ئەو بەڵگەنامەیە پێشدەخرێت کە پسپۆڕی ئەو ڕێکارەیە.

### 1.7 پەسەندکردنی بەڵگەنامەکە
کڕینی پلانێکی ئەندامێتی یان سوودوەرگرتن لە سوودێکی، پەسەندکردنی ئەم بەڵگەنامەیەیە بەو وەشانەی لە کاتی کڕیندا کاری پێدەکرا.

### 1.8 وەشان و بەرواری کارپێکردن
ئەم بەڵگەنامەیە ژمارەی وەشان و بەرواری کارپێکردنی لە سەرەوەی چەسپێنراون. دەقی هەر وەشانێک کە کڕیارێک پێشتر پەسەندی کردووە دەپارێزرێت، بۆیە بە دەقێک لە دژی ئەندامێک وەستانەوە ناکرێت کە لە کاتی کڕینیدا نەبووە.

### 1.9 پاشەکشەی ناڕاستەوخۆ نییە
بێدەنگیی فرۆشگا لە پێشێلکارییەک یان لێبووردنی لە حاڵەتێکی دیاریکراو بە پاشەکشە لە مافی لەم بەڵگەنامەیەدا لە حاڵەتەکانی تر دانانرێت.

## 2. سێ پلەکە و ڕیزبەندییان

### 2.1 پلە پارەدراوەکان
پلەکانی ئەندامێتیی پارەدراو سێن: LEVO PLUS، LEVO PREMIUM، و LEVO PRO. ئەوەی ئەندامێتی نییە بەکارهێنەرێکی ئاساییە، و هەموو ئەوەی هەیەتی کە پلاتفۆرم بۆ گشت خەڵک دەیبەخشێت بەبێ سوودەکانی ئەندامێتی.

### 2.2 ڕیزبەندیی پلەکان
ڕیزبەندیی پلەکان لە نزمەوە بۆ بەرز: PLUS پاشان PREMIUM پاشان PRO.

### 2.3 میرات
پلەی سەرەوە هەموو سوودەکانی ژێر خۆی بە میرات دەبات. ئەندامی PREMIUM سوودەکانی PLUS بە تەواوی هەیە زیاد سوودەکانی PREMIUM، و ئەندامی PRO سوودەکانی PLUS و PREMIUM بە تەواوی هەیە زیاد سوودەکانی PRO.

### 2.4 ناوی پلەی PREMIUM
پلەی ناوەڕاست لە هەموو ئەو شاشانەی بۆ کڕیار پیشان دەدرێن بە ناوی LEVO PREMIUM ناو دەبرێت. لەوانەیە لە تۆماری کۆن یان لە هەناردەکردنێکی ناوخۆیی بە ناوی PRIME دەربکەوێت، و ئەو دوو ناوە بۆ یەک پلەن نەک دوو پلە.

### 2.5 یەک ئەندامێتی لە یەک کاتدا
یەک هەژمار زیاتر لە یەک ئەندامێتیی هەبوو لە یەک کاتدا هەڵناگرێت، جا چالاک بێت یان حیجزکراو لە چاوەڕێی دەستپێکردن. هەوڵدان بۆ کڕینی ئەندامێتییەکی دووەم لەگەڵ هەبوونی یەکەمدا لەسەر ڕاژە ڕەت دەکرێتەوە.

### 2.6 ئەندامێتی کەسییە
ئەندامێتی کەسییە بۆ خاوەنی هەژمار. ناگوازرێتەوە، نافرۆشرێت، بە عارییەتی نادرێت و دابەش ناکرێت، و بۆ کەسێکی تر سوودی لێ وەرناگیرێت تەنانەت ئەندامی ماڵەکەی بێت.

### 2.7 سوود لەسەر ڕاژە دەژمێردرێت
هەر سوودێک لەسەر ڕاژەی فرۆشگا لە کاتی بەکارهێنانیدا لە خودی تۆماری ئەندامێتییەوە دەژمێردرێت. بەوەی وێبگەڕ یان ئەپەکە دەینێرێت لە پلە یان دۆخ یان نیشانەیەکی لە ئامێردا هەڵگیراو پشت نابەسترێت.

## 3. پلانەکان و نرخ و ماوەکانیان

### 3.1 پلان چییە
پلان تۆمارێکی کڕدراوە کە پلە و ماوە بە مانگ و نرخ کۆدەکاتەوە. یەک پلە دەکرێت زیاتر لە یەک پلانی هەبێت بە ماوەی جیاواز.

### 3.2 ماوە بە مانگی ڕۆژژمێری
ماوەی ئەندامێتی بە مانگی ڕۆژژمێری لە ساتی دەستپێکردنیەوە دەژمێردرێت. ئەگەر ڕۆژی بەرامبەر لە مانگی کۆتاییدا نەبوو، ئەندامێتییەکە لە دوایین ڕۆژی ئەو مانگەدا کۆتایی دێت.

### 3.3 نرخ
نرخی هەر پلانێک ئەو ژمارەیەیە کە لە لاپەڕەی ئەندامێتییەکاندا لە ساتی کڕیندا پیشان دەدرێت. هیچ نرخێک لەم بەڵگەنامەیەدا ناچەسپێنرێت و بەڵگەی نرخی لێ وەرناگیرێت، چونکە نرخەکان فرۆشگا لە سیستەمەکەیدا دیاری دەکات و بە ڕاگەیاندنی خۆی دەگۆڕێن.

### 3.4 نرخی پیشاندراو تەنها بەرامبەری ئەندامێتییە
بەرامبەری ئەندامێتی لە بەرامبەر ئەو سوودانەیە کە لەم بەڵگەنامەیەدا ڕوون کراونەتەوە. نرخی کاڵا، کرێی گەیاندن، کرێی گەرەنتی درێژکراوە، یان هیچ بڕێکی تر لەخۆناگرێت.

### 3.5 پلانی بێ نرخ
ئەو پلانەی فرۆشگا نرخی بۆ دیاری نەکردووە بۆ فرۆشتن پێشکەش نەکراوە و ناکڕدرێت، و سیستەمەکە کڕینی بە نامەیەکی ڕوون ڕەت دەکاتەوە. دەرکەوتنی لە شاشەیەک یان لە لیستێکدا هیچ مافێکی کڕینی بە نرخێکی وەهمی دروست ناکات.

### 3.6 گۆڕینی نرخەکان
فرۆشگا دەتوانێت نرخی پلانەکان بگۆڕێت، پلان زیاد بکات و پلان ڕابگرێت. گۆڕانکاری لەسەر ئەندامێتییەکی هەبوو کە پێشتر کڕدراوە جێبەجێ نابێت، داوای جیاوازی لە ئەندامەکەی ناکرێت، و ماوەکەی کورت ناکرێتەوە.

### 3.7 دراو و کەمکردنەوە لە جزدان
نرخی پلانەکان بە دیناری عێراقی پیشان دەدرێن، و بەرامبەری ئەندامێتی لە باڵانسی جزدان کەم دەکرێتەوە بەو دراوەی کەمکردنەوەکەی پێدەکرێت بەپێی نرخی ئاڵوگۆڕی پەسەندکراوی پلاتفۆرم لە ساتی کڕیندا. وردەکاری جزدان و باڵانسەکان لە سیاسەتی پارەدان و جزداندایە.

### 3.8 گۆڕانی نرخی ئاڵوگۆڕ لە نێوان پیشاندان و پەسەندکردندا
ئەگەر نرخی ئاڵوگۆڕ گۆڕا یان ژمارەکانی پیشاندان گۆڕان لە نێوان ساتی پیشاندانی کورتەکە و ساتی پەسەندکردندا، سیستەمەکە تەواوکردنی کڕینەکە ڕەت دەکاتەوە و ژمارە نوێیەکان دووبارە پیشان دەدات بۆ پەسەندکردنەوە. هیچ بڕێک لە کڕیار کەم ناکرێتەوە کە نەیبینیبێت و پەسەندی نەکردبێت.

### 3.9 کڕین لە دەرەوەی پلاتفۆرم نییە
ئەندامێتی تەنها لە ناو پلاتفۆرمەوە و بە کەمکردنەوە لە جزدان دەفرۆشرێت، نوێ دەکرێتەوە و بەرز دەکرێتەوە. ئەوەی لە دەرەوەی پلاتفۆرم دەدرێت هیچ ئەندامێتییەک دروست ناکات و فرۆشگا بە هیچ شتێک پابەند ناکات.

## 4. پلەی LEVO PLUS چی دەبەخشێت

### 4.1 بنەمای ئەم بەشە
ئەوەی لەم بەشەدا هاتووە کۆی ئەو سوودانەیە کە بۆ پلەی PLUS لە سیستەمی فرۆشگادا تۆمار کراون. ئەوەی لێرە و لە بەشەکانی پێنجەم و شەشەمدا نەهاتووە لە سوودەکانی ئەندامێتی نییە.

### 4.2 کردنەوەی فرۆشگا لە ناو کۆمەڵگەی لێڤۆ
PLUS دۆخی بازرگان لە ناو کۆمەڵگەی لێڤۆ بە خاوەنەکەی دەبەخشێت: پرۆفایلی بازرگان، فرۆشگایەک لە ناو پلاتفۆرم، پیشاندانی بەرهەم، و بەڕێوەبردنی داواکارییەکانی فرۆشگاکەی.

### 4.3 ژێردۆمەین بۆ فرۆشگای بازرگان
بۆ فرۆشگای بازرگان ناونیشانێکی ژێردۆمەین لە ناو پلاتفۆرمدا دەدرێت کە پێی دەناسرێت.

### 4.4 پانێڵی ئامارەکانی بازرگان
ئامارەکانی فرۆشگا و بەرهەم و داواکارییەکانی بۆ بازرگان پیشان دەدرێن.

### 4.5 پێشکەشکردنی پێشنیار لە ناو کۆمەڵگەدا
ئەندامی PLUS دەتوانێت پێشنیارەکانی لەسەر ئەو داواکارییانەی ئەندامان کە لە کۆمەڵگەی لێڤۆدا بڵاو کراونەتەوە پێشکەش بکات بەپێی سیاسەتی کۆمەڵگە.

### 4.6 کوپۆن و بەش و پێشکەشکراوە تایبەتەکانی ئەندامان
ئەوەی فرۆشگا بۆ ئەندامان تەرخان دەکات لە کوپۆن و بەشی پیشاندراو و پێشکەشکراو بۆ ئەندامی PLUS بەردەستە، کاتێک فرۆشگا ڕایدەگەیەنێت و تا کاری پێدەکرێت.

### 4.7 سنوورەکانی پلەی PLUS
PLUS بە خۆی هیچ نرخێکی تایبەت بۆ ئەندام لەسەر کاڵا نابەخشێت، نە بەخشینی کرێی گەیاندن، نە زیادکەری خاڵ، نە پێشینەیی لە خزمەتگوزاری، و نە پارەدانی دواخراو. ئەمانە تەنها سوودەکانی دوو پلەی سەرەوەن.

### 4.8 مەرجی ئەندامێتیی چالاک بۆ دۆخی بازرگان
دۆخی بازرگان بە ئەندامێتییەکی چالاکەوە بەستراوە. ئەگەر ئەندامێتی کۆتایی هات، سوودەکانی بازرگان بەپێی ئەوەی سیاسەتی کۆمەڵگەی لێڤۆ ڕوونی دەکاتەوە ڕادەوەستن، بەبێ ئەوەی ئەوەی پێشتر لە تۆمارەکانی فرۆشگا یان داواکارییەکانی هەبووە بسڕدرێتەوە.

## 5. پلەی LEVO PREMIUM چی دەبەخشێت

### 5.1 ئەوەی PREMIUM بە میرات دەیبات
PREMIUM هەموو ئەوە دەبەخشێت کە PLUS لە بەشی چوارەمدا دەیبەخشێت، و ئەمانەی خوارەوەی بۆ زیاد دەکات.

### 5.2 نرخاندنی تایبەت بە ئەندامانی PREMIUM
ئەو نرخەی ئەندامێتی کە بۆ بەرهەمەکە تۆمار کراوە لەسەر ئەندام جێبەجێ دەکرێت، لەو شوێنانەی فرۆشگا نرخێکی تایبەت بە ئەندامانی بۆ ئەو بەرهەمە تۆمار کردووە. لەو شوێنانەی تۆماری نەکردووە، نرخەکە ئەو نرخەیە کە بۆ گشت خەڵک ڕاگەیەنراوە.

### 5.3 بەخشینی گەیاندن لە سەرووی بەهای ڕاگەیەنراوی داواکارییەوە
فرۆشگا کرێی گەیاندنی ئاسایی لەسەر ئەندامی PREMIUM هەڵدەگرێت ئەگەر بەهای کاڵای داواکارییەکە کە بۆ ئەم مەبەستە ژمێردراوە لە بڕی {{PREMIUM_FREE_DELIVERY_MIN_IQD}} دیناری عێراقی تێپەڕی. تێپەڕاندن مەرجێکی ڕاستەقینەیە: بڕی یەکسان بە سنوورەکە بەس نییە، بەڵکو دەبێت لێی زیاتر بێت.

### 5.4 سنوورەکانی بەخشینی PREMIUM
بەخشینی PREMIUM تەنها کرێی گەیاندنی ئاسایی دادەپۆشێت. کرێی چاپگەرەکان، کرێی قوتووی زیادە، و کرێیە زیادەکانی تر ناگرێتەوە، و ئەمانە لەسەر کڕیار دەمێننەوە. وردەکاری ئەم کرێیانە لە سیاسەتی گەیاندندایە.

### 5.5 زیادکەری خاڵ
خاڵەکانی ئەندامی PREMIUM بە هاوکۆڵکەی یەک و نیو ئەوەی بۆ بەکارهێنەری ئاسایی دەژمێردرێت دەژمێردرێن، لە چوونەژوورەوەی ڕۆژانە، لە ئەرکەکان، لە کڕین، و لە هەڵسەنگاندنەکاندا. وردەکاری ژمێرکاری و خڕکردنەوە لە سیاسەتی خەڵات و خاڵدایە.

### 5.6 باجی پارەدان لە کاتی گەیاندندا
بەخشین لە باجی وەرگرتنی نەقد سوودێکی تۆمارکراوە لە سیستەمدا بۆ پلەی PREMIUM بەرەو سەرەوە، و تەنها کاتێک کاری پێدەکرێت کە فرۆشگا بە ڕێسایەکی ڕاگەیەنراو چالاکی بکات. ئەو ڕێسایەی ئێستا کاری پێدەکرێت ئەندامی PREMIUM لەم باجە نابەخشێت، بۆیە لەسەری دەمێنێتەوە مەگەر فرۆشگا پێچەوانەکەی ڕابگەیەنێت.

### 5.7 سنوورەکانی پلەی PREMIUM
PREMIUM نرخی PRO لەسەر کاڵا نابەخشێت، نە بەخشینی کۆمیسیۆنی گواستنەوە لە داواکاری پێشوەخت، نە پارەدانی دواخراو، نە پێشینەیی خزمەتگوزاری، نە خزمەتگوزاریی تەواوکردن لە ماوەی دوازدە کاتژمێردا، و نە نیشانەی PRO.

## 6. پلەی LEVO PRO چی دەبەخشێت

### 6.1 ئەوەی PRO بە میرات دەیبات
PRO هەموو ئەوە دەبەخشێت کە PLUS و PREMIUM لە بەشەکانی چوارەم و پێنجەمدا دەیبەخشن، و ئەمانەی خوارەوەی بۆ زیاد دەکات. سوودەکانی کڕینی PRO بە بەشی حەوتەم مەرجدارن.

### 6.2 نرخاندنی تایبەت بە ئەندامانی PRO
نرخی PRO کە بۆ بەرهەمەکە تۆمار کراوە لەسەر ئەندام جێبەجێ دەکرێت لەو شوێنانەی فرۆشگا تۆماری کردووە. لەو شوێنانەی تۆماری نەکردووە، نرخەکە ئەو نرخەیە کە بۆ گشت خەڵک ڕاگەیەنراوە، و نرخی PRO لە ڕێژەیەک یان لە بەراوردێکەوە دەرناهێنرێت.

### 6.3 بەخشینی کۆمیسیۆنی گواستنەوە لە داواکاری پێشوەخت
کۆمیسیۆنی گواستنەوەی زیادکراو بۆ هێڵی داواکاری پێشوەخت لەسەر ئەندامی PRO ناژمێردرێت. ئەم بەخشینە لە سوودەکانی کڕینە کە بە بەشی حەوتەم مەرجدارن.

### 6.4 بەخشینی گەیاندن لە سەرووی بەهای ڕاگەیەنراوی داواکارییەوە
فرۆشگا تێچووەکانی گەیاندن لەسەر ئەندامی PRO هەڵدەگرێت ئەگەر بەهای کاڵای داواکارییەکە کە بۆ ئەم مەبەستە ژمێردراوە لە بڕی {{PRO_FREE_DELIVERY_MIN_IQD}} دیناری عێراقی تێپەڕی. تێپەڕاندن مەرجێکی ڕاستەقینەیە: بڕی یەکسان بە سنوورەکە بەس نییە، بەڵکو دەبێت لێی زیاتر بێت.

### 6.5 فراوانیی بەخشینی PRO
بەخشینی PRO فراوانترە لە بەخشینی PREMIUM: ئەو تێچووانەی گەیاندن دادەپۆشێت کە لەسەر داواکارییەکە پیشان دەدرێن نەک تەنها کرێی ئاسایی، بەپێی ئەوەی سیاسەتی گەیاندن ڕوونی دەکاتەوە. ئەو باجەی کۆمپانیای گەیاندن وەک باجی وەرگرتنی نەقد لە بەردەرگا دەیسەپێنێت کرێی گەیاندن نییە و ئەم بەخشینە ناینگرێتەوە.

### 6.6 پێشینەیی خزمەتگوزاری
داواکاری و هەڵسەنگاندن و داواکارییەکانی ئەندامی PRO لە ڕیزدا لەسەر ئەوانیتر پێشدەخرێن لە چوارچێوەی ئەوەی ڕێکخستنی کار ڕێگەی پێدەدات، و ماوەی یەکەم وەڵامدانەوەی {{PRO_PRIORITY_RESPONSE_HOURS}} کاتژمێر ئامانج دەکرێت. پێشینەیی ڕیزبەندییە لە ڕیزدا و بەڵێنی ئەنجام یان گۆڕینی ناوەڕۆکی بڕیارێک نییە.

### 6.7 خزمەتگوزاریی تەواوکردن لە ماوەی دوازدە کاتژمێردا
بۆ ئەندامی PRO خزمەتگوزاریی تەواوکردنی داواکارییەکە لە ماوەی دوازدە کاتژمێر لە دروستکردنیەوە پێشکەش دەکرێت. خزمەتگوزارییەکی مەرجدارە، و تەنها کاتێک لەسەر داواکارییەکی دیاریکراو کار دەکات کە هەموو ئەمانە پێکەوە کۆببنەوە: ئەندامێتیی چالاکی PRO، گەیاندن بۆ ناونیشانی بنەڕەتیی پەسەندکراو، چالاککردنی خزمەتگوزارییەکە لەلایەن فرۆشگاوە، ئەوەی ڕێگەی گەیاندنی هەڵبژێردراو لەو ڕێگایانە بێت کە فرۆشگا خزمەتگوزارییەکەی گرتوونەتەوە، ئەوەی جۆری بارکردن لە جۆرە گرتراوەکان بێت، و ئەوەی پارێزگای ناونیشانەکە لە پارێزگا گرتراوەکان بێت.

### 6.8 ڕوونکردنەوەی هۆکاری جێبەجێنەبوونی خزمەتگوزاریی دوازدە کاتژمێر
ئەگەر مەرجێک لە مەرجەکانی ماددەی 6.7 پێک نەهات، خزمەتگوزارییەکە لەسەر داواکارییەکە جێبەجێ نابێت و هۆکارەکەی لە خودی داواکارییەکەدا ڕوون دەکرێتەوە. جێبەجێنەبوونی بە پێشێلکردنی ئەندامێتی دانانرێت.

### 6.9 پارەدانی دواخراو
پارەدانی دواخراو بۆ ئەندامی PRO بەردەستە بەپێی سنوور و بەروارەکانی کە لە سیاسەتی پارەدان و جزداندا ڕوون کراونەتەوە. ئاسانکارییەکە بە هەڵسەنگاندنی فرۆشگا بۆ شایستەیی هەژمارەکە مەرجدارە، و مافێکی ڕەها لە هەموو داواکارییەکدا نییە.

### 6.10 نیشانەی PRO
فرۆشگای ئەندامی PRO لە ناو کۆمەڵگەدا نیشانەیەکی پێدەدرێت کە ئاماژە بە پلەکەی دەدات. نیشانەکە تەنها ئاماژەیە بۆ ئەندامێتی، و نە پشتڕاستکردنەوەی ناسنامەیە و نە بڕوانامەیەکی فرۆشگایە لەسەر کوالیتی کاڵای بازرگانەکە یان پابەندبوونی.

### 6.11 زیادکەری خاڵ
خاڵەکانی ئەندامی PRO بە دووقات ئەوەی بۆ بەکارهێنەری ئاسایی دەژمێردرێت دەژمێردرێن، لە چوونەژوورەوەی ڕۆژانە، لە ئەرکەکان، لە کڕین، و لە هەڵسەنگاندنەکاندا. وردەکاری ژمێرکاری و خڕکردنەوە لە سیاسەتی خەڵات و خاڵدایە.

### 6.12 بەش و پێشکەشکراوە تایبەتەکانی PRO
ئەوەی فرۆشگا بۆ پلەکەی تەرخان دەکات لە بەش و پێشکەشکراو بۆ ئەندامی PRO بەردەستە، کاتێک فرۆشگا ڕایدەگەیەنێت و تا کاری پێدەکرێت.

### 6.13 دیاریی داواکاریی پێشوەختی پێشوەخت پارەدراو
ئەگەر فرۆشگا ئەم دیارییەی چالاک کرد و ئەو بەرهەمەی دیاری کرد کە لێی دەدرێت، ئەندامی PRO شایستەی دیارییەکی کاڵایی دەبێت لەگەڵ داواکارییە پێشوەختەکەیدا ئەگەر داواکارییەکە بە تەواوی پێش گەیاندن پارەی درابێت بەجۆرێک کە هیچی نەمێنێتەوە لە بەردەرگا وەربگیرێت، و داواکارییەکە لە چوارچێوەی کڕینی تایبەت بە PRO بەپێی بەشی حەوتەم نرخێنرابێت. دیارییەکە کاڵایە کە لەگەڵ داواکارییەکەدا دەنێردرێت و بەهاکەی لەسەر پسوولەکە سفرە، بۆیە لە نرخێک کەم ناکرێتەوە، بە پارە ناگۆڕدرێت و بە نەقد ناگەڕێندرێتەوە.

### 6.14 دیاریی مەرجدار لە دەرەوەی مەرجەکەی بەڵێنی پێ نادرێت
ئەگەر فرۆشگا دیارییەکەی چالاک نەکرد یان بەرهەمەکەی دیاری نەکرد، هیچ شایستەییەک تێیدا نییە. هیچ کارمەندێک یان بازرگانێک ناتوانێت بەڵێنی پێ بدات وەک ئەوەی خۆکار یان دڵنیاکراو بێت.

## 7. مەرجی ناونیشانی بنەڕەتیی پەسەندکراو بۆ سوودەکانی کڕین لە PRO

### 7.1 ڕێسا
سوودەکانی کڕینی تایبەت بە PRO — واتە نرخی PRO لەسەر کاڵا، بەخشینی کۆمیسیۆنی گواستنەوە لە داواکاری پێشوەخت، بەخشینی زیادەی فرۆشتنی ڕاستەوخۆ، بەخشینی تێچووەکانی گەیاندن، و پێشینەیی گەیاندن — تەنها لەسەر ئەو داواکارییە کار دەکەن کە بۆ یەک ناونیشانی دیاریکراو نرخێنراوە کە ناونیشانی بنەڕەتیی پەسەندکراوی هەژماری ئەندامەکەیە.

### 7.2 بۆچی ئەم مەرجە
چونکە سوودەکانی PRO بۆ یەک کەس لە شوێنێکی زانراودا دانراون، نەک بۆ ناونیشانێک کە لە هەموو داواکارییەکدا دەگۆڕێت. بەستنیان بە یەک ناونیشانی پەسەندکراوەوە ئەوەیە کە ڕێگر دەبێت لە گۆڕینیان بۆ ئامرازێکی کڕینی کۆمەڵ بۆ دووبارە فرۆشتنەوە لە ژێر ناوی یەک ئەندامدا.

### 7.3 ناونیشانی پەسەندکراو چۆن دەناسرێتەوە
ناونیشانی پەسەندکراو ئەو ناونیشانەیە کە بە دۆخی پەسەندکراو بۆ هەژماری ئەندامەکە لە سیستەمی فرۆشگادا تۆمارە. پێکهاتن لەسەر ناو و ناونیشان و ژمارەی مۆبایل دەپێورێت، تەنها بە تێپەڕاندنی جیاوازی بۆشایی و دۆخی پیت و شێوازەکانی نووسینی ژمارە.

### 7.4 نرخاندن لە دەرەوەی ناونیشانی پەسەندکراو
ئەگەر داواکارییەکە بۆ ناونیشانێکی جگە لە ناونیشانی پەسەندکراو نرخێنرابوو، بە تەواوی بە شێوەی ئاسایی نرخێنرا: بە نرخی گشت خەڵک، بە کۆمیسیۆنی گواستنەوە، بە زیادەی فرۆشتنی ڕاستەوخۆ، بە کرێی گەیاندن، و بەبێ پێشینەیی گەیاندن.

### 7.5 ئەندام پێش هەڵبژاردنی ناونیشان چی دەبینێت
لە لاپەڕەی بەرهەم و لە سەبەتەدا، پێش ئەوەی ئەندام ناونیشانێک هەڵبژێرێت، نرخەکە بە ناونیشانی بنەڕەتیی خۆی بڕیاری لەسەر دەدرێت. ئەوەی ناونیشانی بنەڕەتیی پەسەندکراو نییە نرخی ئاسایی لە هەموو ئەم شاشانەدا دەبینێت، تا نرخێک نەبینێت کە لە بەردەرگا جێبەجێ نابێت.

### 7.6 پەسەندکردنی ناونیشان و گۆڕینی
پەسەندکردنی ناونیشان و پێداچوونەوە و گۆڕینی لە دەسەڵاتی فرۆشگادایە بەپێی ڕێکاری بەڕێوەبردنی ئەندامێتیی PRO. ناونیشانێک تەنها بە زیادکردنی بۆ هەژمارەکە پەسەند ناکرێت.

### 7.7 ئەوەی بەم مەرجە لەناو ناچێت
ئەوەی لە سوودەکانی کڕین نییە بەم مەرجە لەناو ناچێت: زیادکەری خاڵ، نیشانەی PRO، پێشینەیی خزمەتگوزاری، پارەدانی دواخراو، و بەش و پێشکەشکراوە تایبەتەکان بە هەبوونی ئەندامێتییەکە دەمێننەوە، ناونیشانی داواکارییەکە هەرچییەک بێت.

## 8. کڕین و بەرزکردنەوە و پارەدان

### 8.1 کێ دەکڕێت
ئەندامێتی تەنها لە ناو هەژمارێکی پشتڕاستکراوەوە دەکڕدرێت، و تەنها بە ناوی خاوەنی هەژمارەکە تۆمار دەکرێت.

### 8.2 کورتەکە پێش پەسەندکردن
پێش پەسەندکردن کورتەیەک بۆ کڕیار پیشان دەدرێت کە پلانەکە و پلەکەی و ماوەکەی و نرخەکەی ڕوون دەکاتەوە، بەهای ئەوەی لە باڵانسی ئەندامێتییە هەبووەکەی بۆی دەژمێردرێت ئەگەر هەبوو، ئەو بڕەی بەکردەوە کەم دەکرێتەوە، باڵانسی بەردەستی، و بەرواری چاوەڕوانکراوی کۆتاییهاتن یان ئەوەی ئەندامێتییەکە تا دەستپێکردن حیجز دەکرێت.

### 8.3 پەسەندکردن ئەوەیە کە پابەند دەکات
هیچ بڕێک کەم ناکرێتەوە و هیچ ئەندامێتییەک دروست ناکرێت پێش پەسەندکردنی کڕیار بۆ کورتەکە. ئەگەر ئەو بڕەی لە کاتی پەسەندکردندا دووبارە ژمێردرایەوە لەگەڵ بڕە پیشاندراوەکە جیاواز بوو، تەواوکردن ڕەت دەکرێتەوە و کورتەکە بە ژمارە نوێیەکانەوە دووبارە پیشان دەدرێت.

### 8.4 کەمکردنەوە لە جزدان
بەرامبەری ئەندامێتی لە باڵانسی بەردەستی جزدان کەم دەکرێتەوە. باڵانسی بەردەست ئەوەیە کە دوای لابردنی ئەوەی بۆ کردارەکانی تر حیجز کراوە یەکلایی کراوەتەوە، وەک سیاسەتی پارەدان و جزدان ڕوونی دەکاتەوە.

### 8.5 نەبوونی باڵانسی پێویست
ئەگەر باڵانسی بەردەست بەس نەکرد، کڕینەکە ڕەت دەکرێتەوە و هیچ تۆمارێکی ئەندامێتی دروست ناکرێت و هیچ کەم ناکرێتەوە. هیچ ئەندامێتییەکی بەشەکی و هیچ ئەندامێتییەک بە قەرز دروست ناکرێت.

### 8.6 کلیکی دووجارە و دووبارەبوونەوە
هەر کردارێکی کڕین کلیلێکی هەیە کە دووبارە نابێتەوە. ئەگەر داواکارییەکە بە هۆکارێکی تەکنیکی دوو جار نێردرا، یەک کەمکردنەوە و یەک ئەندامێتی جێبەجێ دەکرێت، و دووەمیان بە دووبارەبوونەوەی یەکەمیان دادەنرێت نەک کڕینێکی نوێ.

### 8.7 کڕینی ئەندامێتی لە هەمان پلە
ئەندامێتی لە هەمان پلە ناکڕدرێت تا یەکەمیان هەیە. دوای کۆتاییهاتنی دووبارە دەکڕدرێت.

### 8.8 دابەزین بۆ پلەیەکی نزمتر
کڕین بۆ دابەزین بۆ پلەیەکی نزمتر لە پلەی هەبوو ناکرێت. ئەوەی بیەوێت دەبێت چاوەڕێی کۆتاییهاتنی ئەندامێتییەکەی بکات و پاشان ئەوەی دەیەوێت بکڕێت.

### 8.9 بەرزکردنەوە بۆ پلەیەکی بەرزتر
بەرزکردنەوە لە پلەیەکی نزمەوە بۆ بەرزتر لە هەر کاتێکدا ڕێپێدراوە. بەهای ئەوەی لە ئەندامێتییە هەبووەکەی ماوەتەوە بۆ ئەندام دەژمێردرێت وەک کەمکردنەوە لە نرخی پلە نوێیەکە، ئەندامێتییە کۆنەکە لە هەمان ساتدا کۆتایی پێدێت، و نوێیەکە بە ماوەکەی تەواوی دەست پێدەکات.

### 8.10 باڵانسی بەرزکردنەوە چۆن دەژمێردرێت
باڵانسی بەرزکردنەوە لەسەر بنەمای بەهای پلانە هەبووەکە دابەشکراو بەسەر ڕۆژەکانی ماوەکەیدا دەژمێردرێت، لە ڕۆژە ماوەکانی زەرب کراوە، و کەسرەکە بۆ وردی بۆ خوارەوە خڕ دەکرێتەوە. باڵانسی ژمێردراو بە هیچ شێوەیەک لە نرخی پلە نوێیەکە زیاتر نابێت، چونکە بەرزکردنەوە قەرزێک بۆ کڕیار لەسەر فرۆشگا دروست ناکات و پارەی نەقدی بۆ ناگەڕێنێتەوە.

### 8.11 بەرزکردنەوەی ئەندامێتییەکی حیجزکراو کە دەستی پێنەکردووە
ئەگەر ئەندامێتییە هەبووەکە حیجزکراوی پارەدراو بوو و ماوەکەی هێشتا دەستی پێنەکردبوو، بەهاکەی بە تەواوی وەک کەمکردنەوە لە نرخی پلە نوێیەکە ژمێردرا، چونکە هیچی لێ خەرج نەکراوە.

### 8.12 ئەندامێتیی بەخشراو لە بەرزکردنەوەدا ناژمێردرێت
ئەو ئەندامێتییەی بەبێ بەرامبەر بە کڕیار دراوە لە بەرزکردنەوەدا بە بەهای سفر مامەڵەی لەگەڵ دەکرێت، بۆیە لە نرخی پلە نوێیەکە کەم ناکرێتەوە، چونکە بەرزکردنەوە لەسەر ئەوە دەژمێردرێت کە کڕیار داویەتی نەک لەسەر ئەوەی فرۆشگا پێی بەخشیوە.

## 9. دەستپێکردن و ماوە و کۆتاییهاتن و نوێکردنەوە

### 9.1 دەستپێکردنی ئەندامێتی دوای دەستپێکردنی سیستەم
دوای ڕاگەیاندنی دەستپێکردن، ئەندامێتی لە ساتی تەواوبوونی کڕینەکەوە دەست پێدەکات، و کاتەکەی بە تێپەڕینی ماوەکەی بە مانگی ڕۆژژمێری کۆتایی دێت.

### 9.2 ئەندامێتیی حیجزکراو پێش دەستپێکردنی سیستەم
ئەوەی پێش ڕاگەیاندنی دەستپێکردن کڕیویەتی، ئەندامێتییەکەی بە ماوەکەی تەواوی بۆ حیجز کراوە و ماوەکەی هێشتا دەستی پێنەکردووە. حیجزکردن پابەندبوونی فرۆشگایە بە ماوەکەی تەواو، و بە درێژیی چاوەڕوانی کەم نابێتەوە.

### 9.3 دەستپێکردنی ماوە لە کاتی دەستپێکردنی سیستەمدا
ماوەی ئەندامێتیی حیجزکراو بە ڕاگەیاندنی فرۆشگا بۆ چالاککردنی دەستپێکردن دەست پێدەکات، کە بڕیارێکی ڕاگەیەنراو و تۆمارکراوە، و تەنها بە تێپەڕینی کات ڕوونادات.

### 9.4 کۆتاییهاتنی ماوە
ئەندامێتی بە تێپەڕینی ماوەکەی لە خۆیەوە کۆتایی دێت، و کۆتاییهاتنەکەی لە سیستەمدا تۆمار دەکرێت. کۆتاییهاتنەکەی پێویستی بە ئاگادارکردنەوە و بە داواکاری نییە.

### 9.5 نوێکردنەوەی خۆکار نییە
ئەندامێتی خۆکارانە نوێ نابێتەوە، فرۆشگا هیچ ئامرازێکی پارەدان هەڵناگرێت کە دوای کۆتاییهاتنی ماوەکە لێی کەم بکاتەوە، و لە جزدانی کڕیار بەرامبەری نوێکردنەوەیەک کە داوای نەکردووە کەم ناکرێتەوە. ئەوەی بیەوێت بەردەوام بێت خۆی پلانێکی نوێ دەکڕێت.

### 9.6 کڕین دوای کۆتاییهاتن
دوای کۆتاییهاتنی ئەندامێتی دووبارە کڕین ڕێپێدراوە، بە هەمان پلە یان بە پلەیەکی تر. ئەندامێتییە نوێیەکە ئەندامێتییەکی سەربەخۆیە بە ماوە و نرخی خۆی، و ئەوەی تێپەڕیوە بۆ ئەوەی دێت زیاد ناکرێت.

### 9.7 کاریگەریی کۆتاییهاتن لەسەر سوودەکان
بە کۆتاییهاتنی ئەندامێتی هەموو سوودەکان لە بەرواری کۆتاییهاتنەوە بەرەو پێش دەوەستن: نرخ دەگەڕێتەوە بۆ نرخی گشت خەڵک، کرێی گەیاندن دەگەڕێتەوە سەر کڕیار، زیادکەری خاڵ دەگەڕێتەوە بۆ ئاستی ئاسایی، و پێشینەیی و نیشانە و پارەدانی دواخراوی نوێ لەناو دەچن.

### 9.8 ئەوەی بە کۆتاییهاتن لەناو ناچێت
ئەوەی پێش کۆتاییهاتن بۆ کڕیار جێگیر بووە بە کۆتاییهاتنی ئەندامێتی لەناو ناچێت، و وردەکاری ئەوە لە بەشی یازدەیەمدایە.

### 9.9 ئاگادارکردنەوە لە نزیکبوونەوەی کۆتاییهاتن
ئەگەر فرۆشگا ئاگادارکردنەوەیەکی نزیکبوونەوەی کۆتاییهاتنی نارد، بیرخستنەوەیەکە لە ڕووی خزمەتگوزارییەوە. نەگەیشتنی ماوەکە درێژ ناکاتەوە و هیچ مافێکی درێژکردنەوە دروست ناکات.

## 10. هەڵوەشاندنەوە و گەڕاندنەوەی پارە

### 10.1 هەڵوەشاندنەوە دوگمەیەک نییە لە هەژماردا
لە پلاتفۆرمدا هەڵوەشاندنەوەی خۆکاری ئەندامێتی نییە. ئەوەی بیەوێت ئەندامێتییەکەی هەڵبوەشێنێتەوە داواکارییەک بۆ پشتگیری لە ڕێگەی {{LEVONIS_SUPPORT_CONTACT}} پێشکەش دەکات، و داواکارییەکەی بەپێی ئەم بەشە سەیر دەکرێت.

### 10.2 کێ دەتوانێت هەڵیوەشێنێتەوە
ئەندامێتی تەنها بە بڕیارێکی تۆمارکراوی بەڕێوەبەرایەتی فرۆشگا هەڵدەوەشێنرێتەوە، کە تێیدا دەپارێزرێت کێ دەریکردووە و کەی و بۆچی.

### 10.3 چی دەکرێت هەڵبوەشێنرێتەوە
ئەندامێتیی چالاک، ئەندامێتیی حیجزکراو کە دەستی پێنەکردووە، و ئەندامێتییەک کە پارەدانەکەی تەواو نەبووە دەکرێت هەڵبوەشێنرێنەوە. ئەندامێتییەک کە ماوەکەی کۆتایی هاتووە هەڵناوەشێنرێتەوە، چونکە لە خۆیەوە تەواو بووە.

### 10.4 کاریگەریی هەڵوەشاندنەوە
بە هەڵوەشاندنەوە سوودەکان لە بەرواریەوە بەرەو پێش دەوەستن، و ئەندامێتییەکە وەک هەڵوەشێنراوە تۆمار دەکرێت. دوای ئەوە هەژمارەکە لە ئەندامێتیی هەبوو بەتاڵ دەبێت، بۆیە دەتوانێت دووبارە بکڕێت.

### 10.5 گەڕاندنەوەی پارە
گەڕاندنەوەی پارە بڕیارێکی سەربەخۆیە لە هەڵوەشاندنەوە و ئەنجامێکی حەتمیی نییە. ئەگەر فرۆشگا بڕیاری گەڕاندنەوەی دا، ئەو بڕەی لەسەر ئەندامێتییەکە تۆمار کراوە بۆ جزدانی کڕیار دەگەڕێندرێتەوە بەو دراوەی پێی کەم کرابووەوە، و دوو جار ناگەڕێندرێتەوە تەنانەت ئەگەر هەڵوەشاندنەوەکە دووبارە جێبەجێ کرایەوە. ئەگەر ڕێککەوتن لەسەر گەڕاندنەوەی بەشێکی لە بەرامبەر ماوەی خەرجکراو کرا، ئەوە بە نووسراوی لە خودی بڕیاری هەڵوەشاندنەوەکەدا دەچەسپێنرێت و پێی تۆمار دەکرێت.

### 10.6 ئاڕاستەی گەڕاندنەوە
ئاڕاستەی گەڕاندنەوە جزدانی کڕیارە لە ناو پلاتفۆرمدا. بەرامبەری ئەندامێتی بە نەقد لە بەردەرگا و بۆ ئامرازێکی پارەدانی دەرەکی ناگەڕێندرێتەوە، و دوای ئەوە باڵانسەکە بەپێی سیاسەتی پارەدان و جزدان بەکاردێت.

### 10.7 هەڵوەشاندنەوە بەهۆی پێشێلکاری
ئەگەر هەڵوەشاندنەوەکە بەهۆی پێشێلکردنی ئەندام بۆ ئەم بەڵگەنامەیە یان بۆ مەرجە گشتییەکان بوو، فرۆشگا دەتوانێت هیچ نەگەڕێنێتەوە، و هۆکارەکە لە بڕیاری هەڵوەشاندنەوەدا ڕوون دەکرێتەوە.

### 10.8 کاریگەریی هەڵوەشاندنەوە لەسەر خەڵاتی ناردنی داوەتنامە کە لە ئەندامێتییەکەوە سەرچاوەی گرتووە
ئەگەر ئەندامێتیی PRO خەڵاتێکی داوەتنامەی بۆ ئەو کەسە دروست کردبوو کە ئەندامەکەی بانگهێشت کردووە، ئەو خەڵاتە بە هەڵوەشاندنەوەی ئەندامێتییەکە هەڵدەوەشێتەوە، چونکە هۆکارەکەی ئەو پارەدانەیە کە لەناوچووە.

### 10.9 ئەوەی ناگەڕێندرێتەوە
بەرامبەری ئەندامێتی بۆ ئەو ماوەیەی ئەندام بەکردەوە سوودی لێ وەرگرتووە ناگەڕێندرێتەوە، سوودێک کە بەکاری نەهێناوە قەرەبوو ناکرێتەوە، و بەرامبەری ئەندامێتی بۆ نرخی کاڵا یان بۆ خاڵ ناگۆڕدرێت.

## 11. کاریگەریی کۆتاییهاتنی ئەندامێتی لەسەر ئەوەی ئەندام پێشتر شایستەی بووە

### 11.1 ڕێسا
ئەو سوودەی بۆ ئەندام لەسەر داواکارییەکی پارەدراو یان لەسەر خەڵاتێکی شایستە پێش کۆتاییهاتن یان هەڵوەشاندنەوەی ئەندامێتییەکەی جێگیر بووە، دوای ئەوە لێی وەرناگیرێتەوە. کۆتاییهاتن بۆ داهاتوو کار دەکات نەک بۆ ڕابردوو.

### 11.2 وێنەگرتنی ئەندامێتی لەسەر داواکارییەکە
لەگەڵ هەر داواکارییەکدا تۆمارێکی بەستراوی پلەی ئەندامێتی و دۆخەکەی لە کاتی تەواوکردنی داواکارییەکەدا هەڵدەگیرێت، و ئەوەی کاریگەریی لەسەر نرخ و گەیاندن و باج داناوە. ئەم تۆمارە سەرچاوەیە لە هەر پێداچوونەوەیەکی دواتر لەسەر داواکارییەکە.

### 11.3 ئەو نرخەی دراوە
ئەو نرخەی بە سوودی ئەندامێتی دراوە نرخێکی کۆتاییە. دوای کۆتاییهاتنی ئەندامێتییەکەی داوای جیاوازی لە کڕیار ناکرێت، تەنانەت ئەگەر داواکارییەکە دوای کۆتاییهاتن جێبەجێ یان گەیەنرا.

### 11.4 بەخشینی گەیاندنی شایستە
ئەو بەخشینی گەیاندنەی لەسەر داواکارییەکی پەسەندکراو جێگیر بووە بە کۆتاییهاتنی ئەندامێتی دوای پەسەندکردنی هەڵناوەشێتەوە، و کۆمپانیای گەیاندن داوای ئەو کرێیە لە کڕیار ناکات کە فرۆشگا هەڵیگرتووە.

### 11.5 ئەو خاڵانەی بە زیادکەر دراون
ئەو خاڵانەی بە زیادکەری ئەندامێتی ژمێردراون بە بڕە ژمێردراوەکەیان بۆ کڕیار دەمێننەوە. ئەگەر بەشێک لە داواکارییەکە دوای کۆتاییهاتنی ئەندامێتی گەڕێندرایەوە، خاڵەکان بەو زیادکەرە دووبارە دەژمێردرێنەوە کە لە کاتی کڕیندا لەسەر داواکارییەکە چەسپێنراوە نەک بە زیادکەری ئەمڕۆ، بۆیە لە کڕیار زیاتر لەوەی شایستەی بووە وەرناگیرێتەوە.

### 11.6 دیاری و خەڵاتە جێگیرەکان
ئەو دیارییەی لەسەر داواکارییەکی پارەدراو جێگیر بووە، و ئەو خەڵاتەی گەیشتووەتە قۆناغی حیجزکردن یان گەیاندن، بە کۆتاییهاتنی ئەندامێتی وەرناگیرێنەوە. ئەوەیان کە نەگەیشتووەتە قۆناغی شایستەیی بە مەرجی خۆی ڕێک دەخرێت.

### 11.7 گەرەنتی و دوای فرۆشتن
ئەندامێتی هیچ پەیوەندییەکی بە گەرەنتییەوە نییە. ماوەی گەرەنتی و فراوانیی وەک ئەو ڕۆژەی کڕین دەمێننەوە، و کۆتاییهاتنی ئەندامێتی کورتیان ناکاتەوە و داواکارییەکی هەبوو لەناو نابات. ئەوەی لەناو دەچێت تەنها پێشینەیی ڕیزە.

### 11.8 پارەدانی دواخراوی هەبوو
ئەگەر بڕێکی دواخراو لەسەر ئەندام بوو، دانەوەی دوای کۆتاییهاتن یان هەڵوەشاندنەوەی ئەندامێتییەکەی پێویست دەمێنێتەوە، و ڕێگەی دانەوەکەی بۆ بەردەست دەمێنێتەوە، چونکە ئەرکەکە پێش کۆتاییهاتن دروست بووە.

## 12. ئەندامێتیی بەخشراو و دیارییە مەرجدارەکان

### 12.1 ئەندامێتیی PLUS ی بەخشراو لەگەڵ کڕینی چاپگەر
ئەگەر فرۆشگا ئەم تایبەتمەندییەی چالاک کرد و ئەو پلانەی PLUS ی دیاری کرد کە دەبەخشرێت، ئەوەی چاپگەرێکی شایستە بکڕێت ئەندامێتیی PLUS ی بەبێ بەرامبەر پێدەدرێت.

### 12.2 مەرجی ئەوەی هەژمارەکە ئەندامێتیی هەبووی نەبێت
ئەندامێتیی بەخشراو بە هەژمارێک نادرێت کە ئەندامێتییەکی هەبووی هەیە، جا چالاک بێت یان حیجزکراو، چونکە هەژمار زیاتر لە یەک ئەندامێتی هەڵناگرێت. نەبەخشینەکە لە تۆماری فرۆشگادا تۆمار دەکرێت تا لە کاتی پێویستدا بە دەست سەیر بکرێت.

### 12.3 بەهای ئەندامێتیی بەخشراو لە بەرزکردنەوەدا
ئەندامێتیی بەخشراو لە ژمێرکاری باڵانسی بەرزکردنەوەدا بەهاکەی سفرە، بەپێی ماددەی 8.12.

### 12.4 دیارییە مەرجدارەکان بە گشتی
هەر دیاری یان سوودێکی زیادە کە بەندە بە چالاککردنی فرۆشگا بۆی و بە دیاریکردنی ئەوەی لێی دەدرێت، پێش کۆبوونەوەی مەرجەکەی شایستە نابێت. دەرکەوتنی ناوی لە لاپەڕەیەک یان لە ڕیکلامێکی کۆندا هیچ شایستەییەک دروست ناکات.

### 12.5 دیاری کاڵایە نەک پارە
دیاری وەک کاڵا بە بەهای سفر لەسەر پسوولەکە دەدرێت. بە پارە و بە خاڵ و بە داشکاندن ناگۆڕدرێت، و لە کاتی گەڕاندنەوەدا بە نەقد ناگەڕێندرێتەوە.

### 12.6 تەواوبوونی کۆگا
ئەگەر ئەوەی دیارییەکەی لێ دەدرێت تەواو بوو، کڕیار ئاگادار دەکرێتەوە و شایستەییەکەی پارێزراو دەمێنێتەوە تا بەردەست دەبێت یان تا ڕێککەوتن لەسەر جێگرەوەیەک دەکرێت. بە هیچ شێوەیەک ناگۆڕدرێت بۆ پارە.

## 13. خراپبەکارهێنان و سنووردارکردنی سوودەکان

### 13.1 مەبەستی ئەم بەشە
سوودەکانی ئەندامێتی بۆ بەکارهێنانێکی کەسیی ئاقڵانە دانراون. ئەم بەشە ڕوون دەکاتەوە چی بە خراپبەکارهێنان دادەنرێت و چی لێی دەکەوێتەوە.

### 13.2 شێوەکانی خراپبەکارهێنان
- بەکارهێنانی سوودەکانی ئەندامێتی بۆ کڕین بە مەبەستی دووبارە فرۆشتنەوە یان بۆ دابینکردن بۆ کەسانی تر.
- ڕێگەدان بە کەسێکی جگە لە خاوەنی هەژمار بۆ سوودەکانی ئەندامێتییەکەی.
- کردنەوەی چەند هەژمارێک بۆ یەک کەس بۆ دووبارەکردنەوەی سوودێک یان تێپەڕاندنی سنوورێک.
- دووبارەکردنەوەی ڕەتکردنەوەی وەرگرتن یان دووبارەکردنەوەی هەڵوەشاندنەوە بەشێوەیەک کە تێچوو بەبێ بەرامبەر بخاتە سەر فرۆشگا.
- پێشکەشکردنی زانیاریی نادروست بۆ پەسەندکردنی ناونیشانێک یان بۆ بەدەستهێنانی سوودێک.
- بەکارهێنانی ئەندامێتی لە چالاکییەکی قەدەغەکراو لە مەرجە گشتییەکاندا.

### 13.3 سنووردارکردنی سوودەکان
فرۆشگا دەتوانێت یەک سوود یان زیاتر لەسەر هەژمارێکی دیاریکراو ڕابگرێت بە بڕیارێکی هۆکارداری تۆمارکراو، لەگەڵ مانەوەی ئەندامێتییەکە. ئەمە بە سنووردارکردنی سوودەکان ناو دەبرێت نەک بە هەڵوەشاندنەوەی ئەندامێتی.

### 13.4 ئەوەی سنووردارکردن دەستی بۆ نابات
سنووردارکردنی سوودەکان دەست نابات بۆ چوونەژوورەوەی کڕیار بۆ هەژمارەکەی، نە بۆ گەیشتنی بە داتا و داواکارییەکانی، نە بۆ مافی پشتگیری، نە بۆ مافی گەرەنتی، نە بۆ ئەرکی دانەوەی ئەوەی لەسەریەتی و توانای دانەوەی. سنووردارکردن تەنها لەسەر ژمێرکاری سوودەکە دەکەوێت.

### 13.5 کاریگەریی سنووردارکردن لەسەر نرخاندن
ئەگەر سنووردارکردنەکە سوودەکانی کڕینی تایبەت بە PRO ی گرتەوە، داواکارییەکانی ئەندام بە ماوەی سنووردارکردنەکە بە شێوەی ئاسایی نرخێنران، پاشان بە نەمانی دەگەڕێنەوە بۆ ئەوەی بوون.

### 13.6 ئاگادارکردنەوە
خاوەنی هەژمار بە هەبوونی سنووردارکردنەکە و بە هۆکارەکەی بە شێوەیەکی گشتی ئاگادار دەکرێتەوە، مەگەر لە وردەکاریی هۆکارەکەدا زیان بە ئاسایشی پلاتفۆرم بێت یان شێوازی دۆزینەوەی پێشێلکارییەکە ئاشکرا بکات.

### 13.7 ناڕەزایی
خاوەنی هەژمار دەتوانێت لە بڕیاری سنووردارکردن ناڕەزایی دەرببڕێت لە ماوەی {{ACCOUNT_APPEAL_DAYS}} ڕۆژ لە ئاگادارکردنەوەیەوە، و لە ماوەی {{DISPUTE_RESPONSE_DAYS}} ڕۆژ بڕیاری لەسەر دەدرێت.

### 13.8 وەرگرتنەوەی ئەوەی بە ناڕەوا وەرگیراوە
فرۆشگا دەتوانێت ئەوە وەربگرێتەوە کە لە نرخ کەم کراوەتەوە یان لە کرێ بەخشراوە یان وەک خاڵ دراوە لەسەر بنەمای خراپبەکارهێنانێکی سەلمێنراو، و وەک قەرز لەسەر هەژمارەکە تۆماری بکات یان لە جزدانەکەی کەمی بکاتەوە.

### 13.9 هەڵوەشاندنەوە لەگەڵ خراپبەکارهێنانی گەورە
ئەگەر خراپبەکارهێنانەکە گەیشتە ئاستێکی گەورە یان دوای ئاگادارکردنەوە دووبارە بووەوە، هەڵوەشاندنەوەی ئەندامێتییەکە بەپێی ماددەی 10.7 ڕێپێدراوە.

### 13.10 مافەکانی تری فرۆشگا
ئەوەی لەم بەشەدایە ڕێگر نییە لە فرۆشگا کە بۆ ئەو زیانەی پێی گەیشتووە بگەڕێتەوە، نە لە گرتنەبەری ئەو ڕێوشوێنەی بە باشی دەزانێت بەپێی مەرجە گشتییەکان و یاسای جێبەجێکراو.

## 14. حوکمە کۆتاییەکان

### 14.1 گۆڕینی ئەم بەڵگەنامەیە
فرۆشگا دەتوانێت ئەم بەڵگەنامەیە بگۆڕێت. گۆڕانکارییەکە بە وەشانێکی نوێ و بەرواری کارپێکردنی نوێ بڵاو دەکرێتەوە، و لەسەر ئەوەی دوای کارپێکردنی ڕوودەدات جێبەجێ دەبێت. گۆڕانکاریی دواتر لە سوودێک کەم ناکاتەوە کە بۆ ئەندامێتییەکی هەبوو پێش کارپێکردنی جێگیر بووە.

### 14.2 بەڵگەیی وەشانی تۆمارکراو
ئەو وەشانەی لە تۆماری فرۆشگادا لەگەڵ پەسەندکردنی ئەندامەکە هەڵگیراوە بەڵگەیە لە کاتی ناکۆکیدا لەسەر ناوەڕۆکی ئەوەی پەسەندی کردووە.

### 14.3 سەربەخۆیی بڕگەکان
ئەگەر بڕگەیەک لەم بەڵگەنامەیە پووچ بووەوە یان جێبەجێکردنی مەحاڵ بوو، بڕگەکانی تر بە هەموویانەوە کاریان پێدەکرێت.

### 14.4 چارەسەری ناکۆکییەکان
ناکۆکییەکە سەرەتا بۆ پشتگیری لە ڕێگەی {{LEVONIS_SUPPORT_CONTACT}} پێشکەش دەکرێت، و لە ماوەی {{DISPUTE_RESPONSE_DAYS}} ڕۆژ وەڵام دەدرێتەوە.

### 14.5 یاسای جێبەجێکراو و دەسەڵاتی دادوەری
لەسەر ئەم بەڵگەنامەیە یاسای {{GOVERNING_LAW_JURISDICTION}} جێبەجێ دەبێت، و {{COMPETENT_COURT}} دەسەڵاتی سەیرکردنی ئەوەی لێیەوە سەرچاوە دەگرێت هەیە.

### 14.6 خاڵی پەیوەندی
خاڵی پەیوەندیی پەسەندکراو: {{LEVONIS_SUPPORT_CONTACT}}، و کاتەکانی کار: {{LEVONIS_SUPPORT_HOURS}}.`,
  },
};
