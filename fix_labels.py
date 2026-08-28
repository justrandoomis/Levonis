import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# In InvestmentDetails
old_details = """        <div className="flex justify-between items-center text-sm mb-6">
          <span className="text-zinc-500">{tInvest('Original Amount:', 'المبلغ الأصلي:')} {formatCurrency(inv.amount)}</span>
          <span className="text-green-600 flex items-center gap-1">{tInvest('Profit:', 'الربح:')} +<AnimatedCurrency amountInUSD={currentProfit} investCurrency={investCurrency} exchangeRate={exchangeRate} fontSize={14} textColor="#16a34a" fontWeight="bold" gradientFrom="black" /></span>
        </div>"""

new_details = """        <div className="flex flex-col gap-2 mb-6">
          <div className="flex justify-between items-center text-sm">
            <span className="text-zinc-500">{tInvest('Original Amount:', 'المبلغ الأصلي:')} {formatCurrency(inv.amount)}</span>
            <span className="text-green-600 font-bold">{tInvest('Total Expected Profit:', 'إجمالي الربح المتوقع:')} +{formatCurrency(inv.expected_profit)}</span>
          </div>
          <div className="flex justify-between items-center text-sm border-t border-zinc-800 pt-2">
            <span className="text-zinc-400">{tInvest('Accrued Profit:', 'الربح المتراكم حتى الآن:')}</span>
            <span className="text-green-500 flex items-center gap-1">+<AnimatedCurrency amountInUSD={currentProfit} investCurrency={investCurrency} exchangeRate={exchangeRate} fontSize={14} textColor="#22c55e" fontWeight="bold" gradientFrom="black" /></span>
          </div>
        </div>"""

content = content.replace(old_details, new_details)

# In InvestHome and InvestTab, change "Up/أرباح" to "Accrued Profit/أرباح متراكمة"
content = content.replace("tInvest('Up', 'أرباح')", "tInvest('Accrued Profit', 'أرباح متراكمة')")

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
