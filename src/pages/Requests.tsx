/**
 * The customer-request marketplace — /requests.
 *
 * A customer describes a job; merchants offer; the customer picks one and the
 * money is held until the work is done.
 *
 * WHAT THIS PAGE SHOWS AND DOES NOT. The board is public, so it shows the JOB
 * — title, quantity, material, budget, governorate — and a display name. It
 * never shows a phone, an email or an address, and that is enforced by the
 * server's SELECT list rather than by this page choosing what to render
 * (§24). If this component asked for more, it would not get it.
 *
 * ACCEPTING AN OFFER MOVES MONEY, so the confirmation says so plainly: the
 * amount leaves the customer's available balance and is HELD, not paid, and
 * the merchant is only paid when the customer confirms delivery. A customer
 * who does not understand that is a customer who will open a dispute over
 * something working correctly.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  Plus, Loader2, PackageSearch, Clock, MapPin, Star, BadgeCheck, ShieldCheck,
  ChevronLeft, Send, X,
} from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { api, ApiError } from '../lib/api';
import { iqd, badgeLabel, merchantApi, type MerchantMe } from '../lib/merchant';
import { GOVERNORATE_LABELS, GOVERNORATES } from '../lib/governorates';
import {
  AttachmentDraft, AttachmentList, uploadRequestFiles, type RequestFile,
} from '../components/media/RequestAttachments';

interface RequestRow {
  id: string;
  title: string;
  description: string;
  category: string;
  quantity: number;
  material: string;
  color: string;
  dimensions: string;
  budget_iqd: number | null;
  deadline: string | null;
  governorate: string;
  state: string;
  offer_count: number;
  created_at: string;
  customer_name: string | null;
}

interface OfferRow {
  id: string;
  price_iqd: number;
  completion_days: number;
  delivery_method: string;
  message: string;
  warranty_terms: string;
  state: string;
  merchant: {
    id: string;
    name: string;
    verified: boolean;
    badge: string;
    rating: number | null;
    rating_count: number;
    completed_orders: number;
    store_slug: string | null;
  } | null;
}

type View = 'board' | 'mine' | 'new';

export default function Requests() {
  const { loc } = useLanguage();
  const { user } = useAuth();
  const [view, setView] = useState<View>('board');
  const [me, setMe] = useState<MerchantMe | null>(null);
  const [open, setOpen] = useState<RequestRow | null>(null);

  useEffect(() => {
    if (!user) return;
    merchantApi.me().then(setMe).catch(() => {});
  }, [user]);

  if (open) return <RequestDetail request={open} me={me} onBack={() => setOpen(null)} />;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-300 pb-28">
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-2xl h-[380px] bg-olive/15 rounded-full blur-[120px] pointer-events-none z-0" />

      <div className="relative z-10 max-w-2xl mx-auto px-4 sm:px-6 pt-6">
        <h1 className="text-gold font-bold text-lg mb-1">
          {loc('طلبات العملاء', 'Customer requests', 'داواکاری کڕیاران')}
        </h1>
        <p className="text-zinc-500 text-[12.5px] mb-5">
          {loc(
            'اطلب شيئًا مخصصًا، واستقبل عروضًا من التجار.',
            'Ask for something custom, and receive offers from merchants.',
            'داوای شتێکی تایبەت بکە و ئۆفەر لە بازرگانەکانەوە وەربگرە.'
          )}
        </p>

        <div className="flex gap-1.5 mb-5">
          {(['board', 'mine'] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-4 min-h-[40px] rounded-2xl text-[12.5px] font-semibold border transition-colors ${
                view === v ? 'bg-olive text-white border-olive' : 'bg-white/[0.03] text-zinc-400 border-white/10'
              }`}
            >
              {v === 'board'
                ? loc('كل الطلبات', 'All requests', 'هەموو داواکاریەکان')
                : loc('طلباتي', 'My requests', 'داواکاریەکانم')}
            </button>
          ))}
          {user && (
            <button
              onClick={() => setView('new')}
              className="ms-auto px-4 min-h-[40px] rounded-2xl bg-olive text-white text-[12.5px] font-semibold flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              {loc('طلب جديد', 'New', 'نوێ')}
            </button>
          )}
        </div>

        {view === 'new' ? (
          <NewRequest onDone={() => setView('mine')} onCancel={() => setView('board')} />
        ) : (
          <RequestList mine={view === 'mine'} onOpen={setOpen} />
        )}
      </div>
    </div>
  );
}

function RequestList({ mine, onOpen }: { mine: boolean; onOpen: (r: RequestRow) => void }) {
  const { loc, lang } = useLanguage();
  const [rows, setRows] = useState<RequestRow[] | null>(null);

  useEffect(() => {
    setRows(null);
    api
      .get<{ requests: RequestRow[] }>(mine ? '/api/marketplace/my-requests' : '/api/marketplace/requests')
      .then((d) => setRows(d.requests))
      .catch(() => setRows([]));
  }, [mine]);

  if (rows === null) {
    return (
      <div className="py-12 flex justify-center">
        <Loader2 className="w-5 h-5 text-gold animate-spin" />
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="py-14 text-center">
        <PackageSearch className="w-9 h-9 text-zinc-600 mx-auto mb-3" />
        <p className="text-zinc-400 text-[13px]">
          {mine
            ? loc('لم تنشئ أي طلب بعد', 'You have not created a request yet', 'هێشتا داواکاریت دروست نەکردووە')
            : loc('لا توجد طلبات مفتوحة', 'No open requests', 'هیچ داواکارییەکی کراوە نییە')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <button
          key={r.id}
          onClick={() => onOpen(r)}
          className="w-full text-start rounded-2xl border border-white/10 bg-white/[0.03] p-4 active:scale-[0.99] transition-transform"
        >
          <div className="flex items-start justify-between gap-3 mb-1.5">
            <h3 className="text-white font-semibold text-[14px] leading-snug">{r.title}</h3>
            <StateChip state={r.state} />
          </div>
          <p className="text-zinc-400 text-[12.5px] line-clamp-2 leading-relaxed mb-2.5">{r.description}</p>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-zinc-500">
            {r.budget_iqd !== null && (
              <span className="text-gold font-semibold" dir="ltr">
                {loc('الميزانية', 'Budget', 'بودجە')}: {iqd(r.budget_iqd)}
              </span>
            )}
            {r.quantity > 1 && <span>×{r.quantity}</span>}
            {r.material && <span>{r.material}</span>}
            {r.governorate && (
              <span className="flex items-center gap-1">
                <MapPin className="w-3 h-3" />
                {GOVERNORATE_LABELS[r.governorate]?.[lang === 'ckb' ? 'ckb' : lang] ?? r.governorate}
              </span>
            )}
            <span className="ms-auto text-gold/80 font-semibold">
              {loc(`${r.offer_count} عرض`, `${r.offer_count} offers`, `${r.offer_count} ئۆفەر`)}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}

// --------------------------------------------------------------- detail

function RequestDetail({
  request,
  me,
  onBack,
}: {
  request: RequestRow;
  me: MerchantMe | null;
  onBack: () => void;
}) {
  const { loc } = useLanguage();
  const [offers, setOffers] = useState<OfferRow[] | null>(null);
  const [isCustomer, setIsCustomer] = useState(false);
  const [accepting, setAccepting] = useState('');
  const [error, setError] = useState('');
  const [offering, setOffering] = useState(false);
  const [files, setFiles] = useState<RequestFile[]>([]);
  const [isOwner, setIsOwner] = useState(false);

  const load = useCallback(() => {
    api
      .get<{ offers: OfferRow[]; is_customer: boolean }>(`/api/marketplace/requests/${request.id}/offers`)
      .then((d) => {
        setOffers(d.offers);
        setIsCustomer(d.is_customer);
      })
      .catch(() => setOffers([]));
  }, [request.id]);

  // The attachments come from the request itself, and so does the answer to
  // "may this caller see them" — the server decides, this page renders.
  const loadFiles = useCallback(() => {
    api
      .get<{ files: RequestFile[]; is_owner: boolean }>(`/api/marketplace/requests/${request.id}`)
      .then((d) => {
        setFiles(d.files ?? []);
        setIsOwner(!!d.is_owner);
      })
      .catch(() => setFiles([]));
  }, [request.id]);

  useEffect(load, [load]);
  useEffect(loadFiles, [loadFiles]);

  const canOffer = !!me?.can.offers && !isCustomer && ['open', 'receiving_offers'].includes(request.state);
  const alreadyOffered = (offers ?? []).some((o) => o.state === 'pending' || o.state === 'accepted');

  async function accept(offer: OfferRow) {
    // Money moves here. Say exactly what will happen before it does.
    const ok = window.confirm(
      loc(
        `سيُحجز ${iqd(offer.price_iqd)} من رصيدك الآن — لن يُدفع للتاجر إلا بعد تأكيدك للاستلام. متابعة؟`,
        `${iqd(offer.price_iqd)} will be HELD from your balance now — the merchant is only paid after you confirm delivery. Continue?`,
        `${iqd(offer.price_iqd)} لە باڵانسەکەت دەگیرێت — تەنها دوای پشتڕاستکردنەوەی وەرگرتن پارە دەدرێت بە بازرگان. بەردەوام بیت؟`
      )
    );
    if (!ok) return;

    setAccepting(offer.id);
    setError('');
    try {
      await api.post(`/api/marketplace/offers/${offer.id}/accept`);
      load();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : loc('تعذّر قبول العرض', 'Could not accept the offer', 'نەتوانرا ئۆفەرەکە پەسەند بکرێت')
      );
    } finally {
      setAccepting('');
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-300 pb-28">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 pt-6">
        <button onClick={onBack} className="inline-flex items-center gap-1.5 text-zinc-400 text-[13px] mb-4">
          <ChevronLeft className="w-4 h-4 rtl:rotate-180" />
          {loc('رجوع', 'Back', 'گەڕانەوە')}
        </button>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 mb-4">
          <div className="flex items-start justify-between gap-3 mb-2">
            <h1 className="text-white font-bold text-[16px] leading-snug">{request.title}</h1>
            <StateChip state={request.state} />
          </div>
          <p className="text-zinc-300 text-[13px] leading-relaxed whitespace-pre-wrap mb-3">{request.description}</p>

          <div className="grid grid-cols-2 gap-2 text-[12px]">
            {request.budget_iqd !== null && (
              <Detail label={loc('الميزانية', 'Budget', 'بودجە')} value={iqd(request.budget_iqd)} />
            )}
            {request.quantity > 1 && (
              <Detail label={loc('الكمية', 'Quantity', 'بڕ')} value={String(request.quantity)} />
            )}
            {request.material && <Detail label={loc('المادة', 'Material', 'ماددە')} value={request.material} />}
            {request.color && <Detail label={loc('اللون', 'Colour', 'ڕەنگ')} value={request.color} />}
            {request.dimensions && (
              <Detail label={loc('الأبعاد', 'Dimensions', 'ڕەهەندەکان')} value={request.dimensions} />
            )}
            {request.deadline && (
              <Detail label={loc('الموعد', 'Deadline', 'کاتی کۆتایی')} value={request.deadline} />
            )}
          </div>
        </div>

        {(files.length > 0 || isOwner) && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 mb-4">
            <AttachmentList
              requestId={request.id}
              files={files}
              /* Adding or removing is only offered while the request is still
                 taking offers. The API refuses it after that anyway — the
                 merchants priced against these files — but a control that
                 will be refused should not be there to press. */
              canEdit={isOwner && ['open', 'receiving_offers', 'draft'].includes(request.state)}
              onChanged={loadFiles}
            />
          </div>
        )}

        {error && (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 mb-4">
            <p className="text-red-300 text-[12.5px]">{error}</p>
          </div>
        )}

        {canOffer && !alreadyOffered && (
          <button
            onClick={() => setOffering(true)}
            className="w-full min-h-[48px] rounded-2xl bg-olive text-white font-bold text-[14px] flex items-center justify-center gap-2 mb-4"
          >
            <Send className="w-4 h-4" />
            {loc('قدّم عرضًا', 'Submit an offer', 'ئۆفەر پێشکەش بکە')}
          </button>
        )}

        {offering && (
          <OfferForm
            requestId={request.id}
            onDone={() => {
              setOffering(false);
              load();
            }}
            onCancel={() => setOffering(false)}
          />
        )}

        <h2 className="text-gold font-bold text-[13px] mb-3">
          {isCustomer
            ? loc('العروض المقدّمة', 'Offers received', 'ئۆفەرە وەرگیراوەکان')
            : loc('عرضك', 'Your offer', 'ئۆفەرەکەت')}
        </h2>

        {offers === null ? (
          <div className="py-8 flex justify-center">
            <Loader2 className="w-5 h-5 text-gold animate-spin" />
          </div>
        ) : !offers.length ? (
          <p className="text-zinc-500 text-[12.5px] py-6 text-center">
            {loc('لا توجد عروض بعد', 'No offers yet', 'هێشتا ئۆفەر نییە')}
          </p>
        ) : (
          <div className="space-y-3">
            {offers.map((o) => (
              <OfferCard
                key={o.id}
                offer={o}
                canAccept={isCustomer && o.state === 'pending' && ['open', 'receiving_offers'].includes(request.state)}
                accepting={accepting === o.id}
                onAccept={() => accept(o)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function OfferCard({
  offer,
  canAccept,
  accepting,
  onAccept,
}: {
  offer: OfferRow;
  canAccept: boolean;
  accepting: boolean;
  onAccept: () => void;
}) {
  const { loc } = useLanguage();
  const m = offer.merchant;

  return (
    <div
      className={`rounded-2xl border p-4 ${
        offer.state === 'accepted' ? 'border-emerald-500/40 bg-emerald-500/[0.06]' : 'border-white/10 bg-white/[0.03]'
      }`}
    >
      <div className="flex items-start justify-between gap-3 mb-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-white font-semibold text-[13.5px] truncate">{m?.name ?? '—'}</span>
            {m?.verified && <BadgeCheck className="w-3.5 h-3.5 text-gold shrink-0" />}
          </div>
          {/* Reputation, so a customer can compare on more than price (§27). */}
          <div className="flex items-center gap-2 mt-0.5 text-[11.5px] text-zinc-500">
            {m && <span className="text-gold/80">{badgeLabel(m.badge, loc)}</span>}
            {m?.rating !== null && m?.rating !== undefined && (
              <span className="flex items-center gap-0.5">
                <Star className="w-3 h-3 text-gold fill-gold" />
                {m.rating.toFixed(1)} ({m.rating_count})
              </span>
            )}
            {!!m?.completed_orders && (
              <span>{loc(`${m.completed_orders} طلب`, `${m.completed_orders} orders`, `${m.completed_orders} داواکاری`)}</span>
            )}
          </div>
        </div>
        <span className="text-gold font-bold text-[15px] shrink-0" dir="ltr">{iqd(offer.price_iqd)}</span>
      </div>

      {offer.completion_days > 0 && (
        <div className="flex items-center gap-1.5 text-zinc-400 text-[12px] mb-2">
          <Clock className="w-3.5 h-3.5" />
          {loc(`خلال ${offer.completion_days} يوم`, `In ${offer.completion_days} days`, `لە ${offer.completion_days} ڕۆژدا`)}
        </div>
      )}

      {offer.message && <p className="text-zinc-300 text-[12.5px] leading-relaxed mb-2">{offer.message}</p>}
      {offer.warranty_terms && (
        <div className="flex items-start gap-1.5 text-zinc-400 text-[11.5px] mb-2">
          <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {offer.warranty_terms}
        </div>
      )}

      <div className="flex gap-2 mt-3">
        {m?.store_slug && (
          <Link
            to={`/community/store/${m.store_slug}`}
            className="flex-1 min-h-[40px] rounded-xl border border-white/10 bg-white/[0.03] text-zinc-300 text-[12px] font-semibold flex items-center justify-center"
          >
            {loc('زيارة المتجر', 'View store', 'بینینی فرۆشگا')}
          </Link>
        )}
        {canAccept && (
          <button
            onClick={onAccept}
            disabled={accepting}
            className="flex-1 min-h-[40px] rounded-xl bg-olive text-white text-[12px] font-bold flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            {accepting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {loc('اقبل العرض', 'Accept offer', 'ئۆفەر پەسەند بکە')}
          </button>
        )}
        {offer.state === 'accepted' && (
          <span className="flex-1 min-h-[40px] rounded-xl bg-emerald-500/10 text-emerald-400 text-[12px] font-bold flex items-center justify-center">
            {loc('مقبول', 'Accepted', 'پەسەندکراو')}
          </span>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- creation

function NewRequest({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { loc, lang } = useLanguage();
  const [f, setF] = useState({
    title: '',
    description: '',
    category: '',
    quantity: 1,
    material: '',
    color: '',
    dimensions: '',
    budget_iqd: '' as string,
    governorate: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);

  async function submit() {
    setSaving(true);
    setError('');
    try {
      // A file belongs to a request, so the request has to exist first. Two
      // steps, and the second one is reported honestly: a posted request with
      // a failed attachment is still a posted request, and telling the
      // customer their model uploaded when it did not is how a merchant ends
      // up quoting on nothing.
      const created = await api.post<{ request: { id: string } }>('/api/marketplace/requests', {
        ...f,
        budget_iqd: f.budget_iqd === '' ? null : Number(f.budget_iqd),
      });
      if (attachments.length) {
        const failed = await uploadRequestFiles(created.request.id, attachments);
        if (failed) {
          alert(loc(
            `نُشر طلبك، لكن تعذّر رفع ${failed} من الملفات. يمكنك إضافتها من صفحة الطلب.`,
            `Your request was posted, but ${failed} file(s) did not upload. You can add them from the request page.`,
            `داواکارییەکەت بڵاوکرایەوە، بەڵام ${failed} فایل بار نەکرا.`
          ));
        }
      }
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : loc('تعذّر الإرسال', 'Could not submit', 'نەتوانرا بنێردرێت'));
      setSaving(false);
    }
  }

  const valid = f.title.trim().length >= 4 && f.description.trim().length >= 10;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-gold font-bold text-[14px]">{loc('طلب جديد', 'New request', 'داواکاری نوێ')}</h2>
        <button onClick={onCancel} className="text-zinc-500">
          <X className="w-4 h-4" />
        </button>
      </div>

      <F label={loc('ماذا تريد؟', 'What do you need?', 'چی دەتەوێت؟')} required>
        <input
          value={f.title}
          onChange={(e) => setF({ ...f, title: e.target.value })}
          maxLength={140}
          placeholder={loc('مثال: قطعة غيار لمكنسة', 'e.g. A replacement bracket', 'نموونە: پارچەیەکی جێگرەوە')}
          className="w-full min-h-[48px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40"
        />
      </F>

      <F label={loc('التفاصيل', 'Details', 'وردەکاری')} required>
        <textarea
          value={f.description}
          onChange={(e) => setF({ ...f, description: e.target.value })}
          rows={4}
          maxLength={6000}
          className="w-full rounded-2xl bg-black/40 border border-white/10 px-4 py-3 text-white text-[14px] outline-none focus:border-gold/40 resize-none"
        />
      </F>

      <div className="grid grid-cols-2 gap-3">
        <F label={loc('الكمية', 'Quantity', 'بڕ')}>
          <input
            type="number"
            min={1}
            value={f.quantity}
            onChange={(e) => setF({ ...f, quantity: Number(e.target.value) || 1 })}
            className="w-full min-h-[48px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40"
          />
        </F>
        <F label={loc('الميزانية (اختياري)', 'Budget (optional)', 'بودجە')}>
          <input
            type="number"
            value={f.budget_iqd}
            onChange={(e) => setF({ ...f, budget_iqd: e.target.value })}
            className="w-full min-h-[48px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40"
          />
        </F>
        <F label={loc('المادة', 'Material', 'ماددە')}>
          <input
            value={f.material}
            onChange={(e) => setF({ ...f, material: e.target.value })}
            className="w-full min-h-[48px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40"
          />
        </F>
        <F label={loc('اللون', 'Colour', 'ڕەنگ')}>
          <input
            value={f.color}
            onChange={(e) => setF({ ...f, color: e.target.value })}
            className="w-full min-h-[48px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40"
          />
        </F>
      </div>

      <F label={loc('المحافظة', 'Governorate', 'پارێزگا')}>
        <select
          value={f.governorate}
          onChange={(e) => setF({ ...f, governorate: e.target.value })}
          className="w-full min-h-[48px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40"
        >
          <option value="">{loc('اختر', 'Select', 'هەڵبژێرە')}</option>
          {GOVERNORATES.map((g) => (
            <option key={g.id} value={g.id} className="bg-[#0a0a0a]">
              {lang === 'ar' ? g.ar : lang === 'ckb' ? g.ckb : g.en}
            </option>
          ))}
        </select>
      </F>

      <F label={loc('المرفقات', 'Attachments', 'هاوپێچەکان')}>
        <AttachmentDraft files={attachments} onChange={setAttachments} />
      </F>

      {error && <p className="text-red-400 text-[12.5px]">{error}</p>}

      <button
        onClick={submit}
        disabled={!valid || saving}
        className="w-full min-h-[48px] rounded-2xl bg-olive text-white font-bold text-[14px] flex items-center justify-center gap-2 disabled:opacity-40"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        {loc('انشر الطلب', 'Post request', 'داواکاری بڵاو بکەرەوە')}
      </button>
    </motion.div>
  );
}

function OfferForm({
  requestId,
  onDone,
  onCancel,
}: {
  requestId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { loc } = useLanguage();
  const [f, setF] = useState({ price_iqd: '', completion_days: '', message: '', warranty_terms: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setSaving(true);
    setError('');
    try {
      await api.post(`/api/marketplace/requests/${requestId}/offers`, {
        price_iqd: Number(f.price_iqd),
        completion_days: Number(f.completion_days) || 0,
        message: f.message,
        warranty_terms: f.warranty_terms,
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : loc('تعذّر الإرسال', 'Could not submit', 'نەتوانرا بنێردرێت'));
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-4 mb-4">
      <div className="flex items-center justify-between">
        <h3 className="text-gold font-bold text-[13px]">{loc('عرضك', 'Your offer', 'ئۆفەرەکەت')}</h3>
        <button onClick={onCancel} className="text-zinc-500">
          <X className="w-4 h-4" />
        </button>
      </div>

      <F label={loc('السعر (د.ع)', 'Price (IQD)', 'نرخ')} required>
        <input
          type="number"
          value={f.price_iqd}
          onChange={(e) => setF({ ...f, price_iqd: e.target.value })}
          className="w-full min-h-[48px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40"
        />
      </F>
      <F label={loc('مدة التنفيذ (أيام)', 'Completion (days)', 'ماوەی تەواوکردن')}>
        <input
          type="number"
          value={f.completion_days}
          onChange={(e) => setF({ ...f, completion_days: e.target.value })}
          className="w-full min-h-[48px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40"
        />
      </F>
      <F label={loc('رسالة للعميل', 'Message to the customer', 'نامە بۆ کڕیار')}>
        <textarea
          value={f.message}
          onChange={(e) => setF({ ...f, message: e.target.value })}
          rows={3}
          className="w-full rounded-2xl bg-black/40 border border-white/10 px-4 py-3 text-white text-[14px] outline-none focus:border-gold/40 resize-none"
        />
      </F>
      <F label={loc('الضمان (اختياري)', 'Warranty (optional)', 'گەرەنتی')}>
        <input
          value={f.warranty_terms}
          onChange={(e) => setF({ ...f, warranty_terms: e.target.value })}
          className="w-full min-h-[48px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40"
        />
      </F>

      {error && <p className="text-red-400 text-[12.5px]">{error}</p>}

      <p className="text-zinc-600 text-[11.5px] leading-relaxed">
        {loc(
          'بعد قبول العميل لعرضك، لا يمكن تغيير السعر أو المدة.',
          'Once the customer accepts, the price and timeline cannot be changed.',
          'دوای پەسەندکردنی کڕیار، نرخ و ماوە ناگۆڕدرێن.'
        )}
      </p>

      <button
        onClick={submit}
        disabled={saving || !f.price_iqd}
        className="w-full min-h-[48px] rounded-2xl bg-olive text-white font-bold text-[14px] flex items-center justify-center gap-2 disabled:opacity-40"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        {loc('أرسل العرض', 'Send offer', 'ئۆفەر بنێرە')}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ bits

function F({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-zinc-400 text-[12.5px] font-semibold mb-2">
        {label}
        {required && <span className="text-gold ms-1">*</span>}
      </label>
      {children}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-black/30 border border-white/5 px-3 py-2">
      <p className="text-zinc-600 text-[10.5px] mb-0.5">{label}</p>
      <p className="text-zinc-200 text-[12px] font-semibold" dir="auto">{value}</p>
    </div>
  );
}

function StateChip({ state }: { state: string }) {
  const { loc } = useLanguage();
  const map: Record<string, string> = {
    open: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    receiving_offers: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    offer_selected: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
    in_progress: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
    delivered: 'bg-purple-500/10 text-purple-300 border-purple-500/20',
    completed: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    disputed: 'bg-red-500/10 text-red-300 border-red-500/20',
    cancelled: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
    expired: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  };
  const label: Record<string, string> = {
    open: loc('مفتوح', 'Open', 'کراوە'),
    receiving_offers: loc('يستقبل عروضًا', 'Receiving offers', 'ئۆفەر وەردەگرێت'),
    offer_selected: loc('تم اختيار عرض', 'Offer selected', 'ئۆفەر هەڵبژێردرا'),
    in_progress: loc('قيد التنفيذ', 'In progress', 'لە جێبەجێکردندا'),
    delivered: loc('تم التسليم', 'Delivered', 'گەیشت'),
    completed: loc('مكتمل', 'Completed', 'تەواو'),
    disputed: loc('نزاع', 'Disputed', 'ناکۆکی'),
    cancelled: loc('ملغي', 'Cancelled', 'هەڵوەشێنراوە'),
    expired: loc('منتهٍ', 'Expired', 'بەسەرچوو'),
  };
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${map[state] ?? map.open}`}>
      {label[state] ?? state}
    </span>
  );
}
