const fs = require('fs');

let code = fs.readFileSync('server.ts', 'utf8');

if (!code.includes("import fs from 'fs';") && !code.includes('import * as fs')) {
    code = code.replace(
        /import path from "path";/g,
        "import path from \"path\";\nimport fs from \"fs\";"
    );
    // and replace fsModule with fs
    code = code.replace(/const fsModule = require\('fs'\);/g, '');
    code = code.replace(/fsModule\./g, 'fs.');
    fs.writeFileSync('server.ts', code);
}
