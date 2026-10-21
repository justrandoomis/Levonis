/**
 * IS THE SOFT KEYBOARD UP? (plan P1-06, design critique 11)
 *
 * This site’s viewport tag has no `interactive-widget` (index.html), so the
 * keyboard does not shrink the layout viewport: `innerHeight` stays the
 * screen’s and only `visualViewport.height` drops. The keyboard is taken to
 * be up when a field that types is focused AND the visual viewport is more
 * than 150 px shorter than the layout viewport. Comparing the two heights of
 * the same moment — never against the largest height seen — keeps a
 * rotation from portrait to landscape with a field focused from reading as
 * a keyboard that never closes. The editor’s action bar steps aside while it
 * is up, so it never covers the field being typed into.
 */
import { useEffect, useState } from 'react';
import { useMediaQuery } from '../../../../lib/useMediaQuery';

export const KEYBOARD_GAP_PX = 150;

/**
 * A phone either way up: narrow, OR short (a phone in landscape is 740 wide
 * and 360 tall, where a centred window leaves no room for a list and its
 * search field, and row actions belong in a sheet).
 */
export const COMPACT_QUERY = '(max-width: 639px), (max-height: 480px)';

/**
 * Where the editor’s sheets sit. On a compact screen, upright or sideways,
 * they are docked at the bottom and open tall: upright, the sheet’s own
 * detent sets the height; sideways (wide, so not a phone to the sheet) the
 * class does, as tall as the large detent would be.
 */
export function useSheetPlacement(): { placement: 'dock' | 'bottom'; panelClassName?: string } {
  return useMediaQuery(COMPACT_QUERY) ? { placement: 'dock', panelClassName: 'h-[85dvh]' } : { placement: 'bottom' };
}

/** An element the keyboard types into. */
export function typesText(el: Element | null | undefined): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'hidden', 'image', 'date'].includes(type);
  }
  return (el as HTMLElement).isContentEditable === true;
}

export function keyboardIsOpen(p: { innerHeight: number; visualHeight: number | null | undefined; typing: boolean }): boolean {
  if (!p.typing || !p.visualHeight || !p.innerHeight) return false;
  return p.innerHeight - p.visualHeight > KEYBOARD_GAP_PX;
}

export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const vv = window.visualViewport;
    const read = () =>
      setOpen(
        keyboardIsOpen({
          innerHeight: window.innerHeight,
          visualHeight: vv?.height ?? window.innerHeight,
          typing: typesText(document.activeElement),
        })
      );
    read();
    vv?.addEventListener('resize', read);
    window.addEventListener('resize', read);
    document.addEventListener('focusin', read);
    document.addEventListener('focusout', read);
    return () => {
      vv?.removeEventListener('resize', read);
      window.removeEventListener('resize', read);
      document.removeEventListener('focusin', read);
      document.removeEventListener('focusout', read);
    };
  }, []);
  return open;
}
