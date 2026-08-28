const fs = require('fs');
const content = fs.readFileSync('src/pages/Chats.tsx', 'utf8');
const lines = content.split('\n');
lines.forEach((line, i) => {
  if (/[\u4e00-\u9fa5]/.test(line)) {
    console.log(`Line ${i + 1}: ${line}`);
  }
});
