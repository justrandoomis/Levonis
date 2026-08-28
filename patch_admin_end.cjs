const fs = require('fs');
let content = fs.readFileSync('src/pages/Admin.tsx', 'utf8');

const target = `        </div>
      </div>
    </div>
  );
}`;

const replacement = `          </div>
        </div>
      </div>
    </div>
  );
}`;

content = content.replace(target, replacement);

fs.writeFileSync('src/pages/Admin.tsx', content);
