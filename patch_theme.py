import sys

def main():
    layout_content = """import React, { ReactNode } from 'react';
import { Search, Bell, Menu, User, ArrowLeft, ArrowRight } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useNavigate } from 'react-router-dom';

interface SidebarItem {
  id: string;
  icon: React.ElementType;
  label: string;
}

interface DashboardLayoutProps {
  title?: string;
  sidebarItems: SidebarItem[];
  activeTab: string;
  onTabChange: (id: string) => void;
  children: ReactNode;
}

export default function DashboardLayout({ title = "LEVO", sidebarItems, activeTab, onTabChange, children }: DashboardLayoutProps) {
  const { dir } = useLanguage();
  const navigate = useNavigate();
  
  return (
    <div className="flex h-screen w-full bg-[#18181b] overflow-hidden font-sans" dir={dir}>
      {/* Sidebar */}
      <div className="hidden lg:flex flex-col w-[260px] bg-[#09090b] text-zinc-300 shrink-0 shadow-[4px_0_24px_rgba(0,0,0,0.3)] z-20 border-r border-zinc-800">
        <div className="p-8 flex items-center gap-4">
          <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-[#708238] to-[#9fae63] flex items-center justify-center font-bold text-lg text-white shadow-lg">
            L
          </div>
          <span className="font-bold text-sm tracking-widest uppercase border border-zinc-700 px-3 py-1 rounded-lg text-white">{title}</span>
        </div>
        
        <div className="px-8 py-2 text-[10px] font-bold text-zinc-500 tracking-widest uppercase mb-2">
          {dir === 'rtl' ? 'القائمة الرئيسية' : 'MAIN MENU'}
        </div>
        
        <nav className="flex-1 px-4 space-y-2">
          {sidebarItems.map(item => (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={`w-full flex items-center gap-4 px-6 py-4 rounded-xl transition-all duration-300 font-medium ${
                activeTab === item.id 
                  ? 'bg-[#708238] text-white shadow-[0_4px_15px_rgba(112,130,56,0.3)]' 
                  : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-white'
              } ${dir === 'rtl' ? 'flex-row-reverse' : ''}`}
            >
              <item.icon className="w-5 h-5 shrink-0" />
              <span className={`text-[13px] ${dir === 'rtl' ? 'text-right' : 'text-left'}`}>{item.label}</span>
            </button>
          ))}
        </nav>
        
        <div className="p-6 mt-auto">
           <div onClick={() => navigate('/community')} className="cursor-pointer w-full aspect-square rounded-[24px] bg-gradient-to-br from-zinc-800 to-zinc-900 border border-zinc-700 shadow-lg flex flex-col items-center justify-center p-6 relative overflow-hidden group hover:border-[#D4AF37] transition-all">
             <User className="w-12 h-12 text-[#D4AF37] mb-3 group-hover:scale-110 transition-transform" />
             <div className="text-[11px] font-bold text-white text-center">{dir === 'rtl' ? 'عرض صفحتي في ليفو' : 'View My Levo Page'}</div>
           </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-full overflow-hidden relative bg-[#18181b]">
        {/* Topbar */}
        <div className="h-[90px] flex items-center justify-between px-10 shrink-0 z-10 w-full bg-[#18181b]/90 backdrop-blur-md border-b border-zinc-800/50">
           <div className="lg:hidden">
              <button className="p-2 bg-zinc-800 rounded-lg shadow-sm text-zinc-300">
                <Menu className="w-5 h-5" />
              </button>
           </div>
           
           <div className="hidden lg:flex gap-14 text-[13px] font-semibold text-zinc-400 pl-4">
             <button onClick={() => navigate('/')} className="cursor-pointer hover:text-white transition-colors flex items-center gap-2">
               {dir === 'rtl' ? <ArrowRight className="w-4 h-4"/> : <ArrowLeft className="w-4 h-4"/>}
               {dir === 'rtl' ? 'العودة للرئيسية' : 'Back to Home'}
             </button>
             <span className="cursor-pointer hover:text-white transition-colors">Lorem ipsum</span>
             <div className="relative">
               <span className="cursor-pointer text-white font-bold">Ipsum dolor</span>
               <div className="absolute -bottom-[33px] left-0 right-0 h-0.5 bg-[#D4AF37]"></div>
             </div>
           </div>
           
           <div className="flex items-center gap-6 ml-auto text-zinc-400">
             <button className="hover:text-[#D4AF37] transition-colors">
               <Search className="w-5 h-5 stroke-[2]" />
             </button>
             <button className="hover:text-[#D4AF37] transition-colors relative">
               <Bell className="w-5 h-5 stroke-[2]" />
               <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-[#708238] border-2 border-[#18181b] rounded-full text-[8px] font-bold text-white flex items-center justify-center">3</span>
             </button>
             <div className="w-9 h-9 rounded-full bg-zinc-800 flex items-center justify-center cursor-pointer overflow-hidden ml-2 shadow-sm border border-zinc-600">
               <User className="w-5 h-5 text-zinc-400" />
             </div>
             <button className="text-zinc-500 hover:text-zinc-300 transition-colors ml-2 lg:hidden">
               <Menu className="w-6 h-6 stroke-[2]" />
             </button>
           </div>
        </div>
        
        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-6 md:px-10 py-8 custom-scrollbar relative z-0">
          {children}
        </div>
      </div>
    </div>
  );
}
"""

    merchant_content = """import React, { useState } from 'react';
import { useLanguage } from '../LanguageContext';
import DashboardLayout from './DashboardLayout';
import { Home, ShoppingBag, ListOrdered, Settings, User, ChevronDown, Save } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function MerchantDashboard() {
  const { dir } = useLanguage();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('overview');

  const sidebarItems = [
    { id: 'overview', icon: Home, label: dir === 'rtl' ? 'نظرة عامة' : 'Overview' },
    { id: 'store_page', icon: User, label: dir === 'rtl' ? 'صفحة المتجر' : 'Store Page' },
    { id: 'products', icon: ShoppingBag, label: dir === 'rtl' ? 'المنتجات' : 'Products' },
    { id: 'orders', icon: ListOrdered, label: dir === 'rtl' ? 'الطلبات' : 'Orders' },
    { id: 'settings', icon: Settings, label: dir === 'rtl' ? 'الإعدادات' : 'Settings' },
  ];

  const SoftCard = ({ children, className = "" }: { children: React.ReactNode, className?: string }) => (
    <div className={`bg-zinc-900/90 rounded-[24px] shadow-[0_10px_30px_rgba(0,0,0,0.2)] border border-zinc-800/50 p-6 ${className}`}>
      {children}
    </div>
  );

  return (
    <DashboardLayout 
      sidebarItems={sidebarItems} 
      activeTab={activeTab} 
      onTabChange={setActiveTab}
    >
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 w-full pb-6 max-w-[1400px] mx-auto">
          {/* Left Column (Spans 4) */}
          <div className="lg:col-span-4 flex flex-col gap-6">
            
            {/* Main Bar Chart Card */}
            <SoftCard className="flex flex-col h-[280px]">
              <div className="flex justify-between items-start mb-6">
                 <div>
                   <div className="text-zinc-400 text-[11px] font-semibold mb-1">{dir === 'rtl' ? 'إجمالي المبيعات' : 'Total Sales'}</div>
                   <div className="text-2xl font-black text-white">$ 240,117</div>
                 </div>
                 <button className="flex items-center gap-1 bg-[#708238] text-white px-3 py-1.5 rounded-full text-[10px] font-bold shadow-[0_4px_12px_rgba(112,130,56,0.3)]">
                   {dir === 'rtl' ? 'هذا الشهر' : 'This Month'} <ChevronDown className="w-3 h-3" />
                 </button>
              </div>
              
              <div className="flex-1 flex items-end justify-between px-2 gap-4 h-full pt-4">
                {[
                  { label: 'Apr', h1: '40%' },
                  { label: 'May', h1: '60%' },
                  { label: 'Jun', h1: '80%' },
                  { label: 'Jul', h1: '100%' },
                  { label: 'Aug', h1: '70%' }
                ].map((bar, i) => (
                  <div key={i} className="flex flex-col items-center gap-3 flex-1 h-full justify-end">
                    <div className="w-3.5 bg-zinc-800 rounded-t-full relative h-full flex items-end">
                      <div className="w-full bg-gradient-to-t from-[#708238] to-[#9fae63] rounded-t-full shadow-[0_0_10px_rgba(112,130,56,0.3)] transition-all duration-700 ease-out" style={{ height: bar.h1 }}></div>
                    </div>
                    <span className="text-[10px] font-bold text-zinc-500">{bar.label}</span>
                  </div>
                ))}
              </div>
            </SoftCard>

            {/* Area Chart Card */}
            <SoftCard className="h-[200px] flex flex-col justify-end relative overflow-hidden p-0">
               <div className="absolute inset-0 pointer-events-none z-0 bg-zinc-900/50"></div>
               
               <svg viewBox="0 0 400 150" className="w-full h-full preserve-3d" preserveAspectRatio="none">
                  <path d="M0,150 L0,90 C40,50 80,120 120,80 C160,40 200,100 240,70 C280,40 320,20 360,60 C390,90 400,120 400,120 L400,150 Z" fill="url(#gradGold)" opacity="0.4" />
                  <path d="M0,150 L0,130 C40,120 80,150 120,110 C160,70 200,140 240,130 C280,120 320,90 360,110 C390,125 400,140 400,140 L400,150 Z" fill="url(#gradOlive)" opacity="0.8" />
                  
                  <defs>
                    <linearGradient id="gradGold" x1="0%" y1="0%" x2="0%" y2="100%">
                      <stop offset="0%" stopColor="#D4AF37" stopOpacity="0.5" />
                      <stop offset="100%" stopColor="#D4AF37" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="gradOlive" x1="0%" y1="0%" x2="0%" y2="100%">
                      <stop offset="0%" stopColor="#708238" stopOpacity="0.8" />
                      <stop offset="100%" stopColor="#708238" stopOpacity="0" />
                    </linearGradient>
                  </defs>
               </svg>
               
               {/* Data points */}
               <div className="absolute top-[40%] left-[25%] w-7 h-7 bg-zinc-800 border border-zinc-700 rounded-full shadow-lg flex items-center justify-center text-[8px] font-bold text-white z-10">31</div>
               <div className="absolute top-[60%] left-[45%] w-6 h-6 bg-zinc-800 border border-zinc-700 rounded-full shadow-lg flex items-center justify-center text-[7px] font-bold text-white z-10">49</div>
               <div className="absolute top-[20%] left-[75%] w-7 h-7 bg-zinc-800 border border-zinc-700 rounded-full shadow-lg flex items-center justify-center text-[8px] font-bold text-white z-10">67</div>
            </SoftCard>

            {/* Bottom Left Stats */}
            <SoftCard className="flex flex-row justify-between items-center py-6 px-6 h-[140px]">
               <div className="flex flex-col gap-3">
                 <div className="flex items-center gap-2">
                   <div className="w-1.5 h-1.5 rounded-full bg-[#708238]"></div>
                   <span className="text-[10px] text-zinc-400 font-semibold w-16">Ipsum dolor</span>
                   <span className="text-[10px] text-white font-bold">32%</span>
                 </div>
                 <div className="flex items-center gap-2">
                   <div className="w-1.5 h-1.5 rounded-full bg-[#D4AF37]"></div>
                   <span className="text-[10px] text-zinc-400 font-semibold w-16">Dolor sit</span>
                   <span className="text-[10px] text-white font-bold">56%</span>
                 </div>
                 <div className="flex items-center gap-2">
                   <div className="w-1.5 h-1.5 rounded-full bg-zinc-500"></div>
                   <span className="text-[10px] text-zinc-400 font-semibold w-16">Amet lorem</span>
                   <span className="text-[10px] text-white font-bold">12%</span>
                 </div>
               </div>
               
               <div className="flex items-center">
                  <div className="relative w-20 h-20">
                     <svg viewBox="0 0 36 36" className="w-full h-full transform -rotate-90">
                       <path className="text-zinc-800" strokeWidth="3" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                       <path className="text-[#708238]" strokeDasharray="67, 100" strokeWidth="3" strokeLinecap="round" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                       <path className="text-[#D4AF37]" strokeDasharray="30, 100" strokeDashoffset="-67" strokeWidth="3" strokeLinecap="round" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                     </svg>
                     <div className="absolute inset-0 flex flex-col items-center justify-center">
                       <span className="text-[13px] font-black text-white leading-none mb-0.5">67%</span>
                       <span className="text-[5px] font-bold text-zinc-500 tracking-widest">LOREM IPSUM</span>
                     </div>
                  </div>
               </div>
            </SoftCard>
          </div>

          {/* Middle Column (Spans 4) */}
          <div className="lg:col-span-4 flex flex-col gap-6">
             {/* Top Stats Cards */}
             <div className="grid grid-cols-2 gap-4 h-[120px]">
                <SoftCard className="p-5 flex flex-col justify-center items-start gap-1">
                  <span className="text-[10px] font-bold text-zinc-400 uppercase">{dir === 'rtl' ? 'الطلبات الجديدة' : 'New Orders'}</span>
                  <span className="text-lg font-black text-white mb-2">1,234</span>
                  <button className="bg-[#708238] text-white text-[10px] font-bold py-1.5 px-4 rounded-lg shadow-[0_4px_10px_rgba(112,130,56,0.3)]">{dir === 'rtl' ? 'عرض' : 'View'}</button>
                </SoftCard>
                <SoftCard className="p-5 flex flex-col justify-center items-start gap-1">
                  <span className="text-[10px] font-bold text-zinc-400 uppercase">{dir === 'rtl' ? 'الزيارات' : 'Visitors'}</span>
                  <span className="text-lg font-black text-white mb-2">11,544</span>
                  <button className="bg-[#D4AF37] text-white text-[10px] font-bold py-1.5 px-4 rounded-lg shadow-[0_4px_10px_rgba(212,175,55,0.3)]">{dir === 'rtl' ? 'تفاصيل' : 'Details'}</button>
                </SoftCard>
             </div>
             
             {/* Dots Rows */}
             <div className="py-2 flex flex-col gap-4 pl-2">
                <div className="flex items-center gap-4">
                   <span className="text-[10px] font-bold text-zinc-400 w-12">LOREM</span>
                   <div className="flex gap-2">
                     {[1,2,3,4].map(i => <div key={i} className="w-3 h-3 rounded-full bg-[#708238]"></div>)}
                     {[5,6].map(i => <div key={i} className="w-3 h-3 rounded-full bg-zinc-800 border border-zinc-700"></div>)}
                   </div>
                </div>
                <div className="flex items-center gap-4">
                   <span className="text-[10px] font-bold text-zinc-400 w-12">LOREM</span>
                   <div className="flex gap-2">
                     <div className="w-3 h-3 rounded-full bg-[#708238]"></div>
                     {[1,2,3,4].map(i => <div key={i} className="w-3 h-3 rounded-full bg-[#D4AF37]"></div>)}
                     <div className="w-3 h-3 rounded-full bg-zinc-800 border border-zinc-700"></div>
                   </div>
                </div>
                <div className="flex items-center gap-4 mt-1">
                   <span className="text-[10px] font-semibold text-zinc-500 w-12">Lorem ipsum</span>
                </div>
             </div>

             {/* List Items */}
             <div className="flex flex-col gap-4 mt-2">
                <SoftCard className="p-4 flex items-center justify-between border border-zinc-800 bg-zinc-800/30">
                   <div>
                     <div className="text-[12px] font-bold text-white">{dir === 'rtl' ? 'طلب جديد #402' : 'New Order #402'}</div>
                     <div className="text-[10px] text-zinc-500 mt-1">{dir === 'rtl' ? 'منذ 5 دقائق' : '5 mins ago'}</div>
                   </div>
                   <div className="w-8 h-8 rounded-lg bg-[#708238] text-white flex items-center justify-center shadow-[0_4px_10px_rgba(112,130,56,0.3)]">
                     <ChevronDown className="w-4 h-4" />
                   </div>
                </SoftCard>
                <SoftCard className="p-4 flex items-center justify-between border border-zinc-800 bg-zinc-800/30">
                   <div>
                     <div className="text-[12px] font-bold text-white">{dir === 'rtl' ? 'طلب جديد #401' : 'New Order #401'}</div>
                     <div className="text-[10px] text-zinc-500 mt-1">{dir === 'rtl' ? 'منذ 12 دقيقة' : '12 mins ago'}</div>
                   </div>
                   <div className="w-8 h-8 rounded-lg bg-[#D4AF37] text-white flex items-center justify-center shadow-[0_4px_10px_rgba(212,175,55,0.3)]">
                     <ChevronDown className="w-4 h-4" />
                   </div>
                </SoftCard>
             </div>
             
             {/* Progress Bars */}
             <div className="flex flex-col gap-6 mt-4">
                <div>
                   <div className="flex justify-between items-end mb-2">
                     <span className="text-[14px] font-black text-white">64%</span>
                     <span className="text-[9px] font-bold text-zinc-500 tracking-widest uppercase">{dir === 'rtl' ? 'الهدف الشهري' : 'Monthly Goal'}</span>
                   </div>
                   <div className="w-full bg-zinc-800 rounded-full h-2">
                     <div className="bg-[#708238] h-2 rounded-full shadow-[0_0_8px_rgba(112,130,56,0.4)]" style={{ width: '64%' }}></div>
                   </div>
                </div>
                <div>
                   <div className="flex justify-between items-end mb-2">
                     <span className="text-[14px] font-black text-white">83%</span>
                     <span className="text-[9px] font-bold text-zinc-500 tracking-widest uppercase">{dir === 'rtl' ? 'التقييم الإيجابي' : 'Positive Rating'}</span>
                   </div>
                   <div className="w-full bg-zinc-800 rounded-full h-2">
                     <div className="bg-[#D4AF37] h-2 rounded-full shadow-[0_0_8px_rgba(212,175,55,0.4)]" style={{ width: '83%' }}></div>
                   </div>
                </div>
             </div>
          </div>

          {/* Right Column (Spans 4) */}
          <div className="lg:col-span-4 flex flex-col gap-6">
             {/* Circular Progress Row */}
             <div className="flex justify-between items-center px-4 py-2 h-[120px]">
                <div className="flex flex-col items-center gap-3">
                  <div className="relative w-[56px] h-[56px]">
                     <svg viewBox="0 0 36 36" className="w-full h-full transform -rotate-90">
                       <path className="text-zinc-800" strokeWidth="3" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                       <path className="text-[#D4AF37]" strokeDasharray="75, 100" strokeWidth="3" strokeLinecap="round" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                     </svg>
                     <div className="absolute inset-0 flex items-center justify-center text-[12px] font-black text-white">75%</div>
                  </div>
                  <div className="text-center text-[7px] font-semibold text-zinc-500 leading-[1.3]">{dir === 'rtl' ? 'معدل' : 'Completion'}<br/>{dir === 'rtl' ? 'الإنجاز' : 'Rate'}</div>
                </div>

                <div className="flex flex-col items-center gap-3">
                  <div className="relative w-[56px] h-[56px]">
                     <svg viewBox="0 0 36 36" className="w-full h-full transform -rotate-90">
                       <path className="text-zinc-800" strokeWidth="3" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                       <path className="text-[#708238]" strokeDasharray="71, 100" strokeWidth="3" strokeLinecap="round" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                     </svg>
                     <div className="absolute inset-0 flex items-center justify-center text-[12px] font-black text-white">71%</div>
                  </div>
                  <div className="text-center text-[7px] font-semibold text-zinc-500 leading-[1.3]">{dir === 'rtl' ? 'الاحتفاظ' : 'Retention'}<br/>{dir === 'rtl' ? 'بالعملاء' : 'Rate'}</div>
                </div>
             </div>

             {/* Double Line Chart */}
             <SoftCard className="p-5 relative h-[220px] flex flex-col justify-end">
               <div className="text-[9px] font-bold text-white tracking-widest uppercase mb-auto z-20">{dir === 'rtl' ? 'إحصائيات الأداء' : 'PERFORMANCE STATS'}</div>
               
               <div className="absolute inset-x-5 top-14 bottom-6 flex flex-col justify-between z-0">
                  {[100, 50, 0].map(val => (
                    <div key={val} className="flex items-center gap-2 w-full">
                      <span className="text-[8px] font-bold text-zinc-600 w-4 text-right">{val}</span>
                      <div className="flex-1 border-b border-dashed border-zinc-800 h-px"></div>
                    </div>
                  ))}
               </div>
               
               <div className="absolute inset-x-10 top-14 bottom-6 z-10">
                  <svg viewBox="0 0 300 100" className="w-full h-full preserve-3d" preserveAspectRatio="none">
                    <path d="M0,40 Q40,10 80,40 T160,30 T240,10 T300,30 L300,60 L0,60 Z" fill="url(#gradGold2)" opacity="0.4" />
                    <path d="M0,40 Q40,10 80,40 T160,30 T240,10 T300,30" fill="none" stroke="#D4AF37" strokeWidth="2.5" />
                    
                    <path d="M0,80 Q30,60 70,80 T150,90 T220,70 T300,80 L300,100 L0,100 Z" fill="url(#gradOlive2)" opacity="0.4" />
                    <path d="M0,80 Q30,60 70,80 T150,90 T220,70 T300,80" fill="none" stroke="#708238" strokeWidth="2.5" />

                    <defs>
                      <linearGradient id="gradGold2" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" stopColor="#D4AF37" stopOpacity="0.5" />
                        <stop offset="100%" stopColor="#D4AF37" stopOpacity="0" />
                      </linearGradient>
                      <linearGradient id="gradOlive2" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" stopColor="#708238" stopOpacity="0.5" />
                        <stop offset="100%" stopColor="#708238" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                  </svg>
               </div>
             </SoftCard>

             {/* Bottom Bar Chart */}
             <div className="flex-1 flex flex-col pt-4 min-h-[140px]">
                <div className="relative h-full w-full flex items-end">
                   <div className="absolute inset-0 flex flex-col justify-between">
                      {[75, 50, 25, 0].map(val => (
                        <div key={val} className="flex items-center gap-2 w-full">
                          <span className="text-[8px] font-bold text-zinc-600 w-5 text-right">{val}%</span>
                          <div className="flex-1 border-b border-dashed border-zinc-800 h-px"></div>
                        </div>
                      ))}
                   </div>
                   
                   <div className="relative z-10 w-full h-[85%] flex items-end justify-around pl-8 pr-2 pb-1">
                      {[
                        { h: '60%', c: '#708238' },
                        { h: '40%', c: '#708238' },
                        { h: '85%', c: '#708238' },
                        { h: '30%', c: '#708238' },
                        { h: '50%', c: '#708238' },
                        { h: '100%', c: '#708238' },
                        { h: '70%', c: '#708238' }
                      ].map((bar, i) => (
                        <div key={i} className="w-4 relative h-full flex items-end justify-center">
                           <div className="w-full rounded-t-sm shadow-[0_0_8px_rgba(112,130,56,0.3)] transition-all duration-700 ease-out" 
                                style={{ height: bar.h, backgroundColor: bar.c, opacity: i % 2 === 0 ? 1 : 0.6 }}></div>
                        </div>
                      ))}
                   </div>
                </div>
             </div>
          </div>

        </div>
      )}

      {/* STORE PAGE CONTROL TAB */}
      {activeTab === 'store_page' && (
        <div className="mt-6 max-w-3xl">
          <h2 className="text-2xl font-bold text-white mb-6">{dir === 'rtl' ? 'التحكم بصفحة المتجر في ليفو' : 'Control Levo Store Page'}</h2>
          
          <div className="space-y-6">
            <SoftCard>
              <h3 className="text-lg font-bold text-white mb-4">{dir === 'rtl' ? 'المعلومات الأساسية' : 'Basic Info'}</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-zinc-400 mb-2">{dir === 'rtl' ? 'اسم المتجر' : 'Store Name'}</label>
                  <input type="text" defaultValue="Alex Smith" className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-[#D4AF37]" />
                </div>
                <div>
                  <label className="block text-sm text-zinc-400 mb-2">{dir === 'rtl' ? 'وصف المتجر' : 'Store Bio'}</label>
                  <textarea defaultValue="Designing my life" rows={3} className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-[#D4AF37]"></textarea>
                </div>
                <button className="flex items-center gap-2 bg-[#708238] hover:bg-[#859846] text-white px-6 py-3 rounded-xl font-bold transition-colors">
                  <Save className="w-4 h-4" />
                  {dir === 'rtl' ? 'حفظ التغييرات' : 'Save Changes'}
                </button>
              </div>
            </SoftCard>
            
            <SoftCard>
              <h3 className="text-lg font-bold text-white mb-4">{dir === 'rtl' ? 'رابط الصفحة' : 'Page Link'}</h3>
              <p className="text-sm text-zinc-400 mb-4">{dir === 'rtl' ? 'هذا هو الرابط الخاص بمتجرك في مجتمع ليفو' : 'This is your store link in the Levo community'}</p>
              <div className="flex items-center gap-4 flex-wrap sm:flex-nowrap">
                <code className="w-full sm:flex-1 bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-[#D4AF37] text-sm overflow-x-auto">
                  https://levo.com/store/alex.smith
                </code>
                <button onClick={() => navigate('/store/store-123')} className="w-full sm:w-auto bg-zinc-800 hover:bg-zinc-700 text-white px-6 py-3 rounded-xl font-bold transition-colors whitespace-nowrap">
                  {dir === 'rtl' ? 'زيارة الصفحة' : 'Visit Page'}
                </button>
              </div>
            </SoftCard>
          </div>
        </div>
      )}

      {/* PRODUCTS TAB */}
      {activeTab === 'products' && (
        <div className="mt-6">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold text-white">{dir === 'rtl' ? 'إدارة المنتجات' : 'Manage Products'}</h2>
            <button className="bg-[#D4AF37] text-[#0a0a0a] px-4 py-2 rounded-lg font-bold text-sm">
              {dir === 'rtl' ? 'إضافة منتج' : 'Add Product'}
            </button>
          </div>
          <SoftCard>
            <div className="text-zinc-400 text-center py-10">
              {dir === 'rtl' ? 'لا توجد منتجات حالياً' : 'No products found'}
            </div>
          </SoftCard>
        </div>
      )}

      {/* ORDERS TAB */}
      {activeTab === 'orders' && (
        <div className="mt-6">
          <h2 className="text-2xl font-bold text-white mb-6">{dir === 'rtl' ? 'الطلبات' : 'Orders'}</h2>
          <SoftCard>
            <div className="text-zinc-400 text-center py-10">
              {dir === 'rtl' ? 'لا توجد طلبات جديدة' : 'No new orders'}
            </div>
          </SoftCard>
        </div>
      )}
      
      {/* SETTINGS TAB */}
      {activeTab === 'settings' && (
        <div className="mt-6">
          <h2 className="text-2xl font-bold text-white mb-6">{dir === 'rtl' ? 'الإعدادات' : 'Settings'}</h2>
          <SoftCard>
            <div className="text-zinc-400 text-center py-10">
              {dir === 'rtl' ? 'إعدادات المتجر' : 'Store Settings'}
            </div>
          </SoftCard>
        </div>
      )}
    </DashboardLayout>
  );
}
"""

    with open('src/components/DashboardLayout.tsx', 'w') as f:
        f.write(layout_content)
        
    with open('src/components/MerchantDashboard.tsx', 'w') as f:
        f.write(merchant_content)
        
    print("Patched DashboardLayout to be full page")

if __name__ == "__main__":
    main()
