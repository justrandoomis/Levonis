/**
 * The title row of a section inside a page: «Upcoming prints  2   View all ›».
 * A real heading (h2 by default), an optional count badge, and an optional
 * link or control at the inline end.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { useCloudText } from '../text';
import { forwardChevron } from './icons';

export interface SectionHeaderProps {
  title: React.ReactNode;
  /** A count beside the title (a number, set tabular). */
  count?: number | null;
  /** A link at the inline end: `{ to, label }`. */
  link?: { to: string; label: string };
  /** Anything else at the inline end (replaces `link`). */
  action?: React.ReactNode;
  level?: 2 | 3;
  id?: string;
  className?: string;
}

export function SectionHeader({ title, count, link, action, level = 2, id, className = '' }: SectionHeaderProps) {
  const { dir } = useCloudText();
  const Heading = `h${level}` as 'h2' | 'h3';
  const Forward = forwardChevron(dir);
  return (
    <div className={`flex items-center justify-between gap-3 ${className}`}>
      <div className="flex min-w-0 items-center gap-2">
        <Heading id={id} className="truncate text-[17px] font-bold text-text-primary">
          {title}
        </Heading>
        {count != null ? <Badge>{count}</Badge> : null}
      </div>
      {action ??
        (link ? (
          <Link
            to={link.to}
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[13px] font-semibold text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {link.label}
            <Forward aria-hidden="true" className="h-4 w-4" />
          </Link>
        ) : null)}
    </div>
  );
}
