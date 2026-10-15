/**
 * THE OWNER'S VALUATION RECORD of one request (spec §6.13; GET /requests/:id/valuation, cost_read):
 * each computation (at submit, at intake, an override, the cut-over) with its offer, ceiling, store
 * cap and expected margin, and per part today's public price, what was actually paid, the base,
 * the condition, the expected resale, the costs, the margin, the store cap and the highest offer
 * allowed; then the stock the device became — its lot, its cost and the hidden used draft.
 *
 * Its own lazy chunk, mounted for the verified owner only; the server refuses everyone else with
 * COST_ACCESS_DENIED (the same body for a real and an invented id). Nothing here is cached.
 */
import React, { useEffect, useState } from 'react';
import { ExternalLink, Lock } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { api } from '../../lib/api';
import { apiRefusal, refusalLang } from '../../lib/refusalStrings';
import { dateText } from '../tradeIn/model';
import { useA } from './useA';
import type { AdminKey } from './copy';

interface ComponentLine {
  role: string;
  family: string;
  now_iqd?: number;
  paid_iqd?: number;
  base_iqd?: number;
  q_bp?: number;
  cond_iqd?: number;
  resale_iqd?: number;
  costs_iqd?: number;
  margin_iqd?: number;
  store_cap_iqd?: number;
  max_offer_iqd?: number;
  offer_iqd?: number;
}
interface Valuation {
  phase: string;
  offer: number | null;
  ceiling: number | null;
  store_cap: number | null;
  expected_margin: number | null;
  components: ComponentLine[];
  created_at: string;
}
interface Answer {
  valuations: Valuation[];
  stock: { lot_id: string; draft_product_id: string; cost_basis_iqd: number; order_id: string; booked_at: string } | null;
}

export default function OwnerValuationPanel({ requestId }: { requestId: string }) {
  const { a, money, lang } = useA();
  const [data, setData] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    api
      .get<Answer>(`/api/admin/trade-in/requests/${encodeURIComponent(requestId)}/valuation`)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(apiRefusal(e, refusalLang(lang), a('loadError'))));
    return () => {
      alive = false;
    };
  }, [requestId, lang, a]);

  const rows: Array<[AdminKey, keyof ComponentLine, 'money' | 'pct']> = [
    ['owner.todayPrice', 'now_iqd', 'money'],
    ['owner.paid', 'paid_iqd', 'money'],
    ['owner.base', 'base_iqd', 'money'],
    ['owner.quality', 'q_bp', 'pct'],
    ['owner.cond', 'cond_iqd', 'money'],
    ['owner.resale', 'resale_iqd', 'money'],
    ['owner.costs', 'costs_iqd', 'money'],
    ['owner.margin', 'margin_iqd', 'money'],
    ['owner.storeCap', 'store_cap_iqd', 'money'],
    ['owner.maxOffer', 'max_offer_iqd', 'money'],
    ['owner.offer', 'offer_iqd', 'money'],
  ];

  return (
    <section className={`${T.surface} space-y-3 p-4`} data-owner-valuation aria-labelledby="ti-owner-title">
      <h3 id="ti-owner-title" className="flex items-center gap-1.5 text-[14px] font-bold">
        <Lock className="h-4 w-4 text-[var(--ap-accent-text)]" aria-hidden />
        {a('owner.title')}
      </h3>
      {error ? <p className="text-[12.5px] text-[var(--ap-danger)]">{error}</p> : null}
      {!data && !error ? <p className={`text-[12.5px] ${T.text3}`}>{a('loading')}</p> : null}
      {data && data.valuations.length === 0 ? <p className={`text-[12.5px] ${T.text3}`}>{a('owner.none')}</p> : null}
      {data?.valuations.map((v, i) => (
        <div key={`${v.phase}-${v.created_at}-${i}`} className="space-y-2 rounded-[var(--ap-radius-md)] bg-[var(--ap-surface-2)] p-3" data-valuation={v.phase}>
          <p className="flex flex-wrap items-baseline justify-between gap-2 text-[12.5px]">
            <span className="font-semibold">{a(`phase.${v.phase}` as AdminKey)}</span>
            <span className={`${T.text3} tabular-nums`}>{dateText(v.created_at, lang)}</span>
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px] sm:grid-cols-4">
            {(
              [
                ['owner.offer', v.offer],
                ['owner.ceiling', v.ceiling],
                ['owner.storeCap', v.store_cap],
                ['owner.expectedMargin', v.expected_margin],
              ] as Array<[AdminKey, number | null]>
            ).map(([k, n]) => (
              <div key={k} className="min-w-0">
                <dt className={T.text3}>{a(k)}</dt>
                <dd className="font-semibold tabular-nums">{money(n)}</dd>
              </div>
            ))}
          </dl>
          {Array.isArray(v.components) && v.components.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-[12px]">
                <thead>
                  <tr className={T.text3}>
                    <th className="py-1 text-start font-medium" scope="col" />
                    {v.components.map((c) => (
                      <th key={c.role} className="py-1 text-end font-medium" scope="col">
                        {a(c.role === 'ams' ? 'part.ams' : 'part.device')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([label, key, kind]) => (
                    <tr key={key} className="border-t border-[var(--ap-hairline)]">
                      <th className="py-1 text-start font-normal" scope="row">
                        {a(label)}
                      </th>
                      {v.components.map((c) => {
                        const n = c[key] as number | undefined;
                        return (
                          <td key={c.role} className="py-1 text-end tabular-nums" dir="ltr">
                            {n === undefined ? '—' : kind === 'pct' ? `${(n / 100).toFixed(1)}%` : money(n)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ))}
      {data?.stock ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px]" data-owner-stock>
          <div>
            <dt className={T.text3}>{a('owner.stockCost')}</dt>
            <dd className="font-semibold tabular-nums">{money(data.stock.cost_basis_iqd)}</dd>
          </div>
          <div>
            <dt className={T.text3}>{a('owner.lot')}</dt>
            <dd className="font-mono text-[11.5px]" dir="ltr">
              {data.stock.lot_id}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className={T.text3}>{a('owner.draft')}</dt>
            <dd>
              <a
                className="inline-flex items-center gap-1 underline decoration-dotted"
                href={`/admin?tab=products&edit=${encodeURIComponent(data.stock.draft_product_id)}`}
                data-owner-draft
              >
                {a('owner.openDraft')} <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            </dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}
