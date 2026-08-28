import React, { useState, useEffect, useRef } from 'react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError } from '../lib/api';
import { Search, Edit2, Shield, User, Store, Check, CreditCard, TrendingUp } from 'lucide-react';

interface AdminUserRow {
  id: string;
  email: string;
  username: string | null;
  name: string;
  role: 'customer' | 'merchant' | 'admin';
  is_investor: number;
  subscription_plan: 'free' | 'plus' | 'pro';
  subscription_expiry: number;
  created_at: string;
}

const ROLE_STYLES: Record<string, string> = {
  admin: 'bg-[#6B46FF]/10 text-[#6B46FF] border-[#6B46FF]/20',
  merchant: 'bg-[#D4AF37]/10 text-[#D4AF37] border-[#D4AF37]/20',
  customer: 'bg-zinc-800 text-zinc-400 border-zinc-700',
};

export default function AdminUsers() {
  const { t, dir } = useLanguage();
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [editingUser, setEditingUser] = useState<AdminUserRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchUsers = async (search: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const qs = search ? `?search=${encodeURIComponent(search)}&limit=100` : '?limit=100';
      const data = await api.get<{ users: AdminUserRow[]; total: number }>(`/api/admin/users${qs}`);
      setUsers(data.users);
      setTotal(data.total);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers('');
  }, []);

  // Debounced server-side search.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchUsers(searchTerm.trim());
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchTerm]);

  // Client-side filter as a fallback on top of the server result.
  const filteredUsers = users.filter(u =>
    (u.name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    (u.email || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    (u.username || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleSaveUser = async (updatedUser: AdminUserRow) => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.patch(`/api/admin/users/${updatedUser.id}`, {
        role: updatedUser.role,
        subscription_plan: updatedUser.subscription_plan,
        is_investor: !!updatedUser.is_investor,
      });
      setUsers(users.map(u => u.id === updatedUser.id ? updatedUser : u));
      setEditingUser(null);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Failed to update user');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-black text-white">{t('adminUsers')}</h2>
          <span className="text-xs font-bold text-zinc-500 bg-zinc-800 px-3 py-1 rounded-full border border-zinc-700">
            {total.toLocaleString()} {dir === 'rtl' ? 'مستخدم' : 'total'}
          </span>
        </div>
        <div className="relative w-full md:w-64">
          <input
            type="text"
            placeholder={dir === 'rtl' ? 'البحث عن مستخدم...' : 'Search users...'}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-700 text-white pl-10 pr-4 py-2 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#6B46FF]/50"
          />
          <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
        </div>
      </div>

      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-4 text-sm font-medium">
          {loadError}
        </div>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[900px]">
            <thead>
              <tr className="bg-zinc-800/50 border-b border-zinc-700">
                <th className="py-4 px-6 text-xs font-bold text-zinc-400 uppercase tracking-wider">User Info</th>
                <th className="py-4 px-6 text-xs font-bold text-zinc-400 uppercase tracking-wider">Role</th>
                <th className="py-4 px-6 text-xs font-bold text-zinc-400 uppercase tracking-wider">Plan</th>
                <th className="py-4 px-6 text-xs font-bold text-zinc-400 uppercase tracking-wider">Investor</th>
                <th className="py-4 px-6 text-xs font-bold text-zinc-400 uppercase tracking-wider">Joined</th>
                <th className="py-4 px-6 text-xs font-bold text-zinc-400 uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u) => (
                <tr key={u.id} className="border-b border-zinc-800 hover:bg-zinc-800/30 transition-colors">
                  <td className="py-4 px-6">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center shrink-0 border border-zinc-700">
                        {u.role === 'admin' ? <Shield className="w-5 h-5 text-[#6B46FF]" /> : u.role === 'merchant' ? <Store className="w-5 h-5 text-[#D4AF37]" /> : <User className="w-5 h-5 text-zinc-400" />}
                      </div>
                      <div>
                        <div className="font-bold text-zinc-200">{u.name || u.username || 'Unnamed User'}</div>
                        <div className="text-sm text-zinc-500 font-medium">{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="py-4 px-6">
                    <span className={`px-3 py-1 rounded-full text-xs font-bold border capitalize ${ROLE_STYLES[u.role] || ROLE_STYLES.customer}`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="py-4 px-6">
                    <div className="flex items-center gap-2">
                      <CreditCard className="w-4 h-4 text-zinc-500" />
                      <span className="text-sm font-bold text-zinc-300 capitalize">{u.subscription_plan || 'free'}</span>
                    </div>
                  </td>
                  <td className="py-4 px-6">
                    {u.is_investor ? (
                      <span className="inline-flex items-center gap-1 text-xs font-bold text-[#2CE59B]">
                        <TrendingUp className="w-3.5 h-3.5" /> Yes
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-600 font-medium">—</span>
                    )}
                  </td>
                  <td className="py-4 px-6 text-xs text-zinc-500 whitespace-nowrap">
                    {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="py-4 px-6 text-right">
                    <button
                      onClick={() => { setSaveError(null); setEditingUser(u); }}
                      className="p-2 hover:bg-zinc-700 rounded-lg text-zinc-400 hover:text-white transition-colors"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-zinc-500 font-medium">
                    {searchTerm ? `No users found matching "${searchTerm}"` : 'No users found'}
                  </td>
                </tr>
              )}
              {loading && users.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-zinc-500 font-medium">Loading...</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editingUser && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl w-full max-w-md p-6 shadow-2xl">
            <h3 className="text-xl font-bold text-white mb-6">Edit User</h3>

            <div className="space-y-4 mb-8">
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Name</label>
                <input
                  type="text"
                  value={editingUser.name || editingUser.username || ''}
                  disabled
                  className="w-full bg-zinc-800/50 border border-zinc-700 text-zinc-400 px-4 py-3 rounded-xl cursor-not-allowed"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Role</label>
                <div className="grid grid-cols-3 gap-3">
                  <button
                    onClick={() => setEditingUser({...editingUser, role: 'customer'})}
                    className={`py-3 rounded-xl font-bold border flex items-center justify-center gap-2 transition-colors text-sm ${editingUser.role === 'customer' ? 'bg-zinc-800 text-white border-zinc-600' : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:bg-zinc-800/50'}`}
                  >
                    <User className="w-4 h-4" /> Customer
                  </button>
                  <button
                    onClick={() => setEditingUser({...editingUser, role: 'merchant'})}
                    className={`py-3 rounded-xl font-bold border flex items-center justify-center gap-2 transition-colors text-sm ${editingUser.role === 'merchant' ? 'bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]/50' : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:bg-zinc-800/50'}`}
                  >
                    <Store className="w-4 h-4" /> Merchant
                  </button>
                  <button
                    onClick={() => setEditingUser({...editingUser, role: 'admin'})}
                    className={`py-3 rounded-xl font-bold border flex items-center justify-center gap-2 transition-colors text-sm ${editingUser.role === 'admin' ? 'bg-[#6B46FF]/20 text-[#6B46FF] border-[#6B46FF]/50' : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:bg-zinc-800/50'}`}
                  >
                    <Shield className="w-4 h-4" /> Admin
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Subscription Plan</label>
                <select
                  value={editingUser.subscription_plan || 'free'}
                  onChange={(e) => setEditingUser({...editingUser, subscription_plan: e.target.value as AdminUserRow['subscription_plan']})}
                  className="w-full bg-zinc-800 border border-zinc-700 text-white px-4 py-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#6B46FF]/50 appearance-none font-medium capitalize"
                >
                  <option value="free">Free Plan</option>
                  <option value="plus">Plus Plan</option>
                  <option value="pro">Pro Plan</option>
                </select>
              </div>

              <label className="flex items-center gap-3 cursor-pointer bg-zinc-800/50 border border-zinc-700 rounded-xl px-4 py-3">
                <input
                  type="checkbox"
                  checked={!!editingUser.is_investor}
                  onChange={(e) => setEditingUser({...editingUser, is_investor: e.target.checked ? 1 : 0})}
                  className="w-5 h-5 rounded border-zinc-700 bg-zinc-800 accent-[#2CE59B]"
                />
                <span className="text-white font-medium flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-[#2CE59B]" /> Investor
                </span>
              </label>

              {saveError && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl p-3 text-sm font-medium">
                  {saveError}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setEditingUser(null)}
                disabled={saving}
                className="px-5 py-2.5 rounded-xl font-bold text-zinc-400 hover:bg-zinc-800 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleSaveUser(editingUser)}
                disabled={saving}
                className="px-5 py-2.5 rounded-xl font-bold bg-white text-black hover:bg-zinc-200 transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                <Check className="w-4 h-4" /> {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
