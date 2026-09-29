/**
 * THE COMMUNITY'S FOUR VERBS — real links, so a keyboard, a screen reader and
 * a long press all know where each goes. «طلب طباعة» is the page's one primary
 * action and carries the sage disc; «شارك مشروعًا» opens the composer. A guest
 * goes through sign-in first and comes back to the door they chose.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, Heart, Plus, Share2 } from 'lucide-react';
import { useHubStrings } from './strings';

export interface DoorLink {
  to: string;
  state?: unknown;
}

export default function QuickActions({ newRequestLink, composerLink }: { newRequestLink: DoorLink; composerLink: DoorLink }) {
  const s = useHubStrings();
  return (
    <nav aria-label={s.shortcuts} data-community-quick-actions className="grid grid-cols-4 gap-2 sm:max-w-lg">
      <Door {...newRequestLink} icon={Plus} label={s.printRequest} primary testId="community-new-request" />
      <Door {...composerLink} icon={Share2} label={s.shareProject} testId="community-share-project" />
      <Door to="/requests?view=mine" icon={ClipboardList} label={s.myRequests} />
      <Door to="/followed-stores" icon={Heart} label={s.followed} />
    </nav>
  );
}

function Door({
  to,
  state,
  icon: Icon,
  label,
  primary = false,
  testId,
}: DoorLink & {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;
  label: string;
  primary?: boolean;
  testId?: string;
}) {
  return (
    <Link
      to={to}
      state={state}
      data-testid={testId}
      className="press-scale group flex min-w-0 flex-col items-center gap-2 rounded-2xl py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <span
        className={`flex h-12 w-12 items-center justify-center rounded-2xl border transition-colors ${
          primary ? 'border-sage/40 bg-sage/10' : 'border-border-subtle/60 bg-surface group-hover:border-border-subtle'
        }`}
      >
        <Icon aria-hidden="true" className={`h-5 w-5 ${primary ? 'text-sage' : 'text-text-secondary group-hover:text-text-primary'}`} />
      </span>
      <span className={`line-clamp-2 w-full text-balance text-center text-[11px] font-medium leading-tight ${primary ? 'text-sage' : 'text-text-secondary'}`}>{label}</span>
    </Link>
  );
}
