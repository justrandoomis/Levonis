/**
 * «الذكاء الاصطناعي للمساعد» — THE OWNER TAB OF THE ASSISTANT AI LAYER
 * (push B1; plan §10, §11, §12.4).
 *
 * WHAT IT IS FOR. The layer ships dark: off, no model, no rates. The owner
 * turns it on here, and nowhere else, without a deploy:
 *
 *   1. the master switch, the daily cap in USD (UTC days, $1.00 by default,
 *      $50 at most), signed-out visitors and their share of the cap, and
 *      whether questions typed in Sorani may be read;
 *   2. per task (typed questions, photos and clip frames, voice notes) a
 *      primary and a fallback model, picked ONLY from the live list the
 *      provider returns at that moment, with the prices copied by hand from
 *      the pricing page of the provider; a Test button per task;
 *   3. health: whether the key, the Workers AI binding and the images binding
 *      exist (yes or no, never a prefix or a length), the circuit, the last
 *      failure code;
 *   4. the ledger: today and the last seven days, by task.
 *
 * NOTHING HERE NAMES A MODEL. Model ids exist only in the D1 rows the owner
 * writes from this tab and in the list the server fetches live; this file
 * draws whatever comes back. The model output of a Test never reaches the
 * browser: the server answers with codes, milliseconds and a cost only.
 *
 * WHO. Mounted by src/pages/Admin.tsx for the verified owner only, a
 * courtesy: every route under /api/admin/assist-ai refuses anyone else, and
 * every write asks for a recent sign-in (REAUTH_REQUIRED otherwise).
 *
 * Its own lazy chunk, with the frame-drawing helper of the vision Test behind
 * a second dynamic import (src/lib/assistMedia.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, FlaskConical, LogIn, Mic, RefreshCw, Square } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useOptionalAuth } from '../AuthContext';
import { api, ApiError } from '../lib/api';
import { apiRefusal, refusalLang } from '../lib/refusalStrings';
import { formatElapsed, useVoiceRecorder } from '../lib/voiceRecorder';
import { Card } from './ui/Card';
import { Button } from './ui/Button';
import { Field, Input, Select } from './ui/Field';
import { Switch } from './ui/Switch';
import { StatusChip, type Tone } from './ui/Badge';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { toast } from './ui/Toast';

// ------------------------------------------------------------------ words

const AR = {
  tab: 'الذكاء الاصطناعي للمساعد',
  subtitle: 'طبقة اختيارية فوق المساعد الأساسي. الأسعار والتوفر والحلول تبقى من بيانات المتجر؛ النموذج يفهم السؤال ويقرأ المرفق فقط.',
  enabled: 'تشغيل طبقة الذكاء الاصطناعي',
  off_note: 'متوقفة: المساعد يعمل بالوضع الأساسي (قواعد ثابتة).',
  cap: 'الحد اليومي للإنفاق (دولار أمريكي، يتجدد 00:00 UTC)',
  spent: 'المصروف اليوم: {spent} من {cap}',
  cap_reached: 'بلغ الإنفاق الحد اليومي: الوضع الأساسي حتى 00:00 UTC.',
  guests: 'السماح للزوار غير المسجلين باستخدام فهم الأسئلة',
  guest_share: 'الحصة القصوى للزوار غير المسجلين من السقف (%)',
  understand_ckb: 'السماح للنموذج بقراءة الأسئلة المكتوبة بالسورانية — الردود تبقى قوالب مكتوبة يدويًا',
  task_understand: 'فهم الأسئلة المكتوبة',
  task_vision: 'قراءة الصور ولقطات المقاطع',
  task_speech: 'تحويل الرسائل الصوتية إلى نص',
  primary: 'الأساسي',
  fallback: 'الاحتياطي',
  no_model: 'لم يُختر نموذج: هذه المهمة بالوضع الأساسي.',
  pick_model: 'اختر نموذجًا من قائمة المزوّد',
  list_unavailable: 'تعذّر جلب قائمة النماذج من المزوّد الآن.',
  list_manual: 'تعذّر جلب القائمة: اكتب معرّف النموذج يدويًا، ولن يُحفظ إلا بعد تجربة ناجحة.',
  model_gone: 'النموذج لم يعد في قائمة المزوّد: اختر غيره.',
  rate_in: 'سعر المدخلات لكل مليون رمز (دولار)',
  rate_out: 'سعر المخرجات لكل مليون رمز (دولار)',
  rate_cache_write: 'سعر كتابة الذاكرة المؤقتة لكل مليون رمز (دولار)',
  rate_cache_read: 'سعر قراءة الذاكرة المؤقتة لكل مليون رمز (دولار)',
  rate_minute: 'السعر لكل دقيقة صوت (دولار)',
  rates_note: 'انسخ الأسعار من صفحة أسعار المزوّد؛ لا يعمل نموذج بلا سعر.',
  worst_case_warn: 'قد تكلف المكالمة الواحدة لهذه المهمة حتى {cost} دولار، وهذا أكثر من عُشر السقف اليومي فلن تعمل. ارفع السقف أو اختر نموذجًا أرخص.',
  save: 'حفظ',
  remove: 'إزالة النموذج',
  test: 'تجربة',
  test_ok: 'نجحت التجربة ({ms} مللي ثانية)',
  test_fail: 'فشلت التجربة: {code}',
  test_record: 'سجّل جملة قصيرة (حتى 10 ثوانٍ) لتجربة تحويل الصوت إلى نص. لا يُحفظ التسجيل.',
  key_set: 'مفتاح المزوّد مضبوط',
  key_missing: 'مفتاح المزوّد غير مضبوط',
  binding_ok: 'ربط Workers AI موجود',
  binding_missing: 'ربط Workers AI غير موجود',
  images_ok: 'ربط الصور موجود',
  images_missing: 'ربط الصور غير موجود',
  circuit: 'متوقف مؤقتًا بعد أعطال متتالية حتى {time}',
  failures: 'الإخفاقات خلال ٢٤ ساعة',
  diagnose_note: 'التشخيص الذكي يعمل دون هذه المهمة.',
  section_master: 'التشغيل والسقف',
  section_health: 'الحالة',
  section_ledger: 'سجل الاستخدام',
  loading: 'جارٍ التحميل…',
  load_failed: 'تعذر تحميل إعدادات الذكاء الاصطناعي.',
  retry: 'إعادة المحاولة',
  not_migrated: 'جداول طبقة الذكاء الاصطناعي غير مثبتة بعد على قاعدة البيانات: المساعد يعمل بالوضع الأساسي.',
  saved: 'حُفظ.',
  failed: 'تعذر الحفظ، حاول مرة أخرى.',
  reauth: 'لحماية الإعدادات، سجّل الدخول مجددًا ثم أعد المحاولة.',
  sign_in_again: 'سجّل الدخول مجددًا',
  ready: 'جاهز',
  not_ready: 'غير جاهز',
  change: 'تغيير',
  choose: 'اختيار نموذج',
  cancel: 'إلغاء',
  model_id: 'معرّف النموذج',
  list_loading: 'جارٍ جلب القائمة من المزوّد…',
  rates_short: 'الأسعار (دولار)',
  remove_confirm: 'إزالة هذا النموذج؟',
  remove_consequence: 'تعمل المهمة بالنموذج الآخر إن وُجد، وإلا بالوضع الأساسي.',
  record: 'تسجيل',
  stop: 'إيقاف وتجربة',
  test_valid: 'الرد صالح',
  test_invalid: 'الرد غير صالح',
  test_expected: 'النتيجة كما هو متوقع',
  test_unexpected: 'النتيجة ليست كما هو متوقع',
  test_cost: 'الكلفة: {cost} دولار',
  test_manual_first: 'جرّب المعرّف أولًا: يُحفظ بعد تجربة ناجحة فقط.',
  cap_invalid: 'أدخل مبلغًا من 0 إلى 50 دولارًا، بخانتين عشريتين على الأكثر.',
  share_invalid: 'أدخل نسبة من 0 إلى 100.',
  rate_invalid: 'أدخل سعرًا صحيحًا بست خانات عشرية على الأكثر؛ الأسعار المطلوبة أكبر من صفر.',
  id_invalid: 'المعرّف يحوي حروفًا غير مسموحة.',
  today: 'اليوم (UTC)',
  reserved: 'محجوز',
  guest_spent: 'إنفاق الزوار',
  calls: 'الطلبات',
  ok_calls: 'الناجحة',
  failed_calls: 'الإخفاقات',
  cost: 'الكلفة (دولار)',
  day: 'اليوم',
  task: 'المهمة',
  week: 'آخر ٧ أيام',
  no_usage: 'لا استخدام بعد.',
  last_ok: 'آخر نجاح',
  last_fail: 'آخر إخفاق',
  never: 'لا يوجد',
  running: 'يعمل',
  refresh: 'تحديث',
} as const;

type Key = keyof typeof AR;

const EN: Record<Key, string> = {
  tab: 'Assistant AI',
  subtitle: 'An optional layer over the basic assistant. Prices, stock and fixes still come from the data of the shop; the model only understands the question and reads the attachment.',
  enabled: 'Turn the AI layer on',
  off_note: 'Off: the assistant runs in basic mode (fixed rules).',
  cap: 'Daily spend cap (USD, resets 00:00 UTC)',
  spent: 'Spent today: {spent} of {cap}',
  cap_reached: 'Daily cap reached: basic mode until 00:00 UTC.',
  guests: 'Let signed-out visitors use question understanding',
  guest_share: 'Most of the cap guests may use (%)',
  understand_ckb: 'Let the model read questions typed in Sorani — replies stay hand-written templates',
  task_understand: 'Understanding typed questions',
  task_vision: 'Reading photos and clip frames',
  task_speech: 'Turning voice notes into text',
  primary: 'Primary',
  fallback: 'Fallback',
  no_model: 'No model chosen: this task runs in basic mode.',
  pick_model: 'Pick a model from the list of the provider',
  list_unavailable: 'The model list of the provider could not be fetched right now.',
  list_manual: 'The list could not be fetched: type the model id by hand; it is saved only after a passing test.',
  model_gone: 'This model is no longer in the list of the provider: pick another.',
  rate_in: 'Input price per million tokens (USD)',
  rate_out: 'Output price per million tokens (USD)',
  rate_cache_write: 'Cache write price per million tokens (USD)',
  rate_cache_read: 'Cache read price per million tokens (USD)',
  rate_minute: 'Price per audio minute (USD)',
  rates_note: 'Copy the prices from the pricing page of the provider; a model without prices does not run.',
  worst_case_warn: 'One call for this task could cost up to {cost} USD, more than a tenth of the daily cap, so it will not run. Raise the cap or pick a cheaper model.',
  save: 'Save',
  remove: 'Remove model',
  test: 'Test',
  test_ok: 'Test passed ({ms} ms)',
  test_fail: 'Test failed: {code}',
  test_record: 'Record a short sentence (up to 10 seconds) to test speech to text. The recording is not kept.',
  key_set: 'Provider key is set',
  key_missing: 'Provider key is not set',
  binding_ok: 'Workers AI binding present',
  binding_missing: 'Workers AI binding missing',
  images_ok: 'Images binding present',
  images_missing: 'Images binding missing',
  circuit: 'Paused after repeated failures until {time}',
  failures: 'Failures in the last 24 hours',
  diagnose_note: 'Smart Diagnose works without this task.',
  section_master: 'Switch and cap',
  section_health: 'Health',
  section_ledger: 'Usage ledger',
  loading: 'Loading…',
  load_failed: 'The AI settings could not be loaded.',
  retry: 'Retry',
  not_migrated: 'The tables of the AI layer are not installed on the database yet: the assistant runs in basic mode.',
  saved: 'Saved.',
  failed: 'Could not save. Try again.',
  reauth: 'To protect the settings, sign in again, then retry.',
  sign_in_again: 'Sign in again',
  ready: 'Ready',
  not_ready: 'Not ready',
  change: 'Change',
  choose: 'Choose a model',
  cancel: 'Cancel',
  model_id: 'Model id',
  list_loading: 'Fetching the list from the provider…',
  rates_short: 'Prices (USD)',
  remove_confirm: 'Remove this model?',
  remove_consequence: 'The task runs on the other model if there is one, or in basic mode.',
  record: 'Record',
  stop: 'Stop and test',
  test_valid: 'The answer was valid',
  test_invalid: 'The answer was not valid',
  test_expected: 'The result was as expected',
  test_unexpected: 'The result was not as expected',
  test_cost: 'Cost: {cost} USD',
  test_manual_first: 'Test the id first: it is saved only after a passing test.',
  cap_invalid: 'Enter an amount from 0 to 50 USD, with at most two decimals.',
  share_invalid: 'Enter a share from 0 to 100.',
  rate_invalid: 'Enter a valid price with at most six decimals; the required prices are above zero.',
  id_invalid: 'The id has characters that are not allowed.',
  today: 'Today (UTC)',
  reserved: 'Reserved',
  guest_spent: 'Guest spend',
  calls: 'Calls',
  ok_calls: 'OK',
  failed_calls: 'Failures',
  cost: 'Cost (USD)',
  day: 'Day',
  task: 'Task',
  week: 'Last 7 days',
  no_usage: 'No usage yet.',
  last_ok: 'Last success',
  last_fail: 'Last failure',
  never: 'Never',
  running: 'Running',
  refresh: 'Refresh',
};

const CKB: Record<Key, string> = {
  tab: 'زیرەکی دەستکردی یاریدەدەر',
  subtitle: 'چینێکی ئارەزوومەندانە لەسەر یاریدەدەری بنەڕەتی. نرخ و بەردەستبوون و چارەسەرەکان هەر لە داتای فرۆشگاکەوە دێن؛ مۆدێلەکە تەنها لە پرسیارەکە تێدەگات و هاوپێچەکە دەخوێنێتەوە.',
  enabled: 'چالاککردنی چینی زیرەکی دەستکرد',
  off_note: 'ڕاگیراوە: یاریدەدەرەکە بە دۆخی بنەڕەتی (یاسا جێگیرەکان) کار دەکات.',
  cap: 'سنووری ڕۆژانەی خەرجی (دۆلاری ئەمریکی، لە 00:00 UTC نوێ دەبێتەوە)',
  spent: 'خەرجی ئەمڕۆ: {spent} لە {cap}',
  cap_reached: 'خەرجی گەیشتە سنووری ڕۆژانە: دۆخی بنەڕەتی تا 00:00 UTC.',
  guests: 'ڕێگەدان بە سەردانکەرانی چوونەژوورەوە نەکردوو بۆ بەکارهێنانی تێگەیشتن لە پرسیار',
  guest_share: 'زۆرترین بەشی سنوورەکە بۆ میوانانی بێ ئەکاونت (%)',
  understand_ckb: 'ڕێگەدان بە مۆدێلەکە بۆ خوێندنەوەی پرسیارە نووسراوەکان بە سۆرانی — وەڵامەکان هەر لە قاڵبە دەستنووسەکانەوە دێن',
  task_understand: 'تێگەیشتن لە پرسیارە نووسراوەکان',
  task_vision: 'خوێندنەوەی وێنە و وێنەکانی ڤیدیۆ',
  task_speech: 'گۆڕینی نامە دەنگییەکان بۆ نووسین',
  primary: 'سەرەکی',
  fallback: 'یەدەگ',
  no_model: 'هیچ مۆدێلێک هەڵنەبژێردراوە: ئەم ئەرکە بە دۆخی بنەڕەتی کار دەکات.',
  pick_model: 'مۆدێلێک لە لیستی دابینکەرەکە هەڵبژێرە',
  list_unavailable: 'ئێستا نەتوانرا لیستی مۆدێلەکان لە دابینکەرەکەوە وەربگیرێت.',
  list_manual: 'نەتوانرا لیستەکە وەربگیرێت: ناسنامەی مۆدێلەکە بە دەست بنووسە؛ تەنها دوای تاقیکردنەوەیەکی سەرکەوتوو پاشەکەوت دەکرێت.',
  model_gone: 'ئەم مۆدێلە چیتر لە لیستی دابینکەرەکەدا نییە: یەکێکی تر هەڵبژێرە.',
  rate_in: 'نرخی تێخراو بۆ هەر ملیۆن تۆکن (دۆلار)',
  rate_out: 'نرخی دەرچوو بۆ هەر ملیۆن تۆکن (دۆلار)',
  rate_cache_write: 'نرخی نووسینی کاش بۆ هەر ملیۆن تۆکن (دۆلار)',
  rate_cache_read: 'نرخی خوێندنەوەی کاش بۆ هەر ملیۆن تۆکن (دۆلار)',
  rate_minute: 'نرخ بۆ هەر خولەکێکی دەنگ (دۆلار)',
  rates_note: 'نرخەکان لە پەڕەی نرخی دابینکەرەکەوە کۆپی بکە؛ مۆدێلێک بێ نرخ کار ناکات.',
  worst_case_warn: 'یەک بانگکردن بۆ ئەم ئەرکە لەوانەیە تا {cost} دۆلار تێبچێت، کە زیاترە لە یەک لە دەی سنووری ڕۆژانە، بۆیە کار ناکات. سنوورەکە بەرز بکەرەوە یان مۆدێلێکی هەرزانتر هەڵبژێرە.',
  save: 'پاشەکەوتکردن',
  remove: 'لابردنی مۆدێل',
  test: 'تاقیکردنەوە',
  test_ok: 'تاقیکردنەوەکە سەرکەوتوو بوو ({ms} میلی چرکە)',
  test_fail: 'تاقیکردنەوەکە سەرنەکەوت: {code}',
  test_record: 'ڕستەیەکی کورت تۆمار بکە (تا ١٠ چرکە) بۆ تاقیکردنەوەی گۆڕینی دەنگ بۆ دەق. تۆمارەکە هەڵناگیرێت.',
  key_set: 'کلیلی دابینکەر دانراوە',
  key_missing: 'کلیلی دابینکەر دانەنراوە',
  binding_ok: 'بەستنەوەی Workers AI هەیە',
  binding_missing: 'بەستنەوەی Workers AI نییە',
  images_ok: 'بەستنەوەی وێنە هەیە',
  images_missing: 'بەستنەوەی وێنە نییە',
  circuit: 'دوای چەند هەڵەیەکی یەک لە دوای یەک تا {time} ڕاگیراوە',
  failures: 'شکستەکان لە ٢٤ کاتژمێری ڕابردوودا',
  diagnose_note: 'دەستنیشانکردنی زیرەک بەبێ ئەم ئەرکە کار دەکات.',
  section_master: 'چالاککردن و سنوور',
  section_health: 'دۆخ',
  section_ledger: 'تۆماری بەکارهێنان',
  loading: 'بارکردن…',
  load_failed: 'نەتوانرا ڕێکخستنەکانی زیرەکی دەستکرد باربکرێن.',
  retry: 'هەوڵدانەوە',
  not_migrated: 'خشتەکانی چینی زیرەکی دەستکرد هێشتا لەسەر بنکەدراوەکە دانەمەزراون: یاریدەدەرەکە بە دۆخی بنەڕەتی کار دەکات.',
  saved: 'پاشەکەوت کرا.',
  failed: 'پاشەکەوت نەکرا، دووبارە هەوڵ بدەرەوە.',
  reauth: 'بۆ پاراستنی ڕێکخستنەکان، دووبارە بچۆ ژوورەوە و پاشان هەوڵ بدەرەوە.',
  sign_in_again: 'دووبارە بچۆ ژوورەوە',
  ready: 'ئامادەیە',
  not_ready: 'ئامادە نییە',
  change: 'گۆڕین',
  choose: 'هەڵبژاردنی مۆدێل',
  cancel: 'هەڵوەشاندنەوە',
  model_id: 'ناسنامەی مۆدێل',
  list_loading: 'لیستەکە لە دابینکەرەکەوە وەردەگیرێت…',
  rates_short: 'نرخەکان (دۆلار)',
  remove_confirm: 'ئەم مۆدێلە لاببرێت؟',
  remove_consequence: 'ئەرکەکە بە مۆدێلەکەی تر کار دەکات ئەگەر هەبێت، ئەگەرنا بە دۆخی بنەڕەتی.',
  record: 'تۆمارکردن',
  stop: 'ڕاگرتن و تاقیکردنەوە',
  test_valid: 'وەڵامەکە دروست بوو',
  test_invalid: 'وەڵامەکە دروست نەبوو',
  test_expected: 'ئەنجامەکە وەک چاوەڕوانکراو بوو',
  test_unexpected: 'ئەنجامەکە وەک چاوەڕوانکراو نەبوو',
  test_cost: 'تێچوون: {cost} دۆلار',
  test_manual_first: 'سەرەتا ناسنامەکە تاقی بکەرەوە: تەنها دوای تاقیکردنەوەیەکی سەرکەوتوو پاشەکەوت دەکرێت.',
  cap_invalid: 'بڕێک لە 0 تا 50 دۆلار بنووسە، بە زۆرترین دوو ژمارەی دوای خاڵ.',
  share_invalid: 'ڕێژەیەک لە 0 تا 100 بنووسە.',
  rate_invalid: 'نرخێکی دروست بە زۆرترین شەش ژمارەی دوای خاڵ بنووسە؛ نرخە پێویستەکان لە سفر زیاترن.',
  id_invalid: 'ناسنامەکە پیتی ڕێگەپێنەدراوی تێدایە.',
  today: 'ئەمڕۆ (UTC)',
  reserved: 'گیراوە',
  guest_spent: 'خەرجی میوانان',
  calls: 'داواکارییەکان',
  ok_calls: 'سەرکەوتووەکان',
  failed_calls: 'شکستەکان',
  cost: 'تێچوون (دۆلار)',
  day: 'ڕۆژ',
  task: 'ئەرک',
  week: 'دوایین ٧ ڕۆژ',
  no_usage: 'هێشتا هیچ بەکارهێنانێک نییە.',
  last_ok: 'دوایین سەرکەوتن',
  last_fail: 'دوایین شکست',
  never: 'هیچ',
  running: 'کار دەکات',
  refresh: 'نوێکردنەوە',
};

/** Every word of the tab, by language: identical keys by type, three languages (tests/aiStringsClient.test.ts). */
export const ADMIN_AI_STRINGS: Record<'ar' | 'en' | 'ckb', Record<Key, string>> = { ar: AR, en: EN, ckb: CKB };

