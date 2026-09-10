const fs = require('fs');

const path = 'src/WalletContext.tsx';
let content = fs.readFileSync(path, 'utf8');

content = content.replace(
  "console.error('Failed to fetch wallet', e);",
  `console.error('Failed to fetch wallet', e);
      setBalanceUsdCents(0);
      setPointBalance(0);
      setTransactions([]);
      setPointTransactions([]);`
);

fs.writeFileSync(path, content);
