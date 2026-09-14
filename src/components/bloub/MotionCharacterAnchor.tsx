import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
import { beginCharacterRouteLoad, characterLayout, registerCharacterAnchor, type AnchorKind } from './anchors';
import { signalBloub } from './events';

/** Layout only. The animated SVG lives exclusively in AppIntro. */
export function MotionCharacterAnchor({ kind = 'top-header', busy = false, className = '' }: {
  kind?: AnchorKind; busy?: boolean; className?: string;
}) {
  const element = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => {
    if (element.current) return registerCharacterAnchor(element.current, kind, busy);
  }, [kind, busy]);
  return (
    <span ref={element} data-bloub-anchor={kind} data-bloub-home-target={kind === 'bottom-home' ? '' : undefined}
      aria-hidden="true" className={`lv-character-anchor ${className}`}>
      <span data-bloub-fallback className="lv-character-fallback">L</span>
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

/** Reserved in-flow slot for a focused page with no registered header yet.
 * A page's own header takes precedence; there is never a second Home row once
 * that header mounts. No fixed top/left guesses or covering existing controls.
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

/** Page-owned critical loading; failure settlement must set busy=false too. */
export function useCharacterBusy(busy: boolean): void {
  React.useLayoutEffect(() => {
    if (busy) return beginCharacterRouteLoad();
  }, [busy]);
}
