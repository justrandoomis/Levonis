import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Update InvestTab list item
new_item = """
              return (
                <div key={inv.id} onClick={() => setSelectedInvest(inv)} className="flex justify-between items-center cursor-pointer p-4 hover:bg-zinc-50 rounded-xl transition-colors border border-zinc-100">
                  <div className="flex flex-col">
                    <span className="font-bold text-zinc-900">Investment #{inv.id.slice(0,4).toUpperCase()}</span>
                    <span className="text-xs text-zinc-500">Starts: {new Date(inv.start_date).toLocaleDateString()}</span>
                    {isCompleted ? (
                      <span className="text-xs text-green-600 font-bold">Completed</span>
                    ) : (
                      <span className="text-xs text-[#e6a84f] font-bold">Active</span>
                    )}
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="font-bold text-zinc-900">${currentVal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                    <span className="text-xs text-green-600">+{currentProfit.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                    <span className="text-[10px] text-zinc-400 mt-1">Target: ${(inv.amount + inv.expected_profit).toLocaleString()}</span>
                  </div>
                </div>
              );
"""

content = re.sub(
    r"return \(\s*<div key=\{inv\.id\} onClick=\{\(\) => setSelectedInvest\(inv\)\} className=\"flex justify-between items-center cursor-pointer\">.*?\n\s*\);\n",
    new_item,
    content,
    flags=re.DOTALL
)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
