import re

with open('src/pages/InvestAdmin.tsx', 'r') as f:
    content = f.read()

duration_state = """  const [duration, setDuration] = useState(Math.ceil((new Date(inv.end_date).getTime() - new Date(inv.start_date).getTime()) / (1000 * 60 * 60 * 24)));"""
content = content.replace("  const [isEditing, setIsEditing] = useState(false);", duration_state + "\n  const [isEditing, setIsEditing] = useState(false);")

update_func = """  const updateInvestment = async () => {
    const end = new Date(inv.start_date);
    end.setDate(end.getDate() + parseInt(duration.toString()));
    await queryDb('UPDATE investments SET amount = ?, expected_profit = ?, end_date = ? WHERE id = ?', [parseFloat(amount), parseFloat(profit), end.toISOString(), inv.id]);
    setIsEditing(false);
    inv.amount = parseFloat(amount);
    inv.expected_profit = parseFloat(profit);
    inv.end_date = end.toISOString();
  };"""
content = re.sub(r"  const updateInvestment = async \(\) \{.*?\n  \};", update_func, content, flags=re.DOTALL)

input_field = """          <div>
            <label className="block text-sm text-zinc-400 mb-1">Duration (Days)</label>
            <input type="number" value={duration} onChange={e => setDuration(e.target.value)} className="w-full bg-zinc-900 p-3 rounded-lg text-white" />
          </div>"""
content = content.replace("          <button onClick={updateInvestment}", input_field + "\n          <button onClick={updateInvestment}")

with open('src/pages/InvestAdmin.tsx', 'w') as f:
    f.write(content)
