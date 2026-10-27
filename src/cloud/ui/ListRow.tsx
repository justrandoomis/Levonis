/**
 * ONE ROW OF A LIST — an upcoming print, a material, a printer, an order.
 *
 *   [leading]  Title                         [trailing]
 *              meta · meta
 *
 * Resting clay on its own; with `to` it is a door (and shows a forward
 * chevron unless `trailing` says something else). `leading` is an icon in a
 * well or a colour swatch; `trailing` a StatusPill, a figure, a button.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useCloudText } from '../text';
import { forwardChevron } from './icons';

export interface ListRowProps {
  title: React.ReactNode;
  meta?: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  to?: string;
  className?: string;
}

export function ListRow({ title, meta, leading, trailing, to, className = '' }: ListRowProps) {
  const { dir } = useCloudText();
  const Forward = forwardChevron(dir);
  const body = (
    <>
      {leading ? (
        <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl lv-well text-text-secondary">
          {leading}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-text-primary">{title}</span>
        {meta ? <span className="mt-0.5 block truncate text-[12px] text-text-muted">{meta}</span> : null}
      </span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
      {to && !trailing ? <Forward aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" /> : null}
    </>
  );
  const shell = `lv-surface flex min-w-0 items-center gap-3 p-3 ${className}`;
  if (to) {
    return (
      <Link
        to={to}
        className={`${shell} no-press transition-colors hover:bg-surface-raised active:shadow-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
      >
        {body}
      </Link>
    );
  }
  return <div className={shell}>{body}</div>;
}
