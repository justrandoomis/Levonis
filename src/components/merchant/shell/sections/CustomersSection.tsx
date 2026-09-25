/**
 * `/merchant/customers[/<key>]` — the people who bought from this store, and
 * one of them (W3-B). Built from this store's own counted orders only
 * (worker/routes/merchantCustomers.ts): not a directory (§60), and a
 * customer is addressed by an order id of this store, never a user id.
 */
import type { SectionProps } from '../sections';
import { useWorkspace } from '../context';
import CustomerList from '../../customers/CustomerList';
import CustomerDetailView from '../../customers/CustomerDetailView';

export default function CustomersSection({ id }: SectionProps) {
  const ws = useWorkspace();
  if (id) return <CustomerDetailView key={id} customerKey={id} href={ws.href} />;
  return <CustomerList href={ws.href} />;
}
