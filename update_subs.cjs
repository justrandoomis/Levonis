const fs = require('fs');
let code = fs.readFileSync('src/pages/Subscription.tsx', 'utf8');

// Ensure CircularGallery is imported
if (!code.includes('import CircularGallery')) {
  code = code.replace(
    /import \{ Sparkles, Check, Info, ShieldCheck \} from 'lucide-react';/,
    `import { Sparkles, Check, Info, ShieldCheck } from 'lucide-react';\nimport CircularGallery from '../components/CircularGallery';`
  );
}

const gallerySection = `        {/* Circular Plans Gallery */}
        <div className="pt-4 pb-4 min-h-[350px] px-2 sm:px-0 relative">
          <div style={{ height: '350px', position: 'relative' }}>
            <CircularGallery
              bend={3}
              textColor="#ffffff"
              borderRadius={0.1}
              scrollEase={0.08}
              fontUrl="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@700&display=swap"
              font="bold 24px 'Plus Jakarta Sans'"
              scrollSpeed={3.5}
              onIndexChange={(index) => {
                if (activePlans[index]) {
                  setSelectedDuration(activePlans[index].id);
                }
              }}
              items={activePlans.map((plan, i) => {
                const images = [
                  'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=800&auto=format&fit=crop',
                  'https://images.unsplash.com/photo-1614850523459-c2f4c699c52e?q=80&w=800&auto=format&fit=crop',
                  'https://images.unsplash.com/photo-1550684848-fac1c5b4e853?q=80&w=800&auto=format&fit=crop',
                  'https://images.unsplash.com/photo-1618005192384-a83a8bd57fbe?q=80&w=800&auto=format&fit=crop'
                ];
                return {
                  image: images[i % images.length],
                  text: plan.number + ' ' + plan.unit
                };
              })}
            />
          </div>
          
          {/* Selected Plan Details */}
          <AnimatePresence mode="wait">
            <motion.div 
              key={selectedDuration}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="mt-6 flex flex-col items-center"
            >
              {(() => {
                const selectedPlan = activePlans.find(p => p.id === selectedDuration);
                if (!selectedPlan) return null;
                const badgeBg = activeTab === 'pro' ? 'bg-[#B03142]' : 'bg-olive';
                const accentColor = activeTab === 'pro' ? 'from-[#B03142] to-[#8c2634]' : 'from-olive to-[#0A1F18]';
                
                return (
                  <div className="relative w-full max-w-[280px] bg-zinc-800/90 backdrop-blur-xl rounded-[20px] p-6 shadow-xl border border-white/5">
                    {selectedPlan.badge && (
                      <div className={\`absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 \${badgeBg} rounded-full\`}>
                        <span className="text-[10px] font-bold text-white uppercase tracking-wider">{selectedPlan.badge}</span>
                      </div>
                    )}
                    
                    <div className="text-center mt-2">
                      <h4 className="font-black text-white text-[32px]">
                        {selectedPlan.number} <span className="text-[20px] text-zinc-400">{selectedPlan.unit}</span>
                      </h4>
                    </div>
                    
                    <div className="text-center w-full flex flex-col items-center gap-2 mt-4">
                      <span className="text-[13px] font-medium text-zinc-300">
                        {selectedPlan.pricePerUnit}
                      </span>
                      
                      {selectedPlan.savings ? (
                        <span className={\`px-3 py-1 rounded-full text-[12px] font-bold \${
                          activeTab === 'pro' ? 'bg-[#B03142]/80 text-gold border border-[#B03142]/50' : 'bg-olive/20 text-gold border border-olive/30'
                        }\`}>
                          {selectedPlan.savings}
                        </span>
                      ) : (
                        <span className="h-[28px]"></span>
                      )}
                      
                      <span className="font-bold mt-2 tracking-tight text-white text-[18px]">
                        Total: {selectedPlan.total}
                      </span>
                    </div>
                  </div>
                );
              })()}
            </motion.div>
          </AnimatePresence>
        </div>`;

const regex = /\{\/\* Plans Grid \*\/\}[\s\S]*?<\/AnimatePresence>\n\s*<\/div>/;

if (regex.test(code)) {
  code = code.replace(regex, gallerySection);
  fs.writeFileSync('src/pages/Subscription.tsx', code);
  console.log('Successfully replaced plans grid.');
} else {
  console.error('Regex did not match.');
}
