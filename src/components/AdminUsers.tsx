import React, { useState, useEffect } from 'react';
import { useLanguage } from '../LanguageContext';
import { queryDb } from '../lib/db';
import { Search, Edit2, Shield, User, Wallet, Check, X, CreditCard } from 'lucide-react';

export default function AdminUsers() {
  const { t, dir } = useLanguage();
  const [users, setUsers] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [editingUser, setEditingUser] = useState<any | null>(null);

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    try {
      const res = await queryDb('SELECT * FROM users ORDER BY created_at DESC');
      setUsers(res);
    } catch (err) {
      console.error(err);
    }
  };

  const filteredUsers = users.filter(u => 
    (u.name || '').toLowerCase().includes(searchTerm.toLowerCase()) || 
    (u.email || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleSaveUser = async (updatedUser: any) => {
    try {
      await queryDb(`
        UPDATE users 
        SET isAdmin = ?, subscription_plan = ?
        WHERE id = ?
      `, [updatedUser.isAdmin ? 1 : 0, updatedUser.subscription_plan, updatedUser.id]);
      
      setUsers(users.map(u => u.id === updatedUser.id ? updatedUser : u));
      setEditingUser(null);
    } catch (err) {
      console.error("Failed to update user", err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <h2 className="text-2xl font-black text-white">{t('adminUsers')}</h2>
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

      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[800px]">
            <thead>
              <tr className="bg-zinc-800/50 border-b border-zinc-700">
                <th className="py-4 px-6 text-xs font-bold text-zinc-400 uppercase tracking-wider">User Info</th>
                <th className="py-4 px-6 text-xs font-bold text-zinc-400 uppercase tracking-wider">Role</th>
                <th className="py-4 px-6 text-xs font-bold text-zinc-400 uppercase tracking-wider">Plan</th>
                <th className="py-4 px-6 text-xs font-bold text-zinc-400 uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u, i) => (
                <tr key={i} className="border-b border-zinc-800 hover:bg-zinc-800/30 transition-colors">
                  <td className="py-4 px-6">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center shrink-0 border border-zinc-700">
                        {u.isAdmin ? <Shield className="w-5 h-5 text-[#6B46FF]" /> : <User className="w-5 h-5 text-zinc-400" />}
                      </div>
                      <div>
                        <div className="font-bold text-zinc-200">{u.name || u.username || 'Unnamed User'}</div>
                        <div className="text-sm text-zinc-500 font-medium">{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="py-4 px-6">
                    <span className={`px-3 py-1 rounded-full text-xs font-bold border ${u.isAdmin ? 'bg-[#6B46FF]/10 text-[#6B46FF] border-[#6B46FF]/20' : 'bg-zinc-800 text-zinc-400 border-zinc-700'}`}>
                      {u.isAdmin ? 'Admin' : 'Customer'}
                    </span>
                  </td>
                  <td className="py-4 px-6">
                    <div className="flex items-center gap-2">
                      <CreditCard className="w-4 h-4 text-zinc-500" />
                      <span className="text-sm font-bold text-zinc-300 capitalize">{u.subscription_plan || 'free'}</span>
                    </div>
                  </td>
                  <td className="py-4 px-6 text-right">
                    <button 
                      onClick={() => setEditingUser(u)}
                      className="p-2 hover:bg-zinc-700 rounded-lg text-zinc-400 hover:text-white transition-colors"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-12 text-center text-zinc-500 font-medium">No users found matching "{searchTerm}"</td>
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
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setEditingUser({...editingUser, isAdmin: false})}
                    className={`py-3 rounded-xl font-bold border flex items-center justify-center gap-2 transition-colors ${!editingUser.isAdmin ? 'bg-zinc-800 text-white border-zinc-600' : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:bg-zinc-800/50'}`}
                  >
                    <User className="w-4 h-4" /> Customer
                  </button>
                  <button
                    onClick={() => setEditingUser({...editingUser, isAdmin: true})}
                    className={`py-3 rounded-xl font-bold border flex items-center justify-center gap-2 transition-colors ${editingUser.isAdmin ? 'bg-[#6B46FF]/20 text-[#6B46FF] border-[#6B46FF]/50' : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:bg-zinc-800/50'}`}
                  >
                    <Shield className="w-4 h-4" /> Admin
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">Subscription Plan</label>
                <select 
                  value={editingUser.subscription_plan || 'free'}
                  onChange={(e) => setEditingUser({...editingUser, subscription_plan: e.target.value})}
                  className="w-full bg-zinc-800 border border-zinc-700 text-white px-4 py-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#6B46FF]/50 appearance-none font-medium capitalize"
                >
                  <option value="free">Free Plan</option>
                  <option value="plus">Plus Plan</option>
                  <option value="pro">Pro Plan</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-3">
              <button 
                onClick={() => setEditingUser(null)}
                className="px-5 py-2.5 rounded-xl font-bold text-zinc-400 hover:bg-zinc-800 transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={() => handleSaveUser(editingUser)}
                className="px-5 py-2.5 rounded-xl font-bold bg-white text-black hover:bg-zinc-200 transition-colors flex items-center gap-2"
              >
                <Check className="w-4 h-4" /> Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
