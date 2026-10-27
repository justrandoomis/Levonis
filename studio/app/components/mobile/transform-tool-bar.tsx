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
 *
 * ONE TAB STOP, AND THE ARROWS WALK THE TILES (c6fix-r2-ha-02). The group is
 * a toolbar, so Tab enters it once, on the tile that last had the focus, and
 * the arrow keys, Home and End move the focus across «تحريك / تدوير / الحجم /
 * ترتيب» in the writing direction; Space or Enter presses. A key the toolbar
 * handles stops here (roving.ts): before, ArrowLeft on «تحريك» reached the
 * engine's nudge on window and moved the selected model 10 mm while the
 * focus stayed put.
 */

import { useRef, useState, type KeyboardEvent } from "react";
import type { StudioDictionary } from "../../i18n";
import { Icon, type IconName } from "../header";
import { consumeRovingKey } from "./roving";

export type GizmoTool = "move" | "rotate" | "scale";

export interface TransformToolBarProps {
  t: StudioDictionary;
  active: GizmoTool | null;
  disabled: boolean;
  onTool: (tool: GizmoTool) => void;
  onArrange: () => void;
}

/** Move, Rotate, Size and Arrange. */
const TILE_COUNT = 4;
const ARRANGE = TILE_COUNT - 1;

export default function TransformToolBar({ t, active, disabled, onTool, onArrange }: TransformToolBarProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  // The tile Tab lands on: the one that last had the focus.
  const [stop, setStop] = useState(0);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = consumeRovingKey(event, index, TILE_COUNT);
    if (next < 0) return;
    setStop(next);
    refs.current[next]?.focus();
  };
  const tools: Array<{ id: GizmoTool; icon: IconName; label: string }> = [
    { id: "move", icon: "move", label: t.move },
    { id: "rotate", icon: "rotate", label: t.toolRotate },
    { id: "scale", icon: "scale", label: t.toolScale },
  ];
  return (
    <div className="m-tools m-only" role="toolbar" aria-label={t.transformTools}>
      {tools.map((tool, index) => (
        <button
          key={tool.id}
          ref={(node) => { refs.current[index] = node; }}
          type="button"
          className="m-tool m-sel"
          aria-pressed={active === tool.id}
          tabIndex={index === stop ? 0 : -1}
          disabled={disabled}
          onClick={() => onTool(tool.id)}
          onFocus={() => setStop(index)}
          onKeyDown={(event) => onKeyDown(event, index)}
          data-levo-tool={tool.id}
        >
          <Icon name={tool.icon} /><span>{tool.label}</span>
        </button>
      ))}
      <button
        ref={(node) => { refs.current[ARRANGE] = node; }}
        type="button"
        className="m-tool"
        tabIndex={stop === ARRANGE ? 0 : -1}
        disabled={disabled}
        onClick={onArrange}
        onFocus={() => setStop(ARRANGE)}
        onKeyDown={(event) => onKeyDown(event, ARRANGE)}
        data-levo-action="auto-arrange-phone"
      >
        <Icon name="layers" /><span>{t.toolArrange}</span>
      </button>
    </div>
  );
}
