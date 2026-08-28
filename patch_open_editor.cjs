const fs = require('fs');
let content = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

const target = `  const openEditor = (prod?: any) => {
    if (prod) {
      setForm({
        ...prod,
        images: JSON.parse(prod.images || '[]'),
        options: JSON.parse(prod.options || '[]'),
        colors: JSON.parse(prod.colors || '[]'),
        shipping_methods: JSON.parse(prod.shipping_methods || '[]'),
        membership_prices: JSON.parse(prod.membership_prices || '{"plus":0,"pro":0}'),
        payment_options: JSON.parse(prod.payment_options || '["full"]'),
        specifications: JSON.parse(prod.specifications || '[]'),
        is_featured: !!prod.is_featured
      });
    } else {
      setForm(initialForm);
    }
    setIsEditing(true);
  };`;

const replacement = `  const openEditor = (prod?: any) => {
    if (prod) {
      let parsedMem = { plus: 0, pro: 0 };
      try { parsedMem = JSON.parse(prod.membership_prices || '{"plus":0,"pro":0}'); } catch (e) {}
      let parsedSM = [];
      try { parsedSM = JSON.parse(prod.shipping_methods || '[]'); } catch (e) {}
      let parsedOpts = [];
      try { parsedOpts = JSON.parse(prod.options || '[]'); } catch (e) {}
      let parsedCols = [];
      try { parsedCols = JSON.parse(prod.colors || '[]'); } catch (e) {}

      setForm({
        ...prod,
        name_ar: prod.name_ar || '',
        description_ar: prod.description_ar || '',
        base_price: (prod.base_price || 0) * exchangeRate,
        original_price: (prod.original_price || 0) * exchangeRate,
        product_cost: (prod.product_cost || 0) * exchangeRate,
        membership_prices: {
          plus: (parsedMem.plus || 0) * exchangeRate,
          pro: (parsedMem.pro || 0) * exchangeRate
        },
        shipping_methods: parsedSM.map(m => ({...m, cost: (m.cost||0)*exchangeRate, price: (m.price||0)*exchangeRate})),
        options: parsedOpts.map(o => ({...o, cost: (o.cost||0)*exchangeRate, price: (o.price||0)*exchangeRate, original_price: (o.original_price||0)*exchangeRate})),
        colors: parsedCols.map(c => ({...c, cost: (c.cost||0)*exchangeRate, price: (c.price||0)*exchangeRate, original_price: (c.original_price||0)*exchangeRate})),
        images: JSON.parse(prod.images || '[]'),
        payment_options: JSON.parse(prod.payment_options || '["full"]'),
        specifications: JSON.parse(prod.specifications || '[]'),
        is_featured: !!prod.is_featured
      });
    } else {
      setForm(initialForm);
    }
    setIsEditing(true);
  };`;

content = content.replace(target, replacement);

fs.writeFileSync('src/components/AdminProducts.tsx', content);
