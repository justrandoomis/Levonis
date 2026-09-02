/**
 * The tinted stat cards + sparkline used by the products-management screens
 * (merchant dashboard and platform admin). Every curve these draw must be a
 * REAL series — fewer than two points renders a flat baseline, an honest
 * "no history yet", never an invented shape.
 */

export function Spark({ series, className }: { series: number[]; className: string }) {
  const pts = series.length >= 2 ? series : [0, 0];
  const max = Math.max(...pts, 1);
  const step = 100 / (pts.length - 1);
  const path = pts.map((v, i) => `${(i * step).toFixed(1)},${(26 - (v / max) * 22).toFixed(1)}`).join(' ');
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className={`w-full h-7 ${className}`} aria-hidden>
      <polyline points={path} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export const TINTS: Record<string, { box: string; icon: string; spark: string }> = {
  purple: { box: 'border-purple-500/20 bg-purple-500/[0.06]', icon: 'bg-purple-500/15 text-purple-300', spark: 'text-purple-400/80' },
  blue: { box: 'border-sky-500/20 bg-sky-500/[0.06]', icon: 'bg-sky-500/15 text-sky-300', spark: 'text-sky-400/80' },
  green: { box: 'border-emerald-500/25 bg-emerald-500/[0.08]', icon: 'bg-emerald-500/15 text-emerald-300', spark: 'text-emerald-400/80' },
  amber: { box: 'border-amber-500/25 bg-amber-500/[0.07]', icon: 'bg-amber-500/15 text-amber-300', spark: 'text-amber-400/80' },
  red: { box: 'border-red-500/25 bg-red-500/[0.07]', icon: 'bg-red-500/15 text-red-300', spark: 'text-red-400/80' },
};

export function StatCard({
  tint, icon, label, value, sub, series,
}: {
  tint: keyof typeof TINTS;
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  series: number[];
}) {
  const t = TINTS[tint];
  return (
    <div className={`rounded-xl border p-2.5 min-w-0 ${t.box}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 ${t.icon}`}>{icon}</span>
        <span className="text-zinc-400 text-[10.5px] font-semibold truncate">{label}</span>
      </div>
      <div className="text-white font-bold text-[19px] leading-tight"><span dir="ltr">{value}</span></div>
      <div className="text-zinc-500 text-[10px] truncate mb-1">{sub}</div>
      <Spark series={series} className={t.spark} />
    </div>
  );
}
