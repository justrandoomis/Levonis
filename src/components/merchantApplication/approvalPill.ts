/**
 * The workspace status pill's words for the approval axis (Community V3 push
 * 1.2, DECISIONS row 257) — owned here, with the merchant application, and
 * read by src/components/merchant/shell/strings.ts. Written in Arabic, English
 * and Sorani under row 183, in the merchant-application refusals' vocabulary.
 * Tiny on purpose: the workspace frame has a byte budget.
 */
export const APPROVAL_PILL = {
  label: ['بانتظار الاعتماد', 'Awaiting approval', 'چاوەڕێی پەسەندکردن'],
  why: [
    'متجرك يحتاج اعتماد التاجر؛ تابع طلبك.',
    'Your store needs merchant approval; follow your application.',
    'فرۆشگاکەت پێویستی بە پەسەندکردنی بازرگان هەیە؛ بەدواداچوون بۆ داواکارییەکەت بکە.',
  ],
} as const;
