/**
 * Class recipes for the admin products screen, built on the .ap tokens in
 * theme.css (the single source of truth — no colour literal lives here).
 *
 * Rules the recipes follow:
 *  - hover/active are guarded with `enabled:` so a disabled control never
 *    lights up; Tailwind v4 media-gates hover, so `active` IS the touch
 *    feedback on an iPad;
 *  - focus is a solid 2px outline with a transparent offset gap, never a
 *    ring-offset that paints a halo of the wrong ground over a card;
 *  - state comes from aria attributes (aria-expanded, aria-pressed,
 *    aria-current) instead of `!` overrides, so the markup and the styling
 *    agree by construction;
 *  - a recipe never carries two utilities for the same property. Tailwind
 *    emits utilities in a fixed order regardless of class order, so an
 *    "override" appended to a base that already sets that property is dead
 *    (`text-[12px]` after `text-[13px]` renders 13px). Bases therefore set no
 *    size/weight; each recipe states its own once;
 *  - text buttons are 36px (h-9), icon buttons 32px (h-8); form controls keep
 *    the 40px floor the §12 suites assert for every select on the page.
 */

const focus =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ap-ring)]';
/** For controls that sit inside a track or a menu, where an outset ring would spill. */
const focusInset =
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ap-ring)]';
const btnBase =
  `inline-flex items-center justify-center gap-1.5 whitespace-nowrap select-none rounded-[var(--ap-radius-md)] leading-none transition-colors duration-150 disabled:opacity-45 disabled:cursor-not-allowed ${focus}`;
const btnText = 'text-[13px] font-semibold';

export const AP = 'ap min-w-0 text-[var(--ap-text-1)]';

export const surface = 'rounded-[var(--ap-radius-lg)] border border-[var(--ap-border)] bg-[var(--ap-surface-1)]';
export const surfaceRaised = `${surface} shadow-[var(--ap-shadow-1)]`;

export const text1 = 'text-[var(--ap-text-1)]';
export const text2 = 'text-[var(--ap-text-2)]';
export const text3 = 'text-[var(--ap-text-3)]';

export const btnPrimary =
  `${btnBase} ${btnText} h-9 px-3.5 text-white bg-[var(--ap-accent)] enabled:hover:bg-[var(--ap-accent-hover)] enabled:active:bg-[var(--ap-accent-active)] shadow-[inset_0_1px_0_rgb(255_255_255_/_0.14),0_1px_2px_rgb(0_0_0_/_0.35)]`;
export const btnSecondary =
  `${btnBase} ${btnText} h-9 px-3 text-[var(--ap-text-1)] bg-[var(--ap-surface-2)] border border-[var(--ap-border-strong)] enabled:hover:bg-[var(--ap-surface-3)] enabled:hover:border-[var(--ap-border-hover)] enabled:active:bg-[var(--ap-surface-4)]`;
const ghostColours =
  'text-[var(--ap-text-2)] enabled:hover:text-[var(--ap-text-1)] enabled:hover:bg-[var(--ap-surface-2)] enabled:active:bg-[var(--ap-surface-3)]';
export const btnGhost = `${btnBase} text-[13px] font-medium h-9 px-3 ${ghostColours}`;
/** The 32px ghost for secondary rows (advanced-filter reset). */
export const btnGhostSm = `${btnBase} text-[12px] font-medium h-8 px-2.5 ${ghostColours}`;
export const btnDanger =
  `${btnBase} ${btnText} h-9 px-3 text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border border-[var(--ap-danger-border)] enabled:hover:bg-[var(--ap-danger-bg-hover)]`;

const iconBase = `${btnBase} shrink-0 rounded-[var(--ap-radius-sm)]`;
/** 32px icon button; lit while its menu is open (aria-expanded="true"). */
export const btnIcon =
  `${iconBase} h-8 w-8 text-[var(--ap-text-2)] bg-[var(--ap-surface-2)] border border-[var(--ap-border)] enabled:hover:text-[var(--ap-text-1)] enabled:hover:bg-[var(--ap-surface-3)] enabled:hover:border-[var(--ap-border-hover)] enabled:active:bg-[var(--ap-surface-4)] aria-expanded:text-[var(--ap-accent-text)] aria-expanded:bg-[var(--ap-accent-soft)] aria-expanded:border-[var(--ap-accent-border)]`;
