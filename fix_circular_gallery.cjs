const fs = require('fs');
let code = fs.readFileSync('src/components/CircularGallery.tsx', 'utf8');

// Fix medias array length and index calculation
code = code.replace(
  /const galleryItems = items && items\.length \? items : defaultItems;\n\s*this\.mediasImages = galleryItems\.concat\(galleryItems\);/,
  `const galleryItems = items && items.length ? items : defaultItems;
    this.originalLength = galleryItems.length;
    // Repeat items multiple times to ensure the total width is much larger than the screen, preventing jumps
    this.mediasImages = [];
    for (let i = 0; i < 10; i++) {
      this.mediasImages = this.mediasImages.concat(galleryItems);
    }`
);

code = code.replace(
  /\/\/ The array is concatenated with itself, so we take modulo of half length\n\s*const realIndex = itemIndex % \(this\.mediasImages\.length \/ 2\);/,
  `const realIndex = itemIndex % this.originalLength;`
);

// Fix onWheel
code = code.replace(
  /onWheel\(e: any\) \{\n\s*const delta = e\.deltaY \|\| e\.wheelDelta \|\| e\.detail;\n\s*this\.scroll\.target \+= \(delta > 0 \? this\.scrollSpeed : -this\.scrollSpeed\) \* 0\.2;\n\s*this\.onCheckDebounce\(\);\n\s*\}/,
  `onWheel(e: any) {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      return; // Ignore vertical scroll to let user scroll the page normally
    }
    const delta = e.deltaX || e.deltaY || e.wheelDelta || e.detail;
    this.scroll.target += (delta > 0 ? this.scrollSpeed : -this.scrollSpeed) * 0.2;
    this.onCheckDebounce();
  }`
);

fs.writeFileSync('src/components/CircularGallery.tsx', code);
console.log('Fixed CircularGallery');
