const fs = require('fs');
let content = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

// Replace all ($) with (IQD)
content = content.replace(/\(\$\)/g, '(IQD)');

// Update handleSave
const handleSaveTarget = `        id, form.name, form.slug, form.description, JSON.stringify(form.images), JSON.stringify(form.options),
        JSON.stringify(form.colors), form.selling_type, JSON.stringify(form.shipping_methods),
        form.base_price / exchangeRate, form.original_price / exchangeRate, form.product_cost / exchangeRate, JSON.stringify(form.membership_prices),
        JSON.stringify(form.payment_options), form.subcategory_id, form.display_order, form.is_featured ? 1 : 0,
        JSON.stringify(form.specifications)`;

const handleSaveNew = `        id, form.name, form.slug, form.description, JSON.stringify(form.images), 
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
        JSON.stringify(form.specifications)`;
content = content.replace(handleSaveTarget, handleSaveNew);

// Update load logic in edit
const editTarget = `    setForm({
      ...p,
      name_ar: p.name_ar || '',
      description_ar: p.description_ar || '',
      base_price: (p.base_price || 0) * exchangeRate,
      original_price: (p.original_price || 0) * exchangeRate,
      product_cost: (p.product_cost || 0) * exchangeRate
    });`;

const editNew = `
    let parsedMem = { plus: 0, pro: 0 };
    try { parsedMem = JSON.parse(p.membership_prices || '{"plus":0,"pro":0}'); } catch (e) {}
    let parsedSM = [];
    try { parsedSM = JSON.parse(p.shipping_methods || '[]'); } catch (e) {}
    let parsedOpts = [];
    try { parsedOpts = JSON.parse(p.options || '[]'); } catch (e) {}
    let parsedCols = [];
    try { parsedCols = JSON.parse(p.colors || '[]'); } catch (e) {}
    
    setForm({
      ...p,
      name_ar: p.name_ar || '',
      description_ar: p.description_ar || '',
      base_price: (p.base_price || 0) * exchangeRate,
      original_price: (p.original_price || 0) * exchangeRate,
      product_cost: (p.product_cost || 0) * exchangeRate,
      membership_prices: {
        plus: (parsedMem.plus || 0) * exchangeRate,
        pro: (parsedMem.pro || 0) * exchangeRate
      },
      shipping_methods: parsedSM.map(m => ({...m, cost: (m.cost||0)*exchangeRate, price: (m.price||0)*exchangeRate})),
      options: parsedOpts.map(o => ({...o, cost: (o.cost||0)*exchangeRate, price: (o.price||0)*exchangeRate, original_price: (o.original_price||0)*exchangeRate})),
      colors: parsedCols.map(c => ({...c, cost: (c.cost||0)*exchangeRate, price: (c.price||0)*exchangeRate, original_price: (c.original_price||0)*exchangeRate})),
      images: JSON.parse(p.images || '[""]'),
      payment_options: JSON.parse(p.payment_options || '["full"]'),
      specifications: JSON.parse(p.specifications || '[]')
    });`;
content = content.replace(editTarget, editNew);

// Remove the inline JSON parsing in the old edit target since we now do it manually and overwrite fields properly.
// The old code had:
// const handleEdit = (p: any) => { ... setForm(p); } 
// wait, the old editTarget was already what I just replaced. Wait, did the old code do JSON parse when clicking edit?
fs.writeFileSync('patch.js', content);
