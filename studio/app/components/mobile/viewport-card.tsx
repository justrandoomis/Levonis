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
 * the start side; the file name on the end side, in LTR as a file name is.
 */

import type { DragEvent, ReactNode, Ref } from "react";
import type { StudioDictionary } from "../../i18n";
import { Icon } from "../header";

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
      {overlay && (
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
            >
              <Icon name={overlay.expanded ? "shrink" : "fit"} />
            </button>
            <button type="button" className="vp-tool" onClick={overlay.onResetView} disabled={!overlay.hasObjects} data-levo-action="reset-view">
              <Icon name="resetView" /><span>{t.resetView}</span>
            </button>
            <span className="vp-divider" aria-hidden="true" />
            <button type="button" className="vp-tool" onClick={overlay.onViewBed} aria-label={t.bed} title={t.bed} data-levo-action="view-bed">
              <Icon name="cube" />
            </button>
          </div>
          <span className="vp-file" data-levo-readout="file-name">
            <Icon name="document" />
            {overlay.fileLabel
              ? <span dir="ltr">{overlay.fileLabel}</span>
              : <span>{t.noModelYet}</span>}
          </span>
        </div>
      )}
    </section>
  );
}
