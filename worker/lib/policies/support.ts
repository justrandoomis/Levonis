import type { PolicyDocument } from './types';

/**
 * سياسة الدعم والتواصل والشكاوى — what a customer may ask support for, on
 * which channel, how fast, and the four things support will NOT do whatever
 * the ticket says.
 *
 * WHY CHAPTER 10 IS THE POINT OF THIS DOCUMENT. Every refusal a support agent
 * has to make — no, I cannot change that price; no, I cannot waive the seven
 * days; no, I cannot act on this because I cannot tell it came from you — is
 * a refusal the agent should be able to point at rather than improvise. The
 * codebase already enforces the third one: `supportRoutes` reads ONLY the
 * signed-in user's own rows, and a manipulated id (another customer's order)
 * gets the same not-found-in-your-account answer so existence is never
 * revealed. Articles 9.2 and 10.5 turn that behaviour into a stated rule, so
 * a caller who says "just tell me if order ORD-… is out for delivery" is
 * refused by the policy and not by the agent's judgement.
 *
 * WHAT THE CODE FIXES, AND THE ARTICLE THAT SAYS SO (worker/routes/support.ts):
 *  - The in-app assistant is DETERMINISTIC: a fixed intent allowlist resolved
 *    by button intents and per-language keyword dictionaries, with no model
 *    and no inference. Ambiguous input returns clarifying choices — NEVER a
 *    guess. Chapter 3 says exactly that, including article 3.5, because a
 *    customer who believes they spoke to a person, or to something that can
 *    promise, will quote it back in a dispute.
 *  - Ticket creation demands `confirm: true`; an accidental tap cannot file a
 *    ticket — article 6.2. Order and device references are ownership-checked
 *    server-side — article 6.4.
 *  - The four recorded states, and the fact that a customer reply on a
 *    resolved ticket HONESTLY REOPENS it rather than vanishing — articles 6.6
 *    and 6.8.
 *  - PRO priority is REAL: the queue orders by priority then by age, oldest
 *    first, and age stays visible precisely so an ordinary customer is not
 *    starved. Chapter 8 states both halves, because a priority that hides its
 *    own cost is the kind a customer finds out about the hard way.
 *  - RESTRICTIONS NEVER GATE SUPPORT. `RESTRICTABLE_BENEFITS` covers benefit
 *    computation only; support, warranty and data access are deliberately not
 *    restrictable. Article 2.7 says so, so a restricted account is never told
 *    it has lost the right to complain.
 *  - Staff identity stays internal — only the is_staff flag reaches the
 *    customer payload — which is article 13.4.
 *
 * NO NUMBER IS INVENTED. There is no response-time constant anywhere in this
 * codebase: the queue is ordered but not timed. Every target in chapter 7 is
 * therefore a placeholder for the owner to fill, and article 7.1 states that
 * the targets are targets and not guarantees, which is the only honest thing
 * a document can say about a queue worked by people.
 *
 * VERSION 2 — WHY IT MOVED. Two corrections a customer could see on the
 * page; the archive keeps version 1 byte for byte.
 *   * THE NAME. The store is written «Levonis», in Latin script, in all three
 *     languages. 2 transliterated occurrences left the body here.
 *   * THE UNKNOWNS. 13 articles and 19 further lines in this document still state a
 *     fact the owner has not given, so ./render.ts WITHHOLDS them from the published
 *     text rather than show a customer a `{{TOKEN}}`. They are still authored
 *     below, and each one returns of its own accord the moment its value is
 *     written in and the version moves again.
 *
 * VERSION 3 — WHY IT MOVED. The archive keeps version 2 byte for byte.
 *   * THE FACTS. worker/lib/policies/facts.ts now states `COMPETENT_COURT`, `GOVERNING_LAW_JURISDICTION`, `LEVONIS_SUPPORT_CONTACT`,
 *     so the clauses that carried them are published instead of withheld.
 *   * NO POINTER TO NOTHING. ./render.ts now also withholds a line that cites,
 *     by number, an article of this document that is itself withheld.
 */
