import type { PolicyDocument } from './types';

/**
 * سياسة التسجيل والحسابات — WHO MAY HOLD AN ACCOUNT, AND WHAT PROVING AN
 * IDENTIFIER ACTUALLY MEANS HERE.
 *
 * WHY THIS IS A SEPARATE DOCUMENT FROM THE PRIVACY POLICY. Privacy answers
 * what is collected and why. This answers something the store has to be able
 * to prove in an argument: that the person who placed the order was the
 * account holder, that the address on the account was proven before it became
 * a recovery channel, and that a loss which followed a shared password is not
 * the shop's. Those are contractual statements, not data statements.
 *
 * EVERY PROCEDURE HERE IS READ OFF routes/auth.ts, NOT INVENTED. The four
 * sign-up paths are the four the code has, and each is described as the code
 * performs it rather than as a generic flow:
 *   - EMAIL FIRST (migration 0051): `/register` with an address writes NOTHING
 *     to `users` and stores NO password; the account is born at
 *     `/signup/complete`, when the holder of the emailed link chooses one.
 *     Article 5.2 says exactly that, because a customer who is told "your
 *     account was created" and then finds none would be right to complain.
 *   - PHONE (Telegram): `/register` REFUSES a phone by name
 *     (`PHONE_REQUIRES_VERIFICATION`), so article 6.2 states the rule the
 *     refusal enforces — no phone is stored before ownership is proven.
 *   - ONE-TIME CODE (WhatsApp or email): ten minutes, five attempts, a sixty
 *     second resend cooldown. Stated as figures because they ARE in the code.
 *   - GOOGLE: an ID token verified against Google's JWKS, which is why article
 *     6.4 refuses to let such an account change its address here.
 *
 * ENUMERATION SAFETY IS A PROMISE TO THE CUSTOMER, so it is written as one
 * (5.10): the identical answer for a free and a taken address is a deliberate
 * property of the code, and a customer who is told "we do not disclose whether
 * an address has an account" can rely on it.
 *
 * CHAPTER 11 IS DELIBERATELY HONEST ABOUT A MISSING ROUTE. There is no
 * self-service account deletion endpoint in this codebase. So closure is
 * written as a request to Support, which is what actually happens, rather
 * than as a button that does not exist. Promising the button would be the
 * one failure this corpus cannot afford.
 *
 * RETENTION PERIODS ARE PLACEHOLDERS. The code keeps orders, ledger entries,
 * policy acceptances and audit rows indefinitely; how long the owner intends
 * to keep them is a decision, not a fact readable from a schema.
 */
