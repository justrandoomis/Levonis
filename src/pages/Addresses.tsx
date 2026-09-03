import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Plus, MapPin, Edit2, Trash2, CheckCircle, User } from 'lucide-react';
import { useAuth } from '../AuthContext';
import { api, ApiAddress } from '../lib/api';
import { useLanguage } from '../LanguageContext';
import { GOVERNORATES } from '../lib/governorates';
import { Overlay } from '../components/ui/Overlay';

export default function Addresses() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoaded } = useAuth();
  const { loc, lang } = useLanguage();

  const [addresses, setAddresses] = useState<ApiAddress[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingAddress, setEditingAddress] = useState<ApiAddress | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [actionError, setActionError] = useState('');

  // The Delete button of the row being asked about. The confirmation is a
  // question about ONE address out of a list of otherwise identical cards, and
  // its copy never names which one — so the only thing on screen that says
  // "this address" is where the dialog comes from. Holding the element that was
  // pressed lets the window scale out of that exact button and collapse back
  // into it. It is a plain ref rather than state on purpose: it must be set
  // synchronously, before the render that opens the window reads it.
  const deleteAnchor = useRef<HTMLElement | null>(null);

  // Form states
  const [formLabel, setFormLabel] = useState('');
  const [formAddress, setFormAddress] = useState('');
  const [formLandmark, setFormLandmark] = useState('');
  const [formName, setFormName] = useState('');
  const [formPhone, setFormPhone] = useState('');
  // 0026: the parts a courier's form asks for, kept separate so the admin can
  // copy each one on its own instead of editing a paste on every order.
  const [formGovernorate, setFormGovernorate] = useState('');
  const [formArea, setFormArea] = useState('');
  const [formNotes, setFormNotes] = useState('');

  const loadAddresses = useCallback(async () => {
    setListError('');
    try {
      const data = await api.get<{ addresses: ApiAddress[] }>('/api/addresses');
      setAddresses(data.addresses);
    } catch (err: any) {
      setListError(err?.message || 'Failed to load addresses');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isAuthenticated) {
      setIsLoading(false);
      return;
    }
    loadAddresses();
  }, [isLoaded, isAuthenticated, loadAddresses]);

  const handleOpenAdd = () => {
    setEditingAddress(null);
    setFormLabel('');
    setFormAddress('');
    setFormLandmark('');
    setFormName('');
    setFormPhone('');
    setFormGovernorate('');
    setFormArea('');
    setFormNotes('');
    setFormError('');
    setShowAddModal(true);
  };

  const handleOpenEdit = (addr: ApiAddress) => {
    setEditingAddress(addr);
    setFormLabel(addr.label);
    setFormAddress(addr.address);
    setFormLandmark(addr.landmark || '');
    setFormName(addr.name);
    setFormPhone(addr.phone.replace(/^\+964-?/, ''));
    setFormGovernorate(addr.governorate || '');
    setFormArea(addr.area || '');
    setFormNotes(addr.notes || '');
    setFormError('');
    setShowAddModal(true);
  };

  const handleSave = async () => {
    if (isSaving) return;
    setFormError('');
    if (!formName.trim() || !formPhone.trim() || !formLabel.trim() || !formAddress.trim()) {
      setFormError(loc('الاسم والرقم واسم العنوان والعنوان مطلوبة', 'Name, phone, label and address are required', 'ناو و ژمارە و ناونیشان پێویستن'));
      return;
    }
    // The governorate is required for a NEW address: dispatch routes on it,
    // and a parcel without one is a phone call. An address saved before this
    // existed can still be edited without adding one, so nobody is locked out
    // of fixing a typo in their own phone number.
    if (!editingAddress && !formGovernorate) {
      setFormError(loc('اختر المحافظة', 'Choose a governorate', 'پارێزگا هەڵبژێرە'));
      return;
    }
    const body = {
      label: formLabel.trim(),
      name: formName.trim(),
      phone: '+964-' + formPhone.trim(),
      address: formAddress.trim(),
      landmark: formLandmark.trim(),
      governorate: formGovernorate,
      area: formArea.trim(),
      notes: formNotes.trim(),
      isDefault: editingAddress ? editingAddress.is_default === 1 : addresses.length === 0,
    };
    setIsSaving(true);
    try {
      if (editingAddress) {
        await api.put(`/api/addresses/${editingAddress.id}`, body);
      } else {
        await api.post('/api/addresses', body);
      }
      await loadAddresses();
      setShowAddModal(false);
    } catch (err: any) {
      setFormError(err?.message || 'Failed to save address');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirmId) return;
    setActionError('');
    try {
      await api.delete(`/api/addresses/${deleteConfirmId}`);
      await loadAddresses();
    } catch (err: any) {
      setActionError(err?.message || 'Failed to delete address');
    } finally {
      setDeleteConfirmId(null);
    }
  };

  const handleSetDefault = async (id: string) => {
    setActionError('');
    try {
      await api.post(`/api/addresses/${id}/default`);
      await loadAddresses();
    } catch (err: any) {
      setActionError(err?.message || 'Failed to set default address');
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white w-full font-sans flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 sticky top-0 bg-[#0a0a0a]/90 backdrop-blur-md z-10 border-b border-zinc-900">
        <button
          onClick={() => navigate(-1)}
          className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-zinc-900 transition-colors"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
        <h1 className="text-[17px] font-bold">My Addresses</h1>
        <div className="w-10 h-10"></div>
      </div>

      <div className="p-4 flex-1">
        {!isAuthenticated && isLoaded ? (
          <div className="text-center py-16 text-zinc-500">
            <MapPin className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="font-medium">Sign in to manage your addresses</p>
            <button onClick={() => navigate('/auth')} className="mt-4 px-6 py-2 bg-olive/20 text-gold rounded-full font-bold text-sm">
              Sign in
            </button>
          </div>
        ) : (
          <>
            <button
              onClick={handleOpenAdd}
              className="w-full bg-olive/10 border border-olive/30 hover:bg-olive/20 text-gold rounded-2xl p-4 flex items-center justify-center gap-2 font-bold transition-colors shadow-sm mb-6"
            >
              <Plus className="w-5 h-5" />
              Add address
            </button>

            {actionError && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] font-medium rounded-2xl p-3 text-center mb-4">
                {actionError}
              </div>
            )}
            {listError && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] font-medium rounded-2xl p-3 text-center mb-4">
                {listError}
              </div>
            )}

            {isLoading ? (
              <div className="flex justify-center py-16">
                <div className="w-8 h-8 border-2 border-gold/20 border-t-gold rounded-full animate-spin" />
              </div>
            ) : addresses.length === 0 && !listError ? (
              <div className="text-center py-12 text-zinc-500">
                <MapPin className="w-10 h-10 mx-auto mb-3 opacity-40" />
                <p className="font-medium">No saved addresses yet</p>
                <p className="text-sm mt-1">Add your first delivery address above.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {addresses.map((addr) => (
                  <div key={addr.id} className={`bg-zinc-900 border ${addr.is_default ? 'border-gold/50' : 'border-zinc-800'} rounded-3xl p-5 relative overflow-hidden transition-colors`}>
                    {addr.is_default === 1 && (
                      <div className="absolute top-0 right-0 bg-gold/20 text-gold text-[10px] font-bold px-3 py-1 rounded-bl-xl uppercase tracking-wider">
                        Default
                      </div>
                    )}
                    <div className="flex gap-4">
                      <div className="mt-1">
                        <MapPin className={`w-6 h-6 ${addr.is_default ? 'text-gold' : 'text-zinc-400'}`} />
                      </div>
                      <div className="flex-1">
                        <h3 className="text-lg font-bold mb-1">{addr.label}</h3>
                        <p className="text-zinc-400 text-sm leading-relaxed mb-3">
                          {addr.address}
                          {addr.landmark && <><br/>Landmark: {addr.landmark}</>}
                        </p>
                        <p className="text-sm font-medium text-zinc-300">
                          Phone number: <span className="font-bold">{addr.phone}</span>
                        </p>

                        <div className="flex items-center flex-wrap gap-2 mt-4 pt-4 border-t border-zinc-800/50">
                          <button onClick={() => handleOpenEdit(addr)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700/50 hover:bg-zinc-800 hover:border-zinc-600 text-zinc-300 text-[11px] font-bold uppercase tracking-wider transition-colors">
                            <Edit2 className="w-3.5 h-3.5" />
                            Edit
                          </button>
                          <button onClick={(e) => { deleteAnchor.current = e.currentTarget; setDeleteConfirmId(addr.id); }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700/50 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/30 text-zinc-400 text-[11px] font-bold uppercase tracking-wider transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                            Delete
                          </button>
                          {addr.is_default !== 1 && (
                            <button onClick={() => handleSetDefault(addr.id)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700/50 hover:bg-gold/10 hover:text-gold hover:border-gold/30 text-zinc-400 text-[11px] font-bold uppercase tracking-wider transition-colors ml-auto">
                              <CheckCircle className="w-3.5 h-3.5" />
                              Set Default
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* DELETE CONFIRMATION — a centred question that has to be answered.

          It used to be a `fixed inset-0` div that appeared with Tailwind's
          `zoom-in-95` keyframe and, when the id was cleared, simply stopped
          existing: a full arrival and no departure at all. A keyframe is also
          uninterruptible — someone who taps Delete and immediately reaches for
          Cancel has to wait out an animation that has stopped meaning anything.
          The primitive's spring animates from the panel's live value, so the
          trip back starts from wherever the window actually got to.

          `Overlay`, not `Sheet`. This is a question with exactly two answers,
          both of them on screen. A sheet's drag-to-dismiss would invent a third
          answer ("neither") for a gesture that is easy to make by accident,
          which is the last thing a destructive prompt should offer.

          `anchor` is the row's own Delete button (captured on press), so the
          question grows out of the control that raised it. With several
          near-identical address cards stacked up, that origin is the only
          indication of WHICH address is at stake — the copy says "this
          address" and never names it.

          dismissOnEscape AND dismissOnScrim are both false. This is not the
          primitive being made stubborn: the old markup had no scrim handler and
          no key listener, so neither gesture closed it before, and the thing
          being confirmed is explicitly irreversible. A destructive question is
          answered, not dodged — Cancel is the way out, and it is one tap away.

          z={60} preserves the old `z-[60]`, deliberately above the editor's
          z-50 so a deletion confirmed with the editor open still sits on top. */}
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
        {/* The old panel's own padding, moved inside: the primitive owns the
            material, the border and the rounding, the caller owns the inset. */}
        <div className="p-6">
          <h2 id="delete-address-title" className="text-xl font-bold mb-2">Delete Address</h2>
          <p className="text-zinc-400 mb-6">Are you sure you want to delete this address? This action cannot be undone.</p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setDeleteConfirmId(null)}
              className="flex-1 py-3.5 rounded-2xl bg-zinc-800 hover:bg-zinc-700 text-white font-bold transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              className="flex-1 py-3.5 rounded-2xl bg-red-500 hover:bg-red-600 text-white font-bold transition-colors shadow-lg shadow-red-500/20"
            >
              Delete
            </button>
          </div>
        </div>
      </Overlay>

      {/* ADD / EDIT ADDRESS — a full-bleed editing task that rises from the
          bottom edge and goes back down the same way.

          It used to be `fixed inset-0` with `slide-in-from-bottom-full`: it
          slid up once, and then on close it was unmounted mid-screen and simply
          ceased to be. So the window had exactly half a life — it came from
          somewhere and returned to nowhere, which is the spatial contract
          broken in the one place a person is most likely to reopen it (they
          save an address, notice a typo, and tap Edit again). `placement="bottom"`
          keeps the direction the old keyframe established, and now the exit
          retraces it.

          `Overlay`, not `Sheet`, even though it arrives from the bottom edge.
          A `Sheet` is draggable, and this window is a long scrolling form: a
          downward drag started over the fields is the gesture for reading the
          rest of the form, and handing that same gesture a second meaning
          ("throw the whole thing away") would put a half-typed address one
          clumsy swipe from oblivion. The grabber would also land on top of the
          sticky header and its back button. This window is left the way it was
          entered: the back chevron, Save, or Escape.

          No `anchor`. A window that covers the entire screen has no visible
          relationship to the 40px button that opened it — scaling a full-bleed
          surface out of one corner reads as a glitch, not as provenance. A
          full-screen task belongs to the edge it comes from, and the two
          triggers (Add, and every row's Edit) would each claim a different
          origin for the same window anyway.

          `solid`. The primitive's default material is tinted glass, but every
          surface in here — the sticky translucent header, the `zinc-800/50`
          input fields, the map card — is drawn assuming an opaque page ground
          underneath. Over glass, the address cards of the list behind would
          show through the very fields being typed into. So the editor supplies
          the old `bg-[#0a0a0a]` and keeps the arrival, the exit and the
          reduced-motion cross-fade that the primitive provides regardless.

          dismissOnScrim={false}: there was no backdrop to click before (the old
          window was opaque and covered everything), and a stray tap beside the
          panel on a wide screen must not discard a form someone is filling in.
          Escape now closes it, which the primitive owns — there was no key
          listener here to remove.

          z={50} is the old `z-50`, unchanged. */}
      <Overlay
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        labelledBy="address-editor-title"
        placement="bottom"
        dismissOnScrim={false}
        solid
        z={50}
        testId="address-editor"
        panelClassName="w-full sm:max-w-xl h-[100dvh] sm:h-[calc(100dvh-2rem)] overflow-hidden flex flex-col bg-[#0a0a0a]"
      >
          <div className="flex items-center p-4 sticky top-0 bg-[#0a0a0a]/90 backdrop-blur-md z-10 border-b border-zinc-900">
            <button
              onClick={() => setShowAddModal(false)}
              className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-zinc-900 transition-colors -ml-2"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
            <h1 id="address-editor-title" className="text-[19px] font-bold ml-1">Delivery details</h1>
          </div>

          {/* min-h-0 because this is now a flex child of a panel with a real
              height rather than of a viewport-sized div: without it the column
              would refuse to shrink and the scroll would move to the page. */}
          <div className="flex-1 min-h-0 overflow-y-auto pb-24">
            <div className="p-4">
              {/* Location Card (map image is decorative only) */}
              <div className="bg-zinc-900/50 border border-zinc-800 rounded-3xl overflow-hidden mb-8">
                <div className="h-[150px] bg-zinc-800 relative w-full overflow-hidden">
                  <img referrerPolicy="no-referrer" src="https://i.imgur.com/5J32z6S.jpeg" alt="" aria-hidden="true" className="w-full h-full object-cover opacity-40 pointer-events-none" />
                </div>

                <div className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <MapPin className="w-5 h-5 text-zinc-400 shrink-0" />
                    <input
                      type="text"
                      value={formLabel}
                      onChange={e => setFormLabel(e.target.value)}
                      placeholder="Label — e.g. Home, Work"
                      className="bg-transparent border-none focus:outline-none font-bold text-[17px] text-white w-full placeholder-zinc-600"
                    />
                  </div>

                  {/* Governorate and area are their OWN fields, not part of
                      the free-text line: dispatch routes on the governorate,
                      and the admin copies each into a separate box on the
                      courier's form. */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2 mt-2">
                    <div>
                      <label className="text-[11px] font-medium text-zinc-400 mb-1 block">
                        {loc('المحافظة', 'Governorate', 'پارێزگا')}<span className="text-red-500">*</span>
                      </label>
                      <select
                        value={formGovernorate}
                        onChange={e => setFormGovernorate(e.target.value)}
                        className="bg-zinc-800/50 border border-zinc-700/50 focus:border-gold/50 rounded-xl px-3 min-h-[44px] text-white text-sm w-full outline-none transition-colors"
                      >
                        <option value="">{loc('اختر المحافظة', 'Choose a governorate', 'پارێزگا هەڵبژێرە')}</option>
                        {GOVERNORATES.map(g => (
                          <option key={g.id} value={g.id}>
                            {lang === 'en' ? g.en : lang === 'ckb' ? g.ckb : g.ar}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-zinc-400 mb-1 block">
                        {loc('المنطقة', 'Area', 'ناوچە')}
                      </label>
                      <input
                        type="text"
                        value={formArea}
                        onChange={e => setFormArea(e.target.value)}
                        placeholder={loc('مثال: الكرادة', 'e.g. Karrada', 'نموونە: کەڕادە')}
                        className="bg-zinc-800/50 border border-zinc-700/50 focus:border-gold/50 rounded-xl px-3 min-h-[44px] text-white text-sm w-full outline-none transition-colors"
                      />
                    </div>
                  </div>

                  <div className="mb-2 mt-2">
                    <label className="text-[11px] font-medium text-zinc-400 mb-1 block">
                      {loc('تفاصيل العنوان', 'Street and details', 'وردەکاری ناونیشان')}<span className="text-red-500">*</span>
                    </label>
                    <textarea
                      value={formAddress}
                      onChange={e => setFormAddress(e.target.value)}
                      placeholder={loc('الحي، الشارع، رقم الدار…', 'District, street, house number…', 'گەڕەک، شەقام، ژمارەی ماڵ…')}
                      rows={2}
                      className="bg-zinc-800/50 border border-zinc-700/50 focus:border-gold/50 rounded-xl px-3 py-2 text-white text-sm w-full outline-none transition-colors resize-none"
                    />
                  </div>

                  <div className="flex items-center gap-3 bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-3 mt-2 min-h-[44px]">
                    <MapPin className="w-5 h-5 text-zinc-400 shrink-0 opacity-70" />
                    <input
                      type="text"
                      placeholder={loc('أقرب نقطة دالة (اختياري)', 'Nearest landmark (optional)', 'نزیکترین نیشانە (ئارەزوومەندانە)')}
                      value={formLandmark}
                      onChange={e => setFormLandmark(e.target.value)}
                      className="bg-transparent border-none focus:outline-none text-white text-[14px] w-full placeholder-zinc-500"
                    />
                  </div>

                  <div className="mt-2">
                    <label className="text-[11px] font-medium text-zinc-400 mb-1 block">
                      {loc('ملاحظات للمندوب', 'Notes for the courier', 'تێبینی بۆ گەیێنەر')}
                    </label>
                    <textarea
                      value={formNotes}
                      onChange={e => setFormNotes(e.target.value)}
                      placeholder={loc('مثال: اتصل قبل الوصول', 'e.g. call before arriving', 'نموونە: پێش هاتن پەیوەندی بکە')}
                      rows={2}
                      className="bg-zinc-800/50 border border-zinc-700/50 focus:border-gold/50 rounded-xl px-3 py-2 text-white text-sm w-full outline-none transition-colors resize-none"
                    />
                  </div>
                </div>
              </div>

              {/* Recipient Details Section */}
              <div className="flex items-center justify-between mb-5 px-1">
                <h2 className="text-[17px] font-bold">Recipient details</h2>
                <button
                  onClick={() => { setFormName(''); setFormPhone(''); }}
                  className="px-3 py-1 bg-red-500/10 text-red-400 rounded-full text-[12px] font-bold hover:bg-red-500/20 transition-colors"
                >
                  Clear details
                </button>
              </div>

              <div className="space-y-6 px-1">
                <div className="relative border-b border-zinc-800 pb-2">
                  <label className="text-[12px] text-zinc-400 mb-1 block">Recipient's name<span className="text-red-500">*</span></label>
                  <div className="flex items-center justify-between">
                    <input
                      type="text"
                      value={formName}
                      onChange={e => setFormName(e.target.value)}
                      placeholder="Full name"
                      className="bg-transparent border-none focus:outline-none text-white text-[17px] font-medium w-full placeholder-zinc-700"
                    />
                    <div className="w-6 h-6 rounded-md bg-olive/20 text-olive flex items-center justify-center shrink-0">
                      <User className="w-4 h-4" />
                    </div>
                  </div>
                </div>

                <div className="relative border-b border-zinc-800 pb-2">
                  <label className="text-[12px] text-zinc-400 mb-2 block">Phone number<span className="text-red-500">*</span></label>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5 bg-zinc-800 px-3 py-1.5 rounded-full border border-zinc-700 shrink-0">
                      <span className="text-sm">🇮🇶</span>
                      <span className="text-[13px] font-bold">+964</span>
                    </div>
                    <input
                      type="tel"
                      value={formPhone}
                      onChange={e => setFormPhone(e.target.value)}
                      placeholder="7700000000"
                      className="bg-transparent border-none focus:outline-none text-white text-[17px] font-medium w-full placeholder-zinc-700"
                    />
                  </div>
                </div>
              </div>

              {formError && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] font-medium rounded-2xl p-3 text-center mt-6">
                  {formError}
                </div>
              )}

              <div className="flex items-center justify-between mt-8 mb-4 px-1">
                <div className="flex items-center gap-3">
                  <MapPin className="w-5 h-5 text-zinc-400" />
                  <span className="font-bold text-[15px]">{editingAddress ? 'Update this saved address?' : 'Save this address?'}</span>
                </div>
                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="px-5 py-2 bg-olive/20 text-olive rounded-full text-[13px] font-bold disabled:opacity-50"
                >
                  {isSaving ? 'Saving…' : editingAddress ? 'Update' : 'Save'}
                </button>
              </div>

            </div>
          </div>

          {/* `absolute inset-x-0`, not `fixed left-0 right-0`. The panel is an
              animated (transformed and filtered) element, which makes it the
              containing block for fixed descendants anyway — so `fixed` here
              was already lying about what it did. Stating it as absolute ties
              the bar to the panel it belongs to, which is what keeps it the
              width of the window rather than the width of the screen once the
              panel stops being full-bleed on a wide viewport. */}
          <div className="absolute inset-x-0 bottom-0 p-4 bg-[#0a0a0a]/90 backdrop-blur-md pb-8">
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="w-full bg-olive hover:bg-olive-light text-white py-4 rounded-full font-bold text-[16px] shadow-lg shadow-olive/10 active:scale-95 transition-all disabled:opacity-50"
            >
              {isSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
      </Overlay>
    </div>
  );
}
