/**
 * MENU — a list of actions that belongs to one button.
 *
 * WHAT WAS MISSING. `Anchored` declared `role="menu"` but had no keyboard at
 * all: arrow keys did nothing, typing did nothing, and Escape closed it
 * without giving focus back, so a keyboard user landed on <body>. The
 * dashboard's own dropdowns were hand-rolled `absolute` divs with none of it.
 *
 * THE KEYBOARD MODEL (WAI-ARIA "menu button", as native menus behave):
 *   on the trigger — Enter / Space / ↓ open on the first item, ↑ on the last;
 *   in the menu    — ↓ / ↑ move (wrapping, skipping separators), Home / End
 *                    jump, typing a letter jumps to the next item starting
 *                    with it (the same letter again cycles), Enter / Space
 *                    activate, Escape closes and returns focus to the
 *                    trigger, Tab closes and moves on from the trigger.
 * Focus really moves (a roving `tabIndex`), so a screen reader follows it,
 * and pointing at an item focuses it, so mouse and keyboard never disagree
 * about which row is lit. A disabled item stays reachable — it can say WHY it
 * is disabled (`hint`) — but cannot be activated.
 *
 * TWO PRESENTATIONS, ONE MENU. With a precise pointer or on a wide screen it
 * is `Anchored` to its trigger (it grows out of the button). On a phone under
 * a thumb it is a bottom sheet with 44px rows and a Cancel at the thumb — the
 * NotificationBell split, decided by `useIsPhone`/`usePointerFine` rather than
 * by a width alone.
 *
 * An item's action runs AFTER focus is back on the trigger, so an action that
 * opens a dialog gives that dialog the right opener to return to.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
import { edgeIndex, stepIndex, typeaheadIndex } from '../../lib/listNav';
import { useIsPhone, usePointerFine } from '../../lib/useMediaQuery';
import { Anchored } from './Overlay';
import { Sheet } from './Sheet';

export interface MenuItem {
  id: string;
  /** Plain text: it is also what typeahead matches. */
  label: string;
  icon?: React.ReactNode;
  onSelect?: () => void;
  /** A navigation item: rendered as a real link (new-tab and copy-link work). */
  href?: string;
  destructive?: boolean;
  disabled?: boolean;
  /** A second, quieter line — for a disabled item, the reason. */
  hint?: string;
}

export interface MenuSeparator {
  id: string;
  separator: true;
}

export type MenuEntry = MenuItem | MenuSeparator;

