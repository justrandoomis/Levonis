const fs = require('fs');
let content = fs.readFileSync('src/pages/Product.tsx', 'utf8');

content = content.replace(
  /          <\/div>\s*<\/div>\s*<\/div>\s*\{cartModalOpen && \(/g,
  '          </div>\n        </div>\n      </div>\n      </div>\n      {cartModalOpen && ('
);

content = content.replace(
  /      \}\)\}\s*<\/div>\s*<\/div>\s*\);\s*\}/g,
  '      }))}\n    </div>\n  );\n}'
);

fs.writeFileSync('src/pages/Product.tsx', content);
