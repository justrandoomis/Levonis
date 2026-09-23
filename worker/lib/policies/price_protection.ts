import type { PolicyDocument } from './types';

/**
 * سياسة الأسعار وتغييرها وإلغاء الطلب.
 *
 * WHY THIS DOCUMENT EXISTS SEPARATELY. It carries the owner's clause 6 in
 * full — the Store may cancel an unpaid order or correct its price, and once
 * the customer has paid, the paid price stands and the Store absorbs any
 * increase — together with the two things that clause is always argued about:
 * a price that moved between the cart and the checkout, and a price that fell
 * after delivery.
 *
 * WHY CHAPTER 5 DOES NOT PROMISE AN IN-PLACE REPRICE. Nothing in the code
 * edits the total of an order that already exists: an unpaid order is
 * corrected by agreeing the correction with the customer, or by cancelling it
 * and reissuing at the corrected price. Writing it that way keeps the article
 * describing a process that exists.
 *
 * WHY CHAPTER 10 IS SO SPECIFIC. The seven-day claim is a real, implemented
 * decision path with real refusals (a bundle as a whole, a mystery line, an
 * order older than exact variant tracking), and a claim that is refused for a
 * reason the customer could have read in advance is a support argument the
 * document should have prevented.
 *
 * VERSION 2 — WHY IT MOVED. One correction a customer could see on the page;
 * the archive keeps version 1 byte for byte. This is the only document in the
 * corpus that never spelled the store's name in Arabic or Sorani, so the
 * brand pass left it alone.
 *   * THE UNKNOWNS. 6 articles and 6 further lines in this document still state a
 *     fact the owner has not given, so ./render.ts WITHHOLDS them from the published
 *     text rather than show a customer a `{{TOKEN}}`. They are still authored
 *     below, and each one returns of its own accord the moment its value is
 *     written in and the version moves again.
 */
