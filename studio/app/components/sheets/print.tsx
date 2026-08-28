"use client";

/**
 * Print & export sheet (slice S6).
 *
 * Output-path ordering follows mandate §9: preparing a MakerWorld 3MF project
 * is the PRIMARY action; raw G-code download/share is grouped under an
 * explicitly secondary section kept for testing and manual transfer.
 *
 * Honesty:
 * - the ready card only claims a result while the sliced output still matches
 *   the project (fresh, from the S4 slicing-state hook); a stale result is
 *   labeled stale and export is blocked upstream;
 * - MakerWorld wording is "file ready" / "open upload page" — never
 *   "uploaded"; opening the page uploads nothing and no success is recorded.
 */

import type { StudioDictionary } from "../../i18n";
import { Icon } from "../header";

export interface PrintSheetProps {
  t: StudioDictionary;
  profileShortName: string;
  selectedPlate: number;
  objectCount: number;
  /** Plates that currently hold a FRESH sliced result. */
  freshPlateCount: number;
  /** True when the current plate's result went stale after edits. */
  currentStale: boolean;
  handyProjectReady: boolean;
  onPrepareForHandy: () => void;
  onDownloadGcode: () => void;
  onShareGcode: () => void;
  onSaveProject: () => void;
  onExportAll: () => void;
  onOpenConnect: () => void;
}

export default function PrintSheet(props: PrintSheetProps) {
  const { t } = props;
  return (
    <div className="sheet-body print-body">
      {props.currentStale ? (
        <div className="print-ready-card stale" role="alert">
          <span><Icon name="warning" /></span>
          <div><strong>{t.stale}</strong><small>{t.staleHelp}</small></div>
        </div>
      ) : (
        <div className="print-ready-card">
          <span><Icon name="check" /></span>
          <div><strong>{t.printReady}</strong><small>{t.printReadyHelp}</small></div>
        </div>
      )}

      <section className={`phone-print-card ${props.handyProjectReady ? "ready" : ""}`} aria-live="polite">
        <header>
          <span><Icon name="print" /></span>
          <div><strong>{t.primaryPathTitle}</strong><p>{t.primaryPathHelp}</p></div>
        </header>
        <ol className="phone-print-steps">
          <li><b>1</b><span>{t.phoneStepOne}</span></li>
          <li><b>2</b><span>{t.phoneStepTwo}</span></li>
          <li><b>3</b><span>{t.phoneStepThree}</span></li>
        </ol>
        <div className="phone-print-actions">
          <button onClick={props.onPrepareForHandy}>
            <Icon name="save" /><span><b>{t.prepareForHandy}</b><small>{t.prepareForHandyHelp}</small></span>
          </button>
          {props.handyProjectReady && (
            <a href="https://makerworld.com/en/upload" target="_blank" rel="noreferrer">
              <span>{t.openMakerWorld}</span><Icon name="external" />
            </a>
          )}
        </div>
        {props.handyProjectReady && <p className="phone-print-file-ready">{t.handyFileReady}</p>}
        <p className="phone-print-confirmation"><Icon name="check" /><span>{t.phoneConfirmation}</span></p>
        <small className="phone-print-rights">{t.phoneRights}</small>
      </section>

      <section className="secondary-output-section">
        <h3>{t.secondaryOutputs}</h3>
        <p className="secondary-output-help">{t.gcodeSecondaryHelp}</p>
        <div className="print-action-grid">
          <button onClick={props.onDownloadGcode} disabled={props.currentStale}>
            <Icon name="file" /><span><b>{t.downloadGcode}</b><small>{props.profileShortName} · {t.plate} {props.selectedPlate + 1}</small></span>
          </button>
          <button onClick={props.onShareGcode} disabled={props.currentStale}>
            <Icon name="share" /><span><b>{t.shareFile}</b><small>{t.download}</small></span>
          </button>
          <button onClick={props.onSaveProject}>
            <Icon name="save" /><span><b>{t.saveProject}</b><small>{props.objectCount} {t.objects}</small></span>
          </button>
          {props.freshPlateCount > 1 && (
            <button onClick={props.onExportAll}>
              <Icon name="layers" /><span><b>{t.exportAll}</b><small>{props.freshPlateCount} {t.plate}</small></span>
            </button>
          )}
        </div>
      </section>

      <div className="print-handoff">
        <span className="handoff-icon"><Icon name="print" /></span>
        <div><strong>{t.officialPrint}</strong><p>{t.officialPrintHelp}</p><p>{t.mobilePrintHelp}</p></div>
        <a href="https://wiki.bambulab.com/en/software/bambu-connect" target="_blank" rel="noreferrer">
          <span>{t.openBambuGuide}</span><Icon name="external" />
        </a>
      </div>
      <button className="connection-details-button" onClick={props.onOpenConnect}>
        <Icon name="print" /><span>{t.connectPrinter}</span><Icon name="external" />
      </button>
      <p className="print-safety"><Icon name="info" /><span>{t.printSafety}</span></p>
    </div>
  );
}
