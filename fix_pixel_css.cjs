const fs = require('fs');
let css = fs.readFileSync('src/components/PixelCard.css', 'utf8');

css = css.replace(/height: 400px;/, '/* height: 400px; */');
css = css.replace(/width: 300px;/, '/* width: 300px; */');
css = css.replace(/aspect-ratio: 4 \/ 5;/, '/* aspect-ratio: 4 / 5; */');
css = css.replace(/border: 1px solid #27272a;/, '/* border: 1px solid #27272a; */');
css = css.replace(/border-radius: 25px;/, '/* border-radius: 25px; */');

fs.writeFileSync('src/components/PixelCard.css', css);
console.log('Fixed PixelCard.css');
