/**
 * THE SIX SECTIONS OF THE COMMUNITY, AS LINKS (community UI plan C1, §3 and
 * D-7; IMG_8487 R3, IMG_8462 (a)). Each section has its own page now, so the
 * chips are navigation, not tabs: a `<nav>` list of real links, the home
 * («لك») marked `aria-current="page"`. A long press, a new tab and a screen
 * reader all know where each goes.
 *
 *   grid   a phone: three by two chips, 48px high, the icon at the inline
 *          start and the label filling the rest. Under 375px the icon stacks
 *          over the label at 12.5px. Sorani has a single word wider than a
 *          third of any phone («شوێنکەوتووەکانم»), so Sorani lays the six out
 *          two by three: a word is never cut
 *   track  from `lg`: one raised tray of six equal columns, the labels alone
 *
 * The current section is the D-3 selection inside the community scope (DECISIONS
 * row 270): the solid sand fill with ink words (`.cm-sel`). Its cue that is not
 * a colour is the weight of its label and, on the track, the short bar under
 * it (IMG_8462 draws it in gold; on the sand it is the ink).
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Box, Store, User, Users, Wrench } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useMediaQuery } from '../../../lib/useMediaQuery';
import { useHubStrings } from './strings';

/** A phone narrower than 375px: a third of it holds an icon beside a word no more. */
const NARROW_QUERY = '(max-width: 374px)';

/** The section pages, in the owner order (§3). */
export const SECTION_LINKS = [
  { id: 'foryou', to: '/community' },
  { id: 'following', to: '/community/following' },
  { id: 'projects', to: '/community/projects' },
  { id: 'requests', to: '/requests' },
  { id: 'stores', to: '/community/stores' },
  { id: 'creators', to: '/community/makers' },
] as const;

/**
 * The bulb (the lucide lightbulb), drawn here: its icon module is used by one
 * lazy screen already (the sections menu), and a second user would move it
 * into the shared icon chunk every store page downloads (vite.config.ts `iconChunk`).
 */
function BulbGlyph({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
      <path d="M9 18h6" />
      <path d="M10 22h4" />
    </svg>
  );
}

const ICONS: Record<(typeof SECTION_LINKS)[number]['id'], (p: { className?: string }) => React.ReactNode> = {
  foryou: (p) => <User aria-hidden="true" strokeWidth={1.75} {...p} />,
  following: (p) => <Users aria-hidden="true" strokeWidth={1.75} {...p} />,
  projects: (p) => <BulbGlyph {...p} />,
  requests: (p) => <Box aria-hidden="true" strokeWidth={1.75} {...p} />,
  stores: (p) => <Store aria-hidden="true" strokeWidth={1.75} {...p} />,
  creators: (p) => <Wrench aria-hidden="true" strokeWidth={1.75} {...p} />,
};

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

export default function SectionNav({ variant }: { variant: 'grid' | 'track' }) {
  const s = useHubStrings();
  const { lang } = useLanguage();
  const narrow = useMediaQuery(NARROW_QUERY);
  if (variant === 'track') {
    return (
      <nav aria-label={s.sections} data-community-sections="track">
        <ul className="cm-card grid gap-1 lg:grid-cols-6 rounded-xl p-1.5 shadow-sm">
          {SECTION_LINKS.map(({ id, to }) => {
            const here = id === 'foryou';
            return (
              <li key={id} className="min-w-0">
                <Link
                  to={to}
                  aria-current={here ? 'page' : undefined}
                  className={`relative flex min-h-12 items-center justify-center rounded-md px-2 text-center text-base leading-tight ${FOCUS} ${
                    here ? 'cm-sel cm-line font-bold' : 'font-medium text-text-secondary hover:bg-surface-selected hover:text-text-primary'
                  }`}
                >
                  {s.tabs[id]}
                  {here && <span aria-hidden="true" className="absolute bottom-1 start-1/2 h-1 w-12 -translate-x-1/2 rtl:translate-x-1/2 rounded-full bg-current" />}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }
  // The longest Sorani label («شوێنکەوتووەکانم», 96px at 12.5px) is wider than a third of a phone:
  // Sorani lays the six out two by three. Under 375px every language stacks the icon over the words.
  const sorani = lang === 'ckb';
  const chip = narrow ? 'flex-col justify-center gap-1 px-1.5 py-1.5 text-center text-[12.5px]' : 'gap-2 px-2.5 py-1 text-start text-[14px]';
  return (
    <nav aria-label={s.sections} data-community-sections="grid">
      <ul className={`grid gap-2 ${sorani ? 'grid-cols-2' : 'grid-cols-3'}`}>
        {SECTION_LINKS.map(({ id, to }) => {
          const here = id === 'foryou';
          const Icon = ICONS[id];
          return (
            <li key={id} className="min-w-0">
              <Link
                to={to}
                aria-current={here ? 'page' : undefined}
                className={`flex h-full min-h-12 items-center rounded-md leading-tight ${chip} ${FOCUS} ${here ? 'cm-sel cm-line font-bold' : 'cm-raised font-semibold'}`}
              >
                <Icon className={`h-5 w-5 shrink-0 ${here ? '' : 'text-text-muted'}`} />
                <span className="min-w-0 break-words">{s.tabs[id]}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
