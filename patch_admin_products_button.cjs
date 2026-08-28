const fs = require('fs');
let content = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

const autoTranslateButtonTarget = `          <div className="flex justify-between items-center mb-4">
            <h4 className="text-white font-bold">Product Details</h4>
            <button type="button" onClick={handleAutoTranslate} disabled={isTranslating} className="bg-olive/20 hover:bg-olive/30 text-gold px-3 py-1.5 rounded text-sm font-medium transition-colors border border-olive/30">
              {isTranslating ? 'Translating...' : '🪄 Auto Translate (AR to EN)'}
            </button>
          </div>`;
content = content.replace(autoTranslateButtonTarget, `          <div className="flex justify-between items-center mb-4">
            <h4 className="text-white font-bold">Product Details</h4>
          </div>`);

fs.writeFileSync('src/components/AdminProducts.tsx', content);
