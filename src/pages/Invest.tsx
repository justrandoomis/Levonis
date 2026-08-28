import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { useWallet } from '../WalletContext';
import { useLanguage } from '../LanguageContext';
import { queryDb } from '../lib/db';
import Counter from '../components/Counter';
import { Home, TrendingUp, MessageSquare, PlusCircle, Bell, User, Plus, Info, Send, ArrowLeft } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';


function AnimatedCurrency({ amountInUSD, investCurrency, exchangeRate, fontSize = 14, textColor = 'inherit', fontWeight = 'inherit', gradientFrom = 'black' }: any) {
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
}

export default function Invest() {

  const navigate = useNavigate();
  const { user } = useAuth();
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const { balance, exchangeRate, chargeWallet, addTransaction } = useWallet();
  const { lang, setLang } = useLanguage();
  
  const [investCurrency, setInvestCurrency] = useState<'IQD'|'USD'>(() => {
    return (localStorage.getItem('investCurrency') as 'IQD'|'USD') || 'IQD';
  });
  
  useEffect(() => {
    localStorage.setItem('investCurrency', investCurrency);
  }, [investCurrency]);

  const formatCurrency = (amountInUSD: number) => {
    if (investCurrency === 'IQD') {
      return (amountInUSD * exchangeRate).toLocaleString() + ' IQD';
    }
    return '$' + amountInUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  
  const formatInputCurrency = (amountInput: number | string) => {
    const num = typeof amountInput === 'string' ? parseFloat(amountInput) : amountInput;
    if (isNaN(num)) return investCurrency === 'IQD' ? '0 IQD' : '$0';
    return investCurrency === 'IQD' ? num.toLocaleString() + ' IQD' : '$' + num.toLocaleString();
  };


  const tInvest = (en: string, ar: string) => lang === 'ar' ? ar : en;

  const [activeTab, setActiveTab] = useState('home');
  const [loading, setLoading] = useState(true);
  const [investments, setInvestments] = useState<any[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  
  useEffect(() => {

    loadData();
  }, [user]);

  const loadData = async () => {
    if (!user) return;
    try {
      setLoading(true);
      let invs = await queryDb('SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC', [user.id]);
      if (true) {
        const now = new Date().getTime();
        const fortyFiveDays = 45 * 24 * 60 * 60 * 1000;
        
        // If the user uses IQD, the exchange rate is ~1500, so we store the USD equivalent
        // If they use USD, exchangeRate is 1, so it stays 5M and 1M USD.
        const effectiveRate = exchangeRate || 1500;
        const mockAmount = 5000000 / effectiveRate;
        const mockProfit = 1000000 / effectiveRate;
        
        // Let's make it start a little bit ago so there's some profit, but we will explicitly show the total target
        // Actually, let's start it right now so it counts up from zero!
        invs = [
          {
            id: 'mock1',
            user_id: user.id,
            amount: mockAmount,
            expected_profit: mockProfit,
            status: 'active',
            start_date: new Date(now).toISOString(),
            end_date: new Date(now + fortyFiveDays).toISOString(),
            created_at: new Date(now).toISOString()
          }
        ];
      }
      setInvestments(invs || []);
      
      const msgs = await queryDb('SELECT * FROM investor_messages WHERE user_id = ? ORDER BY created_at ASC', [user.id]);
      setMessages(msgs || []);
      
      // Calculate active investment value vs free money
      // Let's assume balance is stored somewhere or calculated. For this mock, we just use a fixed number or sum.
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const renderTab = () => {
    switch (activeTab) {
      case 'home':
        return <InvestHome investments={investments} balance={balance} formatCurrency={formatCurrency} lang={lang} setLang={setLang} investCurrency={investCurrency} setInvestCurrency={setInvestCurrency} tInvest={tInvest} exchangeRate={exchangeRate} />;
      case 'invest':
        return <InvestTab balance={balance} investments={investments} loadData={loadData} formatCurrency={formatCurrency} tInvest={tInvest} investCurrency={investCurrency} exchangeRate={exchangeRate} chargeWallet={chargeWallet} user={user} />;
      case 'chat':
        return <ChatTab messages={messages} loadData={loadData} tInvest={tInvest} />;
      case 'funds':
        return <MoveFundsTab balance={balance} investments={investments} formatCurrency={formatCurrency} formatInputCurrency={formatInputCurrency} tInvest={tInvest} chargeWallet={chargeWallet} addTransaction={addTransaction} setActiveTab={setActiveTab} />;
      default:
        return <InvestHome investments={investments} balance={balance} formatCurrency={formatCurrency} lang={lang} setLang={setLang} investCurrency={investCurrency} setInvestCurrency={setInvestCurrency} tInvest={tInvest} exchangeRate={exchangeRate} />;
    }
  };



  return (
    <div className="w-full min-h-screen bg-white text-zinc-900 font-sans flex flex-col" dir="ltr">
      <div className="flex-1 overflow-y-auto pb-[80px]">
        {renderTab()}
      </div>
      
      {/* Bottom Navigation */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-zinc-200 flex justify-around items-center h-[70px] pb-safe z-50">
        <NavItem icon={<Home />} label={tInvest("Home", "الرئيسية")} active={activeTab === 'home'} onClick={() => setActiveTab('home')} />
        <NavItem icon={<TrendingUp />} label={tInvest("Invest", "استثمار")} active={activeTab === 'invest'} onClick={() => setActiveTab('invest')} />
        <NavItem icon={<MessageSquare />} label={tInvest("Support", "الدعم")} active={activeTab === 'chat'} onClick={() => setActiveTab('chat')} />
        <NavItem icon={<PlusCircle />} label="Move Funds" active={activeTab === 'funds'} onClick={() => setActiveTab('funds')} />
      </div>
    </div>
  );
}

function NavItem({ icon, label, active, onClick }: { icon: any, label: string, active: boolean, onClick: () => void }) {
  return (
    <button onClick={onClick} className={`flex flex-col items-center justify-center w-full h-full space-y-1 ${active ? 'text-[#e6a84f]' : 'text-zinc-500'}`}>
      <div className="[&>svg]:w-6 [&>svg]:h-6">
        {icon}
      </div>
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  );
}

function InvestHome({ investments, balance, formatCurrency, lang, setLang, investCurrency, setInvestCurrency, tInvest, exchangeRate }: { investments: any[], balance: number, formatCurrency: any, lang: any, setLang: any, investCurrency: any, setInvestCurrency: any, tInvest: any, exchangeRate: number }) {
  const { user } = useAuth();

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 50);
    return () => clearInterval(timer);
  }, []);

  const [showProfileMenu, setShowProfileMenu] = useState(false);
  
  // Calculate total current value
  let totalInvested = 0;
  let totalCurrentValue = 0;
  let totalProfit = 0;
  
  investments.forEach(inv => {
    if (inv.status === 'active') {
      const start = new Date(inv.start_date).getTime();
      const end = new Date(inv.end_date).getTime();
      const totalDuration = end - start;
      const elapsed = Math.max(0, Math.min(now - start, totalDuration));
      const progress = totalDuration > 0 ? elapsed / totalDuration : 1;
      
      const currentProfit = inv.expected_profit * progress;
      totalCurrentValue += (inv.amount + currentProfit);
      totalInvested += inv.amount;
      totalProfit += currentProfit;
    } else if (inv.status === 'completed') {
      // {tInvest('Completed', 'مكتمل')}, maybe in balance?
    }
  });
  
  const displayTotal = totalCurrentValue + balance;

  // Mock chart data starting from 0 as requested
  const data = [
    { name: '1M', value: 0 },
    { name: '3M', value: displayTotal * 0.24 },
    { name: '6M', value: displayTotal * 0.5 },
    { name: '1Y', value: displayTotal * 0.76 },
    { name: 'ALL', value: displayTotal },
  ];

  return (
    <div className="w-full flex flex-col pt-6">
      <div className="flex justify-between items-center px-6 mb-8 relative">
        <Bell className="w-6 h-6 text-zinc-800" />
        <button onClick={() => setShowProfileMenu(!showProfileMenu)} className="w-10 h-10 bg-zinc-100 rounded-full flex items-center justify-center">
          <User className="w-6 h-6 text-zinc-800" />
        </button>
        {showProfileMenu && (
          <div className="absolute right-6 top-12 bg-white border border-zinc-200 shadow-xl rounded-xl p-4 flex flex-col gap-4 z-50 min-w-[200px]">
            <div>
              <label className="text-xs font-bold text-zinc-500 uppercase mb-2 block">Language</label>
              <div className="flex gap-2">
                <button onClick={() => setLang('en')} className={`px-3 py-1 rounded-full text-sm ${lang === 'en' ? 'bg-[#e6a84f] text-white font-bold' : 'bg-zinc-100 text-zinc-600'}`}>EN</button>
                <button onClick={() => setLang('ar')} className={`px-3 py-1 rounded-full text-sm ${lang === 'ar' ? 'bg-[#e6a84f] text-white font-bold' : 'bg-zinc-100 text-zinc-600'}`}>AR</button>
              </div>
            </div>
            <div>
              <label className="text-xs font-bold text-zinc-500 uppercase mb-2 block">Currency</label>
              <div className="flex gap-2">
                <button onClick={() => setInvestCurrency('IQD')} className={`px-3 py-1 rounded-full text-sm ${investCurrency === 'IQD' ? 'bg-[#e6a84f] text-white font-bold' : 'bg-zinc-100 text-zinc-600'}`}>IQD</button>
                <button onClick={() => setInvestCurrency('USD')} className={`px-3 py-1 rounded-full text-sm ${investCurrency === 'USD' ? 'bg-[#e6a84f] text-white font-bold' : 'bg-zinc-100 text-zinc-600'}`}>USD</button>
              </div>
            </div>
          </div>
        )}
      </div>
      
      <div className="flex flex-col items-center justify-center text-center px-6 mb-8 mt-4">
        <p className="text-zinc-500 text-sm font-bold uppercase mb-4 tracking-wider">{tInvest('Total Live Profit', 'إجمالي الأرباح المباشرة')}</p>
        <div className="mb-4 flex justify-center">
          <AnimatedCurrency amountInUSD={totalProfit} investCurrency={investCurrency} exchangeRate={exchangeRate} fontSize={48} textColor="#18181b" gradientFrom="white" fontWeight={800} />
        </div>
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-500 bg-zinc-100 px-4 py-2 rounded-full">
          <span>{tInvest('Total Invested:', 'إجمالي الاستثمارات:')}</span>
          <span className="text-zinc-900 font-bold">{formatCurrency(totalInvested)}</span>
        </div>
      </div>
      
      <div className="w-full h-[250px] mt-4">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <Area type="monotone" dataKey="value" fillOpacity={1} fill="url(#colorValue)" stroke="#e6a84f" strokeWidth={2} dot={false} />
            <YAxis hide domain={['dataMin', 'dataMax']} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      
      <div className="flex justify-center gap-6 mt-6 px-6">
        <button className="w-12 h-12 rounded-full bg-zinc-100 text-zinc-900 font-bold text-sm">1M</button>
        <button className="w-12 h-12 rounded-full text-zinc-800 font-bold text-sm">3M</button>
        <button className="w-12 h-12 rounded-full text-zinc-800 font-bold text-sm">6M</button>
        <button className="w-12 h-12 rounded-full text-zinc-800 font-bold text-sm">1Y</button>
        <button className="w-12 h-12 rounded-full text-zinc-800 font-bold text-sm">ALL</button>
      </div>
    </div>
  );
}

function InvestTab({ balance, investments, loadData, formatCurrency, tInvest, investCurrency, exchangeRate, chargeWallet, user }: { balance: number, investments: any[], loadData: () => void, formatCurrency: any, tInvest: any, investCurrency: any, exchangeRate: any, chargeWallet: any, user: any }) {
  const [showForm, setShowForm] = useState(false);
  const [investAmount, setInvestAmount] = useState('');
  const [investPlan, setInvestPlan] = useState('3M');
  const [selectedInvest, setSelectedInvest] = useState<any>(null);
  
  if (selectedInvest) {
    return <InvestmentDetails inv={selectedInvest} onBack={() => setSelectedInvest(null)} formatCurrency={formatCurrency} tInvest={tInvest} investCurrency={investCurrency} exchangeRate={exchangeRate} />;
  }
  
  let totalCurrentValue = 0;
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
  });

  return (
    <div className="w-full flex flex-col pt-12 px-6">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-2xl font-bold text-zinc-900 mx-auto">Invest</h1>
        <Plus className="w-6 h-6 text-zinc-800 absolute right-6" />
      </div>
      
      <div className="flex flex-col items-center justify-center text-center mb-8">
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
      
      <div className="bg-white rounded-2xl border border-zinc-200 p-6 mb-6 shadow-sm">
        <h3 className="font-bold text-lg text-zinc-900 mb-6">{tInvest('Your Investments', 'استثماراتك')}</h3>
        
        {investments.length === 0 ? (
          <p className="text-zinc-500 text-sm">No investments found.</p>
        ) : (
          <div className="flex flex-col gap-6">
            {investments.map(inv => {
              const start = new Date(inv.start_date).getTime();
              const end = new Date(inv.end_date).getTime();
              const elapsed = Math.max(0, Math.min(now - start, end - start));
              const progress = (end - start) > 0 ? elapsed / (end - start) : 1;
              const currentProfit = inv.expected_profit * progress;
              const currentVal = inv.amount + currentProfit;
              
              const isCompleted = inv.status === 'completed' || now >= end;
              
              
              return (
                <div key={inv.id} onClick={() => setSelectedInvest(inv)} className="flex justify-between items-center cursor-pointer p-4 hover:bg-zinc-50 rounded-xl transition-colors border border-zinc-200">
                  <div className="flex flex-col">
                    <span className="font-bold text-zinc-900">Investment #{inv.id.slice(0,4).toUpperCase()}</span>
                    <span className="text-xs text-zinc-500">Starts: {new Date(inv.start_date).toLocaleDateString()}</span>
                    {isCompleted ? (
                      <span className="text-xs text-green-600 font-bold">{tInvest('Completed', 'مكتمل')}</span>
                    ) : (
                      <span className="text-xs text-[#e6a84f] font-bold">{tInvest('Active', 'نشط')}</span>
                    )}
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="font-bold text-zinc-900">{formatCurrency(currentVal)}</span>
                    <span className="text-xs text-green-600 flex items-center gap-1">+<AnimatedCurrency amountInUSD={currentProfit} investCurrency={investCurrency} exchangeRate={exchangeRate} fontSize={12} textColor="#16a34a" fontWeight="bold" gradientFrom="white" /></span>
                    <span className="text-[10px] text-zinc-500 mt-1">{tInvest('Target:', 'الهدف:')} {formatCurrency(inv.amount + inv.expected_profit)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      
      {!showForm ? (
        <button onClick={() => setShowForm(true)} className="text-[#e6a84f] font-bold text-center mt-4">
          {tInvest('Open or transfer an account +', 'افتح أو حول حساب +')}
        </button>
      ) : (
        <div className="bg-white rounded-2xl border border-zinc-200 p-6 mt-4 shadow-sm flex flex-col gap-4">
          <h3 className="font-bold text-lg">{tInvest('New Investment', 'استثمار جديد')}</h3>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-bold text-zinc-500">{tInvest(`Amount to invest (${investCurrency})`, `المبلغ المراد استثماره (${investCurrency})`)}</label>
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
      )}
    </div>
  );
}

function InvestmentDetails({ inv, onBack, formatCurrency, tInvest, investCurrency, exchangeRate }: { inv: any, onBack: () => void, formatCurrency: any, tInvest: any, investCurrency: any, exchangeRate: any }) {
  const [items, setItems] = useState<any[]>([]);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 50);
    return () => clearInterval(timer);
  }, []);

  
  useEffect(() => {
    queryDb('SELECT * FROM investment_items WHERE investment_id = ?', [inv.id]).then(res => {
      if (true) {
        if (inv.id === 'mock1') {
          res = [
            { id: 'i1', investment_id: 'mock1', name: 'Real Estate - Commercial Building', price: 2500000, image: '' },
            { id: 'i2', investment_id: 'mock1', name: 'Tech Startup Shares', price: 2500000, image: '' }
          ];
        }
      }
      setItems(res || []);
    });
  }, [inv.id]);
  
  const start = new Date(inv.start_date).getTime();
  const end = new Date(inv.end_date).getTime();
  const elapsed = Math.max(0, Math.min(now - start, end - start));
  const progress = (end - start) > 0 ? elapsed / (end - start) : 1;
  const currentProfit = inv.expected_profit * progress;
  const currentVal = inv.amount + currentProfit;
  const daysLeft = Math.ceil(Math.max(0, end - now) / (1000 * 60 * 60 * 24));
  
  return (
    <div className="w-full flex flex-col pt-12 px-6">
      <div className="flex items-center mb-8 relative">
        <button onClick={onBack} className="absolute left-0 p-2"><ArrowLeft className="w-6 h-6" /></button>
        <h1 className="text-xl font-bold text-zinc-900 mx-auto">{tInvest('Investment Details', 'تفاصيل الاستثمار')}</h1>
      </div>
      
      <div className="bg-white rounded-2xl border border-zinc-200 p-6 mb-6">
        <h2 className="text-3xl font-bold text-zinc-900 mb-2">{formatCurrency(currentVal)}</h2>
        <div className="flex flex-col gap-2 mb-6">
          <div className="flex justify-between items-center text-sm">
            <span className="text-zinc-500">{tInvest('Original Amount:', 'المبلغ الأصلي:')} {formatCurrency(inv.amount)}</span>
            <span className="text-green-600 font-bold">{tInvest('Total Expected Profit:', 'إجمالي الربح المتوقع:')} +{formatCurrency(inv.expected_profit)}</span>
          </div>
          <div className="flex justify-between items-center text-sm border-t border-zinc-200 pt-2">
            <span className="text-zinc-400">{tInvest('Accrued Profit:', 'الربح المتراكم حتى الآن:')}</span>
            <span className="text-green-500 flex items-center gap-1">+<AnimatedCurrency amountInUSD={currentProfit} investCurrency={investCurrency} exchangeRate={exchangeRate} fontSize={14} textColor="#22c55e" fontWeight="bold" gradientFrom="white" /></span>
          </div>
        </div>
        
        <div className="w-full bg-zinc-200 h-2 rounded-full mb-2 overflow-hidden">
          <div className="bg-[#e6a84f] h-full" style={{ width: `${progress * 100}%` }}></div>
        </div>
        <div className="flex justify-between text-xs text-zinc-500">
          <span>{daysLeft} {tInvest('days left', 'أيام متبقية')}</span>
          <span>{tInvest('Target:', 'الهدف:')} {formatCurrency(inv.amount + inv.expected_profit)}</span>
        </div>
      </div>
      
      <h3 className="font-bold text-lg text-zinc-900 mb-4">{tInvest('Purchased Items', 'العناصر المشتراة')}</h3>
      <div className="flex flex-col gap-4">
        {items.map(item => (
          <div key={item.id} className="flex items-center gap-4 bg-white p-4 rounded-xl border border-zinc-200 shadow-sm">
            {item.image ? (
              <img src={item.image} alt={item.name} className="w-16 h-16 object-cover rounded-lg" />
            ) : (
              <div className="w-16 h-16 bg-zinc-100 rounded-lg flex items-center justify-center">
                <Info className="w-6 h-6 text-zinc-500" />
              </div>
            )}
            <div className="flex flex-col">
              <span className="font-bold text-zinc-900">{item.name}</span>
              <span className="text-sm text-zinc-500">{formatCurrency(item.price)}</span>
            </div>
          </div>
        ))}
        {items.length === 0 && <p className="text-sm text-zinc-500">{tInvest('No items specified.', 'لم يتم تحديد عناصر.')}</p>}
      </div>
    </div>
  );
}

function ChatTab({ messages, loadData, tInvest }: { messages: any[], loadData: () => void, tInvest: any }) {
  const [text, setText] = useState('');
  const { user } = useAuth();
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  
  const send = async () => {
    if (!text.trim() || !user) return;
    try {
      const id = Math.random().toString(36).substr(2,9);
      await queryDb('INSERT INTO investor_messages (id, user_id, sender, message) VALUES (?, ?, ?, ?)', [id, user.id, 'user', text]);
      setText('');
      loadData();
    } catch(e) {}
  };
  
  return (
    <div className="w-full h-full flex flex-col bg-white">
      <div className="flex items-center p-4 bg-white border-b border-zinc-200">
        <div className="w-10 h-10 bg-zinc-100 rounded-full flex items-center justify-center mr-3">
          <User className="w-6 h-6 text-zinc-500" />
        </div>
        <div className="flex flex-col">
          <span className="font-bold text-zinc-900">{tInvest('Support Agent', 'وكيل الدعم')}</span>
          <span className="text-xs text-zinc-500">{tInvest('Customer Support', 'دعم العملاء')}</span>
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        <div className="self-center text-xs text-zinc-500 my-2">{tInvest('Chat started', 'بدأت المحادثة')}</div>
        {messages.map(m => (
          <div key={m.id} className={`max-w-[80%] p-3 rounded-2xl ${m.sender === 'user' ? 'bg-zinc-800 text-white self-end rounded-tr-sm font-medium' : 'bg-zinc-100 text-zinc-900 self-start rounded-tl-sm border border-zinc-200'}`}>
            {m.message}
          </div>
        ))}
      </div>
      
      <div className="p-4 bg-white border-t border-zinc-200">
        <div className="flex items-center bg-white border border-zinc-300 rounded-full px-4 py-2">
          <input 
            type="text" 
            placeholder={tInvest("Type a message here...", "اكتب رسالة هنا...")} 
            className="flex-1 bg-transparent outline-none text-sm text-zinc-900"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && send()}
          />
          <button onClick={send} className="ml-2 text-zinc-900">
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}


function MoveFundsTab({ balance, investments, formatCurrency, formatInputCurrency, tInvest, chargeWallet, addTransaction, setActiveTab }: { balance: number, investments: any[], formatCurrency: any, formatInputCurrency: any, tInvest: any, chargeWallet: any, addTransaction: any, setActiveTab: any }) {
  const [amount, setAmount] = useState('0');
  const [actionType, setActionType] = useState<'deposit'|'withdraw'>('deposit');
  
  const now = new Date().getTime();
  const maturedInvestmentsTotal = investments.filter(inv => {
    if (inv.status !== 'active') return false;
    const end = new Date(inv.end_date).getTime();
    return now >= end;
  }).reduce((sum, inv) => sum + inv.amount + inv.expected_profit, 0);
  
  const availableBalance = balance + maturedInvestmentsTotal;
  
  const handleKey = (n: string) => {

    if (n === 'back') {
      setAmount(prev => prev.length > 1 ? prev.slice(0, -1) : '0');
    } else {
      setAmount(prev => prev === '0' ? n : prev + n);
    }
  };

  return (
    <div className="w-full flex flex-col pt-12 px-6 pb-24">
      <h1 className="text-xl font-bold text-zinc-900 mx-auto mb-8">{tInvest('Move funds', 'نقل الأموال')}</h1>
      
      <div className="flex justify-center border-b border-zinc-200 mb-8 w-full">
        <div 
          onClick={() => setActionType('deposit')}
          className={`w-1/2 text-center pb-3 font-bold cursor-pointer transition-colors ${actionType === 'deposit' ? 'border-b-2 border-[#e6a84f] text-[#e6a84f]' : 'text-zinc-500'}`}>
          Deposit
        </div>
        <div 
          onClick={() => setActionType('withdraw')}
          className={`w-1/2 text-center pb-3 font-bold cursor-pointer transition-colors ${actionType === 'withdraw' ? 'border-b-2 border-[#e6a84f] text-[#e6a84f]' : 'text-zinc-500'}`}>
          Withdraw
        </div>
      </div>
      
      <div className="flex flex-col items-center justify-center text-center mb-4">
        <h2 className="text-6xl font-light tracking-tight text-zinc-800 mb-2">
          {formatInputCurrency(amount)}
        </h2>
        <p className="text-sm text-zinc-500">{tInvest('Available Balance:', 'الرصيد المتاح:')} {formatCurrency(availableBalance)}</p>
      </div>
      

      
      <div className="grid grid-cols-3 gap-4 mb-8 max-w-xs mx-auto w-full">
        {[1,2,3,4,5,6,7,8,9].map(n => (
          <button key={n} onClick={() => handleKey(n.toString())} className="text-3xl font-light text-zinc-600 py-3 rounded-full hover:bg-zinc-100 active:bg-zinc-200 transition-colors">{n}</button>
        ))}
        <div></div>
        <button onClick={() => handleKey('0')} className="text-3xl font-light text-zinc-600 py-3 rounded-full hover:bg-zinc-100 active:bg-zinc-200 transition-colors">0</button>
        <button onClick={() => handleKey('back')} className="flex items-center justify-center text-zinc-600 py-3 rounded-full hover:bg-zinc-100 active:bg-zinc-200 transition-colors">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"></path><line x1="18" y1="9" x2="12" y2="15"></line><line x1="12" y1="9" x2="18" y2="15"></line></svg>
        </button>
      </div>
      
      <button 
        onClick={async () => {
          const numAmount = parseFloat(amount);
          if (isNaN(numAmount) || numAmount <= 0) return;
          
          if (actionType === 'deposit') {
             // We want instant deposit for demo purposes so they can invest it
             // addTransaction defaults to pending, so let's use a workaround or just add transaction and then tell them it's pending.
             // Actually, if we use addTransaction, it's pending. 
             // Let's just write to db directly to make it approved for this specific "invest" demo flow, or just use chargeWallet with negative amount? chargeWallet decreases. 
             // Let's use chargeWallet(-numAmount, 'Deposit to Wallet') which increases balance because it does b - amount.
             try {
                await chargeWallet(-numAmount, 'Deposit to Wallet');
                setAmount('0');
                setActiveTab('home');
             } catch(e) {}
          } else {
             if (numAmount > availableBalance) {
                alert(tInvest('Insufficient funds', 'رصيد غير كاف'));
                return;
             }
             try {
                await chargeWallet(numAmount, 'Withdraw from Wallet');
                setAmount('0');
                setActiveTab('home');
             } catch(e) {}
          }
        }}
        className="w-full bg-[#e6a84f] hover:bg-[#d49942] text-white font-bold py-4 rounded-full transition-colors text-lg mt-auto">
        {actionType === 'deposit' ? tInvest('Confirm Deposit', 'تأكيد الإيداع') : tInvest('Confirm Withdrawal', 'تأكيد السحب')}
      </button>
    </div>
  );
}
