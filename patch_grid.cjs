const fs = require('fs');
let content = fs.readFileSync('src/pages/Profile.tsx', 'utf8');

const target = `          {/* Body Content */}
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
          </div>`;

const replacement = `          {/* Body Content */}
          <div className="px-6 pt-10 pb-10 grid grid-cols-3 gap-4" dir="rtl">
            {/* Right: Points */}
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
            
            {/* Left: Warranty Center */}
            <div className="flex flex-col items-center justify-center cursor-pointer group">
              <div className="w-[52px] h-[52px] mb-4 text-[#e6c687] transition-transform group-hover:scale-105 drop-shadow-md">
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
                  <path fillRule="evenodd" clipRule="evenodd" d="M12 2.25C7.5 2.25 4 4.25 4 4.25V9.75C4 15.25 7.5 19.75 12 21.75C16.5 19.75 20 15.25 20 9.75V4.25S16.5 2.25 12 2.25ZM16.3 8.3L10.8 13.8L7.7 10.7L6.3 12.1L10.8 16.6L17.7 9.7L16.3 8.3Z" />
                </svg>
              </div>
              <span className="text-zinc-300 text-[15px] font-medium mb-1.5 tracking-wide">مركز الضمان</span>
              <span className="h-7"></span> {/* Spacer to keep alignment with other items having numbers */}
            </div>
          </div>`;

content = content.replace(target, replacement);

fs.writeFileSync('src/pages/Profile.tsx', content);
