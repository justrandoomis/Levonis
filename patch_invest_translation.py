import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Add translation helper in Invest component
trans_helper = """
  const tInvest = (en: string, ar: string) => lang === 'ar' ? ar : en;
"""
content = content.replace("  const [activeTab, setActiveTab] = useState('home');", trans_helper + "\n  const [activeTab, setActiveTab] = useState('home');")

# Now update InvestHome
content = content.replace("function InvestHome({ investments, balance, formatCurrency, lang, setLang, investCurrency, setInvestCurrency }: { investments: any[], balance: number, formatCurrency: any, lang: any, setLang: any, investCurrency: any, setInvestCurrency: any }) {", "function InvestHome({ investments, balance, formatCurrency, lang, setLang, investCurrency, setInvestCurrency, tInvest }: { investments: any[], balance: number, formatCurrency: any, lang: any, setLang: any, investCurrency: any, setInvestCurrency: any, tInvest: any }) {")
content = content.replace("<InvestHome investments={investments} balance={balance} formatCurrency={formatCurrency} lang={lang} setLang={setLang} investCurrency={investCurrency} setInvestCurrency={setInvestCurrency} />", "<InvestHome investments={investments} balance={balance} formatCurrency={formatCurrency} lang={lang} setLang={setLang} investCurrency={investCurrency} setInvestCurrency={setInvestCurrency} tInvest={tInvest} />")

content = content.replace("{user?.name}, you have", "{tInvest(user?.name + ', you have', 'لديك يا ' + user?.name)}")
content = content.replace("Up {formatCurrency(totalProfit)}", "{tInvest('Up', 'أرباح')} {formatCurrency(totalProfit)}")
content = content.replace("Your Investments", "{tInvest('Your Investments', 'استثماراتك')}")
content = content.replace("Active", "{tInvest('Active', 'نشط')}")
content = content.replace("Completed", "{tInvest('Completed', 'مكتمل')}")
content = content.replace("Total Return:", "{tInvest('Total Return:', 'العائد الإجمالي:')}")

# InvestTab
content = content.replace("function InvestTab({ investments, loadData, formatCurrency }: { investments: any[], loadData: () => void, formatCurrency: any }) {", "function InvestTab({ investments, loadData, formatCurrency, tInvest }: { investments: any[], loadData: () => void, formatCurrency: any, tInvest: any }) {")
content = content.replace("<InvestTab investments={investments} loadData={loadData} formatCurrency={formatCurrency} />", "<InvestTab investments={investments} loadData={loadData} formatCurrency={formatCurrency} tInvest={tInvest} />")

content = content.replace("My Portfolio", "{tInvest('My Portfolio', 'محفظتي')}")
content = content.replace("Total Value", "{tInvest('Total Value', 'القيمة الإجمالية')}")
content = content.replace("Total Profit", "{tInvest('Total Profit', 'إجمالي الربح')}")

# InvestmentDetails
content = content.replace("function InvestmentDetails({ inv, onBack, formatCurrency }: { inv: any, onBack: () => void, formatCurrency: any }) {", "function InvestmentDetails({ inv, onBack, formatCurrency, tInvest }: { inv: any, onBack: () => void, formatCurrency: any, tInvest: any }) {")
content = content.replace("<InvestmentDetails inv={selectedInvest} onBack={() => setSelectedInvest(null)} formatCurrency={formatCurrency} />", "<InvestmentDetails inv={selectedInvest} onBack={() => setSelectedInvest(null)} formatCurrency={formatCurrency} tInvest={tInvest} />")

content = content.replace("Investment Details", "{tInvest('Investment Details', 'تفاصيل الاستثمار')}")
content = content.replace("Original Amount:", "{tInvest('Original Amount:', 'المبلغ الأصلي:')}")
content = content.replace("Profit:", "{tInvest('Profit:', 'الربح:')}")
content = content.replace("{daysLeft} days left", "{daysLeft} {tInvest('days left', 'أيام متبقية')}")
content = content.replace("Target:", "{tInvest('Target:', 'الهدف:')}")
content = content.replace("Purchased Items", "{tInvest('Purchased Items', 'العناصر المشتراة')}")
content = content.replace("No items specified.", "{tInvest('No items specified.', 'لم يتم تحديد عناصر.')}")

# ChatTab
content = content.replace("function ChatTab({ messages, loadData }: { messages: any[], loadData: () => void }) {", "function ChatTab({ messages, loadData, tInvest }: { messages: any[], loadData: () => void, tInvest: any }) {")
content = content.replace("<ChatTab messages={messages} loadData={loadData} />", "<ChatTab messages={messages} loadData={loadData} tInvest={tInvest} />")

content = content.replace("Support Agent", "{tInvest('Support Agent', 'وكيل الدعم')}")
content = content.replace("Customer Support", "{tInvest('Customer Support', 'دعم العملاء')}")
content = content.replace("Chat started", "{tInvest('Chat started', 'بدأت المحادثة')}")
content = content.replace('placeholder="Type a message here..."', 'placeholder={tInvest("Type a message here...", "اكتب رسالة هنا...")}')

# MoveFundsTab
content = content.replace("function MoveFundsTab({ balance, investments, formatCurrency, formatInputCurrency }: { balance: number, investments: any[], formatCurrency: any, formatInputCurrency: any }) {", "function MoveFundsTab({ balance, investments, formatCurrency, formatInputCurrency, tInvest }: { balance: number, investments: any[], formatCurrency: any, formatInputCurrency: any, tInvest: any }) {")
content = content.replace("<MoveFundsTab balance={balance} investments={investments} formatCurrency={formatCurrency} formatInputCurrency={formatInputCurrency} />", "<MoveFundsTab balance={balance} investments={investments} formatCurrency={formatCurrency} formatInputCurrency={formatInputCurrency} tInvest={tInvest} />")

content = content.replace("Move funds", "{tInvest('Move funds', 'نقل الأموال')}")
content = content.replace(">          Deposit", ">          {tInvest('Deposit', 'إيداع')}")
content = content.replace(">          Withdraw", ">          {tInvest('Withdraw', 'سحب')}")
content = content.replace("Available Balance:", "{tInvest('Available Balance:', 'الرصيد المتاح:')}")
content = content.replace("'Confirm Deposit' : 'Confirm Withdrawal'", "tInvest('Confirm Deposit', 'تأكيد الإيداع') : tInvest('Confirm Withdrawal', 'تأكيد السحب')")

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
