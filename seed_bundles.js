const bundles = [
  {
    id: "bundle-1",
    name: "Summer Pro Bundle",
    name_ar: "الباقة الصيفية للمحترفين",
    slug: "summer-pro-bundle",
    description: "Get everything you need for summer. Contains 3 products.",
    description_ar: "احصل على كل ما تحتاجه للصيف. تحتوي على ٣ منتجات.",
    images: JSON.stringify(["https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400&h=400&fit=crop"]),
    selling_type: "bundle",
    base_price: 150000,
    original_price: 200000,
    subcategory_id: "bundles",
  },
  {
    id: "bundle-2",
    name: "Gaming Starter Kit",
    name_ar: "باقة اللاعبين المبتدئين",
    slug: "gaming-starter-kit",
    description: "A perfect bundle for gamers.",
    description_ar: "باقة مثالية للاعبين.",
    images: JSON.stringify(["https://images.unsplash.com/photo-1598550476439-6847785fcea6?w=400&h=400&fit=crop"]),
    selling_type: "bundle",
    base_price: 250000,
    original_price: 320000,
    subcategory_id: "bundles",
  },
  {
    id: "bundle-3",
    name: "Home Office Setup",
    name_ar: "باقة المكتب المنزلي",
    slug: "home-office-setup",
    description: "Upgrade your home office.",
    description_ar: "طور مكتبك المنزلي.",
    images: JSON.stringify(["https://images.unsplash.com/photo-1593640408182-31c70c8268f5?w=400&h=400&fit=crop"]),
    selling_type: "bundle",
    base_price: 450000,
    original_price: 500000,
    subcategory_id: "bundles",
  },
  {
    id: "bundle-4",
    name: "Fitness Pack",
    name_ar: "باقة اللياقة البدنية",
    slug: "fitness-pack",
    description: "Stay fit with this amazing pack.",
    description_ar: "حافظ على لياقتك مع هذه الباقة الرائعة.",
    images: JSON.stringify(["https://images.unsplash.com/photo-1581009146145-b5ef050c2e1e?w=400&h=400&fit=crop"]),
    selling_type: "bundle",
    base_price: 80000,
    original_price: 120000,
    subcategory_id: "bundles",
  }
];

async function seed() {
  for (const b of bundles) {
    const sql = `
      INSERT INTO products (id, name, name_ar, slug, description, description_ar, images, selling_type, base_price, original_price, subcategory_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [b.id, b.name, b.name_ar, b.slug, b.description, b.description_ar, b.images, b.selling_type, b.base_price, b.original_price, b.subcategory_id];
    
    try {
      const res = await fetch('http://localhost:3000/api/d1/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, params })
      });
      const data = await res.json();
      console.log(`Inserted ${b.id}:`, data);
    } catch(e) {
      console.error(`Failed ${b.id}:`, e.message);
    }
  }
}

seed();
