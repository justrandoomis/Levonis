const fs = require('fs');
let content = fs.readFileSync('src/pages/Profile.tsx', 'utf8');

const target = `        {/* Benefits Card */}
        <div className="bg-zinc-900/95 backdrop-blur-md border border-zinc-800/50 rounded-xl p-3 mb-3 shadow-sm flex flex-col gap-3">
          <div className="flex justify-between items-center">
            <h2 className="text-gold font-bold text-[15px] flex items-center gap-0.5">
              {t('myBenefits' as any)} <ChevronRight className="w-4 h-4 text-zinc-500" />
            </h2>
            <div className="flex items-center bg-gradient-to-r from-[#2a3f1c]/30 to-transparent rounded-full px-2 py-0.5">
              <button className="text-gold font-bold italic tracking-wider text-xs mr-2 hover:opacity-80 transition-opacity active:scale-95">{user?.isAdmin ? 'Pro Member' : t('vipMember' as any)}</button>
              <div className="w-px h-3 bg-zinc-700 mx-1"></div>
              <button className="text-zinc-400 flex items-center text-[10px] ml-1 hover:opacity-80 transition-opacity active:scale-95">{user?.isAdmin ? 'View Pro Benefits' : t('viewBenefits' as any)} <ChevronRight className="w-3 h-3" /></button>
            </div>
          </div>
          
          <div className="grid grid-cols-3 gap-2 text-center mt-1">
            <div className="flex flex-col items-center cursor-pointer">
              <span className="text-zinc-400 text-[11px] mb-1">{t('coupons' as any)}</span>
              <span className="text-white font-bold text-base leading-none">2 <span className="text-[10px] font-normal text-zinc-500 ml-0.5">pcs</span></span>
            </div>
            <div className="flex flex-col items-center cursor-pointer" onClick={() => navigate('/wallet')}>
              <span className="text-zinc-400 text-[11px] mb-1">{t('balance' as any)}</span>
              <span className="text-white font-bold text-base leading-none">
                {currency === 'USD' && <span className="text-[10px] font-normal text-zinc-500 mr-0.5">$</span>}
                {(currency === 'IQD' ? balance * exchangeRate : balance).toLocaleString('en-US', { minimumFractionDigits: currency === 'IQD' ? 0 : 2, maximumFractionDigits: currency === 'IQD' ? 0 : 2 })}
                {currency === 'IQD' && <span className="text-[10px] font-normal text-zinc-500 ml-0.5">IQD</span>}
              </span>
            </div>
            <div onClick={() => navigate('/points')} className="flex flex-col items-center cursor-pointer hover:bg-white/5 rounded-lg transition-colors p-1 -m-1">
              <span className="text-zinc-400 text-[11px] mb-1">{t('points' as any)}</span>
              <span className="text-white font-bold text-base leading-none">{pointBalance.toLocaleString()}</span>
            </div>
          </div>

          <div className="bg-zinc-800/40 rounded-lg p-2 flex justify-between items-center border border-zinc-800/50 mt-1">
            <div className="flex items-center gap-2">
              <div className="text-gold bg-olive/20 px-1.5 py-0.5 rounded text-[10px] font-bold">
                $20
              </div>
              <span className="text-[11px] text-white font-medium">Available on orders over $200</span>
              <span className="text-[10px] text-zinc-500 hidden sm:inline ml-1">For specific items</span>
            </div>
            <button className="bg-olive hover:bg-olive-light text-white text-[11px] font-bold px-3 py-1 rounded-full transition-colors">
              Claim
            </button>
          </div>
        </div>`;

