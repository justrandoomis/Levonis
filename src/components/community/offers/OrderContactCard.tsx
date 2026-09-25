/**
 * WHO THE OTHER SIDE IS, AFTER ACCEPTANCE (§4.7, stream W5-A).
 *
 * The server hands each party the OTHER party's contact from the snapshot it
 * froze at acceptance — the merchant gets the customer's name, phone and
 * delivery address (only a name and phone for a pickup); the customer gets the
 * store's name and phone — and nothing before. This card shows it and opens
 * the request's conversation (W2-E's request thread: `POST /api/chats/open`
 * with the request, and for the customer the merchant). An order accepted
 * before 0130 has no snapshot: the card then offers the conversation alone.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, MessageCircle, Phone, Store } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError } from '../../../lib/api';
import { apiRefusal } from '../../../lib/refusalStrings';
import { GOVERNORATES } from '../../../lib/governorates';
import { Button } from '../../ui/Button';
import { useToast } from '../../ui/Toast';
import { deliveryLabel, offersApi, type OrderContact } from './types';

export default function OrderContactCard({ orderId, compact = false }: { orderId: string; compact?: boolean }) {
  const { loc, lang } = useLanguage();
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<{ role: 'customer' | 'merchant'; contact: OrderContact | null; thread: { request_id: string; merchant_id: string } } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    offersApi
      .order(orderId)
      .then((d) => alive && setData(d))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [orderId]);

  async function openChat() {
    if (!data) return;
    try {
      const r = await offersApi.openThread(data.thread.request_id, data.role === 'customer' ? data.thread.merchant_id : undefined);
      navigate(`/chat/${encodeURIComponent(r.chatId)}`);
    } catch (e) {
      const L = lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';
      toast.error(e instanceof ApiError ? apiRefusal(e, L, e.message) : loc('تعذّر فتح المحادثة', 'Could not open the conversation'));
    }
  }

  if (failed) return null;
  if (!data) return <div className="h-16 animate-pulse rounded-2xl bg-white/[0.04]" aria-busy="true" />;
  const c = data.contact;
  const gov = GOVERNORATES.find((g) => g.id === c?.governorate);
  const govName = gov ? (lang === 'en' ? gov.en : gov.ar) : c?.governorate ?? '';
  const place = [govName, c?.area, c?.address, c?.landmark].filter(Boolean).join(' · ');

  return (
    <div className={`rounded-2xl bg-white/[0.03] ${compact ? 'p-3' : 'p-4'}`} data-order-contact={orderId} data-order-contact-role={data.role}>
      <p className="text-[12px] font-semibold text-text-muted">
        {data.role === 'merchant' ? loc('الزبون — للتواصل والتسليم', 'The customer — contact and delivery') : loc('التاجر — للتواصل', 'The merchant — contact')}
      </p>
      {c ? (
        <div className="mt-2 space-y-1.5 text-[13px]">
          <p className="flex items-center gap-2 font-semibold text-text-primary">
            {data.role === 'customer' && <Store aria-hidden="true" className="h-4 w-4 text-text-muted" />}
            <bdi>{data.role === 'merchant' ? c.name : c.store_name}</bdi>
          </p>
          {c.phone ? (
            <a href={`tel:${c.phone}`} className="inline-flex min-h-[44px] items-center gap-2 rounded text-gold underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" dir="ltr">
              <Phone aria-hidden="true" className="h-4 w-4" />
              {c.phone}
            </a>
          ) : (
            <p className="text-text-muted">{loc('لا رقم مسجّل — تواصل عبر المحادثة.', 'No phone on file — use the conversation.')}</p>
          )}
          {data.role === 'merchant' && (
            <p className="flex items-start gap-2 text-text-secondary">
              <MapPin aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
              <span dir="auto" className="min-w-0 break-words">
                {c.delivery_method === 'pickup' ? loc('يستلمه بنفسه من ورشتك', 'Collects it from your workshop') : place || loc('لا عنوان محفوظ — اسأله في المحادثة.', 'No saved address — ask in the conversation.')}
              </span>
            </p>
          )}
          {c.delivery_method && <p className="text-[12px] text-text-muted">{deliveryLabel(c.delivery_method, loc)}</p>}
        </div>
      ) : (
        <p className="mt-1.5 text-[12.5px] text-text-secondary">{loc('تواصلا عبر محادثة الطلب.', 'Talk through the request conversation.')}</p>
      )}
      <Button variant="secondary" size="sm" className="mt-3" icon={<MessageCircle aria-hidden="true" className="h-4 w-4" />} onClick={openChat} data-order-chat={orderId}>
        {loc('افتح المحادثة', 'Open conversation')}
      </Button>
    </div>
  );
}