export interface MenuTriggerProps {
  ref: (el: HTMLElement | null) => void;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick: (event: React.MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}

export interface MenuProps {
  /** The menu's accessible name, and the sheet's title on a phone. */
  label: string;
  items: MenuEntry[];
  /** Render the trigger and spread `props` onto it (a Button or IconButton). */
  trigger: (props: MenuTriggerProps) => React.ReactNode;
  align?: 'start' | 'end';
  /** `auto`: anchored with a precise pointer or on a wide screen, a sheet on a phone. */
  presentation?: 'auto' | 'popover' | 'sheet';
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

const isSeparator = (e: MenuEntry): e is MenuSeparator => 'separator' in e;

interface MenuListProps {
  id: string;
  label: string;
  items: MenuEntry[];
  start: 'first' | 'last';
  large: boolean;
  onPick: (item: MenuItem) => void;
  onTab: () => void;
}

function MenuList({ id, label, items, start, large, onPick, onTab }: MenuListProps) {
  const refs = useRef<Array<HTMLElement | null>>([]);
  const typed = useRef({ text: '', at: 0 });
  const skip = (i: number) => isSeparator(items[i]);

  const focusAt = useCallback((i: number) => {
    if (i >= 0) refs.current[i]?.focus({ preventScroll: false });
  }, []);

  // One frame later: an anchored panel is invisible until it has been
  // positioned, and an invisible element cannot take focus.
  useEffect(() => {
    const frame = requestAnimationFrame(() => focusAt(edgeIndex(start, items.length, skip)));
    return () => cancelAnimationFrame(frame);
    // Only on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = () => refs.current.findIndex((el) => el === document.activeElement);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    const n = items.length;
    const at = current();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusAt(stepIndex(at, e.key === 'ArrowDown' ? 1 : -1, n, skip));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusAt(edgeIndex(e.key === 'Home' ? 'first' : 'last', n, skip));
    } else if (e.key === 'Tab') {
      onTab();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
      const now = Date.now();
      typed.current = { text: now - typed.current.at > 500 ? e.key : typed.current.text + e.key, at: now };
      const labels = items.map((it) => (isSeparator(it) ? '' : it.label));
      const hit = typeaheadIndex(labels, at, typed.current.text, skip);
      if (hit >= 0) {
        e.preventDefault();
        focusAt(hit);
      }
    }
  };

  return (
    <div id={id} role="menu" aria-label={label} aria-orientation="vertical" onKeyDown={onKeyDown} className={large ? 'p-2' : 'p-1'}>
      {items.map((entry, i) => {
        if (isSeparator(entry)) {
          return <div key={entry.id} role="separator" className="my-1 h-px bg-border-subtle" />;
        }
        const row = `flex w-full items-center gap-3 rounded-md px-3 text-start outline-none transition-colors focus:bg-white/[0.07] ${
          large ? 'min-h-12 text-[15px]' : 'min-h-11 text-sm'
        } ${entry.destructive ? 'text-danger' : 'text-text-primary'} ${entry.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`;
        const content = (
          <>
            {entry.icon && (
              <span aria-hidden="true" className={`shrink-0 ${entry.destructive ? '' : 'text-text-secondary'}`}>
                {entry.icon}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{entry.label}</span>
              {entry.hint && <span className="block text-[12px] leading-snug text-text-muted">{entry.hint}</span>}
            </span>
          </>
        );
        const common = {
          ref: (el: HTMLElement | null) => {
            refs.current[i] = el;
          },
          role: 'menuitem',
          tabIndex: -1,
          'aria-disabled': entry.disabled || undefined,
          'data-menu-item': entry.id,
          onPointerMove: (ev: React.PointerEvent<HTMLElement>) => {
            if (ev.pointerType === 'mouse' && document.activeElement !== ev.currentTarget) ev.currentTarget.focus({ preventScroll: true });
          },
          className: row,
        };
        if (entry.href && !entry.disabled) {
          return (
            <Link key={entry.id} to={entry.href} {...common} onClick={() => onPick(entry)}>
              {content}
            </Link>
          );
        }
        return (
          <button
            key={entry.id}
            type="button"
            {...common}
            onClick={() => {
              if (!entry.disabled) onPick(entry);
            }}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}

export function Menu({ label, items, trigger, align = 'end', presentation = 'auto', onOpenChange, className = '' }: MenuProps) {
  const { loc } = useLanguage();
  const phone = useIsPhone();
  const fine = usePointerFine();
  const asSheet = presentation === 'sheet' || (presentation === 'auto' && phone && !fine);
  const [open, setOpenState] = useState(false);
  const [start, setStart] = useState<'first' | 'last'>('first');
  const anchor = useRef<HTMLElement | null>(null);
  const menuId = `menu-${useId()}`;

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange]
  );

  const close = useCallback(() => setOpen(false), [setOpen]);

  const pick = (item: MenuItem) => {
    setOpen(false);
    anchor.current?.focus({ preventScroll: true });
    // A link item navigates by itself; `onSelect` is only its side effect.
    item.onSelect?.();
  };

  const triggerProps: MenuTriggerProps = {
    ref: (el) => {
      anchor.current = el;
    },
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: () => {
      setStart('first');
      setOpen(!open);
    },
    onKeyDown: (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setStart(e.key === 'ArrowUp' ? 'last' : 'first');
        setOpen(true);
      }
    },
  };

  const list = (
    <MenuList
      id={menuId}
      label={label}
      items={items}
      start={start}
      large={asSheet}
      onPick={pick}
      onTab={() => {
        setOpen(false);
        anchor.current?.focus({ preventScroll: true });
      }}
    />
  );

  return (
    <>
      {trigger(triggerProps)}
      {asSheet ? (
        <Sheet
          open={open}
          onClose={close}
          label={label}
          dragHandle
          testId="menu-sheet"
          header={<p className="px-4 pb-1 pt-1 text-[13px] font-semibold text-text-muted">{label}</p>}
          footer={
            <button type="button" onClick={close} className="lv-button lv-button-secondary w-full">
              {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
            </button>
          }
        >
          {list}
        </Sheet>
      ) : (
        <Anchored open={open} onClose={close} anchor={anchor} align={align} role="none" testId="menu" className={`min-w-[12rem] max-w-[min(20rem,calc(100vw-1rem))] ${className}`}>
          {list}
        </Anchored>
      )}
    </>
  );
}
