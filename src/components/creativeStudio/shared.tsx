/**
 * Small pieces every studio screen shares: the request hook with real
 * loading / failed / empty states, the error sentence by code, a media query,
 * a download, and the studio context (who is looking, what the provider and
 * the brand say). No studio screen invents its own version of any of these.
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError, isAborted } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import Spinner from '../ui/Spinner';
import { Button } from '../ui/Button';
import type { BrandDto, ProviderStatusDto } from '../../../packages/creativeDoc/src/api';
import { S, errorText, tx, type Lang, type Tri } from './strings';

export function useText(): { lang: Lang; dir: 'rtl' | 'ltr'; w: (entry: Tri) => string } {
  const { lang, dir } = useLanguage();
  return { lang, dir, w: useCallback((entry: Tri) => tx(entry, lang), [lang]) };
}

/** The sentence for any failure: the studio’s own words for a known code, else the server’s. */
export function failText(e: unknown, lang: Lang): string {
  if (e instanceof ApiError) return errorText(e.code, e.message || tx(S.retry, lang), lang);
  if (e instanceof Error && e.message) return e.message;
  return errorText('INVALID_RESPONSE', '', lang);
}

export function codeOf(e: unknown): string {
  return e instanceof ApiError ? e.code ?? '' : '';
}

export type Remote<T> =
  | { status: 'loading' }
  | { status: 'failed'; error: unknown }
  | { status: 'ready'; data: T };

/** Runs `load` on mount and when `deps` change; `reload()` runs it again. A stale answer never overwrites a newer one. */
export function useRemote<T>(load: () => Promise<T>, deps: readonly unknown[]): [Remote<T>, () => void, (next: T) => void] {
  const [state, setState] = useState<Remote<T>>({ status: 'loading' });
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const run = useCallback(() => {
    const mine = ++seq.current;
    setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    loadRef.current().then(
      (data) => { if (seq.current === mine) setState({ status: 'ready', data }); },
      (error: unknown) => { if (seq.current === mine && !isAborted(error)) setState({ status: 'failed', error }); },
    );
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(run, deps);
  const set = useCallback((data: T) => setState({ status: 'ready', data }), []);
  return [state, run, set];
}

/** Loading, failed (with the reason and a retry) or the content. */
export function RemoteView<T>({ remote, onRetry, children, compact = false }: { remote: Remote<T>; onRetry: () => void; children: (data: T) => React.ReactNode; compact?: boolean }) {
  const { lang, w } = useText();
  if (remote.status === 'loading') {
    return (
      <div className={`flex items-center justify-center gap-2 text-sm text-text-muted ${compact ? 'py-4' : 'py-12'}`} role="status">
        <Spinner size="sm" decorative />
        <span>{w(S.loading)}</span>
      </div>
    );
  }
  if (remote.status === 'failed') {
    return (
      <div className={`flex flex-col items-center gap-3 text-center ${compact ? 'py-4' : 'py-10'}`} role="alert">
        <p className="text-sm text-danger">{failText(remote.error, lang)}</p>
        <Button size="sm" onClick={onRetry}>{w(S.retry)}</Button>
      </div>
    );
  }
  return <>{children(remote.data)}</>;
}

export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/** Hands the reader a file. Nothing is uploaded by this. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

export function shortTime(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const locale = lang === 'en' ? 'en-GB' : lang === 'ckb' ? 'ckb-IQ' : 'ar-IQ';
  try {
    return d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short', numberingSystem: 'latn' } as Intl.DateTimeFormatOptions);
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

export interface StudioUser {
  /** The verified owner: provider key, model, budget, brand versions. */
  isOwner: boolean;
  /** Owner or full admin. Assistant admins never get here (the route and the server refuse). */
  canDesign: boolean;
}

export interface StudioContextValue {
  user: StudioUser;
  provider: ProviderStatusDto | null;
  brand: BrandDto | null;
  reloadProvider(): void;
  reloadBrand(): void;
  goTab(tab: StudioTab): void;
  openDocument(id: string): void;
  startNew(prefill?: NewDesignPrefill): void;
  /**
   * The open editor registers the question to ask before the studio leaves it
   * (another tab, «back to admin», a new design); returns the unregister. The
   * studio’s own, not src/lib/leaveGuard.ts: that one is the dashboard’s, and
   * importing it here split it into a chunk of its own.
   */
  setLeaveGuard(guard: () => boolean): () => void;
}

export type StudioTab = 'home' | 'new' | 'editor' | 'brand' | 'claims' | 'assets' | 'archive' | 'settings';

/** What «use this idea» carries into New design (screensModel.ideaPrefill): every field of the idea a design can use. */
export interface NewDesignPrefill {
  mode?: 'product' | 'service';
  productId?: string;
  /** Preselected once the approved claims are loaded. */
  claimId?: string;
  objective?: import('../../../packages/creativeDoc/src/schema').Objective;
  /** The idea's composition direction: its visual priority is preselected, so this variant leads. */
  variant?: import('../../../packages/creativeDoc/src/templates').VariantId;
  copy?: { headline: string; subhead?: string; cta?: string; features?: string[] };
  caption?: string;
  alt?: string;
  /** The ideas job: a design built from the idea's own words is recorded as Claude's (origin 'ai'). */
  jobId?: string;
}

export const StudioContext = createContext<StudioContextValue | null>(null);

export function useStudio(): StudioContextValue {
  const v = useContext(StudioContext);
  if (!v) throw new Error('useStudio outside the studio');
  return v;
}

/** Why AI is not ready, in words, with the way to Settings — manual work is never blocked by it. */
export function AiNotReady({ provider, onSettings }: { provider: ProviderStatusDto | null; onSettings: () => void }) {
  const { lang, w } = useText();
  const code = provider?.not_ready_code ?? (provider ? null : 'KEY_NOT_CONFIGURED');
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-3 text-sm" role="status" data-ai-not-ready={code ?? ''}>
      <p className="font-semibold text-text-primary">{w(S.aiNotReady)}</p>
      {code ? <p className="mt-1 text-text-secondary">{errorText(code, code, lang)}</p> : null}
      <p className="mt-1 text-text-muted">{w(S.aiManualStillWorks)}</p>
      <Button size="sm" variant="ghost" className="mt-2" onClick={onSettings}>{w(S.aiGoSettings)}</Button>
    </div>
  );
}
