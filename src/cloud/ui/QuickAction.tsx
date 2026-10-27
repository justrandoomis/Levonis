/**
 * QUICK ACTIONS — the doors under the balances: «Buy hours», «Buy filament»,
 * «View printers», and the one primary call to action, «Start a new print».
 *
 * A QuickAction is a small square of pressable clay (resting card, a step
 * higher under a pointer, dented while held — the KpiTile recipe) with its
 * icon over its label. The PrimaryAction is the house primary button (ink on
 * the cream theme, cream on the dark one) made a link: one per screen.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useCloudText } from '../text';
import { forwardArrow } from './icons';

export interface QuickActionProps {
  to: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  className?: string;
}

export function QuickAction({ to, icon, label, className = '' }: QuickActionProps) {
  return (
    <Link
      to={to}
      className={`lv-surface flex min-w-0 flex-col items-center justify-center gap-1.5 px-2 py-3 text-center no-press transition-colors hover:bg-surface-raised hover:shadow-lg active:shadow-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${className}`}
    >
      <span aria-hidden="true" className="text-text-primary">
        {icon}
      </span>
      <span className="text-[12px] font-semibold leading-tight text-text-primary">{label}</span>
    </Link>
  );
}

export interface PrimaryActionProps {
  to: string;
  icon?: React.ReactNode;
  label: React.ReactNode;
  /** A quiet second line under the label. */
  hint?: React.ReactNode;
  className?: string;
}

export function PrimaryAction({ to, icon, label, hint, className = '' }: PrimaryActionProps) {
  const { dir } = useCloudText();
  const Forward = forwardArrow(dir);
  return (
    <Link to={to} className={`lv-button lv-button-primary w-full justify-between gap-3 py-3 ${className}`}>
      <span className="flex min-w-0 items-center gap-3">
        {icon ? <span aria-hidden="true" className="shrink-0">{icon}</span> : null}
        <span className="min-w-0 text-start">
          <span className="block truncate">{label}</span>
          {hint ? <span className="block truncate text-[12px] font-medium opacity-70">{hint}</span> : null}
        </span>
      </span>
      <Forward aria-hidden="true" className="h-4 w-4 shrink-0" />
    </Link>
  );
}
