import React, { useState, useEffect, useRef } from 'react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError } from '../lib/api';
import { Search, Edit2, Shield, User, Store, Check, CreditCard, TrendingUp } from 'lucide-react';
import { Overlay } from './ui/Overlay';

interface AdminUserRow {
  id: string;
  email: string;
  username: string | null;
  name: string;
  role: 'customer' | 'merchant' | 'admin';
  is_investor: number;
  membership_tier: 'free' | 'plus' | 'pro' | 'prime';
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
  // The row's own edit button, captured at the moment it is pressed. The editor
  // is opened from one of many identical buttons in a long table, so without
  // this the window would grow out of the middle of the screen and the admin
  // would lose track of WHICH user they just opened. Handing the button to the
  // overlay makes it scale out of — and collapse back into — the exact row it
  // belongs to, which is the whole point of the spatial rule.
  const editAnchorRef = useRef<HTMLElement | null>(null);

  // WHY THE WINDOW DOES NOT READ `editingUser` DIRECTLY. `editingUser` going
  // null IS the close, but the panel is still on screen for the length of its
  // exit spring; reading the state would empty the form out from under the
  // animation and the admin would watch a blank card shrink back into the row.
  // So the last edited row is held for exactly as long as the window is still
  // being drawn.
  const lastEditedRef = useRef<AdminUserRow | null>(null);
  if (editingUser) lastEditedRef.current = editingUser;
  const editorUser = editingUser ?? lastEditedRef.current;

  // Closing is the Cancel button's behaviour, and Cancel is disabled while a
  // save is in flight. Escape and any other route out has to obey the same
  // rule, or the admin could dismiss the window mid-PATCH and never learn
  // whether the change landed.
  const closeEditor = () => {
    if (saving) return;
    setEditingUser(null);
  };

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
        membership_tier: updatedUser.membership_tier,
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
          {/* The actions column is pinned: this table is 900px wide inside a
              766px viewport on a tablet held upright, and its own row controls
              measured at x=-79 — off the screen entirely. The backgrounds are
              this table's own zinc palette rather than the shared admin tokens,
              and they are opaque on purpose: a translucent cell lets the
              scrolled columns show through the buttons. */}
          <table className="w-full text-left border-collapse min-w-[900px] [&_tr>*:last-child]:sticky [&_tr>*:last-child]:end-0 [&_tr>*:last-child]:z-[1] [&_tbody_tr>*:last-child]:bg-zinc-900 [&_thead_tr>*:last-child]:bg-zinc-800">
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
                      <span className="text-sm font-bold text-zinc-300 capitalize">{u.membership_tier || 'free'}</span>
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
                      onClick={(e) => { editAnchorRef.current = e.currentTarget; setSaveError(null); setEditingUser(u); }}
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

