const fs = require('fs');
let code = fs.readFileSync('src/pages/Subscription.tsx', 'utf8');

const arrowCode = `            />
            
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 flex flex-col items-center justify-center animate-bounce z-10 pointer-events-none">
              <div className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-md border border-white/20 flex items-center justify-center shadow-[0_0_15px_rgba(255,255,255,0.1)] text-white mb-2">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              </div>
            </div>`;

code = code.replace(/            \/>/g, arrowCode);

fs.writeFileSync('src/pages/Subscription.tsx', code);
