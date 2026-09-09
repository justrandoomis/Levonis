/**
 * THE ADDRESS BOOK.
 *
 * WHAT WAS WRONG WITH IT, in the order a customer would hit it.
 *
 * 1. IT WAS IN ENGLISH. Roughly twenty hardcoded English strings — 'My
 *    Addresses', 'Add address', 'Edit', 'Delete', 'Set Default', 'Recipient
 *    details', the delete confirmation — rendered inside an RTL box on an
 *    Arabic-first store. The only translated block was the governorate group
 *    added later. Every string here is `loc(ar, en, ckb)` now, and every
 *    physical direction class (`right-0`, `ml-auto`, `-ml-2`, `rounded-bl-xl`)
 *    is logical, so the layout mirrors instead of pointing the wrong way.
 *
 * 2. THE SAVE BUTTON WAS INVISIBLE. `bg-olive/20 text-olive` — olive is
 *    #1B2010, a near-black green — measures 1.16:1 against this page's ground.
 *    WCAG asks 4.5:1 for text. The primary action of the screen could not be
 *    read. It is the house gold CTA now, like every other primary action.
 *
 * 3. THE PHONE WAS NEVER VALIDATED. `'+964-' + typed`, with the only check
 *    being non-empty, and the result copied straight onto the courier's
 *    shipment request. It also made editing impossible for any number not
 *    already `+964`-prefixed: the prefix was stripped only on an exact match
 *    and then re-added unconditionally, so a stored `+13105551234` round-tripped
 *    to `+964-+13105551234` and was rejected every single time. Both halves now
 *    live in `AddressForm`, and the server normalises through libphonenumber.
 *
 * 4. THE 'MAP' WAS A HOTLINKED IMGUR PHOTO — the only external image in the
 *    entire repository, `aria-hidden`, with no fallback and no function: there
 *    is no map picker, no geocoding and no coordinates anywhere near it. If
 *    imgur ever expires the id, its "image removed" graphic renders inside the
 *    form. Deleted; the card now shows the governorate that was actually
 *    chosen, which is information rather than decoration.
 *
 * 5. THE SERVER'S PRO/KYC ANSWER WAS DISCARDED. `backs_approved_snapshot` and
 *    `matches_approved_snapshot` are computed on every read specifically so
 *    this screen can explain eligibility. Both are shown now.
 *
 * 6. DOUBLE-TAPPING DELETE OR SET-DEFAULT fired twice; the second answered
 *    'Address not found'. Both are guarded.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus, MapPin, Edit2, Trash2, CheckCircle, ShieldCheck, AlertTriangle } from 'lucide-react';
import { useAuth } from '../AuthContext';
import { api, ApiAddress } from '../lib/api';
import { apiRefusal } from '../lib/refusalStrings';
import { useLanguage } from '../LanguageContext';
import { GOVERNORATES } from '../lib/governorates';
import { Overlay } from '../components/ui/Overlay';
import AddressForm from '../components/address/AddressForm';

export default function Addresses() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated, isLoaded } = useAuth();
  const { loc, lang, dir } = useLanguage();

  const [addresses, setAddresses] = useState<ApiAddress[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingAddress, setEditingAddress] = useState<ApiAddress | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  /** One write at a time. A second tap on Delete used to fire a second request
   *  and report 'Address not found' for a deletion that had just succeeded. */
  const [busyId, setBusyId] = useState<string | null>(null);

  /**
   * WHERE TO GO BACK TO, AND WHAT TO TELL IT.
   *
   * A checkout that sends someone here to add an address needs the id that was
   * created — otherwise the customer returns to a checkout that re-selects the
   * OLD default and ships to the wrong place. Both checkouts now embed the form
   * instead, so this is the fallback path for any caller that still routes;
   * honouring it costs one line and closes the loop either way.
   */
  const routeNext = (location.state as { next?: string } | null)?.next ?? '';

  // The Delete button of the row being asked about. The confirmation is a
  // question about ONE address out of a list of otherwise identical cards, and
  // its copy never names which one — so the only thing on screen that says
  // "this address" is where the dialog comes from. Holding the element that was
  // pressed lets the window scale out of that exact button and collapse back
  // into it. It is a plain ref rather than state on purpose: it must be set
  // synchronously, before the render that opens the window reads it.
  const deleteAnchor = useRef<HTMLElement | null>(null);

  const loadAddresses = useCallback(async () => {
    setListError('');
    try {
      const data = await api.get<{ addresses: ApiAddress[] }>('/api/addresses');
      setAddresses(data.addresses);
    } catch (err) {
      setListError(apiRefusal(err, lang as 'ar' | 'en' | 'ckb', loc('تعذّر تحميل العناوين', 'Could not load your addresses', 'نەتوانرا ناونیشانەکان بار بکرێن')));
    } finally {
      setIsLoading(false);
    }
  }, [lang, loc]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isAuthenticated) {
      setIsLoading(false);
      return;
    }
    loadAddresses();
  }, [isLoaded, isAuthenticated, loadAddresses]);

  const openAdd = () => {
    setEditingAddress(null);
    setEditorOpen(true);
  };

  const openEdit = (addr: ApiAddress) => {
    setEditingAddress(addr);
    setEditorOpen(true);
  };

  const handleSaved = async (id: string) => {
    setEditorOpen(false);
    await loadAddresses();
    if (routeNext) navigate(routeNext, { state: { addressId: id }, replace: true });
  };

  const handleDelete = async () => {
    if (!deleteConfirmId || busyId) return;
    const id = deleteConfirmId;
    setActionError('');
    setBusyId(id);
    setDeleteConfirmId(null);
    try {
      await api.delete(`/api/addresses/${id}`);
      await loadAddresses();
    } catch (err) {
      setActionError(apiRefusal(err, lang as 'ar' | 'en' | 'ckb', loc('تعذّر حذف العنوان', 'Could not delete the address', 'نەتوانرا ناونیشان بسڕدرێتەوە')));
    } finally {
      setBusyId(null);
    }
  };

  const handleSetDefault = async (id: string) => {
    if (busyId) return;
    setActionError('');
    setBusyId(id);
    try {
      await api.post(`/api/addresses/${id}/default`);
      await loadAddresses();
    } catch (err) {
      setActionError(apiRefusal(err, lang as 'ar' | 'en' | 'ckb', loc('تعذّر تعيين العنوان الافتراضي', 'Could not set the default address', 'نەتوانرا بکرێتە ناونیشانی بنەڕەت')));
    } finally {
      setBusyId(null);
    }
  };

  /** The chosen governorate's name in the reader's language, or the raw stored
   *  value when it predates the closed list — never blank, never guessed. */
  const governorateName = (id: string) => {
    if (!id) return '';
    const g = GOVERNORATES.find((x) => x.id === id);
    if (!g) return id;
    return lang === 'en' ? g.en : lang === 'ckb' ? g.ckb : g.ar;
  };

  const Back = dir === 'rtl' ? ChevronRight : ChevronLeft;

  return (
    <div className="min-h-dvh bg-black text-white w-full font-sans flex flex-col">
      <div className="flex items-center justify-between gap-2 px-4 py-3 sticky top-0 bg-black/85 backdrop-blur-xl z-10 border-b border-zinc-900">
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label={loc('رجوع', 'Back', 'گەڕانەوە')}
          className="w-11 h-11 flex items-center justify-center rounded-full hover:bg-zinc-900 transition-colors [touch-action:manipulation]"
        >
          <Back aria-hidden="true" className="w-6 h-6" />
        </button>
        <h1 className="text-[17px] font-bold">{loc('عناويني', 'My addresses', 'ناونیشانەکانم')}</h1>
        <div className="w-11" />
      </div>

      <div className="flex-1 px-4 py-4 mx-auto w-full max-w-[560px]">
        {!isAuthenticated && isLoaded ? (
          <div className="text-center py-16 text-zinc-500">
            <MapPin aria-hidden="true" className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="font-medium">{loc('سجّل الدخول لإدارة عناوينك', 'Sign in to manage your addresses', 'بچۆ ژوورەوە بۆ بەڕێوەبردنی ناونیشانەکانت')}</p>
            <button
              type="button"
              onClick={() => navigate('/auth?next=%2Faddresses')}
              className="mt-4 min-h-[44px] px-6 rounded-xl bg-gold text-black font-black text-sm hover:brightness-110 transition-[filter]"
            >
              {loc('تسجيل الدخول', 'Sign in', 'چوونەژوورەوە')}
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={openAdd}
              className="w-full min-h-[52px] rounded-2xl border border-zinc-800 bg-zinc-900/40 text-gold flex items-center justify-center gap-2 font-bold hover:border-gold/40 hover:bg-gold/[0.06] transition-colors mb-5 [touch-action:manipulation]"
            >
              <Plus aria-hidden="true" className="w-5 h-5" />
              {loc('إضافة عنوان', 'Add an address', 'زیادکردنی ناونیشان')}
            </button>

            {actionError ? (
              <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-[13px] text-red-300 mb-4">
                {actionError}
              </p>
            ) : null}
            {listError ? (
              <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-[13px] text-red-300 mb-4">
                {listError}
              </p>
            ) : null}

            {isLoading ? (
              // A skeleton of the real cards, at the top of the column where the
              // cards will be — not a spinner floating in an empty page.
              <div className="space-y-3" aria-busy="true">
                {[0, 1].map((i) => (
                  <div key={i} className="rounded-2xl border border-zinc-800/70 bg-zinc-900/40 p-4">
                    <div className="h-4 w-28 rounded bg-zinc-800 animate-pulse" />
                    <div className="h-3 w-full rounded bg-zinc-800/70 animate-pulse mt-3" />
                    <div className="h-3 w-2/3 rounded bg-zinc-800/70 animate-pulse mt-2" />
                  </div>
                ))}
              </div>
            ) : addresses.length === 0 && !listError ? (
              <div className="text-center py-12 text-zinc-500">
                <MapPin aria-hidden="true" className="w-10 h-10 mx-auto mb-3 opacity-40" />
                <p className="font-medium text-zinc-300">{loc('لا توجد عناوين محفوظة', 'No saved addresses yet', 'هێشتا هیچ ناونیشانێک پاشەکەوت نەکراوە')}</p>
                <p className="text-sm mt-1">{loc('أضف عنوان التوصيل الأول من الزر أعلاه.', 'Add your first delivery address with the button above.', 'یەکەم ناونیشانی گەیاندن بە دوگمەی سەرەوە زیاد بکە.')}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {addresses.map((addr) => {
                  const isDefault = addr.is_default === 1;
                  const diverged = addr.matches_approved_snapshot === false;
                  return (
                    <div
                      key={addr.id}
                      className={`rounded-2xl border p-4 transition-colors ${
                        isDefault ? 'border-gold/40 bg-gold/[0.04]' : 'border-zinc-800/70 bg-zinc-900/40'
                      } ${busyId === addr.id ? 'opacity-60' : ''}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h2 className="font-bold text-[16px] text-white truncate">{addr.label}</h2>
                          {/* The three fields the courier actually routes on,
                              which the old card hid entirely. */}
                          <p className="text-[12px] text-zinc-500 mt-0.5">
                            {[governorateName(addr.governorate), addr.area].filter(Boolean).join(' · ') ||
                              loc('لم تُحدَّد المحافظة', 'No governorate set', 'پارێزگا دیاری نەکراوە')}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          {isDefault ? (
                            <span className="rounded-lg bg-gold/15 text-gold text-[10px] font-black px-2 py-1 uppercase tracking-wider">
                              {loc('افتراضي', 'Default', 'بنەڕەت')}
                            </span>
                          ) : null}
                          {addr.backs_approved_snapshot ? (
                            <span className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 text-zinc-300 text-[10px] font-bold px-2 py-1">
                              <ShieldCheck aria-hidden="true" className="w-3 h-3" />
                              {loc('العنوان المعتمد', 'Approved address', 'ناونیشانی پەسەندکراو')}
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <p className="text-zinc-400 text-[13.5px] leading-relaxed mt-2.5">{addr.address}</p>
                      {addr.landmark ? (
                        <p className="text-zinc-500 text-[12.5px] mt-1">
                          {loc('نقطة دالة', 'Landmark', 'نیشانە')}: {addr.landmark}
                        </p>
                      ) : null}
                      <p className="text-[13px] text-zinc-300 mt-1.5">
                        {addr.name} ·{' '}
                        {/* An LTR number inside RTL prose without isolation
                            reorders around the punctuation beside it. */}
                        <span dir="ltr" className="font-bold tabular-nums">
                          {addr.phone}
                        </span>
                      </p>

                      {diverged ? (
                        <p className="mt-2.5 flex items-start gap-1.5 rounded-xl border-s-2 border-amber-500/60 bg-amber-500/[0.06] px-3 py-2 text-[12px] text-amber-200">
                          <AlertTriangle aria-hidden="true" className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          {loc(
                            'هذا العنوان لم يعد مطابقًا للعنوان المعتمد لعضوية PRO.',
                            'This address no longer matches your approved PRO address.',
                            'ئەم ناونیشانە چیتر لەگەڵ ناونیشانی پەسەندکراوی PRO یەک ناگرێتەوە.'
                          )}
                        </p>
                      ) : null}

                      <div className="flex items-center flex-wrap gap-2 mt-3.5 pt-3.5 border-t border-white/[0.06]">
                        <button
                          type="button"
                          onClick={() => openEdit(addr)}
                          className="inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-xl border border-zinc-800 bg-zinc-900/60 text-zinc-300 text-[12px] font-bold hover:text-white hover:border-zinc-600 transition-colors [touch-action:manipulation]"
                        >
                          <Edit2 aria-hidden="true" className="w-3.5 h-3.5" />
                          {loc('تعديل', 'Edit', 'دەستکاری')}
                        </button>
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={(e) => {
                            deleteAnchor.current = e.currentTarget;
                            setDeleteConfirmId(addr.id);
                          }}
                          className="inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-xl border border-zinc-800 bg-zinc-900/60 text-zinc-400 text-[12px] font-bold hover:text-red-300 hover:border-red-500/40 disabled:opacity-40 transition-colors [touch-action:manipulation]"
                        >
                          <Trash2 aria-hidden="true" className="w-3.5 h-3.5" />
                          {loc('حذف', 'Delete', 'سڕینەوە')}
                        </button>
                        {!isDefault ? (
                          <button
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => handleSetDefault(addr.id)}
                            className="inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-xl border border-zinc-800 bg-zinc-900/60 text-zinc-400 text-[12px] font-bold hover:text-gold hover:border-gold/40 disabled:opacity-40 transition-colors ms-auto [touch-action:manipulation]"
                          >
                            <CheckCircle aria-hidden="true" className="w-3.5 h-3.5" />
                            {loc('اجعله الافتراضي', 'Set as default', 'بیکە بە بنەڕەت')}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* DELETE CONFIRMATION — a centred question that has to be answered.

          `Overlay`, not `Sheet`. This is a question with exactly two answers,
          both of them on screen. A sheet's drag-to-dismiss would invent a third
          answer ("neither") for a gesture that is easy to make by accident,
          which is the last thing a destructive prompt should offer.

          `anchor` is the row's own Delete button (captured on press), so the
          question grows out of the control that raised it. With several
          near-identical address cards stacked up, that origin is the only
          indication of WHICH address is at stake.

          dismissOnEscape AND dismissOnScrim are both false: the thing being
          confirmed is irreversible, and Cancel is one tap away.

          z={60} sits above the editor's z-50 so a deletion confirmed with the
          editor open still renders on top. */}
      <Overlay
        open={!!deleteConfirmId}
        onClose={() => setDeleteConfirmId(null)}
        labelledBy="delete-address-title"
        anchor={deleteAnchor}
        dismissOnEscape={false}
        dismissOnScrim={false}
        z={60}
        testId="address-delete-confirm"
        panelClassName="w-full max-w-sm"
      >
        <div className="p-6">
          <h2 id="delete-address-title" className="text-xl font-bold mb-2">
            {loc('حذف العنوان', 'Delete address', 'سڕینەوەی ناونیشان')}
          </h2>
          <p className="text-zinc-400 mb-6 text-[14px] leading-relaxed">
            {loc(
              'سيُحذف هذا العنوان نهائيًا ولا يمكن التراجع.',
              'This address will be removed permanently. This cannot be undone.',
              'ئەم ناونیشانە بە یەکجاری دەسڕدرێتەوە و ناگەڕێتەوە.'
            )}
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setDeleteConfirmId(null)}
              className="flex-1 min-h-[48px] rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white font-bold transition-colors"
            >
              {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="flex-1 min-h-[48px] rounded-xl bg-red-500 hover:bg-red-600 text-white font-bold transition-colors"
            >
              {loc('حذف', 'Delete', 'سڕینەوە')}
            </button>
          </div>
        </div>
      </Overlay>

      {/* ADD / EDIT — a full-bleed editing task that rises from the bottom edge
          and goes back down the same way.

          `Overlay`, not `Sheet`, even though it arrives from the bottom. A
          `Sheet` is draggable, and this is a scrolling form: a downward drag
          started over the fields is the gesture for reading the rest of it, and
          giving that gesture a second meaning ("throw the whole thing away")
          would put a half-typed address one clumsy swipe from oblivion.

          No `anchor`: a window that covers the screen has no visible
          relationship to the 44px button that opened it, and the two triggers
          (Add, and every row's Edit) would each claim a different origin for
          the same window.

          `solid`, because the fields are drawn assuming an opaque ground —
          over glass the address cards behind would show through the very boxes
          being typed into. */}
      <Overlay
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        labelledBy="address-editor-title"
        placement="bottom"
        dismissOnScrim={false}
        solid
        z={50}
        testId="address-editor"
        panelClassName="w-full sm:max-w-lg h-[100dvh] sm:h-[calc(100dvh-2rem)] overflow-hidden flex flex-col bg-black"
      >
        <div className="flex items-center gap-1 px-3 py-3 sticky top-0 bg-black/85 backdrop-blur-xl z-10 border-b border-zinc-900">
          <button
            type="button"
            onClick={() => setEditorOpen(false)}
            aria-label={loc('إغلاق', 'Close', 'داخستن')}
            className="w-11 h-11 flex items-center justify-center rounded-full hover:bg-zinc-900 transition-colors [touch-action:manipulation]"
          >
            <Back aria-hidden="true" className="w-6 h-6" />
          </button>
          <h2 id="address-editor-title" className="text-[17px] font-bold ms-1">
            {editingAddress
              ? loc('تعديل العنوان', 'Edit address', 'دەستکاری ناونیشان')
              : loc('عنوان جديد', 'New address', 'ناونیشانی نوێ')}
          </h2>
        </div>

        {/* min-h-0 because this is a flex child of a panel with a real height:
            without it the column refuses to shrink and the scroll moves to the
            page behind. */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <AddressForm
            key={editingAddress?.id ?? 'new'}
            initial={editingAddress}
            defaultWhenFirst={addresses.length === 0}
            onSaved={handleSaved}
            onCancel={() => setEditorOpen(false)}
          />
        </div>
      </Overlay>
    </div>
  );
}
