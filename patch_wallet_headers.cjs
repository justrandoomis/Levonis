const fs = require('fs');
let content = fs.readFileSync('src/pages/Admin.tsx', 'utf8');

const target = `                      <th className="pb-3 px-4 font-medium">Date</th>
                      <th className="pb-3 px-4 font-medium">Type</th>
                      <th className="pb-3 px-4 font-medium">Account</th>`;

const replacement = `                      <th className="pb-3 px-4 font-medium">User</th>
                      <th className="pb-3 px-4 font-medium">Date</th>
                      <th className="pb-3 px-4 font-medium">Type</th>
                      <th className="pb-3 px-4 font-medium">Account</th>`;

content = content.replace(target, replacement);

fs.writeFileSync('src/pages/Admin.tsx', content);
