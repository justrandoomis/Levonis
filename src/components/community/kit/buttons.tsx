/**
 * THE COMMUNITY BUTTONS (community UI plan B1; tokens.md §6 rows 1–6).
 *
 * One component, six looks, every state:
 *   gold       the one primary verb of a screen: the sand-gold gradient with
 *              ink text (D-2, owner override), 52px as a bottom CTA
 *   secondary  dark clay on a card («حفظ مسودة», «مراسلة»)
 *   ghost      flat until held
 *   outline    the gold-outline verb («استيراد»)
 *   danger     a destructive verb
 * plus the gold text link («عرض الكل ‹») and the icon button (40 drawn, 44
 * hit, round or square).
 *
 * The states come from `.lv-button` (src/index.css): hover under a pointer,
 * the press dent (`--clay-press`), the focus ring (`--color-focus`), disabled
 * flat, and BUSY: a spinner, `aria-busy`, presses refused, the width held.
 * As ui/Button does, `onClick` may return a promise and the button stays busy
 * until it settles, so a double tap never submits twice.
 */
import React, { useRef, useState } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { IconButton, type IconButtonProps } from '../../ui/Button';
import Spinner from '../../ui/Spinner';

export type KitVariant = 'gold' | 'secondary' | 'ghost' | 'outline' | 'danger';
/** `cta` 52 (a bottom bar), `md` 44, `sm` 44 with less padding, `compact` 36 drawn inside a 44 hit. */
export type KitSize = 'cta' | 'md' | 'sm' | 'compact';

const LOOK: Record<KitVariant, string> = {
  gold: 'cm-btn-gold',
  secondary: 'lv-button-secondary cm-btn-clay',
  ghost: 'lv-button-ghost',
  outline: 'cm-btn-outline',
  danger: 'lv-button-danger',
};

const SIZE: Record<KitSize, string> = {
  cta: 'cm-btn-cta',
  md: '',
  sm: 'lv-button-sm',
  compact: 'lv-button-sm cm-btn-compact lv-hit',
};

/** The class list of a kit button, for a link or a label that must look like one. */
export function kitButtonClass(variant: KitVariant = 'secondary', size: KitSize = 'md', block = false): string {
  return `lv-button ${LOOK[variant]} ${SIZE[size]}${block ? ' w-full' : ''}`;
}

export interface KitButtonProps extends Omit<React.ComponentPropsWithRef<'button'>, 'onClick'> {
  variant?: KitVariant;
  size?: KitSize;
  loading?: boolean;
  /** Replaces the label while busy («جارٍ النشر…»), not a bare spinner. */
  loadingLabel?: React.ReactNode;
  /** At the inline start (the right in Arabic). */
  icon?: React.ReactNode;
  iconEnd?: React.ReactNode;
  block?: boolean;
  /** May return a promise: the button stays busy and refuses presses until it settles. */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => unknown;
}

export function KitButton({
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
}: KitButtonProps) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const busy = loading || pending;
  const handle = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (busy || disabled || inFlight.current) {
      event.preventDefault();
      return;
    }
    const result = onClick?.(event);
    if (!result || typeof (result as PromiseLike<unknown>).then !== 'function') return;
    inFlight.current = true;
    setPending(true);
    const settle = () => {
      inFlight.current = false;
      setPending(false);
    };
    (result as PromiseLike<unknown>).then(settle, settle);
  };
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      data-busy={busy || undefined}
      data-variant={variant}
      onClick={handle}
      className={`${kitButtonClass(variant, size, block)} ${className}`}
    >
      {busy ? <Spinner size="sm" delayMs={0} decorative /> : icon}
      {busy && loadingLabel ? loadingLabel : children}
      {!busy && iconEnd}
    </button>
  );
}

/** The one primary verb of a screen (D-2): gold, 52px at the bottom of a flow. */
export function GoldButton(props: Omit<KitButtonProps, 'variant'>) {
  return <KitButton {...props} variant="gold" />;
}

export interface KitButtonLinkProps extends LinkProps {
  variant?: KitVariant;
  size?: KitSize;
  icon?: React.ReactNode;
  iconEnd?: React.ReactNode;
  block?: boolean;
}

/** A navigation verb drawn as a button: a real link (new tab, copy link, a guest through /auth). */
export function KitButtonLink({ variant = 'secondary', size = 'md', icon, iconEnd, block = false, className = '', children, ...rest }: KitButtonLinkProps) {
  return (
    <Link {...rest} data-variant={variant} className={`${kitButtonClass(variant, size, block)} ${className}`}>
      {icon}
      {children}
      {iconEnd}
    </Link>
  );
}

/** The chevron that points onward in the writing direction (left in Arabic). */
export function OnwardChevron({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  const { dir } = useLanguage();
  const Glyph = dir === 'rtl' ? ChevronLeft : ChevronRight;
  return <Glyph aria-hidden="true" className={className} strokeWidth={2} />;
}

export interface TextLinkProps extends LinkProps {
  /** Hide the onward chevron (a link inside a sentence). */
  plain?: boolean;
}

/** The gold text link: «عرض الطلب ‹», «عرض الكل ‹», «زيارة المتجر ‹». */
export function TextLink({ plain = false, className = '', children, ...rest }: TextLinkProps) {
  return (
    <Link {...rest} className={`inline-flex min-h-11 items-center gap-1 rounded-sm text-[13px] font-semibold text-gold underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${className}`}>
      <span>{children}</span>
      {!plain && <OnwardChevron />}
    </Link>
  );
}

export interface KitIconButtonProps extends Omit<IconButtonProps, 'variant'> {
  /** `round` (share, bell, messages) or `square` (eye, trash, «…»). */
  shape?: 'round' | 'square';
  /** `secondary` a raised disc (default), `ghost` flat until hovered, `danger` the raised disc in the danger ink. */
  tone?: 'secondary' | 'ghost' | 'danger';
}

/** The icon button at the reference size: 40 drawn, 44 hit, round or square. */
export function KitIconButton({ shape = 'round', tone = 'secondary', className = '', ...rest }: KitIconButtonProps) {
  return (
    <IconButton
      {...rest}
      variant={tone === 'ghost' ? 'ghost' : 'secondary'}
      className={`cm-icon ${shape === 'square' ? 'cm-icon-sq' : ''} ${tone === 'danger' ? 'cm-icon-danger' : ''} ${className}`}
    />
  );
}
