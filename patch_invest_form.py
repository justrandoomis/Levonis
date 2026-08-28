import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

old_button = """      <button className="text-[#e6a84f] font-bold text-center mt-4">
        Open or transfer an account +
      </button>"""

new_form = """      {!showForm ? (
        <button onClick={() => setShowForm(true)} className="text-[#e6a84f] font-bold text-center mt-4">
          {tInvest('Open or transfer an account +', 'افتح أو حول حساب +')}
        </button>
      ) : (
        <div className="bg-white rounded-2xl border border-zinc-200 p-6 mt-4 shadow-sm flex flex-col gap-4">
          <h3 className="font-bold text-lg">{tInvest('New Investment', 'استثمار جديد')}</h3>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-bold text-zinc-500">{tInvest('Amount to invest (USD)', 'المبلغ المراد استثماره (USD)')}</label>
            <input 
              type="number" 
              value={investAmount} 
              onChange={e => setInvestAmount(e.target.value)}
              className="bg-zinc-100 border border-zinc-200 rounded-xl px-4 py-3 outline-none"
              placeholder="e.g. 1000"
            />
            <span className="text-xs text-zinc-400">{tInvest('Available:', 'المتاح:')} {formatCurrency(balance)}</span>
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-bold text-zinc-500">{tInvest('Duration', 'المدة')}</label>
            <div className="flex gap-2">
              {['1M', '3M', '6M', '1Y'].map(plan => (
                <button 
                  key={plan}
                  onClick={() => setInvestPlan(plan)}
                  className={`flex-1 py-2 rounded-xl text-sm font-bold transition-colors ${investPlan === plan ? 'bg-[#e6a84f] text-white' : 'bg-zinc-100 text-zinc-600'}`}
                >
                  {plan}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 mt-2">
            <button 
              onClick={() => setShowForm(false)}
              className="flex-1 py-3 rounded-xl font-bold text-zinc-600 bg-zinc-100"
            >
              {tInvest('Cancel', 'إلغاء')}
            </button>
            <button 
              onClick={async () => {
                const amt = parseFloat(investAmount);
                if (isNaN(amt) || amt <= 0) return;
                
                // Usually invest amounts are in USD, exchangeRate applies to IQD
                // If the user uses IQD, balance might be in USD, but formatCurrency converts it.
                // In WalletContext, balance is in USD. So amt should be in USD.
                
                let amtUSD = amt;
                if (investCurrency === 'IQD') {
                   // if they typed IQD, convert to USD
                   amtUSD = amt / (exchangeRate || 1500);
                }

                if (amtUSD > balance) {
                  alert(tInvest('Insufficient balance', 'رصيد غير كاف'));
                  return;
                }
                
                try {
                  // Deduct from wallet
                  await chargeWallet(amtUSD, 'Investment Creation');
                  
                  // Calculate expected profit (just mock rates for demo)
                  let rate = 0.05; // 5%
                  let days = 30;
                  if (investPlan === '3M') { rate = 0.15; days = 90; }
                  if (investPlan === '6M') { rate = 0.35; days = 180; }
                  if (investPlan === '1Y') { rate = 0.80; days = 365; }
                  
                  const expectedProfit = amtUSD * rate;
                  const startDate = new Date();
                  const endDate = new Date(startDate.getTime() + days * 24 * 60 * 60 * 1000);
                  
                  const id = Math.random().toString(36).substr(2,9);
                  
                  // Import queryDb if not already accessible, wait, InvestTab is in Invest.tsx, so queryDb is in scope!
                  const { queryDb } = await import('../lib/db');
                  await queryDb('INSERT INTO investments (id, user_id, amount, expected_profit, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?)', [
                    id, user.id, amtUSD, expectedProfit, startDate.toISOString(), endDate.toISOString()
                  ]);
                  
                  setShowForm(false);
                  setInvestAmount('');
                  loadData();
                } catch(e) {
                  console.error(e);
                  alert('Error creating investment');
                }
              }}
              className="flex-1 py-3 rounded-xl font-bold text-white bg-[#e6a84f]"
            >
              {tInvest('Confirm', 'تأكيد')}
            </button>
          </div>
        </div>
      )}"""

content = content.replace(old_button, new_form)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
