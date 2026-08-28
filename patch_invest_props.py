import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Pass props
content = content.replace("<InvestHome investments={investments} balance={balance} />", "<InvestHome investments={investments} balance={balance} formatCurrency={formatCurrency} lang={lang} setLang={setLang} investCurrency={investCurrency} setInvestCurrency={setInvestCurrency} />")
content = content.replace("<InvestTab investments={investments} loadData={loadData} />", "<InvestTab investments={investments} loadData={loadData} formatCurrency={formatCurrency} />")
content = content.replace("<MoveFundsTab balance={balance} investments={investments} />", "<MoveFundsTab balance={balance} investments={investments} formatCurrency={formatCurrency} formatInputCurrency={formatInputCurrency} />")

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
