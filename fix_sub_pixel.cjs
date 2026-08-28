const fs = require('fs');
let code = fs.readFileSync('src/pages/Subscription.tsx', 'utf8');

// Add import
if (!code.includes("import PixelCard")) {
  code = code.replace(
    /import GooeyNav from '\.\.\/components\/GooeyNav';/,
    `import GooeyNav from '../components/GooeyNav';\nimport PixelCard from '../components/PixelCard';`
  );
}

// Replace the ID card with PixelCard wrapping the content
const searchStr = `<motion.div 
            whileHover={{ rotateX: 5, rotateY: -5, scale: 1.02 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            className={\`relative backdrop-blur-2xl border border-white/20 rounded-[24px] p-6 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.5)] overflow-hidden aspect-[1.58/1] flex flex-col justify-between \${
              currentPlan === 'pro' 
                ? 'bg-gradient-to-br from-red-900/40 via-black/80 to-black/90' 
                : currentPlan === 'plus'
                ? 'bg-gradient-to-br from-olive/40 via-black/80 to-black/90'
                : 'bg-gradient-to-br from-zinc-800/80 to-zinc-900/90'
            }\`}
          >
            {/* Glass reflections */}`;

const replacementStr = `<motion.div 
            whileHover={{ rotateX: 5, rotateY: -5, scale: 1.02 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            className="w-full h-full cursor-pointer"
          >
            <PixelCard
              variant={currentPlan === 'pro' ? 'red' : currentPlan === 'plus' ? 'olive' : 'default'}
              className={\`relative backdrop-blur-2xl border border-white/20 rounded-[24px] p-6 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.5)] overflow-hidden aspect-[1.58/1] flex flex-col justify-between w-full h-full \${
                currentPlan === 'pro' 
                  ? 'bg-gradient-to-br from-red-900/40 via-black/80 to-black/90' 
                  : currentPlan === 'plus'
                  ? 'bg-gradient-to-br from-olive/40 via-black/80 to-black/90'
                  : 'bg-gradient-to-br from-zinc-800/80 to-zinc-900/90'
              }\`}
            >
            {/* Glass reflections */}`;

if (code.includes(searchStr)) {
  code = code.replace(searchStr, replacementStr);
  code = code.replace(
    `            </div>
          </motion.div>
        </div>`,
    `            </div>
            </PixelCard>
          </motion.div>
        </div>`
  );
  fs.writeFileSync('src/pages/Subscription.tsx', code);
  console.log('Fixed Subscription.tsx with PixelCard');
} else {
  console.log('Could not find search string in Subscription.tsx');
}
