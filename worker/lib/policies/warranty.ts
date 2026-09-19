import type { PolicyDocument } from './types';

/**
 * THE PARTS WARRANTY — the owner's clause 5, written out.
 *
 * This is the document the shop has to stand behind when a customer arrives
 * with a dead printer in month eleven, so every sentence here is measured
 * against what worker/routes/devices.ts and worker/lib/deviceOps.ts actually
 * do. Nothing is promised that the code cannot perform:
 *
 *  - TWELVE MONTHS FROM DELIVERY, PER UNIT. `createUnitsOnDelivery` writes one
 *    row per physical unit with warranty_start_at = that unit's delivered_at,
 *    and `computeCoverage` adds the months to it. The document therefore says
 *    "the recorded delivery date of the unit", never "the date of purchase":
 *    those are different days in the data, and the difference is exactly what
 *    an argument in month thirteen is about.
 *  - REGISTRATION IS NOT THE CLOCK. deviceOps says so in its header and the
 *    routes honour it; article 5.2 repeats it because a customer who registers
 *    late will otherwise assume the opposite.
 *  - THE REMEDY IS THE PART. The owner's rule, and the claim workflow agrees:
 *    CLAIM_STAGES ends in repairing/replaced/resolved, and a whole-unit
 *    replacement is an admin act with its own route that CARRIES THE ORIGINAL
 *    END DATE (policy_version.carried = 'original_end'). Article 5.4 states
 *    that consequence rather than leaving it to be discovered.
 *  - THE EVIDENCE IS THE ONE THE ROUTE ASKS FOR: subject, a description of at
 *    least ten characters, and at most six private attachments (8 MB an image,
 *    40 MB a video) uploaded through POST /api/devices/claims/upload.
 *
 * Every figure the code does not hold — turnaround days, an inspection fee, a
 * service address — is a double-brace placeholder. A made-up number in a document the
 * owner shows a bank is worse than a blank.
 */
