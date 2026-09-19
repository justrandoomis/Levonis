import type { PolicyDocument } from './types';

/**
 * سياسة البيع — THE STORE'S SIDE OF THE SALE.
 *
 * WHY A SEPARATE DOCUMENT FROM THE PURCHASE POLICY. The purchase policy binds
 * the customer; this one binds the Store and states the limits of what it
 * undertakes — that a photograph is indicative, that a manufacturer may change
 * a specification, that stock is judged at confirmation and not at the moment
 * an item was added to a cart. A document that only granted the Store rights
 * would be worthless in front of a customer; a document that only imposed
 * duties would be worthless in front of a bank. Both halves are here.
 *
 * WHY THE TWO SELLING CHANNELS ARE SEPARATED SO SHARPLY (chapter 6 onward).
 * The code keeps them apart on purpose: a cart holds ONE seller, a merchant
 * order is prepaid from the wallet with no cash on delivery and no warehouse
 * pickup, and a merchant's payout is pending until they deliver. A policy that
 * blurred the two would promise a LEVONIS remedy for a merchant's default.
 */
export const selling: PolicyDocument = {
  key: 'selling',
  version: 1,
  effective_at: '2026-01-01',
  title: {
    ar: 'سياسة البيع',
    en: 'Selling Policy',
    ckb: 'سیاسەتی فرۆشتن',
  },
  body: {
    ar: `## 1. التمهيد والنطاق

### 1.1 الغرض من هذه الوثيقة
تبيّن هذه الوثيقة ما يلتزم به المتجر تجاه الزبون، وحدود هذا الالتزام، وحقوق المتجر في رفض الطلب أو تقييده، والفرق بين البيع من متجر ليفونيس الرسمي والبيع عبر متاجر مجتمع ليفو.

### 1.2 الأطراف
المتجر: {{LEVONIS_LEGAL_NAME}}، المسجل برقم {{LEVONIS_REGISTRATION_NO}}. والتاجر: كل بائع مستقل يملك متجراً داخل مجتمع ليفو. والزبون: صاحب الحساب المشتري.

### 1.3 التعريفات
- البائع: الطرف الذي تنشأ عليه التزامات البيع في طلب معيّن، وهو ليفونيس في طلبات المتجر الرسمي والتاجر في طلبات متاجر المجتمع.
- الوصف: نص المنتج وخصائصه المعروضة على صفحته.
- الصورة الإيضاحية: أي صورة أو فيديو أو نموذج ثلاثي الأبعاد يعرض المنتج.
- التأكيد: قبول المتجر للطلب وبدء تجهيزه.
- المنصة: نظام ليفونيس بكل خدماته، بما فيها مساحة مجتمع ليفو.

### 1.4 النص المعتمد
النص العربي هو المعتمد، والنسختان الإنكليزية والكردية ترجمتان أمينتان له بالترقيم نفسه.

### 1.5 علاقة هذه الوثيقة بغيرها
تُقرأ مع سياسة الشراء، وسياسة الدفع والمحفظة، وسياسة الأسعار وتغييرها وإلغاء الطلب، وسياسة التوصيل، وسياسة الضمان، وسياسة الإرجاع.

## 2. ما يلتزم به المتجر

### 2.1 بيع ما هو معروض فعلاً
يلتزم المتجر ببيع القطعة الموصوفة على صفحتها بالمواصفة المعلنة، وبعدم استبدالها بقطعة أدنى دون إعلام الزبون وأخذ موافقته.

### 2.2 تسعير معلن ومحسوب من الخادم
يلتزم المتجر بأن يكون السعر المعروض في شاشة الدفع هو السعر المحتسب فعلاً على الطلب، بكل بنوده، من غير رسم خفي ولا زيادة غير معلنة.

### 2.3 بيان مكوّنات السعر
يلتزم المتجر ببيان قيمة البضاعة وأجرة التوصيل وعمولة النقل ورسم الضمان وضريبة الدفع عند الاستلام والخصومات، كل بند على حدة، قبل الطلب وعلى الفاتورة.

### 2.4 تجهيز الطلب المؤكد
يلتزم المتجر بتجهيز الطلب المؤكد وتسليمه إلى شركة التوصيل خلال المدة المعتادة لنوع شحنه، مع مراعاة المدد التقديرية المبينة في سياسة الشراء.

### 2.5 تحديث حالة الطلب
يلتزم المتجر بتحديث حالة الطلب على مساره، وبأن تكون الحالة المعروضة في حساب الزبون هي الحالة الحقيقية للطلب.

### 2.6 حفظ لقطة الطلب
يلتزم المتجر بحفظ لقطة ثابتة لسعر الطلب ومزاياه وعنوانه ووسيلة دفعه، وبعدم تعديلها بعد إنشاء الطلب. وتغيير الإعدادات لاحقاً لا يعيد حساب طلب سابق.

### 2.7 إصدار الفاتورة
يلتزم المتجر بإصدار فاتورة لكل طلب، وبإتاحتها للزبون في حسابه.

### 2.8 الضمان وفق وثيقته
يلتزم المتجر بضمان القطع وفق سياسة الضمان: التغطية الأساسية اثنا عشر شهراً من التسليم الفعلي، ويجوز تمديدها إلى أربعة وعشرين شهراً بشراء التمديد قبل إنشاء الطلب لا بعده. والضمان يغطي الأجزاء المعيبة مصنعياً، ويُنفَّذ بإصلاح الجزء المعيب أو استبداله، لا باستبدال الجهاز كاملاً.

### 2.9 حفظ بيانات الزبون
يلتزم المتجر بحفظ بيانات الزبون وعدم تسليمها لغير من يلزم لتنفيذ الطلب، وفق سياسة الخصوصية.

### 2.10 حدود ما يلتزم به المتجر
لا يلتزم المتجر بما لم يُعرض على صفحة المنتج أو في شاشة الدفع، ولا بما وُعد به شفاهاً أو خارج المنصة، ولا بأداء لا يذكره وصف المنتج.

## 3. الوصف والصور والمواصفات

### 3.1 الصور إيضاحية
الصور والفيديوهات والنماذج المعروضة إيضاحية للتعريف بالمنتج. وقد تختلف الألوان بحسب شاشة العرض والإضاءة، وقد تُظهر الصورة ملحقاً أو خلفية أو قطعة مرافقة ليست جزءاً من البيع.

### 3.2 ما يشمله البيع هو المذكور نصاً
المعوَّل عليه في تحديد محتويات الصندوق هو النص المكتوب في وصف المنتج، لا ما يظهر في الصورة. وما لم يُذكر نصاً ليس جزءاً من البيع.

### 3.3 المواصفات المنقولة عن المصنّع
المواصفات الفنية منقولة عن المصنّع أو الموزع. وقد يغيّر المصنّع مواصفة أو إصداراً أو ملحقاً أو تغليفاً دون إشعار مسبق، ولا يُعدّ ذلك مخالفة من المتجر ما دامت القطعة المسلَّمة هي الموديل المطلوب بوظيفته المعلنة.

### 3.4 تغيّر المواصفة بعد الطلب
إذا تغيّرت مواصفة جوهرية بعد الطلب وقبل التسليم، أُعلم الزبون وخُيِّر بين القبول أو الإلغاء مع إعادة ما دفعه. والتغيّر غير الجوهري لا يعطي حق الإلغاء.

### 3.5 القياسات والأوزان
القياسات والأوزان تقريبية ضمن هامش التصنيع المعتاد، ما لم يُنصّ على خلاف ذلك في الوصف.

### 3.6 الأداء والتوافق
لا يضمن المتجر توافق المنتج مع أجهزة أو برامج أو مواد لم يذكرها الوصف، ولا نتيجة إنتاجية معيّنة تعتمد على إعدادات المستخدم أو خبرته أو بيئة التشغيل.

### 3.7 الأخطاء الطباعية
الخطأ الطباعي الظاهر في وصف أو سعر أو رقم لا يُنشئ التزاماً على المتجر، ويُصحَّح وفق سياسة الأسعار وتغييرها وإلغاء الطلب.

### 3.8 اللغة المعتمدة في الوصف
عند اختلاف نسختي الوصف العربية والإنكليزية لمنتج، يُرجَّح النص العربي، وعند الشك يُرجع إلى مواصفة المصنّع الرسمية.

## 4. التوفر والمخزون

### 4.1 التوفر عند لحظة التأكيد
عرض المنتج على الموقع لا يعني توفره. المخزون يخضع للتوفر لحظة تأكيد الطلب، ويُعاد التحقق منه عند إنشاء الطلب لا عند إضافته إلى السلة.

### 4.2 نفاد الكمية بين الطلب والتأكيد
إذا نفدت الكمية بعد إنشاء الطلب وقبل تأكيده، أُبلغ الزبون وخُيِّر بين الانتظار أو البديل أو الإلغاء مع إعادة ما دفع كاملاً.

### 4.3 التوفر في الطلب المسبق
في الطلب المسبق يكون التوفر لدى المجهّز لا لدى المتجر، وقد يعتذر المجهّز أو يتأخر. ويطبَّق في هذه الحالة ما ورد في سياسة الشراء بشأن الطلب المسبق.

### 4.4 الحجز
لا يُحجز مخزون لصالح زبون قبل إنشاء طلبه، ولا تُعدّ السلة ولا قائمة الرغبات حجزاً.

### 4.5 الطلبات المتزامنة
عند تزاحم أكثر من طلب على آخر قطعة، تكون الأولوية لأول طلب اكتمل إنشاؤه في النظام، بصرف النظر عن وقت الإضافة إلى السلة.

### 4.6 المنتجات المسحوبة
للمتجر سحب منتج من العرض في أي وقت. والسحب لا يمس طلباً مؤكداً قائماً قبله.

## 5. حق المتجر في رفض الطلب أو تقييده

### 5.1 الحق في الرفض
للمتجر رفض أي طلب قبل تأكيده، أو تقييد كميته، أو حصره بوسيلة دفع معيّنة، مع بيان السبب للزبون.

### 5.2 الشراء بقصد إعادة البيع
للمتجر رفض الطلب أو تقييد كميته عند وجود قرائن على الشراء بقصد إعادة البيع، ومنها تكرار طلب القطعة نفسها بكميات كبيرة، أو تعدد الطلبات إلى عنوان واحد بأسماء مختلفة، أو استهداف عرض محدود بكميات غير معتادة.

### 5.3 تعذر الوصول إلى الزبون
للمتجر إلغاء الطلب إذا تعذر الوصول إلى الزبون على الرقم المسجل أو تعذر التحقق من عنوانه خلال {{ORDER_CONFIRMATION_WINDOW_HOURS}} ساعة، أو إذا لم يرد على شركة التوصيل بعد {{FAILED_DELIVERY_ATTEMPTS}} محاولات.

### 5.4 سجل رفض الاستلام
للمتجر حصر شراء الحساب بالدفع المسبق، أو رفض طلباته، إذا كان له سجل من رفض الاستلام أو من تعذر التسليم، لأن كل واقعة منها تحمّل المتجر أجرة ذهاب وإياب لا يقابلها بيع.

### 5.5 إساءة استعمال العروض والنقاط والإحالات
للمتجر رفض الطلب وإسقاط المزية عند إساءة استعمال كوبون أو عرض أو نقاط أو إحالات، أو عند استعمال حسابات متعددة لغرض واحد.

### 5.6 الاشتباه في وسيلة الدفع
للمتجر رفض الطلب أو تعليقه عند الاشتباه في مصدر الرصيد أو في إيصال إيداع أو عند نزاع دفع قائم، إلى أن تكتمل المراجعة.

### 5.7 السلوك المسيء
للمتجر رفض التعامل مع حساب صدر عنه سلوك مسيء تجاه العاملين أو مندوبي التوصيل أو أعضاء المجتمع.

### 5.8 مخالفة الاستعمال المشروع
للمتجر رفض طلب يُراد به استعمال مخالف للقانون أو للاستعمال المعلن للمنتج.

### 5.9 أثر الرفض على المبالغ
إذا رُفض طلب مدفوع، أُعيد ما دُفع كاملاً وفق سياسة الدفع والمحفظة، ما لم يكن الرفض بعد شحن الطرد، فتطبَّق عندئذ أحكام الرفض عند الباب.

### 5.10 حق الاعتراض
للزبون الاعتراض على الرفض أو التقييد عبر الدعم خلال {{DISPUTE_RESPONSE_DAYS}} يوماً، ويُبحث اعتراضه على أساس ما هو مسجل في النظام.

## 6. الفرق بين متجر ليفونيس الرسمي ومجتمع ليفو

### 6.1 متجر ليفونيس الرسمي
في المتجر الرسمي يكون ليفونيس هو البائع: البضاعة بضاعته، ومخزنه مصدرها، وهو المسؤول عن السعر والتجهيز والتوصيل والضمان والإرجاع وفق وثائقه.

### 6.2 مجتمع ليفو
في مجتمع ليفو يكون التاجر هو البائع، وتوفر المنصة العرض والسلة والطلب والدفع والمحادثة ونقل المال. ولا يصبح ليفونيس بائعاً للبضاعة لمجرد أنها عُرضت داخل منصته.

### 6.3 وسائل الدفع والتسليم في كل مسار
المتجر الرسمي يتيح الدفع من المحفظة والدفع عند الاستلام والاستلام من المخزن. أما طلبات متاجر مجتمع ليفو فتُدفع مقدماً من المحفظة حصراً: لا دفع عند الاستلام ولا استلام من المخزن في هذا المسار.

### 6.4 سلة واحدة لبائع واحد
لا تجمع السلة بين بضاعة ليفونيس وبضاعة تاجر، ولا بين تاجرين، لأن لكل بائع طلبه وتسليمه وعمولته ومسؤوليته المستقلة.

### 6.5 الضمان والإرجاع في طلبات التجار
الضمان والإرجاع في طلبات متاجر المجتمع يقعان على التاجر وفق ما أعلنه في متجره، ما لم يكن المنتج مشمولاً بضمان مصنّع مستقل. ولا يلتزم ليفونيس بضمان بضاعة لم يبعها.

### 6.6 دور المنصة عند الخلاف
تتدخل المنصة عند طلب أحد الطرفين من الدعم ذلك، وفق الفصل السابع. وتدخلها تنظيمي لحماية سلامة المعاملة، ولا يجعلها طرفاً في البيع.

### 6.7 هوية البائع معروضة
اسم البائع معروض على صفحة المنتج وفي السلة وعلى الطلب. وعلى الزبون مراجعته قبل الشراء، ولا تُنسب شروط تاجر إلى تاجر آخر ولا إلى المتجر الرسمي.

## 7. مجتمع ليفو: خصوصية المحادثات وحدود المسؤولية

### 7.1 خصوصية المحادثات
المحادثات بين أعضاء مجتمع ليفو خاصة بأطرافها. المتجر لا يطالعها ولا يقرؤها ولا يراقب محتواها، ولا يوجد باب خلفي لأي إدارة للاطلاع عليها.

### 7.2 عدم مسؤولية المتجر عن قول الأعضاء أو عروضهم
المتجر غير مسؤول عمّا يقوله الأعضاء أو يعرضونه أو يعدون به في محادثاتهم أو في عروضهم. وما يصدر عن عضو يلزمه هو وحده.

### 7.3 التدخل بناءً على طلب
لا يتدخل المتجر في محادثة أو معاملة بين عضوين إلا إذا طلب أحد الطرفين من الدعم ذلك. وعند الطلب يطّلع الدعم على ما يقدّمه الطرفان من مستندات وعلى سجلات المعاملة، بالقدر اللازم للبت في الطلب.

### 7.4 ما يُتفق عليه خارج المنصة
المتجر غير مسؤول عن أي اتفاق أو دفع أو تسليم يتم خارج المنصة. ومن دفع خارج المنصة أو سلّم خارجها فقد تنازل عن حماية النظام وعن سجلاته وعن إمكان تدخل الدعم.

### 7.5 الإبلاغ عن مخالفة
لعضو المجتمع الإبلاغ عن محتوى أو سلوك مخالف عبر الدعم. ويتخذ المتجر ما يراه من إجراء تجاه الحساب المخالف، دون أن يصبح بذلك ضامناً لمعاملات غيره.

### 7.6 حدود ما يمكن للمنصة إثباته
ما تحفظه المنصة هو ما جرى داخلها: الطلب والدفع والحالات والتواريخ. ولا يمكنها إثبات ما جرى خارجها، ولا الحكم في نزاع لا أثر له في سجلاتها.

## 8. مسار ليفو برو للتجار

### 8.1 خطوات المسار
يعرض التاجر منتجه داخل المنصة، ويضيفه الزبون إلى سلته، وينشئ الطلب، ويدفع قيمته مقدماً من محفظته. ثم يجهّز التاجر الطلب ويسلّمه بوسيلته المعلنة.

### 8.2 الدفع المسبق من المحفظة
لا يُنشأ طلب من متجر تاجر ما لم يغطِّ الرصيد المتاح في محفظة الزبون قيمة الطلب كاملة. ويُحجز المبلغ ثم يُسوّى مع إنشاء الطلب في معاملة واحدة، فلا يوجد طلب غير مدفوع على هذا المسار ولا خصم بلا طلب.

### 8.3 لا دفع عند الاستلام ولا استلام من المخزن
لا يتاح الدفع عند الاستلام ولا الاستلام من المخزن في هذا المسار، لأن المتجر لا يحتفظ ببضاعة التاجر ولا يملك من يحصّل عنه عند الباب.

### 8.4 المحادثة والتفاوض داخل المنصة
للزبون والتاجر التحادث والتفاوض على السعر داخل المنصة. وأي سعر متفق عليه لا يصير نافذاً إلا إذا انعكس في عرض التاجر داخل المنصة قبل إنشاء الطلب، لأن الطلب يُسعَّر من سجلات المنصة لا من نص محادثة.

### 8.5 عمولة المنصة
تستوفي المنصة عمولتها من قيمة البيع بالنسبة المعتمدة وقت البيع، وتُثبَّت هذه النسبة على الطلب. وتغيير النسبة لاحقاً لا يغيّر ما استُحق على طلب سابق.

### 8.6 استحقاق التاجر
يُقيَّد نصيب التاجر عند إنشاء الطلب بحالة معلّقة، ولا يصبح قابلاً للسحب إلا بعد تسليم الطلب. وإذا أُلغي الطلب عُكس القيد المعلّق.

### 8.7 التزامات التاجر
يلتزم التاجر بصحة وصف منتجه وسعره وكميته، وبتجهيز الطلب وتسليمه في المدة التي أعلنها، وبالرد على زبونه، وبتنفيذ ضمانه وإرجاعه المعلنين.

### 8.8 توقف التاجر عن الرد
إذا توقف التاجر عن الرد أو عن تنفيذ طلب مدفوع، جاز للزبون أن يطلب من الدعم التدخل. وللمتجر عندئذ إيقاف متجر التاجر، وحجز مستحقاته المعلّقة، وإلغاء الطلب وإعادة المبلغ إلى محفظة الزبون. وتُنفَّذ الإعادة من إدارة المتجر لا من التاجر.

### 8.9 إيقاف متجر التاجر
للمتجر إيقاف متجر التاجر أو تعليقه عند تكرار التأخير أو الشكاوى أو مخالفة السياسات، على أن تبقى الطلبات القائمة قبل الإيقاف محل تسوية.

### 8.10 لا تحويل للمسؤولية
تدخّل المتجر في أي من الحالات أعلاه إجراء تنظيمي لحماية الزبون، ولا يجعل ليفونيس بائعاً ولا ضامناً لبضاعة التاجر.

## 9. العروض والإعلان والتسعير

### 9.1 مدة العرض
لكل عرض بداية ونهاية معلنتان، ولا يُطبَّق قبل بدايته ولا بعد نهايته ولو بقي ظاهراً على شاشة لم تُحدَّث.

### 9.2 حدود العرض
للعرض حدّ لكل مستخدم وحدّ إجمالي. وانتهاء الحدّ ينهي العرض فعلياً ولو لم تنتهِ مدته.

### 9.3 العروض المشروطة بالعضوية
بعض العروض مقصورة على مستوى عضوية معيّن. ولا يستحقها من ليست عضويته فعّالة وقت الطلب.

### 9.4 لا جمع بين سعرين على القطعة الواحدة
لا يُجمع بين سعر عرض مجدول وسعر آخر على القطعة نفسها. ويبقى الكوبون مطبَّقاً على قيمة البضاعة وفق شروطه.

### 9.5 صدق الإعلان
يلتزم المتجر بألا يعلن سعراً لا يبيع به، ولا خصماً محسوباً على سعر لم يكن معمولاً به فعلاً.

### 9.6 إعلانات التجار
إعلان التاجر عن منتجه مسؤوليته وحده، وللمتجر إزالة إعلان مخالف أو مضلل من المنصة.

## 10. حدود المسؤولية

### 10.1 الضرر أثناء النقل
لا يتحمل المتجر الضرر الواقع أثناء النقل، بما فيه الضرر الواقع عند حدود إقليم كردستان أو عند أي نقطة تفتيش يُفتح فيها الطرد ويُعاد تغليفه بمعرفة جهة ليست المتجر ولا شركة التوصيل. وتفصيل ذلك في سياسة الشراء وسياسة التوصيل.

### 10.2 أجرة التوصيل والضريبة
أجرة التوصيل والضريبة المرتبطة بها تحددهما شركات التوصيل لا ليفونيس، والمتجر ينقل ما تفرضه الشركة ولا يتحكم به.

### 10.3 التأخير خارج سيطرة المتجر
لا يتحمل المتجر تبعة التأخير الناشئ عن المجهّز أو الناقل أو إجراءات المنافذ والتفتيش أو القوة القاهرة أو انقطاع الطرق أو تعطل الشبكات.

### 10.4 الاستعمال والصيانة
لا يتحمل المتجر الضرر الناتج عن سوء الاستعمال أو عن التشغيل بخلاف تعليمات المصنّع أو عن تعديل أو إصلاح غير مصرح به أو عن استعمال مواد غير مناسبة.

### 10.5 الضرر غير المباشر
لا يتحمل المتجر الأضرار غير المباشرة ولا فوات الكسب ولا تعطل عمل ناتج عن عطل منتج، ويبقى التزامه في حدود الإصلاح أو الاستبدال أو الرد وفق سياسة الضمان وسياسة الإرجاع.

### 10.6 سقف المسؤولية
لا تتجاوز مسؤولية المتجر عن أي طلب قيمة ذلك الطلب المدفوعة فعلاً، ما لم يقرر القانون الواجب التطبيق خلاف ذلك.

### 10.7 مسؤولية التاجر
مسؤولية التاجر عن بضاعته وعن وعوده قائمة تجاه زبونه، ولا تنتقل إلى ليفونيس بسبب استضافة المنصة للمعاملة.

## 11. أحكام ختامية

### 11.1 التعديل
للمتجر تعديل هذه السياسة بإصدار نسخة جديدة برقم وتاريخ نفاذ، ولا يسري التعديل بأثر رجعي على طلب سابق.

### 11.2 استقلال البنود
بطلان بند لا يمس باقي البنود.

### 11.3 حل النزاعات
يُقدَّم النزاع إلى الدعم مع رقم الطلب والمستندات، وتُبذل المحاولة الودية خلال {{DISPUTE_RESPONSE_DAYS}} يوماً.

### 11.4 القانون والاختصاص
تخضع هذه الوثيقة لقوانين {{GOVERNING_LAW_JURISDICTION}}، والاختصاص لمحاكم {{COMPETENT_COURT}}.

### 11.5 جهة الاتصال
جهة الاتصال المعتمدة {{LEVONIS_SUPPORT_CONTACT}}، وأوقات العمل {{LEVONIS_SUPPORT_HOURS}}.`,

    en: `## 1. Preamble and Scope

### 1.1 Purpose of this document
This document sets out what the Store undertakes towards the customer, the limits of that undertaking, the Store's rights to refuse or limit an order, and the difference between selling from the official LEVONIS store and selling through the stores of the Levo community.

### 1.2 The parties
The Store: {{LEVONIS_LEGAL_NAME}}, registered under number {{LEVONIS_REGISTRATION_NO}}. The Merchant: any independent seller holding a store inside the Levo community. The Customer: the purchasing account holder.

### 1.3 Definitions
- The Seller: the party on whom the selling obligations fall for a given order — LEVONIS on official-store orders, and the Merchant on community-store orders.
- The Description: the product's text and stated characteristics as displayed on its page.
- Illustrative imagery: any photograph, video or three-dimensional model displaying the product.
- Confirmation: the Store's acceptance of the order and the start of its preparation.
- The Platform: the LEVONIS system with all of its services, including the Levo community space.

### 1.4 Authoritative text
The Arabic text is authoritative; the English and Kurdish versions are faithful translations of it under the same numbering.

### 1.5 Relationship to the other documents
This document is read with the Purchase Policy, the Payment and Wallet Policy, the Pricing, Price Changes and Order Cancellation Policy, the Delivery Policy, the Warranty Policy and the Returns Policy.

## 2. What the Store Undertakes

### 2.1 To sell what is actually displayed
The Store undertakes to sell the item described on its page to the stated specification, and not to substitute a lesser item without informing the customer and obtaining their agreement.

### 2.2 Declared pricing computed by the server
The Store undertakes that the price displayed at checkout is the price actually computed on the order, with all of its components, with no hidden fee and no undeclared increase.

### 2.3 Itemising the price
The Store undertakes to state the merchandise value, the delivery fee, the transport commission, the warranty fee, the cash-on-delivery tax and the discounts, each separately, before the order and on the invoice.

### 2.4 Preparing a confirmed order
The Store undertakes to prepare a confirmed order and hand it to the delivery company within the period usual for its shipping type, subject to the indicative durations set out in the Purchase Policy.

### 2.5 Keeping the order state current
The Store undertakes to keep the order's state current along its path, and that the state displayed in the customer's account is the order's true state.

### 2.6 Preserving the order snapshot
The Store undertakes to preserve a fixed snapshot of the order's price, benefits, address and payment method, and not to alter it after the order has been created. Later changes to settings do not recompute an earlier order.

### 2.7 Issuing the invoice
The Store undertakes to issue an invoice for every order and to make it available to the customer in their account.

### 2.8 Warranty under its own document
The Store undertakes to warrant items under the Warranty Policy: base cover of twelve months from actual delivery, extendable to twenty-four months where the extension is bought before the order is placed and not afterwards. The warranty covers factory-faulty parts and is performed by repairing or replacing the faulty part, not by swapping the whole device.

### 2.9 Protecting customer data
The Store undertakes to protect the customer's data and not to disclose it beyond what is necessary to execute the order, under the Privacy Policy.

### 2.10 The limits of the Store's undertaking
The Store is not bound by anything not displayed on the product page or at checkout, nor by anything promised orally or outside the platform, nor by any performance the product description does not state.

## 3. Description, Imagery and Specifications

### 3.1 Imagery is illustrative
The photographs, videos and models displayed are illustrative and serve to identify the product. Colours may differ according to display and lighting, and an image may show an accessory, a background or an accompanying item that is not part of the sale.

### 3.2 The sale is what the text states
What determines the contents of the box is the written text of the product description, not what appears in the image. Anything not stated in the text is not part of the sale.

### 3.3 Specifications taken from the manufacturer
Technical specifications are taken from the manufacturer or the distributor. The manufacturer may change a specification, a revision, an accessory or the packaging without prior notice, and that is not a breach by the Store so long as the item delivered is the model ordered with its stated function.

### 3.4 A specification that changes after the order
Where a material specification changes after the order and before delivery, the customer is informed and may choose between accepting and cancelling with a return of what they paid. A non-material change does not give rise to a right of cancellation.

### 3.5 Dimensions and weights
Dimensions and weights are approximate within the usual manufacturing tolerance, unless the description states otherwise.

### 3.6 Performance and compatibility
The Store does not warrant the product's compatibility with devices, software or materials the description does not name, nor any particular production outcome that depends on the user's settings, skill or operating environment.

### 3.7 Typographical errors
A manifest typographical error in a description, a price or a figure creates no obligation on the Store and is corrected under the Pricing, Price Changes and Order Cancellation Policy.

### 3.8 The authoritative language of a description
Where the Arabic and English versions of a product description differ, the Arabic text prevails, and in case of doubt reference is made to the manufacturer's official specification.

## 4. Availability and Stock

### 4.1 Availability at the moment of confirmation
Display of a product on the site does not mean it is available. Stock is subject to availability at the moment the order is confirmed, and is re-verified when the order is created rather than when it was added to the cart.

### 4.2 Stock exhausted between order and confirmation
Where the quantity is exhausted after the order is created and before it is confirmed, the customer is notified and may choose between waiting, an alternative, or cancellation with a full return of what was paid.

### 4.3 Availability on a pre-order
On a pre-order, availability rests with the supplier and not with the Store, and the supplier may decline or be delayed. The provisions of the Purchase Policy on pre-orders then apply.

### 4.4 Reservation
No stock is reserved for a customer before their order is created, and neither the cart nor a wish list constitutes a reservation.

### 4.5 Simultaneous orders
Where more than one order competes for the last unit, priority goes to the first order completed in the system, regardless of when the item was added to a cart.

### 4.6 Withdrawn products
The Store may withdraw a product from display at any time. Withdrawal does not affect a confirmed order standing before it.

## 5. The Store's Right to Refuse or Limit an Order

### 5.1 The right to refuse
The Store may refuse any order before confirming it, limit its quantity, or restrict it to a particular payment method, stating the reason to the customer.

### 5.2 Buying for resale
The Store may refuse an order or limit its quantity where there are indications of buying for resale, including repeated orders of the same item in large quantities, multiple orders to one address under different names, or an unusual concentration of quantity on a limited offer.

### 5.3 An unreachable customer
The Store may cancel the order where the customer cannot be reached on the registered number or their address cannot be verified within {{ORDER_CONFIRMATION_WINDOW_HOURS}} hours, or where they do not answer the delivery company after {{FAILED_DELIVERY_ATTEMPTS}} attempts.

### 5.4 A history of refused deliveries
The Store may restrict an account's purchasing to prepayment, or refuse its orders, where the account has a history of refusing delivery or of failed delivery, because each such event costs the Store an outbound and return charge against no sale.

### 5.5 Abuse of offers, points and referrals
The Store may refuse the order and forfeit the benefit where a coupon, an offer, points or referrals are abused, or where multiple accounts are used for one purpose.

### 5.6 Doubt as to the means of payment
The Store may refuse or suspend an order where there is doubt as to the source of the balance, as to a deposit receipt, or where a payment dispute is open, until the review is complete.

### 5.7 Abusive conduct
The Store may decline to deal with an account from which abusive conduct towards staff, delivery couriers or community members has issued.

### 5.8 Unlawful use
The Store may refuse an order intended for a use contrary to law or contrary to the product's stated use.

### 5.9 The effect of refusal on amounts
Where a paid order is refused, what was paid is returned in full under the Payment and Wallet Policy, unless the refusal follows dispatch of the parcel, in which case the provisions on refusal at the door apply.

### 5.10 The right to object
The customer may object to a refusal or a restriction through support within {{DISPUTE_RESPONSE_DAYS}} days, and the objection is examined on the basis of what is recorded in the system.

## 6. The Official LEVONIS Store and the Levo Community

### 6.1 The official LEVONIS store
In the official store LEVONIS is the seller: the goods are its own, its warehouse is their source, and it is responsible for the price, the preparation, the delivery, the warranty and returns under its own documents.

### 6.2 The Levo community
In the Levo community the Merchant is the seller, and the platform supplies the listing, the cart, the order, the payment, the chat and the movement of money. LEVONIS does not become the seller of goods merely because they were displayed inside its platform.

### 6.3 Payment and delivery on each path
The official store offers payment from the wallet, cash on delivery and warehouse pickup. Orders from Levo community stores are prepaid from the wallet exclusively: there is no cash on delivery and no warehouse pickup on that path.

### 6.4 One cart, one seller
A cart does not combine LEVONIS goods with a merchant's goods, nor two merchants, because each seller has their own order, delivery, commission and independent responsibility.

### 6.5 Warranty and returns on merchant orders
Warranty and returns on community-store orders fall on the Merchant as declared in their store, unless the product is covered by an independent manufacturer's warranty. LEVONIS does not undertake to warrant goods it did not sell.

### 6.6 The platform's role in a dispute
The platform intervenes where a party asks support to, under chapter 7. Its intervention is regulatory, to protect the integrity of the transaction, and does not make it a party to the sale.

### 6.7 The seller's identity is displayed
The seller's name is displayed on the product page, in the cart and on the order. The customer must check it before buying, and one merchant's terms are not attributed to another merchant or to the official store.

## 7. The Levo Community: Privacy of Conversations and Limits of Responsibility

### 7.1 Privacy of conversations
Conversations between members of the Levo community are private to their parties. The Store does not review or read them and does not monitor their content, and there is no administrative back door for viewing them.

### 7.2 No responsibility for what members say or offer
The Store is not responsible for what members say, offer or promise in their conversations or in their listings. What a member states binds that member alone.

### 7.3 Intervention on request
The Store does not intervene in a conversation or a transaction between two members unless one of the parties asks support to. Where asked, support examines the documents the parties provide and the transaction records, to the extent necessary to decide the request.

### 7.4 Arrangements made outside the platform
The Store is not responsible for any agreement, payment or delivery made outside the platform. A person who paid or delivered outside it has given up the protection of the system, its records, and the possibility of support's intervention.

### 7.5 Reporting a breach
A community member may report offending content or conduct through support. The Store takes such action as it sees fit against the offending account, without thereby becoming a guarantor of other people's transactions.

### 7.6 The limits of what the platform can establish
What the platform stores is what happened inside it: the order, the payment, the states and the dates. It cannot establish what happened outside it, nor decide a dispute of which its records hold no trace.

## 8. The LEVO PRO Merchant Path

### 8.1 The steps of the path
The merchant lists their product inside the platform, the customer adds it to their cart, places the order, and pays its value in advance from their wallet. The merchant then prepares the order and delivers it by their declared means.

### 8.2 Prepayment from the wallet
No order from a merchant's store is created unless the available balance in the customer's wallet covers the full value of the order. The amount is reserved and then settled together with the creation of the order in one transaction, so there is no unpaid order on this path and no debit without an order.

### 8.3 No cash on delivery and no warehouse pickup
Cash on delivery and warehouse pickup are not available on this path, because the Store neither holds the merchant's goods nor has anyone to collect at the door on their behalf.

### 8.4 Chat and negotiation inside the platform
The customer and the merchant may chat and negotiate the price inside the platform. An agreed price takes effect only where it is reflected in the merchant's listing inside the platform before the order is created, because the order is priced from the platform's records and not from the text of a conversation.

### 8.5 The platform's commission
The platform takes its commission on the sale value at the rate in force at the time of the sale, and that rate is fixed onto the order. A later change of rate does not change what was due on an earlier order.

### 8.6 The merchant's entitlement
The merchant's share is recorded as pending when the order is created and becomes withdrawable only after the order has been delivered. Where the order is cancelled, the pending entry is reversed.

### 8.7 The merchant's obligations
The merchant undertakes that their product's description, price and quantity are accurate, to prepare and deliver the order within the period they declared, to answer their customer, and to honour the warranty and returns they declared.

### 8.8 A merchant who stops answering
Where the merchant stops answering or stops performing a paid order, the customer may ask support to intervene. The Store may then suspend the merchant's store, withhold their pending entitlements, cancel the order and return the amount to the customer's wallet. The return is performed by the Store's administration and not by the merchant.

### 8.9 Suspending a merchant's store
The Store may suspend or restrict a merchant's store on repeated delay, complaints or breach of the policies, while orders standing before the suspension remain subject to settlement.

### 8.10 No transfer of responsibility
The Store's intervention in any of the cases above is a regulatory measure to protect the customer, and does not make LEVONIS the seller or the guarantor of the merchant's goods.

## 9. Offers, Advertising and Pricing

### 9.1 The offer window
Every offer has a declared start and end, and is not applied before its start or after its end even if it remains visible on a screen that has not been refreshed.

### 9.2 Offer limits
An offer carries a per-customer limit and a global limit. Exhaustion of the limit ends the offer in fact even if its period has not expired.

### 9.3 Membership-conditional offers
Some offers are confined to a particular membership level. A person whose membership is not active at the time of the order is not entitled to them.

### 9.4 No two prices on one item
A scheduled offer price is not combined with another price on the same item. A coupon continues to apply to the merchandise value under its own terms.

### 9.5 Truthful advertising
The Store undertakes not to advertise a price at which it does not sell, nor a discount computed against a price that was not actually in force.

### 9.6 Merchants' advertising
A merchant's advertising of their product is their own responsibility, and the Store may remove an offending or misleading listing from the platform.

## 10. Limits of Responsibility

### 10.1 Damage in transit
The Store is not liable for damage occurring during transport, including damage occurring at the Kurdistan Region border or at any checkpoint where the parcel is opened and repacked by a party that is neither the Store nor the delivery company. The detail is in the Purchase Policy and the Delivery Policy.

### 10.2 The delivery fee and its tax
The delivery fee and the tax attached to it are set by the delivery companies and not by LEVONIS; the Store passes on what the company charges and does not control it.

### 10.3 Delay outside the Store's control
The Store does not bear the consequence of delay arising from the supplier, the carrier, border and inspection procedures, force majeure, road closures or network outages.

### 10.4 Use and maintenance
The Store is not liable for damage resulting from misuse, from operation contrary to the manufacturer's instructions, from unauthorised modification or repair, or from the use of unsuitable materials.

### 10.5 Indirect damage
The Store is not liable for indirect damage, loss of profit or business interruption resulting from a product fault; its obligation remains repair, replacement or refund under the Warranty Policy and the Returns Policy.

### 10.6 Cap on liability
The Store's liability on any order does not exceed the value actually paid on that order, unless the governing law provides otherwise.

### 10.7 The merchant's liability
The merchant's liability for their goods and their promises stands towards their customer and does not pass to LEVONIS because the platform hosted the transaction.

## 11. Final Provisions

### 11.1 Amendment
The Store may amend this policy by issuing a new version with a number and an effective date; an amendment has no retroactive effect on an earlier order.

### 11.2 Severability
The invalidity of one article does not affect the remaining articles.

### 11.3 Dispute resolution
A dispute is submitted to support with the order number and the documents, and an amicable resolution is attempted within {{DISPUTE_RESPONSE_DAYS}} days.

### 11.4 Law and jurisdiction
This document is governed by the laws of {{GOVERNING_LAW_JURISDICTION}}, and the courts of {{COMPETENT_COURT}} have jurisdiction.

### 11.5 Contact
The approved contact point is {{LEVONIS_SUPPORT_CONTACT}}, and the working hours are {{LEVONIS_SUPPORT_HOURS}}.`,

    ckb: `## 1. پێشەکی و بواری کار

### 1.1 مەبەستی ئەم بەڵگەنامەیە
ئەم بەڵگەنامەیە دیاری دەکات فرۆشگا چی لە بەرامبەر کڕیاردا لە ئەستۆ دەگرێت، سنووری ئەم پابەندییە، مافی فرۆشگا لە ڕەتکردنەوە یان سنووردارکردنی داواکاری، و جیاوازی نێوان فرۆشتن لە فرۆشگا فەرمییەکەی لیڤۆنیس و فرۆشتن لە ڕێگەی فرۆشگاکانی کۆمەڵگای لیڤۆوە.

### 1.2 لایەنەکان
فرۆشگا: {{LEVONIS_LEGAL_NAME}}، تۆمارکراو بە ژمارە {{LEVONIS_REGISTRATION_NO}}. بازرگان: هەر فرۆشیارێکی سەربەخۆ کە فرۆشگایەکی هەیە لە ناو کۆمەڵگای لیڤۆ. کڕیار: خاوەنی هەژماری کڕیار.

### 1.3 پێناسەکان
- فرۆشیار: ئەو لایەنەی پابەندی فرۆشتن لە داواکارییەکی دیاریکراودا لەسەری دەکەوێت، لیڤۆنیسە لە داواکارییەکانی فرۆشگا فەرمییەکە و بازرگانە لە داواکارییەکانی فرۆشگاکانی کۆمەڵگا.
- وەسف: دەقی بەرهەم و تایبەتمەندییەکانی وەک لەسەر پەڕەکەی پیشان دەدرێن.
- وێنەی ڕوونکەرەوە: هەر وێنە یان ڤیدیۆ یان مۆدێلی سێ ڕەهەندی کە بەرهەمەکە پیشان دەدات.
- پشتڕاستکردنەوە: وەرگرتنی داواکارییەکە لەلایەن فرۆشگاوە و دەستپێکردنی ئامادەکاری.
- پلاتفۆرم: سیستەمی لیڤۆنیس بە هەموو خزمەتگوزارییەکانییەوە، بە بۆشایی کۆمەڵگای لیڤۆشەوە.

### 1.4 دەقی پەسەندکراو
دەقی عەرەبی پەسەندکراوە، و وەشانی ئینگلیزی و کوردی وەرگێڕانی دڵسۆزی ئەون بە هەمان ژمارەگوزاری.

### 1.5 پەیوەندی بە بەڵگەنامەکانی دیکەوە
لەگەڵ سیاسەتی کڕین، سیاسەتی پارەدان و جزدان، سیاسەتی نرخ و گۆڕانی نرخ و هەڵوەشاندنەوەی داواکاری، سیاسەتی گەیاندن، سیاسەتی گەرەنتی و سیاسەتی گەڕاندنەوە دەخوێنرێتەوە.

## 2. ئەوەی فرۆشگا لە ئەستۆ دەگرێت

### 2.1 فرۆشتنی ئەوەی بە ڕاستی پیشان دراوە
فرۆشگا پابەندە بە فرۆشتنی ئەو کاڵایەی لەسەر پەڕەکەیدا وەسف کراوە بە تایبەتمەندی ڕاگەیەنراو، و بەوەی بە کاڵایەکی خواروو نەگۆڕدرێت بەبێ ئاگادارکردنەوەی کڕیار و وەرگرتنی ڕەزامەندی.

### 2.2 نرخی ڕاگەیەنراو کە لەسەر ڕاژەکار حساب دەکرێت
فرۆشگا پابەندە بەوەی ئەو نرخەی لە شاشەی پارەداندا پیشان دەدرێت هەمان ئەو نرخە بێت کە بە ڕاستی لەسەر داواکارییەکە حساب کراوە، بە هەموو بڕگەکانییەوە، بەبێ کرێی شاراوە و بەبێ زیادەی ڕانەگەیەنراو.

### 2.3 ڕوونکردنەوەی پێکهاتەکانی نرخ
فرۆشگا پابەندە بە ڕوونکردنەوەی بەهای کاڵا و کرێی گەیاندن و کۆمیسیۆنی گواستنەوە و کرێی گەرەنتی و باجی پارەدان لە کاتی وەرگرتن و داشکاندنەکان، هەر بڕگەیەک بە جیا، پێش داواکاری و لەسەر پسووڵەکە.

### 2.4 ئامادەکردنی داواکاری پشتڕاستکراو
فرۆشگا پابەندە بە ئامادەکردنی داواکاری پشتڕاستکراو و ڕادەستکردنی بە کۆمپانیای گەیاندن لە ماوەی ئاسایی جۆری گەیاندنەکەیدا، لەگەڵ ڕەچاوکردنی ئەو ماوە خەمڵێنراوانەی لە سیاسەتی کڕیندا هاتوون.

### 2.5 نوێکردنەوەی دۆخی داواکاری
فرۆشگا پابەندە بە نوێکردنەوەی دۆخی داواکارییەکە لەسەر ڕێڕەوەکەی، و بەوەی ئەو دۆخەی لە هەژماری کڕیاردا پیشان دەدرێت دۆخی ڕاستەقینەی داواکارییەکە بێت.

### 2.6 پاراستنی وێنەی داواکاری
فرۆشگا پابەندە بە پاراستنی وێنەیەکی جێگیر لە نرخ و سوود و ناونیشان و شێوازی پارەدانی داواکارییەکە، و بەوەی دوای دروستبوونی داواکارییەکە نەیگۆڕێت. گۆڕانی ڕێکخستنەکان لە دواتردا داواکارییەکی پێشووتر دووبارە حساب ناکاتەوە.

### 2.7 دەرکردنی پسووڵە
فرۆشگا پابەندە بە دەرکردنی پسووڵە بۆ هەر داواکارییەک و بەردەستکردنی بۆ کڕیار لە هەژمارەکەیدا.

### 2.8 گەرەنتی بەپێی بەڵگەنامەی خۆی
فرۆشگا پابەندە بە گەرەنتی کاڵاکان بەپێی سیاسەتی گەرەنتی: پۆشینی بنەڕەتی دوازدە مانگە لە گەیاندنی ڕاستەقینەوە، و دەکرێت بۆ بیست و چوار مانگ درێژ بکرێتەوە بەمەرجێک درێژکردنەوەکە پێش دروستبوونی داواکاری بکڕدرێت نەک دواتر. گەرەنتی پارچە عەیبدارە کارگەییەکان دەگرێتەوە، و بە چاککردنەوە یان گۆڕینەوەی پارچە عەیبدارەکە جێبەجێ دەکرێت، نەک بە گۆڕینەوەی هەموو ئامێرەکە.

### 2.9 پاراستنی زانیاری کڕیار
فرۆشگا پابەندە بە پاراستنی زانیاری کڕیار و ئاشکرانەکردنی زیاتر لەوەی بۆ جێبەجێکردنی داواکارییەکە پێویستە، بەپێی سیاسەتی تایبەتمەندێتی.

### 2.10 سنووری پابەندی فرۆشگا
فرۆشگا پابەند نییە بەوەی لەسەر پەڕەی بەرهەم یان لە شاشەی پارەداندا پیشان نەدراوە، و نە بەوەی بە زارەکی یان لە دەرەوەی پلاتفۆرم بەڵێنی پێدراوە، و نە بە کارایەکی کە وەسفی بەرهەمەکە باسی ناکات.

## 3. وەسف و وێنە و تایبەتمەندییەکان

### 3.1 وێنەکان ڕوونکەرەوەن
ئەو وێنە و ڤیدیۆ و مۆدێلانەی پیشان دەدرێن ڕوونکەرەوەن بۆ ناساندنی بەرهەمەکە. لەوانەیە ڕەنگەکان بەپێی شاشە و ڕووناکی جیاواز بن، و لەوانەیە وێنەکە پێداویستی یان پاشبنەما یان کاڵایەکی هاوڕێ پیشان بدات کە بەشێک نییە لە فرۆشتنەکە.

### 3.2 فرۆشتنەکە ئەوەیە دەقەکە دەیڵێت
ئەوەی ناوەڕۆکی سندووقەکە دیاری دەکات دەقی نووسراوی وەسفی بەرهەمەکەیە، نەک ئەوەی لە وێنەکەدا دەردەکەوێت. هەرچی لە دەقەکەدا نەهاتبێت بەشێک نییە لە فرۆشتنەکە.

### 3.3 تایبەتمەندییە وەرگیراوەکان لە بەرهەمهێنەرەوە
تایبەتمەندییە تەکنیکییەکان لە بەرهەمهێنەر یان دابەشکەرەوە وەرگیراون. لەوانەیە بەرهەمهێنەر تایبەتمەندی یان وەشان یان پێداویستی یان پاکەتکردن بگۆڕێت بەبێ ئاگادارکردنەوەی پێشوەخت، و ئەمە پێشێلکاری فرۆشگا نییە مادام ئەو کاڵایەی گەیەنراوە هەمان ئەو مۆدێلە بێت بە کارایە ڕاگەیەنراوەکەیەوە.

### 3.4 گۆڕانی تایبەتمەندی دوای داواکاری
ئەگەر تایبەتمەندییەکی بنەڕەتی دوای داواکاری و پێش گەیاندن گۆڕا، کڕیار ئاگادار دەکرێتەوە و دەتوانێت لە نێوان وەرگرتن و هەڵوەشاندنەوە لەگەڵ گەڕاندنەوەی ئەوەی داویەتی هەڵبژێرێت. گۆڕانی نابنەڕەتی مافی هەڵوەشاندنەوە نادات.

### 3.5 پێوانە و کێش
پێوانە و کێشەکان نزیکەیین لە ناو سنووری ئاسایی بەرهەمهێناندا، مەگەر وەسفەکە پێچەوانەی بڵێت.

### 3.6 کارایی و گونجان
فرۆشگا گونجانی بەرهەمەکە لەگەڵ ئامێر یان نەرمەکاڵا یان ماددەیەک کە وەسفەکە ناوی نەهێناوە دەستەبەر ناکات، و نە ئەنجامێکی بەرهەمهێنانی دیاریکراو کە بە ڕێکخستن و شارەزایی بەکارهێنەر و ژینگەی کارکردنەوە بەندە.

### 3.7 هەڵەی چاپی
هەڵەی چاپی ئاشکرا لە وەسف یان نرخ یان ژمارەیەکدا هیچ پابەندییەک لەسەر فرۆشگا دروست ناکات، و بەپێی سیاسەتی نرخ و گۆڕانی نرخ و هەڵوەشاندنەوەی داواکاری ڕاست دەکرێتەوە.

### 3.8 زمانی پەسەندکراو لە وەسفدا
لە کاتی جیاوازی نێوان وەشانی عەرەبی و ئینگلیزی وەسفی بەرهەمێکدا، دەقی عەرەبی پێش دەخرێت، و لە کاتی گومانیشدا دەگەڕێینەوە بۆ تایبەتمەندی فەرمی بەرهەمهێنەر.

## 4. بەردەستبوون و کۆگا

### 4.1 بەردەستبوون لە ساتی پشتڕاستکردنەوەدا
پیشاندانی بەرهەم لەسەر ماڵپەڕ مانای بەردەستبوونی نییە. کۆگا بەندە بە بەردەستبوون لە ساتی پشتڕاستکردنەوەی داواکاریدا، و لە کاتی دروستبوونی داواکاریدا دووبارە پشکنین دەکرێتەوە نەک لە کاتی زیادکردنی بۆ سەبەتە.

### 4.2 تەواوبوونی بڕ لە نێوان داواکاری و پشتڕاستکردنەوەدا
ئەگەر بڕەکە دوای دروستبوونی داواکاری و پێش پشتڕاستکردنەوەی تەواو بوو، کڕیار ئاگادار دەکرێتەوە و دەتوانێت لە نێوان چاوەڕوانی، جێگرەوە، یان هەڵوەشاندنەوە بە گەڕاندنەوەی تەواوی ئەوەی دراوە هەڵبژێرێت.

### 4.3 بەردەستبوون لە داواکاری پێشوەختدا
لە داواکاری پێشوەختدا بەردەستبوون لای دابینکەرە نەک لای فرۆشگا، و لەوانەیە دابینکەر داوای لێبوردن بکات یان دوابکەوێت. لەم حاڵەتەدا ئەوەی لە سیاسەتی کڕیندا سەبارەت بە داواکاری پێشوەخت هاتووە جێبەجێ دەبێت.

### 4.4 حیجزکردن
هیچ کۆگایەک بۆ کڕیارێک حیجز ناکرێت پێش دروستبوونی داواکارییەکەی، و نە سەبەتە و نە لیستی ئارەزوو حیجز نین.

### 4.5 داواکارییە هاوکاتەکان
کاتێک زیاتر لە داواکارییەک لەسەر دوایین دانە کێبڕکێ دەکەن، پێشینە بۆ ئەو داواکارییەیە کە یەکەم جار لە سیستەمدا تەواو بووە، بێ گوێدانە کاتی زیادکردنی بۆ سەبەتە.

### 4.6 بەرهەمە لابراوەکان
فرۆشگا دەتوانێت لە هەر کاتێکدا بەرهەمێک لە پیشاندان لابەرێت. لابردن کاریگەری لەسەر داواکارییەکی پشتڕاستکراوی پێشتر نییە.

## 5. مافی فرۆشگا لە ڕەتکردنەوە یان سنووردارکردنی داواکاری

### 5.1 مافی ڕەتکردنەوە
فرۆشگا دەتوانێت هەر داواکارییەک پێش پشتڕاستکردنەوەی ڕەت بکاتەوە، یان بڕەکەی سنووردار بکات، یان بە شێوازێکی دیاریکراوی پارەدان سنووری بکات، لەگەڵ ڕوونکردنەوەی هۆکارەکە بۆ کڕیار.

### 5.2 کڕین بە مەبەستی فرۆشتنەوە
فرۆشگا دەتوانێت داواکارییەکە ڕەت بکاتەوە یان بڕەکەی سنووردار بکات کاتێک نیشانە هەبێت بۆ کڕین بە مەبەستی فرۆشتنەوە، وەک دووبارەبوونەوەی داواکاری هەمان کاڵا بە بڕی زۆر، یان چەند داواکارییەک بۆ یەک ناونیشان بە ناوی جیاواز، یان ئاراستەکردنی ئۆفەرێکی سنووردار بە بڕێکی نائاسایی.

### 5.3 نەگەیشتن بە کڕیار
فرۆشگا دەتوانێت داواکارییەکە هەڵبوەشێنێتەوە ئەگەر نەکرا لە ماوەی {{ORDER_CONFIRMATION_WINDOW_HOURS}} کاتژمێردا بە ژمارە تۆمارکراوەکە بگات بە کڕیار یان ناونیشانەکەی پشکنین بکات، یان ئەگەر دوای {{FAILED_DELIVERY_ATTEMPTS}} هەوڵ وەڵامی کۆمپانیای گەیاندنی نەدایەوە.

### 5.4 تۆماری ڕەتکردنەوەی وەرگرتن
فرۆشگا دەتوانێت کڕینی هەژمارەکە بە پارەدانی پێشەکی سنووردار بکات، یان داواکارییەکانی ڕەت بکاتەوە، ئەگەر تۆمارێکی ڕەتکردنەوەی وەرگرتن یان شکستی گەیاندنی هەبێت، چونکە هەر ڕووداوێکیان کرێی چوون و هاتنەوە دەخاتە سەر فرۆشگا بەبێ هیچ فرۆشتنێک.

### 5.5 خراپبەکارهێنانی ئۆفەر و خاڵ و ناردن
فرۆشگا دەتوانێت داواکارییەکە ڕەت بکاتەوە و سوودەکە بڕوخێنێت لە کاتی خراپبەکارهێنانی کوپۆن یان ئۆفەر یان خاڵ یان ناردن، یان لە کاتی بەکارهێنانی چەند هەژمارێک بۆ یەک مەبەست.

### 5.6 گومان لە شێوازی پارەدان
فرۆشگا دەتوانێت داواکارییەکە ڕەت بکاتەوە یان ڕایبگرێت کاتێک گومان هەبێت لە سەرچاوەی باڵانس یان لە وەسڵی داخڵکردن یان کاتێک ناکۆکییەکی پارەدان کراوەیە، هەتا پێداچوونەوەکە تەواو دەبێت.

### 5.7 ڕەفتاری ناشیرین
فرۆشگا دەتوانێت مامەڵە لەگەڵ هەژمارێکدا ڕەت بکاتەوە کە ڕەفتاری ناشیرینی لێوە دەرچووە بەرامبەر کارمەندان یان گەیەنەران یان ئەندامانی کۆمەڵگا.

### 5.8 بەکارهێنانی نایاسایی
فرۆشگا دەتوانێت داواکارییەک ڕەت بکاتەوە کە بۆ بەکارهێنانێکی پێچەوانەی یاسا یان پێچەوانەی بەکارهێنانی ڕاگەیەنراوی بەرهەمەکە مەبەستی پێیە.

### 5.9 کاریگەری ڕەتکردنەوە لەسەر بڕەکان
ئەگەر داواکارییەکی دراو ڕەت کرایەوە، ئەوەی دراوە بە تەواوی دەگەڕێتەوە بەپێی سیاسەتی پارەدان و جزدان، مەگەر ڕەتکردنەوەکە دوای ناردنی پاکەتەکە بێت، ئەوسا حوکمەکانی ڕەتکردنەوە لە بەردەرگا جێبەجێ دەبن.

### 5.10 مافی ناڕەزایی
کڕیار دەتوانێت لە ماوەی {{DISPUTE_RESPONSE_DAYS}} ڕۆژدا لە ڕێگەی پشتیوانییەوە ناڕەزایی لە ڕەتکردنەوە یان سنووردارکردن دەرببڕێت، و ناڕەزاییەکەی لەسەر بنەمای ئەوەی لە سیستەمدا تۆمار کراوە لێکۆڵینەوەی لەگەڵ دەکرێت.

## 6. فرۆشگا فەرمییەکەی لیڤۆنیس و کۆمەڵگای لیڤۆ

### 6.1 فرۆشگا فەرمییەکەی لیڤۆنیس
لە فرۆشگا فەرمییەکەدا لیڤۆنیس فرۆشیارە: کاڵاکە هی خۆیەتی، کۆگاکەی سەرچاوەیەتی، و بەرپرسیارە لە نرخ و ئامادەکاری و گەیاندن و گەرەنتی و گەڕاندنەوە بەپێی بەڵگەنامەکانی خۆی.

### 6.2 کۆمەڵگای لیڤۆ
لە کۆمەڵگای لیڤۆدا بازرگان فرۆشیارە، و پلاتفۆرم پیشاندان و سەبەتە و داواکاری و پارەدان و گفتوگۆ و گواستنەوەی پارە دابین دەکات. لیڤۆنیس تەنها لەبەر ئەوەی کاڵاکە لە ناو پلاتفۆرمەکەیدا پیشان دراوە نابێتە فرۆشیاری.

### 6.3 شێوازی پارەدان و گەیاندن لە هەر ڕێڕەوێکدا
فرۆشگا فەرمییەکە پارەدان لە جزدان، پارەدان لە کاتی وەرگرتن، و وەرگرتن لە کۆگا پێشکەش دەکات. بەڵام داواکارییەکانی فرۆشگاکانی کۆمەڵگای لیڤۆ تەنها پێشەکی لە جزدانەوە دەدرێن: لەم ڕێڕەوەدا نە پارەدان لە کاتی وەرگرتن هەیە و نە وەرگرتن لە کۆگا.

### 6.4 یەک سەبەتە بۆ یەک فرۆشیار
سەبەتە کاڵای لیڤۆنیس و کاڵای بازرگان کۆناکاتەوە، نە دوو بازرگانیش، چونکە هەر فرۆشیارێک داواکاری و گەیاندن و کۆمیسیۆن و بەرپرسیاریەتی سەربەخۆی خۆی هەیە.

### 6.5 گەرەنتی و گەڕاندنەوە لە داواکارییەکانی بازرگاناندا
گەرەنتی و گەڕاندنەوە لە داواکارییەکانی فرۆشگاکانی کۆمەڵگادا لەسەر بازرگانن بەپێی ئەوەی لە فرۆشگاکەیدا ڕایگەیاندووە، مەگەر بەرهەمەکە بە گەرەنتی بەرهەمهێنەرێکی سەربەخۆ داپۆشرابێت. لیڤۆنیس پابەند نییە بە گەرەنتیکردنی کاڵایەک کە خۆی نەیفرۆشتووە.

### 6.6 ڕۆڵی پلاتفۆرم لە کاتی ناکۆکیدا
پلاتفۆرم دەستێوەردان دەکات کاتێک یەکێک لە لایەنەکان داوا لە پشتیوانی بکات، بەپێی بەشی حەوتەم. دەستێوەردانەکەی ڕێکخستنەییە بۆ پاراستنی ساغی مامەڵەکە، و نایکاتە لایەنێک لە فرۆشتنەکەدا.

### 6.7 ناسنامەی فرۆشیار پیشان دەدرێت
ناوی فرۆشیار لەسەر پەڕەی بەرهەم و لە سەبەتە و لەسەر داواکارییەکە پیشان دەدرێت. پێویستە کڕیار پێش کڕین پێداچوونەوەی بۆ بکات، و مەرجەکانی بازرگانێک بۆ بازرگانێکی دیکە یان بۆ فرۆشگا فەرمییەکە نادرێتەوە پاڵ.

## 7. کۆمەڵگای لیڤۆ: تایبەتمەندێتی گفتوگۆکان و سنووری بەرپرسیاریەتی

### 7.1 تایبەتمەندێتی گفتوگۆکان
گفتوگۆکانی نێوان ئەندامانی کۆمەڵگای لیڤۆ تایبەتن بە لایەنەکانیان. فرۆشگا نایانبینێت و نایانخوێنێتەوە و چاودێری ناوەڕۆکیان ناکات، و هیچ دەرگایەکی پشتەوە بۆ هیچ بەڕێوەبەرایەتییەک بۆ بینینیان نییە.

### 7.2 بێبەرپرسیاریەتی فرۆشگا لە قسە و پێشنیاری ئەندامان
فرۆشگا بەرپرسیار نییە لەوەی ئەندامان لە گفتوگۆکانیان یان لە پێشنیارەکانیاندا دەیڵێن یان پێشکەشی دەکەن یان بەڵێنی پێدەدەن. ئەوەی لە ئەندامێکەوە دەردەچێت تەنها خۆی پابەند دەکات.

### 7.3 دەستێوەردان بەپێی داواکاری
فرۆشگا دەستێوەردان ناکات لە گفتوگۆ یان مامەڵەیەکی نێوان دوو ئەندامدا مەگەر یەکێک لە لایەنەکان داوا لە پشتیوانی بکات. لە کاتی داواکاریدا پشتیوانی ئەو بەڵگانەی لایەنەکان پێشکەشی دەکەن و تۆمارەکانی مامەڵەکە دەبینێت، بەو ڕادەیەی بۆ بڕیاردان پێویستە.

### 7.4 ئەوەی لە دەرەوەی پلاتفۆرم ڕێککەوتی لەسەر دەکرێت
فرۆشگا بەرپرسیار نییە لە هیچ ڕێککەوتن یان پارەدان یان گەیاندنێک کە لە دەرەوەی پلاتفۆرم ئەنجام دەدرێت. ئەو کەسەی لە دەرەوەی پلاتفۆرم پارەی داوە یان ڕادەستی کردووە، واز لە پاراستنی سیستەم و لە تۆمارەکانی و لە ئەگەری دەستێوەردانی پشتیوانی هێناوە.

### 7.5 ڕاگەیاندنی پێشێلکاری
ئەندامی کۆمەڵگا دەتوانێت ناوەڕۆک یان ڕەفتارێکی پێشێلکار لە ڕێگەی پشتیوانییەوە ڕابگەیەنێت. فرۆشگا ئەو ڕێکارەی پێی باشە بەرامبەر هەژماری پێشێلکار دەگرێتەبەر، بەبێ ئەوەی بەمە ببێتە دەستەبەرکەری مامەڵەی خەڵکی دیکە.

### 7.6 سنووری ئەوەی پلاتفۆرم دەتوانێت بیسەلمێنێت
ئەوەی پلاتفۆرم هەڵیدەگرێت ئەوەیە لە ناوەوەی ڕوویداوە: داواکاری و پارەدان و دۆخەکان و بەروارەکان. ناتوانێت ئەوە بسەلمێنێت کە لە دەرەوەی ڕوویداوە، و نە بڕیار بدات لە ناکۆکییەک کە هیچ شوێنەوارێکی لە تۆمارەکانیدا نییە.

## 8. ڕێڕەوی لیڤۆ پرۆ بۆ بازرگانان

### 8.1 هەنگاوەکانی ڕێڕەوەکە
بازرگان بەرهەمەکەی لە ناو پلاتفۆرمدا پیشان دەدات، کڕیار زیادی دەکات بۆ سەبەتەکەی، داواکارییەکە دروست دەکات، و بەهاکەی پێشەکی لە جزدانەکەیەوە دەدات. پاشان بازرگان داواکارییەکە ئامادە دەکات و بە ڕێگەی ڕاگەیەنراوی خۆی دەیگەیەنێت.

### 8.2 پارەدانی پێشەکی لە جزدانەوە
هیچ داواکارییەک لە فرۆشگای بازرگانێکەوە دروست نابێت مەگەر باڵانسی بەردەست لە جزدانی کڕیاردا تەواوی بەهای داواکارییەکە بپۆشێت. بڕەکە حیجز دەکرێت و پاشان لەگەڵ دروستبوونی داواکارییەکەدا لە یەک مامەڵەدا جێگیر دەکرێت، بۆیە لەم ڕێڕەوەدا نە داواکاری نەدراو هەیە و نە بڕینی بەبێ داواکاری.

### 8.3 نە پارەدان لە کاتی وەرگرتن و نە وەرگرتن لە کۆگا
لەم ڕێڕەوەدا پارەدان لە کاتی وەرگرتن و وەرگرتن لە کۆگا بەردەست نین، چونکە فرۆشگا نە کاڵای بازرگان هەڵدەگرێت و نە کەسێکی هەیە لە جیاتی ئەو لە بەردەرگا کۆی بکاتەوە.

### 8.4 گفتوگۆ و دانوستان لە ناو پلاتفۆرمدا
کڕیار و بازرگان دەتوانن لە ناو پلاتفۆرمدا گفتوگۆ بکەن و لەسەر نرخ دانوستان بکەن. هەر نرخێکی ڕێککەوتی لەسەر کراو تەنها کاتێک کاری پێدەکرێت کە پێش دروستبوونی داواکارییەکە لە پیشاندانی بازرگان لە ناو پلاتفۆرمدا ڕەنگی دابێتەوە، چونکە داواکارییەکە لە تۆمارەکانی پلاتفۆرمەوە نرخ دەکرێت نەک لە دەقی گفتوگۆیەکەوە.

### 8.5 کۆمیسیۆنی پلاتفۆرم
پلاتفۆرم کۆمیسیۆنی خۆی لە بەهای فرۆشتنەکە وەردەگرێت بەو ڕێژەیەی لە کاتی فرۆشتندا کاری پێدەکرا، و ئەم ڕێژەیە لەسەر داواکارییەکە جێگیر دەکرێت. گۆڕانی ڕێژەکە لە دواتردا ئەوە ناگۆڕێت کە لەسەر داواکارییەکی پێشوو شایستە بووە.

### 8.6 شایستەیی بازرگان
بەشی بازرگان لە کاتی دروستبوونی داواکارییەکەدا بە دۆخی چاوەڕوان تۆمار دەکرێت، و تەنها دوای گەیاندنی داواکارییەکە دەکرێت دەربهێنرێت. ئەگەر داواکارییەکە هەڵوەشێنرایەوە، تۆمارە چاوەڕوانەکە پێچەوانە دەکرێتەوە.

### 8.7 ئەرکەکانی بازرگان
بازرگان پابەندە بە ڕاستی وەسف و نرخ و بڕی بەرهەمەکەی، و بە ئامادەکردن و گەیاندنی داواکارییەکە لەو ماوەیەدا کە ڕایگەیاندووە، و بە وەڵامدانەوەی کڕیارەکەی، و بە جێبەجێکردنی گەرەنتی و گەڕاندنەوە ڕاگەیەنراوەکانی.

### 8.8 بازرگانێک کە وەڵام نادات
ئەگەر بازرگان وەڵامدانەوە یان جێبەجێکردنی داواکارییەکی دراوی ڕاگرت، کڕیار دەتوانێت داوا لە پشتیوانی بکات دەستێوەردان بکات. فرۆشگا ئەوسا دەتوانێت فرۆشگای بازرگانەکە ڕابگرێت، شایستە چاوەڕوانەکانی بگرێتەوە، داواکارییەکە هەڵبوەشێنێتەوە و بڕەکە بۆ جزدانی کڕیار بگەڕێنێتەوە. گەڕاندنەوەکە لەلایەن بەڕێوەبەرایەتی فرۆشگاوە جێبەجێ دەکرێت نەک لەلایەن بازرگانەوە.

### 8.9 ڕاگرتنی فرۆشگای بازرگان
فرۆشگا دەتوانێت فرۆشگای بازرگان ڕابگرێت یان سنووردار بکات لە کاتی دووبارەبوونەوەی دواکەوتن یان سکاڵا یان پێشێلکردنی سیاسەتەکان، بەمەرجێک ئەو داواکارییانەی پێش ڕاگرتنەکە هەبوون بۆ ڕێکخستن بمێننەوە.

### 8.10 گواستنەوەی بەرپرسیاریەتی نییە
دەستێوەردانی فرۆشگا لە هەر یەکێک لە حاڵەتەکانی سەرەوەدا ڕێکارێکی ڕێکخستنەییە بۆ پاراستنی کڕیار، و لیڤۆنیس ناکاتە فرۆشیار یان دەستەبەرکەری کاڵای بازرگان.

## 9. ئۆفەر و ڕیکلام و نرخاندن

### 9.1 ماوەی ئۆفەر
هەر ئۆفەرێک دەستپێک و کۆتاییەکی ڕاگەیەنراوی هەیە، و پێش دەستپێکی و دوای کۆتاییەکەی جێبەجێ ناکرێت تەنانەت ئەگەر لەسەر شاشەیەکی نوێنەکراوەوە بمێنێتەوە.

### 9.2 سنووری ئۆفەر
ئۆفەر سنوورێکی هەیە بۆ هەر بەکارهێنەرێک و سنوورێکی گشتی. تەواوبوونی سنوورەکە ئۆفەرەکە بە کردەوە کۆتایی پێدەهێنێت تەنانەت ئەگەر ماوەکەی تەواو نەبووبێت.

### 9.3 ئۆفەرە بەندەکان بە ئەندامێتییەوە
هەندێک ئۆفەر تەنها بۆ ئاستێکی دیاریکراوی ئەندامێتین. ئەو کەسەی ئەندامێتییەکەی لە کاتی داواکاریدا چالاک نییە شایستەی نییە.

### 9.4 دوو نرخ لەسەر یەک کاڵا کۆ ناکرێنەوە
نرخی ئۆفەری خشتەکراو لەگەڵ نرخێکی دیکە لەسەر هەمان کاڵا کۆ ناکرێتەوە. کوپۆن بەپێی مەرجەکانی خۆی لەسەر بەهای کاڵا جێبەجێ دەمێنێتەوە.

### 9.5 ڕاستگۆیی لە ڕیکلامدا
فرۆشگا پابەندە بەوەی نرخێک ڕانەگەیەنێت کە پێی نافرۆشێت، و نە داشکاندنێک کە لەسەر نرخێک حساب کراوە کە بە ڕاستی کاری پێنەدەکرا.

### 9.6 ڕیکلامی بازرگانان
ڕیکلامی بازرگان بۆ بەرهەمەکەی بەرپرسیاریەتی خۆیەتی، و فرۆشگا دەتوانێت پیشاندانێکی پێشێلکار یان چەواشەکار لە پلاتفۆرم لابەرێت.

## 10. سنووری بەرپرسیاریەتی

### 10.1 زیان لە کاتی گواستنەوە
فرۆشگا بەرپرسیار نییە لەو زیانەی لە کاتی گواستنەوەدا ڕوو دەدات، بەوەشەوە کە لە سنووری هەرێمی کوردستان یان لە هەر خاڵێکی پشکنیندا ڕوو دەدات کە پاکەتەکە لێی دەکرێتەوە و دووبارە پاکەت دەکرێتەوە لەلایەن لایەنێکەوە کە نە فرۆشگایە و نە کۆمپانیای گەیاندن. وردەکارییەکەی لە سیاسەتی کڕین و سیاسەتی گەیاندندایە.

### 10.2 کرێی گەیاندن و باج
کرێی گەیاندن و ئەو باجەی پێوەی بەستراوە لەلایەن کۆمپانیاکانی گەیاندنەوە دیاری دەکرێن نەک لەلایەن لیڤۆنیسەوە، و فرۆشگا ئەوە دەگوازێتەوە کە کۆمپانیاکە داوای دەکات و کۆنترۆڵی ناکات.

### 10.3 دواکەوتنی دەرەوەی دەسەڵاتی فرۆشگا
فرۆشگا بەرپرسیار نییە لەو دواکەوتنەی لە دابینکەر یان گواستنەوە یان ڕێکارەکانی سنوور و پشکنین یان هێزی زاڵ یان داخستنی ڕێگاکان یان وەستانی تۆڕەکانەوە سەرچاوە دەگرێت.

### 10.4 بەکارهێنان و چاودێری
فرۆشگا بەرپرسیار نییە لەو زیانەی لە خراپبەکارهێنان یان لە خستنەکار بە پێچەوانەی ڕێنماییەکانی بەرهەمهێنەر یان لە دەستکاری و چاککردنەوەی بێ ڕێپێدان یان لە بەکارهێنانی ماددەی نەگونجاو سەرچاوە دەگرێت.

### 10.5 زیانی ناڕاستەوخۆ
فرۆشگا بەرپرسیار نییە لە زیانی ناڕاستەوخۆ و لە لەدەستدانی قازانج و لە وەستانی کار کە لە عەیبی بەرهەمێکەوە دێت، و پابەندییەکەی لە چوارچێوەی چاککردنەوە یان گۆڕینەوە یان گەڕاندنەوە دەمێنێتەوە بەپێی سیاسەتی گەرەنتی و سیاسەتی گەڕاندنەوە.

### 10.6 سنووری بەرپرسیاریەتی
بەرپرسیاریەتی فرۆشگا لەسەر هیچ داواکارییەک لەو بەهایە تێناپەڕێت کە بە ڕاستی لەسەر ئەو داواکارییە دراوە، مەگەر یاسای جێبەجێکراو پێچەوانەی بڵێت.

### 10.7 بەرپرسیاریەتی بازرگان
بەرپرسیاریەتی بازرگان لەسەر کاڵا و بەڵێنەکانی بەرامبەر کڕیارەکەی دەمێنێتەوە، و بەهۆی میوانداریکردنی مامەڵەکە لەلایەن پلاتفۆرمەوە بۆ لیڤۆنیس ناگوازرێتەوە.

## 11. حوکمە کۆتاییەکان

### 11.1 هەموارکردن
فرۆشگا دەتوانێت ئەم سیاسەتە هەموار بکات بە دەرکردنی وەشانێکی نوێ بە ژمارە و بەرواری جێبەجێبوونەوە، و هەمواری کاریگەری دواوەی نییە لەسەر داواکارییەکی پێشوو.

### 11.2 سەربەخۆیی بڕگەکان
پووچبوونەوەی بڕگەیەک کاریگەری لەسەر بڕگەکانی دیکە نییە.

### 11.3 چارەسەری ناکۆکی
ناکۆکی بە ژمارەی داواکاری و بەڵگەنامەکانەوە پێشکەشی پشتیوانی دەکرێت، و لە ماوەی {{DISPUTE_RESPONSE_DAYS}} ڕۆژدا هەوڵی چارەسەری دۆستانە دەدرێت.

### 11.4 یاسا و دەسەڵاتی دادوەری
ئەم بەڵگەنامەیە بەپێی یاساکانی {{GOVERNING_LAW_JURISDICTION}} دەبێت، و دەسەڵاتی دادوەری بۆ دادگاکانی {{COMPETENT_COURT}}ـە.

### 11.5 خاڵی پەیوەندی
خاڵی پەیوەندی پەسەندکراو {{LEVONIS_SUPPORT_CONTACT}}ـە، و کاتی کارکردن {{LEVONIS_SUPPORT_HOURS}}ـە.`,
  },
};