// ------------------------------------------------------------- the wire

export type AiTask = 'understand' | 'vision' | 'speech';
export const AI_TASKS: readonly AiTask[] = ['understand', 'vision', 'speech'];
export type RateKey = 'in' | 'out' | 'cache_write' | 'cache_read' | 'per_minute';
/** The prices a task is charged in (plan §11 PUT body): tokens for text and images, minutes for speech. */
export const TASK_RATES: Record<AiTask, readonly RateKey[]> = {
  understand: ['in', 'out', 'cache_write', 'cache_read'],
  vision: ['in', 'out', 'cache_write', 'cache_read'],
  speech: ['per_minute'],
};
/** The prices that must be above zero for a row to run (plan §11). */
export const REQUIRED_RATES: Record<AiTask, readonly RateKey[]> = { understand: ['in', 'out'], vision: ['in', 'out'], speech: ['per_minute'] };

const BASE = '/api/admin/assist-ai';
/** The shape every model id must have before it is sent (the server checks it again). */
export const MODEL_ID_SHAPE = /^[A-Za-z0-9@/._:-]{1,128}$/;

interface TaskRow {
  task: AiTask;
  rank: 0 | 1;
  provider: string;
  model_id: string;
  rates: Partial<Record<RateKey, number>>;
  gone: boolean;
  ready: boolean;
  /** The worst case of one call on this row, as the server reserves it (plan §10), in USD. */
  worstCaseUsd: number;
  /** Over a tenth of the cap: the server refuses every call of this row. */
  worstCaseWarn: boolean;
}
interface ProviderHealth {
  last_ok_at: string | null;
  last_fail_at: string | null;
  last_fail_code: string | null;
  circuit_open_until: string | null;
}
export interface Overview {
  migrated: boolean;
  settings: { enabled: boolean; daily_cap_usd: number; guests: boolean; guest_share_pct: number; understand_ckb: boolean };
  tasks: TaskRow[];
  today: { spent: number; reserved: number; guest: number; cap: number; calls: number };
  week: Array<{ day: string; task: string; calls: number; ok: number; cost: number }>;
  health: { anthropic_key: boolean; ai_binding: boolean; images_binding: boolean; providers: Record<string, ProviderHealth> };
  outcomes: Record<string, Record<string, number>>;
}
interface ListedModel {
  id: string;
  label: string;
}
interface TestAnswer {
  ok: boolean;
  code: string;
  ms: number | null;
  costUsd: number | null;
  valid: boolean | null;
  expected: boolean | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
/** D1 answers 0 and 1; JSON answers booleans. Either reads the same here. */
const flag = (v: unknown): boolean => v === true || v === 1;
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const isTask = (v: unknown): v is AiTask => v === 'understand' || v === 'vision' || v === 'speech';

/** The GET answer as this tab may draw it; anything missing reads as empty, never as on. */
export function readOverview(raw: unknown): Overview {
  const d = isRecord(raw) ? raw : {};
  const settings = isRecord(d.settings) ? d.settings : {};
  const today = isRecord(d.today) ? d.today : {};
  const health = isRecord(d.health) ? d.health : {};
  const providers: Record<string, ProviderHealth> = {};
  if (isRecord(health.providers)) {
    for (const [name, p] of Object.entries(health.providers)) {
      if (!isRecord(p)) continue;
      providers[name] = {
        last_ok_at: str(p.last_ok_at),
        last_fail_at: str(p.last_fail_at),
        last_fail_code: str(p.last_fail_code),
        circuit_open_until: str(p.circuit_open_until ?? p.open_until),
      };
    }
  }
  const tasks: TaskRow[] = (Array.isArray(d.tasks) ? d.tasks : []).flatMap((r) => {
    if (!isRecord(r) || !isTask(r.task) || (r.rank !== 0 && r.rank !== 1) || typeof r.model_id !== 'string') return [];
    const rates: Partial<Record<RateKey, number>> = {};
    if (isRecord(r.rates)) for (const k of ['in', 'out', 'cache_write', 'cache_read', 'per_minute'] as const) if (typeof r.rates[k] === 'number') rates[k] = r.rates[k] as number;
    return [
      {
        task: r.task,
        rank: r.rank,
        provider: typeof r.provider === 'string' ? r.provider : '',
        model_id: r.model_id,
        rates,
        gone: flag(r.gone),
        ready: flag(r.ready),
        worstCaseUsd: num(r.worst_case_usd),
        worstCaseWarn: flag(r.worst_case_warn),
      },
    ];
  });
  const outcomes: Record<string, Record<string, number>> = {};
  if (isRecord(d.outcomes_24h)) {
    for (const [task, codes] of Object.entries(d.outcomes_24h)) {
      if (!isRecord(codes)) continue;
      outcomes[task] = Object.fromEntries(Object.entries(codes).filter(([, n]) => typeof n === 'number' && n > 0)) as Record<string, number>;
    }
  }
  const cap = num(settings.daily_cap_usd, num(today.cap, 1));
  return {
    migrated: d.migrated !== false,
    settings: {
      enabled: flag(settings.enabled),
      daily_cap_usd: cap,
      guests: flag(settings.guests),
      guest_share_pct: num(settings.guest_share_pct, 25),
      understand_ckb: flag(settings.understand_ckb),
    },
    tasks,
    today: { spent: num(today.spent), reserved: num(today.reserved), guest: num(today.guest), cap: num(today.cap, cap), calls: num(today.calls) },
    week: (Array.isArray(d.week) ? d.week : []).flatMap((w) =>
      isRecord(w) && typeof w.day === 'string' && typeof w.task === 'string'
        ? [{ day: w.day, task: w.task, calls: num(w.calls), ok: num(w.ok), cost: num(w.cost) }]
        : []
    ),
    health: { anthropic_key: flag(health.anthropic_key), ai_binding: flag(health.ai_binding), images_binding: flag(health.images_binding), providers },
    outcomes,
  };
}

/** The Test answer: codes, milliseconds and a cost; the output of the model never comes back. */
function readTest(raw: unknown): TestAnswer & { token: string | null } {
  const d = isRecord(raw) ? raw : {};
  const micro = typeof d.cost_micro_usd === 'number' && Number.isFinite(d.cost_micro_usd) ? d.cost_micro_usd : null;
  return {
    ok: d.ok === true,
    code: typeof d.code === 'string' ? d.code : d.ok === true ? 'OK' : 'BAD_OUTPUT',
    ms: typeof d.ms === 'number' ? d.ms : null,
    costUsd: micro === null ? null : micro / 1_000_000,
    valid: typeof d.valid === 'boolean' ? d.valid : null,
    expected: typeof d.expected === 'boolean' ? d.expected : null,
    token: typeof d.test_token === 'string' && d.test_token ? d.test_token : null,
  };
}

// ------------------------------------------------------------ the numbers

/**
 * A decimal the owner typed, as plain ASCII text («١٫٥» → «1.5»), or null:
 * Arabic-Indic and Persian digits and the Arabic decimal mark are read as
 * such, at most `maxDp` decimals, no sign, no exponent. The server reads this
 * text itself, so no float ever moves a price.
 */
export function normalizeUsd(text: string, maxDp: number): string | null {
  const ascii = text
    .trim()
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u066B,]/g, '.');
  const decimals = maxDp > 0 ? `(?:\\.\\d{1,${Math.floor(maxDp)}})?` : '';
  return new RegExp(`^\\d{1,9}${decimals}$`).test(ascii) ? ascii : null;
}

