import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# signature
old_sig = "function InvestHome({ investments, balance }: { investments: any[], balance: number }) {"
new_sig = "function InvestHome({ investments, balance, formatCurrency, lang, setLang, investCurrency, setInvestCurrency }: { investments: any[], balance: number, formatCurrency: any, lang: any, setLang: any, investCurrency: any, setInvestCurrency: any }) {"
content = content.replace(old_sig, new_sig)

# Profile menu state
profile_state = """  const { user } = useAuth();
  const [showProfileMenu, setShowProfileMenu] = useState(false);"""
content = content.replace("  const { user } = useAuth();", profile_state)

# Replace the top nav
old_nav = """      <div className="flex justify-between items-center px-6 mb-8">
        <Bell className="w-6 h-6 text-zinc-800" />
        <User className="w-6 h-6 text-zinc-800" />
      </div>"""
new_nav = """      <div className="flex justify-between items-center px-6 mb-8 relative">
        <Bell className="w-6 h-6 text-zinc-800" />
        <button onClick={() => setShowProfileMenu(!showProfileMenu)} className="w-10 h-10 bg-zinc-100 rounded-full flex items-center justify-center">
          <User className="w-6 h-6 text-zinc-800" />
        </button>
        {showProfileMenu && (
          <div className="absolute right-6 top-12 bg-white border border-zinc-200 shadow-xl rounded-xl p-4 flex flex-col gap-4 z-50 min-w-[200px]">
            <div>
              <label className="text-xs font-bold text-zinc-500 uppercase mb-2 block">Language</label>
              <div className="flex gap-2">
                <button onClick={() => setLang('en')} className={`px-3 py-1 rounded-full text-sm ${lang === 'en' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-800'}`}>EN</button>
                <button onClick={() => setLang('ar')} className={`px-3 py-1 rounded-full text-sm ${lang === 'ar' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-800'}`}>AR</button>
              </div>
            </div>
            <div>
              <label className="text-xs font-bold text-zinc-500 uppercase mb-2 block">Currency</label>
              <div className="flex gap-2">
                <button onClick={() => setInvestCurrency('IQD')} className={`px-3 py-1 rounded-full text-sm ${investCurrency === 'IQD' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-800'}`}>IQD</button>
                <button onClick={() => setInvestCurrency('USD')} className={`px-3 py-1 rounded-full text-sm ${investCurrency === 'USD' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-800'}`}>USD</button>
              </div>
            </div>
          </div>
        )}
      </div>"""
content = content.replace(old_nav, new_nav)

# Replace values in InvestHome
content = content.replace("${displayTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}", "{formatCurrency(displayTotal)}")
content = content.replace("Up ${totalProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}", "Up {formatCurrency(totalProfit)}")
content = content.replace("${(inv.amount + currentProfit).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}", "{formatCurrency(inv.amount + currentProfit)}")
content = content.replace("+${currentProfit.toLocaleString(undefined, { minimumFractionDigits: 2 })}", "+{formatCurrency(currentProfit)}")

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
