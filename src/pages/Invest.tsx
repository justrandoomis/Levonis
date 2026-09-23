import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { useWallet } from '../WalletContext';
import { useLanguage } from '../LanguageContext';
import { api, ApiError, formatIqd, formatUsdCents, usdCentsToIqd } from '../lib/api';
import { Home, TrendingUp, MessageSquare, PlusCircle, User, Info, Send, ArrowLeft, Lock, Wallet as WalletIcon } from 'lucide-react';
import { AreaChart, Area, YAxis, ResponsiveContainer } from 'recharts';

interface Investment {
  id: string;
  user_id: string;
  amount_usd_cents: number;
  expected_profit_usd_cents: number;
  start_date: string;
  end_date: string;
  status: 'active' | 'completed' | 'cancelled' | string;
  created_at: string;
}

interface InvestmentItem {
  id: string;
  name: string;
  price_usd_cents: number;
  image: string | null;
}

interface InvestorMessage {
  id: string;
  sender: 'user' | 'admin';
  message: string;
  created_at: string;
}

/** Pro-rata accrued profit for an investment at time `now` (honest daily accrual from real dates). */
function accruedProfit(inv: Investment, now: number): number {
  if (inv.status === 'cancelled') return 0;
  const start = new Date(inv.start_date).getTime();
  const end = new Date(inv.end_date).getTime();
  if (isNaN(start) || isNaN(end)) return 0;
  const total = end - start;
  const elapsed = Math.max(0, Math.min(now - start, total));
  const progress = total > 0 ? elapsed / total : 1;
  return inv.expected_profit_usd_cents * progress;
}

