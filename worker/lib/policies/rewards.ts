import type { PolicyDocument } from './types';

/**
 * سياسة النقاط والمراجعات والهدايا والإحالات — the four reward mechanisms the
 * shop actually runs, written so a customer who lost a point can be shown WHY.
 *
 * THE ONE SENTENCE THIS DOCUMENT EXISTS TO PROTECT (chapters 7 and 8):
 * REVIEW POINTS ARE AUTOMATIC, THE REVIEW GIFT IS NOT. worker/routes/reviews.ts
 * awards the doubled review points INSIDE the submission batch, with no human
 * in the loop, for every valid manual review that does NOT reach a gift tier —
 * and awards nothing automatically for one that does, because that review goes
 * into `review_rewards` as `submitted` and waits for an admin decision that may
 * be approve, reject or request-changes. The product page already tells the
 * customer exactly this ('تُنشر مراجعتك فورًا، ثم تُراجع المكافأة بشكل منفصل').
 * A document promising an automatic gift would put the shop in writing against
 * its own screen, so articles 7.5 and 8.2 state the split from both ends.
 *
 * WHAT THE CODE FIXES, AND THE ARTICLE THAT SAYS SO:
 *  - worker/lib/pointsOps.ts: one point per full `iqd_per_point` of NET
 *    ELIGIBLE MERCHANDISE, summed first and floored ONCE on the order total;
 *    delivery, transport commission and warranty fees are not merchandise —
 *    articles 2.2 to 2.8. Redemption is a different rate, 1 point = 1 IQD
 *    exactly, never rounded to a hundred — article 4.2.
 *  - `available_at = purchase_at + 7×24h`, fixed at creation and never moved;
 *    release needs BOTH that instant AND a settled payment, which for a COD
 *    order is a RECORDED collection — articles 3.3 to 3.6. PENDING points are
 *    deliberately not in the wallet ledger, which is why article 3.7 can say
 *    they are not spendable as a fact of construction rather than a promise.
 *  - `recomputeReversal` recomputes from the REMAINING eligible amount at the
 *    order's FROZEN multiplier and writes negative entries; history is never
 *    erased — articles 11.2 to 11.5.
 *  - worker/lib/pointsMultiplier.ts: PREMIUM ×1.5, PRO ×2, everyone else ×1,
 *    ROUNDED HALF UP. Article 6.7 states the rounding out loud, because a
 *    five-point check-in paying eight at ×1.5 is exactly the line a customer
 *    opens a ticket about.
 *  - worker/lib/pointsTasks.ts: every mission value is a server constant, the
 *    day is the server's Baghdad day, elapsed time is re-checked in SQL. The
 *    module also DECLARES what it cannot prove (`verification`), so articles
 *    5.8 and 5.9 say out loud that three of the four tasks rest on the
 *    browser's word and may be switched off — a reward the owner can disable
 *    must not read as a permanent entitlement.
 *  - worker/lib/reviewAutoSweep.ts writes the seven-day system rating with no
 *    reward row and no ledger entry at all — chapter 9, so nobody argues that
 *    a rating they did not write owes them points.
 *  - worker/lib/membershipOps.ts runs THREE separate referral mechanisms with
 *    different clocks and different conditions; chapter 10 keeps them apart
 *    rather than merging them into one paragraph that would be wrong for two.
 *
 * NO EXPIRY IS INVENTED. There is no expiry column, no sweep and no job that
 * ages a point out anywhere in this codebase, so article 12.1 states plainly
 * that points do not lapse with time and article 12.2 lists the only three
 * ways a point actually leaves a balance. Writing a twelve-month expiry here
 * because other shops have one would be a term the software cannot enforce.
 *
 * PLACEHOLDERS. The per-review point value is an owner setting
 * (`reviewPointsConfig`) with NO default in code — the route returns an honest
 * 503 when it is unset — so article 7.6 carries {{REVIEW_BASE_POINTS}} rather
 * than a number. The earning rate DOES have a code default and is stated.
 *
 * VERSION 2 — WHY IT MOVED. Two corrections a customer could see on the
 * page; the archive keeps version 1 byte for byte.
 *   * THE NAME. The store is written «Levonis», in Latin script, in all three
 *     languages. 8 transliterated occurrences left the body here. Where the
 *     name carried an Arabic or Sorani affix the affix was detached rather than
 *     swallowed by the replacement, so the sentence still parses.
 *   * THE UNKNOWNS. 5 articles and 5 further lines in this document still state a
 *     fact the owner has not given, so ./render.ts WITHHOLDS them from the published
 *     text rather than show a customer a `{{TOKEN}}`. They are still authored
 *     below, and each one returns of its own accord the moment its value is
 *     written in and the version moves again.
 */
