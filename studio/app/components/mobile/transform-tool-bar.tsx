"use client";

/**
 * TransformToolBar — four tiles in an inset tray (reference row 5): Move,
 * Rotate, Size and Arrange, in reading order (Move first, at the start side).
 *
 * The first three choose the engine's transform gizmo; the shell does not
 * guess which one is on, it reads the engine's own rail
 * (EngineAdapter#activeGizmo), and the active tile takes the sand clay with
 * aria-pressed (owner override D-3). Arrange is an action, not a mode: it
 * lays out every object on the plate, with an undo in the message row, and so
 * it has no pressed state.
 */

import type { StudioDictionary } from "../../i18n";
import { Icon, type IconName } from "../header";

export type GizmoTool = "move" | "rotate" | "scale";

export interface TransformToolBarProps {
  t: StudioDictionary;
  active: GizmoTool | null;
  disabled: boolean;
  onTool: (tool: GizmoTool) => void;
  onArrange: () => void;
}

export default function TransformToolBar({ t, active, disabled, onTool, onArrange }: TransformToolBarProps) {
  const tools: Array<{ id: GizmoTool; icon: IconName; label: string }> = [
    { id: "move", icon: "move", label: t.move },
    { id: "rotate", icon: "rotate", label: t.toolRotate },
    { id: "scale", icon: "scale", label: t.toolScale },
  ];
  return (
    <div className="m-tools m-only" role="toolbar" aria-label={t.transformTools}>
      {tools.map((tool) => (
        <button
          key={tool.id}
          type="button"
          className="m-tool m-sel"
          aria-pressed={active === tool.id}
          disabled={disabled}
          onClick={() => onTool(tool.id)}
          data-levo-tool={tool.id}
        >
          <Icon name={tool.icon} /><span>{tool.label}</span>
        </button>
      ))}
      <button type="button" className="m-tool" disabled={disabled} onClick={onArrange} data-levo-action="auto-arrange-phone">
        <Icon name="layers" /><span>{t.toolArrange}</span>
      </button>
    </div>
  );
}
