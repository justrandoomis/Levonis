/**
 * «إعدادات الاستبدال» — THE OWNER'S SIDE OF THE DESK (spec §4.4, §6.11, §6.13, §10.3): how long
 * an offer and a credit hold, the collection fee, the hours tolerance and the serial rule (GET/PUT
 * /policy); the trade-in P&L of the last 30 days (GET /pnl); the component reference prices; and
 * the condition rules with the offer parameters of each family (RulesEditor).
 *
 * Every read here is a cost read — the server answers the verified owner only (COST_ACCESS_DENIED
 * for everyone else) — and the tab is not offered to anyone else. Nothing here is cached.
 */
import React, { useEffect, useState } from 'react';
import * as T from '../adminProducts/theme';
import { api } from '../../lib/api';
import { apiRefusal, refusalLang } from '../../lib/refusalStrings';
import { useA } from './useA';
import ComponentRefs from './ComponentRefs';
import RulesEditor from './RulesEditor';
import { PNL_COUNT, type AdminKey } from './copy';
import { countedText } from '../tradeIn/copy';

interface Policy {
  offer_valid_days: number;
  credit_valid_days: number;
  reissue_valid_days: number;
  pickup_fee_iqd: number;
  hours_tolerance_pct: number;
  hours_tolerance_abs: number;
  require_serial_match: boolean;
}
type PolicyNumber = Exclude<keyof Policy, 'require_serial_match' | 'reissue_valid_days'>;
interface Pnl {
  credits_fixed: { count: number; total_iqd: number };
  in_stock: { count: number; cost_iqd: number };
  resold: { count: number; revenue_iqd: number; cogs_iqd: number; margin_iqd: number };
  write_offs: { count: number; cost_iqd: number };
  above_ceiling: { count: number; over_iqd: number };
  reissued: { count: number; total_iqd: number };
}

const FIELDS: Array<[PolicyNumber, AdminKey]> = [
  ['offer_valid_days', 'p.offerDays'],
  ['credit_valid_days', 'p.creditDays'],
  ['pickup_fee_iqd', 'p.pickupFee'],
  ['hours_tolerance_pct', 'p.hoursTolPct'],
  ['hours_tolerance_abs', 'p.hoursTolAbs'],
];

export default function TradeInSettings() {
  const { a, money, lang } = useA();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [defaults, setDefaults] = useState<Policy | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ policy: Policy; defaults: Policy }>('/api/admin/trade-in/policy')
      .then((d) => {
        setPolicy(d.policy);
        setDraft(d.policy);
        setDefaults(d.defaults);
      })
      .catch((e) => setError(apiRefusal(e, refusalLang(lang), a('loadError'))));
    api
      .get<{ pnl: Pnl }>('/api/admin/trade-in/pnl')
      .then((d) => setPnl(d.pnl))
      .catch(() => undefined);
  }, [lang, a]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const body: Record<string, unknown> = { require_serial_match: draft.require_serial_match };
      for (const [k] of FIELDS) body[k] = draft[k];
      const d = await api.put<{ policy: Policy }>('/api/admin/trade-in/policy', body);
      setPolicy(d.policy);
      setDraft(d.policy);
      setSaved(true);
    } catch (e) {
      setError(apiRefusal(e, refusalLang(lang), a('failed')));
    } finally {
      setBusy(false);
    }
  };

  const tile = (k: AdminKey, count: number, figure: number, extra?: React.ReactNode) => (
    <div className="min-w-0 rounded-[var(--ap-radius-md)] bg-[var(--ap-surface-2)] p-3" data-pnl={k}>
      <p className={`text-[12px] ${T.text3}`}>{a(k)}</p>
      <p className="text-[16px] font-bold tabular-nums">{money(figure)}</p>
      <p className={`text-[11.5px] ${T.text3}`}>{countedText(PNL_COUNT, count, lang)}</p>
      {extra}
    </div>
  );

  return (
    <div className="space-y-4" data-trade-in-settings>
      <section className={`${T.surface} space-y-3 p-4`} data-trade-in-pnl>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[15px] font-bold">{a('pnl')}</h3>
          <span className={`text-[12px] ${T.text3}`}>{a('pnl.period')}</span>
        </div>
        {pnl ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {tile('pnl.credits', pnl.credits_fixed.count, pnl.credits_fixed.total_iqd)}
            {tile('pnl.inStock', pnl.in_stock.count, pnl.in_stock.cost_iqd)}
            {tile(
              'pnl.resold',
              pnl.resold.count,
              pnl.resold.revenue_iqd,
              <p className={`text-[11.5px] ${T.text2}`}>
                {a('owner.margin')}: <span className="tabular-nums">{money(pnl.resold.margin_iqd)}</span>
              </p>
            )}
            {tile('pnl.writeOffs', pnl.write_offs.count, pnl.write_offs.cost_iqd)}
            {tile('pnl.overrides', pnl.above_ceiling.count, pnl.above_ceiling.over_iqd)}
            {tile('pnl.reissued', pnl.reissued.count, pnl.reissued.total_iqd)}
          </div>
        ) : (
          <p className={`text-[12.5px] ${T.text3}`}>{a('loading')}</p>
        )}
      </section>

      <section className={`${T.surface} space-y-3 p-4`} data-trade-in-policy>
        <h3 className="text-[15px] font-bold">{a('policy.title')}</h3>
        {draft ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {FIELDS.map(([k, label]) => (
                <label key={k} className="block min-w-0">
                  <span className={`mb-1 block truncate text-[11.5px] ${T.text3}`}>{a(label)}</span>
                  <input
                    className={`${T.input} w-full tabular-nums`}
                    dir="ltr"
                    inputMode="numeric"
                    value={String(draft[k])}
                    onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value.replace(/[^0-9]/g, '') || 0) })}
                    data-policy={k}
                  />
                  {defaults ? <span className={`mt-0.5 block text-[11px] ${T.text3}`}>{a('p.default', { x: defaults[k] })}</span> : null}
                </label>
              ))}
              <div className="min-w-0">
                <span className={`mb-1 block truncate text-[11.5px] ${T.text3}`}>{a('p.reissueDays')}</span>
                <span className="block py-2 text-[13px] tabular-nums">{draft.reissue_valid_days}</span>
              </div>
            </div>
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--ap-accent)]"
                checked={draft.require_serial_match}
                onChange={(e) => setDraft({ ...draft, require_serial_match: e.target.checked })}
              />
              {a('p.requireSerial')}
            </label>
            <div className="flex items-center gap-3">
              <button type="button" className={T.btnPrimary} disabled={busy || JSON.stringify(draft) === JSON.stringify(policy)} onClick={save} data-policy-save>
                {a('save')}
              </button>
              {saved ? <span className="text-[12.5px] text-[var(--ap-success)]">{a('saved')}</span> : null}
            </div>
          </>
        ) : !error ? (
          <p className={`text-[12.5px] ${T.text3}`}>{a('loading')}</p>
        ) : null}
        {error ? (
          <p className="text-[12.5px] text-[var(--ap-danger)]" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <ComponentRefs />

      <section className="space-y-2">
        <h3 className="px-1 text-[15px] font-bold">{a('rules.title')}</h3>
        <RulesEditor />
      </section>
    </div>
  );
}
