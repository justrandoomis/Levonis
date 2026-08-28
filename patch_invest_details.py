import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

old_calc = """  let totalCurrentValue = 0;
  let totalProfit = 0;
  
  const now = new Date().getTime();
  investments.forEach(inv => {
    if (inv.status === 'active') {
      const start = new Date(inv.start_date).getTime();
      const end = new Date(inv.end_date).getTime();
      const totalDuration = end - start;
      const elapsed = Math.max(0, Math.min(now - start, totalDuration));
      const progress = totalDuration > 0 ? elapsed / totalDuration : 1;
      
      const currentProfit = inv.expected_profit * progress;
      totalCurrentValue += (inv.amount + currentProfit);
      totalProfit += currentProfit;
    }
  });"""

new_calc = """  let totalCurrentValue = 0;
  let totalProfit = 0;
  let totalInvested = 0;
  
  const now = new Date().getTime();
  investments.forEach(inv => {
    if (inv.status === 'active') {
      const start = new Date(inv.start_date).getTime();
      const end = new Date(inv.end_date).getTime();
      const totalDuration = end - start;
      const elapsed = Math.max(0, Math.min(now - start, totalDuration));
      const progress = totalDuration > 0 ? elapsed / totalDuration : 1;
      
      const currentProfit = inv.expected_profit * progress;
      totalCurrentValue += (inv.amount + currentProfit);
      totalProfit += currentProfit;
      totalInvested += inv.amount;
    }
  });"""

content = content.replace(old_calc, new_calc)

old_ui = """      <div className="flex flex-col items-center justify-center text-center mb-8">
        <h2 className="text-4xl font-bold tracking-tight text-zinc-900 mb-2">
          {formatCurrency(totalCurrentValue)}
        </h2>
        <p className="text-sm font-medium text-zinc-400">
          {tInvest('Accrued Profit', 'أرباح متراكمة')} <AnimatedCurrency amountInUSD={totalProfit} investCurrency={investCurrency} exchangeRate={exchangeRate} fontSize={14} textColor="#a1a1aa" gradientFrom="white" fontWeight={500} />
        </p>
      </div>
      
      <div className="bg-white rounded-2xl border border-zinc-200 p-6 mb-6">"""

new_ui = """      <div className="flex flex-col items-center justify-center text-center mb-8">
        <h2 className="text-4xl font-bold tracking-tight text-zinc-900 mb-2">
          {formatCurrency(totalCurrentValue)}
        </h2>
        <p className="text-sm font-medium text-zinc-400">
          {tInvest('Accrued Profit', 'أرباح متراكمة')} <AnimatedCurrency amountInUSD={totalProfit} investCurrency={investCurrency} exchangeRate={exchangeRate} fontSize={14} textColor="#a1a1aa" gradientFrom="white" fontWeight={500} />
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-zinc-200 p-5 mb-6 flex justify-between items-center shadow-sm">
         <div className="flex flex-col">
           <span className="text-zinc-500 text-xs font-bold uppercase mb-1">{tInvest('Available Balance', 'المبلغ المتاح')}</span>
           <span className="font-bold text-lg text-zinc-900">{formatCurrency(balance)}</span>
         </div>
         <div className="h-10 w-[1px] bg-zinc-200 mx-4"></div>
         <div className="flex flex-col items-end">
           <span className="text-zinc-500 text-xs font-bold uppercase mb-1">{tInvest('Invested Amount', 'المبلغ المستثمر')}</span>
           <span className="font-bold text-lg text-zinc-900">{formatCurrency(totalInvested)}</span>
         </div>
      </div>
      
      <div className="bg-white rounded-2xl border border-zinc-200 p-6 mb-6 shadow-sm">"""

content = content.replace(old_ui, new_ui)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
