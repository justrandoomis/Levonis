/**
 * THE COMMUNITY TOP BAR (community UI plan C1 R1 and D1; IMG_8487, IMG_8462).
 *
 *   start   the wordmark «LEVONIS» (Latin, left to right, D-8); on a phone the
 *           page h1 «مجتمع ليفو» sits small under it, so a screen reader hears
 *           «LEVONIS», then the heading. From `lg` the h1 is the large title
 *           under the bar, and the bar carries the search in its middle
 *   end     reading from the end edge: the account door, the bell, the chats.
 *           The account door is the avatar, which opens the sections and
 *           account menu (hub/CommunityMenu.tsx, a lazy chunk downloaded on
 *           the first press, focus given back to the avatar when it closes),
 *           as kit `MenuDoor` does for a section header. A guest has the same
 *           door as a person glyph on a disc (the menu leads with «تسجيل
 *           الدخول» for a guest), and no bell: an inbox belongs to an account.
 *           The chats keep their unread badge: the bottom bar reads it once a
 *           page and this shows the same number (src/lib/useChatUnread.ts)
 *
 * There is no back arrow: the community home is a place, not a step.
 * Sticky floating chrome (`material scroll-edge`), as the bar it replaces.
 *
 * Nothing here imports the community kit modules: the home first chunk is
 * named in the entry, and every chunk it names costs every visit (plan R6).
 */
import React, { Suspense, useCallback, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircleMore, User } from 'lucide-react';
import { useAuth } from '../../../AuthContext';
import { useLanguage } from '../../../LanguageContext';
import { useChatUnread } from '../../../lib/useChatUnread';
import { variantSrcSet } from '../../../../packages/contracts/src/imageSizing';
import { fill, useHubStrings } from './strings';

/** The inbox, as the home header loads it: its own lazy chunk, for a signed-in viewer only. */
const NotificationBell = React.lazy(() => import('../../notifications/NotificationBell'));
/** The sections and account menu: downloaded on the first press. */
const CommunityMenu = React.lazy(() => import('./CommunityMenu'));

const CIRCLE = 'relative inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-surface text-text-secondary shadow-xs transition-colors hover:bg-surface-raised hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

export default function TopBar({ wide, search }: { wide: boolean; search?: React.ReactNode }) {
  const s = useHubStrings();
  const { t } = useLanguage();
  const { user, isAuthenticated } = useAuth();
  // The one read of this page, by the bottom bar (src/lib/useChatUnread.ts); nothing for a guest.
  const shared = useChatUnread();
  const unread = isAuthenticated ? shared : 0;
  const chats = unread > 0 ? `${t('webCenter')}، ${fill(s.unreadMessages, { n: unread })}` : t('webCenter');

  // The menu door: open state, the chunk asked for on the first press, focus back to the avatar on close.
  const door = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [ever, setEver] = useState(false);
  const close = useCallback(() => {
    setOpen(false);
    door.current?.focus({ preventScroll: true });
  }, []);

  const name = user?.name || user?.username || '';
  return (
    <div
      data-community-topbar
      className={`material scroll-edge sticky top-0 z-40 px-4 ${wide ? 'shadow-lg' : ''}`}
      style={wide ? { borderEndStartRadius: 24, borderEndEndRadius: 24 } : undefined}
    >
      <div className={`mx-auto flex max-w-6xl items-center gap-3 ${wide ? 'h-20' : 'h-14'}`}>
        <div className="min-w-0 shrink-0">
          <p dir="ltr" lang="en" className={`font-bold leading-none tracking-wide text-text-primary ${wide ? 'text-[28px]' : 'text-[22px]'}`}>
            LEVONIS
          </p>
          {!wide && <h1 className="mt-1 text-[13px] font-semibold leading-tight text-text-secondary">{s.title}</h1>}
        </div>
        {wide ? <div className="mx-auto w-full min-w-0 max-w-2xl">{search}</div> : <span className="flex-1" />}
        <div className="flex shrink-0 items-center gap-2.5">
          <Link to="/chats" aria-label={chats} data-community-chats className={CIRCLE}>
            <MessageCircleMore aria-hidden="true" className="h-5 w-5" strokeWidth={2} />
            {unread > 0 && (
              <span aria-hidden="true" data-nav-badge="messages" className="absolute -top-1 -end-1 h-[16px] min-w-[16px] rounded-full bg-crimson px-1 text-center text-[10px] font-black leading-[16px] text-snow tabular-nums">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </Link>
          {isAuthenticated && (
            <Suspense fallback={<span aria-hidden="true" className="size-11 shrink-0" />}>
              <NotificationBell />
            </Suspense>
          )}
          <button
            ref={door}
            type="button"
            onClick={() => {
              setEver(true);
              setOpen((o) => !o);
            }}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={s.sectionsAndAccount}
            data-community-avatar
            className={CIRCLE}
          >
            {isAuthenticated ? (
              <span aria-hidden="true" className="flex size-10 items-center justify-center overflow-hidden rounded-full bg-surface-selected text-base font-bold text-text-secondary">
                {user?.avatar_key ? (
                  <img src={`/files/${user.avatar_key}`} srcSet={variantSrcSet(`/files/${user.avatar_key}`)} sizes="40px" alt="" decoding="async" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                ) : (
                  name.trim().charAt(0).toUpperCase()
                )}
              </span>
            ) : (
              <User aria-hidden="true" className="h-5 w-5 text-gold" strokeWidth={2} />
            )}
          </button>
          {ever && (
            <Suspense fallback={null}>
              <CommunityMenu open={open} onClose={close} anchor={door} />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
