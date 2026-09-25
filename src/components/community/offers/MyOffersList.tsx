/**
 * «عروضي» — the workshop's offers across every request (stream W5-A), for the
 * workspace's `/merchant/requests`. What needs the merchant first: offers the
 * customer's change superseded (re-confirm or edit), then the ones standing,
 * then the rest. Each row opens its request, where the offer is edited,
 * withdrawn or — once accepted — the customer's contact and the conversation
 * are. Pages by the server's cursor.
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Money } from '../../ui/Money';
import { Button } from '../../ui/Button';
import { StatusChip } from '../../ui/Badge';
import { Segmented } from '../../ui/Segmented';
import { offerStateLabel, offersApi, validUntil, type MyOfferRow } from './types';

type Filter = '' | 'superseded' | 'pending' | 'accepted';

export default function MyOffersList({ requestHref }: { requestHref: (requestId: string) => string }) {
  const { loc, lang } = useLanguage();
  const [filter, setFilter] = useState<Filter>('');
  const [rows, setRows] = useState<MyOfferRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);

  const load = useCallback((f: Filter, after = '') => {
    setFailed(false);
    return offersApi
      .mine(after, f)
      .then((d) => {
        // An older server, or a stand-in, may answer without the list: that
        // is "no offers", never a crash of the section around it.
        const list = Array.isArray(d?.offers) ? d.offers : [];
        setRows((prev) => (after && prev ? [...prev, ...list] : list));
        setCursor(typeof d?.next_cursor === 'string' ? d.next_cursor : null);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    setRows(null);
    void load(filter);
  }, [filter, load]);

  return (
    <section aria-labelledby="my-offers-title" data-my-offers>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="my-offers-title" className="text-[15px] font-bold text-text-primary">{loc('عروضي', 'My offers')}</h2>
        <div className="w-full sm:w-auto sm:min-w-[340px]">
          <Segmented
            group="my-offers-filter"
            size="sm"
            label={loc('تصفية العروض', 'Filter offers')}
            value={filter || 'all'}
            onChange={(id) => setFilter((id === 'all' ? '' : id) as Filter)}
            items={[
              { id: 'all', label: loc('الكل', 'All') },
              { id: 'superseded', label: loc('للتأكيد', 'Re-confirm') },
              { id: 'pending', label: loc('قائمة', 'Open') },
              { id: 'accepted', label: loc('مقبولة', 'Accepted') },
            ]}
          />
        </div>
      </div>
      {failed ? (
        <p className="py-6 text-center text-[13px] text-text-muted">
          {loc('تعذّر تحميل عروضك.', 'Could not load your offers.')}{' '}
          <button type="button" className="font-semibold text-gold underline-offset-4 hover:underline" onClick={() => load(filter)}>
            {loc('أعد المحاولة', 'Retry')}
          </button>
        </p>
      ) : rows === null ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-2xl bg-white/[0.04]" />)}
        </div>
      ) : !rows.length ? (
        <p className="py-6 text-center text-[13px] text-text-muted">
          {filter ? loc('لا عروض هنا.', 'No offers here.') : loc('لم تقدّم عروضًا بعد. الطلبات التي تناسب ورشتك على لوحة الطلبات.', 'You have not made offers yet. Requests that fit your workshop are on the board.')}
        </p>
      ) : (
        <ul className="lv-surface divide-y divide-white/[0.06]">
          {rows.map((o) => {
            const st = offerStateLabel(o, loc);
            const until = validUntil(o.expires_at, lang);
            const req = o.request ?? { id: o.request_id, title: '', state: '', revision: 1, expires_at: null };
            return (
              <li key={o.id}>
                <a
                  href={requestHref(req.id)}
                  data-my-offer={o.id}
                  data-my-offer-state={o.state}
                  className="flex min-h-[64px] items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold text-text-primary" dir="auto">{req.title || req.id}</span>
                    <span className="mt-0.5 block text-[12px] text-text-muted">
                      <Money iqd={o.price_iqd} /> · {loc(`نسخة ${o.revision}`, `v${o.revision}`)}
                      {until && o.state === 'pending' ? <> · {loc(`حتى ${until}`, `until ${until}`)}</> : null}
                    </span>
                  </span>
                  <StatusChip tone={st.tone}>{st.text}</StatusChip>
                  <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted rtl:-scale-x-100" />
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {cursor && rows && (
        <div className="mt-3 flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            loading={more}
            onClick={async () => {
              setMore(true);
              await load(filter, cursor);
              setMore(false);
            }}
          >
            {loc('المزيد', 'More')}
          </Button>
        </div>
      )}
    </section>
  );
}
