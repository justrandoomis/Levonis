const fs = require('fs');
let code = fs.readFileSync('src/components/ScrollReveal.css', 'utf8');

code = code.replace(/\.scroll-reveal \{[\s\S]*?\}/, '.scroll-reveal {\n  /* removed */\n}');
code = code.replace(/\.scroll-reveal-text \{[\s\S]*?\}/, '.scroll-reveal-text {\n  /* removed */\n}');

fs.writeFileSync('src/components/ScrollReveal.css', code);
