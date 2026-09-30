/**
 * «كيف ظهرت الصفحة لزوارك» — how one vital's real readings fell into the
 * three Web Vitals bands (merchant platform v2 workspace §3.7, storefront
 * §3.9): three rows, each the band's WORD in its tone, a bar whose width is
 * the band's share, and the share in figures. The word carries the meaning —
 * the tone and the bar only repeat it — so it reads in greyscale and aloud.
 *
 * The bar is `h-2 rounded-full` on the `bg-surface-selected` track, filled in
 * the one accent. The width is inline (a share is data, not a class); the
 * fill grows from the inline start with the `ui` spring, and under reduced
 * motion it is simply there.
 */
import * as Motion from 'motion/react-m';
import { useLanguage } from '../../../../LanguageContext';
import { formatPercent } from '../../../../lib/localeNumber';
import { useMotion } from '../../../../lib/motion';
import { MotionFeatures } from '../../../../lib/motionFeatures';
import { fillSpeed, useSpeedStrings } from '../strings';
import type { Bucket, BucketCounts } from './api';

export const BUCKETS: readonly Bucket[] = ['good', 'ok', 'poor'];

/** A band's word colour — always beside the word, never instead of it. */
export const BUCKET_TEXT: Readonly<Record<Bucket, string>> = { good: 'text-success', ok: 'text-warning', poor: 'text-danger' };

/**
 * Whole percentages of the readings in each band that always add up to 100
 * (largest remainder, ties to the better band), or null with no readings —
 * «0٪ · 0٪ · 0٪» would be a claim about visits that never happened.
 */
export function bandShares(c: BucketCounts): Record<Bucket, number> | null {
  const counts = BUCKETS.map((b) => Math.max(0, Number(c?.[b]) || 0));
  const total = counts.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  const exact = counts.map((n) => (n / total) * 100);
  const whole = exact.map((v) => Math.floor(v));
  let left = 100 - whole.reduce((a, b) => a + b, 0);
  const byRemainder = exact.map((v, i) => ({ i, r: v - whole[i] })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of byRemainder) {
    if (left <= 0) break;
    whole[i] += 1;
    left -= 1;
  }
  return { good: whole[0], ok: whole[1], poor: whole[2] };
}

export default function DistributionBar({ counts, title }: { counts: BucketCounts; title: string }) {
  const s = useSpeedStrings();
  const { lang } = useLanguage();
  const m = useMotion();
  const shares = bandShares(counts);
  if (!shares) return null;
  return (
    <section aria-label={title} data-speed-spread className="lv-surface p-4">
      <h3 className="text-[13px] font-bold text-text-primary">{title}</h3>
      <MotionFeatures>
        <ul className="mt-3 space-y-2.5">
          {BUCKETS.map((b) => {
            const pct = formatPercent(shares[b], lang, 0);
            return (
              <li key={b} data-speed-band={b} className="grid items-center gap-3" style={{ gridTemplateColumns: '5.5rem minmax(0, 1fr) 3rem' }}>
                <span className={`truncate text-[12.5px] font-semibold ${BUCKET_TEXT[b]}`}>{s.bucket[b]}</span>
                <div role="img" aria-label={fillSpeed(s.spread.share, { word: s.bucket[b], pct })} className="h-2 overflow-hidden rounded-full bg-surface-selected">
                  <Motion.div
                    data-speed-band-fill
                    className="h-full rounded-full bg-gold"
                    style={{ width: `${shares[b]}%`, transformOrigin: m.dir === -1 ? 'right' : 'left' }}
                    initial={m.reduced ? false : { scaleX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={m.spring('ui')}
                  />
                </div>
                <bdi className="text-end text-[12px] tabular-nums text-text-secondary">{pct}</bdi>
              </li>
            );
          })}
        </ul>
      </MotionFeatures>
    </section>
  );
}
