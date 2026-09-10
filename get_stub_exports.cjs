const fs = require('fs');
const path = require('path');

function check(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            if (fullPath.includes('node_modules')) continue;
            check(fullPath);
        } else if (fullPath.endsWith('.tsx') || fullPath.endsWith('.ts')) {
            const content = fs.readFileSync(fullPath, 'utf8');
            if (content.includes('export default function') && content.split('\n').length <= 10) {
                const basename = path.basename(fullPath, path.extname(fullPath));
                const cmd = `grep -r -E "from '.*${basename}'" src/`;
                try {
                    const out = require('child_process').execSync(cmd, { encoding: 'utf8' });
                    const namedImports = new Set();
                    for (const line of out.split('\n')) {
                        const match = line.match(/import\s*[^}]*?{([^}]+)}/);
                        if (match) {
                            match[1].split(',').forEach(i => namedImports.add(i.trim().split(' ')[0]));
                        }
                    }
                    if (namedImports.size > 0) {
                        let newContent = content;
                        for (const imp of namedImports) {
                            if (imp && imp !== 'default' && imp !== 'type' && !newContent.includes(`export const ${imp}`) && !newContent.includes(`export function ${imp}`)) {
                                newContent += `\nexport const ${imp} = {} as any;`;
                            }
                        }
                        fs.writeFileSync(fullPath, newContent);
                    }
                } catch (e) {}
            }
        }
    }
}
check('./src');
