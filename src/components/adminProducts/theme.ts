/**
 * Class recipes for the admin products screen, built on the .ap tokens in
 * theme.css. Everything is a plain string so the JSX stays readable and the
 * system can be tuned in one place. Text buttons are 36px (h-9), icon
 * buttons 32px (h-8); form controls keep the 40px floor the §12 suites
 * assert for every select on the page.
 */

const focus =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ap-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ap-bg-0)]';
const btnBase =
  `inline-flex items-center justify-center gap-1.5 whitespace-nowrap select-none rounded-[var(--ap-radius-md)] text-[13px] font-semibold leading-none transition-colors duration-150 disabled:opacity-45 disabled:cursor-not-allowed ${focus}`;

export const AP = 'ap min-w-0 text-[var(--ap-text-1)]';

export const surface = 'rounded-[var(--ap-radius-lg)] border border-[var(--ap-border)] bg-[var(--ap-surface-1)]';
export const surfaceRaised = `${surface} shadow-[var(--ap-shadow-1)]`;

export const text1 = 'text-[var(--ap-text-1)]';
export const text2 = 'text-[var(--ap-text-2)]';
export const text3 = 'text-[var(--ap-text-3)]';

export const btnPrimary =
  `${btnBase} h-9 px-3.5 text-white bg-[var(--ap-accent)] hover:bg-[var(--ap-accent-hover)] active:bg-[var(--ap-accent-active)] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_1px_2px_rgba(0,0,0,0.4)]`;
export const btnSecondary =
  `${btnBase} h-9 px-3 text-[var(--ap-text-1)] bg-[var(--ap-surface-2)] border border-[var(--ap-border-strong)] hover:bg-[var(--ap-surface-3)] active:bg-[var(--ap-surface-4)]`;
export const btnGhost =
  `${btnBase} h-9 px-3 text-[var(--ap-text-2)] hover:text-[var(--ap-text-1)] hover:bg-[var(--ap-surface-2)] active:bg-[var(--ap-surface-3)]`;
export const btnDanger =
  `${btnBase} h-9 px-3 text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border border-[var(--ap-danger-border)] hover:bg-[rgba(239,83,83,0.2)]`;
export const btnIcon =
  `${btnBase} h-8 w-8 shrink-0 rounded-[var(--ap-radius-sm)] text-[var(--ap-text-2)] bg-[var(--ap-surface-2)] border border-[var(--ap-border)] hover:text-[var(--ap-text-1)] hover:bg-[var(--ap-surface-3)] hover:border-[var(--ap-border-strong)] active:bg-[var(--ap-surface-4)]`;
export const btnIconDanger =
  `${btnBase} h-8 w-8 shrink-0 rounded-[var(--ap-radius-sm)] text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border border-[var(--ap-danger-border)] hover:bg-[rgba(239,83,83,0.2)]`;
export const btnIconActive =
  `${btnBase} h-8 w-8 shrink-0 rounded-[var(--ap-radius-sm)] text-[var(--ap-accent-text)] bg-[var(--ap-accent-soft)] border border-[var(--ap-accent-border)]`;

export const chip =
  `${btnBase} h-8 px-3 rounded-full text-[12px] text-[var(--ap-text-2)] border border-[var(--ap-border)] hover:text-[var(--ap-text-1)] hover:border-[var(--ap-border-strong)]`;
export const chipActive =
  `${btnBase} h-8 px-3 rounded-full text-[12px] text-[var(--ap-accent-text)] bg-[var(--ap-accent-soft)] border border-[var(--ap-accent-border)]`;

const control =
  'h-10 min-w-0 rounded-[var(--ap-radius-md)] bg-[var(--ap-surface-2)] border border-[var(--ap-border)] text-[13px] text-[var(--ap-text-1)] placeholder:text-[var(--ap-text-3)] transition-colors duration-150 hover:border-[var(--ap-border-strong)] focus:outline-none focus:border-[var(--ap-accent-border)] focus:ring-2 focus:ring-[var(--ap-ring)]';
export const input = `${control} px-3`;
export const select = `${control} ap-select`;

export const kbd =
  'inline-flex items-center h-5 px-1.5 rounded-md border border-[var(--ap-border-strong)] bg-[var(--ap-surface-3)] text-[10px] font-medium text-[var(--ap-text-3)] leading-none';

