"use client";

/**
 * Platform-status sheet (slice S6).
 *
 * Every capability card states what is real today:
 * - the plate editor's demonstrated abilities,
 * - the engine's honest limits (9 plates, missing tools are not simulated),
 * - multi-material honesty (extruder assignment works; surface painting does
 *   not exist in the engine and is not claimed),
 * - direct printing status on the web (none — no bridge, no cloud partner).
 *
 * APK: the update-check/download UI is gone from the web entirely; instead an
 * explicitly disabled "full LEVONIS app — coming soon" card with NO link
 * (mandate §12). Back-links return users to the LEVONIS store and community
 * as plain navigation (mandate §2).
 */

import type { StudioDictionary } from "../../i18n";
import { Icon } from "../header";

export interface AboutSheetProps {
  t: StudioDictionary;
  onOpenConnect: () => void;
}

export default function AboutSheet(props: AboutSheetProps) {
  const { t } = props;
  return (
    <div className="sheet-body about-body">
      <div className="capability verified"><i /><span><strong>{t.realEditor}</strong><small>{t.realEditorHelp}</small></span></div>
      <div className="capability partial"><i /><span><strong>{t.missingTools}</strong><small>{t.missingToolsHelp}</small></span></div>
      <div className="capability partial"><i /><span><strong>{t.mmuStatus}</strong><small>{t.mmuStatusHelp}</small></span></div>
      <div className="capability disabled"><i /><span><strong>{t.directPrint}</strong><small>{t.directPrintHelp}</small></span></div>

      <div className="full-app-soon-card" aria-disabled="true">
        <Icon name="info" />
        <span><b>{t.fullAppSoon}</b><small>{t.fullAppSoonHelp}</small></span>
      </div>

      <button className="connection-details-button" onClick={props.onOpenConnect}>
        <Icon name="print" /><span>{t.connectPrinter}</span><Icon name="external" />
      </button>

      <div className="site-links">
        <a href="https://levonis-iq.com/" rel="noreferrer"><span>{t.backToStore}</span><Icon name="external" /></a>
        <a href="https://levonis-iq.com/community" rel="noreferrer"><span>{t.backToCommunity}</span><Icon name="external" /></a>
      </div>

      <p className="levonis-rights">{t.levonisRights}</p>
      <details className="legal-details">
        <summary>{t.legalInfo}</summary>
        <p>{t.legalSummary}</p>
        <a href="https://github.com/aliamer229/Levo_slicer" target="_blank" rel="noreferrer">{t.sourceAndNotices}</a>
      </details>
    </div>
  );
}
