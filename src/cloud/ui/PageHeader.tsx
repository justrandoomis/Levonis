/**
 * The head of a cloud page: an optional way back, the page's one h1, a quiet
 * line under it, and actions at the inline end (a phone stacks them under).
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useCloudText } from '../text';
import { backArrow } from './icons';

export interface PageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** A link back: `{ to, label }` («Printers»). */
  back?: { to: string; label: string };
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, back, actions, className = '' }: PageHeaderProps) {
  const { dir } = useCloudText();
  const Back = backArrow(dir);
  return (
    <header className={`mb-4 ${className}`}>
      {back ? (
        <Link
          to={back.to}
          className="mb-2 inline-flex items-center gap-1.5 rounded-full py-1 text-[13px] font-semibold text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Back aria-hidden="true" className="h-4 w-4" />
          {back.label}
        </Link>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold leading-tight text-text-primary">{title}</h1>
          {subtitle ? <p className="mt-1 text-sm leading-relaxed text-text-muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
