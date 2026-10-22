import type { PolicyDocument } from './types';

/**
 * القراءة الآلية في مساعد الدعم — what the support assistant sends to an
 * outside AI provider when the shop turns automatic reading on, what it keeps
 * (nothing read), and what never comes from AI (push B plan §12.5; the
 * acceptance matrix's no-training row).
 *
 * WHY IT IS ITS OWN DOCUMENT. Push B ships switched off (ai_settings.enabled =
 * 0, migration 0210). Support policy chapter 3 describes the assistant as it
 * works today, by fixed rules alone, and stays true while the layer is off;
 * this document says, in article 1.2, that it applies only once the shop turns
 * reading on. The two never contradict each other on a given day.
 *
 * WHAT THE CODE FIXES, AND THE ARTICLE THAT SAYS SO:
 *  - A read happens only on the customer's tap and after the consent sheet;
 *    the server refuses a read without `consent: true` (2.1, 5.1).
 *  - Only the file tapped is sent: a photo re-encoded without its metadata,
 *    up to four frames of a clip (never its sound), or a voice note (2.1,
 *    3.1). Sorani speech is never sent (2.3).
 *  - A typed message reaches a provider only after the fixed rules and the
 *    catalogue lookup found nothing, with e-mail addresses, phone numbers and
 *    order numbers taken out, and with no name or account (2.2, 3.1).
 *  - Nothing read is stored; the ledger keeps counts and result codes only,
 *    with no user id and no address (3.2, 3.3; worker/lib/ai/budget.ts).
 *  - Every reply is a hand-written template over the shop's own data: prices,
 *    availability, compatibility and error-code meanings never come from a
 *    model (4.1). A candidate is used only after the customer's tap (4.2).
 *
 * The provider names are company names, not model names: no model is named in
 * this repository (the repository is public).
 */
