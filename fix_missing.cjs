const fs = require('fs');
const path = require('path');

function findAndStubMissingFiles(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            if (fullPath.includes('node_modules')) continue;
            findAndStubMissingFiles(fullPath);
        } else if (fullPath.endsWith('.tsx') || fullPath.endsWith('.ts')) {
            const content = fs.readFileSync(fullPath, 'utf8');
            const imports = content.match(/import.*?from\s+['"]([^'"]+)['"]/g) || [];
            const dynamicImports = content.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g) || [];
            
            for (const imp of [...imports, ...dynamicImports]) {
                const match = imp.match(/['"]([^'"]+)['"]/);
                if (match && match[1].startsWith('.')) {
                    let targetPath = path.resolve(dir, match[1]);
                    // Try .tsx, .ts, .js, .jsx, /index.tsx etc.
                    const extensions = ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '.css'];
                    let exists = false;
                    for (const ext of extensions) {
                        if (fs.existsSync(targetPath + ext)) {
                            exists = true;
                            break;
                        }
                    }
                    if (!exists && !fs.existsSync(targetPath)) {
                        if (targetPath.endsWith('.css')) continue;
                        console.log(`Stubbing ${targetPath}.tsx imported in ${fullPath}`);
                        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                        const componentName = path.basename(targetPath);
                        fs.writeFileSync(targetPath + '.tsx', `import React from 'react';\nexport default function ${componentName.replace(/[^a-zA-Z0-9]/g, '')}() { return <div>${componentName}</div>; }\n`);
                    }
                }
            }
        }
    }
}
findAndStubMissingFiles('./src');
