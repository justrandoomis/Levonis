const fs = require('fs');
let content = fs.readFileSync('src/pages/Product.tsx', 'utf8');

let lines = content.split('\n');
// lines[708] is '    </div>' (line 709)
// lines[707] is '    </div>' (line 708)
if (lines[708].includes('</div>')) {
  lines.splice(708, 1);
}

fs.writeFileSync('src/pages/Product.tsx', lines.join('\n'));
