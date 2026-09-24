/**
 * COUNTDOWN — to a moment the merchant set. It hides itself the second that
 * moment passes: no timer that loops, restarts or runs negative.
 */
import { useEffect, useState } from 'react';
import { useLanguage } from '../../../LanguageContext';
import { useStoreTheme } from '../StoreTheme';
import { Column, hasLink, LinkTo, useText } from '../parts';
import type { BlockProps } from '../types';

function remaining(target: number, now: number) {
  const s = Math.max(0, Math.floor((target - now) / 1000));
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60, done: s <= 0 };
}

export default function CountdownBlock({ block, data }: BlockProps<'countdown'>) {
  const s = block.settings;
  const { loc } = useLanguage();
  const text = useText();
  const { accent } = useStoreTheme();
  const target = s.ends_at ? Date.parse(s.ends_at) : NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!Number.isFinite(target)) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [target]);
  if (!Number.isFinite(target)) return null;
  const r = remaining(target, now);
  if (r.done) return null;
  const cta = text(s.cta_label);
  const units: Array<[number, string]> = [
    [r.d, loc('يوم', 'days')],
    [r.h, loc('ساعة', 'hours')],
    [r.m, loc('دقيقة', 'min')],
    [r.s, loc('ثانية', 'sec')],
  ];
  return (
    <Column>
      <div className={block.variant === 'card' ? 'sf-card sf-card-pad text-center' : 'text-center'}>
        {text(s.title) && (
          <p className="text-white text-[14px] font-bold mb-2.5" dir="auto">
            {text(s.title)}
          </p>
        )}
        {/* In the page's direction: days first, where the reader starts. */}
        <div className="flex justify-center gap-2" role="timer" aria-live="off">
          {units.map(([v, label]) => (
            <div key={label} className="min-w-[58px] sf-row px-2 py-1.5">
              <div className="text-white font-bold text-[18px] tabular-nums leading-tight">{String(v).padStart(2, '0')}</div>
              <div className="text-zinc-500 text-[10.5px]">{label}</div>
            </div>
          ))}
        </div>
        {cta && hasLink(s.link, data) && (
          <LinkTo link={s.link} data={data} className={`inline-flex items-center min-h-[44px] px-5 mt-3 rounded-xl font-bold text-[13px] ${accent.btn}`}>
            {cta}
          </LinkTo>
        )}
      </div>
      {/* OWNER: Sorani to be written by hand. */}
    </Column>
  );
}
