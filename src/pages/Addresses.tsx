import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Plus, MapPin, Edit2, Trash2, CheckCircle, Circle, User, Map as MapIcon } from 'lucide-react';
import { useAuth } from '../AuthContext';

interface Address {
  id: string;
  type: string;
  address: string;
  landmark: string;
  name: string;
  phone: string;
  isDefault?: boolean;
}

export default function Addresses() {
  const navigate = useNavigate();
  const { user } = useAuth();
  
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingAddress, setEditingAddress] = useState<Address | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Form states
  const [formType, setFormType] = useState('');
  const [formAddress, setFormAddress] = useState('');
  const [formProvince, setFormProvince] = useState('');
  const [formRegion, setFormRegion] = useState('');
  const [formLandmark, setFormLandmark] = useState('');
  const [formName, setFormName] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [isManualAddress, setIsManualAddress] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('userAddresses');
    if (saved) {
      try {
        setAddresses(JSON.parse(saved));
      } catch (e) {}
    } else {
      // Default mock address
      setAddresses([
        {
          id: '1',
          type: 'Home',
          address: 'Baghdad, Al-Mansour, 14th Ramadan St',
          landmark: '',
          name: user?.name || 'Alex Smith',
          phone: '+964-7701234567',
          isDefault: true
        }
      ]);
    }
  }, [user]);

  const saveAddresses = (newAddresses: Address[]) => {
    setAddresses(newAddresses);
    localStorage.setItem('userAddresses', JSON.stringify(newAddresses));
  };

  const handleOpenAdd = () => {
    setEditingAddress(null);
    setFormType('');
    setFormAddress('');
    setFormProvince('');
    setFormRegion('');
    setFormLandmark('');
    setFormName('');
    setFormPhone('');
    setIsManualAddress(false);
    setShowAddModal(true);
  };

  const handleOpenEdit = (addr: Address) => {
    setEditingAddress(addr);
    setFormType(addr.type);
    setFormAddress(addr.address);
    setFormLandmark(addr.landmark || '');
    setFormName(addr.name);
    let phoneStr = addr.phone.replace('+964-', '').replace('+62-', '').replace('+91-', '');
    if (phoneStr.startsWith('+964')) phoneStr = phoneStr.replace('+964', '');
    setFormPhone(phoneStr);
    setIsManualAddress(false);
    setShowAddModal(true);
  };

  const handleSave = () => {
    if (!formName.trim() || !formPhone.trim() || !formType.trim()) {
      alert('Name, Phone, and Address Label are required');
      return;
    }

    let finalAddress = formAddress;
    if (isManualAddress) {
      finalAddress = `${formProvince}, ${formRegion}`;
    }

    const newAddr: Address = {
      id: editingAddress ? editingAddress.id : Date.now().toString(),
      type: formType,
      address: finalAddress,
      landmark: formLandmark,
      name: formName,
      phone: '+964-' + formPhone,
      isDefault: editingAddress ? editingAddress.isDefault : addresses.length === 0
    };

    let updated: Address[];
    if (editingAddress) {
      updated = addresses.map(a => a.id === editingAddress.id ? newAddr : a);
    } else {
      updated = [...addresses, newAddr];
    }
    
    saveAddresses(updated);
    setShowAddModal(false);
  };

  const handleDelete = () => {
    if (deleteConfirmId) {
      const updated = addresses.filter(a => a.id !== deleteConfirmId);
      // If we deleted the default address and there are others left, make the first one default
      if (addresses.find(a => a.id === deleteConfirmId)?.isDefault && updated.length > 0) {
        updated[0].isDefault = true;
      }
      saveAddresses(updated);
      setDeleteConfirmId(null);
    }
  };

  const handleSetDefault = (id: string) => {
    const updated = addresses.map(a => ({
      ...a,
      isDefault: a.id === id
    }));
    saveAddresses(updated);
  };

  const handleMapTap = () => {
    setIsManualAddress(false);
    setFormAddress('Baghdad, Al-Mansour, 14th Ramadan St');
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
        <button 
          onClick={handleOpenAdd}
          className="w-full bg-olive/10 border border-olive/30 hover:bg-olive/20 text-gold rounded-2xl p-4 flex items-center justify-center gap-2 font-bold transition-colors shadow-sm mb-6"
        >
          <Plus className="w-5 h-5" />
          Add address
        </button>

        <div className="space-y-4">
          {addresses.map((addr) => (
            <div key={addr.id} className={`bg-zinc-900 border ${addr.isDefault ? 'border-gold/50' : 'border-zinc-800'} rounded-3xl p-5 relative overflow-hidden transition-colors`}>
              {addr.isDefault && (
                <div className="absolute top-0 right-0 bg-gold/20 text-gold text-[10px] font-bold px-3 py-1 rounded-bl-xl uppercase tracking-wider">
                  Default
                </div>
              )}
              <div className="flex gap-4">
                <div className="mt-1">
                  <MapPin className={`w-6 h-6 ${addr.isDefault ? 'text-gold' : 'text-zinc-400'}`} />
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-bold mb-1">{addr.type}</h3>
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
                    <button onClick={() => setDeleteConfirmId(addr.id)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700/50 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/30 text-zinc-400 text-[11px] font-bold uppercase tracking-wider transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete
                    </button>
                    {!addr.isDefault && (
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
      </div>

      {/* Delete Confirmation Modal */}
      {deleteConfirmId && (
        <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0a0a0a] border border-zinc-800 rounded-[28px] p-6 w-full max-w-sm animate-in zoom-in-95 duration-200 shadow-2xl">
            <h2 className="text-xl font-bold mb-2">Delete Address</h2>
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
        </div>
      )}

      {/* Add/Edit Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-[#0a0a0a] flex flex-col animate-in slide-in-from-bottom-full duration-300">
          <div className="flex items-center p-4 sticky top-0 bg-[#0a0a0a]/90 backdrop-blur-md z-10 border-b border-zinc-900">
            <button 
              onClick={() => setShowAddModal(false)} 
              className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-zinc-900 transition-colors -ml-2"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
            <h1 className="text-[19px] font-bold ml-1">Delivery details</h1>
          </div>

          <div className="flex-1 overflow-y-auto pb-24">
            <div className="p-4">
              {/* Map & Location Card */}
              <div className="bg-zinc-900/50 border border-zinc-800 rounded-3xl overflow-hidden mb-8">
                <div className="h-[150px] bg-zinc-800 relative w-full overflow-hidden">
                  <img referrerPolicy="no-referrer" src="https://i.imgur.com/5J32z6S.jpeg" alt="Map" className="w-full h-full object-cover opacity-60" />
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center">
                    <button onClick={handleMapTap} className="bg-white text-black px-4 py-2 rounded-full font-bold text-[13px] shadow-lg flex items-center gap-2 hover:scale-105 transition-transform active:scale-95">
                      <div className="w-5 h-5 bg-orange-500 rounded-full flex items-center justify-center">
                        <MapPin className="w-3 h-3 text-white" />
                      </div>
                      Tap the map
                    </button>
                  </div>
                </div>
                
                <div className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 flex-1">
                      <MapPin className="w-5 h-5 text-zinc-400 shrink-0" />
                      <input 
                        type="text" 
                        value={formType}
                        onChange={e => setFormType(e.target.value)}
                        placeholder="e.g. Work"
                        className="bg-transparent border-none focus:outline-none font-bold text-[17px] text-white w-full placeholder-zinc-600"
                      />
                    </div>
                    <button 
                      onClick={() => setIsManualAddress(!isManualAddress)}
                      className="px-4 py-1.5 bg-olive/20 text-olive rounded-full text-[13px] font-bold"
                    >
                      {isManualAddress ? 'Cancel' : 'Edit'}
                    </button>
                  </div>
                  
                  {isManualAddress ? (
                    <div className="space-y-4 mb-4 mt-2 animate-in fade-in zoom-in-95 duration-200">
                      <div>
                        <label className="text-[11px] font-medium text-zinc-400 mb-1 block">Province</label>
                        <input 
                          type="text" 
                          value={formProvince}
                          onChange={e => setFormProvince(e.target.value)}
                          placeholder="e.g. Baghdad"
                          className="bg-zinc-800/50 border border-zinc-700/50 focus:border-gold/50 rounded-xl px-3 py-2 text-white text-sm w-full outline-none transition-colors"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] font-medium text-zinc-400 mb-1 block">Region / City</label>
                        <input 
                          type="text" 
                          value={formRegion}
                          onChange={e => setFormRegion(e.target.value)}
                          placeholder="e.g. Al-Mansour"
                          className="bg-zinc-800/50 border border-zinc-700/50 focus:border-gold/50 rounded-xl px-3 py-2 text-white text-sm w-full outline-none transition-colors"
                        />
                      </div>
                    </div>
                  ) : (
                    <p className="text-zinc-300 text-[14px] leading-[1.4] mb-4">
                      {formAddress || 'Tap on the map to set location automatically or click Edit to enter manually.'}
                    </p>
                  )}
                  
                  <div className="flex items-center gap-3 bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-3 mt-2">
                    <MapPin className="w-5 h-5 text-zinc-400 shrink-0 opacity-70" />
                    <input 
                      type="text" 
                      placeholder="Any landmark near here? (optional)"
                      value={formLandmark}
                      onChange={e => setFormLandmark(e.target.value)}
                      className="bg-transparent border-none focus:outline-none text-white text-[14px] w-full placeholder-zinc-500"
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
                      placeholder="e.g. Alex Smith"
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
              
              <div className="flex items-center justify-between mt-8 mb-4 px-1">
                <div className="flex items-center gap-3">
                  <MapPin className="w-5 h-5 text-zinc-400" />
                  <span className="font-bold text-[15px]">Update this saved address?</span>
                </div>
                <button 
                  onClick={handleSave}
                  className="px-5 py-2 bg-olive/20 text-olive rounded-full text-[13px] font-bold"
                >
                  Update
                </button>
              </div>

            </div>
          </div>
          
          <div className="fixed bottom-0 left-0 right-0 p-4 bg-[#0a0a0a]/90 backdrop-blur-md pb-8">
            <button 
              onClick={handleSave}
              className="w-full bg-olive hover:bg-[#3b5927] text-white py-4 rounded-full font-bold text-[16px] shadow-lg shadow-olive/10 active:scale-95 transition-all"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
