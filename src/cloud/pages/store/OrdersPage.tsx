/**
 * THE CUSTOMER'S ORDERS (/orders, signed in): GET /orders, newest first —
 * purchases and the delivery-fee orders of shipments — each with its date,
 * its number, how it is paid, its total and its state in words. The server
 * answers at most its latest 200; the screen shows them a page at a time and
 * says when the list was capped.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusChip } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Money } from '../../../components/ui/Money';
import { formatFigure } from '../../../lib/localeNumber';
import { listOrders } from '../../api';
import { formatDate } from '../../format';
import { orders as words, orderStatus, paymentMethod, store } from '../../strings/store';
import { useCloudText } from '../../text';
import { CloudEmptyState, CloudErrorState, CloudPageSkeleton, ListRow, PageHeader, Receipt, Truck } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { orderTone } from './rules';

/** GET /orders answers at most this many rows (worker/routes/printCloud.ts `LIMIT 200`). */
const SERVER_CAP = 200;
const PAGE = 20;

export default function OrdersPage() {
  const { t, lang } = useCloudText();
  const list = useCloudQuery((signal) => listOrders({ signal }), []);
  const [limit, setLimit] = useState(PAGE);
  const back = { to: '/store', label: t(store.title) };

  if (list.error) {
    return (
      <div>
        <PageHeader title={t(words.title)} back={back} />
        <CloudErrorState error={list.error} onRetry={list.reload} />
      </div>
    );
  }
  if (!list.data) return <CloudPageSkeleton />;
  const rows = list.data;

  return (
    <div className="space-y-4">
      <PageHeader title={t(words.title)} subtitle={t(words.subtitle)} back={back} />
      {rows.length === 0 ? (
        <CloudEmptyState
          icon={<Receipt className="h-6 w-6" />}
          title={t(words.emptyTitle)}
          body={t(words.emptyBody)}
          action={
            <Link to="/store" className="lv-button lv-button-primary">
              {t(words.goToStore)}
            </Link>
          }
        />
      ) : (
        <>
          <ul className="space-y-2">
            {rows.slice(0, limit).map((o) => {
              const status = orderStatus[o.status as keyof typeof orderStatus];
              const method = paymentMethod[o.payment_method as keyof typeof paymentMethod];
              return (
                <li key={o.id}>
                  <ListRow
                    to={`/orders/${encodeURIComponent(o.id)}`}
                    leading={o.kind === 'shipping' ? <Truck className="h-4 w-4" /> : <Receipt className="h-4 w-4" />}
                    title={`${o.kind === 'shipping' ? t(words.deliveryFee) : t(words.purchase)} · ${formatDate(o.created_at, lang)}`}
                    meta={
                      <>
                        <bdi dir="ltr">{o.id}</bdi>
                        {method ? ` · ${t(method)}` : ''}
                      </>
                    }
                    trailing={
                      <span className="flex flex-col items-end gap-1">
                        <span className="text-sm font-bold text-text-primary">
                          <Money iqd={o.total_iqd} />
                        </span>
                        <StatusChip tone={orderTone(o.status)}>{status ? t(status) : o.status}</StatusChip>
                      </span>
                    }
                  />
                </li>
              );
            })}
          </ul>
          {rows.length > limit ? (
            <div className="flex flex-col items-center gap-2">
              <p className="text-[12px] text-text-muted">{t(store.shownOf, { shown: formatFigure(limit, lang), total: formatFigure(rows.length, lang) })}</p>
              <Button variant="secondary" onClick={() => setLimit((n) => n + PAGE)}>
                {t(store.showMore)}
              </Button>
            </div>
          ) : null}
          {rows.length >= SERVER_CAP ? <p className="text-center text-[12px] text-text-muted">{t(words.latestOnly, { n: formatFigure(SERVER_CAP, lang) })}</p> : null}
        </>
      )}
    </div>
  );
}
