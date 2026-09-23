import type { PolicyDocument } from './types';

/**
 * سياسة الشراء — THE CUSTOMER'S SIDE OF THE SALE.
 *
 * WHY THIS IS A SOURCE FILE AND NOT AN ADMIN SCREEN. The owner's instruction
 * is that these documents are edited from the code and from nowhere else: an
 * admin page that anyone with a session could rewrite is not an instrument the
 * store can rely on in front of a customer, a courier or a bank. A change here
 * is a commit, a review and a deploy, with a version number and an effective
 * date — which is exactly what makes the text usable as evidence.
 *
 * WHY THE ARABIC IS WRITTEN FIRST. Arabic is the authoritative text (article
 * 1.6); en and ckb carry the SAME article numbers so a customer who accepted
 * one language and argues in another is arguing about the same article.
 *
 * WHY PLACEHOLDERS. Every double-braced token is a fact the code does not hold — a
 * registration number, a contact, a threshold nobody has decided. A blank the
 * owner fills is recoverable; an invented company number in a document shown
 * to a bank is not. The renderer must refuse to publish a document that still
 * carries an unresolved token rather than print it to a customer.
 *
 * VERSION 3 — WHY IT MOVED. Two corrections a customer could see on the
 * page; the archive keeps version 2 byte for byte.
 *   * THE NAME. The store is written «Levonis», in Latin script, in all three
 *     languages. 12 transliterated occurrences left the body here — 6 in the
 *     Arabic body and 6 in the Sorani one. The Sorani half is why this line
 *     names a count and not a spelling: the corpus used TWO Sorani forms,
 *     «لێڤۆنیس» with ێ (U+06CE) and «لیڤۆنیس» with ی (U+06CC), and a
 *     replacement that knew only the first shipped the second under an Arabic
 *     body that already read «Levonis». tests/policyCorpus.test.ts now
 *     enumerates all three forms.
 *   * THE UNKNOWNS. 13 articles and 13 further lines in this document still state a
 *     fact the owner has not given, so ./render.ts WITHHOLDS them from the published
 *     text rather than show a customer a `{{TOKEN}}`. They are still authored
 *     below, and each one returns of its own accord the moment its value is
 *     written in and the version moves again.
 *
 * VERSION 4 — WHY IT MOVED. The archive keeps version 3 byte for byte.
 *   * THE FACTS. worker/lib/policies/facts.ts now states `COMPETENT_COURT`, `GOVERNING_LAW_JURISDICTION`, `LEVONIS_SUPPORT_CONTACT`, `MIN_PURCHASE_AGE_YEARS`, `PRIME_FREE_DELIVERY_MIN_IQD`, `PRO_FREE_DELIVERY_MIN_IQD`,
 *     so the clauses that carried them are published instead of withheld.
 *   * NO POINTER TO NOTHING. ./render.ts now also withholds a line that cites,
 *     by number, an article of this document that is itself withheld. 10.3
 *     (be present or authorise a recipient) no longer cites the still-withheld
 *     9.7, so that obligation stays published.
 *   * ONE NAME PER TIER. 6.6 calls the middle tier LEVO PREMIUM, as membership
 *     2.4 says every customer screen does; `PRIME_` survives only as the token.
 */
