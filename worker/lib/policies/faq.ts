import type { PolicyDocument } from './types';

/**
 * الأسئلة الشائعة — THE ONLY DOCUMENT IN THIS CORPUS THAT IS NOT OPERATIVE,
 * AND IT SAYS SO IN ITS FIRST LINE.
 *
 * WHY THAT MATTERS ENOUGH TO BE ARTICLE 1.2. An FAQ is the text customers
 * actually read; the seventeen documents beside it are the text they are shown
 * in an argument. If this one restated a rule in friendlier words, the corpus
 * would hold two versions of that rule, and the shop would lose the argument
 * on whichever version is looser — which will always be this one. So every
 * answer below ends by naming the document that decides, and article 1.3 makes
 * the specialist document prevail outright. This file may be re-worded freely;
 * it can never be the reason a customer wins or loses a claim.
 *
 * WHAT IT IS FOR. There are eighteen documents. A customer with one question —
 * when do my points arrive, who pays return shipping, does PRO change a
 * warranty decision — should not have to guess which of the eighteen holds the
 * answer. This is the index, written as questions, and its real job is to
 * ROUTE. The routing is the value; the paraphrase is only the bait.
 *
 * THE QUESTIONS ARE THE ONES SUPPORT ACTUALLY RECEIVES, not the ones a
 * marketing page would ask, which is why several of them are uncomfortable:
 * why a points balance is lower than expected (6.2 — the multiplier rounds,
 * and delivery never earned), why nobody can read a merchant conversation for
 * you (8.3 — there is no back door, and that cuts both ways), why identity
 * data is "encrypted" and the shop can still read it (9.2), and why there is
 * no delete-my-account button (9.3). An FAQ that dodges those is decoration.
 *
 * NO NUMBER IS INVENTED HERE. Where an answer needs a figure, it is either a
 * constant this codebase really holds — the seven-day pending window, 1 point
 * = 1 IQD, the check-in ladder, ×1.5 and ×2 — or it is the same placeholder
 * token the operative document uses. A friendly page is exactly where a wrong
 * number does the most damage, because it is the page people quote.
 */
