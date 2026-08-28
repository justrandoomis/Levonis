import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

old_list = "<span className=\"text-xs text-green-600\">+{currentProfit.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>"
new_list = """<span className="text-xs text-green-600 flex items-center gap-1">+<AnimatedCurrency amountInUSD={currentProfit} investCurrency={investCurrency} exchangeRate={exchangeRate} fontSize={12} textColor="#16a34a" fontWeight="bold" gradientFrom="#18181b" /></span>"""

content = content.replace(old_list, new_list)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
