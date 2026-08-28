const fs = require('fs');
let code = fs.readFileSync('src/pages/Product.tsx', 'utf8');

if (!code.includes("import Stack from '../components/Stack';")) {
  code = code.replace(
    /import \{ ArrowRight, ArrowLeft, Share2, Heart, ShoppingCart, ExternalLink, Star \} from 'lucide-react';/,
    `import { ArrowRight, ArrowLeft, Share2, Heart, ShoppingCart, ExternalLink, Star } from 'lucide-react';\nimport Stack from '../components/Stack';`
  );
}

const replacementCode = `
      <div className="w-full h-[45vh] bg-zinc-900 relative rounded-b-3xl overflow-hidden flex items-center justify-center mt-14 pt-4 pb-4">
        {(() => {
          const allImages = [firstImage, ...descriptionImages].filter(Boolean);
          if (allImages.length > 1) {
            return (
              <div style={{ width: '280px', height: '280px' }}>
                <Stack
                  randomRotation={true}
                  sensitivity={100}
                  sendToBackOnClick={true}
                  cards={allImages.map((src: string, i: number) => (
                    <img 
                      key={i} 
                      src={src} 
                      alt={\`\${name}-\${i}\`} 
                      style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '1rem', border: '2px solid rgba(255,255,255,0.1)' }} 
                    />
                  ))}
                  autoplay={true}
                  autoplayDelay={3000}
                />
              </div>
            );
          } else {
            return <img src={firstImage} alt={name} className="max-w-full max-h-full object-contain p-4" />;
          }
        })()}
      </div>
`;

code = code.replace(
  /<div className="w-full h-\[40vh\] bg-zinc-900 relative rounded-b-3xl overflow-hidden flex items-center justify-center mt-14">\s*<img src=\{firstImage\} alt=\{name\} className="max-w-full max-h-full object-contain p-4" \/>\s*<\/div>/,
  replacementCode
);

// We can remove the descriptionImages grid since it's now in the stack.
const descImagesRegex = /\{\/\* Description Images \*\/\}[\s\S]*?\{\/\* Description Videos \*\/\}/;
if (descImagesRegex.test(code)) {
  code = code.replace(descImagesRegex, '{/* Description Videos */}');
}


fs.writeFileSync('src/pages/Product.tsx', code);
