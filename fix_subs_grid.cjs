const fs = require('fs');
let code = fs.readFileSync('src/pages/Subscription.tsx', 'utf8');

// Remove handleScroll and cardRefs usage
code = code.replace(/const containerRef = useRef<HTMLDivElement>\(null\);\n  const cardRefs = useRef<\{ \[key: string\]: HTMLDivElement \| null \}>[^;]+;\n\n  const handleScroll[^}]+}\n  };\n\n/m, '');
code = code.replace(/ref=\{\(el\) => \{ cardRefs\.current\[plan\.id\] = el; \}\}/g, '');
code = code.replace(/if \(cardRefs\.current\[plan\.id\]\) \{[^\}]+\}/g, '');

// Update the container
code = code.replace(
  /        \{\/\* Carousel \*\/\}\n        <div \n          ref=\{containerRef\}\n          onScroll=\{handleScroll\}\n          className="flex gap-3 overflow-x-auto pt-8 pb-8 hide-scrollbar snap-x snap-mandatory px-\[calc\(50vw-65px\)\] items-end min-h-\[240px\]"\n        >\n          <AnimatePresence mode="wait">\n            <motion\.div \n              key=\{activeTab\}\n              initial=\{\{ opacity: 0, x: 20 \}\}\n              animate=\{\{ opacity: 1, x: 0 \}\}\n              exit=\{\{ opacity: 0, x: -20 \}\}\n              transition=\{\{ duration: 0\.3 \}\}\n              className="flex gap-3 items-end w-max"\n            >/,
  `        {/* Plans Grid */}
        <div className="pt-4 pb-8 min-h-[240px] px-2 sm:px-0">
          <AnimatePresence mode="wait">
            <motion.div 
              key={activeTab}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
              className="grid grid-cols-2 gap-4"
            >`
);

// Update plan card styles
code = code.replace(
  /className="relative flex-none w-\[110px\] snap-center cursor-pointer flex flex-col origin-bottom"/,
  'className="relative w-full cursor-pointer flex flex-col origin-center"'
);

// Remove marginInline from animate
code = code.replace(/marginInline: isSelected \? 8 : 0/, '/* margin removed */');

fs.writeFileSync('src/pages/Subscription.tsx', code);
