import React, { useCallback, useSyncExternalStore } from 'react';
import { Check, Heart, Scale } from 'lucide-react';
import { compareTray, type TrayItem } from '../../lib/compareTray';

/**
 * A result's COMPARE toggle — the same tray as every card toggle
 * (src/lib/compareTray.ts). A refused add (the fifth, or another type) is
 * answered by the tray's own toast or dialog through the store's notice.
 * Labelled, because on a result card there is room to say what it does.
 */
export function CompareButton({
  item,
  type,
  label,
  onLabel,
  addName,
  removeName,
  iconOnly = false,
}: {
  item: TrayItem;
  type: string;
  label: string;
  onLabel: string;
  addName: string;
  removeName: string;
  iconOnly?: boolean;
}) {
  const on = useSyncExternalStore(compareTray.subscribe, () => compareTray.has(item.id), () => false);
  const toggle = useCallback(() => {
    compareTray.toggle(item, type);
  }, [item, type]);
  const name = on ? removeName : addName;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={on}
      aria-label={iconOnly ? name : undefined}
      title={name}
      data-finder-compare={item.id}
      className={`inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-2xl border px-3.5 text-[14px] font-bold transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none ${
        iconOnly ? 'w-12 px-0' : ''
      } ${
        on
          ? 'border-text-primary bg-text-primary text-canvas'
          : 'border-border-subtle bg-surface text-text-primary hover:bg-surface-raised'
      }`}
    >
      {on ? <Check aria-hidden="true" className="size-4" strokeWidth={2.8} /> : <Scale aria-hidden="true" className="size-4" strokeWidth={2} />}
      {iconOnly ? null : <span>{on ? onLabel : label}</span>}
    </button>
  );
}

/**
 * SAVE — the shop's existing favourites (`PUT/DELETE /api/profile/favorites/:id`,
 * the heart on the product page and «المحفوظات»). A guest is sent to sign in
 * and brought back to these results. The heart moves on the tap and returns if
 * the server refuses, with the refusal said out loud (Product.tsx's rule).
 */
export function SaveButton({
  saved,
  busy,
  onToggle,
  label,
}: {
  saved: boolean;
  busy: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        if (!busy) onToggle();
      }}
      aria-pressed={saved}
      aria-busy={busy || undefined}
      aria-label={label}
      title={label}
      className="inline-flex min-h-11 w-12 shrink-0 items-center justify-center rounded-2xl border border-border-subtle bg-surface text-text-primary transition-[background-color,transform] duration-150 hover:bg-surface-raised active:scale-[0.95] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none"
    >
      <Heart
        aria-hidden="true"
        className={`size-[18px] transition-colors ${saved ? 'fill-danger text-danger' : ''}`}
        strokeWidth={2}
      />
    </button>
  );
}
