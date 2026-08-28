const fs = require('fs');
let content = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

content = content.replace(
  `\${p.base_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
  `IQD {(p.base_price * exchangeRate).toLocaleString('en-US', { minimumFractionDigits: 0 })}`
);

fs.writeFileSync('src/components/AdminProducts.tsx', content);
