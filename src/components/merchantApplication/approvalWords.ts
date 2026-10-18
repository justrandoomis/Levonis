/**
 * THE APPROVAL AXIS IN A MERCHANT'S OWN SCREENS — the few sentences the store
 * dashboard (`MerchantDashboardPage`) and the workspace status pill
 * (`shell/status.ts`) need, kept apart from the application form's strings so
 * those screens do not carry the form (Community V3 push 1.2, DECISIONS row
 * 257). Arabic, English and Sorani, in the vocabulary of the
 * merchant-application refusals (src/lib/refusalStrings.ts). Pure, for tests.
 */
import type { ApplicationSummary } from '../../lib/merchant';

export type Loc = (ar: string, en: string, ckb?: string) => string;

/** The application's state in one short phrase. */
export function applicationStateWord(state: ApplicationSummary['state'], loc: Loc): string {
  switch (state) {
    case 'draft':
      return loc('مسودة لم تُرسَل', 'Draft, not sent', 'ڕەشنووس، نەنێردراوە');
    case 'submitted':
      return loc('مُرسَل — بانتظار المراجعة', 'Sent — awaiting review', 'نێردراوە — چاوەڕێی پێداچوونەوە');
    case 'in_review':
      return loc('قيد المراجعة', 'In review', 'لە پێداچوونەوەدایە');
    case 'changes_requested':
      return loc('مطلوب تعديل', 'Changes requested', 'گۆڕانکاری داواکراوە');
    case 'approved':
      return loc('معتمد', 'Approved', 'پەسەندکراوە');
    case 'rejected':
      return loc('مرفوض', 'Rejected', 'ڕەتکراوەتەوە');
    case 'withdrawn':
      return loc('مسحوب', 'Withdrawn', 'کشێنراوەتەوە');
  }
}

/**
 * Why a merchant who is not approved sees «بانتظار الاعتماد», and what to do
 * — with the reviewer's PUBLIC reason when there is one. Never an internal
 * note (the server does not send it).
 */
export function approvalReason(app: ApplicationSummary | null | undefined, loc: Loc): string {
  const reason = app?.reason_public?.trim() ? ` ${app.reason_public.trim()}` : '';
  switch (app?.state) {
    case 'draft':
      return loc(
        'طلب اعتماد التاجر مسودة لم تُرسَل بعد. أكمله وأرسله للمراجعة.',
        'Your merchant application is a draft that has not been sent. Complete it and send it for review.',
        'داواکاریی پەسەندکردنی بازرگانەکەت ڕەشنووسێکە و هێشتا نەنێردراوە. تەواوی بکە و بۆ پێداچوونەوە بینێرە.'
      );
    case 'submitted':
    case 'in_review':
      return loc(
        'طلب اعتماد التاجر قيد المراجعة. سنخبرك بالقرار هنا.',
        'Your merchant application is being reviewed. The decision will show here.',
        'داواکاریی پەسەندکردنی بازرگانەکەت لە پێداچوونەوەدایە. بڕیارەکە لێرە دەردەکەوێت.'
      );
    case 'changes_requested':
      return loc(
        `طلب المراجع تعديلات على طلب اعتمادك.${reason}`,
        `The reviewer asked for changes to your merchant application.${reason}`,
        `پێداچەرەوە داوای گۆڕانکاری لە داواکاریی پەسەندکردنەکەت کردووە.${reason}`
      );
    case 'rejected':
      return loc(
        `رُفض طلب اعتمادك، ويمكنك التقديم من جديد الآن.${reason}`,
        `Your merchant application was rejected; you can apply again now.${reason}`,
        `داواکاریی پەسەندکردنەکەت ڕەتکرایەوە؛ ئێستا دەتوانیت دووبارە پێشکەشی بکەیتەوە.${reason}`
      );
    default:
      return loc(
        'كل تاجر في مجتمع ليفو يحتاج اعتمادًا من مراجع. قدّم طلب اعتماد التاجر.',
        'Every merchant in the Levo community needs a reviewer’s approval. Send your merchant application.',
        'هەموو بازرگانێک لە کۆمەڵگەی لیڤۆدا پێویستی بە پەسەندکردنی پێداچەرەوەیەک هەیە. داواکاریی پەسەندکردنی بازرگان پێشکەش بکە.'
      );
  }
}

/** The one button that moves an unapproved merchant forward, by where their application stands. */
export function applicationCta(app: ApplicationSummary | null | undefined, loc: Loc): string {
  switch (app?.state) {
    case 'draft':
    case 'changes_requested':
      return loc('أكمل طلبك', 'Complete your application', 'داواکارییەکەت تەواو بکە');
    case 'submitted':
    case 'in_review':
      return loc('تابع طلبك', 'Track your application', 'بەدواداچوون بۆ داواکارییەکەت');
    case 'rejected':
    case 'withdrawn':
      return loc('قدّم من جديد', 'Apply again', 'دووبارە پێشکەش بکەرەوە');
    default:
      return loc('قدّم طلب اعتماد التاجر', 'Apply to become a merchant', 'داواکاریی پەسەندکردنی بازرگان پێشکەش بکە');
  }
}