export const faq: PolicyDocument = {
  key: 'faq',
  version: 1,
  effective_at: '2026-01-01',
  title: {
    ar: 'الأسئلة الشائعة',
    en: 'Frequently Asked Questions',
    ckb: 'پرسیارە باوەکان',
  },
  body: {
    ar: `## 1. قبل أن تقرأ

### 1.1 ما هذه الصفحة
هذه الصفحة دليل إلى وثائق المتجر، مكتوبة على شكل أسئلة. كل جواب فيها مختصر، ويذكر الوثيقة التي تحكم المسألة فعلاً.

### 1.2 ليست وثيقة ملزمة
هذه الصفحة **ليست** مصدراً للحقوق والالتزامات. ما يلزم المتجر والزبون هو نص الوثيقة المختصة، لا هذا التبسيط.

### 1.3 عند الاختلاف
إذا اختلف ما هنا عن نص وثيقة مختصة، سرت الوثيقة المختصة، دون استثناء.

### 1.4 النص المعتمد
النص العربي هو النص المعتمد.

## 2. الحساب والتسجيل

### 2.1 هل أحتاج حساباً للشراء؟
نعم. والنقاط والضمان وسجل الطلبات كلها مرتبطة بالحساب. التفاصيل في وثيقة التسجيل والحسابات.

### 2.2 سجّلت ببريدي ولم يُنشأ حساب؟
عند التسجيل بالبريد لا يُنشأ الحساب إلا بعد فتح الرابط المرسل واختيار كلمة المرور. قبل ذلك لا يوجد حساب. انظر وثيقة التسجيل والحسابات.

### 2.3 لماذا لا أستطيع التسجيل برقم الهاتف مباشرة؟
لا يُحفظ رقم قبل إثبات ملكيته. الطريق هو رمز التحقق عبر واتساب أو تلغرام. انظر وثيقة التسجيل والحسابات.

### 2.4 نسيت كلمة المرور
استعملي مسار الاستعادة من صفحة الدخول. ولا يستطيع أي موظف قراءة كلمة مرورك ولا إخبارك بها.

### 2.5 رُفض اسم المستخدم الذي اخترته
هناك قائمتان: واحدة تمنع انتحال صفة المتجر، وأخرى تمنع الألفاظ غير اللائقة. إن كان الرفض في غير محله فاعترضي عبر {{LEVONIS_SUPPORT_CONTACT}} ويُصحَّح دون رسوم. انظر شروط استخدام الموقع.

### 2.6 كيف أغلق حسابي؟
لا يوجد زر حذف ذاتي. الطلب عبر القناة المعتمدة ويُنفَّذ خلال {{ACCOUNT_CLOSURE_PROCESSING_DAYS}} بعد إغلاق الطلبات القائمة. انظر سياسة الخصوصية.

## 3. الطلب والدفع

### 3.1 متى ينعقد البيع؟
بتأكيد الطلب على الخادم، لا بوضع المنتج في السلة. انظر وثيقة الشراء.

### 3.2 وسائل الدفع
المحفظة، والدفع عند الاستلام حيث يكون متاحاً، والنقاط كخصم. التفاصيل في وثيقة الدفع.

### 3.3 هل تُحفظ بطاقتي؟
لا يخزّن المتجر بيانات بطاقة دفع كاملة. انظر سياسة الخصوصية.

### 3.4 ظهر سعر أقل ثم تغيّر
حالات الخطأ في السعر وما يترتب عليها في وثيقة حماية السعر.

### 3.5 هل أستطيع تعديل عنوان طلب مؤكد؟
حتى {{ADDRESS_CHANGE_DEADLINE_HOURS}} من التأكيد وبحسب حالة الطلب. انظر وثيقة التوصيل.

## 4. التوصيل

### 4.1 متى يصل طلبي؟
المدة تختلف بالمحافظة وبحالة التوفر، وما يُعتمد هو ما يظهر في سجل الطلب. ولا يعد المساعد بموعد لا يراه في السجل.

### 4.2 هل التوصيل مجاني؟
مجاني لأعضاء العضويات فوق حدود معلنة، ولغيرهم بحسب تعرفة المحافظة. انظر وثيقة التوصيل ووثيقة العضويات.

### 4.3 وصل الطرد تالفاً
بلّغي خلال {{DAMAGE_REPORT_WINDOW_HOURS}} مع صور. انظر وثيقة التوصيل.

### 4.4 لم أستلم والطلب مسجَّل مُسلَّماً
افتحي تذكرة فوراً؛ يُراجَع السجل وسجل شركة التوصيل. انظر سياسة الدعم.

## 5. الإرجاع والضمان

### 5.1 هل أستطيع الإرجاع لأني غيّرت رأيي؟
حالات الإرجاع وشروطه ومن يتحمل الأجرة في وثيقة الإرجاع.

### 5.2 ما مدة الضمان؟
تختلف بالمنتج وتظهر على صفحته وفي فاتورته. التفاصيل في وثيقة الضمان.

### 5.3 ما الذي يسقط الضمان؟
العبث والفتح غير المصرح به والاستعمال خارج المواصفة وغيرها، مذكورة حصراً في وثيقة الضمان.

### 5.4 هل عضوية PRO تغيّر قرار الضمان؟
لا. تقدّم تذكرتك في الطابور فقط. القرار نفسه لا يتغير. انظر سياسة الدعم ووثيقة الضمان.

### 5.5 جهازي خارج الضمان، هل تُصلحونه؟
نعم، إصلاح مدفوع: طلب، ثم تشخيص، ثم عرض سعر مكتوب، ولا يبدأ العمل إلا بقبول مكتوب. انظر وثيقة ما بعد البيع.

## 6. النقاط

### 6.1 متى تصبح نقاط الشراء قابلة للاستعمال؟
بعد سبعة أيام من تأكيد الطلب **و** بعد تسوية الدفع. وفي الدفع عند الاستلام، التسوية هي تسجيل التحصيل لا التسليم وحده. انظر سياسة النقاط.

### 6.2 نقاطي أقل مما توقعت
ثلاثة أسباب شائعة: أجرة التوصيل ورسوم الضمان لا تكسب نقاطاً، والنقاط التي أنفقتِها على الطلب تُخصم من الأساس قبل الاحتساب، والمضاعف يقرَّب إلى أقرب عدد صحيح. التفصيل في سياسة النقاط.

### 6.3 كم تساوي النقطة؟
نقطة واحدة تخصم ديناراً واحداً بالضبط، دون تقريب.

### 6.4 ما سلّم تسجيل الدخول اليومي؟
5، 5، 10، 10، 15، 15، ثم 20 من اليوم السابع فصاعداً. وانقطاع التتابع يعيدك إلى أول درجة.

### 6.5 مضاعف الاشتراك
بريميوم ×1.5 و PRO ×2. ويُحسب لحظة قيد النقاط، لا بأثر رجعي.

### 6.6 هل تنتهي صلاحية النقاط؟
لا تنتهي بمرور الزمن وحده اليوم. وأي تغيير يُعلَن مسبقاً ولا يسري بأثر رجعي.

### 6.7 هل أستطيع تحويل نقاطي إلى نقد أو إلى حساب آخر؟
لا. النقاط شخصية ولا تُصرف نقداً ولا تُنقل.

## 7. العضويات

### 7.1 ما الفرق بين الفئات؟
المزايا وترتيبها في وثيقة العضويات، وهي مكتوبة بحسب أدنى فئة تملك كل ميزة.

### 7.2 لماذا لم أحصل على سعر PRO؟
بعض مزايا الشراء لعضوية PRO مشروطة بالعنوان المعتمد الافتراضي. انظر وثيقة العضويات.

### 7.3 هل يتجدد الاشتراك تلقائياً؟
لا يوجد تجديد تلقائي ولا وسيلة دفع محفوظة. ينتهي الاشتراك بانتهاء مدته.

### 7.4 كيف ألغي الاشتراك؟
عبر طلب إلى الدعم؛ لا يوجد إلغاء ذاتي. انظر وثيقة العضويات.

## 8. مجتمع ليفو

### 8.1 من البائع؟
التاجر المستقل، لا المتجر. ودور المتجر استضافة المنصة. انظر وثيقة مجتمع ليفو.

### 8.2 كيف يُدفع في طلب المجتمع؟
مقدماً من المحفظة. ولا يوجد دفع عند الاستلام ولا استلام من المخزن. انظر وثيقة مجتمع ليفو.

### 8.3 هل يستطيع موظف قراءة محادثتي مع التاجر؟
لا. لا يقرأ المحادثة إلا طرفاها، ولا يوجد باب خلفي في النظام. وإن احتجتِ إليها دليلاً في نزاع فقدّميها أنتِ. انظر سياسة الخصوصية.

### 8.4 التاجر لا يرد
هناك مدة رد معلنة ومسار تصعيد. انظر وثيقة مجتمع ليفو.

## 9. الخصوصية والبيانات

### 9.1 ما الذي يُحفظ عني؟
جرد الفئات في سياسة الخصوصية، فئةً فئةً مع الغرض من كل واحدة.

### 9.2 بيانات هويتي «مشفَّرة»، فهل تستطيعون قراءتها؟
نعم عند الحاجة المشروعة. التشفير هنا من جانب الخادم بمفاتيح يديرها المتجر، وليس تشفيراً طرفياً، ولا نصفه بغير ذلك. انظر سياسة الخصوصية.

### 9.3 لماذا لا يوجد زر حذف الحساب؟
لأن الحذف يمر بإغلاق الطلبات القائمة وتسوية الأرصدة وحفظ ما يلزم قانوناً. فهو طلب يعالجه إنسان لا زر. انظر سياسة الخصوصية.

### 9.4 هل تبيعون بياناتي؟
لا. ولا توجد شبكة إعلانات ولا أداة تحليلات من طرف ثالث داخل الصفحات.

### 9.5 هل تُرسَل هويتي إلى جهة خارجية؟
لا. ولا يوجد تعرّف على الوجه ولا استعلام من قاعدة بيانات حكومية. القرار قرار موظف مخوّل يُسجَّل باسمه.

## 10. الدعم

### 10.1 كيف أتواصل؟
تذكرة من داخل الحساب، أو {{LEVONIS_SUPPORT_CONTACT}} خلال {{LEVONIS_SUPPORT_HOURS}}.

### 10.2 هل المساعد داخل الموقع ذكاء اصطناعي؟
لا. أداة حتمية بقواعد مكتوبة، تجيب من بيانات حسابك ومن الوثائق المنشورة، ولا تخمّن، وتحيل إلى موظف عند الالتباس. انظر شروط استخدام الموقع.

### 10.3 موظف وعدني بشيء في واتساب
ما يُعتدّ به مكتوب داخل التذكرة. وما كُتب فيها من التزام صريح يلزم المتجر. انظر سياسة الدعم.

### 10.4 كيف أصعّد شكوى؟
اطلبي التصعيد داخل التذكرة، أو راسلي {{LEVONIS_COMPLAINTS_CONTACT}}، ويُبتّ خلال {{DISPUTE_RESPONSE_DAYS}}.

## 11. المقارنة بين المنتجات

### 11.1 على أي أساس تُقارَن المواصفات؟
تُقارَن على محاور معلنة، وتُذكر أعلى الصفحة طبيعة المقارنة: أهي بين جهازين من التقنية نفسها أم مقارنة مختلطة.

### 11.2 لماذا بعض الحقول فارغة؟
لأن القيمة غير مذكورة لذلك المنتج. والحقل غير المذكور لا يُحتسب في النتيجة ولا يُقرأ كصفر.

### 11.3 هل ترتيب المقارنة قرار شراء؟
لا. هو ملخص للمواصفات المعلنة. والملزم هو ما في صفحة المنتج وفي الفاتورة.

## 12. أسئلة يكثر الخلاف عليها

### 12.1 لماذا تغيّرت أجرة التوصيل بين لحظة وأخرى؟
أجرة التوصيل ليست رقماً يضعه المتجر، بل تحدده شركة التوصيل بحسب الوجهة والوزن والحجم وحالة الطريق يوم الشحن. والرقم المعروض عند الدفع رقم لحظي صالح لتلك اللحظة، ويتغير بتغير العنوان أو محتوى السلة أو تعرفة الشركة. المرجع: وثيقة التوصيل، المادتان 3.14 و3.15.

### 12.2 هل أستطيع فتح الصندوق قبل أن أدفع للمندوب؟
لك عند الباب أن تتحقق من سلامة الطرد من الخارج، ومن مطابقة عدد القطع، ومن أن التغليف الخارجي لم يُفتح، وذلك خلال {{DOOR_INSPECTION_MINUTES}}. أما فتح المنتج نفسه وتشغيله قبل الدفع فليس حقاً على المندوب، لأنه ليس طرفاً في البيع ولا يملك القرار فيه. فإن ظهر الخلل بعد الفتح فطريقه الإرجاع خلال سبعة أيام من التسليم أو الضمان. المرجع: وثيقة الشراء، الفصل الثامن، ووثيقة التوصيل، المادة 3.27.

### 12.3 وصل الطرد مفتوحاً لأن نقطة تفتيش على الحدود فتحته، فمن المسؤول؟
فتح الطرد في نقطة تفتيش أو عند حدود الإقليم إجراء لا يملك المتجر ولا الناقل منعه، ولا يُعد بذاته عيباً في المنتج. والمطلوب منك أن توثّق الحالة بالصور عند الباب قبل التوقيع، وأن تبلّغ خلال {{DAMAGE_REPORT_WINDOW_HOURS}}، فإن نقص شيء أو تضرر عولج على أساس الضرر أثناء النقل. أما التوقيع بلا تحفظ ثم الإبلاغ بعد أيام فيُضعف المطالبة. المرجع: وثيقة التوصيل، المواد 3.25 و3.26 و3.30، ووثيقة الاسترجاع، المواد 4.16 إلى 4.19.

### 12.4 هل أستطيع شراء الضمان الممتد بعد أن طلبت؟
لا. الضمان الممتد يُشترى قبل تثبيت الطلب فقط، ويُسجَّل على الطلب نفسه وبرسمه. ولا يُباع بعد الشراء ولا بعد التسليم ولا عند ظهور عطل، لأنه عندئذ تأمين على واقعة وقعت. المرجع: وثيقة الضمان الممتد، المادة 6.2.

### 12.5 لماذا لا أستطيع الدفع عند الاستلام في منتج من متجر مجتمعي؟
لأن البائع في ذلك المسار تاجر مستقل لا المتجر، والمال يُحجز داخل المنصة حتى يتم الطلب، وهذا الحجز هو ما يحمي الطرفين. فلو دُفع عند الباب لما بقي للمنصة ما تحجزه ولا ما تردّه عند النزاع. ولهذا السبب نفسه لا يوجد استلام من المخزن في هذا المسار. المرجع: سياسة مجتمع ليفو، المادتان 7.5 و7.6.

### 12.6 لماذا ترفض السلة إضافة منتج من متجر آخر؟
لأن السلة الواحدة تحمل بائعاً واحداً: إما متجر ليفونيس الرسمي وإما تاجراً واحداً من المجتمع. ولكل بائع وسائل دفعه وتسليمه ومسؤوليته ومدده، وخلطهم في سلة واحدة يجعل الطلب الواحد محكوماً بقواعد متعارضة. والحل أن تُتمّ الطلب الأول ثم تبدأ سلة جديدة. المرجع: وثيقة الشراء، المادة 4.7، وسياسة مجتمع ليفو، المادة 7.3.

### 12.7 ما الفرق بين البيع المباشر والطلب المسبق؟
البيع المباشر بضاعة موجودة فعلاً وجاهزة للشحن، وسعرها يحمل علاوة البيع المباشر. والطلب المسبق بضاعة تُجلب بعد طلبك، فسعر بضاعتها أقل وتُضاف إليه عمولة نقل، ومدته أطول بطبيعته. ولا يُحوَّل طلب مسبق إلى بيع مباشر بعد تثبيته. المرجع: وثيقة الشراء، المواد 4.1 و4.2 و4.8 و4.10.

### 12.8 لماذا يستغرق الشحن البحري كل هذه المدة؟
لأن المسار البحري نفسه طويل: حجز الحاوية، ثم الإبحار، ثم التفريغ في الميناء، ثم التخليص الكمركي، ثم النقل البري إلى المخزن، ثم التوزيع. وكل محطة من هذه المحطات لها طابورها ولا يملك المتجر تقصيره. ولهذا يُعرض المسار الجوي والبري والبحري بمدد مختلفة وأسعار مختلفة، وتبقى المدد كلها تقديرية لا وعداً. المرجع: وثيقة التوصيل، المادتان 3.8 و3.9، ووثيقة الشراء، المادتان 4.3 و4.4.

### 12.9 متى يعود مالي إلى المحفظة بعد إلغاء الطلب؟
إذا كان الطلب مدفوعاً مسبقاً من المحفظة أُعيد المبلغ إلى المحفظة عند تسجيل الإلغاء، وأُعيدت معه النقاط التي صُرفت على الطلب، وأُلغيت نقاطه المعلّقة. وإذا كان المال محجوزاً ولم يُسوَّ بعد فإن الحجز يُفك ويعود الرصيد متاحاً. والرد يكون إلى المحفظة لا نقداً. المرجع: وثيقة الشراء، المادة 12.2، ووثيقة الدفع، الفصل الحادي عشر، ووثيقة النقاط، المادتان 3.9 و11.6.

### 12.10 لماذا تعرض المحفظة رقمين مختلفين؟
لأن المحفظة ليست رقماً واحداً: هناك الرصيد المسوّى، وهو كل ما دخل وخرج؛ وهناك المحجوز، وهو ما التزم به لطلب قائم؛ وهناك الرصيد المتاح، وهو الفرق بينهما، وهو وحده ما يمكن إنفاقه. فإذا رأيت رقماً أكبر في مكان وأصغر في الدفع فالسبب في الغالب مبلغ محجوز لطلب لم يُغلق بعد. والنقاط رصيد مستقل عن هذا كله، ولها معلّقها ومستقرها. المرجع: وثيقة الدفع، المواد 6.1 إلى 6.7.

### 12.11 لماذا حصلت على نقاط مراجعة ولم أحصل على هدية؟
لأنهما شيئان مختلفان. نقاط المراجعة تُمنح تلقائياً للمراجعة اليدوية الصحيحة في اللحظة نفسها. أما الهدية فقرار مستقل للمتجر، لا يترتب على مجرد كتابة مراجعة، ولا تدخله المراجعة إلا إذا بلغت درجة جودة مقيسة، ثم يصدر فيه قبول أو طلب تعديل أو رفض بسبب مكتوب. المرجع: وثيقة النقاط والمراجعات، المادتان 7.5 و8.2.

## 13. أحكام ختامية

### 13.1 تحديث هذه الصفحة
تُحدَّث دون أن يترتب عليها حق أو التزام، لأنها ليست وثيقة ملزمة.

### 13.2 أين أجد الوثائق كاملة؟
في صفحة الوثائق داخل الموقع، مرتبةً في أقسام، وكل وثيقة بنسختها وتاريخ نفاذها.`,
    en: `## 1. Before you read

### 1.1 What this page is
This page is a guide to the Store's documents, written as questions. Every answer is a summary and names the document that actually governs the matter.

### 1.2 Not a binding document
This page is **not** a source of rights and obligations. What binds the Store and the Customer is the text of the specialist document, not this simplification.

### 1.3 On any difference
If anything here differs from the text of a specialist document, that document prevails, without exception.

### 1.4 Authoritative text
The Arabic text is authoritative.

## 2. Account and registration

### 2.1 Do I need an account to buy?
Yes. Points, warranty and order history are all tied to the account. Details in the Registration and Accounts policy.

### 2.2 I registered with my email and no account was created
When registering by email, the account is created only after the emailed link is opened and a password chosen. Before that there is no account. See the Registration and Accounts policy.

### 2.3 Why can't I register with a phone number directly?
No number is stored before ownership of it is proven. The route is a verification code by WhatsApp or Telegram. See the Registration and Accounts policy.

### 2.4 I forgot my password
Use the recovery path on the sign-in page. No member of staff can read your password or tell you what it is.

### 2.5 My chosen username was refused
There are two lists: one preventing impersonation of the Store, and one preventing indecent words. If the refusal is wrong, appeal via {{LEVONIS_SUPPORT_CONTACT}} and it is corrected without charge. See the Website Terms of Use.

### 2.6 How do I close my account?
There is no self-service delete button. The request goes through the approved channel and is carried out within {{ACCOUNT_CLOSURE_PROCESSING_DAYS}} after open orders are closed. See the Privacy Policy.

## 3. Ordering and payment

### 3.1 When is the sale formed?
On confirmation of the order on the server — not by putting a product in the cart. See the Purchase policy.

### 3.2 Payment methods
The wallet, cash on delivery where available, and points as a discount. Details in the Payment policy.

### 3.3 Is my card stored?
The Store does not store full payment-card data. See the Privacy Policy.

### 3.4 A lower price was shown and then changed
Pricing-error cases and their consequences are in the Price Protection policy.

### 3.5 Can I change the address on a confirmed order?
Up to {{ADDRESS_CHANGE_DEADLINE_HOURS}} from confirmation, depending on the order's state. See the Delivery policy.

## 4. Delivery

### 4.1 When will my order arrive?
The period varies by governorate and availability, and what counts is what appears in the order record. The assistant will not promise a date it cannot see there.

### 4.2 Is delivery free?
Free for members above published thresholds, and otherwise by governorate tariff. See the Delivery policy and the Memberships policy.

### 4.3 The parcel arrived damaged
Report within {{DAMAGE_REPORT_WINDOW_HOURS}} with photographs. See the Delivery policy.

### 4.4 I did not receive it but the order is recorded as delivered
Open a ticket immediately; the record and the carrier's record are reviewed. See the Support policy.

## 5. Returns and warranty

### 5.1 Can I return an item because I changed my mind?
The return cases, their conditions and who bears the cost are in the Returns policy.

### 5.2 How long is the warranty?
It varies by product and is shown on its page and on its invoice. Details in the Warranty policy.

### 5.3 What voids the warranty?
Tampering, unauthorised opening, use outside specification and others, listed exhaustively in the Warranty policy.

### 5.4 Does PRO membership change a warranty decision?
No. It moves your ticket up the queue only. The decision itself does not change. See the Support policy and the Warranty policy.

### 5.5 My device is out of warranty — will you repair it?
Yes, as a paid repair: a request, then a diagnosis, then a written quotation, and work begins only on written acceptance. See the After-Sale policy.

## 6. Points

### 6.1 When do purchase points become usable?
Seven days after order confirmation **and** after payment has settled. For cash on delivery, settlement is the recorded collection, not delivery alone. See the Points policy.

### 6.2 My points are fewer than I expected
Three common reasons: delivery charges and warranty fees earn nothing; points you spent on the order are deducted from the base before the calculation; and the multiplier is rounded to the nearest whole number. Detail in the Points policy.

### 6.3 What is a point worth?
One point discounts exactly one dinar, with no rounding.

### 6.4 What is the daily sign-in ladder?
5, 5, 10, 10, 15, 15, then 20 from the seventh day onward. Breaking the streak returns you to the first rung.

### 6.5 The subscription multiplier
Premium ×1.5 and PRO ×2, applied at the instant the points are recorded, never retroactively.

### 6.6 Do points expire?
They do not expire by the passage of time alone today. Any change is announced in advance and does not apply retroactively.

### 6.7 Can I convert points to cash or move them to another account?
No. Points are personal, are not paid out in cash and are not transferable.

## 7. Memberships

### 7.1 What is the difference between the tiers?
The benefits and their order are in the Memberships policy, written by the lowest tier that owns each benefit.

### 7.2 Why did I not get the PRO price?
Some PRO purchase benefits are conditional on the approved default address. See the Memberships policy.

### 7.3 Does the subscription renew automatically?
There is no automatic renewal and no stored payment instrument. The subscription simply ends when its term ends.

### 7.4 How do I cancel?
By request to Support; there is no self-service cancellation. See the Memberships policy.

## 8. Levo community

### 8.1 Who is the seller?
The independent merchant, not the Store. The Store's role is to host the platform. See the Levo Community policy.

### 8.2 How is a community order paid?
Prepaid from the wallet. There is no cash on delivery and no warehouse pickup. See the Levo Community policy.

### 8.3 Can a staff member read my conversation with a merchant?
No. Only the two parties read it, and there is no back door in the system. If you need it as evidence in a dispute, you submit it yourself. See the Privacy Policy.

### 8.4 The merchant is not replying
There is a published reply window and an escalation path. See the Levo Community policy.

## 9. Privacy and data

### 9.1 What is held about me?
An inventory of the categories is in the Privacy Policy, category by category with the purpose of each.

### 9.2 My identity data is "encrypted" — can you read it?
Yes, for a legitimate need. The encryption here is server-side with keys the Store manages; it is not end-to-end, and we do not describe it as such. See the Privacy Policy.

### 9.3 Why is there no delete-my-account button?
Because deletion passes through closing open orders, settling balances and retaining what the law requires. It is therefore a request handled by a person, not a button. See the Privacy Policy.

### 9.4 Do you sell my data?
No. There is no advertising network and no third-party analytics tool inside the pages.

### 9.5 Is my identity sent to an outside party?
No. There is no face recognition and no government-database query. The decision is made by an authorised staff member and recorded in their name.

## 10. Support

### 10.1 How do I get in touch?
A ticket from inside your account, or {{LEVONIS_SUPPORT_CONTACT}} during {{LEVONIS_SUPPORT_HOURS}}.

### 10.2 Is the in-site assistant an AI?
No. It is a deterministic tool driven by written rules, answering from your account's data and from the published documents. It does not guess and refers ambiguity to a person. See the Website Terms of Use.

### 10.3 A staff member promised me something on WhatsApp
What counts is what is written inside the ticket. An express undertaking written there binds the Store. See the Support policy.

### 10.4 How do I escalate a complaint?
Ask for escalation inside the ticket, or write to {{LEVONIS_COMPLAINTS_CONTACT}}; it is decided within {{DISPUTE_RESPONSE_DAYS}}.

## 11. Comparing products

### 11.1 On what basis are specifications compared?
On published axes, and the nature of the comparison is stated at the top of the page: whether it is between two machines of the same technology or a mixed comparison.

### 11.2 Why are some fields empty?
Because the value is not stated for that product. A field that is not stated is not counted in the result and is not read as a zero.

### 11.3 Is the comparison ranking a purchase decision?
No. It is a summary of published specifications. What binds is what is on the product page and on the invoice.

## 12. Questions that are most often argued about

### 12.1 Why did the delivery charge change from one moment to the next?
The delivery charge is not a figure the Store sets; it is set by the delivery company according to the destination, the weight, the volume and the state of the road on the day of shipping. The figure shown at checkout is a figure of that moment, and it changes with the address, the contents of the cart or the company's tariff. Reference: the Delivery document, articles 3.14 and 3.15.

### 12.2 May I open the box before I pay the courier?
At the door you may verify that the parcel is sound from the outside, that the number of pieces matches, and that the outer packaging has not been opened, within {{DOOR_INSPECTION_MINUTES}}. Opening the product itself and running it before paying is not a right against the courier, who is not a party to the sale and holds no decision in it. If a defect appears after opening, the path is a return within seven days of delivery, or the warranty. Reference: the Purchase document, chapter 8, and the Delivery document, article 3.27.

### 12.3 The parcel arrived open because a checkpoint at the border opened it; who is responsible?
Opening a parcel at a checkpoint or at the borders of the Region is a measure neither the Store nor the carrier can prevent, and it is not in itself a defect in the product. What is required of you is to document the condition in photographs at the door before signing, and to report within {{DAMAGE_REPORT_WINDOW_HOURS}}; if something is missing or damaged it is handled on the basis of transit damage. Signing without reservation and then reporting days later weakens the claim. Reference: the Delivery document, articles 3.25, 3.26 and 3.30, and the Returns document, articles 4.16 to 4.19.

### 12.4 Can I buy the extended warranty after I have ordered?
No. The extended warranty is bought only before the order is committed, and it is recorded on that order with its fee. It is not sold after the purchase, nor after delivery, nor when a fault appears, because at that point it would be insurance against an event that has already happened. Reference: the Extended Warranty document, article 6.2.

### 12.5 Why can I not pay on delivery for a product from a community store?
Because in that path the seller is an independent merchant and not the Store, and the money is held inside the platform until the order is completed; that holding is what protects both parties. Were it paid at the door, the platform would have nothing to hold and nothing to return upon a dispute. For the same reason there is no warehouse collection in that path. Reference: the Levo Community Policy, articles 7.5 and 7.6.

### 12.6 Why does the cart refuse a product from another shop?
Because one cart carries one seller: either the official Levonis store or one community merchant. Each seller has their own means of payment and delivery, their own liability and their own periods, and mixing them in one cart makes a single order subject to conflicting rules. The remedy is to complete the first order and then begin a new cart. Reference: the Purchase document, article 4.7, and the Levo Community Policy, article 7.3.

### 12.7 What is the difference between a direct sale and a pre-order?
A direct sale is goods that actually exist and are ready to ship, and its price carries the direct-sale premium. A pre-order is goods brought in after your order, so the price of the goods is lower and a transport commission is added to it, and its period is by nature longer. A pre-order is not converted into a direct sale after it is committed. Reference: the Purchase document, articles 4.1, 4.2, 4.8 and 4.10.

### 12.8 Why does sea freight take all that time?
Because the sea route itself is long: booking the container, then the voyage, then unloading at the port, then customs clearance, then land transport to the warehouse, then distribution. Each of these stages has its own queue, which the Store cannot shorten. That is why the air, land and sea routes are offered with different periods and different prices, and why all the periods remain estimates and not a promise. Reference: the Delivery document, articles 3.8 and 3.9, and the Purchase document, articles 4.3 and 4.4.

### 12.9 When does my money return to the wallet after a cancellation?
Where the order was prepaid from the wallet, the amount is returned to the wallet when the cancellation is recorded, together with the points that were spent on the order, and its pending points are cancelled. Where the money was held and not yet settled, the hold is released and the balance becomes available again. The refund is to the wallet and not in cash. Reference: the Purchase document, article 12.2, the Payment document, chapter 11, and the Points document, articles 3.9 and 11.6.

### 12.10 Why does the wallet show two different figures?
Because the wallet is not one figure: there is the settled balance, which is everything that came in and went out; there is the held amount, which is committed to a live order; and there is the available balance, which is the difference between them and is the only one that can be spent. If you see a larger figure in one place and a smaller one at checkout, the cause is usually an amount held for an order that has not yet closed. Points are a separate balance from all of this, with their own pending and settled parts. Reference: the Payment document, articles 6.1 to 6.7.

### 12.11 Why did I receive review points but no gift?
Because they are two different things. Review points are granted automatically for a valid manual review at the very moment it is saved. The gift, by contrast, is an independent decision of the Store; it does not follow from merely writing a review, a review enters it only where it reaches a measured quality score, and an approval, a request for changes or a refusal then issues upon it with a written reason. Reference: the Points and Reviews document, articles 7.5 and 8.2.

## 13. Final provisions

### 13.1 Updating this page
It is updated without creating any right or obligation, because it is not a binding document.

### 13.2 Where do I find the full documents?
On the documents page inside the site, arranged in sections, each with its version and effective date.`,
    ckb: `## 1. پێش خوێندنەوە

### 1.1 ئەم لاپەڕەیە چییە
ئەم لاپەڕەیە ڕێنمایەکە بۆ بەڵگەنامەکانی فرۆشگا، بە شێوەی پرسیار نووسراوە. هەر وەڵامێک کورتەیەکە و ناوی ئەو بەڵگەنامەیە دەڵێت کە بەکردەوە بابەتەکە ڕێک دەخات.

### 1.2 بەڵگەنامەیەکی پابەندکەر نییە
ئەم لاپەڕەیە **سەرچاوەی** ماف و ئەرک **نییە**. ئەوەی فرۆشگا و کڕیار پابەند دەکات دەقی بەڵگەنامەی پسپۆڕەکەیە، نەک ئەم ساکارکردنەوەیە.

### 1.3 لە کاتی جیاوازیدا
ئەگەر ئەوەی لێرەیە لەگەڵ دەقی بەڵگەنامەیەکی پسپۆڕ جیاواز بوو، ئەو بەڵگەنامەیە سەرچاوەیە، بەبێ هیچ جیاوازییەک.

### 1.4 دەقی بنەڕەت
دەقی عەرەبی بنەڕەتە.

## 2. هەژمار و تۆمارکردن

### 2.1 بۆ کڕین هەژمارم پێویستە؟
بەڵێ. خاڵ و گەرەنتی و مێژووی داواکارییەکان هەموو بە هەژمارەوە بەستراون. وردەکاری لە بەڵگەنامەی تۆمارکردن و هەژمارەکان.

### 2.2 بە ئیمەیڵ تۆمارم کرد و هەژمار دروست نەبوو
لە کاتی تۆمارکردن بە ئیمەیڵ، هەژمار تەنها دوای کردنەوەی ئەو بەستەرەی نێردراوە و هەڵبژاردنی وشەی نهێنی دروست دەبێت. پێش ئەوە هیچ هەژمارێک نییە. بڕوانە بەڵگەنامەی تۆمارکردن و هەژمارەکان.

### 2.3 بۆچی ناتوانم ڕاستەوخۆ بە ژمارەی مۆبایل تۆمار بکەم؟
هیچ ژمارەیەک پێش سەلماندنی خاوەندارێتی هەڵناگیرێت. ڕێگاکە کۆدی پشتڕاستکردنەوەیە بە واتساپ یان تێلێگرام. بڕوانە بەڵگەنامەی تۆمارکردن و هەژمارەکان.

### 2.4 وشەی نهێنیم لەبیر چووە
ڕێڕەوی گەڕاندنەوە لە لاپەڕەی چوونەژوورەوە بەکاربهێنە. هیچ کارمەندێک ناتوانێت وشەی نهێنیت بخوێنێتەوە یان پێت بڵێت.

### 2.5 ناوی بەکارهێنەری هەڵبژاردووم ڕەت کرایەوە
دوو لیست هەن: یەکێکیان ڕێگری لە خۆدەرخستن وەک فرۆشگا دەکات، و ئەویتریان ڕێگری لە وشەی ناشیاو دەکات. ئەگەر ڕەتکردنەوەکە هەڵە بوو، لە ڕێگەی {{LEVONIS_SUPPORT_CONTACT}} ناڕەزایی دەرببڕە و بەبێ کرێ ڕاست دەکرێتەوە. بڕوانە مەرجەکانی بەکارهێنانی ماڵپەڕ.

### 2.6 چۆن هەژمارەکەم دادەخەم؟
هیچ دوگمەیەکی سڕینەوەی خۆکار نییە. داواکارییەکە لە ڕێگەی کەناڵی پەسەندکراوەوە دەچێت و لە ماوەی {{ACCOUNT_CLOSURE_PROCESSING_DAYS}} دوای داخستنی داواکارییە کراوەکان جێبەجێ دەکرێت. بڕوانە سیاسەتی تایبەتمەندێتی.

## 3. داواکاری و پارەدان

### 3.1 کەی فرۆشتن دروست دەبێت؟
بە پەسەندکردنی داواکارییەکە لەسەر ڕاژە — نەک بە خستنی بەرهەم لە سەبەتەدا. بڕوانە بەڵگەنامەی کڕین.

### 3.2 ڕێگەکانی پارەدان
جزدان، پارەدان لە کاتی گەیاندندا لە شوێنی بەردەست، و خاڵ وەک داشکاندن. وردەکاری لە بەڵگەنامەی پارەدان.

### 3.3 کارتەکەم هەڵدەگیرێت؟
فرۆشگا داتای تەواوی کارتی پارەدان هەڵناگرێت. بڕوانە سیاسەتی تایبەتمەندێتی.

### 3.4 نرخێکی کەمتر پیشان درا و پاشان گۆڕا
حاڵەتەکانی هەڵەی نرخ و ئەنجامەکانیان لە بەڵگەنامەی پاراستنی نرخدان.

### 3.5 دەتوانم ناونیشانی داواکارییەکی پەسەندکراو بگۆڕم؟
تا {{ADDRESS_CHANGE_DEADLINE_HOURS}} لە پەسەندکردنەوە و بەپێی دۆخی داواکارییەکە. بڕوانە بەڵگەنامەی گەیاندن.

## 4. گەیاندن

### 4.1 کەی داواکارییەکەم دەگات؟
ماوەکە بەپێی پارێزگا و بەردەستبوون جیاوازە، و ئەوەی سەرچاوەیە ئەوەیە کە لە تۆماری داواکارییەکەدا دەردەکەوێت. یاریدەدەر بەڵێنی بەروارێک نادات کە لەوێدا نەیبینێت.

### 4.2 گەیاندن بێبەرامبەرە؟
بێبەرامبەرە بۆ ئەندامان لە سەرووی سنووری ڕاگەیەنراوەوە، و بۆ ئەوانیتر بەپێی تەعریفەی پارێزگا. بڕوانە بەڵگەنامەی گەیاندن و بەڵگەنامەی ئەندامێتییەکان.

### 4.3 پاکەتەکە بە زیانەوە گەیشت
لە ماوەی {{DAMAGE_REPORT_WINDOW_HOURS}} بە وێنەوە ڕایبگەیەنە. بڕوانە بەڵگەنامەی گەیاندن.

### 4.4 وەرمنەگرتووە بەڵام داواکارییەکە وەک گەیشتوو تۆمار کراوە
دەستبەجێ بلیتێک بکەرەوە؛ تۆمارەکە و تۆماری کۆمپانیای گەیاندن پێداچوونەوەیان بۆ دەکرێت. بڕوانە سیاسەتی پشتگیری.

## 5. گەڕاندنەوە و گەرەنتی

### 5.1 دەتوانم بیگەڕێنمەوە چونکە بیرم گۆڕا؟
حاڵەتەکانی گەڕاندنەوە و مەرجەکانیان و ئەوەی کرێکە لەسەر کێیە لە بەڵگەنامەی گەڕاندنەوەدان.

### 5.2 ماوەی گەرەنتی چەندە؟
بەپێی بەرهەم جیاوازە و لە لاپەڕەکەی و لە پسوولەکەیدا دەردەکەوێت. وردەکاری لە بەڵگەنامەی گەرەنتی.

### 5.3 چی گەرەنتی لەناو دەبات؟
دەستکاری، کردنەوەی بێمۆڵەت، بەکارهێنان لە دەرەوەی تایبەتمەندی و هیتر، بە تەواوی لە بەڵگەنامەی گەرەنتیدا ڕیز کراون.

### 5.4 ئەندامێتی PRO بڕیاری گەرەنتی دەگۆڕێت؟
نەخێر. تەنها بلیتەکەت لە ڕیزەکەدا پێشدەخات. خودی بڕیارەکە ناگۆڕێت. بڕوانە سیاسەتی پشتگیری و بەڵگەنامەی گەرەنتی.

### 5.5 ئامێرەکەم لە دەرەوەی گەرەنتییە، چاکی دەکەنەوە؟
بەڵێ، وەک چاکسازیی پارەدراو: داواکاری، پاشان دەستنیشانکردن، پاشان پێشکەشکردنی نرخی نووسراو، و کارەکە تەنها بە پەسەندکردنی نووسراو دەست پێدەکات. بڕوانە بەڵگەنامەی دوای فرۆشتن.

## 6. خاڵەکان

### 6.1 کەی خاڵی کڕین بەکاردێت؟
حەوت ڕۆژ دوای پەسەندکردنی داواکارییەکە **و** دوای یەکلاییبوونەوەی پارەدان. لە پارەدان لە کاتی گەیاندندا، یەکلاییبوونەوە تۆمارکردنی وەرگرتنی پارەکەیە نەک تەنها گەیاندن. بڕوانە سیاسەتی خاڵەکان.

### 6.2 خاڵەکانم لەوەی چاوەڕێم دەکرد کەمترن
سێ هۆکاری باو: کرێی گەیاندن و کرێی گەرەنتی هیچ خاڵێک بەدەست ناهێنن؛ ئەو خاڵانەی لەسەر داواکارییەکە خەرجت کردوون پێش ژمێرکاری لە بنەماکە کەم دەکرێنەوە؛ و زیادکەر بۆ نزیکترین ژمارەی تەواو خڕ دەکرێتەوە. وردەکاری لە سیاسەتی خاڵەکان.

### 6.3 خاڵێک چەندە دەنرخێنرێت؟
یەک خاڵ بە تەواوی یەک دینار داشکاندن دەکات، بەبێ خڕکردنەوە.

### 6.4 پێپلیکانەی چوونەژوورەوەی ڕۆژانە چییە؟
5، 5، 10، 10، 15، 15، پاشان 20 لە ڕۆژی حەوتەمەوە. پچڕانی زنجیرە دەتگەڕێنێتەوە بۆ یەکەم پلە.

### 6.5 زیادکەری ئەندامێتی
پریمیۆم ×1.5 و PRO ×2، لە ساتی تۆمارکردنی خاڵەکاندا جێبەجێ دەبێت، هەرگیز بە دواوە نا.

### 6.6 خاڵەکان بەسەر دەچن؟
ئەمڕۆ تەنها بە تێپەڕینی کات بەسەر ناچن. هەر گۆڕانکارییەک پێشوەخت ڕادەگەیەنرێت و بە دواوە جێبەجێ نابێت.

### 6.7 دەتوانم خاڵەکانم بکەمە پارە یان بۆ هەژمارێکی تر بنێرم؟
نەخێر. خاڵەکان کەسین، بە پارە نادرێنەوە و ناگوازرێنەوە.

## 7. ئەندامێتییەکان

### 7.1 جیاوازی نێوان پلەکان چییە؟
سوودەکان و ڕیزبەندییان لە بەڵگەنامەی ئەندامێتییەکاندان، بەپێی نزمترین پلەی خاوەنی هەر سوودێک نووسراون.

### 7.2 بۆچی نرخی PRO وەرنەگرت؟
هەندێک لە سوودەکانی کڕینی PRO بەندن بە ناونیشانی پەسەندکراوی بنەڕەتەوە. بڕوانە بەڵگەنامەی ئەندامێتییەکان.

### 7.3 ئەندامێتی خۆکارانە نوێ دەبێتەوە؟
هیچ نوێبوونەوەیەکی خۆکار و هیچ ئامرازێکی پارەدانی هەڵگیراو نییە. ئەندامێتی بە کۆتاییهاتنی ماوەکەی کۆتایی دێت.

### 7.4 چۆن هەڵیدەوەشێنمەوە؟
بە داواکارییەک بۆ پشتگیری؛ هەڵوەشاندنەوەی خۆکار نییە. بڕوانە بەڵگەنامەی ئەندامێتییەکان.

## 8. کۆمەڵگەی لێڤۆ

### 8.1 فرۆشیار کێیە؟
بازرگانە سەربەخۆکە، نەک فرۆشگا. ڕۆڵی فرۆشگا میوانداریکردنی پلاتفۆرمەکەیە. بڕوانە بەڵگەنامەی کۆمەڵگەی لێڤۆ.

### 8.2 پارەی داواکاری کۆمەڵگە چۆن دەدرێت؟
پێشوەخت لە جزدانەوە. پارەدان لە کاتی گەیاندندا و وەرگرتن لە کۆگا نییە. بڕوانە بەڵگەنامەی کۆمەڵگەی لێڤۆ.

### 8.3 کارمەندێک دەتوانێت گفتوگۆکەم لەگەڵ بازرگان بخوێنێتەوە؟
نەخێر. تەنها دوو لایەنەکە دەیخوێننەوە، و هیچ دەرگایەکی پشتەوە لە سیستەمەکەدا نییە. ئەگەر وەک بەڵگە لە ناکۆکییەکدا پێویستت بوو، خۆت پێشکەشی دەکەیت. بڕوانە سیاسەتی تایبەتمەندێتی.

### 8.4 بازرگانەکە وەڵام نادات
ماوەیەکی ڕاگەیەنراوی وەڵامدانەوە و ڕێڕەوێکی بەرزکردنەوە هەیە. بڕوانە بەڵگەنامەی کۆمەڵگەی لێڤۆ.

## 9. تایبەتمەندێتی و داتا

### 9.1 چی دەربارەی من هەڵدەگیرێت؟
لیستی پۆلەکان لە سیاسەتی تایبەتمەندێتیدایە، پۆل بە پۆل لەگەڵ مەبەستی هەر یەکێکیان.

### 9.2 داتای ناسنامەم «شێوەکراوە»، دەتوانن بیخوێننەوە؟
بەڵێ، بۆ پێویستییەکی یاسایی. شێوەکردنەکە لێرە لای ڕاژەیە بە کلیلێک کە فرۆشگا بەڕێوەی دەبات؛ سەرتاسەری نییە، و بە جۆرێکی تریش وەسفی ناکەین. بڕوانە سیاسەتی تایبەتمەندێتی.

### 9.3 بۆچی دوگمەی سڕینەوەی هەژمار نییە؟
چونکە سڕینەوە بە داخستنی داواکارییە کراوەکان و یەکلاییکردنەوەی باڵانسەکان و پاراستنی ئەوەی یاسا داوای دەکات تێدەپەڕێت. بۆیە داواکارییەکە کە مرۆڤێک مامەڵەی لەگەڵ دەکات، نەک دوگمە. بڕوانە سیاسەتی تایبەتمەندێتی.

### 9.4 داتاکەم دەفرۆشن؟
نەخێر. هیچ تۆڕێکی ڕیکلام و هیچ ئامرازێکی شیکاری لایەنی سێیەم لە ناو لاپەڕەکاندا نییە.

### 9.5 ناسنامەم بۆ لایەنێکی دەرەکی دەنێردرێت؟
نەخێر. هیچ ناسینەوەی ڕوخسار و هیچ پرسیارێکی بنکەدراوەی حکومی نییە. بڕیارەکە لەلایەن کارمەندێکی مۆڵەتپێدراوەوە دەدرێت و بە ناوی ئەو تۆمار دەکرێت.

## 10. پشتگیری

### 10.1 چۆن پەیوەندی بکەم؟
بلیتێک لە ناو هەژمارەکەتەوە، یان {{LEVONIS_SUPPORT_CONTACT}} لە ماوەی {{LEVONIS_SUPPORT_HOURS}}.

### 10.2 یاریدەدەری ناو ماڵپەڕ ژیری دەستکردە؟
نەخێر. ئامرازێکی دیاریکراوە کە بە ڕێسای نووسراو کار دەکات، لە داتای هەژمارەکەت و لە بەڵگەنامە بڵاوکراوەکان وەڵام دەداتەوە. مەزەندە ناکات و ناڕوونی بۆ کەسێک دەنێرێت. بڕوانە مەرجەکانی بەکارهێنانی ماڵپەڕ.

### 10.3 کارمەندێک لە واتساپ بەڵێنێکی پێدام
ئەوەی سەرچاوەیە ئەوەیە کە لە ناو بلیتەکەدا نووسراوە. بەڵێنێکی ڕوونی لەوێ نووسراو فرۆشگا پابەند دەکات. بڕوانە سیاسەتی پشتگیری.

### 10.4 چۆن سکاڵا بەرز بکەمەوە؟
لە ناو بلیتەکەدا داوای بەرزکردنەوە بکە، یان بۆ {{LEVONIS_COMPLAINTS_CONTACT}} بنووسە؛ لە ماوەی {{DISPUTE_RESPONSE_DAYS}} بڕیاری لەسەر دەدرێت.

## 11. بەراوردکردنی بەرهەمەکان

### 11.1 تایبەتمەندییەکان لەسەر چ بنەمایەک بەراورد دەکرێن؟
لەسەر تەوەرەی ڕاگەیەنراو، و سروشتی بەراوردەکە لە سەرەوەی لاپەڕەکەدا دەوترێت: ئایا لە نێوان دوو ئامێری هەمان تەکنەلۆژیایە یان بەراوردێکی تێکەڵە.

### 11.2 بۆچی هەندێک خانە بەتاڵن؟
چونکە بەهاکە بۆ ئەو بەرهەمە نەوتراوە. ئەو خانەیەی نەوتراوە لە ئەنجامەکەدا ناژمێردرێت و وەک سفر ناخوێنرێتەوە.

### 11.3 ڕیزبەندی بەراورد بڕیاری کڕینە؟
نەخێر. کورتەیەکی تایبەتمەندییە ڕاگەیەنراوەکانە. ئەوەی پابەندکەرە ئەوەیە کە لە لاپەڕەی بەرهەم و لە پسوولەکەدایە.

## 12. ئەو پرسیارانەی زۆرتر لەسەریان دەمەقاڵێ دەکرێت

### 12.1 بۆچی تێچووی گەیاندن لە ساتێکەوە بۆ ساتێکی تر گۆڕا؟
تێچووی گەیاندن ژمارەیەک نییە کە فرۆشگا دایبنێت، بەڵکو کۆمپانیای گەیاندن بەپێی شوێنی گەیشتن و کێش و قەبارە و دۆخی ڕێگا لە ڕۆژی ناردندا دیاری دەکات. ئەو ژمارەیەی لە کاتی پارەداندا پیشان دەدرێت ژمارەی هەمان ساتە، و بە گۆڕانی ناونیشان یان ناوەڕۆکی سەبەتە یان تەعریفەی کۆمپانیاکە دەگۆڕێت. سەرچاوە: بەڵگەنامەی گەیاندن، ماددەکانی 3.14 و 3.15.

### 12.2 دەتوانم سندوقەکە بکەمەوە پێش ئەوەی پارە بە گەیەنەر بدەم؟
لە بەردەرگادا دەتوانیت دڵنیا ببیت کە پاکێجەکە لە دەرەوە ساغە، و ژمارەی پارچەکان یەکدەگرن، و پاکێجی دەرەوە نەکراوەتەوە، لە ماوەی {{DOOR_INSPECTION_MINUTES}}. بەڵام کردنەوەی خودی بەرهەمەکە و کارپێکردنی پێش پارەدان مافێک نییە بەسەر گەیەنەرەوە، چونکە ئەو لایەنی فرۆشتنەکە نییە و بڕیاری تێدا نییە. ئەگەر دوای کردنەوە کەموکوڕی دەرکەوت، ڕێچکەکە گەڕاندنەوەیە لە ماوەی حەوت ڕۆژ لە گەیاندنەوە، یان گەرەنتی. سەرچاوە: بەڵگەنامەی کڕین، بەشی هەشتەم، و بەڵگەنامەی گەیاندن، ماددەی 3.27.

### 12.3 پاکێجەکە کراوە گەیشت چونکە خاڵێکی پشکنین لە سنووردا کردبووەوە، کێ بەرپرسە؟
کردنەوەی پاکێج لە خاڵێکی پشکنین یان لە سنووری هەرێمدا ڕێوشوێنێکە کە نە فرۆشگا و نە گواستنەوەکەر ناتوانن ڕێگری لێ بکەن، و لە خۆیدا کەموکوڕی لە بەرهەمەکەدا نییە. ئەوەی لە تۆ داوا دەکرێت ئەوەیە دۆخەکە بە وێنە لە بەردەرگا پێش واژووکردن تۆمار بکەیت، و لە ماوەی {{DAMAGE_REPORT_WINDOW_HOURS}} ڕاپۆرتی بکەیت؛ ئەگەر شتێک کەم بوو یان زیانی پێگەیشت لەسەر بنەمای زیانی کاتی گواستنەوە چارەسەر دەکرێت. واژووکردن بەبێ تێبینی و پاشان ڕاپۆرتکردن دوای چەند ڕۆژێک داواکارییەکە لاواز دەکات. سەرچاوە: بەڵگەنامەی گەیاندن، ماددەکانی 3.25 و 3.26 و 3.30، و بەڵگەنامەی گەڕاندنەوە، ماددەکانی 4.16 تا 4.19.

### 12.4 دەتوانم گەرەنتی درێژکراوە بکڕم دوای ئەوەی داواکاریم کرد؟
نەخێر. گەرەنتی درێژکراوە تەنها پێش جێگیرکردنی داواکارییەکە دەکڕدرێت، و لەسەر هەمان داواکاری بە باجەکەیەوە تۆمار دەکرێت. دوای کڕین و دوای گەیاندن و لە کاتی دەرکەوتنی تێکچووندا نافرۆشرێت، چونکە ئەو کاتە دەبێتە دڵنیایی لەسەر ڕووداوێک کە پێشتر ڕوویداوە. سەرچاوە: بەڵگەنامەی گەرەنتی درێژکراوە، ماددەی 6.2.

### 12.5 بۆچی ناتوانم لە کاتی وەرگرتندا پارەی بەرهەمێکی فرۆشگایەکی کۆمەڵگەیی بدەم؟
چونکە لەو ڕێچکەیەدا فرۆشیار بازرگانێکی سەربەخۆیە نەک فرۆشگا، و پارەکە لەناو پلاتفۆرمەکەدا گیراو دەمێنێتەوە تا داواکارییەکە تەواو دەبێت؛ ئەو گیرانە ئەوەیە کە هەردوو لایەن دەپارێزێت. ئەگەر لە بەردەرگا پارە بدرایە، پلاتفۆرمەکە هیچی نەدەما بیگرێت و هیچی نەدەما لە کاتی ناکۆکیدا بیگەڕێنێتەوە. بە هەمان هۆکار لەو ڕێچکەیەدا وەرگرتن لە کۆگا نییە. سەرچاوە: سیاسەتی کۆمەڵگەی لێڤۆ، ماددەکانی 7.5 و 7.6.

### 12.6 بۆچی سەبەتەکە بەرهەمێک لە فرۆشگایەکی تر ڕەت دەکاتەوە؟
چونکە یەک سەبەتە یەک فرۆشیار هەڵدەگرێت: یان فرۆشگای فەرمی لێڤۆنیس یان یەک بازرگانی کۆمەڵگە. هەر فرۆشیارێک ڕێگاکانی پارەدان و گەیاندنی خۆی و بەرپرسیارێتی و ماوەکانی خۆی هەیە، و تێکەڵکردنیان لە یەک سەبەتەدا یەک داواکاری دەخاتە ژێر یاسای دژبەیەک. چارەسەرەکە ئەوەیە داواکاری یەکەم تەواو بکەیت و پاشان سەبەتەیەکی نوێ دەست پێ بکەیت. سەرچاوە: بەڵگەنامەی کڕین، ماددەی 4.7، و سیاسەتی کۆمەڵگەی لێڤۆ، ماددەی 7.3.

### 12.7 جیاوازی نێوان فرۆشتنی ڕاستەوخۆ و داواکاری پێشوەختە چییە؟
فرۆشتنی ڕاستەوخۆ کاڵایەکە کە بەڕاستی هەیە و ئامادەیە بۆ ناردن، و نرخەکەی زیادەی فرۆشتنی ڕاستەوخۆ هەڵدەگرێت. داواکاری پێشوەختە کاڵایەکە کە دوای داواکارییەکەت دەهێنرێت، بۆیە نرخی کاڵاکەی کەمترە و کۆمیسیۆنی گواستنەوەی بۆ زیاد دەکرێت، و ماوەکەی بە سروشتی خۆی درێژترە. داواکاری پێشوەختە دوای جێگیرکردنی نابێتە فرۆشتنی ڕاستەوخۆ. سەرچاوە: بەڵگەنامەی کڕین، ماددەکانی 4.1 و 4.2 و 4.8 و 4.10.

### 12.8 بۆچی ناردنی دەریایی هەموو ئەو ماوەیە دەخایەنێت؟
چونکە خودی ڕێگای دەریایی درێژە: گرتنی کۆنتەینەرەکە، پاشان دەریاوانی، پاشان بارکردنەوە لە بەندەر، پاشان دەرکردنی گومرگی، پاشان گواستنەوەی وشکانی بۆ کۆگا، پاشان دابەشکردن. هەر قۆناغێک لەمانە ڕیزی خۆی هەیە کە فرۆشگا ناتوانێت کورتی بکاتەوە. بۆیە ڕێگای ئاسمانی و وشکانی و دەریایی بە ماوەی جیاواز و نرخی جیاواز پێشکەش دەکرێن، و هەموو ماوەکان خەمڵاندنن نەک بەڵێن. سەرچاوە: بەڵگەنامەی گەیاندن، ماددەکانی 3.8 و 3.9، و بەڵگەنامەی کڕین، ماددەکانی 4.3 و 4.4.

### 12.9 کەی پارەکەم بۆ جزدان دەگەڕێتەوە دوای هەڵوەشاندنەوەی داواکاری؟
ئەگەر داواکارییەکە پێشەکی لە جزدانەوە پارەی درابێت، بڕەکە لە کاتی تۆمارکردنی هەڵوەشاندنەوەکەدا بۆ جزدان دەگەڕێتەوە، لەگەڵ ئەو خاڵانەی لەسەر داواکارییەکە خەرج کرابوون، و خاڵە هەڵپەسێردراوەکانی هەڵدەوەشێنەوە. ئەگەر پارەکە گیراو بووبێت و هێشتا دانەنرابێت، گیرانەکە دەکرێتەوە و باڵانسەکە بەردەست دەبێتەوە. گەڕاندنەوەکە بۆ جزدانە نەک بە پارەی نەقد. سەرچاوە: بەڵگەنامەی کڕین، ماددەی 12.2، بەڵگەنامەی پارەدان، بەشی یازدەیەم، و بەڵگەنامەی خاڵ، ماددەکانی 3.9 و 11.6.

### 12.10 بۆچی جزدان دوو ژمارەی جیاواز پیشان دەدات؟
چونکە جزدان یەک ژمارە نییە: باڵانسی دانراو هەیە، کە هەموو ئەوەیە هاتووەتە ژوورەوە و چووەتە دەرەوە؛ بڕی گیراو هەیە، کە بۆ داواکارییەکی کراوە پابەند کراوە؛ و باڵانسی بەردەست هەیە، کە جیاوازی نێوان ئەو دووانەیە و تەنها ئەوە دەکرێت خەرج بکرێت. ئەگەر لە شوێنێکدا ژمارەیەکی گەورەتر و لە کاتی پارەداندا کەمتر ببینیت، هۆکارەکە زۆرجار بڕێکی گیراوە بۆ داواکارییەک کە هێشتا داخراو نەبووە. خاڵ باڵانسێکی سەربەخۆیە لە هەموو ئەمانە، بە بەشی هەڵپەسێردراو و جێگیری خۆیەوە. سەرچاوە: بەڵگەنامەی پارەدان، ماددەکانی 6.1 تا 6.7.

### 12.11 بۆچی خاڵی پێداچوونەوەم وەرگرت بەڵام دیارییەکم وەرنەگرت؟
چونکە دوو شتی جیاوازن. خاڵی پێداچوونەوە بە شێوەی خۆکار بۆ پێداچوونەوەی دەستیی دروست دەبەخشرێت لە هەمان ساتی پاراستنیدا. بەڵام دیاری بڕیارێکی سەربەخۆی فرۆشگایە؛ تەنها بە نووسینی پێداچوونەوەیەک نایەت، و پێداچوونەوە تەنها کاتێک دەچێتە ناوی کە بگاتە پلەیەکی جۆرایەتی پێوراو، و پاشان پەسەندکردن یان داواکردنی گۆڕانکاری یان ڕەتکردنەوە بە هۆکارێکی نووسراو لەسەری دەردەچێت. سەرچاوە: بەڵگەنامەی خاڵ و پێداچوونەوە، ماددەکانی 7.5 و 8.2.

## 13. حوکمە کۆتاییەکان

### 13.1 نوێکردنەوەی ئەم لاپەڕەیە
نوێ دەکرێتەوە بەبێ ئەوەی هیچ ماف یان ئەرکێکی لێ بکەوێتەوە، چونکە بەڵگەنامەیەکی پابەندکەر نییە.

### 13.2 بەڵگەنامە تەواوەکان لە کوێ دەدۆزمەوە؟
لە لاپەڕەی بەڵگەنامەکان لە ناو ماڵپەڕەکەدا، بە بەشەوە ڕێکخراون، و هەر بەڵگەنامەیەک بە وەشان و بەرواری کارپێکردنیەوە.`,
  },
};
