const fs = require('fs');

let code = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

if (!code.includes('algorithm_tags=excluded.algorithm_tags')) {
    code = code.replace(
        /brand, labels, hashtags, features/g,
        "brand, labels, hashtags, algorithm_tags, features"
    );
    code = code.replace(
        /brand=excluded.brand, labels=excluded.labels, hashtags=excluded.hashtags, features=excluded.features/g,
        "brand=excluded.brand, labels=excluded.labels, hashtags=excluded.hashtags, algorithm_tags=excluded.algorithm_tags, features=excluded.features"
    );
    code = code.replace(
        /form.brand, JSON.stringify\(form.labels\), JSON.stringify\(form.hashtags\), JSON.stringify\(form.features\)/g,
        "form.brand, JSON.stringify(form.labels), JSON.stringify(form.hashtags), JSON.stringify(form.algorithm_tags), JSON.stringify(form.features)"
    );
    code = code.replace(
        /brand: prod.brand \|\| '',/g,
        "brand: prod.brand || '',\n        algorithm_tags: prod.algorithm_tags ? JSON.parse(prod.algorithm_tags) : [],"
    );
    code = code.replace(
        /\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?/g,
        "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?"
    ); // added one more ?
}

fs.writeFileSync('src/components/AdminProducts.tsx', code);