/** Same, at the 36px text-button height for the header row. */
export const btnIconLg = btnIcon.replace('h-8 w-8', 'h-9 w-9');
export const btnIconDanger =
  `${iconBase} h-8 w-8 text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border border-[var(--ap-danger-border)] enabled:hover:bg-[var(--ap-danger-bg-hover)]`;
/** 32px borderless icon button for dismiss controls that sit on a tinted bed. */
export const btnIconGhost =
  `${iconBase} h-8 w-8 text-[var(--ap-text-2)] enabled:hover:text-[var(--ap-text-1)] enabled:hover:bg-[rgb(255_255_255_/_0.07)] enabled:active:bg-[rgb(255_255_255_/_0.11)]`;

/** Toggle chip (aria-pressed drives the lit state). */
export const chip =
  `${btnBase} text-[12px] font-medium h-8 px-3 rounded-full text-[var(--ap-text-2)] border border-[var(--ap-border)] enabled:hover:text-[var(--ap-text-1)] enabled:hover:border-[var(--ap-border-hover)] aria-pressed:text-[var(--ap-accent-text)] aria-pressed:bg-[var(--ap-accent-soft)] aria-pressed:border-[var(--ap-accent-border)]`;
/** The filter-row toggle at the 40px control height (aria-pressed lit). */
export const btnFilter =
  `${btnBase} ${btnText} h-10 px-3 text-[var(--ap-text-2)] border border-[var(--ap-border)] bg-[var(--ap-surface-2)] enabled:hover:text-[var(--ap-text-1)] enabled:hover:border-[var(--ap-border-hover)] enabled:active:bg-[var(--ap-surface-3)] aria-pressed:text-[var(--ap-accent-text)] aria-pressed:bg-[var(--ap-accent-soft)] aria-pressed:border-[var(--ap-accent-border)]`;

const control =
  'h-10 min-w-0 rounded-[var(--ap-radius-md)] bg-[var(--ap-surface-2)] border border-[var(--ap-border)] text-[var(--ap-text-1)] placeholder:text-[var(--ap-text-3)] transition-colors duration-150 hover:border-[var(--ap-border-hover)] focus:outline-none focus:border-[var(--ap-accent)] focus:shadow-[0_0_0_3px_var(--ap-accent-soft)]';
export const input = `${control} text-[13px] px-3`;
export const select = `${control} text-[13px] ap-select`;
export const selectSm = `${control} text-[12px] ap-select`;

const kbdBase =
  'inline-flex items-center px-1.5 rounded-md border border-[var(--ap-border-strong)] bg-[var(--ap-surface-3)] font-medium text-[var(--ap-text-3)] leading-none';
export const kbd = `${kbdBase} h-5 text-[10px]`;
export const kbdTiny = `${kbdBase} h-4 text-[9px]`;

export const badge: Record<'active' | 'draft' | 'hidden', string> = {
  active: 'text-[var(--ap-success)] bg-[var(--ap-success-bg)] border-[var(--ap-success-border)]',
  draft: 'text-[var(--ap-warning)] bg-[var(--ap-warning-bg)] border-[var(--ap-warning-border)]',
  hidden: 'text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border-[var(--ap-danger-border)]',
};
export const badgeBase =
  'inline-flex items-center gap-1.5 h-6 px-2 rounded-full border text-[11.5px] font-semibold leading-none whitespace-nowrap';
/** Opaque dark bed under a badge that floats over a product photo, so the
    14% tint keeps its contrast on a white image too. */
export const badgeBed = 'inline-flex rounded-full bg-[var(--ap-bg-0)]';

export const statCard = {
  base: `${surface} p-4 min-w-0 relative overflow-hidden flex flex-col`,
  tints: {
    purple: { box: 'bg-[var(--ap-accent-soft)] text-[var(--ap-accent-text)]', spark: 'text-[var(--ap-accent-text)]' },
    blue: { box: 'bg-[var(--ap-info-bg)] text-[var(--ap-info)]', spark: 'text-[var(--ap-info)]' },
    green: { box: 'bg-[var(--ap-success-bg)] text-[var(--ap-success)]', spark: 'text-[var(--ap-success)]' },
    amber: { box: 'bg-[var(--ap-warning-bg)] text-[var(--ap-warning)]', spark: 'text-[var(--ap-warning)]' },
    red: { box: 'bg-[var(--ap-danger-bg)] text-[var(--ap-danger)]', spark: 'text-[var(--ap-danger)]' },
  } as Record<'purple' | 'blue' | 'green' | 'amber' | 'red', { box: string; spark: string }>,
};