export const support: PolicyDocument = {
  key: 'support',
  version: 3,
  effective_at: '2026-09-23',
  title: {
    ar: 'سياسة الدعم والتواصل والشكاوى',
    en: 'Support, Contact and Complaints Policy',
    ckb: 'سیاسەتی پشتگیری و پەیوەندی و سکاڵا',
  },
  body: {
    ar: `## 1. التمهيد والنطاق والتعريفات

### 1.1 الغرض من هذه الوثيقة
تبيّن هذه الوثيقة قنوات الدعم المعتمدة في Levonis، وأوقات العمل، وما ينبغي أن يكون جاهزاً لدى الزبون قبل التواصل، ومواعيد الرد والحل المستهدفة، وكيف تُصعَّد الشكوى، وكيف يُعالج النزاع مع تاجر في مجتمع ليفو، وما لا يفعله الدعم مهما طُلب منه.

### 1.2 الأطراف
المتجر: {{LEVONIS_LEGAL_NAME}}، المسجل برقم {{LEVONIS_REGISTRATION_NO}}، وعنوانه {{LEVONIS_ADDRESS}}. والزبون: صاحب الحساب أو من يتواصل مع المتجر بشأن طلب أو منتج.

### 1.3 التعريفات
- الدعم: الجهاز الذي يتولى في المتجر الرد على استفسارات الزبائن ومعالجة شكاواهم.
- القناة المعتمدة: وسيلة تواصل يعترف بها المتجر في هذه الوثيقة، وما عداها غير معتمد.
- المساعد: الأداة داخل التطبيق التي تجيب عن أسئلة محددة سلفاً من بيانات حساب الزبون نفسه.
- التذكرة: سجل مكتوب لطلب أو شكوى، له رقم وحالة وتاريخ ورسائل.
- حالة التذكرة: مرحلتها المسجلة في النظام.
- الأولوية: ترتيب التذكرة في قائمة العمل.
- الشكوى: تظلم من قرار أو من خدمة أو من سلوك.
- النزاع: خلاف بين الزبون وتاجر في مجتمع ليفو على طلب قائم.
- التصعيد: إحالة الشكوى إلى مستوى أعلى في المتجر بعد استنفاد المستوى الأول.
- طلب لا يمكن التحقق منه: طلب لا يستطيع المتجر أن يتثبت أنه صادر عن صاحب الحساب نفسه.

### 1.4 النص المعتمد
النص العربي هو النص المعتمد، والإنكليزي والكردي ترجمتان أمينتان له بالترقيم نفسه. وعند الاختلاف يُرجع إلى العربي.

### 1.5 نطاق هذه الوثيقة
تنظم هذه الوثيقة التواصل والمعالجة الإجرائية. أما مضمون الحق نفسه — إرجاعاً أو ضماناً أو توصيلاً أو دفعاً أو عضوية — فمرجعه وثيقته الخاصة، ولا تنشئ هذه الوثيقة حقاً موضوعياً ولا تلغيه.

### 1.6 من يخاطبه الدعم
يخاطب الدعم صاحب الحساب. ومن تواصل بلا حساب أُجيب في حدود ما لا يكشف بيانات حساب أحد.

## 2. قنوات الدعم المعتمدة

### 2.1 القنوات
- المساعد داخل التطبيق.
- تذاكر الدعم داخل الحساب.
- قناة التواصل المعلنة: {{LEVONIS_SUPPORT_CONTACT}}.

### 2.2 القناة الرسمية للأثر
التذكرة داخل الحساب هي القناة التي يُعتد بها في إثبات تاريخ الطلب ومضمونه. وما جرى على قناة أخرى يُنقل إلى تذكرة ليُعتد به.

### 2.3 لا قناة خارج المعلن
المتجر غير مسؤول عن حساب أو رقم أو صفحة تنتحل اسمه. ولا يُعتد بوعد ولا بقرار صدر من غير القنوات المعلنة في المادة 2.1.

### 2.4 مراسلة التاجر
مراسلة تاجر في مجتمع ليفو تجري داخل المنصة، وتحكمها أحكام المحادثات في سياسة مجتمع ليفو. ولا تُعد مراسلة التاجر مراسلةً للمتجر.

### 2.5 رسائل الخدمة
رسائل الخدمة عن الحساب والطلب والدفع والضمان تُرسل على القنوات المثبتة للحساب: بريد موثَّق، أو رقم أُثبتت ملكيته، أو ربط تلغرام قائم. وليست هذه رسائل تسويقية ولا يمنعها إيقاف التسويق.

### 2.6 القناة التي لا يحملها النظام
إذا لم يكن المتجر قادراً على حمل قناة في وقت ما، لم يُوعَد الزبون بها، وأُبلغ بالسبب بدلاً من إرسال لا يصل.

### 2.7 الدعم لا يُقيَّد
القيود الإدارية على الحساب تمس حساب المزايا وحده. ولا تُقيَّد بها مخاطبة الدعم ولا المطالبة بالضمان ولا الوصول إلى بيانات الحساب. فالحساب المقيَّد يشكو كغيره.

### 2.8 لغة التواصل
يُخاطَب الزبون بالعربية أو الإنكليزية أو الكردية بحسب اختياره، ويُجاب بلغته حيثما أمكن.

## 3. المساعد داخل التطبيق

### 3.1 طبيعته
المساعد أداة محدَّدة السلوك: يجيب عن قائمة مغلقة من الأسئلة بقواعد ثابتة. وليس شخصاً، وليس نظام ذكاء اصطناعي، ولا يستنتج ولا يخمّن.

### 3.2 ما يجيب عنه
حالة الطلب، وتقدير التوصيل، وأجهزة الزبون، وحالة الضمان، ورصيد النقاط، وحالة العضوية، والمساعدة في الإرجاع، والمساعدة في كلمة المرور، والبحث عن منتج، والسؤال عن السياسات، وفتح تذكرة، والتحويل إلى موظف.

### 3.3 مصدر جوابه
لا يقرأ المساعد إلا بيانات الحساب الداخل، والكتالوج العام، والسياسات المنشورة. ولا يبلغ الزبون بشيء عن حساب غيره.

### 3.4 عند الغموض
إذا لم يتبيّن المقصود عرض المساعد خيارات للتوضيح. ولا يجيب بجواب محتمل، لأن جواباً خاطئاً في حالة طلب أسوأ من سؤال إضافي.

### 3.5 قيمة جواب المساعد
جواب المساعد بيان بحالة مسجلة، وليس وعداً ولا قراراً ولا تنازلاً عن شرط في وثيقة. وما يخالف وثائق المتجر منه لا يُعتد به.

### 3.6 التقديرات
ما يعرضه المساعد من مدد التوصيل تقدير مبني على حالة الطلب المسجلة، وتسري عليه المادة الخاصة بتقديرية المدد في وثيقة التوصيل.

### 3.7 التحويل إلى موظف
للزبون في أي وقت أن يطلب التحويل إلى موظف، فتُفتح له تذكرة وفق الفصل السادس.

### 3.8 حدود المساعد
لا ينفّذ المساعد إلغاء طلب، ولا استرداد مال، ولا تعديل عنوان، ولا قراراً في إرجاع أو ضمان. وهذه كلها مسارات لها وثائقها وقراراتها.

## 4. أوقات العمل والتغطية

### 4.1 أوقات العمل
أوقات عمل الدعم: {{LEVONIS_SUPPORT_HOURS}}.

### 4.2 خارج أوقات العمل
تُستقبل التذاكر في كل وقت، وتُعالج في أول وقت عمل تالٍ.

### 4.3 العطل الرسمية
تُعد أيام العطل الرسمية أيام عمل غير محتسبة في المدد المستهدفة، ما لم يُعلن المتجر غير ذلك.

### 4.4 أوقات الاستلام من المخزن
أوقات الحضور إلى المخزن: {{LEVONIS_PICKUP_HOURS}}، وعنوانه {{LEVONIS_WAREHOUSE_ADDRESS}}. وأوقات مركز الخدمة {{LEVONIS_SERVICE_ADDRESS}}.

### 4.5 الانقطاع الطارئ
عند انقطاع تقني أو ظرف خارج الإرادة يُعلن المتجر ذلك على القنوات المعلنة، وتمتد المدد المستهدفة بقدر مدة الانقطاع.

## 5. ما يجب أن يكون جاهزاً لدى الزبون

### 5.1 في كل تواصل
- رقم الطلب.
- البريد أو الرقم المثبت على الحساب.
- بيان واضح للمشكلة ومتى وقعت.

### 5.2 في شكوى توصيل
تاريخ التسليم المسجل، واسم المستلم إن استلم غيره، وصور الطرد من الخارج ومن الداخل، وأي محضر أو ملاحظة من الناقل.

### 5.3 في طلب إرجاع
سبب الإرجاع، وصور المنتج والعيب والتغليف الداخلي والخارجي والرقم التسلسلي، وفيديو إن كان العيب سلوكاً لا يظهر في صورة.

### 5.4 في مطالبة ضمان
الرقم التسلسلي للوحدة، وتاريخ التسليم المسجل، ووصف العطل وتاريخ ظهوره، وما جرى قبل ظهوره.

### 5.5 في مسألة دفع أو محفظة
تاريخ العملية ومبلغها، ورقم الطلب المرتبط بها، وصورة الإيصال إن كان إيداعاً.

### 5.6 في شكوى على تاجر
رقم الطلب المجتمعي، ونسخة من الاتفاق داخل المنصة، والأدلة على ما وقع.

### 5.7 ما لا يُطلب من الزبون
لا يطلب الدعم كلمة المرور، ولا رمز تحقق، ولا صورة بطاقة بنكية كاملة، ولا رمز دخول. ومن طلب ذلك باسم المتجر فهو منتحل، ويُبلَّغ عنه فوراً.

### 5.8 أثر نقص المعلومات
نقص ما تقدّم لا يمنع فتح التذكرة، لكنه يؤخر معالجتها، ولا تُحتسب مدة الانتظار على المتجر في المدة اللازمة لاستكمال المعلومات.

## 6. التذاكر

### 6.1 من يفتح التذكرة
يفتح التذكرة صاحب الحساب من داخل حسابه.

### 6.2 التأكيد قبل الفتح
لا تُفتح التذكرة إلا بتأكيد صريح من الزبون، حتى لا تنشأ تذكرة عن ضغطة غير مقصودة.

### 6.3 حدود النص
عنوان التذكرة لا يقل عن ثلاثة أحرف ولا يزيد على مئتين، ونص الرسالة لا يقل عن خمسة أحرف ولا يزيد على أربعة آلاف. وعدد التذاكر والرسائل التي تُرسل من الحساب الواحد محدود في الساعة.

### 6.4 ربط التذكرة بطلب أو جهاز
يجوز ربط التذكرة برقم طلب أو برقم جهاز، ولا يُقبل الربط إلا إذا كان الطلب أو الجهاز مسجلاً في حساب صاحب التذكرة نفسه.

### 6.5 تعدد التذاكر
تُفتح تذكرة لكل موضوع. وجمع موضوعات متباينة في تذكرة واحدة يؤخر الجميع.

### 6.6 حالات التذكرة
- مفتوحة: سُجّلت ولم تُسند بعد.
- بانتظار الزبون: الدعم طلب معلومة ولم تصل.
- بانتظار الموظف: لدى الدعم ما يردّ عليه.
- منتهية: صدر فيها جواب أو قرار.

### 6.7 انتظار الزبون
إذا بقيت التذكرة بانتظار الزبون بلا رد مدة {{TICKET_CUSTOMER_WAIT_DAYS}} جاز إنهاؤها إدارياً، ولصاحبها إعادة فتحها بالرد عليها.

### 6.8 إعادة الفتح
رد الزبون على تذكرة منتهية يعيد فتحها ويجعلها بانتظار الموظف. ولا تُبتلع رسالته ولا تُهمَل.

### 6.9 سجل التذكرة
تبقى رسائل التذكرة مسجلة بتواريخها، ويستطيع صاحبها الاطلاع عليها من حسابه.

### 6.10 القرار مكتوب
كل قرار في تذكرة يُكتب في التذكرة نفسها بسببه، ولا يُكتفى بجواب شفهي على قناة أخرى.

### 6.11 إغلاق التذكرة لا يسقط الحق
إنهاء التذكرة إجراء تنظيمي، ولا يسقط حقاً ثابتاً في وثيقة أخرى ما دامت مدته قائمة.

## 7. الرد والمدد المستهدفة

### 7.1 طبيعة المدد
المدد الواردة في هذا الفصل مستهدفة لا مضمونة، لأن القائمة يعمل عليها أشخاص. ويلتزم المتجر ببذل ما يلزم لبلوغها، ويعلن سبب التأخر إذا تجاوزها.

### 7.2 أول رد
يُستهدف أول رد خلال {{SUPPORT_FIRST_RESPONSE_HOURS}} من فتح التذكرة داخل أوقات العمل.

### 7.3 أول رد لأعضاء PRO
يُستهدف أول رد لعضو PRO خلال {{PRO_PRIORITY_RESPONSE_HOURS}}.

### 7.4 مدة الحل
يُستهدف حسم المسألة البسيطة خلال {{SUPPORT_RESOLUTION_TARGET_DAYS}}. وما احتاج فحصاً فنياً أو مراجعة ناقل أو مورد يأخذ مدته المبيّنة في وثيقته.

### 7.5 مسارات لها مددها الخاصة
- طلب الإرجاع: وثيقة الاسترجاع والاستبدال.
- مطالبة الضمان: وثيقة الضمان، ومددها {{WARRANTY_CLAIM_DIAGNOSIS_DAYS}} و{{WARRANTY_CLAIM_TURNAROUND_DAYS}}.
- مراجعة الإيداع: {{DEPOSIT_REVIEW_HOURS}}.
- تنفيذ السحب: {{WITHDRAWAL_PAYOUT_DAYS}}.
- دعوى السعر: {{PRICE_CLAIM_DECISION_DAYS}}.
- الفصل في نزاع مجتمعي: {{DISPUTE_RESPONSE_DAYS}}.

### 7.6 وقف المدة
تقف المدة المستهدفة مدة انتظار معلومة أو مستند من الزبون، ومدة انتظار جواب ناقل أو مورد أو جهة رسمية، وتستأنف عند وصولها.

### 7.7 الإبلاغ بالتأخر
إذا تعذّر بلوغ المدة المستهدفة أُبلغ الزبون بذلك وبسببه وبالموعد الجديد، ولا يُترك بلا جواب.

## 8. الأولوية وعدالة الدور

### 8.1 أساس الترتيب
تُرتَّب قائمة العمل بالأولوية أولاً، ثم بالأقدم فالأقدم داخل كل مستوى.

### 8.2 من له الأولوية
تُثبَّت الأولوية للتذكرة عند فتحها لعضو PRO النافذة عضويته الذي لا يوجد عليه قيد إداري يوقف ميزة الأولوية.

### 8.3 الأولوية مثبتة عند الفتح
تُثبَّت الأولوية لحظة فتح التذكرة، ولا تتغير بتغير العضوية بعد ذلك.

### 8.4 لا تجويع لغير الأعضاء
يبقى عمر التذكرة ظاهراً أمام الدعم، والتذكرة القديمة لا تُترك خلف تذاكر أحدث ذات أولوية إلى غير نهاية.

### 8.5 الاستعجال بغير سبب
تكرار فتح التذاكر عن الموضوع نفسه لا يقدّم الدور، وقد يؤخره بتشتيت المعالجة.

### 8.6 الحالات الحرجة
للدعم تقديم ما يمس سلامة شخص أو مالاً محجوزاً أو موعداً ينقضي، أياً كانت عضوية صاحبه.

## 9. التحقق من صاحب الطلب

### 9.1 القاعدة
لا يُنفَّذ طلب يمس حساباً أو طلباً أو مالاً إلا بعد التثبت من أنه صادر عن صاحب الحساب.

### 9.2 كيف يتحقق المتجر
يُعتمد على أن الطلب ورد من داخل الحساب بعد الدخول إليه. وما ورد من خارجه يُطلب من صاحبه أن يعيده من داخل حسابه.

### 9.3 لا كشف عن وجود حساب
لا يؤكد المتجر ولا ينفي وجود حساب أو طلب لمن لم يثبت أنه صاحبه. ويُجاب السائل الجواب نفسه في الحالين.

### 9.4 بيانات الغير
لا يُعطى أحد بيانات طلب غيره ولا عنوانه ولا رقمه، ولو كان قريباً له أو دافعاً عنه.

### 9.5 من استلم نيابة
استلام شخص آخر نيابة عن الزبون تحكمه وثيقة التوصيل، ولا يعطي المستلم حق مخاطبة الدعم عن الطلب.

### 9.6 الطلب المشبوه
إذا قامت قرينة على أن الطلب ليس من صاحب الحساب، أُوقف تنفيذه وأُبلغ صاحب الحساب على قناته المثبتة.

### 9.7 الحساب المخترق
من رأى نشاطاً لا يعرفه على حسابه أبلغ الدعم فوراً، وتُتخذ إجراءات وثيقة التسجيل. ولا يستطيع المتجر استرجاع ما نُفِّذ فعلاً قبل الإبلاغ.

## 10. ما لا يفعله الدعم

### 10.1 لا يغيّر سعراً
لا يغيّر الدعم سعر منتج ولا سعر طلب، ولا يمنح خصماً لم ينشأ من قاعدة معلنة. وما يتعلق بتغيّر السعر أو تصحيحه مرجعه وثيقة الشراء ووثيقة حماية السعر.

### 10.2 لا يتنازل عن شرط
لا يُسقط الدعم شرطاً في وثيقة ولا يمدّ مدة انقضت — كمدة الإرجاع أو شرط شراء الضمان الممتد قبل الطلب — ولو رأى الحالة جديرة. والاستثناء لا يكون إلا بقرار مكتوب من المستوى المخوَّل.

### 10.3 لا ينفّذ طلباً لا يمكن التحقق منه
لا يُنفَّذ تغيير عنوان ولا إلغاء طلب ولا تحويل رصيد ولا إفشاء بيان بناءً على رسالة لا يمكن التثبت من صدورها عن صاحب الحساب.

### 10.4 لا يعد بما لا يملكه النظام
لا يعد الدعم بإعادة نقدية حيث يكون الرد إلى المحفظة، ولا بموعد توصيل قاطع، ولا بتوفر منتج غير مضمون التوفر، ولا بقبول إرجاع قبل الفحص.

### 10.5 لا يكشف عن حساب غير حساب المخاطب
ولو كان السؤال بسيطاً في ظاهره، مثل التحقق من أن رقم طلب موجود.

### 10.6 لا يطلب سرّاً
لا يطلب الدعم كلمة مرور ولا رمز تحقق ولا رمز دخول، ولا يطلب تحويلاً إلى حساب شخصي لموظف.

### 10.7 لا يتوسط خارج المنصة
لا يعتمد الدعم اتفاقاً جرى بين زبون وتاجر خارج المنصة، ولا يفصل فيه.

### 10.8 لا يصلح بيد الزبون
لا يوجّه الدعم الزبون إلى فتح جهاز تحت الضمان ولا إلى إصلاحه بنفسه، لأن ذلك يُسقط الضمان وفق وثيقة الضمان.

### 10.9 حدود الصلاحية
ما جاوز صلاحية الموظف يُحال إلى المستوى الأعلى وفق الفصل الحادي عشر، ولا يُجاب بوعد لا يملكه.

## 11. تصعيد الشكوى

### 11.1 المستوى الأول
يُعرض الأمر أولاً على الدعم بتذكرة، ويُنتظر جوابه خلال المدة المستهدفة.

### 11.2 التصعيد
إن لم يَرْضَ الزبون الجواب، أو تجاوز الرد مدته، طلب التصعيد في التذكرة نفسها، فتُحال إلى المستوى الأعلى.

### 11.3 مدة التصعيد
يُستهدف البتّ في الشكوى المصعَّدة خلال {{SUPPORT_ESCALATION_DAYS}}.

### 11.4 ما يجب أن تتضمنه الشكوى
رقم التذكرة، وبيان القرار المعترض عليه، وسبب الاعتراض، وما يطلبه الزبون على وجه التحديد.

### 11.5 القرار في الشكوى
يصدر القرار مكتوباً بسببه، ويُبيَّن فيه ما قُبل وما رُفض ولماذا.

### 11.6 التظلم من إجراء على الحساب
التظلم من تقييد أو إيقاف يُقدَّم خلال {{ACCOUNT_APPEAL_DAYS}} وفق وثيقة التسجيل.

### 11.7 حق اللجوء إلى القضاء
لا يمنع هذا المسار الزبون من اللجوء إلى الجهة المختصة وفق المادة 14.4.

## 12. النزاع مع تاجر في مجتمع ليفو

### 12.1 موضع الفصل
النزاع بين الزبون والتاجر يُعرض داخل المنصة، ويحكمه الفصل الخاص بالنزاعات في سياسة مجتمع ليفو، وهذه الوثيقة تبيّن مسار التواصل لا مضمون الحكم.

### 12.2 دور المتجر
المتجر في هذا المسار وسيط يفصل بين طرفين بالأدلة، وليس بائعاً للبضاعة المجتمعية. والبائع هو التاجر، وعليه التزاماته.

### 12.3 أثر فتح النزاع على المال
فتح النزاع يبقي المال المحجوز محجوزاً حتى الفصل، ولا يُصرف لأحد الطرفين قبله.

### 12.4 الأدلة
يُفصل بما هو مسجل: المحادثة داخل المنصة، ووصف العرض، والصور، وحالة الطلب، وسجل التسليم.

### 12.5 الاتفاق خارج المنصة
ما جرى خارج المنصة لا يُعتد به في الفصل، ولا يستطيع المتجر حمايته.

### 12.6 مدة الفصل
يُستهدف الفصل خلال {{DISPUTE_RESPONSE_DAYS}}، وتُوقَف المدة مدة انتظار رد أحد الطرفين، ومهلة رد التاجر {{MERCHANT_REPLY_WINDOW_HOURS}}.

### 12.7 التاجر الذي لا يرد
إذا لم يرد التاجر خلال {{MERCHANT_UNRESPONSIVE_DAYS}} فُصل في النزاع بما لدى المتجر من أدلة.

### 12.8 نتيجة الفصل
يصدر القرار مكتوباً بسببه، ويُنفَّذ على المال المحجوز، ويقيَّد أثره على تقييم التاجر وفق سياسة مجتمع ليفو.

### 12.9 الشكوى الكيدية
الشكوى التي يتبيّن كيدها تُرد، ويُتخذ في شأن صاحبها ما يناسب وفق وثيقة التسجيل.

## 13. سلوك الطرفين

### 13.1 احترام متبادل
يُخاطَب الزبون باحترام، ويخاطب الزبون موظفي المتجر وتجار المجتمع بمثله.

### 13.2 ما لا يُحتمل
السبّ والتهديد والابتزاز والتمييز والتحرش وإفشاء بيانات الغير. وللمتجر إنهاء المخاطبة في حينها وتسجيل الواقعة.

### 13.3 الإغراق
إغراق القنوات برسائل متكررة أو بطلبات آلية يُعامل معاملة إساءة الاستعمال، وللمتجر تقييد معدل الإرسال.

### 13.4 هوية الموظف
لا يُفصح للزبون عن هوية الموظف الشخصية، حمايةً له. ويكفي في المخاطبة رقم التذكرة، وللمتجر مساءلة موظفه داخلياً.

### 13.5 تسجيل المخاطبات
تُسجَّل المخاطبات وتُحفظ وفق سياسة الخصوصية وحماية البيانات ومدد الحفظ المبيّنة فيها.

### 13.6 استعمال جواب الدعم
جواب الدعم موجَّه إلى صاحب التذكرة في واقعته، ولا يُعد سابقة عامة ولا يُحتج به في واقعة أخرى.

## 14. أحكام ختامية

### 14.1 التعديل
للمتجر تعديل هذه الوثيقة بإصدار نسخة جديدة برقم وتاريخ نفاذ، ولا يسري التعديل بأثر رجعي على تذكرة قائمة.

### 14.2 الأولوية عند التعارض
إذا تعارض نص هذه الوثيقة مع وعد شفهي أو رسالة من موظف أو منشور تسويقي، فنص هذه الوثيقة هو المعتمد. وإذا تعارض مع وثيقة موضوعية في مضمون حق، فالوثيقة الموضوعية هي المعتمدة في مضمونه.

### 14.3 استقلال البنود
بطلان بند لا يمس صحة سائر البنود.

### 14.4 القانون والاختصاص
تحكم هذه الوثيقة {{GOVERNING_LAW_JURISDICTION}}، والاختصاص بالنزاع ل{{COMPETENT_COURT}}.

### 14.5 التواصل
قناة التواصل المعتمدة: {{LEVONIS_SUPPORT_CONTACT}}، في أوقات {{LEVONIS_SUPPORT_HOURS}}. والعنوان: {{LEVONIS_ADDRESS}}.`,

    en: `## 1. Preamble, Scope and Definitions

### 1.1 Purpose of this document
This document sets out the approved support channels at Levonis, the working hours, what the customer should have ready before making contact, the targeted response and resolution times, how a complaint is escalated, how a dispute with a Levo Community merchant is handled, and what support will not do however it is asked.

### 1.2 The parties
The Store: {{LEVONIS_LEGAL_NAME}}, registered under number {{LEVONIS_REGISTRATION_NO}}, at {{LEVONIS_ADDRESS}}. The Customer: the account holder, or whoever contacts the Store about an order or a product.

### 1.3 Definitions
- Support: the function within the Store that answers customers' enquiries and handles their complaints.
- Approved channel: a means of contact recognised by the Store in this document; anything else is not approved.
- The assistant: the tool inside the application that answers predetermined questions from the customer's own account data.
- Ticket: a written record of a request or a complaint, with a number, a state, a date and messages.
- Ticket state: its recorded stage in the system.
- Priority: the ticket's ordering in the work queue.
- Complaint: a grievance about a decision, a service or conduct.
- Dispute: a disagreement between a customer and a Levo Community merchant over a live order.
- Escalation: the referral of a complaint to a higher level in the Store after the first level is exhausted.
- An unverifiable request: a request the Store cannot establish came from the account holder themselves.

### 1.4 The authoritative text
The Arabic text is the authoritative text; the English and Kurdish are faithful translations of it with the same numbering. In case of divergence the Arabic governs.

### 1.5 The scope of this document
This document regulates contact and procedural handling. The substance of the right itself — a return, a warranty, a delivery, a payment or a membership — is governed by its own document, and this document neither creates nor extinguishes a substantive right.

### 1.6 Whom support addresses
Support addresses the account holder. A person contacting the Store without an account is answered only within limits that disclose nobody's account data.

## 2. The approved support channels

### 2.1 The channels
- The assistant inside the application.
- Support tickets inside the account.
- The published channel of contact: {{LEVONIS_SUPPORT_CONTACT}}.

### 2.2 The channel of record
The ticket inside the account is the channel relied upon to establish the date and the content of a request. Anything that happened on another channel is carried into a ticket in order to be relied upon.

### 2.3 No channel outside the published ones
The Store is not responsible for an account, a number or a page impersonating its name. No promise and no decision issued outside the channels published in article 2.1 is relied upon.

### 2.4 Corresponding with a merchant
Correspondence with a Levo Community merchant takes place inside the platform and is governed by the conversation provisions of the Levo Community Policy. Corresponding with the merchant is not corresponding with the Store.

### 2.5 Service messages
Service messages about the account, the order, payment and warranty are sent on the channels verified for the account: a verified email address, a number whose ownership was proven, or a live Telegram link. These are not marketing messages and switching marketing off does not stop them.

### 2.6 A channel the system cannot carry
Where the Store is unable to carry a channel at a given time, the customer is not promised it, and is told the reason instead of being sent something that will not arrive.

### 2.7 Support is never restricted
Administrative restrictions on an account touch benefit computation alone. They never restrict addressing support, claiming under warranty, or access to account data. A restricted account complains like any other.

### 2.8 The language of contact
The customer is addressed in Arabic, English or Kurdish according to their choice, and is answered in their language wherever possible.

## 3. The assistant inside the application

### 3.1 Its nature
The assistant is a tool of defined behaviour: it answers a closed list of questions by fixed rules. It is not a person, it is not an artificial-intelligence system, and it neither infers nor guesses.

### 3.2 What it answers
Order status, delivery estimate, the customer's devices, warranty status, points balance, membership status, help with a return, help with a password, product search, a question about the policies, opening a ticket, and handover to a member of staff.

### 3.3 The source of its answer
The assistant reads only the signed-in account's own data, the public catalogue and the published policies. It tells the customer nothing about anyone else's account.

### 3.4 On ambiguity
Where the intended meaning is not clear, the assistant offers choices for clarification. It does not answer with a probable answer, because a wrong answer about an order is worse than an additional question.

### 3.5 The weight of the assistant's answer
The assistant's answer is a statement of a recorded state, and is not a promise, a decision or a waiver of a condition in a document. Anything in it that contradicts the Store's documents is not relied upon.

### 3.6 Estimates
Delivery periods shown by the assistant are an estimate built on the recorded state of the order, and the article on the estimative nature of periods in the Delivery document applies to them.

### 3.7 Handover to a member of staff
The customer may at any time ask for handover to a member of staff, and a ticket is opened for them under chapter 6.

### 3.8 The limits of the assistant
The assistant does not cancel an order, refund money, change an address, or take a decision on a return or a warranty. Each of these is a path with its own documents and its own decisions.

## 4. Working hours and coverage

### 4.1 Working hours
Support working hours: {{LEVONIS_SUPPORT_HOURS}}.

### 4.2 Outside working hours
Tickets are received at all times and are handled at the first following working hours.

### 4.3 Public holidays
Official public holidays are treated as non-working days and are not counted in the targeted periods, unless the Store announces otherwise.

### 4.4 Warehouse collection hours
Attendance hours at the warehouse: {{LEVONIS_PICKUP_HOURS}}, at {{LEVONIS_WAREHOUSE_ADDRESS}}. The service centre is at {{LEVONIS_SERVICE_ADDRESS}}.

### 4.5 An emergency interruption
Upon a technical interruption or a circumstance beyond control, the Store announces it on the published channels, and the targeted periods are extended by the length of the interruption.

## 5. What the customer should have ready

### 5.1 On every contact
- The order number.
- The email address or number verified on the account.
- A clear statement of the problem and when it occurred.

### 5.2 On a delivery complaint
The recorded delivery date, the name of the recipient if someone else received it, photographs of the parcel outside and inside, and any record or note from the carrier.

### 5.3 On a return request
The reason for the return, photographs of the product, the defect, the inner and outer packaging and the serial number, and a video where the defect is a behaviour that does not appear in a photograph.

### 5.4 On a warranty claim
The unit's serial number, the recorded delivery date, a description of the fault and the date it appeared, and what happened before it appeared.

### 5.5 On a payment or wallet matter
The date and amount of the transaction, the order number connected to it, and an image of the receipt where it is a deposit.

### 5.6 On a complaint against a merchant
The community order number, a copy of the agreement inside the platform, and the evidence of what occurred.

### 5.7 What is never asked of the customer
Support does not ask for a password, a verification code, a full image of a bank card, or a sign-in code. Anyone asking for these in the Store's name is an impersonator and is to be reported immediately.

### 5.8 The effect of missing information
Missing any of the above does not prevent a ticket from being opened, but it delays its handling, and the waiting period for the information to be completed is not counted against the Store.

## 6. Tickets

### 6.1 Who opens a ticket
The account holder opens the ticket from inside their account.

### 6.2 Confirmation before opening
A ticket is not opened without an express confirmation from the customer, so that a ticket does not arise from an unintended tap.

### 6.3 Text limits
A ticket subject is not less than three characters and not more than two hundred, and the message text not less than five characters and not more than four thousand. The number of tickets and messages sent from one account is limited per hour.

### 6.4 Linking a ticket to an order or a device
A ticket may be linked to an order number or a device number, and the link is accepted only where the order or the device is recorded in the ticket holder's own account.

### 6.5 Multiple tickets
A ticket is opened for each subject. Gathering unrelated subjects in one ticket delays them all.

### 6.6 Ticket states
- Open: recorded and not yet assigned.
- Waiting for the customer: support asked for information which has not arrived.
- Waiting for staff: support has something to answer.
- Resolved: an answer or a decision has issued upon it.

### 6.7 Waiting for the customer
Where a ticket remains waiting for the customer with no reply for {{TICKET_CUSTOMER_WAIT_DAYS}}, it may be closed administratively, and its holder may reopen it by replying to it.

### 6.8 Reopening
A customer's reply on a resolved ticket reopens it and puts it in waiting for staff. Their message is neither swallowed nor ignored.

### 6.9 The ticket record
The ticket's messages remain recorded with their dates, and its holder can consult them from their account.

### 6.10 The decision is written
Every decision on a ticket is written in that ticket with its reason; an oral answer on another channel does not suffice.

### 6.11 Closing a ticket does not extinguish a right
Resolving a ticket is an organisational step and does not extinguish a right established in another document while that right's period is still running.

## 7. Responses and targeted periods

### 7.1 The nature of the periods
The periods in this chapter are targets and not guarantees, because the queue is worked by people. The Store undertakes to do what is needed to meet them, and states the reason for a delay where it exceeds them.

### 7.2 First response
A first response is targeted within {{SUPPORT_FIRST_RESPONSE_HOURS}} of the ticket being opened, within working hours.

### 7.3 First response for PRO members
A first response for a PRO member is targeted within {{PRO_PRIORITY_RESPONSE_HOURS}}.

### 7.4 Resolution period
A simple matter is targeted for resolution within {{SUPPORT_RESOLUTION_TARGET_DAYS}}. A matter requiring a technical inspection or a reference to a carrier or a supplier takes the period stated in its own document.

### 7.5 Paths with their own periods
- A return request: the Returns and Exchange document.
- A warranty claim: the Warranty document, with its periods {{WARRANTY_CLAIM_DIAGNOSIS_DAYS}} and {{WARRANTY_CLAIM_TURNAROUND_DAYS}}.
- Review of a deposit: {{DEPOSIT_REVIEW_HOURS}}.
- Execution of a withdrawal: {{WITHDRAWAL_PAYOUT_DAYS}}.
- A price claim: {{PRICE_CLAIM_DECISION_DAYS}}.
- Determination of a community dispute: {{DISPUTE_RESPONSE_DAYS}}.

### 7.6 Suspension of the period
The targeted period is suspended while information or a document is awaited from the customer, and while an answer is awaited from a carrier, a supplier or an official body, and resumes when it arrives.

### 7.7 Notice of delay
Where the targeted period cannot be met, the customer is told of that, of its reason and of the new date, and is not left without an answer.

## 8. Priority and fairness of turn

### 8.1 The basis of the ordering
The work queue is ordered by priority first, then oldest first within each level.

### 8.2 Who has priority
Priority is fixed on a ticket at its opening for a PRO member whose membership is in force and against whom there is no live administrative restriction suspending the priority benefit.

### 8.3 Priority is fixed at opening
Priority is fixed at the moment the ticket is opened and does not change with a later change of membership.

### 8.4 No starvation of non-members
The age of a ticket remains visible to support, and an older ticket is not left behind newer priority tickets indefinitely.

### 8.5 Urging without cause
Repeatedly opening tickets about the same subject does not advance the turn, and may delay it by fragmenting the handling.

### 8.6 Critical cases
Support may advance a matter touching a person's safety, money held, or a period about to expire, whatever the membership of its holder.

## 9. Verifying the person making the request

### 9.1 The rule
A request touching an account, an order or money is not executed until it is established that it came from the account holder.

### 9.2 How the Store verifies
Reliance is placed on the request having come from inside the account after signing in. A request arriving from outside it is met by asking its sender to resend it from inside their account.

### 9.3 No disclosure that an account exists
The Store neither confirms nor denies the existence of an account or an order to a person who has not established that they are its holder. The enquirer receives the same answer in both cases.

### 9.4 Another person's data
Nobody is given another person's order details, address or number, even a relative or a person paying on their behalf.

### 9.5 A person who received on behalf
Receipt by another person on the customer's behalf is governed by the Delivery document, and does not give the recipient the right to address support about the order.

### 9.6 A suspicious request
Where there is an indication that a request is not from the account holder, its execution is stopped and the account holder is notified on their verified channel.

### 9.7 A compromised account
A person who sees activity they do not recognise on their account notifies support immediately, and the measures of the Registration document are taken. The Store cannot recover what was already executed before the notification.

## 10. What support will not do

### 10.1 It does not change a price
Support does not change the price of a product or of an order, and does not grant a discount that did not arise from a published rule. A change or correction of price is governed by the Purchase document and the Price Protection document.

### 10.2 It does not waive a condition
Support does not waive a condition in a document and does not extend a period that has expired — such as the return window, or the condition that extended warranty is bought before the order — even where it considers the case deserving. An exception is made only by a written decision at the authorised level.

### 10.3 It does not execute an unverifiable request
No change of address, cancellation of an order, transfer of balance or disclosure of a detail is executed on the basis of a message whose issue by the account holder cannot be established.

### 10.4 It does not promise what the system does not have
Support does not promise a cash refund where the refund is to the wallet, nor a definite delivery date, nor the availability of a product whose availability is not assured, nor acceptance of a return before inspection.

### 10.5 It does not disclose an account other than the addressee's
Even where the question appears simple, such as verifying that an order number exists.

### 10.6 It does not ask for a secret
Support does not ask for a password, a verification code or a sign-in code, and does not ask for a transfer to a member of staff's personal account.

### 10.7 It does not mediate outside the platform
Support does not recognise an agreement made between a customer and a merchant outside the platform, and does not determine upon it.

### 10.8 It does not direct a repair by the customer
Support does not direct a customer to open a device under warranty or to repair it themselves, because that voids the warranty under the Warranty document.

### 10.9 Limits of authority
What exceeds a member of staff's authority is referred to the higher level under chapter 11, and is not answered with a promise they do not hold.

## 11. Escalating a complaint

### 11.1 The first level
The matter is put first to support by a ticket, and its answer is awaited within the targeted period.

### 11.2 Escalation
Where the customer is not satisfied with the answer, or the response exceeded its period, they request escalation in the same ticket, and it is referred to the higher level.

### 11.3 The escalation period
A determination on an escalated complaint is targeted within {{SUPPORT_ESCALATION_DAYS}}.

### 11.4 What a complaint must contain
The ticket number, a statement of the decision objected to, the ground of objection, and precisely what the customer is asking for.

### 11.5 The decision on the complaint
The decision issues in writing with its reason, stating what was accepted and what was refused and why.

### 11.6 Appealing a measure on the account
An appeal against a restriction or a suspension is filed within {{ACCOUNT_APPEAL_DAYS}} under the Registration document.

### 11.7 The right to go to court
This path does not prevent the customer from resorting to the competent body under article 14.4.

## 12. A dispute with a Levo Community merchant

### 12.1 Where it is determined
A dispute between a customer and a merchant is brought inside the platform and is governed by the disputes chapter of the Levo Community Policy; this document sets out the path of contact and not the substance of the determination.

### 12.2 The Store's role
In this path the Store is an intermediary determining between two parties on the evidence, and is not the seller of the community goods. The seller is the merchant, upon whom their obligations rest.

### 12.3 The effect of opening a dispute on the money
Opening a dispute keeps the held money held until determination, and it is released to neither party before it.

### 12.4 The evidence
Determination is made on what is recorded: the conversation inside the platform, the description of the listing, the photographs, the state of the order and the delivery record.

### 12.5 An agreement outside the platform
What took place outside the platform is not relied upon in the determination, and the Store cannot protect it.

### 12.6 The period of determination
Determination is targeted within {{DISPUTE_RESPONSE_DAYS}}; the period is suspended while a reply from either party is awaited, and the merchant's reply window is {{MERCHANT_REPLY_WINDOW_HOURS}}.

### 12.7 A merchant who does not reply
Where the merchant does not reply within {{MERCHANT_UNRESPONSIVE_DAYS}}, the dispute is determined on the evidence the Store holds.

### 12.8 The outcome of the determination
The decision issues in writing with its reason, is executed against the held money, and its effect is recorded against the merchant's rating under the Levo Community Policy.

### 12.9 A vexatious complaint
A complaint shown to be vexatious is refused, and what is appropriate is taken in respect of its author under the Registration document.

## 13. The conduct of both parties

### 13.1 Mutual respect
The customer is addressed with respect, and the customer addresses the Store's staff and community merchants likewise.

### 13.2 What is not tolerated
Insult, threat, extortion, discrimination, harassment and the disclosure of another person's data. The Store may end the exchange at that point and record the incident.

### 13.3 Flooding
Flooding the channels with repeated messages or automated requests is treated as abuse, and the Store may limit the rate of sending.

### 13.4 The identity of a member of staff
The personal identity of a member of staff is not disclosed to the customer, for their protection. The ticket number suffices for the exchange, and the Store holds its staff to account internally.

### 13.5 Recording of exchanges
Exchanges are recorded and retained in accordance with the Privacy and Data Protection Policy and the retention periods set out in it.

### 13.6 Use of a support answer
A support answer is addressed to the ticket holder in their own case; it is not a general precedent and is not relied upon in another case.

## 14. Final provisions

### 14.1 Amendment
The Store may amend this document by issuing a new version with a number and an effective date; an amendment does not apply retroactively to a live ticket.

### 14.2 Priority in case of conflict
Where the text of this document conflicts with an oral promise, a message from a member of staff or a marketing publication, the text of this document governs. Where it conflicts with a substantive document as to the content of a right, the substantive document governs as to that content.

### 14.3 Severability
The invalidity of one provision does not affect the validity of the remaining provisions.

### 14.4 Governing law and jurisdiction
This document is governed by {{GOVERNING_LAW_JURISDICTION}}, and {{COMPETENT_COURT}} have jurisdiction over disputes.

### 14.5 Contact
The approved channel of contact: {{LEVONIS_SUPPORT_CONTACT}}, during {{LEVONIS_SUPPORT_HOURS}}. The address: {{LEVONIS_ADDRESS}}.`,

    ckb: `## 1. پێشەکی و بوار و پێناسەکان

### 1.1 مەبەستی ئەم بەڵگەنامەیە
ئەم بەڵگەنامەیە کەناڵە پەسەندکراوەکانی پشتگیری لە Levonis ڕوون دەکاتەوە، و کاتەکانی کار، و ئەوەی پێویستە کڕیار پێش پەیوەندیکردن ئامادەی بێت، و کاتە ئامانجدارەکانی وەڵام و چارەسەر، و چۆن سکاڵا بەرز دەکرێتەوە، و چۆن ناکۆکی لەگەڵ بازرگانێکی کۆمەڵگەی لێڤۆ چارەسەر دەکرێت، و ئەوەی پشتگیری ناینێت هەرچەندە داوای لێ بکرێت.

### 1.2 لایەنەکان
فرۆشگا: {{LEVONIS_LEGAL_NAME}}، تۆمارکراو بە ژمارە {{LEVONIS_REGISTRATION_NO}}، ناونیشانی {{LEVONIS_ADDRESS}}. کڕیار: خاوەن هەژمار، یان ئەو کەسەی سەبارەت بە داواکارییەک یان بەرهەمێک پەیوەندی بە فرۆشگاوە دەکات.

### 1.3 پێناسەکان
- پشتگیری: ئەو بەشەی لە فرۆشگادا وەڵامی پرسیارەکانی کڕیاران دەداتەوە و سکاڵاکانیان چارەسەر دەکات.
- کەناڵی پەسەندکراو: ڕێگەیەکی پەیوەندی کە فرۆشگا لەم بەڵگەنامەیەدا دانی پێدا دەنێت؛ هەرچی تر پەسەندکراو نییە.
- یاریدەدەر: ئەو ئامرازەی ناو بەرنامەکە کە وەڵامی پرسیاری پێشدیاریکراو دەداتەوە لە داتای هەژماری خودی کڕیارەوە.
- تیکێت: تۆمارێکی نووسراوی داواکارییەک یان سکاڵایەک، بە ژمارە و دۆخ و بەروار و نامەکان.
- دۆخی تیکێت: قۆناغی تۆمارکراوی لە سیستەمەکەدا.
- پێشینە: ڕیزبەندی تیکێتەکە لە ڕیزی کاردا.
- سکاڵا: ناڕەزایی لە بڕیارێک یان خزمەتگوزارییەک یان ڕەفتارێک.
- ناکۆکی: جیاوازی نێوان کڕیار و بازرگانێکی کۆمەڵگەی لێڤۆ لەسەر داواکارییەکی کراوە.
- بەرزکردنەوە: ناردنی سکاڵا بۆ ئاستێکی بەرزتر لە فرۆشگا دوای تەواوبوونی ئاستی یەکەم.
- داواکاری پشکنین نەکراو: داواکارییەک کە فرۆشگا ناتوانێت بسەلمێنێت لە خودی خاوەن هەژمارەوە هاتووە.

### 1.4 دەقی پەسەندکراو
دەقی عەرەبی دەقی پەسەندکراوە، و ئینگلیزی و کوردی وەرگێڕانی دڵسۆزن بە هەمان ژمارەبەندی. لە کاتی جیاوازیدا دەقی عەرەبی بنەمایە.

### 1.5 بواری ئەم بەڵگەنامەیە
ئەم بەڵگەنامەیە پەیوەندی و چارەسەری پرۆسێسی ڕێک دەخات. بەڵام ناوەڕۆکی خودی مافەکە — گەڕاندنەوە یان گەرەنتی یان گەیاندن یان پارەدان یان ئەندامێتی — بەڵگەنامەی تایبەتی خۆی ڕێکی دەخات، و ئەم بەڵگەنامەیە نە مافێکی بنەڕەتی دروست دەکات و نە دەیفەوتێنێت.

### 1.6 پشتگیری قسە لەگەڵ کێ دەکات
پشتگیری قسە لەگەڵ خاوەن هەژمار دەکات. ئەو کەسەی بەبێ هەژمار پەیوەندی دەکات تەنها لەو سنوورەدا وەڵام دەدرێتەوە کە داتای هەژماری هیچ کەسێک ئاشکرا ناکات.

## 2. کەناڵە پەسەندکراوەکانی پشتگیری

### 2.1 کەناڵەکان
- یاریدەدەری ناو بەرنامەکە.
- تیکێتەکانی پشتگیری لەناو هەژماردا.
- کەناڵی پەیوەندی بڵاوکراوە: {{LEVONIS_SUPPORT_CONTACT}}.

### 2.2 کەناڵی تۆمار
تیکێتی ناو هەژمار ئەو کەناڵەیە کە پشتی پێ دەبەسترێت بۆ سەلماندنی بەروار و ناوەڕۆکی داواکارییەک. ئەوەی لە کەناڵێکی تردا ڕوویداوە دەگوازرێتەوە بۆ تیکێتێک تاوەکو پشتی پێ ببەسترێت.

### 2.3 هیچ کەناڵێک لە دەرەوەی بڵاوکراوەکان
فرۆشگا بەرپرس نییە لە هەژمار یان ژمارە یان پەڕەیەک کە خۆی وەک ناوی ئەو دەردەخات. هیچ بەڵێن و بڕیارێک کە لە دەرەوەی ئەو کەناڵانەی لە ماددەی 2.1 بڵاو کراونەتەوە دەرچووبێت پشتی پێ ناوەسترێت.

### 2.4 نامەنووسین لەگەڵ بازرگان
نامەنووسین لەگەڵ بازرگانێکی کۆمەڵگەی لێڤۆ لەناو پلاتفۆرمەکەدا دەبێت و بە حوکمەکانی گفتوگۆ لە سیاسەتی کۆمەڵگەی لێڤۆدا ڕێک دەخرێت. نامەنووسین لەگەڵ بازرگان نامەنووسین لەگەڵ فرۆشگا نییە.

### 2.5 نامەکانی خزمەتگوزاری
نامەکانی خزمەتگوزاری سەبارەت بە هەژمار و داواکاری و پارەدان و گەرەنتی لەسەر ئەو کەناڵانە دەنێردرێن کە بۆ هەژمارەکە پشتڕاست کراونەتەوە: ئیمەیڵێکی پشتڕاستکراوە، یان ژمارەیەک کە خاوەندارێتی سەلمێنراوە، یان بەستنەوەیەکی زیندووی تێلێگرام. ئەمانە نامەی بازرگانی نین و کوژاندنەوەی بازرگانی نایانوەستێنێت.

### 2.6 ئەو کەناڵەی سیستەم هەڵیناگرێت
کاتێک فرۆشگا لە کاتێکدا ناتوانێت کەناڵێک هەڵبگرێت، بەڵێنی بە کڕیار نادرێت، و هۆکارەکەی پێ دەڵێن لە جیاتی ناردنێک کە ناگات.

### 2.7 پشتگیری هەرگیز سنووردار ناکرێت
سنوورە کارگێڕییەکان لەسەر هەژمار تەنها ژماردنی سوودەکان دەگرنەوە. هەرگیز قسەکردن لەگەڵ پشتگیری و داواکردنی گەرەنتی و گەیشتن بە داتای هەژمار سنووردار ناکەن. هەژماری سنووردارکراو وەک هەر هەژمارێکی تر سکاڵا دەکات.

### 2.8 زمانی پەیوەندی
کڕیار بە عەرەبی یان ئینگلیزی یان کوردی بەپێی هەڵبژاردنی خۆی قسەی لەگەڵ دەکرێت، و بە زمانی خۆی وەڵام دەدرێتەوە لە هەر شوێنێک بکرێت.

## 3. یاریدەدەری ناو بەرنامەکە

### 3.1 سروشتی
یاریدەدەر ئامرازێکی ڕەفتار دیاریکراوە: وەڵامی لیستێکی داخراوی پرسیار بە یاسای نەگۆڕ دەداتەوە. کەس نییە، سیستەمی زیرەکی دەستکرد نییە، و نە ئەنجام دەردەهێنێت و نە خەمڵاندن دەکات.

### 3.2 وەڵامی چی دەداتەوە
دۆخی داواکاری، خەمڵاندنی گەیاندن، ئامێرەکانی کڕیار، دۆخی گەرەنتی، باڵانسی خاڵ، دۆخی ئەندامێتی، یارمەتی لە گەڕاندنەوەدا، یارمەتی لە وشەی نهێنیدا، گەڕان بەدوای بەرهەم، پرسیار سەبارەت بە سیاسەتەکان، کردنەوەی تیکێت، و گواستنەوە بۆ کارمەند.

### 3.3 سەرچاوەی وەڵامەکەی
یاریدەدەر تەنها داتای خودی ئەو هەژمارە دەخوێنێتەوە کە چووەتە ژوورەوە، لەگەڵ کاتالۆگی گشتی و سیاسەتە بڵاوکراوەکان. هیچ شتێک لەسەر هەژماری کەسێکی تر بە کڕیار ناڵێت.

### 3.4 لە کاتی ناڕوونیدا
کاتێک مەبەست ڕوون نەبێت، یاریدەدەر هەڵبژاردن پێشکەش دەکات بۆ ڕوونکردنەوە. بە وەڵامێکی ئەگەری وەڵام نادات، چونکە وەڵامێکی هەڵە سەبارەت بە داواکارییەک خراپترە لە پرسیارێکی زیادە.

### 3.5 کێشی وەڵامی یاریدەدەر
وەڵامی یاریدەدەر ڕاگەیاندنی دۆخێکی تۆمارکراوە، و بەڵێن و بڕیار و واز هێنان لە مەرجێکی بەڵگەنامەیەک نییە. هەرچی لەناویدا پێچەوانەی بەڵگەنامەکانی فرۆشگا بێت پشتی پێ ناوەسترێت.

### 3.6 خەمڵاندنەکان
ئەو ماوانەی گەیاندن کە یاریدەدەر پیشانی دەدات خەمڵاندنێکن لەسەر بنەمای دۆخی تۆمارکراوی داواکارییەکە، و ئەو ماددەیەی سەبارەت بە خەمڵاندنی ماوەکان لە بەڵگەنامەی گەیاندندا لەسەریان جێبەجێ دەبێت.

### 3.7 گواستنەوە بۆ کارمەند
کڕیار دەتوانێت هەر کاتێک داوای گواستنەوە بۆ کارمەند بکات، و تیکێتێکی بۆ دەکرێتەوە بەپێی بەشی شەشەم.

### 3.8 سنوورەکانی یاریدەدەر
یاریدەدەر داواکاری هەڵناوەشێنێتەوە، پارە ناگەڕێنێتەوە، ناونیشان ناگۆڕێت، و بڕیار لەسەر گەڕاندنەوە یان گەرەنتی نادات. هەریەکە لەمانە ڕێچکەیەکە بە بەڵگەنامە و بڕیارەکانی خۆیەوە.

## 4. کاتەکانی کار و داپۆشین

### 4.1 کاتەکانی کار
کاتەکانی کاری پشتگیری: {{LEVONIS_SUPPORT_HOURS}}.

### 4.2 لە دەرەوەی کاتەکانی کار
تیکێتەکان لە هەموو کاتێکدا وەردەگیرێن و لە یەکەم کاتی کاری دواتردا چارەسەر دەکرێن.

### 4.3 پشووە فەرمییەکان
ڕۆژانی پشووی فەرمی وەک ڕۆژی ناکار هەژمار دەکرێن و لە ماوە ئامانجدارەکاندا ناژمێردرێن، مەگەر فرۆشگا بە پێچەوانەوە ڕایبگەیەنێت.

### 4.4 کاتەکانی وەرگرتن لە کۆگا
کاتەکانی ئامادەبوون لە کۆگا: {{LEVONIS_PICKUP_HOURS}}، لە {{LEVONIS_WAREHOUSE_ADDRESS}}. سەنتەری خزمەتگوزاری لە {{LEVONIS_SERVICE_ADDRESS}}.

### 4.5 پچڕانی لەناکاو
لە کاتی پچڕانێکی تەکنیکی یان بارودۆخێکی دەرەوەی ویستدا، فرۆشگا لەسەر کەناڵە بڵاوکراوەکان ڕایدەگەیەنێت، و ماوە ئامانجدارەکان بەقەد درێژی پچڕانەکە درێژ دەکرێنەوە.

## 5. ئەوەی پێویستە کڕیار ئامادەی بێت

### 5.1 لە هەر پەیوەندییەکدا
- ژمارەی داواکاری.
- ئیمەیڵ یان ژمارەی پشتڕاستکراوە لەسەر هەژمار.
- ڕوونکردنەوەیەکی ڕوونی کێشەکە و کەی ڕوویداوە.

### 5.2 لە سکاڵای گەیاندندا
بەرواری گەیاندنی تۆمارکراو، ناوی وەرگر ئەگەر کەسێکی تر وەریگرتبێت، وێنەی پاکێجەکە لە دەرەوە و ناوەوە، و هەر تۆمار یان تێبینییەک لە گواستنەوەکەرەوە.

### 5.3 لە داواکاری گەڕاندنەوەدا
هۆکاری گەڕاندنەوە، وێنەی بەرهەم و کەموکوڕی و پاکێجی ناوەوە و دەرەوە و ژمارە زنجیرەییەکە، و ڤیدیۆ ئەگەر کەموکوڕییەکە ڕەفتارێک بێت کە لە وێنەدا دەرناکەوێت.

### 5.4 لە داواکاری گەرەنتیدا
ژمارە زنجیرەیی یەکەکە، بەرواری گەیاندنی تۆمارکراو، وەسفی تێکچوونەکە و بەرواری دەرکەوتنی، و ئەوەی پێش دەرکەوتنی ڕوویداوە.

### 5.5 لە بابەتی پارەدان یان جزداندا
بەروار و بڕی مامەڵەکە، ژمارەی ئەو داواکارییەی پەیوەستە پێیەوە، و وێنەی پسوڵەکە ئەگەر دانانێک بێت.

### 5.6 لە سکاڵا لە بازرگانێکدا
ژمارەی داواکاری کۆمەڵگەیی، وێنەیەک لە ڕێککەوتنەکە لەناو پلاتفۆرمەکەدا، و بەڵگەکانی ئەوەی ڕوویداوە.

### 5.7 ئەوەی هەرگیز لە کڕیار داوا ناکرێت
پشتگیری داوای وشەی نهێنی و کۆدی پشتڕاستکردنەوە و وێنەی تەواوی کارتی بانکی و کۆدی چوونەژوورەوە ناکات. هەر کەسێک بە ناوی فرۆشگاوە داوای ئەمانە بکات ساختەکارە و دەبێت دەستبەجێ ڕاپۆرت بکرێت.

### 5.8 کاریگەری کەمی زانیاری
کەمی هیچ یەکێک لەمانە ڕێگە لە کردنەوەی تیکێت ناگرێت، بەڵام چارەسەرکردنی دوا دەخات، و ماوەی چاوەڕوانی تەواوکردنی زانیارییەکە لەسەر فرۆشگا ناژمێردرێت.

## 6. تیکێتەکان

### 6.1 کێ تیکێت دەکاتەوە
خاوەن هەژمار تیکێتەکە لەناو هەژمارەکەی خۆیەوە دەکاتەوە.

### 6.2 پشتڕاستکردنەوە پێش کردنەوە
تیکێت بەبێ پشتڕاستکردنەوەیەکی ڕوونی کڕیار ناکرێتەوە، تاوەکو تیکێتێک لە پەنجەلێدانێکی بێ ئەنقەستەوە سەرهەڵنەدات.

### 6.3 سنووری دەق
بابەتی تیکێت لە سێ پیت کەمتر و لە دووسەد زیاتر نییە، و دەقی نامەکە لە پێنج پیت کەمتر و لە چوار هەزار زیاتر نییە. ژمارەی ئەو تیکێت و نامانەی لە یەک هەژمارەوە دەنێردرێن لە کاتژمێردا سنووردارە.

### 6.4 بەستنەوەی تیکێت بە داواکاری یان ئامێرێکەوە
تیکێت دەکرێت بە ژمارەی داواکاری یان ژمارەی ئامێرێکەوە ببەسترێت، و بەستنەوەکە تەنها وەردەگیرێت ئەگەر داواکارییەکە یان ئامێرەکە لە هەژماری خودی خاوەنی تیکێتەکەدا تۆمار کرابێت.

### 6.5 تیکێتی زۆر
بۆ هەر بابەتێک تیکێتێک دەکرێتەوە. کۆکردنەوەی بابەتی جیاواز لە یەک تیکێتدا هەموویان دوا دەخات.

### 6.6 دۆخەکانی تیکێت
- کراوە: تۆمار کراوە و هێشتا نەدراوەتە کەس.
- چاوەڕوانی کڕیار: پشتگیری داوای زانیارییەکی کردووە و نەگەیشتووە.
- چاوەڕوانی کارمەند: پشتگیری شتێکی هەیە وەڵامی بداتەوە.
- چارەسەرکراو: وەڵام یان بڕیارێکی لەسەر دەرچووە.

### 6.7 چاوەڕوانی کڕیار
ئەگەر تیکێتێک بە ماوەی {{TICKET_CUSTOMER_WAIT_DAYS}} بەبێ وەڵام لە چاوەڕوانی کڕیاردا بمێنێتەوە، دەکرێت بە کارگێڕی دابخرێت، و خاوەنەکەی دەتوانێت بە وەڵامدانەوەی بیکاتەوە.

### 6.8 کردنەوەی دووبارە
وەڵامی کڕیار لەسەر تیکێتێکی چارەسەرکراو دەیکاتەوە و دەیخاتە چاوەڕوانی کارمەندەوە. نامەکەی نە دەخورێت و نە پشتگوێ دەخرێت.

### 6.9 تۆماری تیکێت
نامەکانی تیکێت بە بەروارەکانیانەوە تۆمارکراو دەمێننەوە، و خاوەنەکەی دەتوانێت لە هەژمارەکەیەوە بیانبینێت.

### 6.10 بڕیارەکە نووسراوە
هەر بڕیارێک لەسەر تیکێتێک لە خودی ئەو تیکێتەدا بە هۆکارەکەیەوە دەنووسرێت؛ وەڵامێکی زارەکی لەسەر کەناڵێکی تر بەس نییە.

### 6.11 داخستنی تیکێت مافێک نافەوتێنێت
چارەسەرکردنی تیکێت هەنگاوێکی ڕێکخستنە و مافێک نافەوتێنێت کە لە بەڵگەنامەیەکی تردا جێگیرە، مادام ماوەی ئەو مافە هێشتا بەردەوامە.

## 7. وەڵامدانەوە و ماوە ئامانجدارەکان

### 7.1 سروشتی ماوەکان
ئەو ماوانەی لەم بەشەدا هاتوون ئامانجن نەک گەرەنتی، چونکە ڕیزەکە لەلایەن مرۆڤەوە کار دەکرێت. فرۆشگا بەڵێن دەدات ئەوەی پێویستە بکات بۆ گەیشتن پێیان، و هۆکاری دواکەوتن ڕادەگەیەنێت ئەگەر لێیان تێپەڕی.

### 7.2 یەکەم وەڵام
یەکەم وەڵام لە ماوەی {{SUPPORT_FIRST_RESPONSE_HOURS}} لە کردنەوەی تیکێتەکەوە ئامانج دەکرێت، لەناو کاتەکانی کاردا.

### 7.3 یەکەم وەڵام بۆ ئەندامانی PRO
یەکەم وەڵام بۆ ئەندامی PRO لە ماوەی {{PRO_PRIORITY_RESPONSE_HOURS}} ئامانج دەکرێت.

### 7.4 ماوەی چارەسەر
چارەسەری بابەتێکی سادە لە ماوەی {{SUPPORT_RESOLUTION_TARGET_DAYS}} ئامانج دەکرێت. ئەو بابەتەی پێویستی بە پشکنینی تەکنیکی یان گەڕانەوە بۆ گواستنەوەکەر یان دابینکەر هەیە ئەو ماوەیە دەگرێت کە لە بەڵگەنامەی خۆیدا هاتووە.

### 7.5 ڕێچکەکان بە ماوەی تایبەتی خۆیانەوە
- داواکاری گەڕاندنەوە: بەڵگەنامەی گەڕاندنەوە و ئاڵوگۆڕ.
- داواکاری گەرەنتی: بەڵگەنامەی گەرەنتی، بە ماوەکانی {{WARRANTY_CLAIM_DIAGNOSIS_DAYS}} و {{WARRANTY_CLAIM_TURNAROUND_DAYS}}.
- پێداچوونەوەی دانان: {{DEPOSIT_REVIEW_HOURS}}.
- جێبەجێکردنی کێشانەوە: {{WITHDRAWAL_PAYOUT_DAYS}}.
- داواکاری نرخ: {{PRICE_CLAIM_DECISION_DAYS}}.
- بڕیاردان لە ناکۆکی کۆمەڵگەیی: {{DISPUTE_RESPONSE_DAYS}}.

### 7.6 ڕاگرتنی ماوەکە
ماوە ئامانجدارەکە ڕادەگیرێت لە کاتی چاوەڕوانی زانیاری یان بەڵگەنامەیەک لە کڕیارەوە، و لە کاتی چاوەڕوانی وەڵامی گواستنەوەکەر یان دابینکەر یان لایەنێکی فەرمی، و کاتێک گەیشت بەردەوام دەبێت.

### 7.7 ئاگادارکردنەوە لە دواکەوتن
کاتێک گەیشتن بە ماوە ئامانجدارەکە نەکرێت، کڕیار لەوە و لە هۆکارەکەی و لە بەرواری نوێ ئاگادار دەکرێتەوە، و بەبێ وەڵام جێ ناهێڵدرێت.

## 8. پێشینە و دادپەروەری نۆرە

### 8.1 بنەمای ڕیزبەندی
ڕیزی کار سەرەتا بە پێشینە ڕیز دەکرێت، پاشان بە کۆنترین یەکەم لەناو هەر ئاستێکدا.

### 8.2 کێ پێشینەی هەیە
پێشینە لەسەر تیکێتێک لە کاتی کردنەوەیدا جێگیر دەکرێت بۆ ئەندامی PRO کە ئەندامێتییەکەی کاری پێدەکرێت و هیچ سنوورێکی کارگێڕی زیندووی لەسەر نییە کە سوودی پێشینە ڕابگرێت.

### 8.3 پێشینە لە کاتی کردنەوەدا جێگیر دەکرێت
پێشینە لە ساتی کردنەوەی تیکێتەکەدا جێگیر دەکرێت و بە گۆڕانی دواتری ئەندامێتی ناگۆڕێت.

### 8.4 بێبەشنەکردنی ناوەندامان
تەمەنی تیکێتەکە لەبەردەم پشتگیریدا دیارە، و تیکێتی کۆنتر بۆ هەتاهەتایە لە دوای تیکێتی نوێتری خاوەن پێشینە جێ ناهێڵدرێت.

### 8.5 پەلەکردن بەبێ هۆکار
دووبارە کردنەوەی تیکێت لەسەر هەمان بابەت نۆرە پێش ناخات، و لەوانەیە بە پەرتکردنی چارەسەرکردن دوای بخات.

### 8.6 دۆخە گرنگەکان
پشتگیری دەتوانێت ئەو بابەتە پێش بخات کە پەیوەندی بە سەلامەتی کەسێک یان پارەیەکی گیراو یان ماوەیەکی لە کۆتاییهاتندا هەیە، هەرچییەک ئەندامێتی خاوەنەکەی بێت.

## 9. سەلماندنی داواکار

### 9.1 بنەما
داواکارییەک کە پەیوەندی بە هەژمار یان داواکاری یان پارەوە هەیە جێبەجێ ناکرێت تا نەسەلمێنرێت لە خاوەن هەژمارەوە هاتووە.

### 9.2 فرۆشگا چۆن دەسەلمێنێت
پشت بەوە دەبەسترێت کە داواکارییەکە لە ناو هەژمارەکەوە دوای چوونەژوورەوە هاتووە. ئەو داواکارییەی لە دەرەوەی دێت، لە نێرەرەکەی داوا دەکرێت لە ناو هەژمارەکەی خۆیەوە بینێرێتەوە.

### 9.3 ئاشکرا ناکرێت کە هەژمارێک بوونی هەیە
فرۆشگا نە پشتڕاست دەکاتەوە و نە ڕەت دەکاتەوە کە هەژمارێک یان داواکارییەک بوونی هەیە بۆ کەسێک کە نەیسەلماندووە خاوەنیەتی. پرسیارکەر لە هەردوو دۆخدا هەمان وەڵام وەردەگرێت.

### 9.4 داتای کەسانی تر
هیچ کەسێک وردەکاری داواکاری کەسێکی تر و ناونیشان و ژمارەی پێ نادرێت، تەنانەت خزمێکی بێت یان ئەو کەسەی لە جیاتی پارە دەدات.

### 9.5 ئەو کەسەی لە جیاتی وەریگرتووە
وەرگرتنی کەسێکی تر لە جیاتی کڕیار بە بەڵگەنامەی گەیاندن ڕێک دەخرێت، و مافی قسەکردن لەگەڵ پشتگیری سەبارەت بە داواکارییەکە بە وەرگر نادات.

### 9.6 داواکاری گومانلێکراو
کاتێک ئاماژەیەک هەبێت کە داواکارییەک لە خاوەن هەژمارەوە نەبێت، جێبەجێکردنی ڕادەگیرێت و خاوەن هەژمار لەسەر کەناڵە پشتڕاستکراوەکەی ئاگادار دەکرێتەوە.

### 9.7 هەژماری داگیرکراو
ئەو کەسەی چالاکییەک لەسەر هەژمارەکەی دەبینێت کە نایناسێت دەستبەجێ پشتگیری ئاگادار دەکاتەوە، و ڕێوشوێنەکانی بەڵگەنامەی تۆمارکردن وەردەگیرێن. فرۆشگا ناتوانێت ئەوە بگەڕێنێتەوە کە پێش ئاگادارکردنەوەکە جێبەجێ کرابێت.

## 10. ئەوەی پشتگیری ناینێت

### 10.1 نرخ ناگۆڕێت
پشتگیری نرخی بەرهەمێک یان داواکارییەک ناگۆڕێت، و داشکاندنێک نابەخشێت کە لە یاسایەکی بڵاوکراوەوە نەهاتبێت. گۆڕان یان ڕاستکردنەوەی نرخ بە بەڵگەنامەی کڕین و بەڵگەنامەی پاراستنی نرخ ڕێک دەخرێت.

### 10.2 واز لە مەرجێک ناهێنێت
پشتگیری واز لە مەرجێکی بەڵگەنامەیەک ناهێنێت و ماوەیەکی تەواوبوو درێژ ناکاتەوە — وەک ماوەی گەڕاندنەوە، یان ئەو مەرجەی گەرەنتی درێژکراوە پێش داواکارییەکە بکڕدرێت — تەنانەت ئەگەر بە شایستەشی بزانێت. جیاوازی تەنها بە بڕیارێکی نووسراو لە ئاستی دەسەڵاتداردا دەبێت.

### 10.3 داواکاری پشکنین نەکراو جێبەجێ ناکات
هیچ گۆڕینی ناونیشان و هەڵوەشاندنەوەی داواکاری و گواستنەوەی باڵانس و ئاشکراکردنی وردەکاری جێبەجێ ناکرێت لەسەر بنەمای نامەیەک کە دەرچوونی لە خاوەن هەژمارەوە نەسەلمێنرێت.

### 10.4 بەڵێنی ئەوە نادات کە سیستەم نییەتی
پشتگیری بەڵێنی گەڕاندنەوەی نەقدی نادات لەو شوێنەی گەڕاندنەوەکە بۆ جزدانە، نە بەرواری گەیاندنی بڕیاردراو، نە بەردەستی بەرهەمێک کە بەردەستی دڵنیا نییە، نە وەرگرتنی گەڕاندنەوەیەک پێش پشکنین.

### 10.5 هەژمارێک جگە لە هەژماری قسەکەر ئاشکرا ناکات
تەنانەت کاتێک پرسیارەکە لە ڕواڵەتدا سادە دەردەکەوێت، وەک سەلماندنی ئەوەی ژمارەی داواکارییەک بوونی هەیە.

### 10.6 داوای نهێنی ناکات
پشتگیری داوای وشەی نهێنی و کۆدی پشتڕاستکردنەوە و کۆدی چوونەژوورەوە ناکات، و داوای گواستنەوە بۆ هەژماری کەسیی کارمەندێک ناکات.

### 10.7 لە دەرەوەی پلاتفۆرم ناوەندگیری ناکات
پشتگیری دان بە ڕێککەوتنێکدا نانێت کە لە دەرەوەی پلاتفۆرم لە نێوان کڕیار و بازرگاندا کراوە، و بڕیاری لەسەر نادات.

### 10.8 ڕێنمایی چاککردن بە دەستی کڕیار ناکات
پشتگیری کڕیار ئاڕاستە ناکات بۆ کردنەوەی ئامێرێک لەژێر گەرەنتیدا یان چاککردنی بە دەستی خۆی، چونکە ئەوە گەرەنتی بەپێی بەڵگەنامەی گەرەنتی دەفەوتێنێت.

### 10.9 سنووری دەسەڵات
ئەوەی لە دەسەڵاتی کارمەند تێدەپەڕێت بەپێی بەشی یازدەیەم بۆ ئاستی بەرزتر دەنێردرێت، و بە بەڵێنێک وەڵام نادرێتەوە کە نەیهەیە.

## 11. بەرزکردنەوەی سکاڵا

### 11.1 ئاستی یەکەم
بابەتەکە سەرەتا بە تیکێتێک لە پشتگیری دەنرێت، و وەڵامەکەی لە ماوە ئامانجدارەکەدا چاوەڕێ دەکرێت.

### 11.2 بەرزکردنەوە
ئەگەر کڕیار بە وەڵامەکە ڕازی نەبوو، یان وەڵامدانەوە لە ماوەکەی تێپەڕی، لە هەمان تیکێتدا داوای بەرزکردنەوە دەکات، و بۆ ئاستی بەرزتر دەنێردرێت.

### 11.3 ماوەی بەرزکردنەوە
بڕیاردان لەسەر سکاڵای بەرزکراوە لە ماوەی {{SUPPORT_ESCALATION_DAYS}} ئامانج دەکرێت.

### 11.4 ئەوەی پێویستە سکاڵا لەخۆی بگرێت
ژمارەی تیکێت، ڕوونکردنەوەی ئەو بڕیارەی تانەی لێدەدرێت، هۆکاری تانەکە، و بە وردی ئەوەی کڕیار داوای دەکات.

### 11.5 بڕیار لەسەر سکاڵا
بڕیارەکە بە نووسراوی بە هۆکارەکەیەوە دەردەچێت، و تێیدا ڕوون دەکرێتەوە چی وەرگیراوە و چی ڕەت کراوەتەوە و بۆچی.

### 11.6 تانە لە ڕێوشوێنێکی سەر هەژمار
تانە لە سنووردارکردن یان ڕاگرتن لە ماوەی {{ACCOUNT_APPEAL_DAYS}} بەپێی بەڵگەنامەی تۆمارکردن پێشکەش دەکرێت.

### 11.7 مافی سەردانی دادگا
ئەم ڕێچکەیە ڕێگە لە کڕیار ناگرێت لە ڕووکردنە لایەنی پەیوەندیدار بەپێی ماددەی 14.4.

## 12. ناکۆکی لەگەڵ بازرگانێکی کۆمەڵگەی لێڤۆ

### 12.1 شوێنی بڕیاردان
ناکۆکی نێوان کڕیار و بازرگان لەناو پلاتفۆرمەکەدا دەخرێتەڕوو و بە بەشی ناکۆکییەکان لە سیاسەتی کۆمەڵگەی لێڤۆدا ڕێک دەخرێت؛ ئەم بەڵگەنامەیە ڕێچکەی پەیوەندی ڕوون دەکاتەوە نەک ناوەڕۆکی بڕیارەکە.

### 12.2 ڕۆڵی فرۆشگا
لەم ڕێچکەیەدا فرۆشگا ناوەندگیرێکە کە لەسەر بنەمای بەڵگە لە نێوان دوو لایەندا بڕیار دەدات، و فرۆشیاری کاڵا کۆمەڵگەییەکە نییە. فرۆشیار بازرگانەکەیە و ئەرکەکانی لەسەری.

### 12.3 کاریگەری کردنەوەی ناکۆکی لەسەر پارە
کردنەوەی ناکۆکی پارە گیراوەکە گیراو دەهێڵێتەوە تا بڕیاردان، و پێش ئەو بۆ هیچ کام لە لایەنەکان ئازاد ناکرێت.

### 12.4 بەڵگەکان
بڕیار لەسەر ئەوە دەدرێت کە تۆمارکراوە: گفتوگۆی ناو پلاتفۆرم، وەسفی پێشکەشکراوەکە، وێنەکان، دۆخی داواکارییەکە و تۆماری گەیاندن.

### 12.5 ڕێککەوتنی دەرەوەی پلاتفۆرم
ئەوەی لە دەرەوەی پلاتفۆرم ڕوویداوە لە بڕیاردانەکەدا پشتی پێ ناوەسترێت، و فرۆشگا ناتوانێت بیپارێزێت.

### 12.6 ماوەی بڕیاردان
بڕیاردان لە ماوەی {{DISPUTE_RESPONSE_DAYS}} ئامانج دەکرێت؛ ماوەکە ڕادەگیرێت لە کاتی چاوەڕوانی وەڵامی هەر لایەنێک، و ماوەی وەڵامدانەوەی بازرگان {{MERCHANT_REPLY_WINDOW_HOURS}}ە.

### 12.7 بازرگانێک کە وەڵام نادات
کاتێک بازرگانەکە لە ماوەی {{MERCHANT_UNRESPONSIVE_DAYS}} وەڵام نەداتەوە، ناکۆکییەکە لەسەر ئەو بەڵگانەی فرۆشگا هەیەتی بڕیاری لەسەر دەدرێت.

### 12.8 ئەنجامی بڕیاردان
بڕیارەکە بە نووسراوی بە هۆکارەکەیەوە دەردەچێت، لەسەر پارە گیراوەکە جێبەجێ دەکرێت، و کاریگەرییەکەی لەسەر هەڵسەنگاندنی بازرگان بەپێی سیاسەتی کۆمەڵگەی لێڤۆ تۆمار دەکرێت.

### 12.9 سکاڵای بەدنیاز
ئەو سکاڵایەی دەردەکەوێت بەدنیازە ڕەت دەکرێتەوە، و ئەوەی گونجاوە سەبارەت بە نووسەرەکەی بەپێی بەڵگەنامەی تۆمارکردن وەردەگیرێت.

## 13. ڕەفتاری هەردوو لایەن

### 13.1 ڕێزی دووبەرەکی
بە ڕێزەوە قسە لەگەڵ کڕیار دەکرێت، و کڕیاریش بە هەمان شێوە قسە لەگەڵ کارمەندانی فرۆشگا و بازرگانانی کۆمەڵگە دەکات.

### 13.2 ئەوەی بەرگە ناگیرێت
جنێو و هەڕەشە و زۆرداری و جیاوازی و ئازاردان و ئاشکراکردنی داتای کەسانی تر. فرۆشگا دەتوانێت لەو ساتەدا قسەکردنەکە کۆتایی پێ بهێنێت و ڕووداوەکە تۆمار بکات.

### 13.3 لافاو
لافاوکردنی کەناڵەکان بە نامەی دووبارە یان داواکاری خۆکار وەک خراپ بەکارهێنان مامەڵەی لەگەڵ دەکرێت، و فرۆشگا دەتوانێت ڕێژەی ناردن سنووردار بکات.

### 13.4 ناسنامەی کارمەند
ناسنامەی کەسیی کارمەند بۆ کڕیار ئاشکرا ناکرێت، بۆ پاراستنی. ژمارەی تیکێت بۆ قسەکردن بەسە، و فرۆشگا کارمەندەکەی بە ناوخۆیی لێپرسینەوەی لەگەڵ دەکات.

### 13.5 تۆمارکردنی قسەکردنەکان
قسەکردنەکان تۆمار دەکرێن و بەپێی سیاسەتی تایبەتمەندێتی و پاراستنی داتا و ئەو ماوانەی تێیدا هاتوون هەڵدەگیرێن.

### 13.6 بەکارهێنانی وەڵامی پشتگیری
وەڵامی پشتگیری ئاڕاستەی خاوەنی تیکێتەکەیە لە دۆخی خۆیدا؛ نموونەیەکی گشتی نییە و لە دۆخێکی تردا پشتی پێ ناوەسترێت.

## 14. حوکمە کۆتاییەکان

### 14.1 گۆڕانکاری
فرۆشگا دەتوانێت ئەم بەڵگەنامەیە بگۆڕێت بە دەرکردنی وەشانێکی نوێ بە ژمارە و بەرواری کارپێکردن؛ گۆڕانکاری بە کاریگەری دواکەوتوو لەسەر تیکێتێکی کراوە جێبەجێ نابێت.

### 14.2 پێشینە لە کاتی ناکۆکیدا
کاتێک دەقی ئەم بەڵگەنامەیە لەگەڵ بەڵێنێکی زارەکی یان نامەیەکی کارمەند یان بڵاوکراوەیەکی بازرگانی ناکۆک بێت، دەقی ئەم بەڵگەنامەیە بنەمایە. کاتێک لەگەڵ بەڵگەنامەیەکی بنەڕەتی لە ناوەڕۆکی مافێکدا ناکۆک بێت، بەڵگەنامە بنەڕەتییەکە لەو ناوەڕۆکەدا بنەمایە.

### 14.3 سەربەخۆیی بڕگەکان
پووچی بڕگەیەک کاریگەری لەسەر دروستی بڕگەکانی تر نییە.

### 14.4 یاسا و دەسەڵاتی دادوەری
ئەم بەڵگەنامەیە بە {{GOVERNING_LAW_JURISDICTION}} ڕێک دەخرێت، و {{COMPETENT_COURT}} دەسەڵاتی هەیە لەسەر ناکۆکییەکان.

### 14.5 پەیوەندی
کەناڵی پەیوەندی پەسەندکراو: {{LEVONIS_SUPPORT_CONTACT}}، لە کاتەکانی {{LEVONIS_SUPPORT_HOURS}}. ناونیشان: {{LEVONIS_ADDRESS}}.`,
  },
};
