import re

with open('src/pages/InvestAdmin.tsx', 'r') as f:
    content = f.read()

# I will just write a patch that adds an edit modal or inline edit for investments
new_details = """
function AdminInvestmentDetails({ inv, onBack }: { inv: any, onBack: () => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [image, setImage] = useState('');
  
  // Edit states
  const [amount, setAmount] = useState(inv.amount);
  const [profit, setProfit] = useState(inv.expected_profit);
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
"""

content = re.sub(
    r"function AdminInvestmentDetails\(\{ inv, onBack \}: \{ inv: any, onBack: \(\) => void \}\) \{.*?\n\}\n(?=function AdminChat|$)",
    new_details,
    content,
    flags=re.DOTALL
)

with open('src/pages/InvestAdmin.tsx', 'w') as f:
    f.write(content)
