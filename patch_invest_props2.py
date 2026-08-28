import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Update InvestTab props
old_tab_sig = "function InvestTab({ investments, loadData, formatCurrency, tInvest }: { investments: any[], loadData: () => void, formatCurrency: any, tInvest: any }) {"
new_tab_sig = "function InvestTab({ investments, loadData, formatCurrency, tInvest, investCurrency, exchangeRate }: { investments: any[], loadData: () => void, formatCurrency: any, tInvest: any, investCurrency: any, exchangeRate: any }) {"
content = content.replace(old_tab_sig, new_tab_sig)

old_tab_call = "<InvestTab investments={investments} loadData={loadData} formatCurrency={formatCurrency} tInvest={tInvest} />"
new_tab_call = "<InvestTab investments={investments} loadData={loadData} formatCurrency={formatCurrency} tInvest={tInvest} investCurrency={investCurrency} exchangeRate={exchangeRate} />"
content = content.replace(old_tab_call, new_tab_call)

# Update InvestmentDetails props
old_det_sig = "function InvestmentDetails({ inv, onBack, formatCurrency, tInvest }: { inv: any, onBack: () => void, formatCurrency: any, tInvest: any }) {"
new_det_sig = "function InvestmentDetails({ inv, onBack, formatCurrency, tInvest, investCurrency, exchangeRate }: { inv: any, onBack: () => void, formatCurrency: any, tInvest: any, investCurrency: any, exchangeRate: any }) {"
content = content.replace(old_det_sig, new_det_sig)

old_det_call = "<InvestmentDetails inv={selectedInvest} onBack={() => setSelectedInvest(null)} formatCurrency={formatCurrency} tInvest={tInvest} />"
new_det_call = "<InvestmentDetails inv={selectedInvest} onBack={() => setSelectedInvest(null)} formatCurrency={formatCurrency} tInvest={tInvest} investCurrency={investCurrency} exchangeRate={exchangeRate} />"
content = content.replace(old_det_call, new_det_call)

# Replace totalProfit in InvestTab
old_tab_profit = "{tInvest('Up', 'أرباح')} {formatCurrency(totalProfit)}"
new_tab_profit = "{tInvest('Up', 'أرباح')} <AnimatedCurrency amountInUSD={totalProfit} investCurrency={investCurrency} exchangeRate={exchangeRate} fontSize={14} textColor=\"#52525b\" fontWeight={500} gradientFrom=\"black\" />"
content = content.replace(old_tab_profit, new_tab_profit)

# Replace currentProfit in InvestmentDetails
old_det_profit = "Profit: +{formatCurrency(currentProfit)}"
new_det_profit = """<span className="flex items-center gap-1">Profit: +<AnimatedCurrency amountInUSD={currentProfit} investCurrency={investCurrency} exchangeRate={exchangeRate} fontSize={14} textColor="#16a34a" fontWeight="bold" gradientFrom="black" /></span>"""
content = content.replace(old_det_profit, new_det_profit)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
