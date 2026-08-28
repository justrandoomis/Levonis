import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Add actionType state
new_state = "  const [amount, setAmount] = useState('0');\n  const [actionType, setActionType] = useState<'deposit'|'withdraw'>('deposit');"
content = content.replace("  const [amount, setAmount] = useState('0');", new_state)

# Replace the tabs
old_tabs = """      <div className="flex justify-center border-b border-zinc-200 mb-8 w-full">
        <div className="w-1/2 text-center pb-3 border-b-2 border-[#e6a84f] text-[#e6a84f] font-bold">One time</div>
        <div className="w-1/2 text-center pb-3 text-zinc-400 font-bold">Automated</div>
      </div>"""

new_tabs = """      <div className="flex justify-center border-b border-zinc-200 mb-8 w-full">
        <div 
          onClick={() => setActionType('deposit')}
          className={`w-1/2 text-center pb-3 font-bold cursor-pointer transition-colors ${actionType === 'deposit' ? 'border-b-2 border-[#e6a84f] text-[#e6a84f]' : 'text-zinc-400'}`}>
          Deposit
        </div>
        <div 
          onClick={() => setActionType('withdraw')}
          className={`w-1/2 text-center pb-3 font-bold cursor-pointer transition-colors ${actionType === 'withdraw' ? 'border-b-2 border-[#e6a84f] text-[#e6a84f]' : 'text-zinc-400'}`}>
          Withdraw
        </div>
      </div>"""

content = content.replace(old_tabs, new_tabs)

# Remove the redundant secondary buttons
old_buttons = """      <div className="flex justify-center gap-4 mb-8">
        <button className="bg-zinc-100 text-zinc-800 px-6 py-2 rounded-full font-bold text-sm">Deposit</button>
        <button className="bg-zinc-100 text-zinc-800 px-6 py-2 rounded-full font-bold text-sm">Withdraw</button>
      </div>"""

content = content.replace(old_buttons, "")

# Update the title as well maybe? Just keep it as "Add or move funds" or "Move funds".
content = content.replace('<h1 className="text-xl font-bold text-zinc-900 mx-auto mb-8">Add or move funds</h1>', '<h1 className="text-xl font-bold text-zinc-900 mx-auto mb-8">Move funds</h1>')

# Update the action button
content = content.replace('<button className="w-full bg-[#e6a84f] hover:bg-[#d49942] text-white font-bold py-4 rounded-full transition-colors text-lg mt-auto">\n        Continue\n      </button>', '<button className="w-full bg-[#e6a84f] hover:bg-[#d49942] text-white font-bold py-4 rounded-full transition-colors text-lg mt-auto">\n        {actionType === \'deposit\' ? \'Confirm Deposit\' : \'Confirm Withdrawal\'}\n      </button>')

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
