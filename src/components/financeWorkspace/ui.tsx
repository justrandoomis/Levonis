import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpLeft, LoaderCircle, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

export const formatMoney = (value: number | null | undefined, currency = 'IQD') =>
  value == null ? '—' : `${value.toLocaleString('en-US', { maximumFractionDigits: currency === 'IQD' ? 0 : 2 })} ${currency === 'IQD' ? 'د.ع' : currency}`;

export function Money({ value, currency = 'IQD', compact = false }: {
  value: number | null | undefined; currency?: string; compact?: boolean;
}) {
  return <span className={`fw-money${compact ? ' fw-money--compact' : ''}`} dir="ltr">{formatMoney(value, currency)}</span>;
}

export function Button({ children, variant = 'secondary', busy, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; busy?: boolean;
}) {
  return <button type="button" {...props} disabled={props.disabled || busy} className={`fw-button fw-button--${variant} ${className}`}>
    {busy && <LoaderCircle size={17} className="fw-spinner" aria-hidden />}{children}
  </button>;
}

export function Surface({ title, subtitle, action, children, className = '' }: {
  title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return <section className={`fw-surface ${className}`}>
    {(title || action) && <div className="fw-section-heading"><div>{title && <h2>{title}</h2>}{subtitle && <p>{subtitle}</p>}</div>{action}</div>}
    {children}
  </section>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return <label className="fw-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Empty({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return <div className="fw-empty"><span className="fw-empty-symbol" aria-hidden>◇</span><h3>{title}</h3>{text && <p>{text}</p>}{action}</div>;
}

export function Status({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'positive' | 'warning' | 'danger' }) {
  return <span className={`fw-status fw-status--${tone}`}>{children}</span>;
}

export function Row({ label, value, prominent, onClick, hint }: {
  label: ReactNode; value: ReactNode; prominent?: boolean; onClick?: () => void; hint?: ReactNode;
}) {
  const content = <><span className="fw-row-label">{label}{hint && <small>{hint}</small>}</span><span className="fw-row-value">{value}{onClick && <ArrowUpLeft size={15} aria-hidden />}</span></>;
  return onClick
    ? <button type="button" className={`fw-row fw-row--button${prominent ? ' fw-row--prominent' : ''}`} onClick={onClick}>{content}</button>
    : <div className={`fw-row${prominent ? ' fw-row--prominent' : ''}`}>{content}</div>;
}

/**
 * Native modal semantics supply focus containment and Escape on every sheet, and focus goes back to what opened it.
 * `side` (redesign step 4): a 440 px panel from the inline end instead of a centred sheet — the figure drawer; on a
 * phone every sheet is the full screen. Two can be open at once (an order over the drawer): each returns focus as it closes.
 */
export function Sheet({ title, subtitle, children, footer, onClose, wide = true, side = false }: {
  title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean; side?: boolean;
}) {
  const { dir, loc } = useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    el.showModal();
    const cancel = (event: Event) => { event.preventDefault(); close.current(); };
    el.addEventListener('cancel', cancel);
    return () => {
      el.removeEventListener('cancel', cancel);
      el.close();
      document.body.style.overflow = previousOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  if (typeof document === 'undefined') return null;
  return createPortal(<dialog ref={dialog} className={`fw fw-sheet${side ? ' fw-sheet--side' : wide ? ' fw-sheet--wide' : ''}`} dir={dir}
    aria-labelledby={titleId} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="fw-sheet-panel">
      <header className="fw-sheet-heading"><div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <Button variant="ghost" className="fw-icon-button" onClick={onClose} aria-label={loc('إغلاق', 'Close', 'داخستن')}><X size={21} /></Button>
      </header>
      <div className="fw-sheet-content">{children}</div>
      {footer && <footer className="fw-sheet-footer">{footer}</footer>}
    </div>
  </dialog>, document.body);
}

/**
 * A CARD THAT OPENS ON A CLICK ANYWHERE ON IT, ITS FIGURES STILL SELECTABLE (the second review of step 4). The button on the
 * card's label is its control, for the keyboard and a screen reader; a pointer's click anywhere else on the card does the same —
 * unless the click ends a selection (the owner copies a figure) or lands on a control of its own (the label's button has already
 * opened it). A stretched overlay did this before: it covered the figures, so none could be selected, and the comparison raised
 * above it no longer opened the card. The card's own button takes the focus first, so the drawer gives it back there when it
 * closes, as when the button itself was pressed. `selected`: the page's selection (a test passes its own).
 *
 * A DOUBLE CLICK SELECTS, IT NEVER OPENS (the third review of step 4): a pointer's click waits out a double click
 * (DOUBLE_CLICK_MS) before it opens, and opens nothing if a second click came — or the word under it got selected — in the
 * meantime. Opening on the first click flashed the drawer (the second click fell on its backdrop and closed it), or opened an
 * order sheet over it, or Reports → Orders' first order under «الطلبات المستلمة», and the figure was never selected. A click
 * with no pointer (`detail` 0: a script's) opens at once; the label's button stays immediate, its own control. `later`: when the
 * wait ends (a test runs it by hand).
 *
 * THE OWNER WHO MOVED ON GETS NOTHING (the fourth review of step 4): a card no longer on the page when the wait ends — the owner went
 * to another page within it, which hides the overview or takes it away — opens nothing, so no drawer opens over the page he went to.
 * Another period or currency leaves the card on screen: FinanceWorkspace drops an open asked on another read (openOn).
 */
type Focusable = { focus?: () => void } | null;
export const DOUBLE_CLICK_MS = 300;
type Later = (run: () => void) => () => void;
const afterDoubleClick: Later = (run) => { const timer = setTimeout(run, DOUBLE_CLICK_MS); return () => clearTimeout(timer); };
const pageSelection = () => (typeof window === 'undefined' ? '' : window.getSelection?.()?.toString() ?? '');
type Card = { querySelector?: (selector: string) => Focusable; isConnected?: boolean; getClientRects?: () => { length: number } } | null | undefined;
/** Gone from the page, or drawn nowhere (a hidden page: `display:none` leaves an element no box). */
const goneOrHidden = (card: Card) => card?.isConnected === false || card?.getClientRects?.().length === 0;
export function cardClick(open: () => void, selected: () => string = pageSelection, later: Later = afterDoubleClick) {
  let pending: (() => void) | null = null;
  return (e: { target: EventTarget | null; currentTarget?: EventTarget | null; detail?: number }) => {
    const target = e.target as { closest?: (selector: string) => unknown } | null;
    if (target?.closest?.('button, a, input, select, textarea, summary, label')) return;
    // The second click of a double click: the word under it is being selected — the first click's open is called off.
    if ((e.detail ?? 0) > 1) { pending?.(); pending = null; return; }
    if (selected()) return;
    // React empties the event's currentTarget once its handlers ran: the card is read now, for the wait.
    const card = e.currentTarget as Card;
    const go = () => { pending = null; if (selected() || goneOrHidden(card)) return; card?.querySelector?.('button')?.focus?.(); open(); };
    pending?.();
    if (!e.detail) { pending = null; go(); return; }
    pending = later(go);
  };
}

/** A phone-width screen (the stylesheet's 600 px), followed as it changes; wide when rendered without a window. */
export function useNarrow() {
  const query = typeof window === 'undefined' || !window.matchMedia ? null : window.matchMedia('(max-width: 600px)');
  const [narrow, setNarrow] = useState(() => !!query?.matches);
  useEffect(() => {
    if (!query) return;
    const update = () => setNarrow(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [query?.media]); // eslint-disable-line react-hooks/exhaustive-deps
  return narrow;
}

export function Loading({ text }: { text: string }) {
  return <div className="fw-loading" role="status"><LoaderCircle size={20} className="fw-spinner" aria-hidden />{text}</div>;
}
