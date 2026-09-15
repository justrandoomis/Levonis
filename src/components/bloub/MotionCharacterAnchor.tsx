import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
import { beginCharacterRouteLoad, characterLayout, registerCharacterAnchor, type AnchorKind } from './anchors';
import { signalBloub } from './events';

/**
 * Layout only. The animated SVG lives exclusively in AppIntro.
 *
 * The slot is EMPTY in normal operation. It is a measured destination, and
 * anything drawn in it is a second Home identity competing with the character
 * that is on its way there — including, and especially, during the first
 * visit, when the character is still in the middle of the screen and this slot
 * is what the viewer would see at the bottom. The letter only comes back if
 * the character has actually failed to draw, because then Home needs to be
 * visibly a control rather than an empty patch of bar.
 */
export function MotionCharacterAnchor({ kind = 'top-header', busy = false, className = '' }: {
  kind?: AnchorKind; busy?: boolean; className?: string;
}) {
  const element = React.useRef<HTMLSpanElement>(null);
  React.useSyncExternalStore(characterLayout.subscribe, characterLayout.snapshot, characterLayout.serverSnapshot);
  React.useLayoutEffect(() => {
    if (element.current) return registerCharacterAnchor(element.current, kind, busy);
  }, [kind, busy]);
  return (
    <span ref={element} data-bloub-anchor={kind} data-bloub-home-target={kind === 'bottom-home' ? '' : undefined}
      aria-hidden="true" className={`lv-character-anchor ${className}`}>
      {characterLayout.renderFailed() ? <span data-bloub-fallback className="lv-character-fallback">L</span> : null}
    </span>
  );
}

export function MotionCharacterHome({ busy = false, kind = 'top-header' }: { busy?: boolean; kind?: AnchorKind }) {
  const { t } = useLanguage();
  return (
    <Link to="/" aria-label={t('home')} onClick={() => signalBloub('tap', 210)}
      className="lv-character-home focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
      <MotionCharacterAnchor kind={kind} busy={busy} />
    </Link>
  );
}

/**
 * Reserved in-flow slot for a focused page that has no header of its own.
 *
 * A page's own header takes precedence; there is never a second Home row once
 * that header mounts. No fixed top/left guesses or covering existing controls.
 *
 * IT MOUNTS EVEN WHILE A ROUTE IS STILL LOADING, and that is a deliberate
 * reversal. Suppressing it during the lazy-load window was meant to avoid a
 * layout jolt for a slot nothing was going to use, and the argument holds only
 * while some OTHER anchor exists. On the focused routes it serves — the ones
 * where the bottom navigation is gone — there is no other anchor, so the
 * suppression left the character with no legal destination in the whole
 * document for the length of the load, and a load that never settles (a route
 * flag stuck `busy`) made that permanent: the character stayed frozen at a
 * coordinate belonging to a layout that no longer existed while the page
 * scrolled underneath it. An always-present destination is worth a slot that
 * appears for a few hundred milliseconds over black.
 *
 * The jolt it was protecting against is handled where it belongs instead:
 * AppIntro holds the character's current position through a short handoff
 * rather than docking it here and again on the page's own header.
 */
export function MotionCharacterFallbackHeader() {
  React.useSyncExternalStore(characterLayout.subscribe, characterLayout.snapshot, characterLayout.serverSnapshot);
  if (characterLayout.hasPageAnchor()) return null;
  return (
    <div data-bloub-fallback-header className="lv-character-fallback-header">
      <MotionCharacterHome kind="top-fallback" />
    </div>
  );
}

/**
 * Page-owned critical loading; failure settlement must set busy=false too.
 *
 * The release is the effect's own cleanup and nothing else, which is what
 * makes the counter leak-proof by construction: React runs it on unmount AND
 * before every re-run, so there is no path where `busy` goes false, or the
 * page goes away, without the hold being given back. A caller's `finally`
 * only has to flip the flag — it cannot forget to release.
 */
export function useCharacterBusy(busy: boolean): void {
  React.useLayoutEffect(() => {
    if (busy) return beginCharacterRouteLoad();
  }, [busy]);
}
