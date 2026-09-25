import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../AuthContext';
import { api, ApiError, formatUsdCents } from '../lib/api';
import { TrendingUp, MessageSquare, Plus, Edit, Trash } from 'lucide-react';

interface AdminInvestUser {
  id: string;
  email: string;
  username: string | null;
  name: string;
  is_investor: number | boolean;
  created_at: string;
}

interface Investment {
  id: string;
  user_id: string;
  amount_usd_cents: number;
  expected_profit_usd_cents: number;
  start_date: string;
  end_date: string;
  status: 'active' | 'completed' | 'cancelled' | string;
  created_at: string;
}

interface InvestmentItem {
  id: string;
  investment_id: string;
  name: string;
  price_usd_cents: number;
  image: string | null;
}

interface InvestorMessage {
  id: string;
  sender: 'user' | 'admin';
  message: string;
  created_at: string;
}

function errMsg(err: unknown, fallback: string): string {
  return (err instanceof ApiError && err.message) || fallback;
}

/** Parse a dollars input into integer USD cents; null when invalid. */
function dollarsToCents(input: string): number | null {
  const n = parseFloat(input);
  if (isNaN(n) || n < 0) return null;
  return Math.round(n * 100);
}

export default function InvestAdmin() {
  const { user } = useAuth();
  const [users, setUsers] = useState<AdminInvestUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<AdminInvestUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    try {
      const data = await api.get<{ users: AdminInvestUser[] }>('/api/admin/invest/users');
      setUsers(data.users || []);
      setError(null);
    } catch (err) {
      setError(errMsg(err, 'Failed to load users'));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadUsers().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [loadUsers]);

  const toggleInvestor = async (e: React.MouseEvent, u: AdminInvestUser) => {
    e.stopPropagation();
    try {
      await api.patch(`/api/admin/users/${u.id}`, { is_investor: !u.is_investor });
      await loadUsers();
    } catch (err) {
      alert(errMsg(err, 'Failed to update user'));
    }
  };

  // The route is admin-gated in App.tsx and the API enforces the role;
  // this is only a client-side fallback.
  if (!user?.isAdmin) return <div className="p-8 text-white">Access Denied</div>;

  return (
    <div className="w-full min-h-screen bg-black text-white p-8">
      <h1 className="text-3xl font-bold mb-8">Investor Management</h1>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-gold border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : error ? (
        <div className="text-zinc-400">
          <p className="mb-4">{error}</p>
          <button onClick={() => { setLoading(true); loadUsers().finally(() => setLoading(false)); }} className="bg-zinc-800 hover:bg-zinc-700 px-4 py-2 rounded-lg">Retry</button>
        </div>
      ) : !selectedUser ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {users.length === 0 && <p className="text-zinc-500">No users found.</p>}
          {users.map(u => (
            <div key={u.id} className="bg-zinc-900 p-6 rounded-xl cursor-pointer hover:bg-zinc-800 transition flex justify-between items-center" onClick={() => setSelectedUser(u)}>
              <div>
                <h2 className="text-xl font-bold mb-1 flex items-center gap-2">
                  {u.name || u.username || u.email}
                  {!!u.is_investor && <span className="bg-gold text-accent-contrast text-xs px-2 py-1 rounded font-bold">Investor</span>}
                </h2>
                <p className="text-zinc-400">{u.email}</p>
              </div>
              <button onClick={(e) => toggleInvestor(e, u)} className="bg-zinc-700 hover:bg-zinc-600 px-3 py-1 rounded text-sm">
                {u.is_investor ? 'Revoke' : 'Make Investor'}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div>
          <button onClick={() => setSelectedUser(null)} className="mb-6 text-gold hover:underline">&larr; Back to users</button>
          <UserDetails user={selectedUser} />
        </div>
      )}
    </div>
  );
}

function UserDetails({ user }: { user: AdminInvestUser }) {
  const [activeTab, setActiveTab] = useState('investments');
  const [investments, setInvestments] = useState<Investment[]>([]);
  const [items, setItems] = useState<Record<string, InvestmentItem[]>>({});
  const [messages, setMessages] = useState<InvestorMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const data = await api.get<{
        investments: Investment[];
        items: Record<string, InvestmentItem[]>;
        messages: InvestorMessage[];
      }>(`/api/admin/invest/users/${user.id}`);
      setInvestments(data.investments || []);
      setItems(data.items || {});
      setMessages(data.messages || []);
      setLoadError(null);
    } catch (err) {
      setLoadError(errMsg(err, 'Failed to load user data'));
    }
  }, [user.id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  return (
    <div className="flex gap-8">
      <div className="w-64 shrink-0 flex flex-col gap-2">
        <button className={`p-4 rounded-xl text-left ${activeTab === 'investments' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-900'}`} onClick={() => setActiveTab('investments')}>
          <TrendingUp className="inline-block mr-2" /> Investments
        </button>
        <button className={`p-4 rounded-xl text-left ${activeTab === 'chat' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-900'}`} onClick={() => setActiveTab('chat')}>
          <MessageSquare className="inline-block mr-2" /> Chat Support
        </button>
      </div>

      <div className="flex-1 bg-zinc-900 p-8 rounded-2xl">
        {loadError && <p className="text-red-400 mb-4">{loadError}</p>}
        {activeTab === 'investments' && <AdminInvestments user={user} investments={investments} items={items} loadData={loadData} />}
        {activeTab === 'chat' && <AdminChat user={user} messages={messages} loadData={loadData} />}
      </div>
    </div>
  );
}

