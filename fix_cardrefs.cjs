const fs = require('fs');
let code = fs.readFileSync('src/pages/Subscription.tsx', 'utf8');

// Replace the useEffect block
code = code.replace(/  React\.useEffect\(\(\) => \{\n    if \(cardRefs\.current\[selectedDuration\]\) \{\n      cardRefs\.current\[selectedDuration\]\?\.scrollIntoView\(\{ behavior: 'auto', inline: 'center', block: 'nearest' \}\);\n    \}\n  \}, \[activeTab\]\);\n/, '');

fs.writeFileSync('src/pages/Subscription.tsx', code);