export const price_protection: PolicyDocument = {
  key: 'price_protection',
  version: 2,
  effective_at: '2026-01-01',
  title: {
    ar: 'سياسة الأسعار وتغييرها وإلغاء الطلب',
    en: 'Pricing, Price Changes and Order Cancellation Policy',
    ckb: 'سیاسەتی نرخ، گۆڕانی نرخ و هەڵوەشاندنەوەی داواکاری',
  },
  body: {
    ar: `## 1. التمهيد والتعريفات

### 1.1 الغرض من هذه الوثيقة
تبيّن هذه الوثيقة كيف يُحدَّد السعر، ومتى يجوز للمتجر تغييره أو إلغاء الطلب، وما يحدث للمال عند الإلغاء، وكيف تُعالَج أخطاء التسعير، وما يضمنه العرض أو خصم العضوية وما لا يضمنه، وحماية السعر بعد التسليم.

### 1.2 التعريفات
- السعر المعروض: الرقم الظاهر على صفحة المنتج أو في السلة قبل إتمام الطلب.
- السعر المحتسب: الرقم الذي يحتسبه الخادم لحظة إنشاء الطلب، وهو المعتمد.
- الطلب غير المدفوع: الطلب الذي لم يُستوفَ عنه مال، لا من المحفظة ولا عند الباب.
- الطلب المدفوع: الطلب الذي خُصمت قيمته من المحفظة أو سُجّل تحصيله.
- خطأ التسعير الظاهر: رقم يظهر لأي قارئ عاقل أنه ليس السعر المقصود.
- نافذة العرض: المدة المعلنة بين بداية العرض ونهايته.
- حماية السعر: مطالبة الزبون بفرق السعر عن قطعة سُلِّمت إليه ثم انخفض سعرها خلال سبعة أيام.

### 1.3 النص المعتمد
النص العربي هو المعتمد، والنسختان الإنكليزية والكردية ترجمتان أمينتان له بالترقيم نفسه.

### 1.4 علاقة هذه الوثيقة بغيرها
تُقرأ مع سياسة الشراء، وسياسة البيع، وسياسة الدفع والمحفظة، وسياسة الإرجاع.

## 2. كيف يُحدَّد السعر

### 2.1 السعر يُحتسب على الخادم
كل سعر ورسم وخصم يُحتسب على الخادم لحظة إنشاء الطلب. وأي رقم يرسله المتصفح يُهمل، ولا يُنشئ التزاماً على المتجر.

### 2.2 السعر المعروض ليس تثبيتاً
عرض السعر على صفحة المنتج أو في السلة بيان لحظي بسعر ذلك الوقت، ولا يثبّت السعر إلى وقت لاحق، ولا يُنشئ حجزاً.

### 2.3 مكوّنات السعر
يُبيَّن السعر على مكوّناته: قيمة البضاعة، وعمولة النقل أو علاوة البيع المباشر، ورسم الضمان الممتد، وأجرة التوصيل، وضريبة الدفع عند الاستلام، والخصومات والنقاط. ولا يُخلط بند بآخر.

### 2.4 لقطة السعر على الطلب
يُحفظ مع الطلب سعره ومزاياه كما كانت لحظة الشراء. وتغيير الأسعار أو الإعدادات أو نسب المزايا لاحقاً لا يُعيد حساب طلب سابق، صعوداً أو نزولاً.

### 2.5 العملة
الأسعار بالدينار العراقي، ويُثبَّت سعر صرف المحفظة على الطلب لحظة إنشائه.

## 3. تغيّر السعر بين السلة وإتمام الطلب

### 3.1 القاعدة
إذا تغيّر سعر قطعة بين إضافتها إلى السلة وإتمام الطلب، فالمعتمد هو السعر المحتسب لحظة إنشاء الطلب، لا السعر الذي رآه الزبون عند الإضافة.

### 3.2 لماذا
السلة ليست حجزاً ولا تثبيتاً للسعر، والقطعة تبقى معروضة للجميع حتى لحظة إنشاء الطلب. ولو ثُبِّت سعر السلة لأمكن الاحتفاظ بسعر قديم إلى أجل غير مسمّى.

### 3.3 الانخفاض قبل إتمام الطلب
إذا انخفض السعر قبل إتمام الطلب استفاد الزبون من الانخفاض تلقائياً، لأن الحساب يجري لحظة الإنشاء.

### 3.4 الارتفاع قبل إتمام الطلب
إذا ارتفع السعر قبل إتمام الطلب ظهر الرقم الجديد في شاشة الدفع قبل الضغط على التأكيد. وللزبون ألا يكمل الطلب.

### 3.5 الشاشة القديمة
الصفحة المفتوحة منذ مدة قد تعرض سعراً أو عرضاً لم يعد قائماً. وإعادة تحميل الصفحة تُظهر الحال الفعلية، والمعتمد هو ما يحتسبه الخادم لا ما بقي على الشاشة.

## 4. أخطاء التسعير

### 4.1 الخطأ الظاهر لا يُلزم
السعر المنشور بخطأ ظاهر — كسقوط خانة، أو خطأ في وحدة العملة، أو رقم لا يقارَب سعر السوق لتلك القطعة — لا يُنشئ التزاماً على المتجر ببيع القطعة به.

### 4.2 معالجة الخطأ قبل الدفع
إذا اكتُشف الخطأ قبل دفع الطلب، أُبلغ الزبون بالسعر الصحيح وخُيِّر بين الشراء به أو إلغاء الطلب دون أي تبعة عليه.

### 4.3 معالجة الخطأ بعد الدفع
إذا اكتُشف الخطأ بعد دفع الطلب، لم يُطالَب الزبون بفرق، ويكون للمتجر إما تنفيذ الطلب بالسعر المدفوع أو إلغاؤه وإعادة المبلغ كاملاً، ويُبلَّغ الزبون بالخيار المتخذ وسببه.

### 4.4 حدّ حسن النية
لا يُحتج بالخطأ الظاهر لتصحيح فرق يسير في سعر معقول، ولا يُستعمل هذا البند للتراجع عن عرض صحيح أُعلن عن قصد.

### 4.5 الخطأ في الوصف
الخطأ الظاهر في وصف أو مواصفة أو صورة يُعالج بالطريقة نفسها: تصحيح وإعلام وخيار بين القبول والإلغاء.

## 5. حق المتجر في تعديل سعر الطلب غير المدفوع

### 5.1 القاعدة
يجوز للمتجر تعديل سعر الطلب ما دام غير مدفوع، أو إلغاؤه، قبل تأكيده وبدء تنفيذه.

### 5.2 كيف يُنفَّذ التعديل
لا يُعدَّل مجموع طلب قائم في مكانه. يُبلَّغ الزبون بالسعر الصحيح، فإن قبله أُلغي الطلب وأُعيد إنشاؤه بالسعر المصحح، وإن لم يقبله أُلغي الطلب ولا شيء عليه.

### 5.3 الإبلاغ
يُبلَّغ الزبون بالتعديل أو الإلغاء وسببه خلال {{PRICE_CORRECTION_NOTICE_HOURS}} ساعة من اتخاذ القرار، عبر قنوات الإشعار المسجلة له.

### 5.4 حق الزبون في الرفض
للزبون رفض السعر المعدَّل دون أي تبعة. ولا يُعدّ سكوته قبولاً، ولا يُنفَّذ الطلب بالسعر الجديد قبل موافقته.

### 5.5 ما لا يبرر التعديل
لا يُعدَّل سعر طلب لمجرد أن قيمة العملة تحركت بعد إنشائه، ولا لأن العرض انتهى بعد إنشائه، ولا لأن الزبون استعمل مزية كان مستحقاً لها.

## 6. صون السعر المدفوع

### 6.1 القاعدة
إذا دفع الزبون قيمة طلبه، فالسعر المدفوع هو السعر النافذ، ويلتزم المتجر بتنفيذ الطلب به.

### 6.2 المتجر يتحمل الزيادة
إذا ارتفع سعر القطعة أو كلفتها أو كلفة نقلها بعد الدفع، تحمّل المتجر الزيادة بالكامل ونفّذ الطلب بالسعر المدفوع، ولا يُطالَب الزبون بفرق.

### 6.3 لا مطالبة لاحقة
لا يجوز مطالبة الزبون بأي مبلغ إضافي على طلب دُفع، لا عند التسليم ولا بعده، ما لم يكن المبلغ رسماً معلناً على الطلب نفسه ولم يُدفع بعد.

### 6.4 الطلب المدفوع جزئياً
الطلب الذي دُفعت مقدمته فقط يُعدّ مدفوعاً بمقدار ما دُفع. فتُصان الحصة المدفوعة بسعرها، ويخضع الباقي لأحكام الفصل الخامس قبل تحصيله.

### 6.5 إذا تعذر التنفيذ بالسعر المدفوع
إذا تعذر على المتجر تنفيذ الطلب بالسعر المدفوع — لنفاد القطعة أو اعتذار المجهّز — فليس له رفع السعر. يكون له إلغاء الطلب وإعادة المبلغ كاملاً، أو عرض بديل على الزبون يقبله أو يرفضه.

## 7. حق المتجر في إلغاء الطلب

### 7.1 القاعدة
يجوز للمتجر إلغاء الطلب لسبب معتبر، ويُبيَّن السبب للزبون.

### 7.2 الأسباب المعتبرة
من الأسباب المعتبرة: نفاد الكمية أو تعذر التوريد، وخطأ التسعير الظاهر، وتعذر التحقق من الزبون أو عنوانه، وتعذر الوصول إليه، والاشتباه في احتيال أو في إساءة استعمال عرض أو نقاط، وسجل رفض الاستلام، ووجود نزاع دفع قائم، وتعذر التوصيل إلى المنطقة، والمنع القانوني.

### 7.3 ما يحدث للمال عند الإلغاء
عند الإلغاء تُعاد إلى محفظة الزبون كل المبالغ التي خُصمت منها لهذا الطلب، وتُعاد النقاط المستعملة نقاطاً لا نقداً، وتُلغى النقاط التي كانت ستُمنح عنه، ويُلغى أي التزام تمويل مؤجل تعلّق به. ولا يُقتطع شيء إذا كان الإلغاء قبل الشحن.

### 7.4 الإلغاء بعد الشحن
إذا أُلغي الطلب بعد شحنه لسبب يعود إلى المتجر، أُعيد المبلغ كاملاً ولم يتحمل الزبون كلفة النقل. أما إذا كان الإلغاء بسبب يعود إلى الزبون فتُطبَّق أحكام الرفض عند الباب في سياسة الشراء.

### 7.5 مدة الإعادة
تظهر الإعادة إلى المحفظة عند تنفيذ الإلغاء، وخلال {{REFUND_PROCESSING_DAYS}} يوم عمل على الأكثر في الحالات التي تستلزم مراجعة.

### 7.6 الإلغاء ليس عقوبة
لا يُستعمل الإلغاء لمعاقبة زبون على اعتراضه أو على مراجعته السلبية. وللزبون الاعتراض على قرار الإلغاء عبر الدعم.

### 7.7 المخزون والحجوزات
عند الإلغاء تعود الكمية إلى المخزون، وتُفكّ الحجوزات المرتبطة بالطلب. ولا يعيد الإلغاء فرصة عرض محدود استُهلكت، إذا كان نظام العرض قد قيّدها.

## 8. العروض ونوافذها

### 8.1 بداية العرض ونهايته
لكل عرض بداية ونهاية معلنتان. ولا يُطبَّق قبل بدايته ولا بعد نهايته، ولو بقي ظاهراً على شاشة لم تُحدَّث.

### 8.2 الحدود
للعرض حدّ لكل مستخدم وحدّ إجمالي. وبلوغ الحدّ ينهي العرض فعلياً ولو بقيت مدته، ويُرفض الطلب المتجاوز للحدّ.

### 8.3 العروض المشروطة بالعضوية
العرض المقصور على مستوى عضوية معيّن لا يستحقه من ليست عضويته فعّالة وقت إنشاء الطلب.

### 8.4 سعر واحد للقطعة الواحدة
لا يُجمع سعر عرض مجدول مع سعر آخر على القطعة نفسها. ويُطبَّق الكوبون بعد ذلك على قيمة البضاعة وفق شروطه.

### 8.5 انتهاء العرض أثناء الشراء
إذا انتهى العرض أو نفد حدّه قبل إنشاء الطلب، سُعِّر الطلب بالسعر النافذ عندئذ، ولا يُنشئ ظهور العرض على الشاشة حقاً فيه.

### 8.6 لا أثر رجعي للعرض
لا يُطبَّق عرض جديد على طلب أُنشئ قبل بدايته، ولا يُطالَب بفرق بسببه، مع مراعاة الفصل العاشر.

## 9. ما يضمنه خصم العضوية وما لا يضمنه

### 9.1 ما يضمنه
تضمن العضوية الفعّالة تطبيق سعرها أو خصمها المعلن على القطع المؤهلة وقت إنشاء الطلب، وتُحفظ قيمة ما وفّرته على لقطة ذلك الطلب.

### 9.2 ما لا يضمنه
لا تضمن العضوية أن يكون لكل قطعة سعر عضوية، ولا أن يبقى الخصم بنسبة ثابتة، ولا أن يكون سعر العضو هو الأدنى في السوق، ولا أن تشمل المزية الرسوم والضرائب وأجرة التوصيل ما لم يُنصّ على ذلك.

### 9.3 القطع غير المسعّرة للعضوية
القطعة التي لا سعر عضوية لها تُباع بسعرها الاعتيادي. ولا يُخترع للعضو خصم لم يقرره المتجر.

### 9.4 شرط فعالية العضوية
تُقاس المزية بحال العضوية لحظة إنشاء الطلب. وانتهاء العضوية بعد الطلب لا يسحب مزية مُنحت، وبدء العضوية بعد الطلب لا يمنح مزية لم تكن قائمة.

### 9.5 مزايا مشروطة بشروط أخرى
بعض مزايا العضوية مشروطة بحدّ لقيمة الطلب أو بعنوان معتمد أو بوسيلة دفع أو بنوع شحن. وتخلّف الشرط يُسقط المزية لذلك الطلب وحده، وتعود المزية تلقائياً عند توافر الشرط في طلب لاحق.

### 9.6 لا جمع بين المزايا المتعارضة
لا تُجمع مزيتان تعالجان البند نفسه. وعند تعددها تُطبَّق الأنفع للزبون، ويُبيَّن ذلك في تفصيل السعر.

### 9.7 إعفاء التوصيل
إعفاء أجرة التوصيل مزية مشروطة بحدّ لقيمة الطلب وبشروط العضوية، وتفصيلها في سياسة التوصيل. ولا يشمل الإعفاء رسوماً لم يشملها نصّ المزية.

## 10. حماية السعر بعد التسليم

### 10.1 الحق
إذا انخفض سعر قطعة سُلِّمت إلى الزبون خلال سبعة أيام من تسليمها، جاز له طلب فرق السعر رصيداً في محفظته.

### 10.2 المدة
تُحسب السبعة أيام من التسليم الفعلي الموثق للقطعة. ويُقدَّم الطلب داخل المدة، ولا يقبل النظام طلباً بعد انقضائها.

### 10.3 الطلب لا يُقدَّم إلا على قطعة مسلَّمة
لا تُقبل مطالبة حماية السعر قبل تسليم القطعة. والقطعة التي لم تُسلَّم يخضع سعرها للفصل الخامس والفصل السادس.

### 10.4 كيف يُحتسب الفرق
يُقارَن ما دفعه الزبون فعلاً عن الوحدة بأدنى سعرين: السعر الذي يدفعه اليوم مشترٍ من فئة السعر نفسها، وأدنى سعر مسجل للقطعة نفسها خلال مدة الحماية. ويُضرب الفرق في الكمية المشتراة.

### 10.5 المقارنة بفئة السعر نفسها
يُقارَن مشتري السعر الاعتيادي بالسعر الاعتيادي، ومشتري سعر PRO بسعر PRO أو الاعتيادي أيهما أدنى. ولا يُقارَن مشترٍ اعتيادي بسعر مقصور على عضوية لا يملكها.

### 10.6 الانخفاض الذي ارتفع ثانية
يُعتدّ بالانخفاض الذي حصل داخل المدة ولو أُعيد السعر إلى ما كان عليه قبل تقديم الطلب، لأن المقارنة تقع على السعر المسجل خلال المدة لا على سعر اليوم وحده.

### 10.7 القرار ليس تلقائياً
لا يُصرف فرق السعر تلقائياً. تُراجع المطالبة وتُقبل أو تُرفض بقرار مسبب خلال {{PRICE_CLAIM_DECISION_DAYS}} يوم عمل، ويُقيَّد المبلغ في المحفظة عند القبول.

### 10.8 السقف التراكمي
لا يتجاوز مجموع ما يُصرف عن القطعة الواحدة مقدار الفرق المستحق. وتُخصم المبالغ التي سبق صرفها عنها من أي مطالبة لاحقة.

### 10.9 مطالبة واحدة مفتوحة
لا تُقبل أكثر من مطالبة واحدة مفتوحة عن القطعة نفسها في الوقت نفسه.

### 10.10 وجهة التعويض
يُقيَّد فرق السعر رصيداً في محفظة الزبون. وأي وجهة أخرى لا تكون إلا باتفاق مع الدعم.

### 10.11 لا تعويض مزدوج
لا يُجمع بين تعويض حماية السعر وبين استرداد ثمن القطعة نفسها بالإرجاع. ومن أرجع القطعة واسترد ثمنها لا يستحق فرق سعرها.

## 11. ما لا تشمله حماية السعر

### 11.1 الرسوم والأجور
لا تشمل الحماية أجرة التوصيل ولا ضريبة الدفع عند الاستلام ولا عمولة النقل ولا رسم الضمان الممتد، لأنها ليست قيمة بضاعة.

### 11.2 الحزمة ككل
الحزمة لا تُحمى كوحدة واحدة، لأن سعرها سعر تركيبة لا سعر قطعة. وتُحمى أجزاؤها كل جزء على حدة بحصته من ثمن الحزمة.

### 11.3 عروض المفاجأة
لا تشمل الحماية قطعة من عرض مفاجأة، لأن ما دُفع فيها ثمن العرض لا ثمن القطعة المسحوبة، ولأن المقارنة بسعر القطعة تكشف ما لا يجوز كشفه.

### 11.4 الطلبات القديمة
الطلب الذي يسبق تسجيل المتغيرات الدقيقة لا تمكن مقارنته آلياً، ويُحال إلى الدعم لمراجعة يدوية.

### 11.5 المنتج المسحوب أو المتغيّر
لا تُقبل المطالبة إذا لم يعد المتغيّر المشترى قابلاً للتسعير على المنتج الحالي، وتُحال إلى الدعم.

### 11.6 انخفاض غير قابل للمقارنة
لا يُعتدّ بانخفاض سعر منتج آخر ولو كان مشابهاً، ولا بسعر لدى بائع آخر، ولا بسعر في سوق أخرى.

### 11.7 بضاعة تجار المجتمع
حماية السعر هنا تخص بضاعة المتجر الرسمي. وتسعير بضاعة تجار مجتمع ليفو يخص التاجر، ويُراجَع معه وفق سياسة البيع.

## 12. الإبلاغ والاعتراض

### 12.1 كيف تُقدَّم المطالبة
تُقدَّم مطالبة حماية السعر من سجل الطلب في حساب الزبون، على القطعة المعنية بعينها.

### 12.2 الاعتراض على الرفض
للزبون الاعتراض على رفض مطالبته أو على قرار إلغاء طلبه أو على تصحيح سعره، عبر الدعم، خلال {{DISPUTE_RESPONSE_DAYS}} يوماً من إبلاغه بالقرار.

### 12.3 ما يُبنى عليه القرار
يُبنى القرار على سجلات النظام: لقطة سعر الطلب، وسجل تغيّر الأسعار، وتاريخ التسليم، وما سبق صرفه عن القطعة.

### 12.4 حفظ الأسباب
يُسجَّل سبب كل قبول ورفض وإلغاء وتصحيح، ويُطلع الزبون عليه عند طلبه.

## 13. أحكام ختامية

### 13.1 التعديل
للمتجر تعديل هذه السياسة بإصدار نسخة جديدة برقم وتاريخ نفاذ، ولا يسري التعديل بأثر رجعي على طلب سابق.

### 13.2 استقلال البنود
بطلان بند لا يمس باقي البنود.

### 13.3 القانون والاختصاص
تخضع هذه الوثيقة لقوانين {{GOVERNING_LAW_JURISDICTION}}، والاختصاص لمحاكم {{COMPETENT_COURT}}.

### 13.4 جهة الاتصال
جهة الاتصال المعتمدة {{LEVONIS_SUPPORT_CONTACT}}، وأوقات العمل {{LEVONIS_SUPPORT_HOURS}}.`,

    en: `## 1. Preamble and Definitions

### 1.1 Purpose of this document
This document sets out how a price is determined, when the Store may change it or cancel an order, what happens to the money on cancellation, how pricing errors are handled, what an offer or a membership discount does and does not guarantee, and price protection after delivery.

### 1.2 Definitions
- The displayed price: the figure shown on the product page or in the cart before the order is placed.
- The computed price: the figure the server computes at the moment the order is created; it is the governing one.
- An unpaid order: an order on which no money has been taken, neither from the wallet nor at the door.
- A paid order: an order whose value has been debited from the wallet or whose collection has been recorded.
- A manifest pricing error: a figure that any reasonable reader can see is not the intended price.
- The offer window: the declared period between an offer's start and its end.
- Price protection: the customer's claim for the price difference on an item delivered to them whose price then fell within seven days.

### 1.3 Authoritative text
The Arabic text is authoritative; the English and Kurdish versions are faithful translations of it under the same numbering.

### 1.4 Relationship to the other documents
This document is read with the Purchase Policy, the Selling Policy, the Payment and Wallet Policy and the Returns Policy.

## 2. How a Price is Determined

### 2.1 The price is computed by the server
Every price, fee and discount is computed on the server at the moment the order is created. Any figure sent by the browser is disregarded and creates no obligation on the Store.

### 2.2 A displayed price is not a fixing
Display of a price on the product page or in the cart is a momentary statement of the price at that time. It does not fix the price for a later moment and does not create a reservation.

### 2.3 The components of the price
The price is stated by its components: the merchandise value, the transport commission or the direct-sale premium, the extended-warranty fee, the delivery fee, the cash-on-delivery tax, and discounts and points. No component is merged into another.

### 2.4 The price snapshot on the order
The order's price and benefits as at the moment of purchase are stored with it. Later changes to prices, settings or benefit rates do not recompute an earlier order, upwards or downwards.

### 2.5 Currency
Prices are in Iraqi dinars, and the wallet exchange rate is fixed onto the order at the moment it is created.

## 3. A Price that Changes Between the Cart and Checkout

### 3.1 The rule
Where the price of an item changes between its addition to the cart and the placing of the order, the governing price is the one computed at the moment the order is created, not the price the customer saw when adding it.

### 3.2 Why
The cart is neither a reservation nor a fixing of price, and the item remains on sale to everyone until the order is created. Were the cart's price fixed, an old price could be held indefinitely.

### 3.3 A fall before the order is placed
Where the price falls before the order is placed, the customer benefits from the fall automatically, because the calculation is made at the moment of creation.

### 3.4 A rise before the order is placed
Where the price rises before the order is placed, the new figure appears on the checkout screen before the confirm button is pressed. The customer is free not to complete the order.

### 3.5 A stale screen
A page left open for some time may display a price or an offer that no longer stands. Reloading the page shows the true position, and the governing figure is what the server computes, not what remains on the screen.

## 4. Pricing Errors

### 4.1 A manifest error does not bind
A price published with a manifest error — a dropped digit, a currency-unit mistake, or a figure nowhere near the market price for that item — creates no obligation on the Store to sell at it.

### 4.2 Handling the error before payment
Where the error is discovered before the order is paid, the customer is informed of the correct price and may choose between buying at it and cancelling the order with no consequence to them.

### 4.3 Handling the error after payment
Where the error is discovered after the order has been paid, the customer is not asked for a difference. The Store may either execute the order at the price paid or cancel it and return the amount in full, and the customer is informed of the course taken and its reason.

### 4.4 The good-faith limit
A manifest error is not invoked to correct a minor difference in an otherwise reasonable price, and this article is not used to withdraw from a genuine offer that was published deliberately.

### 4.5 An error in a description
A manifest error in a description, a specification or an image is handled the same way: correction, notice, and a choice between accepting and cancelling.

## 5. The Store's Right to Change the Price of an Unpaid Order

### 5.1 The rule
The Store may change the price of an order while it remains unpaid, or cancel it, before it is confirmed and execution begins.

### 5.2 How the change is carried out
The total of a standing order is not edited in place. The customer is informed of the correct price; if they accept it, the order is cancelled and reissued at the corrected price, and if they do not accept it, the order is cancelled and nothing is owed by them.

### 5.3 Notice
The customer is informed of the change or the cancellation and its reason within {{PRICE_CORRECTION_NOTICE_HOURS}} hours of the decision, through the notification channels registered for them.

### 5.4 The customer's right to refuse
The customer may refuse the corrected price with no consequence. Their silence is not acceptance, and the order is not executed at the new price before they agree.

### 5.5 What does not justify a change
An order's price is not changed merely because the currency moved after it was created, nor because an offer ended after it was created, nor because the customer used a benefit to which they were entitled.

## 6. The Paid Price is Honoured

### 6.1 The rule
Where the customer has paid the value of their order, the price paid is the price in force, and the Store undertakes to execute the order at it.

### 6.2 The Store absorbs the increase
Where the item's price, its cost or its transport cost rises after payment, the Store absorbs the increase in full and executes the order at the price paid; no difference is claimed from the customer.

### 6.3 No later claim
No additional amount may be claimed from the customer on a paid order, neither at delivery nor afterwards, unless the amount is a fee declared on the order itself and not yet paid.

### 6.4 A partly paid order
An order on which only an advance has been paid is treated as paid to the extent of what was paid. The paid portion is honoured at its price, and the remainder is subject to chapter 5 before it is collected.

### 6.5 Where execution at the paid price is impossible
Where the Store cannot execute the order at the price paid — because the item is exhausted or the supplier has declined — it may not raise the price. It may cancel the order and return the amount in full, or offer the customer an alternative for them to accept or refuse.

## 7. The Store's Right to Cancel an Order

### 7.1 The rule
The Store may cancel an order for any established reason, and the reason is stated to the customer.

### 7.2 Established reasons
Established reasons include: exhaustion of stock or inability to procure; a manifest pricing error; inability to verify the customer or their address; inability to reach them; suspicion of fraud or of abuse of an offer or of points; a history of refused deliveries; an open payment dispute; inability to deliver to the area; and a legal prohibition.

### 7.3 What happens to the money on cancellation
On cancellation, every amount debited from the customer's wallet for that order is returned to it, points that were spent are returned as points and not as cash, the points that would have been earned on it are cancelled, and any deferred-financing obligation attached to it is cancelled. Nothing is deducted where the cancellation precedes dispatch.

### 7.4 Cancellation after dispatch
Where an order is cancelled after dispatch for a reason attributable to the Store, the amount is returned in full and the customer bears no transport cost. Where the cancellation is for a reason attributable to the customer, the provisions on refusal at the door in the Purchase Policy apply.

### 7.5 Time to return
The return appears in the wallet when the cancellation is executed, and within {{REFUND_PROCESSING_DAYS}} working days at most in cases requiring review.

### 7.6 Cancellation is not a penalty
Cancellation is not used to penalise a customer for objecting or for leaving a negative review. The customer may object to a cancellation decision through support.

### 7.7 Stock and reservations
On cancellation the quantity returns to stock and the reservations attached to the order are released. Cancellation does not restore a consumed allowance on a limited offer where the offer system has recorded it as used.

## 8. Offers and their Windows

### 8.1 An offer's start and end
Every offer has a declared start and end. It is not applied before its start or after its end, even if it remains visible on a screen that has not been refreshed.

### 8.2 Limits
An offer carries a per-customer limit and a global limit. Reaching the limit ends the offer in fact even if its period remains, and an order exceeding the limit is refused.

### 8.3 Membership-conditional offers
An offer confined to a particular membership level is not available to a person whose membership is not active at the moment the order is created.

### 8.4 One price per item
A scheduled offer price is not combined with another price on the same item. A coupon then applies to the merchandise value under its own terms.

### 8.5 An offer ending during the purchase
Where the offer ends or its limit is exhausted before the order is created, the order is priced at the price then in force; the offer's appearance on screen creates no right to it.

### 8.6 No retroactive effect
A new offer is not applied to an order created before its start, and no difference is claimed on account of it, subject to chapter 10.

## 9. What a Membership Discount Does and Does Not Guarantee

### 9.1 What it guarantees
An active membership guarantees that its declared price or discount is applied to eligible items at the moment the order is created, and the value of what it saved is preserved on that order's snapshot.

### 9.2 What it does not guarantee
A membership does not guarantee that every item carries a membership price, nor that the discount remains at a fixed percentage, nor that the member's price is the lowest in the market, nor that the benefit extends to fees, taxes and the delivery charge unless expressly stated.

### 9.3 Items with no membership price
An item with no membership price is sold at its ordinary price. No discount the Store has not set is invented for a member.

### 9.4 The membership must be active
The benefit is measured by the state of the membership at the moment the order is created. A membership that lapses after the order does not retract a benefit already granted, and a membership that begins after the order does not grant a benefit that did not exist.

### 9.5 Benefits conditional on other conditions
Some membership benefits are conditional on an order-value threshold, an approved address, a payment method or a shipping type. Failure of the condition forfeits the benefit for that order alone, and the benefit returns automatically on a later order where the condition is met.

### 9.6 No stacking of conflicting benefits
Two benefits addressing the same component are not stacked. Where several apply, the one most favourable to the customer is applied, and that is shown in the price breakdown.

### 9.7 The delivery waiver
Waiver of the delivery fee is a benefit conditional on an order-value threshold and on the membership's conditions, detailed in the Delivery Policy. The waiver does not extend to fees the benefit's own wording does not cover.

## 10. Price Protection After Delivery

### 10.1 The right
Where the price of an item delivered to the customer falls within seven days of its delivery, the customer may claim the difference as credit in their wallet.

### 10.2 The period
The seven days run from the documented actual delivery of the item. The claim must be filed within the period; the system does not accept a claim after it has expired.

### 10.3 A claim lies only on a delivered item
A price-protection claim is not accepted before the item has been delivered. The price of an undelivered item is governed by chapters 5 and 6.

### 10.4 How the difference is computed
What the customer actually paid per unit is compared against the lower of two prices: the price a buyer of the same price class would pay today, and the lowest price recorded for the same item within the protection period. The difference is multiplied by the quantity purchased.

### 10.5 Comparison within the same price class
An ordinary-price buyer is compared against the ordinary price; a PRO-price buyer is compared against the PRO price or the ordinary price, whichever is lower. An ordinary buyer is never compared against a price confined to a membership they do not hold.

### 10.6 A fall that was reversed
A fall that occurred within the period counts even if the price was later restored before the claim was filed, because the comparison is against the price recorded within the period and not against today's price alone.

### 10.7 The decision is not automatic
The difference is not paid out automatically. The claim is reviewed and accepted or refused by a reasoned decision within {{PRICE_CLAIM_DECISION_DAYS}} working days, and the amount is credited to the wallet on acceptance.

### 10.8 The cumulative cap
The total paid out on one item never exceeds the eligible difference. Amounts previously paid out on it are deducted from any later claim.

### 10.9 One open claim
No more than one claim may be open on the same item at the same time.

### 10.10 Destination of the compensation
The price difference is credited to the customer's wallet. Any other destination is only by arrangement with support.

### 10.11 No double compensation
Price-protection compensation is not combined with a refund of the same item's price on a return. A customer who returned the item and recovered its price is not entitled to its price difference.

## 11. What Price Protection Does Not Cover

### 11.1 Fees and charges
Protection does not extend to the delivery fee, the cash-on-delivery tax, the transport commission or the extended-warranty fee, because none of them is merchandise value.

### 11.2 A bundle as a whole
A bundle is not protected as a single unit, because its price is the price of a composition and not of an item. Its parts are protected individually, each by its share of the bundle price.

### 11.3 Mystery offers
Protection does not extend to an item from a mystery offer, because what was paid is the price of the offer and not of the item drawn, and because comparing it against the item's price would disclose what may not be disclosed.

### 11.4 Older orders
An order predating the recording of exact variants cannot be compared automatically and is referred to support for manual review.

### 11.5 A withdrawn or altered product
A claim is not accepted where the purchased variant can no longer be priced on the current product, and it is referred to support.

### 11.6 A fall that cannot be compared
The fall in price of another product, however similar, does not count, nor a price at another seller, nor a price in another market.

### 11.7 Community merchants' goods
Price protection here concerns the official store's goods. The pricing of Levo community merchants' goods is the merchant's, and is taken up with them under the Selling Policy.

## 12. Filing and Objecting

### 12.1 How a claim is filed
A price-protection claim is filed from the order record in the customer's account, against the specific item concerned.

### 12.2 Objecting to a refusal
The customer may object to the refusal of a claim, to a decision cancelling their order, or to a correction of its price, through support, within {{DISPUTE_RESPONSE_DAYS}} days of being informed of the decision.

### 12.3 What the decision rests on
The decision rests on the system's records: the order's price snapshot, the price-change history, the date of delivery, and what has previously been paid out on the item.

### 12.4 Reasons are preserved
The reason for every acceptance, refusal, cancellation and correction is recorded, and is disclosed to the customer on request.

## 13. Final Provisions

### 13.1 Amendment
The Store may amend this policy by issuing a new version with a number and an effective date; an amendment has no retroactive effect on an earlier order.

### 13.2 Severability
The invalidity of one article does not affect the remaining articles.

### 13.3 Law and jurisdiction
This document is governed by the laws of {{GOVERNING_LAW_JURISDICTION}}, and the courts of {{COMPETENT_COURT}} have jurisdiction.

### 13.4 Contact
The approved contact point is {{LEVONIS_SUPPORT_CONTACT}}, and the working hours are {{LEVONIS_SUPPORT_HOURS}}.`,

    ckb: `## 1. پێشەکی و پێناسەکان

### 1.1 مەبەستی ئەم بەڵگەنامەیە
ئەم بەڵگەنامەیە دیاری دەکات نرخ چۆن دیاری دەکرێت، کەی فرۆشگا دەتوانێت بیگۆڕێت یان داواکارییەکە هەڵبوەشێنێتەوە، لە کاتی هەڵوەشاندنەوەدا چی بەسەر پارەکەدا دێت، هەڵەکانی نرخاندن چۆن چارەسەر دەکرێن، ئۆفەر یان داشکاندنی ئەندامێتی چی دەستەبەر دەکات و چی نا، و پاراستنی نرخ دوای گەیاندن.

### 1.2 پێناسەکان
- نرخی پیشاندراو: ئەو ژمارەیەی لەسەر پەڕەی بەرهەم یان لە سەبەتەدا پێش تەواوکردنی داواکاری دەردەکەوێت.
- نرخی حسابکراو: ئەو ژمارەیەی ڕاژەکار لە ساتی دروستبوونی داواکاریدا حسابی دەکات، و ئەوە پەسەندکراوە.
- داواکاری نەدراو: ئەو داواکارییەی هیچ پارەیەکی لەسەر وەرنەگیراوە، نە لە جزدان و نە لە بەردەرگا.
- داواکاری دراو: ئەو داواکارییەی بەهاکەی لە جزدانەوە بڕدراوە یان کۆکردنەوەکەی تۆمار کراوە.
- هەڵەی نرخاندنی ئاشکرا: ژمارەیەک کە هەر خوێنەرێکی ژیر دەبینێت ئەو نرخە نییە کە مەبەست بووە.
- پەنجەرەی ئۆفەر: ئەو ماوە ڕاگەیەنراوەی نێوان دەستپێک و کۆتایی ئۆفەرەکە.
- پاراستنی نرخ: داواکاری کڕیار بۆ جیاوازی نرخی کاڵایەک کە بۆی گەیەنراوە و پاشان لە ماوەی حەوت ڕۆژدا نرخەکەی داشکاوە.

### 1.3 دەقی پەسەندکراو
دەقی عەرەبی پەسەندکراوە، و وەشانی ئینگلیزی و کوردی وەرگێڕانی دڵسۆزی ئەون بە هەمان ژمارەگوزاری.

### 1.4 پەیوەندی بە بەڵگەنامەکانی دیکەوە
لەگەڵ سیاسەتی کڕین، سیاسەتی فرۆشتن، سیاسەتی پارەدان و جزدان، و سیاسەتی گەڕاندنەوە دەخوێنرێتەوە.

## 2. نرخ چۆن دیاری دەکرێت

### 2.1 نرخ لەسەر ڕاژەکار حساب دەکرێت
هەموو نرخ و کرێ و داشکاندنێک لە ساتی دروستبوونی داواکاریدا لەسەر ڕاژەکار حساب دەکرێت. هەر ژمارەیەک وێبگەڕ بینێرێت پشتگوێ دەخرێت و هیچ پابەندییەک لەسەر فرۆشگا دروست ناکات.

### 2.2 نرخی پیشاندراو جێگیرکردن نییە
پیشاندانی نرخ لەسەر پەڕەی بەرهەم یان لە سەبەتەدا بەیاننامەیەکی ساتەوەختییە بۆ نرخی ئەو کاتە. نرخەکە بۆ کاتێکی دواتر جێگیر ناکات و حیجز دروست ناکات.

### 2.3 پێکهاتەکانی نرخ
نرخ بە پێکهاتەکانییەوە ڕوون دەکرێتەوە: بەهای کاڵا، کۆمیسیۆنی گواستنەوە یان زیادەی فرۆشتنی ڕاستەوخۆ، کرێی گەرەنتی درێژکراوە، کرێی گەیاندن، باجی پارەدان لە کاتی وەرگرتن، و داشکاندن و خاڵەکان. هیچ بڕگەیەک لەگەڵ بڕگەیەکی دیکەدا تێکەڵ ناکرێت.

### 2.4 وێنەی نرخ لەسەر داواکارییەکە
نرخ و سوودەکانی داواکارییەکە وەک لە ساتی کڕیندا بوون لەگەڵیدا هەڵدەگیرێن. گۆڕانی نرخ یان ڕێکخستن یان ڕێژەی سوودەکان لە دواتردا داواکارییەکی پێشووتر دووبارە حساب ناکاتەوە، نە بەرەو سەرەوە و نە بەرەو خوارەوە.

### 2.5 دراو
نرخەکان بە دیناری عێراقین، و نرخی ئاڵوگۆڕی جزدان لە ساتی دروستبوونی داواکارییەکەدا لەسەری جێگیر دەکرێت.

## 3. گۆڕانی نرخ لە نێوان سەبەتە و تەواوکردنی داواکاری

### 3.1 ڕێسا
ئەگەر نرخی کاڵایەک لە نێوان زیادکردنی بۆ سەبەتە و تەواوکردنی داواکاریدا گۆڕا، ئەو نرخە پەسەندکراوە کە لە ساتی دروستبوونی داواکاریدا حساب کراوە، نەک ئەو نرخەی کڕیار لە کاتی زیادکردندا بینیویەتی.

### 3.2 بۆچی
سەبەتە نە حیجزە و نە جێگیرکردنی نرخە، و کاڵاکە بۆ هەمووان بەردەست دەمێنێتەوە هەتا ساتی دروستبوونی داواکارییەکە. ئەگەر نرخی سەبەتە جێگیر بکرایە، دەکرا نرخێکی کۆن بۆ ماوەیەکی نادیار ڕابگیرێت.

### 3.3 داشکان پێش تەواوکردنی داواکاری
ئەگەر نرخەکە پێش تەواوکردنی داواکاری داشکا، کڕیار بە خۆکار سوود لە داشکانەکە وەردەگرێت، چونکە حسابەکە لە ساتی دروستبووندا ئەنجام دەدرێت.

### 3.4 بەرزبوونەوە پێش تەواوکردنی داواکاری
ئەگەر نرخەکە پێش تەواوکردنی داواکاری بەرز بووەوە، ژمارە نوێیەکە پێش پەستان لەسەر دوگمەی پشتڕاستکردنەوە لە شاشەی پارەداندا دەردەکەوێت. کڕیار ئازادە داواکارییەکە تەواو نەکات.

### 3.5 شاشەی کۆن
پەڕەیەکی ماوەیەکە کراوە لەوانەیە نرخ یان ئۆفەرێک پیشان بدات کە ئیتر نەماوە. بارکردنەوەی پەڕەکە دۆخی ڕاستەقینە پیشان دەدات، و پەسەندکراو ئەوەیە ڕاژەکار حسابی دەکات نەک ئەوەی لەسەر شاشەکە ماوەتەوە.

## 4. هەڵەکانی نرخاندن

### 4.1 هەڵەی ئاشکرا پابەند ناکات
نرخێکی بڵاوکراوە بە هەڵەیەکی ئاشکرا — کەوتنی خانەیەک، هەڵە لە یەکەی دراو، یان ژمارەیەک کە هیچ نزیک نییە لە نرخی بازاڕی ئەو کاڵایە — هیچ پابەندییەک لەسەر فرۆشگا دروست ناکات بۆ فرۆشتنی پێی.

### 4.2 چارەسەری هەڵەکە پێش پارەدان
ئەگەر هەڵەکە پێش دانی داواکارییەکە دۆزرایەوە، کڕیار بە نرخی ڕاست ئاگادار دەکرێتەوە و دەتوانێت لە نێوان کڕین پێی و هەڵوەشاندنەوەی داواکارییەکە بەبێ هیچ بارێک هەڵبژێرێت.

### 4.3 چارەسەری هەڵەکە دوای پارەدان
ئەگەر هەڵەکە دوای دانی داواکارییەکە دۆزرایەوە، داوای جیاوازی لە کڕیار ناکرێت. فرۆشگا دەتوانێت یان داواکارییەکە بەو نرخەی دراوە جێبەجێ بکات یان هەڵیبوەشێنێتەوە و بڕەکە بە تەواوی بگەڕێنێتەوە، و کڕیار بەو ڕێگەیەی گیراوەتەبەر و هۆکارەکەی ئاگادار دەکرێتەوە.

### 4.4 سنووری نیازپاکی
هەڵەی ئاشکرا بۆ ڕاستکردنەوەی جیاوازییەکی بچووک لە نرخێکی گونجاودا بەکار ناهێنرێت، و ئەم بڕگەیە بۆ پاشەکشەکردن لە ئۆفەرێکی ڕاستەقینەی بە ئەنقەست بڵاوکراوە بەکار ناهێنرێت.

### 4.5 هەڵە لە وەسفدا
هەڵەی ئاشکرا لە وەسف یان تایبەتمەندی یان وێنەیەکدا بە هەمان شێوە چارەسەر دەکرێت: ڕاستکردنەوە، ئاگادارکردنەوە، و هەڵبژاردن لە نێوان وەرگرتن و هەڵوەشاندنەوە.

## 5. مافی فرۆشگا لە گۆڕینی نرخی داواکارییەکی نەدراو

### 5.1 ڕێسا
فرۆشگا دەتوانێت نرخی داواکارییەک بگۆڕێت مادام نەدراوە، یان هەڵیبوەشێنێتەوە، پێش پشتڕاستکردنەوەی و دەستپێکردنی جێبەجێکردنی.

### 5.2 گۆڕانەکە چۆن جێبەجێ دەکرێت
کۆی داواکارییەکی هەبوو لە شوێنی خۆیدا دەستکاری ناکرێت. کڕیار بە نرخی ڕاست ئاگادار دەکرێتەوە؛ ئەگەر وەریگرت، داواکارییەکە هەڵدەوەشێنرێتەوە و بە نرخی ڕاستکراوە دووبارە دروست دەکرێتەوە، و ئەگەر وەرینەگرت، داواکارییەکە هەڵدەوەشێنرێتەوە و هیچی لەسەر نییە.

### 5.3 ئاگادارکردنەوە
کڕیار لە ماوەی {{PRICE_CORRECTION_NOTICE_HOURS}} کاتژمێردا لە بڕیارەکەوە بە گۆڕان یان هەڵوەشاندنەوەکە و هۆکارەکەی ئاگادار دەکرێتەوە، لە ڕێگەی ئەو کەناڵە ئاگادارکردنەوانەی بۆی تۆمار کراون.

### 5.4 مافی کڕیار لە ڕەتکردنەوە
کڕیار دەتوانێت نرخی ڕاستکراوە ڕەت بکاتەوە بەبێ هیچ بارێک. بێدەنگی وەرگرتن نییە، و داواکارییەکە بە نرخی نوێ جێبەجێ ناکرێت پێش ڕەزامەندی ئەو.

### 5.5 ئەوەی گۆڕانەکە ناسەلمێنێت
نرخی داواکارییەک ناگۆڕدرێت تەنها لەبەر ئەوەی دراوەکە دوای دروستبوونی جوڵاوە، و نە لەبەر ئەوەی ئۆفەرەکە دوای دروستبوونی کۆتایی هاتووە، و نە لەبەر ئەوەی کڕیار سوودێکی بەکارهێناوە کە شایستەی بووە.

## 6. پاراستنی ئەو نرخەی دراوە

### 6.1 ڕێسا
ئەگەر کڕیار بەهای داواکارییەکەی دا، ئەو نرخەی دراوە نرخی کارپێکراوە، و فرۆشگا پابەندە بە جێبەجێکردنی داواکارییەکە پێی.

### 6.2 فرۆشگا زیادەکە هەڵدەگرێت
ئەگەر نرخی کاڵاکە یان تێچووی یان تێچووی گواستنەوەی دوای پارەدان بەرز بووەوە، فرۆشگا زیادەکە بە تەواوی هەڵدەگرێت و داواکارییەکە بەو نرخە جێبەجێ دەکات کە دراوە؛ هیچ جیاوازییەک لە کڕیار داوا ناکرێت.

### 6.3 داواکاری دواتر نییە
هیچ بڕێکی زیادە ناکرێت لە کڕیار داوا بکرێت لەسەر داواکارییەکی دراو، نە لە کاتی گەیاندن و نە دوای، مەگەر ئەو بڕە کرێیەک بێت کە لەسەر خودی داواکارییەکە ڕاگەیەنراوە و هێشتا نەدراوە.

### 6.4 داواکاری بەشەکی دراو
ئەو داواکارییەی تەنها پێشەکییەکەی دراوە بە بڕی ئەوەی دراوە بە دراو دادەنرێت. بەشە دراوەکە بە نرخەکەی پارێزراوە، و پاشماوەکە پێش کۆکردنەوەی بەندە بە بەشی پێنجەم.

### 6.5 ئەگەر جێبەجێکردن بەو نرخەی دراوە نەکرا
ئەگەر فرۆشگا نەیتوانی داواکارییەکە بەو نرخە جێبەجێ بکات کە دراوە — بەهۆی تەواوبوونی کاڵاکە یان لێبوردنی دابینکەر — بۆی نییە نرخەکە بەرز بکاتەوە. دەتوانێت داواکارییەکە هەڵبوەشێنێتەوە و بڕەکە بە تەواوی بگەڕێنێتەوە، یان جێگرەوەیەک پێشکەشی کڕیار بکات کە وەریبگرێت یان ڕەتی بکاتەوە.

## 7. مافی فرۆشگا لە هەڵوەشاندنەوەی داواکاری

### 7.1 ڕێسا
فرۆشگا دەتوانێت داواکارییەک بۆ هەر هۆکارێکی سەلمێنراو هەڵبوەشێنێتەوە، و هۆکارەکە بۆ کڕیار ڕوون دەکرێتەوە.

### 7.2 هۆکارە سەلمێنراوەکان
لە هۆکارە سەلمێنراوەکان: تەواوبوونی بڕ یان نەتوانینی دابینکردن، هەڵەی نرخاندنی ئاشکرا، نەتوانینی پشکنینی کڕیار یان ناونیشانەکەی، نەگەیشتن بە کڕیار، گومانی ساختەکاری یان خراپبەکارهێنانی ئۆفەر یان خاڵ، تۆماری ڕەتکردنەوەی وەرگرتن، بوونی ناکۆکییەکی کراوەی پارەدان، نەتوانینی گەیاندن بۆ ناوچەکە، و قەدەغەی یاسایی.

### 7.3 لە کاتی هەڵوەشاندنەوەدا چی بەسەر پارەکەدا دێت
لە کاتی هەڵوەشاندنەوەدا هەموو ئەو بڕانەی لە جزدانی کڕیارەوە بۆ ئەم داواکارییە بڕدراون بۆی دەگەڕێنەوە، ئەو خاڵانەی بەکار هێنراون وەک خاڵ دەگەڕێنەوە نەک وەک نەقد، ئەو خاڵانەی دەبوو لەسەری بدرێن هەڵدەوەشێنرێنەوە، و هەر پابەندییەکی دابینکردنی دواخراو کە پێوەی بەستراوە هەڵدەوەشێنرێتەوە. هیچ نابڕدرێت ئەگەر هەڵوەشاندنەوەکە پێش ناردن بێت.

### 7.4 هەڵوەشاندنەوە دوای ناردن
ئەگەر داواکارییەک دوای ناردنی بە هۆکارێک هەڵوەشێنرایەوە کە بۆ فرۆشگا دەگەڕێتەوە، بڕەکە بە تەواوی دەگەڕێتەوە و کڕیار هیچ تێچوویەکی گواستنەوە هەڵناگرێت. بەڵام ئەگەر هەڵوەشاندنەوەکە بە هۆکارێک بێت کە بۆ کڕیار دەگەڕێتەوە، حوکمەکانی ڕەتکردنەوە لە بەردەرگا لە سیاسەتی کڕیندا جێبەجێ دەبن.

### 7.5 ماوەی گەڕاندنەوە
گەڕاندنەوە لە کاتی جێبەجێکردنی هەڵوەشاندنەوەکەدا لە جزداندا دەردەکەوێت، و لەو حاڵەتانەی پێداچوونەوە دەخوازن لە ماوەی زۆرترین {{REFUND_PROCESSING_DAYS}} ڕۆژی کاردا.

### 7.6 هەڵوەشاندنەوە سزا نییە
هەڵوەشاندنەوە بۆ سزادانی کڕیارێک لەسەر ناڕەزایی یان هەڵسەنگاندنی نەرێنی بەکار ناهێنرێت. کڕیار دەتوانێت لە ڕێگەی پشتیوانییەوە ناڕەزایی لە بڕیاری هەڵوەشاندنەوە دەرببڕێت.

### 7.7 کۆگا و حیجزەکان
لە کاتی هەڵوەشاندنەوەدا بڕەکە بۆ کۆگا دەگەڕێتەوە، و ئەو حیجزانەی بە داواکارییەکەوە بەستراون دەکرێنەوە. هەڵوەشاندنەوە ئەو دەرفەتەی ئۆفەرێکی سنووردار ناگەڕێنێتەوە کە سیستەمی ئۆفەر وەک بەکارهێنراو تۆماری کردووە.

## 8. ئۆفەرەکان و پەنجەرەکانیان

### 8.1 دەستپێک و کۆتایی ئۆفەر
هەر ئۆفەرێک دەستپێک و کۆتاییەکی ڕاگەیەنراوی هەیە. پێش دەستپێکی و دوای کۆتاییەکەی جێبەجێ ناکرێت، تەنانەت ئەگەر لەسەر شاشەیەکی نوێنەکراوەوە بمێنێتەوە.

### 8.2 سنوورەکان
ئۆفەر سنوورێکی هەیە بۆ هەر بەکارهێنەرێک و سنوورێکی گشتی. گەیشتن بە سنوورەکە ئۆفەرەکە بە کردەوە کۆتایی پێدەهێنێت تەنانەت ئەگەر ماوەکەی مابێت، و ئەو داواکارییەی لە سنوورەکە تێدەپەڕێت ڕەت دەکرێتەوە.

### 8.3 ئۆفەرە بەندەکان بە ئەندامێتییەوە
ئەو ئۆفەرەی بۆ ئاستێکی دیاریکراوی ئەندامێتی تەرخان کراوە بۆ ئەو کەسە بەردەست نییە کە ئەندامێتییەکەی لە ساتی دروستبوونی داواکاریدا چالاک نییە.

### 8.4 یەک نرخ بۆ هەر کاڵایەک
نرخی ئۆفەری خشتەکراو لەگەڵ نرخێکی دیکە لەسەر هەمان کاڵا کۆ ناکرێتەوە. پاشان کوپۆن بەپێی مەرجەکانی خۆی لەسەر بەهای کاڵا جێبەجێ دەبێت.

### 8.5 کۆتاییهاتنی ئۆفەر لە کاتی کڕیندا
ئەگەر ئۆفەرەکە پێش دروستبوونی داواکارییەکە کۆتایی هات یان سنوورەکەی تەواو بوو، داواکارییەکە بەو نرخە نرخ دەکرێت کە ئەو کاتە کاری پێدەکرا؛ دەرکەوتنی ئۆفەرەکە لەسەر شاشە هیچ مافێکی تێدا دروست ناکات.

### 8.6 کاریگەری دواوە نییە
ئۆفەرێکی نوێ لەسەر داواکارییەک جێبەجێ ناکرێت کە پێش دەستپێکی دروست بووە، و هیچ جیاوازییەک لەسەری داوا ناکرێت، لەگەڵ ڕەچاوکردنی بەشی دەیەم.

## 9. داشکاندنی ئەندامێتی چی دەستەبەر دەکات و چی نا

### 9.1 ئەوەی دەستەبەری دەکات
ئەندامێتی چالاک دەستەبەری دەکات کە نرخ یان داشکاندنە ڕاگەیەنراوەکەی لەسەر کاڵا شایستەکان لە ساتی دروستبوونی داواکاریدا جێبەجێ دەبێت، و بەهای ئەوەی پاشەکەوتی کردووە لەسەر وێنەی ئەو داواکارییە دەپارێزرێت.

### 9.2 ئەوەی دەستەبەری ناکات
ئەندامێتی دەستەبەر ناکات کە هەر کاڵایەک نرخی ئەندامێتی هەبێت، نە ئەوەی داشکاندنەکە بە ڕێژەیەکی جێگیر بمێنێتەوە، نە ئەوەی نرخی ئەندام نزمترین نرخ بێت لە بازاڕدا، نە ئەوەی سوودەکە کرێ و باج و کرێی گەیاندن بگرێتەوە مەگەر بە ڕوونی وترابێت.

### 9.3 کاڵا بێ نرخی ئەندامێتی
ئەو کاڵایەی نرخی ئەندامێتی نییە بە نرخی ئاسایی خۆی دەفرۆشرێت. هیچ داشکاندنێک کە فرۆشگا دیاری نەکردبێت بۆ ئەندام داهێنراو نییە.

### 9.4 مەرجی چالاکی ئەندامێتی
سوودەکە بە دۆخی ئەندامێتی لە ساتی دروستبوونی داواکاریدا دەپێورێت. کۆتاییهاتنی ئەندامێتی دوای داواکارییەکە سوودێکی دراو پەس ناگرێتەوە، و دەستپێکردنی ئەندامێتی دوای داواکارییەکە سوودێک نادات کە نەبووە.

### 9.5 سوودە بەندەکان بە مەرجی دیکەوە
هەندێک سوودی ئەندامێتی بەندن بە سنوورێکی بەهای داواکاری یان ناونیشانێکی پەسەندکراو یان شێوازێکی پارەدان یان جۆرێکی گەیاندنەوە. نەهاتنەدی مەرجەکە سوودەکە تەنها بۆ ئەو داواکارییە دەڕوخێنێت، و سوودەکە بە خۆکار دەگەڕێتەوە لە داواکارییەکی دواتردا کە مەرجەکەی تێدا جێبەجێ بێت.

### 9.6 سوودە ناکۆکەکان کۆ ناکرێنەوە
دوو سوود کە هەمان بڕگە چارەسەر دەکەن کۆ ناکرێنەوە. کاتێک چەندینیان جێبەجێ دەبن، ئەوەیان جێبەجێ دەکرێت کە بۆ کڕیار سوودمەندترە، و ئەمە لە وردەکاری نرخەکەدا ڕوون دەکرێتەوە.

### 9.7 بەخشینی گەیاندن
بەخشینی کرێی گەیاندن سوودێکە بەند بە سنووری بەهای داواکاری و بە مەرجەکانی ئەندامێتییەوە، و وردەکارییەکەی لە سیاسەتی گەیاندندایە. بەخشینەکە ئەو کرێیانە ناگرێتەوە کە دەقی سوودەکە باسیان ناکات.

## 10. پاراستنی نرخ دوای گەیاندن

### 10.1 مافەکە
ئەگەر نرخی کاڵایەک کە بۆ کڕیار گەیەنراوە لە ماوەی حەوت ڕۆژدا لە گەیاندنییەوە داشکا، کڕیار دەتوانێت داوای جیاوازییەکە بکات وەک باڵانس لە جزدانەکەیدا.

### 10.2 ماوەکە
حەوت ڕۆژەکە لە گەیاندنی ڕاستەقینەی تۆمارکراوی کاڵاکەوە دەژمێردرێن. داواکارییەکە لە ناو ماوەکەدا پێشکەش دەکرێت، و سیستەم داواکاری دوای تەواوبوونی ماوەکە وەرناگرێت.

### 10.3 داواکاری تەنها لەسەر کاڵایەکی گەیەنراو
داواکاری پاراستنی نرخ پێش گەیاندنی کاڵاکە وەرناگیرێت. نرخی کاڵایەکی نەگەیەنراو بەندە بە بەشی پێنجەم و شەشەم.

### 10.4 جیاوازییەکە چۆن حساب دەکرێت
ئەوەی کڕیار بە ڕاستی بۆ هەر یەکەیەک داویەتی بەرامبەر نزمترینی دوو نرخ دەکرێت: ئەو نرخەی ئەمڕۆ کڕیارێکی هەمان چینی نرخ دەیدات، و نزمترین نرخی تۆمارکراوی هەمان کاڵا لە ماوەی پاراستنەکەدا. جیاوازییەکە لە بڕی کڕدراو دەدرێت.

### 10.5 بەراورد لە ناو هەمان چینی نرخدا
کڕیاری نرخی ئاسایی بەرامبەر نرخی ئاسایی دەکرێت؛ کڕیاری نرخی PRO بەرامبەر نرخی PRO یان نرخی ئاسایی دەکرێت، هەر کامیان نزمتر بێت. کڕیارێکی ئاسایی هەرگیز بەرامبەر نرخێک ناکرێت کە بۆ ئەندامێتییەک تەرخانە کە خاوەنی نییە.

### 10.6 داشکانێک کە دووبارە بەرز بووەتەوە
ئەو داشکانەی لە ناو ماوەکەدا ڕوویداوە دەژمێردرێت تەنانەت ئەگەر پێش پێشکەشکردنی داواکارییەکە نرخەکە گەڕابێتەوە بۆ جێی خۆی، چونکە بەراوردەکە بەرامبەر ئەو نرخەیە کە لە ناو ماوەکەدا تۆمار کراوە نەک تەنها بەرامبەر نرخی ئەمڕۆ.

### 10.7 بڕیارەکە خۆکار نییە
جیاوازییەکە بە خۆکار نادرێت. داواکارییەکە پێداچوونەوەی بۆ دەکرێت و بە بڕیارێکی هۆکاردار لە ماوەی {{PRICE_CLAIM_DECISION_DAYS}} ڕۆژی کاردا وەردەگیرێت یان ڕەت دەکرێتەوە، و لە کاتی وەرگرتندا بڕەکە لە جزداندا تۆمار دەکرێت.

### 10.8 سنووری کۆکراوە
کۆی ئەوەی لەسەر یەک کاڵا دەدرێت هەرگیز لە جیاوازییە شایستەکە تێناپەڕێت. ئەو بڕانەی پێشتر لەسەری دراون لە هەر داواکارییەکی دواتر دەبڕدرێن.

### 10.9 یەک داواکاری کراوە
لە یەک کاتدا زیاتر لە یەک داواکاری کراوە لەسەر هەمان کاڵا وەرناگیرێت.

### 10.10 ئاراستەی قەرەبوو
جیاوازی نرخ وەک باڵانس لە جزدانی کڕیاردا تۆمار دەکرێت. هەر ئاراستەیەکی دیکە تەنها بە ڕێککەوتن لەگەڵ پشتیوانی دەبێت.

### 10.11 قەرەبووی دووجارە نییە
قەرەبووی پاراستنی نرخ لەگەڵ گەڕاندنەوەی نرخی هەمان کاڵا لە ڕێگەی گەڕاندنەوەوە کۆ ناکرێتەوە. ئەو کەسەی کاڵاکەی گەڕاندووەتەوە و نرخەکەی وەرگرتووەتەوە شایستەی جیاوازی نرخەکەی نییە.

## 11. ئەوەی پاراستنی نرخ ناینوێنێت

### 11.1 کرێ و باجەکان
پاراستن کرێی گەیاندن و باجی پارەدان لە کاتی وەرگرتن و کۆمیسیۆنی گواستنەوە و کرێی گەرەنتی درێژکراوە ناگرێتەوە، چونکە هیچیان بەهای کاڵا نین.

### 11.2 پاکێج وەک تەواو
پاکێج وەک یەک یەکە ناپارێزرێت، چونکە نرخەکەی نرخی پێکهاتەیەکە نەک نرخی کاڵایەک. بەشەکانی بە جیا دەپارێزرێن، هەر بەشێک بە پشکی خۆی لە نرخی پاکێجەکە.

### 11.3 ئۆفەرە سەرسوڕهێنەرەکان
پاراستن کاڵایەکی ئۆفەری سەرسوڕهێنەر ناگرێتەوە، چونکە ئەوەی دراوە نرخی ئۆفەرەکەیە نەک نرخی ئەو کاڵایەی ڕاکێشراوە، و چونکە بەراوردکردنی بەرامبەر نرخی کاڵاکە ئەوە ئاشکرا دەکات کە نابێت ئاشکرا بکرێت.

### 11.4 داواکارییە کۆنەکان
ئەو داواکارییەی پێش تۆمارکردنی وردی گۆڕاوەکانە ناکرێت بە خۆکار بەراورد بکرێت، و بۆ پێداچوونەوەی دەستی ئاراستەی پشتیوانی دەکرێت.

### 11.5 بەرهەمی لابراو یان گۆڕاو
داواکاری وەرناگیرێت ئەگەر ئەو گۆڕاوەی کڕدراوە ئیتر نەکرێت لەسەر بەرهەمی ئێستا نرخ بکرێت، و ئاراستەی پشتیوانی دەکرێت.

### 11.6 داشکانێک کە ناکرێت بەراورد بکرێت
داشکانی نرخی بەرهەمێکی دیکە، هەرچەندە لێکچوو بێت، نەژمێردرێت، و نە نرخێک لای فرۆشیارێکی دیکە، و نە نرخێک لە بازاڕێکی دیکە.

### 11.7 کاڵای بازرگانانی کۆمەڵگا
پاراستنی نرخ لێرەدا تایبەتە بە کاڵای فرۆشگا فەرمییەکە. نرخاندنی کاڵای بازرگانانی کۆمەڵگای لیڤۆ هی بازرگانە، و بەپێی سیاسەتی فرۆشتن لەگەڵ ئەودا لێکۆڵینەوەی لەگەڵ دەکرێت.

## 12. پێشکەشکردن و ناڕەزایی

### 12.1 داواکارییەکە چۆن پێشکەش دەکرێت
داواکاری پاراستنی نرخ لە تۆماری داواکارییەکەوە لە هەژماری کڕیاردا پێشکەش دەکرێت، لەسەر ئەو کاڵایەی مەبەستە بە دیاریکراوی.

### 12.2 ناڕەزایی لە ڕەتکردنەوە
کڕیار دەتوانێت لە ماوەی {{DISPUTE_RESPONSE_DAYS}} ڕۆژدا لە ئاگادارکردنەوەی بڕیارەکەوە، لە ڕێگەی پشتیوانییەوە، ناڕەزایی لە ڕەتکردنەوەی داواکارییەکەی یان لە بڕیاری هەڵوەشاندنەوەی داواکارییەکەی یان لە ڕاستکردنەوەی نرخەکەی دەرببڕێت.

### 12.3 بڕیارەکە لەسەر چی بنیات دەنرێت
بڕیارەکە لەسەر تۆمارەکانی سیستەم بنیات دەنرێت: وێنەی نرخی داواکارییەکە، مێژووی گۆڕانی نرخەکان، بەرواری گەیاندن، و ئەوەی پێشتر لەسەر کاڵاکە دراوە.

### 12.4 هۆکارەکان دەپارێزرێن
هۆکاری هەر وەرگرتن و ڕەتکردنەوە و هەڵوەشاندنەوە و ڕاستکردنەوەیەک تۆمار دەکرێت، و لە کاتی داواکردنیدا بۆ کڕیار ئاشکرا دەکرێت.

## 13. حوکمە کۆتاییەکان

### 13.1 هەموارکردن
فرۆشگا دەتوانێت ئەم سیاسەتە هەموار بکات بە دەرکردنی وەشانێکی نوێ بە ژمارە و بەرواری جێبەجێبوونەوە، و هەمواری کاریگەری دواوەی نییە لەسەر داواکارییەکی پێشوو.

### 13.2 سەربەخۆیی بڕگەکان
پووچبوونەوەی بڕگەیەک کاریگەری لەسەر بڕگەکانی دیکە نییە.

### 13.3 یاسا و دەسەڵاتی دادوەری
ئەم بەڵگەنامەیە بەپێی یاساکانی {{GOVERNING_LAW_JURISDICTION}} دەبێت، و دەسەڵاتی دادوەری بۆ دادگاکانی {{COMPETENT_COURT}}ـە.

### 13.4 خاڵی پەیوەندی
خاڵی پەیوەندی پەسەندکراو {{LEVONIS_SUPPORT_CONTACT}}ـە، و کاتی کارکردن {{LEVONIS_SUPPORT_HOURS}}ـە.`,
  },
};