function AdminInvestments({ user, investments, items, loadData }: {
  user: AdminInvestUser;
  investments: Investment[];
  items: Record<string, InvestmentItem[]>;
  loadData: () => Promise<void>;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [selectedInvId, setSelectedInvId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Form states (USD dollars as typed by the admin; converted to cents on save)
  const [amount, setAmount] = useState('');
  const [profit, setProfit] = useState('');
  const [duration, setDuration] = useState('40'); // days

  const handleAdd = async () => {
    const amountCents = dollarsToCents(amount);
    const profitCents = dollarsToCents(profit) ?? 0;
    const days = parseInt(duration, 10);
    if (amountCents === null || amountCents <= 0) {
      alert('Enter a valid amount (USD)');
      return;
    }
    if (isNaN(days) || days < 1) {
      alert('Enter a valid duration in days');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/admin/invest/users/${user.id}/investments`, {
        amount_usd_cents: amountCents,
        expected_profit_usd_cents: profitCents,
        duration_days: days,
      });
      setShowAdd(false);
      setAmount('');
      setProfit('');
      setDuration('40');
      await loadData();
    } catch (err) {
      alert(errMsg(err, 'Failed to create investment'));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (inv: Investment) => {
    if (!window.confirm(`Delete investment ${inv.id}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.delete(`/api/admin/invest/investments/${inv.id}`);
      if (selectedInvId === inv.id) setSelectedInvId(null);
      await loadData();
    } catch (err) {
      alert(errMsg(err, 'Failed to delete investment'));
    } finally {
      setBusy(false);
    }
  };

  const selectedInv = selectedInvId ? investments.find((i) => i.id === selectedInvId) : null;
  if (selectedInv) {
    return (
      <AdminInvestmentDetails
        inv={selectedInv}
        items={items[selectedInv.id] || []}
        onBack={() => setSelectedInvId(null)}
        loadData={loadData}
      />
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold">Investments for {user.name || user.username || user.email}</h2>
        <button onClick={() => setShowAdd(true)} className="bg-gold text-accent-contrast px-4 py-2 rounded-lg font-bold flex items-center">
          <Plus className="w-5 h-5 mr-1" /> New Investment
        </button>
      </div>

      {showAdd && (
        <div className="bg-zinc-800 p-6 rounded-xl mb-6 grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Amount (USD)</label>
            <input type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white" />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Expected Profit (USD)</label>
            <input type="number" min="0" step="0.01" value={profit} onChange={e => setProfit(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white" />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Duration (Days)</label>
            <input type="number" min="1" value={duration} onChange={e => setDuration(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white" />
          </div>
          <div className="flex items-end gap-2">
            <button onClick={handleAdd} disabled={busy} className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-snow px-6 py-3 rounded-lg font-bold flex-1">Save</button>
            <button onClick={() => setShowAdd(false)} className="bg-zinc-700 hover:bg-zinc-600 text-white px-6 py-3 rounded-lg font-bold">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {investments.length === 0 && <p className="text-zinc-500">No investments for this user yet.</p>}
        {investments.map(inv => (
          <div key={inv.id} className="bg-zinc-800 p-6 rounded-xl flex justify-between items-center">
            <div>
              <div className="font-bold text-lg">ID: {inv.id}</div>
              <div className="text-zinc-400">
                Invested: {formatUsdCents(inv.amount_usd_cents)} | Target Profit: {formatUsdCents(inv.expected_profit_usd_cents)} | Status: {inv.status}
              </div>
            </div>
            <div className="flex items-center gap-4">
              <button onClick={() => setSelectedInvId(inv.id)} className="text-gold hover:underline">Manage</button>
              <button onClick={() => handleDelete(inv)} disabled={busy} className="text-red-500 hover:bg-zinc-700 p-2 rounded-lg disabled:opacity-50">
                <Trash className="w-5 h-5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminInvestmentDetails({ inv, items, onBack, loadData }: {
  inv: Investment;
  items: InvestmentItem[];
  onBack: () => void;
  loadData: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [image, setImage] = useState('');
  const [busy, setBusy] = useState(false);

  const durationDays = Math.ceil((new Date(inv.end_date).getTime() - new Date(inv.start_date).getTime()) / (1000 * 60 * 60 * 24));

  // Edit states (dollars for money fields)
  const [amount, setAmount] = useState(() => (inv.amount_usd_cents / 100).toString());
  const [profit, setProfit] = useState(() => (inv.expected_profit_usd_cents / 100).toString());
  const [duration, setDuration] = useState(() => durationDays.toString());
  const [status, setStatus] = useState(inv.status);
  const [isEditing, setIsEditing] = useState(false);

  const addItem = async () => {
    const priceCents = dollarsToCents(price) ?? 0;
    if (!name.trim()) {
      alert('Enter an item name');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/admin/invest/investments/${inv.id}/items`, {
        name: name.trim(),
        price_usd_cents: priceCents,
        image: image.trim() || undefined,
      });
      setName(''); setPrice(''); setImage('');
      await loadData();
    } catch (err) {
      alert(errMsg(err, 'Failed to add item'));
    } finally {
      setBusy(false);
    }
  };

  const deleteItem = async (id: string) => {
    if (!window.confirm('Delete this item?')) return;
    setBusy(true);
    try {
      await api.delete(`/api/admin/invest/items/${id}`);
      await loadData();
    } catch (err) {
      alert(errMsg(err, 'Failed to delete item'));
    } finally {
      setBusy(false);
    }
  };

  const updateInvestment = async () => {
    const amountCents = dollarsToCents(amount);
    const profitCents = dollarsToCents(profit);
    const days = parseInt(duration, 10);
    if (amountCents === null || amountCents <= 0) {
      alert('Enter a valid amount (USD)');
      return;
    }
    if (profitCents === null) {
      alert('Enter a valid expected profit (USD)');
      return;
    }
    if (isNaN(days) || days < 1) {
      alert('Enter a valid duration in days');
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/api/admin/invest/investments/${inv.id}`, {
        amount_usd_cents: amountCents,
        expected_profit_usd_cents: profitCents,
        duration_days: days,
        status,
      });
      setIsEditing(false);
      await loadData();
    } catch (err) {
      alert(errMsg(err, 'Failed to update investment'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button onClick={onBack} className="mb-6 text-gold hover:underline">&larr; Back to investments</button>

      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold">Manage Investment {inv.id}</h2>
        <button onClick={() => setIsEditing(!isEditing)} className="text-gold hover:underline">
          <Edit className="w-5 h-5" />
        </button>
      </div>

      {isEditing ? (
        <div className="bg-zinc-800 p-6 rounded-xl mb-6 grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Amount (USD)</label>
            <input type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white" />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Expected Profit (USD)</label>
            <input type="number" min="0" step="0.01" value={profit} onChange={e => setProfit(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white" />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Duration (Days)</label>
            <input type="number" min="1" value={duration} onChange={e => setDuration(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white" />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Status</label>
            <select value={status} onChange={e => setStatus(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white">
              <option value="active">Active</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <button onClick={updateInvestment} disabled={busy} className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-snow px-6 py-3 rounded-lg font-bold col-span-2">Save Changes</button>
        </div>
      ) : (
        <div className="bg-zinc-800 p-6 rounded-xl mb-6 flex gap-8 flex-wrap">
          <div>
            <div className="text-sm text-zinc-400">Amount</div>
            <div className="text-xl font-bold">{formatUsdCents(inv.amount_usd_cents)}</div>
          </div>
          <div>
            <div className="text-sm text-zinc-400">Expected Profit</div>
            <div className="text-xl font-bold text-green-500">+{formatUsdCents(inv.expected_profit_usd_cents)}</div>
          </div>
          <div>
            <div className="text-sm text-zinc-400">Duration</div>
            <div className="text-xl font-bold">{durationDays} Days</div>
          </div>
          <div>
            <div className="text-sm text-zinc-400">Status</div>
            <div className="text-xl font-bold capitalize">{inv.status}</div>
          </div>
        </div>
      )}

      <h3 className="text-xl font-bold mb-4">Items Purchased</h3>
      <div className="bg-zinc-800 p-6 rounded-xl mb-6 grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Item Name</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white" />
        </div>
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Item Price (USD)</label>
          <input type="number" min="0" step="0.01" value={price} onChange={e => setPrice(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white" />
        </div>
        <div className="col-span-2">
          <label className="block text-sm text-zinc-400 mb-1">Image URL (optional)</label>
          <input type="text" value={image} onChange={e => setImage(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white" />
        </div>
        <button onClick={addItem} disabled={busy} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-snow px-6 py-3 rounded-lg font-bold col-span-2">Add Item</button>
      </div>

      <div className="flex flex-col gap-4">
        {items.length === 0 && <p className="text-zinc-500">No items yet.</p>}
        {items.map(item => (
          <div key={item.id} className="bg-zinc-800 p-4 rounded-xl flex items-center gap-4">
            {item.image && <img src={item.image} alt={item.name} className="w-16 h-16 object-cover rounded-lg" />}
            <div className="flex-1">
              <div className="font-bold">{item.name}</div>
              <div className="text-zinc-400">{formatUsdCents(item.price_usd_cents)}</div>
            </div>
            <button onClick={() => deleteItem(item.id)} disabled={busy} className="text-red-500 hover:bg-zinc-700 p-2 rounded-lg disabled:opacity-50">
              <Trash className="w-5 h-5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminChat({ user, messages, loadData }: {
  user: AdminInvestUser;
  messages: InvestorMessage[];
  loadData: () => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    try {
      await api.post(`/api/admin/invest/users/${user.id}/messages`, { message });
      setText('');
      await loadData();
    } catch (err) {
      alert(errMsg(err, 'Failed to send message'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="h-[600px] flex flex-col bg-black rounded-xl overflow-hidden border border-zinc-800">
      <div className="p-4 bg-zinc-900 border-b border-zinc-800 font-bold">Chat with {user.name || user.username || user.email}</div>
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
        {messages.length === 0 && <div className="self-center text-xs text-zinc-500 my-2">No messages yet.</div>}
        {messages.map(m => (
          <div key={m.id} className={`max-w-[80%] p-3 rounded-2xl ${m.sender === 'admin' ? 'bg-gold text-accent-contrast self-end rounded-tr-sm' : 'bg-zinc-800 text-white self-start rounded-tl-sm'}`}>
            {m.message}
          </div>
        ))}
      </div>
      <div className="p-4 bg-zinc-900 flex gap-2">
        <input
          type="text"
          className="flex-1 bg-black text-white p-3 rounded-lg border border-zinc-800"
          placeholder="Reply..."
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
        />
        <button onClick={send} disabled={sending || !text.trim()} className="bg-gold text-accent-contrast px-6 font-bold rounded-lg disabled:opacity-50">Send</button>
      </div>
    </div>
  );
}
