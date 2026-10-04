import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
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

/** Native modal semantics supply focus containment and Escape on every sheet. */
export function Sheet({ title, subtitle, children, footer, onClose, wide = true }: {
  title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean;
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
  return createPortal(<dialog ref={dialog} className={`fw fw-sheet${wide ? ' fw-sheet--wide' : ''}`} dir={dir}
    aria-labelledby={titleId} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="fw-sheet-panel">
      <header className="fw-sheet-heading"><div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <Button variant="ghost" className="fw-icon-button" onClick={onClose} aria-label={loc('إغلاق', 'Close')}><X size={21} /></Button>
      </header>
      <div className="fw-sheet-content">{children}</div>
      {footer && <footer className="fw-sheet-footer">{footer}</footer>}
    </div>
  </dialog>, document.body);
}

export function Loading({ text }: { text: string }) {
  return <div className="fw-loading" role="status"><LoaderCircle size={20} className="fw-spinner" aria-hidden />{text}</div>;
}