export const rewards: PolicyDocument = {
  key: 'rewards',
  version: 2,
  effective_at: '2026-01-01',
  title: {
    ar: 'سياسة النقاط والمراجعات والهدايا والإحالات',
    en: 'Points, Reviews, Gifts and Referrals Policy',
    ckb: 'سیاسەتی خاڵ و پێداچوونەوە و دیاری و ناردن',
  },
  body: {
    ar: `## 1. التمهيد والنطاق والتعريفات

### 1.1 الغرض من هذه الوثيقة
تبيّن هذه الوثيقة كيف تُكتسب نقاط Levonis وبأي معدل، ومتى تصير قابلة للإنفاق ولماذا لا تُنفق قبل ذلك، وعلامَ تُصرف وعلامَ لا تُصرف، وكيف تُحتسب مكافأة المراجعة وكيف يُقرَّر في هدية المراجعة، وكيف تعمل الإحالة وما هي محطاتها، وحق المتجر في عكس نقاط طلب أُلغي أو مراجعة مفتعلة.

### 1.2 الأطراف
المتجر: {{LEVONIS_LEGAL_NAME}}، المسجل برقم {{LEVONIS_REGISTRATION_NO}}، وعنوانه {{LEVONIS_ADDRESS}}، ويشار إليه بـ Levonis. والزبون: صاحب الحساب المسجل في المنصة.

### 1.3 التعريفات
- النقطة: وحدة حسابية داخلية يقيدها المتجر في رصيد النقاط لصاحب الحساب. وليست عملة ولا وديعة ولا التزاماً نقدياً.
- رصيد النقاط: مجموع النقاط المستقرة في سجل المحفظة لصاحب الحساب.
- النقطة المعلّقة: نقطة نشأت عن شراء ولم تستقر بعد، فهي مسجلة في سجل الاستحقاق ولا وجود لها في سجل المحفظة.
- النقطة المستقرة: نقطة أُطلقت إلى سجل المحفظة بعد تحقق شرطي المدة والتسوية، وهي وحدها القابلة للإنفاق.
- البضاعة المؤهلة: قيمة المنتجات المباعة من متجر Levonis الرسمي، بالسعر المطبّق بعد خصومات المنتج والعضوية، دون أجرة توصيل ولا عمولة نقل ولا رسم ضمان ممتد.
- الأساس المؤهل الصافي: البضاعة المؤهلة بعد حسم خصم الكوبون على مستوى الطلب وحسم النقاط المصروفة على الطلب نفسه.
- لحظة الشراء: اللحظة التي أُثبت فيها الطلب على الخادم بعد حجز المخزون وخصم المحفظة وإصدار الفاتورة.
- التسوية: إثبات أن ثمن الطلب قُبض فعلاً. وفي الدفع المسبق من المحفظة تقع التسوية لحظة الشراء، وفي الدفع عند الاستلام لا تقع إلا بتسجيل التحصيل.
- المهمة: عمل داخل التطبيق يمنح نقاطاً بقيمة يحددها الخادم وحده.
- اليوم المعتمد: اليوم التقويمي بتوقيت بغداد كما يحسبه خادم المتجر من ساعته هو.
- المراجعة: نص وتقييم بالنجوم يكتبه زبون عن منتج استلمه فعلاً ضمن طلب مسلَّم.
- درجة الجودة: تقدير آلي لفائدة المراجعة ووسائطها، من واحد إلى خمسة، لا علاقة له بعدد النجوم ولا بكون الرأي مادحاً أو ذامّاً.
- هدية المراجعة: صندوق عيني من مخزون هدايا الطابعات يمنحه المتجر بقرار مستقل.
- الإحالة: نسبة حساب جديد إلى صاحب حساب قائم، برمز إحالة أو برابط اسم مستخدم.

### 1.4 النص المعتمد
النص العربي هو النص المعتمد، والإنكليزي والكردي ترجمتان أمينتان له بالترقيم نفسه. وعند الاختلاف يُرجع إلى العربي.

### 1.5 علاقة هذه الوثيقة بغيرها
تُقرأ هذه الوثيقة مع وثيقة الشراء ووثيقة الدفع ووثيقة العضويات ووثيقة التسجيل وسياسة مجتمع ليفو. وما يخص بنية أرصدة المحفظة مرجعه وثيقة الدفع، وما يخص مضاعف العضوية ومداه مرجعه وثيقة العضويات.

### 1.6 ما ليست عليه النقاط
- النقاط ليست مالاً، ولا تُبدَّل بنقد، ولا تُحوَّل إلى بطاقة ولا إلى حساب مصرفي.
- النقاط لا تُنقل من حساب إلى حساب، ولا تُورَّث، ولا تُباع، ولا تُهدى.
- النقاط ليست ديناً على المتجر، ولا يُطالَب بها بعد إغلاق الحساب.

### 1.7 قبول هذه الوثيقة
استعمال النقاط أو المطالبة بمكافأة مراجعة أو بإحالة قبولٌ لأحكام هذه الوثيقة بنسختها النافذة وقت الواقعة.

## 2. كيف تُكتسب نقاط الشراء

### 2.1 القاعدة
يُنشئ كل طلب مثبت على الخادم استحقاق نقاط محسوباً من أساسه المؤهل الصافي، بالمعدل النافذ لحظة الشراء.

### 2.2 المعدل
نقطة واحدة عن كل مئة دينار عراقي كاملة من الأساس المؤهل الصافي. وهذا المعدل إعداد في نظام المتجر يجوز للمتجر تغييره للمستقبل.

### 2.3 تجميد المعدل على الطلب
يُحَل المعدل مرة واحدة عند الشراء ويُثبَّت على سجل الاستحقاق. وتغيير المعدل بعد ذلك لا يعيد تسعير طلب سابق، لا بالزيادة ولا بالنقصان.

### 2.4 الطلبات القديمة
الطلبات التي سبقت العمل بالمعدل الحالي تبقى على معدلها القديم — نقطة عن كل ألف دينار، تُمنح عند التسليم — وتبقى قيودها كما هي. ولا تُضاعف ولا يُعاد منحها ولا يُعاد احتسابها.

### 2.5 الجمع ثم التقريب مرة واحدة
تُجمع قيم أسطر الطلب أولاً، ثم يُجرى التقريب إلى الأسفل مرة واحدة على مجموع الطلب. ولا يُقرَّب كل سطر على حدة، لأن ذلك يضيّع على الزبون نقاطاً استحقها.

### 2.6 ما لا يُحتسب ضمن البضاعة المؤهلة
- أجرة التوصيل وأي رسم أو ضريبة عليها.
- عمولة النقل في الطلب المسبق.
- رسم الضمان الممتد.
- أسطر متاجر مجتمع ليفو.
- اشتراكات العضوية.

### 2.7 أثر الكوبون والنقاط على الأساس
يُحسم خصم الكوبون على مستوى الطلب كاملاً من وعاء البضاعة المؤهلة، وتُحسم كذلك النقاط المصروفة على الطلب نفسه. والعلة أن الزبون لا يكتسب نقاطاً على قيمة لم يدفعها، وأن الكوبون قد يغطي جزءاً من أجرة التوصيل التي لا تكسب نقاطاً أصلاً.

### 2.8 الأساس لا يكون سالباً
إذا استغرق الخصم قيمة البضاعة كلها صار الأساس المؤهل صفراً، ولا ينشأ عنه استحقاق، ولا يُحمَّل الزبون شيئاً.

### 2.9 المحاولة غير الناجحة
المحاولة التي لم تنته بطلب مثبت لا تُنشئ استحقاقاً ولا تُسجَّل. ولا يُعتد بساعة جهاز الزبون ولا بلحظة إنشاء السلة في تحديد لحظة الشراء.

### 2.10 مضاعف العضوية
يُطبَّق مضاعف العضوية على النقاط المستحقة وفق الفصل السادس، ويُثبَّت المضاعف المطبق على سجل الاستحقاق ويُسجَّل معه.

## 3. دورة حياة النقطة

### 3.1 إنشاء الاستحقاق
يُنشأ سجل الاستحقاق بحالة معلّق داخل المعاملة نفسها التي أثبتت الطلب، لا بعدها ولا في وقت لاحق.

### 3.2 لحظة الشراء المسجلة
لحظة الشراء هي لحظة إثبات الطلب على الخادم. ولا تُعتمد لحظة فتح السلة ولا لحظة بدء الدفع.

### 3.3 مدة التعليق
تُحدَّد لحظة الاستحقاق بسبعة أيام كاملة — مئة وثمان وستين ساعة — من لحظة الشراء، وتُثبَّت عند الإنشاء ولا تُقدَّم ولا تُؤخَّر بعدها لأي سبب.

### 3.4 شرطا الإطلاق
لا تُطلق النقاط المعلّقة إلا باجتماع شرطين معاً: انقضاء مدة التعليق، وتسوية ثمن الطلب. ونقص أحدهما يبقي النقاط معلّقة.

### 3.5 التسوية في الدفع المسبق
الطلب المدفوع مسبقاً من المحفظة مسوّى لحظة الشراء، فيكفيه انقضاء السبعة أيام.

### 3.6 التسوية في الدفع عند الاستلام
الطلب المدفوع عند الاستلام لا يُعد مسوّى بمجرد التسليم، بل بتسجيل تحصيل المبلغ. فإذا سُجل التحصيل في اليوم التاسع أُطلقت النقاط في اليوم التاسع. والتسوية المتأخرة لا تبدأ مدة تعليق جديدة.

### 3.7 النقطة المعلّقة غير قابلة للإنفاق
النقطة المعلّقة غير موجودة في سجل المحفظة أصلاً، فلا يمكن صرفها لا عند الدفع ولا بغيره. وهذا بناءٌ في النظام لا وعدٌ، ولذلك لا يُقبل الاحتجاج بأن الرصيد الظاهر في صفحة النقاط أكبر مما قبله الدفع.

### 3.8 آلية الإطلاق
يقع الإطلاق في مهمة دورية على الخادم وعند تسجيل التسوية نفسها، وكلاهما لا يكرر القيد. ولا يتوقف الإطلاق على فتح الزبون لصفحة ولا للتطبيق.

### 3.9 إلغاء الطلب قبل الإطلاق
إذا أُلغي الطلب قبل إطلاق نقاطه أُلغي الاستحقاق المعلّق ولم يدخل سجل المحفظة شيء.

## 4. صرف النقاط

### 4.1 أين تُصرف
تُصرف النقاط المستقرة خصماً من قيمة البضاعة المؤهلة عند إتمام طلب من متجر Levonis الرسمي.

### 4.2 قيمة النقطة عند الصرف
النقطة الواحدة تساوي ديناراً عراقياً واحداً بالضبط عند الصرف. فسبعمئة وتسع وثلاثون نقطة تخصم سبعمئة وتسعة وثلاثين ديناراً، ولا تُقرَّب إلى خمسمئة ولا إلى ألف.

### 4.3 سقف الصرف في الطلب الواحد
يجوز صرف كل الرصيد المستقر، بشرط ألا يتجاوز المصروف قيمة البضاعة المؤهلة في ذلك الطلب بعد خصومات المنتج والعضوية والكوبون.

### 4.4 ما لا تُصرف عليه النقاط
- أجرة التوصيل وأي رسم أو ضريبة عليها.
- عمولة النقل في الطلب المسبق.
- رسم الضمان الممتد.
- أسطر متاجر مجتمع ليفو وطلباتها.
- اشتراكات العضوية.

### 4.5 لا صرف لما دون النقطة
لا يوجد كسر نقطة. والمصروف عدد صحيح من النقاط.

### 4.6 لا استرداد نقدي
النقاط لا تُبدَّل بنقد ولا تُسحب من المحفظة ولا تُحوَّل إلى رصيد نقدي بأي وجه.

### 4.7 أثر الصرف على اكتساب الطلب نفسه
النقاط المصروفة على طلب تُحسم من أساسه المؤهل، فلا يُعاد كسب نقاط على قيمة سُدِّدت بنقاط.

### 4.8 رصيد لا يكفي
إذا نقص الرصيد المستقر عن المطلوب طُبّق المتاح منه فقط، ولا يُسمح برصيد سالب.

### 4.9 إلغاء الطلب بعد صرف نقاط عليه
إذا أُلغي طلب صُرفت عليه نقاط أُعيدت تلك النقاط إلى رصيد الزبون وفق المادة 11.6.

## 5. مهام النقاط داخل التطبيق

### 5.1 طبيعة المهام
تعرض المنصة مهاماً يمنح إتمامها نقاطاً. وقيمة كل مهمة ثابتٌ في برنامج الخادم، ولا يرسل التطبيق قيمة ولا مدة ولا تاريخاً.

### 5.2 تسجيل الحضور اليومي
مهمة يومية واحدة لكل يوم معتمد. وسلّمها: خمس نقاط في اليومين الأول والثاني، وعشر في الثالث والرابع، وخمس عشرة في الخامس والسادس، وعشرون من اليوم السابع المتصل فصاعداً.

### 5.3 احتساب أيام التتابع
يُشتق يوم التتابع من سجل المنح نفسه في قاعدة البيانات، لا من عدّاد محفوظ على الحساب. وانقطاع التتابع يعيد العدّاد إلى أول درجات السلّم، وهي أقلها قيمة.

### 5.4 تفعيل الإشعارات
مهمة تُمنح مرة واحدة للحساب طوال عمره، قيمتها خمسون نقطة.

### 5.5 مشاهدة الإعلان
مهمة يومية قيمتها عشرون نقطة. ولا تُقبل المطالبة بها إلا بعد أن يصدر الخادم تذكرة موقوتة وتنقضي المدة المقررة بساعة الخادم نفسه.

### 5.6 التصفح
مهمة يومية قيمتها عشرون نقطة، ولا تُقبل المطالبة بها قبل انقضاء مئة وثمانين ثانية من ساعة الخادم عبر نبضات موثقة.

### 5.7 مرة واحدة في كل مدة
تُمنح المهمة اليومية مرة واحدة في اليوم المعتمد، والمهمة التي لمرة واحدة مرة واحدة أبداً. ومحاولة المطالبة مرة ثانية لا تحرّك شيئاً ويُعلَن رفضها صراحة.

### 5.8 ما يستطيع الخادم إثباته وما لا يستطيعه
تسجيل الحضور يثبته الخادم كاملاً من ساعته ومن سجله. أما تفعيل الإشعارات ومشاهدة الإعلان والتصفح فلا يملك الخادم دليلاً على وقوعها فعلاً؛ وغاية ما يثبته أن مدة معينة مرّت على ساعته هو. وتُعرض هذه الحقيقة للزبون في الصفحة نفسها.

### 5.9 حق المتجر في إيقاف مهمة
للمتجر أن يوقف مهمة الإشعارات أو الإعلان أو التصفح، وأن يعدّل مدة الإعلان المقررة، دون إشعار سابق. والمهمة الموقوفة تُرفض بسبب معلن، ولا تنشئ حقاً مكتسباً لمن لم يطالب بها قبل الإيقاف.

### 5.10 المضاعف على المهام
يُطبَّق مضاعف العضوية على نقاط المهام، ويُسجَّل المضاعف المطبق على قيد المنح، ليمكن تفسير اختلاف قيمة منحة اليوم عن منحة الأمس.

## 6. المضاعف وأثر انقضاء العضوية

### 6.1 مصدر المضاعف
المضاعف من فئة عضوية الزبون النافذة لحظة المنح أو لحظة الشراء، وفق وثيقة العضويات.

### 6.2 التثبيت
يُثبَّت المضاعف على سجل الاستحقاق أو على قيد المنح لحظة نشوئه.

### 6.3 انقضاء العضوية بعد الشراء
انقضاء العضوية بعد لحظة الشراء لا يخفض نقاط طلب سابق ولا يغيّر ما استقر منها.

### 6.4 أثر المضاعف عند الإرجاع الجزئي
يُحتسب ما يُعكس من نقاط بالمضاعف المثبت على الطلب نفسه، لا بمضاعف جديد. وبهذا لا يُسلب العضو الجزء المضاعف مما احتفظ به من بضاعة.

### 6.5 لا مضاعف بأثر رجعي
ترقية العضوية لا ترفع نقاط طلب سابق ولا منحة سابقة.

### 6.6 قيم المضاعف
عضو LEVO PREMIUM: مرة ونصف. عضو PRO: مرتان. ومن سواهما: مرة واحدة بلا زيادة. ويسري المضاعف على نقاط تسجيل الحضور والمهام والشراء والمراجعة.

### 6.7 التقريب
إذا نتج عن ضرب المضاعف كسرُ نقطة قُرِّب النصف إلى الأعلى. فخمس نقاط بمضاعف مرة ونصف تصير ثماني نقاط لا سبعاً. والمضاعف مرتان والمضاعف مرة واحدة لا ينشأ عنهما كسر أصلاً.

### 6.8 تقييد المزايا
إذا كان على الحساب قيدٌ إداري قائم يوقف ميزة المضاعف، احتُسبت النقاط بالمضاعف العادي طوال مدة القيد، ويُبيَّن ذلك على قيد المنح.

## 7. المراجعات ونقاطها

### 7.1 من يحق له المراجعة
المراجعة متاحة لمن استلم المنتج فعلاً ضمن طلب مسجَّل التسليم في حسابه. ولكل زبون مراجعة واحدة عن المنتج الواحد.

### 7.2 النشر الفوري
تُنشر المراجعة فور إرسالها. ولا تنتظر موافقة إدارية لتظهر.

### 7.3 حدود المحتوى
- نص المراجعة لا يزيد على أربعة آلاف حرف.
- الصور ستٌّ على الأكثر، ولا تتجاوز الصورة الواحدة ثمانية ميغابايت.
- الفيديو لا يتجاوز أربعين ميغابايت.
- عدد المراجعات المرسلة من الحساب الواحد محدود في الساعة، منعاً للإغراق.

### 7.4 درجة الجودة
يقيس النظام جودة المراجعة قياساً آلياً ثابتاً من فائدة النص وعدد الصور المتمايزة وجودتها ووجود الفيديو وجودته ووجود الدليل الدائم. ولا تدخل نبرة الرأي في هذا القياس: مراجعة بنجمة واحدة مفيدة قد تبلغ ما تبلغه مراجعة بخمس نجوم مفيدة.

### 7.5 نقاط المراجعة تلقائية
المراجعة اليدوية الصحيحة التي لا تبلغ درجة من درجات الهدية تُمنح نقاطها تلقائياً في المعاملة نفسها التي حفظت المراجعة، من غير قرار إداري ومن غير انتظار. وهذه هي الحالة الغالبة.

### 7.6 قيمة نقاط المراجعة
قيمة نقاط المراجعة ضِعف القيمة الأساسية المعلنة في إعدادات المتجر، ثم يُطبَّق عليها مضاعف العضوية. والقيمة الأساسية النافذة: {{REVIEW_BASE_POINTS}}.

### 7.7 إذا لم تُحدَّد القيمة الأساسية
إذا لم تكن القيمة الأساسية محددة في إعدادات المتجر فلا تُمنح نقاط مراجعة، ويُعلَن ذلك للزبون في الصفحة بصريح العبارة. ولا يخترع النظام قيمة، ولا ينشأ للزبون حق بأثر رجعي عند تحديدها لاحقاً.

### 7.8 المراجعة التي تبلغ درجة هدية
المراجعة التي تبلغ درجة من درجات الهدية لا تُمنح نقاط المراجعة التلقائية، لأنها دخلت مسار الهدية المبيّن في الفصل الثامن.

### 7.9 تعديل المراجعة
للزبون تعديل مراجعته ما دامت مكافأتها لم يُبتّ فيها. وإن نزل التعديل بالمراجعة دون درجة الهدية بقيت المراجعة منشورة، وسُجّل رفض مكافأة الهدية بسبب مكتوب، ومُنحت المراجعة نقاطها التلقائية كأي مراجعة يدوية صحيحة.

### 7.10 حذف المراجعة أو إخفاؤها
للمتجر إخفاء أو حذف مراجعة مخالفة لقواعد المحتوى في شروط استخدام الموقع والتطبيق. ولا يُعد ذلك قراراً في المكافأة، كما أن رفض المكافأة ليس حذفاً للمراجعة: القراران مستقلان.

### 7.11 الإفصاح
تُعلَّم المراجعات التي جرت ضمن برنامج المكافآت بما يفيد ذلك في الصفحة العامة، حفظاً لحق القارئ في معرفة ذلك.

### 7.12 خصوصية دليل إنستغرام
دليل الستوري يُخزَّن خاصاً، ولا يُعرض إلا لصاحبه ولإدارة المتجر، ولا يظهر في أي عرض عام أبداً.

## 8. هدية المراجعة

### 8.1 ما هي
صندوق عيني من مخزون هدايا الطابعات، بخمس درجات: الأولى ملحق، والثانية خيط طباعة، والثالثة خيط طباعة وملحق، والرابعة رأس طباعة، والخامسة رأس طباعة ومنصة.

### 8.2 الهدية قرار مستقل للمتجر
الهدية ليست حقاً يترتب تلقائياً على كتابة مراجعة، ولا على بلوغ درجة جودة معينة. المراجعة المؤهلة تدخل قائمة تقييم، ويصدر في شأنها قرار إداري معلَّل بواحد من ثلاثة: قبول بدرجة، أو طلب تعديل، أو رفض. والقبول وحده ينشئ الاستحقاق.

### 8.3 شروط دخول قائمة التقييم
لا تدخل المراجعة قائمة الهدية إلا إذا بلغت درجة جودة مقيسة آلياً، وكان معها نص ذو قدر كافٍ من التفصيل وصور متمايزة. وتتطلب الدرجات العليا فيديو مفيداً ودليلاً دائماً.

### 8.4 القرار معلَّل
لا يصدر قبول ولا رفض ولا طلب تعديل بغير سبب مكتوب يُعرض على صاحب المراجعة.

### 8.5 القرار لا يُعاد
المكافأة التي قُبلت لا يُعاد البتّ فيها، ولا تُسحب بقرار لاحق، إلا في حالات إساءة الاستعمال المبيّنة في الفصل الثالث عشر.

### 8.6 استحقاق واحد لكل مراجعة
تنشئ الموافقة استحقاق هدية واحداً لا غير عن المراجعة الواحدة.

### 8.7 اختيار الصندوق
يختار صاحب الاستحقاق صندوقاً واحداً بدرجة تساوي درجته أو تقل عنها. والاختيار نهائي ولا يُكرر.

### 8.8 محتوى الصندوق
يُحدَّد محتوى الصندوق من الخادم من أصناف متوفرة فعلاً في المخزون، ويُثبَّت مرة واحدة ولا يُعاد سحبه ولا يُبدَّل بعد تثبيته.

### 8.9 نفاد المخزون
إذا نفد المتوفر من درجة ما تعذّر اختيارها حتى يتوفر بديل. ولا يُستبدل بها نقد ولا نقاط.

### 8.10 الهدية عينية
الهدية عينية لا غير، ولا تُبدَّل بمال ولا برصيد محفظة ولا بخصم على طلب.

### 8.11 تسليم الهدية
تُسلَّم الهدية وفق ما تحدده الإدارة، وتسري عليها أحكام التوصيل المعتادة وكلفها.

### 8.12 المراجعات المولَّدة آلياً
المراجعة التي يولدها النظام لا تُمنح مكافأة بأي حال، ولا تدخل قائمة الهدايا.

## 9. التقييم التلقائي بعد سبعة أيام

### 9.1 ما هو
بعد مضي سبعة أيام على تسليم منتج لم يكتب الزبون عنه مراجعة، يسجل النظام تقييماً تلقائياً منشوراً بخمس نجوم بلا نص ولا وسائط.

### 9.2 لا مكافأة عليه
هذا التقييم لا يُنشئ مكافأة ولا يقيّد نقطة واحدة، لأنه ليس عملاً من الزبون.

### 9.3 تعليمه
يُعلَّم هذا التقييم في العرض العام بما يفيد أنه صادر عن النظام لا عن الزبون.

### 9.4 استبداله بمراجعة حقيقية
لصاحب الحساب أن يستبدل به مراجعة حقيقية في أي وقت، فتحل محله وتأخذ حكم المراجعة اليدوية في النقاط أو في مسار الهدية.

## 10. الإحالات

### 10.1 نشوء الإحالة
تنشأ الإحالة عند إنشاء حساب جديد برمز إحالة أو برابط اسم مستخدم. وتُقيَّد مرة واحدة عند الإنشاء.

### 10.2 لا تُنقل ولا يُعاد النظر فيها
لا تُنسب الإحالة إلى محيل آخر بعد قيدها، ولا تُنقل، ولا يُعاد النظر فيها بطلب.

### 10.3 الإحالة الذاتية
لا تُقبل إحالة الشخص لنفسه ولا الإحالة عبر حساب ثانٍ يفتحه المحيل. وتُعامل معاملة تعدد الحسابات وفق وثيقة التسجيل.

### 10.4 برنامج الطابعة: ما يناله الصديق
يُعفى الحساب المُحال من أجرة التوصيل في طلب واحد مؤهل يتضمن طابعة من قوائم الطابعات المعتمدة. والإعفاء لطلب واحد لا غير.

### 10.5 استهلاك الإعفاء
يُستهلك الإعفاء بأول طلب مؤهل يحمله ولم يُلغَ، لا بانتظار تسليمه. فالطلب الذي حمل الإعفاء يُسقط الحق حتى قبل وصوله.

### 10.6 برنامج الطابعة: ما يناله المحيل
يُقيَّد للمحيل استحقاق معلّق عند تسجيل تسليم الطلب المؤهل، وتُحدَّد أهليته بسبعة أيام من تاريخ التسليم المسجل.

### 10.7 برنامج عضوية PRO
إذا اشترى المُحال اشتراك PRO مدفوعاً نشأ للمحيل استحقاق مؤهل لحظة تسجيل الشراء. وإلغاء ذلك الاشتراك يُلغي هذا الاستحقاق، لأن سببه هو الدفع الذي زال.

### 10.8 هدية رمز الدعم
من اشترى طابعة مؤهلة عبر رمز دعم أو رابط مشاركة، ثم سُلّم طلبه وسُوّي ثمنه، نشأ لصاحب الرمز استحقاق هدية خيط طباعة واحد.

### 10.9 ما لا يُشترط في هدية رمز الدعم
لا يُشترط في صاحب الرمز أن يكون عضو PRO، ولا يُشترط في المشتري أن يكون حساباً جديداً، ولا تُفرض مدة انتظار سبعة أيام. ومدة السبعة أيام إنما هي لنقاط الشراء وحدها.

### 10.10 حالات التوقف للمراجعة
يوقف النظام الاستحقاق للمراجعة اليدوية، لا للرفض، في حالتين: أن يكون على الطلب نفسه استحقاق مقيَّد ببرنامج الطابعة القديم، وأن يكون على الطلب طلب إرجاع قائم لم يُرفض. ويُبتّ فيهما بقرار إداري معلَّل.

### 10.11 مراحل استحقاق الهدية
يمر استحقاق هدية رمز الدعم بمراحل مسجلة: قيد الأهلية، ثم مستحق، ثم محجوز، ثم مسلَّم. وتُلغى أي مرحلة قائمة إذا زال سببها.

### 10.12 ما يسقط الإحالة ومكافأتها
تسقط المكافأة إذا أُلغي الطلب الذي كان سببها، أو رُدّ المنتج، أو تبيّن أن الحساب المُحال ليس لشخص مستقل، أو استُعمل تعدد الحسابات أو رموز مفتعلة للحصول عليها.

### 10.13 إغلاق الحساب
الإحالات المقيدة تبقى وقائع مسجلة، ولا تُعاد إلى المحيل ولا تُنقل إلى غيره. ويتوقف رابط إحالة الحساب المغلق عن العمل.

## 11. عكس النقاط وسحب المكافآت

### 11.1 موجب العكس
يُعكس ما لا يستحقه الزبون: نقاط طلب أُلغي، ونقاط قيمة أُعيدت إليه، ونقاط مراجعة ثبت افتعالها، ومكافأة إحالة زال سببها.

### 11.2 طريقة العكس
يُحتسب العكس بإعادة حساب المستحق من الأساس المؤهل المتبقي بعد الإرجاع، ثم يُقيَّد الفرق قيداً سالباً. ولا يُحذف قيد سابق ولا يُمحى تاريخ.

### 11.3 لماذا لا يُحسب المُعاد وحده
لو حُسب المُعاد وحده لانحرف الحساب عن أساس الطلب عند تكرار الإرجاع الجزئي. ولذلك المرجع دائماً هو ما تبقى، لا ما ذهب.

### 11.4 نصيب السطر من الخصومات
يُخفَّض نصيب السطر المُعاد بنسبة خصومات الطلب نفسها، فلا يخسر الزبون نقاطاً إلا عن المال الذي دفعه فعلاً في ذلك السطر.

### 11.5 المضاعف عند العكس
يُحتسب العكس بالمضاعف المثبت على الطلب وقت الشراء وحده.

### 11.6 النقاط التي صُرفت على طلب مُلغى
تُعاد النقاط التي صُرفت على طلب أُلغي إلى رصيد الزبون.

### 11.7 الرصيد بعد العكس
إذا كان الزبون قد أنفق نقاطاً عُكست بعد ذلك، فللمتجر تسوية الفرق من رصيده اللاحق. ولا يُطالَب الزبون بمال نقداً عن نقاط أُنفقت.

### 11.8 المراجعة المسحوبة
سحب مراجعة أو حذفها لمخالفتها قواعد المحتوى يُجيز عكس نقاطها إذا كانت المخالفة تمسّ صحة المراجعة نفسها.

### 11.9 التبليغ
يُبيَّن سبب كل عكس في سجل النقاط، ويستطيع الزبون مراجعته من صفحة النقاط.

## 12. البقاء والانقطاع وكشف الرصيد

### 12.1 لا انتهاء بالتقادم
لا تنتهي صلاحية النقاط بمرور الزمن. ولا يوجد في نظام المتجر إسقاط للنقاط بسبب عدم الاستعمال.

### 12.2 كيف تنقص النقاط
لا تنقص النقاط إلا بثلاثة: صرفها في طلب، أو عكسها وفق الفصل الحادي عشر، أو زوال الحساب الذي تنتمي إليه.

### 12.3 إيقاف الحساب
إيقاف الحساب يجمّد استعمال النقاط طوال مدة الإيقاف، ولا يُعد ذلك إسقاطاً لها. وأحكام الإيقاف في وثيقة التسجيل.

### 12.4 إغلاق الحساب
بإغلاق الحساب تسقط النقاط ولا تُعوَّض بمال ولا تُنقل إلى حساب آخر.

### 12.5 تغيير البرنامج
للمتجر تعديل معدلات الكسب وقيم المهام ومحتوى الهدايا للمستقبل. والنقاط المستقرة قبل التعديل لا تتأثر به.

### 12.6 كشف الرصيد
تعرض صفحة النقاط للزبون رصيده المستقر ونقاطه المعلّقة وسجل حركاته، وسبب كل حركة وتاريخها والمضاعف الذي طُبّق عليها.

### 12.7 الاعتراض على الرصيد
لمن رأى في رصيده خطأً أن يعترض عبر قناة الدعم المعتمدة مبيّناً الحركة محل الاعتراض وتاريخها. ويُجاب اعتراضه بقرار معلَّل مسنَد إلى سجلات المتجر.

### 12.8 اختلاف الرقمين
إذا اختلف الرقم المعروض في صفحة النقاط عن الرقم المقبول عند الدفع فالسبب في الغالب نقاط معلّقة لم تستقر بعد، أو سقف الصرف في المادة 4.3. والمعوَّل عليه هو سجل المحفظة.

## 13. إساءة الاستعمال

### 13.1 القاعدة
برامج المكافآت موضوعة لزبون واحد حقيقي يشتري لنفسه ويكتب رأيه بنفسه. وكل استعمال يخرج عن ذلك إساءة.

### 13.2 صور الإساءة
- فتح حسابات متعددة للحصول على نقاط أو إحالات أو إعفاءات.
- شراء يُلغى أو يُرجع لغرض حصد النقاط.
- مراجعة مفتعلة، أو منقولة عن غيرها، أو بصور أو فيديو لا يخص المنتج، أو مكررة عن مراجعة سابقة للحساب نفسه.
- مراجعة مقابل أجر من بائع أو من غيره خارج برنامج المتجر.
- استعمال برامج آلية للمطالبة بالمهام، أو مناداة نقاط المهام من خارج التطبيق.
- افتعال رموز دعم أو روابط مشاركة لتوليد استحقاقات.
- استغلال خلل ظاهر في النظام بعد إدراكه.

### 13.3 الرأي السلبي ليس إساءة
المراجعة السالبة الصادقة ليست إساءة، ولا يجوز حرمان صاحبها من مكافأة بسببها. والمعيار فائدة المراجعة وصدقها لا رضا المتجر عنها.

### 13.4 الإجراء
للمتجر عند الإساءة: عكس النقاط محل الإساءة، وسحب استحقاق الهدية غير المسلَّم، ومنع الحساب من برامج المكافآت، ورفعها إلى إجراءات الحساب في وثيقة التسجيل عند الجسامة.

### 13.5 التناسب
يكون الإجراء بقدر الواقعة. ولا يُصادَر رصيد كامل بسبب واقعة واحدة يمكن عكسها بعينها.

### 13.6 التظلم
لصاحب الحساب أن يتظلم من إجراء اتُّخذ عليه خلال {{ACCOUNT_APPEAL_DAYS}} عبر قناة الدعم المعتمدة، ويُبتّ في تظلمه بقرار معلَّل.

### 13.7 الأدلة
يستند المتجر في إثبات الإساءة إلى سجلاته هو: سجل المنح، وسجل المحفظة، وسجل التدقيق، وسجل التسليم والتسوية.

### 13.8 عدم الإخلال
إجراءات هذا الفصل لا تخل بحق المتجر في المطالبة بما لحقه من ضرر وفق القانون.

## 14. أحكام ختامية

### 14.1 التعديل
للمتجر تعديل هذه الوثيقة بإصدار نسخة جديدة برقم وتاريخ نفاذ، ولا يسري التعديل بأثر رجعي على واقعة تمت قبل نفاذه.

### 14.2 الأولوية عند التعارض
إذا تعارض نص هذه الوثيقة مع وعد شفهي أو رسالة من موظف أو منشور تسويقي أو صورة في إعلان، فنص هذه الوثيقة هو المعتمد.

### 14.3 حجية السجلات
سجلات المتجر الإلكترونية هي المرجع في إثبات المنح والصرف والعكس ومواعيدها.

### 14.4 استقلال البنود
بطلان بند لا يمس صحة سائر البنود.

### 14.5 القانون والاختصاص
يحكم هذه الوثيقة {{GOVERNING_LAW_JURISDICTION}}، وتختص بالنزاع {{COMPETENT_COURT}}.

### 14.6 التواصل
قناة التواصل المعتمدة في شأن هذه الوثيقة: {{LEVONIS_SUPPORT_CONTACT}}، في أوقات {{LEVONIS_SUPPORT_HOURS}}.`,

    en: `## 1. Preamble, Scope and Definitions

### 1.1 Purpose of this document
This document sets out how Levonis points are earned and at what rate, when they become spendable and why they are not spendable before that, what they may and may not be spent on, how a review reward is calculated and how a review gift is decided, how referrals work and what their milestones are, and the Store's right to reverse the points of a cancelled order or a fabricated review.

### 1.2 The parties
The Store: {{LEVONIS_LEGAL_NAME}}, registered under number {{LEVONIS_REGISTRATION_NO}}, at {{LEVONIS_ADDRESS}}, referred to as Levonis. The Customer: the holder of an account registered on the platform.

### 1.3 Definitions
- Point: an internal accounting unit recorded by the Store in the account holder's points balance. It is not a currency, not a deposit and not a monetary obligation.
- Points balance: the total of settled points in the account holder's wallet ledger.
- Pending point: a point that arose from a purchase and has not yet settled; it is recorded in the entitlement ledger and does not exist in the wallet ledger at all.
- Settled point: a point released into the wallet ledger after both the waiting period and payment settlement; only settled points are spendable.
- Eligible merchandise: the value of products sold by the official Levonis store, at the applied price after product and membership discounts, excluding delivery charges, transport commission and extended-warranty fees.
- Net eligible base: eligible merchandise after deducting the order-level coupon discount and the points spent on that same order.
- Purchase moment: the instant the order was committed on the server, after stock was reserved, the wallet debited and the invoice issued.
- Settlement: proof that the price of the order was actually collected. On wallet prepayment settlement occurs at the purchase moment; on cash on delivery it occurs only when a collection is recorded.
- Mission: an action inside the application that grants points at a value decided solely by the server.
- Recorded day: the Baghdad calendar day as computed by the Store's server from its own clock.
- Review: text and a star rating written by a customer about a product actually received in a delivered order.
- Quality score: an automatic assessment of a review's usefulness and its media, from one to five, unrelated to the number of stars and to whether the opinion is favourable or critical.
- Review gift: a physical box from the printer-gift stock granted by the Store as an independent decision.
- Referral: the attribution of a new account to an existing account holder, by referral code or by a username link.

### 1.4 The authoritative text
The Arabic text is the authoritative text; the English and Kurdish are faithful translations of it with the same numbering. In case of divergence the Arabic governs.

### 1.5 Relationship to the other documents
This document is read with the Purchase document, the Payment document, the Memberships document, the Registration document and the Levo Community Policy. The structure of wallet balances is governed by the Payment document; the membership multiplier and its extent by the Memberships document.

### 1.6 What points are not
- Points are not money; they are not exchanged for cash and never transferred to a card or a bank account.
- Points are not moved between accounts, not inherited, not sold and not gifted.
- Points are not a debt owed by the Store and cannot be claimed after an account is closed.

### 1.7 Acceptance of this document
Using points, or claiming a review reward or a referral reward, constitutes acceptance of this document in the version in force at the time of the event.

## 2. How purchase points are earned

### 2.1 The rule
Every order committed on the server creates a points entitlement calculated from its net eligible base, at the rate in force at the purchase moment.

### 2.2 The rate
One point for every full 100 Iraqi dinars of the net eligible base. This rate is a setting in the Store's system which the Store may change prospectively.

### 2.3 The rate is frozen on the order
The rate is resolved once at purchase and fixed on the entitlement record. A later change of the rate never re-prices an earlier order, neither upwards nor downwards.

### 2.4 Older orders
Orders that predate the current rate remain on their own rate — one point per 1,000 dinars, granted at delivery — and their records stay as they are. They are never multiplied, re-granted or recomputed.

### 2.5 Summed first, rounded once
The values of the order's lines are summed first, and the rounding down is applied once to the order total. It is not applied line by line, because that would lose the customer points they had earned.

### 2.6 What is not eligible merchandise
- The delivery charge and any fee or tax upon it.
- The transport commission on a pre-order.
- The extended-warranty fee.
- Levo Community store lines.
- Membership subscriptions.

### 2.7 The effect of a coupon and of points on the base
An order-level coupon discount is deducted in full from the eligible merchandise pool, and so are the points spent on that same order. The reason is that a customer does not earn points on value they did not pay, and that a coupon may partly cover a delivery charge which earns no points in the first place.

### 2.8 The base is never negative
If the discount absorbs the whole value of the merchandise, the net eligible base becomes zero, no entitlement arises from it, and nothing is charged to the customer.

### 2.9 An unsuccessful attempt
An attempt that did not end in a committed order creates no entitlement and is not recorded. Neither the clock of the customer's device nor the moment the cart was created determines the purchase moment.

### 2.10 The membership multiplier
The membership multiplier is applied to the points due in accordance with the Memberships document, and the multiplier applied is fixed on the entitlement record and stored with it.

## 3. The life of a point

### 3.1 Creation of the entitlement
The entitlement record is created in the "pending" state inside the very transaction that committed the order, not after it and not at some later time.

### 3.2 The recorded purchase moment
The purchase moment is the moment the order was committed on the server. Neither the moment the cart was opened nor the moment payment began is used.

### 3.3 The waiting period
The settlement instant is set at seven full days — one hundred and sixty-eight hours — from the purchase moment, fixed at creation, and thereafter never brought forward or pushed back for any reason.

### 3.4 The two release conditions
Pending points are released only when both conditions are met together: the waiting period has passed and the price of the order has settled. If one is missing, the points stay pending.

### 3.5 Settlement on prepayment
An order prepaid from the wallet is settled at the purchase moment, so the passing of the seven days suffices.

### 3.6 Settlement on cash on delivery
An order paid on delivery is not settled by the delivery itself but by the recording of the collection. If collection is recorded on day nine, the points are released on day nine. A late settlement does not start a new waiting period.

### 3.7 A pending point is not spendable
A pending point does not exist in the wallet ledger at all, so it cannot be spent, at checkout or otherwise. This is a matter of construction and not a promise, which is why it is not open to a customer to argue that the balance shown on the points page was larger than the one accepted at checkout.

### 3.8 The release mechanism
Release happens in a scheduled job on the server and at the recording of settlement itself, and neither duplicates the entry. Release does not depend on the customer opening any page or the application.

### 3.9 Cancellation before release
If the order is cancelled before its points are released, the pending entitlement is cancelled and nothing enters the wallet ledger.

## 4. Spending points

### 4.1 Where they are spent
Settled points are spent as a deduction from the value of eligible merchandise when completing an order from the official Levonis store.

### 4.2 The value of a point on redemption
One point equals exactly one Iraqi dinar on redemption. Seven hundred and thirty-nine points discount seven hundred and thirty-nine dinars; they are not rounded to five hundred or to a thousand.

### 4.3 The ceiling in a single order
The whole settled balance may be spent, provided the amount spent does not exceed the value of the eligible merchandise in that order after product, membership and coupon discounts.

### 4.4 What points may not be spent on
- The delivery charge and any fee or tax upon it.
- The transport commission on a pre-order.
- The extended-warranty fee.
- Levo Community store lines and their orders.
- Membership subscriptions.

### 4.5 No fraction of a point
There is no fraction of a point. The amount spent is a whole number of points.

### 4.6 No cash redemption
Points are not exchanged for cash, not withdrawn from the wallet and not converted into a cash balance in any way.

### 4.7 The effect of spending on the same order's earning
Points spent on an order are deducted from its eligible base, so points are not re-earned on value that was settled with points.

### 4.8 An insufficient balance
If the settled balance is less than required, only what is available is applied, and a negative balance is not permitted.

### 4.9 Cancelling an order on which points were spent
If an order on which points were spent is cancelled, those points are returned to the customer's balance in accordance with article 11.6.

## 5. In-application point missions

### 5.1 The nature of the missions
The platform offers missions whose completion grants points. The value of each mission is a constant in the server program, and the application sends no value, no duration and no date.

### 5.2 The daily check-in
One daily mission per recorded day. Its ladder is: five points on the first and second days, ten on the third and fourth, fifteen on the fifth and sixth, and twenty from the seventh consecutive day onwards.

### 5.3 Computation of the streak
The streak day is derived from the award records themselves in the database, not from a counter cached on the account. Breaking the streak returns the counter to the first rung of the ladder, which is its cheapest.

### 5.4 Enabling notifications
A mission granted once per account for its whole lifetime, worth fifty points.

### 5.5 Watching the advertisement
A daily mission worth twenty points. It may not be claimed until the server has issued a timed ticket and the prescribed period has elapsed on the server's own clock.

### 5.6 Browsing
A daily mission worth twenty points, which may not be claimed before one hundred and eighty seconds have elapsed on the server's clock across authenticated pings.

### 5.7 Once per period
A daily mission is granted once per recorded day, and a once-only mission once ever. A second claim moves nothing and its refusal is stated expressly.

### 5.8 What the server can prove and what it cannot
The check-in is proven entirely by the server from its own clock and its own records. As for enabling notifications, watching the advertisement and browsing, the server holds no proof that they actually happened; the most it proves is that a given period elapsed on its own clock. This fact is displayed to the customer on the page itself and may not be objected to afterwards.

### 5.9 The Store's right to switch a mission off
The Store may switch off the notifications, advertisement or browsing mission, and may change the prescribed advertisement period, without prior notice. A disabled mission is refused with a stated reason, and it creates no acquired right for anyone who had not claimed it before it was switched off.

### 5.10 The multiplier on missions
The membership multiplier is applied to mission points, and the multiplier applied is recorded on the award entry, so that a difference between today's award and yesterday's can be explained.

## 6. The multiplier and the effect of a lapsed membership

### 6.1 Source of the multiplier
The multiplier comes from the customer's membership tier in force at the moment of the award or of the purchase, in accordance with the Memberships document.

### 6.2 Fixing
The multiplier is fixed on the entitlement record or on the award entry at the moment it arises.

### 6.3 A membership that lapses after a purchase
A membership that lapses after the purchase moment does not reduce the points of an earlier order and does not change what has settled of them.

### 6.4 The multiplier on a partial return
Points reversed are computed at the multiplier fixed on that same order, never at a freshly resolved one. A member is therefore not stripped of the multiplied portion of the goods they kept.

### 6.5 No retroactive multiplier
Upgrading a membership does not raise the points of an earlier order or an earlier award.

### 6.6 The values of the multiplier
A LEVO PREMIUM member: one and a half. A PRO member: twofold. Anyone else: onefold, with no increase. The multiplier applies to check-in points, mission points, purchase points and review points.

### 6.7 Rounding
Where multiplying produces a fraction of a point, a half is rounded up. Five points at a multiplier of one and a half become eight points, not seven. A twofold and a onefold multiplier produce no fraction at all.

### 6.8 A restricted benefit
Where a live administrative restriction on the account suspends the multiplier benefit, points are computed at the ordinary multiplier for the duration of the restriction, and that is shown on the award entry.

## 7. Reviews and their points

### 7.1 Who may review
A review is open to a customer who actually received the product in an order recorded as delivered in their account. Each customer has one review per product.

### 7.2 Immediate publication
A review is published as soon as it is sent. It does not wait for an administrative approval in order to appear.

### 7.3 Content limits
- The review text may not exceed four thousand characters.
- Photographs are limited to six, and no single image may exceed eight megabytes.
- A video may not exceed forty megabytes.
- The number of reviews sent from one account is limited per hour, to prevent flooding.

### 7.4 The quality score
The system measures the quality of a review by a fixed automatic measure taken from the usefulness of the text, the number of distinct images and their quality, the presence and quality of a video, and the presence of durable evidence. The tone of the opinion plays no part in that measure: a useful one-star review may reach what a useful five-star review reaches.

### 7.5 Review points are automatic
A valid manual review that does not reach one of the gift levels is granted its points automatically, in the very transaction that saved the review, with no administrative decision and no waiting. This is the ordinary case.

### 7.6 The value of review points
The value of review points is twice the base value published in the Store's settings, and the membership multiplier is then applied to it. The base value in force is: {{REVIEW_BASE_POINTS}}.

### 7.7 If the base value is not configured
If the base value is not set in the Store's settings, no review points are granted, and this is stated to the customer on the page in express terms. The system invents no value, and no retroactive right arises for the customer when a value is later set.

### 7.8 A review that reaches a gift level
A review that reaches one of the gift levels is not granted the automatic review points, because it has entered the gift path set out in chapter 8.

### 7.9 Editing a review
A customer may edit their review as long as its reward has not been decided. If the edit brings the review below a gift level, the review remains published, the refusal of the gift reward is recorded with a written reason, and the review is granted its automatic points like any other valid manual review.

### 7.10 Deleting or hiding a review
The Store may hide or delete a review that breaches the content rules in the Site and Application Terms of Use. That is not a decision on the reward, just as a refusal of a reward is not a deletion of the review: the two decisions are independent.

### 7.11 Disclosure
Reviews made within the rewards programme are marked as such on the public page, in order to preserve the reader's right to know that.

### 7.12 Privacy of the Instagram evidence
Story evidence is stored privately, shown only to its owner and to the Store's administration, and never appears in any public display.

## 8. The review gift

### 8.1 What it is
A physical box from the printer-gift stock, in five levels: the first an accessory, the second a print filament, the third a filament and an accessory, the fourth a print nozzle, and the fifth a nozzle and a plate.

### 8.2 The gift is an independent decision of the Store
The gift is not a right that follows automatically from writing a review, nor from reaching a particular quality score. A qualifying review enters an assessment queue, and a reasoned administrative decision is issued upon it in one of three forms: approval at a level, a request for changes, or a refusal. Approval alone creates the entitlement.

### 8.3 Conditions for entering the queue
A review does not enter the gift queue unless it has reached an automatically measured quality score, with a text of sufficient detail and distinct images. The higher levels additionally require a useful video and durable evidence.

### 8.4 The decision is reasoned
No approval, refusal or request for changes is issued without a written reason shown to the author of the review.

### 8.5 The decision is not reopened
A reward that has been approved is not re-decided and is not withdrawn by a later decision, save in the cases of abuse set out in chapter 13.

### 8.6 One entitlement per review
An approval creates one gift entitlement only, per review.

### 8.7 Choosing the box
The holder of the entitlement chooses one box at a level equal to or below their own. The choice is final and is not repeated.

### 8.8 The contents of the box
The contents are determined by the server from items actually available in stock, fixed once, and never re-drawn or exchanged after they have been fixed.

### 8.9 Exhausted stock
If what is available at a level is exhausted, that level cannot be chosen until a substitute is available. It is not converted into cash or into points.

### 8.10 The gift is in kind
The gift is in kind only, and is not exchanged for money, for wallet balance or for a discount on an order.

### 8.11 Delivery of the gift
The gift is delivered as the administration determines, and the ordinary delivery provisions and their costs apply to it.

### 8.12 Automatically generated reviews
A review generated by the system is granted no reward in any case and does not enter the gift queue.

## 9. The automatic rating after seven days

### 9.1 What it is
After seven days have passed from the delivery of a product about which the customer has written no review, the system records an automatic published rating of five stars with no text and no media.

### 9.2 No reward upon it
This rating creates no reward and records not a single point, because it is not an act of the customer.

### 9.3 Its marking
This rating is marked in the public display as issued by the system and not by the customer.

### 9.4 Replacing it with a real review
The account holder may replace it with a real review at any time; that review takes its place and takes the rule of a manual review as to points or as to the gift path.

## 10. Referrals

### 10.1 How a referral arises
A referral arises when a new account is created with a referral code or a username link. It is recorded once, at creation.

### 10.2 It is neither moved nor reopened
A referral is not attributed to another referrer after it has been recorded, is not transferred, and is not reconsidered on request.

### 10.3 Self-referral
A referral by a person to themselves is not accepted, nor is a referral through a second account opened by the referrer. It is treated as multiple accounts under the Registration document.

### 10.4 The printer programme: what the friend receives
The referred account is exempted from the delivery charge on one qualifying order containing a printer from the approved printer catalogues. The exemption is for one order only.

### 10.5 Consuming the exemption
The exemption is consumed by the first qualifying order that carries it and is not cancelled, not by waiting for its delivery. An order that carried the exemption therefore spends the right even before it arrives.

### 10.6 The printer programme: what the referrer receives
A pending entitlement is recorded for the referrer when the delivery of the qualifying order is recorded, and its eligibility is set at seven days from the recorded delivery date.

### 10.7 The PRO membership programme
If the referred person buys a paid PRO subscription, a qualified entitlement arises for the referrer at the moment the purchase is recorded. Cancelling that subscription cancels this entitlement, because its cause was the payment that has gone.

### 10.8 The support-code gift
A person who bought a qualifying printer through a support code or a share link, whose order was then delivered and whose price settled, gives rise to one filament-gift entitlement for the holder of that code.

### 10.9 What is not required for the support-code gift
The holder of the code is not required to be a PRO member, the buyer is not required to be a new account, and no seven-day waiting period is imposed. The seven-day period belongs to purchase points alone.

### 10.10 Cases held for review
The system holds an entitlement for manual review, not for refusal, in two cases: where an entitlement under the older printer programme is already recorded against the same order, and where a return request on the order is open and has not been refused. Both are decided by a reasoned administrative decision.

### 10.11 The stages of a gift entitlement
A support-code gift entitlement passes through recorded stages: pending eligibility, then due, then reserved, then delivered. Any live stage is cancelled if its cause falls away.

### 10.12 What forfeits a referral and its reward
The reward is forfeited if the order that caused it is cancelled, or the product is returned, or it appears that the referred account does not belong to an independent person, or multiple accounts or contrived codes were used to obtain it.

### 10.13 Closing an account
Recorded referrals remain as recorded facts; they are neither returned to the referrer nor transferred to anyone else. The referral link of a closed account ceases to work.

## 11. Reversing points and withdrawing rewards

### 11.1 Grounds for reversal
What the customer is not entitled to is reversed: the points of a cancelled order, the points on value returned to them, the points of a review shown to be fabricated, and a referral reward whose cause has gone.

### 11.2 The method of reversal
A reversal is computed by recalculating the entitlement from the eligible base remaining after the return, and the difference is then recorded as a negative entry. No earlier entry is deleted and no history is erased.

### 11.3 Why the returned portion is not computed alone
Were the returned portion computed on its own, the calculation would drift away from the order's basis upon repeated partial returns. The reference is therefore always what remains, not what has gone.

### 11.4 The line's share of discounts
The share of the returned line is reduced by the order's own discount ratio, so the customer loses points only on the money they actually paid on that line.

### 11.5 The multiplier on reversal
A reversal is computed at the multiplier fixed on the order at the time of purchase, and at no other.

### 11.6 Points spent on a cancelled order
Points spent on an order that is cancelled are returned to the customer's balance.

### 11.7 The balance after a reversal
If the customer had already spent points which were afterwards reversed, the Store may settle the difference from their later balance. The customer is not asked for money in cash for points already spent.

### 11.8 A withdrawn review
Withdrawing or deleting a review for breach of the content rules permits the reversal of its points where the breach goes to the soundness of the review itself.

### 11.9 Notification
The reason for every reversal is stated in the points record, and the customer can consult it from the points page.

## 12. Persistence, interruption and disclosure of the balance

### 12.1 No lapse by the passage of time
Points do not expire with the passage of time. There is nothing in the Store's system that forfeits points for non-use.

### 12.2 How points decrease
Points decrease only in three ways: spending them on an order, reversing them under chapter 11, or the disappearance of the account to which they belong.

### 12.3 Suspension of the account
Suspension of the account freezes the use of points for the duration of the suspension, and that is not a forfeiture of them. The provisions on suspension are in the Registration document.

### 12.4 Closure of the account
On closure of the account the points lapse; they are not compensated in money and are not transferred to another account.

### 12.5 Changing the programme
The Store may amend earning rates, mission values and gift contents prospectively. Points settled before the amendment are unaffected by it.

### 12.6 Disclosure of the balance
The points page shows the customer their settled balance, their pending points and the record of their movements, with the reason for each movement, its date and the multiplier applied to it.

### 12.7 Objecting to a balance
A customer who sees an error in their balance may object through the approved support channel, stating the movement objected to and its date. Their objection is answered by a reasoned decision supported by the Store's records.

### 12.8 A difference between the two figures
Where the figure shown on the points page differs from the figure accepted at checkout, the cause is usually pending points that have not yet settled, or the redemption ceiling in article 4.3. The wallet record is what governs.

## 13. Abuse

### 13.1 The rule
The reward programmes are designed for one real customer who buys for themselves and writes their own opinion. Every use outside that is abuse.

### 13.2 Forms of abuse
- Opening multiple accounts to obtain points, referrals or exemptions.
- A purchase cancelled or returned for the purpose of harvesting points.
- A fabricated review, one copied from another, one with images or video not belonging to the product, or one duplicating an earlier review from the same account.
- A review written for payment from a seller or from anyone else outside the Store's programme.
- Using automated programs to claim missions, or calling mission endpoints from outside the application.
- Contriving support codes or share links in order to generate entitlements.
- Exploiting an evident fault in the system after becoming aware of it.

### 13.3 A negative opinion is not abuse
An honest negative review is not abuse, and its author may not be deprived of a reward on account of it. The measure is the usefulness and the truthfulness of the review, not the Store's satisfaction with it.

### 13.4 The measures
Upon abuse the Store may: reverse the points concerned, withdraw an undelivered gift entitlement, bar the account from the reward programmes, and escalate to the account measures in the Registration document where the matter is grave.

### 13.5 Proportionality
The measure is proportionate to the event. A whole balance is not confiscated on account of a single event which can be reversed on its own terms.

### 13.6 Appeal
An account holder may appeal a measure taken against them within {{ACCOUNT_APPEAL_DAYS}} through the approved support channel, and their appeal is decided by a reasoned decision.

### 13.7 Evidence
The Store relies in proving abuse on its own records: the award record, the wallet record, the audit record, and the delivery and settlement records.

### 13.8 Without prejudice
The measures in this chapter are without prejudice to the Store's right to claim the damage it has suffered under the law.

## 14. Final provisions

### 14.1 Amendment
The Store may amend this document by issuing a new version with a number and an effective date; an amendment does not apply retroactively to an event completed before it took effect.

### 14.2 Priority in case of conflict
Where the text of this document conflicts with an oral promise, a message from a member of staff, a marketing publication or an image in an advertisement, the text of this document governs.

### 14.3 The authority of the records
The Store's electronic records are the reference in proving awards, redemptions, reversals and their timing.

### 14.4 Severability
The invalidity of one provision does not affect the validity of the remaining provisions.

### 14.5 Governing law and jurisdiction
This document is governed by {{GOVERNING_LAW_JURISDICTION}}, and {{COMPETENT_COURT}} has jurisdiction over disputes.

### 14.6 Contact
The approved channel of contact concerning this document: {{LEVONIS_SUPPORT_CONTACT}}, during {{LEVONIS_SUPPORT_HOURS}}.`,

    ckb: `## 1. پێشەکی و بوار و پێناسەکان

### 1.1 مەبەستی ئەم بەڵگەنامەیە
ئەم بەڵگەنامەیە ڕوون دەکاتەوە چۆن خاڵی Levonis بەدەست دەهێنرێت و بە چ ڕێژەیەک، کەی خەرجکردنی بۆ دەکرێت و بۆچی پێش ئەو کاتە خەرج ناکرێت، لەسەر چی خەرج دەکرێت و لەسەر چی خەرج ناکرێت، چۆن پاداشتی پێداچوونەوە دەژمێردرێت و چۆن بڕیار لەسەر دیاری پێداچوونەوە دەدرێت، ناردن چۆن کار دەکات و قۆناغەکانی چین، و مافی فرۆشگا بۆ گەڕاندنەوەی خاڵی داواکارییەکی هەڵوەشێنراوە یان پێداچوونەوەیەکی ساختە.

### 1.2 لایەنەکان
فرۆشگا: {{LEVONIS_LEGAL_NAME}}، تۆمارکراو بە ژمارە {{LEVONIS_REGISTRATION_NO}}، ناونیشانی {{LEVONIS_ADDRESS}}، کە بە Levonis ئاماژەی پێ دەکرێت. کڕیار: خاوەنی ئەو هەژمارەیەی لە پلاتفۆرمەکەدا تۆمار کراوە.

### 1.3 پێناسەکان
- خاڵ: یەکەیەکی ژمێریاری ناوخۆیی کە فرۆشگا لە باڵانسی خاڵی خاوەن هەژماردا تۆماری دەکات. دراو نییە و ئەمانەت نییە و ئەرکێکی دارایی نییە.
- باڵانسی خاڵ: کۆی ئەو خاڵانەی لە تۆماری جزدانی خاوەن هەژماردا جێگیر بوونە.
- خاڵی هەڵپەسێردراو: خاڵێک کە لە کڕینێکەوە سەری هەڵداوە و هێشتا جێگیر نەبووە؛ لە تۆماری شایستەیی تۆمارکراوە و هەر بوونی لە تۆماری جزداندا نییە.
- خاڵی جێگیر: خاڵێک کە دوای تەواوبوونی ماوەی چاوەڕوانی و دانانی پارە بەرەو تۆماری جزدان ئازاد کراوە، و تەنها ئەمانە خەرج دەکرێن.
- کاڵای شایستە: بەهای ئەو بەرهەمانەی لە فرۆشگای فەرمی Levonis ەوە دەفرۆشرێن، بە نرخی جێبەجێکراو دوای داشکاندنی بەرهەم و ئەندامێتی، بەبێ تێچووی گەیاندن و کۆمیسیۆنی گواستنەوە و باجی گەرەنتی درێژکراوە.
- بنەمای شایستەی ڕوون: کاڵای شایستە دوای کەمکردنەوەی داشکاندنی کۆپۆن لەسەر ئاستی داواکاری و ئەو خاڵانەی لەسەر هەمان داواکاری خەرج کراون.
- ساتی کڕین: ئەو ساتەی داواکارییەکە لەسەر ڕاژە جێگیر کرا، دوای گیرانی کۆگا و کەمکردنەوەی جزدان و دەرکردنی پسوڵە.
- دانان: سەلماندنی ئەوەی نرخی داواکارییەکە بەڕاستی وەرگیراوە. لە پارەدانی پێشەکی لە جزدانەوە، دانان لە ساتی کڕیندا ڕوودەدات؛ لە پارەدان لەکاتی وەرگرتندا تەنها بە تۆمارکردنی کۆکردنەوەی پارە ڕوودەدات.
- ئەرک: کردارێک لەناو بەرنامەکەدا کە خاڵ دەبەخشێت بە بەهایەک کە تەنها ڕاژە بڕیاری لەسەر دەدات.
- ڕۆژی تۆمارکراو: ڕۆژی ڕۆژژمێری بەغدا وەک ڕاژەی فرۆشگا لە کاتژمێری خۆیەوە دەیژمێرێت.
- پێداچوونەوە: دەق و پلەی ئەستێرە کە کڕیارێک لەسەر بەرهەمێک دەینووسێت کە بەڕاستی لە داواکارییەکی گەیەنراودا وەریگرتووە.
- پلەی جۆرایەتی: هەڵسەنگاندنێکی خۆکار بۆ سوودمەندی پێداچوونەوە و میدیاکانی، لە یەکەوە بۆ پێنج، پەیوەندی بە ژمارەی ئەستێرەکانەوە نییە و بەوەشەوە نییە کە بۆچوونەکە ستایش یان ڕەخنە بێت.
- دیاری پێداچوونەوە: سندوقێکی ماددی لە کۆگای دیاری چاپکەرەکان کە فرۆشگا بە بڕیارێکی سەربەخۆ دەیبەخشێت.
- ناردن: پێدانی هەژمارێکی نوێ بە خاوەن هەژمارێکی هەبوو، بە کۆدی ناردن یان بە بەستەری ناوی بەکارهێنەر.

### 1.4 دەقی پەسەندکراو
دەقی عەرەبی دەقی پەسەندکراوە، و ئینگلیزی و کوردی وەرگێڕانی دڵسۆزن بە هەمان ژمارەبەندی. لە کاتی جیاوازیدا دەقی عەرەبی بنەمایە.

### 1.5 پەیوەندی ئەم بەڵگەنامەیە بە ئەوانی تر
ئەم بەڵگەنامەیە لەگەڵ بەڵگەنامەی کڕین و بەڵگەنامەی پارەدان و بەڵگەنامەی ئەندامێتییەکان و بەڵگەنامەی تۆمارکردن و سیاسەتی کۆمەڵگەی لێڤۆ دەخوێنرێتەوە. پێکهاتەی باڵانسەکانی جزدان بەڵگەنامەی پارەدان ڕێکی دەخات، و زیادکەری ئەندامێتی و سنووری بەڵگەنامەی ئەندامێتییەکان.

### 1.6 ئەوەی خاڵ نییە
- خاڵ پارە نییە، بە پارەی نەقد ناگۆڕدرێت، و بۆ کارت یان هەژماری بانکی ناگوازرێتەوە.
- خاڵ لە هەژمارێکەوە بۆ هەژمارێکی تر ناگوازرێتەوە، میرات نابێت، نافرۆشرێت و دیاری ناکرێت.
- خاڵ قەرزێک نییە لەسەر فرۆشگا، و دوای داخستنی هەژمار داوای ناکرێت.

### 1.7 پەسەندکردنی ئەم بەڵگەنامەیە
بەکارهێنانی خاڵ، یان داواکردنی پاداشتی پێداچوونەوە یان پاداشتی ناردن، پەسەندکردنی ئەم بەڵگەنامەیەیە بەو وەشانەی لە کاتی ڕووداوەکەدا کاری پێدەکرا.

## 2. چۆن خاڵی کڕین بەدەست دەهێنرێت

### 2.1 بنەما
هەر داواکارییەک کە لەسەر ڕاژە جێگیر بێت شایستەیی خاڵ دروست دەکات، لە بنەمای شایستەی ڕوونی خۆیەوە دەژمێردرێت، بەو ڕێژەیەی لە ساتی کڕیندا کاری پێدەکرا.

### 2.2 ڕێژەکە
یەک خاڵ بۆ هەر سەد دیناری عێراقی تەواو لە بنەمای شایستەی ڕوون. ئەم ڕێژەیە ڕێکخستنێکە لە سیستەمی فرۆشگا کە فرۆشگا دەتوانێت بۆ داهاتوو بیگۆڕێت.

### 2.3 ڕەقکردنی ڕێژە لەسەر داواکاری
ڕێژەکە جارێک لە کاتی کڕیندا دیاری دەکرێت و لەسەر تۆماری شایستەیی جێگیر دەکرێت. گۆڕینی دواتری ڕێژە هەرگیز داواکارییەکی پێشووتر دووبارە نرخ ناکاتەوە، نە بە زیادکردن و نە بە کەمکردنەوە.

### 2.4 داواکارییە کۆنەکان
ئەو داواکارییانەی پێش ڕێژەی ئێستا بوون لەسەر ڕێژەی خۆیان دەمێننەوە — یەک خاڵ بۆ هەر هەزار دینار، لە کاتی گەیاندندا دەبەخشرێت — و تۆمارەکانیان وەک خۆیان دەمێننەوە. هەرگیز چەند قات ناکرێن و دووبارە نابەخشرێنەوە و دووبارە ناژمێردرێنەوە.

### 2.5 کۆکردنەوە سەرەتا، خڕکردنەوە جارێک
بەهای هێڵەکانی داواکاری سەرەتا کۆ دەکرێنەوە، و خڕکردنەوە بۆ خوارەوە جارێک لەسەر کۆی داواکارییەکە جێبەجێ دەکرێت. هێڵ بە هێڵ جێبەجێ ناکرێت، چونکە ئەوە خاڵی شایستەی کڕیار لەدەست دەدات.

### 2.6 ئەوەی کاڵای شایستە نییە
- تێچووی گەیاندن و هەر باج و پارەیەکی لەسەری.
- کۆمیسیۆنی گواستنەوە لە داواکاری پێشوەختەدا.
- باجی گەرەنتی درێژکراوە.
- هێڵەکانی فرۆشگاکانی کۆمەڵگەی لێڤۆ.
- بەشداری ئەندامێتی.

### 2.7 کاریگەری کۆپۆن و خاڵ لەسەر بنەما
داشکاندنی کۆپۆن لەسەر ئاستی داواکاری بە تەواوی لە حەوزی کاڵای شایستە کەم دەکرێتەوە، و ئەو خاڵانەش کە لەسەر هەمان داواکاری خەرج کراون. هۆکارەکەی ئەوەیە کە کڕیار خاڵ بەدەست ناهێنێت لەسەر بەهایەک کە نەیداوە، و ئەوەی کۆپۆن لەوانەیە بەشێک لە تێچووی گەیاندن دابپۆشێت کە لە بنەڕەتدا هیچ خاڵێک بەدەست ناهێنێت.

### 2.8 بنەما هەرگیز نەرێنی نابێت
ئەگەر داشکاندن هەموو بەهای کاڵاکە بگرێتەوە، بنەمای شایستەی ڕوون دەبێتە سفر، هیچ شایستەییەک لێی سەرهەڵنادات، و هیچ لە کڕیار وەرناگیرێت.

### 2.9 هەوڵێکی سەرنەکەوتوو
ئەو هەوڵەی بە داواکارییەکی جێگیر کۆتایی نەهاتووە هیچ شایستەییەک دروست ناکات و تۆمار ناکرێت. نە کاتژمێری ئامێری کڕیار و نە ساتی دروستکردنی سەبەتە ساتی کڕین دیاری ناکەن.

### 2.10 زیادکەری ئەندامێتی
زیادکەری ئەندامێتی بەپێی بەڵگەنامەی ئەندامێتییەکان لەسەر خاڵە شایستەکان جێبەجێ دەکرێت، و ئەو زیادکەرەی جێبەجێ کراوە لەسەر تۆماری شایستەیی جێگیر دەکرێت و لەگەڵیدا هەڵدەگیرێت.

## 3. ژیانی خاڵێک

### 3.1 دروستکردنی شایستەیی
تۆماری شایستەیی بە دۆخی «هەڵپەسێردراو» لەناو هەمان مامەڵەدا دروست دەکرێت کە داواکارییەکەی جێگیر کرد، نە دوای ئەو و نە لە کاتێکی دواتردا.

### 3.2 ساتی کڕینی تۆمارکراو
ساتی کڕین ئەو ساتەیە کە داواکارییەکە لەسەر ڕاژە جێگیر کرا. نە ساتی کردنەوەی سەبەتە و نە ساتی دەستپێکردنی پارەدان بەکار ناهێنرێن.

### 3.3 ماوەی هەڵپەسێردن
ساتی شایستەیی بە حەوت ڕۆژی تەواو — سەد و شەست و هەشت کاتژمێر — لە ساتی کڕینەوە دیاری دەکرێت، لە کاتی دروستکردندا جێگیر دەکرێت، و دواتر هەرگیز بۆ هیچ هۆیەک پێشخستن یان دواخستنی بۆ ناکرێت.

### 3.4 دوو مەرجی ئازادکردن
خاڵە هەڵپەسێردراوەکان تەنها کاتێک ئازاد دەکرێن کە هەردوو مەرج پێکەوە جێبەجێ بن: تێپەڕبوونی ماوەی چاوەڕوانی، و دانانی نرخی داواکارییەکە. ئەگەر یەکێکیان نەبێت خاڵەکان هەڵپەسێردراو دەمێننەوە.

### 3.5 دانان لە پارەدانی پێشەکیدا
داواکارییەک کە پێشەکی لە جزدانەوە پارەی دراوە لە ساتی کڕیندا دانراوە، بۆیە تەنها تێپەڕبوونی حەوت ڕۆژەکە بەسە.

### 3.6 دانان لە پارەدان لەکاتی وەرگرتندا
داواکارییەک کە لەکاتی وەرگرتندا پارە دەدرێت بە تەنها گەیاندن دانراو نییە، بەڵکو بە تۆمارکردنی کۆکردنەوەی پارە. ئەگەر کۆکردنەوە لە ڕۆژی نۆیەمدا تۆمار بکرێت، خاڵەکان لە ڕۆژی نۆیەمدا ئازاد دەکرێن. دانانی دواکەوتوو ماوەی چاوەڕوانیی نوێ دەست پێ ناکات.

### 3.7 خاڵی هەڵپەسێردراو خەرج ناکرێت
خاڵی هەڵپەسێردراو هەر بوونی لە تۆماری جزداندا نییە، بۆیە ناتوانرێت خەرج بکرێت، نە لە کاتی پارەداندا و نە بە شێوەیەکی تر. ئەمە پێکهاتەی سیستەمەکەیە نەک بەڵێن، بۆیە ڕەوا نییە کڕیار بڵێت ئەو باڵانسەی لە پەڕەی خاڵەکاندا دەرکەوتووە گەورەتر بوو لەوەی لە کاتی پارەداندا وەرگیرا.

### 3.8 میکانیزمی ئازادکردن
ئازادکردن لە ئەرکێکی خشتەکراودا لەسەر ڕاژە و لە کاتی تۆمارکردنی دانانەکەدا ڕوودەدات، و هیچیان تۆمارەکە دووبارە ناکەنەوە. ئازادکردن بەستراوە نییە بە کردنەوەی هیچ پەڕەیەک یان بەرنامەکە لەلایەن کڕیارەوە.

### 3.9 هەڵوەشاندنەوە پێش ئازادکردن
ئەگەر داواکارییەکە پێش ئازادکردنی خاڵەکانی هەڵبوەشێنرێتەوە، شایستەیی هەڵپەسێردراو هەڵدەوەشێتەوە و هیچ شتێک ناچێتە ناو تۆماری جزدانەوە.

## 4. خەرجکردنی خاڵ

### 4.1 لە کوێ خەرج دەکرێن
خاڵە جێگیرەکان وەک کەمکردنەوەیەک لە بەهای کاڵای شایستە خەرج دەکرێن لە کاتی تەواوکردنی داواکارییەک لە فرۆشگای فەرمی Levonis.

### 4.2 بەهای خاڵ لە کاتی خەرجکردن
یەک خاڵ بە تەواوی یەک دیناری عێراقییە لە کاتی خەرجکردندا. حەوتسەد و سی و نۆ خاڵ حەوتسەد و سی و نۆ دینار کەم دەکەنەوە، و بۆ پێنجسەد یان هەزار خڕ ناکرێنەوە.

### 4.3 سنووری بەرزی خەرجکردن لە یەک داواکاریدا
هەموو باڵانسی جێگیر دەکرێت خەرج بکرێت، بەو مەرجەی ئەوەی خەرج دەکرێت لە بەهای کاڵای شایستە لەو داواکارییەدا تێنەپەڕێت، دوای داشکاندنی بەرهەم و ئەندامێتی و کۆپۆن.

### 4.4 ئەوەی خاڵی لەسەر خەرج ناکرێت
- تێچووی گەیاندن و هەر باج و پارەیەکی لەسەری.
- کۆمیسیۆنی گواستنەوە لە داواکاری پێشوەختەدا.
- باجی گەرەنتی درێژکراوە.
- هێڵەکانی فرۆشگاکانی کۆمەڵگەی لێڤۆ و داواکارییەکانیان.
- بەشداری ئەندامێتی.

### 4.5 پارچەی خاڵ نییە
پارچەی خاڵ بوونی نییە. ئەوەی خەرج دەکرێت ژمارەیەکی تەواوی خاڵە.

### 4.6 گەڕاندنەوەی نەقدی نییە
خاڵ بە پارەی نەقد ناگۆڕدرێت، لە جزدانەوە دەرناهێنرێت و بە هیچ شێوەیەک نابێتە باڵانسی نەقدی.

### 4.7 کاریگەری خەرجکردن لەسەر بەدەستهێنانی هەمان داواکاری
ئەو خاڵانەی لەسەر داواکارییەک خەرج دەکرێن لە بنەمای شایستەی ئەو کەم دەکرێنەوە، بۆیە خاڵ دووبارە بەدەست ناهێنرێتەوە لەسەر بەهایەک کە بە خاڵ دراوە.

### 4.8 باڵانسی نەبەس
ئەگەر باڵانسی جێگیر لە پێویست کەمتر بێت تەنها ئەوەی بەردەستە جێبەجێ دەکرێت، و باڵانسی نەرێنی ڕێگەپێدراو نییە.

### 4.9 هەڵوەشاندنەوەی داواکارییەک کە خاڵی لەسەر خەرج کراوە
ئەگەر داواکارییەک هەڵبوەشێنرێتەوە کە خاڵی لەسەر خەرج کرابێت، ئەو خاڵانە بەپێی ماددەی 11.6 بۆ باڵانسی کڕیار دەگەڕێنرێنەوە.

## 5. ئەرکەکانی خاڵ لەناو بەرنامەکەدا

### 5.1 سروشتی ئەرکەکان
پلاتفۆرمەکە ئەرک پێشکەش دەکات کە تەواوکردنیان خاڵ دەبەخشێت. بەهای هەر ئەرکێک نەگۆڕێکە لە بەرنامەی ڕاژەدا، و بەرنامەکە هیچ بەها و ماوە و بەروارێک نانێرێت.

### 5.2 ئامادەبوونی ڕۆژانە
یەک ئەرکی ڕۆژانە بۆ هەر ڕۆژێکی تۆمارکراو. پلیکانەکەی: پێنج خاڵ لە ڕۆژی یەکەم و دووەم، دە لە سێیەم و چوارەم، پازدە لە پێنجەم و شەشەم، و بیست لە ڕۆژی حەوتەمی بەردەوامەوە بەرەو پێشەوە.

### 5.3 ژماردنی ڕۆژانی بەردەوامی
ڕۆژی بەردەوامی لە خودی تۆمارەکانی بەخشیندا لە بنکەدراوەکەوە دەردەهێنرێت، نەک لە ژمێرەرێکی هەڵگیراو لەسەر هەژمار. پچڕانی بەردەوامی ژمێرەرەکە بۆ یەکەم پلەی پلیکانەکە دەگەڕێنێتەوە، کە هەرزانترینیانە.

### 5.4 کارخستنی ئاگادارکردنەوەکان
ئەرکێک کە جارێک بۆ هەژمار لە هەموو تەمەنیدا دەبەخشرێت، بەهای پەنجا خاڵە.

### 5.5 بینینی ڕیکلام
ئەرکێکی ڕۆژانە بە بەهای بیست خاڵ. داوای ناکرێت مەگەر دوای ئەوەی ڕاژە بلیتێکی کاتدار دەردەکات و ماوەی دیاریکراو بە کاتژمێری خودی ڕاژە تێدەپەڕێت.

### 5.6 گەڕان
ئەرکێکی ڕۆژانە بە بەهای بیست خاڵ، و داوای ناکرێت پێش تێپەڕبوونی سەد و هەشتا چرکە بە کاتژمێری ڕاژە لە ڕێگەی نبزی ڕاستکراوەوە.

### 5.7 جارێک لە هەر ماوەیەکدا
ئەرکی ڕۆژانە جارێک لە ڕۆژی تۆمارکراودا دەبەخشرێت، و ئەرکی جارێکی تەنها جارێک بۆ هەمیشە. داواکاری دووەم هیچ ناجوڵێنێت و ڕەتکردنەوەکەی بە ڕوونی ڕادەگەیەنرێت.

### 5.8 ئەوەی ڕاژە دەتوانێت بیسەلمێنێت و ئەوەی ناتوانێت
ئامادەبوون بە تەواوی لەلایەن ڕاژەوە لە کاتژمێر و تۆمارەکانی خۆیەوە دەسەلمێنرێت. بەڵام کارخستنی ئاگادارکردنەوەکان و بینینی ڕیکلام و گەڕان، ڕاژە هیچ بەڵگەیەکی نییە لەسەر ئەوەی بەڕاستی ڕوویانداوە؛ زۆرترین ئەوەی دەیسەلمێنێت ئەوەیە کە ماوەیەکی دیاریکراو بە کاتژمێری خۆی تێپەڕیوە. ئەم ڕاستییە لە خودی پەڕەکەدا بۆ کڕیار پیشان دەدرێت و دواتر ڕەخنەی لێ ناگیرێت.

### 5.9 مافی فرۆشگا بۆ کوژاندنەوەی ئەرکێک
فرۆشگا دەتوانێت ئەرکی ئاگادارکردنەوە یان ڕیکلام یان گەڕان بکوژێنێتەوە، و ماوەی دیاریکراوی ڕیکلام بگۆڕێت، بەبێ ئاگادارکردنەوەی پێشوەختە. ئەرکی کوژاوە بە هۆکارێکی ڕاگەیەنراو ڕەت دەکرێتەوە، و هیچ مافێکی بەدەستهاتوو دروست ناکات بۆ ئەو کەسەی پێش کوژاندنەوەکە داوای نەکردووە.

### 5.10 زیادکەر لەسەر ئەرکەکان
زیادکەری ئەندامێتی لەسەر خاڵی ئەرکەکان جێبەجێ دەکرێت، و ئەو زیادکەرەی جێبەجێ کراوە لەسەر تۆماری بەخشین هەڵدەگیرێت، تاوەکو جیاوازی نێوان بەخشینی ئەمڕۆ و دوێنێ ڕوون بکرێتەوە.

## 6. زیادکەر و کاریگەری کۆتاییهاتنی ئەندامێتی

### 6.1 سەرچاوەی زیادکەر
زیادکەر لە پلەی ئەندامێتی کڕیارەوە دێت کە لە ساتی بەخشین یان کڕیندا کاری پێدەکرا، بەپێی بەڵگەنامەی ئەندامێتییەکان.

### 6.2 جێگیرکردن
زیادکەر لەسەر تۆماری شایستەیی یان لەسەر تۆماری بەخشین لە ساتی سەرهەڵدانیدا جێگیر دەکرێت.

### 6.3 ئەندامێتییەک کە دوای کڕین کۆتایی دێت
ئەندامێتییەک کە دوای ساتی کڕین کۆتایی دێت خاڵی داواکارییەکی پێشووتر کەم ناکاتەوە و ئەوەی جێگیر بووە ناگۆڕێت.

### 6.4 زیادکەر لە گەڕاندنەوەی بەشەکیدا
ئەو خاڵانەی دەگەڕێنرێنەوە بەو زیادکەرە دەژمێردرێن کە لەسەر هەمان داواکاری جێگیر کراوە، هەرگیز بە زیادکەرێکی نوێ. بۆیە ئەندام لەو بەشە زیادکراوەی کاڵاکە بێبەش ناکرێت کە هێشتاشی لای ماوەتەوە.

### 6.5 زیادکەری دواکەوتوو نییە
بەرزکردنەوەی ئەندامێتی خاڵی داواکارییەکی پێشوو یان بەخشینێکی پێشوو بەرز ناکاتەوە.

### 6.6 بەهاکانی زیادکەر
ئەندامی LEVO PREMIUM: یەک و نیو. ئەندامی PRO: دوو ئەوەندە. کەسانی تر: یەک ئەوەندە بەبێ زیادکردن. زیادکەرەکە لەسەر خاڵی ئامادەبوون و ئەرکەکان و کڕین و پێداچوونەوە جێبەجێ دەکرێت.

### 6.7 خڕکردنەوە
کاتێک لێکدان پارچەی خاڵ دروست دەکات، نیوەکە بەرەو سەرەوە خڕ دەکرێتەوە. پێنج خاڵ بە زیادکەری یەک و نیو دەبێتە هەشت خاڵ نەک حەوت. زیادکەری دوو ئەوەندە و یەک ئەوەندە هیچ پارچەیەک دروست ناکەن.

### 6.8 سوودی سنووردارکراو
کاتێک سنوورێکی کارگێڕی زیندوو لەسەر هەژمار سوودی زیادکەر ڕادەگرێت، خاڵەکان بە زیادکەری ئاسایی دەژمێردرێن بۆ ماوەی سنوورەکە، و ئەمە لەسەر تۆماری بەخشین پیشان دەدرێت.

## 7. پێداچوونەوەکان و خاڵەکانیان

### 7.1 کێ دەتوانێت پێداچوونەوە بکات
پێداچوونەوە کراوەیە بۆ ئەو کڕیارەی بەڕاستی بەرهەمەکەی وەرگرتووە لە داواکارییەکدا کە وەک گەیەنراو لە هەژمارەکەیدا تۆمار کراوە. هەر کڕیارێک یەک پێداچوونەوەی هەیە بۆ هەر بەرهەمێک.

### 7.2 بڵاوکردنەوەی دەستبەجێ
پێداچوونەوە هەر کە نێردرا بڵاو دەکرێتەوە. چاوەڕێی پەسەندکردنی کارگێڕی ناکات بۆ ئەوەی دەربکەوێت.

### 7.3 سنووری ناوەڕۆک
- دەقی پێداچوونەوە لە چوار هەزار پیت تێناپەڕێت.
- وێنەکان بە شەش سنووردارن، و هیچ وێنەیەک لە هەشت مێگابایت تێناپەڕێت.
- ڤیدیۆ لە چل مێگابایت تێناپەڕێت.
- ژمارەی ئەو پێداچوونەوانەی لە یەک هەژمارەوە دەنێردرێن لە کاتژمێردا سنووردارە، بۆ ڕێگریکردن لە لافاو.

### 7.4 پلەی جۆرایەتی
سیستەمەکە جۆرایەتی پێداچوونەوە بە پێوانەیەکی خۆکاری نەگۆڕ دەپێوێت، لە سوودمەندی دەق و ژمارەی وێنە جیاوازەکان و جۆرایەتییان و بوونی ڤیدیۆ و جۆرایەتییەکەی و بوونی بەڵگەی هەمیشەیی. تۆنی بۆچوون هیچ ڕۆڵێکی لەو پێوانەیەدا نییە: پێداچوونەوەیەکی سوودمەند بە یەک ئەستێرە دەتوانێت بگاتە ئەوەی پێداچوونەوەیەکی سوودمەند بە پێنج ئەستێرە پێی دەگات.

### 7.5 خاڵی پێداچوونەوە خۆکارە
پێداچوونەوەی دەستیی دروست کە نەگاتە یەکێک لە پلەکانی دیاری، خاڵەکانی بە شێوەی خۆکار دەبەخشرێن لە خودی ئەو مامەڵەیەدا کە پێداچوونەوەکەی پاراست، بەبێ بڕیاری کارگێڕی و بەبێ چاوەڕوانی. ئەمە دۆخی باوە.

### 7.6 بەهای خاڵی پێداچوونەوە
بەهای خاڵی پێداچوونەوە دوو ئەوەندەی بەها بنەڕەتییەکەیە کە لە ڕێکخستنەکانی فرۆشگادا بڵاو کراوەتەوە، و پاشان زیادکەری ئەندامێتی لەسەری جێبەجێ دەکرێت. بەها بنەڕەتییەکەی کاری پێدەکرێت: {{REVIEW_BASE_POINTS}}.

### 7.7 ئەگەر بەها بنەڕەتییەکە دیاری نەکرابێت
ئەگەر بەها بنەڕەتییەکە لە ڕێکخستنەکانی فرۆشگادا دیاری نەکرابێت، هیچ خاڵی پێداچوونەوە نابەخشرێت، و ئەمە بە ڕوونی لە پەڕەکەدا بە کڕیار ڕادەگەیەنرێت. سیستەمەکە هیچ بەهایەک داناهێنێت، و هیچ مافێکی دواکەوتوو بۆ کڕیار سەرهەڵنادات کاتێک بەهایەک دواتر دیاری دەکرێت.

### 7.8 پێداچوونەوەیەک کە دەگاتە پلەی دیاری
پێداچوونەوەیەک کە دەگاتە یەکێک لە پلەکانی دیاری، خاڵی خۆکاری پێداچوونەوەی پێ نابەخشرێت، چونکە چووەتە ناو ڕێچکەی دیاری کە لە بەشی هەشتەمدا هاتووە.

### 7.9 دەستکاریکردنی پێداچوونەوە
کڕیار دەتوانێت پێداچوونەوەکەی دەستکاری بکات تا ئەو کاتەی بڕیار لەسەر پاداشتەکەی نەدراوە. ئەگەر دەستکارییەکە پێداچوونەوەکە بخاتە خوارتر لە پلەی دیاری، پێداچوونەوەکە بڵاوکراوە دەمێنێتەوە، ڕەتکردنەوەی پاداشتی دیاری بە هۆکارێکی نووسراو تۆمار دەکرێت، و پێداچوونەوەکە خاڵی خۆکاری خۆی وەردەگرێت وەک هەر پێداچوونەوەیەکی دەستیی دروست.

### 7.10 سڕینەوە یان شاردنەوەی پێداچوونەوە
فرۆشگا دەتوانێت پێداچوونەوەیەک بشارێتەوە یان بیسڕێتەوە کە پێچەوانەی یاساکانی ناوەڕۆکە لە مەرجەکانی بەکارهێنانی ماڵپەڕ و بەرنامەدا. ئەوە بڕیار لەسەر پاداشت نییە، هەروەک ڕەتکردنەوەی پاداشت سڕینەوەی پێداچوونەوە نییە: هەردوو بڕیارەکە سەربەخۆن.

### 7.11 ئاشکراکردن
ئەو پێداچوونەوانەی لەناو پرۆگرامی پاداشتدا کراون لە پەڕەی گشتیدا نیشانە دەکرێن، بۆ پاراستنی مافی خوێنەر بۆ زانینی ئەوە.

### 7.12 تایبەتمەندیی بەڵگەی ئینستاگرام
بەڵگەی ستۆری بە شێوەی تایبەت هەڵدەگیرێت، تەنها بۆ خاوەنەکەی و کارگێڕی فرۆشگا پیشان دەدرێت، و هەرگیز لە هیچ پیشاندانێکی گشتیدا دەرناکەوێت.

## 8. دیاری پێداچوونەوە

### 8.1 چییە
سندوقێکی ماددی لە کۆگای دیاری چاپکەرەکان، بە پێنج پلە: یەکەم پێداویستییەک، دووەم دەزووی چاپ، سێیەم دەزووی چاپ و پێداویستییەک، چوارەم لوولەی چاپ، و پێنجەم لوولە و تەختە.

### 8.2 دیاری بڕیارێکی سەربەخۆی فرۆشگایە
دیاری مافێک نییە کە بە شێوەی خۆکار لە نووسینی پێداچوونەوەوە بێت، نە لە گەیشتن بە پلەیەکی دیاریکراوی جۆرایەتی. پێداچوونەوەی شایستە دەچێتە ناو ڕیزی هەڵسەنگاندن، و بڕیارێکی کارگێڕی هۆکاردار لەسەری دەردەچێت بە یەکێک لە سێ شێوە: پەسەندکردن بە پلەیەک، یان داواکردنی گۆڕانکاری، یان ڕەتکردنەوە. تەنها پەسەندکردن شایستەیی دروست دەکات.

### 8.3 مەرجەکانی چوونە ناو ڕیزەکە
پێداچوونەوە ناچێتە ناو ڕیزی دیاری مەگەر گەیشتبێتە پلەیەکی جۆرایەتی کە بە خۆکاری پێورابێت، لەگەڵ دەقێکی بەپێی پێویست ورد و وێنەی جیاواز. پلە بەرزەکان سەرەڕای ئەوە ڤیدیۆی سوودمەند و بەڵگەی هەمیشەیی دەخوازن.

### 8.4 بڕیارەکە هۆکاردارە
هیچ پەسەندکردن و ڕەتکردنەوە و داواکردنی گۆڕانکارییەک بەبێ هۆکارێکی نووسراو دەرناچێت کە بە خاوەنی پێداچوونەوەکە پیشان دەدرێت.

### 8.5 بڕیارەکە دووبارە ناکرێتەوە
ئەو پاداشتەی پەسەند کراوە دووبارە بڕیاری لەسەر نادرێتەوە و بە بڕیارێکی دواتر نافەوتێنرێت، جگە لە دۆخەکانی خراپ بەکارهێنان کە لە بەشی سێزدەیەمدا هاتوون.

### 8.6 یەک شایستەیی بۆ هەر پێداچوونەوەیەک
پەسەندکردن تەنها یەک شایستەیی دیاری دروست دەکات بۆ هەر پێداچوونەوەیەک.

### 8.7 هەڵبژاردنی سندوق
خاوەنی شایستەیی یەک سندوق هەڵدەبژێرێت بە پلەیەک یەکسان یان خوارتر لە پلەی خۆی. هەڵبژاردنەکە کۆتاییە و دووبارە ناکرێتەوە.

### 8.8 ناوەڕۆکی سندوق
ناوەڕۆکەکە لەلایەن ڕاژەوە لە بەرهەمی بەڕاستی بەردەست لە کۆگادا دیاری دەکرێت، جارێک جێگیر دەکرێت، و دوای جێگیرکردن هەرگیز دووبارە هەڵناکێشرێتەوە و ناگۆڕدرێت.

### 8.9 تەواوبوونی کۆگا
ئەگەر ئەوەی لە پلەیەکدا بەردەستە تەواو بێت، ئەو پلەیە ناتوانرێت هەڵبژێردرێت تا جێگرەوەیەک بەردەست دەبێت. بە پارە یان بە خاڵ ناگۆڕدرێت.

### 8.10 دیاری ماددییە
دیاری تەنها ماددییە، و بە پارە یان باڵانسی جزدان یان داشکاندن لەسەر داواکارییەک ناگۆڕدرێت.

### 8.11 گەیاندنی دیاری
دیاری بەو شێوەیە دەگەیەنرێت کە کارگێڕی دیاری دەکات، و حوکمەکانی ئاسایی گەیاندن و تێچووەکانی لەسەری جێبەجێ دەکرێن.

### 8.12 پێداچوونەوە خۆکارە دروستکراوەکان
ئەو پێداچوونەوەیەی سیستەمەکە دروستی دەکات بە هیچ شێوەیەک پاداشتی پێ نابەخشرێت و ناچێتە ناو ڕیزی دیارییەکان.

## 9. پلەدانی خۆکار دوای حەوت ڕۆژ

### 9.1 چییە
دوای تێپەڕبوونی حەوت ڕۆژ بەسەر گەیاندنی بەرهەمێکدا کە کڕیار هیچ پێداچوونەوەیەکی لەسەر نەنووسیوە، سیستەمەکە پلەدانێکی خۆکاری بڵاوکراوە بە پێنج ئەستێرە بەبێ دەق و بەبێ میدیا تۆمار دەکات.

### 9.2 هیچ پاداشتێکی لەسەر نییە
ئەم پلەدانە هیچ پاداشتێک دروست ناکات و تەنانەت یەک خاڵیش تۆمار ناکات، چونکە کرداری کڕیار نییە.

### 9.3 نیشانەکردنی
ئەم پلەدانە لە پیشاندانی گشتیدا نیشانە دەکرێت وەک دەرچووی سیستەم نەک کڕیار.

### 9.4 گۆڕینی بە پێداچوونەوەیەکی ڕاستەقینە
خاوەن هەژمار دەتوانێت هەر کاتێک بە پێداچوونەوەیەکی ڕاستەقینە بیگۆڕێت؛ ئەو پێداچوونەوەیە جێگەی دەگرێتەوە و حوکمی پێداچوونەوەی دەستیی وەردەگرێت لە خاڵ یان لە ڕێچکەی دیاریدا.

## 10. ناردنەکان

### 10.1 چۆن ناردنێک سەرهەڵدەدات
ناردن سەرهەڵدەدات کاتێک هەژمارێکی نوێ بە کۆدی ناردن یان بەستەری ناوی بەکارهێنەر دروست دەکرێت. جارێک، لە کاتی دروستکردندا، تۆمار دەکرێت.

### 10.2 نە دەگوازرێتەوە و نە دەکرێتەوە
ناردن دوای تۆمارکردنی بە نێرەرێکی تر پەیوەست ناکرێت، ناگوازرێتەوە، و بە داواکاری دووبارە لێی نادرێتەوە.

### 10.3 ناردنی خۆیی
ناردنی کەسێک بۆ خۆی وەرناگیرێت، نە ناردن لە ڕێگەی هەژمارێکی دووەمەوە کە نێرەرەکە دەیکاتەوە. وەک هەژماری فرە مامەڵەی لەگەڵ دەکرێت بەپێی بەڵگەنامەی تۆمارکردن.

### 10.4 پرۆگرامی چاپکەر: ئەوەی هاوڕێکە وەریدەگرێت
هەژماری نێردراو لە تێچووی گەیاندن بێبەش دەکرێت لە یەک داواکاری شایستەدا کە چاپکەرێکی تێدا بێت لە کاتالۆگە پەسەندکراوەکانی چاپکەر. بێبەشکردنەکە تەنها بۆ یەک داواکارییە.

### 10.5 بەکارهێنانی بێبەشکردنەکە
بێبەشکردنەکە بە یەکەم داواکاری شایستە بەکار دەهێنرێت کە هەڵیدەگرێت و هەڵنەوەشێنراوەتەوە، نەک بە چاوەڕوانی گەیاندنی. بۆیە ئەو داواکارییەی بێبەشکردنەکەی هەڵگرتووە مافەکە بەکار دەهێنێت تەنانەت پێش گەیشتنیشی.

### 10.6 پرۆگرامی چاپکەر: ئەوەی نێرەر وەریدەگرێت
شایستەییەکی هەڵپەسێردراو بۆ نێرەر تۆمار دەکرێت کاتێک گەیاندنی داواکارییە شایستەکە تۆمار دەکرێت، و شایستەییەکەی بە حەوت ڕۆژ لە بەرواری گەیاندنی تۆمارکراوەوە دیاری دەکرێت.

### 10.7 پرۆگرامی ئەندامێتی PRO
ئەگەر کەسی نێردراو بەشداری PRO ی پارەدراو بکڕێت، شایستەییەکی شایستە بۆ نێرەر سەرهەڵدەدات لە ساتی تۆمارکردنی کڕینەکەدا. هەڵوەشاندنەوەی ئەو بەشدارییە ئەم شایستەییە هەڵدەوەشێنێتەوە، چونکە هۆکارەکەی ئەو پارەدانە بوو کە نەماوە.

### 10.8 دیاری کۆدی پشتگیری
ئەو کەسەی چاپکەرێکی شایستەی لە ڕێگەی کۆدی پشتگیری یان بەستەری هاوبەشکردنەوە کڕیوە، و پاشان داواکارییەکەی گەیەنراوە و نرخەکەی دانراوە، یەک شایستەیی دیاری دەزووی چاپ بۆ خاوەنی ئەو کۆدە دروست دەکات.

### 10.9 ئەوەی لە دیاری کۆدی پشتگیریدا داوا ناکرێت
لە خاوەنی کۆدەکە داوا ناکرێت ئەندامی PRO بێت، لە کڕیارەکە داوا ناکرێت هەژمارێکی نوێ بێت، و هیچ ماوەیەکی چاوەڕوانی حەوت ڕۆژە نادرێتەسەر. ماوەی حەوت ڕۆژ تەنها هی خاڵی کڕینە.

### 10.10 دۆخەکانی ڕاگرتن بۆ پێداچوونەوە
سیستەمەکە شایستەیی بۆ پێداچوونەوەی دەستی ڕادەگرێت، نەک بۆ ڕەتکردنەوە، لە دوو دۆخدا: کاتێک شایستەییەک بەپێی پرۆگرامی کۆنی چاپکەر لەسەر هەمان داواکاری تۆمار کرابێت، و کاتێک داواکاری گەڕاندنەوەیەک لەسەر داواکارییەکە کراوە بێت و ڕەت نەکرابێتەوە. لە هەردووکیاندا بە بڕیارێکی کارگێڕی هۆکاردار بڕیار دەدرێت.

### 10.11 قۆناغەکانی شایستەیی دیاری
شایستەیی دیاری کۆدی پشتگیری بە قۆناغی تۆمارکراودا تێدەپەڕێت: لە ژێر شایستەیی، پاشان شایستە، پاشان گیراو، پاشان گەیەنراو. هەر قۆناغێکی زیندوو هەڵدەوەشێتەوە ئەگەر هۆکارەکەی نەما.

### 10.12 ئەوەی ناردن و پاداشتەکەی دەفەوتێنێت
پاداشتەکە دەفەوتێت ئەگەر ئەو داواکارییەی هۆکاری بوو هەڵبوەشێتەوە، یان بەرهەمەکە بگەڕێندرێتەوە، یان دەربکەوێت هەژماری نێردراو هی کەسێکی سەربەخۆ نییە، یان هەژماری فرە یان کۆدی دەستکرد بۆ بەدەستهێنانی بەکارهێنرابێت.

### 10.13 داخستنی هەژمار
ناردنە تۆمارکراوەکان وەک ڕووداوی تۆمارکراو دەمێننەوە؛ نە بۆ نێرەر دەگەڕێنرێنەوە و نە بۆ کەسێکی تر دەگوازرێنەوە. بەستەری ناردنی هەژمارێکی داخراو لە کارکردن دەوەستێت.

## 11. گەڕاندنەوەی خاڵ و کشاندنەوەی پاداشت

### 11.1 هۆکارەکانی گەڕاندنەوە
ئەوەی کڕیار شایستەی نییە دەگەڕێندرێتەوە: خاڵی داواکارییەکی هەڵوەشێنراوە، خاڵی ئەو بەهایەی بۆی گەڕێنراوەتەوە، خاڵی پێداچوونەوەیەک کە سەلمێنرا ساختەیە، و پاداشتی ناردنێک کە هۆکارەکەی نەماوە.

### 11.2 شێوازی گەڕاندنەوە
گەڕاندنەوە بە دووبارە ژماردنی شایستەیی لە بنەمای شایستەی ماوە دوای گەڕاندنەوەکە دەژمێردرێت، و پاشان جیاوازییەکە وەک تۆمارێکی نەرێنی تۆمار دەکرێت. هیچ تۆمارێکی پێشوو ناسڕدرێتەوە و هیچ مێژووێک نافەوتێت.

### 11.3 بۆچی بەشە گەڕێنراوەکە بە تەنها ناژمێردرێت
ئەگەر بەشە گەڕێنراوەکە بە تەنها بژمێردرایە، ژماردنەکە لە بنەمای داواکارییەکە لادەدا لە کاتی دووبارەبوونەوەی گەڕاندنەوەی بەشەکیدا. بۆیە سەرچاوە هەمیشە ئەوەیە کە ماوەتەوە، نەک ئەوەی ڕۆیشتووە.

### 11.4 بەشی هێڵەکە لە داشکاندنەکان
بەشی هێڵە گەڕێنراوەکە بە هەمان ڕێژەی داشکاندنی داواکارییەکە کەم دەکرێتەوە، بۆیە کڕیار تەنها خاڵ لەسەر ئەو پارەیە لەدەست دەدات کە بەڕاستی لەو هێڵەدا داویەتی.

### 11.5 زیادکەر لە کاتی گەڕاندنەوەدا
گەڕاندنەوە بەو زیادکەرە دەژمێردرێت کە لە کاتی کڕیندا لەسەر داواکارییەکە جێگیر کراوە، و بە هیچ زیادکەرێکی تر.

### 11.6 ئەو خاڵانەی لەسەر داواکارییەکی هەڵوەشێنراوە خەرج کراون
ئەو خاڵانەی لەسەر داواکارییەک خەرج کراون کە هەڵدەوەشێتەوە بۆ باڵانسی کڕیار دەگەڕێنرێنەوە.

### 11.7 باڵانس دوای گەڕاندنەوە
ئەگەر کڕیار پێشتر خاڵی خەرج کردبێت کە دواتر گەڕێنرابێتەوە، فرۆشگا دەتوانێت جیاوازییەکە لە باڵانسی دواتریدا ڕێک بخات. لە کڕیار داوای پارەی نەقدی لێ ناکرێت لەسەر ئەو خاڵانەی خەرج کراون.

### 11.8 پێداچوونەوەی کشێنراوە
کشاندنەوە یان سڕینەوەی پێداچوونەوەیەک بەهۆی پێشێلکردنی یاساکانی ناوەڕۆک، ڕێگە دەدات بە گەڕاندنەوەی خاڵەکانی کاتێک پێشێلکارییەکە دەگاتە ڕاستی خودی پێداچوونەوەکە.

### 11.9 ئاگادارکردنەوە
هۆکاری هەر گەڕاندنەوەیەک لە تۆماری خاڵەکاندا ڕوون دەکرێتەوە، و کڕیار دەتوانێت لە پەڕەی خاڵەکانەوە بیبینێت.

## 12. مانەوە و پچڕان و ئاشکراکردنی باڵانس

### 12.1 بە تێپەڕبوونی کات کۆتایی نایەت
خاڵ بە تێپەڕبوونی کات بەسەر ناچێت. هیچ شتێک لە سیستەمی فرۆشگادا نییە کە خاڵ بەهۆی بەکارنەهێنانەوە بفەوتێنێت.

### 12.2 چۆن خاڵ کەم دەبێت
خاڵ تەنها بە سێ شێوە کەم دەبێت: خەرجکردنی لە داواکارییەکدا، گەڕاندنەوەی بەپێی بەشی یازدەیەم، یان نەمانی ئەو هەژمارەی سەر بەوە.

### 12.3 ڕاگرتنی هەژمار
ڕاگرتنی هەژمار بەکارهێنانی خاڵەکان بۆ ماوەی ڕاگرتنەکە دەبەستێتەوە، و ئەوە فەوتاندنیان نییە. حوکمەکانی ڕاگرتن لە بەڵگەنامەی تۆمارکردندان.

### 12.4 داخستنی هەژمار
بە داخستنی هەژمار خاڵەکان دەفەوتێن؛ بە پارە قەرەبوو ناکرێنەوە و بۆ هەژمارێکی تر ناگوازرێنەوە.

### 12.5 گۆڕینی پرۆگرام
فرۆشگا دەتوانێت ڕێژەکانی بەدەستهێنان و بەهای ئەرکەکان و ناوەڕۆکی دیارییەکان بۆ داهاتوو بگۆڕێت. ئەو خاڵانەی پێش گۆڕانکارییەکە جێگیر بوونە کاریگەر نابن پێی.

### 12.6 ئاشکراکردنی باڵانس
پەڕەی خاڵەکان باڵانسی جێگیر و خاڵە هەڵپەسێردراوەکان و تۆماری جوڵانەوەکانی بۆ کڕیار پیشان دەدات، لەگەڵ هۆکاری هەر جوڵانەوەیەک و بەرواری و ئەو زیادکەرەی لەسەری جێبەجێ کراوە.

### 12.7 تانە لە باڵانس
ئەو کڕیارەی هەڵەیەک لە باڵانسەکەیدا دەبینێت دەتوانێت لە ڕێگەی کەناڵی پشتگیری پەسەندکراوەوە تانە بدات، بە ڕوونکردنەوەی ئەو جوڵانەوەیەی تانەی لێ دەدات و بەرواری. تانەکەی بە بڕیارێکی هۆکاردار وەڵام دەدرێتەوە کە پشت بە تۆمارەکانی فرۆشگا دەبەستێت.

### 12.8 جیاوازی نێوان دوو ژمارەکە
کاتێک ئەو ژمارەیەی لە پەڕەی خاڵەکاندا دەرکەوتووە جیاواز بێت لەو ژمارەیەی لە کاتی پارەداندا وەرگیراوە، هۆکارەکە زۆرجار خاڵی هەڵپەسێردراوە کە هێشتا جێگیر نەبووە، یان سنووری خەرجکردن لە ماددەی 4.3. تۆماری جزدان ئەوەیە کە بنەمایە.

## 13. خراپ بەکارهێنان

### 13.1 بنەما
پرۆگرامەکانی پاداشت بۆ یەک کڕیاری ڕاستەقینە داڕێژراون کە بۆ خۆی دەکڕێت و بۆچوونی خۆی دەنووسێت. هەموو بەکارهێنانێکی دەرەوەی ئەوە خراپ بەکارهێنانە.

### 13.2 شێوەکانی خراپ بەکارهێنان
- کردنەوەی هەژماری فرە بۆ بەدەستهێنانی خاڵ یان ناردن یان بێبەشکردن.
- کڕینێک کە هەڵدەوەشێتەوە یان دەگەڕێندرێتەوە بۆ کۆکردنەوەی خاڵ.
- پێداچوونەوەی ساختە، یان لەبەرگیراو لە کەسێکی تر، یان بە وێنە و ڤیدیۆی نا پەیوەست بە بەرهەمەکە، یان دووبارەکەرەوەی پێداچوونەوەیەکی پێشووی هەمان هەژمار.
- پێداچوونەوە لە بەرامبەر پارە لە فرۆشیارێک یان لە کەسێکی تر لە دەرەوەی پرۆگرامی فرۆشگا.
- بەکارهێنانی بەرنامەی خۆکار بۆ داواکردنی ئەرکەکان، یان بانگکردنی خاڵی ئەرکەکان لە دەرەوەی بەرنامەکە.
- دروستکردنی دەستکردی کۆدی پشتگیری یان بەستەری هاوبەشکردن بۆ دروستکردنی شایستەیی.
- بەکارهێنانی هەڵەیەکی ئاشکرا لە سیستەمەکەدا دوای زانینی.

### 13.3 بۆچوونی نەرێنی خراپ بەکارهێنان نییە
پێداچوونەوەی نەرێنی ڕاستگۆ خراپ بەکارهێنان نییە، و خاوەنەکەی نابێت لەبەر ئەو لە پاداشت بێبەش بکرێت. پێوانەکە سوودمەندی و ڕاستگۆیی پێداچوونەوەکەیە، نەک ڕەزامەندی فرۆشگا لێی.

### 13.4 ڕێوشوێنەکان
لە کاتی خراپ بەکارهێناندا فرۆشگا دەتوانێت: خاڵە پەیوەندیدارەکان بگەڕێنێتەوە، شایستەیی دیاری نەگەیەنراو بکشێنێتەوە، هەژمارەکە لە پرۆگرامەکانی پاداشت قەدەغە بکات، و لە کاتی گەورەییدا بەرەو ڕێوشوێنەکانی هەژمار لە بەڵگەنامەی تۆمارکردندا بەرزی بکاتەوە.

### 13.5 هاوسەنگی
ڕێوشوێنەکە بەقەد ڕووداوەکە دەبێت. باڵانسێکی تەواو لەبەر یەک ڕووداو کە دەکرێت بە تایبەتی بگەڕێندرێتەوە دەستبەسەردا ناگیرێت.

### 13.6 تانە
خاوەن هەژمار دەتوانێت لە ماوەی {{ACCOUNT_APPEAL_DAYS}} لە ڕێگەی کەناڵی پشتگیری پەسەندکراوەوە تانە لەو ڕێوشوێنە بدات کە لە دژی وەرگیراوە، و بە بڕیارێکی هۆکاردار بڕیاری لەسەر دەدرێت.

### 13.7 بەڵگەکان
فرۆشگا لە سەلماندنی خراپ بەکارهێناندا پشت بە تۆمارەکانی خۆی دەبەستێت: تۆماری بەخشین، تۆماری جزدان، تۆماری پشکنین، و تۆماری گەیاندن و دانان.

### 13.8 بەبێ زیان
ڕێوشوێنەکانی ئەم بەشە زیان بە مافی فرۆشگا ناگەیەنن بۆ داواکردنی ئەو زیانەی بەرکەوتووە بەپێی یاسا.

## 14. حوکمە کۆتاییەکان

### 14.1 گۆڕانکاری
فرۆشگا دەتوانێت ئەم بەڵگەنامەیە بگۆڕێت بە دەرکردنی وەشانێکی نوێ بە ژمارە و بەرواری کارپێکردن؛ گۆڕانکاری بە کاریگەری دواکەوتوو لەسەر ڕووداوێک جێبەجێ نابێت کە پێش کارپێکردنی تەواو بووە.

### 14.2 پێشینە لە کاتی ناکۆکیدا
کاتێک دەقی ئەم بەڵگەنامەیە لەگەڵ بەڵێنێکی زارەکی یان نامەیەکی کارمەند یان بڵاوکراوەیەکی بازرگانی یان وێنەیەک لە ڕیکلامدا ناکۆک بێت، دەقی ئەم بەڵگەنامەیە بنەمایە.

### 14.3 کاریگەری تۆمارەکان
تۆمارە ئەلیکترۆنییەکانی فرۆشگا سەرچاوەن لە سەلماندنی بەخشین و خەرجکردن و گەڕاندنەوە و کاتەکانیان.

### 14.4 سەربەخۆیی بڕگەکان
پووچی بڕگەیەک کاریگەری لەسەر دروستی بڕگەکانی تر نییە.

### 14.5 یاسا و دەسەڵاتی دادوەری
ئەم بەڵگەنامەیە بە {{GOVERNING_LAW_JURISDICTION}} ڕێک دەخرێت، و {{COMPETENT_COURT}} دەسەڵاتی هەیە لەسەر ناکۆکییەکان.

### 14.6 پەیوەندی
کەناڵی پەیوەندی پەسەندکراو سەبارەت بەم بەڵگەنامەیە: {{LEVONIS_SUPPORT_CONTACT}}، لە کاتەکانی {{LEVONIS_SUPPORT_HOURS}}.`,
  },
};
