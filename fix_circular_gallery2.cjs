const fs = require('fs');
let code = fs.readFileSync('src/components/CircularGallery.tsx', 'utf8');

// 1. Fix the array duplication to avoid lagging
code = code.replace(
  /const galleryItems = items && items\.length \? items : defaultItems;\n\s*this\.originalLength = galleryItems\.length;\n\s*\/\/ Repeat items multiple times to ensure the total width is much larger than the screen, preventing jumps\n\s*this\.mediasImages = \[\];\n\s*for \(let i = 0; i < 10; i\+\+\) \{\n\s*this\.mediasImages = this\.mediasImages\.concat\(galleryItems\);\n\s*\}/,
  `const galleryItems = items && items.length ? items : defaultItems;
    this.originalLength = galleryItems.length;
    
    // Repeat items a few times to cover the viewport width without causing WebGL lag
    this.mediasImages = [];
    const repeatCount = Math.max(2, Math.ceil(12 / galleryItems.length)); 
    for (let i = 0; i < repeatCount; i++) {
      this.mediasImages = this.mediasImages.concat(galleryItems);
    }`
);

// 2. Fix the onCheck calculation to snap to the exact center and handle negative index correctly
code = code.replace(
  /onCheck\(\) \{\n\s*if \(!this\.medias \|\| !this\.medias\[0\]\) return;\n\s*const width = this\.medias\[0\]\.width;\n\s*const itemIndex = Math\.round\(Math\.abs\(this\.scroll\.target\) \/ width\);\n\s*const item = width \* itemIndex;\n\s*this\.scroll\.target = this\.scroll\.target < 0 \? -item : item;\n\s*if \(this\.onIndexChange\) \{\n\s*const realIndex = itemIndex % this\.originalLength;\n\s*this\.onIndexChange\(realIndex\);\n\s*\}\n\s*\}/,
  `onCheck() {
    if (!this.medias || !this.medias[0]) return;
    const width = this.medias[0].width;
    const H = this.viewport.width / 2;
    
    // Find the closest index to the center
    const centerIndex = Math.round((this.scroll.target - H) / width);
    
    // Snap target so this plane is at exactly x = 0 (center)
    this.scroll.target = H + centerIndex * width;
    
    if (this.onIndexChange) {
      const realIndex = ((centerIndex % this.originalLength) + this.originalLength) % this.originalLength;
      this.onIndexChange(realIndex);
    }
  }`
);

// 3. Make sure the touchcancel event is properly attached
if (!code.includes("window.addEventListener('touchcancel'")) {
  code = code.replace(
    /window\.addEventListener\('touchend', this\.boundOnTouchUp\);/,
    `window.addEventListener('touchend', this.boundOnTouchUp);\n    window.addEventListener('touchcancel', this.boundOnTouchUp);`
  );
  code = code.replace(
    /window\.removeEventListener\('touchend', this\.boundOnTouchUp\);/,
    `window.removeEventListener('touchend', this.boundOnTouchUp);\n    window.removeEventListener('touchcancel', this.boundOnTouchUp);`
  );
}

fs.writeFileSync('src/components/CircularGallery.tsx', code);
console.log('Fixed CircularGallery again');