export const registration: PolicyDocument = {
  key: 'registration',
  version: 1,
  effective_at: '2026-01-01',
  title: {
    ar: 'سياسة التسجيل والحسابات',
    en: 'Registration and Accounts Policy',
    ckb: 'سیاسەتی تۆمارکردن و هەژمارەکان',
  },
  body: {
    ar: `## 1. التمهيد والنطاق والتعريفات

### 1.1 الغرض من هذه الوثيقة
تبيّن هذه الوثيقة من يجوز له فتح حساب على منصة ليفونيس، وما يلتزم به صاحب الحساب، وكيف تُثبت ملكية البريد أو رقم الهاتف ولماذا يصرّ المتجر على إثباتها، وكيف تُحفظ بيانات الدخول ومن يتحمل الخسارة عند إفشائها، وما يوقف الحساب أو يغلقه، وكيف يغلق الزبون حسابه، وما يبقى عند المتجر بعد الإغلاق وإلى متى.

### 1.2 الأطراف
المتجر: {{LEVONIS_LEGAL_NAME}}، المسجل برقم {{LEVONIS_REGISTRATION_NO}}. وصاحب الحساب: كل شخص فُتح باسمه حساب على المنصة، زبوناً كان أو تاجراً.

### 1.3 التعريفات
- الحساب: السجل الذي يجمع هوية الشخص على المنصة وطلباته ومحفظته ونقاطه ووحدات ضمانه.
- المعرّف: البريد الإلكتروني أو رقم الهاتف الذي يُعرف به الحساب ويُستعمل للدخول وللاسترجاع.
- القناة الموثقة: معرّف أثبت صاحب الحساب ملكيته بإجراء من إجراءات الفصل الخامس.
- اسم المستخدم: الاسم العلني المختصر الذي يُعرف به صاحب الحساب داخل المنصة وفي رابط الإحالة.
- الاسم الظاهر: الاسم الذي يُعرض إلى جانب نشاط صاحب الحساب.
- كلمة المرور: السر الذي يختاره صاحب الحساب للدخول.
- الجلسة: الحالة التي يظل فيها المتصفح معروفاً للمنصة بعد الدخول.
- الجلسة الحديثة: جلسة لم يمض على بدئها إلا وقت قصير، تُشترط لبعض العمليات الحساسة.
- الرمز لمرة واحدة: رقم قصير يُرسل إلى قناة ليثبت حائزه أنها له.
- الرابط ذو الاستعمال الواحد: رابط يُرسل إلى بريد ليُثبت ملكيته أو ليُغيّر كلمة المرور، ولا يعمل بعد استعماله.
- الإيقاف: منع الدخول أو منع بعض الأفعال مع بقاء الحساب وسجله.
- الإغلاق: إنهاء الحساب على نحو لا رجعة فيه.

### 1.4 النص المعتمد
النص العربي هو النص المعتمد. والنسختان الإنكليزية والكردية ترجمتان أمينتان له بالترقيم نفسه مادة بمادة، وعند الاختلاف في التفسير يُرجع إلى النص العربي.

### 1.5 علاقة هذه الوثيقة بغيرها
تُقرأ مع الشروط والأحكام العامة، وسياسة الخصوصية، وسياسة الدفع والمحفظة، وسياسة مجتمع ليفو، وسياسة العضويات، وسياسة المكافآت.

### 1.6 قبول الوثيقة
فتح حساب أو الدخول إليه أو استعماله قبول بهذه الوثيقة بنسختها النافذة وقت الاستعمال.

## 2. من يجوز له أن يفتح حساباً

### 2.1 السن
لا يُفتح حساب لمن هو دون {{MIN_ACCOUNT_AGE_YEARS}} سنة. ومن كان دون سن الرشد القانونية فلا يتعاقد ولا يشتري إلا بموافقة وليّه، والوليّ مسؤول عن كل تصرف يقع على الحساب.

### 2.2 الأهلية
يشترط في صاحب الحساب أن يكون كامل الأهلية للتعاقد. وللمتجر أن يمتنع عن فتح حساب أو عن الاستمرار فيه إذا تبيّن انتفاء الأهلية.

### 2.3 الحساب شخصي
الحساب شخصي لصاحبه، وما يقع عليه من فعل يُنسب إليه. ولا يجوز فتح حساب باسم شخص آخر ولا انتحال هويته ولا استعمال بياناته.

### 2.4 حساب باسم منشأة
يجوز فتح حساب لحساب منشأة تجارية، على أن يديره شخص طبيعي مفوَّض بذلك. والمنشأة وممثلها متضامنان فيما يقع على الحساب.

### 2.5 الحساب لا يُنقل
لا يُباع الحساب ولا يُؤجَّر ولا يُهدى ولا تُنقل ملكيته. ولا ينتقل ما فيه من رصيد أو نقاط أو وحدات ضمان أو شارة إلى شخص آخر.

### 2.6 حق المتجر في الامتناع
للمتجر أن يمتنع عن فتح حساب، أو عن قبول معرّف بعينه، لسبب مقرر يتصل بأمن المنصة أو بحماية زبائنها أو بمخالفة سابقة، دون أن يكون ملزماً ببيان تفصيل السبب إذا كان بيانه يضر بذلك الأمن.

### 2.7 الحساب المفتوح بالمخالفة
الحساب الذي فُتح بالمخالفة لهذا الفصل يُعامل معاملة الحساب المخالف في الفصل العاشر، ولا ينشئ لصاحبه حقاً يحتج به.

## 3. حساب واحد للشخص الواحد

### 3.1 القاعدة
للشخص الواحد حساب واحد على المنصة.

### 3.2 لماذا هذه القاعدة
لأن المحفظة، ووحدات الضمان، ونقاط المكافآت، وحدود العروض، وحساب الإحالة، والعضوية، كلها مربوطة بالشخص لا بالجهاز ولا بالبريد. وتعدد الحسابات يجعل ميزة وُضعت لشخص واحد تُؤخذ مرات، ويجعل حداً وُضع للحماية بلا معنى.

### 3.3 تعدد الحسابات
فتح حسابات متعددة للشخص الواحد مخالفة. ويُعامل معها المتجر بدمج ما يمكن دمجه أو بإيقاف الحسابات الزائدة، وبسحب ما استُفيد منه بغير وجه حق.

### 3.4 الإحالة الذاتية
لا تُحتسب إحالة من شخص إلى نفسه، ولا إحالة بحساب ثانٍ فتحه المُحيل. والإحالة تُربط مرة واحدة عند إنشاء الحساب ولا تُنقل بعدها إلى مُحيل آخر.

### 3.5 استعمال حساب الغير
لا يجوز الدخول إلى حساب لا يملكه المستعمل، ولو بإذن صاحبه. وما يقع على الحساب يُنسب إلى صاحبه وحده وفق المادة 8.8.

### 3.6 الاستثناء
لا يُستثنى من هذا الفصل إلا بإذن مكتوب مسبق من المتجر، وبحدود ما يقرره الإذن.

## 4. صحة البيانات

### 4.1 الالتزام بالصدق
يلتزم صاحب الحساب بأن تكون كل بياناته صحيحة وحديثة: اسمه، وبريده، ورقمه، وعناوين تسليمه.

### 4.2 البيانات المطلوبة عند الإنشاء
يُطلب عند الإنشاء بحسب طريق التسجيل: بريد إلكتروني أو رقم هاتف، واسم ظاهر، وكلمة مرور في الطرق التي تقتضيها، واسم مستخدم اختياري، وبلد ولغة اختياريتان. ولا يمنع اختيار بلد غير معروف إنشاء الحساب بل يُسجَّل بأنه لم يُحدَّد.

### 4.3 عنوان التسليم
عنوان التسليم مسؤولية صاحب الحساب. وأثر العنوان الناقص أو الخاطئ — من تأخير أو تعذر تسليم أو أجرة محاولة ثانية — عليه وفق سياسة التوصيل.

### 4.4 تحديث البيانات
يلتزم صاحب الحساب بتحديث بياناته كلما تغيّرت، وعلى الأخص رقمه وبريده، لأنهما قناتا الاسترجاع والإشعار.

### 4.5 أثر البيانات غير الصحيحة
البيانات غير الصحيحة قد يترتب عليها: تعذر التسليم، وتعذر الاسترجاع، ورفض طلب، وتقييد الحساب. والمتجر غير مسؤول عن نتيجة بيان أدلى به صاحب الحساب على خلاف الحقيقة.

### 4.6 التحقق عند الشك
للمتجر أن يطلب إثبات هوية أو إثبات ملكية وسيلة دفع أو إثبات عنوان عند الشك في صحة بيان أو عند تعامل غير معتاد، وأن يوقف تنفيذ طلب إلى حين ورود الإثبات.

## 5. طرق إنشاء الحساب والتحقق منه

### 5.1 الطرق المتاحة
يُفتح الحساب بإحدى الطرق الآتية بحسب ما هو مفعّل على المنصة: بالبريد الإلكتروني، أو برقم الهاتف عبر تيليغرام، أو برمز لمرة واحدة يصل عبر واتساب أو البريد، أو بحساب غوغل. وما هو مفعّل فعلاً يُعلن في شاشة الدخول، فما لا يستطيع المتجر تنفيذه لا يُعرض على الزبون.

### 5.2 التسجيل بالبريد: الحساب يولد بعد إثبات البريد
عند التسجيل ببريد إلكتروني لا يُنشأ حساب في تلك اللحظة ولا تُخزَّن كلمة مرور. تُحفظ محاولة التسجيل مؤقتاً وتُرسل رسالة إلى البريد تتضمن رابطاً. ومن يفتح الرابط يختار كلمة المرور، وعند ذلك — لا قبله — يُنشأ الحساب ويُثبَّت اسم المستخدم إن كان لا يزال متاحاً، وتُفتح الجلسة.

### 5.3 صلاحية رابط التسجيل
رابط التسجيل صالح أربعاً وعشرين ساعة، ويُستعمل مرة واحدة. والتسجيل من جديد بالبريد نفسه يُلغي المحاولة السابقة ويصدر رابطاً جديداً، فلا يُتم التسجيلَ إلا آخرُ محاولة.

### 5.4 من يزرع تسجيلاً لبريد غيره
لا يكسب شيئاً: لم تُجمع كلمة مرور، وصاحب البريد إما أن يهمل الرسالة فلا يقع شيء، وإما أن يفتح الرابط ويختار كلمة مروره هو.

### 5.5 التسجيل برقم الهاتف
لا يُقبل تسجيل برقم هاتف عبر مسار البريد، لأن ذلك المسار لا يتضمن إثباتاً لملكية الرقم. والتسجيل بالرقم يجري عبر تيليغرام: يُفتح رابط بالتطبيق، ويثبت صاحب الرقم ملكيته من داخله، ويُرسل رمز، وعند التحقق تُقبل كلمة المرور ويُنشأ الحساب. ومدة صلاحية هذه المحاولة خمس عشرة دقيقة.

### 5.6 الرمز لمرة واحدة
يُرسل الرمز إلى واتساب أو إلى البريد بحسب اختيار صاحب الحساب. وهو صالح عشر دقائق، وله خمس محاولات إدخال، ولا يُعاد إرساله قبل مضي ستين ثانية. واستنفاد المحاولات يبطل الرمز ويستلزم طلب رمز جديد.

### 5.7 الدخول بالرمز والتسجيل به
إذا كان المعرّف يخص حساباً قائماً فُتحت الجلسة. وإذا لم يكن يخص حساباً وكان الطلب من شاشة التسجيل، صار الرمز إثباتاً لملكية القناة، وأُعطي تذكرة صالحة خمس عشرة دقيقة لإتمام إنشاء الحساب. واستلام الرمز على البريد يُعد إثباتاً لملكيته يُغني عن رابط التحقق.

### 5.8 الدخول بحساب غوغل
يجوز الدخول بحساب غوغل، ويتحقق المتجر من صحة ما يصدره غوغل بنفسه. والبريد في هذا الطريق يقرره غوغل ويؤكده عند كل دخول.

### 5.9 لماذا يصرّ المتجر على التوثيق
لأن المعرّف الموثق هو: قناة استرجاع الحساب عند نسيان كلمة المرور، وقناة إبلاغ صاحب الحساب بحركة على محفظته أو بمحاولة دخول، وأساس القول إن الطلب صدر عن صاحب الحساب، والوسيلة التي يميّز بها المتجر الشخص عن الشخص فيمنع تعدد الحسابات. ومعرّف غير موثق لا يصلح لأي من ذلك، فقبوله يعني حساباً لا يُسترجع وطلباً لا يُنسب.

### 5.10 المتجر لا يكشف وجود الحساب
لا تكشف المنصة عمّا إذا كان بريد أو رقم يخص حساباً. فالجواب على محاولة تسجيل ببريد مسجَّل وعلى محاولة تسجيل ببريد غير مسجَّل واحد في نصه وفي أثره الظاهر، ولا يعلم صاحب البريد أن أحداً حاول إلا من صندوقه هو. وكذلك في طلب استعادة كلمة المرور وفي طلب الرمز.

### 5.11 بريد غير حقيقي
الحساب المفتوح برقم الهاتف قد يحمل بريداً بديلاً لا يصل إليه شيء. ولا يُدّعى في هذه الحال أن رسالة تحقق أُرسلت، بل يُطلب من صاحب الحساب إضافة بريد حقيقي أولاً.

### 5.12 قناة غير متاحة
إذا لم تكن قناة مهيأة على المنصة، أو كانت متوقفة عن العمل، قيل ذلك صراحة وسُمّيت قناة بديلة. ولا يُقال «حاول لاحقاً» عن عطل لا يصلحه الانتظار.

### 5.13 حدود الطلب
لكل من التسجيل وطلب الرمز وطلب رابط التحقق وطلب استعادة كلمة المرور حد لعدد المحاولات في الساعة وفي اليوم، للمصدر وللوجهة معاً، حتى لا يُغرق بريد أحد ولا رقمه برسائل لم يطلبها.

## 6. البريد والرقم بوصفهما مفتاح هوية

### 6.1 شكل الرقم
يُقبل رقم الهاتف العراقي بصيغته المعتادة، وتُقبل الأرقام العربية الهندية وتُحوَّل. وما لا يصلح رقماً يُرفض في حينه مع بيان الشكل المطلوب.

### 6.2 لا يُخزَّن رقم قبل إثبات ملكيته
لا يُسجَّل رقم هاتف على حساب إلا بعد إثبات ملكيته. ورقم يُكتب في نموذج من غير إثبات لا يُخزَّن ولا يُعتد به.

### 6.3 تغيير البريد بالتحقق لا بالإعلان
لا يتغيّر بريد الحساب بمجرد طلبه. يُرسل رابط تحقق إلى البريد الجديد، ولا يُنقل الحساب إليه إلا بفعل صريح من داخل ذلك البريد. ويبقى البريد القديم عاملاً إلى أن يقع ذلك، لئلا يُقفل الحساب بخطأ مطبعي.

### 6.4 إعادة التوثيق عند تغيير البريد
يُشترط لتغيير البريد: كلمة المرور الحالية إن كان للحساب كلمة مرور، أو جلسة حديثة إن لم تكن له. والحساب الذي يدخل بغوغل لا يُغيَّر بريده من هنا، لأن بريده يقرره غوغل، وتغييره هنا يقطع صلة الدخول في صمت.

### 6.5 البريد المستعمل على حساب آخر
لا يُنقل الحساب إلى بريد يخص حساباً آخر. ويُبلَّغ الطالب بجواب واحد لا يكشف ما إذا كان البريد مستعملاً، ولا يُرسَل رابط في هذه الحال.

### 6.6 تغيير الرقم
يجري تغيير رقم الهاتف بالإجراء نفسه الذي يُثبت به ابتداءً: إثبات ملكية الرقم الجديد قبل ربطه.

### 6.7 معرّف انتقل إلى شخص آخر
إذا انتقل رقم أو بريد إلى شخص آخر — بإعادة تخصيص من المزوّد أو بغيرها — فعلى صاحب الحساب أن يزيله عن حسابه فوراً. وإذا تبيّن للمتجر أن معرّفاً لم يعد لصاحبه، جاز له فصله عن الحساب وطلب معرّف بديل قبل أي عملية حساسة.

### 6.8 الرمز يُقيَّم وقت استعماله
إثبات ملكية القناة يعني أن حائز الرمز يسيطر على تلك القناة. أما إلى مَن تعود القناة فيُقرَّر لحظة الاستعمال لا لحظة الإرسال. فإن تغيّر صاحب القناة بين الأمرين رُفض الرمز.

## 7. قنوات الإشعار ورموز الأمان

### 7.1 القنوات
قنوات الإشعار: داخل التطبيق، وتيليغرام، وواتساب، والبريد الإلكتروني. ولصاحب الحساب أن يختار ما يُفعّله منها وأن يختار قناته المفضّلة، وله أن يطفئها جميعاً عدا ما نصت عليه المادة 7.6.

### 7.2 التفعيل ليس جاهزية
تفعيل قناة رغبةٌ لا قدرة. فالقناة لا تعمل إلا إذا كانت مهيأة على المنصة وكانت بيانات صاحب الحساب فيها موثقة. ويُعرض لصاحب الحساب بيان القناة الجاهزة من غير الجاهزة، لا أن يُترك يظن أنه سيُبلَّغ وهو لن يُبلَّغ.

### 7.3 ما يُرسل عبر القنوات
يُرسل عبرها: رموز الدخول والتحقق، وروابط الاسترجاع، وإشعارات الطلب ومراحله، وإشعارات المحفظة، وإشعارات الأمان، وإشعارات الشكاوى، وما يختاره صاحب الحساب من إشعارات أخرى.

### 7.4 الرمز سرّ
الرمز والرابط سرّ لصاحب الحساب وحده. ولا يطلبهما المتجر ولا أي من موظفيه في محادثة ولا في مكالمة ولا في رسالة، بأي حال. وكل من طلبهما منتحل مهما بدا.

### 7.5 رسالة لم تُطلب
من وصله رمز أو رابط لم يطلبه فلا يستعمله، وليبلّغ {{LEVONIS_SUPPORT_CONTACT}}. ووصول رمز إلى قناة لا يعني أن حساباً قائماً عليها.

### 7.6 إشعارات لا تُطفأ
لا تُطفأ الإشعارات المتعلقة بأمان الحساب، ولا الإشعارات المتعلقة بحركة المحفظة، ولا الإشعارات المتعلقة بشكوى مقدَّمة على صاحب الحساب أو منه، ولا الإشعارات المتعلقة بانقضاء اشتراك يترتب عليه أثر. لأنها تقرر مالاً ومركزاً.

### 7.7 الرسائل التسويقية
الرسائل التسويقية اختيارية، وتُوقَف بطلب صاحب الحساب في أي وقت، ولا يترتب على إيقافها منع خدمة ولا نقص في حق.

### 7.8 تكلفة القناة
ما تفرضه شركة الاتصال أو مزوّد الخدمة على صاحب الحساب مقابل استلام رسالة شأنه معهم، ولا يتحمله المتجر.

## 8. كلمة المرور والجلسات وحفظ بيانات الدخول

### 8.1 كلمة المرور
كلمة المرور لا تقل عن ثمانية محارف ولا تزيد على مئة وثمانية وعشرين. ويُنصح بألا تكون مستعملة على موقع آخر ولا مشتقة من اسم أو تاريخ ميلاد أو رقم هاتف.

### 8.2 كيف تُحفظ
لا تُخزَّن كلمة المرور نصاً. تُخزَّن بصيغة مشتقة لا يُستخرج منها الأصل، ولا يستطيع أحد في المتجر أن يقرأها ولا أن يخبر بها صاحبها.

### 8.3 تغيير كلمة المرور
يُشترط لتغيير كلمة المرور: كلمة المرور الحالية إن وُجدت، أو جلسة حديثة إن كان الحساب بلا كلمة مرور. ولا تكفي الجلسة القديمة وحدها لعملية بهذا الأثر.

### 8.4 استعادة كلمة المرور
تُستعاد بطلب رابط يُرسل إلى بريد الحساب. والرابط صالح ثلاثين دقيقة ويُستعمل مرة واحدة، ويبطل بعد استعماله أو بانقضاء مدته أو بإصدار رابط أحدث منه.

### 8.5 جواب طلب الاستعادة
جواب طلب الاستعادة واحد في كل حال، سواء أكان البريد يخص حساباً أم لا، عملاً بالمادة 5.10.

### 8.6 الجلسة ومدتها
تبقى الجلسة أربعة عشر يوماً من فتحها ثم تنتهي. وتُحفظ في ملف تعريف لا يقرأه برنامج الصفحة، فلا يُستخرج منها رمز يُنسخ إلى مكان آخر.

### 8.7 الجلسة الحديثة
تُشترط جلسة حديثة — لم يمض على بدئها أكثر من عشر دقائق — للعمليات التي تغيّر قناة الاسترجاع أو سرّ الدخول في الحسابات التي لا كلمة مرور لها. والغرض أن يكون فاعل هذه العمليات قد أثبت نفسه للتو لا قبل أسبوعين.

### 8.8 الخروج من الجلسات
لصاحب الحساب أن يخرج من جلسته، وله أن ينهي جلساته كلها على كل الأجهزة. ويُنصح بذلك عند فقدان جهاز أو الشك في اطلاع أحد على كلمة المرور.

### 8.9 حفظ بيانات الدخول ومن يتحمل الخسارة
صاحب الحساب مسؤول عن حفظ كلمة مروره ورموزه وعن كل ما يقع على حسابه. ومن أفشى كلمة مروره أو رمزه، أو مكّن غيره من حسابه، أو تركه مفتوحاً على جهاز مشترك، تحمّل وحده ما ترتب على ذلك من طلب أو خصم من محفظة أو استعمال لنقاطه أو لوحدات ضمانه، ولا يرجع بشيء منه على المتجر.

### 8.10 الجهاز المشترك
لا يُنصح بالدخول من جهاز عام أو مشترك، ومن فعل فعليه الخروج من الجلسة عند انتهائه، لأن الجلسة تبقى قائمة ولو أُغلقت الصفحة.

### 8.11 الإبلاغ عن اختراق
من اشتبه في دخول غير مصرّح به إلى حسابه فليغيّر كلمة مروره فوراً، ولينهِ جلساته كلها، وليبلّغ {{LEVONIS_SUPPORT_CONTACT}} من غير تأخير. والإبلاغ المبكر هو ما يتيح للمتجر إيقاف حركة قائمة أو استرجاع مبلغ لم يُصرف بعد.

### 8.12 حدود ما يستطيعه المتجر بعد الاختراق
ما نُفّذ فعلاً وسُلّم أو صُرف قد يتعذّر استرجاعه. والمتجر يبذل ما في وسعه ولا يضمن نتيجة في اختراق سببه إفشاء من صاحب الحساب.

## 9. الاسم واسم المستخدم وقواعد المحتوى

### 9.1 الاسم الظاهر
يكون الاسم الظاهر اسماً يصح عرضه أمام الآخرين. ويُمنع ما هو بذيء أو مسيء أو موهم بصفة رسمية.

### 9.2 اسم المستخدم: الشكل
اسم المستخدم من ثلاثة محارف إلى ثلاثين، بحروف لاتينية صغيرة وأرقام والنقطة والشرطة والشرطة السفلية. ولا يبدأ ولا ينتهي بعلامة، ولا تتكرر فيه علامتان متجاورتان، ولا يكون أرقاماً كلها. ويُخزَّن بحروف صغيرة، فالاختلاف في حالة الأحرف لا ينشئ اسمين.

### 9.3 الأسماء المحجوزة
تُحجز أسماء المستخدمين التي تدل على المنصة أو على موظفيها أو على أقسام الموقع، مثل ما يشير إلى ليفونيس أو الدعم أو الإدارة أو المحفظة أو الطلبات. لأن رسالة من اسم كهذا تُقرأ على أنها من المتجر.

### 9.4 الأسماء غير اللائقة
يُرفض الاسم أو اسم المستخدم البذيء أو المسيء. ويُقاس ذلك على الكلمة بمعناها لا على تشابه حروف عارض، فلا يُرفض اسم سليم لأن حروفه توافق جزءاً من كلمة أخرى.

### 9.5 انتحال الصفة
يُمنع انتحال صفة المتجر أو موظفيه أو تاجر آخر أو علامة تجارية، بالاسم أو بالصورة أو بالوصف. ومن فعل أُوقف حسابه فوراً.

### 9.6 اسم المستخدم رابط إحالة
اسم المستخدم هو المقبض العلني للإحالة. ولذلك يجوز لأي أحد أن يستعلم عن كونه متاحاً، ولا يُعد ذلك كشفاً لبيان خاص.

### 9.7 تغيير اسم المستخدم وأثره
يجوز تغيير اسم المستخدم مرة كل أربعة عشر يوماً. والإحالات التي تمت تبقى مربوطة بصاحبها بغض النظر عن الاسم، فلا تنتقل إلى غيره. لكن رابط إحالة يحمل الاسم القديم يكفّ عن نسب الإحالة إلى صاحبه الأول بعد التغيير — فإن أخذ شخص آخر الاسم نُسبت إليه، وإلا لم تُنسب إلى أحد. والمعرّف الذي لا ينتقل هو رمز الإحالة الخاص بالحساب، وهو يبقى عاملاً لهذا السبب.

### 9.8 الصور والمحتوى
صاحب الحساب مسؤول عن كل ما يرفعه: صورته الشخصية، وصور تقييماته، ومرفقات طلباته. ويُمنع فيها ما يمنعه القانون، وما ينتهك حق غيره، وما هو بذيء أو يحوي بيانات شخص آخر.

### 9.9 ملكية ما يُرفع
يبقى ما يرفعه صاحب الحساب ملكاً له. ويمنح المتجر رخصة استعماله بالقدر اللازم لتشغيل الخدمة: عرض صورته في ملفه، وعرض صور تقييمه على صفحة المنتج، وتسليم مرفق الطلب إلى التاجر المنفّذ.

### 9.10 حق المتجر في التصحيح
للمتجر أن يُزيل اسماً أو صورة أو محتوى مخالفاً، وأن يطلب من صاحب الحساب تغييره، وأن يوقف الحساب عند الامتناع أو التكرار.

## 10. ما يوقف الحساب أو يغلقه

### 10.1 درجات الإجراء
للحساب أربع حالات: فعّال، ومقيَّد، وموقوف، ومغلق. المقيَّد يفقد بعض الأفعال، والموقوف يُمنع من الدخول أو من التعامل، والمغلق منتهٍ لا رجعة فيه.

### 10.2 أسباب التقييد
يقيَّد الحساب عند: الشك في تعدد الحسابات، أو الاشتباه في استعمال غير معتاد للعروض والكوبونات، أو تكرار رفض الاستلام من غير سبب، أو نزاع قائم يقتضي وقف بعض الأفعال حتى يُفصل فيه.

### 10.3 أسباب الإيقاف
يوقَف الحساب عند: الاحتيال أو محاولته، أو استعمال وسيلة دفع لا يملكها، أو انتحال صفة، أو تهديد أو ابتزاز عضو أو موظف، أو نشر محتوى يحظره القانون، أو محاولة اختراق المنصة أو اختبار ثغراتها بغير إذن، أو استغلال خلل تقني لمنفعة، أو التلاعب بالتقييمات أو بنظام الإحالة أو بنظام النقاط، أو مخالفة جسيمة لسياسة مجتمع ليفو.

### 10.4 أسباب الإغلاق
يُغلق الحساب عند تكرار ما يوجب الإيقاف، أو عند ثبوت احتيال جسيم، أو بطلب من صاحبه وفق الفصل الحادي عشر، أو تنفيذاً لأمر من جهة مختصة.

### 10.5 الإجراء الفوري
للمتجر أن يقيّد أو يوقف فوراً ودون إنذار سابق إذا كان في التأخير ضرر على زبائن أو على أموالهم أو على سلامة المنصة، ثم يبلّغ صاحب الحساب بما جرى.

### 10.6 الإبلاغ والتظلم
يُبلَّغ صاحب الحساب بالإجراء وبسببه بالقدر الذي لا يضر بأمن المنصة. وله أن يتظلم خلال {{ACCOUNT_APPEAL_DAYS}} من إبلاغه إلى {{LEVONIS_SUPPORT_CONTACT}}، ويُبت في تظلمه خلال {{DISPUTE_RESPONSE_DAYS}}.

### 10.7 أثر الإيقاف على الطلبات القائمة
الطلب المدفوع الذي لم يُسلَّم بعد يُنفَّذ أو يُلغى ويُرد ثمنه. ولا يُتخذ الإيقاف سبباً لحجز بضاعة دُفع ثمنها ولا لإسقاط حق ثابت لصاحب الحساب، إلا بقدر ما يقتضيه فحص واقعة احتيال.

### 10.8 أثر الإيقاف على المحفظة
يبقى رصيد المحفظة ملكاً لصاحبه. وللمتجر أن يحتجز الصرف منه إلى حين انتهاء فحص أو نزاع، وأن يخصم منه ما ثبت أنه مستحق لطرف آخر بقرار مسبب.

### 10.9 أثر الإيقاف على المكافآت والعضوية
يوقَف صرف النقاط ومزايا العضوية مدة الإيقاف. وتُسقط النقاط والمزايا التي ثبت أنها اكتُسبت بالمخالفة.

### 10.10 أثر الإيقاف على متجر التاجر
إذا كان صاحب الحساب تاجراً، طُبّقت عليه فوق ذلك أحكام الفصل الحادي عشر من سياسة مجتمع ليفو.

## 11. إغلاق الزبون لحسابه

### 11.1 الحق في الإغلاق
لصاحب الحساب أن يغلق حسابه متى شاء.

### 11.2 كيف يُطلب الإغلاق
يُقدَّم طلب الإغلاق إلى {{LEVONIS_SUPPORT_CONTACT}} من القناة الموثقة المسجلة على الحساب. ولا يُنفَّذ طلب ورد من قناة غير موثقة ولا من غير صاحب الحساب.

### 11.3 التثبت قبل التنفيذ
يتثبت المتجر من هوية الطالب قبل التنفيذ — برمز إلى القناة الموثقة أو بما يقوم مقامه — لأن إغلاق حساب بناءً على طلب منتحل خسارة لا تُستدرك.

### 11.4 الطلبات القائمة
لا يُنفَّذ الإغلاق ولمصاحبه طلب قائم لم يُسلَّم أو لم يُرد ثمنه، ولا نزاع أو شكوى لم يُفصل فيها، ولا طلب إرجاع أو مطالبة ضمان قيد النظر. ويُؤجَّل التنفيذ حتى تنتهي هذه، أو يُلغى الطلب القائم ويُرد ثمنه بموافقة صاحب الحساب.

### 11.5 رصيد المحفظة
على صاحب الحساب أن يتصرف في رصيده قبل الإغلاق. وله أن يطلب صرف الرصيد القابل للصرف وفق سياسة الدفع والمحفظة، فما كان منه إيداعاً نقدياً قابلاً للاسترجاع يُرد إليه، وما كان رصيداً ترويجياً أو هدية أو تعويضاً ممنوحاً فلا يُصرف نقداً ويسقط بالإغلاق. وللمطالبة بالرصيد بعد الإغلاق مهلة {{WALLET_BALANCE_CLAIM_DAYS}} تُقدَّم خلالها إلى {{LEVONIS_SUPPORT_CONTACT}}.

### 11.6 وحدات الضمان
وحدات الضمان وتمديداته مربوطة بالقطعة المشتراة وبفاتورتها، لا بوجود الحساب. ومن أغلق حسابه فله أن يطالب بضمان قطعته بفاتورتها ورقم طلبها وفق سياسة الضمان، ما دامت مدة الضمان سارية. غير أن إغلاق الحساب يُفقده الوصول الذاتي إلى سجل مشترياته، فعليه أن يحتفظ بفواتيره قبل الإغلاق.

### 11.7 النقاط والمزايا
تسقط بالإغلاق نقاط المكافآت، والرصيد الترويجي، والقسائم، وما تبقى من مدة عضوية، ولا تُحوَّل إلى مال ولا إلى حساب آخر.

### 11.8 الإحالات
تبقى الإحالات التي تمت مسجلة كوقائع، ولا تُعاد إلى المُحيل ولا تُنقل إلى غيره. ويكفّ رابط إحالة صاحب الحساب المغلق عن العمل.

### 11.9 متجر التاجر
من كان تاجراً فلا يُغلق حسابه قبل إغلاق متجره وتسوية طلباته القائمة ونزاعاته ومستحقاته وتحويل رصيده المتاح.

### 11.10 مهلة التنفيذ
يُنفَّذ الإغلاق خلال {{ACCOUNT_CLOSURE_PROCESSING_DAYS}} من اكتمال شروطه. ولصاحب الحساب أن يعدل عن طلبه قبل التنفيذ.

### 11.11 لا رجعة بعد التنفيذ
الحساب المغلق لا يُعاد فتحه ولا يُسترجع محتواه. ومن أراد التعامل بعدها فتح حساباً جديداً، ولا ينتقل إليه شيء من القديم.

### 11.12 اسم المستخدم بعد الإغلاق
لا يُطلق اسم المستخدم فور الإغلاق، بل يبقى محجوزاً مدة {{USERNAME_RELEASE_DAYS}} حتى لا يلتقطه غيره فيبدو وكأنه صاحبه الأول.

## 12. ما يبقى بعد الإغلاق ولماذا وإلى متى

### 12.1 القاعدة
يُحذف من بيانات الحساب ما لا يلزم بقاؤه، ويبقى ما يلزم لإثبات معاملة وقعت فعلاً أو لتنفيذ التزام قانوني أو للدفاع عن حق.

### 12.2 الطلبات والفواتير
تبقى الطلبات والفواتير وما يتصل بها من مبالغ وضرائب وأجور توصيل، لأنها مستندات محاسبية ودليل على بيع تم. وتُحفظ مدة {{ORDER_RECORD_RETENTION_YEARS}}.

### 12.3 سجل المحفظة
تبقى قيود المحفظة — الإيداع والخصم والحجز والاسترجاع — لأن رصيداً لا يُفسَّر بقيوده لا يمكن مراجعته. وتُحفظ مدة {{WALLET_RECORD_RETENTION_YEARS}}.

### 12.4 سجل قبول السياسات
يبقى سجل موافقة صاحب الحساب على السياسات ونص النسخة التي وافق عليها، لأن موافقة لا يمكن إبراز نصها بعد سنوات لا قيمة لها. ويُحفظ مدة {{POLICY_ACCEPTANCE_RETENTION_YEARS}}.

### 12.5 سجل التدقيق
تبقى سجلات الأمان والتدقيق — محاولات الدخول والتغييرات الحساسة والقرارات الإدارية — مدة {{AUDIT_LOG_RETENTION_YEARS}}، وهي مكتوبة أصلاً ببيانات مقنّعة لا تصلح قائمة مراسلة.

### 12.6 المحادثات
تبقى الرسائل المتصلة بطلب أو بنزاع مدة {{CHAT_RETENTION_YEARS}} لأنها دليل الطرفين. وبقاؤها لا يعني اطلاعاً عليها، وتبقى محكومة بأحكام الفصل السادس من سياسة مجتمع ليفو.

### 12.7 التقييمات
يبقى التقييم المنشور بعد إغلاق حساب كاتبه، ويُفصل عن هويته فلا يُنسب إليه بالاسم. لأن حذفه يحرّف صورة تاجر كوّنها زبائن حقيقيون.

### 12.8 الحذف مقابل إخفاء الهوية
حيث يمكن الحذف يُحذف. وحيث لا يمكن — لأن السطر نفسه دليل على معاملة — تُفصل البيانات الشخصية عنه ويبقى السطر بلا هوية.

### 12.9 النسخ الاحتياطية
قد تبقى البيانات في نسخ احتياطية مدة يسيرة بعد حذفها من النظام العامل، حتى تنتهي دورة تلك النسخ. ولا تُستعمل هذه النسخ إلا لاسترجاع عطل.

### 12.10 الإحالة إلى سياسة الخصوصية
تفصيل ما يُجمع ولماذا وكيف يُحمى وحقوق صاحب البيانات في الوصول والتصحيح والاعتراض موضعه سياسة الخصوصية، وتُقرأ هذه المواد معها.

## 13. أحكام عامة وختامية

### 13.1 التعديل
للمتجر تعديل هذه السياسة بإصدار نسخة جديدة برقم وتاريخ نفاذ. ويُبلَّغ صاحب الحساب بالتعديل الجوهري عبر قناته الموثقة، ولا يسري التعديل بأثر رجعي على واقعة تمت قبل نفاذه.

### 13.2 استقلال البنود
بطلان بند لا يمس صحة سائر البنود.

### 13.3 اللغة
عند اختلاف النسخ الثلاث يُرجع إلى النص العربي وفق المادة 1.4.

### 13.4 الإحالة
ما لم يرد فيه نص هنا يُرجع فيه إلى الشروط والأحكام العامة وإلى السياسة المختصة بموضوعه.

### 13.5 القانون والاختصاص
تخضع هذه الوثيقة لقوانين {{GOVERNING_LAW_JURISDICTION}}، والاختصاص لمحاكم {{COMPETENT_COURT}}.

### 13.6 نقطة الاتصال
نقطة الاتصال المعتمدة {{LEVONIS_SUPPORT_CONTACT}}، وأوقات العمل {{LEVONIS_SUPPORT_HOURS}}، والعنوان {{LEVONIS_ADDRESS}}.`,
    en: `## 1. Preamble, Scope and Definitions

### 1.1 Purpose of this document
This document states who may open an account on the LEVONIS platform, what the account holder undertakes, how ownership of an email address or a phone number is proven and why the Store insists on proving it, how credentials are to be kept and who bears a loss when they are disclosed, what suspends or closes an account, how a customer closes their own account, and what the Store keeps after closure and for how long.

### 1.2 The parties
The Store: {{LEVONIS_LEGAL_NAME}}, registered under number {{LEVONIS_REGISTRATION_NO}}. The account holder: any person in whose name an account has been opened on the platform, whether customer or merchant.

### 1.3 Definitions
- Account: the record that brings together a person's identity on the platform with their orders, their wallet, their points and their warranty units.
- Identifier: the email address or phone number by which an account is known and which is used for signing in and for recovery.
- Verified channel: an identifier whose ownership the account holder has proven by one of the procedures in Chapter 5.
- Username: the short public handle by which an account holder is known inside the platform and in their referral link.
- Display name: the name shown beside an account holder's activity.
- Password: the secret the account holder chooses in order to sign in.
- Session: the state in which a browser remains known to the platform after signing in.
- Fresh session: a session begun only a short time ago, required for certain sensitive operations.
- One-time code: a short number sent to a channel so that whoever holds it proves the channel is theirs.
- Single-use link: a link sent to an address to prove it or to change a password, which stops working once used.
- Suspension: the prevention of sign-in or of certain acts, while the account and its record remain.
- Closure: the ending of an account, irreversibly.

### 1.4 Authoritative text
The Arabic text is authoritative. The English and Kurdish versions are faithful translations of it with the same numbering, article by article, and where interpretation differs the Arabic text prevails.

### 1.5 Relationship to other documents
This document is read together with the General Terms and Conditions, the Privacy Policy, the Payment and Wallet Policy, the Levo Community Policy, the Memberships Policy and the Rewards Policy.

### 1.6 Acceptance
Opening an account, signing in to one or using one is acceptance of this document in the version in force at the time of use.

## 2. Who May Open an Account

### 2.1 Age
No account is opened for anyone under {{MIN_ACCOUNT_AGE_YEARS}} years of age. Anyone under the legal age of majority may neither contract nor buy except with their guardian's consent, and the guardian is responsible for every act done on the account.

### 2.2 Capacity
An account holder must have full capacity to contract. The Store may decline to open an account, or to continue one, where capacity is shown to be absent.

### 2.3 An account is personal
An account is personal to its holder, and any act done on it is attributed to them. No account may be opened in another person's name, nor may their identity be assumed, nor their data used.

### 2.4 An account in the name of an enterprise
An account may be opened on behalf of a commercial enterprise, provided it is administered by a natural person authorised to do so. The enterprise and its representative are jointly liable for what occurs on the account.

### 2.5 An account is not transferable
An account is not sold, rented, given away, nor is its ownership transferred. Nothing in it — balance, points, warranty units or badge — passes to another person.

### 2.6 The Store's right to decline
The Store may decline to open an account, or to accept a particular identifier, for an established reason connected with the security of the platform, the protection of its customers or a prior breach, without being obliged to set that reason out in detail where doing so would harm that security.

### 2.7 An account opened in breach
An account opened in breach of this chapter is treated as a breaching account under Chapter 10, and creates no right its holder may rely upon.

## 3. One Account per Person

### 3.1 The rule
One person has one account on the platform.

### 3.2 Why this rule exists
Because the wallet, warranty units, reward points, offer limits, referral accounting and membership are all tied to the person and not to the device nor to the address. Multiple accounts allow a benefit designed for one person to be taken many times, and make a limit set for protection meaningless.

### 3.3 Multiple accounts
Opening multiple accounts for one person is a breach. The Store responds by merging what can be merged or suspending the surplus accounts, and by recovering whatever was obtained without right.

### 3.4 Self-referral
A referral from a person to themselves is not counted, nor is a referral made through a second account opened by the referrer. A referral binds once when the account is created and is not moved to a different referrer afterwards.

### 3.5 Using another person's account
No one may sign in to an account they do not own, even with its holder's permission. What occurs on an account is attributed to its holder alone, under Article 8.9.

### 3.6 Exception
No exception to this chapter is made except by the Store's prior written permission, and within the limits that permission sets.

## 4. Accuracy of Information

### 4.1 The duty of truthfulness
The account holder undertakes that all their information is accurate and current: their name, their address, their number and their delivery addresses.

### 4.2 Information required at creation
What is required at creation depends on the path of registration: an email address or a phone number, a display name, a password on the paths that call for one, an optional username, and an optional country and language. Choosing an unrecognised country does not prevent the account from being created; it is recorded as unstated.

### 4.3 The delivery address
The delivery address is the account holder's responsibility. The consequences of an incomplete or wrong address — delay, failure to deliver, the fee for a second attempt — fall on them, under the Delivery Policy.

### 4.4 Keeping information current
The account holder undertakes to update their information whenever it changes, and in particular their number and their address, since those are the channels for recovery and for notification.

### 4.5 Consequences of inaccurate information
Inaccurate information may result in: failed delivery, failed recovery, refusal of an order, and restriction of the account. The Store is not responsible for the consequences of a statement the account holder made contrary to the truth.

### 4.6 Verification on doubt
The Store may require proof of identity, proof of ownership of a payment instrument, or proof of address where it doubts the accuracy of a statement or where dealing is unusual, and may hold the execution of an order until that proof arrives.

## 5. How an Account Is Created and Verified

### 5.1 The available paths
An account is opened by one of the following paths, according to what is enabled on the platform: by email address, by phone number through Telegram, by a one-time code delivered over WhatsApp or email, or by a Google account. What is in fact enabled is stated on the sign-in screen, so that what the Store cannot perform is not offered to the customer.

### 5.2 Email registration: the account is born after the address is proven
When registering with an email address no account is created at that moment and no password is stored. The registration attempt is held temporarily and a message containing a link is sent to the address. Whoever opens the link chooses the password, and at that point — not before — the account is created, the username is claimed if it is still available, and the session is opened.

### 5.3 Validity of the registration link
A registration link is valid for twenty-four hours and is used once. Registering again with the same address cancels the previous attempt and issues a new link, so that only the latest attempt can be completed.

### 5.4 Someone who plants a registration for another person's address
Gains nothing: no password was collected, and the owner of the address either ignores the message, in which case nothing happens, or opens the link and chooses their own password.

### 5.5 Registration by phone number
Registration by phone number is not accepted through the email path, because that path contains no proof of ownership of the number. Registration by number proceeds through Telegram: a link is opened in the application, the owner of the number proves ownership from inside it, a code is sent, and on verification the password is accepted and the account is created. This attempt is valid for fifteen minutes.

### 5.6 The one-time code
The code is sent to WhatsApp or to the email address, at the account holder's choice. It is valid for ten minutes, allows five entry attempts, and is not resent before sixty seconds have passed. Exhausting the attempts voids the code and requires a new one.

### 5.7 Signing in with a code and registering with one
If the identifier belongs to an existing account, the session is opened. If it belongs to no account and the request came from the registration screen, the code becomes proof of ownership of the channel, and a ticket valid for fifteen minutes is issued to complete the creation of the account. Receiving the code at an email address is itself proof of that address and dispenses with a verification link.

### 5.8 Signing in with Google
Signing in with a Google account is permitted, and the Store verifies for itself what Google issues. On this path the address is determined by Google and is confirmed by it at every sign-in.

### 5.9 Why the Store insists on verification
Because a verified identifier is: the channel by which an account is recovered when a password is forgotten; the channel by which the holder is told of movement on their wallet or of an attempted sign-in; the basis for saying that an order came from the account holder; and the means by which the Store tells one person from another and so prevents multiple accounts. An unverified identifier serves none of these, so accepting one means an account that cannot be recovered and an order that cannot be attributed.

### 5.10 The Store does not disclose whether an account exists
The platform does not disclose whether an address or a number belongs to an account. The answer to a registration attempt on a registered address and on an unregistered one is identical in its wording and in its visible effect, and the owner of the address learns that someone tried only from their own inbox. The same holds for a password recovery request and for a code request.

### 5.11 A non-real address
An account opened by phone number may carry a substitute address at which nothing arrives. In that case it is not claimed that a verification message was sent; the account holder is asked to add a real address first.

### 5.12 A channel that is unavailable
Where a channel is not configured on the platform, or has stopped working, this is said expressly and an alternative channel is named. "Try again later" is not said of a fault that waiting will not repair.

### 5.13 Request limits
Registration, code requests, verification-link requests and password recovery requests each carry a limit on the number of attempts per hour and per day, both per source and per destination, so that nobody's address or number can be flooded with messages they did not request.

## 6. The Address and the Number as Keys of Identity

### 6.1 The form of the number
An Iraqi phone number is accepted in its usual form, and Arabic-Indic digits are accepted and converted. Anything that cannot be a number is refused there and then, with the required form stated.

### 6.2 No number is stored before ownership is proven
No phone number is recorded on an account until its ownership has been proven. A number typed into a form without proof is neither stored nor given effect.

### 6.3 Changing the address by verification, not by declaration
An account's address does not change merely because a change was requested. A verification link is sent to the new address, and the account is moved to it only by an express act from inside that address. The old address keeps working until that happens, so that a typing error can never lock the account.

### 6.4 Re-authentication on an address change
Changing the address requires: the current password where the account has one, or a fresh session where it does not. An account that signs in with Google does not change its address here, because its address is determined by Google, and changing it here would silently break that link.

### 6.5 An address already used on another account
An account is not moved to an address belonging to another account. The requester receives a single answer that does not disclose whether the address is in use, and no link is sent in that case.

### 6.6 Changing the number
A phone number is changed by the same procedure that proves it in the first place: ownership of the new number is proven before it is linked.

### 6.7 An identifier that has passed to another person
Where a number or an address passes to another person — by reassignment from the provider or otherwise — the account holder must remove it from their account at once. Where it appears to the Store that an identifier no longer belongs to its holder, it may detach it from the account and require a substitute identifier before any sensitive operation.

### 6.8 A code is judged at the time it is used
Proving ownership of a channel means that whoever holds the code controls that channel. To whom the channel belongs is decided at the moment of use, not at the moment of sending. If the owner of the channel changed between the two, the code is refused.

## 7. Notification Channels and Security Codes

### 7.1 The channels
The notification channels are: in-app, Telegram, WhatsApp and email. The account holder chooses which to enable and which is their preferred channel, and may switch all of them off save as provided in Article 7.6.

### 7.2 Enabling is not readiness
Enabling a channel is a wish, not a capability. A channel works only where it is configured on the platform and where the account holder's details on it are verified. The account holder is shown which channels are ready and which are not, rather than being left to believe they will be told when they will not.

### 7.3 What is sent over the channels
The following are sent over them: sign-in and verification codes, recovery links, order notices and their stages, wallet notices, security notices, complaint notices, and whatever other notices the account holder chooses.

### 7.4 A code is a secret
A code and a link are the secret of the account holder alone. Neither the Store nor any of its staff requests them in a conversation, in a call or in a message, in any circumstances. Anyone who requests them is an impostor, however they may appear.

### 7.5 A message that was not requested
Anyone who receives a code or a link they did not request must not use it, and should notify {{LEVONIS_SUPPORT_CONTACT}}. A code arriving at a channel does not mean an account exists on it.

### 7.6 Notices that cannot be switched off
Notices concerning the security of the account, notices concerning movement on the wallet, notices concerning a complaint made against or by the account holder, and notices concerning the lapse of a subscription that carries consequences, cannot be switched off. They decide money and standing.

### 7.7 Marketing messages
Marketing messages are optional, are stopped at the account holder's request at any time, and stopping them entails no withholding of a service and no diminution of a right.

### 7.8 The cost of a channel
Whatever a telecommunications company or a service provider charges the account holder for receiving a message is a matter between them, and the Store does not bear it.

## 8. Passwords, Sessions and Keeping Credentials

### 8.1 The password
A password is not less than eight characters and not more than one hundred and twenty-eight. It is advised that it not be one used on another site, nor derived from a name, a date of birth or a phone number.

### 8.2 How it is stored
A password is not stored as text. It is stored in a derived form from which the original cannot be recovered, and nobody at the Store can read it or tell its owner what it is.

### 8.3 Changing the password
Changing the password requires: the current password where one exists, or a fresh session where the account has none. An old session alone is not enough for an operation of this consequence.

### 8.4 Recovering the password
It is recovered by requesting a link sent to the account's address. The link is valid for thirty minutes and used once, and is void after use, after its period expires, or on the issue of a later link.

### 8.5 The answer to a recovery request
The answer to a recovery request is the same in every case, whether or not the address belongs to an account, in accordance with Article 5.10.

### 8.6 The session and its duration
A session lasts fourteen days from the moment it is opened and then ends. It is kept in a cookie the page's own code cannot read, so no token can be extracted from it and copied elsewhere.

### 8.7 The fresh session
A fresh session — one begun no more than ten minutes ago — is required for operations that change the recovery channel or the sign-in secret on accounts that have no password. The purpose is that whoever performs such an operation has proven themselves just now and not a fortnight ago.

### 8.8 Ending sessions
An account holder may sign out of their session, and may end all their sessions on every device. This is advised on losing a device or on suspecting that someone has learned the password.

### 8.9 Keeping credentials and who bears a loss
The account holder is responsible for keeping their password and their codes and for everything that occurs on their account. Whoever discloses their password or their code, or lets another use their account, or leaves it open on a shared device, bears alone what follows from it — an order, a debit from the wallet, the use of their points or of their warranty units — and recovers none of it from the Store.

### 8.10 Shared devices
Signing in from a public or shared device is not advised; whoever does so must sign out when finished, since the session persists even after the page is closed.

### 8.11 Reporting a compromise
Anyone who suspects unauthorised access to their account must change their password at once, end all their sessions, and notify {{LEVONIS_SUPPORT_CONTACT}} without delay. Early notice is what allows the Store to stop a movement in progress or to recover an amount not yet disbursed.

### 8.12 The limits of what the Store can do after a compromise
What has actually been executed and delivered or disbursed may be impossible to recover. The Store does what it can and warrants no outcome in a compromise caused by disclosure on the account holder's part.

## 9. Names, Usernames and Content Rules

### 9.1 The display name
A display name must be a name fit to be shown to others. Anything obscene, offensive or suggestive of an official capacity is prohibited.

### 9.2 The username: form
A username is from three to thirty characters, in lowercase Latin letters, digits, the full stop, the hyphen and the underscore. It does not begin or end with a punctuation mark, does not contain two adjacent punctuation marks, and is not made up entirely of digits. It is stored in lowercase, so a difference in letter case does not create two names.

### 9.3 Reserved names
Usernames denoting the platform, its staff or sections of the site are reserved — such as anything referring to LEVONIS, support, administration, the wallet or orders. A message from such a name is read as a message from the Store.

### 9.4 Indecent names
An obscene or offensive name or username is refused. This is judged on the word in its meaning and not on an incidental resemblance of letters, so that a sound name is not refused because its letters happen to coincide with part of another word.

### 9.5 Impersonation
Impersonating the Store, its staff, another merchant or a trade mark is prohibited, whether by name, image or description. Whoever does so has their account suspended at once.

### 9.6 The username is a referral link
The username is the public handle for referrals. Anyone may therefore enquire whether one is available, and that is not treated as the disclosure of private information.

### 9.7 Changing the username and its effect
A username may be changed once every fourteen days. Referrals already made remain bound to their owner regardless of the name and do not pass to anyone else. But a referral link carrying the old name ceases to attribute the referral to its first owner after the change — if another person has taken the name it is attributed to them, and otherwise to nobody. The identifier that never moves is the account's own referral code, and it keeps working for that reason.

### 9.8 Images and content
The account holder is responsible for everything they upload: their profile picture, their review images and their request attachments. What the law prohibits, what infringes another's right, and what is obscene or contains another person's data are prohibited in them.

### 9.9 Ownership of what is uploaded
What the account holder uploads remains theirs. They grant the Store a licence to use it to the extent needed to operate the service: showing their picture in their profile, showing their review images on the product page, and delivering a request attachment to the merchant carrying it out.

### 9.10 The Store's right to correct
The Store may remove a name, an image or content that breaches these rules, may require the account holder to change it, and may suspend the account on refusal or repetition.

## 10. What Suspends or Closes an Account

### 10.1 Degrees of action
An account has four states: active, restricted, suspended and closed. A restricted account loses certain acts; a suspended account is barred from signing in or from dealing; a closed account is ended irreversibly.

### 10.2 Grounds for restriction
An account is restricted for: suspicion of multiple accounts, suspicion of unusual use of offers and coupons, repeated refusal to accept delivery without cause, or an open dispute requiring certain acts to be halted until it is decided.

### 10.3 Grounds for suspension
An account is suspended for: fraud or its attempt, using a payment instrument not belonging to the holder, impersonation, threatening or extorting a member or a member of staff, publishing content prohibited by law, attempting to breach the platform or to test its weaknesses without permission, exploiting a technical fault for gain, manipulating reviews, the referral system or the points system, or a grave breach of the Levo Community Policy.

### 10.4 Grounds for closure
An account is closed upon repetition of what warrants suspension, upon proof of grave fraud, at its holder's request under Chapter 11, or in execution of an order from a competent authority.

### 10.5 Immediate action
The Store may restrict or suspend immediately and without prior warning where delay would harm customers, their money or the integrity of the platform, and then informs the account holder of what has occurred.

### 10.6 Notice and appeal
The account holder is informed of the action and of its reason to the extent that does not harm the security of the platform. They may appeal within {{ACCOUNT_APPEAL_DAYS}} of being notified to {{LEVONIS_SUPPORT_CONTACT}}, and the appeal is decided within {{DISPUTE_RESPONSE_DAYS}}.

### 10.7 Effect of suspension on open orders
A paid order not yet delivered is either carried out or cancelled and refunded. Suspension is not made a ground for withholding goods whose price has been paid, nor for defeating an established right of the account holder, save to the extent required by the examination of an incident of fraud.

### 10.8 Effect of suspension on the wallet
The wallet balance remains the property of its owner. The Store may withhold disbursement from it pending the conclusion of an examination or a dispute, and may deduct from it whatever is established as due to another party by a reasoned decision.

### 10.9 Effect of suspension on rewards and membership
The disbursement of points and of membership benefits is suspended for the duration of the suspension. Points and benefits established to have been earned in breach are forfeited.

### 10.10 Effect of suspension on a merchant store
Where the account holder is a merchant, Chapter 11 of the Levo Community Policy applies to them in addition.

## 11. A Customer Closing Their Own Account

### 11.1 The right to close
An account holder may close their account whenever they wish.

### 11.2 How closure is requested
A closure request is made to {{LEVONIS_SUPPORT_CONTACT}} from the verified channel registered on the account. A request arriving from an unverified channel, or from someone other than the account holder, is not carried out.

### 11.3 Confirmation before execution
The Store confirms the requester's identity before execution — by a code to the verified channel or its equivalent — because closing an account on an impostor's request is a loss that cannot be undone.

### 11.4 Open orders
Closure is not carried out while the holder has an open order not yet delivered or refunded, a dispute or complaint not yet decided, or a return request or warranty claim under consideration. Execution is deferred until these end, or the open order is cancelled and refunded with the account holder's consent.

### 11.5 The wallet balance
The account holder must deal with their balance before closure. They may request disbursement of the disbursable balance under the Payment and Wallet Policy: what was a refundable cash deposit is returned to them, while what was promotional credit, a gift or a granted compensation is not paid out in cash and lapses on closure. A claim to the balance after closure must be made within {{WALLET_BALANCE_CLAIM_DAYS}} to {{LEVONIS_SUPPORT_CONTACT}}.

### 11.6 Warranty units
Warranty units and their extensions are tied to the item purchased and to its invoice, not to the existence of the account. Whoever has closed their account may claim under their item's warranty on its invoice and order number under the Warranty Policy, so long as the warranty period is still running. Closure does, however, remove their own access to their purchase history, so they must keep their invoices before closing.

### 11.7 Points and benefits
Reward points, promotional credit, vouchers and any remaining membership term lapse on closure, and are converted neither into money nor into another account.

### 11.8 Referrals
Referrals already made remain recorded as facts; they are neither returned to the referrer nor transferred to anyone else. The closed account holder's referral link ceases to work.

### 11.9 A merchant store
A merchant's account is not closed before their store is closed and their open orders, disputes, receivables and available balance are settled and transferred.

### 11.10 Time to execute
Closure is executed within {{ACCOUNT_CLOSURE_PROCESSING_DAYS}} of its conditions being met. The account holder may withdraw their request before execution.

### 11.11 No return after execution
A closed account is not reopened and its contents are not restored. Whoever wishes to deal afterwards opens a new account, and nothing passes to it from the old one.

### 11.12 The username after closure
A username is not released immediately on closure; it stays held for {{USERNAME_RELEASE_DAYS}} so that nobody else takes it and appears to be its first holder.

## 12. What Remains After Closure, Why, and for How Long

### 12.1 The rule
What need not remain of an account's data is deleted; what is needed to establish a transaction that actually occurred, to perform a legal obligation, or to defend a right, remains.

### 12.2 Orders and invoices
Orders and invoices, with their amounts, taxes and delivery fees, remain, because they are accounting documents and evidence of a sale that took place. They are kept for {{ORDER_RECORD_RETENTION_YEARS}}.

### 12.3 The wallet record
Wallet entries — deposits, debits, holds and refunds — remain, because a balance that cannot be explained by its entries cannot be audited. They are kept for {{WALLET_RECORD_RETENTION_YEARS}}.

### 12.4 The record of policy acceptance
The record of the account holder's acceptance of the policies, and the text of the version they accepted, remains, because an acceptance whose text cannot be produced years later is worthless. It is kept for {{POLICY_ACCEPTANCE_RETENTION_YEARS}}.

### 12.5 The audit record
Security and audit records — sign-in attempts, sensitive changes and administrative decisions — remain for {{AUDIT_LOG_RETENTION_YEARS}}, and are written in masked form to begin with, so they are unfit to serve as a mailing list.

### 12.6 Conversations
Messages connected to an order or a dispute remain for {{CHAT_RETENTION_YEARS}} because they are evidence for both parties. Their retention is not access to them, and they remain governed by Chapter 6 of the Levo Community Policy.

### 12.7 Reviews
A published review remains after its author's account is closed, and is detached from their identity so that it is no longer attributed to them by name. Deleting it would distort a picture of a merchant formed by real customers.

### 12.8 Deletion versus anonymisation
Where deletion is possible, deletion is done. Where it is not — because the row is itself evidence of a transaction — the personal data is detached from it and the row remains without an identity.

### 12.9 Backups
Data may remain in backups for a short period after being deleted from the live system, until the cycle of those backups completes. Such backups are used only to recover from a failure.

### 12.10 Reference to the Privacy Policy
The detail of what is collected, why, how it is protected, and the data subject's rights of access, correction and objection belongs to the Privacy Policy, and these articles are read together with it.

## 13. General and Final Provisions

### 13.1 Amendment
The Store may amend this policy by issuing a new version with a number and an effective date. The account holder is notified of a material amendment through their verified channel, and an amendment has no retrospective effect on an event that took place before it came into force.

### 13.2 Severability
The invalidity of one provision does not affect the validity of the remaining provisions.

### 13.3 Language
Where the three versions differ, the Arabic text governs under Article 1.4.

### 13.4 Reference
Anything not provided for here is referred to the General Terms and Conditions and to the policy competent for its subject matter.

### 13.5 Governing law and jurisdiction
This document is governed by the laws of {{GOVERNING_LAW_JURISDICTION}}, and jurisdiction lies with the courts of {{COMPETENT_COURT}}.

### 13.6 Contact point
The approved contact point is {{LEVONIS_SUPPORT_CONTACT}}, business hours {{LEVONIS_SUPPORT_HOURS}}, address {{LEVONIS_ADDRESS}}.`,
    ckb: `## 1. پێشەکی و بواری کار و پێناسەکان

### 1.1 مەبەستی ئەم بەڵگەنامەیە
ئەم بەڵگەنامەیە ڕوون دەکاتەوە کێ دەتوانێت هەژمارێک لەسەر پلاتفۆرمی لێڤۆنیس بکاتەوە، خاوەن هەژمار چی لەسەرە، چۆن خاوەندارێتی ئیمەیڵ یان ژمارەی تەلەفۆن دەسەلمێندرێت و بۆچی فرۆشگا پێداگری لەسەر سەلماندنی دەکات، چۆن زانیاری چوونەژوورەوە دەپارێزرێت و کێ زیانەکە هەڵدەگرێت لە کاتی ئاشکراکردنیاندا، چی هەژمار ڕادەگرێت یان دایدەخات، چۆن کڕیار هەژمارەکەی خۆی دادەخات، و چی لای فرۆشگا دەمێنێتەوە دوای داخستن و بۆ چەند ماوەیەک.

### 1.2 لایەنەکان
فرۆشگا: {{LEVONIS_LEGAL_NAME}}، تۆمارکراو بە ژمارە {{LEVONIS_REGISTRATION_NO}}. خاوەن هەژمار: هەر کەسێک کە بە ناوی ئەوەوە هەژمارێک لەسەر پلاتفۆرم کراوەتەوە، کڕیار بێت یان بازرگان.

### 1.3 پێناسەکان
- هەژمار: ئەو تۆمارەی ناسنامەی کەسێک لەسەر پلاتفۆرم لەگەڵ داواکارییەکانی و جزدانەکەی و خاڵەکانی و یەکەکانی گەرەنتییەکەی کۆدەکاتەوە.
- ناسێنەر: ئەو ئیمەیڵ یان ژمارە تەلەفۆنەی هەژمارەکە پێی دەناسرێت و بۆ چوونەژوورەوە و بۆ گەڕاندنەوە بەکاردێت.
- کەناڵی پشتڕاستکراو: ناسێنەرێک کە خاوەن هەژمار خاوەندارێتییەکەی بە یەکێک لە ڕێکارەکانی بەشی پێنجەم سەلماندووە.
- ناوی بەکارهێنەر: ئەو ناوە کورتە ئاشکرایەی خاوەن هەژمار پێی دەناسرێت لەناو پلاتفۆرم و لە بەستەری ناساندندا.
- ناوی دەرکەوتوو: ئەو ناوەی لەتەنیشت چالاکی خاوەن هەژمار پیشان دەدرێت.
- وشەی تێپەڕبوون: ئەو نهێنییەی خاوەن هەژمار بۆ چوونەژوورەوە هەڵیدەبژێرێت.
- دانیشتن: ئەو دۆخەی وێبگەڕ تێیدا دوای چوونەژوورەوە بۆ پلاتفۆرم ناسراو دەمێنێتەوە.
- دانیشتنی نوێ: دانیشتنێک کە تەنیا ماوەیەکی کورت لە دەستپێکردنی تێپەڕیوە، و بۆ هەندێک کرداری هەستیار مەرجە.
- کۆدی یەک جارە: ژمارەیەکی کورت کە بۆ کەناڵێک دەنێردرێت تاکو ئەوەی هەڵیدەگرێت بسەلمێنێت کە هی ئەوە.
- بەستەری یەک بەکارهێنان: بەستەرێک کە بۆ ئیمەیڵێک دەنێردرێت بۆ سەلماندنی یان بۆ گۆڕینی وشەی تێپەڕبوون، و دوای بەکارهێنان کار ناکات.
- ڕاگرتن: ڕێگرتن لە چوونەژوورەوە یان لە هەندێک کردار لەگەڵ مانەوەی هەژمارەکە و تۆمارەکەی.
- داخستن: کۆتاییهێنان بە هەژمارێک بە شێوەیەک کە گەڕانەوەی نییە.

### 1.4 دەقی پەسەندکراو
دەقی عەرەبی پەسەندکراوە. وەشانی ئینگلیزی و کوردی وەرگێڕانی دڵسۆزی ئەون بە هەمان ژمارەکردن بڕگە بە بڕگە، و لە کاتی جیاوازی لە لێکدانەوەدا دەقی عەرەبی دەبڕێت.

### 1.5 پەیوەندی ئەم بەڵگەنامەیە بە بەڵگەنامەکانی تر
لەگەڵ مەرج و ڕێساکانی گشتی، و سیاسەتی تایبەتمەندێتی، و سیاسەتی پارەدان و جزدان، و سیاسەتی کۆمەڵگەی لێڤۆ، و سیاسەتی ئەندامێتییەکان، و سیاسەتی خەڵات دەخوێنرێتەوە.

### 1.6 قبوڵکردنی بەڵگەنامەکە
کردنەوەی هەژمارێک یان چوونەژوورەوەی یان بەکارهێنانی قبوڵکردنی ئەم بەڵگەنامەیەیە بەو وەشانەی لە کاتی بەکارهێناندا جێبەجێیە.

## 2. کێ دەتوانێت هەژمارێک بکاتەوە

### 2.1 تەمەن
هیچ هەژمارێک بۆ ئەو کەسە ناکرێتەوە کە تەمەنی لە {{MIN_ACCOUNT_AGE_YEARS}} ساڵ کەمترە. ئەوەی لە تەمەنی یاسایی پێگەیشتن کەمترە نە گرێبەست دەکات و نە دەکڕێت مەگەر بە ڕەزامەندی سەرپەرشتیارەکەی، و سەرپەرشتیار بەرپرسیارە لە هەموو کردارێک کە لەسەر هەژمارەکە ڕوودەدات.

### 2.2 توانای یاسایی
مەرجە خاوەن هەژمار تەواو توانای گرێبەستکردنی هەبێت. فرۆشگا دەتوانێت لە کردنەوەی هەژمارێک یان لە بەردەوامبوونی خۆی بگرێت ئەگەر دەرکەوت کە توانا نییە.

### 2.3 هەژمار کەسییە
هەژمار کەسییە بۆ خاوەنەکەی، و هەر کردارێک لەسەری ڕووبدات بۆی دەگەڕێندرێتەوە. نابێت هەژمارێک بە ناوی کەسێکی ترەوە بکرێتەوە، نە ناسنامەکەی بسەندرێت، نە زانیارییەکانی بەکاربهێندرێن.

### 2.4 هەژمار بە ناوی دامەزراوەیەک
دەکرێت هەژمارێک لە پێناوی دامەزراوەیەکی بازرگانی بکرێتەوە، بەمەرجێک کەسێکی سروشتیی ڕێپێدراو بەڕێوەی بەرێت. دامەزراوەکە و نوێنەرەکەی هاوبەشن لە بەرپرسیارێتی ئەوەی لەسەر هەژمارەکە ڕوودەدات.

### 2.5 هەژمار ناگوازرێتەوە
هەژمار نە دەفرۆشرێت نە بە کرێ دەدرێت نە دیاری دەکرێت نە خاوەندارێتییەکەی دەگوازرێتەوە. هیچ شتێکی ناوی — باڵانس، خاڵ، یەکەی گەرەنتی یان نیشانە — بۆ کەسێکی تر ناگوازرێتەوە.

### 2.6 مافی فرۆشگا بۆ ڕەتکردنەوە
فرۆشگا دەتوانێت لە کردنەوەی هەژمارێک، یان لە قبوڵکردنی ناسێنەرێکی دیاریکراو، خۆی بگرێت بۆ هۆکارێکی جێگیر کە پەیوەندی بە ئاسایشی پلاتفۆرم یان پاراستنی کڕیارەکانی یان سەرپێچییەکی پێشووەوە هەیە، بەبێ ئەوەی ئەرکی لەسەر بێت وردەکاری هۆکارەکە ڕوون بکاتەوە ئەگەر ڕوونکردنەوەکە زیان بەو ئاسایشە بگەیەنێت.

### 2.7 هەژماری بە سەرپێچی کراوە
ئەو هەژمارەی بە سەرپێچی ئەم بەشە کراوەتەوە وەک هەژماری سەرپێچیکار لە بەشی دەیەمدا مامەڵەی لەگەڵ دەکرێت، و هیچ مافێک بۆ خاوەنەکەی دروست ناکات کە پشتی پێ ببەستێت.

## 3. یەک هەژمار بۆ هەر کەسێک

### 3.1 بنەماکە
هەر کەسێک یەک هەژماری هەیە لەسەر پلاتفۆرم.

### 3.2 بۆچی ئەم بنەمایە
چونکە جزدان، و یەکەکانی گەرەنتی، و خاڵەکانی خەڵات، و سنووری پێشکەشکراوەکان، و ژماردنی ناساندن، و ئەندامێتی، هەموویان بە کەسەکەوە بەستراون نەک بە ئامێرەکە و نەک بە ناونیشانەکە. زۆربوونی هەژمار وا دەکات سوودێک کە بۆ یەک کەس دانراوە چەند جارێک وەربگیرێت، و سنوورێک کە بۆ پاراستن دانراوە بێ واتا بکات.

### 3.3 زۆربوونی هەژمار
کردنەوەی چەند هەژمارێک بۆ یەک کەس سەرپێچییە. فرۆشگا بە یەکخستنی ئەوەی دەکرێت یەک بخرێت یان بە ڕاگرتنی هەژمارە زیادەکان وەڵامی دەداتەوە، و ئەوەی بە ناحەق وەرگیراوە وەردەگرێتەوە.

### 3.4 ناساندنی خۆ
ناساندن لە کەسێکەوە بۆ خۆی ناژمێردرێت، نە ناساندنێک بە هەژمارێکی دووەم کە ناسێنەرەکە کردوویەتییەوە. ناساندن یەک جار لە کاتی دروستکردنی هەژمارەکەدا دەبەسترێت و دوای ئەوە بۆ ناسێنەرێکی تر ناگوازرێتەوە.

### 3.5 بەکارهێنانی هەژماری کەسانی تر
هیچ کەس ناتوانێت بچێتە ناو هەژمارێک کە خاوەنی نییە، تەنانەت بە ڕێپێدانی خاوەنەکەی. ئەوەی لەسەر هەژمارێک ڕوودەدات تەنیا بۆ خاوەنەکەی دەگەڕێندرێتەوە، بەپێی بڕگەی 8.9.

### 3.6 دەربازبوون
هیچ دەربازبوونێک لەم بەشە نییە مەگەر بە ڕێپێدانێکی نووسراوی پێشوەختی فرۆشگا، و لەناو ئەو سنوورانەی ڕێپێدانەکە دایدەنێت.

## 4. ڕاستی زانیارییەکان

### 4.1 ئەرکی ڕاستگۆیی
خاوەن هەژمار ئەرکی لەسەرە هەموو زانیارییەکانی ڕاست و نوێ بن: ناوی، ناونیشانەکەی، ژمارەکەی، و ناونیشانەکانی گەیاندنی.

### 4.2 ئەو زانیارییانەی لە کاتی دروستکردندا داوا دەکرێن
ئەوەی لە کاتی دروستکردندا داوا دەکرێت بەپێی ڕێڕەوی تۆمارکردن دەگۆڕێت: ناونیشانی ئیمەیڵ یان ژمارە تەلەفۆن، ناوێکی دەرکەوتوو، وشەی تێپەڕبوون لەو ڕێڕەوانەی داوای دەکەن، ناوی بەکارهێنەری ئارەزوومەندانە، و وڵات و زمانی ئارەزوومەندانە. هەڵبژاردنی وڵاتێکی نەناسراو ڕێگر نییە لە دروستبوونی هەژمارەکە، بەڵکو وەک نەدیاریکراو تۆمار دەکرێت.

### 4.3 ناونیشانی گەیاندن
ناونیشانی گەیاندن بەرپرسیارێتی خاوەن هەژمارە. ئەنجامەکانی ناونیشانێکی ناتەواو یان هەڵە — دواکەوتن، نەتوانینی گەیاندن، کرێی هەوڵی دووەم — لەسەر ئەون، بەپێی سیاسەتی گەیاندن.

### 4.4 نوێکردنەوەی زانیارییەکان
خاوەن هەژمار ئەرکی لەسەرە زانیارییەکانی نوێ بکاتەوە هەر کاتێک بگۆڕێن، بەتایبەتی ژمارەکەی و ناونیشانەکەی، چونکە ئەوانە کەناڵی گەڕاندنەوە و ئاگادارکردنەوەن.

### 4.5 ئەنجامەکانی زانیاری نادروست
زانیاری نادروست لەوانەیە ئەمانەی لێبکەوێتەوە: نەگەیشتنی گەیاندن، نەتوانینی گەڕاندنەوە، ڕەتکردنەوەی داواکارییەک، و سنووردارکردنی هەژمارەکە. فرۆشگا بەرپرسیار نییە لە ئەنجامی زانیارییەک کە خاوەن هەژمار پێچەوانەی ڕاستی داویەتی.

### 4.6 پشکنین لە کاتی گومان
فرۆشگا دەتوانێت داوای بەڵگەی ناسنامە، یان بەڵگەی خاوەندارێتی ئامرازی پارەدان، یان بەڵگەی ناونیشان بکات لە کاتێکدا کە گومانی لە ڕاستی زانیارییەک هەیە یان مامەڵەکە نائاسایی بێت، و جێبەجێکردنی داواکارییەک ڕابگرێت تا بەڵگەکە دەگات.

## 5. چۆن هەژمار دروست دەکرێت و پشتڕاست دەکرێتەوە

### 5.1 ڕێڕەوە بەردەستەکان
هەژمار بە یەکێک لەم ڕێڕەوانە دەکرێتەوە، بەپێی ئەوەی لەسەر پلاتفۆرم چالاکە: بە ناونیشانی ئیمەیڵ، یان بە ژمارەی تەلەفۆن لە ڕێگەی تێلێگرامەوە، یان بە کۆدێکی یەک جارە کە لە ڕێگەی واتساپ یان ئیمەیڵەوە دێت، یان بە هەژماری گووگڵ. ئەوەی بەڕاستی چالاکە لە شاشەی چوونەژوورەوەدا ڕادەگەیەنرێت، تاکو ئەوەی فرۆشگا ناتوانێت جێبەجێی بکات بۆ کڕیار نەخرێتەڕوو.

### 5.2 تۆمارکردن بە ئیمەیڵ: هەژمار دوای سەلماندنی ناونیشانەکە لەدایک دەبێت
لە کاتی تۆمارکردن بە ناونیشانی ئیمەیڵدا لەو ساتەدا هیچ هەژمارێک دروست ناکرێت و هیچ وشەی تێپەڕبوونێک هەڵناگیرێت. هەوڵی تۆمارکردنەکە بە کاتی دەپارێزرێت و پەیامێک کە بەستەرێکی تێدایە بۆ ناونیشانەکە دەنێردرێت. ئەوەی بەستەرەکە دەکاتەوە وشەی تێپەڕبوون هەڵدەبژێرێت، و لەو خاڵەدا — نەک پێشتر — هەژمارەکە دروست دەکرێت و ناوی بەکارهێنەر جێگیر دەکرێت ئەگەر هێشتا بەردەست بێت، و دانیشتنەکە دەکرێتەوە.

### 5.3 ماوەی بەستەری تۆمارکردن
بەستەری تۆمارکردن بۆ بیست و چوار کاتژمێر دەرباز و یەک جار بەکاردەهێندرێت. تۆمارکردنی دووبارە بە هەمان ناونیشان هەوڵە پێشووەکە هەڵدەوەشێنێتەوە و بەستەرێکی نوێ دەردەکات، بۆیە تەنیا دوایین هەوڵ دەتوانێت تەواو بکرێت.

### 5.4 ئەو کەسەی تۆمارکردنێک بۆ ناونیشانی کەسێکی تر دادەنێت
هیچ بەدەست ناهێنێت: هیچ وشەی تێپەڕبوونێک کۆنەکراوەتەوە، و خاوەنی ناونیشانەکە یان پەیامەکە پشتگوێ دەخات و هیچ ڕوونادات، یان بەستەرەکە دەکاتەوە و وشەی تێپەڕبوونی خۆی هەڵدەبژێرێت.

### 5.5 تۆمارکردن بە ژمارەی تەلەفۆن
تۆمارکردن بە ژمارەی تەلەفۆن لە ڕێڕەوی ئیمەیڵەوە قبوڵ ناکرێت، چونکە ئەو ڕێڕەوە هیچ بەڵگەیەکی خاوەندارێتی ژمارەکەی تێدا نییە. تۆمارکردن بە ژمارە لە ڕێگەی تێلێگرامەوە دەڕوات: بەستەرێک لە ئەپەکەدا دەکرێتەوە، خاوەنی ژمارەکە خاوەندارێتییەکەی لە ناوەوە دەسەلمێنێت، کۆدێک دەنێردرێت، و لە کاتی پشتڕاستکردنەوەدا وشەی تێپەڕبوون قبوڵ دەکرێت و هەژمارەکە دروست دەکرێت. ئەم هەوڵە بۆ پازدە خولەک دەرباز.

### 5.6 کۆدی یەک جارە
کۆدەکە بەپێی هەڵبژاردنی خاوەن هەژمار بۆ واتساپ یان بۆ ناونیشانی ئیمەیڵ دەنێردرێت. بۆ دە خولەک دەرباز، پێنج هەوڵی تێخستنی هەیە، و پێش تێپەڕبوونی شەست چرکە دووبارە نانێردرێتەوە. تەواوکردنی هەوڵەکان کۆدەکە پووچ دەکاتەوە و داوای کۆدێکی نوێ دەخوازێت.

### 5.7 چوونەژوورەوە بە کۆد و تۆمارکردن پێی
ئەگەر ناسێنەرەکە هی هەژمارێکی هەبوو بێت، دانیشتنەکە دەکرێتەوە. ئەگەر هی هیچ هەژمارێک نەبوو و داواکارییەکە لە شاشەی تۆمارکردنەوە هاتبوو، کۆدەکە دەبێتە بەڵگەی خاوەندارێتی کەناڵەکە، و بلیتێک کە بۆ پازدە خولەک دەربازە بۆ تەواوکردنی دروستکردنی هەژمارەکە دەردەچێت. وەرگرتنی کۆدەکە لە ناونیشانێکی ئیمەیڵدا خۆی بەڵگەی ئەو ناونیشانەیە و پێویست بە بەستەری پشتڕاستکردنەوە ناهێڵێت.

### 5.8 چوونەژوورەوە بە گووگڵ
چوونەژوورەوە بە هەژماری گووگڵ ڕێپێدراوە، و فرۆشگا خۆی ڕاستی ئەوەی گووگڵ دەریدەکات پشکنین دەکات. لەم ڕێڕەوەدا ناونیشانەکە گووگڵ دیاری دەکات و لە هەر چوونەژوورەوەیەکدا پشتڕاستی دەکاتەوە.

### 5.9 بۆچی فرۆشگا پێداگری لەسەر پشتڕاستکردنەوە دەکات
چونکە ناسێنەرێکی پشتڕاستکراو ئەمانەیە: ئەو کەناڵەی هەژمارەکە پێی دەگەڕێندرێتەوە لە کاتی لەبیرکردنی وشەی تێپەڕبوون؛ ئەو کەناڵەی خاوەنەکەی پێی ئاگادار دەکرێتەوە لە جوڵەیەک لەسەر جزدانەکەی یان لە هەوڵێکی چوونەژوورەوە؛ بنەمای ئەو قسەیەی کە داواکارییەکە لە خاوەن هەژمارەوە هاتووە؛ و ئەو ئامرازەی فرۆشگا پێی کەسێک لە کەسێکی تر جیا دەکاتەوە و بەمە ڕێگر دەبێت لە زۆربوونی هەژمار. ناسێنەرێکی پشتڕاستنەکراو هیچ کام لەمانە ناکات، بۆیە قبوڵکردنی مانای هەژمارێکە کە ناگەڕێندرێتەوە و داواکارییەکە کە بۆ کەس ناگەڕێندرێتەوە.

### 5.10 فرۆشگا ئاشکرا ناکات کە هەژمار هەیە یان نا
پلاتفۆرم ئاشکرا ناکات کە ناونیشانێک یان ژمارەیەک هی هەژمارێکە. وەڵامی هەوڵی تۆمارکردن لەسەر ناونیشانێکی تۆمارکراو و لەسەر یەکێکی تۆمارنەکراو لە وشە و لە کاریگەرییە دەرکەوتووەکەیدا یەکسانە، و خاوەنی ناونیشانەکە تەنیا لە سندوقی خۆیەوە دەزانێت کە کەسێک هەوڵی داوە. هەمان شت بۆ داواکاری گەڕاندنەوەی وشەی تێپەڕبوون و بۆ داواکاری کۆد.

### 5.11 ناونیشانێکی نائەسڵی
ئەو هەژمارەی بە ژمارەی تەلەفۆن کراوەتەوە لەوانەیە ناونیشانێکی جێگرەوەی هەبێت کە هیچی بۆ ناگات. لەو حاڵەتەدا بانگەشەی ئەوە ناکرێت کە پەیامی پشتڕاستکردنەوە نێردراوە، بەڵکو داوا لە خاوەن هەژمار دەکرێت سەرەتا ناونیشانێکی ڕاستەقینە زیاد بکات.

### 5.12 کەناڵێکی بەردەست نەبوو
ئەگەر کەناڵێک لەسەر پلاتفۆرم ئامادە نەبوو، یان لە کارکردن وەستابوو، ئەمە بە ڕوونی دەوترێت و کەناڵێکی جێگرەوە ناو دەبرێت. «دواتر هەوڵ بدەرەوە» بۆ تێکچوونێک نادرێت کە چاوەڕوانکردن چاکی ناکاتەوە.

### 5.13 سنووری داواکاری
تۆمارکردن، و داواکاری کۆد، و داواکاری بەستەری پشتڕاستکردنەوە، و داواکاری گەڕاندنەوەی وشەی تێپەڕبوون هەریەکەیان سنوورێکی ژمارەی هەوڵیان هەیە لە کاتژمێرێک و لە ڕۆژێکدا، هەم بۆ سەرچاوە و هەم بۆ مەبەست، تاکو ناونیشان یان ژمارەی هیچ کەسێک بە پەیامی داوانەکراو پڕ نەکرێت.

## 6. ناونیشان و ژمارە وەک کلیلی ناسنامە

### 6.1 شێوەی ژمارە
ژمارەی تەلەفۆنی عێراقی بە شێوە باوەکەی قبوڵ دەکرێت، و ژمارە عەرەبی-هیندییەکان قبوڵ و دەگۆڕدرێن. ئەوەی ناتوانێت ژمارە بێت لەو کاتەدا ڕەت دەکرێتەوە لەگەڵ ڕوونکردنەوەی ئەو شێوەیەی داوا دەکرێت.

### 6.2 هیچ ژمارەیەک پێش سەلماندنی خاوەندارێتی هەڵناگیرێت
هیچ ژمارە تەلەفۆنێک لەسەر هەژمارێک تۆمار ناکرێت تا خاوەندارێتییەکەی نەسەلمێندرێت. ژمارەیەک کە بێ بەڵگە لە فۆڕمێکدا دەنووسرێت نە هەڵدەگیرێت و نە پەسەند دەکرێت.

### 6.3 گۆڕینی ناونیشان بە پشتڕاستکردنەوە نەک بە ڕاگەیاندن
ناونیشانی هەژمارێک تەنیا بەوەی داوای گۆڕینی کراوە ناگۆڕێت. بەستەرێکی پشتڕاستکردنەوە بۆ ناونیشانە نوێیەکە دەنێردرێت، و هەژمارەکە تەنیا بە کردارێکی ڕوون لە ناو ئەو ناونیشانەوە بۆی دەگوازرێتەوە. ناونیشانە کۆنەکە بەردەوام کار دەکات تا ئەوە ڕوودەدات، تاکو هەڵەیەکی نووسین هەرگیز هەژمارەکە دانەخات.

### 6.4 دووبارە پشتڕاستکردنەوە لە کاتی گۆڕینی ناونیشان
گۆڕینی ناونیشان ئەمانەی دەوێت: وشەی تێپەڕبوونی ئێستا ئەگەر هەژمارەکە هەیبوو، یان دانیشتنێکی نوێ ئەگەر نەیبوو. ئەو هەژمارەی بە گووگڵ دەچێتە ژوورەوە ناونیشانەکەی لێرەوە ناگۆڕدرێت، چونکە ناونیشانەکەی گووگڵ دیاری دەکات، و گۆڕینی لێرە بە بێدەنگی ئەو پەیوەندییە دەپچڕێنێت.

### 6.5 ناونیشانێک کە لەسەر هەژمارێکی تر بەکارهاتووە
هەژمار بۆ ناونیشانێک ناگوازرێتەوە کە هی هەژمارێکی ترە. داواکار یەک وەڵام وەردەگرێت کە ئاشکرا ناکات ناونیشانەکە بەکارهاتووە یان نا، و لەو حاڵەتەدا هیچ بەستەرێک نانێردرێت.

### 6.6 گۆڕینی ژمارە
ژمارەی تەلەفۆن بە هەمان ئەو ڕێکارە دەگۆڕدرێت کە لە سەرەتادا سەلماندی: خاوەندارێتی ژمارە نوێیەکە پێش بەستنەوەی دەسەلمێندرێت.

### 6.7 ناسێنەرێک کە بۆ کەسێکی تر گواستراوەتەوە
ئەگەر ژمارەیەک یان ناونیشانێک بۆ کەسێکی تر گوازرایەوە — بە دابەشکردنەوەی دابینکەر یان بە شێوەیەکی تر — خاوەن هەژمار دەبێت دەستبەجێ لە هەژمارەکەی لایببات. ئەگەر بۆ فرۆشگا دەرکەوت کە ناسێنەرێک چیتر هی خاوەنەکەی نییە، دەتوانێت لە هەژمارەکە جیای بکاتەوە و پێش هەر کردارێکی هەستیار داوای ناسێنەرێکی جێگرەوە بکات.

### 6.8 کۆد لە کاتی بەکارهێنانیدا هەڵدەسەنگێندرێت
سەلماندنی خاوەندارێتی کەناڵێک مانای ئەوەیە کە ئەوەی کۆدەکەی هەڵگرتووە دەسەڵاتی بەسەر ئەو کەناڵەدا هەیە. بەڵام ئەوەی کەناڵەکە هی کێیە لە ساتی بەکارهێناندا بڕیاری لەسەر دەدرێت نەک لە ساتی ناردندا. ئەگەر خاوەنی کەناڵەکە لە نێوان ئەو دوو ساتەدا گۆڕا، کۆدەکە ڕەت دەکرێتەوە.

## 7. کەناڵەکانی ئاگادارکردنەوە و کۆدەکانی ئاسایش

### 7.1 کەناڵەکان
کەناڵەکانی ئاگادارکردنەوە ئەمانەن: ناو ئەپ، تێلێگرام، واتساپ، و ئیمەیڵ. خاوەن هەژمار هەڵدەبژێرێت کامەیان چالاک بکات و کامەیان کەناڵە پەسەندکراوەکەیەتی، و دەتوانێت هەموویان بکوژێنێتەوە جگە لەوەی لە بڕگەی 7.6 هاتووە.

### 7.2 چالاککردن ئامادەیی نییە
چالاککردنی کەناڵێک ئارەزوویەکە نەک توانا. کەناڵێک تەنیا کار دەکات کاتێک لەسەر پلاتفۆرم ئامادە بێت و زانیاری خاوەن هەژمار تێیدا پشتڕاستکرابێت. بۆ خاوەن هەژمار ڕوون دەکرێتەوە کام کەناڵ ئامادەیە و کام نا، نەک بەجێبهێڵدرێت بەو گومانەوە کە ئاگادار دەکرێتەوە لە کاتێکدا ناکرێتەوە.

### 7.3 ئەوەی لە ڕێگەی کەناڵەکانەوە دەنێردرێت
ئەمانە لە ڕێگەیانەوە دەنێردرێن: کۆدەکانی چوونەژوورەوە و پشتڕاستکردنەوە، بەستەرەکانی گەڕاندنەوە، ئاگادارکردنەوەی داواکاری و قۆناغەکانی، ئاگادارکردنەوەی جزدان، ئاگادارکردنەوەی ئاسایش، ئاگادارکردنەوەی سکاڵا، و هەر ئاگادارکردنەوەیەکی تر کە خاوەن هەژمار هەڵیدەبژێرێت.

### 7.4 کۆد نهێنییە
کۆد و بەستەر نهێنیی تەنیا خاوەن هەژمارن. نە فرۆشگا و نە هیچ کارمەندێکی لە گفتوگۆدا یان لە پەیوەندییەکدا یان لە پەیامێکدا داوایان ناکات، بە هیچ حاڵێک. هەر کەسێک داوایان بکات ساختەکارە، هەرچۆنێک دەربکەوێت.

### 7.5 پەیامێک کە داوا نەکراوە
ئەوەی کۆدێک یان بەستەرێکی بۆ دێت کە داوای نەکردووە نابێت بەکاری بهێنێت، و با {{LEVONIS_SUPPORT_CONTACT}} ئاگادار بکاتەوە. گەیشتنی کۆدێک بە کەناڵێک مانای ئەوە نییە کە هەژمارێک لەسەری هەیە.

### 7.6 ئاگادارکردنەوەکانی ناکوژێنرێنەوە
ئەو ئاگادارکردنەوانەی پەیوەندییان بە ئاسایشی هەژمارەکەوە هەیە، و ئەوانەی پەیوەندییان بە جوڵەی جزدانەوە هەیە، و ئەوانەی پەیوەندییان بە سکاڵایەکەوە هەیە کە دژی خاوەن هەژمار یان لەلایەن ئەوەوە پێشکەش کراوە، و ئەوانەی پەیوەندییان بە کۆتاییهاتنی ئابوونەیەکەوە هەیە کە کاریگەری هەیە، ناکوژێنرێنەوە. چونکە بڕیار لە پارە و پێگە دەدەن.

### 7.7 پەیامە بازاڕگەرییەکان
پەیامە بازاڕگەرییەکان ئارەزوومەندانەن، بە داواکاری خاوەن هەژمار لە هەر کاتێکدا دەوەستێنرێن، و وەستاندنیان نە ڕێگرتن لە خزمەتگوزارییەک و نە کەمکردنەوەی مافێکی لێدەکەوێتەوە.

### 7.8 تێچووی کەناڵ
ئەوەی کۆمپانیای پەیوەندی یان دابینکەری خزمەتگوزاری لە خاوەن هەژمار وەریدەگرێت لە بەرامبەر وەرگرتنی پەیامێک بابەتێکە لەنێوان ئەواندا، و فرۆشگا هەڵینایەت.

## 8. وشەی تێپەڕبوون و دانیشتنەکان و پاراستنی زانیاری چوونەژوورەوە

### 8.1 وشەی تێپەڕبوون
وشەی تێپەڕبوون لە هەشت نووسە کەمتر و لە سەد و بیست و هەشت زیاتر نابێت. ئامۆژگاری دەکرێت کە لەسەر ماڵپەڕێکی تر بەکارنەهاتبێت و لە ناو یان بەرواری لەدایکبوون یان ژمارەی تەلەفۆنەوە وەرنەگیرابێت.

### 8.2 چۆن هەڵدەگیرێت
وشەی تێپەڕبوون وەک دەق هەڵناگیرێت. بە شێوەیەکی وەرگیراو هەڵدەگیرێت کە ئەسڵەکەی لێ دەرناهێندرێت، و هیچ کەسێک لە فرۆشگا ناتوانێت بیخوێنێتەوە و نە بە خاوەنەکەی بڵێت چییە.

### 8.3 گۆڕینی وشەی تێپەڕبوون
گۆڕینی وشەی تێپەڕبوون ئەمانەی دەوێت: وشەی تێپەڕبوونی ئێستا ئەگەر هەبوو، یان دانیشتنێکی نوێ ئەگەر هەژمارەکە هیچی نەبوو. دانیشتنێکی کۆن بە تەنیا بۆ کردارێک بەم کاریگەرییە بەس نییە.

### 8.4 گەڕاندنەوەی وشەی تێپەڕبوون
بە داواکردنی بەستەرێک دەگەڕێندرێتەوە کە بۆ ناونیشانی هەژمارەکە دەنێردرێت. بەستەرەکە بۆ سی خولەک دەرباز و یەک جار بەکاردەهێندرێت، و دوای بەکارهێنان یان بە تێپەڕبوونی ماوەکەی یان بە دەرچوونی بەستەرێکی دواتر پووچ دەبێتەوە.

### 8.5 وەڵامی داواکاری گەڕاندنەوە
وەڵامی داواکاری گەڕاندنەوە لە هەموو حاڵەتێکدا یەکسانە، جا ناونیشانەکە هی هەژمارێک بێت یان نا، بەپێی بڕگەی 5.10.

### 8.6 دانیشتن و ماوەکەی
دانیشتن چواردە ڕۆژ لە ساتی کردنەوەی دەمێنێتەوە و پاشان کۆتایی دێت. لە کوکییەکدا هەڵدەگیرێت کە کۆدی خودی لاپەڕەکە ناتوانێت بیخوێنێتەوە، بۆیە هیچ تۆکنێکی لێ دەرناهێندرێت کە بۆ شوێنێکی تر کۆپی بکرێت.

### 8.7 دانیشتنی نوێ
دانیشتنێکی نوێ — کە زیاتر لە دە خولەک لە دەستپێکردنی تێنەپەڕیوە — مەرجە بۆ ئەو کردارانەی کەناڵی گەڕاندنەوە یان نهێنیی چوونەژوورەوە دەگۆڕن لەو هەژمارانەی وشەی تێپەڕبوونیان نییە. مەبەست ئەوەیە کە ئەنجامدەری ئەم کردارانە هەر ئێستا خۆی سەلماندبێت نەک دوو هەفتە لەمەوپێش.

### 8.8 کۆتاییهێنان بە دانیشتنەکان
خاوەن هەژمار دەتوانێت لە دانیشتنەکەی بچێتە دەرەوە، و دەتوانێت کۆتایی بە هەموو دانیشتنەکانی لەسەر هەموو ئامێرەکان بهێنێت. لە کاتی لەدەستدانی ئامێرێک یان گومان لەوەی کەسێک وشەی تێپەڕبوونی زانیوە ئامۆژگاری بەمە دەکرێت.

### 8.9 پاراستنی زانیاری چوونەژوورەوە و کێ زیانەکە هەڵدەگرێت
خاوەن هەژمار بەرپرسیارە لە پاراستنی وشەی تێپەڕبوونی و کۆدەکانی و لە هەموو ئەوەی لەسەر هەژمارەکەی ڕوودەدات. ئەوەی وشەی تێپەڕبوونی یان کۆدەکەی ئاشکرا بکات، یان ڕێگا بە کەسێکی تر بدات هەژمارەکەی بەکاربهێنێت، یان لەسەر ئامێرێکی هاوبەش کراوەی بەجێبهێڵێت، بە تەنیا ئەوە هەڵدەگرێت کە لێی دەکەوێتەوە — داواکارییەک، کەمکردنەوەیەک لە جزدان، بەکارهێنانی خاڵەکانی یان یەکەکانی گەرەنتییەکەی — و هیچی لە فرۆشگا وەرناگرێتەوە.

### 8.10 ئامێری هاوبەش
چوونەژوورەوە لە ئامێرێکی گشتی یان هاوبەشەوە ئامۆژگاری ناکرێت، و ئەوەی ئەمە دەکات دەبێت لە کاتی تەواوبووندا بچێتە دەرەوە، چونکە دانیشتنەکە دەمێنێتەوە تەنانەت ئەگەر لاپەڕەکە دابخرێت.

### 8.11 ڕاگەیاندنی تێکشکان
ئەوەی گومانی لە چوونەژوورەوەیەکی بێ ڕێپێدان بۆ هەژمارەکەی هەیە دەبێت دەستبەجێ وشەی تێپەڕبوونی بگۆڕێت، کۆتایی بە هەموو دانیشتنەکانی بهێنێت، و بێ دواکەوتن {{LEVONIS_SUPPORT_CONTACT}} ئاگادار بکاتەوە. ئاگادارکردنەوەی زوو ئەوەیە کە ڕێگا بە فرۆشگا دەدات جوڵەیەکی بەردەوام ڕابگرێت یان بڕێک بگەڕێنێتەوە کە هێشتا دەرنەچووە.

### 8.12 سنووری ئەوەی فرۆشگا دوای تێکشکان دەیکات
ئەوەی بەڕاستی جێبەجێ کراوە و گەیەنراوە یان دەرچووە لەوانەیە نەکرێت بگەڕێندرێتەوە. فرۆشگا ئەوەی لە توانایدایە دەیکات و هیچ ئەنجامێک گەرەنتی ناکات لە تێکشکانێکدا کە هۆکارەکەی ئاشکراکردنە لەلایەن خاوەن هەژمارەوە.

## 9. ناو و ناوی بەکارهێنەر و بنەماکانی ناوەڕۆک

### 9.1 ناوی دەرکەوتوو
ناوی دەرکەوتوو دەبێت ناوێک بێت کە شایستەی پیشاندانە لەبەردەم کەسانی تر. هەر ئەوەی قێزەون یان ئازاردەر یان ئاماژەدەر بە سیفەتێکی فەرمی بێت قەدەغەیە.

### 9.2 ناوی بەکارهێنەر: شێوە
ناوی بەکارهێنەر لە سێ نووسەوە تا سی نووسە، بە پیتی لاتینیی بچووک و ژمارە و خاڵ و هێڵ و هێڵی ژێرەوە. بە هێمایەک دەست پێناکات و کۆتایی پێ نایەت، دوو هێمای تەنیشت یەک تێیدا نابێت، و هەمووی لە ژمارە پێک نایەت. بە پیتی بچووک هەڵدەگیرێت، بۆیە جیاوازی لە گەورەیی پیت دوو ناو دروست ناکات.

### 9.3 ناوە پاراستراوەکان
ئەو ناوانەی ئاماژە بە پلاتفۆرم یان بە کارمەندەکانی یان بە بەشەکانی ماڵپەڕەکە دەکەن پاراستراون — وەک هەر ئەوەی ئاماژە بە لێڤۆنیس یان پشتگیری یان بەڕێوەبەرایەتی یان جزدان یان داواکارییەکان دەکات. چونکە پەیامێک لە ناوێکی وا وەک پەیامێک لە فرۆشگاوە دەخوێندرێتەوە.

### 9.4 ناوە نەشیاوەکان
ناو یان ناوی بەکارهێنەری قێزەون یان ئازاردەر ڕەت دەکرێتەوە. ئەمە لەسەر وشەکە بە واتاکەی دەپێورێت نەک لەسەر هاوشێوەییەکی ڕێکەوتی پیتەکان، تاکو ناوێکی ساغ ڕەت نەکرێتەوە لەبەر ئەوەی پیتەکانی لەگەڵ بەشێکی وشەیەکی تر ڕێک دەکەون.

### 9.5 خۆ لە کەسێکی تر چواندن
خۆ لە فرۆشگا یان کارمەندەکانی یان بازرگانێکی تر یان مارکەیەکی بازرگانی چواندن قەدەغەیە، بە ناو بێت یان بە وێنە یان بە وەسف. ئەوەی ئەمە بکات هەژمارەکەی دەستبەجێ ڕادەگیرێت.

### 9.6 ناوی بەکارهێنەر بەستەری ناساندنە
ناوی بەکارهێنەر دەستەکی ئاشکرای ناساندنە. بۆیە هەر کەسێک دەتوانێت بپرسێت ئایا بەردەستە، و ئەمە وەک ئاشکراکردنی زانیارییەکی تایبەت هەژمار ناکرێت.

### 9.7 گۆڕینی ناوی بەکارهێنەر و کاریگەرییەکەی
ناوی بەکارهێنەر دەکرێت هەر چواردە ڕۆژ جارێک بگۆڕدرێت. ئەو ناساندنانەی کراون بە خاوەنەکەیانەوە دەبەسترێنەوە بێ گوێدان بە ناوەکە و بۆ کەسێکی تر ناگوازرێنەوە. بەڵام بەستەرێکی ناساندن کە ناوە کۆنەکە هەڵدەگرێت دوای گۆڕینەکە وازدەهێنێت لە گەڕاندنەوەی ناساندنەکە بۆ خاوەنە یەکەمەکەی — ئەگەر کەسێکی تر ناوەکەی وەرگرتبێت بۆ ئەو دەگەڕێندرێتەوە، ئەگەرنا بۆ هیچ کەس. ئەو ناسێنەرەی هەرگیز ناگوازرێتەوە کۆدی ناساندنی خودی هەژمارەکەیە، و بۆ هەمان هۆکار بەردەوام کار دەکات.

### 9.8 وێنە و ناوەڕۆک
خاوەن هەژمار بەرپرسیارە لە هەموو ئەوەی بارییدەکات: وێنەی پرۆفایلەکەی، وێنەکانی هەڵسەنگاندنەکانی، و هاوپێچەکانی داواکارییەکانی. ئەوەی یاسا قەدەغەی کردووە، و ئەوەی مافی کەسێکی تر پێشێل دەکات، و ئەوەی قێزەونە یان زانیاری کەسێکی تری تێدایە تێیاندا قەدەغەن.

### 9.9 خاوەندارێتی ئەوەی بارکراوە
ئەوەی خاوەن هەژمار باری دەکات هی خۆی دەمێنێتەوە. مۆڵەتێک بە فرۆشگا دەدات بۆ بەکارهێنانی بەو ڕادەیەی بۆ کارپێکردنی خزمەتگوزارییەکە پێویستە: پیشاندانی وێنەکەی لە پرۆفایلەکەیدا، پیشاندانی وێنەکانی هەڵسەنگاندنەکەی لەسەر لاپەڕەی بەرهەمەکە، و گەیاندنی هاوپێچی داواکارییەکە بەو بازرگانەی جێبەجێی دەکات.

### 9.10 مافی فرۆشگا بۆ ڕاستکردنەوە
فرۆشگا دەتوانێت ناو یان وێنە یان ناوەڕۆکێکی سەرپێچیکار لابەرێت، و داوا لە خاوەن هەژمار بکات بیگۆڕێت، و لە کاتی ڕەتکردنەوە یان دووبارەبوونەوەدا هەژمارەکە ڕابگرێت.

## 10. ئەوەی هەژمار ڕادەگرێت یان دایدەخات

### 10.1 پلەکانی کردار
هەژمار چوار دۆخی هەیە: چالاک، سنووردار، ڕاگیراو، و داخراو. هەژماری سنووردار هەندێک کردار لەدەست دەدات، هەژماری ڕاگیراو لە چوونەژوورەوە یان لە مامەڵەکردن ڕێگری لێدەکرێت، و هەژماری داخراو بە شێوەیەکی بێ گەڕانەوە کۆتایی هاتووە.

### 10.2 هۆکارەکانی سنووردارکردن
هەژمار سنووردار دەکرێت بۆ: گومان لە زۆربوونی هەژمار، گومان لە بەکارهێنانی نائاسایی پێشکەشکراوەکان و کۆپۆنەکان، ڕەتکردنەوەی دووبارەی وەرگرتن بێ هۆکار، یان ناکۆکییەکی کراوە کە داوای ڕاگرتنی هەندێک کردار دەکات تا بڕیاری لەسەر دەدرێت.

### 10.3 هۆکارەکانی ڕاگرتن
هەژمار ڕادەگیرێت بۆ: فێڵ یان هەوڵدان بۆی، بەکارهێنانی ئامرازێکی پارەدان کە هی خاوەنەکە نییە، خۆ لە کەسێکی تر چواندن، هەڕەشە یان ملکەچکردنی ئەندامێک یان کارمەندێک، بڵاوکردنەوەی ناوەڕۆکێک کە یاسا قەدەغەی کردووە، هەوڵدان بۆ شکاندنی پلاتفۆرم یان تاقیکردنەوەی لاوازییەکانی بێ ڕێپێدان، بەکارهێنانی تێکچوونێکی تەکنیکی بۆ بەرژەوەندی، دەستکاریکردنی هەڵسەنگاندنەکان یان سیستەمی ناساندن یان سیستەمی خاڵەکان، یان سەرپێچییەکی گەورەی سیاسەتی کۆمەڵگەی لێڤۆ.

### 10.4 هۆکارەکانی داخستن
هەژمار دادەخرێت لە کاتی دووبارەبوونەوەی ئەوەی ڕاگرتنی لێدەکەوێتەوە، یان لە کاتی سەلماندنی فێڵێکی گەورە، یان بە داواکاری خاوەنەکەی بەپێی بەشی یازدەیەم، یان بۆ جێبەجێکردنی فەرمانێکی لایەنێکی پەیوەندیدار.

### 10.5 کرداری دەستبەجێ
فرۆشگا دەتوانێت دەستبەجێ و بەبێ ئاگادارکردنەوەی پێشوەخت سنووردار یان ڕابگرێت ئەگەر دواکەوتن زیان بە کڕیاران یان بە پارەکانیان یان بە تەواوەتیی پلاتفۆرم بگەیەنێت، پاشان خاوەن هەژمار لەوەی ڕوویداوە ئاگادار دەکاتەوە.

### 10.6 ئاگادارکردنەوە و تانە
خاوەن هەژمار لە کردارەکە و لە هۆکارەکەی ئاگادار دەکرێتەوە بەو ڕادەیەی زیان بە ئاسایشی پلاتفۆرم ناگەیەنێت. دەتوانێت لە ماوەی {{ACCOUNT_APPEAL_DAYS}} لە ئاگادارکردنەوەیەوە تانە بدات بۆ {{LEVONIS_SUPPORT_CONTACT}}، و تانەکە لە ماوەی {{DISPUTE_RESPONSE_DAYS}} بڕیاری لەسەر دەدرێت.

### 10.7 کاریگەری ڕاگرتن لەسەر داواکارییە کراوەکان
داواکارییەکی پارەدراو کە هێشتا نەگەیەنراوە یان جێبەجێ دەکرێت یان هەڵدەوەشێنرێتەوە و دەگەڕێندرێتەوە. ڕاگرتن نابێتە هۆکارێک بۆ ڕاگرتنی کاڵایەک کە نرخەکەی دراوە، نە بۆ سڕینەوەی مافێکی جێگیری خاوەن هەژمار، جگە بەو ڕادەیەی پشکنینی ڕووداوێکی فێڵ داوای دەکات.

### 10.8 کاریگەری ڕاگرتن لەسەر جزدان
باڵانسی جزدان موڵکی خاوەنەکەی دەمێنێتەوە. فرۆشگا دەتوانێت دەرکردنی لێی ڕابگرێت تا کۆتاییهاتنی پشکنینێک یان ناکۆکییەک، و ئەوەی بە بڕیارێکی بەهۆکار سەلمێندراوە کە مافی لایەنێکی ترە لێی کەم بکاتەوە.

### 10.9 کاریگەری ڕاگرتن لەسەر خەڵات و ئەندامێتی
دەرکردنی خاڵەکان و سوودەکانی ئەندامێتی بۆ ماوەی ڕاگرتنەکە ڕادەگیرێت. ئەو خاڵ و سوودانەی سەلمێندراوە کە بە سەرپێچی بەدەست هاتوون دەسڕدرێنەوە.

### 10.10 کاریگەری ڕاگرتن لەسەر فرۆشگای بازرگان
ئەگەر خاوەن هەژمار بازرگان بوو، بەشی یازدەیەمی سیاسەتی کۆمەڵگەی لێڤۆ لەسەرەوە بۆی جێبەجێ دەکرێت.

## 11. داخستنی هەژمار لەلایەن کڕیارەوە

### 11.1 مافی داخستن
خاوەن هەژمار دەتوانێت هەر کاتێک بیەوێت هەژمارەکەی دابخات.

### 11.2 چۆن داواکاری داخستن دەکرێت
داواکاری داخستن بۆ {{LEVONIS_SUPPORT_CONTACT}} پێشکەش دەکرێت لەو کەناڵە پشتڕاستکراوەی لەسەر هەژمارەکە تۆمار کراوە. داواکارییەک کە لە کەناڵێکی پشتڕاستنەکراوەوە بێت، یان لە کەسێکەوە جگە لە خاوەن هەژمار، جێبەجێ ناکرێت.

### 11.3 دڵنیابوونەوە پێش جێبەجێکردن
فرۆشگا پێش جێبەجێکردن ناسنامەی داواکار دڵنیا دەکاتەوە — بە کۆدێک بۆ کەناڵە پشتڕاستکراوەکە یان ئەوەی جێگەی دەگرێتەوە — چونکە داخستنی هەژمارێک لەسەر داواکاری ساختەکارێک زیانێکە کە ناگەڕێندرێتەوە.

### 11.4 داواکارییە کراوەکان
داخستن جێبەجێ ناکرێت لە کاتێکدا خاوەنەکەی داواکارییەکی کراوەی هەیە کە هێشتا نەگەیەنراوە یان نەگەڕێندراوەتەوە، یان ناکۆکی یان سکاڵایەک کە هێشتا بڕیاری لەسەر نەدراوە، یان داواکاری گەڕاندنەوە یان داواکاری گەرەنتییەک کە لەبەردەستە. جێبەجێکردن دوا دەخرێت تا ئەمانە کۆتایی دێن، یان داواکارییە کراوەکە بە ڕەزامەندی خاوەن هەژمار هەڵدەوەشێنرێتەوە و دەگەڕێندرێتەوە.

### 11.5 باڵانسی جزدان
خاوەن هەژمار دەبێت پێش داخستن مامەڵە لەگەڵ باڵانسەکەی بکات. دەتوانێت داوای دەرکردنی ئەو باڵانسە بکات کە دەکرێت دەربکرێت بەپێی سیاسەتی پارەدان و جزدان: ئەوەی سپاردەیەکی نەختی گەڕاندنەوەیی بووە بۆی دەگەڕێندرێتەوە، بەڵام ئەوەی باڵانسی بانگەشەیی یان دیاری یان قەرەبووی پێدراو بووە بە نەختی دەرناکرێت و بە داخستن دەڕوات. داواکاری بۆ باڵانسەکە دوای داخستن دەبێت لە ماوەی {{WALLET_BALANCE_CLAIM_DAYS}} بۆ {{LEVONIS_SUPPORT_CONTACT}} بکرێت.

### 11.6 یەکەکانی گەرەنتی
یەکەکانی گەرەنتی و درێژکردنەوەکانیان بەو کاڵایەوە بەستراون کە کڕدراوە و بە پسوڵەکەیەوە، نەک بە بوونی هەژمارەکەوە. ئەوەی هەژمارەکەی داخستووە دەتوانێت بە پسوڵەکەی و ژمارەی داواکارییەکەی داوای گەرەنتیی کاڵاکەی بکات بەپێی سیاسەتی گەرەنتی، تاوەکو ماوەی گەرەنتییەکە هێشتا بەردەوامە. بەڵام داخستن دەستڕاگەیشتنی خۆی بە مێژووی کڕینەکانی لادەبات، بۆیە دەبێت پێش داخستن پسوڵەکانی بپارێزێت.

### 11.7 خاڵ و سوودەکان
خاڵەکانی خەڵات، و باڵانسی بانگەشەیی، و کۆپۆنەکان، و ئەوەی لە ماوەی ئەندامێتی ماوەتەوە بە داخستن دەڕۆن، و نە بۆ پارە و نە بۆ هەژمارێکی تر ناگۆڕدرێن.

### 11.8 ناساندنەکان
ئەو ناساندنانەی کراون وەک ڕووداو تۆمارکراو دەمێننەوە، نە بۆ ناسێنەرەکە دەگەڕێنەوە و نە بۆ کەسێکی تر دەگوازرێنەوە. بەستەری ناساندنی خاوەن هەژماری داخراو لە کارکردن دەوەستێت.

### 11.9 فرۆشگای بازرگان
هەژماری بازرگانێک پێش داخستنی فرۆشگاکەی و یەکلاکردنەوەی داواکارییە کراوەکانی و ناکۆکییەکانی و مافەکانی و گواستنەوەی باڵانسە بەردەستەکەی دانەخرێت.

### 11.10 ماوەی جێبەجێکردن
داخستن لە ماوەی {{ACCOUNT_CLOSURE_PROCESSING_DAYS}} لە تەواوبوونی مەرجەکانی جێبەجێ دەکرێت. خاوەن هەژمار دەتوانێت پێش جێبەجێکردن داواکارییەکەی بکێشێتەوە.

### 11.11 گەڕانەوە نییە دوای جێبەجێکردن
هەژماری داخراو ناکرێتەوە و ناوەڕۆکەکەی ناگەڕێندرێتەوە. ئەوەی بیەوێت دواتر مامەڵە بکات هەژمارێکی نوێ دەکاتەوە، و هیچ شتێکی کۆن بۆی ناگوازرێتەوە.

### 11.12 ناوی بەکارهێنەر دوای داخستن
ناوی بەکارهێنەر دەستبەجێ لە کاتی داخستندا ئازاد ناکرێت، بەڵکو بۆ ماوەی {{USERNAME_RELEASE_DAYS}} پاراستراو دەمێنێتەوە تاکو کەسێکی تر وەرینەگرێت و وا دەرنەکەوێت کە خاوەنە یەکەمەکەیەتی.

## 12. ئەوەی دوای داخستن دەمێنێتەوە، بۆچی، و بۆ چەند ماوەیەک

### 12.1 بنەماکە
ئەوەی لە زانیاری هەژمارەکە پێویست نییە بمێنێتەوە دەسڕدرێتەوە، و ئەوەی بۆ سەلماندنی مامەڵەیەک کە بەڕاستی ڕوویداوە، یان بۆ جێبەجێکردنی ئەرکێکی یاسایی، یان بۆ بەرگریکردن لە مافێک پێویستە، دەمێنێتەوە.

### 12.2 داواکارییەکان و پسوڵەکان
داواکارییەکان و پسوڵەکان، لەگەڵ بڕەکانیان و باجەکانیان و کرێی گەیاندنیان، دەمێننەوە، چونکە بەڵگەنامەی ژمێریاریین و بەڵگەن لەسەر فرۆشتنێک کە ڕوویداوە. بۆ ماوەی {{ORDER_RECORD_RETENTION_YEARS}} دەپارێزرێن.

### 12.3 تۆماری جزدان
تۆمارەکانی جزدان — سپاردە، کەمکردنەوە، ڕاگرتن، و گەڕاندنەوە — دەمێننەوە، چونکە باڵانسێک کە بە تۆمارەکانی ڕوون نەکرێتەوە ناکرێت پشکنین بکرێت. بۆ ماوەی {{WALLET_RECORD_RETENTION_YEARS}} دەپارێزرێن.

### 12.4 تۆماری قبوڵکردنی سیاسەتەکان
تۆماری قبوڵکردنی خاوەن هەژمار بۆ سیاسەتەکان، و دەقی ئەو وەشانەی قبوڵی کردووە، دەمێنێتەوە، چونکە قبوڵکردنێک کە دەقەکەی دوای چەند ساڵێک ناکرێت پیشان بدرێت بێ بەهایە. بۆ ماوەی {{POLICY_ACCEPTANCE_RETENTION_YEARS}} دەپارێزرێت.

### 12.5 تۆماری پشکنین
تۆمارەکانی ئاسایش و پشکنین — هەوڵەکانی چوونەژوورەوە، گۆڕانکارییە هەستیارەکان، و بڕیارە ئیدارییەکان — بۆ ماوەی {{AUDIT_LOG_RETENTION_YEARS}} دەمێننەوە، و لە سەرەتاوە بە شێوەی داپۆشراو نووسراون، بۆیە ناشێن ببنە لیستی پەیامنێردن.

### 12.6 گفتوگۆکان
ئەو پەیامانەی پەیوەندییان بە داواکارییەک یان بە ناکۆکییەکەوە هەیە بۆ ماوەی {{CHAT_RETENTION_YEARS}} دەمێننەوە چونکە بەڵگەی هەردوو لایەنن. پاراستنیان گەیشتن پێیان نییە، و لەژێر حوکمی بەشی شەشەمی سیاسەتی کۆمەڵگەی لێڤۆ دەمێننەوە.

### 12.7 هەڵسەنگاندنەکان
هەڵسەنگاندنێکی بڵاوکراوە دوای داخستنی هەژماری نووسەرەکەی دەمێنێتەوە، و لە ناسنامەکەی جیا دەکرێتەوە تاکو چیتر بە ناو بۆی نەگەڕێندرێتەوە. سڕینەوەی ئەو وێنەیە تێکدەدات کە کڕیاری ڕاستەقینە لە بازرگانێک دروستیان کردووە.

### 12.8 سڕینەوە بەرامبەر بێناسنامەکردن
لەو شوێنەی سڕینەوە دەکرێت، سڕینەوە دەکرێت. لەو شوێنەی ناکرێت — چونکە دێڕەکە خۆی بەڵگەی مامەڵەیەکە — زانیارییە کەسییەکە لێی جیا دەکرێتەوە و دێڕەکە بێ ناسنامە دەمێنێتەوە.

### 12.9 پاڵپشتەکان
لەوانەیە زانیاری بۆ ماوەیەکی کورت دوای سڕینەوەی لە سیستەمە زیندووەکە لە پاڵپشتەکاندا بمێنێتەوە، تا سووڕی ئەو پاڵپشتانە تەواو دەبێت. ئەم پاڵپشتانە تەنیا بۆ گەڕانەوە لە تێکچوونێک بەکاردەهێندرێن.

### 12.10 ئاماژە بۆ سیاسەتی تایبەتمەندێتی
وردەکاری ئەوەی کۆدەکرێتەوە و بۆچی و چۆن دەپارێزرێت و مافەکانی خاوەنی زانیاری بۆ دەستڕاگەیشتن و ڕاستکردنەوە و ناڕەزایی شوێنی سیاسەتی تایبەتمەندێتییە، و ئەم بڕگانە لەگەڵ ئەو دەخوێنرێنەوە.

## 13. حوکمە گشتی و کۆتاییەکان

### 13.1 هەموارکردن
فرۆشگا دەتوانێت ئەم سیاسەتە هەموار بکات بە دەرکردنی وەشانێکی نوێ بە ژمارە و بەرواری جێبەجێبوونەوە. خاوەن هەژمار لە هەمواری بنەڕەتی لە ڕێگەی کەناڵە پشتڕاستکراوەکەیەوە ئاگادار دەکرێتەوە، و هەمواری کاریگەری دواوەی نییە لەسەر ڕووداوێک کە پێش جێبەجێبوونی ڕوویداوە.

### 13.2 سەربەخۆیی بڕگەکان
پووچبوونەوەی بڕگەیەک کاریگەری لەسەر دروستی بڕگەکانی تر نییە.

### 13.3 زمان
لە کاتی جیاوازی سێ وەشانەکەدا دەقی عەرەبی دەبڕێت بەپێی بڕگەی 1.4.

### 13.4 ئاماژە
ئەوەی لێرەدا دەقی لەسەر نەهاتووە بۆ مەرج و ڕێساکانی گشتی و بۆ ئەو سیاسەتەی بابەتەکەی دەگرێتەوە دەگەڕێندرێتەوە.

### 13.5 یاسا و دەسەڵاتی دادوەری
ئەم بەڵگەنامەیە بەپێی یاساکانی {{GOVERNING_LAW_JURISDICTION}} دەبێت، و دەسەڵاتی دادوەری بۆ دادگاکانی {{COMPETENT_COURT}}ـە.

### 13.6 خاڵی پەیوەندی
خاڵی پەیوەندی پەسەندکراو {{LEVONIS_SUPPORT_CONTACT}}ـە، کاتی کارکردن {{LEVONIS_SUPPORT_HOURS}}ـە، و ناونیشان {{LEVONIS_ADDRESS}}ـە.`,
  },
};
