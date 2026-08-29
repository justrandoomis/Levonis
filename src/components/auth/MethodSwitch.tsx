import React from 'react';

/**
 * MethodSwitch — segmented method navigation for /auth (integrated mandate
 * §2.1): email / phone / Google / Telegram as clear tabs, so the page never
 * shows every form stacked in one long column.
 *
 * Real tablist semantics: roving tabindex, ArrowLeft/Right (RTL-aware),
 * Home/End, aria-selected + aria-controls pointing at the method panel the
 * page renders. Selection follows focus (standard tabs pattern).
 */

export type AuthMethod = 'email' | 'phone' | 'google' | 'telegram';

export interface MethodOption {
  id: AuthMethod;
  label: string;
  icon: React.ReactNode;
}

export interface MethodSwitchProps {
  options: MethodOption[];
  value: AuthMethod;
  onChange: (method: AuthMethod) => void;
  /** Accessible name of the tablist, e.g. "طريقة الدخول". */
  ariaLabel: string;
  dir?: 'ltr' | 'rtl';
  idPrefix?: string;
}

export function methodTabId(idPrefix: string, m: AuthMethod): string {
  return `${idPrefix}-tab-${m}`;
}

export function methodPanelId(idPrefix: string, m: AuthMethod): string {
  return `${idPrefix}-panel-${m}`;
}

export default function MethodSwitch({
  options,
  value,
  onChange,
  ariaLabel,
  dir = 'rtl',
  idPrefix = 'auth-method',
}: MethodSwitchProps) {
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.id === value)
  );

  const move = (delta: number) => {
    const next = options[(activeIndex + delta + options.length) % options.length];
    onChange(next.id);
    // Move focus with selection (roving tabindex).
    requestAnimationFrame(() => {
      document.getElementById(methodTabId(idPrefix, next.id))?.focus();
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // In RTL the "next" tab is visually to the LEFT.
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const backward = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === forward) {
      e.preventDefault();
      move(1);
    } else if (e.key === backward) {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      move(-activeIndex);
    } else if (e.key === 'End') {
      e.preventDefault();
      move(options.length - 1 - activeIndex);
    }
  };

  return (
    <div role="tablist" aria-label={ariaLabel} className="lv-methods" onKeyDown={handleKeyDown}>
      {options.map((o) => {
        const selected = o.id === value;
        return (
          <button
            key={o.id}
            id={methodTabId(idPrefix, o.id)}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={methodPanelId(idPrefix, o.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.id)}
            className="lv-methods__tab"
          >
            <span aria-hidden className="lv-methods__icon">
              {o.icon}
            </span>
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
