const fs = require('fs');
let code = fs.readFileSync('src/pages/Home.tsx', 'utf8');

if (!code.includes('CircularGallery')) {
  code = code.replace(
    /import TrueFocus from '\.\.\/components\/TrueFocus';/,
    `import TrueFocus from '../components/TrueFocus';\nimport CircularGallery from '../components/CircularGallery';`
  );

  const galleryHtml = `
      {/* Circular Gallery */}
      <section className="py-12 mt-4 px-4 sm:px-6 mb-8">
        <h3 className="text-2xl font-black text-white mb-6 text-center">Featured Highlights</h3>
        <div className="w-full h-[400px] md:h-[500px] rounded-3xl overflow-hidden border border-white/10 bg-zinc-900/50 relative">
          <CircularGallery
            bend={2}
            textColor="#ffffff"
            borderRadius={0.1}
            scrollEase={0.15}
            fontUrl="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@700&display=swap"
            font="bold 30px 'Plus Jakarta Sans'"
            scrollSpeed={2}
            items={[
              { image: 'https://images.unsplash.com/photo-1601597111158-2fceff292cdc?q=80&w=800&auto=format&fit=crop', text: 'Premium Style' },
              { image: 'https://images.unsplash.com/photo-1549439602-43ebca2327af?q=80&w=800&auto=format&fit=crop', text: 'Healthy Living' },
              { image: 'https://images.unsplash.com/photo-1579450841234-49351e3a312b?q=80&w=800&auto=format&fit=crop', text: 'Exclusive Offers' },
              { image: 'https://images.unsplash.com/photo-1555529771-835f59fc5efe?q=80&w=800&auto=format&fit=crop', text: 'New Arrivals' },
              { image: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?q=80&w=800&auto=format&fit=crop', text: 'Trending Now' }
            ]}
          />
        </div>
      </section>
  `;

  code = code.replace(
    /      \{\/\* 4\. Explore Menu \*\/\}/,
    galleryHtml + '\n      {/* 4. Explore Menu */}'
  );

  fs.writeFileSync('src/pages/Home.tsx', code);
}
