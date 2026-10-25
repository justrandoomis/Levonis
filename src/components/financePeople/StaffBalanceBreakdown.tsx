import { Money, useLanguage } from './shared';

export type StaffBalance = {
  reconciliation_pending?: boolean; staff_net_iqd: number; staff_available_iqd: number; staff_debt_iqd: number; pending_costs?: number;
  staff_iqd?: number; staff_paid_iqd?: number; staff_held_iqd?: number; staff_pending_settlement_reserve_iqd?: number;
  advance_balance_iqd?: number;
};

export default function StaffBalanceBreakdown({ balance }: { balance: StaffBalance }) {
  const { loc } = useLanguage();
  // Optional during an asset/worker rollout; never print a missing field as 0.
  if (balance.staff_paid_iqd === undefined) return null;
  const cells = [
    [loc('إجمالي المستحقات المحسوبة', 'Total calculated earnings', 'کۆی شایستە ژمێردراوەکان'), balance.staff_iqd],
    [loc('إجمالي المدفوعات والسلف', 'Total payments and advances', 'کۆی پارەدان و پێشەکییەکان'), balance.staff_paid_iqd],
    [loc('من المدفوعات: سلف لم تُسوّ بعد', 'Of payments: unsettled advances', 'لە پارەدانەکان: پێشەکیی یەکلانەکراوە'), balance.advance_balance_iqd],
    [loc('موقوف لحين اكتمال الحساب', 'Held pending calculation', 'ڕاگیراو تا تەواوبوونی ژمێریاری'), balance.staff_pending_settlement_reserve_iqd],
    [loc('محجوز لطلبات السحب', 'Reserved for withdrawals', 'گیراو بۆ داواکاریی ڕاکێشان'), balance.staff_held_iqd],
  ] as const;
  return <details className="fp-detail"><summary>{loc('مطابقة الرصيد التراكمي', 'Reconcile cumulative balance', 'پشکنینی کۆی باڵانس')}</summary>
    <div className="fp-stats">{cells.map(([label, value]) => <div className="fp-stat" key={label}><span>{label}</span><Money value={value ?? null} /></div>)}</div>
    <p className="fp-note">{loc('الرصيد التراكمي = إجمالي المستحقات المحسوبة − المدفوعات والسلف، لجميع الفترات. يُستبعد الموقوف والمحجوز من المتاح للسحب. المستحقات التي ينقص أساس حسابها لا تُعد مبلغًا نهائيًا.', 'Cumulative balance = total calculated earnings − payments and advances, across all periods. Pending and reserved amounts are excluded from withdrawals. Earnings with missing calculation inputs are not final.', 'کۆی باڵانس = کۆی شایستە ژمێردراوەکان − پارەدان و پێشەکییەکان، بۆ هەموو ماوەکان. بڕی ڕاگیراو و گیراو لە ڕاکێشان دەردەکرێت. شایستەی زانیاریی ژمێریاریی کەمە بڕێکی کۆتایی نییە.')}</p>
  </details>;
}
