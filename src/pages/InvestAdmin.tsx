import React, { useState, useEffect } from 'react';
import { useAuth } from '../AuthContext';
import { queryDb } from '../lib/db';
import { Users, TrendingUp, MessageSquare, Plus, Edit, Trash } from 'lucide-react';

export default function InvestAdmin() {
  const { user } = useAuth();
  const [users, setUsers] = useState<any[]>([]);
  const [selectedUser, setSelectedUser] = useState<any>(null);
  
  useEffect(() => {
    if (user?.isAdmin) {
      loadUsers();
    }
  }, [user]);

  
  const toggleInvestor = async (e: any, u: any) => {
    e.stopPropagation();
    await queryDb('UPDATE users SET isInvestor = ? WHERE id = ?', [u.isInvestor ? 0 : 1, u.id]);
    loadUsers();
  };

  const loadUsers = async () => {
    const res = await queryDb('SELECT * FROM users');
    setUsers(res || []);
  };

  if (!user?.isAdmin) return <div className="p-8 text-white">Access Denied</div>;

  return (
    <div className="w-full min-h-screen bg-black text-white p-8">
      <h1 className="text-3xl font-bold mb-8">Investor Management</h1>
      
      {!selectedUser ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {users.map(u => (
            
            <div key={u.id} className="bg-zinc-900 p-6 rounded-xl cursor-pointer hover:bg-zinc-800 transition flex justify-between items-center" onClick={() => setSelectedUser(u)}>
              <div>
                <h2 className="text-xl font-bold mb-1 flex items-center gap-2">
                  {u.name} 
                  {u.isInvestor === 1 && <span className="bg-gold text-black text-xs px-2 py-1 rounded font-bold">Investor</span>}
                </h2>
                <p className="text-zinc-400">{u.email}</p>
              </div>
              <button onClick={(e) => toggleInvestor(e, u)} className="bg-zinc-700 hover:bg-zinc-600 px-3 py-1 rounded text-sm">
                {u.isInvestor ? 'Revoke' : 'Make Investor'}
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

function UserDetails({ user }: { user: any }) {
  const [activeTab, setActiveTab] = useState('investments');
  const [investments, setInvestments] = useState<any[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  
  useEffect(() => {
    loadData();
  }, [user.id]);
  
  const loadData = async () => {
    const invs = await queryDb('SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC', [user.id]);
    setInvestments(invs || []);
    const msgs = await queryDb('SELECT * FROM investor_messages WHERE user_id = ? ORDER BY created_at ASC', [user.id]);
    setMessages(msgs || []);
  };
  
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
        {activeTab === 'investments' && <AdminInvestments user={user} investments={investments} loadData={loadData} />}
        {activeTab === 'chat' && <AdminChat user={user} messages={messages} loadData={loadData} />}
      </div>
    </div>
  );
}

function AdminInvestments({ user, investments, loadData }: { user: any, investments: any[], loadData: () => void }) {
  const [showAdd, setShowAdd] = useState(false);
  const [selectedInv, setSelectedInv] = useState<any>(null);
  
  // Form states
  const [amount, setAmount] = useState('');
  const [profit, setProfit] = useState('');
  const [duration, setDuration] = useState('40'); // days
  
  const handleAdd = async () => {
    const id = Math.random().toString(36).substr(2,9);
    const start = new Date();
    const end = new Date();
    end.setDate(end.getDate() + parseInt(duration));
    
    await queryDb(`
      INSERT INTO investments (id, user_id, amount, expected_profit, start_date, end_date) 
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, user.id, parseFloat(amount), parseFloat(profit), start.toISOString(), end.toISOString()]);
    
    setShowAdd(false);
    loadData();
  };
  
  if (selectedInv) return <AdminInvestmentDetails inv={selectedInv} onBack={() => setSelectedInv(null)} />;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold">Investments for {user.name}</h2>
        <button onClick={() => setShowAdd(true)} className="bg-gold text-black px-4 py-2 rounded-lg font-bold flex items-center">
          <Plus className="w-5 h-5 mr-1" /> New Investment
        </button>
      </div>
      
      {showAdd && (
        <div className="bg-zinc-800 p-6 rounded-xl mb-6 grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Amount</label>
            <input type="number" value={amount} onChange={e => setAmount(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white" />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Expected Profit</label>
            <input type="number" value={profit} onChange={e => setProfit(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white" />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Duration (Days)</label>
            <input type="number" value={duration} onChange={e => setDuration(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white" />
          </div>
          <div className="flex items-end gap-2">
            <button onClick={handleAdd} className="bg-green-600 hover:bg-green-700 text-white px-6 py-3 rounded-lg font-bold flex-1">Save</button>
            <button onClick={() => setShowAdd(false)} className="bg-zinc-700 hover:bg-zinc-600 text-white px-6 py-3 rounded-lg font-bold">Cancel</button>
          </div>
        </div>
      )}
      
      <div className="flex flex-col gap-4">
        {investments.map(inv => (
          <div key={inv.id} className="bg-zinc-800 p-6 rounded-xl flex justify-between items-center">
            <div>
              <div className="font-bold text-lg">ID: {inv.id}</div>
              <div className="text-zinc-400">Invested: {inv.amount} | Target Profit: {inv.expected_profit}</div>
            </div>
            <button onClick={() => setSelectedInv(inv)} className="text-gold hover:underline">Manage Items</button>
          </div>
        ))}
      </div>
    </div>
  );
}


function AdminInvestmentDetails({ inv, onBack }: { inv: any, onBack: () => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [image, setImage] = useState('');
  
  // Edit states
  const [amount, setAmount] = useState(inv.amount);
  const [profit, setProfit] = useState(inv.expected_profit);
  const [duration, setDuration] = useState(Math.ceil((new Date(inv.end_date).getTime() - new Date(inv.start_date).getTime()) / (1000 * 60 * 60 * 24)));
  const [isEditing, setIsEditing] = useState(false);
  
  useEffect(() => {
    loadItems();
  }, [inv.id]);
  
  const loadItems = async () => {
    const res = await queryDb('SELECT * FROM investment_items WHERE investment_id = ?', [inv.id]);
    setItems(res || []);
  };
  
  const addItem = async () => {
    const id = Math.random().toString(36).substr(2,9);
    await queryDb('INSERT INTO investment_items (id, investment_id, name, price, image) VALUES (?, ?, ?, ?, ?)', [id, inv.id, name, parseFloat(price), image]);
    setName(''); setPrice(''); setImage('');
    loadItems();
  };

  const deleteItem = async (id: string) => {
    await queryDb('DELETE FROM investment_items WHERE id = ?', [id]);
    loadItems();
  };
  
  const updateInvestment = async () => {
    await queryDb('UPDATE investments SET amount = ?, expected_profit = ? WHERE id = ?', [parseFloat(amount), parseFloat(profit), inv.id]);
    setIsEditing(false);
    inv.amount = parseFloat(amount);
    inv.expected_profit = parseFloat(profit);
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
            <label className="block text-sm text-zinc-400 mb-1">Amount</label>
            <input type="number" value={amount} onChange={e => setAmount(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white" />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Expected Profit</label>
            <input type="number" value={profit} onChange={e => setProfit(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white" />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Duration (Days)</label>
            <input type="number" value={duration} onChange={e => setDuration(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white" />
          </div>
          <button onClick={updateInvestment} className="bg-green-600 hover:bg-green-700 text-white px-6 py-3 rounded-lg font-bold col-span-2">Save Changes</button>
        </div>
      ) : (
        <div className="bg-zinc-800 p-6 rounded-xl mb-6 flex gap-8">
          <div>
            <div className="text-sm text-zinc-400">Amount</div>
            <div className="text-xl font-bold">${inv.amount}</div>
          </div>
          <div>
            <div className="text-sm text-zinc-400">Expected Profit</div>
            <div className="text-xl font-bold text-green-500">+${inv.expected_profit}</div>
          </div>
          <div>
            <div className="text-sm text-zinc-400">Duration</div>
            <div className="text-xl font-bold">{Math.ceil((new Date(inv.end_date).getTime() - new Date(inv.start_date).getTime()) / (1000 * 60 * 60 * 24))} Days</div>
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
          <label className="block text-sm text-zinc-400 mb-1">Item Price</label>
          <input type="number" value={price} onChange={e => setPrice(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white" />
        </div>
        <div className="col-span-2">
          <label className="block text-sm text-zinc-400 mb-1">Image URL</label>
          <input type="text" value={image} onChange={e => setImage(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white" />
        </div>
        <button onClick={addItem} className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-bold col-span-2">Add Item</button>
      </div>
      
      <div className="flex flex-col gap-4">
        {items.map(item => (
          <div key={item.id} className="bg-zinc-800 p-4 rounded-xl flex items-center gap-4">
            {item.image && <img src={item.image} className="w-16 h-16 object-cover rounded-lg" />}
            <div className="flex-1">
              <div className="font-bold">{item.name}</div>
              <div className="text-zinc-400">${item.price}</div>
            </div>
            <button onClick={() => deleteItem(item.id)} className="text-red-500 hover:bg-zinc-700 p-2 rounded-lg">
              <Trash className="w-5 h-5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminChat({ user, messages, loadData }: { user: any, messages: any[], loadData: () => void }) {
  const [text, setText] = useState('');
  
  const send = async () => {
    if (!text.trim()) return;
    const id = Math.random().toString(36).substr(2,9);
    await queryDb('INSERT INTO investor_messages (id, user_id, sender, message) VALUES (?, ?, ?, ?)', [id, user.id, 'admin', text]);
    setText('');
    loadData();
  };
  
  return (
    <div className="h-[600px] flex flex-col bg-black rounded-xl overflow-hidden border border-zinc-800">
      <div className="p-4 bg-zinc-900 border-b border-zinc-800 font-bold">Chat with {user.name}</div>
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
        {messages.map(m => (
          <div key={m.id} className={`max-w-[80%] p-3 rounded-2xl ${m.sender === 'admin' ? 'bg-gold text-black self-end rounded-tr-sm' : 'bg-zinc-800 text-white self-start rounded-tl-sm'}`}>
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
        <button onClick={send} className="bg-gold text-black px-6 font-bold rounded-lg">Send</button>
      </div>
    </div>
  );
}
