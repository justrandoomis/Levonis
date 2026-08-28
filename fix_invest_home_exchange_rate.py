import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Replace InvestHome definition
old_sig = "function InvestHome({ investments, balance, formatCurrency, lang, setLang, investCurrency, setInvestCurrency, tInvest }: { investments: any[], balance: number, formatCurrency: any, lang: any, setLang: any, investCurrency: any, setInvestCurrency: any, tInvest: any }) {"
new_sig = "function InvestHome({ investments, balance, formatCurrency, lang, setLang, investCurrency, setInvestCurrency, tInvest, exchangeRate }: { investments: any[], balance: number, formatCurrency: any, lang: any, setLang: any, investCurrency: any, setInvestCurrency: any, tInvest: any, exchangeRate: number }) {"
content = content.replace(old_sig, new_sig)

# Replace the call to InvestHome
old_call = "<InvestHome investments={investments} balance={balance} formatCurrency={formatCurrency} lang={lang} setLang={setLang} investCurrency={investCurrency} setInvestCurrency={setInvestCurrency} tInvest={tInvest} />"
new_call = "<InvestHome investments={investments} balance={balance} formatCurrency={formatCurrency} lang={lang} setLang={setLang} investCurrency={investCurrency} setInvestCurrency={setInvestCurrency} tInvest={tInvest} exchangeRate={exchangeRate} />"
content = content.replace(old_call, new_call)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
