"use client";

/**
 * ReadinessBanner — the line under the model (reference row 8), driven by the
 * real state through readiness.ts. It never shows a success the editor cannot
 * stand behind; the decision table and its reasons are in that module.
 *
 * A blocker is an alert (it is announced at once); every other state is a
 * polite status.
 */

import type { StudioDictionary } from "../../i18n";
import { Icon } from "../header";
import { toneOf, type ReadinessKind } from "./readiness";

export interface ReadinessBannerProps {
  t: StudioDictionary;
  kind: ReadinessKind;
  /** The second line, already worded for the state (the shell knows the numbers). */
  detail: string;
}

export default function ReadinessBanner({ t, kind, detail }: ReadinessBannerProps) {
  const tone = toneOf(kind);
  const title = kind === "ready" ? t.readyToSlice
    : kind === "sliced" ? t.printReady
      : kind === "stale" ? t.stale
        : kind === "fallback" ? t.presetFallbackTitle
          : t.tooBigTitle;
  return (
    <div
      className="m-banner m-only"
      data-tone={tone}
      data-levo-readiness={kind}
      role={tone === "danger" ? "alert" : "status"}
      aria-live={tone === "danger" ? "assertive" : "polite"}
    >
      <span className="m-banner__icon" aria-hidden="true"><Icon name={tone === "success" ? "check" : "warning"} /></span>
      <strong>{title}</strong>
      <small>{detail}</small>
    </div>
  );
}