      {/*
        THE EDIT-USER WINDOW.

        It used to be a hand-rolled `fixed inset-0 bg-black/60 backdrop-blur-sm`
        that was mounted the instant a row's pencil was pressed and torn out of
        the DOM the instant it was dismissed: no arrival, and — the part that
        actually hurts — no departure. The admin's eye had nothing to follow
        back to the row they had just been editing, so after every save the
        long table had to be re-scanned to find their place again.

        `Overlay` AND NOT `Sheet`. This is a centred task dialog: it holds a
        form with a role choice, a plan select and an investor flag, and it is
        answered with Cancel or Save. `Sheet` is for a surface you throw away
        with your thumb, and a half-filled form is not something that should
        ever leave by accident. So the window stays centred, and the only ways
        out are the two buttons and Escape.

        NO SCRIM DISMISSAL, deliberately: the old backdrop had no onClick, so
        clicking outside never closed this form, and gaining that silently
        would mean a mis-aimed click on a full-screen dim could discard an
        edit. Escape is new and is the one route the primitive adds — it is
        the keyboard equivalent of Cancel, and it runs through the same
        `closeEditor` that refuses to close mid-save.

        `anchor` is the row's own pencil button, so the window grows out of the
        user it belongs to and collapses back into it. The z-index is still 50,
        exactly what the old markup used, so this keeps sitting under whatever
        already sat above it.

        The old markup had no role, no aria-modal and no accessible name at
        all; the primitive supplies the first two, and the "Edit User" heading
        that is already on screen now names the window through `labelledBy`.
      */}
      {editorUser && (
        <Overlay
          open={!!editingUser}
          onClose={closeEditor}
          mode="modal"
          anchor={editAnchorRef}
          labelledBy="admin-edit-user-title"
          dismissOnScrim={false}
          z={50}
          testId="admin-edit-user"
          // Geometry only — the material, the border and the rounding belong to
          // the primitive. `pointer-events-none` on the way out: while the panel
          // is playing its exit it is a picture of itself, and a click landing on
          // a role button then would re-open the window the admin just closed.
          panelClassName={`w-full max-w-md${editingUser ? '' : ' pointer-events-none'}`}
        >
          {/* The old inner padding lives on a plain div inside, where it belongs. */}
          <div className="p-6">
            <h3 id="admin-edit-user-title" className="text-xl font-bold text-white mb-6">Edit User</h3>

            <div className="space-y-4 mb-8">
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Name</label>
                <input
                  type="text"
                  value={editorUser.name || editorUser.username || ''}
                  disabled
                  className="w-full bg-zinc-800/50 border border-zinc-700 text-zinc-400 px-4 py-3 rounded-xl cursor-not-allowed"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Role</label>
                <div className="grid grid-cols-3 gap-3">
                  <button
                    onClick={() => setEditingUser({...editorUser, role: 'customer'})}
                    className={`py-3 rounded-xl font-bold border flex items-center justify-center gap-2 transition-colors text-sm ${editorUser.role === 'customer' ? 'bg-zinc-800 text-white border-zinc-600' : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:bg-zinc-800/50'}`}
                  >
                    <User className="w-4 h-4" /> Customer
                  </button>
                  <button
                    onClick={() => setEditingUser({...editorUser, role: 'merchant'})}
                    className={`py-3 rounded-xl font-bold border flex items-center justify-center gap-2 transition-colors text-sm ${editorUser.role === 'merchant' ? 'bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]/50' : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:bg-zinc-800/50'}`}
                  >
                    <Store className="w-4 h-4" /> Merchant
                  </button>
                  <button
                    onClick={() => setEditingUser({...editorUser, role: 'admin'})}
                    className={`py-3 rounded-xl font-bold border flex items-center justify-center gap-2 transition-colors text-sm ${editorUser.role === 'admin' ? 'bg-[#6B46FF]/20 text-[#6B46FF] border-[#6B46FF]/50' : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:bg-zinc-800/50'}`}
                  >
                    <Shield className="w-4 h-4" /> Admin
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Subscription Plan</label>
                <select
                  value={editorUser.membership_tier || 'free'}
                  onChange={(e) => setEditingUser({...editorUser, membership_tier: e.target.value as AdminUserRow['membership_tier']})}
                  className="w-full bg-zinc-800 border border-zinc-700 text-white px-4 py-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#6B46FF]/50 appearance-none font-medium capitalize"
                >
                  <option value="free">Free Plan</option>
                  <option value="plus">Plus Plan</option>
                  <option value="prime">LEVO PRIME</option>
                  <option value="pro">Pro Plan</option>
                </select>
              </div>

              <label className="flex items-center gap-3 cursor-pointer bg-zinc-800/50 border border-zinc-700 rounded-xl px-4 py-3">
                <input
                  type="checkbox"
                  checked={!!editorUser.is_investor}
                  onChange={(e) => setEditingUser({...editorUser, is_investor: e.target.checked ? 1 : 0})}
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
                onClick={closeEditor}
                disabled={saving}
                className="px-5 py-2.5 rounded-xl font-bold text-zinc-400 hover:bg-zinc-800 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleSaveUser(editorUser)}
                disabled={saving}
                className="px-5 py-2.5 rounded-xl font-bold bg-white text-black hover:bg-zinc-200 transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                <Check className="w-4 h-4" /> {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </Overlay>
      )}
    </div>
  );
}
