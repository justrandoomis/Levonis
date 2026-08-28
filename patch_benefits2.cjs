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
              Use Now
            </button>
          </div>
        </div>`;

const replacement = `        {/* VIP Benefits Card */}
        <div className="bg-gradient-to-b from-[#151515] to-[#050505] rounded-[24px] mb-6 shadow-2xl overflow-hidden border border-[#222]" dir="ltr">
          {/* Header */}
          <div className="relative w-full h-[60px] flex items-center border-b border-[#222]">
            {/* SVG Background for Gold Tab */}
            <div className="absolute top-0 left-0 w-[55%] md:w-[45%] h-full z-0 overflow-hidden">
              <svg preserveAspectRatio="none" viewBox="0 0 100 100" className="w-full h-full scale-105 origin-left">
                <path d="M0,0 L80,0 C92,0 85,100 100,100 L0,100 Z" fill="#e6c687" />
              </svg>
            </div>
            
            {/* Left Content (Gold Tab) */}
            <div className="relative z-10 w-[50%] md:w-[40%] flex justify-end items-center pr-8 text-black font-bold text-base cursor-pointer hover:opacity-80 transition-opacity">
              <ChevronLeft className="w-5 h-5 mr-1" strokeWidth={2.5} />
              <span className="text-[17px] tracking-tight">امتيازاتي الحصرية</span>
            </div>
            
            {/* Right Content (Black Tab) */}
            <div className="relative z-10 flex-1 flex justify-end items-center pr-5 text-[#e6c687] cursor-pointer hover:opacity-80 transition-opacity">
              <span className="text-2xl font-serif mr-3 opacity-90 tracking-wide">88VIP</span>
              <span className="text-sm mx-3 opacity-30 font-light">|</span>
              <span className="text-[13px] font-medium mr-1.5 opacity-90">عرض مزايا العضوية الضخمة</span>
              <ChevronLeft className="w-4 h-4 opacity-70" strokeWidth={2.5} />
            </div>
          </div>

          {/* Body Content */}
          <div className="px-6 pt-10 pb-10 grid grid-cols-3 gap-4" dir="rtl">
            {/* Right: Warranty Center */}
            <div className="flex flex-col items-center justify-center cursor-pointer group">
              <div className="w-[52px] h-[52px] mb-4 text-[#e6c687] transition-transform group-hover:scale-105 drop-shadow-md">
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
                  <path fillRule="evenodd" clipRule="evenodd" d="M12 2.25C7.5 2.25 4 4.25 4 4.25V9.75C4 15.25 7.5 19.75 12 21.75C16.5 19.75 20 15.25 20 9.75V4.25S16.5 2.25 12 2.25ZM16.3 8.3L10.8 13.8L7.7 10.7L6.3 12.1L10.8 16.6L17.7 9.7L16.3 8.3Z" />
                </svg>
              </div>
              <span className="text-zinc-300 text-[15px] font-medium mb-1.5 tracking-wide">مركز الضمان</span>
              <span className="h-7"></span> {/* Spacer to keep alignment with other items having numbers */}
            </div>

            {/* Middle: Wallet */}
            <div onClick={() => navigate('/wallet')} className="flex flex-col items-center justify-center cursor-pointer group">
              <div className="w-[52px] h-[52px] mb-4 text-[#e6c687] transition-transform group-hover:scale-105 drop-shadow-md">
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
                  <path fillRule="evenodd" clipRule="evenodd" d="M20 7H4C2.9 7 2 7.9 2 9V17C2 18.1 2.9 19 4 19H20C21.1 19 22 18.1 22 17V9C22 7.9 21.1 7 20 7ZM15 15.5V10.5C15 9.7 15.7 9 16.5 9H20V17H16.5C15.7 17 15 16.3 15 15.5Z" />
                  <path d="M16.5 10.5C15.9 10.5 15.5 10.9 15.5 11.5V14.5C15.5 15.1 15.9 15.5 16.5 15.5H20V10.5H16.5Z" />
                  <circle cx="17.2" cy="13" r="1.2" fill="#0a0a0a" />
                </svg>
              </div>
              <span className="text-zinc-300 text-[15px] font-medium mb-1.5 tracking-wide">محفظة</span>
              <span className="text-[#e6c687] font-bold text-2xl flex items-baseline drop-shadow-sm" dir="ltr">
                {currency === 'USD' && <span className="text-base mr-1">$</span>}
                <span className="text-2xl mr-0.5 tracking-tight font-serif">¥</span>
                <span className="text-2xl tracking-tight">{(currency === 'IQD' ? balance * exchangeRate : balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                {currency === 'IQD' && <span className="text-[14px] ml-1 opacity-0">.</span>}
              </span>
            </div>

            {/* Left: Points */}
            <div onClick={() => navigate('/points')} className="flex flex-col items-center justify-center cursor-pointer group">
              <div className="w-[52px] h-[52px] mb-4 text-[#e6c687] transition-transform group-hover:scale-105 drop-shadow-md">
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
                  <circle cx="12" cy="13" r="7.5" />
                  <circle cx="7.5" cy="7.5" r="3" />
                  <circle cx="16.5" cy="7.5" r="3" />
                  <path d="M9.5 10.5h5v1.5h-1.75v3.5h-1.5v-3.5h-1.75v-1.5z" fill="#0a0a0a" />
                </svg>
              </div>
              <span className="text-zinc-300 text-[15px] font-medium mb-1.5 tracking-wide">نقاط</span>
              <span className="text-[#e6c687] font-bold text-2xl drop-shadow-sm">{pointBalance.toLocaleString()}</span>
            </div>
          </div>
        </div>`;

content = content.replace(target, replacement);

fs.writeFileSync('src/pages/Profile.tsx', content);
