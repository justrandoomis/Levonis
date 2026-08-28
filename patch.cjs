const fs = require('fs');
let code = fs.readFileSync('src/pages/Home.tsx', 'utf8');

code = code.replace(
  /{discountedProducts.map\(p => \([\s\S]*?<div key={p.id} className="snap-start">[\s\S]*?{renderProductCard\(p, "w-\[180px\] md:w-\[200px\]"\)}[\s\S]*?<\/div>[\s\S]*?\)\)}/g,
  `{discountedProducts.map((p, index) => (
                <AnimatedItem key={p.id} index={index} className="snap-start">
                  {renderProductCard(p, "w-[180px] md:w-[200px]")}
                </AnimatedItem>
              ))}`
);

fs.writeFileSync('src/pages/Home.tsx', code);
