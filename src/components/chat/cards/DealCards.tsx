/**
 * THE DEAL, IN THE CONVERSATION — a print request, a quote, a private product
 * (docs/COMMUNITY_COMMERCE_CHAT.md §4).
 *
 * Each card shows what it FROZE when it was sent (the request as written, the
 * quote's terms at that revision, the private product as made) and says what it
 * is NOW in words. Its buttons are the server's `current.actions` and nothing
 * else, and each one is an existing door: acceptance is the escrow's own
 * (`/api/marketplace/offers/:id/accept`, sent with the price and revision THIS
 * card showed), a private product is bought through the store cart.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Calculator, FileText, Printer, Sparkles, Image as ImageIcon, Box } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useMoney } from '../../../CurrencyContext';
import { ApiError } from '../../../lib/api';
import { toast } from '../../../lib/toastStore';
import { chatCommerceApi } from '../../../lib/chatCommerceApi';
import { merchantHref } from '../../../lib/merchantRoutes';
import type { ChatCard } from '../../../lib/chatCards';
import { useConfirm } from '../../ui/ConfirmDialog';
import { useCardActions } from './cardContext';
import { daysText, deliveryText, statusText } from './cardWords';
import { CardActions, CardButton, CardKicker, CardShell, Fact, StatusLine, shortDate, toneOf } from './parts';
import { useAddToCart } from './useAddToCart';

interface Props {
  card: ChatCard;
  mine: boolean;
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

/** Run a card action: busy while it runs, the refusal in the reader's words, the thread re-read after. */
function useCardRun() {
  const { lang, loc } = useLanguage();
  const actions = useCardActions();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  async function run(name: string, work: () => Promise<unknown>, done?: string): Promise<boolean> {
    setBusy(name);
    try {
      await work();
      if (done) toast.success(done);
      await actions?.refresh();
      return true;
    } catch (e) {
      const fallback = loc('تعذّر إتمام العملية', 'That could not be done');
      const { apiRefusal } = await import('../../../lib/refusalStrings');
      const text = e instanceof ApiError ? apiRefusal(e, lang, fallback) : fallback;
      if (e instanceof ApiError && e.code === 'INSUFFICIENT_FUNDS') {
        toast.error(text, { action: { label: loc('اشحن المحفظة', 'Top up the wallet'), onClick: () => navigate('/wallet') } });
      } else {
        toast.error(text);
      }
      // A changed quote or request: show the conversation as it now is.
      if (e instanceof ApiError && e.status === 409) await actions?.refresh();
      return false;
    } finally {
      setBusy(null);
    }
  }
  return { busy, run };
}

const sideOf = (role: string | undefined): 'customer' | 'merchant' | 'other' =>
  role === 'customer' ? 'customer' : role === 'merchant' ? 'merchant' : 'other';

// ============================================================ quote

