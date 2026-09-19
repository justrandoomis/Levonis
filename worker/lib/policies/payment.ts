import type { PolicyDocument } from './types';

/**
 * سياسة الدفع والمحفظة — HOW MONEY MOVES.
 *
 * WHY THE WALLET IS DESCRIBED AS THREE NUMBERS AND NOT ONE (chapter 6). The
 * engine keeps settled, held and available apart on purpose: money reserved
 * for an order or for a filed withdrawal is still in the ledger but is no
 * longer spendable, and a document that said "your balance" would describe a
 * number the customer cannot use. A customer who is refused at checkout with a
 * balance on screen needs the reason written down BEFORE it happens, not
 * explained afterwards by support.
 *
 * WHY THE COMMUNITY PATH HAS ITS OWN CHAPTER (chapter 9). It is prepaid from
 * the wallet with nothing due at the door and no warehouse pickup — not as a
 * setting that happens to be off, but because Levonis holds neither the
 * merchant's stock nor their cash. Saying it plainly here is what stops a
 * customer expecting to pay a merchant's courier in cash.
 */
export const payment: PolicyDocument = {
  key: 'payment',
  version: 1,
  effective_at: '2026-01-01',
  title: {
    ar: 'سياسة الدفع والمحفظة',
    en: 'Payment and Wallet Policy',
    ckb: 'سیاسەتی پارەدان و جزدان',
  },
  body: {
    ar: `## 1. التمهيد والتعريفات

### 1.1 الغرض من هذه الوثيقة
تبيّن هذه الوثيقة وسائل الدفع المقبولة في المتجر، وأحكام محفظة ليفو، وكيف تُحتسب الأرصدة، ومتى يكون المال قابلاً للإنفاق ومتى لا يكون، وكيف تُعاد المبالغ ومتى.

### 1.2 التعريفات
- المحفظة: رصيد الزبون داخل المنصة، المحفوظ بالدولار والمعروض بالدينار العراقي.
- الرصيد المسوّى: مجموع الإيداعات المعتمدة ناقصاً السحوبات المعتمدة.
- المحجوز: المبالغ المحجوزة لطلب قائم أو لطلب سحب مفتوح، وهي مقيدة في الرصيد المسوّى ولا تُنفق.
- الرصيد المتاح: الرصيد المسوّى ناقصاً المحجوز، وهو وحده القابل للإنفاق.
- الإيداع قيد المراجعة: طلب إيداع لم تُعتمد مراجعته بعد، وهو ليس رصيداً.
- الدفع عند الاستلام: تحصيل قيمة الطلب نقداً عند تسليمه إلى عنوان.
- الدفع المسبق: تسديد قيمة الطلب كاملة من المحفظة عند إنشائه.
- الدفع المؤجل: تمويل قيمة الطلب على حساب العضوية لسداده في موعد محدد.

### 1.3 العملة وسعر الصرف
الأسعار معروضة بالدينار العراقي. ورصيد المحفظة محفوظ بالدولار ويُحوَّل بسعر الصرف المعتمد في المتجر لحظة العملية، ويُثبَّت هذا السعر على الطلب. ويُقرَّب التحويل إلى الأعلى بما لا يُنقص من قيمة الدفعة.

### 1.4 النص المعتمد
النص العربي هو المعتمد، والنسختان الإنكليزية والكردية ترجمتان أمينتان له بالترقيم نفسه.

### 1.5 علاقة هذه الوثيقة بغيرها
تُقرأ مع سياسة الشراء، وسياسة البيع، وسياسة الأسعار وتغييرها وإلغاء الطلب، وسياسة الإرجاع.

## 2. وسائل الدفع المقبولة

### 2.1 الوسائل المعروضة
لا تُقبل إلا وسيلة الدفع المعروضة فعلاً في شاشة الدفع لذلك الطلب. وما لا يظهر في تلك الشاشة ليس وسيلة مقبولة مهما ذُكر في مكان آخر.

### 2.2 الوسائل الأساسية
وسائل الدفع الأساسية ثلاث: الدفع المسبق من محفظة ليفو، والدفع عند الاستلام في طلبات المتجر الرسمي، والدفع المؤجل لأعضاء PRO المؤهلين. ولا يُقبل خارج ذلك أي ترتيب دفع.

### 2.3 لا دفع جزئي مقدماً
لا يقبل النظام دفع جزء من القيمة مقدماً وترك الباقي. فإما أن يُدفع الطلب كاملاً مقدماً من المحفظة، وإما أن يُدفع عند الاستلام، مع مراعاة المقدمات الإلزامية في المادة 2.5.

### 2.4 لا دفع خارج المنصة
لا يُقبل أي دفع خارج قنوات المنصة المعلنة. ومن حوّل مالاً إلى حساب شخصي أو إلى جهة لم يعلنها المتجر فعل ذلك على مسؤوليته، ولا يُعدّ ذلك وفاءً بقيمة طلب.

### 2.5 المقدمات الإلزامية
بعض الطلبات تستلزم مقدمة من المحفظة قبل إتمامها ولو اختير الدفع عند الاستلام، ومنها توصيل الطابعة إلى عنوان. وتُخصم المقدمة وحدها من الرصيد، ويبقى الباقي مستحقاً عند الباب، ولا يُسحب الرصيد كله لمجرد وجود مقدمة.

### 2.6 لا رسوم خفية
لا يُضاف إلى الطلب رسم لم يُعرض في شاشة الدفع. وأي زيادة بعد ذلك تخضع لسياسة الأسعار وتغييرها وإلغاء الطلب.

## 3. الدفع عند الاستلام

### 3.1 نطاقه
الدفع عند الاستلام متاح في طلبات متجر ليفونيس الرسمي المسلَّمة إلى عنوان. وهو غير متاح في طلبات متاجر مجتمع ليفو، وغير متاح على الاستلام من المخزن.

### 3.2 المبلغ المستحق عند الباب
المبلغ المستحق عند الباب هو المعروض على الطلب وعلى الفاتورة، بعد خصم ما دُفع مقدماً من المحفظة أو بالنقاط. ولا يُطلب من الزبون مبلغ يخالف الفاتورة.

### 3.3 ضريبة الدفع عند الاستلام
تُضاف ضريبة مقدارها ستة آلاف دينار عن كل خمسمئة ألف دينار كاملة من المبلغ المستحق عند الباب. ولا تُفرض على الطلب المدفوع مسبقاً ولا على الاستلام من المخزن، وقد تُعفى منها بعض مستويات العضوية، ويُعرض مقدارها ومقدار الإعفاء رقمين منفصلين.

### 3.4 التحصيل هو ما يُثبت الدفع
لا يُعدّ الطلب مدفوعاً بمجرد تسليمه، بل بتسجيل التحصيل في النظام. وما يترتب على الدفع من آثار — ومنها تحرير النقاط المكتسبة — يبدأ من تاريخ تسجيل التحصيل.

### 3.5 تعذر الدفع عند الباب
إذا لم يوفّر الزبون المبلغ عند التسليم عُدّ ذلك رفضاً عند الباب، وطُبِّقت عليه أحكام الفصل التاسع من سياسة الشراء.

### 3.6 تقييد الوسيلة
للمتجر حصر شراء حساب معيّن بالدفع المسبق عند تكرار رفض الاستلام أو تعذر التسليم، وفق سياسة البيع.

## 4. الدفع المسبق من المحفظة

### 4.1 لحظة الخصم
في الطلب المدفوع مسبقاً يُخصم المبلغ من الرصيد المتاح لحظة إنشاء الطلب، لا لحظة تأكيده ولا لحظة شحنه.

### 4.2 الحجز ثم التسوية
يُحجز المبلغ ويُسوّى في المعاملة نفسها التي يُكتب فيها الطلب. فلا يوجد طلب مدفوع بلا قيد، ولا قيد بلا طلب، ولا خصم نصفي بسبب انقطاع في الأثناء.

### 4.3 عدم كفاية الرصيد
إذا لم يغطِّ الرصيد المتاح ما هو مطلوب، رُفض الطلب صراحةً وبيان المبلغ الناقص، ولم يُكتب أي قيد. ووجود رصيد مسوّى لا يكفي إذا كان محجوزاً.

### 4.4 النقر المزدوج
إعادة المحاولة بالمفتاح نفسه لا تنشئ خصماً ثانياً، ويعيد النظام الطلب الأول ذاته.

### 4.5 ما يحدث إذا لم يُؤكَّد الطلب
إذا أُلغي الطلب المدفوع قبل تأكيده أو تعذر تأكيده، أُعيد المبلغ إلى المحفظة وفق الفصل الحادي عشر.

## 5. الدفع المؤجل لأعضاء PRO

### 5.1 من يستحقه
الدفع المؤجل مقصور على عضو PRO فعّال، غير مقيّد، معتمد لهذه الخدمة بقرار فردي، ومتحقَّق من هويته، وله عنوان افتراضي معتمد. وتخلّف أي شرط يمنع الخدمة.

### 5.2 الحدود
للخدمة حدّ أدنى لقيمة الطلب، وحدّ ائتماني لكل حساب. ولا يُموَّل طلب يتجاوز المتبقي من الحدّ الائتماني، ويُعرض المتبقي في شاشة الدفع.

### 5.3 موعد السداد
يُسدَّد المبلغ الممول خلال المدة المعلنة في شاشة الدفع، وهي ثلاثون يوماً ما لم يُعلن غيرها، وتُحتسب من تاريخ الطلب.

### 5.4 التأخر في السداد
التأخر عن موعد السداد يوقف الخدمة ويجوز معه تقييد الحساب إلى حين التسوية، إضافة إلى ما يقرره القانون.

### 5.5 إلغاء الطلب الممول
إلغاء الطلب الممول يلغي التزامه المالي المقابل، ولا يبقى على الزبون سداد قيمة طلب أُلغي.

### 5.6 لا تمويل خارج هذه الشروط
لا يُمنح تأجيل ولا تقسيط خارج ما ورد في هذا الفصل، ولا بالاتفاق الشفوي.

## 6. محفظة ليفو: بنية الأرصدة

### 6.1 ثلاثة أرقام لا رقم واحد
تُعرض المحفظة بثلاثة أرقام: الرصيد المسوّى، والمحجوز، والرصيد المتاح. ويُعرض معها الإيداع قيد المراجعة على حدة لأنه ليس رصيداً.

### 6.2 تعريف الرصيد المسوّى
الرصيد المسوّى هو مجموع الإيداعات المعتمدة ناقصاً السحوبات المعتمدة. وهو ما يملكه الزبون دفترياً، وليس بالضرورة ما يستطيع إنفاقه.

### 6.3 تعريف المحجوز
المحجوز هو ما حُجز لطلب قائم أو لطلب سحب مفتوح. ويظل ضمن الرصيد المسوّى إلى أن تُنفَّذ العملية التي حُجز لها أو تُلغى.

### 6.4 تعريف الرصيد المتاح
الرصيد المتاح هو الرصيد المسوّى ناقصاً المحجوز، وهو وحده ما يُنفق في المتجر أو يُسحب.

### 6.5 لماذا المال المحجوز لطلب غير قابل للإنفاق
المال المحجوز لطلب أو لطلب سحب مخصص لتلك العملية. ولولا هذا الحجز لأمكن إنفاق المبلغ نفسه مرتين — مرة في المتجر ومرة في السحب — فيخرج من المتجر ما لم يدخله. ولذلك لا يُقاس الشراء على الرصيد المسوّى بل على المتاح.

### 6.6 النقاط رصيد مستقل
النقاط رصيد منفصل عن المال. لا تتحول النقاط إلى نقد، ولا تُسحب، ولا يُنقص المحجوز المالي منها، وتُستعمل على قيمة البضاعة وحدها بواقع نقطة واحدة لكل دينار.

### 6.7 النقاط المعلّقة
النقاط المكتسبة عن طلب تبقى معلّقة إلى انقضاء مدة الحجز واكتمال تحصيل الطلب، ولا تُنفق قبل تحريرها.

### 6.8 حدود العملية الواحدة
لكل عملية على المحفظة حدّ أعلى وحدّ أدنى يبيّنهما النظام، ولا تُقبل مبالغ كسرية دون الوحدة المحاسبية المعتمدة.

### 6.9 المحفظة ليست حساباً مصرفياً
المحفظة رصيد تشغيلي داخل المتجر، وليست وديعة ولا حساباً مصرفياً ولا أداة ادخار، ولا يترتب عليها فائدة ولا عائد.

## 7. الإيداع

### 7.1 كيف يُطلب الإيداع
يُقدَّم طلب الإيداع بالمبلغ مع إيصال التحويل مرفوعاً في النظام، ومع بيان الجهة والقناة ورقم العملية.

### 7.2 الإيصال ليس دفعاً
رفع الإيصال لا يعني قيد المبلغ. يبقى الطلب قيد المراجعة إلى أن تعتمده الإدارة بعد التحقق من وصول التحويل فعلاً.

### 7.3 مدة المراجعة
تُراجع طلبات الإيداع خلال {{DEPOSIT_REVIEW_HOURS}} ساعة من تقديمها في أيام العمل. والتأخر في المراجعة لا يُنشئ رصيداً.

### 7.4 تحويل واحد قيد واحد
لا يُقيَّد التحويل الواحد مرتين. وإعادة إرسال الطلب بالرقم المرجعي نفسه أو بإيصال مُعاد الاستعمال تُرفض، وتُحال إلى المراجعة بدل أن تُقيَّد.

### 7.5 الإيداع قيد المراجعة غير قابل للإنفاق
المبلغ قيد المراجعة لا يدخل الرصيد المتاح ولا يُشترى به. ويُعرض على حدة حتى لا يُحسب رصيداً.

### 7.6 رفض الإيداع
يُرفض طلب الإيداع عند عدم ثبوت التحويل أو عند اختلاف المبلغ أو عند شبهة التزوير، مع بيان السبب. وتزوير إيصال سبب كافٍ لإيقاف الحساب وللمطالبة بما يترتب عليه.

### 7.7 مصدر المال
يقرّ الزبون بأن المال المودع من مصدر مشروع يخصّه. وللمتجر تعليق العملية وطلب توضيح عند الاشتباه.

## 8. السحب

### 8.1 تقديم الطلب
يُقدَّم طلب السحب من الرصيد المتاح مع بيان وجهة التحويل. ويُحجز المبلغ فور تقديم الطلب فلا يبقى قابلاً للإنفاق في المتجر.

### 8.2 الحدود
لطلب السحب حدّ أدنى وحدّ أعلى يبيّنهما النظام عند التقديم.

### 8.3 الرسوم
لا توجد رسوم سحب مقررة في النظام عند تاريخ نفاذ هذه النسخة، والمبلغ الصافي يساوي المبلغ المطلوب. وإذا قُررت رسوم مستقبلاً أُعلنت قبل تطبيقها وظهرت في بيان الطلب.

### 8.4 مراحل الطلب
يمر طلب السحب بالمراحل: مُقدَّم، ثم موافَق عليه للمعالجة، ثم قيد المعالجة، ثم مدفوع. وقد ينتهي بالرفض أو الإلغاء أو الإخفاق، ولكل حالة سببها المدوّن.

### 8.5 معنى الموافقة
الموافقة تعني الموافقة على المعالجة لا أن المال أُرسل. ولا يُعدّ السحب منفَّذاً إلا بتسجيل الدفع بمرجع تحويل.

### 8.6 التنفيذ اليدوي
تُنفَّذ الحوالات يدوياً بمعرفة الإدارة ولا تُرسل آلياً. وتستغرق المعالجة عادة {{WITHDRAWAL_PAYOUT_DAYS}} يوم عمل من الموافقة.

### 8.7 إلغاء الطلب
للزبون إلغاء طلب السحب قبل بدء المعالجة، ويُفك الحجز عندئذ ويعود المبلغ إلى الرصيد المتاح مرة واحدة.

### 8.8 الإخفاق
إذا أخفقت الحوالة لسبب يعود إلى وجهة التحويل، أُعيد المبلغ إلى الرصيد وأُبلغ الزبون بالسبب، وله تقديم طلب جديد ببيانات صحيحة.

### 8.9 صحة وجهة التحويل
الزبون مسؤول عن صحة بيانات وجهة التحويل. ولا يتحمل المتجر نتيجة تحويل نُفِّذ إلى بيانات خاطئة قدّمها الزبون.

## 9. الدفع في طلبات مجتمع ليفو

### 9.1 الدفع المسبق حصراً
طلبات متاجر مجتمع ليفو تُدفع مقدماً من المحفظة حصراً. ولا يُنشأ الطلب أصلاً ما لم يغطِّ الرصيد المتاح قيمته كاملة.

### 9.2 لا دفع عند الاستلام على هذا المسار
لا يوجد دفع عند الاستلام في طلبات التجار. ولا يُطلب من الزبون مال عند الباب في هذا المسار، ومن طُلب منه ذلك فليرفض وليبلغ الدعم.

### 9.3 لا استلام من المخزن على هذا المسار
لا يوجد استلام من مخزن ليفونيس لطلبات التجار، لأن المتجر لا يحتفظ ببضاعة التاجر.

### 9.4 سبب هذه القاعدة
المتجر لا يملك بضاعة التاجر ولا يحصّل عنه: لا مندوب له عند الباب ولا شباك له في المخزن. فالدفع المسبق ليس خياراً مفعّلاً بل هو بنية هذا المسار.

### 9.5 حجز المبلغ وتسويته
يُحجز مبلغ الطلب ويُسوّى في المعاملة نفسها التي يُنشأ فيها الطلب، ويُقيَّد نصيب التاجر معلّقاً إلى حين التسليم.

### 9.6 إعادة المبلغ عند تعثر التاجر
إذا لم يسلّم التاجر أو توقف عن الرد، فللزبون طلب تدخل الدعم. وتُنفَّذ إعادة المبلغ إلى محفظة الزبون من إدارة المتجر لا من التاجر، وفق سياسة البيع.

## 10. النقاط والكوبونات في الدفع

### 10.1 طبيعة النقاط
النقطة وحدة خصم لا وسيلة دفع خارجية. تُطبَّق على قيمة البضاعة، ولا تُطبَّق على أجرة التوصيل ولا على عمولة النقل ولا على رسم الضمان ولا على ضريبة الدفع عند الاستلام.

### 10.2 سقف الاستعمال
لا يتجاوز ما يُخصم بالنقاط قيمة البضاعة المؤهلة في الطلب، ويُعرض السقف قبل التأكيد.

### 10.3 الكوبون
يُطبَّق الكوبون وفق شروطه ومدته وحدوده، ويُطبَّق على قيمة البضاعة. والكوبون المستنفد أو المنتهي لا يُطبَّق ولو ظهر على شاشة قديمة.

### 10.4 أثر الإلغاء على النقاط
عند إلغاء الطلب تُعاد النقاط المستعملة نقاطاً لا نقداً، وتُلغى النقاط التي كانت ستُمنح عنه.

### 10.5 رمز الدعم لا يغيّر السعر
رمز دعم عضو آخر ينسب الطلب إليه ولا يغيّر قيمته بدينار واحد، ويُقيَّد بأثر مالي صفري صراحةً.

## 11. الاسترداد وإعادة الأموال

### 11.1 وجهة الإعادة
تُعاد المبالغ إلى محفظة الزبون. وأي وجهة أخرى لا تكون إلا باتفاق مع الدعم وبحسب ما تسمح به القنوات المتاحة.

### 11.2 مقدار الإعادة عند الإلغاء قبل التنفيذ
عند إلغاء الطلب قبل تجهيزه يُعاد ما دُفع من المحفظة كاملاً، وتُعاد النقاط نقاطاً، ولا يُقتطع شيء.

### 11.3 الإعادة بالعملة المخصومة
يُعاد إلى المحفظة المبلغ بالقيمة الدولارية نفسها التي خُصمت، فما يظهر بالدينار قد يختلف قليلاً عن الرقم الأصلي إذا تغيّر سعر الصرف بين العمليتين.

### 11.4 مدة الإعادة
تظهر الإعادة إلى المحفظة عند تنفيذ الإلغاء أو عند اعتماد القرار الذي رتّبها، وخلال {{REFUND_PROCESSING_DAYS}} يوم عمل على الأكثر في الحالات التي تستلزم مراجعة.

### 11.5 الإعادة بعد الفحص
الإعادة المترتبة على إرجاع أو عيب لا تُنفَّذ إلا بعد استلام القطعة وفحصها واعتماد القرار، وفق سياسة الإرجاع.

### 11.6 ما لا يُعاد
لا تُعاد أجرة التوصيل المدفوعة فعلاً عن طلب سُلِّم، ولا كلفة الذهاب والإياب في حالات الرفض عند الباب لغير سبب يعود إلى المتجر، ولا عمولة النقل في الطلب المسبق بعد تنفيذ النقل.

### 11.7 الاسترداد لا يُجمع
لا يُجمع بين استرداد مالي وتعويض آخر عن الواقعة نفسها، ولا يُعوَّض مرتين عن المبلغ نفسه.

### 11.8 الطلب المدفوع نقداً عند الباب
الطلب الذي دُفع نقداً عند الباب تُعاد قيمته إلى المحفظة عند استحقاق الإعادة، ما لم يُتفق مع الدعم على وجهة أخرى.

## 12. السجلات والمراجعة والنزاع

### 12.1 سجل العمليات
لكل عملية على المحفظة رقم ووقت وسبب، ويطّلع الزبون على سجله في حسابه.

### 12.2 طلب مراجعة عملية
للزبون طلب مراجعة أي عملية تخصه ببيان السبب. ولا يُفتح لعملية واحدة أكثر من طلب مراجعة قائم في وقت واحد.

### 12.3 ما تعتمد عليه المراجعة
تعتمد المراجعة على سجلات النظام والمستندات المقدمة. وما جرى خارج المنصة لا تمتلك المنصة إثباته.

### 12.4 التصحيح لا يُخترع
لا يُصحَّح رصيد بقيد يدوي دون سبب موثق ومراجعة. ولا تُنشأ أرصدة تعويضية إلا بقرار مسجل.

### 12.5 النزاع لدى جهة الدفع
للزبون عرض نزاعه على جهة الدفع وفق مسارها. وتقديم مطالبة يعلم صاحبها بعدم صحتها، أو تحصيل استرداد مزدوج عن المبلغ نفسه، مخالفة توجب الاسترجاع والإيقاف.

## 13. منع الاحتيال

### 13.1 الممارسات الممنوعة
يُمنع تزوير الإيصالات أو إعادة استعمالها، وإنشاء حسابات وهمية لاستغلال العروض أو النقاط أو الإحالات، وتقسيم المبالغ للتحايل على الحدود، واستغلال خلل واضح في النظام.

### 13.2 الإجراء
للمتجر تعليق العملية أو الطلب أو الحساب إلى حين اكتمال المراجعة، مع بيان السبب وإتاحة الاعتراض.

### 13.3 حدود الإجراء
لا تُصادر أرصدة بصورة تلقائية، ويقتصر التعليق على ما يلزم للمراجعة ولمدة معقولة.

## 14. أحكام ختامية

### 14.1 التعديل
للمتجر تعديل هذه السياسة بإصدار نسخة جديدة برقم وتاريخ نفاذ، ولا يسري التعديل بأثر رجعي على عملية سابقة.

### 14.2 استقلال البنود
بطلان بند لا يمس باقي البنود.

### 14.3 القانون والاختصاص
تخضع هذه الوثيقة لقوانين {{GOVERNING_LAW_JURISDICTION}}، والاختصاص لمحاكم {{COMPETENT_COURT}}.

### 14.4 جهة الاتصال
جهة الاتصال المعتمدة {{LEVONIS_SUPPORT_CONTACT}}، وأوقات العمل {{LEVONIS_SUPPORT_HOURS}}.`,

    en: `## 1. Preamble and Definitions

### 1.1 Purpose of this document
This document sets out the payment methods the Store accepts, the terms of the Levo wallet, how balances are computed, when money is spendable and when it is not, and how and when amounts are returned.

### 1.2 Definitions
- The Wallet: the customer's balance inside the platform, held in dollars and displayed in Iraqi dinars.
- Settled Balance: the sum of approved deposits less approved withdrawals.
- Held: amounts reserved for a standing order or an open withdrawal request; they remain inside the settled balance and are not spent.
- Available Balance: the settled balance less what is held; it alone is spendable.
- Deposit under review: a deposit request not yet approved; it is not a balance.
- Cash on Delivery: collection of the order's value in cash on delivery to an address.
- Prepayment: settlement of the order's full value from the wallet when it is created.
- Deferred payment: financing of the order's value against the membership, to be settled by a stated date.

### 1.3 Currency and exchange rate
Prices are displayed in Iraqi dinars. The wallet balance is held in dollars and converted at the store's applicable exchange rate at the moment of the transaction, and that rate is fixed onto the order. The conversion is rounded so that it never falls short of the payment's value.

### 1.4 Authoritative text
The Arabic text is authoritative; the English and Kurdish versions are faithful translations of it under the same numbering.

### 1.5 Relationship to the other documents
This document is read with the Purchase Policy, the Selling Policy, the Pricing, Price Changes and Order Cancellation Policy, and the Returns Policy.

## 2. Accepted Payment Methods

### 2.1 The methods displayed
Only a payment method actually displayed on that order's checkout screen is accepted. What does not appear on that screen is not an accepted method, wherever else it may be mentioned.

### 2.2 The principal methods
There are three principal methods: prepayment from the Levo wallet, cash on delivery on official-store orders, and deferred payment for eligible PRO members. No other payment arrangement is accepted.

### 2.3 No partial advance
The system does not accept payment of part of the value in advance with the remainder left over. An order is either paid in full in advance from the wallet, or paid on delivery, subject to the compulsory advances in article 2.5.

### 2.4 No payment outside the platform
No payment outside the platform's declared channels is accepted. A person who transfers money to a personal account or to a party the Store has not declared does so at their own risk, and that is not discharge of an order's value.

### 2.5 Compulsory advances
Some orders require an advance from the wallet before they can be placed even where cash on delivery is chosen, home delivery of a printer among them. Only the advance is debited from the balance and the remainder stays due at the door; the whole balance is not swept merely because an advance is due.

### 2.6 No hidden fees
No fee not displayed at checkout is added to the order. Any later increase is governed by the Pricing, Price Changes and Order Cancellation Policy.

## 3. Cash on Delivery

### 3.1 Its scope
Cash on delivery is available on orders from the official LEVONIS store delivered to an address. It is not available on orders from Levo community stores, and it is not available on warehouse pickup.

### 3.2 The amount due at the door
The amount due at the door is the amount stated on the order and on the invoice, after deduction of whatever was paid in advance from the wallet or in points. The customer is not asked for an amount that differs from the invoice.

### 3.3 The cash-on-delivery tax
A tax of six thousand dinars is added for every complete five hundred thousand dinars of the amount payable at the door. It is not charged on a prepaid order or on warehouse pickup; certain membership levels may be exempt from it, and the tax and the exemption are displayed as two separate figures.

### 3.4 Collection is what proves payment
An order is not treated as paid merely because it was delivered, but by the recording of the collection in the system. The consequences of payment — including the release of earned points — run from the date the collection is recorded.

### 3.5 Inability to pay at the door
Where the customer does not have the amount available at delivery, that is treated as a refusal at the door and chapter 9 of the Purchase Policy applies to it.

### 3.6 Restricting the method
The Store may restrict a given account's purchasing to prepayment where refusal of delivery or failed delivery is repeated, under the Selling Policy.

## 4. Prepayment from the Wallet

### 4.1 The moment of the debit
On a prepaid order, the amount is debited from the available balance at the moment the order is created — not when it is confirmed and not when it is dispatched.

### 4.2 Reservation then settlement
The amount is reserved and settled in the same transaction in which the order is written. There is therefore no paid order without an entry, no entry without an order, and no half debit caused by an interruption in between.

### 4.3 Insufficient balance
Where the available balance does not cover what is required, the order is refused expressly with the shortfall stated, and no entry is written. A settled balance does not suffice if it is held.

### 4.4 Double taps
A retry under the same key does not create a second debit; the system returns the first order itself.

### 4.5 What happens if the order is not confirmed
Where a paid order is cancelled before confirmation, or cannot be confirmed, the amount is returned to the wallet under chapter 11.

## 5. Deferred Payment for PRO Members

### 5.1 Who is entitled to it
Deferred payment is confined to an active PRO member who is unrestricted, individually approved for the service, identity-verified, and holding an approved default address. The absence of any one condition withholds the service.

### 5.2 Limits
The service carries a minimum order value and a credit limit per account. An order exceeding the remaining credit limit is not financed, and the remainder is displayed at checkout.

### 5.3 The settlement date
The financed amount is settled within the period stated at checkout, which is thirty days unless otherwise stated, running from the date of the order.

### 5.4 Late settlement
Late settlement suspends the service and may lead to restriction of the account until settlement, in addition to what the law provides.

### 5.5 Cancellation of a financed order
Cancellation of a financed order cancels its corresponding financial obligation; the customer does not remain liable for the value of a cancelled order.

### 5.6 No financing outside these terms
No deferral or instalment plan is granted outside this chapter, and none by oral agreement.

## 6. The Levo Wallet: Structure of Balances

### 6.1 Three numbers, not one
The wallet is displayed as three numbers: the settled balance, what is held, and the available balance. Deposits under review are displayed alongside them and separately, because they are not a balance.

### 6.2 The settled balance defined
The settled balance is the sum of approved deposits less approved withdrawals. It is what the customer holds on the books, and not necessarily what they can spend.

### 6.3 What is held, defined
Held money is money reserved for a standing order or an open withdrawal request. It remains within the settled balance until the operation it was reserved for is executed or cancelled.

### 6.4 The available balance defined
The available balance is the settled balance less what is held, and it alone is what can be spent in the store or withdrawn.

### 6.5 Why money reserved for an order is not spendable
Money reserved for an order or a withdrawal is committed to that operation. Without the reservation the same amount could be spent twice — once in the store and once on the payout — and money would leave the store that never entered it. Purchasing is therefore measured against the available balance and not the settled one.

### 6.6 Points are a separate balance
Points are a balance separate from money. They do not convert into cash, they are not withdrawn, financial holds do not reduce them, and they are applied to the merchandise value alone at one point per dinar.

### 6.7 Pending points
Points earned on an order remain pending until the holding period has run and the order's collection is complete, and are not spent before they are released.

### 6.8 Limits per operation
Each wallet operation carries a maximum and a minimum stated by the system, and amounts below the accounting unit in use are not accepted.

### 6.9 The wallet is not a bank account
The wallet is an operating balance inside the store. It is not a deposit, a bank account or a savings instrument, and it bears neither interest nor return.

## 7. Deposits

### 7.1 How a deposit is requested
A deposit request is submitted with the amount, the transfer receipt uploaded into the system, and the provider, the channel and the transaction reference.

### 7.2 A receipt is not a payment
Uploading a receipt does not credit the amount. The request remains under review until the administration approves it after verifying that the transfer actually arrived.

### 7.3 Review period
Deposit requests are reviewed within {{DEPOSIT_REVIEW_HOURS}} hours of submission on working days. Delay in review does not create a balance.

### 7.4 One transfer, one credit
A single transfer is not credited twice. Resubmission under the same reference, or with a re-used receipt, is refused and referred to review rather than credited.

### 7.5 A deposit under review is not spendable
An amount under review does not enter the available balance and cannot be spent. It is displayed separately so that it is not counted as a balance.

### 7.6 Refusal of a deposit
A deposit request is refused where the transfer is not established, where the amount differs, or where forgery is suspected, with the reason stated. Forging a receipt is sufficient ground to suspend the account and to claim what follows from it.

### 7.7 Source of funds
The customer confirms that the money deposited is from a lawful source belonging to them. The Store may suspend the operation and request clarification where there is suspicion.

## 8. Withdrawals

### 8.1 Filing a request
A withdrawal request is filed against the available balance, stating the destination of the transfer. The amount is reserved as soon as the request is filed and is therefore no longer spendable in the store.

### 8.2 Limits
A withdrawal request carries a minimum and a maximum stated by the system on submission.

### 8.3 Fees
No withdrawal fee is configured in the system at the effective date of this version, and the net amount equals the amount requested. If a fee is set in future it will be published before it applies and will appear in the request's statement.

### 8.4 The stages of a request
A withdrawal request passes through: filed, then approved for processing, then processing, then paid. It may end in refusal, cancellation or failure, each with its recorded reason.

### 8.5 What approval means
Approval means approval for processing, not that the money has been sent. A withdrawal is executed only when the payment is recorded with a transfer reference.

### 8.6 Manual execution
Transfers are executed manually by the administration and are never sent automatically. Processing ordinarily takes {{WITHDRAWAL_PAYOUT_DAYS}} working days from approval.

### 8.7 Cancelling a request
The customer may cancel a withdrawal request before processing begins; the reservation is then released once and the amount returns to the available balance.

### 8.8 Failure
Where a transfer fails for a reason attributable to the destination, the amount is returned to the balance and the customer is informed of the reason, and may file a fresh request with correct details.

### 8.9 Accuracy of the destination
The customer is responsible for the accuracy of the transfer destination details. The Store does not bear the consequence of a transfer executed to incorrect details supplied by the customer.

## 9. Payment on Levo Community Orders

### 9.1 Prepaid exclusively
Orders from Levo community stores are prepaid from the wallet exclusively. The order is not created at all unless the available balance covers its full value.

### 9.2 No cash on delivery on this path
There is no cash on delivery on merchant orders. No money is asked of the customer at the door on this path, and anyone asked for it should refuse and notify support.

### 9.3 No warehouse pickup on this path
There is no pickup from the LEVONIS warehouse for merchant orders, because the Store does not hold the merchant's goods.

### 9.4 The reason for this rule
The Store neither owns the merchant's goods nor collects on their behalf: it has no courier at the door and no counter at the warehouse for them. Prepayment is therefore not a setting that happens to be enabled; it is the structure of this path.

### 9.5 Reservation and settlement
The order's amount is reserved and settled in the same transaction in which the order is created, and the merchant's share is recorded as pending until delivery.

### 9.6 Return of the amount where the merchant defaults
Where the merchant does not deliver or stops answering, the customer may ask support to intervene. The return to the customer's wallet is performed by the Store's administration and not by the merchant, under the Selling Policy.

## 10. Points and Coupons in Payment

### 10.1 The nature of points
A point is a unit of discount, not an external means of payment. Points apply to the merchandise value and do not apply to the delivery fee, the transport commission, the warranty fee or the cash-on-delivery tax.

### 10.2 The ceiling on use
What is discounted in points does not exceed the eligible merchandise value on the order, and the ceiling is displayed before confirmation.

### 10.3 Coupons
A coupon applies under its own conditions, period and limits, and is applied to the merchandise value. An exhausted or expired coupon does not apply even if it appears on a stale screen.

### 10.4 The effect of cancellation on points
On cancellation of an order, points that were spent are returned as points and not as cash, and the points that would have been earned on it are cancelled.

### 10.5 A support code does not change the price
Another member's support code attributes the order to them and does not change its value by a single dinar; it is recorded with an expressly zero monetary effect.

## 11. Refunds and the Return of Money

### 11.1 Destination of the return
Amounts are returned to the customer's wallet. Any other destination is only by arrangement with support and according to what the available channels permit.

### 11.2 The amount returned on cancellation before execution
Where an order is cancelled before it is prepared, what was paid from the wallet is returned in full, points are returned as points, and nothing is deducted.

### 11.3 Return in the currency debited
The amount is returned to the wallet in the same dollar value that was debited, so the figure shown in dinars may differ slightly from the original where the exchange rate changed between the two operations.

### 11.4 Time to return
The return appears in the wallet when the cancellation is executed or when the decision producing it is approved, and within {{REFUND_PROCESSING_DAYS}} working days at most in cases requiring review.

### 11.5 Return after inspection
A return arising from a return case or a defect is executed only after the item has been received, inspected and the decision approved, under the Returns Policy.

### 11.6 What is not returned
The delivery fee actually paid on an order that was delivered is not returned, nor the outbound and return charge in cases of refusal at the door for a reason not attributable to the Store, nor the transport commission on a pre-order after the transport has been performed.

### 11.7 No accumulation of remedies
A refund is not combined with another compensation for the same event, and the same amount is not compensated twice.

### 11.8 An order paid in cash at the door
An order paid in cash at the door has its value returned to the wallet where a return falls due, unless another destination is agreed with support.

## 12. Records, Review and Disputes

### 12.1 The transaction record
Every wallet operation carries a number, a time and a reason, and the customer may view their record in their account.

### 12.2 Requesting a review of an operation
The customer may request a review of any operation belonging to them, stating the reason. No more than one review request may be open at a time for a single operation.

### 12.3 What the review relies on
The review relies on the system's records and the documents submitted. What happened outside the platform is not something the platform can establish.

### 12.4 Corrections are not invented
A balance is not corrected by a manual entry without a documented reason and a review. Compensating balances are created only by a recorded decision.

### 12.5 Disputes with a payment provider
The customer may bring a genuine dispute to their payment provider through that provider's own route. Bringing a claim known to be false, or collecting a double recovery of the same amount, is a breach warranting recovery and suspension.

## 13. Prevention of Fraud

### 13.1 Prohibited practices
Forging or re-using receipts, creating fictitious accounts to exploit offers, points or referrals, splitting amounts to evade limits, and exploiting an evident system fault are prohibited.

### 13.2 The measure taken
The Store may suspend the operation, the order or the account until the review is complete, stating the reason and allowing an objection.

### 13.3 Limits of the measure
Balances are not confiscated automatically, and suspension is confined to what the review requires and to a reasonable period.

## 14. Final Provisions

### 14.1 Amendment
The Store may amend this policy by issuing a new version with a number and an effective date; an amendment has no retroactive effect on an earlier operation.

### 14.2 Severability
The invalidity of one article does not affect the remaining articles.

### 14.3 Law and jurisdiction
This document is governed by the laws of {{GOVERNING_LAW_JURISDICTION}}, and the courts of {{COMPETENT_COURT}} have jurisdiction.

### 14.4 Contact
The approved contact point is {{LEVONIS_SUPPORT_CONTACT}}, and the working hours are {{LEVONIS_SUPPORT_HOURS}}.`,

    ckb: `## 1. پێشەکی و پێناسەکان

### 1.1 مەبەستی ئەم بەڵگەنامەیە
ئەم بەڵگەنامەیە ئەو شێوازانەی پارەدان دیاری دەکات کە فرۆشگا وەریان دەگرێت، مەرجەکانی جزدانی لیڤۆ، چۆنیەتی حسابکردنی باڵانسەکان، کەی پارە خەرجکراوە و کەی نا، و چۆن و کەی بڕەکان دەگەڕێنرێنەوە.

### 1.2 پێناسەکان
- جزدان: باڵانسی کڕیار لە ناو پلاتفۆرمدا، بە دۆلار هەڵدەگیرێت و بە دیناری عێراقی پیشان دەدرێت.
- باڵانسی جێگیرکراو: کۆی داخڵکردنە پەسەندکراوەکان کەم کراوە لە دەرهێنانە پەسەندکراوەکان.
- گیراو: ئەو بڕانەی بۆ داواکارییەکی هەبوو یان بۆ داواکارییەکی دەرهێنانی کراوە گیراون، لە ناو باڵانسی جێگیرکراودا دەمێننەوە و خەرج ناکرێن.
- باڵانسی بەردەست: باڵانسی جێگیرکراو کەم کراوە لە گیراو، و تەنها ئەوە خەرجکراوە.
- داخڵکردنی لەژێر پێداچوونەوە: داواکارییەکی داخڵکردن کە هێشتا پەسەند نەکراوە، و باڵانس نییە.
- پارەدان لە کاتی وەرگرتن: کۆکردنەوەی بەهای داواکارییەکە بە نەقد لە کاتی گەیاندنی بۆ ناونیشانێک.
- پارەدانی پێشەکی: دانی تەواوی بەهای داواکارییەکە لە جزدانەوە لە کاتی دروستبوونیدا.
- پارەدانی دواخراو: دابینکردنی بەهای داواکارییەکە لەسەر ئەندامێتی بۆ دانەوەی لە بەروارێکی دیاریکراودا.

### 1.3 دراو و نرخی ئاڵوگۆڕ
نرخەکان بە دیناری عێراقی پیشان دەدرێن. باڵانسی جزدان بە دۆلار هەڵدەگیرێت و بە نرخی ئاڵوگۆڕی پەسەندکراوی فرۆشگا لە ساتی مامەڵەکەدا دەگۆڕدرێت، و ئەم نرخە لەسەر داواکارییەکە جێگیر دەکرێت. گۆڕینەوەکە بەو شێوەیە خڕ دەکرێتەوە کە هەرگیز لە بەهای پارەدانەکە کەم نەکاتەوە.

### 1.4 دەقی پەسەندکراو
دەقی عەرەبی پەسەندکراوە، و وەشانی ئینگلیزی و کوردی وەرگێڕانی دڵسۆزی ئەون بە هەمان ژمارەگوزاری.

### 1.5 پەیوەندی بە بەڵگەنامەکانی دیکەوە
لەگەڵ سیاسەتی کڕین، سیاسەتی فرۆشتن، سیاسەتی نرخ و گۆڕانی نرخ و هەڵوەشاندنەوەی داواکاری، و سیاسەتی گەڕاندنەوە دەخوێنرێتەوە.

## 2. شێوازە وەرگیراوەکانی پارەدان

### 2.1 ئەو شێوازانەی پیشان دەدرێن
تەنها ئەو شێوازەی پارەدان وەردەگیرێت کە بە ڕاستی لە شاشەی پارەدانی ئەو داواکارییەدا پیشان دەدرێت. ئەوەی لەو شاشەیەدا دەرناکەوێت شێوازێکی وەرگیراو نییە، لە هەر شوێنێکی دیکە باسی کرابێت.

### 2.2 شێوازە سەرەکییەکان
سێ شێوازی سەرەکی هەن: پارەدانی پێشەکی لە جزدانی لیڤۆوە، پارەدان لە کاتی وەرگرتن لە داواکارییەکانی فرۆشگا فەرمییەکەدا، و پارەدانی دواخراو بۆ ئەندامانی شایستەی PRO. هیچ ڕێکخستنێکی دیکەی پارەدان وەرناگیرێت.

### 2.3 پارەدانی بەشەکی پێشەکی نییە
سیستەم دانی بەشێک لە بەهاکە بە پێشەکی و بەجێهێشتنی پاشماوەکە وەرناگرێت. یان داواکارییەکە بە تەواوی پێشەکی لە جزدانەوە دەدرێت، یان لە کاتی وەرگرتندا، لەگەڵ ڕەچاوکردنی پێشەکییە پێویستەکانی بڕگەی 2.5.

### 2.4 پارەدانی دەرەوەی پلاتفۆرم نییە
هیچ پارەدانێکی دەرەوەی کەناڵە ڕاگەیەنراوەکانی پلاتفۆرم وەرناگیرێت. ئەو کەسەی پارە بۆ هەژمارێکی کەسی یان بۆ لایەنێک دەگوازێتەوە کە فرۆشگا ڕایینەگەیاندووە، لەسەر بەرپرسیاریەتی خۆی ئەوە دەکات، و ئەمە دانەوەی بەهای داواکارییەک نییە.

### 2.5 پێشەکییە پێویستەکان
هەندێک داواکاری پێشەکییەک لە جزدانەوە دەخوازن پێش تەواوکردنیان تەنانەت ئەگەر پارەدان لە کاتی وەرگرتنیش هەڵبژێردرا، لەوانەش گەیاندنی چاپکەر بۆ ناونیشانێک. تەنها پێشەکییەکە لە باڵانس دەبڕدرێت و پاشماوەکە لە بەردەرگا دەمێنێتەوە؛ تەنها لەبەر بوونی پێشەکییەک هەموو باڵانسەکە ناسڕدرێتەوە.

### 2.6 کرێی شاراوە نییە
هیچ کرێیەک کە لە شاشەی پارەداندا پیشان نەدراوە بۆ داواکارییەکە زیاد ناکرێت. هەر زیادبوونێکی دواتر بەندە بە سیاسەتی نرخ و گۆڕانی نرخ و هەڵوەشاندنەوەی داواکاری.

## 3. پارەدان لە کاتی وەرگرتن

### 3.1 بواری
پارەدان لە کاتی وەرگرتن لە داواکارییەکانی فرۆشگا فەرمییەکەی لیڤۆنیسدا بەردەستە کە بۆ ناونیشانێک دەگەیەنرێن. لە داواکارییەکانی فرۆشگاکانی کۆمەڵگای لیڤۆدا بەردەست نییە، و لەسەر وەرگرتن لە کۆگاش بەردەست نییە.

### 3.2 ئەو بڕەی لە بەردەرگا دەدرێت
ئەو بڕەی لە بەردەرگا دەدرێت ئەوەیە لەسەر داواکارییەکە و لەسەر پسووڵەکەدا پیشان دراوە، دوای بڕینی ئەوەی پێشەکی لە جزدان یان بە خاڵ دراوە. لە کڕیار بڕێک داوا ناکرێت کە جیاواز بێت لە پسووڵەکە.

### 3.3 باجی پارەدان لە کاتی وەرگرتن
باجێکی شەش هەزار دینار زیاد دەکرێت بۆ هەر پێنج سەد هەزار دینارێکی تەواو لەو بڕەی لە بەردەرگا دەدرێت. لەسەر داواکاری پێشەکی دراو و لەسەر وەرگرتن لە کۆگا زیاد ناکرێت، و لەوانەیە هەندێک ئاستی ئەندامێتی لێی ببەخشرێن، و بڕی باج و بڕی بەخشین وەک دوو ژمارەی جیاواز پیشان دەدرێن.

### 3.4 کۆکردنەوە ئەوەیە پارەدان دەسەلمێنێت
داواکارییەک تەنها بەوەی گەیەنراوە بە دراو دانانرێت، بەڵکو بە تۆمارکردنی کۆکردنەوەکە لە سیستەمدا. ئەو کاریگەرییانەی لە پارەدانەوە دێن — لەوانەش ئازادکردنی خاڵە بەدەستهێنراوەکان — لە بەرواری تۆمارکردنی کۆکردنەوەکەوە دەست پێدەکەن.

### 3.5 نەتوانینی پارەدان لە بەردەرگا
ئەگەر کڕیار بڕەکەی لە کاتی گەیاندندا ئامادە نەکرد، وەک ڕەتکردنەوە لە بەردەرگا دادەنرێت و بەشی نۆیەمی سیاسەتی کڕین لەسەری جێبەجێ دەبێت.

### 3.6 سنووردارکردنی شێوازەکە
فرۆشگا دەتوانێت کڕینی هەژمارێکی دیاریکراو بە پارەدانی پێشەکی سنووردار بکات لە کاتی دووبارەبوونەوەی ڕەتکردنەوەی وەرگرتن یان شکستی گەیاندن، بەپێی سیاسەتی فرۆشتن.

## 4. پارەدانی پێشەکی لە جزدانەوە

### 4.1 ساتی بڕین
لە داواکارییەکی پێشەکی دراودا، بڕەکە لە ساتی دروستبوونی داواکارییەکەدا لە باڵانسی بەردەست دەبڕدرێت — نەک لە کاتی پشتڕاستکردنەوەی و نەک لە کاتی ناردنی.

### 4.2 گرتن پاشان جێگیرکردن
بڕەکە دەگیرێت و لە هەمان ئەو مامەڵەیەدا جێگیر دەکرێت کە داواکارییەکەی تێدا دەنووسرێت. بۆیە نە داواکارییەکی دراو بەبێ تۆمار هەیە، نە تۆمارێک بەبێ داواکاری، و نە بڕینێکی نیوەچڵ بەهۆی پچڕانێکی لە ناوەڕاستدا.

### 4.3 نەبوونی باڵانسی پێویست
ئەگەر باڵانسی بەردەست ئەوەی پێویستە نەیپۆشی، داواکارییەکە بە ڕوونی ڕەت دەکرێتەوە و بڕی کەموکوڕی دیاری دەکرێت، و هیچ تۆمارێک نانووسرێت. بوونی باڵانسێکی جێگیرکراو بەس نییە ئەگەر گیرابێت.

### 4.4 کرتەی دووجارە
هەوڵدانەوە بە هەمان کلیل بڕینی دووەم دروست ناکات، و سیستەم هەمان داواکاری یەکەم دەگەڕێنێتەوە.

### 4.5 ئەگەر داواکارییەکە پشتڕاست نەکرایەوە
ئەگەر داواکارییەکی دراو پێش پشتڕاستکردنەوەی هەڵوەشێنرایەوە یان نەکرا پشتڕاست بکرێتەوە، بڕەکە بەپێی بەشی یازدەیەم بۆ جزدان دەگەڕێتەوە.

## 5. پارەدانی دواخراو بۆ ئەندامانی PRO

### 5.1 کێ شایستەیەتی
پارەدانی دواخراو تەنها بۆ ئەندامێکی PRO ی چالاکە کە سنووردار نەکراوە، بە بڕیارێکی تاکەکەسی بۆ ئەم خزمەتگوزارییە پەسەند کراوە، ناسنامەکەی پشکنین کراوە، و ناونیشانێکی بنەڕەتی پەسەندکراوی هەیە. نەبوونی هەر مەرجێکیان خزمەتگوزارییەکە ڕادەگرێت.

### 5.2 سنوورەکان
خزمەتگوزارییەکە کەمترین بەهای داواکاری و سنوورێکی قەرزی بۆ هەر هەژمارێک هەیە. ئەو داواکارییەی لە پاشماوەی سنووری قەرز تێدەپەڕێت دابین ناکرێت، و پاشماوەکە لە شاشەی پارەداندا پیشان دەدرێت.

### 5.3 بەرواری دانەوە
بڕە دابینکراوەکە لە ماوەی ڕاگەیەنراودا لە شاشەی پارەداندا دەدرێتەوە، کە سی ڕۆژە مەگەر بە جیاوازی ڕاگەیەنرابێت، و لە بەرواری داواکارییەکەوە دەژمێردرێت.

### 5.4 دواکەوتن لە دانەوە
دواکەوتن لە بەرواری دانەوە خزمەتگوزارییەکە ڕادەگرێت و دەکرێت هەژمارەکە سنووردار بکرێت هەتا ڕێکخستن، سەرباری ئەوەی یاسا دیاری دەکات.

### 5.5 هەڵوەشاندنەوەی داواکارییەکی دابینکراو
هەڵوەشاندنەوەی داواکارییەکی دابینکراو پابەندی دارایی بەرامبەرەکەی هەڵدەوەشێنێتەوە، و کڕیار بەرپرسیار نامێنێتەوە لە بەهای داواکارییەکی هەڵوەشێنراوە.

### 5.6 دابینکردن لە دەرەوەی ئەم مەرجانە نییە
هیچ دواخستن یان قیستێک لە دەرەوەی ئەم بەشە نادرێت، و نە بە ڕێککەوتنی زارەکی.

## 6. جزدانی لیڤۆ: پێکهاتەی باڵانسەکان

### 6.1 سێ ژمارە نەک یەک
جزدان بە سێ ژمارە پیشان دەدرێت: باڵانسی جێگیرکراو، گیراو، و باڵانسی بەردەست. داخڵکردنی لەژێر پێداچوونەوە بە جیا لەگەڵیاندا پیشان دەدرێت، چونکە باڵانس نییە.

### 6.2 پێناسەی باڵانسی جێگیرکراو
باڵانسی جێگیرکراو کۆی داخڵکردنە پەسەندکراوەکانە کەم کراوە لە دەرهێنانە پەسەندکراوەکان. ئەوەیە کڕیار لە دەفتەردا خاوەنیەتی، و بە پێویست ئەوە نییە دەتوانێت خەرجی بکات.

### 6.3 پێناسەی گیراو
پارەی گیراو ئەو پارەیەیە کە بۆ داواکارییەکی هەبوو یان داواکارییەکی دەرهێنانی کراوە تەرخان کراوە. لە ناو باڵانسی جێگیرکراودا دەمێنێتەوە هەتا ئەو کارەی بۆی گیراوە جێبەجێ دەکرێت یان هەڵدەوەشێنرێتەوە.

### 6.4 پێناسەی باڵانسی بەردەست
باڵانسی بەردەست باڵانسی جێگیرکراوە کەم کراوە لە گیراو، و تەنها ئەوەیە کە لە فرۆشگادا خەرج دەکرێت یان دەردەهێنرێت.

### 6.5 بۆچی ئەو پارەیەی بۆ داواکارییەک گیراوە خەرج ناکرێت
ئەو پارەیەی بۆ داواکارییەک یان دەرهێنانێک گیراوە بۆ ئەو کارە تەرخان کراوە. بەبێ ئەم گرتنە دەکرا هەمان بڕ دووجار خەرج بکرێت — جارێک لە فرۆشگا و جارێک لە دەرهێنان — و پارەیەک لە فرۆشگا بچێتە دەرەوە کە هەرگیز نەهاتووەتە ژوورەوە. بۆیە کڕین بە باڵانسی بەردەست دەپێورێت نەک بە جێگیرکراوەکە.

### 6.6 خاڵەکان باڵانسێکی سەربەخۆن
خاڵەکان باڵانسێکن جیا لە پارە. نە دەبنە نەقد، نە دەردەهێنرێن، نە گرتنی دارایی کەمیان دەکاتەوە، و تەنها لەسەر بەهای کاڵا بەکار دەهێنرێن بە یەک خاڵ بۆ هەر دینارێک.

### 6.7 خاڵە چاوەڕوانەکان
ئەو خاڵانەی لەسەر داواکارییەک بەدەست دەهێنرێن چاوەڕوان دەمێننەوە هەتا ماوەی گرتنەکە تێدەپەڕێت و کۆکردنەوەی داواکارییەکە تەواو دەبێت، و پێش ئازادکردنیان خەرج ناکرێن.

### 6.8 سنووری هەر کارێک
هەر کارێکی جزدان زۆرترین و کەمترین بڕی هەیە کە سیستەم ڕوونی دەکاتەوە، و بڕی کەمتر لە یەکەی ژمێریاری کارپێکراو وەرناگیرێت.

### 6.9 جزدان هەژماری بانکی نییە
جزدان باڵانسێکی کارکردنە لە ناو فرۆشگادا. نە سپاردەیە، نە هەژماری بانکییە، نە ئامرازی پاشەکەوتکردنە، و نە سوود و نە داهاتی لێ دەکەوێتەوە.

## 7. داخڵکردن

### 7.1 چۆن داوای داخڵکردن دەکرێت
داواکاری داخڵکردن بە بڕەکە و وەسڵی گواستنەوە کە لە سیستەمدا بارکراوە، لەگەڵ ڕوونکردنەوەی لایەن و کەناڵ و ژمارەی مامەڵەکە پێشکەش دەکرێت.

### 7.2 وەسڵ پارەدان نییە
بارکردنی وەسڵ مانای تۆمارکردنی بڕەکە نییە. داواکارییەکە لەژێر پێداچوونەوەدا دەمێنێتەوە هەتا بەڕێوەبەرایەتی پەسەندی دەکات دوای دڵنیابوون لەوەی گواستنەوەکە بە ڕاستی گەیشتووە.

### 7.3 ماوەی پێداچوونەوە
داواکارییەکانی داخڵکردن لە ماوەی {{DEPOSIT_REVIEW_HOURS}} کاتژمێردا لە پێشکەشکردنیانەوە لە ڕۆژانی کاردا پێداچوونەوەیان بۆ دەکرێت. دواکەوتن لە پێداچوونەوە باڵانس دروست ناکات.

### 7.4 یەک گواستنەوە یەک تۆمار
یەک گواستنەوە دووجار تۆمار ناکرێت. ناردنەوەی داواکارییەکە بە هەمان ژمارەی ئاماژە، یان بە وەسڵێکی دووبارە بەکارهێنراو، ڕەت دەکرێتەوە و بۆ پێداچوونەوە دەنێردرێت نەک تۆمار بکرێت.

### 7.5 داخڵکردنی لەژێر پێداچوونەوە خەرج ناکرێت
ئەو بڕەی لەژێر پێداچوونەوەدایە ناچێتە ناو باڵانسی بەردەست و ناکرێت خەرج بکرێت. بە جیا پیشان دەدرێت تاکو وەک باڵانس نەژمێردرێت.

### 7.6 ڕەتکردنەوەی داخڵکردن
داواکاری داخڵکردن ڕەت دەکرێتەوە کاتێک گواستنەوەکە نەسەلمێنرێت یان بڕەکە جیاواز بێت یان گومانی ساختەکاری هەبێت، لەگەڵ ڕوونکردنەوەی هۆکارەکە. ساختەکردنی وەسڵ بەسە بۆ ڕاگرتنی هەژمارەکە و بۆ داواکردنی ئەوەی لێی دەکەوێتەوە.

### 7.7 سەرچاوەی پارە
کڕیار دان بەوەدا دەنێت کە ئەو پارەیەی داخڵ دەکرێت لە سەرچاوەیەکی یاسایی خۆیەتی. فرۆشگا دەتوانێت کارەکە ڕابگرێت و داوای ڕوونکردنەوە بکات لە کاتی گوماندا.

## 8. دەرهێنان

### 8.1 پێشکەشکردنی داواکاری
داواکاری دەرهێنان لە باڵانسی بەردەستەوە پێشکەش دەکرێت لەگەڵ ڕوونکردنەوەی ئاراستەی گواستنەوەکە. بڕەکە هەر کە داواکارییەکە پێشکەش دەکرێت دەگیرێت و ئیتر لە فرۆشگادا خەرجکراو نییە.

### 8.2 سنوورەکان
داواکاری دەرهێنان کەمترین و زۆرترین بڕی هەیە کە سیستەم لە کاتی پێشکەشکردندا ڕوونی دەکاتەوە.

### 8.3 کرێ
لە بەرواری جێبەجێبوونی ئەم وەشانەدا هیچ کرێیەکی دەرهێنان لە سیستەمدا ڕێک نەخراوە، و بڕی سافی یەکسانە بەو بڕەی داوا کراوە. ئەگەر لە داهاتوودا کرێیەک دیاری کرا پێش جێبەجێکردنی ڕادەگەیەنرێت و لە بەیاننامەی داواکارییەکەدا دەردەکەوێت.

### 8.4 قۆناغەکانی داواکاری
داواکاری دەرهێنان بەم قۆناغانەدا تێدەپەڕێت: پێشکەشکراو، پاشان پەسەندکراو بۆ پرۆسێسکردن، پاشان لە پرۆسێسکردندا، پاشان دراو. لەوانەیە بە ڕەتکردنەوە یان هەڵوەشاندنەوە یان شکست کۆتایی بێت، و هەر حاڵەتێک هۆکاری تۆمارکراوی خۆی هەیە.

### 8.5 مانای پەسەندکردن
پەسەندکردن مانای پەسەندکردنە بۆ پرۆسێسکردن، نەک ئەوەی پارەکە نێردراوە. دەرهێنان تەنها کاتێک جێبەجێ دەبێت کە پارەدانەکە بە ئاماژەیەکی گواستنەوە تۆمار بکرێت.

### 8.6 جێبەجێکردنی دەستی
گواستنەوەکان بە دەستی لەلایەن بەڕێوەبەرایەتییەوە جێبەجێ دەکرێن و هەرگیز بە خۆکار نانێردرێن. پرۆسێسکردن بە ئاسایی {{WITHDRAWAL_PAYOUT_DAYS}} ڕۆژی کاری دەوێت لە پەسەندکردنەوە.

### 8.7 هەڵوەشاندنەوەی داواکاری
کڕیار دەتوانێت داواکاری دەرهێنان پێش دەستپێکردنی پرۆسێسکردن هەڵبوەشێنێتەوە؛ ئەوسا گرتنەکە یەک جار دەکرێتەوە و بڕەکە بۆ باڵانسی بەردەست دەگەڕێتەوە.

### 8.8 شکست
ئەگەر گواستنەوەکە بە هۆکارێک شکستی هێنا کە بۆ ئاراستەکە دەگەڕێتەوە، بڕەکە بۆ باڵانس دەگەڕێتەوە و کڕیار بە هۆکارەکە ئاگادار دەکرێتەوە، و دەتوانێت داواکارییەکی نوێ بە زانیاری ڕاستەوە پێشکەش بکات.

### 8.9 ڕاستی ئاراستەی گواستنەوە
کڕیار بەرپرسیارە لە ڕاستی زانیاری ئاراستەی گواستنەوەکە. فرۆشگا بەرپرسیار نییە لە ئەنجامی گواستنەوەیەک کە بۆ زانیاری هەڵەی پێشکەشکراو لەلایەن کڕیارەوە جێبەجێ کراوە.

## 9. پارەدان لە داواکارییەکانی کۆمەڵگای لیڤۆدا

### 9.1 تەنها پێشەکی
داواکارییەکانی فرۆشگاکانی کۆمەڵگای لیڤۆ تەنها پێشەکی لە جزدانەوە دەدرێن. داواکارییەکە لە بنەڕەتدا دروست نابێت مەگەر باڵانسی بەردەست تەواوی بەهاکەی بپۆشێت.

### 9.2 لەم ڕێڕەوەدا پارەدان لە کاتی وەرگرتن نییە
لە داواکارییەکانی بازرگاناندا پارەدان لە کاتی وەرگرتن نییە. لەم ڕێڕەوەدا هیچ پارەیەک لە بەردەرگا لە کڕیار داوا ناکرێت، و ئەوەی داوای لێ بکرێت دەبێت ڕەتی بکاتەوە و پشتیوانی ئاگادار بکاتەوە.

### 9.3 لەم ڕێڕەوەدا وەرگرتن لە کۆگا نییە
بۆ داواکارییەکانی بازرگانان وەرگرتن لە کۆگای لیڤۆنیس نییە، چونکە فرۆشگا کاڵای بازرگان هەڵناگرێت.

### 9.4 هۆکاری ئەم ڕێسایە
فرۆشگا نە خاوەنی کاڵای بازرگانە و نە لە جیاتی ئەو کۆ دەکاتەوە: نە گەیەنەری هەیە لە بەردەرگا و نە پەنجەرەی هەیە لە کۆگادا بۆی. بۆیە پارەدانی پێشەکی ڕێکخستنێک نییە کە چالاک کرابێت، بەڵکو پێکهاتەی ئەم ڕێڕەوەیە.

### 9.5 گرتن و جێگیرکردنی بڕەکە
بڕی داواکارییەکە لە هەمان ئەو مامەڵەیەدا دەگیرێت و جێگیر دەکرێت کە داواکارییەکەی تێدا دروست دەبێت، و بەشی بازرگان وەک چاوەڕوان تۆمار دەکرێت هەتا گەیاندن.

### 9.6 گەڕاندنەوەی بڕەکە لە کاتی سەرنەکەوتنی بازرگان
ئەگەر بازرگان ڕایدەستنەکرد یان وەڵامدانەوەی ڕاگرت، کڕیار دەتوانێت داوای دەستێوەردانی پشتیوانی بکات. گەڕاندنەوە بۆ جزدانی کڕیار لەلایەن بەڕێوەبەرایەتی فرۆشگاوە جێبەجێ دەکرێت نەک لەلایەن بازرگانەوە، بەپێی سیاسەتی فرۆشتن.

## 10. خاڵ و کوپۆن لە پارەداندا

### 10.1 سروشتی خاڵەکان
خاڵ یەکەیەکی داشکاندنە نەک شێوازێکی دەرەکی پارەدان. خاڵەکان لەسەر بەهای کاڵا جێبەجێ دەبن و لەسەر کرێی گەیاندن یان کۆمیسیۆنی گواستنەوە یان کرێی گەرەنتی یان باجی پارەدان لە کاتی وەرگرتن جێبەجێ نابن.

### 10.2 سنووری بەکارهێنان
ئەوەی بە خاڵ دادەشکێندرێت لە بەهای کاڵای شایستەی داواکارییەکە تێناپەڕێت، و سنوورەکە پێش پشتڕاستکردنەوە پیشان دەدرێت.

### 10.3 کوپۆن
کوپۆن بەپێی مەرج و ماوە و سنوورەکانی خۆی جێبەجێ دەبێت و لەسەر بەهای کاڵا جێبەجێ دەکرێت. کوپۆنی تەواوبوو یان بەسەرچوو جێبەجێ نابێت تەنانەت ئەگەر لەسەر شاشەیەکی کۆنەوە دەربکەوێت.

### 10.4 کاریگەری هەڵوەشاندنەوە لەسەر خاڵەکان
لە کاتی هەڵوەشاندنەوەی داواکارییەکدا ئەو خاڵانەی بەکار هێنراون وەک خاڵ دەگەڕێنەوە نەک وەک نەقد، و ئەو خاڵانەی دەبوو لەسەری بدرێن هەڵدەوەشێنرێنەوە.

### 10.5 کۆدی پشتگیری نرخ ناگۆڕێت
کۆدی پشتگیری ئەندامێکی دیکە داواکارییەکە بەو دەداتەوە پاڵ و بەهاکەی بە یەک دیناریش ناگۆڕێت، و بە کاریگەرییەکی داراییی سفری ڕوون تۆمار دەکرێت.

## 11. گەڕاندنەوەی پارە

### 11.1 ئاراستەی گەڕاندنەوە
بڕەکان بۆ جزدانی کڕیار دەگەڕێنرێنەوە. هەر ئاراستەیەکی دیکە تەنها بە ڕێککەوتن لەگەڵ پشتیوانی و بەپێی ئەوەی کەناڵە بەردەستەکان ڕێگەی پێدەدەن دەبێت.

### 11.2 بڕی گەڕاندنەوە لە کاتی هەڵوەشاندنەوە پێش جێبەجێکردن
کاتێک داواکارییەک پێش ئامادەکردنی هەڵدەوەشێنرێتەوە، ئەوەی لە جزدانەوە دراوە بە تەواوی دەگەڕێتەوە، خاڵەکان وەک خاڵ دەگەڕێنەوە، و هیچ نابڕدرێت.

### 11.3 گەڕاندنەوە بەو دراوەی بڕدراوە
بڕەکە بە هەمان بەهای دۆلاری بڕدراو بۆ جزدان دەگەڕێتەوە، بۆیە ئەوەی بە دینار دەردەکەوێت لەوانەیە کەمێک جیاواز بێت لە ژمارە بنەڕەتییەکە ئەگەر نرخی ئاڵوگۆڕ لە نێوان دوو کارەکەدا گۆڕابێت.

### 11.4 ماوەی گەڕاندنەوە
گەڕاندنەوە لە کاتی جێبەجێکردنی هەڵوەشاندنەوەکە یان لە کاتی پەسەندکردنی ئەو بڕیارەی دروستی کردووە لە جزداندا دەردەکەوێت، و لەو حاڵەتانەی پێداچوونەوە دەخوازن لە ماوەی زۆرترین {{REFUND_PROCESSING_DAYS}} ڕۆژی کاردا.

### 11.5 گەڕاندنەوە دوای پشکنین
ئەو گەڕاندنەوەیەی لە گەڕاندنەوەی کاڵا یان لە عەیبێکەوە دێت تەنها دوای وەرگرتنی کاڵاکە و پشکنینی و پەسەندکردنی بڕیارەکە جێبەجێ دەکرێت، بەپێی سیاسەتی گەڕاندنەوە.

### 11.6 ئەوەی ناگەڕێتەوە
ئەو کرێی گەیاندنەی بە ڕاستی لەسەر داواکارییەکی گەیەنراو دراوە ناگەڕێتەوە، و نە کرێی چوون و هاتنەوە لە حاڵەتەکانی ڕەتکردنەوە لە بەردەرگا بۆ هۆکارێک کە بۆ فرۆشگا ناگەڕێتەوە، و نە کۆمیسیۆنی گواستنەوە لە داواکاری پێشوەختدا دوای جێبەجێکردنی گواستنەوەکە.

### 11.7 قەرەبووەکان کۆ ناکرێنەوە
گەڕاندنەوەی دارایی لەگەڵ قەرەبووێکی دیکە لەسەر هەمان ڕووداو کۆ ناکرێتەوە، و هەمان بڕ دووجار قەرەبوو ناکرێتەوە.

### 11.8 داواکاری بە نەقد لە بەردەرگا دراو
ئەو داواکارییەی بە نەقد لە بەردەرگا دراوە، لە کاتی شایستەبوونی گەڕاندنەوەدا بەهاکەی بۆ جزدان دەگەڕێتەوە، مەگەر لەگەڵ پشتیوانیدا ئاراستەیەکی دیکە ڕێککەوتی لەسەر بکرێت.

## 12. تۆمارەکان، پێداچوونەوە و ناکۆکی

### 12.1 تۆماری کارەکان
هەر کارێکی جزدان ژمارە و کات و هۆکاری هەیە، و کڕیار دەتوانێت تۆمارەکەی لە هەژمارەکەیدا ببینێت.

### 12.2 داوای پێداچوونەوەی کارێک
کڕیار دەتوانێت داوای پێداچوونەوەی هەر کارێک بکات کە هی خۆیەتی، بە ڕوونکردنەوەی هۆکارەکە. بۆ یەک کار زیاتر لە یەک داواکاری پێداچوونەوەی کراوە لە یەک کاتدا ناکرێتەوە.

### 12.3 پێداچوونەوە پشت بە چی دەبەستێت
پێداچوونەوە پشت بە تۆمارەکانی سیستەم و ئەو بەڵگانە دەبەستێت کە پێشکەش کراون. ئەوەی لە دەرەوەی پلاتفۆرم ڕوویداوە پلاتفۆرم ناتوانێت بیسەلمێنێت.

### 12.4 ڕاستکردنەوە داهێنراو نییە
باڵانس بە تۆمارێکی دەستی ڕاست ناکرێتەوە بەبێ هۆکارێکی تۆمارکراو و پێداچوونەوە. باڵانسی قەرەبوو تەنها بە بڕیارێکی تۆمارکراو دروست دەکرێت.

### 12.5 ناکۆکی لای لایەنی پارەدان
کڕیار دەتوانێت ناکۆکییەکی ڕاستەقینە بۆ لایەنی پارەدانەکەی بەپێی ڕێڕەوی خۆی بەرز بکاتەوە. پێشکەشکردنی داواکارییەک کە خاوەنەکەی دەزانێت ڕاست نییە، یان وەرگرتنی گەڕاندنەوەی دووجارە لەسەر هەمان بڕ، پێشێلکارییە کە گەڕاندنەوە و ڕاگرتن دەخوازێت.

## 13. ڕێگریکردن لە ساختەکاری

### 13.1 کردەوە قەدەغەکراوەکان
ساختەکردن یان دووبارە بەکارهێنانی وەسڵەکان، دروستکردنی هەژماری خەیاڵی بۆ سوودوەرگرتن لە ئۆفەر یان خاڵ یان ناردن، دابەشکردنی بڕەکان بۆ لادان لە سنوورەکان، و سوودوەرگرتن لە خەڵەڵێکی ئاشکرای سیستەم قەدەغەن.

### 13.2 ئەو ڕێکارەی دەگیرێتەبەر
فرۆشگا دەتوانێت کارەکە یان داواکارییەکە یان هەژمارەکە ڕابگرێت هەتا پێداچوونەوەکە تەواو دەبێت، لەگەڵ ڕوونکردنەوەی هۆکارەکە و ڕێگەدان بە ناڕەزایی.

### 13.3 سنووری ڕێکارەکە
باڵانس بە خۆکار دەستبەسەردا ناگیرێت، و ڕاگرتن لە سنووری پێویستی پێداچوونەوە و لە ماوەیەکی گونجاودا دەمێنێتەوە.

## 14. حوکمە کۆتاییەکان

### 14.1 هەموارکردن
فرۆشگا دەتوانێت ئەم سیاسەتە هەموار بکات بە دەرکردنی وەشانێکی نوێ بە ژمارە و بەرواری جێبەجێبوونەوە، و هەمواری کاریگەری دواوەی نییە لەسەر کارێکی پێشوو.

### 14.2 سەربەخۆیی بڕگەکان
پووچبوونەوەی بڕگەیەک کاریگەری لەسەر بڕگەکانی دیکە نییە.

### 14.3 یاسا و دەسەڵاتی دادوەری
ئەم بەڵگەنامەیە بەپێی یاساکانی {{GOVERNING_LAW_JURISDICTION}} دەبێت، و دەسەڵاتی دادوەری بۆ دادگاکانی {{COMPETENT_COURT}}ـە.

### 14.4 خاڵی پەیوەندی
خاڵی پەیوەندی پەسەندکراو {{LEVONIS_SUPPORT_CONTACT}}ـە، و کاتی کارکردن {{LEVONIS_SUPPORT_HOURS}}ـە.`,
  },
};
