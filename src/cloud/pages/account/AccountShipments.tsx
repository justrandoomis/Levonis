/**
 * /account/shipments — PICKUPS AND DELIVERIES (GET /shipments).
 *
 * Every shipment the customer asked for, newest first, with its state in
 * words, its fee when it has one, and the way to ask for another — offered
 * only while the workshop offers pickup or delivery (GET /status `delivery`).
 */
import { Link } from 'react-router-dom';
import { Money } from '../../../components/ui/Money';
import { listShipments } from '../../api';
import { useCloud } from '../../CloudContext';
import { formatDate } from '../../format';
import { shipmentKind, shipText } from '../../strings/account';
import { useCloudText } from '../../text';
import { CloudEmptyState, CloudErrorState, CloudPageSkeleton, Info, ListRow, MapPin, Truck } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { CapNote, ShipmentPill, SubPageHeader, useStatusWord } from './shared';

/** The server's own cap on the shipments it lists (GET /shipments). */
const SHIPMENTS_CAP = 200;
const enc = encodeURIComponent;

export default function AccountShipments() {
  const { t, lang } = useCloudText();
  const { status, dashboardVersion } = useCloud();
  const word = useStatusWord();
  const list = useCloudQuery((signal) => listShipments({ signal }), [dashboardVersion]);
  const offered = !!status && (status.delivery.enabled || status.delivery.pickup_enabled);
  const header = (
    <SubPageHeader
      title={t(shipText.title)}
      subtitle={t(shipText.subtitle)}
      actions={
        offered ? (
          <Link to="/account/shipments/new" className="lv-button lv-button-primary lv-button-sm">
            <Truck aria-hidden="true" className="h-4 w-4" />
            {t(shipText.request)}
          </Link>
        ) : null
      }
    />
  );

  return (
    <div className="space-y-4">
      {header}
      {status && !offered ? (
        <p className="flex items-start gap-2 rounded-xl lv-well px-3 py-2 text-[13px] leading-snug text-text-secondary">
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          {t(shipText.unavailable)}
        </p>
      ) : null}
      {list.error ? (
        <CloudErrorState error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <CloudPageSkeleton />
      ) : list.data.length === 0 ? (
        <CloudEmptyState icon={<Truck className="h-6 w-6" />} title={t(shipText.emptyTitle)} body={t(shipText.emptyBody)} />
      ) : (
        <>
          <ul className="space-y-2">
            {list.data.map((s) => (
              <li key={s.id}>
                <ListRow
                  to={`/account/shipments/${enc(s.id)}`}
                  leading={s.kind === 'pickup' ? <MapPin className="h-4 w-4" /> : <Truck className="h-4 w-4" />}
                  title={word(shipmentKind, s.kind)}
                  meta={
                    <>
                      {t(shipText.requestedOn, { date: formatDate(s.created_at, lang) })}
                      {s.fee_iqd > 0 ? (
                        <>
                          {' · '}
                          <Money iqd={s.fee_iqd} />
                        </>
                      ) : null}
                      {s.tracking_ref ? ` · ${t(shipText.tracking, { ref: s.tracking_ref })}` : null}
                    </>
                  }
                  trailing={<ShipmentPill status={s.status} />}
                />
              </li>
            ))}
          </ul>
          <CapNote shown={list.data.length} cap={SHIPMENTS_CAP} />
        </>
      )}
    </div>
  );
}
