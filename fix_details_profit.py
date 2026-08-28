import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

old_str = "<span className=\"text-green-600\">{tInvest('Profit:', 'الربح:')} +{formatCurrency(currentProfit)}</span>"
new_str = """<span className="text-green-600 flex items-center gap-1">{tInvest('Profit:', 'الربح:')} +<AnimatedCurrency amountInUSD={currentProfit} investCurrency={investCurrency} exchangeRate={exchangeRate} fontSize={14} textColor="#16a34a" fontWeight="bold" gradientFrom="black" /></span>"""

content = content.replace(old_str, new_str)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
