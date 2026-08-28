const fs = require('fs');
let content = fs.readFileSync('src/pages/Profile.tsx', 'utf8');

const target = `        {/* Orders Card */}
        <div className="bg-gradient-to-b from-[#151515] to-[#050505] rounded-[16px] sm:rounded-[20px] md:rounded-[24px] mb-4 sm:mb-6 shadow-2xl overflow-hidden border border-[#222]" dir="ltr">
          {/* Header */}
          <div className="relative w-full h-[48px] sm:h-[54px] md:h-[60px] flex items-center border-b border-[#222]">
            {/* SVG Background for Gold Tab */}
            <div className="absolute top-0 left-0 w-[35%] sm:w-[30%] md:w-[25%] h-full z-0 overflow-hidden">
              <svg preserveAspectRatio="none" viewBox="0 0 100 100" className="w-full h-full scale-[1.05] origin-left">
                <path d="M0,0 L78,0 C88,0 82,100 100,100 L0,100 Z" fill="#e6c687" />
              </svg>
            </div>
            
            {/* Left Content (Gold Tab) - Show All Orders */}
            <div className="relative z-10 w-[32%] sm:w-[28%] md:w-[23%] flex justify-center sm:justify-end items-center pr-2 sm:pr-6 text-black font-bold cursor-pointer hover:opacity-80 transition-opacity">
              <ChevronLeft className="w-4 h-4 sm:w-5 sm:h-5 mr-0.5 sm:mr-1 shrink-0" strokeWidth={2.5} />
              <span className="text-[12px] sm:text-[14px] md:text-[16px] tracking-tight truncate">الكل</span>
            </div>
            
            {/* Right Content (Black Tab) - My Orders Title */}
            <div className="relative z-10 flex-1 flex justify-end items-center pr-4 sm:pr-6 md:pr-8 text-[#e6c687] cursor-pointer hover:opacity-80 transition-opacity overflow-hidden">
              <span className="text-[14px] sm:text-base md:text-lg font-medium opacity-90 truncate">{t('myOrders' as any)}</span>
            </div>
          </div>

          {/* Body Content */}
          <div className="px-3 sm:px-6 pt-6 sm:pt-8 md:pt-10 pb-6 sm:pb-8 md:pb-10 flex justify-between items-start" dir="rtl">
            {[
              { icon: Wallet, label: 'pendingPayment' },
              { icon: Package, label: 'processing' },
              { icon: Truck, label: 'shipped', badge: '1' },
              { icon: MessageSquare, label: 'reviews' },
              { icon: RefreshCcw, label: 'returns' },
            ].map((item, i) => (
              <div key={i} className="flex flex-col items-center justify-center cursor-pointer group w-[20%]">
                <div className="relative w-[28px] h-[28px] sm:w-[36px] sm:h-[36px] md:w-[44px] md:h-[44px] mb-2 sm:mb-3 md:mb-4 text-[#e6c687] transition-transform group-hover:scale-105 drop-shadow-md">
                  <item.icon className="w-full h-full text-[#e6c687] opacity-90" strokeWidth={1.5} />
                  {item.badge && (
                    <span className="absolute -top-1.5 -right-2 bg-[#e6c687] text-black text-[10px] font-bold w-[16px] h-[16px] rounded-full flex items-center justify-center shadow-sm border border-[#151515]">
                      {item.badge}
                    </span>
                  )}
                </div>
                <span className="text-zinc-300 text-[10px] sm:text-[12px] md:text-[14px] font-medium tracking-wide text-center group-hover:text-[#e6c687] transition-colors leading-tight">
                  {t(item.label as any)}
                </span>
              </div>
            ))}
          </div>
        </div>`;

const replacement = `        {/* Orders Card */}
        <div className="bg-gradient-to-b from-[#151515] to-[#050505] rounded-[16px] mb-4 shadow-xl overflow-hidden border border-[#222]" dir="ltr">
          {/* Header */}
          <div className="relative w-full h-[40px] sm:h-[44px] md:h-[48px] flex items-center border-b border-[#222]">
            {/* SVG Background for Gold Tab */}
            <div className="absolute top-0 left-0 w-[35%] sm:w-[30%] md:w-[25%] h-full z-0 overflow-hidden">
              <svg preserveAspectRatio="none" viewBox="0 0 100 100" className="w-full h-full scale-[1.05] origin-left">
                <path d="M0,0 L78,0 C88,0 82,100 100,100 L0,100 Z" fill="#e6c687" />
              </svg>
            </div>
            
            {/* Left Content (Gold Tab) - Show All Orders */}
            <div className="relative z-10 w-[32%] sm:w-[28%] md:w-[23%] flex justify-center sm:justify-end items-center pr-2 sm:pr-4 md:pr-6 text-black font-bold cursor-pointer hover:opacity-80 transition-opacity">
              <ChevronLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4 mr-0.5 shrink-0" strokeWidth={2.5} />
              <span className="text-[11px] sm:text-[12px] md:text-[13px] tracking-tight truncate">الكل</span>
            </div>
            
            {/* Right Content (Black Tab) - My Orders Title */}
            <div className="relative z-10 flex-1 flex justify-end items-center pr-4 sm:pr-5 md:pr-6 text-[#e6c687] cursor-pointer hover:opacity-80 transition-opacity overflow-hidden">
              <span className="text-[13px] sm:text-[14px] md:text-[15px] font-medium opacity-90 truncate">{t('myOrders' as any)}</span>
            </div>
          </div>

          {/* Body Content */}
          <div className="px-3 sm:px-4 md:px-5 pt-4 sm:pt-5 md:pt-6 pb-4 sm:pb-5 md:pb-6 flex justify-between items-start" dir="rtl">
            {[
              { icon: Wallet, label: 'pendingPayment' },
              { icon: Package, label: 'processing' },
              { icon: Truck, label: 'shipped', badge: '1' },
              { icon: MessageSquare, label: 'reviews' },
              { icon: RefreshCcw, label: 'returns' },
            ].map((item, i) => (
              <div key={i} className="flex flex-col items-center justify-center cursor-pointer group w-[20%]">
                <div className="relative w-[24px] h-[24px] sm:w-[28px] sm:h-[28px] md:w-[32px] md:h-[32px] mb-1.5 sm:mb-2 text-[#e6c687] transition-transform group-hover:scale-105 drop-shadow-md">
                  <item.icon className="w-full h-full text-[#e6c687] opacity-90" strokeWidth={1.5} />
                  {item.badge && (
                    <span className="absolute -top-1.5 -right-2 bg-[#e6c687] text-black text-[9px] font-bold w-[14px] h-[14px] rounded-full flex items-center justify-center shadow-sm border border-[#151515]">
                      {item.badge}
                    </span>
                  )}
                </div>
                <span className="text-zinc-300 text-[9px] sm:text-[10px] md:text-[11px] font-medium tracking-wide text-center group-hover:text-[#e6c687] transition-colors leading-tight">
                  {t(item.label as any)}
                </span>
              </div>
            ))}
          </div>
        </div>`;

content = content.replace(target, replacement);

fs.writeFileSync('src/pages/Profile.tsx', content);
