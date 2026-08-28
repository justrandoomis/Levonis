const fs = require('fs');

let code = fs.readFileSync('src/pages/Product.tsx', 'utf8');

// I also need to make sure Star is imported.
if(!code.includes('Star,')){
    code = code.replace(/ShoppingCart, ExternalLink } from 'lucide-react';/, "ShoppingCart, ExternalLink, Star } from 'lucide-react';");
    fs.writeFileSync('src/pages/Product.tsx', code);
}

