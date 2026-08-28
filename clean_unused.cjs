const fs = require('fs');

let content = fs.readFileSync('src/pages/Rewards.tsx', 'utf8');

content = content.replace(/  const \[pushEnabled, setPushEnabled\] = useState\(false\);\n/, '');
content = content.replace(/  const \[watched3Mins, setWatched3Mins\] = useState\(false\);\n/, '');
content = content.replace(/    const storedPush = localStorage\.getItem\('levo_push_enabled'\) === 'true';\n/, '');
content = content.replace(/    const stored3MinsDate = localStorage\.getItem\('levo_3mins_date'\);\n/, '');
content = content.replace(/    setPushEnabled\(storedPush\);\n/, '');
content = content.replace(/    setWatched3Mins\(stored3MinsDate === todayStr\);\n/, '');

fs.writeFileSync('src/pages/Rewards.tsx', content);