export const badge: Record<'active' | 'draft' | 'hidden' | 'out' | 'low', string> = {
  active: 'text-[var(--ap-success)] bg-[var(--ap-success-bg)] border-[var(--ap-success-border)]',
  draft: 'text-[var(--ap-warning)] bg-[var(--ap-warning-bg)] border-[var(--ap-warning-border)]',
  hidden: 'text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border-[var(--ap-danger-border)]',
  out: 'text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border-[var(--ap-danger-border)]',
  low: 'text-[var(--ap-warning)] bg-[var(--ap-warning-bg)] border-[var(--ap-warning-border)]',
};
export const badgeBase =
  'inline-flex items-center gap-1.5 h-6 px-2 rounded-full border text-[11.5px] font-semibold leading-none whitespace-nowrap';

export const statCard = {
  base: `${surface} p-3.5 min-w-0 relative overflow-hidden`,
  tints: {
    purple: { box: 'bg-[var(--ap-accent-soft)] text-[var(--ap-accent-text)]', spark: 'text-[var(--ap-accent-text)]' },
    blue: { box: 'bg-[var(--ap-info-bg)] text-[var(--ap-info)]', spark: 'text-[var(--ap-info)]' },
    green: { box: 'bg-[var(--ap-success-bg)] text-[var(--ap-success)]', spark: 'text-[var(--ap-success)]' },
    amber: { box: 'bg-[var(--ap-warning-bg)] text-[var(--ap-warning)]', spark: 'text-[var(--ap-warning)]' },
    red: { box: 'bg-[var(--ap-danger-bg)] text-[var(--ap-danger)]', spark: 'text-[var(--ap-danger)]' },
  } as Record<'purple' | 'blue' | 'green' | 'amber' | 'red', { box: string; spark: string }>,
};

export const tableHead =
  'text-[11.5px] font-semibold text-[var(--ap-text-3)] uppercase tracking-[0.02em] border-b border-[var(--ap-border)] bg-[var(--ap-surface-1)]';
export const tableRow = 'transition-colors duration-150 hover:bg-[var(--ap-surface-2)]';

export const menuBox =
  'w-56 rounded-[var(--ap-radius-md)] bg-[var(--ap-surface-3)] shadow-[var(--ap-shadow-menu)] overflow-hidden py-1';
export const menu = `fixed z-[140] ${menuBox}`;
export const menuAnchored = `absolute z-[140] top-full mt-1.5 start-0 ${menuBox}`;
export const menuItem =
  `w-full text-start px-3 h-9 text-[12.5px] text-[var(--ap-text-1)] flex items-center gap-2.5 hover:bg-[var(--ap-surface-4)] active:bg-[var(--ap-surface-4)] disabled:opacity-40 ${focus} focus-visible:ring-offset-0 focus-visible:ring-inset`;
export const menuItemDanger = `${menuItem} text-[var(--ap-danger)]`;

export const segmented = {
  base: 'inline-flex items-center h-9 p-[3px] rounded-[var(--ap-radius-md)] bg-[var(--ap-surface-2)] border border-[var(--ap-border)]',
  active: `inline-flex items-center justify-center h-full w-8 rounded-[7px] text-[var(--ap-text-1)] bg-[var(--ap-surface-4)] shadow-[0_1px_2px_rgba(0,0,0,0.4)] ${focus} focus-visible:ring-offset-0`,
  inactive: `inline-flex items-center justify-center h-full w-8 rounded-[7px] text-[var(--ap-text-3)] hover:text-[var(--ap-text-2)] ${focus} focus-visible:ring-offset-0`,
};

export const pageBtn = {
  base: `${btnBase} min-w-8 h-8 px-2 text-[12px] rounded-[var(--ap-radius-sm)] text-[var(--ap-text-2)] border border-[var(--ap-border)] hover:border-[var(--ap-border-strong)] hover:text-[var(--ap-text-1)] disabled:opacity-30`,
  active: `${btnBase} min-w-8 h-8 px-2 text-[12px] rounded-[var(--ap-radius-sm)] text-[var(--ap-accent-text)] bg-[var(--ap-accent-soft)] border border-[var(--ap-accent-border)]`,
};

export const thumb =
  'rounded-[var(--ap-radius-sm)] bg-[var(--ap-surface-3)] border border-[var(--ap-border)] overflow-hidden shrink-0';
