import type { PolicyDocument } from './types';

/**
 * DELIVERY, SHIPPING AND FEES — article 3 of the corpus.
 *
 * This document carries three of the owner's eight clauses (transit damage,
 * who sets the fee, who pays it), so it is the one a courier or a bank is
 * most likely to be shown. Everything in it was read out of the code first:
 *
 *   * The three checkout methods and their published estimates come from
 *     SETTING_DEFAULTS.checkoutDeliveryMethods in worker/lib/settings.ts —
 *     standard / personal / pickup. They are ADMIN-EDITABLE, which is why
 *     article 3.3 states the figures as "published at the effective date"
 *     and makes the checkout screen, not this text, the authority on price.
 *   * The four shipping types and their very different timings come from
 *     packages/pricing/src/shippingType.ts and cartShippingMethods. The cart
 *     holds exactly one type, so 3.6 says so.
 *   * The PRO / PREMIUM waiver, the approved-default-address condition and
 *     the subsidy ceiling are quoteShipping() in packages/shipping/src.
 *     Both thresholds are owner configuration and an admin benefit rule can
 *     replace them outright, so they are placeholders here rather than the
 *     75,000 / 150,000 that happen to be seeded today.
 *   * The cash-on-delivery tax in 3.22 is ADMIN-EDITABLE exactly like the
 *     delivery fees above: codTaxPerBlockIqd / codTaxBlockIqd are
 *     `admin_settings` rows in worker/lib/settings.ts, both published in
 *     PUBLIC_SETTING_KEYS so a sentence can quote the CONFIGURED rate.
 *     packages/shipping/src/codTax.ts holds only the unconfigured default
 *     and takes the rate as an argument. This note once said the opposite —
 *     "hardcoded constants ... not settings" — and that sentence is why 3.22
 *     went on promising six thousand per five hundred thousand after the
 *     owner halved the charge. So 3.22 states NO figure: it defers
 *     to the checkout screen the way 3.3 does, and it must stay that way.
 *     A `{{TOKEN}}` is not the way round it either. ./render.ts now WITHHOLDS
 *     any line that still carries one, so a token no longer reaches the
 *     customer as literal braces — but withholding is silence, not a figure,
 *     and a clause that named the rate would still have to be re-published
 *     every time the owner edited the setting. The deferral stands.
 *
 * WHY 3.35 EXISTS. worker/lib/delivery/ has createShipment and getShipment
 * and nothing else — there is no reschedule endpoint and no reroute call on
 * the DeliveryDriver interface, and sweepDeliveryStatuses only ever READS
 * the courier's word. So the store genuinely cannot move a parcel that is
 * already with the courier, and the document says that plainly instead of
 * promising a service the owner would then have to perform by phone.
 *
 * WHY 3.11 IS WORDED THE WAY IT IS. sync.ts leaves the order's stage
 * untouched on error and on an unmapped status. A document that promised
 * live tracking would be describing a system that deliberately says nothing
 * when it does not know, so 3.11 describes that silence as the safeguard it
 * is.
 *
 * Customs (3.23) has NO engine in this worker. The article therefore states
 * who bears such a charge if one arises and refuses to quantify it.
 *
 * VERSION 3 — WHY IT MOVED. Two corrections a customer could see on the
 * page; the archive keeps version 2 byte for byte.
 *   * THE NAME. The store is written «Levonis», in Latin script, in all three
 *     languages. 4 transliterated occurrences left the body here. Where the
 *     name carried an Arabic or Sorani affix the affix was detached rather than
 *     swallowed by the replacement, so the sentence still parses.
 *   * THE UNKNOWNS. 18 lines in this document still state a
 *     fact the owner has not given, so ./render.ts WITHHOLDS them from the published
 *     text rather than show a customer a `{{TOKEN}}`. They are still authored
 *     below, and each one returns of its own accord the moment its value is
 *     written in and the version moves again.
 */
