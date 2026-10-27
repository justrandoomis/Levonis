/**
 * THE HOME'S TWO VERBS (community UI plan C1 R2 and D2; IMG_8487, IMG_8462):
 * «اطلب طباعة», the one gold primary of the screen (D-2, the sand gradient
 * inside the community scope), and «شارك مشروعًا» in raised clay beside it.
 * Both are real links, so a keyboard, a screen reader and a long press know
 * where each goes, and a guest goes through sign-in first and comes back to
 * the door they chose (`state.from`). «طلباتي» and the stores a member
 * follows moved to the sections menu (D-9).
 *
 * A phone puts the two side by side under the search, 48px high; from `lg`
 * they sit at the end of the title row, 56px high.
 */
import { Link } from 'react-router-dom';
import { Box, Plus } from 'lucide-react';
import { useHubStrings } from './strings';

export interface DoorLink {
  to: string;
  state?: unknown;
}

export default function HubActions({ newRequestLink, composerLink, wide }: { newRequestLink: DoorLink; composerLink: DoorLink; wide: boolean }) {
  const s = useHubStrings();
  const size = wide ? 'min-h-14 px-6 text-lg' : 'min-h-12';
  const icon = wide ? 'h-6 w-6' : 'h-[18px] w-[18px]';
  // The kit looks by their class names (`.cm-btn-gold`, the lazy community sheet): the home first
  // chunk imports no kit module, since the entry names every chunk it needs (plan R6).
  return (
    <div data-community-actions className={wide ? 'flex shrink-0 items-center gap-4' : 'grid grid-cols-2 gap-2'}>
      <Link to={newRequestLink.to} state={newRequestLink.state} data-variant="gold" data-testid="community-new-request" className={`lv-button cm-btn-gold font-bold ${size}`}>
        <Box aria-hidden="true" className={`${icon} shrink-0`} strokeWidth={2} />
        {s.requestPrint}
      </Link>
      <Link to={composerLink.to} state={composerLink.state} data-variant="secondary" data-testid="community-share-project" className={`lv-button lv-button-secondary cm-btn-clay ${size}`}>
        <Plus aria-hidden="true" className={`${icon} shrink-0`} strokeWidth={2} />
        {s.shareProject}
      </Link>
    </div>
  );
}
