import React, { useEffect, useState } from 'react';
import { useLanguage } from '../LanguageContext';
import { queryDb } from '../lib/db';
import { useWallet } from '../WalletContext';
import { 
  DollarSign, 
  TrendingUp, 
  TrendingDown, 
  Users, 
  Package, 
  ShoppingCart, 
  Wallet, 
  Check, 
  X, 
  Bell, 
  MessageSquare, 
  ShieldCheck, 
  CreditCard,
  ChevronDown,
  ArrowUpRight,
  ArrowDownRight,
  Clock,
  Zap,
  Activity,
  Layers,
  BarChart3,
  Search,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';

interface OverviewStats {
  totalRevenueUSD: number;
  totalRevenueIQD: number;
  totalOrdersCount: number;
  pendingOrdersCount: number;
  completedOrdersCount: number;
  totalUsersCount: number;
  proSubscribersCount: number;
  cardSubscribersCount: number;
  totalIncomingUSD: number;
  totalOutgoingUSD: number;
  pendingWalletCount: number;
  pendingSupportCount: number;
}

export default function AdminOverview({ onNavigateTab }: { onNavigateTab?: (tab: string) => void }) {
  const { dir } = useLanguage();
  const { updateTransactionStatus } = useWallet();

  const [timeFilter, setTimeFilter] = useState<'week' | 'month' | 'year'>('month');
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<OverviewStats>({
    totalRevenueUSD: 240117,
    totalRevenueIQD: 360175500,
    totalOrdersCount: 1248,
    pendingOrdersCount: 14,
    completedOrdersCount: 1098,
    totalUsersCount: 842,
    proSubscribersCount: 215,
    cardSubscribersCount: 388,
    totalIncomingUSD: 12376,
    totalOutgoingUSD: 11544,
    pendingWalletCount: 2,
    pendingSupportCount: 3,
  });

  const [pendingWalletRequests, setPendingWalletRequests] = useState<any[]>([]);
  const [pendingCommunityRequests, setPendingCommunityRequests] = useState<any[]>([]);
  const [loadingActionId, setLoadingActionId] = useState<string | null>(null);

  // Vertical Bar Chart Pill Data
  const monthlyBarCapsules = [
    { month: 'Apr', label: 'أبريل', val: '$38,200', fillHeight: '60%' },
    { month: 'Jun', label: 'يونيو', val: '$45,100', fillHeight: '80%' },
    { month: 'Aug', label: 'أغسطس', val: '$32,400', fillHeight: '45%' },
    { month: 'Oct', label: 'أكتوبر', val: '$58,900', fillHeight: '92%' },
    { month: 'Feb', label: 'فبراير', val: '$49,000', fillHeight: '75%' },
  ];

  const fetchOverviewData = async () => {
    setLoading(true);
    try {
      // 1. Fetch Users stats
      const usersRes = await queryDb('SELECT * FROM users').catch(() => []);
      const totalUsers = usersRes.length;
      const proSubs = usersRes.filter((u: any) => u.subscription_plan === 'pro').length;
      const cardSubs = usersRes.filter((u: any) => u.card_number && u.card_number.length > 0).length;

      // 2. Fetch Wallet Transactions
      const walletRes = await queryDb("SELECT wallet_transactions.*, users.email, users.username FROM wallet_transactions LEFT JOIN users ON wallet_transactions.userId = users.id ORDER BY wallet_transactions.date DESC").catch(() => []);
      
      const pendingWallet = walletRes.filter((t: any) => t.status === 'pending');
      
      let incomingSum = 0;
      let outgoingSum = 0;
      let revenueSum = 0;
      let purchaseCount = 0;
      let completedPurchaseCount = 0;

      walletRes.forEach((t: any) => {
        if (t.status === 'approved' || t.status === 'completed') {
          if (t.type === 'deposit') incomingSum += (t.amount || 0);
          if (t.type === 'withdraw') outgoingSum += (t.amount || 0);
          if (t.type === 'purchase') {
             revenueSum += (t.amount || 0);
             completedPurchaseCount++;
          }
        }
        if (t.type === 'purchase') purchaseCount++;
      });

      // 3. Fetch Community requests
      const commReqs = await queryDb("SELECT * FROM community_requests WHERE status = 'pending' ORDER BY created_at DESC").catch(() => []);

      setPendingWalletRequests(pendingWallet.slice(0, 5));
      setPendingCommunityRequests(commReqs.slice(0, 5));

      setStats({
        totalRevenueUSD: revenueSum,
        totalRevenueIQD: revenueSum * 1500,
        totalOrdersCount: purchaseCount,
        pendingOrdersCount: walletRes.filter((t:any) => t.type === 'purchase' && t.status === 'pending').length,
        completedOrdersCount: completedPurchaseCount,
        totalUsersCount: totalUsers,
        proSubscribersCount: proSubs,
        cardSubscribersCount: cardSubs,
        totalIncomingUSD: incomingSum,
        totalOutgoingUSD: outgoingSum,
        pendingWalletCount: pendingWallet.length,
        pendingSupportCount: commReqs.length,
      });
    } catch (err) {
      console.error("Error loading admin overview:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOverviewData();
  }, []);

  const handleApproveWallet = async (id: string) => {
    if (loadingActionId) return;
    setLoadingActionId(`approve-${id}`);
    try {
      await updateTransactionStatus(id, 'approved', 'Approved via Overview');
      await fetchOverviewData();
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingActionId(null);
    }
  };

  const handleRejectWallet = async (id: string) => {
    if (loadingActionId) return;
    setLoadingActionId(`reject-${id}`);
    try {
      await updateTransactionStatus(id, 'rejected', 'Rejected via Overview');
      await fetchOverviewData();
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingActionId(null);
    }
  };

  return (
    <div className="space-y-6 text-white pb-12 font-sans" dir={dir}>
      
      {/* Top Bar matching Image Header */}
      <div className="flex flex-col lg:flex-row items-center justify-between gap-4 bg-zinc-900/90 border border-zinc-800 p-4 sm:p-5 rounded-3xl shadow-2xl backdrop-blur-xl">
        <div className="flex items-center gap-4 w-full lg:w-auto">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-[#c5a059] via-[#e6c27a] to-[#708238] flex items-center justify-center shadow-lg shadow-[#c5a059]/30 shrink-0 font-black text-xl text-white">
            L
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-white flex items-center gap-2">
              {dir === 'rtl' ? 'لوحة القيادة والإحصائيات' : 'Executive Overview Dashboard'}
              <span className="bg-[#708238]/20 text-[#708238] text-xs font-bold px-3 py-0.5 rounded-full border border-[#708238]/30 flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-[#708238] animate-pulse"></span>
                {dir === 'rtl' ? 'مباشر' : 'Live'}
              </span>
            </h1>
            <p className="text-xs text-zinc-400 font-medium">
              {dir === 'rtl' ? 'مراقبة المبيعات، المحفظة، الرسوم البيانية التفاعلية والأداء العام' : 'Real-time sales, wallet metrics, interactive charts and system analytics'}
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-3 w-full lg:w-auto justify-end">
          <div className="relative">
            <select
              value={timeFilter}
              onChange={(e) => setTimeFilter(e.target.value as any)}
              className="appearance-none bg-zinc-800/90 border border-zinc-700/80 text-white font-bold text-xs px-4 py-2.5 rounded-2xl pr-8 focus:outline-none focus:ring-2 focus:ring-[#c5a059] cursor-pointer shadow-inner"
            >
              <option value="week">{dir === 'rtl' ? 'هذا الأسبوع' : 'This Week'}</option>
              <option value="month">{dir === 'rtl' ? 'هذا الشهر' : 'This Month'}</option>
              <option value="year">{dir === 'rtl' ? 'هذه السنة' : 'This Year'}</option>
            </select>
            <ChevronDown className="w-4 h-4 text-zinc-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>

          <button
            onClick={fetchOverviewData}
            className="p-2.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-2xl text-zinc-300 hover:text-white transition-all shadow-sm active:scale-95"
            title={dir === 'rtl' ? 'تحديث البيانات' : 'Refresh Data'}
          >
            <Zap className="w-4 h-4 text-[#708238]" />
          </button>
        </div>
      </div>


      {/* MAIN DASHBOARD GRID - Exact Layout as Reference Image */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 lg:gap-6">

        {/* ================= COLUMN 1 (Left: 4 Cols): Bar Pills + Smooth Peak Wave + Radial Rings ================= */}
        <div className="xl:col-span-4 space-y-5 lg:space-y-6">

          {/* Card 1: Revenue $240,117 with Vertical Capsule Pill Bars */}
          <div className="bg-[#18181b]/80 backdrop-blur-xl border border-white/5 rounded-[2rem] p-6 shadow-[0_8px_32px_rgba(0,0,0,0.3)] relative overflow-hidden group">
            <div className="flex justify-between items-start mb-8">
              <div>
                <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400 block mb-1">
                  {dir === 'rtl' ? 'إجمالي الأرباح والمبيعات' : 'Total Revenue & Profits'}
                </span>
                <div className="text-3xl font-black text-white tracking-tight flex items-center gap-3">
                  <span className="text-zinc-500 font-light">$</span>
                  {stats.totalRevenueUSD.toLocaleString()}
                </div>
              </div>

              <div className="bg-gradient-to-r from-[#708238] to-[#8a9a49] text-white font-extrabold text-[10px] px-3.5 py-1.5 rounded-full shadow-lg shadow-[#708238]/20 flex items-center gap-1 cursor-pointer hover:scale-105 transition-transform">
                {dir === 'rtl' ? 'التفاصيل' : 'Lorem'} <ChevronDown className="w-3 h-3 ml-0.5" />
              </div>
            </div>

            {/* Vertical Pill Capsule Bars (Matching image: rounded capsules) */}
            <div className="pt-2 pb-2">
              <div className="flex items-end justify-between h-32 gap-3 sm:gap-4 px-2">
                {monthlyBarCapsules.map((item, idx) => (
                  <div key={idx} className="flex flex-col items-center gap-3 flex-1 h-full justify-end group/bar">
                    {/* Capsule Pill Container */}
                    <div className="w-full bg-[#27272a]/50 rounded-full h-full max-h-[110px] flex items-end p-1 shadow-inner ring-1 ring-white/5 relative overflow-hidden">
                      <div 
                        className="w-full bg-gradient-to-t from-[#c5a059] via-[#d4b26a] to-[#e6c27a] rounded-full transition-all duration-700 group-hover/bar:brightness-110 shadow-[0_0_10px_rgba(197,160,89,0.3)]"
                        style={{ height: item.fillHeight }}
                      ></div>
                    </div>
                    <span className="text-[10px] font-bold text-zinc-500 tracking-wider">
                      {dir === 'rtl' ? item.label : item.month}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Card 2: Smooth Peak Curve Wave Chart with 31, 49, 67 badges */}
          <div className="bg-[#18181b]/80 backdrop-blur-xl border border-white/5 rounded-[2rem] p-6 shadow-[0_8px_32px_rgba(0,0,0,0.3)] relative overflow-hidden">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400">
                {dir === 'rtl' ? 'مؤشر النمو والمستويات' : 'Peak Performance Wave'}
              </span>
              <div className="flex gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#c5a059] opacity-70"></span>
                <span className="w-1.5 h-1.5 rounded-full bg-[#708238] opacity-70"></span>
              </div>
            </div>

            {/* SVG Peak Wave Graph */}
            <div className="relative w-full h-36 pt-4">
              <svg className="w-full h-full overflow-visible" viewBox="0 0 320 100" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="wavePinkGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#c5a059" stopOpacity="0.45" />
                    <stop offset="100%" stopColor="#c5a059" stopOpacity="0.0" />
                  </linearGradient>
                  <linearGradient id="wavePurpleGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#708238" stopOpacity="0.55" />
                    <stop offset="100%" stopColor="#708238" stopOpacity="0.0" />
                  </linearGradient>
                </defs>

                {/* Grid Lines */}
                <line x1="0" y1="20" x2="320" y2="20" stroke="rgba(255,255,255,0.06)" strokeDasharray="3" />
                <line x1="0" y1="60" x2="320" y2="60" stroke="rgba(255,255,255,0.06)" strokeDasharray="3" />

                {/* Background Wave Purple */}
                <path 
                  d="M 0 80 C 30 80, 30 85, 60 85 C 120 85, 150 17, 210 17 C 260 17, 270 75, 320 75 L 320 100 L 0 100 Z" 
                  fill="url(#wavePurpleGrad)" 
                />
                <path 
                  d="M 0 80 C 30 80, 30 85, 60 85 C 120 85, 150 17, 210 17 C 260 17, 270 75, 320 75" 
                  fill="none" 
                  stroke="#708238" 
                  strokeWidth="2.5" 
                />

                {/* Primary Wave Pink */}
                <path 
                  d="M 0 85 C 40 85, 40 47, 85 47 C 105 47, 105 65, 120 65 C 140 65, 140 40, 160 40 C 200 40, 220 85, 320 85 L 320 100 L 0 100 Z" 
                  fill="url(#wavePinkGrad)" 
                />
                <path 
                  d="M 0 85 C 40 85, 40 47, 85 47 C 105 47, 105 65, 120 65 C 140 65, 140 40, 160 40 C 200 40, 220 85, 320 85" 
                  fill="none" 
                  stroke="#c5a059" 
                  strokeWidth="2.5" 
                />

                {/* Drop Lines */}
                <line x1="85" y1="47" x2="85" y2="100" stroke="rgba(255,255,255,0.08)" strokeDasharray="2" strokeWidth="1" />
                <line x1="160" y1="40" x2="160" y2="100" stroke="rgba(255,255,255,0.08)" strokeDasharray="2" strokeWidth="1" />
                <line x1="210" y1="17" x2="210" y2="100" stroke="rgba(255,255,255,0.08)" strokeDasharray="2" strokeWidth="1" />

                {/* Peak Point Badges matching image (31, 49, 67) */}
                {/* Badge 31 */}
                <g transform="translate(85, 47)">
                  <circle r="12" fill="#18181b" stroke="#c5a059" strokeWidth="2.5" />
                  <text x="0" y="3.5" textAnchor="middle" fill="#fff" fontSize="9" fontWeight="bold">31</text>
                </g>

                {/* Badge 49 */}
                <g transform="translate(160, 40)">
                  <circle r="12" fill="#18181b" stroke="#8a9a49" strokeWidth="2.5" />
                  <text x="0" y="3.5" textAnchor="middle" fill="#fff" fontSize="9" fontWeight="bold">49</text>
                </g>

                {/* Badge 67 */}
                <g transform="translate(210, 17)">
                  <circle r="14" fill="#708238" stroke="#fff" strokeWidth="2.5" filter="drop-shadow(0px 2px 4px rgba(0,0,0,0.5))" />
                  <text x="0" y="4" textAnchor="middle" fill="#fff" fontSize="9.5" fontWeight="black">67</text>
                </g>
              </svg>

              <div className="flex justify-between text-[9px] font-black tracking-widest text-zinc-600 mt-2 px-1">
                <span>20</span><span>30</span><span>40</span><span>50</span><span>60</span><span>70</span><span>80</span>
              </div>
            </div>
          </div>

          {/* Card 3: Multi-Arc Concentric Radial Rings Chart */}
          <div className="bg-[#18181b]/80 backdrop-blur-xl border border-white/5 rounded-[2rem] p-6 shadow-[0_8px_32px_rgba(0,0,0,0.3)] flex items-center justify-between gap-4">
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <span className="w-1.5 h-4 rounded-full bg-[#708238]"></span>
                <div className="text-[10px] font-bold text-zinc-400 flex flex-col">
                  <span>{dir === 'rtl' ? 'بطاقات هدايا' : 'Gift Cards'}</span>
                  <span className="text-white font-mono text-xs">34%</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-1.5 h-4 rounded-full bg-[#8a9a49]"></span>
                <div className="text-[10px] font-bold text-zinc-400 flex flex-col">
                  <span>{dir === 'rtl' ? 'اشتراكات VIP' : 'Subscriptions'}</span>
                  <span className="text-white font-mono text-xs">56%</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-1.5 h-4 rounded-full bg-[#c5a059]"></span>
                <div className="text-[10px] font-bold text-zinc-400 flex flex-col">
                  <span>{dir === 'rtl' ? 'خدمات إضافية' : 'Addons'}</span>
                  <span className="text-white font-mono text-xs">12%</span>
                </div>
              </div>
            </div>

            {/* Concentric Arc Circles */}
            <div className="relative w-[100px] h-[100px] flex items-end justify-end shrink-0">
              <svg className="w-full h-full transform -rotate-180 drop-shadow-xl">
                {/* Outer Ring 67% */}
                <circle cx="0" cy="0" r="46" stroke="rgba(255,255,255,0.03)" strokeWidth="6" fill="transparent" />
                <circle cx="0" cy="0" r="46" stroke="#708238" strokeWidth="6" strokeDasharray="289" strokeDashoffset={289 * (1 - 0.67 * 0.25)} strokeLinecap="round" fill="transparent" />

                {/* Middle Ring 56% */}
                <circle cx="0" cy="0" r="34" stroke="rgba(255,255,255,0.03)" strokeWidth="6" fill="transparent" />
                <circle cx="0" cy="0" r="34" stroke="#8a9a49" strokeWidth="6" strokeDasharray="213.6" strokeDashoffset={213.6 * (1 - 0.56 * 0.25)} strokeLinecap="round" fill="transparent" />

                {/* Inner Ring 34% */}
                <circle cx="0" cy="0" r="22" stroke="rgba(255,255,255,0.03)" strokeWidth="6" fill="transparent" />
                <circle cx="0" cy="0" r="22" stroke="#c5a059" strokeWidth="6" strokeDasharray="138.2" strokeDashoffset={138.2 * (1 - 0.34 * 0.25)} strokeLinecap="round" fill="transparent" />
              </svg>
              <div className="absolute bottom-0 right-0 translate-x-2 translate-y-2 flex flex-col items-center">
                <span className="text-sm font-black text-white bg-zinc-900 rounded-full w-10 h-10 flex items-center justify-center ring-4 ring-[#18181b]">67%</span>
                <span className="text-[7px] font-black tracking-widest text-zinc-500 uppercase mt-1 text-center w-12">Lorem<br/>Ipsum</span>
              </div>
            </div>
          </div>

        </div>

        {/* ================= COLUMN 2 (Middle: 4 Cols): In/Out Cards + Dots + Actions + Meters ================= */}
        <div className="xl:col-span-4 space-y-5 lg:space-y-6">

          {/* Top-up $12,376 & Payout $11,544 side-by-side cards */}
          <div className="grid grid-cols-2 gap-4">
            {/* Top-up Card */}
            <div className="bg-[#18181b]/80 backdrop-blur-xl border border-white/5 rounded-[2rem] p-6 shadow-[0_8px_32px_rgba(0,0,0,0.3)] flex flex-col justify-between items-center text-center">
              <div className="w-full">
                <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest block mb-1">
                  {dir === 'rtl' ? 'تعبئة المحفظة' : 'Top-ups'}
                </span>
                <div className="text-xl font-black text-white flex items-center justify-center gap-1">
                  <span className="text-zinc-500 font-light">$</span>
                  {stats.totalIncomingUSD.toLocaleString()}
                </div>
              </div>
              <div className="mt-5 w-full">
                <button className="w-full bg-gradient-to-r from-[#708238] to-[#8a9a49] hover:brightness-110 text-white font-extrabold text-[10px] py-2 rounded-full shadow-[0_4px_12px_rgba(112,130,56,0.3)] transition-all active:scale-95 tracking-widest uppercase">
                  {dir === 'rtl' ? 'الواردات' : 'Lorem'}
                </button>
              </div>
            </div>

            {/* Payout Card */}
            <div className="bg-[#18181b]/80 backdrop-blur-xl border border-white/5 rounded-[2rem] p-6 shadow-[0_8px_32px_rgba(0,0,0,0.3)] flex flex-col justify-between items-center text-center">
              <div className="w-full">
                <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest block mb-1">
                  {dir === 'rtl' ? 'السحوبات والمصروف' : 'Payouts'}
                </span>
                <div className="text-xl font-black text-white flex items-center justify-center gap-1">
                  <span className="text-zinc-500 font-light">$</span>
                  {stats.totalOutgoingUSD.toLocaleString()}
                </div>
              </div>
              <div className="mt-5 w-full">
                <button className="w-full bg-gradient-to-r from-[#c5a059] to-[#d4b26a] hover:brightness-110 text-[#18181b] font-extrabold text-[10px] py-2 rounded-full shadow-[0_4px_12px_rgba(197,160,89,0.3)] transition-all active:scale-95 tracking-widest uppercase">
                  {dir === 'rtl' ? 'المصروفات' : 'Lorem'}
                </button>
              </div>
            </div>
          </div>

          {/* Status Dots Array Row (Matching reference image dots) */}
          <div className="bg-[#18181b]/80 backdrop-blur-xl border border-white/5 rounded-[2rem] p-6 shadow-[0_8px_32px_rgba(0,0,0,0.3)] space-y-5">
            <div className="flex items-center justify-between">
              <div className="text-[9px] font-black uppercase tracking-widest text-zinc-400 flex flex-col gap-0.5">
                <span className="text-white text-[11px]">{dir === 'rtl' ? 'حالة خوادم الدفع' : 'Payment Servers'}</span>
                <span>{dir === 'rtl' ? 'نشط الآن' : 'Active Status'}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#708238] shadow-[0_0_8px_rgba(112,130,56,0.6)]"></span>
                <span className="w-2.5 h-2.5 rounded-full bg-[#708238] shadow-[0_0_8px_rgba(112,130,56,0.6)]"></span>
                <span className="w-2.5 h-2.5 rounded-full bg-[#708238] shadow-[0_0_8px_rgba(112,130,56,0.6)]"></span>
                <span className="w-2 h-2 rounded-full bg-zinc-700/50"></span>
                <span className="w-2 h-2 rounded-full bg-zinc-700/50"></span>
              </div>
            </div>

            <div className="flex items-center justify-between pt-5 border-t border-white/5">
              <div className="text-[9px] font-black uppercase tracking-widest text-zinc-400 flex flex-col gap-0.5">
                <span className="text-white text-[11px]">{dir === 'rtl' ? 'نشاط المستخدمين' : 'User Activity'}</span>
                <span>{dir === 'rtl' ? 'فوري' : 'Real-time'}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#c5a059] shadow-[0_0_8px_rgba(197,160,89,0.6)]"></span>
                <span className="w-2.5 h-2.5 rounded-full bg-[#c5a059] shadow-[0_0_8px_rgba(197,160,89,0.6)]"></span>
                <span className="w-2.5 h-2.5 rounded-full bg-[#c5a059] shadow-[0_0_8px_rgba(197,160,89,0.6)]"></span>
                <span className="w-2.5 h-2.5 rounded-full bg-[#c5a059] shadow-[0_0_8px_rgba(197,160,89,0.6)]"></span>
                <span className="w-2 h-2 rounded-full bg-zinc-700/50"></span>
              </div>
            </div>
          </div>

          {/* Quick Action Item Cards (Combined into one card with a subtle divider) */}
          <div className="bg-[#18181b]/80 backdrop-blur-xl border border-white/5 rounded-[2rem] p-5 shadow-[0_8px_32px_rgba(0,0,0,0.3)]">
            {/* Item 1 */}
            <div className="p-2 flex items-center justify-between gap-4">
              <div className="min-w-0 flex flex-col gap-1">
                <div className="font-bold text-white text-xs truncate">
                  {dir === 'rtl' ? 'طلب شحن زين كاش بقيمة $250' : 'Dolor sit amet lorem'}
                </div>
                <div className="text-[10px] font-bold text-zinc-500">{dir === 'rtl' ? 'بانتظار التأكيد' : 'Dolor sit amet'}</div>
              </div>
              <button 
                onClick={() => handleApproveWallet('1')}
                className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#8a9a49] to-[#708238] text-white flex items-center justify-center shadow-[0_4px_12px_rgba(112,130,56,0.4)] hover:scale-105 active:scale-95 shrink-0 transition-transform"
              >
                <ChevronDown className="w-5 h-5 stroke-[3]" />
              </button>
            </div>
            
            <div className="h-px w-full bg-white/5 my-2"></div>

            {/* Item 2 */}
            <div className="p-2 flex items-center justify-between gap-4">
              <div className="min-w-0 flex flex-col gap-1">
                <div className="font-bold text-white text-xs truncate">
                  {dir === 'rtl' ? 'طلب سحب رصيد بقيمة $120' : 'Dolor sit amet lorem'}
                </div>
                <div className="text-[10px] font-bold text-zinc-500">{dir === 'rtl' ? 'مراجعة أمنية' : 'Dolor sit amet'}</div>
              </div>
              <button 
                onClick={() => handleRejectWallet('2')}
                className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#d4b26a] to-[#c5a059] text-[#18181b] flex items-center justify-center shadow-[0_4px_12px_rgba(197,160,89,0.4)] hover:scale-105 active:scale-95 shrink-0 transition-transform"
              >
                <ChevronDown className="w-5 h-5 stroke-[3]" />
              </button>
            </div>
          </div>

          {/* Horizontal Progress Bar Meters (64% Purple, 83% Yellow) */}
          <div className="bg-[#18181b]/80 backdrop-blur-xl border border-white/5 rounded-[2rem] p-6 shadow-[0_8px_32px_rgba(0,0,0,0.3)] space-y-6">
            {/* Progress 1: 64% */}
            <div>
              <div className="flex justify-between text-xs font-black mb-2 uppercase tracking-widest">
                <span className="text-white">64%</span>
                <span className="text-zinc-500">{dir === 'rtl' ? 'تسليم طلبات برو' : 'Lorem ipsum sit'}</span>
              </div>
              <div className="w-full bg-[#27272a]/50 rounded-full h-3 overflow-hidden shadow-inner relative">
                <div className="bg-gradient-to-r from-[#708238] to-[#8a9a49] absolute top-0 bottom-0 left-0 rounded-full w-[64%] shadow-[0_0_10px_rgba(112,130,56,0.5)]"></div>
              </div>
            </div>

            {/* Progress 2: 83% */}
            <div>
              <div className="flex justify-between text-xs font-black mb-2 uppercase tracking-widest">
                <span className="text-white">83%</span>
                <span className="text-zinc-500">{dir === 'rtl' ? 'نسبة رضى المستخدمين' : 'Lorem ipsum sit'}</span>
              </div>
              <div className="w-full bg-[#27272a]/50 rounded-full h-3 overflow-hidden shadow-inner relative">
                <div className="bg-gradient-to-r from-[#c5a059] to-[#d4b26a] absolute top-0 bottom-0 left-0 rounded-full w-[83%] shadow-[0_0_10px_rgba(197,160,89,0.5)]"></div>
              </div>
            </div>
          </div>

        </div>

        {/* ================= COLUMN 3 (Right: 4 Cols): 3 Donut Gauges + Stacked Wave + Stacked Bar Chart ================= */}
        <div className="xl:col-span-4 space-y-5 lg:space-y-6">

          {/* 3 Radial Ring Donut Gauges */}
          <div className="bg-[#18181b]/80 backdrop-blur-xl border border-white/5 rounded-[2rem] p-6 shadow-[0_8px_32px_rgba(0,0,0,0.3)] flex justify-between items-center">
            
            {/* Donut 1: 75% */}
            <div className="flex flex-col items-center">
              <div className="relative w-16 h-16 flex items-center justify-center">
                <svg className="w-full h-full transform -rotate-90 drop-shadow-lg">
                  <circle cx="32" cy="32" r="26" stroke="rgba(255,255,255,0.03)" strokeWidth="5" fill="transparent" />
                  <circle cx="32" cy="32" r="26" stroke="#e6c27a" strokeWidth="5" strokeDasharray="163.4" strokeDashoffset={163.4 - (163.4 * 0.75)} strokeLinecap="round" fill="transparent" />
                </svg>
                <span className="absolute text-[11px] font-black text-white">75%</span>
              </div>
              <div className="text-[8px] font-black uppercase tracking-widest text-zinc-500 mt-3 text-center">
                {dir === 'rtl' ? 'الطلبات' : 'Lorem ipsum'}<br/>sit amet dolor
              </div>
            </div>

            {/* Donut 2: 71% */}
            <div className="flex flex-col items-center">
              <div className="relative w-16 h-16 flex items-center justify-center">
                <svg className="w-full h-full transform -rotate-90 drop-shadow-lg">
                  <circle cx="32" cy="32" r="26" stroke="rgba(255,255,255,0.03)" strokeWidth="5" fill="transparent" />
                  <circle cx="32" cy="32" r="26" stroke="#9fae63" strokeWidth="5" strokeDasharray="163.4" strokeDashoffset={163.4 - (163.4 * 0.71)} strokeLinecap="round" fill="transparent" />
                </svg>
                <span className="absolute text-[11px] font-black text-white">71%</span>
              </div>
              <div className="text-[8px] font-black uppercase tracking-widest text-zinc-500 mt-3 text-center">
                {dir === 'rtl' ? 'برو Pro' : 'Lorem ipsum'}<br/>sit amet dolor
              </div>
            </div>

            {/* Donut 3: 46% */}
            <div className="flex flex-col items-center">
              <div className="relative w-16 h-16 flex items-center justify-center">
                <svg className="w-full h-full transform -rotate-90 drop-shadow-lg">
                  <circle cx="32" cy="32" r="26" stroke="rgba(255,255,255,0.03)" strokeWidth="5" fill="transparent" />
                  <circle cx="32" cy="32" r="26" stroke="#c5a059" strokeWidth="5" strokeDasharray="163.4" strokeDashoffset={163.4 - (163.4 * 0.46)} strokeLinecap="round" fill="transparent" />
                </svg>
                <span className="absolute text-[11px] font-black text-white">46%</span>
              </div>
              <div className="text-[8px] font-black uppercase tracking-widest text-zinc-500 mt-3 text-center">
                {dir === 'rtl' ? 'البطاقات' : 'Lorem ipsum'}<br/>sit amet dolor
              </div>
            </div>

          </div>

          {/* Dual Wave Charts (Matching image right side area charts) */}
          <div className="bg-[#18181b]/80 backdrop-blur-xl border border-white/5 rounded-[2rem] p-6 shadow-[0_8px_32px_rgba(0,0,0,0.3)] space-y-4">
            <div className="text-[9px] font-black uppercase tracking-widest text-zinc-400 mb-2">
              {dir === 'rtl' ? 'التدفقات النقدية' : 'Lorem Ipsum Dolor Sit Amet'}
            </div>

            {/* Top Chart Box */}
            <div className="relative w-full h-[72px] bg-[#27272a]/30 rounded-2xl overflow-hidden border border-white/5 flex shadow-inner">
              {/* Y Axis */}
              <div className="w-8 flex flex-col justify-between py-1.5 text-[7px] font-black text-zinc-600 text-center border-r border-white/5">
                <span>100</span>
                <span>50</span>
                <span>0</span>
              </div>
              <div className="flex-1 relative">
                <svg className="w-full h-full overflow-visible" viewBox="0 0 300 72" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="yellowWave2" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#c5a059" stopOpacity="0.3" />
                      <stop offset="100%" stopColor="#c5a059" stopOpacity="0.0" />
                    </linearGradient>
                  </defs>
                  <line x1="0" y1="36" x2="300" y2="36" stroke="rgba(255,255,255,0.03)" strokeDasharray="2" />
                  <path 
                    d="M 0 45 C 30 45, 40 25, 80 25 C 130 25, 140 55, 190 55 C 230 55, 240 30, 280 30 C 290 30, 295 40, 300 40 L 300 72 L 0 72 Z" 
                    fill="url(#yellowWave2)" 
                  />
                  <path 
                    d="M 0 45 C 30 45, 40 25, 80 25 C 130 25, 140 55, 190 55 C 230 55, 240 30, 280 30 C 290 30, 295 40, 300 40" 
                    fill="none" 
                    stroke="#c5a059" 
                    strokeWidth="2" 
                  />
                </svg>
              </div>
            </div>

            {/* Bottom Chart Box */}
            <div className="relative w-full h-[72px] bg-[#27272a]/30 rounded-2xl overflow-hidden border border-white/5 flex shadow-inner">
              {/* Y Axis */}
              <div className="w-8 flex flex-col justify-between py-1.5 text-[7px] font-black text-zinc-600 text-center border-r border-white/5">
                <span>100</span>
                <span>50</span>
                <span>0</span>
              </div>
              <div className="flex-1 relative">
                <svg className="w-full h-full overflow-visible" viewBox="0 0 300 72" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="greenWave2" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#708238" stopOpacity="0.3" />
                      <stop offset="100%" stopColor="#708238" stopOpacity="0.0" />
                    </linearGradient>
                  </defs>
                  <line x1="0" y1="36" x2="300" y2="36" stroke="rgba(255,255,255,0.03)" strokeDasharray="2" />
                  <path 
                    d="M 0 50 C 20 50, 40 35, 80 35 C 120 35, 140 60, 180 60 C 220 60, 240 35, 280 35 C 290 35, 295 45, 300 45 L 300 72 L 0 72 Z" 
                    fill="url(#greenWave2)" 
                  />
                  <path 
                    d="M 0 50 C 20 50, 40 35, 80 35 C 120 35, 140 60, 180 60 C 220 60, 240 35, 280 35 C 290 35, 295 45, 300 45" 
                    fill="none" 
                    stroke="#708238" 
                    strokeWidth="2" 
                  />
                </svg>
              </div>
            </div>
          </div>

          {/* Vertical Stacked Column Bar Chart */}
          <div className="bg-[#18181b]/80 backdrop-blur-xl border border-white/5 rounded-[2rem] p-6 shadow-[0_8px_32px_rgba(0,0,0,0.3)] relative">
            <div className="flex h-[132px]">
              {/* Y Axis */}
              <div className="w-8 flex flex-col justify-between text-[7px] font-black text-zinc-600 py-1">
                <span>75%</span>
                <span>50%</span>
                <span>25%</span>
                <span>0%</span>
              </div>
              
              {/* Chart Area */}
              <div className="flex-1 relative border-l border-b border-white/5">
                {/* Horizontal Grid Lines */}
                <div className="absolute inset-0 flex flex-col justify-between pointer-events-none">
                  <div className="w-full border-t border-white/5 border-dashed h-0"></div>
                  <div className="w-full border-t border-white/5 border-dashed h-0"></div>
                  <div className="w-full border-t border-white/5 border-dashed h-0"></div>
                  <div className="w-full h-0"></div>
                </div>
                
                {/* Stacked Columns */}
                <div className="absolute inset-0 flex items-end justify-between gap-3 sm:gap-4 px-3 pt-2 pb-0">
                  {[
                    { top: 25, bottom: 35 },
                    { top: 35, bottom: 20 },
                    { top: 15, bottom: 35 },
                    { top: 40, bottom: 25 },
                    { top: 25, bottom: 45 },
                    { top: 50, bottom: 25 },
                    { top: 35, bottom: 45 },
                  ].map((bar, i) => (
                    <div key={i} className="flex-1 flex flex-col justify-end gap-[1.5px] h-full group cursor-pointer">
                      <div className="w-full bg-[#e6c27a]/80 rounded-t-sm group-hover:brightness-110 transition-all shadow-[0_0_8px_rgba(230,194,122,0.3)]" style={{ height: `${bar.top}%` }}></div>
                      <div className="w-full bg-[#c5a059] rounded-b-sm group-hover:brightness-110 transition-all shadow-[0_0_8px_rgba(197,160,89,0.3)]" style={{ height: `${bar.bottom}%` }}></div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

        </div>

      </div>

    </div>
  );
}
