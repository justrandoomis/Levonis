import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# 1. InvestTab totalProfit
# Find: {tInvest('Up', 'أرباح')} {formatCurrency(totalProfit)} (wait, I already replaced the one in InvestHome, let's see if the one in InvestTab is there)
# InvestTab has:
# <p className="text-sm font-medium text-zinc-600">
#   {tInvest('Up', 'أرباح')} {formatCurrency(totalProfit)}
# </p>

tab_profit = """{tInvest('Up', 'أرباح')} {investCurrency === 'USD' ? '$' : ''}
          <Counter 
            value={investCurrency === 'USD' ? parseFloat(totalProfit.toFixed(2)) : Math.floor(totalProfit * exchangeRate)} 
            fontSize={14} 
            padding={0} 
            gap={1} 
            textColor="#52525b" 
            fontWeight={500} 
            gradientFrom="black" 
          />
          {investCurrency === 'IQD' ? ' IQD' : ''}"""

# Actually, wait, `investCurrency` and `exchangeRate` are NOT passed to InvestTab or InvestmentDetails!
# In my previous patches I only added it to InvestHome?
# Let's check `InvestTab` props.
