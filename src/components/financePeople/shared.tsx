import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, RefreshCw, Search, X } from 'lucide-react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Button, IconButton } from '../ui/Button';
import { Field, Input } from '../ui/Field';
import { Overlay } from '../ui/Overlay';
import '../adminProducts/theme.css';
import './people.css';

export { api, Button, Field, Input, useLanguage };
export const PEOPLE = '/api/admin/finance-people';
export const EARNINGS = '/api/finance-earnings';
export type PanelProps = { month?: string; from?: string; to?: string; onChanged?: () => void };
export type Account = { id: string; name: string; email: string; role: string; admin_scope?: string };
export type Withdrawal = {
  id: string; amount_iqd: number; paid_iqd: number; state: string; created_at: string;
  balance_type?: 'earnings' | 'capital' | 'all'; reference?: string; receipt_url?: string; user_name?: string; email?: string; note?: string;
};

export function useRemote<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const mine = ++generation.current;
    setLoading(true); setError('');
    try { const value = await api.get<T>(path, { mascot: 'silent' }); if (mine === generation.current) setData(value); }
    catch (e) { if (mine === generation.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (mine === generation.current) setLoading(false); }
  }, [path]);
  useEffect(() => {
    void load();
    // This numeric request generation deliberately invalidates an in-flight read.
    return () => { generation.current += 1; };
  }, [load]);
  return { data, error, loading, load };
}

export function useMutation() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const lock = useRef(false);
  const run = async (fn: () => Promise<void>, message?: string | (() => string)) => {
    if (lock.current) return false;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await fn(); setNotice(typeof message === 'function' ? message() : message ?? ''); return true; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
    finally { lock.current = false; setBusy(false); }
  };
  return { busy, error, notice, run, clear: () => { setError(''); setNotice(''); } };
}

export function Money({ value, className = '' }: { value: number | null | undefined; className?: string }) {
  const { loc } = useLanguage();
  return <span className={`fp-money ${className}`}><bdi>{value == null ? '—' : value.toLocaleString('en-US')}</bdi>{value != null && <small>{loc('د.ع', 'IQD')}</small>}</span>;
}
export function Feedback({ error, notice }: { error?: string; notice?: string }) {
  return <>{error && <p className="fp-feedback fp-error" role="alert">{error}</p>}{notice && <p className="fp-feedback fp-success" role="status"><Check size={16} aria-hidden="true" />{notice}</p>}</>;
}
export function Surface({ title, hint, action, children, className = '' }: { title?: string; hint?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`fp-surface ${className}`}>{(title || action) && <header className="fp-heading"><div>{title && <h3>{title}</h3>}{hint && <p>{hint}</p>}</div>{action}</header>}{children}</section>;
}
export function Empty({ children }: { children: ReactNode }) { return <p className="fp-empty">{children}</p>; }
export function Loading({ error, retry }: { error?: string; retry: () => Promise<unknown> }) {
  const { loc } = useLanguage();
  return <div className="fp-empty" role={error ? 'alert' : 'status'}>{error || loc('جارٍ تحميل الحسابات…', 'Loading accounts…')}{error && <Button className="mt-3" icon={<RefreshCw size={15} />} onClick={retry}>{loc('إعادة المحاولة', 'Try again')}</Button>}</div>;
}
export function Dialog({ open, onClose, title, children, dirty = false, busy = false }: { open: boolean; onClose: () => void; title: string; children: ReactNode; dirty?: boolean; busy?: boolean }) {
  const { loc, dir } = useLanguage();
  return <Overlay open={open} onClose={onClose} label={title} placement="bottom" dirty={dirty} dismissOnScrim={!busy} dismissOnEscape={!busy} panelClassName="ap fp fp-dialog" solid>
    <div dir={dir}><header className="fp-dialog-heading"><h2>{title}</h2><IconButton label={loc('إغلاق', 'Close')} icon={<X size={18} />} onClick={onClose} disabled={busy} /></header>{children}</div>
  </Overlay>;
}
export function StateBadge({ state }: { state: string }) {
  const { loc } = useLanguage();
  const names: Record<string, [string, string]> = { requested: ['بانتظار الاعتماد', 'Requested'], approved: ['معتمد للتسديد', 'Approved'], part_paid: ['مسدد جزئيًا', 'Partly paid'], paid: ['تم التسديد', 'Paid'], rejected: ['مرفوض', 'Rejected'], cancelled: ['ملغى', 'Cancelled'], available: ['متاح', 'Available'], pending: ['قيد الاستحقاق', 'Pending'], pending_cost: ['بانتظار تثبيت التكلفة', 'Awaiting final cost'], pending_reconciliation: ['بانتظار التسوية', 'Awaiting reconciliation'], due: ['مستحق', 'Due'] };
  return <span className={`fp-status fp-status-${state}`}>{names[state] ? loc(...names[state]) : state}</span>;
}
export function dateLabel(value: string, lang: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(lang === 'en' ? 'en-GB' : 'ar-IQ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Baghdad' });
}
export function AccountPicker({ value, onChange }: { value: Account | null; onChange: (v: Account | null) => void }) {
  const { loc } = useLanguage();
  const [term, setTerm] = useState(''), [rows, setRows] = useState<Account[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (value) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true); setError('');
      api.get<{ accounts: Account[] }>(`${PEOPLE}/accounts?q=${encodeURIComponent(term.trim())}`, { signal: controller.signal, mascot: 'silent' })
        .then((r) => { if (!controller.signal.aborted) setRows(r.accounts); })
        .catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [term, value]);
  if (value) return <div className="fp-account"><div className="fp-avatar" aria-hidden="true">{value.name?.slice(0, 1) || '@'}</div><div className="min-w-0 flex-1"><strong>{value.name || value.email}</strong><p dir="ltr">{value.email}</p></div><Button variant="ghost" onClick={() => onChange(null)}>{loc('تغيير', 'Change')}</Button></div>;
  return <div className="fp-stack"><Field label={loc('ابحث عن الحساب', 'Find an account')}><div className="relative"><Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder={loc('الاسم أو البريد الإلكتروني', 'Name or email')} className="ps-10" /><Search size={17} className="absolute start-3 top-3.5" aria-hidden="true" /></div></Field><Feedback error={error} />
    <div className="fp-picker-list" aria-label={loc('الحسابات', 'Accounts')}>{loading ? <Empty>{loc('جارٍ البحث…', 'Searching…')}</Empty> : rows.length === 0 ? <Empty>{loc('لم نجد حسابًا. جرّب اسمًا آخر.', 'No account found. Try another name.')}</Empty> : rows.map((a) => <button type="button" className="fp-account fp-account-choice" key={a.id} onClick={() => onChange(a)}><span className="fp-avatar" aria-hidden="true">{a.name?.slice(0, 1) || '@'}</span><span className="min-w-0"><strong>{a.name || a.email}</strong><span className="fp-muted block truncate" dir="ltr">{a.email}</span></span><span className="fp-status ms-auto">{a.role === 'admin' ? loc('إدارة', 'Admin') : loc('مستخدم', 'User')}</span></button>)}</div>
  </div>;
}
