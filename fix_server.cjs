const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

if (!code.includes('ALTER TABLE products ADD COLUMN algorithm_tags TEXT')) {
    code = code.replace(
        /try \{ await executeD1Query\("ALTER TABLE products ADD COLUMN hashtags TEXT"\); \} catch\(e\) \{\}/,
        `try { await executeD1Query("ALTER TABLE products ADD COLUMN hashtags TEXT"); } catch(e) {}\n    try { await executeD1Query("ALTER TABLE products ADD COLUMN algorithm_tags TEXT"); } catch(e) {}`
    );
    fs.writeFileSync('server.ts', code);
}
