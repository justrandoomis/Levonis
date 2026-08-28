import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

old_animated = """function AnimatedCurrency({ amountInUSD, investCurrency, exchangeRate, fontSize = 14, textColor = 'inherit', fontWeight = 'inherit', gradientFrom = 'black' }: any) {
  const isUSD = investCurrency === 'USD';
  const val = isUSD ? amountInUSD : (amountInUSD * exchangeRate);
  const decimals = isUSD ? 5 : 2;
  
  return (
    <span className="inline-flex items-center justify-center gap-[2px] whitespace-nowrap" style={{ direction: 'ltr' }}>
      {isUSD && <span className="mb-[2px]">$</span>}
      <Counter 
        value={val} 
        fontSize={fontSize} 
        padding={0} 
        gap={1} 
        textColor={textColor} 
        fontWeight={fontWeight} 
        gradientFrom={gradientFrom}
        decimalPlaces={decimals}
      />
      {!isUSD && <span className="mb-[2px]"> IQD</span>}
    </span>
  );
}"""

new_animated = """function AnimatedCurrency({ amountInUSD, investCurrency, exchangeRate, fontSize = 14, textColor = 'inherit', fontWeight = 'inherit', gradientFrom = 'black' }: any) {
  const isUSD = investCurrency === 'USD';
  const val = isUSD ? amountInUSD : (amountInUSD * exchangeRate);
  const decimals = isUSD ? 5 : 2;
  
  return (
    <span className="inline-flex items-center justify-center gap-[2px] whitespace-nowrap" style={{ direction: 'ltr' }}>
      {isUSD && <span className="mb-[2px]" style={{ fontSize: fontSize * 0.8, color: textColor, fontWeight }}>$</span>}
      <Counter 
        value={val} 
        fontSize={fontSize} 
        padding={0} 
        gap={fontSize > 24 ? 3 : 1} 
        textColor={textColor} 
        fontWeight={fontWeight} 
        gradientFrom={gradientFrom}
        decimalPlaces={decimals}
      />
      {!isUSD && <span className="mb-[2px]" style={{ fontSize: fontSize * 0.5, color: textColor, fontWeight }}> IQD</span>}
    </span>
  );
}"""
content = content.replace(old_animated, new_animated)

old_home = """      <div className="flex flex-col items-center justify-center text-center px-6 mb-8">
        <p className="text-zinc-500 text-sm font-medium mb-2">{tInvest(user?.name + ', you have', 'لديك يا ' + user?.name)}</p>
        <h1 className="text-5xl font-bold tracking-tight text-zinc-900 mb-2">
          {formatCurrency(displayTotal)}
        </h1>
        <p className="text-sm font-medium text-zinc-400">
          {tInvest('Accrued Profit', 'أرباح متراكمة')} <AnimatedCurrency amountInUSD={totalProfit} investCurrency={investCurrency} exchangeRate={exchangeRate} fontSize={14} textColor="#a1a1aa" gradientFrom="white" fontWeight={500} />
        </p>
      </div>"""

new_home = """      <div className="flex flex-col items-center justify-center text-center px-6 mb-8 mt-4">
        <p className="text-zinc-500 text-sm font-bold uppercase mb-4 tracking-wider">{tInvest('Total Live Profit', 'إجمالي الأرباح المباشرة')}</p>
        <div className="mb-4 flex justify-center">
          <AnimatedCurrency amountInUSD={totalProfit} investCurrency={investCurrency} exchangeRate={exchangeRate} fontSize={48} textColor="#18181b" gradientFrom="white" fontWeight={800} />
        </div>
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-500 bg-zinc-100 px-4 py-2 rounded-full">
          <span>{tInvest('Total Invested:', 'إجمالي الاستثمارات:')}</span>
          <span className="text-zinc-900 font-bold">{formatCurrency(totalInvested)}</span>
        </div>
      </div>"""
content = content.replace(old_home, new_home)


with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
