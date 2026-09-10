const fs = require('fs');
const path = require('path');

function replaceImports(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            if (fullPath.includes('node_modules')) continue;
            replaceImports(fullPath);
        } else if (fullPath.endsWith('.tsx') || fullPath.endsWith('.ts')) {
            let content = fs.readFileSync(fullPath, 'utf8');
            let modified = false;
            
            // Replace any import from 'worker/...' or '../../../worker/...' with a dummy variable
            // Since this could be complex to regex properly and ensure types,
            // I'll just change the import to a dummy local file, and create that dummy file.
            
            const importRegex = /import\s+([^'"\n]+)\s+from\s+['"]([^'"]+worker[^'"]+)['"]/g;
            content = content.replace(importRegex, (match, names, modulePath) => {
                modified = true;
                return `const ${names.replace(/[{}]/g, '').split(',')[0].trim()} = {} as any; // Stubbed ${modulePath}`;
            });
            
            // If the import was just `import { ... } from "..."` it might have destructured multiple, 
            // the above regex might make syntax errors.
            // Let's do a safer one: create a global stub file in src/stub.ts
            // and replace all worker imports with './stub' (with correct relative path)
            
            if (modified) {
                // Not saving the regex replace, let's do something safer.
            }
        }
    }
}
// Actually, it's easier to just create the missing worker files that are being imported!
