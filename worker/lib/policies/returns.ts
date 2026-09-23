import type { PolicyDocument } from './types';

/**
 * RETURNS AND EXCHANGE — the owner's clause 4, plus the transit-damage rule of
 * clause 1 restated where a customer will actually look for it.
 *
 * WHY CLAUSE 1 IS REPEATED HERE. It lives in the Delivery document as a
 * delivery rule, but it is argued about at the moment of a return: a box that
 * arrived open at a checkpoint is exactly the case where a customer demands a
 * free return and the store must be able to point at a written line. A
 * cross-reference in a dispute is a sentence nobody reads, so articles 4.16 to
 * 4.19 state it in full and name the Delivery document as its source.
 *
 * WHAT THE CODE FIXES, AND THE ARTICLE THAT SAYS SO (worker/routes/returns.ts):
 *  - SEVEN DAYS, from the delivered_at of the affected UNIT when one is named,
 *    else the item, judged at REQUEST time (`within_window` is snapshotted at
 *    creation, so slow staff review never closes a timely case) — article 4.2.
 *  - The reason list is closed: defective, manufacturing_fault,
 *    not_as_described, wrong_item (alias wrong_product), shipping_damage.
 *    THERE IS NO CHANGE-OF-MIND REASON AT ALL, which is why article 4.9 can
 *    say plainly that no such return exists rather than inventing a window.
 *  - An Open Box / used / refurbished listing refuses `not_as_described`
 *    (worker/lib/condition.ts RETURN_BLOCKED_REASONS) and ONLY that: a unit
 *    that arrives dead or is the wrong box is still claimable — article 4.12.
 *  - A bundle returns whole; a faulty component may be claimed alone — 4.13.
 *  - Money moves only at `resolved`, to the WALLET, at the order's recorded
 *    exchange rate, net of the line's share of order-level discounts, with
 *    purchase points reversed proportionally and SHIPPING NOT REFUNDED —
 *    articles 4.7 and 4.8. The store never promises cash back, because the
 *    code cannot pay cash.
 *
 * The owner's own rule — free return only for a genuinely defective product,
 * returned exactly as it arrived, with return shipping on the customer — is
 * article 4.3 and 4.4, and everything after them is the list of cases where a
 * customer will say those two articles do not apply to them.
 *
 * VERSION 2 — WHY IT MOVED. Two corrections a customer could see on the
 * page; the archive keeps version 1 byte for byte.
 *   * THE NAME. The store is written «Levonis», in Latin script, in all three
 *     languages. 8 transliterated occurrences left the body here. Where the
 *     name carried an Arabic or Sorani affix the affix was detached rather than
 *     swallowed by the replacement, so the sentence still parses.
 *   * THE UNKNOWNS. 4 lines in this document still state a
 *     fact the owner has not given, so ./render.ts WITHHOLDS them from the published
 *     text rather than show a customer a `{{TOKEN}}`. They are still authored
 *     below, and each one returns of its own accord the moment its value is
 *     written in and the version moves again.
 */
