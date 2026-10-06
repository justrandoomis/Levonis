/**
 * THE STARS OF A REVIEW — one control to give them, one figure to show them.
 *
 * The input is a radiogroup of five 44 px radios (28 px stars), so a thumb
 * lands on the star it means and a screen reader hears «4 نجوم, 4 من 5». One
 * radio is in the tab order (the chosen one, else the first); the arrow keys
 * move along the row in the reading direction, Home and End jump to 1 and 5.
 *
 * The display is one image with a sentence for a name, not five decorations.
 * Filled stars are the gold of the house; empty ones the muted text token, so
 * both themes flip with the palette.
 */
import React, { useRef } from 'react';
import { Star } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { reviewStrings } from './reviewStrings';

const STARS = [1, 2, 3, 4, 5] as const;

export function StarRatingInput({
  value,
  onChange,
  label,
  disabled = false,
  describedBy,
}: {
  value: number;
  onChange: (n: number) => void;
  /** The group's accessible name, e.g. «التقييم — Bambu Lab A1». */
  label: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  const { lang, dir } = useLanguage();
  const s = reviewStrings(lang);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusable = value >= 1 && value <= 5 ? value : 1;

  const move = (to: number) => {
    const n = Math.max(1, Math.min(5, to));
    onChange(n);
    refs.current[n - 1]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, n: number) => {
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === forward || e.key === 'ArrowUp') move(n + 1);
    else if (e.key === back || e.key === 'ArrowDown') move(n - 1);
    else if (e.key === 'Home') move(1);
    else if (e.key === 'End') move(5);
    else return;
    e.preventDefault();
  };

  return (
    <div role="radiogroup" aria-label={label} aria-describedby={describedBy} data-star-input className="flex items-center gap-0.5">
      {STARS.map((n) => {
        const on = n <= value;
        return (
          <button
            key={n}
            ref={(el) => {
              refs.current[n - 1] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={s.star(n)}
            tabIndex={n === focusable ? 0 : -1}
            data-star={n}
            disabled={disabled}
            onClick={() => onChange(n)}
            onKeyDown={(e) => onKeyDown(e, n)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
          >
            <Star className={`h-7 w-7 transition-colors ${on ? 'text-gold' : 'text-text-muted'}`} fill={on ? 'currentColor' : 'none'} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

export function StarRatingDisplay({ value, size = 'sm' }: { value: number; size?: 'xs' | 'sm' }) {
  const { lang } = useLanguage();
  const s = reviewStrings(lang);
  const n = Math.max(0, Math.min(5, Math.round(Number(value) || 0)));
  const icon = size === 'xs' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  return (
    <span role="img" aria-label={s.starsOf(n)} data-stars={n} className="inline-flex items-center gap-0.5">
      {STARS.map((i) => (
        <Star key={i} className={`${icon} ${i <= n ? 'text-gold' : 'text-text-muted'}`} fill={i <= n ? 'currentColor' : 'none'} aria-hidden />
      ))}
    </span>
  );
}