export default function Invest() {
  const navigate = useNavigate();
  const { user, isLoaded } = useAuth();
  const { exchangeRate } = useWallet();
  const { lang, setLang } = useLanguage();

  const [investCurrency, setInvestCurrency] = useState<'IQD' | 'USD'>(() => {
    try {
      return (localStorage.getItem('investCurrency') as 'IQD' | 'USD') || 'IQD';
    } catch {
      return 'IQD';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('investCurrency', investCurrency);
    } catch {
      /* display pref only */
    }
  }, [investCurrency]);

  /** Format USD cents in the chosen display currency. */
  const formatCurrency = useCallback(
    (cents: number) => {
      if (investCurrency === 'IQD') {
        return formatIqd(usdCentsToIqd(Math.round(cents), exchangeRate));
      }
      return formatUsdCents(Math.round(cents));
    },
    [investCurrency, exchangeRate]
  );

  const tInvest = useCallback((en: string, ar: string) => (lang === 'ar' ? ar : en), [lang]);

  const [activeTab, setActiveTab] = useState('home');
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [investments, setInvestments] = useState<Investment[]>([]);
  const [items, setItems] = useState<Record<string, InvestmentItem[]>>({});
  const [messages, setMessages] = useState<InvestorMessage[]>([]);

  const loadData = useCallback(async () => {
    try {
      const data = await api.get<{
        investments: Investment[];
        items: Record<string, InvestmentItem[]>;
        messages: InvestorMessage[];
      }>('/api/invest');
      setInvestments(data.investments || []);
      setItems(data.items || {});
      setMessages(data.messages || []);
      setAccessDenied(false);
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setAccessDenied(true);
      } else if (err instanceof ApiError && err.status === 401) {
        navigate('/auth');
      } else {
        setLoadError(
          (err instanceof ApiError && err.message) || tInvest('Failed to load your portfolio', 'تعذر تحميل محفظتك')
        );
      }
    }
  }, [navigate, tInvest]);

  useEffect(() => {
    if (!isLoaded || !user) return;
    let cancelled = false;
    setLoading(true);
    loadData().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, user, loadData]);

  // Poll the support chat every 10s while that tab is open.
  useEffect(() => {
    if (activeTab !== 'chat' || accessDenied) return;
    const interval = setInterval(() => {
      loadData();
    }, 10000);
    return () => clearInterval(interval);
  }, [activeTab, accessDenied, loadData]);

  if (loading) {
    return (
      <div className="w-full min-h-screen bg-white flex items-center justify-center" dir="ltr">
        <div className="w-6 h-6 border-2 border-[#e6a84f] border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className="w-full min-h-screen bg-white text-zinc-900 font-sans flex flex-col items-center justify-center gap-4 p-8 text-center" dir="ltr">
        <div className="w-16 h-16 rounded-full bg-zinc-100 flex items-center justify-center">
          <Lock className="w-8 h-8 text-zinc-400" />
        </div>
        <h1 className="text-xl font-bold">{tInvest('Investor Access Only', 'الوصول للمستثمرين فقط')}</h1>
        <p className="text-sm text-zinc-500 max-w-sm">
          {tInvest(
            'The investment program is invitation-only — contact support to learn more.',
            'برنامج الاستثمار بدعوة فقط — تواصل مع الدعم لمعرفة المزيد.'
          )}
        </p>
        <button
          onClick={() => navigate('/')}
          className="mt-2 bg-[#e6a84f] hover:bg-[#d49942] text-white font-bold px-8 py-3 rounded-full transition-colors"
        >
          {tInvest('Back to Home', 'العودة للرئيسية')}
        </button>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="w-full min-h-screen bg-white text-zinc-900 font-sans flex flex-col items-center justify-center gap-4 p-8 text-center" dir="ltr">
        <p className="text-sm text-zinc-500">{loadError}</p>
        <button
          onClick={() => {
            setLoading(true);
            loadData().finally(() => setLoading(false));
          }}
          className="bg-zinc-100 hover:bg-zinc-200 text-zinc-800 font-bold px-8 py-3 rounded-full transition-colors"
        >
          {tInvest('Retry', 'إعادة المحاولة')}
        </button>
      </div>
    );
  }

  const renderTab = () => {
    switch (activeTab) {
      case 'home':
        return <InvestHome investments={investments} formatCurrency={formatCurrency} lang={lang} setLang={setLang} investCurrency={investCurrency} setInvestCurrency={setInvestCurrency} tInvest={tInvest} />;
      case 'invest':
        return <InvestTab investments={investments} items={items} formatCurrency={formatCurrency} tInvest={tInvest} goToSupport={() => setActiveTab('chat')} />;
      case 'chat':
        return <ChatTab messages={messages} loadData={loadData} tInvest={tInvest} />;
      case 'funds':
        return <MoveFundsTab tInvest={tInvest} />;
      default:
        return <InvestHome investments={investments} formatCurrency={formatCurrency} lang={lang} setLang={setLang} investCurrency={investCurrency} setInvestCurrency={setInvestCurrency} tInvest={tInvest} />;
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
        <NavItem icon={<PlusCircle />} label={tInvest("Move Funds", "نقل الأموال")} active={activeTab === 'funds'} onClick={() => setActiveTab('funds')} />
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

function InvestHome({ investments, formatCurrency, lang, setLang, investCurrency, setInvestCurrency, tInvest }: {
  investments: Investment[];
  formatCurrency: (cents: number) => string;
  lang: any;
  setLang: any;
  investCurrency: 'IQD' | 'USD';
  setInvestCurrency: (c: 'IQD' | 'USD') => void;
  tInvest: (en: string, ar: string) => string;
}) {
  const [showProfileMenu, setShowProfileMenu] = useState(false);

  const now = Date.now();
  let totalInvested = 0;
  let totalProfit = 0;
  investments.forEach((inv) => {
    if (inv.status === 'cancelled') return;
    totalInvested += inv.amount_usd_cents;
    totalProfit += inv.status === 'completed' ? inv.expected_profit_usd_cents : accruedProfit(inv, now);
  });

  // Value-over-time series derived from the real investments (linear accrual
  // between each investment's real start and end dates).
  const activeInvs = investments.filter((inv) => inv.status !== 'cancelled');
  const chartData: Array<{ t: number; value: number }> = [];
  if (activeInvs.length > 0) {
    const starts = activeInvs.map((inv) => new Date(inv.start_date).getTime()).filter((n) => !isNaN(n));
    if (starts.length > 0) {
      const minStart = Math.min(...starts);
      const maxT = Math.max(now, minStart + 1);
      const steps = 24;
      for (let i = 0; i <= steps; i++) {
        const t = minStart + ((maxT - minStart) * i) / steps;
        let value = 0;
        activeInvs.forEach((inv) => {
          const start = new Date(inv.start_date).getTime();
          if (isNaN(start) || t < start) return;
          value += inv.amount_usd_cents + accruedProfit(inv, t);
        });
        chartData.push({ t, value });
      }
    }
  }

  return (
    <div className="w-full flex flex-col pt-6">
      <div className="flex justify-end items-center px-6 mb-8 relative">
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
        <p className="text-zinc-500 text-sm font-bold uppercase mb-4 tracking-wider">{tInvest('Accrued Profit to Date', 'الأرباح المتراكمة حتى الآن')}</p>
        <div className="mb-4 flex justify-center">
          <span className="text-5xl font-extrabold tracking-tight text-zinc-900" style={{ direction: 'ltr' }}>{formatCurrency(totalProfit)}</span>
        </div>
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-500 bg-zinc-100 px-4 py-2 rounded-full">
          <span>{tInvest('Total Invested:', 'إجمالي الاستثمارات:')}</span>
          <span className="text-zinc-900 font-bold">{formatCurrency(totalInvested)}</span>
        </div>
      </div>

      {investments.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
          <p className="text-sm text-zinc-500 max-w-xs">
            {tInvest(
              'No investments yet. New investments are arranged with our team — send us a message from the Support tab.',
              'لا توجد استثمارات بعد. تُرتب الاستثمارات الجديدة مع فريقنا — أرسل لنا رسالة من تبويب الدعم.'
            )}
          </p>
        </div>
      ) : chartData.length > 0 ? (
        <div className="w-full h-[250px] mt-4">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#e6a84f" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="#e6a84f" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="value" fillOpacity={1} fill="url(#colorValue)" stroke="#e6a84f" strokeWidth={2} dot={false} />
              <YAxis hide domain={['dataMin', 'dataMax']} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : null}
    </div>
  );
}

function InvestTab({ investments, items, formatCurrency, tInvest, goToSupport }: {
  investments: Investment[];
  items: Record<string, InvestmentItem[]>;
  formatCurrency: (cents: number) => string;
  tInvest: (en: string, ar: string) => string;
  goToSupport: () => void;
}) {
  const [selectedInvest, setSelectedInvest] = useState<Investment | null>(null);

  if (selectedInvest) {
    return (
      <InvestmentDetails
        inv={selectedInvest}
        items={items[selectedInvest.id] || []}
        onBack={() => setSelectedInvest(null)}
        formatCurrency={formatCurrency}
        tInvest={tInvest}
      />
    );
  }

  const now = Date.now();
  let totalCurrentValue = 0;
  let totalProfit = 0;
  let totalInvested = 0;
  investments.forEach((inv) => {
    if (inv.status === 'cancelled') return;
    const profit = inv.status === 'completed' ? inv.expected_profit_usd_cents : accruedProfit(inv, now);
    totalCurrentValue += inv.amount_usd_cents + profit;
    totalProfit += profit;
    totalInvested += inv.amount_usd_cents;
  });

  return (
    <div className="w-full flex flex-col pt-12 px-6">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-2xl font-bold text-zinc-900 mx-auto">{tInvest('Invest', 'استثمار')}</h1>
      </div>

      <div className="flex flex-col items-center justify-center text-center mb-8">
        <h2 className="text-4xl font-bold tracking-tight text-zinc-900 mb-2">
          {formatCurrency(totalCurrentValue)}
        </h2>
        <p className="text-sm font-medium text-zinc-400">
          {tInvest('Accrued Profit', 'أرباح متراكمة')} <span className="font-bold">{formatCurrency(totalProfit)}</span>
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-zinc-200 p-5 mb-6 flex justify-between items-center shadow-sm">
         <div className="flex flex-col">
           <span className="text-zinc-500 text-xs font-bold uppercase mb-1">{tInvest('Invested Amount', 'المبلغ المستثمر')}</span>
           <span className="font-bold text-lg text-zinc-900">{formatCurrency(totalInvested)}</span>
         </div>
         <div className="h-10 w-[1px] bg-zinc-200 mx-4"></div>
         <div className="flex flex-col items-end">
           <span className="text-zinc-500 text-xs font-bold uppercase mb-1">{tInvest('Expected Profit', 'الربح المتوقع')}</span>
           <span className="font-bold text-lg text-zinc-900">
             {formatCurrency(investments.filter(i => i.status !== 'cancelled').reduce((s, i) => s + i.expected_profit_usd_cents, 0))}
           </span>
         </div>
      </div>

      <div className="bg-white rounded-2xl border border-zinc-200 p-6 mb-6 shadow-sm">
        <h3 className="font-bold text-lg text-zinc-900 mb-6">{tInvest('Your Investments', 'استثماراتك')}</h3>

        {investments.length === 0 ? (
          <p className="text-zinc-500 text-sm">{tInvest('No investments yet.', 'لا توجد استثمارات بعد.')}</p>
        ) : (
          <div className="flex flex-col gap-6">
            {investments.map((inv) => {
              const profit = inv.status === 'completed' ? inv.expected_profit_usd_cents : accruedProfit(inv, now);
              const currentVal = inv.amount_usd_cents + profit;
              const end = new Date(inv.end_date).getTime();
              const isCompleted = inv.status === 'completed' || (inv.status === 'active' && !isNaN(end) && now >= end);
              const isCancelled = inv.status === 'cancelled';

              return (
                <div key={inv.id} onClick={() => setSelectedInvest(inv)} className="flex justify-between items-center cursor-pointer p-4 hover:bg-zinc-50 rounded-xl transition-colors border border-zinc-200">
                  <div className="flex flex-col">
                    <span className="font-bold text-zinc-900">{tInvest('Investment', 'استثمار')} #{inv.id.slice(-4).toUpperCase()}</span>
                    <span className="text-xs text-zinc-500">{tInvest('Starts:', 'يبدأ:')} {new Date(inv.start_date).toLocaleDateString()}</span>
                    {isCancelled ? (
                      <span className="text-xs text-red-500 font-bold">{tInvest('Cancelled', 'ملغي')}</span>
                    ) : isCompleted ? (
                      <span className="text-xs text-green-600 font-bold">{tInvest('Completed', 'مكتمل')}</span>
                    ) : (
                      <span className="text-xs text-[#e6a84f] font-bold">{tInvest('Active', 'نشط')}</span>
                    )}
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="font-bold text-zinc-900">{formatCurrency(isCancelled ? inv.amount_usd_cents : currentVal)}</span>
                    {!isCancelled && (
                      <span className="text-xs text-green-600 font-bold">+{formatCurrency(profit)}</span>
                    )}
                    <span className="text-[10px] text-zinc-500 mt-1">{tInvest('Target:', 'الهدف:')} {formatCurrency(inv.amount_usd_cents + inv.expected_profit_usd_cents)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* New investments are arranged by the team, not created from the app. */}
      <div className="bg-zinc-50 rounded-2xl border border-zinc-200 p-6 mt-2 text-center">
        <p className="text-sm text-zinc-600 mb-4">
          {tInvest(
            'New investments are arranged with our team — send us a message and we will get back to you.',
            'تُرتب الاستثمارات الجديدة مع فريقنا — أرسل لنا رسالة وسنعاود التواصل معك.'
          )}
        </p>
        <button onClick={goToSupport} className="bg-[#e6a84f] hover:bg-[#d49942] text-white font-bold px-8 py-3 rounded-full transition-colors">
          {tInvest('Message Support', 'راسل الدعم')}
        </button>
      </div>
    </div>
  );
}

function InvestmentDetails({ inv, items, onBack, formatCurrency, tInvest }: {
  inv: Investment;
  items: InvestmentItem[];
  onBack: () => void;
  formatCurrency: (cents: number) => string;
  tInvest: (en: string, ar: string) => string;
}) {
  const now = Date.now();
  const start = new Date(inv.start_date).getTime();
  const end = new Date(inv.end_date).getTime();
  const total = end - start;
  const elapsed = Math.max(0, Math.min(now - start, total));
  const progress = total > 0 ? elapsed / total : 1;
  const currentProfit = inv.status === 'completed' ? inv.expected_profit_usd_cents : accruedProfit(inv, now);
  const currentVal = inv.amount_usd_cents + currentProfit;
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
            <span className="text-zinc-500">{tInvest('Original Amount:', 'المبلغ الأصلي:')} {formatCurrency(inv.amount_usd_cents)}</span>
            <span className="text-green-600 font-bold">{tInvest('Expected Profit:', 'الربح المتوقع:')} +{formatCurrency(inv.expected_profit_usd_cents)}</span>
          </div>
          <div className="flex justify-between items-center text-sm border-t border-zinc-200 pt-2">
            <span className="text-zinc-400">{tInvest('Accrued Profit:', 'الربح المتراكم حتى الآن:')}</span>
            <span className="text-green-500 font-bold">+{formatCurrency(currentProfit)}</span>
          </div>
        </div>

        <div className="w-full bg-zinc-200 h-2 rounded-full mb-2 overflow-hidden">
          <div className="bg-[#e6a84f] h-full" style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}></div>
        </div>
        <div className="flex justify-between text-xs text-zinc-500">
          <span>{daysLeft} {tInvest('days left', 'أيام متبقية')}</span>
          <span>{tInvest('Target:', 'الهدف:')} {formatCurrency(inv.amount_usd_cents + inv.expected_profit_usd_cents)}</span>
        </div>
      </div>

      <h3 className="font-bold text-lg text-zinc-900 mb-4">{tInvest('Purchased Items', 'العناصر المشتراة')}</h3>
      <div className="flex flex-col gap-4">
        {items.map((item) => (
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
              <span className="text-sm text-zinc-500">{formatCurrency(item.price_usd_cents)}</span>
            </div>
          </div>
        ))}
        {items.length === 0 && <p className="text-sm text-zinc-500">{tInvest('No items specified.', 'لم يتم تحديد عناصر.')}</p>}
      </div>
    </div>
  );
}

function ChatTab({ messages, loadData, tInvest }: {
  messages: InvestorMessage[];
  loadData: () => Promise<void>;
  tInvest: (en: string, ar: string) => string;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await api.post('/api/invest/messages', { message });
      setText('');
      await loadData();
    } catch (err) {
      setSendError(
        (err instanceof ApiError && err.message) || tInvest('Failed to send message', 'تعذر إرسال الرسالة')
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="w-full h-full flex flex-col bg-white">
      <div className="flex items-center p-4 bg-white border-b border-zinc-200">
        <div className="w-10 h-10 bg-zinc-100 rounded-full flex items-center justify-center mr-3">
          <User className="w-6 h-6 text-zinc-500" />
        </div>
        <div className="flex flex-col">
          <span className="font-bold text-zinc-900">{tInvest('Support', 'الدعم')}</span>
          <span className="text-xs text-zinc-500">{tInvest('Investor Support', 'دعم المستثمرين')}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {messages.length === 0 && (
          <div className="self-center text-xs text-zinc-500 my-2">
            {tInvest('No messages yet — write to our team below.', 'لا توجد رسائل بعد — راسل فريقنا أدناه.')}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`max-w-[80%] p-3 rounded-2xl ${m.sender === 'user' ? 'bg-zinc-800 text-white self-end rounded-tr-sm font-medium' : 'bg-zinc-100 text-zinc-900 self-start rounded-tl-sm border border-zinc-200'}`}>
            {m.message}
          </div>
        ))}
        {sendError && <div className="self-center text-xs text-red-500">{sendError}</div>}
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
          <button onClick={send} disabled={sending || !text.trim()} className="ml-2 text-zinc-900 disabled:opacity-40">
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function MoveFundsTab({ tInvest }: { tInvest: (en: string, ar: string) => string }) {
  const navigate = useNavigate();

  return (
    <div className="w-full flex flex-col pt-12 px-6 pb-24">
      <h1 className="text-xl font-bold text-zinc-900 mx-auto mb-8">{tInvest('Move funds', 'نقل الأموال')}</h1>

      <div className="flex flex-col items-center justify-center text-center gap-4 py-12">
        <div className="w-16 h-16 rounded-full bg-zinc-100 flex items-center justify-center">
          <WalletIcon className="w-8 h-8 text-[#e6a84f]" />
        </div>
        <h2 className="text-lg font-bold text-zinc-900">{tInvest('Deposits & Withdrawals', 'الإيداع والسحب')}</h2>
        <p className="text-sm text-zinc-500 max-w-sm">
          {tInvest(
            'Deposits and withdrawals are handled through your Levonis wallet. Requests are reviewed by our team before funds move.',
            'تتم عمليات الإيداع والسحب عبر محفظة Levonis. تُراجع الطلبات من قبل فريقنا قبل تحريك الأموال.'
          )}
        </p>
        <button
          onClick={() => navigate('/wallet')}
          className="mt-2 bg-[#e6a84f] hover:bg-[#d49942] text-white font-bold px-8 py-3 rounded-full transition-colors"
        >
          {tInvest('Go to Wallet', 'الذهاب إلى المحفظة')}
        </button>
      </div>
    </div>
  );
}
