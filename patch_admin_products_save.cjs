const fs = require('fs');
let content = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

const target = `  const handleSave = async () => {
    try {
      const id = form.id || Math.random().toString(36).substr(2, 9);
      
      const sql = \`
        INSERT INTO products (id, name, slug, description, images, options, colors, selling_type, shipping_methods, base_price, original_price, product_cost, membership_prices, payment_options, subcategory_id, display_order, is_featured, specifications)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, slug=excluded.slug, description=excluded.description, images=excluded.images,
          options=excluded.options, colors=excluded.colors, selling_type=excluded.selling_type, shipping_methods=excluded.shipping_methods,
          base_price=excluded.base_price, original_price=excluded.original_price, product_cost=excluded.product_cost,
          membership_prices=excluded.membership_prices, payment_options=excluded.payment_options, subcategory_id=excluded.subcategory_id,
          display_order=excluded.display_order, is_featured=excluded.is_featured, specifications=excluded.specifications
      \`;

      await queryDb(sql, [
        id, form.name, form.slug, form.description, JSON.stringify(form.images), 
        JSON.stringify(form.options.map(o => ({...o, cost: o.cost/exchangeRate, price: o.price/exchangeRate, original_price: o.original_price/exchangeRate}))),
        JSON.stringify(form.colors.map(c => ({...c, cost: c.cost/exchangeRate, price: c.price/exchangeRate, original_price: c.original_price/exchangeRate}))), 
        form.selling_type, 
        JSON.stringify(form.shipping_methods.map(m => ({...m, cost: m.cost/exchangeRate, price: m.price/exchangeRate}))),
        form.base_price / exchangeRate, form.original_price / exchangeRate, form.product_cost / exchangeRate, 
        JSON.stringify({
          plus: form.membership_prices.plus / exchangeRate,
          pro: form.membership_prices.pro / exchangeRate
        }),
        JSON.stringify(form.payment_options), form.subcategory_id, form.display_order, form.is_featured ? 1 : 0,
        JSON.stringify(form.specifications)
      ]);`;

const replacement = `  const handleSave = async () => {
    try {
      let finalName = form.name;
      let finalDesc = form.description;
      
      // Auto-translate if English is empty but Arabic is present
      if (!finalName && form.name_ar) {
        setIsTranslating(true);
        try {
          const res = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: form.name_ar, targetLang: 'en' })
          });
          const data = await res.json();
          if (data.success && data.translation) finalName = data.translation;
        } catch(e) {}
        setIsTranslating(false);
      }
      
      if (!finalDesc && form.description_ar) {
        setIsTranslating(true);
        try {
          const res = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: form.description_ar, targetLang: 'en' })
          });
          const data = await res.json();
          if (data.success && data.translation) finalDesc = data.translation;
        } catch(e) {}
        setIsTranslating(false);
      }

      const id = form.id || Math.random().toString(36).substr(2, 9);
      const finalSlug = form.slug || finalName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      
      const sql = \`
        INSERT INTO products (id, name, name_ar, slug, description, description_ar, images, options, colors, selling_type, shipping_methods, base_price, original_price, product_cost, membership_prices, payment_options, subcategory_id, display_order, is_featured, specifications)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, name_ar=excluded.name_ar, slug=excluded.slug, description=excluded.description, description_ar=excluded.description_ar, images=excluded.images,
          options=excluded.options, colors=excluded.colors, selling_type=excluded.selling_type, shipping_methods=excluded.shipping_methods,
          base_price=excluded.base_price, original_price=excluded.original_price, product_cost=excluded.product_cost,
          membership_prices=excluded.membership_prices, payment_options=excluded.payment_options, subcategory_id=excluded.subcategory_id,
          display_order=excluded.display_order, is_featured=excluded.is_featured, specifications=excluded.specifications
      \`;

      await queryDb(sql, [
        id, finalName, form.name_ar, finalSlug, finalDesc, form.description_ar, JSON.stringify(form.images), 
        JSON.stringify(form.options.map(o => ({...o, cost: o.cost/exchangeRate, price: o.price/exchangeRate, original_price: o.original_price/exchangeRate}))),
        JSON.stringify(form.colors.map(c => ({...c, cost: c.cost/exchangeRate, price: c.price/exchangeRate, original_price: c.original_price/exchangeRate}))), 
        form.selling_type, 
        JSON.stringify(form.shipping_methods.map(m => ({...m, cost: m.cost/exchangeRate, price: m.price/exchangeRate}))),
        form.base_price / exchangeRate, form.original_price / exchangeRate, form.product_cost / exchangeRate, 
        JSON.stringify({
          plus: form.membership_prices.plus / exchangeRate,
          pro: form.membership_prices.pro / exchangeRate
        }),
        JSON.stringify(form.payment_options), form.subcategory_id, form.display_order, form.is_featured ? 1 : 0,
        JSON.stringify(form.specifications)
      ]);`;

content = content.replace(target, replacement);

fs.writeFileSync('src/components/AdminProducts.tsx', content);