export const warranty: PolicyDocument = {
  key: 'warranty',
  version: 1,
  effective_at: '2026-01-01',
  title: {
    ar: 'ضمان القطع',
    en: 'Parts Warranty',
    ckb: 'گەرەنتی پارچەکان',
  },
  body: {
    ar: `## وثيقة الضمان — المادة 5

هذه الوثيقة تبيّن ضمان القطع الذي يمنحه متجر ليفونيس على الأجهزة التي يبيعها، وحدودَه وإجراءاته. النص العربي هو النص المعتمد، وما سواه ترجمة أمينة له بالترقيم نفسه. تقديم أي مطالبة ضمان يعني الاطلاع على هذه الوثيقة وقبول ما فيها.

### 5.1 التعريفات
- المتجر: {{LEVONIS_LEGAL_NAME}}، المشار إليه في هذه الوثيقة بـ ليفونيس.
- الزبون: الشخص الذي اشترى الجهاز من ليفونيس، أو الحساب الذي يحمل تسجيل الجهاز.
- الوحدة: الجهاز الفعلي الواحد، بسجله المستقل في نظام المتجر وبرقمه التسلسلي إن وُجد. الطلب الذي يحوي ثلاث طابعات هو ثلاث وحدات، لكل واحدة منها ضمانها ومدتها.
- القطعة: أي جزء داخل الوحدة قابل للفك أو الاستبدال على حدة.
- عيب التصنيع: خلل في المادة أو في التجميع أو في المكوّن نفسه، ظهر أثناء الاستعمال الطبيعي ووفق تعليمات المصنّع، ولم يكن سببه حدث خارجي ولا فعل من الزبون ولا طرف ثالث.
- تاريخ التسليم المسجل: التاريخ والوقت المسجلان في نظام المتجر لتسليم تلك الوحدة بعينها، وهو وحده ما تُحسب منه المدد.
- وصل الضمان: المستند الذي يصدره المتجر للوحدة ويحمل رقمًا بالصيغة WR ثم السنة ثم اليوم ثم التسلسل.
- المطالبة: الطلب المسجل في نظام المتجر على وحدة مسجلة في حساب الزبون.

### 5.2 مدة الضمان
مدة الضمان اثنا عشر شهرًا تقويميًا تبدأ من تاريخ التسليم المسجل للوحدة نفسها.

- لا تبدأ المدة من تاريخ الطلب، ولا من تاريخ الدفع، ولا من تاريخ الشحن، ولا من تاريخ فتح الصندوق.
- تُحسب المدة لكل وحدة على حدة. إذا سُلمت وحدات الطلب الواحد في تواريخ مختلفة فلكل وحدة تاريخ انتهاء مختلف.
- تسجيل الجهاز في حساب الزبون لا يبدأ المدة ولا يمددها ولا يعيدها من جديد. التسجيل وسيلة للوصول إلى خدمات المطالبة، لا حدثٌ يحرك الضمان.
- الأجهزة المستعملة أو المجددة أو المعروضة بوصف Open Box تحمل المدة المعلنة في صفحتها وفي وصلها، وهي شهر واحد أو اثنا عشر شهرًا حسب ما حدده المتجر لتلك الوحدة، ولا تقبل أي تمديد مدفوع.
- إذا اشترى الزبون تمديدًا للضمان قبل إتمام الطلب فالمدة الإجمالية هي أربعة وعشرون أو ستة وثلاثون شهرًا حسب التمديد المشترى، وتُطبَّق عليها هذه الوثيقة نفسها بحروفها، مع ما ورد في وثيقة تمديد الضمان.

### 5.3 ما يغطيه الضمان
يغطي الضمان القطع التي تعطلت بعيب تصنيعي، ولا يغطي شيئًا سواه.

- يشمل ذلك عطل مكوّن إلكتروني أو ميكانيكي تحت الاستعمال الطبيعي وضمن مواصفات المصنّع المعلنة.
- يشمل عيبًا ظاهرًا عند أول تشغيل، ويشمل عيبًا خفيًا ظهر لاحقًا داخل المدة.
- التغطية مشروطة بأن يكون الجهاز قد شُغّل ورُكّب واستُعمل وفق دليل المصنّع وتعليماته، وبمصدر طاقة مطابق لما نصّ عليه.
- عبء بيان أن العطل عيب تصنيعي يقع على الفحص الفني الذي يجريه المتجر أو من يفوضه، وقرار الفحص هو المرجع في تحديد سبب العطل.

### 5.4 ما يقدمه المتجر: إصلاح القطعة أو استبدالها
الضمان التزام بإصلاح القطعة المعيبة أو استبدالها، وليس التزامًا باستبدال الجهاز.

- لا يشمل الضمان بأي حال استبدال الطابعة كاملة بجهاز آخر، ولا استرجاع ثمنها، ولا تعويضًا نقديًا عن العطل.
- يختار المتجر بين إصلاح القطعة وبين استبدالها بقطعة جديدة أو بقطعة مكافئة سليمة، وفق ما يظهره الفحص وما يتوفر لدى المتجر.
- استبدال الوحدة كاملة إجراء استثنائي لا يقع إلا بقرار مكتوب من إدارة المتجر، وعند وقوعه فإن الوحدة البديلة تكمل تاريخ انتهاء ضمان الوحدة الأصلية ولا تبدأ مدة جديدة.
- القطعة المستبدلة المعيبة تصبح ملكًا للمتجر، ولا تُعاد إلى الزبون إلا بطلبه وقبل إتلافها.
- القطعة المركّبة بديلًا تبقى مشمولة إلى نهاية مدة ضمان الوحدة الأصلية، لا إلى تاريخ لاحق لها.

### 5.5 ما لا يغطيه الضمان
لا يشمل الضمان أيًا مما يأتي، ولا يُقبل فيه طلب إصلاح مجاني:

- سوء الاستعمال، والاستعمال خلافًا لدليل المصنّع، والتشغيل خارج المواصفات المعلنة للجهاز.
- الحوادث والسقوط والصدم والكسر والضغط والثني، وكل ضرر فيزيائي ظاهر.
- توصيل الجهاز بجهد كهربائي غير مطابق، أو باستعمال محوّل أو مصدر طاقة غير مطابق، أو نتيجة ارتفاع أو انقطاع في التيار.
- الماء والسوائل والرطوبة والغبار الكثيف والحرارة أو البرودة خارج حدود التشغيل المعلنة.
- التعديل غير المصرح به، وفتح الجهاز أو تفكيكه أو إصلاحه لدى جهة غير معتمدة من المتجر.
- تركيب قطع أو ملحقات أو مكوّنات من طرف ثالث، والأضرار الناتجة عنها، ولو كان الضرر في قطعة أخرى.
- المستهلكات وقطع التآكل بطبيعتها، ومنها على سبيل البيان لا الحصر: الفوّهات (النوزلات)، والسيور، ومنصات الطباعة وأسطحها، وأغشية FEP، وأحواض الراتنج، والرولمانات والمحامل، والمراوح بعد انقضاء عمرها التشغيلي المقرر من المصنّع، والكوابل، وأنابيب البودن، وأدوات التنظيف، والمواد الاستهلاكية مثل الفلمنت والراتنج.
- الاستهلاك الطبيعي، والخدوش والعلامات الشكلية التي لا تؤثر في عمل الجهاز، والاصفرار أو تغير اللون بمرور الوقت.
- المشكلات البرمجية وحدها: إعدادات التقطيع، وملفات النماذج، والفيرموير غير الرسمي، وتوافق البرامج، ما لم يثبت أنها ناتجة عن عيب في قطعة.
- الضرر الحاصل أثناء النقل أو عند نقطة تفتيش حدودية، وهو محكوم بالمادة 4 من وثيقة الاسترجاع ولا يُعالج كمطالبة ضمان.
- الأجهزة التي لم تُشترَ من ليفونيس، والأجهزة التي اشتُريت من تاجر مستقل داخل منصة ليفو برو والتي يتحمل ضمانها بائعها المعلن.
- انقطاع العمل والخسائر غير المباشرة، وفق المادة 5.18.

### 5.6 ما يُسقط الضمان
يسقط الضمان عن الوحدة كليًا في أي من الحالات الآتية، ولو كان العطل المطالب به عيب تصنيع:

- إزالة الرقم التسلسلي أو طمسه أو تغييره أو تعذّر قراءته.
- فتح الجهاز أو إصلاحه أو تعديله لدى جهة غير معتمدة من المتجر.
- كسر الأختام أو الملصقات الواقية حيث وُجدت.
- تقديم وحدة مختلفة عن الوحدة المشمولة، أو وصل ضمان لا يخص الجهاز المقدم.
- تقديم معلومات أو صور أو مقاطع غير صحيحة عن سبب العطل، أو إخفاء واقعة سقوط أو تسرب سائل أو إصلاح سابق.

### 5.7 ما يجب على الزبون تقديمه
لا تُقبل المطالبة إلا مستوفية الآتي:

- الطلب الذي اشتُري به الجهاز، معرفًا برقمه في نظام المتجر.
- الوحدة نفسها، ورقمها التسلسلي مطابقًا لما هو مسجل ولما هو مطبوع على وصل الضمان.
- صور واضحة للجهاز كاملًا، وللقطعة المعطلة، وللرقم التسلسلي.
- مقطع فيديو يُظهر العطل وهو يقع، لأن كثيرًا من الأعطال لا تثبت بصورة ساكنة.
- وصف مكتوب لما حدث: متى ظهر العطل، وفي أي ظرف، وما الذي جُرّب قبل المطالبة.
- وصل الضمان إن كان قد سُلّم مع الجهاز.

يقبل النظام ستة ملفات على الأكثر مع المطالبة الواحدة، بحد ثمانية ميغابايت للصورة وأربعين ميغابايت للمقطع. ما زاد يُرسل في رسائل لاحقة داخل المطالبة نفسها.

### 5.8 كيف تُقدَّم المطالبة
- يسجل الزبون الجهاز في حسابه أولًا من صفحة الضمان، برقمه التسلسلي أو برقم وصل الضمان أو من قائمة الأجهزة المستحقة في حسابه.
- تُفتح المطالبة من الجهاز المسجل نفسه. الجهاز غير المسجل لا تُفتح عليه مطالبة، ويُطلب من صاحبه تسجيله أولًا.
- يُكتب عنوان للمطالبة ووصف لا يقل عن عشرة أحرف، وتُرفق الأدلة المذكورة في المادة 5.7.
- المطالبة مسار مسجل داخل المتجر وله سجل رسائل بين الزبون والمتجر. ما يُتفق عليه خارج هذا المسار لا يُعتد به عند الخلاف.
- لا يقبل النظام أكثر من عشر مطالبات من الحساب الواحد في الساعة الواحدة، منعًا للإغراق.

### 5.9 مراحل المطالبة
تمر المطالبة بالمراحل المسجلة الآتية، ولا تنتقل من مرحلة إلى أخرى إلا بقرار من موظف مختص. لا توجد موافقة تلقائية في أي مرحلة:

- مستلمة: سُجّلت المطالبة ولم يبدأ الفحص.
- قيد التشخيص: الجهاز أو القطعة تحت الفحص الفني.
- مقبولة أو مرفوضة: قرار معلل. المطالبة المرفوضة يجوز إعادة فتحها للتشخيص مرة أخرى إذا ظهر معطى جديد.
- قيد الإصلاح: العمل جارٍ على القطعة.
- مستبدلة: نُفّذ استبدال القطعة أو الوحدة وفق المادة 5.4.
- منجزة: أُغلقت المطالبة بعد تسليم النتيجة.

### 5.10 مدة الإنجاز
- يبدأ الفحص خلال {{WARRANTY_CLAIM_DIAGNOSIS_DAYS}} من وصول الجهاز أو القطعة إلى المتجر، لا من تاريخ فتح المطالبة.
- تُنجز المطالبة المقبولة خلال {{WARRANTY_CLAIM_TURNAROUND_DAYS}} من انتهاء الفحص، ما لم تكن القطعة غير متوفرة.
- إذا كانت القطعة تحتاج استيرادًا فالمدة {{WARRANTY_PART_SOURCING_DAYS}}، ويُبلغ الزبون بذلك كتابةً داخل المطالبة.
- هذه مدد عمل معلنة، لا مواعيد مضمونة تعاقديًا. تأخر شركة النقل أو المصنّع أو المنفذ الحدودي خارج عن سيطرة المتجر.

### 5.11 أجور الشحن في المطالبة
- إيصال الجهاز أو القطعة من الزبون إلى المتجر على حساب الزبون، ذهابًا، في جميع الأحوال.
- إعادة القطعة أو الجهاز من المتجر إلى الزبون بعد قبول المطالبة كعيب تصنيعي: على حساب المتجر.
- إذا رُفضت المطالبة لخروجها عن التغطية أو لسقوط الضمان فأجور الإعادة على الزبون كذلك، ويُضاف إليها أجر الفحص المنصوص عليه في المادة 5.15.
- أجور الشحن ورسومه تحددها شركات التوصيل لا المتجر، وفق ما هو مبيّن في وثيقة التوصيل.
- لا يُستعمل الشحن المجاني الممنوح لأعضاء PRO فوق حد {{PRO_FREE_DELIVERY_MIN_IQD}} لتغطية شحن المطالبات إلا إذا نص المتجر على ذلك كتابةً.

### 5.12 القطعة المتوقفة عن الإنتاج
إذا كانت القطعة المعيبة قد توقف إنتاجها أو تعذر الحصول عليها:

- يستبدلها المتجر بقطعة مكافئة في الوظيفة والأداء، ولو اختلفت في الشكل أو الرقم أو المنشأ.
- فإن تعذرت المكافئة، جاز للمتجر استبدال المجموعة أو الوحدة التي تحوي القطعة، مع بقاء تاريخ انتهاء الضمان الأصلي.
- فإن تعذر ذلك كله، يُصدر المتجر رصيدًا في محفظة الزبون بقيمة القطعة وقت الشراء، لا بقيمة الجهاز كاملًا، وتُغلق المطالبة بذلك.
- لا يلتزم المتجر بتوفير قطعة أوقف المصنّع إنتاجها، ولا بتعويض عن انقطاعها عن السوق.

### 5.13 التحقق من الضمان
- لكل وحدة وصل ضمان واحد ساري المفعول. يمكن التحقق منه علنًا برقم الوصل أو بالرقم التسلسلي المطبوع على الجهاز.
- تُظهر صفحة التحقق حالة التغطية ووصف المنتج وتاريخي بدء الضمان وانتهائه وجزءًا من الرقم التسلسلي فقط، ولا تُظهر بيانات المشتري.
- الحالات المسجلة للوصل هي: ساري، منتهٍ، ملغى، مستبدل. الوصل غير المسلَّم بعد لا يظهر في التحقق ولا يُحتج به.
- الوصل الملغى أو المستبدل لا يثبت تغطية، ويبقى الوصل الساري الوحيد هو الحجة.

### 5.14 خدمة الأولوية لأعضاء PRO
مطالبة العضو المشترك في PRO تُسجَّل بأولوية في طابور المعالجة، وتُقدَّم على غيرها في الدور. الأولوية تقديم في الدور فقط، وليست تغييرًا في التغطية ولا في الاستثناءات ولا في مدة الضمان. مدة الاستجابة المستهدفة للعضو {{PRO_PRIORITY_RESPONSE_HOURS}}.

### 5.15 المطالبة التي لا يثبت فيها عيب
إذا أظهر الفحص أن الجهاز سليم، أو أن سبب العطل من الحالات المستثناة في المادة 5.5، أو أن الضمان ساقط وفق المادة 5.6:

- تُرفض المطالبة بقرار معلل مكتوب داخل سجل المطالبة.
- يستحق المتجر أجر الفحص البالغ {{WARRANTY_INSPECTION_FEE_IQD}}.
- يُعرض على الزبون إصلاح مدفوع وفق وثيقة خدمات ما بعد البيع، ولا يُنفذ إلا بموافقته الكتابية على عرض السعر.
- إذا لم يستلم الزبون جهازه خلال {{UNCOLLECTED_DEVICE_STORAGE_DAYS}} من إبلاغه بالقرار، يستحق المتجر أجر خزن قدره {{STORAGE_FEE_PER_DAY_IQD}} عن كل يوم.

### 5.16 بعد انتهاء المدة
العطل الذي يظهر بعد انتهاء مدة الضمان لا يُعالج تحت هذه الوثيقة ولو كان سببه عيب تصنيع. المطالبة المقدمة بعد انتهاء المدة تُسجَّل كطلب إصلاح مدفوع وتُعامل وفق وثيقة خدمات ما بعد البيع. العبرة في المدة بتاريخ تقديم المطالبة في نظام المتجر، لا بتاريخ ظهور العطل ولا بتاريخ اتصال الزبون بأي وسيلة أخرى.

### 5.17 العلاقة بضمان المصنّع
ضمان ليفونيس ضمان بائع مستقل عن ضمان المصنّع، ولا يعني اعتمادًا من العلامة التجارية ولا وكالةً عنها. لا يُلزم هذا الضمان المصنّع بشيء، ولا يلزم المتجرَ بما يعد به المصنّع. وحيث تكون سياسة المصنّع أوسع في حالة بعينها، يعين المتجر الزبونَ على الوصول إليها دون أن يضمن نتيجتها.

### 5.18 حدود المسؤولية
مسؤولية المتجر بموجب هذه الوثيقة محصورة في إصلاح القطعة المعيبة أو استبدالها. لا يتحمل المتجر:

- الخسائر غير المباشرة، وفوات الكسب، وتوقف العمل أو الإنتاج.
- قيمة المواد المستهلكة في طباعة فاشلة، ولا قيمة الوقت، ولا قيمة الطلبات التي تعذر على الزبون تنفيذها.
- الملفات والنماذج والإعدادات المخزّنة في الجهاز أو في بطاقة ذاكرته.
- أي تعويض يتجاوز الثمن المدفوع فعلًا عن الوحدة محل المطالبة.

### 5.19 انتقال الجهاز إلى مالك آخر
الضمان مرتبط بالوحدة لا بالشخص، ويكمل مدته الأصلية عند انتقال الجهاز. ينتقل الضمان بشرط أن يفك المالك الأول ارتباط الجهاز بحسابه وأن يسجله المالك الجديد باسمه. الجهاز الذي يبقى مسجلًا باسم غير حائزه لا تُقبل عليه مطالبة من الحائز. لا يبدأ الانتقال مدة جديدة ولا يمدد المدة القائمة.

### 5.20 التعارض والنفاذ واللغة
- هذه الوثيقة جزء من سياسات ليفونيس، وتُقرأ مع وثيقة الاسترجاع ووثيقة تمديد الضمان ووثيقة خدمات ما بعد البيع.
- إذا تعارض نص هذه الوثيقة مع وعد شفهي أو رسالة من موظف أو منشور تسويقي، فنص هذه الوثيقة هو المعتمد.
- عند اختلاف الترجمات يُرجع إلى النص العربي.
- يسري تعديل هذه الوثيقة على المطالبات المقدمة بعد تاريخ نفاذه، ولا يسري بأثر رجعي على مطالبة قائمة.
- عنوان المتجر للمراسلة والخدمة: {{LEVONIS_SERVICE_ADDRESS}}. قناة التواصل المعتمدة: {{LEVONIS_SUPPORT_CONTACT}}.`,

    en: `## Warranty Document — Article 5

This document sets out the parts warranty Levonis grants on the devices it sells, its limits and its procedures. The Arabic text is the authoritative text; this is a faithful translation of it with the same numbering. Filing a warranty claim means this document has been read and accepted.

### 5.1 Definitions
- The Store: {{LEVONIS_LEGAL_NAME}}, referred to in this document as Levonis.
- The Customer: the person who bought the device from Levonis, or the account that holds the device registration.
- The Unit: one physical device, with its own record in the store system and its own serial number where one exists. An order containing three printers is three units, each with its own warranty and its own period.
- The Part: any component inside the unit that can be removed or replaced on its own.
- Manufacturing fault: a defect in material, assembly or the component itself, appearing under normal use and in accordance with the manufacturer instructions, and not caused by an external event, by the customer, or by a third party.
- Recorded delivery date: the date and time recorded in the store system for the delivery of that particular unit. It is the only date from which any period is counted.
- Warranty receipt: the document the store issues for a unit, carrying a number in the form WR, year, day and sequence.
- The Claim: the request recorded in the store system against a unit registered to the customer account.

### 5.2 Warranty period
The warranty period is twelve calendar months, starting from the recorded delivery date of the unit itself.

- The period does not start from the order date, the payment date, the shipping date, or the date the box was opened.
- The period is counted per unit. If units of one order are delivered on different dates, each unit has a different expiry date.
- Registering the device in the customer account does not start, extend or restart the period. Registration is the way to reach claim services; it is not an event that moves the warranty.
- Used, refurbished or Open Box devices carry the period stated on their page and on their receipt, being one month or twelve months as the store set for that unit, and they accept no paid extension.
- If the customer bought a warranty extension before placing the order, the total period is twenty-four or thirty-six months according to the extension purchased. This same document applies to it word for word, together with the Extended Warranty document.

### 5.3 What the warranty covers
The warranty covers parts that failed from a manufacturing fault, and nothing else.

- This includes the failure of an electronic or mechanical component under normal use and within the manufacturer published specifications.
- It includes a fault apparent at first power-on, and a hidden fault that appeared later within the period.
- Cover is conditional on the device having been installed, powered and used in accordance with the manufacturer manual and instructions, and from a power source matching what the manufacturer stated.
- Establishing that a failure is a manufacturing fault rests on the technical inspection carried out by the store or by whoever it authorises, and the inspection decision is the reference for the cause of failure.

### 5.4 What the store provides: repair or replacement of the part
The warranty is an undertaking to repair or replace the faulty part. It is not an undertaking to replace the device.

- The warranty never includes swapping a whole printer for another machine, nor refunding its price, nor any cash compensation for the failure.
- The store chooses between repairing the part and replacing it with a new or an equivalent sound part, according to what the inspection shows and what the store holds.
- Replacing a whole unit is an exceptional measure taken only by a written decision of store management. Where it happens, the replacement unit continues the original unit warranty expiry date and does not start a new period.
- The faulty part that is removed becomes the property of the store and is not returned to the customer except on request and before its disposal.
- A part fitted as a replacement remains covered until the end of the original unit warranty period, and not to any later date.

### 5.5 What the warranty does not cover
The warranty covers none of the following, and no free repair is accepted for them:

- Misuse, use contrary to the manufacturer manual, and operation outside the published specifications of the device.
- Accidents, drops, impacts, breakage, crushing and bending, and all visible physical damage.
- Connecting the device to a non-matching voltage, using a non-matching adapter or power source, or damage from a power surge or interruption.
- Water, liquids, humidity, heavy dust, and heat or cold outside the published operating limits.
- Unauthorised modification, and opening, dismantling or repairing the device at a party not approved by the store.
- Fitting third-party parts, accessories or components, and damage resulting from them, even where the damage appears in another part.
- Consumables and wear items by their nature, including but not limited to: nozzles, belts, build plates and their surfaces, FEP film, resin vats, bearings, fans past the operating life set by the manufacturer, cables, Bowden tubes, cleaning tools, and consumable materials such as filament and resin.
- Normal wear, scratches and cosmetic marks that do not affect operation, and yellowing or colour change over time.
- Software-only problems: slicer settings, model files, unofficial firmware and software compatibility, unless shown to result from a defect in a part.
- Damage occurring during transport or at a border inspection point, which is governed by Article 4 of the Returns document and is not handled as a warranty claim.
- Devices not bought from Levonis, and devices bought from an independent merchant inside the Levo Pro platform, whose warranty is borne by the seller named there.
- Business interruption and indirect losses, per Article 5.18.

### 5.6 What voids the warranty
The warranty is void for the whole unit in any of the following cases, even where the failure claimed is a manufacturing fault:

- Removal, defacement, alteration or illegibility of the serial number.
- Opening, repairing or modifying the device at a party not approved by the store.
- Breaking the seals or protective labels where present.
- Presenting a unit different from the covered unit, or a warranty receipt that does not belong to the device presented.
- Providing untrue information, photographs or footage about the cause of failure, or concealing a drop, a liquid spill or an earlier repair.

### 5.7 What the customer must produce
A claim is accepted only when it carries all of the following:

- The order the device was bought under, identified by its number in the store system.
- The unit itself, with its serial number matching what is recorded and what is printed on the warranty receipt.
- Clear photographs of the whole device, of the failed part, and of the serial number.
- A video showing the fault as it occurs, because many faults cannot be established by a still image.
- A written description of what happened: when the fault appeared, under what conditions, and what was tried before the claim.
- The warranty receipt, where one was handed over with the device.

The system accepts at most six files with a single claim, up to eight megabytes for an image and forty megabytes for a video. Anything further is sent as later messages inside the same claim.

### 5.8 How a claim is filed
- The customer first registers the device in their account from the warranty page, by its serial number, by the warranty receipt number, or from the list of eligible devices in their account.
- The claim is opened from that registered device. No claim can be opened on an unregistered device; its holder is asked to register it first.
- A subject and a description of at least ten characters are written, and the evidence named in Article 5.7 is attached.
- The claim is a recorded channel inside the store with its own message record between customer and store. What is agreed outside this channel is not relied upon in a dispute.
- The system accepts no more than ten claims from one account in one hour, to prevent flooding.

### 5.9 Claim stages
A claim passes through the following recorded stages, and moves from one stage to another only by the decision of a responsible member of staff. There is no automatic approval at any stage:

- Received: the claim is recorded and inspection has not begun.
- Diagnosing: the device or part is under technical inspection.
- Approved or rejected: a reasoned decision. A rejected claim may be reopened for diagnosis if new information appears.
- Repairing: work on the part is in progress.
- Replaced: the part or the unit has been replaced under Article 5.4.
- Resolved: the claim is closed after the result has been handed over.

### 5.10 Turnaround
- Inspection begins within {{WARRANTY_CLAIM_DIAGNOSIS_DAYS}} of the device or part reaching the store, not from the date the claim was opened.
- An approved claim is completed within {{WARRANTY_CLAIM_TURNAROUND_DAYS}} of the end of inspection, unless the part is unavailable.
- Where a part must be imported, the period is {{WARRANTY_PART_SOURCING_DAYS}}, and the customer is told so in writing inside the claim.
- These are published working periods, not contractually guaranteed dates. Delay by a courier, by the manufacturer, or at a border crossing is outside the control of the store.

### 5.11 Claim shipping costs
- Sending the device or part from the customer to the store is at the customer expense, outbound, in every case.
- Returning the part or device from the store to the customer after a claim is accepted as a manufacturing fault is at the store expense.
- Where a claim is rejected as outside cover or because the warranty is void, the return leg is likewise at the customer expense, together with the inspection fee stated in Article 5.15.
- Shipping charges and fees are set by the delivery companies, not by the store, as stated in the Delivery document.
- Free shipping granted to PRO members above the {{PRO_FREE_DELIVERY_MIN_IQD}} threshold is not applied to claim shipping unless the store states so in writing.

### 5.12 A part that is out of production
Where the faulty part is out of production or cannot be obtained:

- The store replaces it with a part equivalent in function and performance, even if it differs in shape, part number or origin.
- Where no equivalent is available, the store may replace the assembly or the unit containing the part, the original warranty expiry date remaining unchanged.
- Where none of that is possible, the store issues wallet credit for the value of the part at the time of purchase, not the value of the whole device, and the claim is closed on that basis.
- The store is not obliged to supply a part the manufacturer has discontinued, nor to compensate for its disappearance from the market.

### 5.13 Warranty verification
- Each unit has one live warranty receipt. It can be verified publicly by the receipt number or by the serial number printed on the device.
- The verification page shows the cover status, the product description, the warranty start and end dates, and part of the serial number only. It shows no buyer data.
- The recorded receipt states are: active, expired, void, replaced. A receipt not yet handed over does not appear in verification and cannot be relied upon.
- A void or replaced receipt establishes no cover; the live receipt alone is the proof.

### 5.14 PRO priority service
A claim from a member holding a PRO subscription is recorded with priority in the processing queue and is taken ahead of others in turn. Priority is a place in the queue only; it changes neither the cover, nor the exclusions, nor the warranty period. The target response time for a member is {{PRO_PRIORITY_RESPONSE_HOURS}}.

### 5.15 A claim where no fault is established
Where the inspection shows that the device is sound, that the cause of failure is one of the excluded cases in Article 5.5, or that the warranty is void under Article 5.6:

- The claim is rejected by a reasoned written decision inside the claim record.
- The store is entitled to the inspection fee of {{WARRANTY_INSPECTION_FEE_IQD}}.
- A paid repair is offered to the customer under the After-Sale Services document, and is carried out only on written acceptance of the quotation.
- If the customer does not collect the device within {{UNCOLLECTED_DEVICE_STORAGE_DAYS}} of being told of the decision, the store is entitled to a storage charge of {{STORAGE_FEE_PER_DAY_IQD}} per day.

### 5.16 After the period ends
A failure appearing after the warranty period ends is not handled under this document, even where its cause is a manufacturing fault. A claim filed after the period ends is recorded as a paid repair request and treated under the After-Sale Services document. What counts for the period is the date the claim was filed in the store system, not the date the fault appeared, nor the date the customer made contact by any other means.

### 5.17 Relationship with the manufacturer warranty
The Levonis warranty is a seller warranty independent of the manufacturer warranty. It implies no approval by, and no agency for, the brand. This warranty binds the manufacturer to nothing, and does not bind the store to what the manufacturer promises. Where the manufacturer policy is broader in a particular case, the store assists the customer in reaching it without guaranteeing its outcome.

### 5.18 Limits of liability
The liability of the store under this document is confined to repairing or replacing the faulty part. The store does not bear:

- Indirect losses, loss of profit, and interruption of work or production.
- The value of material consumed in a failed print, the value of time, or the value of orders the customer could not fulfil.
- Files, models and settings stored on the device or on its memory card.
- Any compensation exceeding the price actually paid for the unit in question.

### 5.19 Transfer of the device to another owner
The warranty attaches to the unit, not to the person, and continues its original period when the device changes hands. It transfers on condition that the first owner unlinks the device from their account and the new owner registers it in their own name. A device still registered to someone other than its holder does not accept a claim from that holder. A transfer starts no new period and extends no existing one.

### 5.20 Conflict, effect and language
- This document forms part of the Levonis policies and is read together with the Returns document, the Extended Warranty document and the After-Sale Services document.
- Where the text of this document conflicts with an oral promise, a message from a member of staff, or a marketing post, the text of this document prevails.
- Where translations differ, the Arabic text governs.
- An amendment to this document applies to claims filed after its effective date and has no retroactive effect on a pending claim.
- Store address for correspondence and service: {{LEVONIS_SERVICE_ADDRESS}}. Approved contact channel: {{LEVONIS_SUPPORT_CONTACT}}.`,

    ckb: `## بەڵگەنامەی گەرەنتی — ماددەی 5

ئەم بەڵگەنامەیە گەرەنتی پارچەکان ڕوون دەکاتەوە کە فرۆشگای لێڤۆنیس لەسەر ئەو ئامێرانە دەیدات کە دەیفرۆشێت، لەگەڵ سنوورەکانی و ڕێکارەکانی. دەقی عەرەبی دەقی پەسەندکراوە و ئەمە وەرگێڕانێکی دڵسۆزی ئەوە بە هەمان ژمارەبەندی. پێشکەشکردنی هەر داواکارییەکی گەرەنتی واتای خوێندنەوە و پەسەندکردنی ئەم بەڵگەنامەیە.

### 5.1 پێناسەکان
- فرۆشگا: {{LEVONIS_LEGAL_NAME}}، کە لەم بەڵگەنامەیەدا بە لێڤۆنیس ئاماژەی پێدەکرێت.
- کڕیار: ئەو کەسەی ئامێرەکەی لە لێڤۆنیس کڕیوە، یان ئەو هەژمارەی تۆمارکردنی ئامێرەکەی پێیە.
- یەکە: یەک ئامێری فیزیکی، بە تۆمارە سەربەخۆکەی لە سیستەمی فرۆشگا و بە ژمارە زنجیرەییەکەی ئەگەر هەبێت. داواکارییەک کە سێ پرینتەری تێدایە سێ یەکەیە، هەریەکەیان گەرەنتی و ماوەی خۆی هەیە.
- پارچە: هەر بەشێکی ناو یەکەکە کە بە تەنها دەکرێت دابمالرێت یان بگۆڕدرێت.
- کەموکووڕی بەرهەمهێنان: کەموکووڕی لە ماددە یان لە کۆکردنەوە یان لە پێکهاتەکە خۆی، کە لە کاتی بەکارهێنانی ئاسایی و بەپێی ڕێنماییەکانی کارگە دەرکەوتووە، و هۆکارەکەی ڕووداوێکی دەرەکی یان کردەی کڕیار یان لایەنی سێیەم نەبووە.
- بەرواری تۆمارکراوی گەیاندن: ئەو بەروار و کاتەی لە سیستەمی فرۆشگادا بۆ گەیاندنی ئەو یەکەیە تۆمارکراوە، و تەنها ئەوە بنەمای ژماردنی هەموو ماوەکانە.
- پسوولەی گەرەنتی: ئەو بەڵگەنامەیەی فرۆشگا بۆ یەکەکە دەریدەکات و ژمارەیەکی بە شێوەی WR و ساڵ و ڕۆژ و زنجیرە هەڵدەگرێت.
- داواکاری: ئەو داواکارییەی لە سیستەمی فرۆشگادا لەسەر یەکەیەکی تۆمارکراو لە هەژماری کڕیار تۆمار دەکرێت.

### 5.2 ماوەی گەرەنتی
ماوەی گەرەنتی دوانزە مانگی ساڵنامەییە و لە بەرواری تۆمارکراوی گەیاندنی هەمان یەکەوە دەست پێدەکات.

- ماوەکە لە بەرواری داواکاری، لە بەرواری پارەدان، لە بەرواری نێردن یان لە بەرواری کردنەوەی سندوقەکە دەست پێناکات.
- ماوەکە بۆ هەر یەکەیەک بە جیا دەژمێردرێت. ئەگەر یەکەکانی یەک داواکاری لە بەرواری جیاواز بگەیەنرێن، هەر یەکەیەک بەرواری کۆتایی جیاوازی هەیە.
- تۆمارکردنی ئامێر لە هەژماری کڕیار ماوەکە دەست پێناکات، درێژی ناکاتەوە و لە سەرەتاوە نایگەڕێنێتەوە. تۆمارکردن ڕێگایە بۆ گەیشتن بە خزمەتگوزاری داواکاری، نەک ڕووداوێک کە گەرەنتی بجوڵێنێت.
- ئامێری بەکارهاتوو یان چاککراوەوە یان ئەوانەی بە Open Box دەفرۆشرێن ئەو ماوەیە هەڵدەگرن کە لە پەڕەکەی و لە پسوولەکەی ڕاگەیەنراوە، واتە یەک مانگ یان دوانزە مانگ بەپێی ئەوەی فرۆشگا بۆ ئەو یەکەیە دیاری کردووە، و هیچ درێژکردنەوەیەکی پارەدراو وەرناگرن.
- ئەگەر کڕیار پێش تەواوکردنی داواکارییەکە درێژکردنەوەی گەرەنتی کڕیبێت، کۆی ماوەکە بیست و چوار یان سی و شەش مانگە بەپێی ئەو درێژکردنەوەیەی کڕیویەتی، و هەمان ئەم بەڵگەنامەیە بە وشە لەسەری جێبەجێ دەبێت، لەگەڵ بەڵگەنامەی درێژکردنەوەی گەرەنتی.

### 5.3 ئەوەی گەرەنتی دایدەپۆشێت
گەرەنتی ئەو پارچانە دادەپۆشێت کە بەهۆی کەموکووڕی بەرهەمهێنانەوە تێکچوون، و هیچی تر.

- ئەمە تێکچوونی پێکهاتەیەکی ئەلیکترۆنی یان میکانیکی لە بەکارهێنانی ئاسایی و لەناو تایبەتمەندییە ڕاگەیەنراوەکانی کارگە دەگرێتەوە.
- کەموکووڕییەکی دیار لە یەکەم کارپێکردن دەگرێتەوە، هەروەها کەموکووڕییەکی شاراوە کە دواتر لەناو ماوەکەدا دەرکەوتووە.
- داپۆشین بەو مەرجەیە کە ئامێرەکە بەپێی ڕێبەری کارگە دانرابێت و کار پێکرابێت و بەکارهاتبێت، و لە سەرچاوەی وزەیەکەوە کە لەگەڵ ئەوەی کارگە دیاری کردووە بگونجێت.
- سەلماندنی ئەوەی تێکچوونەکە کەموکووڕی بەرهەمهێنانە دەکەوێتە سەر پشکنینی تەکنیکی کە فرۆشگا یان ئەو لایەنەی ڕایدەسپێرێت ئەنجامی دەدات، و بڕیاری پشکنین سەرچاوەیە بۆ دیاریکردنی هۆکاری تێکچوون.

### 5.4 ئەوەی فرۆشگا پێشکەشی دەکات: چاککردن یان گۆڕینی پارچەکە
گەرەنتی پابەندبوونێکە بە چاککردن یان گۆڕینی پارچە کەموکووڕەکە، نەک پابەندبوون بە گۆڕینی ئامێرەکە.

- گەرەنتی بە هیچ شێوەیەک گۆڕینی تەواوی پرینتەرەکە بە ئامێرێکی تر ناگرێتەوە، نە گەڕاندنەوەی نرخەکەی، نە هیچ قەرەبووێکی نەقدی لەسەر تێکچوونەکە.
- فرۆشگا هەڵدەبژێرێت لە نێوان چاککردنی پارچەکە و گۆڕینی بە پارچەیەکی نوێ یان هاوتای ساغ، بەپێی ئەوەی پشکنین دەریدەخات و ئەوەی لای فرۆشگا بەردەستە.
- گۆڕینی تەواوی یەکەکە ڕێکارێکی نائاساییە و تەنها بە بڕیاری نووسراوی بەڕێوەبەرایەتی فرۆشگا ڕوودەدات، و لە کاتی ڕوودانیدا یەکە جێگرەوەکە هەمان بەرواری کۆتایی گەرەنتی یەکە سەرەکییەکە تەواو دەکات و ماوەیەکی نوێ دەست پێناکات.
- پارچە کەموکووڕەکەی لادەبرێت دەبێتە موڵکی فرۆشگا، و تەنها بە داواکاری کڕیار و پێش لەناوبردنی دەگەڕێندرێتەوە.
- ئەو پارچەیەی وەک جێگرەوە دادەنرێت تا کۆتایی ماوەی گەرەنتی یەکە سەرەکییەکە دادەپۆشرێت، نەک تا بەروارێکی دواتر.

### 5.5 ئەوەی گەرەنتی دایناپۆشێت
گەرەنتی هیچ یەک لەمانە ناگرێتەوە و هیچ چاککردنێکی بێبەرامبەریان بۆ وەرناگیرێت:

- خراپ بەکارهێنان، بەکارهێنان پێچەوانەی ڕێبەری کارگە، و کارپێکردن لە دەرەوەی تایبەتمەندییە ڕاگەیەنراوەکانی ئامێر.
- ڕووداو و کەوتن و لێدان و شکان و پەستان و چەماندن، و هەموو زیانێکی فیزیکی دیار.
- بەستنەوەی ئامێر بە ڤۆڵتییەکی نەگونجاو، یان بەکارهێنانی گۆڕەر یان سەرچاوەی وزەی نەگونجاو، یان زیان لە بەرزبوونەوە یان پچڕانی کارەبا.
- ئاو و شلە و شێ و تۆزی زۆر و گەرما یان سەرمای دەرەوەی سنووری کارکردنی ڕاگەیەنراو.
- دەستکاری بێ مۆڵەت، و کردنەوە یان دامالین یان چاککردنی ئامێرەکە لای لایەنێک کە فرۆشگا پەسەندی نەکردووە.
- دانانی پارچە یان پێداویستی یان پێکهاتەی لایەنی سێیەم، و ئەو زیانانەی لێیەوە دێن، تەنانەت ئەگەر زیانەکە لە پارچەیەکی تردا دەرکەوێت.
- ماددە بەکارهاتووەکان و پارچە داڕووخاوەکان بە سروشتی خۆیان، لەوانە بەڵام نەک تەنها: نۆزڵەکان، قایشەکان، تەختەکانی چاپ و ڕووەکانیان، پەردەی FEP، حەوزی ڕەزین، بێرینگ و پاڵپشتەکان، فانەکان دوای تەواوبوونی تەمەنی کاری دیاریکراوی کارگە، کێبڵەکان، لولەی بۆدن، ئامرازی پاککردنەوە، و ماددە بەکارهاتووەکان وەک فیلەمێنت و ڕەزین.
- داڕووخانی سروشتی، خەون و نیشانە ڕووکەشییەکان کە کاری ئامێر تێک نادەن، و زەردبوون یان گۆڕانی ڕەنگ بە تێپەڕبوونی کات.
- کێشە نەرمەکاڵاییەکان بە تەنها: ڕێکخستنەکانی سلایسەر، فایلەکانی مۆدێل، فێرموێری نافەرمی و گونجانی نەرمەکاڵا، مەگەر بسەلمێنرێت لە کەموکووڕی پارچەیەکەوە هاتبن.
- ئەو زیانەی لە کاتی گواستنەوەدا یان لە خاڵێکی پشکنینی سنووریدا ڕوودەدات، کە بە ماددەی 4 ی بەڵگەنامەی گەڕاندنەوە ڕێکدەخرێت و وەک داواکاری گەرەنتی مامەڵەی لەگەڵ ناکرێت.
- ئەو ئامێرانەی لە لێڤۆنیس نەکڕدراون، و ئەو ئامێرانەی لە بازرگانێکی سەربەخۆی ناو پلاتفۆرمی لێڤۆ پرۆ کڕدراون کە گەرەنتییەکەیان لەسەر ئەو فرۆشیارەیە کە ناوی هاتووە.
- وەستانی کار و زیانە ناڕاستەوخۆکان، بەپێی ماددەی 5.18.

### 5.6 ئەوەی گەرەنتی پووچ دەکاتەوە
گەرەنتی بۆ هەموو یەکەکە پووچ دەبێتەوە لە هەر یەک لەم حاڵەتانەدا، تەنانەت ئەگەر ئەو تێکچوونەی داوای لەسەر دەکرێت کەموکووڕی بەرهەمهێنان بێت:

- لابردن یان سڕینەوە یان گۆڕین یان نەخوێندنەوەی ژمارە زنجیرەییەکە.
- کردنەوە یان چاککردن یان دەستکاریکردنی ئامێرەکە لای لایەنێکی نا پەسەندکراو لەلایەن فرۆشگاوە.
- شکاندنی مۆر یان لێدراوە پارێزەرەکان لەو شوێنانەی هەن.
- پێشکەشکردنی یەکەیەکی جیاواز لە یەکە داپۆشراوەکە، یان پسوولەی گەرەنتییەک کە هی ئەو ئامێرە نییە کە پێشکەش کراوە.
- پێدانی زانیاری یان وێنە یان ڤیدیۆی نادروست دەربارەی هۆکاری تێکچوون، یان شاردنەوەی کەوتن یان ڕژانی شلە یان چاککردنێکی پێشوو.

### 5.7 ئەوەی پێویستە کڕیار پێشکەشی بکات
داواکاری تەنها کاتێک وەردەگیرێت کە هەموو ئەمانەی لەگەڵ بێت:

- ئەو داواکارییەی ئامێرەکەی پێ کڕدراوە، بە ژمارەکەی لە سیستەمی فرۆشگا.
- خودی یەکەکە، و ژمارە زنجیرەییەکەی لەگەڵ ئەوەی تۆمارکراوە و ئەوەی لەسەر پسوولەی گەرەنتی چاپکراوە یەک بێت.
- وێنەی ڕوون بۆ هەموو ئامێرەکە، بۆ پارچە تێکچووەکە، و بۆ ژمارە زنجیرەییەکە.
- ڤیدیۆیەک کە تێکچوونەکە لە کاتی ڕوودانیدا نیشان بدات، چونکە زۆرێک لە تێکچوونەکان بە وێنەیەکی وەستاو ناسەلمێنرێن.
- وەسفێکی نووسراو لەوەی ڕوویداوە: کەی تێکچوونەکە دەرکەوت، لە چ بارودۆخێکدا، و چی تاقی کراوەتەوە پێش داواکارییەکە.
- پسوولەی گەرەنتی، ئەگەر لەگەڵ ئامێرەکە پێدرابێت.

سیستەمەکە لەگەڵ یەک داواکاریدا زۆرترین شەش فایل وەردەگرێت، تا هەشت میگابایت بۆ وێنە و چل میگابایت بۆ ڤیدیۆ. زیاتر لەوە وەک نامەی دواتر لەناو هەمان داواکاریدا دەنێردرێت.

### 5.8 چۆن داواکاری پێشکەش دەکرێت
- کڕیار سەرەتا ئامێرەکە لە هەژمارەکەی خۆی لە پەڕەی گەرەنتی تۆمار دەکات، بە ژمارە زنجیرەیی، یان بە ژمارەی پسوولەی گەرەنتی، یان لە لیستی ئامێرە شایستەکانی ناو هەژمارەکەی.
- داواکارییەکە لە هەمان ئامێرە تۆمارکراوەکەوە دەکرێتەوە. لەسەر ئامێرێکی تۆمارنەکراو هیچ داواکارییەک ناکرێتەوە، و داوا لە خاوەنەکەی دەکرێت سەرەتا تۆماری بکات.
- ناونیشانێک و وەسفێکی نەکەمتر لە دە پیت دەنووسرێت، و ئەو بەڵگانەی لە ماددەی 5.7 هاتوون هاوپێچ دەکرێن.
- داواکارییەکە کەناڵێکی تۆمارکراوە لەناو فرۆشگادا و تۆماری نامەی خۆی هەیە لە نێوان کڕیار و فرۆشگا. ئەوەی لە دەرەوەی ئەم کەناڵە ڕێک دەکەوێت لە کاتی ناکۆکیدا پشتی پێ نابەسترێت.
- سیستەمەکە زیاتر لە دە داواکاری لە یەک هەژمارەوە لە یەک کاتژمێردا وەرناگرێت، بۆ ڕێگریکردن لە لافاو.

### 5.9 قۆناغەکانی داواکاری
داواکاری بەم قۆناغە تۆمارکراوانەدا تێدەپەڕێت، و تەنها بە بڕیاری کارمەندێکی بەرپرس لە قۆناغێکەوە بۆ قۆناغێکی تر دەچێت. لە هیچ قۆناغێکدا پەسەندکردنی خۆکار نییە:

- وەرگیراو: داواکارییەکە تۆمار کراوە و پشکنین دەستی پێنەکردووە.
- لە ژێر دەستنیشانکردن: ئامێر یان پارچەکە لە ژێر پشکنینی تەکنیکییە.
- پەسەندکراو یان ڕەتکراوە: بڕیارێکی هۆکاردار. داواکاری ڕەتکراوە دەکرێت بۆ دەستنیشانکردنی دووبارە بکرێتەوە ئەگەر زانیاری نوێ دەرکەوێت.
- لە ژێر چاککردن: کار لەسەر پارچەکە بەردەوامە.
- گۆڕدراوە: پارچەکە یان یەکەکە بەپێی ماددەی 5.4 گۆڕدراوە.
- تەواوبوو: داواکارییەکە دوای پێدانی ئەنجامەکە داخراوە.

### 5.10 ماوەی تەواوکردن
- پشکنین لە ماوەی {{WARRANTY_CLAIM_DIAGNOSIS_DAYS}} دوای گەیشتنی ئامێر یان پارچەکە بە فرۆشگا دەست پێدەکات، نەک لە بەرواری کردنەوەی داواکارییەکەوە.
- داواکاری پەسەندکراو لە ماوەی {{WARRANTY_CLAIM_TURNAROUND_DAYS}} دوای کۆتایی پشکنین تەواو دەکرێت، مەگەر پارچەکە بەردەست نەبێت.
- ئەگەر پارچەکە پێویستی بە هاوردەکردن بێت، ماوەکە {{WARRANTY_PART_SOURCING_DAYS}} ە، و کڕیار بە نووسراوی لەناو داواکارییەکەدا ئاگادار دەکرێتەوە.
- ئەمانە ماوەی کاری ڕاگەیەنراون، نەک بەرواری گەرەنتیکراوی گرێبەستی. دواکەوتنی کۆمپانیای گواستنەوە یان کارگە یان دەروازەی سنووری لە دەرەوەی دەسەڵاتی فرۆشگایە.

### 5.11 تێچووی گواستنەوە لە داواکاریدا
- ناردنی ئامێر یان پارچەکە لە کڕیارەوە بۆ فرۆشگا لەسەر کڕیارە، لە ڕۆیشتندا، لە هەموو حاڵەتێکدا.
- گەڕاندنەوەی پارچە یان ئامێر لە فرۆشگاوە بۆ کڕیار دوای پەسەندکردنی داواکاری وەک کەموکووڕی بەرهەمهێنان لەسەر فرۆشگایە.
- ئەگەر داواکارییەکە ڕەت کرایەوە بەهۆی دەرەوەی داپۆشین بوون یان پووچبوونەوەی گەرەنتی، تێچووی گەڕاندنەوەش لەسەر کڕیارە، لەگەڵ ئەو کرێی پشکنینەی لە ماددەی 5.15 هاتووە.
- کرێ و باجی گواستنەوە لەلایەن کۆمپانیاکانی گەیاندنەوە دیاری دەکرێن نەک لەلایەن فرۆشگاوە، بەپێی ئەوەی لە بەڵگەنامەی گەیاندن هاتووە.
- ئەو گواستنەوە بێبەرامبەرەی بۆ ئەندامانی PRO لە سەرووی سنووری {{PRO_FREE_DELIVERY_MIN_IQD}} دەدرێت بۆ گواستنەوەی داواکارییەکان بەکار نایەت مەگەر فرۆشگا بە نووسراوی ئەوە بڵێت.

### 5.12 پارچەیەک کە بەرهەمهێنانی وەستاوە
ئەگەر پارچە کەموکووڕەکە بەرهەمهێنانی وەستابێت یان دەست نەکەوێت:

- فرۆشگا بە پارچەیەکی هاوتا لە ئەرک و کارایی دەیگۆڕێت، تەنانەت ئەگەر لە شێوە یان ژمارە یان سەرچاوەدا جیاواز بێت.
- ئەگەر هاوتا دەست نەکەوێت، فرۆشگا دەتوانێت ئەو کۆمەڵە یان یەکەیە بگۆڕێت کە پارچەکەی تێدایە، لەگەڵ مانەوەی هەمان بەرواری کۆتایی گەرەنتی سەرەکی.
- ئەگەر هیچ لەمانە نەکرێت، فرۆشگا کرێدیتێک لە جزدانی کڕیاردا دەردەکات بە بەهای پارچەکە لە کاتی کڕین، نەک بە بەهای هەموو ئامێرەکە، و داواکارییەکە بەوە دادەخرێت.
- فرۆشگا پابەند نییە بە دابینکردنی پارچەیەک کە کارگە بەرهەمهێنانی ڕاگرتووە، نە بە قەرەبووکردنەوە لەسەر نەمانی لە بازاڕ.

### 5.13 پشتڕاستکردنەوەی گەرەنتی
- هەر یەکەیەک یەک پسوولەی گەرەنتی چالاکی هەیە. بە ژمارەی پسوولە یان بە ژمارە زنجیرەیی چاپکراوی سەر ئامێرەکە بە ئاشکرا دەتوانرێت پشتڕاست بکرێتەوە.
- پەڕەی پشتڕاستکردنەوە تەنها دۆخی داپۆشین و وەسفی بەرهەم و بەرواری دەستپێک و کۆتایی گەرەنتی و بەشێک لە ژمارە زنجیرەیی نیشان دەدات، و هیچ زانیارییەکی کڕیار نیشان نادات.
- دۆخە تۆمارکراوەکانی پسوولە ئەمانەن: چالاک، کۆتایی هاتوو، پووچکراوە، گۆڕدراوە. ئەو پسوولەیەی هێشتا نەدراوەتە دەست کەس لە پشتڕاستکردنەوەدا دەرناکەوێت و پشتی پێ نابەسترێت.
- پسوولەی پووچکراوە یان گۆڕدراو هیچ داپۆشینێک ناسەلمێنێت، و تەنها پسوولە چالاکەکە بەڵگەیە.

### 5.14 خزمەتگوزاری پێشینەیی بۆ ئەندامانی PRO
داواکاری ئەو ئەندامەی بەشداری PRO ی هەیە بە پێشینەیی لە ڕیزی کارکردندا تۆمار دەکرێت و لە نۆرەدا پێش ئەوانی تر دەخرێت. پێشینەیی تەنها شوێنە لە ڕیزدا، و نە داپۆشین نە جیاکراوەکان نە ماوەی گەرەنتی ناگۆڕێت. ماوەی وەڵامدانەوەی ئامانجدار بۆ ئەندام {{PRO_PRIORITY_RESPONSE_HOURS}} ە.

### 5.15 داواکارییەک کە کەموکووڕی تێدا نەسەلمێنرێت
ئەگەر پشکنین دەریخست کە ئامێرەکە ساغە، یان هۆکاری تێکچوونەکە یەکێکە لە حاڵەتە جیاکراوەکانی ماددەی 5.5، یان گەرەنتی بەپێی ماددەی 5.6 پووچ بووەتەوە:

- داواکارییەکە بە بڕیارێکی هۆکاردار و نووسراو لەناو تۆماری داواکاریدا ڕەت دەکرێتەوە.
- فرۆشگا شایستەی کرێی پشکنینە کە {{WARRANTY_INSPECTION_FEE_IQD}} ە.
- چاککردنێکی پارەدراو بەپێی بەڵگەنامەی خزمەتگوزاری دوای فرۆشتن پێشکەش بە کڕیار دەکرێت، و تەنها بە پەسەندکردنی نووسراوی نرخنامەکە جێبەجێ دەکرێت.
- ئەگەر کڕیار لە ماوەی {{UNCOLLECTED_DEVICE_STORAGE_DAYS}} دوای ئاگادارکردنەوەی لە بڕیارەکە ئامێرەکەی وەرنەگرت، فرۆشگا شایستەی کرێی هەڵگرتنە بە بڕی {{STORAGE_FEE_PER_DAY_IQD}} بۆ هەر ڕۆژێک.

### 5.16 دوای کۆتاییهاتنی ماوەکە
ئەو تێکچوونەی دوای کۆتاییهاتنی ماوەی گەرەنتی دەردەکەوێت لەژێر ئەم بەڵگەنامەیەدا مامەڵەی لەگەڵ ناکرێت، تەنانەت ئەگەر هۆکارەکەی کەموکووڕی بەرهەمهێنان بێت. ئەو داواکارییەی دوای کۆتاییهاتنی ماوەکە پێشکەش دەکرێت وەک داواکاری چاککردنی پارەدراو تۆمار دەکرێت و بەپێی بەڵگەنامەی خزمەتگوزاری دوای فرۆشتن مامەڵەی لەگەڵ دەکرێت. بنەما لە ماوەکەدا بەرواری پێشکەشکردنی داواکارییە لە سیستەمی فرۆشگا، نەک بەرواری دەرکەوتنی تێکچوونەکە، نە بەرواری پەیوەندیکردنی کڕیار بە هەر ڕێگایەکی تر.

### 5.17 پەیوەندی بە گەرەنتی کارگەوە
گەرەنتی لێڤۆنیس گەرەنتی فرۆشیارە و سەربەخۆیە لە گەرەنتی کارگە، و واتای پەسەندکردن لەلایەن مارکەکە یان بریکارێتی بۆی نییە. ئەم گەرەنتییە کارگە بە هیچ پابەند ناکات، و فرۆشگاش بەوەی کارگە بەڵێنی دەدات پابەند ناکات. لەو حاڵەتانەی سیاسەتی کارگە فراوانتر بێت، فرۆشگا یارمەتی کڕیار دەدات بۆ گەیشتن بەو سیاسەتە بەبێ گەرەنتیدانی ئەنجامەکەی.

### 5.18 سنووری بەرپرسیارێتی
بەرپرسیارێتی فرۆشگا بەپێی ئەم بەڵگەنامەیە تەنها لە چاککردن یان گۆڕینی پارچە کەموکووڕەکەدا کورت دەبێتەوە. فرۆشگا ئەمانە هەڵناگرێت:

- زیانە ناڕاستەوخۆکان، لەدەستدانی قازانج، و وەستانی کار یان بەرهەمهێنان.
- بەهای ئەو ماددانەی لە چاپێکی سەرنەکەوتوودا بەکارهاتوون، نە بەهای کات، نە بەهای ئەو داواکارییانەی کڕیار نەیتوانیوە جێبەجێیان بکات.
- فایل و مۆدێل و ڕێکخستنەکانی ناو ئامێرەکە یان کارتی بیرگەکەی.
- هیچ قەرەبووێک کە لەو نرخە زیاتر بێت کە بە ڕاستی بۆ ئەو یەکەیە دراوە کە داواکارییەکەی لەسەرە.

### 5.19 گواستنەوەی ئامێر بۆ خاوەنێکی تر
گەرەنتی بە یەکەکەوە بەستراوە نەک بە کەسەکەوە، و لە کاتی گواستنەوەی ئامێرەکەدا هەمان ماوەی سەرەکی تەواو دەکات. گەرەنتی دەگوازرێتەوە بەو مەرجەی خاوەنی یەکەم ئامێرەکە لە هەژمارەکەی خۆی بکاتەوە و خاوەنی نوێ بە ناوی خۆی تۆماری بکات. ئەو ئامێرەی بە ناوی کەسێکی جیاواز لە هەڵگرەکەی تۆمارکراو بمێنێتەوە، داواکاری لە هەڵگرەکەوە لەسەری وەرناگیرێت. گواستنەوە هیچ ماوەیەکی نوێ دەست پێناکات و ماوەی هەبووش درێژ ناکاتەوە.

### 5.20 ناکۆکی و جێبەجێبوون و زمان
- ئەم بەڵگەنامەیە بەشێکە لە سیاسەتەکانی لێڤۆنیس، و لەگەڵ بەڵگەنامەی گەڕاندنەوە و بەڵگەنامەی درێژکردنەوەی گەرەنتی و بەڵگەنامەی خزمەتگوزاری دوای فرۆشتن دەخوێندرێتەوە.
- ئەگەر دەقی ئەم بەڵگەنامەیە لەگەڵ بەڵێنێکی زارەکی یان نامەیەکی کارمەند یان بڵاوکراوەیەکی بازرگانی ناکۆک بوو، دەقی ئەم بەڵگەنامەیە پەسەندە.
- لە کاتی جیاوازی وەرگێڕانەکاندا دەقی عەرەبی بنەمایە.
- هەموو گۆڕانکارییەک لەم بەڵگەنامەیەدا لەسەر ئەو داواکارییانە جێبەجێ دەبێت کە دوای بەرواری کارپێکردنی پێشکەش دەکرێن، و کاریگەری دواکەوتووی لەسەر داواکارییەکی کراوە نییە.
- ناونیشانی فرۆشگا بۆ نامەنووسین و خزمەتگوزاری: {{LEVONIS_SERVICE_ADDRESS}}. کەناڵی پەیوەندی پەسەندکراو: {{LEVONIS_SUPPORT_CONTACT}}.`,
  },
};
