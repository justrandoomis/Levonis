const fs = require('fs');
let code = fs.readFileSync('src/components/TrueFocus.css', 'utf8');

code = code.replace(/gap: 1em;/, 'gap: 0.3em;');
code = code.replace(/justify-content: center;/, 'justify-content: flex-start;');
code = code.replace(/display: flex;/, 'display: inline-flex;');

fs.writeFileSync('src/components/TrueFocus.css', code);