const replacement = `        {/* VIP Benefits Card */}
        <div className="bg-gradient-to-b from-[#151515] to-[#050505] rounded-xl mb-4 shadow-xl overflow-hidden" dir="ltr">
          {/* Header */}
          <div className="relative w-full h-[52px] flex items-center border-b border-[#222]">
            {/* SVG Background for Gold Tab */}
            <div className="absolute top-0 left-0 w-[45%] md:w-[35%] h-full z-0">
              <svg preserveAspectRatio="none" viewBox="0 0 100 100" className="w-full h-full">
                <path d="M0,0 L85,0 C95,0 90,100 100,100 L0,100 Z" fill="#e6c687" />
              </svg>
            </div>
            
            {/* Left Content (Gold Tab) */}
            <div className="relative z-10 flex-1 flex items-center pl-4 text-black font-bold text-sm cursor-pointer hover:opacity-80 transition-opacity">
              <ChevronLeft className="w-5 h-5 mr-1" strokeWidth={2.5} />
              <span className="text-[15px]">امتيازاتي الحصرية</span>
            </div>
            
            {/* Right Content (Black Tab) */}
            <div className="relative z-10 flex-1 flex justify-end items-center pr-4 text-[#e6c687] cursor-pointer hover:opacity-80 transition-opacity">
              <span className="text-xl font-serif mr-2 opacity-90">88VIP</span>
              <span className="text-xs mx-1 opacity-40">|</span>
              <span className="text-xs font-medium mr-1">عرض مزايا العضوية الضخمة</span>
              <ChevronLeft className="w-4 h-4 opacity-80" strokeWidth={2} />
            </div>
          </div>

          {/* Body Content */}
          <div className="px-4 pt-6 pb-6 grid grid-cols-3 gap-2" dir="rtl">
            {/* Right: Points */}
            <div onClick={() => navigate('/points')} className="flex flex-col items-center justify-center cursor-pointer group">
              <div className="w-12 h-12 mb-3 text-[#e6c687] transition-transform group-hover:scale-110 drop-shadow-md">
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
                  <circle cx="12" cy="13" r="7.5" />
                  <circle cx="7" cy="7" r="3.2" />
                  <circle cx="17" cy="7" r="3.2" />
                  <path d="M9.5 10.5h5v1.5h-1.75v3.5h-1.5v-3.5h-1.75v-1.5z" fill="#0a0a0a" />
                </svg>
              </div>
              <span className="text-zinc-300 text-sm font-medium mb-1.5 tracking-wide">نقاط</span>
              <span className="text-[#e6c687] font-bold text-xl drop-shadow-sm">{pointBalance.toLocaleString()}</span>
            </div>

            {/* Middle: Wallet */}
            <div onClick={() => navigate('/wallet')} className="flex flex-col items-center justify-center cursor-pointer group">
              <div className="w-12 h-12 mb-3 text-[#e6c687] transition-transform group-hover:scale-110 drop-shadow-md">
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
                  <path d="M20 7H4C2.9 7 2 7.9 2 9V17C2 18.1 2.9 19 4 19H20C21.1 19 22 18.1 22 17V9C22 7.9 21.1 7 20 7ZM17.5 15H15.5V11H17.5C18.6 11 19.5 11.9 19.5 13C19.5 14.1 18.6 15 17.5 15Z" />
                  <circle cx="17.5" cy="13" r="1.2" fill="#0a0a0a" />
                </svg>
              </div>
              <span className="text-zinc-300 text-sm font-medium mb-1.5 tracking-wide">محفظة</span>
              <span className="text-[#e6c687] font-bold text-xl flex items-baseline drop-shadow-sm" dir="ltr">
                {currency === 'USD' && <span className="text-sm mr-0.5">$</span>}
                {currency === 'IQD' && <span className="text-sm mr-0.5 opacity-0">.</span>}
                {(currency === 'IQD' ? balance * exchangeRate : balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                {currency === 'IQD' && <span className="text-[13px] ml-1">IQD</span>}
              </span>
            </div>

            {/* Left: Warranty Center */}
            <div className="flex flex-col items-center justify-center cursor-pointer group">
              <div className="w-12 h-12 mb-3 text-[#e6c687] transition-transform group-hover:scale-110 drop-shadow-md">
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
                  <path d="M12 2.25c-4.5 0-8 2-8 2v5.5c0 5.5 3.5 10 8 12 4.5-2 8-6.5 8-12v-5.5s-3.5-2-8-2zm-1.25 12.5l-3.5-3.5 1.5-1.5 2 2 5-5 1.5 1.5-6.5 6.5z" />
                </svg>
              </div>
              <span className="text-zinc-300 text-sm font-medium mb-1.5 tracking-wide">مركز الضمان</span>
              <span className="h-6"></span> {/* Spacer to keep alignment with other items having numbers */}
            </div>
          </div>
        </div>`;

content = content.replace(target, replacement);

fs.writeFileSync('src/pages/Profile.tsx', content);