export const assistant_ai: PolicyDocument = {
  key: 'assistant_ai',
  version: 1,
  effective_at: '2026-10-22',
  title: {
    ar: 'القراءة الآلية في مساعد الدعم',
    en: 'Automatic Reading in the Support Assistant',
    ckb: 'خوێندنەوەی خۆکار لە یاریدەدەری پشتگیریدا',
  },
  body: {
    ar: `## 1. النطاق

### 1.1 ما تغطيه هذه الوثيقة
تبيّن هذه الوثيقة كيف يستعين مساعد الدعم في Levonis بمزوّد ذكاء اصطناعي خارجي لقراءة بعض ما يرسله الزبون، وما يُرسل إليه، وما يُحفظ وما لا يُحفظ، وما لا يأتي أبدًا من الذكاء الاصطناعي.

### 1.2 متى تسري
تسري هذه الوثيقة فقط حين تشغّل إدارة المتجر القراءة الآلية. وما دامت متوقفة يعمل المساعد بالقواعد الثابتة وحدها كما تصفه سياسة الدعم في فصلها الثالث، ولا يُرسل شيء إلى أي مزوّد.

## 2. القراءة الآلية

### 2.1 المرفقات
القراءة الآلية للمرفقات اختيارية. عندما تضغط «اقرأ الصورة» أو «حوّل التسجيل إلى نص» نرسل ذلك الملف وحده إلى مزوّد ذكاء اصطناعي يعمل لحسابنا (Anthropic أو Cloudflare) لقراءة الرموز أو الكلام فقط. ومن المقطع المصوّر تُرسل لقطات قليلة منه، لا صوته.

### 2.2 الرسائل المكتوبة
الرسائل التي لا تفهمها القواعد الثابتة قد تُرسل إلى المزوّد نفسه بلا اسمك أو حسابك ليختار الجواب من بياناتنا. وتُحذف منها قبل الإرسال عناوين البريد وأرقام الهواتف وأرقام الطلبات.

### 2.3 الرسائل الصوتية
يتحوّل التسجيل إلى نص يظهر في خانة الكتابة لديك، فتراجعه وتعدّله قبل إرساله. ولا يُرسل الكلام الكردي إلى أي مزوّد.

## 3. ما يُرسل وما يُحفظ

### 3.1 ما يُرسل
يُرسل الملف الذي اخترت قراءته، بعد حذف بيانات الموقع والجهاز من الصورة، أو نص رسالتك بعد الحذف الوارد في المادة 2.2. ولا يُرسل معه اسمك ولا حسابك ولا طلباتك.

### 3.2 ما لا يُحفظ
لا نحفظ النص المستخرج من الملفات، ولا نتيجة القراءة، ولا الصور أو اللقطات المرسلة للقراءة.

### 3.3 ما يُسجَّل
نسجّل فقط عدد الطلبات ورموز النتيجة وكلفتها، بلا معرّف مستخدم ولا عنوان شبكة.

### 3.4 التدريب والتسويق
لا يُستخدم شيء من ذلك لتدريب النماذج ولا للتسويق.

## 4. حدود القراءة الآلية

### 4.1 ما لا يأتي من الذكاء الاصطناعي
الأسعار والتوفر والتوافق ومعاني رموز الأخطاء لا تأتي أبدًا من الذكاء الاصطناعي، بل من بيانات المتجر الحقيقية وخطواته المكتوبة يدويًا.

### 4.2 التأكيد قبل الاستعمال
ما يُقرأ من صورة أو مقطع يُعرض عليك اقتراحًا تؤكده بضغطة، ولا يُختار عنك شيء. ويحمل الجواب المستعان فيه بالذكاء الاصطناعي إشارة تبيّن ذلك، ومعه خيار «ليس هذا ما قصدته».

## 5. اختيارك

### 5.1 الموافقة
قبل أول قراءة نعرض عليك ملاحظة القراءة الآلية، ولك أن ترفض. فإن رفضت بقي المرفق مرفقًا كما هو، ويراه الفريق إذا فتحت تذكرة.`,
    en: `## 1. Scope

### 1.1 What this document covers
This document explains how the Levonis support assistant uses an outside AI provider to read some of what a customer sends, what is sent to it, what is and is not kept, and what never comes from AI.

### 1.2 When it applies
This document applies only while the shop has turned automatic reading on. While it is off, the assistant works by fixed rules alone, as chapter 3 of the support policy describes, and nothing is sent to any provider.

## 2. Automatic reading

### 2.1 Attachments
Automatic reading of attachments is optional. When you press «Read the photo» or «Turn the recording into text», we send that one file to an AI provider working for us (Anthropic or Cloudflare), only to read codes or speech. From a clip, a few of its frames are sent, never its sound.

### 2.2 Typed messages
Messages our fixed rules cannot understand may be sent to the same provider, without your name or account, so it can pick the answer from our data. E-mail addresses, phone numbers and order numbers are removed from them before they are sent.

### 2.3 Voice notes
A recording is turned into text that appears in your own message box, where you check and edit it before you send it. Kurdish speech is never sent to any provider.

## 3. What is sent and what is kept

### 3.1 What is sent
The file you chose to have read, with the location and device data removed from a photo, or the text of your message after the removals in article 2.2. Your name, your account and your orders are not sent with it.

### 3.2 What is not kept
We do not keep the text read from files, the result of a reading, or the pictures or frames sent to be read.

### 3.3 What is recorded
We record only the number of requests, their result codes and their cost, with no user id and no network address.

### 3.4 Training and marketing
None of this is used to train models or for marketing.

## 4. The limits of automatic reading

### 4.1 What never comes from AI
Prices, availability, compatibility and error-code meanings never come from AI. They come from the shop's real data and its hand-written steps.

### 4.2 Confirmed before it is used
What is read from a photo or a clip is shown to you as a suggestion you confirm with a tap; nothing is chosen for you. A reply that AI helped with carries a mark that says so, together with the choice «That is not what I meant».

## 5. Your choice

### 5.1 Consent
Before the first reading we show you a note about automatic reading, and you may decline. If you decline, the attachment stays attached as it is, and the team sees it if you open a ticket.`,
    ckb: `## 1. بوار

### 1.1 ئەم بەڵگەنامەیە چی دەگرێتەوە
ئەم بەڵگەنامەیە ڕوون دەکاتەوە کە یاریدەدەری پشتگیری Levonis چۆن پشت بە دابینکەرێکی دەرەکی زیرەکی دەستکرد دەبەستێت بۆ خوێندنەوەی هەندێک لەوەی کڕیار دەینێرێت، چی بۆی دەنێردرێت، چی هەڵدەگیرێت و چی هەڵناگیرێت، و چی هەرگیز لە زیرەکی دەستکردەوە نایەت.

### 1.2 کەی جێبەجێ دەبێت
ئەم بەڵگەنامەیە تەنها کاتێک جێبەجێ دەبێت کە بەڕێوەبەرایەتی فرۆشگاکە خوێندنەوەی خۆکاری چالاک کردبێت. تا ئەو کاتەی ڕاگیراوە، یاریدەدەرەکە تەنها بە یاسا جێگیرەکان کار دەکات، وەک فەسڵی سێیەمی سیاسەتی پشتگیری باسی دەکات، و هیچ شتێک بۆ هیچ دابینکەرێک نانێردرێت.

## 2. خوێندنەوەی خۆکار

### 2.1 هاوپێچەکان
خوێندنەوەی خۆکاری هاوپێچەکان ئارەزوومەندانەیە. کاتێک «وێنەکە بخوێنەوە» یان «تۆمارەکە بکە بە نووسین» دادەگریت، تەنها ئەو فایلە دەنێرین بۆ دابینکەرێکی زیرەکی دەستکرد کە بۆ ئێمە کار دەکات (Anthropic یان Cloudflare)، تەنها بۆ خوێندنەوەی کۆد یان قسە. لە ڤیدیۆ تەنها چەند وێنەیەکی دەنێردرێت، هەرگیز دەنگەکەی نا.

### 2.2 نامە نووسراوەکان
ئەو نامانەی یاسا جێگیرەکانمان تێیان ناگەن، لەوانەیە بەبێ ناو و ئەکاونتەکەت بنێردرێن بۆ هەمان دابینکەر تا وەڵامەکە لە داتاکانمان هەڵبژێرێت. پێش ناردن، ناونیشانی ئیمەیڵ و ژمارەی تەلەفۆن و ژمارەی داواکارییەکانیان لێ دەسڕدرێتەوە.

### 2.3 نامە دەنگییەکان
تۆمارەکە دەکرێت بە نووسینێک کە لە خانەی نووسینی خۆتدا دەردەکەوێت، و پێش ناردنی دەیپشکنیت و دەستکاری دەکەیت. قسەی کوردی هەرگیز بۆ هیچ دابینکەرێک نانێردرێت.

## 3. چی دەنێردرێت و چی هەڵدەگیرێت

### 3.1 چی دەنێردرێت
ئەو فایلەی هەڵتبژاردووە بخوێندرێتەوە، دوای سڕینەوەی زانیاری شوێن و ئامێر لە وێنەکە، یان دەقی نامەکەت دوای ئەو سڕینەوانەی لە بڕگەی 2.2دا هاتووە. ناو و ئەکاونت و داواکارییەکانت لەگەڵیدا نانێردرێن.

### 3.2 چی هەڵناگیرێت
ئەو دەقەی لە فایلەکان دەخوێندرێتەوە هەڵناگرین، نە ئەنجامی خوێندنەوەکە، نە ئەو وێنە و وێنە ڤیدیۆییانەی بۆ خوێندنەوە نێردراون.

### 3.3 چی تۆمار دەکرێت
تەنها ژمارەی داواکارییەکان و کۆدی ئەنجامەکانیان و تێچوویان تۆمار دەکەین، بەبێ ناسنامەی بەکارهێنەر و بەبێ ناونیشانی تۆڕ.

### 3.4 ڕاهێنان و ڕیکلام
هیچ کام لەمانە بۆ ڕاهێنانی مۆدێل یان ڕیکلام بەکارناهێنرێت.

## 4. سنوورەکانی خوێندنەوەی خۆکار

### 4.1 ئەوەی هەرگیز لە زیرەکی دەستکردەوە نایەت
نرخ، بەردەستبوون، گونجان و مانای کۆدی هەڵەکان هەرگیز لە زیرەکی دەستکردەوە نایەن، بەڵکو لە داتای ڕاستەقینەی فرۆشگاکە و هەنگاوە دەستنووسەکانییەوە دێن.

### 4.2 پشتڕاستکردنەوە پێش بەکارهێنان
ئەوەی لە وێنە یان ڤیدیۆیەک دەخوێندرێتەوە، وەک پێشنیارێک پیشانت دەدرێت کە بە یەک دەستلێدان پشتڕاستی دەکەیتەوە؛ هیچ شتێک لە جیاتی تۆ هەڵنابژێردرێت. ئەو وەڵامەی زیرەکی دەستکرد یارمەتی تێدا داوە نیشانەیەکی پێوەیە کە ئەمە دەڵێت، لەگەڵ هەڵبژاردنی «مەبەستم ئەمە نەبوو».

## 5. هەڵبژاردنی تۆ

### 5.1 ڕەزامەندی
پێش یەکەم خوێندنەوە تێبینییەکی خوێندنەوەی خۆکارت پیشان دەدەین، و دەتوانیت ڕەتی بکەیتەوە. ئەگەر ڕەتت کردەوە، هاوپێچەکە وەک خۆی هاوپێچ دەمێنێتەوە، و تیمەکە دەیبینێت ئەگەر تیکێتێک بکەیتەوە.`,
  },
};
