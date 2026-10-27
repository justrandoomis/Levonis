"use client";

/**
 * ViewportCard — the rounded clay frame around the engine (reference row 4).
 *
 * It IS the editor area: the section that holds `.viewport-mount`, the empty
 * state, the import progress and the desktop shell actions. On a desktop the
 * stylesheet keeps it the full workspace it always was; on a phone it becomes
 * a card in the column, and `expanded` lays it back over the whole screen.
 * The engine is mounted once, inside, and is never moved between layouts.
 *
 * The overlay toolbar (phone only) runs along the card's top edge with no bar
 * behind it, as drawn: expand, «إعادة العرض», a divider and the view cube on
 * the start side; the file name on the end side, in LTR as a file name is,
 * with its document icon after it (the end side of the label, as drawn).
 *
 * «إعادة العرض» carries its name in aria-label as well as in the visible
 * span: under 350px the span is hidden to fit the row, and a button whose
 * only text is hidden has no accessible name (WCAG 4.1.2).
 *
 * ONE TAB STOP, AND THE ARROWS WALK THE THREE VIEW BUTTONS (c6fix-r3-ha-04),
 * as in TransformToolBar. The overlay said role="toolbar" and handled no
 * key, so an arrow on expand, «إعادة العرض» or the bed view went on to the
 * engine on window: it moved the selected model 10 mm and made the result
 * stale, and in the preview it stepped the layer slider. Now Tab enters the
 * toolbar once, on the button that last had the focus, the arrows, Home and
 * End walk the enabled buttons in the writing direction, and a key the
 * toolbar handles stops here (roving.ts). «إعادة العرض» is skipped while it
 * is disabled (no model yet).
 */

import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import type { StudioDictionary } from "../../i18n";
import { Icon } from "../header";
import { consumeRovingKey } from "./roving";

export interface ViewportCardProps {
  t: StudioDictionary;
  busy: boolean;
  children: ReactNode;
  onDragOverCapture: (event: DragEvent<HTMLElement>) => void;
  onDropCapture: (event: DragEvent<HTMLElement>) => void;
  /** The phone overlay toolbar; null hides it (no engine yet). */
  overlay: ViewportOverlayProps | null;
  cardRef?: Ref<HTMLElement>;
}

export interface ViewportOverlayProps {
  fileLabel: string | null;
  expanded: boolean;
  hasObjects: boolean;
  onToggleExpanded: () => void;
  onResetView: () => void;
  onViewBed: () => void;
}

export default function ViewportCard({ t, busy, children, onDragOverCapture, onDropCapture, overlay, cardRef }: ViewportCardProps) {
  return (
    <section
      ref={cardRef}
      className="editor-area"
      aria-busy={busy}
      onDragOverCapture={onDragOverCapture}
      onDropCapture={onDropCapture}
    >
      {children}
      {overlay && <ViewportOverlay t={t} overlay={overlay} />}
    </section>
  );
}

/** Expand, «إعادة العرض» and the bed view, in reading order. */
const EXPAND = 0;
const RESET = 1;
const BED = 2;

function ViewportOverlay({ t, overlay }: { t: StudioDictionary; overlay: ViewportOverlayProps }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  // The button Tab lands on: the one that last had the focus, while enabled.
  const [stop, setStop] = useState(EXPAND);
  const enabled = overlay.hasObjects ? [EXPAND, RESET, BED] : [EXPAND, BED];
  const tabStop = enabled.includes(stop) ? stop : EXPAND;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = consumeRovingKey(event, enabled.indexOf(index), enabled.length);
    if (next < 0) return;
    setStop(enabled[next]);
    refs.current[enabled[next]]?.focus();
  };
  return (
    <div className="vp-overlay m-only" role="toolbar" aria-label={t.viewGroup}>
      <div className="vp-tools">
        <button
          type="button"
          className="vp-tool"
          aria-pressed={overlay.expanded}
          aria-label={overlay.expanded ? t.collapseView : t.expandView}
          title={overlay.expanded ? t.collapseView : t.expandView}
          onClick={overlay.onToggleExpanded}
          data-levo-action="viewport-expand"
          ref={(node) => { refs.current[EXPAND] = node; }}
          tabIndex={tabStop === EXPAND ? 0 : -1}
          onFocus={() => setStop(EXPAND)}
          onKeyDown={(event) => onKeyDown(event, EXPAND)}
        >
          <Icon name={overlay.expanded ? "shrink" : "fit"} />
        </button>
        <button
          type="button"
          className="vp-tool"
          onClick={overlay.onResetView}
          disabled={!overlay.hasObjects}
          aria-label={t.resetView}
          title={t.resetView}
          data-levo-action="reset-view"
          ref={(node) => { refs.current[RESET] = node; }}
          tabIndex={tabStop === RESET ? 0 : -1}
          onFocus={() => setStop(RESET)}
          onKeyDown={(event) => onKeyDown(event, RESET)}
        >
          <Icon name="resetView" /><span>{t.resetView}</span>
        </button>
        <span className="vp-divider" aria-hidden="true" />
        <button
          type="button"
          className="vp-tool"
          onClick={overlay.onViewBed}
          aria-label={t.bed}
          title={t.bed}
          data-levo-action="view-bed"
          ref={(node) => { refs.current[BED] = node; }}
          tabIndex={tabStop === BED ? 0 : -1}
          onFocus={() => setStop(BED)}
          onKeyDown={(event) => onKeyDown(event, BED)}
        >
          <Icon name="cube" />
        </button>
      </div>
      <span className="vp-file" data-levo-readout="file-name">
        {overlay.fileLabel
          ? <span dir="ltr">{overlay.fileLabel}</span>
          : <span>{t.noModelYet}</span>}
        <Icon name="document" />
      </span>
    </div>
  );
}
