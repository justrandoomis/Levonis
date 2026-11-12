import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Button, Loading, Money, Status, Surface } from './ui';
import { WORKSPACE_API, type FinanceCheck, type FinanceChecksAnswer } from './types';
import { acs, checkWords } from './accountingStrings';

/**
 * «المال والأرباح» → المحاسبة: THE BOOKS' OWN CHECKS, first on the page (the owner's brief, 2026-11-12, part 4: «automated
 * consistency checks»; worker/lib/financeChecks.ts, which the daily alert runs too).
 *
 * The page reads GET /accounting-checks once when it opens and again on «افحص الآن». Nothing found: one line that says so
 * and when it was checked. Something found: one row per check that found it — the faults first, each with a chip that says
 * which kind it is («خلل» or «للمراجعة»), its name, one sentence of what to do, its first ids, and its count with its money
 * where it is money. An order's id opens its sheet (the workspace's `onOpenOrder`); the other ids (an entry, a payment, an
 * expense, a month) are named to be found. The page writes nothing.
 */
const ORDER_ID = /^ORD-/;
const clockOf = (at: string) => { const t = Date.parse(at); return Number.isFinite(t) ? new Date(t + 3 * 3600000).toISOString().slice(11, 16) : ''; };

export default function AccountingChecks({ onOpenOrder }: { onOpenOrder: (orderId: string) => void }) {
  const { loc } = useLanguage();
  const [data, setData] = useState<FinanceChecksAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = useRef<AbortController | null>(null);

  const read = useCallback(() => {
    live.current?.abort();
    const controller = new AbortController();
    live.current = controller;
    setBusy(true);
    setFailed(false);
    api.get<FinanceChecksAnswer>(`${WORKSPACE_API}/accounting-checks`, { signal: controller.signal })
      .then((r) => { if (!controller.signal.aborted) setData(r); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
  }, []);
  useEffect(() => { read(); return () => live.current?.abort(); }, [read]);

  const found = (data?.checks ?? []).filter((c) => c.count > 0).sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  const action = <Button variant="ghost" onClick={read} busy={busy} data-finance-checks-again>{acs(loc, 'again')}</Button>;

  return <Surface title={acs(loc, 'title')} subtitle={acs(loc, 'sub')} action={action}>
    <div data-finance-checks aria-busy={busy}>
      {failed ? <p className="fw-note" role="alert">{acs(loc, 'failed')}</p>
        : !data ? <Loading text={acs(loc, 'title')} />
          : found.length === 0 ? <p className="fw-note" data-finance-checks-clear>{acs(loc, 'clear')}</p>
            : <ul className="fw-att">{found.map((c) => <CheckRow key={c.key} check={c} onOpenOrder={onOpenOrder} />)}</ul>}
      {data && !failed && <p className="fw-note">{acs(loc, 'checked', { time: clockOf(data.checked_at) })}</p>}
    </div>
  </Surface>;
}

function CheckRow({ check, onOpenOrder }: { check: FinanceCheck; onOpenOrder: (orderId: string) => void }) {
  const { loc } = useLanguage();
  const { title, note } = checkWords(loc, check.key);
  const rest = check.count - check.sample.length;
  return <li data-finance-check={check.key} data-finance-check-severity={check.severity}>
    <Status tone={check.severity === 'error' ? 'danger' : 'warning'}>{acs(loc, check.severity === 'error' ? 'fault' : 'look')}</Status>
    <div>
      <strong>{title}</strong>
      <small>{note}</small>
      <small dir="ltr" data-finance-check-ids>{check.sample.map((id, i) => <Fragment key={id}>
        {i > 0 && ' · '}
        {ORDER_ID.test(id) ? <button type="button" className="fw-link" onClick={() => onOpenOrder(id)}>{id}</button> : id}
      </Fragment>)}{rest > 0 && <> · {acs(loc, 'more', { n: rest })}</>}</small>
    </div>
    <span data-finance-check-count>{check.count.toLocaleString('en-US')}{check.amount_iqd !== null && <> · <Money value={check.amount_iqd} /></>}</span>
  </li>;
}
