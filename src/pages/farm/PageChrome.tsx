import React, { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

export function GamesPage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-black text-white pb-24">
      <div className="max-w-3xl mx-auto px-4 py-6">
        {children}
      </div>
    </div>
  );
}

export function GamesHeader({
  title,
  back,
  rightAction,
}: {
  title: string;
  back?: string;
  rightAction?: ReactNode;
}) {
  const navigate = useNavigate();
  const { dir } = useLanguage();
  const BackIcon = dir === 'rtl' ? ArrowRight : ArrowLeft;

  return (
    <header className="flex items-center justify-between gap-4 mb-6">
      <div className="flex items-center gap-3">
        {back && (
          <button
            type="button"
            onClick={() => navigate(-1)}
            aria-label={back}
            className="p-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors"
          >
            <BackIcon className="w-5 h-5" />
          </button>
        )}
        <h1 className="text-xl font-black text-white">{title}</h1>
      </div>
      {rightAction && <div>{rightAction}</div>}
    </header>
  );
}

export function GamesBody({ children }: { children: ReactNode }) {
  return <main className="flex flex-col gap-6">{children}</main>;
}
