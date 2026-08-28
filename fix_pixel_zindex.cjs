const fs = require('fs');
let code = fs.readFileSync('src/components/PixelCard.tsx', 'utf8');

code = code.replace(
  /zIndex: 10/,
  `zIndex: 50,
          backgroundColor: 'rgba(0,0,0,0.85)',
          backdropFilter: 'blur(4px)'`
);

// Let's also increase pixel size/density so it looks more like a "noise cover"
code = code.replace(/this\.maxSizeInteger = 2;/, 'this.maxSizeInteger = 4;');
code = code.replace(/this\.minSize = 0\.5;/, 'this.minSize = 1.5;');

fs.writeFileSync('src/components/PixelCard.tsx', code);
console.log('Fixed PixelCard z-index and background');