/** The same, as a number. */
export function parseUsd(text: string, maxDp: number): number | null {
  const ascii = normalizeUsd(text, maxDp);
  const n = ascii === null ? Number.NaN : Number(ascii);
  return Number.isFinite(n) ? n : null;
}

const usd = (n: number): string => {
  const digits = n !== 0 && Math.abs(n) < 0.01 ? 4 : 2;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits });
};

function when(iso: string | null, lang: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString(lang === 'en' ? 'en-GB' : 'ar-IQ-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/**
 * A refusal in the language of the owner. The server sends the sentence of
 * its own refusal table as the fallback (packages/contracts/src/assistAiRefusals.ts
 * on the server branch); the shared table gives the cost codes (REAUTH_REQUIRED, OWNER_ONLY).
 */
const refusal = (e: unknown, lang: string, fallback: string) => apiRefusal(e, refusalLang(lang), fallback);

const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

// ---------------------------------------------------------------- the tab

type Message = { tone: 'success' | 'danger'; text: string; reauth?: boolean } | null;

const TASK_LABEL: Record<AiTask, Key> = { understand: 'task_understand', vision: 'task_vision', speech: 'task_speech' };
const RATE_LABEL: Record<RateKey, Key> = { in: 'rate_in', out: 'rate_out', cache_write: 'rate_cache_write', cache_read: 'rate_cache_read', per_minute: 'rate_minute' };
/** The tab address the fresh sign-in returns to (src/pages/Admin.tsx DEEP_LINK_TABS). */
const TAB_PATH = '/admin?tab=assist_ai';

export default function AdminAssistAi() {
  const { lang, dir } = useLanguage();
  const words = ADMIN_AI_STRINGS[lang === 'en' || lang === 'ckb' ? lang : 'ar'];
  const s = (k: Key) => words[k];
  const auth = useOptionalAuth();
  const [data, setData] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState<Message>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      setData(readOverview(await api.get<unknown>(BASE, { mascot: 'silent' })));
    } catch (e) {
      // Not deployed yet (404): the layer is simply not there, which is basic mode.
      if (e instanceof ApiError && e.status === 404) setData(readOverview({ migrated: false }));
      else setLoadError(refusal(e, lang, s('load_failed')));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * One write; every write re-reads the tab (the version moved). The answer is
   * a toast of the admin console, seen wherever the owner has scrolled to; a
   * write that needs a fresh sign-in stays on the page with the way through.
   */
  const write = useCallback(
    async (job: () => Promise<unknown>): Promise<boolean> => {
      setMessage(null);
      try {
        await job();
        toast.success(s('saved'));
        await load();
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'REAUTH_REQUIRED') setMessage({ tone: 'danger', text: s('reauth'), reauth: true });
        else toast.error(refusal(e, lang, s('failed')));
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang, load]
  );

  const signInAgain = async () => {
    try {
      await auth?.logout();
    } finally {
      window.location.assign(`/auth?next=${encodeURIComponent(TAB_PATH)}`);
    }
  };

  return (
    <div dir={dir} className="space-y-4" data-admin-assist-ai>
      <header className="flex items-start gap-3">
        <Bot className="mt-1 h-6 w-6 shrink-0 text-gold" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-text-primary">{s('tab')}</h2>
          <p className="text-sm leading-relaxed text-text-muted">{s('subtitle')}</p>
        </div>
        <Button size="sm" variant="ghost" icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />} onClick={() => load()}>
          {s('refresh')}
        </Button>
      </header>

      {message && (
        <div role={message.tone === 'success' ? 'status' : 'alert'} className={`lv-alert lv-alert-${message.tone} text-sm text-text-primary`} data-assist-ai-message={message.tone}>
          <p>{message.text}</p>
          {message.reauth && (
            <Button size="sm" variant="primary" className="mt-2" icon={<LogIn className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />} onClick={signInAgain}>
              {s('sign_in_again')}
            </Button>
          )}
        </div>
      )}

      {!data && !loadError && <p className="py-12 text-center text-sm text-text-muted">{s('loading')}</p>}
      {loadError && (
        <div role="alert" className="lv-alert lv-alert-danger flex flex-wrap items-center justify-between gap-2 text-sm text-text-primary">
          <span>{loadError}</span>
          <Button size="sm" onClick={() => load()}>
            {s('retry')}
          </Button>
        </div>
      )}

      {data && !data.migrated && (
        <p className="lv-alert lv-alert-warning text-sm text-text-primary" data-assist-ai-not-migrated>
          {s('not_migrated')}
        </p>
      )}

      {data && data.migrated && (
        <>
          <MasterCard data={data} s={s} write={write} />
          {AI_TASKS.map((task) => (
            <TaskCard key={task} task={task} data={data} s={s} lang={lang} write={write} />
          ))}
          <HealthCard data={data} s={s} lang={lang} />
          <LedgerCard data={data} s={s} />
        </>
      )}
    </div>
  );
}

type S = (k: Key) => string;
type Write = (job: () => Promise<unknown>) => Promise<boolean>;

// ------------------------------------------------------ 1. switch and cap

function MasterCard({ data, s, write }: { data: Overview; s: S; write: Write }) {
  const saved = data.settings;
  const [cap, setCap] = useState(String(saved.daily_cap_usd));
  const [share, setShare] = useState(String(saved.guest_share_pct));
  const [errors, setErrors] = useState<{ cap?: string; share?: string }>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setCap(String(saved.daily_cap_usd));
    setShare(String(saved.guest_share_pct));
  }, [saved.daily_cap_usd, saved.guest_share_pct]);

  /** The whole settings object, every time: the server bumps the version on each write. */
  const put = async (change: Partial<Overview['settings']>) => {
    setBusy(true);
    try {
      await write(() => api.put(`${BASE}/settings`, { ...saved, ...change }));
    } finally {
      setBusy(false);
    }
  };
  const saveNumbers = async () => {
    const capUsd = parseUsd(cap, 2);
    const sharePct = parseUsd(share, 0);
    const next = {
      cap: capUsd === null || capUsd > 50 ? s('cap_invalid') : undefined,
      share: sharePct === null || sharePct > 100 ? s('share_invalid') : undefined,
    };
    setErrors(next);
    if (next.cap || next.share) return;
    await put({ daily_cap_usd: capUsd!, guest_share_pct: sharePct! });
  };

  const used = data.today.spent + data.today.reserved;
  const capUsd = data.today.cap || saved.daily_cap_usd;
  const pct = capUsd > 0 ? Math.min(100, Math.round((used / capUsd) * 100)) : 100;
  const reached = used >= capUsd;

  return (
    <Card title={s('section_master')} id="assist-ai-master">
      <div className="divide-y divide-border-subtle">
        <div className="pb-3">
          <Switch checked={saved.enabled} busy={busy} onChange={(on) => void put({ enabled: on })} label={s('enabled')} description={saved.enabled ? undefined : s('off_note')} />
        </div>
        <div className="space-y-3 py-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={s('cap')} error={errors.cap}>
              <Input ltr inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
            </Field>
            {saved.guests && (
              <Field label={s('guest_share')} error={errors.share}>
                <Input ltr inputMode="numeric" value={share} onChange={(e) => setShare(e.target.value)} />
              </Field>
            )}
          </div>
          <Button size="sm" variant="primary" onClick={saveNumbers} disabled={busy}>
            {s('save')}
          </Button>
          <div>
            <p className="text-[13px] text-text-secondary" data-assist-ai-spent>
              {fill(s('spent'), { spent: `$${usd(data.today.spent)}`, cap: `$${usd(capUsd)}` })}
            </p>
            <div className="lv-well mt-1.5 h-2 overflow-hidden rounded-full" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={s('cap')}>
              <div className={`h-full rounded-full ${reached ? 'bg-danger' : 'bg-gold'}`} style={{ width: `${pct}%` }} />
            </div>
            {reached && <p className="mt-1.5 text-[12px] text-danger">{s('cap_reached')}</p>}
          </div>
        </div>
        <div className="pt-3">
          <Switch checked={saved.guests} busy={busy} onChange={(on) => void put({ guests: on })} label={s('guests')} />
          <Switch checked={saved.understand_ckb} busy={busy} onChange={(on) => void put({ understand_ckb: on })} label={s('understand_ckb')} />
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------- 2. per task

function TaskCard({ task, data, s, lang, write }: { task: AiTask; data: Overview; s: S; lang: string; write: Write }) {
  const rows = ([0, 1] as const).map((rank) => data.tasks.find((r) => r.task === task && r.rank === rank) ?? null);
  return (
    <Card title={s(TASK_LABEL[task])} description={task === 'vision' ? s('diagnose_note') : task === 'speech' ? s('test_record') : undefined} id={`assist-ai-task-${task}`}>
      <div className="divide-y divide-border-subtle">
        {rows.map((row, rank) => (
          <ModelRow key={rank} task={task} rank={rank as 0 | 1} row={row} s={s} lang={lang} write={write} />
        ))}
      </div>
    </Card>
  );
}

interface Draft {
  modelId: string;
  rates: Record<RateKey, string>;
  manual: boolean;
  token: string | null;
}

/** A speech id typed by hand: the Test sends it with its price, and hands back the token its Save needs. */
interface ManualTest {
  modelId: string;
  perMinute: string;
  onToken: (token: string) => void;
}

function ModelRow({ task, rank, row, s, lang, write }: { task: AiTask; rank: 0 | 1; row: TaskRow | null; s: S; lang: string; write: Write }) {
  const [editing, setEditing] = useState(false);
  /** The live list: undefined while it loads, null when the provider gave none, 'error' when the request failed. */
  const [list, setList] = useState<ListedModel[] | null | undefined | 'error'>(undefined);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<{ id?: string; rates?: string }>({});
  const [confirmRemove, setConfirmRemove] = useState(false);

  const open = async () => {
    const rates = Object.fromEntries(TASK_RATES[task].map((k) => [k, row?.rates[k] ? String(row.rates[k]) : ''])) as Record<RateKey, string>;
    setDraft({ modelId: row?.model_id ?? '', rates, manual: false, token: null });
    setErrors({});
    setEditing(true);
    setList(undefined);
    try {
      const d = await api.get<{ models?: unknown }>(`${BASE}/models?task=${task}`, { mascot: 'silent', timeoutMs: 30000 });
      const models = Array.isArray(d.models)
        ? d.models.flatMap((m) => (isRecord(m) && typeof m.id === 'string' && m.id ? [{ id: m.id, label: typeof m.label === 'string' && m.label ? m.label : m.id }] : []))
        : null;
      setList(models);
      // Speech with no list: the id is typed by hand and saved only after a passing Test.
      if (models === null && task === 'speech') setDraft((p) => (p ? { ...p, manual: true } : p));
    } catch {
      setList('error');
    }
  };
  const close = () => {
    setEditing(false);
    setDraft(null);
  };

  const save = async () => {
    if (!draft) return;
    const id = draft.modelId.trim();
    // Each price as the exact decimal the owner typed (the server reads the text, never a float).
    const rates: Record<RateKey, string> = { in: '0', out: '0', cache_write: '0', cache_read: '0', per_minute: '0' };
    let bad = false;
    for (const k of TASK_RATES[task]) {
      const typed = draft.rates[k].trim();
      const v = typed === '' && !REQUIRED_RATES[task].includes(k) ? '0' : normalizeUsd(typed, 6);
      if (v === null || (REQUIRED_RATES[task].includes(k) && !(Number(v) > 0))) bad = true;
      else rates[k] = v;
    }
    const next = { id: MODEL_ID_SHAPE.test(id) ? undefined : s('id_invalid'), rates: bad ? s('rate_invalid') : undefined };
    setErrors(next);
    if (next.id || next.rates) return;
    if (draft.manual && !draft.token) {
      setErrors({ id: s('test_manual_first') });
      return;
    }
    const body = { model_id: id, rates, ...(draft.manual && draft.token ? { test_token: draft.token } : {}) };
    if (await write(() => api.put(`${BASE}/tasks/${task}/${rank}`, body))) close();
  };

  const listed = list !== undefined && list !== 'error' && list !== null ? list : [];
  const manual: ManualTest | null =
    editing && draft?.manual && MODEL_ID_SHAPE.test(draft.modelId.trim())
      ? { modelId: draft.modelId.trim(), perMinute: draft.rates.per_minute, onToken: (token) => setDraft((p) => (p ? { ...p, token } : p)) }
      : null;
  return (
    <div className="py-3 first:pt-0" data-assist-ai-row={`${task}:${rank}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-text-secondary">{s(rank === 0 ? 'primary' : 'fallback')}</span>
        {row ? (
          <>
            <bdi className="min-w-0 break-all font-mono text-[13px] text-text-primary" dir="ltr">
              {row.model_id}
            </bdi>
            <StatusChip tone={row.gone ? 'danger' : row.ready ? 'success' : 'warning'}>{row.gone ? s('model_gone') : row.ready ? s('ready') : s('not_ready')}</StatusChip>
          </>
        ) : (
          <span className="text-[13px] text-text-muted">{s('no_model')}</span>
        )}
        <span className="flex-1" />
        {!editing && (
          <Button size="sm" variant="secondary" onClick={open}>
            {row ? s('change') : s('choose')}
          </Button>
        )}
        {!editing && row && (
          <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}>
            {s('remove')}
          </Button>
        )}
      </div>
      {row && !editing && (
        <p className="mt-1 text-[12px] text-text-muted" dir="ltr">
          {TASK_RATES[task].map((k) => `${k} $${usd(row.rates[k] ?? 0)}`).join(' · ')}
        </p>
      )}
      {/* The worst case of one call, as the server reserves it (plan §10): over a tenth of the cap, the row never runs. */}
      {row && row.worstCaseWarn && (
        <p className="lv-alert lv-alert-warning mt-2 text-[13px] text-text-primary" data-assist-ai-worst-case>
          {fill(s('worst_case_warn'), { cost: usd(row.worstCaseUsd) })}
        </p>
      )}

      {editing && draft && (
        <div className="mt-3 space-y-3 rounded-lg bg-surface-raised p-3" data-assist-ai-editor>
          {list === undefined && <p className="text-[13px] text-text-muted">{s('list_loading')}</p>}
          {list === 'error' && <p className="text-[13px] text-warning">{s('list_unavailable')}</p>}
          {list === null && task !== 'speech' && <p className="text-[13px] text-warning">{s('list_unavailable')}</p>}
          {draft.manual ? (
            <Field label={s('model_id')} hint={s('list_manual')} error={errors.id}>
              <Input ltr value={draft.modelId} onChange={(e) => setDraft({ ...draft, modelId: e.target.value, token: null })} autoComplete="off" spellCheck={false} />
            </Field>
          ) : (
            listed.length > 0 && (
              <Field label={s('pick_model')} error={errors.id}>
                <Select value={draft.modelId} onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}>
                  <option value="">—</option>
                  {listed.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label === m.id ? m.id : `${m.label} (${m.id})`}
                    </option>
                  ))}
                </Select>
              </Field>
            )
          )}
          {(draft.manual || listed.length > 0) && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                {TASK_RATES[task].map((k) => (
                  <Field key={k} label={s(RATE_LABEL[k])}>
                    <Input
                      ltr
                      inputMode="decimal"
                      value={draft.rates[k]}
                      onChange={(e) => setDraft({ ...draft, rates: { ...draft.rates, [k]: e.target.value }, token: draft.manual ? null : draft.token })}
                    />
                  </Field>
                ))}
              </div>
              <p className="text-[12px] text-text-muted">{s('rates_note')}</p>
              {errors.rates && <p className="lv-field-error">{errors.rates}</p>}
            </>
          )}
          {/* A typed speech id is tested here, before it can be saved (plan §11). */}
          {draft.manual && <TestPanel task={task} rank={rank} s={s} lang={lang} manual={manual} />}
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={close}>
              {s('cancel')}
            </Button>
            <Button size="sm" variant="primary" onClick={save} disabled={!draft.modelId.trim() || (draft.manual && !draft.token)}>
              {s('save')}
            </Button>
          </div>
        </div>
      )}

      {row && !editing && <TestPanel task={task} rank={rank} s={s} lang={lang} manual={null} />}

      <ConfirmDialog
        open={confirmRemove}
        title={s('remove_confirm')}
        consequence={s('remove_consequence')}
        confirmLabel={s('remove')}
        cancelLabel={s('cancel')}
        destructive
        onCancel={() => setConfirmRemove(false)}
        onConfirm={async () => {
          await write(() => api.delete(`${BASE}/tasks/${task}/${rank}`));
          setConfirmRemove(false);
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------ the Test

/**
 * ONE TEST OF ONE ROW (plan §11, POST /test/:task with its `rank`): budgeted
 * and written to the ledger by the server, which answers codes, milliseconds,
 * a cost and two flags, never the output of the model.
 *   understand  the fixed sentence of the server;
 *   vision      `image`, a code drawn on a dark screen-like panel in this
 *               browser, and `code`, the code drawn;
 *   speech      `audio`, up to ten seconds recorded in this tab; with an id
 *               typed by hand, `model_id` and `per_minute` too, and a passing
 *               Test answers the `test_token` the Save of that id needs.
 * Nothing sent for a Test is stored.
 */
function TestPanel({ task, rank, s, lang, manual }: { task: AiTask; rank: 0 | 1; s: S; lang: string; manual: ManualTest | null }) {
  const [result, setResult] = useState<TestAnswer | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const manualRef = useRef(manual);
  manualRef.current = manual;

  const post = async (body: FormData | Record<string, unknown>) => {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const answer = readTest(await api.post<unknown>(`${BASE}/test/${task}`, body, { timeoutMs: 45000 }));
      setResult(answer);
      if (answer.ok && answer.token) manualRef.current?.onToken(answer.token);
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'REAUTH_REQUIRED' ? s('reauth') : refusal(e, lang, s('failed')));
    } finally {
      setBusy(false);
    }
  };

  const testVision = async () => {
    const media = await import('../lib/assistMedia');
    const code = media.testCode();
    const jpeg = await media.drawCodeTestImage(code);
    if (!jpeg) {
      setError(s('failed'));
      return;
    }
    const form = new FormData();
    form.append('image', jpeg, 'test.jpg');
    form.append('code', code);
    form.append('rank', String(rank));
    await post(form);
  };

  const sendRecording = async (file: File | null) => {
    if (!file) return;
    const form = new FormData();
    form.append('audio', file, file.name);
    const m = manualRef.current;
    if (m) {
      form.append('model_id', m.modelId);
      form.append('per_minute', normalizeUsd(m.perMinute, 6) ?? '');
    } else {
      form.append('rank', String(rank));
    }
    await post(form);
  };
  const recorder = useVoiceRecorder({ maxSeconds: 10, onLimit: (file) => void sendRecording(file) });
  const latin = lang === 'en';

  return (
    <div className="mt-2" data-assist-ai-test={`${task}:${rank}`}>
      <div className="flex flex-wrap items-center gap-2">
        {task === 'speech' ? (
          recorder.recording ? (
            <>
              <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-danger" aria-hidden="true" />
              <span className="tabular-nums text-sm text-text-secondary" dir="ltr">
                {formatElapsed(recorder.elapsed, latin)} / {formatElapsed(10, latin)}
              </span>
              <Button size="sm" variant="primary" icon={<Square className="h-3.5 w-3.5" aria-hidden="true" />} onClick={async () => sendRecording(await recorder.stop())}>
                {s('stop')}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              icon={<Mic className="h-4 w-4" aria-hidden="true" />}
              loading={busy}
              onClick={() => recorder.start()}
              disabled={!recorder.supported}
            >
              {s('test')}
            </Button>
          )
        ) : (
          <Button size="sm" variant="secondary" icon={<FlaskConical className="h-4 w-4" aria-hidden="true" />} loading={busy} onClick={() => (task === 'vision' ? testVision() : post({ rank }))}>
            {s('test')}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {error}
        </p>
      )}
      {result && (
        <div role="status" className="mt-2 space-y-1 text-[13px]" data-assist-ai-test-result={result.ok ? 'ok' : 'fail'}>
          <p className={result.ok ? 'font-semibold text-success' : 'font-semibold text-danger'}>
            {result.ok ? fill(s('test_ok'), { ms: result.ms ?? 0 }) : fill(s('test_fail'), { code: result.code })}
          </p>
          {result.valid !== null && <p className="text-text-secondary">{s(result.valid ? 'test_valid' : 'test_invalid')}</p>}
          {result.expected !== null && <p className="text-text-secondary">{s(result.expected ? 'test_expected' : 'test_unexpected')}</p>}
          {result.costUsd !== null && <p className="text-text-muted">{fill(s('test_cost'), { cost: usd(result.costUsd) })}</p>}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- 3. health

const PROVIDER_TITLE: Record<string, string> = { anthropic: 'Anthropic', workers_ai: 'Cloudflare Workers AI' };

function HealthCard({ data, s, lang }: { data: Overview; s: S; lang: string }) {
  const h = data.health;
  const chip = (ok: boolean, yes: Key, no: Key) => <StatusChip tone={ok ? 'success' : 'danger'}>{s(ok ? yes : no)}</StatusChip>;
  const failures = Object.entries(data.outcomes).flatMap(([task, codes]) =>
    Object.entries(codes)
      .filter(([code]) => code !== 'OK')
      .map(([code, n]) => ({ task, code, n }))
  );
  return (
    <Card title={s('section_health')} id="assist-ai-health">
      <div className="flex flex-wrap gap-2">
        {chip(h.anthropic_key, 'key_set', 'key_missing')}
        {chip(h.ai_binding, 'binding_ok', 'binding_missing')}
        {chip(h.images_binding, 'images_ok', 'images_missing')}
      </div>
      <ul className="mt-3 divide-y divide-border-subtle">
        {Object.entries(h.providers).map(([name, p]) => {
          const open = p.circuit_open_until && Date.parse(p.circuit_open_until) > Date.now();
          return (
            <li key={name} className="py-2.5 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-text-primary">{PROVIDER_TITLE[name] ?? name}</span>
                <StatusChip tone={open ? 'warning' : 'success'}>{open ? fill(s('circuit'), { time: when(p.circuit_open_until, lang) }) : s('running')}</StatusChip>
              </div>
              <p className="mt-1 text-text-muted">
                {s('last_ok')}: {when(p.last_ok_at, lang) || s('never')} · {s('last_fail')}: {p.last_fail_at ? `${when(p.last_fail_at, lang)} (${p.last_fail_code ?? '—'})` : s('never')}
              </p>
            </li>
          );
        })}
      </ul>
      <div className="mt-2">
        <h3 className="text-[13px] font-semibold text-text-secondary">{s('failures')}</h3>
        {failures.length === 0 ? (
          <p className="mt-1 text-[13px] text-text-muted">{s('never')}</p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-2">
            {failures.map((f) => (
              <li key={`${f.task}:${f.code}`}>
                <StatusChip tone={failureTone(f.code)}>
                  {isTask(f.task) ? s(TASK_LABEL[f.task]) : f.task}: <bdi className="font-mono">{f.code}</bdi> ×{f.n}
                </StatusChip>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/** A key or a quota is the owner to fix; anything else passes on its own. */
const failureTone = (code: string): Tone => (code === 'KEY_REJECTED' || code === 'QUOTA' || code === 'MODEL_GONE' ? 'danger' : 'warning');

// ------------------------------------------------------------- 4. ledger

function LedgerCard({ data, s }: { data: Overview; s: S }) {
  const t = data.today;
  const tile = (label: Key, value: string) => (
    <div className="lv-well rounded-lg p-3">
      <div className="text-[12px] text-text-muted">{s(label)}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-text-primary" dir="ltr">
        {value}
      </div>
    </div>
  );
  return (
    <Card title={s('section_ledger')} description={s('today')} id="assist-ai-ledger">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tile('cost', `$${usd(t.spent)}`)}
        {tile('reserved', `$${usd(t.reserved)}`)}
        {tile('guest_spent', `$${usd(t.guest)}`)}
        {tile('calls', String(t.calls))}
      </div>
      <h3 className="mt-4 text-[13px] font-semibold text-text-secondary">{s('week')}</h3>
      {data.week.length === 0 ? (
        <p className="mt-1 text-[13px] text-text-muted">{s('no_usage')}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-border-subtle text-text-muted">
                {(['day', 'task', 'calls', 'ok_calls', 'failed_calls', 'cost'] as const).map((k) => (
                  <th key={k} scope="col" className="p-2 text-start font-semibold">
                    {s(k)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.week.map((w) => (
                <tr key={`${w.day}:${w.task}`} className="border-b border-border-subtle last:border-b-0 text-text-secondary">
                  <td className="p-2 tabular-nums" dir="ltr">
                    {w.day}
                  </td>
                  <td className="p-2">{isTask(w.task) ? s(TASK_LABEL[w.task]) : w.task}</td>
                  <td className="p-2 tabular-nums">{w.calls}</td>
                  <td className="p-2 tabular-nums">{w.ok}</td>
                  <td className="p-2 tabular-nums">{Math.max(0, w.calls - w.ok)}</td>
                  <td className="p-2 tabular-nums" dir="ltr">
                    ${usd(w.cost)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
