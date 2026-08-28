const fs = require('fs');
let code = fs.readFileSync('src/pages/Home.tsx', 'utf8');

const observerStr = `
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const observerTarget = useRef(null);

  useEffect(() => {
    async function fetchHomeProducts() {
      try {
        const discounted = await queryDb('SELECT * FROM products WHERE original_price > base_price ORDER BY created_at DESC LIMIT 10');
        setDiscountedProducts(discounted || []);
        
        const newest = await queryDb('SELECT * FROM products ORDER BY created_at DESC LIMIT 20 OFFSET 0');
        setNewProducts(newest || []);
      } catch (err) {
        console.error('Failed to fetch home products', err);
      }
    }
    fetchHomeProducts();
  }, []);

  const loadMore = async () => {
    if (isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    try {
      const nextPage = page + 1;
      const offset = (nextPage - 1) * 20;
      const newest = await queryDb('SELECT * FROM products ORDER BY created_at DESC LIMIT 20 OFFSET ?', [offset]);
      if (newest && newest.length > 0) {
        setNewProducts(prev => [...prev, ...newest]);
        setPage(nextPage);
      } else {
        setHasMore(false);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoadingMore(false);
    }
  };

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { threshold: 0.1 }
    );

    if (observerTarget.current) {
      observer.observe(observerTarget.current);
    }

    return () => {
      if (observerTarget.current) {
        observer.unobserve(observerTarget.current);
      }
    };
  }, [observerTarget.current, isLoadingMore, hasMore, page]);
`;

code = code.replace(/useEffect\(\(\) => \{\n    async function fetchHomeProducts[\s\S]*?fetchHomeProducts\(\);\n  \}, \[\]\);/, observerStr);

const targetDivStr = `
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
              {newProducts.map(p => renderProductCard(p, "w-full"))}
            </div>
            {hasMore && (
              <div ref={observerTarget} className="w-full h-20 flex items-center justify-center mt-4">
                <div className="w-6 h-6 border-2 border-olive border-t-transparent rounded-full animate-spin"></div>
              </div>
            )}
`;

code = code.replace(/<div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">\s*\{newProducts\.map\(p => renderProductCard\(p, "w-full"\)\)\}\s*<\/div>/, targetDivStr);

fs.writeFileSync('src/pages/Home.tsx', code);
