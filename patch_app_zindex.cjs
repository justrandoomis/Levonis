const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf8');
content = content.replace(
  'zIndex={40}',
  'zIndex={10}'
);
fs.writeFileSync('src/App.tsx', content);
console.log('Patched zIndex');
