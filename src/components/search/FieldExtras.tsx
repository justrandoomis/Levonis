import React, { Suspense, useEffect, useRef, useState } from 'react';
import { Camera, History } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import AnimatedPlaceholder from './AnimatedPlaceholder';
import { addRecent, clearRecent, readRecent } from './recentTerms';

/** Scan and photo search, fetched on the camera button's press. */
const loadVisual = () => import('./VisualSearch');
const VisualSearch = React.lazy(loadVisual);

/** The event the field sends to open scan / photo search from elsewhere (its «no results» row). */
export const OPEN_VISUAL_EVENT = 'lv:visual-search';

/**
 * WHAT THE SEARCH FIELD GAINED ON 2026-11-18, IN ONE CHUNK AFTER THE FIRST
 * PAINT (owner: «the [search products] show instead animation of popular
 * products … add search about images and scan»).
 *
 * The field (./LiveSearch.tsx) is in every page's first paint and its budget
 * is measured to the tenth of a kilobyte (tests/bundleBudget.test.ts), so
 * none of this rides there: the typed placeholder (./AnimatedPlaceholder.tsx),
 * the camera button at the field's end while it is empty, and the scan /
 * photo window behind it (./VisualSearch.tsx, its own chunk again, fetched on
 * the button's press). Until this lands the field is the field it was: the
 * native placeholder, no camera.
 */
export default function FieldExtras({
  empty,
  focused,
  mirrorStyle,
  textClass,
  eventTarget,
}: {
  empty: boolean;
  /** The input has focus: the empty field then lists the shopper's recent searches under it. */
  focused: boolean;
  mirrorStyle: React.CSSProperties;
  textClass: string;
  /** The field's form: «ابحث بصورة» in its panel dispatches `OPEN_VISUAL_EVENT` on it. */
  eventTarget: React.RefObject<HTMLElement | null>;
}) {
  const { loc } = useLanguage();
  const cameraRef = useRef<HTMLButtonElement>(null);
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  const inputOf = () => eventTarget.current?.querySelector('input[type="search"]') as HTMLInputElement | null | undefined;
  // A chosen recent search or a scanned code goes into the field AS IF TYPED: the field's own
  // onChange runs (value, panel, live answer), so the field carries no extra door for it.
  const onQuery = (text: string) => {
    const input = inputOf();
    if (!input) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text.slice(0, 100));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus({ preventScroll: true });
  };
  // While names are being typed the input's own placeholder steps aside; it is the
  // field's label text (aria-label), so it comes back word for word, in the page language.
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const input = eventTarget.current?.querySelector('input[type="search"]') as HTMLInputElement | null;
    if (!input) return;
    input.placeholder = typing && empty ? '' : input.getAttribute('aria-label') ?? '';
  }, [typing, empty, eventTarget, loc]);
  // THE SHOPPER'S LAST SEARCHES (./recentTerms.ts, this device only), under the empty focused
  // field. Escape or a choice hides them until the next focus.
  const [recent, setRecent] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (focused && empty) {
      setRecent(readRecent());
      setDismissed(false);
    }
  }, [focused, empty]);
  useEffect(() => {
    const el = eventTarget.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDismissed(true);
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [eventTarget]);
  const recentShown = focused && empty && !dismissed && !open && recent.length > 0;
  // What is remembered: the text in the field when the shopper submits it, opens a row of
  // its panel, or takes a section shortcut — read here off the form, so the field itself
  // (in every first paint) carries none of it.
  useEffect(() => {
    const el = eventTarget.current;
    if (!el) return;
    const text = () => (el.querySelector('input[type="search"]') as HTMLInputElement | null)?.value ?? '';
    const onSubmit = () => addRecent(text());
    const onClick = (e: Event) => {
      if ((e.target as Element | null)?.closest?.('[role="option"], [data-search-sections] a')) addRecent(text());
    };
    el.addEventListener('submit', onSubmit);
    el.addEventListener('click', onClick, true);
    return () => {
      el.removeEventListener('submit', onSubmit);
      el.removeEventListener('click', onClick, true);
    };
  }, [eventTarget]);

  useEffect(() => {
    const el = eventTarget.current;
    if (!el) return;
    const onOpen = () => {
      // The panel under the field steps aside, as Escape in the field does, and the field lets go
      // of the focus: the window takes it, and a field with text that got it back would reopen the panel.
      const input = inputOf();
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      input?.blur();
      setArmed(true);
      setOpen(true);
    };
    el.addEventListener(OPEN_VISUAL_EVENT, onOpen);
    return () => el.removeEventListener(OPEN_VISUAL_EVENT, onOpen);
  }, [eventTarget]);

  return (
    <>
      {empty && <AnimatedPlaceholder style={mirrorStyle} className={`font-medium ${textClass}`} onReady={setTyping} />}
      {empty && (
        <button
          ref={cameraRef}
          type="button"
          data-testid="search-camera"
          aria-label={loc('ابحث بالباركود أو بصورة', 'Search by barcode or photo', 'گەڕان بە بارکۆد یان وێنە')}
          onPointerDown={() => void loadVisual()}
          onClick={() => {
            setArmed(true);
            setOpen(true);
          }}
          className="absolute inset-y-0 end-0 flex w-11 items-center justify-center rounded-lg text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Camera aria-hidden="true" className="size-[18px]" />
        </button>
      )}
      {recentShown && (
        <div
          data-search-recent
          // Keeps the caret in the field while a row is tapped.
          onMouseDown={(e) => e.preventDefault()}
          className="material pointer-events-auto absolute inset-x-0 top-full z-20 mt-2 overflow-hidden rounded-lg border border-border-subtle p-1.5 shadow-lg"
        >
          <div className="flex items-center justify-between px-2">
            <span className="text-[12px] font-bold text-text-muted">{loc('عمليات بحثك الأخيرة', 'Your recent searches', 'دوایین گەڕانەکانت')}</span>
            <button
              type="button"
              onClick={() => {
                clearRecent();
                setRecent([]);
              }}
              className="lv-button lv-button-ghost lv-button-sm text-text-muted"
            >
              {loc('مسح', 'Clear', 'سڕینەوە')}
            </button>
          </div>
          {recent.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setDismissed(true);
                onQuery(t);
              }}
              className="lv-button lv-button-ghost w-full justify-start gap-3 px-2 text-[14px] font-normal text-text-primary"
            >
              <History aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
              <bdi className="truncate">{t}</bdi>
            </button>
          ))}
        </div>
      )}
      {armed && (
        <Suspense fallback={null}>
          <VisualSearch open={open} onClose={() => setOpen(false)} anchor={cameraRef} onQuery={onQuery} />
        </Suspense>
      )}
    </>
  );
}