export const purchase: PolicyDocument = {
  key: 'purchase',
  version: 4,
  effective_at: '2026-09-23',
  title: {
    ar: 'سياسة الشراء',
    en: 'Purchase Policy',
    ckb: 'سیاسەتی کڕین',
  },
  body: {
    ar: `## 1. التمهيد والتعريفات

### 1.1 الغرض من هذه الوثيقة
تبيّن هذه الوثيقة شروط الشراء من Levonis: من يحق له الشراء، وكيف يتكوّن الطلب، ومتى يصبح ملزماً للطرفين، وماذا يشمل السعر المعروض، وما هي واجبات الزبون عند التسليم. وهي وثيقة تعاقدية تُقرأ مع باقي وثائق المتجر ولا تحلّ محلها.

### 1.2 الأطراف
الطرف الأول هو المتجر: {{LEVONIS_LEGAL_NAME}}، المسجل برقم {{LEVONIS_REGISTRATION_NO}}، وعنوانه {{LEVONIS_ADDRESS}}. الطرف الثاني هو الزبون: صاحب الحساب الذي أُرسل الطلب منه.

### 1.3 التعريفات
- المتجر أو Levonis: المتجر الرسمي الذي يبيع بضاعته الخاصة ويشحنها من مخزنه.
- مجتمع ليفو: المساحة التي يعرض فيها التجار المستقلون بضاعتهم داخل المنصة.
- التاجر: بائع مستقل يملك متجراً داخل مجتمع ليفو، وهو البائع في طلباته لا Levonis.
- الطلب: الطلب المسجل في النظام برقمه، بكل ما يحمله من أسطر وأسعار وعنوان ووسيلة دفع.
- البيع المباشر: بيع قطعة متوفرة فعلاً لدى المتجر وقت الطلب.
- الطلب المسبق: شراء قطعة تُجلب بعد الطلب عبر الشحن الجوي أو البحري أو البري.
- المحفظة: رصيد الزبون داخل المنصة، بأحكامه المبيّنة في سياسة الدفع والمحفظة.
- شركة التوصيل: الشركة التي تنقل الطرد وتحدد أجرته وضريبته.
- عرض السعر: الحساب الذي يعرضه النظام قبل إتمام الطلب، بكل بنوده.

### 1.4 نطاق التطبيق
تسري هذه السياسة على كل طلب يُنشأ عبر المنصة، سواء كان بائعه Levonis أو تاجراً في مجتمع ليفو، وعلى كل وسيلة دفع وكل وسيلة تسليم، ما لم يُنصّ على خلاف ذلك في بند صريح.

### 1.5 علاقة هذه الوثيقة بباقي الوثائق
تُقرأ هذه السياسة مع سياسة البيع، وسياسة الدفع والمحفظة، وسياسة الأسعار وتغييرها وإلغاء الطلب، وسياسة التوصيل، وسياسة الضمان، وسياسة الإرجاع والاستبدال. وعند تعارض ظاهر، يُقدَّم البند الأخص على البند الأعم، وتُقدَّم الوثيقة المتخصصة في الموضوع على ما ورد عرضاً في غيرها.

### 1.6 اللغة المعتمدة
النص العربي هو النص المعتمد. النسختان الإنكليزية والكردية ترجمتان أمينتان له وتحملان الترقيم نفسه، وعند أي اختلاف في المعنى يُرجع إلى النص العربي.

### 1.7 النسخة وتاريخ النفاذ
لهذه الوثيقة رقم نسخة وتاريخ نفاذ مثبتان في أعلاها. يخضع كل طلب لنسخة السياسة النافذة لحظة إنشائه، ويُسجَّل قبول الزبون لها مع الطلب.

### 1.8 لا تنازل ضمني
عدم مطالبة المتجر بحق من حقوقه في واقعة معيّنة لا يُعدّ تنازلاً عنه، ولا يمنعه من المطالبة به في واقعة أخرى.

## 2. أهلية الشراء وحساب الزبون

### 2.1 اشتراط الحساب
لا يُنشأ أي طلب دون حساب مسجل ومسجّل الدخول. السلة وعرض السعر والطلب والمحفظة كلها مرتبطة بالحساب، ولا يقبل النظام طلباً من زائر غير مسجل.

### 2.2 الأهلية القانونية والسن
يجب أن يكون الزبون كامل الأهلية القانونية للتعاقد. ومن كان دون {{MIN_PURCHASE_AGE_YEARS}} سنة لا يشتري إلا عبر وليّه أو من يمثله قانوناً، ويتحمل صاحب الحساب مسؤولية كل طلب صدر منه.

### 2.3 صحة بيانات الحساب
يلتزم الزبون بأن يكون اسمه ورقم هاتفه وبريده وعناوينه صحيحة وقابلة للاستعمال. البيانات الخاطئة أو المنتحلة سبب كافٍ لرفض الطلب أو إيقافه.

### 2.4 حساب واحد لكل شخص
لكل شخص حساب واحد. إنشاء حسابات متعددة للحصول على عروض أو نقاط أو إحالات أو مزايا عضوية غير مستحقة مخالفة تُسقط المزية وتعرّض الحسابات جميعها للإيقاف.

### 2.5 أمن الحساب ومسؤولية الأوامر الصادرة منه
الزبون مسؤول عن حماية بيانات دخوله ورموز التحقق. يُعدّ كل طلب أُنشئ من حسابه صادراً عنه ما لم يُبلّغ الدعم باختراق قبل تنفيذ الطلب، ولا يطلب الدعم كلمة السر أو رمز التحقق في أي حال.

### 2.6 الشراء بالنيابة عن منشأة
من يشتري باسم شركة أو جهة يقرّ بأنه مخوّل بذلك. ويُخاطب المتجر صاحب الحساب وحده في كل ما يتعلق بالطلب، ولا يلتزم بمخاطبة جهة أخرى إلا بتفويض مكتوب.

### 2.7 تقييد الحساب أو إيقافه
للمتجر تقييد الشراء أو إيقاف الحساب عند ثبوت تزوير إيصال، أو إساءة استعمال العروض والنقاط، أو تكرار رفض الاستلام، أو سلوك مسيء تجاه العاملين أو المندوبين، على أن يُبيَّن السبب ويبقى للزبون حق الاعتراض عبر الدعم.

## 3. كيف يتكوّن الطلب ومتى يصبح ملزماً

### 3.1 السلة ليست حجزاً
إضافة قطعة إلى السلة لا تحجزها ولا تثبّت سعرها ولا تضمن توفرها. تبقى القطعة متاحة لغيره من الزبائن حتى لحظة إنشاء الطلب فعلاً.

### 3.2 التسعير من الخادم وحده
تُحتسب كل الأسعار والرسوم والخصومات على الخادم. أي سعر أو مجموع يرسله المتصفح يُهمل تماماً، والرقم المعتمد هو ما يحتسبه النظام لحظة إنشاء الطلب.

### 3.3 عرض السعر قبل التأكيد
قبل إتمام الطلب يعرض النظام: قيمة البضاعة، ورسوم النقل أو علاوة البيع المباشر، ورسم الضمان الممتد إن اختير، وأجرة التوصيل، وضريبة الدفع عند الاستلام إن وُجدت، والخصومات والنقاط، والمبلغ المخصوم من المحفظة، والمبلغ المستحق عند التسليم. عرض السعر بيان حسابي لحظي وليس عقداً بذاته.

### 3.4 إرسال الطلب إيجاب من الزبون
إرسال الطلب إيجاب بالشراء من الزبون وفق السعر والشروط المعروضة له في تلك اللحظة، وليس قبولاً نهائياً من المتجر.

### 3.5 حالة الطلب عند الإنشاء
يُنشأ كل طلب بحالة قيد الانتظار. وفي هذه الحالة لا يكون المتجر قد قبل البيع بعد، وتبقى الكمية والتوفر خاضعين للمراجعة.

### 3.6 متى ينعقد العقد
ينعقد العقد بتأكيد المتجر للطلب بعد التحقق من التوفر وصحة البيانات. وقبل التأكيد يجوز للمتجر رفض الطلب أو تعديل سعره وفق سياسة الأسعار وتغييرها وإلغاء الطلب.

### 3.7 الدفع عند الإنشاء في الطلبات المدفوعة مسبقاً
في الطلب المدفوع من المحفظة يُخصم المبلغ لحظة إنشاء الطلب لا لحظة التأكيد. وإذا لم يتمكن المتجر من تأكيد الطلب أُعيد المبلغ إلى المحفظة كاملاً وفق سياسة الدفع والمحفظة.

### 3.8 النقر المزدوج ومفتاح عدم التكرار
يحمل كل إتمام طلب مفتاحاً لمنع التكرار، فلا ينشئ النقر المزدوج أو إعادة المحاولة بعد انقطاع الشبكة طلبين ولا خصمين. وإذا تكرر الإرسال بالمفتاح نفسه أعاد النظام الطلب الأول ذاته.

### 3.9 قبول السياسات المسجل مع الطلب
يُسجَّل قبول الزبون للسياسات المطلوبة في المعاملة نفسها التي يُكتب فيها الطلب، بنسختها ورقمها ووقتها. فلا يوجد طلب مؤكد دون قبول مسجل، ولا قبول مسجل دون طلب.

### 3.10 لقطة الطلب وحجيّتها
تُحفظ مع الطلب لقطة ثابتة لما كان عليه السعر والعنوان ووسيلة الدفع والمزايا وقت الشراء. وتغيير الإعدادات أو الأسعار لاحقاً لا يغيّر طلباً سابقاً، وهذه اللقطة هي المرجع عند أي خلاف على ما جرى الاتفاق عليه.

### 3.11 الطلبات المتفق عليها خارج المنصة
لا يُعتدّ بطلب أو سعر أو وعد اتُّفق عليه خارج المنصة ولم يُسجَّل طلباً فيها. والمتجر غير ملزم بما لا رقم طلب له.

## 4. البيع المباشر والطلب المسبق

### 4.1 تعريف البيع المباشر
البيع المباشر بيع قطعة موجودة فعلاً لدى المتجر وقت الطلب، تُجهَّز وتُسلَّم ضمن المسار المحلي القصير.

### 4.2 تعريف الطلب المسبق
الطلب المسبق تكليف للمتجر بجلب قطعة غير موجودة في المخزن وقت الطلب، من مصدرها إلى العراق ثم إلى الزبون. وهو وعد بالجلب وفق مسار نقل محدد، لا بيع من رفّ جاهز.

### 4.3 مسارات النقل الثلاثة
للطلب المسبق ثلاثة مسارات: الشحن الجوي، والشحن البحري، والشحن البري. لكل مسار مدته التقديرية وعمولته الخاصة، ويُختار المسار قبل إضافة القطعة إلى السلة ويُثبَّت على الطلب.

### 4.4 المدد الزمنية تقديرية
المدد المعروضة لكل مسار تقديرية مبنية على المعتاد، وليست موعداً مضموناً. ولا يُعدّ تجاوزها بسبب المجهّز أو الناقل أو إجراءات المنافذ إخلالاً موجباً للتعويض.

### 4.5 مراحل التتبع
يمر البيع المباشر بخمس مراحل: استُلم، أُكِّد، قيد التجهيز، خرج للتوصيل، سُلِّم. ويمر الطلب المسبق بأربع عشرة مرحلة تبدأ من تجهيز المجهّز ومخزن المنشأ وتنتهي بالتسليم. وحالة الطلب المعروضة في الحساب هي البيان المعتمد لموقعه.

### 4.6 نوع شحن واحد للسلة الواحدة
لا تجمع السلة الواحدة بين نوعي شحن مختلفين، لأن لكل نوع مساراً ومدة وتتبعاً مختلفاً. وعند محاولة الجمع يرفض النظام الإضافة ويعرض إفراغ السلة والبدء بالنوع الجديد.

### 4.7 بائع واحد للسلة الواحدة
لا تجمع السلة الواحدة بين بضاعة Levonis وبضاعة تاجر، ولا بين تاجرين. وعند محاولة الجمع يرفض النظام الإضافة حتى تُفرَغ السلة، لأن كل بائع مسؤول عن طلبه ووسيلة تسليمه وعمولته على حدة.

### 4.8 لا يحوّل الطلب المسبق إلى بيع مباشر
اختيار الدفع عند الاستلام في طلب مسبق قد يغيّر طريقة تسعير السطر، لكنه لا يغيّر طبيعة الطلب: يبقى طلباً مسبقاً بمساره ومراحله ومدته. ولا يحق للزبون مطالبة المتجر بتسليم فوري لأنه اختار الدفع عند الباب.

### 4.9 التوفر في الطلب المسبق
قد يتعذر على المجهّز تأمين القطعة أو مواصفتها بعد الطلب. وفي هذه الحالة يُخيَّر الزبون بين البديل المتاح أو الانتظار أو إلغاء الطلب مع إعادة ما دفع كاملاً.

### 4.10 اختلاف التسعير بين المسارين
سعر القطعة في الطلب المسبق يحمل عمولة النقل الخاصة بالمسار المختار، وسعرها في البيع المباشر قد يحمل علاوة التوفر الفوري. ولا يُجمع الاثنان على السطر الواحد أبداً.

## 5. الكميات والحدود

### 5.1 حدود الكمية في السطر الواحد
أقل كمية للسطر الواحد قطعة واحدة، وأكثرها تسع وتسعون قطعة. وقد يكون للمنتج أو للحزمة أو للعرض حدّ أدنى من ذلك يُعرض عند الإضافة.

### 5.2 سقف السطور في الطلب الواحد
لكل طلب سقف لعدد السطور المادية التي يحتملها، وعند تجاوزه يرفض النظام الطلب صراحةً ويطلب تقسيمه إلى طلبات، بدل تنفيذ طلب ناقص.

### 5.3 حدود الحزم والعروض
للحزمة حدّ أقصى للكمية في الطلب الواحد. وللعرض المحدود حدّ لكل مستخدم وحدّ إجمالي، ويُرفض الطلب الذي يتجاوزهما ولو كان العرض ما يزال معروضاً على الشاشة.

### 5.4 مراجعة المخزون لحظة الطلب
يُعاد التحقق من التوفر والمخزون لحظة إنشاء الطلب لا لحظة الإضافة إلى السلة. والقطعة التي نفدت أو أُخفيت بين اللحظتين توقف الطلب بدل إنشاء التزام لا يمكن تنفيذه.

### 5.5 الحدّ من الكميات المشتبه بإعادة بيعها
للمتجر خفض الكمية أو رفض الطلب كلياً عند وجود قرائن على الشراء بغرض إعادة البيع، أو على تجزئة طلب واحد على حسابات متعددة لاستنفاد عرض محدود.

### 5.6 لا حجز بالكمية قبل إنشاء الطلب
لا تُحجز أي كمية لصالح زبون قبل إنشاء طلبه فعلاً. ووجود القطعة في سلته لا يمنع بيعها لغيره.

## 6. ما يشمله السعر المعروض وما لا يشمله

### 6.1 فصل قيمة البضاعة عن الرسوم
يفصل النظام دائماً قيمة البضاعة عن الرسوم. النقاط والخصومات تُحتسب على قيمة البضاعة وحدها، ولا تُحتسب على أجرة التوصيل ولا على عمولة النقل ولا على رسم الضمان.

### 6.2 عمولة النقل في الطلب المسبق
سعر سطر الطلب المسبق يشمل عمولة النقل الخاصة بالمسار المختار. وهي جزء من ثمن الخدمة لا من ثمن البضاعة، ولا تُسترد بمجرد تغيير رأي الزبون بعد الشراء.

### 6.3 علاوة البيع المباشر
قد يحمل سعر البيع المباشر علاوة مقابل التوفر الفوري. وعضو PRO الفعّال معفى من هذه العلاوة ومن عمولة النقل وفق شروط العضوية.

### 6.4 رسم الضمان الممتد
إذا اختار الزبون تمديد ضمان الطابعة أُضيف رسمه إلى سعر السطر. ولا يجوز شراء التمديد بعد إنشاء الطلب بأي حال، وتفصيل ذلك في سياسة الضمان.

### 6.5 أجرة التوصيل وضريبتها تحددهما شركات التوصيل
أجرة التوصيل والضريبة المرتبطة بها تحددهما شركات التوصيل، لا Levonis. المتجر ينقل إلى الزبون ما تفرضه الشركة الناقلة ولا يضيف إليه ولا يتحكم به، وأي تغيير في تعرفة الشركة ينعكس على ما يُعرض عند الطلب.

### 6.6 كلف التوصيل على الزبون
كل كلف التوصيل على الزبون. ويُستثنى من ذلك أعضاء PRO و LEVO PREMIUM فوق قيمة طلب محددة، حيث يتحملها المتجر: الإعفاء لعضو PRO الفعّال عند تجاوز قيمة البضاعة المؤهلة حدّ {{PRO_FREE_DELIVERY_MIN_IQD}} دينار حصراً بالزيادة، ويشمل التوصيل الاعتيادي والتغليف المحمي. أما LEVO PREMIUM فيُعفى من أجرة التوصيل الاعتيادية وحدها عند تجاوز حدّ {{PRIME_FREE_DELIVERY_MIN_IQD}} دينار حصراً بالزيادة. والرقم المعتمد في كل طلب هو المعروض في شاشة الدفع لذلك الطلب، وتفصيل الشروط في سياسة التوصيل.

### 6.7 ضريبة الدفع عند الاستلام
عند اختيار الدفع عند الاستلام مع التوصيل إلى عنوان، تُضاف ضريبة بمقدار مقرر عن كل شريحة كاملة من المبلغ المستحق عند الباب. ومقدار الضريبة ومقدار الشريحة كلاهما قابلان للتعديل من إدارة المتجر، والرقم المعتمد في كل طلب هو المعروض في شاشة الدفع لذلك الطلب. ولا تُفرض هذه الضريبة على الاستلام من المخزن ولا على الطلب المدفوع مسبقاً. وقد تُعفى منها بعض مستويات العضوية، ويُعرض مقدار الضريبة والإعفاء رقمين منفصلين على الفاتورة.

### 6.8 مقدمة توصيل الطابعة إلى المنزل
توصيل الطابعة إلى عنوان يستلزم دفع مقدمة من المحفظة قبل إتمام الطلب، بالمبلغ المعروض على صفحة المنتج وفي شاشة الدفع، وهو عند تاريخ نفاذ هذه النسخة خمسون ألف دينار. ولا تُطلب هذه المقدمة عند الاستلام من المخزن، ويُرفض الطلب إذا لم يغطها الرصيد.

### 6.9 التغليف المحمي
التغليف المحمي خدمة اختيارية تُضاف فوق التعرفة الاعتيادية ولا تحلّ محلها. ولا تُعرض إلا إذا كان سعرها محدداً، ولا تُفرض على من لم يطلبها.

### 6.10 النقاط والكوبونات
النقطة الواحدة تساوي ديناراً واحداً عند الاستعمال، ولا تُستعمل إلا على قيمة البضاعة. والكوبون يخضع لشروطه ومدته وحدوده، ولا يُجمع مع سعر عرض مجدول على القطعة نفسها إلا إذا نُصّ على ذلك.

### 6.11 العملة والتحويل
الأسعار معروضة بالدينار العراقي. ورصيد المحفظة محفوظ بالدولار، ويحوَّل إلى الدينار بسعر الصرف المعتمد في المتجر لحظة العملية، ويُثبَّت هذا السعر على الطلب.

### 6.12 ما لا يشمله السعر
لا يشمل السعر المعروض: تركيب المنتج أو تشغيله، ولا التدريب عليه، ولا المواد الاستهلاكية غير المذكورة في وصف القطعة، ولا أي رسم تفرضه جهة ثالثة بعد التسليم، ولا كلفة إعادة الإرسال بعد تسليم فاشل يعود سببه إلى الزبون.

## 7. تأكيد الطلب والإشعارات

### 7.1 معنى التأكيد
التأكيد إعلان من المتجر بقبول البيع وبدء التجهيز. وقبله لا يُعدّ الطلب مقبولاً مهما ظهر على الشاشة من مبالغ أو مراحل.

### 7.2 قنوات الإشعار
تُرسل إشعارات الطلب إلى الحساب وإلى ما سجّله الزبون من وسائل اتصال. وعدم وصول إشعار لسبب خارج عن المتجر لا يبطل الطلب ولا يوقف مدده، والمرجع هو حالة الطلب المعروضة في الحساب.

### 7.3 تعذر التأكيد
إذا تعذر التحقق من الزبون أو من عنوانه أو من جدية طلبه خلال {{ORDER_CONFIRMATION_WINDOW_HOURS}} ساعة من إنشائه، جاز للمتجر إلغاء الطلب وإعادة ما دُفع منه.

### 7.4 الفاتورة
تُصدر للطلب فاتورة تحمل تفصيل قيمة البضاعة والرسوم والخصومات والمدفوع والمتبقي. وهي المستند المعتمد في كل مطالبة لاحقة تتعلق بالمبالغ.

### 7.5 تتبع الطلب
يُعرض للزبون موقع طلبه على مسار مراحله. ولا تُعرض عليه الأرقام الداخلية لشركة النقل، ولا يُعدّ تأخر انتقال مرحلة بذاته إخلالاً ما دام الطلب سائراً.

### 7.6 تغيير العنوان بعد التأكيد
لا يُغيَّر عنوان التسليم بعد تسليم الطرد إلى شركة التوصيل إلا بموافقة الشركة. وإذا قبلت الشركة التغيير تحمّل الزبون فرق الأجرة إن وُجد.

## 8. الاستلام والفحص عند الباب

### 8.1 موعد التسليم والاتصال المسبق
تتصل شركة التوصيل بالرقم المسجل على الطلب قبل التسليم أو عنده. ويلتزم الزبون بأن يكون الرقم عاملاً ومتاحاً خلال أيام التوصيل المعتادة.

### 8.2 من يحق له الاستلام
يُسلَّم الطرد إلى الزبون أو إلى من يفوّضه في العنوان نفسه. ويُعدّ استلام من كان في العنوان تسليماً صحيحاً منتجاً لآثاره، ما لم يُبلَّغ المتجر بخلاف ذلك قبل التسليم.

### 8.3 ما يجب فحصه عند الباب
على الزبون قبل التوقيع أو الدفع أن يتحقق من: مطابقة الطرد لرقم طلبه، وسلامة الكارتون الخارجي، وعدم وجود فتح أو إعادة لصق، ومطابقة عدد القطع، ومطابقة الموديل واللون، ووجود الملحقات المذكورة، وسلامة الرقم التسلسلي حيث يوجد.

### 8.4 الطرد الواصل مفتوحاً أو متضرراً
إذا وصل الطرد مفتوحاً أو ممزقاً أو مبلولاً أو ظهر عليه أثر طرق أو إعادة تغليف، فعلى الزبون رفض استلامه أو استلامه مع إثبات التحفظ لدى المندوب وتصويره قبل فتحه. والاستلام دون تحفظ مع ضرر ظاهر يُضعف المطالبة اللاحقة بضرر النقل.

### 8.5 الضرر أثناء النقل وعند الحدود ونقاط التفتيش
لا يتحمل المتجر الضرر الذي يقع أثناء النقل، ويشمل ذلك الضرر الواقع عند حدود إقليم كردستان أو عند أي نقطة تفتيش يُفتح فيها الطرد ويُعاد تغليفه بمعرفة جهة ليست المتجر ولا شركة التوصيل. وتوجَّه المطالبة عن هذا الضرر إلى الجهة الناقلة أو الجهة التي أجرت التفتيش، ويقدّم المتجر ما لديه من مستندات لإسناد المطالبة.

### 8.6 توثيق الحالة بالصور
يوصى بتصوير الطرد قبل فتحه وأثناء فتحه بلقطة متصلة. وغياب التوثيق لا يسقط الحق بذاته، لكنه يجعل إثبات أن الضرر سابق على الاستلام أصعب على الزبون.

### 8.7 القبول مع التحفظ
للزبون أن يستلم الطرد ويثبّت تحفظه على حالته لدى المندوب. ويُبلّغ الدعم بذلك مع رقم الطلب والصور خلال {{DAMAGE_REPORT_WINDOW_HOURS}} ساعة من الاستلام.

### 8.8 التسليم الجزئي
إذا سُلّم جزء من الطلب فعلى الزبون إثبات ذلك عند الاستلام. ويبقى الجزء غير المسلّم قائماً بذمة المتجر، ولا يُعدّ تسليم جزء تسليماً للكل.

### 8.9 الأرقام التسلسلية وبدء مدد الضمان
تبدأ مدد الضمان والإرجاع من تاريخ التسليم الفعلي الموثق للقطعة، لا من تاريخ الطلب ولا من تاريخ الدفع. ويُسجَّل الرقم التسلسلي للأجهزة المسلسلة مع التسليم.

### 8.10 مهلة الإبلاغ عن نقص أو ضرر ظاهر
يُبلَّغ عن النقص أو الضرر الظاهر أو عدم مطابقة الموديل خلال {{DAMAGE_REPORT_WINDOW_HOURS}} ساعة من التسليم. والإبلاغ بعد هذه المهلة يُبحث بحسب طبيعة العيب، ولا يُقبل الاعتراض على أمر ظاهر كان يمكن رؤيته عند الباب.

## 9. الرفض عند الباب

### 9.1 حق الرفض وأسبابه المقبولة
للزبون رفض الاستلام عند وصول قطعة مختلفة عن المطلوب، أو كمية ناقصة، أو طرد متضرر أو مفتوح، أو مبلغ مطلوب يخالف ما على فاتورة الطلب.

### 9.2 الرفض دون سبب من الأسباب أعلاه
الرفض لغير الأسباب في المادة 9.1 لا يُنشئ حقاً في تحمّل المتجر لكلف النقل. وتُطبَّق عليه أحكام المادتين 9.3 و 9.6.

### 9.3 كلفة الرفض
عند الرفض لغير سبب يعود إلى المتجر، يتحمل الزبون أجرة الذهاب والإياب التي تطالب بها شركة التوصيل، وتُقتطع من المبلغ المعاد إليه إن كان الطلب مدفوعاً.

### 9.4 الرفض في الدفع عند الاستلام
في طلب الدفع عند الاستلام يُعاد الطرد إلى المتجر ولا يُحصَّل شيء. ويُسجَّل الرفض على الحساب، وتبقى كلفة الإرجاع المطالب بها من شركة التوصيل مستحقة على الزبون وفق المادة 9.3.

### 9.5 الرفض في الطلب المدفوع مسبقاً
إذا رُفض طلب مدفوع مسبقاً لغير سبب يعود إلى المتجر، أُعيد المبلغ إلى محفظة الزبون بعد خصم أجرة الذهاب والإياب وأي رسم لا يُسترد من شركة التوصيل.

### 9.6 تكرار الرفض وأثره
تكرار رفض الاستلام أو تكرار تعذر التسليم سبب كافٍ لحصر الشراء اللاحق بالدفع المسبق، أو لرفض طلبات الحساب، وفق سياسة البيع.

### 9.7 تعذر الوصول إلى الزبون
إذا تعذر على شركة التوصيل الوصول إلى الزبون بعد {{FAILED_DELIVERY_ATTEMPTS}} محاولات، أُعيد الطرد إلى المتجر وعُومل الطلب معاملة الرفض عند الباب، وطُبّقت عليه المادة 9.3.

## 10. التزامات الزبون

### 10.1 رقم هاتف عامل ومطابق
يلتزم الزبون بتسجيل رقم هاتف صحيح قابل للاتصال يخصّه أو يخصّ من يستلم عنه. ولا يُقبل رقم غير قابل للطلب، ويُعدّ الرقم المسجل على الطلب هو الرقم المعتمد.

### 10.2 عنوان صحيح ومحافظة صحيحة
يلتزم الزبون بعنوان دقيق يشمل المحافظة والمنطقة وأقرب نقطة دالّة. والمحافظة تُختار من القائمة المعتمدة لأن التوزيع يُبنى عليها، والعنوان الناقص أو الخاطئ يجعل كلفة التسليم الفاشل على الزبون.

### 10.3 الحضور أو تفويض مستلم
يلتزم الزبون بأن يكون حاضراً في العنوان في وقت التسليم أو أن يفوّض من يستلم عنه. وغياب الطرفين تسليم فاشل.

### 10.4 الرد على شركة التوصيل
يلتزم الزبون بالرد على اتصال شركة التوصيل وبالتنسيق معها. وعدم الرد المتكرر يُعامل معاملة تعذر التسليم.

### 10.5 تهيئة المبلغ أو الرصيد
في الدفع عند الاستلام يلتزم الزبون بتهيئة المبلغ المستحق كاملاً عند الباب. وفي الطلب المدفوع مسبقاً أو المستلزم مقدمة يلتزم بتوفير الرصيد في المحفظة قبل إتمام الطلب.

### 10.6 تحديث البيانات قبل الشحن
كل تعديل على العنوان أو الهاتف يجب أن يصل الدعم قبل تسليم الطرد إلى شركة التوصيل. وما بعد ذلك يخضع للمادة 7.6.

### 10.7 التعامل مع المندوب
يلتزم الزبون بالتعامل اللائق مع مندوب التوصيل. ولا يُطلب من المندوب فتح الطرد لتجربة التشغيل، ولا الانتظار لفحص يتجاوز {{DOOR_INSPECTION_MINUTES}} دقيقة، ولا تحصيل مبلغ مخالف لما على الفاتورة.

### 10.8 الإبلاغ برقم الطلب
كل مراجعة أو شكوى تُقدَّم مقترنة برقم الطلب. والمتجر غير ملزم بالبحث عن طلب بلا رقم، ولا بمخاطبة من ليس صاحب الحساب.

### 10.9 أثر الإخلال بهذه الالتزامات
الإخلال بالتزامات هذا الفصل يجعل ما ترتب عليه من كلفة أو تأخير أو تلف على الزبون، ولا يُعدّ إخلالاً من المتجر بالتزاماته.

## 11. الاستلام من المخزن

### 11.1 متى يتاح
لا يتاح الاستلام من المخزن إلا إذا ظهر خياراً في شاشة الدفع لذلك الطلب. وموقعه {{LEVONIS_WAREHOUSE_ADDRESS}} وأوقاته {{LEVONIS_PICKUP_HOURS}}.

### 11.2 لا يتاح في طلبات مجتمع ليفو
الاستلام من المخزن غير متاح في طلبات تجار مجتمع ليفو، لأن المتجر لا يحتفظ ببضاعة التاجر ولا يسلّمها عنه.

### 11.3 التحقق من هوية المستلم
يُسلَّم الطلب في المخزن بعد التحقق من هوية المستلم ومن رقم الطلب. ولا يُسلَّم لغير صاحب الحساب إلا بتفويض منه.

### 11.4 مدة حفظ الطلب
يُحفظ الطلب الجاهز للاستلام مدة {{PICKUP_HOLD_DAYS}} يوماً من إشعار الجاهزية. وبعدها يجوز للمتجر إلغاء الطلب وإعادة ما دُفع منه وفق سياسة الدفع والمحفظة.

### 11.5 لا ضريبة دفع عند الاستلام على الاستلام من المخزن
لا تُفرض ضريبة الدفع عند الاستلام على الطلب المستلم من المخزن، لأنها مرتبطة بالتحصيل النقدي عبر التوصيل إلى عنوان.

## 12. إلغاء الزبون لطلبه

### 12.1 الإلغاء قبل التأكيد
للزبون إلغاء طلبه بنفسه ما دام في حالة الانتظار، أي قبل تأكيده من المتجر. وبعد التأكيد يكون الإلغاء عبر الدعم وفق حالة التجهيز والشحن.

### 12.2 ما يُعاد عند الإلغاء
عند الإلغاء تُعاد المبالغ المدفوعة من المحفظة إلى المحفظة، وتُعاد النقاط المستعملة نقاطاً لا نقداً، وتُلغى النقاط التي كانت ستُمنح عن الطلب.

### 12.3 ما لا يُلغى ذاتياً
لا يُلغى ذاتياً الطلب الذي كُشفت فيه قطعة من عروض المفاجأة، لأن السحب قد ظهر ولا يُعاد. ويُراجع في هذه الحالة عبر الدعم.

### 12.4 الإلغاء بعد التجهيز أو الشحن
الطلب الذي جُهّز أو شُحن أو خرج للتوصيل لا يُعامل معاملة الطلب الذي لم يُنفَّذ. وتُطبَّق عليه أحكام الرفض عند الباب والإرجاع بحسب حالته.

### 12.5 إلغاء المتجر للطلب
يجوز للمتجر إلغاء الطلب وفق الأسباب والإجراءات المبينة في سياسة الأسعار وتغييرها وإلغاء الطلب، ويُعاد للزبون ما دفعه وفق تلك السياسة.

## 13. أحكام ختامية

### 13.1 تعديل هذه السياسة
للمتجر تعديل هذه السياسة بإصدار نسخة جديدة برقم وتاريخ نفاذ. ولا يسري التعديل بأثر رجعي على طلب سابق.

### 13.2 حجية النسخة المسجلة
النسخة التي قبلها الزبون وقت الطلب هي النسخة الحاكمة لذلك الطلب، ويُحفظ قبولها بوقته وبصمته.

### 13.3 استقلال البنود
بطلان بند أو تعذر تنفيذه لا يمس باقي البنود، وتبقى الوثيقة نافذة فيما عداه.

### 13.4 حل النزاعات
يُقدَّم النزاع أولاً إلى الدعم مع رقم الطلب والمستندات، وتُبذل المحاولة الودية خلال {{DISPUTE_RESPONSE_DAYS}} يوماً قبل اللجوء إلى غير ذلك.

### 13.5 القانون الواجب التطبيق والاختصاص
يخضع تفسير هذه الوثيقة وتنفيذها ل{{GOVERNING_LAW_JURISDICTION}}، ويكون الاختصاص ل{{COMPETENT_COURT}}.

### 13.6 جهة الاتصال
جهة الاتصال المعتمدة للشكاوى والمراجعات هي {{LEVONIS_SUPPORT_CONTACT}}، وأوقات العمل {{LEVONIS_SUPPORT_HOURS}}.`,

    en: `## 1. Preamble and Definitions

### 1.1 Purpose of this document
This document sets out the terms on which a customer buys from LEVONIS: who may buy, how an order is formed, when it becomes binding on both parties, what the quoted price covers, and what the customer must do at delivery. It is a contractual document, read together with the store's other policies and not in place of them.

### 1.2 The parties
The first party is the Store: {{LEVONIS_LEGAL_NAME}}, registered under number {{LEVONIS_REGISTRATION_NO}}, with its address at {{LEVONIS_ADDRESS}}. The second party is the Customer: the holder of the account from which the order was sent.

### 1.3 Definitions
- The Store or LEVONIS: the official store, which sells its own goods and ships them from its own warehouse.
- The Levo community: the space in which independent merchants offer their goods inside the platform.
- The Merchant: an independent seller holding a store inside the Levo community, who is the seller on their own orders, not LEVONIS.
- The Order: the order recorded in the system under its number, with its lines, prices, address and payment method.
- Direct Sale: the sale of an item actually held by the Store at the time of the order.
- Pre-order: the purchase of an item brought in after the order by air, sea or land freight.
- The Wallet: the customer's balance inside the platform, governed by the Payment and Wallet Policy.
- The Delivery Company: the company that carries the parcel and sets its fee and its tax.
- The Quote: the calculation the system displays before the order is placed, with all of its lines.

### 1.4 Scope
This policy applies to every order created through the platform, whether its seller is LEVONIS or a merchant in the Levo community, and to every payment and delivery method, except where an express article provides otherwise.

### 1.5 Relationship to the other documents
This policy is read with the Selling Policy, the Payment and Wallet Policy, the Pricing, Price Changes and Order Cancellation Policy, the Delivery Policy, the Warranty Policy and the Returns and Replacement Policy. Where they appear to conflict, the more specific article prevails over the more general one, and the document dedicated to a subject prevails over an incidental mention of it elsewhere.

### 1.6 Authoritative language
The Arabic text is the authoritative text. The English and Kurdish versions are faithful translations of it carrying the same numbering, and any difference in meaning is resolved by reference to the Arabic.

### 1.7 Version and effective date
This document carries a version number and an effective date at its head. Every order is governed by the version in force at the moment it was created, and the customer's acceptance of that version is recorded with the order.

### 1.8 No implied waiver
The Store's failure to enforce a right in one instance is not a waiver of that right and does not prevent it from being enforced in another.

## 2. Eligibility to Buy and the Customer Account

### 2.1 An account is required
No order is created without a registered and signed-in account. The cart, the quote, the order and the wallet are all bound to the account, and the system accepts no order from an unregistered visitor.

### 2.2 Legal capacity and age
The customer must have full legal capacity to contract. A person under {{MIN_PURCHASE_AGE_YEARS}} years of age may buy only through a guardian or legal representative, and the account holder bears responsibility for every order placed from the account.

### 2.3 Accuracy of account data
The customer undertakes that their name, telephone number, email and addresses are correct and usable. False or impersonated data is sufficient ground to refuse or suspend an order.

### 2.4 One account per person
Each person holds one account. Creating multiple accounts to obtain offers, points, referrals or membership benefits not due is a breach that forfeits the benefit and exposes all of the accounts to suspension.

### 2.5 Account security and orders issued from it
The customer is responsible for protecting their credentials and verification codes. Every order created from their account is treated as issued by them unless support was notified of a compromise before the order was executed, and support never asks for a password or a verification code in any circumstance.

### 2.6 Buying on behalf of an entity
A person buying in the name of a company or body confirms that they are authorised to do so. The Store deals solely with the account holder on everything concerning the order, and is not obliged to deal with any other party absent a written authorisation.

### 2.7 Restricting or suspending an account
The Store may restrict purchasing or suspend an account where a forged receipt, abuse of offers or points, repeated refusal of delivery, or abusive conduct towards staff or couriers is established, provided the reason is stated and the customer retains the right to object through support.

## 3. How an Order is Formed and When it Becomes Binding

### 3.1 The cart is not a reservation
Adding an item to the cart does not reserve it, does not fix its price and does not guarantee its availability. The item remains available to other customers until an order is actually created.

### 3.2 Pricing is computed by the server alone
Every price, fee and discount is computed on the server. Any price or total sent by the browser is disregarded entirely, and the binding figure is the one the system computes at the moment the order is created.

### 3.3 The quote before confirmation
Before the order is placed the system displays: the merchandise value, the transport commission or the direct-sale premium, the extended-warranty fee if selected, the delivery fee, the cash-on-delivery tax if any, discounts and points, the amount applied from the wallet, and the amount due on delivery. The quote is a momentary calculation, not a contract in itself.

### 3.4 Placing an order is the customer's offer
Placing an order is the customer's offer to buy on the price and terms displayed to them at that moment; it is not a final acceptance by the Store.

### 3.5 The order's state on creation
Every order is created in the pending state. In that state the Store has not yet accepted the sale, and quantity and availability remain subject to review.

### 3.6 When the contract is concluded
The contract is concluded when the Store confirms the order after verifying availability and the accuracy of the data. Before confirmation the Store may refuse the order or change its price under the Pricing, Price Changes and Order Cancellation Policy.

### 3.7 Payment at creation on prepaid orders
On an order paid from the wallet, the amount is debited at the moment the order is created, not at the moment of confirmation. If the Store cannot confirm the order, the amount is returned to the wallet in full under the Payment and Wallet Policy.

### 3.8 Double taps and the idempotency key
Every checkout carries a key that prevents duplication, so a double tap or a retry after a network interruption does not create two orders or two debits. A repeated submission under the same key returns the first order itself.

### 3.9 Policy acceptance recorded with the order
The customer's acceptance of the required policies is recorded in the same transaction in which the order is written, with the version, the number and the time. There is therefore no confirmed order without a recorded acceptance, and no recorded acceptance without an order.

### 3.10 The order snapshot and its evidential value
A fixed snapshot of the price, address, payment method and benefits as at the time of purchase is stored with the order. Later changes to settings or prices do not change an earlier order, and that snapshot is the reference in any dispute about what was agreed.

### 3.11 Arrangements made outside the platform
No order, price or promise agreed outside the platform and not recorded as an order within it is recognised. The Store is not bound by anything that has no order number.

## 4. Direct Sale and Pre-order

### 4.1 Definition of a direct sale
A direct sale is the sale of an item actually held by the Store at the time of the order, prepared and delivered through the short local route.

### 4.2 Definition of a pre-order
A pre-order is an instruction to the Store to bring in an item not held in the warehouse at the time of the order, from its source into Iraq and then to the customer. It is a promise to procure along a stated freight route, not a sale off the shelf.

### 4.3 The three freight routes
A pre-order travels by one of three routes: air, sea or land. Each route has its own indicative duration and its own commission; the route is chosen before the item is added to the cart and is fixed onto the order.

### 4.4 Durations are indicative
The durations displayed for each route are indicative and based on what is usual; they are not a guaranteed date. Exceeding them because of the supplier, the carrier or border procedures is not a breach giving rise to compensation.

### 4.5 Tracking stages
A direct sale passes through five stages: received, confirmed, preparing, out for delivery, delivered. A pre-order passes through fourteen stages, beginning with the supplier's preparation and the origin warehouse and ending with delivery. The order state shown in the account is the authoritative statement of where the order stands.

### 4.6 One shipping type per cart
A single cart does not combine two different shipping types, because each type has its own route, duration and tracking. Where the combination is attempted the system refuses the addition and offers to empty the cart and start with the new type.

### 4.7 One seller per cart
A single cart does not combine LEVONIS goods with a merchant's goods, nor two merchants. Where the combination is attempted the system refuses the addition until the cart is emptied, because each seller is separately responsible for their order, their delivery and their commission.

### 4.8 A pre-order is not converted into a direct sale
Choosing cash on delivery on a pre-order may change how the line is priced, but it does not change the nature of the order: it remains a pre-order with its route, its stages and its duration. The customer may not require immediate delivery on the ground that they chose to pay at the door.

### 4.9 Availability on a pre-order
The supplier may prove unable to secure the item or its specification after the order. In that case the customer is offered the available alternative, or to wait, or to cancel with a full return of what was paid.

### 4.10 The difference in pricing between the two routes
The price of a pre-order line carries the transport commission of the chosen route, and the price of a direct sale may carry the premium for immediate availability. The two are never combined on the same line.

## 5. Quantities and Limits

### 5.1 Quantity limits per line
The minimum quantity per line is one unit and the maximum is ninety-nine units. A product, a bundle or an offer may carry a lower limit, which is displayed when the item is added.

### 5.2 The ceiling on lines per order
Each order has a ceiling on the number of physical lines it can carry. Where it is exceeded the system refuses the order expressly and asks for it to be split into several orders, rather than executing an incomplete one.

### 5.3 Bundle and offer limits
A bundle carries a maximum quantity per order. A limited offer carries a per-customer limit and a global limit, and an order exceeding them is refused even if the offer is still displayed on screen.

### 5.4 Stock is re-checked when the order is placed
Availability and stock are re-verified at the moment the order is created, not at the moment the item was added to the cart. An item that sold out or was hidden in between stops the order rather than creating an obligation that cannot be met.

### 5.5 Limiting quantities suspected of resale
The Store may reduce the quantity or refuse the order entirely where there are indications of buying for resale, or of splitting one order across several accounts in order to exhaust a limited offer.

### 5.6 No quantity is reserved before the order exists
No quantity is reserved for a customer before their order is actually created. An item sitting in their cart does not prevent it being sold to someone else.

## 6. What the Quoted Price Includes and Excludes

### 6.1 Merchandise is separated from fees
The system always separates the merchandise value from the fees. Points and discounts are computed on the merchandise value alone, and never on the delivery fee, the transport commission or the warranty fee.

### 6.2 The transport commission on a pre-order
The price of a pre-order line includes the transport commission of the chosen route. It is part of the price of the service and not of the goods, and it is not refunded merely because the customer changed their mind after purchase.

### 6.3 The direct-sale premium
A direct-sale price may carry a premium for immediate availability. An active PRO member is exempt from that premium and from the transport commission under the terms of the membership.

### 6.4 The extended-warranty fee
If the customer selects an extension of a printer's warranty, its fee is added to the line price. The extension may not be bought after the order has been placed in any circumstance; the detail is in the Warranty Policy.

### 6.5 The delivery fee and its tax are set by the delivery companies
The delivery fee and the tax attached to it are set by the delivery companies, not by LEVONIS. The Store passes on what the carrier charges, adds nothing to it and does not control it, and any change in the carrier's tariff is reflected in what is displayed at the time of the order.

### 6.6 Delivery costs are on the customer
All delivery costs are on the customer. PRO and LEVO PREMIUM members above a stated order value are excepted, and there the Store carries them: the waiver for an active PRO member applies where the eligible merchandise value is strictly more than {{PRO_FREE_DELIVERY_MIN_IQD}} dinars, and covers ordinary delivery and protected packing. LEVO PREMIUM is waived the ordinary delivery fee alone where the value is strictly more than {{PRIME_FREE_DELIVERY_MIN_IQD}} dinars. The figure that governs a given order is the one displayed on that order's checkout screen, and the conditions are detailed in the Delivery Policy.

### 6.7 The cash-on-delivery tax
Where cash on delivery is chosen with delivery to an address, a tax is added at a stated amount for every complete block of the amount payable at the door. The amount of the tax and the size of the block may both be amended by the Store's administration, and the figure that governs a given order is the one displayed on that order's checkout screen. It is not charged on warehouse pickup nor on a prepaid order. Certain membership levels may be exempt from it, and the tax and the exemption are shown as two separate figures on the invoice.

### 6.8 The printer home-delivery advance
Home delivery of a printer requires an advance paid from the wallet before the order can be placed, in the amount displayed on the product page and at checkout, which at the effective date of this version is fifty thousand dinars. The advance is not required for warehouse pickup, and the order is refused if the balance does not cover it.

### 6.9 Protected packing
Protected packing is an optional service added on top of the ordinary tariff and does not replace it. It is offered only where its price has been set, and it is never charged to a customer who did not ask for it.

### 6.10 Points and coupons
One point equals exactly one dinar when spent, and points are applied to the merchandise value only. A coupon is subject to its own conditions, period and limits, and is not combined with a scheduled offer price on the same item unless expressly stated.

### 6.11 Currency and conversion
Prices are displayed in Iraqi dinars. The wallet balance is held in dollars and converted into dinars at the store's applicable exchange rate at the moment of the transaction, and that rate is fixed onto the order.

### 6.12 What the price excludes
The quoted price does not include: installation or commissioning of the product, training on it, consumables not named in the item's description, any fee imposed by a third party after delivery, or the cost of re-dispatch after a failed delivery attributable to the customer.

## 7. Order Confirmation and Notices

### 7.1 What confirmation means
Confirmation is the Store's declaration that it accepts the sale and is beginning preparation. Before it, the order is not accepted, whatever amounts or stages appear on screen.

### 7.2 Notification channels
Order notices are sent to the account and to the contact methods the customer registered. The non-arrival of a notice for a reason outside the Store does not invalidate the order or suspend its periods, and the reference is the order state shown in the account.

### 7.3 Where confirmation is not possible
Where the customer, their address or the genuineness of their order cannot be verified within {{ORDER_CONFIRMATION_WINDOW_HOURS}} hours of creation, the Store may cancel the order and return whatever was paid on it.

### 7.4 The invoice
An invoice is issued for the order detailing the merchandise value, the fees, the discounts, the amount paid and the amount outstanding. It is the governing document in any subsequent claim concerning amounts.

### 7.5 Order tracking
The customer is shown where their order stands on its stage path. The carrier's internal numbers are not shown to them, and a delay in moving between stages is not in itself a breach so long as the order is progressing.

### 7.6 Changing the address after confirmation
The delivery address is not changed after the parcel has been handed to the delivery company except with that company's agreement. Where the company accepts the change, the customer bears any difference in the fee.

## 8. Receipt and Inspection at the Door

### 8.1 Delivery time and the prior call
The delivery company calls the number recorded on the order before or at delivery. The customer undertakes that the number is working and reachable during ordinary delivery days.

### 8.2 Who may take delivery
The parcel is handed to the customer or to a person they authorise at the same address. Receipt by a person present at the address is a valid delivery with full effect, unless the Store was notified otherwise before delivery.

### 8.3 What must be checked at the door
Before signing or paying, the customer must verify: that the parcel matches their order number, that the outer carton is intact, that there is no opening or re-taping, that the number of pieces matches, that the model and colour match, that the accessories named are present, and that the serial number is intact where one exists.

### 8.4 A parcel arriving open or damaged
Where a parcel arrives open, torn or wet, or shows signs of impact or repacking, the customer must refuse it, or take it while recording a reservation with the courier and photographing it before opening it. Taking delivery without reservation where the damage was visible weakens any later claim for transit damage.

### 8.5 Damage in transit, at the border and at inspection points
The Store is not liable for damage occurring during transport. This includes damage occurring at the Kurdistan Region border or at any checkpoint where the parcel is opened and repacked by a party that is neither the Store nor the delivery company. A claim for such damage is directed to the carrier or to the authority that carried out the inspection, and the Store provides the documents it holds in support of that claim.

### 8.6 Documenting the condition
Photographing the parcel before opening it, and filming the opening in one continuous take, is recommended. The absence of documentation does not by itself forfeit a right, but it makes it harder for the customer to establish that the damage preceded receipt.

### 8.7 Acceptance under reservation
The customer may take the parcel and record a reservation as to its condition with the courier. Support is to be notified of this, with the order number and the photographs, within {{DAMAGE_REPORT_WINDOW_HOURS}} hours of receipt.

### 8.8 Partial delivery
Where part of an order is delivered, the customer must record that at the point of receipt. The undelivered part remains owed by the Store, and delivery of a part is not delivery of the whole.

### 8.9 Serial numbers and the start of warranty periods
Warranty and return periods run from the documented actual delivery of the item, not from the date of the order and not from the date of payment. The serial number of serialised devices is recorded with delivery.

### 8.10 The period for reporting a shortage or visible damage
A shortage, visible damage or a mismatched model must be reported within {{DAMAGE_REPORT_WINDOW_HOURS}} hours of delivery. A report after that period is examined according to the nature of the defect, and an objection is not accepted as to something visible that could have been seen at the door.

## 9. Refusal at the Door

### 9.1 The right to refuse and the accepted grounds
The customer may refuse delivery where an item different from the one ordered arrives, where the quantity is short, where the parcel is damaged or open, or where the amount demanded differs from the order's invoice.

### 9.2 Refusal on grounds other than the above
A refusal on grounds other than those in article 9.1 does not create any right to have the Store bear the transport costs. Articles 9.3 and 9.6 apply to it.

### 9.3 The cost of refusal
Where the refusal is for a reason not attributable to the Store, the customer bears the outbound and return charge claimed by the delivery company, and it is deducted from any amount returned to them if the order was paid.

### 9.4 Refusal on a cash-on-delivery order
On a cash-on-delivery order the parcel is returned to the Store and nothing is collected. The refusal is recorded on the account, and the return cost claimed by the delivery company remains due from the customer under article 9.3.

### 9.5 Refusal on a prepaid order
Where a prepaid order is refused for a reason not attributable to the Store, the amount is returned to the customer's wallet after deduction of the outbound and return charge and of any fee not recoverable from the delivery company.

### 9.6 Repeated refusal and its effect
Repeated refusal of delivery, or repeated failure of delivery, is sufficient ground to restrict later purchases to prepayment, or to refuse the account's orders, under the Selling Policy.

### 9.7 Where the customer cannot be reached
Where the delivery company cannot reach the customer after {{FAILED_DELIVERY_ATTEMPTS}} attempts, the parcel is returned to the Store, the order is treated as a refusal at the door, and article 9.3 applies to it.

## 10. The Customer's Obligations

### 10.1 A working and matching telephone number
The customer undertakes to register a correct, callable number belonging to them or to the person receiving on their behalf. A number that cannot be dialled is not accepted, and the number recorded on the order is the governing one.

### 10.2 A correct address and a correct governorate
The customer undertakes to give a precise address including the governorate, the area and the nearest landmark. The governorate is chosen from the approved list because dispatch is built on it, and an incomplete or wrong address places the cost of a failed delivery on the customer.

### 10.3 Being present or authorising a recipient
The customer undertakes to be present at the address at the time of delivery or to authorise someone to receive on their behalf. The absence of both is a failed delivery.

### 10.4 Answering the delivery company
The customer undertakes to answer the delivery company's call and to coordinate with it. Repeated failure to answer is treated as failure of delivery.

### 10.5 Having the amount or the balance ready
On cash on delivery the customer undertakes to have the full amount due ready at the door. On a prepaid order, or one requiring an advance, they undertake to have the balance in the wallet before the order is placed.

### 10.6 Updating details before dispatch
Any change of address or telephone must reach support before the parcel is handed to the delivery company. Thereafter article 7.6 applies.

### 10.7 Dealing with the courier
The customer undertakes to deal properly with the delivery courier. The courier is not to be asked to open the parcel for a functional test, to wait for an inspection exceeding {{DOOR_INSPECTION_MINUTES}} minutes, or to collect an amount differing from the invoice.

### 10.8 Quoting the order number
Every enquiry or complaint is submitted with the order number. The Store is not obliged to search for an order without a number, nor to deal with anyone other than the account holder.

### 10.9 The effect of breaching these obligations
Breach of the obligations in this chapter places the resulting cost, delay or damage on the customer, and is not a breach by the Store of its own obligations.

## 11. Warehouse Pickup

### 11.1 When it is available
Warehouse pickup is available only where it appears as an option on that order's checkout screen. Its location is {{LEVONIS_WAREHOUSE_ADDRESS}} and its hours are {{LEVONIS_PICKUP_HOURS}}.

### 11.2 Not available on Levo community orders
Warehouse pickup is not available on orders from Levo community merchants, because the Store neither holds the merchant's goods nor hands them over on their behalf.

### 11.3 Verifying the recipient
An order is handed over at the warehouse after verification of the recipient's identity and of the order number. It is not handed to anyone other than the account holder except on their authorisation.

### 11.4 How long an order is held
An order ready for pickup is held for {{PICKUP_HOLD_DAYS}} days from the readiness notice. Thereafter the Store may cancel the order and return whatever was paid on it under the Payment and Wallet Policy.

### 11.5 No cash-on-delivery tax on pickup
The cash-on-delivery tax is not charged on an order collected from the warehouse, because it attaches to cash collection through delivery to an address.

## 12. Cancellation by the Customer

### 12.1 Cancellation before confirmation
The customer may cancel their order themselves while it remains pending, that is, before the Store has confirmed it. After confirmation, cancellation is through support and depends on the state of preparation and dispatch.

### 12.2 What is returned on cancellation
On cancellation, amounts paid from the wallet are returned to the wallet, points that were spent are returned as points and not as cash, and the points that would have been earned on the order are cancelled.

### 12.3 What cannot be self-cancelled
An order in which an item from a mystery offer has been revealed cannot be self-cancelled, because the draw has been shown and is not undone. Such a case is reviewed through support.

### 12.4 Cancellation after preparation or dispatch
An order that has been prepared, dispatched or sent out for delivery is not treated as an order that was never executed. The provisions on refusal at the door and on returns apply to it according to its state.

### 12.5 Cancellation by the Store
The Store may cancel an order on the grounds and by the procedure set out in the Pricing, Price Changes and Order Cancellation Policy, and what the customer paid is returned under that policy.

## 13. Final Provisions

### 13.1 Amendment of this policy
The Store may amend this policy by issuing a new version with a number and an effective date. An amendment has no retroactive effect on an earlier order.

### 13.2 The evidential value of the recorded version
The version the customer accepted at the time of the order is the version governing that order, and its acceptance is stored with its time and its fingerprint.

### 13.3 Severability
The invalidity or unenforceability of one article does not affect the remaining articles, and the document remains in force as to the rest.

### 13.4 Dispute resolution
A dispute is first submitted to support with the order number and the documents, and an amicable resolution is attempted within {{DISPUTE_RESPONSE_DAYS}} days before any other recourse.

### 13.5 Governing law and jurisdiction
The interpretation and performance of this document are governed by {{GOVERNING_LAW_JURISDICTION}}, and {{COMPETENT_COURT}} have jurisdiction.

### 13.6 Contact
The approved contact point for complaints and enquiries is {{LEVONIS_SUPPORT_CONTACT}}, and the working hours are {{LEVONIS_SUPPORT_HOURS}}.`,

    ckb: `## 1. پێشەکی و پێناسەکان

### 1.1 مەبەستی ئەم بەڵگەنامەیە
ئەم بەڵگەنامەیە مەرجەکانی کڕین لە Levonis دیاری دەکات: کێ بۆی هەیە بکڕێت، داواکاری چۆن پێک دێت، کەی بۆ هەردوو لا بەندکەر دەبێت، نرخی پیشاندراو چی لەخۆ دەگرێت، و کڕیار لە کاتی وەرگرتندا چی لەسەرە. بەڵگەنامەیەکی گرێبەستییە و لەگەڵ سیاسەتەکانی دیکەی فرۆشگا دەخوێنرێتەوە، نەک لە جێگەی ئەوان.

### 1.2 لایەنەکان
لایەنی یەکەم فرۆشگایە: {{LEVONIS_LEGAL_NAME}}، تۆمارکراو بە ژمارە {{LEVONIS_REGISTRATION_NO}}، ناونیشانی {{LEVONIS_ADDRESS}}. لایەنی دووەم کڕیارە: خاوەنی ئەو هەژمارەی داواکاری لێوە نێردراوە.

### 1.3 پێناسەکان
- فرۆشگا یان Levonis: فرۆشگا فەرمییەکە کە کاڵای خۆی دەفرۆشێت و لە کۆگای خۆیەوە دەینێرێت.
- کۆمەڵگای لیڤۆ: ئەو بۆشاییەی بازرگانە سەربەخۆکان کاڵای خۆیانی تێدا پیشان دەدەن لە ناو پلاتفۆرمەکە.
- بازرگان: فرۆشیارێکی سەربەخۆ کە فرۆشگایەکی هەیە لە ناو کۆمەڵگای لیڤۆ، و لە داواکارییەکانی خۆیدا ئەو فرۆشیارە نەک Levonis.
- داواکاری: ئەو داواکارییەی بە ژمارەی خۆیەوە لە سیستەمدا تۆمار کراوە، بە هەموو دێڕ و نرخ و ناونیشان و شێوازی پارەدانییەوە.
- فرۆشتنی ڕاستەوخۆ: فرۆشتنی کاڵایەک کە لە کاتی داواکاریدا بە ڕاستی لای فرۆشگا بەردەستە.
- داواکاری پێشوەخت: کڕینی کاڵایەک کە دوای داواکاری بە بارهەڵگری ئاسمانی یان دەریایی یان وشکانی دەهێنرێت.
- جزدان: باڵانسی کڕیار لە ناو پلاتفۆرمەکە، بەپێی سیاسەتی پارەدان و جزدان.
- کۆمپانیای گەیاندن: ئەو کۆمپانیایەی پاکەتەکە دەگوازێتەوە و کرێ و باجەکەی دیاری دەکات.
- نرخاندن: ئەو حسابەی سیستەم پێش تەواوکردنی داواکاری پیشانی دەدات، بە هەموو بڕگەکانییەوە.

### 1.4 بواری جێبەجێکردن
ئەم سیاسەتە بۆ هەموو داواکارییەک جێبەجێ دەبێت کە لە ڕێگەی پلاتفۆرمەوە دروست دەبێت، جا فرۆشیارەکەی Levonis بێت یان بازرگانێک لە کۆمەڵگای لیڤۆ، و بۆ هەموو شێوازێکی پارەدان و گەیاندن، مەگەر بڕگەیەکی ڕوون پێچەوانەی بڵێت.

### 1.5 پەیوەندی ئەم بەڵگەنامەیە بە بەڵگەنامەکانی دیکەوە
ئەم سیاسەتە لەگەڵ سیاسەتی فرۆشتن، سیاسەتی پارەدان و جزدان، سیاسەتی نرخ و گۆڕانی نرخ و هەڵوەشاندنەوەی داواکاری، سیاسەتی گەیاندن، سیاسەتی گەرەنتی، و سیاسەتی گەڕاندنەوە و ئاڵوگۆڕ دەخوێنرێتەوە. لە کاتی ناکۆکی ڕواڵەتیدا، بڕگە تایبەتییەکە پێش بڕگە گشتییەکە دەخرێت، و ئەو بەڵگەنامەیەی تایبەتە بە بابەتەکە پێش ئاماژەیەکی لاوەکی لە شوێنێکی دیکە دەخرێت.

### 1.6 زمانی پەسەندکراو
دەقی عەرەبی دەقی پەسەندکراوە. وەشانی ئینگلیزی و کوردی وەرگێڕانی دڵسۆزی ئەون و هەمان ژمارەگوزاری هەڵدەگرن، و لە کاتی هەر جیاوازییەکی واتادا دەگەڕێینەوە بۆ دەقی عەرەبی.

### 1.7 وەشان و بەرواری جێبەجێبوون
ئەم بەڵگەنامەیە ژمارەی وەشان و بەرواری جێبەجێبوونی لە سەرەوەیدا هەیە. هەر داواکارییەک بەو وەشانەوە بەندە کە لە ساتی دروستبوونیدا کاری پێدەکرا، و ڕەزامەندی کڕیار لەگەڵ داواکارییەکەدا تۆمار دەکرێت.

### 1.8 وازهێنانی ناڕاستەوخۆ نییە
ئەوەی فرۆشگا لە بارێکدا داوای مافێکی خۆی نەکات، وازهێنان لەو مافە نییە و ڕێگری لێ ناکات لە بارێکی دیکەدا داوای بکات.

## 2. شایستەیی کڕین و هەژماری کڕیار

### 2.1 پێویستی هەژمار
هیچ داواکارییەک بەبێ هەژمارێکی تۆمارکراو و چوونەژوورەوە دروست نابێت. سەبەتە و نرخاندن و داواکاری و جزدان هەموویان بە هەژمارەوە بەستراون، و سیستەم داواکاری لە سەردانیکەرێکی تۆمارنەکراو وەرناگرێت.

### 2.2 توانای یاسایی و تەمەن
پێویستە کڕیار توانای یاسایی تەواوی گرێبەستکردنی هەبێت. ئەوەی تەمەنی لە {{MIN_PURCHASE_AGE_YEARS}} ساڵ کەمترە تەنها لە ڕێگەی سەرپەرشتیار یان نوێنەری یاساییەوە دەکڕێت، و خاوەنی هەژمار بەرپرسیارە لە هەموو داواکارییەک کە لە هەژمارەکەیەوە نێردراوە.

### 2.3 ڕاستی زانیاری هەژمار
کڕیار پابەندە بەوەی ناو و ژمارەی مۆبایل و ئیمەیل و ناونیشانەکانی ڕاست و بەکارهێنراو بن. زانیاری هەڵە یان ناوی کەسی تر بەسە بۆ ڕەتکردنەوە یان ڕاگرتنی داواکاری.

### 2.4 یەک هەژمار بۆ هەر کەسێک
بۆ هەر کەسێک یەک هەژمار. دروستکردنی چەند هەژمارێک بۆ بەدەستهێنانی ئۆفەر یان خاڵ یان ناردن یان سوودی ئەندامێتی بەبێ شایستەیی، پێشێلکارییە و سوودەکە دەڕوخێنێت و هەموو هەژمارەکان ڕووبەڕووی ڕاگرتن دەکاتەوە.

### 2.5 پاراستنی هەژمار و بەرپرسیاریەتی ئەو داواکارییانەی لێیەوە دەردەچن
کڕیار بەرپرسیارە لە پاراستنی زانیاری چوونەژوورەوە و کۆدەکانی پشتڕاستکردنەوە. هەر داواکارییەک لە هەژمارەکەیەوە دروست بێت وەک ئەوە دادەنرێت لەو دەرچووە، مەگەر پێش جێبەجێکردنی داواکارییەکە پشتیوانی لە دەستدرێژی ئاگادار کرابێتەوە، و پشتیوانی لە هیچ حاڵەتێکدا داوای وشەی نهێنی یان کۆدی پشتڕاستکردنەوە ناکات.

### 2.6 کڕین بە ناوی دەزگایەکەوە
ئەوەی بە ناوی کۆمپانیا یان لایەنێکەوە دەکڕێت دان بەوەدا دەنێت کە ڕێپێدراوە. فرۆشگا تەنها لەگەڵ خاوەنی هەژماردا قسە دەکات سەبارەت بە داواکارییەکە، و پابەند نییە بە قسەکردن لەگەڵ لایەنێکی دیکە بەبێ ڕێپێدانێکی نووسراو.

### 2.7 سنووردارکردن یان ڕاگرتنی هەژمار
فرۆشگا دەتوانێت کڕین سنووردار بکات یان هەژمار ڕابگرێت کاتێک ساختەکردنی وەسڵ، یان خراپبەکارهێنانی ئۆفەر و خاڵ، یان دووبارەبوونەوەی ڕەتکردنەوەی وەرگرتن، یان ڕەفتاری ناشیرین بەرامبەر کارمەندان و گەیەنەران دەسەلمێنرێت، بەمەرجێک هۆکارەکە ڕوون بکرێتەوە و مافی ناڕەزایی بۆ کڕیار بمێنێتەوە لە ڕێگەی پشتیوانییەوە.

## 3. داواکاری چۆن پێک دێت و کەی بەندکەر دەبێت

### 3.1 سەبەتە حیجز نییە
زیادکردنی کاڵایەک بۆ سەبەتە نە حیجزی دەکات، نە نرخی جێگیر دەکات، نە بەردەستبوونی دەستەبەر دەکات. کاڵاکە بۆ کڕیارانی دیکە بەردەست دەمێنێتەوە هەتا ئەو ساتەی داواکاری بە ڕاستی دروست دەبێت.

### 3.2 نرخاندن تەنها لەلایەن ڕاژەکارەوە
هەموو نرخ و کرێ و داشکاندنێک لەسەر ڕاژەکار حساب دەکرێت. هەر نرخ یان کۆیەک وێبگەڕ بینێرێت بە تەواوی پشتگوێ دەخرێت، و ژمارەی پەسەندکراو ئەوەیە سیستەم لە ساتی دروستبوونی داواکاریدا حسابی دەکات.

### 3.3 نرخاندن پێش پشتڕاستکردنەوە
پێش تەواوکردنی داواکاری سیستەم ئەمانە پیشان دەدات: بەهای کاڵا، کۆمیسیۆنی گواستنەوە یان زیادەی فرۆشتنی ڕاستەوخۆ، کرێی گەرەنتی درێژکراوە ئەگەر هەڵبژێردرا، کرێی گەیاندن، باجی پارەدان لە کاتی وەرگرتن ئەگەر هەبوو، داشکاندن و خاڵەکان، ئەو بڕەی لە جزدانەوە دەبڕدرێت، و ئەو بڕەی لە کاتی گەیاندندا دەدرێت. نرخاندن حسابێکی ساتەوەختییە نەک گرێبەست بە خۆی.

### 3.4 ناردنی داواکاری پێشنیاری کڕیارە
ناردنی داواکاری پێشنیاری کڕیارە بۆ کڕین بەپێی ئەو نرخ و مەرجانەی لەو ساتەدا پیشانی دراون، نەک وەرگرتنی کۆتایی لەلایەن فرۆشگاوە.

### 3.5 دۆخی داواکاری لە کاتی دروستبوون
هەر داواکارییەک بە دۆخی چاوەڕوانی دروست دەبێت. لەو دۆخەدا فرۆشگا هێشتا فرۆشتنەکەی وەرنەگرتووە، و بڕ و بەردەستبوون لەژێر پێداچوونەوەدا دەمێننەوە.

### 3.6 کەی گرێبەست دەبەسترێت
گرێبەست بە پشتڕاستکردنەوەی داواکاری لەلایەن فرۆشگاوە دەبەسترێت، دوای دڵنیابوون لە بەردەستبوون و ڕاستی زانیارییەکان. پێش پشتڕاستکردنەوە فرۆشگا دەتوانێت داواکارییەکە ڕەت بکاتەوە یان نرخەکەی بگۆڕێت بەپێی سیاسەتی نرخ و گۆڕانی نرخ و هەڵوەشاندنەوەی داواکاری.

### 3.7 پارەدان لە کاتی دروستبووندا لە داواکارییە پێشەکی دراوەکاندا
لە داواکارییەکی لە جزدانەوە دراودا، بڕەکە لە ساتی دروستبوونی داواکاریدا دەبڕدرێت نەک لە ساتی پشتڕاستکردنەوەدا. ئەگەر فرۆشگا نەیتوانی داواکارییەکە پشتڕاست بکاتەوە، بڕەکە بە تەواوی دەگەڕێتەوە بۆ جزدان بەپێی سیاسەتی پارەدان و جزدان.

### 3.8 کرتەی دووجارە و کلیلی نەدووبارەبوونەوە
هەر تەواوکردنێکی داواکاری کلیلێک هەڵدەگرێت بۆ ڕێگریکردن لە دووبارەبوونەوە، بۆیە کرتەی دووجارە یان هەوڵدانەوە دوای پچڕانی ئینتەرنێت دوو داواکاری و دوو بڕین دروست ناکات. ئەگەر بە هەمان کلیل دووبارە نێردرا، سیستەم هەمان داواکاری یەکەم دەگەڕێنێتەوە.

### 3.9 وەرگرتنی سیاسەتەکان کە لەگەڵ داواکاریدا تۆمار دەکرێت
وەرگرتنی کڕیار بۆ سیاسەتە داواکراوەکان لە هەمان ئەو مامەڵەیەدا تۆمار دەکرێت کە داواکارییەکەی تێدا دەنووسرێت، بە وەشان و ژمارە و کاتەوە. بۆیە هیچ داواکارییەکی پشتڕاستکراو بەبێ وەرگرتنی تۆمارکراو نییە، و هیچ وەرگرتنێکی تۆمارکراو بەبێ داواکاری نییە.

### 3.10 وێنەگرتنی داواکاری و بەهای بەڵگەیی
وێنەیەکی جێگیر لە نرخ و ناونیشان و شێوازی پارەدان و سوودەکان وەک لە کاتی کڕیندا بوون لەگەڵ داواکارییەکەدا هەڵدەگیرێت. گۆڕانی ڕێکخستن یان نرخەکان لە دواتردا داواکارییەکی پێشووتر ناگۆڕێت، و ئەم وێنەیە سەرچاوەیە لە هەر ناکۆکییەک لەسەر ئەوەی چی ڕێککەوتی لەسەر کراوە.

### 3.11 ڕێککەوتنی دەرەوەی پلاتفۆرم
هیچ داواکاری یان نرخ یان بەڵێنێک کە لە دەرەوەی پلاتفۆرم ڕێککەوتی لەسەر کراوە و وەک داواکارییەک تێیدا تۆمار نەکراوە، دان پێدا نانرێت. فرۆشگا پابەند نییە بەوەی ژمارەی داواکاری نییە.

## 4. فرۆشتنی ڕاستەوخۆ و داواکاری پێشوەخت

### 4.1 پێناسەی فرۆشتنی ڕاستەوخۆ
فرۆشتنی ڕاستەوخۆ فرۆشتنی کاڵایەکە کە لە کاتی داواکاریدا بە ڕاستی لای فرۆشگا بەردەستە، ئامادە دەکرێت و لە ڕێڕەوی ناوخۆیی کورتدا دەگەیەنرێت.

### 4.2 پێناسەی داواکاری پێشوەخت
داواکاری پێشوەخت ڕاسپاردەیە بە فرۆشگا بۆ هێنانی کاڵایەک کە لە کاتی داواکاریدا لە کۆگادا نییە، لە سەرچاوەکەیەوە بۆ عێراق و پاشان بۆ کڕیار. بەڵێنی هێنانە بەپێی ڕێڕەوێکی دیاریکراوی بارهەڵگرتن، نەک فرۆشتن لە سەر ڕەفە.

### 4.3 سێ ڕێڕەوی بارهەڵگرتن
داواکاری پێشوەخت بە یەکێک لە سێ ڕێڕەودا دەڕوات: ئاسمانی، دەریایی، وشکانی. هەر ڕێڕەوێک ماوەی خەمڵێنراو و کۆمیسیۆنی خۆی هەیە، و ڕێڕەوەکە پێش زیادکردنی کاڵاکە بۆ سەبەتە هەڵدەبژێردرێت و لەسەر داواکارییەکە جێگیر دەکرێت.

### 4.4 ماوەکان خەمڵێنراون
ئەو ماوانەی بۆ هەر ڕێڕەوێک پیشان دەدرێن خەمڵێنراون و لەسەر بنەمای ئاسایی داڕێژراون، بەڵێنی بەروارێکی دەستەبەرکراو نین. تێپەڕاندنیان بەهۆی دابینکەر یان گواستنەوە یان ڕێکارەکانی سنوورەوە پێشێلکارییەک نییە کە قەرەبوو بخوازێت.

### 4.5 قۆناغەکانی بەدواداچوون
فرۆشتنی ڕاستەوخۆ بە پێنج قۆناغدا تێدەپەڕێت: وەرگیرا، پشتڕاست کرایەوە، لە ئامادەکاریدا، بۆ گەیاندن دەرچوو، گەیەنرا. داواکاری پێشوەخت بە چواردە قۆناغدا تێدەپەڕێت کە لە ئامادەکاری دابینکەر و کۆگای سەرچاوەوە دەست پێدەکات و بە گەیاندن کۆتایی دێت. ئەو دۆخەی لە هەژماردا پیشان دەدرێت بەڵگەی پەسەندکراوە بۆ شوێنی داواکارییەکە.

### 4.6 یەک جۆری گەیاندن بۆ هەر سەبەتەیەک
یەک سەبەتە دوو جۆری جیاوازی گەیاندن کۆناکاتەوە، چونکە هەر جۆرێک ڕێڕەو و ماوە و بەدواداچوونی خۆی هەیە. لە کاتی هەوڵدان بۆ تێکەڵکردن، سیستەم زیادکردنەکە ڕەت دەکاتەوە و پێشنیاری بەتاڵکردنی سەبەتە و دەستپێکردن بە جۆرە نوێیەکە دەکات.

### 4.7 یەک فرۆشیار بۆ هەر سەبەتەیەک
یەک سەبەتە کاڵای Levonis و کاڵای بازرگانێک کۆناکاتەوە، نە دوو بازرگانیش. لە کاتی هەوڵدان بۆ تێکەڵکردن، سیستەم زیادکردنەکە ڕەت دەکاتەوە هەتا سەبەتەکە بەتاڵ دەکرێت، چونکە هەر فرۆشیارێک بە جیا بەرپرسیارە لە داواکاری و گەیاندن و کۆمیسیۆنی خۆی.

### 4.8 داواکاری پێشوەخت نابێتە فرۆشتنی ڕاستەوخۆ
هەڵبژاردنی پارەدان لە کاتی وەرگرتن لە داواکارییەکی پێشوەختدا لەوانەیە شێوازی نرخاندنی دێڕەکە بگۆڕێت، بەڵام سروشتی داواکارییەکە ناگۆڕێت: بە داواکارییەکی پێشوەخت دەمێنێتەوە بە ڕێڕەو و قۆناغ و ماوەکەیەوە. کڕیار ناتوانێت داوای گەیاندنی دەستبەجێ بکات لەبەر ئەوەی پارەدانی لە بەردەرگا هەڵبژاردووە.

### 4.9 بەردەستبوون لە داواکاری پێشوەختدا
لەوانەیە دابینکەر نەتوانێت کاڵاکە یان تایبەتمەندییەکەی دوای داواکاری دابین بکات. لەو حاڵەتەدا کڕیار نێوان جێگرەوەی بەردەست، یان چاوەڕوانی، یان هەڵوەشاندنەوەی داواکاری بە گەڕاندنەوەی تەواوی ئەوەی داویەتی، هەڵدەبژێرێت.

### 4.10 جیاوازی نرخاندن لە نێوان دوو ڕێڕەودا
نرخی دێڕی داواکاری پێشوەخت کۆمیسیۆنی گواستنەوەی ڕێڕەوی هەڵبژێردراو هەڵدەگرێت، و نرخی فرۆشتنی ڕاستەوخۆ لەوانەیە زیادەی بەردەستبوونی دەستبەجێ هەڵبگرێت. هەرگیز هەردووکیان لەسەر یەک دێڕ کۆناکرێنەوە.

## 5. بڕەکان و سنوورەکان

### 5.1 سنووری بڕ لە هەر دێڕێکدا
کەمترین بڕ بۆ هەر دێڕێک یەک دانەیە و زۆرترین نۆوەد و نۆ دانەیە. لەوانەیە بەرهەم یان پاکێج یان ئۆفەر سنوورێکی کەمتری هەبێت کە لە کاتی زیادکردندا پیشان دەدرێت.

### 5.2 سنووری دێڕەکان لە هەر داواکارییەکدا
هەر داواکارییەک سنوورێکی هەیە بۆ ژمارەی دێڕە ماددییەکانی کە هەڵیدەگرێت، و لە کاتی تێپەڕاندنیدا سیستەم داواکارییەکە بە ڕوونی ڕەت دەکاتەوە و داوای دابەشکردنی دەکات بۆ چەند داواکارییەک، لە جیاتی جێبەجێکردنی داواکارییەکی ناتەواو.

### 5.3 سنووری پاکێج و ئۆفەر
پاکێج زۆرترین بڕی هەیە بۆ هەر داواکارییەک. ئۆفەری سنووردار سنوورێکی هەیە بۆ هەر بەکارهێنەرێک و سنوورێکی گشتی، و ئەو داواکارییەی تێیان دەپەڕێنێت ڕەت دەکرێتەوە تەنانەت ئەگەر ئۆفەرەکە هێشتا لەسەر شاشە پیشان بدرێت.

### 5.4 پێداچوونەوەی کۆگا لە ساتی داواکاریدا
بەردەستبوون و کۆگا لە ساتی دروستبوونی داواکاریدا دووبارە پشکنین دەکرێن، نەک لە ساتی زیادکردن بۆ سەبەتە. ئەو کاڵایەی لە نێوانیاندا تەواو بووە یان شاردراوەتەوە داواکارییەکە ڕادەگرێت، لە جیاتی دروستکردنی پابەندییەک کە ناکرێت جێبەجێ بکرێت.

### 5.5 سنووردارکردنی بڕی گومانلێکراو بۆ فرۆشتنەوە
فرۆشگا دەتوانێت بڕەکە کەم بکاتەوە یان داواکارییەکە بە تەواوی ڕەت بکاتەوە کاتێک نیشانە هەبێت بۆ کڕین بە مەبەستی فرۆشتنەوە، یان دابەشکردنی یەک داواکاری بەسەر چەند هەژمارێکدا بۆ تەواوکردنی ئۆفەرێکی سنووردار.

### 5.6 پێش دروستبوونی داواکاری هیچ بڕێک حیجز ناکرێت
هیچ بڕێک بۆ کڕیارێک حیجز ناکرێت پێش ئەوەی داواکارییەکەی بە ڕاستی دروست بێت. بوونی کاڵاکە لە سەبەتەکەیدا ڕێگری لە فرۆشتنی بۆ کەسێکی تر ناکات.

## 6. نرخی پیشاندراو چی لەخۆ دەگرێت و چی لەخۆ ناگرێت

### 6.1 جیاکردنەوەی بەهای کاڵا لە کرێکان
سیستەم هەمیشە بەهای کاڵا لە کرێکان جیا دەکاتەوە. خاڵ و داشکاندن تەنها لەسەر بەهای کاڵا حساب دەکرێن، و هەرگیز لەسەر کرێی گەیاندن یان کۆمیسیۆنی گواستنەوە یان کرێی گەرەنتی نا.

### 6.2 کۆمیسیۆنی گواستنەوە لە داواکاری پێشوەختدا
نرخی دێڕی داواکاری پێشوەخت کۆمیسیۆنی گواستنەوەی ڕێڕەوی هەڵبژێردراو لەخۆ دەگرێت. بەشێکە لە نرخی خزمەتگوزارییەکە نەک لە نرخی کاڵاکە، و تەنها بەهۆی گۆڕانی بیری کڕیار دوای کڕین ناگەڕێتەوە.

### 6.3 زیادەی فرۆشتنی ڕاستەوخۆ
لەوانەیە نرخی فرۆشتنی ڕاستەوخۆ زیادەیەک هەڵبگرێت لە بەرامبەر بەردەستبوونی دەستبەجێ. ئەندامی PRO ی چالاک لەم زیادەیە و لە کۆمیسیۆنی گواستنەوە بەخشراوە بەپێی مەرجەکانی ئەندامێتی.

### 6.4 کرێی گەرەنتی درێژکراوە
ئەگەر کڕیار درێژکردنەوەی گەرەنتی چاپکەر هەڵبژارد، کرێیەکەی بۆ نرخی دێڕەکە زیاد دەکرێت. بە هیچ شێوەیەک ناکرێت درێژکردنەوەکە دوای دروستبوونی داواکاری بکڕدرێت، و وردەکارییەکەی لە سیاسەتی گەرەنتیدایە.

### 6.5 کرێی گەیاندن و باجەکەی لەلایەن کۆمپانیاکانی گەیاندنەوە دیاری دەکرێن
کرێی گەیاندن و ئەو باجەی پێوەی بەستراوە لەلایەن کۆمپانیاکانی گەیاندنەوە دیاری دەکرێن، نەک لەلایەن Levonisەوە. فرۆشگا ئەوە دەگوازێتەوە بۆ کڕیار کە کۆمپانیای گواستنەوە داوای دەکات، هیچی بۆ زیاد ناکات و کۆنترۆڵی ناکات، و هەر گۆڕانێک لە تەعریفەی کۆمپانیاکە ڕەنگدانەوەی دەبێت لەوەی لە کاتی داواکاریدا پیشان دەدرێت.

### 6.6 تێچووی گەیاندن لەسەر کڕیارە
هەموو تێچووەکانی گەیاندن لەسەر کڕیارن. ئەندامانی PRO و LEVO PREMIUM لە سەرووی بەهایەکی دیاریکراوی داواکاری لەمە دەردەچن، و لەوێدا فرۆشگا هەڵیدەگرێت: بەخشینەکە بۆ ئەندامی PRO ی چالاک کاتێک جێبەجێ دەبێت کە بەهای کاڵای شایستە بە تەواوی زیاتر بێت لە {{PRO_FREE_DELIVERY_MIN_IQD}} دینار، و گەیاندنی ئاسایی و پاکەتکردنی پارێزراو دەگرێتەوە. بەڵام LEVO PREMIUM تەنها لە کرێی گەیاندنی ئاسایی دەبەخشرێت کاتێک بەهاکە بە تەواوی زیاتر بێت لە {{PRIME_FREE_DELIVERY_MIN_IQD}} دینار. ئەو ژمارەیەی بۆ هەر داواکارییەک کاری پێدەکرێت ئەوەیە لە شاشەی پارەدانی ئەو داواکارییەدا پیشان دەدرێت، و مەرجەکان لە سیاسەتی گەیاندندا وردتر کراون.

### 6.7 باجی پارەدان لە کاتی وەرگرتن
لە کاتی هەڵبژاردنی پارەدان لە کاتی وەرگرتن لەگەڵ گەیاندن بۆ ناونیشانێک، باجێک بە بڕێکی دیاریکراو زیاد دەکرێت بۆ هەر بڕێکی تەواو لەو بڕەی لە بەردەرگا دەدرێت. هەردوو بڕەکە دەکرێت لەلایەن بەڕێوەبەرایەتیی فرۆشگاوە بگۆڕدرێن، و ئەو ژمارەیەی بۆ هەر داواکارییەک کاری پێدەکرێت ئەوەیە لە شاشەی پارەدانی ئەو داواکارییەدا پیشان دەدرێت. لەسەر وەرگرتن لە کۆگا و لەسەر داواکاری پێشەکی دراو زیاد ناکرێت. لەوانەیە هەندێک ئاستی ئەندامێتی لێی ببەخشرێن، و بڕی باج و بەخشین وەک دوو ژمارەی جیاواز لەسەر پسووڵەکە پیشان دەدرێن.

### 6.8 پێشەکی گەیاندنی چاپکەر بۆ ماڵ
گەیاندنی چاپکەر بۆ ناونیشانێک پێویستی بە پێشەکییەکە لە جزدانەوە پێش تەواوکردنی داواکاری، بەو بڕەی لەسەر پەڕەی بەرهەم و لە شاشەی پارەداندا پیشان دەدرێت، کە لە بەرواری جێبەجێبوونی ئەم وەشانەدا پەنجا هەزار دینارە. ئەم پێشەکییە بۆ وەرگرتن لە کۆگا داوا ناکرێت، و داواکارییەکە ڕەت دەکرێتەوە ئەگەر باڵانس داینەپۆشێت.

### 6.9 پاکەتکردنی پارێزراو
پاکەتکردنی پارێزراو خزمەتگوزارییەکی هەڵبژاردەییە کە لەسەر تەعریفەی ئاسایی زیاد دەکرێت و لە جێگەی ناگرێتەوە. تەنها کاتێک پیشان دەدرێت کە نرخەکەی دیاری کرابێت، و هەرگیز لەسەر ئەو کەسە زیاد ناکرێت کە داوای نەکردووە.

### 6.10 خاڵ و کوپۆن
یەک خاڵ لە کاتی بەکارهێناندا یەک دینارە، و تەنها لەسەر بەهای کاڵا بەکار دەهێنرێت. کوپۆن بەندە بە مەرج و ماوە و سنوورەکانی خۆیەوە، و لەگەڵ نرخی ئۆفەری خشتەکراو لەسەر هەمان کاڵا کۆ ناکرێتەوە مەگەر بە ڕوونی وترابێت.

### 6.11 دراو و گۆڕینەوە
نرخەکان بە دیناری عێراقی پیشان دەدرێن. باڵانسی جزدان بە دۆلار هەڵدەگیرێت و بە نرخی ئاڵوگۆڕی پەسەندکراوی فرۆشگا لە ساتی مامەڵەکەدا دەگۆڕدرێت بۆ دینار، و ئەم نرخە لەسەر داواکارییەکە جێگیر دەکرێت.

### 6.12 ئەوەی نرخەکە لەخۆی ناگرێت
نرخی پیشاندراو ئەمانە لەخۆ ناگرێت: دانان یان خستنەکاری بەرهەمەکە، ڕاهێنان لەسەری، ئەو پێداویستییە بەکارهاتووانەی لە وەسفی کاڵاکەدا ناونەبراون، هەر کرێیەک لەلایەن لایەنی سێیەمەوە دوای گەیاندن دابنرێت، و تێچووی ناردنەوە دوای گەیاندنێکی شکستخواردوو کە هۆکارەکەی دەگەڕێتەوە بۆ کڕیار.

## 7. پشتڕاستکردنەوەی داواکاری و ئاگادارکردنەوەکان

### 7.1 مانای پشتڕاستکردنەوە
پشتڕاستکردنەوە ڕاگەیاندنی فرۆشگایە بەوەی فرۆشتنەکە وەردەگرێت و دەست بە ئامادەکاری دەکات. پێش ئەوە داواکارییەکە وەرگیراو نییە، هەرچەندە بڕ و قۆناغیش لەسەر شاشە دەربکەون.

### 7.2 کەناڵەکانی ئاگادارکردنەوە
ئاگادارییەکانی داواکاری بۆ هەژمار و بۆ ئەو ڕێگا پەیوەندییانە دەنێردرێن کە کڕیار تۆماری کردوون. نەگەیشتنی ئاگادارییەک بەهۆکارێکی دەرەوەی فرۆشگا داواکارییەکە پووچ ناکاتەوە و ماوەکانی ڕاناگرێت، و سەرچاوە ئەو دۆخەیە کە لە هەژماردا پیشان دەدرێت.

### 7.3 کاتێک پشتڕاستکردنەوە نەکرێت
ئەگەر نەکرا کڕیار یان ناونیشانەکەی یان جدیبوونی داواکارییەکەی لە ماوەی {{ORDER_CONFIRMATION_WINDOW_HOURS}} کاتژمێردا لە دروستبوونییەوە پشکنین بکرێت، فرۆشگا دەتوانێت داواکارییەکە هەڵبوەشێنێتەوە و ئەوەی لەسەری دراوە بگەڕێنێتەوە.

### 7.4 پسووڵە
بۆ داواکارییەکە پسووڵەیەک دەردەچێت کە وردەکاری بەهای کاڵا و کرێکان و داشکاندن و دراو و ماوە هەڵدەگرێت. ئەمە بەڵگەی پەسەندکراوە لە هەر داواکارییەکی دواتردا کە پەیوەندی بە بڕەکانەوە هەیە.

### 7.5 بەدواداچوونی داواکاری
شوێنی داواکارییەکەی لەسەر ڕێڕەوی قۆناغەکانی بۆ کڕیار پیشان دەدرێت. ژمارە ناوخۆییەکانی کۆمپانیای گواستنەوە پیشانی نادرێن، و دواکەوتنی گواستنەوە لە نێوان قۆناغەکاندا بە خۆی پێشێلکاری نییە مادام داواکارییەکە بەڕێوەیە.

### 7.6 گۆڕینی ناونیشان دوای پشتڕاستکردنەوە
ناونیشانی گەیاندن دوای ڕادەستکردنی پاکەتەکە بە کۆمپانیای گەیاندن ناگۆڕدرێت مەگەر بە ڕەزامەندی ئەو کۆمپانیایە. ئەگەر کۆمپانیاکە گۆڕانەکە وەرگرت، کڕیار جیاوازی کرێیەکە هەڵدەگرێت ئەگەر هەبوو.

## 8. وەرگرتن و پشکنین لە بەردەرگا

### 8.1 کاتی گەیاندن و پەیوەندی پێشوەخت
کۆمپانیای گەیاندن پێش گەیاندن یان لە کاتیدا پەیوەندی بەو ژمارەیەوە دەکات کە لەسەر داواکارییەکە تۆمار کراوە. کڕیار پابەندە بەوەی ژمارەکە کار بکات و لە ڕۆژانی ئاسایی گەیاندندا بەردەست بێت.

### 8.2 کێ بۆی هەیە وەری بگرێت
پاکەتەکە بە کڕیار یان بەو کەسە دەدرێت کە لە هەمان ناونیشاندا ڕێی پێدەدات. وەرگرتن لەلایەن ئەو کەسەی لە ناونیشانەکەدایە گەیاندنێکی دروستە بە هەموو کاریگەرییەکانییەوە، مەگەر پێش گەیاندن فرۆشگا بە پێچەوانەوە ئاگادار کرابێتەوە.

### 8.3 ئەوەی پێویستە لە بەردەرگا پشکنین بکرێت
پێش واژۆ یان پارەدان، پێویستە کڕیار دڵنیا بێتەوە لە: گونجانی پاکەتەکە لەگەڵ ژمارەی داواکارییەکەی، ساغی کارتۆنی دەرەوە، نەبوونی کردنەوە یان دووبارە لکاندنەوە، گونجانی ژمارەی پارچەکان، گونجانی مۆدێل و ڕەنگ، بوونی ئەو پێداویستییانەی ناویان هاتووە، و ساغی ژمارەی زنجیرەیی لە شوێنی خۆیدا.

### 8.4 پاکەتی کراوە یان زیانلێکەوتوو
ئەگەر پاکەتەکە کراوە یان دڕاو یان تەڕ گەیشت، یان نیشانەی لێدان یان دووبارە پاکەتکردنی لەسەر بوو، پێویستە کڕیار ڕەتی بکاتەوە، یان وەری بگرێت لەگەڵ تۆمارکردنی تێبینی لای گەیەنەر و وێنەگرتنی پێش کردنەوەی. وەرگرتن بەبێ تێبینی لەگەڵ زیانێکی بەدیار، داواکاری دواتری زیانی گواستنەوە لاواز دەکات.

### 8.5 زیان لە کاتی گواستنەوە و لە سنوور و خاڵەکانی پشکنین
فرۆشگا بەرپرسیار نییە لەو زیانەی لە کاتی گواستنەوەدا ڕوو دەدات. ئەمە ئەو زیانەش دەگرێتەوە کە لە سنووری هەرێمی کوردستان یان لە هەر خاڵێکی پشکنیندا ڕوو دەدات کە پاکەتەکە لێی دەکرێتەوە و دووبارە پاکەت دەکرێتەوە لەلایەن لایەنێکەوە کە نە فرۆشگایە و نە کۆمپانیای گەیاندن. داواکاری ئەم زیانە ئاراستەی کۆمپانیای گواستنەوە یان ئەو لایەنە دەکرێت کە پشکنینەکەی ئەنجام داوە، و فرۆشگا ئەو بەڵگانەی لای هەیە بۆ پشتگیری داواکارییەکە پێشکەش دەکات.

### 8.6 تۆمارکردنی دۆخەکە بە وێنە
پێشنیار دەکرێت پاکەتەکە پێش کردنەوەی وێنە بگیرێت و کردنەوەکەی بە یەک ڤیدیۆی نەپچڕاو تۆمار بکرێت. نەبوونی تۆمارکردن بە خۆی مافێک نافەوتێنێت، بەڵام سەلماندنی ئەوەی زیانەکە پێش وەرگرتن بووە بۆ کڕیار قورستر دەکات.

### 8.7 وەرگرتن لەگەڵ تێبینی
کڕیار دەتوانێت پاکەتەکە وەربگرێت و تێبینی خۆی لەسەر دۆخەکەی لای گەیەنەر تۆمار بکات. پشتیوانی لە ماوەی {{DAMAGE_REPORT_WINDOW_HOURS}} کاتژمێردا لە وەرگرتنەوە، بە ژمارەی داواکاری و وێنەکانەوە، ئاگادار دەکرێتەوە.

### 8.8 گەیاندنی بەشەکی
ئەگەر بەشێک لە داواکارییەکە گەیەنرا، پێویستە کڕیار لە کاتی وەرگرتندا ئەوە تۆمار بکات. ئەو بەشەی نەگەیەنراوە لە ئەستۆی فرۆشگادا دەمێنێتەوە، و گەیاندنی بەشێک گەیاندنی هەمووی نییە.

### 8.9 ژمارە زنجیرەییەکان و دەستپێکردنی ماوەی گەرەنتی
ماوەی گەرەنتی و گەڕاندنەوە لە بەرواری گەیاندنی ڕاستەقینەی تۆمارکراوی کاڵاکەوە دەست پێدەکەن، نەک لە بەرواری داواکاری و نەک لە بەرواری پارەدان. ژمارەی زنجیرەیی ئامێرە زنجیرەییەکان لەگەڵ گەیاندندا تۆمار دەکرێت.

### 8.10 ماوەی ڕاگەیاندنی کەمی یان زیانی بەدیار
کەمی یان زیانی بەدیار یان مۆدێلی نەگونجاو دەبێت لە ماوەی {{DAMAGE_REPORT_WINDOW_HOURS}} کاتژمێردا لە گەیاندنەوە ڕابگەیەنرێت. ڕاگەیاندن دوای ئەم ماوەیە بەپێی سروشتی عەیبەکە لێکۆڵینەوەی لەگەڵ دەکرێت، و ناڕەزایی وەرناگیرێت لەسەر شتێکی بەدیار کە دەکرا لە بەردەرگا ببینرێت.

## 9. ڕەتکردنەوە لە بەردەرگا

### 9.1 مافی ڕەتکردنەوە و هۆکارە وەرگیراوەکان
کڕیار دەتوانێت وەرگرتن ڕەت بکاتەوە کاتێک کاڵایەکی جیاواز لەوەی داوای کردووە دەگات، یان بڕەکە کەمە، یان پاکەتەکە زیانی پێگەیشتووە یان کراوەیە، یان ئەو بڕەی داوا دەکرێت جیاوازە لەوەی لەسەر پسووڵەی داواکارییەکەیە.

### 9.2 ڕەتکردنەوە بە هۆکارێکی تر
ڕەتکردنەوە بە هۆکارێک جگە لەوانەی بڕگەی 9.1 هیچ مافێک دروست ناکات بۆ ئەوەی فرۆشگا تێچووی گواستنەوە هەڵبگرێت. بڕگەکانی 9.3 و 9.6 لەسەری جێبەجێ دەبن.

### 9.3 تێچووی ڕەتکردنەوە
کاتێک ڕەتکردنەوەکە بە هۆکارێک بێت کە بۆ فرۆشگا ناگەڕێتەوە، کڕیار کرێی چوون و هاتنەوە هەڵدەگرێت کە کۆمپانیای گەیاندن داوای دەکات، و لەو بڕە دەبڕدرێت کە بۆی دەگەڕێتەوە ئەگەر داواکارییەکە درابوو.

### 9.4 ڕەتکردنەوە لە داواکاری پارەدان لە کاتی وەرگرتن
لە داواکاری پارەدان لە کاتی وەرگرتندا پاکەتەکە بۆ فرۆشگا دەگەڕێتەوە و هیچ کۆ ناکرێتەوە. ڕەتکردنەوەکە لەسەر هەژمارەکە تۆمار دەکرێت، و ئەو تێچووی گەڕاندنەوەی کۆمپانیای گەیاندن داوای دەکات بەپێی بڕگەی 9.3 لەسەر کڕیار دەمێنێتەوە.

### 9.5 ڕەتکردنەوە لە داواکاری پێشەکی دراودا
ئەگەر داواکارییەکی پێشەکی دراو بە هۆکارێک ڕەت کرایەوە کە بۆ فرۆشگا ناگەڕێتەوە، بڕەکە بۆ جزدانی کڕیار دەگەڕێتەوە دوای بڕینی کرێی چوون و هاتنەوە و هەر کرێیەک کە لە کۆمپانیای گەیاندنەوە وەرناگیرێتەوە.

### 9.6 دووبارەبوونەوەی ڕەتکردنەوە و کاریگەرییەکەی
دووبارەبوونەوەی ڕەتکردنەوەی وەرگرتن، یان دووبارەبوونەوەی شکستی گەیاندن، بەسە بۆ ئەوەی کڕینی دواتر بە پارەدانی پێشەکی سنووردار بکرێت، یان داواکارییەکانی هەژمارەکە ڕەت بکرێنەوە، بەپێی سیاسەتی فرۆشتن.

### 9.7 کاتێک ناکرێت گەیشتن بە کڕیار
ئەگەر کۆمپانیای گەیاندن نەیتوانی دوای {{FAILED_DELIVERY_ATTEMPTS}} هەوڵ بگاتە کڕیار، پاکەتەکە بۆ فرۆشگا دەگەڕێتەوە، داواکارییەکە وەک ڕەتکردنەوە لە بەردەرگا مامەڵەی لەگەڵ دەکرێت، و بڕگەی 9.3 لەسەری جێبەجێ دەبێت.

## 10. ئەرکەکانی کڕیار

### 10.1 ژمارەی مۆبایلی کارا و گونجاو
کڕیار پابەندە بە تۆمارکردنی ژمارەیەکی ڕاست و پەیوەندیپێکراو کە هی خۆی بێت یان هی ئەو کەسە بێت کە لە جیاتی وەری دەگرێت. ژمارەیەک کە ناکرێت پەیوەندی پێوە بکرێت وەرناگیرێت، و ئەو ژمارەیەی لەسەر داواکارییەکەیە ژمارەی پەسەندکراوە.

### 10.2 ناونیشانی ڕاست و پارێزگای ڕاست
کڕیار پابەندە بە دانی ناونیشانێکی ورد کە پارێزگا و ناوچە و نزیکترین نیشانە لەخۆ بگرێت. پارێزگا لە لیستە پەسەندکراوەکە هەڵدەبژێردرێت چونکە دابەشکردن لەسەری بنیات دەنرێت، و ناونیشانی ناتەواو یان هەڵە تێچووی گەیاندنی شکستخواردوو دەخاتە سەر کڕیار.

### 10.3 ئامادەبوون یان ڕێپێدان بە وەرگرێک
کڕیار پابەندە بەوەی لە کاتی گەیاندندا لە ناونیشانەکەدا ئامادە بێت یان ڕێ بە کەسێک بدات لە جیاتی وەری بگرێت. نەبوونی هەردووکیان گەیاندنێکی شکستخواردووە.

### 10.4 وەڵامدانەوەی کۆمپانیای گەیاندن
کڕیار پابەندە بە وەڵامدانەوەی پەیوەندی کۆمپانیای گەیاندن و ڕێکخستن لەگەڵی. وەڵامنەدانەوەی دووبارە وەک شکستی گەیاندن مامەڵەی لەگەڵ دەکرێت.

### 10.5 ئامادەکردنی بڕەکە یان باڵانس
لە پارەدان لە کاتی وەرگرتندا کڕیار پابەندە بە ئامادەکردنی تەواوی ئەو بڕەی لە بەردەرگا دەدرێت. لە داواکاری پێشەکی دراو یان ئەوەی پێشەکی دەخوازێت، پابەندە بە دابینکردنی باڵانس لە جزداندا پێش تەواوکردنی داواکاری.

### 10.6 نوێکردنەوەی زانیاری پێش ناردن
هەر گۆڕانێک لە ناونیشان یان مۆبایل دەبێت پێش ڕادەستکردنی پاکەتەکە بە کۆمپانیای گەیاندن بگاتە پشتیوانی. دوای ئەوە بڕگەی 7.6 جێبەجێ دەبێت.

### 10.7 مامەڵەکردن لەگەڵ گەیەنەر
کڕیار پابەندە بە مامەڵەیەکی شیاو لەگەڵ گەیەنەری گەیاندن. داوا لە گەیەنەر ناکرێت پاکەتەکە بکاتەوە بۆ تاقیکردنەوەی کارکردن، یان چاوەڕوانی پشکنینێک بکات کە لە {{DOOR_INSPECTION_MINUTES}} خولەک تێدەپەڕێت، یان بڕێک کۆ بکاتەوە کە جیاوازە لەوەی لەسەر پسووڵەکەیە.

### 10.8 ڕاگەیاندن بە ژمارەی داواکاری
هەر پرسیار یان سکاڵایەک بە ژمارەی داواکارییەوە پێشکەش دەکرێت. فرۆشگا پابەند نییە بە گەڕان بەدوای داواکارییەک بەبێ ژمارە، و نە بە مامەڵەکردن لەگەڵ کەسێک جگە لە خاوەنی هەژمار.

### 10.9 کاریگەری پێشێلکردنی ئەم ئەرکانە
پێشێلکردنی ئەرکەکانی ئەم بەشە ئەو تێچوو یان دواکەوتن یان زیانەی لێی دەکەوێتەوە دەخاتە سەر کڕیار، و پێشێلکاری فرۆشگا نییە بۆ ئەرکەکانی خۆی.

## 11. وەرگرتن لە کۆگا

### 11.1 کەی بەردەستە
وەرگرتن لە کۆگا تەنها کاتێک بەردەستە کە وەک هەڵبژاردەیەک لە شاشەی پارەدانی ئەو داواکارییەدا دەربکەوێت. شوێنەکەی {{LEVONIS_WAREHOUSE_ADDRESS}} و کاتەکانی {{LEVONIS_PICKUP_HOURS}}.

### 11.2 لە داواکارییەکانی کۆمەڵگای لیڤۆدا بەردەست نییە
وەرگرتن لە کۆگا لە داواکارییەکانی بازرگانانی کۆمەڵگای لیڤۆدا بەردەست نییە، چونکە فرۆشگا نە کاڵای بازرگان هەڵدەگرێت و نە لە جیاتی ئەو ڕادەستی دەکات.

### 11.3 پشکنینی ناسنامەی وەرگر
داواکارییەکە لە کۆگادا دوای پشکنینی ناسنامەی وەرگر و ژمارەی داواکارییەکە ڕادەست دەکرێت. بۆ کەسێک جگە لە خاوەنی هەژمار ڕادەست ناکرێت مەگەر بە ڕێپێدانی ئەو.

### 11.4 ماوەی هەڵگرتنی داواکاری
داواکاری ئامادە بۆ وەرگرتن بۆ ماوەی {{PICKUP_HOLD_DAYS}} ڕۆژ لە ئاگاداری ئامادەبوونەوە هەڵدەگیرێت. دوای ئەوە فرۆشگا دەتوانێت داواکارییەکە هەڵبوەشێنێتەوە و ئەوەی لەسەری دراوە بگەڕێنێتەوە بەپێی سیاسەتی پارەدان و جزدان.

### 11.5 باجی پارەدان لە کاتی وەرگرتن لەسەر وەرگرتن لە کۆگا نییە
باجی پارەدان لە کاتی وەرگرتن لەسەر ئەو داواکارییە زیاد ناکرێت کە لە کۆگاوە وەردەگیرێت، چونکە بە کۆکردنەوەی نەقدی لە ڕێگەی گەیاندن بۆ ناونیشانەوە بەستراوە.

## 12. هەڵوەشاندنەوەی داواکاری لەلایەن کڕیارەوە

### 12.1 هەڵوەشاندنەوە پێش پشتڕاستکردنەوە
کڕیار دەتوانێت خۆی داواکارییەکەی هەڵبوەشێنێتەوە مادام لە دۆخی چاوەڕوانیدایە، واتە پێش پشتڕاستکردنەوەی لەلایەن فرۆشگاوە. دوای پشتڕاستکردنەوە، هەڵوەشاندنەوە لە ڕێگەی پشتیوانییەوەیە و بە دۆخی ئامادەکاری و ناردنەوە بەندە.

### 12.2 ئەوەی لە کاتی هەڵوەشاندنەوەدا دەگەڕێتەوە
لە کاتی هەڵوەشاندنەوەدا ئەو بڕانەی لە جزدانەوە دراون بۆ جزدان دەگەڕێنەوە، ئەو خاڵانەی بەکار هێنراون وەک خاڵ دەگەڕێنەوە نەک وەک نەقد، و ئەو خاڵانەی دەبوو لەسەر داواکارییەکە بدرێن هەڵدەوەشێنرێنەوە.

### 12.3 ئەوەی بە خۆکار هەڵناوەشێنرێتەوە
ئەو داواکارییەی کاڵایەکی ئۆفەری سەرسوڕهێنەری تێدا ئاشکرا کراوە بە خۆکار هەڵناوەشێنرێتەوە، چونکە ڕاکێشانەکە دەرکەوتووە و ناگەڕێتەوە. ئەم حاڵەتە لە ڕێگەی پشتیوانییەوە پێداچوونەوەی بۆ دەکرێت.

### 12.4 هەڵوەشاندنەوە دوای ئامادەکاری یان ناردن
ئەو داواکارییەی ئامادە کراوە یان نێردراوە یان بۆ گەیاندن دەرچووە وەک داواکارییەک مامەڵەی لەگەڵ ناکرێت کە هەرگیز جێبەجێ نەکراوە. حوکمەکانی ڕەتکردنەوە لە بەردەرگا و گەڕاندنەوە بەپێی دۆخەکەی لەسەری جێبەجێ دەبن.

### 12.5 هەڵوەشاندنەوەی فرۆشگا بۆ داواکاری
فرۆشگا دەتوانێت داواکارییەک هەڵبوەشێنێتەوە بەپێی ئەو هۆکار و ڕێکارانەی لە سیاسەتی نرخ و گۆڕانی نرخ و هەڵوەشاندنەوەی داواکاریدا هاتوون، و ئەوەی کڕیار داویەتی بەپێی ئەو سیاسەتە دەگەڕێتەوە.

## 13. حوکمە کۆتاییەکان

### 13.1 هەموارکردنی ئەم سیاسەتە
فرۆشگا دەتوانێت ئەم سیاسەتە هەموار بکات بە دەرکردنی وەشانێکی نوێ بە ژمارە و بەرواری جێبەجێبوونەوە. هەمواری هیچ کاریگەرییەکی دواوەی نییە لەسەر داواکارییەکی پێشوو.

### 13.2 بەهای بەڵگەیی وەشانی تۆمارکراو
ئەو وەشانەی کڕیار لە کاتی داواکاریدا وەریگرتووە وەشانی حوکمڕانە بۆ ئەو داواکارییە، و وەرگرتنەکەی بە کات و پەنجەمۆرەکەیەوە هەڵدەگیرێت.

### 13.3 سەربەخۆیی بڕگەکان
پووچبوونەوە یان نەتوانینی جێبەجێکردنی بڕگەیەک کاریگەری لەسەر بڕگەکانی دیکە نییە، و بەڵگەنامەکە لە پاشماوەکەیدا کاری پێدەکرێت.

### 13.4 چارەسەری ناکۆکی
ناکۆکی سەرەتا بە ژمارەی داواکاری و بەڵگەنامەکانەوە پێشکەشی پشتیوانی دەکرێت، و لە ماوەی {{DISPUTE_RESPONSE_DAYS}} ڕۆژدا هەوڵی چارەسەری دۆستانە دەدرێت پێش هەر ڕێگەیەکی دیکە.

### 13.5 یاسای جێبەجێکراو و دەسەڵاتی دادوەری
لێکدانەوە و جێبەجێکردنی ئەم بەڵگەنامەیە بەپێی {{GOVERNING_LAW_JURISDICTION}} دەبێت، و {{COMPETENT_COURT}} دەسەڵاتیان هەیە.

### 13.6 خاڵی پەیوەندی
خاڵی پەیوەندی پەسەندکراو بۆ سکاڵا و پرسیارەکان {{LEVONIS_SUPPORT_CONTACT}}ـە، و کاتی کارکردن {{LEVONIS_SUPPORT_HOURS}}ـە.`,
  },
};
