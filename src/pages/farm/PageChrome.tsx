/**
 * The header every games page shares: translucent chrome, a history-aware
 * back button (a deep link or a refresh has nothing to go back to, so it falls
 * back to the route the caller names), a title and an optional trailing slot.
 * The pages own their scroll container — the full-screen shell around
 * /games/* is overflow-hidden.
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { FOCUS } from './ui';

export function useGoBack(fallback: string): () => void {
  const navigate = useNavigate();
  return () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(fallback);
  };
}

export function GamesHeader({
  title,
  backLabel,
  fallback,
  children,
  trailing,
}: {
  title: React.ReactNode;
  backLabel: string;
  fallback: string;
  /** Rendered under the title (a second line). */
  children?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  const { dir } = useLanguage();
  const goBack = useGoBack(fallback);
  return (
    <header className="shrink-0 z-40 material material-thin px-3 py-2 flex items-center gap-3 border-b border-white/5" data-games-header>
      <button type="button" onClick={goBack} aria-label={backLabel} className={`p-2 min-w-[44px] min-h-[44px] inline-flex items-center justify-center bg-zinc-900/80 rounded-full hover:bg-zinc-800 transition-colors ${FOCUS}`}>
        {dir === 'rtl' ? <ArrowRight aria-hidden="true" className="w-5 h-5" /> : <ArrowLeft aria-hidden="true" className="w-5 h-5" />}
      </button>
      <div className="min-w-0 flex-1">
        <h1 className="text-white font-bold text-[16px] leading-5 truncate">{title}</h1>
        {children}
      </div>
      {trailing}
    </header>
  );
}

/** The dark page frame: fills the full-screen shell and owns its own scroll. */
export function GamesPage({ dir, children, testId }: { dir: 'ltr' | 'rtl'; children: React.ReactNode; testId?: string }) {
  return (
    <div dir={dir} className="w-full flex-1 min-h-0 flex flex-col bg-[#0a0a0a] text-zinc-300 overflow-hidden" data-games-page={testId ?? true}>
      {children}
    </div>
  );
}

export function GamesBody({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] space-y-5 max-w-2xl mx-auto">{children}</div>
    </div>
  );
}
