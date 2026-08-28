import sys

def main():
    layout_content = """import React, { ReactNode } from 'react';
import { Search, Bell, Menu } from 'lucide-react';
import { useLanguage } from '../LanguageContext';

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

export default function DashboardLayout({ title = "LOGO", sidebarItems, activeTab, onTabChange, children }: DashboardLayoutProps) {
  const { dir } = useLanguage();
  
  return (
    <div className="min-h-screen bg-[#987DF6] flex items-center justify-center p-4 md:p-10 font-sans relative overflow-hidden" dir={dir}>
      {/* Background Subtle Blobs */}
      <div className="absolute top-[-5%] left-[10%] w-[400px] h-[400px] bg-white/10 rounded-full blur-3xl pointer-events-none"></div>
      <div className="absolute bottom-[-10%] right-[10%] w-[500px] h-[500px] bg-[#8964F3]/40 rounded-full blur-3xl pointer-events-none"></div>
      
      <div className="w-full max-w-[1440px] h-[90vh] min-h-[700px] bg-[#F4F6FC] rounded-[40px] flex shadow-[0_20px_60px_rgba(0,0,0,0.15)] relative z-10 overflow-hidden">
        
        {/* Sidebar */}
        <div className="hidden lg:flex flex-col w-[260px] bg-[#7D57F1] text-white shrink-0 shadow-[4px_0_24px_rgba(125,87,241,0.2)] z-20">
          <div className="p-8 flex items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-[#FF7A7A] to-[#FF9B7B] flex items-center justify-center font-bold text-lg text-white shadow-lg">
              L
            </div>
            <span className="font-bold text-sm tracking-widest uppercase border border-white/30 px-3 py-1 rounded-lg">{title}</span>
          </div>
          
          <div className="px-8 py-2 text-[10px] font-bold text-white/70 tracking-widest uppercase mb-2">
            LOREM
          </div>
          
          <nav className="flex-1 px-4 space-y-1">
            {sidebarItems.map(item => (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className={`w-full flex items-center gap-4 px-6 py-4 rounded-xl transition-all duration-300 font-medium ${
                  activeTab === item.id 
                    ? 'bg-[#6B46DF] text-white shadow-inner' 
                    : 'text-white/80 hover:bg-white/10'
                } ${dir === 'rtl' ? 'flex-row-reverse' : ''}`}
              >
                <item.icon className="w-5 h-5 shrink-0" />
                <span className={`text-[13px] ${dir === 'rtl' ? 'text-right' : 'text-left'}`}>{item.label}</span>
              </button>
            ))}
          </nav>
          
          <div className="p-6 mt-auto">
             <div className="w-full aspect-square rounded-[24px] bg-gradient-to-br from-[#8D6DF3] to-[#6A42E4] shadow-[0_10px_30px_rgba(0,0,0,0.1)] flex items-center justify-center p-6 relative overflow-hidden">
               <div className="w-full h-full rounded-full border border-white/20 flex items-center justify-center relative">
                 <div className="w-1.5 h-1.5 bg-white rounded-full absolute"></div>
                 <div className="w-0.5 h-8 bg-white/90 rounded-full absolute origin-bottom -translate-y-4 rotate-[45deg]"></div>
                 <div className="w-0.5 h-10 bg-white/60 rounded-full absolute origin-bottom -translate-y-5 rotate-[135deg]"></div>
                 {[0, 90, 180, 270].map(deg => (
                   <div key={deg} className="w-0.5 h-1.5 bg-white/30 absolute" style={{ transform: `rotate(${deg}deg) translateY(-32px)` }}></div>
                 ))}
               </div>
             </div>
             <div className="text-[10px] text-white/50 mt-4 text-center">Lorem ipsum dolor</div>
          </div>
        </div>

        {/* Main Content */}
        <div className="flex-1 flex flex-col h-full overflow-hidden relative">
          
          {/* Topbar */}
          <div className="h-[90px] flex items-center justify-between px-10 shrink-0 z-10 w-full bg-[#F4F6FC]/80 backdrop-blur-md">
             <div className="lg:hidden">
                <button className="p-2 bg-white rounded-lg shadow-sm text-[#7D57F1]">
                  <Menu className="w-5 h-5" />
                </button>
             </div>
             
             <div className="hidden lg:flex gap-14 text-[13px] font-semibold text-[#A0A5B1] pl-4">
               <span className="cursor-pointer hover:text-slate-800 transition-colors">Lorem ipsum</span>
               <span className="cursor-pointer hover:text-slate-800 transition-colors">Amet lorem</span>
               <div className="relative">
                 <span className="cursor-pointer text-slate-800 font-bold">Ipsum dolor</span>
                 <div className="absolute -bottom-4 left-0 right-0 h-0.5 bg-[#FF6B9E]"></div>
               </div>
             </div>
             
             <div className="flex items-center gap-6 ml-auto text-[#7D57F1]">
               <button className="hover:text-[#6731E4] transition-colors">
                 <Search className="w-5 h-5 stroke-[2]" />
               </button>
               <button className="hover:text-[#6731E4] transition-colors relative">
                 <Bell className="w-5 h-5 stroke-[2]" />
                 <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-[#FF6B9E] border-2 border-[#F4F6FC] rounded-full text-[8px] font-bold text-white flex items-center justify-center">5</span>
               </button>
               <div className="w-9 h-9 rounded-full bg-[#E5DFFF] flex items-center justify-center cursor-pointer overflow-hidden ml-2 shadow-sm border-2 border-white">
                 <svg viewBox="0 0 24 24" className="w-10 h-10 text-[#7D57F1] mt-2" fill="currentColor">
                   <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                 </svg>
               </div>
               <button className="text-slate-400 hover:text-slate-600 transition-colors ml-2">
                 <Menu className="w-6 h-6 stroke-[2]" />
               </button>
             </div>
          </div>
          
          {/* Scrollable Content */}
          <div className="flex-1 overflow-y-auto px-10 pb-10 custom-scrollbar relative z-0">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
"""

    merchant_content = """import React, { useState } from 'react';
import { useLanguage } from '../LanguageContext';
import DashboardLayout from './DashboardLayout';
import { Home, Shield, Lock, DollarSign, Settings, ChevronDown, Check } from 'lucide-react';

export default function MerchantDashboard() {
  const { dir } = useLanguage();
  const [activeTab, setActiveTab] = useState('home');

  const sidebarItems = [
    { id: 'home', icon: Home, label: 'Ipsum dolor' },
    { id: 'shield', icon: Shield, label: 'Sit amet' },
    { id: 'lock', icon: Lock, label: 'Lorem ipsum' },
    { id: 'finance', icon: DollarSign, label: 'Dolor sit' },
    { id: 'settings', icon: Settings, label: 'Amet lorem' },
  ];

  const SoftCard = ({ children, className = "" }: { children: React.ReactNode, className?: string }) => (
    <div className={`bg-white rounded-[24px] shadow-[0_10px_30px_rgba(0,0,0,0.03)] border border-white p-6 ${className}`}>
      {children}
    </div>
  );

  return (
    <DashboardLayout 
      sidebarItems={sidebarItems} 
      activeTab={activeTab} 
      onTabChange={setActiveTab}
    >
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 w-full">
        
        {/* Left Column (Spans 4) */}
        <div className="lg:col-span-4 flex flex-col gap-6">
          
          {/* Main Bar Chart Card */}
          <SoftCard className="flex flex-col h-[260px]">
            <div className="flex justify-between items-start mb-6">
               <div>
                 <div className="text-slate-400 text-[11px] font-semibold mb-1">Lorem Ipsum</div>
                 <div className="text-xl font-black text-slate-800">$ 240.117</div>
               </div>
               <button className="flex items-center gap-1 bg-[#2CE59B] text-white px-3 py-1.5 rounded-full text-[10px] font-bold shadow-[0_4px_12px_rgba(44,229,155,0.3)]">
                 dolor <ChevronDown className="w-3 h-3" />
               </button>
            </div>
            
            <div className="flex-1 flex items-end justify-between px-2 gap-4 h-full pt-4">
              {[
                { label: 'Apr', h1: '40%' },
                { label: 'Jun', h1: '60%' },
                { label: 'Aug', h1: '80%' },
                { label: 'Oct', h1: '100%' },
                { label: 'Feb', h1: '70%' }
              ].map((bar, i) => (
                <div key={i} className="flex flex-col items-center gap-3 flex-1 h-full justify-end">
                  <div className="w-3.5 bg-[#FF6B9E]/10 rounded-t-full relative h-full flex items-end">
                    <div className="w-full bg-gradient-to-t from-[#FF6B9E] to-[#FFA0BB] rounded-t-full shadow-[0_0_10px_rgba(255,107,158,0.3)] transition-all duration-700 ease-out" style={{ height: bar.h1 }}></div>
                  </div>
                  <span className="text-[9px] font-bold text-slate-400">{bar.label}</span>
                </div>
              ))}
            </div>
          </SoftCard>

          {/* Area Chart Card */}
          <SoftCard className="h-[200px] flex flex-col justify-end relative overflow-hidden p-0">
             <div className="absolute inset-0 pointer-events-none z-0 bg-[#F4F6FC]/20"></div>
             
             <svg viewBox="0 0 400 150" className="w-full h-full preserve-3d" preserveAspectRatio="none">
                <path d="M0,150 L0,90 C40,50 80,120 120,80 C160,40 200,100 240,70 C280,40 320,20 360,60 C390,90 400,120 400,120 L400,150 Z" fill="url(#gradPurple2)" opacity="0.4" />
                <path d="M0,150 L0,130 C40,120 80,150 120,110 C160,70 200,140 240,130 C280,120 320,90 360,110 C390,125 400,140 400,140 L400,150 Z" fill="url(#gradPink2)" opacity="0.8" />
                
                <defs>
                  <linearGradient id="gradPurple2" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="#7D57F1" stopOpacity="0.8" />
                    <stop offset="100%" stopColor="#7D57F1" stopOpacity="0" />
                  </linearGradient>
                  <linearGradient id="gradPink2" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="#FF6B9E" stopOpacity="0.8" />
                    <stop offset="100%" stopColor="#FF6B9E" stopOpacity="0" />
                  </linearGradient>
                </defs>
             </svg>
             
             {/* Data points */}
             <div className="absolute top-[40%] left-[25%] w-7 h-7 bg-white rounded-full shadow-[0_4px_10px_rgba(0,0,0,0.1)] flex items-center justify-center text-[7px] font-bold text-slate-800 z-10">31</div>
             <div className="absolute top-[60%] left-[45%] w-6 h-6 bg-white rounded-full shadow-[0_4px_10px_rgba(0,0,0,0.1)] flex items-center justify-center text-[6px] font-bold text-slate-800 z-10">49</div>
             <div className="absolute top-[20%] left-[75%] w-7 h-7 bg-white rounded-full shadow-[0_4px_10px_rgba(0,0,0,0.1)] flex items-center justify-center text-[7px] font-bold text-slate-800 z-10">67</div>
             
             {/* X Axis */}
             <div className="absolute bottom-3 left-6 right-6 flex justify-between text-[8px] font-bold text-slate-400 z-10">
               <span>20</span><span>30</span><span>40</span><span>50</span><span>60</span><span>70</span><span>80</span>
             </div>
          </SoftCard>

          {/* Bottom Left Stats */}
          <SoftCard className="flex flex-row justify-between items-center py-6 h-[140px]">
             <div className="flex flex-col gap-3">
               <div className="flex items-center gap-2">
                 <div className="w-1.5 h-1.5 rounded-full bg-[#7D57F1]"></div>
                 <span className="text-[9px] text-slate-400 font-semibold w-16">Ipsum dolor</span>
                 <span className="text-[9px] text-slate-800 font-bold">32%</span>
               </div>
               <div className="flex items-center gap-2">
                 <div className="w-1.5 h-1.5 rounded-full bg-[#FF6B9E]"></div>
                 <span className="text-[9px] text-slate-400 font-semibold w-16">Dolor sit</span>
                 <span className="text-[9px] text-slate-800 font-bold">56%</span>
               </div>
               <div className="flex items-center gap-2">
                 <div className="w-1.5 h-1.5 rounded-full bg-[#2CE59B]"></div>
                 <span className="text-[9px] text-slate-400 font-semibold w-16">Amet lorem</span>
                 <span className="text-[9px] text-slate-800 font-bold">12%</span>
               </div>
             </div>
             
             <div className="flex items-center">
                <div className="relative w-20 h-20">
                   <svg viewBox="0 0 36 36" className="w-full h-full transform -rotate-90">
                     <path className="text-slate-100" strokeWidth="4" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                     <path className="text-[#7D57F1]" strokeDasharray="67, 100" strokeWidth="4" strokeLinecap="round" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                     <path className="text-[#FF6B9E]" strokeDasharray="30, 100" strokeDashoffset="-67" strokeWidth="4" strokeLinecap="round" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                   </svg>
                   <div className="absolute inset-0 flex flex-col items-center justify-center">
                     <span className="text-[13px] font-black text-slate-800 leading-none mb-0.5">67%</span>
                     <span className="text-[5px] font-bold text-slate-400 tracking-widest">LOREM IPSUM</span>
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
                <span className="text-[10px] font-bold text-slate-400 uppercase">Dolore</span>
                <span className="text-sm font-black text-slate-800 mb-2">$ 12,376</span>
                <button className="bg-[#2CE59B] text-white text-[9px] font-bold py-1.5 px-4 rounded-lg shadow-[0_4px_10px_rgba(44,229,155,0.3)]">Lorem</button>
              </SoftCard>
              <SoftCard className="p-5 flex flex-col justify-center items-start gap-1">
                <span className="text-[10px] font-bold text-slate-400 uppercase">Dolore</span>
                <span className="text-sm font-black text-slate-800 mb-2">$ 11,544</span>
                <button className="bg-[#D67BFF] text-white text-[9px] font-bold py-1.5 px-4 rounded-lg shadow-[0_4px_10px_rgba(214,123,255,0.3)]">Lorem</button>
              </SoftCard>
           </div>
           
           {/* Dots Rows */}
           <div className="py-2 flex flex-col gap-4 pl-2">
              <div className="flex items-center gap-4">
                 <span className="text-[10px] font-bold text-slate-800 w-12">LOREM</span>
                 <div className="flex gap-2">
                   {[1,2,3,4].map(i => <div key={i} className="w-3 h-3 rounded-full bg-[#2CE59B] shadow-sm"></div>)}
                   {[5,6].map(i => <div key={i} className="w-3 h-3 rounded-full bg-white shadow-sm border border-slate-100"></div>)}
                 </div>
              </div>
              <div className="flex items-center gap-4">
                 <span className="text-[10px] font-bold text-slate-800 w-12">LOREM</span>
                 <div className="flex gap-2">
                   <div className="w-3 h-3 rounded-full bg-[#2CE59B] shadow-sm"></div>
                   {[1,2,3,4].map(i => <div key={i} className="w-3 h-3 rounded-full bg-[#D67BFF] shadow-sm"></div>)}
                   <div className="w-3 h-3 rounded-full bg-white shadow-sm border border-slate-100"></div>
                 </div>
              </div>
              <div className="flex items-center gap-4">
                 <span className="text-[9px] font-semibold text-slate-400 w-12">Lorem ipsum</span>
              </div>
           </div>

           {/* List Items */}
           <div className="flex flex-col gap-4 mt-2">
              <SoftCard className="p-4 flex items-center justify-between shadow-[0_4px_20px_-5px_rgba(0,0,0,0.02)] border border-slate-50">
                 <div>
                   <div className="text-[11px] font-bold text-slate-700">Dolor sit amet lorem</div>
                   <div className="text-[9px] text-slate-400 mt-1">Dolor sit amet</div>
                 </div>
                 <div className="w-7 h-7 rounded-lg bg-[#2CE59B] text-white flex items-center justify-center shadow-[0_4px_10px_rgba(44,229,155,0.3)]">
                   <ChevronDown className="w-4 h-4" />
                 </div>
              </SoftCard>
              <SoftCard className="p-4 flex items-center justify-between shadow-[0_4px_20px_-5px_rgba(0,0,0,0.02)] border border-slate-50">
                 <div>
                   <div className="text-[11px] font-bold text-slate-700">Dolor sit amet lorem</div>
                   <div className="text-[9px] text-slate-400 mt-1">Dolor sit amet</div>
                 </div>
                 <div className="w-7 h-7 rounded-lg bg-[#FF6B9E] text-white flex items-center justify-center shadow-[0_4px_10px_rgba(255,107,158,0.3)]">
                   <ChevronDown className="w-4 h-4" />
                 </div>
              </SoftCard>
           </div>
           
           {/* Progress Bars */}
           <div className="flex flex-col gap-6 mt-4">
              <div>
                 <div className="flex justify-between items-end mb-2">
                   <span className="text-[13px] font-black text-slate-800">64%</span>
                   <span className="text-[8px] font-bold text-slate-400 tracking-widest uppercase">Lorem ipsum sit</span>
                 </div>
                 <div className="w-full bg-slate-100 rounded-full h-2">
                   <div className="bg-[#D67BFF] h-2 rounded-full shadow-[0_0_8px_rgba(214,123,255,0.4)]" style={{ width: '64%' }}></div>
                 </div>
              </div>
              <div>
                 <div className="flex justify-between items-end mb-2">
                   <span className="text-[13px] font-black text-slate-800">83%</span>
                   <span className="text-[8px] font-bold text-slate-400 tracking-widest uppercase">Lorem ipsum sit</span>
                 </div>
                 <div className="w-full bg-slate-100 rounded-full h-2">
                   <div className="bg-[#FFD166] h-2 rounded-full shadow-[0_0_8px_rgba(255,209,102,0.4)]" style={{ width: '83%' }}></div>
                 </div>
              </div>
           </div>

        </div>

        {/* Right Column (Spans 4) */}
        <div className="lg:col-span-4 flex flex-col gap-6">
           
           {/* Circular Progress Row */}
           <div className="flex justify-between items-center px-4 py-2 h-[120px]">
              <div className="flex flex-col items-center gap-3">
                <div className="relative w-[50px] h-[50px]">
                   <svg viewBox="0 0 36 36" className="w-full h-full transform -rotate-90">
                     <path className="text-slate-100" strokeWidth="4" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                     <path className="text-[#FFD166]" strokeDasharray="75, 100" strokeWidth="4" strokeLinecap="round" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                   </svg>
                   <div className="absolute inset-0 flex items-center justify-center text-[11px] font-black text-slate-700">75%</div>
                </div>
                <div className="text-center text-[6px] font-semibold text-slate-400 leading-[1.2]">Lorem ipsum dolor<br/>sit amet dolor</div>
              </div>

              <div className="flex flex-col items-center gap-3">
                <div className="relative w-[50px] h-[50px]">
                   <svg viewBox="0 0 36 36" className="w-full h-full transform -rotate-90">
                     <path className="text-slate-100" strokeWidth="4" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                     <path className="text-[#06D6A0]" strokeDasharray="71, 100" strokeWidth="4" strokeLinecap="round" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                   </svg>
                   <div className="absolute inset-0 flex items-center justify-center text-[11px] font-black text-slate-700">71%</div>
                </div>
                <div className="text-center text-[6px] font-semibold text-slate-400 leading-[1.2]">Lorem ipsum dolor<br/>sit amet dolor</div>
              </div>

              <div className="flex flex-col items-center gap-3">
                <div className="relative w-[50px] h-[50px]">
                   <svg viewBox="0 0 36 36" className="w-full h-full transform -rotate-90">
                     <path className="text-slate-100" strokeWidth="4" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                     <path className="text-[#7D57F1]" strokeDasharray="46, 100" strokeWidth="4" strokeLinecap="round" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                   </svg>
                   <div className="absolute inset-0 flex items-center justify-center text-[11px] font-black text-slate-700">46%</div>
                </div>
                <div className="text-center text-[6px] font-semibold text-slate-400 leading-[1.2]">Lorem ipsum dolor<br/>sit amet dolor</div>
              </div>
           </div>

           {/* Double Line Chart */}
           <SoftCard className="p-5 relative h-[180px]">
             <div className="text-[8px] font-bold text-slate-700 tracking-widest uppercase mb-4">LOREM IPSUM DOLOR SIT AMET</div>
             
             <div className="absolute inset-x-5 top-12 bottom-6 flex flex-col justify-between z-0">
                {[100, 50, 0].map(val => (
                  <div key={val} className="flex items-center gap-2 w-full">
                    <span className="text-[7px] font-bold text-slate-300 w-3 text-right">{val}</span>
                    <div className="flex-1 border-b border-dashed border-slate-200 h-px"></div>
                  </div>
                ))}
             </div>
             
             <div className="absolute inset-x-10 top-12 bottom-6 z-10">
                <svg viewBox="0 0 300 100" className="w-full h-full preserve-3d" preserveAspectRatio="none">
                  {/* Yellow area */}
                  <path d="M0,40 Q40,10 80,40 T160,30 T240,10 T300,30 L300,60 L0,60 Z" fill="url(#gradYellow2)" opacity="0.5" />
                  <path d="M0,40 Q40,10 80,40 T160,30 T240,10 T300,30" fill="none" stroke="#FFD166" strokeWidth="2.5" />
                  
                  {/* Green area */}
                  <path d="M0,80 Q30,60 70,80 T150,90 T220,70 T300,80 L300,100 L0,100 Z" fill="url(#gradGreen2)" opacity="0.5" />
                  <path d="M0,80 Q30,60 70,80 T150,90 T220,70 T300,80" fill="none" stroke="#06D6A0" strokeWidth="2.5" />

                  <defs>
                    <linearGradient id="gradYellow2" x1="0%" y1="0%" x2="0%" y2="100%">
                      <stop offset="0%" stopColor="#FFD166" stopOpacity="0.8" />
                      <stop offset="100%" stopColor="#FFD166" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="gradGreen2" x1="0%" y1="0%" x2="0%" y2="100%">
                      <stop offset="0%" stopColor="#06D6A0" stopOpacity="0.8" />
                      <stop offset="100%" stopColor="#06D6A0" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                </svg>
             </div>
           </SoftCard>

           {/* Bottom Bar Chart */}
           <div className="flex-1 flex flex-col pt-4">
              <div className="relative h-full w-full min-h-[140px] flex items-end">
                 <div className="absolute inset-0 flex flex-col justify-between">
                    {[75, 50, 25, 0].map(val => (
                      <div key={val} className="flex items-center gap-2 w-full">
                        <span className="text-[7px] font-bold text-slate-300 w-4 text-right">{val}%</span>
                        <div className="flex-1 border-b border-dashed border-slate-200 h-px"></div>
                      </div>
                    ))}
                 </div>
                 
                 <div className="relative z-10 w-full h-[85%] flex items-end justify-around pl-8 pr-4">
                    {[
                      { h: '60%', c: '#FFB6C1' },
                      { h: '40%', c: '#FFB6C1' },
                      { h: '85%', c: '#FFB6C1' },
                      { h: '30%', c: '#FFB6C1' },
                      { h: '50%', c: '#FFB6C1' },
                      { h: '100%', c: '#FFB6C1' },
                      { h: '70%', c: '#FFB6C1' }
                    ].map((bar, i) => (
                      <div key={i} className="w-6 relative h-full flex items-end justify-center">
                         <div className="w-full rounded-t-sm shadow-[0_0_8px_rgba(255,182,193,0.5)] transition-all duration-700 ease-out" 
                              style={{ height: bar.h, backgroundColor: bar.c }}></div>
                      </div>
                    ))}
                 </div>
              </div>
           </div>

        </div>

      </div>
    </DashboardLayout>
  );
}
"""

    with open('src/components/DashboardLayout.tsx', 'w') as f:
        f.write(layout_content)
        
    with open('src/components/MerchantDashboard.tsx', 'w') as f:
        f.write(merchant_content)
        
    print("Patched layout and dashboard")

if __name__ == "__main__":
    main()
