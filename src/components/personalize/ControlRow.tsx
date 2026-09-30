/**
 * THE ROW — exactly what the engine compiled (packages/catalog/src/
 * personalize/surface.ts): ≤ 4 tiles, then the open tile's panel, then the
 * price and the ONE door. Never a control of its own: archetype A (a name
 * stand) is Name · Look · Size · More + the door = 5 row controls, and every
 * blueprint ≤ 5 (docs/LEVO_PROJECT_PROGRAMME.md §C.6 «Compactness», §F F9).
 * Save, share and start over live in the top bar's ⋯, never here.
 *
 * Each tile is a tab (label + the current value); arrow keys follow the
 * writing direction and Enter opens; More opens its sheet. The door says what
 * the engine decided: «أضف إلى السلة», «اطلب الطباعة» or «اسأل المتجر»; when
 * the configuration cannot be made as it stands it stays in place, dimmed and
 * `aria-disabled`, and a tap brings the customer to what is missing.
 * `data-control` on every row control, `data-door` on the door.
 */
import React, { useRef } from 'react';
import type { SurfaceItem, TileId } from '../../../packages/catalog/src/personalize/types';
import type { SurfacePlan } from '../../../packages/catalog/src/personalize/surface';
import { useLanguage } from '../../LanguageContext';
import type { StudioWords } from './strings';

type Words = StudioWords;
export type DoorKind = 'add_to_cart' | 'request' | 'ask';

export const tileKey = (t: SurfaceItem<TileId>): string => (t.ref ? `${t.id}:${t.ref}` : t.id);

export interface ControlRowProps {
  plan: SurfacePlan;
  /** The open tile (`tileKey`), or null. */
  active: string | null;
  onTile: (tile: SurfaceItem<TileId>, el: HTMLButtonElement) => void;
  /** A tile's current value («ALI», three colour dots, «Medium ★»). */
  value: (tile: SurfaceItem<TileId>) => React.ReactNode;
  /** What a blocked door would be once fixed. */
  doorWould: DoorKind;
  onDoor: () => void;
  doorBusy?: boolean;
  /** The id of the line that explains a blocked door. */
  describedBy?: string;
  t: Words;
  price: React.ReactNode;
  /** The open tile's panel, between the row and the footer. */
  children?: React.ReactNode;
  panelId: string;
  /** A read-only view (C3's twin): the tiles are shown, the door is not. */
  readOnly?: boolean;
}

export function ControlRow({ plan, active, onTile, value, doorWould, onDoor, doorBusy, describedBy, t, price, children, panelId, readOnly }: ControlRowProps) {
  const { dir } = useLanguage();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const n = plan.tiles.length;
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = refs.current.findIndex((el) => el === document.activeElement);
    if (i < 0) return;
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    const to = e.key === forward ? (i + 1) % n : e.key === back ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    refs.current[to]?.focus();
  };
  const blocked = plan.door.kind === 'disabled';
  const kind: DoorKind = blocked ? doorWould : (plan.door.kind as DoorKind);
  return (
    <>
      {n > 0 && (
        <div
          role="tablist"
          aria-label={t.controls}
          onKeyDown={onKeyDown}
          className="grid shrink-0 gap-2 px-3 pt-3"
          style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
        >
          {plan.tiles.map((tile, i) => {
            const key = tileKey(tile);
            const selected = active === key;
            const more = tile.id === 'more';
            return (
              <button
                key={key}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={more ? undefined : panelId}
                aria-haspopup={more ? 'dialog' : undefined}
                tabIndex={selected || (!active && i === 0) ? 0 : -1}
                data-selected={selected ? 'true' : undefined}
                data-control={tile.id}
                onClick={(e) => onTile(tile, e.currentTarget)}
                className="lv-choice flex min-w-0 flex-col items-center justify-center gap-0.5 px-1.5 py-1.5 text-center"
              >
                <span className="max-w-full truncate text-[11.5px] font-medium text-text-muted">{t.tiles[tile.id]}</span>
                <span className="flex max-w-full items-center justify-center gap-1 truncate text-[13px] font-semibold text-text-primary">{value(tile)}</span>
              </button>
            );
          })}
        </div>
      )}
      <div id={panelId} role="tabpanel" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {children}
      </div>
      <div className="flex shrink-0 items-center gap-3 border-t border-border-subtle px-3 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
        {price}
        {!readOnly && (
          <button
            type="button"
            data-control="door"
            data-door={plan.door.kind}
            aria-disabled={blocked || undefined}
            aria-describedby={blocked ? describedBy : undefined}
            aria-busy={doorBusy || undefined}
            onClick={onDoor}
            className="lv-button lv-button-primary min-w-0 flex-1"
          >
            <span className="truncate">{t.door[kind]}</span>
          </button>
        )}
      </div>
    </>
  );
}
