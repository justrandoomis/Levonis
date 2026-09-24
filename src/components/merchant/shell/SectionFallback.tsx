/**
 * What a screen shows while its chunk arrives: the SHAPE of that screen
 * (src/components/ui/DashboardSkeletons.tsx), never a spinner in the middle
 * of nowhere and never a number that will change.
 */
import type { MerchantSection } from '../../../lib/merchantRoutes';
import { CardSkeleton, FormSkeleton, KpiRowSkeleton, ListRowsSkeleton, TableRowsSkeleton } from '../../ui/DashboardSkeletons';

const SHAPE: Record<MerchantSection, 'home' | 'list' | 'table' | 'form' | 'kpi' | 'card'> = {
  home: 'home',
  orders: 'list',
  custom_orders: 'list',
  requests: 'list',
  customers: 'list',
  coupons: 'list',
  products: 'table',
  collections: 'list',
  services: 'list',
  showcase: 'card',
  printers: 'form',
  costing: 'form',
  store_design: 'card',
  store_settings: 'form',
  store_delivery: 'form',
  money: 'kpi',
  analytics: 'kpi',
  reviews: 'list',
  inbox: 'list',
  notifications: 'list',
};

export default function SectionFallback({ section }: { section: MerchantSection }) {
  switch (SHAPE[section]) {
    case 'home':
      return (
        <div className="space-y-8">
          <CardSkeleton lines={1} />
          <div className="lv-surface overflow-hidden">
            <ListRowsSkeleton rows={4} />
          </div>
          <KpiRowSkeleton count={4} />
        </div>
      );
    case 'table':
      return (
        <div className="lv-surface overflow-hidden">
          <TableRowsSkeleton rows={6} columns={4} />
        </div>
      );
    case 'form':
      return <FormSkeleton fields={4} />;
    case 'kpi':
      return (
        <div className="space-y-4">
          <KpiRowSkeleton count={4} />
          <CardSkeleton lines={4} />
        </div>
      );
    case 'card':
      return <CardSkeleton lines={5} />;
    case 'list':
    default:
      return (
        <div className="lv-surface overflow-hidden">
          <ListRowsSkeleton rows={5} />
        </div>
      );
  }
}