export function QuoteCardView({ card, mine }: Props) {
  const { lang, loc } = useLanguage();
  const { moneyBoth } = useMoney();
  const navigate = useNavigate();
  const actions = useCardActions();
  const { busy, run } = useCardRun();
  const [confirm, dialog] = useConfirm();
  const s = card.original;
  const cur = card.current;
  const side = sideOf(actions?.role);
  const price = Number(s.price_iqd ?? 0);
  const revision = Number(s.revision ?? 1);
  const title = str(s.title);
  const can = new Set(cur.actions ?? []);
  const job = [num(s.quantity) && Number(s.quantity) > 1 ? loc(`${s.quantity} قطع`, `${s.quantity} pieces`) : '', str(s.material), str(s.color)]
    .filter(Boolean)
    .join(' · ');

  const accept = async () => {
    const yes = await confirm({
      title: loc(`قبول العرض بـ ${moneyBoth(price)}؟`, `Accept the quote for ${moneyBoth(price)}?`),
      consequence: loc(
        'يُحجز المبلغ من محفظتك في الضمان، ولا يصل إلى المتجر إلا بعد أن تؤكّد استلام الطلب. إن لم يصلك ما اتفقتما عليه يمكنك فتح نزاع.',
        'The amount is held from your wallet in escrow and reaches the store only after you confirm receipt. If you do not get what you agreed, you can open a dispute.'
      ),
      confirmLabel: loc('قبول وحجز المبلغ', 'Accept and hold the money'),
    });
    if (!yes) return;
    await run('accept', () => chatCommerceApi.accept(card.ref, { price_iqd: price, revision }), loc('قُبل العرض — المبلغ محجوز في الضمان', 'Quote accepted — the money is held'));
  };
  const decline = async () => {
    const yes = await confirm({
      title: loc('رفض هذا العرض؟', 'Decline this quote?'),
      consequence: loc('سيُبلَّغ المتجر، ويمكنه أن يرسل عرضًا آخر.', 'The store is told and may send another quote.'),
      confirmLabel: loc('رفض العرض', 'Decline'),
      destructive: true,
    });
    if (yes) await run('decline', () => chatCommerceApi.decline(card.ref));
  };
  const withdraw = async () => {
    const yes = await confirm({
      title: loc('سحب هذا العرض؟', 'Withdraw this quote?'),
      consequence: loc('لن يستطيع الزبون قبوله بعد الآن.', 'The customer will no longer be able to accept it.'),
      confirmLabel: loc('سحب العرض', 'Withdraw'),
      destructive: true,
    });
    if (yes) await run('withdraw', () => chatCommerceApi.withdraw(card.ref));
  };

  const orderId = typeof cur.order_id === 'string' ? cur.order_id : null;
  return (
    <CardShell mine={mine} kind="quote" label={loc(`عرض سعر: ${title}`, `Quote: ${title}`)}>
      <div className="p-3 flex flex-col gap-2">
        <CardKicker icon={Calculator}>{loc('عرض سعر', 'Quote')}{revision > 1 ? loc(` — التعديل ${revision}`, ` — revision ${revision}`) : ''}</CardKicker>
        <h3 dir="auto" className="text-[14px] font-bold leading-snug">{title}</h3>
        {job && <p dir="auto" className="text-[12.5px] text-text-secondary">{job}</p>}
        <p className="text-[18px] font-extrabold tabular-nums" data-card-price>{moneyBoth(price)}</p>
        <dl className="flex flex-col gap-1">
          <Fact label={loc('مدة التنفيذ', 'Ready in')}>{daysText(Number(s.completion_days ?? 0), loc)}</Fact>
          <Fact label={loc('التسليم', 'Handover')}>{deliveryText(s.delivery_method, loc)}</Fact>
          <Fact label={loc('يشمل', 'Includes')}>{str(s.included)}</Fact>
          <Fact label={loc('الضمان', 'Warranty')}>{str(s.warranty_terms)}</Fact>
          <Fact label={loc('صالح حتى', 'Valid until')}>{shortDate(s.expires_at, lang)}</Fact>
        </dl>
        {str(s.message) && <p dir="auto" className="text-[12.5px] text-text-secondary whitespace-pre-wrap break-words">{str(s.message)}</p>}
        <StatusLine tone={toneOf(cur.status)}>{statusText('quote', cur.status, loc, side)}</StatusLine>
        {(can.size > 0 || orderId) && (
          <CardActions>
            {can.has('accept') && <CardButton action="accept" variant="primary" busy={busy === 'accept'} onClick={() => void accept()}>{loc('قبول العرض', 'Accept')}</CardButton>}
            {can.has('decline') && <CardButton action="decline" busy={busy === 'decline'} onClick={() => void decline()}>{loc('رفض', 'Decline')}</CardButton>}
            {can.has('reconfirm') && (
              <CardButton action="reconfirm" variant="primary" busy={busy === 'reconfirm'} onClick={() => void run('reconfirm', () => chatCommerceApi.reconfirm(card.ref), loc('أكّدت عرضك للطلب كما هو الآن', 'You re-confirmed your quote'))}>
                {loc('أؤكّد عرضي', 'Re-confirm')}
              </CardButton>
            )}
            {can.has('edit') && (
              <CardButton action="edit" onClick={() => actions?.openQuote({ requestId: str(s.request_id), edit: { offerId: card.ref, snapshot: s } })}>
                {loc('تعديل العرض', 'Edit')}
              </CardButton>
            )}
            {can.has('edit') && (
              <CardButton action="to_product" variant="ghost" onClick={() => actions?.openCustomProduct({ quoteId: card.ref, name: title, price_iqd: price, prep_days: Number(s.completion_days ?? 0) })}>
                {loc('حوّله إلى منتج خاص', 'Make it a private product')}
              </CardButton>
            )}
            {can.has('withdraw') && <CardButton action="withdraw" variant="danger" busy={busy === 'withdraw'} onClick={() => void withdraw()}>{loc('سحب', 'Withdraw')}</CardButton>}
            {orderId && (
              <CardButton
                action="view_order"
                onClick={() => navigate(side === 'merchant' ? merchantHref.customOrder(orderId) : `/requests?request=${encodeURIComponent(str(s.request_id))}`)}
              >
                {loc('عرض الطلب', 'View the order')}
              </CardButton>
            )}
          </CardActions>
        )}
      </div>
      {dialog}
    </CardShell>
  );
}

// ============================================================ print request

interface RequestFile {
  id: string;
  name: string;
  kind: string;
  inline: boolean;
}

