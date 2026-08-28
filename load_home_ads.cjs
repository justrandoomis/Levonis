const fs = require('fs');
let code = fs.readFileSync('src/pages/Home.tsx', 'utf8');

if (!code.includes('levo_home_ads')) {
  code = code.replace(
    /const \[activeIndex, setActiveIndex\] = useState\(0\);/,
    `const [activeIndex, setActiveIndex] = useState(0);\n  const [customAds, setCustomAds] = useState<{id: string, text: string, animation: string}[]>([]);\n\n  useEffect(() => {\n    const saved = localStorage.getItem('levo_home_ads');\n    if (saved) {\n      try {\n        setCustomAds(JSON.parse(saved));\n      } catch (e) {}\n    }\n  }, []);\n`
  );

  code = code.replace(
    /const banners = \[\n  \{\n    id: 1,/,
    `let banners = [\n  {\n    id: 1,`
  );
  
  code = code.replace(
    /    image: 'https:\/\/images.unsplash.com\/photo-1523275335684-37898b6baf30\?auto=format&fit=crop&q=80&w=300'\n  \}\n\];/,
    `    image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&q=80&w=300'\n  }\n];\n\n  // Merge custom ads if any\n  if (customAds.length > 0) {\n    banners = customAds.map((ad, i) => ({\n      id: parseInt(ad.id) || i,\n      title: ad.text,\n      subtitle: banners[i % banners.length]?.subtitle || '',\n      bgColor: banners[i % banners.length]?.bgColor || 'bg-zinc-800',\n      image: banners[i % banners.length]?.image || ''\n    }));\n  }`
  );
  fs.writeFileSync('src/pages/Home.tsx', code);
}
