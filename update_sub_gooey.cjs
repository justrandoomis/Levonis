const fs = require('fs');
let code = fs.readFileSync('src/pages/Subscription.tsx', 'utf8');

code = code.replace(
  /initialActiveIndex=\{activeTab === 'plus' \? 0 : 1\}/,
  `initialActiveIndex={activeTab === 'plus' ? 0 : 1}\n            activeColor={activeTab === 'plus' ? '#8B9B7B' : '#B03142'}`
);

fs.writeFileSync('src/pages/Subscription.tsx', code);
console.log('Fixed Subscription.tsx');
