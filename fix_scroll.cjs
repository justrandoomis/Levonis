const fs = require('fs');
let code = fs.readFileSync('src/components/ScrollReveal.tsx', 'utf8');

// Replace the gsap.fromTo calls to not use ScrollTrigger, but just animate on mount
// Or we can just remove the scrollTrigger part and wrap in an IntersectionObserver
code = code.replace(/import \{ ScrollTrigger \} from 'gsap\/ScrollTrigger';/, '');
code = code.replace(/gsap\.registerPlugin\(ScrollTrigger\);/, '');

const newUseEffect = `
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const wordElements = el.querySelectorAll('.word');

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          gsap.fromTo(
            el,
            { transformOrigin: '0% 50%', rotate: baseRotation },
            { ease: 'power2.out', rotate: 0, duration: 1 }
          );

          gsap.fromTo(
            wordElements,
            { opacity: baseOpacity, willChange: 'opacity' },
            { ease: 'power2.out', opacity: 1, stagger: 0.05, duration: 0.8 }
          );

          if (enableBlur) {
            gsap.fromTo(
              wordElements,
              { filter: \`blur(\${blurStrength}px)\` },
              { ease: 'power2.out', filter: 'blur(0px)', stagger: 0.05, duration: 0.8 }
            );
          }
          
          observer.disconnect();
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(el);

    return () => observer.disconnect();
  }, [enableBlur, baseRotation, baseOpacity, blurStrength]);
`;

code = code.replace(/useEffect\(\(\) => \{[\s\S]*?return \(\) => \{\n\s*ScrollTrigger\.getAll\(\)\.forEach[\s\S]*?\}\);\n\s*\}, \[.*?\]\);/, newUseEffect);

fs.writeFileSync('src/components/ScrollReveal.tsx', code);
