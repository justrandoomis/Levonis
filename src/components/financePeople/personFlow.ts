/** The money flow's columns (PersonStatement.tsx; DECISIONS row 342), pure: no React, no stylesheet. */
import type { PersonStatementStrings } from '../../lib/personStatementStrings';
import type { PersonFinance } from './PersonFinanceView';

export type Column = { key: string; label: string; earned: number; paid: number; reserved: number; held: number; available: number; capital: number; withdraw: number };

/** What the ledger paid beyond its earnings: the part of the column the four lines do not explain. */
export const debtOf = (c: Pick<Column, 'earned' | 'paid' | 'reserved' | 'held' | 'available'>) => c.available - (c.earned - c.paid - c.reserved - c.held);

export function flowColumns(person: PersonFinance, t: PersonStatementStrings): Column[] {
  const work = person.work, inv = person.investor, c = person.combined;
  const cols: Column[] = [];
  if (work) cols.push({ key: 'work', label: t.colWork, earned: work.earned_iqd, paid: work.paid_iqd, reserved: work.reserved_iqd, held: work.held_iqd, available: work.available_iqd, capital: 0, withdraw: work.available_iqd });
  if (inv) cols.push({ key: 'invest', label: t.colInvest, earned: inv.profit.earned_iqd, paid: inv.profit.paid_iqd, reserved: inv.profit.reserved_iqd, held: inv.profit.held_iqd, available: inv.profit.available_iqd, capital: inv.capital.available_iqd, withdraw: inv.profit.available_iqd + inv.capital.available_iqd });
  if (cols.length > 1) cols.push({ key: 'total', label: t.colTotal, earned: c.earned_iqd, paid: c.paid_iqd, reserved: c.reserved_iqd, held: c.held_iqd, available: c.available_earnings_iqd, capital: c.available_capital_iqd, withdraw: c.available_iqd });
  return cols;
}
