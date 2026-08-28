const fs = require('fs');
let code = fs.readFileSync('src/pages/Subscription.tsx', 'utf8');

code = code.replace(
  /<div className="pt-4 pb-4 min-h-\[400px\] px-2 sm:px-0 relative mb-8">/g,
  '<div className="pt-4 pb-4 min-h-[400px] w-screen relative left-1/2 -translate-x-1/2 mb-8">'
);

fs.writeFileSync('src/pages/Subscription.tsx', code);