export function PrintRequestCardView({ card, mine }: Props) {
  const { lang, loc } = useLanguage();
  const { money } = useMoney();
  const actions = useCardActions();
  const { busy, run } = useCardRun();
  const [confirm, dialog] = useConfirm();
  const [open, setOpen] = useState(false);
  const s = card.original;
  const cur = card.current;
  const side = sideOf(actions?.role);
  const requestId = str(s.request_id);
  const files = (Array.isArray(s.files) ? s.files : []) as RequestFile[];
  const can = new Set(cur.actions ?? []);
  const description = str(s.description);
  const long = description.length > 180;
  const job = [num(s.quantity) && Number(s.quantity) > 1 ? loc(`${s.quantity} قطع`, `${s.quantity} pieces`) : loc('قطعة واحدة', 'One piece'), str(s.material), str(s.color), str(s.dimensions)]
    .filter(Boolean)
    .join(' · ');
  const fileUrl = (f: RequestFile) => `/api/marketplace/requests/${encodeURIComponent(requestId)}/files/${encodeURIComponent(f.id)}`;

  const cancel = async () => {
    const yes = await confirm({
      title: loc('إلغاء طلب الطباعة؟', 'Cancel this print request?'),
      consequence: loc('يُغلق الطلب وأي عرض سعر عليه. لا يُخصم منك شيء.', 'The request and any quote on it close. Nothing is charged.'),
      confirmLabel: loc('إلغاء الطلب', 'Cancel the request'),
      destructive: true,
    });
    if (yes) await run('cancel', () => chatCommerceApi.cancelRequest(requestId));
  };

  return (
    <CardShell mine={mine} kind="print_request" label={loc(`طلب طباعة: ${str(s.title)}`, `Print request: ${str(s.title)}`)}>
      <div className="p-3 flex flex-col gap-2">
        <CardKicker icon={Printer}>
          {s.created_by === 'merchant'
            ? side === 'merchant' ? loc('طلب كتبته للزبون', 'A job you wrote for the customer') : loc('طلب أنشأه المتجر لك', 'A job the store wrote for you')
            : side === 'merchant' ? loc('طلب طباعة لمتجرك', 'Print request to your store') : loc('طلب طباعة لهذا المتجر', 'Print request to this store')}
        </CardKicker>
        <h3 dir="auto" className="text-[14px] font-bold leading-snug">{str(s.title)}</h3>
        <p dir="auto" className="text-[12.5px] text-text-secondary">{job}</p>
        {description && (
          <p dir="auto" className={`text-[12.5px] text-text-primary whitespace-pre-wrap break-words ${long && !open ? 'line-clamp-4' : ''}`}>{description}</p>
        )}
        {long && (
          <button type="button" onClick={() => setOpen((v) => !v)} className="self-start text-[12px] font-semibold text-text-secondary underline underline-offset-2">
            {open ? loc('عرض أقل', 'Show less') : loc('عرض الكل', 'Show all')}
          </button>
        )}
        <dl className="flex flex-col gap-1">
          <Fact label={loc('الميزانية', 'Budget')}>{num(s.budget_iqd) ? money(Number(s.budget_iqd)) : ''}</Fact>
          <Fact label={loc('مطلوب قبل', 'Needed by')}>{shortDate(s.deadline, lang)}</Fact>
          <Fact label={loc('ملاحظات', 'Notes')}>{str(s.notes)}</Fact>
        </dl>
        {files.length > 0 && (
          <ul className="flex flex-col gap-1.5" aria-label={loc('المرفقات', 'Attachments')}>
            {files.map((f) => (
              <li key={f.id} className="flex items-center gap-2 text-[12.5px]">
                {f.inline ? (
                  <a href={fileUrl(f)} target="_blank" rel="noreferrer" className="w-10 h-10 rounded-md overflow-hidden bg-surface-raised shrink-0">
                    <img referrerPolicy="no-referrer" src={fileUrl(f)} alt="" loading="lazy" className="w-full h-full object-cover" />
                  </a>
                ) : (
                  <span className="w-10 h-10 rounded-md bg-surface-raised flex items-center justify-center shrink-0">
                    {f.kind === 'model' ? <Box className="w-4 h-4 text-text-muted" aria-hidden="true" /> : <FileText className="w-4 h-4 text-text-muted" aria-hidden="true" />}
                  </span>
                )}
                <span dir="auto" className="min-w-0 flex-1 truncate">{f.name}</span>
                {f.kind === 'model' && side === 'merchant' && (
                  <span className="text-[11px] text-text-muted shrink-0">{loc('يُفتح بعد القبول', 'Opens after acceptance')}</span>
                )}
                {!f.inline && f.kind !== 'model' && (
                  <a href={fileUrl(f)} target="_blank" rel="noreferrer" className="text-[12px] font-semibold text-text-secondary underline underline-offset-2 shrink-0">
                    {loc('فتح', 'Open')}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
        <StatusLine tone={toneOf(cur.status)}>{statusText('print_request', cur.status, loc, side)}</StatusLine>
        {can.size > 0 && (
          <CardActions>
            {can.has('quote') && (
              <CardButton action="quote" variant="primary" onClick={() => actions?.openQuote({ requestId })}>{loc('أرسل عرض سعر', 'Send a quote')}</CardButton>
            )}
            {can.has('edit_quote') && typeof cur.offer_id === 'string' && (
              <CardButton action="edit_quote" onClick={() => actions?.openQuote({ requestId, edit: { offerId: String(cur.offer_id), snapshot: {} } })}>
                {loc('عدّل عرضك', 'Edit your quote')}
              </CardButton>
            )}
            {can.has('cancel') && <CardButton action="cancel" variant="danger" busy={busy === 'cancel'} onClick={() => void cancel()}>{loc('إلغاء الطلب', 'Cancel request')}</CardButton>}
          </CardActions>
        )}
      </div>
      {dialog}
    </CardShell>
  );
}

// ============================================================ private product

export function CustomProductCardView({ card, mine }: Props) {
  const { lang, loc } = useLanguage();
  const { moneyBoth } = useMoney();
  const navigate = useNavigate();
  const actions = useCardActions();
  const { busy, run } = useCardRun();
  const cart = useAddToCart();
  const [confirm, dialog] = useConfirm();
  const s = card.original;
  const cur = card.current;
  const side = sideOf(actions?.role);
  const name = lang !== 'en' && str(s.name_ar) ? str(s.name_ar) : str(s.name);
  const can = new Set(cur.actions ?? []);
  const orderId = typeof cur.order_id === 'string' ? cur.order_id : null;

  const cancel = async () => {
    const yes = await confirm({
      title: loc('إلغاء هذا المنتج الخاص؟', 'Cancel this private product?'),
      consequence: loc('لن يستطيع الزبون شراءه، ويُحذف من سلته إن أضافه.', 'The customer can no longer buy it, and it leaves their cart.'),
      confirmLabel: loc('إلغاء المنتج', 'Cancel the product'),
      destructive: true,
    });
    if (yes && actions) await run('cancel', () => chatCommerceApi.cancelCustomProduct(actions.chatId, card.ref));
  };

  return (
    <CardShell mine={mine} kind="custom_product" label={loc(`منتج خاص: ${name}`, `Private product: ${name}`)}>
      {typeof s.image === 'string' && s.image ? (
        <img referrerPolicy="no-referrer" src={s.image} alt="" loading="lazy" className="aspect-[4/3] w-full object-cover bg-surface-raised" />
      ) : (
        <div className="aspect-[4/3] w-full bg-surface-raised flex items-center justify-center">
          <ImageIcon className="w-7 h-7 text-text-muted" strokeWidth={1.5} aria-hidden="true" />
        </div>
      )}
      <div className="p-3 flex flex-col gap-2">
        <CardKicker icon={Sparkles}>{side === 'customer' ? loc('منتج خاص لك', 'Made for you') : loc('منتج خاص للزبون', 'Private product for this customer')}</CardKicker>
        <h3 dir="auto" className="text-[14px] font-bold leading-snug">{name}</h3>
        {str(s.description) && <p dir="auto" className="text-[12.5px] text-text-secondary whitespace-pre-wrap break-words line-clamp-5">{str(s.description)}</p>}
        <p className="text-[17px] font-extrabold tabular-nums" data-card-price>{moneyBoth(Number(s.price_iqd ?? 0))}</p>
        <dl className="flex flex-col gap-1">
          <Fact label={loc('التجهيز', 'Preparation')}>{daysText(Number(s.prep_days ?? 0), loc)}</Fact>
          <Fact label={loc('متاح حتى', 'Available until')}>{shortDate(s.expires_at, lang)}</Fact>
        </dl>
        <StatusLine tone={toneOf(cur.status)}>{statusText('custom_product', cur.status, loc, side)}</StatusLine>
        {(can.size > 0) && (
          <CardActions>
            {can.has('add_to_cart') && (
              <CardButton action="add_to_cart" variant="primary" busy={cart.busy} onClick={() => void cart.add(card.ref, name)}>
                {loc('أضف إلى السلة', 'Add to cart')}
              </CardButton>
            )}
            {can.has('cancel') && <CardButton action="cancel" variant="danger" busy={busy === 'cancel'} onClick={() => void cancel()}>{loc('إلغاء', 'Cancel')}</CardButton>}
            {can.has('view_order') && orderId && (
              <CardButton action="view_order" onClick={() => navigate(side === 'merchant' ? merchantHref.order(orderId) : `/orders/${encodeURIComponent(orderId)}`)}>
                {loc('عرض الطلب', 'View the order')}
              </CardButton>
            )}
          </CardActions>
        )}
      </div>
      {cart.dialog}
      {dialog}
    </CardShell>
  );
}
