const fs = require('fs');
let content = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

content = content.replace(
  '<Save className="w-4 h-4" /> Save Product',
  '<Save className="w-4 h-4" /> {isTranslating ? "Translating & Saving..." : "Save Product"}'
);
content = content.replace(
  '<button onClick={handleSave} className="flex items-center gap-2 bg-olive text-white px-6 py-2 rounded-lg font-bold hover:bg-olive/90 transition-colors">',
  '<button onClick={handleSave} disabled={isTranslating} className="flex items-center gap-2 bg-olive text-white px-6 py-2 rounded-lg font-bold hover:bg-olive/90 transition-colors disabled:opacity-50">'
)

fs.writeFileSync('src/components/AdminProducts.tsx', content);
