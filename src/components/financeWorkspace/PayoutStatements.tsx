import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Loading, Money, Status, Surface } from './ui';
import { WORKSPACE_API } from './types';
import { pss, type PsKey } from './statementsStrings';

/**
 * «المال والأرباح» → الأشخاص والدفعات → «الكشوف» (the owner, 2026-11-13: «more improvement if possible on ui ux» of the
 * statements; DECISIONS row 336; GET /statements).
 *
 * Every staff payment and every investor withdrawal of the period, newest first, each with its statement as Excel and as a
 * page to print or save as PDF, in the reader's language — the place to find a payout's statement, where before it was
 * only on that payout's row of «سجل العمليات المالية». A rejected or cancelled withdrawal paid nothing and is not listed.
 */
export interface PayoutStatementsAnswer {
  staff_payments: Array<{ id: string; kind: 'payment' | 'advance'; day: string; amount_iqd: number; person: string }>;
  withdrawals: Array<{ id: string; state: 'requested' | 'approved' | 'part_paid' | 'paid'; day: string; amount_iqd: number; paid_iqd: number; person: string }>;
}

function Links({ kind, id }: { kind: 'staff-payments' | 'withdrawals'; id: string }) {
  const { lang } = useLanguage();
  const base = `${WORKSPACE_API}/statements/${kind}/${encodeURIComponent(id)}`;
  return <span data-payout-statement={id}><a className="fw-link" href={`${base}/export.xlsx?lang=${lang}`}>Excel</a>{' · '}
    <a className="fw-link" href={`${base}/print?lang=${lang}`} target="_blank" rel="noopener">PDF</a></span>;
}

export default function PayoutStatements({ from, to }: { from: string; to: string }) {
  const { loc } = useLanguage();
  const [data, setData] = useState<PayoutStatementsAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setFailed(false);
    api.get<PayoutStatementsAnswer>(`${WORKSPACE_API}/statements?from=${from}&to=${to}`, { signal: controller.signal })
      .then((r) => { if (!controller.signal.aborted) setData(r); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [from, to]);

  return <Surface title={pss(loc, 'title')} subtitle={pss(loc, 'sub')}>
    <div data-payout-statements>
      {failed ? <p className="fw-note" role="alert">{pss(loc, 'failed')}</p>
        : !data ? <Loading text={pss(loc, 'title')} />
          : <>
            <h3 className="fw-courier-h">{pss(loc, 'staffTitle')}</h3>
            {data.staff_payments.length === 0 ? <p className="fw-note" data-payout-none="staff">{pss(loc, 'noneStaff')}</p>
              : <div className="fw-table-wrap"><table className="fw-table" data-payout-staff>
                <thead><tr><th scope="col">{pss(loc, 'colDay')}</th><th scope="col">{pss(loc, 'colEmployee')}</th><th scope="col">{pss(loc, 'colKind')}</th>
                  <th scope="col">{pss(loc, 'colAmount')}</th><th scope="col">{pss(loc, 'colStatement')}</th></tr></thead>
                <tbody>{data.staff_payments.map((p) => <tr key={p.id}>
                  <td dir="ltr">{p.day}</td><td>{p.person}</td><td>{pss(loc, p.kind === 'advance' ? 'kindAdvance' : 'kindPayment')}</td>
                  <td><Money value={p.amount_iqd} /></td><td><Links kind="staff-payments" id={p.id} /></td>
                </tr>)}</tbody>
              </table></div>}
            <h3 className="fw-courier-h">{pss(loc, 'withdrawalsTitle')}</h3>
            {data.withdrawals.length === 0 ? <p className="fw-note" data-payout-none="withdrawals">{pss(loc, 'noneWithdrawals')}</p>
              : <div className="fw-table-wrap"><table className="fw-table" data-payout-withdrawals>
                <thead><tr><th scope="col">{pss(loc, 'colDay')}</th><th scope="col">{pss(loc, 'colInvestor')}</th><th scope="col">{pss(loc, 'colState')}</th>
                  <th scope="col">{pss(loc, 'colAmount')}</th><th scope="col">{pss(loc, 'colPaid')}</th><th scope="col">{pss(loc, 'colStatement')}</th></tr></thead>
                <tbody>{data.withdrawals.map((w) => <tr key={w.id}>
                  <td dir="ltr">{w.day}</td><td>{w.person}</td>
                  <td><Status tone={w.state === 'paid' ? 'positive' : w.state === 'requested' ? 'neutral' : 'warning'}>{pss(loc, w.state as PsKey)}</Status></td>
                  <td><Money value={w.amount_iqd} /></td><td><Money value={w.paid_iqd} /></td><td><Links kind="withdrawals" id={w.id} /></td>
                </tr>)}</tbody>
              </table></div>}
          </>}
    </div>
  </Surface>;
}
