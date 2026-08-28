const fs = require('fs');
let content = fs.readFileSync('src/pages/Home.tsx', 'utf8');

// Insert LogoLoop import
content = content.replace(
  "import { Link, useNavigate } from 'react-router-dom';",
  "import { Link, useNavigate } from 'react-router-dom';\nimport LogoLoop from '../components/LogoLoop';"
);

// Replace Top Brands grid with LogoLoop
const targetStr = `          <div className="flex gap-4 overflow-x-auto hide-scrollbar pb-4 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x">
            {TOP_BRANDS.map(brand => (
              <div 
                key={brand.id} 
                onClick={() => navigate('/products?brand=' + brand.id)}
                className="shrink-0 flex flex-col items-center gap-3 cursor-pointer group w-[100px] snap-start"
              >
                <div className={\`w-[100px] h-[100px] rounded-2xl \${brand.color} p-0.5 overflow-hidden border border-zinc-800 group-hover:border-white/20 transition-all shadow-sm group-hover:shadow-md\`}>
                  <img referrerPolicy="no-referrer" src={brand.image} alt={brand.name} className="w-full h-full object-cover rounded-[14px] group-hover:scale-110 transition-transform duration-500" />
                </div>
                <h3 className="text-zinc-300 group-hover:text-white font-bold text-sm text-center leading-tight transition-colors line-clamp-2">
                  {brand.name}
                </h3>
              </div>
            ))}
          </div>`;

const replacementStr = `          <div className="-mx-4 px-4 sm:mx-0 sm:px-0 relative overflow-hidden h-[160px] pb-4">
            <LogoLoop
              logos={TOP_BRANDS}
              speed={40}
              direction={dir === 'rtl' ? 'right' : 'left'}
              logoHeight={140}
              gap={16}
              hoverSpeed={0}
              fadeOut
              fadeOutColor="#000000"
              renderItem={(brand, key) => (
                <div 
                  onClick={() => navigate('/products?brand=' + brand.id)}
                  className="shrink-0 flex flex-col items-center gap-3 cursor-pointer group w-[100px] mt-2"
                >
                  <div className={\`w-[100px] h-[100px] rounded-2xl \${brand.color} p-0.5 overflow-hidden border border-zinc-800 group-hover:border-white/20 transition-all shadow-sm group-hover:shadow-md\`}>
                    <img referrerPolicy="no-referrer" src={brand.image} alt={brand.name} className="w-full h-full object-cover rounded-[14px] group-hover:scale-110 transition-transform duration-500" />
                  </div>
                  <h3 className="text-zinc-300 group-hover:text-white font-bold text-sm text-center leading-tight transition-colors line-clamp-2">
                    {brand.name}
                  </h3>
                </div>
              )}
            />
          </div>`;

content = content.replace(targetStr, replacementStr);
fs.writeFileSync('src/pages/Home.tsx', content);