export const delivery: PolicyDocument = {
  key: 'delivery',
  version: 3,
  effective_at: '2026-01-01',
  title: {
    ar: 'سياسة التوصيل والشحن والرسوم',
    en: 'Delivery, Shipping and Fees Policy',
    ckb: 'سیاسەتی گەیاندن و ناردن و کرێیەکان',
  },
  body: {
    ar: `## وثيقة التوصيل والشحن والرسوم — المادة 3

هذه الوثيقة تبيّن كيف يصل الطلب إلى الزبون: بأي طريقة، وفي أي مدة، وبأي أجرة، ومن يتحمل هذه الأجرة، وأين تنتهي مسؤولية المتجر وأين تبدأ مسؤولية شركة التوصيل. وهي تُقرأ مع وثيقة الشراء ووثيقة البيع ووثيقة الدفع والمحفظة ووثيقة الإرجاع والاستبدال ووثيقة الضمان. النص العربي هو النص المعتمد، وما خالفه من ترجمة يُردّ إليه.

### 3.1 نطاق الوثيقة
- تسري هذه الوثيقة على كل طلب يُنشأ داخل المنصة ويُسلَّم داخل جمهورية العراق.
- تسري على طلبات المتجر الرسمي لـ Levonis، وعلى طلبات متاجر المجتمع في حدود ما تنص عليه المادة 3.5.
- لا تسري على نقل يرتبه الزبون بنفسه مع ناقل من عنده، ولا على بضاعة لم تُشترَ من المنصة.
- ما ورد هنا يحكم النقل والتسليم والأجور. أما العيب والضمان والإرجاع فمحلها الوثائق المخصصة لها.

### 3.2 التعريفات
يُقصد بالألفاظ الآتية، أينما وردت في هذه الوثيقة، المعاني المبيّنة إزاءها:

- المتجر: {{LEVONIS_LEGAL_NAME}}، المشغّل لمنصة Levonis.
- شركة التوصيل أو الناقل: الشركة المستقلة التي تنقل الطرد وتسلّمه، وهي شخص قانوني مستقل عن المتجر.
- الطرد: الوحدة المغلّفة المسلّمة إلى الناقل بموجب طلب واحد.
- التسليم إلى الناقل: اللحظة التي يستلم فيها الناقل الطرد من المتجر أو من مخزنه.
- التسليم إلى الزبون: اللحظة التي يستلم فيها الزبون الطرد أو من ينوب عنه عند الباب أو عند نقطة الاستلام.
- طريقة التوصيل: الخيار الذي يختاره الزبون في شاشة الدفع للمسافة الأخيرة، وهي التوصيل الاعتيادي أو التوصيل الشخصي أو الاستلام من المخزن.
- نوع الشحن: مسار تأمين البضاعة نفسه، وهو البيع المباشر أو الطلب المسبق جواً أو بحراً أو براً.
- العضو: صاحب عضوية LEVO PRO أو LEVO PREMIUM الفعّالة.
- العنوان الافتراضي المعتمد: العنوان الواحد المعتمد على حساب عضو PRO، والذي تُقاس عليه امتيازاته.
- متجر المجتمع: متجر تاجر مستقل يعرض بضاعته داخل المنصة ويبيعها بنفسه.

### 3.3 طرق التوصيل المعروضة عند الدفع
يعرض المتجر في شاشة الدفع الطرق الآتية، ولا تُعد أي منها متاحة لطلب بعينه إلا إذا ظهرت فعلاً في تلك الشاشة:

- التوصيل الاعتيادي: تسليم إلى عنوان الزبون بواسطة شركة التوصيل، ومدته التقديرية المنشورة عند تاريخ نفاذ هذه النسخة يومان إلى ثلاثة أيام عمل.
- التوصيل الشخصي: تسليم إلى عنوان الزبون في اليوم نفسه حيث تسمح المنطقة وساعة الطلب، وأجرته أعلى من الاعتيادي لأن كلفته على الناقل أعلى.
- الاستلام من المخزن: يستلم الزبون طلبه بنفسه من مخزن المتجر بلا أجرة توصيل، ومدة التجهيز التقديرية المنشورة عند تاريخ نفاذ هذه النسخة ساعتان.

الأرقام المنشورة أعلاه إرشادية وقابلة للتعديل من إدارة المتجر. والمعتمد في كل طلب هو ما ظهر في شاشة الدفع لذلك الطلب وقت تثبيته.

### 3.4 توفر طريقة التوصيل ليس مضموناً لكل منتج
- بعض المنتجات تحمل قواعد توصيل خاصة بها، تحدد أي الطرق يقبلها المنتج وبأي أجرة لكل عدد من الوحدات.
- إذا كان في السلة منتج لا يقبل الطريقة المختارة، رُفض الطلب بتلك الطريقة صراحة وبُيّن المنتج المانع، ولم يُقبل الطلب ثم يُعتذر عنه عند الباب.
- تعرض شاشة الدفع أجرة كل طريقة محسوبة على السلة نفسها، لا على تعرفة عامة لا تعرف ما في السلة.
- الطريقة التي تظهر غير متاحة لا يجوز فرضها بطلب مباشر إلى الخادم، فالرفض يقع في الخادم لا في الواجهة.

### 3.5 توصيل طلبات متاجر المجتمع
- طلب متجر المجتمع يبيعه التاجر ويشحنه التاجر، والمتجر وسيط منصة لا ناقل ولا بائع لتلك البضاعة.
- طلب متجر المجتمع مدفوع مقدماً من محفظة الزبون. ولا يوجد على هذا المسار دفع عند الاستلام ولا استلام من مخزن المتجر، لأن المتجر لا يحوز بضاعة التاجر ولا يحصّل نقده، وليس له عند أي من الطرفين من يستلم أو يسلّم.
- أجرة توصيل طلب متجر المجتمع تحددها إعدادات ذلك المتجر، وتظهر للزبون قبل تثبيت الطلب.
- ما ورد في هذه الوثيقة عن ضرر النقل ونقاط التفتيش يسري على طلب متجر المجتمع بالقدر نفسه، مع بقاء التزام التاجر عن بضاعته قائماً.

### 3.6 نوع الشحن، والسلة الواحدة لنوع واحد
- لكل منتج نوع شحن: بيع مباشر، أو طلب مسبق جواً، أو طلب مسبق بحراً، أو طلب مسبق براً.
- السلة الواحدة لا تجمع نوعين. أول منتج يدخل السلة يحدد نوعها، وما بعده يجب أن يوافقه، وإلا رُفضت الإضافة حتى تُفرغ السلة.
- سبب المنع أن النوعين ليسا وصفين لرحلة واحدة، بل رحلتان مختلفتان لا يجمعهما موعد واحد ولا مسار تتبع واحد. وطلب يجمعهما لا يمكن أن يُقال عنه صدقاً متى يصل.
- لا يُعد هذا المنع تقييداً للزبون، فله أن ينشئ طلباً مستقلاً لكل نوع، ولكل طلب موعده وأجرته.

### 3.7 التوصيل في البيع المباشر
- البيع المباشر بضاعة موجودة لدى المتجر وقت الطلب، تُجهّز وتُسلَّم إلى الناقل ثم تُسلَّم إلى الزبون.
- مراحله خمس: استُلم الطلب، ثم تأكيد، ثم تجهيز، ثم خرج للتوصيل، ثم سُلّم.
- المدة التقديرية المنشورة للشحن المباشر عند تاريخ نفاذ هذه النسخة ثلاثة إلى خمسة أيام عمل من تثبيت الطلب، وهي غير المدة التقديرية لطريقة التوصيل نفسها في المادة 3.3، إذ الأولى تشمل التجهيز والثانية المسافة الأخيرة.
- توقف تجهيز البيع المباشر على إتمام ما يترتب على الزبون من دفع مقدم حيث يكون مطلوباً.

### 3.8 الشحن في الطلب المسبق جواً وبحراً وبراً
- الطلب المسبق بضاعة تُشترى من مورد خارج العراق بعد تثبيت الطلب، ثم تُجمّع وتُنقل وتُخلّص وتُدخل إلى مخزن المتجر، ثم تُسلَّم محلياً.
- المدد التقديرية المنشورة عند تاريخ نفاذ هذه النسخة: الجوي عشرة إلى أربعة عشر يوم عمل، والبري عشرون إلى ثلاثون يوم عمل، والبحري ثلاثون إلى خمسة وأربعون يوم عمل.
- مراحل الطلب المسبق أربع عشرة مرحلة، تبدأ باستلام الطلب وتأكيده، ثم تجهيز المورد، ثم مخزن المنشأ، ثم تجهيز الشحنة، ثم التسليم إلى الناقل الدولي، ثم مغادرة المنشأ، ثم الطريق إلى العراق، ثم الوصول إلى العراق، ثم الطريق إلى مخزن ليفو، ثم مخزن ليفو، ثم تجهيز التوصيل المحلي، ثم الخروج للتوصيل، ثم التسليم.
- الطلب المسبق يخضع بعد وصوله إلى مخزن المتجر لأحكام التوصيل المحلي نفسها الواردة في هذه الوثيقة.
- قد تترتب على نوع النقل عمولة نقل تُضاف إلى سعر المنتج، وتظهر ضمن سعره قبل تثبيت الطلب لا بعده.

### 3.9 سبب تفاوت المدد بين الطرق
تفاوت المدد بين الجوي والبري والبحري ليس اختياراً تسويقياً، بل هو فرق في طبيعة النقل ذاته:

- الجوي أسرع لأنه يقطع المسافة في ساعات، وأعلى كلفة لأن أجرة الوزن فيه أعلى، ويقيّد بما يقبل النقل الجوي من مواد.
- البري متوسط في المدة والكلفة، ويتأثر بالحدود البرية وازدحامها وإجراءاتها وأيام العطل.
- البحري هو الأطول لأن الشحنة تنتظر تجميع الحاوية، ثم تقطع رحلة بحرية بمواعيد إبحار ثابتة لا تُستعجل، ثم تُفرَّغ وتُخلَّص في الميناء، وهو الأقل كلفة لهذا السبب.
- هذه المدد مقاسة بأيام العمل لا بالأيام التقويمية، ولا تدخل فيها العطل الرسمية ولا أيام تعطيل المنافذ.

### 3.10 المدد تقديرية وليست وعداً
- كل مدة واردة في هذه الوثيقة أو معروضة في المنصة تقدير مبني على المعتاد، وليست التزاماً بموعد.
- لا يترتب على تجاوز المدة التقديرية وحده تعويض ولا فسخ، ما لم يبلغ التأخير حداً يجعل تنفيذ الطلب غير ذي موضوع، فيُعالج وفق وثيقة الشراء ووثيقة الدفع.
- لا يعتد بوعد شفهي بموعد تسليم صادر من أي شخص، والمعتمد ما هو مثبت في المنصة.
- إذا تبيّن للمتجر أن التأخير جوهري، أبلغ الزبون به وبيّن خياراته، ولا يُعد سكوت المنصة إقراراً بموعد.

### 3.11 مراحل التتبع ومصدر تحديثها
- تظهر حالة الطلب للزبون في حسابه، وتنتقل بين المراحل المذكورة في المادتين 3.7 و3.8.
- الحالات التي مصدرها شركة التوصيل تُنقل من نظام الناقل آلياً ودورياً، وتُسجَّل باسم مصدرها.
- إذا تعذر الاتصال بنظام الناقل، أو ورد منه وصف حالة لا يقابله عند المتجر ما يقابله، بقي الطلب في مرحلته ولم تُحرَّك، وسُجّل ما ورد كما ورد.
- هذا التحفظ مقصود: تعذر المعرفة ليس دليلاً على واقعة. ولا يُعد بقاء الحالة على ما هي عليه إقراراً بأن شيئاً لم يحدث، ولا نفياً لما حدث فعلاً عند الناقل.
- للزبون أن يراجع الدعم إذا بقيت الحالة ساكنة مدة غير معتادة، وللمتجر تحديثها يدوياً بما يثبت لديه.

### 3.12 التغطية الجغرافية
- يوصل المتجر إلى محافظات جمهورية العراق الثماني عشرة: بغداد، والبصرة، ونينوى، وأربيل، والسليمانية، ودهوك، وكركوك، وديالى، والأنبار، وبابل، وكربلاء، والنجف، وواسط، وميسان، وذي قار، والمثنى، والقادسية، وصلاح الدين.
- المحافظة حقل مقيّد باللائحة أعلاه، ولا يُقبل فيه نص حر، لأن الناقل يوجّه الشحنة على اسم المحافظة، واختلاف الإملاء عنده مكان آخر لا اسم آخر.
- التوصيل داخل المحافظة إلى المناطق التي يخدمها الناقل. وما لا يخدمه الناقل من مناطق نائية قد يتطلب استلاماً من أقرب نقطة يحددها، أو أجرة إضافية يقررها الناقل.
- لا يوصل المتجر إلى خارج جمهورية العراق، ولا يقبل عنواناً خارجها.
- العنوان الذي يقدمه الزبون هو المعتمد. وما ينشأ عن نقص في العنوان أو خطأ فيه من تأخير أو كلفة إضافية أو تعذر تسليم يتحمله الزبون.

### 3.13 التوصيل إلى إقليم كردستان
- يشمل التوصيل محافظات إقليم كردستان: أربيل والسليمانية ودهوك، بالطرق نفسها المعروضة في شاشة الدفع لتلك العناوين.
- قد تختلف أجرة التوصيل إلى الإقليم عنها إلى غيره، لأن الناقل يسعّر على المحافظة والمسافة والمنفذ، ويظهر الفرق في شاشة الدفع قبل تثبيت الطلب.
- قد تختلف مدة التوصيل إلى الإقليم عن المدة المعتادة تبعاً لإجراءات المنافذ وأيام تعطيلها، وهو سبب خارج عن إرادة المتجر وإرادة الناقل معاً.
- الطرد المتجه إلى الإقليم أو الخارج منه قد يمر بنقاط تفتيش تُفتح عندها الطرود وتُفحص وتُعاد تغليفها، وحكم ذلك في المادة 3.26، وهو حكم جوهري في هذه الوثيقة.

### 3.14 أجرة التوصيل والرسوم تحددها شركات التوصيل لا المتجر
- أجرة التوصيل والرسوم المترتبة عليها تحددها شركات التوصيل، ولا يحددها المتجر.
- ما يعرضه المتجر على الزبون هو ما تتقاضاه شركة التوصيل، ينقله إليه كما هو. ولا يضيف المتجر إلى هذه الأجرة ربحاً، ولا يملك خفضها، ولا التفاوض عليها نيابة عن الزبون.
- رفع الناقل لتعرفته أو تغييره لطريقة احتساب المسافة أو المنطقة أمر يقع خارج إرادة المتجر، ولا يُسأل عنه، ولا يُعد تغييراً من المتجر لسعر معلن.
- الضريبة أو الرسم الذي تفرضه شركة التوصيل على خدمتها أو على تحصيل النقد يتبع الحكم نفسه: مصدره الناقل، والمتجر ناقل له لا فارض له.
- ما يتحمله المتجر عن عضو مستحق بموجب المادة 3.17 يبقى أجرة الناقل نفسها، غاية الأمر أن دافعها المتجر لا الزبون.

### 3.15 الأجرة المعروضة عند الدفع رقم لحظي
- الأجرة الظاهرة في شاشة الدفع هي رقم شركة التوصيل في تلك اللحظة، محسوباً على العنوان والمحافظة والطريقة ومحتوى السلة كما هي وقت العرض.
- يتغير هذا الرقم إذا تغير العنوان، أو تغيرت المحافظة، أو تغيرت طريقة التوصيل، أو تغير محتوى السلة عدداً أو حجماً أو وزناً أو صنفاً.
- الأجرة المثبتة على الطلب عند تثبيته هي المعتمدة لذلك الطلب، ولا يُطالب الزبون بفرق ينشأ بعد التثبيت عن تغيير في تعرفة الناقل.
- إذا طلب الزبون بعد التثبيت تغييراً يوجب على الناقل أجرة مغايرة، عومل الأمر معاملة الطلب الجديد في أجرته، وتفصيل ما يقبل التغيير في المادتين 3.35 و3.36.
- الأجرة المعروضة لا تشمل ما قد يفرضه الناقل من أجر انتظار أو محاولة إضافية أو إعادة تسليم، وحكم ذلك في المادة 3.33.

### 3.16 كل كلف التوصيل على الزبون
- الأصل أن جميع كلف التوصيل على الزبون: أجرة المسافة الأخيرة، وأجرة الطريقة التي اختارها، وما يترتب على التحصيل النقدي من ضريبة، وكلفة إعادة التوصيل، وكلفة الإعادة عند الرفض بغير سبب معتبر.
- كلفة إرجاع منتج معيب تُعالج في وثيقة الإرجاع والاستبدال، وأجرة الشحن في الإرجاع على الزبون وفق ما نصت عليه تلك الوثيقة.
- لا يُفهم من عرض أجرة صفرية على طريقة الاستلام من المخزن أن التوصيل مجاني، بل أن لا مسافة أخيرة في تلك الطريقة أصلاً.
- يُستثنى من أصل هذه المادة ما ورد في المادة 3.17 حصراً، وما يقرره المتجر من عرض ترويجي أو إحالة يظهر أثره في شاشة الدفع.

### 3.17 استثناء العضوية: PRO و LEVO PREMIUM
- يتحمل المتجر كلف التوصيل عن العضو فوق قيمة طلب محددة، على التفصيل الآتي.
- عضو LEVO PRO الفعّال: يتحمل المتجر عنه أجرة التوصيل إذا تجاوزت قيمة البضاعة المؤهلة الحدّ المعلن لعضويته وقدره {{PRO_FREE_DELIVERY_MIN_IQD}}، والتجاوز يكون بالزيادة حصراً فلا يكفي بلوغ الحدّ. ويشمل ما يتحمله المتجر عنه التوصيل الاعتيادي والتغليف المحمي.
- عضو LEVO PREMIUM الفعّال: يتحمل المتجر عنه أجرة التوصيل الاعتيادية وحدها إذا تجاوزت قيمة البضاعة المؤهلة الحدّ المعلن لعضويته وقدره {{PREMIUM_FREE_DELIVERY_MIN_IQD}}، بالزيادة حصراً. ولا يمتد هذا الإعفاء إلى التغليف المحمي ولا إلى الرسوم الإضافية في المادة 3.20.
- قيمة البضاعة المؤهلة تُحسب على البضاعة بعد الحسومات والقسائم والنقاط وقبل أجرة التوصيل، ولا تدخل فيها أجرة التوصيل نفسها.
- إذا اجتمع في عضو وصفان، قُدّم حكم PRO لأنه الأوسع.
- الإعفاء يسقط بانتهاء العضوية أو توقفها، ويعود بعودتها، ولا أثر رجعي له على طلب سابق.
- ما تحمله المتجر عن العضو يظهر في الفاتورة مبيّناً: أجرة الناقل، ثم ما تحمله المتجر منها. ولا تُعرض الأجرة صفراً بلا بيان، لأن الفاتورة التي لا تُقرأ لا يُحتج بها.

### 3.18 شرط العنوان الافتراضي المعتمد لعضو PRO
- امتيازات عضو PRO المتعلقة بالتوصيل قائمة عند عنوانه الافتراضي المعتمد وحده.
- إذا اختار عضو PRO في طلب ما عنواناً آخر، سُعّر ذلك الطلب تسعير الزبون الاعتيادي، ولا يُعد ذلك حرماناً من امتياز بل تحديداً لمكانه.
- تعود الأهلية تلقائياً بعودة العضو إلى عنوانه المعتمد، من غير طلب ولا مراجعة.
- تُبيّن شاشة الدفع سبب عدم تطبيق الإعفاء عند اختيار عنوان آخر، حتى لا يُفاجأ العضو بأجرة لم يتوقعها.
- هذا الشرط خاص بعضوية PRO، ولا يُقاس عليه في عضوية LEVO PREMIUM.

### 3.19 سقف ما تتحمله العضوية
- يجوز أن يكون لما يتحمله المتجر عن العضو سقف أعلى معلن في شروط العضوية.
- إذا لم يُقرر سقف، تحمّل المتجر أجرة التوصيل المشمولة كاملة.
- إذا قُرر سقف وبلغته الأجرة، تحمّل المتجر مقدار السقف ودفع العضو الفرق، ولا يُقال في هذه الحال إن التوصيل مجاني، بل يُبيّن في الفاتورة مقدار ما تحمله المتجر ومقدار ما بقي على العضو.
- المتجر ملتزم ببيان هذا الفرق قبل تثبيت الطلب لا بعده.

### 3.20 الرسوم الإضافية على أجرة التوصيل
قد تُضاف إلى أجرة التوصيل الاعتيادية رسوم تتبع طبيعة البضاعة، وكلها تظهر في شاشة الدفع قبل التثبيت:

- رسم الطابعات: يُحتسب على الطابعة بحسب صنفها الحجمي، وقد يكون مستحق الدفع مقدماً قبل التجهيز إذا قررت إدارة المتجر ذلك.
- رسم الكرتون: يستحق إذا تجاوز عدد بكرات الخيط الحدّ المقرر، وسببه أن الكمية تتطلب كرتوناً إضافياً لا يحتمله التغليف الاعتيادي. ولا يُستوفى هذا الرسم ما لم يكن الحدّ ومقدار الرسم مقررين معاً.
- التغليف المحمي: خدمة اختيارية يطلبها الزبون، يُغلَّف فيها الطرد ويُعامل بما يعينه على تحمل الطريق. وهو إضافة على التعرفة لا بديل عنها، ولا يُستوفى عنه أجر ما لم يكن مسعّراً، ولا يُعرض غير مسعّر.
- لا يُستوفى أي رسم من هذه الرسوم ما لم يكن مقرراً ومعروضاً. والرسم غير المقرر لا يُقدَّر ولا يُجتهد فيه.
- التغليف المحمي احتياط مادي في التغليف، وليس تأميناً على الطرد، ولا يترتب عليه تحمّل المتجر لضرر النقل المنصوص عليه في المادة 3.25.

### 3.21 خدمة الإنجاز خلال اثنتي عشرة ساعة لعضو PRO
- يوفر المتجر لعضو PRO خدمة إنجاز خلال اثنتي عشرة ساعة، وهي خدمة مشروطة لا امتياز مطلق.
- شروطها مجتمعة: أن تكون العضوية فعّالة ومستحقة للخدمة، وأن يكون التسليم على العنوان الافتراضي المعتمد، وأن تكون الخدمة مفعّلة من إدارة المتجر، وأن تكون طريقة التوصيل المختارة من الطرق المشمولة بها، وأن يكون نوع الشحن مشمولاً بها، وأن تكون المحافظة ضمن نطاقها إن حُدد لها نطاق.
- الخدمة مشمولة اليوم بالتوصيل الشخصي وبالبيع المباشر. والطلب المسبق غير مشمول بطبيعته، لأن بضاعته لم تصل بعد.
- إذا تخلف شرط من هذه الشروط، بُيّن سبب التخلف بعينه في شاشة الدفع، ولم تُحتسب الخدمة، ولم يُستوف عنها أجر.
- مدة الاثنتي عشرة ساعة تُحسب من لحظة استحقاق الخدمة على الطلب، وهي مدة إنجاز لدى المتجر، ولا تلغي أثر ما يقع عند الناقل من ظروف الطريق.

### 3.22 الدفع عند الباب وضريبة التحصيل النقدي
- الدفع عند الاستلام متاح على مسار المتجر الرسمي حيث يظهر في شاشة الدفع، وغير متاح على مسار متاجر المجتمع وفق المادة 3.5.
- يُستوفى على المبلغ المحصّل نقداً عند الباب ضريبة تحصيل، تُحتسب بمقدار مقرر عن كل شريحة كاملة من المبلغ المستحق قبل الضريبة، والمقداران كلاهما معروضان في شاشة الدفع لذلك الطلب. والكسر الذي لا يبلغ شريحة كاملة لا يُستوفى عنه شيء. والمقداران قابلان للتعديل من إدارة المتجر، والمعتمد في كل طلب هو ما ظهر في شاشة الدفع لذلك الطلب وقت تثبيته.
- هذه الضريبة لا تُستوفى على الاستلام من المخزن، لأن لا تحصيل عند باب ولا نقل لنقد.
- تظهر الضريبة في الفاتورة بنداً مستقلاً بمقدارها، ولا تُدمج في السعر.
- إذا كان الزبون معفى منها بموجب عضويته، احتُسبت كاملة ثم بُيّن الإعفاء بإزائها في الفاتورة، حتى يبقى الرقمان قابلين للمراجعة، ولا يظهر صفر لا يُعرف كيف صار صفراً.
- لا يُطلب من مندوب التوصيل تحصيل مبلغ يخالف ما على الفاتورة، ولا يُقبل من الزبون الاحتجاج باتفاق شفهي مع المندوب على مبلغ آخر.
- المبلغ المحصّل عند الباب يُدفع إلى المندوب بموجب وصل، والوصل بيّنة على الدفع.

### 3.23 الرسوم الكمركية ورسوم الاستيراد
- السعر المعروض على منتج الطلب المسبق يشمل ما أفصح عنه المتجر من كلفة نقل وعمولة، ولا يشمل رسماً تفرضه جهة رسمية على الزبون بشخصه.
- إذا فرضت جهة رسمية رسماً كمركياً أو رسم استيراد أو رسم إدخال مستحقاً على الزبون بشخصه، فهو على الزبون، ويُؤدى إلى الجهة التي فرضته لا إلى المتجر.
- المتجر لا يقدّر مقدار هذا الرسم ولا يضمن عدم فرضه، لأن تقديره وفرضه ليسا إليه.
- ما يتحمله المتجر من تخليص وإدخال لشحنته الخاصة داخل في كلفته هو، ولا يُطالب به الزبون مرة أخرى.
- عند نشوء مطالبة رسمية من هذا النوع، يبيّن المتجر للزبون ما لديه من مستندات الشحنة بما يعينه على مراجعة الجهة المختصة، وذلك على سبيل المعاونة لا الالتزام. وللاستفسار: {{LEVONIS_SUPPORT_CONTACT}}.

### 3.24 التزام المتجر بالتغليف وحدود هذا الالتزام
- يلتزم المتجر بأن يغلّف البضاعة تغليفاً سليماً يناسب طبيعتها ووزنها وقابليتها للكسر، وأن يسلّمها إلى شركة التوصيل وهي على تلك الحال.
- يلتزم المتجر بأن يكون ما في الطرد مطابقاً لما في الطلب عدداً وصنفاً وموديلاً.
- يلتزم المتجر بأن يسلّم الناقل بيانات التسليم صحيحة كما قدمها الزبون.
- ينتهي التزام المتجر المادي عند تسليم الطرد إلى شركة التوصيل سليماً. وما بعد ذلك حيازة الناقل ومسؤوليته.
- عبء إثبات سلامة التغليف عند التسليم إلى الناقل على المتجر، ويُستوفى بما لديه من توثيق التجهيز ووصل التسليم إلى الناقل.

### 3.25 لا مسؤولية على المتجر عن الضرر الواقع أثناء النقل
- لا يتحمل المتجر الضرر الواقع على الطرد أثناء النقل بعد تسليمه إلى شركة التوصيل سليماً.
- يشمل ذلك الكسر والانبعاج والخدش والبلل والسرقة والفقد وسوء المناولة ونقص المحتويات الواقع في حيازة الناقل.
- سبب هذا الحكم أن الطرد يخرج من يد المتجر إلى يد شخص قانوني مستقل، لا يشرف المتجر على عماله ولا على مركباته ولا على مسالكه ولا على ما يقع في مستودعاته.
- عدم تحمل المتجر لهذا الضرر لا يعني إنكاره، ولا يمنع الزبون من مطالبة الناقل، ولا يمنع المتجر من معاونته على ذلك وفق المادة 3.29.
- ما ثبت أنه عيب تصنيع خفي لا علاقة له بالنقل يبقى محكوماً بوثيقة الضمان، ولا تُدفع مطالبة الضمان بهذه المادة.
- ما ثبت أن سببه سوء تغليف من المتجر يبقى على المتجر، ولا يستتر بهذه المادة.

### 3.26 حدود إقليم كردستان ونقاط التفتيش وفتح الطرود
- لا يتحمل المتجر الضرر الواقع على الطرد عند حدود إقليم كردستان، ولا عند أي نقطة تفتيش أو سيطرة أو منفذ يُفتح فيه الطرد ويُفحص ويُعاد تغليفه بمعرفة جهة ليست المتجر ولا شركة التوصيل.
- يشمل ذلك ما ينشأ عن الفتح من قطع للأشرطة، وتلف للتغليف الأصلي، وإعادة تغليف بغير ما غُلّف به، وفك للأجزاء، ونقص فيما كان داخل الطرد.
- الجهة التي تفتح الطرد في هذه الحال تمارس صلاحية رسمية لا يملك المتجر ردّها ولا الاعتراض على ممارستها ولا حضورها.
- لا يُشترط لتحقق هذا الحكم أن يكون الفتح بغير حق، بل يكفي أن يقع الفتح وإعادة التغليف بمعرفة تلك الجهة.
- يقع هذا الحكم على الطرد المتجه إلى الإقليم والخارج منه والمار به على السواء.
- إذا وصل الطرد بأثر ظاهر من هذا النوع، فالإجراء الصحيح ما نصت عليه المادتان 3.27 و3.30، والمتجر يعاون على مراجعة الناقل وفق المادة 3.29.

### 3.27 ما يثبته الزبون عند الباب
حفاظاً على حق الزبون قِبَل الناقل، وحتى تبقى الواقعة قابلة للإثبات، على الزبون قبل التوقيع بالاستلام أن يفعل الآتي:

- فحص الكرتون الخارجي أمام المندوب: هل هو مفتوح، وهل شريطه مقطوع أو مُعاد لصقه، وهل فيه انبعاج أو تمزق أو أثر بلل.
- تصوير الطرد من الخارج قبل فتحه، بحيث يظهر في الصورة الملصق وحال التغليف.
- فتح الطرد أمام المندوب حيث تسمح طريقة التوصيل، وتصوير الفتح بمقطع واحد متصل غير مقطوع.
- التحقق من العدد والمحتويات والموديل والرقم التسلسلي ومن سلامة التغليف الداخلي.
- تثبيت التحفظ كتابة على وصل التوصيل عند وجود أثر ظاهر، أو رفض الاستلام وفق المادة 3.31.
- إبلاغ المتجر خلال {{DAMAGE_REPORT_WINDOW_HOURS}} ساعة من التسليم برقم الطلب والصور والمقاطع.
- لا يُطلب من المندوب انتظار فحص يتجاوز {{DOOR_INSPECTION_MINUTES}} دقيقة، ولا تشغيل الجهاز وتجربته عند الباب.

### 3.28 أثر عدم إثبات الزبون
- التوقيع بالاستلام بلا تحفظ مع وجود أثر ظاهر على الكرتون يُضعف دعوى ضرر النقل إلى حد سقوطها، لأن التوقيع إقرار بالتسلم على الحال الظاهرة.
- الطرد الذي فُتح بعد مغادرة المندوب بلا تصوير متصل لا تُقبل عليه مطالبة بنقص محتويات، لأن الواقعة لا تعود قابلة للإثبات لا للزبون ولا للمتجر ولا للناقل.
- الإبلاغ بعد المهلة المنصوص عليها يُضعف المطالبة، وقد لا يُقبل إذا كان محله أمراً ظاهراً كان يمكن رؤيته عند الباب.
- ما تقدم لا يمنع مطالبة الضمان عن عيب تصنيع خفي، فذاك محكوم بوثيقة الضمان لا بهذه الوثيقة.

### 3.29 معاونة المتجر في مطالبة الناقل
لا يتحمل المتجر ضرر النقل، ومع ذلك يقوم بما يأتي معاونةً للزبون، ويُعد التزاماً ببذل عناية لا بتحقيق نتيجة:

- تزويد الزبون ومطالبته لدى الناقل بما لدى المتجر من رقم الشحنة ورقم التتبع وتاريخ التسليم إلى الناقل وبيان محتويات الطرد.
- تقديم ما يثبت حال الطرد عند تسليمه إلى الناقل.
- رفع المطالبة إلى الناقل باسم المتجر بوصفه الجهة المتعاقدة معه حيث يقبل الناقل ذلك.
- متابعة جواب الناقل وإبلاغ الزبون به كما ورد، من غير وعد بنتيجة ولا بمدة.
- إذا أقر الناقل بالمسؤولية وأدى تعويضاً عن الطرد، آل التعويض إلى الزبون في حدود ما أُدي فعلاً.
- إذا أنكر الناقل، بقي للزبون حقه في مراجعته مباشرة، ويبقى المتجر على موقفه المبيّن في المادة 3.25.
- المطالبة لدى الناقل مقيدة بمدة يحددها الناقل نفسه، ولا يُسأل المتجر عن فوات مدة سببها تأخر الزبون في الإبلاغ.

### 3.30 الطرد الذي يصل مفتوحاً
- الطرد الذي يصل مفتوحاً أو مُعاد تغليفه بغير تغليفه الأصلي: للزبون رفض استلامه، والرفض هو الإجراء الصحيح في هذه الحال.
- إذا اختار الزبون استلامه، ثبّت تحفظه على الوصل، وصوّر الطرد قبل الفتح وأثناءه، وأبلغ المتجر ضمن المهلة.
- الطرد المرفوض لهذا السبب يعود إلى المتجر، ويُفحص عند وصوله، ويُبت في الطلب على أساس ما يظهر عند الفحص.
- كلفة الإعادة في هذه الحال لا تُحمَّل على الزبون إذا كان الأثر الظاهر موثقاً بالصور.
- إذا تبيّن من الفحص أن سبب الفتح إجراء جهة رسمية، سرى حكم المادة 3.26، ولا يتحمل المتجر الضرر، ويعاون الزبون وفق المادة 3.29.

### 3.31 الرفض عند الباب
- للزبون رفض الاستلام عند الباب.
- الرفض المبني على سبب من أسباب هذه الوثيقة، كوصول الطرد مفتوحاً أو ظهور ضرر موثق أو عدم مطابقة ظاهرة، لا تُحمَّل كلفة إعادته على الزبون.
- الرفض بغير سبب من هذه الأسباب تُحمَّل كلفة الذهاب والإياب فيه على الزبون، وتُستوفى من المبلغ المسترجع إن وُجد.
- الطرد المرفوض يعود إلى المتجر ويُعامل الطلب معاملة الملغى وفق وثيقة الشراء ووثيقة الدفع والمحفظة.
- تكرار الرفض بلا سبب من الحساب نفسه يعرّض الحساب لتقييد الدفع عند الاستلام، فيُطلب منه الدفع المسبق.

### 3.32 تعذر الوصول إلى الزبون أو غيابه
- على الزبون أن يكون متاحاً على الرقم المسجل في حسابه أيام التوصيل المتوقعة، وأن يكون عنوانه قابلاً للوصول.
- إذا لم يُجب الزبون على اتصال المندوب، أو كان غائباً عن العنوان، عُدّت المحاولة محاولة تسليم فاشلة وسُجلت.
- يعيد الناقل المحاولة بحسب نظامه. فإذا تعذر الوصول بعد {{FAILED_DELIVERY_ATTEMPTS}} محاولات، أُعيد الطرد إلى المتجر وعومل الطلب معاملة الرفض عند الباب بغير سبب.
- إذا تعذر الوصول إلى الزبون لتأكيد طلبه أصلاً خلال {{ORDER_CONFIRMATION_WINDOW_HOURS}} ساعة، جاز للمتجر إلغاء الطلب وفق وثيقة البيع.
- الرقم المسجل الخاطئ أو المغلق أو غير المستعمل سبب يعود إلى الزبون، وما ترتب عليه من كلفة عليه.

### 3.33 إعادة التوصيل ومن يتحمل كلفتها
- إعادة التوصيل بعد محاولة فاشلة سببها الزبون تُستوفى عنها أجرة إعادة مقدارها {{REDELIVERY_FEE_IQD}}، تحددها شركة التوصيل ويُنقل مقدارها إلى الزبون كما هو.
- إعادة التوصيل التي سببها المتجر أو الناقل، كخطأ في التجهيز أو في توجيه الشحنة، لا يتحملها الزبون.
- أجرة الانتظار أو المحاولة الإضافية التي يفرضها الناقل تتبع حكم المادة 3.14، فمصدرها الناقل والمتجر ناقل لها.
- إذا رغب الزبون بعد المحاولة الفاشلة في استلام طلبه من مخزن المتجر بدلاً من إعادة التوصيل، جاز ذلك حيث تكون طريقة الاستلام متاحة لذلك الطلب، ولا تُستوفى عنه أجرة إعادة.
- الطلب الذي يتعذر تسليمه نهائياً يعود إلى المتجر، وتُطبق عليه أحكام الإلغاء والاسترجاع في وثيقة الدفع والمحفظة بعد حسم ما استحق من كلف.

### 3.34 اختيار يوم التوصيل وتغييره وسقفه
- للزبون أن يبيّن يوماً يفضّله للتسليم عند تثبيت الطلب أو قبل تسليم الطرد إلى شركة التوصيل، ويُبلَّغ ذلك إلى الدعم على {{LEVONIS_SUPPORT_CONTACT}}.
- تفضيل اليوم طلب يُبذل فيه وسع المتجر، وليس حجزاً لموعد، ولا يترتب على عدم تحققه أثر.
- يُقبل تغيير اليوم المفضل قبل تسليم الطرد إلى الناقل بمدة لا تقل عن {{DELIVERY_DAY_CHANGE_NOTICE_HOURS}} ساعة.
- سقف التغيير {{DELIVERY_DAY_CHANGE_LIMIT}} مرة على الطلب الواحد. وما زاد على ذلك يُعد تأجيلاً غير معتاد، وللمتجر عندها إبقاء الطلب على حاله أو إلغاؤه وفق وثيقة البيع.
- تأجيل التسليم بطلب الزبون لا يمدد مدة الإرجاع ولا مدة الضمان، فمبدؤهما التسليم الفعلي.
- التأجيل الذي يبقي البضاعة محجوزة لدى المتجر مدة غير معتادة يجيز للمتجر استيفاء أجر خزن مقداره {{STORAGE_FEE_PER_DAY_IQD}} عن كل يوم بعد انقضاء {{PICKUP_HOLD_DAYS}} يوماً من إشعار الجاهزية.

### 3.35 الطرد المسلَّم إلى الناقل لا يُعاد توجيهه ولا تُغيَّر مواعيده من خلال المتجر
- بعد تسليم الطرد إلى شركة التوصيل، لا يملك المتجر تغيير عنوانه، ولا تحويله إلى مدينة أخرى أو شخص آخر، ولا تقديم موعده أو تأخيره، ولا وقفه في الطريق.
- سبب ذلك أن الشحنة تصير في حيازة الناقل ونظامه، والمتجر لا يملك في هذا النظام إلا إنشاء الشحنة والسؤال عن حالها. ولا يوجد لديه إجراء لإعادة التوجيه ولا لإعادة الجدولة.
- كل وعد بخلاف ذلك يصدر من أي شخص لا يلزم المتجر، ولا يُعتد به.
- ما يملكه الزبون في هذه الحال أمران: مراجعة شركة التوصيل مباشرة على رقم الشحنة وفق نظامها، أو رفض الاستلام عند الباب ثم إعادة الطلب من جديد على البيانات الصحيحة.
- يعاون المتجر الزبون على الوصول إلى الناقل وتزويده برقم الشحنة، وليس في ذلك التزام بتحقق ما يطلبه.
- ما يقبله الناقل من تعديل يبقى بين الزبون والناقل، وما يترتب عليه من أجر على الزبون.

### 3.36 تغيير العنوان قبل التسليم إلى الناقل
- يُقبل تغيير عنوان التسليم قبل تسليم الطرد إلى شركة التوصيل، ويُطلب من الدعم على {{LEVONIS_SUPPORT_CONTACT}} خلال {{ADDRESS_CHANGE_DEADLINE_HOURS}} ساعة من تثبيت الطلب أو قبل التسليم إلى الناقل أيهما أسبق.
- إذا ترتب على العنوان الجديد أجرة مغايرة عند الناقل، استُوفي الفرق من الزبون أو رُدّ إليه بحسب الحال قبل التجهيز.
- إذا نقل التغيير التسليم إلى محافظة أخرى، جاز أن تتغير الطريقة المتاحة والمدة التقديرية والأجرة معاً.
- تغيير العنوان لعضو PRO إلى غير عنوانه الافتراضي المعتمد يسقط الإعفاء عن ذلك الطلب وفق المادة 3.18.
- بعد تسليم الطرد إلى الناقل يسري حكم المادة 3.35 ولا يُقبل التغيير.

### 3.37 استلام شخص آخر نيابة عن الزبون
- يجوز أن يستلم الطرد شخص بالغ حاضر في العنوان المسجل، ويُعد استلامه استلاماً صحيحاً منتجاً لأثره.
- التوقيع بالاستلام من هذا الشخص يسري على الزبون فيما يتعلق بالإقرار بحال الطرد الظاهرة.
- على الزبون أن يعلم من ينوب عنه بما نصت عليه المادة 3.27، فإن فحص التغليف وتثبيت التحفظ حق يسقط بالإهمال.
- الدفع عند الاستلام من هذا الشخص مبرئ لذمة الزبون في حدود ما دُفع بموجب وصل.
- ليس للمندوب ترك الطرد في غياب من يستلمه ما لم يأذن الزبون بذلك كتابة، والإذن بذلك ينقل تبعة الفقد إلى الزبون.

### 3.38 الاستلام من المخزن
- الاستلام من المخزن متاح على مسار المتجر الرسمي حيث يظهر خياراً في شاشة الدفع لذلك الطلب، وغير متاح على مسار متاجر المجتمع وفق المادة 3.5.
- موقع الاستلام {{LEVONIS_WAREHOUSE_ADDRESS}} وأوقاته {{LEVONIS_PICKUP_HOURS}}.
- لا تُستوفى أجرة توصيل على هذه الطريقة، ولا تُستوفى ضريبة التحصيل النقدي وفق المادة 3.22، لأن لا مسافة أخيرة ولا تحصيل عند باب.
- على المستلم إبراز ما يثبت هويته ورقم الطلب.
- للزبون فحص المحتويات عند الاستلام في المخزن، وهو أوسع مما يتاح عند الباب، ويُثبّت ما يظهر من ملاحظات في حينه.
- يُحفظ الطلب الجاهز للاستلام مدة {{PICKUP_HOLD_DAYS}} يوماً من إشعار الجاهزية، وبعدها جاز للمتجر إلغاؤه وردّ ما دُفع منه وفق وثيقة الدفع والمحفظة، أو استيفاء أجر خزن {{STORAGE_FEE_PER_DAY_IQD}} عن كل يوم.
- الطرد المستلم من المخزن ينتقل إلى حيازة الزبون بمجرد خروجه من المخزن، ولا يسري عليه حكم ضرر النقل، لأن لا ناقل فيه.

### 3.39 الظروف الخارجة عن الإرادة
- لا يُسأل المتجر عن تأخير أو تعذر تسليم سببه أمر خارج عن إرادته، كإغلاق الطرق والمنافذ، وتعطيل الدوام الرسمي، والأحوال الجوية، والاضطرابات، وانقطاع خدمات الناقل، وقرارات الجهات الرسمية.
- يبقى للزبون في هذه الحال حقه في المبلغ المدفوع إذا لم يُنفَّذ الطلب، وفق وثيقة الدفع والمحفظة.
- لا يُعد هذا البند إعفاء عاماً، ولا يُتوسع فيه ليشمل تقصيراً من المتجر في التجهيز أو في البيان.

### 3.40 الأولوية عند التعارض والقانون الواجب التطبيق
- ما ورد في هذه الوثيقة من أحكام التوصيل والأجور مقدَّم على ما ورد عرضاً في غيرها من الوثائق.
- ما ورد في وثيقة الضمان ووثيقة الإرجاع والاستبدال من أحكام العيب والإرجاع مقدَّم على ما ورد عرضاً هنا.
- تثبيت الطلب قبول بما في هذه الوثيقة بنسختها النافذة وقت التثبيت، والنسخة المحفوظة بتاريخها هي الحجة.
- يسري على هذه الوثيقة قانون {{GOVERNING_LAW_JURISDICTION}}، وتختص بالنزاع الناشئ عنها {{COMPETENT_COURT}}.
- للاستفسار والمطالبات: {{LEVONIS_SUPPORT_CONTACT}}.
`,
    en: `## Delivery, Shipping and Fees Document — Article 3

This document sets out how an order reaches the customer: by which method, within what period, at what fee, who bears that fee, where the Store's responsibility ends and where the delivery company's begins. It is read together with the Purchase Policy, the Selling Policy, the Payment and Wallet Policy, the Returns and Exchange Policy and the Warranty Policy. The Arabic text is the authoritative text, and any translation differing from it is referred back to it.

### 3.1 Scope of this document
- This document applies to every order created within the platform and delivered inside the Republic of Iraq.
- It applies to orders of the official Levonis store, and to orders of community stores within the limits stated in article 3.5.
- It does not apply to transport the customer arranges themselves with a carrier of their own, nor to goods not purchased from the platform.
- What is stated here governs transport, delivery and charges. Defects, warranty and returns are governed by the documents dedicated to them.

### 3.2 Definitions
The following terms, wherever they appear in this document, carry the meanings set against them:

- The Store: {{LEVONIS_LEGAL_NAME}}, the operator of the Levonis platform.
- The delivery company, or the carrier: the independent company that transports and delivers the parcel, being a legal person independent of the Store.
- The parcel: the packed unit handed to the carrier under a single order.
- Handover to the carrier: the moment at which the carrier takes the parcel from the Store or from its warehouse.
- Delivery to the customer: the moment at which the customer, or a person acting for them, receives the parcel at the door or at the collection point.
- Delivery method: the option the customer selects at checkout for the last mile, being standard delivery, personal delivery or warehouse pickup.
- Shipping type: the route by which the goods themselves are obtained, being a direct sale or a pre-order by air, by sea or by land.
- The member: the holder of an active LEVO PRO or LEVO PREMIUM membership.
- The approved default address: the single approved address on a PRO member's account, against which their benefits are measured.
- Community store: an independent merchant's store which displays its goods within the platform and sells them itself.

### 3.3 The delivery methods offered at checkout
The Store offers the following methods at checkout, and none of them is available for a particular order unless it actually appears on that screen:

- Standard delivery: delivery to the customer's address by the delivery company, with an estimated period published at the effective date of this version of two to three business days.
- Personal delivery: delivery to the customer's address on the same day where the area and the hour of ordering permit; its fee is higher than the standard fee because it costs the carrier more.
- Warehouse pickup: the customer collects the order themselves from the Store's warehouse with no delivery fee, with an estimated preparation period published at the effective date of this version of two hours.

The figures published above are indicative and may be amended by the Store's administration. What governs each order is what appeared at checkout for that order at the time it was placed.

### 3.4 The availability of a delivery method is not guaranteed for every product
- Some products carry their own delivery rules, determining which methods the product accepts and at what fee per number of units.
- Where the cart holds a product that does not accept the selected method, the order is expressly refused on that method and the blocking product is identified, rather than being accepted and then apologised for at the door.
- The checkout screen shows each method's fee calculated on that very cart, not on a general tariff that does not know what the cart holds.
- A method shown as unavailable may not be forced by a direct request to the server; the refusal is made at the server and not in the interface.

### 3.5 Delivery of community store orders
- A community store order is sold by the merchant and shipped by the merchant; the Store is a platform intermediary, neither carrier nor seller of those goods.
- A community store order is paid in advance from the customer's wallet. There is no cash on delivery and no warehouse pickup on this path, because the Store holds neither the merchant's stock nor their cash, and has nobody at either end to collect or to hand over.
- The delivery fee of a community store order is set by that store's own settings and is shown to the customer before the order is placed.
- What this document states on transit damage and checkpoints applies to a community store order to the same extent, while the merchant's own obligation for their goods remains.

### 3.6 Shipping type, and one cart to one type
- Every product has a shipping type: a direct sale, or a pre-order by air, by sea or by land.
- A single cart does not combine two types. The first product added determines the cart's type and every product after it must match, failing which the addition is refused until the cart is emptied.
- The reason for this bar is that the two types are not two descriptions of one journey but two different journeys, sharing neither a single date nor a single tracking path. An order combining them cannot honestly be said to arrive at any one time.
- This bar is not a restriction on the customer, who may create a separate order for each type, each with its own timing and its own fee.

### 3.7 Delivery on a direct sale
- A direct sale is goods held by the Store at the time of order, which are prepared, handed to the carrier and then delivered to the customer.
- Its stages are five: order received, then confirmed, then preparing, then out for delivery, then delivered.
- The estimated period published for direct shipping at the effective date of this version is three to five business days from the placing of the order, which is not the same as the estimated period of the delivery method itself in article 3.3: the former covers preparation and the latter the last mile.
- Preparation of a direct sale depends on completion of any advance payment due from the customer where one is required.

### 3.8 Shipping on a pre-order by air, by sea and by land
- A pre-order is goods purchased from a supplier outside Iraq after the order is placed, then consolidated, transported, cleared and brought into the Store's warehouse, and then delivered locally.
- The estimated periods published at the effective date of this version are: air, ten to fourteen business days; land, twenty to thirty business days; sea, thirty to forty-five business days.
- A pre-order has fourteen stages, beginning with the order being received and confirmed, then supplier preparing, then the origin warehouse, then freight preparation, then handover to the international carrier, then departure from origin, then en route to Iraq, then arrival in Iraq, then en route to the Levo warehouse, then the Levo warehouse, then local delivery preparation, then out for delivery, then delivered.
- Once it reaches the Store's warehouse, a pre-order is subject to the same local delivery provisions set out in this document.
- A transport commission may be due according to the mode of carriage and is added to the product's price, appearing within that price before the order is placed and not after.

### 3.9 Why the periods differ so much between the modes
The difference in period between air, land and sea is not a marketing choice; it is a difference in the nature of the carriage itself:

- Air is the fastest because it covers the distance in hours, and the most costly because its charge by weight is higher, and it is restricted to what air carriage accepts by way of materials.
- Land is intermediate in period and in cost, and is affected by land borders, their congestion, their procedures and holidays.
- Sea is the longest because the consignment waits for a container to be consolidated, then makes a sea voyage on fixed sailing dates that cannot be hurried, then is discharged and cleared at the port; and it is the least costly for that reason.
- These periods are measured in business days and not calendar days, and do not include official holidays or days on which the crossings are closed.

### 3.10 The periods are estimates and not a promise
- Every period stated in this document or displayed on the platform is an estimate based on the ordinary course, and is not an undertaking as to a date.
- The mere passing of an estimated period gives rise of itself to neither compensation nor rescission, unless the delay reaches a degree that renders performance of the order purposeless, in which case it is dealt with under the Purchase Policy and the Payment Policy.
- No oral promise of a delivery date by any person is to be relied upon; what governs is what is recorded on the platform.
- Where the Store becomes aware that a delay is material, it notifies the customer and sets out their options; the platform's silence is not an acknowledgment of a date.

### 3.11 The tracking stages and the source of their updates
- The order's status appears to the customer in their account and moves between the stages set out in articles 3.7 and 3.8.
- Statuses whose source is the delivery company are carried over from the carrier's system automatically and periodically, and are recorded in the name of their source.
- Where the carrier's system cannot be reached, or where it returns a status description to which nothing at the Store corresponds, the order remains at its stage and is not moved, and what was received is recorded as received.
- This reservation is deliberate: an inability to know is not evidence of an event. The status remaining as it is amounts neither to an acknowledgment that nothing happened, nor to a denial of what in fact happened at the carrier.
- The customer may refer to support where a status remains static for an unusual period, and the Store may update it manually on what is established to it.

### 3.12 Geographic coverage
- The Store delivers to the eighteen governorates of the Republic of Iraq: Baghdad, Basra, Nineveh, Erbil, Sulaymaniyah, Duhok, Kirkuk, Diyala, Anbar, Babil, Karbala, Najaf, Wasit, Maysan, Dhi Qar, Muthanna, Al-Qadisiyyah and Salah Al-Din.
- The governorate is a field restricted to the list above and free text is not accepted in it, because the carrier routes the consignment on the name of the governorate, and a difference in spelling is to that carrier a different place and not a different name.
- Delivery within a governorate is to the areas the carrier serves. An outlying area the carrier does not serve may require collection from the nearest point the carrier designates, or an additional charge the carrier determines.
- The Store does not deliver outside the Republic of Iraq and does not accept an address outside it.
- The address the customer supplies is the governing one. Any delay, additional cost or failure of delivery arising from an incomplete or erroneous address is borne by the customer.

### 3.13 Delivery to the Kurdistan Region
- Delivery covers the governorates of the Kurdistan Region, being Erbil, Sulaymaniyah and Duhok, by the same methods displayed at checkout for those addresses.
- The delivery fee to the Region may differ from that to elsewhere, because the carrier prices on the governorate, the distance and the crossing; the difference appears at checkout before the order is placed.
- The delivery period to the Region may differ from the ordinary period according to the procedures at the crossings and the days on which they are closed, a cause outside the control of the Store and of the carrier alike.
- A parcel travelling to the Region or out of it may pass checkpoints at which parcels are opened, inspected and repacked; that is governed by article 3.26, which is a fundamental provision of this document.

### 3.14 The delivery fee and its charges are set by the delivery companies and not by the Store
- The delivery fee and the charges arising on it are set by the delivery companies and are not set by the Store.
- What the Store displays to the customer is what the delivery company charges, passed on as it is. The Store adds no profit to that fee, has no power to reduce it, and does not negotiate it on the customer's behalf.
- A carrier raising its tariff, or changing how it calculates distance or zone, is a matter outside the Store's control, for which it is not answerable, and which is not a change by the Store to a declared price.
- A tax or charge imposed by the delivery company on its service or on the collection of cash follows the same rule: its source is the carrier, and the Store passes it on rather than imposing it.
- What the Store bears for an entitled member under article 3.17 remains the carrier's own fee; the only difference is that the Store, and not the customer, pays it.

### 3.15 The fee shown at checkout is a figure of that moment
- The fee appearing at checkout is the delivery company's figure at that moment, calculated on the address, the governorate, the method and the contents of the cart as they stand at the time of display.
- That figure changes if the address changes, if the governorate changes, if the delivery method changes, or if the contents of the cart change in number, size, weight or kind.
- The fee recorded on the order when it is placed is the governing one for that order, and the customer is not pursued for a difference arising after the order is placed out of a change in the carrier's tariff.
- Where the customer requests, after placing the order, a change that obliges the carrier to a different fee, the matter is treated as a new order as to its fee; what may be changed is set out in articles 3.35 and 3.36.
- The fee displayed does not include any waiting charge, additional attempt or redelivery the carrier may impose, which is governed by article 3.33.

### 3.16 All delivery costs are on the customer
- The principle is that all delivery costs are on the customer: the last-mile fee, the fee of the method they selected, the tax arising on cash collection, the cost of redelivery, and the cost of return where the parcel is refused without a recognised reason.
- The cost of returning a defective product is dealt with in the Returns and Exchange Policy, and return shipping is on the customer as that document provides.
- The display of a zero fee on warehouse pickup is not to be understood as delivery being free, but as there being no last mile in that method at all.
- Excepted from the principle of this article is what is stated in article 3.17 exclusively, together with any promotion or referral the Store determines, the effect of which appears at checkout.

### 3.17 The membership exception: PRO and LEVO PREMIUM
- The Store bears the delivery costs of the member above a stated order value, on the following detail.
- An active LEVO PRO member: the Store bears their delivery fee where the eligible merchandise value exceeds the declared threshold for their membership, being {{PRO_FREE_DELIVERY_MIN_IQD}}; the excess must be strictly above it, so reaching the threshold does not suffice. What the Store bears for them covers standard delivery and protected packing.
- An active LEVO PREMIUM member: the Store bears their standard delivery fee alone where the eligible merchandise value exceeds the declared threshold for their membership, being {{PREMIUM_FREE_DELIVERY_MIN_IQD}}, strictly above. This waiver extends neither to protected packing nor to the additional charges in article 3.20.
- The eligible merchandise value is calculated on the merchandise after discounts, coupons and points and before the delivery fee, and does not include the delivery fee itself.
- Where two descriptions meet in one member, the PRO provision prevails as the wider of the two.
- The waiver lapses on the membership ending or being suspended and returns on its return, and has no retrospective effect on an earlier order.
- What the Store bears for the member appears on the invoice, itemised: the carrier's fee, then what the Store bore of it. The fee is not shown as zero without explanation, because an invoice that cannot be read cannot be relied upon.

### 3.18 The approved default address condition for a PRO member
- A PRO member's delivery benefits exist at their approved default address alone.
- Where a PRO member selects another address on an order, that order is priced as an ordinary customer's, which is not a deprivation of a benefit but a definition of where it exists.
- Eligibility returns automatically on the member returning to their approved address, without request or review.
- The checkout screen states the reason the waiver was not applied when another address is selected, so that the member is not surprised by a fee they did not expect.
- This condition is particular to PRO membership and is not to be applied by analogy to LEVO PREMIUM membership.

### 3.19 A ceiling on what the membership bears
- What the Store bears for the member may be subject to a declared upper ceiling in the membership terms.
- Where no ceiling is set, the Store bears the covered delivery fee in full.
- Where a ceiling is set and the fee reaches it, the Store bears the amount of the ceiling and the member pays the difference; in that case delivery is not said to be free, and the invoice states the amount the Store bore and the amount remaining on the member.
- The Store is bound to state that difference before the order is placed and not after.

### 3.20 Additional charges on the delivery fee
Charges following the nature of the goods may be added to the standard delivery fee, all of which appear at checkout before the order is placed:

- Printer charge: calculated on the printer according to its size class, and may be payable in advance of preparation where the Store's administration so determines.
- Carton charge: due where the number of filament spools exceeds the set threshold, its cause being that the quantity requires an additional carton which ordinary packing does not accommodate. This charge is not collected unless both the threshold and the amount of the charge are set.
- Protected packing: an optional service the customer requests, in which the parcel is packed and handled so as to help it withstand the journey. It is an addition to the tariff and not a substitute for it, no charge is made for it unless it is priced, and it is not offered unpriced.
- None of these charges is collected unless it is set and displayed. A charge that is not set is neither estimated nor assumed.
- Protected packing is a physical precaution in the packing and is not insurance on the parcel; it does not give rise to the Store bearing the transit damage provided for in article 3.25.

### 3.21 The twelve-hour fulfilment service for a PRO member
- The Store provides a PRO member with a twelve-hour fulfilment service, which is a conditional service and not an absolute benefit.
- Its conditions are cumulative: that the membership be active and entitled to the service; that delivery be to the approved default address; that the service be enabled by the Store's administration; that the selected delivery method be among the methods it covers; that the shipping type be covered by it; and that the governorate fall within its area where an area has been set.
- The service today covers personal delivery and direct sales. A pre-order is not covered by its nature, because its goods have not yet arrived.
- Where one of these conditions is not met, the particular reason for the failure is stated at checkout, the service is not counted and no charge is made for it.
- The twelve-hour period runs from the moment the service becomes due on the order; it is a period of fulfilment at the Store and does not negate the effect of road conditions arising at the carrier.

### 3.22 Payment at the door and the cash collection tax
- Cash on delivery is available on the official store path where it appears at checkout, and is not available on the community stores path under article 3.5.
- A collection tax is due on the amount collected in cash at the door, charged at a stated amount for every complete block of the amount payable before the tax; the amount of the tax and the size of the block are both displayed at checkout for that order. A fraction not amounting to a complete block bears nothing. Both figures may be amended by the Store's administration, and what governs each order is what appeared at checkout for that order at the time it was placed.
- This tax is not due on warehouse pickup, because there is no collection at a door and no carriage of cash.
- The tax appears on the invoice as an independent item in its amount and is not merged into the price.
- Where the customer is exempt from it under their membership, it is calculated in full and the exemption is then stated against it on the invoice, so that both figures remain auditable and no zero appears whose derivation is unknown.
- The delivery courier is not to be asked to collect an amount differing from the invoice, and no reliance is placed on an oral agreement between the customer and the courier as to another amount.
- The amount collected at the door is paid to the courier against a receipt, and the receipt is evidence of payment.

### 3.23 Customs duty and import charges
- The price displayed on a pre-order product includes the transport cost and commission the Store has disclosed, and does not include a charge imposed by an official authority upon the customer personally.
- Where an official authority imposes a customs duty, an import charge or an entry charge due from the customer personally, it is on the customer and is paid to the authority imposing it and not to the Store.
- The Store does not estimate the amount of such a charge and does not guarantee that none will be imposed, because its estimation and its imposition are not for the Store to make.
- What the Store bears by way of clearance and entry for its own consignment is included within its own cost and is not claimed from the customer a second time.
- Where an official claim of this kind arises, the Store makes available to the customer such consignment documents as it holds so as to assist them in approaching the competent authority, by way of assistance and not of obligation. For enquiries: {{LEVONIS_SUPPORT_CONTACT}}.

### 3.24 The Store's packing obligation and the limits of that obligation
- The Store undertakes to pack the goods soundly in a manner appropriate to their nature, weight and fragility, and to hand them to the delivery company in that condition.
- The Store undertakes that what is in the parcel corresponds to what is in the order in number, kind and model.
- The Store undertakes to hand the carrier correct delivery particulars as supplied by the customer.
- The Store's physical obligation ends upon the parcel being handed to the delivery company in sound condition. What follows is the carrier's possession and the carrier's responsibility.
- The burden of proving the soundness of the packing at the time of handover to the carrier lies on the Store, and is discharged by such records of preparation and handover to the carrier as it holds.

### 3.25 The Store is not liable for damage occurring during transport
- The Store does not bear damage occurring to the parcel during transport after it has been handed to the delivery company in sound condition.
- This includes breakage, denting, scratching, wetting, theft, loss, mishandling and shortage of contents occurring in the carrier's possession.
- The reason for this provision is that the parcel passes out of the Store's hands into those of an independent legal person, over whose workers, vehicles, routes and warehouses the Store exercises no supervision.
- The Store not bearing this damage does not mean that it denies it, does not prevent the customer from claiming against the carrier, and does not prevent the Store from assisting them to do so under article 3.29.
- What is established to be a latent manufacturing defect unconnected with transport remains governed by the Warranty Policy, and a warranty claim is not to be met with this article.
- What is established to have been caused by defective packing by the Store remains on the Store and does not shelter behind this article.

### 3.26 The Kurdistan Region border, checkpoints and the opening of parcels
- The Store does not bear damage occurring to the parcel at the border of the Kurdistan Region, nor at any checkpoint, control point or crossing at which the parcel is opened, inspected and repacked by a party which is neither the Store nor the delivery company.
- This includes what arises from the opening by way of tapes being cut, the original packing being damaged, repacking otherwise than as originally packed, parts being dismantled, and shortages in what was inside the parcel.
- The party opening the parcel in such a case exercises an official power which the Store has no power to resist, to object to, or to attend.
- It is not a condition of this provision that the opening be unlawful; it suffices that the opening and repacking occur at the hands of that party.
- This provision applies alike to a parcel travelling to the Region, out of it and through it.
- Where a parcel arrives bearing a visible trace of this kind, the correct course is that set out in articles 3.27 and 3.30, and the Store assists in approaching the carrier under article 3.29.

### 3.27 What the customer is to record at the door
In order to preserve the customer's right against the carrier, and so that the event remains capable of proof, the customer is, before signing for receipt, to do the following:

- Inspect the outer carton in front of the courier: whether it is open, whether its tape is cut or re-applied, and whether it bears a dent, a tear or a trace of wetting.
- Photograph the parcel from the outside before opening it, so that the label and the condition of the packing appear in the photograph.
- Open the parcel in front of the courier where the delivery method permits, and film the opening in a single continuous unbroken clip.
- Verify the number, the contents, the model, the serial number and the soundness of the inner packing.
- Record a written reservation on the delivery receipt where a visible trace exists, or refuse receipt under article 3.31.
- Notify the Store within {{DAMAGE_REPORT_WINDOW_HOURS}} hours of delivery with the order number, the photographs and the clips.
- The courier is not to be asked to wait for an inspection exceeding {{DOOR_INSPECTION_MINUTES}} minutes, nor to operate and test the device at the door.

### 3.28 The effect of the customer not recording
- Signing for receipt without reservation where a visible trace exists on the carton weakens a transit damage claim to the point of its falling away, because the signature is an acknowledgment of receipt in the apparent condition.
- A parcel opened after the courier has left, without continuous filming, does not admit a claim for shortage of contents, because the event is no longer capable of proof by the customer, by the Store or by the carrier.
- Notification after the stated period weakens the claim and may not be accepted where its subject is something visible that could have been seen at the door.
- The foregoing does not preclude a warranty claim for a latent manufacturing defect, which is governed by the Warranty Policy and not by this document.

### 3.29 The Store's assistance in a claim against the carrier
The Store does not bear transit damage; it nevertheless does the following by way of assistance to the customer, which is an obligation of means and not of result:

- Providing the customer and their claim against the carrier with such consignment number, tracking number, date of handover to the carrier and statement of the parcel's contents as the Store holds.
- Producing what establishes the condition of the parcel at the time it was handed to the carrier.
- Raising the claim with the carrier in the Store's name as the party contracting with it, where the carrier accepts this.
- Following up the carrier's answer and conveying it to the customer as received, without promise as to a result or as to a period.
- Where the carrier acknowledges liability and pays compensation for the parcel, the compensation passes to the customer to the extent actually paid.
- Where the carrier denies liability, the customer retains their right to approach it directly, and the Store remains on the position stated in article 3.25.
- A claim against the carrier is limited by a period the carrier itself sets, and the Store is not answerable for the lapse of a period caused by the customer's delay in notifying.

### 3.30 A parcel that arrives open
- A parcel that arrives open, or repacked otherwise than in its original packing: the customer may refuse receipt of it, and refusal is the correct course in that case.
- Where the customer elects to receive it, they record their reservation on the receipt, photograph the parcel before and during opening, and notify the Store within the period.
- A parcel refused for this reason returns to the Store, is inspected on its arrival, and the order is determined on the basis of what the inspection reveals.
- The cost of return in this case is not charged to the customer where the visible trace is documented by photographs.
- Where the inspection reveals that the cause of the opening was the act of an official authority, article 3.26 applies, the Store does not bear the damage, and it assists the customer under article 3.29.

### 3.31 Refusal at the door
- The customer may refuse receipt at the door.
- A refusal founded on a reason recognised by this document, such as the parcel arriving open, documented damage appearing, or a visible non-conformity, does not carry the cost of its return to the customer.
- A refusal not founded on such a reason carries the cost of the outward and return journey to the customer, which is deducted from any amount refunded.
- A refused parcel returns to the Store and the order is treated as cancelled under the Purchase Policy and the Payment and Wallet Policy.
- Repeated refusal without reason from the same account exposes the account to a restriction on cash on delivery, so that advance payment is required of it.

### 3.32 The customer being unreachable or absent
- The customer is to be available on the number recorded in their account on the expected delivery days, and their address is to be reachable.
- Where the customer does not answer the courier's call, or is absent from the address, the attempt is counted and recorded as a failed delivery attempt.
- The carrier repeats the attempt in accordance with its own system. Where the customer cannot be reached after {{FAILED_DELIVERY_ATTEMPTS}} attempts, the parcel is returned to the Store and the order is treated as a refusal at the door without reason.
- Where the customer cannot be reached to confirm the order at all within {{ORDER_CONFIRMATION_WINDOW_HOURS}} hours, the Store may cancel the order under the Selling Policy.
- A recorded number that is wrong, switched off or out of use is a cause attributable to the customer, and the cost arising from it is on them.

### 3.33 Redelivery and who bears its cost
- Redelivery after a failed attempt caused by the customer bears a redelivery fee of {{REDELIVERY_FEE_IQD}}, set by the delivery company and passed on to the customer as it is.
- Redelivery caused by the Store or the carrier, such as an error in preparation or in routing the consignment, is not borne by the customer.
- A waiting charge or additional attempt charge imposed by the carrier follows article 3.14: its source is the carrier and the Store passes it on.
- Where the customer, after a failed attempt, wishes to collect their order from the Store's warehouse instead of redelivery, that is permitted where the pickup method is available for that order, and no redelivery fee is charged.
- An order that finally cannot be delivered returns to the Store, and the cancellation and refund provisions of the Payment and Wallet Policy apply to it after deduction of the costs incurred.

### 3.34 Choosing the delivery day, changing it, and the ceiling on that
- The customer may state a preferred day for delivery when placing the order or before the parcel is handed to the delivery company, notifying support at {{LEVONIS_SUPPORT_CONTACT}}.
- A day preference is a request on which the Store uses its endeavours; it is not a reservation of an appointment, and no consequence follows from its not being met.
- A change of the preferred day is accepted no later than {{DELIVERY_DAY_CHANGE_NOTICE_HOURS}} hours before the parcel is handed to the carrier.
- The ceiling on changes is {{DELIVERY_DAY_CHANGE_LIMIT}} per order. Beyond that the matter is treated as an unusual postponement, and the Store may then keep the order as it stands or cancel it under the Selling Policy.
- A postponement of delivery at the customer's request extends neither the return period nor the warranty period, both of which run from actual delivery.
- A postponement that keeps the goods reserved at the Store for an unusual period entitles the Store to a storage charge of {{STORAGE_FEE_PER_DAY_IQD}} per day after the lapse of {{PICKUP_HOLD_DAYS}} days from the readiness notice.

### 3.35 A parcel already handed to the carrier is neither rerouted nor rescheduled through the Store
- After the parcel has been handed to the delivery company, the Store has no power to change its address, to divert it to another city or another person, to bring its date forward or back, or to stop it in transit.
- The reason is that the consignment passes into the carrier's possession and the carrier's system, in which the Store holds nothing beyond creating the consignment and asking after its condition. It has no procedure for rerouting and none for rescheduling.
- Any promise to the contrary by any person does not bind the Store and is not to be relied upon.
- What the customer holds in this case is two things: approaching the delivery company directly on the consignment number in accordance with its system, or refusing receipt at the door and then placing the order afresh on the correct particulars.
- The Store assists the customer in reaching the carrier and provides them with the consignment number; that carries no undertaking that what they seek will be achieved.
- Any amendment the carrier accepts remains between the customer and the carrier, and any charge arising from it is on the customer.

### 3.36 Changing the address before handover to the carrier
- A change of the delivery address is accepted before the parcel is handed to the delivery company, and is requested from support at {{LEVONIS_SUPPORT_CONTACT}} within {{ADDRESS_CHANGE_DEADLINE_HOURS}} hours of the order being placed or before handover to the carrier, whichever is the earlier.
- Where the new address gives rise to a different fee at the carrier, the difference is collected from or returned to the customer as the case may be before preparation.
- Where the change moves delivery to another governorate, the available method, the estimated period and the fee may all change together.
- A change of address by a PRO member to other than their approved default address causes the waiver to lapse on that order under article 3.18.
- After the parcel has been handed to the carrier, article 3.35 applies and no change is accepted.

### 3.37 Receipt by another person on the customer's behalf
- The parcel may be received by an adult present at the recorded address, and their receipt is a valid receipt producing its effect.
- That person's signature on receipt binds the customer as regards the acknowledgment of the parcel's apparent condition.
- The customer is to inform the person acting for them of what article 3.27 provides, for the inspection of the packing and the recording of a reservation is a right lost by neglect.
- Payment at the door by that person discharges the customer to the extent paid against a receipt.
- The courier may not leave the parcel in the absence of a person to receive it unless the customer has authorised this in writing, and such authorisation transfers the risk of loss to the customer.

### 3.38 Warehouse pickup
- Warehouse pickup is available on the official store path where it appears as an option at checkout for that order, and is not available on the community stores path under article 3.5.
- The collection location is {{LEVONIS_WAREHOUSE_ADDRESS}} and its hours are {{LEVONIS_PICKUP_HOURS}}.
- No delivery fee is charged on this method, and no cash collection tax is due under article 3.22, because there is no last mile and no collection at a door.
- The person collecting is to produce proof of identity and the order number.
- The customer may inspect the contents on collection at the warehouse, which is wider than what is available at the door, and any observations appearing are recorded at the time.
- An order ready for collection is held for {{PICKUP_HOLD_DAYS}} days from the readiness notice, after which the Store may cancel it and return what was paid on it under the Payment and Wallet Policy, or charge storage of {{STORAGE_FEE_PER_DAY_IQD}} per day.
- A parcel collected from the warehouse passes into the customer's possession upon leaving the warehouse, and the transit damage provision does not apply to it, because there is no carrier in it.

### 3.39 Circumstances beyond control
- The Store is not answerable for a delay or a failure of delivery caused by a matter beyond its control, such as the closure of roads and crossings, the suspension of official working hours, weather conditions, disturbances, interruption of the carrier's services and decisions of official authorities.
- The customer retains in such a case their right to the amount paid where the order is not performed, under the Payment and Wallet Policy.
- This provision is not a general exemption and is not to be extended to cover a failure by the Store in preparation or in disclosure.

### 3.40 Precedence on conflict and the governing law
- What is stated in this document as to delivery and charges prevails over what is stated incidentally in the other documents.
- What is stated in the Warranty Policy and the Returns and Exchange Policy as to defects and returns prevails over what is stated incidentally here.
- Placing an order is acceptance of what is in this document in the version in force at the time of placing it, and the archived version bearing its date is the authority.
- This document is governed by the law of {{GOVERNING_LAW_JURISDICTION}}, and {{COMPETENT_COURT}} has jurisdiction over any dispute arising from it.
- For enquiries and claims: {{LEVONIS_SUPPORT_CONTACT}}.
`,
    ckb: `## بەڵگەنامەی گەیاندن و ناردن و کرێیەکان — بڕگەی 3

ئەم بەڵگەنامەیە ڕوون دەکاتەوە چۆن داواکاری دەگاتە کڕیار: بە چ ڕێگایەک، لە چ ماوەیەکدا، بە چ کرێیەک، کێ ئەو کرێیە دەگرێتە ئەستۆ، بەرپرسیارێتی فرۆشگا لە کوێ کۆتایی دێت و بەرپرسیارێتی کۆمپانیای گەیاندن لە کوێ دەست پێدەکات. لەگەڵ سیاسەتی کڕین و سیاسەتی فرۆشتن و سیاسەتی پارەدان و جزدان و سیاسەتی گەڕاندنەوە و ئاڵوگۆڕ و سیاسەتی گەرەنتی دەخوێنرێتەوە. دەقی عەرەبی دەقی پەسەندکراوە، و هەر وەرگێڕانێک کە جیاواز بێت لەگەڵی، بۆی دەگەڕێتەوە.

### 3.1 بوارى ئەم بەڵگەنامەیە
- ئەم بەڵگەنامەیە لەسەر هەر داواکارییەک جێبەجێ دەبێت کە لە ناو پلاتفۆرمەکەدا دروست دەکرێت و لە ناو کۆماری عێراقدا دەگەیەنرێت.
- لەسەر داواکارییەکانی فرۆشگای فەرمیی Levonis جێبەجێ دەبێت، و لەسەر داواکارییەکانی فرۆشگاکانی کۆمەڵگە لە سنووری ئەوەی بڕگەی 3.5 دەیڵێت.
- لەسەر ئەو گواستنەوەیە جێبەجێ نابێت کە کڕیار خۆی لەگەڵ گەیەنەرێکی خۆی ڕێک دەخات، و نە لەسەر کاڵایەک کە لە پلاتفۆرمەکەوە نەکڕدراوە.
- ئەوەی لێرەدا هاتووە گواستنەوە و گەیاندن و کرێیەکان بەڕێوە دەبات. بەڵام عەیب و گەرەنتی و گەڕاندنەوە لەو بەڵگەنامانەدان کە تایبەتن پێیان.

### 3.2 پێناسەکان
مەبەست لەم وشانەی خوارەوە، لە هەر شوێنێکی ئەم بەڵگەنامەیەدا بێن، ئەو مانایانەیە کە بەرامبەریان دیاری کراون:

- فرۆشگا: {{LEVONIS_LEGAL_NAME}}، بەڕێوەبەری پلاتفۆرمی Levonis.
- کۆمپانیای گەیاندن یان گەیەنەر: ئەو کۆمپانیا سەربەخۆیەی پاکەتەکە دەگوازێتەوە و دەیگەیەنێت، و کەسێکی یاسایی سەربەخۆیە لە فرۆشگا.
- پاکەت: ئەو یەکە پێچراوەی بە یەک داواکاری دراوەتە گەیەنەر.
- ڕادەستکردن بە گەیەنەر: ئەو ساتەی گەیەنەر پاکەتەکە لە فرۆشگا یان لە کۆگاکەی وەردەگرێت.
- گەیاندن بە کڕیار: ئەو ساتەی کڕیار یان نوێنەرەکەی پاکەتەکە لە بەردەرگا یان لە خاڵی وەرگرتن وەردەگرێت.
- ڕێگای گەیاندن: ئەو هەڵبژاردەیەی کڕیار لە شاشەی پارەداندا بۆ دوا مەودا هەڵیدەبژێرێت، واتە گەیاندنی ئاسایی یان گەیاندنی کەسی یان وەرگرتن لە کۆگا.
- جۆری ناردن: ڕێڕەوی دابینکردنی کاڵاکە خۆی، واتە فرۆشتنی ڕاستەوخۆ یان پێش-داواکاری بە ئاسمان یان بە دەریا یان بە وشکانی.
- ئەندام: خاوەنی ئەندامێتیی چالاکی LEVO PRO یان LEVO PREMIUM.
- ناونیشانی بنەڕەتیی پەسەندکراو: ئەو یەک ناونیشانە پەسەندکراوەی لەسەر هەژماری ئەندامی PRO، کە ئیمتیازەکانی بەپێی ئەو دەپێورێن.
- فرۆشگای کۆمەڵگە: فرۆشگای بازرگانێکی سەربەخۆ کە کاڵاکەی لە ناو پلاتفۆرمەکەدا نیشان دەدات و خۆی دەیفرۆشێت.

### 3.3 ئەو ڕێگا گەیاندنانەی لە پارەداندا پیشان دەدرێن
فرۆشگا لە شاشەی پارەداندا ئەم ڕێگایانە پیشان دەدات، و هیچیان بۆ داواکارییەکی دیاریکراو بەردەست نین مەگەر بەڕاستی لەو شاشەیەدا دەربکەون:

- گەیاندنی ئاسایی: گەیاندن بۆ ناونیشانی کڕیار لە ڕێگەی کۆمپانیای گەیاندنەوە، و ماوەی خەمڵێنراوی بڵاوکراوە لە بەرواری جێبەجێبوونی ئەم وەشانەدا دوو بۆ سێ ڕۆژی کار.
- گەیاندنی کەسی: گەیاندن بۆ ناونیشانی کڕیار لە هەمان ڕۆژدا لەو ناوچانەی ڕێگە دەدەن و بەپێی کاتی داواکاری، و کرێیەکەی لە ئاسایی بەرزترە چونکە تێچووی لەسەر گەیەنەر زیاترە.
- وەرگرتن لە کۆگا: کڕیار خۆی داواکارییەکەی لە کۆگای فرۆشگا وەردەگرێت بەبێ کرێی گەیاندن، و ماوەی ئامادەکردنی خەمڵێنراوی بڵاوکراوە لە بەرواری جێبەجێبوونی ئەم وەشانەدا دوو کاتژمێرە.

ئەو ژمارانەی سەرەوە ڕێنمایین و دەکرێت لەلایەن بەڕێوەبەرایەتیی فرۆشگاوە بگۆڕدرێن. ئەوەی لە هەر داواکارییەکدا پەسەندکراوە، ئەوەیە کە لە شاشەی پارەدانی ئەو داواکارییەدا لە کاتی جێگیرکردنیدا دەرکەوتووە.

### 3.4 بەردەستبوونی ڕێگای گەیاندن بۆ هەموو بەرهەمێک دڵنیایی نییە
- هەندێک بەرهەم یاسای گەیاندنی تایبەت بە خۆیان هەیە، کە دیاری دەکەن بەرهەمەکە چ ڕێگایەک وەردەگرێت و بە چ کرێیەک بۆ هەر ژمارەیەک یەکە.
- ئەگەر لە سەبەتەکەدا بەرهەمێک هەبێت کە ڕێگای هەڵبژێردراو وەرناگرێت، داواکارییەکە بەو ڕێگایە بە ئاشکرا ڕەت دەکرێتەوە و ئەو بەرهەمە دیاری دەکرێت کە ڕێگر بووە، نەک داواکارییەکە وەربگیرێت و پاشان لە بەردەرگا داوای لێبووردن بکرێت.
- شاشەی پارەدان کرێی هەر ڕێگایەک لەسەر هەمان سەبەتە پیشان دەدات، نەک لەسەر نرخێکی گشتی کە نازانێت چی لە سەبەتەکەدایە.
- ئەو ڕێگایەی وەک بەردەستنەبوو دەردەکەوێت، بە داواکارییەکی ڕاستەوخۆ بۆ ڕاژە ناسەپێندرێت، چونکە ڕەتکردنەوەکە لە ڕاژەکەدا ڕوودەدات نەک لە ڕووکارەکەدا.

### 3.5 گەیاندنی داواکارییەکانی فرۆشگاکانی کۆمەڵگە
- داواکاریی فرۆشگای کۆمەڵگە بازرگانەکە دەیفرۆشێت و بازرگانەکە دەینێرێت، و فرۆشگا ناوەندێکی پلاتفۆرمە نەک گەیەنەر و نەک فرۆشیاری ئەو کاڵایە.
- داواکاریی فرۆشگای کۆمەڵگە پێشوەخت لە جزدانی کڕیارەوە دەدرێت. لەم ڕێڕەوەدا پارەدان لە کاتی وەرگرتن نییە و وەرگرتن لە کۆگای فرۆشگاش نییە، چونکە فرۆشگا نە کاڵای بازرگانەکە لەلایە و نە پارەکەی کۆدەکاتەوە، و لە هیچ لایەکیاندا کەسی نییە وەربگرێت یان ڕادەست بکات.
- کرێی گەیاندنی داواکاریی فرۆشگای کۆمەڵگە بە ڕێکخستنەکانی ئەو فرۆشگایە دیاری دەکرێت و پێش جێگیرکردنی داواکارییەکە بۆ کڕیار دەردەکەوێت.
- ئەوەی لەم بەڵگەنامەیەدا سەبارەت بە زیانی گواستنەوە و خاڵەکانی پشکنین هاتووە، بە هەمان پلە لەسەر داواکاریی فرۆشگای کۆمەڵگەش جێبەجێ دەبێت، لەگەڵ مانەوەی پابەندیی بازرگانەکە بە کاڵاکەی خۆی.

### 3.6 جۆری ناردن، و یەک سەبەتە بۆ یەک جۆر
- هەر بەرهەمێک جۆری ناردنی هەیە: فرۆشتنی ڕاستەوخۆ، یان پێش-داواکاری بە ئاسمان، یان بە دەریا، یان بە وشکانی.
- یەک سەبەتە دوو جۆر کۆناکاتەوە. یەکەم بەرهەمی دەچێتە سەبەتەکەوە جۆرەکەی دیاری دەکات، و ئەوانەی دواتر دەبێت هاوتای بن، ئەگەرنا زیادکردنەکە ڕەت دەکرێتەوە تا سەبەتەکە چۆڵ دەکرێت.
- هۆکاری ئەم ڕێگرییە ئەوەیە کە دوو جۆرەکە دوو وەسفی یەک گەشت نین، بەڵکو دوو گەشتی جیاوازن کە نە یەک کاتیان هەیە و نە یەک ڕێڕەوی بەدواداچوون. داواکارییەک کە هەردووکیان کۆبکاتەوە، بە ڕاستی ناکرێت بوترێت کەی دەگات.
- ئەم ڕێگرییە سنووردارکردنی کڕیار نییە، چونکە دەتوانێت بۆ هەر جۆرێک داواکارییەکی سەربەخۆ دروست بکات، و هەر داواکارییەک کات و کرێی خۆی هەیە.

### 3.7 گەیاندن لە فرۆشتنی ڕاستەوخۆدا
- فرۆشتنی ڕاستەوخۆ کاڵایەکە کە لە کاتی داواکاریدا لای فرۆشگا ئامادەیە، ئامادە دەکرێت و دەدرێتە گەیەنەر و پاشان دەگەیەنرێتە کڕیار.
- قۆناغەکانی پێنجن: داواکاری وەرگیرا، پاشان پەسەندکرا، پاشان ئامادەکردن، پاشان بۆ گەیاندن دەرچوو، پاشان گەیەنرا.
- ماوەی خەمڵێنراوی بڵاوکراوە بۆ ناردنی ڕاستەوخۆ لە بەرواری جێبەجێبوونی ئەم وەشانەدا سێ بۆ پێنج ڕۆژی کارە لە جێگیرکردنی داواکارییەوە، و ئەمە جیاوازە لە ماوەی خەمڵێنراوی ڕێگای گەیاندن خۆی لە بڕگەی 3.3، چونکە یەکەمیان ئامادەکردن دەگرێتەوە و دووەمیان دوا مەودا.
- ئامادەکردنی فرۆشتنی ڕاستەوخۆ بەستراوەتەوە بە تەواوکردنی ئەو پارەدانە پێشوەختەی لەسەر کڕیارە لەو حاڵەتانەی داوا دەکرێت.

### 3.8 ناردن لە پێش-داواکاریدا بە ئاسمان و دەریا و وشکانی
- پێش-داواکاری کاڵایەکە کە دوای جێگیرکردنی داواکارییەکە لە دابینکەرێکی دەرەوەی عێراق دەکڕدرێت، پاشان کۆدەکرێتەوە و دەگوازرێتەوە و ڕەوانە دەکرێت و دەخرێتە کۆگای فرۆشگاوە، پاشان بە ناوخۆیی دەگەیەنرێت.
- ماوە خەمڵێنراوەکانی بڵاوکراوە لە بەرواری جێبەجێبوونی ئەم وەشانەدا: ئاسمانی دە بۆ چواردە ڕۆژی کار، وشکانی بیست بۆ سی ڕۆژی کار، دەریایی سی بۆ چل و پێنج ڕۆژی کار.
- پێش-داواکاری چواردە قۆناغی هەیە، بە وەرگرتن و پەسەندکردنی داواکارییەکە دەست پێدەکات، پاشان ئامادەکردنی دابینکەر، پاشان کۆگای سەرچاوە، پاشان ئامادەکردنی بارەکە، پاشان ڕادەستکردن بە گەیەنەری نێودەوڵەتی، پاشان دەرچوون لە سەرچاوە، پاشان ڕێگا بۆ عێراق، پاشان گەیشتن بە عێراق، پاشان ڕێگا بۆ کۆگای لێڤۆ، پاشان کۆگای لێڤۆ، پاشان ئامادەکردنی گەیاندنی ناوخۆیی، پاشان دەرچوون بۆ گەیاندن، پاشان گەیاندن.
- پێش-داواکاری دوای گەیشتنی بە کۆگای فرۆشگا، ملکەچی هەمان یاساکانی گەیاندنی ناوخۆییە کە لەم بەڵگەنامەیەدا هاتوون.
- لەوانەیە بەپێی جۆری گواستنەوە کۆمیسیۆنێکی گواستنەوە بکەوێتە سەر نرخی بەرهەمەکە، و لە ناو نرخەکەیدا پێش جێگیرکردنی داواکارییەکە دەردەکەوێت نەک دوای.

### 3.9 هۆکاری جیاوازیی ماوەکان لە نێوان ڕێگاکاندا
جیاوازیی ماوە لە نێوان ئاسمانی و وشکانی و دەریاییدا هەڵبژاردەیەکی بازاڕگەری نییە، بەڵکو جیاوازییە لە سروشتی گواستنەوەکە خۆیدا:

- ئاسمانی خێراترینە چونکە مەودایەکە بە کاتژمێر دەبڕێت، و گرانترینە چونکە کرێی کێشی تێدا بەرزترە، و سنووردارە بەوەی گواستنەوەی ئاسمانی چ ماددەیەک وەردەگرێت.
- وشکانی مامناوەندە لە ماوە و تێچوودا، و کاریگەری سنووری وشکانی و قەرەباڵغی و ڕێکارەکانی و ڕۆژانی پشوو لەسەرە.
- دەریایی درێژترینە چونکە بارەکە چاوەڕێی پڕبوونی کۆنتەینەرەکە دەکات، پاشان گەشتێکی دەریایی بە بەرواری دیاریکراوی دەریاکەوتن دەبڕێت کە پەلەیان پێناکرێت، پاشان لە بەندەردا دادەبەزێنرێت و ڕەوانە دەکرێت، و بەم هۆیەوە کەمترین تێچووی هەیە.
- ئەم ماوانە بە ڕۆژی کار دەپێورێن نەک بە ڕۆژی ساڵنامە، و پشووە فەرمییەکان و ڕۆژانی داخستنی دەروازەکانیان تێدا ناژمێردرێن.

### 3.10 ماوەکان خەمڵاندنن نەک بەڵێن
- هەر ماوەیەک لەم بەڵگەنامەیەدا یان لە پلاتفۆرمەکەدا پیشان بدرێت، خەمڵاندنێکە لەسەر بنەمای باو، و پابەندبوون بە بەروارێک نییە.
- تەنها تێپەڕبوونی ماوەی خەمڵێنراو نە قەرەبوو دەخوڵقێنێت و نە هەڵوەشاندنەوە، مەگەر دواکەوتنەکە بگاتە ئەو ئاستەی جێبەجێکردنی داواکارییەکە بێ واتا بکات، ئەو کاتە بەپێی سیاسەتی کڕین و سیاسەتی پارەدان چارەسەر دەکرێت.
- بەڵێنێکی زارەکی لەسەر بەرواری گەیاندن لە هەر کەسێکەوە بێت پشتی پێ نابەسترێت، و ئەوەی پەسەندکراوە ئەوەیە کە لە پلاتفۆرمەکەدا تۆمارکراوە.
- ئەگەر بۆ فرۆشگا دەرکەوت کە دواکەوتنەکە بنەڕەتییە، کڕیار ئاگادار دەکاتەوە و هەڵبژاردەکانی بۆ ڕوون دەکاتەوە، و بێدەنگیی پلاتفۆرمەکە دانپێدانان بە بەروارێک نییە.

### 3.11 قۆناغەکانی بەدواداچوون و سەرچاوەی نوێکردنەوەیان
- دۆخی داواکارییەکە لە هەژمارەکەیدا بۆ کڕیار دەردەکەوێت، و لە نێوان ئەو قۆناغانەدا دەجوڵێت کە لە بڕگەکانی 3.7 و 3.8 هاتوون.
- ئەو دۆخانەی سەرچاوەکەیان کۆمپانیای گەیاندنە، بە شێوەی خۆکار و دەوری لە سیستەمی گەیەنەرەوە دەگوازرێنەوە، و بە ناوی سەرچاوەکەیانەوە تۆمار دەکرێن.
- ئەگەر نەکرا پەیوەندی بە سیستەمی گەیەنەرەوە بکرێت، یان وەسفی دۆخێکی لێوە هات کە لای فرۆشگا هاوتای نەبوو، داواکارییەکە لە قۆناغەکەی خۆیدا دەمێنێتەوە و ناجوڵێنرێت، و ئەوەی هاتووە وەک خۆی تۆمار دەکرێت.
- ئەم وریایییە بە ئەنقەست ە: نەتوانینی زانین بەڵگە نییە لەسەر ڕووداوێک. مانەوەی دۆخەکە لەسەر ئەوەی هەیە نە دانپێدانانە بەوەی هیچ ڕووینەداوە، و نە نکۆڵییە لەوەی بەڕاستی لای گەیەنەر ڕوویداوە.
- کڕیار دەتوانێت پەیوەندی بە پشتیوانییەوە بکات ئەگەر دۆخەکە ماوەیەکی نائاسایی وەستا بوو، و فرۆشگا دەتوانێت بە دەست نوێی بکاتەوە بەپێی ئەوەی بۆی سەلمێنراوە.

### 3.12 داپۆشینی جوگرافی
- فرۆشگا بۆ هەژدە پارێزگای کۆماری عێراق دەگەیەنێت: بەغدا، بەسرە، نەینەوا، هەولێر، سلێمانی، دهۆک، کەرکووک، دیالە، ئەنبار، بابل، کەربەلا، نەجەف، واسیت، مەیسان، زیقار، موسەنا، قادسیە و سەلاحەدین.
- پارێزگا خانەیەکی سنووردارە بەو لیستەی سەرەوە و دەقی ئازادی تێدا وەرناگیرێت، چونکە گەیەنەر بارەکە بەپێی ناوی پارێزگا ئاڕاستە دەکات، و جیاوازیی ڕێنووس لای ئەو شوێنێکی دیکەیە نەک ناوێکی دیکە.
- گەیاندن لە ناو پارێزگادا بۆ ئەو ناوچانەیە کە گەیەنەر خزمەتیان دەکات. ئەو ناوچە دوورانەی گەیەنەر خزمەتیان ناکات لەوانەیە پێویستیان بە وەرگرتن بێت لە نزیکترین خاڵی دیاریکراوی گەیەنەر، یان کرێیەکی زیادە کە گەیەنەر بڕیاری لەسەر دەدات.
- فرۆشگا بۆ دەرەوەی کۆماری عێراق ناگەیەنێت، و ناونیشانی دەرەوەی وەرناگرێت.
- ئەو ناونیشانەی کڕیار پێشکەشی دەکات، ئەوەیە کە پەسەندکراوە. هەر دواکەوتن یان تێچووی زیادە یان نەگەیشتنێک کە لە کەمی یان هەڵەی ناونیشانەکەوە سەرچاوە بگرێت، لەسەر کڕیارە.

### 3.13 گەیاندن بۆ هەرێمی کوردستان
- گەیاندن پارێزگاکانی هەرێمی کوردستان دەگرێتەوە: هەولێر و سلێمانی و دهۆک، بە هەمان ئەو ڕێگایانەی لە شاشەی پارەداندا بۆ ئەو ناونیشانانە پیشان دەدرێن.
- لەوانەیە کرێی گەیاندن بۆ هەرێم جیاواز بێت لەوەی بۆ شوێنی دیکە، چونکە گەیەنەر بەپێی پارێزگا و مەودا و دەروازە نرخ دادەنێت، و جیاوازییەکە پێش جێگیرکردنی داواکارییەکە لە شاشەی پارەداندا دەردەکەوێت.
- لەوانەیە ماوەی گەیاندن بۆ هەرێم جیاواز بێت لە ماوەی ئاسایی بەپێی ڕێکارەکانی دەروازەکان و ڕۆژانی داخستنیان، و ئەمە هۆکارێکە لە دەرەوەی ویستی فرۆشگا و ویستی گەیەنەر پێکەوە.
- ئەو پاکەتەی بەرەو هەرێم دەچێت یان لێوە دەردەچێت، لەوانەیە بە خاڵی پشکنیندا تێپەڕێت کە تێیدا پاکەتەکان دەکرێنەوە و دەپشکنرێن و دووبارە دەپێچرێنەوە، و یاسای ئەمە لە بڕگەی 3.26دایە، کە بڕگەیەکی بنەڕەتییە لەم بەڵگەنامەیەدا.

### 3.14 کرێی گەیاندن و کرێیەکانی لەلایەن کۆمپانیاکانی گەیاندنەوە دیاری دەکرێن نەک لەلایەن فرۆشگاوە
- کرێی گەیاندن و ئەو کرێیانەی لەسەری دەکەون، لەلایەن کۆمپانیاکانی گەیاندنەوە دیاری دەکرێن، و فرۆشگا دیاریان ناکات.
- ئەوەی فرۆشگا بۆ کڕیاری پیشان دەدات، ئەوەیە کە کۆمپانیای گەیاندن وەریدەگرێت، وەک خۆی دەیگوازێتەوە بۆی. فرۆشگا هیچ قازانجێک ناخاتە سەر ئەم کرێیە، و توانای کەمکردنەوەی نییە، و لە جیاتی کڕیار دانوستانی لەسەر ناکات.
- بەرزکردنەوەی نرخی گەیەنەر یان گۆڕینی شێوازی ژمێریاریی مەودا یان ناوچە، شتێکە لە دەرەوەی ویستی فرۆشگا، و لێی بەرپرسیار نییە، و گۆڕینێکی فرۆشگا نییە بۆ نرخێکی ڕاگەیەنراو.
- ئەو باج یان کرێیەی کۆمپانیای گەیاندن لەسەر خزمەتەکەی یان لەسەر کۆکردنەوەی پارە دەیسەپێنێت، هەمان یاسای بەسەردا دێت: سەرچاوەکەی گەیەنەرە، و فرۆشگا گوازەرەوەیەتی نەک سەپێنەری.
- ئەوەی فرۆشگا لە جیاتی ئەندامێکی شایستە بەپێی بڕگەی 3.17 دەیگرێتە ئەستۆ، هەر کرێی گەیەنەر خۆیەتی، تەنها جیاوازییەکە ئەوەیە کە فرۆشگا دەیدات نەک کڕیار.

### 3.15 ئەو کرێیەی لە پارەداندا پیشان دەدرێت ژمارەیەکی ئەو ساتەیە
- ئەو کرێیەی لە شاشەی پارەداندا دەردەکەوێت، ژمارەی کۆمپانیای گەیاندنە لەو ساتەدا، بەپێی ناونیشان و پارێزگا و ڕێگا و ناوەڕۆکی سەبەتەکە وەک لە کاتی پیشاندانیدا هەیە.
- ئەم ژمارەیە دەگۆڕێت ئەگەر ناونیشانەکە بگۆڕێت، یان پارێزگاکە بگۆڕێت، یان ڕێگای گەیاندن بگۆڕێت، یان ناوەڕۆکی سەبەتەکە لە ژمارە یان قەبارە یان کێش یان جۆردا بگۆڕێت.
- ئەو کرێیەی لە کاتی جێگیرکردندا لەسەر داواکارییەکە تۆمار دەکرێت، ئەوەیە کە بۆ ئەو داواکارییە پەسەندکراوە، و کڕیار بە جیاوازییەک ناگیرێت کە دوای جێگیرکردن لە گۆڕانی نرخی گەیەنەرەوە سەرچاوە بگرێت.
- ئەگەر کڕیار دوای جێگیرکردن داوای گۆڕانێکی کرد کە کرێیەکی جیاواز لەسەر گەیەنەر بخوڵقێنێت، لە ڕووی کرێیەوە وەک داواکارییەکی نوێ مامەڵەی لەگەڵ دەکرێت، و وردەکاریی ئەوەی دەگۆڕدرێت لە بڕگەکانی 3.35 و 3.36دایە.
- ئەو کرێیەی پیشان دەدرێت، ئەو کرێی چاوەڕوانی یان هەوڵی زیادە یان دووبارە گەیاندنە ناگرێتەوە کە گەیەنەر بیسەپێنێت، و یاسای ئەمە لە بڕگەی 3.33دایە.

### 3.16 هەموو تێچووەکانی گەیاندن لەسەر کڕیارن
- بنەما ئەوەیە کە هەموو تێچووەکانی گەیاندن لەسەر کڕیارن: کرێی دوا مەودا، و کرێی ئەو ڕێگایەی هەڵیبژاردووە، و ئەو باجەی لە کۆکردنەوەی پارەی نەقدەوە دێت، و تێچووی دووبارە گەیاندن، و تێچووی گەڕاندنەوە لە کاتی ڕەتکردنەوە بەبێ هۆکارێکی دانپێدانراو.
- تێچووی گەڕاندنەوەی بەرهەمێکی عەیبدار لە سیاسەتی گەڕاندنەوە و ئاڵوگۆڕدا چارەسەر دەکرێت، و کرێی ناردن لە گەڕاندنەوەدا لەسەر کڕیارە بەپێی ئەوەی ئەو بەڵگەنامەیە دەیڵێت.
- لە پیشاندانی کرێی سفر لەسەر ڕێگای وەرگرتن لە کۆگا، نابێت تێبگەیەنرێت کە گەیاندن خۆڕاییە، بەڵکو ئەوەی لەو ڕێگایەدا لە بنەڕەتدا دوا مەودا نییە.
- لە بنەمای ئەم بڕگەیە تەنها ئەوە جیا دەکرێتەوە کە لە بڕگەی 3.17دا هاتووە، و ئەو پێشکەشکردن یان ڕەوانەکردنەی فرۆشگا بڕیاری لەسەر دەدات و کاریگەرییەکەی لە شاشەی پارەداندا دەردەکەوێت.

### 3.17 جیاکردنەوەی ئەندامێتی: PRO و LEVO PREMIUM
- فرۆشگا تێچووەکانی گەیاندن لە جیاتی ئەندام دەگرێتە ئەستۆ سەروو بڕێکی دیاریکراوی داواکاری، بەم وردەکارییەی خوارەوە.
- ئەندامی چالاکی LEVO PRO: فرۆشگا کرێی گەیاندنی لە ئەستۆ دەگرێت ئەگەر بەهای کاڵای شایستە لە سنووری ڕاگەیەنراوی ئەندامێتییەکەی تێپەڕی، کە {{PRO_FREE_DELIVERY_MIN_IQD}}ە، و تێپەڕاندن دەبێت بە زیادبوون بێت تەنها، بۆیە گەیشتن بە سنوورەکە بەس نییە. ئەوەی فرۆشگا لە جیاتی دەیگرێتە ئەستۆ، گەیاندنی ئاسایی و پێچانەوەی پارێزراو دەگرێتەوە.
- ئەندامی چالاکی LEVO PREMIUM: فرۆشگا تەنها کرێی گەیاندنی ئاسایی لە ئەستۆ دەگرێت ئەگەر بەهای کاڵای شایستە لە سنووری ڕاگەیەنراوی ئەندامێتییەکەی تێپەڕی، کە {{PREMIUM_FREE_DELIVERY_MIN_IQD}}ە، بە زیادبوون تەنها. ئەم بەخشینە نە پێچانەوەی پارێزراو دەگرێتەوە و نە ئەو کرێیە زیادانەی لە بڕگەی 3.20دان.
- بەهای کاڵای شایستە لەسەر کاڵاکە دوای داشکاندن و کۆپۆن و خاڵەکان و پێش کرێی گەیاندن دەژمێردرێت، و کرێی گەیاندن خۆی تێیدا نییە.
- ئەگەر لە ئەندامێکدا دوو وەسف کۆببوونەوە، یاسای PRO پێشخراوە چونکە فراوانترە.
- بەخشینەکە بە کۆتاییهاتن یان ڕاگرتنی ئەندامێتییەکە دەڕوخێت و بە گەڕانەوەی دەگەڕێتەوە، و هیچ کاریگەرییەکی دواوەی نییە لەسەر داواکارییەکی پێشوو.
- ئەوەی فرۆشگا لە جیاتی ئەندام دەیگرێتە ئەستۆ، لە پسووڵەکەدا بە ڕوونی دەردەکەوێت: کرێی گەیەنەر، پاشان ئەوەی فرۆشگا لێی گرتووەتە ئەستۆ. کرێیەکە بە سفر و بەبێ ڕوونکردنەوە پیشان نادرێت، چونکە ئەو پسووڵەیەی ناخوێنرێتەوە پشتی پێ نابەسترێت.

### 3.18 مەرجی ناونیشانی بنەڕەتیی پەسەندکراو بۆ ئەندامی PRO
- ئیمتیازەکانی ئەندامی PRO کە پەیوەندییان بە گەیاندنەوە هەیە، تەنها لەسەر ناونیشانی بنەڕەتیی پەسەندکراوی بوونیان هەیە.
- ئەگەر ئەندامی PRO لە داواکارییەکدا ناونیشانێکی دیکەی هەڵبژارد، ئەو داواکارییە وەک کڕیارێکی ئاسایی نرخ بۆ دادەنرێت، و ئەمە بێبەشکردن لە ئیمتیازێک نییە بەڵکو دیاریکردنی شوێنیەتی.
- شایستەیی بە گەڕانەوەی ئەندام بۆ ناونیشانە پەسەندکراوەکەی خۆکارانە دەگەڕێتەوە، بەبێ داواکاری و بەبێ پێداچوونەوە.
- شاشەی پارەدان هۆکاری جێبەجێنەکردنی بەخشینەکە ڕوون دەکاتەوە کاتێک ناونیشانێکی دیکە هەڵبژێردرا، تاکو ئەندام بە کرێیەکی چاوەڕواننەکراو سەرسام نەبێت.
- ئەم مەرجە تایبەتە بە ئەندامێتیی PRO، و لەسەر ئەندامێتیی LEVO PREMIUM بە هاوشێوەیی ناسەپێندرێت.

### 3.19 بەرزترین سنووری ئەوەی ئەندامێتی دەیگرێتە ئەستۆ
- لەوانەیە ئەوەی فرۆشگا لە جیاتی ئەندام دەیگرێتە ئەستۆ، بەرزترین سنوورێکی ڕاگەیەنراوی هەبێت لە مەرجەکانی ئەندامێتیدا.
- ئەگەر هیچ سنوورێک دانەنرابێت، فرۆشگا کرێی گەیاندنی داپۆشراو بە تەواوی دەگرێتە ئەستۆ.
- ئەگەر سنوورێک دانرا و کرێیەکە گەیشتییە، فرۆشگا بڕی سنوورەکە دەگرێتە ئەستۆ و ئەندام جیاوازییەکە دەدات، و لەم حاڵەتەدا ناوترێت گەیاندن خۆڕاییە، بەڵکو لە پسووڵەکەدا بڕی ئەوەی فرۆشگا گرتوویەتییە ئەستۆ و بڕی ئەوەی لەسەر ئەندام ماوەتەوە ڕوون دەکرێتەوە.
- فرۆشگا پابەندە بە ڕوونکردنەوەی ئەم جیاوازییە پێش جێگیرکردنی داواکارییەکە نەک دوای.

### 3.20 کرێیە زیادەکان لەسەر کرێی گەیاندن
لەوانەیە کرێی تایبەت بە سروشتی کاڵاکە بخرێتە سەر کرێی گەیاندنی ئاسایی، و هەموویان پێش جێگیرکردن لە شاشەی پارەداندا دەردەکەون:

- کرێی چاپکەرەکان: لەسەر چاپکەرەکە بەپێی پۆلی قەبارەکەی دەژمێردرێت، و لەوانەیە پێش ئامادەکردن پێویست بێت پێشوەخت بدرێت ئەگەر بەڕێوەبەرایەتیی فرۆشگا بڕیاری لەسەر بدات.
- کرێی کارتۆن: دەکەوێتە ئەستۆ ئەگەر ژمارەی بۆبینەکانی دەزوو لە سنووری دیاریکراو تێپەڕی، و هۆکارەکەی ئەوەیە کە ئەو بڕە پێویستی بە کارتۆنێکی زیادەیە کە پێچانەوەی ئاسایی هەڵیناگرێت. ئەم کرێیە وەرناگیرێت مەگەر سنوورەکە و بڕی کرێیەکە پێکەوە دانرابن.
- پێچانەوەی پارێزراو: خزمەتێکی ئارەزوومەندانەیە کە کڕیار داوای دەکات، کە تێیدا پاکەتەکە دەپێچرێتەوە و مامەڵەی لەگەڵ دەکرێت بەو شێوەیەی یارمەتی بدات بەرگەی ڕێگاکە بگرێت. ئەمە زیادکردنێکە لەسەر نرخەکە نەک جێگرەوەی، و هیچ کرێیەکی لێ وەرناگیرێت مەگەر نرخی بۆ دانرابێت، و بەبێ نرخ پیشان نادرێت.
- هیچ کام لەم کرێیانە وەرناگیرێت مەگەر دانرابێت و پیشان درابێت. ئەو کرێیەی دانەنراوە، نە خەمڵێندرێت و نە کۆششی تێدا دەکرێت.
- پێچانەوەی پارێزراو وریاییەکی ماددییە لە پێچانەوەدا، و دڵنیایی نییە لەسەر پاکەتەکە، و بەهۆیەوە فرۆشگا زیانی گواستنەوەی بڕگەی 3.25 ناگرێتە ئەستۆ.

### 3.21 خزمەتی تەواوکردن لە ماوەی دوازدە کاتژمێردا بۆ ئەندامی PRO
- فرۆشگا بۆ ئەندامی PRO خزمەتی تەواوکردن لە ماوەی دوازدە کاتژمێردا دابین دەکات، کە خزمەتێکی مەرجدارە نەک ئیمتیازێکی بێ سنوور.
- مەرجەکانی پێکەوەن: ئەندامێتییەکە چالاک و شایستەی خزمەتەکە بێت، گەیاندن بۆ ناونیشانی بنەڕەتیی پەسەندکراو بێت، خزمەتەکە لەلایەن بەڕێوەبەرایەتیی فرۆشگاوە چالاک کرابێت، ڕێگای گەیاندنی هەڵبژێردراو لەو ڕێگایانە بێت کە دەیگرێتەوە، جۆری ناردن بەشێک بێت لەوەی دەیگرێتەوە، و پارێزگاکە لە ناو بوارەکەیدا بێت ئەگەر بوارێکی بۆ دیاری کرابێت.
- خزمەتەکە ئەمڕۆ گەیاندنی کەسی و فرۆشتنی ڕاستەوخۆ دەگرێتەوە. پێش-داواکاری بە سروشتی خۆی ناگیرێتەوە، چونکە کاڵاکەی هێشتا نەگەیشتووە.
- ئەگەر یەکێک لەم مەرجانە نەبوو، هۆکاری نەبوونەکەی بە دیاریکراوی لە شاشەی پارەداندا ڕوون دەکرێتەوە، و خزمەتەکە ناژمێردرێت، و هیچ کرێیەکی لێ وەرناگیرێت.
- ماوەی دوازدە کاتژمێرەکە لەو ساتەوە دەژمێردرێت کە خزمەتەکە لەسەر داواکارییەکە دەکەوێتە ئەستۆ، و ماوەی تەواوکردنە لای فرۆشگا، و کاریگەریی ئەو بارودۆخانەی لای گەیەنەر لە ڕێگادا ڕوودەدەن نابڕێتەوە.

### 3.22 پارەدان لە بەردەرگا و باجی کۆکردنەوەی نەقد
- پارەدان لە کاتی وەرگرتن لە ڕێڕەوی فرۆشگای فەرمیدا بەردەستە لەو شوێنانەی لە شاشەی پارەداندا دەردەکەوێت، و لە ڕێڕەوی فرۆشگاکانی کۆمەڵگەدا بەردەست نییە بەپێی بڕگەی 3.5.
- لەسەر ئەو بڕەی بە نەقد لە بەردەرگا کۆدەکرێتەوە، باجی کۆکردنەوە دەکەوێتە ئەستۆ، بە بڕێکی دیاریکراو بۆ هەر بڕێکی تەواو لەو بڕەی پێش باج دەکەوێتە ئەستۆ، و هەردوو بڕەکە لە شاشەی پارەدانی ئەو داواکارییەدا پیشان دەدرێن. ئەو پارچەیەی نەگاتە بڕێکی تەواو، هیچی لێ وەرناگیرێت. هەردوو بڕەکە دەکرێت لەلایەن بەڕێوەبەرایەتیی فرۆشگاوە بگۆڕدرێن، و ئەوەی لە هەر داواکارییەکدا پەسەندکراوە، ئەوەیە کە لە شاشەی پارەدانی ئەو داواکارییەدا لە کاتی جێگیرکردنیدا دەرکەوتووە.
- ئەم باجە لەسەر وەرگرتن لە کۆگا وەرناگیرێت، چونکە نە کۆکردنەوە لە بەردەرگایەک هەیە و نە گواستنەوەی پارە.
- باجەکە لە پسووڵەکەدا وەک بڕگەیەکی سەربەخۆ بە بڕەکەیەوە دەردەکەوێت، و لەگەڵ نرخەکەدا تێکەڵ ناکرێت.
- ئەگەر کڕیار بەپێی ئەندامێتییەکەی لێی بەخشراو بێت، بە تەواوی دەژمێردرێت و پاشان بەخشینەکە بەرامبەری لە پسووڵەکەدا ڕوون دەکرێتەوە، تاکو هەردوو ژمارەکە شیاوی پێداچوونەوە بمێننەوە، و سفرێک دەرنەکەوێت کە نەزانرێت چۆن بووە بە سفر.
- داوا لە گەیەنەری گەیاندن ناکرێت بڕێک کۆبکاتەوە کە جیاواز بێت لەوەی لەسەر پسووڵەکەیە، و لە کڕیارەوە پشت بە ڕێککەوتنێکی زارەکی لەگەڵ گەیەنەر لەسەر بڕێکی دیکە نابەسترێت.
- ئەو بڕەی لە بەردەرگا کۆدەکرێتەوە، بە پسووڵە دەدرێتە گەیەنەر، و پسووڵەکە بەڵگەیە لەسەر پارەدان.

### 3.23 کرێی گومرگ و کرێیەکانی هاوردەکردن
- ئەو نرخەی لەسەر بەرهەمی پێش-داواکاری پیشان دەدرێت، ئەو تێچووی گواستنەوە و کۆمیسیۆنە دەگرێتەوە کە فرۆشگا ئاشکرای کردووە، و ئەو کرێیە ناگرێتەوە کە لایەنێکی فەرمی لەسەر کڕیار بە کەسی خۆی دەیسەپێنێت.
- ئەگەر لایەنێکی فەرمی کرێی گومرگ یان کرێی هاوردە یان کرێی خستنە ژوورەوەی سەپاند کە لەسەر کڕیار بە کەسی خۆی بێت، لەسەر کڕیارە، و دەدرێت بەو لایەنەی سەپاندوویەتی نەک بە فرۆشگا.
- فرۆشگا بڕی ئەم کرێیە خەمڵێنی ناکات و دڵنیایی نادات کە نەسەپێندرێت، چونکە خەمڵاندن و سەپاندنی بۆ ئەو نییە.
- ئەوەی فرۆشگا لە ڕەوانەکردن و خستنە ژوورەوەی بارەکەی خۆی دەیگرێتە ئەستۆ، لە ناو تێچووی خۆیدایە، و جارێکی دیکە لە کڕیار داوا ناکرێت.
- کاتێک داواکارییەکی فەرمی لەم جۆرە دەخوڵقێت، فرۆشگا ئەو بەڵگەنامانەی باری کە لای هەیە بۆ کڕیار ڕوون دەکاتەوە بەوەی یارمەتی بدات بۆ سەردانی لایەنی پەیوەندیدار، و ئەمە لە ڕێگەی یارمەتیدانەوەیە نەک پابەندبوون. بۆ پرسیار: {{LEVONIS_SUPPORT_CONTACT}}.

### 3.24 پابەندیی فرۆشگا بە پێچانەوە و سنووری ئەم پابەندییە
- فرۆشگا پابەندە کە کاڵاکە بە شێوەیەکی دروست بپێچێتەوە کە گونجاو بێت لەگەڵ سروشت و کێش و شکاوییەکەی، و بەو دۆخە ڕادەستی کۆمپانیای گەیاندنی بکات.
- فرۆشگا پابەندە کە ئەوەی لە پاکەتەکەدایە لەگەڵ ئەوەی لە داواکارییەکەدایە بگونجێت لە ژمارە و جۆر و مۆدێلدا.
- فرۆشگا پابەندە کە زانیارییە دروستەکانی گەیاندن وەک کڕیار پێشکەشی کردوون ڕادەستی گەیەنەر بکات.
- پابەندیی ماددیی فرۆشگا لە کاتی ڕادەستکردنی پاکەتەکە بە کۆمپانیای گەیاندن بە دۆخێکی ساغ کۆتایی دێت. ئەوەی دوای ئەوە دێت، دەستی گەیەنەر و بەرپرسیارێتیی گەیەنەرە.
- بارگرانیی سەلماندنی ساغیی پێچانەوەکە لە کاتی ڕادەستکردن بە گەیەنەر لەسەر فرۆشگایە، و بەو تۆمارانەی ئامادەکردن و پسووڵەی ڕادەستکردن بە گەیەنەر جێبەجێ دەکرێت کە لای هەن.

### 3.25 فرۆشگا بەرپرسیار نییە لەو زیانەی لە کاتی گواستنەوەدا ڕوودەدات
- فرۆشگا ئەو زیانە ناگرێتە ئەستۆ کە لە کاتی گواستنەوەدا بەسەر پاکەتەکەدا دێت دوای ئەوەی بە دۆخێکی ساغ ڕادەستی کۆمپانیای گەیاندن کراوە.
- ئەمە شکان و چەقاندن و خوڕان و تەڕبوون و دزین و ونبوون و خراپ مامەڵەکردن و کەمیی ناوەڕۆک دەگرێتەوە کە لە دەستی گەیەنەردا ڕوودەدەن.
- هۆکاری ئەم یاسایە ئەوەیە کە پاکەتەکە لە دەستی فرۆشگا دەچێتە دەستی کەسێکی یاسایی سەربەخۆ، کە فرۆشگا نە چاودێریی کرێکارەکانی دەکات و نە ئۆتۆمبێلەکانی و نە ڕێڕەوەکانی و نە ئەوەی لە کۆگاکانیدا ڕوودەدات.
- نەگرتنە ئەستۆی ئەم زیانە لەلایەن فرۆشگاوە، مانای نکۆڵیکردنی نییە، و ڕێگر نییە لەبەردەم کڕیار بۆ داواکاری لە گەیەنەر، و ڕێگر نییە لەبەردەم فرۆشگا بۆ یارمەتیدانی لەسەر ئەوە بەپێی بڕگەی 3.29.
- ئەوەی بسەلمێنرێت عەیبێکی بەرهەمهێنانی شاراوەیە و پەیوەندیی بە گواستنەوەوە نییە، لەسەر سیاسەتی گەرەنتی دەمێنێتەوە، و داواکاریی گەرەنتی بەم بڕگەیە ڕەت ناکرێتەوە.
- ئەوەی بسەلمێنرێت هۆکارەکەی پێچانەوەی خراپی فرۆشگایە، لەسەر فرۆشگا دەمێنێتەوە، و لە پشت ئەم بڕگەیەدا خۆی نەشاردووەتەوە.

### 3.26 سنووری هەرێمی کوردستان و خاڵەکانی پشکنین و کردنەوەی پاکەتەکان
- فرۆشگا ئەو زیانە ناگرێتە ئەستۆ کە لە سنووری هەرێمی کوردستان بەسەر پاکەتەکەدا دێت، و نە لە هیچ خاڵێکی پشکنین یان چاودێری یان دەروازەیەک کە تێیدا پاکەتەکە دەکرێتەوە و دەپشکنرێت و دووبارە دەپێچرێتەوە لەلایەن لایەنێکەوە کە نە فرۆشگایە و نە کۆمپانیای گەیاندن.
- ئەمە ئەوە دەگرێتەوە کە لە کردنەوەکەوە دەخوڵقێت: بڕینی تەیپەکان، و تێکچوونی پێچانەوەی سەرەکی، و دووبارە پێچانەوە بە جۆرێکی دیکە، و لێککردنەوەی بەشەکان، و کەمی لەوەی لە ناو پاکەتەکەدا بوو.
- ئەو لایەنەی لەم حاڵەتەدا پاکەتەکە دەکاتەوە، دەسەڵاتێکی فەرمی بەکاردەهێنێت کە فرۆشگا نە توانای ڕەتکردنەوەی هەیە و نە ناڕەزایی دەربڕین لەسەری و نە ئامادەبوون لەلای.
- بۆ جێبەجێبوونی ئەم یاسایە مەرج نییە کردنەوەکە بە ناڕەوا بێت، بەڵکو بەسە کردنەوە و دووبارە پێچانەوەکە لەلایەن ئەو لایەنەوە ڕووبدات.
- ئەم یاسایە بە یەکسانی دەکەوێتە سەر ئەو پاکەتەی بەرەو هەرێم دەچێت و ئەوەی لێوە دەردەچێت و ئەوەی پێیدا تێدەپەڕێت.
- ئەگەر پاکەتەکە بە شوێنەوارێکی بەدیاری ئەم جۆرە گەیشت، ڕێکاری دروست ئەوەیە کە لە بڕگەکانی 3.27 و 3.30دا هاتووە، و فرۆشگا یارمەتی دەدات بۆ سەردانی گەیەنەر بەپێی بڕگەی 3.29.

### 3.27 ئەوەی کڕیار لە بەردەرگا تۆماری دەکات
بۆ پاراستنی مافی کڕیار بەرامبەر گەیەنەر، و تاکو ڕووداوەکە شیاوی سەلماندن بمێنێتەوە، لەسەر کڕیارە پێش واژووکردن بۆ وەرگرتن ئەمانە بکات:

- پشکنینی کارتۆنی دەرەوە لەبەردەم گەیەنەر: ئایا کراوەتەوە، ئایا تەیپەکەی بڕدراوە یان دووبارە لکێندراوەتەوە، و ئایا چەقاندن یان دڕان یان شوێنەواری تەڕبوونی تێدایە.
- وێنەگرتنی پاکەتەکە لە دەرەوە پێش کردنەوەی، بە شێوەیەک کە لەیبڵەکە و دۆخی پێچانەوەکە لە وێنەکەدا دەربکەون.
- کردنەوەی پاکەتەکە لەبەردەم گەیەنەر لەو حاڵەتانەی ڕێگای گەیاندن ڕێگە دەدات، و تۆمارکردنی کردنەوەکە بە یەک ڤیدیۆی بەردەوامی نەپچڕاو.
- دڵنیابوون لە ژمارە و ناوەڕۆک و مۆدێل و ژمارەی زنجیرەیی و ساغیی پێچانەوەی ناوەوە.
- تۆمارکردنی تێبینی بە نووسین لەسەر پسووڵەی گەیاندن کاتێک شوێنەوارێکی بەدیار هەیە، یان ڕەتکردنەوەی وەرگرتن بەپێی بڕگەی 3.31.
- ئاگادارکردنەوەی فرۆشگا لە ماوەی {{DAMAGE_REPORT_WINDOW_HOURS}} کاتژمێردا لە گەیاندنەوە بە ژمارەی داواکاری و وێنە و ڤیدیۆکانەوە.
- داوا لە گەیەنەر ناکرێت چاوەڕێی پشکنینێک بکات کە لە {{DOOR_INSPECTION_MINUTES}} خولەک تێدەپەڕێت، و نە ئامێرەکە لە بەردەرگا بخاتە کار و تاقی بکاتەوە.

### 3.28 کاریگەریی تۆمارنەکردنی کڕیار
- واژووکردن بۆ وەرگرتن بەبێ تێبینی لەگەڵ بوونی شوێنەوارێکی بەدیار لەسەر کارتۆنەکە، داواکاریی زیانی گواستنەوە لاواز دەکات تا ئاستی ڕوخانی، چونکە واژووەکە دانپێدانانە بە وەرگرتن لەسەر دۆخی بەدیار.
- ئەو پاکەتەی دوای ڕۆیشتنی گەیەنەر کراوەتەوە بەبێ تۆمارکردنی بەردەوام، داواکاری لەسەر کەمیی ناوەڕۆکی وەرناگیرێت، چونکە ڕووداوەکە چیتر شیاوی سەلماندن نییە نە بۆ کڕیار و نە بۆ فرۆشگا و نە بۆ گەیەنەر.
- ئاگادارکردنەوە دوای ماوەی دیاریکراو داواکارییەکە لاواز دەکات، و لەوانەیە وەرنەگیرێت ئەگەر بابەتەکەی شتێکی بەدیار بێت کە دەکرا لە بەردەرگا ببینرێت.
- ئەوەی ڕابردوو ڕێگر نییە لەبەردەم داواکاریی گەرەنتی بۆ عەیبێکی بەرهەمهێنانی شاراوە، چونکە ئەوە لەسەر سیاسەتی گەرەنتییە نەک ئەم بەڵگەنامەیە.

### 3.29 یارمەتیدانی فرۆشگا لە داواکاری لە گەیەنەر
فرۆشگا زیانی گواستنەوە ناگرێتە ئەستۆ، لەگەڵ ئەوەشدا ئەمانەی خوارەوە دەکات بۆ یارمەتیدانی کڕیار، و پابەندییەکی هەوڵدانە نەک پابەندی بە بەدەستهێنانی ئەنجام:

- دابینکردنی کڕیار و داواکارییەکەی لە گەیەنەر بەو ژمارەی بار و ژمارەی بەدواداچوون و بەرواری ڕادەستکردن بە گەیەنەر و لیستی ناوەڕۆکی پاکەتەکە کە لای فرۆشگا هەن.
- پێشکەشکردنی ئەوەی دۆخی پاکەتەکە دەسەلمێنێت لە کاتی ڕادەستکردنی بە گەیەنەر.
- بەرزکردنەوەی داواکارییەکە بۆ گەیەنەر بە ناوی فرۆشگاوە وەک ئەو لایەنەی گرێبەستی لەگەڵ کردووە، لەو حاڵەتانەی گەیەنەر ئەمە وەردەگرێت.
- بەدواداچوونی وەڵامی گەیەنەر و ئاگادارکردنەوەی کڕیار پێی وەک هاتووە، بەبێ بەڵێن لەسەر ئەنجام و نە لەسەر ماوە.
- ئەگەر گەیەنەر دانی بە بەرپرسیارێتیدا نا و قەرەبووی پاکەتەکەی دا، قەرەبووەکە بۆ کڕیار دەگەڕێتەوە لە سنووری ئەوەی بەڕاستی دراوە.
- ئەگەر گەیەنەر نکۆڵیی کرد، مافی کڕیار دەمێنێتەوە بۆ سەردانی ڕاستەوخۆی، و فرۆشگا لەسەر ئەو هەڵوێستە دەمێنێتەوە کە لە بڕگەی 3.25دا ڕوونکراوەتەوە.
- داواکاری لە گەیەنەر بە ماوەیەک سنووردارە کە گەیەنەر خۆی دیاری دەکات، و فرۆشگا بەرپرسیار نییە لە تێپەڕبوونی ماوەیەک کە هۆکارەکەی دواکەوتنی کڕیارە لە ئاگادارکردنەوەدا.

### 3.30 ئەو پاکەتەی بە کراوەیی دەگات
- ئەو پاکەتەی بە کراوەیی دەگات یان بە پێچانەوەیەکی جیاواز لە پێچانەوەی سەرەکی دووبارە پێچراوەتەوە: کڕیار دەتوانێت وەرگرتنی ڕەت بکاتەوە، و ڕەتکردنەوە لەم حاڵەتەدا ڕێکاری دروستە.
- ئەگەر کڕیار وەرگرتنی هەڵبژارد، تێبینییەکەی لەسەر پسووڵەکە تۆمار دەکات، و پاکەتەکە پێش کردنەوە و لە کاتی کردنەوەدا وێنە دەگرێت، و لە ماوەکەدا فرۆشگا ئاگادار دەکاتەوە.
- ئەو پاکەتەی بەم هۆیەوە ڕەت دەکرێتەوە، بۆ فرۆشگا دەگەڕێتەوە، و لە کاتی گەیشتنیدا دەپشکنرێت، و بڕیار لەسەر داواکارییەکە لەسەر بنەمای ئەوەی پشکنینەکە دەریدەخات دەدرێت.
- تێچووی گەڕاندنەوە لەم حاڵەتەدا لەسەر کڕیار ناخرێت ئەگەر شوێنەوارە بەدیارەکە بە وێنە تۆمار کرابێت.
- ئەگەر لە پشکنینەکەدا دەرکەوت کە هۆکاری کردنەوەکە کردەی لایەنێکی فەرمی بووە، بڕگەی 3.26 جێبەجێ دەبێت، و فرۆشگا زیانەکە ناگرێتە ئەستۆ، و کڕیار بەپێی بڕگەی 3.29 یارمەتی دەدات.

### 3.31 ڕەتکردنەوە لە بەردەرگا
- کڕیار دەتوانێت وەرگرتن لە بەردەرگا ڕەت بکاتەوە.
- ئەو ڕەتکردنەوەیەی لەسەر هۆکارێکی دانپێدانراوی ئەم بەڵگەنامەیە بنیات نراوە، وەک گەیشتنی پاکەتەکە بە کراوەیی یان دەرکەوتنی زیانێکی تۆمارکراو یان ناگونجانێکی بەدیار، تێچووی گەڕاندنەوەی لەسەر کڕیار ناخرێت.
- ئەو ڕەتکردنەوەیەی لەسەر هیچ کام لەم هۆکارانە بنیات نەنراوە، تێچووی ڕۆیشتن و گەڕانەوەی لەسەر کڕیارە، و لەو بڕەی دەگەڕێتەوە دەبڕدرێت ئەگەر هەبێت.
- پاکەتی ڕەتکراوە بۆ فرۆشگا دەگەڕێتەوە و داواکارییەکە وەک هەڵوەشاوە مامەڵەی لەگەڵ دەکرێت بەپێی سیاسەتی کڕین و سیاسەتی پارەدان و جزدان.
- دووبارەبوونەوەی ڕەتکردنەوە بەبێ هۆکار لە هەمان هەژمارەوە، هەژمارەکە دەخاتە بەردەم سنووردارکردنی پارەدان لە کاتی وەرگرتن، بۆیە داوای پارەدانی پێشوەختی لێ دەکرێت.

### 3.32 نەگەیشتن بە کڕیار یان ئامادەنەبوونی
- لەسەر کڕیارە لەو ڕۆژانەی گەیاندنی چاوەڕوانکراودا لەسەر ئەو ژمارەیەی لە هەژمارەکەیدا تۆمارکراوە بەردەست بێت، و ناونیشانەکەی شیاوی گەیشتن بێت.
- ئەگەر کڕیار وەڵامی پەیوەندیی گەیەنەری نەدایەوە، یان لە ناونیشانەکە ئامادە نەبوو، هەوڵەکە وەک هەوڵێکی گەیاندنی سەرنەکەوتوو دەژمێردرێت و تۆمار دەکرێت.
- گەیەنەر بەپێی سیستەمی خۆی هەوڵەکە دووبارە دەکاتەوە. ئەگەر دوای {{FAILED_DELIVERY_ATTEMPTS}} هەوڵ نەکرا بگات، پاکەتەکە بۆ فرۆشگا دەگەڕێتەوە و داواکارییەکە وەک ڕەتکردنەوە لە بەردەرگا بەبێ هۆکار مامەڵەی لەگەڵ دەکرێت.
- ئەگەر لە بنەڕەتدا نەکرا بگەن بە کڕیار بۆ پەسەندکردنی داواکارییەکەی لە ماوەی {{ORDER_CONFIRMATION_WINDOW_HOURS}} کاتژمێردا، فرۆشگا دەتوانێت داواکارییەکە هەڵبوەشێنێتەوە بەپێی سیاسەتی فرۆشتن.
- ژمارەی تۆمارکراوی هەڵە یان کوژێنراوە یان بەکارنەهاتوو هۆکارێکە کە بۆ کڕیار دەگەڕێتەوە، و ئەو تێچووەی لێی دەکەوێتەوە لەسەر ئەوە.

### 3.33 دووبارە گەیاندن و کێ تێچووەکەی دەگرێتە ئەستۆ
- دووبارە گەیاندن دوای هەوڵێکی سەرنەکەوتوو کە هۆکارەکەی کڕیارە، کرێی دووبارە گەیاندنی بە بڕی {{REDELIVERY_FEE_IQD}} لێ وەردەگیرێت، کە کۆمپانیای گەیاندن دیاری دەکات و بڕەکەی وەک خۆی بۆ کڕیار دەگوازرێتەوە.
- ئەو دووبارە گەیاندنەی هۆکارەکەی فرۆشگا یان گەیەنەرە، وەک هەڵەیەک لە ئامادەکردن یان لە ئاڕاستەکردنی بارەکە، کڕیار ناینێتە ئەستۆ.
- کرێی چاوەڕوانی یان هەوڵی زیادە کە گەیەنەر دەیسەپێنێت، ملکەچی بڕگەی 3.14ە، چونکە سەرچاوەکەی گەیەنەرە و فرۆشگا گوازەرەوەیەتی.
- ئەگەر کڕیار دوای هەوڵە سەرنەکەوتووەکە ویستی داواکارییەکەی لە کۆگای فرۆشگا وەربگرێت لە جیاتی دووبارە گەیاندن، ئەمە ڕێگەپێدراوە لەو حاڵەتانەی ڕێگای وەرگرتن بۆ ئەو داواکارییە بەردەستە، و هیچ کرێی دووبارە گەیاندنی لێ وەرناگیرێت.
- ئەو داواکارییەی بە کۆتایی ناکرێت بگەیەنرێت بۆ فرۆشگا دەگەڕێتەوە، و یاساکانی هەڵوەشاندنەوە و گەڕاندنەوەی پارە لە سیاسەتی پارەدان و جزداندا لەسەری جێبەجێ دەبن دوای بڕینی ئەو تێچووانەی کەوتوونەتە ئەستۆ.

### 3.34 هەڵبژاردنی ڕۆژی گەیاندن و گۆڕینی و بەرزترین سنووری
- کڕیار دەتوانێت ڕۆژێکی پەسەندی بۆ گەیاندن دیاری بکات لە کاتی جێگیرکردنی داواکارییەکەدا یان پێش ڕادەستکردنی پاکەتەکە بە کۆمپانیای گەیاندن، و ئەمە بە پشتیوانی ڕادەگەیەنرێت لەسەر {{LEVONIS_SUPPORT_CONTACT}}.
- پەسەندکردنی ڕۆژ داواکارییەکە کە فرۆشگا هەوڵی خۆی تێدا دەدات، و حجزکردنی کاتێک نییە، و لە نەگەیشتنی هیچ کاریگەرییەک ناخوڵقێت.
- گۆڕینی ڕۆژە پەسەندکراوەکە وەردەگیرێت پێش ڕادەستکردنی پاکەتەکە بە گەیەنەر بە ماوەیەک کە لە {{DELIVERY_DAY_CHANGE_NOTICE_HOURS}} کاتژمێر کەمتر نەبێت.
- بەرزترین سنووری گۆڕین {{DELIVERY_DAY_CHANGE_LIMIT}} جارە لەسەر یەک داواکاری. ئەوەی لەمە زیاتر بێت، وەک دواخستنێکی نائاسایی دەژمێردرێت، و فرۆشگا ئەو کاتە دەتوانێت داواکارییەکە لەسەر دۆخی خۆی بهێڵێتەوە یان هەڵیبوەشێنێتەوە بەپێی سیاسەتی فرۆشتن.
- دواخستنی گەیاندن بە داوای کڕیار، نە ماوەی گەڕاندنەوە درێژ دەکاتەوە و نە ماوەی گەرەنتی، چونکە هەردووکیان لە گەیاندنی کردارییەوە دەست پێدەکەن.
- ئەو دواخستنەی کاڵاکە ماوەیەکی نائاسایی لای فرۆشگا حجزکراو دەهێڵێتەوە، ڕێگە بە فرۆشگا دەدات کرێی هەڵگرتن بە بڕی {{STORAGE_FEE_PER_DAY_IQD}} بۆ هەر ڕۆژێک وەربگرێت دوای تێپەڕبوونی {{PICKUP_HOLD_DAYS}} ڕۆژ لە ئاگاداریی ئامادەبوونەوە.

### 3.35 ئەو پاکەتەی ڕادەستی گەیەنەر کراوە، لە ڕێگەی فرۆشگاوە نە ئاڕاستەی دەگۆڕدرێت و نە کاتەکانی
- دوای ڕادەستکردنی پاکەتەکە بە کۆمپانیای گەیاندن، فرۆشگا توانای گۆڕینی ناونیشانەکەی نییە، و نە گواستنەوەی بۆ شارێکی دیکە یان کەسێکی دیکە، و نە پێشخستن یان دواخستنی کاتەکەی، و نە ڕاگرتنی لە ڕێگادا.
- هۆکارەکەی ئەوەیە کە بارەکە دەچێتە ناو دەست و سیستەمی گەیەنەرەوە، و فرۆشگا لەو سیستەمەدا هیچی نییە جگە لە دروستکردنی بارەکە و پرسیارکردن لە دۆخی. هیچ ڕێکارێکی بۆ گۆڕینی ئاڕاستە و هیچی بۆ دووبارە کاتبەندی نییە.
- هەر بەڵێنێکی پێچەوانە لە هەر کەسێکەوە بێت، فرۆشگا پابەند ناکات، و پشتی پێ نابەسترێت.
- ئەوەی کڕیار لەم حاڵەتەدا هەیەتی دوو شتە: سەردانی ڕاستەوخۆی کۆمپانیای گەیاندن لەسەر ژمارەی بارەکە بەپێی سیستەمەکەی، یان ڕەتکردنەوەی وەرگرتن لە بەردەرگا و پاشان دووبارە داواکردنەوە لەسەر زانیارییە دروستەکان.
- فرۆشگا یارمەتیی کڕیار دەدات بۆ گەیشتن بە گەیەنەر و ژمارەی بارەکەی پێدەدات، و ئەمە هیچ پابەندییەک نییە بەوەی ئەوەی داوای دەکات بەدی بێت.
- هەر ڕاستکردنەوەیەک کە گەیەنەر وەریبگرێت، لە نێوان کڕیار و گەیەنەردا دەمێنێتەوە، و ئەو کرێیەی لێی دەکەوێتەوە لەسەر کڕیارە.

### 3.36 گۆڕینی ناونیشان پێش ڕادەستکردن بە گەیەنەر
- گۆڕینی ناونیشانی گەیاندن پێش ڕادەستکردنی پاکەتەکە بە کۆمپانیای گەیاندن وەردەگیرێت، و لە پشتیوانییەوە داوا دەکرێت لەسەر {{LEVONIS_SUPPORT_CONTACT}} لە ماوەی {{ADDRESS_CHANGE_DEADLINE_HOURS}} کاتژمێردا لە جێگیرکردنی داواکارییەکەوە یان پێش ڕادەستکردن بە گەیەنەر، کامیان زووترە.
- ئەگەر ناونیشانە نوێیەکە کرێیەکی جیاوازی لای گەیەنەر خوڵقاند، جیاوازییەکە پێش ئامادەکردن لە کڕیار وەردەگیرێت یان بۆی دەگەڕێتەوە بەپێی حاڵەتەکە.
- ئەگەر گۆڕانەکە گەیاندنەکەی بۆ پارێزگایەکی دیکە گواستەوە، لەوانەیە ڕێگا بەردەستەکە و ماوە خەمڵێنراوەکە و کرێیەکە پێکەوە بگۆڕێن.
- گۆڕینی ناونیشان لەلایەن ئەندامی PROوە بۆ ناونیشانێک جگە لە ناونیشانە بنەڕەتییە پەسەندکراوەکەی، بەخشینەکە لەسەر ئەو داواکارییە دەڕوخێنێت بەپێی بڕگەی 3.18.
- دوای ڕادەستکردنی پاکەتەکە بە گەیەنەر، بڕگەی 3.35 جێبەجێ دەبێت و هیچ گۆڕانێک وەرناگیرێت.

### 3.37 وەرگرتنی کەسێکی دیکە لە جیاتی کڕیار
- پاکەتەکە دەتوانێت لەلایەن کەسێکی پێگەیشتووەوە وەربگیرێت کە لە ناونیشانە تۆمارکراوەکەدا ئامادەیە، و وەرگرتنەکەی وەرگرتنێکی دروستە و کاریگەریی خۆی دەخوڵقێنێت.
- واژووی ئەو کەسە لە کاتی وەرگرتندا لەسەر کڕیار جێبەجێ دەبێت سەبارەت بە دانپێدانان بە دۆخی بەدیاری پاکەتەکە.
- لەسەر کڕیارە ئەو کەسەی نوێنەرایەتیی دەکات ئاگادار بکاتەوە لەوەی بڕگەی 3.27 دەیڵێت، چونکە پشکنینی پێچانەوە و تۆمارکردنی تێبینی مافێکە بە پشتگوێخستن دەڕوخێت.
- پارەدان لە کاتی وەرگرتن لەلایەن ئەو کەسەوە، کڕیار بەری دەکات لە سنووری ئەوەی بە پسووڵە دراوە.
- گەیەنەر ناتوانێت پاکەتەکە لە نەبوونی کەسێکدا بۆ وەرگرتنی جێبهێڵێت مەگەر کڕیار بە نووسین ڕێگەی پێدابێت، و ئەم ڕێگەپێدانە مەترسیی ونبوون دەگوازێتەوە بۆ سەر کڕیار.

### 3.38 وەرگرتن لە کۆگا
- وەرگرتن لە کۆگا لە ڕێڕەوی فرۆشگای فەرمیدا بەردەستە لەو شوێنانەی وەک هەڵبژاردەیەک لە شاشەی پارەدانی ئەو داواکارییەدا دەردەکەوێت، و لە ڕێڕەوی فرۆشگاکانی کۆمەڵگەدا بەردەست نییە بەپێی بڕگەی 3.5.
- شوێنی وەرگرتن {{LEVONIS_WAREHOUSE_ADDRESS}}ە و کاتەکانی {{LEVONIS_PICKUP_HOURS}}ن.
- هیچ کرێیەکی گەیاندن لەسەر ئەم ڕێگایە وەرناگیرێت، و هیچ باجێکی کۆکردنەوەی نەقد ناکەوێتە ئەستۆ بەپێی بڕگەی 3.22، چونکە نە دوا مەودا هەیە و نە کۆکردنەوە لە بەردەرگا.
- لەسەر وەرگرەکە پێویستە ئەوەی ناسنامەی دەسەلمێنێت و ژمارەی داواکارییەکە پیشان بدات.
- کڕیار دەتوانێت لە کاتی وەرگرتن لە کۆگادا ناوەڕۆکەکە بپشکنێت، کە فراوانترە لەوەی لە بەردەرگا بەردەستە، و هەر تێبینییەک دەربکەوێت لە هەمان کاتدا تۆمار دەکرێت.
- داواکاریی ئامادە بۆ وەرگرتن بۆ ماوەی {{PICKUP_HOLD_DAYS}} ڕۆژ لە ئاگاداریی ئامادەبوونەوە هەڵدەگیرێت، دوای ئەوە فرۆشگا دەتوانێت هەڵیبوەشێنێتەوە و ئەوەی لەسەری دراوە بگەڕێنێتەوە بەپێی سیاسەتی پارەدان و جزدان، یان کرێی هەڵگرتنی {{STORAGE_FEE_PER_DAY_IQD}} بۆ هەر ڕۆژێک وەربگرێت.
- ئەو پاکەتەی لە کۆگاوە وەردەگیرێت، بە دەرچوونی لە کۆگاکە دەچێتە ناو دەستی کڕیارەوە، و یاسای زیانی گواستنەوە لەسەری جێبەجێ نابێت، چونکە هیچ گەیەنەرێکی تێدا نییە.

### 3.39 بارودۆخەکانی دەرەوەی ویست
- فرۆشگا بەرپرسیار نییە لە دواکەوتن یان نەگەیاندنێک کە هۆکارەکەی شتێکە لە دەرەوەی ویستی، وەک داخستنی ڕێگاکان و دەروازەکان، و ڕاگرتنی کاتی کاری فەرمی، و بارودۆخی کەشوهەوا، و ناجێگیری، و پچڕانی خزمەتەکانی گەیەنەر، و بڕیارەکانی لایەنە فەرمییەکان.
- لەم حاڵەتەدا مافی کڕیار دەمێنێتەوە بۆ ئەو بڕەی داویەتی ئەگەر داواکارییەکە جێبەجێ نەکرا، بەپێی سیاسەتی پارەدان و جزدان.
- ئەم بڕگەیە بەخشینێکی گشتی نییە، و فراوان ناکرێت بۆ ئەوەی کەموکوڕیی فرۆشگا لە ئامادەکردن یان لە ڕوونکردنەوەدا بگرێتەوە.

### 3.40 پێشینەیی لە کاتی ناکۆکی و یاسای جێبەجێکراو
- ئەوەی لەم بەڵگەنامەیەدا لە یاساکانی گەیاندن و کرێیەکان هاتووە، پێش ئەوە دەخرێت کە بە لاوەکی لە بەڵگەنامەکانی دیکەدا هاتووە.
- ئەوەی لە سیاسەتی گەرەنتی و سیاسەتی گەڕاندنەوە و ئاڵوگۆڕدا لە یاساکانی عەیب و گەڕاندنەوە هاتووە، پێش ئەوە دەخرێت کە بە لاوەکی لێرەدا هاتووە.
- جێگیرکردنی داواکارییەکە پەسەندکردنی ئەوەیە کە لەم بەڵگەنامەیەدایە بەو وەشانەی لە کاتی جێگیرکردندا کاری پێدەکرێت، و ئەو وەشانە پارێزراوەی بەرواری لەسەرە بەڵگەیە.
- ئەم بەڵگەنامەیە ملکەچی یاسای {{GOVERNING_LAW_JURISDICTION}}ە، و {{COMPETENT_COURT}} دەسەڵاتداری ئەو ناکۆکییەیە کە لێی دەخوڵقێت.
- بۆ پرسیار و داواکاری: {{LEVONIS_SUPPORT_CONTACT}}.
`,
  },
};
