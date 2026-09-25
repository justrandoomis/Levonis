/**
 * BUTTON and ICONBUTTON — the `lv-button` classes, as components.
 *
 * The classes have existed for a long time (`src/index.css`: 44px minimum,
 * focus ring, disabled state, five variants) but only as classes, so every
 * screen re-assembled a button from them and re-solved the same two problems
 * by hand, usually not at all:
 *
 *   A DOUBLE SUBMIT. A «حفظ» pressed twice before the first request answers
 *   saves twice. A `loading` prop only helps after the parent has re-rendered,
 *   and a fast double tap lands before that. So `onClick` may RETURN A
 *   PROMISE: the button refuses every further click (synchronously, through a
 *   ref, not through state) until that promise settles, and shows it is busy
 *   while it waits. A controlled `loading` prop does the same for a caller that
 *   owns the request itself.
 *
 *   BUSY IS NOT DISABLED. A `disabled` button drops keyboard focus on the
 *   floor the moment it is pressed, and a screen reader hears nothing. A busy
 *   button keeps focus, says `aria-busy`, and ignores presses
 *   (`aria-disabled`). Its label stays where it was, so nothing jumps.
 *
 * ICONBUTTON DRAWS SMALL AND HITS 44px (docs/MOTION.md §1): the button is a
 * 44px transparent target and the visible pill inside it is 36px. Its
 * accessible name is required — an icon alone names nothing — and the same
 * text is the tooltip a mouse user gets.
 */
import React, { useRef, useState } from 'react';
import Spinner from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';

type NativeButton = Omit<React.ComponentPropsWithRef<'button'>, 'onClick'>;

export interface ButtonProps extends NativeButton {
  variant?: ButtonVariant;
  /** `sm` lowers padding and type only; the 44px target never shrinks. */
  size?: 'md' | 'sm';
  /** Busy: a spinner, `aria-busy`, and every press refused. */
  loading?: boolean;
  /** Replaces the label while busy — «جارٍ الحفظ…», not a bare spinner. */
  loadingLabel?: React.ReactNode;
  /** An icon before the label (the inline start: right in Arabic). */
  icon?: React.ReactNode;
  /** An icon after the label. */
  iconEnd?: React.ReactNode;
  /** Full width of its container. */
  block?: boolean;
  /** May return a promise; the button stays busy and refuses presses until it settles. */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => unknown;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * The shared press guard. Returns the handler to put on the element and
 * whether a returned promise is still pending.
 */
function usePressGuard(
  onClick: ButtonProps['onClick'],
  blocked: boolean
): [(event: React.MouseEvent<HTMLButtonElement>) => void, boolean] {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const handle = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (blocked || inFlight.current) {
      // A submit button inside a form must not submit it either.
      event.preventDefault();
      return;
    }
    const result = onClick?.(event);
    if (!isThenable(result)) return;
    inFlight.current = true;
    setPending(true);
    const settle = () => {
      inFlight.current = false;
      setPending(false);
    };
    result.then(settle, settle);
  };
  return [handle, pending];
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  loadingLabel,
  icon,
  iconEnd,
  block = false,
  className = '',
  type = 'button',
  disabled,
  children,
  onClick,
  ...rest
}: ButtonProps) {
  const [handle, pending] = usePressGuard(onClick, loading || !!disabled);
  const busy = loading || pending;
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      data-busy={busy || undefined}
      onClick={handle}
      className={`lv-button lv-button-${variant} ${size === 'sm' ? 'lv-button-sm' : ''} ${block ? 'w-full' : ''} ${className}`}
    >
      {busy ? <Spinner size="sm" delayMs={0} decorative /> : icon}
      {busy && loadingLabel ? loadingLabel : children}
      {!busy && iconEnd}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'iconEnd' | 'block' | 'loadingLabel' | 'size'> {
  /** The accessible name — required; also the pointer tooltip. */
  label: string;
  icon: React.ReactNode;
  /** `ghost` (default): no fill until hovered. `secondary`: a quiet raised disc. */
  variant?: 'ghost' | 'secondary' | 'danger';
  /**
   * A count pinned to the corner (`3`, shown «99+» past 99), or `'dot'`.
   * Decorative — the number must also be in `label` («الإشعارات: 3 غير مقروءة»).
   * Drawn SOLID (accent fill, dark figure): a tint would let the icon show
   * through the number.
   */
  badge?: number | 'dot' | null;
}

const ICON_TONE: Record<NonNullable<IconButtonProps['variant']>, string> = {
  ghost: 'text-text-secondary hover:text-text-primary',
  secondary: 'text-text-primary',
  danger: 'text-danger',
};

const ICON_DISC: Record<NonNullable<IconButtonProps['variant']>, string> = {
  ghost: 'group-hover:bg-white/[0.06]',
  secondary: 'bg-surface-raised border border-border-subtle',
  danger: 'group-hover:bg-danger/10',
};

export function IconButton({
  label,
  icon,
  variant = 'ghost',
  loading = false,
  badge,
  className = '',
  type = 'button',
  disabled,
  onClick,
  title,
  ...rest
}: IconButtonProps) {
  const [handle, pending] = usePressGuard(onClick, loading || !!disabled);
  const busy = loading || pending;
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled}
      aria-label={label}
      title={title ?? label}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      data-icon-button
      onClick={handle}
      className={`group relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full press-scale focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40 ${ICON_TONE[variant]} ${className}`}
    >
      <span
        aria-hidden="true"
        data-icon-disc
        className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${ICON_DISC[variant]}`}
      >
        {busy ? <Spinner size="sm" delayMs={0} decorative /> : icon}
      </span>
      {badge === 'dot' ? (
        <span aria-hidden="true" data-icon-badge className="pointer-events-none absolute top-2 end-2 h-2 w-2 rounded-full bg-gold ring-2 ring-canvas" />
      ) : typeof badge === 'number' && badge > 0 ? (
        <span
          aria-hidden="true"
          data-icon-badge
          dir="ltr"
          className="pointer-events-none absolute top-0.5 end-0.5 min-w-[18px] rounded-full bg-gold px-1 text-center text-[10px] font-bold leading-[18px] text-accent-contrast tabular-nums ring-2 ring-canvas"
        >
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </button>
  );
}
