/**
 * The Command Center's figures, from GET /api/merchant/analytics/report — the
 * server's own daily series, sliced, never re-counted from anything else.
 *
 * NO INVENTED FIGURE (dataviz rules, the report's own contract):
 *   · «today» is the last day of the report's range (the server's Baghdad day);
 *   · a week-on-week change exists only when the series really holds the
 *     previous seven days — otherwise there is no delta, not a «+100%»;
 *   · the change is shown as a signed count / amount, never a percentage of a
 *     zero week;
 *   · visitors appear only when traffic was being counted for the WHOLE week
 *     (the report leaves traffic out, or starts it at `counted_from`): a
 *     half-counted week would read as a drop that never happened;
 *   · a trend line is drawn only when the fortnight has a sale in it — a flat
 *     line of zeros says nothing a «0» does not.
 */
export interface ReportLike {
  range: { from: string; to: string };
  orders: { series: Array<{ day: string; orders: number; gross_iqd: number }> };
  traffic?: { counted_from: string; series: Array<{ day: string; visitors: number }> };
}

export interface CommandKpis {
  today: { orders: number; gross_iqd: number };
  week: {
    orders: number;
    gross_iqd: number;
    /** The seven days before — absent when the series does not reach back that far. */
    previous?: { orders: number; gross_iqd: number };
    /** Daily orders over the last 14 days (or fewer), oldest first — absent when all zero. */
    trend?: number[];
  };
  /** Visitors over the same seven days — absent unless all seven were counted. */
  visitors7?: number;
}

export function commandKpis(r: ReportLike): CommandKpis | null {
  const s = r.orders?.series ?? [];
  if (!s.length) return null;
  const today = s[s.length - 1];
  const last7 = s.slice(-7);
  const prev7 = s.length >= 14 ? s.slice(-14, -7) : null;
  const sum = (rows: typeof s, k: 'orders' | 'gross_iqd') => rows.reduce((a, x) => a + (Number(x[k]) || 0), 0);
  const fortnight = s.slice(-14).map((x) => Number(x.orders) || 0);
  const out: CommandKpis = {
    today: { orders: Number(today.orders) || 0, gross_iqd: Number(today.gross_iqd) || 0 },
    week: {
      orders: sum(last7, 'orders'),
      gross_iqd: sum(last7, 'gross_iqd'),
      ...(prev7 && prev7.length === 7 ? { previous: { orders: sum(prev7, 'orders'), gross_iqd: sum(prev7, 'gross_iqd') } } : {}),
      ...(fortnight.length >= 2 && fortnight.some((v) => v > 0) ? { trend: fortnight } : {}),
    },
  };
  const weekStart = last7[0]?.day;
  if (r.traffic && weekStart && r.traffic.counted_from <= weekStart && last7.length === 7) {
    const counted = r.traffic.series.filter((d) => d.day >= weekStart);
    if (counted.length === 7) out.visitors7 = counted.reduce((a, d) => a + (Number(d.visitors) || 0), 0);
  }
  return out;
}
