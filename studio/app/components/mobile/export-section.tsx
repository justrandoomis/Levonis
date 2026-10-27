"use client";

/**
 * ExportSection — «تصدير الملف» (reference row 10).
 *
 * 3MF is always available: a project is worth saving long before anything is
 * sliced, and the 3MF carries the layout and the settings. G-code exists only
 * as the output of a slice, so its tile is enabled only while the current
 * plate's result is FRESH; before a slice it says «متاح بعد التقطيع», after an
 * edit «أعد التقطيع أولًا». The old G-code is never offered as if it were the
 * new one (the slicing-state hook refuses to hand it out anyway).
 *
 * «المزيد من خيارات التصدير» opens the existing print sheet (MakerWorld 3MF,
 * sharing, every plate, connecting a printer) once there is a result to talk
 * about; before that, the same things live in the overflow sheet.
 */

import type { StudioDictionary } from "../../i18n";
import { Icon } from "../header";

/**
 * A Latin token joined by a hyphen («G-code») is one word to the reader, but
 * a line may break after its hyphen: at 390 px the Sorani label wrapped as
 * «هەناردەکردنی G-» over «code», and the English one did at 320 px. Each such
 * token is drawn as one unbreakable, direction-isolated run, so the label
 * wraps only between words, and the font keeps drawing its own hyphen (the
 * Cairo subsets have no glyph for U+2011, the non-breaking hyphen).
 */
const HYPHENATED_TOKEN = /([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)/;

export function keepTokensWhole(label: string) {
  return label.split(HYPHENATED_TOKEN).map((part, index) => (
    index % 2 === 1
      ? <bdi key={index} dir="ltr" className="m-export__token">{part}</bdi>
      : part
  ));
}

export interface ExportSectionProps {
  t: StudioDictionary;
  hasObjects: boolean;
  gcodeReady: boolean;
  stale: boolean;
  /** «A1 · Plate 1» once the G-code is ready. */
  gcodeCaption: string;
  onExport3mf: () => void;
  onExportGcode: () => void;
  onMore: (() => void) | null;
}

export default function ExportSection(props: ExportSectionProps) {
  const { t } = props;
  return (
    <section className="m-export m-only" aria-labelledby="m-export-title" data-levo-card="export">
      <h2 id="m-export-title">{t.exportFile}</h2>
      <div className="m-export__row">
        <button type="button" className="m-export__tile" onClick={props.onExport3mf} disabled={!props.hasObjects} data-levo-action="export-3mf">
          <span><b>{keepTokensWhole(t.export3mf)}</b></span>
          <Icon name="document" />
        </button>
        <button type="button" className="m-export__tile" onClick={props.onExportGcode} disabled={!props.gcodeReady} data-levo-action="export-gcode">
          <span>
            <b>{keepTokensWhole(t.exportGcode)}</b>
            <small>{props.gcodeReady ? props.gcodeCaption : props.stale ? t.resliceFirst : t.availableAfterSlice}</small>
          </span>
          <Icon name="document" />
        </button>
      </div>
      {props.onMore && (
        <button type="button" className="m-export__more" onClick={props.onMore} aria-haspopup="dialog">
          <span>{t.moreExport}</span><Icon name="chevronBack" />
        </button>
      )}
    </section>
  );
}
