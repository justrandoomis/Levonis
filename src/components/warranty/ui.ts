/**
 * Shared class strings for the warranty surface, so every button in the
 * section presses, focuses and disables the same way.
 *
 * CLAY (build plan §6 Phase 3): the buttons are the house `lv-button`
 * variants (raised clay that dents while held, its own focus ring and busy
 * and disabled states), a field is the `lv-input` well, a card is
 * `lv-surface` and the notes are flat `lv-alert`s — information is never
 * raised.
 */

export const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold';

/** The house secondary action: quiet raised clay, full height, icon + label. */
export const BTN_SECONDARY = 'lv-button lv-button-secondary text-[13px]';

/** The one primary action per card/panel. */
export const BTN_PRIMARY = 'lv-button lv-button-primary text-[13px]';

/** Destructive confirmation only — never on a card face. */
export const BTN_DANGER = 'lv-button lv-button-danger text-[13px]';

/** Inline text action / navigation link inside a card. */
export const LINK_QUIET = `inline-flex items-center gap-1 min-h-[32px] text-[12px] font-medium text-text-secondary hover:text-text-primary underline-offset-2 hover:underline rounded transition-colors ${FOCUS}`;

export const INPUT = 'lv-input min-w-0 py-2.5 text-sm';

export const CARD = 'lv-surface';

export const ERROR_BOX = 'lv-alert lv-alert-danger text-[13px] font-medium text-text-primary';
export const OK_BOX = 'lv-alert lv-alert-success text-[13px] font-medium text-text-primary';
