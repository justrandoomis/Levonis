/**
 * What the «تسوية الأجور» dialog shows (DECISIONS row 306): the preview of a
 * settlement and a refusal, in the reader's language. Drawn from props alone —
 * no context, no request, no stylesheet of its own (people.css is loaded by the
 * dialog) — so tests render it in ar, en and ckb (tests/wageSettlementDialog.test.ts).
 */
import { CalendarCheck } from 'lucide-react';
import type { Language } from '../../translations';
import { percentText, type PersonFinanceStrings, type SettleRefusalKey } from '../../lib/personFinanceStrings';
import { dayText, lastSettledDay, type LastSettlement, type SettlementPreview } from './wageSettlement';

/** The screen's Money (shared.tsx), with the reader's language passed in. */
function Amount({ value, lang, className = '', signed = false }: { value: number; lang: Language; className?: string; signed?: boolean }) {
  return <span className={`fp-money ${className}`}><bdi>{signed && value > 0 ? '+' : ''}{value.toLocaleString('en-US')}</bdi><small>{lang === 'en' ? 'IQD' : 'د.ع'}</small></span>;
}
const tone = (n: number) => (n < 0 ? 'fp-negative' : n > 0 ? 'fp-positive' : '');
const shares = (bps: number[]) => bps.map((b) => percentText(b)).join(' / ');

export function SettlementPreviewView({ preview, s, lang }: { preview: SettlementPreview; s: PersonFinanceStrings; lang: Language }) {
  const t = s.settle, arrow = lang === 'en' ? '→' : '←';
  const owner = new Map(preview.investors.flatMap((v) => v.order_ids.map((id) => [id, v] as const)));
  return <div className="fp-stack" data-settlement-preview>
    <div className="fp-review-heading"><CalendarCheck size={20} aria-hidden="true" /><div><strong>{t.ordersThrough} {dayText(lastSettledDay(preview.through_day), lang)}</strong>
      <p className="fp-muted">{t.rowsLine(preview.rows, preview.adjusted, preview.reversed)}</p></div></div>
    <div className="fp-stats">
      <div className="fp-stat"><span>{t.earned}</span><Amount value={preview.earned_before_iqd} lang={lang} /></div>
      <div className="fp-stat"><span>{t.paid}</span><Amount value={preview.paid_before_iqd} lang={lang} /></div>
      <div className="fp-stat"><span>{t.owedBefore}</span><Amount value={preview.owed_before_iqd} lang={lang} /></div>
      <div className="fp-stat fp-stat-good"><span>{t.agreed}</span><Amount value={preview.owed_iqd} lang={lang} /></div>
    </div>
    <div className="fp-row"><span>{t.change}</span><Amount value={preview.change_iqd} lang={lang} signed className={tone(preview.change_iqd)} /></div>
    <p className="fp-note">{t.paidStays}</p>
    {preview.investors.length > 0 && <div className="fp-warning-box" data-settlement-investors><strong>{t.investorTitle}</strong><p>{t.investorWhy}</p>
      <div className="fp-rows">{preview.investors.map((v) => <div className="fp-row" key={v.user_id}><div className="min-w-0"><strong><bdi>{v.name}</bdi></strong>
        <p className="fp-row-meta">{t.investorShare} {shares(v.share_bps)} · {t.investorOrders(v.order_ids.length)} · {t.investorWages} <Amount value={v.wage_change_iqd} lang={lang} signed /></p>
        {v.profit_change_iqd !== 0 && <p className="fp-row-meta">{v.profit_change_iqd > 0 ? t.investorUp : t.investorDown} <Amount value={Math.abs(v.profit_change_iqd)} lang={lang} className={tone(v.profit_change_iqd)} /> {t.investorLess}</p>}
      </div></div>)}</div></div>}
    {preview.order_changes.length === 0 ? <p className="fp-muted">{t.noOrders}</p>
      : <details className="fp-detail" open={preview.order_changes.length <= 6 || undefined}><summary>{t.ordersTitle(preview.order_changes.length)}</summary>
        <div className="fp-rows">{preview.order_changes.map((o) => { const v = owner.get(o.order_id); return <div className="fp-row" key={o.order_id}>
          <div className="min-w-0"><bdi dir="ltr">{o.order_id}</bdi>{v && <p className="fp-row-meta"><span className="fp-status fp-status-approved"><bdi>{v.name}</bdi> · {shares(v.share_bps)}</span></p>}</div>
          <div className="text-end"><Amount value={o.before_iqd} lang={lang} /> {arrow} <Amount value={o.after_iqd} lang={lang} className={tone(o.after_iqd - o.before_iqd)} /></div>
        </div>; })}</div></details>}
    <p className="fp-muted">{t.final}</p>
  </div>;
}

/** A refusal the dialog says itself: what blocks the settlement, and what to do. */
export function SettlementRefusalBox({ kind, s, lang, last }: { kind: SettleRefusalKey; s: PersonFinanceStrings; lang: Language; last?: LastSettlement | null }) {
  const t = s.settle;
  return <div className="fp-warning-box" role="alert" data-settlement-refusal={kind}><strong>{t.refusedTitle}</strong>
    <p>{t.refusal[kind]}</p>
    {kind === 'settled' && last && <p>{s.settledThrough} {dayText(lastSettledDay(last.through_day), lang)} · {s.agreedOwed} <Amount value={last.owed_iqd} lang={lang} /></p>}
    <p>{t.refusalAction[kind]}</p></div>;
}