export const returns: PolicyDocument = {
  key: 'returns',
  version: 2,
  effective_at: '2026-01-01',
  title: {
    ar: 'سياسة الاسترجاع والاستبدال',
    en: 'Returns and Exchange Policy',
    ckb: 'سیاسەتی گەڕاندنەوە و ئاڵوگۆڕ',
  },
  body: {
    ar: `## وثيقة الاسترجاع والاستبدال — المادة 4

هذه الوثيقة تبيّن متى يُقبل إرجاع منتج اشتُري من Levonis، وبأي شروط، ومن يتحمل كلفة الإرجاع، وماذا يحدث في كل حالة عملية يقع فيها الخلاف. النص العربي هو النص المعتمد، وما سواه ترجمة أمينة له بالترقيم نفسه.

### 4.1 التعريفات
- المتجر: {{LEVONIS_LEGAL_NAME}}، المشار إليه بـ Levonis.
- المنتج المعيب فعليًا: المنتج الذي لا يعمل أصلًا، أو يعمل بخلل ناتج عن عيب تصنيع، أو وصل مخالفًا لوصفه المنشور، أو وصل صنفًا غير الذي طُلب.
- الحالة الأصلية: حال المنتج لحظة تسليمه، بكل ما كان في الصندوق.
- التغليف الداخلي: علبة المنتج نفسها، بحشواتها وأكياسها وأغلفتها الواقية.
- التغليف الخارجي: الكرتون الذي وصل به الشحن، بشريطه وملصقاته وبياناته.
- تغيير الرأي: عدول الزبون عن الشراء لسبب لا يتعلق بعيب في المنتج ولا بمخالفته لوصفه.
- الوحدة: الجهاز الفعلي الواحد بسجله المستقل، كما تعرّفه وثيقة الضمان.
- تاريخ التسليم المسجل: التاريخ والوقت المسجلان في نظام المتجر لتسليم تلك الوحدة أو ذلك السطر من الطلب.

### 4.2 مدة تقديم طلب الإرجاع
- تُقدَّم طلبات الإرجاع خلال سبعة أيام من تاريخ التسليم المسجل، لا من تاريخ الطلب ولا من تاريخ الدفع.
- إذا كان الطلب يخص وحدة بعينها فالمدة تُحسب من تسليم تلك الوحدة، وإلا فمن تسليم سطر الطلب.
- العبرة بوقت تقديم الطلب في نظام المتجر. الطلب المقدم داخل المدة يبقى صالحًا ولو تأخرت مراجعة المتجر له إلى ما بعد انقضائها.
- بعد انقضاء السبعة أيام يُغلق باب الإرجاع نهائيًا، ويبقى الطريق الوحيد أمام الزبون هو الضمان وفق المادة 5 إن كان العطل عيب تصنيع.
- لا يُقبل طلب إرجاع على طلب لم يُسجَّل تسليمه بعد.

### 4.3 الإرجاع المجاني: الحالة الوحيدة وشروطها
الإرجاع المجاني لا يكون إلا لمنتج معيب فعليًا، ومُعادٍ كما وصل تمامًا. ويُشترط لقبوله اجتماع الآتي كله:

- أن يكون سبب الإرجاع عيبًا حقيقيًا في المنتج أو مخالفته لوصفه أو وصول صنف خاطئ أو ضررًا مثبتًا.
- ألا ينقص من محتويات الصندوق شيء: كل ملحق، وكل كيبل، وكل عدة وأداة، وكل قطعة احتياطية، وكل بطاقة أو دليل أو ملصق أو هدية مرافقة.
- أن يكون التغليف الداخلي سليمًا بحشواته وأغلفته.
- أن يكون التغليف الخارجي سليمًا كذلك، بشريطه وملصقاته.
- أن يكون الرقم التسلسلي مطابقًا للرقم المسجل على الطلب وغير ممسوح ولا مغيّر.
- ألا يكون المنتج قد استُعمل استعمالًا يتجاوز ما يلزم للتحقق من العيب.

نقص أي بند من هذه البنود يخرج الحالة من الإرجاع المجاني، وتُعامل وفق المواد 4.10 و4.11 و4.12.

### 4.4 كلفة إعادة الشحن
- كلفة إعادة المنتج إلى المتجر يتحملها الزبون في جميع الأحوال، بما فيها حالة المنتج المعيب فعليًا. مجانية الإرجاع تعني عدم استيفاء رسم أو غرامة على الإرجاع نفسه، لا تحمُّل المتجر أجرة النقل.
- أجور التوصيل والضرائب المرافقة تحددها شركات التوصيل، لا Levonis. المتجر ينقل ما تطلبه الشركة ولا يزيد عليه ولا يتحكم فيه.
- أجرة التوصيل المدفوعة في الطلب الأصلي لا تُرد عند الإرجاع، لأنها خدمة نُفّذت فعلًا.
- جميع كلف التوصيل على الزبون، إلا لأعضاء PRO والعضوية المميزة فوق قيمة الطلب البالغة {{PRO_FREE_DELIVERY_MIN_IQD}}، حيث يتحملها المتجر وفق ما هو مبيّن في وثيقة التوصيل.
- إذا اتفق الطرفان على استلام المنتج من عنوان الزبون، فكلفة الاستلام على الزبون ما لم ينص المتجر كتابةً على غير ذلك.
- تسليم المنتج المرتجع باليد إلى {{RETURN_DROP_OFF_LOCATION}} يُسقط كلفة النقل عن الطرفين.

### 4.5 الأسباب المقبولة للإرجاع
لا يقبل النظام إلا الأسباب الآتية، ويجب اختيار السبب الصحيح لأنه يحدد مسار المعالجة:

- منتج معيب: لا يعمل أو يعمل بخلل.
- عيب تصنيع: خلل ظهر تحت الاستعمال الطبيعي.
- مخالف للوصف: يختلف جوهريًا عن وصفه المنشور وقت الشراء.
- منتج خاطئ: وصل صنف غير المطلوب.
- ضرر شحن: ضرر ظاهر ناتج عن النقل، مع مراعاة المواد 4.16 إلى 4.19.

اختيار سبب غير صحيح لتجاوز شرط من شروط هذه الوثيقة يُعد إخلالًا بها ويُرفض الطلب على أساسه.

### 4.6 ما يجب أن يرفقه الزبون
- وصف مكتوب لما حدث، لا يزيد على ثلاثة آلاف حرف.
- صور واضحة للمنتج، وللعيب، وللتغليف الداخلي والخارجي، وللرقم التسلسلي.
- مقطع فيديو يُظهر العيب حين يكون العيب سلوكًا لا يظهر في صورة.
- يقبل النظام ستة ملفات على الأكثر مع الطلب الواحد، وتُحفظ في مساحة خاصة بالزبون لا يطلع عليها إلا هو وإدارة المتجر.
- إخفاء واقعة سقوط أو تسرب سائل أو فتح سابق للجهاز يُسقط الطلب ولو كان العيب موجودًا.

### 4.7 مسار معالجة الطلب
يمر طلب الإرجاع بالمراحل المسجلة الآتية، ولا ينتقل بينها إلا بقرار موظف مختص:

- مُقدَّم: سُجّل الطلب.
- قيد التقييم: تُراجع الحالة والأدلة.
- مقبول أو مرفوض: قرار معلل، والرفض لا يصدر بلا سبب مكتوب.
- قيد الاستلام: المنتج في طريقه إلى المتجر.
- مستلَم: وصل المنتج إلى المتجر.
- مفحوص: أُجري الفحص الفني على المنتج المرتجع.
- منجَز: صدر القرار النهائي بواحدة من النتائج الآتية: استبدال، أو إرجاع مبلغ، أو إصلاح، أو رفض معلل.

لا يُنفَّذ أي إرجاع مبلغ ولا أي استبدال قبل وصول المنتج إلى المتجر وفحصه. لا توجد موافقة تلقائية في أي مرحلة، ولا تُعد الموافقة على فتح الطلب موافقة على الإرجاع.

### 4.8 إرجاع المبلغ: وجهته وحسابه
- يُقيَّد المبلغ المسترجع في محفظة الزبون داخل المتجر. المتجر لا يعد بإعادة نقدية ولا بتحويل إلى بطاقة أو حساب بنكي، ولا يجوز الاحتجاج عليه بذلك.
- يُحسب المبلغ على أساس ما دُفع فعلًا عن ذلك السطر، منقوصًا منه حصته من خصومات الطلب كالكوبون والنقاط المستعملة.
- أجرة التوصيل لا تدخل في الحساب ولا تُرد.
- يُعتمد سعر الصرف المسجل على الطلب وقت إنشائه، لا سعر يوم الإرجاع.
- تُسحب نقاط الشراء الممنوحة عن الجزء المرتجع بنسبته، وتُعاد الكمية إلى المخزون.
- لا يُرجع المبلغ عن الوحدة الواحدة مرتين. القضية التي انتهت بإرجاع مبلغ تستنفد حق الإرجاع عن تلك الكمية، أما التي انتهت بإصلاح أو استبدال فلا تستنفده.

### 4.9 تغيير الرأي
لا يوجد في Levonis إرجاع لتغيير الرأي. المنتج السليم المطابق لوصفه لا يُرجَع لأن الزبون عدل عن شرائه، ولا لأنه وجد سعرًا أقل، ولا لأنه لم يعجبه شكله أو حجمه أو لونه بعد الاستلام، ولا لأنه اشترى نموذجًا وأراد نموذجًا آخر. نظام المتجر نفسه لا يقبل تسجيل طلب إرجاع بهذا السبب. ومن أراد التراجع فسبيله إلغاء الطلب قبل تسليمه وفق وثيقة الشراء.

### 4.10 الجهاز الذي استُعمل ويعمل
الجهاز الذي شُغّل واستُعمل وثبت أنه يعمل وفق مواصفاته لا يُقبل إرجاعه:

- الطباعة التجريبية والمعايرة والتشغيل لأكثر مما يلزم للتحقق من العيب استعمالٌ وليست فحصًا.
- استهلاك المواد المرفقة، أو تركيب فلمنت أو راتنج، أو تشغيل عمليات طباعة كاملة، كلها دليل على الاستعمال.
- إذا ظهر بعد ذلك عيب تصنيع فالمسار هو الضمان وفق المادة 5، لا الإرجاع.

### 4.11 نقص الملحقات أو التغليف
- نقص أي ملحق أو أداة أو قطعة احتياطية أو كيبل يُخرج الطلب من الإرجاع المجاني.
- التغليف الداخلي التالف أو المفقود يمنع قبول الإرجاع، لأن المنتج لا يمكن إعادة شحنه ولا بيعه بعد ذلك بحاله.
- التغليف الخارجي الذي رماه الزبون: يبقى الإرجاع ممكنًا في حالة العيب الحقيقي فقط إذا كان التغليف الداخلي سليمًا، ويتحمل الزبون كلفة تغليف بديل آمن.
- المتجر لا يقبل منتجًا مرتجعًا بلا تغليف يقيه من الضرر، وأي ضرر يقع أثناء الإعادة بسبب سوء التغليف على الزبون.
- عند قبول إرجاع ناقص المحتويات استثناءً بقرار من الإدارة، تُخصم قيمة الناقص من المبلغ المسترجع.

### 4.12 الأجهزة المستعملة والمجددة وOpen Box
- هذه الوحدات تُباع بوصف معلن لحالتها: درجتها، وساعات تشغيلها إن عُرفت، وما أُصلح فيها. الزبون يشتريها على هذا الوصف.
- لذلك لا تُقبل عليها مطالبة مخالفة الوصف، ونظام المتجر يرفضها بنصها.
- ويبقى مقبولًا عليها: المنتج الذي وصل معطلًا، أو وصل متضررًا، أو كان صنفًا خاطئًا. رفض هذه الحالات ليس معنى عبارة غير قابل للإرجاع.
- الضمان على هذه الوحدات هو المدة المعلنة لها، شهر أو اثنا عشر شهرًا، ولا تُباع عليها تمديدات.

### 4.13 المنتجات المباعة ضمن حزمة
- الحزمة تُرجَع كاملة أو لا تُرجَع. إرجاع الجزء الغالي من حزمة مخفّضة والاحتفاظ بالرخيص بسعر الحزمة خصمٌ لم يعرضه أحد.
- إرجاع الحزمة كاملة يفتح قضية عن كل مكوّن فيها، وتُحسب قيمة كل مكوّن من حصته المسجلة في سعر الحزمة لا من سعره المفرد.
- تُستثنى من ذلك المطالبة بعيب أو ضرر شحن في مكوّن واحد: تُقبل على ذلك المكوّن وحده، ولا تُعد إرجاعًا جزئيًا للحزمة، ولا تُستهلك بها حصة الحزمة من حق الإرجاع.

### 4.14 المنتجات المشتراة ضمن عرض أو تخفيض
- المنتج المشترى بسعر عرض تسري عليه المدة نفسها والشروط نفسها، دون زيادة ودون نقصان.
- المبلغ المسترجع هو ما دُفع فعلًا بسعر العرض، لا السعر الاعتيادي المعروض مشطوبًا.
- إذا كان العرض محدود الكمية فإن إلغاء الطلب أو إرجاعه يعيد الحصة إلى العرض، ولا يمنح الزبون حق إعادة الشراء بالسعر نفسه بعد انتهاء مدة العرض.
- الهدية أو النقاط الممنوحة مع العرض تُسحب بنسبة ما أُرجع.

### 4.15 خط المفاجأة والمنتجات غير المكشوفة
لا يُقبل طلب إرجاع على منتج مفاجأة قبل كشف محتواه في النظام، لأن مسار الإرجاع يعرض ما يُعاد فيكشف المحتوى قبل أوانه. بعد الكشف تسري عليه أحكام هذه الوثيقة كاملة.

### 4.16 الضرر أثناء النقل ومسؤولية المتجر
المتجر غير مسؤول عن الضرر الذي يقع أثناء النقل. وهذا يشمل صراحةً الضرر الواقع عند حدود إقليم كردستان أو عند أي نقطة تفتيش، حيث يُفتح الطرد ويُعاد تغليفه من جهة ليست المتجر وليست شركة التوصيل.

- تنتقل تبعة الهلاك والضرر إلى الزبون بتسليم الطرد إلى شركة التوصيل.
- المتجر يسلم الطرد سليمًا ومغلفًا، ويحتفظ بما يثبت ذلك عند الإرسال.
- المتجر لا يملك سلطة على إجراءات التفتيش، ولا على من يفتح الطرد، ولا على طريقة إعادة تغليفه، ولا على مدة حجزه.
- المطالبة عن ضرر النقل تُوجَّه إلى شركة التوصيل وفق شروطها، ويقدم المتجر للزبون ما لديه من مستندات الإرسال لدعم مطالبته.

### 4.17 ما يجب على الزبون فعله عند الاستلام
هذه الإجراءات شرط لقبول أي مطالبة بضرر نقل، وتركها يُسقطها:

- فحص الكرتون الخارجي أمام المندوب قبل التوقيع: هل هو مفتوح، هل شريطه مقطوع أو مُعاد لصقه، هل فيه انبعاج أو تمزق أو أثر بلل.
- تصوير الطرد من الخارج قبل فتحه.
- فتح الطرد أمام المندوب حيث تسمح طريقة التوصيل، وتصوير عملية الفتح بمقطع متصل غير مقطوع.
- التحقق من وجود كل ما في قائمة المحتويات، ومن سلامة التغليف الداخلي، ومن الرقم التسلسلي.
- تثبيت الملاحظة على وصل التوصيل أو رفض الاستلام عند وجود ضرر ظاهر.
- إبلاغ المتجر خلال أربع وعشرين ساعة من التسليم بالصور والمقاطع ورقم الطلب.

### 4.18 إذا لم يفعل الزبون ذلك
- التوقيع على الاستلام دون تحفظ مع وجود ضرر ظاهر في الكرتون يُسقط دعوى ضرر النقل.
- الطرد الذي فُتح بعد مغادرة المندوب بلا تصوير متصل لا تُقبل عليه مطالبة بنقص محتويات، لأن الواقعة لا تعود قابلة للإثبات.
- الإبلاغ بعد أربع وعشرين ساعة من التسليم يُضعف المطالبة، ولا يُقبل بعد مضي مدة الإرجاع في المادة 4.2.
- ما سبق لا يمنع مطالبة الضمان عن عيب تصنيع خفي وفق المادة 5.

### 4.19 الطرد الذي يصل مفتوحًا والرفض عند الباب
- الطرد الذي يصل مفتوحًا أو مُعاد تغليفه: من حق الزبون رفض استلامه، ورفضه عند الباب هو الإجراء الصحيح.
- الطرد المرفوض عند الباب يعود إلى المتجر، وتُراجع حالته عند وصوله، ويُبت في الطلب على أساس ما يظهر عند الفحص.
- كلفة الإعادة في حالة الرفض بسبب ضرر ظاهر موثق بالصور لا تُحمَّل على الزبون. أما الرفض بلا سبب من أسباب هذه الوثيقة فكلفة الذهاب والإياب على الزبون.
- تكرار رفض الاستلام بلا سبب من الحساب نفسه يعرّض الحساب إلى تقييد وسائل الدفع عند التسليم وفق وثيقة الشراء.

### 4.20 الاستبدال
- الاستبدال نتيجة من نتائج مسار الإرجاع لا مسار مستقل، ولا يُنفَّذ إلا بعد استلام المنتج وفحصه.
- يُستبدل المنتج بالصنف نفسه بحالته الجديدة إن توفر، فإن لم يتوفر عُرض على الزبون إرجاع المبلغ إلى محفظته.
- لا يُستبدل منتج بصنف آخر مختلف السعر إلا بقرار من الإدارة، وبتسوية الفرق قبل التنفيذ.
- مدة ضمان المنتج البديل هي ما تبقى من ضمان المنتج الأصلي، وفق المادة 5.4.

### 4.21 طلبات التجار المستقلين داخل ليفو برو
- طلبات التجار المستقلين مدفوعة مسبقًا من المحفظة، ولا يوجد فيها دفع عند التسليم ولا استلام من المخزن.
- شروط الإرجاع في هذه الطلبات محكومة بما أعلنه التاجر وبما ورد في وثيقة مجتمع ليفو، ودور المتجر فيها دور المنصة لا دور البائع.
- المتجر لا يتحمل ما يتفق عليه الطرفان خارج المنصة، ولا يضمن وعدًا لم يُسجَّل في الطلب.
- عند نزاع، يتدخل المتجر بناءً على طلب أحد الطرفين من الدعم، وفق ما هو مبيّن في وثيقة مجتمع ليفو.

### 4.22 الاستعمال السيئ لحق الإرجاع
- تقديم طلبات إرجاع متكررة بلا سبب حقيقي، أو تقديم أدلة مفبركة، أو إعادة منتج غير الذي سُلّم، أو إعادة جهاز بعد نزع قطعة منه، كلها إخلال بهذه الوثيقة.
- للمتجر في هذه الحالات رفض الطلب، ومطالبة الزبون بفرق القيمة، وتقييد مزايا الحساب وفق سياسة الاستعمال السيئ في وثيقة الشروط، مع بيان السبب وإتاحة الاعتراض.

### 4.23 ما لا تشمله هذه الوثيقة
- أعطال ما بعد السبعة أيام: مرجعها وثيقة الضمان، المادة 5.
- الإصلاح المدفوع خارج الضمان والخدمات الأخرى: مرجعها وثيقة خدمات ما بعد البيع.
- إلغاء الطلب قبل التسليم وتغيّر السعر قبل الدفع: مرجعها وثيقة الشراء.
- المنتجات الرقمية والخدمات: لا يسري عليها الإرجاع المادي المنصوص عليه هنا.

### 4.24 النفاذ واللغة
- إذا تعارض نص هذه الوثيقة مع وعد شفهي أو رسالة من موظف أو منشور تسويقي، فنص هذه الوثيقة هو المعتمد.
- عند اختلاف الترجمات يُرجع إلى النص العربي.
- يسري تعديل هذه الوثيقة على الطلبات المقدمة بعد تاريخ نفاذه، ولا يسري بأثر رجعي على طلب قائم.
- قناة التواصل المعتمدة لطلبات الإرجاع: {{LEVONIS_SUPPORT_CONTACT}}. عنوان الاستلام والتسليم: {{LEVONIS_SERVICE_ADDRESS}}.`,

    en: `## Returns and Exchange Document — Article 4

This document sets out when a product bought from Levonis may be returned, on what conditions, who bears the cost of the return, and what happens in each practical case where a dispute arises. The Arabic text is the authoritative text; this is a faithful translation of it with the same numbering.

### 4.1 Definitions
- The Store: {{LEVONIS_LEGAL_NAME}}, referred to as Levonis.
- Genuinely defective product: a product that does not work at all, or works with a malfunction caused by a manufacturing fault, or arrived differing from its published description, or arrived as an item other than the one ordered.
- Original condition: the state of the product at the moment of delivery, with everything that was in the box.
- Inner carton: the product box itself, with its inserts, bags and protective wrapping.
- Outer carton: the shipping carton in which the parcel arrived, with its tape, labels and markings.
- Change of mind: the customer withdrawing from the purchase for a reason unrelated to any defect in the product or any departure from its description.
- The Unit: one physical device with its own record, as defined in the Warranty document.
- Recorded delivery date: the date and time recorded in the store system for the delivery of that unit or that order line.

### 4.2 The window for filing a return request
- Return requests are filed within seven days of the recorded delivery date, not of the order date and not of the payment date.
- Where the request concerns a particular unit, the period runs from the delivery of that unit; otherwise from the delivery of the order line.
- What counts is the time the request is filed in the store system. A request filed within the window remains valid even if the store review of it runs past the window.
- After the seven days the return route is closed for good, and the only remaining route for the customer is the warranty under Article 5 where the failure is a manufacturing fault.
- No return request is accepted on an order whose delivery has not been recorded.

### 4.3 The free return: the only case, and its conditions
A free return exists only for a genuinely defective product returned exactly as it arrived. Its acceptance requires all of the following together:

- That the reason for the return is a genuine defect in the product, a departure from its description, delivery of the wrong item, or established damage.
- That nothing is missing from the contents of the box: every accessory, every cable, every tool and instrument, every spare part, every card, manual, label or accompanying gift.
- That the inner carton is intact, with its inserts and wrapping.
- That the outer carton is likewise intact, with its tape and labels.
- That the serial number matches the number recorded on the order and is neither erased nor altered.
- That the product has not been used beyond what is necessary to establish the defect.

The absence of any one of these takes the case out of the free return, and it is then treated under Articles 4.10, 4.11 and 4.12.

### 4.4 Return shipping cost
- The cost of returning the product to the store is borne by the customer in every case, including the case of a genuinely defective product. A free return means that no fee or penalty is charged for the return itself; it does not mean the store carries the carriage.
- Delivery charges and the taxes accompanying them are set by the delivery companies, not by Levonis. The store quotes what the company charges, adds nothing to it, and does not control it.
- The delivery charge paid on the original order is not refunded on a return, because it is a service that was actually performed.
- All delivery costs are on the customer, except for PRO and Premium members above an order value of {{PRO_FREE_DELIVERY_MIN_IQD}}, where the store carries them, as set out in the Delivery document.
- Where the parties agree that the product is collected from the customer address, the cost of collection is on the customer unless the store states otherwise in writing.
- Handing the returned product in person at {{RETURN_DROP_OFF_LOCATION}} removes the carriage cost for both parties.

### 4.5 Accepted reasons for a return
The system accepts only the following reasons, and the correct reason must be chosen because it determines the processing route:

- Defective product: it does not work, or works with a malfunction.
- Manufacturing fault: a defect that appeared under normal use.
- Not as described: it differs substantially from its published description at the time of purchase.
- Wrong product: an item other than the one ordered was delivered.
- Shipping damage: visible damage caused by transport, subject to Articles 4.16 to 4.19.

Choosing an incorrect reason in order to get around a condition of this document is a breach of it, and the request is refused on that ground.

### 4.6 What the customer must attach
- A written description of what happened, not exceeding three thousand characters.
- Clear photographs of the product, of the defect, of the inner and outer cartons, and of the serial number.
- A video showing the defect where the defect is a behaviour that a photograph cannot show.
- The system accepts at most six files with a single request, stored in a private area belonging to the customer which only they and store management can open.
- Concealing a drop, a liquid spill or an earlier opening of the device voids the request even where the defect exists.

### 4.7 The processing route
A return request passes through the following recorded stages, and moves between them only by the decision of a responsible member of staff:

- Requested: the request is recorded.
- Assessment: the case and the evidence are reviewed.
- Approved or rejected: a reasoned decision; a rejection is never issued without a written reason.
- Collection: the product is on its way to the store.
- Received: the product has reached the store.
- Inspected: the technical inspection of the returned product has been carried out.
- Resolved: the final decision is issued with one of the following outcomes: replacement, refund, repair, or a reasoned refusal.

No refund and no replacement is carried out before the product reaches the store and is inspected. There is no automatic approval at any stage, and accepting the opening of a request is not acceptance of the return.

### 4.8 The refund: its destination and its calculation
- The refunded amount is credited to the customer wallet inside the store. The store does not promise cash back, nor a transfer to a card or a bank account, and no claim to that effect may be made against it.
- The amount is calculated on what was actually paid for that line, less its share of order-level discounts such as a coupon and any points used.
- The delivery charge is not part of the calculation and is not refunded.
- The exchange rate recorded on the order at the time it was created is applied, not the rate on the day of the return.
- Purchase points granted for the returned portion are reversed proportionally, and the quantity is restored to stock.
- No unit is refunded twice. A case that ended in a refund exhausts the return entitlement for that quantity; a case that ended in a repair or a replacement does not exhaust it.

### 4.9 Change of mind
There is no change-of-mind return at Levonis. A sound product matching its description is not returned because the customer withdrew from the purchase, nor because they found a lower price, nor because they did not like its shape, size or colour after delivery, nor because they bought one model and now want another. The store system itself will not record a return request for that reason. Whoever wishes to withdraw does so by cancelling the order before its delivery, under the Purchase document.

### 4.10 A machine that was used and works
A device that was powered up, used, and shown to work to its specification is not accepted for return:

- Test printing, calibration, and running the machine beyond what is needed to establish a defect are use, not inspection.
- Consuming the supplied materials, loading filament or resin, or running complete print jobs are all evidence of use.
- Where a manufacturing fault appears afterwards, the route is the warranty under Article 5, not a return.

### 4.11 Missing accessories or packaging
- A missing accessory, tool, spare part or cable takes the request out of the free return.
- A damaged or missing inner carton prevents acceptance of the return, because the product can then neither be shipped nor sold on in that state.
- An outer carton the customer threw away: the return remains possible in a genuine-defect case only where the inner carton is intact, and the customer bears the cost of safe replacement packaging.
- The store does not accept a returned product without packaging that protects it, and any damage occurring during the return because of poor packing is on the customer.
- Where a return with missing contents is accepted exceptionally by a management decision, the value of what is missing is deducted from the refund.

### 4.12 Used, refurbished and Open Box devices
- These units are sold under a published description of their condition: their grade, their running hours where known, and what was repaired in them. The customer buys them on that description.
- A not-as-described claim is therefore not accepted on them, and the store system refuses it by name.
- What remains accepted on them: a unit that arrived dead, arrived damaged, or was the wrong item. Refusing those is not what the phrase not returnable means.
- The warranty on these units is the period published for them, one month or twelve months, and no extension is sold on them.

### 4.13 Products sold inside a bundle
- A bundle is returned whole or not at all. Returning the expensive half of a discounted bundle and keeping the cheap half at the bundle price is a discount nobody offered.
- Returning the whole bundle opens a case for each of its components, and the value of each component is computed from its recorded share of the bundle price, not from its stand-alone price.
- Excepted from this is a claim of a defect or shipping damage in a single component: it is accepted on that component alone, is not treated as a partial bundle return, and does not consume the bundle return entitlement.

### 4.14 Products bought in an offer or at a discount
- A product bought at an offer price is subject to the same window and the same conditions, neither more nor less.
- The refunded amount is what was actually paid at the offer price, not the regular price shown struck through.
- Where the offer is limited in quantity, cancelling or returning the order returns the slot to the offer, and does not entitle the customer to buy again at the same price after the offer window has closed.
- A gift or points granted with the offer are reversed in proportion to what was returned.

### 4.15 The mystery line and undisclosed products
No return request is accepted on a mystery product before its content has been revealed in the system, because the return route lists what is being sent back and would disclose the content before its time. After the reveal, this document applies to it in full.

### 4.16 Transit damage and the liability of the store
The store is not liable for damage occurring during transport. This expressly includes damage occurring at the Kurdistan Region border or at any checkpoint inspection, where the parcel is opened and repacked by a party that is neither the store nor the courier.

- Risk of loss and damage passes to the customer when the parcel is handed to the delivery company.
- The store hands over the parcel intact and packed, and keeps what establishes that at the time of dispatch.
- The store has no authority over inspection procedures, over who opens the parcel, over how it is repacked, or over how long it is held.
- A claim for transport damage is directed to the delivery company under its own terms, and the store provides the customer with the dispatch records it holds in support of that claim.

### 4.17 What the customer must do on delivery
These steps are a condition of any transport-damage claim, and omitting them forfeits it:

- Inspect the outer carton in front of the courier before signing: whether it is open, whether its tape is cut or re-applied, whether there is a dent, a tear or a trace of wetting.
- Photograph the parcel from the outside before opening it.
- Open the parcel in front of the courier where the delivery method allows, and record the opening in one continuous, uncut video.
- Verify that everything on the contents list is present, that the inner carton is intact, and that the serial number is correct.
- Record the objection on the delivery note, or refuse receipt, where there is visible damage.
- Notify the store within twenty-four hours of delivery with the photographs, the footage and the order number.

### 4.18 If the customer does not do that
- Signing for receipt without reservation where the carton is visibly damaged forfeits the transport-damage claim.
- A parcel opened after the courier has left, with no continuous recording, does not support a claim of missing contents, because the event can no longer be established.
- Notification later than twenty-four hours after delivery weakens the claim, and is not accepted at all after the return window in Article 4.2 has closed.
- None of the above prevents a warranty claim for a hidden manufacturing fault under Article 5.

### 4.19 A parcel that arrives open, and refusal at the door
- A parcel that arrives open or repacked: the customer is entitled to refuse it, and refusing it at the door is the correct step.
- A parcel refused at the door returns to the store, its condition is reviewed on arrival, and the request is decided on what the inspection shows.
- The cost of the return leg where the refusal is due to visible damage documented in photographs is not charged to the customer. Where the refusal has no ground under this document, the cost of both legs is on the customer.
- Repeated refusal without ground from the same account exposes that account to restriction of cash-on-delivery payment under the Purchase document.

### 4.20 Exchange
- An exchange is one of the outcomes of the return route, not a separate route, and is carried out only after the product has been received and inspected.
- The product is exchanged for the same item in its new condition where available; where it is not available, a refund to the customer wallet is offered.
- A product is not exchanged for a different item at a different price except by a management decision, with the difference settled before it is carried out.
- The warranty period of the replacement product is the remainder of the original product warranty, under Article 5.4.

### 4.21 Independent merchant orders inside Levo Pro
- Independent merchant orders are paid in advance from the wallet; there is no cash on delivery and no warehouse pickup on that route.
- The return terms of those orders are governed by what the merchant published and by the Levo Community document, and the role of the store in them is that of a platform, not of the seller.
- The store does not bear what the two parties agree off the platform, and does not guarantee a promise that was not recorded on the order.
- In a dispute, the store intervenes at the request of one of the parties to support, as set out in the Levo Community document.

### 4.22 Abuse of the return entitlement
- Filing repeated return requests without a genuine ground, submitting fabricated evidence, returning a product other than the one delivered, or returning a device after removing a part from it, are all breaches of this document.
- In such cases the store may refuse the request, claim the difference in value from the customer, and restrict account benefits under the abuse policy in the Terms document, stating the reason and allowing an objection.

### 4.23 What this document does not cover
- Failures after the seven days: the reference is the Warranty document, Article 5.
- Paid repair outside warranty and other services: the reference is the After-Sale Services document.
- Cancelling an order before delivery and a price change before payment: the reference is the Purchase document.
- Digital products and services: the physical return set out here does not apply to them.

### 4.24 Effect and language
- Where the text of this document conflicts with an oral promise, a message from a member of staff, or a marketing post, the text of this document prevails.
- Where translations differ, the Arabic text governs.
- An amendment to this document applies to requests filed after its effective date and has no retroactive effect on a pending request.
- Approved contact channel for return requests: {{LEVONIS_SUPPORT_CONTACT}}. Address for collection and handover: {{LEVONIS_SERVICE_ADDRESS}}.`,

    ckb: `## بەڵگەنامەی گەڕاندنەوە و ئاڵوگۆڕ — ماددەی 4

ئەم بەڵگەنامەیە ڕوون دەکاتەوە کەی بەرهەمێکی کڕدراو لە Levonis دەگەڕێندرێتەوە، بە چ مەرجێک، کێ تێچووی گەڕاندنەوە هەڵدەگرێت، و لە هەر حاڵەتێکی کردەییدا کە ناکۆکی تێدا ڕوودەدات چی ڕوودەدات. دەقی عەرەبی دەقی پەسەندکراوە و ئەمە وەرگێڕانێکی دڵسۆزی ئەوە بە هەمان ژمارەبەندی.

### 4.1 پێناسەکان
- فرۆشگا: {{LEVONIS_LEGAL_NAME}}، کە بە Levonis ئاماژەی پێدەکرێت.
- بەرهەمی بە ڕاستی کەموکووڕ: ئەو بەرهەمەی هەر کار ناکات، یان بە کەموکووڕییەک کار دەکات کە لە کەموکووڕی بەرهەمهێنانەوە هاتووە، یان جیاواز لە وەسفە بڵاوکراوەکەی گەیشتووە، یان جۆرێکی تر لە داواکراوەکە گەیشتووە.
- دۆخی سەرەتایی: دۆخی بەرهەمەکە لە ساتی گەیاندن، بە هەموو ئەوەی لە سندوقەکەدا بوو.
- پاکێجی ناوەوە: خودی قوتوی بەرهەمەکە، بە پڕکەرەوە و کیسە و پێچانەوە پارێزەرەکانی.
- پاکێجی دەرەوە: ئەو کارتۆنەی بارەکەی پێ گەیشتووە، بە تەیپ و لێدراوە و زانیارییەکانی.
- گۆڕینی بیر: پاشەکشەی کڕیار لە کڕینەکە بۆ هۆکارێک کە پەیوەندی بە کەموکووڕی بەرهەم یان جیاوازی لە وەسفەکەی نییە.
- یەکە: یەک ئامێری فیزیکی بە تۆماری سەربەخۆی خۆی، وەک لە بەڵگەنامەی گەرەنتیدا پێناسە کراوە.
- بەرواری تۆمارکراوی گەیاندن: ئەو بەروار و کاتەی لە سیستەمی فرۆشگادا بۆ گەیاندنی ئەو یەکە یان ئەو دێڕەی داواکاری تۆمارکراوە.

### 4.2 ماوەی پێشکەشکردنی داواکاری گەڕاندنەوە
- داواکاری گەڕاندنەوە لە ماوەی حەوت ڕۆژ لە بەرواری تۆمارکراوی گەیاندنەوە پێشکەش دەکرێت، نەک لە بەرواری داواکاری و نەک لە بەرواری پارەدانەوە.
- ئەگەر داواکارییەکە تایبەت بێت بە یەکەیەکی دیاریکراو، ماوەکە لە گەیاندنی ئەو یەکەیەوە دەژمێردرێت، ئەگەرنا لە گەیاندنی دێڕەکەی داواکارییەوە.
- بنەما کاتی پێشکەشکردنی داواکارییە لە سیستەمی فرۆشگا. ئەو داواکارییەی لەناو ماوەکەدا پێشکەش کراوە بەردەوام دەبێت لە هێزدا، تەنانەت ئەگەر پێداچوونەوەی فرۆشگا دوای کۆتایی ماوەکە بێت.
- دوای حەوت ڕۆژ دەرگای گەڕاندنەوە بە تەواوی دادەخرێت، و تەنها ڕێگای ماوە بۆ کڕیار گەرەنتییە بەپێی ماددەی 5 ئەگەر تێکچوونەکە کەموکووڕی بەرهەمهێنان بێت.
- هیچ داواکارییەکی گەڕاندنەوە لەسەر داواکارییەک وەرناگیرێت کە گەیاندنەکەی هێشتا تۆمار نەکراوە.

### 4.3 گەڕاندنەوەی بێبەرامبەر: تەنها حاڵەتەکە و مەرجەکانی
گەڕاندنەوەی بێبەرامبەر تەنها بۆ بەرهەمێکی بە ڕاستی کەموکووڕ هەیە کە بە تەواوی وەک خۆی گەیشتووە بگەڕێندرێتەوە. بۆ وەرگرتنی مەرجە هەموو ئەمانە پێکەوە کۆببنەوە:

- هۆکاری گەڕاندنەوە کەموکووڕییەکی ڕاستەقینەی بەرهەمەکە بێت یان جیاوازی لە وەسفەکەی یان گەیشتنی جۆرێکی هەڵە یان زیانێکی سەلمێنراو.
- هیچ شتێک لە ناوەڕۆکی سندوقەکە کەم نەبێت: هەموو پێداویستی، هەموو کێبڵێک، هەموو ئامراز و کەرەستەیەک، هەموو پارچەیەکی یەدەگ، هەموو کارت و ڕێبەر و لێدراوە و دیارییەکی هاوپێچ.
- پاکێجی ناوەوە ساغ بێت، بە پڕکەرەوە و پێچانەوەکانی.
- پاکێجی دەرەوەش بە هەمان شێوە ساغ بێت، بە تەیپ و لێدراوەکانی.
- ژمارە زنجیرەییەکە لەگەڵ ئەوەی لەسەر داواکارییەکە تۆمارکراوە یەک بێت و نە سڕابێتەوە و نە گۆڕابێت.
- بەرهەمەکە زیاتر لەوەی پێویستە بۆ سەلماندنی کەموکووڕییەکە بەکارنەهاتبێت.

نەبوونی هەر یەکێک لەمانە حاڵەتەکە لە گەڕاندنەوەی بێبەرامبەر دەردەهێنێت، و بەپێی ماددەکانی 4.10 و 4.11 و 4.12 مامەڵەی لەگەڵ دەکرێت.

### 4.4 تێچووی گەڕاندنەوەی بار
- تێچووی گەڕاندنەوەی بەرهەمەکە بۆ فرۆشگا لە هەموو حاڵەتێکدا لەسەر کڕیارە، لەوانەش حاڵەتی بەرهەمی بە ڕاستی کەموکووڕ. بێبەرامبەری گەڕاندنەوە واتای وەرنەگرتنی کرێ یان سزا لەسەر خودی گەڕاندنەوەکەیە، نەک هەڵگرتنی کرێی گواستنەوە لەلایەن فرۆشگاوە.
- کرێ و باجی گەیاندن لەلایەن کۆمپانیاکانی گەیاندنەوە دیاری دەکرێن نەک لەلایەن Levonis ەوە. فرۆشگا ئەوە دەڵێت کە کۆمپانیاکە داوای دەکات، هیچی بۆ زیاد ناکات و کۆنترۆڵی ناکات.
- ئەو کرێی گەیاندنەی لە داواکاری سەرەکیدا دراوە لە کاتی گەڕاندنەوەدا ناگەڕێندرێتەوە، چونکە خزمەتگوزارییەکە بە ڕاستی جێبەجێ کراوە.
- هەموو تێچووەکانی گەیاندن لەسەر کڕیارن، جگە لە ئەندامانی PRO و ئەندامێتی تایبەت لە سەرووی بەهای داواکاری {{PRO_FREE_DELIVERY_MIN_IQD}}، کە فرۆشگا هەڵیدەگرێت، بەپێی ئەوەی لە بەڵگەنامەی گەیاندن هاتووە.
- ئەگەر هەردوو لا ڕێک کەوتن کە بەرهەمەکە لە ناونیشانی کڕیارەوە وەربگیرێت، تێچووی وەرگرتن لەسەر کڕیارە مەگەر فرۆشگا بە نووسراوی پێچەوانەی بڵێت.
- پێدانی بەرهەمە گەڕێنراوەکە بە دەست لە {{RETURN_DROP_OFF_LOCATION}} تێچووی گواستنەوە لەسەر هەردوو لا لادەبات.

### 4.5 هۆکارە پەسەندکراوەکانی گەڕاندنەوە
سیستەمەکە تەنها ئەم هۆکارانە وەردەگرێت، و دەبێت هۆکاری ڕاست هەڵبژێردرێت چونکە ڕێچکەی کارکردن دیاری دەکات:

- بەرهەمی کەموکووڕ: کار ناکات یان بە کەموکووڕییەوە کار دەکات.
- کەموکووڕی بەرهەمهێنان: کەموکووڕییەک لە بەکارهێنانی ئاسایی دەرکەوتووە.
- جیاواز لە وەسف: بە شێوەیەکی بنەڕەتی جیاوازە لە وەسفە بڵاوکراوەکەی لە کاتی کڕین.
- بەرهەمی هەڵە: جۆرێکی جیاواز لە داواکراوەکە گەیشتووە.
- زیانی گواستنەوە: زیانێکی دیار کە لە گواستنەوەوە هاتووە، بە ڕەچاوکردنی ماددەکانی 4.16 تا 4.19.

هەڵبژاردنی هۆکارێکی نادروست بۆ تێپەڕاندنی مەرجێکی ئەم بەڵگەنامەیە پێشێلکارییە و داواکارییەکە لەسەر ئەو بنەمایە ڕەت دەکرێتەوە.

### 4.6 ئەوەی پێویستە کڕیار هاوپێچی بکات
- وەسفێکی نووسراو لەوەی ڕوویداوە، کە لە سێ هەزار پیت زیاتر نەبێت.
- وێنەی ڕوون بۆ بەرهەمەکە، بۆ کەموکووڕییەکە، بۆ پاکێجی ناوەوە و دەرەوە، و بۆ ژمارە زنجیرەییەکە.
- ڤیدیۆیەک کە کەموکووڕییەکە نیشان بدات کاتێک کەموکووڕییەکە ڕەفتارێکە کە لە وێنەدا دەرناکەوێت.
- سیستەمەکە لەگەڵ یەک داواکاریدا زۆرترین شەش فایل وەردەگرێت، و لە شوێنێکی تایبەتی کڕیاردا هەڵدەگیرێن کە تەنها خۆی و بەڕێوەبەرایەتی فرۆشگا دەیبیننەوە.
- شاردنەوەی کەوتن یان ڕژانی شلە یان کردنەوەی پێشووی ئامێرەکە داواکارییەکە پووچ دەکاتەوە، تەنانەت ئەگەر کەموکووڕییەکە هەبێت.

### 4.7 ڕێچکەی کارکردن لەسەر داواکاری
داواکاری گەڕاندنەوە بەم قۆناغە تۆمارکراوانەدا تێدەپەڕێت، و تەنها بە بڕیاری کارمەندێکی بەرپرس لە نێوانیاندا دەجوڵێت:

- پێشکەشکراو: داواکارییەکە تۆمار کراوە.
- لە ژێر هەڵسەنگاندن: حاڵەتەکە و بەڵگەکان پێداچوونەوەیان بۆ دەکرێت.
- پەسەندکراو یان ڕەتکراوە: بڕیارێکی هۆکاردار، و ڕەتکردنەوە بەبێ هۆکاری نووسراو دەرناچێت.
- لە ژێر وەرگرتن: بەرهەمەکە لە ڕێگای فرۆشگایە.
- وەرگیراو: بەرهەمەکە گەیشتووەتە فرۆشگا.
- پشکنراو: پشکنینی تەکنیکی لەسەر بەرهەمە گەڕێنراوەکە ئەنجام دراوە.
- تەواوبوو: بڕیاری کۆتایی دەرچووە بە یەکێک لەم ئەنجامانە: گۆڕینەوە، گەڕاندنەوەی بڕی پارە، چاککردن، یان ڕەتکردنەوەی هۆکاردار.

هیچ گەڕاندنەوەی پارە و هیچ گۆڕینەوەیەک پێش گەیشتنی بەرهەمەکە بە فرۆشگا و پشکنینی جێبەجێ ناکرێت. لە هیچ قۆناغێکدا پەسەندکردنی خۆکار نییە، و پەسەندکردنی کردنەوەی داواکارییەکە پەسەندکردنی گەڕاندنەوەکە نییە.

### 4.8 گەڕاندنەوەی پارە: شوێنی و ژماردنی
- بڕە گەڕێنراوەکە لە جزدانی کڕیاردا لەناو فرۆشگا تۆمار دەکرێت. فرۆشگا بەڵێنی گەڕاندنەوەی نەقدی نادات، نە گواستنەوە بۆ کارت یان هەژماری بانکی، و ناکرێت بەوە پێوانەی لەسەر بکرێت.
- بڕەکە لەسەر بنەمای ئەوەی بە ڕاستی بۆ ئەو دێڕە دراوە دەژمێردرێت، کەم دەکرێتەوە بەشەکەی لە داشکاندنەکانی داواکاری وەک کۆپۆن و خاڵە بەکارهاتووەکان.
- کرێی گەیاندن ناچێتە ناو ژماردنەکە و ناگەڕێندرێتەوە.
- ئەو نرخی گۆڕینەوەی دراو کە لە کاتی دروستکردنی داواکارییەکەدا تۆمارکراوە پەیڕەو دەکرێت، نەک نرخی ڕۆژی گەڕاندنەوە.
- خاڵەکانی کڕین بۆ ئەو بەشەی گەڕێنراوەتەوە بە ڕێژە لادەبرێن، و بڕەکە دەگەڕێتەوە ناو کۆگا.
- هیچ یەکەیەک دوو جار پارەی بۆ ناگەڕێندرێتەوە. ئەو حاڵەتەی بە گەڕاندنەوەی پارە کۆتایی هاتووە مافی گەڕاندنەوەی ئەو بڕە تەواو دەکات، بەڵام ئەوەی بە چاککردن یان گۆڕینەوە کۆتایی هاتووە تەواوی ناکات.

### 4.9 گۆڕینی بیر
لە Levonis گەڕاندنەوە بەهۆی گۆڕینی بیرەوە بوونی نییە. بەرهەمی ساغ کە لەگەڵ وەسفەکەی دەگونجێت ناگەڕێندرێتەوە لەبەر ئەوەی کڕیار لە کڕینەکە پاشەکشەی کردووە، نە لەبەر ئەوەی نرخێکی کەمتری دۆزیوەتەوە، نە لەبەر ئەوەی دوای وەرگرتن شێوە یان قەبارە یان ڕەنگەکەی پێ خۆش نەبووە، نە لەبەر ئەوەی مۆدێلێکی کڕیوە و ئێستا مۆدێلێکی تری دەوێت. خودی سیستەمی فرۆشگا داواکاری گەڕاندنەوە بەم هۆکارە تۆمار ناکات. ئەوەی بیەوێت پاشەکشە بکات، ڕێگاکەی هەڵوەشاندنەوەی داواکارییەکەیە پێش گەیاندنی، بەپێی بەڵگەنامەی کڕین.

### 4.10 ئامێرێک کە بەکارهاتووە و کار دەکات
ئەو ئامێرەی کارپێکراوە و بەکارهاتووە و سەلمێنراوە کە بەپێی تایبەتمەندییەکانی کار دەکات بۆ گەڕاندنەوە وەرناگیرێت:

- چاپی تاقیکردنەوە و کالیبرەکردن و کارپێکردن زیاتر لەوەی پێویستە بۆ سەلماندنی کەموکووڕی، بەکارهێنانە نەک پشکنین.
- بەکارهێنانی ئەو ماددانەی لەگەڵ ئامێرەکەدا هاتوون، یان دانانی فیلەمێنت یان ڕەزین، یان جێبەجێکردنی چاپی تەواو، هەموویان بەڵگەن لەسەر بەکارهێنان.
- ئەگەر دواتر کەموکووڕی بەرهەمهێنان دەرکەوت، ڕێگاکە گەرەنتییە بەپێی ماددەی 5، نەک گەڕاندنەوە.

### 4.11 کەمی پێداویستی یان پاکێج
- کەمی هەر پێداویستی یان ئامراز یان پارچەی یەدەگ یان کێبڵێک داواکارییەکە لە گەڕاندنەوەی بێبەرامبەر دەردەهێنێت.
- پاکێجی ناوەوەی زیانلێکەوتوو یان ونبوو ڕێگە لە وەرگرتنی گەڕاندنەوەکە دەگرێت، چونکە بەرهەمەکە دواتر نە دەنێردرێتەوە و نە بەو دۆخە دەفرۆشرێت.
- پاکێجی دەرەوە کە کڕیار فڕێیداوە: گەڕاندنەوە تەنها لە حاڵەتی کەموکووڕی ڕاستەقینەدا دەکرێت ئەگەر پاکێجی ناوەوە ساغ بێت، و کڕیار تێچووی پاکێجێکی جێگرەوەی پارێزەر هەڵدەگرێت.
- فرۆشگا بەرهەمی گەڕێنراوە بەبێ پاکێجێک کە بیپارێزێت وەرناگرێت، و هەر زیانێک لە کاتی گەڕاندنەوەدا بەهۆی پاکێجی خراپەوە ڕوو بدات لەسەر کڕیارە.
- ئەگەر بە بڕیاری بەڕێوەبەرایەتی گەڕاندنەوەیەکی کەم ناوەڕۆک بە دەرەنجامێکی نائاسایی وەرگیرا، بەهای ئەوەی کەمە لە بڕە گەڕێنراوەکە کەم دەکرێتەوە.

### 4.12 ئامێرە بەکارهاتوو و چاککراوەوە و Open Box
- ئەم یەکانە بە وەسفێکی ڕاگەیەنراوی دۆخیان دەفرۆشرێن: پلەیان، کاتژمێرەکانی کارکردنیان ئەگەر زانرابن، و ئەوەی تێیاندا چاککراوە. کڕیار لەسەر ئەو وەسفە دەیانکڕێت.
- بۆیە داواکاری جیاوازی لە وەسف لەسەریان وەرناگیرێت، و سیستەمی فرۆشگا بە ناوی خۆی ڕەتی دەکاتەوە.
- ئەوەی لەسەریان پەسەند دەمێنێتەوە: ئەو یەکەیەی مردوو گەیشتووە، یان زیانلێکەوتوو گەیشتووە، یان جۆری هەڵە بووە. ڕەتکردنەوەی ئەم حاڵەتانە واتای دەستەواژەی ناگەڕێندرێتەوە نییە.
- گەرەنتی لەسەر ئەم یەکانە ئەو ماوەیەیە کە بۆیان ڕاگەیەنراوە، یەک مانگ یان دوانزە مانگ، و هیچ درێژکردنەوەیەکیان لەسەر نافرۆشرێت.

### 4.13 بەرهەمەکانی ناو پاکێجی کۆمەڵ
- پاکێجی کۆمەڵ بە تەواوی دەگەڕێندرێتەوە یان هەر ناگەڕێندرێتەوە. گەڕاندنەوەی بەشە گرانەکەی پاکێجێکی داشکێنراو و هێشتنەوەی بەشە هەرزانەکە بە نرخی پاکێج، داشکاندنێکە کە کەس پێشکەشی نەکردووە.
- گەڕاندنەوەی هەموو پاکێجەکە بۆ هەر پێکهاتەیەکی حاڵەتێک دەکاتەوە، و بەهای هەر پێکهاتەیەک لە بەشە تۆمارکراوەکەی لە نرخی پاکێجەکەدا دەژمێردرێت نەک لە نرخی تاکەکەی.
- لەمە جیا دەکرێتەوە داواکاری کەموکووڕی یان زیانی گواستنەوە لە یەک پێکهاتەدا: تەنها لەسەر ئەو پێکهاتەیە وەردەگیرێت، وەک گەڕاندنەوەی بەشەکی پاکێج دانانرێت، و مافی گەڕاندنەوەی پاکێجەکەی پێ تەواو نابێت.

### 4.14 بەرهەمە کڕدراوەکان لە پێشکەشکردن یان داشکاندندا
- بەرهەمی کڕدراو بە نرخی پێشکەشکردن هەمان ماوە و هەمان مەرجی لەسەرە، نە زیاتر نە کەمتر.
- بڕە گەڕێنراوەکە ئەوەیە کە بە ڕاستی بە نرخی پێشکەشکردن دراوە، نەک ئەو نرخە ئاسایییەی بە هێڵ بەسەردا نیشان دراوە.
- ئەگەر پێشکەشکردنەکە بڕی سنووردار بێت، هەڵوەشاندنەوە یان گەڕاندنەوەی داواکارییەکە بەشەکە دەگەڕێنێتەوە بۆ پێشکەشکردنەکە، و مافی کڕینەوە بە هەمان نرخ دوای کۆتاییهاتنی ماوەی پێشکەشکردن بە کڕیار نادات.
- ئەو دیاری یان خاڵانەی لەگەڵ پێشکەشکردنەکە دراون بە ڕێژەی ئەوەی گەڕێنراوەتەوە لادەبرێن.

### 4.15 هێڵی سەرسوڕهێنەر و بەرهەمە ئاشکرانەکراوەکان
هیچ داواکارییەکی گەڕاندنەوە لەسەر بەرهەمی سەرسوڕهێنەر پێش ئاشکرابوونی ناوەڕۆکەکەی لە سیستەمدا وەرناگیرێت، چونکە ڕێچکەی گەڕاندنەوە ئەوە نیشان دەدات کە دەگەڕێندرێتەوە و ناوەڕۆکەکە پێش کاتی خۆی ئاشکرا دەکات. دوای ئاشکرابوون ئەم بەڵگەنامەیە بە تەواوی لەسەری جێبەجێ دەبێت.

### 4.16 زیانی کاتی گواستنەوە و بەرپرسیارێتی فرۆشگا
فرۆشگا بەرپرسیار نییە لەو زیانەی لە کاتی گواستنەوەدا ڕوودەدات. ئەمە بە ڕوونی ئەو زیانە دەگرێتەوە کە لە سنووری هەرێمی کوردستان یان لە هەر خاڵێکی پشکنیندا ڕوودەدات، لەو شوێنەی بارەکە لەلایەن لایەنێکەوە دەکرێتەوە و دووبارە پاکێج دەکرێت کە نە فرۆشگایە و نە کۆمپانیای گەیاندن.

- مەترسی لەناوچوون و زیان بە پێدانی بارەکە بە کۆمپانیای گەیاندن دەگوازرێتەوە بۆ کڕیار.
- فرۆشگا بارەکە ساغ و پاکێجکراو دەدات، و ئەوەی ئەوە دەسەلمێنێت لە کاتی ناردندا هەڵدەگرێت.
- فرۆشگا هیچ دەسەڵاتێکی بەسەر ڕێکاری پشکنیندا نییە، نە بەسەر ئەو کەسەی بارەکە دەکاتەوە، نە بەسەر شێوازی دووبارە پاکێجکردنی، نە بەسەر ماوەی ڕاگرتنی.
- داواکاری زیانی گواستنەوە ئاڕاستەی کۆمپانیای گەیاندن دەکرێت بەپێی مەرجەکانی خۆی، و فرۆشگا ئەو تۆمارانەی ناردن کە لای هەیە پێشکەشی کڕیار دەکات بۆ پشتیوانی لە داواکارییەکەی.

### 4.17 ئەوەی پێویستە کڕیار لە کاتی وەرگرتندا بیکات
ئەم هەنگاوانە مەرجی هەر داواکارییەکی زیانی گواستنەوەن، و بەجێهێشتنیان مافەکە لەناو دەبات:

- پشکنینی کارتۆنی دەرەوە لەبەردەم نێردراوەکەدا پێش واژووکردن: ئایا کراوەیە، ئایا تەیپەکەی بڕاوە یان دووبارە لکێندراوەتەوە، ئایا کوتان یان دڕان یان شوێنی تەڕی تێدایە.
- وێنەگرتنی بارەکە لە دەرەوە پێش کردنەوەی.
- کردنەوەی بارەکە لەبەردەم نێردراوەکەدا لەو شوێنانەی شێوازی گەیاندن ڕێگە دەدات، و تۆمارکردنی کردنەوەکە بە ڤیدیۆیەکی بەردەوام و نەبڕاو.
- دڵنیابوون لە بوونی هەموو ئەوەی لە لیستی ناوەڕۆکدایە، لە ساغی پاکێجی ناوەوە، و لە ژمارە زنجیرەییەکە.
- تۆمارکردنی تێبینییەکە لەسەر پسوولەی گەیاندن، یان ڕەتکردنەوەی وەرگرتن، لە کاتی بوونی زیانی دیار.
- ئاگادارکردنەوەی فرۆشگا لە ماوەی بیست و چوار کاتژمێر دوای گەیاندن بە وێنە و ڤیدیۆ و ژمارەی داواکاری.

### 4.18 ئەگەر کڕیار ئەوەی نەکرد
- واژووکردن لەسەر وەرگرتن بەبێ تێبینی لە کاتێکدا زیانی دیار لە کارتۆنەکەدا هەبێت، داواکاری زیانی گواستنەوە لەناو دەبات.
- ئەو بارەی دوای ڕۆیشتنی نێردراوەکە کراوەتەوە و تۆمارکردنێکی بەردەوامی نییە، داواکاری کەمی ناوەڕۆکی لەسەر وەرناگیرێت، چونکە ڕووداوەکە چیتر ناسەلمێنرێت.
- ئاگادارکردنەوە دوای بیست و چوار کاتژمێر لە گەیاندن داواکارییەکە لاواز دەکات، و دوای کۆتاییهاتنی ماوەی گەڕاندنەوەی ماددەی 4.2 هەر وەرناگیرێت.
- هیچ لەوانەی سەرەوە ڕێگە لە داواکاری گەرەنتی بۆ کەموکووڕی بەرهەمهێنانی شاراوە ناگرێت بەپێی ماددەی 5.

### 4.19 ئەو بارەی کراوە دەگات و ڕەتکردنەوە لە بەردەرگا
- ئەو بارەی کراوە یان دووبارە پاکێجکراو دەگات: کڕیار مافی هەیە ڕەتی بکاتەوە، و ڕەتکردنەوەی لە بەردەرگا هەنگاوی ڕاستە.
- ئەو بارەی لە بەردەرگا ڕەت دەکرێتەوە بۆ فرۆشگا دەگەڕێتەوە، دۆخەکەی لە کاتی گەیشتندا پێداچوونەوەی بۆ دەکرێت، و داواکارییەکە لەسەر ئەوەی پشکنین دەریدەخات بڕیاری لەسەر دەدرێت.
- تێچووی گەڕاندنەوە لە حاڵەتی ڕەتکردنەوە بەهۆی زیانی دیاری بە وێنە تۆمارکراو، لەسەر کڕیار دانانرێت. بەڵام ڕەتکردنەوە بەبێ هۆکارێک لە هۆکارەکانی ئەم بەڵگەنامەیە، تێچووی ڕۆیشتن و گەڕانەوە لەسەر کڕیارە.
- دووبارەبوونەوەی ڕەتکردنەوەی وەرگرتن بەبێ هۆکار لە هەمان هەژمارەوە، ئەو هەژمارە ڕووبەڕووی سنووردارکردنی پارەدان لە کاتی گەیاندن دەکاتەوە بەپێی بەڵگەنامەی کڕین.

### 4.20 ئاڵوگۆڕ
- ئاڵوگۆڕ یەکێکە لە ئەنجامەکانی ڕێچکەی گەڕاندنەوە نەک ڕێچکەیەکی سەربەخۆ، و تەنها دوای وەرگرتن و پشکنینی بەرهەمەکە جێبەجێ دەکرێت.
- بەرهەمەکە بە هەمان جۆر لە دۆخی نوێیدا دەگۆڕدرێتەوە ئەگەر بەردەست بێت، و ئەگەر بەردەست نەبوو گەڕاندنەوەی پارە بۆ جزدانی کڕیار پێشکەش دەکرێت.
- بەرهەمێک بە جۆرێکی تر بە نرخێکی جیاواز ناگۆڕدرێتەوە مەگەر بە بڕیاری بەڕێوەبەرایەتی، و بە ڕێککەوتنی جیاوازییەکە پێش جێبەجێکردن.
- ماوەی گەرەنتی بەرهەمە جێگرەوەکە ئەوەیە کە لە گەرەنتی بەرهەمە سەرەکییەکە ماوەتەوە، بەپێی ماددەی 5.4.

### 4.21 داواکاری بازرگانە سەربەخۆکان لەناو لێڤۆ پرۆ
- داواکاری بازرگانە سەربەخۆکان پێشوەخت لە جزدانەوە پارەیان دراوە، و پارەدان لە کاتی گەیاندن و وەرگرتن لە کۆگا لەو ڕێگایەدا نییە.
- مەرجەکانی گەڕاندنەوە لەم داواکارییانەدا بەو شێوەیە ڕێکدەخرێن کە بازرگانەکە ڕایگەیاندووە و بەپێی بەڵگەنامەی کۆمەڵگەی لێڤۆ، و ڕۆڵی فرۆشگا تێیدا ڕۆڵی پلاتفۆرمە نەک ڕۆڵی فرۆشیار.
- فرۆشگا بەرپرسیار نییە لەوەی هەردوو لا لە دەرەوەی پلاتفۆرمەکە ڕێکی دەکەون، و بەڵێنێک ناسەلمێنێت کە لە داواکارییەکەدا تۆمار نەکراوە.
- لە کاتی ناکۆکیدا، فرۆشگا بە داواکاری یەکێک لە لایەنەکان لە پشتگیری، دەستێوەردان دەکات، بەپێی ئەوەی لە بەڵگەنامەی کۆمەڵگەی لێڤۆ هاتووە.

### 4.22 خراپ بەکارهێنانی مافی گەڕاندنەوە
- پێشکەشکردنی داواکاری گەڕاندنەوەی دووبارە بەبێ هۆکاری ڕاستەقینە، پێشکەشکردنی بەڵگەی ساختە، گەڕاندنەوەی بەرهەمێک جیاواز لەوەی پێدراوە، یان گەڕاندنەوەی ئامێرێک دوای لابردنی پارچەیەکی، هەموویان پێشێلکردنی ئەم بەڵگەنامەیەن.
- لەم حاڵەتانەدا فرۆشگا دەتوانێت داواکارییەکە ڕەت بکاتەوە، جیاوازی بەهاکە لە کڕیار داوا بکات، و سوودەکانی هەژمارەکە سنووردار بکات بەپێی سیاسەتی خراپ بەکارهێنان لە بەڵگەنامەی مەرجەکاندا، لەگەڵ ڕوونکردنەوەی هۆکارەکە و ڕێگەدان بە ناڕەزایی.

### 4.23 ئەوەی ئەم بەڵگەنامەیە ناگرێتەوە
- تێکچوونەکانی دوای حەوت ڕۆژ: سەرچاوەکەیان بەڵگەنامەی گەرەنتییە، ماددەی 5.
- چاککردنی پارەدراوی دەرەوەی گەرەنتی و خزمەتگوزارییەکانی تر: سەرچاوەکەیان بەڵگەنامەی خزمەتگوزاری دوای فرۆشتنە.
- هەڵوەشاندنەوەی داواکاری پێش گەیاندن و گۆڕانی نرخ پێش پارەدان: سەرچاوەکەیان بەڵگەنامەی کڕینە.
- بەرهەمە دیجیتاڵییەکان و خزمەتگوزارییەکان: ئەو گەڕاندنەوە فیزیکییەی لێرە هاتووە لەسەریان جێبەجێ نابێت.

### 4.24 کارپێکردن و زمان
- ئەگەر دەقی ئەم بەڵگەنامەیە لەگەڵ بەڵێنێکی زارەکی یان نامەیەکی کارمەند یان بڵاوکراوەیەکی بازرگانی ناکۆک بوو، دەقی ئەم بەڵگەنامەیە پەسەندە.
- لە کاتی جیاوازی وەرگێڕانەکاندا دەقی عەرەبی بنەمایە.
- گۆڕانکاری لەم بەڵگەنامەیەدا لەسەر ئەو داواکارییانە جێبەجێ دەبێت کە دوای بەرواری کارپێکردنی پێشکەش دەکرێن، و کاریگەری دواکەوتووی لەسەر داواکارییەکی کراوە نییە.
- کەناڵی پەیوەندی پەسەندکراو بۆ داواکاری گەڕاندنەوە: {{LEVONIS_SUPPORT_CONTACT}}. ناونیشانی وەرگرتن و پێدان: {{LEVONIS_SERVICE_ADDRESS}}.`,
  },
};
