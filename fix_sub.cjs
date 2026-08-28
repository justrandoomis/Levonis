const fs = require('fs');
let code = fs.readFileSync('src/pages/Subscription.tsx', 'utf8');

code = code.replace(/textClassName="[^"]+"/g, (match) => {
  if (match.includes('font-bold')) {
    return 'textClassName="text-[14.5px] font-bold tracking-wide m-0 p-0"';
  }
  return 'textClassName="text-[14.5px] m-0 p-0 font-normal leading-normal"';
});

code = code.replace(/containerClassName="[^"]+"/g, 'containerClassName="m-0 p-0 inline-flex"');

fs.writeFileSync('src/pages/Subscription.tsx', code);
