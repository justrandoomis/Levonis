/**
 * CARD — one grouped surface with an optional title row.
 *
 * Group by spacing first and by a box second (apple-design §4): a card is for
 * content that belongs together AND sits beside other groups — a section of a
 * settings page, a panel on the Command Center. It is the existing
 * `.lv-surface` (tonal surface, 1px subtle border, `radius-lg`), so a card in
 * the workspace and a surface in the store are the same material.
 *
 * The title is a real heading (h2 by default; pass `level` inside a page that
 * already has h2s), because a screen-reader user moves through a dashboard by
 * its headings. `action` sits at the inline end of the title row: «عرض الكل»,
 * a menu. Titles are neutral text, not gold — the accent is for state, not
 * for every label on the page.
 *
 * Do not nest cards; use `Card.Section`-style spacing (a `lv-section` divider)
 * inside one instead.
 */
import React from 'react';

export interface CardProps {
  title?: React.ReactNode;
  /** One quiet line under the title. */
  description?: React.ReactNode;
  /** At the inline end of the title row. */
  action?: React.ReactNode;
  children?: React.ReactNode;
  /** Heading level of the title. */
  level?: 2 | 3 | 4;
  /** `none` for content that runs to the edges (a list, a table). */
  padding?: 'md' | 'none';
  as?: 'section' | 'div' | 'article';
  className?: string;
  id?: string;
}

export function Card({
  title,
  description,
  action,
  children,
  level = 2,
  padding = 'md',
  as: Tag = 'section',
  className = '',
  id,
}: CardProps) {
  const Heading = `h${level}` as 'h2' | 'h3' | 'h4';
  const titleId = id && title ? `${id}-title` : undefined;
  const head = (title || action) && (
    <div className={`flex items-start justify-between gap-3 ${padding === 'none' ? 'px-4 pt-4' : ''} ${children ? 'mb-3' : ''}`}>
      <div className="min-w-0">
        {title && (
          <Heading id={titleId} className="text-[15px] font-bold leading-snug text-text-primary">
            {title}
          </Heading>
        )}
        {description && <p className="mt-0.5 text-[13px] leading-relaxed text-text-muted">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
  return (
    <Tag id={id} aria-labelledby={titleId} data-card className={`lv-surface min-w-0 ${padding === 'md' ? 'p-4' : 'overflow-hidden'} ${className}`}>
      {head}
      {children}
    </Tag>
  );
}
