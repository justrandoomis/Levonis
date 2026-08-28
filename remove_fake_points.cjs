const fs = require('fs');

let content = fs.readFileSync('src/pages/Rewards.tsx', 'utf8');

const regex = /\{\/\* Earn Rewards Section \*\/\}.*?<\/div>\n\s*<\/div>\n\s*<\/div>\n\s*\);/s;

content = content.replace(regex, '      </div>\n    </div>\n  );');

fs.writeFileSync('src/pages/Rewards.tsx', content);
