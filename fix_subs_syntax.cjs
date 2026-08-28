const fs = require('fs');
let code = fs.readFileSync('src/pages/Subscription.tsx', 'utf8');

code = code.replace(
  /onClick=\{\(\) => \{\n\s*setSelectedDuration\(plan\.id\);\n\s*\);\n\s*\}\n\s*\}\}/,
  'onClick={() => setSelectedDuration(plan.id)}'
);

// We still have cardRefs around line 18, 64-87, and 89-94.
// Let's remove them properly.
code = code.replace(/const cardRefs = React\.useRef<\{\[key: string\]: HTMLDivElement \| null\}>\(\{\}\);\n/, '');
code = code.replace(/const handleScroll = \(e: React\.UIEvent<HTMLDivElement>\) => \{[\s\S]*?^\s*};\n/m, '');
code = code.replace(/React\.useEffect\(\(\) => \{[\s\S]*?\}, \[selectedDuration\]\);\n/m, '');

fs.writeFileSync('src/pages/Subscription.tsx', code);
