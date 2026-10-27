/**
 * AN HONEST «NOTHING HERE YET», with the one thing to do next.
 *
 * A new customer has no hours, no filament, no files: the screen says so and
 * offers the way in («Buy hours», «Upload your first model») — never a
 * sample row that is not theirs. Resting clay, the icon in a sunk well, as
 * the house async states (src/components/ui/AsyncStates.tsx) draw theirs.
 */
import React from 'react';
import { Inbox } from './icons';

export interface CloudEmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  /** One or two actions — `lv-button` links or `<Button>`s. */
  action?: React.ReactNode;
  /** Less padding, for a state inside a section rather than a whole page. */
  compact?: boolean;
  /** `alert` for a failure the reader must hear now; `status` (default) for a quiet fact. */
  role?: 'status' | 'alert';
  className?: string;
}

export function CloudEmptyState({ icon, title, body, action, compact = false, role = 'status', className = '' }: CloudEmptyStateProps) {
  return (
    <div role={role} className={`lv-surface flex flex-col items-center gap-3 text-center ${compact ? 'px-4 py-6' : 'px-6 py-12'} ${className}`}>
      <div aria-hidden="true" className="flex h-12 w-12 items-center justify-center rounded-full lv-well text-text-muted">
        {icon ?? <Inbox className="h-6 w-6" />}
      </div>
      <p className="text-[15px] font-bold text-text-primary">{title}</p>
      {body ? <p className="max-w-xs text-sm leading-relaxed text-text-muted">{body}</p> : null}
      {action ? <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}
