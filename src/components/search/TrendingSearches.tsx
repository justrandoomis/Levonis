// Lucian UX/UI Prompt #322 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#322
import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Pause, Play } from 'lucide-react';
import { api } from '../../lib/api';
import { useMediaQuery } from '../../lib/useMediaQuery';
import MotionCollection from '../motion/MotionCollection';
import { useLanguage } from '../../LanguageContext';
import './trendingSearches.css';

type Trend = { id: string; term: string; rank: number; previous_rank: number | null };
type Answer = { items: Trend[]; updated_at?: string };

export default function TrendingSearches({ onChoose }: { onChoose: (term: string) => void }) {
  const { loc } = useLanguage();
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [items, setItems] = useState<Trend[]>([]);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  const [foreground, setForeground] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    if (root.current) observer.observe(root.current);
    const onVisibility = () => setForeground(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);
  useEffect(() => {
    if (!visible || !foreground) return;
    const controller = new AbortController();
    const refresh = () => api.get<Answer>('/api/search/trending', { signal: controller.signal, mascot: 'silent' })
      .then((data) => { if (!controller.signal.aborted) setItems(data.items.slice(0, 10)); }).catch(() => {});
    void refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [visible, foreground]);
  useEffect(() => {
    if (reduced || paused || focused || open || !visible || !foreground || items.length < 2) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % items.length), 2000);
    return () => clearInterval(timer);
  }, [reduced, paused, focused, open, visible, foreground, items.length]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const change = (item: Trend) => item.previous_rank === null ? loc('جديد', 'NEW', 'نوێ') : item.previous_rank === item.rank ? '–' : `${item.previous_rank > item.rank ? '▲' : '▼'}${Math.abs(item.previous_rank - item.rank)}`;
  const current = items[index % Math.max(items.length, 1)];
  return <div className="u322" ref={root} onFocus={() => setFocused(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { setFocused(false); setOpen(false); } }} onPointerEnter={() => setFocused(true)} onPointerLeave={() => setFocused(root.current?.contains(document.activeElement) ?? false)} onKeyDown={(e) => {
    if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    {current && <>
      <div className="u322-head">
        <button type="button" ref={trigger} className="u322-tk" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((value) => !value)}>
          <small>{loc('الرائج في البحث', 'Trending in search', 'باو لە گەڕان')}</small>
          <span className="u322-roll" aria-live="off"><span className="u322-line" key={current.id}><b>{current.rank}</b><span>{current.term}</span><em>{change(current)}</em></span></span>
          <ChevronDown size={14} aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
        </button>
        {!reduced && items.length > 1 && <button type="button" className="u322-pause" aria-label={paused ? loc('تشغيل التدوير', 'Resume rotation', 'بەردەوامبوون') : loc('إيقاف التدوير', 'Pause rotation', 'ڕاگرتن')} aria-pressed={paused} onClick={() => setPaused((value) => !value)}>{paused ? <Play size={13} /> : <Pause size={13} />}</button>}
      </div>
      {open && <div className="u322-panel" id={id}>
        <p>{loc('الأكثر اختياراً من البحث اليوم · التغيّر مقارنة بالأمس', 'Most selected from search today · change versus yesterday', 'زۆرترین هەڵبژێردراو لە گەڕانی ئەمڕۆ · بەراورد بە دوێنێ')}</p>
        <MotionCollection version={items.map((i) => i.id).join(',')}><ol>
          {items.map((item) => <li key={item.id} data-motion-key={item.id}><button type="button" onClick={() => { setOpen(false); onChoose(item.term); }}><b>{item.rank}</b><span>{item.term}</span><em>{change(item)}</em></button></li>)}
        </ol></MotionCollection>
      </div>}
    </>}
  </div>;
}