export const tableHead =
  'text-[11.5px] font-semibold text-[var(--ap-text-3)] border-b border-[var(--ap-border)] bg-[rgb(255_255_255_/_0.02)]';
export const tableRow = 'transition-colors duration-150 hover:bg-[rgb(255_255_255_/_0.025)]';

/**
 * PIN THE LAST COLUMN OF A WIDE TABLE.
 *
 * Every admin list sets a min-width wider than a tablet held upright, so its
 * wrapper scrolls sideways — and because the admin is RTL, the LAST column is
 * on the LEFT. It is therefore the row actions that leave the screen, not the
 * slug or the SKU.
 *
 * Measured on the built app at 1024x1366: on the products tab the scroller is
 * 766px over 938px and «تعديل» sat at x=-97, «حذف / أرشفة» at x=-59, «المزيد»
 * at x=-135 — 90 controls entirely outside the viewport. On the users tab, 100.
 * The owner reported this as not being able to edit or delete; the buttons were
 * there and simply could not be reached.
 *
 * Sticky keeps them against the inline-end edge at any scroll offset, in both
 * writing directions, and hides nothing — the other columns scroll underneath.
 * The opaque background is what makes "underneath" true.
 *
 * Apply to the <table>, not the wrapper: sticky positions against the nearest
 * scrolling ancestor, and the cells must be the sticky elements.
 */
export const stickyActionsColumn = [
  '[&_tr>*:last-child]:sticky',
  '[&_tr>*:last-child]:end-0',
  '[&_tr>*:last-child]:z-[1]',
  '[&_tbody_tr>*:last-child]:bg-[var(--ap-surface-1)]',
  '[&_thead_tr>*:last-child]:bg-[var(--ap-surface-2)]',
].join(' ');

export const menuBox =
  'w-56 rounded-[var(--ap-radius-md)] bg-[var(--ap-surface-3)] shadow-[var(--ap-shadow-menu)] overflow-hidden py-1';
export const menu = `fixed z-[140] ${menuBox}`;
/** Anchored under a trigger that sits at the inline-END of its row, so the
    panel grows back over the page instead of off the clipped content column. */
export const menuAnchored = `absolute z-[140] top-full mt-1.5 end-0 ${menuBox}`;
const menuItemBase =
  `w-full text-start px-3 h-9 text-[12.5px] flex items-center gap-2.5 disabled:opacity-40 ${focusInset}`;
export const menuItem =
  `${menuItemBase} text-[var(--ap-text-1)] enabled:hover:bg-[var(--ap-surface-4)] enabled:active:bg-[var(--ap-surface-4)] focus-visible:bg-[var(--ap-surface-4)]`;
export const menuItemDanger =
  `${menuItemBase} text-[var(--ap-danger)] enabled:hover:bg-[var(--ap-danger-bg)] enabled:active:bg-[var(--ap-danger-bg-hover)] focus-visible:bg-[var(--ap-danger-bg)]`;

/** 36px track holding 32px segments, so it lines up with the selects' row. */
export const segmented = {
  base: 'inline-flex items-center h-9 p-0.5 rounded-[var(--ap-radius-md)] bg-[var(--ap-surface-2)] border border-[var(--ap-border)]',
  item: `inline-flex items-center justify-center h-8 w-8 rounded-[7px] text-[var(--ap-text-3)] transition-colors duration-150 enabled:hover:text-[var(--ap-text-2)] aria-pressed:text-[var(--ap-text-1)] aria-pressed:bg-[var(--ap-surface-4)] aria-pressed:shadow-[0_1px_2px_rgb(0_0_0_/_0.35)] ${focusInset}`,
};

/** Page number (aria-current="page" lights the current one). */
export const pageBtn =
  `${btnBase} text-[12px] font-semibold min-w-8 h-8 px-2 rounded-[var(--ap-radius-sm)] text-[var(--ap-text-2)] border border-[var(--ap-border)] enabled:hover:border-[var(--ap-border-hover)] enabled:hover:text-[var(--ap-text-1)] disabled:opacity-30 aria-[current=page]:text-[var(--ap-accent-text)] aria-[current=page]:bg-[var(--ap-accent-soft)] aria-[current=page]:border-[var(--ap-accent-border)]`;

export const thumb =
  'rounded-[var(--ap-radius-sm)] bg-[var(--ap-surface-3)] border border-[var(--ap-border)] overflow-hidden shrink-0';
